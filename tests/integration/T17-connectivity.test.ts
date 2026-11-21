import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { preferencePayload } from '@patrick/contracts';
import { openDatabase } from '@patrick/storage';
import type { Principal } from '../../apps/service/src/auth.js';
import { createSettingsChanges, type SettingsDraft } from '../../apps/service/src/settings/changes.js';
import { connectivitySettingsHandler, verifiedConnectivityHosts } from '../../apps/service/src/settings/network.js';
import { connectivityProbeHosts, parseConnectivityHostname } from '../../packages/host/src/network/probes.js';

const initial = '2026-11-21T02:00:00.000Z';
const owner: Principal = {
  account_id: 'owner', caller_id: 'web', auth_epoch: 1, authenticated_at: initial, domains: ['personal'], operations: ['owner'],
};

test('connectivity hosts reject a url, port, path, address, or empty name', () => {
  expect(parseConnectivityHostname('git.lifepilot.xyz')).toBe('git.lifepilot.xyz');
  expect(parseConnectivityHostname('WWW.Google.com')).toBe('www.google.com');
  for (const value of ['', ' ', 'https://git.lifepilot.xyz', 'git.lifepilot.xyz:443', 'git.lifepilot.xyz/a',
    'git.lifepilot.xyz?q=1', '10.1.3.1', '2001:db8::1', 'not a host']) {
    expect(() => parseConnectivityHostname(value)).toThrow('CONNECTIVITY_HOST_INVALID');
  }
  expect(preferencePayload.safeParse({ intranet_host: 'git.lifepilot.xyz' }).success).toBe(false);
  expect(connectivityProbeHosts).toHaveLength(1);
});

test('a connectivity draft keeps the previous probe hosts until the settings receipt is rechecked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-connectivity-'));
  const db = openDatabase(join(root, 'settings.sqlite'));
  db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(owner.account_id, 1, 1, initial);
  db.prepare("INSERT INTO caller_scopes VALUES ('owner','web','personal','owner',NULL)").run();
  const now = new Date(initial);
  const handler = connectivitySettingsHandler({ db, now: () => now, deviceId: 'desktop-a', authorize() {} });
  const engine = createSettingsChanges({ db, now: () => now, ttlMs: 60_000, handlers: { set_connectivity_targets: handler } });
  const draft: SettingsDraft = {
    operation: 'set_connectivity_targets', domain: 'personal', target: 'connectivity',
    input: { intranet_host: 'git.lifepilot.xyz', public_host: 'www.google.com' },
  };
  try {
    expect(verifiedConnectivityHosts(db, owner.account_id, 'personal')).toEqual({
      intranet: 'git.lifepilot.xyz', public: 'www.google.com',
    });
    expect(connectivityProbeHosts(null)).toEqual({ intranet: 'git.lifepilot.xyz', public: 'www.google.com' });
    const proof = await engine.validateSettings(owner, draft);
    expect(proof.valid).toBe(true);
    const applied = await handler.apply(owner, draft, proof, () => initial);
    expect(applied.revision).toBe(1);
    expect(verifiedConnectivityHosts(db, owner.account_id, 'personal')).toEqual({
      intranet: 'git.lifepilot.xyz', public: 'www.google.com',
    });
    db.prepare('UPDATE connectivity_probe_targets SET pending_public=? WHERE account_id=?').run('other.example', owner.account_id);
    const checked = await handler.recheck(owner, draft, applied);
    expect(checked.verified).toBe(false);
    expect(verifiedConnectivityHosts(db, owner.account_id, 'personal')).toEqual({
      intranet: 'git.lifepilot.xyz', public: 'www.google.com',
    });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a rechecked settings receipt replaces the probe hosts and a bad draft does not', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-connectivity-'));
  const db = openDatabase(join(root, 'settings.sqlite'));
  db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(owner.account_id, 1, 1, initial);
  db.prepare("INSERT INTO caller_scopes VALUES ('owner','web','personal','owner',NULL)").run();
  const now = new Date(initial);
  const handler = connectivitySettingsHandler({ db, now: () => now, deviceId: 'desktop-a', authorize() {} });
  const engine = createSettingsChanges({ db, now: () => now, ttlMs: 60_000, handlers: { set_connectivity_targets: handler } });
  const draft: SettingsDraft = {
    operation: 'set_connectivity_targets', domain: 'personal', target: 'connectivity',
    input: { intranet_host: 'git.example', public_host: 'www.example' },
  };
  try {
    const rejected = await engine.validateSettings(owner, {
      ...draft, input: { intranet_host: 'https://git.example', public_host: 'www.example' },
    });
    expect(rejected.valid).toBe(false);
    expect(verifiedConnectivityHosts(db, owner.account_id, 'personal')).toEqual({
      intranet: 'git.lifepilot.xyz', public: 'www.google.com',
    });
    const proof = await engine.validateSettings(owner, draft);
    const receipt = await engine.submitSettings(owner, {
      validationId: proof.validation_id, requestId: 'connectivity-2', controlReceiptId: 'receipt-2', draft,
    });
    expect(receipt.verified).toBe(true);
    expect(receipt.effects).toEqual([{ item: 'connectivity_targets', outcome: 'applied', revision: 1 }]);
    expect(verifiedConnectivityHosts(db, owner.account_id, 'personal')).toEqual({
      intranet: 'git.example', public: 'www.example',
    });
    expect(() => connectivityProbeHosts({ intranet: 'https://git.example/a', public: 'www.example' })).toThrow('CONNECTIVITY_HOST_INVALID');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
