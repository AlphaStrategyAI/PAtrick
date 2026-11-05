import { DomainError, digest, now, stableId, type AppConfig, type DecisionSnapshot, type Entities, type SourceRevision, type Table, type Task } from './domain.js';
import type { Store } from './store.js';
import { enqueueStructuredKnowledge, isStructuredKnowledgeCard } from './knowledge-jobs.js';
import { knowledgeActionSourceRefs } from './knowledge-records.js';

export interface IngestInput {
  projectId: string; kind?: SourceRevision['kind']; externalId: string; title: string; content: string;
  locator?: string; authorId?: string; retention?: SourceRevision['retention']; revision?: string;
  purpose?: 'task' | 'reference'; status?: 'active' | 'withdrawn';
}
const finished = new Set(['delivered', 'archived', 'cancelled']);

/** Revoke evidence before any newly received revision can be scheduled. */
export function invalidateSource(store: Store, sourceId: string, status: 'superseded' | 'withdrawn'): void {
  const source = store.get('sources', sourceId);
  if (!source) return;
  if (source.status === 'superseded' && status === 'superseded') return;
  if (source.status === 'withdrawn') { if (status === 'withdrawn') redactWithdrawnEvidence(store, sourceId); return; }
  const scope = { projectId: source.projectId, domain: source.domain }; const changed = now();
  if (status === 'withdrawn') {
    redactWithdrawnEvidence(store, sourceId);
    store.save('events', { ...scope, id: stableId('source-invalidated', sourceId, status), type: 'source.withdrawn', message: 'Evidence retracted.', createdAt: changed, data: { sourceId } });
    return;
  }
  const dependentCards=new Set(store.list('actions').filter(action=>action.kind==='knowledge.structured-ingest'&&knowledgeActionSourceRefs(action).some(ref=>ref.id===sourceId)).map(action=>action.payload.sourceId).filter((id):id is string=>typeof id==='string'));
  store.save('sources', { ...source, status });
  for (const action of store.list('actions')) if (['knowledge.structured-ingest','knowledge.host-observation','knowledge.evidence-link','experience.test-observation'].includes(action.kind) && knowledgeActionSourceRefs(action).some(ref => ref.id === sourceId)) {
    store.save('actions', { ...action, status: 'completed', payload: { phase: 'invalid', errorCode: 'source_invalidated', retracted: true, sourceIds: [sourceId] }, updatedAt: changed });
  }
  // Copies retain their originating revision, including secondary/historical Vault edits.
  for (const child of store.list('sources')) if (child.projectId === source.projectId && child.domain === source.domain && child.parentSources?.some(ref => ref.id === sourceId)) invalidateSource(store, child.id, status);
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
  for (const task of store.list('tasks')) {
    if (task.projectId !== scope.projectId || task.domain !== scope.domain || finished.has(task.status)) continue;
    const direct = task.sourceId === sourceId;
    const depends = invalidCaseTasks.has(task.id) || task.decision?.citations.some(c => c.sourceId === sourceId) || task.decision?.ruleIds.some(id => invalidRules.has(id));
    if (!direct && !depends) continue;
    for (const question of store.list('questions')) if (question.taskId === task.id && question.status === 'open') store.save('questions', { ...question, status: 'stale' });
    for (const attempt of store.list('attempts')) if (attempt.taskId === task.id && attempt.status === 'running') store.save('attempts', { ...attempt, status: 'stale', finishedAt: changed, error: 'Source changed during execution.' });
    for (const action of store.list('actions')) if (action.taskId === task.id && action.status === 'pending') store.save('actions', { ...action, status: 'completed', payload: { invalidated: true, reason: status }, updatedAt: changed });
    for (const message of store.list('outbox')) if (message.taskId === task.id && message.status === 'pending') store.save('outbox', { ...message, status: 'sent', text: '[invalidated]', remoteId: 'invalidated' });
    store.save('tasks', { ...task, version: task.version + 1, status: direct ? 'cancelled' : 'deciding', stage: 'decide', updatedAt: changed, runAfter: changed, decision: undefined, decisionSnapshotId: undefined, plan: undefined, artifact: undefined, review: undefined, questionId: undefined, receiptId: undefined, error: `Source ${status}; previous authorizations invalidated.` });
  }
  store.save('events', { ...scope, id: stableId('source-invalidated', sourceId, status), type: `source.${status}`, message: `Source ${sourceId} ${status}; dependent evidence and actions invalidated.`, createdAt: changed, data: { sourceId } });
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
    for (const child of sources) if (child.parentSources?.some(ref => sourceIds.has(ref.id))) sourceIds.add(child.id);
    for (const rule of rules) if (rule.citations.some(c => sourceIds.has(c.sourceId))) ruleIds.add(rule.id);
    for (const c of cases) if (sourceIds.has(c.sourceId) || c.decisionSnapshot?.sourceRefs.some(ref => sourceIds.has(ref.id)) || c.ruleIds.some(id => ruleIds.has(id)) || taskIds.has(c.taskId)) { caseIds.add(c.id); taskIds.add(c.taskId); sourceIds.add(c.sourceId); }
    for (const task of tasks) if (sourceIds.has(task.sourceId) || task.decision?.citations.some(c => sourceIds.has(c.sourceId)) || task.decision?.ruleIds.some(id => ruleIds.has(id))) taskIds.add(task.id);
    for (const action of historicalJudgments) {
      const snapshot = action.payload.snapshot as DecisionSnapshot | undefined;
      if (action.taskId && snapshot && (sourceIds.has(snapshot.sourceId) || snapshot.sourceRefs.some(ref => sourceIds.has(ref.id)))) taskIds.add(action.taskId);
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
  for (const source of sources) if (sourceIds.has(source.id)) write('sources', { ...source, status: 'withdrawn', title: '[withdrawn]', content: '', locator: `withdrawn:${source.id}` });
  for (const card of cards) if (cardIds.has(card.id)) write('cards', { ...card, title: '[withdrawn]', body: '', quote: '', aliases: [], ...(isStructuredKnowledgeCard(card)?{experience:undefined,claim:undefined,pendingClaim:undefined}:{}),locator: `withdrawn:${card.sourceId}`, status: 'withdrawn' });
  for (const rule of rules) if (ruleIds.has(rule.id)) write('rules', { ...rule, title: '[withdrawn]', statement: '[Evidence withdrawn]', conditions: '[withdrawn]', exceptions: '[withdrawn]', status: 'suspended', citations: rule.citations.map(c => ({ ...c, quote: '[withdrawn]', locator: `withdrawn:${c.sourceId}` })) });
  for (const c of cases) if (caseIds.has(c.id)) write('cases', { ...c, originalWords: '[withdrawn]', rationale: '[withdrawn]', alternatives: [], outcome: undefined, decisionSnapshot: undefined, outcomes: undefined, status: 'withdrawn' });
  const option = { label: '[withdrawn]', description: '[withdrawn]', rationale: '[withdrawn]', tradeoff: '[withdrawn]', evidenceUrls: [] };
  for (const q of questions) if (taskIds.has(q.taskId)) write('questions', { ...q, title: '[withdrawn]', context: '', options: { A: option, B: option }, research: { queries: [], summary: '', gaps: [] }, answer: undefined, status: 'stale' });
  for (const task of tasks) if (taskIds.has(task.id)) {
    const terminal = finished.has(task.status);
    const status = terminal ? task.status : sourceIds.has(task.sourceId) ? 'cancelled' : 'deciding';
    const alreadyRedacted = task.error === 'Evidence withdrawn; readable content retracted.' && !task.description && !task.decision && !task.plan && !task.artifact && !task.review && !task.feedback;
    write('tasks', { ...task, title: '[Evidence withdrawn]', description: '', decision: undefined, decisionSnapshotId: undefined, plan: undefined, baselineFiles: undefined, artifact: undefined, review: undefined, feedback: undefined, error: 'Evidence withdrawn; readable content retracted.', status, ...(terminal ? {} : { version: alreadyRedacted ? task.version : task.version + 1, stage: 'decide' as const, questionId: undefined, updatedAt: alreadyRedacted ? task.updatedAt : now(), runAfter: alreadyRedacted ? task.runAfter : now() }) });
  }
  for (const event of store.list('events')) if (scoped(event) && (event.taskId && taskIds.has(event.taskId) || refers(event.data) || mentions(event.data) || mentions(event.message))) write('events', { ...event, message: 'Evidence retracted.', data: { retracted: true } });
  for (const attempt of store.list('attempts')) if (taskIds.has(attempt.taskId)) write('attempts', { ...attempt, error: undefined, ...(attempt.status === 'running' ? { status: 'stale' as const, finishedAt: now() } : {}) });
  const outboxIds = new Set<string>();
  for (const action of store.list('actions')) if (scoped(action) && (action.taskId && taskIds.has(action.taskId) || refers(action.payload) || mentions(action.payload))) {
    if (typeof action.payload.outboxId === 'string') outboxIds.add(action.payload.outboxId);
    write('actions', { ...action, status: 'completed', payload: { retracted: true, sourceIds: [...sourceIds], ...(typeof action.payload.receiptId === 'string' ? { receiptId: action.payload.receiptId } : {}), ...(typeof action.payload.remoteId === 'string' ? { remoteId: action.payload.remoteId } : {}) } });
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
  const purpose = input.purpose ?? 'task';
  if (!['task', 'reference'].includes(purpose)) throw new DomainError('Unknown source purpose.');
  const kind = input.kind ?? 'manual';
  if (!['file', 'feishu', 'github', 'conversation', 'manual', 'reading'].includes(kind)) throw new DomainError('Unknown source kind.');
  const scope = { projectId: project.id, domain: project.domain };
  return store.transaction(() => {
    if (!store.get('projects', project.id)) store.save('projects', project);
    const previous = store.list('sources').filter(s => s.projectId === project.id && s.domain === project.domain && s.kind === kind && s.externalId === input.externalId && s.status === 'active');
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
      const task = purpose === 'reference' ? undefined : store.list('tasks').find(t => t.sourceId === id);
      if (existing.retention === 'ephemeral' && !existing.content) {
        const restored = { ...existing, title: input.title, content: input.content };
        store.save('sources', restored);
        enqueueStructuredKnowledge(store, restored);
        if (task && !finished.has(task.status)) {
          for (const question of store.list('questions')) if (question.taskId === task.id) store.save('questions', { ...question, status: 'stale' });
          const reconstructed: Task = { ...task, title: input.title, version: task.version + 1, status: 'queued', stage: 'knowledge_extract', runAfter: now(), updatedAt: now(), repairCount: 0, decision: undefined, plan: undefined, artifact: undefined, review: undefined, questionId: undefined, receiptId: undefined, feedback: undefined, baselineFiles: undefined, error: undefined };
          store.save('tasks', reconstructed); return reconstructed;
        }
      }
      enqueueStructuredKnowledge(store, store.get('sources', id)!);
      return task;
    }
    for (const old of previous) invalidateSource(store, old.id, 'superseded');
    const createdAt = now();
    const source: SourceRevision = { ...scope, id, purpose, ...(parentSources?.length ? { parentSources } : {}), kind, externalId: input.externalId, revision, title: input.title, content: input.content, locator: input.locator ?? `${kind}:${input.externalId}`, authorId: input.authorId ?? '', retention: input.retention ?? 'permanent', status: 'active', createdAt };
    store.save('sources', source);
    store.save('cursors', { ...scope, id: hashId, value: contentHash, updatedAt: createdAt });
    enqueueStructuredKnowledge(store, source);
    if (purpose === 'reference') {
      store.save('events', { ...scope, id: stableId('ingest', id), type: 'source.received', message: 'Reference revision accepted.', createdAt, data: { sourceId: id, revision, retention: source.retention, purpose } });
      return undefined;
    }
    const task: Task = { ...scope, billingBoundary, id: stableId('task', id), sourceId: id, sourceRevision: revision, title: input.title, description: source.retention === 'ephemeral' ? '' : input.content, status: 'queued', version: 1, stage: 'knowledge_extract', createdAt, updatedAt: createdAt, runAfter: createdAt, attempts: 0, repairCount: 0, budgetUsd: project.budgetUsd, spentUsd: 0 };
    store.save('tasks', task);
    store.save('events', { ...scope, id: stableId('ingest', id), taskId: task.id, type: 'source.received', message: 'Source revision accepted.', createdAt, data: { sourceId: id, revision, retention: source.retention } });
    return task;
  });
}
