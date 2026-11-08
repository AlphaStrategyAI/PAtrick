import { expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { now, type DecisionCase, type Project, type Rule } from '../../src/domain.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';

it('returns the task evidence and applicable standards by task id', async () => {
  const config = readConfig({ PATRICK_MODE: 'test', PATRICK_HOST: '127.0.0.1', PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [7], ownerId: config.ownerId, autoMerge: false, budgetUsd: 1, createdAt: now() };
  config.projects = [project];
  const store = new Store(':memory:');
  store.save('projects', project);
  const engine = new Workbench({ store, config, workers: [], writer: { baseline: async () => '', deliver: async () => { throw Error('unused'); } }, research: { research: async () => { throw Error('unused'); } } });
  const app = createApp({ store, config, engine });
  try {
    const task = engine.ingest({ projectId: 'p', kind: 'manual', externalId: 'idea', title: '草稿', content: '导出失败后保留草稿，以供恢复。' })!;
    const source = store.get('sources', task.sourceId)!;
    const citation = { sourceId: source.id, revision: source.revision, quote: source.content, locator: source.locator };
    const decisionCase: DecisionCase = { id: 'case-inquiry', projectId: 'p', domain: 'personal', taskId: task.id, questionId: 'q', decisionId: 'd', actorId: project.ownerId, choice: 'C', originalWords: source.content, rationale: '当时的原话', alternatives: [], ruleIds: ['keep'], sourceId: source.id, status: 'active', createdAt: now() };
    const rule: Rule = { id: 'keep', projectId: 'p', domain: 'personal', title: '保留草稿', statement: '仅本产品保留到下次成功导出。', conditions: '仅本产品', exceptions: '敏感草稿另计', version: 1, kind: 'principle', status: 'active', caseIds: [decisionCase.id], citations: [citation], createdAt: now(), reviewAt: '2099-01-01T00:00:00.000Z' };
    const other: Rule = { ...rule, id: 'other', statement: '另一项任务的原则', caseIds: ['missing-case'] };
    store.save('cases', decisionCase);
    store.save('rules', rule);
    store.save('rules', other);
    const body = await (await app.request(`/api/tasks/${task.id}?project=p`)).json() as { evidence: { quote?: string; citations: unknown[] }; standards: { id: string; statement: string }[] };
    expect(body.evidence.quote).toBe(source.content);
    expect(body.standards).toEqual([{ id: 'keep', title: '保留草稿', statement: '仅本产品保留到下次成功导出。', kind: 'principle', version: 1, status: 'active' }]);
    engine.withdraw(source.id);
    const withdrawn = await (await app.request(`/api/tasks/${task.id}?project=p`)).json() as { evidence: { quote?: string }; standards: unknown[] };
    expect(withdrawn.evidence.quote).toBeUndefined();
    expect(JSON.stringify(withdrawn)).not.toContain(source.content);
    expect(withdrawn.standards).toEqual([]);
  } finally {
    await engine.shutdown();
    store.close();
  }
});
