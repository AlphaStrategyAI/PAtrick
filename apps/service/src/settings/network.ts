import { hostname } from 'node:os';
import type { CredentialStore } from '@patrick/host';
import type { SqliteDatabase } from '@patrick/storage';
import { createMacNetworkActuator, readMacRoute, readMacSecureProxy } from '../../../../packages/host/src/network/native.js';
import { createNodeNetworkProbePorts } from '../../../../packages/host/src/network/node-probes.js';
import { connectivityProbeHosts, createNetworkInspector, parseConnectivityHostname } from '../../../../packages/host/src/network/probes.js';
import { createNetworkControlAuthority, createNetworkSettingsHandler, networkReceiptToApplied } from '../../../../packages/host/src/network/settings.js';
import { createNetworkSupervisor, networkRepairPolicyDigest, type RepairReceipt } from '../../../../packages/host/src/network/supervisor.js';
import { parseNetworkPolicy, type NetworkPolicy } from '../../../../packages/host/src/network/vpn.js';
import { assertDomainPermission, canConfirm, type Principal } from '../auth.js';
import { ApiError } from '../errors.js';
import { assertSettingsControl, settingsControlHash } from './authority.js';
import { draftHash, SettingsApplyBlocked, type SettingsDraft, type SettingsHandler, type StoredSettingsChange } from './changes.js';

export type NetworkRepairConfiguration = Readonly<Omit<Parameters<typeof createNetworkSettingsHandler>[0],
  'db' | 'now' | 'authority' | 'reject'>>;
export type NativeNetworkConfiguration = Readonly<{
  accountId: string; domain: string; localDeviceId: string; policy: NetworkPolicy;
  endpoints: Parameters<typeof createNodeNetworkProbePorts>[0]['endpoints'];
  nativeBindings: Parameters<typeof createMacNetworkActuator>[0]['bindings']; snapshotDirectory: string;
  nativeRuntime?: Pick<Parameters<typeof createMacNetworkActuator>[0], 'platform' | 'runCommand'>;
}>;

/** Native probes and mutations are enabled only by an explicitly registered host configuration. */
export function createNativeNetworkRepairConfiguration(input: NativeNetworkConfiguration): NetworkRepairConfiguration {
  const policy = parseNetworkPolicy(input.policy);
  const bindings = structuredClone(input.nativeBindings);
  const proxyServices = new Map<string, string>();
  for (const binding of bindings) {
    const repair = policy.repairs.find(({ id }) => id === binding.repairId);
    if (repair?.kind === 'refresh_proxy' && 'service' in binding) {
      if (proxyServices.has(repair.target) && proxyServices.get(repair.target) !== binding.service) {
        throw new Error('NETWORK_PROXY_SERVICE_AMBIGUOUS');
      }
      proxyServices.set(repair.target, binding.service);
    }
  }
  const ports = createNodeNetworkProbePorts({ policy, localDeviceId: input.localDeviceId, endpoints: input.endpoints,
    local: { route: (target, signal) => {
      const endpoint = input.endpoints.find(({ targetId }) => targetId === target.id)!;
      return readMacRoute({ ...input.nativeRuntime, host: new URL(endpoint.url).hostname.replace(/^\[|\]$/gu, '') }, signal);
    } },
    proxy: (targetId, signal) => {
      const service = proxyServices.get(targetId);
      return service ? readMacSecureProxy({ ...input.nativeRuntime, service }, signal) : Promise.resolve(null);
    },
  });
  const inspect = createNetworkInspector(policy, ports);
  return Object.freeze({ policy, accountId: input.accountId, domain: input.domain, localDeviceId: input.localDeviceId,
    actuator: createMacNetworkActuator({ policy, localDeviceId: input.localDeviceId,
      ...input.nativeRuntime, bindings, snapshotDirectory: input.snapshotDirectory }),
    async observe({ deviceId, targetIds, signal }) {
      if (deviceId !== input.localDeviceId) throw new Error('NETWORK_DEVICE_NOT_REGISTERED');
      const report = await inspect(targetIds, signal);
      return report.targets.map(({ targetId, outcome, retryAfterMs }) => ({ targetId, problem: outcome, retryAfterMs }));
    },
  });
}

export function networkSettingsHandlers(options: {
  db: SqliteDatabase; credentials: CredentialStore; now: () => Date; networkRepair?: NetworkRepairConfiguration;
}): Readonly<Partial<Record<string, SettingsHandler>>> {
  const { db, credentials, now, networkRepair } = options;
  const reject = (reason: string): never => { throw new ApiError(403, 'FORBIDDEN', { reason }); };
  const connectivity = connectivitySettingsHandler({
    db, now, deviceId: hostname(),
    authorize(principal, draft, proof, controlReceiptId) {
      assertDomainPermission(db, principal, draft.domain, 'owner', false);
      assertSettingsControl(db, credentials, principal, now(), controlReceiptId, {
        operation: draft.operation, target: draft.target, domain: draft.domain,
        draftHash: proof.draft_hash, validationId: proof.validation_id, objectRevision: proof.base_revision,
      });
    },
  });
  if (!networkRepair) return { set_connectivity_targets: connectivity };
  const authority = createNetworkControlAuthority({ db, now, reject,
    assertControl({ principal, draft, proof, controlReceiptId }) {
      assertDomainPermission(db, principal, draft.domain, 'owner', false);
      assertSettingsControl(db, credentials, principal, now(), controlReceiptId, {
        operation: draft.operation, target: draft.target, domain: draft.domain,
        draftHash: proof.draft_hash, validationId: proof.validation_id, objectRevision: proof.base_revision,
      });
    },
  });
  const handler = createNetworkSettingsHandler({ ...networkRepair, db, now, reject, authority });
  return {
    set_connectivity_targets: connectivity,
    repair_network: withNetworkRecovery({ ...networkRepair, db, now, reject, authority }, handler),
  };
}

type RecoverySourceRow = {
  change_id: string; account_id: string; caller_id: string; data_domain: string; device_id: string; operation: string;
  validation_id: string; control_receipt_id: string; draft_hash: string; base_revision: number; proof_device_id: string;
  identity_id: string; original_auth_epoch: number; receipt_auth_epoch: number; proposal_id: string; receipt_proposal_hash: string;
  proposal_hash: string; receipt_policy_revision: number; original_policy_revision: number; action: string; control_target: string;
  scope: string; confirmed_at: string | null; expected_epoch: number; network_target_id: string; repair_id: string;
  policy_digest: string; attempts: number; receipt_json: string | null; current_epoch: number;
  owner_id: string | null; lock_token: string | null; apply_epoch: number | null; changed_rule: string | null; restore_epoch: number | null;
};
const digest = (value: Json) => createHash('sha256').update(canonicalPayload(value)).digest('hex');

function withNetworkRecovery(
  options: Parameters<typeof createNetworkSettingsHandler>[0], handler: SettingsHandler,
): SettingsHandler {
  const { db, policy, now } = options;
  const deviceId = options.localDeviceId;
  const policyDigest = networkRepairPolicyDigest(policy, options.actuator);
  const fail = (reason: string): never => { throw new ApiError(409, 'VALIDATION_STALE', { reason }); };
  function loadNetworkRecoverySource(principal: Principal, changeId: string) {
    if (!canConfirm(principal)) return options.reject('owner_required');
    assertDomainPermission(db, principal, options.domain, 'owner', false);
    const row = db.prepare(`SELECT s.change_id,s.account_id,s.caller_id,s.data_domain,s.operation,s.target_id AS device_id,
      s.validation_id,s.control_receipt_id,v.draft_hash,v.base_revision,v.device_id AS proof_device_id,v.identity_id,
      v.auth_epoch AS original_auth_epoch,r.auth_epoch AS receipt_auth_epoch,r.proposal_id,
      r.proposal_hash AS receipt_proposal_hash,r.base_revision AS receipt_policy_revision,p.proposal_hash,
      p.base_revision AS original_policy_revision,p.target AS control_target,p.action,p.scope,p.confirmed_at,
      n.expected_epoch,n.target_id AS network_target_id,n.repair_id,n.policy_digest,n.attempts,n.receipt_json,
      d.epoch AS current_epoch,d.owner_id,d.lock_token,a.apply_epoch,a.changed_rule,a.restore_epoch
      FROM settings_changes s JOIN settings_validations v ON v.validation_id=s.validation_id
        AND v.account_id=s.account_id AND v.caller_id=s.caller_id AND v.data_domain=s.data_domain
        AND v.operation=s.operation AND v.target_id=s.target_id
      JOIN control_receipts r ON r.receipt_id=s.control_receipt_id AND r.account_id=s.account_id
        AND r.caller_id=s.caller_id AND r.result='confirmed'
      JOIN control_proposals p ON p.proposal_id=r.proposal_id AND p.account_id=r.account_id
      JOIN network_repair_operations n ON n.device_id=s.target_id AND n.proposal_id=r.proposal_id AND n.confirmation_id=r.receipt_id
      JOIN network_device_state d ON d.device_id=n.device_id
      LEFT JOIN network_repair_attempts a ON a.device_id=n.device_id AND a.proposal_id=n.proposal_id AND a.attempt=n.attempts
      WHERE s.change_id=? AND s.account_id=? AND s.operation='repair_network'`)
      .get(changeId, principal.account_id) as RecoverySourceRow | undefined;
    if (!row) return fail('network_intent_unavailable');
    const originalDraft: SettingsDraft = { operation: 'repair_network', domain: row.data_domain, target: row.device_id,
      input: { target_id: row.network_target_id, repair_id: row.repair_id } };
    const controlHash = settingsControlHash({ operation: originalDraft.operation, target: row.device_id, domain: row.data_domain,
      validationId: row.validation_id, draftHash: row.draft_hash, objectRevision: row.base_revision });
    if (principal.account_id !== options.accountId || row.account_id !== options.accountId || row.data_domain !== options.domain ||
        row.device_id !== deviceId || row.proof_device_id !== deviceId || row.identity_id !== deviceId ||
        row.original_auth_epoch !== row.receipt_auth_epoch || !row.confirmed_at ||
        row.original_policy_revision !== row.receipt_policy_revision || row.action !== 'repair_network' ||
        row.control_target !== deviceId || row.scope !== row.data_domain || row.base_revision !== row.expected_epoch ||
        draftHash(originalDraft) !== row.draft_hash || row.receipt_proposal_hash !== controlHash || row.proposal_hash !== controlHash ||
        row.policy_digest !== policyDigest ||
        !policy.repairs.some(({ id, target }) => id === row.repair_id && target === row.network_target_id)) fail('network_provenance');
    const receipt = row.receipt_json ? JSON.parse(row.receipt_json) as RepairReceipt : null;
    if (receipt && (receipt.proposalId !== row.proposal_id || receipt.deviceId !== deviceId || receipt.attempts !== row.attempts)) {
      fail('network_provenance');
    }
    const immutableDigest = digest([row.change_id, row.account_id, row.caller_id, row.data_domain, row.device_id,
      row.validation_id, row.control_receipt_id, row.proposal_id, row.draft_hash, row.expected_epoch,
      row.network_target_id, row.repair_id, row.policy_digest, row.original_auth_epoch, row.receipt_auth_epoch,
      row.original_policy_revision, row.receipt_policy_revision, row.confirmed_at, controlHash]);
    const sourceDigest = digest([immutableDigest, row.current_epoch, row.owner_id, row.lock_token,
      row.apply_epoch, row.changed_rule, row.restore_epoch, row.attempts, row.receipt_json]);
    const settledApply = Boolean(row.changed_rule && /^[a-f0-9]{64}$/u.test(row.changed_rule) && row.restore_epoch === null);
    const readback = settledApply && row.owner_id === row.proposal_id && Boolean(row.lock_token) &&
      row.apply_epoch === row.current_epoch && (!receipt || ['unresolved', 'in_progress'].includes(receipt.state));
    const projection = settledApply && receipt?.state === 'repaired' && receipt.epoch === row.apply_epoch &&
      row.current_epoch >= row.apply_epoch! && (row.current_epoch !== row.apply_epoch || row.lock_token === null);
    return { row, receipt, originalDraft, sourceDigest, immutableDigest,
      status: readback ? 'readback_available' as const : projection ? 'projection_available' as const : 'unavailable' as const };
  }
  function request(principal: Principal, draft: SettingsDraft) {
    if (principal.account_id !== options.accountId || draft.operation !== 'reconcile_network' || draft.domain !== options.domain ||
        draft.target !== deviceId || !draft.input || typeof draft.input !== 'object' || Array.isArray(draft.input) ||
        Object.keys(draft.input).length !== 1 || typeof draft.input.change_id !== 'string') return options.reject('network_recovery_binding');
    return draft.input.change_id;
  }
  function eligible(principal: Principal, draft: SettingsDraft) {
    const source = loadNetworkRecoverySource(principal, request(principal, draft));
    if (source.status === 'unavailable') fail('network_effect_unsettled');
    return source;
  }
  const recovery: NonNullable<SettingsHandler['recovery']> = {
    operation: 'reconcile_network',
    offer(principal, original) {
      try {
        const source = loadNetworkRecoverySource(principal, original.changeId);
        if (source.status === 'unavailable') return { change_id: original.changeId, status: 'unavailable', reason: 'network_effect_unsettled' };
        return { change_id: original.changeId, action: 'reconcile_network', status: source.status,
          target: { target: deviceId, device: deviceId, revision: source.row.current_epoch, input: { change_id: original.changeId },
            label: `${source.row.network_target_id} / ${source.row.repair_id}` } };
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        return { change_id: original.changeId, status: 'unavailable', reason: String(error.params.reason ?? 'network_provenance') };
      }
    },
    draftFor(principal, original) {
      const draft = { operation: 'reconcile_network', domain: original.domain, target: original.targetId, input: { change_id: original.changeId } };
      eligible(principal, draft);
      return draft;
    },
    binding(principal, draft) {
      const source = eligible(principal, draft);
      return { revision: source.row.current_epoch, deviceId, identityId: deviceId,
        scopeHash: digest(['network-readback-v1', policyDigest, source.sourceDigest]) };
    },
    async validate(principal, draft) { eligible(principal, draft); return { valid: true }; },
    authorize(principal, draft, proof, controlReceiptId) {
      request(principal, draft);
      options.authority({ principal, draft, proof, controlReceiptId });
    },
  };
  return { ...handler, recovery,
    async recover(principal, original: StoredSettingsChange, draft, proof, controlReceiptId, assertCurrentReadbackAuthority) {
      const before = eligible(principal, draft);
      if (before.row.change_id !== original.changeId) fail('network_recovery_binding');
      assertCurrentReadbackAuthority();
      let receipt = before.receipt;
      if (before.status === 'readback_available') {
        const supervisor = createNetworkSupervisor(db, { policy, actuator: options.actuator, observe: options.observe,
          now: () => now().getTime(), confirmation: () => null,
          reconciliationAuthority(proposalId, expectedEpoch) {
            assertCurrentReadbackAuthority();
            const source = eligible(principal, draft);
            if (source.row.proposal_id !== proposalId || source.row.expected_epoch !== expectedEpoch ||
                source.sourceDigest !== before.sourceDigest) return null;
            return { source: { proposalId, confirmationId: source.row.control_receipt_id, deviceId,
              targetId: source.row.network_target_id, repairId: source.row.repair_id, policyDigest,
              expectedEpoch, ownerEpoch: source.row.current_epoch },
              freshControl: options.authority({ principal, draft, proof, controlReceiptId }) };
          },
        });
        await supervisor.reconcileNetwork(before.row.proposal_id, before.row.expected_epoch);
        receipt = loadNetworkRecoverySource(principal, original.changeId).receipt;
      }
      const settledReceipt = receipt ?? fail('network_receipt_unavailable');
      const current = loadNetworkRecoverySource(principal, original.changeId);
      const projectionEpoch = current.row.current_epoch;
      let verified = false;
      let issue = 'network_' + settledReceipt.state;
      const settled = settledReceipt.state === 'repaired';
      if (settled && settledReceipt.epoch === projectionEpoch) {
        if (before.status === 'projection_available') {
          assertCurrentReadbackAuthority();
          const signal = AbortSignal.timeout(Math.min(15_000, policy.limits.deadline_ms));
          const repair = policy.repairs.find(({ id }) => id === current.row.repair_id)!;
          try {
            const first = await readUntilAbort(signal, () => options.actuator.readRule(repair, signal));
            const readings = await readUntilAbort(signal, () => options.observe({ deviceId, targetIds: policy.targets.map(({ id }) => id), signal }));
            const last = await readUntilAbort(signal, () => options.actuator.readRule(repair, signal));
            verified = !signal.aborted && first === current.row.changed_rule && last === first &&
              readings.length === policy.targets.length && policy.targets.every(({ id }) =>
                readings.filter(({ targetId, problem }) => targetId === id && problem === 'healthy').length === 1);
          } catch { verified = false; }
        } else verified = true;
        issue = verified ? '' : 'network_recheck';
      } else if (settled) issue = 'network_superseded';
      const resultReceiptBytes = current.row.receipt_json;
      const immutableDigest = before.immutableDigest;
      return { state: settled ? 'settled' : 'unresolved', applied: networkReceiptToApplied(settledReceipt),
        checked: { verified, ...(issue ? { issue } : {}) }, checkedAt: now().toISOString(),
        assertProjectionCurrent() {
          const live = loadNetworkRecoverySource(principal, original.changeId);
          if (live.immutableDigest !== immutableDigest || live.row.current_epoch !== projectionEpoch ||
              live.row.current_epoch !== proof.base_revision || live.row.receipt_json !== resultReceiptBytes ||
              (settled && projectionEpoch === settledReceipt.epoch && live.row.lock_token !== null)) fail('network_projection_changed');
        } };
    },
  };
}

function readUntilAbort<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('NETWORK_READBACK_DEADLINE'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return read(); }).then((result) => {
      signal.removeEventListener('abort', abort);
      resolve(result);
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

export function registeredNetworkTargets(db: SqliteDatabase, configuration: NetworkRepairConfiguration | undefined,
  principal: Principal, domain: string) {
  if (!configuration || principal.account_id !== configuration.accountId || domain !== configuration.domain) return [];
  const row = db.prepare('SELECT epoch FROM network_device_state WHERE device_id=?')
    .get(configuration.localDeviceId) as { epoch: number } | undefined;
  return configuration.policy.repairs.map(({ id, target }) => ({ target: configuration.localDeviceId,
    device: configuration.localDeviceId, status: 'registered', revision: row?.epoch ?? 0,
    label: `${target} / ${id}`, input: { target_id: target, repair_id: id } }));
}
import { createHash } from 'node:crypto';
import { canonicalPayload, type Json } from '@patrick/contracts';

const connectivityTarget = 'connectivity';
type ConnectivityRow = {
  verified_intranet: string; verified_public: string; verified_revision: number;
  pending_intranet: string | null; pending_public: string | null; pending_revision: number | null;
};

function connectivityHosts(input: Json): { intranet: string; public: string } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, 'intranet_host') || !Object.hasOwn(record, 'public_host')) return null;
  try {
    return { intranet: parseConnectivityHostname(record.intranet_host), public: parseConnectivityHostname(record.public_host) };
  } catch { return null; }
}

function connectivityRow(db: SqliteDatabase, accountId: string, domain: string): ConnectivityRow | undefined {
  return db.prepare(`SELECT verified_intranet, verified_public, verified_revision, pending_intranet, pending_public, pending_revision
    FROM connectivity_probe_targets WHERE account_id=? AND data_domain=?`).get(accountId, domain) as ConnectivityRow | undefined;
}

export function verifiedConnectivityHosts(db: SqliteDatabase, accountId: string, domain: string): { intranet: string; public: string } {
  const row = connectivityRow(db, accountId, domain);
  return connectivityProbeHosts(row ? { intranet: row.verified_intranet, public: row.verified_public } : null);
}

export function connectivitySettingsHandler(options: {
  db: SqliteDatabase; now: () => Date; deviceId: string; authorize: SettingsHandler['authorize'];
}): SettingsHandler {
  const { db, deviceId, authorize } = options;
  return {
    binding(principal, draft) {
      if (draft.operation !== 'set_connectivity_targets' || draft.target !== connectivityTarget) {
        throw new ApiError(422, 'UNPROCESSABLE', { reason: 'settings_input' });
      }
      const current = connectivityRow(db, principal.account_id, draft.domain);
      const hosts = verifiedConnectivityHosts(db, principal.account_id, draft.domain);
      return {
        revision: current?.verified_revision ?? 0, deviceId, identityId: deviceId,
        scopeHash: createHash('sha256').update(canonicalPayload([hosts.intranet, hosts.public, current?.verified_revision ?? 0])).digest('hex'),
      };
    },
    async validate(_principal, draft) {
      return { valid: draft.target === connectivityTarget && connectivityHosts(draft.input) !== null };
    },
    authorize,
    async apply(principal, draft, proof, beforeWrite) {
      const hosts = connectivityHosts(draft.input);
      if (!hosts || draft.target !== connectivityTarget) throw new SettingsApplyBlocked('connectivity_host');
      beforeWrite();
      const current = connectivityRow(db, principal.account_id, draft.domain);
      const base = current?.verified_revision ?? 0;
      if (base !== proof.base_revision) throw new SettingsApplyBlocked('confirmation_changed');
      const pending = base + 1;
      const verified = verifiedConnectivityHosts(db, principal.account_id, draft.domain);
      db.prepare(`INSERT INTO connectivity_probe_targets
        (account_id, data_domain, verified_intranet, verified_public, verified_revision, pending_intranet, pending_public, pending_revision)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(account_id, data_domain) DO UPDATE SET
          pending_intranet=excluded.pending_intranet, pending_public=excluded.pending_public, pending_revision=excluded.pending_revision
        WHERE connectivity_probe_targets.verified_revision=?`).run(
        principal.account_id, draft.domain, verified.intranet, verified.public, base, hosts.intranet, hosts.public, pending, base);
      const stored = connectivityRow(db, principal.account_id, draft.domain);
      if (stored?.pending_intranet !== hosts.intranet || stored.pending_public !== hosts.public || stored.pending_revision !== pending) {
        throw new SettingsApplyBlocked('confirmation_changed');
      }
      return { revision: pending, effects: [{ item: 'connectivity_targets', outcome: 'applied', revision: pending }] };
    },
    async recheck(principal, draft, applied) {
      const hosts = connectivityHosts(draft.input);
      const current = connectivityRow(db, principal.account_id, draft.domain);
      if (!hosts || !current || current.pending_intranet !== hosts.intranet || current.pending_public !== hosts.public ||
          current.pending_revision !== applied.revision || current.verified_revision + 1 !== applied.revision) {
        return { verified: false, issue: 'connectivity_recheck' };
      }
      const updated = db.prepare(`UPDATE connectivity_probe_targets
        SET verified_intranet=pending_intranet, verified_public=pending_public, verified_revision=pending_revision,
            pending_intranet=NULL, pending_public=NULL, pending_revision=NULL
        WHERE account_id=? AND data_domain=? AND pending_revision=? AND verified_revision=?`).run(
        principal.account_id, draft.domain, applied.revision, current.verified_revision);
      return updated.changes === 1 ? { verified: true } : { verified: false, issue: 'connectivity_recheck' };
    },
  };
}
