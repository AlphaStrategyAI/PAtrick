import { expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { now, type Project, type ResearchRecord } from '../../src/domain.js';
import { Workbench } from '../../src/orchestrator.js';
import { retainPrimaryResearch } from '../../src/research-sources.js';
import { Store } from '../../src/store.js';

const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/product/PRD.md', allowedPaths: ['docs/product/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [1], ownerId: 'owner', autoMerge: false, budgetUsd: 0, createdAt: now(), executionRunner: 'grok', reviewIntervalDays: 7 };

function research(): ResearchRecord {
  return { queries: (['zh', 'en'] as const).map(language => ({ language, query: language === 'zh' ? '草稿恢复' : 'draft recovery', searchedAt: now(), sources: [{ url: `https://example.com/${language}`, canonicalUrl: `https://example.com/${language}`, title: language === 'zh' ? '中文一手' : 'English primary', language, publishedAt: '2026-11-01', accessedAt: now(), excerpt: language === 'zh' ? '中文原文比较恢复机会。' : 'English original compares recovery.', primary: true, conditions: '本产品' }] })), summary: '两种语言都查过。', gaps: [] };
}

it('keeps primary research excerpts as reference sources and does not open a delivery task', async () => {
  const store = new Store(':memory:');
  store.save('projects', project);
  try {
    retainPrimaryResearch(store, project, research());
    retainPrimaryResearch(store, project, research());
    const sources = store.list('sources').filter(item => item.externalId.startsWith('research:'));
    expect(sources.map(item => item.title).sort()).toEqual(['English primary', '中文一手']);
    expect(sources.every(item => item.purpose === 'reference' && item.status === 'active')).toBe(true);
    expect(store.list('tasks').filter(task => task.kind !== 'reference_knowledge')).toHaveLength(0);
    const at = now();
    const record = research();
    store.save('tasks', { id: 'task', projectId: project.id, domain: project.domain, sourceId: 'source', sourceRevision: 'v1', title: '确认草稿', description: '需要选择', status: 'awaiting_answer', version: 1, createdAt: at, updatedAt: at, runAfter: at, attempts: 0, repairCount: 0, budgetUsd: 0, spentUsd: 0, stage: 'decide', questionId: 'question' });
    store.save('questions', { id: 'question', projectId: project.id, domain: project.domain, taskId: 'task', taskVersion: 1, version: 1, ownerId: project.ownerId, title: '草稿保留多久？', context: '两种做法都可行', options: { A: { label: '保留', description: '保留草稿', rationale: '便于恢复', tradeoff: '多留一份', evidenceUrls: ['https://example.com/zh'] }, B: { label: '删除', description: '删除草稿', rationale: '少留一份', tradeoff: '不能恢复', evidenceUrls: ['https://example.com/en'] } }, research: record, status: 'open', createdAt: at });
    const config = readConfig({ PATRICK_MODE: 'test', PATRICK_HOST: '127.0.0.1', PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
    config.ownerId = project.ownerId;
    config.projects = [project];
    const engine = new Workbench({ store, config, workers: [], writer: { baseline: async () => '', deliver: async () => { throw Error('No remote proof'); } }, research: { research: async () => { throw Error('No research'); } } });
    try {
      const html = await (await createApp({ store, config, engine }).request('/sources')).text();
      expect(html).toContain('查证一手');
      expect(html).toContain('来自中英文查证的一手摘录，不启动执行任务。');
      expect(html).not.toContain('>结果依据<');
      const workbench = await (await createApp({ store, config, engine }).request('/')).text();
      expect(workbench).toContain('已收入查证资料');
    } finally { await engine.shutdown(); }
  } finally { store.close(); }
});
