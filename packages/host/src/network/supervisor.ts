import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { SqliteDatabase } from '@patrick/storage';
import { mayRevert, parseNetworkPolicy, repairVerificationTargets, selectFixedRepair } from './vpn.js';
import type { FixedRepair, NetworkOwner, NetworkPolicy } from './vpn.js';

const idPattern = /^[a-z0-9][a-z0-9_-]{0,159}$/u;
const maximumBackoffMs = 24 * 60 * 60_000;
const rulePattern = /^[a-f0-9]{64}$/u;
const problems = ['healthy', 'interface', 'route', 'dns', 'proxy', 'tcp', 'tls',
  'identity', 'rate_limit', 'target', 'peer', 'permission', 'mfa', 'unknown'] as const;

export type NetworkObservation = Readonly<{
  targetId: string; problem: (typeof problems)[number]; retryAfterMs?: number | null;
}>;

/** Only a trusted, current T03 confirmation lookup may construct this binding. */
export type ConfirmedNetworkRepair = Readonly<{
  proposalId: string; confirmationId: string; deviceId: string; targetId: string; repairId: string;
  policyDigest: string; expectedEpoch: number; expiresAt: number;
}>;
export type NetworkReadbackAuthority = Readonly<{
  source: Readonly<{ proposalId: string; confirmationId: string; deviceId: string; targetId: string; repairId: string;
    policyDigest: string; expectedEpoch: number; ownerEpoch: number }>;
  freshControl: Readonly<{ proposalId: string; confirmationId: string; expiresAt: number }>;
}>;

type RuleContext = Readonly<{ owner: NetworkOwner; expectedRule: string; signal: AbortSignal; assertEffect: () => void }>;
type ApplyResult =
  | Readonly<{ state: 'changed'; revision: string; reconnected?: true }>
  | Readonly<{ state: 'unchanged' | 'conflict' | 'unknown' | 'identity' | 'permission' | 'mfa' | 'rate_limit' }>;

export type FixedNetworkActuator = Readonly<{
  registrationDigest?: string;
  // The adapter retains the restorable local snapshot; only an opaque rule digest crosses this boundary.
  readRule: (repair: FixedRepair, signal: AbortSignal) => Promise<string | null | Readonly<{ state: 'permission' | 'incompatible' }>>;
  // Both mutations compare expectedRule against the actual setting before changing it. A nonchanging
  // result guarantees there was no effect. On abort, settle only after possible effects have stopped.
  apply: (repair: FixedRepair, context: RuleContext) => Promise<ApplyResult>;
  restore: (repair: FixedRepair, context: RuleContext & Readonly<{ priorRule: string }>) =>
    Promise<'restored' | 'conflict' | 'unknown'>;
}>;

type ReceiptState = 'not_confirmed' | 'busy' | 'in_progress' | 'stale_epoch' | 'superseded' |
  'unresolved' | 'not_applicable' | 'already_healthy' | 'needs_login' | 'mfa_required' | 'rate_limited' |
  'peer_unavailable' | 'needs_permission' | 'unavailable' | 'deadline' | 'repaired' | 'reverted' | 'not_repaired';
export type RepairReceipt = Readonly<{
  proposalId: string; deviceId: string; state: ReceiptState; epoch: number | null; attempts: number;
  verification?: readonly NetworkObservation[]; rollbackVerification?: readonly NetworkObservation[];
  questionId?: string; retryAt?: number;
}>;

export type NetworkSupervisorOptions = Readonly<{
  policy: NetworkPolicy;
  /** Rechecks current trusted control on the same ledger; never accepts caller-supplied approval facts. */
  confirmation: (proposalId: string) => ConfirmedNetworkRepair | null;
  reconciliationAuthority?: (originalProposalId: string, originalExpectedEpoch: number) => NetworkReadbackAuthority | null;
  observe: (input: Readonly<{ deviceId: string; targetIds: readonly string[]; signal: AbortSignal }>) =>
    Promise<readonly NetworkObservation[]>;
  actuator: FixedNetworkActuator;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}>;

type DeviceState = { epoch: number; owner_id: string | null; lock_token: string | null };
type OperationRow = { confirmation_id: string; target_id: string; repair_id: string; policy_digest: string;
  expected_epoch: number; attempts: number; receipt_json: string | null };
type Blocker = { retry_at: number | null; mfa_question_id: string | null };
type Run = { approval: ConfirmedNetworkRepair; token: string; owner: DeviceState; attempts: number };
type ReceiptDetails = Pick<RepairReceipt, 'verification' | 'rollbackVerification' | 'questionId' | 'retryAt'>;

export function networkPolicyDigest(policy: NetworkPolicy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}

export function networkRepairPolicyDigest(policy: NetworkPolicy, actuator: FixedNetworkActuator): string {
  const base = networkPolicyDigest(policy);
  if (actuator.registrationDigest === undefined) return base;
  if (!rulePattern.test(actuator.registrationDigest)) throw new Error('NETWORK_ACTUATOR_REGISTRATION_INVALID');
  return createHash('sha256').update(JSON.stringify([base, actuator.registrationDigest])).digest('hex');
}

export function createNetworkSupervisor(db: SqliteDatabase, options: NetworkSupervisorOptions) {
  const { actuator, observe } = options;
  const policy = parseNetworkPolicy(options.policy);
  const deviceId = policy.device_id;
  const policyDigest = networkRepairPolicyDigest(policy, actuator);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  const allTargets = Object.freeze(policy.targets.map(({ id }) => id));
  const peers = policy.targets.filter(({ role }) => role === 'peer').map(({ id }) => id);
  const terminalReceipt = (proposalId: string, state: ReceiptState, epoch: number | null = null,
    attempts = 0, details: ReceiptDetails = {}): RepairReceipt => ({ proposalId, deviceId, state, epoch, attempts, ...details });

  // Never inherit a caller transaction: a mutation can only start after its intent is durably committed.
  function write<T>(action: () => T): T {
    if (db.inTransaction) throw new Error('NETWORK_OUTER_TRANSACTION');
    return db.transaction(action).immediate();
  }
  function device(): DeviceState {
    return db.prepare('SELECT epoch, owner_id, lock_token FROM network_device_state WHERE device_id = ?')
      .get(deviceId) as DeviceState;
  }
  function owned(run: Pick<Run, 'token' | 'owner'>, current = device()): boolean {
    if (current.lock_token !== run.token) return false;
    if (run.owner.owner_id === null) return current.owner_id === null && current.epoch === run.owner.epoch;
    if (current.owner_id === null) return false;
    return mayRevert({ operationId: run.owner.owner_id, epoch: run.owner.epoch },
      { operationId: current.owner_id, epoch: current.epoch });
  }
  function readApproval(proposalId: string, expectedEpoch: number): ConfirmedNetworkRepair | null {
    try {
      const input = options.confirmation(proposalId);
      if (!input || input.proposalId !== proposalId || input.deviceId !== deviceId ||
        input.expectedEpoch !== expectedEpoch || input.policyDigest !== policyDigest ||
        typeof input.confirmationId !== 'string' || !idPattern.test(input.confirmationId) ||
        !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now() ||
        !policy.repairs.some((repair) => repair.id === input.repairId && repair.target === input.targetId)) return null;
      return { proposalId, confirmationId: input.confirmationId, deviceId, expectedEpoch, policyDigest,
        expiresAt: input.expiresAt, repairId: input.repairId, targetId: input.targetId };
    } catch {
      return null;
    }
  }
  function acquire(proposalId: string, expectedEpoch: number): Run | RepairReceipt {
    return write(() => {
      const approval = readApproval(proposalId, expectedEpoch);
      if (!approval) return terminalReceipt(proposalId, 'not_confirmed');
      db.prepare('INSERT INTO network_device_state (device_id) VALUES (?) ON CONFLICT DO NOTHING').run(deviceId);
      const current = device();
      const prior = db.prepare(`SELECT confirmation_id, target_id, repair_id, policy_digest, expected_epoch, attempts, receipt_json
        FROM network_repair_operations WHERE device_id = ? AND proposal_id = ?`).get(deviceId, proposalId) as OperationRow | undefined;
      if (prior) {
        if (prior.confirmation_id !== approval.confirmationId || prior.target_id !== approval.targetId ||
          prior.repair_id !== approval.repairId || prior.policy_digest !== approval.policyDigest ||
          prior.expected_epoch !== approval.expectedEpoch) return terminalReceipt(proposalId, 'not_confirmed');
        return prior.receipt_json ? JSON.parse(prior.receipt_json) as RepairReceipt
          : terminalReceipt(proposalId, 'in_progress', current.epoch, prior.attempts);
      }
      if (current.lock_token !== null) return terminalReceipt(proposalId, 'busy', current.epoch);
      if (expectedEpoch !== current.epoch) return terminalReceipt(proposalId, 'stale_epoch', current.epoch);
      const token = randomUUID();
      const inserted = db.prepare(`INSERT INTO network_repair_operations
        (device_id, proposal_id, confirmation_id, expected_epoch, target_id, repair_id, policy_digest, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(deviceId, proposalId, approval.confirmationId,
        expectedEpoch, approval.targetId, approval.repairId, policyDigest, now());
      if (inserted.changes !== 1) return terminalReceipt(proposalId, 'not_confirmed');
      const locked = db.prepare(`UPDATE network_device_state SET lock_token = ? WHERE device_id = ?
        AND lock_token IS NULL AND epoch = ?`).run(token, deviceId, expectedEpoch);
      if (locked.changes !== 1) throw new Error('NETWORK_OWNER_CHANGED');
      return { approval, token, owner: current, attempts: 0 };
    });
  }
  function advance(run: Run): NetworkOwner {
    const epoch = run.owner.epoch + 1;
    const operationId = run.approval.proposalId;
    const edit = db.prepare(`UPDATE network_device_state SET epoch = ?, owner_id = ?
      WHERE device_id = ? AND epoch = ? AND owner_id IS ? AND lock_token = ?`)
      .run(epoch, operationId, deviceId, run.owner.epoch, run.owner.owner_id, run.token);
    if (edit.changes !== 1) throw new Error('NETWORK_OWNER_CHANGED');
    return { operationId, epoch };
  }
  function reserveApply(run: Run, priorRule: string): { owner: NetworkOwner } | 'not_confirmed' | 'superseded' {
    return write(() => {
      if (!owned(run)) return 'superseded';
      const current = readApproval(run.approval.proposalId, run.approval.expectedEpoch);
      if (!current || current.confirmationId !== run.approval.confirmationId || current.repairId !== run.approval.repairId ||
        current.targetId !== run.approval.targetId || current.expiresAt !== run.approval.expiresAt) return 'not_confirmed';
      const owner = advance(run);
      const attempt = run.attempts + 1;
      db.prepare(`INSERT INTO network_repair_attempts (device_id, proposal_id, attempt, prior_epoch, apply_epoch, prior_rule)
        VALUES (?, ?, ?, ?, ?, ?)`).run(deviceId, owner.operationId, attempt, run.owner.epoch, owner.epoch, priorRule);
      db.prepare(`UPDATE network_repair_operations SET attempts = ?
        WHERE device_id = ? AND proposal_id = ?`).run(attempt, deviceId, owner.operationId);
      return { owner };
    });
  }
  function commitChange(run: Run, revision: string): boolean {
    return write(() => {
      if (!owned(run)) return false;
      db.prepare(`UPDATE network_repair_attempts SET changed_rule = ?
        WHERE device_id = ? AND proposal_id = ? AND attempt = ?`).run(revision, deviceId, run.approval.proposalId, run.attempts);
      return true;
    });
  }
  function reserveRestore(run: Run): NetworkOwner | null {
    return write(() => {
      if (!owned(run)) return null;
      const owner = advance(run);
      const edit = db.prepare(`UPDATE network_repair_attempts SET restore_epoch = ?
        WHERE device_id = ? AND proposal_id = ? AND attempt = ? AND apply_epoch = ?
        AND changed_rule IS NOT NULL AND restore_epoch IS NULL`)
        .run(owner.epoch, deviceId, owner.operationId, run.attempts, run.owner.epoch);
      if (edit.changes !== 1) throw new Error('NETWORK_RESTORE_NOT_OWNED');
      return owner;
    });
  }
  function readBlocker(target: string): Blocker | undefined {
    return db.prepare('SELECT retry_at, mfa_question_id FROM network_target_blockers WHERE device_id = ? AND target_id = ?')
      .get(deviceId, target) as Blocker | undefined;
  }
  function finish(run: Run, state: ReceiptState, details: ReceiptDetails = {}): RepairReceipt {
    return write(() => {
      const current = device();
      const target = run.approval.targetId;
      const same = owned(run, current);
      if (same && state === 'mfa_required') {
        const questionId = readBlocker(target)?.mfa_question_id ?? randomUUID();
        db.prepare(`INSERT INTO network_target_blockers (device_id, target_id, mfa_question_id) VALUES (?, ?, ?)
          ON CONFLICT (device_id, target_id) DO UPDATE SET mfa_question_id = excluded.mfa_question_id`)
          .run(deviceId, target, questionId);
        details = { ...details, questionId };
      }
      if (same && state === 'rate_limited') {
        const retryAt = details.retryAt ?? now() + policy.limits.cooldown_ms;
        db.prepare(`INSERT INTO network_target_blockers (device_id, target_id, retry_at) VALUES (?, ?, ?)
          ON CONFLICT (device_id, target_id) DO UPDATE SET retry_at = excluded.retry_at`).run(deviceId, target, retryAt);
        details = { ...details, retryAt };
      }
      if (same && (state === 'already_healthy' || state === 'repaired')) {
        db.prepare('DELETE FROM network_target_blockers WHERE device_id = ? AND target_id = ?').run(deviceId, target);
      }
      const receipt = terminalReceipt(run.approval.proposalId, same ? state : 'superseded', current.epoch, run.attempts, details);
      db.prepare(`UPDATE network_repair_operations SET receipt_json = ?
        WHERE device_id = ? AND proposal_id = ? AND receipt_json IS NULL`)
        .run(JSON.stringify(receipt), deviceId, run.approval.proposalId);
      if (same && state !== 'unresolved') {
        db.prepare(`UPDATE network_device_state SET lock_token = NULL
          WHERE device_id = ? AND lock_token = ? AND epoch = ? AND owner_id IS ?`)
          .run(deviceId, run.token, current.epoch, current.owner_id);
      }
      return receipt;
    });
  }

  async function repairNetwork(proposalId: string, expectedEpoch: number): Promise<RepairReceipt> {
    if (typeof proposalId !== 'string' || !idPattern.test(proposalId) ||
      !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0) return terminalReceipt('', 'not_confirmed');
    const startedAt = now();
    const run = acquire(proposalId, expectedEpoch);
    if ('state' in run) return run;
    const limit = policy.limits;
    const target = run.approval.targetId;
    const deadline = startedAt + limit.deadline_ms;
    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(), Math.max(0, deadline - now()));
    const signal = controller.signal;
    const expired = () => signal.aborted || now() >= deadline;
    let unsettledEffect = false;
    let details: ReceiptDetails = {};
    const finalize = (state: ReceiptState) => finish(run, state, details);
    const targetBackoff = () => {
      const retryAt = readBlocker(target)?.retry_at;
      if (retryAt !== undefined && retryAt !== null && retryAt > now()) {
        details = { retryAt };
        return finalize('rate_limited');
      }
      return null;
    };
    async function inspect(targetIds: readonly string[]): Promise<readonly NetworkObservation[]> {
      if (expired()) throw new Error('NETWORK_DEADLINE');
      const result = await untilAbort(signal, () => observe({ deviceId, targetIds, signal }));
      if (expired()) throw new Error('NETWORK_DEADLINE');
      if (result.length !== targetIds.length) throw new Error('NETWORK_OBSERVATION_INCOMPLETE');
      return targetIds.map((targetId) => {
        const items = result.filter((entry) => entry.targetId === targetId);
        if (items.length !== 1 || !problems.includes(items[0].problem)) throw new Error('NETWORK_OBSERVATION_INCOMPLETE');
        const { problem, retryAfterMs } = items[0];
        return problem === 'rate_limit' && typeof retryAfterMs === 'number' && Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0
          ? { targetId, problem, retryAfterMs: Math.min(retryAfterMs, maximumBackoffMs) } : { targetId, problem };
      });
    }

    const noteRateLimit = (reading: NetworkObservation) => {
      if (reading.problem === 'rate_limit') {
        details = { ...details, retryAt: now() + Math.max(limit.cooldown_ms, reading.retryAfterMs ?? 0) };
      }
    };
    const rule = (repair: FixedRepair) => untilAbort(signal, () => actuator.readRule(repair, signal));
    const assertEffect = () => {
      if (expired() || !owned(run)) throw new Error('NETWORK_EFFECT_NOT_OWNED');
      const live = readApproval(run.approval.proposalId, run.approval.expectedEpoch);
      if (!live || live.confirmationId !== run.approval.confirmationId || live.expiresAt !== run.approval.expiresAt) {
        throw new Error('NETWORK_EFFECT_NOT_CONFIRMED');
      }
    };

    try {
      const backoff = targetBackoff();
      if (backoff) return backoff;
      let last: ReceiptState = 'not_repaired';
      for (let attempt = 1; attempt <= limit.maximum_attempts; attempt += 1) {
        const baseline = await inspect(allTargets);
        details = { verification: baseline };
        const reading = baseline.find(({ targetId }) => targetId === target)!;
        const baselineProblem = reading.problem;
        const known = guidance(baselineProblem);
        if (known) {
          noteRateLimit(reading);
          return finalize(known);
        }
        if (readBlocker(target)?.mfa_question_id) return finalize('mfa_required');
        if (!peers.every((peer) => baseline.find(({ targetId }) => targetId === peer)?.problem === 'healthy')) {
          return finalize('peer_unavailable');
        }
        const repair = selectFixedRepair(policy, { deviceId, targetId: target, repairId: run.approval.repairId, problem: baselineProblem });
        if (!repair) return finalize('not_applicable');
        if (!owned(run)) return finalize('superseded');
        const targets = Object.freeze(repairVerificationTargets(policy, target,
          baseline.filter(({ problem }) => problem === 'healthy').map(({ targetId }) => targetId)));
        const priorRule = await rule(repair);
        if (expired()) return finalize('deadline');
        if (priorRule && typeof priorRule === 'object' && priorRule.state === 'permission') return finalize('needs_permission');
        if (typeof priorRule !== 'string' || !rulePattern.test(priorRule)) return finalize('unavailable');
        const reservation = reserveApply(run, priorRule);
        if (typeof reservation === 'string') return finalize(reservation);
        run.owner = { owner_id: reservation.owner.operationId, epoch: reservation.owner.epoch, lock_token: run.token };
        run.attempts += 1;
        if (expired()) return finalize('deadline');
        unsettledEffect = true;
        const result = await untilAbort(signal, () => actuator.apply(repair, { owner: reservation.owner, expectedRule: priorRule, signal, assertEffect }));
        if (!owned(run)) return finalize('superseded');
        if (result.state === 'changed') {
          if (typeof result.revision !== 'string' || !rulePattern.test(result.revision) ||
            (result.revision === priorRule && !(repair.kind === 'reconnect_vpn' && result.reconnected === true))) return finalize('unresolved');
          if (!commitChange(run, result.revision)) return finalize('superseded');
          details = {};
          let verification: readonly NetworkObservation[];
          try { verification = await inspect(targets); } catch { verification = []; }
          details = { verification };
          if (!owned(run)) return finalize('superseded');
          if (expired() || await rule(repair) !== result.revision || expired()) return finalize('unresolved');
          if (verification.length > 0 && verification.every(({ problem }) => problem === 'healthy')) return finalize('repaired');

          const restoreOwner = reserveRestore(run);
          if (!restoreOwner) return finalize('superseded');
          run.owner = { owner_id: restoreOwner.operationId, epoch: restoreOwner.epoch, lock_token: run.token };
          if (expired()) return finalize('unresolved');
          const undone = await untilAbort(signal, () =>
            actuator.restore(repair, { owner: restoreOwner, expectedRule: result.revision, priorRule, signal, assertEffect }));
          if (undone !== 'restored') return finalize('unresolved');
          const rollbackVerification = await inspect(targets);
          details = { verification, rollbackVerification };
          if (rollbackVerification.slice(1).some(({ problem }) => problem !== 'healthy') ||
            expired() || await rule(repair) !== priorRule || expired()) return finalize('unresolved');
          unsettledEffect = false;
          const currentProblem = verification[0]?.problem;
          const hint = currentProblem ? guidance(currentProblem) : undefined;
          if (hint && hint !== 'already_healthy') {
            noteRateLimit(verification[0]);
            return finalize(hint);
          }
          if (verification.length === 0 || verification.slice(1).some(({ problem }) => problem !== 'healthy') ||
            currentProblem !== baselineProblem) return finalize('reverted');
          last = 'reverted';
        } else {
          if (!['unchanged', 'conflict', 'identity', 'permission', 'mfa', 'rate_limit'].includes(result.state)) return finalize('unresolved');
          unsettledEffect = false;
          const hint = result.state === 'unchanged' || result.state === 'conflict' ? undefined : guidance(result.state);
          if (hint) return finalize(hint);
          if (result.state === 'conflict') return finalize('not_repaired');
        }
        if (attempt >= limit.maximum_attempts) return finalize(last);
        if (expired() || now() + limit.cooldown_ms >= deadline) return finalize('deadline');
        await untilAbort(signal, () => sleep(limit.cooldown_ms, signal));
      }
      return finalize(last);
    } catch {
      return finalize(unsettledEffect ? 'unresolved' : expired() ? 'deadline' : 'unavailable');
    } finally {
      clearTimeout(watchdog);
    }
  }

  function currentEpoch(): number {
    const row = db.prepare('SELECT epoch FROM network_device_state WHERE device_id = ?').get(deviceId) as { epoch: number } | undefined;
    return row?.epoch ?? 0;
  }

  /** Readback only: an applied result must already be durably settled, with no restore in flight.
   * The trusted confirmation callback must recheck the current session and owner each time.
   * An expired approval, unacknowledged effect, restore intent or foreign rule never releases a lock. */
  async function reconcileNetwork(proposalId: string, expectedEpoch: number): Promise<RepairReceipt> {
    if (!idPattern.test(proposalId) || !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0) {
      return terminalReceipt('', 'not_confirmed');
    }
    const readAuthority = (): NetworkReadbackAuthority | null => {
      try {
        let authority: NetworkReadbackAuthority | null;
        if (options.reconciliationAuthority) authority = options.reconciliationAuthority(proposalId, expectedEpoch);
        else {
          const approval = readApproval(proposalId, expectedEpoch);
          authority = approval ? { source: { ...approval, ownerEpoch: device().epoch },
            freshControl: { proposalId: approval.proposalId, confirmationId: approval.confirmationId, expiresAt: approval.expiresAt } } : null;
        }
        const source = authority?.source;
        const control = authority?.freshControl;
        if (!source || !control || source.proposalId !== proposalId || source.deviceId !== deviceId ||
            source.expectedEpoch !== expectedEpoch || source.policyDigest !== policyDigest ||
            !idPattern.test(source.confirmationId) || !idPattern.test(control.proposalId) || !idPattern.test(control.confirmationId) ||
            !Number.isSafeInteger(source.ownerEpoch) || !Number.isSafeInteger(control.expiresAt) || control.expiresAt <= now() ||
            !policy.repairs.some(({ id, target }) => id === source.repairId && target === source.targetId)) return null;
        return authority;
      } catch { return null; }
    };
    const prepared = write(() => {
      const authority = readAuthority();
      if (!authority) return terminalReceipt(proposalId, 'not_confirmed');
      const { source } = authority;
      const operation = db.prepare('SELECT * FROM network_repair_operations WHERE device_id=? AND proposal_id=?')
        .get(deviceId, proposalId) as OperationRow | undefined;
      if (!operation || operation.confirmation_id !== source.confirmationId || operation.expected_epoch !== expectedEpoch ||
          operation.policy_digest !== policyDigest || operation.target_id !== source.targetId ||
          operation.repair_id !== source.repairId) return terminalReceipt(proposalId, 'not_confirmed');
      const current = device();
      const existing = operation.receipt_json ? JSON.parse(operation.receipt_json) as RepairReceipt
        : terminalReceipt(proposalId, 'in_progress', current.epoch, operation.attempts);
      if (current.owner_id !== proposalId || current.epoch !== source.ownerEpoch || !current.lock_token ||
          !['unresolved', 'in_progress'].includes(existing.state)) return existing;
      const attempt = db.prepare(`SELECT apply_epoch,changed_rule,restore_epoch FROM network_repair_attempts
        WHERE device_id=? AND proposal_id=? AND attempt=?`).get(deviceId, proposalId, operation.attempts) as
        { apply_epoch: number; changed_rule: string | null; restore_epoch: number | null } | undefined;
      if (!attempt?.changed_rule || !rulePattern.test(attempt.changed_rule) ||
          attempt.restore_epoch !== null || attempt.apply_epoch !== current.epoch) return existing;
      return { run: { token: current.lock_token, owner: current, attempts: operation.attempts },
        authority, changedRule: attempt.changed_rule, previous: operation.receipt_json, existing };
    });
    if ('state' in prepared) return prepared;
    const { run, changedRule, existing } = prepared;
    const repair = policy.repairs.find(({ id }) => id === prepared.authority.source.repairId)!;
    const signal = AbortSignal.timeout(Math.min(15_000, policy.limits.deadline_ms));
    try {
      if (await untilAbort(signal, () => actuator.readRule(repair, signal)) !== changedRule) return existing;
      const verification = await untilAbort(signal, () => observe({ deviceId, targetIds: allTargets, signal }));
      if (verification.length !== allTargets.length ||
          !allTargets.every((targetId) => verification.filter((entry) => entry.targetId === targetId && entry.problem === 'healthy').length === 1) ||
          await untilAbort(signal, () => actuator.readRule(repair, signal)) !== changedRule) return existing;
      return write(() => {
        const authority = readAuthority();
        if (!authority || JSON.stringify(authority) !== JSON.stringify(prepared.authority)) return terminalReceipt(proposalId, 'not_confirmed');
        if (signal.aborted || !owned(run)) return terminalReceipt(proposalId, 'superseded', device().epoch, run.attempts);
        const receipt = terminalReceipt(proposalId, 'repaired', run.owner.epoch, run.attempts, { verification });
        const updated = db.prepare(`UPDATE network_repair_operations SET receipt_json=?
          WHERE device_id=? AND proposal_id=? AND receipt_json IS ?`)
          .run(JSON.stringify(receipt), deviceId, proposalId, prepared.previous);
        if (updated.changes !== 1) return terminalReceipt(proposalId, 'superseded', run.owner.epoch, run.attempts);
        db.prepare(`UPDATE network_device_state SET lock_token=NULL WHERE device_id=? AND owner_id=? AND epoch=? AND lock_token=?`)
          .run(deviceId, proposalId, run.owner.epoch, run.token);
        db.prepare('DELETE FROM network_target_blockers WHERE device_id=? AND target_id=?').run(deviceId, prepared.authority.source.targetId);
        return receipt;
      });
    } catch { return existing; }
  }

  return { currentEpoch, repairNetwork, reconcileNetwork };
}

function guidance(problem: NetworkObservation['problem']): ReceiptState | undefined {
  switch (problem) {
    case 'healthy': return 'already_healthy';
    case 'identity': return 'needs_login';
    case 'mfa': return 'mfa_required';
    case 'permission': return 'needs_permission';
    case 'rate_limit': return 'rate_limited';
    default: return undefined;
  }
}

// Deadline expiry always settles the caller. If a mutation may still be running, its
// durable lock remains held and no other operation can assume control of that setting.
function untilAbort<T>(signal: AbortSignal, callback: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('NETWORK_DEADLINE')); return; }
    const abort = () => reject(new Error('NETWORK_DEADLINE'));
    signal.addEventListener('abort', abort, { once: true });
    const failed = (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); };
    try {
      // Enter the adapter immediately after the ownership reservation, without an intervening await.
      callback().then((result) => { signal.removeEventListener('abort', abort); resolve(result); }, failed);
    } catch (error) {
      failed(error);
    }
  });
}
