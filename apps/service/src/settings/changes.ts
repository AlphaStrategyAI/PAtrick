import { createHash, randomUUID } from 'node:crypto';
import { canonicalPayload, type Json } from '@patrick/contracts';
import { commandFingerprint, recordCommand, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { assertDomainPermission, canConfirm, ORIGIN, RP_ID, snapshot, type Principal } from '../auth.js';
import { ApiError } from '../errors.js';
import { stageControlProposal } from '../control.js';
import { settingsControlHash } from './authority.js';
import { assertBusinessWrite } from '../recovery-runtime.js';

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
export type StoredSettingsChange = {
  changeId: string; accountId: string; callerId: string; domain: string; operation: string; targetId: string;
  validationId: string; controlReceiptId: string; phase: SettingsChangeReceipt['phase'];
  receipt: SettingsChangeReceipt; receiptBytes: string; updatedAt: string;
};
export type SettingsRecoveryOffer =
  | { change_id: string; status: 'unavailable'; reason: string }
  | { change_id: string; action: 'reconcile_network'; status: 'readback_available' | 'projection_available';
      target: { target: string; device: string; revision: number; input: { change_id: string }; label: string } };
type RecoveryChecks = Pick<SettingsHandler, 'binding' | 'validate' | 'authorize'> & {
  operation: 'reconcile_network';
  draftFor(principal: Principal, original: StoredSettingsChange): SettingsDraft;
  offer(principal: Principal, original: StoredSettingsChange): SettingsRecoveryOffer;
};
export type SettingsRecoveryOutcome = {
  state: 'settled' | 'unresolved'; applied: Applied; checked: Check; checkedAt: string;
  assertProjectionCurrent: () => void;
};
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
  apply(principal: Principal, draft: SettingsDraft, proof: Validation, beforeWrite: () => string,
    revalidateAuthorization?: () => string): Promise<Applied>;
  recheck(principal: Principal, draft: SettingsDraft, applied: Applied): Promise<Check>;
  recovery?: RecoveryChecks;
  recover?: (principal: Principal, original: StoredSettingsChange, recoveryDraft: SettingsDraft, freshProof: Validation,
    freshControlReceiptId: string, assertCurrentReadbackAuthority: () => void) => Promise<SettingsRecoveryOutcome>;
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
  const recoveryChecks = new Map<string, RecoveryChecks>();
  for (const handler of Object.values(handlers)) {
    if (!handler) continue;
    if (Boolean(handler.recovery) !== Boolean(handler.recover)) throw new Error('SETTINGS_RECOVERY_PAIR_REQUIRED');
    if (handler.recovery) {
      if (handler.recovery.operation !== 'reconcile_network') throw new Error('SETTINGS_RECOVERY_ACTION_INVALID');
      if (Object.hasOwn(handlers, handler.recovery.operation) || recoveryChecks.has(handler.recovery.operation)) {
        throw new Error('SETTINGS_RECOVERY_ACTION_DUPLICATE');
      }
      recoveryChecks.set(handler.recovery.operation, handler.recovery);
    }
  }

  function handlerFor(draft: SettingsDraft): SettingsHandler {
    const handler = Object.hasOwn(handlers, draft.operation) ? handlers[draft.operation] : undefined;
    if (!handler) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'settings_operation' });
    return handler;
  }

  function checksFor(draft: SettingsDraft): Pick<SettingsHandler, 'binding' | 'validate' | 'authorize'> {
    return recoveryChecks.get(draft.operation) ?? handlerFor(draft);
  }

  function permissionHash(principal: Principal, domain: string): string {
    const permissions = db.prepare(`SELECT permission FROM caller_scopes
      WHERE account_id=? AND caller_id=? AND data_domain=? AND revoked_at IS NULL ORDER BY permission`)
      .all(principal.account_id, principal.caller_id, domain) as { permission: string }[];
    return sha256(permissions.map(({ permission }) => permission));
  }

  function binding(principal: Principal, draft: SettingsDraft, handler: Pick<SettingsHandler, 'binding'>): BoundDraft {
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

  function storedChange(principal: Principal, changeId: string): StoredSettingsChange {
    readScopedChange(principal, changeId);
    const row = db.prepare('SELECT * FROM settings_changes WHERE change_id=?').get(changeId) as {
      account_id: string; caller_id: string; data_domain: string; operation: string; target_id: string;
      validation_id: string; control_receipt_id: string; phase: SettingsChangeReceipt['phase']; receipt: string; updated_at: string;
    };
    return { changeId, accountId: row.account_id, callerId: row.caller_id, domain: row.data_domain,
      operation: row.operation, targetId: row.target_id, validationId: row.validation_id, controlReceiptId: row.control_receipt_id,
      phase: row.phase, receipt: JSON.parse(row.receipt) as SettingsChangeReceipt, receiptBytes: row.receipt, updatedAt: row.updated_at };
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

  function assertSettingsWrite(draft: SettingsDraft): void {
    // These are explicit owner control operations. Registered server handlers still
    // enforce their own scoped T03 authorization; they confer no business admission.
    if (['disable_feishu', 'start_backup', 'start_restore', 'pause_http_source', 'disconnect_http_source'].includes(draft.operation)) return;
    assertBusinessWrite(db, draft.domain);
  }

  const readChange = (principal: Principal, changeId: string) => readScopedChange(principal, changeId).receipt;
  async function validate(principal: Principal, draft: SettingsDraft, expectedRevision?: number | null, requestId?: string) {
    draft = structuredClone(draft);
    const command: PreflightCommand = { principal, draft, expectedRevision, requestId, payload: draft,
      operation: 'validateSettings', permission: 'settings.validate' };
    assertDomainPermission(db, principal, draft.domain, command.permission);
    const previous = replayPreflight<Validation>(command);
    if (previous) return previous;
    const handler = checksFor(draft);
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
        if (!canApply(proof, binding(principal, draft, checksFor(draft)), time)) stale();
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
        assertSettingsWrite(draft);
        if (!canApply(proof, binding(principal, draft, handler), now())) stale();
        if (proofUsed(proof.validation_id, request.controlReceiptId)) stale();
        const inFlight = db.prepare(`SELECT 1 FROM settings_changes WHERE account_id=? AND data_domain=? AND target_id=?
          AND phase IN ('applying','applied','uncertain') LIMIT 1`).get(principal.account_id, draft.domain, draft.target);
        if (inFlight) throw new ApiError(409, 'CONFLICT', { reason: 'change_in_flight' });
        handler.authorize(principal, draft, proof, request.controlReceiptId);
        const changeId = `settings_${randomUUID()}`;
        const receipt: SettingsChangeReceipt = { change_id: changeId, validation_id: proof.validation_id, operation: draft.operation,
          target_id: draft.target, phase: 'applying', applied_revision: null, verified: false, checked_at: null, issues: [], effects: [] };
        const at = now().toISOString();
        if (!canApply(proof, binding(principal, draft, handler), new Date(at))) stale();
        assertSettingsWrite(draft);
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
      const revalidateAuthorization = () => {
        const current = now();
        try {
          request.assertSession?.();
          assertDomainPermission(db, principal, draft.domain, 'owner', false);
          assertSettingsWrite(draft);
          if (!permit.proof.valid || permit.proof.expires_at <= current.toISOString()) stale();
          handler.authorize(principal, draft, permit.proof, request.controlReceiptId);
          assertSettingsWrite(draft);
        } catch (error) {
          if (error instanceof ApiError) throw new SettingsApplyBlocked('confirmation_changed');
          throw error;
        }
        return current.toISOString();
      };
      const beforeWrite = () => {
        const at = revalidateAuthorization();
        if (!canApply(permit.proof, binding(principal, draft, handler), new Date(at))) {
          throw new SettingsApplyBlocked('confirmation_changed');
        }
        try { assertSettingsWrite(draft); }
        catch (error) {
          if (error instanceof ApiError) throw new SettingsApplyBlocked('confirmation_changed');
          throw error;
        }
        return at;
      };
      try { applied = await handler.apply(principal, draft, permit.proof, beforeWrite, revalidateAuthorization); }
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
    recoveryOffer(principal: Principal, changeId: string): SettingsRecoveryOffer {
      const original = storedChange(principal, changeId);
      if (!canConfirm(principal)) return { change_id: changeId, status: 'unavailable', reason: 'owner_required' };
      try { assertDomainPermission(db, principal, original.domain, 'owner', false); }
      catch { return { change_id: changeId, status: 'unavailable', reason: 'owner_required' }; }
      const handler = handlers[original.operation];
      if (!handler?.recovery) return { change_id: changeId, status: 'unavailable', reason: 'recovery_unregistered' };
      return handler.recovery.offer(principal, original);
    },
    async recoverSettings(principal: Principal, request: ChangeRequest & { changeId: string; expectedRevision: number; assertSession: () => void }) {
      const draft = structuredClone(request.draft);
      const original = storedChange(principal, request.changeId);
      const handler = handlers[original.operation];
      const checks = handler?.recovery;
      if (!checks || !handler.recover) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'settings_recovery' });
      const fingerprint = commandFingerprint({ operation: 'recoverSettingsChange', resource_id: original.changeId,
        data_domain: original.domain, expected_revision: request.expectedRevision,
        payload_hash: sha256([draftHash(draft), request.validationId, request.controlReceiptId]) });
      const assertOwner = () => {
        request.assertSession();
        if (!canConfirm(principal)) throw new ApiError(403, 'FORBIDDEN', { reason: 'caller' });
        assertDomainPermission(db, principal, original.domain, 'owner', false);
      };
      const permit = withImmediateTransaction(db, () => {
        assertOwner();
        const prior = db.prepare(`SELECT i.command_id,i.command_fingerprint,r.change_id,r.receipt FROM command_inbox i
          LEFT JOIN settings_recoveries r USING(command_id) WHERE i.account_id=? AND i.caller_id=? AND i.client_request_id=?`)
          .get(principal.account_id, principal.caller_id, request.requestId) as
          { command_id: string; command_fingerprint: string; change_id: string | null; receipt: string | null } | undefined;
        if (prior && (prior.command_fingerprint !== fingerprint || prior.change_id !== original.changeId)) {
          throw new ApiError(409, 'CONFLICT', { reason: 'idempotency' });
        }
        if (prior?.receipt) return { completed: JSON.parse(prior.receipt) as { recovery_command_id: string; receipt: SettingsChangeReceipt } };
        const expectedDraft = checks.draftFor(principal, original);
        if (draftHash(expectedDraft) !== draftHash(draft)) stale();
        const proof = loadProof(principal, draft, request.validationId, request.expectedRevision);
        const live = binding(principal, draft, checks);
        if (!canApply(proof, live, now())) stale();
        checks.authorize(principal, draft, proof, request.controlReceiptId);
        if (!prior && proofUsed(proof.validation_id, request.controlReceiptId)) stale();
        if (prior) {
          const source = db.prepare('SELECT source_digest FROM settings_recoveries WHERE command_id=?').get(prior.command_id) as { source_digest: string };
          if (source.source_digest !== live.scopeHash) stale();
          return { commandId: prior.command_id, proof, permissionHash: permissionHash(principal, original.domain) };
        }
        const commandId = `settings_recovery_${randomUUID()}`;
        const at = now().toISOString();
        recordCommand(db, { account_id: principal.account_id, caller_id: principal.caller_id, client_request_id: request.requestId,
          command_fingerprint: fingerprint, command_id: commandId });
        db.prepare(`INSERT INTO command_records(command_id,account_id,caller_id,operation,resource_id,data_domain,permission,created_at)
          VALUES (?,?,?,'recoverSettingsChange',?,?,'owner',?)`).run(commandId, principal.account_id, principal.caller_id, original.changeId, original.domain, at);
        db.prepare(`INSERT INTO settings_recoveries(command_id,change_id,validation_id,control_receipt_id,account_id,caller_id,
          auth_epoch,expected_revision,source_digest,phase,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`)
          .run(commandId, original.changeId, proof.validation_id, request.controlReceiptId, principal.account_id, principal.caller_id,
            principal.auth_epoch, request.expectedRevision, live.scopeHash, at, at);
        return { commandId, proof, permissionHash: permissionHash(principal, original.domain) };
      });
      if ('completed' in permit) return permit.completed;
      const assertFreshRecoveryControl = () => {
        assertOwner();
        const proof = loadProof(principal, draft, request.validationId, request.expectedRevision);
        if (!proof.valid || proof.expires_at <= now().toISOString() ||
            proof.draft_hash !== draftHash(draft) || permissionHash(principal, original.domain) !== permit.permissionHash) stale();
        checks.authorize(principal, draft, proof, request.controlReceiptId);
      };
      const assertReadbackSourceCurrent = () => {
        assertFreshRecoveryControl();
        if (!canApply(permit.proof, binding(principal, draft, checks), now())) stale();
      };
      let outcome: SettingsRecoveryOutcome;
      try {
        assertReadbackSourceCurrent();
        outcome = await handler.recover(principal, original, draft, permit.proof, request.controlReceiptId, assertReadbackSourceCurrent);
      } catch (error) {
        withImmediateTransaction(db, () => {
          db.prepare("UPDATE settings_recoveries SET phase='unresolved',updated_at=? WHERE command_id=? AND receipt IS NULL")
            .run(now().toISOString(), permit.commandId);
        });
        throw error;
      }
      return withImmediateTransaction(db, () => {
        assertFreshRecoveryControl();
        outcome.assertProjectionCurrent();
        const receipt: SettingsChangeReceipt = { ...original.receipt,
          phase: outcome.state === 'settled' ? 'observed' : 'uncertain', applied_revision: outcome.applied.revision,
          effects: outcome.applied.effects, verified: outcome.state === 'settled' && outcome.checked.verified,
          checked_at: outcome.checkedAt, issues: outcome.checked.issue ? [outcome.checked.issue] : [] };
        const edited = db.prepare(`UPDATE settings_changes SET phase=?,receipt=?,updated_at=?
          WHERE change_id=? AND phase=? AND receipt=? AND updated_at=?`)
          .run(receipt.phase, JSON.stringify(receipt), now().toISOString(), original.changeId, original.phase, original.receiptBytes, original.updatedAt);
        const result = { recovery_command_id: permit.commandId,
          receipt: edited.changes === 1 ? receipt : readChange(principal, original.changeId) };
        db.prepare('UPDATE settings_recoveries SET phase=?,receipt=?,updated_at=? WHERE command_id=? AND receipt IS NULL')
          .run(edited.changes === 1 ? outcome.state === 'settled' ? 'observed' : 'unresolved' : 'superseded',
            JSON.stringify(result), now().toISOString(), permit.commandId);
        return result;
      });
    },
    readChange,
    readScopedChange,
  };

  function proofUsed(validationId: string, receiptId: string): boolean {
    return Boolean(db.prepare(`SELECT 1 FROM settings_changes WHERE validation_id=? OR control_receipt_id=?
      UNION ALL SELECT 1 FROM settings_recoveries WHERE validation_id=? OR control_receipt_id=? LIMIT 1`)
      .get(validationId, receiptId, validationId, receiptId));
  }
}

export function draftHash(value: SettingsDraft): string {
  return sha256({ operation: value.operation, domain: value.domain, target: value.target, input: value.input });
}

function proposalExpiry(first: string, second: string): string { return first < second ? first : second; }

function stale(): never {
  throw new ApiError(409, 'VALIDATION_STALE', { reason: 'validation_binding' });
}
