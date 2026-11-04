import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { digest, type Project, type WorkerInput } from '../../src/domain.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';
import { recordDecisionSnapshot } from '../../src/standards.js';
import { recordOutcomeEvidence, runOutcomeReviews } from '../../src/reviews.js';

const stores: Store[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
afterEach(() => { stores.splice(0).forEach(store => store.close()); vi.useRealTimers(); });
function setup() {
  const config = readConfig({ PATRICK_MODE: 'demo', PATRICK_OWNER_ID: 'owner' });
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '我的项目', description: '', repository: 'a/b', repositoryProvider: 'github', prdPath: 'PRD.md', allowedPaths: ['PRD.md'], trustedChecks: ['test'], trustedAppIds: [1], ownerId: config.ownerId, autoMerge: true, budgetUsd: 1, reviewIntervalDays: 7, createdAt: new Date().toISOString() };
  config.projects = [project, { ...project, id: 'other', projectId: 'other', domain: 'work', name: '另一个本人的项目' }];
  const store = new Store(':memory:'); stores.push(store);
  config.projects.forEach(p => store.save('projects', p));
  const engine = new Workbench({ store, config, workers: [], writer: { baseline: async () => '', deliver: async () => { throw Error('No remote operation in rendering tests'); } }, research: { research: async () => { throw Error('No research in rendering tests'); } } });
  function judgment(projectId = 'p', title = '原始判断 <img src=x onerror="judgment()">') {
    const p = config.projects.find(p => p.id === projectId)!;
    const task = engine.ingest({ projectId, externalId: `idea-${projectId}`, revision: 'v1', title, content: 'Synthetic original source', retention: 'permanent' })!;
    const input = { task, source: store.get('sources', task.sourceId)!, project: p, role: 'decide', cards: [], rules: [] } as WorkerInput;
    store.save('attempts', { id: `attempt-${projectId}`, projectId, domain: p.domain, taskId: task.id, taskVersion: task.version, role: 'decide', runner: 'grok', model: 'local-test', provider: 'local-test', inputHash: digest(input), status: 'succeeded', costUsd: 0, startedAt: new Date().toISOString() });
    return { task, snapshot: recordDecisionSnapshot(store, task, input, { action: 'proceed', summary: '当时初判 <script>judgment()</script>', rationale: '当时依据', expectedOutcome: '预期仍需验证', citations: [], ruleIds: [] }) };
  }
  const { task, snapshot } = judgment();
  const app = createApp({ store, config, engine });
  const page = async (path = '/standards?project=p') => { const response = await app.request(path); expect(response.status).toBe(200); return response.text(); };
  function evidence(kind: 'correction' | 'metric' | 'failure' | 'abandonment', quote: string, attributed = false) {
    engine.ingest({ projectId: 'p', kind: 'reading', purpose: 'reference', externalId: kind, revision: 'v1', title: `测试依据 ${kind}`, content: quote, authorId: 'reporter', retention: 'permanent' });
    const source = store.list('sources').find(s => s.externalId === kind)!;
    recordOutcomeEvidence(store, config, snapshot.id, { projectId: 'p', domain: 'personal', kind, sourceId: source.id, sourceRevision: source.revision, quote, observedAt: '2026-01-03T00:00:00Z', ...(attributed ? { attribution: { method: 'direct_measurement', citations: [{ sourceId: source.id, revision: source.revision, quote, locator: source.locator }] } } : {}) }, config.ownerId);
    return source;
  }
  function delivery() {
    store.save('tasks', { ...task, status: 'delivered', artifact: { taskVersion: 1, planHash: 'p', baselineSha: 'base', files: [{ path: project.prdPath, content: 'Delivered' }], tests: [], summary: 'Delivery' } });
    store.save('receipts', { id: 'verified-receipt', taskId: task.id, projectId: 'p', domain: 'personal', repository: project.repository, path: project.prdPath, pullRequestUrl: 'https://example.com/1', pullRequestNumber: 1, headSha: 'head', mergeSha: 'merge', contentHash: digest('Delivered'), verifiedAt: snapshot.recordedAt, checks: [{ name: 'test', conclusion: 'success', headSha: 'head', appId: 1, url: 'https://example.com/check' }] });
  }
  return { config, store, app, project, task, snapshot, judgment, evidence, delivery, page };
}
const metric = (sampleSize: number | null = 10) => JSON.stringify({ schemaVersion: 1, name: '本地测试指标', value: 12, baseline: 8, unit: '次', sampleSize: sampleSize ?? undefined, periodStart: '2026-01-02T00:00:00Z', periodEnd: '2026-01-03T00:00:00Z' });
function reviewRegion(html: string): string {
  const opening = /<section\b[^>]*aria-labelledby="outcome-reviews-title"[^>]*>/.exec(html);
  expect(opening).not.toBeNull();
  const start = opening!.index;
  let depth = 0;
  for (const tag of html.slice(start).matchAll(/<\/?section\b[^>]*>/g)) {
    depth += tag[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, start + tag.index! + tag[0].length);
  }
  throw new Error('The labelled outcome review section must have a closing tag.');
}

describe('outcome reviews on real HTTP pages', () => {
  it('shows scheduled and due judgments, frozen original text and missing evidence as observing', async () => {
    const f = setup();
    let html = reviewRegion(await f.page());
    expect(html).toContain('待到期'); expect(html).toContain('待观察'); expect(html).toContain('datetime="2026-01-08T00:00:00.000Z"');
    vi.setSystemTime(new Date('2026-01-08T00:00:00Z')); runOutcomeReviews(f.store);
    html = reviewRegion(await f.page());
    expect(html).toContain('已到期'); expect(html).toContain('尚无当前已验证交付回执'); expect(html).toContain('尚无当前引用测量');
    expect(html).toContain('原始判断 &lt;img'); expect(html).toContain('当时初判 &lt;script&gt;'); expect(html).not.toContain('<img src=x');
    for (const label of ['交付验证', '来源报告的纠正', '来源报告的测量', '失败检查', '放弃与执行状态', '证据缺口']) expect(html).toContain(label);
  });
  it('provides distinct judgment anchors for multiple snapshots of the same task and goal', async () => {
    const f = setup();
    const firstAttempt = f.store.get('attempts', 'attempt-p')!;
    f.store.save('attempts', { ...firstAttempt, id: 'second-decide-attempt' });
    const input = { task: f.task, source: f.store.get('sources', f.task.sourceId)!, project: f.project, role: 'decide', cards: [], rules: [] } as WorkerInput;
    const second = recordDecisionSnapshot(f.store, f.task, input, f.snapshot.decision);
    expect(second.id).not.toBe(f.snapshot.id);
    const html = reviewRegion(await f.page());
    expect(html).toContain(`id="outcome-review-${f.snapshot.id}"`);
    expect(html).toContain(`id="outcome-review-${second.id}"`);
  });
  it('limits review assertions to the labelled region even when the neighboring weekly reflection is present', async () => {
    const f = setup();
    f.store.save('cases', { projectId: 'p', domain: 'personal', id: 'reflection-case', taskId: f.task.id, questionId: 'reflection-question', decisionId: f.snapshot.id, actorId: f.config.ownerId, choice: 'C', originalWords: 'REFLECTION_ONLY_SENTINEL', rationale: 'Owner words', alternatives: [], ruleIds: [], sourceId: f.task.sourceId, status: 'active', createdAt: new Date().toISOString() });
    const html = await f.page();
    expect(html).toContain('REFLECTION_ONLY_SENTINEL');
    const region = reviewRegion(html);
    expect(region).toContain('来源报告的测量');
    expect(region).toContain('查看原始任务');
    expect(region).not.toContain('REFLECTION_ONLY_SENTINEL');
    expect(region).not.toContain('weekly-reflection-title');
  });
  it('keeps an actual verified delivery pending before the first scan and shows its receipt after scanning', async () => {
    const f = setup(); vi.setSystemTime(new Date('2026-01-08T00:00:00Z')); f.delivery();
    let html = reviewRegion(await f.page());
    expect(html).toContain('交付回执待复核');
    expect(html).not.toContain('尚无当前已验证交付回执');
    expect(html).not.toContain('verified-receipt');
    expect(runOutcomeReviews(f.store)).toBe(1);
    html = reviewRegion(await f.page());
    expect(html).toContain('verified-receipt');
    expect(html).not.toContain('交付回执待复核');
    expect(html).not.toContain('尚无当前已验证交付回执');
  });
  it('labels linked metrics as associated evidence and keeps exact quotes and attribution separate from causal claims', async () => {
    const f = setup(); vi.setSystemTime(new Date('2026-01-08T00:00:00Z')); f.delivery();
    f.evidence('metric', metric(), true); f.evidence('correction', '  原文 <img src=x onerror="evidence()">\n'); runOutcomeReviews(f.store);
    const html = reviewRegion(await f.page());
    expect(html).toContain('已关联结果依据'); expect(html).toContain('不代表预测准确，也不证明业务改善');
    expect(html).toContain('12 次'); expect(html).toContain('样本量：10'); expect(html).toContain('基线：8'); expect(html).toContain('来源报告 · 直接测量');
    expect(html).toContain('verified-receipt'); expect(html).toContain('  原文 &lt;img'); expect(html).not.toContain('<img src=x'); expect(html).toContain('reporter');
    expect(html).not.toContain('尚无当前引用测量');
  });
  it.each(['unattributed', 'unknown sample'])('keeps %s measurements observing even after verified delivery', async mode => {
    const f = setup(); vi.setSystemTime(new Date('2026-01-08T00:00:00Z')); f.delivery();
    f.evidence('metric', metric(mode === 'unknown sample' ? null : 10), mode !== 'unattributed');
    runOutcomeReviews(f.store); const html = reviewRegion(await f.page()); expect(html).toContain('待观察'); expect(html).not.toContain('已关联结果依据');
    expect(html).toContain(mode === 'unattributed' ? '缺少测量归因材料' : '测量样本量未知');
  });
  it('uses legacy seven-day schedules despite a changed project setting', async () => {
    const f = setup(), action = f.store.get('actions', f.snapshot.id)!;
    f.store.save('actions', { ...action, payload: { snapshot: { ...f.snapshot, reviewAt: undefined, reviewIntervalDays: undefined } } });
    f.store.save('projects', { ...f.project, reviewIntervalDays: 30 });
    const html = reviewRegion(await f.page()); expect(html).toContain('每 7 天'); expect(html).toContain('datetime="2026-01-08T00:00:00.000Z"'); expect(html).not.toContain('每 30 天');
  });
  it('isolates project reviews and excludes a populated foreign-owner selection, switcher and task page', async () => {
    const f = setup(); f.judgment('other', 'OTHER_OWNER_JUDGMENT');
    expect(await f.page()).not.toContain('OTHER_OWNER_JUDGMENT');
    expect(await f.page('/standards?project=other')).toContain('OTHER_OWNER_JUDGMENT');
    f.store.save('projects', { ...f.config.projects[1]!, ownerId: 'foreign-owner' });
    for (const path of ['/standards?project=p', '/standards?project=other', '/sources?project=other', '/settings?project=other', '/']) {
      const html = await f.page(path); expect(html).not.toContain('OTHER_OWNER_JUDGMENT'); expect(html).not.toContain('另一个本人的项目');
    }
    const foreignTask = f.store.list('tasks').find(task => task.projectId === 'other')!;
    expect(await f.page(`/tasks/${foreignTask.id}`)).not.toContain('OTHER_OWNER_JUDGMENT');
  });
  it('hides withdrawn evidence and withdrawn subjects after real withdrawal requests', async () => {
    const f = setup(); vi.setSystemTime(new Date('2026-01-08T00:00:00Z')); const source = f.evidence('correction', 'WITHDRAWN_PRIVATE_QUOTE'); runOutcomeReviews(f.store);
    expect(reviewRegion(await f.page())).toContain('WITHDRAWN_PRIVATE_QUOTE');
    expect((await f.app.request(`/api/sources/${source.id}/withdraw`, { method: 'POST', headers: { Accept: 'application/json' } })).status).toBe(200);
    expect(reviewRegion(await f.page())).not.toContain('WITHDRAWN_PRIVATE_QUOTE');
    await f.app.request(`/api/sources/${f.task.sourceId}/withdraw`, { method: 'POST' });
    expect(reviewRegion(await f.page())).not.toContain('原始判断 &lt;img');
  });
  it('keeps source-reported abandonment, engineering failures and blocked execution distinct from business outcomes', async () => {
    const f = setup(); vi.setSystemTime(new Date('2026-01-08T00:00:00Z')); f.evidence('abandonment', '来源报告放弃'); f.evidence('failure', '来源报告失败');
    f.store.save('tasks', { ...f.task, status: 'blocked', updatedAt: new Date().toISOString(), plan: { taskVersion: 1, sourceRevision: f.task.sourceRevision, baselineSha: 'base', summary: 'Plan', paths: ['PRD.md'], steps: ['Update'], tests: ['test'], stopConditions: ['change'] }, review: { taskVersion: 1, planHash: 'p', artifactHash: 'a', verdict: 'repair', summary: 'failed', issues: [], tests: [{ command: 'test', passed: false, output: '<script>failedCheck()</script>' }] } });
    runOutcomeReviews(f.store); const html = reviewRegion(await f.page());
    expect(html).toContain('暂时阻塞'); expect(html).toContain('不等同于业务失败'); expect(html).toContain('来源报告放弃'); expect(html).toContain('来源报告失败'); expect(html).toContain('&lt;script&gt;failedCheck()');
  });
  it('labels reference source purpose without starting a task', async () => {
    const f = setup(); vi.setSystemTime(new Date('2026-01-08T00:00:00Z')); f.evidence('correction', 'Synthetic correction');
    const html = await f.page('/sources?project=p'); expect(html).toContain('结果依据'); expect(html).toContain('仅作引用，不启动执行任务'); expect(f.store.list('tasks')).toHaveLength(1);
  });
  it('renders numeric interval bounds and persists a progressive form submission into settings', async () => {
    const f = setup(), settings = await f.page('/settings?project=p');
    expect(settings).toMatch(/<input[^>]*name="reviewIntervalDays"[^>]*type="number"[^>]*min="1"[^>]*max="365"[^>]*step="1"[^>]*value="7"/);
    const response = await f.app.request('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ name: '间隔项目', domain: 'personal', repository: 'a/b', prdPath: 'PRD.md', allowedPaths: 'PRD.md', budgetUsd: '2', reviewIntervalDays: '30' }) });
    expect(response.status).toBe(200); const { project } = await response.json(); expect(project.reviewIntervalDays).toBe(30);
    expect(await f.page(`/settings?project=${project.id}`)).toContain('<dt>结果复核间隔</dt><dd>30 天</dd>');
  });
});
