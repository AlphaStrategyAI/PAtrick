import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError, now, roles, stableId, type AppConfig, type DeliveryReceipt, type Project, type Question, type Rule, type WorkerAdapter } from '../../src/domain.js';
import { caseVersions, refreshCaseVersions } from '../../src/cases.js';
import { Workbench } from '../../src/orchestrator.js';
import { recordOutcomeEvidence } from '../../src/reviews.js';
import { appendCaseOutcome } from '../../src/standards.js';
import { Store } from '../../src/store.js';

const stores: Store[] = [];
const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: 'Product', description: '', repository: 'owner/product', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/'], trustedChecks: ['test'], trustedAppIds: [1], ownerId: 'owner', autoMerge: true, budgetUsd: 1, createdAt: now() };
function setup(database = ':memory:', retention: 'permanent' | 'ephemeral' = 'permanent') {
  const store = new Store(database); stores.push(store);
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: '/tmp', vaultDir: '/tmp', ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, runnerPolicies: [], scanIntervalMs: 1000 };
  const engine = new Workbench({ store, config, workers: [], writer: { async baseline() { throw new Error('unused'); }, async deliver() { throw new Error('unused'); } }, research: { async research() { throw new Error('unused'); } } });
  function question(id: string) {
    const task = engine.ingest({ projectId: 'p', externalId: id, title: 'Drafts', content: 'Keep the owner draft.', retention })!;
    const suggestion = (label: string) => ({ label, description: `Choose ${label}`, rationale: 'Evidence', tradeoff: 'Cost', evidenceUrls: ['https://example.com'] });
    const q: Question = { id, projectId: 'p', domain: 'personal', taskId: task.id, taskVersion: 1, version: 1, ownerId: 'owner', title: 'Keep drafts?', context: 'Choose', options: { A: suggestion('keep'), B: suggestion('delete') }, research: { queries: [], summary: '', gaps: [] }, status: 'open', createdAt: now() };
    store.save('questions', q); store.save('tasks', { ...task, status: 'awaiting_answer', stage: 'decide', questionId: id });
    return q;
  }
  return { store, engine, config, question };
}
afterEach(() => stores.splice(0).forEach(store => store.close()));

describe('canonical owner cases', () => {
  it('keeps the accepted answer when the case snapshot is unavailable and finishes it once the snapshot can be read', () => {
    const f = setup(), q = f.question('snapshot-failure');
    const before = f.store.get('tasks', q.taskId)!, list = f.store.list.bind(f.store);
    const fault = vi.spyOn(f.store, 'list').mockImplementation(((...args: Parameters<typeof list>) => {
      if (args[0] === 'actions' && new Error().stack?.includes('relatedQuestionSnapshots')) throw new DomainError('Knowledge temporarily unavailable; retry.', 'knowledge_snapshot_unavailable', 503);
      return list(...args);
    }) as typeof f.store.list);
    const answer = { questionId: q.id, taskVersion: 1, questionVersion: 1, actorId: 'owner', eventId: 'failed-answer', choice: 'C' as const, text: 'Keep drafts.' };
    try {
      const task = f.engine.answer(answer);
      expect(task).toMatchObject({ id: before.id, version: before.version + 1, status: 'deciding' });
      expect(f.store.get('questions', q.id)?.status).toBe('answered');
      expect(f.store.list('cases')).toHaveLength(0);
      expect(f.store.get('actions', stableId('owner-answer-collect', q.id))?.status).toBe('pending');
    } finally { fault.mockRestore(); }
    f.engine.answer(answer);
    expect(f.store.get('questions', q.id)?.status).toBe('answered');
    expect(f.store.get('tasks', q.taskId)?.version).toBe(before.version + 1);
    expect(f.store.list('cases')).toHaveLength(1);
    expect(f.store.get('cursors', stableId('answer-event', 'p', 'personal', 'failed-answer'))?.value).toBeTruthy();
  });
  it.each(['A', 'B', 'C'] as const)('freezes answer %s once, including replay and a separate identical question', choice => {
    const f = setup();
    const q = f.question('question-1');
    const answer = { questionId: q.id, taskVersion: 1, questionVersion: 1, actorId: 'owner', eventId: 'event-1', choice, ...(choice === 'C' ? { text: 'Keep drafts for one day.' } : {}) };
    f.engine.answer(answer); f.engine.answer(answer);
    const first = f.store.list('cases')[0]!;
    const versions = () => f.store.list('actions').filter(action => action.kind === 'decision.case-version');
    expect(versions()).toHaveLength(1);
    expect(versions()[0]!.payload.case).toMatchObject({ id: stableId('canonical-case', 'p', 'personal', 'question', q.id), version: 1, original: { kind: 'question', id: q.id }, authority: 'owner-explicit', ownerCaseId: first.id, choiceText: first.originalWords, frozenJudgment: null, expectedOutcome: null });
    const q2 = f.question('question-2');
    f.engine.answer({ ...answer, questionId: q2.id, eventId: 'event-2' });
    expect(versions()).toHaveLength(2);
    expect(new Set(versions().map(action => (action.payload.case as { id: string }).id)).size).toBe(2);
  });
  it('appends only genuine new delivery evidence and retracts readable case history on withdrawal', () => {
    const f = setup(), q = f.question('question-result');
    f.engine.answer({ questionId: q.id, taskVersion: 1, questionVersion: 1, actorId: 'owner', eventId: 'event-result', choice: 'C', text: 'Keep drafts until export succeeds.' });
    const task = f.store.get('tasks', q.taskId)!;
    const receipt: DeliveryReceipt = { id: 'receipt', taskId: task.id, projectId: 'p', domain: 'personal', repository: project.repository, path: project.prdPath, pullRequestUrl: 'https://example.com/pr/1', pullRequestNumber: 1, headSha: 'head', mergeSha: 'merged', contentHash: 'hash', verifiedAt: now(), checks: [] };
    f.store.save('receipts', receipt);
    appendCaseOutcome(f.store, task, receipt, 'Delivery confirmed.', f.config);
    appendCaseOutcome(f.store, task, receipt, 'Delivery confirmed.', f.config);
    const versions = caseVersions(f.store, f.config, project).sort((a, b) => a.version - b.version);
    expect(versions.map(v => v.version)).toEqual([1, 2]);
    expect(versions[1]).toMatchObject({ choiceText: versions[0]!.choiceText, frozenJudgment: versions[0]!.frozenJudgment, observationRefs: [{ kind: 'receipt', id: receipt.id }] });
    f.engine.withdraw(task.sourceId);
    expect(caseVersions(f.store, f.config, project)).toEqual([]);
    expect(JSON.stringify(f.store.list('actions'))).not.toContain('Keep drafts until export succeeds.');
    expect(f.store.list('actions').filter(a => a.kind === 'decision.case-version').map(a => a.payload)).toEqual(expect.arrayContaining([expect.objectContaining({ retracted: true, hash: versions[0]!.hash }), expect.objectContaining({ retracted: true, hash: versions[1]!.hash })]));
  });
  it('keeps temporary answer versions out of the reopened store', () => {
    const root = mkdtempSync(join(tmpdir(), 'patrick-case-'));
    try {
      const path = join(root, 'db.sqlite'), f = setup(path, 'ephemeral'), q = f.question('temporary-question');
      f.engine.answer({ questionId: q.id, taskVersion: 1, questionVersion: 1, actorId: 'owner', eventId: 'temporary-event', choice: 'C', text: 'TEMPORARY_CASE_SENTINEL' });
      expect(caseVersions(f.store, f.config, project)).toHaveLength(1);
      f.store.close();
      const reopened = new Store(path); stores.push(reopened);
      expect(caseVersions(reopened, f.config, project)).toEqual([]);
      expect(JSON.stringify([reopened.list('actions'), reopened.list('cases'), reopened.list('questions')])).not.toContain('TEMPORARY_CASE_SENTINEL');
    } finally { for (const store of stores.splice(0)) store.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it('captures an actual no-question judgment and versions only new underlying outcome evidence', async () => {
    const store = new Store(':memory:'); stores.push(store);
    const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: '/tmp', vaultDir: '/tmp', ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, runnerPolicies: [{ runner: 'grok', roles: [...roles], domains: ['personal'], provider: 'provider', model: 'model', admitted: true, costPerRunUsd: .01, independentReview: false }], scanIntervalMs: 1000 };
    const worker: WorkerAdapter = { name: 'grok', async run(input) {
      const citation = { sourceId: input.source.id, revision: input.source.revision, quote: 'Keep drafts.', locator: input.source.locator };
      const output = input.role === 'knowledge_extract' ? { cards: [] } : input.role === 'case_extract' ? { observations: [] } : { action: 'proceed', summary: 'Keep drafts', rationale: 'Recovery', expectedOutcome: 'Drafts remain recoverable.', citations: [citation], ruleIds: ['used-rule'], grounds: { statements: [{ citation, purpose: 'requirement', binding: 'task-request' }], facts: [], unresolved: [] } };
      return { output, costUsd: .01, provider: 'provider', model: 'model' };
    } };
    const engine = new Workbench({ store, config, workers: [worker], writer: { async baseline() { throw new Error('unused'); }, async deliver() { throw new Error('unused'); } }, research: { async research() { throw new Error('unused'); } } });
    const task = engine.ingest({ projectId: 'p', externalId: 'no-question', title: 'Drafts', content: 'Keep drafts.' })!, source = store.get('sources', task.sourceId)!;
    const rule: Rule = { id: 'used-rule', projectId: 'p', domain: 'personal', title: 'Recovery', statement: 'Rule version three', conditions: 'Drafts', exceptions: 'None', version: 3, kind: 'observation', status: 'active', caseIds: [], citations: [{ sourceId: source.id, revision: source.revision, quote: source.content, locator: source.locator }], createdAt: now(), reviewAt: new Date(Date.now() + 86400000).toISOString() };
    store.save('rules', rule);
    store.save('actions', { id: 'monthly-admission', projectId: 'p', domain: 'personal', kind: 'decision.monthly-comparison', status: 'completed', payload: { comparison: { trial: 'single-product', candidateId: 'used-rule', reverted: false } }, updatedAt: now() });
    await engine.tick(); await engine.tick(); await engine.tick();
    const snapshotId = store.get('tasks', task.id)!.decisionSnapshotId!;
    const before = caseVersions(store, config, project);
    expect(before).toMatchObject([{ authority: 'source-report', identity: 'host-bound', decisionSnapshotId: snapshotId, expectedOutcome: 'Drafts remain recoverable.', frozenJudgment: { rules: [{ version: 3, statement: 'Rule version three' }] } }]);
    store.save('rules', { ...rule, version: 4, statement: 'Changed later' });
    engine.ingest({ projectId: 'p', externalId: 'result', title: 'Correction', content: 'Draft recovery failed.', purpose: 'reference' });
    const result = store.list('sources').find(s => s.externalId === 'result')!, at = new Date();
    recordOutcomeEvidence(store, config, snapshotId, { projectId: 'p', domain: 'personal', kind: 'failure', sourceId: result.id, sourceRevision: result.revision, quote: result.content, observedAt: at.toISOString(), attribution: { method: 'none', citations: [] } }, 'owner', at);
    const versions = caseVersions(store, config, project, at).sort((a, b) => a.version - b.version);
    expect(versions.map(v => v.version)).toEqual([1, 2]);
    expect(versions[1]).toMatchObject({ frozenJudgment: before[0]!.frozenJudgment, expectedOutcome: before[0]!.expectedOutcome, observationRefs: [expect.objectContaining({ kind: 'outcome-evidence' })] });
    const receipt: DeliveryReceipt = { id: 'no-question-receipt', taskId: task.id, projectId: 'p', domain: 'personal', repository: project.repository, path: project.prdPath, pullRequestUrl: 'https://example.com/pr/2', pullRequestNumber: 2, headSha: 'head', mergeSha: 'merged', contentHash: 'hash', verifiedAt: now(), checks: [] };
    store.save('receipts', receipt);
    const delivery = { ...store.get('tasks', task.id)!, receiptId: receipt.id, stage: 'feedback' as const, status: 'feedback' as const };
    store.save('tasks', delivery); appendCaseOutcome(store, delivery, receipt, 'Delivery confirmed.', config);
    expect(caseVersions(store, config, project).sort((a, b) => a.version - b.version)[2]).toMatchObject({ frozenJudgment: before[0]!.frozenJudgment, observationRefs: expect.arrayContaining([expect.objectContaining({ kind: 'receipt', id: receipt.id })]) });
    const current = store.get('tasks', task.id)!;
    store.save('tasks', { ...current, version: current.version + 1, stage: 'decide', status: 'deciding' });
    await engine.tick();
    expect(caseVersions(store, config, project).map(v => v.version)).toEqual([1, 2, 3]);
    expect(refreshCaseVersions(store, config, project)).toBe(0);
    expect(refreshCaseVersions(store, config, project)).toBe(0);
  });
  it('keeps the real question judgment and rule body frozen after the owner answers', async () => {
    const store = new Store(':memory:'); stores.push(store);
    const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: '/tmp', vaultDir: '/tmp', ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, runnerPolicies: [{ runner: 'grok', roles: [...roles], domains: ['personal'], provider: 'provider', model: 'model', admitted: true, costPerRunUsd: .01, independentReview: false }], scanIntervalMs: 1000 };
    const urls = ['https://zh.example.com/evidence', 'https://en.example.com/evidence'];
    const research = { queries: (['zh', 'en'] as const).map((language, i) => ({ language, query: language === 'zh' ? '草稿 保留' : 'draft retention', searchedAt: now(), sources: [{ language, url: urls[i]!, canonicalUrl: urls[i]!, title: 'Evidence', publishedAt: '2026-01-01', accessedAt: now(), excerpt: 'The alternatives differ.', primary: true, conditions: 'Drafts' }] })), summary: 'Both choices have tradeoffs.', gaps: [] };
    const suggestion = (label: string) => ({ label, description: `Choose ${label}`, rationale: 'Evidence', tradeoff: 'Cost', evidenceUrls: urls });
    const worker: WorkerAdapter = { name: 'grok', async run(input) {
      const citation = { sourceId: input.source.id, revision: input.source.revision, quote: 'Keep drafts.', locator: input.source.locator };
      const output = input.role === 'knowledge_extract' ? { cards: [] } : input.role === 'case_extract' ? { observations: [] } : { action: input.answer ? 'proceed' : 'ask', summary: input.answer ? 'After the answer' : 'Initial judgment', rationale: 'Choose a retention period.', expectedOutcome: 'Recovery remains possible.', citations: [citation], ruleIds: ['question-rule'], grounds: { statements: [{ citation, purpose: 'requirement', binding: 'task-request' }], facts: [], unresolved: [] }, ...(!input.answer ? { question: { title: 'Keep drafts?', context: 'Choose a retention period.', A: suggestion('keep'), B: suggestion('delete') } } : {}) };
      return { output, costUsd: .01, provider: 'provider', model: 'model' };
    } };
    const engine = new Workbench({ store, config, workers: [worker], writer: { async baseline() { throw new Error('unused'); }, async deliver() { throw new Error('unused'); } }, research: { async research() { return research; } } });
    const task = engine.ingest({ projectId: 'p', externalId: 'question-judgment', title: 'Drafts', content: 'Keep drafts.' })!, source = store.get('sources', task.sourceId)!;
    const rule: Rule = { id: 'question-rule', projectId: 'p', domain: 'personal', title: 'Recovery', statement: 'Original rule', conditions: 'Drafts', exceptions: 'None', version: 3, kind: 'observation', status: 'active', caseIds: [], citations: [{ sourceId: source.id, revision: source.revision, quote: source.content, locator: source.locator }], createdAt: now(), reviewAt: new Date(Date.now() + 86400000).toISOString() };
    store.save('rules', rule);
    store.save('actions', { id: 'monthly-admission', projectId: 'p', domain: 'personal', kind: 'decision.monthly-comparison', status: 'completed', payload: { comparison: { trial: 'single-product', candidateId: 'question-rule', reverted: false } }, updatedAt: now() });
    for (let i = 0; i < 5; i++) await engine.tick();
    const q = store.list('questions')[0]!;
    engine.answer({ questionId: q.id, taskVersion: q.taskVersion, questionVersion: q.version, actorId: 'owner', eventId: 'actual-question-answer', choice: 'A' });
    store.save('rules', { ...rule, version: 4, statement: 'Later rule' });
    expect(caseVersions(store, config, project)).toMatchObject([{ original: { kind: 'question', id: q.id }, choiceText: expect.stringContaining('Choose keep'), frozenJudgment: { decision: { summary: 'Initial judgment' }, rules: [{ version: 3, statement: 'Original rule' }] }, expectedOutcome: 'Recovery remains possible.' }]);
    await engine.tick();
    const laterSnapshot = store.get('tasks', task.id)!.decisionSnapshotId!;
    engine.ingest({ projectId: 'p', externalId: 'post-answer-result', title: 'Result', content: 'Draft recovery failed.', purpose: 'reference' });
    const result = store.list('sources').find(s => s.externalId === 'post-answer-result')!, at = new Date();
    recordOutcomeEvidence(store, config, laterSnapshot, { projectId: 'p', domain: 'personal', kind: 'failure', sourceId: result.id, sourceRevision: result.revision, quote: result.content, observedAt: at.toISOString(), attribution: { method: 'none', citations: [] } }, 'owner', at);
    const versions = caseVersions(store, config, project, at).filter(v => v.original.kind === 'question').sort((a, b) => a.version - b.version);
    expect(versions.map(v => v.version)).toEqual([1, 2]);
    expect(versions[1]).toMatchObject({ frozenJudgment: versions[0]!.frozenJudgment, expectedOutcome: versions[0]!.expectedOutcome, observationRefs: [expect.objectContaining({ kind: 'outcome-evidence' })] });
  });
  it('attaches evidence for a second real question only to that question', async () => {
    const store = new Store(':memory:'); stores.push(store);
    const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: '/tmp', vaultDir: '/tmp', ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, runnerPolicies: [{ runner: 'grok', roles: [...roles], domains: ['personal'], provider: 'provider', model: 'model', admitted: true, costPerRunUsd: .01, independentReview: false }], scanIntervalMs: 1000 };
    const urls = ['https://zh.example.com/evidence', 'https://en.example.com/evidence'];
    const research = { queries: (['zh', 'en'] as const).map((language, i) => ({ language, query: language === 'zh' ? '草稿 保留' : 'draft retention', searchedAt: now(), sources: [{ language, url: urls[i]!, canonicalUrl: urls[i]!, title: 'Evidence', publishedAt: '2026-01-01', accessedAt: now(), excerpt: 'The alternatives differ.', primary: true, conditions: 'Drafts' }] })), summary: 'Both choices have tradeoffs.', gaps: [] };
    const suggestion = (label: string) => ({ label, description: `Choose ${label}`, rationale: 'Evidence', tradeoff: 'Cost', evidenceUrls: urls });
    const worker: WorkerAdapter = { name: 'grok', async run(input) {
      const citation = { sourceId: input.source.id, revision: input.source.revision, quote: 'Keep drafts.', locator: input.source.locator };
      const output = input.role === 'knowledge_extract' ? { cards: [] } : input.role === 'case_extract' ? { observations: [] } : { action: 'ask', summary: 'A genuine tradeoff', rationale: 'Choose a retention period.', citations: [citation], ruleIds: [], grounds: { statements: [{ citation, purpose: 'requirement', binding: 'task-request' }], facts: [], unresolved: [] }, question: { title: input.task.version === 1 ? 'First choice' : 'Second choice', context: 'Choose.', A: suggestion('keep'), B: suggestion('delete') } };
      return { output, costUsd: .01, provider: 'provider', model: 'model' };
    } };
    const engine = new Workbench({ store, config, workers: [worker], writer: { async baseline() { throw new Error('unused'); }, async deliver() { throw new Error('unused'); } }, research: { async research() { return research; } } });
    engine.ingest({ projectId: 'p', externalId: 'two-questions', title: 'Drafts', content: 'Keep drafts.' });
    for (let i = 0; i < 5; i++) await engine.tick();
    const first = store.list('questions')[0]!;
    engine.answer({ questionId: first.id, taskVersion: first.taskVersion, questionVersion: first.version, actorId: 'owner', eventId: 'first-answer', choice: 'A' });
    await engine.tick();
    const second = store.list('questions').find(q => q.id !== first.id)!;
    engine.answer({ questionId: second.id, taskVersion: second.taskVersion, questionVersion: second.version, actorId: 'owner', eventId: 'second-answer', choice: 'B' });
    engine.ingest({ projectId: 'p', externalId: 'second-result', title: 'Result', content: 'The second choice failed.', purpose: 'reference' });
    const source = store.list('sources').find(s => s.externalId === 'second-result')!, at = new Date();
    recordOutcomeEvidence(store, config, second.decisionSnapshotId!, { projectId: 'p', domain: 'personal', kind: 'failure', sourceId: source.id, sourceRevision: source.revision, quote: source.content, observedAt: at.toISOString(), attribution: { method: 'none', citations: [] } }, 'owner', at);
    const versions = caseVersions(store, config, project, at);
    expect(versions.filter(v => v.original.id === first.id).map(v => v.version)).toEqual([1]);
    expect(versions.filter(v => v.original.id === second.id).map(v => v.version)).toEqual([1, 2]);
  });
});
