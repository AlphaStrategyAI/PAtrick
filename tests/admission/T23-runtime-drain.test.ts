import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { openDatabase } from '@patrick/storage';
import { createNotificationMaintenance } from '../../apps/service/src/notification-maintenance.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const roots: string[] = [];
function temporary() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t23-drain-'));
  roots.push(root);
  return { databasePath: join(root, 'service.sqlite'), credentialDirectory: join(root, 'credentials') };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('factory subpath has no singleton, database, credential or timer startup', async () => {
  const storage = await import('@patrick/storage');
  const host = await import('@patrick/host');
  const opened = vi.spyOn(storage, 'openDatabase');
  const credentials = vi.spyOn(host, 'createCredentialStore');
  const timer = vi.spyOn(globalThis, 'setTimeout');
  try {
    const factory = await import('@patrick/service/factory');
    expect(factory).not.toHaveProperty('app');
    expect(factory.createApp).toBeTypeOf('function');
    expect([opened, credentials, timer].map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
  } finally { vi.restoreAllMocks(); }
});


test('notification stop joins the real deferred claim and denies subsequent ticks', async () => {
  const paths = temporary();
  const db = openDatabase(paths.databasePath);
  const claim = deferred<null>();
  const entered = deferred<void>();
  const stop = new AbortController();
  let calls = 0;
  const worker = createNotificationMaintenance(db, () => new Date(), {
    hub: { claim: () => { calls++; entered.resolve(); return claim.promise; }, heartbeat: async () => [], result: async () => ({ rejected: [] }) },
    transport: { send: async () => { throw new Error('UNEXPECTED_SEND'); }, lookup: async () => { throw new Error('UNEXPECTED_LOOKUP'); } },
    scopes: [{ accountId: 'owner', dataDomain: 'personal' }], timezone: 'UTC', credentialUsable: () => false,
    signal: stop.signal,
  });
  try {
    const active = worker.tick();
    await entered.promise;
    stop.abort();
    const lifetime = worker as typeof worker & { join?: () => Promise<void> };
    expect(lifetime.join, 'an aborted signal must still expose the active claim join').toBeTypeOf('function');
    let finished = false;
    const joined = lifetime.join!().then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(db.prepare('SELECT 1 AS alive').get()).toEqual({ alive: 1 });
    claim.resolve(null);
    await Promise.all([active, joined]);
    await worker.tick();
    expect(calls).toBe(1);
  } finally { claim.resolve(null); db.close(); }
});

async function runtimeFactory() {
  return (await import('../../apps/service/src/factory.js')).createServiceRuntime;
}

test('owned runtime denies late requests and joins an admitted handler before closing SQLite', async () => {
  const paths = temporary();
  const make = await runtimeFactory();
  let database: ReturnType<typeof openDatabase> | undefined;
  const value = make({ ...paths, recoveryRuntime: { attach({ database: db }: { database: ReturnType<typeof openDatabase> }) { database = db; } } });
  const runtime = value as { app?: import('hono').Hono; drain?: (options?: { timeoutMs?: number }) => Promise<{ status: string }> };
  expect(runtime.drain, 'service must own an awaited resource drain').toBeTypeOf('function');
  const entered = deferred<void>();
  const finish = deferred<void>();
  let observed: unknown;
  runtime.app!.get('/deferred', async (c) => {
    entered.resolve();
    await finish.promise;
    observed = database!.prepare('SELECT 1 AS alive').get();
    return c.json(observed);
  });
  const request = runtime.app!.request('/deferred');
  await entered.promise;
  expect(await runtime.drain!({ timeoutMs: 1 })).toMatchObject({ status: 'draining' });
  expect(database!.open).toBe(true);
  expect((await runtime.app!.request('/healthz')).status).toBe(503);
  finish.resolve();
  expect((await request).status).toBe(200);
  expect(observed).toEqual({ alive: 1 });
  expect(await runtime.drain!()).toMatchObject({ status: 'closed' });
  expect(database!.open).toBe(false);
  expect(await runtime.drain!()).toMatchObject({ status: 'closed' });
});

test('lazy zero-worker runtime drains without opening its database', async () => {
  const { createServiceRuntime } = await import('../../apps/service/src/factory.js');
  const storage = await import('@patrick/storage');
  const opened = vi.spyOn(storage, 'openDatabase');
  try {
    const runtime = createServiceRuntime();
    expect((await runtime.app.request('/healthz')).status).toBe(200);
    expect(await runtime.drain()).toMatchObject({ status: 'closed' });
    expect(opened).not.toHaveBeenCalled();
    expect((await runtime.app.request('/api/v1/settings')).status).toBe(503);
  } finally { opened.mockRestore(); }
});

test('trusted recovery composition receives the exact gated handles before any worker call', async () => {
  const { createServiceRuntime } = await import('../../apps/service/src/factory.js');
  const { recoveryWriteAllowed } = await import('@patrick/storage');
  const paths = temporary();
  const sequence: string[] = [];
  let database!: ReturnType<typeof openDatabase>;
  let hub!: import('@patrick/integrations/autoloop/answers').LocalHubPort;
  const claimed = deferred<null>();
  const entered = deferred<void>();
  const runtime = createServiceRuntime({ ...paths,
    recoveryRuntime: { attach({ database: db }) { database = db; sequence.push('attached'); } },
    bindRecoveryOperations(resources) {
      expect(resources.database).toBe(database);
      expect(recoveryWriteAllowed(resources.database, 'personal')).toBe(false);
      hub = resources.hub;
      sequence.push('bound');
      return undefined;
    },
    notificationMaintenance: {
      hub: { claim: () => { sequence.push('worker'); entered.resolve(); return claimed.promise; },
        heartbeat: async () => [], result: async () => ({ rejected: [] }) },
      transport: { send: async () => { throw new Error('UNEXPECTED_SEND'); }, lookup: async () => { throw new Error('UNEXPECTED_LOOKUP'); } },
      scopes: [{ accountId: 'owner', dataDomain: 'personal' }], timezone: 'UTC', credentialUsable: () => false,
    },
  });
  const closeHub = vi.spyOn(hub, 'close');
  const closeDb = vi.spyOn(database, 'close');
  try {
    await entered.promise;
    expect(sequence).toEqual(['attached', 'bound', 'worker']);
    expect(await runtime.drain({ timeoutMs: 1 })).toMatchObject({ status: 'draining' });
    expect(runtime.read().status).toBe('draining');
    expect(closeHub).not.toHaveBeenCalled();
    expect(closeDb).not.toHaveBeenCalled();
    await hub.accept('fixture', 1, { choice: 0 });
    claimed.resolve(null);
    expect(await runtime.drain()).toMatchObject({ status: 'closed' });
    expect(closeHub).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(closeHub.mock.invocationCallOrder[0]).toBeLessThan(closeDb.mock.invocationCallOrder[0]);
  } finally { claimed.resolve(null); await runtime.drain(); }
});

test('startup rejection stops scheduled workers and closes the owned Hub and main database', async () => {
  const { createServiceRuntime } = await import('../../apps/service/src/factory.js');
  const paths = temporary();
  let database!: ReturnType<typeof openDatabase>;
  let closeHub!: ReturnType<typeof vi.spyOn>;
  const claim = vi.fn(async () => null);
  expect(() => createServiceRuntime({ ...paths,
    recoveryRuntime: { attach({ database: db }) { database = db; } },
    bindRecoveryOperations({ hub }) { closeHub = vi.spyOn(hub, 'close'); return undefined; },
    notificationMaintenance: { hub: { claim, heartbeat: async () => [], result: async () => ({ rejected: [] }) },
      transport: { send: async () => { throw new Error('UNEXPECTED_SEND'); }, lookup: async () => { throw new Error('UNEXPECTED_LOOKUP'); } },
      scopes: [{ accountId: 'owner', dataDomain: 'personal' }], timezone: 'UTC', credentialUsable: () => false },
    consultationWorker: { hub: emptyConsultationHub(), heartbeatIntervalMs: 0 },
  })).toThrow('CONSULTATION_WORKER_TIMEOUT_INVALID');
  await vi.waitFor(() => expect(database.open).toBe(false));
  expect(closeHub).toHaveBeenCalledTimes(1);
  expect(claim).not.toHaveBeenCalled();
});

function emptyConsultationHub(): import('../../packages/integrations/autoloop/consultation-runtime.js').ConsultationWorkerOptions['hub'] {
  return {
    postEvent: async () => { throw new Error('UNEXPECTED_POST'); }, eventOutcome: async () => { throw new Error('UNEXPECTED_OUTCOME'); },
    claim: async () => null, heartbeat: async () => [], result: async () => ({ rejected: [] }),
  };
}

test('Hub observer join retains a deferred snapshot after caller cancellation and never reschedules', async () => {
  const { startProductViewHubObserver } = await import('../../apps/service/src/product-views.js');
  const db = openDatabase(temporary().databasePath);
  const stop = new AbortController();
  const entered = deferred<void>();
  const snapshot = deferred<import('@patrick/integrations/autoloop/observer').HubStatePage>();
  const state = vi.fn(() => { entered.resolve(); return snapshot.promise; });
  const record = vi.fn();
  const worker = startProductViewHubObserver(db, () => new Date(), { hub: { state }, signal: stop.signal }, record);
  try {
    await entered.promise;
    stop.abort();
    let joined = false;
    const completion = worker.join().then(() => { joined = true; });
    await Promise.resolve();
    expect(joined).toBe(false);
    snapshot.resolve({ seq: 0, runs: [], cards: [], lines: [], hasMore: false, nextBefore: null });
    await completion;
    expect(record).not.toHaveBeenCalled();
    expect(state).toHaveBeenCalledTimes(1);
    expect(worker.errors).toEqual([{ code: 'ASYNC_TASK_FAILED' }]);
  } finally { worker.stop(); await worker.join(); db.close(); }
});

test('SSE cancellation joins deferred poll authentication before SQLite closes and does not rearm', async () => {
  const { createHash } = await import('node:crypto');
  const auth = await import('../../apps/service/src/auth.js');
  const { createServiceRuntime } = await import('../../apps/service/src/factory.js');
  const paths = temporary();
  let database!: ReturnType<typeof openDatabase>;
  const runtime = createServiceRuntime({ ...paths,
    recoveryRuntime: { attach({ database: db }) { database = db; } },
  });
  const at = new Date().toISOString();
  database.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run('owner', 1, 1, at);
  database.prepare("INSERT INTO caller_scopes VALUES ('owner','web','personal','owner',NULL)").run();
  const token = 'synthetic-t23-web-session';
  database.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)').run(
    createHash('sha256').update(token).digest('hex'), 'owner', 'web', 1,
    new Date(Date.now() + 60_000).toISOString(), at, 'fixture-only-no-secret');
  const entered = deferred<void>();
  const release = deferred<void>();
  const original = auth.runWithAuth;
  let armed = false;
  let polls = 0;
  let polledWithOpenDatabase = false;
  const authenticate = vi.spyOn(auth, 'runWithAuth').mockImplementation(async (context, fn) => {
    if (armed) {
      polls++;
      entered.resolve();
      await release.promise;
      polledWithOpenDatabase = context.db.open;
    }
    return original(context, fn);
  });
  try {
    const response = await runtime.app.request('/api/v1/events?domain=personal&after=synthetic-cursor', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    armed = true;
    const pendingRead = response.body!.getReader().read();
    await entered.promise;
    expect(await runtime.drain({ timeoutMs: 1 })).toMatchObject({ status: 'draining' });
    expect(database.open).toBe(true);
    expect((await runtime.app.request('/healthz')).status).toBe(503);
    release.resolve();
    await pendingRead;
    expect(await runtime.drain()).toMatchObject({ status: 'closed' });
    expect(polledWithOpenDatabase).toBe(true);
    expect(polls).toBe(1);
    expect(database.open).toBe(false);
  } finally { release.resolve(); await runtime.drain(); authenticate.mockRestore(); }
});

test('HTTP source join awaits cancelled collection SQL finalization and clears its durable lease', async () => {
  const { createBlobStore } = await import('@patrick/storage');
  const { createSourceRegistry } = await import('../../packages/integrations/sources/registry.js');
  const { createHttpCollectionWorker } = await import('../../apps/service/src/source-collection.js');
  const paths = temporary();
  const db = openDatabase(paths.databasePath);
  const stop = new AbortController();
  const response = { status: 200, location: null, contentType: 'application/rss+xml',
    bytes: new TextEncoder().encode('<rss><channel><item><guid>first</guid><title>First</title></item></channel></rss>') };
  const pending = deferred<typeof response>();
  const entered = deferred<void>();
  let delay = false;
  const request = vi.fn(async () => { if (delay) { entered.resolve(); return pending.promise; } return response; });
  const registry = createSourceRegistry(db, { blobs: createBlobStore(join(paths.credentialDirectory, '..', 'blobs')),
    http: { approvedUrls: () => ['https://feed.example.test/news'],
      port: { request, resolve: async () => [{ address: '8.8.8.8', family: 4 }] } } });
  const source = await registry.enableSource({ accountId: 'owner', dataDomain: 'personal' }, { type: 'rss', target: 'https://feed.example.test/news' });
  const worker = createHttpCollectionWorker(db, registry, () => new Date(), { signal: stop.signal });
  try {
    delay = true;
    const tick = worker.tick();
    await entered.promise;
    stop.abort();
    let finished = false;
    const joined = worker.join().then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(finished).toBe(false);
    expect(db.prepare('SELECT 1 AS alive').get()).toEqual({ alive: 1 });
    pending.resolve(response);
    await Promise.all([tick, joined]);
    expect(db.prepare('SELECT lease_token,lease_until FROM http_source_schedule WHERE source_id=?').get(source.sourceId)).toEqual({ lease_token: null, lease_until: null });
    expect(await worker.tick()).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  } finally { pending.resolve(response); worker.stop(); await worker.join(); db.close(); }
});

test('consultation join retains the underlying Hub promise beyond its logical deadline', async () => {
  const { createConsultationApi } = await import('../../packages/domain/src/consultations.js');
  const { startConsultationWorker } = await import('../../packages/integrations/autoloop/consultation-runtime.js');
  const db = openDatabase(temporary().databasePath);
  const now = () => new Date();
  db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run('owner', 1, 1, now().toISOString());
  db.prepare("INSERT INTO caller_scopes VALUES ('owner','web','personal','consultation.request',NULL)").run();
  const principal = { account_id: 'owner', caller_id: 'web', auth_epoch: 1, domains: ['personal'], operations: ['consultation.request'] };
  const api = createConsultationApi(db, { now });
  await api.createConsultation(principal, { client_request_id: 'finite-consultation', text: 'Synthetic request', data_domain: 'personal', parent_work_id: null });
  const entered = deferred<void>();
  const reply = deferred<never>();
  const post = vi.fn(() => { entered.resolve(); return reply.promise; });
  const worker = startConsultationWorker(db, now, { hub: { ...emptyConsultationHub(), postEvent: post },
    hubTimeoutMs: 1, intervalMs: 60_000, onError() {} }, { put() { throw new Error('UNEXPECTED_SECRET'); }, resolve: () => null });
  try {
    await entered.promise;
    // A deadline ends the logical Hub request but cannot prove its actual callback has completed.
    await new Promise((resolve) => setTimeout(resolve, 5));
    worker.stop();
    let finished = false;
    const joined = worker.join().then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    reply.resolve(undefined as never);
    await joined;
    expect(post).toHaveBeenCalledTimes(1);
    expect(db.open).toBe(true);
  } finally { reply.resolve(undefined as never); worker.stop(); await worker.join(); db.close(); }
});

test('projection sweep cancellation clears the queued sweep and exposes an idempotent join', async () => {
  const { createProductViewService } = await import('../../apps/service/src/product-views.js');
  const db = openDatabase(temporary().databasePath);
  const views = createProductViewService(db, () => new Date());
  const worker = views.start();
  worker.stop();
  await worker.join();
  db.close();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(views.start()).toBe(worker);
  await worker.join();
});

async function seedWork(db: ReturnType<typeof openDatabase>) {
  const { createDelegationApi } = await import('../../packages/domain/src/delegation.js');
  const now = () => new Date('2026-11-17T00:00:00.000Z');
  const principal = { account_id: 'owner', caller_id: 'web', auth_epoch: 1, domains: ['personal'], operations: ['owner'] };
  db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run('owner', 1, 1, now().toISOString());
  const service = createDelegationApi(db, principal, { domain: 'personal', now });
  const policy = { type_id: 'finite-type', domains: ['personal'], actions: ['judge'], resources: ['work'], effects: [],
    risk: 'low', level: 'L1' as const, budget_micros: 1000 };
  await service.registerMandateType({ ...policy, config_version: 1 });
  await service.openMandate({ ...policy, mandate_id: 'finite-mandate', expires_at: '2026-12-01T00:00:00.000Z' });
  await service.openWork({ work_id: 'finite-work', generation: 1, mandate_id: 'finite-mandate', phase: 'judgment', next_action: 'judge', budget_micros: 1 });
  return { principal, now };
}

test('work-stop join waits for the actual supervisor after cancellation wins its observation race', async () => {
  const { appendDomainEvent } = await import('@patrick/storage');
  const { createWorkControlApi } = await import('../../packages/domain/src/work-control.js');
  const { startWorkStopObserver } = await import('../../apps/service/src/work-stop.js');
  const db = openDatabase(temporary().databasePath);
  const { principal, now } = await seedWork(db);
  const receipt = createWorkControlApi(db, principal, { now,
    stopPort: { submit() {}, read: () => ({ process_tree_stopped: false, effects_reconciled: false }) },
  }).applyWorkControlNow(principal, { work_id: 'finite-work', generation: 1, expected_revision: 0, type: 'stop' });
  appendDomainEvent(db, { eventId: 'finite-stop', aggregateId: 'finite-work', aggregateVersion: 1,
    accountId: 'owner', dataDomain: 'personal', destination: 'work-stop-supervisor',
    payload: { type: 'work.stop.requested', receipt_id: receipt.receipt_id } });
  const entered = deferred<void>();
  const reply = deferred<import('../../packages/domain/src/work-control.js').StopReport | null>();
  const reconcile = vi.fn(() => { entered.resolve(); return reply.promise; });
  const worker = startWorkStopObserver(db, { reconcile }, now);
  try {
    await entered.promise;
    worker.stop();
    let finished = false;
    const completion = worker.join().then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(db.prepare('SELECT state FROM work_control_receipts WHERE receipt_id=?').get(receipt.receipt_id)).toEqual({ state: 'processing' });
    reply.resolve({ process_tree_stopped: true, effects_reconciled: true });
    await completion;
    expect(db.prepare('SELECT state FROM work_control_receipts WHERE receipt_id=?').get(receipt.receipt_id)).toEqual({ state: 'processing' });
    expect(reconcile).toHaveBeenCalledTimes(1);
  } finally { reply.resolve(null); worker.stop(); await worker.join(); db.close(); }
});

test('PR service shutdown joins polling and denies staging after stop', async () => {
  const { createBlobStore } = await import('@patrick/storage');
  const { createPrDeliveryService } = await import('../../apps/service/src/pr-delivery.js');
  const paths = temporary();
  const db = openDatabase(paths.databasePath);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('UNEXPECTED_FETCH'); });
  const worker = createPrDeliveryService(db, () => new Date(), { accountId: 'owner', callerId: 'web', domain: 'personal',
    target: { owner: 'approved', repo: 'plans', repoId: '123', baseRef: 'main' },
    artifactsRoot: join(paths.credentialDirectory, '..', 'artifacts'), receiptsRoot: join(paths.credentialDirectory, '..', 'receipts'),
    blobs: createBlobStore(join(paths.credentialDirectory, '..', 'blobs')), fetch });
  try {
    const close = worker.start();
    close();
    await worker.join();
    expect(worker.pollOnce()).toBeInstanceOf(Promise);
    await worker.join();
    await expect(worker.stageCompletedBuild({} as Parameters<typeof worker.stageCompletedBuild>[0], { title: '', body: '' })).rejects.toThrow('PUBLISHER_SCOPE_UNAVAILABLE');
    expect(fetch).not.toHaveBeenCalled();
  } finally { worker.stop(); await worker.join(); db.close(); }
});

test('top-level cancellation closes lazy runtime and repeated drains share completion', async () => {
  const { createServiceRuntime } = await import('../../apps/service/src/factory.js');
  const signal = new AbortController();
  const runtime = createServiceRuntime({ signal: signal.signal });
  signal.abort();
  expect((await runtime.app.request('/healthz')).status).toBe(503);
  const outcomes = await Promise.all([runtime.drain(), runtime.drain(), runtime.drain({ timeoutMs: 0 })]);
  expect(outcomes.map((value) => value.status)).toEqual(['closed', 'closed', 'closed']);
});

test('consultation shutdown keeps the actual paid backend operation joined after cancellation', async () => {
  const { createHash } = await import('node:crypto');
  const { createConsultationApi } = await import('../../packages/domain/src/consultations.js');
  const { startConsultationWorker } = await import('../../packages/integrations/autoloop/consultation-runtime.js');
  const { fixedConsultationQuoteHash } = await import('../../packages/executor/src/consultation.js');
  const { CONSULTATION_RULE } = await import('../../packages/integrations/autoloop/client.js');
  const db = openDatabase(temporary().databasePath);
  const now = () => new Date();
  db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run('owner', 1, 1, now().toISOString());
  db.prepare("INSERT INTO caller_scopes VALUES ('owner','web','personal','owner',NULL)").run();
  const principal = { account_id: 'owner', caller_id: 'web', auth_epoch: 1, domains: ['personal'], operations: ['owner'] };
  const request = await createConsultationApi(db, { now }).createConsultation(principal, {
    client_request_id: 'finite-paid', text: 'Synthetic question', data_domain: 'personal', parent_work_id: null });
  const observation = 'finite deferred test backend admission';
  const admission = { backend: 'dsh' as const, available: true, status: 'verified' as const,
    command: 'fixture', observation, evidenceSha256: createHash('sha256').update(observation).digest('hex') };
  const terms = { accountId: 'owner', dataDomain: 'personal', backend: admission.backend,
    admissionSha256: admission.evidenceSha256, routeId: 'fixture', chargeMicros: 11, providerQuoteRef: 'fixture-only-quote' };
  const reply = deferred<Awaited<ReturnType<import('../../packages/executor/src/consultation.js').ConsultationBackend['send']>>>();
  const entered = deferred<void>();
  const send = vi.fn(() => { entered.resolve(); return reply.promise; });
  const wire = { id: `consultation.requested:${request.request_id}`, source: 'patrick', type: 'consultation.requested',
    subject: request.request_id, summary: '', detail: JSON.stringify({ request_id: request.request_id, root: request.request_id,
      cause: request.request_id, kind: 'consultation.requested', generation: 0, hops: 0 }) };
  const secrets = new Map<string, Uint8Array>();
  const worker = startConsultationWorker(db, now, { intervalMs: 60_000, onError() {},
    hub: { ...emptyConsultationHub(), postEvent: async () => ({ event: 1, duplicate: false, routed: [CONSULTATION_RULE] }),
      eventOutcome: async () => ({ event: 1, runs: [{ run: 1, rule: CONSULTATION_RULE, state: 'claimed' }] }),
      claim: async () => ({ run: 1, token: 'synthetic-hub-token', rule: { name: CONSULTATION_RULE }, context: { answers: [], events: [wire] } }) },
    backend: { scope: { accountId: 'owner', dataDomain: 'personal' }, admission,
      route: { sdkMaxRetries: 0, implicitResend: false, perHttpAccounted: false, verifiedMaxSends: null },
      routeId: terms.routeId, pricing: { kind: 'fixed', terms, evidenceSha256: fixedConsultationQuoteHash(terms) }, send },
  }, { put(bytes) { secrets.set('fixture', bytes); return 'fixture'; }, resolve: (ref) => secrets.get(ref) ?? null });
  try {
    await entered.promise;
    worker.stop();
    let finished = false;
    const joined = worker.join().then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(finished).toBe(false);
    expect(db.prepare('SELECT status FROM budget_reservations').get()).toEqual({ status: 'uncertain' });
    reply.resolve({ terminal: { closed: true, drained: true, exitCode: 0, stdout: '', stderr: '' }, usage: null });
    await joined;
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT status FROM consultations WHERE request_id=?').get(request.request_id)).toEqual({ status: 'pending' });
  } finally {
    reply.resolve({ terminal: { closed: true, drained: true, exitCode: 0, stdout: '', stderr: '' }, usage: null });
    worker.stop(); await worker.join(); db.close();
  }
});

test('a handler that initiates drain remains admitted until its own deferred SQL finishes', async () => {
  const { createServiceRuntime } = await import('../../apps/service/src/factory.js');
  let database!: ReturnType<typeof openDatabase>;
  const runtime = createServiceRuntime({ ...temporary(), recoveryRuntime: { attach({ database: db }) { database = db; } } });
  const finish = deferred<void>();
  const entered = deferred<void>();
  let sql: unknown;
  runtime.app.get('/self-stop', async (c) => {
    runtime.stop();
    entered.resolve();
    await finish.promise;
    sql = database.prepare('SELECT 1 AS alive').get();
    return c.text('finished');
  });
  const response = runtime.app.request('/self-stop');
  await entered.promise;
  expect(await runtime.drain({ timeoutMs: 1 })).toMatchObject({ status: 'draining' });
  finish.resolve();
  await response;
  expect(await runtime.drain()).toMatchObject({ status: 'closed' });
  expect(sql).toEqual({ alive: 1 });
});

test('failed lazy credential initialization retries with the same owned database and recovery gate', async () => {
  const { createServiceRuntime } = await import('../../apps/service/src/factory.js');
  const host = await import('@patrick/host');
  const storage = await import('@patrick/storage');
  const opened = vi.spyOn(storage, 'openDatabase');
  const credentials = vi.spyOn(host, 'createCredentialStore');
  credentials.mockImplementationOnce(() => { throw new Error('synthetic credential directory failure'); });
  const attached = vi.fn();
  const runtime = createServiceRuntime({ credentialDirectory: temporary().credentialDirectory, recoveryRuntime: { attach: attached } });
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await runtime.app.request('/api/v1/session')).status).toBe(500);
    expect((await runtime.app.request('/api/v1/session')).status).toBe(401);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(attached).toHaveBeenCalledTimes(1);
    const db = opened.mock.results[0].value as ReturnType<typeof openDatabase>;
    expect(await runtime.drain()).toMatchObject({ status: 'closed' });
    expect(db.open).toBe(false);
    rmSync(db.name, { force: true });
  } finally { await runtime.drain(); vi.restoreAllMocks(); consoleError.mockRestore(); }
});

test('resource close failure is redacted and retains the main database with an explicit failed result', async () => {
  const { createServiceRuntime } = await import('../../apps/service/src/factory.js');
  let database!: ReturnType<typeof openDatabase>;
  let hub!: import('@patrick/integrations/autoloop/answers').LocalHubPort;
  const runtime = createServiceRuntime({ ...temporary(), recoveryRuntime: { attach({ database: db }) { database = db; } },
    bindRecoveryOperations(resources) { hub = resources.hub; return undefined; } });
  const close = vi.spyOn(hub, 'close').mockImplementation(() => { throw new Error('fixture-private-failure-detail'); });
  try {
    const result = await runtime.drain();
    expect(result).toMatchObject({ status: 'close_failed', errors: [{ code: 'HUB_CLOSE_FAILED' }] });
    expect(JSON.stringify(result)).not.toContain('fixture-private-failure-detail');
    expect(database.open).toBe(true);
    expect(await runtime.drain()).toEqual(result);
  } finally { close.mockRestore(); hub.close(); database.close(); }
});

test('PR drain joins a deferred read and its real uncertain-receipt SQL cleanup without another request', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { createBlobStore } = await import('@patrick/storage');
  const { createSourceRegistry } = await import('../../packages/integrations/sources/registry.js');
  const { createStandardsApi } = await import('../../packages/domain/src/standards.js');
  const { createPrDeliveryService } = await import('../../apps/service/src/pr-delivery.js');
  const paths = temporary();
  const db = openDatabase(paths.databasePath);
  const { principal, now } = await seedWork(db);
  const blobs = createBlobStore(join(paths.credentialDirectory, '..', 'blobs'));
  const sourcePath = join(paths.credentialDirectory, '..', 'synthetic-source');
  mkdirSync(sourcePath);
  writeFileSync(join(sourcePath, 'demand.md'), 'Synthetic historical read-only queue fixture');
  const registry = createSourceRegistry(db, { blobs, now: () => now().toISOString() });
  const source = await registry.enableSource({ accountId: 'owner', dataDomain: 'personal' },
    { type: 'directory', target: sourcePath, hasTriggerRule: true, excludes: [], frequency: 'poll', history: 'none' });
  await registry.collectSource(source.sourceId, source.configRevision);
  const revision = db.prepare('SELECT revision_id,content_hash FROM source_revisions LIMIT 1').get() as { revision_id: string; content_hash: string };
  const dataset = await createStandardsApi(db, principal, { domain: 'personal', now }).seedProductDataset();
  const hash = 'a'.repeat(64);
  const sha = 'a'.repeat(40);
  const at = now().toISOString();
  // This expired historical grant permits read-only reconciliation. It cannot authorize a new send.
  db.prepare(`INSERT INTO execution_grants(grant_id,subject_kind,account_id,data_domain,work_id,generation,caller_id,attempt_id,
    mandate_id,next_action,allowed_effects_json,allowed_domains_json,readonly_tools_json,basis_hash,phase,permission_revision,expires_at,schema_version,created_at)
    VALUES ('historical-grant','work','owner','personal','finite-work',1,'web','historical-attempt','finite-mandate','publish_pr',
    '["publish_pr"]','["personal"]','[]',?,'delivery',1,?,'1.0',?)`).run(hash, at, at);
  db.prepare(`INSERT INTO work_pr_builds(build_id,work_id,generation,grant_id,attempt_id,source_revision_id,source_config_revision,
    source_hash,basis_hash,repo_id,base_ref,artifact,patch,verified_at)
    VALUES ('historical-build','finite-work',1,'historical-grant','historical-attempt',?,1,?,?,'123','main','{}','{}',?)`)
    .run(revision.revision_id, revision.content_hash, hash, at);
  db.prepare(`INSERT INTO effect_intents(intent_id,effect_key,account_id,data_domain,work_id,generation,origin,action,build_id,
    authorization_ref,authorization_epoch,resource,repo_id,repo_owner,repo_name,branch,base_ref,expected_remote_version,
    head_sha,tree_sha,title,body,payload_hash,dataset_id,case_id,created_at,schema_version)
    VALUES ('historical-intent','historical-key','owner','personal','finite-work',1,'business','publish_pr','historical-build',
    'historical-grant',1,'github:123','123','approved','plans','patrick/historical','main',?,?,?,'Historical plan','Fixture',?,?,?,?,'1.0')`)
    .run(sha, sha, sha, hash, dataset.dataset_id, dataset.training_ids[0], at);
  db.prepare("INSERT INTO effect_receipts(intent_id,status,updated_at) VALUES ('historical-intent','uncertain',?)").run(at);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  const entered = deferred<void>();
  const reply = deferred<Response>();
  let receivedSignal: AbortSignal | null | undefined;
  const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => { receivedSignal = init?.signal; entered.resolve(); return reply.promise; });
  const worker = createPrDeliveryService(db, now, { accountId: 'owner', callerId: 'web', domain: 'personal',
    target: { owner: 'approved', repo: 'plans', repoId: '123', baseRef: 'main' }, artifactsRoot: sourcePath, receiptsRoot: sourcePath, blobs, fetch });
  try {
    const polling = worker.pollOnce();
    await entered.promise;
    worker.stop();
    expect(receivedSignal?.aborted).toBe(true);
    let finished = false;
    const joined = worker.join().then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(finished).toBe(false);
    reply.resolve(Response.json({ id: 123, full_name: 'approved/plans' }));
    await Promise.all([polling, joined]);
    expect(db.prepare("SELECT status,reason FROM effect_receipts WHERE intent_id='historical-intent'").get())
      .toEqual({ status: 'uncertain', reason: 'github_read_or_send_unknown' });
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { reply.resolve(Response.json({})); worker.stop(); await worker.join(); db.close(); }
});

test('notification join retains the actual transport after its domain deadline has recorded uncertainty', async () => {
  const { NOTIFICATION_RULE } = await import('@patrick/integrations/autoloop/client');
  const { storeHubView } = await import('@patrick/integrations/autoloop/observer');
  const db = openDatabase(temporary().databasePath);
  await seedWork(db);
  const timestamp = '2026-11-17T12:00:00.000Z';
  const now = () => new Date(timestamp);
  db.prepare("INSERT INTO caller_scopes VALUES ('owner','web','personal','owner',NULL)").run();
  db.prepare("UPDATE work_generations SET awaiting_answer=1 WHERE work_id='finite-work'").run();
  db.prepare(`INSERT INTO question_bindings(question_id,question_version,work_id,generation,account_id,data_domain,proposal_revision,
    options_hash,hub_card_id,judgment_basis_hash,options_json,custom_rules_json,custom_allowed,status,withdrawal_watermark,schema_version,
    revision,created_at,updated_at) VALUES ('finite-question',1,'finite-work',1,'owner','personal',1,?,71,?,'[]','{}',0,'open',0,'1.0',1,?,?)`)
    .run('a'.repeat(64), 'b'.repeat(64), timestamp, timestamp);
  db.prepare(`INSERT INTO product_view_checkpoints(account_id,data_domain,epoch,hub_seq,domain_seq,notification_seq,notification_floor,
    observed_at,trusted_as_of,freshness) VALUES ('owner','personal',1,4,0,1,0,?,?,'fresh')`).run(timestamp, timestamp);
  db.prepare("INSERT INTO product_work_views VALUES ('owner','personal','finite-work',1,1,'awaiting_answer',?,?)")
    .run(timestamp, JSON.stringify({ question_id: 'finite-question', generation: 1 }));
  storeHubView(db, { hub_seq: 4, cards: [], runs: [] }, timestamp);
  db.prepare(`INSERT INTO channel_connections(connection_id,account_id,data_domain,app_id,tenant_key,credential_ref,
    credential_version,config_revision,channel_incarnation,connection_epoch,binding_revision,current_pairing_id,current_test_id,owner_open_id,chat_id,status,
    transport_mode,schema_version,created_at,updated_at)
    VALUES ('finite-connection','owner','personal','app','tenant','fixture-ref',1,1,1,1,1,'finite-pair','finite-test','owner-open','owner-chat',
    'ready','active','1.0',?,?)`).run(timestamp, timestamp);
  db.prepare(`INSERT INTO channel_bindings VALUES
    ('finite-binding','finite-connection','finite-pair','owner','personal','owner-open','owner-chat','app','tenant',1,1,1,1,1,'1.0',?)`).run(timestamp);
  db.prepare(`INSERT INTO channel_tests(test_id,connection_id,account_id,data_domain,preview_hash,destination,status,message_id,inbound_evidence,
    app_id,tenant_key,config_revision,credential_version,binding_id,incarnation,epoch,schema_version,created_at,updated_at)
    VALUES ('finite-test','finite-connection','owner','personal',?,'owner-open','verified','fixture-message','fixture-reply','app','tenant',
    1,1,'finite-binding',1,1,'1.0',?,?)`).run('c'.repeat(64), timestamp, timestamp);
  const response = deferred<Awaited<ReturnType<import('../../packages/domain/src/notifications.js').NotificationPort['send']>>>();
  const entered = deferred<void>();
  const send = vi.fn<import('../../packages/domain/src/notifications.js').NotificationPort['send']>((_delivery, beforeSend) => {
    beforeSend(); entered.resolve(); return response.promise;
  });
  const worker = createNotificationMaintenance(db, now, {
    hub: { claim: async () => ({ run: 1, token: '{{SECRET_ut0210j7}}', rule: { name: NOTIFICATION_RULE }, context: { answers: [],
      events: [{ source: 'schedule', type: 'schedule.tick', id: NOTIFICATION_RULE + '@' + timestamp, subject: '', summary: '' }] } }),
    heartbeat: async () => [], result: async () => ({ rejected: [] }) },
    transport: { send, lookup: async () => ({ outcome: 'unknown' }) }, timezone: 'UTC',
    credentialUsable: () => true, scopes: [{ accountId: 'owner', dataDomain: 'personal' }],
  });
  const deadline = new AbortController();
  const timeout = AbortSignal.timeout;
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => ms === 12_000 ? deadline.signal : timeout(ms));
  try {
    const ticking = worker.tick();
    await entered.promise;
    deadline.abort();
    await ticking;
    worker.stop();
    let finished = false;
    const joined = worker.join().then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(db.prepare('SELECT status FROM notification_intents').get()).toEqual({ status: 'uncertain' });
    response.resolve({ outcome: 'unknown' });
    await joined;
    expect(send).toHaveBeenCalledTimes(1);
  } finally { response.resolve({ outcome: 'unknown' }); worker.stop(); await worker.join(); timeoutSpy.mockRestore(); db.close(); }
});

test('HTTP worker joins deferred DNS after logical cancellation without admitting an HTTP request', async () => {
  const { createBlobStore } = await import('@patrick/storage');
  const { createSourceRegistry } = await import('../../packages/integrations/sources/registry.js');
  const { createHttpCollectionWorker } = await import('../../apps/service/src/source-collection.js');
  const paths = temporary();
  const db = openDatabase(paths.databasePath);
  const dns = deferred<readonly { address: string; family: number }[]>();
  const entered = deferred<void>();
  const request = vi.fn(async () => { throw new Error('UNEXPECTED_REQUEST'); });
  const registry = createSourceRegistry(db, { blobs: createBlobStore(join(paths.credentialDirectory, '..', 'blobs')),
    http: { approvedUrls: () => ['https://feed.example.test/news'],
      port: { resolve: () => { entered.resolve(); return dns.promise; }, request } } });
  const source = await registry.enableSource({ accountId: 'owner', dataDomain: 'personal' }, { type: 'rss', target: 'https://feed.example.test/news' });
  const worker = createHttpCollectionWorker(db, registry, () => new Date(), { signal: new AbortController().signal });
  try {
    const ticking = worker.tick();
    await entered.promise;
    worker.stop();
    await ticking;
    let finished = false;
    const joined = worker.join().then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(finished).toBe(false);
    expect(db.prepare('SELECT lease_token FROM http_source_schedule WHERE source_id=?').get(source.sourceId)).toEqual({ lease_token: null });
    dns.resolve([{ address: '8.8.8.8', family: 4 }]);
    await joined;
    expect(request).not.toHaveBeenCalled();
    expect(await worker.tick()).toBe(false);
  } finally { dns.resolve([]); worker.stop(); await worker.join(); db.close(); }
});

test('request-owned source preview retains failed raw DNS after its handler ends and redacts late failure', async () => {
  const { createHash } = await import('node:crypto');
  const { canonicalPayload } = await import('@patrick/contracts');
  const { ORIGIN } = await import('../../apps/service/src/auth.js');
  const { createServiceRuntime } = await import('../../apps/service/src/factory.js');
  const storage = await import('@patrick/storage');
  const opened = vi.spyOn(storage, 'openDatabase');
  const dns = deferred<readonly { address: string; family: number }[]>();
  const entered = deferred<void>();
  let signal: AbortSignal | undefined;
  const requestPort = vi.fn(async () => { throw new Error('UNEXPECTED_REQUEST'); });
  const runtime = createServiceRuntime({ ...temporary(), httpSources: {
    approvedUrls: () => ['https://feed.example.test/news'],
    port: { resolve: (_host, current) => { signal = current; entered.resolve(); return dns.promise; }, request: requestPort },
  } });
  const db = opened.mock.results[0].value as ReturnType<typeof openDatabase>;
  opened.mockRestore();
  const at = new Date().toISOString();
  const token = 'synthetic-source-preview-session';
  db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run('owner', 1, 1, at);
  db.prepare("INSERT INTO caller_scopes VALUES ('owner','web','personal','owner',NULL)").run();
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),
    'owner', 'web', 1, new Date(Date.now() + 60_000).toISOString(), at, 'fixture-only-no-secret');
  const payload = { type: 'rss', target: 'https://feed.example.test/news', request_scope: {
    account_id: 'owner', caller_id: 'web', data_domain: 'personal', permission_epoch: 1,
  } };
  try {
    const response = runtime.app.request('/api/v1/sources/detect', { method: 'POST', headers: {
      authorization: `Bearer ${token}`, origin: ORIGIN, 'content-type': 'application/json',
    }, body: JSON.stringify({ client_request_id: 'finite-preview', expected_revision: null, payload,
      payload_hash: createHash('sha256').update(canonicalPayload(payload)).digest('hex') }) });
    await entered.promise;
    expect(await runtime.drain({ timeoutMs: 1 })).toMatchObject({ status: 'draining' });
    expect(signal?.aborted).toBe(true);
    expect((await response).status).toBe(503);
    expect(db.open).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_preview_receipts').get()).toEqual({ n: 0 });
    expect((await runtime.app.request('/healthz')).status).toBe(503);
    dns.reject(new Error('fixture-private-late-DNS-error'));
    const closed = await runtime.drain();
    expect(closed).toMatchObject({ status: 'closed', errors: [{ code: 'ASYNC_TASK_FAILED' }] });
    expect(JSON.stringify(closed)).not.toContain('fixture-private-late-DNS-error');
    expect(requestPort).not.toHaveBeenCalled();
    expect(db.open).toBe(false);
  } finally { dns.resolve([]); await runtime.drain(); }
});

test('startup errors retain an awaitable cleanup outcome and compatible createApp rethrows the original cause', async () => {
  const { createServiceRuntime, createApp } = await import('../../apps/service/src/factory.js');
  const cause = new Error('fixture-startup-rejected');
  let failure: unknown;
  try {
    createServiceRuntime({ ...temporary(), recoveryRuntime: { attach() { throw cause; } } });
  } catch (error) { failure = error; }
  const exposed = failure as { cleanup?: { drain(): Promise<{ status: string }> }; cause?: unknown };
  expect(exposed.cleanup?.drain, 'failed startup must expose its actual asynchronous cleanup outcome').toBeTypeOf('function');
  expect(exposed.cause).toBe(cause);
  expect(await exposed.cleanup!.drain()).toMatchObject({ status: 'closed' });
  expect(() => createApp({ ...temporary(), recoveryRuntime: { attach() { throw cause; } } })).toThrow(cause);
});

test('trusted binding receives the exact local answer Hub SQLite handle used by the port', async () => {
  const { createServiceRuntime } = await import('../../apps/service/src/factory.js');
  let database: ReturnType<typeof openDatabase> | undefined;
  let hubDatabase: ReturnType<typeof openDatabase> | undefined;
  let hub: import('@patrick/integrations/autoloop/answers').LocalHubPort | undefined;
  const sequence: string[] = [];
  const runtime = createServiceRuntime({ ...temporary(), recoveryRuntime: { attach({ database: db }) { database = db; sequence.push('gate'); } },
    bindRecoveryOperations(resources) {
      hub = resources.hub;
      hubDatabase = resources.hubDatabase;
      sequence.push('bind');
      return undefined;
    },
    notificationMaintenance: { hub: { claim: async () => { sequence.push('worker'); return null; },
      heartbeat: async () => [], result: async () => ({ rejected: [] }) },
    transport: { send: async () => { throw new Error('UNEXPECTED_SEND'); }, lookup: async () => ({ outcome: 'unknown' }) },
    scopes: [{ accountId: 'owner', dataDomain: 'personal' }], timezone: 'UTC', credentialUsable: () => false },
  });
  try {
    expect(hubDatabase, 'bindRecoveryOperations must receive the existing local answer Hub SQLite handle').toBeDefined();
    expect(hubDatabase).not.toBe(database);
    expect(hubDatabase!.prepare("SELECT name FROM sqlite_master WHERE name='recovery_domain_gates'").get()).toBeUndefined();
    const closeHub = vi.spyOn(hub!, 'close');
    const closeHubDatabase = vi.spyOn(hubDatabase!, 'close');
    const closeDatabase = vi.spyOn(database!, 'close');
    await hub!.accept('exact-hub-question', 42, { text: 'Synthetic answer' });
    expect(hubDatabase!.prepare('SELECT card_id,body_json FROM hub_answers WHERE question_id=?').get('exact-hub-question'))
      .toEqual({ card_id: 42, body_json: JSON.stringify({ text: 'Synthetic answer' }) });
    hubDatabase!.prepare('INSERT INTO hub_answers VALUES (?,?,?,?)').run('sql-answer', 7, JSON.stringify({ choice: 0 }), 'fixture-event');
    expect(await hub!.read('sql-answer')).toEqual({ cardId: 7, state: 'answered', answer_event_id: 'fixture-event', body: { choice: 0 } });
    await vi.waitFor(() => expect(sequence).toEqual(['gate', 'bind', 'worker']));
    expect(await runtime.drain()).toMatchObject({ status: 'closed' });
    await runtime.drain();
    expect(closeHub).toHaveBeenCalledTimes(1);
    expect(closeHubDatabase).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(closeHubDatabase.mock.invocationCallOrder[0]).toBeLessThan(closeDatabase.mock.invocationCallOrder[0]);
  } finally { await runtime.drain(); }
});

test('a rejected trusted local Hub owner callback closes the exact opened handle', async () => {
  const { createLocalHubPort } = await import('@patrick/integrations/autoloop/answers');
  let database: ReturnType<typeof openDatabase> | undefined;
  const cause = new Error('fixture-owner-rejected');
  let closeDatabase: ReturnType<typeof vi.spyOn> | undefined;
  let returned: ReturnType<typeof createLocalHubPort> | undefined;
  try {
    expect(() => { returned = createLocalHubPort(temporary().databasePath, (db) => { database = db; closeDatabase = vi.spyOn(db, 'close'); throw cause; }); }).toThrow(cause);
    expect(database).toBeDefined();
    expect(database!.open).toBe(false);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  } finally { returned?.close(); if (database?.open) database.close(); }
});

test.each(['binding', 'initialization'] as const)('Hub %s failure exposes cleanup and closes each owned handle once in order', async (failurePoint) => {
  const storage = await import('@patrick/storage');
  const { createServiceRuntime, ServiceStartupError } = await import('../../apps/service/src/factory.js');
  const open = storage.openDatabase;
  const cause = new Error('fixture-hub-startup-rejected');
  let hubDatabase: ReturnType<typeof openDatabase> | undefined;
  let database: ReturnType<typeof openDatabase> | undefined;
  let closeHubDatabase: ReturnType<typeof vi.spyOn> | undefined;
  let closeDatabase: ReturnType<typeof vi.spyOn> | undefined;
  const opened = vi.spyOn(storage, 'openDatabase').mockImplementation((path, options) => {
    const db = open(path, options);
    if (path.endsWith('.hub')) {
      hubDatabase = db;
      closeHubDatabase = vi.spyOn(db, 'close');
      if (failurePoint === 'initialization') vi.spyOn(db, 'exec').mockImplementationOnce(() => { throw cause; });
    }
    return db;
  });
  const bind = vi.fn(() => { if (failurePoint === 'binding') throw cause; return undefined; });
  const claim = vi.fn(async () => null);
  let failure: unknown;
  try {
    try {
      createServiceRuntime({ ...temporary(), recoveryRuntime: { attach({ database: db }) {
        database = db;
        closeDatabase = vi.spyOn(db, 'close');
      } }, bindRecoveryOperations: bind,
      notificationMaintenance: { hub: { claim, heartbeat: async () => [], result: async () => ({ rejected: [] }) },
        transport: { send: async () => { throw new Error('UNEXPECTED_SEND'); }, lookup: async () => ({ outcome: 'unknown' }) },
        scopes: [{ accountId: 'owner', dataDomain: 'personal' }], timezone: 'UTC', credentialUsable: () => false } });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ServiceStartupError);
    const error = failure as InstanceType<typeof ServiceStartupError>;
    expect(error.cause).toBe(cause);
    expect(await error.cleanup.drain()).toMatchObject({ status: 'closed' });
    await error.cleanup.drain();
    expect(database!.open).toBe(false);
    expect(hubDatabase!.open).toBe(false);
    expect(closeHubDatabase).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(closeHubDatabase!.mock.invocationCallOrder[0]).toBeLessThan(closeDatabase!.mock.invocationCallOrder[0]);
    expect(claim).not.toHaveBeenCalled();
    expect(bind).toHaveBeenCalledTimes(failurePoint === 'binding' ? 1 : 0);
  } finally { opened.mockRestore(); if (hubDatabase?.open) hubDatabase.close(); if (database?.open) database.close(); }
});

test.each(['closed', 'close_failed'] as const)(
  'failed lazy recovery attachment blocks subsequent and queued requests with %s cleanup', async (cleanupStatus) => {
    const { createServiceRuntime } = await import('../../apps/service/src/factory.js');
    const host = await import('@patrick/host');
    const attached: ReturnType<typeof openDatabase>[] = [];
    const credentials = vi.spyOn(host, 'createCredentialStore');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    let close: ReturnType<typeof vi.spyOn> | undefined;
    let routed = 0;
    const runtime = createServiceRuntime({ credentialDirectory: temporary().credentialDirectory,
      recoveryRuntime: { attach({ database }) {
        attached.push(database);
        close = vi.spyOn(database, 'close');
        if (cleanupStatus === 'close_failed') close.mockImplementation(() => { throw new Error('fixture-close-failed'); });
        throw new Error('fixture-attachment-failed');
      } },
    });
    runtime.app.get('/api/v1/attachment-protected', (c) => { routed++; return c.text('must not enter'); });
    try {
      const first = runtime.app.request('/api/v1/session');
      const queued = runtime.app.request('/api/v1/attachment-protected');
      expect((await first).status).toBe(500);
      expect((await queued).status).toBeGreaterThanOrEqual(500);
      expect((await runtime.app.request('/api/v1/session')).status,
        'later lazy requests must remain blocked after failed attachment').toBe(503);
      expect(attached).toHaveLength(1);
      expect(routed).toBe(0);
      expect(credentials, 'failed attachment must never admit credential initialization').not.toHaveBeenCalled();
      const result = await runtime.drain();
      expect(result.status).toBe(cleanupStatus);
      expect(result.errors).toContainEqual({ code: 'RECOVERY_RUNTIME_ATTACHMENT_FAILED' });
      expect(attached[0].open).toBe(cleanupStatus === 'close_failed');
      expect(close).toHaveBeenCalledTimes(1);
      expect(await runtime.drain()).toEqual(result);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.drain();
      close?.mockRestore();
      for (const db of attached) {
        if (db.open) db.close();
        rmSync(db.name, { force: true });
      }
      credentials.mockRestore();
      errorLog.mockRestore();
    }
  },
);
