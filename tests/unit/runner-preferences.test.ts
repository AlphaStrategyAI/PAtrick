import { afterEach, describe, expect, it } from 'vitest';
import { projectSchema } from '../../src/config.js';
import { digest, roles, WorkerUnavailable, type AppConfig, type Project, type Role, type Runner, type RunnerPolicy, type SourceRevision, type Task, type WorkerAdapter, type WorkerInput } from '../../src/domain.js';
import { Scheduler } from '../../src/scheduler.js';
import { Store } from '../../src/store.js';

const stores: Store[] = [];
const createdAt = '2026-01-01T00:00:00.000Z';
const baseProject: Project = { id: 'p', projectId: 'p', domain: 'personal', name: 'Product', description: 'Test', repository: 'owner/product', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/'], trustedChecks: [], trustedAppIds: [], ownerId: 'owner', autoMerge: false, budgetUsd: 10, createdAt };
interface Options {
  executionRunner?: 'grok' | 'dsh';
  unavailable?: Partial<Record<Runner, Role[]>>;
  policies?: Partial<Record<Runner, Partial<RunnerPolicy>>>;
  projectBudget?: number;
  taskBudget?: number;
  resultIdentity?: Partial<Record<Runner, { provider?: string; model?: string }>>;
}

function setup(options: Options = {}) {
  const store = new Store(':memory:'); stores.push(store);
  const project: Project = { ...baseProject, ...(options.executionRunner ? { executionRunner: options.executionRunner } : {}), budgetUsd: options.projectBudget ?? 10 };
  const source: SourceRevision = { id: 'source', projectId: project.id, domain: project.domain, kind: 'manual', externalId: 'idea', revision: 'revision-1', title: 'Retain drafts', content: 'Keep drafts after failed exports.', locator: 'manual:idea', authorId: 'owner', retention: 'permanent', status: 'active', createdAt };
  const initialTask: Task = { id: 'task', projectId: project.id, domain: project.domain, sourceId: source.id, sourceRevision: source.revision, title: source.title, description: source.content, status: 'executing', version: 1, createdAt, updatedAt: createdAt, runAfter: createdAt, attempts: 0, repairCount: 0, budgetUsd: options.taskBudget ?? 10, spentUsd: 0, stage: 'execute', plan: { taskVersion: 1, sourceRevision: source.revision, baselineSha: 'baseline', summary: 'Retain drafts', paths: ['docs/PRD.md'], steps: ['Update PRD'], tests: ['validate'], stopConditions: ['Source changes'] } };
  store.save('projects', project); store.save('sources', source); store.save('tasks', initialTask);
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: '', vaultDir: '', ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], scanIntervalMs: 1000, workers: {}, runnerPolicies: (['grok', 'dsh', 'codex'] as const).map(runner => ({ runner, roles: [...roles], domains: ['personal'], provider: `${runner}-provider`, model: `${runner}-model`, admitted: true, costPerRunUsd: .01, independentReview: false, ...options.policies?.[runner] })) };
  const calls: { runner: Runner; role: Role }[] = [];
  const workers: WorkerAdapter[] = (['grok', 'dsh', 'codex'] as const).map(name => ({ name, async run(input) {
    calls.push({ runner: name, role: input.role });
    if (options.unavailable?.[name]?.includes(input.role)) throw new WorkerUnavailable(`${name} offline`);
    let output: unknown;
    if (input.role === 'knowledge_extract') output = { cards: [] };
    if (input.role === 'case_extract') output = { observations: [] };
    if (input.role === 'decide') output = { action: 'proceed', summary: 'Update PRD', rationale: 'Drafts should be retained', citations: [], ruleIds: [] };
    if (input.role === 'plan') output = input.task.plan;
    if (input.role === 'execute') output = { taskVersion: input.task.version, planHash: digest(input.plan!), baselineSha: input.plan!.baselineSha, files: [{ path: 'docs/PRD.md', content: '# PRD\nKeep drafts.' }], tests: [{ command: 'validate', passed: true, output: '1 passed' }], summary: 'Updated' };
    if (input.role === 'check') output = { taskVersion: input.task.version, planHash: digest(input.plan!), artifactHash: digest(input.artifact!), verdict: 'pass', summary: 'Independent checks passed', issues: [], tests: [{ command: 'validate', passed: true, output: '1 passed' }] };
    if (input.role === 'feedback') output = { summary: 'Verified', observations: [] };
    return { output, costUsd: .01, model: `${name}-model`, provider: `${name}-provider`, ...options.resultIdentity?.[name] };
  } }));
  const scheduler = new Scheduler(store, config, workers);
  const run = async (role: Role) => {
    const task: Task = { ...store.get('tasks', initialTask.id)!, stage: role, status: role === 'check' ? 'checking' : 'executing' };
    store.save('tasks', task);
    const input: WorkerInput = { task, project, source, role, cards: [], rules: [], plan: task.plan, artifact: task.artifact };
    const output = await scheduler.run(task, project, input);
    if (role === 'execute' && output) store.save('tasks', { ...store.get('tasks', task.id)!, artifact: output as NonNullable<Task['artifact']> });
    return output;
  };
  return { store, run, calls, config, project, runners: (role: Role) => calls.filter(call => call.role === role).map(call => call.runner) };
}

afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe('project execution runner preference', () => {
  it('defaults to Grok and accepts dsh as the project execution preference', () => {
    expect(projectSchema.parse(baseProject).executionRunner).toBe('grok');
    expect(projectSchema.parse({ ...baseProject, executionRunner: 'dsh' }).executionRunner).toBe('dsh');
    expect(projectSchema.safeParse({ ...baseProject, executionRunner: 'codex' }).success).toBe(false);
  });

  it.each([undefined, 'grok'] as const)('uses Grok by default or with preference %s', async executionRunner => {
    const f = setup({ executionRunner }); await f.run('execute');
    expect(f.runners('execute')).toEqual(['grok']);
  });

  it('uses an explicitly preferred dsh when it is available', async () => {
    const f = setup({ executionRunner: 'dsh' }); await f.run('execute');
    expect(f.runners('execute')).toEqual(['dsh']);
  });

  it('falls back from unavailable dsh to Grok within the same task', async () => {
    const f = setup({ executionRunner: 'dsh', unavailable: { dsh: ['execute'] } }); await f.run('execute');
    expect(f.runners('execute')).toEqual(['dsh', 'grok']);
    expect(f.store.list('attempts').map(attempt => [attempt.runner, attempt.status])).toEqual([['dsh', 'unavailable'], ['grok', 'succeeded']]);
    expect(f.store.list('tasks')).toHaveLength(1);
  });

  it('falls back from dsh through Grok to Codex', async () => {
    const f = setup({ executionRunner: 'dsh', unavailable: { dsh: ['execute'], grok: ['execute'] } }); await f.run('execute');
    expect(f.runners('execute')).toEqual(['dsh', 'grok', 'codex']);
  });

  it.each([
    ['knowledge_extract', 'grok'], ['case_extract', 'grok'], ['decide', 'grok'], ['plan', 'codex'], ['feedback', 'codex'],
  ] as const)('keeps the %s role on its usual first runner', async (role, runner) => {
    const f = setup({ executionRunner: 'dsh' }); await f.run(role);
    expect(f.runners(role)).toEqual([runner]);
  });

  it.each([
    ['domain', { domains: ['other'] }], ['role', { roles: ['plan'] }], ['admission', { admitted: false }],
  ] satisfies [string, Partial<RunnerPolicy>][])('does not bypass dsh %s policy', async (_, policy) => {
    const f = setup({ executionRunner: 'dsh', policies: { dsh: policy } }); await f.run('execute');
    expect(f.runners('execute')).toEqual(['grok']);
  });

  it.each(['provider', 'model'] as const)('rejects a preferred runner whose actual %s is not admitted', async identity => {
    const f = setup({ executionRunner: 'dsh', resultIdentity: { dsh: { [identity]: 'unadmitted' } } });
    await expect(f.run('execute')).rejects.toMatchObject({ code: 'provider_not_admitted' });
    expect(f.runners('execute')).toEqual(['dsh']);
    expect(f.store.list('attempts').map(attempt => attempt.status)).toEqual(['failed']);
  });

  it.each([0, -.01, Number.NaN, Number.POSITIVE_INFINITY])('blocks a preferred runner without a positive finite conservative cost (%s)', async costPerRunUsd => {
    const f = setup({ executionRunner: 'dsh', policies: { dsh: { costPerRunUsd } } });
    expect(await f.run('execute')).toBeUndefined();
    expect(f.calls).toEqual([]); expect(f.store.list('attempts')).toEqual([]);
    expect(f.store.get('tasks', 'task')?.status).toBe('blocked');
  });

  it.each(['projectBudget', 'taskBudget'] as const)('preserves the authorized %s cap before invoking a preferred runner', async limit => {
    const f = setup({ executionRunner: 'dsh', [limit]: .005 });
    expect(await f.run('execute')).toBeUndefined();
    expect(f.calls).toEqual([]); expect(f.store.list('attempts')).toEqual([]);
    expect(f.store.list('events').at(-1)?.type).toBe('budget_exhausted');
  });

  for (const role of roles) {
    it.each([
      ['zero project cap with an older positive task cap', { projectBudget: 0, taskBudget: 10 }],
      ['zero task cap with a positive project cap', { projectBudget: 10, taskBudget: 0 }],
      ['claimed zero-cost admission without subscription proof', { policies: { grok: { costPerRunUsd: 0 }, dsh: { costPerRunUsd: 0 }, codex: { costPerRunUsd: 0 } } }],
    ] satisfies [string, Options][])(`blocks ${role} for %s before any attempt or reservation`, async (_, options) => {
      const f = setup(options);
      const original = f.store.get('tasks', 'task')!;
      expect(await f.run(role)).toBeUndefined();
      expect(f.calls).toEqual([]);
      expect(f.store.list('attempts')).toEqual([]);
      expect(f.store.list('tasks')).toHaveLength(1);
      expect(f.store.get('tasks', original.id)).toMatchObject({
        id: original.id, version: original.version, sourceRevision: original.sourceRevision,
        budgetUsd: original.budgetUsd, spentUsd: original.spentUsd, attempts: original.attempts,
        status: 'blocked', plan: original.plan,
      });
      expect(f.store.list('events').at(-1)?.type).toBe('budget_exhausted');
    });
  }
});

describe('independent review preference', () => {
  it('prefers healthy Grok over an independently admitted Codex that executed after fallback', async () => {
    const f = setup({ executionRunner: 'dsh', unavailable: { dsh: ['execute'], grok: ['execute'] }, policies: { codex: { independentReview: true } } });
    await f.run('execute'); await f.run('check');
    expect(f.runners('execute')).toEqual(['dsh', 'grok', 'codex']);
    expect(f.runners('check')).toEqual(['grok']);
  });

  it('uses the actual executor after fallback when ordering the distinct candidates', async () => {
    const f = setup({ executionRunner: 'dsh', unavailable: { dsh: ['execute'], codex: ['check'] }, policies: { grok: { independentReview: true } } });
    await f.run('execute'); await f.run('check');
    expect(f.runners('execute')).toEqual(['dsh', 'grok']);
    expect(f.runners('check')).toEqual(['codex', 'dsh']);
  });

  it('tries both distinct runners in the usual order before the admitted independent session', async () => {
    const f = setup({ unavailable: { grok: ['execute', 'check'], dsh: ['execute', 'check'] }, policies: { codex: { independentReview: true } } });
    await f.run('execute'); expect(await f.run('check')).toMatchObject({ verdict: 'pass' });
    expect(f.runners('check')).toEqual(['grok', 'dsh', 'codex']);
    expect(f.store.list('attempts').filter(attempt => attempt.role === 'check').map(attempt => attempt.status)).toEqual(['unavailable', 'unavailable', 'succeeded']);
  });

  it.each([
    ['independent review', { independentReview: false }],
    ['runner admission', { independentReview: true, admitted: false }],
    ['domain', { independentReview: true, domains: ['other'] }],
    ['role', { independentReview: true, roles: ['execute'] }],
  ] satisfies [string, Partial<RunnerPolicy>][])('blocks without using the same runner when %s is not admitted', async (_, policy) => {
    const f = setup({ unavailable: { grok: ['execute', 'check'], dsh: ['execute', 'check'] } });
    await f.run('execute'); Object.assign(f.config.runnerPolicies.find(candidate => candidate.runner === 'codex')!, policy);
    expect(await f.run('check')).toBeUndefined();
    expect(f.runners('check')).toEqual(['grok', 'dsh']);
    expect(f.store.get('tasks', 'task')?.status).toBe('blocked');
    expect(f.store.list('events').at(-1)?.type).toBe('workers_unavailable');
  });

  it('reserves all distinct attempts before admitting the same runner against remaining budget', async () => {
    const f = setup({ taskBudget: .055, unavailable: { grok: ['execute', 'check'], dsh: ['execute', 'check'] }, policies: { codex: { independentReview: true } } });
    await f.run('execute'); expect(await f.run('check')).toBeUndefined();
    expect(f.runners('check')).toEqual(['grok', 'dsh']);
    expect(f.store.get('tasks', 'task')?.spentUsd).toBeCloseTo(.05);
    expect(f.store.list('events').at(-1)?.type).toBe('budget_exhausted');
  });
});
