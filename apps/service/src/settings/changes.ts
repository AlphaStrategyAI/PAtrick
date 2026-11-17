import { createHash, randomUUID } from 'node:crypto';
import { canonicalPayload, type Json } from '@patrick/contracts';
import { commandFingerprint, recordCommand, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { assertDomainPermission, canConfirm, ORIGIN, RP_ID, snapshot, type Principal } from '../auth.js';
import { ApiError } from '../errors.js';
import { stageControlProposal } from '../control.js';
import { settingsControlHash } from './authority.js';

export type SettingsDraft = { operation: string; domain: string; target: string; input: Json };
type Binding = { revision: number; deviceId: string; identityId: string; scopeHash: string };
type BoundDraft = Binding & { hash: string };
type Validation = {
  validation_id: string; draft_hash: string; base_revision: number; device_id: string;
  identity_id: string; scope_hash: string; valid: boolean; checked_at: string; expires_at: string;
};
type ProofRow = Omit<Validation, 'valid'> & {
  valid: number; account_id: string; caller_id: string; auth_epoch: number;
  data_domain: string; operation: string; target_id: string;
};
export type SettingsEffect = { item: string; outcome: 'applied' | 'unchanged' | 'blocked' | 'uncertain'; revision: number | null };
type Applied = { revision: number | null; effects: readonly SettingsEffect[] };
type Check = { verified: boolean; issue?: string };
export class SettingsApplyBlocked extends Error {
  readonly issue: string;
  constructor(issue: string) {
    super(issue);
    this.issue = issue;
  }
}
export type SettingsHandler = {
  binding(principal: Principal, draft: SettingsDraft): Binding;
  validate(principal: Principal, draft: SettingsDraft): Promise<{ valid: boolean }>;
  authorize(principal: Principal, draft: SettingsDraft, proof: Validation, controlReceiptId: string): void;
  apply(principal: Principal, draft: SettingsDraft, proof: Validation, beforeWrite: () => string): Promise<Applied>;
  recheck(principal: Principal, draft: SettingsDraft, applied: Applied): Promise<Check>;
};
type ChangeRequest = { validationId: string; requestId: string; controlReceiptId: string; draft: SettingsDraft;
  expectedRevision?: number | null; assertSession?: () => void };
export type SettingsChangeReceipt = {
  change_id: string; validation_id: string; operation: string; target_id: string;
  phase: 'applying' | 'applied' | 'observed' | 'uncertain'; applied_revision: number | null;
  verified: boolean; checked_at: string | null; issues: readonly string[]; effects: readonly SettingsEffect[];
};
type ChangeRow = { account_id: string; caller_id: string; data_domain: string; receipt: string };
const operation = 'applySettingsChanges';
type PreflightOperation = 'validateSettings' | 'prepareSettingsControl';
type PreflightCommand = { principal: Principal; draft: SettingsDraft; operation: PreflightOperation; permission: string;
  expectedRevision?: number | null; requestId?: string; payload: Json };
type PreflightReceipt<T> = Omit<ReturnType<typeof snapshot>, 'data'> & { data: T };
const sha256 = (value: Json) => createHash('sha256').update(canonicalPayload(value)).digest('hex');

export function canApply(proof: Validation, live: BoundDraft, now: Date): boolean {
  return proof.valid && proof.expires_at > now.toISOString() && proof.draft_hash === live.hash
    && proof.base_revision === live.revision && proof.device_id === live.deviceId
    && proof.identity_id === live.identityId && proof.scope_hash === live.scopeHash;
}

export function createSettingsChanges(options: {
  db: SqliteDatabase; now: () => Date; ttlMs?: number; handlers: Readonly<Partial<Record<string, SettingsHandler>>>;
}) {
  const { db, now, handlers } = options;
  const ttlMs = options.ttlMs ?? 120_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000) throw new Error('SETTINGS_TTL_INVALID');
  const changeById = db.prepare('SELECT account_id,caller_id,data_domain,receipt FROM settings_changes WHERE change_id=?');

  function handlerFor(draft: SettingsDraft): SettingsHandler {
    const handler = Object.hasOwn(handlers, draft.operation) ? handlers[draft.operation] : undefined;
    if (!handler) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'settings_operation' });
    return handler;
  }

  function binding(principal: Principal, draft: SettingsDraft, handler: SettingsHandler): BoundDraft {
    const current = handler.binding(principal, draft);
    if (!Number.isSafeInteger(current.revision) || current.revision < 0 || !current.deviceId || !current.identityId ||
        !/^[a-f0-9]{64}$/.test(current.scopeHash)) throw new Error('SETTINGS_BINDING_INVALID');
    const permissions = db.prepare(`SELECT permission FROM caller_scopes
      WHERE account_id=? AND caller_id=? AND data_domain=? AND revoked_at IS NULL ORDER BY permission`)
      .all(principal.account_id, principal.caller_id, draft.domain) as { permission: string }[];
    return { ...current, scopeHash: sha256([current.scopeHash, permissions.map(({ permission }) => permission)]), hash: draftHash(draft) };
  }

  function readScopedChange(principal: Principal, changeId: string) {
    const row = changeById.get(changeId) as ChangeRow | undefined;
    if (!row || row.account_id !== principal.account_id) throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
    assertDomainPermission(db, principal, row.data_domain, 'settings.read');
    return { domain: row.data_domain, receipt: JSON.parse(row.receipt) as SettingsChangeReceipt };
  }

  function loadProof(principal: Principal, draft: SettingsDraft, validationId: string, expectedRevision?: number | null): Validation {
    const row = db.prepare('SELECT * FROM settings_validations WHERE validation_id=?').get(validationId) as ProofRow | undefined;
    if (!row || row.account_id !== principal.account_id || row.caller_id !== principal.caller_id ||
        row.data_domain !== draft.domain || row.operation !== draft.operation || row.target_id !== draft.target ||
        row.auth_epoch !== principal.auth_epoch || (expectedRevision !== undefined && (expectedRevision ?? 0) !== row.base_revision)) stale();
    return { validation_id: row.validation_id, draft_hash: row.draft_hash,
      base_revision: row.base_revision, device_id: row.device_id, identity_id: row.identity_id,
      scope_hash: row.scope_hash, valid: row.valid === 1, checked_at: row.checked_at, expires_at: row.expires_at };
  }

  function preflightFingerprint(command: PreflightCommand): string {
    return commandFingerprint({ operation: command.operation, resource_id: command.draft.target, data_domain: command.draft.domain,
      expected_revision: command.expectedRevision ?? null, payload_hash: sha256(command.payload) });
  }

  function replayPreflight<T>(command: PreflightCommand): PreflightReceipt<T> | undefined {
    const { principal, requestId } = command;
    if (requestId === undefined) return;
    const row = db.prepare(`SELECT i.command_fingerprint,r.auth_epoch,r.body FROM command_inbox i
      LEFT JOIN settings_preflight_receipts r ON r.command_id=i.command_id
      WHERE i.account_id=? AND i.caller_id=? AND i.client_request_id=?`)
      .get(principal.account_id, principal.caller_id, requestId) as
      { command_fingerprint: string; auth_epoch: number | null; body: string | null } | undefined;
    if (!row) return;
    if (row.command_fingerprint !== preflightFingerprint(command) || row.auth_epoch !== principal.auth_epoch || !row.body) {
      throw new ApiError(409, 'CONFLICT', { reason: 'idempotency' });
    }
    return JSON.parse(row.body) as PreflightReceipt<T>;
  }

  function recordPreflight<T>(command: PreflightCommand, resourceId: string, result: T): PreflightReceipt<T> {
    const { principal, draft, requestId } = command;
    const at = now();
    const body = { ...snapshot({ ...principal, domains: [draft.domain] }, result, at, db), data: result };
    if (requestId === undefined) return body;
    const id = `settings_preflight_${randomUUID()}`;
    recordCommand(db, { account_id: principal.account_id, caller_id: principal.caller_id, client_request_id: requestId,
      command_fingerprint: preflightFingerprint(command), command_id: id });
    db.prepare(`INSERT INTO command_records(command_id,account_id,caller_id,operation,resource_id,data_domain,permission,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, principal.account_id, principal.caller_id, command.operation, resourceId, draft.domain,
        command.permission, at.toISOString());
    db.prepare('INSERT INTO settings_preflight_receipts(command_id,auth_epoch,body) VALUES (?,?,?)')
      .run(id, principal.auth_epoch, JSON.stringify(body));
    return body;
  }

  const readChange = (principal: Principal, changeId: string) => readScopedChange(principal, changeId).receipt;
  async function validate(principal: Principal, draft: SettingsDraft, expectedRevision?: number | null, requestId?: string) {
    draft = structuredClone(draft);
    const command: PreflightCommand = { principal, draft, expectedRevision, requestId, payload: draft,
      operation: 'validateSettings', permission: 'settings.validate' };
    assertDomainPermission(db, principal, draft.domain, command.permission);
    const previous = replayPreflight<Validation>(command);
    if (previous) return previous;
    const handler = handlerFor(draft);
    const checkedAt = now();
    const checked = binding(principal, draft, handler);
    if (expectedRevision !== undefined && (expectedRevision ?? 0) !== checked.revision) stale();
    const result = await handler.validate(principal, draft);
    return withImmediateTransaction(db, () => {
      assertDomainPermission(db, principal, draft.domain, command.permission);
      const replay = replayPreflight<Validation>(command);
      if (replay) return replay;
      if (draftHash(draft) !== checked.hash) stale();
      const proof: Validation = { validation_id: `validation_${randomUUID()}`, draft_hash: checked.hash,
        base_revision: checked.revision, device_id: checked.deviceId, identity_id: checked.identityId,
        scope_hash: checked.scopeHash, valid: result.valid, checked_at: checkedAt.toISOString(),
        expires_at: new Date(checkedAt.getTime() + ttlMs).toISOString() };
      if (!canApply({ ...proof, valid: true }, binding(principal, draft, handler), now())) stale();
      db.prepare(`INSERT INTO settings_validations (validation_id,account_id,caller_id,data_domain,operation,target_id,
        draft_hash,auth_epoch,base_revision,device_id,identity_id,scope_hash,valid,checked_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(proof.validation_id, principal.account_id, principal.caller_id,
          draft.domain, draft.operation, draft.target, proof.draft_hash, principal.auth_epoch, proof.base_revision,
          proof.device_id, proof.identity_id, proof.scope_hash, proof.valid ? 1 : 0, proof.checked_at, proof.expires_at);
      return recordPreflight(command, proof.validation_id, proof);
    });
  }

  return {
    isRegistered: (operation: string) => Object.hasOwn(handlers, operation) && handlers[operation] !== undefined,
    async validateSettings(principal: Principal, draft: SettingsDraft, expectedRevision?: number | null): Promise<Validation> {
      return (await validate(principal, draft, expectedRevision)).data;
    },
    validateSettingsCommand(principal: Principal, draft: SettingsDraft, expectedRevision: number | null, requestId: string) {
      return validate(principal, draft, expectedRevision, requestId);
    },
    prepareControl(principal: Principal, draft: SettingsDraft, validationId: string, challengeId: string,
      expectedRevision: number | null, requestId: string) {
      const command: PreflightCommand = { principal, draft, expectedRevision, requestId,
        payload: { draft, validation_id: validationId, challenge_id: challengeId }, operation: 'prepareSettingsControl', permission: 'owner' };
      return withImmediateTransaction(db, () => {
        if (!canConfirm(principal)) throw new ApiError(403, 'FORBIDDEN', { reason: 'caller' });
        assertDomainPermission(db, principal, draft.domain, 'owner', false);
        const replay = replayPreflight<{
          proposal_id: string; proposal_hash: string; base_revision: number; object_revision: number; expires_at: string;
        }>(command);
        if (replay) return replay;
        const proof = loadProof(principal, draft, validationId, expectedRevision);
        const time = now();
        if (!canApply(proof, binding(principal, draft, handlerFor(draft)), time)) stale();
        const account = db.prepare('SELECT policy_revision FROM accounts WHERE account_id=?').get(principal.account_id) as { policy_revision: number };
        const challenge = db.prepare(`SELECT challenge_hash,expires_at FROM auth_challenges WHERE challenge_id=? AND account_id=?
          AND purpose='control' AND consumed_at IS NULL AND expires_at>? AND origin=? AND rp_id=?`)
          .get(challengeId, principal.account_id, time.toISOString(), ORIGIN, RP_ID) as { challenge_hash: string; expires_at: string } | undefined;
        if (!challenge) throw new ApiError(403, 'FORBIDDEN', { reason: 'challenge' });
        const proposalId = 'settings_proposal_' + sha256([principal.account_id, principal.caller_id, validationId, challengeId]);
        const proposalHash = settingsControlHash({ operation: draft.operation, target: draft.target, domain: draft.domain,
          validationId, draftHash: proof.draft_hash, objectRevision: proof.base_revision });
        const expiresAt = proposalExpiry(proof.expires_at, challenge.expires_at);
        const existing = db.prepare(`SELECT proposal_hash,base_revision,challenge_hash,expires_at,confirmed_at FROM control_proposals
          WHERE proposal_id=? AND account_id=?`).get(proposalId, principal.account_id) as
          { proposal_hash: string; base_revision: number; challenge_hash: string; expires_at: string; confirmed_at: string | null } | undefined;
        if (existing) {
          if (existing.proposal_hash !== proposalHash || existing.base_revision !== account.policy_revision ||
              existing.challenge_hash !== challenge.challenge_hash || existing.expires_at !== expiresAt || existing.confirmed_at) stale();
        } else {
          // One validation and one challenge may prepare one proposal; preflight never applies a change.
          const alreadyBound = db.prepare('SELECT 1 FROM control_proposals WHERE account_id=? AND challenge_hash=? LIMIT 1')
            .get(principal.account_id, challenge.challenge_hash);
          if (alreadyBound) throw new ApiError(409, 'CONFLICT', { reason: 'challenge_binding' });
          stageControlProposal(db, { proposalId, accountId: principal.account_id, proposalHash, challengeId,
            baseRevision: account.policy_revision, target: draft.target, action: draft.operation, scope: draft.domain, expiresAt });
        }
        return recordPreflight(command, proposalId, { proposal_id: proposalId, proposal_hash: proposalHash,
          base_revision: account.policy_revision, object_revision: proof.base_revision, expires_at: expiresAt });
      });
    },
    async submitSettings(principal: Principal, request: ChangeRequest): Promise<SettingsChangeReceipt> {
      const draft = structuredClone(request.draft);
      const handler = handlerFor(draft);
      const permit = withImmediateTransaction(db, () => {
        request.assertSession?.();
        assertDomainPermission(db, principal, draft.domain, 'owner', false);
        const proof = loadProof(principal, draft, request.validationId, request.expectedRevision);
        const payloadHash = sha256([proof.validation_id, draftHash(draft), request.controlReceiptId]);
        const fingerprint = commandFingerprint({ operation, resource_id: draft.target, data_domain: draft.domain,
          expected_revision: proof.base_revision, payload_hash: payloadHash });
        const previous = db.prepare('SELECT command_id,command_fingerprint FROM command_inbox WHERE account_id=? AND caller_id=? AND client_request_id=?')
          .get(principal.account_id, principal.caller_id, request.requestId) as { command_id: string; command_fingerprint: string } | undefined;
        if (previous) {
          if (previous.command_fingerprint !== fingerprint) throw new ApiError(409, 'CONFLICT', { reason: 'idempotency' });
          return { receipt: readChange(principal, previous.command_id), fresh: false } as const;
        }
        if (!canApply(proof, binding(principal, draft, handler), now())) stale();
        if (db.prepare('SELECT 1 FROM settings_changes WHERE validation_id=? OR control_receipt_id=?')
          .get(proof.validation_id, request.controlReceiptId)) stale();
        const inFlight = db.prepare(`SELECT 1 FROM settings_changes WHERE account_id=? AND data_domain=? AND target_id=?
          AND phase IN ('applying','applied','uncertain') LIMIT 1`).get(principal.account_id, draft.domain, draft.target);
        if (inFlight) throw new ApiError(409, 'CONFLICT', { reason: 'change_in_flight' });
        handler.authorize(principal, draft, proof, request.controlReceiptId);
        const changeId = `settings_${randomUUID()}`;
        const receipt: SettingsChangeReceipt = { change_id: changeId, validation_id: proof.validation_id, operation: draft.operation,
          target_id: draft.target, phase: 'applying', applied_revision: null, verified: false, checked_at: null, issues: [], effects: [] };
        const at = now().toISOString();
        recordCommand(db, { account_id: principal.account_id, caller_id: principal.caller_id, client_request_id: request.requestId,
          command_fingerprint: fingerprint, command_id: changeId });
        db.prepare(`INSERT INTO command_records (command_id,account_id,caller_id,operation,resource_id,data_domain,permission,created_at)
          VALUES (?,?,?,?,?,?,'owner',?)`).run(changeId, principal.account_id, principal.caller_id, operation, changeId, draft.domain, at);
        db.prepare(`INSERT INTO settings_changes (change_id,validation_id,control_receipt_id,account_id,caller_id,data_domain,operation,
          target_id,phase,receipt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(changeId, proof.validation_id, request.controlReceiptId, principal.account_id, principal.caller_id,
            draft.domain, draft.operation, draft.target, receipt.phase, JSON.stringify(receipt), at, at);
        return { receipt, proof, fresh: true } as const;
      });
      if (!permit.fresh) return permit.receipt;
      const write = (receipt: SettingsChangeReceipt, prior: SettingsChangeReceipt['phase']) => withImmediateTransaction(db, () => {
        const updated = db.prepare('UPDATE settings_changes SET phase=?,receipt=?,updated_at=? WHERE change_id=? AND phase=?')
          .run(receipt.phase, JSON.stringify(receipt), now().toISOString(), receipt.change_id, prior);
        if (updated.changes !== 1) throw new Error('SETTINGS_RECEIPT_STATE_CHANGED');
        return receipt;
      });
      let applied: Applied;
      const beforeWrite = () => {
        const current = now();
        try {
          request.assertSession?.();
          assertDomainPermission(db, principal, draft.domain, 'owner', false);
          if (!canApply(permit.proof, binding(principal, draft, handler), current)) stale();
          handler.authorize(principal, draft, permit.proof, request.controlReceiptId);
        } catch (error) {
          if (error instanceof ApiError) throw new SettingsApplyBlocked('confirmation_changed');
          throw error;
        }
        return current.toISOString();
      };
      try { applied = await handler.apply(principal, draft, permit.proof, beforeWrite); }
      catch (error) {
        if (error instanceof SettingsApplyBlocked) return write({ ...permit.receipt, phase: 'observed',
          checked_at: now().toISOString(), issues: [error.issue], effects: [{ item: 'settings_target', outcome: 'blocked', revision: null }] }, 'applying');
        return write({ ...permit.receipt, phase: 'uncertain', issues: ['apply_uncertain'] }, 'applying');
      }
      const receipt = write({ ...permit.receipt, phase: 'applied', applied_revision: applied.revision, effects: applied.effects }, 'applying');
      let checked: Check;
      try { checked = await handler.recheck(principal, draft, applied); }
      catch { checked = { verified: false, issue: 'recheck_unavailable' }; }
      return write({ ...receipt, phase: 'observed', checked_at: now().toISOString(), verified: checked.verified,
        issues: checked.issue ? [checked.issue] : [] }, 'applied');
    },
    readChange,
    readScopedChange,
  };
}

export function draftHash(value: SettingsDraft): string {
  return sha256({ operation: value.operation, domain: value.domain, target: value.target, input: value.input });
}

function proposalExpiry(first: string, second: string): string { return first < second ? first : second; }

function stale(): never {
  throw new ApiError(409, 'VALIDATION_STALE', { reason: 'validation_binding' });
}
