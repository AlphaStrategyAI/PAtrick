import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { canonicalPayload, routes, type Json } from '@patrick/contracts';
import { commandFingerprint, recordCommand, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import {
  ORIGIN,
  RP_ID,
  assertBrowserOrigin,
  authContext,
  canConfirm,
  readPresentedToken,
  requireSession,
  snapshot,
  type Principal,
} from './auth.js';
import { ApiError, errorBody } from './errors.js';

const RECEIPT_SECRET_TTL_MS = 5 * 60 * 1000;
const OPERATION = 'confirmControlProposal';

export const CONFIRM_PROPOSAL_SQL = `UPDATE control_proposals
SET confirmed_at = @now
WHERE proposal_id = @id AND account_id = @account
  AND proposal_hash = @hash AND challenge_hash = @challenge
  AND base_revision = @current_revision AND confirmed_at IS NULL AND expires_at > @now
RETURNING proposal_id;`;

export type ControlReceipt = {
  receipt_id: string;
  proposal_id: string;
  account_id: string;
  caller_id: string;
  command_id: string;
  proposal_hash: string;
  auth_epoch: number;
  authenticated_at: string;
  credential_ref: string;
  base_revision: number;
};

export type ConfirmControlInput = {
  proposal_id: string;
  proposal_hash: string;
  challenge: string;
  client_request_id: string;
  expected_revision: number;
  payload_hash: string;
};

type ProposalRow = {
  scope: string;
  proposal_hash: string;
  base_revision: number;
};

const confirmRequest = routeRequest('confirmControlProposal');

export function stageControlProposal(db: SqliteDatabase, input: {
  proposalId: string;
  accountId: string;
  proposalHash: string;
  challengeId: string;
  baseRevision: number;
  target: string;
  action: string;
  scope: string;
  expiresAt?: string;
}): void {
  const challenge = db.prepare(`SELECT challenge_hash, expires_at, account_id, purpose
    FROM auth_challenges WHERE challenge_id = ?`).get(input.challengeId) as {
    challenge_hash: string;
    expires_at: string;
    account_id: string | null;
    purpose: string;
  } | undefined;
  if (!challenge || challenge.account_id !== input.accountId || challenge.purpose !== 'control') {
    throw new Error('CHALLENGE_NOT_FOUND');
  }
  db.prepare(`INSERT INTO control_proposals (
    proposal_id, account_id, proposal_hash, target, action, scope, base_revision, challenge_hash, expires_at, confirmed_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`).run(
    input.proposalId,
    input.accountId,
    input.proposalHash,
    input.target,
    input.action,
    input.scope,
    input.baseRevision,
    challenge.challenge_hash,
    input.expiresAt ?? challenge.expires_at,
    new Date().toISOString(),
  );
}

export async function confirmControl(principal: Principal, input: ConfirmControlInput): Promise<ControlReceipt> {
  if (!canConfirm(principal)) throw new ApiError(403, 'FORBIDDEN', { reason: 'caller' });
  const { db, credentials, now } = authContext();
  const nowIso = now().toISOString();
  return withImmediateTransaction(db, () => {
    const account = db.prepare('SELECT auth_epoch, policy_revision FROM accounts WHERE account_id = ?').get(principal.account_id) as {
      auth_epoch: number;
      policy_revision: number;
    } | undefined;
    if (!account || account.auth_epoch !== principal.auth_epoch) {
      throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'auth_epoch' });
    }
    const proposal = db.prepare(`SELECT scope, proposal_hash, base_revision
      FROM control_proposals WHERE proposal_id = ? AND account_id = ?`).get(input.proposal_id, principal.account_id) as ProposalRow | undefined;
    if (!proposal) throw new ApiError(403, 'FORBIDDEN', { reason: 'proposal' });
    if (!permissionActive(db, principal, proposal.scope, 'owner')) {
      throw new ApiError(403, 'FORBIDDEN', { reason: 'permission' });
    }
    const fingerprint = commandFingerprint({
      operation: OPERATION,
      resource_id: input.proposal_id,
      data_domain: proposal.scope,
      expected_revision: input.expected_revision,
      payload_hash: input.payload_hash,
    });
    const existing = db.prepare(`SELECT command_id, command_fingerprint FROM command_inbox
      WHERE account_id = ? AND caller_id = ? AND client_request_id = ?`).get(
      principal.account_id,
      principal.caller_id,
      input.client_request_id,
    ) as { command_id: string; command_fingerprint: string } | undefined;
    if (existing) {
      if (existing.command_fingerprint !== fingerprint) throw new ApiError(409, 'CONFLICT', { reason: 'idempotency' });
      return loadReceipt(db, input.proposal_id, existing.command_id);
    }
    if (input.expected_revision !== account.policy_revision) {
      throw new ApiError(409, 'CONFLICT', { reason: 'revision' }, false, account.policy_revision);
    }
    const consumed = db.prepare(`UPDATE auth_challenges
      SET consumed_at = @now
      WHERE challenge_id = @id AND account_id = @account AND purpose = 'control'
        AND origin = @origin AND rp_id = @rp_id AND consumed_at IS NULL AND expires_at > @now
      RETURNING challenge_hash`).get({
      now: nowIso,
      id: input.challenge,
      account: principal.account_id,
      origin: ORIGIN,
      rp_id: RP_ID,
    }) as { challenge_hash: string } | undefined;
    if (!consumed) throw new ApiError(403, 'FORBIDDEN', { reason: 'challenge' });
    const confirmed = db.prepare(CONFIRM_PROPOSAL_SQL).get({
      now: nowIso,
      id: input.proposal_id,
      account: principal.account_id,
      hash: input.proposal_hash,
      challenge: consumed.challenge_hash,
      current_revision: account.policy_revision,
    }) as { proposal_id: string } | undefined;
    if (!confirmed) throw new ApiError(409, 'CONFLICT', { reason: 'proposal_binding' }, false, account.policy_revision);
    const command = recordCommand(db, {
      account_id: principal.account_id,
      caller_id: principal.caller_id,
      client_request_id: input.client_request_id,
      command_fingerprint: fingerprint,
      command_id: randomUUID(),
    });
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const credentialRef = credentials.put(secret, RECEIPT_SECRET_TTL_MS);
    const receiptId = `rcpt_${randomUUID()}`;
    db.prepare(`INSERT INTO command_records (
      command_id, account_id, caller_id, operation, resource_id, data_domain, permission, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'owner', ?)`).run(
      command.command_id,
      principal.account_id,
      principal.caller_id,
      OPERATION,
      input.proposal_id,
      proposal.scope,
      nowIso,
    );
    db.prepare(`INSERT INTO control_receipts (
      receipt_id, proposal_id, account_id, caller_id, auth_epoch, authenticated_at, proposal_hash,
      challenge_hash, base_revision, credential_ref, command_id, result, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)`).run(
      receiptId,
      input.proposal_id,
      principal.account_id,
      principal.caller_id,
      principal.auth_epoch,
      principal.authenticated_at,
      input.proposal_hash,
      consumed.challenge_hash,
      account.policy_revision,
      credentialRef,
      command.command_id,
      nowIso,
    );
    return {
      receipt_id: receiptId,
      proposal_id: input.proposal_id,
      account_id: principal.account_id,
      caller_id: principal.caller_id,
      command_id: command.command_id,
      proposal_hash: input.proposal_hash,
      auth_epoch: principal.auth_epoch,
      authenticated_at: principal.authenticated_at,
      credential_ref: credentialRef,
      base_revision: account.policy_revision,
    };
  });
}

export function mountControlRoutes(app: Hono): void {
  app.post('/api/v1/control-proposals/:id/confirm', (c) => handle(c, () => confirmProposal(c)));
  app.get('/api/v1/control-receipts/:id', (c) => handle(c, () => readControlReceipt(c)));
  app.get('/api/v1/commands/:id', (c) => handle(c, () => readCommand(c)));
}

async function confirmProposal(c: Context): Promise<Response> {
  assertBrowserOrigin(c.req.raw);
  if (!readPresentedToken(c.req.raw)) throw new ApiError(403, 'FORBIDDEN', { reason: 'caller' });
  const principal = await requireSession(c.req.raw);
  if (!canConfirm(principal)) throw new ApiError(403, 'FORBIDDEN', { reason: 'caller' });
  const parsed = confirmRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as {
    client_request_id: string;
    expected_revision: number | null;
    payload_hash: string;
    payload: { proposal_hash: string; challenge_id: string };
  };
  if (body.expected_revision === null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'expected_revision' });
  const proposalId = c.req.param('id');
  if (!proposalId) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'proposal' });
  const payload: Json = {
    challenge_id: body.payload.challenge_id,
    proposal_hash: body.payload.proposal_hash,
  };
  assertPayloadHash(payload, body.payload_hash);
  const receipt = await confirmControl(principal, {
    proposal_id: proposalId,
    proposal_hash: body.payload.proposal_hash,
    challenge: body.payload.challenge_id,
    client_request_id: body.client_request_id,
    expected_revision: body.expected_revision,
    payload_hash: body.payload_hash,
  });
  return c.json({
    command_id: receipt.command_id,
    state: 'received' as const,
    receipt_url: `/api/v1/commands/${receipt.command_id}`,
  }, 202);
}

async function readControlReceipt(c: Context): Promise<Response> {
  const principal = await requireSession(c.req.raw);
  if (!canConfirm(principal)) throw new ApiError(403, 'FORBIDDEN', { reason: 'caller' });
  const { db, now } = authContext();
  const row = db.prepare(`SELECT receipt_id, proposal_id, command_id, proposal_hash, auth_epoch,
      authenticated_at, credential_ref, base_revision
    FROM control_receipts
    WHERE receipt_id = ? AND account_id = ?`).get(c.req.param('id'), principal.account_id) as {
    receipt_id: string;
    proposal_id: string;
    command_id: string;
    proposal_hash: string;
    auth_epoch: number;
    authenticated_at: string;
    credential_ref: string;
    base_revision: number;
  } | undefined;
  if (!row) throw new ApiError(404, 'NOT_FOUND', { reason: 'receipt' });
  return c.json(snapshot(principal, {
    receipt_id: row.receipt_id,
    proposal_id: row.proposal_id,
    command_id: row.command_id,
    proposal_hash: row.proposal_hash,
    auth_epoch: row.auth_epoch,
    authenticated_at: row.authenticated_at,
    credential_ref: row.credential_ref,
    base_revision: row.base_revision,
  }, now(), db));
}

async function readCommand(c: Context): Promise<Response> {
  const principal = await requireSession(c.req.raw);
  const { db, now } = authContext();
  const row = db.prepare(`SELECT command_id, resource_id, data_domain, permission, operation
    FROM command_records
    WHERE command_id = ? AND account_id = ? AND caller_id = ?`).get(c.req.param('id'), principal.account_id, principal.caller_id) as {
    command_id: string;
    resource_id: string;
    data_domain: string;
    permission: string;
    operation: string;
  } | undefined;
  if (!row || !permissionActive(db, principal, row.data_domain, row.permission)) {
    throw new ApiError(403, 'FORBIDDEN', { reason: 'permission' });
  }
  return c.json(snapshot(principal, {
    command_id: row.command_id,
    state: 'received',
    receipt_url: `/api/v1/commands/${row.command_id}`,
    resource_id: row.resource_id,
    operation: row.operation,
  }, now(), db));
}

function loadReceipt(db: SqliteDatabase, proposalId: string, commandId: string): ControlReceipt {
  const row = db.prepare(`SELECT receipt_id, proposal_id, account_id, caller_id, command_id, proposal_hash,
      auth_epoch, authenticated_at, credential_ref, base_revision
    FROM control_receipts WHERE proposal_id = ? AND command_id = ?`).get(proposalId, commandId) as ControlReceipt | undefined;
  if (!row) throw new ApiError(409, 'CONFLICT', { reason: 'receipt' });
  return row;
}

function permissionActive(db: SqliteDatabase, principal: Principal, domain: string, permission: string): boolean {
  const row = db.prepare(`SELECT 1 AS ok FROM caller_scopes
    WHERE account_id = ? AND caller_id = ? AND data_domain = ? AND permission = ? AND revoked_at IS NULL`).get(
    principal.account_id,
    principal.caller_id,
    domain,
    permission,
  );
  return Boolean(row);
}

function assertPayloadHash(payload: Json, claimed: string): void {
  const actual = createHash('sha256').update(canonicalPayload(payload)).digest('hex');
  const left = Buffer.from(actual);
  const right = Buffer.from(claimed);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new ApiError(422, 'UNPROCESSABLE', { reason: 'payload_hash' });
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError(422, 'UNPROCESSABLE', { reason: 'json' });
  }
}

async function handle(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    const rendered = errorBody(error);
    return c.json(rendered.body, rendered.status as 401);
  }
}

function routeRequest(operationId: string) {
  const route = routes.find((item) => item.operationId === operationId);
  if (!route) throw new Error(`ROUTE_MISSING:${operationId}`);
  return route.request;
}
