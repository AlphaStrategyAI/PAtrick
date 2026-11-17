import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createCredentialStore } from '@patrick/host';
import { canonicalPayload, type Json } from '@patrick/contracts';
import { createHash } from 'node:crypto';
import { openDatabase } from '@patrick/storage';
import { createApp } from '../../apps/service/src/app.js';
import { issueCallerSession, ORIGIN, RP_ID } from '../../apps/service/src/auth.js';
import { parseNetworkPolicy } from '../../packages/host/src/network/vpn.js';

for (const scenario of ['success', 'mfa'] as const) {
test(`a second fixed repair preserves its input and the same ${scenario} receipt across settings and System`, async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t21-browser-'));
  const databasePath = join(root, 'ledger.sqlite');
  const credentialDirectory = join(root, 'credentials');
  const db = openDatabase(databasePath);
  const now = () => new Date('2026-11-17T07:00:00.000Z');
  const policy = parseNetworkPolicy({ schema_version: '1.0', device_id: 'test-mac', revision: 1,
    targets: [{ id: 'hub', role: 'hub' }, { id: 'work', role: 'target' }, { id: 'peer', role: 'peer' }],
    vpn_paths: [], repairs: [{ id: 'fixed-dns', kind: 'refresh_dns', target: 'work' },
      { id: 'fixed-proxy', kind: 'refresh_proxy', target: 'work' }],
    limits: { maximum_attempts: 1, cooldown_ms: 5_000, deadline_ms: 5_000 }, fallback: 'none' });
  let fixed = false;
  const applied: string[] = [];
  const requests: { path: string; payload: unknown }[] = [];
  try {
    db.prepare("INSERT INTO accounts VALUES ('owner',1,1,?)").run(now().toISOString());
    const credentials = createCredentialStore(credentialDirectory, now);
    const { token } = issueCallerSession(db, { accountId: 'owner', callerId: 'web', domain: 'personal', permissions: ['owner'] }, now, credentials);
    await page.context().addCookies([{ name: 'patrick_session', value: token, url: 'http://localhost', httpOnly: true, sameSite: 'Strict' }]);
    const app = createApp({ databasePath, credentialDirectory, now, networkRepair: {
      policy, localDeviceId: 'test-mac', accountId: 'owner', domain: 'personal',
      observe: async ({ targetIds }) => targetIds.map((targetId) => ({ targetId,
        problem: targetId === 'work' && scenario === 'mfa' && db.prepare('SELECT 1 FROM settings_changes').get() ? 'mfa' as const
          : targetId === 'work' && !fixed ? 'proxy' as const : 'healthy' as const })),
      actuator: { readRule: async () => (fixed ? 'b' : 'a').repeat(64),
        apply: async (repair) => { applied.push(repair.id); fixed = true; return { state: 'changed', revision: 'b'.repeat(64) }; },
        restore: async () => 'unknown' },
    } });
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith('/events')) return route.fulfill({ status: 503, body: '' });
      const body = request.postData();
      if (body) requests.push({ path, payload: (JSON.parse(body) as { payload: unknown }).payload });
      const response = await app.request(request.url(), { method: request.method(), headers: await request.allHeaders(),
        ...(body ? { body } : {}) });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    await page.goto('/settings/operation');
    await page.getByLabel('Registered target').selectOption({ label: 'work / fixed-proxy · test-mac' });
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Validation passed')).toBeVisible();
    expect(requests.find(({ path }) => path.endsWith('/settings/validations'))?.payload).toMatchObject({
      operation: 'repair_network', target: 'test-mac', input: { target_id: 'work', repair_id: 'fixed-proxy' },
    });
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('button', { name: 'Confirm and apply' })).toBeVisible();
    expect(applied).toEqual([]);
    await page.getByRole('button', { name: 'Confirm and apply' }).click();
    const receipt = page.getByTestId('settings-change-receipt');
    await expect(receipt.getByText(scenario === 'success' ? 'Verified after applying' : 'Complete MFA in the target app', { exact: true })).toBeVisible();
    const id = await receipt.locator('code').textContent();
    expect(applied).toEqual(scenario === 'success' ? ['fixed-proxy'] : []);
    await receipt.getByRole('link', { name: 'System' }).click();
    await expect(receipt.locator('code')).toHaveText(id!);
    if (scenario === 'mfa') {
      await expect(receipt.getByText('Complete MFA in the target app', { exact: true })).toBeVisible();
      await expect(receipt.getByRole('link', { name: 'After completing MFA, check again' })).toHaveAttribute('href',
        /^\/settings\/operation\?network_question=[a-f0-9-]{36}$/u);
      await expect(receipt.getByText('Target verification: work · Complete MFA in the target app')).toBeVisible();
    }
    await receipt.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(new RegExp('/settings/operation\\?change=' + id));
    await expect(receipt.locator('code')).toHaveText(id!);
    expect(applied).toEqual(scenario === 'success' ? ['fixed-proxy'] : []);
  } finally {
    try { await page.unrouteAll({ behavior: 'wait' }); }
    finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  }
});
}

for (const entry of ['settings', 'system', 'logout'] as const) {
test(`fresh recovery is reachable from ${entry} and retains the original receipt`, async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t21-recovery-browser-'));
  const databasePath = join(root, 'ledger.sqlite');
  const credentialDirectory = join(root, 'credentials');
  const db = openDatabase(databasePath);
  let time = Date.parse('2026-11-17T07:00:00.000Z');
  const now = () => new Date(time);
  let fixed = false;
  let interrupt = true;
  let applies = 0;
  let restores = 0;
  const paths: string[] = [];
  const inputs: unknown[] = [];
  const policy = parseNetworkPolicy({ schema_version: '1.0', device_id: 'fixture-mac', revision: 1,
    targets: [{ id: 'hub', role: 'hub' }, { id: 'work', role: 'target' }, { id: 'peer', role: 'peer' }],
    vpn_paths: [], repairs: [{ id: 'fixed-dns', kind: 'refresh_dns', target: 'work' }],
    limits: { maximum_attempts: 1, cooldown_ms: 5_000, deadline_ms: 5_000 }, fallback: 'none' });
  try {
    db.prepare("INSERT INTO accounts VALUES ('owner',1,1,?)").run(now().toISOString());
    const credentials = createCredentialStore(credentialDirectory, now);
    const session = issueCallerSession(db, { accountId: 'owner', callerId: 'web', domain: 'personal', permissions: ['owner'] }, now, credentials);
    await page.context().addCookies([{ name: 'patrick_session', value: session.token, url: 'http://localhost', httpOnly: true, sameSite: 'Strict' }]);
    const configuration = { databasePath, credentialDirectory, now, networkRepair: {
      policy, accountId: 'owner', domain: 'personal', localDeviceId: policy.device_id,
      observe: async ({ targetIds }: { targetIds: readonly string[] }) => {
        if (fixed && interrupt) { interrupt = false; time += 5_001; }
        return targetIds.map((targetId) => ({ targetId, problem: targetId === 'work' && !fixed ? 'dns' as const : 'healthy' as const }));
      },
      actuator: { readRule: async () => (fixed ? 'b' : 'a').repeat(64),
        apply: async () => { fixed = true; applies += 1; return { state: 'changed' as const, revision: 'b'.repeat(64) }; },
        restore: async () => { restores += 1; return 'unknown' as const; } },
    } };
    let app = createApp(configuration);
    const headers = { authorization: session['authorization'], origin: ORIGIN, 'content-type': 'application/json' };
    const post = (path: string, id: string, revision: number, payload: Json) => app.request('/api/v1' + path, {
      method: 'POST', headers, body: JSON.stringify({ client_request_id: id, expected_revision: revision, payload,
        payload_hash: createHash('sha256').update(canonicalPayload(payload)).digest('hex') }),
    });
    const draft = { operation: 'repair_network', domain: 'personal', target: policy.device_id, input: { target_id: 'work', repair_id: 'fixed-dns' } };
    const validation = await post('/settings/validations', 'seed-validation', 0, draft);
    expect(validation.status).toBe(200);
    const { data: { validation_id } } = await validation.json() as { data: { validation_id: string } };
    const auth = await app.request('/api/v1/auth/challenge', { method: 'POST', headers, body: JSON.stringify({ rp_id: RP_ID }) });
    const { challenge_id } = await auth.json() as { challenge_id: string };
    const prepared = await post('/settings/control-proposals', 'seed-control', 0, { draft, validation_id, challenge_id });
    const { data: proposal } = await prepared.json() as { data: { proposal_id: string; proposal_hash: string; base_revision: number } };
    expect((await post('/control-proposals/' + proposal.proposal_id + '/confirm', 'seed-confirm', proposal.base_revision,
      { proposal_hash: proposal.proposal_hash, challenge_id })).status).toBe(202);
    const { receipt_id } = db.prepare('SELECT receipt_id FROM control_receipts WHERE proposal_id=?').get(proposal.proposal_id) as { receipt_id: string };
    const applied = await post('/settings/changes', 'seed-apply', 0, { draft, validation_id, control_receipt_id: receipt_id });
    const { command_id: changeId } = await applied.json() as { command_id: string };
    const stored = db.prepare('SELECT receipt FROM settings_changes').get() as { receipt: string };
    db.prepare("UPDATE settings_changes SET phase='uncertain',receipt=?").run(JSON.stringify({ ...JSON.parse(stored.receipt), phase: 'uncertain' }));
    time += 120_001;
    app = createApp(configuration);
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith('/events')) return route.fulfill({ status: 503, body: '' });
      const body = request.postData();
      if (request.method() === 'POST') {
        paths.push(path);
        if (path.endsWith('/settings/validations') && body) inputs.push((JSON.parse(body) as { payload: unknown }).payload);
      }
      const response = await app.request(request.url(), { method: request.method(), headers: await request.allHeaders(), ...(body ? { body } : {}) });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    await page.goto((entry === 'system' ? '/system' : '/settings/operation') + '?change=' + changeId);
    const receipt = page.getByTestId('settings-change-receipt');
    await expect(receipt.getByRole('heading', { name: 'Check interrupted network change', exact: true }).first()).toBeVisible();
    expect(paths).toEqual([]);
    await receipt.getByLabel('Registered target').selectOption({ label: 'work / fixed-dns · fixture-mac' });
    await receipt.getByRole('button', { name: 'Continue' }).click();
    await expect(receipt.getByText('Validation passed')).toBeVisible();
    expect(inputs).toEqual([{ operation: 'reconcile_network', domain: 'personal', target: policy.device_id, input: { change_id: changeId } }]);
    await receipt.getByRole('button', { name: 'Continue' }).click();
    if (entry === 'logout') {
      await expect(receipt.getByRole('button', { name: 'Confirm and check' })).toBeVisible();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Confirm and check' })).toHaveCount(0);
      expect(paths.some((path) => path.endsWith('/recovery'))).toBe(false);
      expect([applies, restores]).toEqual([1, 0]);
      return;
    }
    await receipt.getByRole('button', { name: 'Confirm and check' }).click();
    await expect(receipt.getByText('Verified after applying', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp('change=' + changeId));
    await expect(receipt.locator('code')).toHaveText(changeId);
    expect(paths).toContain('/api/v1/settings/changes/' + changeId + '/recovery');
    expect(paths).not.toContain('/api/v1/settings/changes');
    expect([applies, restores]).toEqual([1, 0]);
    await receipt.getByRole('link', { name: entry === 'settings' ? 'System' : 'Settings', exact: true }).click();
    await expect(receipt.locator('code')).toHaveText(changeId);
    await expect(receipt.getByText('Verified after applying', { exact: true })).toBeVisible();
    if (entry === 'system') {
      db.prepare("UPDATE settings_changes SET phase='uncertain',receipt=?").run(JSON.stringify({
        ...JSON.parse(stored.receipt), phase: 'uncertain',
      }));
      db.prepare('UPDATE network_repair_attempts SET changed_rule=NULL').run();
      await page.reload();
      await expect(receipt.getByText('An effect may still be running. The device remains locked.')).toBeVisible();
      await expect(receipt.getByRole('button', { name: 'Confirm and check' })).toHaveCount(0);
    }
  } finally {
    try { await page.unrouteAll({ behavior: 'wait' }); }
    finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  }
});
}
