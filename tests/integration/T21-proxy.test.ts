import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { expect, test, vi } from 'vitest';
import * as nodeProbes from '../../packages/host/src/network/node-probes.js';
import { createNativeNetworkRepairConfiguration } from '../../apps/service/src/settings/network.js';
import { parseNetworkPolicy, selectFixedRepair } from '../../packages/host/src/network/vpn.js';

vi.mock('node:dns/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:dns/promises')>();
  return { ...original, lookup: (hostname: string, options: import('node:dns').LookupAllOptions) =>
    hostname === 'multi-address.test'
      ? Promise.resolve([{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }])
      : original.lookup(hostname, options) };
});

const policy = parseNetworkPolicy({ schema_version: '1.0', device_id: 'registered-mac', revision: 1,
  targets: [{ id: 'hub', role: 'hub' }, { id: 'work', role: 'target' }, { id: 'peer', role: 'peer' }],
  vpn_paths: [], repairs: [{ id: 'work-proxy', kind: 'refresh_proxy', target: 'work' }],
  limits: { maximum_attempts: 1, cooldown_ms: 5_000, deadline_ms: 5_000 }, fallback: 'none' });
const endpoints = policy.targets.map(({ id }) => ({ targetId: id, url: 'https://127.0.0.1/health',
  identity: () => 'verified' as const, peer: async () => 'passed' as const }));

test('a failed registered CONNECT path is a proxy fault without falling back to direct transport', async () => {
  let attempts = 0;
  const ports = nodeProbes.createNodeNetworkProbePorts({ policy, localDeviceId: policy.device_id, endpoints,
    proxy: async () => ({ server: 'registered-proxy.test', port: 8080 }),
    connectProxy: async () => { attempts += 1; throw new Error('ECONNREFUSED'); },
    local: { interfaces: async () => 'passed', route: async () => 'passed', proxy: async () => 'unknown' },
  });
  const signal = new AbortController().signal;
  await ports.dns(policy.targets[1], signal);
  expect(await ports.proxy!(policy.targets[1], signal)).toBe('failed');
  expect(attempts).toBe(1);
});

test.each(['proxy', 'tcp'] as const)('the registered CONNECT %s stage falls back across pinned DNS addresses', async (stage) => {
  const destinations: string[] = [];
  let opened = 0;
  const ports = nodeProbes.createNodeNetworkProbePorts({ policy, localDeviceId: policy.device_id,
    endpoints: endpoints.map((endpoint) => ({ ...endpoint, url: 'https://multi-address.test/health' })),
    proxy: async () => ({ server: 'registered-proxy.test', port: 8080 }),
    connectProxy: async (_proxy, destination) => {
      destinations.push(destination.host);
      if (stage === 'tcp' && opened++ === 0) return new Socket();
      if (destination.host === '::1') throw new Error('ECONNREFUSED');
      return new Socket();
    },
  });
  const signal = new AbortController().signal;
  await ports.dns(policy.targets[1], signal);
  expect(await ports.proxy!(policy.targets[1], signal)).toBe('passed');
  if (stage === 'tcp') expect(await ports.tcp(policy.targets[1], signal)).toBe('passed');
  expect(destinations).toEqual(stage === 'proxy' ? ['::1', '127.0.0.1'] : ['::1', '::1', '127.0.0.1']);
});

test('native composition diagnoses the registered service proxy and makes its fixed repair reachable', async () => {
  const original = nodeProbes.createNodeNetworkProbePorts;
  const spy = vi.spyOn(nodeProbes, 'createNodeNetworkProbePorts').mockImplementation((options) => original({
    ...options, local: { interfaces: async () => 'passed', route: async () => 'passed', proxy: async () => 'unknown' },
    connectProxy: async () => { throw new Error('ECONNREFUSED'); },
  }));
  const calls: string[][] = [];
  try {
    const configuration = createNativeNetworkRepairConfiguration({ policy, localDeviceId: policy.device_id,
      accountId: 'owner', domain: 'personal', endpoints, snapshotDirectory: mkdtempSync(join(tmpdir(), 'patrick-t21-composition-')),
      nativeBindings: [{ repairId: 'work-proxy', service: 'Registered service', proxies: {
        web: { enabled: true, server: 'fixed.test', port: 8080 },
        secure: { enabled: true, server: 'fixed.test', port: 8080 },
        socks: { enabled: false, server: 'fixed.test', port: 1080 },
      } }],
      nativeRuntime: { platform: 'darwin', runCommand: async (_file, args) => {
        calls.push([...args]);
        if (args[0] === '-getsecurewebproxy') return {
          stdout: 'Enabled: Yes\nServer: broken.test\nPort: 8080\nAuthenticated Proxy Enabled: 0\n',
        };
        if (args[0] === '-getautoproxyurl') return { stdout: 'URL: (null)\nEnabled: No\n' };
        if (args[0] === '-getproxyautodiscovery') return { stdout: 'Auto Proxy Discovery: Off\n' };
        throw new Error('unexpected command');
      } },
    });
    expect(spy.mock.calls[0][0].proxy).toBeTypeOf('function');
    const readings = await configuration.observe({ deviceId: policy.device_id, targetIds: ['work'], signal: new AbortController().signal });
    expect(readings).toEqual([{ targetId: 'work', problem: 'proxy', retryAfterMs: null }]);
    expect(selectFixedRepair(policy, { deviceId: policy.device_id, targetId: 'work', repairId: 'work-proxy', problem: readings[0].problem }))
      .toEqual(policy.repairs[0]);
    expect(calls).toContainEqual(['-getsecurewebproxy', 'Registered service']);
    expect(calls.every(([action]) => action.startsWith('-get'))).toBe(true);
  } finally { spy.mockRestore(); }
});

test.each([
  ['no-route', { code: 1, stderr: 'route: writing to routing socket: not in table\n' }, 'route'],
  ['permission', { code: 1, stderr: 'route: permission denied\n' }, 'unknown'],
  ['unsupported', { code: 'ENOENT', stderr: '' }, 'unknown'],
] as const)('native composition distinguishes %s before selecting its registered VPN repair', async (_name, failure, problem) => {
  const vpnPolicy = parseNetworkPolicy({ ...policy,
    vpn_paths: [{ id: 'company', client: 'tunnelblick', targets: ['work'] }],
    repairs: [{ id: 'work-vpn', kind: 'reconnect_vpn', target: 'work', path: 'company' }],
  });
  const original = nodeProbes.createNodeNetworkProbePorts;
  const spy = vi.spyOn(nodeProbes, 'createNodeNetworkProbePorts').mockImplementation((options) => {
    const ports = original(options);
    return { ...ports, interfaces: async () => 'passed', tcp: async () => 'unknown' };
  });
  try {
    const configuration = createNativeNetworkRepairConfiguration({ policy: vpnPolicy, localDeviceId: policy.device_id,
      accountId: 'owner', domain: 'personal', endpoints, snapshotDirectory: mkdtempSync(join(tmpdir(), 'patrick-t21-route-')),
      nativeBindings: [{ repairId: 'work-vpn', client: 'tunnelblick', configuration: 'Registered VPN' }],
      nativeRuntime: { platform: 'darwin', runCommand: async (file, args) => {
        expect(file).toBe('/sbin/route');
        expect(args).toEqual(['-n', 'get', '127.0.0.1']);
        throw Object.assign(new Error('route failed'), failure);
      } },
    });
    const readings = await configuration.observe({ deviceId: policy.device_id, targetIds: ['work'], signal: new AbortController().signal });
    expect(readings[0].problem).toBe(problem);
    expect(Boolean(selectFixedRepair(vpnPolicy, { deviceId: policy.device_id, targetId: 'work', repairId: 'work-vpn',
      problem: readings[0].problem }))).toBe(problem === 'route');
  } finally { spy.mockRestore(); }
});
