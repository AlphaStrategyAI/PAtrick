import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';

const io = vi.hoisted(() => ({ roots: [] as string[], calls: [] as string[] }));
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  function observe(name: string, path: unknown) {
    if (typeof path === 'string' && io.roots.some((root) => path === root || path.startsWith(root + '/'))) io.calls.push(name + ':' + path);
  }
  return {
    ...actual,
    realpath: (...args: Parameters<typeof actual.realpath>) => { observe('realpath', args[0]); return actual.realpath(...args); },
    stat: (...args: Parameters<typeof actual.stat>) => { observe('stat', args[0]); return actual.stat(...args); },
    lstat: (...args: Parameters<typeof actual.lstat>) => { observe('lstat', args[0]); return actual.lstat(...args); },
    readdir: (...args: Parameters<typeof actual.readdir>) => { observe('readdir', args[0]); return actual.readdir(...args); },
    readFile: (...args: Parameters<typeof actual.readFile>) => { observe('readFile', args[0]); return actual.readFile(...args); },
    open: (...args: Parameters<typeof actual.open>) => { observe('open', args[0]); return actual.open(...args); },
  };
});
import { createSourceRegistry } from '../../packages/integrations/sources/registry.js';
import { openDatabase } from '../../packages/storage/src/database.js';
import { createBlobStore } from '../../packages/storage/src/blob-store.js';
import { directoryReaderCapability } from '../../packages/integrations/sources/directory-capability.js';

const actor = { accountId: 'owner', dataDomain: 'personal' };

test('the directory reader is admitted and reports what it can do', () => {
  expect(directoryReaderCapability).toEqual({ state: 'available', reason: null });
});

test('a directory preview reads the approved files and writes nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-directory-preview-')); const dir = join(root, 'source');
  mkdirSync(dir); writeFileSync(join(dir, 'note.md'), 'ordinary test note');
  const db = openDatabase(join(root, 'state.sqlite'));
  try {
    const registry = createSourceRegistry(db, { blobs: createBlobStore(join(root, 'blobs')) });
    io.roots = [dir, realpathSync(dir)]; io.calls = [];
    const preview = await registry.detectSource(actor, { type: 'directory', target: dir });
    expect(preview.samples).toEqual([{ locator: 'note.md', byteLength: 18 }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_configs').get()).toEqual({ n: 0 });
  } finally { io.roots = []; db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a directory preview never follows a link out of the approved root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-directory-link-')); const dir = join(root, 'source');
  mkdirSync(dir); writeFileSync(join(dir, 'note.md'), 'ordinary test note');
  symlinkSync('/etc/passwd', join(dir, 'escape.md'));
  const db = openDatabase(join(root, 'state.sqlite'));
  try {
    const registry = createSourceRegistry(db, { blobs: createBlobStore(join(root, 'blobs')) });
    const preview = await registry.detectSource(actor, { type: 'directory', target: dir });
    expect(preview.samples.map((sample) => sample.locator)).toEqual(['note.md']);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a paused directory returns a blocked error without inventing a receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-directory-paused-')); const dir = join(root, 'source'); mkdirSync(dir);
  const db = openDatabase(join(root, 'state.sqlite')); const stamp = '2026-11-17T05:00:00.000Z';
  try {
    db.prepare(`INSERT INTO source_configs VALUES ('legacy','owner','personal','directory',?,?,'{}','[]',NULL,'poll','none',0,0,'paused',2,'1.0',?,?)`)
      .run(dir, dir, stamp, stamp);
    db.prepare("INSERT INTO source_cursors VALUES ('legacy',2,'sweep:1','advanced',1,?)").run(stamp);
    const registry = createSourceRegistry(db, { blobs: createBlobStore(join(root, 'blobs')) });
    io.roots = [dir, realpathSync(dir)]; io.calls = [];
    const receipt = await registry.collectSource('legacy', 1);
    expect(receipt).toMatchObject({ kind: 'failure', reason: 'PAUSED', accepted: false });
    expect(db.prepare('SELECT status,config_revision FROM source_configs').get()).toEqual({ status: 'paused', config_revision: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM collection_receipts').get()).toEqual({ n: 0 });
  } finally { io.roots = []; db.close(); rmSync(root, { recursive: true, force: true }); }
});

async function seededHistory() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-directory-history-')); const dir = join(root, 'source');
  mkdirSync(dir); writeFileSync(join(dir, 'note.md'), 'new ordinary note');
  const db = openDatabase(join(root, 'state.sqlite')); const blobs = createBlobStore(join(root, 'blobs'));
  const stamp = '2026-11-17T05:00:00.000Z'; const path = realpathSync(dir);
  const scope = JSON.stringify({ repo: null, branch: null, path: null, root: path, excludes: [] });
  db.prepare(`INSERT INTO source_configs VALUES ('legacy','owner','personal','directory',?,?,?,'[]',NULL,'poll','none',0,1,'enabled',1,'1.0',?,?)`)
    .run(path, path, scope, stamp, stamp);
  db.prepare(`INSERT INTO source_versions SELECT source_id,config_revision,account_id,data_domain,connector_type,normalized_target,
    physical_root,scope_json,excludes_json,credential_ref,frequency,history,has_trigger_rule,enabled,status,schema_version,created_at
    FROM source_configs WHERE source_id='legacy'`).run();
  db.prepare("INSERT INTO source_cursors VALUES ('legacy',1,'sweep:1','advanced',1,?)").run(stamp);
  db.prepare("INSERT INTO collection_receipts VALUES ('legacy-receipt','legacy',1,'first_collection','sweep:1',1,NULL,?,1,NULL)").run(stamp);
  const hash = await blobs.putBlob(Buffer.from('saved historical note'));
  db.prepare('INSERT INTO blobs VALUES (?,?,?)').run(hash, Buffer.byteLength('saved historical note'), stamp);
  db.prepare("INSERT INTO source_objects VALUES ('legacy','old-object','note.md','connector',0,1)").run();
  db.prepare(`INSERT INTO source_revisions VALUES ('legacy','old-object',1,'old-revision',?,'connector',0,'owner','personal','1.0',?)`).run(hash, stamp);
  db.prepare("INSERT INTO source_revision_provenance VALUES ('old-revision','legacy',1,'owner','personal')").run();
  db.prepare("INSERT INTO domain_events VALUES (1,'old-event','old-object',1,NULL,'owner','personal','1.0','{}',?)").run(stamp);
  db.prepare("INSERT INTO outbox (event_id,destination) VALUES ('old-event','source-work')").run();
  const registry = createSourceRegistry(db, { blobs });
  const tables = ['source_configs', 'source_versions', 'source_cursors', 'source_objects', 'source_revisions', 'source_revision_provenance',
    'directory_commit_generations', 'collection_receipts', 'delete_sweeps', 'domain_events', 'outbox', 'blobs'];
  const state = () => tables.map((name) => db.prepare(`SELECT * FROM ${name}`).all());
  return { root, dir, db, blobs, hash, registry, state, close() { io.roots = []; if (db.open) db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('an enabled directory collects the approved files and keeps the recorded history', async () => {
  const f = await seededHistory();
  try {
    io.roots = [f.dir, realpathSync(f.dir)]; io.calls = [];
    const receipt = await f.registry.collectSource('legacy', 1);
    expect(receipt).toMatchObject({ kind: 'success', accepted: true, count: 1 });
    const objects = f.db.prepare('SELECT locator,observed_seq FROM source_objects WHERE source_id=?').all('legacy') as
      Array<{ locator: string; observed_seq: number }>;
    expect(objects.map((row) => row.locator)).toContain('note.md');
    expect(objects.find((row) => row.locator === 'note.md')?.observed_seq).toBe(2);
    expect(Buffer.from(await f.blobs.readBlob(f.hash)).toString()).toBe('saved historical note');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM domain_events').get()).toEqual({ n: 1 });
  } finally { f.close(); }
});

test('the public directory helpers read through the admitted reader', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-directory-helpers-')); const dir = join(root, 'source');
  mkdirSync(dir); writeFileSync(join(dir, 'note.md'), 'ordinary test note');
  const { listSamples, samplePath, scanDirectory } = await import('../../packages/integrations/sources/directory.js');
  try {
    expect(await listSamples(dir, [])).toEqual([{ relativePath: 'note.md', byteLength: 18 }]);
    expect((await samplePath(join(dir, 'note.md'))).exists).toBe(true);
    const scan = await scanDirectory(dir, []);
    expect(scan.state).toBe('ready');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
