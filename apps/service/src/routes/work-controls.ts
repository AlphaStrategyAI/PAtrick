import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { routes, type Json } from '@patrick/contracts';
import { commandFingerprint, recordCommand, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { type AdmissionPrincipal } from '../../../../packages/domain/src/delegation.js';
import { createStopFixture, createWorkControlApi } from '../../../../packages/domain/src/work-control.js';
import type { Principal } from '../auth.js';
import { ApiError } from '../errors.js';
import { assertPayloadHash, assertWriteOrigin, handle, readJson, requirePermission, routeId } from './http.js';

type Ready = () => { db: SqliteDatabase; now: () => Date };
type Envelope<T> = { client_request_id: string; expected_revision: number | null; payload_hash: string; payload: T };

const controlRequest = routeRequest('controlWork');

export function mountWorkControlRoutes(app: Hono, ready: Ready): void {
  const stopPort = createStopFixture();
  app.post('/api/v1/work/:id/controls', (c) => handle(c, () => controlWork(c, ready, stopPort)));
}

async function controlWork(c: Context, ready: Ready, stopPort: ReturnType<typeof createStopFixture>): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requirePermission(c.req.raw, 'work.control');
  const parsed = controlRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as Envelope<{ type: 'pause' | 'resume' | 'stop'; generation: number }>;
  if (body.expected_revision === null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'expected_revision' });
  assertPayloadHash(body.payload as unknown as Json, body.payload_hash);
  const workId = routeId(c.req.param('id'));
  const { db, now } = ready();
  const work = db.prepare('SELECT account_id, data_domain FROM work_generations WHERE work_id = ? AND generation = ?').get(
    workId,
    body.payload.generation,
  ) as { account_id: string; data_domain: string } | undefined;
  if (!work || work.account_id !== principal.account_id || !principal.domains.includes(work.data_domain)) {
    throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  }
  const fingerprint = commandFingerprint({
    operation: 'controlWork',
    resource_id: workId,
    data_domain: work.data_domain,
    expected_revision: body.expected_revision,
    payload_hash: body.payload_hash,
  });
  const existing = existingCommand(db, principal, body.client_request_id, fingerprint);
  if (existing) return c.json(accepted(existing, workId), 202);
  const caller: AdmissionPrincipal = {
    account_id: principal.account_id,
    caller_id: principal.caller_id,
    auth_epoch: principal.auth_epoch,
    domains: principal.domains,
    operations: principal.operations,
  };
  await createWorkControlApi(db, caller, { now, stopPort }).applyWorkControl(caller, {
    work_id: workId,
    type: body.payload.type,
    generation: body.payload.generation,
    expected_revision: body.expected_revision,
  });
  const commandId = storeCommand(db, principal, {
    operation: 'controlWork',
    resourceId: workId,
    dataDomain: work.data_domain,
    clientRequestId: body.client_request_id,
    expectedRevision: body.expected_revision,
    payloadHash: body.payload_hash,
    permission: 'work.control',
    fingerprint,
  });
  return c.json(accepted(commandId, workId), 202);
}

function accepted(commandId: string, workId: string) {
  return { command_id: commandId, state: 'received' as const, receipt_url: `/api/v1/work/${workId}` };
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
