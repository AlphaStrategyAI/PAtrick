import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONSULTATION_WORKER, createHubClient, hubRules, PINNED_HUB_COMMIT, type HubClient, type HubKeys } from '../../packages/integrations/autoloop/client.js';

const REMOTE = 'https://github.com/KKKKhazix/agent-autoloop.git';

const PROBE_AGENT = `const mode = process.env.PATRICK_PROBE_MODE ?? 'idle';
if (mode === 'model') process.stderr.write('model-called\\n');
if (mode === 'native-waiting') process.stdout.write('no-op\\n');
else if (mode === 'native-claimed') process.stdout.write('claimed\\n');
else process.stdout.write('idle\\n');
`;

const BOOT = `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const home = process.env.AGENT_AUTOLOOP_HOME;
const root = process.env.PATRICK_AUTOLOOP_ROOT;
const pin = process.env.PATRICK_AUTOLOOP_COMMIT;
process.env.AGENT_AUTOLOOP_RULES = join(home, 'rules.json');
process.env.AGENT_AUTOLOOP_PUBLIC_URL = 'http://127.0.0.1';
process.env.AGENT_AUTOLOOP_COMMIT = pin;
const runtime = await import(pathToFileURL(join(root, 'host/runtime.ts')).href);
const http = await import(pathToFileURL(join(root, 'host/http.ts')).href);
const keysPath = join(home, 'probe-keys.json');
let keys;
if (existsSync(keysPath)) keys = JSON.parse(readFileSync(keysPath, 'utf8'));
else {
  keys = {
    owner: runtime.addKey('owner', 'owner'),
    worker: runtime.addKey('worker', 'w1'),
    consultationWorker: runtime.addKey('worker', '${CONSULTATION_WORKER}'),
    source: runtime.addKey('source', 'patrick'),
  };
  writeFileSync(keysPath, JSON.stringify(keys));
}
const server = http.serve(0, '127.0.0.1', { commit: pin });
await new Promise((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
process.stdout.write(JSON.stringify({ port: server.address().port, ...keys }) + '\\n');
const shutdown = () => {
  server.closeAllConnections();
  server.close();
  if (runtime.db?.isOpen) runtime.db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`;

const COMMAND_RUNNER = `import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [mode, contextFile] = process.argv.slice(2);
const root = process.env.PATRICK_AUTOLOOP_ROOT;
const plugin = (await import(pathToFileURL(join(root, 'plugins/command/agent.ts')).href)).default;
const argv = plugin.command({
  prompt: 'probe',
  command: [process.execPath, process.env.PATRICK_PROBE_SCRIPT],
  cwd: '/tmp',
  contextFile,
  access: 'read',
  session: 'probe',
  resume: null,
  folder: '/tmp',
});
const proc = spawnSync(argv[0], argv.slice(1), {
  encoding: 'utf8',
  env: { ...process.env, AGENT_AUTOLOOP_CONTEXT: contextFile, PATRICK_PROBE_MODE: mode },
});
const reading = plugin.read(proc.stdout ?? '', proc.status, proc.stderr ?? '');
process.stdout.write(JSON.stringify({
  command: argv.join(' '),
  exitCode: proc.status,
  stdout: proc.stdout,
  stderr: proc.stderr,
  reading,
  check: typeof plugin.check === 'function' ? plugin.check() : null,
}));
`;

export type PinnedHub = {
  baseUrl: string;
  home: string;
  source: string;
  client: HubClient;
  consultationClient: HubClient;
  keys: HubKeys;
  stop: () => Promise<void>;
};

export class PinnedHubError extends Error {
  readonly command: string;
  constructor(command: string, message: string) {
    super(message);
    this.command = command;
  }
}

let cachedSource: string | undefined;

export function pinnedAutoloopSource(): string {
  if (cachedSource) return cachedSource;
  const command = `git clone ${REMOTE} && git checkout ${PINNED_HUB_COMMIT}`;
  const candidates = [process.env.PATRICK_AUTOLOOP_SRC, '/tmp/agent-autoloop'].filter((dir): dir is string => Boolean(dir));
  for (const dir of candidates) {
    if (!existsSync(join(dir, 'plugins/command/agent.ts'))) continue;
    try {
      const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      if (head === PINNED_HUB_COMMIT) return cachedSource = dir;
      throw new PinnedHubError(`git -C ${dir} rev-parse HEAD`, `expected ${PINNED_HUB_COMMIT}, got ${head}`);
    } catch (error) {
      if (error instanceof PinnedHubError) throw error;
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'agent-autoloop-'));
  try {
    execFileSync('git', ['clone', '--quiet', REMOTE, dir], { stdio: 'pipe' });
    execFileSync('git', ['-C', dir, 'checkout', '--quiet', PINNED_HUB_COMMIT], { stdio: 'pipe' });
  } catch (error) {
    throw new PinnedHubError(command, error instanceof Error ? error.message : String(error));
  }
  return cachedSource = dir;
}

export async function startPinnedHub(existingHome?: string): Promise<PinnedHub> {
  const source = pinnedAutoloopSource();
  const home = existingHome ?? mkdtempSync(join(tmpdir(), 'patrick-t04-hub-'));
  mkdirSync(home, { recursive: true });
  const script = join(home, 'probe-agent.mjs');
  if (!existingHome) {
    writeFileSync(script, PROBE_AGENT);
    writeFileSync(join(home, 'rules.json'), `${JSON.stringify(hubRules([process.execPath, script]), null, 2)}\n`);
    writeFileSync(join(home, 'boot.mjs'), BOOT);
    writeFileSync(join(home, 'command-runner.mjs'), COMMAND_RUNNER);
  }
  const command = `node ${join(home, 'boot.mjs')}`;
  const child = spawn(process.execPath, [join(home, 'boot.mjs')], {
    env: {
      ...process.env,
      AGENT_AUTOLOOP_HOME: home,
      PATRICK_AUTOLOOP_ROOT: source,
      PATRICK_AUTOLOOP_COMMIT: PINNED_HUB_COMMIT,
      PATRICK_PROBE_SCRIPT: script,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const ready = JSON.parse(await readStdoutLine(child, command)) as { port: number; consultationWorker: string } & HubKeys;
    const url = `http://127.0.0.1:${ready.port}`;
    const client = createHubClient(url, ready);
    return {
      baseUrl: url,
      home,
      source,
      client,
      consultationClient: createHubClient(url, { ...ready, worker: ready.consultationWorker }),
      keys: { owner: ready.owner, worker: ready.worker, source: ready.source },
      stop: () => stopChild(child),
    };
  } catch (error) {
    child.kill('SIGKILL');
    if (error instanceof PinnedHubError) throw error;
    throw new PinnedHubError(command, error instanceof Error ? error.message : String(error));
  }
}

export type CommandPluginResult = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  reading: { text?: string; error?: string };
  check: string | null;
};

export function runCommandPlugin(hub: PinnedHub, mode: string, contextFile: string): CommandPluginResult {
  const command = `node ${join(hub.home, 'command-runner.mjs')} ${mode}`;
  const proc = execFileSync(process.execPath, [join(hub.home, 'command-runner.mjs'), mode, contextFile], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATRICK_AUTOLOOP_ROOT: hub.source,
      PATRICK_PROBE_SCRIPT: join(hub.home, 'probe-agent.mjs'),
    },
  });
  const parsed = JSON.parse(proc) as CommandPluginResult;
  parsed.command = command;
  return parsed;
}

function readStdoutLine(child: ChildProcess, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new PinnedHubError(command, `timed out starting hub\n${stderr}`));
    }, 20_000);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline >= 0) {
        clearTimeout(timer);
        resolve(stdout.slice(0, newline));
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new PinnedHubError(command, `hub exited ${code ?? 'null'} before ready\n${stderr}`));
    });
  });
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

