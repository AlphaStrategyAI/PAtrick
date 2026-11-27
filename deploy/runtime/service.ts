import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { extname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { assertHubIdentity } from '@patrick/integrations/autoloop/client';
import {
  cleanRuntimeStartup,
  createProvisionedServiceRuntime,
  isRuntimeMain,
  installRuntimeMaintenance,
  requireRuntimeProvisioning,
  unavailableRuntimeDiagnostic,
  type RuntimeProvisioning,
} from './composition.js';

type ServiceRuntime = ReturnType<typeof createProvisionedServiceRuntime>;
type ListenerState = 'running' | 'draining' | 'closed' | 'close_failed';
type WebMaterial = { path: string; bytes: number; sha256: string };

const owners = new WeakMap<ServiceRuntime, RuntimeProvisioning>();
const startedIngress = new WeakMap<object, object>();
export function ownsMaintenanceIngress(runtime: object, ingress: object) {
  return startedIngress.get(runtime) === ingress;
}

const listenerStarted = new WeakSet<ServiceRuntime>();
// Keeps the existing 20 MB attachment contract within a bounded encoded request.
const maxBodyBytes = 32 * 1024 * 1024;

const contentTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function loadWebMaterials() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const indexPath = resolve(root, 'metadata/runtime-materials.json');
  const stat = await lstat(indexPath);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || await realpath(indexPath) !== indexPath) throw new Error();
  const inventory: { files: WebMaterial[] } = JSON.parse(await readFile(indexPath, 'utf8'));
  if (!Array.isArray(inventory.files) || inventory.files.length > 10000) throw new Error();
  const web = new Map<string, string>();
  let total = 0;
  for (const material of inventory.files) {
    if (!material.path.startsWith('web/')) continue;
    if (!/^web\/[A-Za-z0-9_./-]{1,508}$/.test(material.path) ||
        material.path.split('/').some((part) => !part || part.endsWith('.')) ||
        !Number.isSafeInteger(material.bytes) || material.bytes < 0 || material.bytes > 16 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(material.sha256)) throw new Error();
    const absolute = resolve(root, material.path);
    const info = await lstat(absolute);
    total += material.bytes;
    if (!info.isFile() || info.size !== material.bytes || await realpath(absolute) !== absolute ||
        total > 40 * 1024 * 1024 ||
        createHash('sha256').update(await readFile(absolute)).digest('hex') !== material.sha256) throw new Error();
    const route = '/' + material.path.slice('web/'.length);
    if (web.has(route)) throw new Error();
    web.set(route, absolute);
  }
  if (!web.has('/index.html')) throw new Error();
  return web;
}

async function serveStatic(
  request: IncomingMessage, response: ServerResponse, materials: Map<string, string>, path: string,
): Promise<boolean> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const urlPath = decodeURIComponent(path);
  const file = materials.get(urlPath) ?? (extname(urlPath) ? undefined : materials.get('/index.html'));
  if (!file) return false;
  response.setHeader('content-type', contentTypes[extname(file)] ?? 'application/octet-stream');
  response.setHeader('x-content-type-options', 'nosniff');
  if (request.method === 'HEAD') response.end();
  else await pipeline(createReadStream(file), response);
  return true;
}

function requestUrl(request: IncomingMessage, origin: URL, listenerAuthority: string): URL | undefined {
  const host = request.headers.host;
  const target = request.url;
  if ((host !== origin.host && host !== listenerAuthority) || !target?.startsWith('/') || target.startsWith('//') ||
      target.includes('\\') || /%2f|%5c/i.test(target.split('?')[0])) return undefined;
  return new URL(target, origin);
}

function honoRequest(request: IncomingMessage, url: URL, signal: AbortSignal): Request {
  const method = request.method ?? 'GET';
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    let bytes = 0;
    const source = Readable.toWeb(request) as ReadableStream<Uint8Array>;
    body = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, stream) {
        bytes += chunk.byteLength;
        if (bytes > maxBodyBytes) stream.error(new Error('REQUEST_BODY_LIMIT'));
        else stream.enqueue(chunk);
      },
    }));
  }
  return new Request(url, { method, headers, body, signal, ...(body ? { duplex: 'half' } as RequestInit : {}) });
}

async function writeResponse(result: Response, response: ServerResponse, signal: AbortSignal): Promise<void> {
  response.statusCode = result.status;
  if (result.statusText) response.statusMessage = result.statusText;
  result.headers.forEach((value, name) => {
    if (name !== 'set-cookie' && name !== 'connection' && name !== 'transfer-encoding') response.setHeader(name, value);
  });
  const cookies = result.headers.getSetCookie();
  if (cookies.length) response.setHeader('set-cookie', cookies);
  if (result.body) {
    response.flushHeaders();
    await pipeline(Readable.fromWeb(result.body as never), response, { signal });
  } else response.end();
}

export function createInstalledService(provisioning: RuntimeProvisioning) {
  const runtime = createProvisionedServiceRuntime(provisioning);
  owners.set(runtime, provisioning);
  return runtime;
}

const maintenanceSignals = new WeakMap<ServiceRuntime, { held: boolean; settled(): void }>();
export async function startServiceListener(runtime: ServiceRuntime, provisioning: RuntimeProvisioning, assertSelected?: () => void) {
  const ports = requireRuntimeProvisioning(provisioning);
  if (owners.get(runtime) !== provisioning || listenerStarted.has(runtime)) throw new Error('LISTENER_OWNER_INVALID');
  listenerStarted.add(runtime);
  if (runtime.read().status !== 'running') throw new Error('LISTENER_RUNTIME_NOT_RUNNING');
  const registration = provisioning.registration.listener;
  let materials: Awaited<ReturnType<typeof loadWebMaterials>>;
  try { materials = await loadWebMaterials(); }
  catch {
    const cleanup = await runtime.drain();
    throw Object.assign(new Error('LISTENER_WEB_MATERIALS_INVALID'), { cleanup, readCleanup: runtime.read, drainCleanup: runtime.drain });
  }
  try { assertSelected?.(); }
  catch (cause) {
    const cleanup = await runtime.drain();
    throw Object.assign(new Error('LISTENER_START_CANCELLED', { cause }), { cleanup, readCleanup: runtime.read, drainCleanup: runtime.drain });
  }
  let state: ListenerState = 'running';
  let admitting = true;
  let authority = '';
  const origin = new URL(registration.origin);
  const tasks = new Set<Promise<void>>();
  const sockets = new Set<Socket>();
  const server = createServer({ headersTimeout: 10000, requestTimeout: 30000 }, (request, response) => {
    if (!admitting) {
      response.statusCode = 503;
      response.end('Service stopping');
      return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const responseClosed = () => { if (!response.writableFinished) abort(); };
    request.once('aborted', abort);
    response.once('close', responseClosed);
    const task = (async () => {
      try {
        const url = requestUrl(request, origin, authority);
        if (!url) {
          response.statusCode = 400;
          response.end('Invalid request target');
          return;
        }
        if (Number(request.headers['content-length']) > maxBodyBytes) {
          response.statusCode = 413;
          response.setHeader('connection', 'close');
          response.end('Request body too large');
          return;
        }
        const api = url.pathname === '/healthz' || url.pathname === '/api' || url.pathname.startsWith('/api/');
        if (!api && await serveStatic(request, response, materials, url.pathname)) return;
        const result = await runtime.app.fetch(honoRequest(request, url, controller.signal));
        await writeResponse(result, response, controller.signal);
      } catch {
        if (!response.headersSent && !response.destroyed) {
          response.statusCode = 500;
          response.end('Internal service error');
        } else if (!response.writableEnded) response.destroy();
      } finally {
        request.removeListener('aborted', abort);
        response.removeListener('close', responseClosed);
      }
    })();
    tasks.add(task);
    void task.then(() => tasks.delete(task), () => tasks.delete(task));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  try {
    await new Promise<void>((resolveListen, reject) => {
      const error = (cause: Error) => { server.removeListener('listening', listening); reject(cause); };
      const listening = () => { server.removeListener('error', error); resolveListen(); };
      server.once('error', error);
      server.once('listening', listening);
      server.listen(registration.port, registration.host);
    });
  } catch {
    const cleanup = await runtime.drain();
    throw Object.assign(new Error('LISTENER_BIND_FAILED'), { cleanup, readCleanup: runtime.read, drainCleanup: runtime.drain });
  }
  let ingressFailed = false;
  let closing: Promise<void> | undefined;
  const address = server.address();
  const hostname = registration.host === '::1' ? '[::1]' : registration.host;
  if (!address || typeof address === 'string') {
    stop();
    const cleanup = await runtime.drain();
    throw Object.assign(new Error('LISTENER_ADDRESS_INVALID'), { cleanup, readCleanup: runtime.read, drainCleanup: runtime.drain });
  }

  authority = hostname + ':' + address.port;
  const url = 'http://' + authority;
  function stopIngress(stopRuntime = false) {
    if (!admitting) return;
    admitting = false;
    state = 'draining';
    // Runtime joins application handlers and real response producers before closing SQLite.
    // The remaining socket work only holds bridge buffers and the immutable Web files.
    if (stopRuntime) runtime.stop();
    const serverClosed = new Promise<boolean>((settle) => {
      server.close((error) => settle(!error));
    });
    closing = Promise.all([serverClosed, Promise.allSettled([...tasks])]).then(async ([closed]) => {
      if (closed) {
        await Promise.all([...sockets].map(socket => new Promise<void>(settle => {
          socket.once('close', () => settle());
        })));
      }
      state = closed ? 'closed' : 'close_failed';
    });
  }
  function stop() {
    stopIngress(true);
  }
  server.on('error', () => { ingressFailed = true; stop(); });

  function read() {
    return { listener: state, activeRequests: tasks.size, openConnections: sockets.size, runtime: runtime.read() };
  }

  async function drain({ timeoutMs = 5000 }: { timeoutMs?: number } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
      throw new Error('LISTENER_DRAIN_TIMEOUT_INVALID');
    }
    stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([closing, runtime.drain({ timeoutMs })]),
        new Promise<void>((settle) => { timer = setTimeout(settle, timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return read();
  }
  const ingress = Object.freeze({
    async stopIngress() {
      const signals = maintenanceSignals.get(runtime);
      if (signals) signals.held = true;
      const allSockets = [...sockets].map((socket) => new Promise<void>((settle) => socket.once('close', settle)));
      stopIngress();
      await Promise.all([closing, ...allSockets]);
      return !ingressFailed && state === 'closed' && tasks.size === 0 && sockets.size === 0;
    },
    onClose() { maintenanceSignals.get(runtime)?.settled(); },
  });
  startedIngress.set(runtime, ingress);
  const maintenance = await installRuntimeMaintenance(runtime, ingress);
  startedIngress.delete(runtime);
  if (ports.serviceOptions.assertStartupAllowed && runtime.read().status !== 'running') {
    stop();
    const cleanup = await drain();
    throw Object.assign(new Error('LISTENER_RUNTIME_NOT_RUNNING'), { cleanup, readCleanup: read, drainCleanup: drain });
  }
  return {
    url, stop, drain, read,
    async triggerConsultationTick() {
      if (!admitting) throw new Error('CONSULTATION_TRIGGER_STOPPED');
      const hub = provisioning.registration.operationalHub;
      if (ports.serviceOptions.consultationWorker?.mode !== 'manual' || !hub) {
        throw new Error('CONSULTATION_TRIGGER_NOT_CONFIGURED');
      }
      assertSelected?.();
      await assertHubIdentity(hub.origin, hub.commit);
      if (!admitting) throw new Error('CONSULTATION_TRIGGER_STOPPED');
      assertSelected?.();
      return runtime.triggerConsultationTick();
    },
    issueOwnerBootstrap() {
      if (!admitting) throw new Error('OWNER_BOOTSTRAP_UNAVAILABLE');
      assertSelected?.();
      return runtime.issueOwnerBootstrap();
    },
    ...(maintenance ? { maintenance } : {}),
  };
}

export async function runInstalledService(provisioning: RuntimeProvisioning, assertSelected?: () => void,
  options?: { manageSignals?: boolean }) {
  assertSelected?.();
  let runtime: ServiceRuntime;
  try { runtime = createInstalledService(provisioning); }
  catch (error) {
    const { code, ...cleanup } = await cleanRuntimeStartup(error);
    throw Object.assign(new Error(code), cleanup);
  }

  let received: 'SIGTERM' | 'SIGINT' | undefined;
  let listener: Awaited<ReturnType<typeof startServiceListener>> | undefined;
  type SignalResult = ReturnType<NonNullable<typeof listener>['read']> & { signal: 'SIGTERM' | 'SIGINT' };
  let settle!: (value: SignalResult) => void;
  const closed = new Promise<SignalResult>((resolveClosed) => { settle = resolveClosed; });
  let observing: NodeJS.Timeout | undefined;

  const uninstallSignals = () => {
    if (maintenanceSignals.get(runtime)?.held) return;
    process.off('SIGTERM', signal);
    process.off('SIGINT', signal);
    clearInterval(observing);
  };

  function monitorDrain() {
    if (!listener || !received || observing) return;
    const started = listener;
    const receivedSignal = received;
    void started.drain().then((result) => {
      settle({ ...result, signal: receivedSignal });
      if (result.listener === 'closed' && result.runtime.status === 'closed') uninstallSignals();
      else {
        process.exitCode = 1;
        // Keep ownership while cancellation is unconfirmed, including promises without an I/O handle.
        observing = setInterval(() => {
          const current = started.read();
          if (current.listener === 'closed' && current.runtime.status === 'closed') uninstallSignals();
        }, 250);
      }
    });
  }

  function signal(value: 'SIGTERM' | 'SIGINT') {
    if (received) return;
    received = value;
    if (!listener) runtime.stop();
    monitorDrain();
  }

  if (options?.manageSignals !== false) {
    process.on('SIGTERM', signal);
    process.on('SIGINT', signal);
  }
  try {
    maintenanceSignals.set(runtime, { held: false, settled() { this.held = false; uninstallSignals(); } });
    listener = await startServiceListener(runtime, provisioning, assertSelected);
    monitorDrain();
    return {
      ...listener,
      async drain(options?: { timeoutMs?: number }) {
        const result = await listener!.drain(options);
        if (result.listener === 'closed' && result.runtime.status === 'closed') uninstallSignals();
        return result;
      },
      closed,
    };
  } catch (error) {
    uninstallSignals();
    throw error;
  }
}

if (isRuntimeMain(import.meta.url)) {
  const result = unavailableRuntimeDiagnostic(
    'Provision the registered loopback listener, service identity, and independent recovery activation and binding ports.',
  );
  process.stderr.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}
