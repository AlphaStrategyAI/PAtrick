import type { BudgetReceipt, CallReservation, Usage } from '../../domain/src/budget.js';
import type { ConsultationGrant } from '../../domain/src/delegation.js';
import { dispatchPaidNext, hardBudgetAdmitted, type BillingBridge, type RouteProof } from '../harness/patrick-bridge.js';
import { evidenceSha256 } from './hash.js';
import { completedRun, parseTerminal } from './wrapper.js';
import type { ObservedProcess, ProbeRecord } from './types.js';

type ConsultationScope = { accountId: string; dataDomain: string };

export type ConsultationBackend = {
  scope: Readonly<ConsultationScope>;
  admission: ProbeRecord;
  route: RouteProof;
  routeId: string;
  amountMicros: number;
  send(input: {
    requestId: string;
    resultVersion: number;
    callId: string;
    reservationId: string;
    text: string;
  } & ConsultationScope): Promise<{ terminal: ObservedProcess; usage: Usage | null }>;
};

export function consultationBackendAdmitted(backend: ConsultationBackend): boolean {
  const { admission, route } = backend;
  return backend.scope.accountId.length > 0 && backend.scope.dataDomain.length > 0
    && admission.available && admission.status === 'verified'
    && admission.evidenceSha256 === evidenceSha256(admission.observation)
    && hardBudgetAdmitted(route) && (!route.perHttpAccounted || route.verifiedMaxSends === 1)
    && backend.routeId.length > 0 && Number.isSafeInteger(backend.amountMicros) && backend.amountMicros > 0;
}

export function consultationBackendMatches(backend: ConsultationBackend, scope: ConsultationScope): boolean {
  return backend.scope.accountId === scope.accountId && backend.scope.dataDomain === scope.dataDomain;
}

/** The admitted boundary performs the single paid call, only after T09 acquires its T08 permit. */
export async function runPaidConsultation(input: {
  backend: ConsultationBackend;
  grant: ConsultationGrant;
  scope: ConsultationScope;
  text: string;
  billing: BillingBridge;
  settleAnswer(reservationId: string, usage: Usage, text: string): Promise<BudgetReceipt>;
}) {
  const { backend, grant } = input;
  if (!consultationBackendAdmitted(backend) || !consultationBackendMatches(backend, input.scope)
    || !grant.allowed_domains.includes(input.scope.dataDomain)) throw new Error('CONSULTATION_BACKEND_BLOCKED');
  const callId = `consultation:${grant.request_id}`;
  const call: CallReservation = {
    businessId: callId,
    callId,
    grantId: grant.grant_id,
    attemptId: grant.attempt_id,
    routeId: backend.routeId,
    amountMicros: backend.amountMicros,
  };
  let answer: string | undefined;
  return dispatchPaidNext({
    call,
    route: backend.route,
    bridge: {
      reserveCall: (request) => input.billing.reserveCall(request),
      claimPaidDispatch: (...args) => input.billing.claimPaidDispatch(...args),
      settleCall: (reservationId, usage) => usage && answer
        ? input.settleAnswer(reservationId, usage, answer)
        : input.billing.settleCall(reservationId, usage),
    },
    network: {
      async send(permit) {
        try {
          const { terminal, usage } = await backend.send({
            ...input.scope, requestId: grant.request_id, resultVersion: grant.result_version,
            callId: permit.callId, reservationId: permit.reservationId, text: input.text,
          });
          const parsed = parseTerminal(backend.admission.backend, terminal.stdout);
          if (parsed.usage && parsed.answerText?.trim() && completedRun({
            closed: terminal.closed, drained: terminal.drained, exitCode: terminal.exitCode,
            finalCount: parsed.finalCount, completed: parsed.completed, outputsValid: parsed.outputsValid,
          })) answer = parsed.answerText;
          // A failed terminal may still carry actual proved usage; charge it without manufacturing an answer.
          const verifiedUsage = usage && usage.amount_micros === call.amountMicros && usage.proof.length > 0 && usage.usage_id.length > 0;
          return { usage: verifiedUsage ? usage : null };
        } catch {
          // The transport cannot prove where it stopped. Retain the reservation as uncertain.
          return { usage: null };
        }
      },
    },
  });
}
