import { linkRetainedExperienceEvidence } from './experience.js';
import { expandFactRefs, factualEligibility, knowledgeReference } from './knowledge-use.js';
import type { FactualContext, FactualUseView } from './knowledge-contract.js';
import { assertPlanBinding, assertArtifactBinding, assertReviewBinding, testsRecorded } from './execution-contract.js';
import { randomUUID } from 'node:crypto';
import { DomainError, artifactSchema, decisionSchema, decisionInterpretationFor, digest, executionPlanSchema, feedbackSchema, now, pathAllowed, questionAnswerSchema, reviewSchema, roles, stableId, type AppConfig, type DeliveryReceipt, type DeliveryWriter, type NotificationAdapter, type Project, type Question, type QuestionAnswer, type ResearchAdapter, type ResearchRecord, type Role, type Runner, type Task, type TaskStatus, type WorkerAdapter, type WorkerInput } from './domain.js';
import { ingestSource, withdrawSource, type IngestInput } from './intake.js';
import { ingestStructuredKnowledge, publishKnowledge, type StructuredCurrentReceipt } from './knowledge.js';
import { consumedStageResult, enqueueStructuredKnowledge, isReadyStructuredKnowledgeJob, readyStructuredKnowledgeJobs, structuredIngestJobSchema, structuredKnowledgeJobId, validStructuredJobRefs } from './knowledge-jobs.js';
import { knowledgePolicyHash } from './knowledge-identity.js';
import { canonicalFactualContextPayloadSchema, knowledgeRequestSourceRefs, readHostObservation } from './knowledge-records.js';
import { assertKnowledgeSource, parseStructuredKnowledge, structuredRepositoryRequest } from './structured-knowledge.js';
import type { RepositoryKnowledgeReader } from './integrations/repository-knowledge.js';
import { applicableRules, appendCaseOutcome, frozenAnswer, publishObservations, recordDecisionSnapshot, recordOwnerDecision } from './standards.js';
import { Scheduler } from './scheduler.js';
import { isKnowledgeSnapshotFailure, Store, VaultSyncError } from './store.js';
import { BillingAuthority } from './billing.js';
import { billingMessage, publicError, recordPolicyStatus, type BillingStatuses } from './readiness.js';

export interface WorkbenchOptions {
  store: Store; config: AppConfig; workers: WorkerAdapter[] | Partial<Record<Runner, WorkerAdapter>>;
  writer: DeliveryWriter; research: ResearchAdapter; notifier?: NotificationAdapter;
  canRun?: (project: Project) => boolean;
  repositoryKnowledgeReader?: RepositoryKnowledgeReader;
  billing?: BillingAuthority;
}
/** Refresh outside SQLite; only the admitted one-use selection can create a dispatch context. */
export async function prepareFactualContext(store:Store,reader:RepositoryKnowledgeReader|undefined,task:Task,signal:AbortSignal):Promise<FactualContext|undefined> {
 if(!reader||signal.aborted)return undefined;
 const source=store.get('sources',task.sourceId),project=store.get('projects',task.projectId),live=store.get('tasks',task.id);
 if(!source||!project||!live||live.version!==task.version||live.sourceId!==task.sourceId||source.revision!==task.sourceRevision)return undefined;
 let parsed:ReturnType<typeof parseStructuredKnowledge>;
 try{assertKnowledgeSource(store,source,project);parsed=parseStructuredKnowledge(source,project);}catch(error){if(isKnowledgeSnapshotFailure(error))throw error;return undefined;}
 if(parsed?.kind!=='repository-facts'||parsed.input.changeNumber===undefined)return undefined;
 const receipts:StructuredCurrentReceipt[]=[];
 const result=await ingestStructuredKnowledge(store,reader,source.id,signal,{refresh:'current',onCurrentReceipt:receipt=>{receipts.push(receipt);}});
 const receipt=receipts[0];if(result!=='processed'||!receipt||signal.aborted||!receipt.observations.length)return undefined;
 return store.transaction(()=>{
  const current=store.get('tasks',task.id),currentSource=store.get('sources',source.id),currentProject=store.get('projects',project.id);
  if(!current||current.version!==task.version||current.sourceId!==source.id||current.sourceRevision!==source.revision||!currentSource||digest(currentSource)!==digest(source)||!currentProject||knowledgePolicyHash(currentProject)!==knowledgePolicyHash(project))return undefined;
  const request=structuredRepositoryRequest(store,source,project,parsed!);request.current={changeNumber:parsed!.input.changeNumber!,checkNames:[...project.trustedChecks]};
  const sourceRefs=knowledgeRequestSourceRefs(store,source.id,project,request);if(!sourceRefs)return undefined;
  if(receipt.observations.some(entry=>{const observation=readHostObservation(store,entry.id,project);return !observation||digest(observation)!==entry.hash;}))return undefined;
  const context:FactualContext={id:stableId('factual-context',randomUUID()),projectId:project.id,domain:project.domain,observedAt:receipt.observedAt,projectPolicyHash:knowledgePolicyHash(project),source:{id:source.id,revision:source.revision},sourceHash:digest(source),task:{id:task.id,version:task.version},observations:receipt.observations};
  const payload={schemaVersion:1 as const,context,digest:digest(context),sourceRefs};if(!canonicalFactualContextPayloadSchema.safeParse(payload).success)return undefined;
  store.save('actions',{id:context.id,projectId:project.id,domain:project.domain,taskId:task.id,kind:'knowledge.factual-context',status:'completed',payload,updatedAt:now()});
  return context;
 });
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
  private readonly repositoryKnowledgeReader?: RepositoryKnowledgeReader;
  private busy = false;
  private stopping = false;
  private pauseDepth = 0;
  private idleWaiters: (() => void)[] = [];
  private hostAbort?: AbortController;
  private hostPreferredTaskId?: string;
  private activeHostReads = 0;
  private activeHostActors = new Set<Promise<unknown>>();
  private localHolds = new Set<string>();
  private localRetryOnce = new Set<string>();

  constructor(options: WorkbenchOptions) {
    this.store = options.store; this.config = options.config; this.writer = options.writer; this.research = options.research; this.notifier = options.notifier;
    this.canRun = options.canRun;
    const reader=options.repositoryKnowledgeReader;
    this.repositoryKnowledgeReader = reader && {read:(project,source,request,signal)=>{
      // An adapter may ignore abort; its I/O still occupies a host-read slot until it settles.
      if(this.activeHostReads>=4)return Promise.reject(new DomainError('Host read capacity is occupied.','host_read_capacity',409));
      this.activeHostReads++;
      try{
        let actor:Promise<unknown>;
        const result=Promise.resolve(reader.read(project,source,request,signal)).finally(()=>{this.activeHostReads--;this.activeHostActors.delete(actor);});
        actor=result;this.activeHostActors.add(actor);return result;
      }
      catch(error){this.activeHostReads--;throw error;}
    }};
    this.billing = options.billing ?? new BillingAuthority(this.store, this.config, { async read() { return undefined; } });
    this.scheduler = new Scheduler(this.store, this.config, options.workers, this.billing);
    for (const project of this.config.projects) if (!this.store.get('projects', project.id)) this.store.save('projects', project);
    this.store.rebuildIndex();
    linkRetainedExperienceEvidence(this.store);
    // Only leased runtime initialization may reconcile a previous authority's attempts.
    // Constructing a Workbench must never close work owned by the live authority.
  }

  ingest(input: IngestInput): Task | undefined {return ingestSource(this.store,this.config,input);}
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
    const source=this.store.get('sources',task.sourceId),jobAction=source&&this.store.get('actions',structuredKnowledgeJobId(source)),job=jobAction&&structuredIngestJobSchema.safeParse(jobAction.payload);
    const heldRead=task.stage==='knowledge_extract'&&jobAction?.status==='pending'&&job?.success&&['knowledge_read_inflight','knowledge_snapshot_unavailable'].includes(job.data.errorCode??'');
    const expiredFeedback=source?.retention==='ephemeral'&&task.stage==='feedback'&&(!source.content||!task.plan||!task.artifact||!task.review||!task.receiptId);
    const heldFeedback=source?.retention==='ephemeral'&&task.stage==='feedback'&&(this.localHolds.has(this.actionId(task))||consumedStageResult(this.store,task));
    if (!task.billingStop && !['blocked', 'retrying'].includes(task.status)&&!heldRead&&!expiredFeedback&&!heldFeedback) throw new DomainError('Only a blocked or retrying task can be retried.', 'invalid_transition', 409);
    // Commit an exhausted cap before returning the 409; throwing inside the
    // retry transaction would roll the durable stop and owner notice back.
    const stop = this.billing.taskStop(task);
    if (stop) throw new DomainError(billingMessage({ state: 'blocked', reason: stop, attemptsLimit: Math.min(task.attemptLimit ?? 32, this.config.maxAttemptsPerTask ?? 32), attempts: task.attempts }), stop, 409);
    const retried=this.store.transaction(() => {
      this.current(task);
      const project = this.project(task);
      const source=this.store.get('sources',task.sourceId),acceptedHash=source&&this.store.get('cursors',stableId('source-hash',source.id))?.value;
      if(source&&task.stage==='feedback'&&!this.feedbackContextAvailable(task,source,project))throw new DomainError('Delivery completed, but feedback context expired; automatic recovery is unavailable.','feedback_context_unavailable',409);
      if(!source||acceptedHash&&acceptedHash!==digest(source.content))throw new DomainError('Knowledge source content changed.','stale_source',409);
      this.recoverStructuredHold(source);
      const reconstruct=source.retention==='ephemeral'&&task.stage!=='knowledge_extract'&&task.stage!=='feedback'&&consumedStageResult(this.store,task);
      const next: Task = reconstruct
        ? {...task,budgetUsd:project.budgetUsd,version:task.version+1,status:'queued',stage:'knowledge_extract',runAfter:now(),updatedAt:now(),repairCount:0,decision:undefined,decisionSnapshotId:undefined,plan:undefined,artifact:undefined,review:undefined,questionId:undefined,receiptId:undefined,feedback:undefined,baselineFiles:undefined,error:undefined,blockedFrom:undefined}
        : { ...task, budgetUsd: project.budgetUsd, status: stageStatus[task.stage], error: undefined, runAfter: now(), updatedAt: now() };
      this.store.save('tasks', next); this.event(task, 'task.retried', 'Task explicitly retried.'); return next;
    });
    const actionId=this.actionId(task);this.localHolds.delete(actionId);if(retried.version===task.version)this.localRetryOnce.add(actionId);return retried;
  }

  private recoverStructuredHold(source:import('./domain.js').SourceRevision):void {
    const id=structuredKnowledgeJobId(source),action=this.store.get('actions',id),job=action&&structuredIngestJobSchema.safeParse(action.payload);
    if(action?.status==='pending'&&job?.success&&['knowledge_read_inflight','knowledge_snapshot_unavailable'].includes(job.data.errorCode??'')){
      const project=this.store.get('projects',source.projectId),acceptedHash=this.store.get('cursors',stableId('source-hash',source.id))?.value;
      if(!project||source.status!=='active'||project.id!==project.projectId||project.id!==source.projectId||project.domain!==source.domain||
        action.projectId!==source.projectId||action.domain!==source.domain||action.kind!=='knowledge.structured-ingest'||job.data.sourceId!==source.id||job.data.sourceRevision!==source.revision||
        job.data.sourceHash!==digest(source.content)||acceptedHash&&acceptedHash!==digest(source.content)||!validStructuredJobRefs(this.store,source,job.data.sourceRefs))throw new DomainError('Structured ingest job changed.','stale_source',409);
      if(job.data.readHold&&(job.data.readHold.policyHash!==knowledgePolicyHash(project)||job.data.readHold.sourceHashes.length!==job.data.sourceRefs.length||job.data.readHold.sourceHashes.some((ref,index)=>{
        const dependency=this.store.get('sources',ref.id),hash=this.store.get('cursors',stableId('source-hash',ref.id))?.value;
        return ref.id!==job.data.sourceRefs[index]?.id||ref.revision!==job.data.sourceRefs[index]?.revision||!dependency||dependency.status!=='active'||dependency.revision!==ref.revision||dependency.projectId!==source.projectId||dependency.domain!==source.domain||digest(dependency.content)!==ref.hash||!!hash&&hash!==ref.hash;
      })))throw new DomainError('Knowledge dependencies or policy changed.','stale_source',409);
      assertKnowledgeSource(this.store,source,project);const parsed=parseStructuredKnowledge(source,project);
      if(!parsed)throw new DomainError('Structured ingest job changed.','stale_source',409);
      const request=structuredRepositoryRequest(this.store,source,project,parsed),refs=knowledgeRequestSourceRefs(this.store,source.id,project,request);
      if(!refs||digest(refs)!==digest(job.data.sourceRefs))throw new DomainError('Knowledge dependencies changed.','stale_source',409);
      const {readHold:_hold,...remaining}=job.data;
      this.store.save('actions',{...action,payload:{...remaining,errorCode:undefined,runAfter:now()},updatedAt:now()});
    }
  }

  private holdLocalTask(task:Task):void {
    this.localHolds.add(this.actionId(task));
    try{
      const current=this.store.get('tasks',task.id);
      if(current&&current.version===task.version&&current.stage===task.stage&&current.repairCount===task.repairCount&&!stopped.has(current.status))
        this.store.save('tasks',{...current,status:'blocked',blockedFrom:stageStatus[current.stage],error:'knowledge_snapshot_unavailable',updatedAt:now()});
    }catch(error){if(!isKnowledgeSnapshotFailure(error))throw error;}
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

  async tick(preferredTaskId?:string): Promise<void> {
    if (this.stopping || this.pauseDepth>0) return;
    if(this.busy){
      // A different ready task can preempt a host read; an ordinary self-tick cannot.
      const preferred=this.hostAbort?this.readyTask(this.hostPreferredTaskId):undefined;
      if(this.hostAbort&&preferred){
        this.hostAbort.abort();await new Promise<void>(resolve=>this.idleWaiters.push(resolve));
        if(!this.stopping&&this.pauseDepth===0)await this.tick(preferred.id);
      }
      return;
    }
    this.busy = true;
    try {
      this.store.reconcileVault();
      const ready = (preferredTaskId?this.readyTask(undefined,preferredTaskId):undefined)??this.readyTask();
      const source = ready?.stage==='knowledge_extract' ? this.store.get('sources',ready.sourceId) : undefined;
      if(source)enqueueStructuredKnowledge(this.store,source);
      const preferred=source?await this.drainHostJobs(1,structuredKnowledgeJobId(source),true,ready?.id):{count:0,aborted:false};
      if(preferred.aborted||this.stopping||this.pauseDepth>0)return;
      if (ready) {
        let task = ready;
        try {
          this.current(task);
          const project = this.project(task);
          const source = this.store.get('sources', task.sourceId)!;
          if (source.retention === 'ephemeral' && !source.content) throw new DomainError('Temporary source content expired with the previous process. Re-ingest the authorized revision to resume.', 'ephemeral_expired');
          if (task.status !== stageStatus[task.stage]) { task = { ...task, status: stageStatus[task.stage], updatedAt: now() }; this.store.save('tasks', task); }
          let handled=false;
          if(task.stage==='knowledge_extract'){
            const action=this.store.get('actions',structuredKnowledgeJobId(source)),job=action&&structuredIngestJobSchema.safeParse(action.payload);
            if(!action||!job?.success)throw new DomainError('Structured knowledge job is invalid.','invalid_structured_knowledge',400);
            if(action.status==='pending')handled=true;
            if(job.data.phase==='invalid')throw new DomainError('Invalid structured knowledge envelope.','invalid_structured_knowledge',400);
            if(job.data.phase==='processed'){this.beginAction(task);this.store.transaction(()=>this.advance(task,'case_extract'));handled=true;}
            if(job.data.phase!=='ordinary')handled=true;
          }
          if(!handled){this.beginAction(task);this.localRetryOnce.delete(this.actionId(task));if(await this.process(task, project)==='preempted')return;}
        } catch (error) {
          if(isKnowledgeSnapshotFailure(error)||error instanceof VaultSyncError){this.holdLocalTask(task);throw error;}
          const latest = this.store.get('tasks', task.id);
          // Cancellation/revocation and a newer attempt own their own transition.
          if (latest && latest.version === task.version && latest.stage === task.stage && !stopped.has(latest.status)) {
            if (error instanceof DomainError && error.code === 'baseline_changed') this.replan(task);
            else if (!(error instanceof DomainError && error.code === 'stale_attempt')) this.fail(task, error);
          }
        }
      }
      if(!this.stopping&&this.pauseDepth===0)await this.drainHostJobs(4-preferred.count);
      await this.flushOutbox();
    } finally {
      this.busy = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  private async drainHostJobs(limit:number,preferredId?:string,onlyPreferred=false,preferredTaskId?:string):Promise<{count:number;aborted:boolean}>{
    const at=now(),bounded=Math.max(0,Math.min(4,Math.floor(limit)));
    if(!Number.isFinite(bounded)||!bounded)return {count:0,aborted:false};
    const preferred=preferredId&&this.store.get('actions',preferredId);
    const first=preferred&&isReadyStructuredKnowledgeJob(this.store,preferred,at)?[preferred]:[];
    const jobs=[...first,...(onlyPreferred?[]:readyStructuredKnowledgeJobs(this.store,at,4).filter(j=>j.id!==preferredId))].slice(0,bounded);
    if(!jobs.length)return {count:0,aborted:false};
    const controller=new AbortController();this.hostAbort=controller;this.hostPreferredTaskId=preferredTaskId;
    try{
    const actors=jobs.map(async job=>{
      const payload=structuredIngestJobSchema.safeParse(job.payload),project=this.store.get('projects',job.projectId);
      if(!payload.success||!project||project.domain!==job.domain)return;
      const denied=!!this.canRun&&!this.canRun(project);
      try{await ingestStructuredKnowledge(this.store,denied?undefined:this.repositoryKnowledgeReader,payload.data.sourceId,AbortSignal.any([controller.signal,AbortSignal.timeout(30_000)]),denied?{readbackUnavailableReason:'host_egress_unavailable'}:{});}catch(error){
        if(isKnowledgeSnapshotFailure(error))throw error;
        // An unexpected pre-read failure must not leave a ready job in a tight retry loop.
        const current=this.store.get('actions',job.id),state=current&&structuredIngestJobSchema.safeParse(current.payload);
        if(current?.status==='pending'&&state?.success&&isReadyStructuredKnowledgeJob(this.store,current,now()))this.store.save('actions',{...current,payload:{...state.data,phase:'pending-readback',tries:state.data.tries+1,runAfter:new Date(Date.now()+30_000).toISOString(),errorCode:'knowledge_processing_failed'},updatedAt:now()});
      }
    });
    try{await Promise.all(actors);}
    catch(error){controller.abort();await Promise.allSettled(actors);await Promise.allSettled([...this.activeHostActors]);throw error;}
    }finally{if(this.hostAbort===controller){this.hostAbort=undefined;this.hostPreferredTaskId=undefined;}}
    return {count:jobs.length,aborted:controller.signal.aborted};
  }

  async drainStructuredKnowledge(limit=4):Promise<number>{
    if(this.busy||this.stopping||this.pauseDepth>0)return 0;
    this.busy=true;
    try{this.store.reconcileVault();return (await this.drainHostJobs(limit)).count;}finally{this.busy=false;for(const resolve of this.idleWaiters.splice(0))resolve();}
  }

  /** Retain writer ownership until the current stage and its notification flush have settled. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.hostAbort?.abort();
    if (this.busy) await new Promise<void>(resolve => this.idleWaiters.push(resolve));
    await Promise.allSettled([...this.activeHostActors]);
  }
  async pause():Promise<()=>void>{this.pauseDepth++;this.hostAbort?.abort();if(this.busy)await new Promise<void>(resolve=>this.idleWaiters.push(resolve));await Promise.allSettled([...this.activeHostActors]);let resumed=false;return ()=>{if(!resumed){resumed=true;this.pauseDepth--;}};}

  async runUntilIdle(maxSteps = 100): Promise<void> {
    for (let step = 0; step < maxSteps; step++) {
      if(this.busy||this.stopping||this.pauseDepth>0)return;
      const ready = !!this.readyTask() || readyStructuredKnowledgeJobs(this.store,now(),1).length>0;
      if(!ready)return;
      await this.tick();
      if(!this.readyTask()&&!readyStructuredKnowledgeJobs(this.store,now(),1).length)return;
    }
    if (this.readyTask()||readyStructuredKnowledgeJobs(this.store,now(),1).length) throw new DomainError('The workbench step limit was reached; inspect the active task.', 'step_limit');
  }

  private async process(task: Task, project: Project): Promise<void|'preempted'> {
    if (task.stage === 'research') return this.performResearch(task, project);
    if (task.stage === 'delivery') return this.deliver(task, project);
    let context:FactualContext|undefined;
    if(this.repositoryKnowledgeReader&&(!this.canRun||this.canRun(project))){
      const controller=new AbortController();this.hostAbort=controller;this.hostPreferredTaskId=task.id;
      try{context=await prepareFactualContext(this.store,this.repositoryKnowledgeReader,task,AbortSignal.any([controller.signal,AbortSignal.timeout(30_000)]));}
      finally{if(this.hostAbort===controller){this.hostAbort=undefined;this.hostPreferredTaskId=undefined;}}
      if(controller.signal.aborted||this.stopping||this.pauseDepth>0)return 'preempted';
      this.current(task);
    }
    let input = this.input(task, project, task.stage,context);
    if (task.stage === 'plan') {
      const baselineSha = await this.writer.baseline(project); this.current(task);
      if (!baselineSha) throw new DomainError('The writer could not establish a repository baseline.', 'baseline_unavailable');
      const baselineFiles = this.writer.readBaseline ? await this.writer.readBaseline(project, baselineSha) : undefined;
      this.current(task);
      this.store.save('tasks', { ...this.task(task.id), baselineFiles });
      input = { ...this.input(task, project, task.stage,context), baselineSha, baselineFiles };
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
        const decision = decisionSchema.parse(output); const factualUse=this.validateDecision(task, decision, input);
        const snapshot = recordDecisionSnapshot(this.store, task, input, decision, factualUse);
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

  private input(task: Task, project: Project, role: Role, context?: FactualContext): WorkerInput {return this.store.readSnapshot(()=>{const live=this.store.get('projects',project.id);if(!live||digest(live)!==digest(project))throw new DomainError('Project state changed; retry.','stale_project_state',409);return this.inputBody(task,live,role,context);});}
  private inputBody(task: Task, project: Project, role: Role, context?: FactualContext): WorkerInput {
    const current = this.task(task.id); const source = this.store.get('sources', task.sourceId)!;
    const question = current.questionId ? this.store.get('questions', current.questionId) : undefined;
    const completedResearch = this.store.list('actions').find(a => a.taskId === task.id && a.kind === 'research' && a.status === 'completed' && a.payload.taskVersion === task.version && a.payload.sourceRevision === task.sourceRevision)?.payload.research as ResearchRecord | undefined;
    const activeCards = this.store.list('cards').filter(card=>card.sourceId===source.id).flatMap(card=>{const view=knowledgeReference(this.store,card,project);return view?[view]:[];});
    const relevant=this.store.searchCards(`${current.title}\n${current.description}`,project,30);
    const cards=[...new Map([...activeCards,...relevant].map(card=>[card.id,card])).values()].slice(0,30);
    const facts=cards.flatMap(card=>{const historical=card.factual?.eligible?[card.factual.fact]:[];const current=context?factualEligibility(this.store,card,project,{temporal:'current',contextId:context.id},context):undefined;return current?.eligible?[...historical,current.fact]:historical;});
    return { task: current, project, role, source, cards, facts, ...(context?{factualContext:context}:{}), ...(current.decision?{decisionInterpretation:decisionInterpretationFor(current)}:{}), rules: applicableRules(this.store, current), answer: question?.status === 'answered' ? question.answer?.text : undefined, research: question?.status === 'answered' ? question.research : completedResearch, plan: current.plan, artifact: current.artifact, receipt: current.receiptId ? this.store.get('receipts', current.receiptId) : undefined, baselineFiles: current.baselineFiles };
  }

  private validateDecision(task: Task, decision: ReturnType<typeof decisionSchema.parse>, input:WorkerInput): FactualUseView {
    const liveTask=this.store.get('tasks',task.id),liveSource=this.store.get('sources',task.sourceId),liveProject=this.store.get('projects',task.projectId);
    if(!liveTask||!liveSource||!liveProject||liveTask.id!==input.task.id||liveTask.version!==input.task.version||liveTask.sourceId!==input.task.sourceId||liveTask.sourceRevision!==input.task.sourceRevision||liveTask.title!==input.task.title||liveTask.description!==input.task.description||digest(liveSource)!==digest(input.source)||knowledgePolicyHash(liveProject)!==knowledgePolicyHash(input.project))throw new DomainError('The frozen decision input changed.','stale_frozen_input',409);
    if (decision.action === 'proceed' && !decision.citations.length) throw new DomainError('Proceed requires at least one current authorized source quotation or bound owner-answer quotation.', 'missing_evidence');
    const temporaryTask = this.store.get('sources', task.sourceId)?.retention === 'ephemeral';
    for (const citation of decision.citations) {
      const source = this.store.get('sources', citation.sourceId);
      if (source?.status !== 'active' || source.revision !== citation.revision || source.projectId !== task.projectId || source.domain !== task.domain || !source.content.includes(citation.quote) || source.locator !== citation.locator || !temporaryTask && source.retention === 'ephemeral') throw new DomainError('Decision cites unavailable, out-of-scope or temporary-only evidence.', 'invalid_citation', 403);
    }
    const rules = new Set(applicableRules(this.store, task).map(rule => rule.id));
    if (decision.ruleIds.some(id => !rules.has(id))) throw new DomainError('Decision cites a rule outside its current authorized scope.', 'invalid_rule', 403);
    const hasCitation=(citation:typeof decision.citations[number])=>decision.citations.some(item=>digest(item)===digest(citation));
    for(const statement of decision.grounds.statements){
      if(!hasCitation(statement.citation))throw new DomainError('A statement must cite authorized source words.','invalid_ground',403);
      if(statement.binding==='task-request'){
        if(statement.purpose!=='requirement'||statement.citation.sourceId!==task.sourceId||statement.citation.revision!==task.sourceRevision)throw new DomainError('Requirement does not bind the current task.','invalid_ground',403);
      }else if(statement.binding==='accepted-owner-answer'){
        const q=task.questionId?this.store.get('questions',task.questionId):undefined,project=this.store.get('projects',task.projectId);
        const answerSource=q?this.store.get('sources',stableId('owner-answer',q.id)):undefined;
        const answerCase=q?this.store.get('cases',stableId('decision-case',q.id)):undefined;
        const answerEvent=q?.answer?this.store.get('cursors',stableId('answer-event',task.projectId,task.domain,q.answer.eventId)):undefined;
        if(statement.purpose!=='requirement'||!q||q.status!=='answered'||q.taskId!==task.id||q.projectId!==task.projectId||q.domain!==task.domain||q.taskVersion+1!==task.version||!q.answer||q.answer.actorId!==q.ownerId||q.ownerId!==project?.ownerId||answerSource?.id!==statement.citation.sourceId||answerSource.kind!=='conversation'||answerSource.externalId!==`answer:${q.id}`||answerSource.authorId!==q.ownerId||answerSource.revision!==digest(q.answer.text)||answerSource.content!==q.answer.text||answerSource.locator!==`question:${q.id}@${q.version}`||answerEvent?.value!==digest({questionId:q.id,choice:q.answer.choice,words:q.answer.text})||!answerCase||answerCase.status!=='active'||answerCase.taskId!==task.id||answerCase.questionId!==q.id||answerCase.sourceId!==answerSource.id||answerCase.actorId!==q.ownerId||answerCase.originalWords!==q.answer.text)throw new DomainError('Requirement does not bind the accepted owner answer.','invalid_ground',403);
      }else if(statement.purpose!=='author-statement')throw new DomainError('A source statement cannot create a requirement.','invalid_ground',403);
    }
    if(decision.grounds.unresolved.some(item=>item.citation&&!hasCitation(item.citation)))throw new DomainError('An unresolved statement cites unavailable words.','invalid_ground',403);
    const facts=expandFactRefs(this.store,decision.grounds.facts,task,input.factualContext);
    if(facts.some(f=>!input.facts.some(original=>digest(original)===digest(f))))throw new DomainError('Fact was not in the frozen host input.','invalid_fact',403);
    if(!temporaryTask&&facts.some(f=>f.sourceRefs.some(ref=>this.store.get('sources',ref.id)?.retention==='ephemeral')))throw new DomainError('Temporary evidence cannot be persisted through this task.','invalid_fact',403);
    if(decision.action==='proceed'&&!decision.grounds.statements.length&&!facts.length)throw new DomainError('Proceed requires an authorized statement or fact.','missing_evidence');
    return {facts,statements:structuredClone(decision.grounds.statements),unresolved:structuredClone(decision.grounds.unresolved),interpretationLabel:'assistant-inference'};
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
    // Adapter and retained data are runtime values: inspect every element before matching policy.
    const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
    if (!receipt || typeof receipt !== 'object' || !nonempty(receipt.id) || !nonempty(receipt.taskId) || !nonempty(receipt.projectId) || !nonempty(receipt.domain) || !nonempty(receipt.repository) || !nonempty(receipt.path) || !nonempty(receipt.pullRequestUrl) || !nonempty(receipt.headSha) || !nonempty(receipt.mergeSha) || !nonempty(receipt.contentHash) || !nonempty(receipt.verifiedAt) || !Array.isArray(receipt.checks) || !receipt.checks.every(check => !!check && typeof check === 'object' && nonempty(check.name) && nonempty(check.conclusion) && nonempty(check.headSha) && Number.isInteger(check.appId) && nonempty(check.url))) throw new DomainError('The writer returned a malformed receipt.', 'invalid_receipt');
    const file = task.artifact?.files.find(f => f.path === project.prdPath);
    if (!receipt || !file || receipt.taskId !== task.id || receipt.projectId !== task.projectId || receipt.domain !== task.domain || receipt.repository !== project.repository || receipt.path !== project.prdPath || !receipt.mergeSha?.trim() || !receipt.headSha?.trim() || !receipt.id || !Number.isInteger(receipt.pullRequestNumber) || receipt.pullRequestNumber < 1 || !Number.isFinite(Date.parse(receipt.verifiedAt)) || receipt.contentHash !== digest(file.content)) throw new DomainError('The writer did not return a verified, matching merged-file receipt.', 'invalid_receipt');
    try { if (new URL(receipt.pullRequestUrl).protocol !== 'https:') throw new Error(); } catch { throw new DomainError('The writer did not provide a valid remote pull request URL.', 'invalid_receipt'); }
    if (!project.autoMerge || !project.trustedChecks.length || !project.trustedAppIds.length || !Array.isArray(receipt.checks) || project.trustedChecks.some(name => !receipt.checks.some(check => check.name === name && check.conclusion === 'success' && check.headSha === receipt.headSha && project.trustedAppIds.includes(check.appId) && !!check.url))) throw new DomainError('The merged head lacks every required trusted successful check.', 'invalid_receipt');
  }

  private feedbackContextAvailable(task:Task,source:import('./domain.js').SourceRevision,project:Project):boolean {
    if(!source.content||source.status!=='active'||source.id!==task.sourceId||source.revision!==task.sourceRevision||source.projectId!==task.projectId||source.domain!==task.domain||project.id!==task.projectId||project.domain!==task.domain||!task.plan||!task.artifact||!task.review||!task.receiptId)return false;
    const acceptedHash=this.store.get('cursors',stableId('source-hash',source.id))?.value;
    if(acceptedHash&&acceptedHash!==digest(source.content)||!executionPlanSchema.safeParse(task.plan).success||!artifactSchema.safeParse(task.artifact).success||!reviewSchema.safeParse(task.review).success)return false;
    const receipt=this.store.get('receipts',task.receiptId);if(!receipt)return false;
    try{this.validatePlan(task,project);this.validateArtifact(task,project,task.artifact);this.validateReview(task,task.review);this.validateReceipt(task,project,receipt);return task.review.verdict==='pass'&&this.testsPassed(task.plan.tests,task.artifact.tests)&&this.testsPassed(task.plan.tests,task.review.tests);}
    catch(error){if(error instanceof VaultSyncError||isKnowledgeSnapshotFailure(error))throw error;if(error instanceof DomainError)return false;throw error;}
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

  private readyTask(excludeId?:string,preferredId?:string): Task | undefined {
    if (this.stopping) return undefined;
    const attempts=this.store.list('attempts');
    return this.store.list('tasks').filter(task => {
      if (task.id===excludeId || preferredId!==undefined&&task.id!==preferredId || task.billingStop || stopped.has(task.status) || Date.parse(task.runAfter) > Date.now()) return false;
      const project = this.store.get('projects', task.projectId);
      const feedbackSource=task.stage==='feedback'?this.store.get('sources',task.sourceId):undefined;
      if(task.stage==='feedback'&&project&&(!feedbackSource||!this.feedbackContextAvailable(task,feedbackSource,project))){
        const error='Delivery completed, but feedback context expired; automatic recovery is unavailable.';
        if(task.status!=='blocked'||task.error!==error)this.store.save('tasks',{...task,status:'blocked',blockedFrom:'feedback',error,updatedAt:now()});
        return false;
      }
      if(roles.some(role=>task.stage===role)){
        const id=this.actionId(task),consumed=consumedStageResult(this.store,task,attempts);
        if(!this.localRetryOnce.has(id)&&(this.localHolds.has(id)||task.error==='knowledge_snapshot_unavailable'||consumed)){this.holdLocalTask(task);return false;}
      }
      if(task.stage==='knowledge_extract'){
        const source=this.store.get('sources',task.sourceId),action=source&&this.store.get('actions',structuredKnowledgeJobId(source));
        const job=action&&structuredIngestJobSchema.safeParse(action.payload);
        if(action&&!job?.success&&task.status==='blocked')return false;
        if(action?.status==='pending'&&job?.success&&!isReadyStructuredKnowledgeJob(this.store,action,now()))return false;
        if(action?.status==='completed'&&job?.success&&job.data.phase==='invalid'&&task.status==='blocked')return false;
      }
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
  private beginAction(task: Task): void {
    const id=this.actionId(task),existing=this.store.get('actions',id);
    if(!existing||existing.status==='completed')this.store.transaction(()=>{
      const live=this.store.get('actions',id);if(live&&live.status!=='completed')return;
      const current=this.task(task.id),priorSucceededAttemptIds=this.store.list('attempts').filter(attempt=>attempt.taskId===task.id&&attempt.projectId===task.projectId&&attempt.domain===task.domain&&attempt.taskVersion===task.version&&attempt.role===task.stage&&attempt.status==='succeeded').map(attempt=>attempt.id);
      this.store.save('actions',{id,projectId:task.projectId,domain:task.domain,taskId:task.id,kind:task.stage,status:'pending',payload:{taskVersion:task.version,sourceRevision:task.sourceRevision,attemptsBefore:current.attempts,priorSucceededAttemptIds},updatedAt:now()});
    });
  }
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
