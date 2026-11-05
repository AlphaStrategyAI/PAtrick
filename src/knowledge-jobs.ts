import { z } from 'zod';
import { digest, now, stableId, type ActionRecord, type Attempt, type KnowledgeCard, type SourceRevision, type Task } from './domain.js';
import type { SourceRef } from './knowledge-contract.js';
import { knowledgeSourceRefs } from './knowledge-records.js';
import type { Store } from './store.js';

export interface StructuredIngestJobV1 {
  schemaVersion: 1; sourceId: string; sourceRevision: string; sourceHash: string; sourceRefs: SourceRef[];
  phase: 'queued' | 'pending-readback' | 'ordinary' | 'processed' | 'invalid';
  tries: number; runAfter: string; errorCode?: string;
  readHold?: {policyHash:string;sourceHashes:{id:string;revision:string;hash:string}[]};
}
const text = z.string().min(1).max(10000);
export const structuredIngestJobSchema: z.ZodType<StructuredIngestJobV1> = z.object({
  schemaVersion: z.literal(1), sourceId: text, sourceRevision: text, sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRefs: z.array(z.object({ id: text, revision: text }).strict()).min(1).max(256),
  phase: z.enum(['queued', 'pending-readback', 'ordinary', 'processed', 'invalid']),
  tries: z.number().int().nonnegative(), runAfter: z.string().datetime({offset:true}), errorCode: text.optional(),
  readHold:z.object({policyHash:z.string().regex(/^[a-f0-9]{64}$/),sourceHashes:z.array(z.object({id:text,revision:text,hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(256)}).strict().optional(),
}).strict();

/** A pending stage plus a succeeded attempt is negative evidence only. */
export function consumedStageResult(store:Store,task:Task,attempts:Attempt[]=store.list('attempts')):boolean {
  const id=stableId('stage-action',task.id,task.version,task.stage,task.repairCount),action=store.get('actions',id);
  if(!action||action.status!=='pending'||action.kind!==task.stage||action.taskId!==task.id||action.projectId!==task.projectId||action.domain!==task.domain)return false;
  const history=attempts.filter(attempt=>attempt.taskId===task.id),before=action.payload.attemptsBefore,prior=action.payload.priorSucceededAttemptIds;
  const validBefore=typeof before==='number'&&Number.isSafeInteger(before)&&before>=0&&before<=task.attempts&&history.length<=task.attempts;
  const ordinals=history.filter(attempt=>attempt.billing).map(attempt=>attempt.billing!.ordinal);
  const validOrdinals=ordinals.every(ordinal=>Number.isSafeInteger(ordinal)&&ordinal>0&&ordinal<=task.attempts)&&new Set(ordinals).size===ordinals.length;
  const post=validBefore&&validOrdinals?history.filter(attempt=>attempt.billing&&attempt.billing.ordinal>before):[];
  // For older actions, only a complete billed suffix and ledger insertion order
  // establish that an unbilled success belongs to a previous pass.
  const suffixComplete=validBefore&&validOrdinals&&post.length===task.attempts-before&&post.length>0&&history.every(attempt=>attempt.projectId===task.projectId&&attempt.domain===task.domain);
  return history.some(attempt=>{
    if(attempt.projectId!==task.projectId||attempt.domain!==task.domain||attempt.taskVersion!==task.version||attempt.role!==task.stage||attempt.status!=='succeeded')return false;
    if(action.payload.taskVersion!==task.version||action.payload.sourceRevision!==task.sourceRevision||!validBefore)return true;
    if(attempt.billing)return !validOrdinals||attempt.billing.ordinal>before;
    return !(Array.isArray(prior)&&prior.includes(attempt.id)||suffixComplete&&history.indexOf(attempt)<history.indexOf(post[0]!));
  });
}

export function structuredKnowledgeJobId(source: SourceRevision): string {
  return stableId('knowledge.structured-ingest', source.id, source.revision, digest(source.content));
}
export function structuredKnowledgeCardId(card:Pick<KnowledgeCard,'sourceId'|'sourceRevision'|'kind'|'title'|'quote'>):string {
  return `knowledge-structured-card:${stableId('knowledge.structured-card',card.sourceId,card.sourceRevision,card.kind,card.title,card.quote)}`;
}
export function isStructuredKnowledgeCard(card:KnowledgeCard):boolean {return card.id.startsWith('knowledge-structured-card:');}

/** Check the entire stored closure, including request dependencies, without parsing source text. */
export function validStructuredJobRefs(store:Store,source:SourceRevision,refs:SourceRef[]):boolean {
  const primary=knowledgeSourceRefs(store,source.id,source);if(!primary)return false;
  const indexed=new Map(refs.map(ref=>[ref.id,ref.revision]));
  if(indexed.size!==refs.length||primary.some(ref=>indexed.get(ref.id)!==ref.revision))return false;
  return refs.every(ref=>{
    const dependency=store.get('sources',ref.id);
    if(!dependency||dependency.status!=='active'||dependency.revision!==ref.revision||dependency.projectId!==source.projectId||dependency.domain!==source.domain||dependency.retention==='ephemeral'&&!dependency.content)return false;
    const lineage=knowledgeSourceRefs(store,ref.id,source);
    return !!lineage&&lineage.every(parent=>indexed.get(parent.id)===parent.revision);
  });
}

/** Call only after accepted source identity, retention and purpose have been resolved. */
export function enqueueStructuredKnowledge(store: Store, source: SourceRevision): string | undefined {
  if (source.status !== 'active' || source.retention === 'ephemeral' && !source.content) return undefined;
  const current = store.get('sources', source.id), project = store.get('projects', source.projectId);
  if (!current || digest(current) !== digest(source) || !project || project.id !== project.projectId || project.domain !== source.domain) return undefined;
  const acceptedHash=store.get('cursors',stableId('source-hash',source.id))?.value;
  if(acceptedHash&&acceptedHash!==digest(source.content))return undefined;
  const sourceRefs = knowledgeSourceRefs(store, source.id, source); if (!sourceRefs) return undefined;
  if(sourceRefs.some(ref=>{const parent=store.get('sources',ref.id);return parent?.retention==='ephemeral'&&!parent.content;}))return undefined;
  const id = structuredKnowledgeJobId(source), existing = store.get('actions', id);
  if (existing) return id; // Includes completed and redacted tombstones.
  const at = now(), payload: StructuredIngestJobV1 = { schemaVersion: 1, sourceId: source.id, sourceRevision: source.revision,
    sourceHash: digest(source.content), sourceRefs, phase: 'queued', tries: 0, runAfter: at };
  store.save('actions', { id, projectId: source.projectId, domain: source.domain, kind: 'knowledge.structured-ingest', status: 'pending', payload: payload as unknown as Record<string,unknown>, updatedAt: at });
  return id;
}

export function isReadyStructuredKnowledgeJob(store:Store,action:ActionRecord,at:string):boolean {
    if (!Number.isFinite(Date.parse(at))) return false;
    if (action.kind !== 'knowledge.structured-ingest' || action.status !== 'pending') return false;
    const parsed = structuredIngestJobSchema.safeParse(action.payload); if (!parsed.success) return false;
    const job = parsed.data, source = store.get('sources', job.sourceId), project = store.get('projects', action.projectId);
    if(job.errorCode==='knowledge_read_inflight'||job.errorCode==='knowledge_snapshot_unavailable')return false;
    if (!source || !project || source.status !== 'active' || source.revision !== job.sourceRevision || digest(source.content) !== job.sourceHash ||
      source.projectId !== action.projectId || source.domain !== action.domain || project.id !== project.projectId || project.domain !== action.domain ||
      action.id !== structuredKnowledgeJobId(source) || Date.parse(job.runAfter) > Date.parse(at)) return false;
    return ['queued','pending-readback'].includes(job.phase)&&validStructuredJobRefs(store,source,job.sourceRefs);
}
export function readyStructuredKnowledgeJobs(store: Store, at: string, limit: number): ActionRecord[] {
  if (!Number.isFinite(limit)) return [];
  return store.list('actions').filter(action=>isReadyStructuredKnowledgeJob(store,action,at))
    .sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id)).slice(0, Math.max(0, Math.min(4, Math.floor(limit))));
}
