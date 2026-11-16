import { createHash, randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { routes, type Json } from '@patrick/contracts';
import type { CredentialStore } from '@patrick/host';
import { commandFingerprint, recordCommand, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { encodeHubAnswer, type LocalHubPort } from '@patrick/integrations/autoloop/answers';
import { createFeishuChannel } from '../../../../packages/integrations/feishu/connection.js';
import { snapshot, type Principal } from '../auth.js';
import { ApiError } from '../errors.js';
import { assertPayloadHash, assertWriteOrigin, handle, readJson, requirePermission, routeId } from './http.js';

type Ready = () => { db: SqliteDatabase; now: () => Date; credentials: CredentialStore; hub: LocalHubPort };
type Envelope<T> = { client_request_id: string; expected_revision: number | null; payload_hash: string; payload: T };

const bindingRequest = routeRequest('createFeishuBinding');
const confirmRequest = routeRequest('confirmFeishuBinding');
const testRequest = routeRequest('createFeishuTest');
const sendRequest = routeRequest('sendFeishuTest');

export function mountFeishuRoutes(app: Hono, ready: Ready): void {
  app.get('/api/v1/channels/feishu', (c) => handle(c, () => readChannel(c, ready)));
  app.post('/api/v1/channels/feishu/credentials', (c) => handle(c, () => putCredential(c, ready)));
  app.post('/api/v1/channels/feishu/bindings', (c) => handle(c, () => createBinding(c, ready)));
  app.post('/api/v1/channels/feishu/bindings/:id/confirm', (c) => handle(c, () => confirmBinding(c, ready)));
  app.get('/api/v1/channels/feishu/bindings/:id', (c) => handle(c, () => readBinding(c, ready)));
  app.post('/api/v1/channels/feishu/tests', (c) => handle(c, () => createTest(c, ready)));
  app.post('/api/v1/channels/feishu/tests/:id/send', (c) => handle(c, () => sendTest(c, ready)));
  app.get('/api/v1/channels/feishu/tests/:id', (c) => handle(c, () => readTest(c, ready)));
}

async function readChannel(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'channels.read');
  const { db, now } = ready();
  const row = db.prepare(`SELECT status, reason_code, transport_mode, data_domain, account_id FROM channel_connections
    WHERE account_id = ? ORDER BY updated_at DESC LIMIT 1`).get(principal.account_id) as {
    status: string;
    reason_code: string | null;
    transport_mode: string;
    data_domain: string;
    account_id: string;
  } | undefined;
  const data = row && principal.domains.includes(row.data_domain)
    ? { status: row.status, reason_code: row.reason_code, transport_mode: row.transport_mode }
    : { status: 'not_configured', reason_code: null, transport_mode: 'probe' };
  return c.json(snapshot(principal, data, now(), db));
}

async function putCredential(c: Context, ready: Ready): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requirePermission(c.req.raw, 'owner');
  const body = await readJson(c.req.raw) as { app_id?: string; app_secret?: string };
  if (!body.app_id || !body.app_secret) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'credential' });
  const { credentials, db, now } = ready();
  const ref = credentials.put(new TextEncoder().encode(body.app_secret), 10 * 60 * 1000);
  const stamped = now().toISOString();
  const version = withImmediateTransaction(db, () => {
    const current = db.prepare('SELECT credential_version FROM channel_connections WHERE account_id = ?').get(principal.account_id) as {
      credential_version: number;
    } | undefined;
    const next = (current?.credential_version ?? 0) + 1;
    if (!current) {
      db.prepare(`INSERT INTO channel_connections (
        connection_id, account_id, data_domain, app_id, tenant_key, credential_ref, credential_version,
        config_revision, channel_incarnation, connection_epoch, binding_revision, current_pairing_id, current_test_id,
        owner_open_id, chat_id, status, transport_mode, reason_code, cutoff_seq, schema_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending-tenant', ?, ?, 1, 1, 1, 1, NULL, NULL, NULL, NULL, 'needs_binding', 'probe', NULL, NULL, '1.0', ?, ?)`).run(
        `conn_${sha256(principal.account_id).slice(0, 12)}`,
        principal.account_id,
        principal.domains[0] ?? 'personal',
        body.app_id,
        ref,
        next,
        stamped,
        stamped,
      );
    } else {
      db.prepare(`UPDATE channel_connections SET credential_ref = ?, credential_version = ?, app_id = ?, updated_at = ?
        WHERE account_id = ?`).run(ref, next, body.app_id, stamped, principal.account_id);
    }
    return next;
  });
  return c.json({ credential_ref: ref, version });
}

async function createBinding(c: Context, ready: Ready): Promise<Response> {
  return command(c, ready, 'createFeishuBinding', bindingRequest, 'channels/feishu/bindings', async (resources, principal) => {
    const channel = feishu(resources, principal);
    await channel.configure();
    const pairing = await channel.createPairing();
    return pairing.pairing_id;
  });
}

async function confirmBinding(c: Context, ready: Ready): Promise<Response> {
  const pairingId = routeId(c.req.param('id'));
  return command(c, ready, 'confirmFeishuBinding', confirmRequest, `channels/feishu/bindings/${pairingId}`, async (resources, principal) => {
    await feishu(resources, principal).confirmPairing(principal, pairingId);
    return pairingId;
  });
}

async function readBinding(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'channels.read');
  const pairingId = routeId(c.req.param('id'));
  const { db, now } = ready();
  const row = db.prepare(`SELECT pairing_id, status, expires_at, candidate_open_id, account_id, data_domain
    FROM channel_pairings WHERE pairing_id = ?`).get(pairingId) as { account_id: string; data_domain: string } | undefined;
  if (!row || row.account_id !== principal.account_id || !principal.domains.includes(row.data_domain)) {
    throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  }
  return c.json(snapshot(principal, row, now(), db));
}

async function createTest(c: Context, ready: Ready): Promise<Response> {
  return command(c, ready, 'createFeishuTest', testRequest, 'channels/feishu/tests', async (resources, principal, body) => {
    const destination = (body as { destination?: string }).destination;
    if (!destination) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'destination' });
    const created = await feishu(resources, principal).createTest(destination);
    return created.test_id;
  });
}

async function sendTest(c: Context, ready: Ready): Promise<Response> {
  const testId = routeId(c.req.param('id'));
  return command(c, ready, 'sendFeishuTest', sendRequest, `channels/feishu/tests/${testId}`, async (resources, principal, body) => {
    const payload = body as { test_id: string; preview_hash: string; destination: string };
    if (payload.test_id !== testId) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'test' });
    await feishu(resources, principal).sendTest(payload);
    return testId;
  });
}

async function readTest(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'channels.read');
  const testId = routeId(c.req.param('id'));
  const { db, now } = ready();
  const row = db.prepare(`SELECT test_id, status, preview_hash, destination, message_id, inbound_evidence, app_id, tenant_key,
    config_revision, credential_version, binding_id, data_domain, incarnation, epoch, account_id
    FROM channel_tests WHERE test_id = ?`).get(testId) as { account_id: string; data_domain: string } | undefined;
  if (!row || row.account_id !== principal.account_id || !principal.domains.includes(row.data_domain)) {
    throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  }
  return c.json(snapshot(principal, row, now(), db));
}

function feishu(resources: ReturnType<Ready>, principal: Principal) {
  return createFeishuChannel(resources.db, {
    now: resources.now,
    hub: resources.hub,
    encode: encodeHubAnswer,
    domain: principal.domains[0] ?? 'personal',
    connectionId: `conn_${sha256(principal.account_id).slice(0, 12)}`,
  });
}

async function command(
  c: Context,
  ready: Ready,
  operation: string,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } },
  receiptPath: string,
  run: (resources: ReturnType<Ready>, principal: Principal, payload: unknown) => Promise<string>,
): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requirePermission(c.req.raw, 'owner');
  const parsed = schema.safeParse(await readJson(c.req.raw));
  if (!parsed.success || !parsed.data) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as Envelope<unknown>;
  assertPayloadHash((body.payload ?? {}) as Json, body.payload_hash);
  const resources = ready();
  const domain = principal.domains[0] ?? 'personal';
  const resourceId = await run(resources, principal, body.payload);
  const fingerprint = commandFingerprint({
    operation,
    resource_id: resourceId,
    data_domain: domain,
    expected_revision: body.expected_revision,
    payload_hash: body.payload_hash,
  });
  const commandId = randomUUID();
  withImmediateTransaction(resources.db, () => {
    const stored = recordCommand(resources.db, {
      account_id: principal.account_id,
      caller_id: principal.caller_id,
      client_request_id: body.client_request_id,
      command_fingerprint: fingerprint,
      command_id: commandId,
    });
    if (stored.created) {
      resources.db.prepare(`INSERT INTO command_records (
        command_id, account_id, caller_id, operation, resource_id, data_domain, permission, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'owner', ?)`).run(
        stored.command_id,
        principal.account_id,
        principal.caller_id,
        operation,
        resourceId,
        domain,
        resources.now().toISOString(),
      );
    }
  });
  const receiptUrl = receiptPath.endsWith(`/${resourceId}`)
    ? `/api/v1/${receiptPath}`
    : `/api/v1/${receiptPath}/${resourceId}`;
  return c.json({ command_id: commandId, state: 'received', receipt_url: receiptUrl }, 202);
}

function routeRequest(operationId: string) {
  const route = routes.find((item) => item.operationId === operationId);
  if (!route) throw new Error(`ROUTE_MISSING:${operationId}`);
  return route.request;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
