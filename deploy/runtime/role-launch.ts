import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExclusiveRuntimeStaging } from '../lib/emitted-release.mjs';
import { projectIdentity, type HostIdentity } from '../lib/doctor.mjs';
import type { RuntimeProvisioningInput } from './composition.js';
import { withConfirmedGeneration, type GenerationEnrollment } from './lifecycle-generation.js';

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

export async function startSelectedRuntimeRole(
  enrollment: GenerationEnrollment,
  owner: ExclusiveRuntimeStaging,
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
        operationalHubPath: join(dataRoot, 'hub.sqlite'), credentialDirectory: join(dataRoot, 'credentials'),
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
