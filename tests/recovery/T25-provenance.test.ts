import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { createBlobStore } from '../../packages/storage/src/blob-store.js';
import { openDatabase, type MigrationEntry } from '../../packages/storage/src/database.js';
import { createSourceRegistry } from '../../packages/integrations/sources/registry.js';
import { quarantineRestoredAuthority } from '../../packages/host/src/recovery/restore.js';

const migrations = fileURLToPath(new URL('../../packages/storage/migrations/', import.meta.url));
const manifest = JSON.parse(readFileSync(join(migrations, 'manifest.json'), 'utf8')) as MigrationEntry[];
const newest = '0025_source_revision_provenance.sql';
const provenanceIndex = manifest.findIndex((entry) => entry.file === newest);
const previousManifest = manifest.slice(0, provenanceIndex);
const at = '2026-11-17T06:00:00.000Z';

test('a real prior-schema SQLite backup opens raw, quarantines, and migrates without inventing old provenance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-provenance-recovery-'));
  const originalPath = join(root, 'previous.sqlite');
  const backupPath = join(root, 'backup.sqlite');
  let prior: ReturnType<typeof openDatabase> | undefined;
  let restored: InstanceType<typeof Database> | undefined;
  let migrated: ReturnType<typeof openDatabase> | undefined;
  try {
    expect(provenanceIndex).toBeGreaterThan(0);
    prior = openDatabase(originalPath, { manifest: previousManifest });
    const directory = join(root, 'source');
    mkdirSync(directory);
    writeFileSync(join(directory, 'demand.md'), 'A');
    prior.prepare("INSERT INTO accounts VALUES ('owner',1,0,?)").run(at);
    const blobs = createBlobStore(join(root, 'blobs'));
    const registry = createSourceRegistry(prior, { blobs, now: () => at });
    const source = await registry.enableSource({ accountId: 'owner', dataDomain: 'personal' }, { type: 'directory', target: directory });
    // Synthetic historical row uses the real previous migration schema. It has no provenance claim.
    const hash = await blobs.putBlob(Buffer.from('A'));
    prior.prepare('INSERT INTO blobs VALUES (?,?,?)').run(hash, 1, at);
    prior.prepare("INSERT INTO source_objects VALUES (?, 'obj_legacy', 'demand.md', 'connector', 0, 1)").run(source.sourceId);
    prior.prepare(`INSERT INTO source_revisions VALUES (?, 'obj_legacy', 1, 'rev_obj_legacy_1', ?, 'connector', 0,
      'owner', 'personal', '1.0', ?)`).run(source.sourceId, hash, at);
    expect(prior.prepare("SELECT name FROM sqlite_master WHERE name='source_revision_provenance'").get()).toBeUndefined();
    await prior.backup(backupPath);
    prior.close(); prior = undefined;

    restored = new Database(backupPath);
    restored.pragma('foreign_keys=ON');
    expect(restored.prepare("SELECT name FROM sqlite_master WHERE name='source_revision_provenance'").get()).toBeUndefined();
    expect(restored.prepare('SELECT revision_id FROM source_revisions').all()).toEqual([{ revision_id: 'rev_obj_legacy_1' }]);
    quarantineRestoredAuthority(restored, at, 'isolated-restore', root);
    expect(restored.prepare('SELECT status,config_revision FROM source_configs WHERE source_id=?').get(source.sourceId))
      .toEqual({ status: 'paused', config_revision: 2 });
    expect(restored.prepare("SELECT name FROM sqlite_master WHERE name='source_revision_provenance'").get()).toBeUndefined();
    restored.close(); restored = undefined;

    migrated = openDatabase(backupPath);
    expect(migrated.prepare('SELECT file,sha256 FROM schema_migrations ORDER BY position').all()).toEqual(manifest);
    expect(migrated.prepare(`SELECT r.revision_id,p.config_revision FROM source_revisions r
      LEFT JOIN source_revision_provenance p USING(revision_id)`).all())
      .toEqual([{ revision_id: 'rev_obj_legacy_1', config_revision: null }]);
    expect(migrated.pragma('foreign_key_check')).toEqual([]);
    migrated.close(); migrated = undefined;
    migrated = openDatabase(backupPath);
    expect(migrated.prepare('SELECT COUNT(*) AS n FROM source_revision_provenance').get()).toEqual({ n: 0 });
    expect(migrated.prepare('SELECT status,config_revision FROM source_configs WHERE source_id=?').get(source.sourceId))
      .toEqual({ status: 'paused', config_revision: 2 });
  } finally {
    if (prior?.open) prior.close();
    if (restored?.open) restored.close();
    if (migrated?.open) migrated.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a previous-schema revision stays unknown while a new post-migration revision gets the current version', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-provenance-upgrade-'));
  const databasePath = join(root, 'state.sqlite');
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(databasePath, { manifest: previousManifest });
    const directory = join(root, 'source');
    mkdirSync(directory);
    const file = join(directory, 'demand.md');
    writeFileSync(file, 'A');
    const blobs = createBlobStore(join(root, 'blobs'));
    const registry = createSourceRegistry(db, { blobs, now: () => at });
    const source = await registry.enableSource({ accountId: 'owner', dataDomain: 'personal' }, { type: 'directory', target: directory });
    const hash = await blobs.putBlob(Buffer.from('A'));
    db.prepare('INSERT INTO blobs VALUES (?,?,?)').run(hash, 1, at);
    db.prepare("INSERT INTO source_objects VALUES (?, 'obj_legacy', 'demand.md', 'connector', 0, 1)").run(source.sourceId);
    db.prepare(`INSERT INTO source_revisions VALUES (?, 'obj_legacy', 1, 'rev_obj_legacy_1', ?, 'connector', 0,
      'owner', 'personal', '1.0', ?)`).run(source.sourceId, hash, at);
    db.close();
    db = openDatabase(databasePath);
    writeFileSync(file, 'B');
    await createSourceRegistry(db, { blobs, now: () => at }).collectSource(source.sourceId, source.configRevision);
    const rows = db.prepare(`SELECT r.revision_id,r.observed_seq,p.config_revision,p.account_id,p.data_domain
      FROM source_revisions r LEFT JOIN source_revision_provenance p USING(revision_id) ORDER BY r.observed_seq`).all();
    expect(rows).toEqual([
      { revision_id: 'rev_obj_legacy_1', observed_seq: 1, config_revision: null, account_id: null, data_domain: null },
      { revision_id: 'rev_obj_legacy_2', observed_seq: 2, config_revision: 1, account_id: 'owner', data_domain: 'personal' },
    ]);
    db.close(); db = openDatabase(databasePath);
    expect(db.prepare('SELECT revision_id FROM source_revision_provenance').all()).toEqual([{ revision_id: 'rev_obj_legacy_2' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally { if (db?.open) db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a changed pending migration file is rejected before upgrading an actual prior ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-provenance-hash-'));
  try {
    const path = join(root, 'state.sqlite');
    const prior = openDatabase(path, { manifest: previousManifest });
    prior.close();
    const copied = join(root, 'migrations');
    cpSync(migrations, copied, { recursive: true });
    appendFileSync(join(copied, newest), '\n-- tampered\n');
    expect(() => openDatabase(path, { migrationsDir: copied })).toThrow('SCHEMA_FILE_HASH_MISMATCH');
    const untouched = openDatabase(path, { manifest: previousManifest });
    expect(untouched.prepare('SELECT file,sha256 FROM schema_migrations ORDER BY position').all()).toEqual(previousManifest);
    untouched.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a changed applied ledger hash is rejected on restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-provenance-ledger-'));
  try {
    const path = join(root, 'state.sqlite');
    const db = openDatabase(path);
    db.prepare('UPDATE schema_migrations SET sha256=? WHERE file=?').run('0'.repeat(64), newest);
    db.close();
    expect(() => openDatabase(path)).toThrow('SCHEMA_HISTORY_MISMATCH');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('quarantine and restart preserve a new backup’s recorded provenance without treating it as authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-provenance-new-backup-'));
  const path = join(root, 'state.sqlite');
  const backupPath = join(root, 'backup.sqlite');
  let sourceDb: ReturnType<typeof openDatabase> | undefined;
  let raw: InstanceType<typeof Database> | undefined;
  let reopened: ReturnType<typeof openDatabase> | undefined;
  try {
    const directory = join(root, 'source');
    mkdirSync(directory);
    writeFileSync(join(directory, 'demand.md'), 'A');
    sourceDb = openDatabase(path);
    sourceDb.prepare("INSERT INTO accounts VALUES ('owner',1,0,?)").run(at);
    const registry = createSourceRegistry(sourceDb, { blobs: createBlobStore(join(root, 'blobs')), now: () => at });
    const source = await registry.enableSource({ accountId: 'owner', dataDomain: 'personal' }, { type: 'directory', target: directory });
    await registry.collectSource(source.sourceId, source.configRevision);
    const provenance = sourceDb.prepare('SELECT * FROM source_revision_provenance').all();
    expect(provenance).toHaveLength(1);
    await sourceDb.backup(backupPath);
    sourceDb.close(); sourceDb = undefined;
    raw = new Database(backupPath);
    raw.pragma('foreign_keys=ON');
    quarantineRestoredAuthority(raw, at, 'isolated-restore', root);
    expect(raw.prepare('SELECT status,config_revision FROM source_configs').get()).toEqual({ status: 'paused', config_revision: 2 });
    expect(raw.prepare('SELECT * FROM source_revision_provenance').all()).toEqual(provenance);
    expect(raw.pragma('foreign_key_check')).toEqual([]);
    raw.close(); raw = undefined;
    reopened = openDatabase(backupPath);
    expect(reopened.prepare('SELECT * FROM source_revision_provenance').all()).toEqual(provenance);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM outbox WHERE destination='source-work'").get()).toEqual({ n: 0 });
    expect(reopened.pragma('foreign_key_check')).toEqual([]);
  } finally {
    if (sourceDb?.open) sourceDb.close();
    if (raw?.open) raw.close();
    if (reopened?.open) reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});
