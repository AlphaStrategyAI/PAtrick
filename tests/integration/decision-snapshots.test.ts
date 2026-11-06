import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest, now, roles, type AppConfig, type DeliveryReceipt, type Project, type ResearchRecord, type Rule, type WorkerAdapter } from '../../src/domain.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';

const roots: string[] = [], stores: Store[] = [];
const initialSummary = 'INITIAL_JUDGMENT_SENTINEL';
const oldStatement = 'RULE_VERSION_THREE_SENTINEL';
const prediction = 'Failed exports will retain a recoverable draft; usage impact remains unmeasured.';
const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: 'Draft product', description: '', repository: 'owner/product', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], trustedChecks: ['test'], trustedAppIds: [123], ownerId: 'owner', autoMerge: true, budgetUsd: 10, createdAt: now() };
const research: ResearchRecord = { queries: (['zh', 'en'] as const).map(language => ({ language, query: language === 'zh' ? '草稿 恢复' : 'draft recovery', searchedAt: now(), sources: [{ language, url: `https://${language}.example.com/original`, canonicalUrl: `https://${language}.example.com/original`, title: 'Original source', publishedAt: '2026-01-01', accessedAt: now(), excerpt: 'Two viable approaches', primary: true, conditions: 'Failed export' }] })), summary: 'Retention and deletion have different tradeoffs.', gaps: [] };
const option = (label: string) => ({ label, description: `Choose ${label}`, rationale: 'Original evidence', tradeoff: 'A stated cost', evidenceUrls: research.queries.flatMap(q => q.sources.map(s => s.url)) });

function setup({ ask = true, temporary = false, changeRuleDuringDecision = false, temporaryCitation = false, omitPrediction = false, dropRuleAfterAnswer = false }: { ask?: boolean; temporary?: boolean; changeRuleDuringDecision?: boolean; temporaryCitation?: boolean; omitPrediction?: boolean; dropRuleAfterAnswer?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'patrick-judgments-')); roots.push(root);
  const db = join(root, 'db.sqlite'), vault = join(root, 'vault');
  const store = new Store(db, vault); stores.push(store);
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: root, vaultDir: vault, ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, scanIntervalMs: 1000, runnerPolicies: (['grok', 'dsh', 'codex'] as const).map(runner => ({ runner, roles: [...roles], domains: ['personal'], provider: `${runner}-provider`, model: `${runner}-model`, admitted: true, costPerRunUsd: .01, independentReview: false })) };
  let changed = false;
  const workers: WorkerAdapter[] = (['grok', 'dsh', 'codex'] as const).map(name => ({ name, async run(input) {
    let output: unknown;
    if (input.role === 'knowledge_extract') output = { cards: [] };
    if (input.role === 'case_extract') output = { observations: [] };
    if (input.role === 'decide') {
      if (changeRuleDuringDecision && !changed) { changed = true; store.save('rules', { ...store.get('rules', 'used-rule')!, version: 4, statement: 'A changed rule' }); }
      const cited = temporaryCitation ? store.get('sources', 'temporary-evidence')! : input.source;
      output = { action: ask && !input.answer ? 'ask' : 'proceed', summary: input.answer ? 'Later judgment after the answer' : initialSummary, rationale: 'Use the rule as it existed before the owner answered.', ...(omitPrediction ? {} : { expectedOutcome: prediction }), citations: [{ sourceId: cited.id, revision: cited.revision, quote: temporaryCitation ? cited.content : '保留草稿', locator: cited.locator }], ruleIds: input.answer && dropRuleAfterAnswer ? [] : ['used-rule'], grounds:{statements:[{citation:{sourceId:cited.id,revision:cited.revision,quote:temporaryCitation?cited.content:'保留草稿',locator:cited.locator},purpose:temporaryCitation?'author-statement':'requirement',binding:temporaryCitation?'source-statement':'task-request'}],facts:[],unresolved:[]}, ...(ask && !input.answer ? { question: { title: 'Keep drafts?', context: 'Retention requires an owner tradeoff.', A: option('retain'), B: option('delete') } } : {}) };
    }
    if (input.role === 'plan') output = { taskVersion: input.task.version, sourceRevision: input.source.revision, baselineSha: 'baseline', summary: 'Update PRD', paths: [project.prdPath], steps: ['Retain recovery behavior'], tests: ['test'], stopConditions: ['Source changes'] };
    if (input.role === 'execute') output = { taskVersion: input.task.version, planHash: digest(input.plan!), baselineSha: 'baseline', files: [{ path: project.prdPath, content: '# PRD\nKeep drafts.' }], tests: [{ command: 'test', passed: true, output: '1 passed' }], summary: 'Updated' };
    if (input.role === 'check') output = { taskVersion: input.task.version, planHash: digest(input.plan!), artifactHash: digest(input.artifact!), verdict: 'pass', summary: 'Checked', issues: [], tests: [{ command: 'test', passed: true, output: '1 passed' }] };
    if (input.role === 'feedback') output = { summary: 'Verified file delivery; product usage remains unmeasured.', observations: [] };
    return { output, costUsd: .01, provider: `${name}-provider`, model: `${name}-model` };
  } }));
  const engine = new Workbench({ store, config, workers, research: { async research() { return research; } }, writer: { async baseline() { return 'baseline'; }, async deliver(task) { return { id: `receipt-${task.id}`, taskId: task.id, projectId: task.projectId, domain: task.domain, repository: project.repository, path: project.prdPath, pullRequestUrl: 'https://github.com/owner/product/pull/1', pullRequestNumber: 1, headSha: 'head', mergeSha: 'merged', contentHash: digest(task.artifact!.files[0]!.content), verifiedAt: now(), checks: [{ name: 'test', conclusion: 'success', headSha: 'head', appId: 123, url: 'https://github.com/owner/product/actions/1' }] } satisfies DeliveryReceipt; } } });
  const task = engine.ingest({ projectId: project.id, externalId: 'idea', title: 'Recover a failed export', content: '导出失败后保留草稿。', retention: temporary ? 'ephemeral' : 'permanent' })!;
  const source = store.get('sources', task.sourceId)!;
  const rule: Rule = { id: 'used-rule', projectId: 'p', domain: 'personal', title: 'Recovery observation', statement: oldStatement, conditions: 'Failed exports', exceptions: 'Unknown', version: 3, kind: 'observation', status: 'active', caseIds: [], citations: [{ sourceId: source.id, revision: source.revision, quote: '保留草稿', locator: source.locator }], createdAt: now(), reviewAt: new Date(Date.now() + 86400_000).toISOString() };
  store.save('rules', rule); store.save('rules', { ...rule, id: 'unused-rule', statement: 'Not used by this decision' });
  const answer = (choice: 'A' | 'B' | 'C') => { const q = store.list('questions').find(q => q.status === 'open')!; return engine.answer({ questionId: q.id, taskVersion: q.taskVersion, questionVersion: q.version, actorId: 'owner', eventId: 'answer', choice, ...(choice === 'C' ? { text: '只保留到下次成功导出' } : {}) }); };
  const reopen = () => { store.close(); const next = new Store(db, vault); stores.push(next); return next; };
  return { root, db, vault, store, engine, task, answer, reopen };
}

function vaultText(root: string): string {
  return readdirSync(root, { withFileTypes: true }).map(item => item.isDirectory() ? vaultText(join(root, item.name)) : item.name.endsWith('.md') ? readFileSync(join(root, item.name), 'utf8') : '').join('\n');
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('frozen decision history', () => {
  it.each(['A', 'B', 'C'] as const)('preserves the actual pre-answer judgment and rule versions after %s, delivery and restart', async choice => {
    const f = setup(); await f.engine.runUntilIdle();
    const question = f.store.list('questions').find(q => q.status === 'open')!;
    f.answer(choice); await f.engine.runUntilIdle();
    expect(f.store.get('tasks', f.task.id)?.status).toBe('delivered');
    f.store.save('rules', { ...f.store.get('rules', 'used-rule')!, version: 4, statement: 'Later changed content' });
    const store = f.reopen(), c = store.list('cases')[0]!;
    expect(c.decisionSnapshot).toMatchObject({ schemaVersion: 1, taskId: f.task.id, taskVersion: 1, goal: { title: 'Recover a failed export' }, decision: { summary: initialSummary }, expectedOutcome: prediction });
    expect(c.decisionSnapshot?.rules.map(r => [r.id, r.version, r.statement])).toEqual([['used-rule', 3, oldStatement]]);
    expect(c.decisionSnapshot?.id).toBe(question.decisionSnapshotId);
    expect(c.decisionId).toBe(c.decisionSnapshot?.id);
    expect(c.decisionSnapshot?.decision.citations[0]?.quote).toBe('保留草稿');
    expect(c.outcomes).toEqual([expect.objectContaining({ receiptId: `receipt-${f.task.id}`, summary: 'Verified file delivery; product usage remains unmeasured.' })]);
    const snapshot = store.get('actions', c.decisionId)?.payload.snapshot;
    expect(snapshot).toEqual(c.decisionSnapshot);
    expect(vaultText(f.vault)).toContain(initialSummary);
  });

  it('records a no-question judgment before later stages overwrite task state', async () => {
    const f = setup({ ask: false }); await f.engine.runUntilIdle();
    const task = f.store.get('tasks', f.task.id)!;
    expect(task.decisionSnapshotId).toBeTruthy();
    const action = f.store.get('actions', task.decisionSnapshotId!)!;
    expect(action.kind).toBe('decision.snapshot');
    expect(action.payload.snapshot).toMatchObject({ decision: { summary: initialSummary }, expectedOutcome: prediction, taskId: task.id });
  });

  it('retracts readable snapshots and appended results with their source', async () => {
    const f = setup(); await f.engine.runUntilIdle(); f.answer('C'); await f.engine.runUntilIdle();
    expect(f.store.list('cases')[0]?.decisionSnapshot?.decision.summary).toBe(initialSummary);
    expect(f.store.list('cases')[0]?.outcomes).toHaveLength(1);
    f.engine.withdraw(f.task.sourceId);
    const store = f.reopen();
    expect(store.list('cases')[0]?.decisionSnapshot).toBeUndefined();
    expect(store.list('cases')[0]?.outcomes).toBeUndefined();
    const persisted = JSON.stringify(['tasks', 'cases', 'questions', 'actions'].map(table => store.list(table as 'tasks' | 'cases' | 'questions' | 'actions'))) + vaultText(f.vault);
    expect(persisted).not.toContain(initialSummary); expect(persisted).not.toContain(oldStatement); expect(persisted).not.toContain(prediction);
  });

  it('keeps a temporary judgment and case in memory without publishing their text', async () => {
    const f = setup({ temporary: true }); await f.engine.runUntilIdle(); f.answer('A'); await f.engine.runUntilIdle();
    expect(f.store.list('cases')[0]?.decisionSnapshot?.decision.summary).toBe(initialSummary);
    const store = f.reopen();
    const persisted = JSON.stringify(['tasks', 'cases', 'questions', 'actions'].map(table => store.list(table as 'tasks' | 'cases' | 'questions' | 'actions'))) + vaultText(f.vault);
    expect(persisted).not.toContain(initialSummary); expect(persisted).not.toContain(oldStatement); expect(persisted).not.toContain(prediction);
  });

  it('rejects a deciding result if a used rule changed after its frozen input', async () => {
    const f = setup({ changeRuleDuringDecision: true }); await f.engine.runUntilIdle();
    expect(f.store.list('questions')).toEqual([]);
    expect(f.store.list('actions').filter(a => a.kind === 'decision.snapshot')).toEqual([]);
    expect(f.store.get('tasks', f.task.id)?.status).toBe('blocked');
  });

  it.each(['rule', 'citation'] as const)('does not persist a temporary source through a permanent task %s', async through => {
    const f = setup({ ask: false, temporaryCitation: through === 'citation' });
    const source = f.store.get('sources', f.task.sourceId)!, secret = 'TEMPORARY_EVIDENCE_SENTINEL';
    const temporarySource = { ...source, id: 'temporary-evidence', externalId: 'temporary', retention: 'ephemeral' as const, content: secret, revision: digest(secret), locator: 'temporary:source' };
    f.store.save('sources', temporarySource);
    if (through === 'rule') f.store.save('rules', { ...f.store.get('rules', 'used-rule')!, statement: secret, citations: [{ sourceId: temporarySource.id, revision: temporarySource.revision, quote: secret, locator: temporarySource.locator }] });
    await f.engine.runUntilIdle();
    expect(f.store.get('tasks', f.task.id)?.status).toBe('blocked');
    expect(f.store.list('actions').filter(a => a.kind === 'decision.snapshot')).toEqual([]);
    const store = f.reopen();
    const persisted = JSON.stringify(['tasks', 'cases', 'questions', 'actions'].map(table => store.list(table as 'tasks' | 'cases' | 'questions' | 'actions'))) + vaultText(f.vault);
    expect(persisted).not.toContain(secret);
  });

  it('records an unspecified historical prediction as unknown', async () => {
    const f = setup({ ask: false, omitPrediction: true }); await f.engine.runUntilIdle();
    const task = f.store.get('tasks', f.task.id)!;
    expect(f.store.get('actions', task.decisionSnapshotId!)?.payload.snapshot).toMatchObject({ expectedOutcome: null });
  });

  it('keeps pre-upgrade questions answerable without inventing a historical snapshot', async () => {
    const f = setup(); await f.engine.runUntilIdle();
    const q = f.store.list('questions').find(q => q.status === 'open')!;
    f.store.save('questions', { ...q, decisionSnapshotId: undefined });
    f.answer('B');
    expect(f.store.list('cases')[0]?.choice).toBe('B');
    expect(f.store.list('cases')[0]?.decisionSnapshot).toBeUndefined();
  });

  it('does not replace or duplicate the first recorded result during feedback replay', async () => {
    const f = setup(); await f.engine.runUntilIdle(); f.answer('A'); await f.engine.runUntilIdle();
    const before = structuredClone(f.store.list('cases')[0]!.outcomes);
    expect(before).toHaveLength(1);
    const task = f.store.get('tasks', f.task.id)!;
    f.store.save('tasks', { ...task, status: 'feedback', stage: 'feedback' });
    await f.engine.runUntilIdle();
    expect(f.store.list('cases')[0]?.outcomes).toEqual(before);
  });

  it('retracts evidence used only by the historical judgment after the current judgment stops using it', async () => {
    const f = setup({ dropRuleAfterAnswer: true });
    const original = f.store.get('sources', f.task.sourceId)!;
    const reference = { ...original, id: 'earlier-reference', externalId: 'reference', title: 'Earlier reference', content: oldStatement, revision: digest(oldStatement), locator: 'manual:reference' };
    f.store.save('sources', reference);
    f.store.save('rules', { ...f.store.get('rules', 'used-rule')!, citations: [{ sourceId: reference.id, revision: reference.revision, quote: reference.content, locator: reference.locator }] });
    await f.engine.runUntilIdle(); f.answer('C'); await f.engine.runUntilIdle();
    expect(f.store.get('tasks', f.task.id)?.decision?.ruleIds).toEqual([]);
    expect(f.store.list('cases')[0]?.decisionSnapshot?.sourceRefs).toContainEqual({ id: reference.id, revision: reference.revision });
    f.engine.withdraw(reference.id);
    const store = f.reopen();
    expect(store.list('cases')[0]?.decisionSnapshot).toBeUndefined();
    expect(JSON.stringify(store.list('actions')) + JSON.stringify(store.list('cases')) + vaultText(f.vault)).not.toContain(oldStatement);
  });

  it('clears task derivatives reached only through an earlier no-question judgment', async () => {
    const f = setup({ ask: false });
    const original = f.store.get('sources', f.task.sourceId)!, secret = 'HISTORICAL_ONLY_DERIVATIVE_SENTINEL';
    const reference = { ...original, id: 'old-judgment-reference', externalId: 'reference', title: 'Earlier reference', content: secret, revision: digest(secret), locator: 'manual:old-reference' };
    f.store.save('sources', reference);
    f.store.save('rules', { ...f.store.get('rules', 'used-rule')!, citations: [{ sourceId: reference.id, revision: reference.revision, quote: secret, locator: reference.locator }] });
    await f.engine.runUntilIdle();
    const task = f.store.get('tasks', f.task.id)!;
    expect(f.store.list('cases')).toEqual([]);
    expect(f.store.get('actions', task.decisionSnapshotId!)?.payload.snapshot).toMatchObject({ sourceRefs: expect.arrayContaining([{ id: reference.id, revision: reference.revision }]) });
    // A later judgment can stop naming the old rule while earlier artifacts still derive from it.
    f.store.save('tasks', { ...task, decisionSnapshotId: undefined, decision: { ...task.decision!, ruleIds: [] }, artifact: { ...task.artifact!, files: [{ path: project.prdPath, content: secret }] }, feedback: secret });
    f.engine.withdraw(reference.id);
    const store = f.reopen(), retracted = store.get('tasks', task.id)!;
    expect(retracted.artifact).toBeUndefined(); expect(retracted.feedback).toBeUndefined();
    expect(JSON.stringify(store.list('tasks')) + JSON.stringify(store.list('actions')) + vaultText(f.vault)).not.toContain(secret);
  });
});
