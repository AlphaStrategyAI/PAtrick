import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { routes, type Json } from '@patrick/contracts';
import { commandFingerprint, recordCommand, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import {
  type AnswerCommand,
  type AnswerGate,
  type CardAnswer,
  type Principal as AnswerPrincipal,
} from '../../../../packages/domain/src/answer-gate.js';
import { assertDomainPermission, snapshot, type Principal } from '../auth.js';
import { assertBusinessWrite } from '../recovery-runtime.js';
import { ApiError } from '../errors.js';
import { assertPayloadHash, assertWriteOrigin, handle, readJson, requirePermission, routeId } from './http.js';

type Ready = () => { db: SqliteDatabase; now: () => Date; gate: (domain: string) => AnswerGate };
type Envelope<T> = { client_request_id: string; expected_revision: number | null; payload_hash: string; payload: T };

const answerRequest = routeRequest('submitAnswer');

export function mountAnswerRoutes(app: Hono, ready: Ready): void {
  app.get('/api/v1/questions/:id', (c) => handle(c, () => readQuestion(c, ready)));
  app.post('/api/v1/questions/:id/answers', (c) => handle(c, () => postAnswer(c, ready)));
  app.get('/api/v1/answers/:receiptId', (c) => handle(c, () => readReceipt(c, ready)));
}

async function readQuestion(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'questions.read');
  const questionId = routeId(c.req.param('id'));
  const { db, now } = ready();
  const row = db.prepare(`SELECT question_id, question_version, work_id, generation, proposal_revision, options_hash,
    hub_card_id, status, successor_question_id, data_domain, account_id, options_json, custom_allowed
    FROM question_bindings WHERE question_id = ? AND account_id = ? ORDER BY question_version DESC LIMIT 1`).get(
    questionId,
    principal.account_id,
  ) as { data_domain: string; account_id: string; options_json: string; custom_allowed: 0 | 1 } | undefined;
  if (!row || !principal.domains.includes(row.data_domain)) throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  assertDomainPermission(db, principal, row.data_domain, 'questions.read');
  const { options_json, custom_allowed, ...binding } = row;
  const options = (JSON.parse(options_json) as {
    option_id: string;
    index: number;
    label: string;
    next_action?: string | null;
    difference?: string | null;
    missing?: string[];
  }[]).map(({ option_id, index, label, next_action, difference, missing }) => ({
    option_id,
    index,
    label,
    next_action: next_action ?? null,
    difference: difference ?? null,
    missing: missing ?? [],
  }));
  return c.json(snapshot({ ...principal, domains: [row.data_domain] }, { ...binding, options, custom_allowed: !!custom_allowed }, now(), db));
}

async function postAnswer(c: Context, ready: Ready): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requirePermission(c.req.raw, 'questions.answer');
  const parsed = answerRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as Envelope<{
    work_id: string;
    generation: number;
    question_id: string;
    question_version: number;
    proposal_revision: number;
    options_hash: string;
    answer: CardAnswer;
  }>;
  if (body.expected_revision === null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'expected_revision' });
  assertPayloadHash(body.payload as unknown as Json, body.payload_hash);
  const questionId = routeId(c.req.param('id'));
  if (questionId !== body.payload.question_id) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'question' });
  const { db, gate } = ready();
  const scope = db.prepare(`SELECT data_domain, account_id FROM question_bindings
    WHERE question_id = ? AND question_version = ?`).get(questionId, body.payload.question_version) as {
    data_domain: string;
    account_id: string;
  } | undefined;
  if (!scope || scope.account_id !== principal.account_id || !principal.domains.includes(scope.data_domain)) {
    throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  }
  assertDomainPermission(db, principal, scope.data_domain, 'questions.answer');
  const fingerprint = commandFingerprint({
    operation: 'submitAnswer',
    resource_id: questionId,
    data_domain: scope.data_domain,
    expected_revision: body.expected_revision,
    payload_hash: body.payload_hash,
  });
  const command: AnswerCommand = {
    client_request_id: body.client_request_id,
    expected_revision: body.expected_revision,
    payload_hash: body.payload_hash,
    entry: 'web',
    payload: body.payload,
  };
  let receipt;
  try {
    receipt = await gate(scope.data_domain).submitAnswer(asAnswerPrincipal(principal), command);
  } catch (error) {
    if (error instanceof Error && error.message === 'RECEIPT_LOST') throw new ApiError(503, 'UNAVAILABLE', { reason: 'receipt' }, true);
    if (error instanceof Error && error.message === 'CHANNEL_DENIED') throw new ApiError(403, 'FORBIDDEN', { reason: 'channel' });
    throw error;
  }
  const commandId = storeCommand(db, principal, {
    operation: 'submitAnswer',
    questionId, questionVersion: body.payload.question_version,
    resourceId: receipt.receipt_id,
    dataDomain: scope.data_domain,
    clientRequestId: body.client_request_id,
    expectedRevision: body.expected_revision,
    payloadHash: body.payload_hash,
    permission: 'questions.answer',
    fingerprint,
  });
  return c.json({ command_id: commandId, state: 'received', receipt_url: `/api/v1/answers/${receipt.receipt_id}` }, 202);
}

async function readReceipt(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'questions.read');
  const receiptId = routeId(c.req.param('receiptId'));
  const { db, now } = ready();
  const row = db.prepare(`SELECT receipt_id, intent_id, question_id, validity, disposition, reason_code, hub_answer_event_id,
    successor_question_id, difference, missing_json, data_domain, account_id
    FROM answer_receipts WHERE receipt_id = ?`).get(receiptId) as { data_domain: string; account_id: string } | undefined;
  if (!row || row.account_id !== principal.account_id || !principal.domains.includes(row.data_domain)) {
    throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  }
  assertDomainPermission(db, principal, row.data_domain, 'questions.read');
  return c.json(snapshot({ ...principal, domains: [row.data_domain] }, row, now(), db));
}

function asAnswerPrincipal(principal: Principal): AnswerPrincipal {
  return {
    account_id: principal.account_id,
    caller_id: principal.caller_id,
    auth_epoch: principal.auth_epoch,
    domains: principal.domains,
    operations: principal.operations,
  };
}

function storeCommand(db: SqliteDatabase, principal: Principal, input: {
  operation: string;
  questionId: string; questionVersion: number;
  resourceId: string;
  dataDomain: string;
  clientRequestId: string;
  expectedRevision: number | null;
  payloadHash: string;
  permission: string;
  fingerprint: string;
}): string {
  const commandId = randomUUID();
  return withImmediateTransaction(db, () => {
    const receipt = recordCommand(db, {
      account_id: principal.account_id,
      caller_id: principal.caller_id,
      client_request_id: input.clientRequestId,
      command_fingerprint: input.fingerprint,
      command_id: commandId,
    });
    if (receipt.created) {
      const question = db.prepare('SELECT data_domain FROM question_bindings WHERE question_id=? AND question_version=?')
        .get(input.questionId, input.questionVersion) as { data_domain: string };
      assertDomainPermission(db, principal, question.data_domain, input.permission);
      assertBusinessWrite(db, question.data_domain);
      if (question.data_domain !== input.dataDomain) throw new ApiError(409, 'CONFLICT', { reason: 'scope' });
      db.prepare(`INSERT INTO command_records (
        command_id, account_id, caller_id, operation, resource_id, data_domain, permission, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        receipt.command_id,
        principal.account_id,
        principal.caller_id,
        input.operation,
        input.resourceId,
        input.dataDomain,
        input.permission,
        new Date().toISOString(),
      );
    }
    return receipt.command_id;
  });
}

function routeRequest(operationId: string) {
  const route = routes.find((item) => item.operationId === operationId);
  if (!route) throw new Error(`ROUTE_MISSING:${operationId}`);
  return route.request;
}
