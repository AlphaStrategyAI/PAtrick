import { createHash, randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { canonicalPayload, routes, type Json } from '@patrick/contracts';
import { commandFingerprint, recordCommand, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { createDelegationApi, type AdmissionPrincipal, type Level } from '../../../../packages/domain/src/delegation.js';
import { snapshot, type Principal } from '../auth.js';
import { ApiError } from '../errors.js';
import { assertPayloadHash, assertWriteOrigin, handle, readJson, requirePermission, routeId } from './http.js';

type Ready = () => { db: SqliteDatabase; now: () => Date };
type Envelope<T> = { client_request_id: string; expected_revision: number | null; payload_hash: string; payload: T };
type Proposal = {
  type_id: string;
  actions: string[];
  resources: string[];
  effects: string[];
  domains: string[];
  risk: string;
  level: Level;
  budget_micros: number;
  expires_at: string;
};

const proposalRequest = routeRequest('createDelegationProposal');
const controlRequest = routeRequest('controlDelegation');
const LEVELS = new Set(['L0', 'L1', 'L2', 'L3']);

export function mountDelegationRoutes(app: Hono, ready: Ready): void {
  app.get('/api/v1/delegations', (c) => handle(c, () => listDelegations(c, ready)));
  app.get('/api/v1/delegations/:id', (c) => handle(c, () => readDelegation(c, ready)));
  app.post('/api/v1/delegation-proposals', (c) => handle(c, () => proposeDelegation(c, ready)));
  app.post('/api/v1/delegations/:id/controls', (c) => handle(c, () => controlDelegation(c, ready)));
}

async function listDelegations(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'delegations.read');
  const { db, now } = ready();
  const items = await delegationApi(db, principal, now).listDelegations();
  return c.json(snapshot(principal, { items }, now(), db));
}

async function readDelegation(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'delegations.read');
  const { db, now } = ready();
  const item = await delegationApi(db, principal, now).getDelegation(routeId(c.req.param('id')));
  return c.json(snapshot(principal, item, now(), db));
}

async function proposeDelegation(c: Context, ready: Ready): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requirePermission(c.req.raw, 'owner');
  const parsed = proposalRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as Envelope<unknown>;
  if (body.expected_revision !== null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'expected_revision' });
  const proposal = proposalOf(body.payload);
  if (!proposal.domains.every((item) => principal.domains.includes(item))) throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  assertPayloadHash(proposal as unknown as Json, body.payload_hash);
  const domain = proposal.domains[0];
  if (!domain) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'domain' });
  const mandateId = `m_${createHash('sha256').update(canonicalPayload(proposal as unknown as Json)).digest('hex').slice(0, 24)}`;
  const { db, now } = ready();
  const fingerprint = commandFingerprint({
    operation: 'createDelegationProposal',
    resource_id: mandateId,
    data_domain: domain,
    expected_revision: null,
    payload_hash: body.payload_hash,
  });
  const existing = existingCommand(db, principal, body.client_request_id, fingerprint);
  if (existing) return c.json(accepted(existing, mandateId), 202);
  await delegationApi(db, principal, now, domain).openMandate({ ...proposal, mandate_id: mandateId });
  const commandId = storeCommand(db, principal, {
    operation: 'createDelegationProposal',
    resourceId: mandateId,
    dataDomain: domain,
    clientRequestId: body.client_request_id,
    expectedRevision: null,
    payloadHash: body.payload_hash,
    permission: 'owner',
    fingerprint,
  });
  return c.json(accepted(commandId, mandateId), 202);
}

async function controlDelegation(c: Context, ready: Ready): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requirePermission(c.req.raw, 'owner');
  const parsed = controlRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as Envelope<{ type: 'pause' | 'resume' | 'stop' }>;
  if (body.expected_revision === null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'expected_revision' });
  assertPayloadHash(body.payload as unknown as Json, body.payload_hash);
  const mandateId = routeId(c.req.param('id'));
  const { db, now } = ready();
  const current = await delegationApi(db, principal, now).getDelegation(mandateId);
  const fingerprint = commandFingerprint({
    operation: 'controlDelegation',
    resource_id: mandateId,
    data_domain: current.domains[0] ?? principal.domains[0] ?? 'personal',
    expected_revision: body.expected_revision,
    payload_hash: body.payload_hash,
  });
  const existing = existingCommand(db, principal, body.client_request_id, fingerprint);
  if (existing) return c.json(accepted(existing, mandateId), 202);
  const api = delegationApi(db, principal, now, current.domains[0]);
  if (body.payload.type === 'pause') await api.pauseMandate(mandateId, body.expected_revision);
  else if (body.payload.type === 'resume') await api.resumeMandate(mandateId, body.expected_revision);
  else await api.stopMandate(mandateId, body.expected_revision);
  const commandId = storeCommand(db, principal, {
    operation: 'controlDelegation',
    resourceId: mandateId,
    dataDomain: current.domains[0] ?? principal.domains[0] ?? 'personal',
    clientRequestId: body.client_request_id,
    expectedRevision: body.expected_revision,
    payloadHash: body.payload_hash,
    permission: 'owner',
    fingerprint,
  });
  return c.json(accepted(commandId, mandateId), 202);
}

function delegationApi(db: SqliteDatabase, principal: Principal, now: () => Date, domain = principal.domains[0] ?? 'personal') {
  const caller: AdmissionPrincipal = {
    account_id: principal.account_id,
    caller_id: principal.caller_id,
    auth_epoch: principal.auth_epoch,
    domains: principal.domains,
    operations: principal.operations,
  };
  return createDelegationApi(db, caller, { now, domain });
}

function proposalOf(value: unknown): Proposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const record = value as Record<string, unknown>;
  const level = record.level;
  if (typeof record.type_id !== 'string' || record.type_id.length === 0) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'type' });
  if (typeof record.risk !== 'string' || record.risk.length === 0) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'risk' });
  if (typeof record.expires_at !== 'string' || record.expires_at.length === 0) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'expires_at' });
  if (typeof level !== 'string' || !LEVELS.has(level)) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'level' });
  if (typeof record.budget_micros !== 'number' || !Number.isInteger(record.budget_micros) || record.budget_micros < 0) {
    throw new ApiError(422, 'UNPROCESSABLE', { reason: 'budget' });
  }
  return {
    type_id: record.type_id,
    actions: stringList(record.actions, 'actions'),
    resources: stringList(record.resources, 'resources'),
    effects: stringList(record.effects, 'effects'),
    domains: stringList(record.domains, 'domains'),
    risk: record.risk,
    level: level as Level,
    budget_micros: record.budget_micros,
    expires_at: record.expires_at,
  };
}

function stringList(value: unknown, reason: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new ApiError(422, 'UNPROCESSABLE', { reason });
  }
  return value;
}

function accepted(commandId: string, mandateId: string) {
  return { command_id: commandId, state: 'received' as const, receipt_url: `/api/v1/delegations/${mandateId}` };
}

function existingCommand(db: SqliteDatabase, principal: Principal, clientRequestId: string, expectedFingerprint: string): string | undefined {
  const row = db.prepare(`SELECT command_id, command_fingerprint FROM command_inbox
    WHERE account_id = ? AND caller_id = ? AND client_request_id = ?`).get(principal.account_id, principal.caller_id, clientRequestId) as {
    command_id: string;
    command_fingerprint: string;
  } | undefined;
  if (!row) return undefined;
  if (row.command_fingerprint !== expectedFingerprint) throw new ApiError(409, 'CONFLICT', { reason: 'idempotency' });
  return row.command_id;
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
