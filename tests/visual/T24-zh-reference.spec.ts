/// <reference lib="dom" />
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { expect, test } from '@playwright/test';
import design from '../../design-inputs.lock.json' with { type: 'json' };
import rendering from '../../apps/web/rendering.lock.json' with { type: 'json' };
import { digest, pixelDiff } from './T24-baseline-fixture.js';
import { messages } from './T24-edit-fixture.js';
import { stamp, withVault } from './T24-vault-fixture.js';

const views = [
  { route: '/knowledge', section: 'knowledge', frame: 'zh-knowledge', id: '26:1617', data: '/api/v1/knowledge',
    settledText: 'empty.knowledge', buttons: { search: '搜索' } },
  { route: '/delegations', section: 'delegations', frame: 'zh-delegation', id: '26:1829', data: '/api/v1/delegations',
    settledText: 'empty.delegations', buttons: {} },
  { route: '/system', section: 'system', frame: 'zh-system', id: '26:2046', data: '/api/v1/system/health',
    settledText: 'button.refreshStatus', buttons: { 'refresh-status': '刷新状态', 'preview-diagnostics': '预览诊断' } },
] as const;
const file = (path: string) => new URL('../../' + path, import.meta.url);
const manifest = file('fixtures/screens/screen-manifest.json');
const hashes: Record<string, string> = { ...rendering.fonts.inter.sha256,
  ...Object.fromEntries(Object.entries(rendering.fonts.noto.sha256).map(([name, hash]) => [basename(name), hash])) };

test.use({ locale: 'zh-CN' });

for (const view of views) {
  test(`Chinese desktop runtime reference for ${view.frame}`, async ({ page, browser }, info) => {
    expect(design.frames.filter(frame => frame.key === view.frame)).toEqual([{ key: view.frame, id: view.id }]);
    expect(design.exports.some(row => row.key === view.frame && row.exported)).toBe(false);
    expect(browser.version()).toBe(rendering.chromium.version);
    await page.clock.setFixedTime(new Date(stamp));
    await page.context().route('**/*', route => new URL(route.request().url()).origin === 'http://localhost'
      ? route.fallback() : route.abort('blockedbyclient'));
    const fonts: Array<Promise<{ name: string; sha256: string }>> = [];
    page.on('response', response => {
      if (response.request().resourceType() !== 'font') return;
      fonts.push(response.body().then(bytes => ({ name: basename(new URL(response.url()).pathname), sha256: digest(bytes) })));
    });

    await withVault(page, 't24-chinese-reference', async ({ requests }) => {
      const t = messages.zh;
      await page.goto(view.route);
      await expect(page.getByRole('heading', { name: t[`nav.${view.section}`], exact: true, level: 1 })).toBeVisible();
      await expect(page.getByRole('main').getByText(t[view.settledText], { exact: true })).toBeVisible();
      for (const label of Object.values(view.buttons)) {
        await expect(page.getByRole('main').getByRole('button', { name: label, exact: true })).toBeVisible();
      }
      await expect.poll(() => requests.some(request => request.method === 'GET' && request.path === view.data && request.status === 200)).toBe(true);
      await expect(page.locator('.brand').getByRole('status')).toHaveText(t['status.offline']);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map(image => image.decode()));
      });
      const loaded = await Promise.all(fonts);
      expect(loaded.some(font => font.name.startsWith('noto-sans-sc-'))).toBe(true);
      for (const font of loaded) expect(font.sha256).toBe(hashes[font.name]);
      const observed = await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight },
        dpr: devicePixelRatio, locale: document.documentElement.lang, clock: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, light: matchMedia('(prefers-color-scheme: light)').matches,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, logoRunners: document.querySelectorAll('.logo-runner').length }));
      expect(observed).toEqual({ viewport: rendering.viewports.desktop, dpr: rendering.deviceScaleFactor,
        locale: 'zh-CN', clock: new Date(stamp).toISOString(), timezone: rendering.rendering.timezone,
        light: true, reducedMotion: true, logoRunners: 0 });
      const screenshot = await page.screenshot({ path: info.outputPath('runtime.png'), animations: 'disabled', scale: 'css' });
      expect(requests.filter(request => request.method !== 'GET')).toEqual([]);
      const baseline = `fixtures/screens/baselines/${view.frame}.png`;
      const reference = file(baseline);
      expect(existsSync(reference), 'reviewed runtime screenshot for ' + view.frame).toBe(true);
      const expected = readFileSync(reference);
      const index = JSON.parse(readFileSync(manifest, 'utf8')) as { screens: Array<{ frame_id: string }> };
      expect(index).toMatchObject({ kind: 'runtime-reference', coverage: 'partial', chromium: rendering.chromium.version });
      expect(index.screens.filter(row => row.frame_id === view.id)).toEqual([expect.objectContaining({ frame_id: view.id,
        fixture_sha256: digest(readFileSync(file('tests/visual/T24-vault-fixture.ts'))),
        rendering_lock_sha256: digest(readFileSync(file('apps/web/rendering.lock.json'))),
        expected_actions: Object.keys(view.buttons), test_id: info.title,
        route: view.route, locale: 'zh-CN', baseline_asset: baseline, baseline_sha256: digest(expected),
        design_comparison: 'export_unavailable', viewport: rendering.viewports.desktop, dpr: rendering.deviceScaleFactor })]);
      const result = await pixelDiff(page, screenshot, expected);
      await info.attach('runtime-readback', { contentType: 'application/json', body: JSON.stringify({ ...observed, route: view.route,
        frame: view.id, screenshotSha256: digest(screenshot), result, loaded }) });
      expect(result.ratio).toBeLessThanOrEqual(0.005);
    });
  });
}
