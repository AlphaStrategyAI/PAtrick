import { createHash, randomUUID } from 'node:crypto';
import { canonicalPayload } from '@patrick/contracts';
import { assertRecoveryWriteAllowed, recoveryWriteAllowed, ackOutbox, appendDomainEvent, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import type { BudgetReceipt, Usage } from './budget.js';
import { createDelegationApi, type AdmissionPrincipal, type ConsultationGrant } from './delegation.js';

export const COMPLETE_CONSULTATION_SQL = `UPDATE consultations
SET status = 'answered', final_result = @answer, result_version = result_version + 1
WHERE request_id = @request_id AND result_version = @expected_revision
  AND status IN ('pending', 'waiting_user')
RETURNING result_version;`;

const CANCEL_CONSULTATION_SQL = `UPDATE consultations
SET status = 'cancelled', cancelled_at = @cancelled_at, updated_at = @updated_at, result_version = result_version + 1
WHERE request_id = @request_id AND result_version = @expected_revision
  AND status IN ('pending', 'waiting_user')
  AND account_id = @account_id AND caller_id = @caller_id AND data_domain = @data_domain
RETURNING result_version;`;

const CONSULTATION_BUDGET_MICROS = 5000;
const CONSULTATION_SEND_MICROS = 1000;
const DAY_MS = 86_400_000;

export type ConsultationStatus = 'pending' | 'waiting_user' | 'answered' | 'cancelled' | 'failed';

/** The partial answer is capped so a long run cannot grow the row without bound. */
const MAX_PARTIAL_TEXT = 8000;

export type ConsultationRequest = {
  client_request_id: string;
  text: string;
  data_domain: string;
  parent_work_id: string | null;
};

export type ConsultationAnswer = {
  text: string;
};

export type ConsultationReceipt = {
  request_id: string;
  result_version: number;
  status: ConsultationStatus;
  conversation_id: string;
  parent_work_id: string | null;
};

export type ConsultationView = ConsultationReceipt & {
  caller_id: string;
  final_result: ConsultationAnswer | null;
  /** The answer as it has been produced so far, while the consultation is still running. */
  partial_text: string;
};

export type ConversationReceipt = {
  conversation_id: string;
  work_id: string | null;
  revision: number;
};

export type ConversationMessage = {
  message_id: string;
  conversation_id: string;
  raw_text: string;
  role: 'user' | 'assistant';
  kind: string;
  result_version: number | null;
};

export type ConsultationDispatch = {
  businessId: string;
  grantId: string;
  attemptId: string;
  routeId: string;
  callId: string;
  amountMicros: number;
};

export type ConsultationDispatchResult = {
  sent: boolean;
  text: string;
  alreadyDispatched: boolean;
};

export type ConsultationBilling = {
  dispatch(input: ConsultationDispatch): Promise<ConsultationDispatchResult>;
};

export type ConsultationHubEvent = {
  event_id: string;
  root: string;
  cause: string;
  generation: number;
  hops: number;
  kind: 'consultation.requested';
  request_id: string;
};

export type ConsultationHubPort = {
  publish(event: ConsultationHubEvent, now: string): Promise<'accepted' | 'duplicate'>;
};

export type ConsultationRun = {
  sent: boolean;
  completed: boolean;
  grant: ConsultationGrant | null;
};

const CONSULTATION_PERMISSIONS = ['consultations.write', 'owner', 'mcp:consult'] as const;
type ConsultationPermission = (typeof CONSULTATION_PERMISSIONS)[number];

type ConsultationOptions = {
  now?: () => Date;
  knownAnswer?: (text: string) => ConsultationAnswer | null;
};

type ConsultationRow = {
  request_id: string;
  account_id: string;
  caller_id: string;
  data_domain: string;
  parent_work_id: string | null;
  result_version: number;
  status: ConsultationStatus;
  request_fingerprint: string | null;
  raw_text: string | null;
  final_result: string | null;
  conversation_id: string | null;
  partial_text: string | null;
};

type ConversationRow = {
  conversation_id: string;
  account_id: string;
  caller_id: string;
  data_domain: string;
  kind: 'work' | 'consultation';
  work_id: string | null;
  caller_request_id: string | null;
  request_fingerprint: string | null;
  revision: number;
};

export function createConsultationApi(db: SqliteDatabase, options: ConsultationOptions = {}) {
  const now = options.now ?? (() => new Date());

  function stamp(): string {
    return now().toISOString();
  }

  const api = {
    createConsultation(
      principal: AdmissionPrincipal,
      request: ConsultationRequest,
      authorizationPermission = CONSULTATION_PERMISSIONS.find((permission) => principal.operations.includes(permission)),
    ): ConsultationReceipt {
      assertRequest(principal, request);
      const fingerprint = requestFingerprint(request);
      const known = options.knownAnswer?.(request.text) ?? null;
      return withImmediateTransaction(db, () => {
        const existing = findConsultation(db, principal, request.client_request_id);
        if (existing) {
          if (existing.request_fingerprint !== fingerprint) throw new Error('CONFLICT');
          return receiptOf(existing);
        }
        if (request.parent_work_id && !visibleWork(db, principal, request.parent_work_id, request.data_domain)) {
          throw new Error('FORBIDDEN');
        }
        const stamped = stamp();
        assertRecoveryWriteAllowed(db, request.data_domain);
        const requestId = `req_${randomUUID()}`;
        const conversationId = insertConversation(db, principal, {
          kind: 'consultation',
          dataDomain: request.data_domain,
          clientRequestId: request.client_request_id,
          fingerprint,
          stamped,
        });
        insertMessage(db, {
          conversationId,
          accountId: principal.account_id,
          dataDomain: request.data_domain,
          role: 'user',
          kind: 'user_text',
          rawText: request.text,
          resultVersion: null,
          callerRequestId: request.client_request_id,
          stamped,
        });
        insertConsultation(db, principal, request, {
          requestId,
          conversationId,
          fingerprint,
          stamped,
        });
        insertConsultationBudget(db, principal, requestId, request.data_domain, stamped);
        if (known) {
          const completed = answerConsultation(db, requestId, 0, known, stamped);
          if (!completed) throw new Error('CONFLICT');
        } else {
          queueConsultation(db, principal, requestId, request.data_domain, authorizationPermission);
        }
        const stored = requireConsultation(db, requestId);
        return receiptOf(stored);
      });
    },

    async completeConsultation(requestId: string, version: number, answer: ConsultationAnswer): Promise<boolean> {
      return withImmediateTransaction(db, () => answerConsultation(db, requestId, version, answer, stamp()));
    },

    cancelConsultation(principal: AdmissionPrincipal, requestId: string, version: number): boolean {
      return withImmediateTransaction(db, () => {
        const row = loadConsultation(db, requestId);
        if (!row) return false;
        if (!owns(principal, row.account_id, row.caller_id, row.data_domain)) throw new Error('FORBIDDEN');
        const cancelled = db.prepare(CANCEL_CONSULTATION_SQL).get({
          cancelled_at: stamp(),
          updated_at: stamp(),
          request_id: requestId,
          expected_revision: version,
          account_id: principal.account_id,
          caller_id: principal.caller_id,
          data_domain: row.data_domain,
        }) as { result_version: number } | undefined;
        return Boolean(cancelled);
      });
    },

    readConsultation(principal: AdmissionPrincipal, requestId: string): ConsultationView {
      const row = loadConsultation(db, requestId);
      if (!row || !owns(principal, row.account_id, row.caller_id, row.data_domain)) throw new Error('FORBIDDEN');
      return viewOf(row);
    },

    async dispatchConsultation(requestId: string, hub: ConsultationHubPort): Promise<'accepted' | 'duplicate' | 'missing'> {
      const stored = db.prepare('SELECT payload FROM domain_events WHERE event_id = ?').get(`consultation.requested:${requestId}`) as {
        payload: string;
      } | undefined;
      if (!stored) return 'missing';
      const payload = JSON.parse(stored.payload) as {
        event_id: string;
        request_id: string;
        root: string;
        cause: string;
        generation: number;
        hops: number;
      };
      const stamped = stamp();
      const current = requireConsultation(db, requestId);
      assertRecoveryWriteAllowed(db, current.data_domain);
      return hub.publish({
        event_id: payload.event_id,
        root: payload.root,
        cause: payload.cause,
        generation: payload.generation,
        hops: payload.hops,
        kind: 'consultation.requested',
        request_id: payload.request_id,
      }, stamped);
    },

    async runConsultation(principal: AdmissionPrincipal, requestId: string, billing: ConsultationBilling): Promise<ConsultationRun> {
      const row = loadConsultation(db, requestId);
      if (!row || row.account_id !== principal.account_id) throw new Error('NOT_FOUND');
      if (!owns(principal, row.account_id, row.caller_id, row.data_domain)) throw new Error('FORBIDDEN');
      const delegation = createDelegationApi(db, principal, { now, domain: row.data_domain });
      let grant: ConsultationGrant;
      try {
        grant = await delegation.authorizeConsultation(requestId, `attempt:${requestId}`);
      } catch (error) {
        if (error instanceof Error && (error.message === 'DENIED' || error.message === 'NOT_FOUND')) {
          return { sent: false, completed: false, grant: null };
        }
        throw error;
      }
      assertRecoveryWriteAllowed(db, requireConsultation(db, requestId).data_domain);
      const businessId = `consultation:${requestId}`;
      const dispatched = await billing.dispatch({
        businessId,
        grantId: grant.grant_id,
        attemptId: grant.attempt_id,
        routeId: 'consultation',
        callId: businessId,
        amountMicros: CONSULTATION_SEND_MICROS,
      });
      const recoverable = dispatched.alreadyDispatched && dispatched.text.length > 0;
      if (!dispatched.sent && !recoverable) return { sent: false, completed: false, grant };
      const completed = await this.completeConsultation(requestId, grant.result_version, { text: dispatched.text });
      return { sent: dispatched.sent, completed, grant };
    },

    createConversation(principal: AdmissionPrincipal, request: {
      client_request_id: string;
      text: string;
      data_domain: string;
    }): ConversationReceipt {
      if (!principal.domains.includes(request.data_domain) || request.text.length === 0 || request.client_request_id.length === 0) {
        throw new Error('UNPROCESSABLE');
      }
      const fingerprint = createHash('sha256').update(canonicalPayload({
        data_domain: request.data_domain,
        text: request.text,
      })).digest('hex');
      return withImmediateTransaction(db, () => {
        const existing = findConversation(db, principal, request.client_request_id);
        if (existing) {
          if (existing.request_fingerprint !== fingerprint) throw new Error('CONFLICT');
          return { conversation_id: existing.conversation_id, work_id: existing.work_id, revision: existing.revision };
        }
        const stamped = stamp();
        assertRecoveryWriteAllowed(db, request.data_domain);
        const conversationId = insertConversation(db, principal, {
          kind: 'work',
          dataDomain: request.data_domain,
          clientRequestId: request.client_request_id,
          fingerprint,
          stamped,
        });
        insertMessage(db, {
          conversationId,
          accountId: principal.account_id,
          dataDomain: request.data_domain,
          role: 'user',
          kind: 'user_text',
          rawText: request.text,
          resultVersion: null,
          callerRequestId: request.client_request_id,
          stamped,
        });
        return { conversation_id: conversationId, work_id: null, revision: 0 };
      });
    },

    postMessage(principal: AdmissionPrincipal, conversationId: string, request: {
      client_request_id: string;
      text: string;
    }): ConversationMessage {
      if (request.text.length === 0 || request.client_request_id.length === 0) throw new Error('UNPROCESSABLE');
      return withImmediateTransaction(db, () => {
        const stamped = stamp();
        const conversation = requireOwnedConversation(db, principal, conversationId);
        const existing = db.prepare(`SELECT message_id, conversation_id, raw_text, role, kind, result_version
          FROM messages WHERE conversation_id = ? AND caller_request_id = ?`).get(conversationId, request.client_request_id) as ConversationMessage | undefined;
        if (existing) {
          if (existing.raw_text !== request.text) throw new Error('CONFLICT');
          return existing;
        }
        assertRecoveryWriteAllowed(db, conversation.data_domain);
        return insertMessage(db, {
          conversationId: conversation.conversation_id,
          accountId: principal.account_id,
          dataDomain: conversation.data_domain,
          role: 'user',
          kind: 'user_text',
          rawText: request.text,
          resultVersion: null,
          callerRequestId: request.client_request_id,
          stamped,
        });
      });
    },

    async listConversations(principal: AdmissionPrincipal): Promise<ConversationReceipt[]> {
      const rows = db.prepare(`SELECT conversation_id, work_id, revision, data_domain FROM conversations
        WHERE account_id = ? AND caller_id = ? ORDER BY created_at, conversation_id`).all(principal.account_id, principal.caller_id) as Array<{
        conversation_id: string;
        work_id: string | null;
        revision: number;
        data_domain: string;
      }>;
      return rows.filter((row) => principal.domains.includes(row.data_domain)).map((row) => ({
        conversation_id: row.conversation_id,
        work_id: row.work_id,
        revision: row.revision,
      }));
    },

    async listMessages(principal: AdmissionPrincipal, conversationId: string): Promise<ConversationMessage[]> {
      const conversation = requireOwnedConversation(db, principal, conversationId);
      return db.prepare(`SELECT message_id, conversation_id, raw_text, role, kind, result_version
        FROM messages WHERE conversation_id = ? AND account_id = ? AND data_domain = ?
        ORDER BY created_at, message_id`).all(conversation.conversation_id, principal.account_id, conversation.data_domain) as ConversationMessage[];
    },

    linkConversationWork(
      principal: AdmissionPrincipal,
      conversationId: string,
      workId: string,
      expectedRevision: number,
    ): ConversationReceipt {
      return withImmediateTransaction(db, () => {
        const stamped = stamp();
        const conversation = requireOwnedConversation(db, principal, conversationId);
        if (conversation.kind !== 'work') throw new Error('UNPROCESSABLE');
        if (conversation.work_id === workId) {
          return { conversation_id: conversation.conversation_id, work_id: workId, revision: conversation.revision };
        }
        if (conversation.work_id) throw new Error('CONFLICT');
        if (!visibleWork(db, principal, workId, conversation.data_domain)) throw new Error('FORBIDDEN');
        assertRecoveryWriteAllowed(db, conversation.data_domain);
        const updated = db.prepare(`UPDATE conversations
          SET work_id = @work_id, revision = revision + 1, updated_at = @updated_at
          WHERE conversation_id = @conversation_id AND revision = @expected_revision AND work_id IS NULL
            AND account_id = @account_id AND caller_id = @caller_id
          RETURNING revision`).get({
          work_id: workId,
          updated_at: stamped,
          conversation_id: conversation.conversation_id,
          expected_revision: expectedRevision,
          account_id: principal.account_id,
          caller_id: principal.caller_id,
        }) as { revision: number } | undefined;
        if (!updated) throw new Error('CONFLICT');
        return { conversation_id: conversation.conversation_id, work_id: workId, revision: updated.revision };
      });
    },
  };
  // HTTP callers compose these synchronous mutations with their command receipts.
  return {
    ...api,
    readConsultationSnapshot: api.readConsultation,
    mutations: {
      createConsultation: api.createConsultation,
      cancelConsultation: api.cancelConsultation,
      createConversation: api.createConversation,
      postMessage: api.postMessage,
      linkConversationWork: api.linkConversationWork,
    },
    async readConsultation(...args: Parameters<typeof api.readConsultation>) { return api.readConsultation(...args); },
    async createConsultation(...args: Parameters<typeof api.createConsultation>) { return api.createConsultation(...args); },
    async cancelConsultation(...args: Parameters<typeof api.cancelConsultation>) { return api.cancelConsultation(...args); },
    async createConversation(...args: Parameters<typeof api.createConversation>) { return api.createConversation(...args); },
    async postMessage(...args: Parameters<typeof api.postMessage>) { return api.postMessage(...args); },
    async linkConversationWork(...args: Parameters<typeof api.linkConversationWork>) { return api.linkConversationWork(...args); },
  };
}

const PAID_RESULT = 'consultation.paid_result';
const PAID_RESULT_DESTINATION = 'consultation-local';

export function consultationOutbox(db: SqliteDatabase, limit: number): string[] {
  const rows = db.prepare(`SELECT e.aggregate_id FROM outbox o JOIN domain_events e USING (event_id)
    WHERE o.destination = 'autoloop' AND o.result IS NULL
      AND e.event_id = 'consultation.requested:' || e.aggregate_id ORDER BY e.seq LIMIT ?`).all(limit) as { aggregate_id: string }[];
  return rows.map((row) => row.aggregate_id);
}

export function acknowledgeConsultationOutbox(
  db: SqliteDatabase, requestId: string, result: 'accepted' | 'duplicate',
): void {
  withImmediateTransaction(db, () => {
    const eventId = `consultation.requested:${requestId}`;
    const row = db.prepare(`SELECT o.result FROM outbox o JOIN hub_events h USING (event_id)
      WHERE o.event_id = ? AND o.destination = 'autoloop' AND h.request_id = ? AND h.kind = 'consultation.requested'`)
      .get(eventId, requestId) as { result: string | null } | undefined;
    if (!row) throw new Error('CONSULTATION_HUB_RECEIPT_MISSING');
    if (row.result === null) {
      assertRecoveryWriteAllowed(db, requireConsultation(db, requestId).data_domain);
      ackOutbox(db, eventId, 'autoloop', result);
    }
  });
}

export function consultationAwaitingHubReceipt(db: SqliteDatabase, requestId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM outbox WHERE event_id = ? AND destination = 'autoloop' AND result IS NULL")
    .get(`consultation.requested:${requestId}`));
}

export function admittedConsultation(db: SqliteDatabase, requestId: string, now: string) {
  const row = db.prepare(`SELECT c.raw_text, c.account_id, c.caller_id, c.data_domain, c.deadline_at, e.payload, a.auth_epoch
    FROM consultations c JOIN domain_events e ON e.event_id = 'consultation.requested:' || c.request_id
    JOIN accounts a ON a.account_id = c.account_id
    JOIN outbox o ON o.event_id = e.event_id AND o.destination = 'autoloop' AND o.result IS NOT NULL
    JOIN hub_events h ON h.event_id = e.event_id AND h.request_id = c.request_id AND h.kind = 'consultation.requested'
    WHERE c.request_id = ? AND c.raw_text IS NOT NULL AND c.status = 'pending'
      AND c.cancelled_at IS NULL AND c.deadline_at > ?
      AND c.account_id = e.account_id AND c.data_domain = e.data_domain`).get(requestId, now) as {
    raw_text: string; account_id: string; caller_id: string; data_domain: string; deadline_at: string; payload: string; auth_epoch: number;
  } | undefined;
  if (!row || !recoveryWriteAllowed(db, row.data_domain)) return null;
  let event: { type?: unknown; auth_epoch?: unknown; authorization_permission?: unknown } | null;
  try {
    event = JSON.parse(row.payload) as typeof event;
  } catch {
    return null;
  }
  const permission = CONSULTATION_PERMISSIONS.find((candidate) => candidate === event?.authorization_permission);
  if (event?.type !== 'consultation.requested' || event.auth_epoch !== row.auth_epoch || !permission) return null;
  const active = db.prepare(`SELECT 1 FROM caller_scopes
    WHERE account_id = ? AND caller_id = ? AND data_domain = ? AND permission = ? AND revoked_at IS NULL`)
    .get(row.account_id, row.caller_id, row.data_domain, permission);
  if (!active) return null;
  const principal: AdmissionPrincipal = {
    account_id: row.account_id, caller_id: row.caller_id, auth_epoch: row.auth_epoch,
    domains: [row.data_domain], operations: [permission],
  };
  return { principal, text: row.raw_text, domain: row.data_domain, deadlineAt: row.deadline_at };
}

export type ConsultationPaidTerminal =
  | { status: 'answered'; text: string }
  | { status: 'failed'; exit_code: number };

type PaidResult = {
  type: typeof PAID_RESULT;
  request_id: string;
  result_version: number;
  call_id: string;
  reservation_id: string;
  usage_id: string;
} & (ConsultationPaidTerminal | { status?: undefined; text: string });

function validTerminal(terminal: ConsultationPaidTerminal | { status?: undefined; text: string }): boolean {
  if (terminal.status === 'failed') return Number.isSafeInteger(terminal.exit_code) && terminal.exit_code !== 0;
  return (terminal.status === undefined || terminal.status === 'answered')
    && typeof terminal.text === 'string' && Boolean(terminal.text.trim());
}

export function persistConsultationPaidResult(
  db: SqliteDatabase, grant: ConsultationGrant, receipt: BudgetReceipt, usage: Usage, result: ConsultationPaidTerminal,
): void {
  if (!db.inTransaction) throw new Error('CONSULTATION_SETTLEMENT_REQUIRED');
  const row = requireConsultation(db, grant.request_id);
  const callId = `consultation:${grant.request_id}`;
  if (receipt.business_id !== callId || receipt.call_id !== callId || receipt.grant_id !== grant.grant_id
    || receipt.attempt_id !== grant.attempt_id || receipt.status !== 'settled' || !receipt.dispatched_at
    || !validTerminal(result)) throw new Error('CONSULTATION_RECEIPT_MISMATCH');
  const eventId = paidResultEventId(grant.request_id, grant.result_version);
  const payload: PaidResult = {
    type: PAID_RESULT, request_id: grant.request_id, result_version: grant.result_version,
    call_id: callId, reservation_id: receipt.reservation_id, usage_id: usage.usage_id, ...result,
  };
  appendDomainEvent(db, {
    eventId, aggregateId: grant.request_id, aggregateVersion: grant.result_version, accountId: row.account_id,
    dataDomain: row.data_domain, causationId: `consultation.requested:${grant.request_id}`,
    payload, destination: PAID_RESULT_DESTINATION,
  });
  ackOutbox(db, eventId, PAID_RESULT_DESTINATION, 'accepted');
}

function paidResultEventId(requestId: string, version: number): string {
  return `${PAID_RESULT}:${requestId}:${version}`;
}

export function finalizeConsultationPaidResult(
  db: SqliteDatabase, requestId: string, version: number, now: string,
): ConsultationPaidTerminal['status'] | null {
  return withImmediateTransaction(db, () => {
    const callId = `consultation:${requestId}`;
    const result = db.prepare(`SELECT e.payload, r.reservation_id, u.usage_id FROM domain_events e
      JOIN consultations c ON c.request_id = e.aggregate_id AND c.account_id = e.account_id AND c.data_domain = e.data_domain
      JOIN execution_grants g ON g.request_id = c.request_id AND g.subject_kind = 'consultation'
        AND g.result_version = e.aggregate_version AND g.account_id = c.account_id
        AND g.caller_id = c.caller_id AND g.data_domain = c.data_domain
      JOIN budget_reservations r ON r.grant_id = g.grant_id AND r.attempt_id = g.attempt_id
      JOIN usage_receipts u ON u.reservation_id = r.reservation_id AND u.amount_micros = r.amount_micros
      WHERE e.event_id = ? AND e.aggregate_id = ? AND e.aggregate_version = ?
        AND r.business_id = ? AND r.call_id = ? AND r.status = 'settled' AND r.dispatched_at IS NOT NULL AND length(u.proof) > 0`)
      .get(paidResultEventId(requestId, version), requestId, version, callId, callId) as {
      payload: string; reservation_id: string; usage_id: string;
    } | undefined;
    if (!result) return null;
    const payload = JSON.parse(result.payload) as PaidResult;
    if (payload.type !== PAID_RESULT || payload.request_id !== requestId || payload.result_version !== version
      || payload.call_id !== callId || payload.reservation_id !== result.reservation_id
      || payload.usage_id !== result.usage_id || !validTerminal(payload)) return null;
    if (payload.status === 'failed') {
      const updated = db.prepare(`UPDATE consultations SET status = 'failed', result_version = result_version + 1, updated_at = ?
        WHERE request_id = ? AND result_version = ? AND status IN ('pending', 'waiting_user')`)
        .run(now, requestId, version);
      if (updated.changes === 1) return 'failed';
      const row = requireConsultation(db, requestId);
      return row.status === 'failed' && row.result_version === version + 1 ? 'failed' : null;
    }
    if (answerConsultation(db, requestId, version, { text: payload.text }, now)) return 'answered';
    const row = requireConsultation(db, requestId);
    return row.status === 'answered' && row.result_version === version + 1
      && row.final_result === canonicalPayload({ text: payload.text }) ? 'answered' : null;
  });
}

export function recoverConsultationPaidResults(db: SqliteDatabase, now: string, limit: number): void {
  const rows = db.prepare(`SELECT c.request_id, c.result_version FROM consultations c
    JOIN domain_events e ON e.event_id = 'consultation.paid_result:' || c.request_id || ':' || c.result_version
    WHERE c.status = 'pending' ORDER BY e.seq LIMIT ?`).all(limit) as { request_id: string; result_version: number }[];
  for (const row of rows) finalizeConsultationPaidResult(db, row.request_id, row.result_version, now);
}

function answerConsultation(db: SqliteDatabase, requestId: string, version: number, answer: ConsultationAnswer, stamped: string): boolean {
  const stored = canonicalPayload({ text: answer.text });
  const current = loadConsultation(db, requestId);
  if (!current) return false;
  if (current.result_version !== version || !['pending', 'waiting_user'].includes(current.status)) return false;
  assertRecoveryWriteAllowed(db, current.data_domain);
  const updated = db.prepare(COMPLETE_CONSULTATION_SQL).get({
    answer: stored,
    request_id: requestId,
    expected_revision: version,
  }) as { result_version: number } | undefined;
  if (!updated) return false;
  const row = requireConsultation(db, requestId);
  db.prepare('UPDATE consultations SET updated_at = ? WHERE request_id = ?').run(stamped, requestId);
  if (!row.conversation_id) throw new Error('UNPROCESSABLE');
  insertMessage(db, {
    conversationId: row.conversation_id,
    accountId: row.account_id,
    dataDomain: row.data_domain,
    role: 'assistant',
    kind: 'final_answer',
    rawText: answer.text,
    resultVersion: updated.result_version,
    callerRequestId: null,
    stamped,
  });
  return true;
}

function queueConsultation(
  db: SqliteDatabase,
  principal: AdmissionPrincipal,
  requestId: string,
  dataDomain: string,
  authorizationPermission: ConsultationPermission | undefined,
): void {
  const eventId = `consultation.requested:${requestId}`;
  appendDomainEvent(db, {
    eventId,
    aggregateId: requestId,
    aggregateVersion: 0,
    accountId: principal.account_id,
    dataDomain,
    payload: {
      type: 'consultation.requested',
      event_id: eventId,
      request_id: requestId,
      auth_epoch: principal.auth_epoch,
      authorization_permission: authorizationPermission ?? null,
      root: requestId,
      cause: requestId,
      generation: 0,
      hops: 0,
    },
    destination: 'autoloop',
  });
}

function insertConsultation(
  db: SqliteDatabase,
  principal: AdmissionPrincipal,
  request: ConsultationRequest,
  input: { requestId: string; conversationId: string; fingerprint: string; stamped: string },
): void {
  const deadline = new Date(nowMillis(input.stamped) + DAY_MS).toISOString();
  db.prepare(`INSERT INTO consultations (
    request_id, account_id, caller_id, data_domain, parent_work_id, result_version, status, domains_json, tools_json,
    deadline_at, budget_micros, permission_revision, cancelled_at, schema_version, created_at, updated_at,
    caller_request_id, request_fingerprint, raw_text, final_result, conversation_id
  ) VALUES (?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?, ?, 0, NULL, '1.0', ?, ?, ?, ?, ?, NULL, ?)`).run(
    input.requestId,
    principal.account_id,
    principal.caller_id,
    request.data_domain,
    request.parent_work_id,
    JSON.stringify([request.data_domain]),
    JSON.stringify(['patrick_memory_query']),
    deadline,
    CONSULTATION_BUDGET_MICROS,
    input.stamped,
    input.stamped,
    request.client_request_id,
    input.fingerprint,
    request.text,
    input.conversationId,
  );
}

function insertConsultationBudget(db: SqliteDatabase, principal: AdmissionPrincipal, requestId: string, dataDomain: string, stamped: string): void {
  db.prepare(`INSERT INTO business_budgets (
    business_id, account_id, data_domain, subject_kind, limit_micros, held_micros, spent_micros, schema_version, created_at, updated_at
  ) VALUES (?, ?, ?, 'consultation', ?, 0, 0, '1.0', ?, ?)`).run(
    `consultation:${requestId}`,
    principal.account_id,
    dataDomain,
    CONSULTATION_BUDGET_MICROS,
    stamped,
    stamped,
  );
}

function insertConversation(db: SqliteDatabase, principal: AdmissionPrincipal, input: {
  kind: 'work' | 'consultation';
  dataDomain: string;
  clientRequestId: string;
  fingerprint: string;
  stamped: string;
}): string {
  const conversationId = `conv_${randomUUID()}`;
  db.prepare(`INSERT INTO conversations (
    conversation_id, account_id, caller_id, data_domain, kind, origin, work_id, context_ref, return_to,
    caller_request_id, request_fingerprint, revision, schema_version, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, 0, '1.0', ?, ?)`).run(
    conversationId,
    principal.account_id,
    principal.caller_id,
    input.dataDomain,
    input.kind,
    principal.caller_id,
    input.clientRequestId,
    input.fingerprint,
    input.stamped,
    input.stamped,
  );
  return conversationId;
}

function insertMessage(db: SqliteDatabase, input: {
  conversationId: string;
  accountId: string;
  dataDomain: string;
  role: 'user' | 'assistant';
  kind: ConversationMessage['kind'];
  rawText: string;
  resultVersion: number | null;
  callerRequestId: string | null;
  stamped: string;
}): ConversationMessage {
  const messageId = `msg_${randomUUID()}`;
  db.prepare(`INSERT INTO messages (
    message_id, conversation_id, account_id, data_domain, work_id, role, kind, raw_text, source_revision, result_version,
    caller_request_id, schema_version, created_at
  ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, '1.0', ?)`).run(
    messageId,
    input.conversationId,
    input.accountId,
    input.dataDomain,
    input.role,
    input.kind,
    input.rawText,
    input.resultVersion,
    input.callerRequestId,
    input.stamped,
  );
  return {
    message_id: messageId,
    conversation_id: input.conversationId,
    raw_text: input.rawText,
    role: input.role,
    kind: input.kind,
    result_version: input.resultVersion,
  };
}

function assertRequest(principal: AdmissionPrincipal, request: ConsultationRequest): void {
  if (!principal.domains.includes(request.data_domain) || request.text.length === 0 || request.client_request_id.length === 0) {
    throw new Error('UNPROCESSABLE');
  }
}

function requestFingerprint(request: ConsultationRequest): string {
  return createHash('sha256').update(canonicalPayload({
    data_domain: request.data_domain,
    parent_work_id: request.parent_work_id,
    text: request.text,
  })).digest('hex');
}

function owns(principal: AdmissionPrincipal, accountId: string, callerId: string, dataDomain: string): boolean {
  return principal.account_id === accountId && principal.caller_id === callerId && principal.domains.includes(dataDomain);
}

function visibleWork(db: SqliteDatabase, principal: AdmissionPrincipal, workId: string, dataDomain: string): boolean {
  const row = db.prepare(`SELECT work_id FROM work_generations
    WHERE work_id = ? AND account_id = ? AND data_domain = ? LIMIT 1`).get(workId, principal.account_id, dataDomain);
  return Boolean(row);
}

function findConsultation(db: SqliteDatabase, principal: AdmissionPrincipal, clientRequestId: string): ConsultationRow | undefined {
  return db.prepare(`SELECT request_id, account_id, caller_id, data_domain, parent_work_id, result_version, status,
    request_fingerprint, raw_text, final_result, conversation_id, partial_text
    FROM consultations WHERE account_id = ? AND caller_id = ? AND caller_request_id = ?`).get(
    principal.account_id,
    principal.caller_id,
    clientRequestId,
  ) as ConsultationRow | undefined;
}

function loadConsultation(db: SqliteDatabase, requestId: string): ConsultationRow | undefined {
  return db.prepare(`SELECT request_id, account_id, caller_id, data_domain, parent_work_id, result_version, status,
    request_fingerprint, raw_text, final_result, conversation_id, partial_text
    FROM consultations WHERE request_id = ?`).get(requestId) as ConsultationRow | undefined;
}

function requireConsultation(db: SqliteDatabase, requestId: string): ConsultationRow {
  const row = loadConsultation(db, requestId);
  if (!row || !row.conversation_id) throw new Error('NOT_FOUND');
  return row;
}

function findConversation(db: SqliteDatabase, principal: AdmissionPrincipal, clientRequestId: string): ConversationRow | undefined {
  return db.prepare(`SELECT conversation_id, account_id, caller_id, data_domain, kind, work_id, caller_request_id,
    request_fingerprint, revision FROM conversations
    WHERE account_id = ? AND caller_id = ? AND caller_request_id = ?`).get(
    principal.account_id,
    principal.caller_id,
    clientRequestId,
  ) as ConversationRow | undefined;
}

function requireOwnedConversation(db: SqliteDatabase, principal: AdmissionPrincipal, conversationId: string): ConversationRow {
  const row = db.prepare(`SELECT conversation_id, account_id, caller_id, data_domain, kind, work_id, caller_request_id,
    request_fingerprint, revision FROM conversations WHERE conversation_id = ?`).get(conversationId) as ConversationRow | undefined;
  if (!row || !owns(principal, row.account_id, row.caller_id, row.data_domain)) throw new Error('FORBIDDEN');
  return row;
}

function receiptOf(row: ConsultationRow): ConsultationReceipt {
  if (!row.conversation_id) throw new Error('NOT_FOUND');
  return {
    request_id: row.request_id,
    result_version: row.result_version,
    status: row.status,
    conversation_id: row.conversation_id,
    parent_work_id: row.parent_work_id,
  };
}

function viewOf(row: ConsultationRow): ConsultationView {
  return {
    ...receiptOf(row),
    caller_id: row.caller_id,
    final_result: parseAnswer(row.final_result),
    partial_text: row.partial_text ?? '',
  };
}

/** Records the answer produced so far, so the owner can read it while it runs.
 *
 * Only a pending consultation accepts a partial answer. The text is capped so a
 * long run cannot grow the row without bound, and the final answer always wins:
 * once the result is persisted the partial text is cleared.
 */
export function recordConsultationPartial(db: SqliteDatabase, requestId: string, text: string, at: string): void {
  const row = loadConsultation(db, requestId);
  if (!row) throw new Error('NOT_FOUND');
  if (row.status !== 'pending') return;
  const capped = text.slice(0, MAX_PARTIAL_TEXT);
  if (capped === (row.partial_text ?? '')) return;
  db.prepare('UPDATE consultations SET partial_text = ?, partial_updated_at = ? WHERE request_id = ? AND status = ?')
    .run(capped, at, requestId, 'pending');
}

function parseAnswer(value: string | null): ConsultationAnswer | null {
  if (!value) return null;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || !('text' in parsed) || typeof parsed.text !== 'string') return null;
  return { text: parsed.text };
}

function nowMillis(iso: string): number {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) throw new Error('UNPROCESSABLE');
  return parsed;
}
