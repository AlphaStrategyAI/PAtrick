/// <reference lib="dom" />
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { Agent, createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createConnection, createServer as createNetServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { tmpdir as proxyTmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { expect, type Page } from '@playwright/test';

export const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function measureSettings(page: Page) {
  return page.evaluate(() => {
    const select = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error('Missing settings landmark ' + selector);
      return element.getBoundingClientRect();
    };
    const actions = document.querySelectorAll('.settings-checks-action > button');
    if (actions.length !== 1) throw new Error('Expected one Settings checks action');
    const action = actions[0].getBoundingClientRect();
    const grid = '.settings-grid a';
    const links = [...document.querySelectorAll<HTMLAnchorElement>(grid)];
    const edges: Record<string, number> = {
      sidebarRight: select('.desktop-sidebar').right,
      headerBottom: select('.topbar').bottom,
      headingLeft: select('main h1').left,
      overviewTop: select('.settings-overview').top,
      overviewBottom: select('.settings-overview').bottom,
      runChecksLeft: action.left, runChecksRight: action.right, runChecksTop: action.top, runChecksBottom: action.bottom,
    };
    for (const a of links) {
      const name = a.pathname.split('/').at(-1)!;
      const { left, right, top, bottom } = a.getBoundingClientRect();
      if (left < 0 || top < 0 || right > innerWidth || bottom > innerHeight ||
          !a.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2))) {
        throw new Error('Settings link clipped or covered: ' + name);
      }
      Object.assign(edges, { [name + 'Left']: left, [name + 'Right']: right, [name + 'Top']: top, [name + 'Bottom']: bottom });
    }
    const categories = links.map(a => {
      const labelledBy = a.getAttribute('aria-labelledby');
      if (labelledBy === null) return { path: a.pathname, label: a.innerText };
      const label = labelledBy.trim().split(/\s+/u).map(id => {
        const source = document.getElementById(id);
        if (!source) throw new Error('Missing Settings link label ' + id);
        return source.innerText.trim();
      }).join(' ');
      return { path: a.pathname, label };
    });
    return { edges, links: categories, clock: new Date().toISOString(),
      width: innerWidth, height: innerHeight, dpr: devicePixelRatio, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      htmlLang: document.documentElement.lang, light: matchMedia('(prefers-color-scheme: light)').matches,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, logoRunners: document.querySelectorAll('.logo-runner').length };
  });
}

export function edgeDeltas(actual: Record<string, number>, reference: Record<string, number>) {
  const deltas: Record<string, number> = {};
  for (const [key, expected] of Object.entries(reference)) {
    expect(Number.isFinite(actual[key]), 'measured ' + key).toBe(true);
    deltas[key] = actual[key]! - expected;
  }
  return deltas;
}

// Compare decoded sRGB RGBA at every viewport pixel (including antialiasing and text).
export async function pixelDiff(page: Page, actual: Buffer, reference: Buffer) {
  return page.evaluate(async ([left, right]) => {
    async function pixels(base64: string) {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, image.width, image.height).data;
      image.close();
      return { data: new Uint32Array(data.buffer), width: canvas.width, height: canvas.height };
    }
    const [a, b] = await Promise.all([pixels(left), pixels(right)]);
    if (a.width !== b.width || a.height !== b.height) throw new Error('Incompatible baseline dimensions');
    let changed = 0;
    for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) changed++;
    return { changed, total: a.data.length, ratio: changed / a.data.length };
  }, [actual.toString('base64'), reference.toString('base64')] as const);
}

const handshakeTimeoutMs = 2_000;
const reservedPorts = new Set([...Array.from({ length: 20 }, (_, index) => 4179 + index), 4431, 5173, 8443, 43123, 43124, 43155]);

function mac(key: string, value: string): string {
  return createHmac('sha256', Buffer.from(key, 'hex')).update(value).digest('hex');
}
function sameMac(actual: string, expected: string): boolean {
  return /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function readBoundedLine(socket: Socket, limit: number, onLine: (line: string) => void): void {
  let buffered = Buffer.alloc(0);
  const timer = setTimeout(() => socket.destroy(), handshakeTimeoutMs);
  timer.unref();
  const onClose = () => clearTimeout(timer);
  const onData = (chunk: Buffer) => {
    if (chunk.length > limit - buffered.length) { socket.destroy(); return; }
    buffered = Buffer.concat([buffered, chunk]);
    const newline = buffered.indexOf(10);
    if (newline < 0) return;
    if (newline !== buffered.length - 1) { socket.destroy(); return; }
    socket.removeListener('data', onData);
    socket.removeListener('close', onClose);
    clearTimeout(timer);
    onLine(buffered.subarray(0, newline).toString('utf8'));
  };
  socket.once('close', onClose);
  socket.on('data', onData);
}
function closeListening(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
export async function bindUnreserved(server: Server, used: ReadonlySet<number> = new Set()): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      try { server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve(); }); }
      catch (error) { server.removeListener('error', onError); reject(error); }
    });
    const address = server.address();
    if (!address || typeof address === 'string' || !Number.isInteger(address.port) || address.port < 1 || address.port > 65535) {
      throw new Error('Missing overview proxy port');
    }
    if (!reservedPorts.has(address.port) && !used.has(address.port)) return address.port;
    await closeListening(server);
  }
  throw new Error('Overview proxy port allocation exhausted');
}

/** Each Playwright runner owns its proxy and a separate authenticated, in-memory control channel. */
export async function overviewProxyTarget(): Promise<string> {
  const inheritedPort = process.env.PATRICK_OVERVIEW_PROXY_PORT;
  const inheritedControl = process.env.PATRICK_OVERVIEW_CONTROL_PORT;
  const inheritedDirectory = process.env.PATRICK_OVERVIEW_DIRECTORY;
  const inheritedKey = process.env.PATRICK_OVERVIEW_TRANSPORT_KEY;
  const owner = Number(process.env.PATRICK_OVERVIEW_PROXY_OWNER);
  const isWorker = process.env.TEST_WORKER_INDEX !== undefined && owner === process.ppid;
  if (inheritedPort && inheritedControl && inheritedDirectory && inheritedKey && owner > 0 && (owner === process.pid || isWorker)) {
    const port = Number(inheritedPort), control = Number(inheritedControl);
    if (![port, control].every(value => Number.isInteger(value) && value > 0 && value <= 65535 && !reservedPorts.has(value)) ||
        port === control || dirname(inheritedDirectory) !== join(proxyTmpdir()) ||
        !basename(inheritedDirectory).startsWith('p24-overview-proxy-') || !lstatSync(inheritedDirectory).isDirectory() ||
        !/^[a-f0-9]{64}$/.test(inheritedKey)) throw new Error('Invalid inherited overview proxy');
    return `http://127.0.0.1:${port}`;
  }
  const directory = mkdtempSync(join(proxyTmpdir(), 'p24-overview-proxy-'));
  chmodSync(directory, 0o700);
  const identity = lstatSync(directory);
  const removeOwnedDirectory = () => {
    const current = lstatSync(directory, { throwIfNoEntry: false });
    if (!current?.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) return;
    if (readdirSync(directory).length === 0) rmdirSync(directory);
  };
  const controlKey = randomBytes(32).toString('hex');
  let registration: { socket: Socket; pid: number; port: number; token: string } | undefined;
  let proxyPort = 0, controlPort = 0;
  const proxy = createHttpServer((request, response) => {
    const active = registration;
    if (!active || !alive(active.pid)) {
      if (active) { active.socket.destroy(); registration = undefined; }
      response.writeHead(503).end();
      return;
    }
    const connection = createConnection({ host: '127.0.0.1', port: active.port });
    let forwarded = false;
    let eventStream = false;
    const fail = () => {
      connection.destroy();
      if (!response.destroyed && !response.writableEnded) {
        if (!response.headersSent) response.writeHead(503).end();
        else response.destroy();
      }
    };
    connection.on('error', fail);
    connection.on('close', () => { if (!forwarded) fail(); });
    response.on('close', () => connection.destroy());
    const challenge = randomBytes(32).toString('hex');
    readBoundedLine(connection, 65, line => {
      if (!sameMac(line, mac(active.token, 'server:' + challenge))) { fail(); return; }
      forwarded = true;
      const agent = new Agent({ keepAlive: false });
      agent.createConnection = () => connection;
      const upstream = httpRequest({ host: '127.0.0.1', method: request.method, path: request.url, headers: request.headers, agent }, incoming => {
        eventStream = incoming.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream';
        incoming.once('aborted', fail);
        incoming.once('error', fail);
        incoming.once('close', () => { if (!incoming.complete) fail(); });
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        if (eventStream) response.flushHeaders();
        incoming.pipe(response);
      });
      upstream.on('error', fail);
      request.pipe(upstream);
    });
    connection.on('connect', () => connection.write(challenge + ':' + mac(active.token, 'client:' + challenge) + '\n'));
  });
  const control = createNetServer(socket => {
    socket.on('error', () => socket.destroy());
    readBoundedLine(socket, 256, line => {
      const match = /^([1-9][0-9]*):([1-9][0-9]{0,4}):([a-f0-9]{64}):([a-f0-9]{64})$/.exec(line);
      if (!match) { socket.destroy(); return; }
      const pid = Number(match[1]), port = Number(match[2]), token = match[3];
      const body = `${pid}:${port}:${token}`;
      if (!Number.isSafeInteger(pid) || port > 65535 || (reservedPorts.has(port) || [proxyPort, controlPort].includes(port)) || !alive(pid) || !sameMac(match[4], mac(controlKey, body))) {
        socket.destroy(); return;
      }
      if (registration && !alive(registration.pid)) { registration.socket.destroy(); registration = undefined; }
      if (registration) { socket.destroy(); return; }
      registration = { socket, pid, port, token };
      socket.on('close', () => { if (registration?.socket === socket) registration = undefined; });
      socket.write('OK\n');
    });
  });
  try {
    proxyPort = await bindUnreserved(proxy);
    controlPort = await bindUnreserved(control, new Set([proxyPort]));
    process.env.PATRICK_OVERVIEW_PROXY_OWNER = String(process.pid);
    process.env.PATRICK_OVERVIEW_PROXY_PORT = String(proxyPort);
    process.env.PATRICK_OVERVIEW_CONTROL_PORT = String(controlPort);
    process.env.PATRICK_OVERVIEW_DIRECTORY = directory;
    process.env.PATRICK_OVERVIEW_TRANSPORT_KEY = controlKey;
    delete process.env.PATRICK_OVERVIEW_SOCKET;
    proxy.unref(); control.unref();
    process.once('exit', () => { proxy.close(); control.close(); removeOwnedDirectory(); });
    return `http://127.0.0.1:${proxyPort}`;
  } catch (error) {
    try { if (control.listening) await closeListening(control); }
    finally {
      try { if (proxy.listening) await closeListening(proxy); }
      finally { removeOwnedDirectory(); }
    }
    throw error;
  }
}

type HealthFixtureOptions = {
  backendPort?: number;
  scratchRoot?: string;
  onCleanup?: (result: { databaseOpen: boolean; runtimeStatus: string; serviceListening: boolean }) => void;
};

async function unrouteOpenPage(page: Page) {
  try { if (!page.isClosed()) await page.unrouteAll({ behavior: 'wait' }); }
  catch (error) { if (!page.isClosed()) throw error; }
}

async function leaveOpenPage(page: Page) {
  try { if (!page.isClosed()) await page.goto('about:blank'); }
  catch (error) { if (!page.isClosed()) throw error; }
}

/** Real local service and SQLite projection; no business or external service writes. */
export async function withHealthService(page: Page, run: (fixture: {
  requests: Array<{ method: string; path: string; status: number; hasCookie: boolean; hasAuthorization: boolean }>;
  backendPort: number;
  stopBackend: () => Promise<void>;
  setProjection: (freshness: 'fresh' | 'stale' | 'unknown', at: string, facts?: HealthFacts) => void;
  disconnectEvents: () => void;
  resetProjection: () => void;
  holdNextSession: () => { ready: Promise<void>; release: () => void };
  holdAllSessions: () => { ready: Promise<void>; count: () => number; release: () => void };
  switchDomain: () => Promise<void>;
  addPermission: () => void;
}) => Promise<void>, initial?: { freshness: 'fresh' | 'stale' | 'unknown'; at: string; facts?: HealthFacts },
options: HealthFixtureOptions = {}) {
  const [{ tmpdir }, { Readable }, { pipeline },
    { openDatabase }, { createCredentialStore }, { issueCallerSession }, { createServiceRuntime }] = await Promise.all([
    import('node:os'), import('node:stream'), import('node:stream/promises'),
    import('@patrick/storage'), import('@patrick/host'), import('../../apps/service/src/auth.js'), import('../../apps/service/src/app.js'),
  ]);
  const directory = mkdtempSync(join(options.scratchRoot ?? tmpdir(), 'patrick-settings-overview-'));
  const databasePath = join(directory, 'service.sqlite');
  const credentialDirectory = join(directory, 'credentials');
  const at = '2026-11-17T05:00:00.000Z';
  const now = () => new Date(at);
  let db: ReturnType<typeof openDatabase> | undefined;
  let runtime: ReturnType<typeof createServiceRuntime> | undefined;
  let backend: Server | undefined;
  let control: Socket | undefined;
  let releaseAllSessions: (() => void) | undefined;
  let runtimeStatus = 'not-started';
  const connections = new Set<Socket>();
  try {
    db = openDatabase(databasePath);
    const database = db;
    database.prepare("INSERT INTO accounts VALUES ('owner',1,1,?)").run(at);
    const setProjection = (freshness: 'fresh' | 'stale' | 'unknown', time: string, facts?: HealthFacts) => {
      database.prepare(`INSERT INTO product_view_checkpoints (account_id,data_domain,epoch,hub_seq,domain_seq,notification_seq,
        notification_floor,observed_at,trusted_as_of,freshness,health_payload) VALUES ('owner','personal',1,0,0,0,0,?,?,?,?)
        ON CONFLICT(account_id,data_domain) DO UPDATE SET observed_at=excluded.observed_at,trusted_as_of=excluded.trusted_as_of,
        freshness=excluded.freshness,health_payload=excluded.health_payload`)
        .run(time, freshness === 'unknown' ? null : time, freshness, facts ? JSON.stringify(facts) : null);
    };
    if (initial) setProjection(initial.freshness, initial.at, initial.facts);
    const { token } = issueCallerSession(database, { accountId: 'owner', callerId: 'web', domain: 'personal', permissions: ['owner'] },
      now, createCredentialStore(credentialDirectory, now));
    await page.context().addCookies([{ name: 'patrick_session', value: token, url: 'http://localhost', httpOnly: true, sameSite: 'Strict' }]);
    const serviceRuntime = createServiceRuntime({ databasePath, credentialDirectory, now });
    runtime = serviceRuntime;
    const requests: Array<{ method: string; path: string; status: number; hasCookie: boolean; hasAuthorization: boolean }> = [];
    const streams = new Set<import('node:http').ServerResponse>();
    let offline = false;
    let held: { ready: () => void; gate: Promise<void> } | undefined;
    let heldAll: { seen: () => void; gate: Promise<void> } | undefined;
    const holdNextSession = () => {
      let ready!: () => void;
      let release!: () => void;
      const pending = new Promise<void>(resolve => { ready = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      held = { ready, gate };
      return { ready: pending, release };
    };
    const holdAllSessions = () => {
      if (heldAll) throw new Error('Session gate already active');
      let signalReady!: () => void;
      let open!: () => void;
      let count = 0;
      const ready = new Promise<void>(resolve => { signalReady = resolve; });
      const gate = new Promise<void>(resolve => { open = resolve; });
      const current = { gate, seen: () => { count++; signalReady(); } };
      heldAll = current;
      const release = () => {
        if (heldAll !== current) return;
        heldAll = undefined;
        releaseAllSessions = undefined;
        open();
      };
      releaseAllSessions = release;
      return { ready, count: () => count, release };
    };
    const service = createHttpServer((request, response) => {
      void (async () => {
        const abort = new AbortController();
        response.on('close', () => abort.abort());
        const target = new URL(request.url ?? '/', 'http://localhost');
        const method = request.method ?? 'GET';
        const events = target.pathname === '/api/v1/events';
        if (events && offline) { response.writeHead(503).end(); return; }
        if (events) { streams.add(response); response.on('close', () => streams.delete(response)); }
        const body: Buffer[] = [];
        for await (const chunk of request) body.push(Buffer.from(chunk));
        if (target.pathname === '/api/v1/session' && method === 'GET') {
          if (heldAll) {
            const pending = heldAll; pending.seen(); await pending.gate;
          } else if (held) {
            const pending = held; held = undefined; pending.ready(); await pending.gate;
          }
        }
        const upstream = await serviceRuntime.app.request(target.pathname + target.search, {
          method, headers: request.headers as Record<string, string>, signal: abort.signal,
          ...(body.length ? { body: Buffer.concat(body).toString() } : {}),
        });
        requests.push({ method, path: target.pathname, status: upstream.status, hasCookie: !!request.headers.cookie,
          hasAuthorization: !!request.headers.authorization });
        response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
        if (events) response.flushHeaders();
        if (!upstream.body) response.end();
        else await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream<Uint8Array>), response);
      })().catch(() => { if (!response.destroyed) response.destroy(); });
    });
    const backendToken = randomBytes(32).toString('hex');
    backend = createNetServer(socket => {
      connections.add(socket);
      socket.on('error', () => socket.destroy());
      socket.on('close', () => connections.delete(socket));
      readBoundedLine(socket, 130, line => {
        const match = /^([a-f0-9]{64}):([a-f0-9]{64})$/.exec(line);
        if (!match || !sameMac(match[2], mac(backendToken, 'client:' + match[1]))) { socket.destroy(); return; }
        socket.write(mac(backendToken, 'server:' + match[1]) + '\n');
        service.emit('connection', socket);
      });
    });
    const backendPort = options.backendPort === undefined ? await bindUnreserved(backend, new Set([Number(process.env.PATRICK_OVERVIEW_PROXY_PORT), Number(process.env.PATRICK_OVERVIEW_CONTROL_PORT)])) : await new Promise<number>((resolve, reject) => {
      if (reservedPorts.has(options.backendPort!) || [Number(process.env.PATRICK_OVERVIEW_PROXY_PORT), Number(process.env.PATRICK_OVERVIEW_CONTROL_PORT)].includes(options.backendPort!)) {
        reject(new Error('Reserved overview backend port')); return;
      }
      backend!.once('error', reject);
      backend!.listen(options.backendPort, '127.0.0.1', () => resolve(options.backendPort!));
    });
    const controlPort = Number(process.env.PATRICK_OVERVIEW_CONTROL_PORT);
    const controlKey = process.env.PATRICK_OVERVIEW_TRANSPORT_KEY;
    if (!Number.isInteger(controlPort) || !controlKey || !/^[a-f0-9]{64}$/.test(controlKey)) throw new Error('Overview control unavailable');
    control = createConnection({ host: '127.0.0.1', port: controlPort });
    control.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      control!.once('error', onError);
      control!.once('close', () => reject(new Error('Overview registration closed')));
      const body = `${process.pid}:${backendPort}:${backendToken}`;
      readBoundedLine(control!, 3, line => {
        if (line !== 'OK') { reject(new Error('Overview registration rejected')); return; }
        control!.removeListener('error', onError);
        resolve();
      });
      control!.once('connect', () => control!.write(body + ':' + mac(controlKey, body) + '\n'));
    });
    await run({ requests, backendPort, setProjection,
      stopBackend: async () => {
        for (const connection of connections) connection.destroy();
        if (backend?.listening) await closeListening(backend);
      },
      disconnectEvents: () => { offline = true; for (const stream of streams) stream.end(); },
      resetProjection: () => {
        const result = database.prepare("UPDATE product_view_checkpoints SET epoch=epoch+1 WHERE account_id='owner' AND data_domain='personal'").run();
        if (result.changes !== 1) throw new Error('Missing projection checkpoint');
      },
      holdNextSession,
      holdAllSessions,
      addPermission: () => {
        database.prepare("INSERT INTO caller_scopes (account_id,caller_id,data_domain,permission,revoked_at) VALUES ('owner','web','personal','settings.read',NULL)").run();
      },
      switchDomain: async () => {
        const replacement = issueCallerSession(database, { accountId: 'owner', callerId: 'other-web', domain: 'company', permissions: ['owner'] },
          now, createCredentialStore(credentialDirectory, now));
        await page.context().addCookies([{ name: 'patrick_session', value: replacement.token, url: 'http://localhost', httpOnly: true, sameSite: 'Strict' }]);
      },
    });
  } finally {
    releaseAllSessions?.();
    try {
      if (backend?.listening) await leaveOpenPage(page);
    } finally {
      try { await unrouteOpenPage(page); }
      finally {
        control?.destroy();
        for (const connection of connections) connection.destroy();
        try { if (backend?.listening) await closeListening(backend); }
        finally {
          try { if (runtime) { runtime.stop(); runtimeStatus = (await runtime.drain()).status; } }
          finally {
            try { if (db?.open) db.close(); }
            finally {
              rmSync(directory, { recursive: true, force: true });
              options.onCleanup?.({ databaseOpen: !!db?.open, runtimeStatus, serviceListening: !!backend?.listening });
            }
          }
        }
      }
    }
  }
}

type HealthFacts = {
  connections: { vault: { status: string; revision: number; epoch: number } | null; feishu: { status: string; revision: number; epoch: number } | null };
  edits: { pending: number; failed: number };
};
