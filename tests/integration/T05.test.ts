import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { GITHUB_LIVE_NETWORK, verifyGithubSignature } from '../../packages/integrations/sources/github.js';
import { admitChange, createSourceRegistry } from '../../packages/integrations/sources/registry.js';
import { createBlobStore, type BlobStore } from '../../packages/storage/src/blob-store.js';
import { openDatabase, type SqliteDatabase } from '../../packages/storage/src/database.js';

const NOW = '2026-11-16T12:00:00.000Z';
const EXPIRES = '2026-11-16T12:15:00.000Z';
const PRINCIPAL = { accountId: 'owner', dataDomain: 'personal' };
const WEBHOOK_SECRET = 'fixture-webhook-secret';
const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/sources/github/', import.meta.url));
const FIXTURE_TREE = join(FIXTURE_DIR, 'tree');
const MIGRATIONS = fileURLToPath(new URL('../../packages/storage/migrations/', import.meta.url));
const HASHES = {
  '0002_core.sql': '6e82bac75d455f28dc498874b61d0d778e1552b4bc5a8d1b5d7f5dfddfc06233',
  '0003_auth_control.sql': '3767d19a3f6c65f5ddae4f5f7d65a057082bfc978fec2d7e7a7a347f4cf2487f',
  '0004_hub_work.sql': 'bcd83075a607244bf5e5ee89efc621d0dd7670e42ace2b5884874ee8047dbcbe',
} as const;

type RevisionRow = { object_id: string; observed_seq: number; content_hash: string; tombstone: number };
type CursorRow = { cursor: string; phase: string; config_revision: number; sweep_count: number; updated_at: string };
type VersionRow = { config_revision: number; status: string; enabled: number };

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function temporaryDatabase(): { dir: string; db: SqliteDatabase; blobs: BlobStore; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t05-'));
  const db = openDatabase(join(dir, 'patrick.sqlite'));
  const blobs = createBlobStore(join(dir, 'blobs'));
  return {
    dir,
    db,
    blobs,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function contentRevisions(db: SqliteDatabase, sourceId: string): RevisionRow[] {
  return db.prepare(`SELECT object_id, observed_seq, content_hash, tombstone
    FROM source_revisions WHERE source_id = ? AND tombstone = 0 ORDER BY observed_seq`).all(sourceId) as RevisionRow[];
}

function cursorRow(db: SqliteDatabase, sourceId: string): CursorRow {
  return db.prepare(`SELECT cursor, phase, config_revision, sweep_count, updated_at
    FROM source_cursors WHERE source_id = ?`).get(sourceId) as CursorRow;
}

function versions(db: SqliteDatabase, sourceId: string): VersionRow[] {
  return db.prepare(`SELECT config_revision, status, enabled FROM source_versions
    WHERE source_id = ? ORDER BY config_revision`).all(sourceId) as VersionRow[];
}

function receiptKinds(db: SqliteDatabase, sourceId: string): string[] {
  return (db.prepare(`SELECT kind FROM collection_receipts WHERE source_id = ? ORDER BY rowid`).all(sourceId) as { kind: string }[])
    .map((row) => row.kind);
}

function countRows(db: SqliteDatabase, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function workCount(db: SqliteDatabase): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE destination = 'source-work'`).get() as { n: number };
  return row.n;
}

function directoryDraft(target: string, extras: { excludes?: string[]; hasTriggerRule?: boolean } = {}) {
  return {
    type: 'directory' as const,
    target,
    excludes: extras.excludes ?? [],
    hasTriggerRule: extras.hasTriggerRule ?? true,
    frequency: 'poll',
    history: 'none' as const,
  };
}

function githubDraft() {
  return {
    type: 'github' as const,
    target: 'github://fixture/notes',
    repo: 'fixture/notes',
    branch: 'main',
    path: 'docs',
    excludes: [] as string[],
    hasTriggerRule: true,
    frequency: 'poll',
    history: 'none' as const,
  };
}

test('admitChange accepts only an in-scope source edit with a trigger rule', () => {
  const change = { hasTriggerRule: true, origin: 'source', kind: 'modify', matchesScope: true, excluded: false } as const;
  expect(admitChange(change)).toBe(true);
  expect(admitChange({ ...change, origin: 'review' })).toBe(false);
  expect(admitChange({ ...change, excluded: true })).toBe(false);
  expect(admitChange({ ...change, origin: 'bot_output' })).toBe(false);
  expect(admitChange({ ...change, origin: 'system_view' })).toBe(false);
  expect(admitChange({ ...change, kind: 'delete' })).toBe(false);
  expect(admitChange({ ...change, kind: 'create' })).toBe(true);
  expect(admitChange({ ...change, hasTriggerRule: false })).toBe(false);
  expect(admitChange({ ...change, matchesScope: false })).toBe(false);
});

test('A to B to A keeps three revisions and enable is separate from the first collection', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'notes');
  mkdirSync(root);
  const file = join(root, 'note.txt');
  writeFileSync(file, 'A');
  try {
    const registry = createSourceRegistry(fx.db, { blobs: fx.blobs, now: () => NOW });
    const draft = directoryDraft(root);
    const configsBefore = countRows(fx.db, 'source_configs');
    const preview = await registry.detectSource(PRINCIPAL, draft);
    const again = await registry.detectSource(PRINCIPAL, draft);
    const enabled = await registry.enableSource(PRINCIPAL, draft);
    const baselineCursor = cursorRow(fx.db, enabled.sourceId);
    const first = await registry.collectSource(enabled.sourceId, enabled.configRevision);
    writeFileSync(file, 'B');
    const second = await registry.collectSource(enabled.sourceId, enabled.configRevision);
    writeFileSync(file, 'A');
    const third = await registry.collectSource(enabled.sourceId, enabled.configRevision);
    const revisions = contentRevisions(fx.db, enabled.sourceId);

    expect(revisions).toHaveLength(3);
    expect(configsBefore).toBe(0);
    expect(baselineCursor).toMatchObject({ cursor: preview.baseline, phase: 'baseline', config_revision: 1, sweep_count: 0 });
    expect(preview.sourceId).toBeNull();
    expect(preview.expiresAt).toBe(EXPIRES);
    expect(preview.baseline).toBe(`baseline:${preview.draftHash}`);
    expect(preview.draftHash).toHaveLength(64);
    expect(again.draftHash).toBe(preview.draftHash);
    expect(preview.samples).toEqual([{ locator: 'note.txt', byteLength: 1 }]);
    expect(preview.identity).toEqual({
      accountId: 'owner',
      dataDomain: 'personal',
      connectorType: 'directory',
      physicalRoot: realpathSync(root),
    });
    expect(preview.scope).toEqual({ repo: null, branch: null, path: null, root: realpathSync(root), excludes: [] });
    expect(enabled.kind).toBe('enable');
    expect(enabled.accepted).toBe(true);
    expect(enabled.configRevision).toBe(1);
    expect(enabled.cursor).toBe(preview.baseline);
    expect(enabled.count).toBe(0);
    expect(first.kind).toBe('first_collection');
    expect(first.accepted).toBe(true);
    expect(first.count).toBe(1);
    expect(second.kind).toBe('success');
    expect(third.kind).toBe('success');
    expect(revisions.map((row) => row.observed_seq)).toEqual([1, 2, 3]);
    expect(new Set(revisions.map((row) => row.object_id)).size).toBe(1);
    expect(revisions[0]?.content_hash).toBe(sha256(Buffer.from('A')));
    expect(revisions[1]?.content_hash).toBe(sha256(Buffer.from('B')));
    expect(revisions[2]?.content_hash).toBe(revisions[0]?.content_hash);
    expect(countRows(fx.db, 'blobs')).toBe(2);
    expect(Buffer.from(await fx.blobs.readBlob(revisions[0]!.content_hash)).equals(Buffer.from('A'))).toBe(true);
    expect(receiptKinds(fx.db, enabled.sourceId)).toEqual(['enable', 'first_collection', 'success', 'success']);
    expect(workCount(fx.db)).toBe(3);
    expect(cursorRow(fx.db, enabled.sourceId).phase).toBe('advanced');
    expect(cursorRow(fx.db, enabled.sourceId).cursor).not.toBe(preview.baseline);
  } finally {
    fx.close();
  }
});

test('one physical root keeps one collector', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'notes');
  mkdirSync(root);
  writeFileSync(join(root, 'note.txt'), 'A');
  try {
    const registry = createSourceRegistry(fx.db, { blobs: fx.blobs, now: () => NOW });
    const first = await registry.enableSource(PRINCIPAL, directoryDraft(root));
    const second = await registry.enableSource(PRINCIPAL, directoryDraft(root, { excludes: ['other.txt'] }));
    expect(second.sourceId).toBe(first.sourceId);
    expect(countRows(fx.db, 'source_configs')).toBe(1);
    expect(countRows(fx.db, 'source_versions')).toBe(1);
    const stored = fx.db.prepare('SELECT excludes_json FROM source_configs WHERE source_id = ?').get(first.sourceId) as { excludes_json: string };
    expect(JSON.parse(stored.excludes_json)).toEqual([]);
    mkdirSync(join(root, 'nested'));
    await expect(registry.enableSource(PRINCIPAL, directoryDraft(join(root, 'nested')))).rejects.toThrow('SOURCE_ROOT_TAKEN');
    expect(countRows(fx.db, 'source_configs')).toBe(1);
  } finally {
    fx.close();
  }
});

test('a paused source rejects an old receipt', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'notes');
  mkdirSync(root);
  writeFileSync(join(root, 'note.txt'), 'A');
  try {
    const registry = createSourceRegistry(fx.db, { blobs: fx.blobs, now: () => NOW });
    const enabled = await registry.enableSource(PRINCIPAL, directoryDraft(root));
    await registry.collectSource(enabled.sourceId, 1);
    const before = cursorRow(fx.db, enabled.sourceId);
    const paused = await registry.pauseSource(enabled.sourceId);
    writeFileSync(join(root, 'note.txt'), 'B');
    const late = await registry.collectSource(enabled.sourceId, 1);
    expect(paused.kind).toBe('pause');
    expect(paused.configRevision).toBe(2);
    expect(versions(fx.db, enabled.sourceId)).toEqual([
      { config_revision: 1, status: 'enabled', enabled: 1 },
      { config_revision: 2, status: 'paused', enabled: 0 },
    ]);
    expect(late.accepted).toBe(false);
    expect(late.reason).toBe('PAUSED');
    expect(contentRevisions(fx.db, enabled.sourceId)).toHaveLength(1);
    expect(cursorRow(fx.db, enabled.sourceId)).toEqual(before);
  } finally {
    fx.close();
  }
});

test('a late commit re-reads config revision after the blob is durable', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'notes');
  mkdirSync(root);
  const file = join(root, 'note.txt');
  writeFileSync(file, 'A');
  const holder: { pause: boolean; sourceId: string } = { pause: false, sourceId: '' };
  try {
    const registry = createSourceRegistry(fx.db, {
      blobs: fx.blobs,
      now: () => NOW,
      beforeCursorCommit() {
        if (holder.pause) void registry.pauseSource(holder.sourceId);
      },
    });
    const enabled = await registry.enableSource(PRINCIPAL, directoryDraft(root));
    holder.sourceId = enabled.sourceId;
    await registry.collectSource(enabled.sourceId, 1);
    const before = cursorRow(fx.db, enabled.sourceId);
    writeFileSync(file, 'B');
    holder.pause = true;
    const late = await registry.collectSource(enabled.sourceId, 1);
    expect(late.accepted).toBe(false);
    expect(late.reason).toBe('PAUSED');
    expect(contentRevisions(fx.db, enabled.sourceId).map((row) => row.content_hash)).toEqual([sha256(Buffer.from('A'))]);
    expect(cursorRow(fx.db, enabled.sourceId)).toEqual(before);
    expect(existsSync(fx.blobs.pathFor(sha256(Buffer.from('B'))))).toBe(true);
    expect(fx.db.prepare('SELECT status FROM source_configs WHERE source_id = ?').get(enabled.sourceId)).toEqual({ status: 'paused' });
  } finally {
    fx.close();
  }
});

test('an excluded path is not collected and a source without a trigger stores no work', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'notes');
  mkdirSync(root);
  writeFileSync(join(root, 'note.txt'), 'keep');
  writeFileSync(join(root, 'skip.txt'), 'drop');
  const quietRoot = join(fx.dir, 'quiet');
  mkdirSync(quietRoot);
  writeFileSync(join(quietRoot, 'note.txt'), 'quiet');
  try {
    const registry = createSourceRegistry(fx.db, { blobs: fx.blobs, now: () => NOW });
    const enabled = await registry.enableSource(PRINCIPAL, directoryDraft(root, { excludes: ['skip.txt'] }));
    await registry.collectSource(enabled.sourceId, 1);
    const revisions = contentRevisions(fx.db, enabled.sourceId);
    expect(revisions).toHaveLength(1);
    expect(Buffer.from(await fx.blobs.readBlob(revisions[0]!.content_hash)).equals(Buffer.from('keep'))).toBe(true);
    expect(existsSync(fx.blobs.pathFor(sha256(Buffer.from('drop'))))).toBe(false);

    const quiet = await registry.enableSource(PRINCIPAL, directoryDraft(quietRoot, { hasTriggerRule: false }));
    await registry.collectSource(quiet.sourceId, 1);
    expect(contentRevisions(fx.db, quiet.sourceId)).toHaveLength(1);
    expect(workCount(fx.db)).toBe(1);
  } finally {
    fx.close();
  }
});

test('the directory watcher reads only after the file is stable', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'notes');
  mkdirSync(root);
  const file = join(root, 'note.txt');
  writeFileSync(file, 'partial');
  try {
    const registry = createSourceRegistry(fx.db, { blobs: fx.blobs, now: () => NOW });
    const enabled = await registry.enableSource(PRINCIPAL, directoryDraft(root));
    const first = await registry.wakeDirectory(enabled.sourceId, 'note.txt');
    expect(first.read).toBe(false);
    expect(contentRevisions(fx.db, enabled.sourceId)).toHaveLength(0);
    expect(existsSync(fx.blobs.pathFor(sha256(Buffer.from('partial'))))).toBe(false);
    writeFileSync(file, 'partial-complete');
    const second = await registry.wakeDirectory(enabled.sourceId, 'note.txt');
    expect(second.read).toBe(false);
    expect(contentRevisions(fx.db, enabled.sourceId)).toHaveLength(0);
    const third = await registry.wakeDirectory(enabled.sourceId, 'note.txt');
    expect(third.read).toBe(true);
    expect(third.receipt?.kind).toBe('first_collection');
    const revisions = contentRevisions(fx.db, enabled.sourceId);
    expect(revisions).toHaveLength(1);
    expect(Buffer.from(await fx.blobs.readBlob(revisions[0]!.content_hash)).equals(Buffer.from('partial-complete'))).toBe(true);
    expect(existsSync(fx.blobs.pathFor(sha256(Buffer.from('partial'))))).toBe(false);
  } finally {
    fx.close();
  }
});

async function wakeUntilStable(
  registry: ReturnType<typeof createSourceRegistry>,
  sourceId: string,
  locator: string,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await registry.wakeDirectory(sourceId, locator);
    if (result.read) return;
  }
  throw new Error(`wake did not stabilize ${locator}`);
}

test('a directory wake does not confirm sibling deletes', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'notes');
  mkdirSync(root);
  const fileA = join(root, 'a.txt');
  const fileB = join(root, 'b.txt');
  writeFileSync(fileA, 'alpha-0');
  writeFileSync(fileB, 'beta');
  try {
    const registry = createSourceRegistry(fx.db, { blobs: fx.blobs, now: () => NOW });
    const enabled = await registry.enableSource(PRINCIPAL, directoryDraft(root));
    const afterBaseline = cursorRow(fx.db, enabled.sourceId);
    await registry.collectSource(enabled.sourceId, 1);
    expect(cursorRow(fx.db, enabled.sourceId).sweep_count).toBe(afterBaseline.sweep_count + 1);

    writeFileSync(fileA, 'alpha-1');
    await wakeUntilStable(registry, enabled.sourceId, 'a.txt');
    writeFileSync(fileA, 'alpha-2');
    await wakeUntilStable(registry, enabled.sourceId, 'a.txt');

    const objectB = fx.db.prepare('SELECT object_id, tombstone FROM source_objects WHERE source_id = ? AND locator = ?').get(
      enabled.sourceId,
      'b.txt',
    ) as { object_id: string; tombstone: number };
    expect(objectB.tombstone).toBe(0);
    expect(
      fx.db.prepare('SELECT missing_streak FROM delete_sweeps WHERE source_id = ? AND object_id = ?').get(
        enabled.sourceId,
        objectB.object_id,
      ),
    ).toBeUndefined();
    expect(cursorRow(fx.db, enabled.sourceId).sweep_count).toBe(afterBaseline.sweep_count + 1);

    rmSync(fileB);
    const missing = await registry.collectSource(enabled.sourceId, 1);
    expect(missing.kind).toBe('success');
    expect(
      fx.db.prepare('SELECT missing_streak FROM delete_sweeps WHERE source_id = ? AND object_id = ?').get(
        enabled.sourceId,
        objectB.object_id,
      ),
    ).toEqual({ missing_streak: 1 });
    const confirmed = await registry.collectSource(enabled.sourceId, 1);
    expect(confirmed.kind).toBe('withdraw');
    expect(
      fx.db.prepare('SELECT tombstone FROM source_objects WHERE source_id = ? AND object_id = ?').get(
        enabled.sourceId,
        objectB.object_id,
      ),
    ).toEqual({ tombstone: 1 });
  } finally {
    fx.close();
  }
});

test('restoring withdrawn bytes stages a live revision again', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'notes');
  mkdirSync(root);
  const bytes = Buffer.from('gone-later');
  writeFileSync(join(root, 'note.txt'), bytes);
  try {
    const registry = createSourceRegistry(fx.db, { blobs: fx.blobs, now: () => NOW });
    const enabled = await registry.enableSource(PRINCIPAL, directoryDraft(root));
    await registry.collectSource(enabled.sourceId, 1);
    rmSync(join(root, 'note.txt'));
    await registry.collectSource(enabled.sourceId, 1);
    await registry.collectSource(enabled.sourceId, 1);
    expect(fx.db.prepare('SELECT tombstone FROM source_objects WHERE source_id = ?').get(enabled.sourceId)).toEqual({ tombstone: 1 });

    writeFileSync(join(root, 'note.txt'), bytes);
    const restored = await registry.collectSource(enabled.sourceId, 1);
    expect(restored.accepted).toBe(true);
    expect(fx.db.prepare('SELECT tombstone FROM source_objects WHERE source_id = ?').get(enabled.sourceId)).toEqual({ tombstone: 0 });
    const live = contentRevisions(fx.db, enabled.sourceId);
    expect(live).toHaveLength(2);
    expect(live[1]?.content_hash).toBe(sha256(bytes));
    expect(live[1]?.observed_seq).toBeGreaterThan(live[0]!.observed_seq);
  } finally {
    fx.close();
  }
});

test('offline and placeholder sweeps pause collection and do not confirm a delete', async () => {
  const offline = temporaryDatabase();
  const offlineRoot = join(offline.dir, 'notes');
  mkdirSync(offlineRoot);
  writeFileSync(join(offlineRoot, 'note.txt'), 'stay');
  try {
    const registry = createSourceRegistry(offline.db, { blobs: offline.blobs, now: () => NOW });
    const enabled = await registry.enableSource(PRINCIPAL, directoryDraft(offlineRoot));
    await registry.collectSource(enabled.sourceId, 1);
    const before = cursorRow(offline.db, enabled.sourceId);
    renameSync(realpathSync(offlineRoot), `${realpathSync(offlineRoot)}-offline`);
    const paused = await registry.collectSource(enabled.sourceId, 1);
    expect(paused.accepted).toBe(false);
    expect(paused.reason).toBe('OFFLINE');
    expect(cursorRow(offline.db, enabled.sourceId)).toEqual(before);
    expect(offline.db.prepare('SELECT tombstone FROM source_objects WHERE source_id = ?').get(enabled.sourceId)).toEqual({ tombstone: 0 });
    expect(offline.db.prepare('SELECT COUNT(*) AS n FROM delete_sweeps WHERE source_id = ?').get(enabled.sourceId)).toEqual({ n: 0 });
    expect(offline.db.prepare('SELECT status, enabled FROM source_configs WHERE source_id = ?').get(enabled.sourceId)).toEqual({
      status: 'offline',
      enabled: 0,
    });
  } finally {
    offline.close();
  }

  const held = temporaryDatabase();
  const root = join(held.dir, 'notes');
  mkdirSync(root);
  writeFileSync(join(root, 'note.txt'), 'stay');
  try {
    const registry = createSourceRegistry(held.db, { blobs: held.blobs, now: () => NOW });
    const enabled = await registry.enableSource(PRINCIPAL, directoryDraft(root));
    await registry.collectSource(enabled.sourceId, 1);
    const before = cursorRow(held.db, enabled.sourceId);
    rmSync(join(root, 'note.txt'));
    execFileSync('truncate', ['-s', '4096', join(root, 'cloud.bin')]);
    const paused = await registry.collectSource(enabled.sourceId, 1);
    expect(paused.accepted).toBe(false);
    expect(paused.reason).toBe('PLACEHOLDER');
    expect(cursorRow(held.db, enabled.sourceId)).toEqual(before);
    expect(held.db.prepare('SELECT tombstone FROM source_objects WHERE source_id = ?').get(enabled.sourceId)).toEqual({ tombstone: 0 });
    expect(held.db.prepare('SELECT COUNT(*) AS n FROM delete_sweeps WHERE source_id = ?').get(enabled.sourceId)).toEqual({ n: 0 });
    expect(existsSync(held.blobs.pathFor(sha256(Buffer.alloc(4096))))).toBe(false);
    expect(held.db.prepare('SELECT status FROM source_configs WHERE source_id = ?').get(enabled.sourceId)).toEqual({ status: 'placeholder' });
  } finally {
    held.close();
  }
});

test('two successful sweeps confirm a delete by withdrawing and checking dependencies', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'notes');
  mkdirSync(root);
  writeFileSync(join(root, 'note.txt'), 'gone-later');
  try {
    const registry = createSourceRegistry(fx.db, { blobs: fx.blobs, now: () => NOW });
    const enabled = await registry.enableSource(PRINCIPAL, directoryDraft(root));
    await registry.collectSource(enabled.sourceId, 1);
    expect(workCount(fx.db)).toBe(1);
    rmSync(join(root, 'note.txt'));
    const missing = await registry.collectSource(enabled.sourceId, 1);
    expect(missing.kind).toBe('success');
    expect(missing.count).toBe(0);
    expect(fx.db.prepare('SELECT tombstone FROM source_objects WHERE source_id = ?').get(enabled.sourceId)).toEqual({ tombstone: 0 });
    expect(fx.db.prepare('SELECT missing_streak FROM delete_sweeps WHERE source_id = ?').get(enabled.sourceId)).toEqual({ missing_streak: 1 });
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM dependency_checks WHERE source_id = ?').get(enabled.sourceId)).toEqual({ n: 0 });
    const confirmed = await registry.collectSource(enabled.sourceId, 1);
    expect(confirmed.kind).toBe('withdraw');
    expect(confirmed.accepted).toBe(true);
    expect(fx.db.prepare('SELECT tombstone FROM source_objects WHERE source_id = ?').get(enabled.sourceId)).toEqual({ tombstone: 1 });
    expect(fx.db.prepare('SELECT reason FROM dependency_checks WHERE source_id = ?').get(enabled.sourceId)).toEqual({ reason: 'source_withdrawn' });
    expect(contentRevisions(fx.db, enabled.sourceId)).toHaveLength(1);
    expect(workCount(fx.db)).toBe(1);
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE destination = 'source-dependency'`).get()).toEqual({ n: 1 });
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM domain_events WHERE payload LIKE '%"admitted":true%'`).get()).toEqual({ n: 1 });
  } finally {
    fx.close();
  }
});

test('a target carrying credentials is rejected before a source is saved', async () => {
  const fx = temporaryDatabase();
  try {
    const registry = createSourceRegistry(fx.db, { blobs: fx.blobs, now: () => NOW, githubFixtureRoot: FIXTURE_TREE });
    await expect(registry.detectSource(PRINCIPAL, {
      type: 'github',
      target: 'https://user:token@github.com/fixture/notes',
      repo: 'fixture/notes',
      branch: 'main',
      path: 'docs',
    })).rejects.toThrow('SOURCE_CREDENTIAL_IN_TARGET');
    expect(countRows(fx.db, 'source_configs')).toBe(0);
  } finally {
    fx.close();
  }
});

test('a signed local github fixture collects only the approved object and does not use the live network', async () => {
  const fx = temporaryDatabase();
  const tree = join(fx.dir, 'github-tree');
  cpSync(FIXTURE_TREE, tree, { recursive: true });
  const notePath = join(tree, 'fixture/notes/main/docs/note.txt');
  const secretPath = join(tree, 'fixture/notes/main/secret/hidden.txt');
  symlinkSync(secretPath, join(tree, 'fixture/notes/main/docs/alias.txt'));
  const note = readFileSync(notePath);
  const secret = readFileSync(secretPath);
  const rawBody = readFileSync(join(FIXTURE_DIR, 'push.json'));
  const signature = readFileSync(join(FIXTURE_DIR, 'push.sig'), 'utf8').trim();
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    calls.push(String(input));
    throw new Error('GITHUB_NETWORK_NOT_USED');
  }) as typeof globalThis.fetch;
  try {
    expect(GITHUB_LIVE_NETWORK).toBe('not-used');
    expect(verifyGithubSignature(rawBody, signature, WEBHOOK_SECRET)).toBe(true);
    expect(verifyGithubSignature(rawBody, `sha256=${'0'.repeat(64)}`, WEBHOOK_SECRET)).toBe(false);
    const registry = createSourceRegistry(fx.db, { blobs: fx.blobs, now: () => NOW, githubFixtureRoot: tree });
    const preview = await registry.detectSource(PRINCIPAL, githubDraft());
    expect(preview.samples).toEqual([{ locator: 'docs/note.txt', byteLength: note.byteLength }]);
    expect(preview.identity.physicalRoot).toBe('github://fixture/notes@main/docs');
    const enabled = await registry.enableSource(PRINCIPAL, githubDraft());
    const baseline = cursorRow(fx.db, enabled.sourceId);
    const forged = await registry.ingestGithubWebhook({
      sourceId: enabled.sourceId,
      configRevision: enabled.configRevision,
      rawBody,
      signature: `sha256=${'ab'.repeat(32)}`,
      deliveryId: 'delivery-push-1',
      secret: WEBHOOK_SECRET,
    });
    expect(forged.accepted).toBe(false);
    expect(forged.reason).toBe('BAD_SIGNATURE');
    expect(cursorRow(fx.db, enabled.sourceId)).toEqual(baseline);
    expect(countRows(fx.db, 'webhook_deliveries')).toBe(0);
    expect(contentRevisions(fx.db, enabled.sourceId)).toHaveLength(0);
    expect(existsSync(fx.blobs.pathFor(sha256(note)))).toBe(false);
    expect(existsSync(fx.blobs.pathFor(sha256(secret)))).toBe(false);

    const ingested = await registry.ingestGithubWebhook({
      sourceId: enabled.sourceId,
      configRevision: enabled.configRevision,
      rawBody,
      signature,
      deliveryId: 'delivery-push-1',
      secret: WEBHOOK_SECRET,
    });
    expect(ingested.accepted).toBe(true);
    expect(ingested.kind).toBe('first_collection');
    expect(ingested.evidenceRef).toMatch(/^local-fixture:[a-f0-9]{64}$/);
    const after = cursorRow(fx.db, enabled.sourceId);
    expect(after.cursor).toBe('delivery:delivery-push-1');
    expect(after.cursor).not.toBe(baseline.cursor);
    expect(contentRevisions(fx.db, enabled.sourceId)).toHaveLength(1);
    expect(existsSync(fx.blobs.pathFor(sha256(note)))).toBe(true);
    expect(existsSync(fx.blobs.pathFor(sha256(secret)))).toBe(false);
    expect(countRows(fx.db, 'webhook_deliveries')).toBe(1);

    writeFileSync(notePath, 'local-fixture-note-v2\n');
    const repeated = await registry.ingestGithubWebhook({
      sourceId: enabled.sourceId,
      configRevision: enabled.configRevision,
      rawBody,
      signature,
      deliveryId: 'delivery-push-1',
      secret: WEBHOOK_SECRET,
    });
    expect(repeated.accepted).toBe(false);
    expect(repeated.reason).toBe('DUPLICATE_EVENT');
    expect(cursorRow(fx.db, enabled.sourceId)).toEqual(after);
    expect(contentRevisions(fx.db, enabled.sourceId)).toHaveLength(1);
    expect(countRows(fx.db, 'webhook_deliveries')).toBe(1);
    expect(existsSync(fx.blobs.pathFor(sha256(Buffer.from('local-fixture-note-v2\n'))))).toBe(false);

    const caughtUp = await registry.collectSource(enabled.sourceId, enabled.configRevision);
    expect(caughtUp.accepted).toBe(true);
    expect(caughtUp.kind).toBe('success');
    const revisions = contentRevisions(fx.db, enabled.sourceId);
    expect(revisions).toHaveLength(2);
    expect(revisions[1]?.content_hash).toBe(sha256(Buffer.from('local-fixture-note-v2\n')));
    expect(new Set(revisions.map((row) => row.object_id)).size).toBe(1);
    expect(existsSync(fx.blobs.pathFor(sha256(secret)))).toBe(false);
    expect(calls).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
    fx.close();
  }
});

test('review and bot deliveries are saved once and do not collect or create work', async () => {
  const fx = temporaryDatabase();
  try {
    const registry = createSourceRegistry(fx.db, { blobs: fx.blobs, now: () => NOW, githubFixtureRoot: FIXTURE_TREE });
    const enabled = await registry.enableSource(PRINCIPAL, githubDraft());
    const baseline = cursorRow(fx.db, enabled.sourceId);
    const reviewBody = readFileSync(join(FIXTURE_DIR, 'review.json'));
    const review = await registry.ingestGithubWebhook({
      sourceId: enabled.sourceId,
      configRevision: 1,
      rawBody: reviewBody,
      signature: readFileSync(join(FIXTURE_DIR, 'review.sig'), 'utf8').trim(),
      deliveryId: 'delivery-review-1',
      secret: WEBHOOK_SECRET,
    });
    expect(review.accepted).toBe(false);
    expect(review.reason).toBe('IGNORED_ORIGIN');
    expect(contentRevisions(fx.db, enabled.sourceId)).toHaveLength(0);
    expect(cursorRow(fx.db, enabled.sourceId)).toEqual(baseline);
    expect(workCount(fx.db)).toBe(0);
    expect(countRows(fx.db, 'webhook_deliveries')).toBe(1);
    await registry.ingestGithubWebhook({
      sourceId: enabled.sourceId,
      configRevision: 1,
      rawBody: reviewBody,
      signature: readFileSync(join(FIXTURE_DIR, 'review.sig'), 'utf8').trim(),
      deliveryId: 'delivery-review-1',
      secret: WEBHOOK_SECRET,
    });
    expect(countRows(fx.db, 'webhook_deliveries')).toBe(1);
    expect(cursorRow(fx.db, enabled.sourceId)).toEqual(baseline);

    const botBody = readFileSync(join(FIXTURE_DIR, 'bot.json'));
    const bot = await registry.ingestGithubWebhook({
      sourceId: enabled.sourceId,
      configRevision: 1,
      rawBody: botBody,
      signature: readFileSync(join(FIXTURE_DIR, 'bot.sig'), 'utf8').trim(),
      deliveryId: 'delivery-bot-1',
      secret: WEBHOOK_SECRET,
    });
    expect(bot.reason).toBe('IGNORED_ORIGIN');
    expect(contentRevisions(fx.db, enabled.sourceId)).toHaveLength(0);
    expect(workCount(fx.db)).toBe(0);
    expect(cursorRow(fx.db, enabled.sourceId)).toEqual(baseline);
    expect(countRows(fx.db, 'webhook_deliveries')).toBe(2);
  } finally {
    fx.close();
  }
});

test('the source migration appends without changing earlier files', () => {
  const manifest = JSON.parse(readFileSync(join(MIGRATIONS, 'manifest.json'), 'utf8')) as { file: string; sha256: string }[];
  expect(manifest.map((entry) => entry.file)).toEqual([
    '0002_core.sql',
    '0003_auth_control.sql',
    '0004_hub_work.sql',
    '0005_sources.sql',
    '0006_vault_evidence.sql',
    '0007_standards.sql',
    '0008_admission_budget.sql',
    '0010_answers_channels.sql',
    '0011_conversations.sql',
    '0012_effects_outcomes.sql',
    '0013_views.sql',
    '0017_settings.sql',
    '0018_delegation_control.sql',
    '0019_stats.sql',
  ]);
  for (const [file, hash] of Object.entries(HASHES)) {
    expect(manifest.find((entry) => entry.file === file)?.sha256).toBe(hash);
    expect(sha256(readFileSync(join(MIGRATIONS, file)))).toBe(hash);
  }
  const sourceHash = sha256(readFileSync(join(MIGRATIONS, '0005_sources.sql')));
  expect(manifest[3]?.sha256).toBe(sourceHash);
  const fx = temporaryDatabase();
  try {
    expect(fx.db.prepare('SELECT file, sha256 FROM schema_migrations ORDER BY position').all()).toEqual(manifest);
  } finally {
    fx.close();
  }
});
