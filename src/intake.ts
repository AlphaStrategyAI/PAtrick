import { DomainError, digest, now, stableId, type AppConfig, type DecisionSnapshot, type Entities, type SourceRevision, type Table, type Task } from './domain.js';
import { sourceExpansionPaused } from './evaluation.js';
import type { Store } from './store.js';
import { consumedStageResult, enqueueStructuredKnowledge, isStructuredKnowledgeCard, structuredIngestJobSchema, structuredKnowledgeJobId } from './knowledge-jobs.js';
import { canonicalExperiencePayloadSchema, factualContextTombstone, factualContextTombstonePayloadSchema, knowledgeActionDependencies, knowledgeActionSourceRefs, knowledgeSourceRefs, wellFormedParentSources } from './knowledge-records.js';

export interface IngestInput {
  projectId: string; kind?: SourceRevision['kind']; externalId: string; title: string; content: string;
  locator?: string; authorId?: string; retention?: SourceRevision['retention']; revision?: string;
  purpose?: 'task' | 'reference'; status?: 'active' | 'withdrawn'; subscribedTaskId?: string;
}
const finished = new Set(['delivered', 'completed', 'archived', 'cancelled']);

/** Preserve no evidence content or authority when a normalization link is sanitized. */
export function normalizationTombstone(store:Store,action:Entities['actions'],invalid:Set<string>,base:Record<string,unknown>):Record<string,unknown> {
  if(action.kind==='decision.case-version'){
    const value=action.payload.case as {id?:unknown;version?:unknown;hash?:unknown}|undefined;
    if(value&&typeof value.id==='string'&&Number.isSafeInteger(value.version)&&typeof value.hash==='string'&&/^[a-f0-9]{64}$/.test(value.hash))return {retracted:true,caseId:value.id,version:value.version,hash:value.hash};
    if(action.payload.retracted===true&&typeof action.payload.caseId==='string'&&Number.isSafeInteger(action.payload.version)&&typeof action.payload.hash==='string'&&/^[a-f0-9]{64}$/.test(action.payload.hash))return action.payload;
  }
  if(action.kind==='decision.rule-version'){
    const history=action.payload.history as {id?:unknown;ruleId?:unknown;version?:unknown;ruleHash?:unknown;confirmation?:{hash?:unknown}}|undefined;
    if(history&&history.id===action.id&&typeof history.ruleId==='string'&&Number.isSafeInteger(history.version)&&typeof history.ruleHash==='string'&&/^[a-f0-9]{64}$/.test(history.ruleHash)&&typeof history.confirmation?.hash==='string'&&/^[a-f0-9]{64}$/.test(history.confirmation.hash)&&action.id===stableId('decision.rule-version',history.ruleId,history.version,history.confirmation.hash))return {retracted:true,ruleId:history.ruleId,version:history.version,hash:history.ruleHash,caseHash:history.confirmation.hash};
    if(action.payload.retracted===true&&typeof action.payload.ruleId==='string'&&Number.isSafeInteger(action.payload.version)&&typeof action.payload.hash==='string'&&/^[a-f0-9]{64}$/.test(action.payload.hash)&&typeof action.payload.caseHash==='string'&&/^[a-f0-9]{64}$/.test(action.payload.caseHash))return action.payload;
  }
  if(action.kind!=='experience.evidence-link'||action.status!=='completed')return base;
  const parsed=canonicalExperiencePayloadSchema.safeParse(action.payload);if(!parsed.success)return base;
  const association=parsed.data.association,binding=association.versionBinding,card=store.get('cards',association.cardId);
  if(!binding||binding.reported!=='unknown'||!card||card.status!=='active'||card.expiresAt&&!(Date.parse(card.expiresAt)>Date.now())||card.projectId!==action.projectId||card.domain!==action.domain||card.sourceId!==association.sourceId||card.sourceRevision!==association.sourceRevision||invalid.has(card.sourceId)||card.experience?.codeVersion!==binding.observedRevision||action.id!==stableId('experience-evidence-link',association)||parsed.data.digest!==digest(association)||parsed.data.sourceRefs.some(ref=>!store.get('sources',ref.id)))return base;
  const refs=knowledgeSourceRefs(store,card.sourceId,card);if(!refs||refs.some(ref=>invalid.has(ref.id)))return base;
  return {...base,sourceRefs:refs,normalizationOrigin:{cardId:card.id,candidateHash:association.candidateHash,sourceId:card.sourceId,sourceRevision:card.sourceRevision,reported:'unknown',observedRevision:binding.observedRevision}};
}

/** Historical snapshots are negative dependencies only when their host identity and references are coherent. */
export function historicalSnapshot(store: Store, action: Entities['actions'], scope: { projectId: string; domain: string }): DecisionSnapshot | undefined {
  if (action.projectId !== scope.projectId || action.domain !== scope.domain || action.kind !== 'decision.snapshot' || action.status !== 'completed' || typeof action.taskId !== 'string' || !action.taskId.trim() || typeof action.id !== 'string' || !action.id.trim()) return;
  const snapshot = action.payload?.snapshot as Partial<DecisionSnapshot> | undefined;
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.id !== action.id || snapshot.projectId !== scope.projectId || snapshot.domain !== scope.domain || snapshot.taskId !== action.taskId || !Number.isSafeInteger(snapshot.taskVersion) || snapshot.taskVersion! < 1 || typeof snapshot.attemptId !== 'string' || !snapshot.attemptId.trim() || action.id !== stableId('decision-snapshot', action.taskId, snapshot.taskVersion, snapshot.attemptId) || !Array.isArray(snapshot.sourceRefs)) return;
  const task = store.get('tasks', action.taskId);
  if (!task || task.projectId !== scope.projectId || task.domain !== scope.domain || snapshot.taskVersion! > task.version || snapshot.sourceId !== task.sourceId || snapshot.sourceRevision !== task.sourceRevision) return;
  if (!snapshot.sourceRefs.every(ref => ref && typeof ref === 'object' && typeof ref.id === 'string' && !!ref.id.trim() && typeof ref.revision === 'string' && !!ref.revision.trim())) return;
  return snapshot as DecisionSnapshot;
}

/** Revoke evidence before any newly received revision can be scheduled. */
export function invalidateSource(store: Store, sourceId: string, status: 'superseded' | 'withdrawn'): void {
  const source = store.get('sources', sourceId);
  if (!source) return;
  if (source.status === 'superseded' && status === 'superseded') return;
  if (source.status === 'withdrawn') { if (status === 'withdrawn') redactWithdrawnEvidence(store, sourceId); return; }
  const scope = { projectId: source.projectId, domain: source.domain }; const changed = now();
  if (status === 'withdrawn') {
    redactWithdrawnEvidence(store, sourceId);
    store.save('events', { ...scope, id: stableId('source-invalidated', sourceId, status), type: 'source.withdrawn', message: '来源已撤回。相关知识和规则已停用。', createdAt: changed, data: { sourceId } });
    return;
  }
  const actions=store.list('actions');
  const dependentCards=new Set(actions.filter(action=>action.kind==='knowledge.structured-ingest'&&knowledgeActionSourceRefs(action).some(ref=>ref.id===sourceId)).map(action=>action.payload.sourceId).filter((id):id is string=>typeof id==='string'));
  const contexts=new Map(actions.flatMap(action=>{
    const payload=factualContextTombstone(store,action,sourceId);return payload?[[action.id,payload] as const]:[];
  }));
  store.save('sources', { ...source, status });
  for (const action of store.list('actions')) if (['knowledge.structured-ingest','knowledge.host-observation','knowledge.evidence-link','knowledge.factual-context','experience.test-observation','experience.evidence-link','decision.case-version','decision.owner-origin','decision.case-alias','decision.rule-version'].includes(action.kind) && knowledgeActionSourceRefs(action).some(ref => ref.id === sourceId)) {
    // A previously sanitized context stays tied to its first invalidation.
    if(action.kind==='knowledge.factual-context'&&factualContextTombstonePayloadSchema.safeParse(action.payload).success&&!knowledgeActionDependencies(action,store).unresolved)continue;
    const payload=contexts.get(action.id)??normalizationTombstone(store,action,new Set([sourceId]),{ phase: 'invalid', errorCode: 'source_invalidated', retracted: true, sourceIds: [sourceId] });
    store.save('actions', { ...action, status: 'completed', payload, updatedAt: changed });
  }
  // Copies retain their originating revision, including secondary/historical Vault edits.
  for (const child of store.list('sources')) if (child.projectId === source.projectId && child.domain === source.domain && store.sourceDependsOnId(child,sourceId)) invalidateSource(store, child.id, status);
  const invalidRules = new Set<string>();
  for (const card of store.list('cards')) {
    if(isStructuredKnowledgeCard(card)&&(card.sourceId===sourceId||dependentCards.has(card.sourceId)))store.save('cards',{...card,status:'withdrawn',title:'[withdrawn]',body:'',quote:'',aliases:[],experience:undefined,claim:undefined,pendingClaim:undefined,locator:`withdrawn:${card.sourceId}`});
    else if(card.sourceId===sourceId)store.save('cards',{...card,status:'withdrawn',body:'',quote:''});
  }
  for (const rule of store.list('rules')) if (rule.citations.some(c => c.sourceId === sourceId)) {
    invalidRules.add(rule.id);
    store.save('rules', { ...rule, status: 'suspended' });
  }
  const invalidCaseTasks = new Set<string>();
  for (const decisionCase of store.list('cases')) if (decisionCase.sourceId === sourceId || decisionCase.decisionSnapshot?.sourceRefs.some(ref => ref.id === sourceId) || decisionCase.ruleIds.some(id => invalidRules.has(id))) {
    invalidCaseTasks.add(decisionCase.taskId);
    store.save('cases', { ...decisionCase, status: 'withdrawn', originalWords: '[withdrawn]' });
    const question = store.get('questions', decisionCase.questionId);
    if (question) store.save('questions', { ...question, status: 'stale' });
  }
  // A historical citation can still underlie retained research. It is a negative
  // invalidation dependency only, never evidence authorizing current work.
  const historicalTasks = new Set<string>();
  for (const action of store.list('actions')) {
    const snapshot = historicalSnapshot(store, action, scope);
    if (snapshot?.sourceRefs.some(ref => ref.id === sourceId)) historicalTasks.add(action.taskId!);
  }
  for (const task of store.list('tasks')) {
    if (task.projectId !== scope.projectId || task.domain !== scope.domain || finished.has(task.status)) continue;
    const direct = task.sourceId === sourceId;
    const depends = invalidCaseTasks.has(task.id) || historicalTasks.has(task.id) || task.decision?.citations.some(c => c.sourceId === sourceId) || task.decision?.ruleIds.some(id => invalidRules.has(id));
    if (!direct && !depends) continue;
    for (const question of store.list('questions')) if (question.taskId === task.id && question.status === 'open') store.save('questions', { ...question, status: 'stale' });
    for (const attempt of store.list('attempts')) if (attempt.taskId === task.id && attempt.status === 'running') store.save('attempts', { ...attempt, status: 'stale', finishedAt: changed, error: 'Source changed during execution.' });
    for (const action of store.list('actions')) if (action.taskId === task.id && action.status === 'pending') store.save('actions', { ...action, status: 'completed', payload: { invalidated: true, reason: status }, updatedAt: changed });
    for (const message of store.list('outbox')) if (message.taskId === task.id && message.status === 'pending') store.save('outbox', { ...message, status: 'sent', text: '[invalidated]', remoteId: 'invalidated' });
    if(task.stage==='feedback'&&task.receiptId){
      // The source change revokes further work, but cannot undo a completed delivery.
      store.save('tasks',{...task,status:'cancelled',updatedAt:changed,runAfter:changed,decision:undefined,decisionSnapshotId:undefined,plan:undefined,artifact:undefined,review:undefined,questionId:undefined,error:'delivery_kept'});
    }else{
      store.save('tasks', { ...task, version: task.version + 1, status: direct ? 'cancelled' : 'deciding', stage: 'decide', updatedAt: changed, runAfter: changed, decision: undefined, decisionSnapshotId: undefined, plan: undefined, artifact: undefined, review: undefined, questionId: undefined, receiptId: undefined, error: 'source_superseded' });
    }
  }
  store.save('events', { ...scope, id: stableId('source-invalidated', sourceId, status), type: `source.${status}`, message: status === 'superseded' ? '资料有了新修订。旧修订停止引用。' : '来源已撤回。相关知识和规则已停用。', createdAt: changed, data: { sourceId } });
}

/** Retraction removes readable derivatives too; a historical delivery keeps only its receipt audit. */
export function redactWithdrawnEvidence(store: Store, sourceId: string): void {
  const origin = store.get('sources', sourceId); if (!origin) return;
  const scoped = (entity: { projectId: string; domain: string }) => entity.projectId === origin.projectId && entity.domain === origin.domain;
  const sources = store.list('sources').filter(scoped), tasks = store.list('tasks').filter(scoped), rules = store.list('rules').filter(scoped), cases = store.list('cases').filter(scoped), questions = store.list('questions').filter(scoped), cards = store.list('cards').filter(scoped);
  const historicalJudgments = store.list('actions').filter(action => scoped(action) && action.kind === 'decision.snapshot');
  const sourceIds = new Set([sourceId]), taskIds = new Set<string>(), ruleIds = new Set<string>(), caseIds = new Set<string>();
  let previousSize = -1;
  while (previousSize !== sourceIds.size + taskIds.size + ruleIds.size + caseIds.size) {
    previousSize = sourceIds.size + taskIds.size + ruleIds.size + caseIds.size;
    for (const child of sources) if ([...sourceIds].some(id=>store.sourceDependsOnId(child,id))) sourceIds.add(child.id);
    for (const rule of rules) if (rule.citations.some(c => sourceIds.has(c.sourceId))) ruleIds.add(rule.id);
    for (const c of cases) if (sourceIds.has(c.sourceId) || c.decisionSnapshot?.sourceRefs.some(ref => sourceIds.has(ref.id)) || c.ruleIds.some(id => ruleIds.has(id)) || taskIds.has(c.taskId)) { caseIds.add(c.id); taskIds.add(c.taskId); sourceIds.add(c.sourceId); }
    for (const task of tasks) if (sourceIds.has(task.sourceId) || task.decision?.citations.some(c => sourceIds.has(c.sourceId)) || task.decision?.ruleIds.some(id => ruleIds.has(id))) taskIds.add(task.id);
    for (const action of historicalJudgments) {
      const snapshot = historicalSnapshot(store, action, origin);
      if (snapshot && (sourceIds.has(snapshot.sourceId) || snapshot.sourceRefs.some(ref => sourceIds.has(ref.id)))) taskIds.add(snapshot.taskId);
    }
    for (const q of questions) if (taskIds.has(q.taskId)) { const id = stableId('owner-answer', q.id); if (sources.some(s => s.id === id)) sourceIds.add(id); }
  }
  const dependentCards=new Set(store.list('actions').filter(action=>scoped(action)&&action.kind==='knowledge.structured-ingest'&&knowledgeActionSourceRefs(action).some(ref=>sourceIds.has(ref.id))).map(action=>action.payload.sourceId).filter((id):id is string=>typeof id==='string'));
  const cardIds = new Set(cards.filter(c => sourceIds.has(c.sourceId)||dependentCards.has(c.sourceId)&&isStructuredKnowledgeCard(c)).map(c => c.id));
  const ids = new Set([...sourceIds, ...taskIds, ...ruleIds, ...caseIds, ...cardIds, ...questions.filter(q => taskIds.has(q.taskId)).map(q => q.id)]);
  const fragments = [...sources.filter(s => sourceIds.has(s.id)).flatMap(s => [s.content, s.title]), ...cards.filter(c => cardIds.has(c.id)).flatMap(c => [c.body, c.quote, c.title]), ...rules.filter(r => ruleIds.has(r.id)).flatMap(r => [r.statement, r.title])].filter(text => text.length >= 8);
  const refers = (value: unknown): boolean => typeof value === 'string' ? ids.has(value) : Array.isArray(value) ? value.some(refers) : !!value && typeof value === 'object' && Object.values(value).some(refers);
  const mentions = (value: unknown): boolean => typeof value === 'string' ? fragments.some(fragment => value.includes(fragment)) : Array.isArray(value) ? value.some(mentions) : !!value && typeof value === 'object' && Object.values(value).some(mentions);
  const write = <K extends Table>(table: K, entity: Entities[K]) => { if (JSON.stringify(store.get(table, entity.id)) !== JSON.stringify(entity)) store.save(table, entity); };
  // Preserve only independently authorized normalization origins before the
  // revoked source revisions move their old links into temporary storage.
  // Other action sanitation keeps its original order, after card redaction.
  for(const action of store.list('actions'))if(scoped(action)&&action.kind==='experience.evidence-link'&&knowledgeActionDependencies(action).refs.some(ref=>sourceIds.has(ref.id))){
    const payload=normalizationTombstone(store,action,sourceIds,{retracted:true,sourceIds:[...sourceIds]});
    if(payload.normalizationOrigin)write('actions',{...action,status:'completed',payload});
  }
  for (const source of sources) if (sourceIds.has(source.id)) write('sources', { ...source, externalId:store.auditTemporaryRevision(source.externalId),authorId:store.auditTemporaryRevision(source.authorId),revision:store.auditTemporaryRevision(source.revision),...(source.parentSources!==undefined?{parentSources:wellFormedParentSources(source.parentSources)?source.parentSources!.map(ref=>({id:ref.id,revision:sourceIds.has(ref.id)?store.auditTemporaryRevision(ref.revision):ref.revision})):[{id:'',revision:''}]}:{}),status: 'withdrawn', title: '[withdrawn]', content: '', locator: `withdrawn:${source.id}` });
  for (const card of cards) if (cardIds.has(card.id)) write('cards', { ...card, sourceRevision:sourceIds.has(card.sourceId)?store.auditTemporaryRevision(card.sourceRevision):card.sourceRevision,title: '[withdrawn]', body: '', quote: '', aliases: [], experience:undefined,claim:undefined,pendingClaim:undefined,locator: `withdrawn:${card.sourceId}`, status: 'withdrawn' });
  for (const rule of rules) if (ruleIds.has(rule.id)) write('rules', { ...rule, title: '[withdrawn]', statement: '[Evidence withdrawn]', conditions: '[withdrawn]', exceptions: '[withdrawn]', status: 'suspended', citations: rule.citations.map(c => ({ ...c, revision:sourceIds.has(c.sourceId)?store.auditTemporaryRevision(c.revision):c.revision,quote: '[withdrawn]', locator: `withdrawn:${c.sourceId}` })) });
  for (const c of cases) if (caseIds.has(c.id)) write('cases', { ...c, originalWords: '[withdrawn]', rationale: '[withdrawn]', alternatives: [], outcome: undefined, decisionSnapshot: undefined, outcomes: undefined, status: 'withdrawn' });
  const option = { label: '[withdrawn]', description: '[withdrawn]', rationale: '[withdrawn]', tradeoff: '[withdrawn]', evidenceUrls: [] };
  for (const q of questions) if (taskIds.has(q.taskId)) write('questions', { ...q, title: '[withdrawn]', context: '', options: { A: option, B: option }, research: { queries: [], summary: '', gaps: [] }, answer: undefined, status: 'stale' });
  for (const task of tasks) if (taskIds.has(task.id)) {
    const terminal = finished.has(task.status);
    const completedDelivery = task.stage === 'feedback' && !!task.receiptId;
    const status = terminal ? task.status : completedDelivery || sourceIds.has(task.sourceId) ? 'cancelled' : 'deciding';
    const alreadyRedacted = task.error === 'evidence_withdrawn' && !task.description && !task.decision && !task.plan && !task.artifact && !task.review && !task.feedback;
    write('tasks', { ...task, sourceRevision:sourceIds.has(task.sourceId)?store.auditTemporaryRevision(task.sourceRevision):task.sourceRevision,title: '[Evidence withdrawn]', description: '', decision: undefined, decisionSnapshotId: undefined, plan: undefined, baselineFiles: undefined, artifact: undefined, review: undefined, feedback: undefined, error: 'evidence_withdrawn', status, ...(terminal || completedDelivery ? {} : { version: alreadyRedacted ? task.version : task.version + 1, stage: 'decide' as const, questionId: undefined, updatedAt: alreadyRedacted ? task.updatedAt : now(), runAfter: alreadyRedacted ? task.runAfter : now() }) });
  }
  for (const event of store.list('events')) if (scoped(event) && (event.taskId && taskIds.has(event.taskId) || refers(event.data) || mentions(event.data) || mentions(event.message))) write('events', { ...event, message: '证据已收回。', data: { retracted: true } });
  for (const attempt of store.list('attempts')) if (taskIds.has(attempt.taskId)) write('attempts', { ...attempt, error: undefined, ...(attempt.status === 'running' ? { status: 'stale' as const, finishedAt: now() } : {}) });
  const outboxIds = new Set<string>();
  for (const action of store.list('actions')) if (scoped(action) && (()=>{
    if(action.kind==='experience.evidence-link'){
      const dependencies=knowledgeActionDependencies(action);
      if(!dependencies.unresolved)return dependencies.refs.some(ref=>sourceIds.has(ref.id));
    }
    if(['knowledge.structured-ingest','knowledge.host-observation','knowledge.evidence-link','knowledge.factual-context','experience.test-observation'].includes(action.kind) &&
      knowledgeActionDependencies(action,store).refs.some(ref=>sourceIds.has(ref.id)))return true;
    return !!(action.taskId && taskIds.has(action.taskId) || refers(action.payload) || mentions(action.payload));
  })()) {
    if (typeof action.payload.outboxId === 'string') outboxIds.add(action.payload.outboxId);
    const payload=normalizationTombstone(store,action,sourceIds,{ retracted: true, sourceIds: [...sourceIds], ...(typeof action.payload.receiptId === 'string' ? { receiptId: action.payload.receiptId } : {}), ...(typeof action.payload.remoteId === 'string' ? { remoteId: action.payload.remoteId } : {}) });
    write('actions', { ...action, status: 'completed', payload });
  }
  for (const message of store.list('outbox')) if (scoped(message) && (message.taskId && taskIds.has(message.taskId) || message.sourceIds?.some(id => sourceIds.has(id)) || outboxIds.has(message.id) || mentions(message.text))) write('outbox', { ...message, text: '[Evidence retracted]', status: 'sent', remoteId: message.remoteId ?? 'invalidated' });
}

export function withdrawSource(store: Store, sourceId: string): void { store.transaction(() => invalidateSource(store, sourceId, 'withdrawn')); }

export function ingestSource(store: Store, config: Pick<AppConfig, 'projects' | 'billingBoundary'>, input: IngestInput, parentSources?: SourceRevision['parentSources']): Task | undefined {
  const billingBoundary = config.billingBoundary === undefined ? 'metered-only' : config.billingBoundary;
  if (billingBoundary !== 'included-only' && billingBoundary !== 'metered-only') throw new DomainError('Invalid host billing boundary.', 'billing_policy_invalid');
  const project = store.get('projects', input.projectId) ?? config.projects.find(p => p.id === input.projectId);
  if (!project) throw new DomainError('Unknown project.', 'unknown_project', 404);
  if (!input.externalId?.trim() || !input.title?.trim() || typeof input.content !== 'string' || input.content.length > 2_000_000) throw new DomainError('A source identifier, title and bounded text are required.');
  const subscribed = input.subscribedTaskId ? store.get('tasks', input.subscribedTaskId) : undefined;
  if (input.subscribedTaskId && (!subscribed || subscribed.projectId !== project.id || subscribed.domain !== project.domain)) throw new DomainError('The subscribed task is not in this project.', 'unknown_task', 404);
  const carrySubscription = !!subscribed && subscribed.kind !== 'reference_knowledge' && !finished.has(subscribed.status) && !subscribed.receiptId && subscribed.stage !== 'feedback';
  const purpose = input.subscribedTaskId && !carrySubscription ? 'reference' : input.purpose ?? 'task';
  if (!['task', 'reference'].includes(purpose)) throw new DomainError('Unknown source purpose.');
  const kind = input.kind ?? 'manual';
  if (!['file', 'feishu', 'github', 'gitlab', 'conversation', 'manual', 'reading', 'email'].includes(kind)) throw new DomainError('Unknown source kind.');
  const scope = { projectId: project.id, domain: project.domain };
  return store.transaction(() => {
    if (!store.get('projects', project.id)) store.save('projects', project);
    if(parentSources?.some(ref=>{const parent=store.get('sources',ref.id);return parent&&parent.status!=='active';}))throw new DomainError('A source dependency is no longer active.','stale_source',409);
    const previous = store.list('sources').filter(s => s.projectId === project.id && s.domain === project.domain && s.kind === kind && store.sourceExternalIdMatches(s,input.externalId) && s.status === 'active');
    if (input.status === 'withdrawn') { for (const s of previous) invalidateSource(store, s.id, 'withdrawn'); return undefined; }
    const revision = input.revision ?? digest(input.content);
    if (!revision.trim()) throw new DomainError('A source revision is required.');
    const id = stableId('source', scope, kind, input.externalId, revision);
    const existing = store.get('sources', id);
    const contentHash = digest(input.content);
    const hashId = stableId('source-hash', id);
    const knownHash = store.get('cursors', hashId)?.value;
    if (existing) {
      if ((existing.purpose ?? 'task') !== purpose) throw new DomainError('This source revision has a different purpose.', 'purpose_conflict', 409);
      if (knownHash && knownHash !== contentHash) throw new DomainError('This source revision already has different content.', 'revision_conflict', 409);
      if (existing.status !== 'active') throw new DomainError('A revoked source revision cannot be reused. Send a new revision.', 'revoked_revision', 409);
      if(existing.content){
        const identity={externalId:input.externalId,revision,authorId:input.authorId??'',locator:input.locator??`${kind}:${input.externalId}`};
        if(existing.externalId!==identity.externalId||existing.revision!==identity.revision||existing.authorId!==identity.authorId||existing.locator!==identity.locator||
          parentSources!==undefined&&(store.sourceHasOpaqueIdentity(existing)?!store.sourceIdentityMatches(existing,identity,parentSources):digest(existing.parentSources??[])!==digest(parentSources)))throw new DomainError('This source revision already has different identity metadata.','revision_conflict',409);
      }
      const task = store.list('tasks').find(t => t.sourceId === id && (purpose === 'reference' ? t.kind === 'reference_knowledge' : t.kind !== 'reference_knowledge'));
      if (!existing.content && (existing.retention === 'ephemeral' || store.sourceHasOpaqueIdentity(existing) || existing.title==='Temporary source')) {
        const locator=input.locator??`${kind}:${input.externalId}`,authorId=input.authorId??'';
        if(!store.sourceIdentityMatches(existing,{externalId:input.externalId,revision,authorId,locator},parentSources))throw new DomainError('This source revision has unavailable or different identity metadata.','revision_conflict',409);
        const restored = { ...existing, externalId:input.externalId,authorId,revision, title: input.title, content: input.content, locator, ...(parentSources?{parentSources}:{}) };
        store.save('sources', restored);
        enqueueStructuredKnowledge(store, store.get('sources',id)!);
        if(task?.kind==='reference_knowledge'){
          const restoredTask:Task={...task,sourceRevision:revision,title:input.title,description:''};
          if(task.status==='completed'&&!task.billingStop){store.save('tasks',{...restoredTask,version:task.version+1,status:'queued',error:undefined,runAfter:now(),updatedAt:now()});return undefined;}
          if(finished.has(task.status)){store.save('tasks',restoredTask);return undefined;}
          const consumed=consumedStageResult(store,restoredTask);
          store.save('tasks',{...restoredTask,...(task.billingStop?{}:consumed?{status:'blocked' as const,error:'knowledge_snapshot_unavailable'}:{status:'queued' as const,error:undefined,runAfter:now()}),updatedAt:now()});
          return undefined;
        }
        if (task && !finished.has(task.status)) {
          const restoredTask={...task,sourceRevision:revision};
          if(task.stage==='feedback'){
            const held:Task={...restoredTask,title:input.title,status:'blocked',blockedFrom:'feedback',error:'Delivery completed, but feedback context expired; automatic recovery is unavailable.',updatedAt:now()};
            store.save('tasks',held);return held;
          }
          const action=store.get('actions',structuredKnowledgeJobId(restored)),job=action&&structuredIngestJobSchema.safeParse(action.payload);
          const heldRead=action?.status==='pending'&&job?.success&&['knowledge_read_inflight','knowledge_snapshot_unavailable'].includes(job.data.errorCode??'');
          if(heldRead||consumedStageResult(store,restoredTask)){
            const held:Task={...restoredTask,title:input.title,status:'blocked',error:'knowledge_snapshot_unavailable',updatedAt:now()};
            store.save('tasks',held);return held;
          }
          for (const question of store.list('questions')) if (question.taskId === task.id) store.save('questions', { ...question, status: 'stale' });
          const reconstructed: Task = { ...task, sourceRevision:revision,title: input.title, version: task.version + 1, status: 'queued', stage: 'knowledge_extract', runAfter: now(), updatedAt: now(), repairCount: 0, decision: undefined, plan: undefined, artifact: undefined, review: undefined, questionId: undefined, receiptId: undefined, feedback: undefined, baselineFiles: undefined, error: undefined };
          store.save('tasks', reconstructed); return reconstructed;
        }
      }
      enqueueStructuredKnowledge(store, store.get('sources', id)!);
      return purpose === 'reference' ? undefined : task;
    }
    const githubAlreadyUsed = kind === 'github' && store.list('sources').some(source => source.projectId === scope.projectId && source.domain === scope.domain && source.kind === 'github');
    if (kind === 'github' && !githubAlreadyUsed && sourceExpansionPaused(store, scope)) throw new DomainError('Source expansion is paused after two measured weeks over 60 maintenance minutes. Keep the current product source and repair the slowest recorded step before adding GitHub.', 'source_expansion_paused', 409);
    const prior = previous.length === 1 ? previous[0] : undefined;
    const carried = prior && prior.retention !== 'ephemeral' ? store.list('tasks').find(task => task.sourceId === prior.id && task.kind !== 'reference_knowledge' && !finished.has(task.status) && !task.receiptId && task.stage !== 'feedback') : undefined;
    for (const old of previous) invalidateSource(store, old.id, 'superseded');
    const createdAt = now();
    const source: SourceRevision = { ...scope, id, purpose, ...(parentSources?.length ? { parentSources } : {}), kind, externalId: input.externalId, revision, title: input.title, content: input.content, locator: input.locator ?? `${kind}:${input.externalId}`, authorId: input.authorId ?? '', retention: input.retention ?? 'permanent', status: 'active', createdAt };
    store.save('sources', source);
    store.save('cursors', { ...scope, id: hashId, value: contentHash, updatedAt: createdAt });
    if (input.subscribedTaskId) {
      const current = store.get('tasks', input.subscribedTaskId)!;
      if (purpose === 'reference') {
        store.save('events', { ...scope, id: stableId('ingest', id), taskId: current.id, type: 'discussion.note', message: '这条讨论有了新消息。原任务已经结束，不会另开一件。', createdAt, data: { sourceId: id, revision } });
        return undefined;
      }
      for (const question of store.list('questions')) if (question.taskId === current.id && question.status === 'open') store.save('questions', { ...question, status: 'stale' });
      const alreadyRejudged = !!subscribed && current.version > subscribed.version && current.error === 'source_superseded';
      const woken: Task = { ...current, sourceId: id, sourceRevision: revision, title: input.title, description: input.content, version: alreadyRejudged ? current.version : current.version + 1, status: 'queued', stage: 'knowledge_extract', updatedAt: createdAt, runAfter: createdAt, repairCount: 0, decision: undefined, decisionSnapshotId: undefined, plan: undefined, artifact: undefined, review: undefined, questionId: undefined, feedback: undefined, baselineFiles: undefined, blockedFrom: undefined, error: undefined };
      store.save('tasks', woken);
      store.save('events', { ...scope, id: stableId('ingest', id), taskId: woken.id, type: 'discussion.continued', message: previous.length ? '这条讨论有了新修订。原任务重新处理一次。' : '这条讨论有了新消息。原任务继续处理一次。', createdAt, data: { sourceId: id, revision } });
      enqueueStructuredKnowledge(store, source);
      return woken;
    }
    enqueueStructuredKnowledge(store, source);
    if (purpose === 'reference') {
      store.save('events', { ...scope, id: stableId('ingest', id), type: 'source.received', message: '已收下这份引用资料。它不启动执行任务。', createdAt, data: { sourceId: id, revision:store.sourceRequiresTemporaryRetention(source)?store.auditTemporaryRevision(revision):revision, retention: source.retention, purpose } });
      return undefined;
    }
    if (carried) {
      const current = store.get('tasks', carried.id)!;
      const woken: Task = { ...current, sourceId: id, sourceRevision: revision, title: input.title, description: input.content, status: 'queued', stage: 'knowledge_extract', updatedAt: createdAt, runAfter: createdAt, repairCount: 0, decision: undefined, decisionSnapshotId: undefined, plan: undefined, artifact: undefined, review: undefined, questionId: undefined, feedback: undefined, baselineFiles: undefined, blockedFrom: undefined, error: undefined };
      store.save('tasks', woken);
      store.save('events', { ...scope, id: stableId('ingest', id), taskId: woken.id, type: 'source.updated', message: '资料有了新修订。原任务重新处理一次。', createdAt, data: { sourceId: id, revision, retention: source.retention } });
      return woken;
    }
    const task: Task = { ...scope, billingBoundary, id: stableId('task', id), sourceId: id, sourceRevision: revision, title: input.title, description: source.retention === 'ephemeral' ? '' : input.content, status: 'queued', version: 1, stage: 'knowledge_extract', createdAt, updatedAt: createdAt, runAfter: createdAt, attempts: 0, repairCount: 0, budgetUsd: project.budgetUsd, spentUsd: 0 };
    store.save('tasks', task);
    store.save('events', { ...scope, id: stableId('ingest', id), taskId: task.id, type: 'source.received', message: '已收下这份资料，并开始处理。', createdAt, data: { sourceId: id, revision, retention: source.retention } });
    return task;
  });
}
