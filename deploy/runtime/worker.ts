import { createServiceRuntime } from '@patrick/service/factory';
import { createHubClient } from '@patrick/integrations/autoloop/client';
import {
  cleanRuntimeStartup,
  isRuntimeMain,
  requireRuntimeProvisioning,
  unavailableRuntimeDiagnostic,
  type RuntimeProvisioning,
} from './composition.js';

async function assertHubIdentity(origin: string, commit: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(new URL('/healthz', origin), {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !response.body) throw new Error();
  } catch {
    throw new Error('OPERATIONAL_HUB_HEALTH_UNAVAILABLE');
  }
  const reader = response.body.getReader();
  let health: unknown;
  try {
    const buffers: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 8192) throw new Error();
      buffers.push(chunk.value);
    }
    health = JSON.parse(Buffer.concat(buffers).toString('utf8'));
  } catch {
    throw new Error('OPERATIONAL_HUB_HEALTH_UNAVAILABLE');
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!health || typeof health !== 'object' || !('ok' in health) || health.ok !== true ||
      !('commit' in health) || health.commit !== commit) throw new Error('OPERATIONAL_HUB_IDENTITY_MISMATCH');
}

export async function createInstalledWorker(provisioning: RuntimeProvisioning) {
  const { worker, storageOptions } = requireRuntimeProvisioning(provisioning);
  const hub = provisioning.registration.operationalHub;
  if (!hub || !worker) throw new Error('OPERATIONAL_HUB_CAPABILITIES_REQUIRED');
  await assertHubIdentity(hub.origin, hub.commit);
  try {
    const { stop, drain, read } = createServiceRuntime({
      ...storageOptions,
      consultationWorker: { hub: createHubClient(hub.origin, worker.keys), backend: worker.backend },
    });
    return { stop, drain, read };
  } catch (error) {
    const { code, cleanup, readCleanup } = await cleanRuntimeStartup(error);
    throw Object.assign(new Error(code), { cleanup, readCleanup });
  }
}

export async function runInstalledWorker(provisioning: RuntimeProvisioning) {
  const runtime = await createInstalledWorker(provisioning);
  type Status = ReturnType<typeof runtime.read>;
  const keepAlive = setInterval(() => {
    if (runtime.read().status === 'closed') release();
  }, 250);
  function release() {
    clearInterval(keepAlive);
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  }
  async function drain(options?: { timeoutMs?: number }) {
    const result = await runtime.drain(options);
    if (result.status === 'closed') release();
    return result;
  }
  let stopping = false;
  let publish!: (result: Status & { signal: 'SIGTERM' | 'SIGINT' }) => void;
  const closed = new Promise<Status & { signal: 'SIGTERM' | 'SIGINT' }>((settle) => { publish = settle; });
  function onSignal(signal: 'SIGTERM' | 'SIGINT') {
    if (stopping) return;
    stopping = true;
    void drain().then((result) => {
      if (result.status !== 'closed') process.exitCode = 1;
      publish({ ...result, signal });
    });
  }
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  return { stop: runtime.stop, drain, read: runtime.read, closed };
}

if (isRuntimeMain(import.meta.url)) {
  const result = unavailableRuntimeDiagnostic(
    'Provision the independently managed Autoloop Hub origin and pinned commit, its role keys, and the worker recovery controller.',
  );
  process.stderr.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}
