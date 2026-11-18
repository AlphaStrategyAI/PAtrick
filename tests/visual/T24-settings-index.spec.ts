/// <reference lib="dom" />
import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import rendering from '../../apps/web/rendering.lock.json' with { type: 'json' };
import { messages } from './T24-edit-fixture.js';
import { stamp, withVault } from './T24-vault-fixture.js';

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
  });
}
