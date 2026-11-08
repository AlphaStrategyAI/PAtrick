import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { AppConfig, Project } from '../../src/domain.js';
import { publicError } from '../../src/readiness.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

it('does not send a private-domain question to research', async () => {
  const root = mkdtempSync(join(tmpdir(), 'research-egress-'));
  roots.push(root);
  const store = new Store(join(root, 'db.sqlite'), join(root, 'vault'));
  stores.push(store);
  const project: Project = { id: 'p', projectId: 'p', domain: 'company', name: '内部', description: '', repository: 'group/product', repositoryProvider: 'gitlab', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [7], ownerId: 'owner', autoMerge: false, budgetUsd: 1, createdAt: new Date().toISOString() };
  store.save('projects', project);
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: root, vaultDir: join(root, 'vault'), ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, scanIntervalMs: 1000, runnerPolicies: [], egressPolicies: [{ domain: 'company', research: false, feishu: false }] };
  let calls = 0;
  const engine = new Workbench({ store, config, workers: [], writer: { async baseline() { return 'baseline'; }, async deliver() { throw new Error('unused'); } }, research: { async research() { calls += 1; return { queries: [], summary: '', gaps: [] }; } } });
  const created = engine.ingest({ projectId: 'p', kind: 'manual', externalId: 'private', title: '内部处理', content: '内部草稿处理办法。' })!;
  const suggestion = { label: '保留', description: 'PRIVATE_SENTINEL 保留内部草稿', rationale: '内部', tradeoff: '成本', evidenceUrls: ['https://example.com/private'] };
  store.save('tasks', { ...created, stage: 'research', status: 'researching', decision: { action: 'ask', summary: '需要选择', rationale: '两种做法', citations: [], ruleIds: [], question: { title: 'PRIVATE_SENTINEL', context: 'PRIVATE_SENTINEL', A: suggestion, B: { ...suggestion, label: '删除', description: 'PRIVATE_SENTINEL 删除' } } } });
  try {
    await engine.tick();
    expect(calls).toBe(0);
    expect(store.get('tasks', created.id)?.error).toBe('egress_denied');
    expect(publicError('egress_denied')).toContain('不能送去外部检索');
    const page = await (await createApp({ store, config, engine }).request(`/tasks/${created.id}?project=p&domain=company`)).text();
    expect(page).toContain('不能送去外部检索');
    expect(page).not.toContain('PRIVATE_SENTINEL');
    expect(JSON.stringify(store.list('outbox'))).not.toContain('PRIVATE_SENTINEL');
    expect(JSON.stringify(store.list('events'))).not.toContain('PRIVATE_SENTINEL');
  } finally { await engine.shutdown(); }
});
