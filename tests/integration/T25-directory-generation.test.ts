import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openDatabase } from '../../packages/storage/src/database.js';
import { createBlobStore } from '../../packages/storage/src/blob-store.js';
import { createSourceRegistry } from '../../packages/integrations/sources/registry.js';

test('a newer wake commit rejects an older full scan and keeps the latest revision', async () => {
 const root = mkdtempSync(join(tmpdir(), 'patrick-dir-race-'));
 const sourceRoot = join(root, 'source'); mkdirSync(sourceRoot);
 const file = join(sourceRoot, 'demand.md'); writeFileSync(file, 'A');
 const first = openDatabase(join(root, 'state.sqlite'));
 const second = openDatabase(join(root, 'state.sqlite'));
 const blobs = createBlobStore(join(root, 'blobs'));
 let release!: () => void;
 let held!: () => void;
 const paused = new Promise<void>((resolve) => { held = resolve; });
 const gate = new Promise<void>((resolve) => { release = resolve; });
 const slowBlobs = { ...blobs, async putBlob(bytes: Uint8Array) {
   const result = await blobs.putBlob(bytes);
   if (Buffer.from(bytes).toString() === 'B') { held(); await gate; }
   return result;
 }};
 const slow = createSourceRegistry(first, { blobs: slowBlobs });
 const fast = createSourceRegistry(second, { blobs });
 let pending: Promise<unknown> | undefined;
 try {
   const source = await slow.enableSource({ accountId: 'owner', dataDomain: 'personal' }, { type: 'directory', target: sourceRoot });
   await slow.collectSource(source.sourceId, source.configRevision);
   writeFileSync(file, 'B');
   pending = slow.collectSource(source.sourceId, source.configRevision);
   await Promise.race([paused, new Promise((_, reject) => setTimeout(() => reject(new Error('barrier timeout')), 5000))]);
   const before = second.prepare('SELECT sweep_count,cursor FROM source_cursors WHERE source_id=?').get(source.sourceId);
   writeFileSync(file, 'C');
   const wake1 = await fast.wakeDirectory(source.sourceId, 'demand.md');
   const wake2 = await fast.wakeDirectory(source.sourceId, 'demand.md');
   expect(wake1.read).toBe(false);
   expect(wake2.read).toBe(true);
   const afterWake = second.prepare('SELECT sweep_count,cursor FROM source_cursors WHERE source_id=?').get(source.sourceId);
   release();
   const olderReceipt = await pending;
   const hashes = Object.fromEntries(['A','B','C'].map((value) => [createHash('sha256').update(value).digest('hex'), value]));
   const rows = first.prepare('SELECT observed_seq,content_hash FROM source_revisions ORDER BY observed_seq').all() as {observed_seq:number;content_hash:string}[];
   const observed = rows.map((row) => hashes[row.content_hash]);
   console.log(JSON.stringify({before,afterWake,wake2,olderReceipt,observed}));
   expect(afterWake).toEqual(before);
   expect(observed).toEqual(['A','C']);
   expect(olderReceipt).toMatchObject({ accepted: false, reason: 'STALE_COLLECTION' });
 } finally {
   release();
   if (pending) await pending.catch(() => {});
   first.close(); second.close(); rmSync(root, {recursive:true,force:true});
 }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function state(db: ReturnType<typeof openDatabase>) {
  return Object.fromEntries(['directory_commit_generations', 'source_objects', 'source_revisions', 'source_revision_provenance',
    'source_cursors', 'delete_sweeps', 'collection_receipts', 'domain_events', 'outbox'].map((name) => [name, db.prepare(`SELECT * FROM ${name}`).all()]));
}

async function makeRace() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-s1a-race-'));
  const sourceRoot = join(root, 'source'); mkdirSync(sourceRoot);
  const file = join(sourceRoot, 'demand.md'); writeFileSync(file, 'A');
  const first = openDatabase(join(root, 'state.sqlite'));
  const second = openDatabase(join(root, 'state.sqlite'));
  const blobs = createBlobStore(join(root, 'blobs'));
  const held = deferred(); const release = deferred();
  const slow = createSourceRegistry(first, { blobs: { ...blobs, async putBlob(bytes: Uint8Array) {
    const result = await blobs.putBlob(bytes);
    if (Buffer.from(bytes).toString() === 'B') { held.resolve(); await release.promise; }
    return result;
  } } });
  const fast = createSourceRegistry(second, { blobs });
  const source = await slow.enableSource({ accountId: 'owner', dataDomain: 'personal' }, {
    type: 'directory', target: sourceRoot, hasTriggerRule: true,
  });
  await slow.collectSource(source.sourceId, 1);
  return { root, sourceRoot, file, first, second, blobs, slow, fast, source, held, release,
    close() { release.resolve(); first.close(); second.close(); rmSync(root, { recursive: true, force: true }); } };
}

async function awaitBarrier(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('barrier timeout')), 5000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

test.each([
  { older: 'full', newer: 'full' },
  { older: 'wake', newer: 'full' },
  { older: 'wake', newer: 'wake' },
] as const)('a later $newer commit rejects an earlier $older snapshot', async ({ older, newer }) => {
  const f = await makeRace();
  let pending: Promise<unknown> | undefined;
  try {
    writeFileSync(f.file, 'B');
    if (older === 'wake') expect((await f.slow.wakeDirectory(f.source.sourceId, 'demand.md')).read).toBe(false);
    pending = older === 'wake' ? f.slow.wakeDirectory(f.source.sourceId, 'demand.md') : f.slow.collectSource(f.source.sourceId, 1);
    await awaitBarrier(f.held.promise);
    writeFileSync(f.file, 'C');
    if (newer === 'wake') {
      expect((await f.fast.wakeDirectory(f.source.sourceId, 'demand.md')).read).toBe(false);
      expect((await f.fast.wakeDirectory(f.source.sourceId, 'demand.md')).receipt).toMatchObject({ accepted: true, count: 1 });
    } else expect(await f.fast.collectSource(f.source.sourceId, 1)).toMatchObject({ accepted: true, count: 1 });
    const afterNewer = state(f.second);
    f.release.resolve();
    const result = await pending;
    const receipt = older === 'wake' ? (result as { receipt: unknown }).receipt : result;
    expect(receipt).toMatchObject({ accepted: false, reason: 'STALE_COLLECTION' });
    expect(state(f.first)).toEqual(afterNewer);
    writeFileSync(f.file, 'D');
    expect(await f.fast.collectSource(f.source.sourceId, 1)).toMatchObject({ accepted: true, count: 1 });
    const hashes = f.first.prepare('SELECT content_hash FROM source_revisions ORDER BY observed_seq').all() as { content_hash: string }[];
    expect(hashes.map((row) => row.content_hash)).toEqual(['A', 'C', 'D'].map((value) => createHash('sha256').update(value).digest('hex')));
  } finally { f.release.resolve(); if (pending) await pending.catch(() => {}); f.close(); }
});

test.each(['full', 'wake'] as const)('a newer no-change %s commit fences an older changed scan', async (newer) => {
  const f = await makeRace();
  let pending: Promise<unknown> | undefined;
  try {
    writeFileSync(f.file, 'B');
    pending = f.slow.collectSource(f.source.sourceId, 1);
    await awaitBarrier(f.held.promise);
    writeFileSync(f.file, 'A');
    let receipt: unknown;
    if (newer === 'wake') {
      await f.fast.wakeDirectory(f.source.sourceId, 'demand.md');
      receipt = (await f.fast.wakeDirectory(f.source.sourceId, 'demand.md')).receipt;
    } else receipt = await f.fast.collectSource(f.source.sourceId, 1);
    expect(receipt).toMatchObject({ accepted: true, count: 0 });
    const afterNewer = state(f.second);
    f.release.resolve();
    expect(await pending).toMatchObject({ accepted: false, reason: 'STALE_COLLECTION' });
    expect(state(f.first)).toEqual(afterNewer);
    expect(f.first.prepare('SELECT COUNT(*) AS n FROM source_revisions').get()).toEqual({ n: 1 });
  } finally { f.release.resolve(); if (pending) await pending.catch(() => {}); f.close(); }
});

test('an older deletion sweep cannot tombstone a file restored before a newer sweep', async () => {
  const f = await makeRace();
  const kept = join(f.sourceRoot, 'keep.md');
  let pending: Promise<unknown> | undefined;
  try {
    writeFileSync(kept, 'keep');
    await f.fast.collectSource(f.source.sourceId, 1);
    rmSync(kept);
    await f.fast.collectSource(f.source.sourceId, 1);
    expect(f.first.prepare('SELECT missing_streak FROM delete_sweeps').get()).toEqual({ missing_streak: 1 });
    writeFileSync(f.file, 'B');
    pending = f.slow.collectSource(f.source.sourceId, 1);
    await awaitBarrier(f.held.promise);
    writeFileSync(kept, 'keep');
    expect(await f.fast.collectSource(f.source.sourceId, 1)).toMatchObject({ accepted: true });
    const afterNewer = state(f.second);
    f.release.resolve();
    expect(await pending).toMatchObject({ accepted: false, reason: 'STALE_COLLECTION' });
    expect(state(f.first)).toEqual(afterNewer);
    expect(f.first.prepare("SELECT tombstone FROM source_objects WHERE locator='keep.md'").get()).toEqual({ tombstone: 0 });
    expect(f.first.prepare("SELECT COUNT(*) AS n FROM outbox WHERE destination='source-dependency'").get()).toEqual({ n: 0 });
  } finally { f.release.resolve(); if (pending) await pending.catch(() => {}); f.close(); }
});

test.each(['source_revision_provenance', 'outbox', 'collection_receipts'] as const)('a failure in %s rolls back generation and all source writes', async (table) => {
  const f = await makeRace();
  try {
    const before = state(f.first);
    writeFileSync(f.file, 'C');
    f.first.exec(`CREATE TEMP TRIGGER fail_s1a BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'S1A_INJECTED'); END`);
    await expect(f.slow.collectSource(f.source.sourceId, 1)).rejects.toThrow('S1A_INJECTED');
    expect(state(f.first)).toEqual(before);
    f.first.exec('DROP TRIGGER fail_s1a');
    expect(await f.slow.collectSource(f.source.sourceId, 1)).toMatchObject({ accepted: true, count: 1 });
  } finally { f.close(); }
});

test('a different source commits independently without invalidating a pending scan', async () => {
  const f = await makeRace();
  let pending: Promise<unknown> | undefined;
  try {
    const otherRoot = join(f.root, 'other'); mkdirSync(otherRoot); writeFileSync(join(otherRoot, 'other.md'), 'other');
    const other = await f.fast.enableSource({ accountId: 'owner', dataDomain: 'personal' }, { type: 'directory', target: otherRoot });
    writeFileSync(f.file, 'B'); pending = f.slow.collectSource(f.source.sourceId, 1); await awaitBarrier(f.held.promise);
    expect(await f.fast.collectSource(other.sourceId, 1)).toMatchObject({ accepted: true, count: 1 });
    f.release.resolve();
    expect(await pending).toMatchObject({ accepted: true, count: 1 });
    expect(f.first.prepare('SELECT source_id,commit_generation FROM directory_commit_generations ORDER BY source_id').all())
      .toHaveLength(2);
  } finally { f.release.resolve(); if (pending) await pending.catch(() => {}); f.close(); }
});

test('directory generation rejects reset, deletion and replacement', async () => {
  const f = await makeRace();
  try {
    expect(f.first.prepare('SELECT commit_generation FROM directory_commit_generations WHERE source_id=?').get(f.source.sourceId))
      .toEqual({ commit_generation: 1 });
    expect(() => f.first.prepare('UPDATE directory_commit_generations SET commit_generation=0 WHERE source_id=?').run(f.source.sourceId)).toThrow();
    expect(() => f.first.prepare('DELETE FROM directory_commit_generations WHERE source_id=?').run(f.source.sourceId)).toThrow();
    expect(() => f.first.prepare(`INSERT OR REPLACE INTO directory_commit_generations
      (source_id,account_id,data_domain,commit_generation) VALUES (?,?,?,0)`).run(f.source.sourceId, 'owner', 'personal')).toThrow();
    expect(f.first.prepare('SELECT commit_generation FROM directory_commit_generations WHERE source_id=?').get(f.source.sourceId))
      .toEqual({ commit_generation: 1 });
  } finally { f.close(); }
});

test('a failed confirmed deletion rolls back its generation and can be rescanned', async () => {
  const f = await makeRace();
  try {
    rmSync(f.file);
    await f.slow.collectSource(f.source.sourceId, 1);
    const before = state(f.first);
    f.first.exec("CREATE TEMP TRIGGER fail_delete_provenance BEFORE INSERT ON source_revision_provenance BEGIN SELECT RAISE(ABORT,'S1A_DELETE_FAILURE'); END");
    await expect(f.slow.collectSource(f.source.sourceId, 1)).rejects.toThrow('S1A_DELETE_FAILURE');
    expect(state(f.first)).toEqual(before);
    f.first.exec('DROP TRIGGER fail_delete_provenance');
    expect(await f.slow.collectSource(f.source.sourceId, 1)).toMatchObject({ accepted: true, kind: 'withdraw' });
    expect(f.first.prepare('SELECT tombstone FROM source_revisions ORDER BY observed_seq').all()).toEqual([{ tombstone: 0 }, { tombstone: 1 }]);
    expect(f.first.prepare("SELECT COUNT(*) AS n FROM outbox WHERE destination='source-dependency'").get()).toEqual({ n: 1 });
  } finally { f.close(); }
});
