import type { HubPublisher } from '@patrick/integrations/autoloop/client';
import { dispatchSourceWork } from '@patrick/integrations/sources/work-dispatch';
import type { SqliteDatabase } from '@patrick/storage';
import { createTaskLifetime } from './lifecycle.js';

export type SourceWorkDispatchOptions = {
  hub: HubPublisher;
  signal?: AbortSignal;
  intervalMs?: number;
  onError?: (error: unknown) => void;
};

/** Drains admitted source changes into work roots and dispatches them to the hub.
 *
 * The dispatcher only publishes `work.requested` for a change the trigger
 * allowlist admitted, and it leaves the outbox entry unacknowledged whenever the
 * work cannot be prepared, so a later round retries instead of losing the change.
 */
export function createSourceWorkDispatch(db: SqliteDatabase, now: () => Date, options: SourceWorkDispatchOptions) {
  const lifetime = createTaskLifetime(options.signal);
  options = { ...options, signal: lifetime.signal };
  let started = false;
  let timer: NodeJS.Timeout | undefined;
  const interval = options.intervalMs ?? 1000;

  async function runTick() {
    await dispatchSourceWork(db, options.hub, { now });
  }

  function tick() {
    return lifetime.run(runTick);
  }

  function start() {
    if (started || options.signal?.aborted) return;
    started = true;
    options.signal?.addEventListener('abort', () => clearTimeout(timer), { once: true });
    function poll(wait: number) {
      if (options.signal?.aborted) return;
      timer = setTimeout(() => {
        void tick().catch((error: unknown) => {
          try { options.onError?.(error); } catch { /* Reporters must not stop claiming. */ }
        }).finally(() => poll(interval));
      }, wait);
      timer.unref();
    }
    poll(0);
  }

  return {
    start,
    tick,
    stop: lifetime.stop,
    join: lifetime.join,
    errors: lifetime.errors,
    get active() { return lifetime.active; },
  };
}
