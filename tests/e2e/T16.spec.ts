import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { canonicalPayload, type Json } from '../../packages/contracts/src/envelope.js';
import rendering from '../../apps/web/rendering.lock.json' with { type: 'json' };
import { t16Fixture } from './T16-fixture.js';

test('新建标准从已授权的空标准页进入并读取文件回执', async ({ page, browser }) => {
  expect(browser.version()).toBe(rendering.chromium.version);
  const fixture = await t16Fixture(page);
  try {
    await page.goto('/standards');
    await page.getByRole('button', { name: '新建标准' }).click({ timeout: 3_000 });
    await page.getByRole('button', { name: '登记编辑' }).click();
    const progress = page.getByTestId('edit-progress');
    await expect(progress.getByTestId('file-state')).toHaveText('等待保存');
    expect(fixture.requests.find(({ method, path }) => method === 'POST' && path === '/api/v1/edits'))
      .toMatchObject({ origin: 'http://localhost', status: 202, body: { expected_revision: null,
        payload: { operation: 'create_standard', expected_active_version: null } } });
  } finally { fixture.close(); }
});

test('修订标准后，实际采纳和投影失败分开显示', async ({ page }) => {
  const fixture = await t16Fixture(page, true);
  try {
    await page.goto('/standards');
    await page.getByRole('button', { name: '修订标准' }).click({ timeout: 3_000 });
    await page.getByRole('button', { name: '登记编辑' }).click();
    const progress = page.getByTestId('edit-progress');
    await expect(progress.getByTestId('file-state')).toHaveText('等待保存');
    await fixture.adoptRevision('staging');
    await page.getByRole('button', { name: '刷新回执' }).click();
    await expect(progress.getByTestId('file-state')).toHaveText('已收录');
    await expect(progress.getByTestId('business-state')).toHaveText('已采用');
    await expect(progress.getByTestId('projection-state')).toHaveText('Obsidian 待更新');
    await expect(page.getByTestId('evaluation-evidence')).toContainText('评测通过');
    await expect(page.getByTestId('evaluation-evidence')).toContainText('product-demand-v1');
    const before = fixture.db.prepare(`SELECT receipt_revision,projection_intent_id,projection_revision
      FROM edit_receipts WHERE projection_state='failed'`).get() as {
        receipt_revision: number; projection_intent_id: string; projection_revision: number;
      };
    const id = (fixture.db.prepare("SELECT edit_id FROM edit_receipts WHERE projection_state='failed'").get() as { edit_id: string }).edit_id;
    const manifest = fixture.db.prepare('SELECT manifest_json FROM projection_batches WHERE intent_id=?')
      .get(before.projection_intent_id) as { manifest_json: string };
    const frozenHash = (JSON.parse(manifest.manifest_json) as { render: { blob: string } }).render.blob;
    const path = `/api/v1/edits/${id}/projection-retries`;
    const wrongPayload = { expected_revision: before.receipt_revision, intent_id: 'wrong',
      projection_revision: before.projection_revision };
    const wrong = await fixture.request(path, { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ client_request_id: 'wrong-intent', expected_revision: before.receipt_revision, payload: wrongPayload,
        payload_hash: createHash('sha256').update(canonicalPayload(wrongPayload as Json)).digest('hex') }) });
    expect(wrong.status).toBe(409);
    fixture.allowProjection();
    const blocked = fixture.blockBatchPath();
    const exactPayload = { ...wrongPayload, intent_id: before.projection_intent_id };
    const unsafe = await fixture.request(path, { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ client_request_id: 'unsafe-path-retry', expected_revision: before.receipt_revision, payload: exactPayload,
        payload_hash: createHash('sha256').update(canonicalPayload(exactPayload)).digest('hex') }) });
    expect(unsafe.status).toBe(202);
    expect(blocked.list()).toEqual([]);
    expect(fixture.db.prepare("SELECT 1 FROM projection_pointers WHERE view_kind='standards'").get()).toBeUndefined();
    blocked.release();
    expect(await fixture.saveNewKnowledgeAfterFailure()).toMatchObject({ collected: 1 });
    await page.getByRole('button', { name: '重试导回' }).click();
    await expect(progress.getByTestId('file-state')).toHaveText('已收录');
    await expect(progress.getByTestId('business-state')).toHaveText('已采用');
    await expect(progress.getByTestId('projection-state')).toHaveText('已导回');
    const retry = fixture.requests.find(({ method, path }) => method === 'POST' && path.endsWith('/projection-retries'));
    expect(retry).toMatchObject({ status: 202, body: { expected_revision: before.receipt_revision, payload: {
      expected_revision: before.receipt_revision, intent_id: before.projection_intent_id, projection_revision: before.projection_revision,
    } } });
    const again = await fixture.request(path, { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify(retry?.body) });
    expect(again.status).toBe(202);
    expect(fixture.db.prepare('SELECT active_version FROM standards WHERE standard_id=?').get('std-t16')).toEqual({ active_version: 2 });
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM adoption_facts WHERE standard_id=?').get('std-t16')).toEqual({ n: 2 });
    expect(fixture.db.prepare("SELECT intent_id,projection_revision FROM projection_pointers WHERE view_kind='standards'").get())
      .toEqual({ intent_id: before.projection_intent_id, projection_revision: before.projection_revision });
    const files = fixture.projectedFiles();
    expect(files['生效标准/当前.md']).toContain('std-t16');
    expect(files['生效标准/当前.md']).toContain('v2');
    expect(files['知识/当前.md']).not.toContain('k-after-failure');
    expect(createHash('sha256').update(canonicalPayload(files)).digest('hex')).toBe(frozenHash);
  } finally { fixture.close(); }
});

test('冻结内容时存储目录不可用，修复后按原采纳导回', async ({ page }) => {
  const fixture = await t16Fixture(page, true);
  try {
    const id = await fixture.registerRevision(1);
    await fixture.adoptRevision('blob', id);
    const failed = await readEdit(fixture, id);
    expect(failed.business.state).toBe('adopted');
    expect(failed.projection.state).toBe('failed');
    const manifest = fixture.db.prepare('SELECT manifest_json FROM projection_batches WHERE intent_id=?')
      .get(failed.projection.intent_id) as { manifest_json: string };
    const original = (JSON.parse(manifest.manifest_json) as { render: { blob: string } }).render.blob;
    fixture.restoreBlobStore();
    expect(await fixture.saveNewKnowledgeAfterFailure()).toMatchObject({ collected: 1 });
    expect((await retryEdit(fixture, id, failed, 'after-blob-repair')).status).toBe(202);
    const current = await readEdit(fixture, id);
    expect(current.projection).toMatchObject({ ...failed.projection, state: 'current' });
    expect(createHash('sha256').update(canonicalPayload(fixture.projectedFiles())).digest('hex')).toBe(original);
  } finally { fixture.close(); }
});

test('较新投影接替时旧回执记录接替批次', async ({ page }) => {
  const fixture = await t16Fixture(page, true);
  try {
    const older = await fixture.registerRevision(1);
    await fixture.adoptRevision('staging', older);
    const failed = await readEdit(fixture, older);
    expect(failed.projection.state).toBe('failed');
    fixture.allowProjection();
    const newer = await fixture.registerRevision(2);
    await fixture.adoptRevision(undefined, newer);
    const current = await readEdit(fixture, newer);
    expect(current.projection.state).toBe('current');
    expect((await retryEdit(fixture, older, failed, 'older-than-pointer')).status).toBe(202);
    const replaced = await readEdit(fixture, older);
    expect(replaced.business).toEqual(failed.business);
    expect(replaced.projection).toEqual({ ...failed.projection, state: 'superseded', superseded_by: current.projection.intent_id });
    expect((await retryEdit(fixture, older, failed, 'older-than-pointer')).status).toBe(202);
    expect(await readEdit(fixture, older)).toEqual(replaced);
  } finally { fixture.close(); }
});

type Fixture = Awaited<ReturnType<typeof t16Fixture>>;
type Receipt = { receipt_revision: number; business: { state: string }; projection: {
  state: string; intent_id: string; projection_revision: number; superseded_by: string | null;
} };
async function readEdit(fixture: Fixture, id: string): Promise<Receipt> {
  const response = await fixture.request(`/api/v1/edits/${id}`);
  expect(response.status).toBe(200);
  return (await response.json() as { data: Receipt }).data;
}
function retryEdit(fixture: Fixture, id: string, receipt: Receipt, requestId: string) {
  const payload = { expected_revision: receipt.receipt_revision, intent_id: receipt.projection.intent_id,
    projection_revision: receipt.projection.projection_revision };
  return fixture.request(`/api/v1/edits/${id}/projection-retries`, {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ client_request_id: requestId, expected_revision: receipt.receipt_revision, payload,
      payload_hash: createHash('sha256').update(canonicalPayload(payload)).digest('hex') }),
  });
}

test('知识页展示原稿和补充入口，并保留原始证据', async ({ page }) => {
  const fixture = await t16Fixture(page);
  try {
    await page.goto('/knowledge');
    await page.getByRole('button', { name: 'k-t16' }).click({ timeout: 3_000 });
    await page.getByRole('button', { name: '编辑原稿' }).click();
    const original = page.getByRole('dialog', { name: '编辑原稿' });
    await expect(original.getByText('知识笔记/原文.md')).toBeVisible();
    await original.getByRole('button', { name: '登记编辑' }).click();
    await expect(original.getByTestId('edit-progress').getByTestId('file-state')).toHaveText('等待保存');
    const exact = fixture.db.prepare("SELECT document_id,observed_seq FROM vault_documents WHERE relative_path='知识笔记/原文.md'").get() as {
      document_id: string; observed_seq: number;
    };
    expect(fixture.requests.find(({ method, path }) => method === 'POST' && path === '/api/v1/edits'))
      .toMatchObject({ status: 202, body: { payload: { operation: 'edit_original', knowledge_id: 'k-t16',
        document_id: exact.document_id, expected_source_revision: exact.observed_seq } } });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '补充知识' }).click();
    await page.getByRole('button', { name: '登记编辑' }).click();
    await expect(page.getByTestId('edit-progress').getByTestId('file-state')).toHaveText('等待保存');
    expect(fixture.requests.filter(({ method, path }) => method === 'POST' && path === '/api/v1/edits').at(-1))
      .toMatchObject({ status: 202, body: { payload: { operation: 'supplement_knowledge', knowledge_id: 'k-t16', expected_knowledge_revision: 1 } } });
    await expect(page.getByText('知识笔记/补充/k-t16.md')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '编辑原稿' }).click();
    await page.getByRole('button', { name: '登记编辑' }).click();
    await expect(page.getByTestId('edit-progress').getByTestId('file-state')).toHaveText('等待保存');
    fixture.saveOriginal();
    await page.getByRole('button', { name: '检查保存' }).click();
    await expect(page.getByTestId('edit-progress').getByTestId('file-state')).toHaveText('已收录');
    expect(fixture.db.prepare("SELECT 1 FROM vault_documents WHERE relative_path='知识笔记/unrelated.md'").get()).toBeUndefined();
  } finally { fixture.close(); }
});

test('委托状态与具体范围来自服务，预览未核验的变更不会写入', async ({ page }) => {
  const fixture = await t16Fixture(page);
  try {
    await page.goto('/delegations');
    await page.getByRole('button', { name: 'mandate-t16' }).click();
    await page.getByRole('button', { name: '预览暂停' }).click();
    const preview = page.getByRole('dialog', { name: '委托变更预览' });
    await expect(preview.getByText('生效 → 已暂停')).toBeVisible();
    await expect(preview.getByText(/此预览不会改动委托/)).toBeVisible();
    await page.keyboard.press('Escape');
    expect(fixture.requests.some(({ method }) => method === 'POST')).toBe(false);
    expect(fixture.db.prepare("SELECT status FROM mandates WHERE mandate_id='mandate-t16'").get()).toEqual({ status: 'active' });
  } finally { fixture.close(); }
});

test('资料域只返回获准的搜索证据', async ({ page }) => {
  const fixture = await t16Fixture(page);
  try {
    fixture.db.prepare(`INSERT INTO caller_scopes (account_id,caller_id,data_domain,permission,revoked_at)
      VALUES ('owner','web','secondary','conversations.read',NULL)`).run();
    fixture.db.prepare(`INSERT INTO knowledge_records SELECT 'other',canonical_id,account_id,'secondary',
      revision,status,title,body,schema_version,created_at,updated_at FROM knowledge_records WHERE knowledge_id='k-t16'`).run();
    await page.goto('/knowledge');
    await page.getByRole('searchbox', { name: '搜索当前知识' }).fill('知识和引文');
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await page.getByRole('button', { name: 'k-t16' }).click();
    await expect(page.getByRole('button', { name: 'other' })).toHaveCount(0);
    await page.getByRole('button', { name: '查看来源位置' }).click();
    await expect(page.getByText('知识笔记/原文.md')).toBeVisible();
    const denied = await fixture.request('/api/v1/knowledge?domain=secondary');
    expect(denied.status).toBe(403);
  } finally { fixture.close(); }
});

test('委托在显式确认精确提案后才生效，并可读回相同可信回执', async ({ page }) => {
  const fixture = await t16Fixture(page);
  try {
    await page.goto('/delegations');
    await page.getByRole('button', { name: 'mandate-t16' }).click();
    await page.getByRole('button', { name: '预览暂停' }).click();
    const preview = page.getByRole('dialog', { name: '委托变更预览' });
    await preview.getByRole('button', { name: '登记委托提案' }).click({ timeout: 3_000 });
    await expect(preview.getByTestId('delegation-proposal-hash')).toContainText(/^[a-f0-9]{64}$/);
    expect(fixture.db.prepare("SELECT status FROM mandates WHERE mandate_id='mandate-t16'").get()).toEqual({ status: 'active' });
    await preview.getByRole('button', { name: '确认并应用委托变更' }).click();
    await expect(preview.getByTestId('delegation-control-receipt')).toContainText(/rcpt_/);
    await expect(preview.getByText('已应用：已暂停')).toBeVisible();
    expect(fixture.db.prepare("SELECT status,revision FROM mandates WHERE mandate_id='mandate-t16'").get())
      .toEqual({ status: 'paused', revision: 1 });
    expect(fixture.requests.filter(({ method, path }) => method === 'POST' && path.endsWith('/apply'))).toHaveLength(1);
  } finally { fixture.close(); }
});
