import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { canonicalPayload } from '@patrick/contracts';
import { withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { assertVaultWriteAllowed, requireVault } from './connection.js';
import { assertBoundRender, assertFailedReceiptCurrent, observeAdoptionProjection, supersedeAdoptionProjection,
  type AdoptionRender } from './adoption-projection.js';
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
  adoptionRender?: AdoptionRender;
  expectedFailedReceiptRevision?: number;
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
    authorize?: () => void;
  },
): Promise<ProjectionResult> {
  const vault = requireVault(db, input.vaultId);
  const authorize = () => {
    options.authorize?.();
    assertVaultWriteAllowed(db, vault);
    if (vault.status !== 'connected') throw new Error('CONFLICT');
  };
  authorize();
  // All views share the index. Serialize by Vault domain; the SQL row is also shared across processes.
  const key = vault.data_domain;
  const lockView = 'vault-index';
  return withViewLock(key, async () => {
    const holder = randomUUID();
    if (liveLocks.has(key)) throw new Error('PROJECTION_LOCKED');
    liveLocks.set(key, holder);
    try {
      withImmediateTransaction(db, () => {
        authorize();
        acquireProjectionLock(db, vault.data_domain, lockView, holder, options.now);
        // Preserve the view-specific observation expected by existing diagnostics.
        db.prepare(`INSERT INTO projection_locks (data_domain,view_kind,holder,acquired_at) VALUES (?,?,?,?)
          ON CONFLICT(data_domain,view_kind) DO UPDATE SET holder=excluded.holder,acquired_at=excluded.acquired_at`)
          .run(vault.data_domain, input.viewKind, holder, options.now);
      });
      let filesystemFailure: (() => ProjectionResult) | undefined;
      try {
        authorize();
        options.onProjectionLock?.(vault.data_domain, input.viewKind);
        authorize();
        if (input.adoptionRender) {
          assertFailedReceiptCurrent(db, input);
          const superseded = withImmediateTransaction(db, () => {
            authorize();
            return supersedeAdoptionProjection(db, input, options.now);
          });
          if (superseded) return superseded;
          assertBoundRender(db, input);
        } else if (input.viewKind === 'standards' && db.prepare(`SELECT 1 FROM projection_batches
          WHERE data_domain=? AND view_kind='standards' AND projection_revision=? AND intent_id LIKE 'intent_fact_%'`)
          .get(vault.data_domain, input.revision)) throw new Error('CONFLICT');
        const pointer = currentPointer(db, vault.data_domain, input.viewKind);
        if (pointer !== null && input.revision <= pointer) {
          if (input.adoptionRender) {
            const exact = db.prepare(`SELECT 1 FROM projection_pointers WHERE data_domain=? AND view_kind=?
              AND projection_revision=? AND intent_id=?`).get(vault.data_domain, input.viewKind, input.revision, input.adoptionRender.intentId);
            if (!exact) throw new Error('CONFLICT');
            return { applied: true, pointer, state: 'current' as const };
          }
          withImmediateTransaction(db, () => remember(db, vault, input, 'superseded', 0, options.now));
          return { applied: false, pointer, state: 'superseded' as const };
        }
        const failed = () => {
          if (input.adoptionRender) {
            // Keep any pending index proof. On retry a published inode will be reconciled, never replaced.
            withImmediateTransaction(db, () => observeAdoptionProjection(db, input, 'failed', options.now));
          }
          return { applied: false, pointer, state: 'failed' as const };
        };
        filesystemFailure = failed;
        const batch = batchName(input.revision, input.adoptionRender?.intentId);
        const index = indexBody(input.revision, batch);
        const previous = pointer === null ? undefined : db.prepare(`SELECT intent_id FROM projection_pointers
          WHERE data_domain=? AND view_kind=? AND projection_revision=?`).get(vault.data_domain, input.viewKind, pointer) as
          { intent_id: string } | undefined;
        const precedingBatch = pointer === null ? null : batchName(pointer, previous?.intent_id);
        if (!manifestComplete(input.files) || !await rootMatches(vault)) return failed();
        authorize();
        const manifest = projectionManifest(input);
        const scope = publicationScope(vault, input, pointer, manifest, index);
        const pending = loadPublicationProof(db, scope);
        if (pending === 'conflict') return failed();
        const simulateFailure = options.failProjection?.(input.revision);
        authorize();
        if (simulateFailure) {
          if (!pending && !input.adoptionRender) withImmediateTransaction(db, () => remember(db, vault, input, 'failed', 0, options.now));
          return failed();
        }
        const destination = join(vault.root_path, INDEX_PATH);
        let live: IndexSnapshot;
        try {
          live = await readIndexFile(destination);
          authorize();
        } catch (error) {
          if (error instanceof Error && error.message === 'PROJECTION_INDEX_UNSAFE') return failed();
          throw error;
        }
        if (pending && sameIndex(live, pending.publishedIndex)) {
          // The index already exists; never rewrite it during reconciliation.
          await syncIndexPublication(destination);
        } else {
          if (pending && !sameIndex(live, pending.precedingIndex)) return failed();
          if (pending && await pathExists(batchPath(vault.root_path, batch)) &&
              !await exactPublishedBatch(vault.root_path, batch, input.files)) return failed();
          if (!await canReplaceIndex(db, vault, live)) {
            if (!pending && !input.adoptionRender) withImmediateTransaction(db, () => remember(db, vault, input, 'failed', 0, options.now));
            return failed();
          }
          authorize();
          const system = await writableDirectory(vault.root_path, '系统视图');
          authorize();
          await writableDirectory(system, '批次');
          authorize();
          const staged = await stageIndex(vault.root_path, batch, index);
          try {
            authorize();
            const stamped = await readIndexFile(staged);
            authorize();
            if (!stamped || stamped.sha256 !== scope.indexSha256) throw new Error('PROJECTION_INDEX_STAGE_INVALID');
            const proof = writePublicationProof(scope, live, stamped);
            withImmediateTransaction(db, () => {
              authorize();
              const actual = requireVault(db, vault.vault_id);
              if (input.adoptionRender) assertBoundRender(db, input);
              if (actual.config_revision !== vault.config_revision || actual.connection_epoch !== vault.connection_epoch ||
                  !remember(db, vault, input, 'pending', 0, options.now, proof)) throw new Error('PROJECTION_SCOPE_CHANGED');
            });
            await publishBatch(vault.root_path, batch, input.files, !pending && !input.adoptionRender, () => {
              authorize();
              if (input.adoptionRender) assertBoundRender(db, input);
            });
            if (precedingBatch) await preserveBatch(vault.root_path, vault.isolation_root, vault.vault_id, precedingBatch, authorize);
            authorize();
            if (input.adoptionRender) assertBoundRender(db, input);
            await publishIndex(destination, staged, live, () => {
              authorize();
              if (input.adoptionRender) assertBoundRender(db, input);
            });
          } finally {
            await removeStaged(staged);
          }
        }
        // Files are the publication receipt; a matching intention alone cannot advance the pointer.
        if (!await exactPublishedBatch(vault.root_path, batch, input.files) || !await rootMatches(vault)) return failed();
        const publishedIndex = await readIndexFile(destination);
        const moved = withImmediateTransaction(db, () => {
          authorize();
          const actual = requireVault(db, vault.vault_id);
          if (input.adoptionRender) assertBoundRender(db, input);
          const actualPointer = currentPointer(db, vault.data_domain, input.viewKind);
          const actualScope = publicationScope(actual, input, actualPointer, manifest, index);
          const proof = loadPublicationProof(db, actualScope);
          if (!proof || proof === 'conflict' || !sameIndex(publishedIndex, proof.publishedIndex) ||
              actualPointer !== pointer || !remember(db, vault, input, 'current', 1, options.now)) return actualPointer;
          movePointer(db, vault.data_domain, input.viewKind, input.revision, projectionIntentId(vault, input), options.now);
          if (input.adoptionRender) observeAdoptionProjection(db, input, 'current', options.now);
          else if (input.editId) syncEditProjection(db, input.editId, input.revision, input.viewKind, options.now);
          return currentPointer(db, vault.data_domain, input.viewKind);
        });
        if (moved !== input.revision) return failed();
        if (precedingBatch) {
          try {
            await removePreservedBatch(vault.root_path, vault.isolation_root, vault.vault_id, precedingBatch);
          } catch (error) {
            // An old directory may remain after publication. A cleanup error cannot undo an already verified receipt.
            if (!isProjectionIoFailure(error)) throw error;
          }
        }
        return {
          applied: moved === input.revision,
          pointer: moved,
          state: moved === input.revision ? 'current' : 'failed',
        };
      } catch (error) {
        if (filesystemFailure && isProjectionIoFailure(error)) return filesystemFailure();
        throw error;
      } finally {
        withImmediateTransaction(db, () => {
          db.prepare('DELETE FROM projection_locks WHERE data_domain = ? AND view_kind IN (?,?) AND holder = ?').run(
            vault.data_domain,
            lockView,
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
  const key = domain;
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

async function publishBatch(root: string, revision: string, files: Record<string, string>, allowLegacyRepair: boolean,
  authorize: () => void): Promise<void> {
  const destination = batchPath(root, revision);
  await assertPhysicalDirectory(dirname(destination));
  if (await pathExists(destination)) {
    if (await exactPublishedBatch(root, revision, files)) return;
    if (!allowLegacyRepair) throw new Error('PROJECTION_BATCH_OCCUPIED');
    await assertPhysicalDirectory(destination);
  }
  const stagingParent = await writableDirectory(root, '.patrick-staging');
  const staging = await mkdtemp(join(stagingParent, `batch-${revision}-`));
  try {
    for (const path of PROJECTION_BATCH_FILES) {
      const bytes = Buffer.from(files[path] ?? '', 'utf8');
      const parts = path.split('/');
      const name = parts.pop()!;
      let parent = staging;
      for (const part of parts) parent = await writableDirectory(parent, part);
      await assertPhysicalDirectory(parent);
      const target = join(parent, name);
      const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o644);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (!(await readFile(target)).equals(bytes)) throw new Error('PROJECTION_READBACK');
    }
    await assertPhysicalDirectory(staging);
    await assertPhysicalDirectory(dirname(destination));
    if (await pathExists(destination)) {
      if (!allowLegacyRepair) throw new Error('PROJECTION_BATCH_OCCUPIED');
      await assertPhysicalDirectory(destination);
      await assertPhysicalDirectory(stagingParent);
      const quarantine = await mkdtemp(join(stagingParent, `batch-quarantine-${revision}-`));
      await assertPhysicalDirectory(quarantine);
      authorize();
      await rename(destination, join(quarantine, 'original'));
    }
    authorize();
    await rename(staging, destination);
    if (!await exactPublishedBatch(root, revision, files)) throw new Error('PROJECTION_MANIFEST');
  } finally {
    await removeStaged(staging, true);
  }
}

async function assertPhysicalDirectory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory() ||
      (await realpath(path)).normalize('NFC') !== path.normalize('NFC')) throw new Error('PROJECTION_PATH_UNSAFE');
}

async function writableDirectory(parent: string, name: string): Promise<string> {
  if (!name || name === '.' || name === '..' || /[/\\\p{Cc}]/u.test(name)) throw new Error('PROJECTION_PATH_UNSAFE');
  await assertPhysicalDirectory(parent);
  const path = join(parent, name);
  try {
    await mkdir(path);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  await assertPhysicalDirectory(path);
  return path;
}

async function removeStaged(path: string, recursive = false): Promise<void> {
  try {
    await assertPhysicalDirectory(dirname(path));
    await rm(path, { recursive, force: true });
  } catch (error) {
    // The abandoned temporary name is never reused. Do not follow a parent that has changed.
    if (!isProjectionIoFailure(error)) throw error;
  }
}

async function preserveBatch(root: string, isolationRoot: string, vaultId: string, revision: string, authorize: () => void): Promise<void> {
  const from = batchPath(root, revision);
  if (!await batchDirectoryComplete(from)) return;
  const container = await writableDirectory(await realpath(dirname(isolationRoot)), basename(isolationRoot));
  const safeIsolation = await writableDirectory(container, vaultId);
  const destination = join(safeIsolation, revision);
  if (await batchDirectoryComplete(destination) && await batchBytesMatch(from, destination)) return;
  authorize();
  await copyBatchToIsolation(from, safeIsolation, revision, authorize);
  if (!(await batchDirectoryComplete(destination)) || !(await batchBytesMatch(from, destination))) {
    throw new Error('PRESERVE_INCOMPLETE');
  }
}

async function removePreservedBatch(root: string, isolationRoot: string, vaultId: string, revision: string): Promise<void> {
  const from = batchPath(root, revision);
  const isolation = join(await realpath(dirname(isolationRoot)), basename(isolationRoot), vaultId, revision);
  if (!await isBatchDirectory(from) || !await batchDirectoryComplete(isolation)) return;
  const expected = new Set<string>(PROJECTION_BATCH_FILES);
  async function fullyPreserved(dir: string, prefix: string): Promise<boolean> {
    await assertPhysicalDirectory(dir);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      const file = join(dir, entry.name);
      if (entry.isDirectory() && [...expected].some((path) => path.startsWith(name + '/'))) {
        if (!await fullyPreserved(file, name + '/')) return false;
      } else if (!entry.isFile() || !expected.has(name) ||
          (await realpath(file)).normalize('NFC') !== file.normalize('NFC') ||
          !(await readFile(file)).equals(await readFile(join(isolation, name)))) return false;
    }
    return true;
  }
  if (await fullyPreserved(from, '')) {
    await assertPhysicalDirectory(from);
    await rm(from, { recursive: true });
  }
}

async function isBatchDirectory(path: string): Promise<boolean> {
  try {
    await assertPhysicalDirectory(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function batchDirectoryComplete(destination: string): Promise<boolean> {
  if (!(await isBatchDirectory(destination))) return false;
  for (const path of PROJECTION_BATCH_FILES) {
    try {
      const file = join(destination, ...path.split('/'));
      const info = await lstat(file);
      if (!info.isFile() || (await realpath(file)).normalize('NFC') !== file.normalize('NFC')) throw new Error('PROJECTION_PATH_UNSAFE');
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
  container: string,
  revision: string,
  authorize: () => void,
): Promise<void> {
  await assertPhysicalDirectory(container);
  const destination = join(container, revision);
  const staging = await mkdtemp(join(container, `.patrick-staging-batch-${revision}-`));
  try {
    for (const path of PROJECTION_BATCH_FILES) {
      const parts = path.split('/');
      const name = parts.pop()!;
      let target = staging;
      for (const part of parts) target = await writableDirectory(target, part);
      const source = join(from, path);
      if (!(await lstat(source)).isFile() || (await realpath(source)).normalize('NFC') !== source.normalize('NFC')) {
        throw new Error('PROJECTION_PATH_UNSAFE');
      }
      await cp(source, join(target, name), { errorOnExist: true, force: false });
    }
    if (!(await batchDirectoryComplete(staging)) || !(await batchBytesMatch(from, staging))) throw new Error('PRESERVE_INCOMPLETE');
    await assertPhysicalDirectory(container);
    if (await pathExists(destination)) {
      await assertPhysicalDirectory(destination);
      const quarantine = await mkdtemp(join(container, `.patrick-isolation-quarantine-${revision}-`));
      await assertPhysicalDirectory(quarantine);
      authorize();
      await rename(destination, join(quarantine, 'original'));
    }
    authorize();
    await rename(staging, destination);
  } finally {
    await removeStaged(staging, true);
  }
}

function batchName(revision: number, intent?: string): string {
  return intent && /^intent_fact_[0-9a-f]{24}$/.test(intent) ? `standards-${intent}-${revision}` : String(revision);
}

function indexBody(revision: number, batch = batchName(revision)): string {
  return `---\nkind: projection-index\nprojection_revision: ${revision}\n---\n\n当前批次：系统视图/批次/${batch}\n`;
}

async function canReplaceIndex(db: SqliteDatabase, vault: ReturnType<typeof requireVault>, index: IndexSnapshot): Promise<boolean> {
  if (!index) return true;
  try {
    if (await indexSeedMatches(vault.root_path, vault, index)) return true;
  } catch (error) {
    if (error instanceof Error && error.message === 'PROJECTION_INDEX_UNSAFE') return false;
    throw error;
  }
  const previous = db.prepare(`SELECT b.projection_revision,b.intent_id FROM projection_batches b
    JOIN projection_pointers p ON p.data_domain = b.data_domain AND p.view_kind = b.view_kind
      AND p.projection_revision = b.projection_revision AND p.intent_id = b.intent_id
    WHERE b.vault_id = ? AND b.data_domain = ? AND b.applied = 1`).all(vault.vault_id, vault.data_domain) as {
    projection_revision: number; intent_id: string;
  }[];
  return previous.some(({ projection_revision, intent_id }) =>
    index.sha256 === sha256(indexBody(projection_revision, batchName(projection_revision, intent_id))));
}

async function stageIndex(root: string, batch: string, body: string): Promise<string> {
  const directory = await writableDirectory(root, '.patrick-staging');
  const staging = join(directory, `index-${batch}-${randomUUID()}.md`);
  try {
    const handle = await open(staging, 'wx', 0o644);
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await removeStaged(staging);
    throw error;
  }
  return staging;
}

async function publishIndex(destination: string, staging: string, replacing: IndexSnapshot, authorize: () => void): Promise<void> {
  await assertPhysicalDirectory(dirname(destination));
  await assertPhysicalDirectory(dirname(staging));
  if (!replacing) {
    // Publish the exact inode registered by the pending proof, without replacing a racing file.
    authorize();
    await link(staging, destination);
  } else {
    const current = await readIndexFile(destination);
    if (!sameIndex(current, replacing)) throw new Error('PROJECTION_INDEX_CONFLICT');
    authorize();
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

function batchPath(root: string, revision: string): string {
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

async function exactPublishedBatch(root: string, revision: string, files: Record<string, string>): Promise<boolean> {
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

export function isProjectionIoFailure(error: unknown): boolean {
  return ['EACCES', 'EBUSY', 'EDQUOT', 'EEXIST', 'EIO', 'EISDIR', 'ELOOP', 'EMFILE', 'ENFILE', 'ENOENT',
    'ENOSPC', 'ENOTDIR', 'ENOTEMPTY', 'EPERM', 'EROFS', 'ESTALE', 'EXDEV'].includes(errorCode(error) ?? '') ||
    (error instanceof Error && ['PRESERVE_INCOMPLETE', 'PROJECTION_BATCH_OCCUPIED', 'PROJECTION_INDEX_CONFLICT',
      'PROJECTION_INDEX_STAGE_INVALID', 'PROJECTION_INDEX_UNSAFE', 'PROJECTION_MANIFEST', 'PROJECTION_PATH_UNSAFE',
      'PROJECTION_READBACK'].includes(error.message));
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
  const manifestJson = publicationProof ?? canonicalPayload(input.adoptionRender
    ? { format: 'patrick.adoption-render.v1', render: input.adoptionRender, manifest: projectionManifest(input) }
    : projectionManifest(input));
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
