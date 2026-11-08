import { expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { DomainError, now, type Decision, type Project, type Question } from '../../src/domain.js';
import { Workbench } from '../../src/orchestrator.js';
import { publicError } from '../../src/readiness.js';
import { Store } from '../../src/store.js';

it('rejudges an old answer once and does not execute its option', async () => {
  const config = readConfig({ PATRICK_MODE: 'test', PATRICK_HOST: '127.0.0.1', PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/product/PRD.md', allowedPaths: ['docs/product/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [7], ownerId: config.ownerId, autoMerge: false, budgetUsd: 0, createdAt: now() };
  config.projects = [project];
  const store = new Store(':memory:');
  store.save('projects', project);
  const engine = new Workbench({ store, config, workers: [], writer: { baseline: async () => '', deliver: async () => { throw Error('unused'); } }, research: { research: async () => { throw Error('unused'); } } });
  const app = createApp({ store, config, engine });
  try {
    const created = engine.ingest({ projectId: 'p', kind: 'manual', externalId: 'idea', title: '草稿', content: '导出失败后保留草稿。' })!;
    const suggestion = (label: string) => ({ label, description: label, rationale: '依据', tradeoff: '代价', evidenceUrls: ['https://example.com'] });
    const question: Question = { id: 'q-old', projectId: 'p', domain: 'personal', taskId: created.id, taskVersion: created.version, version: 1, ownerId: project.ownerId, title: '保留吗', context: '选择', options: { A: suggestion('保留'), B: suggestion('删除') }, research: { queries: [], summary: '', gaps: [] }, status: 'open', createdAt: now() };
    store.save('questions', question);
    const decision: Decision = { action: 'proceed', summary: '按旧选项继续。', rationale: '这是过期路径。', citations: [], ruleIds: [] };
    store.save('tasks', { ...created, version: created.version + 1, stage: 'plan', status: 'planning', questionId: question.id, decision });
    const answer = { questionId: question.id, taskVersion: question.taskVersion, questionVersion: question.version, actorId: project.ownerId, choice: 'A' as const, eventId: 'old-card' };
    const rejudged = engine.answer(answer);
    expect(rejudged).toMatchObject({ id: created.id, version: created.version + 2, status: 'deciding', stage: 'decide', error: 'stale_answer' });
    expect(rejudged.decision).toBeUndefined();
    expect(store.get('questions', question.id)?.status).toBe('stale');
    expect(store.list('cases')).toEqual([]);
    expect(store.list('events').some(event => event.taskId === created.id && event.message === publicError('stale_answer'))).toBe(true);
    expect(() => engine.answer({ ...answer, eventId: 'old-card-again' })).toThrow(DomainError);
    expect(store.get('tasks', created.id)?.version).toBe(created.version + 2);
    expect(() => engine.answer({ ...answer, actorId: 'intruder', eventId: 'intruder' })).toThrow(DomainError);
    expect(store.get('tasks', created.id)?.version).toBe(created.version + 2);
    const page = await (await app.request(`/tasks/${created.id}?project=p`)).text();
    expect(page).toContain('没有执行原来的选项');
  } finally {
    await engine.shutdown();
    store.close();
  }
});
