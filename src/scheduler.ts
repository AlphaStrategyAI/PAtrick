import { randomUUID } from 'node:crypto';
import { DomainError, WorkerUnavailable, digest, now, roleSchemas, stableId, type AppConfig, type Attempt, type Project, type Role, type Runner, type RunnerPolicy, type Task, type WorkerAdapter, type WorkerInput } from './domain.js';
import { Store } from './store.js';

const preferred: Record<Role, Runner[]> = {
  knowledge_extract: ['grok', 'dsh', 'codex'], case_extract: ['grok', 'dsh', 'codex'], decide: ['grok', 'dsh', 'codex'],
  plan: ['codex', 'grok', 'dsh'], execute: ['grok', 'dsh', 'codex'], check: ['codex', 'grok', 'dsh'], feedback: ['codex', 'grok', 'dsh'],
};

export class Scheduler {
  private workers: Map<Runner, WorkerAdapter>;
  constructor(private store: Store, private config: AppConfig, workers: WorkerAdapter[] | Partial<Record<Runner, WorkerAdapter>>) {
    this.workers = new Map((Array.isArray(workers) ? workers : Object.values(workers)).filter((w): w is WorkerAdapter => !!w).map(w => [w.name, w]));
  }

  async run(task: Task, project: Project, input: WorkerInput): Promise<unknown> {
    const frozen = structuredClone(input); const inputHash = digest(frozen);
    const execution = this.store.list('attempts').filter(a => a.taskId === task.id && a.taskVersion === task.version && a.role === 'execute' && a.status === 'succeeded').at(-1);
    const policies = preferred[input.role].flatMap(runner => {
      const policy = this.config.runnerPolicies.find(p => p.runner === runner && p.admitted && p.roles.includes(input.role) && p.domains.includes(task.domain));
      if (!policy) return [];
      // A shared runner is allowed only with explicitly admitted independent read-only checking.
      if (input.role === 'check' && execution && execution.runner === runner && !policy.independentReview) return [];
      return [policy];
    });
    let previous: Attempt | undefined; let reason = '';
    for (const policy of policies) {
      const current = this.current(task);
      if (!this.budgetAllows(current, project, policy)) {
        this.block(task, 'The remaining authorized budget cannot admit another run.', 'budget_exhausted'); return undefined;
      }
      const attempt: Attempt = { id: randomUUID(), projectId: task.projectId, domain: task.domain, taskId: task.id, taskVersion: task.version, role: input.role, runner: policy.runner, model: policy.model, provider: policy.provider, inputHash, status: 'running', costUsd: policy.costPerRunUsd, startedAt: now() };
      this.store.transaction(() => {
        const t = this.current(task);
        if (!this.budgetAllows(t, project, policy)) throw new DomainError('The remaining authorized budget cannot reserve this attempt.', 'budget_exhausted');
        this.store.save('attempts', attempt);
        this.store.save('tasks', { ...t, attempts: t.attempts + 1, spentUsd: t.spentUsd + policy.costPerRunUsd, updatedAt: now() });
        if (previous) {this.notify(task, stableId('fallback', previous.id, attempt.id), `${task.title} · ${input.role}: ${previous.runner} → ${policy.runner}. 原因：${reason}。已继续原任务。`);this.store.save('events',{id:stableId('switch-event',previous.id,attempt.id),projectId:task.projectId,domain:task.domain,taskId:task.id,type:'worker.switched',message:`${input.role}: ${previous.runner} → ${policy.runner}`,createdAt:now(),data:{from:previous.runner,to:policy.runner,role:input.role}});}
      });
      try {
        const worker = this.workers.get(policy.runner);
        if (!worker) throw new WorkerUnavailable(`${policy.runner} has no configured adapter.`);
        const invocation = structuredClone(frozen);
        const result = await worker.run(invocation);
        if (Number.isFinite(result.costUsd) && result.costUsd >= 0) this.charge(attempt, result.costUsd);
        if (digest(invocation) !== inputHash) throw new DomainError('A worker mutated its frozen input.', 'input_mutated');
        this.assertCurrentAttempt(attempt, task);
        if (!Number.isFinite(result.costUsd) || result.costUsd < 0) throw new DomainError('Worker returned an invalid cost.', 'invalid_cost');
        // Fees are accounted even if a result later fails schema or policy validation.
        if (result.provider !== policy.provider || result.model !== policy.model) throw new DomainError('Actual model/provider differs from current admission policy.', 'provider_not_admitted', 403);
        const parsed = roleSchemas[input.role].safeParse(result.output);
        if (!parsed.success) throw new DomainError(`Invalid ${input.role} result: ${parsed.error.message}`, 'invalid_worker_output');
        const spent = this.current(task);
        if (spent.spentUsd > Math.min(spent.budgetUsd, project.budgetUsd)) throw new DomainError('The worker exceeded the remaining authorized budget.', 'budget_exhausted');
        this.store.save('attempts', { ...this.store.get('attempts', attempt.id)!, status: 'succeeded', finishedAt: now() });
        return parsed.data;
      } catch (error) {
        const recorded = this.store.get('attempts', attempt.id);
        if (recorded?.status !== 'running' || !this.isCurrent(task)) {
          if (recorded?.status === 'running') this.store.save('attempts', { ...recorded, status: 'stale', finishedAt: now(), error: 'Obsolete task or attempt output rejected.' });
          throw new DomainError('An obsolete worker result was rejected.', 'stale_attempt', 409);
        }
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof WorkerUnavailable) {
          this.store.save('attempts', { ...recorded, status: 'unavailable', finishedAt: now(), error: message }); previous = attempt; reason = message; continue;
        }
        this.store.save('attempts', { ...recorded, status: 'failed', finishedAt: now(), error: message });
        throw error;
      }
    }
    this.block(task, `No admitted ${input.role} runner is currently available. ${reason}`, 'workers_unavailable');
    return undefined;
  }

  private current(task: Task): Task { const current = this.store.get('tasks', task.id); if (!current || !this.isCurrent(task)) throw new DomainError('Task or source changed.', 'stale_attempt', 409); return current; }
  private isCurrent(task: Task): boolean {
    const current = this.store.get('tasks', task.id); const source = this.store.get('sources', task.sourceId);
    return !!current && current.version === task.version && current.stage === task.stage && !['cancelled', 'delivered', 'archived'].includes(current.status) && source?.status === 'active' && source.revision === task.sourceRevision;
  }
  private assertCurrentAttempt(attempt: Attempt, task: Task): void {
    this.current(task); const current = this.store.get('attempts', attempt.id);
    const latest = this.store.list('attempts').filter(a => a.taskId === task.id && a.taskVersion === task.version && a.role === attempt.role).at(-1);
    if (current?.status !== 'running' || current.inputHash !== attempt.inputHash || latest?.id !== attempt.id) throw new DomainError('A previous attempt cannot commit late output.', 'stale_attempt', 409);
  }
  private charge(attempt: Attempt, costUsd: number): void {
    this.store.transaction(() => {
      const current = this.store.get('attempts', attempt.id)!; const task = this.store.get('tasks', attempt.taskId)!;
      const charged = Math.max(current.costUsd, costUsd);
      this.store.save('attempts', { ...current, costUsd: charged }); this.store.save('tasks', { ...task, spentUsd: task.spentUsd + charged - current.costUsd, updatedAt: now() });
    });
  }
  private budgetAllows(task: Task, project: Project, policy: RunnerPolicy): boolean {
    return Number.isFinite(policy.costPerRunUsd) && policy.costPerRunUsd > 0 && task.spentUsd + policy.costPerRunUsd <= Math.min(task.budgetUsd, project.budgetUsd);
  }
  private block(task: Task, message: string, code: string): void {
    this.store.transaction(() => {
      const current = this.current(task); const runAfter = new Date(Date.now() + 30_000).toISOString();
      this.store.save('tasks', { ...current, status: 'blocked', blockedFrom: current.status, runAfter, error: message, updatedAt: now() });
      this.notify(task, stableId('blocked', task.id, task.version, task.stage, current.attempts), `${task.title} · ${task.stage}: ${message} 下次探测：${runAfter}。无需回答。`);
      this.store.save('events', { id: randomUUID(), projectId: task.projectId, domain: task.domain, taskId: task.id, type: code, message, createdAt: now(), data: { runAfter } });
    });
  }
  private notify(task: Task, id: string, text: string): void {
    if (this.store.get('outbox', id)) return;
    this.store.save('outbox', { id, projectId: task.projectId, domain: task.domain, taskId: task.id, channel: this.config.feishu ? 'feishu' : 'origin', recipient: this.config.feishu?.ownerOpenId ?? this.config.ownerId, text, status: 'pending', attempts: 0, runAfter: now(), createdAt: now() });
  }
}
