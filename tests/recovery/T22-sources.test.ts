import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { createRecoveryRuntimeGate, createBlobStore, openDatabase } from '@patrick/storage';
import { createHttpCollectionWorker } from '../../apps/service/src/source-collection.js';
import { createSourceRegistry, type RegistryOptions } from '../../packages/integrations/sources/registry.js';

// Test-only bypass for legacy state-machine assertions; this is not an admitted production reader.
vi.mock('../../packages/integrations/sources/directory-capability.js', async (load) => {
  const actual = await load<typeof import('../../packages/integrations/sources/directory-capability.js')>();
  return { ...actual, assertDirectoryReaderAvailable: () => {} };
});

const principal = { accountId: 'owner', dataDomain: 'personal' };
const at = '2026-11-17T06:00:00.000Z';

function fixture(options: Partial<RegistryOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t22-sources-'));
  const db = openDatabase(join(root, 'local.sqlite'));
  const notes = join(root, 'notes');
  mkdirSync(notes);
  writeFileSync(join(notes, 'note.md'), 'A');
  const blobs = createBlobStore(join(root, 'blobs'));
  const putBlob = vi.spyOn(blobs, 'putBlob');
  const registry = createSourceRegistry(db, { ...options, blobs, now: options.now ?? (() => at) });
  const draft = { type: 'directory' as const, target: notes, excludes: [], hasTriggerRule: true,
    frequency: 'poll', history: 'none' as const };
  const counts = () => ({
    revisions: db.prepare('SELECT COUNT(*) AS n FROM source_revisions').get(),
    events: db.prepare('SELECT COUNT(*) AS n FROM domain_events').get(),
    receipts: db.prepare('SELECT COUNT(*) AS n FROM collection_receipts').get(),
    cursors: db.prepare('SELECT * FROM source_cursors').all(),
  });
  return { db, root, notes, blobs, putBlob, registry, draft, counts,
    close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('closed recovery refuses direct source enable before creating configuration or cursor authority', async () => {
  const f = fixture();
  try {
    createRecoveryRuntimeGate(f.db);
    await expect(f.registry.enableSource(principal, f.draft)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM source_configs').get()).toEqual({ n: 0 });
    expect(f.counts().cursors).toEqual([]);
  } finally { f.close(); }
});

test.each(['collect', 'wake'] as const)('closed recovery refuses a direct directory %s before blob or business writes', async (kind) => {
  const f = fixture();
  try {
    const enabled = await f.registry.enableSource(principal, f.draft);
    const before = f.counts();
    createRecoveryRuntimeGate(f.db);
    const run = () => kind === 'collect' ? f.registry.collectSource(enabled.sourceId, enabled.configRevision)
      : f.registry.wakeDirectory(enabled.sourceId, 'note.md');
    await expect(run()).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(f.putBlob).not.toHaveBeenCalled();
    expect(f.counts()).toEqual(before);
  } finally { f.close(); }
});

test('recovery closure during the last cursor callback cannot commit staged source revisions', async () => {
  let closeGate = () => {};
  const f = fixture({ beforeCursorCommit: () => closeGate() });
  try {
    const enabled = await f.registry.enableSource(principal, f.draft);
    const before = f.counts();
    closeGate = () => { createRecoveryRuntimeGate(f.db); };
    await expect(f.registry.collectSource(enabled.sourceId, enabled.configRevision)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(f.putBlob).toHaveBeenCalled();
    expect(f.counts()).toEqual(before);
  } finally { f.close(); }
});

test('recovery closure after one blob prevents staging another file and committing the batch', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.notes, 'other.md'), 'B');
    const enabled = await f.registry.enableSource(principal, f.draft);
    const before = f.counts();
    f.putBlob.mockImplementationOnce(async (bytes) => {
      createRecoveryRuntimeGate(f.db);
      return createHash('sha256').update(bytes).digest('hex');
    });
    await expect(f.registry.collectSource(enabled.sourceId, enabled.configRevision)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(f.putBlob).toHaveBeenCalledTimes(1);
    expect(f.counts()).toEqual(before);
  } finally { f.close(); }
});

test('closed recovery preserves owner pause without granting new collection authority', async () => {
  const f = fixture();
  try {
    const enabled = await f.registry.enableSource(principal, f.draft);
    createRecoveryRuntimeGate(f.db);
    await expect(f.registry.pauseSource(enabled.sourceId)).resolves.toMatchObject({ kind: 'pause', accepted: true });
    expect(f.db.prepare('SELECT status FROM source_configs WHERE source_id=?').get(enabled.sourceId)).toEqual({ status: 'paused' });
    expect(f.putBlob).not.toHaveBeenCalled();
  } finally { f.close(); }
});

const feedUrl = 'https://feed.example.test/news';
const feedDraft = { type: 'rss' as const, target: feedUrl };
const feedResponse = { status: 200, location: null, contentType: 'application/rss+xml',
  bytes: Buffer.from('<rss><channel><item><guid>old</guid><title>Old</title><pubDate>Mon, 16 Nov 2026 00:00:00 GMT</pubDate></item></channel></rss>') };
const historyActor = { ...principal, callerId: 'editor', authEpoch: 1 };
const historyLimits = { from: '2026-11-15T00:00:00Z', until: '2026-11-17T00:00:00Z', maxObjects: 10, maxBytes: 8192 };

function httpFixture() {
  const request = vi.fn(async () => feedResponse);
  const resolve = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
  const f = fixture({ http: { approvedUrls: (_owner, target) => [target], port: { request, resolve } } });
  return { ...f, request, resolve };
}

function callbackFixture() {
  let duringClock = () => {};
  let duringScope = () => {};
  let beforeCommit = () => {};
  const request = vi.fn(async () => feedResponse);
  const resolve = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
  const f = fixture({ now: () => { duringClock(); return at; }, beforeCursorCommit: () => beforeCommit(),
    http: { approvedUrls: (_owner, target) => { duringScope(); return [target]; }, port: { request, resolve } } });
  return { ...f, request, resolve,
    onClock(callback: () => void) { duringClock = callback; },
    onScope(callback: () => void) { duringScope = callback; },
    onCommit(callback: () => void) { beforeCommit = callback; } };
}

function admit(f: ReturnType<typeof fixture>, domain = principal.dataDomain) {
  f.db.prepare(`INSERT INTO recovery_domain_gates(data_domain,writer_epoch,status,activation_id,witness_revision,updated_at)
    VALUES (?,'epoch-1','open','activation-1','witness-1',?)`).run(domain, at);
  const gate = createRecoveryRuntimeGate(f.db);
  gate.admit({ domain, writerEpoch: 'epoch-1', activationId: 'activation-1', witnessRevision: 'witness-1' });
  return gate;
}

async function prepareHistory(f: ReturnType<typeof httpFixture>, id = 'history-1') {
  const enabled = await f.registry.enableSource(principal, feedDraft);
  await f.registry.collectSource(enabled.sourceId, enabled.configRevision);
  const prepared = await f.registry.prepareRssHistory(historyActor, enabled.sourceId, enabled.configRevision, historyLimits);
  const plan = f.db.transaction(() => {
    f.db.prepare('INSERT INTO command_inbox VALUES (?,?,?,?,?)').run(principal.accountId, historyActor.callerId, id, id, 'a'.repeat(64));
    return f.registry.freezeRssHistory(historyActor, id, prepared);
  }).immediate();
  f.putBlob.mockClear();
  return { enabled, prepared, plan };
}

test('an admitted directory writes successfully, then live epoch drift closes the same handle', async () => {
  const f = fixture();
  try {
    admit(f);
    const enabled = await f.registry.enableSource(principal, f.draft);
    await expect(f.registry.collectSource(enabled.sourceId, enabled.configRevision)).resolves.toMatchObject({ accepted: true, count: 1 });
    const before = f.counts();
    f.putBlob.mockClear();
    f.db.prepare("UPDATE recovery_domain_gates SET writer_epoch='epoch-2'").run();
    writeFileSync(join(f.notes, 'note.md'), 'B');
    await expect(f.registry.collectSource(enabled.sourceId, enabled.configRevision)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(f.putBlob).not.toHaveBeenCalled();
    expect(f.counts()).toEqual(before);
  } finally { f.close(); }
});

test('a peer handle cannot collect from a persisted SQL-open recovery gate without runtime admission', async () => {
  const f = fixture();
  let peer: ReturnType<typeof openDatabase> | undefined;
  try {
    const enabled = await f.registry.enableSource(principal, f.draft);
    admit(f);
    peer = openDatabase(join(f.root, 'local.sqlite'));
    const registry = createSourceRegistry(peer, { blobs: f.blobs, now: () => at });
    await expect(registry.collectSource(enabled.sourceId, enabled.configRevision)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(f.putBlob).not.toHaveBeenCalled();
  } finally { peer?.close(); f.close(); }
});

test('source collection checks the stored source domain when another domain is admitted', async () => {
  const f = fixture();
  try {
    const enabled = await f.registry.enableSource({ ...principal, dataDomain: 'enterprise' }, f.draft);
    admit(f);
    await expect(f.registry.collectSource(enabled.sourceId, enabled.configRevision)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(f.putBlob).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('HTTP recovery closure after DNS preparation prevents request and failure receipt writes', async () => {
  const f = httpFixture();
  try {
    const enabled = await f.registry.enableSource(principal, feedDraft);
    const before = f.counts();
    f.resolve.mockImplementationOnce(async () => {
      createRecoveryRuntimeGate(f.db);
      return [{ address: '8.8.8.8', family: 4 }];
    });
    await expect(f.registry.collectSource(enabled.sourceId, enabled.configRevision)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(f.request).not.toHaveBeenCalled();
    expect(f.putBlob).not.toHaveBeenCalled();
    expect(f.counts()).toEqual(before);
  } finally { f.close(); }
});

test('HTTP recovery closure during response preparation prevents response staging and baseline writes', async () => {
  const f = httpFixture();
  try {
    const enabled = await f.registry.enableSource(principal, feedDraft);
    const before = f.counts();
    f.request.mockImplementationOnce(async () => { createRecoveryRuntimeGate(f.db); return feedResponse; });
    await expect(f.registry.collectSource(enabled.sourceId, enabled.configRevision)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(f.putBlob).not.toHaveBeenCalled();
    expect(f.counts()).toEqual(before);
    expect(f.db.prepare('SELECT * FROM http_source_baselines').all()).toEqual([]);
  } finally { f.close(); }
});

test('HTTP response evidence cannot stage after recovery closes at the item blob handoff', async () => {
  const f = httpFixture();
  try {
    const enabled = await f.registry.enableSource(principal, feedDraft);
    await f.registry.collectSource(enabled.sourceId, enabled.configRevision);
    const before = f.counts();
    f.putBlob.mockClear();
    f.request.mockResolvedValueOnce({ ...feedResponse, bytes: Buffer.from('<rss><channel><item><guid>new</guid><title>New</title></item></channel></rss>') });
    f.putBlob.mockImplementationOnce(async (bytes) => { createRecoveryRuntimeGate(f.db); return createHash('sha256').update(bytes).digest('hex'); });
    await expect(f.registry.collectSource(enabled.sourceId, enabled.configRevision)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(f.putBlob).toHaveBeenCalledTimes(1);
    expect(f.counts()).toEqual(before);
  } finally { f.close(); }
});

test.each(['pause', 'disconnect'] as const)('HTTP %s remains usable while recovery is closed', async (operation) => {
  const f = httpFixture();
  try {
    const enabled = await f.registry.enableSource(principal, feedDraft);
    createRecoveryRuntimeGate(f.db);
    expect(f.registry.changeHttpSource(principal, enabled.sourceId, operation, 1, undefined, () => at)).toMatchObject({ changed: true });
    expect(() => f.registry.changeHttpSource(principal, enabled.sourceId, 'resume', 2, undefined, () => at)).toThrow();
  } finally { f.close(); }
});

test.each(['modify', 'resume'] as const)('HTTP %s rechecks recovery after its final authority callback', async (operation) => {
  const f = httpFixture();
  try {
    const enabled = await f.registry.enableSource(principal, feedDraft);
    const before = f.db.prepare('SELECT * FROM source_configs').all();
    expect(() => f.registry.changeHttpSource(principal, enabled.sourceId, operation, 1,
      operation === 'modify' ? '1h' : undefined, () => { createRecoveryRuntimeGate(f.db); return at; })).toThrow('RECOVERY_WRITE_BLOCKED');
    expect(f.db.prepare('SELECT * FROM source_configs').all()).toEqual(before);
  } finally { f.close(); }
});

test('history plan freeze cannot grant new import authority while recovery is closed', async () => {
  const f = httpFixture();
  try {
    const { enabled } = await prepareHistory(f);
    const prepared = await f.registry.prepareRssHistory(historyActor, enabled.sourceId, 1, historyLimits);
    createRecoveryRuntimeGate(f.db);
    expect(() => f.db.transaction(() => {
      f.db.prepare('INSERT INTO command_inbox VALUES (?,?,?,?,?)').run(principal.accountId, historyActor.callerId, 'closed-history', 'closed-history', 'b'.repeat(64));
      return f.registry.freezeRssHistory(historyActor, 'closed-history', prepared);
    }).immediate())
      .toThrow('RECOVERY_WRITE_BLOCKED');
    expect(f.db.prepare('SELECT 1 FROM http_source_history_plans WHERE plan_id=?').get('closed-history')).toBeUndefined();
  } finally { f.close(); }
});

test('history import denies closed recovery before staging and also rechecks its final callback', async () => {
  for (const closeAt of ['entry', 'commit'] as const) {
    const f = httpFixture();
    try {
      const { plan } = await prepareHistory(f);
      const before = f.counts();
      if (closeAt === 'entry') createRecoveryRuntimeGate(f.db);
      await expect(f.registry.importRssHistory(historyActor, plan.plan_id, plan.plan_hash, 1, () => {
        if (closeAt === 'commit') createRecoveryRuntimeGate(f.db);
        return at;
      })).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
      expect(f.counts()).toEqual(before);
      expect(f.db.prepare('SELECT * FROM http_source_history_receipts').all()).toEqual([]);
      if (closeAt === 'entry') expect(f.putBlob).not.toHaveBeenCalled();
    } finally { f.close(); }
  }
});

test('completed history import retains exact receipt replay while recovery is closed', async () => {
  const f = httpFixture();
  try {
    const { plan } = await prepareHistory(f);
    const applied = await f.registry.importRssHistory(historyActor, plan.plan_id, plan.plan_hash, 1, () => at);
    const before = f.counts();
    f.putBlob.mockClear();
    createRecoveryRuntimeGate(f.db);
    await expect(f.registry.importRssHistory(historyActor, plan.plan_id, plan.plan_hash, 1, () => at))
      .resolves.toEqual({ ...applied, created: false });
    expect(f.counts()).toEqual(before);
    expect(f.putBlob).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('closed recovery prevents webhook staging and ignored-delivery acknowledgements', async () => {
  for (const origin of ['source', 'review'] as const) {
    const f = fixture();
    try {
      const tree = join(f.root, 'github');
      const docs = join(tree, 'fixture', 'notes', 'main', 'docs');
      mkdirSync(docs, { recursive: true });
      writeFileSync(join(docs, 'note.md'), 'synthetic webhook content');
      const registry = createSourceRegistry(f.db, { blobs: f.blobs, now: () => at, githubFixtureRoot: tree });
      const enabled = await registry.enableSource(principal, { type: 'github', target: 'github://fixture/notes',
        repo: 'fixture/notes', branch: 'main', path: 'docs' });
      const rawBody = Buffer.from(JSON.stringify({ repository: { full_name: 'fixture/notes' }, ref: 'refs/heads/main',
        ...(origin === 'review' ? { review: { state: 'commented' } } : {}), commits: [{ added: ['docs/note.md'], modified: [], removed: [] }] }));
      const secret = 'synthetic-test-signature';
      const signature = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
      const before = f.counts();
      createRecoveryRuntimeGate(f.db);
      await expect(registry.ingestGithubWebhook({ sourceId: enabled.sourceId, configRevision: 1, rawBody,
        secret, signature, deliveryId: 'closed-' + origin })).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
      expect(f.putBlob).not.toHaveBeenCalled();
      expect(f.db.prepare('SELECT * FROM webhook_deliveries').all()).toEqual([]);
      expect(f.counts()).toEqual(before);
    } finally { f.close(); }
  }
});

test('a closed HTTP worker cannot acquire leases or call the registry', async () => {
  const f = httpFixture();
  try {
    await f.registry.enableSource(principal, feedDraft);
    const collect = vi.spyOn(f.registry, 'collectSource');
    createRecoveryRuntimeGate(f.db);
    const worker = createHttpCollectionWorker(f.db, f.registry, () => new Date(at), { signal: new AbortController().signal });
    expect(await worker.tick()).toBe(false);
    expect(collect).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT * FROM http_source_schedule').all()).toEqual([]);
  } finally { f.close(); }
});

test('a blocked first domain cannot starve an admitted HTTP source', async () => {
  const f = httpFixture();
  try {
    const blocked = await f.registry.enableSource(principal, feedDraft);
    const admitted = await f.registry.enableSource({ ...principal, dataDomain: 'enterprise' }, { ...feedDraft, target: 'https://other.example.test/news' });
    f.db.prepare('UPDATE source_configs SET updated_at=? WHERE source_id=?').run('2026-11-16T00:00:00.000Z', blocked.sourceId);
    admit(f, 'enterprise');
    const collect = vi.spyOn(f.registry, 'collectSource');
    const worker = createHttpCollectionWorker(f.db, f.registry, () => new Date(at), { signal: new AbortController().signal });
    expect(await worker.tick()).toBe(true);
    expect(collect).toHaveBeenCalledWith(admitted.sourceId, 1, expect.any(Object));
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.db.prepare('SELECT source_id FROM http_source_schedule').all()).toEqual([{ source_id: admitted.sourceId }]);
    expect(f.db.prepare("SELECT source_id FROM collection_receipts WHERE kind='first_collection'").all()).toEqual([{ source_id: admitted.sourceId }]);
  } finally { f.close(); }
});

test('HTTP lease liveness closes immediately when its persisted source domain loses admission', async () => {
  const f = httpFixture();
  try {
    const enabled = await f.registry.enableSource(principal, feedDraft);
    const runtime = admit(f);
    const collect = vi.spyOn(f.registry, 'collectSource').mockImplementationOnce(async (_id, _revision, guard) => {
      expect(guard!.isLive()).toBe(true);
      runtime.revoke(principal.dataDomain);
      expect(guard!.isLive()).toBe(false);
      throw new Error('RECOVERY_WRITE_BLOCKED');
    });
    const worker = createHttpCollectionWorker(f.db, f.registry, () => new Date(at), { signal: new AbortController().signal });
    await expect(worker.tick()).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(collect).toHaveBeenCalledTimes(1);
    expect(f.db.prepare('SELECT lease_token,lease_until FROM http_source_schedule WHERE source_id=?').get(enabled.sourceId))
      .toEqual({ lease_token: null, lease_until: null });
  } finally { f.close(); }
});

const sourceDrifts = ['blocked-domain', 'admitted-domain', 'account', 'revision', 'status', 'scope'] as const;
type SourceDrift = typeof sourceDrifts[number];

function driftSource(f: ReturnType<typeof fixture>, sourceId: string, drift: SourceDrift) {
  if (drift === 'blocked-domain' || drift === 'admitted-domain') {
    f.db.prepare("UPDATE source_configs SET data_domain='enterprise' WHERE source_id=?").run(sourceId);
  } else if (drift === 'account') {
    f.db.prepare("UPDATE source_configs SET account_id='other' WHERE source_id=?").run(sourceId);
  } else if (drift === 'revision') {
    f.db.prepare('UPDATE source_configs SET config_revision=config_revision+1 WHERE source_id=?').run(sourceId);
  } else if (drift === 'status') {
    f.db.prepare("UPDATE source_configs SET status=CASE status WHEN 'enabled' THEN 'paused' ELSE 'enabled' END,enabled=1-enabled WHERE source_id=?").run(sourceId);
  } else {
    f.db.prepare("UPDATE source_configs SET scope_json=json_set(scope_json,'$.httpTargets',json(?)) WHERE source_id=?")
      .run(JSON.stringify([feedUrl, 'https://other.example.test/news']), sourceId);
  }
}

function sourceConfiguration(f: ReturnType<typeof fixture>) {
  return {
    configs: f.db.prepare('SELECT * FROM source_configs').all(),
    versions: f.db.prepare('SELECT * FROM source_versions').all(),
    cursors: f.db.prepare('SELECT * FROM source_cursors').all(),
    receipts: f.db.prepare('SELECT * FROM http_source_config_receipts').all(),
  };
}

test.each(sourceDrifts.flatMap((drift) => (['modify', 'resume'] as const).map((operation) => ({ drift, operation }))))(
  'HTTP $operation rejects $drift introduced by its final callback',
  async ({ drift, operation }) => {
    const f = httpFixture();
    try {
      const enabled = await f.registry.enableSource(principal, feedDraft);
      if (operation === 'resume') f.registry.changeHttpSource(principal, enabled.sourceId, 'pause', 1, undefined, () => at);
      const revision = operation === 'resume' ? 2 : 1;
      admit(f);
      if (drift === 'admitted-domain') admit(f, 'enterprise');
      const before = sourceConfiguration(f);
      const callback = vi.fn(() => { driftSource(f, enabled.sourceId, drift); return at; });
      expect(() => f.registry.changeHttpSource(principal, enabled.sourceId, operation, revision,
        operation === 'modify' ? '1h' : undefined, callback)).toThrow();
      expect(callback).toHaveBeenCalledTimes(1);
      expect(sourceConfiguration(f)).toEqual(before);
    } finally { f.close(); }
  },
);

test.each(sourceDrifts)('history import rejects %s introduced by its final callback', async (drift) => {
  const f = httpFixture();
  try {
    const { enabled, plan } = await prepareHistory(f);
    admit(f);
    if (drift === 'admitted-domain') admit(f, 'enterprise');
    const before = f.counts();
    const configuration = sourceConfiguration(f);
    const callback = vi.fn(() => { driftSource(f, enabled.sourceId, drift); return at; });
    await expect(f.registry.importRssHistory(historyActor, plan.plan_id, plan.plan_hash, 1, callback)).rejects.toThrow();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(f.counts()).toEqual(before);
    expect(sourceConfiguration(f)).toEqual(configuration);
    expect(f.db.prepare('SELECT * FROM http_source_history_receipts').all()).toEqual([]);
  } finally { f.close(); }
});

test.each(['admitted-domain', 'account', 'scope'] as const)(
  'late collection commit rejects %s while retaining its final callback state',
  async (drift) => {
    let mutate = () => {};
    const request = vi.fn(async () => feedResponse);
    const f = fixture({ beforeCursorCommit: () => mutate(),
      http: { approvedUrls: (_owner, target) => [target, 'https://other.example.test/news'],
        port: { request, resolve: async () => [{ address: '8.8.8.8', family: 4 }] } } });
    try {
      const enabled = await f.registry.enableSource(principal, feedDraft);
      admit(f);
      admit(f, 'enterprise');
      const before = f.counts();
      mutate = () => {
        if (drift === 'scope') {
          f.db.prepare("UPDATE source_configs SET scope_json=json_set(scope_json,'$.httpTargets',json(?)) WHERE source_id=?")
            .run(JSON.stringify([feedUrl]), enabled.sourceId);
        } else driftSource(f, enabled.sourceId, drift);
      };
      await expect(f.registry.collectSource(enabled.sourceId, 1)).resolves.toMatchObject({
        accepted: false, reason: 'SOURCE_IDENTITY_CHANGED',
      });
      expect(f.counts()).toEqual(before);
      expect(f.db.prepare('SELECT * FROM http_source_baselines').all()).toEqual([]);
      expect(f.db.prepare('SELECT * FROM http_source_response_evidence').all()).toEqual([]);
      expect(f.db.prepare('SELECT account_id,data_domain,scope_json FROM source_configs WHERE source_id=?').get(enabled.sourceId))
        .toMatchObject(drift === 'account' ? { account_id: 'other' } :
          drift === 'admitted-domain' ? { data_domain: 'enterprise' } : { scope_json: expect.stringContaining(feedUrl) });
    } finally { f.close(); }
  },
);

test.each(sourceDrifts)('HTTP collection lease closes on %s drift from its claim', async (drift) => {
  const f = httpFixture();
  try {
    const enabled = await f.registry.enableSource(principal, feedDraft);
    admit(f);
    if (drift === 'admitted-domain') admit(f, 'enterprise');
    const collect = vi.spyOn(f.registry, 'collectSource').mockImplementationOnce(async (_id, _revision, guard) => {
      expect(guard!.isLive()).toBe(true);
      driftSource(f, enabled.sourceId, drift);
      expect(guard!.isLive()).toBe(false);
      return { accepted: false } as never;
    });
    const worker = createHttpCollectionWorker(f.db, f.registry, () => new Date(at), { signal: new AbortController().signal });
    expect(await worker.tick()).toBe(true);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(f.db.prepare('SELECT lease_token,lease_until FROM http_source_schedule WHERE source_id=?').get(enabled.sourceId))
      .toEqual({ lease_token: null, lease_until: null });
  } finally { f.close(); }
});

test('existing source enable rereads its persisted owner after the callback', async () => {
  const f = httpFixture();
  try {
    const enabled = await f.registry.enableSource(principal, feedDraft);
    const inspected = f.registry.inspectHttpDraft(principal, feedDraft);
    const before = sourceConfiguration(f);
    await expect(f.registry.enableSource(principal, feedDraft, { draftHash: inspected.draftHash, beforeWrite() {
      driftSource(f, enabled.sourceId, 'account');
      return at;
    } })).rejects.toThrow('SOURCE_ROOT_TAKEN');
    expect(sourceConfiguration(f)).toEqual(before);
  } finally { f.close(); }
});

test('completed history callback replay keeps its receipt without creating new authority', async () => {
  const f = httpFixture();
  try {
    const { plan } = await prepareHistory(f);
    const applied = await f.registry.importRssHistory(historyActor, plan.plan_id, plan.plan_hash, 1, () => at);
    const before = f.counts();
    f.putBlob.mockClear();
    createRecoveryRuntimeGate(f.db);
    const callback = vi.fn(() => at);
    await expect(f.registry.importRssHistory(historyActor, plan.plan_id, plan.plan_hash, 1, callback))
      .resolves.toEqual({ ...applied, created: false });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(f.counts()).toEqual(before);
    expect(f.putBlob).not.toHaveBeenCalled();
  } finally { f.close(); }
});

const finalInvalidations = ['revoke', 'blocked-domain', 'admitted-domain'] as const;
type FinalInvalidation = typeof finalInvalidations[number];

function invalidateSource(f: ReturnType<typeof fixture>, sourceId: string, kind: FinalInvalidation) {
  if (kind === 'revoke') createRecoveryRuntimeGate(f.db).revoke(principal.dataDomain);
  else driftSource(f, sourceId, kind);
}

test.each((['guard', 'scope', 'clock'] as const).flatMap((hook) => finalInvalidations.map((kind) => ({ hook, kind }))))(
  'final collection $hook callback cannot admit new writes after $kind',
  async ({ hook, kind }) => {
    const f = callbackFixture();
    try {
      const enabled = await f.registry.enableSource(principal, feedDraft);
      admit(f);
      if (kind === 'admitted-domain') admit(f, 'enterprise');
      const before = f.counts();
      let committing = false;
      f.onCommit(() => { committing = true; });
      const invalidate = vi.fn(() => { if (committing) invalidateSource(f, enabled.sourceId, kind); });
      if (hook === 'scope') f.onScope(invalidate);
      if (hook === 'clock') f.onClock(invalidate);
      const collected = f.registry.collectSource(enabled.sourceId, 1, { signal: new AbortController().signal,
        isLive() { if (hook === 'guard') invalidate(); return true; } });
      if (kind === 'admitted-domain') {
        await expect(collected).resolves.toMatchObject({ accepted: false, reason: 'SOURCE_IDENTITY_CHANGED' });
      } else await expect(collected).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
      expect(invalidate).toHaveBeenCalled();
      expect(f.counts()).toEqual(before);
      expect(f.db.prepare('SELECT * FROM http_source_baselines').all()).toEqual([]);
      expect(f.db.prepare('SELECT * FROM http_source_response_evidence').all()).toEqual([]);
    } finally { f.close(); }
  },
);

test.each((['modify', 'resume', 'history'] as const).flatMap((operation) =>
  finalInvalidations.map((kind) => ({ operation, kind }))))(
  'final $operation policy callback cannot admit new writes after $kind',
  async ({ operation, kind }) => {
    const f = callbackFixture();
    try {
      const prepared = operation === 'history' ? await prepareHistory(f) : null;
      const enabled = prepared?.enabled ?? await f.registry.enableSource(principal, feedDraft);
      if (operation === 'resume') f.registry.changeHttpSource(principal, enabled.sourceId, 'pause', 1, undefined, () => at);
      const revision = operation === 'resume' ? 2 : 1;
      admit(f);
      if (kind === 'admitted-domain') admit(f, 'enterprise');
      const before = f.counts();
      const configuration = sourceConfiguration(f);
      let final = false;
      const invalidate = vi.fn(() => { if (final) invalidateSource(f, enabled.sourceId, kind); });
      f.onScope(invalidate);
      const beforeWrite = () => { final = true; return at; };
      if (operation === 'history') {
        await expect(f.registry.importRssHistory(historyActor, prepared!.plan.plan_id, prepared!.plan.plan_hash, 1, beforeWrite))
          .rejects.toThrow();
      } else {
        expect(() => f.registry.changeHttpSource(principal, enabled.sourceId, operation, revision,
          operation === 'modify' ? '1h' : undefined, beforeWrite)).toThrow();
      }
      expect(invalidate).toHaveBeenCalled();
      expect(f.counts()).toEqual(before);
      expect(sourceConfiguration(f)).toEqual(configuration);
      expect(f.db.prepare('SELECT * FROM http_source_history_receipts').all()).toEqual([]);
    } finally { f.close(); }
  },
);

test('final history clock cannot replace the persisted actor binding after it was loaded', async () => {
  const f = callbackFixture();
  try {
    const { plan } = await prepareHistory(f);
    admit(f);
    const before = f.counts();
    let final = false;
    const invalidate = vi.fn(() => {
      if (final) f.db.prepare('UPDATE http_source_history_plans SET auth_epoch=2 WHERE plan_id=?').run(plan.plan_id);
    });
    f.onClock(invalidate);
    await expect(f.registry.importRssHistory(historyActor, plan.plan_id, plan.plan_hash, 1, () => {
      final = true;
      return at;
    })).rejects.toThrow();
    expect(invalidate).toHaveBeenCalled();
    expect(f.counts()).toEqual(before);
    expect(f.db.prepare('SELECT * FROM http_source_history_receipts').all()).toEqual([]);
    expect(f.db.prepare('SELECT auth_epoch FROM http_source_history_plans WHERE plan_id=?').get(plan.plan_id)).toEqual({ auth_epoch: 1 });
  } finally { f.close(); }
});

test.each(['admitted-domain', 'status', 'scope'] as const)(
  'history freeze rejects %s introduced by its timestamp callback',
  async (drift) => {
    const f = callbackFixture();
    try {
      const enabled = await f.registry.enableSource(principal, feedDraft);
      await f.registry.collectSource(enabled.sourceId, 1);
      const prepared = await f.registry.prepareRssHistory(historyActor, enabled.sourceId, 1, historyLimits);
      admit(f);
      admit(f, 'enterprise');
      const configuration = sourceConfiguration(f);
      f.onClock(() => driftSource(f, enabled.sourceId, drift));
      expect(() => f.db.transaction(() => {
        f.db.prepare('INSERT INTO command_inbox VALUES (?,?,?,?,?)')
          .run(principal.accountId, historyActor.callerId, 'clock-plan', 'clock-plan', 'c'.repeat(64));
        return f.registry.freezeRssHistory(historyActor, 'clock-plan', prepared);
      }).immediate()).toThrow();
      expect(sourceConfiguration(f)).toEqual(configuration);
      expect(f.db.prepare('SELECT * FROM http_source_history_plans').all()).toEqual([]);
    } finally { f.close(); }
  },
);

test.each((['guard', 'clock'] as const).flatMap((hook) =>
  (['revoke', 'admitted-domain'] as const).map((kind) => ({ hook, kind }))))(
  'HTTP failure receipt $hook callback cannot write after $kind',
  async ({ hook, kind }) => {
    const f = callbackFixture();
    try {
      const enabled = await f.registry.enableSource(principal, feedDraft);
      admit(f);
      if (kind === 'admitted-domain') admit(f, 'enterprise');
      const before = f.counts();
      let failed = false;
      f.request.mockImplementationOnce(async () => { failed = true; throw new Error('SOURCE_HTTP_UNAVAILABLE'); });
      const invalidate = vi.fn(() => { if (failed) invalidateSource(f, enabled.sourceId, kind); });
      if (hook === 'clock') f.onClock(invalidate);
      const collected = f.registry.collectSource(enabled.sourceId, 1, { signal: new AbortController().signal,
        isLive() { if (hook === 'guard') invalidate(); return true; } });
      if (kind === 'revoke') await expect(collected).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
      else await expect(collected).resolves.toMatchObject({ accepted: false, reason: 'SOURCE_IDENTITY_CHANGED' });
      expect(invalidate).toHaveBeenCalled();
      expect(f.counts()).toEqual(before);
      expect(f.putBlob).not.toHaveBeenCalled();
    } finally { f.close(); }
  },
);

test.each(['revoke', 'admitted-domain'] as const)('ignored webhook timestamp cannot write delivery authority after %s', async (kind) => {
  const f = fixture();
  try {
    const tree = join(f.root, 'github');
    const docs = join(tree, 'fixture', 'notes', 'main', 'docs');
    mkdirSync(docs, { recursive: true });
    let duringClock = () => {};
    const registry = createSourceRegistry(f.db, { blobs: f.blobs, now: () => { duringClock(); return at; }, githubFixtureRoot: tree });
    const enabled = await registry.enableSource(principal, { type: 'github', target: 'github://fixture/notes',
      repo: 'fixture/notes', branch: 'main', path: 'docs' });
    admit(f);
    if (kind === 'admitted-domain') admit(f, 'enterprise');
    const rawBody = Buffer.from(JSON.stringify({ repository: { full_name: 'fixture/notes' }, ref: 'refs/heads/main',
      review: { state: 'commented' }, commits: [] }));
    const secret = 'synthetic-test-signature';
    const signature = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
    duringClock = () => invalidateSource(f, enabled.sourceId, kind);
    const ingesting = registry.ingestGithubWebhook({ sourceId: enabled.sourceId, configRevision: 1, rawBody,
      secret, signature, deliveryId: 'clock-review' });
    if (kind === 'revoke') await expect(ingesting).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    else await expect(ingesting).resolves.toMatchObject({ accepted: false, reason: 'SOURCE_IDENTITY_CHANGED' });
    expect(f.db.prepare('SELECT * FROM webhook_deliveries').all()).toEqual([]);
    expect(f.putBlob).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('collection final guard can pause its source without the outer commit undoing the reduction', async () => {
  const f = callbackFixture();
  try {
    const enabled = await f.registry.enableSource(principal, feedDraft);
    admit(f);
    let committing = false;
    f.onCommit(() => { committing = true; });
    await expect(f.registry.collectSource(enabled.sourceId, 1, { signal: new AbortController().signal,
      isLive() { if (committing) void f.registry.pauseSource(enabled.sourceId); return true; } }))
      .resolves.toMatchObject({ accepted: false, reason: 'PAUSED' });
    expect(f.db.prepare('SELECT status FROM source_configs WHERE source_id=?').get(enabled.sourceId)).toEqual({ status: 'paused' });
    expect(f.db.prepare("SELECT kind FROM collection_receipts WHERE kind<>'enable'").all()).toEqual([{ kind: 'pause' }]);
    expect(f.db.prepare('SELECT * FROM http_source_response_evidence').all()).toEqual([]);
  } finally { f.close(); }
});

test('history final callback can replay a completed receipt while recovery closes', async () => {
  const f = callbackFixture();
  try {
    const { plan } = await prepareHistory(f);
    const receipt = { receipt_id: 'receipt_' + plan.plan_id, applied_at: at,
      selected_objects: 1, imported_objects: 0, existing_objects: 1 };
    const before = f.counts();
    await expect(f.registry.importRssHistory(historyActor, plan.plan_id, plan.plan_hash, 1, () => {
      f.db.prepare('INSERT INTO http_source_history_receipts VALUES (?,?,?,?,?,?)')
        .run(plan.plan_id, receipt.receipt_id, at, 1, 0, 1);
      createRecoveryRuntimeGate(f.db);
      return at;
    })).resolves.toEqual({ receipt, created: false });
    expect(f.counts()).toEqual(before);
  } finally { f.close(); }
});

test.each(['pause', 'disconnect'] as const)('HTTP %s final callback may close recovery and still reduce authority', async (operation) => {
  const f = callbackFixture();
  try {
    const enabled = await f.registry.enableSource(principal, feedDraft);
    expect(f.registry.changeHttpSource(principal, enabled.sourceId, operation, 1, undefined, () => {
      createRecoveryRuntimeGate(f.db);
      return at;
    })).toMatchObject({ changed: true, revision: 2 });
    expect(f.db.prepare('SELECT enabled,status FROM source_configs WHERE source_id=?').get(enabled.sourceId))
      .toEqual({ enabled: 0, status: operation === 'pause' ? 'paused' : 'disconnected' });
  } finally { f.close(); }
});
