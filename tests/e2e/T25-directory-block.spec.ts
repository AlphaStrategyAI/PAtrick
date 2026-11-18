import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openDatabase } from '@patrick/storage';
import { createCredentialStore } from '@patrick/host';
import { issueCallerSession } from '../../apps/service/src/auth.js';
import { createApp } from '../../apps/service/src/app.js';

test('an existing folder shows its saved status and blocked reader in list and detail', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-block-ui-'));
  const databasePath = join(dir, 'state.sqlite'); const credentialDirectory = join(dir, 'credentials');
  const now = () => new Date('2026-11-17T05:00:00.000Z');
  const db = openDatabase(databasePath);
  try {
    db.prepare("INSERT INTO accounts VALUES ('owner',1,1,?)").run(now().toISOString());
    db.prepare(`INSERT INTO source_configs VALUES ('legacy','owner','personal','directory','/synthetic/old','/synthetic/old',
      '{}','[]',NULL,'poll','none',0,1,'enabled',1,'1.0',?,?)`).run(now().toISOString(), now().toISOString());
    db.prepare(`INSERT INTO source_configs VALUES ('paused','owner','personal','directory','/synthetic/paused','/synthetic/paused',
      '{}','[]',NULL,'poll','none',0,0,'paused',2,'1.0',?,?)`).run(now().toISOString(), now().toISOString());
    db.prepare("INSERT INTO collection_receipts VALUES ('old-receipt','legacy',1,'first_collection','sweep:1',1,NULL,?,1,NULL)").run(now().toISOString());
    const credentials = createCredentialStore(credentialDirectory, now);
    const { token } = issueCallerSession(db, { accountId: 'owner', callerId: 'web', domain: 'personal', permissions: ['owner'] }, now, credentials);
    await page.context().addCookies([{ name: 'patrick_session', value: token, url: 'http://localhost', httpOnly: true, sameSite: 'Strict' }]);
    const app = createApp({ databasePath, credentialDirectory, now });
    let capabilityRequests = 0;
    let capabilityUnavailable = false;
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      if (request.url().includes('/api/v1/source-reader-capabilities')) {
        capabilityRequests++;
        if (capabilityUnavailable) return route.fulfill({ status: 503, body: '' });
      }
      if (request.url().includes('/api/v1/events')) return route.fulfill({ status: 503, body: '' });
      const body = request.postData();
      const response = await app.request(request.url(), { method: request.method(), headers: await request.allHeaders(), ...(body ? { body } : {}) });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    await page.goto('/settings/collection');
    const list = page.locator('main li').filter({ hasText: '/synthetic/old' });
    await expect(list).toContainText('Enabled');
    await expect(list).toContainText('Directory reading is temporarily unavailable.', { timeout: 5000 });
    const paused = page.locator('main li').filter({ hasText: '/synthetic/paused' });
    await expect(paused).toContainText('Paused');
    await expect(paused).toContainText('Directory reading is temporarily unavailable.');
    await list.getByRole('button', { name: '/synthetic/old' }).click();
    const detail = page.getByRole('region', { name: 'Source details' });
    await expect(detail).toContainText('Enabled');
    await expect(detail).toContainText('Directory reading is temporarily unavailable.');
    await expect(detail).toContainText('Wait for a trusted reader');
    await expect(detail).toContainText('First successful collection');
    expect(capabilityRequests).toBe(1);
    await paused.getByRole('button', { name: '/synthetic/paused' }).click();
    await expect(detail).toContainText('Paused');
    await expect(detail).toContainText('Directory reading is temporarily unavailable.');
    expect(capabilityRequests).toBe(1);
    await page.reload();
    await expect(page.locator('main li').filter({ hasText: '/synthetic/old' })).toContainText('Directory reading is temporarily unavailable.');
    capabilityUnavailable = true;
    await page.getByRole('button', { name: 'Refresh status' }).click();
    await expect(page.locator('main li').filter({ hasText: '/synthetic/old' })).toContainText('Directory reading status is unavailable.');
    await page.locator('main li').filter({ hasText: '/synthetic/old' }).getByRole('button').click();
    await expect(page.getByRole('region', { name: 'Source details' })).toContainText('Directory reading status is unavailable.');
    capabilityUnavailable = false;
    await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh');
    await page.reload();
    await expect(page.locator('main li').filter({ hasText: '/synthetic/old' })).toContainText('目录读取暂不可用。');
    await page.locator('main li').filter({ hasText: '/synthetic/old' }).getByRole('button').click();
    await expect(page.getByRole('region', { name: '来源详情' })).toContainText('请等待可信读取能力可用');
    expect(db.prepare("SELECT status,config_revision FROM source_configs WHERE source_id='legacy'").get()).toEqual({ status: 'enabled', config_revision: 1 });
    expect(db.prepare("SELECT status,config_revision FROM source_configs WHERE source_id='paused'").get()).toEqual({ status: 'paused', config_revision: 2 });
    expect(db.prepare('SELECT event_id FROM collection_receipts').all()).toEqual([{ event_id: 'old-receipt' }]);
  } finally { await page.unrouteAll({ behavior: 'wait' }); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

async function readerFixture(page: Page) {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-block-freshness-'));
  const databasePath = join(dir, 'state.sqlite'); const credentialDirectory = join(dir, 'credentials');
  const now = () => new Date('2026-11-17T05:00:00.000Z');
  const db = openDatabase(databasePath);
  db.prepare("INSERT INTO accounts VALUES ('owner',1,1,?)").run(now().toISOString());
  db.prepare(`INSERT INTO source_configs VALUES ('legacy','owner','personal','directory','/synthetic/old','/synthetic/old',
    '{}','[]',NULL,'poll','none',0,1,'enabled',1,'1.0',?,?)`).run(now().toISOString(), now().toISOString());
  const credentials = createCredentialStore(credentialDirectory, now);
  const { token } = issueCallerSession(db, { accountId: 'owner', callerId: 'web', domain: 'personal', permissions: ['owner'] }, now, credentials);
  await page.context().addCookies([{ name: 'patrick_session', value: token, url: 'http://localhost', httpOnly: true, sameSite: 'Strict' }]);
  const app = createApp({ databasePath, credentialDirectory, now });
  let requests = 0;
  let deliveries = 0;
  let hold = false;
  const pending: Array<() => void> = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const capability = request.url().includes('/api/v1/source-reader-capabilities');
    if (capability) {
      requests++;
      if (hold) await new Promise<void>((resolve) => pending.push(resolve));
    }
    if (request.url().includes('/api/v1/events')) return route.fulfill({ status: 503, body: '' });
    const body = request.postData();
    const response = await app.request(request.url(), { method: request.method(), headers: await request.allHeaders(), ...(body ? { body } : {}) });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    if (capability) deliveries++;
  });
  return {
    requests: () => requests,
    deliveries: () => deliveries,
    hold: (value: boolean) => { hold = value; },
    release: () => { for (const resolve of pending.splice(0)) resolve(); },
    async close() { for (const resolve of pending.splice(0)) resolve(); await page.unrouteAll({ behavior: 'wait' }); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('directory capability expires without a manual refresh while the next request hangs', async ({ page }) => {
  await page.clock.install();
  const f = await readerFixture(page);
  try {
    await page.goto('/settings/collection');
    const row = page.locator('main li').filter({ hasText: '/synthetic/old' });
    await expect(row).toContainText('Directory reading is temporarily unavailable.');
    expect(f.requests()).toBe(1);
    f.hold(true);
    await page.clock.fastForward(10_001);
    await expect.poll(f.requests).toBe(2);
    await page.clock.fastForward(30_001);
    await expect(row).toContainText('Directory reading status is unavailable.');
    f.release();
  } finally { await f.close(); }
});

test('an actually delivered capability reply cannot become fresh after its request lifetime', async ({ page }) => {
  await page.clock.install();
  const f = await readerFixture(page);
  try {
    await page.goto('/settings/collection');
    const row = page.locator('main li').filter({ hasText: '/synthetic/old' });
    await expect(row).toContainText('Directory reading is temporarily unavailable.');
    f.hold(true);
    await page.clock.fastForward(10_001);
    await expect.poll(f.requests).toBe(2);
    const later = await page.evaluate(() => Date.now() + 30_001);
    await page.clock.setSystemTime(later);
    const response = page.waitForResponse((item) => item.url().includes('/api/v1/source-reader-capabilities'));
    f.release();
    await response;
    await expect.poll(f.deliveries).toBe(2);
    await page.clock.runFor(1);
    await expect(row).toContainText('Directory reading status is unavailable.');
  } finally { await f.close(); }
});

test('returning to the page and reconnecting revalidates before showing directory capability', async ({ page }) => {
  const f = await readerFixture(page);
  try {
    await page.goto('/settings/collection');
    const row = page.locator('main li').filter({ hasText: '/synthetic/old' });
    await expect(row).toContainText('Directory reading is temporarily unavailable.');
    expect(f.requests()).toBe(1);
    f.hold(true);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(f.requests).toBeGreaterThanOrEqual(2);
    await expect(row).toContainText('Directory reading status is unavailable.');
    f.hold(false); f.release();
    await expect(row).toContainText('Directory reading is temporarily unavailable.');
    await page.context().setOffline(true);
    await expect(row).toContainText('Directory reading status is unavailable.');
    const before = f.requests();
    await page.context().setOffline(false);
    await expect.poll(f.requests).toBeGreaterThan(before);
    await expect(row).toContainText('Directory reading is temporarily unavailable.');
  } finally { await page.context().setOffline(false); await f.close(); }
});
