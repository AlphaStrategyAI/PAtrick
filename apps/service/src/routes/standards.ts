import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { routes, type Json } from '@patrick/contracts';
import { commandFingerprint, recordCommand, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { createStandardsApi, type StandardsPrincipal } from '../../../../packages/domain/src/standards.js';
import type { createVaultApi } from '@patrick/integrations/vault/drafts';
import { assertDomainPermission, snapshot, type Principal } from '../auth.js';
import { ApiError } from '../errors.js';
import { domainPrincipal, learningDomain, queryParameter, vaultRelativePath } from './learning-scope.js';
import { assertPayloadHash, assertWriteOrigin, handle, readJson, requirePermission, routeId } from './http.js';

type Ready = () => { db: SqliteDatabase; now: () => Date; api: ReturnType<typeof createVaultApi> };
type Envelope<T> = { client_request_id: string; expected_revision: number | null; payload_hash: string; payload: T };

const createRequest = routeRequest('createStandardCandidate');
const evaluateRequest = routeRequest('evaluateStandardCandidate');
const adoptRequest = routeRequest('adoptStandardCandidate');

export function mountStandardRoutes(app: Hono, ready: Ready): void {
  app.get('/api/v1/standards', (c) => handle(c, () => listStandards(c, ready)));
  app.get('/api/v1/standards/:id/edit-target', (c) => handle(c, () => standardEditTarget(c, ready)));
  app.get('/api/v1/standards/:id/versions', (c) => handle(c, () => listVersions(c, ready)));
  app.get('/api/v1/evaluations/:id', (c) => handle(c, () => readEvaluation(c, ready)));
  app.post('/api/v1/standard-candidates', (c) => handle(c, () => createCandidate(c, ready)));
  app.post('/api/v1/standard-candidates/:id/evaluations', (c) => handle(c, () => evaluateCandidate(c, ready)));
  app.post('/api/v1/standard-candidates/:id/adoptions', (c) => handle(c, () => adoptCandidate(c, ready)));
}

async function listStandards(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'standards.read');
  const { db, now } = ready();
  const domain = learningDomain(db, principal, 'standards.read', queryParameter(c, 'domain'));
  const caller = domainPrincipal(db, principal, domain);
  const standardRows = await standardsApi(db, caller, now, domain).listStandards();
  const withdrawn = db.prepare(`SELECT s.standard_id FROM standards s JOIN standard_versions sv
    ON sv.standard_id=s.standard_id AND sv.data_domain=s.data_domain AND sv.version=s.active_version AND sv.status='withdrawn'
    WHERE s.account_id=? AND s.data_domain=?`).all(principal.account_id,domain) as { standard_id: string }[];
  const degraded = new Set(withdrawn.map((row) => row.standard_id));
  const items = standardRows.map((item) => degraded.has(item.standard_id) ? { ...item, degraded: true } : item);
  return c.json(snapshot(caller, { items }, now(), db));
}

async function listVersions(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'standards.read');
  const { db, now } = ready();
  const domain = learningDomain(db, principal, 'standards.read', queryParameter(c, 'domain'));
  const caller = domainPrincipal(db, principal, domain);
  const id = routeId(c.req.param('id'));
  const versions = await standardsApi(db, caller, now, domain).listVersions(id);
  const links = db.prepare(`SELECT a.active_version,a.report_id FROM adoption_facts a
    JOIN standard_candidates c ON c.candidate_id=a.candidate_id AND c.account_id=? AND c.data_domain=a.data_domain
    WHERE a.standard_id=? AND a.data_domain=?`).all(principal.account_id,id,domain) as { active_version: number; report_id: string }[];
  const reports = new Map(links.map((link) => [link.active_version, link.report_id]));
  const items = versions.map((version) => ({ ...version, report_id: reports.get(version.version) ?? null }));
  const candidates = db.prepare(`SELECT c.candidate_id,c.status,c.base_version,c.source_revision,
    (SELECT r.report_id FROM evaluation_reports r WHERE r.candidate_id=c.candidate_id AND r.account_id=c.account_id
      AND r.data_domain=c.data_domain ORDER BY r.frozen_at DESC,r.report_id LIMIT 1) AS report_id
    FROM standard_candidates c WHERE c.standard_id=? AND c.account_id=? AND c.data_domain=? AND c.status<>'adopted'
    ORDER BY c.created_at DESC,c.candidate_id LIMIT 50`).all(id, principal.account_id,domain);
  return c.json(snapshot(caller, { items, candidates }, now(), db));
}

async function readEvaluation(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'standards.read');
  const { db, now } = ready();
  const domain = learningDomain(db, principal, 'standards.read', queryParameter(c, 'domain'));
  const caller = domainPrincipal(db, principal, domain);
  const report = await standardsApi(db, caller, now, domain).getEvaluation(routeId(c.req.param('id')));
  return c.json(snapshot(caller, report, now(), db));
}

async function standardEditTarget(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'edits.read');
  const { db, now } = ready();
  const domain = learningDomain(db, principal, 'edits.read', queryParameter(c, 'domain'));
  assertDomainPermission(db, principal, domain, 'standards.read');
  const target = db.prepare(`SELECT d.document_id,sv.source_revision AS observed_seq,r.relative_path,v.vault_id
    FROM standards s JOIN standard_versions sv ON sv.standard_id=s.standard_id AND sv.version=s.active_version
      AND sv.status='active' AND sv.data_domain=s.data_domain
    JOIN vault_documents d ON d.document_id=sv.document_id AND d.account_id=s.account_id AND d.data_domain=s.data_domain
    JOIN vault_revisions r ON r.document_id=d.document_id AND r.vault_id=d.vault_id AND r.account_id=s.account_id
      AND r.data_domain=s.data_domain AND r.observed_seq=sv.source_revision AND r.content_hash=sv.content_hash AND r.tombstone=0
    JOIN vaults v ON v.vault_id=d.vault_id AND v.account_id=s.account_id AND v.data_domain=s.data_domain AND v.status='connected'
    WHERE s.standard_id=? AND s.account_id=? AND s.data_domain=? AND d.tombstone=0`)
    .get(routeId(c.req.param('id')),principal.account_id,domain) as { relative_path: string } | undefined;
  if (!target || !vaultRelativePath(target.relative_path)) throw new ApiError(409, 'CONFLICT', { reason: 'edit_target' });
  return c.json(snapshot({ ...principal, domains: [domain] }, target, now(), db));
}

async function createCandidate(c: Context, ready: Ready): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requirePermission(c.req.raw, 'standards.write');
  const parsed = createRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as Envelope<{ standard_id: string | null; draft_key: string }>;
  if (body.expected_revision !== null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'expected_revision' });
  assertPayloadHash(body.payload as unknown as Json, body.payload_hash);
  const { db, now } = ready();
  const opened = openStandardDraft(db, principal, body.payload.draft_key);
  assertDomainPermission(db, principal, opened.intent.data_domain, 'standards.write');
  if (body.payload.standard_id !== null && body.payload.standard_id !== opened.intent.target_id) {
    throw new ApiError(409, 'CONFLICT', { reason: 'standard' });
  }
  const fingerprint = commandFingerprint({
    operation: 'createStandardCandidate',
    resource_id: opened.intent.target_id,
    data_domain: opened.document.data_domain,
    expected_revision: null,
    payload_hash: body.payload_hash,
  });
  const existing = existingCommand(db, principal, body.client_request_id, fingerprint);
  if (existing) return c.json(accepted(existing, 'createStandardCandidate', commandResource(db, existing)), 202);
  const api = standardsApi(db, principal, now, opened.intent.data_domain);
  const candidate = await api.openCandidate({
    vault_id: opened.document.vault_id,
    standard_id: opened.intent.target_id,
    draft_key: body.payload.draft_key,
    document_id: opened.document.document_id,
    source_revision: opened.document.observed_seq,
    content_hash: opened.document.content_hash,
    baseVersion: opened.intent.base_version,
    editId: opened.intent.edit_id,
  });
  const commandId = storeCommand(db, principal, {
    operation: 'createStandardCandidate',
    resourceId: candidate.standard_id,
    dataDomain: opened.document.data_domain,
    clientRequestId: body.client_request_id,
    expectedRevision: null,
    payloadHash: body.payload_hash,
    permission: 'standards.write',
    fingerprint,
  });
  return c.json(accepted(commandId, 'createStandardCandidate', candidate.standard_id), 202);
}

async function evaluateCandidate(c: Context, ready: Ready): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requirePermission(c.req.raw, 'standards.write');
  const parsed = evaluateRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as Envelope<{ dataset_id: string }>;
  assertPayloadHash(body.payload as unknown as Json, body.payload_hash);
  const { db, now } = ready();
  const candidateId = routeId(c.req.param('id'));
  const candidate = visibleCandidate(db, principal, candidateId);
  assertDomainPermission(db, principal, candidate.data_domain, 'standards.write');
  if (body.expected_revision !== null && body.expected_revision !== candidate.pointer_revision) {
    throw new ApiError(409, 'CONFLICT', { reason: 'revision' });
  }
  const dataset = db.prepare('SELECT policy_version, data_domain FROM evaluation_datasets WHERE dataset_id = ?').get(body.payload.dataset_id) as {
    policy_version: number;
    data_domain: string;
  } | undefined;
  if (!dataset || dataset.data_domain !== candidate.data_domain) throw new ApiError(403, 'FORBIDDEN', { reason: 'dataset' });
  const fingerprint = commandFingerprint({
    operation: 'evaluateStandardCandidate',
    resource_id: candidateId,
    data_domain: candidate.data_domain,
    expected_revision: body.expected_revision,
    payload_hash: body.payload_hash,
  });
  const existing = existingCommand(db, principal, body.client_request_id, fingerprint);
  if (existing) return c.json(accepted(existing, 'evaluateStandardCandidate', commandResource(db, existing)), 202);
  const report = await standardsApi(db, principal, now, candidate.data_domain).evaluate({ id: candidateId }, { version: dataset.policy_version });
  if (report.dataset_id !== body.payload.dataset_id) throw new ApiError(409, 'CONFLICT', { reason: 'dataset' });
  const commandId = storeCommand(db, principal, {
    operation: 'evaluateStandardCandidate',
    resourceId: report.id,
    dataDomain: candidate.data_domain,
    clientRequestId: body.client_request_id,
    expectedRevision: body.expected_revision,
    payloadHash: body.payload_hash,
    permission: 'standards.write',
    fingerprint,
  });
  return c.json(accepted(commandId, 'evaluateStandardCandidate', report.id), 202);
}

async function adoptCandidate(c: Context, ready: Ready): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const principal = await requirePermission(c.req.raw, 'owner');
  const parsed = adoptRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as Envelope<{ report_id: string }>;
  if (body.expected_revision === null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'expected_revision' });
  assertPayloadHash(body.payload as unknown as Json, body.payload_hash);
  const { db, now, api } = ready();
  const candidateId = routeId(c.req.param('id'));
  const candidate = visibleCandidate(db, principal, candidateId);
  assertDomainPermission(db, principal, candidate.data_domain, 'owner', false);
  const fingerprint = commandFingerprint({
    operation: 'adoptStandardCandidate',
    resource_id: candidateId,
    data_domain: candidate.data_domain,
    expected_revision: body.expected_revision,
    payload_hash: body.payload_hash,
  });
  const reportId = body.payload.report_id;
  const authorize = () => assertDomainPermission(db, principal, candidate.data_domain, 'owner', false);
  const existing = existingCommand(db, principal, body.client_request_id, fingerprint);
  if (existing) {
    await api.projectPendingStandardAdoption(candidateId, reportId, authorize);
    return c.json(accepted(existing, 'adoptStandardCandidate', commandResource(db, existing)), 202);
  }
  const adopted = await standardsApi(db, principal, now, candidate.data_domain).adoptStandard(candidateId, reportId, body.expected_revision);
  if (adopted === 'adopted') {
    // A response lost before the command record can resume the pending publication with the same command.
    await api.projectPendingStandardAdoption(candidateId, reportId, authorize);
  }
  const commandId = storeCommand(db, principal, {
    operation: 'adoptStandardCandidate',
    resourceId: body.payload.report_id,
    dataDomain: candidate.data_domain,
    clientRequestId: body.client_request_id,
    expectedRevision: body.expected_revision,
    payloadHash: body.payload_hash,
    permission: 'owner',
    fingerprint,
  });
  return c.json(accepted(commandId, 'adoptStandardCandidate', body.payload.report_id), 202);
}

function standardsApi(db: SqliteDatabase, principal: Principal, now: () => Date, domain = principal.domains[0] ?? 'personal') {
  const caller: StandardsPrincipal = {
    account_id: principal.account_id,
    caller_id: principal.caller_id,
    auth_epoch: principal.auth_epoch,
    domains: principal.domains,
    operations: principal.operations,
  };
  return createStandardsApi(db, caller, { now, domain });
}

function openStandardDraft(db: SqliteDatabase, principal: Principal, draftKey: string) {
  if (!draftKey || draftKey.includes('/') || draftKey.includes('\\') || draftKey.includes('..')) {
    throw new ApiError(422, 'UNPROCESSABLE', { reason: 'draft_key' });
  }
  const rows = db.prepare(`SELECT edit_id, target_id, base_version, document_id, data_domain
    FROM edit_intents
    WHERE account_id = ? AND draft_key = ? AND operation IN ('create_standard', 'revise_standard')
      AND closed_at IS NULL AND target_id IS NOT NULL AND document_id IS NOT NULL`).all(principal.account_id, draftKey) as Array<{
    edit_id: string;
    target_id: string;
    base_version: number | null;
    document_id: string;
    data_domain: string;
  }>;
  const visible = rows.filter((row) => principal.domains.includes(row.data_domain));
  const intent = visible[0];
  if (!intent || visible.length !== 1) throw new ApiError(409, 'CONFLICT', { reason: 'draft' });
  const document = db.prepare(`SELECT document_id, vault_id, observed_seq, content_hash, data_domain, account_id
    FROM vault_documents
    WHERE document_id = ? AND tombstone = 0`).get(intent.document_id) as {
    document_id: string;
    vault_id: string;
    observed_seq: number;
    content_hash: string | null;
    data_domain: string;
    account_id: string;
  } | undefined;
  if (!document || document.account_id !== principal.account_id || document.data_domain !== intent.data_domain || !document.content_hash) {
    throw new ApiError(409, 'CONFLICT', { reason: 'draft' });
  }
  return { intent, document: { ...document, content_hash: document.content_hash } };
}

function visibleCandidate(db: SqliteDatabase, principal: Principal, candidateId: string) {
  const row = db.prepare(`SELECT candidate_id, account_id, data_domain, pointer_revision FROM standard_candidates
    WHERE candidate_id = ?`).get(candidateId) as {
    candidate_id: string;
    account_id: string;
    data_domain: string;
    pointer_revision: number;
  } | undefined;
  if (!row || row.account_id !== principal.account_id) throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  return row;
}

function accepted(commandId: string, operation: string, resourceId: string) {
  return { command_id: commandId, state: 'received' as const, receipt_url: receiptUrl(operation, resourceId) };
}

function receiptUrl(operation: string, resourceId: string): string {
  if (operation === 'createStandardCandidate') return `/api/v1/standards/${resourceId}/versions`;
  return `/api/v1/evaluations/${resourceId}`;
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

function commandResource(db: SqliteDatabase, commandId: string): string {
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
