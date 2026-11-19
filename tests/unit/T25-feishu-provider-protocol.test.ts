import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { attemptFeishuConnectionTest } from '../../packages/integrations/feishu/provider-protocol.js';

type Attempt = Parameters<typeof attemptFeishuConnectionTest>[0];
type Transport = Parameters<typeof attemptFeishuConnectionTest>[1];
type Reply = Awaited<ReturnType<Transport>>;
const oauth = 'https://accounts.feishu.cn/oauth/v3/token';
const message = 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id';
// Minimal success shapes from the 2026-11-19 Feishu OAuth and create-message documentation snapshot.
const token = { code: 0, token_type: 'Bearer', access_token: 'fixture.bearer', expires_in: 60 };
const receipt = { code: 0, data: { message_id: 'om_fixture' } };
const unknown = { state: 'unknown' };
const sent = { state: 'sent', message_id: 'om_fixture' };
function input() {
  return {
    appId: 'cli_fixture', secret: Buffer.from('fixture secret'), openId: 'ou_fixture',
    chatId: 'oc_fixture', tenantKey: 'tenant_fixture', testId: 'test_123456789abc',
    signal: new AbortController().signal, authorizeOAuth: () => true, authorizeMessage: () => true,
  } satisfies Attempt;
}
function json(value: unknown, status = 200): Reply {
  return { status, headers: [['content-type', 'application/json; charset=utf-8']], body: Buffer.from(JSON.stringify(value)) };
}
function fixture(first = json(token), second = json(receipt)) {
  const handoffs: string[] = [];
  const transport = vi.fn<Transport>(async (url, take) => {
    if (take(url)) handoffs.push(url);
    return url === oauth ? first : second;
  });
  return { transport, handoffs };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { vi.useRealTimers(); });

test('hands off exactly two fixed POSTs, keeps the bearer on the message endpoint and matches the T10 preview', async () => {
  const requests: unknown[] = [];
  let hash: string | undefined;
  const attempt = input();
  const result = await attemptFeishuConnectionTest(attempt, async (url, take) => {
    const request = take(url);
    if (request) {
      const body = JSON.parse(Buffer.from(request.body).toString('utf8'));
      requests.push({ url, method: request.method, headers: request.headers, body });
      if (body.content) hash = createHash('sha256').update(JSON.parse(body.content).text).digest('hex');
    }
    return url === oauth ? json(token) : json(receipt);
  });
  const baseHeaders = { 'content-type': 'application/json', 'accept-encoding': 'identity' };
  expect(requests).toEqual([
    { url: oauth, method: 'POST', headers: baseHeaders, body: {
      grant_type: 'client_credentials', client_id: attempt.appId, client_secret: 'fixture secret',
    } },
    { url: message, method: 'POST', headers: { ...baseHeaders, authorization: 'Bearer fixture.bearer' }, body: {
      receive_id: attempt.openId, msg_type: 'text', content: JSON.stringify({ text: 'PAtrick 连接测试，不含业务资料。' }), uuid: attempt.testId,
    } },
  ]);
  expect(hash).toBe('4d193473189df867b365ad7eaf7b802c659718d80b8f90e5b3ca6d5d16ecdb10');
  expect(result).toEqual(sent);
});

test.each([
  ['non-200', json(token, 201)], ['redirect', json(token, 307)], ['error code', json({ ...token, code: 1 })],
  ['string code', json({ ...token, code: '0' })], ['missing token', json({ code: 0 })],
  ['blank', json({ ...token, access_token: ' ' })], ['oversized', json({ ...token, access_token: 't'.repeat(32769) })],
  ['bad type', json({ ...token, token_type: 'Other' })], ['expired', json({ ...token, expires_in: 0 })],
  ['fractional TTL', json({ ...token, expires_in: 1.5 })], ['string TTL', json({ ...token, expires_in: '60' })],
  ['array', json([token])], ['invalid scope type', json({ ...token, scope: [] })],
] as const)('ends after OAuth for %s', async (_name, first) => {
  const { transport, handoffs } = fixture(first);
  expect(await attemptFeishuConnectionTest(input(), transport)).toEqual(unknown);
  expect(handoffs).toEqual([oauth]);
  expect(transport).toHaveBeenCalledTimes(1);
});

test.each([
  ['redirect', json(receipt, 302)], ['unauthorized', json(receipt, 401)], ['limited', json(receipt, 429)],
  ['server failure', json(receipt, 503)], ['wrong code type', json({ ...receipt, code: '0' })],
  ['empty ID', json({ code: 0, data: { message_id: '' } })], ['missing ID', json({ code: 0, data: {} })],
  ['long ID', json({ code: 0, data: { message_id: 'm'.repeat(201) } })],
  ['different chat', json({ code: 0, data: { ...receipt.data, chat_id: 'oc_other' } })],
  ['different tenant', json({ code: 0, data: { ...receipt.data, sender: { tenant_key: 'other' } } })],
  ['partial JSON', { ...json(receipt), body: Buffer.from('{"code":0') }],
  ['invalid UTF-8', { ...json(receipt), body: Buffer.from([255]) }],
  ['non-JSON media', { ...json(receipt), headers: [['content-type', 'text/plain']] }],
  ['compressed', { ...json(receipt), headers: [['content-type', 'application/json'], ['content-encoding', 'gzip']] }],
  ['oversized body', { ...json(receipt), body: Buffer.alloc(65537, 32) }],
  ['oversized headers', { ...json(receipt), headers: [['content-type', 'application/json'], ['x-fixture', 'a'.repeat(16384)]] }],
] as const)('keeps %s unknown after one message submission', async (_name, second) => {
  const { transport, handoffs } = fixture(json(token), second);
  expect(await attemptFeishuConnectionTest(input(), transport)).toEqual(unknown);
  expect(handoffs).toEqual([oauth, message]);
  expect(transport).toHaveBeenCalledTimes(2);
});

test('accepts a 32 KiB bearer and consistent response identities', async () => {
  const { transport, handoffs } = fixture(json({ ...token, access_token: 't'.repeat(32768), scope: 'im:message' }),
    json({ code: 0, data: { ...receipt.data, chat_id: 'oc_fixture', sender: { tenant_key: 'tenant_fixture' } } }));
  expect(await attemptFeishuConnectionTest(input(), transport)).toEqual(sent);
  expect(handoffs).toEqual([oauth, message]);
});

test.each([
  ['matching', { sender_type: 'app', id_type: 'app_id', id: 'cli_fixture' }, sent],
  ['conflicting', { id_type: 'app_id', id: 'cli_other' }, unknown],
  ['user sender', { sender_type: 'user', id_type: 'open_id', id: 'ou_fixture' }, unknown],
  ['other ID type', { sender_type: 'app', id_type: 'open_id', id: 'ou_fixture' }, sent],
  ['absent ID', { id_type: 'app_id' }, sent],
  ['absent ID type', { id: 'ordinary_sender' }, sent],
] as const)('checks the optional sender app identity when %s', async (_name, sender, expected) => {
  const { transport, handoffs } = fixture(json(token), json({ code: 0, data: { ...receipt.data, sender } }));
  expect(await attemptFeishuConnectionTest(input(), transport)).toEqual(expected);
  expect(handoffs).toEqual([oauth, message]);
});

test.each([
  { testId: 'wrong' }, { openId: '' }, { tenantKey: ' ' }, { chatId: 'x'.repeat(801) },
  { appId: 'a'.repeat(201) }, { secret: Buffer.alloc(4097) }, { secret: Buffer.from([0xff]) },
])('rejects invalid enrollment inputs before transport', async (changes) => {
  const { transport } = fixture();
  expect(await attemptFeishuConnectionTest({ ...input(), ...changes }, transport)).toEqual(unknown);
  expect(transport).not.toHaveBeenCalled();
});

test.each([oauth, message])('requires the stage gate for %s, once and only for its fixed target', async (stage) => {
  for (const mode of ['no gate', 'duplicate', 'other target']) {
    const grants: boolean[] = [];
    const urls: string[] = [];
    const result = await attemptFeishuConnectionTest(input(), async (url, take) => {
      urls.push(url);
      if (url !== stage) take(url);
      else if (mode === 'duplicate') grants.push(Boolean(take(url)), Boolean(take(url)));
      else if (mode === 'other target') grants.push(Boolean(take(url === oauth ? message : oauth)));
      return url === oauth ? json(token) : json(receipt);
    });
    expect(result).toEqual(unknown);
    expect(urls).toEqual(stage === oauth ? [oauth] : [oauth, message]);
    expect(grants).toEqual(mode === 'duplicate' ? [true, false] : mode === 'other target' ? [false] : []);
  }
});

test.each(['authorizeOAuth', 'authorizeMessage'] as const)('requires literal synchronous approval from %s', async (key) => {
  for (const authorize of [undefined, () => false, () => Promise.resolve(true),
    () => Promise.reject(new Error('fixture rejection')), () => { throw new Error('fixture rejection'); }]) {
    const { transport, handoffs } = fixture();
    expect(await attemptFeishuConnectionTest({ ...input(), [key]: authorize }, transport)).toEqual(unknown);
    expect(handoffs).toEqual(key === 'authorizeMessage' && authorize !== undefined ? [oauth] : []);
  }
});

test('snapshots identity, authorization callbacks and secret before asynchronous preparation', async () => {
  const attempt = input();
  const ready = deferred();
  const observed: unknown[] = [];
  const attemptResult = attemptFeishuConnectionTest(attempt, async (url, take) => {
    await ready.promise;
    const request = take(url);
    if (request) observed.push(JSON.parse(Buffer.from(request.body).toString('utf8')));
    return url === oauth ? json(token) : json({ ...receipt, data: { ...receipt.data, chat_id: 'oc_fixture' } });
  });
  Object.assign(attempt, { openId: 'ou_replaced', chatId: 'oc_replaced', authorizeMessage: () => false });
  attempt.secret.fill(0);
  ready.resolve();
  expect(await attemptResult).toEqual(sent);
  expect(observed).toMatchObject([{ client_secret: 'fixture secret' }, { receive_id: 'ou_fixture' }]);
});

test('counts OAuth time toward token expiry and rechecks after message preparation', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  const preparing = deferred();
  const release = deferred();
  const granted: boolean[] = [];
  const result = attemptFeishuConnectionTest(input(), async (url, take) => {
    if (url === oauth) {
      granted.push(Boolean(take(url)));
      vi.advanceTimersByTime(700);
      return json({ ...token, expires_in: 1 });
    }
    preparing.resolve();
    await release.promise;
    granted.push(Boolean(take(url)));
    return json(receipt);
  });
  await preparing.promise;
  vi.advanceTimersByTime(300);
  release.resolve();
  expect(await result).toEqual(unknown);
  expect(granted).toEqual([true, false]);
});

test.each(['stop before OAuth', 'stop before message', 'deadline before message', 'deadline after message'])(
  'waits for modeled resource release on %s and discards any late success', async (scenario) => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    const stop = new AbortController();
    const preparing = deferred();
    const release = deferred();
    const gated: boolean[] = [];
    const urls: string[] = [];
    let released = false;
    let settled = false;
    let stageSignal: AbortSignal | undefined;
    const attempt = attemptFeishuConnectionTest({ ...input(), signal: stop.signal }, async (url, take, signal) => {
      urls.push(url);
      if (url === oauth && scenario !== 'stop before OAuth') {
        gated.push(Boolean(take(url)));
        vi.advanceTimersByTime(6000);
        return json(token);
      }
      stageSignal = signal;
      if (scenario === 'deadline after message') gated.push(Boolean(take(url)));
      preparing.resolve();
      await release.promise;
      if (scenario !== 'deadline after message') gated.push(Boolean(take(url)));
      released = true;
      return url === oauth ? json(token) : json(receipt);
    }).then((result) => { settled = true; return result; });
    await preparing.promise;
    if (scenario.startsWith('stop')) stop.abort();
    else vi.advanceTimersByTime(4000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stageSignal?.aborted).toBe(true);
    expect([released, settled]).toEqual([false, false]);
    release.resolve();
    expect(await attempt).toEqual(unknown);
    expect(released).toBe(true);
    expect(urls).toEqual(scenario === 'stop before OAuth' ? [oauth] : [oauth, message]);
    expect(gated).toEqual(scenario === 'stop before OAuth' ? [false] : [true, scenario === 'deadline after message']);
  });

test.each(['throw', 'reject'])('sanitizes a transport %s without a replacement', async (mode) => {
  const urls: string[] = [];
  const result = await attemptFeishuConnectionTest(input(), (url, take) => {
    urls.push(url);
    take(url);
    if (url === oauth) return Promise.resolve(json(token));
    const failure = new Error(token.access_token);
    if (mode === 'throw') throw failure;
    return Promise.reject(failure);
  });
  expect(result).toEqual(unknown);
  expect(urls).toEqual([oauth, message]);
});

test('releases owned buffers after settlement and closes retained stage gates', async () => {
  const attempt = input();
  const buffers: Uint8Array[] = [];
  const gates: (() => unknown)[] = [];
  const result = await attemptFeishuConnectionTest(attempt, async (url, take) => {
    const req = take(url);
    const reply = url === oauth ? json(token) : json(receipt);
    if (req) buffers.push(req.body);
    buffers.push(reply.body);
    gates.push(() => take(url));
    return reply;
  });
  expect(result).toEqual(sent);
  expect(buffers).toHaveLength(4);
  expect(buffers.every((bytes) => bytes.length > 0 && bytes.every((byte) => byte === 0))).toBe(true);
  expect(gates.map((take) => take())).toEqual([null, null]);
  expect(attempt.secret.toString()).toBe('fixture secret');
});

test('checks cancellation again when authorization consumes the rest of the deadline', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  const { transport, handoffs } = fixture();
  const result = await attemptFeishuConnectionTest({
    ...input(), authorizeMessage: () => { vi.advanceTimersByTime(10_000); return true; },
  }, transport);
  expect(result).toEqual(unknown);
  expect(handoffs).toEqual([oauth]);
});

test('accepts exact local response byte budgets and rejects an incomplete declared body', async () => {
  const first = json(token);
  const header = ['x-padding', ''] as [string, string];
  const baseHeaderBytes = 2 + first.headers.reduce((n, [k, v]) => n + k.length + v.length + 4, 0);
  header[1] = 'a'.repeat(16384 - baseHeaderBytes - header[0].length - 4);
  const second = json(receipt);
  const padded = Buffer.alloc(65536, 32);
  padded.set(second.body);
  const ok = fixture({ ...first, headers: [...first.headers, header] }, { ...second, body: padded });
  expect(await attemptFeishuConnectionTest(input(), ok.transport)).toEqual(sent);
  const incomplete = fixture(json(token), { ...json(receipt), headers: [
    ['content-type', 'application/json'], ['content-length', String(second.body.byteLength + 1)],
  ] });
  expect(await attemptFeishuConnectionTest(input(), incomplete.transport)).toEqual(unknown);
  expect(incomplete.handoffs).toEqual([oauth, message]);
});

test('keeps a synthetic credential or bearer echoed as a receipt out of the result', async () => {
  for (const id of ['om_fixture-secret', 'om_fixture-token']) {
    const { transport } = fixture(json({ ...token, access_token: 'fixture-token' }), json({ code: 0, data: { message_id: id } }));
    expect(await attemptFeishuConnectionTest({ ...input(), secret: Buffer.from('fixture-secret') }, transport)).toEqual(unknown);
  }
});
