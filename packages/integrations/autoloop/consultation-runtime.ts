import type { SqliteDatabase } from '@patrick/storage';
import { createBudgetApi } from '../../domain/src/budget.js';
import {
  acknowledgeConsultationOutbox, admittedConsultation, consultationAwaitingHubReceipt, consultationOutbox, createConsultationApi,
  finalizeConsultationPaidResult, persistConsultationPaidResult, recoverConsultationPaidResults,
} from '../../domain/src/consultations.js';
import { createDelegationApi } from '../../domain/src/delegation.js';
import { consultationBackendAdmitted, consultationBackendMatches, runPaidConsultation, type ConsultationBackend } from '../../executor/src/consultation.js';
import { CONSULTATION_RULE, HUB_SOURCE, type HubClient, type HubJob } from './client.js';
import { createConsultationHubPort } from './consultation-port.js';

const BATCH = 32;
// The dedicated Hub worker key may recover this same outstanding claim after a service restart.
const CLAIM_ID = 'patrick-consultation-service-v1';

export type ConsultationWorkerOptions = {
  hub: Pick<HubClient, 'postEvent' | 'claim' | 'result'>;
  backend?: ConsultationBackend;
  signal?: AbortSignal;
  intervalMs?: number;
  onError?: (error: unknown) => void;
};

export function startConsultationWorker(db: SqliteDatabase, now: () => Date, options: ConsultationWorkerOptions): void {
  const interval = options.intervalMs ?? 1000;
  const api = createConsultationApi(db, { now });
  const hubPort = createConsultationHubPort(db, {
    async postEvent(body) {
      const ack = await options.hub.postEvent(body);
      const stored = db.prepare('SELECT hub_event FROM hub_events WHERE event_id = ?').get(body.id) as { hub_event: number } | undefined;
      if (!Number.isSafeInteger(ack.event) || ack.event <= 0 || (stored && stored.hub_event !== ack.event)) {
        throw new Error('CONSULTATION_HUB_RECEIPT_MISMATCH');
      }
      return ack;
    },
  });
  let timeout: NodeJS.Timeout | undefined;
  options.signal?.addEventListener('abort', () => clearTimeout(timeout), { once: true });

  async function tick() {
    // Local completion is independent of both the Hub lease and the current send grant.
    recoverConsultationPaidResults(db, now().toISOString(), BATCH);
    for (const requestId of consultationOutbox(db, BATCH)) {
      if (options.signal?.aborted) return;
      try {
        const result = await api.dispatchConsultation(requestId, hubPort);
        if (result !== 'missing') acknowledgeConsultationOutbox(db, requestId, result);
      } catch (error) {
        report(error);
      }
    }
    const backend = options.backend;
    if (options.signal?.aborted || !backend || !consultationBackendAdmitted(backend)) return;
    const job = await options.hub.claim(CLAIM_ID);
    if (!job || options.signal?.aborted) return;
    if (job.rule.name !== CONSULTATION_RULE) throw new Error('CONSULTATION_WORKER_KEY_SCOPE');
    const requestId = claimedRequest(job);
    if (requestId && consultationAwaitingHubReceipt(db, requestId)) return;
    const finished = requestId ? await execute(requestId, backend) : false;
    await options.hub.result(job.run, job.token, finished
      ? { outcome: 'done', summary: 'consultation answered' }
      : { outcome: 'nothing', summary: 'no verified consultation result' });
  }

  async function execute(requestId: string, backend: ConsultationBackend): Promise<boolean> {
    const admitted = admittedConsultation(db, requestId);
    if (!admitted) {
      const finished = db.prepare("SELECT result_version FROM consultations WHERE request_id = ? AND status = 'answered'").get(requestId) as {
        result_version: number;
      } | undefined;
      return finished ? finalizeConsultationPaidResult(db, requestId, finished.result_version - 1, now().toISOString()) : false;
    }
    const { principal, domain, text } = admitted;
    const scope = { accountId: principal.account_id, dataDomain: domain };
    if (!consultationBackendMatches(backend, scope)) return false;
    const delegation = createDelegationApi(db, principal, { now, domain });
    try {
      const attemptId = `attempt:${requestId}`;
      const grant = await delegation.authorizeConsultation(requestId, attemptId);
      const budget = createBudgetApi(db, principal, { now });
      const outcome = await runPaidConsultation({
        backend, grant, scope, text,
        billing: {
          reserveCall: budget.reserveCall,
          claimPaidDispatch: (...args) => budget.claimPaidDispatch(...args,
            () => !options.signal?.aborted && admittedConsultation(db, requestId) !== null),
          settleCall: budget.settleCall,
        },
        settleAnswer: (reservationId, usage, answer) => budget.settleCall(reservationId, usage,
          (receipt) => persistConsultationPaidResult(db, grant, receipt, usage, answer)),
      });
      if (outcome.settled !== 'settled') return false;
      return finalizeConsultationPaidResult(db, requestId, grant.result_version, now().toISOString());
    } catch (error) {
      if (error instanceof Error && ['DENIED', 'NOT_FOUND', 'FORBIDDEN', 'BUDGET_EXHAUSTED'].includes(error.message)) return false;
      throw error;
    }
  }

  function report(error: unknown) {
    if (options.onError) options.onError(error);
    else process.emitWarning('Consultation worker could not finish a polling step', { code: 'CONSULTATION_WORKER' });
  }

  function schedule(delay: number) {
    if (options.signal?.aborted) return;
    timeout = setTimeout(() => {
      void tick().catch(report).finally(() => schedule(interval));
    }, delay);
    timeout.unref();
  }

  schedule(0);
}

function claimedRequest(job: HubJob): string | null {
  const events = job.context.events.filter((item) => item.source === HUB_SOURCE && item.type === 'consultation.requested');
  if (events.length !== 1) return null;
  const event = events[0];
  try {
    const detail = JSON.parse(event.detail ?? 'null') as {
      request_id?: string; root?: string; cause?: string; kind?: string; generation?: number; hops?: number;
    } | null;
    if (event.id === `consultation.requested:${event.subject}` && detail?.request_id === event.subject
      && detail.root === event.subject && detail.cause === event.subject && detail.kind === event.type
      && detail.generation === 0 && detail.hops === 0) return event.subject;
  } catch {
    // Malformed Hub job data cannot establish authority to enter a paid lane.
  }
  return null;
}
