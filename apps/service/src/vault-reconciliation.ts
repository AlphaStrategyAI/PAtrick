import type { BlobStore, SqliteDatabase } from '@patrick/storage';
import { reconcileConnectedVaults, type VaultReconciliationScope } from '../../../packages/integrations/vault/reconciliation.js';
import { createTaskLifetime } from './lifecycle.js';

export function createVaultReconciliationWorker(db: SqliteDatabase, blobs: BlobStore, scope: VaultReconciliationScope,
  now: () => Date, signal: AbortSignal, intervalMs = 5000,
) {
  const lifetime = createTaskLifetime(signal);
  let timer: NodeJS.Timeout | undefined;

  function poll(delay: number) {
    if (lifetime.signal.aborted) return;
    timer = setTimeout(() => {
      void lifetime.run(() => reconcileConnectedVaults(db, blobs, scope, now().toISOString(), lifetime.signal, lifetime.recordError))
        .then(() => poll(intervalMs), () => poll(intervalMs));
    }, delay);
    timer.unref();
  }
  lifetime.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });

  return {
    start: () => poll(0),
    stop: lifetime.stop,
    join: lifetime.join,
    errors: lifetime.errors,
    get active() { return lifetime.active; },
  };
}
