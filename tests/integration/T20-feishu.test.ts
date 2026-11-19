import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalPayload, routes, type Json } from '@patrick/contracts';
import { createCredentialStore } from '@patrick/host';
import { createLocalHubPort } from '@patrick/integrations/autoloop/answers';
import { createRecoveryRuntimeGate, openDatabase, withImmediateTransaction } from '@patrick/storage';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { createApp, createServiceRuntime } from '../../apps/service/src/factory.js';
import { issueCallerSession, runWithAuth } from '../../apps/service/src/auth.js';
import { createTaskLifetime } from '../../apps/service/src/lifecycle.js';
import { mountFeishuRoutes, publishPairingCode } from '../../apps/service/src/routes/feishu.js';
import { claimFeishuOutboundTest, dispatchClaimedFeishuTest, type FeishuTestOutbound } from '../../packages/integrations/feishu/outbound.js';
import { createFeishuChannel } from '../../packages/integrations/feishu/connection.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const origin = 'https://localhost';
const tests = '/api/v1/channels/feishu/tests';
const alias = '/api/v1/notifications/test';
const stamp = '2026-11-17T06:00:00.000Z';
const sample = 'PAtrick 连接测试，不含业务资料。';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(feishuTestOutbound?: FeishuTestOutbound, integrated = false, withOwner = true) {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t20-test-'));
  const databasePath = join(root, 'local.sqlite');
  const credentialDirectory = join(root, 'credentials');
  const db = openDatabase(databasePath);
  const hub = createLocalHubPort(join(root, 'hub.sqlite'));
  const now = vi.fn(() => new Date(stamp));
  const credentials = createCredentialStore(credentialDirectory, now);
  const session = (accountId: string, domain = 'personal', callerId = 'web') => {
    db.prepare('INSERT OR IGNORE INTO accounts VALUES (?, 1, 1, ?)').run(accountId, stamp);
    return issueCallerSession(db, { accountId, callerId, domain, permissions: ['owner'] }, now, credentials).authorization;
  };
  const owner = session('owner');
  let serviceDb: ReturnType<typeof openDatabase> | undefined;
  const runtime = integrated ? createServiceRuntime({ databasePath, credentialDirectory, now, feishuCredentials: credentials,
    feishuTestOutbound, openMain(path) { return serviceDb = openDatabase(path); },
  }) : undefined;
  const lifetime = createTaskLifetime();
  function localApp(withCredentials = true) {
    const local = new Hono();
    local.use('*', (_c, next) => runWithAuth({ db, credentials, now }, next));
    mountFeishuRoutes(local, () => ({ db, now, hub, feishuCredentials: withCredentials ? credentials : undefined, feishuTestOutbound,
      feishuOutboundLifetime: withOwner ? lifetime : undefined }));
    return local;
  }
  let app = runtime?.app ?? localApp();
  const reopenLocalRoutes = (withCredentials = true) => { app = localApp(withCredentials); };
  const request = (path: string, payload?: unknown, authorization = owner, requestOrigin = origin) => app.request(origin + path, {
    method: payload === undefined ? 'GET' : 'POST', headers: { authorization, origin: requestOrigin, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const command = (path: string, id: string, payload: Json, authorization = owner, requestOrigin = origin) => request(path, {
    client_request_id: id, expected_revision: null, payload_hash: hash(canonicalPayload(payload)), payload,
  }, authorization, requestOrigin);
  const prepare = async () => {
    const prefix = '/api/v1/channels/feishu';
    const credential = await request(`${prefix}/credentials`, { app_id: 'cli_fixture', app_secret: 'fixture-local-only' });
    expect(credential.status).toBe(200);
    await credential.text();
    // Model a connection admitted by a supervised transport, entirely in the local fixture.
    db.prepare("UPDATE channel_connections SET tenant_key='tenant_fixture', reason_code=NULL").run();
    const pairing = await command(`${prefix}/bindings`, 'pair', {});
    const { receipt_url: pairingUrl } = await pairing.json() as { receipt_url: string };
    db.prepare("UPDATE channel_pairings SET status='candidate',candidate_open_id='ou_fixture',candidate_chat_id='oc_fixture'").run();
    const confirmed = await command(`${pairingUrl}/confirm`, 'confirm-pair', {});
    expect(confirmed.status).toBe(202);
    await confirmed.text();
    const response = await command(tests, 'preview', { destination: 'ou_fixture' });
    expect(response.status).toBe(202);
    const { receipt_url: url } = await response.json() as { receipt_url: string };
    const { data: { test_id, preview_hash, destination } } = await (await request(url)).json() as { data: {
      test_id: string; preview_hash: string; destination: string;
    } };
    return { url, payload: { test_id, preview_hash, destination } };
  };
  return { db, runtime, serviceDb, lifetime, now, credentials, session, request, command, prepare, reopenLocalRoutes, dispose: async () => {
    lifetime.stop();
    await lifetime.join();
    await runtime?.drain();
    hub.close(); db.close(); rmSync(root, { recursive: true, force: true });
  } };
}

test('closed recovery refuses credential bootstrap before storing credentials or a connection', async () => {
  const f = fixture();
  try {
    const put = vi.spyOn(f.credentials, 'put');
    createRecoveryRuntimeGate(f.db);
    const response = await f.request('/api/v1/channels/feishu/credentials', {
      app_id: 'cli_fixture', app_secret: 'synthetic-recovery-bootstrap',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ params: { reason: 'recovery_write_blocked' } });
    expect(put).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM channel_connections').get()).toEqual({ count: 0 });
  } finally { await f.dispose(); }
});

test('the public notification test contract accepts exactly the T10 confirmed preview', () => {
  const payload = { test_id: 'test_fixture', preview_hash: hash(sample), destination: 'ou_fixture' };
  const envelope = { client_request_id: 'send', expected_revision: null, payload_hash: hash(canonicalPayload(payload)), payload };
  const canonical = routes.find(({ operationId }) => operationId === 'sendFeishuTest')!;
  const notification = routes.find(({ operationId }) => operationId === 'testNotification')!;
  expect(canonical.request.safeParse(envelope).success).toBe(true);
  expect(notification.request.safeParse(envelope).success).toBe(true);
  expect(notification.request.safeParse({ ...envelope, payload: { destination: 'ou_fixture', intent: 'unapproved' } }).success).toBe(false);
});

test('the service app admits an explicitly supplied T10 provider through the notification alias', async () => {
  const sendTest = vi.fn<FeishuTestOutbound['sendTest']>(async () => ({ state: 'sent', message_id: 'om_app_fixture' }));
  const f = fixture({ sendTest }, true);
  try {
    const { url, payload } = await f.prepare();
    expect((await f.command(alias, 'send', payload)).status).toBe(202);
    expect(sendTest).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ...payload, message: sample }), expect.any(AbortSignal), expect.any(Function));
    expect(await (await f.request(url)).json()).toMatchObject({ data: { status: 'sent', message_id: 'om_app_fixture' } });
  } finally { await f.dispose(); }
});

test('outbound T10 opt-in requires durable intent storage and an explicitly admitted credential provider', () => {
  const feishuTestOutbound = { sendTest: vi.fn<FeishuTestOutbound['sendTest']>() };
  expect(() => createApp({ feishuTestOutbound })).toThrow('FEISHU_TEST_DATABASE_REQUIRED');
  expect(() => createApp({ databasePath: join(tmpdir(), 'unused-t20-fixture.sqlite'), feishuTestOutbound }))
    .toThrow('FEISHU_TEST_CREDENTIAL_PROVIDER_REQUIRED');
});

test('the notification test alias and T10 report the same unconfigured provider without claiming a send', async () => {
  const f = fixture();
  try {
    const { url, payload } = await f.prepare();
    for (const path of [alias, `${url}/send`]) {
      const response = await f.command(path, 'send', payload);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ params: { reason: 'transport_not_configured' } });
    }
    expect(await (await f.request(url)).json()).toMatchObject({ data: { status: 'previewed', message_id: null } });
    expect(await (await f.request('/api/v1/channels/feishu/bindings/current')).json()).toMatchObject({
      data: { transport_available: false },
    });
  } finally { await f.dispose(); }
});

test('an admitted T20 test sends the fixed T10 preview once and replays the original receipt through either route', async () => {
  const sendTest = vi.fn<FeishuTestOutbound['sendTest']>(async () => ({ state: 'sent', message_id: 'om_fixture' }));
  const f = fixture({ sendTest });
  try {
    const { url, payload } = await f.prepare();
    expect(sendTest).not.toHaveBeenCalled();
    expect(await (await f.request('/api/v1/channels/feishu/bindings/current')).json()).toMatchObject({
      data: { transport_available: true },
    });
    const sent = await f.command(alias, 'send', payload);
    expect(sent.status).toBe(202);
    const receipt = await sent.json();
    expect(receipt).toMatchObject({ receipt_url: url, state: 'received' });
    const replay = await f.command(`${url}/send`, 'send', payload);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(receipt);
    expect(sendTest).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      ...payload, message: sample, account_id: 'owner', data_domain: 'personal', app_id: 'cli_fixture', tenant_key: 'tenant_fixture',
      credential_version: 1, config_revision: 1, binding_revision: 2, incarnation: 1, epoch: 1,
    }), expect.any(AbortSignal), expect.any(Function));
    expect(await (await f.request(url)).json()).toMatchObject({
      data: { status: 'sent', message_id: 'om_fixture', inbound_evidence: null },
    });
    expect(await (await f.request('/api/v1/channels/feishu')).json()).toMatchObject({
      data: { status: 'needs_test', transport_mode: 'probe' },
    });
  } finally { await f.dispose(); }
});

test('the alias never sends for stale binding, changed preview, or a different principal', async () => {
  const sendTest = vi.fn<FeishuTestOutbound['sendTest']>();
  const f = fixture({ sendTest });
  try {
    const { url, payload } = await f.prepare();
    expect((await f.command(alias, 'changed-destination', { ...payload, destination: 'ou_other' })).status).toBe(409);
    expect((await f.command(alias, 'changed-content', { ...payload, preview_hash: hash('unapproved text') })).status).toBe(409);
    expect((await f.command(alias, 'other-account', payload, f.session('another-owner'))).status).toBe(409);
    expect((await f.command(alias, 'origin', payload, undefined, 'https://other.invalid')).status).toBe(403);
    f.db.prepare('UPDATE channel_connections SET connection_epoch = connection_epoch + 1').run();
    expect((await f.command(alias, 'stale', payload)).status).toBe(409);
    expect(await (await f.request(url)).json()).toMatchObject({ data: { status: 'previewed' } });
    expect(sendTest).not.toHaveBeenCalled();
  } finally { await f.dispose(); }
});

test('a concurrent replay and an uncertain provider outcome cannot send a replacement', async () => {
  let rejectResult!: (reason: Error) => void;
  const result = new Promise<Awaited<ReturnType<FeishuTestOutbound['sendTest']>>>((_resolve, reject) => { rejectResult = reject; });
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const sendTest = vi.fn<FeishuTestOutbound['sendTest']>(() => { resolveStarted(); return result; });
  const f = fixture({ sendTest });
  try {
    const { url, payload } = await f.prepare();
    const original = f.command(`${url}/send`, 'send-in-flight', payload);
    await started;
    expect(await (await f.request(url)).json()).toMatchObject({ data: { status: 'sending', message_id: null } });
    const replay = await f.command(alias, 'send-in-flight', payload);
    expect(replay.status).toBe(202);
    expect((await f.command(alias, 'second-command', payload)).status).toBe(409);
    rejectResult(new Error('fixture connection lost without a provider receipt'));
    const accepted = await original;
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual(await replay.json());
    expect(await (await f.request(url)).json()).toMatchObject({ data: { status: 'unknown', message_id: null, inbound_evidence: null } });
    expect((await f.command(tests, 'replacement-preview', { destination: payload.destination })).status).toBe(409);
    expect(sendTest).toHaveBeenCalledTimes(1);
  } finally { await f.dispose(); }
});

function testChannel(f: ReturnType<typeof fixture>) {
  const { connection_id } = f.db.prepare('SELECT connection_id FROM channel_connections').get() as { connection_id: string };
  return createFeishuChannel(f.db, { connectionId: connection_id, domain: 'personal', now: () => new Date(stamp),
    hub: { async accept() { throw new Error('UNEXPECTED_HUB_SEND'); }, async read() { return null; } },
    encode: () => ({ choice: 0 }) });
}

test.each(['prepareSentTest', 'configure', 'createPairing', 'receivePairingMessage', 'confirmPairing', 'createTest', 'sendTest', 'setConfigRevision', 'applyTrustedEnable'] as const)(
  'closed recovery refuses direct channel authority at %s', async (operation) => {
    const f = fixture();
    try {
      const { payload } = await f.prepare();
      const channel = testChannel(f);
      let pairing: ReturnType<typeof channel.createPairing> | undefined;
      if (operation === 'receivePairingMessage' || operation === 'confirmPairing') pairing = channel.createPairing();
      if (operation === 'confirmPairing') await channel.receivePairingMessage({ code: pairing!.code, open_id: 'new-owner', chat_id: 'new-chat' });
      if (operation === 'applyTrustedEnable') {
        channel.sendTest(payload);
        await channel.recordTestCallback({ test_id: payload.test_id, message_id: 'om_fixture', inbound_evidence: 'fixture-readback' });
      }
      const proof = channel.currentProof();
      const connection = f.db.prepare('SELECT * FROM channel_connections').get();
      createRecoveryRuntimeGate(f.db);
      const perform = () => {
        switch (operation) {
          case 'prepareSentTest': return channel.prepareSentTest();
          case 'configure': return channel.configure();
          case 'createPairing': return channel.createPairing();
          case 'receivePairingMessage': return channel.receivePairingMessage({ code: pairing!.code, open_id: 'new-owner', chat_id: 'new-chat' });
          case 'confirmPairing': return channel.confirmPairing({ account_id: 'owner', caller_id: 'web', auth_epoch: 1,
            domains: ['personal'], operations: ['owner'] }, pairing!.pairing_id);
          case 'createTest': return channel.createTest(payload.destination);
          case 'sendTest': return channel.sendTest(payload);
          case 'setConfigRevision': return channel.setConfigRevision(20);
          case 'applyTrustedEnable': return channel.applyTrustedEnable(proof);
        }
      };
      await expect((async () => { await perform(); })()).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
      expect(f.db.prepare('SELECT * FROM channel_connections').get()).toEqual(connection);
      expect(f.db.prepare('SELECT status FROM channel_tests WHERE test_id=?').get(payload.test_id)).toEqual({ status: operation === 'applyTrustedEnable' ? 'verified' : 'previewed' });
    } finally { await f.dispose(); }
  });

test('closed recovery cannot claim a Feishu test or record a command through its route', async () => {
  const sendTest = vi.fn<FeishuTestOutbound['sendTest']>(async () => ({ state: 'sent', message_id: 'should-not-send' }));
  const f = fixture({ sendTest });
  try {
    const { payload } = await f.prepare();
    const scope = f.db.prepare('SELECT connection_id,account_id,data_domain FROM channel_connections').get() as {
      connection_id: string; account_id: string; data_domain: string;
    };
    createRecoveryRuntimeGate(f.db);
    expect(() => withImmediateTransaction(f.db, () => claimFeishuOutboundTest(f.db, payload, scope, stamp))).toThrow('RECOVERY_WRITE_BLOCKED');
    const commands = f.db.prepare('SELECT COUNT(*) AS n FROM command_inbox').get();
    const response = await f.command(alias, 'recovery-denied', payload);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ params: { reason: 'recovery_write_blocked' } });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM command_inbox').get()).toEqual(commands);
    expect(sendTest).not.toHaveBeenCalled();
  } finally { await f.dispose(); }
});

test.each(['recovery', 'channel_epoch'] as const)('Feishu handoff rechecks %s after its dispatch microtask', async (change) => {
  const sendTest = vi.fn<FeishuTestOutbound['sendTest']>(async () => ({ state: 'sent', message_id: 'should-not-send' }));
  const f = fixture({ sendTest });
  try {
    const { payload } = await f.prepare();
    const scope = f.db.prepare('SELECT connection_id,account_id,data_domain FROM channel_connections').get() as {
      connection_id: string; account_id: string; data_domain: string;
    };
    const claimed = withImmediateTransaction(f.db, () => claimFeishuOutboundTest(f.db, payload, scope, stamp));
    expect(claimed).not.toBeNull();
    const dispatch = dispatchClaimedFeishuTest(f.db, { sendTest }, claimed!, () => new Date(stamp), f.lifetime);
    const check = expect(dispatch).rejects.toThrow(change === 'recovery' ? 'RECOVERY_WRITE_BLOCKED' : 'FEISHU_TEST_STALE');
    if (change === 'recovery') createRecoveryRuntimeGate(f.db);
    else f.db.prepare('UPDATE channel_connections SET connection_epoch=connection_epoch+1').run();
    await check;
    expect(sendTest).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT status FROM channel_tests WHERE test_id=?').get(payload.test_id)).toEqual({ status: 'sending' });
  } finally { await f.dispose(); }
});

test('owner disable remains available while recovery is closed', async () => {
  const f = fixture();
  try {
    await f.prepare();
    f.db.prepare("UPDATE channel_connections SET status='ready',transport_mode='active'").run();
    const channel = testChannel(f);
    createRecoveryRuntimeGate(f.db);
    await expect(channel.disableTrusted({ accountId: 'owner', configRevision: 1, epoch: 1 })).resolves.toMatchObject({ status: 'disabled' });
    expect(f.db.prepare('SELECT status,transport_mode FROM channel_connections').get()).toEqual({ status: 'disabled', transport_mode: 'disabled' });
  } finally { await f.dispose(); }
});

test('the Feishu transport guard rechecks recovery after awaited credential preparation', async () => {
  let ready!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const prepared = new Promise<void>((resolve) => { resume = resolve; });
  let sends = 0;
  const sendTest: FeishuTestOutbound['sendTest'] = async (_test, _signal, beforeSend) => {
    ready();
    await prepared;
    beforeSend();
    sends++;
    return { state: 'sent', message_id: 'should-not-send' };
  };
  const f = fixture({ sendTest });
  try {
    const { payload } = await f.prepare();
    const scope = f.db.prepare('SELECT connection_id,account_id,data_domain FROM channel_connections').get() as {
      connection_id: string; account_id: string; data_domain: string;
    };
    const claimed = withImmediateTransaction(f.db, () => claimFeishuOutboundTest(f.db, payload, scope, stamp));
    const dispatch = dispatchClaimedFeishuTest(f.db, { sendTest }, claimed!, () => new Date(stamp), f.lifetime);
    const check = expect(dispatch).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    await started;
    createRecoveryRuntimeGate(f.db);
    resume();
    await check;
    expect(sends).toBe(0);
    expect(f.db.prepare('SELECT status FROM channel_tests WHERE test_id=?').get(payload.test_id)).toEqual({ status: 'sending' });
  } finally { await f.dispose(); }
});

test('stale Feishu identity after awaited preparation returns a nonretryable conflict and retains same-key replay', async () => {
  let ready!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const prepared = new Promise<void>((resolve) => { resume = resolve; });
  let handoffs = 0;
  const sendTest = vi.fn<FeishuTestOutbound['sendTest']>(async (_test, _signal, beforeSend) => {
    ready();
    await prepared;
    beforeSend();
    handoffs++;
    return { state: 'sent', message_id: 'should-not-send' };
  });
  const f = fixture({ sendTest });
  try {
    const { payload } = await f.prepare();
    const pending = f.command(alias, 'stale-final-identity', payload);
    await started;
    const command = f.db.prepare("SELECT command_id FROM command_inbox WHERE client_request_id='stale-final-identity'").get();
    f.db.prepare('UPDATE channel_connections SET connection_epoch=connection_epoch+1').run();
    resume();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'CONFLICT', params: { reason: 'stale_test_preview' }, retryable: false });
    expect(handoffs).toBe(0);
    expect(f.db.prepare("SELECT command_id FROM command_inbox WHERE client_request_id='stale-final-identity'").get()).toEqual(command);
    const replay = await f.command(alias, 'stale-final-identity', payload);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject(command!);
    expect(sendTest).toHaveBeenCalledTimes(1);
  } finally { await f.dispose(); }
});

test.each(['resolve', 'reject'] as const)('service drain retains pending Feishu work after HTTP timeout until provider %s', async (settle) => {
  const entered = deferred<void>();
  const provider = deferred<Awaited<ReturnType<FeishuTestOutbound['sendTest']>>>();
  const sendTest = vi.fn<FeishuTestOutbound['sendTest']>(() => { entered.resolve(); return provider.promise; });
  const f = fixture({ sendTest }, true);
  try {
    const { url, payload } = await f.prepare();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const request = f.command(alias, 'pending-send', payload);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    const accepted = await request;
    expect(accepted.status).toBe(202);
    const receipt = await accepted.json();
    expect(receipt).toMatchObject({ receipt_url: url });
    expect(await (await f.request(url)).json()).toMatchObject({ data: { status: 'unknown', message_id: null } });
    expect(await (await f.command(`${url}/send`, 'pending-send', payload)).json()).toEqual(receipt);
    const [, signal, beforeSend] = sendTest.mock.calls[0];
    expect(signal.aborted).toBe(true);
    expect(beforeSend).toThrow('FEISHU_TEST_HANDOFF_CLOSED');
    const draining = f.runtime!.drain({ timeoutMs: 5 });
    await vi.advanceTimersByTimeAsync(5);
    expect(await draining).toMatchObject({ status: 'draining', active: 1 });
    expect(f.serviceDb!.prepare('SELECT 1 AS alive').get()).toEqual({ alive: 1 });
    if (settle === 'resolve') provider.resolve({ state: 'sent', message_id: 'om_late_fixture' });
    else provider.reject(new Error('fixture late failure'));
    expect(await f.runtime!.drain()).toMatchObject({ status: 'closed', active: 0, errors: [] });
    expect(f.serviceDb!.open).toBe(false);
    expect(beforeSend).toThrow('FEISHU_TEST_HANDOFF_CLOSED');
    expect(f.db.prepare('SELECT status, message_id FROM channel_tests WHERE test_id=?').get(payload.test_id))
      .toEqual({ status: 'unknown', message_id: null });
    expect(sendTest).toHaveBeenCalledTimes(1);
  } finally {
    provider.resolve({ state: 'unknown' });
    vi.useRealTimers();
    await f.dispose();
  }
});

test('service stop immediately revokes prepared Feishu handoff and joins the provider', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let handoffs = 0;
  const sendTest = vi.fn<FeishuTestOutbound['sendTest']>(async (_test, _signal, beforeSend) => {
    entered.resolve();
    await release.promise;
    beforeSend();
    handoffs++;
    return { state: 'sent', message_id: 'should-not-send' };
  });
  const f = fixture({ sendTest }, true);
  try {
    const { payload } = await f.prepare();
    const pending = f.command(alias, 'stop-preparation', payload);
    await entered.promise;
    f.runtime!.stop();
    expect(sendTest.mock.calls[0][1].aborted).toBe(true);
    const accepted = await pending;
    expect(accepted.status).toBe(202);
    await accepted.text();
    expect(f.db.prepare('SELECT status, message_id FROM channel_tests WHERE test_id=?').get(payload.test_id))
      .toEqual({ status: 'unknown', message_id: null });
    expect((await f.command(alias, 'after-stop', payload)).status).toBe(503);
    expect(await f.runtime!.drain({ timeoutMs: 0 })).toMatchObject({ status: 'draining', active: 1 });
    release.resolve();
    expect(await f.runtime!.drain()).toMatchObject({ status: 'closed', errors: [] });
    expect(handoffs).toBe(0);
    expect(sendTest).toHaveBeenCalledTimes(1);
  } finally { release.resolve(); await f.dispose(); }
});

test.each(['missing', 'stopped'] as const)('standalone Feishu route requires an active owner before claim (%s)', async (owner) => {
  const sendTest = vi.fn<FeishuTestOutbound['sendTest']>();
  const f = fixture({ sendTest }, false, owner !== 'missing');
  try {
    const { url, payload } = await f.prepare();
    if (owner === 'stopped') f.lifetime.stop();
    const response = await f.command(alias, 'unavailable', payload);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ params: { reason: owner === 'missing' ? 'transport_not_configured' : 'service_stopping' } });
    expect(await (await f.request(url)).json()).toMatchObject({ data: { status: 'previewed' } });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM command_inbox WHERE client_request_id='unavailable'").get()).toEqual({ n: 0 });
    expect(sendTest).not.toHaveBeenCalled();
  } finally { await f.dispose(); }
});

test('stop between Feishu registration and the starter denies both queued and later handoffs', async () => {
  const sendTest = vi.fn<FeishuTestOutbound['sendTest']>();
  const f = fixture({ sendTest });
  try {
    const { payload } = await f.prepare();
    const scope = f.db.prepare('SELECT connection_id,account_id,data_domain FROM channel_connections').get() as {
      connection_id: string; account_id: string; data_domain: string;
    };
    const claimed = withImmediateTransaction(f.db, () => claimFeishuOutboundTest(f.db, payload, scope, stamp));
    const dispatch = () => dispatchClaimedFeishuTest(f.db, { sendTest }, claimed!, () => new Date(stamp), f.lifetime);
    const queued = dispatch();
    expect(f.lifetime.active).toBe(1);
    f.lifetime.stop();
    await expect(dispatch()).rejects.toThrow('FEISHU_TEST_HANDOFF_CLOSED');
    await Promise.all([queued, f.lifetime.join()]);
    expect(f.db.prepare('SELECT status FROM channel_tests WHERE test_id=?').get(payload.test_id)).toEqual({ status: 'unknown' });
    expect(sendTest).not.toHaveBeenCalled();
  } finally { await f.dispose(); }
});

test.each(['throw', 'invalid receipt', 'sent'] as const)('Feishu %s closes the saved handoff and records one bounded outcome', async (outcome) => {
  const sendTest = vi.fn<FeishuTestOutbound['sendTest']>((_test, _signal, beforeSend) => {
    beforeSend();
    if (outcome === 'throw') throw new Error('fixture synchronous failure');
    return Promise.resolve({ state: 'sent', message_id: outcome === 'sent' ? 'om_fixture' : 'invalid message id' });
  });
  const f = fixture({ sendTest });
  try {
    const { url, payload } = await f.prepare();
    const request = await f.command(alias, 'bounded-result', payload);
    expect(request.status).toBe(202);
    expect(await request.json()).toMatchObject({ receipt_url: url });
    expect(await (await f.request(url)).json()).toMatchObject({ data: outcome === 'sent'
      ? { status: 'sent', message_id: 'om_fixture' } : { status: 'unknown', message_id: null } });
    expect(sendTest.mock.calls[0][2]).toThrow('FEISHU_TEST_HANDOFF_CLOSED');
    await f.lifetime.join();
    expect(f.lifetime.errors).toEqual([]);
  } finally { await f.dispose(); }
});

test('a stop during canonical command creation rolls back the Feishu claim before handoff', async () => {
  const sendTest = vi.fn<FeishuTestOutbound['sendTest']>();
  const f = fixture({ sendTest });
  try {
    const { url, payload } = await f.prepare();
    const command = f.db.prepare("SELECT command_id FROM command_inbox WHERE client_request_id='stop-during-claim'");
    f.now.mockImplementation(() => {
      if (f.db.inTransaction && command.get()) f.lifetime.stop();
      return new Date(stamp);
    });
    const response = await f.command(alias, 'stop-during-claim', payload);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ params: { reason: 'service_stopping' } });
    expect(command.get()).toBeUndefined();
    expect(await (await f.request(url)).json()).toMatchObject({ data: { status: 'previewed' } });
    expect(sendTest).not.toHaveBeenCalled();
  } finally { await f.dispose(); }
});

const bindings = '/api/v1/channels/feishu/bindings';
async function syntheticCandidate(f: ReturnType<typeof fixture>) {
  expect((await f.request('/api/v1/channels/feishu/credentials', { app_id: 'cli_fixture', app_secret: 'synthetic-local-test-value' })).status).toBe(200);
  f.db.prepare("UPDATE channel_connections SET tenant_key='tenant_fixture',reason_code=NULL").run();
  const first = await (await f.command(bindings, 'initial', {})).json();
  const old = String(first.receipt_url).split('/').pop()!;
  f.db.prepare("UPDATE channel_pairings SET status='candidate',candidate_open_id='ou_fixture',candidate_chat_id='oc_fixture'").run();
  return { first, old };
}

test('rejecting a synthetic candidate renews once and preserves the one-read receipt', async () => {
  const f = fixture();
  try {
    const { first, old } = await syntheticCandidate(f);
    const reject = (key: string, id = old) => f.command(bindings + '/reject', key, { pairing_id: id });
    const response = await reject('renew');
    expect(response.status).toBe(202);
    const receipt = await response.json();
    expect(receipt.receipt_url).not.toBe(first.receipt_url);
    const locked: boolean[] = [];
    f.db.function('observe_receipt_lookup', () => { locked.push(f.db.inTransaction); return 1; });
    f.db.exec('CREATE TEMP VIEW command_inbox AS SELECT * FROM main.command_inbox WHERE observe_receipt_lookup()');
    expect(await (await reject('renew')).json()).toEqual(receipt);
    expect(locked).toEqual([true]);
    f.db.exec('DROP VIEW temp.command_inbox');
    expect((await reject('renew', 'pair_ffffffffffffffff')).status).toBe(409);
    expect((await reject('stale')).status).toBe(409);
    expect((await f.command(first.receipt_url + '/confirm', 'old-confirm', {})).status).toBe(409);
    expect((await (await f.request(bindings + '/current')).json()).data.code).toBeNull();
    const reader = issueCallerSession(f.db, { accountId: 'owner', callerId: 'viewer', domain: 'personal', permissions: ['channels.read'] }, f.now, f.credentials).authorization;
    expect((await (await f.request(receipt.receipt_url, undefined, reader)).json()).data.code).toBeNull();
    f.db.prepare("UPDATE caller_scopes SET revoked_at=? WHERE account_id='owner' AND caller_id='web' AND data_domain='personal'").run(stamp);
    expect((await f.request(receipt.receipt_url, undefined, f.session('owner', 'work'))).status).toBe(404);
    f.session('owner');
    expect((await f.command(bindings, 'renew', {})).status).toBe(409);
    expect((await (await f.request(receipt.receipt_url)).json()).data.code).toMatch(/^[A-Za-z0-9_-]{24}$/u);
    expect(await (await reject('renew')).json()).toEqual(receipt);
    expect((await (await f.request(receipt.receipt_url)).json()).data.code).toBeNull();
    expect(f.db.prepare('SELECT status FROM channel_pairings ORDER BY rowid').pluck().all()).toEqual(['expired', 'open']);
    expect(f.db.prepare('SELECT count(*) FROM channel_bindings').pluck().get()).toBe(0);
    expect(f.db.prepare('SELECT count(*) FROM channel_tests').pluck().get()).toBe(0);
  } finally { await f.dispose(); }
});

test.each([
  ['expiry', "UPDATE channel_pairings SET expires_at='2020-01-01T00:00:00Z'"],
  ['snapshot', 'UPDATE channel_connections SET connection_epoch=connection_epoch+1'],
  ['binding revision', 'UPDATE channel_pairings SET binding_revision=0'],
  ['probe', "UPDATE channel_connections SET reason_code='NATIVE_PROBE_REQUIRED'"],
  ['consumption', "UPDATE channel_pairings SET consumed_at='2026-01-01T00:00:00Z'"],
  ['recovery', ''],
  ['record rollback', "CREATE TRIGGER fail_receipt BEFORE INSERT ON command_records BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END"],
])('reject fails closed for %s', async (reason, setup) => {
  const f = fixture();
  try {
    const { old } = await syntheticCandidate(f);
    if (setup) f.db.exec(setup);
    else createRecoveryRuntimeGate(f.db);
    const response = await f.command(bindings + '/reject', 'rejected', { pairing_id: old });
    expect(response.status).toBe(reason === 'record rollback' ? 503 : 409);
    expect(f.db.prepare('SELECT pairing_id,status FROM channel_pairings').all()).toEqual([{ pairing_id: old, status: 'candidate' }]);
    expect(f.db.prepare('SELECT current_pairing_id FROM channel_connections').pluck().get()).toBe(old);
    expect(f.db.prepare("SELECT count(*) FROM command_inbox WHERE client_request_id='rejected'").pluck().get()).toBe(0);
    expect(f.db.prepare("SELECT count(*) FROM command_records WHERE operation='rejectFeishuBinding'").pluck().get()).toBe(0);
  } finally { await f.dispose(); }
});

test('rejection requires scoped HTTPS web owner and a concrete selection', async () => {
  const f = fixture();
  try {
    const { old } = await syntheticCandidate(f);
    const path = bindings + '/reject', payload = { pairing_id: old };
    expect((await f.command(path, 'other', payload, f.session('other'))).ok).toBe(false);
    f.db.prepare("UPDATE caller_scopes SET revoked_at=? WHERE account_id='owner' AND caller_id='web' AND data_domain='personal'").run(stamp);
    expect((await f.command(path, 'domain', payload, f.session('owner', 'work'))).ok).toBe(false);
    const reader = issueCallerSession(f.db, { accountId: 'owner', callerId: 'web', domain: 'personal', permissions: ['channels.read'] }, f.now, f.credentials).authorization;
    f.db.prepare("UPDATE caller_scopes SET revoked_at=? WHERE account_id='owner' AND data_domain='work'").run(stamp);
    expect((await f.command(path, 'read-only', payload, reader)).status).toBe(403);
    f.session('owner');
    expect((await f.command(path, 'caller', payload, f.session('owner', 'personal', 'cli'))).status).toBe(403);
    expect((await f.command(path, 'origin', payload, undefined, 'http://localhost')).ok).toBe(false);
    expect((await f.command(path, 'alias', { pairing_id: 'current' })).status).toBe(422);
    expect((await f.command(path, 'extra', { ...payload, extra: true })).status).toBe(422);
    expect(f.db.prepare('SELECT status FROM channel_pairings').pluck().all()).toEqual(['candidate']);
  } finally { await f.dispose(); }
});

test('publishing an older committed code leaves the current process-local code intact', async () => {
  const f = fixture();
  try {
    const { old } = await syntheticCandidate(f);
    await f.command(bindings + '/reject', 'renew', { pairing_id: old });
    const current = f.db.prepare('SELECT connection_id,current_pairing_id FROM channel_connections').get() as { connection_id: string; current_pairing_id: string };
    const entry = { connection_id: current.connection_id, expires_at: '2026-11-17T07:00:00.000Z', code: 'current-code', pairing_id: current.current_pairing_id };
    const codes = new Map([[entry.pairing_id, entry]]);
    publishPairingCode(f, codes, { ...entry, code: 'old-code', pairing_id: old });
    expect([...codes.entries()]).toEqual([[entry.pairing_id, entry]]);
  } finally { await f.dispose(); }
});

test('replay and stale selection preserve a later code after another renewal', async () => {
  const f = fixture();
  try {
    const { old } = await syntheticCandidate(f);
    const reject = (key: string, id: string) => f.command(bindings + '/reject', key, { pairing_id: id });
    const first = await (await reject('renew', old)).json();
    const next = String(first.receipt_url).split('/').pop()!;
    f.db.prepare("UPDATE channel_pairings SET status='candidate',candidate_open_id='ou_second',candidate_chat_id='oc_second' WHERE pairing_id=?").run(next);
    const latest = await (await reject('renew-later', next)).json();
    expect(await (await reject('renew', old)).json()).toEqual(first);
    expect((await reject('fresh-stale', old)).status).toBe(409);
    expect((await (await f.request(first.receipt_url)).json()).data.code).toBeNull();
    expect((await (await f.request(latest.receipt_url)).json()).data.code).toMatch(/^[A-Za-z0-9_-]{24}$/u);
  } finally { await f.dispose(); }
});

test.each(['expired', 'reopened'])('replay cannot regenerate a %s replacement code', async condition => {
  const f = fixture();
  try {
    const { old } = await syntheticCandidate(f);
    f.reopenLocalRoutes(false);
    const state = (await (await f.request(bindings + '/current')).json()).data;
    expect(state).toMatchObject({ credential_setup_available: false, pairing_start_available: true, reject_pairing_available: true });
    const wrongOrigin = (await (await f.request(bindings + '/current', undefined, undefined, 'http://localhost')).json()).data;
    expect(wrongOrigin).toMatchObject({ credential_setup_available: false, pairing_start_available: false, reject_pairing_available: false });
    const denied = await f.command(bindings, 'wrong-origin-start', {}, undefined, 'http://localhost');
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ params: { reason: 'tls_required' } });
    expect((await f.request('/api/v1/channels/feishu/credentials', { app_id: 'cli_fixture', app_secret: 'synthetic-secret' })).status).toBe(503);
    const renew = () => f.command(bindings + '/reject', 'renew', { pairing_id: old });
    const receipt = await (await renew()).json();
    if (condition === 'expired') f.db.prepare("UPDATE channel_pairings SET expires_at=? WHERE status='open'").run(stamp);
    else f.reopenLocalRoutes(false);
    expect(await (await renew()).json()).toEqual(receipt);
    expect((await (await f.request(receipt.receipt_url)).json()).data.code).toBeNull();
    expect(f.db.prepare('SELECT count(*) FROM channel_pairings').pluck().get()).toBe(2);
  } finally { await f.dispose(); }
});
