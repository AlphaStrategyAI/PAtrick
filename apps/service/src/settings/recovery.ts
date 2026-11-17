import { createHash } from 'node:crypto';
import { canonicalPayload, type Json } from '@patrick/contracts';
import type { CredentialStore } from '@patrick/host';
import type { SqliteDatabase } from '@patrick/storage';
import { createRecoveryOperations, type RecoveryOperationRequest, type RecoveryOperationStatus, type RecoveryOperationTarget } from '../../../../packages/host/src/recovery/operations.js';
import { assertDomainPermission, canConfirm, type Principal } from '../auth.js';
import { ApiError } from '../errors.js';
import { assertSettingsControl, settingsControlHash } from './authority.js';
import { draftHash, SettingsApplyBlocked, type SettingsDraft, type SettingsHandler, type StoredSettingsChange } from './changes.js';

export type RecoverySettingsConfiguration = Parameters<typeof createRecoveryOperations>[0] & {
  /** Trusted catalogue entry for the exact configured set. Updated by the host after verified capture. */
  restoreManifests?: Readonly<Record<string, string>>;
};
const digest = (value: unknown) => createHash('sha256').update(canonicalPayload(value as Json)).digest('hex');
const actions = { start_backup: 'readback_recovery_backup', start_restore: 'readback_recovery_drill' } as const;
type Operation = keyof typeof actions;
function reject(reason: string): never { throw new ApiError(422, 'UNPROCESSABLE', { reason }); }

function targetFor(configuration: RecoverySettingsConfiguration, targetId: string, operation: Operation) {
  const target = Object.hasOwn(configuration.targets, targetId) ? configuration.targets[targetId] : undefined;
  const revision = Number(target?.identity.configRevision);
  if (typeof target?.backup?.options.freeze?.acquire !== 'function' || !configuration.authority?.keyId ||
      typeof configuration.authority.sign !== 'function' || typeof configuration.authority.verify !== 'function' ||
      !target.backup.options.authority?.keyId || typeof target.backup.options.authority.sign !== 'function' ||
      typeof target.backup.options.authority.verify !== 'function' ||
      !Number.isSafeInteger(revision) || revision < 0 || String(revision) !== target.identity.configRevision ||
      (operation === 'start_restore' && (!target.drill || !/^[a-f0-9]{64}$/.test(configuration.restoreManifests?.[targetId] ?? '')))) {
    return reject('recovery_ports_unavailable');
  }
  return { target, revision };
}
function inputFor(configuration: RecoverySettingsConfiguration, targetId: string, operation: Operation): Json {
  const { target } = targetFor(configuration, targetId, operation);
  return operation === 'start_backup' ? {} : { set_id: target.backup!.scope.setId, mode: 'drill', manifest_hash: configuration.restoreManifests![targetId] };
}
function configurationDigest(configuration: RecoverySettingsConfiguration, targetId: string, operation: Operation) {
  const { target } = targetFor(configuration, targetId, operation);
  return digest({ protocol: 'settings-recovery-v1', root: configuration.root, authority: configuration.authority.keyId,
    targetId, identity: target.identity, scope: target.backup!.scope, backupRoot: target.backup!.options.root,
    backupAuthority: target.backup!.options.authority.keyId, offHost: Boolean(target.backup!.options.offHost),
    ...(operation === 'start_restore' ? { input: inputFor(configuration, targetId, operation),
      recoveryRoot: target.drill!.recoveryRoot, isolationRoot: target.drill!.isolationRoot, authority: target.drill!.authority.keyId,
      versionLocks: target.drill!.versionLocks, survivors: target.drill!.survivors ?? [], witness: Boolean(target.drill!.witness),
      replay: Boolean(target.drill!.replay), fence: Boolean(target.drill!.fence), withdrawalLog: Boolean(target.drill!.withdrawalLog) } : {}),
  });
}
function operationRequest(targetId: string, operation: Operation, operationId: string, input: Json): RecoveryOperationRequest {
  return { operationId, targetId, mode: operation === 'start_backup' ? 'backup' : 'drill',
    ...(operation === 'start_restore' ? { manifestHash: (input as { manifest_hash: string }).manifest_hash } : {}) };
}
function operationId(account: string, caller: string, validationId: string, controlReceiptId: string, hash: string) {
  return 'settings-recovery-' + digest([account, caller, validationId, controlReceiptId, hash]);
}
function applied(status: RecoveryOperationStatus, id: string, revision: number) {
  if (status.status !== 'completed') throw new Error('RECOVERY_OPERATION_UNCERTAIN');
  if (status.outcome.receipt && (status.outcome.receipt.mode !== 'drill' || status.outcome.receipt.external_writes !== 0)) throw new Error('RECOVERY_DRILL_INVALID');
  return { revision, effects: [{ item: 'recovery:operation:' + id, outcome: 'applied' as const, revision },
    { item: status.outcome.receipt ? 'recovery_drill' : 'recovery_backup', outcome: 'applied' as const, revision }] };
}

export function recoverySettingsHandlers(options: {
  db: SqliteDatabase; credentials: CredentialStore; now: () => Date; recoveryOperations?: RecoverySettingsConfiguration;
}): Readonly<Partial<Record<string, SettingsHandler>>> {
  const { db, credentials, now, recoveryOperations: configuration } = options;
  if (!configuration) return {};
  const operations = createRecoveryOperations(configuration);
  function owner(principal: Principal, target: RecoveryOperationTarget) {
    if (!canConfirm(principal) || principal.account_id !== target.identity.accountId) reject('recovery_owner_required');
    for (const domain of target.identity.domains) assertDomainPermission(db, principal, domain, 'owner', false);
  }
  function bound(principal: Principal, draft: SettingsDraft, operation: Operation) {
    const { target, revision } = targetFor(configuration!, draft.target, operation);
    if (principal.account_id !== target.identity.accountId || !target.identity.domains.includes(draft.domain)) reject('recovery_target_binding');
    if (draft.operation !== operation || digest(draft.input) !== digest(inputFor(configuration!, draft.target, operation))) reject('recovery_draft_binding');
    owner(principal, target);
    const permissions = target.identity.domains.map((domain) => ({ domain, permissions: db.prepare(`SELECT permission FROM caller_scopes
      WHERE account_id=? AND caller_id=? AND data_domain=? AND revoked_at IS NULL ORDER BY permission`).all(principal.account_id, principal.caller_id, domain) }));
    return { revision, deviceId: target.identity.deviceId, identityId: target.identity.scopeId,
      scopeHash: digest([configurationDigest(configuration!, draft.target, operation), permissions]) };
  }
  function authorize(principal: Principal, draft: SettingsDraft, proof: Parameters<SettingsHandler['authorize']>[2], receiptId: string) {
    owner(principal, targetFor(configuration!, draft.target, draft.operation.includes('drill') || draft.operation === 'start_restore' ? 'start_restore' : 'start_backup').target);
    assertSettingsControl(db, credentials, principal, now(), receiptId, { operation: draft.operation, target: draft.target,
      domain: draft.domain, draftHash: proof.draft_hash, validationId: proof.validation_id, objectRevision: proof.base_revision });
  }
  function handler(operation: Operation): SettingsHandler {
    const action = actions[operation];
    function source(principal: Principal, changeId: string) {
      const row = db.prepare(`SELECT s.*,v.draft_hash,v.base_revision,v.device_id,v.identity_id,v.auth_epoch AS proof_epoch,
        r.auth_epoch AS receipt_epoch,r.proposal_hash AS receipt_hash,r.base_revision AS receipt_revision,
        p.proposal_hash,p.base_revision AS policy_revision,p.target AS proposal_target,p.action,p.scope,p.confirmed_at
        FROM settings_changes s JOIN settings_validations v ON v.validation_id=s.validation_id AND v.account_id=s.account_id
          AND v.caller_id=s.caller_id AND v.data_domain=s.data_domain AND v.operation=s.operation AND v.target_id=s.target_id
        JOIN control_receipts r ON r.receipt_id=s.control_receipt_id AND r.account_id=s.account_id AND r.caller_id=s.caller_id AND r.result='confirmed'
        JOIN control_proposals p ON p.proposal_id=r.proposal_id AND p.account_id=r.account_id WHERE s.change_id=?`).get(changeId) as {
          account_id: string; caller_id: string; data_domain: string; operation: string; target_id: string; validation_id: string;
          control_receipt_id: string; draft_hash: string; base_revision: number; device_id: string; identity_id: string;
          proof_epoch: number; receipt_epoch: number; receipt_hash: string; receipt_revision: number; proposal_hash: string;
          policy_revision: number; proposal_target: string; action: string; scope: string; confirmed_at: string | null;
        } | undefined;
      if (!row || row.operation !== operation || row.account_id !== principal.account_id) reject('recovery_source_unavailable');
      const draft: SettingsDraft = { operation, target: row.target_id, domain: row.data_domain, input: inputFor(configuration!, row.target_id, operation) };
      const binding = bound(principal, draft, operation);
      const expectedHash = settingsControlHash({ operation, target: row.target_id, domain: row.data_domain,
        draftHash: row.draft_hash, validationId: row.validation_id, objectRevision: row.base_revision });
      if (draftHash(draft) !== row.draft_hash || row.base_revision !== binding.revision || row.device_id !== binding.deviceId ||
          row.identity_id !== binding.identityId || row.proof_epoch !== row.receipt_epoch || !row.confirmed_at ||
          row.receipt_hash !== expectedHash || row.proposal_hash !== expectedHash || row.receipt_revision !== row.policy_revision ||
          row.proposal_target !== row.target_id || row.action !== operation || row.scope !== row.data_domain) reject('recovery_source_provenance');
      return { row, draft, binding, sourceDigest: digest(row), request: operationRequest(row.target_id, operation,
        operationId(row.account_id, row.caller_id, row.validation_id, row.control_receipt_id, row.draft_hash), draft.input) };
    }
    function readbackSource(principal: Principal, draft: SettingsDraft) {
      if (draft.operation !== action || !draft.input || typeof draft.input !== 'object' || Array.isArray(draft.input) ||
          Object.keys(draft.input).length !== 1 || typeof draft.input.change_id !== 'string') reject('recovery_readback_binding');
      const current = source(principal, (draft.input as { change_id: string }).change_id);
      if (draft.target !== current.row.target_id || draft.domain !== current.row.data_domain) reject('recovery_readback_binding');
      return current;
    }
    return {
      binding: (principal, draft) => bound(principal, draft, operation),
      async validate(principal, draft) {
        bound(principal, draft, operation);
        try {
          await operations.read(operationRequest(draft.target, operation, 'settings-preflight', draft.input));
          bound(principal, draft, operation);
          return { valid: true };
        } catch { return { valid: false }; }
      },
      authorize,
      async apply(principal, draft, proof, beforeWrite) {
        // The original T03 receipt is loaded by validation identity, never selected from a draft.
        const row = db.prepare('SELECT control_receipt_id FROM settings_changes WHERE validation_id=?').get(proof.validation_id) as { control_receipt_id: string };
        const id = operationId(principal.account_id, principal.caller_id, proof.validation_id, row.control_receipt_id, proof.draft_hash);
        const request = operationRequest(draft.target, operation, id, draft.input);
        beforeWrite();
        await operations.reserve(request);
        beforeWrite();
        const status = await operations.run(request, () => { beforeWrite(); });
        beforeWrite();
        return applied(status, id, proof.base_revision);
      },
      async recheck(principal, draft, result, assertCurrent) {
        const effect = result.effects.find(({ item }) => item.startsWith('recovery:operation:'));
        if (!effect) return { verified: false, issue: 'recovery_operation_unavailable' };
        const request = operationRequest(draft.target, operation, effect.item.slice('recovery:operation:'.length), draft.input);
        const status = await operations.read(request);
        assertCurrent?.(); bound(principal, draft, operation);
        return { verified: status.status === 'completed', ...(status.status !== 'completed' ? { issue: 'recovery_operation_uncertain' } : {}),
          assertProjectionCurrent() { assertCurrent?.(); bound(principal, draft, operation); } };
      },
      recovery: {
        operation: action,
        draftFor(principal, original) {
          source(principal, original.changeId);
          return { operation: action, domain: original.domain, target: original.targetId, input: { change_id: original.changeId } };
        },
        offer(principal, original) {
          try {
            const current = source(principal, original.changeId);
            return { change_id: original.changeId, action, status: 'readback_available' as const,
              target: { target: original.targetId, device: current.binding.deviceId, revision: current.binding.revision,
                input: { change_id: original.changeId }, label: operation === 'start_backup' ? 'Backup readback' : 'Isolated drill readback' } };
          } catch (error) {
            if (!(error instanceof ApiError)) throw error;
            return { change_id: original.changeId, status: 'unavailable' as const, reason: String(error.params.reason ?? 'recovery_source_unavailable') };
          }
        },
        binding(principal, draft) {
          const current = readbackSource(principal, draft);
          return { ...current.binding, scopeHash: digest([current.binding.scopeHash, current.sourceDigest, current.request]) };
        },
        async validate(principal, draft) { readbackSource(principal, draft); return { valid: true }; }, authorize,
      },
      async recover(principal, original: StoredSettingsChange, draft, _proof, _receiptId, assertCurrent) {
        const before = readbackSource(principal, draft);
        if (before.row.validation_id !== original.validationId || before.row.control_receipt_id !== original.controlReceiptId) reject('recovery_source_provenance');
        assertCurrent();
        const status = await operations.read(before.request);
        assertCurrent();
        const current = readbackSource(principal, draft);
        if (current.sourceDigest !== before.sourceDigest) reject('recovery_source_changed');
        const complete = status.status === 'completed';
        return { state: complete ? 'settled' : 'unresolved',
          applied: complete ? applied(status, before.request.operationId, current.binding.revision) : { revision: null, effects: [] },
          checked: { verified: complete, ...(!complete ? { issue: 'recovery_operation_uncertain' } : {}) }, checkedAt: now().toISOString(),
          assertProjectionCurrent() {
            assertCurrent();
            if (readbackSource(principal, draft).sourceDigest !== before.sourceDigest) throw new SettingsApplyBlocked('recovery_source_changed');
          } };
      },
    };
  }
  return { start_backup: handler('start_backup'), start_restore: handler('start_restore') };
}

export function registeredRecoveryTargets(configuration: RecoverySettingsConfiguration | undefined, principal: Principal, domain: string, operation: string) {
  if (!configuration || (operation !== 'start_backup' && operation !== 'start_restore')) return [];
  return Object.keys(configuration.targets).flatMap((id) => {
    try {
      const { target, revision } = targetFor(configuration, id, operation);
      if (principal.account_id !== target.identity.accountId || !target.identity.domains.includes(domain)) return [];
      return [{ target: id, device: target.identity.deviceId, revision, status: 'registered',
        label: target.backup!.scope.setId, input: inputFor(configuration, id, operation) }];
    } catch (error) { if (!(error instanceof ApiError)) throw error; return []; }
  });
}
