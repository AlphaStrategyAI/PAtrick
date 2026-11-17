import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createApp } from '../../apps/service/src/app.js';
import { issueCallerSession } from '../../apps/service/src/auth.js';
import { createCredentialStore } from '../../packages/host/src/credentials.js';
import { openDatabase } from '../../packages/storage/src/database.js';
import { createProjectionCursorCodec } from '../../packages/storage/src/views/cursors.js';
import { createWorkProjection } from '../../packages/storage/src/views/work.js';
import { createStatsProjection } from '../../packages/storage/src/views/stats.js';

test('Stats uses verified scope snapshots; date filters and localized presentation do not submit business commands', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t19-browser-'));
  const databasePath = join(root, 'stats.sqlite');
  const credentialDirectory = join(root, 'creds');
  const now = () => new Date('2025-03-10T12:00:00.000Z');
  const at = now().toISOString();
  const credentials = createCredentialStore(credentialDirectory, now);
  const db = openDatabase(databasePath);
  const scope = { accountId: 'owner', callerId: 'web', dataDomain: 'personal', permissionEpoch: 1,
    permissionDigest: 'a'.repeat(64), sessionDigest: 'b'.repeat(64) };
  try {
    db.prepare("INSERT INTO accounts VALUES ('owner',1,1,?)").run(at);
    const session = issueCallerSession(db, { accountId: 'owner', callerId: 'web', domain: 'personal', permissions: ['owner'] }, now, credentials);
    await page.context().addCookies([{ name: 'patrick_session', value: session.token, url: 'http://localhost', httpOnly: true, sameSite: 'Strict' }]);
    db.prepare(`INSERT INTO answer_receipts (receipt_id,intent_id,account_id,data_domain,question_id,question_version,work_id,generation,
      validity,disposition,hub_answer_event_id,result_revision,missing_json,schema_version,created_at)
      VALUES ('r','i','owner','personal','q',1,'waiting',1,'verified','proceed','answer-09',1,'[]','1.0',?)`).run(at);
    db.prepare(`INSERT INTO domain_events (event_id,aggregate_id,aggregate_version,account_id,data_domain,schema_version,payload,created_at)
      VALUES ('answer-event','q',1,'owner','personal','1.0',?,?)`).run(
      JSON.stringify({ type: 'answer.verified', work_id: 'waiting', generation: 1, question_id: 'q', answer_event_id: 'answer-09' }), at);
    db.prepare("INSERT INTO projection_cursors VALUES ('local',0,1,?)").run(at);
    const { bytes } = db.prepare("SELECT bytes FROM product_view_keys WHERE name='cursor'").get() as { bytes: Buffer };
    const work = createWorkProjection(db, createProjectionCursorCodec(bytes));
    work.apply(scope, { watermark: { hub_seq: 6, domain_seq: 1 }, at, coverage: 'fresh',
      items: [{ work_id: 'waiting', generation: 1, updated_at: at, state: 'awaiting_answer',
        attempt_ids: [], question_id: 'q', delivery_id: null }] });
    // Synthetic producer continuity only in this isolated fixture; other metrics remain unknown.
    db.prepare(`INSERT INTO stats_producer_coverage (account_id,data_domain,kind,producer,work_epoch,domain_seq,hub_seq,
      available_since,verified_through,complete_history,evidence_sha256)
      VALUES ('owner','personal','owner_decision','answer_gate',1,1,6,'2025-02-01T00:00:00.000Z',?,1,?)`)
      .run(at, 'e'.repeat(64));
    expect(createStatsProjection(db).refresh(scope, now())).toBe(true);
    const app = createApp({ databasePath, credentialDirectory, now });
    const reads: string[] = [];
    let mutationCount = 0;
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== 'GET') mutationCount += 1;
      if (url.pathname.endsWith('/stats')) reads.push(url.searchParams.get('period') + ':' + url.searchParams.get('timezone'));
      if (url.pathname.endsWith('/events')) { await route.fulfill({ status: 503, body: '' }); return; }
      const response = await app.request(request.url(), { method: request.method(), headers: await request.allHeaders() });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });

    await page.goto('/stats');
    await expect(page.getByRole('heading', { name: 'Owner decisions' }).locator('..')).toContainText('1');
    await expect(page.getByRole('heading', { name: 'Automatic decisions' }).locator('..')).toContainText('—');
    await expect(page.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Last 30 days' }).click();
    await expect.poll(() => reads).toContain('30d:America/New_York');
    const snap = page.locator('.stats-view time').first();
    await expect(snap).toHaveAttribute('datetime', at);
    await page.getByRole('button', { name: 'All time' }).click();
    await expect.poll(() => reads).toContain('all:America/New_York');
    await expect(page.getByRole('heading', { name: 'Owner decisions' }).locator('..')).toContainText('1');

    const priorReads = reads.length;
    await page.getByRole('combobox', { name: 'Language' }).selectOption('zh');
    await expect(page.getByRole('button', { name: '全部时间' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('heading', { name: '主人决策' }).locator('..')).toContainText('1');
    expect(reads.length).toBe(priorReads);
    work.apply(scope, { watermark: { hub_seq: 6, domain_seq: 1 }, at, coverage: 'stale',
      items: [{ work_id: 'waiting', generation: 1, updated_at: at, state: 'awaiting_answer',
        attempt_ids: [], question_id: 'q', delivery_id: null }] });
    await page.reload();
    await expect(page.getByText('暂时无法更新，保留上次已核验的快照。', { exact: false })).toBeVisible();
    await expect(page.locator('.stats-view time').first()).toHaveAttribute('datetime', at);
    await expect(page.getByRole('heading', { name: '主人决策' }).locator('..')).toContainText('1');

    const waiting = page.getByRole('link', { name: '等待决策: 1' });
    await waiting.click();
    await expect(page).toHaveURL(/\/work\?state=awaiting_answer$/u);
    await expect(page.locator('main select')).toHaveValue('awaiting_answer');
    expect(mutationCount).toBe(0);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an owner in another domain can open a restricted Stats page without losing the current session', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t19-browser-scope-'));
  const databasePath = join(root, 'stats.sqlite');
  const credentialDirectory = join(root, 'creds');
  const now = () => new Date('2025-03-10T12:00:00.000Z');
  const db = openDatabase(databasePath);
  try {
    db.prepare("INSERT INTO accounts VALUES ('limited',1,1,?)").run(now().toISOString());
    const credentials = createCredentialStore(credentialDirectory, now);
    issueCallerSession(db, { accountId: 'limited', callerId: 'web', domain: 'z-other', permissions: ['owner'] }, now, credentials);
    const session = issueCallerSession(db, { accountId: 'limited', callerId: 'web', domain: 'personal', permissions: ['work.read'] }, now, credentials);
    await page.context().addCookies([{ name: 'patrick_session', value: session.token, url: 'http://localhost', httpOnly: true, sameSite: 'Strict' }]);
    const app = createApp({ databasePath, credentialDirectory, now });
    const requests: string[] = [];
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      requests.push(url.pathname);
      if (url.pathname.endsWith('/events')) { await route.fulfill({ status: 503, body: '' }); return; }
      const response = await app.request(url, { method: request.method(), headers: await request.allHeaders() });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    await page.goto('/stats');
    await expect(page.getByText('Statistics are unavailable for this data scope.')).toBeVisible({ timeout: 3000 });
    expect(requests).not.toContain('/api/v1/stats');
    await page.locator('a[href="/work"]').first().click();
    await expect(page.locator('main select')).toHaveValue('open');
    expect(requests).toContain('/api/v1/work');
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
