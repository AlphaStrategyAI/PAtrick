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
import { createApp } from '../../apps/service/src/app.js';
import { issueCallerSession, runWithAuth } from '../../apps/service/src/auth.js';
import { mountFeishuRoutes } from '../../apps/service/src/routes/feishu.js';
import { claimFeishuOutboundTest, dispatchClaimedFeishuTest, type FeishuTestOutbound } from '../../packages/integrations/feishu/outbound.js';
import { createFeishuChannel } from '../../packages/integrations/feishu/connection.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const origin = 'https://localhost';
const tests = '/api/v1/channels/feishu/tests';
const alias = '/api/v1/notifications/test';
const stamp = '2026-11-17T06:00:00.000Z';
const sample = 'PAtrick 连接测试，不含业务资料。';

function fixture(feishuTestOutbound?: FeishuTestOutbound, integrated = false) {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t20-test-'));
  const databasePath = join(root, 'local.sqlite');
  const credentialDirectory = join(root, 'credentials');
  const db = openDatabase(databasePath);
  const hub = createLocalHubPort(join(root, 'hub.sqlite'));
  const now = () => new Date(stamp);
  const credentials = createCredentialStore(credentialDirectory, now);
  const session = (accountId: string, domain = 'personal', callerId = 'web') => {
    db.prepare('INSERT OR IGNORE INTO accounts VALUES (?, 1, 1, ?)').run(accountId, stamp);
    return issueCallerSession(db, { accountId, callerId, domain, permissions: ['owner'] }, now, credentials).authorization;
  };
  const owner = session('owner');
  const app = integrated ? createApp({ databasePath, credentialDirectory, now, feishuCredentials: credentials, feishuTestOutbound }) : new Hono();
  if (!integrated) {
    app.use('*', (_c, next) => runWithAuth({ db, credentials, now }, next));
    mountFeishuRoutes(app, () => ({ db, now, hub, feishuCredentials: credentials, feishuTestOutbound }));
  }

  const request = (path: string, payload?: unknown, authorization = owner, requestOrigin = origin) => app.request(origin + path, {
    method: payload === undefined ? 'GET' : 'POST', headers: { authorization, origin: requestOrigin, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const command = (path: string, id: string, payload: Json, authorization = owner, requestOrigin = origin) => request(path, {
    client_request_id: id, expected_revision: null, payload_hash: hash(canonicalPayload(payload)), payload,
  }, authorization, requestOrigin);
  const prepare = async () => {
    const prefix = '/api/v1/channels/feishu';
    expect((await request(`${prefix}/credentials`, { app_id: 'cli_fixture', app_secret: 'fixture-local-only' })).status).toBe(200);
    // Model a connection admitted by a supervised transport, entirely in the local fixture.
    db.prepare("UPDATE channel_connections SET tenant_key='tenant_fixture', reason_code=NULL").run();
    const pairing = await command(`${prefix}/bindings`, 'pair', {});
    const { receipt_url: pairingUrl } = await pairing.json() as { receipt_url: string };
    db.prepare("UPDATE channel_pairings SET status='candidate',candidate_open_id='ou_fixture',candidate_chat_id='oc_fixture'").run();
    expect((await command(`${pairingUrl}/confirm`, 'confirm-pair', {})).status).toBe(202);
    const response = await command(tests, 'preview', { destination: 'ou_fixture' });
    expect(response.status).toBe(202);
    const { receipt_url: url } = await response.json() as { receipt_url: string };
    const { data: { test_id, preview_hash, destination } } = await (await request(url)).json() as { data: {
      test_id: string; preview_hash: string; destination: string;
    } };
    return { url, payload: { test_id, preview_hash, destination } };
  };
  return { db, credentials, session, request, command, prepare, dispose: () => {
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
  } finally { f.dispose(); }
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
  } finally { f.dispose(); }
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
  } finally { f.dispose(); }
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
  } finally { f.dispose(); }
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
  } finally { f.dispose(); }
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
  } finally { f.dispose(); }
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
    } finally { f.dispose(); }
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
  } finally { f.dispose(); }
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
    const dispatch = dispatchClaimedFeishuTest(f.db, { sendTest }, claimed!, () => new Date(stamp));
    const check = expect(dispatch).rejects.toThrow(change === 'recovery' ? 'RECOVERY_WRITE_BLOCKED' : 'FEISHU_TEST_STALE');
    if (change === 'recovery') createRecoveryRuntimeGate(f.db);
    else f.db.prepare('UPDATE channel_connections SET connection_epoch=connection_epoch+1').run();
    await check;
    expect(sendTest).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT status FROM channel_tests WHERE test_id=?').get(payload.test_id)).toEqual({ status: 'sending' });
  } finally { f.dispose(); }
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
  } finally { f.dispose(); }
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
    const dispatch = dispatchClaimedFeishuTest(f.db, { sendTest }, claimed!, () => new Date(stamp));
    const check = expect(dispatch).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    await started;
    createRecoveryRuntimeGate(f.db);
    resume();
    await check;
    expect(sends).toBe(0);
    expect(f.db.prepare('SELECT status FROM channel_tests WHERE test_id=?').get(payload.test_id)).toEqual({ status: 'sending' });
  } finally { f.dispose(); }
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
  } finally { f.dispose(); }
});
