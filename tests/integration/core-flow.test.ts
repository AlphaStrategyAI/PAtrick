import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/store.js';
import { Workbench } from '../../src/orchestrator.js';
import { digest, DomainError, WorkerUnavailable, type AppConfig, type DeliveryReceipt, type Project, type Role, type Runner, type WorkerAdapter, type WorkerInput, type ResearchRecord, type OutboxMessage } from '../../src/domain.js';

const roots: string[] = []; const stores: Store[] = [];
const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: 'Product', description: 'Test', repository: 'owner/product', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/'], trustedChecks: ['test'], trustedAppIds: [123], ownerId: 'owner', autoMerge: true, budgetUsd: 10, createdAt: new Date().toISOString() };
const research: ResearchRecord = { queries: (['zh', 'en'] as const).map(language => ({ language, query: language === 'zh' ? '草稿 恢复' : 'draft recovery', searchedAt: new Date().toISOString(), sources: [{ language, url: `https://${language}.example.com/original`, canonicalUrl: `https://${language}.example.com/original`, title: 'Source', publishedAt: '2026-01-01', accessedAt: new Date().toISOString(), excerpt: 'Evidence for both alternatives', primary: true, conditions: 'Draft export' }] })), summary: 'A and B both viable', gaps: [] };
const suggestion = (label: string) => ({ label, description: `Choose ${label}`, rationale: 'Evidence', tradeoff: 'A cost', evidenceUrls: research.queries.flatMap(q => q.sources.map(s => s.url)) });
interface Options { ask?: boolean; noReceipt?: boolean; badReview?: boolean; repair?: number; workerUnavailable?: Partial<Record<Runner, Role[]>>; budget?: number; notifierOffline?: boolean; research?: ResearchRecord; mutateOutput?: (input: WorkerInput, output: unknown) => unknown; beforeRun?: (input: WorkerInput) => Promise<void>; canRun?: (project: Project) => boolean }
function setup(options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'patrick-core-flow-')); roots.push(root);
  const store = new Store(join(root, 'db.sqlite'), join(root, 'vault')); stores.push(store);
  const p = { ...project, budgetUsd: options.budget ?? 10 }; store.save('projects', p);
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: root, vaultDir: join(root, 'vault'), ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [p], scanIntervalMs: 1000, workers: {}, runnerPolicies: (['grok', 'dsh', 'codex'] as const).map(runner => ({ runner, roles: ['knowledge_extract', 'case_extract', 'decide', 'plan', 'execute', 'check', 'feedback'], domains: ['personal'], provider: `${runner}-provider`, model: `${runner}-model`, admitted: true, costPerRunUsd: .01, independentReview: false })) };
  const calls: { runner: Runner; role: Role; input: WorkerInput }[] = []; const notifications: OutboxMessage[] = []; let checks = 0; let deliveries = 0;
  const workers: WorkerAdapter[] = (['grok', 'dsh', 'codex'] as const).map(name => ({ name, async run(input) {
    calls.push({ runner: name, role: input.role, input: structuredClone(input) });
    if (options.beforeRun) await options.beforeRun(input);
    if (options.workerUnavailable?.[name]?.includes(input.role)) throw new WorkerUnavailable(`${name} offline`);
    let output: unknown;
    if (input.role === 'knowledge_extract') output = { cards: [{ title: '草稿恢复', body: '保留草稿以供恢复', quote: '保留草稿', aliases: ['恢复'], verification: 'reported', kind: 'fact' }] };
    if (input.role === 'case_extract') output = { observations: [{ title: 'Candidate', statement: '保留草稿', quote: '保留草稿', conditions: 'This source', exceptions: 'unknown' }] };
    if (input.role === 'decide') output = { action: options.ask && !input.answer ? 'ask' : 'proceed', summary: 'Update PRD', rationale: 'Evidence supports update', citations: [{ sourceId: input.source.id, revision: input.source.revision, quote: '保留草稿', locator: input.source.locator }], ruleIds: [], ...(options.ask && !input.answer ? { question: { title: 'Retain drafts?', context: 'Two viable approaches', A: suggestion('Retain'), B: suggestion('Delete') } } : {}) };
    if (input.role === 'plan') output = { taskVersion: input.task.version, sourceRevision: input.task.sourceRevision, baselineSha: 'baseline', summary: 'Update PRD', paths: ['docs/PRD.md'], steps: ['Update'], tests: ['test'], stopConditions: ['Source changes'] };
    if (input.role === 'execute') output = { taskVersion: input.task.version, planHash: digest(input.plan!), baselineSha: input.plan!.baselineSha, files: [{ path: 'docs/PRD.md', content: '# PRD\nKeep drafts.' }], tests: [{ command: 'test', passed: true, output: '1 passed' }], summary: 'Updated' };
    if (input.role === 'check') { checks++; output = { taskVersion: input.task.version, planHash: digest(input.plan!), artifactHash: digest(input.artifact!), verdict: options.badReview || checks <= (options.repair ?? 0) ? 'repair' : 'pass', summary: 'Independent checks', issues: [], tests: [{ command: 'test', passed: !(options.badReview || checks <= (options.repair ?? 0)), output: options.badReview ? 'failed' : '1 passed' }] }; }
    if (input.role === 'feedback') output = { summary: 'Merged and verified', observations: ['Successful delivery'] };
    return { output: options.mutateOutput?.(input, output) ?? output, costUsd: .01, model: `${name}-model`, provider: `${name}-provider` };
  } }));
  const writer = { async baseline() { return 'baseline'; }, async deliver(task: WorkerInput['task']) { deliveries++; if (options.noReceipt) throw new Error('remote offline'); return { id: `receipt-${task.id}`, projectId: task.projectId, domain: task.domain, taskId: task.id, repository: p.repository, path: p.prdPath, pullRequestUrl: 'https://github.com/owner/product/pull/1', pullRequestNumber: 1, headSha: 'head', mergeSha: 'merged', contentHash: digest(task.artifact!.files.find(f => f.path === p.prdPath)!.content), verifiedAt: new Date().toISOString(), checks: [{ name: 'test', conclusion: 'success', headSha: 'head', appId: 123, url: 'https://github.com/owner/product/actions/1' }] } satisfies DeliveryReceipt; } };
  const notifier = { async send(message: OutboxMessage) { if (options.notifierOffline) throw new Error('notifier offline'); notifications.push(message); return { remoteId: `remote-${message.id}` }; } };
  const create = () => new Workbench({ store, config, workers, writer, research: { async research() { return options.research ?? research; } }, notifier, canRun: options.canRun });
  const engine = create();
  const ingest = () => engine.ingest({ projectId: 'p', externalId: 'idea', kind: 'manual', title: 'Draft handling', content: '导出失败后保留草稿，以供恢复。', authorId: 'owner' })!;
  return { store, config, engine, calls, notifications, ingest, create, options, deliveryCount: () => deliveries };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function workerStarted(calls: unknown[]) {
  for (let turn = 0; turn < 32 && calls.length === 0; turn++) await Promise.resolve();
  expect(calls).toHaveLength(1);
}

describe('single worker durable business flow', () => {
  it('runs all seven roles without a question and delivers only after receipt and feedback', async () => {
    const f = setup(); const task = f.ingest(); await f.engine.runUntilIdle();
    expect(f.store.get('tasks', task.id)?.status).toBe('delivered');
    expect(f.calls.map(c => c.role)).toEqual(['knowledge_extract', 'case_extract', 'decide', 'plan', 'execute', 'check', 'feedback']);
    expect(f.calls.find(c => c.role === 'decide')?.runner).toBe('grok');
    expect(f.calls.find(c => c.role === 'plan')?.runner).toBe('codex');
    expect(f.calls.find(c => c.role === 'check')?.runner).toBe('codex');
    expect(f.store.list('questions')).toEqual([]);
    expect(f.store.list('rules').every(r => r.kind === 'observation')).toBe(true);
    expect(f.ingest()?.id).toBe(task.id); expect(f.store.list('tasks')).toHaveLength(1);
  });

  it.each(['A', 'B', 'C'] as const)('accepts an owner %s answer once and resumes the same task with frozen scope', async choice => {
    const f = setup({ ask: true }); const task = f.ingest(); await f.engine.runUntilIdle();
    const question = f.store.list('questions')[0]!;
    expect(Object.keys(question.options)).toEqual(['A', 'B']);
    expect(new Set(question.research.queries.map(q => q.language))).toEqual(new Set(['zh', 'en']));
    const answer = { questionId: question.id, taskVersion: question.taskVersion, questionVersion: question.version, actorId: 'owner', choice, text: choice === 'C' ? '只保留到下次导出成功' : undefined, eventId: 'answer-1' };
    expect(() => f.engine.answer({ ...answer, actorId: 'intruder' })).toThrow();
    const resumed = f.engine.answer(answer); expect(f.engine.answer({ ...answer, eventId: 'same-via-backfill' }).id).toBe(resumed.id);
    expect(f.store.list('cases')).toHaveLength(1); expect(f.store.list('rules').filter(r => r.kind === 'principle')).toHaveLength(1);
    const rule = f.store.list('rules').find(r => r.kind === 'principle')!; expect(rule.projectId).toBe('p'); expect(rule.domain).toBe('personal'); expect(rule.conditions).toContain(question.id);
    await f.engine.runUntilIdle(); expect(f.store.get('tasks', task.id)?.status).toBe('delivered');
    expect(f.deliveryCount()).toBe(1); expect(f.calls.filter(c => c.role === 'plan')).toHaveLength(1);
  });

  it('invalidates obsolete answers, cards, rules and actions on source replacement or withdrawal', async () => {
    const f = setup({ ask: true }); const old = f.ingest(); await f.engine.runUntilIdle(); const question = f.store.list('questions')[0]!;
    f.engine.ingest({ projectId: 'p', externalId: 'idea', kind: 'manual', title: 'Edited', content: '新的资料仍须保留草稿。', authorId: 'owner' });
    expect(() => f.engine.answer({ questionId: question.id, taskVersion: question.taskVersion, questionVersion: question.version, actorId: 'owner', choice: 'A', eventId: 'late' })).toThrow();
    expect(f.store.get('tasks', old.id)?.status).toBe('cancelled'); expect(f.store.get('questions', question.id)?.status).toBe('stale');
    expect(f.store.list('rules').every(r => r.status !== 'active')).toBe(true);
    f.engine.withdraw(f.store.list('sources').find(s => s.status === 'active')!.id); f.store.rebuildIndex();
    expect(f.store.searchCards('草稿', project)).toEqual([]);
  });

  it('commits a fallback notice with the new attempt and retries it after an offline restart', async () => {
    const f = setup({ workerUnavailable: { grok: ['knowledge_extract'] }, notifierOffline: true }); const task = f.ingest();
    await f.engine.tick();
    const notice = f.store.list('outbox').find(m => m.text.includes('grok') && m.text.includes('dsh'))!;
    expect(notice.status).toBe('pending'); expect(notice.attempts).toBe(1);
    expect(f.store.list('attempts').map(a => a.status)).toEqual(['unavailable', 'succeeded']);
    f.options.notifierOffline = false;
    f.store.save('outbox', { ...notice, runAfter: new Date(0).toISOString() });
    await f.create().runUntilIdle();
    expect(f.store.get('tasks', task.id)?.status).toBe('delivered'); expect(f.notifications.filter(m => m.id === notice.id)).toHaveLength(1);
    expect(f.store.list('cards')).toHaveLength(1);
  });

  it('blocks without a question when all runners are unavailable or the budget is exhausted', async () => {
    const f = setup({ workerUnavailable: { grok: ['knowledge_extract'], dsh: ['knowledge_extract'], codex: ['knowledge_extract'] } }); const task = f.ingest(); await f.engine.runUntilIdle();
    const blocked = f.store.get('tasks', task.id)!; expect(blocked.status).toBe('blocked'); expect(Date.parse(blocked.runAfter)).toBeGreaterThan(Date.now()); expect(f.store.list('questions')).toEqual([]);
    const budget = setup({ budget: .001 }); const tiny = budget.ingest(); await budget.engine.runUntilIdle();
    expect(budget.store.get('tasks', tiny.id)?.status).toBe('blocked'); expect(budget.calls).toEqual([]);
  });

  it('bounds repairs at two and never treats business test failure as runner unavailability', async () => {
    const f = setup({ badReview: true }); const task = f.ingest(); await f.engine.runUntilIdle();
    expect(f.store.get('tasks', task.id)?.status).toBe('blocked'); expect(f.store.get('tasks', task.id)?.repairCount).toBe(2);
    expect(f.calls.filter(c => c.role === 'execute')).toHaveLength(3); expect(f.store.list('attempts').some(a => a.status === 'unavailable')).toBe(false); expect(f.deliveryCount()).toBe(0);
  });

  it('rejects check results bound to a different artifact and never fabricates delivery', async () => {
    const f = setup({ mutateOutput: (input, output) => input.role === 'check' ? { ...(output as object), artifactHash: 'wrong' } : output }); const task = f.ingest(); await f.engine.runUntilIdle();
    expect(f.store.get('tasks', task.id)?.status).toBe('blocked'); expect(f.deliveryCount()).toBe(0);
    const offline = setup({ noReceipt: true }); const t = offline.ingest(); await offline.engine.runUntilIdle();
    expect(offline.store.get('tasks', t.id)?.status).not.toBe('delivered'); expect(offline.store.list('receipts')).toEqual([]);
  });

  it('requires both actual language searches before opening a question', async () => {
    const f = setup({ ask: true, research: { ...research, queries: research.queries.filter(q => q.language === 'en') } }); const task = f.ingest(); await f.engine.runUntilIdle();
    expect(f.store.get('tasks', task.id)?.status).toBe('blocked'); expect(f.store.list('questions')).toEqual([]);
  });

  it('keeps every temporary derivative in memory and retains only execution metadata after restart', async () => {
    const secret = 'EPHEMERAL_DERIVATIVE_SECRET';
    const f = setup({ mutateOutput: (input, output) => {
      if (input.role === 'knowledge_extract') return { cards: [{ title: secret, body: secret, quote: '保留草稿', aliases: [secret], verification: 'reported', kind: 'fact' }] };
      if (input.role === 'case_extract') return { observations: [{ title: secret, statement: secret, quote: '保留草稿', conditions: secret, exceptions: secret }] };
      return { ...(output as object), summary: secret };
    } });
    const task = f.engine.ingest({ projectId: 'p', externalId: 'temporary', title: secret, content: `${secret} 保留草稿`, retention: 'ephemeral' })!;
    await f.engine.runUntilIdle(); expect(f.store.get('tasks', task.id)?.status).toBe('delivered');
    f.store.close();
    const reopened = new Store(join(f.config.dataDir, 'db.sqlite'), f.config.vaultDir); stores.push(reopened);
    expect(readFileSync(join(f.config.dataDir, 'db.sqlite')).includes(Buffer.from(secret))).toBe(false);
    expect(reopened.get('tasks', task.id)?.plan).toBeUndefined(); expect(reopened.get('tasks', task.id)?.artifact).toBeUndefined();
    expect(reopened.get('sources', task.sourceId)?.content).toBe(''); expect(reopened.list('cards')).toEqual([]);
  });

  it('withdraws a verified owner answer before any dependent work can use it again', async () => {
    const f = setup({ ask: true }); const task = f.ingest(); await f.engine.runUntilIdle(); const q = f.store.list('questions')[0]!;
    f.engine.answer({ questionId: q.id, taskVersion: q.taskVersion, questionVersion: q.version, actorId: 'owner', choice: 'C', text: '保留到导出成功', eventId: 'once' });
    const answerSource = f.store.list('sources').find(s => s.externalId === `answer:${q.id}`)!;
    f.engine.withdraw(answerSource.id);
    expect(f.store.get('questions', q.id)?.status).toBe('stale');
    expect(f.store.get('tasks', task.id)?.questionId).toBeUndefined();
    expect(f.store.list('rules').filter(r => r.kind === 'principle').every(r => r.status === 'suspended')).toBe(true);
  });

  it('re-ingests an expired temporary revision into the same task and reconstructs its stages', async () => {
    const f = setup(); const task = f.engine.ingest({ projectId: 'p', externalId: 'temporary-restart', title: 'Temporary', content: '仍要保留草稿', retention: 'ephemeral' })!;
    for (let i = 0; i < 4; i++) await f.engine.tick();
    expect(f.store.get('tasks', task.id)?.stage).toBe('execute');
    f.store.close();
    const reopened = new Store(join(f.config.dataDir, 'db.sqlite'), f.config.vaultDir); stores.push(reopened);
    const engine = new Workbench({ store: reopened, config: f.config, workers: [], writer: { async baseline() { return 'baseline'; }, async deliver() { throw new Error('unused'); } }, research: { async research() { return research; } } });
    const resumed = engine.ingest({ projectId: 'p', externalId: 'temporary-restart', title: 'Temporary', content: '仍要保留草稿', retention: 'ephemeral' })!;
    expect(resumed.id).toBe(task.id); expect(resumed.stage).toBe('knowledge_extract'); expect(resumed.version).toBe(2); expect(reopened.list('tasks')).toHaveLength(1);
  });

  it('drains a held worker and refuses new task stages after shutdown starts', async () => {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const f = setup({ beforeRun: async input => { if (input.role === 'knowledge_extract') await held; } }); f.ingest();
    const running = f.engine.tick(); await workerStarted(f.calls);
    let closed = false; const closing = f.engine.shutdown().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    await f.engine.tick(); expect(f.store.list('attempts')).toHaveLength(1);
    release(); await running; await closing; expect(closed).toBe(true);
    await f.engine.tick(); await f.engine.runUntilIdle(); expect(f.calls).toHaveLength(1); expect(f.store.list('attempts')).toHaveLength(1);
  });

  it('holds tasks while their project network route is not admitted and resumes after recovery', async () => {
    let available = false; const f = setup({ canRun: () => available }); const task = f.ingest();
    await f.engine.runUntilIdle(); expect(f.calls).toEqual([]); expect(f.store.get('tasks', task.id)?.status).toBe('queued');
    available = true; await f.engine.runUntilIdle(); expect(f.store.get('tasks', task.id)?.status).toBe('delivered');
  });

  it('removes retracted originals and derived text from every durable entity and Vault file, including delivered history', async () => {
    const secret = 'RETRACT_EVERY_DERIVATIVE_SENTINEL';
    const f = setup({ mutateOutput: (input, output) => {
      if (input.role === 'knowledge_extract') return { cards: [{ title: secret, body: secret, quote: '保留草稿', aliases: [secret], verification: 'reported', kind: 'fact' }] };
      if (input.role === 'case_extract') return { observations: [{ title: secret, statement: secret, quote: '保留草稿', conditions: secret, exceptions: secret }] };
      return { ...(output as object), summary: secret };
    } });
    const task = f.engine.ingest({ projectId: 'p', externalId: 'retraction', title: secret, content: `${secret} 保留草稿` })!;
    await f.engine.runUntilIdle(); expect(f.store.get('tasks', task.id)?.status).toBe('delivered');
    f.engine.withdraw(task.sourceId); f.store.close();
    const reopened = new Store(join(f.config.dataDir, 'db.sqlite'), f.config.vaultDir); stores.push(reopened);
    const serialized = ['sources', 'tasks', 'cards', 'rules', 'cases', 'questions', 'events', 'attempts', 'outbox', 'actions', 'cursors'].map(table => JSON.stringify(reopened.list(table as any))).join('\n');
    expect(serialized).not.toContain(secret); expect(reopened.get('tasks', task.id)?.status).toBe('delivered'); expect(reopened.list('receipts')).toHaveLength(1);
    const markdown = readdirSync(f.config.vaultDir, { recursive: true }).map(String).filter(path => path.endsWith('.md')).map(path => readFileSync(join(f.config.vaultDir, path), 'utf8')).join('\n');
    expect(markdown).not.toContain(secret); expect(reopened.searchCards('草稿', project)).toEqual([]);
  });

  it('blocks unsupported proceed decisions before planning or publishing', async () => {
    const f = setup({ mutateOutput: (input, output) => input.role === 'decide' ? { ...(output as object), citations: [] } : output }); const task = f.ingest();
    await f.engine.runUntilIdle(); expect(f.store.get('tasks', task.id)?.status).toBe('blocked');
    expect(f.calls.filter(call => call.role === 'plan')).toHaveLength(0); expect(f.deliveryCount()).toBe(0);
  });

  it('reserves budget for malformed paid runs so retries cannot obtain unbounded free attempts', async () => {
    const f = setup({ budget: .025, beforeRun: async () => { throw new DomainError('Paid runtime returned malformed JSON.', 'worker_output'); } }); const task = f.ingest();
    for (let i = 0; i < 5; i++) { await f.engine.runUntilIdle(); if (i < 4) f.engine.retry(task.id); }
    expect(f.calls).toHaveLength(2); expect(f.store.get('tasks', task.id)?.spentUsd).toBeCloseTo(.02);
    expect(f.store.list('attempts').every(attempt => attempt.costUsd === .01)).toBe(true);
  });

  it('reserves unavailable candidate costs before admitting a fallback and fails closed on zero estimates', async () => {
    const f = setup({ budget: .025, workerUnavailable: { grok: ['knowledge_extract'], dsh: ['knowledge_extract'], codex: ['knowledge_extract'] } }); const task = f.ingest(); await f.engine.runUntilIdle();
    expect(f.calls).toHaveLength(2); expect(f.store.get('tasks', task.id)?.spentUsd).toBeCloseTo(.02);
    const zero = setup(); zero.config.runnerPolicies.forEach(policy => { policy.costPerRunUsd = 0; }); const tiny = zero.ingest(); await zero.engine.tick();
    expect(zero.calls).toHaveLength(0); expect(zero.store.get('tasks', tiny.id)?.status).toBe('blocked');
  });

  it('retains a paid attempt reservation when source withdrawal rejects a late result', async () => {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const f = setup({ beforeRun: async () => held }); const task = f.ingest(); const running = f.engine.tick(); await workerStarted(f.calls);
    f.engine.withdraw(task.sourceId); release(); await running;
    expect(f.store.get('tasks', task.id)?.status).toBe('cancelled'); expect(f.store.get('tasks', task.id)?.spentUsd).toBeCloseTo(.01);
    expect(f.store.list('attempts')[0]?.costUsd).toBe(.01); expect(f.store.list('attempts')[0]?.status).toBe('stale'); expect(f.store.list('cards')).toHaveLength(0);
  });
});
