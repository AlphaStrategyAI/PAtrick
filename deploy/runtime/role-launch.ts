import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { leased, type ExclusiveRuntimeStaging, type RuntimeLease } from '../lib/emitted-release.mjs';
import { bindRegistration, projectIdentity, type HostIdentity } from '../lib/doctor.mjs';
import { admitReadRoot, readRegularFile, sha256 } from '../lib/release.mjs';
import type { RuntimeProvisioningInput } from './composition.js';
import { startHubProcess, type HubProcess } from './hub-process.js';
import { autoloopHubDatabase, autoloopHubDirectory, createInstalledHubRoleOwner, generationHubDatabase, generationHubRoleDigest, hubControlRoot,
  hubWriterFencePath, withConfirmedGeneration,
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
type CleanupResult = ReturnType<Service['read']> | ReturnType<Worker['read']>;
type StartupCleanup = {
  readCleanup(): CleanupResult;
  drainCleanup(options?: { timeoutMs?: number }): Promise<CleanupResult>;
};

function closed(result: CleanupResult) {
  if ('listener' in result) return result.listener === 'closed' && result.runtime.status === 'closed';
  return result.status === 'closed';
}

function hasCleanup(error: unknown): error is StartupCleanup {
  return error instanceof Error && 'readCleanup' in error && typeof error.readCleanup === 'function' &&
    'drainCleanup' in error && typeof error.drainCleanup === 'function';
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
      });
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
    const { ready, lifetime } = launchSelectedHubRole(enrollment, owner, registration, stopping.signal);
    try {
      const started = await ready;
      if (!stopping.signal.aborted) onReady?.(started);
      const exit = await lifetime;
      if (!exit.stopRequested) throw new Error('INSTALLED_HUB_EXITED_UNEXPECTEDLY');
      requireCleanHubExit(exit);
    } catch (error) {
      stop();
      await lifetime.catch(() => {});
      if (error !== stopReason) throw error;
    }
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

export async function startSelectedRuntimeRole(
  enrollment: GenerationEnrollment,
  owner: ExclusiveRuntimeStaging | undefined,
  role: SelectedRuntimePaths['role'],
  provision: (paths: SelectedRuntimePaths) => RuntimeProvisioningInput | Promise<RuntimeProvisioningInput>,
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
    return await withConfirmedGeneration(enrollment, owner, async (selected, deployment, guard) => {
      const generation = selected.order.generation;
      const dataRoot = join(root, 'data', generation.id);
      const paths = Object.freeze({
        role, identity, installationId, generationId: generation.id,
        selectionSha256: selected.sha256, packageSha256: deployment.packageSha256,
        dataRoot, databasePath: join(dataRoot, 'service.sqlite'), localAnswersPath: join(dataRoot, 'answers.sqlite'),
        operationalHubPath: join(dataRoot, generationHubDatabase(generation.roles)), credentialDirectory: join(dataRoot, 'credentials'),
      });
      guard();
      const composition: typeof import('./composition.js') = await import(pathToFileURL(deployment.entrypoints.composition).href);
      guard();
      if (typeof composition.createSelectedRuntimeProvisioning !== 'function') throw new Error('INSTALLED_ROLE_ENTRYPOINT_REQUIRED');
      const input = await provision(paths);
      guard();
      const provisioning = composition.createSelectedRuntimeProvisioning(input, paths);
      if (role === 'service') {
        const entry: typeof import('./service.js') = await import(pathToFileURL(deployment.entrypoints.service).href);
        guard();
        started = { role, runtime: await entry.runInstalledService(provisioning, guard).catch(captureStartupFailure) };
      } else {
        const entry: typeof import('./worker.js') = await import(pathToFileURL(deployment.entrypoints.worker).href);
        guard();
        started = { role, runtime: await entry.runInstalledWorker(provisioning, guard).catch(captureStartupFailure) };
      }
      return started;
    });
  } catch (error) {
    if (hasCleanup(startupFailure) && !closed(startupFailure.readCleanup())) {
      const failures = error === startupFailure ? [error] : [error, startupFailure];
      throw Object.assign(new AggregateError(failures, 'INSTALLED_ROLE_CLEANUP_UNCONFIRMED', { cause: startupFailure }),
        { role, readCleanup: startupFailure.readCleanup, drainCleanup: startupFailure.drainCleanup });
    }
    if (started) {
      const { runtime } = started;
      const drainCleanup = (options?: { timeoutMs?: number }) => runtime.drain(options);
      try {
        runtime.stop();
        if (!closed(await drainCleanup())) throw new Error('INSTALLED_ROLE_DRAIN_INCOMPLETE', { cause: error });
      } catch (cleanup) {
        throw Object.assign(new AggregateError([error, cleanup], 'INSTALLED_ROLE_CLEANUP_UNCONFIRMED', { cause: cleanup }),
          { role, readCleanup: runtime.read, drainCleanup });
      }
    }
    throw error;
  }
}
