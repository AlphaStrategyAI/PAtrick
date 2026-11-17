import { setTimeout as delay } from 'node:timers/promises';
import type { SqliteDatabase } from '@patrick/storage';
import { createBudgetApi } from '../../domain/src/budget.js';
import {
  admittedConsultation, consultationAwaitingHubReceipt,
  finalizeConsultationPaidResult, persistConsultationPaidResult, recoverConsultationPaidResults, type ConsultationPaidTerminal,
} from '../../domain/src/consultations.js';
import { createDelegationApi } from '../../domain/src/delegation.js';
import { consultationBackendAdmitted, consultationBackendMatches, runPaidConsultation, type ConsultationBackend } from '../../executor/src/consultation.js';
import type { CredentialStore } from '../../host/src/credentials.js';
import { CONSULTATION_RULE, type HubClient, type HubJob } from './client.js';
import { consultationHubResult, createConsultationHubReceipts } from './consultation-hub-receipts.js';
import { consultationRequestForJob, createConsultationRouting, deferConsultationScope } from './consultation-routing.js';

const BATCH = 32;
// The pinned Hub lease is five minutes. Keep renewals well inside that window.
const HEARTBEAT_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const EXECUTION_TIMEOUT_MS = 10 * 60_000;
// The dedicated Hub worker key may recover this same outstanding claim after a service restart.
const CLAIM_ID = 'patrick-consultation-service-v1';

export type ConsultationWorkerOptions = {
  hub: Pick<HubClient, 'postEvent' | 'eventOutcome' | 'claim' | 'heartbeat' | 'result'>;
  backend?: ConsultationBackend;
  signal?: AbortSignal;
  intervalMs?: number;
  heartbeatIntervalMs?: number;
  executionTimeoutMs?: number;
  onError?: (error: unknown) => void;
};

export function startConsultationWorker(
  db: SqliteDatabase, now: () => Date, options: ConsultationWorkerOptions, credentials: CredentialStore,
): void {
  const interval = options.intervalMs ?? 1000;
  const heartbeatInterval = options.heartbeatIntervalMs ?? HEARTBEAT_MS;
  const executionTimeout = options.executionTimeoutMs ?? EXECUTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(heartbeatInterval) || heartbeatInterval < 1 || heartbeatInterval > 60_000
    || !Number.isSafeInteger(executionTimeout) || executionTimeout < 1 || executionTimeout > EXECUTION_TIMEOUT_MS) {
    throw new Error('CONSULTATION_WORKER_TIMEOUT_INVALID');
  }
  const routing = createConsultationRouting(db, options.hub, now);
  const receipts = createConsultationHubReceipts(db, credentials, options.hub);
  let timeout: NodeJS.Timeout | undefined;
  options.signal?.addEventListener('abort', () => clearTimeout(timeout), { once: true });

  async function tick() {
    // Local completion is independent of both the Hub lease and the current send grant.
    recoverConsultationPaidResults(db, now().toISOString(), BATCH);
    await receipts.recover(BATCH, report);
    await routing.drain(BATCH, options.signal, report);
    const backend = options.backend;
    if (options.signal?.aborted || !backend || !consultationBackendAdmitted(backend)) return;
    const job = await options.hub.claim(CLAIM_ID);
    if (!job || options.signal?.aborted) return;
    if (job.rule.name !== CONSULTATION_RULE) throw new Error('CONSULTATION_WORKER_KEY_SCOPE');
    const requestId = consultationRequestForJob(job);
    if (requestId && consultationAwaitingHubReceipt(db, requestId)) return;
    const binding = requestId ? receipts.bind(requestId, job) : null;
    if (!requestId || !binding) {
      await options.hub.result(job.run, job.token, consultationHubResult(null));
      return;
    }
    const admitted = admittedConsultation(db, requestId);
    if (admitted && !consultationBackendMatches(backend, { accountId: admitted.principal.account_id, dataDomain: admitted.domain })) {
      await receipts.deliver(binding, deferConsultationScope(requestId, now()));
      return;
    }
    const finished = await withLease(job, (signal) => execute(requestId, backend, signal));
    if (options.signal?.aborted) return;
    await receipts.deliver(binding, consultationHubResult(finished));
  }

  async function withLease<T>(job: HubJob, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const stop = new AbortController();
    const signals = [stop.signal, AbortSignal.timeout(executionTimeout)];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    void keepLease(job.run, signal, stop).catch((error: unknown) => {
      if (!signal.aborted) report(error);
    });
    try {
      return await run(signal);
    } finally {
      stop.abort();
    }
  }

  async function keepLease(run: number, signal: AbortSignal, stop: AbortController): Promise<void> {
    while (!signal.aborted) {
      await delay(heartbeatInterval, undefined, { signal, ref: false });
      try {
        const cancelled = await options.hub.heartbeat(CLAIM_ID, run, AbortSignal.any([signal, AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS)]));
        if (cancelled.includes(run)) stop.abort();
      } catch (error) {
        // A lost heartbeat does not retry the paid call or mint a new permit.
        if (!signal.aborted) report(error);
      }
    }
  }

  async function execute(
    requestId: string, backend: ConsultationBackend, signal: AbortSignal,
  ): Promise<ConsultationPaidTerminal['status'] | null> {
    const admitted = admittedConsultation(db, requestId);
    if (!admitted) {
      const finished = db.prepare("SELECT result_version FROM consultations WHERE request_id = ? AND status IN ('answered', 'failed')").get(requestId) as {
        result_version: number;
      } | undefined;
      return finished ? finalizeConsultationPaidResult(db, requestId, finished.result_version - 1, now().toISOString()) : null;
    }
    const { principal, domain, text } = admitted;
    const scope = { accountId: principal.account_id, dataDomain: domain };
    if (signal.aborted || !consultationBackendMatches(backend, scope)) return null;
    const delegation = createDelegationApi(db, principal, { now, domain });
    try {
      const attemptId = `attempt:${requestId}`;
      const grant = await delegation.authorizeConsultation(requestId, attemptId);
      const budget = createBudgetApi(db, principal, { now });
      const outcome = await runPaidConsultation({
        backend, grant, scope, text, signal,
        billing: {
          reserveCall: budget.reserveCall,
          claimPaidDispatch: (...args) => budget.claimPaidDispatch(...args,
            () => !signal.aborted && admittedConsultation(db, requestId) !== null),
          settleCall: budget.settleCall,
        },
        settleResult: (reservationId, usage, result) => budget.settleCall(reservationId, usage,
          (receipt) => persistConsultationPaidResult(db, grant, receipt, usage, result)),
      });
      if (outcome.settled !== 'settled') return null;
      return finalizeConsultationPaidResult(db, requestId, grant.result_version, now().toISOString());
    } catch (error) {
      if (error instanceof Error && ['DENIED', 'NOT_FOUND', 'FORBIDDEN', 'BUDGET_EXHAUSTED'].includes(error.message)) return null;
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
