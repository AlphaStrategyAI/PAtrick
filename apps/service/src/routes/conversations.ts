import type { Context, Hono } from 'hono';
import { routes, type BrowserCreationScope, type Json } from '@patrick/contracts';
import type { SqliteDatabase } from '@patrick/storage';
import { createConsultationApi } from '../../../../packages/domain/src/consultations.js';
import { assertDomainPermission, domainsWithPermission, requireSession, snapshot, type Principal } from '../auth.js';
import { ApiError } from '../errors.js';
import {
  boundCreationDomain, commandAccepted, resolvedWorkDomain, runConsultationCommand, type CommandEnvelope, type ConsultationReady,
} from './consultation-commands.js';
import { assertPayloadHash, assertWriteOrigin, handle, readJson, routeId } from './http.js';

const createRequest = routeRequest('createConversation');
const messageRequest = routeRequest('postMessage');
const linkRequest = routeRequest('linkConversationWork');
const writePermission = 'conversations.write';
const readPermission = 'conversations.read';

export function mountConversationRoutes(app: Hono, ready: ConsultationReady): void {
  app.get('/api/v1/conversations', (c) => handle(c, () => listConversations(c, ready)));
  app.post('/api/v1/conversations', (c) => handle(c, () => postConversation(c, ready)));
  app.get('/api/v1/conversations/:id/messages', (c) => handle(c, () => listMessages(c, ready)));
  app.post('/api/v1/conversations/:id/messages', (c) => handle(c, () => postMessage(c, ready)));
  app.post('/api/v1/conversations/:id/work-links', (c) => handle(c, () => linkWork(c, ready)));
}

async function listConversations(c: Context, ready: ConsultationReady): Promise<Response> {
  const principal = await requireSession(c.req.raw);
  const { db, now } = ready();
  const domains = domainsWithPermission(db, principal, readPermission);
  if (domains.length === 0) throw new ApiError(403, 'FORBIDDEN', { reason: 'permission' });
  const scoped = { ...principal, domains };
  const items = await createConsultationApi(db, { now }).listConversations(scoped);
  return c.json(snapshot(scoped, { items }, now(), db));
}

async function postConversation(c: Context, ready: ConsultationReady): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const parsed = createRequest.safeParse(await readJson(c.req.raw));
  const principal = await requireSession(c.req.raw);
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as CommandEnvelope<{ text: string; request_scope: BrowserCreationScope }>;
  if (body.expected_revision !== null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'expected_revision' });
  assertPayloadHash(body.payload as unknown as Json, body.payload_hash);
  const { db, now } = ready();
  const { commandId, resourceId } = runConsultationCommand(db, now, principal, 'createConversation', writePermission, body, () => {
    const domain = boundCreationDomain(db, principal, body.payload.request_scope, writePermission);
    return { domain, resourceId: null };
  }, ({ domain }) => createConsultationApi(db, { now }).mutations.createConversation(
    { ...principal, domains: [domain] },
    { text: body.payload.text, client_request_id: body.client_request_id, data_domain: domain },
  ).conversation_id);
  return c.json(commandAccepted(commandId, messagesUrl(resourceId)), 202);
}

async function listMessages(c: Context, ready: ConsultationReady): Promise<Response> {
  const principal = await requireSession(c.req.raw);
  const conversationId = routeId(c.req.param('id'));
  const { db, now } = ready();
  const { domain } = conversationTarget(db, principal, conversationId, readPermission);
  const scoped = { ...principal, domains: [domain] };
  const items = await createConsultationApi(db, { now }).listMessages(scoped, conversationId);
  return c.json(snapshot(scoped, { items }, now(), db));
}

async function postMessage(c: Context, ready: ConsultationReady): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requireSession(c.req.raw);
  const parsed = messageRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as CommandEnvelope<{ text: string }>;
  if (body.expected_revision !== null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'expected_revision' });
  assertPayloadHash(body.payload as unknown as Json, body.payload_hash);
  const conversationId = routeId(c.req.param('id'));
  const { db, now } = ready();
  const { commandId, resourceId } = runConsultationCommand(db, now, principal, 'postMessage', writePermission, body,
    () => conversationTarget(db, principal, conversationId, writePermission),
    ({ domain }) => {
      createConsultationApi(db, { now }).mutations.postMessage(
        { ...principal, domains: [domain] }, conversationId,
        { ...body.payload, client_request_id: body.client_request_id },
      );
      return conversationId;
    },
  );
  return c.json(commandAccepted(commandId, messagesUrl(resourceId)), 202);
}

async function linkWork(c: Context, ready: ConsultationReady): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requireSession(c.req.raw);
  const parsed = linkRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as CommandEnvelope<{ work_id: string }>;
  const revision = body.expected_revision;
  if (revision === null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'expected_revision' });
  assertPayloadHash(body.payload as unknown as Json, body.payload_hash);
  const conversationId = routeId(c.req.param('id'));
  const { db, now } = ready();
  const { commandId, resourceId } = runConsultationCommand(db, now, principal, 'linkConversationWork', writePermission, body, () => {
    const target = conversationTarget(db, principal, conversationId, writePermission);
    if (resolvedWorkDomain(db, principal, body.payload.work_id) !== target.domain) {
      throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
    }
    return target;
  }, (target) => {
    if (target.revision !== revision) throw new ApiError(409, 'CONFLICT', { reason: 'revision' });
    createConsultationApi(db, { now }).mutations.linkConversationWork(
      { ...principal, domains: [target.domain] }, conversationId, body.payload.work_id, revision,
    );
    return conversationId;
  });
  return c.json(commandAccepted(commandId, messagesUrl(resourceId)), 202);
}

function conversationTarget(db: SqliteDatabase, principal: Principal, conversationId: string, permission: string) {
  const row = db.prepare('SELECT account_id, caller_id, data_domain, revision FROM conversations WHERE conversation_id = ?')
    .get(conversationId) as { account_id: string; caller_id: string; data_domain: string; revision: number } | undefined;
  if (!row || row.account_id !== principal.account_id || row.caller_id !== principal.caller_id) {
    throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  }
  assertDomainPermission(db, principal, row.data_domain, permission);
  return { domain: row.data_domain, resourceId: conversationId, revision: row.revision };
}

function messagesUrl(conversationId: string): string {
  return `/api/v1/conversations/${conversationId}/messages`;
}

function routeRequest(operationId: string) {
  const route = routes.find((item) => item.operationId === operationId);
  if (!route) throw new Error(`ROUTE_MISSING:${operationId}`);
  return route.request;
}
