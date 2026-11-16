import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { routes, type Json } from '@patrick/contracts';
import { commandFingerprint, recordCommand, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { createConsultationApi } from '../../../../packages/domain/src/consultations.js';
import { type AdmissionPrincipal } from '../../../../packages/domain/src/delegation.js';
import { snapshot, type Principal } from '../auth.js';
import { ApiError } from '../errors.js';
import { assertPayloadHash, assertWriteOrigin, handle, readJson, requirePermission, routeId } from './http.js';

type Ready = () => { db: SqliteDatabase; now: () => Date };
type Envelope<T> = { client_request_id: string; expected_revision: number | null; payload_hash: string; payload: T };

const createRequest = routeRequest('createConversation');
const messageRequest = routeRequest('postMessage');
const linkRequest = routeRequest('linkConversationWork');

export function mountConversationRoutes(app: Hono, ready: Ready): void {
  app.get('/api/v1/conversations', (c) => handle(c, () => listConversations(c, ready)));
  app.post('/api/v1/conversations', (c) => handle(c, () => postConversation(c, ready)));
  app.get('/api/v1/conversations/:id/messages', (c) => handle(c, () => listMessages(c, ready)));
  app.post('/api/v1/conversations/:id/messages', (c) => handle(c, () => postMessage(c, ready)));
  app.post('/api/v1/conversations/:id/work-links', (c) => handle(c, () => linkWork(c, ready)));
}

async function listConversations(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'conversations.read');
  const { db, now } = ready();
  const items = await createConsultationApi(db, { now }).listConversations(asAdmission(principal));
  return c.json(snapshot(principal, { items }, now(), db));
}

async function postConversation(c: Context, ready: Ready): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requirePermission(c.req.raw, 'conversations.write');
  const parsed = createRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as Envelope<{ text: string }>;
  if (body.expected_revision !== null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'expected_revision' });
  assertPayloadHash(body.payload as unknown as Json, body.payload_hash);
  const domain = principal.domains[0];
  if (!domain) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'domain' });
  const { db, now } = ready();
  const api = createConsultationApi(db, { now });
  const prior = priorCommand(db, principal, body.client_request_id);
  if (prior) return replay(c, prior, 'createConversation', null, body.payload_hash, `/api/v1/conversations/${prior.resource_id}/messages`);
  const receipt = await api.createConversation(asAdmission(principal), {
    client_request_id: body.client_request_id,
    text: body.payload.text,
    data_domain: domain,
  });
  const commandId = storeCommand(db, principal, commandInput({
    operation: 'createConversation',
    resourceId: receipt.conversation_id,
    dataDomain: domain,
    clientRequestId: body.client_request_id,
    expectedRevision: null,
    payloadHash: body.payload_hash,
    permission: 'conversations.write',
  }));
  return c.json(accepted(commandId, `/api/v1/conversations/${receipt.conversation_id}/messages`), 202);
}

async function listMessages(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'conversations.read');
  const conversationId = routeId(c.req.param('id'));
  const { db, now } = ready();
  const items = await createConsultationApi(db, { now }).listMessages(asAdmission(principal), conversationId);
  return c.json(snapshot(principal, { items }, now(), db));
}

async function postMessage(c: Context, ready: Ready): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requirePermission(c.req.raw, 'conversations.write');
  const parsed = messageRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as Envelope<{ text: string }>;
  if (body.expected_revision !== null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'expected_revision' });
  assertPayloadHash(body.payload as unknown as Json, body.payload_hash);
  const conversationId = routeId(c.req.param('id'));
  const { db, now } = ready();
  const scope = conversationScope(db, principal, conversationId);
  const prior = priorCommand(db, principal, body.client_request_id);
  if (prior) return replay(c, prior, 'postMessage', null, body.payload_hash, `/api/v1/conversations/${conversationId}/messages`);
  await createConsultationApi(db, { now }).postMessage(asAdmission(principal), conversationId, {
    client_request_id: body.client_request_id,
    text: body.payload.text,
  });
  const commandId = storeCommand(db, principal, commandInput({
    operation: 'postMessage',
    resourceId: conversationId,
    dataDomain: scope.data_domain,
    clientRequestId: body.client_request_id,
    expectedRevision: null,
    payloadHash: body.payload_hash,
    permission: 'conversations.write',
  }));
  return c.json(accepted(commandId, `/api/v1/conversations/${conversationId}/messages`), 202);
}

async function linkWork(c: Context, ready: Ready): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requirePermission(c.req.raw, 'conversations.write');
  const parsed = linkRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as Envelope<{ work_id: string }>;
  if (body.expected_revision === null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'expected_revision' });
  assertPayloadHash(body.payload as unknown as Json, body.payload_hash);
  const conversationId = routeId(c.req.param('id'));
  const { db, now } = ready();
  const scope = conversationScope(db, principal, conversationId);
  const prior = priorCommand(db, principal, body.client_request_id);
  if (prior) return replay(c, prior, 'linkConversationWork', body.expected_revision, body.payload_hash, `/api/v1/conversations/${conversationId}/messages`);
  await createConsultationApi(db, { now }).linkConversationWork(
    asAdmission(principal),
    conversationId,
    body.payload.work_id,
    body.expected_revision,
  );
  const commandId = storeCommand(db, principal, commandInput({
    operation: 'linkConversationWork',
    resourceId: conversationId,
    dataDomain: scope.data_domain,
    clientRequestId: body.client_request_id,
    expectedRevision: body.expected_revision,
    payloadHash: body.payload_hash,
    permission: 'conversations.write',
  }));
  return c.json(accepted(commandId, `/api/v1/conversations/${conversationId}/messages`), 202);
}

function conversationScope(db: SqliteDatabase, principal: Principal, conversationId: string) {
  const row = db.prepare('SELECT account_id, caller_id, data_domain FROM conversations WHERE conversation_id = ?').get(conversationId) as {
    account_id: string;
    caller_id: string;
    data_domain: string;
  } | undefined;
  if (!row || row.account_id !== principal.account_id || row.caller_id !== principal.caller_id || !principal.domains.includes(row.data_domain)) {
    throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  }
  return row;
}

function replay(
  c: Context,
  prior: PriorCommand,
  operation: string,
  expectedRevision: number | null,
  payloadHash: string,
  receiptUrl: string,
): Response {
  const fingerprint = commandFingerprint({
    operation,
    resource_id: prior.resource_id,
    data_domain: prior.data_domain,
    expected_revision: expectedRevision,
    payload_hash: payloadHash,
  });
  if (prior.command_fingerprint !== fingerprint) throw new ApiError(409, 'CONFLICT', { reason: 'idempotency' });
  return c.json(accepted(prior.command_id, receiptUrl), 202);
}

function accepted(commandId: string, receiptUrl: string) {
  return { command_id: commandId, state: 'received' as const, receipt_url: receiptUrl };
}

function asAdmission(principal: Principal): AdmissionPrincipal {
  return {
    account_id: principal.account_id,
    caller_id: principal.caller_id,
    auth_epoch: principal.auth_epoch,
    domains: principal.domains,
    operations: principal.operations,
  };
}

type PriorCommand = { command_id: string; command_fingerprint: string; resource_id: string; data_domain: string };

function priorCommand(db: SqliteDatabase, principal: Principal, clientRequestId: string) {
  return db.prepare(`SELECT i.command_id, i.command_fingerprint, r.resource_id, r.data_domain
    FROM command_inbox i JOIN command_records r ON r.command_id = i.command_id
    WHERE i.account_id = ? AND i.caller_id = ? AND i.client_request_id = ?`).get(
    principal.account_id,
    principal.caller_id,
    clientRequestId,
  ) as PriorCommand | undefined;
}

function commandInput(input: {
  operation: string;
  resourceId: string;
  dataDomain: string;
  clientRequestId: string;
  expectedRevision: number | null;
  payloadHash: string;
  permission: string;
}): {
  operation: string;
  resourceId: string;
  dataDomain: string;
  clientRequestId: string;
  expectedRevision: number | null;
  payloadHash: string;
  permission: string;
  fingerprint: string;
} {
  return {
    ...input,
    fingerprint: commandFingerprint({
      operation: input.operation,
      resource_id: input.resourceId,
      data_domain: input.dataDomain,
      expected_revision: input.expectedRevision,
      payload_hash: input.payloadHash,
    }),
  };
}

function storeCommand(db: SqliteDatabase, principal: Principal, input: {
  operation: string;
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
