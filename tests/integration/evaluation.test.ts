import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { configureDemo } from '../../src/demo.js';
import { digest } from '../../src/domain.js';
import { recordMaintenance, runMonthlyComparison } from '../../src/evaluation.js';
import { ingestSource } from '../../src/intake.js';
import { Workbench } from '../../src/orchestrator.js';
import { weeklyReport } from '../../src/reports.js';
import { Store } from '../../src/store.js';

function fixture() {
  const config = readConfig({ PATRICK_MODE: 'test', PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
  configureDemo(config);
  const store = new Store(':memory:');
  const project = config.projects[0]!;
  store.save('projects', project);
  return { config, store, project };
}

it('pauses a new GitHub source after two measured weeks over an hour and keeps the product file flowing', () => {
  const { config, store, project } = fixture();
  const at = new Date('2026-11-07T00:00:00.000Z');
  try {
    recordMaintenance(store, project, { eventId: '11111111-1111-4111-8111-111111111111', minutes: 70, note: '采集补扫', recordedAt: '2026-10-28T00:00:00.000Z' });
    recordMaintenance(store, project, { eventId: '22222222-2222-4222-8222-222222222222', minutes: 90, note: '回执对账', recordedAt: '2026-11-04T00:00:00.000Z' });
    const report = weeklyReport(store, project, at);
    expect(report.metrics.maintenanceMinutes).toBe(90);
    expect(report.metrics.slowestRecordedMaintenance).toEqual({ minutes: 90, note: '回执对账' });
    expect(report.metrics.sourceExpansionPaused).toBe(true);
    expect(report.metrics.missedQuestions).toBeNull();
    const file = ingestSource(store, config, { projectId: project.id, kind: 'file', externalId: 'file:idea.md', title: '草稿恢复', content: '导出失败后应恢复草稿。', authorId: project.ownerId });
    expect(file?.status).toBe('queued');
    expect(() => ingestSource(store, config, { projectId: project.id, kind: 'github', externalId: 'discussion-1', title: '远端讨论', content: '把草稿恢复写进仓库讨论。', authorId: project.ownerId })).toThrowError(expect.objectContaining({ code: 'source_expansion_paused' }));
    expect(store.list('sources').filter(source => source.kind === 'github')).toHaveLength(0);
    expect(store.list('tasks')).toHaveLength(1);
  } finally { store.close(); }
});

it('keeps GitHub available when only the latest week is over the limit', () => {
  const { config, store, project } = fixture();
  try {
    recordMaintenance(store, project, { eventId: '33333333-3333-4333-8333-333333333333', minutes: 80, recordedAt: '2026-11-04T00:00:00.000Z' });
    expect(weeklyReport(store, project, new Date('2026-11-07T00:00:00.000Z')).metrics.sourceExpansionPaused).toBe(false);
    const task = ingestSource(store, config, { projectId: project.id, kind: 'github', externalId: 'discussion-1', title: '远端讨论', content: '已有证据的仓库讨论。', authorId: project.ownerId });
    expect(task?.status).toBe('queued');
  } finally { store.close(); }
});

it('records one maintenance session through the owner API and shows it on the weekly report', async () => {
  const config = readConfig({ PATRICK_MODE: 'demo', PATRICK_HOST: '127.0.0.1', PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
  configureDemo(config);
  const store = new Store(':memory:');
  store.save('projects', { ...config.projects[0]!, ownerId: config.ownerId });
  const engine = new Workbench({ store, config, workers: [], writer: { baseline: async () => '', deliver: async () => { throw Error('No remote proof'); } }, research: { research: async () => { throw Error('No research'); } } });
  const app = createApp({ store, config, engine });
  const project = config.projects[0]!;
  const headers = { Authorization: 'Bearer test-owner-token-at-least-32-characters', 'Content-Type': 'application/json', Accept: 'application/json' };
  try {
    const response = await app.request('/api/maintenance', { method: 'POST', headers, body: JSON.stringify({ projectId: project.id, domain: project.domain, minutes: 25, note: '核对采集', eventId: randomUUID() }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.report.metrics.maintenanceMinutes).toBe(25);
    expect(body.report.metrics.sourceExpansionPaused).toBe(false);
    const again = await app.request(`/api/reports/weekly?project=${project.id}&domain=${project.domain}`, { headers });
    expect((await again.json()).metrics.maintenanceMinutes).toBe(25);
  } finally { store.close(); }
});

it('records one monthly held-out comparison and leaves the current principle unchanged', () => {
  const { store, project } = fixture();
  const at = '2026-11-02T00:00:00.000Z';
  const rule = { id: 'principle', projectId: project.id, domain: project.domain, title: '保留草稿', statement: '仅本产品保留到下次成功导出。', conditions: '仅本产品这一次', exceptions: '敏感草稿需单独确认', version: 1, kind: 'principle' as const, status: 'active' as const, caseIds: ['case'], citations: [], createdAt: at, reviewAt: '2026-12-01T00:00:00.000Z' };
  try {
    store.save('sources', { id: 'source', projectId: project.id, domain: project.domain, kind: 'manual', externalId: 'idea', revision: 'v1', title: '草稿', content: '导出失败后应恢复草稿。', locator: 'productIdeas/草稿.md', authorId: project.ownerId, retention: 'permanent', status: 'active', createdAt: at });
    store.save('cases', { id: 'case', projectId: project.id, domain: project.domain, taskId: 'task', questionId: 'question', decisionId: 'decision', actorId: project.ownerId, choice: 'C', originalWords: '仅本产品保留到下次成功导出。', rationale: 'Owner rationale not separately stated.', alternatives: [], ruleIds: ['principle'], sourceId: 'source', status: 'active', createdAt: at });
    store.save('rules', rule);
    const savedRule = store.get('rules', rule.id);
    if (!savedRule) throw new Error('principle missing');
    const before = digest(savedRule);
    const first = runMonthlyComparison(store, project, new Date('2026-11-07T00:00:00.000Z'));
    const second = runMonthlyComparison(store, project, new Date('2026-11-20T00:00:00.000Z'));
    expect(first).toMatchObject({ month: '2026-11', sampleSize: 1, ownerCorrections: 1, matchedSuggestions: 0, candidateAnswers: 0, trial: 'none', principle: 'unchanged' });
    expect(second).toEqual(first);
    expect(store.list('actions').filter(action => action.kind === 'decision.monthly-comparison')).toHaveLength(1);
    const after = store.get('rules', rule.id);
    if (!after) throw new Error('principle missing');
    expect(digest(after)).toBe(before);
    expect(store.get('rules', rule.id)?.statement).toBe(rule.statement);
  } finally { store.close(); }
});
