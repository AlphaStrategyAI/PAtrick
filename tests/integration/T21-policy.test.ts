import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  assessVpnCapability, mayRevert, parseNetworkPolicy, repairVerificationTargets, selectFixedRepair, type VpnTrial,
} from '../../packages/host/src/network/vpn.js';

const at = new Date('2026-11-17T07:00:00.000Z');
const config = () => ({
  schema_version: '1.0', device_id: 'test-mac', revision: 9,
  targets: [{ id: 'hub', role: 'hub' }, { id: 'gitlab', role: 'target' },
    { id: 'github', role: 'target' }, { id: 'writer-peer', role: 'peer' }],
  vpn_paths: [
    { id: 'corporate', client: 'tunnelblick', targets: ['gitlab'] },
    { id: 'personal', client: 'shadowrocket', targets: ['github'] },
  ],
  repairs: [
    { id: 'corporate-dns', kind: 'refresh_dns', target: 'gitlab' },
    { id: 'corporate-reconnect', kind: 'reconnect_vpn', target: 'gitlab', path: 'corporate' },
  ],
  limits: { maximum_attempts: 2, cooldown_ms: 30_000, deadline_ms: 120_000 },
  fallback: 'device_split',
});
const environment = 'a'.repeat(64);
const trial = (order: VpnTrial['order'], overrides: Partial<VpnTrial> = {}): VpnTrial => ({
  deviceId: 'test-mac', policyRevision: 9, environmentDigest: environment,
  order, observedAt: at.toISOString(),
  concurrentAccess: 'passed', enterpriseDns: 'passed', reconnect: 'passed', peer: 'passed', ...overrides,
});

test('a fixed repair accepts only its registered device, target, layer and profile', () => {
  const policy = parseNetworkPolicy(config());
  const exact = { deviceId: 'test-mac', targetId: 'gitlab', repairId: 'corporate-reconnect', problem: 'route' };
  expect(selectFixedRepair(policy, exact)).toEqual({ id: 'corporate-reconnect', kind: 'reconnect_vpn', target: 'gitlab', path: 'corporate' });
  for (const problem of ['identity', 'rate_limit', 'tls', 'target', 'unknown']) {
    expect(selectFixedRepair(policy, { ...exact, problem })).toBeNull();
  }
  expect(selectFixedRepair(policy, { ...exact, deviceId: 'different-device' })).toBeNull();
  expect(selectFixedRepair(policy, { ...exact, targetId: 'github' })).toBeNull();
  expect(selectFixedRepair(policy, { ...exact, repairId: 'sudo' })).toBeNull();
  expect(selectFixedRepair(policy, { ...exact, repairId: 'corporate-dns', problem: 'dns' })).toMatchObject({ kind: 'refresh_dns' });
});

test('registered policy rejects command fields, duplicate identities, unregistered profiles, and unbounded retries', () => {
  expect(() => parseNetworkPolicy({ ...config(), command: 'vpn restart' })).toThrow('NETWORK_POLICY_INVALID');
  expect(() => parseNetworkPolicy({ ...config(), targets: [...config().targets, { id: 'hub', role: 'target' }] })).toThrow('NETWORK_POLICY_INVALID');
  expect(() => parseNetworkPolicy({ ...config(), repairs: [{ id: 'p', kind: 'reconnect_vpn', target: 'github', path: 'corporate' }] }))
    .toThrow('NETWORK_POLICY_INVALID');
  expect(() => parseNetworkPolicy({ ...config(), repairs: [{ id: 'p', kind: 'refresh_dns', target: 'https://unregistered.test/' }] }))
    .toThrow('NETWORK_POLICY_INVALID');
  expect(() => parseNetworkPolicy({ ...config(), limits: { maximum_attempts: 12, cooldown_ms: 1, deadline_ms: 2000 } }))
    .toThrow('NETWORK_POLICY_INVALID');
  const schema = JSON.parse(readFileSync(new URL('../../deploy/network-policy.schema.json', import.meta.url), 'utf8'));
  expect(schema.additionalProperties).toBe(false);
  expect(schema.properties.repairs.items.oneOf.map((item: { properties: { kind: { const: string } } }) => item.properties.kind.const))
    .toEqual(['refresh_dns', 'refresh_proxy', 'reconnect_vpn']);
});

test('dual path needs fresh passing evidence for both start orders, the peer, and the same device environment', () => {
  const policy = parseNetworkPolicy(config());
  const ab = trial(['corporate', 'personal']);
  const ba = trial(['personal', 'corporate']);
  expect(assessVpnCapability(policy, environment, [ab], at)).toMatchObject({ dual_path: null, state: 'unknown' });
  expect(assessVpnCapability(policy, environment, [ab, { ...ba, environmentDigest: 'b'.repeat(64) }], at))
    .toMatchObject({ dual_path: null, state: 'unknown' });
  expect(assessVpnCapability(policy, environment, [ab, { ...ba, deviceId: 'other-mac' }], at))
    .toMatchObject({ dual_path: null, state: 'unknown' });
  expect(assessVpnCapability(policy, environment, [ab, ba], new Date(+at + 60 * 60_000 + 1)))
    .toMatchObject({ dual_path: null, state: 'unknown' });
  expect(assessVpnCapability(policy, environment, [ab, { ...ba, peer: 'unknown' }], at))
    .toMatchObject({ dual_path: null, state: 'unknown' });
  expect(assessVpnCapability(policy, environment, [ab, ba], at))
    .toEqual({ dual_path: true, state: 'supported', fallback: null, observed_at: at.toISOString() });
});

test('a measured conflict chooses only configured fallback advice; equally recent contradictory evidence fails closed', () => {
  const policy = parseNetworkPolicy(config());
  const ab = trial(['corporate', 'personal']);
  const ba = trial(['personal', 'corporate']);
  const conflict = { ...ba, enterpriseDns: 'failed' as const };
  expect(assessVpnCapability(policy, environment, [ab, conflict], at))
    .toEqual({ dual_path: false, state: 'conflict', fallback: 'device_split', observed_at: at.toISOString() });
  expect(assessVpnCapability(policy, environment, [ab, ba, conflict], at))
    .toMatchObject({ dual_path: null, state: 'unknown' });
  expect(assessVpnCapability(parseNetworkPolicy({ ...config(), fallback: 'none' }), environment, [ab, conflict], at))
    .toMatchObject({ dual_path: false, fallback: null });
});

test('rollback is limited to the same operation and epoch; verification covers fault, healthy dependencies and peer', () => {
  expect(mayRevert({ operationId: 'op-a', epoch: 4 }, { operationId: 'op-a', epoch: 4 })).toBe(true);
  expect(mayRevert({ operationId: 'op-a', epoch: 4 }, { operationId: 'op-b', epoch: 4 })).toBe(false);
  expect(mayRevert({ operationId: 'op-a', epoch: 4 }, { operationId: 'op-a', epoch: 5 })).toBe(false);
  const malformed = { operationId: undefined as unknown as string, epoch: 4 };
  expect(mayRevert(malformed, malformed)).toBe(false);
  expect(mayRevert({ operationId: 'op-a', epoch: NaN }, { operationId: 'op-a', epoch: NaN })).toBe(false);
  expect(repairVerificationTargets(parseNetworkPolicy(config()), 'gitlab', ['hub', 'github', 'hub']))
    .toEqual(['gitlab', 'github', 'hub', 'writer-peer']);
  expect(() => repairVerificationTargets(parseNetworkPolicy(config()), 'gitlab', ['not-registered'])).toThrow('NETWORK_TARGET_NOT_REGISTERED');
});
