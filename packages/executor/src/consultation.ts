import type { BudgetReceipt, CallReservation, Usage } from '../../domain/src/budget.js';
import type { ConsultationPaidTerminal } from '../../domain/src/consultations.js';
import type { ConsultationGrant } from '../../domain/src/delegation.js';
import { dispatchPaidNext, hardBudgetAdmitted, type BillingBridge, type RouteProof } from '../harness/patrick-bridge.js';
import { canonicalJson, evidenceSha256 } from './hash.js';
import { completedRun, parseTerminal } from './wrapper.js';
import type { BackendId, ObservedProcess, ProbeRecord } from './types.js';

type ConsultationScope = { accountId: string; dataDomain: string };

export type FixedConsultationQuoteTerms = Readonly<ConsultationScope & {
  backend: BackendId;
  admissionSha256: string;
  routeId: string;
  chargeMicros: number;
  providerQuoteRef: string;
}>;

export type FixedConsultationPricing = Readonly<{
  kind: 'fixed';
  terms: FixedConsultationQuoteTerms;
  evidenceSha256: string;
}>;

/** The digest binds the quote terms; deployment must independently verify the provider quote. */
export function fixedConsultationQuoteHash(terms: FixedConsultationQuoteTerms): string {
  return evidenceSha256(canonicalJson({ ...terms, kind: 'fixed' }));
}

export type ConsultationBackend = {
  scope: Readonly<ConsultationScope>;
  admission: ProbeRecord;
  route: RouteProof;
  routeId: string;
  pricing: FixedConsultationPricing;
  send(input: {
    requestId: string;
    resultVersion: number;
    callId: string;
    reservationId: string;
    text: string;
    fixedQuote: Readonly<{ chargeMicros: number; providerQuoteRef: string; evidenceSha256: string }>;
    signal: AbortSignal;
  } & ConsultationScope): Promise<{ terminal: ObservedProcess; usage: Usage | null }>;
};

export function consultationBackendAdmitted(backend: ConsultationBackend): boolean {
  const { admission, route, routeId, pricing, scope } = backend;
  const quote = pricing?.terms;
  return scope.accountId.length > 0 && scope.dataDomain.length > 0
    && admission.available && admission.status === 'verified'
    && admission.evidenceSha256 === evidenceSha256(admission.observation)
    && hardBudgetAdmitted(route) && (!route.perHttpAccounted || route.verifiedMaxSends === 1)
    && routeId.length > 0 && pricing?.kind === 'fixed' && !!quote
    && quote.accountId === scope.accountId && quote.dataDomain === scope.dataDomain
    && quote.backend === admission.backend && quote.admissionSha256 === admission.evidenceSha256
    && quote.routeId === routeId && Number.isSafeInteger(quote.chargeMicros) && quote.chargeMicros > 0
    && typeof quote.providerQuoteRef === 'string' && quote.providerQuoteRef.trim().length > 0
    && pricing.evidenceSha256 === fixedConsultationQuoteHash(quote);
}

export function consultationBackendMatches(backend: ConsultationBackend, scope: ConsultationScope): boolean {
  return backend.scope.accountId === scope.accountId && backend.scope.dataDomain === scope.dataDomain
    && consultationBackendAdmitted(backend);
}

/** The admitted boundary performs the single paid call, only after T09 acquires its T08 permit. */
export async function runPaidConsultation(input: {
  backend: ConsultationBackend;
  grant: ConsultationGrant;
  scope: ConsultationScope;
  text: string;
  billing: BillingBridge;
  signal: AbortSignal;
  settleResult(reservationId: string, usage: Usage, terminal: ConsultationPaidTerminal): Promise<BudgetReceipt>;
}) {
  const { backend, grant } = input;
  if (!consultationBackendMatches(backend, input.scope) || !grant.allowed_domains.includes(input.scope.dataDomain)) throw new Error('CONSULTATION_BACKEND_BLOCKED');
  const callId = `consultation:${grant.request_id}`;
  const fixedQuote = Object.freeze({
    chargeMicros: backend.pricing.terms.chargeMicros,
    providerQuoteRef: backend.pricing.terms.providerQuoteRef,
    evidenceSha256: backend.pricing.evidenceSha256,
  });
  const call: CallReservation = {
    businessId: callId,
    callId,
    grantId: grant.grant_id,
    attemptId: grant.attempt_id,
    routeId: backend.routeId,
    amountMicros: fixedQuote.chargeMicros,
  };
  let result: ConsultationPaidTerminal | undefined;
  let quotedReservation: string | undefined;
  return dispatchPaidNext({
    call,
    route: backend.route,
    bridge: {
      async reserveCall(request) {
        const receipt = await input.billing.reserveCall(request);
        // T08 returns an existing reservation on replay, even if the configured quote changed.
        if (receipt.amount_micros === request.amountMicros) quotedReservation = receipt.reservation_id;
        return receipt;
      },
      claimPaidDispatch: (...args) => args[0] === quotedReservation
        ? input.billing.claimPaidDispatch(...args) : Promise.resolve('denied'),
      settleCall: (reservationId, usage) => usage && result
        ? input.settleResult(reservationId, usage, result)
        : input.billing.settleCall(reservationId, usage),
    },
    network: {
      async send(permit) {
        try {
          const { terminal, usage } = await sendUntilAborted(backend, {
            ...input.scope, requestId: grant.request_id, resultVersion: grant.result_version,
            callId: permit.callId, reservationId: permit.reservationId, text: input.text, fixedQuote, signal: input.signal,
          });
          const verifiedUsage = usage && usage.amount_micros === call.amountMicros && usage.proof.length > 0 && usage.usage_id.length > 0;
          if (!verifiedUsage) return { usage: null };
          if (terminal.closed && terminal.drained && terminal.exitCode !== null
            && Number.isSafeInteger(terminal.exitCode) && terminal.exitCode !== 0) {
            result = { status: 'failed', exit_code: terminal.exitCode };
          } else {
            const parsed = parseTerminal(backend.admission.backend, terminal.stdout);
            if (parsed.usage && parsed.answerText?.trim() && completedRun({
              closed: terminal.closed, drained: terminal.drained, exitCode: terminal.exitCode,
              finalCount: parsed.finalCount, completed: parsed.completed, outputsValid: parsed.outputsValid,
            })) result = { status: 'answered', text: parsed.answerText };
          }
          return { usage };
        } catch {
          // The transport cannot prove where it stopped. Retain the reservation as uncertain.
          return { usage: null };
        }
      },
    },
  });
}

async function sendUntilAborted(backend: ConsultationBackend, input: Parameters<ConsultationBackend['send']>[0]) {
  const { signal } = input;
  signal.throwIfAborted();
  let cancel!: () => void;
  const aborted = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); });
  signal.addEventListener('abort', cancel, { once: true });
  try {
    return await Promise.race([backend.send(input), aborted]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
