import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createApp } from '../../apps/service/src/app.js';
import { issueCallerSession, ORIGIN } from '../../apps/service/src/auth.js';
import { createCredentialStore } from '../../packages/host/src/credentials.js';
import { openDatabase } from '../../packages/storage/src/database.js';

test('System previews a local notification digest and saves only the exact verified diagnostics attachment', async ({ page }) => {
  const temp = mkdtempSync(join(tmpdir(), 'patrick-t20-diag-browser-'));
  const databasePath = join(temp, 'domain.sqlite');
  const credentialDirectory = join(temp, 'credentials');
  const at = '2040-03-20T17:00:00.000Z';
  const now = () => new Date(at);
  const db = openDatabase(databasePath);
  try {
    db.prepare('INSERT INTO accounts VALUES (?,1,1,?)').run('test-account', at);
    db.prepare(`INSERT INTO product_view_checkpoints (account_id,data_domain,epoch,hub_seq,domain_seq,notification_seq,
      notification_floor,observed_at,trusted_as_of,freshness,health_payload) VALUES ('test-account','test-domain',1,1,2,3,0,?,?,'fresh',?)`)
      .run(at, at, JSON.stringify({ connections: { vault: { status: 'connected' }, feishu: null }, edits: { pending: 0, failed: 0 } }));
    const intent = db.prepare(`INSERT INTO notification_intents(intent_id,account_id,data_domain,object_id,event_version,kind,channel,
      auth_epoch,binding_hash,expires_at,status,updated_at) VALUES (?,'test-account','test-domain',?,1,?,'feishu',1,?,?,'digest',?)`);
    for (const kind of ['progress', 'delivered']) {
      intent.run('notice-' + kind, 'work-' + kind, kind, 'a'.repeat(64), '2040-03-21T17:00:00.000Z', at);
    }
    const before = db.prepare('SELECT intent_id,status,attempts,updated_at FROM notification_intents ORDER BY intent_id').all();
    const credentials = createCredentialStore(credentialDirectory, now);
    const session = issueCallerSession(db, { accountId: 'test-account', callerId: 'test-owner',
      domain: 'test-domain', permissions: ['owner'] }, now, credentials);
    await page.context().addCookies([{ name: 'patrick_session', value: session.token, url: ORIGIN, httpOnly: true, sameSite: 'Strict' }]);
    const app = createApp({ databasePath, credentialDirectory, now });
    let expectedHash: string | undefined;
    let expectedBytes: string | undefined;
    let exportCalls = 0;
    let notificationPreviews = 0;
    let downloadEvents = 0;
    page.on('download', () => { downloadEvents += 1; });
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname.endsWith('/events') || pathname.endsWith('/stream')) {
        await route.fulfill({ status: 503, body: '' }); return;
      }
      const body = request.postData();
      const response = await app.request(request.url(), { headers: await request.allHeaders(), method: request.method(),
        ...(body ? { body } : {}) });
      let reply = await response.text();
      if (pathname.endsWith('/notifications/preview')) notificationPreviews += 1;
      if (pathname.endsWith('/diagnostics/preview') && response.ok) expectedHash = JSON.parse(reply).manifest_hash as string;
      if (pathname.endsWith('/diagnostics/export') && response.ok) {
        exportCalls += 1;
        expectedBytes = reply;
        if (exportCalls === 1) reply += '\n';
      }
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: reply });
    });
    await page.goto('/system');
    const notifications = page.getByRole('region', { name: 'Notifications', exact: true });
    await expect(notifications.locator('dl dd')).toHaveText(['0', '0', '2', '0', '0', '0']);
    await notifications.getByRole('button', { name: 'Preview digest', exact: true }).click();
    const digest = notifications.getByRole('region', { name: 'Digest preview', exact: true });
    await expect(digest.getByText('This preview is local and sends no messages.', { exact: true })).toBeVisible();
    await expect(digest.locator('dl dd')).toHaveText(['1', '1']);
    expect(notificationPreviews).toBe(1);
    expect(exportCalls).toBe(0);
    expect(downloadEvents).toBe(0);
    const panel = page.getByRole('region', { name: 'Diagnostics' });
    await expect(panel.getByRole('button', { name: 'Download diagnostics' })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Preview diagnostics' }).click();
    await expect(panel.getByRole('heading', { name: 'Included in the download' })).toBeVisible();
    await expect(panel.getByText('Connected', { exact: true })).toBeVisible();
    expect(exportCalls).toBe(0);
    const button = panel.getByRole('button', { name: 'Download diagnostics' });
    await button.click();
    await expect(panel.getByRole('alert')).toBeVisible();
    expect(downloadEvents).toBe(0);
    const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
    expect(download.suggestedFilename()).toBe('patrick-diagnostics.json');
    const bytes = readFileSync(await download.path());
    expect(bytes.toString()).toBe(expectedBytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expectedHash);
    expect(exportCalls).toBe(2);
    expect(downloadEvents).toBe(1);
    expect(db.prepare('SELECT intent_id,status,attempts,updated_at FROM notification_intents ORDER BY intent_id').all()).toEqual(before);
    for (const table of ['notification_attempts', 'outbox', 'domain_events']) {
      expect(db.prepare('SELECT COUNT(*) AS n FROM ' + table).get()).toEqual({ n: 0 });
    }
  } finally {
    if (!page.isClosed()) await page.unrouteAll({ behavior: 'wait' });
    db.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
