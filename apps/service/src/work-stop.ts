import { createTaskLifetime, type WorkerLifetime } from './lifecycle.js';
import { ackOutbox, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import type { StopReport } from '../../../packages/domain/src/work-control.js';

export type WorkStopRequest = {
  eventId: string; accountId: string; dataDomain: string; workId: string; generation: number;
};
export type WorkStopSupervisor = {
  // Repeated delivery of the same event ID must reconcile the original stop under the supervisor's identity.
  reconcile(request: WorkStopRequest, signal: AbortSignal): Promise<StopReport | null>;
  signal?: AbortSignal;
};
type Pending = {
  seq: number; event_id: string; account_id: string; data_domain: string;
  work_id: string; generation: number; receipt_id: string; revision: number;
};
export const workStopDestination = 'work-stop-supervisor';

export async function observeWorkStop(db: SqliteDatabase, supervisor: WorkStopSupervisor, now: () => Date, after = 0, timeoutMs = 5000, track: <T>(task: Promise<T>) => Promise<T> = (task) => task): Promise<number> {
  const pending = db.prepare(`SELECT d.seq,d.event_id,d.account_id,d.data_domain,w.work_id,w.generation,r.receipt_id,r.revision
    FROM outbox o JOIN domain_events d ON d.event_id=o.event_id
    JOIN work_control_receipts r ON r.receipt_id=json_extract(d.payload,'$.receipt_id') AND r.account_id=d.account_id
      AND r.work_id=d.aggregate_id AND r.generation=d.aggregate_version
    JOIN work_generations w ON w.work_id=r.work_id AND w.generation=r.generation AND w.account_id=r.account_id
      AND w.data_domain=d.data_domain AND w.revision=r.revision
    WHERE o.destination=? AND o.acked_at IS NULL AND d.seq>? AND d.schema_version LIKE '1.%'
      AND json_extract(d.payload,'$.type')='work.stop.requested'
      AND r.command_type='stop' AND r.state='processing' AND w.control_state='processing'
    ORDER BY d.seq LIMIT 1`).get(workStopDestination, after) as Pending | undefined;
  if (!pending) return 0;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = supervisor.signal ? AbortSignal.any([deadline, supervisor.signal]) : deadline;
  signal.throwIfAborted();
  let observed: StopReport | null;
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    observed = await Promise.race([aborted, track(supervisor.reconcile({
      eventId: pending.event_id, accountId: pending.account_id, dataDomain: pending.data_domain,
      workId: pending.work_id, generation: pending.generation,
    }, signal))]);
  } catch {
    // An interrupted or unavailable supervisor proves nothing; the stable intent remains queued.
    return pending.seq;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
  if (signal.aborted || typeof observed?.process_tree_stopped !== 'boolean' || typeof observed.effects_reconciled !== 'boolean') return pending.seq;
  const done = observed.process_tree_stopped && observed.effects_reconciled;
  withImmediateTransaction(db, () => {
    const stamped = now().toISOString();
    const result = db.prepare(`UPDATE work_generations SET process_tree_stopped=?,effects_reconciled=?,control_state=?,
      attempt_closed=CASE WHEN ?=1 THEN 1 ELSE attempt_closed END,updated_at=?
      WHERE work_id=? AND generation=? AND account_id=? AND data_domain=? AND revision=? AND control_state='processing'
        AND (process_tree_stopped<>? OR effects_reconciled<>? OR ?=1)`)
      .run(Number(observed.process_tree_stopped), Number(observed.effects_reconciled), done ? 'stopped' : 'processing', Number(done),
        stamped, pending.work_id, pending.generation, pending.account_id, pending.data_domain, pending.revision,
        Number(observed.process_tree_stopped), Number(observed.effects_reconciled), Number(done));
    if (!done || result.changes !== 1) return;
    const receipt = db.prepare(`UPDATE work_control_receipts SET state='stopped' WHERE receipt_id=? AND state='processing'`).run(pending.receipt_id);
    if (receipt.changes !== 1) throw new Error('STOP_RECEIPT_STALE');
    ackOutbox(db, pending.event_id, workStopDestination, 'accepted');
  });
  return pending.seq;
}

export function startWorkStopObserver(db: SqliteDatabase, supervisor: WorkStopSupervisor, now: () => Date): WorkerLifetime {
  const lifetime = createTaskLifetime(supervisor.signal);
  supervisor = { ...supervisor, signal: lifetime.signal };
  let cursor = 0;
  let timer: NodeJS.Timeout | undefined;
  supervisor.signal?.addEventListener('abort', () => clearTimeout(timer), { once: true });
  function schedule(wait: number) {
    if (supervisor.signal?.aborted) return;
    timer = setTimeout(() => {
      void lifetime.track(observeWorkStop(db, supervisor, now, cursor, 5000, lifetime.track)).then((next) => { cursor = next; })
        .catch(() => { cursor = 0; }).finally(() => schedule(1000));
    }, wait);
    timer.unref();
  }
  schedule(0);
  return lifetime;
}
