import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, close, closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, Socket, type ListenOptions, type Server } from 'node:net';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { leased, type ExclusiveRuntimeStaging, type RuntimeLease } from '../lib/emitted-release.mjs';
import type { AdmittedDeployment } from '../lib/emitted-release.mjs';
import { bindRegistration, projectIdentity, type HostIdentity } from '../lib/doctor.mjs';
import { admitReadRoot, canonicalize, readRegularFile, sha256 } from '../lib/release.mjs';
import type { RuntimeProvisioningInput } from './composition.js';
import { startHubProcess, type HubProcess } from './hub-process.js';
import { autoloopHubDatabase, autoloopHubDirectory, createInstalledHubRoleOwner, generationHubDatabase, generationHubRoleDigest, generationServiceData, hubControlRoot,
  hubWriterFencePath, reserveControllerServiceSession, reserveServiceWriter, withConfirmedGeneration,
  type GenerationEnrollment, type GenerationNode, type InstalledGeneration } from './lifecycle-generation.js';
import {
  admitSupervisedServiceSelection, matchesServiceStatus, ownerBootstrapControlRequest, ownerBootstrapControlResponse,
  ownerBootstrapDiagnosticCode, ownerBootstrapProtocolError, parseOwnerBootstrapControlResponse, parseServiceOwnerBootstrap,
  serviceChallenge, serviceFrame, serviceHandoffError, serviceHandoffKey, serviceIdentityDigest,
  serviceOwnerBootstrapIssued, serviceOwnerBootstrapUnavailable, serviceReady, serviceSelectionBytes, serviceStatus,
  validateSupervisedServiceAccount, verifyServiceSelection, type ServiceHandoffAuthority,
  type ServiceOwnerBootstrapResult, type ServiceSelection, type SupervisedServiceRegistration,
} from './service-handoff.js';

export type SelectedRuntimePaths = Readonly<{
  role: 'service' | 'worker';
  identity: HostIdentity;
  installationId: string;
  generationId: string;
  selectionSha256: string;
  packageSha256: string;
  dataRoot: string;
  databasePath: string;
  localAnswersPath: string;
  operationalHubPath: string;
  credentialDirectory: string;
}>;

type Service = Awaited<ReturnType<typeof import('./service.js').runInstalledService>>;
type Worker = Awaited<ReturnType<typeof import('./worker.js').runInstalledWorker>>;
type StartedRole = { role: 'service'; runtime: Service } | { role: 'worker'; runtime: Worker };
type RoleProvision = (paths: SelectedRuntimePaths) => RuntimeProvisioningInput | Promise<RuntimeProvisioningInput>;
function selectedRuntimePaths(enrollment: GenerationEnrollment, role: SelectedRuntimePaths['role'],
  generation: InstalledGeneration, selectionSha256: string, packageSha256: string): SelectedRuntimePaths {
  const { root, installationId } = enrollment;
  const identity = projectIdentity(enrollment.identity);
  Object.freeze(identity.domains);
  Object.freeze(identity);
  const generationRoot = join(root, 'data', generation.id);
  const dataRoot = generationServiceData(generationRoot, generation.roles);
  return Object.freeze({
    role, identity, installationId, generationId: generation.id, selectionSha256, packageSha256, dataRoot,
    databasePath: join(dataRoot, 'service.sqlite'), localAnswersPath: join(dataRoot, 'answers.sqlite'),
    operationalHubPath: join(generationRoot, generationHubDatabase(generation.roles)), credentialDirectory: join(dataRoot, 'credentials'),
  });
}

type RoleLifecycle = {
  signal: AbortSignal;
  onStarting(): void;
  onStarted(role: StartedRole): void;
  onClosed(): void;
};
type ServiceFence = ReturnType<typeof reserveServiceWriter>;
const undrainedServiceFences = new Set<ServiceFence>();
type CleanupResult = ReturnType<Service['read']> | ReturnType<Worker['read']>;
type StartupCleanup = {
  readCleanup(): CleanupResult;
  drainCleanup(options?: { timeoutMs?: number }): Promise<CleanupResult>;
};

function closed(result: CleanupResult) {
  if ('listener' in result) return result.listener === 'closed' && result.runtime.status === 'closed';
  return result.status === 'closed';
}

function running(result: CleanupResult) {
  if ('listener' in result) return result.listener === 'running' && result.runtime.status === 'running';
  return result.status === 'running';
}

function hasCleanup(error: unknown): error is StartupCleanup {
  return error instanceof Error && 'readCleanup' in error && typeof error.readCleanup === 'function' &&
    'drainCleanup' in error && typeof error.drainCleanup === 'function';
}

function wasCanceledStartup(error: unknown, reason: Error): boolean {
  if (error === reason) return true;
  if (!(error instanceof Error)) return false;
  if (error.message === 'LISTENER_START_CANCELLED') return error.cause === reason;
  return error instanceof AggregateError && error.message === 'INSTALLED_ROLE_CLEANUP_UNCONFIRMED' &&
    error.errors.length === 1 && wasCanceledStartup(error.errors[0], reason);
}

export type HubRoleRegistration = Readonly<{
  rulesSha256: string;
  listener: Readonly<{ host: '127.0.0.1' | '::1'; port: number }>;
  publicUrl: string;
}>;

type StartedHub = Readonly<{
  role: 'hub';
  generationId: string;
  selectionSha256: string;
  packageSha256: string;
  runtime: Pick<HubProcess, 'read' | 'drain'> & { stop(): void };
}>;

export async function startSelectedHubRole(
  enrollment: GenerationEnrollment,
  owner: ExclusiveRuntimeStaging | undefined,
  registration: HubRoleRegistration,
): Promise<StartedHub> {
  return launchSelectedHubRole(enrollment, owner, registration).ready;
}

function launchSelectedHubRole(
  enrollment: GenerationEnrollment,
  owner: ExclusiveRuntimeStaging | undefined,
  registration: HubRoleRegistration,
  signal?: AbortSignal,
) {
  const binding = bindRegistration(() => registration);
  const generationBinding = bindRegistration(() => enrollment);
  const { root, hubOwner, hubRole } = generationBinding.value;
  const { listener, publicUrl, rulesSha256 } = binding.value;
  const { host, port } = listener;
  const { uid, gid } = hubOwner ?? { uid: process.geteuid!(), gid: process.getegid!() };
  const url = URL.parse(publicUrl);
  const authority = host === '::1' ? '[::1]' : host;
  if (!hubRole || !['127.0.0.1', '::1'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535 ||
      uid === 0 || !url || url.origin !== publicUrl ||
      (url.protocol !== 'https:' && publicUrl !== new URL(`http://${authority}:${port}`).origin) ||
      !/^[0-9a-f]{64}$/.test(rulesSha256)) throw new Error('INSTALLED_HUB_REGISTRATION_INVALID');

  const roleRoot = hubControlRoot(root);
  const rulesPath = join(roleRoot, 'rules.json');
  const roleOwner = createInstalledHubRoleOwner(root, hubRole);
  const roleSha256 = generationHubRoleDigest(generationBinding.value);
  let resolveReady!: (value: StartedHub) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<StartedHub>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const run = async (lease: RuntimeLease) => {
    let runtime: HubProcess | undefined;
    function stopChild() { runtime?.stop(signal?.reason); }
    const rulesRoot = admitReadRoot(roleRoot, { allowAncestorEntriesChange: true });
    function validateRole() {
      lease.guard();
      rulesRoot.validate();
      if (uid !== process.geteuid!()) {
        const directory = lstatSync(roleRoot, { bigint: true });
        if (!directory.isDirectory() || directory.uid !== BigInt(process.geteuid!()) ||
            directory.gid !== BigInt(gid) || (directory.mode & 0o7777n) !== 0o750n) {
          throw new Error('INSTALLED_HUB_RULES_DIRECTORY_INVALID');
        }
      }
      const rules = lstatSync(rulesPath, { bigint: true });
      if (!rules.isFile() || rules.nlink !== 1n || rules.uid !== BigInt(process.geteuid!()) ||
          ((rules.mode & 0o7777n) !== 0o444n && (uid !== process.geteuid!() || (rules.mode & 0o7777n) !== 0o400n))) {
        throw new Error('INSTALLED_HUB_RULES_INVALID');
      }
    }
    try {
      const identity = await withConfirmedGeneration(enrollment, owner, async (selected, deployment, guard) => {
        if (selected.order.hubRoleSha256 !== roleSha256) throw new Error('INSTALLED_HUB_REGISTRATION_REQUIRED');
        const generation = selected.order.generation;
        const database = generation.roles[autoloopHubDatabase];
        const hub = deployment.autoloopHub;
        if (!database || !hub) throw new Error('INSTALLED_HUB_MATERIAL_REQUIRED');
        function validate() {
          signal?.throwIfAborted();
          validateRole();
          guard();
        }
        validate();
        const rules = await readRegularFile(rulesPath, 128 * 1024, { root: roleRoot, validate });
        if (sha256(rules) !== rulesSha256) throw new Error('INSTALLED_HUB_RULES_INVALID');
        await startHubProcess({ entry: hub.entry, commit: hub.commit, database, rulesPath, rulesSha256,
          writerFence: { path: hubWriterFencePath(root), node: hubRole.writerNode },
          hubHome: join(root, 'data', generation.id, autoloopHubDirectory), uid, gid, host, port, publicUrl },
        validate, child => {
          runtime = child;
          signal?.addEventListener('abort', stopChild, { once: true });
        });
        validate();
        return { generationId: generation.id, selectionSha256: selected.sha256, packageSha256: deployment.packageSha256 };
      }, signal);
      signal?.throwIfAborted();
      validateRole();
      const child = runtime!;
      await child.activate();
      validateRole();
      if (child.read().state !== 'running') throw new Error('INSTALLED_HUB_START_FAILED');
      resolveReady(Object.freeze({ role: 'hub', ...identity, runtime: Object.freeze({
        read: child.read, stop: () => child.stop(),
        async drain(options?: { timeoutMs?: number }) {
          const result = await child.drain(options);
          if (result.state === 'closed') await lifetime;
          return result;
        },
      }) }));
      const exit = await child.exited;
      return { ...exit, stopRequested: signal?.aborted === true };
    } catch (error) {
      if (runtime) {
        runtime.stop();
        const state = await runtime.drain();
        if (state.state !== 'closed') {
          rejectReady(Object.assign(new Error('INSTALLED_ROLE_CLEANUP_UNCONFIRMED', { cause: error }), {
            role: 'hub', readCleanup: runtime.read, drainCleanup: runtime.drain,
          }));
          await runtime.exited;
        }
        if (signal?.aborted && signal.reason === error) requireCleanHubExit(await runtime.exited);
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', stopChild);
    }
  };
  const lifetime = leased(roleOwner, run, true, () => { binding.validate(); generationBinding.validate(); });
  void lifetime.catch(rejectReady);
  return { ready, lifetime };
}

function requireCleanHubExit(exit: Awaited<HubProcess['exited']>) {
  if (exit.code !== 0 || exit.signal !== null) throw new Error('INSTALLED_HUB_STOP_FAILED');
}

export async function runInstalledHubRole(
  enrollment: GenerationEnrollment,
  owner: ExclusiveRuntimeStaging | undefined,
  registration: HubRoleRegistration,
  onReady?: (started: StartedHub) => void,
): Promise<void> {
  const stopping = new AbortController();
  const stopReason = new Error('INSTALLED_HUB_STOP_REQUESTED');
  const stop = () => stopping.abort(stopReason);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    await runHubUntilStopped(enrollment, owner, registration, stopping, stopReason, onReady);
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

async function runHubUntilStopped(enrollment: GenerationEnrollment, owner: ExclusiveRuntimeStaging | undefined,
  registration: HubRoleRegistration, stopping: AbortController, stopReason: Error,
  onReady?: (started: StartedHub) => void) {
  const { ready, lifetime } = launchSelectedHubRole(enrollment, owner, registration, stopping.signal);
  try {
    const started = await ready;
    if (!stopping.signal.aborted) onReady?.(started);
    const exit = await lifetime;
    if (!exit.stopRequested) throw new Error('INSTALLED_HUB_EXITED_UNEXPECTEDLY');
    requireCleanHubExit(exit);
  } catch (error) {
    stopping.abort(stopReason);
    await lifetime.catch(() => {});
    if (error !== stopReason) throw error;
  }
}

type SupervisorProgram = Readonly<{ path: string; sha256: string }>;
const hubReady = 'READY 1 hub\n';
const hubStopped = 'STOPPED 1 hub\n';

async function verifyRolePeer(socket: Socket, program: SupervisorProgram, role: 'hub' | 'service' | 'worker') {
  const { path, sha256: expected } = program;
  const denied = new Error(`INSTALLED_${role.toUpperCase()}_SUPERVISOR_PEER_INVALID`);
  if (resolve(path) !== path || !/^[a-f0-9]{64}$/.test(expected)) throw denied;
  const root = admitReadRoot(dirname(path), { allowAncestorEntriesChange: true });
  const initial = lstatSync(path);
  function validate() {
    root.validate();
    const current = lstatSync(path);
    if (!current.isFile() || current.nlink !== 1 || current.uid !== process.geteuid?.() ||
        (current.mode & 0o7022) !== 0 || (current.mode & 0o100) === 0 ||
        current.dev !== initial.dev || current.ino !== initial.ino || current.ctimeMs !== initial.ctimeMs) throw denied;
  }
  if (sha256(await readRegularFile(path, 1024 * 1024, { root: root.root, validate })) !== expected) throw denied;
  validate();
  if (socket.destroyed) throw denied;
  const child = spawn(path, ['check-role-peer', role], {
    env: {}, stdio: ['ignore', 'ignore', 'ignore', socket], timeout: 5000, killSignal: 'SIGKILL',
  });
  const [code, signal] = await once(child, 'close');
  validate();
  if (code !== 0 || signal !== null) throw denied;
}

export async function serveInstalledHubRole(socket: Socket, program: SupervisorProgram,
  enrollment: GenerationEnrollment, owner: ExclusiveRuntimeStaging | undefined, registration: HubRoleRegistration): Promise<void> {
  const stopping = new AbortController();
  const stopReason = new Error('INSTALLED_HUB_STOP_REQUESTED');
  const stop = () => stopping.abort(stopReason);
  socket.pause();
  socket.once('close', stop);
  socket.once('end', stop);
  socket.once('error', stop);
  let invalid = false;
  let completed = false;
  try {
    await verifyRolePeer(socket, program, 'hub');
    socket.on('data', () => { invalid = true; stop(); });
    socket.resume();
    if (!stopping.signal.aborted) {
      await runHubUntilStopped(enrollment, owner, registration, stopping, stopReason, () => socket.write(hubReady));
    }
    if (invalid) throw new Error('INSTALLED_HUB_SUPERVISOR_PROTOCOL_INVALID');
    completed = true;
  } finally {
    if (!completed) socket.destroy();
    else if (!socket.destroyed) socket.end(hubStopped);
  }
}

export async function runInstalledHubSupervisor(program: SupervisorProgram, enrollment: GenerationEnrollment,
  owner: ExclusiveRuntimeStaging | undefined, registration: HubRoleRegistration): Promise<void> {
  if (process.env.PATRICK_SUPERVISOR_LISTENER_FD !== '3' || !fstatSync(3).isSocket()) {
    throw new Error('INSTALLED_HUB_SUPERVISOR_LISTENER_REQUIRED');
  }
  const fixedProgram = bindRegistration(() => program).value;
  const fixedEnrollment = bindRegistration(() => enrollment).value;
  const fixedRole = bindRegistration(() => registration).value;
  const descriptor = openSync('/dev/fd/3', constants.O_RDWR);
  closeSync(3);

  let active: { socket: Socket; finished: Promise<void> } | undefined;
  let closing = false;
  let failure: unknown;
  const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, socket => {
    if (closing || active) {
      socket.destroy();
      return;
    }
    const finished = serveInstalledHubRole(socket, fixedProgram, fixedEnrollment, owner, fixedRole).catch(error => {
      if (closing) failure ??= error;
      const code = error instanceof Error && /^[A-Z][A-Z_]{1,95}$/.test(error.message) ? error.message : 'UNKNOWN';
      console.error('INSTALLED_HUB_SUPERVISOR_SESSION_FAILED', code);
    }).finally(() => { active = undefined; });
    active = { socket, finished };
  });
  const closed = new Promise<void>(resolveClosed => server.once('close', resolveClosed));
  function stop() {
    if (closing) return;
    closing = true;
    server.close();
    active?.socket.destroy();
  }
  server.on('error', error => {
    failure ??= error;
    stop();
  });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    try { server.listen({ fd: descriptor }); }
    catch (error) {
      close(descriptor, () => undefined);
      throw error;
    }
    await closed;
    await active?.finished;
    if (failure) throw failure;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

export async function listenVerifiedServiceControl(options: ListenOptions | { fd: number }, endpoint: string,
  admit: (socket: Socket) => void, signal: AbortSignal) {
  const challenge = randomBytes(32);
  let verified = false;
  const pending = new Map<Socket, (bytes: Buffer) => void>();
  function discardUnverified(this: Socket) { this.destroy(); }
  const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, socket => {
    if (verified) return admit(socket);
    if (pending.size >= 32) return socket.destroy();
    let length = 0;
    function check(bytes: Buffer) {
      if (length + bytes.length > challenge.length ||
          !bytes.equals(challenge.subarray(length, length + bytes.length))) return socket.destroy();
      length += bytes.length;
      if (length === challenge.length) {
        server.emit('verified-service-control');
        socket.destroy();
      }
    }
    pending.set(socket, check);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => pending.delete(socket));
    socket.once('end', discardUnverified);
    socket.on('data', check);
    socket.resume();
  });
  let probe: Socket | undefined;
  try {
    try {
      signal.throwIfAborted();
      server.listen(options);
    } catch (error) {
      if ('fd' in options) close(options.fd, () => undefined);
      throw error;
    }
    await once(server, 'listening', { signal });
    const confirmation = once(server, 'verified-service-control', { signal });
    probe = createConnection(endpoint);
    probe.on('error', () => probe?.destroy());
    probe.once('connect', () => probe?.end(challenge));
    probe.resume();
    await Promise.race([
      confirmation,
      once(probe, 'close', { signal }).then(() => { throw new Error('probe disconnected'); }),
    ]);
    signal.throwIfAborted();
    verified = true;
    for (const [socket, check] of pending) {
      socket.pause();
      socket.off('data', check);
      socket.off('end', discardUnverified);
      if (!socket.destroyed) admit(socket);
    }
    pending.clear();
    return server;
  } catch (cause) {
    for (const socket of pending.keys()) socket.destroy();
    await new Promise<void>(resolveClosed => server.close(() => resolveClosed()));
    throw new Error('INSTALLED_SERVICE_LISTENER_UNVERIFIED', { cause });
  } finally {
    probe?.destroy();
  }
}

type SupervisorSessionPhase = 'VERIFY_PEER' | 'SERVE' | 'RESERVE_WRITER' | 'VERIFY_GENERATION' |
  'SEND_READY' | 'READ_HELLO' | 'SIGN_SELECTION' | 'VERIFY_SIGNATURE' | 'AUTHORIZE_WRITER' | 'DRAIN';
type SetSupervisorSessionPhase = (phase: SupervisorSessionPhase) => void;
type ServeSupervisorConnection = (socket: Socket, shutdown: AbortSignal, setPhase: SetSupervisorSessionPhase) => Promise<void>;

export function runInstalledServiceSupervisor(program: SupervisorProgram, endpoint: string, serve: ServeSupervisorConnection) {
  return runInstalledRoleSupervisor('service', program, endpoint, serve);
}

export function runInstalledWorkerSupervisor(program: SupervisorProgram, endpoint: string, serve: ServeSupervisorConnection) {
  return runInstalledRoleSupervisor('worker', program, endpoint, serve);
}

const consultationTick = Object.freeze({ version: 1, type: 'consultation-tick' });
const tickResult = (available: boolean) => ({ version: 1, type: 'consultation-tick-result', available });
const workerProtocolError = () => new Error('INSTALLED_WORKER_SUPERVISOR_PROTOCOL_INVALID');

export async function serveInstalledWorkerTicks(socket: Socket, shutdown: AbortSignal,
  trigger: () => Promise<boolean>) {
  const channel = serviceFrame(socket);
  let stopWaiting: (() => void) | undefined;
  function stop() {
    stopWaiting?.();
    socket.destroy();
  }
  shutdown.addEventListener('abort', stop, { once: true });
  socket.once('end', stop);
  socket.once('close', stop);
  try {
    while (!shutdown.aborted && !socket.destroyed) {
      const request = await channel.read();
      shutdown.throwIfAborted();
      if (socket.destroyed) return;
      if (canonicalize(request) !== canonicalize(consultationTick)) throw workerProtocolError();
      const available = await new Promise<boolean | undefined>((settle, reject) => {
        stopWaiting = () => settle(undefined);
        void Promise.resolve().then(trigger).then(settle, reject);
      });
      stopWaiting = undefined;
      if (available === undefined) return;
      if (!shutdown.aborted && !socket.destroyed) channel.write(tickResult(available));
    }
  } catch (error) {
    if (!shutdown.aborted && !socket.readableEnded && !socket.destroyed) throw error;
  } finally {
    shutdown.removeEventListener('abort', stop);
    socket.off('end', stop);
    socket.off('close', stop);
    socket.destroy();
  }
}

export async function runSupervisedWorkerRole(onReady?: () => void) {
  if (process.env.PATRICK_SUPERVISOR_FD !== '3' || !fstatSync(3).isSocket()) throw workerProtocolError();
  const descriptor = openSync('/dev/fd/3', constants.O_RDWR);
  closeSync(3);
  const socket = new Socket({ fd: descriptor, readable: true, writable: true });
  const channel = serviceFrame(socket);
  const stopping = new AbortController();
  function stop() {
    stopping.abort();
    socket.destroy();
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  let ready = false;
  try {
    while (!stopping.signal.aborted) {
      channel.write(consultationTick);
      const response = canonicalize(await channel.read());
      if (response === canonicalize(tickResult(true))) {
        if (!ready) onReady?.();
        ready = true;
      } else if (response !== canonicalize(tickResult(false))) throw workerProtocolError();
      await delay(1000, undefined, { signal: stopping.signal });
    }
  } catch (error) {
    if (!stopping.signal.aborted) throw error;
  } finally {
    socket.destroy();
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

async function runInstalledRoleSupervisor(role: 'service' | 'worker', program: SupervisorProgram, endpoint: string,
  serve: ServeSupervisorConnection, shared?: { descriptor: 3 | 4; signal: AbortSignal }) {
  const name = role.toUpperCase();
  const inherited = shared?.descriptor ?? 3;
  const descriptorVariable = inherited === 4 ? 'PATRICK_WORKER_LISTENER_FD' : 'PATRICK_SUPERVISOR_LISTENER_FD';
  if (process.platform !== 'darwin' || process.getuid?.() !== 0 || process.geteuid?.() !== 0 ||
      process.env[descriptorVariable] !== String(inherited) || !fstatSync(inherited).isSocket() || resolve(endpoint) !== endpoint) {
    throw new Error(`INSTALLED_${name}_SUPERVISOR_LISTENER_REQUIRED`);
  }
  const fixedProgram = bindRegistration(() => program).value;
  const descriptor = openSync(`/dev/fd/${inherited}`, constants.O_RDWR);
  closeSync(inherited);
  const stopping = new AbortController();
  let active: Socket | undefined;
  const sessions = new Map<Socket, Promise<void>>();
  let server: Server | undefined;
  function stop() {
    stopping.abort(new Error(`INSTALLED_${name}_SUPERVISOR_STOP_REQUESTED`));
    server?.close();
    for (const socket of sessions.keys()) {
      if (socket !== active) socket.destroy();
    }
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  shared?.signal.addEventListener('abort', stop, { once: true });
  if (shared?.signal.aborted) stop();
  try {
    server = await listenVerifiedServiceControl({ fd: descriptor }, endpoint, socket => {
      if (stopping.signal.aborted || active || sessions.size >= 8) return socket.destroy();
      socket.on('error', () => socket.destroy());
      let phase: SupervisorSessionPhase = 'VERIFY_PEER';
      const startedAt = performance.now();
      const finished = verifyRolePeer(socket, fixedProgram, role).then(() => {
        if (!socket.destroyed && !stopping.signal.aborted && !active) {
          active = socket;
          phase = 'SERVE';
          return serve(socket, stopping.signal, next => { phase = next; });
        }
      }).catch(error => {
        let code = 'UNKNOWN';
        if (error instanceof Error) {
          const nodeCode = (error as NodeJS.ErrnoException).code;
          if (/^[A-Z][A-Z_]{1,95}$/.test(error.message)) code = error.message;
          else if (typeof nodeCode === 'string' &&
            /^(EACCES|EPERM|ENOENT|ETIMEDOUT|ECONNRESET|EPIPE|ERR_STREAM_PREMATURE_CLOSE)$/.test(nodeCode)) code = nodeCode;
        }
        console.error(`INSTALLED_${name}_SUPERVISOR_SESSION_FAILED`, phase, `${Math.round(performance.now() - startedAt)}ms`, code);
      }).finally(() => {
        socket.destroy();
        if (active === socket) active = undefined;
        sessions.delete(socket);
      });
      sessions.set(socket, finished);
    }, AbortSignal.any([stopping.signal, AbortSignal.timeout(5000)]));
    const closed = once(server, 'close');
    if (stopping.signal.aborted) stop();
    await closed;
  } finally {
    stop();
    active?.destroy();
    await Promise.all(sessions.values());
    shared?.signal.removeEventListener('abort', stop);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

type SelectedServiceSession = Readonly<{
  paths: SelectedRuntimePaths;
  deployment: AdmittedDeployment;
  session: string;
  signal: AbortSignal;
  assertCurrent(): void;
}>;
type ServeSelectedService = (socket: Socket, admission: SelectedServiceSession) => Promise<'drained'>;
type WorkerTick = () => Promise<boolean>;
export type OwnerBootstrapRequester = () => Promise<ServiceOwnerBootstrapResult>;
export type ServiceSupervisorOwnerControl = Readonly<{
  endpoint?: string;
  onAvailable?: (issue: OwnerBootstrapRequester | undefined) => void;
}>;
const serviceSupervisorReadyMs = 60_000;
const serviceHandshakeMs = 10_000;
const serviceStopReplyMs = 30_000;
const ownerControlRequestMs = 5_000;
const ownerControlMaxPathBytes = 103;
const ownerControlSocketName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,58}\.sock$/;
const ownerControlInvalid = () => new Error('INSTALLED_OWNER_BOOTSTRAP_CONTROL_INVALID');

export function ownerBootstrapControlEndpoint(root: string): string {
  return join(root, 'runtime', 'service-control', 'owner.sock');
}

function checkPinnedDirectory(path: string, pin: GenerationNode, uid: number, mode?: number) {
  const info = lstatSync(path, { bigint: true });
  if (!info.isDirectory() || realpathSync.native(path) !== path || info.uid !== BigInt(uid) ||
      String(info.dev) !== pin.device || String(info.ino) !== pin.inode || String(info.birthtimeNs) !== pin.birthtimeNs ||
      (mode !== undefined && (info.mode & 0o7777n) !== BigInt(mode))) throw ownerControlInvalid();
}

function validateOwnerControlAncestors(parent: string, expectedUid: number) {
  for (let ancestor = dirname(parent); ; ancestor = dirname(ancestor)) {
    const info = lstatSync(ancestor);
    const writableByOthers = (info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0;
    const ownerAllowed = expectedUid === 0 ? info.uid === 0 : info.uid === 0 || info.uid === expectedUid;
    if (!info.isDirectory() || realpathSync.native(ancestor) !== ancestor || !ownerAllowed || writableByOthers) {
      throw ownerControlInvalid();
    }
    if (ancestor === sep) break;
  }
}

function validateOwnerControlParent(endpoint: string, expectedUid: number) {
  if (typeof endpoint !== 'string' || endpoint.includes('\0') || resolve(endpoint) !== endpoint ||
      Buffer.byteLength(endpoint) > ownerControlMaxPathBytes || !ownerControlSocketName.test(basename(endpoint))) {
    throw ownerControlInvalid();
  }
  const parent = dirname(endpoint);
  let info;
  try { info = lstatSync(parent); }
  catch { throw ownerControlInvalid(); }
  if (!info.isDirectory() || realpathSync.native(parent) !== parent ||
      info.uid !== expectedUid || (info.mode & 0o7777) !== 0o700) {
    throw ownerControlInvalid();
  }
  validateOwnerControlAncestors(parent, expectedUid);
  return { parent, dev: info.dev, ino: info.ino };
}

function validateOwnerControlSocket(endpoint: string, expectedUid: number, pinned?: { dev: number; ino: number }) {
  let info;
  try { info = lstatSync(endpoint); }
  catch { throw ownerControlInvalid(); }
  if (!info.isSocket() || info.uid !== expectedUid || (info.mode & 0o7777) !== 0o600 ||
      (pinned && (info.dev !== pinned.dev || info.ino !== pinned.ino))) {
    throw ownerControlInvalid();
  }
  return { dev: info.dev, ino: info.ino };
}

function verifyControllerOwnerControlDirectory(enrollment: GenerationEnrollment) {
  const role = enrollment.serviceRole;
  if (!role?.controllerOwned) throw ownerControlInvalid();
  checkPinnedDirectory(enrollment.root, enrollment.rootNode, 0);
  const runtime = join(enrollment.root, 'runtime');
  const runtimeInfo = lstatSync(runtime);
  if (!runtimeInfo.isDirectory() || realpathSync.native(runtime) !== runtime ||
      runtimeInfo.uid !== 0 || (runtimeInfo.mode & 0o022) !== 0) throw ownerControlInvalid();
  checkPinnedDirectory(join(runtime, 'service-control'), role.rootNode, 0, 0o700);
}

export async function serveInstalledOwnerBootstrapControl(
  socket: Socket,
  shutdown: AbortSignal,
  issue: OwnerBootstrapRequester,
): Promise<void> {
  const channel = serviceFrame(socket);
  const deadline = new AbortController();
  const signal = AbortSignal.any([shutdown, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(ownerBootstrapProtocolError()), ownerControlRequestMs);
  let stopWaiting: (() => void) | undefined;
  function stop() {
    stopWaiting?.();
    socket.destroy();
  }
  signal.addEventListener('abort', stop, { once: true });
  socket.once('close', stop);
  try {
    const request = await new Promise<unknown>((resolveRead, rejectRead) => {
      stopWaiting = () => resolveRead(undefined);
      void channel.read().then(resolveRead, rejectRead);
    });
    stopWaiting = undefined;
    clearTimeout(timer);
    if (request === undefined || signal.aborted || socket.destroyed) return;
    if (canonicalize(request) !== canonicalize(ownerBootstrapControlRequest)) throw ownerBootstrapProtocolError();
    const result = await new Promise<ServiceOwnerBootstrapResult | undefined>((resolveIssue, rejectIssue) => {
      stopWaiting = () => resolveIssue(undefined);
      void Promise.resolve().then(issue).then(resolveIssue, rejectIssue);
    });
    stopWaiting = undefined;
    if (result === undefined || shutdown.aborted || socket.destroyed) return;
    channel.write(ownerBootstrapControlResponse(result));
    await new Promise<void>(resolveEnded => {
      if (socket.destroyed) return resolveEnded();
      socket.once('close', resolveEnded);
      socket.end(() => {
        socket.off('close', resolveEnded);
        resolveEnded();
      });
    });
  } catch (error) {
    if (!shutdown.aborted && !socket.destroyed) throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    socket.off('close', stop);
    socket.destroy();
  }
}

export async function runInstalledOwnerBootstrapControl(
  endpoint: string,
  shutdown: AbortSignal,
  issue: OwnerBootstrapRequester,
  options?: Readonly<{ expectedUid?: number; verifyDirectory?: () => void; onReady?: () => void }>,
): Promise<void> {
  const expectedUid = options?.expectedUid ?? process.geteuid?.();
  if (expectedUid === undefined || !Number.isInteger(expectedUid) || expectedUid < 0) throw ownerControlInvalid();
  validateOwnerControlParent(endpoint, expectedUid);
  options?.verifyDirectory?.();
  const existing = lstatSync(endpoint, { throwIfNoEntry: false });
  if (existing) {
    if (!existing.isSocket() || existing.uid !== expectedUid || (existing.mode & 0o077) !== 0) throw ownerControlInvalid();
    unlinkSync(endpoint);
  }
  let active: Socket | undefined;
  const sessions = new Map<Socket, Promise<void>>();
  let server: Server | undefined;
  let boundSocket: { dev: number; ino: number } | undefined;
  let ready = false;
  function stop() {
    server?.close();
    for (const socket of sessions.keys()) {
      if (socket !== active) socket.destroy();
    }
  }
  shutdown.addEventListener('abort', stop, { once: true });
  try {
    const previousUmask = process.umask(0o077);
    try {
      server = await listenVerifiedServiceControl({ path: endpoint }, endpoint, socket => {
        if (!ready || shutdown.aborted || active || sessions.size >= 4) return socket.destroy();
        socket.on('error', () => socket.destroy());
        active = socket;
        const finished = Promise.resolve().then(() => {
          validateOwnerControlParent(endpoint, expectedUid);
          options?.verifyDirectory?.();
          validateOwnerControlSocket(endpoint, expectedUid, boundSocket);
          return serveInstalledOwnerBootstrapControl(socket, shutdown, issue);
        }).catch(() => {
          socket.destroy();
        }).finally(() => {
          socket.destroy();
          if (active === socket) active = undefined;
          sessions.delete(socket);
        });
        sessions.set(socket, finished);
      }, AbortSignal.any([shutdown, AbortSignal.timeout(5000)]));
    } finally {
      process.umask(previousUmask);
    }
    chmodSync(endpoint, 0o600);
    validateOwnerControlParent(endpoint, expectedUid);
    options?.verifyDirectory?.();
    boundSocket = validateOwnerControlSocket(endpoint, expectedUid);
    ready = true;
    options?.onReady?.();
    const closed = once(server, 'close');
    if (shutdown.aborted) stop();
    await closed;
  } finally {
    ready = false;
    stop();
    active?.destroy();
    await Promise.all(sessions.values());
    shutdown.removeEventListener('abort', stop);
    if (boundSocket) {
      const current = lstatSync(endpoint, { throwIfNoEntry: false });
      if (current?.isSocket() && current.dev === boundSocket.dev && current.ino === boundSocket.ino) {
        try { unlinkSync(endpoint); } catch { void 0; }
      }
    }
  }
}

export async function requestInstalledOwnerBootstrap(
  endpoint: string,
  options?: Readonly<{ timeoutMs?: number; expectedUid?: number }>,
): Promise<ServiceOwnerBootstrapResult> {
  const timeoutMs = options?.timeoutMs ?? ownerControlRequestMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw ownerControlInvalid();
  const expectedUid = options?.expectedUid ?? process.geteuid?.();
  if (expectedUid === undefined || !Number.isInteger(expectedUid) || expectedUid < 0) throw ownerControlInvalid();
  const parent = validateOwnerControlParent(endpoint, expectedUid);
  const pinned = validateOwnerControlSocket(endpoint, expectedUid);
  const socket = createConnection({ path: endpoint, allowHalfOpen: true });
  const timer = setTimeout(() => socket.destroy(new Error('INSTALLED_OWNER_BOOTSTRAP_REQUEST_TIMEOUT')), timeoutMs);
  try {
    await once(socket, 'connect');
    const afterParent = validateOwnerControlParent(endpoint, expectedUid);
    if (afterParent.dev !== parent.dev || afterParent.ino !== parent.ino) throw ownerControlInvalid();
    validateOwnerControlSocket(endpoint, expectedUid, pinned);
    const channel = serviceFrame(socket);
    channel.write(ownerBootstrapControlRequest);
    socket.end();
    const response = await channel.read();
    await channel.expectEnd();
    return parseOwnerBootstrapControlResponse(response);
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

export function executeSupervisedOwnerBootstrap(
  runningService: Pick<Service, 'read' | 'issueOwnerBootstrap'> | undefined,
  selection: ServiceSelection,
  assertSelected: () => void,
) {
  if (!runningService || !running(runningService.read())) {
    return serviceOwnerBootstrapUnavailable(selection, 'OWNER_BOOTSTRAP_UNAVAILABLE');
  }
  assertSelected();
  try {
    const issued = runningService.issueOwnerBootstrap();
    return serviceOwnerBootstrapIssued(selection, issued.ticket, issued.expires_at);
  } catch (error) {
    return serviceOwnerBootstrapUnavailable(selection, ownerBootstrapDiagnosticCode(error));
  }
}

export async function serveSelectedService(socket: Socket, admission: SelectedServiceSession, enrollment: GenerationEnrollment,
  generation: InstalledGeneration, authority: ServiceHandoffAuthority, key: ReturnType<typeof serviceHandoffKey>,
  arm: () => () => void, setPhase: SetSupervisorSessionPhase, offerTick?: (tick: WorkerTick | undefined) => void,
  offerOwnerBootstrap?: (issue: OwnerBootstrapRequester | undefined) => void): Promise<() => void> {
  const channel = serviceFrame(socket);
  const expiresAt = performance.now() + serviceHandshakeMs;
  const deadline = new AbortController();
  const signal = AbortSignal.any([deadline.signal, admission.signal]);
  const timer = setTimeout(() => deadline.abort(serviceHandoffError()), serviceHandshakeMs);
  let rejectHandshake!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectHandshake = reject; });
  function cancelHandshake() { rejectHandshake(signal.reason); }
  function checkHandshake() {
    signal.throwIfAborted();
    if (performance.now() >= expiresAt) throw serviceHandoffError();
  }
  async function signedSelection() {
    setPhase('READ_HELLO');
    const challenge = serviceChallenge(await channel.read());
    checkHandshake();
    const { installationId, hostId, rootNode, serviceRole } = enrollment;
    const selection: ServiceSelection = {
      format: 'patrick-service-selection-v1', challenge, session: admission.session, installationId, hostId,
      rootNode, uid: serviceRole!.uid, gid: serviceRole!.gid, identitySha256: serviceIdentityDigest(enrollment.identity),
      selectionSha256: admission.paths.selectionSha256, generation,
    };
    setPhase('SIGN_SELECTION');
    const signature = await authority.signSelection(serviceSelectionBytes(selection));
    checkHandshake();
    setPhase('VERIFY_SIGNATURE');
    return verifyServiceSelection({ version: 1, type: 'selection', selection, signature }, key);
  }
  signal.addEventListener('abort', cancelHandshake, { once: true });
  let signed: Awaited<ReturnType<typeof signedSelection>>;
  try {
    setPhase('SEND_READY');
    checkHandshake();
    admission.assertCurrent();
    channel.write(serviceReady);
    signed = await Promise.race([aborted, signedSelection()]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancelHandshake);
  }

  let stopping = false;
  let pendingTick: { promise: Promise<boolean>; resolve(available: boolean): void } | undefined;
  let pendingBootstrap: {
    promise: Promise<ServiceOwnerBootstrapResult>;
    resolve(result: ServiceOwnerBootstrapResult): void;
  } | undefined;
  function settleTick(available: boolean) {
    pendingTick?.resolve(available);
    pendingTick = undefined;
  }
  function settleBootstrap(result: ServiceOwnerBootstrapResult) {
    pendingBootstrap?.resolve(result);
    pendingBootstrap = undefined;
  }
  function stop() {
    if (stopping || socket.destroyed) return;
    stopping = true;
    settleTick(false);
    settleBootstrap({ status: 'unavailable', code: 'OWNER_BOOTSTRAP_UNAVAILABLE' });
    socket.end();
  }
  checkHandshake();
  if (socket.destroyed || socket.writableEnded || socket.readableEnded) {
    throw serviceHandoffError();
  }
  admission.signal.addEventListener('abort', stop, { once: true });
  try {
    setPhase('AUTHORIZE_WRITER');
    const confirmDrain = arm();
    channel.write(signed);
    setPhase('DRAIN');
    const { selection } = signed;
    offerTick?.(() => {
      if (stopping || socket.destroyed || admission.signal.aborted) return Promise.resolve(false);
      if (pendingTick) return pendingTick.promise;
      let acknowledge!: (available: boolean) => void;
      const tick = new Promise<boolean>(resolveTick => { acknowledge = resolveTick; });
      pendingTick = { promise: tick, resolve: acknowledge };
      try {
        admission.assertCurrent();
        channel.write(serviceStatus('worker-tick', selection));
      } catch {
        settleTick(false);
        socket.destroy();
      }
      return tick;
    });
    offerOwnerBootstrap?.(() => {
      if (stopping || socket.destroyed || admission.signal.aborted) {
        return Promise.resolve({ status: 'unavailable', code: 'OWNER_BOOTSTRAP_UNAVAILABLE' });
      }
      if (pendingBootstrap) {
        return Promise.resolve({ status: 'unavailable', code: 'OWNER_BOOTSTRAP_BUSY' });
      }
      let acknowledge!: (result: ServiceOwnerBootstrapResult) => void;
      const request = new Promise<ServiceOwnerBootstrapResult>(resolveBootstrap => { acknowledge = resolveBootstrap; });
      pendingBootstrap = { promise: request, resolve: acknowledge };
      try {
        admission.assertCurrent();
        channel.write(serviceStatus('owner-bootstrap', selection));
      } catch {
        settleBootstrap({ status: 'unavailable', code: 'OWNER_BOOTSTRAP_UNAVAILABLE' });
        socket.destroy();
      }
      return request;
    });
    let stopReceived = false;
    for (;;) {
      const response = await channel.read();
      if (!stopReceived && matchesServiceStatus(response, 'stop', selection)) {
        stopReceived = true;
        stop();
        continue;
      }
      const completed = offerTick && matchesServiceStatus(response, 'worker-tick-completed', selection);
      if (completed || (offerTick && matchesServiceStatus(response, 'worker-tick-unavailable', selection))) {
        if (!pendingTick && !stopping) throw serviceHandoffError();
        settleTick(completed === true);
        continue;
      }
      if (offerOwnerBootstrap) {
        const bootstrapReply = parseServiceOwnerBootstrap(response, selection);
        if (bootstrapReply) {
          if (!pendingBootstrap && !stopping) throw serviceHandoffError();
          settleBootstrap(bootstrapReply);
          continue;
        }
      }
      if (!stopping || !matchesServiceStatus(response, 'drained', selection)) throw serviceHandoffError();
      await channel.expectEnd();
      return confirmDrain;
    }
  } finally {
    offerTick?.(undefined);
    offerOwnerBootstrap?.(undefined);
    settleTick(false);
    settleBootstrap({ status: 'unavailable', code: 'OWNER_BOOTSTRAP_UNAVAILABLE' });
    admission.signal.removeEventListener('abort', stop);
  }
}

export async function runSelectedServiceSupervisor(program: SupervisorProgram, endpoint: string,
  enrollment: GenerationEnrollment, owner: ExclusiveRuntimeStaging | undefined,
  handoff: ServiceHandoffAuthority | ServeSelectedService, workerEndpoint?: string,
  ownerControl?: ServiceSupervisorOwnerControl) {
  const binding = bindRegistration(() => enrollment);
  if (binding.value.serviceRole?.controllerOwned !== true) throw new Error('INSTALLED_SERVICE_CONTROLLER_REQUIRED');
  const authority = typeof handoff === 'function' ? undefined : bindRegistration(() => handoff);
  const key = authority && serviceHandoffKey(authority.value.publicKey);
  if (authority && typeof authority.value.signSelection !== 'function') throw serviceHandoffError();
  const hasWorker = workerEndpoint !== undefined;
  if (hasWorker !== Boolean(process.env.PATRICK_WORKER_LISTENER_FD) ||
      (hasWorker && (!authority || resolve(workerEndpoint) !== workerEndpoint || workerEndpoint === endpoint))) {
    throw new Error('INSTALLED_WORKER_SUPERVISOR_LISTENER_REQUIRED');
  }
  const ownerEndpoint = ownerControl?.endpoint;
  if (ownerControl !== undefined && !authority) throw ownerControlInvalid();
  if (ownerEndpoint !== undefined) {
    const expectedDir = join(binding.value.root, 'runtime', 'service-control');
    if (typeof ownerEndpoint !== 'string' || resolve(ownerEndpoint) !== ownerEndpoint ||
        Buffer.byteLength(ownerEndpoint) > ownerControlMaxPathBytes ||
        dirname(ownerEndpoint) !== expectedDir || !ownerControlSocketName.test(basename(ownerEndpoint)) ||
        ownerEndpoint === endpoint || ownerEndpoint === workerEndpoint) {
      throw ownerControlInvalid();
    }
  }
  let activeTick: WorkerTick | undefined;
  const offerTick = hasWorker ? (tick?: WorkerTick) => { activeTick = tick; } : undefined;
  let activeOwnerBootstrap: OwnerBootstrapRequester | undefined;
  const offerOwnerBootstrap = ownerControl ? (issue?: OwnerBootstrapRequester) => {
    activeOwnerBootstrap = issue;
    ownerControl.onAvailable?.(issue);
  } : undefined;
  const serve: ServeSupervisorConnection = async (socket, shutdown, setPhase) => {
    const disconnected = new AbortController();
    const signal = AbortSignal.any([shutdown, disconnected.signal]);
    function stop() { disconnected.abort(new Error('INSTALLED_SERVICE_CONNECTION_LOST')); }
    setPhase('RESERVE_WRITER');
    const fence = reserveControllerServiceSession(binding.value);
    function assertCurrent() {
      binding.validate();
      fence.guard();
      signal.throwIfAborted();
    }
    socket.once('close', stop);
    try {
      if (socket.destroyed) stop();
      setPhase('VERIFY_GENERATION');
      const selection = await withConfirmedGeneration(binding.value, owner, async (current, deployment, guard) => {
        assertCurrent();
        guard();
        if (current.order.serviceRoleSha256 !== fence.roleSha256) throw new Error('INSTALLED_SERVICE_REGISTRATION_REQUIRED');
        if (!current.order.generation.roles.service) throw new Error('INSTALLED_SERVICE_DATA_LAYOUT_REQUIRED');
        return { paths: selectedRuntimePaths(binding.value, 'service', current.order.generation,
          current.sha256, deployment.packageSha256), deployment, generation: current.order.generation };
      }, signal);
      assertCurrent();
      const session = randomBytes(16).toString('hex');
      const admission = Object.freeze({ paths: selection.paths, deployment: selection.deployment, session, signal, assertCurrent });
      function arm() {
        assertCurrent();
        authority?.validate();
        return fence.authorize(selection.paths.selectionSha256, session);
      }
      let confirmDrain: () => void;
      if (typeof handoff === 'function') {
        setPhase('AUTHORIZE_WRITER');
        confirmDrain = arm();
        setPhase('DRAIN');
        if (await handoff(socket, admission) !== 'drained') throw new Error('INSTALLED_SERVICE_DRAIN_REQUIRED');
      } else {
        authority!.validate();
        confirmDrain = await serveSelectedService(socket, admission, binding.value, selection.generation, authority!.value, key!, arm, setPhase, offerTick, offerOwnerBootstrap);
      }
      authority?.validate();
      binding.validate();
      confirmDrain();
    } finally {
      socket.off('close', stop);
      fence.release();
    }
  };
  if (!hasWorker && ownerEndpoint === undefined) return runInstalledServiceSupervisor(program, endpoint, serve);

  const lifetime = new AbortController();
  const tasks: Promise<void>[] = [
    runInstalledRoleSupervisor('service', program, endpoint, serve, { descriptor: 3, signal: lifetime.signal }),
  ];
  if (hasWorker) {
    tasks.push(runInstalledRoleSupervisor('worker', program, workerEndpoint, (socket, shutdown) =>
      serveInstalledWorkerTicks(socket, shutdown, () => activeTick?.() ?? Promise.resolve(false)),
    { descriptor: 4, signal: lifetime.signal }));
  }
  if (ownerEndpoint !== undefined) {
    tasks.push(runInstalledOwnerBootstrapControl(
      ownerEndpoint,
      lifetime.signal,
      () => activeOwnerBootstrap?.() ?? Promise.resolve({ status: 'unavailable', code: 'OWNER_BOOTSTRAP_UNAVAILABLE' }),
      {
        expectedUid: 0,
        verifyDirectory() {
          binding.validate();
          verifyControllerOwnerControlDirectory(binding.value);
        },
      },
    ));
  }
  await Promise.race(tasks).catch(() => {});
  lifetime.abort();
  const results = await Promise.allSettled(tasks);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}

export async function runSupervisedServiceRole(registration: SupervisedServiceRegistration, provision: RoleProvision,
  onReady?: (started: Extract<StartedRole, { role: 'service' }>) => void): Promise<void> {
  const binding = bindRegistration(() => registration);
  validateSupervisedServiceAccount(binding.value);
  serviceHandoffKey(binding.value.publicKey);
  if (process.env.PATRICK_SUPERVISOR_FD !== '3' || !fstatSync(3).isSocket()) throw serviceHandoffError();
  const socket = new Socket({ fd: 3, readable: true, writable: true, allowHalfOpen: true });
  const channel = serviceFrame(socket);
  const stopping = new AbortController();
  const requestedStop = new Error('INSTALLED_SERVICE_STOP_REQUESTED');
  const drainOptions = { timeoutMs: 2_147_483_647 };
  let deadline = setTimeout(() => socket.destroy(new Error('INSTALLED_SERVICE_SUPERVISOR_READY_TIMEOUT')), serviceSupervisorReadyMs);
  let admitted: ReturnType<typeof admitSupervisedServiceSelection> | undefined;
  let runtime: Service | undefined;
  let parentStopped = false;
  let protocolFailure = false;
  let startupAttempted = false;
  let startupFailure: unknown;
  let parentEnd: Promise<void> | undefined;
  let stopDeadline: NodeJS.Timeout | undefined;
  function stop() {
    if (stopping.signal.aborted) return;
    stopping.abort(requestedStop);
    runtime?.stop();
  }
  function requestStop() {
    stop();
    if (!admitted || socket.destroyed) {
      socket.destroy();
      return;
    }
    if (parentStopped || stopDeadline) return;
    try { channel.write(serviceStatus('stop', admitted.signed.selection)); }
    catch { protocolFailure = true; socket.destroy(); return; }
    stopDeadline = setTimeout(() => socket.destroy(), serviceStopReplyMs);
  }
  process.on('SIGTERM', requestStop);
  process.on('SIGINT', requestStop);
  socket.on('error', stop);
  socket.once('close', stop);
  try {
    if (canonicalize(await channel.read()) !== canonicalize(serviceReady)) throw serviceHandoffError();
    clearTimeout(deadline);
    deadline = setTimeout(() => socket.destroy(new Error('INSTALLED_SERVICE_SUPERVISOR_SELECTION_TIMEOUT')), serviceHandshakeMs);
    const challenge = randomBytes(32).toString('hex');
    channel.write({ version: 1, type: 'hello', challenge });
    const frame = await channel.read();
    binding.validate();
    const selection = admitSupervisedServiceSelection(binding.value, challenge, frame);
    admitted = selection;
    clearTimeout(deadline);
    let executingTick: Promise<void> | undefined;
    let executingBootstrap: Promise<void> | undefined;
    function failProtocol() {
      protocolFailure = true;
      socket.destroy();
      stop();
    }
    function assertSelected() {
      stopping.signal.throwIfAborted();
      binding.validate();
      selection.assertCurrent();
    }
    async function observeSupervisor() {
      for (;;) {
        const request = await channel.readOrEnd();
        if (request === undefined) {
          clearTimeout(stopDeadline);
          parentStopped = true;
          stop();
          return;
        }
        if (matchesServiceStatus(request, 'owner-bootstrap', selection.signed.selection)) {
          if (executingBootstrap) throw serviceHandoffError();
          const runningService = runtime;
          executingBootstrap = Promise.resolve().then(() => {
            if (stopping.signal.aborted || socket.destroyed) return;
            const reply = executeSupervisedOwnerBootstrap(runningService, selection.signed.selection, assertSelected);
            if (!stopping.signal.aborted && !socket.destroyed) channel.write(reply);
          }).catch(failProtocol).finally(() => { executingBootstrap = undefined; });
          continue;
        }
        if (executingTick || !matchesServiceStatus(request, 'worker-tick', selection.signed.selection)) throw serviceHandoffError();
        const runningService = runtime;
        executingTick = Promise.resolve().then(async () => {
          let completed = false;
          if (runningService && !stopping.signal.aborted && running(runningService.read())) {
            try {
              await runningService.triggerConsultationTick();
              completed = true;
            } catch (error) {
              if (!(error instanceof Error) ||
                  !['CONSULTATION_TRIGGER_NOT_CONFIGURED', 'CONSULTATION_TRIGGER_STOPPED',
                    'OPERATIONAL_HUB_HEALTH_UNAVAILABLE', 'OPERATIONAL_HUB_IDENTITY_MISMATCH'].includes(error.message)) throw error;
            }
          }
          if (!stopping.signal.aborted && !socket.destroyed) {
            channel.write(serviceStatus(completed ? 'worker-tick-completed' : 'worker-tick-unavailable', selection.signed.selection));
          }
        }).catch(failProtocol).finally(() => { executingTick = undefined; });
      }
    }
    parentEnd = observeSupervisor().catch(failProtocol);
    try {
      assertSelected();
      const runtimeRoot = join(selection.releaseRoot, 'runtime');
      const composition: typeof import('./composition.js') = await import(pathToFileURL(join(runtimeRoot, 'composition.mjs')).href);
      assertSelected();
      if (typeof composition.createControllerSelectedServiceProvisioning !== 'function') throw new Error('INSTALLED_ROLE_ENTRYPOINT_REQUIRED');
      const input = await provision(selection.paths);
      assertSelected();
      const provisioning = composition.createControllerSelectedServiceProvisioning(input, binding.value, challenge, frame);
      const entry: typeof import('./service.js') = await import(pathToFileURL(join(runtimeRoot, 'service.mjs')).href);
      assertSelected();
      startupAttempted = true;
      runtime = await entry.runInstalledService(provisioning, assertSelected, { manageSignals: false });
      if (stopping.signal.aborted) runtime.stop();
      else if (running(runtime.read())) onReady?.({ role: 'service', runtime });
      while (!stopping.signal.aborted && running(runtime.read())) await delay(250);
      if (!stopping.signal.aborted) throw new Error('INSTALLED_ROLE_EXITED_UNEXPECTEDLY');
    } catch (error) {
      startupFailure = error;
      if (!stopping.signal.aborted) requestStop();
    }
    const cleanupConfirmed = runtime ? closed(await runtime.drain(drainOptions)) :
      hasCleanup(startupFailure) ? closed(startupFailure.readCleanup()) || closed(await startupFailure.drainCleanup(drainOptions)) :
      !startupAttempted || startupFailure === requestedStop;
    if (!cleanupConfirmed) throw new Error('INSTALLED_ROLE_DRAIN_INCOMPLETE', { cause: startupFailure });
    await parentEnd;
    await executingTick;
    await executingBootstrap;
    if (protocolFailure || !parentStopped || socket.destroyed) throw serviceHandoffError();
    channel.write(serviceStatus('drained', selection.signed.selection));
    await new Promise<void>((resolveFinished, reject) => {
      const error = () => reject(serviceHandoffError());
      socket.once('close', error);
      socket.end(() => {
        socket.off('close', error);
        resolveFinished();
      });
    });
    if (startupFailure && !wasCanceledStartup(startupFailure, requestedStop)) throw startupFailure;
  } finally {
    clearTimeout(deadline);
    clearTimeout(stopDeadline);
    process.off('SIGTERM', requestStop);
    process.off('SIGINT', requestStop);
    socket.destroy();
  }
}

export async function runSupervisedHubRole(onReady?: () => void): Promise<void> {
  const failure = new Error('INSTALLED_HUB_SUPERVISOR_PROTOCOL_INVALID');
  if (process.env.PATRICK_SUPERVISOR_FD !== '3') throw failure;
  const fd = openSync('/dev/fd/3', constants.O_RDWR);
  closeSync(3);
  const socket = new Socket({ fd, readable: true, writable: true, allowHalfOpen: true });
  let deadline = setTimeout(() => socket.destroy(failure), 120_000);
  let pending = '';
  let ready = false;
  let stopping = false;
  let stopped = false;
  function stop() {
    if (stopping || socket.destroyed) return;
    stopping = true;
    clearTimeout(deadline);
    deadline = setTimeout(() => socket.destroy(failure), 30_000);
    socket.end();
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    socket.on('data', (bytes: Buffer) => {
      if (pending.length + bytes.length > hubReady.length + hubStopped.length) return socket.destroy(failure);
      pending += bytes.toString('latin1');
      if (!ready && !stopped && pending.startsWith(hubReady)) {
        pending = pending.slice(hubReady.length);
        ready = true;
        if (!stopping) {
          clearTimeout(deadline);
          try { onReady?.(); } catch { return socket.destroy(failure); }
        }
      }
      if (stopping && !stopped && pending.startsWith(hubStopped)) {
        pending = pending.slice(hubStopped.length);
        stopped = true;
      }
      if (pending && (stopped || !((!ready && hubReady.startsWith(pending)) ||
          (stopping && hubStopped.startsWith(pending))))) socket.destroy(failure);
    });
    socket.once('end', () => socket.destroy());
    await once(socket, 'close');
    if (!stopped || pending) throw failure;
  } finally {
    clearTimeout(deadline);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    socket.destroy();
  }
}

export async function startSelectedRuntimeRole(
  enrollment: GenerationEnrollment,
  owner: ExclusiveRuntimeStaging | undefined,
  role: SelectedRuntimePaths['role'],
  provision: RoleProvision,
): Promise<StartedRole> {
  const fence = reserveServiceWriter(enrollment, 'other');
  return launchSelectedRuntimeRole(enrollment, owner, role, provision, fence);
}

async function launchSelectedRuntimeRole(
  enrollment: GenerationEnrollment,
  owner: ExclusiveRuntimeStaging | undefined,
  role: SelectedRuntimePaths['role'],
  provision: RoleProvision,
  fence: ServiceFence,
  lifecycle?: RoleLifecycle,
): Promise<StartedRole> {
  if (role !== 'service' && role !== 'worker') throw new Error('INSTALLED_ROLE_INVALID');
  let started: StartedRole | undefined;
  let startupFailure: unknown;
  function captureStartupFailure(error: unknown): never {
    startupFailure = error;
    throw error;
  }
  try {
    lifecycle?.signal.throwIfAborted();
    return await withConfirmedGeneration(enrollment, owner, async (selected, deployment, guard) => {
      if (selected.order.serviceRoleSha256 !== fence.roleSha256) throw new Error('INSTALLED_SERVICE_REGISTRATION_REQUIRED');
      function assertSelected() {
        fence.guard();
        guard();
        lifecycle?.signal.throwIfAborted();
      }
      const paths = selectedRuntimePaths(enrollment, role, selected.order.generation, selected.sha256, deployment.packageSha256);
      assertSelected();
      const composition: typeof import('./composition.js') = await import(pathToFileURL(deployment.entrypoints.composition).href);
      assertSelected();
      if (typeof composition.createSelectedRuntimeProvisioning !== 'function') throw new Error('INSTALLED_ROLE_ENTRYPOINT_REQUIRED');
      const input = await provision(paths);
      assertSelected();
      const provisioning = composition.createSelectedRuntimeProvisioning(input, paths);
      const options = { manageSignals: !lifecycle };
      if (role === 'service') {
        const entry: typeof import('./service.js') = await import(pathToFileURL(deployment.entrypoints.service).href);
        assertSelected();
        lifecycle?.onStarting();
        started = { role, runtime: await entry.runInstalledService(provisioning, assertSelected, options).catch(captureStartupFailure) };
      } else {
        const entry: typeof import('./worker.js') = await import(pathToFileURL(deployment.entrypoints.worker).href);
        assertSelected();
        started = { role, runtime: await entry.runInstalledWorker(provisioning, assertSelected, options).catch(captureStartupFailure) };
      }
      lifecycle?.onStarted(started);
      assertSelected();
      return started;
    });
  } catch (error) {
    if (hasCleanup(startupFailure)) {
      if (closed(startupFailure.readCleanup())) lifecycle?.onClosed();
      else {
        const failures = error === startupFailure ? [error] : [error, startupFailure];
        throw Object.assign(new AggregateError(failures, 'INSTALLED_ROLE_CLEANUP_UNCONFIRMED', { cause: startupFailure }),
          { role, readCleanup: startupFailure.readCleanup, drainCleanup: startupFailure.drainCleanup });
      }
    }
    if (started) {
      const { runtime } = started;
      const drainCleanup = (options?: { timeoutMs?: number }) => runtime.drain(options);
      try {
        runtime.stop();
        if (!closed(await drainCleanup())) throw new Error('INSTALLED_ROLE_DRAIN_INCOMPLETE', { cause: error });
        lifecycle?.onClosed();
      } catch (cleanup) {
        throw Object.assign(new AggregateError([error, cleanup], 'INSTALLED_ROLE_CLEANUP_UNCONFIRMED', { cause: cleanup }),
          { role, readCleanup: runtime.read, drainCleanup });
      }
    }
    throw error;
  }
}

export async function runInstalledRuntimeRole(
  enrollment: GenerationEnrollment,
  owner: ExclusiveRuntimeStaging | undefined,
  role: SelectedRuntimePaths['role'],
  provision: RoleProvision,
  onReady?: (started: StartedRole) => void,
): Promise<void> {
  const stopping = new AbortController();
  const requestedStop = new Error('INSTALLED_ROLE_STOP_REQUESTED');
  let runtimeStop: (() => void) | undefined;
  function stop() {
    if (stopping.signal.aborted) return;
    stopping.abort(requestedStop);
    runtimeStop?.();
  }
  const drainOptions = { timeoutMs: 2_147_483_647 };
  let fence: ServiceFence | undefined;
  let cleanupConfirmed = true;
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    fence = reserveServiceWriter(enrollment, role === 'service' ? 'foreground' : 'other');
    let started: StartedRole;
    try {
      started = await launchSelectedRuntimeRole(enrollment, owner, role, provision, fence, {
        signal: stopping.signal,
        onStarting() { cleanupConfirmed = false; },
        onStarted({ runtime }) {
          runtimeStop = runtime.stop;
          if (stopping.signal.aborted) runtimeStop();
        },
        onClosed() { cleanupConfirmed = true; },
      });
    } catch (error) {
      if (hasCleanup(error)) {
        cleanupConfirmed = false;
        cleanupConfirmed = closed(error.readCleanup()) || closed(await error.drainCleanup(drainOptions));
        if (!cleanupConfirmed) throw error;
      }
      if (wasCanceledStartup(error, requestedStop)) return;
      throw error;
    }
    const { runtime } = started;
    cleanupConfirmed = false;
    try {
      fence.guard();
      if (!stopping.signal.aborted && running(runtime.read())) onReady?.(started);
      while (!stopping.signal.aborted && running(runtime.read())) {
        fence.guard();
        await delay(250);
      }
      if (!stopping.signal.aborted) throw new Error('INSTALLED_ROLE_EXITED_UNEXPECTEDLY');
    } finally {
      cleanupConfirmed = closed(await runtime.drain(drainOptions));
    }
    if (!cleanupConfirmed) throw new Error('INSTALLED_ROLE_DRAIN_INCOMPLETE');
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    if (fence?.roleSha256 !== undefined) {
      if (cleanupConfirmed) fence.release();
      else undrainedServiceFences.add(fence);
    }
  }
}
