import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { canonicalPayload } from '@patrick/contracts';
import audit from '../../docs/designs/设计资产/v2/Figma-界面核对.json' with { type: 'json' };
import lock from '../../design-inputs.lock.json' with { type: 'json' };
import rendering from '../../apps/web/rendering.lock.json' with { type: 'json' };
import { t16Fixture } from '../e2e/T16-fixture.js';
import { clickCommand, hash, messages, readReceipt, register, showReceipt, stamp, startWrites, temporaryVault,
  type Fixture, type Locale, type Receipt } from './T24-edit-fixture.js';

// Locked rows list the source and destination *frames* of the design, including known runtime variances.
const rows = {
  en: {
    supplement: ['185:5611', '115:3431', '188:13374'], file: ['188:13647', '188:13374', '188:14209'],
    standard: ['187:5433', '172:5844', '188:15799'], 'standard-new': ['187:5437', '172:5844', '188:15044'],
    export: ['188:18832', '188:18517', '172:5844'],
  },
  zh: {
    supplement: ['185:6025', '115:3844', '188:13790'], file: ['188:14066', '188:13790', '188:14625'],
    standard: ['175:8577', '26:1385', '188:16174'], 'standard-new': ['175:8581', '26:1385', '188:15419'],
    export: ['188:19164', '188:18846', '188:18189'],
  },
} as const;
type Action = keyof typeof rows.en;
type Edge = { locale: Locale; action: Action; source: string; destination: string; clicks: string[];
  correspondence: 'one-click semantic endpoint' | 'additional actions' | 'different source' | 'locked source unavailable' };
const locales = ['en', 'zh'] as const;

function verify(edges: Edge[]) {
  const frames = new Map(audit.frames.map(frame => [frame.key, frame.id]));
  expect(edges).toHaveLength(10);
  for (const locale of locales) {
    for (const action of Object.keys(rows[locale]) as Action[]) {
      const [node, from, to] = rows[locale][action];
      const locked = audit.prototypeLinks.sample.filter(row => row.id === node);
      expect(locked).toHaveLength(1);
      expect(locked[0]).toMatchObject({ action: 'v26:edit-' + action, matched: true });
      expect([frames.get(locked[0].from), frames.get(locked[0].to)]).toEqual([from, to]);
      const observed = edges.filter(edge => edge.locale === locale && edge.action === action);
      expect(observed).toHaveLength(1);
      const edge = observed[0];
      expect(locale + '-' + edge.destination, node + ' runtime destination').toBe(locked[0].to);
      if (edge.correspondence === 'one-click semantic endpoint' || edge.correspondence === 'additional actions') {
        expect(locale + '-' + edge.source, node + ' runtime source').toBe(locked[0].from);
      } else expect(locale + '-' + edge.source).not.toBe(locked[0].from);
      if (edge.correspondence === 'one-click semantic endpoint') expect(edge.clicks).toHaveLength(1);
    }
  }
}

function frameFor(operation: string, receipt: Receipt) {
  if (operation === 'supplement_knowledge' || operation === 'edit_original') {
    if (receipt.file.state === 'collected') return 'edit-knowledge-ingested';
    if (receipt.file.state === 'awaiting_save') return 'edit-knowledge';
  }
  if (operation === 'revise_standard' && receipt.business.state === 'adopted') {
    if (receipt.projection.state === 'failed') return 'edit-standard-pending';
    if (receipt.projection.state === 'current') return 'edit-standard-adopted';
  }
  if (receipt.file.state === 'awaiting_save') {
    if (operation === 'revise_standard') return 'edit-standard';
    if (operation === 'create_standard') return 'edit-standard-new';
  }
  throw new Error('No observed editing frame for ' + operation + ' ' + JSON.stringify(receipt));
}

type Run = { page: Page; fx: Fixture; starts: ReturnType<typeof startWrites>; locale: Locale; info: TestInfo; edges: Edge[] };
async function withEditor(browser: Browser, locale: Locale, info: TestInfo, edges: Edge[],
  scenario: string, route: '/knowledge' | '/standards', seedStandard: boolean, body: (run: Run) => Promise<unknown>) {
  const context = await browser.newContext({ locale: locale === 'en' ? 'en-US' : 'zh-CN' });
  try {
    const page = await context.newPage();
    const starts = startWrites(page);
    const fx = await t16Fixture(page, seedStandard);
    try {
      await page.clock.setFixedTime(new Date(stamp));
      await page.goto(route);
      await expect(page.locator('html')).toHaveAttribute('lang', locale === 'en' ? 'en' : 'zh-CN');
      const proof = await body({ page, fx, starts, locale, info, edges });
      const environment = await page.evaluate(async () => {
        await document.fonts.ready;
        return { lang: document.documentElement.lang, width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, clock: new Date().toISOString(),
          light: matchMedia('(prefers-color-scheme: light)').matches, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
          loadedFonts: [...new Set([...document.fonts].filter(f => f.status === 'loaded').map(f => f.family))].sort() };
      });
      expect(environment).toMatchObject({ ...rendering.viewports.desktop, dpr: rendering.deviceScaleFactor,
        timezone: rendering.rendering.timezone, clock: stamp, reduced: true, light: true });
      const requests = fx.requests.map(({ method, path, status }) => ({ method, path, status }));
      await info.attach(locale + '-' + scenario, { contentType: 'application/json',
        body: JSON.stringify({ environment, proof, writeStarts: starts, completed: requests }, null, 2) });
    } finally {
      await page.unrouteAll({ behavior: 'wait' });
      fx.close();
    }
  } finally { await context.close(); }
}

async function knowledge({ page, fx, locale, starts, edges }: Run, supplement: boolean) {
  const t = messages[locale];
  const operation = supplement ? 'supplement_knowledge' : 'edit_original';
  const root = temporaryVault(fx);
  const sourceFile = join(root, '知识笔记', '原文.md');
  const sourceHash = hash(readFileSync(sourceFile));
  await page.getByRole('button', { name: 'k-t16', exact: true }).click();
  await page.getByRole('button', { name: t['learning.sourceLocation'] }).click();
  await expect(page.getByText('知识笔记/原文.md', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(starts).toEqual([]);
  const draft = await register(page, fx, locale, operation, starts);
  expect(draft.request.payload).toMatchObject(supplement ? { knowledge_id: 'k-t16', expected_knowledge_revision: 1 }
    : { knowledge_id: 'k-t16', document_id: draft.record.document_id, expected_source_revision: 1 });
  const draftFrame = frameFor(operation, draft.receipt);
  if (supplement) edges.push({ locale, action: 'supplement', source: 'inline-knowledge-evidence', destination: draftFrame,
    clicks: [t['edits.operation.supplement_knowledge'], t['edits.register']], correspondence: 'different source' });
  const id = draft.receipt.edit_id;
  const expectedPath = supplement ? '知识笔记/补充/k-t16.md' : '知识笔记/原文.md';
  expect(draft.record.relative_path).toBe(expectedPath);
  const target = join(root, expectedPath);
  const before = hash(readFileSync(target));
  if (supplement) appendFileSync(target, '\nT24 synthetic supplement saved for this note.\n');
  else fx.saveOriginal();
  const saved = hash(readFileSync(target));
  expect(saved).not.toBe(before);
  const check = page.getByRole('button', { name: t['edits.check'], exact: true });
  await expect(check).toBeEnabled();
  let command: Awaited<ReturnType<typeof clickCommand>> | undefined;
  const collected = await readReceipt(page, id, async () => { command = await clickCommand(page, () => check.click(), '/api/v1/edits/' + id + '/checks'); });
  expect(command).toMatchObject({ command: { receipt_url: '/api/v1/edits/' + id }, request: { expected_revision: draft.receipt.receipt_revision, payload: {} } });
  expect(collected).toMatchObject({ file: { state: 'collected', proof_ref: saved }, business: draft.receipt.business, projection: draft.receipt.projection });
  expect(collected.receipt_revision).toBeGreaterThan(draft.receipt.receipt_revision);
  const ui = await showReceipt(page, locale, collected);
  const evidence = fx.db.prepare(`SELECT e.evidence_id,e.knowledge_id,e.document_id,e.revision_id,r.content_hash
    FROM evidence_refs e JOIN vault_revisions r ON e.revision_id=r.revision_id WHERE e.document_id=? AND e.knowledge_id='k-t16'
    AND e.status='supported' AND r.content_hash=?`).get(draft.record.document_id, saved);
  expect(evidence).toBeTruthy();
  if (supplement) expect(hash(readFileSync(sourceFile))).toBe(sourceHash);
  else {
    expect(fx.db.prepare("SELECT 1 FROM vault_documents WHERE relative_path='知识笔记/unrelated.md'").get()).toBeUndefined();
    edges.push({ locale, action: 'file', source: draftFrame, destination: frameFor(operation, collected),
      clicks: [t['edits.check']], correspondence: 'one-click semantic endpoint' });
  }
  const again = await readReceipt(page, id, () => page.getByRole('button', { name: t['edits.refresh'] }).click());
  expect(again).toEqual(collected);
  expect(starts.map(req => req.path)).toEqual(['/api/v1/edits', '/api/v1/edits/' + id + '/checks']);
  return { draft, check: command, before, saved, sourceHash, originalAfter: hash(readFileSync(sourceFile)), evidence, collected, again, ui };
}

async function revision({ page, fx, locale, starts, edges }: Run) {
  const t = messages[locale];
  const btn = (name: string) => page.getByRole('button', { name, exact: true });
  await expect(page.getByText(t['standards.current'] + ' 1', { exact: true })).toBeVisible();
  const draft = await register(page, fx, locale, 'revise_standard', starts);
  expect(draft.request.payload).toMatchObject({ standard_id: 'std-t16', base_version: 1 });
  if (locale === 'zh') edges.push({ locale, action: 'standard', source: 'standards', destination: frameFor(draft.record.operation, draft.receipt),
    clicks: [t['edits.operation.revise_standard'], t['edits.register']], correspondence: 'additional actions' });
  const id = draft.receipt.edit_id;
  await fx.adoptRevision('staging', id);
  const refresh = () => btn(t['edits.refresh']).click();
  const failed = await readReceipt(page, id, refresh);
  expect(failed).toMatchObject({ file: { state: 'collected' }, business: { state: 'adopted' }, projection: { state: 'failed' } });
  const before = await showReceipt(page, locale, failed);
  await expect(page.getByTestId('evaluation-evidence')).toContainText(t['standards.decision.pass']);
  const pointer = () => fx.db.prepare("SELECT intent_id,projection_revision FROM projection_pointers WHERE view_kind='standards'").get();
  const pointerBefore = pointer();
  expect(pointerBefore).not.toEqual({ intent_id: failed.projection.intent_id, projection_revision: failed.projection.projection_revision });
  const manifest = String(fx.db.prepare('SELECT manifest_json FROM projection_batches WHERE intent_id=?').pluck().get(failed.projection.intent_id));
  const frozenHash = (JSON.parse(manifest) as { render: { blob: string } }).render.blob;
  fx.allowProjection();
  const retry = btn(t['edits.retryProjection']);
  await expect(retry).toBeEnabled();
  let command: Awaited<ReturnType<typeof clickCommand>> | undefined;
  const current = await readReceipt(page, id, async () => {
    command = await clickCommand(page, () => retry.click(), '/api/v1/edits/' + id + '/projection-retries');
  });
  expect(command).toMatchObject({ command: { receipt_url: '/api/v1/edits/' + id }, request: { expected_revision: failed.receipt_revision,
    payload: { expected_revision: failed.receipt_revision, intent_id: failed.projection.intent_id, projection_revision: failed.projection.projection_revision } } });
  expect(current).toMatchObject({ file: failed.file, business: failed.business, projection: { ...failed.projection, state: 'current' } });
  expect(current.receipt_revision).toBeGreaterThan(failed.receipt_revision);
  const after = await showReceipt(page, locale, current);
  await expect(retry).toHaveCount(0);
  const files = fx.projectedFiles();
  expect(files['生效标准/当前.md']).toContain('std-t16');
  expect(files['生效标准/当前.md']).toContain('v2');
  expect(hash(canonicalPayload(files))).toBe(frozenHash);
  expect(pointer()).toEqual({ intent_id: failed.projection.intent_id, projection_revision: failed.projection.projection_revision });
  expect(fx.db.prepare("SELECT count(*) FROM adoption_facts WHERE standard_id='std-t16'").pluck().get()).toBe(2);
  expect(await readReceipt(page, id, refresh)).toEqual(current);
  const adoptedFrame = frameFor(draft.record.operation, current);
  edges.push({ locale, action: 'export', source: frameFor(draft.record.operation, failed), destination: adoptedFrame,
    clicks: [t['edits.retryProjection']], correspondence: 'one-click semantic endpoint' });
  const proof = { draft, before, failed, retry: command, after, current, pointerBefore: pointerBefore ?? null,
    pointerAfter: pointer(), frozenHash, projectedFileSha256: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, hash(body)])) };
  if (locale === 'zh') return proof;
  // The EN prototype starts both next actions at an already adopted edit. Leave the real receipt to find the list controls.
  await expect(page.getByRole('dialog').getByRole('button', { name: t['edits.operation.create_standard'] })).toHaveCount(0);
  await expect(page.getByRole('dialog').getByRole('button', { name: t['edits.operation.revise_standard'] })).toHaveCount(0);
  const writes = starts.length;
  await btn(t['button.cancel']).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(t['standards.current'] + ' 2', { exact: true })).toBeVisible();
  await expect(btn(t['edits.operation.create_standard'])).toHaveCount(0);
  expect(starts.length).toBe(writes);
  const next = await register(page, fx, locale, 'revise_standard', starts);
  expect(next.request.payload).toMatchObject({ standard_id: 'std-t16', base_version: 2 });
  edges.push({ locale, action: 'standard', source: adoptedFrame, destination: frameFor(next.record.operation, next.receipt),
    clicks: [t['button.cancel'], t['edits.operation.revise_standard'], t['edits.register']], correspondence: 'additional actions' });
  return { ...proof, createAvailableAfterAdoption: false, next };
}

test('frame-coverage · paired editing registration, saved file and export transitions', async ({ browser }, info) => {
  const path = 'docs/designs/设计资产/v2/Figma-界面核对.json';
  expect(hash(readFileSync(new URL('../../' + path, import.meta.url)))).toBe(lock.files[path]);
  expect(browser.version()).toBe(rendering.chromium.version);
  const edges: Edge[] = [];
  for (const locale of locales) {
    await withEditor(browser, locale, info, edges, 'supplement', '/knowledge', false, run => knowledge(run, true));
    await withEditor(browser, locale, info, edges, 'original', '/knowledge', false, run => knowledge(run, false));
    await withEditor(browser, locale, info, edges, 'revision', '/standards', true, revision);
    await withEditor(browser, locale, info, edges, 'initial', '/standards', false, async ({ page, fx, starts }) => {
      const t = messages[locale];
      await expect(page.getByText(t['empty.standards'], { exact: true })).toBeVisible();
      const draft = await register(page, fx, locale, 'create_standard', starts);
      expect(draft.request.payload).toMatchObject({ expected_active_version: null });
      expect(fx.db.prepare('SELECT count(*) FROM adoption_facts').pluck().get()).toBe(0);
      edges.push({ locale, action: 'standard-new', source: 'standards', destination: frameFor(draft.record.operation, draft.receipt),
        clicks: [t['edits.operation.create_standard'], t['edits.register']],
        correspondence: locale === 'en' ? 'locked source unavailable' : 'additional actions' });
      return draft;
    });
  }
  verify(edges);
  // Replay actual observations with an incorrect file transition and a missing translated retry.
  const wrong = edges.map(edge => edge.locale === 'en' && edge.action === 'file' ? { ...edge, destination: edge.source } : edge);
  expect(() => verify(wrong)).toThrow(/188:13647 runtime destination/u);
  expect(() => verify(edges.filter(edge => edge.locale !== 'zh' || edge.action !== 'export'))).toThrow();
  await info.attach('editing-edges', { contentType: 'application/json', body: JSON.stringify(edges.map(edge => ({
    ...edge, lockedNodeSourceDestination: rows[edge.locale][edge.action],
  })), null, 2) });
});
