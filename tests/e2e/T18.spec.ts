import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openDatabase } from '@patrick/storage';
import { createCredentialStore } from '@patrick/host';
import type { RegistryOptions } from '@patrick/integrations/sources/registry';
import { issueCallerSession } from '../../apps/service/src/auth.js';
import { createApp } from '../../apps/service/src/app.js';

const approved = 'https://feed.example.test/updates';

async function setup(page: Page) {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t18-browser-'));
  const databasePath = join(dir, 't18.sqlite');
  const credentialDirectory = join(dir, 'creds');
  const now = () => new Date('2026-11-17T05:00:00.000Z');
  const db = openDatabase(databasePath);
  db.prepare("INSERT INTO accounts VALUES ('owner',1,1,?)").run(now().toISOString());
  const credentials = createCredentialStore(credentialDirectory, now);
  const { token } = issueCallerSession(db, { accountId: 'owner', callerId: 'web', domain: 'personal', permissions: ['owner'] }, now, credentials);
  await page.context().addCookies([{ name: 'patrick_session', value: token, url: 'http://localhost', httpOnly: true, sameSite: 'Strict' }]);
  const visits: string[] = [];
  const controller = new AbortController();
  let resume!: () => void;
  const waitForFirst = new Promise<void>((release) => { resume = release; });
  const httpSources: NonNullable<RegistryOptions['http']> = {
    approvedUrls: (actor, target, kind) => actor.accountId === 'owner' && actor.dataDomain === 'personal' &&
      target === approved && kind === 'rss' ? [approved] : null,
    port: {
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      async request(url) {
        visits.push(url.href);
        if (visits.length === 2) await waitForFirst;
        return { status: 200, location: null, contentType: 'application/rss+xml',
          bytes: new TextEncoder().encode('<rss><channel><item><guid>example</guid><title>News</title><pubDate>Sun, 15 Nov 2026 12:00:00 +0000</pubDate></item></channel></rss>') };
      },
    },
  };
  const app = createApp({ databasePath, credentialDirectory, now, httpSources,
    httpSourceWorker: { signal: controller.signal, pollMs: 100 } });
  await page.route('**/api/v1/**', async (route) => {
    const browser = route.request();
    if (browser.url().includes('/api/v1/events')) {
      await route.fulfill({ status: 503, body: '' });
      return;
    }
    const body = browser.postData();
    const upstream = await app.request(browser.url(), { method: browser.method(),
      headers: await browser.allHeaders(), ...(body ? { body } : {}) });
    await route.fulfill({ status: upstream.status, headers: Object.fromEntries(upstream.headers), body: await upstream.text() });
  });
  return { db, resume, visits, async close() {
    controller.abort();
    resume();
    try { if (!page.isClosed()) await page.unrouteAll({ behavior: 'wait' }); }
    finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  } };
}

test('previews an approved feed, applies an exact confirmed configuration and shows separate first collection', async ({ page }) => {
  const fx = await setup(page);
  try {
    await page.goto('/settings/collection');
    const main = page.locator('main');
    await expect(main.getByText('No sources are registered yet.')).toBeVisible();
    const url = main.getByLabel('Target URL');
    const preview = main.getByRole('button', { name: 'Preview source' });
    await url.fill('https://not-registered.example.test/');
    await preview.click();
    await expect(main.getByRole('alert')).toBeVisible();
    expect(fx.visits).toEqual([]);
    await url.fill(approved);
    await preview.click();
    await expect(main.getByText('Samples: 1')).toBeVisible();
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM source_configs').get()).toEqual({ n: 0 });
    await main.getByLabel('Collection frequency').selectOption('1h');
    await main.getByLabel('Registered target').selectOption({ label: approved });
    const next = main.getByRole('button', { name: 'Continue' });
    await next.click();
    await expect(main.getByText('Validation passed')).toBeVisible();
    await next.click();
    const confirm = main.getByRole('button', { name: 'Confirm and apply' });
    await expect(confirm).toBeVisible();
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM source_configs').get()).toEqual({ n: 0 });
    await confirm.click();
    const receipt = main.getByTestId('settings-change-receipt');
    await expect(receipt.getByText('Verified after applying')).toBeVisible();
    await main.getByRole('button', { name: approved }).click();
    const log = main.getByRole('region', { name: 'Source details' });
    await expect(log.getByText('Enable source', { exact: false })).toBeVisible();
    await expect(log.getByText('First successful collection', { exact: false })).toHaveCount(0);
    await expect.poll(() => fx.visits.length).toBe(2);
    fx.resume();
    await expect.poll(() => fx.db.prepare("SELECT COUNT(*) AS n FROM collection_receipts WHERE kind='first_collection'").get()).toEqual({ n: 1 });
    await main.getByRole('button', { name: 'Refresh status' }).click();
    await expect(log.getByText('First successful collection', { exact: false })).toBeVisible();
    expect(fx.visits).toEqual([approved, approved]);
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM source_revisions').get()).toEqual({ n: 0 });
    await log.getByText('Import RSS history', { exact: true }).click();
    await log.getByLabel('From (UTC, inclusive)').fill('2026-11-14T00:00');
    await log.getByLabel('Until (UTC, exclusive)').fill('2026-11-17T00:00');
    await log.getByRole('button', { name: 'Preview history' }).click();
    await expect(log.getByText('Items selected: 1 / 50')).toBeVisible();
    await expect(log.getByText('Additional network requests: 0')).toBeVisible();
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM source_revisions').get()).toEqual({ n: 0 });
    await log.getByLabel('Registered target').selectOption({ label: approved });
    await log.getByRole('button', { name: 'Continue' }).click();
    await expect(log.getByText('Validation passed')).toBeVisible();
    await log.getByRole('button', { name: 'Continue' }).click();
    await log.getByRole('button', { name: 'Confirm and apply' }).click();
    await expect(main.getByText('Imported items: 1', { exact: false })).toBeVisible();
    await page.reload();
    await expect(main.getByText('Imported items: 1', { exact: false })).toBeVisible();
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM source_revisions').get()).toEqual({ n: 1 });
    expect(fx.db.prepare('SELECT cursor FROM source_cursors').get()).toEqual({ cursor: 'sweep:1' });
    expect(fx.visits).toEqual([approved, approved]);
  } finally { await fx.close(); }
});
