import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { openDatabase, type MigrationEntry } from '../../packages/storage/src/database.js';
import { createBlobStore } from '../../packages/storage/src/blob-store.js';
import { createSourceRegistry } from '../../packages/integrations/sources/registry.js';

const manifestFile = fileURLToPath(new URL('../../packages/storage/migrations/manifest.json', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as MigrationEntry[];
const beforeDirectoryGeneration = manifest.findIndex((entry) => entry.file === '0026_directory_commit_generations.sql');
const oldManifest = manifest.slice(0, beforeDirectoryGeneration);

test('a previous schema with actual directory and RSS configurations migrates and retains its source state on restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-s1a-migration-'));
  const path = join(root, 'state.sqlite'); const dir = join(root, 'source');
  mkdirSync(dir); writeFileSync(join(dir, 'demand.md'), 'A');
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    expect(oldManifest.at(-1)?.file).toBe('0025_source_revision_provenance.sql');
    db = openDatabase(path, { manifest: oldManifest });
    const blobs = createBlobStore(join(root, 'blobs'));
    const registry = createSourceRegistry(db, { blobs });
    const source = await registry.enableSource({ accountId: 'owner', dataDomain: 'personal' }, { type: 'directory', target: dir });
    // RSS configuration is a real source row; its HTTP transport is not invoked.
    db.prepare(`INSERT INTO source_configs VALUES ('rss-old','owner','personal','rss','https://fixture.example.test/feed',
      'https://fixture.example.test/feed','{}','[]',NULL,'daily','none',0,1,'enabled',1,'1.0',?,?)`)
      .run('2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='directory_commit_generations'").get()).toBeUndefined();
    db.close();
    db = openDatabase(path);
    expect(db.prepare('SELECT source_id,account_id,data_domain,commit_generation FROM directory_commit_generations').all())
      .toEqual([{ source_id: source.sourceId, account_id: 'owner', data_domain: 'personal', commit_generation: 0 }]);
    expect(db.prepare('SELECT file,sha256 FROM schema_migrations ORDER BY position').all()).toEqual(manifest);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close(); db = openDatabase(path);
    expect(await createSourceRegistry(db, { blobs }).collectSource(source.sourceId, 1)).toMatchObject({ accepted: true, count: 1 });
    expect(db.prepare('SELECT commit_generation FROM directory_commit_generations').get()).toEqual({ commit_generation: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_revision_provenance').get()).toEqual({ n: 1 });
    db.close(); db = openDatabase(path);
    expect(db.prepare('SELECT commit_generation FROM directory_commit_generations').get()).toEqual({ commit_generation: 1 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally { if (db?.open) db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('new directory sources start at zero and no-change full and wake commits advance across restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-s1a-new-')); const path = join(root, 'state.sqlite');
  const dir = join(root, 'source'); mkdirSync(dir); writeFileSync(join(dir, 'demand.md'), 'A');
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(path);
    const blobs = createBlobStore(join(root, 'blobs'));
    let registry = createSourceRegistry(db, { blobs });
    const source = await registry.enableSource({ accountId: 'owner', dataDomain: 'personal' }, { type: 'directory', target: dir });
    const generation = () => db!.prepare('SELECT commit_generation FROM directory_commit_generations WHERE source_id=?').get(source.sourceId);
    expect(generation()).toEqual({ commit_generation: 0 });
    await registry.collectSource(source.sourceId, 1); expect(generation()).toEqual({ commit_generation: 1 });
    await registry.collectSource(source.sourceId, 1); expect(generation()).toEqual({ commit_generation: 2 });
    db.close(); db = openDatabase(path); registry = createSourceRegistry(db, { blobs });
    expect(generation()).toEqual({ commit_generation: 2 });
    expect((await registry.wakeDirectory(source.sourceId, 'demand.md')).receipt).toBeNull();
    expect((await registry.wakeDirectory(source.sourceId, 'demand.md')).receipt).toMatchObject({ accepted: true, count: 0 });
    expect(generation()).toEqual({ commit_generation: 3 });
    expect(() => db!.prepare("UPDATE source_configs SET account_id='other' WHERE source_id=?").run(source.sourceId)).toThrow(/FOREIGN KEY/);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally { if (db?.open) db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a generation at the safe integer limit fails closed without advancing the source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-s1a-limit-')); const dir = join(root, 'source');
  mkdirSync(dir); writeFileSync(join(dir, 'demand.md'), 'A');
  const db = openDatabase(join(root, 'state.sqlite'));
  try {
    const registry = createSourceRegistry(db, { blobs: createBlobStore(join(root, 'blobs')) });
    const source = await registry.enableSource({ accountId: 'owner', dataDomain: 'personal' }, { type: 'directory', target: dir });
    // Isolated fault injection reaches a state impractical to reach by repeated commits.
    db.exec('DROP TRIGGER directory_generation_no_reset');
    db.prepare('UPDATE directory_commit_generations SET commit_generation=? WHERE source_id=?').run(Number.MAX_SAFE_INTEGER, source.sourceId);
    const before = db.prepare('SELECT * FROM source_cursors').all();
    await expect(registry.collectSource(source.sourceId, 1)).rejects.toThrow('SOURCE_GENERATION_EXHAUSTED');
    expect(db.prepare('SELECT commit_generation FROM directory_commit_generations').get()).toEqual({ commit_generation: Number.MAX_SAFE_INTEGER });
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_revisions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT * FROM source_cursors').all()).toEqual(before);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
