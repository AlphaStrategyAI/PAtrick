import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, createReadStream, openSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { constants, hostname, machine } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { applyHostRegistry, planHostRegistry, readHostRegistry } from '../../deploy/host/registry.js';
import { servicePreflight } from '../../deploy/lib/deployment-templates.mjs';
import { reserveControllerServiceSession, reserveServiceWriter, type GenerationEnrollment } from '../../deploy/runtime/lifecycle-generation.js';
import { createRuntimeProvisioning } from '../../deploy/runtime/composition.js';
import {
  executeSupervisedOwnerBootstrap,
  listenVerifiedServiceControl,
  ownerBootstrapControlEndpoint,
  requestInstalledOwnerBootstrap,
  runInstalledOwnerBootstrapControl,
  runInstalledWorkerSupervisor,
  serveInstalledOwnerBootstrapControl,
  serveInstalledWorkerTicks,
  serveSelectedService,
  type OwnerBootstrapRequester,
} from '../../deploy/runtime/role-launch.js';
import { createInstalledService } from '../../deploy/runtime/service.js';
import {
  serviceFrame, serviceHandoffKey, serviceOwnerBootstrapIssued, serviceOwnerBootstrapUnavailable,
  serviceStatus, type ServiceSelection,
} from '../../deploy/runtime/service-handoff.js';

const enabled = process.env.PATRICK_T23_CONTROLLED_LAUNCH === '1';
const archivedMaterials = process.env.PATRICK_T23_CONTROLLED_MATERIALS;

test('the installed Worker supervisor requires a registered launchd listener', async () => {
  const serve = vi.fn();
  await expect(runInstalledWorkerSupervisor({ path: '/unused', sha256: 'a'.repeat(64) }, '/unused.sock', serve))
    .rejects.toThrow('INSTALLED_WORKER_SUPERVISOR_LISTENER_REQUIRED');
  expect(serve).not.toHaveBeenCalled();
});

test('the Worker channel rejects extra data and releases a disconnected Worker while Service owns its tick', async ({ onTestFinished }) => {
  expect(typeof serveInstalledWorkerTicks).toBe('function');
  const root = await mkdtemp('/private/tmp/patrick-worker-tick-');
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const endpoint = join(root, 'tick.sock');
  const shutdown = new AbortController();
  let admit!: () => void;
  let finish!: (available: boolean) => void;
  const admitted = new Promise<void>(resolveAdmission => { admit = resolveAdmission; });
  const result = new Promise<boolean>(resolveResult => { finish = resolveResult; });
  const trigger = vi.fn(() => {
    admit();
    return result;
  });
  const sessions = new Set<Promise<void>>();
  const server = createServer({ allowHalfOpen: true }, socket => {
    const session = serveInstalledWorkerTicks(socket, shutdown.signal, trigger)
      .catch(() => {}).finally(() => socket.destroy());
    sessions.add(session);
  });
  server.listen(endpoint);
  await once(server, 'listening');
  try {
    const invalid = createConnection(endpoint);
    invalid.end('{"payload":"extra","type":"consultation-tick","version":1}\n');
    await once(invalid, 'close');
    expect(trigger).not.toHaveBeenCalled();
    sessions.clear();

    const worker = createConnection(endpoint);
    worker.write('{"type":"consultation-tick","version":1}\n');
    await admitted;
    const closedWorker = once(worker, 'close');
    worker.destroy();
    await closedWorker;
    const disconnected = await Promise.race([
      Promise.all(sessions).then(() => true),
      new Promise<boolean>(resolveDelay => setTimeout(() => resolveDelay(false), 1000).unref()),
    ]);
    expect(disconnected).toBe(true);
    expect(trigger).toHaveBeenCalledTimes(1);
  } finally {
    shutdown.abort();
    finish(false);
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
});

test('owner bootstrap control channel validates socket permissions, rejects malformed requests, and releases disconnected callers', async ({ onTestFinished }) => {
  const root = await mkdtemp('/private/tmp/patrick-owner-ctl-');
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const controlDir = join(root, 'control');
  await mkdir(controlDir, { mode: 0o700 });
  const endpoint = join(controlDir, 'owner.sock');
  expect(ownerBootstrapControlEndpoint('/Library/Application Support/PAtrick/instance')).toBe(
    '/Library/Application Support/PAtrick/instance/runtime/service-control/owner.sock',
  );

  const longEndpoint = join(controlDir, `${'a'.repeat(90)}.sock`);
  await expect(runInstalledOwnerBootstrapControl(longEndpoint, AbortSignal.timeout(500), async () => ({
    status: 'unavailable', code: 'OWNER_BOOTSTRAP_UNAVAILABLE',
  }))).rejects.toThrow('INSTALLED_OWNER_BOOTSTRAP_CONTROL_INVALID');

  const looseDir = join(root, 'loose');
  await mkdir(looseDir, { mode: 0o755 });
  await expect(runInstalledOwnerBootstrapControl(join(looseDir, 'owner.sock'), AbortSignal.timeout(500), async () => ({
    status: 'unavailable', code: 'OWNER_BOOTSTRAP_UNAVAILABLE',
  }))).rejects.toThrow('INSTALLED_OWNER_BOOTSTRAP_CONTROL_INVALID');

  const regularTarget = join(controlDir, 'not-a-socket.sock');
  await writeFile(regularTarget, 'plain', { mode: 0o600 });
  await expect(runInstalledOwnerBootstrapControl(regularTarget, AbortSignal.timeout(500), async () => ({
    status: 'unavailable', code: 'OWNER_BOOTSTRAP_UNAVAILABLE',
  }))).rejects.toThrow('INSTALLED_OWNER_BOOTSTRAP_CONTROL_INVALID');
  await expect(requestInstalledOwnerBootstrap(regularTarget)).rejects.toThrow('INSTALLED_OWNER_BOOTSTRAP_CONTROL_INVALID');

  const symlinkTarget = join(controlDir, 'link.sock');
  await symlink(endpoint, symlinkTarget);
  await expect(requestInstalledOwnerBootstrap(symlinkTarget)).rejects.toThrow('INSTALLED_OWNER_BOOTSTRAP_CONTROL_INVALID');

  const shutdown = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>(resolveReady => { ready = resolveReady; });
  const sampleTicket = 'A'.repeat(43);
  const sampleExpires = '2026-11-27T12:00:00.000Z';
  const sampleSession = 'a'.repeat(32);
  const sampleSelectionSha = 'b'.repeat(64);
  let nextResponse: Awaited<ReturnType<OwnerBootstrapRequester>> = {
    status: 'issued', ticket: sampleTicket, expires_at: sampleExpires,
    session: sampleSession, selectionSha256: sampleSelectionSha,
  };
  let admitPending!: () => void;
  let releasePending!: () => void;
  const pendingAdmitted = new Promise<void>(resolveAdmit => { admitPending = resolveAdmit; });
  const pendingRelease = new Promise<void>(resolveRelease => { releasePending = resolveRelease; });
  let holdNext = false;
  const issue = vi.fn<OwnerBootstrapRequester>(async () => {
    if (holdNext) {
      holdNext = false;
      admitPending();
      await pendingRelease;
    }
    return nextResponse;
  });
  const serverTask = runInstalledOwnerBootstrapControl(endpoint, shutdown.signal, issue, { onReady: ready });
  try {
    await started;
    const socketInfo = await stat(endpoint);
    expect(socketInfo.mode & 0o7777).toBe(0o600);

    const malformed = createConnection(endpoint);
    malformed.end('{"extra":true,"type":"issue-owner-bootstrap","version":1}\n');
    await once(malformed, 'close');
    expect(issue).not.toHaveBeenCalled();

    await expect(requestInstalledOwnerBootstrap(endpoint)).resolves.toEqual(nextResponse);
    expect(issue).toHaveBeenCalledTimes(1);

    nextResponse = { status: 'unavailable', code: 'RECOVERY_WRITE_BLOCKED' };
    await expect(requestInstalledOwnerBootstrap(endpoint)).resolves.toEqual(nextResponse);
    expect(issue).toHaveBeenCalledTimes(2);

    holdNext = true;
    const dropper = createConnection(endpoint);
    dropper.write('{"type":"issue-owner-bootstrap","version":1}\n');
    await pendingAdmitted;
    const dropperClosed = once(dropper, 'close');
    dropper.destroy();
    await dropperClosed;
    releasePending();
    nextResponse = { status: 'unavailable', code: 'OWNER_PASSKEY_ALREADY_REGISTERED' };
    await expect(requestInstalledOwnerBootstrap(endpoint)).resolves.toEqual(nextResponse);

    await chmod(endpoint, 0o644);
    await expect(requestInstalledOwnerBootstrap(endpoint)).rejects.toThrow('INSTALLED_OWNER_BOOTSTRAP_CONTROL_INVALID');
    await chmod(endpoint, 0o600);
  } finally {
    shutdown.abort();
    releasePending();
    await serverTask;
  }
  await expect(stat(endpoint)).rejects.toMatchObject({ code: 'ENOENT' });

  const directEndpoint = join(controlDir, 'direct.sock');
  const directShutdown = new AbortController();
  const directServer = createServer({ allowHalfOpen: true }, socket => {
    void serveInstalledOwnerBootstrapControl(socket, directShutdown.signal, async () => ({
      status: 'unavailable', code: 'OWNER_BOOTSTRAP_UNAVAILABLE',
    })).catch(() => {}).finally(() => socket.destroy());
  });
  directServer.listen(directEndpoint);
  await once(directServer, 'listening');
  await chmod(directEndpoint, 0o600);
  try {
    await expect(requestInstalledOwnerBootstrap(directEndpoint)).resolves.toEqual({
      status: 'unavailable', code: 'OWNER_BOOTSTRAP_UNAVAILABLE',
    });
  } finally {
    directShutdown.abort();
    directServer.close();
    await once(directServer, 'close');
  }
});

test('serveSelectedService bridges owner-bootstrap over the authenticated channel with single-flight, HTTP verification, and protocol checks', async ({ onTestFinished }) => {
  const root = await mkdtemp('/private/tmp/patrick-owner-bridge-');
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, 'service-data');
  await mkdir(dataRoot, { mode: 0o700 });
  const databasePath = join(dataRoot, 'service.sqlite');
  const credentialDirectory = join(dataRoot, 'credentials');
  await mkdir(credentialDirectory, { mode: 0o700 });
  const identity = {
    accountId: 'owner-bridge', scopeId: 'owner-bridge-scope', deviceId: 'darwin-arm64',
    configRevision: 'r1', domains: ['personal'],
  };
  let attachedDb: DatabaseSync | undefined;
  let admitWriter: (() => void) | undefined;
  const rpId = 'bridge.patrick.test';
  const origin = `https://${rpId}`;
  const provisioning = createRuntimeProvisioning({
    registration: {
      identity, captureHost: hostname(), serviceUid: process.geteuid!(), profile: 'test',
      dataRoot, minimumFreeBytes: 0, origin, rpId, listener: { host: '127.0.0.1', port: 0, origin },
    },
    service: {
      databasePath, credentialDirectory,
      recoveryRuntime: {
        attach({ database, admission }) {
          attachedDb = database as unknown as DatabaseSync;
          admitWriter = () => {
            const writer = { domain: 'personal', writerEpoch: 'epoch-1', activationId: 'act-1', witnessRevision: 'rev-1' };
            database.prepare(`INSERT INTO recovery_domain_gates(data_domain,writer_epoch,status,activation_id,witness_revision,reason,updated_at)
              VALUES(?,?,?,?,?,?,?)`).run(writer.domain, writer.writerEpoch, 'open', writer.activationId, writer.witnessRevision, 'test', new Date().toISOString());
            admission.admit(writer);
          };
        },
      },
      bindRecoveryOperations() {
        return {
          root: dataRoot, targets: {},
          authority: { keyId: 'fixture', async sign() { throw new Error('unexpected'); }, async verify() { return false; } },
        };
      },
    },
  });
  const runtime = createInstalledService(provisioning);
  onTestFinished(async () => { await runtime.drain(); });
  const service = {
    read: () => ({ listener: 'running' as const, activeRequests: 0, openConnections: 0, runtime: runtime.read() }),
    issueOwnerBootstrap: () => runtime.issueOwnerBootstrap(),
  };

  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const key = serviceHandoffKey(publicKey);
  const nodePin = { device: '1', inode: '2', birthtimeNs: '3' };
  const generation = {
    id: 'first-generation', schema: 1, packageSha256: 'c'.repeat(64), releaseRoot: nodePin, dataRoot: nodePin,
    roles: {
      service: nodePin, 'service.sqlite': nodePin, 'answers.sqlite': nodePin,
      credentials: nodePin, blobs: nodePin, projections: nodePin, 'hub/hub.db': nodePin,
    },
  };
  const enrollment = {
    installationId: 'owner-bridge-inst', hostId: 'owner-bridge-host', identity, root, rootNode: nodePin,
    serviceRole: { uid: process.geteuid!(), gid: process.getegid!(), rootNode: nodePin, writerNode: nodePin, controllerOwned: true as const },
  } as unknown as GenerationEnrollment;
  const session = 'd'.repeat(32);
  const selectionSha256 = 'e'.repeat(64);
  const endpoint = join(root, 'handoff.sock');

  const postChallenge = async (ticket: string) => {
    const response = await runtime.app.fetch(new Request(`${origin}/api/v1/auth/challenge`, {
      method: 'POST',
      headers: {
        host: rpId, origin, 'content-type': 'application/json', 'x-patrick-bootstrap': ticket,
      },
      body: JSON.stringify({ rp_id: rpId }),
    }));
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  };

  const openSockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, accepted => {
    openSockets.add(accepted);
    accepted.once('close', () => openSockets.delete(accepted));
  });
  server.listen(endpoint);
  await once(server, 'listening');
  onTestFinished(async () => {
    for (const openSocket of openSockets) openSocket.destroy();
    await new Promise<void>(resolveClosed => server.close(() => resolveClosed()));
  });

  const incoming = once(server, 'connection') as Promise<[Socket]>;
  const client = createConnection({ path: endpoint, allowHalfOpen: true });
  openSockets.add(client);
  const [serverSocket] = await incoming;
  const clientChannel = serviceFrame(client);
  const shutdown = new AbortController();
  let requestBootstrap: OwnerBootstrapRequester | undefined;
  let offered!: () => void;
  const ready = new Promise<void>(resolveReady => { offered = resolveReady; });
  let releaseDelay!: () => void;
  let delayNextReply = false;
  const replyGate = new Promise<void>(resolveGate => { releaseDelay = resolveGate; });
  let activeSelection!: ServiceSelection;

  const supervisorTask = serveSelectedService(
    serverSocket,
    { paths: { selectionSha256 } as never, deployment: {} as never, session, signal: shutdown.signal, assertCurrent() {} },
    enrollment, generation,
    { publicKey, signSelection: bytes => sign(null, bytes, pair.privateKey).toString('base64') },
    key, () => () => {}, () => {}, undefined,
    requester => {
      requestBootstrap = requester;
      if (requester) offered();
    },
  );

  const clientLoop = (async () => {
    expect(await clientChannel.read()).toEqual({ version: 1, type: 'ready' });
    clientChannel.write({ version: 1, type: 'hello', challenge: randomBytes(32).toString('hex') });
    const signed = await clientChannel.read() as { selection: ServiceSelection };
    activeSelection = signed.selection;
    for (;;) {
      const frame = await clientChannel.readOrEnd();
      if (frame === undefined) {
        clientChannel.write(serviceStatus('drained', activeSelection));
        client.end();
        return;
      }
      if (delayNextReply) {
        delayNextReply = false;
        await replyGate;
      }
      const reply = executeSupervisedOwnerBootstrap(service, activeSelection, () => {});
      clientChannel.write(reply);
    }
  })();

  await ready;
  expect(requestBootstrap).toBeTypeOf('function');

  await expect(requestBootstrap!()).resolves.toEqual({ status: 'unavailable', code: 'RECOVERY_WRITE_BLOCKED' });
  expect(service.read().runtime.status).toBe('running');

  admitWriter!();
  delayNextReply = true;
  const firstPending = requestBootstrap!();
  await expect(requestBootstrap!()).resolves.toEqual({ status: 'unavailable', code: 'OWNER_BOOTSTRAP_BUSY' });
  releaseDelay();
  const first = await firstPending;
  expect(first).toMatchObject({ status: 'issued', session, selectionSha256 });
  if (first.status !== 'issued') throw new Error('expected issued bootstrap ticket');

  const second = await requestBootstrap!();
  expect(second.status).toBe('issued');
  if (second.status !== 'issued') throw new Error('expected second issued bootstrap ticket');
  expect(second.ticket).not.toBe(first.ticket);

  expect((await postChallenge(first.ticket)).status).toBe(403);
  const challenge = await postChallenge(second.ticket);
  expect(challenge.status).toBe(200);
  expect((challenge.json.challenge as { rp: { id: string } }).rp.id).toBe(rpId);

  attachedDb!.prepare(`INSERT INTO passkey_credentials(credential_id, account_id, public_key, counter, created_at)
    VALUES('cred-1', ?, ?, 0, ?)`).run(identity.accountId, Buffer.from([1, 2, 3]), new Date().toISOString());
  await expect(requestBootstrap!()).resolves.toEqual({ status: 'unavailable', code: 'OWNER_PASSKEY_ALREADY_REGISTERED' });
  expect(service.read().runtime.status).toBe('running');

  shutdown.abort();
  const confirmDrain = await supervisorTask;
  confirmDrain();
  await clientLoop;
  serverSocket.destroy();
  client.destroy();
  expect(requestBootstrap).toBeUndefined();

  const badIncoming = once(server, 'connection') as Promise<[Socket]>;
  const rogueClient = createConnection({ path: endpoint, allowHalfOpen: true });
  openSockets.add(rogueClient);
  const [rogueServer] = await badIncoming;
  const rogueChannel = serviceFrame(rogueClient);
  const rogueTask = serveSelectedService(
    rogueServer,
    { paths: { selectionSha256 } as never, deployment: {} as never, session, signal: new AbortController().signal, assertCurrent() {} },
    enrollment, generation,
    { publicKey, signSelection: bytes => sign(null, bytes, pair.privateKey).toString('base64') },
    key, () => () => {}, () => {}, undefined, () => {},
  );
  await rogueChannel.read();
  rogueChannel.write({ version: 1, type: 'hello', challenge: randomBytes(32).toString('hex') });
  const rogueSigned = await rogueChannel.read() as { selection: ServiceSelection };
  rogueChannel.write(serviceOwnerBootstrapIssued(rogueSigned.selection, 'B'.repeat(43), '2026-11-27T12:00:00.000Z'));
  await expect(rogueTask).rejects.toThrow('INSTALLED_SERVICE_SUPERVISOR_PROTOCOL_INVALID');
  rogueServer.destroy();
  rogueClient.destroy();

  expect(serviceOwnerBootstrapUnavailable(activeSelection, 'OWNER_BOOTSTRAP_UNAVAILABLE')).toMatchObject({
    version: 1, type: 'owner-bootstrap-unavailable', session, selectionSha256, code: 'OWNER_BOOTSTRAP_UNAVAILABLE',
  });
});
const clt = '/Library/Developer/CommandLineTools';
const localClangSha = '1590ac950a3d627817d09ade5cb60b2115f17a72182a3141e010b4bcc482a0c9';
const localNodeSha = '533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4';
const source = fileURLToPath(new URL('../../deploy/host-controller/main.cc', import.meta.url));
const project = fileURLToPath(new URL('../..', import.meta.url));

test.skipIf(process.platform !== 'darwin' || process.getuid?.() === 0).each([0, 10_001])(
  'the Service uses its inherited socket without reopening it after waiting %i ms', async readyDelay => {
    const bootstrap = await build({
      stdin: { resolveDir: project, contents: `
        import fs from 'node:fs';
        import { generateKeyPairSync } from 'node:crypto';
        import { syncBuiltinESMExports } from 'node:module';
        import { hostname } from 'node:os';
        import { mock } from 'node:test';
        import { runSupervisedServiceRole } from './deploy/runtime/role-launch.js';
        const root = '/private/var';
        const info = fs.lstatSync(root, { bigint: true });
        const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
        const openPath = fs.openSync;
        fs.openSync = (path, ...options) => {
          if (path === '/dev/fd/3') throw Object.assign(new Error('reopening /dev/fd/3 denied'), { code: 'EACCES' });
          return openPath(path, ...options);
        };
        syncBuiltinESMExports();
        mock.timers.enable({ apis: ['setTimeout'] });
        const running = runSupervisedServiceRole({
          root, rootNode: { device: String(info.dev), inode: String(info.ino), birthtimeNs: String(info.birthtimeNs) },
          installationId: 'socket-test', hostId: 'socket-test', captureHost: hostname(),
          uid: process.getuid(), gid: process.getgid(), publicKey,
          identity: { accountId: 'test', scopeId: 'test', deviceId: 'test', configRevision: '1', domains: ['personal'] },
        }, () => { throw new Error('unexpected Service provisioning'); }).catch(error => {
          if (error.message !== 'INSTALLED_SERVICE_SUPERVISOR_PROTOCOL_INVALID') throw error;
        });
        mock.timers.tick(${readyDelay});
        console.log('waiting for supervisor');
        await running;
      ` },
      bundle: true, write: false, format: 'esm', platform: 'node',
      external: ['./composition.js', './service.js', './worker.js'],
    });
    const role = spawn(process.execPath, ['--input-type=module', '-e', bootstrap.outputFiles[0].text], {
      env: { PATRICK_SUPERVISOR_FD: '3' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    const channel = role.stdio[3] as Socket;
    channel.setTimeout(3000, () => channel.destroy(new Error('Service handshake test timed out')));
    const exited = once(role, 'close');
    let errors = '';
    role.stderr!.setEncoding('utf8').on('data', chunk => { errors += chunk; });
    try {
      await Promise.race([once(role.stdout!, 'data'), exited]);
      channel.end('{"type":"ready","version":1}\n');
      let response = '';
      for await (const chunk of channel) response += chunk.toString();
      expect(await exited, errors).toEqual([0, null]);
      expect(JSON.parse(response)).toMatchObject({ type: 'hello', version: 1, challenge: expect.stringMatching(/^[a-f0-9]{64}$/) });
    } finally {
      channel.destroy();
      role.kill();
    }
  },
);

test('proves the service listener serves the registered endpoint before admitting a role', async ({ onTestFinished }) => {
  const root = await mkdtemp('/private/tmp/patrick-svc-listener-');
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const endpoint = join(root, 'expected.sock');
  const unrelated = join(root, 'other.sock');
  const decoy = createServer(socket => socket.pipe(socket));
  decoy.listen(endpoint);
  await once(decoy, 'listening');
  const messages: string[] = [];
  const admit = (socket: Socket) => {
    messages.push('admitted');
    socket.resume();
    socket.end('ready\n');
  };
  try {
    await expect(listenVerifiedServiceControl({ path: unrelated }, endpoint, admit, AbortSignal.timeout(1000)))
      .rejects.toThrow('INSTALLED_SERVICE_LISTENER_UNVERIFIED');
  } finally {
    decoy.close();
    await once(decoy, 'close');
  }
  expect(messages).toEqual([]);
  const server = await listenVerifiedServiceControl({ path: endpoint }, endpoint, admit, AbortSignal.timeout(5000));
  try {
    const role = createConnection(endpoint);
    let response = '';
    for await (const bytes of role) response += bytes.toString();
    expect(response).toBe('ready\n');
    expect(messages).toEqual(['admitted']);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test.skipIf(process.env.PATRICK_T23_SYSTEM_SUPERVISOR_TEST !== '1')(
  'keeps the controller-owned service fence exclusive across independent UIDs',
  async ({ onTestFinished }) => {
    expect([process.platform, process.getuid!(), process.geteuid!()]).toEqual(['darwin', 0, 0]);
    const uid = Number(execFileSync('/usr/bin/id', ['-u', '_mdnsresponder'], { encoding: 'utf8' }).trim());
    const gid = Number(execFileSync('/usr/bin/id', ['-g', '_mdnsresponder'], { encoding: 'utf8' }).trim());
    expect(uid).toBeGreaterThan(0);
    expect(gid).toBeGreaterThan(0);
    const root = await mkdtemp('/private/tmp/patrick-system-writer-');
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const runtime = join(root, 'runtime');
    const control = join(runtime, 'service-control');
    const path = join(control, 'writer.sqlite');
    await chmod(root, 0o711);
    await mkdir(runtime, { mode: 0o711 });
    await mkdir(control, { mode: 0o700 });
    await writeFile(path, '', { mode: 0o600, flag: 'wx' });
    const writer = new DatabaseSync(path);
    try { writer.exec('PRAGMA journal_mode = DELETE; PRAGMA user_version = 1'); }
    finally { writer.close(); }
    const pin = async (target: string) => {
      const node = await stat(target, { bigint: true });
      return { device: String(node.dev), inode: String(node.ino), birthtimeNs: String(node.birthtimeNs) };
    };
    const enrollment = {
      root, rootNode: await pin(root),
      serviceRole: { uid, gid, controllerOwned: true, rootNode: await pin(control), writerNode: await pin(path) },
    } satisfies Pick<GenerationEnrollment, 'root' | 'rootNode' | 'serviceRole'>;
    const competingProcess = () => spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const fence = new DatabaseSync(process.argv[1], { timeout: 0 });
      try { fence.exec('BEGIN IMMEDIATE'); }
      catch (error) { process.exitCode = error.errcode === 5 ? 75 : 1; }
      finally { fence.close(); }
    `, path], { env: {}, timeout: 5000, encoding: 'utf8' });
    expect(() => reserveServiceWriter(enrollment, 'foreground')).toThrow('INSTALLED_SERVICE_CONTROLLER_REQUIRED');
    expect(spawnSync('/usr/bin/touch', [join(control, 'other')], { uid, gid }).status).toBe(1);
    const selection = reserveServiceWriter(enrollment, 'selection');
    try {
      expect(selection.roleSha256).toMatch(/^[a-f0-9]{64}$/);
      selection.guard();
      expect(() => reserveServiceWriter(enrollment, 'selection')).toThrow('INSTALLED_SERVICE_WRITER_BUSY');
      expect(competingProcess()).toMatchObject({ status: 75, signal: null, stderr: '' });
      execFileSync('/bin/chmod', ['+a', '_mdnsresponder allow add_file,delete_child', control]);
      try { expect(() => selection.guard()).toThrow('INSTALLED_SERVICE_WRITER_FENCE_INVALID'); }
      finally { execFileSync('/bin/chmod', ['-a#', '0', control]); }
    } finally { selection.release(); }
    const next = reserveServiceWriter(enrollment, 'selection');
    next.release();
    expect(competingProcess()).toMatchObject({ status: 0, signal: null, stderr: '' });

    const armed = reserveControllerServiceSession(enrollment);
    try {
      const confirmDrain = armed.authorize('a'.repeat(64), 'a'.repeat(32));
      expect(() => armed.authorize('a'.repeat(64), 'b'.repeat(32))).toThrow();
      expect(() => reserveServiceWriter(enrollment, 'selection')).toThrow('INSTALLED_SERVICE_WRITER_BUSY');
      confirmDrain();
    } finally { armed.release(); }
    reserveServiceWriter(enrollment, 'selection').release();

    const undrained = reserveControllerServiceSession(enrollment);
    try { undrained.authorize('a'.repeat(64), 'c'.repeat(32)); }
    finally { undrained.release(); }
    expect(competingProcess()).toMatchObject({ status: 0, signal: null, stderr: '' });
    expect(() => reserveServiceWriter(enrollment, 'selection')).toThrow('INSTALLED_SERVICE_DRAIN_REQUIRED');
    expect(() => reserveControllerServiceSession(enrollment)).toThrow('INSTALLED_SERVICE_DRAIN_REQUIRED');
  },
);

test.skipIf(process.env.PATRICK_T23_SYSTEM_SUPERVISOR_TEST !== '1').for([
  { role: 'hub', socketKey: 'HubControl' },
  { role: 'service', socketKey: 'ServiceControl' },
  { role: 'worker', socketKey: 'WorkerControl' },
] as const)(
  'authenticates the registered $role across system launchd and independent UIDs', { timeout: 60_000 },
  async ({ role, socketKey }, { onTestFinished }) => {
    expect([process.platform, process.getuid!(), process.geteuid!()]).toEqual(['darwin', 0, 0]);
    const account = (name: string) => ({
      uid: Number(execFileSync('/usr/bin/id', ['-u', name], { encoding: 'utf8' }).trim()),
      gid: Number(execFileSync('/usr/bin/id', ['-g', name], { encoding: 'utf8' }).trim()),
    });
    const hub = account('_www');
    const service = account('_mdnsresponder');
    const worker = { uid: hub.uid + 2, gid: hub.gid };
    for (const { uid, gid } of [hub, service, worker]) {
      expect(uid).toBeGreaterThan(0);
      expect(gid).toBeGreaterThan(0);
    }
    expect(new Set([hub.uid, service.uid, worker.uid]).size).toBe(3);
    const { uid, gid } = { hub, service, worker }[role];
    const root = await mkdtemp('/private/tmp/patrick-system-role-');
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await chmod(root, 0o755);
    const registry = join(root, 'registry');
    const endpoint = join(registry, role, 'supervisor.sock');
    const controller = join(root, 'controller');
    const header = join(root, 'registry.h');
    await writeFile(header, [
      '#define PATRICK_NATIVE_REGISTRY_TEST 1',
      `constexpr char registry_root[] = ${JSON.stringify(registry)};`,
      'constexpr auto registry_owner = 0U;',
    ].join('\n'), { mode: 0o600, flag: 'wx' });
    execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', 'clang++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
      '-O2', '-include', header, source, '-o', controller], { cwd: root, timeout: 30_000 });
    await chmod(controller, 0o555);
    const roleEntry = `
      import { fstatSync } from 'node:fs';
      import { Socket } from 'node:net';
      if (process.env.PATRICK_SUPERVISOR_FD !== '3' || !fstatSync(3).isSocket()) process.exit(76);
      const connection = new Socket({ fd: 3, readable: true, writable: true, allowHalfOpen: ${role === 'service'} });
      let response = '';
      for await (const part of connection) {
        response += part.toString();
        if (${JSON.stringify(role)} === 'service') {
          if (response === 'enrolled\\n') connection.write('stop\\n');
          if (response === 'enrolled\\nstopping\\n') connection.end('drained\\n');
        }
      }
      console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), response }));
    `;
    const supervisorEntry = `
      import { spawn } from 'node:child_process';
      import { closeSync, constants, openSync } from 'node:fs';
      import { createServer } from 'node:net';
      if (process.env.PATRICK_SUPERVISOR_LISTENER_FD !== '3' || process.getuid() !== 0) process.exit(76);
      const fd = openSync('/dev/fd/3', constants.O_RDWR);
      closeSync(3);
      createServer({ pauseOnConnect: true }, connection => {
        connection.on('error', () => connection.destroy());
        const check = spawn(${JSON.stringify(controller)}, ['check-role-peer', ${JSON.stringify(role)}], {
          env: {}, stdio: ['ignore', 'ignore', 'ignore', connection], timeout: 5000,
        });
        check.once('error', () => connection.destroy());
        check.once('close', status => {
          connection.resume();
          if (status === 0) connection.end('enrolled\\n');
          else if (status === 78) connection.end('rejected\\n');
          else connection.destroy();
        });
      }).listen({ fd });
    `;
    let roleSupervisorEntry: string | undefined;
    if (role !== 'hub') {
      const supervisorExport = role === 'service' ? 'runInstalledServiceSupervisor' : 'runInstalledWorkerSupervisor';
      const supervisorModule = join(root, 'role-supervision.mjs');
      await build({
        stdin: { contents: `export { ${supervisorExport} } from './deploy/runtime/role-launch.js';`, resolveDir: project },
        outfile: supervisorModule, bundle: true, format: 'esm', platform: 'node',
        external: ['./composition.js', './service.js', './worker.js'],
      });
      const program = { path: controller, sha256: await digest(controller) };
      roleSupervisorEntry = `
        import { ${supervisorExport} as supervise } from ${JSON.stringify(supervisorModule)};
        await supervise(${JSON.stringify(program)}, ${JSON.stringify(endpoint)}, (socket, shutdown) =>
          new Promise(resolve => {
            socket.once('close', resolve);
            if (${JSON.stringify(role)} === 'worker') {
              socket.resume();
              socket.end('enrolled\\n');
              return;
            }
            socket.once('data', request => {
              if (request.toString() !== 'stop\\n') return socket.destroy();
              socket.once('data', drained => {
                if (drained.toString() !== 'drained\\n') return socket.destroy();
                socket.end('stopped\\n');
              });
              process.kill(process.pid, 'SIGTERM');
            });
            shutdown.addEventListener('abort', () => socket.write('stopping\\n'), { once: true });
            socket.resume();
            socket.write('enrolled\\n');
          }));
      `;
    }
    const plan = planHostRegistry({
      registryRoot: registry,
      node: { path: process.execPath, sha256: await digest(process.execPath) },
      roles: {
        service: { ...service, entry: role === 'service' ? roleEntry : 'process.exit(76);' },
        hub: { ...hub, entry: role === 'hub' ? roleEntry : 'process.exit(76);' },
        worker: { ...worker, entry: role === 'worker' ? roleEntry : 'process.exit(76);' },
      },
      supervisor: { entry: supervisorEntry },
      ...(role === 'service' ? { serviceSupervisor: { entry: roleSupervisorEntry! } } : {}),
      ...(role === 'worker' ? { workerSupervisor: { entry: roleSupervisorEntry! } } : {}),
      cli: { entry: 'console.log(JSON.stringify({ uid: process.getuid(), args: process.argv.slice(2) }));' },
    });
    await applyHostRegistry(plan);
    expect(await readHostRegistry(plan)).toEqual(plan.files.map(file => ({ path: file.path, sha256: file.sha256 })));
    const cliArgs = ['doctor', '--vault', 'test-vault'];
    const refusedCli = spawnSync(controller, ['run-cli', ...cliArgs], {
      uid, gid, env: {}, cwd: root, encoding: 'utf8', timeout: 8000,
    });
    expect([refusedCli.status, refusedCli.error, refusedCli.stdout]).toEqual([78, undefined, '']);
    const ownerCli = spawnSync(controller, ['run-cli', ...cliArgs], { env: {}, cwd: root, encoding: 'utf8', timeout: 8000 });
    expect([ownerCli.status, ownerCli.error, ownerCli.stderr]).toEqual([0, undefined, '']);
    expect(JSON.parse(ownerCli.stdout)).toEqual({ uid: 0, args: cliArgs });
    const label = `com.patrick.admission.system-${role}.` + randomBytes(8).toString('hex');
    const job = 'system/' + label;
    const plist = join(root, label + '.plist');
    const stderr = join(root, 'launchd.stderr');
    await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${controller}</string><string>run-supervisor</string><string>${role}</string></array>
<key>UserName</key><string>root</string>
<key>StandardErrorPath</key><string>${stderr}</string>
<key>Sockets</key><dict><key>${socketKey}</key><dict>
<key>SockPathName</key><string>${endpoint}</string>
<key>SockPathOwner</key><integer>0</integer>
<key>SockPathGroup</key><integer>${gid}</integer>
<key>SockPathMode</key><integer>432</integer>
</dict></dict></dict></plist>`, { mode: 0o600, flag: 'wx' });
    const launchctl = (...args: string[]) => execFileSync('/bin/launchctl', args, { cwd: root, encoding: 'utf8', timeout: 5000 });
    launchctl('bootstrap', 'system', plist);
    try {
      await vi.waitFor(async () => {
        const endpointInfo = await stat(endpoint);
        expect([endpointInfo.isSocket(), endpointInfo.uid, endpointInfo.gid, endpointInfo.mode & 0o777])
          .toEqual([true, 0, gid, 0o660]);
      }, { timeout: 5000 });
      const wrongPeer = createConnection(endpoint);
      wrongPeer.setTimeout(5000, () => wrongPeer.destroy(new Error('wrong peer did not receive a reply')));
      try {
        let response = '';
        for await (const part of wrongPeer) response += part.toString();
        expect(response).toBe(role === 'hub' ? 'rejected\n' : '');
      } finally { wrongPeer.destroy(); }
      const admitted = spawnSync(controller, ['run-role', role], {
        uid, gid, env: {}, cwd: root, encoding: 'utf8', timeout: 8000,
      });
      expect([admitted.status, admitted.error, admitted.stderr]).toEqual([0, undefined, '']);
      expect(JSON.parse(admitted.stdout)).toEqual({
        uid, gid, response: role === 'service' ? 'enrolled\nstopping\nstopped\n' : 'enrolled\n',
      });
    } catch (error) {
      const output = await readFile(stderr, 'utf8').catch(() => '');
      throw new Error([String(error), output].filter(Boolean).join('\n'), { cause: error });
    } finally {
      launchctl('bootout', job);
    }
  },
);

async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function admitPreflight(projectRoot: string, artifact: string, archived: boolean): string {
  const run = (executable: string, args: string[]) => {
    const result = spawnSync(executable, args, {
      cwd: projectRoot, env: { PATH: '/usr/bin:/bin', TMPDIR: '/private/tmp' }, timeout: 45_000, encoding: 'utf8',
    });
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    return result.stdout;
  };
  const script = join(projectRoot, 'scripts/build-runtime.mjs');
  if (!archived) {
    const commit = run('/usr/bin/git', ['--no-replace-objects', 'rev-parse', 'HEAD']).trim();
    const sources = ['--profile', 'deployment-complete', '--source-root', projectRoot, '--source-commit', commit];
    const snapshot = JSON.parse(run(process.execPath, [script, 'snapshot', ...sources]));
    run(process.execPath, [script, 'build', ...sources, '--output-root', artifact,
      ...(snapshot.changed ? ['--source-snapshot', snapshot.snapshotSha256] : [])]);
  }
  run(process.execPath, [script, 'verify', '--profile', 'deployment-complete', '--artifact-root', artifact]);
  return join(artifact, servicePreflight.path);
}

describe.skipIf(!enabled)('fixed synthetic role launch', { concurrent: false }, () => {
  let root: string;
  let node: string;
  let bootstrap: string;
  let cwd: string;
  let endpoint: string;
  let controller: string;
  let unregistered: string;
  let mismatchedNode: string;
  let registeredController: string;
  let registryRoot: string;

  beforeAll(async () => {
    expect([process.platform, process.version]).toEqual(['darwin', 'v26.13.0']);
    expect(['arm64', 'x64']).toContain(process.arch);
    const darwinArch = process.arch === 'x64' ? 'x86_64' : 'arm64';
    expect(machine()).toBe(darwinArch);
    if (process.arch === 'x64') {
      const translated = execFileSync('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'], { encoding: 'utf8' }).trim();
      expect(['', '0']).toContain(translated);
    }
    const xcrun = (...args: string[]) => execFileSync('/usr/bin/xcrun', args, { encoding: 'utf8', timeout: 5000 }).trim();
    const clang = archivedMaterials ? xcrun('--find', 'clang++') : join(clt, 'usr/bin/clang++');
    const linker = archivedMaterials ? xcrun('--find', 'ld') : join(clt, 'usr/bin/ld');
    const sdk = await realpath(archivedMaterials ? xcrun('--show-sdk-path') : join(clt, 'SDKs/MacOSX.sdk'));
    const clangSha = await digest(clang);
    const nodeSha = await digest(process.execPath);
    if (!archivedMaterials) {
      expect(process.arch).toBe('arm64');
      expect(nodeSha).toBe(localNodeSha);
      expect(clangSha).toBe(localClangSha);
    }
    root = await mkdtemp('/private/tmp/patrick-role-');
    node = join(root, 'node');
    // .mts fixes ESM interpretation independently of the enclosing package.
    bootstrap = join(root, 'service-bootstrap.mts');
    cwd = join(root, 'service');
    endpoint = join(root, 'control.sock');
    controller = join(root, 'controller');
    unregistered = join(root, 'unregistered');
    mismatchedNode = join(root, 'mismatched-node');
    registeredController = join(root, 'registered-controller');
    registryRoot = join(root, 'registry');
    await mkdir(cwd, { mode: 0o700 });
    await mkdir(join(cwd, 'home'), { mode: 0o700 });
    await copyFile(process.execPath, node);
    const artifact = archivedMaterials ? await realpath(archivedMaterials) : join(root, 'materials');
    const entry = admitPreflight(await realpath(project), artifact, Boolean(archivedMaterials));
    expect(await digest(entry)).toBe(servicePreflight.sha256);
    await copyFile(entry, bootstrap);
    await chmod(node, 0o500);
    await chmod(bootstrap, 0o400);
    await mkdir(registryRoot, { mode: 0o755 });
    const registeredNode = join(registryRoot, 'node');
    await copyFile(node, registeredNode);
    await chmod(registeredNode, 0o555);
    await writeFile(join(root, 'descriptor-sentinel'), '', { mode: 0o600, flag: 'wx' });
    const directory = await stat(root, { bigint: true });
    const header = [
      '#define PATRICK_SYNTHETIC_REGISTRATION 1',
      `constexpr char fixture_root[] = ${JSON.stringify(root)};`,
      `constexpr auto fixture_device = ${directory.dev}ULL;`,
      `constexpr auto fixture_inode = ${directory.ino}ULL;`,
      `constexpr auto fixture_uid = ${directory.uid}U;`,
      `constexpr char bootstrap_sha[] = "${await digest(bootstrap)}";`,
    ].join('\n');
    const headerPath = join(root, 'registration.h');
    const mismatchedHeader = join(root, 'mismatched-node.h');
    const registryHeader = join(root, 'registry.h');
    await writeFile(headerPath, `${header}\nconstexpr char fixture_node_sha[] = "${nodeSha}";\n`);
    await writeFile(mismatchedHeader, `${header}\nconstexpr char fixture_node_sha[] = "${'0'.repeat(64)}";\n`);
    await writeFile(registryHeader, [
      '#define PATRICK_NATIVE_REGISTRY_TEST 1',
      `constexpr char registry_root[] = ${JSON.stringify(registryRoot)};`,
      `constexpr auto registry_owner = ${directory.uid}U;`,
    ].join('\n'));
    const args = ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-O2', '-arch', darwinArch, '-isysroot', sdk,
      '-isystem', join(sdk, 'usr/include/c++/v1'), '--ld-path=' + linker];
    for (const [output, extra] of [
      [unregistered, []], [controller, ['-include', headerPath]], [mismatchedNode, ['-include', mismatchedHeader]],
      [registeredController, ['-include', registryHeader]],
    ] as const) {
      const argv = [...args, ...extra, source, '-o', output];
      const result = spawnSync(clang, argv, {
        cwd: root, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TMPDIR: root },
        timeout: 30_000, encoding: 'utf8',
      });
      expect(result.status, result.error?.message ?? result.stderr).toBe(0);
      console.info(JSON.stringify({ clang, clangSha, arch: process.arch, sdk, argv,
        controllerSha256: await digest(output), nodeSha256: await digest(node),
        bootstrapSha256: await digest(bootstrap), ...(extra.length ? { headerSha256: await digest(extra[1]) } : {}) }));
    }
  }, 60_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  test.each([
    ['wrong role', true, ['run-role', 'editor'], 64],
    ['extra argument', true, ['run-role', 'service', 'other'], 64],
    ['absent registration', false, ['run-role', 'service'], 78],
    ['wrong supervised role', false, ['run-supervisor', 'editor'], 64],
    ['absent worker supervisor registration', false, ['run-supervisor', 'worker'], 78],
  ] as const)('%s exits before connecting', (_reason, registered, argv, code) => {
    const result = spawnSync(registered ? controller : unregistered, argv, {
      env: {}, cwd: root, timeout: 5000, encoding: 'utf8',
    });
    expect([result.error, result.signal, result.status]).toEqual([undefined, null, code]);
  });

  test('rejects a controller whose registration pins different Node bytes', () => {
    const result = spawnSync(mismatchedNode, ['run-role', 'service'], {
      env: {}, cwd: root, timeout: 5000, encoding: 'utf8',
    });
    expect([result.error, result.signal, result.status]).toEqual([undefined, null, 78]);
  });

  async function enrolledRole(role: string, uid = process.getuid!(), gid = process.getgid!()) {
    const directory = join(registryRoot, role);
    const account = join(directory, 'account');
    const entry = join(directory, 'entry.mjs');
    const sentinel = await stat(join(root, 'descriptor-sentinel'), { bigint: true });
    await mkdir(directory, { recursive: true, mode: 0o755 });
    await writeFile(account, `${uid}:${gid}\n`, { mode: 0o444, flag: 'wx' });
    await writeFile(entry, [
      'import { fstatSync } from "node:fs";',
      'let inherited = false;',
      'try {',
      '  const descriptor = fstatSync(3, { bigint: true });',
      `  inherited = descriptor.dev === ${sentinel.dev}n && descriptor.ino === ${sentinel.ino}n;`,
      '} catch (error) { if (error.code !== "EBADF") throw error; }',
      'console.log(JSON.stringify({ role: ' + JSON.stringify(role) + ', cwd: process.cwd(),',
      '  uid: process.getuid(), gid: process.getgid(), argv: process.argv.slice(2), umask: process.umask(),',
      '  inherited, options: process.env.NODE_OPTIONS ?? null, caller: process.env.PATRICK_FIXTURE_PARENT ?? null }));',
    ].join('\n'), { mode: 0o444, flag: 'wx' });
    return { directory, account, entry };
  }

  function runRegisteredRole(role: string) {
    const descriptor = openSync(join(root, 'descriptor-sentinel'), 'r');
    try {
      return spawnSync(registeredController, ['run-role', role], {
        cwd: root,
        env: { PATRICK_FIXTURE_PARENT: 'ignored', NODE_OPTIONS: '--unsupported-fixture-option' },
        timeout: 5000, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe', descriptor],
      });
    } finally { closeSync(descriptor); }
  }

  function checkSupervisorPeer(role: string, descriptor: Socket | number) {
    return new Promise<number | null>(resolve => {
      const child = spawn(registeredController, ['check-role-peer', role], {
        cwd: root, env: {}, timeout: 5000,
        stdio: ['ignore', 'ignore', 'ignore', descriptor],
      });
      child.once('error', () => resolve(null));
      child.once('close', resolve);
    });
  }

  test('the native registry dispatches only admitted role entries for the enrolled account', async () => {
    for (const role of ['service', 'hub', 'worker']) {
      expect(runRegisteredRole(role).status).toBe(78);
      const { directory } = await enrolledRole(role);
      try {
        const result = runRegisteredRole(role);
        expect(result.status, result.error?.message ?? result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          role, cwd: directory, uid: process.getuid!(), gid: process.getgid!(), argv: [], umask: 0o077,
          inherited: false, options: null, caller: null,
        });
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
    expect(runRegisteredRole('editor').status).toBe(64);
    expect(runRegisteredRole('../service').status).toBe(64);
  });

  test('the native registry can launch an enrolled role through a search-only parent', async () => {
    const { directory } = await enrolledRole('service');
    try {
      await chmod(registryRoot, 0o111);
      await expect(readdir(registryRoot)).rejects.toMatchObject({ code: 'EACCES' });
      const result = runRegisteredRole('service');
      expect(result.status, result.error?.message ?? result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ role: 'service', cwd: directory });
    } finally {
      await chmod(registryRoot, 0o755);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('the native registry rejects roles that share a UID even with different GIDs', async ({ onTestFinished }) => {
    const service = await enrolledRole('service');
    onTestFinished(() => rm(service.directory, { recursive: true, force: true }));
    const hub = await enrolledRole('hub', process.getuid!(), process.getgid!() + 1);
    onTestFinished(() => rm(hub.directory, { recursive: true, force: true }));
    const refused = runRegisteredRole('service');
    expect([refused.status, refused.stdout]).toEqual([78, '']);
    await unlink(hub.account);
    await writeFile(hub.account, `${process.getuid!() + 1}:${process.getgid!() + 1}\n`, { mode: 0o444, flag: 'wx' });
    expect(runRegisteredRole('service').status).toBe(0);
  });

  test('the native registry refuses mutable entries, links and a mismatched account', async ({ onTestFinished }) => {
    const { directory, entry, account } = await enrolledRole('worker');
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    await chmod(directory, 0o775);
    try { expect(runRegisteredRole('worker').status).toBe(78); }
    finally { await chmod(directory, 0o755); }
    await chmod(entry, 0o664);
    try { expect(runRegisteredRole('worker').status).toBe(78); }
    finally { await chmod(entry, 0o444); }
    execFileSync('/bin/chmod', ['+a', 'everyone allow write', entry]);
    try { expect(runRegisteredRole('worker').status).toBe(78); }
    finally { execFileSync('/bin/chmod', ['-a#', '0', entry]); }
    const saved = account + '.saved';
    await rename(account, saved);
    await symlink(saved, account);
    try { expect(runRegisteredRole('worker').status).toBe(78); }
    finally { await unlink(account); }
    await writeFile(account, `${process.getuid!()}:${process.getgid!() + 1}\n`, { mode: 0o444, flag: 'wx' });
    expect(runRegisteredRole('worker').status).toBe(78);
  });

  test('an enrolled supervisor connection reaches the role on fd 3', async ({ onTestFinished }) => {
    const role = await enrolledRole('hub');
    onTestFinished(() => rm(role.directory, { recursive: true, force: true }));
    const socketPath = join(role.directory, 'supervisor.sock');
    await writeFile(join(role.directory, 'supervisor-required'), '', { mode: 0o444, flag: 'wx' });
    await unlink(role.entry);
    await writeFile(role.entry, [
      'import { closeSync, constants, openSync } from "node:fs";',
      'import { Socket } from "node:net";',
      'if (process.env.PATRICK_SUPERVISOR_FD !== "3") process.exit(76);',
      'const fd = openSync("/dev/fd/3", constants.O_RDWR);',
      'closeSync(3);',
      'const supervisor = new Socket({ fd, readable: true, writable: true });',
      'supervisor.on("error", () => { process.exitCode = 76; });',
      'supervisor.pipe(process.stdout);',
      'supervisor.write("hub\\n");',
    ].join('\n'), { mode: 0o444, flag: 'wx' });

    expect(runRegisteredRole('hub').status).toBe(78);
    let peerStatus: number | null | undefined;
    const server = createServer(async socket => {
      socket.on('error', () => socket.destroy());
      peerStatus = await checkSupervisorPeer('hub', socket);
      if (peerStatus !== 0) return socket.destroy();
      socket.once('data', bytes => socket.end(bytes.toString() === 'hub\n' ? 'enrolled\n' : 'invalid\n'));
      socket.resume();
    });
    const listening = once(server, 'listening');
    server.listen(socketPath);
    await listening;
    try {
      const descriptor = openSync(join(root, 'descriptor-sentinel'), 'r');
      try {
        const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
          const child = spawn(registeredController, ['run-role', 'hub'], {
            cwd: root, env: { PATRICK_SUPERVISOR_FD: '11' },
            stdio: ['ignore', 'pipe', 'pipe', descriptor], timeout: 5000,
          });
          let stdout = '';
          child.stdout?.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
          child.once('error', reject);
          child.once('close', code => resolve({ code, stdout }));
        });
        expect({ ...result, peerStatus }).toEqual({ code: 0, stdout: 'enrolled\n', peerStatus: 0 });
      } finally { closeSync(descriptor); }
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    expect(runRegisteredRole('hub').status).toBe(78);
  });

  test.skipIf(process.env.PATRICK_T23_LAUNCHD_ADMISSION !== '1')('launchd hands the registered Hub supervisor its listener', async ({ onTestFinished }) => {
    const role = await enrolledRole('hub');
    const supervisor = join(registryRoot, 'hub-supervisor');
    await mkdir(supervisor, { mode: 0o755 });
    onTestFinished(async () => {
      await rm(supervisor, { recursive: true, force: true });
      await rm(role.directory, { recursive: true, force: true });
    });
    await writeFile(join(role.directory, 'supervisor-required'), '', { mode: 0o444, flag: 'wx' });
    await writeFile(join(supervisor, 'entry.mjs'), [
      'import { closeSync, constants, openSync } from "node:fs";',
      'import { createServer } from "node:net";',
      'if (process.env.PATRICK_SUPERVISOR_LISTENER_FD !== "3" || process.env.PATRICK_FIXTURE_PARENT) process.exit(76);',
      'const fd = openSync("/dev/fd/3", constants.O_RDWR);',
      'closeSync(3);',
      'const server = createServer(socket => socket.end("hub-listener\\n"));',
      'server.listen({ fd });',
    ].join('\n'), { mode: 0o444, flag: 'wx' });

    const orphan = spawnSync(registeredController, ['run-supervisor', 'hub'], { cwd: root, env: {}, timeout: 5000 });
    expect([orphan.error, orphan.status]).toEqual([undefined, 78]);
    const domain = `gui/${process.getuid!()}`;
    const label = 'com.patrick.admission.hub.' + randomBytes(8).toString('hex');
    const plist = join(root, label + '.plist');
    const stderr = join(root, label + '.stderr');
    const socketPath = join(role.directory, 'supervisor.sock');
    await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${registeredController}</string><string>run-supervisor</string><string>hub</string></array>
<key>StandardErrorPath</key><string>${stderr}</string>
<key>EnvironmentVariables</key><dict><key>PATRICK_FIXTURE_PARENT</key><string>inherited</string></dict>
<key>Sockets</key><dict><key>HubControl</key><dict>
<key>SockPathName</key><string>${socketPath}</string>
<key>SockPathGroup</key><integer>${process.getgid!()}</integer>
<key>SockPathMode</key><integer>432</integer>
</dict></dict></dict></plist>`, { mode: 0o600, flag: 'wx' });
    const launchctl = (...args: string[]) => spawnSync('/bin/launchctl', args, {
      cwd: root, encoding: 'utf8', timeout: 5000,
    });
    const bootstrapped = launchctl('bootstrap', domain, plist);
    expect(bootstrapped.status, bootstrapped.error?.message ?? bootstrapped.stderr).toBe(0);
    try {
      await vi.waitFor(async () => {
        const socket = await stat(socketPath);
        expect(socket.isSocket()).toBe(true);
        expect(socket.mode & 0o777).toBe(0o660);
      }, { timeout: 2000 });
      const client = createConnection(socketPath);
      client.setTimeout(4000, () => client.destroy(new Error('Hub supervisor did not accept the launchd listener')));
      try {
        let response = '';
        for await (const part of client) response += part.toString();
        expect(response).toBe('hub-listener\n');
      } finally { client.destroy(); }
    } catch (error) {
      const job = launchctl('print', `${domain}/${label}`).stdout.match(/^\s*(?:state|runs|last exit code)\s*=.*$/gm);
      const output = await readFile(stderr, 'utf8').catch(() => '');
      throw new Error([String(error), ...(job ?? []), output].filter(Boolean).join('\n'), { cause: error });
    } finally {
      const removed = launchctl('bootout', `${domain}/${label}`);
      expect(removed.status, removed.error?.message ?? removed.stderr).toBe(0);
    }
  });

  test('the supervisor rejects a non-socket or a peer outside the enrolled account', async ({ onTestFinished }) => {
    const role = await enrolledRole('service', process.getuid!(), process.getgid!() + 1);
    onTestFinished(() => rm(role.directory, { recursive: true, force: true }));
    const descriptor = openSync(join(root, 'descriptor-sentinel'), 'r');
    try { expect(await checkSupervisorPeer('service', descriptor)).toBe(78); }
    finally { closeSync(descriptor); }

    const server = createServer(async socket => {
      socket.once('error', () => socket.destroy());
      socket.end(String(await checkSupervisorPeer('service', socket)));
      socket.resume();
    });
    const socketPath = join(role.directory, 'supervisor.sock');
    const listening = once(server, 'listening');
    server.listen(socketPath);
    await listening;
    try {
      const client = createConnection(socketPath);
      const response = await new Promise<string>((resolve, reject) => {
        let output = '';
        client.setEncoding('utf8').on('data', chunk => { output += chunk; });
        client.once('error', reject);
        client.once('end', () => resolve(output));
      });
      expect(response).toBe('78');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  test.each(['file', 'link'] as const)('an enrolled supervisor rejects a %s in place of its endpoint', async kind => {
    const role = await enrolledRole('worker');
    try {
      const socketPath = join(role.directory, 'supervisor.sock');
      await writeFile(join(role.directory, 'supervisor-required'), '', { mode: 0o444, flag: 'wx' });
      if (kind === 'file') await writeFile(socketPath, '', { mode: 0o644, flag: 'wx' });
      else await symlink(join(root, 'descriptor-sentinel'), socketPath);
      const refused = runRegisteredRole('worker');
      expect([refused.status, refused.stdout]).toEqual([78, '']);
    } finally { await rm(role.directory, { recursive: true, force: true }); }
  });

  async function runLocalChild(server: Server, executable: string, sentinels: number[],
    onSpawn: (child: ChildProcess) => void) {
    const peers = new Set<Socket>();
    server.on('connection', socket => {
      peers.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => peers.delete(socket));
    });
    try {
      const listening = once(server, 'listening');
      server.listen(endpoint);
      await listening;
      const child = spawn(executable, ['run-role', 'service'], {
        cwd: root, env: { PATRICK_FIXTURE_PARENT: 'discard', HOME: root },
        stdio: ['ignore', 'ignore', 'ignore', ...sentinels.map(() => 'pipe' as const)],
      });
      type Status = [number | null, NodeJS.Signals | null];
      let exit: Status | undefined;
      child.once('exit', (code, signal) => { exit = [code, signal]; });
      // Node emits close after either exit or a failed spawn. An error must not
      // settle this promise ahead of actual descriptor cleanup.
      const closed = new Promise<Status>(resolve => {
        child.once('close', (code, signal) => resolve([code, signal]));
      });
      let error: Error | undefined;
      const started = new Promise<void>(resolve => {
        child.once('spawn', resolve);
        child.on('error', reason => { error = reason; resolve(); });
      });
      const deadline = setTimeout(() => child.kill('SIGKILL'), 8000);
      try {
        await started;
        if (!error) onSpawn(child);
        const close = await closed;
        return { pid: child.pid, error, exit, close };
      } finally {
        clearTimeout(deadline);
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed;
      }
    } finally {
      if (server.listening) {
        const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        for (const peer of peers) peer.destroy();
        await stopped;
      }
    }
  }

  test('missing executable closes the child handle and private listener', async () => {
    const server = createServer({ allowHalfOpen: true });
    let serverClosed = false;
    server.once('close', () => { serverClosed = true; });
    const result = await runLocalChild(server, join(root, 'absent-controller'), [3, 4], () => {
      throw new Error('unexpected spawn of missing fixture executable');
    });
    expect(result.error).toMatchObject({ code: 'ENOENT' });
    expect([result.pid, result.exit, result.close]).toEqual([undefined, undefined, [-constants.errno.ENOENT, null]]);
    expect([server.listening, serverClosed]).toEqual([false, true]);
    await expect(stat(endpoint)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 12_000);

  test.each([
    'accepted', 'accepted with only stdio', 'wrong version', 'oversize', 'premature EOF', 'missing acknowledgement',
    'wrong acknowledgement', 'trailing bytes',
  ] as const)('%s has a bounded process exit', async (scenario) => {
    const session = randomBytes(16).toString('hex');
    const server = createServer({ allowHalfOpen: true });
    let response = '';
    let connections = 0;
    let acknowledged = false;
    // The parent checks the two extra pipe ends before ACK. Node may reuse their fd numbers.
    const sentinels = scenario === 'accepted with only stdio' ? [] : [3, 4];
    const expected = (pid: number | undefined) => ({
      version: 1, role: 'service', session, pid, uid: process.getuid!(),
      execPath: node, argv: [node, bootstrap], execArgv: ['--no-addons'], cwd,
      umask: 0o077, environmentMatches: true,
    });
    const result = await runLocalChild(server, controller, sentinels, child => {
      const sentinelEnd = Promise.all(sentinels.map(index => {
        const stream = child.stdio[index] as Socket;
        const ended = once(stream, 'end').then(() => true, () => false);
        stream.resume();
        return ended;
      }));
      server.on('connection', socket => {
        connections++;
        if (scenario === 'premature EOF') return socket.end('HELLO 1 ser');
        if (scenario === 'oversize') return socket.write('X'.repeat(100));
        if (scenario === 'wrong version') return socket.end(`HELLO 2 service ${session}\n`);
        socket.write(`HELLO 1 service ${session}\n`);
        socket.on('data', (bytes: Buffer) => {
          response += bytes.toString('utf8');
          if (response.length > 4096) return socket.destroy();
          if (!response.endsWith('\n') || scenario === 'missing acknowledgement' || acknowledged) return;
          try {
            if (!isDeepStrictEqual(JSON.parse(response), expected(child.pid))) return socket.destroy();
          } catch {
            return socket.destroy();
          }
          acknowledged = true;
          void sentinelEnd.then(ended => {
            if (ended.includes(false)) return socket.destroy();
            const value = scenario === 'wrong acknowledgement' ? 'invalid' : session;
            const extra = scenario === 'trailing bytes' ? 'unexpected\n' : '';
            socket.end(`ACK 1 service ${value}\n${extra}`);
          });
        });
      });
    });
    const accepted = scenario === 'accepted' || scenario === 'accepted with only stdio';
    const code = accepted ? 0 : 76;
    expect(result.error).toBeUndefined();
    expect(result.exit).toEqual([code, null]);
    expect(result.close).toEqual([code, null]);
    expect(connections).toBe(1);
    if (['wrong version', 'oversize', 'premature EOF'].includes(scenario)) {
      expect(response).toBe('');
    } else {
      const report = JSON.parse(response);
      expect(report).toEqual(expected(result.pid));
      expect(acknowledged).toBe(scenario !== 'missing acknowledgement');
      if (accepted) console.info(JSON.stringify({ report, exit: result.exit, childPid: result.pid, sentinels }));
    }
  }, 12_000);
});
