import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { openDatabase, type MigrationEntry } from '@patrick/storage';
import { parseNetworkPolicy } from '../../packages/host/src/network/vpn.js';
import {
  createNetworkSupervisor, networkPolicyDigest, type ConfirmedNetworkRepair, type FixedNetworkActuator,
  type NetworkObservation,
} from '../../packages/host/src/network/supervisor.js';

const original = 'a'.repeat(64);
const changed = 'b'.repeat(64);
const baseTime = Date.parse('2026-11-17T07:00:00.000Z');
const policy = parseNetworkPolicy({
  schema_version: '1.0', device_id: 'fixture-mac', revision: 9,
  targets: [{ id: 'hub', role: 'hub' }, { id: 'gitlab', role: 'target' },
    { id: 'github', role: 'target' }, { id: 'writer-peer', role: 'peer' }],
  vpn_paths: [{ id: 'corporate', client: 'openvpn', targets: ['gitlab'] }],
  repairs: [
    { id: 'corporate-dns', kind: 'refresh_dns', target: 'gitlab' },
    { id: 'personal-proxy', kind: 'refresh_proxy', target: 'github' },
    { id: 'corporate-route', kind: 'reconnect_vpn', target: 'gitlab', path: 'corporate' },
  ],
  limits: { maximum_attempts: 2, cooldown_ms: 5_000, deadline_ms: 20_000 },
  fallback: 'none',
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t21-supervisor-'));
  const path = join(root, 'ledger.sqlite');
  const migrations = new URL('../../packages/storage/migrations/', import.meta.url);
  const files = JSON.parse(readFileSync(new URL('manifest.json', migrations), 'utf8')) as MigrationEntry[];
  const file = '0022_network.sql';
  const manifest = files.some((entry) => entry.file === file) ? files : [
    ...files, { file, sha256: createHash('sha256').update(readFileSync(new URL(file, migrations))).digest('hex') },
  ];
  const db = openDatabase(path, { manifest });
  const second = openDatabase(path, { manifest });
  let now = baseTime;
  let revision = original;
  const statuses = new Map<string, NetworkObservation['problem']>(
    [['hub', 'healthy'], ['gitlab', 'dns'], ['github', 'healthy'], ['writer-peer', 'healthy']]);
  const retryAfter = new Map<string, number>();
  const confirmations = new Map<string, ConfirmedNetworkRepair>();
  const approve = (proposalId: string, changes: Partial<ConfirmedNetworkRepair> = {}) => {
    confirmations.set(proposalId, {
      proposalId, confirmationId: `receipt-${proposalId}`, deviceId: policy.device_id,
      targetId: 'gitlab', repairId: 'corporate-dns', policyDigest: networkPolicyDigest(policy),
      expectedEpoch: 0, expiresAt: baseTime + 60_000, ...changes,
    });
  };
  const observe = vi.fn(async ({ targetIds }: { targetIds: readonly string[] }): Promise<readonly NetworkObservation[]> =>
    targetIds.map((targetId) => ({ targetId, problem: statuses.get(targetId) ?? 'unknown',
      ...(retryAfter.has(targetId) ? { retryAfterMs: retryAfter.get(targetId) } : {}),
    })));
  const readRule = vi.fn<FixedNetworkActuator['readRule']>().mockImplementation(async () => revision);
  const apply = vi.fn<FixedNetworkActuator['apply']>().mockImplementation(async () => {
    revision = changed;
    statuses.set('gitlab', 'healthy');
    return { state: 'changed', revision };
  });
  const restore = vi.fn<FixedNetworkActuator['restore']>().mockImplementation(async (_, { expectedRule, priorRule }) => {
    if (expectedRule !== revision) return 'conflict';
    revision = priorRule;
    statuses.set('gitlab', 'dns');
    statuses.set('github', 'healthy');
    statuses.set('writer-peer', 'healthy');
    return 'restored';
  });
  const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });
  const options = { policy, confirmation: (proposalId: string) => confirmations.get(proposalId) ?? null,
    observe, actuator: { readRule, apply, restore }, now: () => now, sleep };
  return { db, second, approve, confirmations, statuses, retryAfter, observe, readRule, apply, restore, sleep,
    open: (connection = db) => createNetworkSupervisor(connection, options),
    advance: (milliseconds: number) => { now += milliseconds; }, changed: () => revision, replaceRule: (next: string) => { revision = next; },
    dispose: () => { second.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('a confirmed VPN reconnect may preserve its connected-state digest while still requiring target and peer readback', async () => {
  const f = fixture();
  try {
    f.statuses.set('gitlab', 'route');
    f.approve('vpn-cycle', { repairId: 'corporate-route' });
    f.apply.mockImplementation(async () => {
      f.statuses.set('gitlab', 'healthy');
      return { state: 'changed', revision: original, reconnected: true };
    });
    expect(await f.open().repairNetwork('vpn-cycle', 0)).toMatchObject({
      state: 'repaired', attempts: 1, verification: expect.arrayContaining([
        { targetId: 'gitlab', problem: 'healthy' }, { targetId: 'writer-peer', problem: 'healthy' },
      ]),
    });
  } finally { f.dispose(); }
});

test('a reopened supervisor reconciles a settled applied intent only with current authorization and exact ownership', async () => {
  const f = fixture();
  try {
    f.approve('crashed');
    const healthy = f.observe.getMockImplementation()!;
    let first = true;
    f.observe.mockImplementation(async (input) => {
      if (first) { first = false; return healthy(input); }
      f.advance(policy.limits.deadline_ms);
      return healthy(input);
    });
    expect(await f.open().repairNetwork('crashed', 0)).toMatchObject({ state: 'unresolved', epoch: 1 });
    f.advance(-policy.limits.deadline_ms);
    f.observe.mockImplementation(healthy);
    const reopened = f.open(f.second);
    f.confirmations.delete('crashed');
    expect(await reopened.reconcileNetwork('crashed', 0)).toMatchObject({ state: 'not_confirmed' });
    expect(f.second.prepare('SELECT lock_token FROM network_device_state').get()).toMatchObject({ lock_token: expect.any(String) });
    f.approve('crashed');
    f.replaceRule('f'.repeat(64));
    expect(await reopened.reconcileNetwork('crashed', 0)).toMatchObject({ state: 'unresolved' });
    f.replaceRule(changed);
    f.observe.mockImplementation(async (input) => { f.confirmations.delete('crashed'); return healthy(input); });
    expect(await reopened.reconcileNetwork('crashed', 0)).toMatchObject({ state: 'not_confirmed' });
    f.approve('crashed');
    f.observe.mockImplementation(healthy);
    const receipt = await reopened.reconcileNetwork('crashed', 0);
    expect(receipt).toMatchObject({ state: 'repaired', epoch: 1, attempts: 1,
      verification: expect.arrayContaining([{ targetId: 'writer-peer', problem: 'healthy' }]) });
    expect(f.second.prepare('SELECT lock_token FROM network_device_state').get()).toEqual({ lock_token: null });
    expect(await reopened.repairNetwork('crashed', 0)).toEqual(receipt);
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.restore).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});

test('reconciliation keeps unknown effects and foreign rules locked without retrying a mutation', async () => {
  const f = fixture();
  try {
    f.approve('unknown');
    f.apply.mockResolvedValue({ state: 'unknown' });
    expect(await f.open().repairNetwork('unknown', 0)).toMatchObject({ state: 'unresolved' });
    expect(await f.open(f.second).reconcileNetwork('unknown', 0)).toMatchObject({ state: 'unresolved' });
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.second.prepare('SELECT lock_token FROM network_device_state').get()).toMatchObject({ lock_token: expect.any(String) });
  } finally { f.dispose(); }
});

test('only exact unexpired local confirmation authorizes the registered repair; a duplicate replays its durable receipt', async () => {
  const f = fixture();
  try {
    const supervisor = f.open();
    expect(supervisor.currentEpoch()).toBe(0);
    expect(await supervisor.repairNetwork('first', 0)).toMatchObject({ state: 'not_confirmed', attempts: 0 });
    f.approve('first', { deviceId: 'other-host' });
    expect(await supervisor.repairNetwork('first', 0)).toMatchObject({ state: 'not_confirmed', attempts: 0 });
    f.approve('first', { policyDigest: 'f'.repeat(64) });
    expect(await supervisor.repairNetwork('first', 0)).toMatchObject({ state: 'not_confirmed', attempts: 0 });
    f.approve('first', { expiresAt: baseTime });
    expect(await supervisor.repairNetwork('first', 0)).toMatchObject({ state: 'not_confirmed', attempts: 0 });
    f.approve('first');
    expect(await supervisor.repairNetwork('first', 1)).toMatchObject({ state: 'not_confirmed', attempts: 0 });
    expect(f.apply).not.toHaveBeenCalled();
    const receipt = await supervisor.repairNetwork('first', 0);
    expect(receipt).toMatchObject({ state: 'repaired', epoch: 1, attempts: 1,
      verification: [{ targetId: 'gitlab', problem: 'healthy' }, { targetId: 'github', problem: 'healthy' },
        { targetId: 'hub', problem: 'healthy' }, { targetId: 'writer-peer', problem: 'healthy' }] });
    expect(await f.open(f.second).repairNetwork('first', 0)).toEqual(receipt);
    expect(f.open(f.second).currentEpoch()).toBe(1);
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.apply).toHaveBeenCalledWith({ id: 'corporate-dns', kind: 'refresh_dns', target: 'gitlab' },
      expect.objectContaining({ expectedRule: original, owner: { operationId: 'first', epoch: 1 } }));
    f.approve('stale');
    expect(await f.open(f.second).repairNetwork('stale', 0)).toMatchObject({ state: 'stale_epoch', epoch: 1, attempts: 0 });
  } finally { f.dispose(); }
});

test('a healthy hub does not make an identity error or rate limit eligible for a network change', async () => {
  const f = fixture();
  try {
    f.approve('identity');
    const supervisor = f.open();
    f.statuses.set('gitlab', 'identity');
    expect(await supervisor.repairNetwork('identity', 0)).toMatchObject({ state: 'needs_login', epoch: 0, attempts: 0 });
    f.approve('limited');
    f.statuses.set('gitlab', 'rate_limit');
    f.retryAfter.set('gitlab', 90_000);
    expect(await supervisor.repairNetwork('limited', 0)).toMatchObject({ state: 'rate_limited', retryAt: baseTime + 90_000, attempts: 0 });
    f.approve('again');
    f.statuses.set('gitlab', 'dns');
    f.advance(5_001);
    expect(await f.open(f.second).repairNetwork('again', 0)).toMatchObject({ state: 'rate_limited', attempts: 0 });
    expect(f.apply).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});

test('DNS and proxy changes share one durable lock even across database connections', async () => {
  const f = fixture();
  let unblock!: () => void;
  let started!: () => void;
  const admitted = new Promise<void>((resolve) => { started = resolve; });
  const permit = new Promise<void>((resolve) => { unblock = resolve; });
  let running: ReturnType<ReturnType<typeof createNetworkSupervisor>['repairNetwork']> | undefined;
  try {
    f.approve('dns');
    f.approve('proxy', { expectedEpoch: 1, targetId: 'github', repairId: 'personal-proxy' });
    f.approve('vpn', { expectedEpoch: 1, repairId: 'corporate-route' });
    f.apply.mockImplementationOnce(async () => {
      started();
      await permit;
      f.replaceRule(changed);
      f.statuses.set('gitlab', 'healthy');
      return { state: 'changed', revision: changed };
    });
    running = f.open().repairNetwork('dns', 0);
    await admitted;
    expect(await f.open(f.second).repairNetwork('proxy', 1)).toMatchObject({ state: 'busy', attempts: 0 });
    expect(await f.open(f.second).repairNetwork('vpn', 1)).toMatchObject({ state: 'busy', attempts: 0 });
    expect(await f.open(f.second).repairNetwork('dns', 0)).toMatchObject({ state: 'in_progress', attempts: 1 });
    unblock();
    expect(await running).toMatchObject({ state: 'repaired' });
    expect(f.apply).toHaveBeenCalledTimes(1);
  } finally { unblock(); await running; f.dispose(); }
});

test('a regression in a previously healthy lane or peer restores the exact owned prior rule', async () => {
  const f = fixture();
  try {
    f.approve('first');
    f.apply.mockImplementationOnce(async (repair, context) => {
      const apply = f.apply.getMockImplementation()!;
      const result = await apply(repair, context);
      f.statuses.set('github', 'proxy');
      f.statuses.set('writer-peer', 'route');
      return result;
    });
    const receipt = await f.open().repairNetwork('first', 0);
    expect(receipt).toMatchObject({ state: 'reverted', epoch: 2, attempts: 1,
      verification: [{ targetId: 'gitlab', problem: 'healthy' }, { targetId: 'github', problem: 'proxy' },
        { targetId: 'hub', problem: 'healthy' }, { targetId: 'writer-peer', problem: 'route' }] });
    expect(f.restore).toHaveBeenCalledWith(expect.objectContaining({ id: 'corporate-dns' }),
      expect.objectContaining({ expectedRule: changed, priorRule: original, owner: { operationId: 'first', epoch: 2 } }));
    expect(f.changed()).toBe(original);
    expect(f.observe.mock.calls.map(([{ targetIds }]) => targetIds)).toEqual([
      ['hub', 'gitlab', 'github', 'writer-peer'], ['gitlab', 'github', 'hub', 'writer-peer'], ['gitlab', 'github', 'hub', 'writer-peer'],
    ]);
  } finally { f.dispose(); }
});

test('a replaced epoch or ownership cannot trigger rollback of a different operation', async () => {
  const f = fixture();
  try {
    f.approve('first');
    f.observe.mockImplementation(async (input) => {
      if (input.targetIds[0] === 'gitlab') {
        f.second.prepare(`UPDATE network_device_state SET owner_id = 'replacement', epoch = 2, lock_token = NULL
          WHERE device_id = ?`).run(policy.device_id);
        f.statuses.set('writer-peer', 'route');
      }
      return input.targetIds.map((targetId) => ({ targetId, problem: f.statuses.get(targetId) ?? 'unknown' }));
    });
    expect(await f.open().repairNetwork('first', 0)).toMatchObject({ state: 'superseded', epoch: 2, attempts: 1 });
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.second.prepare('SELECT owner_id,epoch FROM network_device_state').get()).toEqual({ owner_id: 'replacement', epoch: 2 });
  } finally { f.dispose(); }
});

test('an ambiguous device effect holds the lock across reopen and cannot silently retry', async () => {
  const f = fixture();
  try {
    f.approve('first');
    f.apply.mockRejectedValueOnce(new Error('opaque device error'));
    expect(await f.open().repairNetwork('first', 0)).toMatchObject({ state: 'unresolved', epoch: 1, attempts: 1 });
    f.approve('second', { expectedEpoch: 1 });
    expect(await f.open(f.second).repairNetwork('second', 1)).toMatchObject({ state: 'busy' });
    expect(await f.open(f.second).repairNetwork('first', 0)).toMatchObject({ state: 'unresolved', attempts: 1 });
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.restore).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});

test('a retry waits for cooldown and stops at the policy cap; expiration before applying prevents effects', async () => {
  const f = fixture();
  try {
    f.approve('bounded');
    f.apply.mockResolvedValue({ state: 'unchanged' });
    expect(await f.open().repairNetwork('bounded', 0)).toMatchObject({ state: 'not_repaired', epoch: 2, attempts: 2 });
    expect(f.apply).toHaveBeenCalledTimes(2);
    expect(f.sleep).toHaveBeenCalledExactlyOnceWith(5_000, expect.any(AbortSignal));
    f.approve('expired', { expectedEpoch: 2, expiresAt: baseTime + 5_001 });
    f.readRule.mockImplementationOnce(async () => { f.advance(2); return original; });
    expect(await f.open().repairNetwork('expired', 2)).toMatchObject({ state: 'not_confirmed', epoch: 2, attempts: 0 });
    expect(f.apply).toHaveBeenCalledTimes(2);
  } finally { f.dispose(); }
});

test('repeated MFA evidence across proposals reports one pending question for the target', async () => {
  const f = fixture();
  try {
    f.approve('first');
    f.approve('second');
    f.statuses.set('gitlab', 'mfa');
    const first = await f.open().repairNetwork('first', 0);
    expect(first).toMatchObject({ state: 'mfa_required', questionId: expect.any(String), attempts: 0 });
    expect(await f.open(f.second).repairNetwork('second', 0)).toMatchObject({ state: 'mfa_required', questionId: first.questionId });
    expect(f.apply).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});

test('foreign rule revisions are preserved even if the SQLite ownership pair has not changed', async () => {
  const f = fixture();
  try {
    f.approve('first');
    const foreign = 'c'.repeat(64);
    f.apply.mockImplementationOnce(async () => {
      f.replaceRule(foreign);
      f.statuses.set('writer-peer', 'route');
      return { state: 'changed', revision: changed };
    });
    expect(await f.open().repairNetwork('first', 0)).toMatchObject({ state: 'unresolved', epoch: 1, attempts: 1 });
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.changed()).toBe(foreign);
  } finally { f.dispose(); }
});

test('MFA requested by the actuator holds further actions for that target until a healthy observation', async () => {
  const f = fixture();
  try {
    f.approve('first');
    f.apply.mockResolvedValueOnce({ state: 'mfa' });
    const first = await f.open().repairNetwork('first', 0);
    expect(first).toMatchObject({ state: 'mfa_required', questionId: expect.any(String), epoch: 1 });
    f.approve('second', { expectedEpoch: 1 });
    expect(await f.open(f.second).repairNetwork('second', 1))
      .toMatchObject({ state: 'mfa_required', questionId: first.questionId, attempts: 0 });
    expect(f.apply).toHaveBeenCalledTimes(1);
    f.approve('resolved', { expectedEpoch: 1 });
    f.statuses.set('gitlab', 'healthy');
    expect(await f.open().repairNetwork('resolved', 1)).toMatchObject({ state: 'already_healthy', attempts: 0 });
    f.approve('next', { expectedEpoch: 1 });
    f.statuses.set('gitlab', 'mfa');
    const next = await f.open().repairNetwork('next', 1);
    expect(next).toMatchObject({ state: 'mfa_required', questionId: expect.any(String), attempts: 0 });
    expect(next.questionId).not.toBe(first.questionId);
  } finally { f.dispose(); }
});

test('the total deadline settles a hung mutation while retaining its durable lock', async () => {
  const f = fixture();
  vi.useFakeTimers();
  try {
    f.approve('first');
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    f.apply.mockImplementationOnce(() => {
      started();
      return new Promise(() => {});
    });
    const repair = f.open().repairNetwork('first', 0);
    await startedPromise;
    const durableIntent = f.second.prepare('SELECT prior_epoch, prior_rule, apply_epoch FROM network_repair_attempts').get();
    expect(durableIntent).toEqual({ prior_epoch: 0, prior_rule: original, apply_epoch: 1 });
    await vi.advanceTimersByTimeAsync(policy.limits.deadline_ms);
    expect(await repair).toMatchObject({ state: 'unresolved', epoch: 1, attempts: 1 });
    f.approve('second', { expectedEpoch: 1 });
    expect(await f.open(f.second).repairNetwork('second', 1)).toMatchObject({ state: 'busy', epoch: 1 });
    expect(f.restore).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); f.dispose(); }
});

test('accepts the full T03 settings proposal identity without weakening device registration', async () => {
  const f = fixture();
  try {
    const proposal = 'settings_proposal_' + 'd'.repeat(64);
    f.approve(proposal);
    expect(await f.open().repairNetwork(proposal, 0)).toMatchObject({ state: 'repaired', attempts: 1 });
  } finally { f.dispose(); }
});

test('a host permission failure provides a permission next step without mutating the network', async () => {
  const f = fixture();
  try {
    f.approve('permission');
    f.statuses.set('gitlab', 'permission');
    expect(await f.open().repairNetwork('permission', 0)).toMatchObject({ state: 'needs_permission', attempts: 0 });
    expect(f.apply).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});

test('an inaccessible fixed-rule snapshot reports the permission block without reserving an effect', async () => {
  const f = fixture();
  try {
    f.approve('snapshot-permission');
    f.readRule.mockResolvedValueOnce({ state: 'permission' });
    expect(await f.open().repairNetwork('snapshot-permission', 0)).toMatchObject({ state: 'needs_permission', attempts: 0, epoch: 0 });
    expect(f.apply).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});
