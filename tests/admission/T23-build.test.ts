import { createHash, generateKeyPairSync } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { setTimeout as setTimer, clearTimeout as clearTimer } from 'node:timers';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const buildScript = join(root, 'scripts/build-runtime.mjs');
const commitResult = spawnSync('/usr/bin/git', ['--no-replace-objects', '-C', root, 'rev-parse', 'HEAD'], {
  env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8',
});
const sourceCommit = commitResult.stdout.trim();
let snapshotSha256: string | undefined;
let temporary = '';
let built = '';
let relocated = '';

type Run = ReturnType<typeof spawnSync>;

function runNode(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Run {
  return spawnSync(process.execPath, args, {
    cwd: options.cwd ?? root,
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      ...options.env,
      NODE_OPTIONS: '',
      NODE_PATH: '',
      TS_NODE_PROJECT: '',
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
}

function output(run: Run): string {
  return `${run.stdout ?? ''}${run.stderr ?? ''}`;
}

type SignalChild = ChildProcessByStdio<null, Readable, Readable>;
type ChildExit = { code: number | null; signal: NodeJS.Signals | null };

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<undefined>((done) => { timer = setTimer(() => done(undefined), milliseconds); })]);
  } finally {
    clearTimer(timer);
  }
}

async function runSignalHarness(
  child: SignalChild, signal: 'SIGTERM' | 'SIGINT', deadlines = { ready: 15_000, graceful: 5_000, reap: 2_000 },
) {
  let stdout = '';
  let stderr = '';
  let ready!: () => void;
  let spawnError: Error | undefined;
  let exit: ChildExit | undefined;
  const readyLine = new Promise<void>((done) => { ready = done; });
  function onStdout(chunk: string) {
    stdout += chunk;
    if (stdout.includes('\n')) ready();
  }
  function onStderr(chunk: string) { stderr += chunk; }
  function onError(error: Error) { spawnError = error; }
  child.stdout.setEncoding('utf8').on('data', onStdout);
  child.stderr.setEncoding('utf8').on('data', onStderr);
  child.on('error', onError);
  const exited = new Promise<ChildExit>((done) => child.once('close', (code, signal) => {
    exit = { code, signal };
    done(exit);
  }));
  try {
    const first = await bounded(Promise.race([readyLine.then(() => 'ready'), exited.then(() => 'exited')]), deadlines.ready);
    if (first !== 'ready' || exit) throw new Error(`signal harness ${first ?? 'readiness timeout'}: ${spawnError?.message ?? ''}${stdout}${stderr}`);
    child.kill(signal);
    const result = await bounded(exited, deadlines.graceful);
    if (!result) throw new Error(`signal harness exit timeout: ${stdout}${stderr}`);
    return { ...result, stdout, stderr };
  } finally {
    try {
      if (!exit) {
        child.kill('SIGTERM');
        if (!await bounded(exited, deadlines.graceful)) {
          child.kill('SIGKILL');
          const reaped = await bounded(exited, deadlines.reap);
          expect(reaped, 'test-owned signal child did not reap').toBeDefined();
        }
      }
    } finally {
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('error', onError);
    }
  }
}

async function checkoutDependencyReadTargets() {
  const paths = [
    join(root, 'node_modules/better-sqlite3/package.json'),
    join(root, 'node_modules/esbuild/package.json'),
    join(root, 'apps/web/node_modules/vite/package.json'),
    join(root, 'node_modules/.vite'),
    join(process.env.npm_config_cache ?? join(homedir(), '.npm'), '_cacache'),
  ];
  const physical = await Promise.all(paths.map((path) => realpath(path).catch(() => path)));
  return [...new Set([...paths, ...physical])];
}

async function copyArtifact(name: string): Promise<string> {
  const target = join(temporary, name);
  await cp(relocated, target, { recursive: true, force: false, errorOnExist: true });
  return target;
}

beforeAll(async () => {
  temporary = await mkdtemp(join(await realpath(tmpdir()), 'patrick-t23-build-'));
  built = join(temporary, 'built');
  relocated = join(temporary, 'relocated');
  const snapshot = runNode([buildScript, 'snapshot', '--source-root', root, '--source-commit', sourceCommit]);
  expect(snapshot.status, output(snapshot)).toBe(0);
  const captured = JSON.parse(String(snapshot.stdout)) as { changed: boolean; snapshotSha256: string };
  snapshotSha256 = captured.changed ? captured.snapshotSha256 : undefined;
  const result = runNode([buildScript, 'build', '--source-root', root, '--output-root', built,
    '--source-commit', sourceCommit, ...(snapshotSha256 ? ['--source-snapshot', snapshotSha256] : [])]);
  expect(output(result), output(result)).toContain('"status":"built"');
  expect(result.status, output(result)).toBe(0);
  await cp(built, relocated, { recursive: true, force: false, errorOnExist: true });
});

afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

describe('T23 installed runtime build and bootstrap', () => {
  test('v3 requires explicit independent native build authority', () => {
    const selection = ['--source-root', root, '--source-commit', sourceCommit, '--profile', 'deployment-complete-native-v3'];
    const capture = runNode([buildScript, 'snapshot', ...selection]);
    expect(capture.status, output(capture)).toBe(0);
    const snapshot = JSON.parse(String(capture.stdout));
    expect(snapshot.profile).toBe('deployment-complete-native-v3');
    const build = runNode([buildScript, 'build', ...selection, '--source-snapshot', snapshot.snapshotSha256,
      '--output-root', join(temporary, 'missing-v3-authority')]);
    expect(build.status).toBe(1);
    expect(output(build)).toContain('RUNTIME_DIRECTORY_AUTHORITY_REQUIRED');
  });

  test('legacy byte verification rejects a native-v3 version claim on the old graph', async () => {
    const artifact = await copyArtifact('mixed');
    const path = join(artifact, 'metadata/runtime-materials.json');
    const inventory = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...inventory, directoryBuildSha256: '0'.repeat(64) }));
    const result = runNode([buildScript, 'verify', '--artifact-root', artifact]);
    expect(result.status, output(result)).toBe(1);
    expect(output(result)).toContain('RUNTIME_INVENTORY_INVALID');
  });

  test('legacy inventory verifies only its declared observation fields', async () => {
    const artifact = await copyArtifact('legacy-observation');
    const path = join(artifact, 'metadata/runtime-materials.json');
    const inv = JSON.parse(await readFile(path, 'utf8'));
    inv.observed.napi = '10';
    await writeFile(path, JSON.stringify(inv));
    const result = runNode([buildScript, 'verify', '--artifact-root', artifact]);
    expect(result.status, output(result)).toBe(1);
    expect(output(result)).toContain('RUNTIME_INVENTORY_INVALID');
  });

  test.skipIf(!process.env.PATRICK_T25_TEST_RECIPE)('v3 requires independently supplied linker libraries', async () => {
    const authority = JSON.parse(await readFile(process.env.PATRICK_T25_TEST_RECIPE!, 'utf8'));
    delete authority.linkerLibraries;
    const path = join(temporary, 'no-linker-inputs.json'), raw = JSON.stringify(authority);
    await writeFile(path, raw);
    const selection = ['--source-root', root, '--source-commit', sourceCommit, '--profile', 'deployment-complete-native-v3'];
    const snapshot = runNode([buildScript, 'snapshot', ...selection]);
    expect(snapshot.status, output(snapshot)).toBe(0);
    const result = runNode([buildScript, 'build', ...selection, '--source-snapshot', JSON.parse(String(snapshot.stdout)).snapshotSha256,
      '--directory-authority', path, '--directory-authority-sha256', createHash('sha256').update(raw).digest('hex'),
      '--node-headers', process.env.PATRICK_T25_NODE_HEADERS_ARCHIVE!, '--output-root', join(temporary, 'no-linker-inputs')]);
    expect(result.status, output(result).slice(0, 160)).toBe(1);
    expect(output(result)).toContain('RUNTIME_DIRECTORY_LINKER_CLOSURE_INVALID');
  }, 120_000);

  test.skipIf(!process.env.PATRICK_T25_TEST_RECIPE)('v3 rejects an unapproved recipe, compiler or SQLite observation', async () => {
    const recipePath = process.env.PATRICK_T25_TEST_RECIPE!;
    const approved = await readFile(recipePath);
    const selection = ['--source-root', root, '--source-commit', sourceCommit, '--profile', 'deployment-complete-native-v3'];
    const capture = runNode([buildScript, 'snapshot', ...selection]);
    expect(capture.status, output(capture)).toBe(0);
    const args = [buildScript, 'build', ...selection, '--source-snapshot', JSON.parse(String(capture.stdout)).snapshotSha256,
      '--node-headers', process.env.PATRICK_T25_NODE_HEADERS_ARCHIVE!, '--output-root', join(temporary, 'refused-native')];
    const mismatch = runNode([...args, '--directory-authority', recipePath, '--directory-authority-sha256', '0'.repeat(64)]);
    expect(output(mismatch)).toContain('RUNTIME_DIRECTORY_AUTHORITY_MISMATCH');
    // Preserve the canonical key order in this supplied test configuration.
    for (const [key, code] of [
      ['recipe', 'RUNTIME_DIRECTORY_MATERIAL_INVALID'], ['compiler', 'RUNTIME_DIRECTORY_TOOL_MISMATCH'],
      ['unmatched-target', 'RUNTIME_DIRECTORY_RECIPE_TARGET_MISMATCH'], ['linker-library', 'RUNTIME_DIRECTORY_LINKER_LIBRARY_MISMATCH'], ['sqlite', 'RUNTIME_DIRECTORY_SQLITE_OBSERVATION_MISMATCH'],
    ]) {
      const a = JSON.parse(approved.toString());
      if (key === 'recipe') a.recipe = 'unapproved';
      if (key === 'compiler') a.tools.compiler = '0'.repeat(64);
      if (key === 'unmatched-target') a.target.arch = 'x64';
      if (key === 'linker-library') a.linkerLibraries['libtapi.dylib'] = '0'.repeat(64);
      if (key === 'sqlite') a.sqliteObservation.packageFilesSha256 = '0'.repeat(64);
      const raw = JSON.stringify(a);
      const file = join(temporary, key + '.json');
      await writeFile(file, raw);
      const run = runNode([...args, '--directory-authority', file, '--directory-authority-sha256',
        createHash('sha256').update(raw).digest('hex')]);
      expect(run.status).toBe(1);
      expect(output(run)).toContain(code);
    }
  }, 120_000);

  test('emits one exhaustive safe runtime inventory and verifies relocated bytes', async () => {
    const inventory = JSON.parse(await readFile(join(relocated, 'metadata/runtime-materials.json'), 'utf8')) as {
      schemaVersion: number;
      materialKind: string;
      source: { commit: string; snapshotSha256: string; lockSha256: string };
      tools: { esbuild: string; vite: string };
      observed: { platform: string; arch: string; node: string; modules: string; npm: string };
      native: { path: string; sha256: string; observedArchitecture: string; observedLoad: boolean };
      files: Array<{ path: string; role: string; bytes: number; sha256: string; mode: string }>;
    };
    expect(inventory).toMatchObject({
      schemaVersion: 1,
      materialKind: 'emitted-runtime-materials',
      source: { commit: sourceCommit },
      tools: { esbuild: '0.28.2', vite: '7.3.8' },
      observed: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        modules: process.versions.modules,
      },
      native: { observedArchitecture: process.arch, observedLoad: true },
    });
    expect(inventory.observed.npm).toMatch(/^\d+\.\d+\.\d+$/);
    expect(inventory.source.snapshotSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(inventory.source.lockSha256).toBe(
      createHash('sha256').update(await readFile(join(root, 'package-lock.json'))).digest('hex'),
    );
    expect(inventory.files.map((file) => file.path)).toEqual([...inventory.files.map((file) => file.path)].sort());
    expect(new Set(inventory.files.map((file) => file.path)).size).toBe(inventory.files.length);
    expect(inventory.files.some((file) => file.path === 'runtime/composition.mjs' && file.role === 'runtime-entry')).toBe(true);
    expect(inventory.files.some((file) => file.path === 'runtime/service.mjs' && file.role === 'runtime-entry')).toBe(true);
    expect(inventory.files.some((file) => file.path === 'runtime/cli.mjs' && file.role === 'runtime-entry')).toBe(true);
    expect(inventory.files.some((file) => file.path === 'runtime/worker.mjs' && file.role === 'runtime-entry')).toBe(true);
    expect(inventory.files.some((file) => file.role === 'runtime-shared-chunk')).toBe(true);
    expect(inventory.files.some((file) => file.path === 'migrations/manifest.json' && file.role === 'storage-migration-manifest')).toBe(true);
    expect(inventory.files.some((file) => file.path === 'web/index.html' && file.role === 'web-entry')).toBe(true);
    expect(inventory.files.some((file) => file.path === inventory.native.path && file.role === 'native-addon')).toBe(true);
    expect(inventory.files.every((file) =>
      !file.path.startsWith('/') && !file.path.includes('..') && file.bytes >= 0 &&
      /^[a-f0-9]{64}$/.test(file.sha256) && /^(100644|100755)$/.test(file.mode))).toBe(true);

    const verified = runNode([buildScript, 'verify', '--artifact-root', relocated]);
    expect(verified.status, output(verified)).toBe(0);
    expect(output(verified)).toContain('"status":"verified"');
  });

  test('rejects a build labelled with a nonexistent commit', () => {
    const result = runNode([buildScript, 'build', '--source-root', root, '--output-root',
      join(temporary, 'wrong-commit'), '--source-commit', '1'.repeat(40)]);
    expect(result.status, output(result)).toBe(1);
    expect(output(result)).toContain('RUNTIME_SOURCE_COMMIT_INVALID');
    const input = [buildScript, 'build', '--source-root', root, '--output-root',
      join(temporary, 'false-pin'), '--source-commit', sourceCommit, '--source-snapshot', '0'.repeat(64)];
    const falsePin = runNode(input);
    expect(output(falsePin)).toContain('RUNTIME_SOURCE_SNAPSHOT_MISMATCH');
    const redirected = runNode(input, { env: { GIT_REPLACE_REF_BASE: 'refs/test/' } });
    expect(output(redirected)).toContain('RUNTIME_GIT_ENVIRONMENT_FORBIDDEN');
  });

  test('rejects a copied executing recipe with another source root and valid pin', async () => {
    const foreign = join(temporary, 'foreign');
    for (const path of ['scripts/build-runtime.mjs', 'deploy/lib/release.mjs']) {
      await mkdir(dirname(join(foreign, path)), { recursive: true });
      await cp(join(root, path), join(foreign, path));
    }
    const result = runNode([join(foreign, 'scripts/build-runtime.mjs'), 'build', '--source-root', root,
      '--source-commit', sourceCommit, '--output-root', join(temporary, 'foreign-output'),
      ...(snapshotSha256 ? ['--source-snapshot', snapshotSha256] : [])]);
    expect(result.status, output(result)).toBe(1);
    expect(output(result)).toContain('RUNTIME_BUILD_RECIPE_MISMATCH');
  });

  test('repeats a pinned build byte-for-byte in a different physical staging tree', async () => {
    const repeat = join(temporary, 'repeat');
    const result = runNode([buildScript, 'build', '--source-root', root, '--output-root', repeat,
      '--source-commit', sourceCommit, ...(snapshotSha256 ? ['--source-snapshot', snapshotSha256] : [])]);
    expect(result.status, output(result)).toBe(0);
    expect(await readFile(join(repeat, 'metadata/runtime-materials.json'), 'utf8')).toBe(
      await readFile(join(built, 'metadata/runtime-materials.json'), 'utf8'),
    );
  }, 120_000);

  test('imports all entries without side effects and refuses standalone authority', () => {
    const imports = runNode([
      '--input-type=module',
      '--eval',
      `await Promise.all(${JSON.stringify(['composition', 'service', 'cli', 'worker'])}.map((name) => import(${JSON.stringify(
        pathToFileURL(join(relocated, 'runtime')).href + '/',
      )} + name + '.mjs'))); process.stdout.write('IMPORTED\\n')`,
    ], { cwd: temporary });
    expect(imports.status, output(imports)).toBe(0);
    expect(imports.stdout).toBe('IMPORTED\n');

    const cli = runNode([join(relocated, 'runtime/cli.mjs'), 'doctor'], { cwd: temporary });
    expect(cli.status, output(cli)).toBe(3);
    expect(JSON.parse(String(cli.stdout))).toMatchObject({
      status: 'unavailable',
      code: 'HOST_REGISTRATION_REQUIRED',
      exitCode: 3,
    });

    for (const entry of ['service', 'worker']) {
      const refused = runNode([join(relocated, `runtime/${entry}.mjs`)], { cwd: temporary });
      expect(refused.status, output(refused)).toBe(3);
      expect(JSON.parse(String(refused.stderr))).toMatchObject({
        status: 'unavailable',
        code: 'TRUSTED_PROVISIONING_REQUIRED',
      });
    }
  });

  test('validates installed public authority and the independent network repair identity', async () => {
    const harness = join(temporary, 'public-origin-harness.mjs');
    const entry = (name: string) => JSON.stringify(pathToFileURL(join(relocated, 'runtime', name + '.mjs')).href);
    await writeFile(harness, `
      import { createHash } from 'node:crypto';
      import { request } from 'node:http';
      import { hostname } from 'node:os';
      import { join } from 'node:path';
      import { createRuntimeProvisioning } from ${entry('composition')};
      import { createInstalledService, startServiceListener } from ${entry('service')};

      const origin = 'https://recorded.patrick.test';
      const rpId = 'recorded.patrick.test';
      const dataRoot = process.cwd();
      const identity = { accountId: 'account', deviceId: 'device', scopeId: 'scope', configRevision: '1', domains: ['personal'] };
      const registration = {
        identity, captureHost: hostname(), serviceUid: process.geteuid(), profile: 'test',
        dataRoot, minimumFreeBytes: 0, origin, rpId, listener: { origin, host: '127.0.0.1', port: 0 },
      };
      let database;
      let attachments = 0;
      const service = {
        databasePath: join(dataRoot, 'https.sqlite'), credentialDirectory: join(dataRoot, 'https-credentials'),
        recoveryRuntime: { attach(resources) { database = resources.database; attachments++; } },
        bindRecoveryOperations() { return { root: dataRoot, targets: {},
          authority: { keyId: 'fixture', async sign() { throw new Error('unexpected'); }, async verify() { return false; } } };
        },
      };
      function rejected(run) { try { run(); return null; } catch (error) { return error.message; } }
      const wrongRp = rejected(() => createRuntimeProvisioning({ registration: { ...registration, rpId: 'other.test' }, service }));
      const wrongListener = rejected(() => createRuntimeProvisioning({ registration: {
        ...registration, listener: { ...registration.listener, origin: 'https://different.test' },
      }, service }));
      const legacy = { ...registration, origin: 'http://localhost', rpId: 'localhost',
        listener: { ...registration.listener, origin: 'http://localhost' } };
      const wrongNetwork = ['accountId', 'domain', 'localDeviceId'].map((field) => {
        const networkRepair = { accountId: identity.accountId, domain: 'personal', localDeviceId: identity.deviceId, [field]: 'other' };
        networkRepair.policy = { device_id: networkRepair.localDeviceId };
        return rejected(() => createRuntimeProvisioning({ registration: legacy, service: { ...service, networkRepair } }));
      });
      const before = attachments;
      const provisioning = createRuntimeProvisioning({ registration, service });
      const runtime = createInstalledService(provisioning);
      const now = new Date().toISOString();
      const future = new Date(Date.now() + 60000).toISOString();
      database.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(identity.accountId, 1, 1, now);
      const ticket = 'synthetic-bootstrap';
      const token = 'synthetic-session';
      const hash = (value) => createHash('sha256').update(value).digest('hex');
      database.prepare('INSERT INTO bootstrap_tickets VALUES (?,?,?,NULL,?)').run(hash(ticket), identity.accountId, future, now);
      database.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)').run(hash(token), identity.accountId, 'web', 1, future, now, 'fixture');
      const listener = await startServiceListener(runtime, provisioning);
      try {
        function post(path, body, overrides = {}, method = 'POST') {
          return new Promise((done, fail) => {
            const payload = body && JSON.stringify(body);
            const req = request(listener.url + path, { method, headers: {
              host: rpId, origin, 'content-type': 'application/json', 'x-patrick-bootstrap': ticket,
              ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}), ...overrides,
            } }, (res) => {
              let data = '';
              res.on('data', (bytes) => { data += bytes; });
              res.on('end', () => { let json; try { json = JSON.parse(data); } catch {} done({ status: res.statusCode, json, headers: res.headers }); });
            });
            req.on('error', fail);
            req.end(payload);
          });
        }
        const path = '/api/v1/auth/challenge';
        const badHost = await post(path, { rp_id: rpId }, { host: 'other.test', 'x-forwarded-host': rpId });
        const badOrigin = await post(path, { rp_id: rpId }, { origin: 'https://other.test', 'x-forwarded-proto': 'https' });
        const wrongRequestRp = await post(path, { rp_id: 'localhost' });
        const registered = await post(path, { rp_id: rpId });
        const row = database.prepare('SELECT origin,rp_id FROM auth_challenges WHERE challenge_id=?').get(registered.json.challenge_id);
        database.prepare('UPDATE auth_challenges SET rp_id=? WHERE challenge_id=?').run('other.test', registered.json.challenge_id);
        const wrongStoredRp = await post('/api/v1/auth/verify', { challenge_id: registered.json.challenge_id, credential: { id: 'fixture-credential' } });
        const logout = await post('/api/v1/session', null, { cookie: 'patrick_session=' + token }, 'DELETE');
        process.stdout.write(JSON.stringify({ wrongRp, wrongListener, wrongNetwork, before, badHost: badHost.status,
          badOrigin: badOrigin.json.params.reason, wrongRequestRp: wrongRequestRp.json.params.reason,
          issued: registered.status, browserRp: registered.json.challenge.rp.id, row,
          wrongStoredRp: wrongStoredRp.json.params.reason, cookie: logout.headers['set-cookie'] }));
      } finally {
        await listener.drain();
      }
    `);
    const result = runNode([harness], { cwd: temporary });
    expect(result.status, output(result)).toBe(0);
    expect(JSON.parse(String(result.stdout))).toMatchObject({
      wrongRp: 'BROWSER_AUTHORITY_INVALID', wrongListener: 'LISTENER_ORIGIN_INVALID',
      wrongNetwork: ['NETWORK_REGISTRATION_MISMATCH', 'NETWORK_REGISTRATION_MISMATCH', 'NETWORK_REGISTRATION_MISMATCH'],
      before: 0, badHost: 400, badOrigin: 'origin', wrongRequestRp: 'rp_id', issued: 200,
      browserRp: 'recorded.patrick.test', row: { origin: 'https://recorded.patrick.test', rp_id: 'recorded.patrick.test' },
      wrongStoredRp: 'challenge', cookie: [expect.stringContaining('Secure')],
    });
  }, 120_000);

  test('binds signed CLI and service backup to independent live Hub storage and reader identity', async () => {
    const harness = join(temporary, 'recovery-binding-harness.mjs');
    const entry = (name: string) => JSON.stringify(pathToFileURL(join(relocated, 'runtime', name + '.mjs')).href);
    const keys = generateKeyPairSync('ed25519');
    const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
    const deniedPaths = await checkoutDependencyReadTargets();
    await writeFile(harness, `
      import { createHash, sign, verify } from 'node:crypto';
      import { link, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
      import { hostname } from 'node:os';
      import { join } from 'node:path';
      import { createRequire } from 'node:module';
      import { createRuntimeProvisioning, openRuntimeDatabase } from ${entry('composition')};
      import { createInstalledCli } from ${entry('cli')};
      import { createInstalledService } from ${entry('service')};

      const require = createRequire(${entry('composition')});
      const Database = require('better-sqlite3');
      const readbackOnly = process.argv[2] === 'readback';
      const root = join(process.cwd(), 'recovery-binding');
      const paths = ['operations', 'sets', 'credentials'].map((part) => join(root, part));
      if (!readbackOnly) await Promise.all(paths.map((path) => mkdir(path, { recursive: true })));
      const [operations, sets, credentials] = paths;
      const identity = { accountId: 'owner', scopeId: 'scope', domains: ['personal'], deviceId: 'device', configRevision: '1' };
      const registration = { identity, captureHost: hostname(), serviceUid: process.geteuid(), profile: 'test',
        dataRoot: root, minimumFreeBytes: 0, origin: 'http://localhost', rpId: 'localhost',
        listener: { host: '127.0.0.1', port: 0, origin: 'http://localhost' } };
      const databasePath = join(root, 'service.sqlite');
      const openFixture = (path) => readbackOnly ? new Database(path, { readonly: true, fileMustExist: true }) : openRuntimeDatabase(path);
      const main = openFixture(databasePath);
      const hubPath = join(root, 'operational.sqlite');
      const hub = openFixture(hubPath);
      const newest = new Date().toISOString();
      if (!readbackOnly) for (const db of [main, hub]) db.prepare("INSERT INTO hub_snapshots VALUES ('hub',0,'{}',?)").run(newest);
      const authority = { keyId: 'fixture',
        async sign(bytes) {
          if (readbackOnly) throw new Error('READBACK_CANNOT_SIGN');
          return sign(null, bytes, ${JSON.stringify(privateKey)}).toString('base64');
        },
        async verify(bytes, signature, keyId) {
          return keyId === 'fixture' && verify(null, bytes, ${JSON.stringify(publicKey)}, Buffer.from(signature, 'base64'));
        } };
      let copiedReaderUses = 0;
      let freezeCalls = 0;
      let releases = 0;
      function schemaReader(db, role) {
        if (db !== main && db !== hub && role === 'hub') copiedReaderUses++;
        return { hubSeq: db.prepare('SELECT MAX(hub_seq) AS seq FROM hub_snapshots').get().seq ?? 0,
          domainSeq: db.prepare('SELECT MAX(seq) AS seq FROM domain_events').get().seq ?? 0,
          schemaHistory: db.prepare('SELECT file,sha256 FROM schema_migrations ORDER BY position').all() };
      }
      const hubBinding = { identity, database: hub, physicalPath: await realpath(hubPath), readDatabase: schemaReader };
      const scope = { setId: 'fixed', domains: [{ domain: 'personal', writerEpoch: 'epoch',
        withdrawal: { seq: 0, hash: createHash('sha256').update('').digest('hex') } }], resources: [], versionLocks: { app: 'one' } };
      let swap = false;
      const freeze = { async acquire() {
        freezeCalls++;
        if (swap) {
          await rename(hubPath, hubPath + '.saved');
          await writeFile(hubPath, 'fixture changed inode');
        }
        return { cutId: 'fixture', ingressFrozen: true, claimsFrozen: true, receiptsFrozen: true,
          effectsFrozen: true, executionTreesStopped: true, uncertainCallsJournaled: true, durableHandoff: true,
          async release() { releases++; if (swap) await rename(hubPath + '.saved', hubPath); } };
      } };
      function recovery(serviceDb, hubDb, reader = schemaReader, setId = scope.setId) {
        return { root: operations, authority, targets: { fixed: { identity, backup: {
          scope: { ...scope, setId }, options: { root: sets, databases: { service: serviceDb, hub: hubDb }, authority, freeze, readDatabase: reader },
        } } } };
      }
      function serviceOptions(targetHub = hub) {
        return { databasePath, credentialDirectory: credentials,
          recoveryRuntime: { attach() {} },
          bindRecoveryOperations({ database }) { return recovery(database, targetHub); },
        };
      }
      function provision(target = recovery(main, hub), binding = hubBinding, service = serviceOptions()) {
        return createRuntimeProvisioning({ registration, hostCapabilities: { recovery: target }, service,
          operationalRecoveryHub: binding });
      }
      const command = ['backup', '--target', 'fixed', '--operation', 'repeatable'];
      if (readbackOnly) {
        const denied = [];
        for (const path of ${JSON.stringify(deniedPaths)}) {
          try { await readFile(path); } catch (error) { if (error.code === 'ERR_ACCESS_DENIED') denied.push(path); }
        }
        const observed = await createInstalledCli(provision()).run([...command, '--readback']);
        for (const db of [hub, main]) db.close();
        process.stdout.write(JSON.stringify({ observed, denied, freezeCalls, copiedReaderUses }));
      } else {
      const alternate = openRuntimeDatabase(hubPath);
      const localAnswer = new Database(databasePath + '.hub');
      const rejected = async (operation) => {
        try { await operation(); return null; }
        catch (error) { await error.cleanup?.drain(); return error.message; }
      };
      const wrongReader = await rejected(() => createInstalledCli(provision(recovery(main, hub, () => ({})))));
      const wrongHandle = await rejected(() => createInstalledCli(provision(recovery(main, alternate))));
      const wrongBindingIdentity = await rejected(() => provision(recovery(main, hub),
        { ...hubBinding, identity: { ...identity, configRevision: '2' } }));
      const designatedLocal = { ...hubBinding, database: localAnswer, physicalPath: await realpath(databasePath + '.hub') };
      const collidingCli = await rejected(() => createInstalledCli(provision(recovery(main, localAnswer), designatedLocal)));
      const aliasPath = join(root, 'local-answer-alias.sqlite');
      await link(databasePath + '.hub', aliasPath);
      const alias = new Database(aliasPath, { readonly: true, fileMustExist: true });
      const collidingAlias = await rejected(() => createInstalledCli(provision(recovery(main, alias),
        { ...designatedLocal, database: alias, physicalPath: aliasPath })));
      alias.close();
      const collidingService = await rejected(async () => {
        const runtime = createInstalledService(provision(recovery(main, hub), hubBinding, serviceOptions(localAnswer)));
        await runtime.drain();
      });
      const runtime = createInstalledService(provision());
      const serviceClosed = (await runtime.drain()).status;
      const cli = createInstalledCli(provision());
      const preview = await cli.run([...command, '--preview']);
      const result = await cli.run([...command, '--execute']);
      if (result.status !== 'completed') throw new Error(JSON.stringify(result));
      const manifestPath = join(sets, scope.setId, 'manifest.json');
      const envelope = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => 'null'));
      const copied = await stat(join(sets, scope.setId, 'databases/hub.sqlite')).catch(() => null);
      const stableFreezeCalls = freezeCalls;
      swap = true;
      const changed = await createInstalledCli(provision(recovery(main, hub, schemaReader, 'swapped')))
        .run(['backup', '--target', 'fixed', '--operation', 'swapped', '--execute']);
      const changedPublished = await stat(join(sets, 'swapped')).then(() => true, () => false);

      swap = false;
      const staleProvisioning = provision(recovery(main, hub, schemaReader, 'stale-main'));
      const unvisitedProvisioning = provision(recovery(main, hub, schemaReader, 'stale-main'));
      const existingCli = createInstalledCli(staleProvisioning);
      const replacementPath = join(root, 'replacement.sqlite');
      const replacement = openRuntimeDatabase(replacementPath);
      replacement.prepare("INSERT INTO hub_snapshots VALUES ('hub',0,'{}',?)").run(newest);
      replacement.close();
      const originalFile = await stat(databasePath, { bigint: true });
      const newFile = await stat(replacementPath, { bigint: true });
      const beforeStaleFreeze = freezeCalls;
      const savedPath = databasePath + '.saved';
      await rename(databasePath, savedPath);
      await rename(replacementPath, databasePath);
      let existingStale, newStale, firstCreation;
      try {
        firstCreation = await rejected(() => createInstalledCli(unvisitedProvisioning));
        existingStale = await existingCli.run(['backup', '--target', 'fixed', '--operation', 'old-cli', '--execute']);
        let created = false;
        try {
          const newer = createInstalledCli(staleProvisioning);
          created = true;
          const result = await newer.run(['backup', '--target', 'fixed', '--operation', 'new-cli', '--execute']);
          newStale = { created, code: result.code };
        } catch (error) { newStale = { created, code: error.message }; }
      } finally {
        await rename(databasePath, replacementPath);
        await rename(savedPath, databasePath);
      }
      const restoredStale = await rejected(() => createInstalledCli(staleProvisioning));
      const freshPreview = await createInstalledCli(provision()).run([...command, '--preview']);
      const staleMain = { replaced: originalFile.dev !== newFile.dev || originalFile.ino !== newFile.ino,
        existing: existingStale, newer: newStale, firstCreation, restoredStale, freshPreview,
        freezes: freezeCalls - beforeStaleFreeze, published: await stat(join(sets, 'stale-main')).then(() => true, () => false) };
      for (const db of [localAnswer, alternate, hub, main]) db.close();
      process.stdout.write(JSON.stringify({ wrongReader, wrongHandle, wrongBindingIdentity, collidingCli, collidingAlias, collidingService,
        serviceClosed, preview, result,
        manifestDigest: envelope && createHash('sha256').update(JSON.stringify(envelope.manifest)).digest('hex'),
        actualCopy: copied?.size > 0, copiedReaderUses, stableFreezeCalls, freezeCalls, releases, changed, changedPublished, staleMain }));
      }
    `);
    // Node's permission model disables fsync entirely. Prepare via ordinary Node, then
    // exercise shipped signed recovery readback with denied checkout/tool paths and no filesystem writes.
    const result = runNode([harness, 'capture'], { cwd: temporary });
    expect(result.status, output(result)).toBe(0);
    const actual = JSON.parse(String(result.stdout));
    expect(actual, String(result.stdout)).toMatchObject({
      wrongReader: 'OPERATIONAL_RECOVERY_HUB_REQUIRED', wrongHandle: 'OPERATIONAL_RECOVERY_HUB_REQUIRED',
      wrongBindingIdentity: 'HOST_IDENTITY_MISMATCH', collidingCli: 'OPERATIONAL_RECOVERY_STORAGE_MISMATCH',
      collidingAlias: 'OPERATIONAL_RECOVERY_STORAGE_MISMATCH',
      collidingService: 'OPERATIONAL_RECOVERY_HUB_REQUIRED', serviceClosed: 'closed',
      preview: { status: 'preview' }, result: { status: 'completed' },
      actualCopy: true, stableFreezeCalls: 1, freezeCalls: 2, releases: 2, changed: { status: 'uncertain' }, changedPublished: false,
      staleMain: {
        replaced: true, published: false, freezes: 0,
        existing: { status: 'blocked', code: 'RECOVERY_SERVICE_HANDLE_MISMATCH' },
        newer: { created: false, code: 'RECOVERY_SERVICE_HANDLE_MISMATCH' },
        firstCreation: 'RECOVERY_SERVICE_HANDLE_MISMATCH', restoredStale: 'RECOVERY_SERVICE_HANDLE_MISMATCH',
        freshPreview: { status: 'preview' },
      },
    });
    expect(actual.result.manifestHash).toBe(actual.manifestDigest);
    expect(actual.copiedReaderUses).toBeGreaterThan(0);
    const tempVolume = '/' + temporary.split('/').filter(Boolean)[0];
    const readback = runNode(['--permission', '--allow-addons', '--allow-fs-read=' + tempVolume, harness, 'readback'],
      { cwd: temporary });
    expect(readback.status, output(readback)).toBe(0);
    const restricted = JSON.parse(String(readback.stdout));
    expect(restricted).toMatchObject({ observed: { status: 'completed', manifestHash: actual.result.manifestHash },
      denied: deniedPaths, freezeCalls: 0 });
    expect(restricted.copiedReaderUses).toBeGreaterThan(0);
  }, 120_000);

  test('runs actual relocated SQLite, CLI, service listener, shared gate, and worker algorithms', async () => {
    const harness = join(temporary, 'runtime-harness.mjs');
    const code = `
      import { hostname } from 'node:os';
      import { createHash } from 'node:crypto';
      import { mkdir, mkdtemp } from 'node:fs/promises';
      import { join } from 'node:path';
      import { createRequire } from 'node:module';
      import { createServer, get } from 'node:http';
      import { setTimeout as wait } from 'node:timers/promises';
      import { once } from 'node:events';
      import { readFile } from 'node:fs/promises';
      import {
        createRuntimeProvisioning, openRuntimeDatabase, runtimeRecoveryWriteAllowed,
      } from ${JSON.stringify(pathToFileURL(join(relocated, 'runtime/composition.mjs')).href)};
      import { createInstalledCli } from ${JSON.stringify(pathToFileURL(join(relocated, 'runtime/cli.mjs')).href)};
      import {
        createInstalledService, runInstalledService, startServiceListener,
      } from ${JSON.stringify(pathToFileURL(join(relocated, 'runtime/service.mjs')).href)};
      import { createInstalledWorker, runInstalledWorker } from ${JSON.stringify(pathToFileURL(join(relocated, 'runtime/worker.mjs')).href)};

      const base = await mkdtemp(join(process.cwd(), 'patrick-runtime-harness-'));
      const dataRoot = join(base, 'data');
      const credentials = join(base, 'credentials');
      const recoveryRoot = join(base, 'recovery');
      await Promise.all([mkdir(dataRoot), mkdir(credentials), mkdir(recoveryRoot)]);
      const identity = {
        accountId: 'account-1', scopeId: 'scope-1', domains: ['personal'],
        deviceId: 'device-1', configRevision: '1',
      };
      let attachedDatabase;
      const service = {
        databasePath: join(dataRoot, 'patrick.sqlite'),
        credentialDirectory: credentials,
        recoveryRuntime: {
          attach({ database, admission }) {
            attachedDatabase = database;
            database.prepare(\`INSERT OR IGNORE INTO recovery_domain_gates(
              data_domain,writer_epoch,status,activation_id,witness_revision,reason,updated_at
            ) VALUES (?,?,?,?,?,?,?)\`).run(
              'personal', 'epoch-1', 'open', 'activation-1', 'witness-1', 'test-controller', new Date(0).toISOString(),
            );
            admission.admit({
              domain: 'personal', writerEpoch: 'epoch-1',
              activationId: 'activation-1', witnessRevision: 'witness-1',
            });
          },
        },
        bindRecoveryOperations({ database, hubDatabase }) {
          if (database !== attachedDatabase || database === hubDatabase) throw new Error('HANDLE_IDENTITY_INVALID');
          return {
            root: recoveryRoot,
            authority: {
              keyId: 'test-key',
              async sign() { return 'test-signature'; },
              async verify(_bytes, signature, keyId) {
                return signature === 'test-signature' && keyId === 'test-key';
              },
            },
            targets: {},
          };
        },
      };
      const registration = {
        identity,
        captureHost: hostname(),
        serviceUid: process.geteuid(),
        profile: 'test',
        dataRoot,
        minimumFreeBytes: 0,
        origin: 'http://localhost',
        rpId: 'localhost',
        listener: { host: '127.0.0.1', port: 0, origin: 'http://localhost' },
      };
      const provisioning = createRuntimeProvisioning({
        registration,
        hostCapabilities: {
          recovery: {
            root: recoveryRoot,
            authority: {
              keyId: 'test-key',
              async sign() { return 'test-signature'; },
              async verify(_bytes, signature, keyId) {
                return signature === 'test-signature' && keyId === 'test-key';
              },
            },
            targets: { backup: { identity } },
          },
        },
        service,
      });

      const require = createRequire(import.meta.url);
      const sqliteResolved = require.resolve('better-sqlite3', { paths: [${JSON.stringify(relocated)}] });
      const direct = openRuntimeDatabase(join(dataRoot, 'direct.sqlite'));
      const journal = direct.pragma('journal_mode', { simple: true });
      const migrationCount = direct.prepare('SELECT COUNT(*) count FROM schema_migrations').get().count;
      direct.close();
      const reopened = openRuntimeDatabase(join(dataRoot, 'direct.sqlite'));
      const reopenedMigrationCount = reopened.prepare('SELECT COUNT(*) count FROM schema_migrations').get().count;
      reopened.close();
      let checkoutAccessDenied = false;
      try { await readFile(${JSON.stringify(join(root, 'node_modules/better-sqlite3/package.json'))}); }
      catch (error) { checkoutAccessDenied = error.code === 'ERR_ACCESS_DENIED'; }

      let forgedProvisioning = null;
      try {
        createInstalledCli({ ...provisioning, host: { ...provisioning.host } });
      } catch (error) {
        forgedProvisioning = error.message;
      }
      let wrongUid = null;
      try {
        createRuntimeProvisioning({
          registration: { ...registration, serviceUid: registration.serviceUid + 1 },
          service,
        });
      } catch (error) {
        wrongUid = error.message;
      }
      const cli = createInstalledCli(provisioning);
      const cliResult = await cli.run(['backup', '--preview', '--target', 'backup']);
      let forgedCode = null;
      try {
        createRuntimeProvisioning({
          registration: { ...registration, identity: { ...identity, configRevision: '2' } },
          hostCapabilities: { recovery: provisioning.host.recovery },
          service,
        });
      } catch (error) {
        forgedCode = error.message;
      }

      const runtime = createInstalledService(provisioning);
      const serviceDatabase = attachedDatabase;
      const sharedGateAllowed = runtimeRecoveryWriteAllowed(serviceDatabase, 'personal');
      const secondHandle = openRuntimeDatabase(join(dataRoot, 'patrick.sqlite'));
      const persistedRowAloneAllowed = runtimeRecoveryWriteAllowed(secondHandle, 'personal');
      secondHandle.close();
      let entered;
      let release;
      const started = new Promise((resolve) => { entered = resolve; });
      const held = new Promise((resolve) => { release = resolve; });
      runtime.app.get('/api/test-held', async (c) => {
        entered();
        await held;
        serviceDatabase.prepare('SELECT 1').get();
        return c.text('finished');
      });
      const listener = await startServiceListener(runtime, provisioning);

      let collision;
      let collisionHub;
      const collisionProvisioning = createRuntimeProvisioning({
        registration: { ...registration, listener: { ...registration.listener, port: Number(new URL(listener.url).port) } },
        service: {
          ...service,
          databasePath: join(dataRoot, 'collision.sqlite'),
          bindRecoveryOperations(resources) {
            collisionHub = resources.hubDatabase;
            return service.bindRecoveryOperations(resources);
          },
        },
      });
      try { await runInstalledService(collisionProvisioning); }
      catch (error) {
        collision = { code: error.message, state: error.cleanup?.status,
          databaseClosed: !attachedDatabase.open, hubClosed: !collisionHub.open };
      }
      let blockedStartup;
      const blockedProvisioning = createRuntimeProvisioning({
        registration, service: {
          ...service, databasePath: join(dataRoot, 'blocked.sqlite'),
          bindRecoveryOperations() { return undefined; },
        },
      });
      try { await runInstalledService(blockedProvisioning); }
      catch (error) {
        blockedStartup = { code: error.message, state: error.cleanup?.status, databaseClosed: !attachedDatabase.open };
      }

      const forgedHost = await new Promise((done, fail) => {
        get(listener.url + '/', { headers: { host: 'unregistered.invalid' } }, (response) => {
          response.resume();
          done(response.statusCode);
        }).once('error', fail);
      });
      const wrongOrigin = await fetch(listener.url + '/api/v1/auth/challenge', {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://invalid.test' },
        body: JSON.stringify({ rp_id: 'localhost' }),
      });
      const validOrigin = await fetch(listener.url + '/api/v1/auth/challenge', {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify({ rp_id: 'localhost' }),
      });
      const session = await fetch(listener.url + '/api/v1/session');
      const health = await fetch(listener.url + '/healthz');
      const home = await fetch(listener.url + '/', { headers: { origin: 'http://localhost' } });
      const healthBody = await health.json();
      const homeBody = await home.text();
      const wrongOriginBody = await wrongOrigin.json();
      const validOriginBody = await validOrigin.json();
      const assetPath = homeBody.match(/src="([^"]+[.]js)"/)?.[1];
      const asset = await fetch(listener.url + assetPath);
      await asset.arrayBuffer();

      const token = 'local-session-stream-fixture';
      const now = new Date().toISOString();
      serviceDatabase.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(identity.accountId, 1, 1, now);
      serviceDatabase.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)').run(
        createHash('sha256').update(token).digest('hex'), identity.accountId, 'web', 1,
        new Date(Date.now() + 60000).toISOString(), now, 'fixture');
      const stream = await fetch(listener.url + '/api/v1/session/stream', { headers: { cookie: 'patrick_session=' + token } });
      const streamReader = stream.body.getReader();
      const streamed = new TextDecoder().decode((await streamReader.read()).value);
      const logoutDenied = await fetch(listener.url + '/api/v1/session', {
        method: 'DELETE', headers: { cookie: 'patrick_session=' + token, origin: 'http://invalid.test' },
      });
      await logoutDenied.text();
      const logout = await fetch(listener.url + '/api/v1/session', {
        method: 'DELETE', headers: { cookie: 'patrick_session=' + token, origin: 'http://localhost' },
      });
      await logout.text();
      await streamReader.cancel();
      const settle = Date.now() + 2000;
      while (listener.read().activeRequests && Date.now() < settle) await wait(5);

      const inFlight = fetch(listener.url + '/api/test-held').then((value) => value.text()).catch(() => 'cancelled');
      await started;
      const timedOut = await listener.drain({ timeoutMs: 5 });
      const remainedOpen = serviceDatabase.open;
      const late = await fetch(listener.url + '/healthz').then((result) => result.status, () => 503);
      release();
      await inFlight;
      const drained = await listener.drain({ timeoutMs: 5000 });
      const finallyClosed = !serviceDatabase.open;

      const pin = '45aecbf578289cda72d1fc773dcad069bfe7778b';
      let reportedCommit = '0'.repeat(40);
      let preflights = 0;
      let zeroPaidCalls = true;
      const eventRequests = [];
      const hub = createServer(async (request, response) => {
        if (request.url === '/healthz') {
          preflights++;
          response.end(JSON.stringify({ ok: true, commit: reportedCommit }));
        } else if (request.headers.authorization !== 'Bearer test-source') {
          zeroPaidCalls = false;
          response.writeHead(403).end();
        } else if (request.method === 'POST' && request.url === '/v1/events') {
          let event = '';
          for await (const chunk of request) event += chunk;
          eventRequests.push(JSON.parse(event));
          response.end(JSON.stringify({ event: 1, duplicate: false, routed: ['咨询'] }));
        } else if (request.url === '/v1/events/1') {
          response.end(JSON.stringify({ event: 1, runs: [{ run: 1, rule: '咨询', state: 'queued' }] }));
        } else response.writeHead(404).end();
      });
      hub.listen(0, '127.0.0.1');
      await once(hub, 'listening');
      const hubOrigin = 'http://127.0.0.1:' + hub.address().port;
      const workerData = join(base, 'worker-data');
      const workerCredentials = join(base, 'worker-credentials');
      await Promise.all([mkdir(workerData), mkdir(workerCredentials)]);
      let observeCalls = 0;
      let releaseObservation;
      const observedPage = new Promise((done) => { releaseObservation = done; });
      let sourceCalls = 0;
      let releaseHttp;
      const pendingHttp = new Promise((done) => { releaseHttp = done; });
      const response = { status: 200, location: null, contentType: 'application/rss+xml',
        bytes: new TextEncoder().encode('<rss><channel><item><guid>first</guid><title>First</title></item></channel></rss>') };
      const sourceUrl = 'https://fixture-feed.test/items';
      const serviceSourceController = new AbortController();
      const workerProvisioning = createRuntimeProvisioning({
        registration: { ...registration, dataRoot: workerData, operationalHub: { origin: hubOrigin, commit: pin } },
        hostCapabilities: {},
        service: {
          ...service,
          databasePath: join(workerData, 'patrick.sqlite'),
          credentialDirectory: workerCredentials,
          productViewHub: { hub: { state() { observeCalls++; return observedPage; } } },
          httpSources: { approvedUrls: () => [sourceUrl], port: {
            async resolve() { return [{ address: '8.8.8.8', family: 4 }]; },
            async request() {
              if (++sourceCalls === 1) throw new Error('finite transport unavailable');
              return pendingHttp;
            },
          } },
          httpSourceWorker: { signal: serviceSourceController.signal, pollMs: 100 },
        },
        worker: { keys: { owner: 'test-owner', worker: 'test-worker', source: 'test-source' } },
      });
      let hubIdentityRejection;
      try { await createInstalledWorker(workerProvisioning); }
      catch (error) { hubIdentityRejection = error.message; }
      const seedRuntime = createInstalledService(workerProvisioning);
      const serviceRoleDatabase = attachedDatabase;
      serviceRoleDatabase.prepare("INSERT INTO source_configs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run('loop-source', identity.accountId, 'personal', 'rss', sourceUrl, 'fixture-source-root',
          JSON.stringify({ repo: null, branch: null, path: null, root: null, excludes: [], httpTargets: [sourceUrl] }),
          '[]', null, 'poll', 'none', 0, 1, 'enabled', 1, '1.0', now, now);
      serviceRoleDatabase.prepare("INSERT INTO source_cursors VALUES (?,?,?,?,?,?)")
        .run('loop-source', 1, 'begin', 'baseline', 0, now);
      attachedDatabase.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(identity.accountId, 1, 1, now);
      attachedDatabase.prepare('INSERT INTO caller_scopes VALUES (?,?,?,?,NULL)').run(identity.accountId, 'web', 'personal', 'owner');
      attachedDatabase.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)').run(
        createHash('sha256').update(token).digest('hex'), identity.accountId, 'web', 1,
        new Date(Date.now() + 60000).toISOString(), now, 'fixture');
      const payload = { parent_work_id: null, request_scope: {
        account_id: identity.accountId, caller_id: 'web', data_domain: 'personal', permission_epoch: 1,
      }, text: 'Finite runtime dispatch probe' };
      const submitted = await seedRuntime.app.request('http://localhost/api/v1/consultations', {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost',
          cookie: 'patrick_session=' + token },
        body: JSON.stringify({ client_request_id: 'dispatch-probe', expected_revision: null,
          payload, payload_hash: createHash('sha256').update(JSON.stringify(payload)).digest('hex') }),
      });
      await submitted.text();
      reportedCommit = pin;
      const worker = await runInstalledWorker(workerProvisioning);
      const workerSharedGate = runtimeRecoveryWriteAllowed(attachedDatabase, 'personal');
      const deadline = Date.now() + 4000;
      let outboxResult;
      do {
        outboxResult = attachedDatabase.prepare("SELECT result FROM outbox WHERE destination = 'autoloop'").get()?.result;
        if (outboxResult) break;
        await wait(10);
      } while (Date.now() < deadline);
      const observationOwners = observeCalls;
      releaseObservation({ seq: 7, runs: [], cards: [], lines: [], hasMore: false, nextBefore: null });
      let observedSeq, sourceReceipt;
      const receiptDeadline = Date.now() + 2000;
      do {
        observedSeq = serviceRoleDatabase.prepare("SELECT hub_seq FROM hub_snapshots WHERE cursor_name='hub_observer'").get()?.hub_seq;
        sourceReceipt = serviceRoleDatabase.prepare("SELECT kind FROM collection_receipts WHERE source_id='loop-source'").get()?.kind;
        if (observedSeq === 7 && sourceReceipt) break;
        await wait(10);
      } while (Date.now() < receiptDeadline);
      serviceRoleDatabase.prepare("UPDATE http_source_schedule SET next_at=? WHERE source_id='loop-source'").run(now);
      const callDeadline = Date.now() + 1000;
      while (sourceCalls < 2 && Date.now() < callDeadline) await wait(8);
      process.kill(process.pid, 'SIGINT');
      const workerDrain = await worker.closed;
      const serviceAfterWorker = seedRuntime.read().status;
      const sourcePending = await seedRuntime.drain({ timeoutMs: 5 });
      const sourceDatabaseOpen = serviceRoleDatabase.open;
      releaseHttp(response);
      const sourceDrained = await seedRuntime.drain({ timeoutMs: 5000 });
      const leaseDb = openRuntimeDatabase(join(workerData, 'patrick.sqlite'));
      const sourceLease = leaseDb.prepare("SELECT lease_token FROM http_source_schedule WHERE source_id='loop-source'").get()?.lease_token;
      leaseDb.close();
      await new Promise((done) => hub.close(done));

      process.stdout.write(JSON.stringify({
        sqliteResolved, journal, migrationCount, reopenedMigrationCount, checkoutAccessDenied,
        cliResult, forgedCode, forgedProvisioning, wrongUid, persistedRowAloneAllowed,
        forgedHost, sharedGateAllowed, collision, blockedStartup, late,
        streamType: stream.headers.get('content-type'), streamed, logoutDenied: logoutDenied.status,
        logout: logout.status, cookieCleared: logout.headers.getSetCookie().some((value) => value.includes('Max-Age=0')),
        healthStatus: health.status, healthBody, homeStatus: home.status,
        homeTitle: homeBody.includes('<title>PAtrick</title>'), assetStatus: asset.status,
        assetType: asset.headers.get('content-type'), wrongOriginStatus: wrongOrigin.status,
        validOriginStatus: validOrigin.status, sessionStatus: session.status, wrongOriginBody, validOriginBody,
        timedOut, remainedOpen, finallyClosed, drained, workerDrain, workerSharedGate, hubIdentityRejection, preflights, eventRequests, outboxResult, zeroPaidCalls, submitted: submitted.status,
        observationOwners, observedSeq, sourceReceipt, sourceCalls, serviceAfterWorker, sourcePending, sourceDatabaseOpen, sourceDrained, sourceLease,
      }) + '\\n');
    `;
    await writeFile(harness, code);
    const canGateNetwork = process.allowedNodeEnvironmentFlags.has('--allow-net');
    const permissionFlags = [
      '--permission', '--allow-addons', '--allow-fs-read=' + temporary + '/*', '--allow-fs-write=' + temporary + '/*',
      ...(canGateNetwork ? ['--allow-net'] : []),
    ];
    const result = runNode([...permissionFlags, harness], { cwd: temporary });
    expect(result.status, output(result)).toBe(0);
    const actual = JSON.parse(String(result.stdout));
    expect(actual.sqliteResolved.startsWith(await realpath(relocated))).toBe(true);
    expect(actual.journal).toBe('wal');
    expect(actual.migrationCount).toBeGreaterThan(0);
    expect(actual.reopenedMigrationCount).toBe(actual.migrationCount);
    expect(actual.checkoutAccessDenied).toBe(true);
    expect(actual.cliResult).toMatchObject({ status: 'preview', code: 'RECOVERY_PREVIEW', exitCode: 0 });
    expect(actual.forgedCode).toBe('HOST_IDENTITY_MISMATCH');
    expect(actual.forgedProvisioning).toBe('TRUSTED_PROVISIONING_REQUIRED');
    expect(actual.wrongUid).toBe('HOST_REGISTRATION_INVALID');
    expect(actual.forgedHost).toBe(400);
    expect(actual.sharedGateAllowed).toBe(true);
    expect(actual.persistedRowAloneAllowed).toBe(false);
    expect(actual).toMatchObject({
      healthStatus: 200,
      healthBody: { ok: true },
      homeStatus: 200,
      homeTitle: true,
      assetStatus: 200,
      assetType: 'text/javascript; charset=utf-8',
      wrongOriginStatus: 403,
      wrongOriginBody: { params: { reason: 'origin' } },
      validOriginStatus: 403,
      validOriginBody: { params: { reason: 'registration_required' } },
      sessionStatus: 401,
      timedOut: { listener: 'draining', activeRequests: 1, runtime: { status: 'draining' } },
      collision: { code: 'LISTENER_BIND_FAILED', state: 'closed', databaseClosed: true, hubClosed: true },
      blockedStartup: { code: 'OPERATIONAL_RECOVERY_BINDING_REQUIRED', state: 'closed', databaseClosed: true },
      late: 503,
      streamType: 'text/event-stream',
      streamed: expect.stringContaining('event: open'),
      logoutDenied: 403,
      logout: 200,
      cookieCleared: true,
      remainedOpen: true,
      finallyClosed: true,
      hubIdentityRejection: 'OPERATIONAL_HUB_IDENTITY_MISMATCH',
      workerSharedGate: true,
      preflights: 2,
      submitted: 202,
      zeroPaidCalls: true,
      outboxResult: 'accepted',
      eventRequests: [expect.objectContaining({ type: 'consultation.requested' })],
      drained: { listener: 'closed', runtime: { status: 'closed', active: 0 } },
      workerDrain: { status: 'closed', active: 0, signal: 'SIGINT' },
      observationOwners: 1, observedSeq: 7, sourceReceipt: 'failure', sourceCalls: 2,
      serviceAfterWorker: 'running', sourcePending: { status: 'draining' }, sourceDatabaseOpen: true,
      sourceDrained: { status: 'closed' }, sourceLease: null,
    });
  }, 120_000);

  test.each(['SIGTERM', 'SIGINT'] as const)('handles %s through listener admission and aggregate runtime drain', async (signal) => {
    const harness = join(temporary, 'signal-harness-' + signal + '.mjs');
    const code = `
      import { hostname } from 'node:os';
      import { mkdir, mkdtemp } from 'node:fs/promises';
      import { join } from 'node:path';
      import { createRuntimeProvisioning } from ${JSON.stringify(pathToFileURL(join(relocated, 'runtime/composition.mjs')).href)};
      import { runInstalledService } from ${JSON.stringify(pathToFileURL(join(relocated, 'runtime/service.mjs')).href)};
      const base = await mkdtemp(join(process.cwd(), 'patrick-signal-'));
      const dataRoot = join(base, 'data');
      const credentialDirectory = join(base, 'credentials');
      const recoveryRoot = join(base, 'recovery');
      await Promise.all([mkdir(dataRoot), mkdir(credentialDirectory), mkdir(recoveryRoot)]);
      const identity = { accountId: 'a', scopeId: 's', domains: ['personal'], deviceId: 'd', configRevision: '1' };
      let attached;
      const provisioning = createRuntimeProvisioning({
        registration: {
          identity, captureHost: hostname(), serviceUid: process.geteuid(), profile: 'test',
          dataRoot, minimumFreeBytes: 0, origin: 'http://localhost', rpId: 'localhost',
          listener: { host: '127.0.0.1', port: 0, origin: 'http://localhost' },
        },
        hostCapabilities: {},
        service: {
          databasePath: join(dataRoot, 'service.sqlite'),
          credentialDirectory,
          recoveryRuntime: { attach({ database }) { attached = database; } },
          bindRecoveryOperations({ database }) {
            if (database !== attached) throw new Error('HANDLE_IDENTITY_INVALID');
            return {
              root: recoveryRoot,
              authority: { keyId: 'k', async sign() { return 's'; }, async verify() { return true; } },
              targets: {},
            };
          },
        },
      });
      const running = await runInstalledService(provisioning);
      process.stdout.write(JSON.stringify({ ready: true, url: running.url }) + '\\n');
      const result = await running.closed;
      process.stdout.write(JSON.stringify(result) + '\\n');
    `;
    await writeFile(harness, code);
    const child = spawn(process.execPath, [harness], {
      cwd: temporary,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_OPTIONS: '', NODE_PATH: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = await runSignalHarness(child, signal);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ ready: true });
    expect(lines[1]).toMatchObject({
      signal,
      listener: 'closed',
      runtime: { status: 'closed', active: 0 },
    });
  }, 30_000);

  test.each(['success', 'generation-layout', 'default-local', 'join-timeout', 'missing-terminal', 'lost-response', 'bad-freeze', 'ordinary-first', 'inode-swap',
    'unbound-open', 'pre-open-exchange', 'swap-at-acquire', 'open-lease-loss', 'prior-at-open', 'prior-start', 'prior-set', 'prior-handoff', 'clearance-mismatch',
    'warm-prior', 'warm-admit', 'warm-withdraw', 'root-ancestor', 'private-descendant', 'receipt-outage', 'warm-receipt-outage',
    'lease-outage', 'post-readback-outage', 'receipt-handoff-exchanged', 'prior-other-operation', 'revoked-receipt', 'tamper-handoff', 'sign-timeout', 'lost-close', 'file-after-claim', 'close-failed', 'tamper-after-close', 'SIGINT', 'SIGTERM'] as const)('runs the signed installed maintenance cut for %s', async (mode) => {
    const harness = join(temporary, 'cut-' + mode + '.mjs');
    await writeFile(harness, String.raw`import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as wait } from 'node:timers/promises';

const [artifact, mode] = process.argv.slice(2);
const entry = (name) => pathToFileURL(join(artifact, 'runtime', name + '.mjs')).href;
const { createMaintenanceStorage, createRuntimeProvisioning, openRuntimeDatabase, runtimeRecoveryWriteAllowed } = await import(entry('composition'));
const { runInstalledService } = await import(entry('service'));
const { runInstalledWorker } = await import(entry('worker'));
const Database = createRequire(entry('composition'))('better-sqlite3');
const root = await mkdtemp(join(process.cwd(), 'maintenance-'));
const [journalRoot, setRoot, handoffRoot, normalRoot, credentialDirectory] =
  ['journal', 'sets', 'handoff', 'ordinary', 'credentials'].map((name) => join(root, name));
for (const path of [journalRoot, setRoot, handoffRoot, normalRoot, credentialDirectory]) await mkdir(path, { mode: 0o700 });
const databasePath = join(root, 'service.sqlite');
const hubPath = join(root, mode === 'generation-layout' ? 'hub.sqlite' : 'operational.sqlite');
const localAnswersPath = mode === 'generation-layout' ? join(root, 'answers.sqlite') : databasePath + '.hub';
if (mode.startsWith('prior-') || mode === 'clearance-mismatch') {
  const seed = new Database(databasePath);
  seed.pragma('user_version=1'); seed.close();
} else openRuntimeDatabase(databasePath).close();
const answerSeed = new Database(localAnswersPath);
answerSeed.pragma('user_version=1'); answerSeed.close();
openRuntimeDatabase(hubPath).close();
let operational;
let unbound;
if (mode === 'unbound-open') {
  unbound = new Database(hubPath, { readonly: true, fileMustExist: true });
  await rename(hubPath, hubPath + '.old');
  const replacement = openRuntimeDatabase(hubPath);
  replacement.exec('CREATE TABLE replacement_identity(value TEXT)');
  replacement.close();
}
const alternate = new Database(hubPath);
const hubLock = new Database(hubPath);
const controls = new Database(join(root, 'fixture-controller.sqlite'));
controls.exec("CREATE TABLE writer_gate(id INTEGER PRIMARY KEY, permitted INTEGER); INSERT INTO writer_gate VALUES (1,1)");
controls.exec("CREATE TABLE unresolved(operation_id TEXT PRIMARY KEY, channel_test TEXT NOT NULL)");
function credentialUsable() { return controls.prepare('SELECT permitted FROM writer_gate WHERE id=1').pluck().get() === 1; }
function alternateWrite(id) {
  assert(credentialUsable(), 'fixture writer capability withdrawn');
  alternate.prepare('INSERT INTO fixture_external VALUES (?)').run(id);
}
alternate.exec("CREATE TABLE fixture_external(id INTEGER PRIMARY KEY); SELECT 1");
alternateWrite(7);
const uid = process.geteuid();
const identity = { accountId: 'owner', scopeId: 'scope', domains: ['personal'], deviceId: 'device', configRevision: '1' };
const domain = { domain: 'personal', writerEpoch: 'epoch', withdrawal: { seq: 0, hash: hash('') } };
const writer = { domain: 'personal', writerId: 'old-writer', writerEpoch: 'epoch', activationId: 'grant', witnessRevision: 'rev-1' };
const plan = { installationId: 'installation', generationId: 'old', operationId: 'maintain', cutId: 'cut', targetId: 'private',
  scope: { setId: 'owned', domains: [domain], resources: [], versionLocks: { app: '1' } }, writers: [writer],
  roles: Object.fromEntries(['service', 'worker', 'hub'].map((role) => [role, { ownerId: role + '-fixture', uid }])),
  journalRoot, setRoot, handoffRoot, protection: 'local_only' };
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
function file(path) {
  const s = statSync(path, { bigint: true });
  return { path, device: String(s.dev), inode: String(s.ino) };
}
function signingKeys() {
  const keys = generateKeyPairSync('ed25519');
  return {
    attest(value) { return sign(null, Buffer.from(value), keys.privateKey).toString('base64'); },
    check(value, signature) { return verify(null, Buffer.from(value), keys.publicKey, Buffer.from(signature, 'base64')); },
  };
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { resolve, promise }; }
const rawEntered = deferred(), rawRelease = deferred(), serviceEntered = deferred(), serviceRelease = deferred();
const signing = deferred(), signRelease = deferred();
const migrationSigner = signingKeys(), witness = signingKeys();
let signs = 0, innerCount = 0, innerRelease = 0, began = 0, closedReads = 0, dropped = false;
let originalAnswerClose, closeAttempts = 0;
let terminalHash, matchingManifests = 0;
let expected, permit, closure, outerHeld = false, sealed = false;
let service, worker, main, workerDb, answers, localHub, serviceGate;
const trace = [];
const signer = { keyId: 'fixture-sign',
  async sign(bytes) {
    signs++;
    const record = JSON.parse(Buffer.from(bytes).toString());
    if (record.kind === 'claim' && mode === 'file-after-claim') {
      await rename(hubPath, hubPath + '.registered');
      await writeFile(hubPath, await readFile(hubPath + '.registered'));
    }
    if (record.kind === 'terminal' && mode === 'missing-terminal') throw new Error('fixture terminal publication denied');
    if (record.schemaVersion && record.setId) { signing.resolve(); await signRelease.promise; }
    return migrationSigner.attest(bytes);
  },
  async verify(bytes, signature, keyId) {
    if (mode === 'lost-response' && !dropped && JSON.parse(Buffer.from(bytes).toString()).kind === 'terminal' &&
        (await readdir(journalRoot)).includes('maintain.terminal.json')) {
      dropped = true;
      throw new Error('fixture response lost after publication');
    }
    const valid = keyId === this.keyId && migrationSigner.check(bytes, signature);
    if (valid && mode === 'post-readback-outage') {
      const record = JSON.parse(Buffer.from(bytes).toString());
      if (record.kind === 'terminal') {
        terminalHash = record.outcome.manifestHash;
        matchingManifests = 0;
      } else if (record.setId && hash(bytes) === terminalHash) matchingManifests++;
    }
    return valid;
  } };
const pin = '45aecbf578289cda72d1fc773dcad069bfe7778b';
const hub = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/healthz') res.end(JSON.stringify({ ok: true, commit: pin }));
  else if (req.url.startsWith('/v1/work?')) {
    rawEntered.resolve();
    await rawRelease.promise;
    res.end(JSON.stringify({ job: null, cancel: [] }));
  } else res.writeHead(404).end();
});
hub.listen(0, '127.0.0.1');
await once(hub, 'listening');
const hubOrigin = 'http://127.0.0.1:' + hub.address().port;
const originalFetch = globalThis.fetch;
// A deliberately non-cancellable, already-dispatched fixture transport. The actual worker
// still owns this loopback response and must join it after its logical abort completes.
globalThis.fetch = (url, options) => originalFetch(url, String(url).startsWith(hubOrigin + '/v1/work?')
  ? { ...options, signal: undefined } : options);
const observation = 'fixture worker route';
const admission = { backend: 'dsh', available: true, status: 'verified', command: 'fixture', observation, evidenceSha256: hash(observation) };
const terms = { accountId: 'owner', dataDomain: 'personal', backend: 'dsh', admissionSha256: admission.evidenceSha256,
  routeId: 'fixture', chargeMicros: 1, providerQuoteRef: 'fixture' };
const backend = { scope: { accountId: 'owner', dataDomain: 'personal' }, admission,
  route: { sdkMaxRetries: 0, implicitResend: false, perHttpAccounted: false, verifiedMaxSends: null }, routeId: 'fixture',
  pricing: { kind: 'fixed', terms, evidenceSha256: hash(canonical({ ...terms, kind: 'fixed' })) },
  async send() { throw new Error('unexpected fixture dispatch'); } };

const parents = new Set();
for (let directory = root; !parents.has(directory); directory = dirname(directory)) parents.add(directory);
const files = { service: file(databasePath), worker: file(databasePath), localAnswers: file(localAnswersPath), operationalHub: file(hubPath) };
const enrollment = { installationId: plan.installationId, generationId: plan.generationId, identity, roles: plan.roles,
  files, ancestors: [...parents].map(file) };
const ownerPermit = witness.attest(canonical(enrollment));
const openingLock = new Database(join(root, 'fixture-opening.sqlite'));
openingLock.exec('CREATE TABLE custody(value INTEGER)');
const renameAuthority = new Database(join(root, 'fixture-opening.sqlite'), { timeout: 0 });
const openedRoles = [], releasedRoles = [];
let denyOpen = mode === 'open-lease-loss';
const storage = createMaintenanceStorage({ enrollment, acquire(bound, role) {
  assert(witness.check(canonical(bound), ownerPermit));
  if (mode === 'swap-at-acquire' && role === 'operationalHub') {
    renameAuthority.exec('BEGIN IMMEDIATE');
    renameSync(hubPath, hubPath + '.moved');
    writeFileSync(hubPath, readFileSync(hubPath + '.moved'));
    renameAuthority.exec('COMMIT');
  }
  if (mode === 'prior-at-open' && role === 'service') {
    writeFileSync(join(journalRoot, 'maintain.claim.json'), 'contrary evidence during acquisition');
  }
  openingLock.exec('BEGIN IMMEDIATE');
  assert.throws(() => renameAuthority.exec('BEGIN IMMEDIATE'), { code: 'SQLITE_BUSY' });
  openedRoles.push(role);
  let reads = 0;
  return { current() { return ++reads > 0 && openingLock.inTransaction && !(denyOpen && reads === 2); },
    release() { openingLock.exec('ROLLBACK'); releasedRoles.push(role); } };
} });
if (mode === 'open-lease-loss') {
  assert.throws(() => storage.openOperationalHub());
  assert.deepEqual(releasedRoles, ['operationalHub']);
  denyOpen = false;
}
if (mode === 'pre-open-exchange') {
  renameAuthority.exec('BEGIN IMMEDIATE');
  await rename(hubPath, hubPath + '.moved');
  await writeFile(hubPath, await readFile(hubPath + '.moved'));
  renameAuthority.exec('COMMIT');
  assert.throws(() => storage.openOperationalHub());
  assert.deepEqual(releasedRoles, ['operationalHub']);
  await rename(hubPath + '.moved', hubPath);
}
if (mode === 'swap-at-acquire') {
  assert.throws(() => storage.openOperationalHub());
  await rename(hubPath + '.moved', hubPath);
}
if (['open-lease-loss', 'pre-open-exchange', 'swap-at-acquire'].includes(mode)) {
  assert.throws(() => storage.openOperationalHub());
  assert.deepEqual(openedRoles, ['operationalHub']);
  hub.closeAllConnections();
  await new Promise((done) => hub.close(done));
  for (const db of [alternate, hubLock, controls, openingLock, renameAuthority]) db.close();
  console.log(JSON.stringify({ mode, openedRoles, releasedRoles, knownLossLatched: true }));
  process.exit(0);
}
operational = storage.openOperationalHub();
const withdrawal = new AbortController();
let generationStops = 0, unavailable = false, revokedReceipt = false, leaseProbe;
const startupPermits = new Map();
const maintenance = {
  plan: { ...plan, ...(mode === 'default-local' && { protection: undefined }) }, signer, storage,
  generation: {
    withdrawal: withdrawal.signal,
    cleared(binding, role) {
      return credentialUsable() && witness.check(canonical({ binding, role }), startupPermits.get(role));
    },
    stop(binding) {
      assert(witness.check(canonical({ binding, role: 'service' }), startupPermits.get('service')));
      generationStops++;
      controls.prepare('UPDATE writer_gate SET permitted=0 WHERE id=1').run();
      if (alternate.open) alternate.close();
    },
  },
  authorize(binding) { return !!permit && witness.check(canonical(binding), permit); },
  begin(binding) {
    assert(this.authorize(binding)); assert.equal(++began, 1);
    controls.prepare('UPDATE writer_gate SET permitted=0 WHERE id=1 AND permitted=1').run();
    alternate.close();
    hubLock.exec('BEGIN IMMEDIATE');
    outerHeld = true;
    worker.stop();
    trace.push('begin');
    return {
      async joinWorkerAndFence() {
        assert.equal((await worker.drain({ timeoutMs: 5000 })).status, 'closed');
        assert.equal(workerDb.open, false);
        sealed = !alternate.open && hubLock.inTransaction && !credentialUsable();
        const uncertain = main.prepare("SELECT test_id FROM channel_tests WHERE status='sending'").pluck().get();
        controls.prepare('INSERT INTO unresolved VALUES (?,?)').run(binding.operationId, uncertain);
        trace.push('worker-closed');
      },
      current(subject) {
        if (leaseProbe === 'unavailable') return undefined;
        if (leaseProbe === 'lost') return false;
        const continuous = sealed && outerHeld && hubLock.inTransaction && !credentialUsable() &&
          !alternate.open && !workerDb.open && witness.check(canonical(subject), permit);
        if (mode === 'post-readback-outage' && continuous && main.open && answers.open && matchingManifests === 2) {
          // Both the signed operation and the explicit set read verified the terminal's manifest.
          if (!trace.includes('post-readback-unavailable')) {
            trace.push('post-readback-unavailable');
            return undefined;
          }
          trace.push('pre-close-confirmed');
        }
        return continuous;
      },
      async acquireInner(domains) {
        assert.deepEqual(domains, ['personal']); assert(sealed && main.open && answers.open);
        assert.equal(runtimeRecoveryWriteAllowed(main, 'personal'), false);
        assert.throws(() => serviceGate.admit(writer));
        innerCount++; trace.push('inner');
        const drained = service.read();
        const journaled = controls.prepare('SELECT channel_test FROM unresolved WHERE operation_id=?').pluck().get(binding.operationId) === 'probe';
        return { cutId: mode === 'bad-freeze' ? 'other-cut' : binding.cutId,
          ingressFrozen: drained.listener === 'closed' && drained.openConnections === 0,
          claimsFrozen: !workerDb.open && !credentialUsable(), receiptsFrozen: sealed && drained.activeRequests === 0,
          effectsFrozen: hubLock.inTransaction && !credentialUsable(),
          executionTreesStopped: worker.read().status === 'closed' && drained.runtime.active === 0,
          uncertainCallsJournaled: journaled, durableHandoff: journaled && (await readdir(handoffRoot)).includes('local-answers.sqlite'),
          async release() { innerRelease++; assert(sealed && outerHeld); trace.push('inner-release'); } };
      },
      async finish(subject, closed, manifestHash) {
        assert(outerHeld && !alternate.open && !workerDb.open);
        assert.equal(closed, !answers.open && !main.open);
        trace.push('finish');
        if (closed && manifestHash && this.current(subject)) closure = witness.attest(canonical({ subject, manifestHash, closed }));
        if (mode === 'lost-close') throw new Error('fixture finish reply lost');
      },
    };
  },
  readClose(subject, manifestHash) {
    closedReads++;
    if (mode === 'receipt-handoff-exchanged' && closedReads === 1) return undefined;
    if (unavailable || (mode === 'receipt-outage' && closedReads === 1)) throw new Error('fixture receipt unavailable');
    if (revokedReceipt) return false;
    return closure && outerHeld && !main.open && !answers.open && !alternate.open && !workerDb.open &&
      witness.check(canonical({ subject, manifestHash, closed: true }), closure) ? hash(closure) : undefined;
  },
};
const serviceConfig = {
  databasePath, credentialDirectory,
  recoveryRuntime: { attach({ database, admission: gate }) {
    database.prepare("INSERT OR IGNORE INTO recovery_domain_gates(data_domain,writer_epoch,status,activation_id,witness_revision,reason,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run('personal', 'epoch', 'open', 'grant', 'rev-1', 'test', new Date(0).toISOString());
    gate.admit(writer);
    if (!main) { main = database; serviceGate = gate; }
    else workerDb = database;
  } },
  bindRecoveryOperations(resources) {
    answers = resources.hubDatabase; localHub = resources.hub;
    originalAnswerClose = localHub.close.bind(localHub);
    localHub.close = () => {
      closeAttempts++;
      assert(main.open);
      if (mode === 'close-failed') throw new Error('fixture checkpoint failed');
      originalAnswerClose();
    };
    const normal = mode === 'root-ancestor' ? '/' : mode === 'private-descendant' ? join(handoffRoot, 'ordinary') : normalRoot;
    return { root: normal, authority: signer, targets: {} };
  },
  notificationMaintenance: {
    hub: { async claim() { serviceEntered.resolve(); await serviceRelease.promise; return null; },
      async heartbeat() { return []; }, async result() { return { rejected: [] }; } },
    transport: { async send() { throw new Error(); }, async lookup() { return null; } },
    scopes: [{ accountId: 'owner', dataDomain: 'personal' }], timezone: 'UTC', credentialUsable: () => false,
  },
};
const readDatabase = (db) => ({
  hubSeq: db.prepare('SELECT COALESCE(MAX(hub_seq),0) AS seq FROM hub_snapshots').get().seq,
  domainSeq: db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM domain_events').get().seq,
  schemaHistory: db.prepare('SELECT file,sha256 FROM schema_migrations ORDER BY position').all(),
});
  expected = { ...structuredClone(plan), identity, captureHost: hostname(), signerId: signer.keyId,
    runtime: { dataRoot: root, profile: 'test', origin: 'http://localhost', rpId: 'localhost',
      listener: { host: '127.0.0.1', port: 0, origin: 'http://localhost' }, operationalHub: { origin: hubOrigin, commit: pin } },
    roots: [journalRoot, setRoot, handoffRoot].map(file), files: {
      service: file(databasePath), worker: file(databasePath), operationalHub: file(hubPath), localAnswers: file(localAnswersPath),
    } };
for (const role of ['service', 'worker']) startupPermits.set(role, witness.attest(canonical({ binding: expected, role })));
const makeProvision = (hubConnection = operational, ordinaryRoot) => createRuntimeProvisioning({
  ...(ordinaryRoot && { hostCapabilities: { recovery: { root: ordinaryRoot, authority: signer, targets: {} } } }),
  registration: { identity, captureHost: hostname(), serviceUid: uid, profile: 'test',
  dataRoot: root, minimumFreeBytes: 0, origin: 'http://localhost', rpId: 'localhost',
  listener: { host: '127.0.0.1', port: 0, origin: 'http://localhost' }, operationalHub: { origin: hubOrigin, commit: pin } },
  operationalRecoveryHub: { identity, database: hubConnection, physicalPath: hubPath, readDatabase }, maintenance, service: serviceConfig,
  worker: { keys: { owner: 'fixture-owner', worker: 'fixture-worker', source: 'fixture-source' }, backend } });
if (unbound) {
  assert.throws(() => makeProvision(unbound));
  const sameFile = new Database(hubPath, { readonly: true });
  try { assert.throws(() => makeProvision(sameFile)); } finally { sameFile.close(); }
  unbound.close();
}
if (mode === 'root-ancestor') {
  assert.throws(() => makeProvision(operational, '/'));
  assert.deepEqual(openedRoles, ['operationalHub']);
}
const provision = makeProvision();
assert.throws(() => makeProvision());
const watchdog = setTimeout(() => { console.error('fixture deadline', mode, trace); process.exit(3); }, 12000);
async function scenario() {
  if (['prior-start', 'prior-set', 'prior-handoff', 'prior-at-open', 'prior-other-operation', 'clearance-mismatch'].includes(mode)) {
    if (mode === 'prior-start') await writeFile(join(journalRoot, 'maintain.claim.json'), 'previous operation evidence');
    if (mode === 'prior-other-operation') await writeFile(join(journalRoot, 'older.claim.json'), 'prior generation evidence');
    if (mode === 'prior-set') await mkdir(join(setRoot, 'owned'));
    if (mode === 'prior-handoff') await writeFile(join(handoffRoot, 'local-answers.sqlite'), 'prior handoff');
    if (mode === 'clearance-mismatch') startupPermits.set('service', startupPermits.get('worker'));
    await assert.rejects(runInstalledService(provision));
    await assert.rejects(runInstalledWorker(provision));
    assert.deepEqual(openedRoles, mode === 'prior-at-open' ? ['operationalHub', 'service'] : ['operationalHub']);
    const seed = new Database(databasePath, { readonly: true });
    try { assert.equal(seed.prepare("SELECT count(*) FROM sqlite_schema WHERE name='schema_migrations'").pluck().get(), 0); }
    finally { seed.close(); }
    assert.equal(main, undefined); assert.equal(workerDb, undefined);
    assert.equal(innerCount + began, 0); assert.equal(generationStops, mode === 'prior-at-open' ? 1 : 0);
    return;
  }
  if (mode === 'root-ancestor' || mode === 'private-descendant') {
    await assert.rejects(runInstalledService(provision));
    assert.equal(main.open, false); assert.equal(answers.open, false); assert.equal(operational.open, true);
    assert.equal(closeAttempts, 1);
    return;
  }
  service = await runInstalledService(provision);
  worker = await runInstalledWorker(provision);
  await Promise.all([serviceEntered.promise, rawEntered.promise]);
  assert(service.maintenance, 'started installed owner must expose its enrolled maintenance cut');
  const observed = (id = 'maintain') => service.maintenance.read(id);
  const capture = (timeoutMs = 5000, operationId = 'maintain') => service.maintenance.capture({ operationId, timeoutMs });
  assert.deepEqual(openedRoles.slice(-4), ['operationalHub', 'service', 'localAnswers', 'worker']);
  assert.deepEqual(releasedRoles, openedRoles);
  assert.equal(answers.name, localAnswersPath);
  if (mode === 'generation-layout') assert(!((await readdir(root)).includes('service.sqlite.hub')));
  assert.equal(observed().status, 'absent');
  if (['warm-prior', 'warm-admit', 'warm-withdraw'].includes(mode)) {
    await writeFile(join(journalRoot, 'maintain.claim.json'), 'uncertain prior operation');
    if (mode === 'warm-admit') assert.throws(() => serviceGate.admit(writer));
    else if (mode === 'warm-withdraw') withdrawal.abort();
    else assert.equal((await capture()).status, 'unresolved');
    assert.equal(service.read().runtime.status, 'draining');
    assert.equal(worker.read().status, 'draining');
    for (const db of [main, workerDb]) { assert(db.open); assert.equal(runtimeRecoveryWriteAllowed(db, 'personal'), false); }
    assert(answers.open); assert.equal(credentialUsable(), false);
    assert.equal(await fetch(service.url + '/healthz').then((r) => r.status, () => 503), 503);
    serviceRelease.resolve(); rawRelease.resolve();
    assert.equal((await worker.drain()).status, 'closed');
    assert.equal((await service.drain()).runtime.status, 'closed');
    assert.equal((await capture()).status, 'unresolved');
    assert.deepEqual(await readdir(journalRoot), ['maintain.claim.json']);
    assert.deepEqual(await readdir(setRoot), []); assert.deepEqual(await readdir(handoffRoot), []);
    assert.equal(began + innerCount, 0); assert.equal(generationStops, 1);
    return;
  }
  assert.equal((await capture(100, 'other')).status, 'blocked');
  for (const wrong of [{ ...expected, cutId: 'old-cut' }, { ...expected, identity: { ...identity, configRevision: '2' } },
    { ...expected, files: { ...expected.files, service: expected.files.operationalHub } },
    { ...expected, writers: [{ ...writer, witnessRevision: 'old' }] }]) {
    permit = witness.attest(canonical(wrong));
    assert.equal((await capture()).status, 'blocked');
  }
  assert.equal(began, 0); assert.equal((await fetch(service.url + '/healthz')).status, 200);
  permit = witness.attest(canonical(expected));
  await localHub.accept('attributed-question', 19, { text: 'original answer' });
  main.prepare("INSERT INTO channel_tests VALUES ('probe','c','owner','personal','p','d','sending',NULL,NULL,'a','t',1,1,'b',1,1,NULL,'1','t','t')").run();
  const now = new Date().toISOString();
  main.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run('owner', 1, 1, now);
  main.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)').run(hash('fixture-session'), 'owner', 'web', 1,
    new Date(Date.now() + 60000).toISOString(), now, 'fixture');
  const stream = await fetch(service.url + '/api/v1/session/stream', { headers: { cookie: ['patrick_session', 'fixture-session'].join('=') } });
  assert.equal(stream.status, 200);
  const consumer = stream.body.getReader();
  assert.match(new TextDecoder().decode((await consumer.read()).value), /event: open/);
  if (mode === 'ordinary-first') service.stop();
  if (mode === 'inode-swap') {
    await rename(databasePath + '.hub', databasePath + '.saved');
    await writeFile(databasePath + '.hub', await readFile(databasePath + '.saved'));
  }
  const pending = capture(mode === 'join-timeout' ? 20 : 5000);
  if (mode === 'ordinary-first' || mode === 'inode-swap') {
    assert.equal((await pending).status, 'blocked');
    assert.equal(began, 0);
    if (mode === 'inode-swap') {
      await rename(databasePath + '.saved', databasePath + '.hub');
      assert.equal((await capture()).status, 'blocked');
    }
  } else {
    assert.equal(observed().phase, 'joining');
    assert.equal((await capture(1)).status, 'unresolved');
    assert.equal((await capture(1, 'other')).status, 'blocked');
    assert.throws(() => alternateWrite(8), /capability withdrawn/);
    const reopened = new Database(hubPath, { timeout: 0 });
    try { assert.throws(() => reopened.prepare('INSERT INTO fixture_external VALUES (8)').run(), { code: 'SQLITE_BUSY' }); }
    finally { reopened.close(); }
    assert.throws(() => serviceGate.admit(writer));
    await assert.rejects(runInstalledService(provision));
    await assert.rejects(runInstalledWorker(provision));
    assert.equal(await fetch(service.url + '/healthz').then((r) => r.status, () => 503), 503);
    const queued = await service.drain({ timeoutMs: 1 });
    assert.equal(queued.runtime.status, 'draining');
    assert(main.open && workerDb.open && answers.open);
    assert.deepEqual(await readdir(journalRoot), []);
    serviceRelease.resolve();
    await wait(3);
    assert.equal(worker.read().status, 'draining'); assert.equal(innerCount, 0);
    if (mode === 'join-timeout') assert.equal((await pending).status, 'unresolved');
    rawRelease.resolve();
    if (!['join-timeout', 'bad-freeze', 'file-after-claim'].includes(mode)) {
      await signing.promise;
      assert(main.open && answers.open && !workerDb.open && !alternate.open);
      assert.equal((await capture(1)).phase, 'capturing');
      if (mode === 'sign-timeout') {
        assert.equal((await pending).status, 'unresolved');
        assert(main.open && answers.open && hubLock.inTransaction);
      }
      if (mode.startsWith('SIG')) {
        process.stdout.write(JSON.stringify({ ready: true }) + '\n');
        await once(process, mode);
        assert.equal((await service.drain({ timeoutMs: 1 })).runtime.status, 'draining');
        assert(main.open && answers.open);
      }
      signRelease.resolve();
    }
    const firstResult = await pending;
    if (mode === 'receipt-outage') assert.equal(firstResult.status, 'unresolved');
    if (mode === 'receipt-handoff-exchanged') {
      assert.equal(firstResult.status, 'unresolved');
      const original = await readFile(join(handoffRoot, 'local-answers.sqlite'));
      const signedCopy = join(setRoot, 'owned/resources/0/local-answers.sqlite');
      await writeFile(signedCopy, Buffer.alloc(original.length));
      assert.equal((await capture()).status, 'unresolved');
      await writeFile(signedCopy, original);
      assert.equal((await capture()).status, 'unresolved');
      assert.equal(innerCount, 1); assert.equal(trace.filter((entry) => entry === 'finish').length, 1);
      return;
    }
    const signsBeforeRepeat = signs;
    if (mode === 'post-readback-outage') {
      assert.equal(firstResult.status, 'unresolved');
      assert.deepEqual(trace.slice(-3), ['post-readback-unavailable', 'pre-close-confirmed', 'finish']);
      assert.equal(main.open || answers.open, false);
      assert(witness.check(canonical({ subject: expected, manifestHash: terminalHash, closed: true }), closure));
    }
    const result = await capture(5000);
    if (mode === 'post-readback-outage') {
      assert.equal(result.status, 'verified');
      assert.equal(result.manifestHash, terminalHash);
      assert.equal(signs, signsBeforeRepeat);
      assert.deepEqual((await readdir(journalRoot)).sort(), ['maintain.claim.json', 'maintain.reservation.json', 'maintain.terminal.json']);
    }
    assert.equal(closeAttempts, 1);
    assert.equal(service.read().runtime.status, mode === 'close-failed' ? 'close_failed' : 'closed');
    assert.equal(answers.open, mode === 'close-failed'); assert.equal(main.open, mode === 'close-failed');
    assert.equal(workerDb.open || alternate.open, false);
    assert(operational.open && outerHeld);
    if (['join-timeout', 'missing-terminal', 'bad-freeze', 'close-failed', 'file-after-claim'].includes(mode)) {
      assert.equal(result.status, 'unresolved');
      assert.equal(innerCount, ['join-timeout', 'file-after-claim'].includes(mode) ? 0 : 1);
      if (mode === 'file-after-claim') {
        assert.deepEqual((await readdir(journalRoot)).sort(), ['maintain.claim.json', 'maintain.reservation.json']);
        assert.deepEqual(await readdir(setRoot), []);
        await rename(hubPath + '.registered', hubPath);
        assert.equal((await capture()).status, 'unresolved');
      }
      if (mode === 'missing-terminal') {
        assert((await readdir(setRoot)).includes('owned'));
        assert.deepEqual((await readdir(journalRoot)).sort(), ['maintain.claim.json', 'maintain.reservation.json']);
      }
    } else {
      assert.equal(result.status, 'verified');
      assert.equal(innerCount, 1); assert.equal(innerRelease, 1);
      const envelope = JSON.parse(await readFile(join(setRoot, 'owned/manifest.json'), 'utf8'));
      const terminal = JSON.parse(await readFile(join(journalRoot, 'maintain.terminal.json'), 'utf8'));
      assert(migrationSigner.check(canonical(envelope.manifest), envelope.signature));
      assert(migrationSigner.check(canonical(terminal.payload), terminal.signature));
      assert.equal(result.manifestHash, hash(canonical(envelope.manifest)));
      assert.equal(terminal.payload.outcome.manifestHash, result.manifestHash);
      assert.deepEqual(envelope.manifest.domains, [domain]);
      assert.equal(envelope.manifest.protection.status, 'local_only');
      assert(!((await readdir(join(setRoot, 'owned'))).includes('off-host-receipt.json')));
      const handoff = envelope.manifest.artifacts.find((artifact) => artifact.kind === 'handoff');
      assert.equal(handoff.hash, hash(await readFile(join(setRoot, 'owned', handoff.path))));
      function query(path, sql) {
        const db = new Database(join(setRoot, 'owned', path), { readonly: true, fileMustExist: true });
        try { return db.prepare(sql).get(); } finally { db.close(); }
      }
      assert.deepEqual(query(handoff.path, 'SELECT * FROM hub_answers'), { question_id: 'attributed-question', card_id: 19,
        body_json: '{"text":"original answer"}', answer_event_id: 'hub:attributed-question:19' });
      assert.deepEqual(query('databases/service.sqlite', 'SELECT status,reason_code FROM channel_tests'),
        { status: 'unknown', reason_code: 'recovery_cut_unconfirmed' });
      assert.deepEqual(query('databases/hub.sqlite', 'SELECT id FROM fixture_external'), { id: 7 });
      const before = signs;
      assert.deepEqual(observed(), result);
      assert.deepEqual(await capture(), result);
      assert.equal(signs, before);
      assert.equal(began, 1);
      if (mode === 'lost-response') assert(dropped);
      if (mode === 'warm-receipt-outage') {
        unavailable = true; assert.equal(observed().status, 'unresolved');
        unavailable = false; assert.deepEqual(await capture(), result);
      }
      if (mode === 'lease-outage') {
        leaseProbe = 'unavailable'; assert.equal(observed().status, 'unresolved');
        leaseProbe = undefined; assert.deepEqual(await capture(), result);
        leaseProbe = 'lost'; assert.equal(observed().status, 'unresolved');
        leaseProbe = undefined; assert.equal((await capture()).status, 'unresolved');
      }
      if (mode === 'revoked-receipt') {
        revokedReceipt = true; assert.equal(observed().status, 'unresolved');
        revokedReceipt = false; assert.equal((await capture()).status, 'unresolved');
      }
      if (mode === 'tamper-handoff') {
        const path = join(setRoot, 'owned', handoff.path);
        const original = await readFile(path);
        await writeFile(path, Buffer.alloc(original.length));
        assert.equal((await capture()).status, 'unresolved');
        await writeFile(path, original);
        assert.equal((await capture()).status, 'unresolved');
      }
      assert.equal(trace.filter((entry) => entry === 'finish').length, 1);
      assert.equal(signs, before);
      if (mode === 'tamper-after-close') {
        const path = join(journalRoot, 'maintain.terminal.json');
        await writeFile(path, JSON.stringify({ ...terminal, signature: terminal.signature.slice(7) }));
        assert.equal((await capture()).status, 'unresolved');
        assert.equal(signs, before);
      }
    }
  }
  console.log(JSON.stringify({ mode, outcome: observed().status, began, innerCount, innerRelease, closedReads, trace }));
}
try {
  await scenario();
  console.log(JSON.stringify({ mode, openedRoles, releasedRoles, generationStops }));
} catch (error) {
  console.error(error, { mode, trace }); process.exitCode = 1;
} finally {
  serviceRelease.resolve(); rawRelease.resolve(); signRelease.resolve();
  await worker?.drain({ timeoutMs: 1000 }); await service?.drain({ timeoutMs: 1000 });
  hub.closeAllConnections(); await new Promise((done) => hub.close(done));
  if (mode === 'close-failed' && answers?.open) { originalAnswerClose(); main.close(); }
  if (alternate.open) alternate.close();
  hubLock.close(); controls.close(); openingLock.close(); renameAuthority.close();
  if (operational.open) operational.close();
  clearTimeout(watchdog);
  // A genuine failed close intentionally retains its runtime keepalive. This isolated
  // test process owns its resources and exits only after observing the failure.
  if (mode === 'close-failed') process.exit(process.exitCode ?? 0);
}
`);
    if (mode === 'SIGINT' || mode === 'SIGTERM') {
      const child = spawn(process.execPath, [harness, relocated, mode], { cwd: temporary, stdio: ['ignore', 'pipe', 'pipe'] });
      const result = await runSignalHarness(child, mode);
      expect(result.code, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain('"outcome":"verified"');
    } else {
      const result = runNode([harness, relocated, mode], { cwd: temporary });
      expect(result.status, output(result)).toBe(0);
    }
  }, 30000);

  test('reaps only its stalled signal fixture when readiness and graceful termination expire', async () => {
    const child = spawn(process.execPath, ['--eval', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
      cwd: temporary,
      env: { PATH: process.env.PATH, NODE_OPTIONS: '', NODE_PATH: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await expect(runSignalHarness(child, 'SIGTERM', { ready: 1500, graceful: 50, reap: 2000 })).rejects.toThrow('readiness timeout');
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBe('SIGKILL');
  });

  test('rejects missing, extra, symlinked, migration-tampered, and native-missing materials', async () => {
    const extra = await copyArtifact('extra');
    await writeFile(join(extra, 'unexpected.txt'), 'unexpected');
    let verified = runNode([buildScript, 'verify', '--artifact-root', extra]);
    expect(verified.status, output(verified)).not.toBe(0);
    expect(output(verified)).toContain('RUNTIME_MATERIAL_EXTRA');

    const missing = await copyArtifact('missing');
    await rm(join(missing, 'runtime/worker.mjs'));
    verified = runNode([buildScript, 'verify', '--artifact-root', missing]);
    expect(verified.status, output(verified)).not.toBe(0);
    expect(output(verified)).toContain('RUNTIME_MATERIAL_MISSING');

    const linked = await copyArtifact('linked');
    await rm(join(linked, 'web/index.html'));
    await symlink(join(relocated, 'web/index.html'), join(linked, 'web/index.html'));
    verified = runNode([buildScript, 'verify', '--artifact-root', linked]);
    expect(verified.status, output(verified)).not.toBe(0);
    expect(output(verified)).toContain('RUNTIME_MATERIAL_SYMLINK');

    const migration = await copyArtifact('migration-tampered');
    const manifest = JSON.parse(await readFile(join(migration, 'migrations/manifest.json'), 'utf8')) as Array<{ file: string }>;
    await writeFile(join(migration, 'migrations', manifest[0].file), 'SELECT 1;');
    const migrationProbe = runNode([
      '--input-type=module',
      '--eval',
      `const {openRuntimeDatabase}=await import(${JSON.stringify(pathToFileURL(join(migration, 'runtime/composition.mjs')).href)});
       openRuntimeDatabase(${JSON.stringify(join(temporary, 'tampered.sqlite'))});`,
    ], { cwd: temporary });
    expect(migrationProbe.status, output(migrationProbe)).not.toBe(0);
    expect(output(migrationProbe)).toContain('SCHEMA_FILE_HASH_MISMATCH');

    const native = await copyArtifact('native-missing');
    const inventory = JSON.parse(await readFile(join(native, 'metadata/runtime-materials.json'), 'utf8')) as { native: { path: string } };
    await rm(join(native, inventory.native.path));
    const nativeProbe = runNode([
      '--input-type=module',
      '--eval',
      `const {openRuntimeDatabase}=await import(${JSON.stringify(pathToFileURL(join(native, 'runtime/composition.mjs')).href)});
       openRuntimeDatabase(${JSON.stringify(join(temporary, 'native.sqlite'))});`,
    ], { cwd: temporary });
    expect(nativeProbe.status, output(nativeProbe)).not.toBe(0);
    expect(output(nativeProbe)).toMatch(/better_sqlite3|Could not locate the bindings file/);
    await writeFile(join(native, inventory.native.path), 'fixture invalid native addon');
    const mismatch = runNode([
      '--input-type=module',
      '--eval',
      `const {openRuntimeDatabase}=await import(${JSON.stringify(pathToFileURL(join(native, 'runtime/composition.mjs')).href)});
       openRuntimeDatabase(${JSON.stringify(join(temporary, 'invalid-native.sqlite'))});`,
    ], { cwd: temporary });
    expect(mismatch.status, output(mismatch)).not.toBe(0);
    expect(output(mismatch)).toMatch(/ERR_DLOPEN_FAILED|not a mach-o|invalid ELF/);
  }, 120_000);
});
