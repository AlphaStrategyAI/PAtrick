/// <reference lib="dom" />
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { settingsControlSchema, settingsReceiptSchema, settingsValidationSchema } from '@patrick/contracts/resources';
import audit from '../../docs/designs/设计资产/v2/Figma-界面核对.json' with { type: 'json' };
import lock from '../../design-inputs.lock.json' with { type: 'json' };
import rendering from '../../apps/web/rendering.lock.json' with { type: 'json' };
import { device, stamp, withVault } from './T24-vault-fixture.js';

const stages = {
  en: { draft: 'Target', validation: 'Validation', review: 'Confirmation', ready: 'Verified after applying' },
  zh: { draft: '选择目标', validation: '验证', review: '确认', ready: '应用后复查确认' },
};
const labels = {
  en: { target: 'Registered target', next: 'Continue', back: 'Back', confirm: 'Confirm and apply',
    valid: 'Validation passed', system: 'System', changeUnavailable: 'Change Vault location: Unavailable in this installation' },
  zh: { target: '已登记目标', next: '继续', back: '上一步', confirm: '确认并应用',
    valid: '验证已通过', system: '系统', changeUnavailable: '更换 Vault 位置: 此安装中暂不可用' },
};
type Locale = keyof typeof stages;
type Stage = keyof typeof stages.en;
type Action = 'review' | 'back' | 'apply';
const design = {
  en: { draft: '187:15484', review: '187:16167', ready: '187:16531',
    nodes: { review: '187:15802', back: '187:16513', apply: '187:16509' } },
  zh: { draft: '187:15824', review: '172:5457', ready: '187:16875',
    nodes: { review: '187:16145', back: '175:5849', apply: '175:5845' } },
};
const locales = ['en', 'zh'] as const;
const actions = ['review', 'back', 'apply'] as const;
type Checkpoint = { stage: Stage; text: string; route: string; language: string };
type Observation = { locale: Locale; action: Action; steps: Checkpoint[]; clicks: string[] };

function verifyEdges(observations: Observation[]) {
  const frames = new Map(audit.frames.map(frame => [frame.key, frame.id]));
  expect(observations).toHaveLength(locales.length * actions.length);
  for (const locale of locales) {
    for (const action of actions) {
      const node = design[locale].nodes[action];
      const evidence = observations.filter(row => row.locale === locale && row.action === action);
      expect(evidence, node + ' requires one local runtime observation').toHaveLength(1);
      const { steps } = evidence[0];
      const from = steps[0].stage;
      const to = steps[steps.length - 1].stage;
      const frameKey = (stage: Stage) => locale + '-obs-' + stage;
      const row = audit.prototypeLinks.sample.filter(row => row.id === node);
      expect(row, node + ' runtime endpoints differ from the locked prototype').toEqual([
        { id: node, action: 'v26:obs-' + action, from: frameKey(from), to: frameKey(to), matched: true },
      ]);
      for (const stage of [from, to]) {
        if (stage === 'validation') throw new Error(node + ' has an intermediate step as a design endpoint');
        expect(frames.get(frameKey(stage))).toBe(design[locale][stage]);
      }
    }
  }
}

async function observe(page: Page, locale: Locale, expected: Stage): Promise<Checkpoint> {
  const current = expected === 'ready'
    ? page.getByTestId('settings-change-receipt').getByRole('status')
    : page.locator('main li[aria-current="step"]');
  await expect(current).toHaveText(stages[locale][expected]);
  await expect(current).toBeVisible();
  const text = await current.innerText();
  const stage = (Object.keys(stages[locale]) as Stage[]).find(key => stages[locale][key] === text);
  if (!stage) throw new Error('Unknown browser state: ' + text);
  const language = locale === 'en' ? 'en' : 'zh-CN';
  await expect(page.locator('html')).toHaveAttribute('lang', language);
  expect(new URL(page.url()).pathname).toBe('/settings/materials');
  return { stage, text, route: new URL(page.url()).pathname + new URL(page.url()).search, language };
}

async function clickFor(page: Page, click: () => Promise<void>, path: string, method: 'POST' | 'GET') {
  const [response] = await Promise.all([
    page.waitForResponse(res => new URL(res.url()).pathname === '/api/v1' + path && res.request().method() === method),
    click(),
  ]);
  expect(response.ok(), method + ' ' + path + ' ' + response.status()).toBe(true);
  return (await response.json()).data;
}

async function exercise(page: Page, locale: Locale, info: TestInfo) {
  const vault = 't24-vault-' + locale;
  const name = labels[locale];
  const selected = JSON.stringify([vault, device]);
  const observations: Observation[] = [];
  await withVault(page, vault, async ({ db, state, requests }) => {
    await page.clock.setFixedTime(new Date(stamp));
    await page.goto('/settings/materials');
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    const target = page.getByRole('combobox', { name: name.target, exact: true });
    const receipt = page.getByTestId('settings-change-receipt');
    const initial = state();
    expect(initial).toEqual({ status: 'awaiting_confirmation', revision: 1, epoch: 0, changes: 0, receipts: 0, vaultEvents: 1 });
    await target.selectOption(selected);

    async function toReview() {
      const draft = await observe(page, locale, 'draft');
      await expect(target).toHaveValue(selected);
      const validation = settingsValidationSchema.parse(await clickFor(page, () => button(name.next).click(), '/settings/validations', 'POST'));
      expect(validation).toMatchObject({ valid: true, base_revision: 1, device_id: device });
      const validated = await observe(page, locale, 'validation');
      await expect(page.getByText(name.valid, { exact: true })).toBeVisible();
      await expect(page.locator('main').getByText(vault, { exact: true })).toBeVisible();
      await expect(button(name.confirm)).toHaveCount(0);
      const proposal = settingsControlSchema.parse(await clickFor(page, () => button(name.next).click(), '/settings/control-proposals', 'POST'));
      const review = await observe(page, locale, 'review');
      await expect(page.getByText(proposal.proposal_hash, { exact: true })).toBeVisible();
      await expect(button(name.confirm)).toBeEnabled();
      expect(state()).toEqual(initial);
      return { steps: [draft, validated, review], validation, proposal };
    }

    const first = await toReview();
    observations.push({ locale, action: 'review', steps: first.steps, clicks: [name.next, name.next] });
    const beforeBack = requests.length;
    await button(name.back).click();
    const backOne = await observe(page, locale, 'validation');
    await expect(button(name.confirm)).toHaveCount(0);
    await expect(page.getByText(name.valid, { exact: true })).toBeVisible();
    expect(state()).toEqual(initial);
    await button(name.back).click();
    const backTwo = await observe(page, locale, 'draft');
    await expect(target).toHaveValue(selected);
    await expect(button(name.back)).toBeDisabled();
    await expect(page.getByText(name.valid, { exact: true })).toHaveCount(0);
    expect(requests.slice(beforeBack).filter(req => req.method !== 'GET')).toEqual([]);
    const afterBack = state();
    expect(afterBack).toEqual(initial);
    observations.push({ locale, action: 'back', steps: [first.steps[2], backOne, backTwo], clicks: [name.back, name.back] });

    const final = await toReview();
    expect(final.proposal.proposal_id).not.toBe(first.proposal.proposal_id);
    const settingsRead = page.waitForResponse(res => /\/api\/v1\/settings\/changes\/settings_[\w-]+$/u.test(new URL(res.url()).pathname));
    await button(name.confirm).click();
    const response = await settingsRead;
    expect(response.ok()).toBe(true);
    const settings = settingsReceiptSchema.parse((await response.json()).data);
    expect(settings).toMatchObject({ change_id: expect.stringMatching(/^settings_[a-f0-9-]{36}$/u), validation_id: final.validation.validation_id,
      operation: 'connect_vault', target_id: vault, phase: 'observed', verified: true, issues: [], applied_revision: 1,
      effects: [{ item: 'vault_connection', outcome: 'applied', revision: 1 }] });
    const changeId = settings.change_id;
    await expect(page).toHaveURL('http://localhost/settings/materials?change=' + changeId);
    const ready = await observe(page, locale, 'ready');
    await expect(receipt.locator('code')).toHaveText(changeId);
    await expect(target).toHaveCount(0);
    await expect(page.getByText(name.changeUnavailable, { exact: true })).toBeVisible();
    observations.push({ locale, action: 'apply', steps: [final.steps[2], ready], clicks: [name.confirm] });
    const afterApply = state();
    expect(afterApply).toEqual({ ...initial, status: 'connected', epoch: 1, changes: 1, receipts: 1, vaultEvents: 2 });
    const persisted = db.prepare(`SELECT s.receipt, s.control_receipt_id, s.account_id, s.data_domain, s.target_id, c.proposal_id, c.proposal_hash
      FROM settings_changes s JOIN control_receipts c ON c.receipt_id=s.control_receipt_id WHERE s.change_id=?`).get(changeId) as
      { receipt: string; control_receipt_id: string; account_id: string; data_domain: string; target_id: string; proposal_id: string; proposal_hash: string };
    expect(persisted).toMatchObject({ account_id: 'owner', data_domain: 'personal', target_id: vault,
      proposal_id: final.proposal.proposal_id, proposal_hash: final.proposal.proposal_hash });
    expect(JSON.parse(persisted.receipt)).toEqual(settings);
    const incidentPath = '/system/incidents/' + changeId;
    const system = await clickFor(page, () => receipt.getByRole('link', { name: name.system }).click(), incidentPath, 'GET');
    expect(system).toEqual(settings);
    await expect(page).toHaveURL('http://localhost/system?change=' + changeId);
    const reloaded = await clickFor(page, async () => { await page.reload(); }, incidentPath, 'GET');
    expect(reloaded).toEqual(settings);
    await expect(receipt.locator('code')).toHaveText(changeId);
    await expect(receipt.getByRole('status')).toHaveText(stages[locale].ready);
    expect(state()).toEqual(afterApply);
    const environment = await page.evaluate(async () => {
      await document.fonts.ready;
      return { viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, clock: new Date().toISOString(),
        lang: document.documentElement.lang, preferredLocale: navigator.language,
        light: matchMedia('(prefers-color-scheme: light)').matches, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        usedFontFamilies: [...new Set([...document.fonts].filter(face => face.status === 'loaded').map(face => face.family))].sort() };
    });
    expect(environment).toMatchObject({ viewport: rendering.viewports.desktop, dpr: rendering.deviceScaleFactor,
      timezone: rendering.rendering.timezone, clock: stamp, light: true, reduced: true });
    const edges = observations.map(observation => {
      const nodeId = design[locale].nodes[observation.action];
      const locked = audit.prototypeLinks.sample.find(row => row.id === nodeId)!;
      return { ...observation, nodeId,
        from: audit.frames.find(frame => frame.key === locked.from)?.id,
        to: audit.frames.find(frame => frame.key === locked.to)?.id,
        correspondence: observation.action === 'apply' ? 'one-click semantic endpoint' : 'two-click path via validation' };
    });
    const body = { edges, environment, initial, afterBack, afterApply, firstProposal: first.proposal.proposal_id,
      finalProposal: final.proposal, controlReceipt: persisted.control_receipt_id, settings, system, reloaded, requests };
    await info.attach('vault-' + locale, { contentType: 'application/json', body: JSON.stringify(body, null, 2) });
  });
  return observations;
}

test('frame-coverage · paired Vault review, back and apply runtime transitions', async ({ browser }, info) => {
  const path = 'docs/designs/设计资产/v2/Figma-界面核对.json';
  const bytes = readFileSync(new URL('../../' + path, import.meta.url));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(lock.files[path]);
  expect(browser.version()).toBe(rendering.chromium.version);
  const observations: Observation[] = [];
  for (const locale of locales) {
    const context = await browser.newContext({ locale: locale === 'zh' ? 'zh-CN' : 'en-US' });
    try { observations.push(...await exercise(await context.newPage(), locale, info)); }
    finally { await context.close(); }
  }
  verifyEdges(observations);
  // Mutate genuine browser observations so both an unpaired readback and a wrong destination must be rejected.
  expect(() => verifyEdges(observations.filter(row => row.locale !== 'zh' || row.action !== 'apply'))).toThrow();
  const wrongDestination = observations.map(row => row.locale === 'en' && row.action === 'apply'
    ? { ...row, steps: [row.steps[0], row.steps[0]] } : row);
  expect(() => verifyEdges(wrongDestination)).toThrow(/runtime endpoints differ/u);
});
