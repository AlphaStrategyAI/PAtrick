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

const createRequest = routeRequest('createConsultation');
const cancelRequest = routeRequest('cancelConsultation');

export function mountConsultationRoutes(app: Hono, ready: Ready): void {
  app.post('/api/v1/consultations', (c) => handle(c, () => postConsultation(c, ready)));
  app.get('/api/v1/consultations/:id', (c) => handle(c, () => readConsultation(c, ready)));
  app.post('/api/v1/consultations/:id/cancel', (c) => handle(c, () => cancelConsultation(c, ready)));
}

async function postConsultation(c: Context, ready: Ready): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requirePermission(c.req.raw, 'consultations.write');
  const parsed = createRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as Envelope<{ text: string; parent_work_id: string | null }>;
  if (body.expected_revision !== null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'expected_revision' });
  assertPayloadHash(body.payload as unknown as Json, body.payload_hash);
  const { db, now } = ready();
  const domain = resolveDomain(db, principal, body.payload.parent_work_id);
  const prior = priorCommand(db, principal, body.client_request_id);
  if (prior) {
    const fingerprint = commandFingerprint({
      operation: 'createConsultation',
      resource_id: prior.resource_id,
      data_domain: prior.data_domain,
      expected_revision: null,
      payload_hash: body.payload_hash,
    });
    if (prior.command_fingerprint !== fingerprint) throw new ApiError(409, 'CONFLICT', { reason: 'idempotency' });
    return c.json(accepted(prior.command_id, prior.resource_id), 202);
  }
  const receipt = await createConsultationApi(db, { now }).createConsultation(asAdmission(principal), {
    client_request_id: body.client_request_id,
    text: body.payload.text,
    data_domain: domain,
    parent_work_id: body.payload.parent_work_id,
  });
  const fingerprint = commandFingerprint({
    operation: 'createConsultation',
    resource_id: receipt.request_id,
    data_domain: domain,
    expected_revision: null,
    payload_hash: body.payload_hash,
  });
  const commandId = storeCommand(db, principal, {
    operation: 'createConsultation',
    resourceId: receipt.request_id,
    dataDomain: domain,
    clientRequestId: body.client_request_id,
    expectedRevision: null,
    payloadHash: body.payload_hash,
    permission: 'consultations.write',
    fingerprint,
  });
  return c.json(accepted(commandId, receipt.request_id), 202);
}

async function readConsultation(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'consultations.read');
  const requestId = routeId(c.req.param('id'));
  const { db, now } = ready();
  const view = await createConsultationApi(db, { now }).readConsultation(asAdmission(principal), requestId);
  return c.json(snapshot(principal, view, now(), db));
}

async function cancelConsultation(c: Context, ready: Ready): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requirePermission(c.req.raw, 'consultations.write');
  const parsed = cancelRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as Envelope<Record<string, never>>;
  if (body.expected_revision === null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'expected_revision' });
  assertPayloadHash(body.payload as unknown as Json, body.payload_hash);
  const requestId = routeId(c.req.param('id'));
  const { db, now } = ready();
  const row = db.prepare('SELECT data_domain, account_id, caller_id FROM consultations WHERE request_id = ?').get(requestId) as {
    data_domain: string;
    account_id: string;
    caller_id: string;
  } | undefined;
  if (!row || row.account_id !== principal.account_id || row.caller_id !== principal.caller_id || !principal.domains.includes(row.data_domain)) {
    throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  }
  const fingerprint = commandFingerprint({
    operation: 'cancelConsultation',
    resource_id: requestId,
    data_domain: row.data_domain,
    expected_revision: body.expected_revision,
    payload_hash: body.payload_hash,
  });
  const prior = priorCommand(db, principal, body.client_request_id);
  if (prior) {
    if (prior.command_fingerprint !== fingerprint) throw new ApiError(409, 'CONFLICT', { reason: 'idempotency' });
    return c.json(accepted(prior.command_id, requestId), 202);
  }
  const cancelled = await createConsultationApi(db, { now }).cancelConsultation(asAdmission(principal), requestId, body.expected_revision);
  if (!cancelled) throw new ApiError(409, 'CONFLICT', { reason: 'revision' });
  const commandId = storeCommand(db, principal, {
    operation: 'cancelConsultation',
    resourceId: requestId,
    dataDomain: row.data_domain,
    clientRequestId: body.client_request_id,
    expectedRevision: body.expected_revision,
    payloadHash: body.payload_hash,
    permission: 'consultations.write',
    fingerprint,
  });
  return c.json(accepted(commandId, requestId), 202);
}

function resolveDomain(db: SqliteDatabase, principal: Principal, parentWorkId: string | null): string {
  if (!parentWorkId) {
    const domain = principal.domains[0];
    if (!domain) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'domain' });
    return domain;
  }
  const rows = db.prepare('SELECT data_domain, account_id FROM work_generations WHERE work_id = ?').all(parentWorkId) as Array<{
    data_domain: string;
    account_id: string;
  }>;
  const visible = rows.find((row) => row.account_id === principal.account_id && principal.domains.includes(row.data_domain));
  if (!visible) throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  return visible.data_domain;
}

function accepted(commandId: string, requestId: string) {
  return { command_id: commandId, state: 'received' as const, receipt_url: `/api/v1/consultations/${requestId}` };
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

function priorCommand(db: SqliteDatabase, principal: Principal, clientRequestId: string) {
  return db.prepare(`SELECT i.command_id, i.command_fingerprint, r.resource_id, r.data_domain
    FROM command_inbox i JOIN command_records r ON r.command_id = i.command_id
    WHERE i.account_id = ? AND i.caller_id = ? AND i.client_request_id = ?`).get(
    principal.account_id,
    principal.caller_id,
    clientRequestId,
  ) as { command_id: string; command_fingerprint: string; resource_id: string; data_domain: string } | undefined;
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
