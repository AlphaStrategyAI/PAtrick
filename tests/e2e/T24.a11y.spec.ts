/// <reference lib="dom" />
import { expect, test as base, type Page } from '@playwright/test';
import rendering from '../../apps/web/rendering.lock.json' with { type: 'json' };
import { t15Fixture } from './T15-fixture.js';

type Fixture = Awaited<ReturnType<typeof t15Fixture>>;
const test = base.extend<{ service: Fixture }>({
  service: [async ({ page }, use) => {
    const service = await t15Fixture();
    try {
      const at = '2026-11-17T05:00:00.000Z';
      service.db.prepare(`INSERT INTO vaults (vault_id,source_id,account_id,data_domain,capture_host,root_path,isolation_root,
        root_identity,physical_root,scope_hash,config_revision,connection_epoch,status,schema_version,created_at,updated_at)
        VALUES ('t24-vault','t24-source','owner','personal','fixture','/synthetic/vault','/synthetic/isolated',
          'synthetic-id','/synthetic/vault',?,1,1,'needs_permission','1.0',?,?)`).run('a'.repeat(64), at, at);
      await service.signIn(page);
      // The persisted projection is initially unknown while the local worker observes its Hub.
      await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/system/health?domain=personal')).json()))
        .toMatchObject({ freshness: 'fresh', data: { service: 'running', freshness: 'fresh', impact: 'vault_needs_permission' } });
      await use(service);
    } finally {
      await page.close();
      await service.close();
    }
  }, { auto: true }],
});
test('a fresh health read waits for its event connection before showing running', async ({ page, service }) => {
  const connection = service.holdNextRead('/api/v1/events');
  try {
    const health = page.waitForResponse(response => response.url().includes('/api/v1/system/health') && response.ok());
    await page.goto('/settings/preferences');
    expect(await (await health).json()).toMatchObject({ freshness: 'fresh', data: { service: 'running', freshness: 'fresh' } });
    await connection.ready;
    const brand = page.locator('.desktop-sidebar .brand');
    await expect(brand.locator('.logo-runner')).toHaveCount(0);
    await expect(brand.getByRole('status')).toHaveText('Status unknown');
    connection.release();
    await expect(brand.getByRole('status')).toHaveText('Running');
    await expect(brand.locator('.logo-runner')).toHaveCSS('animation-play-state', 'running');
    service.disconnectEvents();
    await expect(brand.getByRole('status')).toHaveText('Connection lost');
    await expect(brand.locator('time')).toBeVisible();
    await expect(brand.locator('.logo-runner')).toHaveCount(0);
  } finally {
    connection.release();
  }
});

test('the 4.8s orbit repeats without updating the live status while a decision waits', async ({ page }, info) => {
  await page.goto('/decisions');
  await expect(page.getByTestId('decision-Q-017')).toBeVisible();
  const brand = page.locator('.desktop-sidebar .brand');
  const logo = brand.locator('.curious-logo');
  const runner = logo.locator('.logo-runner');
  await expect(brand.getByRole('status')).toHaveText('Running');
  await expect(logo).toHaveCSS('width', '80px');
  await expect(logo).toHaveCSS('height', '80px');
  await expect(logo.getByRole('img', { name: 'PAtrick' })).toHaveCSS('width', '68px');
  await expect(logo.getByRole('img', { name: 'PAtrick' })).toHaveCSS('height', '68px');
  await expect(logo.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await expect(logo.locator('[aria-live], [role=status]')).toHaveCount(0);
  await expect(runner).toHaveCSS('animation-duration', '4.8s');
  await expect(runner).toHaveCSS('animation-iteration-count', 'infinite');
  const playback = await brand.evaluate(async element => {
    const status = element.querySelector('[role=status]')!;
    const runner = element.querySelector('.logo-runner')!;
    let updates = 0;
    const observer = new MutationObserver(records => { updates += records.length; });
    observer.observe(status, { subtree: true, characterData: true, childList: true, attributes: true });
    try {
      const nextIteration = () => new Promise<number>(resolve => runner.addEventListener('animationiteration',
        event => resolve((event as AnimationEvent).elapsedTime), { once: true }));
      const first = await nextIteration();
      const second = await nextIteration();
      return { first, second, updates };
    } finally {
      observer.disconnect();
    }
  });
  expect(playback.second - playback.first).toBeCloseTo(4.8, 3);
  expect(playback.updates).toBe(0);
  await info.attach('playback', { body: JSON.stringify(playback), contentType: 'application/json' });
  await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh');
  await expect(brand.getByRole('status')).toHaveText('运行中');
  await expect(brand.getByRole('status')).toBeVisible();
});

test('system and local motion preferences keep a static available mark', async ({ page, service }) => {
  await page.goto('/settings/preferences');
  const brand = page.locator('.desktop-sidebar .brand');
  const runner = brand.locator('.logo-runner');
  const reduced = page.getByRole('checkbox', { name: 'Reduce motion' });
  await expect(brand.getByRole('status')).toHaveText('Running');
  await expect(runner).toHaveCSS('animation-play-state', 'running');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(runner).toHaveCount(0);
  await expect(brand.getByRole('img', { name: 'PAtrick' })).toBeVisible();
  await expect(brand.getByRole('status')).toHaveText('Running');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(runner).toHaveCSS('animation-play-state', 'running');
  await reduced.check();
  await expect(runner).toHaveCount(0);
  await expect(brand.getByRole('status')).toHaveText('Running');
  await reduced.uncheck();
  await expect(runner).toHaveCSS('animation-play-state', 'running');
  expect(service.requests.some(r => r.path === '/api/v1/system/health' && r.status === 200)).toBe(true);
});

async function simulatePageVisibility(page: Page, hidden: boolean) {
  await page.evaluate(value => {
    Object.defineProperty(document, 'hidden', { configurable: true, value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('a visibilitychange pauses and resumes the existing orbit phase', async ({ page }) => {
  await page.goto('/settings/preferences');
  const runner = page.locator('.desktop-sidebar .logo-runner');
  await expect(runner).toHaveCSS('animation-play-state', 'running');
  const phase = () => runner.evaluate(el => Number(el.getAnimations()[0]?.currentTime));
  await expect.poll(phase).toBeGreaterThan(100);
  const animation = await runner.evaluateHandle(el => el.getAnimations()[0]);
  await simulatePageVisibility(page, true);
  await expect(runner).toHaveCSS('animation-play-state', 'paused');
  await runner.evaluate(el => el.getAnimations()[0].ready.then(() => undefined));
  const paused = await phase();
  await runner.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await phase()).toBeCloseTo(paused);
  await simulatePageVisibility(page, false);
  await expect(runner).toHaveCSS('animation-play-state', 'running');
  expect(await runner.evaluate((el, prior) => el.getAnimations()[0] === prior, animation)).toBe(true);
  await expect.poll(phase).toBeGreaterThan(paused);
});

test('stale, non-running, and rejected health reads keep the logo static', async ({ page }) => {
  const brand = page.locator('.desktop-sidebar .brand');
  await page.clock.install();
  const snapshot = await page.evaluate(async () => (await fetch('/api/v1/system/health?domain=personal')).json());
  await page.goto('/settings/preferences');
  for (const [freshness, inner, state, label] of [
    ['stale', 'fresh', 'running', 'Status unknown'],
    ['fresh', 'stale', 'running', 'Status unknown'],
    ['fresh', 'fresh', 'paused', 'Paused'],
    ['fresh', 'fresh', 'unknown', 'Status unknown'],
    ['fresh', 'fresh', 'invalid-service', 'Status unknown'],
  ]) {
    await expect(brand.getByRole('status')).toHaveText('Running');
    await expect(brand.locator('.logo-runner')).toHaveCSS('animation-play-state', 'running');
    // Inject only the negative condition into a real, scoped response.
    const path = '**/api/v1/system/health?*';
    await page.route(path, async route => {
      await route.fulfill({ json: {
        ...snapshot, freshness, data: { ...snapshot.data, freshness: inner, service: state },
      } });
    });
    const read = page.waitForResponse(response => response.url().includes('/api/v1/system/health') && response.ok());
    await page.clock.fastForward(16_000);
    await read;
    await expect(brand.getByRole('status')).toHaveText(label);
    await expect(brand.locator('.logo-runner')).toHaveCount(0);
    await page.unroute(path);
    await page.clock.fastForward(16_000);
  }
});

test('the shared logo stays available in the keyboard-operated drawer at both compact widths', async ({ page }) => {
  await page.goto('/settings/preferences');
  for (const viewport of [rendering.viewports.mobile, rendering.viewports.tablet]) {
    await page.setViewportSize(viewport);
    const toggle = page.getByRole('button', { name: 'Open navigation' });
    await toggle.focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('img', { name: 'PAtrick' })).toBeVisible();
    await expect(drawer.getByRole('status')).toHaveText('Running');
    await expect(drawer.locator('.logo-runner')).toHaveCSS('animation-duration', '4.8s');
    await expect(drawer.getByRole('button', { name: 'Close dialog' })).toBeFocused();
    expect(await drawer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(toggle).toBeFocused();
  }
});

base('demo mode keeps the logo static and reports unknown service health', async ({ page }) => {
  await page.goto('http://127.0.0.1:4195/decisions');
  const brand = page.locator('.desktop-sidebar .brand');
  await expect(page.locator('.demo-banner')).toBeVisible();
  await expect(brand.getByRole('status')).toHaveText('Status unknown');
  await expect(brand.getByRole('img', { name: 'PAtrick' })).toBeVisible();
  await expect(brand.locator('.logo-runner')).toHaveCount(0);
});
