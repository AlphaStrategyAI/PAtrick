import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
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
import { expect, test, vi } from 'vitest';
import { createGithubApi, verifyGithubSignature } from '../../packages/integrations/sources/github.js';
import { admitChange, createSourceRegistry } from '../../packages/integrations/sources/registry.js';
import { dispatchSourceWork, sourceWorkId } from '../../packages/integrations/sources/work-dispatch.js';
import type { HubWireEvent } from '../../packages/integrations/autoloop/client.js';
import { createBlobStore, type BlobStore } from '../../packages/storage/src/blob-store.js';
import { openDatabase, type SqliteDatabase } from '../../packages/storage/src/database.js';
import { sourceSettingsHandlers } from '../../apps/service/src/settings/sources.js';
import { createCredentialStore } from '../../packages/host/src/credentials.js';
import { expectedMigrationManifest } from '../support/migration-manifest.js';

// Test-only bypass for legacy state-machine assertions; this is not an admitted production reader.
vi.mock('../../packages/integrations/sources/directory-capability.js', async (load) => {
  const actual = await load<typeof import('../../packages/integrations/sources/directory-capability.js')>();
  return { ...actual, assertDirectoryReaderAvailable: () => {} };
});

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

type PublishedEvent = { body: HubWireEvent; duplicate: boolean };

function recordingHub() {
  const published: PublishedEvent[] = [];
  return {
    published,
    postEvent(body: HubWireEvent) {
      const duplicate = published.some((entry) => entry.body.id === body.id);
      published.push({ body, duplicate });
      return Promise.resolve({ event: published.length, duplicate, routed: ['来源变化'] });
    },
  };
}

function seedMandate(db: SqliteDatabase, domain = 'personal', mandateId = 'mandate-source'): void {
  db.prepare(`INSERT INTO mandate_types (
    type_id, account_id, data_domain, actions_json, resources_json, effects_json, domains_json, risk, level,
    budget_micros, config_version, schema_version, created_at
  ) VALUES ('type-source', 'owner', ?, '[]', '[]', '[]', '[]', 'low', 'L1', 5000, 1, '1.0', ?)`).run(domain, NOW);
  db.prepare(`INSERT INTO mandates (
    mandate_id, type_id, account_id, data_domain, status, actions_json, resources_json, effects_json, domains_json,
    risk, level, budget_micros, expires_at, revision, scope_hash, config_version, schema_version, created_at, updated_at
  ) VALUES (?, 'type-source', 'owner', ?, 'active', '[]', '[]', '[]', '[]', 'low', 'L1', 5000,
    '2027-01-01T00:00:00.000Z', 0, ?, 1, '1.0', ?, ?)`).run(mandateId, domain, 'e'.repeat(64), NOW, NOW);
}

function seedExternalMethodPolicy(db: SqliteDatabase, domain = 'personal'): void {
  db.prepare(`INSERT INTO evaluation_policies (
    policy_id, policy_version, data_domain, dataset_id, min_samples, threshold_thousandths, budget_micros,
    external_method_id, external_method_revision, external_rules_json, schema_version, created_at
  ) VALUES ('policy-external', 1, ?, 'dataset-external', 1, 0, 0, 'method-demand-interview', '2026.1', '[]', '1.0', ?)`)
    .run(domain, NOW);
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
    // Without an admitted API port the reader stays on the fixture tree and
    // never reaches the network.
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
    ...expectedMigrationManifest(MIGRATIONS).map((entry) => entry.file),
  ]);
  expect(manifest).toEqual(expectedMigrationManifest(MIGRATIONS));
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

test('an admitted source change becomes one work root dispatched to the hub', async () => {
  const fx = temporaryDatabase();
  try {
    seedMandate(fx.db);
    seedExternalMethodPolicy(fx.db);
    const root = mkdtempSync(join(tmpdir(), 'patrick-t05-work-'));
    const notes = join(root, 'notes');
    mkdirSync(notes);
    writeFileSync(join(notes, 'idea.md'), '# idea\n');
    const registry = createSourceRegistry(fx.db, { blobs: fx.blobs, now: () => NOW });
    const source = await registry.enableSource(PRINCIPAL, directoryDraft(notes));
    await registry.collectSource(source.sourceId, 1);
    expect(workCount(fx.db)).toBe(1);
    const hub = recordingHub();
    const result = await dispatchSourceWork(fx.db, hub, { now: () => new Date(NOW) });
    expect(result.deferred).toEqual([]);
    expect(result.dispatched).toHaveLength(1);

    const work = fx.db.prepare('SELECT work_id, root_event_id, cause_event_id, source_revision, generation, hub_lane FROM work_refs')
      .all() as Array<{ work_id: string; root_event_id: string; cause_event_id: string; source_revision: string; generation: number; hub_lane: string }>;
    expect(work).toHaveLength(1);
    expect(work[0].work_id).toMatch(/^W-[0-9A-F]{12}$/);
    const object = fx.db.prepare('SELECT source_id, object_id FROM source_objects LIMIT 1').get() as {
      source_id: string;
      object_id: string;
    };
    expect(work[0].work_id).toBe(sourceWorkId(object.source_id, object.object_id));
    expect(work[0].hub_lane).toBe('work');
    expect(work[0].generation).toBe(1);
    expect(work[0].root_event_id).toBe(work[0].cause_event_id);

    const generations = fx.db.prepare('SELECT work_id, generation, phase, next_action, mandate_id, control_state FROM work_generations')
      .all() as Array<{ work_id: string; generation: number; phase: string; next_action: string; mandate_id: string; control_state: string }>;
    expect(generations).toEqual([{
      work_id: work[0].work_id,
      generation: 1,
      phase: 'judgment',
      next_action: 'judge',
      mandate_id: 'mandate-source',
      control_state: 'running',
    }]);

    const basis = fx.db.prepare('SELECT work_id, generation, basis_hash, external_method_id FROM judgment_bases').all() as Array<{
      work_id: string;
      generation: number;
      basis_hash: string;
      external_method_id: string | null;
    }>;
    expect(basis).toHaveLength(1);
    expect(basis[0].work_id).toBe(work[0].work_id);
    expect(basis[0].external_method_id).toBe('method-demand-interview');

    expect(hub.published).toHaveLength(1);
    expect(hub.published[0].body.type).toBe('source.changed');
    expect(hub.published[0].body.summary).toBe('work.requested');
    expect(JSON.parse(hub.published[0].body.detail)).toMatchObject({
      root: work[0].root_event_id,
      cause: work[0].cause_event_id,
      generation: 1,
      kind: 'work.requested',
    });
    expect(fx.db.prepare("SELECT result FROM outbox WHERE destination = 'source-work'").all())
      .toEqual([{ result: 'accepted' }]);
  } finally {
    fx.close();
  }
});

test('replaying the dispatch keeps one work and one generation', async () => {
  const fx = temporaryDatabase();
  try {
    seedMandate(fx.db);
    seedExternalMethodPolicy(fx.db);
    const root = mkdtempSync(join(tmpdir(), 'patrick-t05-replay-'));
    const notes = join(root, 'notes');
    mkdirSync(notes);
    writeFileSync(join(notes, 'idea.md'), '# idea\n');
    const registry = createSourceRegistry(fx.db, { blobs: fx.blobs, now: () => NOW });
    const source = await registry.enableSource(PRINCIPAL, directoryDraft(notes));
    await registry.collectSource(source.sourceId, 1);
    const hub = recordingHub();
    await dispatchSourceWork(fx.db, hub, { now: () => new Date(NOW) });
    const before = fx.db.prepare('SELECT work_id, generation FROM work_refs').all();
    const again = await dispatchSourceWork(fx.db, hub, { now: () => new Date(NOW) });
    expect(again.dispatched).toEqual([]);
    expect(fx.db.prepare('SELECT work_id, generation FROM work_refs').all()).toEqual(before);
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM work_generations').get()).toEqual({ n: 1 });
    expect(hub.published).toHaveLength(1);
  } finally {
    fx.close();
  }
});

test('a trigger without an active delegation scope defers instead of dispatching', async () => {
  const fx = temporaryDatabase();
  try {
    seedExternalMethodPolicy(fx.db);
    const root = mkdtempSync(join(tmpdir(), 'patrick-t05-scope-'));
    const notes = join(root, 'notes');
    mkdirSync(notes);
    writeFileSync(join(notes, 'idea.md'), '# idea\n');
    const registry = createSourceRegistry(fx.db, { blobs: fx.blobs, now: () => NOW });
    const source = await registry.enableSource(PRINCIPAL, directoryDraft(notes));
    await registry.collectSource(source.sourceId, 1);
    const hub = recordingHub();
    const result = await dispatchSourceWork(fx.db, hub, { now: () => new Date(NOW) });
    expect(result.dispatched).toEqual([]);
    expect(result.deferred).toEqual([{ event_id: expect.any(String), reason: 'NO_ACTIVE_MANDATE' }]);
    expect(hub.published).toEqual([]);
    expect(fx.db.prepare("SELECT result FROM outbox WHERE destination = 'source-work'").all()).toEqual([{ result: null }]);
  } finally {
    fx.close();
  }
});

test('an explicit trigger rule selects the mandate type the work runs under', async () => {
  const fx = temporaryDatabase();
  try {
    seedMandate(fx.db);
    seedExternalMethodPolicy(fx.db);
    fx.db.prepare(`INSERT INTO mandate_types (
      type_id, account_id, data_domain, actions_json, resources_json, effects_json, domains_json, risk, level,
      budget_micros, config_version, schema_version, created_at
    ) VALUES ('type-other', 'owner', 'personal', '[]', '[]', '[]', '[]', 'high', 'L2', 9000, 1, '1.0', ?)`).run(NOW);
    fx.db.prepare(`INSERT INTO mandates (
      mandate_id, type_id, account_id, data_domain, status, actions_json, resources_json, effects_json, domains_json,
      risk, level, budget_micros, expires_at, revision, scope_hash, config_version, schema_version, created_at, updated_at
    ) VALUES ('mandate-other', 'type-other', 'owner', 'personal', 'active', '[]', '[]', '[]', '[]', 'high', 'L2', 9000,
      '2027-01-01T00:00:00.000Z', 0, ?, 1, '1.0', ?, ?)`).run('f'.repeat(64), NOW, NOW);
    const root = mkdtempSync(join(tmpdir(), 'patrick-t05-rule-'));
    const notes = join(root, 'notes');
    mkdirSync(notes);
    writeFileSync(join(notes, 'idea.md'), '# idea\n');
    const registry = createSourceRegistry(fx.db, { blobs: fx.blobs, now: () => NOW });
    const source = await registry.enableSource(PRINCIPAL, {
      ...directoryDraft(notes),
      triggerMandateTypeId: 'type-other',
    });
    const rule = fx.db.prepare('SELECT source_id, mandate_type_id, config_revision FROM source_trigger_rules').get() as {
      source_id: string;
      mandate_type_id: string;
      config_revision: number;
    };
    expect(rule).toEqual({ source_id: source.sourceId, mandate_type_id: 'type-other', config_revision: 1 });
    await registry.collectSource(source.sourceId, 1);
    const hub = recordingHub();
    const result = await dispatchSourceWork(fx.db, hub, { now: () => new Date(NOW) });
    expect(result.deferred).toEqual([]);
    expect(result.dispatched).toHaveLength(1);
    const generation = fx.db.prepare('SELECT mandate_id FROM work_generations').get() as { mandate_id: string };
    expect(generation.mandate_id).toBe('mandate-other');
  } finally {
    fx.close();
  }
});

test('the live GitHub reader lists a complete tree and reads a blob with the token', async () => {
  const seen: Array<{ url: string; authorization: string | undefined; version: string | undefined }> = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url ?? '', authorization: request.headers.authorization,
      version: request.headers['x-github-api-version'] as string | undefined });
    if ((request.url ?? '').includes('/git/trees/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ truncated: false, tree: [
        { path: 'docs', type: 'tree', sha: 'sha-dir', size: 0 },
        { path: 'docs/note.txt', type: 'blob', sha: 'sha-1', size: 12 },
      ] }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ content: Buffer.from('hello world\n').toString('base64'), encoding: 'base64' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const api = createGithubApi({ baseUrl: `http://127.0.0.1:${port}` });
    const entries = await api.listTree({ repo: 'fixture/notes', branch: 'main', token: 'token-fixture' });
    expect(entries).toEqual([
      { path: 'docs', type: 'tree', sha: 'sha-dir', size: 0 },
      { path: 'docs/note.txt', type: 'blob', sha: 'sha-1', size: 12 },
    ]);
    const bytes = await api.readBlob({ repo: 'fixture/notes', sha: 'sha-1', token: 'token-fixture' });
    expect(Buffer.from(bytes).toString('utf8')).toBe('hello world\n');
    expect(seen).toHaveLength(2);
    expect(seen[0]?.authorization).toBe('Bearer token-fixture');
    expect(seen[0]?.version).toBe('2022-11-28');
    expect(seen[0]?.url).toContain('/repos/fixture%2Fnotes/git/trees/main?recursive=1');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('the live GitHub reader refuses a truncated tree and reports a failed status', async () => {
  const server = createServer((request, response) => {
    if ((request.url ?? '').includes('/git/trees/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ truncated: true, tree: [] }));
      return;
    }
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const api = createGithubApi({ baseUrl: `http://127.0.0.1:${port}` });
    await expect(api.listTree({ repo: 'fixture/notes', branch: 'main', token: 'token-fixture' }))
      .rejects.toThrow('GITHUB_TREE_TRUNCATED');
    await expect(api.readBlob({ repo: 'fixture/notes', sha: 'sha-1', token: 'token-fixture' }))
      .rejects.toThrow('GITHUB_API_STATUS_403');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a GitHub source with an admitted API port collects the approved branch over the API', async () => {
  const fx = temporaryDatabase();
  const requested: string[] = [];
  const api = {
    async listTree(input: { repo: string; branch: string; token: string }) {
      requested.push(`tree ${input.repo} ${input.branch} ${input.token}`);
      return [
        { path: 'docs', type: 'tree' as const, sha: 'sha-dir', size: 0 },
        { path: 'docs/note.txt', type: 'blob' as const, sha: 'sha-1', size: 12 },
        { path: 'other/secret.txt', type: 'blob' as const, sha: 'sha-2', size: 6 },
      ];
    },
    async readBlob(input: { repo: string; sha: string; token: string }) {
      requested.push(`blob ${input.repo} ${input.sha} ${input.token}`);
      return new TextEncoder().encode(input.sha === 'sha-1' ? 'live note\n' : 'secret\n');
    },
  };
  try {
    const registry = createSourceRegistry(fx.db, {
      blobs: fx.blobs,
      now: () => NOW,
      githubApi: api,
      credentials: { resolve: (reference) => reference === 'cred_github' ? new TextEncoder().encode('token-live') : null },
    });
    const draft = { ...githubDraft(), credentialRef: 'cred_github' };
    const preview = await registry.detectSource(PRINCIPAL, draft);
    expect(preview.samples).toEqual([{ locator: 'docs/note.txt', byteLength: 12 }]);
    const enabled = await registry.enableSource(PRINCIPAL, draft);
    const receipt = await registry.collectSource(enabled.sourceId, 1);
    expect(receipt.accepted).toBe(true);
    expect(requested).toContain('tree fixture/notes main token-live');
    expect(requested).toContain('blob fixture/notes sha-1 token-live');
    const revisions = contentRevisions(fx.db, enabled.sourceId);
    expect(revisions).toHaveLength(1);
    const objects = fx.db.prepare('SELECT locator FROM source_objects WHERE source_id = ?').all(enabled.sourceId) as
      Array<{ locator: string }>;
    expect(objects.map((row) => row.locator)).toEqual(['docs/note.txt']);
  } finally { fx.close(); }
});

test('a GitHub source is added through the trusted change with a staged token', async () => {
  const fx = temporaryDatabase();
  const api = {
    async listTree() {
      return [{ path: 'docs/note.txt', type: 'blob' as const, sha: 'sha-1', size: 12 }];
    },
    async readBlob() {
      return new TextEncoder().encode('live note\n');
    },
  };
  try {
    const registry = createSourceRegistry(fx.db, {
      blobs: fx.blobs,
      now: () => NOW,
      githubApi: api,
      credentials: { resolve: (reference) => reference === 'cred_github' ? new TextEncoder().encode('token-live') : null },
    });
    const handlers = sourceSettingsHandlers({ db: fx.db, credentials: createCredentialStore(join(fx.dir, 'creds'), () => new Date(NOW)),
      now: () => new Date(NOW), registry });
    const handler = handlers.enable_github_source;
    const owner = { account_id: 'owner', caller_id: 'web', auth_epoch: 1, domains: ['personal'],
      operations: ['owner'], authenticated_at: NOW };
    const draft = { operation: 'enable_github_source', domain: 'personal', target: 'github://fixture/notes@main/docs',
      input: { credential_ref: 'cred_github', repo: 'fixture/notes', branch: 'main', path: 'docs' } };
    expect(handler.binding(owner, draft))
      .toMatchObject({ revision: 0, identityId: 'github://fixture/notes@main/docs' });
    await expect(handler.validate(owner, draft)).resolves.toEqual({ valid: true });
    const applied = await handler.apply(owner, draft, { base_revision: 0, draft_hash: 'a'.repeat(64), validation_id: 'v', valid: true, device_id: 'desktop',
        identity_id: 'github://fixture/notes@main/docs', scope_hash: 'b'.repeat(64), checked_at: NOW, expires_at: NOW }, () => NOW);
    expect(applied.effects).toEqual([{ item: 'source_enable', outcome: 'applied', revision: 1 }]);
    const row = fx.db.prepare('SELECT connector_type,normalized_target,credential_ref,status FROM source_configs').get();
    expect(row).toMatchObject({ connector_type: 'github', normalized_target: 'github://fixture/notes@main/docs',
      credential_ref: 'cred_github', status: 'enabled' });
  } finally { fx.close(); }
});
