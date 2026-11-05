import { assertPlanBinding, assertArtifactBinding, assertReviewBinding, testsRecorded } from './execution-contract.js';
import { randomUUID } from 'node:crypto';
import { DomainError, artifactSchema, decisionSchema, digest, executionPlanSchema, feedbackSchema, now, pathAllowed, questionAnswerSchema, reviewSchema, stableId, type AppConfig, type DeliveryReceipt, type DeliveryWriter, type NotificationAdapter, type Project, type Question, type QuestionAnswer, type ResearchAdapter, type ResearchRecord, type Role, type Runner, type Task, type TaskStatus, type WorkerAdapter, type WorkerInput } from './domain.js';
import { ingestSource, withdrawSource, type IngestInput } from './intake.js';
import { publishKnowledge } from './knowledge.js';
import { applicableRules, appendCaseOutcome, frozenAnswer, publishObservations, recordDecisionSnapshot, recordOwnerDecision } from './standards.js';
import { Scheduler } from './scheduler.js';
import { Store } from './store.js';
import { BillingAuthority } from './billing.js';
import { billingMessage, publicError, recordPolicyStatus, type BillingStatuses } from './readiness.js';

export interface WorkbenchOptions {
  store: Store; config: AppConfig; workers: WorkerAdapter[] | Partial<Record<Runner, WorkerAdapter>>;
  writer: DeliveryWriter; research: ResearchAdapter; notifier?: NotificationAdapter;
  canRun?: (project: Project) => boolean;
  billing?: BillingAuthority;
}
const stageStatus: Record<Task['stage'], TaskStatus> = { knowledge_extract: 'extracting', case_extract: 'extracting', decide: 'deciding', research: 'researching', plan: 'planning', execute: 'executing', check: 'checking', delivery: 'publishing', feedback: 'feedback' };
const stopped = new Set<TaskStatus>(['awaiting_answer', 'delivered', 'archived', 'cancelled']);

/** A task is a durable state machine. Waiting never holds a worker or an open DB transaction. */
export class Workbench {
  private readonly store: Store;
  private readonly config: AppConfig;
  private readonly writer: DeliveryWriter;
  private readonly research: ResearchAdapter;
  private readonly notifier?: NotificationAdapter;
  private readonly scheduler: Scheduler;
  private readonly billing: BillingAuthority;
  private readonly canRun?: (project: Project) => boolean;
  private busy = false;
  private stopping = false;
  private pauseDepth = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(options: WorkbenchOptions) {
    this.store = options.store; this.config = options.config; this.writer = options.writer; this.research = options.research; this.notifier = options.notifier;
    this.canRun = options.canRun;
    this.billing = options.billing ?? new BillingAuthority(this.store, this.config, { async read() { return undefined; } });
    this.scheduler = new Scheduler(this.store, this.config, options.workers, this.billing);
    for (const project of this.config.projects) if (!this.store.get('projects', project.id)) this.store.save('projects', project);
    this.store.rebuildIndex();
    // Only leased runtime initialization may reconcile a previous authority's attempts.
    // Constructing a Workbench must never close work owned by the live authority.
  }

  ingest(input: IngestInput): Task | undefined { return ingestSource(this.store, this.config, input); }
  withdraw(sourceId: string): void { withdrawSource(this.store, sourceId); }

  answer(input: QuestionAnswer): Task {
    const parsed = questionAnswerSchema.parse(input);
    // Preserve the owner's wording; validation only trims to test whether C is empty.
    const answer = { ...parsed, ...(input.text !== undefined ? { text: input.text } : {}) };
    return this.store.transaction(() => {
      const question = this.store.get('questions', answer.questionId);
      if (!question) throw new DomainError('Question not found.', 'unknown_question', 404);
      const task = this.task(question.taskId); const project = this.project(task);
      if (answer.actorId !== question.ownerId || answer.actorId !== project.ownerId) throw new DomainError('Only the current project owner may answer this question.', 'wrong_owner', 403);
      const source = this.store.get('sources', task.sourceId);
      if (question.status === 'stale' || source?.status !== 'active' || source.revision !== task.sourceRevision) throw new DomainError('This question is obsolete. Review the current task.', 'stale_answer', 409);
      if (question.taskVersion !== answer.taskVersion || question.version !== answer.questionVersion) throw new DomainError('Answer versions do not match the frozen question.', 'stale_answer', 409);
      const words = frozenAnswer(question, answer);
      const eventId = stableId('answer-event', task.projectId, task.domain, answer.eventId);
      const recorded = this.store.get('cursors', eventId);
      const fingerprint = digest({ questionId: question.id, choice: answer.choice, words });
      if (recorded && recorded.value !== fingerprint) throw new DomainError('This answer event already identifies a different answer.', 'answer_conflict', 409);
      if (question.status === 'answered') {
        if (question.answer?.actorId !== answer.actorId || question.answer.choice !== answer.choice || question.answer.text !== words) throw new DomainError('This question already has a different accepted answer.', 'answer_conflict', 409);
        return task;
      }
      if (task.status !== 'awaiting_answer' || task.questionId !== question.id || task.version !== question.taskVersion) throw new DomainError('The task has moved beyond this question.', 'stale_answer', 409);
      const at = now(); recordOwnerDecision(this.store, task, question, answer);
      this.store.save('questions', { ...question, status: 'answered', answeredAt: at, answer: { choice: answer.choice, text: words, actorId: answer.actorId, eventId: answer.eventId } });
      this.store.save('cursors', { id: eventId, projectId: task.projectId, domain: task.domain, value: fingerprint, updatedAt: at });
      const resumed: Task = { ...task, version: task.version + 1, status: 'deciding', stage: 'decide', updatedAt: at, runAfter: at, decision: undefined, decisionSnapshotId: undefined, plan: undefined, artifact: undefined, review: undefined, error: undefined };
      this.store.save('tasks', resumed);
      this.event(task, 'answer.accepted', 'Owner answer accepted; the original task resumed once.', { questionId: question.id, choice: answer.choice });
      return resumed;
    });
  }

  /** Read-only current host status: never reserve, restore availability or mint a permit. */
  async billingStatuses(projects: Project[]): Promise<BillingStatuses> {
    const statuses: BillingStatuses = {};
    for (const project of projects) {
      statuses[project.id] = {};
      const seen = new Set<(typeof this.config.runnerPolicies)[number]>();
      for (const policy of this.config.runnerPolicies) {
        if (seen.has(policy) || !policy.admitted || !policy.domains.includes(project.domain) || !policy.roles.some(role => this.config.runnerPolicies.find(p => p.admitted && p.runner === policy.runner && p.domains.includes(project.domain) && p.roles.includes(role)) === policy)) continue;
        seen.add(policy);
        recordPolicyStatus(statuses, project.id, policy, await this.billing.status(project, policy));
      }
    }
    return statuses;
  }

  retry(taskId: string): Task {
    const task = this.task(taskId);
    if (!task.billingStop && !['blocked', 'retrying'].includes(task.status)) throw new DomainError('Only a blocked or retrying task can be retried.', 'invalid_transition', 409);
    // Commit an exhausted cap before returning the 409; throwing inside the
    // retry transaction would roll the durable stop and owner notice back.
    const stop = this.billing.taskStop(task);
    if (stop) throw new DomainError(billingMessage({ state: 'blocked', reason: stop, attemptsLimit: Math.min(task.attemptLimit ?? 32, this.config.maxAttemptsPerTask ?? 32), attempts: task.attempts }), stop, 409);
    return this.store.transaction(() => {
      this.current(task);
      const project = this.project(task);
      const next: Task = { ...task, budgetUsd: project.budgetUsd, status: stageStatus[task.stage], error: undefined, runAfter: now(), updatedAt: now() };
      this.store.save('tasks', next); this.event(task, 'task.retried', 'Task explicitly retried.'); return next;
    });
  }

  cancel(taskId: string): Task {
    return this.store.transaction(() => {
      const task = this.task(taskId);
      if (task.status === 'delivered') throw new DomainError('Delivered work cannot be cancelled.', 'invalid_transition', 409);
      if (task.status === 'cancelled') return task;
      const next: Task = { ...task, status: 'cancelled', version: task.version + 1, updatedAt: now(), error: 'Cancelled by owner.' };
      this.store.save('tasks', next);
      for (const question of this.store.list('questions')) if (question.taskId === task.id && question.status === 'open') this.store.save('questions', { ...question, status: 'stale' });
      for (const attempt of this.store.list('attempts')) if (attempt.taskId === task.id && attempt.status === 'running') this.store.save('attempts', { ...attempt, status: 'stale', finishedAt: now(), error: 'Task cancelled.' });
      for (const action of this.store.list('actions')) if (action.taskId === task.id && action.status === 'pending') this.store.save('actions', { ...action, status: 'completed', payload: { cancelled: true }, updatedAt: now() });
      this.event(task, 'task.cancelled', 'Task cancelled.'); return next;
    });
  }

  async tick(): Promise<void> {
    if (this.busy || this.stopping || this.pauseDepth>0) return;
    this.busy = true;
    try {
      const ready = this.readyTask();
      if (ready) {
        let task = ready;
        try {
          this.current(task);
          const project = this.project(task);
          const source = this.store.get('sources', task.sourceId)!;
          if (source.retention === 'ephemeral' && !source.content) throw new DomainError('Temporary source content expired with the previous process. Re-ingest the authorized revision to resume.', 'ephemeral_expired');
          if (task.status !== stageStatus[task.stage]) { task = { ...task, status: stageStatus[task.stage], updatedAt: now() }; this.store.save('tasks', task); }
          this.beginAction(task);
          await this.process(task, project);
        } catch (error) {
          const latest = this.store.get('tasks', task.id);
          // Cancellation/revocation and a newer attempt own their own transition.
          if (latest && latest.version === task.version && latest.stage === task.stage && !stopped.has(latest.status)) {
            if (error instanceof DomainError && error.code === 'baseline_changed') this.replan(task);
            else if (!(error instanceof DomainError && error.code === 'stale_attempt')) this.fail(task, error);
          }
        }
      }
      await this.flushOutbox();
    } finally {
      this.busy = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  /** Retain writer ownership until the current stage and its notification flush have settled. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.busy) await new Promise<void>(resolve => this.idleWaiters.push(resolve));
  }
  async pause():Promise<()=>void>{this.pauseDepth++;if(this.busy)await new Promise<void>(resolve=>this.idleWaiters.push(resolve));let resumed=false;return ()=>{if(!resumed){resumed=true;this.pauseDepth--;}};}

  async runUntilIdle(maxSteps = 100): Promise<void> {
    for (let step = 0; step < maxSteps; step++) {
      const ready = !!this.readyTask(); await this.tick();
      if (!ready || !this.readyTask()) return;
    }
    if (this.readyTask()) throw new DomainError('The workbench step limit was reached; inspect the active task.', 'step_limit');
  }

  private async process(task: Task, project: Project): Promise<void> {
    if (task.stage === 'research') return this.performResearch(task, project);
    if (task.stage === 'delivery') return this.deliver(task, project);
    let input = this.input(task, project, task.stage);
    if (task.stage === 'plan') {
      const baselineSha = await this.writer.baseline(project); this.current(task);
      if (!baselineSha) throw new DomainError('The writer could not establish a repository baseline.', 'baseline_unavailable');
      const baselineFiles = this.writer.readBaseline ? await this.writer.readBaseline(project, baselineSha) : undefined;
      this.current(task);
      this.store.save('tasks', { ...this.task(task.id), baselineFiles });
      input = { ...this.input(task, project, task.stage), baselineSha, baselineFiles };
    }
    if (['execute', 'check'].includes(task.stage)) {
      this.validatePlan(this.task(task.id), project);
      const baselineSha = await this.writer.baseline(project); this.current(task);
      if (baselineSha !== task.plan?.baselineSha) throw new DomainError('The repository baseline changed; plan and validation must be recomputed.', 'baseline_changed', 409);
    }
    const output = await this.scheduler.run(task, project, input);
    if (output === undefined) return;
    this.current(task);
    this.store.transaction(() => {
      if (task.stage === 'knowledge_extract') {
        publishKnowledge(this.store, input.source, output); this.advance(task, 'case_extract');
      } else if (task.stage === 'case_extract') {
        publishObservations(this.store, input.source, output); this.advance(task, 'decide');
      } else if (task.stage === 'decide') {
        const decision = decisionSchema.parse(output); this.validateDecision(task, decision);
        const snapshot = recordDecisionSnapshot(this.store, task, input, decision);
        if (decision.action === 'archive') this.advance(task, 'decide', { status: 'archived', decision, decisionSnapshotId: snapshot.id });
        else if (decision.action === 'proceed') this.advance(task, 'plan', { decision, decisionSnapshotId: snapshot.id });
        else if (!input.research) this.advance(task, 'research', { decision, decisionSnapshotId: snapshot.id });
        else { this.validateResearch(input.research); this.openQuestion(task, project, decision, input.research, snapshot.id); }
      } else if (task.stage === 'plan') {
        const plan = executionPlanSchema.parse(output);
        if (plan.baselineSha !== input.baselineSha) throw new DomainError('The plan uses a different repository baseline.', 'invalid_plan');
        this.validatePlan({ ...task, plan }, project);
        this.advance(task, 'execute', { plan, artifact: undefined, review: undefined });
      } else if (task.stage === 'execute') {
        const artifact = artifactSchema.parse(output); this.validateArtifact(task, project, artifact);
        this.recordFailedTests(task, input, artifact.tests);
        this.advance(task, 'check', { artifact, review: undefined });
      } else if (task.stage === 'check') {
        const review = reviewSchema.parse(output); this.validateReview(task, review);
        this.recordFailedTests(task, input, review.tests);
        if (review.verdict === 'ask') this.advance(task, 'decide', { review, decision: undefined });
        else if (review.verdict === 'repair' || !this.testsPassed(task.plan!.tests, task.artifact!.tests) || !this.testsPassed(task.plan!.tests, review.tests)) this.repair(task, review);
        else this.advance(task, 'delivery', { review });
      } else if (task.stage === 'feedback') {
        const feedback = feedbackSchema.parse(output); const receipt = this.store.get('receipts', task.receiptId ?? '');
        if (!receipt) throw new DomainError('Feedback cannot complete work without a verified receipt.', 'missing_receipt');
        this.validateReceipt(task, project, receipt);
        appendCaseOutcome(this.store, task, receipt, feedback.summary);
        this.advance(task, 'feedback', { status: 'delivered', feedback: feedback.summary, error: undefined });
        this.enqueue(task, stableId('delivered', task.id, task.version), `${task.title} 已交付：${receipt.pullRequestUrl}\n${feedback.summary}`);
      }
    });
  }

  private async performResearch(task: Task, project: Project): Promise<void> {
    const question = task.decision?.question;
    if (!question) throw new DomainError('There is no decision to research.', 'missing_question');
    const research = await this.research.research(`${question.title}\n${question.context}\nA: ${question.A.description}\nB: ${question.B.description}`, project);
    this.current(task); this.validateResearch(research);
    this.store.transaction(() => {
      this.store.save('actions', { id: this.actionId(task), projectId: task.projectId, domain: task.domain, taskId: task.id, kind: 'research', status: 'completed', payload: { taskVersion: task.version, sourceRevision: task.sourceRevision, research }, updatedAt: now() });
      this.advance(task, 'decide');
    });
  }

  private async deliver(task: Task, project: Project): Promise<void> {
    this.validatePlan(task, project); this.validateArtifact(task, project, task.artifact);
    this.validateReview(task, task.review);
    if (task.review?.verdict !== 'pass' || !this.testsPassed(task.plan!.tests, task.artifact!.tests) || !this.testsPassed(task.plan!.tests, task.review.tests)) throw new DomainError('A passing independent review and actual planned tests are required before publishing.', 'unverified_artifact');
    const receipt = await this.writer.deliver(task, project); this.current(task);
    this.validateReceipt(task, project, receipt);
    this.store.transaction(() => {
      const existing = this.store.get('receipts', receipt.id);
      if (existing && digest(existing) !== digest(receipt)) throw new DomainError('The delivery receipt identifier already belongs to another result.', 'receipt_conflict', 409);
      this.store.save('receipts', receipt); this.advance(task, 'feedback', { receiptId: receipt.id });
    });
  }

  private input(task: Task, project: Project, role: Role): WorkerInput {
    const current = this.task(task.id); const source = this.store.get('sources', task.sourceId)!;
    const question = current.questionId ? this.store.get('questions', current.questionId) : undefined;
    const completedResearch = this.store.list('actions').find(a => a.taskId === task.id && a.kind === 'research' && a.status === 'completed' && a.payload.taskVersion === task.version && a.payload.sourceRevision === task.sourceRevision)?.payload.research as ResearchRecord | undefined;
    const activeCards = this.store.list('cards').filter(card => {
      const evidence = this.store.get('sources', card.sourceId);
      return card.projectId === task.projectId && card.domain === task.domain && card.status === 'active' && evidence?.status === 'active' && evidence.revision === card.sourceRevision && (!card.expiresAt || Date.parse(card.expiresAt) > Date.now());
    });
    const relevant=this.store.searchCards(`${current.title}\n${current.description}`,project,30);
    const cards=[...new Map([...activeCards.filter(card=>card.sourceId===source.id),...relevant].map(card=>[card.id,card])).values()].slice(0,30);
    return { task: current, project, role, source, cards, rules: applicableRules(this.store, current), answer: question?.status === 'answered' ? question.answer?.text : undefined, research: question?.status === 'answered' ? question.research : completedResearch, plan: current.plan, artifact: current.artifact, receipt: current.receiptId ? this.store.get('receipts', current.receiptId) : undefined, baselineFiles: current.baselineFiles };
  }

  private validateDecision(task: Task, decision: ReturnType<typeof decisionSchema.parse>): void {
    if (decision.action === 'proceed' && !decision.citations.length) throw new DomainError('Proceed requires at least one current authorized source quotation or bound owner-answer quotation.', 'missing_evidence');
    const temporaryTask = this.store.get('sources', task.sourceId)?.retention === 'ephemeral';
    for (const citation of decision.citations) {
      const source = this.store.get('sources', citation.sourceId);
      if (source?.status !== 'active' || source.revision !== citation.revision || source.projectId !== task.projectId || source.domain !== task.domain || !source.content.includes(citation.quote) || source.locator !== citation.locator || !temporaryTask && source.retention === 'ephemeral') throw new DomainError('Decision cites unavailable, out-of-scope or temporary-only evidence.', 'invalid_citation', 403);
    }
    const rules = new Set(applicableRules(this.store, task).map(rule => rule.id));
    if (decision.ruleIds.some(id => !rules.has(id))) throw new DomainError('Decision cites a rule outside its current authorized scope.', 'invalid_rule', 403);
  }

  private validateResearch(record: ResearchRecord): void {
    if (!record || !Array.isArray(record.queries) || !Array.isArray(record.gaps)) throw new DomainError('Research returned no verifiable query log.', 'insufficient_research');
    const languages = new Set<string>(); const originals = new Set<string>();
    for (const query of record.queries) {
      if (!['zh', 'en'].includes(query.language) || !query.query?.trim() || !Number.isFinite(Date.parse(query.searchedAt)) || !Array.isArray(query.sources)) throw new DomainError('Research contains an invalid query log.', 'insufficient_research');
      languages.add(query.language);
      for (const source of query.sources) {
        if (!source.excerpt?.trim() || !source.conditions?.trim() || !source.title?.trim() || !source.publishedAt || !Number.isFinite(Date.parse(source.accessedAt))) throw new DomainError('Opened research sources must include excerpts, dates and applicability.', 'insufficient_research');
        for (const url of [source.url, source.canonicalUrl]) { try { const parsed = new URL(url); if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(); } catch { throw new DomainError('Research source URL is invalid.', 'insufficient_research'); } }
        if (source.primary) originals.add(source.canonicalUrl.replace(/#.*$/, '').replace(/\/$/, ''));
      }
    }
    if (!languages.has('zh') || !languages.has('en') || originals.size < 2) throw new DomainError('Both Chinese and English must actually be searched, with at least two distinct primary originals supporting the alternatives.', 'insufficient_research');
    for (const language of ['zh', 'en']) if (!record.queries.some(q => q.language === language && q.sources.length) && !record.gaps.length) throw new DomainError('A missing-language evidence gap must be explicit.', 'insufficient_research');
  }

  private openQuestion(task: Task, project: Project, decision: ReturnType<typeof decisionSchema.parse>, research: ResearchRecord, decisionSnapshotId: string): void {
    const q = decision.question!;
    const urls = new Set(research.queries.flatMap(query => query.sources.flatMap(source => [source.url, source.canonicalUrl])));
    if (q.A.description === q.B.description || q.A.label === q.B.label || [q.A, q.B].some(suggestion => suggestion.evidenceUrls.some(url => !urls.has(url)))) throw new DomainError('Two distinct recommendations must cite the opened research sources.', 'invalid_recommendations');
    const version = this.store.list('questions').filter(question => question.taskId === task.id).length + 1;
    const question: Question = { id: stableId('question', task.id, task.version, version), projectId: task.projectId, domain: task.domain, taskId: task.id, taskVersion: task.version, version, ownerId: project.ownerId, title: q.title, context: q.context, options: { A: structuredClone(q.A), B: structuredClone(q.B) }, research: structuredClone(research), status: 'open', createdAt: now(), decisionSnapshotId };
    this.store.save('questions', question); this.advance(task, 'decide', { status: 'awaiting_answer', decision, decisionSnapshotId, questionId: question.id });
    this.enqueue(task, stableId('question-notice', question.id), `${question.title}\n${question.context}\nA · ${q.A.label}: ${q.A.description}\n依据：${q.A.rationale}\n代价：${q.A.tradeoff}\n${q.A.evidenceUrls.join('\n')}\nB · ${q.B.label}: ${q.B.description}\n依据：${q.B.rationale}\n代价：${q.B.tradeoff}\n${q.B.evidenceUrls.join('\n')}\nC · 我自己决定（自由输入）\n问题 ${question.id} · 版本 ${question.version}`);
  }

  private validatePlan(task: Task, project: Project): void { assertPlanBinding(task,project); }
  private validateArtifact(task: Task, project: Project, value: unknown): void { assertArtifactBinding(task,project,value); }
  private validateReview(task: Task, value: unknown): void {
    assertReviewBinding(task,value);
    const attempts = this.store.list('attempts').filter(a => a.taskId === task.id && a.taskVersion === task.version && a.status === 'succeeded');
    const execute = attempts.filter(a => a.role === 'execute').at(-1); const check = attempts.filter(a => a.role === 'check').at(-1);
    if (!execute || !check || execute.runner === check.runner && !this.config.runnerPolicies.some(p => p.runner === check.runner && p.admitted && p.independentReview && p.roles.includes('check') && p.domains.includes(task.domain))) throw new DomainError('The check lacks an admitted independent execution context.', 'nonindependent_review');
  }

  private validateReceipt(task: Task, project: Project, receipt: DeliveryReceipt): void {
    const file = task.artifact?.files.find(f => f.path === project.prdPath);
    if (!receipt || !file || receipt.taskId !== task.id || receipt.projectId !== task.projectId || receipt.domain !== task.domain || receipt.repository !== project.repository || receipt.path !== project.prdPath || !receipt.mergeSha?.trim() || !receipt.headSha?.trim() || !receipt.id || !Number.isInteger(receipt.pullRequestNumber) || receipt.pullRequestNumber < 1 || !Number.isFinite(Date.parse(receipt.verifiedAt)) || receipt.contentHash !== digest(file.content)) throw new DomainError('The writer did not return a verified, matching merged-file receipt.', 'invalid_receipt');
    try { if (new URL(receipt.pullRequestUrl).protocol !== 'https:') throw new Error(); } catch { throw new DomainError('The writer did not provide a valid remote pull request URL.', 'invalid_receipt'); }
    if (!project.autoMerge || !project.trustedChecks.length || !project.trustedAppIds.length || !Array.isArray(receipt.checks) || project.trustedChecks.some(name => !receipt.checks.some(check => check.name === name && check.conclusion === 'success' && check.headSha === receipt.headSha && project.trustedAppIds.includes(check.appId) && !!check.url))) throw new DomainError('The merged head lacks every required trusted successful check.', 'invalid_receipt');
  }

  private testsPassed(commands: string[], tests: { command: string; passed: boolean; output: string }[]): boolean { return testsRecorded(commands, tests) && tests.every(test => test.passed); }
  private repair(task: Task, review: Task['review']): void {
    if (task.repairCount >= 2) { this.fail(task, new DomainError('Two repair rounds have been exhausted; no unverified change was published.', 'repairs_exhausted')); return; }
    this.advance(task, 'execute', { review, repairCount: task.repairCount + 1, error: 'Independent tests or review requested repair.' });
  }

  private replan(task: Task): void {
    this.store.transaction(() => {
      const current = this.current(task);
      this.completeAction(task);
      this.store.save('tasks', { ...current, version: current.version + 1, stage: 'plan', status: 'planning', plan: undefined, artifact: undefined, review: undefined, baselineFiles: undefined, repairCount: 0, receiptId: undefined, updatedAt: now(), runAfter: now(), error: 'baseline_changed' });
      this.event(task, 'baseline.changed', publicError('baseline_changed')!);
    });
  }

  private advance(task: Task, stage: Task['stage'], values: Partial<Task> = {}): void {
    const current = this.current(task);
    this.completeAction(task);
    this.store.save('tasks', { ...current, stage, status: stageStatus[stage], updatedAt: now(), runAfter: now(), error: undefined, ...values });
    this.event(task, 'stage.completed', `${task.stage} completed.`, { next: stage, status: values.status ?? stageStatus[stage] });
  }
  private fail(task: Task, error: unknown): void {
    const rawCode = error instanceof DomainError ? error.code : 'technical_failure';
    const known = new Set(['baseline_changed', 'baseline_unavailable', 'ephemeral_expired', 'pending_ci', 'remote_unavailable', 'technical_failure', 'invalid_plan', 'invalid_artifact', 'invalid_review', 'invalid_receipt', 'invalid_recommendations', 'insufficient_research', 'missing_test_evidence', 'nonindependent_review', 'repairs_exhausted', 'stale_attempt', 'invalid_test_observation']);
    const safe = publicError(rawCode)!;
    const code = known.has(rawCode) || safe === rawCode ? rawCode : 'technical_failure';
    const message = publicError(code)!;
    const retrying = task.stage === 'delivery' && ['pending_ci', 'remote_unavailable', 'technical_failure'].includes(code);
    this.store.transaction(() => {
      const current = this.current(task);
      if (current.billingStop) return;
      const runAfter = new Date(Date.now() + 30_000).toISOString();
      this.store.save('tasks', { ...current, status: retrying ? 'retrying' : 'blocked', blockedFrom: stageStatus[task.stage], updatedAt: now(), runAfter, error: message });
      this.event(task, code, message, { stage: task.stage, runAfter });
      this.enqueue(task, stableId('error', task.id, task.version, task.stage, code, current.attempts), `${task.title} · ${task.stage} 暂停：${message}\n保留原任务，下次重试 ${runAfter}。无需回答。`);
    });
  }

  private readyTask(): Task | undefined {
    if (this.stopping) return undefined;
    return this.store.list('tasks').filter(task => {
      if (task.billingStop || stopped.has(task.status) || Date.parse(task.runAfter) > Date.now()) return false;
      const project = this.store.get('projects', task.projectId);
      return !!project && project.domain === task.domain && (!this.canRun || this.canRun(project));
    }).sort((a, b) => a.runAfter.localeCompare(b.runAfter) || a.createdAt.localeCompare(b.createdAt))[0];
  }
  private task(id: string): Task { const task = this.store.get('tasks', id); if (!task) throw new DomainError('Task not found.', 'unknown_task', 404); return task; }
  private project(task: Task): Project { const project = this.store.get('projects', task.projectId); if (!project || project.domain !== task.domain) throw new DomainError('The project scope is no longer authorized.', 'project_not_authorized', 403); return project; }
  private current(task: Task): Task {
    const current = this.task(task.id); const source = this.store.get('sources', task.sourceId);
    if (current.version !== task.version || current.stage !== task.stage || current.status === 'cancelled' || source?.status !== 'active' || source.revision !== task.sourceRevision || source.projectId !== task.projectId || source.domain !== task.domain) throw new DomainError('Task input or source is obsolete.', 'stale_attempt', 409);
    return current;
  }
  /** Only validated stage results enter the host ledger, before a repair replaces task buffers. */
  private recordFailedTests(task: Task, input: WorkerInput, tests: { command: string; passed: boolean; output: string }[]): void {
    const failed = tests.filter(test => !test.passed && task.plan?.tests.includes(test.command));
    if (!failed.length || !task.decisionSnapshotId) return;
    const attempt = this.store.list('attempts').filter(a => a.taskId === task.id && a.taskVersion === task.version && a.role === input.role && a.status === 'succeeded' && a.inputHash === digest(input)).at(-1);
    if (!attempt) throw new DomainError('A validated test observation requires its accepted host attempt.', 'invalid_test_observation');
    const id = stableId('planned-test-observation', task.decisionSnapshotId, task.version, attempt.id, input.role);
    if (this.store.get('actions', id)) return;
    const recordedAt = now();
    this.store.save('actions', { id, projectId: task.projectId, domain: task.domain, taskId: task.id, kind: 'decision.tests', status: 'completed', payload: { testObservation: { schemaVersion: 1, snapshotId: task.decisionSnapshotId, taskVersion: task.version, attemptId: attempt.id, inputHash: attempt.inputHash, stage: input.role, plannedTests: task.plan!.tests, tests: failed, recordedAt } }, updatedAt: recordedAt });
  }
  private actionId(task: Task): string { return stableId('stage-action', task.id, task.version, task.stage, task.repairCount); }
  private beginAction(task: Task): void { const id = this.actionId(task); if (!this.store.get('actions', id)) this.store.save('actions', { id, projectId: task.projectId, domain: task.domain, taskId: task.id, kind: task.stage, status: 'pending', payload: { taskVersion: task.version, sourceRevision: task.sourceRevision }, updatedAt: now() }); }
  private completeAction(task: Task): void { const action = this.store.get('actions', this.actionId(task)); if (action) this.store.save('actions', { ...action, status: 'completed', updatedAt: now() }); }
  private event(task: Task, type: string, message: string, data: Record<string, unknown> = {}): void { this.store.save('events', { id: randomUUID(), projectId: task.projectId, domain: task.domain, taskId: task.id, type, message, data, createdAt: now() }); }
  private enqueue(task: Task, id: string, text: string): void { if (!this.store.get('outbox', id)) this.store.save('outbox', { id, projectId: task.projectId, domain: task.domain, taskId: task.id, channel: this.config.feishu ? 'feishu' : 'origin', recipient: this.config.feishu?.ownerOpenId ?? this.config.ownerId, text, status: 'pending', attempts: 0, createdAt: now(), runAfter: now() }); }

  private async flushOutbox(): Promise<void> {
    if (!this.notifier) return;
    for (const message of this.store.list('outbox').filter(m => m.status === 'pending' && Date.parse(m.runAfter) <= Date.now()).slice(0, 20)) {
      try {
        const receipt = await this.notifier.send(message);
        if (!receipt.remoteId?.trim()) throw new Error('Notification adapter returned no delivery identifier.');
        const current = this.store.get('outbox', message.id);
        if (current?.status === 'pending') this.store.save('outbox', { ...current, attempts: current.attempts + 1, status: 'sent', remoteId: receipt.remoteId });
      } catch {
        const current = this.store.get('outbox', message.id);
        if (current?.status === 'pending') this.store.save('outbox', { ...current, attempts: current.attempts + 1, runAfter: new Date(Date.now() + Math.min(3600_000, 1000 * 2 ** Math.min(current.attempts, 12))).toISOString() });
      }
    }
  }
}
