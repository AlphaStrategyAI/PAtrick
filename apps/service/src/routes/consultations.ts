import type { Context, Hono } from 'hono';
import { routes, type Json } from '@patrick/contracts';
import { createConsultationApi } from '../../../../packages/domain/src/consultations.js';
import { assertDomainPermission, domainsWithPermission, requireSession, snapshot } from '../auth.js';
import { ApiError } from '../errors.js';
import {
  commandAccepted, ownedConsultationDomain, resolvedWorkDomain, runConsultationCommand,
  type CommandEnvelope, type ConsultationReady,
} from './consultation-commands.js';
import { assertPayloadHash, assertWriteOrigin, handle, readJson, routeId } from './http.js';

const createRequest = routeRequest('createConsultation');
const cancelRequest = routeRequest('cancelConsultation');
const writePermission = 'consultations.write';
const readPermission = 'consultations.read';

export function mountConsultationRoutes(app: Hono, ready: ConsultationReady): void {
  app.post('/api/v1/consultations', (c) => handle(c, () => postConsultation(c, ready)));
  app.get('/api/v1/consultations/:id', (c) => handle(c, () => readConsultation(c, ready)));
  app.post('/api/v1/consultations/:id/cancel', (c) => handle(c, () => cancelConsultation(c, ready)));
}

async function postConsultation(c: Context, ready: ConsultationReady): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requireSession(c.req.raw);
  const parsed = createRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as CommandEnvelope<{ text: string; parent_work_id: string | null }>;
  if (body.expected_revision !== null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'expected_revision' });
  assertPayloadHash(body.payload as unknown as Json, body.payload_hash);
  const { db, now } = ready();
  const { commandId, resourceId } = runConsultationCommand(db, now, principal, 'createConsultation', writePermission, body, () => {
    const parent = body.payload.parent_work_id;
    const domain = parent ? resolvedWorkDomain(db, principal, parent) : domainsWithPermission(db, principal, writePermission)[0];
    if (!domain) throw new ApiError(403, 'FORBIDDEN', { reason: 'permission' });
    assertDomainPermission(db, principal, domain, writePermission);
    const authorization = domainsWithPermission(db, principal, writePermission, false).includes(domain)
      ? writePermission : 'owner';
    return { domain, resourceId: null, authorization } as const;
  }, ({ domain, authorization }) => createConsultationApi(db, { now }).mutations.createConsultation(
    { ...principal, domains: [domain] },
    { ...body.payload, client_request_id: body.client_request_id, data_domain: domain },
    authorization,
  ).request_id);
  return c.json(commandAccepted(commandId, `/api/v1/consultations/${resourceId}`), 202);
}

async function readConsultation(c: Context, ready: ConsultationReady): Promise<Response> {
  const principal = await requireSession(c.req.raw);
  const requestId = routeId(c.req.param('id'));
  const { db, now } = ready();
  const domain = ownedConsultationDomain(db, principal, requestId);
  assertDomainPermission(db, principal, domain, readPermission);
  const scoped = { ...principal, domains: [domain] };
  const view = await createConsultationApi(db, { now }).readConsultation(scoped, requestId);
  return c.json(snapshot(scoped, view, now(), db));
}

async function cancelConsultation(c: Context, ready: ConsultationReady): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requireSession(c.req.raw);
  const parsed = cancelRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as CommandEnvelope<Record<string, never>>;
  const revision = body.expected_revision;
  if (revision === null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'expected_revision' });
  assertPayloadHash(body.payload as unknown as Json, body.payload_hash);
  const requestId = routeId(c.req.param('id'));
  const { db, now } = ready();
  const { commandId, resourceId } = runConsultationCommand(db, now, principal, 'cancelConsultation', writePermission, body, () => {
    const domain = ownedConsultationDomain(db, principal, requestId);
    assertDomainPermission(db, principal, domain, writePermission);
    return { domain, resourceId: requestId };
  }, ({ domain }) => {
    const cancelled = createConsultationApi(db, { now }).mutations.cancelConsultation(
      { ...principal, domains: [domain] }, requestId, revision,
    );
    if (!cancelled) throw new ApiError(409, 'CONFLICT', { reason: 'revision' });
    return requestId;
  });
  return c.json(commandAccepted(commandId, `/api/v1/consultations/${resourceId}`), 202);
}

function routeRequest(operationId: string) {
  const route = routes.find((item) => item.operationId === operationId);
  if (!route) throw new Error(`ROUTE_MISSING:${operationId}`);
  return route.request;
}
