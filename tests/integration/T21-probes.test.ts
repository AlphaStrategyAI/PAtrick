import { describe, expect, it, vi } from 'vitest';
import { classifyHttp, createNetworkInspector } from '../../packages/host/src/network/probes.js';
import type { NetworkProbePorts } from '../../packages/host/src/network/probes.js';
import { parseNetworkPolicy } from '../../packages/host/src/network/vpn.js';

const policy = parseNetworkPolicy({
  schema_version: '1.0', device_id: 'fixture-host', revision: 3,
  targets: [
    { id: 'hub', role: 'hub' }, { id: 'enterprise', role: 'target' }, { id: 'peer', role: 'peer' },
  ],
  vpn_paths: [{ id: 'work', client: 'openvpn', targets: ['enterprise'] }],
  repairs: [], limits: { maximum_attempts: 1, cooldown_ms: 5_000, deadline_ms: 5_000 }, fallback: 'none',
});

function fixture(override: Partial<NetworkProbePorts> = {}): NetworkProbePorts {
  return {
    interfaces: async () => 'passed',
    route: async () => 'passed',
    dns: async () => 'passed',
    proxy: async () => 'not_applicable',
    tcp: async () => 'passed',
    tls: async () => 'passed',
    http: async () => ({ status: 200, identity: 'verified' }),
    peer: async () => 'passed',
    ...override,
  };
}

describe('T21 scoped network probes', () => {
  it('rejects an unregistered target before reading the host or probing a known target', async () => {
    const interfaces = vi.fn<NonNullable<NetworkProbePorts['interfaces']>>(async () => 'passed');
    const dns = vi.fn<NetworkProbePorts['dns']>(async () => 'passed');
    const inspectNetwork = createNetworkInspector(policy, fixture({ interfaces, dns }));
    await expect(inspectNetwork(['hub', 'other'])).rejects.toThrow('NETWORK_TARGET_NOT_REGISTERED');
    expect(interfaces).not.toHaveBeenCalled();
    expect(dns).not.toHaveBeenCalled();
  });

  it('keeps hub and peer healthy when the enterprise target cannot resolve', async () => {
    const tcp = vi.fn<NetworkProbePorts['tcp']>(async () => 'passed');
    const inspectNetwork = createNetworkInspector(policy, fixture({
      dns: async ({ id }) => id === 'enterprise' ? 'failed' : 'passed', tcp,
    }));
    const report = await inspectNetwork(['hub', 'enterprise', 'hub', 'peer']);
    expect(report).toMatchObject({ deviceId: 'fixture-host', policyRevision: 3, interfaces: 'passed' });
    expect(report.targets).toMatchObject([
      { targetId: 'hub', role: 'hub', outcome: 'healthy', layers: { dns: 'passed', peer: 'not_applicable' } },
      { targetId: 'enterprise', role: 'target', outcome: 'dns', layers: { dns: 'failed', tcp: 'skipped', tls: 'skipped' } },
      { targetId: 'peer', role: 'peer', outcome: 'healthy', layers: { peer: 'passed' } },
    ]);
    expect(tcp.mock.calls.map(([{ id }]) => id)).toEqual(['hub', 'peer']);
  });

  it.each(['route', 'proxy', 'tcp', 'tls'] as const)('preserves a confirmed %s failure', async (layer) => {
    const http = vi.fn<NetworkProbePorts['http']>(async () => ({ status: 200, identity: 'verified' }));
    const inspectNetwork = createNetworkInspector(policy, fixture({ [layer]: async () => 'failed', http }));
    const { targets } = await inspectNetwork(['enterprise']);
    expect(targets[0]).toMatchObject({ outcome: layer, layers: { [layer]: 'failed', http: 'skipped', identity: 'skipped' } });
    expect(http).not.toHaveBeenCalled();
  });

  it('reports confirmed local interface failure without attempting transport', async () => {
    const tcp = vi.fn<NetworkProbePorts['tcp']>(async () => 'passed');
    const inspectNetwork = createNetworkInspector(policy, fixture({ interfaces: async () => 'failed', tcp }));
    const { interfaces, targets } = await inspectNetwork(['enterprise']);
    expect(interfaces).toBe('failed');
    expect(targets[0]).toMatchObject({ outcome: 'interface', layers: { tcp: 'skipped' } });
    expect(tcp).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'identity', 'failed'], [403, 'identity', 'failed'], [429, 'rate_limit', 'skipped'],
    [302, 'target', 'skipped'], [503, 'target', 'skipped'],
  ] as const)('classifies response %i without treating it as a path fault', async (status, outcome, identity) => {
    expect(classifyHttp(status)).toBe(outcome);
    const inspectNetwork = createNetworkInspector(policy, fixture({ http: async () => ({ status, retryAfterMs: 37_000 }) }));
    const { targets } = await inspectNetwork(['enterprise']);
    expect(targets[0]).toMatchObject({
      outcome, httpStatus: status, retryAfterMs: status === 429 ? 37_000 : null,
      layers: { tcp: 'passed', tls: 'passed', http: 'passed', identity },
    });
  });

  it('uses authenticated application evidence before reporting an HTTP success as healthy', async () => {
    expect(classifyHttp(204)).toBe('healthy');
    const inspectNetwork = createNetworkInspector(policy, fixture({
      http: async ({ id }) => ({ status: 200, identity: id === 'enterprise' ? 'rejected' : 'unconfirmed' }),
    }));
    const { targets } = await inspectNetwork(['hub', 'enterprise']);
    expect(targets).toMatchObject([
      { outcome: 'unknown', layers: { http: 'passed', identity: 'unknown' } },
      { outcome: 'identity', layers: { http: 'passed', identity: 'failed' } },
    ]);
  });

  it('preserves explicit MFA evidence for the supervisor single-question gate', async () => {
    const inspectNetwork = createNetworkInspector(policy, fixture({
      http: async () => ({ status: 401, identity: 'mfa' }),
    }));
    expect((await inspectNetwork(['enterprise'])).targets[0]).toMatchObject({
      outcome: 'mfa', httpStatus: 401, layers: { identity: 'failed' },
    });
  });

  it('does not bypass an unknown proxy path to infer healthy access or peer heartbeat', async () => {
    const inspectNetwork = createNetworkInspector(policy, fixture({ interfaces: undefined, proxy: undefined, peer: undefined }));
    const { interfaces, targets } = await inspectNetwork(['hub', 'peer']);
    expect(interfaces).toBe('unknown');
    expect(targets).toMatchObject([
      { outcome: 'unknown', layers: { proxy: 'unknown', identity: 'skipped', peer: 'not_applicable' } },
      { outcome: 'unknown', layers: { proxy: 'unknown', identity: 'skipped', peer: 'skipped' } },
    ]);
  });

  it('distinguishes a failed peer heartbeat from a healthy hub', async () => {
    const inspectNetwork = createNetworkInspector(policy, fixture({ peer: async () => 'failed' }));
    const { targets } = await inspectNetwork(['hub', 'peer']);
    expect(targets).toMatchObject([{ outcome: 'healthy' }, { outcome: 'peer', layers: { peer: 'failed' } }]);
  });

  it('reports probe exceptions as unknown and does not reveal internal details', async () => {
    const inspectNetwork = createNetworkInspector(policy, fixture({
      tls: async () => { throw new Error('private fixture hostname'); },
    }));
    const report = await inspectNetwork(['enterprise']);
    expect(report.targets[0]).toMatchObject({ outcome: 'unknown', layers: { tls: 'unknown', http: 'skipped' } });
    expect(JSON.stringify(report)).not.toContain('private fixture hostname');
  });

  it('keeps a stalled adapter within the policy deadline and skips dependent checks', async () => {
    vi.useFakeTimers();
    try {
      const tcp = vi.fn<NetworkProbePorts['tcp']>(async () => 'passed');
      const dns = vi.fn<NetworkProbePorts['dns']>(() => new Promise(() => {}));
      const inspectNetwork = createNetworkInspector(policy, fixture({ dns, tcp }));
      const report = inspectNetwork(['enterprise']);
      await vi.advanceTimersByTimeAsync(policy.limits.deadline_ms);
      expect((await report).targets[0]).toMatchObject({ outcome: 'unknown', layers: { dns: 'unknown', tcp: 'skipped' } });
      expect(dns.mock.calls[0][1].aborted).toBe(true);
      expect(tcp).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
