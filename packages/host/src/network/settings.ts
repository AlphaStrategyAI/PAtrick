import type { Json } from '@patrick/contracts';
import type { SqliteDatabase } from '@patrick/storage';
import { createNetworkSupervisor, networkRepairPolicyDigest, type NetworkSupervisorOptions, type RepairReceipt } from './supervisor.js';
import { parseNetworkPolicy, selectFixedRepair, type NetworkPolicy } from './vpn.js';

type Principal = { account_id: string; caller_id: string; auth_epoch: number; authenticated_at: string; domains: string[]; operations: string[] };
type Draft = { operation: string; domain: string; target: string; input: Json };
type Proof = { validation_id: string; draft_hash: string; base_revision: number; device_id: string;
  identity_id: string; scope_hash: string; valid: boolean; checked_at: string; expires_at: string };
type ControlInput = { principal: Principal; draft: Draft; proof: Proof; controlReceiptId: string };
type Authority = (input: ControlInput) => { proposalId: string; confirmationId: string; expiresAt: number };
type Effect = { item: string; outcome: 'applied' | 'unchanged' | 'blocked' | 'uncertain'; revision: number | null };
type Applied = { revision: number | null; effects: readonly Effect[] };

export function networkReceiptToApplied(receipt: RepairReceipt): Applied {
  const outcome = receipt.state === 'repaired' ? 'applied'
    : receipt.state === 'already_healthy' ? 'unchanged' : receipt.state === 'unresolved' ? 'uncertain' : 'blocked';
  const effects: Effect[] = [{ item: 'network:' + receipt.state, outcome, revision: receipt.epoch }];
  effects.push({ item: 'network:operation:' + receipt.proposalId, outcome: 'unchanged', revision: receipt.epoch });
  for (const [phase, readings] of [['verify', receipt.verification], ['rollback', receipt.rollbackVerification]] as const) {
    for (const reading of readings ?? []) effects.push({ item: `network:${phase}:${reading.targetId}:${reading.problem}`,
      outcome: reading.problem === 'healthy' ? 'unchanged' : 'blocked', revision: receipt.epoch });
  }
  if (receipt.questionId) effects.push({ item: 'network:question:' + receipt.questionId, outcome: 'blocked', revision: receipt.epoch });
  if (receipt.retryAt) effects.push({ item: 'network:retry_at:' + receipt.retryAt, outcome: 'blocked', revision: receipt.epoch });
  return { revision: receipt.epoch, effects };
}

export function createNetworkControlAuthority(options: {
  db: SqliteDatabase; now: () => Date; assertControl: (input: ControlInput) => void; reject: (reason: string) => never;
}): Authority {
  return (input) => {
    options.assertControl(input);
    const row = options.db.prepare(`SELECT r.proposal_id,p.expires_at FROM control_receipts r
      JOIN control_proposals p ON p.proposal_id=r.proposal_id AND p.account_id=r.account_id
      WHERE r.receipt_id=? AND r.account_id=? AND r.caller_id=? AND r.auth_epoch=? AND r.result='confirmed'
        AND p.confirmed_at IS NOT NULL AND p.expires_at>?`)
      .get(input.controlReceiptId, input.principal.account_id, input.principal.caller_id,
        input.principal.auth_epoch, options.now().toISOString()) as { proposal_id: string; expires_at: string } | undefined;
    if (!row) return options.reject('control_receipt');
    return { proposalId: row.proposal_id, confirmationId: input.controlReceiptId, expiresAt: Date.parse(row.expires_at) };
  };
}

export function createNetworkSettingsHandler(options: {
  db: SqliteDatabase; policy: NetworkPolicy; localDeviceId: string; accountId: string; domain: string;
  now: () => Date; authority: Authority; reject: (reason: string) => never;
  observe: NetworkSupervisorOptions['observe']; actuator: NetworkSupervisorOptions['actuator'];
}) {
  const policy = parseNetworkPolicy(options.policy);
  if (options.localDeviceId !== policy.device_id) throw new Error('NETWORK_DEVICE_NOT_REGISTERED');
  const policyDigest = networkRepairPolicyDigest(policy, options.actuator);
  const currentEpoch = () => {
    const row = options.db.prepare('SELECT epoch FROM network_device_state WHERE device_id=?')
      .get(policy.device_id) as { epoch: number } | undefined;
    return row?.epoch ?? 0;
  };
  function request(principal: Principal, draft: Draft) {
    const input = draft.input;
    if (principal.account_id !== options.accountId || draft.domain !== options.domain ||
        draft.operation !== 'repair_network' || draft.target !== policy.device_id ||
        !input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).length !== 2 || typeof input.target_id !== 'string' || typeof input.repair_id !== 'string' ||
        !policy.repairs.some(({ id, target }) => id === input.repair_id && target === input.target_id)) {
      return options.reject('network_registration');
    }
    return { targetId: input.target_id, repairId: input.repair_id };
  }
  function storedControl(proof: Proof, principal: Principal, draft: Draft): string {
    const row = options.db.prepare(`SELECT control_receipt_id FROM settings_changes
      WHERE validation_id=? AND account_id=? AND caller_id=? AND data_domain=? AND operation=? AND target_id=?`)
      .get(proof.validation_id, principal.account_id, principal.caller_id, draft.domain,
        draft.operation, draft.target) as { control_receipt_id: string } | undefined;
    return row?.control_receipt_id ?? options.reject('settings_intent');
  }
  function storedReceipt(principal: Principal, draft: Draft, applied: Applied): RepairReceipt | undefined {
    const marker = applied.effects.find(({ item }) => item.startsWith('network:operation:'));
    if (!marker) return;
    const proposalId = marker.item.slice('network:operation:'.length);
    const row = options.db.prepare(`SELECT n.receipt_json FROM network_repair_operations n
      JOIN settings_changes s ON s.control_receipt_id=n.confirmation_id
      WHERE n.device_id=? AND s.account_id=? AND s.caller_id=? AND s.data_domain=?
        AND s.operation=? AND s.target_id=? AND n.proposal_id=? AND json_extract(n.receipt_json,'$.epoch') IS ?`)
      .get(policy.device_id, principal.account_id, principal.caller_id,
        draft.domain, draft.operation, draft.target, proposalId, applied.revision) as { receipt_json: string } | undefined;
    return row ? JSON.parse(row.receipt_json) as RepairReceipt : undefined;
  }
  return {
    binding(principal: Principal, draft: Draft) {
      request(principal, draft);
      return { revision: currentEpoch(), deviceId: policy.device_id, identityId: policy.device_id, scopeHash: policyDigest };
    },
    async validate(principal: Principal, draft: Draft) {
      const selected = request(principal, draft);
      const readings = await options.observe({ deviceId: policy.device_id,
        targetIds: policy.targets.map(({ id }) => id), signal: AbortSignal.timeout(policy.limits.deadline_ms) });
      const target = readings.find(({ targetId }) => targetId === selected.targetId);
      const peers = policy.targets.filter(({ role }) => role === 'peer');
      return { valid: Boolean(target && (target.problem === 'healthy' || selectFixedRepair(policy, {
        deviceId: policy.device_id, ...selected, problem: target.problem,
      })) && peers.every(({ id }) => readings.find(({ targetId }) => targetId === id)?.problem === 'healthy')) };
    },
    authorize(principal: Principal, draft: Draft, proof: Proof, controlReceiptId: string) {
      request(principal, draft);
      options.authority({ principal, draft, proof, controlReceiptId });
    },
    async apply(principal: Principal, draft: Draft, proof: Proof, beforeWrite: () => string,
      revalidateAuthorization: () => string = beforeWrite): Promise<Applied> {
      const selected = request(principal, draft);
      const controlReceiptId = storedControl(proof, principal, draft);
      beforeWrite();
      const approved = options.authority({ principal, draft, proof, controlReceiptId });
      const supervisor = createNetworkSupervisor(options.db, {
        policy, observe: options.observe, actuator: options.actuator, now: () => options.now().getTime(),
        confirmation(proposalId) {
          revalidateAuthorization();
          const live = options.authority({ principal, draft, proof, controlReceiptId });
          if (live.proposalId !== proposalId || live.confirmationId !== approved.confirmationId) return null;
          return { ...live, deviceId: policy.device_id, ...selected, policyDigest,
            expectedEpoch: proof.base_revision };
        },
      });
      const receipt = await supervisor.repairNetwork(approved.proposalId, proof.base_revision);
      return networkReceiptToApplied(receipt);
    },
    async recheck(principal: Principal, draft: Draft, applied: Applied) {
      request(principal, draft);
      const receipt = storedReceipt(principal, draft, applied);
      if (!receipt || currentEpoch() !== receipt.epoch || !['already_healthy', 'repaired'].includes(receipt.state)) {
        return { verified: false, issue: 'network_' + (receipt?.state ?? 'receipt_unavailable') };
      }
      const targets = receipt.verification?.map(({ targetId }) => targetId) ?? policy.targets.map(({ id }) => id);
      const readings = await options.observe({ deviceId: policy.device_id, targetIds: targets,
        signal: AbortSignal.timeout(policy.limits.deadline_ms) });
      const verified = readings.length === targets.length &&
        targets.every((id) => readings.filter(({ targetId, problem }) => targetId === id && problem === 'healthy').length === 1);
      return { verified, ...(!verified ? { issue: 'network_recheck' } : {}) };
    },
  };
}
