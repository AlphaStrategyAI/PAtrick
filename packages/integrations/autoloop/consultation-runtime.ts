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
const HUB_TIMEOUT_MS = 5000;
const EXECUTION_TIMEOUT_MS = 10 * 60_000;
// The dedicated Hub worker key may recover this same outstanding claim after a service restart.
const CLAIM_ID = 'patrick-consultation-service-v1';

export type ConsultationWorkerOptions = {
  hub: Pick<HubClient, 'postEvent' | 'eventOutcome' | 'claim' | 'heartbeat' | 'result'>;
  backend?: ConsultationBackend;
  signal?: AbortSignal;
  intervalMs?: number;
  hubTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  executionTimeoutMs?: number;
  onError?: (error: unknown) => void;
};

export function startConsultationWorker(
  db: SqliteDatabase, now: () => Date, options: ConsultationWorkerOptions, credentials: CredentialStore,
) {
  const stop = new AbortController();
  options = { ...options, signal: options.signal ? AbortSignal.any([stop.signal, options.signal]) : stop.signal };
  const pending = new Set<Promise<unknown>>();
  const errors: Array<{ code: string }> = [];
  function track<T>(task: Promise<T>): Promise<T> {
    pending.add(task);
    void task.then(() => pending.delete(task), () => {
      pending.delete(task);
      if (errors.length < 16) errors.push({ code: 'ASYNC_TASK_FAILED' });
    });
    return task;
  }
  async function join() { while (pending.size) await Promise.allSettled([...pending]); }

  const interval = options.intervalMs ?? 1000;
  const heartbeatInterval = options.heartbeatIntervalMs ?? HEARTBEAT_MS;
  const hubTimeout = options.hubTimeoutMs ?? HUB_TIMEOUT_MS;
  const executionTimeout = options.executionTimeoutMs ?? EXECUTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(heartbeatInterval) || heartbeatInterval < 1 || heartbeatInterval > 60_000
    || !Number.isSafeInteger(hubTimeout) || hubTimeout < 1 || hubTimeout > HUB_TIMEOUT_MS
    || !Number.isSafeInteger(executionTimeout) || executionTimeout < 1 || executionTimeout > EXECUTION_TIMEOUT_MS) {
    throw new Error('CONSULTATION_WORKER_TIMEOUT_INVALID');
  }
  const hub: ConsultationWorkerOptions['hub'] = {
    postEvent: (body, phase) => request((signal) => options.hub.postEvent(body, signal), phase),
    eventOutcome: (event, phase) => request((signal) => options.hub.eventOutcome(event, signal), phase),
    claim: (id, phase) => request((signal) => options.hub.claim(id, signal), phase),
    heartbeat: (id, run, phase) => request((signal) => options.hub.heartbeat(id, run, signal), phase),
    result: (run, token, body, phase) => request((signal) => options.hub.result(run, token, body, signal), phase),
  };
  const routing = createConsultationRouting(db, hub, now);
  const receipts = createConsultationHubReceipts(db, credentials, hub);
  let timeout: NodeJS.Timeout | undefined;
  options.signal?.addEventListener('abort', () => clearTimeout(timeout), { once: true });

  function combinedDeadline(milliseconds: number, phase?: AbortSignal): AbortSignal {
    const signals = [AbortSignal.timeout(milliseconds)];
    if (options.signal) signals.push(options.signal);
    if (phase) signals.push(phase);
    return AbortSignal.any(signals);
  }

  async function request<T>(start: (signal: AbortSignal) => Promise<T>, phase?: AbortSignal): Promise<T> {
    const signal = combinedDeadline(hubTimeout, phase);
    signal.throwIfAborted();
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); });
    signal.addEventListener('abort', abort, { once: true });
    try {
      return await Promise.race([track(Promise.resolve().then(() => {
        signal.throwIfAborted();
        return start(signal);
      })), stopped]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  async function tick() {
    if (options.signal?.aborted) return;
    // Local completion is independent of both the Hub lease and the current send grant.
    recoverConsultationPaidResults(db, now().toISOString(), BATCH);
    await receipts.recover(BATCH, report, combinedDeadline(2 * hubTimeout));
    await routing.drain(BATCH, combinedDeadline(2 * hubTimeout), report);
    const configuredBackend = options.backend;
    const backend = configuredBackend && { ...configuredBackend,
      send: (input: Parameters<ConsultationBackend['send']>[0]) => track(configuredBackend.send(input)),
    };
    if (options.signal?.aborted || !backend || !consultationBackendAdmitted(backend)) return;
    // The same slot is recovered after restart or an ambiguous claim response. Once a result
    // is staged, the next slot is deterministic and the old run can be replayed independently.
    const stagedRun = receipts.lastStagedRun();
    const claimedAs = stagedRun === null ? CLAIM_ID : `${CLAIM_ID}:${stagedRun}`;
    const job = await hub.claim(claimedAs);
    if (!job || options.signal?.aborted) return;
    if (job.rule.name !== CONSULTATION_RULE) throw new Error('CONSULTATION_WORKER_KEY_SCOPE');
    const requestId = consultationRequestForJob(job);
    const cancelled = job.cancelled ? { outcome: 'cancelled' as const, summary: 'consultation run cancelled in Hub' } : null;
    if (!cancelled && requestId && consultationAwaitingHubReceipt(db, requestId)) return;
    const binding = requestId ? receipts.bind(requestId, job) : null;
    if (!requestId || !binding) {
      await hub.result(job.run, job.token, cancelled ?? consultationHubResult(null));
      return;
    }
    if (receipts.hasStaged(binding)) return; // Recovery owns the exact payload.
    async function submit(bound: NonNullable<typeof binding>, result: Parameters<HubClient['result']>[2]) {
      const deliveryId = receipts.stage(bound, result);
      await receipts.sendStaged(deliveryId);
    }
    if (cancelled) {
      await submit(binding, cancelled);
      return;
    }
    const requestedAt = now();
    const admitted = admittedConsultation(db, requestId, requestedAt.toISOString());
    if (admitted && !consultationBackendMatches(backend, { accountId: admitted.principal.account_id, dataDomain: admitted.domain })) {
      await submit(binding, deferConsultationScope(requestId, requestedAt, admitted.deadlineAt));
      return;
    }
    const finished = await withLease(job, claimedAs, (signal) => execute(requestId, backend, signal));
    if (options.signal?.aborted) return;
    await submit(binding, consultationHubResult(finished));
  }

  async function withLease<T>(job: HubJob, claimedAs: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const stop = new AbortController();
    const signals = [stop.signal, AbortSignal.timeout(executionTimeout)];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    const lease = track(keepLease(job.run, claimedAs, signal, stop)).catch((error: unknown) => {
      if (!signal.aborted) report(error);
    });
    try {
      return await run(signal);
    } finally {
      stop.abort();
      await lease;
    }
  }

  async function keepLease(run: number, claimedAs: string, signal: AbortSignal, stop: AbortController): Promise<void> {
    while (!signal.aborted) {
      await delay(heartbeatInterval, undefined, { signal, ref: false });
      try {
        const cancelled = await hub.heartbeat(claimedAs, run, signal);
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
    const admitted = admittedConsultation(db, requestId, now().toISOString());
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
            () => !signal.aborted && admittedConsultation(db, requestId, now().toISOString()) !== null),
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
    if (options.signal?.aborted) return;
    if (options.onError) { try { options.onError(error); } catch { /* Reporting cannot reject scheduling cleanup. */ } }
    else process.emitWarning('Consultation worker could not finish a polling step', { code: 'CONSULTATION_WORKER' });
  }

  function schedule(delay: number) {
    if (options.signal?.aborted) return;
    timeout = setTimeout(() => {
      void track(tick()).catch(report).finally(() => schedule(interval));
    }, delay);
    timeout.unref();
  }

  schedule(0);
  return { stop() { stop.abort(); }, join, errors, get active() { return pending.size; } };
}
