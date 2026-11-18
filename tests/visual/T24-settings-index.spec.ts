/// <reference lib="dom" />
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test } from '@playwright/test';
import rendering from '../../apps/web/rendering.lock.json' with { type: 'json' };
import { messages } from './T24-edit-fixture.js';
import { stamp, withVault } from './T24-vault-fixture.js';
import { bindUnreserved } from './T24-baseline-fixture.js';

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
          await expect(overview.getByRole('button', { name: locale === 'en' ? 'Run checks' : '运行检查' })).toBeDisabled();
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
        const overview = page.getByRole('region', { name: locale === 'en' ? 'Service projection snapshot' : '服务投影快照' });
        await expect(overview).toContainText(locale === 'en' ? 'Service projection status: Unknown' : '服务投影状态：未知');
        await expect(overview.locator('time')).toHaveCount(0);
        await expect(overview.getByRole('button', { name: locale === 'en' ? 'Run checks' : '运行检查' })).toBeDisabled();
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
            const nav = page.getByRole('navigation', { name: messages[locale]['aria.settings'] });
            const links = nav.getByRole('link');
            await expect(links).toHaveCount(6);
            const env = await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio, scale: visualViewport?.scale,
              scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
            expect(env).toMatchObject({ width: 720, dpr: 2, scale: 1 });
            expect(env.scrollWidth).toBeLessThanOrEqual(env.clientWidth);
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
