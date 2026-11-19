import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createCredentialStore } from '@patrick/host';
import { settingsDashboardSchema } from '@patrick/contracts/resources';
import { openDatabase } from '@patrick/storage';
import { createApp } from '../../apps/service/src/app.js';
import { issueCallerSession } from '../../apps/service/src/auth.js';
import { parseNetworkPolicy } from '../../packages/host/src/network/vpn.js';

const now = () => new Date('2026-11-17T07:00:00.000Z');
const policy = parseNetworkPolicy({ schema_version: '1.0', device_id: 'test-mac', revision: 1,
  targets: [{ id: 'hub', role: 'hub' }, { id: 'work', role: 'target' }, { id: 'peer', role: 'peer' }],
  vpn_paths: [], repairs: [{ id: 'fixed-dns', kind: 'refresh_dns', target: 'work' }],
  limits: { maximum_attempts: 1, cooldown_ms: 5_000, deadline_ms: 5_000 }, fallback: 'none' });
const networkRepair = { policy, accountId: 'owner', domain: 'personal', localDeviceId: 'test-mac',
  observe: async () => [], actuator: { readRule: async () => null,
    apply: async () => ({ state: 'unknown' as const }), restore: async () => 'unknown' as const } };

test('network actions require a durable ledger and explicit credential location', () => {
  expect(() => createApp({ networkRepair })).toThrow('NETWORK_SUPERVISOR_DURABLE_POLICY_REQUIRED');
  expect(() => createApp({ databasePath: ':memory:', networkRepair })).toThrow('NETWORK_SUPERVISOR_DURABLE_POLICY_REQUIRED');
});

test('settings discover only fixed registered repairs for the current owner scope', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'patrick-t21-app-'));
  const databasePath = join(directory, 'ledger.sqlite');
  const credentialDirectory = join(directory, 'credentials');
  const db = openDatabase(databasePath);
  const credentials = createCredentialStore(credentialDirectory, now);
  try {
    expect(() => createApp({ databasePath, networkRepair })).toThrow('NETWORK_SUPERVISOR_CREDENTIAL_DIRECTORY_REQUIRED');
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run('owner', 1, 1, now().toISOString());
    const owner = issueCallerSession(db, { accountId: 'owner', callerId: 'owner-web', domain: 'personal', permissions: ['owner'] }, now, credentials);
    const reader = issueCallerSession(db, { accountId: 'owner', callerId: 'reader-web', domain: 'personal', permissions: ['settings.read'] }, now, credentials);
    const foreign = issueCallerSession(db, { accountId: 'owner', callerId: 'foreign-web', domain: 'company', permissions: ['owner'] }, now, credentials);
    const app = createApp({ databasePath, credentialDirectory, now, networkRepair });
    const read = async (authorization: string, domain: string) => {
      const response = await app.request('/api/v1/settings?domain=' + domain, { headers: { authorization } });
      expect(response.status).toBe(200);
      const { data } = await response.json() as { data: unknown };
      return settingsDashboardSchema.parse(data).groups.flatMap((g) => g.operations).find((op) => op.operation === 'repair_network');
    };
    expect(await read(owner.authorization, 'personal')).toEqual({ operation: 'repair_network', registered: true, kind: 'change', origin: 'inherited',
      targets: [{ target: 'test-mac', device: 'test-mac', status: 'registered', revision: 0,
        label: 'work / fixed-dns', input: { target_id: 'work', repair_id: 'fixed-dns' } }] });
    expect((await read(reader.authorization, 'personal'))?.targets).toEqual([]);
    expect((await read(foreign.authorization, 'company'))?.targets).toEqual([]);
    const unconfigured = createApp({ databasePath, credentialDirectory, now });
    const response = await unconfigured.request('/api/v1/settings?domain=personal', { headers: { authorization: owner.authorization } });
    const { data } = await response.json() as { data: unknown };
    expect(settingsDashboardSchema.parse(data).groups.flatMap((g) => g.operations).find((op) => op.operation === 'repair_network'))
      .toEqual({ operation: 'repair_network', registered: false, kind: 'change', origin: 'inherited', targets: [] });
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
