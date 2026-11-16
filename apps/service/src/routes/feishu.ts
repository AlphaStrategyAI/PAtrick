import { createHash, randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { routes, type Json } from '@patrick/contracts';
import type { CredentialStore } from '@patrick/host';
import { commandFingerprint, recordCommand, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { encodeHubAnswer, type LocalHubPort } from '@patrick/integrations/autoloop/answers';
import { channelPermit, createAnswerGate, type AnswerPayload } from '../../../../packages/domain/src/answer-gate.js';
import { createFeishuChannel, type EnableProof } from '../../../../packages/integrations/feishu/connection.js';
import { snapshot, type Principal } from '../auth.js';
import { ApiError } from '../errors.js';
import { registerSettingsOperation, runSettingsOperation, runSettingsOperationNow } from '../settings/registry.js';
import { assertPayloadHash, assertWriteOrigin, handle, readJson, requirePermission, routeId } from './http.js';

type Ready = () => { db: SqliteDatabase; now: () => Date; credentials: CredentialStore; hub: LocalHubPort };
type Envelope<T> = { client_request_id: string; expected_revision: number | null; payload_hash: string; payload: T };

const bindingRequest = routeRequest('createFeishuBinding');
const confirmRequest = routeRequest('confirmFeishuBinding');
const testRequest = routeRequest('createFeishuTest');
const sendRequest = routeRequest('sendFeishuTest');
const inspectRequest = routeRequest('inspectFeishu');
const validateRequest = routeRequest('validateFeishu');

type SettingsReady = () => { db: SqliteDatabase; now: () => Date; hub: LocalHubPort };

export function mountFeishuRoutes(app: Hono, ready: Ready): void {
  registerFeishuSettings(() => {
    const resources = ready();
    return { db: resources.db, now: resources.now, hub: resources.hub };
  });
  app.get('/api/v1/channels/feishu', (c) => handle(c, () => readChannel(c, ready)));
  app.post('/api/v1/channels/feishu/inspections', (c) => handle(c, () => inspectChannel(c, ready)));
  app.post('/api/v1/channels/feishu/validations', (c) => handle(c, () => validateChannel(c, ready)));
  app.post('/api/v1/channels/feishu/inbound', (c) => handle(c, () => postInbound(c, ready)));
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
  return command(c, ready, 'createFeishuBinding', bindingRequest, 'channels/feishu/bindings', (resources, principal) => {
    const channel = feishu(resources, principal);
    channel.configure();
    channel.createPairing();
    const row = resources.db.prepare('SELECT current_pairing_id FROM channel_connections WHERE connection_id = ?').get(
      connectionIdFor(principal),
    ) as { current_pairing_id: string | null } | undefined;
    if (!row?.current_pairing_id) throw new Error('PAIRING_MISSING');
    return row.current_pairing_id;
  }, true);
}

async function confirmBinding(c: Context, ready: Ready): Promise<Response> {
  const pairingId = routeId(c.req.param('id'));
  return command(c, ready, 'confirmFeishuBinding', confirmRequest, `channels/feishu/bindings/${pairingId}`, (resources, principal) => {
    feishu(resources, principal).confirmPairing(principal, pairingId);
    return pairingId;
  }, true);
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
  return command(c, ready, 'createFeishuTest', testRequest, 'channels/feishu/tests', (resources, principal, body) => {
    const destination = (body as { destination?: string }).destination;
    if (!destination) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'destination' });
    feishu(resources, principal).createTest(destination);
    const row = resources.db.prepare('SELECT current_test_id FROM channel_connections WHERE connection_id = ?').get(
      connectionIdFor(principal),
    ) as { current_test_id: string | null } | undefined;
    if (!row?.current_test_id) throw new Error('TEST_MISSING');
    return row.current_test_id;
  }, true);
}

async function sendTest(c: Context, ready: Ready): Promise<Response> {
  const testId = routeId(c.req.param('id'));
  return command(c, ready, 'sendFeishuTest', sendRequest, `channels/feishu/tests/${testId}`, (resources, principal, body) => {
    const payload = body as { test_id: string; preview_hash: string; destination: string };
    if (payload.test_id !== testId) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'test' });
    feishu(resources, principal).sendTest(payload);
    return testId;
  }, true);
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

async function inspectChannel(c: Context, ready: Ready): Promise<Response> {
  return command(c, ready, 'inspectFeishu', inspectRequest, 'channels/feishu', (resources, principal) => {
    const connectionId = connectionIdFor(principal);
    runSettingsOperationNow('inspect', {
      account_id: principal.account_id,
      connection_id: connectionId,
      domain: principal.domains[0] ?? 'personal',
    });
    void resources;
    return connectionId;
  });
}

async function validateChannel(c: Context, ready: Ready): Promise<Response> {
  return command(c, ready, 'validateFeishu', validateRequest, 'channels/feishu', (resources, principal) => {
    const connectionId = connectionIdFor(principal);
    runSettingsOperationNow('validate', {
      action: 'enable',
      account_id: principal.account_id,
      connection_id: connectionId,
      domain: principal.domains[0] ?? 'personal',
    });
    void resources;
    return connectionId;
  });
}

async function postInbound(c: Context, ready: Ready): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requirePermission(c.req.raw, 'owner');
  const body = await readJson(c.req.raw) as Partial<Envelope<AnswerPayload>> & { connection_id?: string; inbound_id?: string };
  if (!body.client_request_id || !body.payload_hash || !body.payload || !body.connection_id || !body.inbound_id) {
    throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  }
  if (body.expected_revision === undefined) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  assertPayloadHash(body.payload as unknown as Json, body.payload_hash);
  const resources = ready();
  const domain = principal.domains[0] ?? 'personal';
  const connection = resources.db.prepare('SELECT account_id, data_domain FROM channel_connections WHERE connection_id = ?').get(
    body.connection_id,
  ) as { account_id: string; data_domain: string } | undefined;
  if (!connection || connection.account_id !== principal.account_id || !principal.domains.includes(connection.data_domain)) {
    throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  }
  const prior = findCommand(resources.db, principal, body.client_request_id);
  if (prior) {
    return replay(c, prior, 'acceptFeishuInbound', domain, body.expected_revision, body.payload_hash, `/api/v1/answers/${prior.resource_id}`);
  }
  const gate = createAnswerGate(resources.db, {
    domain: connection.data_domain,
    now: resources.now,
    hub: resources.hub,
    encode: encodeHubAnswer,
  });
  let receipt;
  try {
    channelPermit(resources.db, body.connection_id, body.inbound_id, body.payload.question_id, resources.now().toISOString());
    receipt = await gate.submitAnswer({
      account_id: principal.account_id,
      caller_id: 'feishu',
      auth_epoch: principal.auth_epoch,
      domains: principal.domains,
      operations: principal.operations,
    }, {
      client_request_id: body.client_request_id,
      expected_revision: body.expected_revision,
      payload_hash: body.payload_hash,
      entry: 'feishu',
      connection_id: body.connection_id,
      inbound_id: body.inbound_id,
      payload: body.payload,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'CHANNEL_DENIED') throw new ApiError(403, 'FORBIDDEN', { reason: 'channel' });
    throw error;
  }
  const commandId = storeCommand(resources, principal, 'acceptFeishuInbound', receipt.receipt_id, connection.data_domain, body.client_request_id, body.expected_revision, body.payload_hash);
  return c.json({ command_id: commandId, state: 'received', receipt_url: `/api/v1/answers/${receipt.receipt_id}` }, 202);
}

export function registerFeishuSettings(ready: SettingsReady): void {
  registerSettingsOperation('inspect', (input) => inspectFeishu(ready, input));
  registerSettingsOperation('validate', (input) => validateFeishu(ready, input));
  registerSettingsOperation('apply', (input) => applyFeishu(ready, input));
  registerSettingsOperation('recheck', (input) => recheckFeishu(ready, input));
}

function inspectFeishu(ready: SettingsReady, input: unknown): { records: Array<{ target: string; observed: string }> } {
  const request = settingsRequest(input);
  const connection = findSettingsConnection(ready(), request);
  return { records: [{ target: 'feishu', observed: connection?.status ?? 'not_configured' }] };
}

function validateFeishu(ready: SettingsReady, input: unknown): { valid: boolean } {
  const request = settingsRequest(input);
  const resources = ready();
  const connection = findSettingsConnection(resources, request);
  if (!connection) return { valid: false };
  if (request.action === 'disable') {
    const pending = resources.db.prepare(`SELECT COUNT(*) AS n FROM channel_permits
      WHERE connection_id = ? AND permit_recorded = 1 AND terminal = 0 AND dispatch_seq IS NOT NULL`).get(connection.connection_id) as { n: number };
    return { valid: (connection.status === 'ready' || connection.status === 'draining') && pending.n > 0 };
  }
  if (request.action === 'enable' && !request.proof) {
    if (connection.status !== 'needs_enable' || !connection.current_test_id) return { valid: false };
    const current = resources.db.prepare('SELECT status FROM channel_tests WHERE test_id = ?').get(connection.current_test_id) as { status: string } | undefined;
    return { valid: current?.status === 'verified' };
  }
  if (request.action !== 'enable' || !request.proof) return { valid: false };
  if (connection.status !== 'needs_enable' || request.proof.connection_id !== connection.connection_id) return { valid: false };
  if (request.proof.test_id !== connection.current_test_id || request.proof.account_id !== connection.account_id) return { valid: false };
  if (
    request.proof.binding_revision !== connection.binding_revision
    || request.proof.config_revision !== connection.config_revision
    || request.proof.credential_version !== connection.credential_version
    || request.proof.incarnation !== connection.channel_incarnation
    || request.proof.epoch !== connection.connection_epoch
  ) return { valid: false };
  const test = resources.db.prepare('SELECT status, preview_hash FROM channel_tests WHERE test_id = ?').get(request.proof.test_id) as {
    status: string;
    preview_hash: string;
  } | undefined;
  return { valid: Boolean(test && test.status === 'verified' && test.preview_hash === request.proof.preview_hash) };
}

async function applyFeishu(ready: SettingsReady, input: unknown): Promise<{ effects: Array<{ item: string; effect: string }> }> {
  const request = settingsRequest(input);
  const validation = await runSettingsOperation('validate', request) as { valid: boolean };
  if (!validation.valid) throw new Error('BINDING_STALE');
  const resources = ready();
  const connection = findSettingsConnection(resources, request);
  if (!connection) throw new Error('NOT_FOUND');
  const channel = createFeishuChannel(resources.db, {
    now: resources.now,
    hub: resources.hub,
    encode: encodeHubAnswer,
    domain: connection.data_domain,
    connectionId: connection.connection_id,
  });
  if (request.action === 'enable') {
    if (!request.proof) throw new Error('UNPROCESSABLE');
    await channel.applyTrustedEnable(request.proof);
    return { effects: [{ item: 'enable', effect: 'ready' }] };
  }
  const disabled = await channel.disableWhileHubIsUncertain();
  return { effects: [{ item: 'disable', effect: disabled.status }] };
}

function recheckFeishu(ready: SettingsReady, input: unknown): { ok: boolean; checked_at: string; status: string } {
  const request = settingsRequest(input);
  const resources = ready();
  const connection = findSettingsConnection(resources, request);
  const status = connection?.status ?? 'not_configured';
  return {
    ok: status === 'ready' || status === 'disabled' || status === 'draining' || status === 'needs_enable',
    checked_at: resources.now().toISOString(),
    status,
  };
}

async function command(
  c: Context,
  ready: Ready,
  operation: string,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } },
  receiptPath: string,
  run: (resources: ReturnType<Ready>, principal: Principal, payload: unknown) => string | Promise<string>,
  atomic = false,
): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requirePermission(c.req.raw, 'owner');
  const parsed = schema.safeParse(await readJson(c.req.raw));
  if (!parsed.success || !parsed.data) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as Envelope<unknown>;
  assertPayloadHash((body.payload ?? {}) as Json, body.payload_hash);
  const resources = ready();
  const domain = principal.domains[0] ?? 'personal';
  const prior = findCommand(resources.db, principal, body.client_request_id);
  if (prior) {
    assertReplay(prior, operation, domain, body.expected_revision, body.payload_hash);
    return c.json(accepted(prior.command_id, receiptPath, prior.resource_id), 202);
  }
  if (atomic) {
    let resourceId = '';
    const commandId = withImmediateTransaction(resources.db, () => {
      const outcome = run(resources, principal, body.payload);
      if (typeof outcome !== 'string') throw new Error('ASYNC_COMMAND_HANDLER');
      resourceId = outcome;
      return storeCommand(resources, principal, operation, resourceId, domain, body.client_request_id, body.expected_revision, body.payload_hash);
    });
    return c.json(accepted(commandId, receiptPath, resourceId), 202);
  }
  const resourceId = await run(resources, principal, body.payload);
  const commandId = storeCommand(resources, principal, operation, resourceId, domain, body.client_request_id, body.expected_revision, body.payload_hash);
  return c.json(accepted(commandId, receiptPath, resourceId), 202);
}

function replay(
  c: Context,
  prior: StoredCommand,
  operation: string,
  domain: string,
  expectedRevision: number | null,
  payloadHash: string,
  receiptUrl: string,
): Response {
  assertReplay(prior, operation, domain, expectedRevision, payloadHash);
  return c.json({ command_id: prior.command_id, state: 'received', receipt_url: receiptUrl }, 202);
}

function assertReplay(
  prior: StoredCommand,
  operation: string,
  domain: string,
  expectedRevision: number | null,
  payloadHash: string,
): void {
  const fingerprint = commandFingerprint({
    operation,
    resource_id: prior.resource_id,
    data_domain: domain,
    expected_revision: expectedRevision,
    payload_hash: payloadHash,
  });
  if (fingerprint !== prior.command_fingerprint) throw new ApiError(409, 'CONFLICT', { reason: 'idempotency' });
}

function storeCommand(
  resources: ReturnType<Ready>,
  principal: Principal,
  operation: string,
  resourceId: string,
  domain: string,
  clientRequestId: string,
  expectedRevision: number | null,
  payloadHash: string,
): string {
  const fingerprint = commandFingerprint({
    operation,
    resource_id: resourceId,
    data_domain: domain,
    expected_revision: expectedRevision,
    payload_hash: payloadHash,
  });
  const commandId = randomUUID();
  return withImmediateTransaction(resources.db, () => {
    const stored = recordCommand(resources.db, {
      account_id: principal.account_id,
      caller_id: principal.caller_id,
      client_request_id: clientRequestId,
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
    return stored.command_id;
  });
}

type StoredCommand = { command_id: string; command_fingerprint: string; resource_id: string };

function findCommand(db: SqliteDatabase, principal: Principal, clientRequestId: string): StoredCommand | undefined {
  return db.prepare(`SELECT i.command_id, i.command_fingerprint, r.resource_id
    FROM command_inbox i
    JOIN command_records r ON r.command_id = i.command_id
    WHERE i.account_id = ? AND i.caller_id = ? AND i.client_request_id = ?`).get(
    principal.account_id,
    principal.caller_id,
    clientRequestId,
  ) as StoredCommand | undefined;
}

function accepted(commandId: string, receiptPath: string, resourceId: string) {
  if (receiptPath === 'channels/feishu') {
    return { command_id: commandId, state: 'received' as const, receipt_url: '/api/v1/channels/feishu' };
  }
  const receiptUrl = receiptPath.endsWith(`/${resourceId}`)
    ? `/api/v1/${receiptPath}`
    : `/api/v1/${receiptPath}/${resourceId}`;
  return { command_id: commandId, state: 'received' as const, receipt_url: receiptUrl };
}

type SettingsConnection = {
  connection_id: string;
  account_id: string;
  data_domain: string;
  status: string;
  current_test_id: string | null;
  binding_revision: number;
  config_revision: number;
  credential_version: number;
  channel_incarnation: number;
  connection_epoch: number;
};

function findSettingsConnection(resources: ReturnType<SettingsReady>, request: SettingsRequest): SettingsConnection | undefined {
  if (request.connection_id) {
    return resources.db.prepare(`SELECT connection_id, account_id, data_domain, status, current_test_id, binding_revision,
      config_revision, credential_version, channel_incarnation, connection_epoch
      FROM channel_connections WHERE connection_id = ?`).get(request.connection_id) as SettingsConnection | undefined;
  }
  if (!request.account_id) return undefined;
  return resources.db.prepare(`SELECT connection_id, account_id, data_domain, status, current_test_id, binding_revision,
    config_revision, credential_version, channel_incarnation, connection_epoch
    FROM channel_connections WHERE account_id = ? ORDER BY updated_at DESC LIMIT 1`).get(request.account_id) as SettingsConnection | undefined;
}

type SettingsRequest = {
  action?: 'enable' | 'disable';
  connection_id?: string;
  account_id?: string;
  proof?: EnableProof;
};

function settingsRequest(input: unknown): SettingsRequest {
  if (!input || typeof input !== 'object') return {};
  const record = input as Record<string, unknown>;
  const action = record.action === 'enable' || record.action === 'disable' ? record.action : undefined;
  return {
    action,
    connection_id: typeof record.connection_id === 'string' ? record.connection_id : undefined,
    account_id: typeof record.account_id === 'string' ? record.account_id : undefined,
    proof: isProof(record.proof) ? record.proof : undefined,
  };
}

function isProof(value: unknown): value is EnableProof {
  if (!value || typeof value !== 'object') return false;
  const proof = value as Partial<EnableProof>;
  return typeof proof.connection_id === 'string'
    && typeof proof.test_id === 'string'
    && typeof proof.preview_hash === 'string'
    && typeof proof.account_id === 'string'
    && typeof proof.binding_revision === 'number'
    && typeof proof.config_revision === 'number'
    && typeof proof.credential_version === 'number'
    && typeof proof.incarnation === 'number'
    && typeof proof.epoch === 'number';
}

function connectionIdFor(principal: Principal): string {
  return `conn_${sha256(principal.account_id).slice(0, 12)}`;
}

function routeRequest(operationId: string) {
  const route = routes.find((item) => item.operationId === operationId);
  if (!route) throw new Error(`ROUTE_MISSING:${operationId}`);
  return route.request;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
