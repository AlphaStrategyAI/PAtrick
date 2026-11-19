import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request, type IncomingMessage, type RequestOptions } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer, checkServerIdentity, rootCertificates, type ConnectionOptions, type TLSSocket } from 'node:tls';
import { attemptFeishuConnectionTest } from '../../packages/integrations/feishu/provider-protocol.js';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';
import { afterAll, beforeAll, expect, test } from 'vitest';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { resolve, promise };
}

const source = new URL('../../packages/integrations/feishu/provider-https.ts', import.meta.url);
const oauth = 'https://accounts.feishu.cn/oauth/v3/token';
const requireModule = createRequire(import.meta.url);

// Only the in-memory compilation of the reviewed source can name private symbols.
function compileFixture(symbols: string, load: (name: string) => unknown) {
  const input = readFileSync(source, 'utf8') + '\nexport { ' + symbols + ' };';
  const js = ts.transpileModule(input, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const out: Record<string, unknown> = {};
  runInThisContext('(function(require, exports){' + js + '\n})')(load, out);
  return out;
}
function fixtureModule(load: (name: string) => unknown = requireModule) {
  return compileFixture('selectAddress, createTransport', load) as {
    selectAddress: (answers: string[]) => string;
    createTransport: (io: unknown) => Parameters<typeof attemptFeishuConnectionTest>[1];
  };
}

test('permits unicast IPv4 only and rejects the complete mixed answer', () => {
  const { selectAddress } = fixtureModule();
  expect(selectAddress(['8.8.8.8'])).toBe('8.8.8.8');
  for (const address of ['0.0.0.0', '127.0.0.1', '10.1.2.3', '100.64.2.3', '169.254.2.3',
    '172.31.2.3', '192.0.0.8', '192.168.1.2', '192.0.2.1', '198.19.2.3', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '255.255.255.255', '::ffff:8.8.8.8', '8.8.8.999']) {
    expect(() => selectAddress(['8.8.8.8', address])).toThrow('FEISHU_TRANSPORT');
  }
  expect(() => selectAddress([])).toThrow();
  expect(() => selectAddress(Array(17).fill('8.8.8.8'))).toThrow();
});

test('refuses an unexpected target before touching any I/O or gate', async () => {
  const send = fixtureModule().createTransport({});
  await expect(send(oauth + '/', () => { throw Error('fixture'); }, new AbortController().signal))
    .rejects.toThrow('FEISHU_TRANSPORT');
});

test('holds outstanding resolution after abort without dialing or taking', async () => {
  let finish!: (answer: string[]) => void;
  const pending = new Promise<string[]>((done) => { finish = done; });
  const trace: string[] = [];
  const send = fixtureModule().createTransport({
    resolve(host: string) { trace.push(host); return pending; },
    dial() { trace.push('dial'); },
  });
  const stop = new AbortController();
  const result = send(oauth, () => { trace.push('take'); return null; }, stop.signal)
    .then(() => 'accepted', () => 'denied').finally(() => trace.push('settled'));
  stop.abort();
  await new Promise<void>((done) => setImmediate(done));
  expect(trace).toEqual(['accounts.feishu.cn']);
  finish(['8.8.8.8']);
  expect(await result).toBe('denied');
  expect(trace).toEqual(['accounts.feishu.cn', 'settled']);
});

test('ordinary imports expose no native or test entry', async () => {
  expect(Object.keys(await import('../../packages/integrations/feishu/provider-https.js'))).toEqual([]);
  expect(() => requireModule.resolve('@patrick/integrations/feishu/provider-https')).toThrow();
  const pkg = JSON.parse(readFileSync(new URL('../../packages/integrations/package.json', import.meta.url), 'utf8'));
  expect(Object.values(pkg.exports).join(' ')).not.toContain('provider-https');
});

test('abort before TLS readiness waits for actual close and forbids subsequent handoff', async () => {
  const peer = Object.assign(new EventEmitter(), { destroy() { destroyed = true; } });
  let destroyed = false;
  const ready = deferred();
  const trace: string[] = [];
  const send = fixtureModule().createTransport({ resolve: async () => ['8.8.8.8'], select: () => '8.8.8.8',
    port: 443, roots: [], dial() { ready.resolve(); return peer; } });
  const stop = new AbortController();
  const result = send(oauth, () => { trace.push('take'); return null; }, stop.signal)
    .then(() => 'accepted', () => 'denied').finally(() => trace.push('settled'));
  await ready.promise;
  stop.abort();
  peer.emit('secureConnect');
  await new Promise<void>((done) => setImmediate(done));
  expect(destroyed).toBe(true);
  expect(trace).toEqual([]);
  peer.emit('close');
  expect(await result).toBe('denied');
});

const local = '127.0.0.1';
const messageUrl = 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id';
const certificate = { dir: '', key: '', cert: '' };
beforeAll(() => {
  certificate.dir = mkdtempSync(join(tmpdir(), 'patrick-synthetic-feishu-'));
  const key = join(certificate.dir, 'key.pem');
  const cert = join(certificate.dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj',
    '/CN=fixture.invalid', '-addext', 'subjectAltName=DNS:accounts.feishu.cn,DNS:open.feishu.cn',
    '-keyout', key, '-out', cert], { stdio: 'ignore' });
  certificate.key = readFileSync(key, 'utf8');
  certificate.cert = readFileSync(cert, 'utf8');
});
afterAll(() => { if (certificate.dir) rmSync(certificate.dir, { force: true, recursive: true }); });

function response(body: Buffer | string, headers = '', status = '200 OK') {
  const data = Buffer.from(body);
  return Buffer.concat([Buffer.from('HTTP/1.1 ' + status + '\r\nContent-Type: application/json\r\n'
    + headers + 'Content-Length: ' + data.length + '\r\nConnection: close\r\n\r\n'), data]);
}
type Mode = 'ok' | 'wrong-ca' | 'wrong-name' | 'wrong-peer' | 'wrong-port';
async function localFixture(replies: (Buffer | null | ((socket: TLSSocket) => void))[], mode: Mode = 'ok', holdClose = false, holdRequestClose = false) {
  const observation = { applicationBytes: 0, responseBytes: 0, strict: undefined as boolean | undefined,
    upgrade: undefined as IncomingMessage | undefined };
  const limitReached = deferred();
  const sawUpgrade = deferred();
  const tlsClosed = deferred();
  const upgradeRelease = deferred();
  const requestClosing = deferred();
  const requestRelease = deferred();
  const requestClosed = deferred();
  const responseClosed = deferred();
  const received: { bytes: Buffer; clientPort: number | undefined }[] = [];
  const options: ConnectionOptions[] = [];
  const clients: TLSSocket[] = [];
  const closedClients: boolean[] = [];
  const starts = deferred();
  const closing = deferred();
  const release = deferred();
  const resolves: string[] = [];
  const server = createServer({ key: certificate.key, cert: certificate.cert }, (socket) => {
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', (part: Buffer) => {
      observation.applicationBytes += part.length;
      buffer = Buffer.concat([buffer, part]);
      const split = buffer.indexOf('\r\n\r\n');
      if (split < 0) return;
      const length = Number(/content-length: (\d+)/i.exec(buffer.subarray(0, split).toString())?.[1]);
      if (buffer.length < split + 4 + length) return;
      received.push({ bytes: buffer, clientPort: socket.remotePort });
      const reply = replies[received.length - 1];
      // A partial response deliberately holds its stream open for the abort case.
      if (reply === null) socket.write('HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\nx');
      else if (typeof reply === 'function') reply(socket);
      else socket.end(reply);
    });
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, local, done); });
  const address = server.address();
  if (typeof address !== 'object' || !address) throw Error('fixture address');
  // Observe genuine client-side events on per-fixture requests, never on Node globals.
  const transport = fixtureModule((name) => name === 'node:http' ? {
    request(input: RequestOptions) {
      observation.strict = input.insecureHTTPParser;
      const req = request(input);
      if (holdRequestClose) {
        const emit = req.emit.bind(req);
        // ClientRequest emits close directly; hold only this instance's notification.
        req.emit = (event: string | symbol, ...args: unknown[]) => {
          if (event !== 'close') return emit(event, ...args);
          requestClosing.resolve();
          void requestRelease.promise.then(() => emit(event, ...args));
          return true;
        };
      }
      req.once('close', requestClosed.resolve);
      req.once('response', (incoming) => {
        incoming.once('close', responseClosed.resolve);
        incoming.on('data', (chunk: Buffer) => {
          observation.responseBytes += chunk.length;
          if (observation.responseBytes === 65536) limitReached.resolve();
          starts.resolve();
        });
      });
      req.once('upgrade', (incoming) => {
        observation.upgrade = incoming;
        const destroy = incoming._destroy.bind(incoming);
        incoming._destroy = (error, done) => destroy(error, (result) => {
          void upgradeRelease.promise.then(() => done(result));
        });
        sawUpgrade.resolve();
      });
      return req;
    },
  } : requireModule(name)).createTransport({
    resolve: async (host: string) => { resolves.push(host); return [local]; },
    select: () => mode === 'wrong-peer' ? '127.0.0.2' : local,
    port: mode === 'wrong-port' ? address.port + 1 : address.port,
    roots: mode === 'wrong-ca' ? [] : [certificate.cert],
    dial(input: ConnectionOptions) {
      options.push(input);
      // Force the fixture's one listener regardless of the expected peer in refusal tests.
      const socket = connect({ ...input, host: local, port: address.port,
        servername: mode === 'wrong-name' ? 'fixture-wrong.invalid' : input.servername });
      if (holdClose) {
        // Observe the real stream's destroy completion; delay only its callback and close event.
        const destroy = socket._destroy.bind(socket);
        socket._destroy = (error, done) => destroy(error, (result) => {
          closing.resolve();
          void release.promise.then(() => done(result));
        });
      }
      const index = clients.push(socket) - 1;
      socket.once('close', () => { closedClients[index] = true; tlsClosed.resolve(); });
      return socket;
    },
  });
  return { transport, received, observation, options, resolves, clients, closedClients, starts, closing, release, limitReached, sawUpgrade, upgradeRelease, tlsClosed,
    requestClosing, requestRelease, requestClosed, responseClosed, port: address.port,
    close: () => new Promise<void>((done) => { server.close(() => done()); }) };
}
function attempt() {
  return { appId: 'fixture-app', secret: Buffer.from('synthetic-credential'), openId: 'fixture-open',
    chatId: 'fixture-chat', tenantKey: 'fixture-tenant', testId: 'test_123456789abc',
    signal: new AbortController().signal, authorizeOAuth: () => true, authorizeMessage: () => true };
}
const token = JSON.stringify({ code: 0, token_type: 'Bearer', access_token: 'synthetic-bearer', expires_in: 60 });
test('each protocol gate writes on the one verified TLS connection observed at the local server', async () => {
  const f = await localFixture([response(token), response('{"code":0,"data":{"message_id":"fixture_id"}}')]);
  const gates: (number | undefined)[] = [];
  try {
    const authorize = () => {
      const client = f.clients.at(-1)!;
      expect(client.authorized).toBe(true);
      expect(client.bytesWritten).toBe(0);
      gates.push(client.localPort);
      return true;
    };
    const result = await attemptFeishuConnectionTest({ ...attempt(), authorizeOAuth: authorize,
      authorizeMessage: authorize }, f.transport);
    expect(result).toEqual({ state: 'sent', message_id: 'fixture_id' });
    expect(f.resolves).toEqual(['accounts.feishu.cn', 'open.feishu.cn']);
    expect(f.received.map((record) => record.clientPort)).toEqual(gates);
    expect(new Set(gates).size).toBe(2);
    for (const [i, url] of [oauth, messageUrl].entries()) {
      const parsed = new URL(url);
      expect(f.options[i]).toMatchObject({ host: local, family: 4, port: f.port, servername: parsed.hostname,
        checkServerIdentity, rejectUnauthorized: true, ca: [certificate.cert] });
      expect(f.received[i].bytes.toString()).toContain('POST ' + parsed.pathname + parsed.search + ' HTTP/1.1');
    }
    expect(f.closedClients).toEqual([true, true]);
  } finally { f.release.resolve(); await f.close(); }
});
test.each(['wrong-ca', 'wrong-name', 'wrong-peer', 'wrong-port'] as const)(
  'refuses %s before take or HTTP bytes', async (mode) => {
    const f = await localFixture([], mode);
    let gates = 0;
    try {
      await expect(f.transport(oauth, () => { gates++; return null; }, attempt().signal)).rejects.toThrow(/^FEISHU_TRANSPORT$/);
      expect(gates).toBe(0);
      expect(f.closedClients).toEqual([true]);
    } finally { await f.close(); }
    expect(f.observation.applicationBytes).toBe(0);
    expect(f.received).toEqual([]);
  });
test.each(['denied', 'throw', 'abort'])('verified peer receives no request on gate %s', async (mode) => {
  const f = await localFixture([]);
  const stop = new AbortController();
  let gates = 0;
  try {
    await expect(f.transport(oauth, () => {
      gates++;
      if (mode === 'throw') throw Error('synthetic-sensitive-error');
      if (mode === 'abort') stop.abort();
      return null;
    }, stop.signal)).rejects.toThrow(/^FEISHU_TRANSPORT$/);
    expect(gates).toBe(1);
    expect(f.clients[0].bytesWritten).toBe(0);
  } finally { await f.close(); }
  expect(f.observation.applicationBytes).toBe(0);
    expect(f.received).toEqual([]);
});
test.each([
  ['redirect', response('', 'Location: https://example.invalid/\r\n', '302 Found')],
  ['duplicate', response(token, 'Content-Type: application/json\r\n')],
  ['encoded', response(token, 'Content-Encoding: gzip\r\n')],
  ['UTF-8', response(Buffer.from([0xff]))],
  ['oversized body', response(Buffer.alloc(65537))],
  ['oversized header', response(token, 'X-Limit: ' + 'x'.repeat(16384) + '\r\n')],
  ['truncated', Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 90\r\n\r\n{}')],
] as const)('protocol rejects %s after exactly one local attempt', async (_label, reply) => {
  const f = await localFixture([reply]);
  try {
    expect(await attemptFeishuConnectionTest(attempt(), f.transport)).toEqual({ state: 'unknown' });
    expect(f.closedClients).toEqual([true]);
    expect(f.resolves).toEqual(['accounts.feishu.cn']);
    expect(f.received.length).toBe(1);
  } finally { f.release.resolve(); await f.close(); }
});
test('abort during a partial HTTP response waits for client closure', async () => {
  const f = await localFixture([null], 'ok', true);
  const stop = new AbortController();
  let settled = false;
  const work = attemptFeishuConnectionTest({ ...attempt(), signal: stop.signal }, f.transport)
    .finally(() => { settled = true; });
  try {
    await f.starts.promise;
    expect(f.observation.responseBytes).toBe(1);
    expect(f.closedClients).toEqual([]);
    stop.abort();
    await f.closing.promise;
    await new Promise<void>((done) => setImmediate(done));
    expect(settled).toBe(false);
    f.release.resolve();
    expect(await work).toEqual({ state: 'unknown' });
    expect(f.closedClients).toEqual([true]);
    expect(f.resolves).toEqual(['accounts.feishu.cn']);
  } finally { f.release.resolve(); await f.close(); }
});

test('isolated native assembly selects one public IPv4, port 443, SNI, and bundled roots', async () => {
  const trace: string[] = [];
  let lookupOptions: unknown;
  let dialOptions: unknown;
  // The compiled test module receives no DNS/TLS/HTTP capability with external reach.
  function load(name: string) {
    if (name === 'node:net') return requireModule(name);
    if (name === 'node:http') return { request() { throw Error('fixture HTTP forbidden'); } };
    if (name === 'node:dns/promises') return { lookup(host: string, options: unknown) {
      trace.push(host); lookupOptions = options;
      return Promise.resolve([{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }]);
    } };
    if (name === 'node:tls') return { rootCertificates, checkServerIdentity, connect(options: unknown) {
      trace.push('dial'); dialOptions = options; throw Error('synthetic-sensitive-error');
    } };
    throw Error('unexpected fixture module');
  }
  const assembly = compileFixture('createNativeTransport', load) as {
    createNativeTransport(): Parameters<typeof attemptFeishuConnectionTest>[1];
  };
  await expect(assembly.createNativeTransport()(messageUrl, () => { trace.push('gate'); return null; },
    new AbortController().signal)).rejects.toThrow(/^FEISHU_TRANSPORT$/);
  expect(trace).toEqual(['open.feishu.cn', 'dial']);
  expect(lookupOptions).toEqual({ family: 4, all: true, verbatim: true });
  expect(dialOptions).toEqual({ host: '8.8.8.8', port: 443, family: 4, servername: 'open.feishu.cn',
    ALPNProtocols: ['http/1.1'], minVersion: 'TLSv1.2', ca: [...rootCertificates], checkServerIdentity,
    rejectUnauthorized: true });
});

test('abort after a complete reply while TLS close is deferred prevents the next stage', async () => {
  const f = await localFixture([response(token)], 'ok', true);
  const stop = new AbortController();
  let settled = false;
  const work = attemptFeishuConnectionTest({ ...attempt(), signal: stop.signal }, f.transport)
    .finally(() => { settled = true; });
  try {
    await f.closing.promise;
    stop.abort();
    await new Promise<void>((done) => setImmediate(done));
    expect(settled).toBe(false);
    expect(f.resolves).toEqual(['accounts.feishu.cn']);
    f.release.resolve();
    expect(await work).toEqual({ state: 'unknown' });
    expect(f.closedClients).toEqual([true]);
    expect(f.received).toHaveLength(1);
  } finally { f.release.resolve(); await f.close(); }
});

test('explicitly selects strict HTTP parsing on a normal local request', async () => {
  const f = await localFixture([response('{}')]);
  try {
    await attemptFeishuConnectionTest(attempt(), f.transport);
    expect(f.observation.strict).toBe(false);
  } finally { await f.close(); }
});

test('owns and closes the HTTP upgrade response before settling', async () => {
  const f = await localFixture([Buffer.from('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n')]);
  let settled = false;
  const work = attemptFeishuConnectionTest(attempt(), f.transport).finally(() => { settled = true; });
  try {
    await f.sawUpgrade.promise;
    await Promise.all([f.tlsClosed.promise, f.requestClosed.promise]);
    await new Promise<void>((done) => setImmediate(done));
    const incoming = f.observation.upgrade!;
    expect(incoming.destroyed).toBe(true);
    expect(incoming.listenerCount('error')).toBeGreaterThan(0);
    expect(incoming.closed).toBe(false);
    expect(settled).toBe(false);
    f.upgradeRelease.resolve();
    expect(await work).toEqual({ state: 'unknown' });
    expect(incoming.closed).toBe(true);
    expect(f.resolves).toHaveLength(1);
  } finally { f.upgradeRelease.resolve(); f.observation.upgrade?.destroy(); await f.close(); }
});

test('destroys the streamed response on byte 65537 before EOF and holds TLS close', async () => {
  let writer!: TLSSocket;
  const f = await localFixture([(socket) => {
    writer = socket;
    socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 70000\r\n\r\n');
    socket.write(Buffer.alloc(65536));
  }], 'ok', true);
  let settled = false;
  const work = f.transport(oauth, fixtureRequest, attempt().signal)
    .then(() => 'accepted', (error: Error) => error.message).finally(() => { settled = true; });
  try {
    await f.limitReached.promise;
    expect(f.clients[0].destroyed).toBe(false);
    writer.write(Buffer.from('x'));
    await f.closing.promise;
    expect(f.observation.responseBytes).toBe(65537);
    expect(settled).toBe(false);
    expect(f.closedClients).toEqual([]);
    f.release.resolve();
    expect(await work).toBe('FEISHU_TRANSPORT');
    expect(f.closedClients).toEqual([true]);
    expect(f.resolves).toHaveLength(1);
  } finally { f.release.resolve(); writer?.destroy(); await f.close(); }
});

function fixtureRequest() {
  return { method: 'POST' as const, headers: {}, body: Buffer.from('{}') };
}

test('denies oversized headers in the native parser before protocol validation', async () => {
  const f = await localFixture([response('{}', 'X-Fixture: ' + 'a'.repeat(16384) + '\r\n')]);
  try {
    await expect(f.transport(oauth, fixtureRequest, attempt().signal)).rejects.toThrow(/^FEISHU_TRANSPORT$/);
    expect(f.closedClients).toEqual([true]);
    expect(f.observation.responseBytes).toBe(0);
  } finally { await f.close(); }
});

test('holds the request close notification independently of response and TLS close', async () => {
  const f = await localFixture([response('{}')], 'ok', false, true);
  let settled = false;
  const work = f.transport(oauth, fixtureRequest, attempt().signal).finally(() => { settled = true; });
  try {
    await Promise.all([f.requestClosing.promise, f.responseClosed.promise, f.tlsClosed.promise]);
    await new Promise<void>((done) => setImmediate(done));
    expect(settled).toBe(false);
    f.requestRelease.resolve();
    expect((await work).status).toBe(200);
  } finally { f.requestRelease.resolve(); await f.close(); }
});
