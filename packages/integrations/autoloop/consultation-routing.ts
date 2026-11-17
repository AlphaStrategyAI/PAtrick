import type { SqliteDatabase } from '@patrick/storage';
import { acknowledgeConsultationOutbox, createConsultationApi } from '../../domain/src/consultations.js';
import { CONSULTATION_RULE, HUB_SOURCE, type HubClient, type HubJob } from './client.js';
import { createConsultationHubPort } from './consultation-port.js';

type RoutingHub = Pick<HubClient, 'postEvent' | 'eventOutcome'>;
type HubResult = Parameters<HubClient['result']>[2];

const SCOPE_TIMER = 'patrick-consultation-scope';
const SCOPE_RETRY_MS = 30_000;
const requestSubject = /^[A-Za-z0-9#._:/@-]{1,100}$/;
const eventKind = 'consultation.requested';
const eventId = (requestId: string) => `${eventKind}:${requestId}`;

export function createConsultationRouting(db: SqliteDatabase, hub: RoutingHub, now: () => Date) {
  const api = createConsultationApi(db, { now });
  let cursor = 0;

  function hubReceipt(id: string) {
    return db.prepare('SELECT hub_event FROM hub_events WHERE event_id = ?').get(id) as { hub_event: number } | undefined;
  }

  async function reconcile(requestId: string, signal?: AbortSignal) {
    const id = eventId(requestId);
    let receipt = hubReceipt(id);
    let result: 'accepted' | 'duplicate' = 'duplicate';
    if (!receipt) {
      const port = createConsultationHubPort(db, {
        async postEvent(body) {
          const ack = await hub.postEvent(body, signal);
          const stored = hubReceipt(body.id);
          if (!Number.isSafeInteger(ack.event) || ack.event <= 0 || (stored && stored.hub_event !== ack.event)) {
            throw new Error('CONSULTATION_HUB_RECEIPT_MISMATCH');
          }
          return ack;
        },
      });
      const posted = await api.dispatchConsultation(requestId, port);
      if (posted === 'missing') return;
      result = posted;
      receipt = hubReceipt(id);
    }
    if (!receipt) throw new Error('CONSULTATION_HUB_RECEIPT_MISSING');
    const outcome = await hub.eventOutcome(receipt.hub_event, signal);
    if (outcome.event !== receipt.hub_event) throw new Error('CONSULTATION_HUB_RECEIPT_MISMATCH');
    // The source event may exist without any run while the rule is paused. Resume alone is
    // insufficient; the owner explicitly replays skipped events and Hub adds the run to readback.
    if (outcome.runs.some((run) => run.rule === CONSULTATION_RULE)) acknowledgeConsultationOutbox(db, requestId, result);
  }

  return {
    async drain(limit: number, signal: AbortSignal | undefined, report: (error: unknown) => void) {
      // A paused or unrouted event can stay pending indefinitely. A bounded scan cursor lets later
      // requests reach the Hub and applies no changes to earlier pending receipts after restart.
      const pending = db.prepare(`SELECT e.seq, e.aggregate_id FROM outbox o JOIN domain_events e USING (event_id)
        WHERE o.destination = 'autoloop' AND o.result IS NULL AND e.seq > ?
          AND e.event_id = 'consultation.requested:' || e.aggregate_id ORDER BY e.seq LIMIT ?`)
        .all(cursor, limit) as Array<{ seq: number; aggregate_id: string }>;
      for (const entry of pending) {
        if (signal?.aborted) return;
        cursor = entry.seq;
        try {
          await reconcile(entry.aggregate_id, signal);
        } catch (error) {
          report(error);
        }
      }
      if (pending.length < limit) cursor = 0;
    },
  };
}

export function deferConsultationScope(requestId: string, now: Date, deadlineAt: string): HubResult {
  const at = Math.min(now.getTime() + SCOPE_RETRY_MS, Date.parse(deadlineAt));
  if (!Number.isFinite(at) || at <= now.getTime()) return { outcome: 'nothing', summary: 'no verified consultation result' };
  return {
    outcome: 'done',
    summary: 'consultation waiting for a scoped backend',
    later: [{ key: SCOPE_TIMER, at: new Date(at).toISOString(), about: scopeTimerAbout(requestId) }],
  };
}

export function consultationRequestForJob(job: HubJob): string | null {
  if (job.rule.name !== CONSULTATION_RULE) return null;
  const originals = job.context.events.filter((item) => item.source === HUB_SOURCE && item.type === eventKind);
  if (originals.length > 1) return null;
  const original = originals[0];
  if (original) {
    try {
      const detail = JSON.parse(original.detail ?? 'null') as {
        request_id?: string; root?: string; cause?: string; kind?: string; generation?: number; hops?: number;
      } | null;
      if (requestSubject.test(original.subject) && original.id === eventId(original.subject)
        && detail?.request_id === original.subject && detail.root === original.subject && detail.cause === original.subject
        && detail.kind === eventKind && detail.generation === 0 && detail.hops === 0) return original.subject;
    } catch {
      return null;
    }
    return null;
  }
  // Hub supplies both the timer.due event and its timer context. The dedicated parallel
  // consultation lane preserves the original subject on the timer. No paid result is
  // authorized by a subject alone: runtime still reads the exact local request and grant.
  const timers = job.context.events.filter((item) => item.source === HUB_SOURCE && item.type === 'timer.due'
    && /^timer:[1-9][0-9]*$/.test(item.id ?? '') && requestSubject.test(item.subject));
  if (timers.length !== 1) return null;
  const requestId = timers[0].subject;
  return job.context.timers?.some((timer) => timer.key === SCOPE_TIMER && timer.about === scopeTimerAbout(requestId))
    ? requestId : null;
}

function scopeTimerAbout(requestId: string): string {
  return `scope:${eventId(requestId)}`;
}
