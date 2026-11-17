import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openDatabase, type MigrationEntry } from '@patrick/storage';
import { createMacNetworkActuator } from '../../packages/host/src/network/native.js';
import { createNetworkSupervisor, networkPolicyDigest, networkRepairPolicyDigest } from '../../packages/host/src/network/supervisor.js';
import { assessVpnCapability, parseNetworkPolicy, type VpnTrial } from '../../packages/host/src/network/vpn.js';

test('isolated configuration harness proves native fixed repair, owned rollback and all dependency rechecks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'patrick-t21-admission-'));
  const migrations = new URL('../../packages/storage/migrations/', import.meta.url);
  const entries = JSON.parse(readFileSync(new URL('manifest.json', migrations), 'utf8')) as MigrationEntry[];
  const manifest = entries.some(({ file }) => file === '0022_network.sql') ? entries : [...entries, {
    file: '0022_network.sql', sha256: createHash('sha256').update(readFileSync(new URL('0022_network.sql', migrations))).digest('hex'),
  }];
  const db = openDatabase(join(directory, 'network.sqlite'), { manifest });
  try {
    const configFile = join(directory, 'isolated-dns.json');
    await writeFile(configFile, JSON.stringify(['10.42.0.53']));
    const policy = parseNetworkPolicy({
      schema_version: '1.0', device_id: 'isolated-config-harness', revision: 1,
      targets: [{ id: 'hub', role: 'hub' }, { id: 'work', role: 'target' }, { id: 'peer', role: 'peer' }],
      vpn_paths: [{ id: 'work-vpn', client: 'openvpn', targets: ['work'] }],
      repairs: [{ id: 'dns', kind: 'refresh_dns', target: 'work' },
        { id: 'vpn', kind: 'reconnect_vpn', target: 'work', path: 'work-vpn' }],
      limits: { maximum_attempts: 1, cooldown_ms: 5_000, deadline_ms: 5_000 }, fallback: 'none',
    });
    const commands: string[][] = [];
    const actuator = createMacNetworkActuator({
      policy, localDeviceId: policy.device_id, platform: 'darwin', snapshotDirectory: join(directory, 'snapshots'),
      bindings: [{ repairId: 'dns', service: 'Registered test service', servers: ['10.42.0.54'] }],
      async runCommand(file, args) {
        expect(file).toBe('/usr/sbin/networksetup');
        commands.push([...args]);
        if (args[0] === '-getdnsservers') return { stdout: (JSON.parse(await readFile(configFile, 'utf8')) as string[]).join('\n') };
        if (args[0] !== '-setdnsservers') throw new Error('unexpected configuration action');
        await writeFile(configFile, JSON.stringify(args.slice(2)));
        return { stdout: '' };
      },
    });
    const probes: string[][] = [];
    const expiresAt = Date.now() + 60_000;
    let approvalDigest = networkPolicyDigest(policy);
    const supervisor = createNetworkSupervisor(db, {
      policy, actuator,
      confirmation: (proposalId) => ({ proposalId, confirmationId: 'local-control',
        deviceId: policy.device_id, targetId: 'work', repairId: 'dns', policyDigest: approvalDigest,
        expectedEpoch: 0, expiresAt }),
      async observe({ targetIds }) {
        probes.push([...targetIds]);
        const dns = JSON.parse(await readFile(configFile, 'utf8')) as string[];
        const altered = dns[0] === '10.42.0.54';
        return targetIds.map((targetId) => ({ targetId,
          problem: targetId === 'work' ? altered ? 'healthy' : 'dns'
            : targetId === 'peer' && altered ? 'route' : 'healthy' }));
      },
    });
    expect(await supervisor.repairNetwork('missing-native-binding', 0)).toMatchObject({ state: 'not_confirmed', attempts: 0 });
    expect(commands).toHaveLength(0);
    approvalDigest = networkRepairPolicyDigest(policy, actuator);
    const receipt = await supervisor.repairNetwork('isolated-admission', 0);
    expect(receipt).toMatchObject({ state: 'reverted', epoch: 2, attempts: 1,
      rollbackVerification: [{ targetId: 'work', problem: 'dns' }, { targetId: 'hub', problem: 'healthy' }, { targetId: 'peer', problem: 'healthy' }] });
    expect(probes).toEqual([['hub', 'work', 'peer'], ['work', 'hub', 'peer'], ['work', 'hub', 'peer']]);
    expect(JSON.parse(await readFile(configFile, 'utf8'))).toEqual(['10.42.0.53']);
    expect(commands.filter(([name]) => name === '-setdnsservers')).toHaveLength(2);
    expect(await actuator.readRule(policy.repairs[1], new AbortController().signal)).toEqual({ state: 'incompatible' });
    expect(assessVpnCapability(policy, 'a'.repeat(64), [], new Date())).toMatchObject({ dual_path: null, state: 'unknown' });
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

const liveEvidencePath = process.env.PATRICK_T21_LIVE_EVIDENCE;
test.skipIf(!liveEvidencePath)('registered-device VPN admission requires fresh real observations for both launch orders, DNS, reconnect and peer', () => {
  const evidence = JSON.parse(readFileSync(liveEvidencePath!, 'utf8')) as {
    mode: string; policy: unknown; environmentDigest: string; trials: VpnTrial[];
    versions: Record<string, string>; approvedDeviceId: string;
  };
  const policy = parseNetworkPolicy(evidence.policy);
  expect(evidence.mode).toBe('registered-device');
  expect(evidence.approvedDeviceId).toBe(policy.device_id);
  expect(policy.vpn_paths).toHaveLength(2);
  for (const path of policy.vpn_paths) expect(evidence.versions[path.id]).toMatch(/^\S.+$/u);
  const capability = assessVpnCapability(policy, evidence.environmentDigest, evidence.trials, new Date());
  expect(evidence.trials.some(({ order }) => order[0] === policy.vpn_paths[0].id)).toBe(true);
  expect(evidence.trials.some(({ order }) => order[0] === policy.vpn_paths[1].id)).toBe(true);
  expect(capability.state).not.toBe('unknown');
  if (!capability.dual_path) expect(capability.fallback).not.toBeNull();
});
