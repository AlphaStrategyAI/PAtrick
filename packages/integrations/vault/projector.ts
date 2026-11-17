import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalPayload } from '@patrick/contracts';
import { withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { requireVault } from './connection.js';
import { INDEX_PATH, indexSeedMatches, readIndexFile } from './index-proof.js';
import {
  type IndexSnapshot, loadPublicationProof, projectionIntentId, publicationScope, sameIndex, sha256, writePublicationProof,
} from './projection-publication.js';

export const PROJECTION_BATCH_FILES = [
  '知识/当前.md',
  '生效标准/当前.md',
  '候选标准/当前.md',
  '案例/当前.md',
  '知识.base',
  '标准.base',
  '知识关系.canvas',
] as const;

export type ProjectionRequest = {
  vaultId: string;
  viewKind: string;
  revision: number;
  files: Record<string, string>;
  editId?: string;
};

export type ProjectionResult = {
  applied: boolean;
  pointer: number | null;
  state: 'current' | 'failed' | 'superseded';
};

const tails = new Map<string, Promise<void>>();
const liveLocks = new Map<string, string>();

export async function projectVault(
  db: SqliteDatabase,
  input: ProjectionRequest,
  options: {
    now: string;
    failProjection?: (revision: number) => boolean;
    onProjectionLock?: (domain: string, viewKind: string) => void;
  },
): Promise<ProjectionResult> {
  const vault = requireVault(db, input.vaultId);
  const key = `${vault.data_domain}\0${input.viewKind}`;
  return withViewLock(key, async () => {
    const holder = randomUUID();
    if (liveLocks.has(key)) throw new Error('PROJECTION_LOCKED');
    liveLocks.set(key, holder);
    try {
      withImmediateTransaction(db, () => {
        acquireProjectionLock(db, vault.data_domain, input.viewKind, holder, options.now);
      });
      try {
        options.onProjectionLock?.(vault.data_domain, input.viewKind);
        const pointer = currentPointer(db, vault.data_domain, input.viewKind);
        if (pointer !== null && input.revision <= pointer) {
          withImmediateTransaction(db, () => remember(db, vault, input, 'superseded', 0, options.now));
          return { applied: false, pointer, state: 'superseded' as const };
        }
        const failed = { applied: false, pointer, state: 'failed' as const };
        if (!manifestComplete(input.files) || !await rootMatches(vault)) return failed;
        const manifest = projectionManifest(input);
        const scope = publicationScope(vault, input, pointer, manifest, indexBody(input.revision));
        const pending = loadPublicationProof(db, scope);
        if (pending === 'conflict') return failed;
        if (options.failProjection?.(input.revision)) {
          if (!pending) withImmediateTransaction(db, () => remember(db, vault, input, 'failed', 0, options.now));
          return failed;
        }
        const destination = join(vault.root_path, INDEX_PATH);
        let live: IndexSnapshot;
        try {
          live = await readIndexFile(destination);
        } catch (error) {
          if (error instanceof Error && error.message === 'PROJECTION_INDEX_UNSAFE') return failed;
          throw error;
        }
        if (pending && sameIndex(live, pending.publishedIndex)) {
          // The index already exists; never rewrite it during reconciliation.
          await syncIndexPublication(destination);
        } else {
          if (pending && !sameIndex(live, pending.precedingIndex)) return failed;
          if (pending && await pathExists(batchPath(vault.root_path, input.revision)) &&
              !await exactPublishedBatch(vault.root_path, input.revision, input.files)) return failed;
          if (!await canReplaceIndex(db, vault, live)) {
            if (!pending) withImmediateTransaction(db, () => remember(db, vault, input, 'failed', 0, options.now));
            return failed;
          }
          const staged = await stageIndex(vault.root_path, input.revision);
          try {
            const stamped = await readIndexFile(staged);
            if (!stamped || stamped.sha256 !== scope.indexSha256) throw new Error('PROJECTION_INDEX_STAGE_INVALID');
            const proof = writePublicationProof(scope, live, stamped);
            withImmediateTransaction(db, () => {
              const actual = requireVault(db, vault.vault_id);
              if (actual.config_revision !== vault.config_revision || actual.connection_epoch !== vault.connection_epoch ||
                  !remember(db, vault, input, 'pending', 0, options.now, proof)) throw new Error('PROJECTION_SCOPE_CHANGED');
            });
            await publishBatch(vault.root_path, input.revision, input.files);
            if (pointer !== null) await preserveBatch(vault.root_path, vault.isolation_root, vault.vault_id, pointer);
            await publishIndex(destination, staged, live);
          } finally {
            await rm(staged, { force: true });
          }
        }
        // Files are the publication receipt; a matching intention alone cannot advance the pointer.
        if (!await exactPublishedBatch(vault.root_path, input.revision, input.files) || !await rootMatches(vault)) return failed;
        const publishedIndex = await readIndexFile(destination);
        const moved = withImmediateTransaction(db, () => {
          const actual = requireVault(db, vault.vault_id);
          const actualPointer = currentPointer(db, vault.data_domain, input.viewKind);
          const actualScope = publicationScope(actual, input, actualPointer, manifest, indexBody(input.revision));
          const proof = loadPublicationProof(db, actualScope);
          if (!proof || proof === 'conflict' || !sameIndex(publishedIndex, proof.publishedIndex) ||
              actualPointer !== pointer || !remember(db, vault, input, 'current', 1, options.now)) return actualPointer;
          movePointer(db, vault.data_domain, input.viewKind, input.revision, projectionIntentId(vault, input), options.now);
          if (input.editId) syncEditProjection(db, input.editId, input.revision, input.viewKind, options.now);
          return currentPointer(db, vault.data_domain, input.viewKind);
        });
        return {
          applied: moved === input.revision,
          pointer: moved,
          state: moved === input.revision ? 'current' : 'failed',
        };
      } finally {
        withImmediateTransaction(db, () => {
          db.prepare('DELETE FROM projection_locks WHERE data_domain = ? AND view_kind = ? AND holder = ?').run(
            vault.data_domain,
            input.viewKind,
            holder,
          );
        });
      }
    } finally {
      if (liveLocks.get(key) === holder) liveLocks.delete(key);
    }
  });
}

function acquireProjectionLock(db: SqliteDatabase, domain: string, viewKind: string, holder: string, now: string): void {
  const key = `${domain}\0${viewKind}`;
  const existing = lockHolder(db, domain, viewKind);
  if (existing === holder) return;
  if (existing && liveLocks.get(key) === existing) throw new Error('PROJECTION_LOCKED');
  if (!existing) {
    try {
      db.prepare('INSERT INTO projection_locks (data_domain, view_kind, holder, acquired_at) VALUES (?, ?, ?, ?)').run(
        domain,
        viewKind,
        holder,
        now,
      );
      return;
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
    }
  }
  const current = lockHolder(db, domain, viewKind);
  if (!current) {
    db.prepare('INSERT INTO projection_locks (data_domain, view_kind, holder, acquired_at) VALUES (?, ?, ?, ?)').run(
      domain,
      viewKind,
      holder,
      now,
    );
    return;
  }
  if (current === holder) return;
  if (liveLocks.get(key) === current) throw new Error('PROJECTION_LOCKED');
  const updated = db.prepare(`UPDATE projection_locks SET holder = ?, acquired_at = ?
    WHERE data_domain = ? AND view_kind = ? AND holder = ?`).run(holder, now, domain, viewKind, current);
  if (updated.changes !== 1) throw new Error('PROJECTION_LOCKED');
}

function lockHolder(db: SqliteDatabase, domain: string, viewKind: string): string | undefined {
  const row = db.prepare('SELECT holder FROM projection_locks WHERE data_domain = ? AND view_kind = ?').get(domain, viewKind) as {
    holder: string;
  } | undefined;
  return row?.holder;
}

async function publishBatch(root: string, revision: number, files: Record<string, string>): Promise<void> {
  const destination = batchPath(root, revision);
  const status = await batchStatus(destination, files);
  if (status === 'complete') return;
  if (status === 'incomplete') await rm(destination, { recursive: true, force: true });
  const staging = join(root, '.patrick-staging', `batch-${revision}`);
  await rm(staging, { recursive: true, force: true });
  const hashes = new Map<string, string>();
  for (const path of PROJECTION_BATCH_FILES) {
    const body = files[path] ?? '';
    const bytes = Buffer.from(body, 'utf8');
    const target = join(staging, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    const handle = await open(target, 'w', 0o644);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const readBack = await readFile(target);
    if (!readBack.equals(bytes)) throw new Error('PROJECTION_READBACK');
    hashes.set(path, createHash('sha256').update(bytes).digest('hex'));
  }
  await mkdir(dirname(destination), { recursive: true });
  await rename(staging, destination);
  for (const path of PROJECTION_BATCH_FILES) {
    const readBack = await readFile(join(destination, ...path.split('/')));
    if (createHash('sha256').update(readBack).digest('hex') !== hashes.get(path)) throw new Error('PROJECTION_MANIFEST');
  }
}

async function preserveBatch(root: string, isolationRoot: string, vaultId: string, revision: number): Promise<void> {
  const from = join(root, '系统视图', '批次', String(revision));
  const destination = join(isolationRoot, vaultId, String(revision));
  const vaultExists = await isBatchDirectory(from);
  const vaultComplete = vaultExists && (await batchDirectoryComplete(from));
  const isolationComplete = await batchDirectoryComplete(destination);

  if (!vaultExists) {
    if (isolationComplete) return;
    return;
  }

  if (!vaultComplete) {
    if (isolationComplete) {
      await rm(from, { recursive: true, force: true });
      return;
    }
    return;
  }

  if (isolationComplete && (await batchBytesMatch(from, destination))) {
    await rm(from, { recursive: true, force: true });
    return;
  }

  await copyBatchToIsolation(from, isolationRoot, vaultId, revision);

  if (!(await batchDirectoryComplete(destination)) || !(await batchBytesMatch(from, destination))) {
    throw new Error('PRESERVE_INCOMPLETE');
  }
  await rm(from, { recursive: true, force: true });
}

async function isBatchDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function batchDirectoryComplete(destination: string): Promise<boolean> {
  if (!(await isBatchDirectory(destination))) return false;
  for (const path of PROJECTION_BATCH_FILES) {
    try {
      const info = await stat(join(destination, ...path.split('/')));
      if (!info.isFile()) return false;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

async function batchBytesMatch(sourceDir: string, destDir: string): Promise<boolean> {
  for (const path of PROJECTION_BATCH_FILES) {
    try {
      const fromBytes = await readFile(join(sourceDir, ...path.split('/')));
      const toBytes = await readFile(join(destDir, ...path.split('/')));
      if (!fromBytes.equals(toBytes)) return false;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

async function copyBatchToIsolation(
  from: string,
  isolationRoot: string,
  vaultId: string,
  revision: number,
): Promise<void> {
  const destination = join(isolationRoot, vaultId, String(revision));
  const staging = join(isolationRoot, vaultId, `.patrick-staging-batch-${revision}`);
  await rm(staging, { recursive: true, force: true });
  for (const path of PROJECTION_BATCH_FILES) {
    const target = join(staging, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await cp(join(from, ...path.split('/')), target);
  }
  if (!(await batchDirectoryComplete(staging)) || !(await batchBytesMatch(from, staging))) {
    await rm(staging, { recursive: true, force: true });
    throw new Error('PRESERVE_INCOMPLETE');
  }
  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  await rename(staging, destination);
}

function indexBody(revision: number): string {
  return `---\nkind: projection-index\nprojection_revision: ${revision}\n---\n\n当前批次：系统视图/批次/${revision}\n`;
}

async function canReplaceIndex(db: SqliteDatabase, vault: ReturnType<typeof requireVault>, index: IndexSnapshot): Promise<boolean> {
  if (!index) return true;
  try {
    if (await indexSeedMatches(vault.root_path, vault, index)) return true;
  } catch (error) {
    if (error instanceof Error && error.message === 'PROJECTION_INDEX_UNSAFE') return false;
    throw error;
  }
  const previous = db.prepare(`SELECT b.projection_revision FROM projection_batches b
    JOIN projection_pointers p ON p.data_domain = b.data_domain AND p.view_kind = b.view_kind
      AND p.projection_revision = b.projection_revision AND p.intent_id = b.intent_id
    WHERE b.vault_id = ? AND b.data_domain = ? AND b.applied = 1`).all(vault.vault_id, vault.data_domain) as {
    projection_revision: number;
  }[];
  return previous.some(({ projection_revision }) => index.sha256 === sha256(indexBody(projection_revision)));
}

async function stageIndex(root: string, revision: number): Promise<string> {
  const staging = join(root, '.patrick-staging', `index-${revision}-${randomUUID()}.md`);
  const directory = dirname(staging);
  await mkdir(directory, { recursive: true });
  if (!(await lstat(directory)).isDirectory() ||
      (await realpath(directory)).normalize('NFC') !== directory.normalize('NFC')) throw new Error('PROJECTION_INDEX_UNSAFE');
  const handle = await open(staging, 'wx', 0o644);
  try {
    await handle.writeFile(indexBody(revision));
    await handle.sync();
  } finally {
    await handle.close();
  }
  return staging;
}

async function publishIndex(destination: string, staging: string, replacing: IndexSnapshot): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  if (!replacing) {
    // Publish the exact inode registered by the pending proof, without replacing a racing file.
    await link(staging, destination);
  } else {
    const current = await readIndexFile(destination);
    if (!sameIndex(current, replacing)) throw new Error('PROJECTION_INDEX_CONFLICT');
    await rename(staging, destination);
  }
  await syncIndexPublication(destination);
}

async function syncIndexPublication(destination: string): Promise<void> {
  for (const path of [destination, dirname(destination), dirname(dirname(destination))]) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function batchPath(root: string, revision: number): string {
  return join(root, '系统视图', '批次', String(revision));
}

async function rootMatches(vault: ReturnType<typeof requireVault>): Promise<boolean> {
  try {
    const root = await lstat(vault.root_path);
    return root.isDirectory() && `${root.dev}:${root.ino}` === vault.root_identity &&
      (await realpath(vault.root_path)).normalize('NFC') === vault.physical_root.normalize('NFC');
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(errorCode(error) ?? '')) return false;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function exactPublishedBatch(root: string, revision: number, files: Record<string, string>): Promise<boolean> {
  const batchRoot = batchPath(root, revision);
  const expected: ReadonlySet<string> = new Set(PROJECTION_BATCH_FILES);
  const seen = new Set<string>();
  async function readTree(dir: string, prefix: string): Promise<boolean> {
    if (!(await lstat(dir)).isDirectory() || (await realpath(dir)).normalize('NFC') !== dir.normalize('NFC')) return false;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (![...expected].some((file) => file.startsWith(name + '/')) || !await readTree(path, name + '/')) return false;
      } else {
        if (!entry.isFile() || !expected.has(name)) return false;
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const info = await file.stat();
          const bytes = Buffer.from(files[name], 'utf8');
          if (!info.isFile() || info.size !== bytes.byteLength || !(await file.readFile()).equals(bytes)) return false;
        } finally {
          await file.close();
        }
        seen.add(name);
      }
    }
    return true;
  }
  try {
    return await readTree(batchRoot, '') && seen.size === expected.size;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP'].includes(errorCode(error) ?? '')) return false;
    throw error;
  }
}

async function batchStatus(destination: string, files: Record<string, string>): Promise<'missing' | 'complete' | 'incomplete'> {
  try {
    const info = await stat(destination);
    if (!info.isDirectory()) return 'incomplete';
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing';
    throw error;
  }
  for (const path of PROJECTION_BATCH_FILES) {
    const expected = createHash('sha256').update(Buffer.from(files[path] ?? '', 'utf8')).digest('hex');
    try {
      const readBack = await readFile(join(destination, ...path.split('/')));
      if (createHash('sha256').update(readBack).digest('hex') !== expected) return 'incomplete';
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return 'incomplete';
      throw error;
    }
  }
  return 'complete';
}

function manifestComplete(files: Record<string, string>): boolean {
  return PROJECTION_BATCH_FILES.every((path) => typeof files[path] === 'string');
}

function projectionManifest(input: ProjectionRequest) {
  return PROJECTION_BATCH_FILES.map((path) => ({ path, sha256: sha256(filesBody(input.files, path)) }));
}

function remember(
  db: SqliteDatabase,
  vault: { vault_id: string; data_domain: string },
  input: ProjectionRequest,
  cleanup: 'current' | 'failed' | 'superseded' | 'pending',
  applied: 0 | 1,
  now: string,
  publicationProof?: string,
): boolean {
  const manifestJson = publicationProof ?? canonicalPayload(projectionManifest(input));
  const manifestHash = sha256(manifestJson);
  const intentId = projectionIntentId(vault, input);
  return db.prepare(`INSERT INTO projection_batches (
    data_domain, view_kind, projection_revision, vault_id, intent_id, manifest_json, manifest_hash,
    cleanup_state, applied, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(data_domain, view_kind, projection_revision) DO UPDATE SET
    intent_id = excluded.intent_id,
    manifest_json = excluded.manifest_json,
    manifest_hash = excluded.manifest_hash,
    cleanup_state = excluded.cleanup_state,
    applied = excluded.applied,
    updated_at = excluded.updated_at
  WHERE projection_batches.applied = 0 AND projection_batches.vault_id = excluded.vault_id`).run(
    vault.data_domain,
    input.viewKind,
    input.revision,
    vault.vault_id,
    intentId,
    manifestJson,
    manifestHash,
    cleanup,
    applied,
    now,
    now,
  ).changes === 1;
}

function filesBody(files: Record<string, string>, path: string): string {
  return files[path] ?? '';
}

function movePointer(db: SqliteDatabase, domain: string, viewKind: string, revision: number, intentId: string, now: string): void {
  db.prepare(`INSERT INTO projection_pointers (data_domain, view_kind, projection_revision, intent_id, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(data_domain, view_kind) DO UPDATE SET
      projection_revision = excluded.projection_revision,
      intent_id = excluded.intent_id,
      updated_at = excluded.updated_at
    WHERE excluded.projection_revision > projection_pointers.projection_revision`).run(domain, viewKind, revision, intentId, now);
}

function currentPointer(db: SqliteDatabase, domain: string, viewKind: string): number | null {
  const row = db.prepare('SELECT projection_revision FROM projection_pointers WHERE data_domain = ? AND view_kind = ?').get(domain, viewKind) as {
    projection_revision: number;
  } | undefined;
  return row?.projection_revision ?? null;
}

function syncEditProjection(db: SqliteDatabase, editId: string, revision: number, viewKind: string, now: string): void {
  const latest = db.prepare(`SELECT receipt_revision, file_state, file_proof_ref, business_state, candidate_id, result_ref
    FROM edit_receipts WHERE edit_id = ? ORDER BY receipt_revision DESC LIMIT 1`).get(editId) as {
    receipt_revision: number;
    file_state: string;
    file_proof_ref: string | null;
    business_state: string;
    candidate_id: string | null;
    result_ref: string | null;
  } | undefined;
  if (!latest) return;
  db.prepare(`INSERT INTO edit_receipts (
    edit_id, receipt_revision, file_state, file_proof_ref, business_state, candidate_id, result_ref,
    projection_state, projection_intent_id, projection_revision, superseded_by, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'current', ?, ?, NULL, ?)`).run(
    editId,
    latest.receipt_revision + 1,
    latest.file_state,
    latest.file_proof_ref,
    latest.business_state,
    latest.candidate_id,
    latest.result_ref,
    `projection:${viewKind}:${revision}`,
    revision,
    now,
  );
}

function isUniqueConstraint(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? String((error as { code: unknown }).code) : '';
  if (code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  const message = 'message' in error ? String((error as { message: unknown }).message) : '';
  return message.includes('UNIQUE');
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) return String((error as { code: unknown }).code);
  return undefined;
}

function withViewLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(key, gate);
  return previous.catch(() => undefined).then(run).finally(() => {
    release();
    if (tails.get(key) === gate) tails.delete(key);
  });
}
