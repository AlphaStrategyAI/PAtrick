import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openDatabase } from '@patrick/storage';
import { createCredentialStore } from '@patrick/host';
import { connectVault, requireVault } from '@patrick/integrations/vault/connection';
import { issueCallerSession } from '../../apps/service/src/auth.js';
import { createApp } from '../../apps/service/src/app.js';

async function setup(page: Page, withVault = false) {
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
  const { token } = issueCallerSession(db, { accountId: 'owner', callerId: 'web', domain: 'personal', permissions: ['owner'] }, now, credentials);
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
