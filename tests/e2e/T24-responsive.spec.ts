/// <reference lib="dom" />
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium, expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createVaultApi } from '@patrick/integrations/vault/drafts';
import { createBlobStore } from '@patrick/storage';
import rendering from '../../apps/web/rendering.lock.json' with { type: 'json' };
import { messages, stamp, temporaryVault, type Locale } from '../visual/T24-edit-fixture.js';
import { t16Fixture } from './T16-fixture.js';

const filenames = {
  en: 'Accessibility review of keyboard navigation and reading order for the quarterly product requirements meeting with customer support.md',
  zh: '季度产品需求讨论会纪要与客户支持团队共同核对的知识资料以及待确认的后续问题与键盘操作验收记录.md',
};
const scenarios = { mobile: rendering.viewports.mobile, tablet: rendering.viewports.tablet, desktop: rendering.viewports.desktop };
const sidebarPaths = ['/decisions', '/work', '/standards', '/knowledge', '/delegations', '/system', '/stats', '/settings'];
const settingsSummaries = {
  en: { index: 'Connect your inputs. Keep the essentials simple.', collection: 'Manage sources, tools, and preferences.' },
  zh: { index: '接入所需资料，让必要设置保持简单。', collection: '管理来源、工具和偏好。' },
};
const controls = 'a[href]:visible,button:enabled:visible,select:enabled:visible,input:enabled:visible,textarea:enabled:visible';

async function environment(page: Page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    return { width: innerWidth, height: innerHeight, outerWidth, dpr: devicePixelRatio,
      documentWidth: document.documentElement.scrollWidth, rootWidth: document.documentElement.clientWidth,
      pinchScale: visualViewport?.scale, lang: document.documentElement.lang, clock: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      light: matchMedia('(prefers-color-scheme: light)').matches,
      fonts: [...new Set([...document.fonts].filter(face => face.status === 'loaded').map(face => face.family))].sort() };
  });
}

async function measure(target: Locator, textOnly = false) {
  return target.evaluate((el, textOnly) => {
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    let left = 0, right = document.documentElement.clientWidth;
    let top = 0, bottom = innerHeight;
    for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const box = ancestor.getBoundingClientRect();
      if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
        left = Math.max(left, box.left + ancestor.clientLeft);
        right = Math.min(right, box.left + ancestor.clientLeft + ancestor.clientWidth);
      }
      if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
        top = Math.max(top, box.top + ancestor.clientTop);
        bottom = Math.min(bottom, box.top + ancestor.clientTop + ancestor.clientHeight);
      }
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    const fragments = Array.from(range.getClientRects()).filter(box => box.width > 0 && box.height > 0);
    const checked = textOnly ? fragments : [rect];
    const center = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
    const tag = el.tagName.toLowerCase();
    return { tag, label: el.getAttribute('aria-label') || el.textContent?.trim() || el.getAttribute('type') || tag,
      x: rect.x, y: rect.y, width: rect.width, height: rect.height, clipLeft: left, clipRight: right,
      fragmentCount: fragments.length, lines: new Set(fragments.map(box => box.top)).size, scrollX,
      clipped: checked.length === 0 || checked.some(box => box.left < left - 1 || box.right > right + 1),
      unreachable: !textOnly && (!el.contains(center) || rect.top < top - 1 || rect.bottom > bottom + 1) };
  }, textOnly);
}

async function layout(page: Page, scope: Locator, text?: Locator) {
  const dimensions = await environment(page);
  const targets = [];
  for (const target of await scope.locator(controls).all()) targets.push(await measure(target));
  const longText = text ? await measure(text, true) : undefined;
  return { dimensions, scopeScroll: await scope.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth })),
    targets, longText };
}

function issues(name: string, sample: Awaited<ReturnType<typeof layout>>) {
  const problems = [];
  if (sample.dimensions.documentWidth > sample.dimensions.rootWidth + 1) problems.push(name + ': document overflow');
  if (sample.scopeScroll.scroll > sample.scopeScroll.client + 1) problems.push(name + ': container overflow');
  for (const target of sample.targets) {
    if (target.clipped || target.unreachable || target.scrollX !== 0) problems.push(name + ': ' + target.label + ' clipped or obscured');
  }
  if (sample.longText?.clipped) problems.push(name + ': clipped text');
  return problems;
}

async function tabTo(page: Page, target: Locator, trace: string[]) {
  for (let n = 0; n < 32; n++) {
    if (await target.evaluate(el => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
    trace.push(await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return 'body';
      return el.getAttribute('aria-label') || el.getAttribute('href') || el.textContent?.trim().slice(0, 70) || el.tagName;
    }));
  }
  await expect(target, 'Keyboard Tab must reach the requested control').toBeFocused();
}

async function flow(page: Page, locale: Locale, info: TestInfo, width: number, zoom = 1) {
  const t = messages[locale];
  const fx = await t16Fixture(page);
  const trace: string[] = [];
  const samples: Record<string, Awaited<ReturnType<typeof layout>>> = {};
  const problems: string[] = [];
  try {
    const root = temporaryVault(fx);
    const relativePath = '知识笔记/' + filenames[locale];
    writeFileSync(join(root, relativePath), '---\npatrick_id: responsive-source\nkind: knowledge\nknowledge_id: k-responsive\n---\n\n' + filenames[locale]);
    const vault = createVaultApi(fx.db, { captureHost: 'test-mac', blobs: createBlobStore(join(dirname(root), 'blobs')), now: () => new Date(stamp) });
    await vault.readVault('t16-vault');
    await page.clock.setFixedTime(new Date(stamp));
    await page.goto('http://localhost/standards');
    const main = page.getByRole('main');
    await expect(main.getByText(t['empty.standards'], { exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', locale === 'en' ? 'en' : 'zh-CN');
    const env = await environment(page);
    expect(env).toMatchObject({ width, dpr: rendering.deviceScaleFactor * zoom, pinchScale: 1, timezone: rendering.rendering.timezone, clock: stamp, light: true, reduced: true });
    samples.header = await layout(page, page.getByRole('banner'));
    samples.standards = await layout(page, main);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: t['aria.skip'] })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(main).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(main.getByRole('button', { name: t['edits.operation.create_standard'] })).toBeFocused();
    trace.push('Tab → skip link, Enter → main, Tab → first draft');
    const compact = width <= 768;
    const menu = page.getByRole('button', { name: t['aria.openNavigation'] });
    const drawer = page.getByRole('dialog', { name: t['aria.navigation'] });
    if (compact) {
      await tabTo(page, menu, trace);
      await page.keyboard.press('Enter');
      await expect(drawer.getByRole('button', { name: t['aria.closeDialog'] })).toBeFocused();
      samples.drawer = await layout(page, drawer);
      await page.keyboard.press('Escape');
      await expect(menu).toBeFocused();
      await page.keyboard.press('Enter');
    } else {
      await expect(menu).toHaveCount(0);
      samples.sidebar = await layout(page, page.getByRole('complementary'));
    }
    const nav = compact ? drawer.getByRole('navigation') : page.getByRole('navigation', { name: t['aria.navigation'] });
    const links = nav.getByRole('link');
    const navigation = await links.evaluateAll(nodes => nodes.map(node => {
      const { top, bottom, height, width } = node.getBoundingClientRect();
      return { path: node.getAttribute('href'), top, bottom, height, width };
    }));
    expect(navigation.map(item => item.path)).toEqual(sidebarPaths);
    for (const [index, item] of navigation.entries()) {
      expect(item.height).toBeGreaterThanOrEqual(44);
      expect(item.width).toBeGreaterThanOrEqual(44);
      if (index > 0 && index < sidebarPaths.length - 1) {
        expect.soft(item.top - navigation[index - 1].bottom, 'sidebar link gap').toBe(10);
      }
    }
    await expect(nav.getByRole('link', { name: t['nav.standards'] })).toHaveAttribute('aria-current', 'page');
    await tabTo(page, links.first(), trace);
    for (const [index, link] of (await links.all()).entries()) {
      if (index > 0) await page.keyboard.press('Tab');
      await expect(link).toBeFocused();
      expect(await link.evaluate(el => el.matches(':focus-visible') && parseFloat(getComputedStyle(el).outlineWidth) >= 2)).toBe(true);
    }
    const knowledge = nav.getByRole('link', { name: t['nav.knowledge'] });
    await tabTo(page, knowledge, trace);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('http://localhost/knowledge');
    await expect(drawer).toHaveCount(0);
    const note = main.getByRole('button', { name: 'k-responsive', exact: true });
    await expect(note).toBeVisible();
    await tabTo(page, note, trace);
    await page.keyboard.press('Enter');
    const source = main.getByRole('button', { name: t['learning.sourceLocation'] });
    await expect(source).toBeVisible();
    await tabTo(page, source, trace);
    await page.keyboard.press('Enter');
    const path = main.getByText(relativePath, { exact: true });
    await expect(path).toBeVisible();
    samples.source = await layout(page, main, path);
    const edit = main.getByRole('button', { name: t['edits.operation.edit_original'] });
    await tabTo(page, edit, trace);
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: t['edits.operation.edit_original'] });
    const close = dialog.getByRole('button', { name: t['aria.closeDialog'] });
    await expect(close).toBeFocused();
    const submit = dialog.getByRole('button', { name: t['edits.register'] });
    await expect(submit).toBeEnabled();
    await expect(dialog.getByText(relativePath, { exact: true })).toBeVisible();
    samples.preview = await layout(page, dialog, dialog.getByText(relativePath, { exact: true }));
    await tabTo(page, submit, trace);
    const [registration] = await Promise.all([page.waitForResponse(res =>
      new URL(res.url()).pathname === '/api/v1/edits' && res.request().method() === 'POST'), page.keyboard.press('Enter')]);
    expect(registration.status()).toBe(202);
    const { receipt_url: receiptPath } = await registration.json() as { receipt_url: string };
    const id = receiptPath.split('/').at(-1)!;
    await expect(dialog.getByText(id, { exact: true })).toBeVisible();
    await expect(dialog.getByTestId('file-state')).toHaveText(t['edits.file.awaiting_save']);
    const focusAfterReceipt = await dialog.evaluate(el => ({ inside: el.contains(document.activeElement),
      tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.trim().slice(0, 65) }));
    if (!focusAfterReceipt.inside) problems.push('receipt: keyboard focus left the open dialog after registration');
    else if (focusAfterReceipt.text !== t['edits.refresh']) problems.push('receipt: expected focus on the receipt refresh action');
    samples.receipt = await layout(page, dialog, dialog.getByText(relativePath, { exact: true }));
    await tabTo(page, dialog.getByRole('button', { name: t['button.cancel'] }), trace);
    await page.keyboard.press('Escape');
    await expect(edit).toBeFocused();
    for (const [name, sample] of Object.entries(samples)) problems.push(...issues(name, sample));
    await info.attach('responsive-observations', { contentType: 'application/json',
      body: JSON.stringify({ env, zoom, locale, relativePath, receiptPath, focusAfterReceipt, navigation, trace, samples, problems }, null, 2) });
    return problems;
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    fx.close();
  }
}

for (const locale of ['en', 'zh'] as const) {
  test.describe(locale, () => {
    test.use({ locale: locale === 'en' ? 'en-US' : 'zh-CN' });
    for (const [size, viewport] of Object.entries(scenarios)) {
      test(size + ' responsive layout and keyboard', async ({ page, browser }, info) => {
        expect(browser.version()).toBe(rendering.chromium.version);
        await page.setViewportSize(viewport);
        expect(await flow(page, locale, info, viewport.width)).toEqual([]);
      });
    }
    test('Settings home and Collection have distinct localized summaries', async ({ page }) => {
      const t = messages[locale];
      const fx = await t16Fixture(page);
      try {
        await page.goto('/settings');
        const title = page.locator('.page-title');
        await expect(title.getByRole('heading', { name: t['nav.settings'], exact: true })).toBeVisible();
        await expect.soft(title.locator('h1 + p')).toHaveText(settingsSummaries[locale].index);
        await page.getByRole('link', { name: t['settings.collection'], exact: true }).click();
        await expect(page).toHaveURL('http://localhost/settings/collection');
        await expect(title.getByRole('heading', { name: t['settings.collection'], exact: true })).toBeVisible();
        await expect(title.locator('h1 + p')).toHaveText(settingsSummaries[locale].collection);
      } finally {
        await page.unrouteAll({ behavior: 'wait' });
        fx.close();
      }
    });
    test('200% browser zoom in an isolated profile', async ({ browserName }, info) => {
      expect(browserName).toBe('chromium');
      const profile = mkdtempSync(join(tmpdir(), 'patrick-t24-browser-zoom-'));
      try {
        // The headless shell has no browser Settings UI. The full, version-pinned Chromium owns only this temporary profile.
        const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: null,
          locale: locale === 'en' ? 'en-US' : 'zh-CN', timezoneId: rendering.rendering.timezone, colorScheme: 'light', reducedMotion: 'reduce',
          args: ['--window-size=1440,1000', '--host-resolver-rules=MAP localhost 127.0.0.1:4198'] });
        try {
          const version = context.browser()?.version();
          expect(version).toBe(rendering.chromium.version);
          const page = context.pages()[0];
          // Local origin prior to authenticated setup; no service request or page content is required to measure browser zoom.
          await page.route('http://localhost/__zoom_measurement', route => route.fulfill({ contentType: 'text/html', body: '<main>Viewport</main>' }));
          await page.goto('http://localhost/__zoom_measurement');
          const prefs = await context.newPage();
          await prefs.goto('chrome://settings/appearance');
          const before = await environment(page);
          const readZoom = () => prefs.evaluate(() => new Promise<number>(resolve => chrome.settingsPrivate.getDefaultZoom(resolve)));
          expect(before).toMatchObject({ width: rendering.viewports.desktop.width, dpr: rendering.deviceScaleFactor, pinchScale: 1 });
          expect(await readZoom()).toBe(1);
          await prefs.evaluate(() => new Promise<void>(resolve => chrome.settingsPrivate.setDefaultZoom(2, resolve)));
          const zoom = await readZoom();
          expect(zoom).toBe(2);
          await page.reload();
          const after = await environment(page);
          expect(after).toMatchObject({ outerWidth: before.outerWidth, width: before.width / 2, dpr: before.dpr * 2, pinchScale: 1 });
          await prefs.close();
          await page.bringToFront();
          await info.attach('browser-zoom', { contentType: 'application/json', body: JSON.stringify({ version, before, after, zoom }) });
          expect(await flow(page, locale, info, after.width, zoom)).toEqual([]);
        } finally { await context.close(); }
      } finally { rmSync(profile, { recursive: true, force: true }); }
    });
  });
}

// Browser Settings exposes this profile-local API only on chrome://settings.
declare const chrome: { settingsPrivate: {
  getDefaultZoom(callback: (factor: number) => void): void;
  setDefaultZoom(factor: number, callback: () => void): void;
} };

test('layout checks detect horizontal overflow and an obscured action', async ({ page }, info) => {
  const fx = await t16Fixture(page);
  try {
    await page.setViewportSize(rendering.viewports.mobile);
    await page.goto('/standards');
    const main = page.getByRole('main');
    const draft = main.getByRole('button', { name: 'Draft a standard' });
    await expect(draft).toBeEnabled();
    expect(issues('control', await layout(page, main))).toEqual([]);
    const style = await page.addStyleTag({ content: '#main-content { min-width: calc(100vw + 51px); }' });
    const wide = await layout(page, main);
    expect(issues('control', wide)).toContain('control: document overflow');
    await style.evaluate(el => el.parentNode!.removeChild(el));
    const overlay = await page.addStyleTag({ content: '#main-content::after { content: ""; position: fixed; inset: 0; z-index: 100; }' });
    const blocked = await layout(page, main);
    expect(issues('control', blocked)).toContain('control: Draft a standard clipped or obscured');
    await overlay.evaluate(el => el.parentNode!.removeChild(el));
    expect(issues('control', await layout(page, main))).toEqual([]);
    await info.attach('geometry-negative-controls', { contentType: 'application/json', body: JSON.stringify({ wide, blocked }) });
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    fx.close();
  }
});

test('registration preserves a deliberate keyboard focus move while the service responds', async ({ page }) => {
  const fx = await t16Fixture(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  try {
    await page.route('**/api/v1/edits', async route => {
      if (route.request().method() === 'POST') { started(); await held; }
      await route.fallback();
    });
    await page.goto('/standards');
    const draft = page.getByRole('button', { name: 'Draft a standard' });
    await draft.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Draft a standard' });
    const submit = dialog.getByRole('button', { name: 'Register edit' });
    await tabTo(page, submit, []);
    await page.keyboard.press('Enter');
    await pending;
    await expect(submit).toBeDisabled();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+Tab');
    const close = dialog.getByRole('button', { name: 'Close dialog' });
    await expect(close).toBeFocused();
    release();
    await expect(dialog.getByTestId('file-state')).toHaveText('Waiting for save');
    await expect(close).toBeFocused();
    expect(fx.requests.filter(req => req.method === 'POST' && req.path === '/api/v1/edits')).toHaveLength(1);
    await page.keyboard.press('Escape');
    await expect(draft).toBeFocused();
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
    fx.close();
  }
});
