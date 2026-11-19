/// <reference lib="dom" />
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test } from '@playwright/test';
import rendering from '../../apps/web/rendering.lock.json' with { type: 'json' };
import environment from '../../fixtures/screens/visual-environment.json' with { type: 'json' };
import { messages } from './T24-edit-fixture.js';
import { stamp, withVault } from './T24-vault-fixture.js';
import { bindUnreserved, withHealthService } from './T24-baseline-fixture.js';

const sections = ['collection', 'materials', 'execution', 'operation', 'interaction', 'preferences'] as const;
// Exclusive separator ends measured at x=1000 in both locked v2.6 Settings exports.
const exportBottoms = [486, 585, 683, 782, 880, 978];
const descriptions = {
  en: [/sources/i, /Vault/i, /execution tools/i, /backup/i, /Feishu/i, /language/i],
  zh: [/来源/, /资料库/, /执行器/, /备份/, /飞书/, /语言/],
};

for (const locale of ['en', 'zh'] as const) {
  test.describe(locale + ' Settings index', () => {
    test.use({ locale: locale === 'en' ? 'en-US' : 'zh-CN' });
    for (const device of ['desktop', 'tablet', 'mobile'] as const) {
      test(device + ' six described keyboard links in one column', async ({ page }, info) => {
        const viewport = rendering.viewports[device], t = messages[locale];
        await page.setViewportSize(viewport);
        await page.clock.setFixedTime(new Date(stamp));
        await page.context().route('**/*', route => new URL(route.request().url()).origin === 'http://localhost'
          ? route.fallback() : route.abort('blockedbyclient'));
        await withVault(page, 't24-settings-index', async () => {
          await page.goto('/settings');
          const overview = page.getByRole('region', { name: locale === 'en' ? 'Service projection snapshot' : '服务投影快照' });
          await expect(overview).toBeVisible();
          await expect(overview).toContainText(locale === 'en' ? 'Current device: Unknown' : '当前设备：未知');
          const checks = page.getByRole('button', { name: locale === 'en' ? 'Run checks' : '运行检查', exact: true });
          await expect(checks).toBeDisabled();
          await expect(checks).toHaveAccessibleDescription(t['settings.overview.checksUnavailable']);
          await expect(page.locator('#settings-checks-unavailable')).toBeVisible();
          const nav = page.getByRole('navigation', { name: t['aria.settings'] });
          const links = nav.getByRole('link');
          await expect(links).toHaveCount(sections.length);
          await expect(page.locator('.brand .status-pill').first()).toHaveText(t['status.offline']);
          await page.evaluate(async () => {
            await document.fonts.ready;
            await Promise.all([...document.images].map(image => image.decode()));
          });
          const rows = await links.evaluateAll(nodes => nodes.map(node => {
            const { left, right, top, bottom } = node.getBoundingClientRect();
            return { left, right, top, bottom, href: node.getAttribute('href') };
          }));
          writeFileSync(info.outputPath('layout.json'), JSON.stringify({ viewport, rows, exportBottoms }, null, 2));
          await page.screenshot({ path: info.outputPath('index.png') });
          const bounds = await nav.boundingBox();
          expect(bounds).not.toBeNull();
          for (const [i, row] of rows.entries()) {
            expect(Math.abs(row.left - bounds!.x), 'full-width Settings row left').toBeLessThanOrEqual(2);
            expect(Math.abs(row.right - (bounds!.x + bounds!.width)), 'full-width Settings row right').toBeLessThanOrEqual(2);
            expect(row.left).toBeGreaterThanOrEqual(0);
            expect(row.right).toBeLessThanOrEqual(viewport.width);
            expect(row.bottom - row.top).toBeGreaterThanOrEqual(44);
            if (i > 0) {
              expect(row.top).toBeGreaterThanOrEqual(rows[i - 1].bottom);
              if (device === 'desktop') {
                const pitch = row.bottom - rows[i - 1].bottom;
                expect(Math.abs(pitch - (exportBottoms[i] - exportBottoms[i - 1])), 'locked row spacing').toBeLessThanOrEqual(2);
              }
            }
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
          await page.getByRole('button', { name: t['button.signOut'] }).focus();
          const refresh = overview.getByRole('button', { name: locale === 'en' ? 'Refresh health snapshot' : '刷新健康快照' });
          const system = overview.getByRole('link', { name: locale === 'en' ? 'View in System' : '前往系统' });
          await page.keyboard.press('Tab');
          await expect(refresh).toBeFocused();
          await page.keyboard.press('Tab');
          await expect(system).toBeFocused();
          for (const [i, section] of sections.entries()) {
            const link = nav.getByRole('link', { name: t[`settings.${section}`], exact: true });
            await expect(link).toHaveAttribute('href', '/settings/' + section);
            await expect(link).toHaveAccessibleDescription(descriptions[locale][i]);
            const descriptionId = await link.getAttribute('aria-describedby');
            const description = link.locator('[id="' + descriptionId + '"]');
            await expect(description).toHaveText(descriptions[locale][i]);
            await expect(description).toBeVisible();
            await page.keyboard.press('Tab');
            await expect(link).toBeFocused();
            expect(await link.evaluate(el => el.matches(':focus-visible') && parseFloat(getComputedStyle(el).outlineWidth) >= 2)).toBe(true);
          }
          await page.keyboard.press('Enter');
          await expect(page).toHaveURL('http://localhost/settings/preferences');
          await expect(page.getByRole('heading', { level: 1, name: t['settings.preferences'] })).toBeVisible();
        });
      });
    }
    test('demo labels the overview and makes no service request', async ({ page }) => {
      const listener = createServer();
      const port = await bindUnreserved(listener, new Set([Number(process.env.PATRICK_OVERVIEW_PROXY_PORT),
        Number(process.env.PATRICK_OVERVIEW_CONTROL_PORT)]));
      await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
      const vite = spawn(process.execPath, [fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url)),
        '--mode', 'demo', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      { cwd: new URL('../../apps/web', import.meta.url), stdio: 'ignore' });
      try {
        await expect.poll(async () => {
          if (vite.exitCode !== null) throw new Error('Demo server exited');
          return fetch(`http://127.0.0.1:${port}/`).then(response => response.ok, () => false);
        }, { timeout: 15_000 }).toBe(true);
        const api: string[] = [];
        page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/v1/')) api.push(request.url()); });
        await page.goto(`http://127.0.0.1:${port}/settings`);
        await expect(page.locator('.demo-banner')).toBeVisible();
        await expect(page.locator('.topbar')).toHaveCSS('background-color', 'rgb(245, 250, 252)');
        await expect(page.getByRole('heading', { level: 1, name: messages[locale]['nav.settings'], exact: true })).toHaveCount(1);
        await expect(page.getByRole('combobox', { name: messages[locale]['language.label'] })).toBeVisible();
        await expect(page.getByRole('button', { name: messages[locale]['button.consult'] })).toBeVisible();
        await expect(page.getByRole('button', { name: messages[locale]['button.signOut'] })).toHaveCount(0);
        const overview = page.getByRole('region', { name: locale === 'en' ? 'Service projection snapshot' : '服务投影快照' });
        await expect(overview).toContainText(locale === 'en' ? 'Service projection status: Unknown' : '服务投影状态：未知');
        await expect(overview.locator('time')).toHaveCount(0);
        const checks = page.getByRole('button', { name: locale === 'en' ? 'Run checks' : '运行检查', exact: true });
        await expect(checks).toBeDisabled();
        await expect(checks).toHaveAccessibleDescription(messages[locale]['settings.overview.checksUnavailable']);
        await expect(page.locator('#settings-checks-unavailable')).toBeVisible();
        await expect(page.locator('#settings-checks-unavailable')).toHaveCount(1);
        await expect(overview.getByRole('button', { name: locale === 'en' ? 'Refresh health snapshot' : '刷新健康快照' })).toBeDisabled();
        await expect(page.getByRole('navigation', { name: messages[locale]['aria.settings'] }).getByRole('link')).toHaveCount(6);
        expect(api).toEqual([]);
      } finally {
        if (vite.exitCode === null && vite.signalCode === null) {
          const exited = once(vite, 'exit');
          vite.kill('SIGTERM');
          await exited;
        }
      }
    });
    test('200% browser zoom keeps overview and six links reachable', async ({ browserName }, info) => {
      expect(browserName).toBe('chromium');
      const profile = mkdtempSync(join(tmpdir(), 'patrick-t24-settings-zoom-'));
      try {
        const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: null, deviceScaleFactor: undefined,
          locale: locale === 'en' ? 'en-US' : 'zh-CN', timezoneId: rendering.rendering.timezone, colorScheme: 'light', reducedMotion: 'reduce',
          args: ['--window-size=1440,1000', '--host-resolver-rules=MAP localhost 127.0.0.1:4196'] });
        try {
          expect(context.browser()?.version()).toBe(rendering.chromium.version);
          const page = context.pages()[0];
          await page.route('http://localhost/__zoom_measurement', route => route.fulfill({ contentType: 'text/html', body: '<main>Viewport</main>' }));
          await page.goto('http://localhost/__zoom_measurement');
          const prefs = await context.newPage();
          await prefs.goto('chrome://settings/appearance');
          const readZoom = () => prefs.evaluate(() => new Promise<number>(resolve => chrome.settingsPrivate.getDefaultZoom(resolve)));
          expect(await readZoom()).toBe(1);
          await prefs.evaluate(() => new Promise<void>(resolve => chrome.settingsPrivate.setDefaultZoom(2, resolve)));
          expect(await readZoom()).toBe(2);
          await prefs.close();
          await page.bringToFront();
          await withVault(page, 't24-settings-zoom', async () => {
            await page.goto('/settings');
            const overview = page.getByRole('region', { name: locale === 'en' ? 'Service projection snapshot' : '服务投影快照' });
            await expect(overview).toBeVisible();
            const checks = page.getByRole('button', { name: messages[locale]['settings.overview.checks'], exact: true });
            await expect(checks).toBeDisabled();
            await expect(checks).toHaveAccessibleDescription(messages[locale]['settings.overview.checksUnavailable']);
            await checks.scrollIntoViewIfNeeded();
            await expect(checks).toBeInViewport();
            const nav = page.getByRole('navigation', { name: messages[locale]['aria.settings'] });
            const links = nav.getByRole('link');
            await expect(links).toHaveCount(6);
            const env = await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio, scale: visualViewport?.scale,
              scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
            expect(env).toMatchObject({ width: 720, dpr: 2, scale: 1 });
            expect(env.scrollWidth).toBeLessThanOrEqual(env.clientWidth);
            const t = messages[locale];
            const skip = page.getByRole('link', { name: t['aria.skip'] });
            const drawer = page.getByRole('button', { name: t['aria.openNavigation'] });
            const language = page.getByRole('combobox', { name: t['language.label'] });
            const consult = page.getByRole('button', { name: t['button.consult'] });
            const signOut = page.getByRole('button', { name: t['button.signOut'] });
            const refresh = overview.getByRole('button', { name: t['settings.overview.refresh'] });
            const system = overview.getByRole('link', { name: t['settings.overview.system'] });
            await page.keyboard.press('Tab');
            await expect(skip).toBeFocused();
            await page.keyboard.press('Tab');
            await expect(drawer).toBeFocused();
            await page.keyboard.press('Tab');
            await expect(language).toBeFocused();
            await page.keyboard.press('Tab');
            await expect(consult).toBeFocused();
            await page.keyboard.press('Enter');
            const dialog = page.getByRole('dialog', { name: t['consult.title'] });
            await expect(dialog).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(dialog).toHaveCount(0);
            await expect(consult).toBeFocused();
            await page.keyboard.press('Tab');
            await expect(signOut).toBeFocused();
            await page.keyboard.press('Tab');
            await expect(refresh).toBeFocused();
            await expect(checks).not.toBeFocused();
            await expect(refresh).toBeInViewport();
            await page.keyboard.press('Tab');
            await expect(system).toBeFocused();
            await expect(system).toBeInViewport();
            for (const link of await links.all()) {
              await page.keyboard.press('Tab');
              await expect(link).toBeFocused();
              await expect(link).toBeInViewport();
              expect(await link.evaluate(el => el.matches(':focus-visible'))).toBe(true);
            }
            for (const link of await links.all()) {
              await link.focus();
              await expect(link).toBeFocused();
              await expect(link).toBeInViewport();
              expect(await link.evaluate(el => el.matches(':focus-visible'))).toBe(true);
            }
            await overview.getByRole('button', { name: locale === 'en' ? 'Refresh health snapshot' : '刷新健康快照' }).focus();
            await expect(overview.getByRole('button', { name: locale === 'en' ? 'Refresh health snapshot' : '刷新健康快照' })).toBeInViewport();
            await info.attach('settings-zoom', { body: JSON.stringify(env), contentType: 'application/json' });
            await page.screenshot({ path: info.outputPath('zoom.png') });
            await page.locator('#settings-checks-unavailable').evaluate(el => { el.textContent = (el.textContent + ' ').repeat(5); });
            const longReason = page.locator('#settings-checks-unavailable');
            await longReason.scrollIntoViewIfNeeded();
            await expect(longReason).toBeInViewport();
            const stress = await longReason.evaluate(el => {
              const r = el.getBoundingClientRect();
              return { left: r.left, right: r.right, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
                scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
                pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
            });
            expect(stress.left).toBeGreaterThanOrEqual(0);
            expect(stress.right).toBeLessThanOrEqual(stress.viewportWidth);
            expect(stress.scrollWidth).toBeLessThanOrEqual(stress.clientWidth + 1);
            expect(stress.scrollHeight).toBeLessThanOrEqual(stress.clientHeight + 1);
            expect(stress.pageWidth).toBeLessThanOrEqual(stress.viewportWidth);
          });
        } finally { await context.close(); }
      } finally { rmSync(profile, { recursive: true, force: true }); }
    });
  });
}

declare const chrome: { settingsPrivate: {
  getDefaultZoom(callback: (zoom: number) => void): void;
  setDefaultZoom(zoom: number, callback: () => void): void;
} };

const layoutFacts = { connections: { vault: { status: 'needs_permission', revision: 1, epoch: 1 }, feishu: null },
  edits: { pending: 0, failed: 0 } };

for (const locale of ['en', 'zh'] as const) {
  test.describe(locale + ' live Settings heading layout', () => {
    test.use({ locale: locale === 'en' ? 'en-US' : 'zh-CN' });
    test('places the single disabled checks action at the locked desktop bounds', async ({ page }, info) => {
      await page.setViewportSize(rendering.viewports.desktop);
      await page.clock.setFixedTime(new Date(stamp));
      await page.context().route('**/*', route => new URL(route.request().url()).origin === 'http://localhost'
        ? route.fallback() : route.abort('blockedbyclient'));
      await withHealthService(page, async () => {
        await page.goto('/settings');
        const t = messages[locale];
        const title = page.getByRole('heading', { level: 1, name: t['nav.settings'], exact: true });
        const overview = page.getByRole('region', { name: t['settings.overview.title'] });
        await expect(overview).toContainText(t['settings.overview.vaultPermission']);
        await expect(overview.locator('time')).toHaveAttribute('datetime', environment.healthAsOf);
        await expect(overview).toContainText(t['settings.overview.device']);
        const button = page.getByRole('button', { name: t['settings.overview.checks'], exact: true });
        await expect(button).toHaveCount(1);
        await expect(button).toBeDisabled();
        await expect(button).toHaveAttribute('aria-describedby', 'settings-checks-unavailable');
        await expect(button).toHaveAccessibleDescription(t['settings.overview.checksUnavailable']);
        await expect(page.locator('#settings-checks-unavailable')).toBeVisible();
        await expect(overview.getByRole('button', { name: t['settings.overview.refresh'] })).toBeVisible();
        await expect(overview.getByRole('link', { name: t['settings.overview.system'] })).toHaveAttribute('href', '/system');
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all([...document.images].map(image => image.decode()));
        });
        const rects = await page.evaluate(() => {
          const rectangle = (selector: string) => {
            const items = document.querySelectorAll(selector);
            if (items.length !== 1) throw new Error('Expected one ' + selector);
            const { x, y, width, height, top, right, bottom, left } = items[0].getBoundingClientRect();
            return { x, y, width, height, top, right, bottom, left };
          };
          const rows = [...document.querySelectorAll('.settings-grid a')].map(el => {
            const { x, y, width, height, top, right, bottom, left } = el.getBoundingClientRect();
            return { x, y, width, height, top, right, bottom, left };
          });
          return { fonts: document.fonts.status, title: rectangle('.page-title h1'),
            subtitle: rectangle('.page-title > p'), button: rectangle('.settings-checks-action > button'),
            overview: rectangle('.settings-overview'), rows };
        });
        expect(rects.fonts).toBe('loaded');
        expect(rects.rows).toHaveLength(6);
        const buttonBox = await button.boundingBox();
        const titleBox = await title.boundingBox();
        expect(buttonBox).not.toBeNull();
        expect(titleBox).not.toBeNull();
        const reference = environment.frames[locale].figmaEdges;
        const actual = { left: buttonBox!.x, top: buttonBox!.y,
          right: buttonBox!.x + buttonBox!.width, bottom: buttonBox!.y + buttonBox!.height, titleTop: titleBox!.y };
        writeFileSync(info.outputPath('heading-layout.json'), JSON.stringify({ actual, reference, rects }, null, 2));
        expect.soft(await button.evaluate(el => !!el.closest('.page-title')), 'button belongs to page title').toBe(true);
        for (const [side, expected] of Object.entries({ left: reference.runChecksLeft, top: reference.runChecksTop,
          right: reference.runChecksRight, bottom: reference.runChecksBottom })) {
          expect.soft(Math.abs(actual[side as 'left' | 'top' | 'right' | 'bottom'] - expected), side + ' locked button edge')
            .toBeLessThanOrEqual(environment.limits.edgePx);
        }
        expect.soft(Math.abs(actual.titleTop - 104), 'desktop heading top').toBeLessThanOrEqual(2);
      }, { freshness: 'fresh', at: environment.healthAsOf, facts: layoutFacts });
    });

    test('topbar tint is limited to the Settings home route', async ({ page }) => {
      await withHealthService(page, async () => {
        await page.goto('/settings');
        await expect(page.locator('.topbar')).toHaveCSS('background-color', 'rgb(245, 250, 252)');
        await page.goto('/settings/');
        await expect(page.locator('.topbar')).toHaveCSS('background-color', 'rgb(245, 250, 252)');
        await page.goto('/settings/materials');
        await expect(page.locator('.topbar')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
        await page.goto('/system');
        await expect(page.locator('.topbar')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      });
    });

    test('initial session verification keeps the home tint and one status until the real session returns', async ({ page }, info) => {
      await withHealthService(page, async service => {
        const t = messages[locale];
        const held = service.holdAllSessions();
        const browserReplies: number[] = [];
        page.on('response', response => {
          if (new URL(response.url()).pathname === '/api/v1/session' && response.request().method() === 'GET') browserReplies.push(response.status());
        });
        try {
          const navigation = page.goto('/settings');
          await held.ready;
          await navigation;
          await expect(page.locator('.topbar')).toHaveCSS('background-color', 'rgb(245, 250, 252)');
          await expect(page.getByRole('heading', { level: 1, name: t['nav.settings'], exact: true })).toHaveCount(1);
          const pending = await page.evaluate(() => ({ htmlLang: document.documentElement.lang,
            mainLang: document.querySelector<HTMLElement>('main')?.lang, mainText: document.querySelector<HTMLElement>('main')?.innerText }));
          const checking = page.locator('main').getByText(t['session.checking'], { exact: true });
          await expect(checking).toHaveCount(1);
          await expect(checking).toBeVisible();
          await expect(page.getByRole('combobox', { name: t['language.label'] })).toBeVisible();
          await expect(page.getByRole('button', { name: t['button.consult'] })).toBeVisible();
          await expect(page.getByRole('button', { name: t['button.signOut'] })).toHaveCount(0);
          await expect(page.getByRole('button', { name: t['settings.overview.checks'], exact: true })).toHaveCount(0);
          await expect(page.locator('#settings-checks-unavailable')).toHaveCount(0);
          await expect(page.getByRole('region', { name: t['settings.overview.title'] })).toHaveCount(0);
          const completedBeforeRelease = service.requests.filter(request => request.path === '/api/v1/session');
          expect(held.count()).toBeGreaterThan(0);
          expect(completedBeforeRelease).toEqual([]);
          expect(browserReplies).toEqual([]);
          writeFileSync(info.outputPath('pending-session.json'), JSON.stringify({ pending, accepted: held.count(),
            completedBeforeRelease, browserReplies }, null, 2));
          const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/v1/session');
          held.release();
          expect((await response).status()).toBe(200);
          const completed = service.requests.filter(request => request.path === '/api/v1/session');
          expect(completed.some(request => request.method === 'GET' && request.status === 200 && request.hasCookie && !request.hasAuthorization)).toBe(true);
          writeFileSync(info.outputPath('released-session.json'), JSON.stringify({ completed, browserReplies }, null, 2));
          await expect(checking).toHaveCount(0);
          await expect(page.locator('.topbar')).toHaveCSS('background-color', 'rgb(245, 250, 252)');
          await expect(page.getByRole('button', { name: t['button.signOut'] })).toBeVisible();
          const checks = page.getByRole('button', { name: t['settings.overview.checks'], exact: true });
          await expect(checks).toHaveCount(1);
          await expect(checks).toBeDisabled();
          await expect(checks).toHaveAccessibleDescription(t['settings.overview.checksUnavailable']);
          await expect(page.locator('#settings-checks-unavailable')).toHaveCount(1);
          await expect(page.locator('#settings-checks-unavailable')).toBeVisible();
        } finally { held.release(); }
      });
    });

    test('401 keeps the home tint and one sign-in prompt without checks controls', async ({ page }) => {
      await withHealthService(page, async service => {
        const t = messages[locale];
        await page.context().clearCookies();
        const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/v1/session');
        await page.goto('/settings');
        expect((await response).status()).toBe(401);
        expect(service.requests.some(request => request.path === '/api/v1/session' && request.status === 401 && !request.hasCookie)).toBe(true);
        await expect(page.locator('.topbar')).toHaveCSS('background-color', 'rgb(245, 250, 252)');
        await expect(page.getByRole('heading', { level: 1, name: t['nav.settings'], exact: true })).toHaveCount(1);
        const prompt = page.locator('main').getByText(t['session.required'], { exact: true });
        await expect(prompt).toHaveCount(1);
        await expect(prompt).toBeVisible();
        await expect(page.getByRole('combobox', { name: t['language.label'] })).toBeVisible();
        await expect(page.getByRole('button', { name: t['button.consult'] })).toBeVisible();
        await expect(page.getByRole('button', { name: t['button.signOut'] })).toHaveCount(0);
        await expect(page.getByRole('button', { name: t['settings.overview.checks'], exact: true })).toHaveCount(0);
        await expect(page.locator('#settings-checks-unavailable')).toHaveCount(0);
        await expect(page.getByRole('region', { name: t['settings.overview.title'] })).toHaveCount(0);
      });
    });

    for (const device of ['desktop', 'tablet', 'mobile'] as const) {
      test(device + ' wraps long explanatory text without covering actions', async ({ page }) => {
        await page.setViewportSize(rendering.viewports[device]);
        await withHealthService(page, async () => {
          await page.goto('/settings');
          const t = messages[locale];
          const overview = page.getByRole('region', { name: t['settings.overview.title'] });
          await expect(overview).toContainText(t['settings.overview.vaultPermission']);
          const action = page.getByRole('button', { name: t['settings.overview.checks'], exact: true });
          await expect(action).toBeDisabled();
          await page.evaluate(() => {
            const reason = document.getElementById('settings-checks-unavailable');
            const scope = document.querySelector('.settings-overview-scope');
            if (!reason || !scope) throw new Error('Missing explanatory text');
            reason.textContent = (reason.textContent + ' ').repeat(5);
            scope.textContent = (scope.textContent + ' ').repeat(4);
          });
          const layout = await page.evaluate(() => {
            const names = ['main h1', 'button[aria-describedby="settings-checks-unavailable"]', '#settings-checks-unavailable',
              '.settings-overview h2', '.settings-overview-scope', '.settings-overview-actions button', '.settings-overview-actions a'];
            const rectangles = names.map(name => {
              const el = document.querySelector<HTMLElement>(name);
              if (!el) throw new Error('Missing ' + name);
              const r = el.getBoundingClientRect();
              return { name, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
                scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
            });
            return { rectangles, scrollWidth: document.documentElement.scrollWidth, width: innerWidth };
          });
          expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
          for (const r of layout.rectangles) {
            expect(r.left, r.name).toBeGreaterThanOrEqual(0);
            expect(r.right, r.name).toBeLessThanOrEqual(layout.width);
            expect(r.scrollWidth, r.name).toBeLessThanOrEqual(r.clientWidth + 1);
            expect(r.scrollHeight, r.name).toBeLessThanOrEqual(r.clientHeight + 1);
          }
          const overlaps = (a: typeof layout.rectangles[number], b: typeof layout.rectangles[number]) =>
            a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
          for (const [a, b] of [[0, 1], [0, 2], [1, 2], [2, 3], [2, 5], [2, 6], [4, 5], [4, 6]] as const) {
            expect(overlaps(layout.rectangles[a], layout.rectangles[b]), layout.rectangles[a].name + ' overlaps ' + layout.rectangles[b].name).toBe(false);
          }
          await expect(overview.getByRole('button', { name: t['settings.overview.refresh'] })).toBeVisible();
          await expect(overview.getByRole('link', { name: t['settings.overview.system'] })).toBeVisible();
        }, { freshness: 'fresh', at: environment.healthAsOf, facts: layoutFacts });
      });
    }
  });
}

test('Settings topbar keeps language, consultation and sign-out working', async ({ page }) => {
  await withHealthService(page, async () => {
    await page.goto('/settings');
    await expect(page.getByRole('region', { name: messages.en['settings.overview.title'] })).toBeVisible();
    await page.getByRole('combobox', { name: messages.en['language.label'] }).selectOption('zh');
    await expect(page.getByRole('heading', { level: 1, name: messages.zh['nav.settings'], exact: true })).toBeVisible();
    await page.getByRole('button', { name: messages.zh['button.consult'] }).click();
    const dialog = page.getByRole('dialog', { name: messages.zh['consult.title'] });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: messages.zh['aria.closeDialog'] }).click();
    await expect(dialog).toHaveCount(0);
    const signedOut = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/session' && response.request().method() === 'DELETE');
    await page.getByRole('button', { name: messages.zh['button.signOut'] }).click();
    expect((await signedOut).ok()).toBe(true);
    await expect(page.getByRole('button', { name: messages.zh['settings.overview.checks'], exact: true })).toHaveCount(0);
  });
});

test('unauthenticated Settings keeps its title without a checks action', async ({ page }) => {
  await withHealthService(page, async () => {
    await page.context().clearCookies();
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1, name: messages.en['nav.settings'], exact: true })).toBeVisible();
    await expect(page.getByText(messages.en['session.required'])).toBeVisible();
    await expect(page.getByRole('button', { name: messages.en['settings.overview.checks'], exact: true })).toHaveCount(0);
  });
});

test('all held session requests wait for release and receive real authenticated responses', async ({ page }, info) => {
  await withHealthService(page, async service => {
    expect((await page.goto('/api/v1/session'))?.status()).toBe(200);
    const first = service.requests.length;
    const held = service.holdAllSessions();
    try {
      const responses = page.evaluate(async () => await Promise.all([
        fetch('/api/v1/session?gate=one').then(response => response.status),
        fetch('/api/v1/session?gate=two').then(response => response.status),
      ]));
      await held.ready;
      await expect.poll(held.count).toBe(2);
      const before = service.requests.slice(first);
      expect(before).toEqual([]);
      held.release();
      expect(await responses).toEqual([200, 200]);
      const after = service.requests.slice(first);
      expect(after).toHaveLength(2);
      expect(after.every(request => request.method === 'GET' && request.path === '/api/v1/session' &&
        request.status === 200 && request.hasCookie && !request.hasAuthorization)).toBe(true);
      writeFileSync(info.outputPath('session-gate.json'), JSON.stringify({ acceptedBeforeRelease: held.count(), before, after }, null, 2));
    } finally { held.release(); }
  });
});

for (const ending of ['callback failure', 'page close', 'page close then callback failure'] as const) {
  test('held session requests are released on ' + ending, async ({ page }, info) => {
    const scratch = mkdtempSync(join(tmpdir(), 'p24-session-gate-'));
    let cleanup: { databaseOpen: boolean; runtimeStatus: string; serviceListening: boolean } | undefined;
    try {
      const run = withHealthService(page, async service => {
        const held = service.holdAllSessions();
        const navigation = page.goto('/settings').catch(() => undefined);
        await held.ready;
        expect(held.count()).toBeGreaterThan(0);
        expect(service.requests.filter(request => request.path === '/api/v1/session')).toEqual([]);
        if (ending !== 'callback failure') { await page.close(); await navigation; }
        if (ending !== 'page close') throw new Error('expected fixture callback failure');
      }, undefined, { scratchRoot: scratch, onCleanup: result => { cleanup = result; } });
      if (ending !== 'page close') await expect(run).rejects.toThrow('expected fixture callback failure');
      else await expect(run).resolves.toBeUndefined();
      expect(cleanup).toEqual({ databaseOpen: false, runtimeStatus: 'closed', serviceListening: false });
      expect(readdirSync(scratch)).toEqual([]);
      const proxy = 'http://127.0.0.1:' + process.env.PATRICK_OVERVIEW_PROXY_PORT;
      await expect.poll(async () => (await fetch(proxy + '/api/v1/session')).status).toBe(503);
      writeFileSync(info.outputPath('session-gate-cleanup.json'), JSON.stringify({ ending, cleanup, remaining: readdirSync(scratch), proxyStatus: 503 }, null, 2));
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
}
