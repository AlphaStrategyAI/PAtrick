/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { channelTestSchema } from '@patrick/contracts/resources';
import { feishuSetupCopy } from '../../apps/web/src/features/settings/FeishuSetupCopy.js';
import rendering from '../../apps/web/rendering.lock.json' with { type: 'json' };
import audit from '../../docs/designs/设计资产/v2/Figma-界面核对.json' with { type: 'json' };
import lock from '../../design-inputs.lock.json' with { type: 'json' };
import { clickCommand, messages, startWrites, type Locale } from './T24-edit-fixture.js';
import { device, stamp, withVault } from './T24-vault-fixture.js';
import { hash, sample, synthetic, withChannel, withSecureWeb } from './T24-feishu-fixture.js';

const prefix = '/api/v1/channels/feishu';
const rows = {
  en: { 'settings:group:interaction': ['175:6549', '26:2361', '172:5101'], 'v26:fs-connect': ['175:5480', '172:5101', '187:18986'],
    'v26:fs-poll-pair': ['187:20029', '187:19703', '187:20378'], 'v26:fs-confirm-owner': ['187:20714', '187:20378', '188:5972'],
    'v26:fs-reject-owner': ['187:20718', '187:20378', '187:19703'], 'v26:fs-test-preview': ['188:6332', '188:5972', '188:6715'] },
  zh: { 'settings:group:interaction': ['175:5750', '172:5457', '187:18656'], 'v26:fs-connect': ['187:18965', '187:18656', '187:19343'],
    'v26:fs-poll-pair': ['187:20368', '187:20039', '188:5623'], 'v26:fs-confirm-owner': ['188:5962', '188:5623', '188:6342'],
    'v26:fs-reject-owner': ['188:5966', '188:5623', '187:20039'], 'v26:fs-test-preview': ['188:6705', '188:6342', '188:7158'] },
} as const;
type Action = keyof typeof rows.en;
type Checkpoint = { frame: string; route: string; visible: string };
type Edge = { locale: Locale; action: Action; from: Checkpoint; to: Checkpoint; clicks: string[]; variance: string };
const locales = ['en', 'zh'] as const;
const bot = (page: Page, locale: Locale) => page.getByRole('region', { name: feishuSetupCopy[locale].title });

async function state(page: Page, locale: Locale): Promise<Checkpoint> {
  const route = new URL(page.url()).pathname;
  const t = messages[locale], copy = feishuSetupCopy[locale], region = bot(page, locale);
  await expect(page.locator('html')).toHaveAttribute('lang', locale === 'en' ? 'en' : 'zh-CN');
  const found = (frame: string, visible: string) => ({ frame: locale + '-' + frame, route, visible });
  if (route === '/settings/materials' && await page.getByRole('button', { name: t['settings.confirmApply'] }).isVisible())
    return found('obs-review', t['settings.confirmApply']);
  if (route === '/settings' && await page.getByRole('link', { name: t['settings.interaction'], exact: true }).isVisible())
    return found('settings', t['settings.interaction']);
  expect(route).toBe('/settings/interaction');
  if (!await region.locator('details').evaluate(el => el.hasAttribute('open'))) return found('feishu-home', await region.getByRole('status').innerText());
  if (await region.getByText(copy.test.previewed, { exact: true }).isVisible()) return found('feishu-preview', copy.test.previewed);
  if (await region.getByRole('button', { name: copy.preview }).isVisible()) return found('feishu-test', copy.preview);
  if (await region.getByRole('button', { name: copy.confirm }).isVisible()) return found('feishu-owner', copy.confirm);
  if (await region.locator('code').isVisible()) return found('feishu-pair', copy.pairingSend);
  if (await region.getByLabel(copy.secret).isVisible()) return found('feishu-connect', copy.secret);
  if (await region.getByText(copy.secureUnavailable, { exact: true }).isVisible()) return found('http-setup-unavailable', copy.secureUnavailable);
  throw new Error('Unrecognized Feishu checkpoint at ' + route);
}

function verify(edges: Edge[]) {
  const frames = new Map(audit.frames.map(f => [f.key, f.id]));
  expect(edges).toHaveLength(12);
  for (const locale of locales) for (const action of Object.keys(rows[locale]) as Action[]) {
    const [node, from, to] = rows[locale][action];
    const matches = edges.filter(edge => edge.locale === locale && edge.action === action);
    expect(matches, node + ' locale and action').toHaveLength(1);
    const edge = matches[0];
    const locked = audit.prototypeLinks.sample.filter(link => link.id === node);
    expect(locked, node + ' observed endpoints').toEqual([{ id: node, action, matched: true, from: edge.from.frame, to: edge.to.frame }]);
    expect([frames.get(edge.from.frame), frames.get(edge.to.frame)]).toEqual([from, to]);
    const expectedClicks = locale === 'zh' && action === 'settings:group:interaction' ? 2 : 1;
    expect(edge.clicks).toHaveLength(expectedClicks);
  }
}

async function inBrowser(browser: Browser, locale: Locale, secure: boolean, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ locale: locale === 'en' ? 'en-US' : 'zh-CN', ignoreHTTPSErrors: secure });
  try {
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(stamp));
    await run(page);
  } finally { await context.close(); }
}

async function capture(info: TestInfo, name: string, data: unknown) {
  await info.attach(name, { body: JSON.stringify(data, null, 2), contentType: 'application/json' });
}

async function settingsNavigation(page: Page, locale: Locale, edges: Edge[], info: TestInfo) {
  const t = messages[locale], copy = feishuSetupCopy[locale];
  await withVault(page, 't24-feishu-navigation', async ({ db }) => {
    const clicks: string[] = [];
    const writes = startWrites(page);
    if (locale === 'zh') {
      await page.goto('/settings/materials');
      await page.getByRole('combobox', { name: t['settings.selectTarget'] }).selectOption(JSON.stringify(['t24-feishu-navigation', device]));
      const next = page.getByRole('button', { name: t['wizard.next'] });
      await next.click();
      await expect(page.getByText(t['settings.validationPassed'], { exact: true })).toBeVisible();
      await next.click();
      await expect(page.getByRole('button', { name: t['settings.confirmApply'] })).toBeEnabled();
    } else {
      await page.goto('/settings');
      await expect(page.getByRole('link', { name: t['settings.interaction'], exact: true })).toBeVisible();
    }
    const from = await state(page, locale), start = writes.length;
    if (locale === 'zh') {
      await expect(page.getByRole('link', { name: t['settings.interaction'], exact: true })).toHaveCount(0);
      await page.getByRole('navigation').getByRole('link', { name: t['nav.settings'], exact: true }).click();
      await expect(page).toHaveURL('http://localhost/settings');
      clicks.push(t['nav.settings']);
    }
    await page.getByRole('link', { name: t['settings.interaction'], exact: true }).click();
    clicks.push(t['settings.interaction']);
    const region = bot(page, locale);
    await expect(region.getByText(copy.connection.not_configured, { exact: true })).toBeVisible();
    const home = await state(page, locale);
    edges.push({ locale, action: 'settings:group:interaction', from, to: home, clicks,
      variance: locale === 'en' ? 'one-click navigation' : 'two clicks via Settings index' });
    await region.getByText(copy.setup, { exact: true }).click();
    await expect(region.getByText(copy.secureUnavailable, { exact: true })).toBeVisible();
    await expect(region.getByLabel(copy.secret)).toHaveCount(0);
    const unavailable = await state(page, locale);
    expect(writes.slice(start)).toEqual([]);
    expect(db.prepare('SELECT count(*) FROM channel_connections').pluck().get()).toBe(0);
    expect(db.prepare('SELECT count(*) FROM settings_changes').pluck().get()).toBe(0);
    await capture(info, locale + '-http', { from, home, unavailable, clicks, writesAfterSource: writes.slice(start) });
  });
}

async function form(page: Page, origin: string, locale: Locale, edges: Edge[], info: TestInfo) {
  const t = messages[locale], copy = feishuSetupCopy[locale], region = bot(page, locale);
  await withChannel(page, origin, false, async ({ db, requests }) => {
    const writes = startWrites(page);
    await page.goto(origin + '/settings/interaction');
    await expect(region.getByRole('status')).toHaveText(copy.connection.not_configured);
    const from = await state(page, locale);
    await region.getByText(copy.setup, { exact: true }).click();
    await expect(region.getByLabel(copy.secret)).toBeVisible();
    const guide = locale === 'en' ? 'Bot setup guide' : '机器人配置指引';
    await expect(region.getByRole('button', { name: guide, exact: true })).toHaveCount(0);
    await expect(region.getByRole('link', { name: guide, exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => location.protocol === 'https:' && isSecureContext)).toBe(true);
    expect(writes).toEqual([]);
    expect(db.prepare('SELECT count(*) FROM channel_connections').pluck().get()).toBe(0);
    edges.push({ locale, action: 'v26:fs-connect', from, to: await state(page, locale), clicks: [copy.setup],
      variance: 'one-click credential fields in a disclosure on Interaction' });
    await region.getByLabel(copy.appId).fill(synthetic.app);
    await region.getByLabel(copy.secret).fill('synthetic-local-test-value');
    await region.getByRole('button', { name: copy.stage }).click();
    // The endpoint only holds the secret; the connection is configured by a
    // trusted change.
    await expect(region.getByRole('heading', { name: t['settings.feishuConfigure'] })).toBeVisible();
    expect(db.prepare('SELECT count(*) FROM channel_connections').pluck().get()).toBe(0);
    await region.getByLabel(t['settings.selectTarget']).selectOption({ label: synthetic.app });
    await region.getByRole('button', { name: t['wizard.next'] }).click();
    await expect(region.getByText(t['settings.validationPassed'], { exact: true })).toBeVisible();
    await region.getByRole('button', { name: t['wizard.next'] }).click();
    await region.getByRole('button', { name: t['settings.confirmApply'] }).click();
    await expect(region.getByText(copy.nativeProbeRequired, { exact: true })).toBeVisible();
    await expect(region.getByRole('button', { name: copy.pairingStart })).toBeDisabled();
    const staged = db.prepare('SELECT app_id,status,transport_mode,reason_code FROM channel_connections').get();
    expect(staged).toEqual({ app_id: synthetic.app, status: 'needs_binding', transport_mode: 'probe', reason_code: 'NATIVE_PROBE_REQUIRED' });
    expect(db.prepare('SELECT count(*) FROM channel_pairings').pluck().get()).toBe(0);
    expect(writes[0]).toEqual({ method: 'POST', path: prefix + '/credentials' });
    expect(writes.some((write) => write.path === '/api/v1/settings/changes')).toBe(true);
    await capture(info, locale + '-staged', { origin, staged, guideControlAbsent: guide, writes, requests });
  });
}

async function pairing(page: Page, origin: string, locale: Locale, edges: Edge[], info: TestInfo) {
  const copy = feishuSetupCopy[locale], region = bot(page, locale);
  const button = (name: string) => region.getByRole('button', { name, exact: true });
  await withChannel(page, origin, true, async ({ db, requests, receive }) => {
    const writes = startWrites(page);
    await page.goto(origin + '/settings/interaction');
    await expect(region.getByRole('status')).toHaveText(copy.connection.needs_binding);
    await region.getByText(copy.setup, { exact: true }).click();
    const create = await clickCommand(page, () => button(copy.pairingStart).click(), prefix + '/bindings');
    const code = region.locator('code');
    await expect(code).toBeVisible();
    const shown = await code.innerText();
    expect(shown).toMatch(/^[A-Za-z0-9_-]{24}$/u);
    const open = db.prepare('SELECT pairing_id,status,code_hash FROM channel_pairings').get() as { pairing_id: string; status: string; code_hash: string };
    expect(open).toMatchObject({ status: 'open', code_hash: hash(shown) });
    let id = open.pairing_id;
    const pairStage = await state(page, locale);
    expect(create.command.receipt_url).toBe(prefix + '/bindings/' + id);
    await receive(shown);
    const candidate = db.prepare('SELECT status,candidate_open_id,candidate_chat_id FROM channel_pairings WHERE pairing_id=?').get(id);
    expect(candidate).toEqual({ status: 'candidate', candidate_open_id: synthetic.owner, candidate_chat_id: synthetic.chat });
    await expect(code).toBeVisible();
    await expect(button(copy.confirm)).toHaveCount(0);
    const beforePoll = writes.length;
    const [poll] = await Promise.all([page.waitForResponse(res => res.request().method() === 'GET' &&
      new URL(res.url()).pathname === prefix + '/bindings/current'), button(copy.refresh).click()]);
    expect(poll.ok()).toBe(true);
    const polled = (await poll.json()).data;
    expect(polled).toMatchObject({ pairing_id: id, status: 'candidate', candidate_open_id: synthetic.owner, code: null });
    await expect(region.getByText(copy.identity + ': ' + synthetic.owner, { exact: true })).toBeVisible();
    await expect(region.getByText(copy.domain + ': personal', { exact: true })).toBeVisible();
    await expect(code).toHaveCount(0);
    expect(writes.slice(beforePoll)).toEqual([]);
    expect(db.prepare('SELECT count(*) FROM channel_bindings').pluck().get()).toBe(0);
    const owner = await state(page, locale);
    edges.push({ locale, action: 'v26:fs-poll-pair', from: pairStage, to: owner, clicks: [copy.refresh], variance: 'one-click read of a locally delivered candidate' });
    const rejectedId = id;
    const rejectButton = button(copy.reject);
    await rejectButton.focus();
    await expect(rejectButton).toBeFocused();
    const reject = await clickCommand(page, () => rejectButton.press('Enter'), prefix + '/bindings/reject');
    expect(reject.request.payload).toEqual({ pairing_id: rejectedId });
    await expect(code).toBeVisible();
    const replacementCode = await code.innerText();
    expect(replacementCode).not.toBe(shown);
    id = db.prepare('SELECT current_pairing_id FROM channel_connections').pluck().get() as string;
    expect(id).not.toBe(rejectedId);
    expect(reject.command.receipt_url).toBe(prefix + '/bindings/' + id);
    expect(requests.filter(req => req.path === reject.command.receipt_url && req.method === 'GET')).toEqual([
      { path: reject.command.receipt_url, method: 'GET', status: 200 },
    ]);
    expect(db.prepare('SELECT status,code_hash FROM channel_pairings WHERE pairing_id=?').get(id)).toEqual({ status: 'open', code_hash: hash(replacementCode) });
    expect(db.prepare('SELECT status FROM channel_pairings WHERE pairing_id=?').pluck().get(rejectedId)).toBe('expired');
    expect(db.prepare('SELECT count(*) FROM channel_bindings').pluck().get()).toBe(0);
    expect(db.prepare('SELECT count(*) FROM channel_tests').pluck().get()).toBe(0);
    edges.push({ locale, action: 'v26:fs-reject-owner', from: owner, to: await state(page, locale), clicks: [copy.reject],
      variance: 'keyboard rejection of a synthetic candidate and one-read replacement code' });
    await page.reload();
    await region.getByText(copy.setup, { exact: true }).click();
    await expect(button(copy.pairingStart)).toBeEnabled();
    await expect(code).toHaveCount(0);
    await receive(replacementCode);
    await button(copy.refresh).click();
    await expect(button(copy.confirm)).toBeEnabled();
    const confirm = await clickCommand(page, () => button(copy.confirm).click(), prefix + '/bindings/' + id + '/confirm');
    expect(confirm.command.receipt_url).toBe(prefix + '/bindings/' + id);
    await expect(region.getByRole('status')).toHaveText(copy.connection.needs_test);
    await expect(button(copy.preview)).toBeEnabled();
    const testStage = await state(page, locale);
    const binding = db.prepare('SELECT binding_id,pairing_id,owner_open_id,chat_id,app_id,tenant_key,data_domain FROM channel_bindings').get() as { binding_id: string };
    expect(binding).toMatchObject({ pairing_id: id, owner_open_id: synthetic.owner, chat_id: synthetic.chat, app_id: synthetic.app,
      tenant_key: synthetic.tenant, data_domain: 'personal' });
    expect(db.prepare('SELECT status FROM channel_pairings WHERE pairing_id=?').pluck().get(id)).toBe('consumed');
    expect(db.prepare('SELECT count(*) FROM channel_tests').pluck().get()).toBe(0);
    edges.push({ locale, action: 'v26:fs-confirm-owner', from: owner, to: testStage, clicks: [copy.confirm], variance: 'one-click scoped owner confirmation' });
    const prepare = await clickCommand(page, () => button(copy.preview).click(), prefix + '/tests');
    expect(prepare.request.payload).toEqual({ destination: synthetic.owner });
    await expect(region.locator('blockquote')).toHaveText(sample);
    await expect(region.getByText(copy.test.previewed, { exact: true })).toBeVisible();
    await expect(button(copy.send)).toBeDisabled();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const preview = await state(page, locale);
    edges.push({ locale, action: 'v26:fs-test-preview', from: testStage, to: preview, clicks: [copy.preview],
      variance: 'one-click sample preview inline; the locked destination is a dialog' });
    const row = db.prepare('SELECT test_id,status,preview_hash,destination,message_id,inbound_evidence,binding_id FROM channel_tests').get() as { test_id: string };
    const expected = { status: 'previewed', preview_hash: hash(sample), destination: synthetic.owner, message_id: null,
      inbound_evidence: null, binding_id: binding.binding_id };
    expect(row).toMatchObject(expected);
    const receiptPath = prefix + '/tests/' + row.test_id;
    expect(prepare.command.receipt_url).toBe(receiptPath);
    const receipt = page.waitForResponse(res => new URL(res.url()).pathname === receiptPath && res.request().method() === 'GET');
    await page.reload();
    const response = await receipt;
    expect(response.ok()).toBe(true);
    const saved = channelTestSchema.parse((await response.json()).data);
    expect(saved).toMatchObject({ ...expected, test_id: row.test_id, app_id: synthetic.app, tenant_key: synthetic.tenant, data_domain: 'personal' });
    await region.getByText(copy.setup, { exact: true }).click();
    await expect(region.getByText(copy.test.previewed, { exact: true })).toBeVisible();
    await expect(button(copy.send)).toBeDisabled();
    expect(db.prepare('SELECT status,transport_mode,owner_open_id FROM channel_connections').get())
      .toEqual({ status: 'needs_test', transport_mode: 'probe', owner_open_id: synthetic.owner });
    expect(writes.map(req => req.path)).toEqual([prefix + '/bindings', prefix + '/bindings/reject', prefix + '/bindings/' + id + '/confirm', prefix + '/tests']);
    const environment = await page.evaluate(async () => {
      await document.fonts.ready;
      return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, language: document.documentElement.lang,
        clock: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        light: matchMedia('(prefers-color-scheme: light)').matches, fonts: [...new Set([...document.fonts].filter(f => f.status === 'loaded').map(f => f.family))] };
    });
    expect(environment).toMatchObject({ ...rendering.viewports.desktop, dpr: rendering.deviceScaleFactor, clock: stamp, timezone: rendering.rendering.timezone, reduced: true, light: true });
    await capture(info, locale + '-probe', { environment, origin, pairId: id, initialPairingStatus: open.status, candidate, polled, rejectedId, commands: { create, reject, confirm, prepare }, binding, saved, writes, requests });
  });
}

async function staleRejection(page: Page, origin: string, locale: Locale) {
  const copy = feishuSetupCopy[locale], region = bot(page, locale);
  const button = (name: string) => region.getByRole('button', { name, exact: true });
  await withChannel(page, origin, true, async ({ db, requests, receive }) => {
    await page.goto(origin + '/settings/interaction');
    await region.getByText(copy.setup, { exact: true }).click();
    await button(copy.pairingStart).click();
    const code = region.locator('code');
    await expect(code).toBeVisible();
    await receive(await code.innerText());
    await button(copy.refresh).click();
    await expect(button(copy.reject)).toBeEnabled();
    const path = prefix + '/bindings/reject';
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**' + path, async route => { await held; await route.fallback(); });
    const checkpoint = requests.length;
    try {
      await button(copy.reject).click();
      await expect(button(copy.confirm)).toBeDisabled();
      await expect(button(copy.reject)).toBeDisabled();
      db.prepare("UPDATE channel_pairings SET expires_at='2020-01-01T00:00:00.000Z'").run();
    } finally { release(); }
    await expect(button(copy.pairingStart)).toBeEnabled();
    await expect(region.getByRole('alert')).toBeVisible();
    await expect(code).toHaveCount(0);
    const after = requests.slice(checkpoint);
    expect(after.filter(r => r.method === 'POST')).toEqual([{ method: 'POST', path, status: 409 }]);
    expect(after.filter(r => r.method === 'GET').map(r => r.path)).toEqual(expect.arrayContaining([prefix, prefix + '/bindings/current']));
    expect(db.prepare('SELECT count(*) FROM channel_pairings').pluck().get()).toBe(1);
  });
}

for (const locale of locales) {
  test(locale + ' owner manually recovers pairing after a lost rejection response without a credential provider', async ({ browser }) => {
    await withSecureWeb(async origin => inBrowser(browser, locale, true, async page => {
      const region = bot(page, locale), copy = feishuSetupCopy[locale];
      const button = (name: string) => region.getByRole('button', { name, exact: true });
      await withChannel(page, origin, true, async ({ db, requests }) => {
        await page.goto(origin + '/settings/interaction');
        await region.getByText(copy.setup, { exact: true }).click();
        const start = button(copy.pairingStart);
        const code = region.locator('code');
        await button(copy.reject).click();
        await expect(region.getByRole('alert')).toBeVisible();
        await expect(start).toBeEnabled();
        await expect(code).toHaveCount(0);
        const lost = db.prepare('SELECT current_pairing_id FROM channel_connections').pluck().get();
        expect(db.prepare('SELECT status FROM channel_pairings ORDER BY rowid').pluck().all()).toEqual(['expired', 'open']);
        await page.reload();
        await region.getByText(copy.setup, { exact: true }).click();
        await expect(start).toBeEnabled();
        await expect(code).toHaveCount(0);
        await expect(region.getByLabel(copy.secret)).toHaveCount(0);
        expect(requests.filter(r => r.method === 'POST').map(r => [r.path, r.status])).toEqual([
          [prefix + '/bindings/reject', 202],
        ]);
        await start.click();
        await expect(code).toBeVisible();
        const current = db.prepare("SELECT pairing_id,code_hash FROM channel_pairings WHERE status='open'").get() as { pairing_id: string; code_hash: string };
        expect(current.pairing_id).not.toBe(lost);
        expect(current.code_hash).toBe(hash(await code.innerText()));
        expect(db.prepare('SELECT status FROM channel_pairings ORDER BY rowid').pluck().all()).toEqual(['expired', 'expired', 'open']);
        expect(db.prepare('SELECT count(*) FROM channel_bindings').pluck().get()).toBe(0);
        expect(db.prepare('SELECT count(*) FROM channel_tests').pluck().get()).toBe(0);
      }, { withoutCredentials: true, loseRejectResponse: true, seedCandidate: true });
    }));
  });
}

test('frame-coverage · bilingual Feishu navigation, setup, pairing, owner and preview', async ({ browser }, info) => {
  const path = 'docs/designs/设计资产/v2/Figma-界面核对.json';
  expect(hash(readFileSync(new URL('../../' + path, import.meta.url)).toString())).toBe(lock.files[path]);
  expect(browser.version()).toBe(rendering.chromium.version);
  const edges: Edge[] = [];
  await withSecureWeb(async origin => {
    for (const locale of locales) {
      await inBrowser(browser, locale, false, page => settingsNavigation(page, locale, edges, info));
      await inBrowser(browser, locale, true, page => form(page, origin, locale, edges, info));
      await inBrowser(browser, locale, true, page => pairing(page, origin, locale, edges, info));
      await inBrowser(browser, locale, true, page => staleRejection(page, origin, locale));
    }
  });
  verify(edges);
  const wrong = edges.map(e => e.action === 'v26:fs-confirm-owner' && e.locale === 'en' ? { ...e, to: e.from } : e);
  expect(() => verify(wrong)).toThrow(/187:20714 observed endpoints/u);
  expect(() => verify(edges.filter(e => e.action !== 'v26:fs-test-preview' || e.locale !== 'zh'))).toThrow();
  await capture(info, 'feishu-edges', edges.map(e => ({ ...e, lockedNodeSourceTarget: rows[e.locale][e.action] })));
});

test('the owner stages a new credential and rotates it through the trusted change', async ({ browser }) => {
  await withSecureWeb(async origin => {
    await inBrowser(browser, 'en', true, page => withChannel(page, origin, true, async fx => {
      await page.goto(origin + '/settings/interaction');
      const region = page.getByRole('region', { name: 'Feishu bot' });
      await region.getByText(feishuSetupCopy.en.setup, { exact: true }).click();
      await expect(region.getByLabel('New app secret')).toBeVisible({ timeout: 10_000 });
      const before = fx.db.prepare('SELECT credential_ref, credential_version FROM channel_connections').get();
      await region.getByLabel('New app secret').fill('rotated-secret-only');
      await region.getByRole('button', { name: 'Stage a new secret' }).click();
      await expect(region.getByRole('heading', { name: 'Rotate the Feishu credential' })).toBeVisible({ timeout: 10_000 });
      // Staging a candidate never replaces the credential the connection still uses.
      expect(fx.db.prepare('SELECT credential_ref, credential_version FROM channel_connections').get()).toEqual(before);
      expect(fx.requests.some(({ method, path }) => method === 'POST' && path.endsWith('/credentials'))).toBe(true);
    }));
  });
});
