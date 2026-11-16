import type { BudgetReceipt, CallReservation, Usage } from '../../domain/src/budget.js';

export const TOOL_NAME = 'patrick-bridge';

export type RouteProof = {
  sdkMaxRetries: number;
  implicitResend: boolean;
  perHttpAccounted: boolean;
  verifiedMaxSends: number | null;
};

export type BillingBridge = {
  reserveCall(input: CallReservation): Promise<BudgetReceipt>;
  claimPaidDispatch(
    reservationId: string,
    grantId: string,
    attemptId: string,
    routeId: string,
  ): Promise<'acquired' | 'already_dispatched' | 'denied'>;
  settleCall(reservationId: string, usage: Usage | null): Promise<BudgetReceipt>;
};

export type NetworkDouble = {
  send(item: { reservationId: string; callId: string }): Promise<{ usage: Usage | null }>;
};

export type PaidDispatch = {
  bridge: BillingBridge;
  call: CallReservation;
  route: RouteProof;
  network: NetworkDouble;
  crashBeforeSettle?: boolean;
};

export type PaidOutcome = {
  claim: 'acquired' | 'already_dispatched' | 'denied' | 'route_blocked';
  sent: boolean;
  reservationId: string | null;
  settled: 'settled' | 'uncertain' | 'none';
  outbound: number;
};

export function hardBudgetAdmitted(route: RouteProof): boolean {
  if (route.perHttpAccounted) return route.verifiedMaxSends !== null && route.verifiedMaxSends >= 1;
  return route.sdkMaxRetries === 0 && route.implicitResend === false;
}

export async function dispatchPaidNext(input: PaidDispatch): Promise<PaidOutcome> {
  if (!hardBudgetAdmitted(input.route)) {
    return { claim: 'route_blocked', sent: false, reservationId: null, settled: 'none', outbound: 0 };
  }
  const sends = input.route.perHttpAccounted ? input.route.verifiedMaxSends ?? 1 : 1;
  let lastClaim: PaidOutcome['claim'] = 'denied';
  let reservationId: string | null = null;
  let outbound = 0;
  let settled: PaidOutcome['settled'] = 'none';
  for (let index = 0; index < sends; index += 1) {
    const call = sends === 1 ? input.call : { ...input.call, callId: `${input.call.callId}#${index}` };
    const reservation = await input.bridge.reserveCall(call);
    reservationId = reservation.reservation_id;
    const claim = await input.bridge.claimPaidDispatch(reservation.reservation_id, call.grantId, call.attemptId, call.routeId);
    lastClaim = claim;
    if (claim !== 'acquired') continue;
    const response = await input.network.send({ reservationId: reservation.reservation_id, callId: call.callId });
    outbound += 1;
    if (input.crashBeforeSettle) {
      settled = 'none';
      continue;
    }
    if (response.usage === null) {
      await input.bridge.settleCall(reservation.reservation_id, null);
      settled = 'uncertain';
    } else {
      await input.bridge.settleCall(reservation.reservation_id, response.usage);
      settled = 'settled';
    }
  }
  return {
    claim: outbound > 0 ? 'acquired' : lastClaim,
    sent: outbound > 0,
    reservationId,
    settled,
    outbound,
  };
}
