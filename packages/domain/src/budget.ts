import { randomUUID } from 'node:crypto';
import { withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { dispatchAllowed, type AdmissionPrincipal } from './delegation.js';

export const RESERVE_BUDGET_SQL = `UPDATE business_budgets
SET held_micros = held_micros + @amount
WHERE business_id = @business_id AND @amount >= 0
  AND held_micros + spent_micros + @amount <= limit_micros
RETURNING held_micros;`;

export const CLAIM_DISPATCH_SQL = `UPDATE budget_reservations SET dispatched_at = @now
WHERE reservation_id = @reservation_id AND grant_id = @grant_id
  AND attempt_id = @attempt_id AND route_id = @route_id
  AND status = 'held' AND dispatched_at IS NULL
RETURNING reservation_id;`;

export type CallReservation = {
  businessId: string;
  grantId: string;
  attemptId: string;
  routeId: string;
  callId: string;
  amountMicros: number;
};

export type BudgetReceipt = {
  reservation_id: string;
  business_id: string;
  grant_id: string;
  attempt_id: string;
  route_id: string;
  call_id: string;
  amount_micros: number;
  status: 'held' | 'settled' | 'uncertain';
  held_micros: number;
  spent_micros: number;
  limit_micros: number;
  dispatched_at: string | null;
};

export type Usage = {
  usage_id: string;
  amount_micros: number;
  proof: string;
};

type ReservationRow = {
  reservation_id: string;
  business_id: string;
  grant_id: string;
  attempt_id: string;
  route_id: string;
  call_id: string;
  amount_micros: number;
  status: 'held' | 'settled' | 'uncertain';
  dispatched_at: string | null;
};

type BudgetOptions = {
  now?: () => Date;
};

export function createBudgetApi(db: SqliteDatabase, principal: AdmissionPrincipal, options: BudgetOptions = {}) {
  const now = options.now ?? (() => new Date());

  function stamp(): string {
    return now().toISOString();
  }

  return {
    async heldAmount(businessId: string): Promise<number> {
      const row = db.prepare('SELECT held_micros, account_id FROM business_budgets WHERE business_id = ?').get(businessId) as {
        held_micros: number;
        account_id: string;
      } | undefined;
      if (!row || row.account_id !== principal.account_id) throw new Error('NOT_FOUND');
      return row.held_micros;
    },

    async reserveCall(input: CallReservation): Promise<BudgetReceipt> {
      if (!Number.isInteger(input.amountMicros) || input.amountMicros < 0 || input.amountMicros > Number.MAX_SAFE_INTEGER) {
        throw new Error('UNPROCESSABLE');
      }
      return withImmediateTransaction(db, () => {
        const existing = db.prepare('SELECT * FROM budget_reservations WHERE business_id = ? AND call_id = ?').get(
          input.businessId,
          input.callId,
        ) as ReservationRow | undefined;
        if (existing) return receipt(db, existing);
        const budget = db.prepare('SELECT account_id FROM business_budgets WHERE business_id = ?').get(input.businessId) as {
          account_id: string;
        } | undefined;
        if (!budget || budget.account_id !== principal.account_id) throw new Error('NOT_FOUND');
        if (!dispatchAllowed(db, principal, stamp(), {
          grantId: input.grantId,
          attemptId: input.attemptId,
          businessId: input.businessId,
        })) {
          throw new Error('DENIED');
        }
        const updated = db.prepare(RESERVE_BUDGET_SQL).get({
          amount: input.amountMicros,
          business_id: input.businessId,
        }) as { held_micros: number } | undefined;
        if (!updated) throw new Error('BUDGET_EXHAUSTED');
        const reservationId = `res_${randomUUID()}`;
        const stamped = stamp();
        db.prepare(`INSERT INTO budget_reservations (
          reservation_id, business_id, grant_id, attempt_id, route_id, call_id, amount_micros, status, dispatched_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'held', NULL, ?, ?)`).run(
          reservationId,
          input.businessId,
          input.grantId,
          input.attemptId,
          input.routeId,
          input.callId,
          input.amountMicros,
          stamped,
          stamped,
        );
        const stored = db.prepare('SELECT * FROM budget_reservations WHERE reservation_id = ?').get(reservationId) as ReservationRow;
        return receipt(db, stored);
      });
    },

    async claimPaidDispatch(
      reservationId: string,
      grantId: string,
      attemptId: string,
      routeId: string,
    ): Promise<'acquired' | 'already_dispatched' | 'denied'> {
      return withImmediateTransaction(db, () => {
        const row = db.prepare('SELECT * FROM budget_reservations WHERE reservation_id = ?').get(reservationId) as ReservationRow | undefined;
        if (!row) return 'denied';
        if (row.grant_id !== grantId || row.attempt_id !== attemptId || row.route_id !== routeId) return 'denied';
        if (row.status !== 'held') return 'denied';
        if (row.dispatched_at) return 'already_dispatched';
        if (!dispatchAllowed(db, principal, stamp(), { grantId, attemptId, businessId: row.business_id })) return 'denied';
        const claimed = db.prepare(CLAIM_DISPATCH_SQL).get({
          now: stamp(),
          reservation_id: reservationId,
          grant_id: grantId,
          attempt_id: attemptId,
          route_id: routeId,
        }) as { reservation_id: string } | undefined;
        if (claimed) return 'acquired';
        const again = db.prepare('SELECT * FROM budget_reservations WHERE reservation_id = ?').get(reservationId) as ReservationRow | undefined;
        if (again?.dispatched_at && again.status === 'held' && again.grant_id === grantId && again.attempt_id === attemptId && again.route_id === routeId) {
          return 'already_dispatched';
        }
        return 'denied';
      });
    },

    async settleCall(reservationId: string, usage: Usage | null): Promise<BudgetReceipt> {
      return withImmediateTransaction(db, () => {
        const row = db.prepare('SELECT * FROM budget_reservations WHERE reservation_id = ?').get(reservationId) as ReservationRow | undefined;
        if (!row) throw new Error('NOT_FOUND');
        const budget = db.prepare('SELECT account_id FROM business_budgets WHERE business_id = ?').get(row.business_id) as {
          account_id: string;
        } | undefined;
        if (!budget || budget.account_id !== principal.account_id) throw new Error('FORBIDDEN');
        if (usage === null) {
          if (row.status === 'uncertain') return receipt(db, row);
          if (row.status !== 'held' || !row.dispatched_at) throw new Error('UNPROCESSABLE');
          db.prepare(`UPDATE budget_reservations SET status = 'uncertain', updated_at = ?
            WHERE reservation_id = ? AND status = 'held' AND dispatched_at IS NOT NULL`).run(stamp(), reservationId);
          const stored = db.prepare('SELECT * FROM budget_reservations WHERE reservation_id = ?').get(reservationId) as ReservationRow;
          return receipt(db, stored);
        }
        if (!Number.isInteger(usage.amount_micros) || usage.amount_micros !== row.amount_micros || usage.proof.length === 0) {
          throw new Error('UNPROCESSABLE');
        }
        if (row.status === 'settled') {
          const prior = db.prepare('SELECT usage_id, amount_micros, proof FROM usage_receipts WHERE reservation_id = ?').get(reservationId) as {
            usage_id: string;
            amount_micros: number;
            proof: string;
          } | undefined;
          if (prior && prior.usage_id === usage.usage_id && prior.proof === usage.proof && prior.amount_micros === usage.amount_micros) {
            return receipt(db, row);
          }
          throw new Error('CONFLICT');
        }
        if (row.status !== 'held' || !row.dispatched_at) throw new Error('UNPROCESSABLE');
        const stamped = stamp();
        const moved = db.prepare(`UPDATE business_budgets
          SET held_micros = held_micros - @amount, spent_micros = spent_micros + @amount, updated_at = @now
          WHERE business_id = @business_id AND held_micros >= @amount AND @amount >= 0
          RETURNING held_micros`).get({
          amount: usage.amount_micros,
          now: stamped,
          business_id: row.business_id,
        }) as { held_micros: number } | undefined;
        if (!moved) throw new Error('CONFLICT');
        db.prepare(`UPDATE budget_reservations SET status = 'settled', updated_at = ?
          WHERE reservation_id = ? AND status = 'held'`).run(stamped, reservationId);
        db.prepare(`INSERT INTO usage_receipts (usage_id, reservation_id, amount_micros, proof, created_at)
          VALUES (?, ?, ?, ?, ?)`).run(usage.usage_id, reservationId, usage.amount_micros, usage.proof, stamped);
        const stored = db.prepare('SELECT * FROM budget_reservations WHERE reservation_id = ?').get(reservationId) as ReservationRow;
        return receipt(db, stored);
      });
    },
  };
}

function receipt(db: SqliteDatabase, row: ReservationRow): BudgetReceipt {
  const budget = db.prepare('SELECT held_micros, spent_micros, limit_micros FROM business_budgets WHERE business_id = ?').get(row.business_id) as {
    held_micros: number;
    spent_micros: number;
    limit_micros: number;
  };
  return {
    reservation_id: row.reservation_id,
    business_id: row.business_id,
    grant_id: row.grant_id,
    attempt_id: row.attempt_id,
    route_id: row.route_id,
    call_id: row.call_id,
    amount_micros: row.amount_micros,
    status: row.status,
    held_micros: budget.held_micros,
    spent_micros: budget.spent_micros,
    limit_micros: budget.limit_micros,
    dispatched_at: row.dispatched_at,
  };
}
