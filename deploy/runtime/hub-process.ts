import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { request } from 'node:http';

type PhysicalNode = Readonly<{ device: string; inode: string; birthtimeNs: string }>;

type HubProcessInput = Readonly<{
  entry: string;
  hubHome: string;
  rulesPath: string;
  rulesSha256: string;
  uid: number;
  gid: number;
  host: '127.0.0.1' | '::1';
  port: number;
  publicUrl: string;
  commit: string;
  database: PhysicalNode;
  writerFence: Readonly<{ path: string; node: PhysicalNode }>;
}>;

type HubProcessState = Readonly<{
  state: 'starting' | 'running' | 'draining' | 'closed';
  pid: number | undefined;
}>;

export type HubProcess = Readonly<{
  read(): HubProcessState;
  exited: Promise<HubProcessState>;
  activate(): Promise<void>;
  stop(): void;
  drain(options?: { timeoutMs?: number }): Promise<HubProcessState>;
}>;

const phaseTimeoutMs = 15_000;
const termGraceMs = 1_000;
const drainTimeoutMs = 3_000;
const faults = new Set([
  'HUB_PROCESS_IDENTITY_INVALID',
  'HUB_PROCESS_DATABASE_INVALID',
  'HUB_PROCESS_WRITER_FENCE_INVALID',
  'HUB_PROCESS_WRITER_FENCE_BUSY',
  'HUB_PROCESS_MASTER_KEY_INVALID',
  'HUB_PROCESS_RULES_INVALID',
  'HUB_PROCESS_PLUGINS_FORBIDDEN',
  'HUB_PROCESS_BIND_FAILED',
  'HUB_PROCESS_START_FAILED',
]);

const childSource = String.raw`
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const config = JSON.parse(process.argv[1]);
const databasePath = join(config.hubHome, 'hub.db');
const upstreamRoot = dirname(dirname(config.entry));
let server;
let database;
let writerFence;
let prepared = false;
let active = false;
let stopping = false;
let reporting = false;
let fault = 'HUB_PROCESS_START_FAILED';
const healthKey = randomBytes(32).toString('hex');

function assert(value, code) {
  if (!value) {
    fault = code;
    throw new Error(code);
  }
}

function matchesNode(info, node) {
  return String(info.dev) === node.device && String(info.ino) === node.inode && String(info.birthtimeNs) === node.birthtimeNs;
}

function checkWriterFencePath() {
  fault = 'HUB_PROCESS_WRITER_FENCE_INVALID';
  const { path, node } = config.writerFence;
  const info = lstatSync(path, { bigint: true });
  assert(path !== databasePath && realpathSync.native(path) === path && info.isFile() && info.nlink === 1n &&
    info.uid === BigInt(config.uid) && (info.mode & 0o7777n) === 0o600n &&
    matchesNode(info, node) && !matchesNode(info, config.database), fault);
}

function checkWriterFence() {
  checkWriterFencePath();
  const main = writerFence.prepare('PRAGMA database_list').all().filter(record => record.name === 'main');
  assert(writerFence.isTransaction && main.length === 1 && main[0].file === config.writerFence.path, fault);
}

function acquireWriterFence() {
  checkWriterFencePath();
  writerFence = new DatabaseSync(config.writerFence.path, { timeout: 0 });
  checkWriterFencePath();
  try {
    writerFence.exec('BEGIN IMMEDIATE');
  } catch (error) {
    if ([5, 6].includes(error?.errcode & 0xff)) fault = 'HUB_PROCESS_WRITER_FENCE_BUSY';
    throw error;
  }
  checkWriterFence();
  assert(writerFence.prepare('PRAGMA journal_mode').get()?.journal_mode === 'delete' &&
    writerFence.prepare('PRAGMA user_version').get()?.user_version === 1, fault);
}

function checkDatabase() {
  fault = 'HUB_PROCESS_DATABASE_INVALID';
  const home = lstatSync(config.hubHome, { bigint: true });
  const info = lstatSync(databasePath, { bigint: true });
  assert(home.isDirectory() && (home.mode & 0o7777n) === 0o700n && home.uid === BigInt(config.uid) &&
    realpathSync.native(databasePath) === databasePath && info.isFile() && info.nlink === 1n &&
    info.uid === BigInt(config.uid) && (info.mode & 0o022n) === 0n &&
    matchesNode(info, config.database), fault);
  if (database) {
    const main = database.prepare('PRAGMA database_list').all().filter(record => record.name === 'main');
    assert(main.length === 1 && main[0].file === databasePath, fault);
  }
}

function checkPlugins() {
  fault = 'HUB_PROCESS_PLUGINS_FORBIDDEN';
  for (const root of [config.hubHome, upstreamRoot]) {
    assert(!lstatSync(join(root, 'plugins'), { throwIfNoEntry: false }), fault);
  }
}

function checkMasterKey(allowInitialization = false) {
  fault = 'HUB_PROCESS_MASTER_KEY_INVALID';
  const path = join(config.hubHome, 'master.key');
  const info = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (info) {
    assert(info.isFile() && info.nlink === 1n && info.uid === BigInt(config.uid) &&
      (info.mode & 0o7777n) === 0o600n && info.size >= 43n && info.size <= 45n &&
      realpathSync.native(path) === path, fault);
    return;
  }
  assert(allowInitialization, fault);
  const existing = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert(!existing.prepare('SELECT 1 FROM facts LIMIT 1').get(), fault);
  } finally { existing.close(); }
}

function readRules() {
  fault = 'HUB_PROCESS_RULES_INVALID';
  assert(realpathSync.native(config.rulesPath) === config.rulesPath, fault);
  const fd = openSync(config.rulesPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd, { bigint: true });
    let writable = true;
    try {
      accessSync(config.rulesPath, constants.W_OK);
    } catch (error) {
      if (!['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) throw error;
      writable = false;
    }
    const limit = 1024 * 1024;
    assert(!writable && info.isFile() && info.nlink === 1n && (info.mode & 0o022n) === 0n &&
      info.size > 0n && info.size <= BigInt(limit), fault);
    const buffer = Buffer.alloc(Number(info.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const observed = lstatSync(config.rulesPath, { bigint: true });
    const identity = value => [value.dev, value.ino, value.birthtimeNs, value.ctimeNs, value.mtimeNs,
      value.mode, value.uid, value.gid, value.nlink, value.size].join(':');
    assert(length === Number(info.size) && identity(observed) === identity(info) &&
      realpathSync.native(config.rulesPath) === config.rulesPath, fault);
    const bytes = buffer.subarray(0, length);
    assert(createHash('sha256').update(bytes).digest('hex') === config.rulesSha256, fault);
    return { identity: identity(info), text: bytes.toString('utf8') };
  } finally {
    closeSync(fd);
  }
}

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  active = false;
  const deadline = setTimeout(() => process.exit(1), ${termGraceMs}).unref();
  function finish(error) {
    clearTimeout(deadline);
    try {
      if (database?.isOpen) database.close();
    } catch {
      code = 1;
    }
    process.exit(error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? 1 : code);
  }
  if (!server) return finish();
  try {
    server.close(finish);
    server.closeAllConnections();
  } catch {
    finish(new Error());
  }
}

function fail(code) {
  if (stopping || reporting) return;
  reporting = true;
  active = false;
  if (process.connected) {
    const deadline = setTimeout(() => shutdown(1), 100);
    try {
      process.send({ type: 'failed', code }, () => {
        clearTimeout(deadline);
        shutdown(1);
      });
      return;
    } catch {
      clearTimeout(deadline);
    }
  }
  shutdown(1);
}

process.on('disconnect', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('uncaughtException', () => fail('HUB_PROCESS_START_FAILED'));
process.on('unhandledRejection', () => fail('HUB_PROCESS_START_FAILED'));

async function loadRuntimeWithPinnedRules(text) {
  const runtimeUrl = pathToFileURL(join(upstreamRoot, 'host/runtime.ts')).href;
  const pinnedFs = 'data:text/javascript;base64,' + Buffer.from([
    'import { readFileSync as read } from "node:fs";',
    'export { existsSync, writeFileSync } from "node:fs";',
    'export function readFileSync(file, options) {',
    '  return file === ' + JSON.stringify(config.rulesPath) + ' ? ' + JSON.stringify(text) + ' : read(file, options);',
    '}',
  ].join('\n')).toString('base64');
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'node:fs' && context.parentURL === runtimeUrl) {
        return { url: pinnedFs, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  try { return await import(runtimeUrl); }
  finally { hook.deregister(); }
}

async function prepare() {
  checkWriterFence();
  checkDatabase();
  checkPlugins();
  const rules = readRules();
  const { parseRules } = await import(pathToFileURL(join(upstreamRoot, 'protocol/rules.ts')).href);
  fault = 'HUB_PROCESS_RULES_INVALID';
  const expected = parseRules(rules.text, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert(!Object.values(expected.sources).some(source => Object.hasOwn(source, 'adapter')), 'HUB_PROCESS_PLUGINS_FORBIDDEN');
  checkDatabase();
  checkPlugins();
  assert(readRules().identity === rules.identity, 'HUB_PROCESS_RULES_INVALID');
  checkWriterFence();
  checkMasterKey(true);
  fault = 'HUB_PROCESS_START_FAILED';
  const runtime = await loadRuntimeWithPinnedRules(rules.text);
  database = runtime.db;
  checkWriterFence();
  checkDatabase();
  checkMasterKey();
  assert(JSON.stringify(runtime.rules) === JSON.stringify(expected) &&
    readRules().identity === rules.identity, 'HUB_PROCESS_RULES_INVALID');
  fault = 'HUB_PROCESS_START_FAILED';
  const { serve } = await import(pathToFileURL(config.entry).href);
  checkWriterFence();
  fault = 'HUB_PROCESS_BIND_FAILED';
  server = serve(config.port, config.host, { commit: config.commit });
  const handlers = server.listeners('request');
  assert(handlers.length === 1, fault);
  const handler = handlers[0];
  server.removeListener('request', handler);
  server.on('request', (request, response) => {
    if (!active) return response.writeHead(503, { connection: 'close' }).end();
    const challenge = request.headers['x-patrick-hub-challenge'];
    if (request.method === 'GET' && request.url === '/healthz' && typeof challenge === 'string' && /^[a-f0-9]{64}$/.test(challenge)) {
      response.setHeader('x-patrick-hub-proof', createHmac('sha256', healthKey).update(challenge).digest('hex'));
    }
    return handler.call(server, request, response);
  });
  server.on('error', () => fail('HUB_PROCESS_BIND_FAILED'));
  server.once('listening', () => {
    try {
      const address = server.address();
      assert(address && address.address === config.host && address.port > 0 &&
        (!config.port || address.port === config.port), 'HUB_PROCESS_BIND_FAILED');
      checkWriterFence();
      checkDatabase();
      checkPlugins();
      assert(readRules().identity === rules.identity && JSON.stringify(runtime.rules) === JSON.stringify(expected),
        'HUB_PROCESS_RULES_INVALID');
      prepared = true;
      process.send({ type: 'bound', pid: process.pid, port: address.port, healthKey }, error => {
        if (error) shutdown(1);
      });
    } catch {
      fail(fault);
    }
  });
  process.on('message', message => {
    try {
      assert(prepared && !active && !stopping && !reporting && message === 'activate' && server.listening,
        'HUB_PROCESS_START_FAILED');
      checkWriterFence();
      checkDatabase();
      checkPlugins();
      assert(readRules().identity === rules.identity && JSON.stringify(runtime.rules) === JSON.stringify(expected),
        'HUB_PROCESS_RULES_INVALID');
      active = true;
      process.send({ type: 'active', pid: process.pid }, error => {
        if (error) shutdown(1);
      });
    } catch {
      fail(fault);
    }
  });
}

try {
  assert(process.getuid() === config.uid && process.geteuid() === config.uid &&
    process.getgid() === config.gid && process.getegid() === config.gid, 'HUB_PROCESS_IDENTITY_INVALID');
  process.umask(0o077);
  acquireWriterFence();
  process.once('message', message => {
    try {
      assert(message === 'prepare' && process.connected && !stopping && !reporting, 'HUB_PROCESS_START_FAILED');
      void prepare().catch(() => fail(fault));
    } catch {
      fail(fault);
    }
  });
  process.send({ type: 'fenced', pid: process.pid }, error => {
    if (error) shutdown(1);
  });
} catch {
  fail(fault);
}
`;

function checkHealth(host: HubProcessInput['host'], port: number, commit: string, key: string, signal: AbortSignal): Promise<void> {
  const challenge = randomBytes(32).toString('hex');
  const proof = createHmac('sha256', key).update(challenge).digest('hex');
  return new Promise((resolve, reject) => {
    const invalid = () => reject(new Error('HUB_PROCESS_HEALTH_FAILED'));
    const outgoing = request({ hostname: host, port, path: '/healthz', agent: false, signal,
      headers: { 'x-patrick-hub-challenge': challenge } }, response => {
      response.on('error', invalid);
      response.on('aborted', invalid);
      if (response.statusCode !== 200 || response.headers['x-patrick-hub-proof'] !== proof) {
        response.destroy();
        invalid();
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024) {
          response.destroy();
          invalid();
        } else chunks.push(chunk);
      });
      response.once('end', () => {
        try {
          const health = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (health?.ok === true && health.commit === commit) {
            resolve();
            return;
          }
        } catch { void 0; }
        invalid();
      });
    });
    outgoing.once('error', invalid);
    outgoing.end();
  });
}

export async function startHubProcess(input: HubProcessInput, guard: () => void,
  onSpawn: (runtime: HubProcess) => void): Promise<HubProcess> {
  const config = { ...input, database: { ...input.database },
    writerFence: { path: input.writerFence.path, node: { ...input.writerFence.node } } };
  if (!['127.0.0.1', '::1'].includes(config.host) || !Number.isInteger(config.port) ||
      config.port < 0 || config.port > 65535 || !Number.isSafeInteger(config.uid) || config.uid < 0 ||
      !Number.isSafeInteger(config.gid) || config.gid < 0 || !/^[a-f0-9]{40}$/.test(config.commit) ||
      !/^[a-f0-9]{64}$/.test(config.rulesSha256)) throw new Error('HUB_PROCESS_INPUT_INVALID');
  guard();
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, ['--no-addons', '--input-type=module', '--eval', childSource, '--', JSON.stringify(config)], {
      cwd: config.hubHome,
      env: {
        HOME: config.hubHome,
        AGENT_AUTOLOOP_HOME: config.hubHome,
        AGENT_AUTOLOOP_RULES: config.rulesPath,
        AGENT_AUTOLOOP_PUBLIC_URL: config.publicUrl,
      },
      ...(config.uid === process.getuid!() ? {} : { uid: config.uid }),
      ...(config.gid === process.getgid!() ? {} : { gid: config.gid }),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      shell: false,
    });
  } catch {
    throw new Error('HUB_PROCESS_SPAWN_FAILED');
  }
  const pid = child.pid;
  let state: HubProcessState['state'] = 'starting';
  let bound: { port: number; healthKey: string } | undefined;
  let failure: Error | undefined;
  let activation: Promise<void> | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  type Report = 'fenced' | 'bound' | 'active';
  let awaiting: { type: Report; finish(error?: Error): void } | undefined;
  let settleExit!: (result: HubProcessState) => void;
  const exited = new Promise<HubProcessState>(resolve => { settleExit = resolve; });
  const exitWaiters = new Set<() => void>();
  const stopped = new AbortController();
  const read = (): HubProcessState => ({ state, pid });

  function stop() {
    if (state === 'closed' || state === 'draining') return;
    state = 'draining';
    awaiting?.finish(failure ?? new Error('HUB_PROCESS_STOPPED'));
    stopped.abort();
    if (pid === undefined) return;
    child.kill('SIGTERM');
    escalation = setTimeout(() => {
      if (state !== 'closed') child.kill('SIGKILL');
    }, termGraceMs);
  }

  function fail(code: string) {
    failure ??= new Error(code);
    stop();
  }

  function finishExit() {
    if (state === 'closed') return;
    failure ??= new Error('HUB_PROCESS_EXITED');
    state = 'closed';
    clearTimeout(escalation);
    awaiting?.finish(failure);
    stopped.abort();
    child.removeListener('message', onMessage);
    const result = read();
    settleExit(result);
    for (const notify of exitWaiters) notify();
  }

  function onMessage(message: unknown) {
    if (state === 'closed' || state === 'draining') return;
    if (message === null || typeof message !== 'object') return fail('HUB_PROCESS_PROTOCOL_INVALID');
    const report = message as { type?: unknown; pid?: unknown; port?: unknown; code?: unknown; healthKey?: unknown };
    if (report.type === 'failed') {
      return fail(typeof report.code === 'string' && faults.has(report.code) ? report.code : 'HUB_PROCESS_START_FAILED');
    }
    if (!awaiting || report.type !== awaiting.type || pid === undefined || report.pid !== pid) {
      return fail('HUB_PROCESS_PROTOCOL_INVALID');
    }
    if (report.type === 'bound') {
      if (typeof report.port !== 'number' || !Number.isInteger(report.port) || report.port < 1 || report.port > 65535 ||
          (config.port !== 0 && report.port !== config.port) || typeof report.healthKey !== 'string' ||
          !/^[a-f0-9]{64}$/.test(report.healthKey)) return fail('HUB_PROCESS_PROTOCOL_INVALID');
      bound = { port: report.port, healthKey: report.healthKey };
    }
    awaiting.finish();
  }

  child.on('message', onMessage);
  child.on('error', () => fail(pid === undefined ? 'HUB_PROCESS_SPAWN_FAILED' : 'HUB_PROCESS_CHILD_FAILED'));
  child.once('disconnect', () => fail('HUB_PROCESS_DISCONNECTED'));
  child.once('exit', finishExit);
  child.once('close', finishExit);

  function waitForReport(type: Report): Promise<void> {
    return new Promise((resolve, reject) => {
      if (failure || state !== 'starting' || awaiting) {
        reject(failure ?? new Error('HUB_PROCESS_STOPPED'));
        return;
      }
      const timer = setTimeout(() => fail('HUB_PROCESS_TIMEOUT'), phaseTimeoutMs);
      awaiting = { type, finish(error) {
        clearTimeout(timer);
        awaiting = undefined;
        if (error) reject(error);
        else resolve();
      } };
    });
  }

  async function sendAndWait(message: 'prepare' | 'activate', type: 'bound' | 'active'): Promise<void> {
    const report = waitForReport(type);
    if (awaiting) {
      try {
        child.send(message, error => { if (error) fail('HUB_PROCESS_DISCONNECTED'); });
      } catch {
        fail('HUB_PROCESS_DISCONNECTED');
      }
    }
    await report;
  }

  async function drain(options?: { timeoutMs?: number }): Promise<HubProcessState> {
    const timeout = options?.timeoutMs ?? drainTimeoutMs;
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 0x7fffffff) throw new Error('HUB_PROCESS_INPUT_INVALID');
    stop();
    if (state === 'closed' || timeout === 0) return read();
    return new Promise(resolve => {
      const timer = setTimeout(finish, timeout);
      exitWaiters.add(finish);
      function finish() {
        clearTimeout(timer);
        exitWaiters.delete(finish);
        resolve(read());
      }
    });
  }

  async function cleanup() {
    if ((await drain()).state !== 'closed') {
      throw Object.assign(new Error('HUB_PROCESS_CLEANUP_UNCONFIRMED'), { readCleanup: read, drainCleanup: drain, exited });
    }
  }

  function activate(): Promise<void> {
    if (state === 'running') return Promise.resolve();
    if (state !== 'starting') return Promise.reject(failure ?? new Error('HUB_PROCESS_STOPPED'));
    if (!prepared) return Promise.reject(new Error('HUB_PROCESS_NOT_PREPARED'));
    const listener = bound!;
    activation ??= (async () => {
      let ready = false;
      try {
        await sendAndWait('activate', 'active');
        await checkHealth(config.host, listener.port, config.commit, listener.healthKey, AbortSignal.any([
          stopped.signal, AbortSignal.timeout(phaseTimeoutMs),
        ]));
        if (failure || state !== 'starting') throw failure ?? new Error('HUB_PROCESS_STOPPED');
        state = 'running';
        ready = true;
      } finally {
        if (!ready) await cleanup();
      }
    })();
    return activation;
  }

  let prepared = false;
  const runtime = Object.freeze({ read, exited, activate, stop, drain });
  try {
    onSpawn(runtime);
    await waitForReport('fenced');
    if (failure) throw failure;
    guard();
    await sendAndWait('prepare', 'bound');
    if (failure) throw failure;
    guard();
    prepared = true;
    return runtime;
  } finally {
    if (!prepared) await cleanup();
  }
}
