import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalPayload, type Json } from '@patrick/contracts';
import { withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { requireVault } from './connection.js';

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
        if (!manifestComplete(input.files)) {
          withImmediateTransaction(db, () => remember(db, vault, input, 'failed', 0, options.now));
          return { applied: false, pointer, state: 'failed' as const };
        }
        if (options.failProjection?.(input.revision)) {
          withImmediateTransaction(db, () => remember(db, vault, input, 'failed', 0, options.now));
          return { applied: false, pointer, state: 'failed' as const };
        }
        await publishBatch(vault.root_path, input.revision, input.files);
        if (pointer !== null) await preserveBatch(vault.root_path, vault.isolation_root, vault.vault_id, pointer);
        await publishIndex(vault.root_path, input.revision);
        const moved = withImmediateTransaction(db, () => {
          remember(db, vault, input, 'current', 1, options.now);
          movePointer(db, vault.data_domain, input.viewKind, input.revision, `projection:${vault.data_domain}:${input.viewKind}:${input.revision}`, options.now);
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
  const destination = join(root, '系统视图', '批次', String(revision));
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
  await mkdir(dirname(destination), { recursive: true });
  await cp(from, destination, { recursive: true });
  await rm(from, { recursive: true });
}

async function publishIndex(root: string, revision: number): Promise<void> {
  const body = `---\nkind: projection-index\nprojection_revision: ${revision}\n---\n\n当前批次：系统视图/批次/${revision}\n`;
  const staging = join(root, '.patrick-staging', `index-${revision}.md`);
  await mkdir(dirname(staging), { recursive: true });
  const handle = await open(staging, 'w', 0o644);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const destination = join(root, '系统视图', '索引.md');
  await mkdir(dirname(destination), { recursive: true });
  await rename(staging, destination);
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

function remember(
  db: SqliteDatabase,
  vault: { vault_id: string; data_domain: string },
  input: ProjectionRequest,
  cleanup: 'current' | 'failed' | 'superseded',
  applied: 0 | 1,
  now: string,
): void {
  const manifest = PROJECTION_BATCH_FILES.map((path) => ({
    path,
    sha256: createHash('sha256').update(Buffer.from(filesBody(input.files, path), 'utf8')).digest('hex'),
  }));
  const manifestJson = canonicalPayload(manifest as unknown as Json);
  const manifestHash = createHash('sha256').update(manifestJson).digest('hex');
  const intentId = `projection:${vault.data_domain}:${input.viewKind}:${input.revision}`;
  db.prepare(`INSERT INTO projection_batches (
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
  WHERE projection_batches.applied = 0`).run(
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
  );
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
