import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openDatabase } from '@patrick/storage';
import { createCredentialStore } from '@patrick/host';
import { connectVault, requireVault } from '@patrick/integrations/vault/connection';
import { issueCallerSession } from '../../apps/service/src/auth.js';
import { createApp } from '../../apps/service/src/app.js';

async function setup(page: Page, withVault = false, permissions = ['owner']) {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t17-browser-'));
  const databasePath = join(dir, 't17.sqlite');
  const credentialDirectory = join(dir, 'cred');
  const now = () => new Date('2026-11-17T05:00:00.000Z');
  const db = openDatabase(databasePath);
  db.prepare("INSERT INTO accounts VALUES ('owner',1,1,?)").run(now().toISOString());
  if (withVault) {
    const root = join(dir, 'Vault');
    mkdirSync(root);
    await connectVault(db, { accountId: 'owner', deviceId: 'test-device', vaultId: 't17-browser-vault',
      root, domain: 'personal', captureHost: hostname(), now: now().toISOString() });
  }
  const credentials = createCredentialStore(credentialDirectory, now);
  const { token } = issueCallerSession(db, { accountId: 'owner', callerId: 'web', domain: 'personal', permissions }, now, credentials);
  await page.context().addCookies([{ name: 'patrick_session', value: token, url: 'http://localhost', httpOnly: true, sameSite: 'Strict' }]);
  const app = createApp({ databasePath, credentialDirectory, now });
  await page.route('**/api/v1/**', async (route) => {
    const browser = route.request();
    if (browser.url().includes('/api/v1/events')) {
      await route.fulfill({ status: 503, body: '' });
      return;
    }
    const body = browser.postData();
    const upstream = await app.request(browser.url(), {
      method: browser.method(), headers: await browser.allHeaders(), ...(body ? { body } : {}),
    });
    await route.fulfill({ status: upstream.status, headers: Object.fromEntries(upstream.headers), body: await upstream.text() });
  });
  return { db, async close() {
    try { if (!page.isClosed()) await page.unrouteAll({ behavior: 'wait' }); }
    finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  } };
}

test('account preferences read back after reload and a failed save keeps the local language', async ({ page }) => {
  const fx = await setup(page);
  try {
    await page.goto('/settings/preferences');
    const button = page.getByRole('button', { name: 'Save to account' });
    await expect(button).toBeEnabled();
    const pane = page.locator('main');
    await pane.getByRole('checkbox').check();
    const committed = page.waitForResponse((response) => response.url().endsWith('/api/v1/preferences') && response.request().method() === 'PATCH');
    await button.click();
    expect((await committed).status()).toBe(200);
    await expect(page.getByText('Saved to your account')).toBeVisible();
    await page.reload();
    await expect(button).toBeEnabled();
    await expect(pane.getByRole('checkbox')).toBeChecked();
    await page.route('**/api/v1/preferences', async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      await route.fulfill({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ code: 'UNAVAILABLE', params: {}, retryable: true, correlation_id: 'test-unavailable' }) });
    });
    await pane.getByRole('combobox').selectOption('zh');
    await page.getByRole('button', { name: '保存到账户' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(pane.getByRole('alert')).toBeVisible();
    expect(fx.db.prepare("SELECT revision FROM account_preferences WHERE account_id='owner'").get()).toEqual({ revision: 1 });
  } finally { await fx.close(); }
});

test('settings offer six groups and distinguish unconfigured host actions from the registered Vault handler', async ({ page }) => {
  const fx = await setup(page);
  try {
    await page.goto('/settings');
    await expect(page.locator('main nav a')).toHaveCount(6);
    await page.goto('/settings/materials');
    await expect(page.getByText('Connect a Vault: Available')).toBeVisible();
    await page.goto('/settings/operation');
    await expect(page.getByText('Check the host: Unavailable in this installation')).toBeVisible();
  } finally { await fx.close(); }
});

test('a registered Vault uses the three-step review before applying and shows the same receipt on System', async ({ page }) => {
  const fx = await setup(page, true);
  try {
    await page.goto('/settings/materials');
    await page.getByLabel('Registered target').selectOption(JSON.stringify(['t17-browser-vault', 'test-device']));
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Validation passed')).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    const confirm = page.getByRole('button', { name: 'Confirm and apply' });
    await expect(confirm).toBeVisible();
    expect(requireVault(fx.db, 't17-browser-vault').status).toBe('awaiting_confirmation');
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM control_receipts').get()).toEqual({ n: 0 });
    await confirm.click();
    const receipt = page.getByTestId('settings-change-receipt');
    await expect(receipt.getByText('Verified after applying')).toBeVisible();
    const id = await receipt.locator('code').textContent();
    expect(id).toMatch(/^settings_[a-f0-9-]{36}$/u);
    expect(requireVault(fx.db, 't17-browser-vault')).toMatchObject({ status: 'connected', connection_epoch: 1 });
    await receipt.getByRole('link', { name: 'System' }).click();
    await expect(receipt.locator('code')).toHaveText(id!);
    await expect(receipt.getByText('Verified after applying')).toBeVisible();
  } finally { await fx.close(); }
});

test('the first account read does not overwrite a language choice made while it is in flight', async ({ page }) => {
  const fx = await setup(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    await page.route('**/api/v1/preferences', async (route) => {
      if (route.request().method() === 'GET') await held;
      await route.fallback();
    });
    await page.goto('/settings/preferences');
    await page.locator('main').getByRole('combobox').selectOption('zh');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    release();
    await expect(page.getByRole('button', { name: '保存到账户' })).toBeEnabled();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    expect(fx.db.prepare("SELECT revision FROM account_preferences WHERE account_id='owner'").get()).toBeUndefined();
  } finally { release(); await fx.close(); }
});

test('Feishu setup reports unavailable ingress instead of asking for a secret on local HTTP', async ({ page }) => {
  const fx = await setup(page);
  try {
    await page.goto('/settings/interaction');
    const bot = page.getByRole('region', { name: 'Feishu bot' });
    await expect(bot.getByText('Not configured', { exact: true })).toBeVisible();
    await bot.getByText('Connection setup', { exact: true }).click();
    await expect(bot.getByText('Secure credential setup is unavailable in this installation.')).toBeVisible();
    await expect(bot.getByLabel('App Secret')).toHaveCount(0);
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM channel_connections').get()).toEqual({ n: 0 });
  } finally { await fx.close(); }
});

test('Feishu confirms the scoped pairing, previews the exact test and leaves delivery unverified without a transport', async ({ page }) => {
  const fx = await setup(page);
  try {
    const stamp = '2026-11-17T05:00:00.000Z';
    const id = 'conn_' + createHash('sha256').update('owner').digest('hex').slice(0, 12);
    fx.db.prepare(`INSERT INTO channel_connections (
      connection_id, account_id, data_domain, app_id, tenant_key, credential_ref, credential_version,
      config_revision, channel_incarnation, connection_epoch, binding_revision, current_pairing_id, status,
      transport_mode, schema_version, created_at, updated_at
    ) VALUES (?, 'owner', 'personal', 'cli_browser_fixture', 'tenant_fixture', 'cred_fixture', 1,
      1, 1, 1, 1, 'pair_fixture', 'needs_binding', 'probe', '1.0', ?, ?)`).run(id, stamp, stamp);
    fx.db.prepare(`INSERT INTO channel_pairings (
      pairing_id, connection_id, account_id, data_domain, code_hash, expires_at, candidate_open_id,
      candidate_chat_id, app_id, tenant_key, config_revision, credential_version, binding_revision, incarnation, epoch,
      status, schema_version, created_at
    ) VALUES ('pair_fixture', ?, 'owner', 'personal', ?, '2026-11-17T05:05:00.000Z', 'ou_browser_fixture',
      'oc_browser_fixture', 'cli_browser_fixture', 'tenant_fixture', 1, 1, 1, 1, 1, 'candidate', '1.0', ?)`).run(id, 'a'.repeat(64), stamp);
    await page.goto('/settings/interaction');
    const bot = page.getByRole('region', { name: 'Feishu bot' });
    await bot.getByText('Connection setup', { exact: true }).click();
    await expect(bot.getByText('Personal chat identity: ou_browser_fixture')).toBeVisible();
    await expect(bot.getByText('Data scope: personal')).toBeVisible();
    await bot.getByRole('button', { name: 'Confirm identity and data scope' }).click();
    await bot.getByRole('button', { name: 'Preview test' }).click();
    await expect(bot.getByText('PAtrick 连接测试，不含业务资料。')).toBeVisible();
    await expect(bot.getByText('Previewed; no message sent')).toBeVisible();
    await expect(bot.getByRole('button', { name: 'Send test message' })).toBeDisabled();
    await expect(bot.getByText('The supervised Feishu connection is not configured.')).toBeVisible();
    await page.reload();
    await bot.getByText('Connection setup', { exact: true }).click();
    await expect(bot.getByText('Previewed; no message sent')).toBeVisible();
    expect(fx.db.prepare('SELECT status, transport_mode FROM channel_connections').get()).toEqual({ status: 'needs_test', transport_mode: 'probe' });
    expect(fx.db.prepare('SELECT status, message_id, inbound_evidence FROM channel_tests').get()).toEqual({
      status: 'previewed', message_id: null, inbound_evidence: null,
    });
  } finally { await fx.close(); }
});


test('opening interaction settings does not revoke a session that cannot read channels', async ({ page }) => {
  const fx = await setup(page, false, ['settings.read']);
  try {
    const channelRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/channels/feishu')) channelRequests.push(request.url());
    });
    await page.goto('/settings/interaction');
    await expect(page.getByRole('region', { name: 'Feishu bot' })).toContainText('Feishu settings are unavailable with this permission.');
    await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
    expect(channelRequests).toEqual([]);
  } finally { await fx.close(); }
});
