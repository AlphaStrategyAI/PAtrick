import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createMacNetworkActuator } from '../../packages/host/src/network/native.js';
import { parseNetworkPolicy } from '../../packages/host/src/network/vpn.js';

const assertEffect = () => {};
const policy = parseNetworkPolicy({
  schema_version: '1.0', device_id: 'registered-mac', revision: 1,
  targets: [{ id: 'hub', role: 'hub' }, { id: 'work', role: 'target' }, { id: 'peer', role: 'peer' }],
  vpn_paths: [], repairs: [{ id: 'work-dns', kind: 'refresh_dns', target: 'work' }],
  limits: { maximum_attempts: 1, cooldown_ms: 5_000, deadline_ms: 5_000 }, fallback: 'none',
});

test('the native adapter reads back a fixed DNS change and restores only its exact owned snapshot', async () => {
  let dns = ['10.0.0.53'];
  const calls: string[][] = [];
  const actuator = createMacNetworkActuator({
    policy, localDeviceId: 'registered-mac', platform: 'darwin',
    snapshotDirectory: mkdtempSync(join(tmpdir(), 'patrick-t21-native-')),
    bindings: [{ repairId: 'work-dns', service: 'Company Wi-Fi', servers: ['10.0.0.54'] }],
    runCommand: async (file, args) => {
      expect(file).toBe('/usr/sbin/networksetup');
      calls.push([...args]);
      if (args[0] === '-getdnsservers') return { stdout: dns.join('\n') };
      if (args[0] === '-setdnsservers') { dns = [...args.slice(2)]; return { stdout: '' }; }
      throw new Error('unexpected command');
    },
  });
  const repair = policy.repairs[0];
  expect(actuator.registrationDigest).toMatch(/^[a-f0-9]{64}$/u);
  const signal = new AbortController().signal;
  const prior = await actuator.readRule(repair, signal);
  expect(prior).toMatch(/^[a-f0-9]{64}$/u);
  if (typeof prior !== 'string') throw new Error('snapshot missing');
  const owner = { operationId: 'approved-operation', epoch: 1 };
  const applied = await actuator.apply(repair, { expectedRule: prior!, owner, signal, assertEffect });
  expect(applied.state).toBe('changed');
  expect(dns).toEqual(['10.0.0.54']);
  expect(applied).toEqual({ state: 'changed', revision: createHash('sha256').update(JSON.stringify(['10.0.0.54'])).digest('hex') });
  if (applied.state !== 'changed') throw new Error('change missing');
  expect(await actuator.restore(repair, { owner: { ...owner, epoch: 2 }, expectedRule: applied.revision, priorRule: prior!, signal, assertEffect })).toBe('restored');
  expect(dns).toEqual(['10.0.0.53']);
  expect(calls.filter(([command]) => command === '-setdnsservers')).toEqual([
    ['-setdnsservers', 'Company Wi-Fi', '10.0.0.54'], ['-setdnsservers', 'Company Wi-Fi', '10.0.0.53'],
  ]);
});

test('the native adapter cannot restore a foreign operation, changed rule, or unregistered device', async () => {
  let dns = ['10.0.0.53'];
  let writes = 0;
  const options = {
    policy, localDeviceId: 'registered-mac', platform: 'darwin',
    snapshotDirectory: mkdtempSync(join(tmpdir(), 'patrick-t21-native-')),
    bindings: [{ repairId: 'work-dns', service: 'Company Wi-Fi', servers: ['10.0.0.54'] }],
    runCommand: async (_file: string, args: readonly string[]) => {
      if (args[0] === '-getdnsservers') return { stdout: dns.join('\n') };
      writes += 1;
      dns = [...args.slice(2)];
      return { stdout: '' };
    },
  };
  expect(() => createMacNetworkActuator({ ...options, localDeviceId: 'different-device' })).toThrow('NETWORK_DEVICE_NOT_REGISTERED');
  const actuator = createMacNetworkActuator(options);
  const signal = new AbortController().signal;
  const repair = policy.repairs[0];
  const prior = (await actuator.readRule(repair, signal))!;
  if (typeof prior !== 'string') throw new Error('snapshot missing');
  const owner = { operationId: 'approved-operation', epoch: 1 };
  const applied = await actuator.apply(repair, { expectedRule: prior, owner, signal, assertEffect });
  if (applied.state !== 'changed') throw new Error('change missing');
  expect(await actuator.restore(repair, { owner: { operationId: 'other', epoch: 2 },
    expectedRule: applied.revision, priorRule: prior, signal, assertEffect })).toBe('conflict');
  dns = ['10.0.0.99'];
  expect(await actuator.restore(repair, { owner: { ...owner, epoch: 2 },
    expectedRule: applied.revision, priorRule: prior, signal, assertEffect })).toBe('conflict');
  expect(writes).toBe(1);
});

test('proxy configuration is restored from the durable journal after reopening the native adapter', async () => {
  const proxyPolicy = parseNetworkPolicy({ ...policy, repairs: [{ id: 'work-proxy', kind: 'refresh_proxy', target: 'work' }] });
  const original = {
    web: { enabled: true, server: 'old.test', port: 8080 },
    secure: { enabled: true, server: 'old.test', port: 8080 },
    socks: { enabled: false, server: 'socks.test', port: 1080 },
  };
  let proxies = structuredClone(original);
  const kinds = ['web', 'secure', 'socks'] as const;
  const commands = { web: 'webproxy', secure: 'securewebproxy', socks: 'socksfirewallproxy' };
  const desired = {
    socks: original.socks, secure: { server: 'new.test', port: 9090, enabled: true },
    web: { port: 9090, enabled: true, server: 'new.test' },
  };
  const options = {
    policy: proxyPolicy, localDeviceId: policy.device_id, platform: 'darwin',
    snapshotDirectory: mkdtempSync(join(tmpdir(), 'patrick-t21-native-proxy-')),
    bindings: [{ repairId: 'work-proxy', service: 'Registered service', proxies: desired }],
    runCommand: async (_file: string, args: readonly string[]) => {
      const kind = kinds.find((kind) => [`-get${commands[kind]}`, `-set${commands[kind]}`, `-set${commands[kind]}state`].includes(args[0]));
      if (!kind) throw new Error('unexpected proxy command');
      const current = proxies[kind];
      if (args[0].startsWith('-get')) return { stdout: `Enabled: ${current.enabled ? 'Yes' : 'No'}\nServer: ${current.server}\nPort: ${current.port}\nAuthenticated Proxy Enabled: 0\n` };
      if (args[0].endsWith('state')) current.enabled = args[2] === 'on';
      else { current.server = args[2]; current.port = Number(args[3]); }
      return { stdout: '' };
    },
  };
  const actuator = createMacNetworkActuator(options);
  const repair = proxyPolicy.repairs[0];
  const signal = new AbortController().signal;
  const prior = await actuator.readRule(repair, signal);
  if (typeof prior !== 'string') throw new Error('snapshot missing');
  const applied = await actuator.apply(repair, { expectedRule: prior, owner: { operationId: 'proxy', epoch: 1 }, signal, assertEffect });
  expect(applied.state).toBe('changed');
  if (applied.state !== 'changed') throw new Error('change missing');
  expect(proxies).toEqual(desired);
  expect(await createMacNetworkActuator(options).restore(repair, { owner: { operationId: 'proxy', epoch: 2 },
    expectedRule: applied.revision, priorRule: prior, signal, assertEffect })).toBe('restored');
  expect(proxies).toEqual(original);
  proxies = structuredClone(original);
});

test('changing the registered native action invalidates the actuator identity used by T03 validation', () => {
  const options = { policy, localDeviceId: policy.device_id, platform: 'darwin',
    snapshotDirectory: mkdtempSync(join(tmpdir(), 'patrick-t21-native-registration-')) };
  const first = createMacNetworkActuator({ ...options,
    bindings: [{ repairId: 'work-dns', service: 'Registered service', servers: ['10.0.0.53'] }] });
  const second = createMacNetworkActuator({ ...options,
    bindings: [{ repairId: 'work-dns', service: 'Registered service', servers: ['10.0.0.54'] }] });
  expect(first.registrationDigest).not.toBe(second.registrationDigest);
});

test('an empty proxy snapshot is rejected before any native mutation', async () => {
  const proxyPolicy = parseNetworkPolicy({ ...policy, repairs: [{ id: 'work-proxy', kind: 'refresh_proxy', target: 'work' }] });
  let writes = 0;
  const actuator = createMacNetworkActuator({ policy: proxyPolicy, localDeviceId: policy.device_id, platform: 'darwin',
    snapshotDirectory: mkdtempSync(join(tmpdir(), 'patrick-t21-empty-proxy-')),
    bindings: [{ repairId: 'work-proxy', service: 'Registered service', proxies: {
      web: { enabled: true, server: 'fixed.test', port: 8080 },
      secure: { enabled: true, server: 'fixed.test', port: 8080 },
      socks: { enabled: false, server: 'fixed.test', port: 1080 },
    } }],
    runCommand: async (_file, args) => {
      if (args[0].startsWith('-get')) return { stdout: 'Enabled: No\nServer: \nPort: 0\nAuthenticated Proxy Enabled: 0\n' };
      writes += 1;
      return { stdout: '' };
    },
  });
  const signal = new AbortController().signal;
  expect(await actuator.readRule(proxyPolicy.repairs[0], signal)).toEqual({ state: 'incompatible' });
  await actuator.apply(proxyPolicy.repairs[0], { expectedRule: 'a'.repeat(64), owner: { operationId: 'empty', epoch: 1 }, signal, assertEffect });
  expect(writes).toBe(0);
});

test('an unset proxy destination cannot be registered as an exact native configuration', () => {
  const proxyPolicy = parseNetworkPolicy({ ...policy, repairs: [{ id: 'work-proxy', kind: 'refresh_proxy', target: 'work' }] });
  expect(() => createMacNetworkActuator({ policy: proxyPolicy, localDeviceId: policy.device_id, platform: 'darwin',
    snapshotDirectory: mkdtempSync(join(tmpdir(), 'patrick-t21-unset-proxy-')),
    bindings: [{ repairId: 'work-proxy', service: 'Registered service', proxies: {
      web: { enabled: true, server: 'fixed.test', port: 8080 },
      secure: { enabled: true, server: 'fixed.test', port: 8080 },
      socks: { enabled: false, server: '', port: 0 },
    } }],
  })).toThrow('NETWORK_NATIVE_BINDING_INVALID');
});

test('a gate closed between proxy commands prevents later writes and preserves an unknown partial effect', async () => {
  const proxyPolicy = parseNetworkPolicy({ ...policy, repairs: [{ id: 'work-proxy', kind: 'refresh_proxy', target: 'work' }] });
  let allowed = true;
  let writes = 0;
  const actuator = createMacNetworkActuator({ policy: proxyPolicy, localDeviceId: policy.device_id, platform: 'darwin',
    snapshotDirectory: mkdtempSync(join(tmpdir(), 'patrick-t21-proxy-handoff-')),
    bindings: [{ repairId: 'work-proxy', service: 'Fixture service', proxies: {
      web: { enabled: true, server: 'new.test', port: 8080 }, secure: { enabled: true, server: 'new.test', port: 8080 },
      socks: { enabled: false, server: 'new.test', port: 1080 },
    } }],
    runCommand: async (_file, args) => {
      if (args[0].startsWith('-get')) return { stdout: 'Enabled: Yes\nServer: old.test\nPort: 8080\nAuthenticated Proxy Enabled: 0\n' };
      writes += 1;
      allowed = false;
      return { stdout: '' };
    },
  });
  const repair = proxyPolicy.repairs[0];
  const signal = new AbortController().signal;
  const prior = await actuator.readRule(repair, signal);
  if (typeof prior !== 'string') throw new Error('snapshot missing');
  expect(await actuator.apply(repair, { owner: { operationId: 'partial', epoch: 1 }, expectedRule: prior, signal,
    assertEffect() { if (!allowed) throw new Error('RECOVERY_WRITES_BLOCKED'); },
  })).toEqual({ state: 'unknown' });
  expect(writes).toBe(1);
});

test.each(['CONNECTED', 'EXITING'] as const)('ambiguous Tunnelblick EXITING never acknowledges a settled effect from %s', async (initial) => {
  const vpnPolicy = parseNetworkPolicy({ ...policy,
    vpn_paths: [{ id: 'company', client: 'tunnelblick', targets: ['work'] }],
    repairs: [{ id: 'work-vpn', kind: 'reconnect_vpn', path: 'company', target: 'work' }],
  });
  let state: string = initial;
  const actions: string[] = [];
  const options = { policy: vpnPolicy, localDeviceId: policy.device_id, platform: 'darwin',
    snapshotDirectory: mkdtempSync(join(tmpdir(), 'patrick-t21-vpn-')),
    bindings: [{ repairId: 'work-vpn', client: 'tunnelblick' as const, configuration: 'Registered "Company" VPN' }],
    runCommand: async (file: string, args: readonly string[]) => {
      expect(file).toBe('/usr/bin/osascript');
      expect(args.at(-1)).toBe('Registered "Company" VPN');
      const script = args[1];
      expect(script).not.toContain('Registered "Company" VPN');
      if (script.includes('return state of')) return { stdout: state + '\n' };
      if (script.includes('disconnect configurationName')) { actions.push('disconnect'); state = 'EXITING'; }
      else if (script.includes('connect configurationName')) { actions.push('connect'); state = 'CONNECTED'; }
      else throw new Error('unexpected script');
      return { stdout: 'true\n' };
    },
  };
  const actuator = createMacNetworkActuator(options);
  const repair = vpnPolicy.repairs[0];
  const signal = new AbortController().signal;
  const prior = await actuator.readRule(repair, signal);
  if (initial === 'EXITING') {
    expect(prior).toEqual({ state: 'incompatible' });
    expect(actions).toEqual([]);
    return;
  }
  if (typeof prior !== 'string') throw new Error('VPN snapshot missing');
  const applied = await actuator.apply(repair, { expectedRule: prior, owner: { operationId: 'vpn', epoch: 1 }, signal, assertEffect });
  expect(applied).toEqual({ state: 'unknown' });
  expect(state).toBe('EXITING');
  expect(actions).toEqual(['disconnect']);
});
