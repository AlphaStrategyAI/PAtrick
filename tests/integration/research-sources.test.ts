import { expect, it } from 'vitest';
import { now, type Project, type ResearchRecord } from '../../src/domain.js';
import { retainPrimaryResearch } from '../../src/research-sources.js';
import { Store } from '../../src/store.js';

const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/product/PRD.md', allowedPaths: ['docs/product/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [1], ownerId: 'owner', autoMerge: false, budgetUsd: 0, createdAt: now(), executionRunner: 'grok', reviewIntervalDays: 7 };

function research(): ResearchRecord {
  return { queries: (['zh', 'en'] as const).map(language => ({ language, query: language === 'zh' ? '草稿恢复' : 'draft recovery', searchedAt: now(), sources: [{ url: `https://example.com/${language}`, canonicalUrl: `https://example.com/${language}`, title: language === 'zh' ? '中文一手' : 'English primary', language, publishedAt: '2026-11-01', accessedAt: now(), excerpt: language === 'zh' ? '中文原文比较恢复机会。' : 'English original compares recovery.', primary: true, conditions: '本产品' }] })), summary: '两种语言都查过。', gaps: [] };
}

it('keeps primary research excerpts as reference sources and does not open a delivery task', () => {
  const store = new Store(':memory:');
  store.save('projects', project);
  try {
    retainPrimaryResearch(store, project, research());
    retainPrimaryResearch(store, project, research());
    const sources = store.list('sources').filter(item => item.externalId.startsWith('research:'));
    expect(sources.map(item => item.title).sort()).toEqual(['English primary', '中文一手']);
    expect(sources.every(item => item.purpose === 'reference' && item.status === 'active')).toBe(true);
    expect(store.list('tasks').filter(task => task.kind !== 'reference_knowledge')).toHaveLength(0);
  } finally { store.close(); }
});
