import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openDatabase } from '../../packages/storage/src/database.js';
import { createBlobStore } from '../../packages/storage/src/blob-store.js';
import { createSourceRegistry, type RegistryOptions } from '../../packages/integrations/sources/registry.js';

test('empty databases expose a dedicated source revision provenance relation', () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-provenance-'));
  const db = openDatabase(join(root, 'state.sqlite'));
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='source_revision_provenance'").get();
    expect(table).toEqual({ name: 'source_revision_provenance' });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test('directory collection binds the exact source version and scope to its new revision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-provenance-'));
  const db = openDatabase(join(root, 'state.sqlite'));
  try {
    const directory = join(root, 'source');
    mkdirSync(directory);
    writeFileSync(join(directory, 'demand.md'), 'A');
    const registry = createSourceRegistry(db, { blobs: createBlobStore(join(root, 'blobs')) });
    const source = await registry.enableSource({ accountId: 'owner', dataDomain: 'personal' }, {
      type: 'directory', target: directory, hasTriggerRule: true,
    });
    const collection = await registry.collectSource(source.sourceId, source.configRevision);
    expect(collection).toMatchObject({ accepted: true, count: 1 });
    const revision = db.prepare('SELECT revision_id FROM source_revisions').get() as { revision_id: string };
    expect(db.prepare('SELECT * FROM source_revision_provenance').all()).toEqual([{
      revision_id: revision.revision_id, source_id: source.sourceId, config_revision: source.configRevision,
      account_id: 'owner', data_domain: 'personal',
    }]);
    expect(db.prepare("SELECT event_id,destination FROM outbox WHERE destination='source-work'").all())
      .toEqual([{ event_id: `work:${revision.revision_id}`, destination: 'source-work' }]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test('A to B to A and a confirmed deletion each retain their actual source configuration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-provenance-'));
  const db = openDatabase(join(root, 'state.sqlite'));
  try {
    const directory = join(root, 'source');
    const file = join(directory, 'demand.md');
    mkdirSync(directory);
    writeFileSync(file, 'A');
    const registry = createSourceRegistry(db, { blobs: createBlobStore(join(root, 'blobs')) });
    const source = await registry.enableSource({ accountId: 'owner', dataDomain: 'personal' }, {
      type: 'directory', target: directory, hasTriggerRule: true,
    });
    await registry.collectSource(source.sourceId, source.configRevision);
    writeFileSync(file, 'B');
    await registry.collectSource(source.sourceId, source.configRevision);
    writeFileSync(file, 'A');
    await registry.collectSource(source.sourceId, source.configRevision);
    rmSync(file);
    await registry.collectSource(source.sourceId, source.configRevision);
    await registry.collectSource(source.sourceId, source.configRevision);
    expect(db.prepare(`SELECT r.observed_seq,r.tombstone,p.config_revision,p.source_id,p.account_id,p.data_domain
      FROM source_revisions r LEFT JOIN source_revision_provenance p USING (revision_id) ORDER BY r.observed_seq`).all())
      .toEqual([0, 0, 0, 1].map((tombstone, index) => ({ observed_seq: index + 1, tombstone,
        config_revision: source.configRevision, source_id: source.sourceId, account_id: 'owner', data_domain: 'personal' })));
    expect(db.prepare("SELECT destination,COUNT(*) AS n FROM outbox GROUP BY destination ORDER BY destination").all())
      .toEqual([{ destination: 'source-dependency', n: 1 }, { destination: 'source-work', n: 3 }]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test('provenance facts cannot be rewritten or deleted after source configuration advances', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-provenance-'));
  const db = openDatabase(join(root, 'state.sqlite'));
  try {
    const directory = join(root, 'source');
    mkdirSync(directory);
    writeFileSync(join(directory, 'demand.md'), 'A');
    const registry = createSourceRegistry(db, { blobs: createBlobStore(join(root, 'blobs')) });
    const source = await registry.enableSource({ accountId: 'owner', dataDomain: 'personal' }, { type: 'directory', target: directory });
    await registry.collectSource(source.sourceId, source.configRevision);
    const revision = db.prepare('SELECT revision_id FROM source_revisions').get() as { revision_id: string };
    await registry.pauseSource(source.sourceId);
    expect(db.prepare('SELECT config_revision FROM source_configs WHERE source_id=?').get(source.sourceId)).toEqual({ config_revision: 2 });
    expect(() => db.prepare('UPDATE source_revision_provenance SET config_revision=2 WHERE revision_id=?').run(revision.revision_id))
      .toThrow('SOURCE_REVISION_PROVENANCE_IMMUTABLE');
    expect(() => db.prepare('DELETE FROM source_revision_provenance WHERE revision_id=?').run(revision.revision_id))
      .toThrow('SOURCE_REVISION_PROVENANCE_IMMUTABLE');
    expect(() => db.prepare(`INSERT OR REPLACE INTO source_revision_provenance
      SELECT revision_id,source_id,2,account_id,data_domain FROM source_revision_provenance WHERE revision_id=?`)
      .run(revision.revision_id)).toThrow('SOURCE_REVISION_PROVENANCE_IMMUTABLE');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});


const feedUrl = 'https://feed.example.test/provenance';
const stamp = '2026-11-17T06:00:00.000Z';

function feed(title: string) {
  return Buffer.from(`<rss><channel><item><guid>example</guid><title>${title}</title>
    <pubDate>Mon, 16 Nov 2026 00:00:00 GMT</pubDate></item></channel></rss>`);
}

function rssPort(read: () => Buffer): NonNullable<RegistryOptions['http']> {
  return {
    approvedUrls: (actor, target, kind) => actor.accountId === 'owner' && actor.dataDomain === 'personal'
      && target === feedUrl && kind === 'rss' ? [feedUrl] : null,
    port: {
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      request: async () => ({ status: 200, location: null, contentType: 'application/rss+xml', bytes: read() }),
    },
  };
}

test('RSS changes retain the version used for each collection across a configuration change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-provenance-'));
  const db = openDatabase(join(root, 'state.sqlite'));
  try {
    let bytes = feed('baseline');
    const actor = { accountId: 'owner', dataDomain: 'personal' };
    const registry = createSourceRegistry(db, { blobs: createBlobStore(join(root, 'blobs')), now: () => stamp, http: rssPort(() => bytes) });
    const source = await registry.enableSource(actor, { type: 'rss', target: feedUrl, hasTriggerRule: true });
    await registry.collectSource(source.sourceId, 1);
    bytes = feed('first change');
    await registry.collectSource(source.sourceId, 1);
    expect(registry.changeHttpSource(actor, source.sourceId, 'modify', 1, '30m', () => stamp)).toMatchObject({ revision: 2 });
    bytes = feed('second change');
    await registry.collectSource(source.sourceId, 2);
    const rows = db.prepare(`SELECT r.observed_seq,p.config_revision,p.account_id,p.data_domain
      FROM source_revisions r JOIN source_revision_provenance p USING (revision_id)
      WHERE r.source_id=? ORDER BY r.observed_seq`).all(source.sourceId);
    expect(rows).toEqual([1, 2].map((value) => ({ observed_seq: value, config_revision: value,
      account_id: 'owner', data_domain: 'personal' })));
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE destination='source-work'").get()).toEqual({ n: 2 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('RSS history import records its frozen collection configuration and does not create a work event', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-provenance-'));
  const db = openDatabase(join(root, 'state.sqlite'));
  try {
    const actor = { accountId: 'owner', dataDomain: 'personal', callerId: 'editor', authEpoch: 1 };
    const registry = createSourceRegistry(db, { blobs: createBlobStore(join(root, 'blobs')), now: () => stamp, http: rssPort(() => feed('history')) });
    const source = await registry.enableSource(actor, { type: 'rss', target: feedUrl, hasTriggerRule: true });
    await registry.collectSource(source.sourceId, 1);
    expect(registry.changeHttpSource(actor, source.sourceId, 'modify', 1, '30m', () => stamp)).toMatchObject({ revision: 2 });
    await registry.collectSource(source.sourceId, 2);
    const prepared = await registry.prepareRssHistory(actor, source.sourceId, 2, {
      from: '2026-11-15T00:00:00.000Z', until: '2026-11-17T00:00:00.000Z', maxObjects: 10, maxBytes: 8192,
    });
    const plan = db.transaction(() => {
      db.prepare('INSERT INTO command_inbox VALUES (?,?,?,?,?)').run('owner', 'editor', 'history-request', 'history-plan', 'a'.repeat(64));
      return registry.freezeRssHistory(actor, 'history-plan', prepared);
    }).immediate();
    const imported = await registry.importRssHistory(actor, 'history-plan', plan.plan_hash, 2, () => stamp);
    expect(imported.receipt).toMatchObject({ selected_objects: 1, imported_objects: 1 });
    expect(db.prepare(`SELECT p.config_revision,p.source_id,p.account_id,p.data_domain
      FROM source_revision_provenance p JOIN source_revisions r USING(revision_id) WHERE r.source_id=?`).all(source.sourceId))
      .toEqual([{ config_revision: 2, source_id: source.sourceId, account_id: 'owner', data_domain: 'personal' }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE destination='source-work'").get()).toEqual({ n: 0 });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('foreign keys reject a mismatched source, version, account, or domain for a revision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-provenance-'));
  const db = openDatabase(join(root, 'state.sqlite'));
  try {
    const firstDir = join(root, 'first');
    const secondDir = join(root, 'second');
    mkdirSync(firstDir); mkdirSync(secondDir);
    writeFileSync(join(firstDir, 'demand.md'), 'A');
    const registry = createSourceRegistry(db, { blobs: createBlobStore(join(root, 'blobs')) });
    const actor = { accountId: 'owner', dataDomain: 'personal' };
    const first = await registry.enableSource(actor, { type: 'directory', target: firstDir });
    const second = await registry.enableSource(actor, { type: 'directory', target: secondDir });
    await registry.collectSource(first.sourceId, first.configRevision);
    db.exec('SAVEPOINT provenance_fk_probe');
    try {
      db.prepare(`INSERT INTO source_revisions (source_id,object_id,observed_seq,revision_id,content_hash,trust_class,tombstone,account_id,data_domain,schema_version,created_at)
        SELECT source_id,object_id,observed_seq+1,'unbound-test-revision',content_hash,trust_class,tombstone,account_id,data_domain,schema_version,created_at
        FROM source_revisions WHERE source_id=?`).run(first.sourceId);
      const insert = db.prepare('INSERT INTO source_revision_provenance VALUES (?,?,?,?,?)');
      for (const values of [
        ['unbound-test-revision', second.sourceId, 1, 'owner', 'personal'],
        ['unbound-test-revision', first.sourceId, 2, 'owner', 'personal'],
        ['unbound-test-revision', first.sourceId, 1, 'other', 'personal'],
        ['unbound-test-revision', first.sourceId, 1, 'owner', 'other'],
        ['missing-revision', first.sourceId, 1, 'owner', 'personal'],
      ]) expect(() => insert.run(...values)).toThrow(/FOREIGN KEY constraint failed/);
    } finally { db.exec('ROLLBACK TO provenance_fk_probe; RELEASE provenance_fk_probe'); }
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test.each([
  { when: 'provenance', table: 'source_revision_provenance' },
  { when: 'later outbox', table: 'outbox' },
])('a failure at $when rolls back source revision, provenance, cursor and events', async ({ table }) => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-provenance-'));
  const db = openDatabase(join(root, 'state.sqlite'));
  try {
    const directory = join(root, 'source');
    mkdirSync(directory);
    writeFileSync(join(directory, 'demand.md'), 'A');
    const registry = createSourceRegistry(db, { blobs: createBlobStore(join(root, 'blobs')) });
    const source = await registry.enableSource({ accountId: 'owner', dataDomain: 'personal' }, {
      type: 'directory', target: directory, hasTriggerRule: true,
    });
    const cursor = db.prepare('SELECT * FROM source_cursors').all();
    const receipts = db.prepare('SELECT * FROM collection_receipts').all();
    db.exec(`CREATE TEMP TRIGGER fail_test_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'INJECTED_FAILURE'); END`);
    await expect(registry.collectSource(source.sourceId, source.configRevision)).rejects.toThrow('INJECTED_FAILURE');
    for (const name of ['source_objects', 'source_revisions', 'source_revision_provenance', 'domain_events', 'outbox']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get()).toEqual({ n: 0 });
    }
    expect(db.prepare('SELECT * FROM source_cursors').all()).toEqual(cursor);
    expect(db.prepare('SELECT * FROM collection_receipts').all()).toEqual(receipts);
    db.exec('DROP TRIGGER fail_test_write');
    expect(await registry.collectSource(source.sourceId, source.configRevision)).toMatchObject({ accepted: true, count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_revision_provenance').get()).toEqual({ n: 1 });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a failed confirmed deletion rolls back its tombstone, provenance, cursor and dependency event', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-provenance-'));
  const db = openDatabase(join(root, 'state.sqlite'));
  try {
    const directory = join(root, 'source');
    const file = join(directory, 'demand.md');
    mkdirSync(directory);
    writeFileSync(file, 'A');
    const registry = createSourceRegistry(db, { blobs: createBlobStore(join(root, 'blobs')) });
    const source = await registry.enableSource({ accountId: 'owner', dataDomain: 'personal' }, { type: 'directory', target: directory });
    await registry.collectSource(source.sourceId, source.configRevision);
    rmSync(file);
    await registry.collectSource(source.sourceId, source.configRevision);
    const names = ['source_objects', 'source_revisions', 'source_revision_provenance', 'source_cursors', 'collection_receipts', 'domain_events', 'outbox'];
    const before = names.map((name) => db.prepare(`SELECT * FROM ${name}`).all());
    db.exec("CREATE TEMP TRIGGER fail_test_deletion BEFORE INSERT ON source_revision_provenance BEGIN SELECT RAISE(ABORT,'INJECTED_DELETION_FAILURE'); END");
    await expect(registry.collectSource(source.sourceId, source.configRevision)).rejects.toThrow('INJECTED_DELETION_FAILURE');
    expect(names.map((name) => db.prepare(`SELECT * FROM ${name}`).all())).toEqual(before);
    db.exec('DROP TRIGGER fail_test_deletion');
    await registry.collectSource(source.sourceId, source.configRevision);
    expect(db.prepare(`SELECT r.tombstone,p.config_revision FROM source_revisions r
      JOIN source_revision_provenance p USING (revision_id) ORDER BY r.observed_seq`).all())
      .toEqual([{ tombstone: 0, config_revision: 1 }, { tombstone: 1, config_revision: 1 }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE destination='source-dependency'").get()).toEqual({ n: 1 });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
