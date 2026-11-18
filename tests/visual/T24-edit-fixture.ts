/// <reference lib="dom" />
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { editReceiptSchema } from '@patrick/contracts/resources';
import { t16Fixture } from '../e2e/T16-fixture.js';
import en from '../../apps/web/src/i18n/en.json' with { type: 'json' };
import zh from '../../apps/web/src/i18n/zh.json' with { type: 'json' };

export const stamp = '2026-11-17T05:00:00.000Z';
export const messages = { en, zh };
export type Locale = keyof typeof messages;
export type Fixture = Awaited<ReturnType<typeof t16Fixture>>;
export type Receipt = ReturnType<typeof editReceiptSchema.parse>;
type Operation = 'edit_original' | 'create_standard' | 'revise_standard' | 'supplement_knowledge';
export const hash = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');

export function temporaryVault(fx: Fixture) {
  const root = realpathSync(String(fx.db.prepare("SELECT root_path FROM vaults WHERE vault_id='t16-vault'").pluck().get()));
  const parts = relative(realpathSync(tmpdir()), root).split(sep);
  expect(parts).toHaveLength(2);
  expect(parts[0]).toMatch(/^patrick-t16-[A-Za-z0-9]+$/u);
  expect(parts[1]).toBe('vault');
  return root;
}

export function draftFiles(root: string) {
  return ['知识笔记/补充', '标准修订'].flatMap(dir => existsSync(join(root, dir))
    ? readdirSync(join(root, dir), { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => dir + '/' + entry.name) : []).sort();
}

export function startWrites(page: Page) {
  const writes: { method: string; path: string }[] = [];
  page.on('request', req => {
    const path = new URL(req.url()).pathname;
    if (path.startsWith('/api/v1/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) writes.push({ method: req.method(), path });
  });
  return writes;
}

export async function clickCommand(page: Page, click: () => Promise<void>, path: string) {
  const [response] = await Promise.all([page.waitForResponse(res =>
    new URL(res.url()).pathname === path && res.request().method() === 'POST'), click()]);
  expect(response.status()).toBe(202);
  const command: { command_id: string; receipt_url: string } = await response.json();
  expect(command.command_id).toBeTruthy();
  return { command, request: response.request().postDataJSON() as {
    expected_revision: number | null; payload: Record<string, unknown>;
  } };
}

export async function readReceipt(page: Page, id: string, click: () => Promise<void>) {
  const [response] = await Promise.all([page.waitForResponse(res => res.request().method() === 'GET' &&
    new URL(res.url()).pathname === '/api/v1/edits/' + id), click()]);
  expect(response.ok()).toBe(true);
  const receipt = editReceiptSchema.parse((await response.json()).data);
  expect(receipt.edit_id).toBe(id);
  return receipt;
}

export async function showReceipt(page: Page, locale: Locale, receipt: Receipt) {
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(receipt.edit_id, { exact: true })).toBeVisible();
  const t = messages[locale];
  const progress = dialog.getByTestId('edit-progress');
  await expect(progress.getByTestId('file-state')).toHaveText(t[`edits.file.${receipt.file.state}`]);
  await expect(progress.getByTestId('business-state')).toHaveText(t[`edits.business.${receipt.business.state}`]);
  const projection = receipt.projection.state === 'failed' && receipt.business.state === 'adopted' ? 'adopted_pending' : receipt.projection.state;
  await expect(progress.getByTestId('projection-state')).toHaveText(t[`edits.projection.${projection}`]);
  return { id: receipt.edit_id, route: new URL(page.url()).pathname, dialog: await dialog.getByRole('heading').first().innerText(),
    file: await progress.getByTestId('file-state').innerText(), business: await progress.getByTestId('business-state').innerText(),
    projection: await progress.getByTestId('projection-state').innerText() };
}

export async function register(page: Page, fx: Fixture, locale: Locale, operation: Operation, starts: ReturnType<typeof startWrites>) {
  const name = messages[locale][`edits.operation.${operation}`];
  const root = temporaryVault(fx);
  const filesBefore = draftFiles(root);
  const original = hash(readFileSync(join(root, '知识笔记', '原文.md')));
  const beforeIntents = Number(fx.db.prepare('SELECT count(*) FROM edit_intents').pluck().get());
  const beforeWrites = starts.length;
  await page.getByRole('button', { name, exact: true }).click();
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog).toBeVisible();
  const submit = dialog.getByRole('button', { name: messages[locale]['edits.register'] });
  await expect(submit).toBeEnabled();
  await expect(dialog.getByTestId('edit-progress')).toHaveCount(0);
  expect(starts.length).toBe(beforeWrites);
  expect(Number(fx.db.prepare('SELECT count(*) FROM edit_intents').pluck().get())).toBe(beforeIntents);
  expect(draftFiles(root)).toEqual(filesBefore);
  const result = await clickCommand(page, () => submit.click(), '/api/v1/edits');
  expect(result.request).toMatchObject({ expected_revision: null, payload: { operation } });
  expect(result.command.receipt_url).toMatch(/^\/api\/v1\/edits\/[\w-]+$/u);
  const id = result.command.receipt_url.split('/').at(-1)!;
  await expect(dialog.getByText(id, { exact: true })).toBeVisible();
  const receipt = await readReceipt(page, id, () => dialog.getByRole('button', { name: messages[locale]['edits.refresh'] }).click());
  expect(receipt.file.state).toBe('awaiting_save');
  expect(receipt.business.state).toBe(operation === 'revise_standard' ? 'pending' : 'not_started');
  expect(receipt.projection.state).toBe('not_due');
  const ui = await showReceipt(page, locale, receipt);
  const record = fx.db.prepare(`SELECT e.operation,e.target_id,e.document_id,e.relative_path,e.base_version,d.proof_hash,d.write_state
    FROM edit_intents e LEFT JOIN draft_intents d USING(edit_id) WHERE e.edit_id=? AND e.account_id='owner'
    AND e.data_domain='product' AND e.vault_id='t16-vault'`).get(id) as
    { operation: string; target_id: string; document_id: string; relative_path: string; base_version: number | null; proof_hash: string | null; write_state: string | null };
  expect(record.operation).toBe(operation);
  const filesAfter = draftFiles(root);
  expect(filesAfter.filter(path => !filesBefore.includes(path))).toEqual(operation === 'edit_original' ? [] : [record.relative_path]);
  expect(hash(readFileSync(join(root, '知识笔记', '原文.md')))).toBe(original);
  const bytes = readFileSync(join(root, record.relative_path));
  if (operation === 'edit_original') {
    expect(record.relative_path).toBe('知识笔记/原文.md');
    expect(fx.db.prepare('SELECT patrick_id,content_hash FROM vault_documents WHERE document_id=?').get(record.document_id))
      .toEqual({ patrick_id: 'doc-first-note', content_hash: hash(bytes) });
  } else {
    expect(record).toMatchObject({ write_state: 'written', proof_hash: hash(bytes) });
    expect(bytes.toString()).toContain('patrick_id: ' + record.document_id);
  }
  await expect(dialog.getByText(record.relative_path, { exact: true })).toBeVisible();
  await expect(dialog.getByRole('link', { name: messages[locale]['edits.openObsidian'] })).toHaveCount(0);
  expect(starts.slice(beforeWrites)).toEqual([{ method: 'POST', path: '/api/v1/edits' }]);
  return { ...result, record, filesBefore, filesAfter, receipt, ui };
}
