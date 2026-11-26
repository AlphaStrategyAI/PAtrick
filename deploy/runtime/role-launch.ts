import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { close, closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import { createServer, Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { leased, type ExclusiveRuntimeStaging, type RuntimeLease } from '../lib/emitted-release.mjs';
import { bindRegistration, projectIdentity, type HostIdentity } from '../lib/doctor.mjs';
import { admitReadRoot, readRegularFile, sha256 } from '../lib/release.mjs';
import type { RuntimeProvisioningInput } from './composition.js';
import { startHubProcess, type HubProcess } from './hub-process.js';
import { autoloopHubDatabase, autoloopHubDirectory, createInstalledHubRoleOwner, generationHubDatabase, generationHubRoleDigest, hubControlRoot,
  hubWriterFencePath, reserveServiceWriter, withConfirmedGeneration,
  type GenerationEnrollment } from './lifecycle-generation.js';

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

async function verifyHubPeer(socket: Socket, program: SupervisorProgram) {
  const { path, sha256: expected } = program;
  const denied = new Error('INSTALLED_HUB_SUPERVISOR_PEER_INVALID');
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
  const child = spawn(path, ['check-role-peer', 'hub'], {
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
    await verifyHubPeer(socket, program);
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
  const { root, installationId } = enrollment;
  const identity = projectIdentity(enrollment.identity);
  Object.freeze(identity.domains);
  Object.freeze(identity);
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
      const generation = selected.order.generation;
      const dataRoot = join(root, 'data', generation.id);
      const paths = Object.freeze({
        role, identity, installationId, generationId: generation.id,
        selectionSha256: selected.sha256, packageSha256: deployment.packageSha256,
        dataRoot, databasePath: join(dataRoot, 'service.sqlite'), localAnswersPath: join(dataRoot, 'answers.sqlite'),
        operationalHubPath: join(dataRoot, generationHubDatabase(generation.roles)), credentialDirectory: join(dataRoot, 'credentials'),
      });
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
