import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Page } from '@playwright/test';
import { issueBootstrapTicket, issueCallerSession, mountAuthRoutes, runWithAuth } from '../../apps/service/src/auth.js';
import { mountControlRoutes } from '../../apps/service/src/control.js';
import { mountEditRoutes } from '../../apps/service/src/routes/edits.js';
import { mountDelegationRoutes } from '../../apps/service/src/routes/delegations.js';
import { mountKnowledgeRoutes } from '../../apps/service/src/routes/knowledge.js';
import { mountStandardRoutes } from '../../apps/service/src/routes/standards.js';
import { createDelegationApi } from '../../packages/domain/src/delegation.js';
import { createStandardsApi, type StandardRule } from '../../packages/domain/src/standards.js';
import { createCredentialStore } from '../../packages/host/src/credentials.js';
import { createVaultApi } from '../../packages/integrations/vault/drafts.js';
import { PROJECTION_BATCH_FILES } from '../../packages/integrations/vault/projector.js';
import { canonicalPayload } from '../../packages/contracts/src/envelope.js';
import { openDatabase } from '../../packages/storage/src/database.js';
import { createBlobStore } from '../../packages/storage/src/blob-store.js';

function headerEntries(headers: Headers): Record<string, string> {
  const values: Record<string, string> = {};
  headers.forEach((value, key) => { values[key] = value; });
  return values;
}

const now = () => new Date('2026-11-17T05:00:00.000Z');
const owner = { account_id: 'owner', caller_id: 'web', auth_epoch: 1, domains: ['product'], operations: ['owner'] };
const vaultId = 't16-vault';
const standardId = 'std-t16';
const rules = (JSON.parse(readFileSync(new URL('../../fixtures/evaluation/product/manifest.json', import.meta.url), 'utf8')) as {
  candidate_rules: StandardRule[];
}).candidate_rules;

export async function t16Fixture(page: Page, seedStandard = false) {
  const folder = mkdtempSync(join(tmpdir(), 'patrick-t16-'));
  const root = join(folder, 'vault');
  mkdirSync(join(root, '知识笔记'), { recursive: true });
  const db = openDatabase(join(folder, 'test.sqlite'));
  try {
    const credentials = createCredentialStore(join(folder, 'creds'), now);
    const vault = createVaultApi(db, {
      captureHost: 'test-mac',
      blobs: createBlobStore(join(folder, 'blobs')),
      now,
    });
    await vault.connectVault({ accountId: 'owner', deviceId: 'test-mac', vaultId, root, domain: 'product' });
    await vault.confirmVault('test-mac', vaultId);
    writeFileSync(join(root, '知识笔记', '原文.md'),
      '---\npatrick_id: doc-first-note\nkind: knowledge\nknowledge_id: k-t16\n---\n\n网页里的知识和引文。\n', 'utf8');
    await vault.readVault(vaultId);
    const standards = createStandardsApi(db, owner, { domain: 'product', now });
    await standards.seedProductDataset();
    if (seedStandard) {
      const candidate = await standards.openCandidate(await standards.ingestStandardDraft({
        vaultId, standardId, draftKey: 't16-base', rules,
      }));
      const report = await standards.evaluate(candidate, { version: 1 });
      if (await standards.adoptStandard(candidate.id, report.id, candidate.revision) !== 'adopted') throw new Error('Fixture v1 not adopted');
    }

    const delegation = createDelegationApi(db, owner, { domain: 'product', now });
    const mandate = {
      type_id: 't16-scope', actions: ['read'], resources: ['source'], effects: [], domains: ['product'],
      risk: 'low', level: 'L0' as const, budget_micros: 700,
    };
    await delegation.registerMandateType({ ...mandate, config_version: 1 });
    await delegation.openMandate({ ...mandate, mandate_id: 'mandate-t16', expires_at: '2026-11-18T05:00:00Z' });

    issueBootstrapTicket(db, { accountId: 'owner' }, now);
    const { token } = issueCallerSession(db, { accountId: 'owner', callerId: 'web', domain: 'product', permissions: ['owner'] }, now, credentials);
    await page.context().addCookies([{ name: 'patrick_session', value: token, url: 'http://localhost', httpOnly: true, sameSite: 'Strict' }]);
    const app = new Hono();
    app.use('/api/v1/*', async (_c, next) => { await runWithAuth({ db, credentials, now }, next); });
    mountAuthRoutes(app);
    mountControlRoutes(app);
    const ready = () => ({ db, now, api: vault });
    mountEditRoutes(app, ready);
    mountKnowledgeRoutes(app, ready);
    mountStandardRoutes(app, ready);
    mountDelegationRoutes(app, ready);
    const requests: { method: string; path: string; origin?: string; body: unknown; status: number }[] = [];
    await page.route('http://localhost/api/v1/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = await request.allHeaders();
      const body = request.postData();
      const response = await app.request(url.pathname + url.search, { method: request.method(), headers, body: body ?? undefined });
      requests.push({ method: request.method(), path: url.pathname, origin: headers.origin, body: body ? JSON.parse(body) : null, status: response.status });
      await route.fulfill({ status: response.status, headers: headerEntries(response.headers), body: await response.text() });
    });

    return {
      db, requests,
      async request(path: string, options?: RequestInit) {
        return app.request(path, { ...options, headers: {
          ...headerEntries(new Headers(options?.headers)), cookie: `patrick_session=${token}`,
        } });
      },
      saveOriginal() {
        writeFileSync(join(root, '知识笔记', '原文.md'), '---\npatrick_id: doc-first-note\nkind: knowledge\nknowledge_id: k-t16\n---\n\n编辑后的内容。\n', 'utf8');
        writeFileSync(join(root, '知识笔记', 'unrelated.md'), '# Must not be captured during exact edit check\n');
      },
      allowProjection() { rmSync(join(root, '.patrick-staging'), { force: true }); },
      restoreBlobStore() {
        rmSync(join(folder, 'blobs'));
        renameSync(join(folder, 'blobs-available'), join(folder, 'blobs'));
      },
      async registerRevision(baseVersion: number) {
        const payload = { operation: 'revise_standard', standard_id: standardId, base_version: baseVersion,
          draft_key: randomUUID(), vault_id: vaultId };
        const result = await app.request('/api/v1/edits', {
          method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', cookie: `patrick_session=${token}` },
          body: JSON.stringify({ client_request_id: randomUUID(), expected_revision: null, payload,
            payload_hash: createHash('sha256').update(canonicalPayload(payload)).digest('hex') }),
        });
        if (result.status !== 202) throw new Error(`Register revision: ${result.status} ${await result.text()}`);
        const accepted = await result.json() as { receipt_url: string };
        return accepted.receipt_url.split('/').at(-1)!;
      },
      blockBatchPath() {
        const outside = join(folder, 'outside');
        const target = join(root, '系统视图', '批次');
        mkdirSync(outside);
        rmdirSync(target);
        symlinkSync(outside, target, 'dir');
        return {
          list: () => readdirSync(outside),
          release: () => rmSync(target),
        };
      },
      async saveNewKnowledgeAfterFailure() {
        writeFileSync(join(root, '知识笔记', 'new.md'),
          '---\npatrick_id: doc-after-failure\nkind: knowledge\nknowledge_id: k-after-failure\n---\n\nNew knowledge.\n');
        return vault.readVault(vaultId);
      },
      projectedFiles() {
        const index = readFileSync(join(root, '系统视图', '索引.md'), 'utf8');
        const batch = /当前批次：系统视图\/批次\/([^\n]+)/u.exec(index)?.[1];
        if (!batch) throw new Error('Missing published batch');
        return Object.fromEntries(PROJECTION_BATCH_FILES.map((path) =>
          [path, readFileSync(join(root, '系统视图', '批次', batch, path), 'utf8')]));
      },
      async adoptRevision(failure?: 'staging' | 'blob', editId?: string) {
        const intent = db.prepare(`SELECT edit_id,document_id,relative_path,draft_key,base_version FROM edit_intents
          WHERE operation='revise_standard' AND (? IS NULL OR edit_id=?)`).get(editId ?? null, editId ?? null) as {
          edit_id: string; document_id: string; relative_path: string; draft_key: string; base_version: number;
        } | undefined;
        if (!intent) throw new Error('No revision intent from browser');
        const front = readFileSync(join(root, intent.relative_path), 'utf8');
        writeFileSync(join(root, intent.relative_path), front.replace('# 判断规则\n\n', `# 判断规则\n\n\`\`\`json\n${JSON.stringify({ rules })}\n\`\`\`\n\n`));
        await vault.readVault(vaultId);
        const document = db.prepare('SELECT observed_seq,content_hash FROM vault_documents WHERE document_id=?').get(intent.document_id) as {
          observed_seq: number; content_hash: string;
        };
        const candidate = await standards.openCandidate({
          vault_id: vaultId, standard_id: standardId, draft_key: intent.draft_key, document_id: intent.document_id,
          source_revision: document.observed_seq, content_hash: document.content_hash, baseVersion: intent.base_version, editId: intent.edit_id,
        });
        const report = await standards.evaluate(candidate, { version: 1 });
        if (failure === 'staging') {
          const staging = join(root, '.patrick-staging');
          rmSync(staging, { force: true, recursive: true });
          writeFileSync(staging, 'a local file prevents directory creation');
        } else if (failure === 'blob') {
          const store = join(folder, 'blobs');
          renameSync(store, join(folder, 'blobs-available'));
          writeFileSync(store, 'a local file prevents blob storage');
        }
        const payload = { report_id: report.id };
        const response = await app.request(`/api/v1/standard-candidates/${candidate.id}/adoptions`, {
          method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', cookie: `patrick_session=${token}` },
          body: JSON.stringify({ client_request_id: randomUUID(), expected_revision: candidate.revision, payload,
            payload_hash: createHash('sha256').update(canonicalPayload(payload)).digest('hex') }),
        });
        if (response.status !== 202) throw new Error(`Actual adoption response: ${response.status} ${await response.text()}`);
      },
      close() {
        db.close();
        rmSync(folder, { recursive: true, force: true });
      },
    };
  } catch (error) {
    db.close();
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}
