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

it('keeps a task whose billing route no longer matches the host and does not call a worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'billing-boundary-'));
  roots.push(root);
  const store = new Store(join(root, 'db.sqlite'), join(root, 'vault'));
  stores.push(store);
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [7], ownerId: 'owner', autoMerge: false, budgetUsd: 1, createdAt: new Date().toISOString() };
  store.save('projects', project);
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: root, vaultDir: join(root, 'vault'), ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, scanIntervalMs: 1000, billingBoundary: 'metered-only', runnerPolicies: [{ runner: 'grok', roles: ['decide'], domains: ['personal'], provider: 'fixture', model: 'fixture', admitted: true, costPerRunUsd: 0.01, independentReview: false }] };
  let calls = 0;
  const engine = new Workbench({ store, config, workers: [{ name: 'grok', async run() { calls += 1; throw new Error('should not run'); } }], writer: { async baseline() { return 'baseline'; }, async deliver() { throw new Error('unused'); } }, research: { async research() { throw new Error('unused'); } } });
  const created = engine.ingest({ projectId: 'p', kind: 'manual', externalId: 'route', title: '费用路线', content: '按原来的订阅路线处理。' })!;
  store.save('tasks', { ...created, stage: 'decide', status: 'deciding', billingBoundary: 'included-only' });
  try {
    await engine.tick();
    expect(calls).toBe(0);
    expect(store.get('tasks', created.id)).toMatchObject({ status: 'blocked', error: 'billing_boundary_mismatch' });
    const notice = store.list('outbox').find(message => message.taskId === created.id);
    expect(notice?.text).toContain('不会换路线继续');
    expect(notice?.text).not.toContain('frozen task route');
    const page = await (await createApp({ store, config, engine }).request(`/tasks/${created.id}?project=p`)).text();
    expect(page).toContain(publicError('billing_boundary_mismatch'));
  } finally { await engine.shutdown(); }
});
