import { createHash, randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { canonicalPayload, delegationApplyRequest, delegationControlRequest, delegationProposalRequest, type Json } from '@patrick/contracts';
import { commandFingerprint, recordCommand, withDeferredTransaction, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import {
  applyPreparedMandateChange,
  createDelegationApi,
  prepareMandateChange,
  type DelegationView,
  type MandateChange,
  type MandateChangeBaseline,
} from '../../../../packages/domain/src/delegation.js';
import { assertDomainPermission, authContext, browserAuthority, canConfirm, snapshot, type Principal } from '../auth.js';
import { stageControlProposal } from '../control.js';
import { assertBusinessWrite } from '../recovery-runtime.js';
import { ApiError } from '../errors.js';
import { assertPayloadHash, assertWriteOrigin, handle, readJson, requirePermission, routeId } from './http.js';
import { domainPrincipal, learningDomain, queryParameter } from './learning-scope.js';

type Ready = () => { db: SqliteDatabase; now: () => Date };
type Envelope = { client_request_id: string; expected_revision: number | null; payload_hash: string };
type StageInput = { domain: string; mandateId: string; change: MandateChange; challengeId: string; envelope: Envelope };
type ProposalRow = {
  proposal_id: string; stage_command_id: string; account_id: string; caller_id: string; auth_epoch: number;
  data_domain: string; mandate_id: string; change_json: string; mandate_revision: number | null; config_revision: number;
  scope_hash: string; current_status: DelegationView['status'] | null; apply_command_id: string | null;
  applied_control_receipt_id: string | null; applied_result_json: string | null;
  applied_at: string | null; proposal_hash: string; base_revision: number; expires_at: string; confirmed_at: string | null;
  challenge_hash: string; target: string; action: string; scope: string;
};
const recentAuthMs = 5 * 60 * 1000;

export function mountDelegationRoutes(app: Hono, ready: Ready): void {
  app.get('/api/v1/delegations', (c) => handle(c, async () => {
    const principal = await requirePermission(c.req.raw, 'delegations.read');
    const { db, now } = ready();
    const domain = learningDomain(db, principal, 'delegations.read', queryParameter(c, 'domain'));
    const scoped = domainPrincipal(db, principal, domain);
    const items = await createDelegationApi(db, scoped, { now, domain }).listDelegations();
    return c.json(snapshot(scoped, { items }, now(), db));
  }));
  app.get('/api/v1/delegations/:id', (c) => handle(c, async () => {
    const principal = await requirePermission(c.req.raw, 'delegations.read');
    const { db, now } = ready();
    const domain = learningDomain(db, principal, 'delegations.read', queryParameter(c, 'domain'));
    const scoped = domainPrincipal(db, principal, domain);
    const item = await createDelegationApi(db, scoped, { now, domain }).getDelegation(routeId(c.req.param('id')));
    return c.json(snapshot(scoped, item, now(), db));
  }));
  app.post('/api/v1/delegation-proposals', (c) => handle(c, () => stageCreation(c, ready)));
  app.post('/api/v1/delegations/:id/controls', (c) => handle(c, () => stageControl(c, ready)));
  app.get('/api/v1/delegation-proposals/:id', (c) => handle(c, () => readProposal(c, ready)));
  app.post('/api/v1/delegation-proposals/:id/apply', (c) => handle(c, () => applyProposal(c, ready)));
}

async function stageCreation(c: Context, ready: Ready): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const parsed = delegationProposalRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success || parsed.data.expected_revision !== null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'proposal' });
  const input = parsed.data;
  assertPayloadHash(input.payload, input.payload_hash);
  const principal = await requirePermission(c.req.raw, 'owner');
  const { challenge_id: challengeId, expires_at, ...fields } = input.payload;
  const scope = { ...fields, expires_at: new Date(expires_at).toISOString() };
  const domain = scope.domains[0];
  const mandateId = 'mandate_' + digest([principal.account_id, principal.caller_id, domain, input.client_request_id]).slice(0, 40);
  const { db, now } = ready();
  return c.json(stage(db, principal, now(), { domain, mandateId, change: { action: 'create', scope }, challengeId, envelope: input }), 202);
}

async function stageControl(c: Context, ready: Ready): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const parsed = delegationControlRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success || parsed.data.expected_revision === null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'proposal' });
  const input = parsed.data;
  assertPayloadHash(input.payload, input.payload_hash);
  const principal = await requirePermission(c.req.raw, 'owner');
  const mandateId = routeId(c.req.param('id'));
  const { db, now } = ready();
  const target = db.prepare('SELECT data_domain FROM mandates WHERE mandate_id=? AND account_id=?')
    .get(mandateId, principal.account_id) as { data_domain: string } | undefined;
  if (!target) forbidden('mandate');
  return c.json(stage(db, principal, now(), { domain: target.data_domain, mandateId, change: { action: input.payload.type },
    challengeId: input.payload.challenge_id, envelope: input }), 202);
}

function stage(db: SqliteDatabase, principal: Principal, time: Date, input: StageInput) {
  return withImmediateTransaction(db, () => {
    const { change, domain, mandateId, envelope } = input;
    const policyRevision = assertOwner(db, principal, domain);
    assertMandateScopes(db, principal, change, mandateId);
    const operation = change.action === 'create' ? 'createDelegationProposal' : 'controlDelegation';
    const fingerprint = fingerprintFor(operation, domain, mandateId, envelope);
    const prior = existingCommand(db, principal, envelope.client_request_id, fingerprint);
    if (prior) {
      const row = db.prepare('SELECT proposal_id FROM delegation_control_proposals WHERE stage_command_id=? AND auth_epoch=?')
        .get(prior, principal.auth_epoch) as { proposal_id: string } | undefined;
      if (!row) throw new ApiError(409, 'CONFLICT', { reason: 'proposal_binding' });
      return accepted(prior, row.proposal_id);
    }

    assertRecentOwner(principal, time);
    const now = time.toISOString();
    const challenge = db.prepare(`SELECT challenge_hash,expires_at FROM auth_challenges WHERE challenge_id=? AND account_id=?
      AND purpose='control' AND consumed_at IS NULL AND expires_at>? AND origin=? AND rp_id=?`)
      .get(input.challengeId, principal.account_id, now, browserAuthority().origin, browserAuthority().rpId) as { challenge_hash: string; expires_at: string } | undefined;
    if (!challenge) forbidden('challenge');
    const bound = db.prepare('SELECT 1 FROM control_proposals WHERE account_id=? AND challenge_hash=? LIMIT 1')
      .get(principal.account_id, challenge.challenge_hash);
    if (bound) throw new ApiError(409, 'CONFLICT', { reason: 'challenge_binding' });

    const expected = prepareMandateChange(db, principal, domain, now, mandateId, change, envelope.expected_revision);
    const proposalId = 'dprop_' + randomUUID();
    const action = 'delegation.' + change.action;
    const proposalHash = proposalDigest(proposalId, principal, domain, mandateId, change, envelope.expected_revision, expected, policyRevision);
    assertIncreasingWrite(db, principal, domain, change, mandateId);
    stageControlProposal(db, { proposalId, accountId: principal.account_id, proposalHash, challengeId: input.challengeId,
      baseRevision: policyRevision, target: mandateId, action, scope: domain, expiresAt: challenge.expires_at });
    const commandId = storeCommand(db, principal, operation, proposalId, domain, envelope, fingerprint, now);
    db.prepare(`INSERT INTO delegation_control_proposals (
      proposal_id,stage_command_id,account_id,caller_id,auth_epoch,data_domain,mandate_id,change_json,
      mandate_revision,config_revision,scope_hash,current_status
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(proposalId, commandId, principal.account_id, principal.caller_id, principal.auth_epoch,
      domain, mandateId, JSON.stringify(change), envelope.expected_revision, expected.configuration, expected.scopeHash, expected.status);
    return accepted(commandId, proposalId);
  });
}

async function readProposal(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'owner');
  const { db, now } = ready();
  const requestedDomain = queryParameter(c, 'domain');
  const id = routeId(c.req.param('id'));
  const view = withDeferredTransaction(db, () => {
    const row = requireProposal(db, principal, id);
    if (requestedDomain !== undefined && requestedDomain !== row.data_domain) forbidden('scope');
    const time = now();
    const result = row.applied_result_json === null ? null : {
      ...(JSON.parse(row.applied_result_json) as { status: string; revision: number }),
      control_receipt_id: row.applied_control_receipt_id, applied_at: row.applied_at,
    };
    return snapshot(domainPrincipal(db, principal, row.data_domain), {
      proposal_id: row.proposal_id, mandate_id: row.mandate_id, base_revision: row.base_revision,
      proposal_hash: row.proposal_hash, expires_at: row.expires_at,
      mandate_revision: row.mandate_revision, before: row.current_status, change: JSON.parse(row.change_json) as MandateChange,
      state: result ? 'applied' : row.expires_at <= time.toISOString() ? 'expired' : 'staged', result,
    }, time, db);
  });
  return c.json(view);
}

async function applyProposal(c: Context, ready: Ready): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const parsed = delegationApplyRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'proposal' });
  const input = parsed.data;
  assertPayloadHash(input.payload, input.payload_hash);
  const principal = await requirePermission(c.req.raw, 'owner');
  const { db, now } = ready();
  const { credentials } = authContext();
  const id = routeId(c.req.param('id'));
  const reply = withImmediateTransaction(db, () => {
    const row = requireProposal(db, principal, id);
    const operation = 'applyDelegationProposal';
    const fingerprint = fingerprintFor(operation, row.data_domain, row.proposal_id, input);
    const prior = existingCommand(db, principal, input.client_request_id, fingerprint);
    if (prior) {
      if (prior !== row.apply_command_id) throw new ApiError(409, 'CONFLICT', { reason: 'proposal_binding' });
      return accepted(prior, row.proposal_id);
    }
    if (row.apply_command_id) throw new ApiError(409, 'CONFLICT', { reason: 'already_applied' });
    const time = now();
    const current = time.toISOString();
    assertRecentOwner(principal, time);
    if (row.expires_at <= current || row.mandate_revision !== input.expected_revision ||
      row.base_revision !== assertOwner(db, principal, row.data_domain)) {
      throw new ApiError(409, 'CONFLICT', { reason: 'proposal_revision' });
    }
    const change = JSON.parse(row.change_json) as MandateChange;
    const expected = { configuration: row.config_revision, scopeHash: row.scope_hash, status: row.current_status };
    const hash = proposalDigest(id, principal, row.data_domain, row.mandate_id, change, row.mandate_revision, expected, row.base_revision);
    if (hash !== row.proposal_hash || row.target !== row.mandate_id || row.action !== 'delegation.' + change.action ||
        row.scope !== row.data_domain) forbidden('proposal_binding');

    const receipt = db.prepare(`SELECT r.credential_ref,r.authenticated_at FROM control_receipts r
      JOIN auth_challenges a ON a.account_id=r.account_id AND a.challenge_hash=r.challenge_hash
        AND a.purpose='control' AND a.origin=@origin AND a.rp_id=@rp AND a.consumed_at IS NOT NULL
      WHERE r.receipt_id=@receipt AND r.proposal_id=@proposal AND r.account_id=@account AND r.caller_id=@caller
        AND r.auth_epoch=@epoch AND r.result='confirmed' AND r.proposal_hash=@hash AND r.base_revision=@policy
        AND r.challenge_hash=@challenge AND r.created_at=@confirmed`).get({
      receipt: input.payload.control_receipt_id, proposal: id, account: principal.account_id, caller: principal.caller_id,
      epoch: principal.auth_epoch, hash, policy: row.base_revision, challenge: row.challenge_hash,
      confirmed: row.confirmed_at, origin: browserAuthority().origin, rp: browserAuthority().rpId,
    }) as { credential_ref: string; authenticated_at: string } | undefined;
    if (!receipt || !isRecent(receipt.authenticated_at, time) || !credentials.resolve(receipt.credential_ref)) forbidden('control_receipt');
    assertMandateScopes(db, principal, change, row.mandate_id);
    assertIncreasingWrite(db, principal, row.data_domain, change, row.mandate_id);
    const mandate = applyPreparedMandateChange(db, principal, row.data_domain, current, row.mandate_id, change, row.mandate_revision, expected);
    const commandId = storeCommand(db, principal, operation, row.proposal_id, row.data_domain, input, fingerprint, current);
    const update = db.prepare(`UPDATE delegation_control_proposals SET apply_command_id=?,applied_control_receipt_id=?,
      applied_result_json=?,applied_at=? WHERE proposal_id=? AND apply_command_id IS NULL`).run(
      commandId, input.payload.control_receipt_id, JSON.stringify({ status: mandate.status, revision: mandate.revision }), current, id,
    );
    if (update.changes !== 1) throw new ApiError(409, 'CONFLICT', { reason: 'already_applied' });
    return accepted(commandId, id);
  });
  return c.json(reply, 202);
}

function assertIncreasingWrite(db: SqliteDatabase, principal: Principal, domain: string, change: MandateChange, mandateId: string): void {
  if (change.action === 'pause' || change.action === 'stop') return;
  if (change.action === 'create') {
    for (const target of change.scope.domains) assertBusinessWrite(db, target);
  } else {
    const row = db.prepare('SELECT data_domain,domains_json FROM mandates WHERE mandate_id=? AND account_id=?')
      .get(mandateId, principal.account_id) as { data_domain: string; domains_json: string } | undefined;
    if (!row) forbidden('mandate');
    assertBusinessWrite(db, row.data_domain);
    for (const target of JSON.parse(row.domains_json) as string[]) assertBusinessWrite(db, target);
  }
  assertBusinessWrite(db, domain);
}

function assertMandateScopes(db: SqliteDatabase, principal: Principal, change: MandateChange, mandateId: string): void {
  if (change.action === 'create') {
    for (const domain of change.scope.domains) assertDomainPermission(db, principal, domain, 'owner', false);
  } else if (change.action === 'resume') {
    const row = db.prepare('SELECT domains_json FROM mandates WHERE mandate_id=? AND account_id=?')
      .get(mandateId, principal.account_id) as { domains_json: string } | undefined;
    if (!row) forbidden('mandate');
    for (const domain of JSON.parse(row.domains_json) as string[]) assertDomainPermission(db, principal, domain, 'owner', false);
  }
}

function assertOwner(db: SqliteDatabase, principal: Principal, domain: string): number {
  if (!canConfirm(principal)) forbidden('caller');
  assertDomainPermission(db, principal, domain, 'owner', false);
  const account = db.prepare('SELECT policy_revision FROM accounts WHERE account_id=? AND auth_epoch=?')
    .get(principal.account_id, principal.auth_epoch) as { policy_revision: number } | undefined;
  if (!account) forbidden('scope');
  return account.policy_revision;
}

function assertRecentOwner(principal: Principal, time: Date): void {
  if (!principal.authenticated_at || !isRecent(principal.authenticated_at, time)) forbidden('recent_authentication');
}

function requireProposal(db: SqliteDatabase, principal: Principal, id: string): ProposalRow {
  const row = db.prepare(`SELECT d.*, p.proposal_hash,p.base_revision,p.expires_at,p.confirmed_at,p.challenge_hash,p.target,p.action,p.scope
    FROM delegation_control_proposals d JOIN control_proposals p
      ON p.proposal_id=d.proposal_id AND p.account_id=d.account_id
    WHERE d.proposal_id=? AND d.account_id=? AND d.caller_id=? AND d.auth_epoch=?`)
    .get(id, principal.account_id, principal.caller_id, principal.auth_epoch) as ProposalRow | undefined;
  if (!row) forbidden('proposal');
  assertOwner(db, principal, row.data_domain);
  return row;
}

function proposalDigest(
  id: string, principal: Principal, domain: string, target: string, change: MandateChange,
  revision: number | null, baseline: MandateChangeBaseline, policyRevision: number,
) {
  return digest({ id, account: principal.account_id, caller: principal.caller_id, epoch: principal.auth_epoch,
    domain, target, change, revision, baseline, policy_revision: policyRevision });
}

function isRecent(authenticatedAt: string, now: Date): boolean {
  const age = now.getTime() - Date.parse(authenticatedAt);
  return Number.isFinite(age) && age >= 0 && age <= recentAuthMs;
}

function digest(value: Json): string {
  return createHash('sha256').update(canonicalPayload(value)).digest('hex');
}

function fingerprintFor(operation: string, domain: string, target: string, data: Envelope): string {
  return commandFingerprint({ operation, data_domain: domain, resource_id: target,
    expected_revision: data.expected_revision, payload_hash: data.payload_hash });
}

function forbidden(reason: string): never {
  throw new ApiError(403, 'FORBIDDEN', { reason });
}

function accepted(commandId: string, proposalId: string) {
  return { command_id: commandId, state: 'received' as const, receipt_url: '/api/v1/delegation-proposals/' + proposalId };
}

function existingCommand(db: SqliteDatabase, principal: Principal, requestId: string, fingerprint: string): string | undefined {
  const prior = db.prepare('SELECT command_id,command_fingerprint FROM command_inbox WHERE account_id=? AND caller_id=? AND client_request_id=?')
    .get(principal.account_id, principal.caller_id, requestId) as { command_id: string; command_fingerprint: string } | undefined;
  if (prior && prior.command_fingerprint !== fingerprint) throw new ApiError(409, 'CONFLICT', { reason: 'idempotency' });
  return prior?.command_id;
}

function storeCommand(db: SqliteDatabase, principal: Principal, operation: string, resource: string, domain: string,
  envelope: Envelope, fingerprint: string, now: string): string {
  const receipt = recordCommand(db, { account_id: principal.account_id, caller_id: principal.caller_id,
    client_request_id: envelope.client_request_id, command_fingerprint: fingerprint, command_id: randomUUID() });
  if (!receipt.created) throw new ApiError(409, 'CONFLICT', { reason: 'idempotency' });
  db.prepare(`INSERT INTO command_records (command_id,account_id,caller_id,operation,resource_id,data_domain,permission,created_at)
    VALUES (?,?,?,?,?,?,'owner',?)`).run(receipt.command_id, principal.account_id, principal.caller_id, operation, resource, domain, now);
  return receipt.command_id;
}
