import { createHash, randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { routes, type Json } from '@patrick/contracts';
import type { CredentialStore } from '@patrick/host';
import { commandFingerprint, recordCommand, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { encodeHubAnswer, type LocalHubPort } from '@patrick/integrations/autoloop/answers';
import { channelPermit, createAnswerGate, type AnswerPayload } from '../../../../packages/domain/src/answer-gate.js';
import { createFeishuChannel, type EnableProof } from '../../../../packages/integrations/feishu/connection.js';
import { claimFeishuOutboundTest, dispatchClaimedFeishuTest, type FeishuOutboundLifetime, type FeishuTestOutbound } from '../../../../packages/integrations/feishu/outbound.js';
import { assertDomainPermission, browserAuthority, domainsWithPermission, requireSession, snapshot, type Principal } from '../auth.js';
import { ApiError } from '../errors.js';
import { assertBusinessWrite } from '../recovery-runtime.js';
import { registerSettingsOperation, runSettingsOperation, runSettingsOperationNow } from '../settings/registry.js';
import { assertPayloadHash, assertWriteOrigin, handle, readJson, requirePermission, routeId } from './http.js';

type Ready = () => {
  db: SqliteDatabase; now: () => Date; hub: LocalHubPort; feishuCredentials?: CredentialStore; feishuTestOutbound?: FeishuTestOutbound;
  feishuOutboundLifetime?: FeishuOutboundLifetime;
};
type PairingCodes = Map<string, { code: string; expires_at: string; connection_id: string }>;
function secureSetupOrigin(): string {
  return browserAuthority().origin.replace(/^http:/u, 'https:');
}
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
  const pairingCodes: PairingCodes = new Map();
  app.get('/api/v1/channels/feishu', (c) => handle(c, () => readChannel(c, ready)));
  app.post('/api/v1/channels/feishu/inspections', (c) => handle(c, () => inspectChannel(c, ready)));
  app.post('/api/v1/channels/feishu/validations', (c) => handle(c, () => validateChannel(c, ready)));
  app.post('/api/v1/channels/feishu/inbound', (c) => handle(c, () => postInbound(c, ready)));
  app.post('/api/v1/channels/feishu/credentials', (c) => handle(c, () => putCredential(c, ready)));
  app.post('/api/v1/channels/feishu/bindings', (c) => handle(c, () => createBinding(c, ready, pairingCodes)));
  app.post('/api/v1/channels/feishu/bindings/:id/confirm', (c) => handle(c, () => confirmBinding(c, ready)));
  app.get('/api/v1/channels/feishu/bindings/:id', (c) => handle(c, () => readBinding(c, ready, pairingCodes)));
  app.post('/api/v1/channels/feishu/tests', (c) => handle(c, () => createTest(c, ready)));
  app.post('/api/v1/channels/feishu/tests/:id/send', (c) => handle(c, () => sendTest(c, ready, routeId(c.req.param('id')))));
  app.post('/api/v1/notifications/test', (c) => handle(c, () => sendTest(c, ready)));
  app.get('/api/v1/channels/feishu/tests/:id', (c) => handle(c, () => readTest(c, ready)));
}

async function readChannel(c: Context, ready: Ready): Promise<Response> {
  const principal = await requireSession(c.req.raw);
  const { db, now } = ready();
  const domain = readChannelDomain(db, principal);
  const row = db.prepare(`SELECT status, reason_code, transport_mode FROM channel_connections
    WHERE account_id = ? AND data_domain = ? ORDER BY updated_at DESC LIMIT 1`).get(principal.account_id, domain);
  return c.json(snapshot(principal, row ?? { status: 'not_configured', reason_code: null, transport_mode: 'probe' }, now(), db));
}

async function putCredential(c: Context, ready: Ready): Promise<Response> {
  assertFeishuOrigin(c.req.raw);
  const principal = await requirePermission(c.req.raw, 'owner');
  if (new URL(c.req.url).origin !== secureSetupOrigin() || c.req.header('origin') !== secureSetupOrigin()) {
    throw new ApiError(409, 'CONFLICT', { reason: 'tls_required' });
  }
  const { feishuCredentials, db, now } = ready();
  // The general session credential store is not an admitted system provider for Feishu.
  if (!feishuCredentials) throw new ApiError(503, 'UNAVAILABLE', { reason: 'credential_provider_not_configured' });
  if (principal.caller_id !== 'web') throw new ApiError(403, 'FORBIDDEN', { reason: 'caller' });
  const body = await readJson(c.req.raw) as { app_id?: unknown; app_secret?: unknown } | null;
  if (typeof body?.app_id !== 'string' || !body.app_id.trim() || body.app_id.length > 200 ||
      typeof body.app_secret !== 'string' || !body.app_secret.trim() || body.app_secret.length > 1024) {
    throw new ApiError(422, 'UNPROCESSABLE', { reason: 'credential' });
  }
  const secret = new TextEncoder().encode(body.app_secret);
  const appId = body.app_id.trim();
  c.header('Cache-Control', 'no-store');
  try {
    const ref = withImmediateTransaction(db, () => {
      const domain = channelDomain(db, principal, 'owner');
      assertBusinessWrite(db, domain);
      // Bootstrap never rotates credentials or modifies an existing binding. Those
      // transitions need a separate Settings proof and a live connection fence.
      if (db.prepare('SELECT 1 FROM channel_connections WHERE account_id = ?').get(principal.account_id)) {
        throw new ApiError(409, 'CONFLICT', { reason: 'connection_already_exists' });
      }
      const stamped = now().toISOString();
      assertBusinessWrite(db, domain);
      let credentialRef: string;
      try { credentialRef = feishuCredentials.put(secret, 10 * 60 * 1000); }
      catch { throw new ApiError(503, 'UNAVAILABLE', { reason: 'credential_store' }); }
      assertBusinessWrite(db, domain);
      db.prepare(`INSERT INTO channel_connections (
        connection_id, account_id, data_domain, app_id, tenant_key, credential_ref, credential_version,
        config_revision, channel_incarnation, connection_epoch, binding_revision, current_pairing_id, current_test_id,
        owner_open_id, chat_id, status, transport_mode, reason_code, cutoff_seq, schema_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending-tenant', ?, 1, 1, 1, 1, 1, NULL, NULL, NULL, NULL,
        'needs_binding', 'probe', 'NATIVE_PROBE_REQUIRED', NULL, '1.0', ?, ?)`).run(
        connectionIdFor(principal), principal.account_id, domain, appId, credentialRef, stamped, stamped,
      );
      return credentialRef;
    });
    return c.json({ credential_ref: ref, version: 1 });
  } finally {
    secret.fill(0);
  }
}

async function createBinding(c: Context, ready: Ready, codes: PairingCodes): Promise<Response> {
  let transient: { pairing_id: string; code: string; expires_at: string; connection_id: string } | undefined;
  const response = await command(c, ready, 'createFeishuBinding', bindingRequest, 'channels/feishu/bindings', (resources, principal) => {
    const row = assertProbe(resources.db, principal, 'needs_binding');
    assertPairingProbe(row);
    const pairing = feishu(resources, principal).createPairing();
    transient = { ...pairing, connection_id: row.connection_id };
    return pairing.pairing_id;
  }, { atomic: true });
  if (transient) {
    const now = ready().now().toISOString();
    for (const [id, entry] of codes) {
      if (entry.expires_at <= now || entry.connection_id === transient.connection_id) codes.delete(id);
    }
    if (codes.size >= 1000) codes.delete(codes.keys().next().value!);
    codes.set(transient.pairing_id, transient);
  }
  return response;
}

async function confirmBinding(c: Context, ready: Ready): Promise<Response> {
  const pairingId = routeId(c.req.param('id'));
  return command(c, ready, 'confirmFeishuBinding', confirmRequest, `channels/feishu/bindings/${pairingId}`, (resources, principal) => {
    assertPairingProbe(assertProbe(resources.db, principal, 'needs_binding'));
    feishu(resources, principal).confirmPairing(principal, pairingId);
    return pairingId;
  }, { atomic: true, pathResourceId: pairingId });
}

async function readBinding(c: Context, ready: Ready, codes: PairingCodes): Promise<Response> {
  const principal = await requireSession(c.req.raw);
  const requested = routeId(c.req.param('id'));
  const { db, now, feishuCredentials, feishuTestOutbound, feishuOutboundLifetime } = ready();
  const domain = readChannelDomain(db, principal);
  const connection = db.prepare(`SELECT connection_id, app_id, current_test_id, current_pairing_id, owner_open_id,
      tenant_key, reason_code, status, transport_mode
    FROM channel_connections WHERE connection_id = ? AND account_id = ? AND data_domain = ?`).get(
    connectionIdFor(principal), principal.account_id, domain,
  ) as { connection_id: string; app_id: string; current_test_id: string | null; current_pairing_id: string | null; owner_open_id: string | null;
    tenant_key: string; reason_code: string | null; status: string; transport_mode: string } | undefined;
  const current = requested === 'current';
  const pairingId = current ? connection?.current_pairing_id : requested;
  const stamped = now();
  c.header('Cache-Control', 'no-store');
  const pairing = pairingId && connection ? db.prepare(`SELECT pairing_id, status, expires_at, candidate_open_id
    FROM channel_pairings WHERE pairing_id = ? AND connection_id = ? AND account_id = ? AND data_domain = ?`).get(
    pairingId, connection.connection_id, principal.account_id, domain,
  ) as { pairing_id: string; status: string; expires_at: string; candidate_open_id: string | null } | undefined : undefined;
  if (!current && !pairing) throw new ApiError(404, 'NOT_FOUND');
  const owner = principal.caller_id === 'web' && domainsWithPermission(db, principal, 'owner', false).includes(domain);
  const isCurrent = !!pairing && pairing.pairing_id === connection?.current_pairing_id;
  const expired = !!pairing && pairing.status !== 'consumed' &&
    (!isCurrent || pairing.status === 'expired' || pairing.expires_at <= stamped.toISOString());
  const disclose = !current && isCurrent && pairing.status === 'open' && !expired && owner &&
    new URL(c.req.url).origin === secureSetupOrigin();
  const code = disclose && pairingId ? codes.get(pairingId)?.code ?? null : null;
  if ((code || expired) && pairingId) codes.delete(pairingId);
  const summary = {
    credential_setup_available: owner && !!feishuCredentials && new URL(c.req.url).origin === secureSetupOrigin(),
    transport_available: owner && !!feishuTestOutbound && !!feishuOutboundLifetime && !feishuOutboundLifetime.signal.aborted &&
      !!connection?.owner_open_id && connection.transport_mode === 'probe' &&
      (connection.status === 'needs_test' || connection.status === 'needs_enable') && admittedPairingProbe(connection),
    owner_actions_available: owner,
    data_domain: domain, app_id: connection?.app_id ?? null, destination: connection?.owner_open_id ?? null,
    current_test_id: connection?.current_test_id ?? null, code,
  };
  return c.json(snapshot(principal, {
    ...summary, pairing_id: pairing?.pairing_id ?? null, expires_at: pairing?.expires_at ?? null,
    status: expired ? 'expired' : pairing?.status ?? null, candidate_open_id: pairing?.candidate_open_id ?? null,
  }, stamped, db));
}

async function createTest(c: Context, ready: Ready): Promise<Response> {
  return command(c, ready, 'createFeishuTest', testRequest, 'channels/feishu/tests', (resources, principal, body) => {
    const destination = (body as { destination?: string }).destination;
    if (!destination) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'destination' });
    const rowBefore = assertProbe(resources.db, principal, 'needs_test');
    const prior = resources.db.prepare('SELECT status FROM channel_tests WHERE test_id = ?').get(rowBefore.current_test_id) as
      { status: string } | undefined;
    if (prior && ['sending', 'sent', 'unknown'].includes(prior.status)) {
      throw new ApiError(409, 'CONFLICT', { reason: 'test_reconciliation_required' });
    }
    feishu(resources, principal).createTest(destination);
    const row = resources.db.prepare('SELECT current_test_id FROM channel_connections WHERE connection_id = ?').get(
      connectionIdFor(principal),
    ) as { current_test_id: string | null } | undefined;
    if (!row?.current_test_id) throw new Error('TEST_MISSING');
    return row.current_test_id;
  }, { atomic: true });
}

async function sendTest(c: Context, ready: Ready, pathTestId?: string): Promise<Response> {
  assertFeishuOrigin(c.req.raw);
  const parsed = sendRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const principal = await requirePermission(c.req.raw, 'owner');
  if (principal.caller_id !== 'web') throw new ApiError(403, 'FORBIDDEN', { reason: 'caller' });
  const { payload, payload_hash, client_request_id, expected_revision } = parsed.data as Envelope<{
    test_id: string; preview_hash: string; destination: string;
  }>;
  assertPayloadHash(payload, payload_hash);
  const testId = payload.test_id;
  if (pathTestId !== undefined && pathTestId !== testId) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'test' });
  const resources = ready();
  const { db, feishuTestOutbound, feishuOutboundLifetime } = resources;
  const operation = 'sendFeishuTest';
  const receiptPath = 'channels/feishu/tests';
  const claimed = withImmediateTransaction(db, () => {
    const domain = channelDomain(db, principal, 'owner');
    const prior = findCommand(db, principal, client_request_id);
    if (prior) {
      assertReplay(prior, operation, domain, expected_revision, payload_hash, testId);
      return { commandId: prior.command_id };
    }
    const connection = assertProbe(db, principal, 'needs_test');
    try {
      feishu(resources, principal).assertTestPreview(payload);
    } catch (error) {
      if (error instanceof Error && (error.message === 'BINDING_STALE' || error.message === 'NOT_FOUND')) {
        throw new ApiError(409, 'CONFLICT', { reason: 'stale_test_preview' });
      }
      throw error;
    }
    if (!feishuTestOutbound || !feishuOutboundLifetime) throw new ApiError(503, 'UNAVAILABLE', { reason: 'transport_not_configured' });
    if (feishuOutboundLifetime.signal.aborted) throw new ApiError(503, 'UNAVAILABLE', { reason: 'service_stopping' });
    assertPairingProbe(connection);
    const test = claimFeishuOutboundTest(db, payload, {
      account_id: principal.account_id, data_domain: domain, connection_id: connection.connection_id,
    }, resources.now().toISOString());
    if (!test) throw new ApiError(409, 'CONFLICT', { reason: 'stale_test_preview' });
    const commandId = storeCommand(resources, principal, operation, testId, domain, client_request_id, expected_revision, payload_hash);
    // The injected clock can synchronously stop the owner while recording the command.
    if (feishuOutboundLifetime.signal.aborted) throw new ApiError(503, 'UNAVAILABLE', { reason: 'service_stopping' });
    return { test, commandId, adapter: feishuTestOutbound, lifetime: feishuOutboundLifetime };
  });
  if (claimed.test) {
    try { await dispatchClaimedFeishuTest(db, claimed.adapter, claimed.test, resources.now, claimed.lifetime); }
    catch (error) {
      if (error instanceof Error && error.message === 'FEISHU_TEST_STALE') {
        throw new ApiError(409, 'CONFLICT', { reason: 'stale_test_preview' });
      }
      throw error;
    }
  }
  return c.json(accepted(claimed.commandId, receiptPath, testId), 202, { 'Cache-Control': 'no-store' });
}

async function readTest(c: Context, ready: Ready): Promise<Response> {
  const principal = await requireSession(c.req.raw);
  const testId = routeId(c.req.param('id'));
  const { db, now } = ready();
  const domain = readChannelDomain(db, principal);
  const row = db.prepare(`SELECT test_id, status, preview_hash, destination, message_id, inbound_evidence, app_id, tenant_key,
    config_revision, credential_version, binding_id, data_domain, incarnation, epoch
    FROM channel_tests WHERE test_id = ? AND connection_id = ? AND account_id = ? AND data_domain = ?`).get(
    testId, connectionIdFor(principal), principal.account_id, domain,
  );
  if (!row) throw new ApiError(404, 'NOT_FOUND');
  return c.json(snapshot(principal, row, now(), db));
}

function assertFeishuOrigin(request: Request): void {
  if (new URL(request.url).origin === secureSetupOrigin() && request.headers.get('origin') === secureSetupOrigin()) return;
  assertWriteOrigin(request);
}

function readChannelDomain(db: SqliteDatabase, principal: Principal): string {
  const domain = principal.domains[0] ?? 'personal';
  if (!domainsWithPermission(db, principal, 'channels.read').includes(domain)) throw new ApiError(404, 'NOT_FOUND');
  return domain;
}

function channelDomain(db: SqliteDatabase, principal: Principal, permission: string): string {
  const domain = principal.domains[0] ?? 'personal';
  assertDomainPermission(db, principal, domain, permission);
  return domain;
}

function assertProbe(db: SqliteDatabase, principal: Principal, status: string) {
  if (principal.caller_id !== 'web') throw new ApiError(403, 'FORBIDDEN', { reason: 'caller' });
  const domain = channelDomain(db, principal, 'owner');
  const row = db.prepare(`SELECT connection_id, current_test_id, status, transport_mode, tenant_key, reason_code FROM channel_connections
    WHERE connection_id = ? AND account_id = ? AND data_domain = ?`).get(connectionIdFor(principal), principal.account_id, domain) as {
    connection_id: string; current_test_id: string | null; status: string; transport_mode: string;
    tenant_key: string; reason_code: string | null;
  } | undefined;
  if (row?.status !== status || row.transport_mode !== 'probe') throw new ApiError(409, 'CONFLICT', { reason: 'channel_stage' });
  return row;
}

function assertPairingProbe(row: ReturnType<typeof assertProbe>): void {
  if (!admittedPairingProbe(row)) {
    throw new ApiError(409, 'CONFLICT', { reason: 'native_probe_required' });
  }
}

function admittedPairingProbe(row: { tenant_key: string; reason_code: string | null }): boolean {
  return row.tenant_key !== 'pending-tenant' && row.reason_code !== 'NATIVE_PROBE_REQUIRED';
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
  options: { atomic?: boolean; pathResourceId?: string } = {},
): Promise<Response> {
  assertFeishuOrigin(c.req.raw);
  const principal = await requirePermission(c.req.raw, 'owner');
  const parsed = schema.safeParse(await readJson(c.req.raw));
  if (!parsed.success || !parsed.data) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as Envelope<unknown>;
  assertPayloadHash((body.payload ?? {}) as Json, body.payload_hash);
  const resources = ready();
  const domain = channelDomain(resources.db, principal, 'owner');
  const prior = findCommand(resources.db, principal, body.client_request_id);
  if (prior) {
    assertReplay(prior, operation, domain, body.expected_revision, body.payload_hash, options.pathResourceId);
    return c.json(accepted(prior.command_id, receiptPath, prior.resource_id), 202);
  }
  if (options.atomic) {
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
  requestedResourceId = prior.resource_id,
): void {
  const fingerprint = commandFingerprint({
    operation,
    resource_id: requestedResourceId,
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
      const createdAt = resources.now().toISOString();
      const target = authorityCommandTarget(resources.db, principal, operation, resourceId);
      if (target) {
        assertDomainPermission(resources.db, principal, target.data_domain, 'owner', false);
        assertBusinessWrite(resources.db, target.data_domain);
        if (target.data_domain !== domain) throw new ApiError(409, 'CONFLICT', { reason: 'scope' });
      }
      resources.db.prepare(`INSERT INTO command_records (
        command_id, account_id, caller_id, operation, resource_id, data_domain, permission, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'owner', ?)`).run(
        stored.command_id,
        principal.account_id,
        principal.caller_id,
        operation,
        resourceId,
        domain,
        createdAt,
      );
    }
    return stored.command_id;
  });
}

function authorityCommandTarget(db: SqliteDatabase, principal: Principal, operation: string, resourceId: string) {
  let query: string;
  switch (operation) {
    case 'createFeishuBinding':
    case 'confirmFeishuBinding':
      query = 'SELECT c.data_domain FROM channel_pairings p JOIN channel_connections c USING(connection_id) WHERE p.pairing_id=? AND c.account_id=?';
      break;
    case 'createFeishuTest':
    case 'sendFeishuTest':
      query = 'SELECT c.data_domain FROM channel_tests t JOIN channel_connections c USING(connection_id) WHERE t.test_id=? AND c.account_id=?';
      break;
    case 'acceptFeishuInbound':
      query = 'SELECT data_domain FROM answer_receipts WHERE receipt_id=? AND account_id=?';
      break;
    default: return;
  }
  const target = db.prepare(query).get(resourceId, principal.account_id) as { data_domain: string } | undefined;
  if (!target) throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  return target;
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
