import { afterEach, describe, expect, it } from 'vitest';
import { digest, DomainError, now, stableId, type AppConfig, type Project, type Question } from '../../src/domain.js';
import { admitOriginalOwnerDecision, caseVersions } from '../../src/cases.js';
import { publicError } from '../../src/readiness.js';
import { FeishuChannel } from '../../src/integrations/feishu.js';
import { publishKnowledge } from '../../src/knowledge.js';
import { Workbench } from '../../src/orchestrator.js';
import { applicableRules } from '../../src/standards.js';
import { Store } from '../../src/store.js';

const stores: Store[] = [];
const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: 'Product', description: '', repository: 'owner/product', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/'], trustedChecks: ['test'], trustedAppIds: [1], ownerId: 'owner', autoMerge: true, budgetUsd: 1, createdAt: now() };
const declaration = '我决定仅本产品保留草稿到下次成功导出';
function setup() {
  const store = new Store(':memory:'); stores.push(store);
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: '/tmp', vaultDir: '/tmp', ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, runnerPolicies: [], scanIntervalMs: 1000, feishu: { appId: 'app', appSecret: 'test', ownerOpenId: 'owner-open', chatId: 'owner-chat' } };
  const engine = new Workbench({ store, config, workers: [], writer: { async baseline() { throw new Error('unused'); }, async deliver() { throw new Error('unused'); } }, research: { async research() { throw new Error('unused'); } } });
  const history: unknown[] = [];
  const channel = new FeishuChannel(store, config, engine, { im: { message: { async list() { return { code: 0, data: { items: history, has_more: false } }; }, async create() { throw new Error('unused'); } } } });
  const receive = (id: string, text: string, extra: Record<string, unknown> = {}) => channel.receive({ sender: { sender_type: 'user', sender_id: { open_id: 'owner-open' } }, message: { message_id: id, chat_id: 'owner-chat', message_type: 'text', create_time: '1000', update_time: '1000', content: JSON.stringify({ text }), ...extra } });
  return { store, config, engine, receive, channel, history };
}
afterEach(() => stores.splice(0).forEach(store => store.close()));

describe('authenticated native originals', () => {
  it('does not reactivate withdrawn evidence when the same message receives a transport update', async () => {
    const f = setup(); await f.receive('withdrawn-1', declaration);
    const source = f.store.list('sources')[0]!;
    expect(caseVersions(f.store, f.config, project)).toHaveLength(1);
    f.engine.withdraw(source.id);
    const tasks = f.store.list('tasks');
    await f.receive('withdrawn-1', declaration, { update_time: '2000' });
    expect(caseVersions(f.store, f.config, project)).toEqual([]);
    expect(f.store.list('sources').filter(s => s.status === 'active')).toEqual([]);
    expect(f.store.list('tasks')).toEqual(tasks);
    expect(applicableRules(f.store, tasks[0]!, f.config).filter(r => r.kind === 'principle')).toEqual([]);
    expect(JSON.stringify(f.store.list('actions'))).not.toContain(declaration);
  });
  it.each(['command', 'reply', 'legacy command'] as const)('keeps an accepted %s answer current when only its timestamp changes', async mode => {
    const f = setup();
    const task = f.engine.ingest({ projectId: 'p', externalId: 'question-source', title: 'Drafts', content: 'Keep drafts.' })!;
    const suggestion = (label: string) => ({ label, description: label, rationale: 'Evidence', tradeoff: 'Cost', evidenceUrls: ['https://example.com'] });
    const q: Question = { id: 'question', projectId: 'p', domain: 'personal', taskId: task.id, taskVersion: 1, version: 1, ownerId: 'owner', title: 'Keep?', context: 'Choose', options: { A: suggestion('Keep'), B: suggestion('Delete') }, research: { queries: [], summary: '', gaps: [] }, status: 'open', createdAt: now() };
    f.store.save('questions', q); f.store.save('tasks', { ...task, stage: 'decide', status: 'awaiting_answer', questionId: q.id });
    f.store.save('outbox', { id: stableId('question-notice', q.id), projectId: 'p', domain: 'personal', channel: 'feishu', recipient: 'owner-open', taskId: task.id, text: 'Keep?', status: 'sent', attempts: 1, createdAt: now(), runAfter: now(), remoteId: 'remote-question' });
    const text = mode === 'reply' ? 'A' : '/answer question 1.1 C Keep until export succeeds';
    const parent = mode === 'reply' ? { parent_id: 'remote-question' } : {};
    await f.receive('answer-1', text, parent);
    const receiptId = stableId('feishu-receive', 'owner-chat', 'answer-1', digest(['1000', text]));
    if (mode === 'legacy command') {
      const receipt = f.store.get('actions', receiptId)!;
      f.store.save('actions', { ...receipt, payload: { messageId: 'answer-1', chatId: 'owner-chat', revision: digest(['1000', text]), sourceIds: receipt.payload.sourceIds } });
    }
    const cases = caseVersions(f.store, f.config, project), question = f.store.get('questions', q.id), sources = f.store.list('sources'), tasks = f.store.list('tasks');
    expect(question?.status).toBe('answered'); expect(cases).toHaveLength(1);
    await f.receive('answer-1', text, { ...parent, update_time: '2000' });
    expect(f.store.get('questions', q.id)).toEqual(question);
    expect(caseVersions(f.store, f.config, project)).toEqual(cases);
    expect(f.store.list('sources')).toEqual(sources); expect(f.store.list('tasks')).toEqual(tasks);
    if (mode === 'legacy command') {
      expect(f.store.get('actions', receiptId)!.payload).toEqual({ messageId: 'answer-1', chatId: 'owner-chat', revision: digest(['1000', text]), sourceIds: [stableId('owner-answer', q.id)] });
      expect(f.store.get('actions', stableId('feishu-receive', 'owner-chat', 'answer-1', digest(['2000', text])))).toBeUndefined();
      await f.receive('answer-1', '/answer question 1.1 B Delete drafts', { update_time: '3000' });
      expect(f.store.get('questions', q.id)?.status).toBe('stale');
      expect(f.store.get('sources', stableId('owner-answer', q.id))?.status).toBe('withdrawn');
      expect(caseVersions(f.store, f.config, project)).toEqual([]);
    }
  });
  it('admits a clear owner declaration in its bound product once and uses it without manufacturing a question', async () => {
    const f = setup();
    await f.receive('native-1', declaration); await f.receive('native-1', declaration);
    f.history.push({ message_id: 'native-1', chat_id: 'owner-chat', msg_type: 'text', create_time: '1000', update_time: '1000', sender: { id: 'owner-open', id_type: 'open_id', sender_type: 'user' }, body: { content: JSON.stringify({ text: declaration }) } });
    await f.channel.catchup();
    expect(f.store.list('questions')).toEqual([]);
    expect(caseVersions(f.store, f.config, project)).toMatchObject([{ identity: 'host-bound', authority: 'owner-explicit', choiceText: declaration, original: { kind: 'authenticated-message' }, frozenJudgment: null, expectedOutcome: null }]);
    const task = f.engine.ingest({ projectId: 'p', externalId: 'another-task', title: 'Export', content: 'Improve exporting.' })!;
    expect(applicableRules(f.store, task, f.config)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'principle', statement: declaration })]));
    expect(f.store.list('actions').filter(a => a.kind === 'decision.owner-origin')).toHaveLength(1);
    f.config.feishu!.ownerOpenId = 'different-owner';
    expect(caseVersions(f.store, f.config, project)).toEqual([]);
    expect(applicableRules(f.store, task, f.config).filter(r => r.kind === 'principle')).toEqual([]);
  });
  it('does not elevate quoted native text or ordinary source metadata', async () => {
    const f = setup();
    await f.receive('quoted-1', `“${declaration}”`);
    await f.receive('reply-1', declaration, { parent_id: 'someone-else' });
    const otherDecision = 'Exports should show a recovery notice.';
    const task = f.engine.ingest({ projectId: 'p', kind: 'file', externalId: 'a-file', title: 'Reported words', content: `${declaration}\n${otherDecision}`, authorId: 'owner' })!;
    const source = f.store.get('sources', task.sourceId)!;
    const extraction = { cards: [], caseMentions: [{ quote: declaration, locator: source.locator, title: 'Reported decision', choiceText: declaration, rationale: null, alternatives: [], originalDecisionLocator: 'unproved-native-id' }, { quote: otherDecision, locator: source.locator, title: 'Another decision', choiceText: otherDecision, rationale: null, alternatives: [] }] };
    publishKnowledge(f.store, source, extraction, f.config); publishKnowledge(f.store, source, extraction, f.config);
    expect(caseVersions(f.store, f.config, project).filter(c => c.authority === 'owner-explicit')).toEqual([]);
    const cases = caseVersions(f.store, f.config, project);
    expect(cases).toMatchObject([{ authority: 'source-report', identity: 'unresolved', choiceText: declaration }, { authority: 'source-report', identity: 'unresolved', choiceText: otherDecision }]);
    expect(new Set(cases.map(c => c.id)).size).toBe(2);
    expect(f.store.list('rules').filter(r => r.kind === 'principle')).toEqual([]);
  });
  it('keeps a native request for confirmation from becoming an owner principle', async () => {
    const f = setup(); await f.receive('question-1', '我决定仅本产品保留草稿，可以吗');
    expect(caseVersions(f.store, f.config, project).filter(c => c.authority === 'owner-explicit')).toEqual([]);
    expect(f.store.list('rules').filter(r => r.kind === 'principle')).toEqual([]);
  });
  it('versions a native edit, revokes withdrawn text, and stops using an origin whose private row is lost', async () => {
    const f = setup(); await f.receive('edit-1', declaration);
    const first = caseVersions(f.store, f.config, project)[0]!;
    const initialRule = f.store.list('rules').find(rule => rule.kind === 'principle')!;
    const initialHistory = f.store.list('actions').find(action => action.kind === 'decision.rule-version')!.payload.history;
    expect(initialHistory).toMatchObject({ relation: 'initial', version: 1, confirmation: { id: first.id, version: 1 } });
    const firstTasks = f.store.list('tasks'), firstSources = f.store.list('sources');
    await f.receive('edit-1', declaration, { update_time: '2000' });
    expect(caseVersions(f.store, f.config, project)).toEqual([first]);
    expect(f.store.list('tasks')).toEqual(firstTasks); expect(f.store.list('sources')).toEqual(firstSources);
    expect(f.store.list('actions').filter(action => action.kind === 'decision.rule-version')).toHaveLength(1);
    expect(f.store.list('actions').filter(action => action.kind === 'feishu_receive').map(action => action.payload.nativeTime)).toContain(2000);
    expect(applicableRules(f.store, firstTasks[0]!, f.config).filter(r => r.kind === 'principle')).toMatchObject([{ id: initialRule.id, version: 1 }]);
    const revised = '我决定仅本产品保留草稿直到导出成功';
    await f.receive('edit-1', revised, { update_time: '1500' });
    expect(caseVersions(f.store, f.config, project)).toEqual([first]);
    await f.receive('edit-1', revised, { update_time: '3000' });
    const current = caseVersions(f.store, f.config, project);
    expect(current).toMatchObject([{ id: first.id, version: 2, choiceText: revised }]);
    expect(JSON.stringify(f.store.list('actions'))).not.toContain(declaration);
    expect(f.store.list('actions').filter(a => a.kind === 'decision.case-version').map(a => a.payload)).toEqual(expect.arrayContaining([expect.objectContaining({ retracted: true, hash: first.hash })]));
    expect(f.store.list('actions').filter(a => a.kind === 'decision.rule-version').map(a => a.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ retracted: true, ruleId: initialRule.id, version: 1, hash: digest(initialRule) }),
      expect.objectContaining({ history: expect.objectContaining({ relation: 'revision', version: 2, previous: { id: initialRule.id, version: 1, hash: digest(initialRule) }, confirmation: { id: first.id, version: 2, hash: current[0]!.hash } }) }),
    ]));
    const task = f.engine.ingest({ projectId: 'p', externalId: 'later', title: 'Later', content: 'Later work.' })!;
    expect(applicableRules(f.store, task, f.config).filter(r => r.kind === 'principle')).toMatchObject([{ id: initialRule.id, version: 2, statement: revised }]);
    const secondRule = f.store.list('rules').find(rule => rule.id === initialRule.id)!;
    await f.receive('edit-1', declaration, { update_time: '4000' });
    expect(caseVersions(f.store, f.config, project)).toMatchObject([{ id: first.id, version: 3, choiceText: declaration }]);
    expect(f.store.list('actions').filter(a => a.kind === 'decision.rule-version').map(a => a.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ history: expect.objectContaining({ relation: 'revision', version: 3, previous: { id: initialRule.id, version: 2, hash: digest(secondRule) } }) }),
    ]));
    expect(applicableRules(f.store, task, f.config).filter(r => r.kind === 'principle')).toMatchObject([{ id: initialRule.id, version: 3, statement: declaration }]);
    const origin = f.store.list('actions').find(a => a.kind === 'decision.owner-origin' && a.payload.hash)!;
    f.store.delete('actions', origin.id);
    expect(caseVersions(f.store, f.config, project)).toEqual([]);
    expect(applicableRules(f.store, task, f.config).filter(r => r.kind === 'principle')).toEqual([]);
  });

  function park(f: ReturnType<typeof setup>, kind: 'open' | 'delivered') {
    const task = f.engine.ingest({ projectId: 'p', externalId: `${kind}-${digest(String(Math.random()))}`, title: 'Open work', content: 'Still working on the export.' })!;
    const suggestion = (label: string) => ({ label, description: label, rationale: 'Evidence', tradeoff: 'Cost', evidenceUrls: ['https://example.com'] });
    const question: Question = { id: `q-${task.id}`, projectId: 'p', domain: 'personal', taskId: task.id, taskVersion: task.version, version: 1, ownerId: 'owner', title: 'Keep?', context: 'Choose', options: { A: suggestion('Keep'), B: suggestion('Delete') }, research: { queries: [], summary: '', gaps: [] }, status: 'open', createdAt: now() };
    f.store.save('questions', question);
    const saved = f.store.get('tasks', task.id)!;
    f.store.save('tasks', { ...saved, stage: kind === 'delivered' ? 'feedback' : 'plan', status: kind === 'delivered' ? 'delivered' : 'planning', questionId: question.id, ...(kind === 'delivered' ? { receiptId: `receipt-${task.id}` } : {}) });
    return { taskId: task.id, questionId: question.id, version: saved.version };
  }

  it('replaces the previous explicit decision when the owner clearly changes their mind', async () => {
    const f = setup();
    await f.receive('base-1', declaration);
    const open = park(f, 'open'), done = park(f, 'delivered');
    const changed = '我决定仅本产品改主意，不再保留失败导出的草稿';
    await f.receive('change-1', changed);
    const later = f.engine.ingest({ projectId: 'p', externalId: 'after-change', title: 'After', content: 'Judge this next.' })!;
    const principles = applicableRules(f.store, later, f.config).filter(rule => rule.kind === 'principle');
    expect(principles).toMatchObject([{ statement: changed, status: 'active' }]);
    expect(f.store.list('rules').filter(rule => rule.kind === 'principle' && rule.status === 'superseded')).toMatchObject([{ statement: declaration }]);
    expect(f.store.list('actions').filter(action => action.kind === 'decision.rule-version').map(action => action.payload.history)).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'owner-change', previous: expect.objectContaining({ id: f.store.list('rules').find(rule => rule.statement === declaration)!.id }) }),
    ]));
    expect(f.store.get('tasks', open.taskId)).toMatchObject({ version: open.version + 1, status: 'deciding', stage: 'decide', error: 'owner_changed' });
    expect(f.store.get('questions', open.questionId)?.status).toBe('stale');
    expect(publicError('owner_changed')).toContain('不再自动引用');
    expect(f.store.get('tasks', done.taskId)).toMatchObject({ version: done.version, status: 'delivered' });
    const again = '我决定仅本产品改主意，导出失败就删除草稿';
    await f.receive('change-2', again);
    expect(applicableRules(f.store, later, f.config).filter(rule => rule.kind === 'principle')).toMatchObject([{ statement: again }]);
    expect(f.store.get('tasks', open.taskId)?.version).toBe(open.version + 2);
    const origin = f.store.list('actions').find(action => action.kind === 'decision.owner-origin' && (action.payload.binding as { messageId?: string }).messageId === 'change-2')!;
    const source = f.store.list('sources').find(item => item.content === again)!;
    admitOriginalOwnerDecision(f.store, f.config, { id: origin.id, hash: origin.payload.hash as string }, { source: { id: source.id, revision: source.revision }, quote: again, scopeQuote: '仅本产品', declaredScope: { projectId: 'p', domain: 'personal' } });
    expect(f.store.get('tasks', open.taskId)?.version).toBe(open.version + 2);
  });

  it('keeps the baseline when the owner states a bounded exception', async () => {
    const f = setup();
    await f.receive('base-2', declaration);
    const open = park(f, 'open');
    const exception = '我决定仅本产品例外，这次导出可以删掉草稿';
    await f.receive('except-1', exception);
    const later = f.engine.ingest({ projectId: 'p', externalId: 'after-exception', title: 'After', content: 'Judge this next.' })!;
    expect(applicableRules(f.store, later, f.config).filter(rule => rule.kind === 'principle').map(rule => rule.statement).sort()).toEqual([declaration, exception].sort());
    const history = f.store.list('actions').find(action => (action.payload.history as { relation?: string } | undefined)?.relation === 'bounded-exception')!.payload.history as { application: { exceptionOf?: string }; previous?: { id: string } };
    const baseline = f.store.list('rules').find(rule => rule.statement === declaration)!;
    expect(history.application.exceptionOf).toBe(baseline.id);
    expect(history.previous?.id).toBe(baseline.id);
    expect(baseline.status).toBe('active');
    expect(f.store.get('tasks', open.taskId)).toMatchObject({ version: open.version, status: 'planning' });
  });

  it('keeps both sides and stops citing them when the owner records a conflict', async () => {
    const f = setup();
    await f.receive('base-3', declaration);
    const open = park(f, 'open');
    const conflict = '我决定仅本产品记下冲突，不能同时自动保留和删除草稿';
    await f.receive('conflict-1', conflict);
    const later = f.engine.ingest({ projectId: 'p', externalId: 'after-conflict', title: 'After', content: 'Judge this next.' })!;
    expect(applicableRules(f.store, later, f.config).filter(rule => rule.kind === 'principle')).toEqual([]);
    expect(f.store.list('rules').filter(rule => rule.kind === 'principle').map(rule => ({ statement: rule.statement, status: rule.status })).sort((a, b) => a.statement.localeCompare(b.statement))).toEqual([
      { statement: conflict, status: 'suspended' },
      { statement: declaration, status: 'suspended' },
    ].sort((a, b) => a.statement.localeCompare(b.statement)));
    expect(f.store.get('tasks', open.taskId)).toMatchObject({ version: open.version + 1, status: 'deciding', error: 'rules_conflict' });
    expect(publicError('rules_conflict')).toContain('暂停自动引用');
    await f.receive('conflict-1', conflict);
    expect(f.store.get('tasks', open.taskId)?.version).toBe(open.version + 1);
  });

  it('does not invent a revision when the baseline is ambiguous or the sentence is not explicit', async () => {
    const f = setup();
    await f.receive('base-4', declaration);
    await f.receive('base-5', '我决定仅本产品另外保留导出记录');
    await f.receive('change-ambiguous', '我决定仅本产品改主意，不再保留失败导出的草稿');
    await f.receive('change-ascii', '我决定仅本产品改主意,不再保留失败导出的草稿');
    await f.receive('change-question', '我决定仅本产品改主意，可以吗');
    expect(f.store.list('rules').filter(rule => rule.kind === 'principle' && rule.status === 'active').map(rule => rule.statement).sort()).toEqual([declaration, '我决定仅本产品另外保留导出记录'].sort());
    const origin = f.store.list('actions').find(action => action.kind === 'decision.owner-origin' && (action.payload.binding as { messageId?: string }).messageId === 'base-4')!;
    const source = f.store.list('sources').find(item => item.content === declaration)!;
    expect(() => admitOriginalOwnerDecision(f.store, f.config, { id: origin.id, hash: origin.payload.hash as string }, { source: { id: source.id, revision: source.revision }, quote: declaration, scopeQuote: '仅本产品', declaredScope: { projectId: 'p', domain: 'personal' }, relation: 'owner-change' })).toThrow(DomainError);
  });
});
