import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { now, type DecisionCase, type DecisionSnapshot, type Project, type Rule, type SourceRevision } from '../../src/domain.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));

function setup() {
  const createdAt = new Date(Date.now() - 3_600_000).toISOString();
  const scope = { projectId: 'snapshot-ui', domain: 'personal' };
  const project: Project = { ...scope, id: scope.projectId, name: '历史判断验收', description: '', repository: 'owner/product', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], trustedChecks: [], trustedAppIds: [], ownerId: 'owner', autoMerge: false, budgetUsd: 2, createdAt };
  const config = readConfig({ PATRICK_MODE: 'demo', PATRICK_HOST: '127.0.0.1' });
  config.projects = [project];
  const store = new Store(':memory:');
  stores.push(store);
  store.save('projects', project);
  const source: SourceRevision = { ...scope, id: 'idea-source', kind: 'manual', externalId: 'idea', revision: 'idea-revision', title: '草稿恢复的原始讨论', content: '导出失败后需要恢复草稿。', locator: 'manual:idea', authorId: 'owner', retention: 'permanent', status: 'active', createdAt };
  const ownerSource: SourceRevision = { ...source, id: 'owner-answer', externalId: 'owner-answer', revision: 'answer-revision', title: '本人答复', content: '保留草稿 <img src=x onerror="ownerDecision()">', locator: 'manual:answer' };
  store.save('sources', source);
  store.save('sources', ownerSource);
  const frozenRule: Rule = { ...scope, id: 'recovery-rule', title: '草稿恢复规则', statement: 'FROZEN_RULE_VERSION_THREE_ONLY', conditions: '失败导出', exceptions: '明确要求删除的情况', version: 3, kind: 'principle', status: 'active', caseIds: [], citations: [{ sourceId: source.id, revision: source.revision, quote: '恢复草稿', locator: source.locator }], createdAt, reviewAt: now() };
  const currentRule: Rule = { ...frozenRule, version: 4, statement: 'CURRENT_RULE_VERSION_FOUR_ONLY', caseIds: ['snapshot-case'] };
  const snapshot: DecisionSnapshot = {
    ...scope, schemaVersion: 1, id: 'decision-snapshot', taskId: 'task-ui', taskVersion: 1, attemptId: 'decide-attempt', inputHash: 'frozen-input', sourceId: source.id, sourceRevision: source.revision,
    goal: { title: '保住用户已完成的编辑', description: '原始目标 <em>不能冒充页面标记</em>' },
    decision: { action: 'proceed', summary: '当时建议保留失败草稿 <script id="snapshot-payload">alert(1)</script>', rationale: 'INITIAL_REASON_ONLY：恢复机会比立即清理更重要。', ruleIds: [frozenRule.id], citations: [{ sourceId: source.id, revision: source.revision, quote: '恢复草稿', locator: source.locator }], expectedOutcome: '预计保留草稿后用户可继续编辑，实际恢复率尚未测量。' },
    rules: [frozenRule], sourceRefs: [{ id: source.id, revision: source.revision }], expectedOutcome: '预计保留草稿后用户可继续编辑，实际恢复率尚未测量。', recordedAt: createdAt,
  };
  const decisionCase: DecisionCase = {
    ...scope, id: 'snapshot-case', taskId: snapshot.taskId, questionId: 'answered-question', decisionId: snapshot.id, actorId: project.ownerId, choice: 'C', originalWords: ownerSource.content, rationale: '仅适用于本产品', alternatives: ['立即删除', '保留七天'], ruleIds: [currentRule.id], sourceId: ownerSource.id, status: 'active', createdAt,
    decisionSnapshot: snapshot,
    outcomes: [{ id: 'result-one', receiptId: 'receipt-one', recordedAt: createdAt, summary: 'FIRST_RECEIPT_RESULT：首次读回已通过。' }, { id: 'result-two', receiptId: 'receipt-two', recordedAt: new Date(Date.now() - 1_800_000).toISOString(), summary: 'SECOND_RECEIPT_RESULT：补充核验已通过，用户恢复率仍未测量。' }],
    outcome: 'SECOND_RECEIPT_RESULT：补充核验已通过，用户恢复率仍未测量。',
  };
  store.save('rules', currentRule);
  store.save('cases', decisionCase);
  const engine = new Workbench({ store, config, workers: [], writer: { baseline: async () => '', deliver: async () => { throw new Error('This HTTP rendering test never performs remote delivery.'); } }, research: { research: async () => { throw new Error('This HTTP rendering test never researches.'); } } });
  const app = createApp({ store, config, engine });
  const page = async () => {
    const response = await app.request(`/standards?project=${project.id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    return response.text();
  };
  return { app, store, project, source, ownerSource, decisionCase, snapshot, currentRule, page };
}

// These names are visible, labelled sections in the rendered page, not private component hooks.
function regions(html: string, label: string): string[] {
  const pattern = new RegExp(`<section\\b(?=[^>]*aria-label="${label}")[^>]*>([\\s\\S]*?)<\\/section>`, 'g');
  return Array.from(html.matchAll(pattern), match => match[1]!);
}

describe('decision snapshots on the standards HTTP page', () => {
  it('keeps the actual v3 judgment and expectation apart from current v4 rules and appended receipt results in both views', async () => {
    const f = setup();
    const html = await f.page();
    const judgments = regions(html, '当时初判');
    expect(judgments).toHaveLength(2); // Weekly reflection and the expandable decision case.
    for (const judgment of judgments) {
      expect(judgment).toContain('保住用户已完成的编辑');
      expect(judgment).toContain('INITIAL_REASON_ONLY');
      expect(judgment).toContain('当时使用的规则');
      expect(judgment).toContain('草稿恢复规则 · v3');
      expect(judgment).toContain('FROZEN_RULE_VERSION_THREE_ONLY');
      expect(judgment).not.toContain('CURRENT_RULE_VERSION_FOUR_ONLY');
      expect(judgment).not.toContain('草稿恢复规则 · v4');
      expect(judgment).toContain('当时预测');
      expect(judgment).toContain(f.snapshot.expectedOutcome);
      expect(judgment).not.toContain('FIRST_RECEIPT_RESULT');
      expect(judgment).not.toContain('SECOND_RECEIPT_RESULT');
    }
    const currentRules = regions(html, '当前规则');
    expect(currentRules).toHaveLength(2);
    for (const current of currentRules) {
      expect(current).toContain('草稿恢复规则 · v4');
      expect(current).toContain('#rule-recovery-rule');
      expect(current).not.toContain('FROZEN_RULE_VERSION_THREE_ONLY');
    }
    const observed = regions(html, '后来回执结果');
    expect(observed).toHaveLength(2);
    for (const result of observed) {
      expect(result).toContain('FIRST_RECEIPT_RESULT');
      expect(result).toContain('receipt-one');
      expect(result).toContain('SECOND_RECEIPT_RESULT');
      expect(result).toContain('receipt-two');
      expect(result).not.toContain(f.snapshot.expectedOutcome);
    }
  });

  it('escapes owner words, frozen goals, judgments and receipt summaries as text', async () => {
    const f = setup();
    f.store.save('cases', { ...f.decisionCase, outcomes: [{ id: 'unsafe-result', receiptId: 'receipt-safe', recordedAt: now(), summary: '结果 <img src=x onerror="receiptPayload()">' }] });
    const html = await f.page();
    expect(html).toContain('&lt;script id=&quot;snapshot-payload&quot;&gt;');
    expect(html).toContain('&lt;em&gt;不能冒充页面标记&lt;/em&gt;');
    expect(html).toContain('保留草稿 &lt;img');
    expect(html).toContain('结果 &lt;img');
    expect(html).not.toContain('<script id="snapshot-payload">');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<em>不能冒充页面标记</em>');
  });

  it('marks a missing historical snapshot and prediction unknown without borrowing a current rule', async () => {
    const f = setup();
    f.store.save('cases', { ...f.decisionCase, decisionSnapshot: undefined, outcomes: undefined, outcome: undefined });
    const html = await f.page();
    const judgments = regions(html, '当时初判');
    expect(judgments).toHaveLength(2);
    for (const judgment of judgments) {
      expect(judgment).toContain('当时初判未留存');
      expect(judgment).toContain('当时使用的规则版本未知');
      expect(judgment).toContain('当时预测未知');
      expect(judgment).not.toContain('CURRENT_RULE_VERSION_FOUR_ONLY');
      expect(judgment).not.toContain('草稿恢复规则 · v4');
    }
    const observed = regions(html, '后来回执结果');
    expect(observed).toHaveLength(2);
    for (const result of observed) expect(result).toContain('待观察');
    expect(html).toContain('草稿恢复规则 · v4');
  });

  it('does not infer a prediction from an observed result when the snapshot expectation is unknown', async () => {
    const f = setup();
    f.store.save('cases', { ...f.decisionCase, decisionSnapshot: { ...f.snapshot, expectedOutcome: null, decision: { ...f.snapshot.decision, expectedOutcome: undefined } } });
    const judgments = regions(await f.page(), '当时初判');
    expect(judgments).toHaveLength(2);
    for (const judgment of judgments) {
      expect(judgment).toContain('当时预测未知');
      expect(judgment).not.toContain('FIRST_RECEIPT_RESULT');
      expect(judgment).not.toContain('SECOND_RECEIPT_RESULT');
    }
  });

  it('keeps withdrawn cases and withdrawn snapshot evidence out of both historical views even if an old projection retains text', async () => {
    const f = setup();
    f.store.save('cases', { ...f.decisionCase, status: 'withdrawn' });
    let html = await f.page();
    expect(html).not.toContain('snapshot-payload');
    expect(html).not.toContain('FROZEN_RULE_VERSION_THREE_ONLY');
    expect(html).not.toContain('FIRST_RECEIPT_RESULT');
    f.store.save('cases', f.decisionCase);
    f.store.save('sources', { ...f.source, status: 'withdrawn' });
    html = await f.page();
    expect(html).not.toContain('snapshot-payload');
    expect(html).not.toContain('FROZEN_RULE_VERSION_THREE_ONLY');
    expect(html).not.toContain('FIRST_RECEIPT_RESULT');
  });

  it('retracts readable history after an authenticated source-withdrawal request', async () => {
    const f = setup();
    const response = await f.app.request(`/api/sources/${f.source.id}/withdraw`, { method: 'POST', headers: { Accept: 'application/json' } });
    expect(response.status).toBe(200);
    const html = await f.page();
    expect(html).not.toContain('snapshot-payload');
    expect(html).not.toContain('FROZEN_RULE_VERSION_THREE_ONLY');
    expect(html).not.toContain('FIRST_RECEIPT_RESULT');
    expect(html).not.toContain('SECOND_RECEIPT_RESULT');
  });
});
