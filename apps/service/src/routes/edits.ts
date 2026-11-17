import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { routes, type Json } from '@patrick/contracts';
import { commandFingerprint, recordCommand, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import type { EditIntentRequest, createVaultApi } from '@patrick/integrations/vault/drafts';
import { assertDomainPermission, domainsWithPermission, snapshot, type Principal } from '../auth.js';
import { ApiError } from '../errors.js';
import { domainPrincipal, learningDomain, queryParameter, vaultRelativePath } from './learning-scope.js';
import { assertPayloadHash, assertWriteOrigin, handle, readJson, requirePermission, routeId } from './http.js';

type VaultApi = ReturnType<typeof createVaultApi>;
type Ready = () => { db: SqliteDatabase; api: VaultApi; now: () => Date };
type Envelope<T> = { client_request_id: string; expected_revision: number | null; payload_hash: string; payload: T };

const createRequest = routeRequest('createEdit');
const retryRequest = routeRequest('retryEditProjection');
const checkRequest = routeRequest('checkEdit');

export function mountEditRoutes(app: Hono, ready: Ready): void {
  app.post('/api/v1/edits', (c) => handle(c, () => create(c, ready)));
  app.get('/api/v1/edits/:id', (c) => handle(c, () => readEdit(c, ready)));
  app.get('/api/v1/edits/:id/destination', (c) => handle(c, () => readDestination(c, ready)));
  app.post('/api/v1/edits/:id/checks', (c) => handle(c, () => check(c, ready)));
  app.post('/api/v1/edits/:id/projection-retries', (c) => handle(c, () => retry(c, ready)));
}

async function create(c: Context, ready: Ready): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requirePermission(c.req.raw, 'edits.write');
  const parsed = createRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as Envelope<EditIntentRequest>;
  if (body.expected_revision !== null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'expected_revision' });
  assertPayloadHash(body.payload as unknown as Json, body.payload_hash);
  const { db, api } = ready();
  const vault = connectedVault(db, principal, body.payload.vault_id);
  const commandId = existingCommand(db, principal, body.client_request_id, fingerprint(body, vault));
  if (commandId) return c.json(accepted(commandId, commandEditId(db, commandId)), 202);
  const edit = await api.createEdit(domainPrincipal(db, principal, vault.data_domain), { ...body.payload, vault_id: vault.vault_id });
  const created = storeCommand(db, principal, {
    operation: 'createEdit',
    resourceId: edit.edit_id,
    dataDomain: vault.data_domain,
    clientRequestId: body.client_request_id,
    expectedRevision: null,
    payloadHash: body.payload_hash,
    permission: 'edits.write',
    fingerprint: fingerprint(body, vault),
  });
  return c.json(accepted(created, edit.edit_id), 202);
}

async function readEdit(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'edits.read');
  const { db, now } = ready();
  const editId = routeId(c.req.param('id'));
  const intent = db.prepare('SELECT account_id, data_domain FROM edit_intents WHERE edit_id = ?').get(editId) as {
    account_id: string;
    data_domain: string;
  } | undefined;
  const domain = learningDomain(db, principal, 'edits.read', queryParameter(c, 'domain'));
  if (!intent || intent.account_id !== principal.account_id || intent.data_domain !== domain) {
    throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  }
  const row = db.prepare(`SELECT edit_id, receipt_revision, file_state, file_proof_ref, business_state, candidate_id,
      result_ref, projection_state, projection_intent_id, projection_revision, superseded_by
    FROM edit_receipts WHERE edit_id = ? ORDER BY receipt_revision DESC LIMIT 1`).get(editId) as {
    edit_id: string;
    receipt_revision: number;
    file_state: 'preparing' | 'awaiting_save' | 'collected' | 'invalid' | 'conflict';
    file_proof_ref: string | null;
    business_state: 'not_started' | 'pending' | 'verifying' | 'evaluating' | 'adopted' | 'not_adopted' | 'stale';
    candidate_id: string | null;
    result_ref: string | null;
    projection_state: 'not_due' | 'pending' | 'current' | 'failed' | 'cleanup_pending' | 'superseded';
    projection_intent_id: string | null;
    projection_revision: number | null;
    superseded_by: string | null;
  } | undefined;
  if (!row) throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  return c.json(snapshot({ ...principal, domains: [domain] }, {
    edit_id: row.edit_id,
    receipt_revision: row.receipt_revision,
    file: { state: row.file_state, proof_ref: row.file_proof_ref },
    business: { state: row.business_state, candidate_id: row.candidate_id, result_ref: row.result_ref },
    projection: {
      state: row.projection_state,
      intent_id: row.projection_intent_id,
      projection_revision: row.projection_revision,
      superseded_by: row.superseded_by,
    },
  }, now(), db));
}

async function readDestination(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'edits.read');
  const { db, now } = ready();
  const domain = learningDomain(db, principal, 'edits.read', queryParameter(c, 'domain'));
  const target = db.prepare(`SELECT e.vault_id,e.relative_path,e.document_id,
    COALESCE(d.observed_seq,CASE WHEN e.operation='edit_original' THEN e.base_version ELSE 0 END) AS observed_seq
    FROM edit_intents e JOIN vaults v ON v.vault_id=e.vault_id AND v.account_id=e.account_id AND v.data_domain=e.data_domain
    LEFT JOIN vault_documents d ON d.document_id=e.document_id AND d.account_id=e.account_id
      AND d.data_domain=e.data_domain AND d.vault_id=e.vault_id
    WHERE e.edit_id=? AND e.account_id=? AND e.data_domain=? AND v.status='connected'`)
    .get(routeId(c.req.param('id')), principal.account_id, domain) as {
      vault_id: string; relative_path: string | null; document_id: string | null; observed_seq: number;
    } | undefined;
  if (!target?.document_id || !target.relative_path || !vaultRelativePath(target.relative_path)) {
    throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  }
  return c.json(snapshot({ ...principal, domains: [domain] }, target, now(), db));
}

async function check(c: Context, ready: Ready): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requirePermission(c.req.raw, 'edits.write');
  const parsed = checkRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE');
  const body = parsed.data as Envelope<Record<string, never>>;
  if (body.expected_revision === null) throw new ApiError(422, 'UNPROCESSABLE');
  assertPayloadHash(body.payload, body.payload_hash);
  const { db, api } = ready();
  const editId = routeId(c.req.param('id'));
  const row = db.prepare('SELECT account_id,data_domain FROM edit_intents WHERE edit_id=?').get(editId) as {
    account_id: string; data_domain: string;
  } | undefined;
  if (!row || row.account_id !== principal.account_id) throw new ApiError(403, 'FORBIDDEN');
  const authorize = () => assertDomainPermission(db, principal, row.data_domain, 'edits.write');
  authorize();
  const fingerprint = commandFingerprint({ operation: 'checkEdit', resource_id: editId, data_domain: row.data_domain,
    expected_revision: body.expected_revision, payload_hash: body.payload_hash });
  const existing = existingCommand(db, principal, body.client_request_id, fingerprint);
  if (existing) return c.json(accepted(existing, editId), 202);
  await api.checkEdit(editId, body.expected_revision, authorize);
  const commandId = storeCommand(db, principal, { operation: 'checkEdit', resourceId: editId, dataDomain: row.data_domain,
    expectedRevision: body.expected_revision, payloadHash: body.payload_hash, clientRequestId: body.client_request_id,
    permission: 'edits.write', fingerprint });
  return c.json(accepted(commandId, editId), 202);
}

async function retry(c: Context, ready: Ready): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requirePermission(c.req.raw, 'edits.write');
  const parsed = retryRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as Envelope<{ expected_revision: number; intent_id: string; projection_revision: number }>;
  if (body.expected_revision === null || body.expected_revision !== body.payload.expected_revision) {
    throw new ApiError(409, 'CONFLICT', { reason: 'revision' });
  }
  assertPayloadHash(body.payload as unknown as Json, body.payload_hash);
  const { db, api } = ready();
  const editId = routeId(c.req.param('id'));
  const intent = db.prepare('SELECT account_id, data_domain FROM edit_intents WHERE edit_id = ?').get(editId) as {
    account_id: string;
    data_domain: string;
  } | undefined;
  if (!intent || intent.account_id !== principal.account_id || !principal.domains.includes(intent.data_domain)) {
    throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  }
  assertDomainPermission(db, principal, intent.data_domain, 'edits.write');
  const fingerprint = commandFingerprint({
    operation: 'retryEditProjection', resource_id: editId, data_domain: intent.data_domain,
    expected_revision: body.expected_revision, payload_hash: body.payload_hash,
  });
  const existing = existingCommand(db, principal, body.client_request_id, fingerprint);
  if (existing) return c.json(accepted(existing, editId), 202);
  await api.retryAdoptedProjection(editId, {
    receiptRevision: body.expected_revision, intentId: body.payload.intent_id, projectionRevision: body.payload.projection_revision,
  }, () => assertDomainPermission(db, principal, intent.data_domain, 'edits.write'));
  const commandId = storeCommand(db, principal, {
    operation: 'retryEditProjection', resourceId: editId, dataDomain: intent.data_domain,
    clientRequestId: body.client_request_id, expectedRevision: body.expected_revision, payloadHash: body.payload_hash,
    permission: 'edits.write', fingerprint,
  });
  return c.json(accepted(commandId, editId), 202);
}

function accepted(commandId: string, editId: string) {
  return { command_id: commandId, state: 'received' as const, receipt_url: `/api/v1/edits/${editId}` };
}

function fingerprint(body: Envelope<EditIntentRequest>, vault: { vault_id: string; data_domain: string }): string {
  return commandFingerprint({
    operation: 'createEdit',
    resource_id: vault.vault_id,
    data_domain: vault.data_domain,
    expected_revision: body.expected_revision,
    payload_hash: body.payload_hash,
  });
}

function connectedVault(db: SqliteDatabase, principal: Principal, vaultId?: string): { vault_id: string; data_domain: string } {
  const rows = db.prepare(`SELECT vault_id, data_domain FROM vaults WHERE account_id=? AND status='connected' AND (? IS NULL OR vault_id=?)`).all(principal.account_id, vaultId ?? null, vaultId ?? null) as {
    vault_id: string;
    data_domain: string;
  }[];
  const domains = domainsWithPermission(db, principal, 'edits.write');
  const visible = rows.filter((row) => domains.includes(row.data_domain) && (vaultId !== undefined || row.data_domain === principal.domains[0]));
  const chosen = visible[0];
  if (!chosen || visible.length !== 1) throw new ApiError(403, 'FORBIDDEN', { reason: 'vault' });
  return chosen;
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

function commandEditId(db: SqliteDatabase, commandId: string): string {
  const row = db.prepare('SELECT resource_id FROM command_records WHERE command_id = ?').get(commandId) as { resource_id: string } | undefined;
  if (!row) throw new ApiError(409, 'CONFLICT', { reason: 'command' });
  return row.resource_id;
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
