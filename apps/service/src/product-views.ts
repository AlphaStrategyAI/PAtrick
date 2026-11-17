import { withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { HUB_CURSOR, readConsistentHubSnapshot, storeHubView, type HubSnapshot, type HubStateReader } from '@patrick/integrations/autoloop/observer';
import { createProjectionCursorCodec, type ProjectionScope } from '../../../packages/storage/src/views/cursors.js';
import { createWorkProjection } from '../../../packages/storage/src/views/work.js';
import { createStatsProjection } from '../../../packages/storage/src/views/stats.js';
import { deriveWorkBatch } from '../../../packages/storage/src/views/work-source.js';

type ProductScope = Pick<ProjectionScope, 'accountId' | 'dataDomain'>;

type ProjectionWorkerOptions = { signal?: AbortSignal; intervalMs?: number; onError?: (error: unknown) => void };
type SweepRow = { account_id: string; data_domain: string };
const staleAfterMs = 60_000;

export function createProductViewService(db: SqliteDatabase, now: () => Date) {
  const key = db.prepare("SELECT bytes FROM product_view_keys WHERE name='cursor'").get() as { bytes: Uint8Array } | undefined;
  if (!key) throw new Error('PRODUCT_VIEW_CURSOR_KEY_MISSING');
  const projection = createWorkProjection(db, createProjectionCursorCodec(key.bytes));
  const stats = createStatsProjection(db);
  const observed = new Map<string, string>();
  let authored = 0;
  let started = false;

  function totalChanges(): number {
    return (db.prepare('SELECT total_changes() AS changes').get() as { changes: number }).changes;
  }
  function inputStamp(observedAt: Date): string {
    const age = db.prepare('SELECT imported_at FROM hub_snapshots WHERE cursor_name=?').get(HUB_CURSOR) as { imported_at: string } | undefined;
    return JSON.stringify([db.pragma('data_version', { simple: true }), totalChanges() - authored,
      age ? observedAt.getTime() - Date.parse(age.imported_at) > staleAfterMs : null]);
  }
  function refresh(scope: ProductScope, onlyChanged = false): void {
    // Prepare the next scope snapshot in a deferred transaction. Recheck the input version inside the commit.
    const at = now();
    const stamp = inputStamp(at);
    const index = JSON.stringify([scope.accountId, scope.dataDomain]);
    if (onlyChanged && observed.get(index) === stamp && !stats.needsRefresh(scope, at)) return;
    const batch = deriveWorkBatch(db, scope, at, staleAfterMs);
    const before = totalChanges();
    let complete: boolean;
    try {
      const applied = projection.apply(scope, batch, () => inputStamp(at) === stamp);
      complete = applied && stats.refresh(scope, at);
    } finally { authored += totalChanges() - before; }
    if (complete) {
      observed.delete(index);
      observed.set(index, stamp);
      if (observed.size > 4096) observed.delete(observed.keys().next().value!);
    }
  }
  function start(options: ProjectionWorkerOptions = {}): void {
    if (started || options.signal?.aborted) return;
    started = true;
    const interval = options.intervalMs ?? 400;
    const pageSize = 4;
    let last: SweepRow | undefined;
    let timer: NodeJS.Timeout | undefined;
    options.signal?.addEventListener('abort', () => clearTimeout(timer), { once: true });
    function schedule(wait: number) {
      if (options.signal?.aborted) return;
      timer = setTimeout(sweep, wait);
      timer.unref();
    }
    function sweep() {
      try {
        const scopes = db.prepare(`SELECT DISTINCT account_id,data_domain FROM caller_scopes
          WHERE revoked_at IS NULL ${last ? 'AND (account_id,data_domain)>(?,?)' : ''}
          ORDER BY account_id,data_domain LIMIT ?`)
          .all(...(last ? [last.account_id, last.data_domain, pageSize] : [pageSize])) as SweepRow[];
        for (const { account_id, data_domain } of scopes) {
          try { refresh({ accountId: account_id, dataDomain: data_domain }, true); }
          catch (error) { options.onError?.(error); }
        }
        last = scopes.length === pageSize ? scopes.at(-1) : undefined;
        schedule(last ? 10 : interval);
      } catch (error) {
        options.onError?.(error);
        schedule(interval);
      }
    }
    schedule(0);
  }

  function recordHubObservation(view: HubSnapshot, observedAt: string): void {
    const before = totalChanges();
    if (storeHubView(db, view, observedAt) === 'observation') {
      // Advancing a liveness timestamp does not change the projection's input facts.
      // The stamp still tracks the age bucket to notice both expiry and recovery.
      authored += totalChanges() - before;
    }
  }
  return { projection, stats, refresh, start, recordHubObservation };
}

export type ProductViewHub = { hub: HubStateReader; signal?: AbortSignal; onError?: (error: unknown) => void };

/** The Hub owns the operational state. The optional observer only reads its consistent paged snapshot. */
export function startProductViewHubObserver(
  db: SqliteDatabase, now: () => Date, options: ProductViewHub,
  record: (view: HubSnapshot, observedAt: string) => void,
): void {
  let timeout: NodeJS.Timeout | undefined;
  options.signal?.addEventListener('abort', () => clearTimeout(timeout), { once: true });
  function schedule(delay: number) {
    if (options.signal?.aborted) return;
    timeout = setTimeout(() => {
      void observe().catch((error: unknown) => {
        if (!options.signal?.aborted) options.onError?.(error);
      }).finally(() => schedule(2500));
    }, delay);
    timeout.unref();
  }
  async function observe() {
    const deadline = AbortSignal.timeout(8000);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const view = await readConsistentHubSnapshot(options.hub, signal);
    signal.throwIfAborted();
    withImmediateTransaction(db, () => {
      const prior = db.prepare('SELECT hub_seq FROM hub_snapshots WHERE cursor_name=?').get(HUB_CURSOR) as { hub_seq: number } | undefined;
      if (prior && prior.hub_seq > view.hub_seq) throw new Error('HUB_OBSERVER_WATERMARK_REGRESSION');
      record(view, now().toISOString());
    });
  }
  schedule(0);
}
