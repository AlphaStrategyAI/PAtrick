import type { Query, QueryClient } from '@tanstack/react-query';
import { watermarkSchema } from '@patrick/contracts/envelope';
import { ClientError, scopedQueryKey } from './client.js';
import { covers } from './events.js';
import type { Scope, Watermark } from './events.js';
import { waitForDelay } from './timing.js';

export function purgeAccountQueries(client: QueryClient, account: string): void {
  const filters = { queryKey: ['patrick', account] };
  void client.cancelQueries(filters);
  client.removeQueries(filters);
}

export const t13ProjectionMeta = { t13Projection: true } as const;

function participates(query: Query): boolean {
  if (query.meta?.t13Projection !== true) return false;
  if (query.state.status !== 'error') return true;
  const error = query.state.error;
  return error instanceof ClientError && error.status !== 401 && error.status !== 403
    && (error.retryable || error.code === 'UNAVAILABLE' || error.status === 429 || (error.status ?? 0) >= 500);
}

/** A notification commits before its refetch. Cancel first, including queries with no value yet. */
export function refreshScopedQueries(client: QueryClient, scope: Scope): Promise<void> {
  const filters = { queryKey: scopedQueryKey(scope, '').slice(0, 4), predicate: participates };
  // TanStack cancels the retryer synchronously, even though its bookkeeping returns a promise.
  void client.cancelQueries(filters);
  return client.invalidateQueries(filters);
}

/** Batch a replay, then retain demand until active scoped snapshots cover both watermarks. */
export function createProjectionRefresh(
  client: QueryClient, scope: Scope, signal: AbortSignal, options: { coalesceMs?: number; retryMs?: number } = {},
) {
  const coalesce = options.coalesceMs ?? 16;
  const retry = options.retryMs ?? 1000;
  const activeFilters = { queryKey: scopedQueryKey(scope, '').slice(0, 4), type: 'active' as const, predicate: participates };
  let latest: Watermark = { hub_seq: 0, domain_seq: 0 };
  let requested = 0;
  let pending: Promise<void> | undefined;

  async function drain(): Promise<void> {
    try {
      let delay = coalesce;
      let nextRetry = retry;
      while (!signal.aborted) {
        await waitForDelay(delay, signal);
        if (signal.aborted) return;
        const observed = requested;
        await refreshScopedQueries(client, scope);
        if (signal.aborted) return;
        if (requested !== observed) {
          // The last GET might have started before a change, even at the same watermark.
          delay = coalesce;
          nextRetry = retry;
          continue;
        }
        if (client.getQueryCache().findAll(activeFilters).every((query) => {
          const data = query.state.data;
          const mark = watermarkSchema.safeParse(data && typeof data === 'object' && 'watermark' in data ? data.watermark : undefined);
          return mark.success && covers(mark.data, latest);
        })) return;
        delay = nextRetry;
        nextRetry = Math.min(nextRetry * 2, 5000);
      }
    } finally {
      pending = undefined;
    }
  }

  return (watermark: Watermark): Promise<void> => {
    if (signal.aborted) return Promise.resolve();
    latest = { hub_seq: Math.max(latest.hub_seq, watermark.hub_seq), domain_seq: Math.max(latest.domain_seq, watermark.domain_seq) };
    requested++;
    return pending ??= drain();
  };
}
