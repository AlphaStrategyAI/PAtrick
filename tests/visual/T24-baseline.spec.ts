/// <reference lib="dom" />
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { expect, test } from '@playwright/test';
import lock from '../../design-inputs.lock.json' with { type: 'json' };
import rendering from '../../apps/web/rendering.lock.json' with { type: 'json' };
import environment from '../../fixtures/screens/visual-environment.json' with { type: 'json' };
import { messages } from './T24-edit-fixture.js';
import { stamp } from './T24-vault-fixture.js';
import { digest, edgeDeltas, measureSettings, pixelDiff, withHealthService } from './T24-baseline-fixture.js';

const file = (path: string) => new URL('../../' + path, import.meta.url);
const require = createRequire(import.meta.url);
const groups = ['collection', 'materials', 'execution', 'operation', 'interaction', 'preferences'] as const;
const facts = { connections: { vault: { status: 'needs_permission', revision: 1, epoch: 1 }, feishu: null },
  edits: { pending: 0, failed: 0 } };

for (const locale of ['en', 'zh'] as const) {
  test.describe(locale + ' settings index', () => {
    test.use({ locale: locale === 'en' ? 'en-US' : 'zh-CN' });
    test('desktop runtime baseline and locked design comparison', async ({ page, browser }, info) => {
      const frame = environment.frames[locale];
      const design = lock.exports.find(row => row.key === frame.key)!;
      expect(lock.frames.filter(row => row.key === frame.key)).toEqual([{ id: frame.id, key: frame.key }]);
      expect(design).toMatchObject({ id: frame.id, ...environment.viewport, exported: true, asset: frame.exportAsset,
        sha256: frame.exportSha256, exportVersion: frame.exportVersion });
      const exportBytes = readFileSync(file('docs/designs/设计资产/v2/' + design.asset));
      expect(digest(exportBytes)).toBe(design.sha256);
      expect(browser.version()).toBe(rendering.chromium.version);
      expect(require('@playwright/test/package.json').version).toBe(rendering.playwright);
      expect(digest(readFileSync(file('apps/web/rendering.lock.json')))).toBe(environment.renderingLockSha256);
      expect(digest(readFileSync(file('tests/visual/T24-vault-fixture.ts')))).toBe(environment.fixtureSha256);
      expect(digest(readFileSync(file('tests/visual/T24-baseline-fixture.ts')))).toBe(environment.healthFixtureSha256);
      expect(environment.limits).toEqual({ edgePx: 2, pixelRatio: 0.005 });
      expect(environment).toMatchObject({ chromium: rendering.chromium.version, playwright: rendering.playwright,
        viewport: rendering.viewports.desktop, deviceScaleFactor: rendering.deviceScaleFactor });
      await page.clock.setFixedTime(new Date(stamp));
      await page.context().route('**/*', route => new URL(route.request().url()).origin === 'http://localhost'
        ? route.fallback() : route.abort('blockedbyclient'));
      const fonts: Array<Promise<{ name: string; sha256: string }>> = [];
      page.on('response', response => {
        if (response.request().resourceType() !== 'font') return;
        const name = basename(new URL(response.url()).pathname);
        fonts.push(response.body().then(bytes => ({ name, sha256: digest(bytes) })));
      });
      await withHealthService(page, async service => {
        const transport = { port: Number(process.env.PATRICK_OVERVIEW_PROXY_PORT), directory: process.env.PATRICK_OVERVIEW_DIRECTORY,
          controlPort: Number(process.env.PATRICK_OVERVIEW_CONTROL_PORT), backendPort: service.backendPort, owner: Number(process.env.PATRICK_OVERVIEW_PROXY_OWNER), worker: process.pid, parent: process.ppid, observedAt: new Date().toISOString() };
        expect(transport.owner).toBe(transport.parent);
        expect(new Set([transport.port, transport.controlPort, transport.backendPort, 43155]).size).toBe(4);
        writeFileSync(info.outputPath('overview-transport.json'), JSON.stringify(transport, null, 2));
        await page.goto(environment.route);
        const t = messages[locale];
        await expect(page.getByRole('heading', { level: 1, name: t['nav.settings'], exact: true })).toBeVisible();
        await expect(page.locator('.brand').getByRole('status')).toHaveText(t['status.running'], { timeout: 22_000 });
        const overview = page.getByRole('region', { name: t['settings.overview.title'] });
        await expect(overview).toContainText(t['settings.overview.vaultPermission']);
        await expect(overview.locator('time')).toHaveAttribute('datetime', environment.healthAsOf);
        await expect(page.locator('.curious-logo img')).toBeVisible();
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all([...document.images].map(image => image.decode()));
        });
        const measured = await measureSettings(page);
        expect(measured.links).toEqual(groups.map(group => ({ path: '/settings/' + group, label: t[`settings.${group}`] })));
        expect(measured).toMatchObject({ ...environment.viewport, dpr: environment.deviceScaleFactor, htmlLang: locale === 'en' ? 'en' : 'zh-CN',
          timezone: environment.timezone, clock: environment.clock, light: true, reducedMotion: true, logoRunners: 0 });
        const loaded = await Promise.all(fonts);
        expect(loaded.some(font => font.name === 'InterVariable.woff2')).toBe(true);
        if (locale === 'zh') expect(loaded.some(font => font.name.startsWith('noto-sans-sc-'))).toBe(true);
        const hashes: Record<string, string> = { ...rendering.fonts.inter.sha256,
          ...Object.fromEntries(Object.entries(rendering.fonts.noto.sha256).map(([name, hash]) => [basename(name), hash])) };
        for (const font of loaded) expect(font.sha256, font.name).toBe(hashes[font.name]);
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('DOM.enable');
        await cdp.send('CSS.enable');
        const { root } = await cdp.send('DOM.getDocument');
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'main h1' });
        const { fonts: headingFonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
        await cdp.detach();
        expect(headingFonts.some(font => font.isCustomFont && font.glyphCount > 0 &&
          font.familyName.includes(locale === 'en' ? 'Inter' : 'Noto Sans SC'))).toBe(true);
        const shot = await page.screenshot({ path: info.outputPath('runtime.png'), animations: 'disabled', scale: 'css' });
        const designPixels = await pixelDiff(page, shot, exportBytes);
        const designEdges = edgeDeltas(measured.edges, { ...environment.figmaEdges, ...frame.figmaEdges });
        writeFileSync(info.outputPath('design-comparison.json'), JSON.stringify({ frame: design, measured, loaded, headingFonts,
          designEdges, designPixels, geometryWithinTolerance: Object.values(designEdges).every(d => Math.abs(d) <= environment.limits.edgePx),
          pixelsWithinTolerance: designPixels.ratio <= environment.limits.pixelRatio }, null, 2));
        const reference = file(frame.asset);
        expect(existsSync(reference), 'reviewed runtime screenshot ' + locale).toBe(true);
        const expected = readFileSync(reference);
        expect(digest(expected)).toBe(frame.baselineSha256);
        const runtimePixels = await pixelDiff(page, shot, expected);
        expect(Object.keys(frame.edges).sort()).toEqual(Object.keys(measured.edges).sort());
        const runtimeEdges = edgeDeltas(measured.edges, frame.edges);
        writeFileSync(info.outputPath('runtime-comparison.json'), JSON.stringify({ runtimeEdges, runtimePixels }, null, 2));
        for (const [key, delta] of Object.entries(runtimeEdges)) expect.soft(Math.abs(delta), key + ' geometry drift').toBeLessThanOrEqual(environment.limits.edgePx);
        expect.soft(runtimePixels.ratio, 'changed pixel ratio').toBeLessThanOrEqual(environment.limits.pixelRatio);
        // Release qualification can run the same capture with the locked Figma gates enabled.
        if (process.env.T24_REQUIRE_DESIGN_MATCH === '1') {
          for (const [key, delta] of Object.entries(designEdges))
            expect.soft(Math.abs(delta), key + ' Figma drift').toBeLessThanOrEqual(environment.limits.edgePx);
          expect.soft(designPixels.ratio, 'Figma pixel ratio').toBeLessThanOrEqual(environment.limits.pixelRatio);
        }
      }, { freshness: 'fresh', at: environment.healthAsOf, facts });
    });
  });
}
