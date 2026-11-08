import { recordLocalTests } from './experience-observations.js';
import { takeHostTestRun } from './integrations/workers.js';
import { randomUUID } from 'node:crypto';
import { DomainError, SubscriptionAccessError, WorkerUnavailable, digest, now, stableId, type AppConfig, type Attempt, type Project, type Role, type Runner, type Task, type WorkerAdapter, type WorkerInput, type WorkerResult } from './domain.js';
import { publicError } from './readiness.js';
import { Store } from './store.js';
import { assertBillingAuthorityBinding, billingSwitchInputHash, BillingAuthority } from './billing.js';

const preferred: Record<Role, Runner[]> = {
  knowledge_extract: ['grok', 'dsh', 'codex'], case_extract: ['grok', 'dsh', 'codex'], decide: ['grok', 'dsh', 'codex'],
  plan: ['codex', 'grok', 'dsh'], execute: ['grok', 'dsh', 'codex'], check: ['codex', 'grok', 'dsh'], feedback: ['codex', 'grok', 'dsh'],
};

export class Scheduler {
  private workers: Map<Runner, WorkerAdapter>;
  private readonly billing: BillingAuthority;
  constructor(private store: Store, private config: AppConfig, workers: WorkerAdapter[] | Partial<Record<Runner, WorkerAdapter>>, billing?: BillingAuthority) {
    this.billing = billing ?? new BillingAuthority(store, config, { async read() { return undefined; } });
    assertBillingAuthorityBinding(this.billing, store, config);
    this.workers = new Map((Array.isArray(workers) ? workers : Object.values(workers)).filter((w): w is WorkerAdapter => !!w).map(w => [w.name, w]));
  }

  async run(task: Task, project: Project, input: WorkerInput): Promise<unknown> {
    const frozen = structuredClone(input);
    // Pin legacy rows from host authority before consulting any candidate or price.
    const pinned = this.store.transaction(() => {
      const current = this.current(task), host = this.config.billingBoundary === undefined ? 'metered-only' : this.config.billingBoundary;
      if (host !== 'metered-only' && host !== 'included-only') throw new DomainError('Invalid host billing boundary.', 'billing_policy_invalid');
      if (current.billingBoundary === undefined) { const value = { ...current, billingBoundary: host }; this.store.save('tasks', value); return value; }
      return current;
    });
    const hostBoundary = this.config.billingBoundary === undefined ? 'metered-only' : this.config.billingBoundary;
    if (pinned.billingStop) return undefined;
    if (pinned.billingBoundary !== hostBoundary || (frozen.task.billingBoundary !== undefined && frozen.task.billingBoundary !== pinned.billingBoundary)) {
      this.block(task, 'The frozen task route does not match the current host route.', 'billing_boundary_mismatch'); return undefined;
    }
    const execution = this.store.list('attempts').filter(a => a.taskId === task.id && a.taskVersion === task.version && a.role === 'execute' && a.status === 'succeeded').at(-1);
    const runnerOrder = input.role === 'execute' && project.executionRunner === 'dsh' ? ['dsh', 'grok', 'codex'] as const : preferred[input.role];
    const admitted = runnerOrder.flatMap(runner => {
      const policy = this.config.runnerPolicies.find(p => p.runner === runner && p.admitted && p.roles.includes(input.role) && p.domains.includes(task.domain));
      return policy && ((policy.billing?.mode === 'included-subscription') === (pinned.billingBoundary === 'included-only')) ? [policy] : [];
    });
    // Prefer another runner before an explicitly admitted independent session on the actual executor.
    const policies = input.role === 'check' && execution
      ? [...admitted.filter(policy => policy.runner !== execution.runner), ...admitted.filter(policy => policy.runner === execution.runner && policy.independentReview)]
      : admitted;
    // A rolled-back switch can be retried on this authority with its canonical prior.
    const latest = this.store.list('attempts').filter(a => a.taskId === task.id && a.taskVersion === task.version && a.role === frozen.role).at(-1);
    let previous: Attempt | undefined = latest?.status === 'unavailable' && (latest.inputHash === digest(frozen) || latest.billing?.switchInputHash === billingSwitchInputHash(frozen, pinned.billingBoundary!)) && ['worker_unavailable', 'subscription_unavailable'].includes(latest.error ?? '') ? latest : undefined;
    let reason = previous?.error ?? '';
    for (const policy of policies) {
      let reserved;
      try { reserved = await this.billing.reserve(frozen, policy.runner, previous && previous.runner !== policy.runner ? { fromAttemptId: previous.id, reason: previous.error as 'worker_unavailable' | 'subscription_unavailable' } : undefined); }
      catch (cause) {
        if (!(cause instanceof DomainError)) throw cause;
        if (['subscription_unverified', 'subscription_expired', 'subscription_scope', 'subscription_profile_unavailable', 'billing_route_forbidden'].includes(cause.code)) { reason = cause.code; continue; }
        if (cause.code === 'subscription_attempt_limit') return undefined;
        if (['budget_exceeded', 'billing_budget_invalid', 'billing_policy_invalid'].includes(cause.code)) {
          this.block(task, 'The remaining authorized budget cannot admit another run.', 'budget_exhausted'); return undefined;
        }
        throw cause;
      }
      const attempt = reserved.attempt;
      let originalResult:WorkerResult|undefined;
      try {
        const worker = this.workers.get(policy.runner) ?? { name: policy.runner, async run() { throw new WorkerUnavailable('No configured worker adapter.'); } };
        const capturingWorker:WorkerAdapter={name:worker.name,async run(activeInput,signal,permit){const result=await worker.run(activeInput,signal,permit);originalResult=result;return result;}};
        const result = await this.billing.dispatch(reserved, structuredClone(frozen), capturingWorker);
        if(originalResult)recordLocalTests(this.store,reserved.attempt.id,frozen,originalResult,result.output);
        return result.output;
      } catch (cause) {
        if (cause instanceof WorkerUnavailable || (cause instanceof SubscriptionAccessError && cause.observation.disposition === 'verified-no-charge-refusal')) {
          previous = attempt; reason = cause instanceof SubscriptionAccessError ? 'subscription_unavailable' : 'worker_unavailable';
          // reserve() resolves the persisted unavailable attempt, never this stale clone.
          previous = { ...previous, error: reason };
          continue;
        }
        throw cause;
      } finally {if(originalResult)takeHostTestRun(originalResult);}
    }
    this.block(task, 'workers_unavailable', 'workers_unavailable');
    return undefined;
  }

  private current(task: Task): Task { const current = this.store.get('tasks', task.id); if (!current || !this.isCurrent(task)) throw new DomainError('Task or source changed.', 'stale_attempt', 409); return current; }
  private isCurrent(task: Task): boolean {
    const current = this.store.get('tasks', task.id); const source = this.store.get('sources', task.sourceId);
    return !!current && current.kind === task.kind && current.version === task.version && current.stage === task.stage && !['cancelled', 'delivered', 'completed', 'archived'].includes(current.status) && source?.status === 'active' && source.revision === task.sourceRevision && (current.kind === 'reference_knowledge' ? current.stage === 'knowledge_extract' && source.purpose === 'reference' : source.purpose !== 'reference');
  }
  private block(task: Task, message: string, code: string): void {
    this.store.transaction(() => {
      const current = this.current(task); if (current.billingStop) return; const runAfter = new Date(Date.now() + 30_000).toISOString();
      const coded = code === 'workers_unavailable' || code === 'budget_exhausted' || code === 'billing_boundary_mismatch';
      const ownerMessage = coded ? publicError(code)! : message;
      const notice = code === 'workers_unavailable'
        ? `${current.title}：当前没有可接这个角色的运行器。下次探测：${runAfter}。无需回答。`
        : code === 'budget_exhausted' || code === 'billing_boundary_mismatch'
          ? `${current.title}：${ownerMessage}`
          : `${current.title} · ${current.stage}: ${message} 下次探测：${runAfter}。无需回答。`;
      this.store.save('tasks', { ...current, status: 'blocked', blockedFrom: current.status, runAfter, error: coded ? code : message, updatedAt: now() });
      this.notify(task, stableId('blocked', task.id, task.version, task.stage, current.attempts), notice);
      this.store.save('events', { id: randomUUID(), projectId: task.projectId, domain: task.domain, taskId: task.id, type: code, message: ownerMessage, createdAt: now(), data: { runAfter } });
    });
  }
  private notify(task: Task, id: string, text: string): void {
    if (this.store.get('outbox', id)) return;
    this.store.save('outbox', { id, projectId: task.projectId, domain: task.domain, taskId: task.id, channel: this.config.feishu ? 'feishu' : 'origin', recipient: this.config.feishu?.ownerOpenId ?? this.config.ownerId, text, status: 'pending', attempts: 0, runAfter: now(), createdAt: now() });
  }
}
