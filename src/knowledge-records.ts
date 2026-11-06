import { digest, pathAllowed, stableId, type Scope, type ActionRecord } from './domain.js';
import { isKnowledgeSnapshotFailure, type Store } from './store.js';
import { z } from 'zod';
import { atomicClaimSchema, observedProcessSchema, type TestObservation, type HostObservation, type SourceRef, type RepositoryReadRequest, type CanonicalHostObservationPayload, type CanonicalKnowledgeEvidencePayload, type CanonicalCiTestObservationPayload, type AtomicClaim, type ExperienceAssociation } from './knowledge-contract.js';
import { snapshotDigest, knowledgePolicyHash } from './knowledge-identity.js';
import { assertKnowledgeSource, parseStructuredKnowledge, structuredRepositoryRequest } from './structured-knowledge.js';

export interface AcceptedLocalProvenance {
 attemptId:string;taskId:string;taskVersion:number;role:'execute'|'check';runner:string;provider:string;model:string;
 inputHash:string;outputHash:string;planHash:string;artifactHash:string;runId:string;sourceHash:string;policyHash:string;
}

type RetainedTestObservation={observation:TestObservation;hosts:HostObservation[]};

/** Read retained accepted facts, independently of the task's later workflow. */
function readRetainedTestObservation(store:Store,id:string,scope:Scope):RetainedTestObservation|undefined {
 const row=store.get('actions',id);
 if(!row||row.kind!=='experience.test-observation'||row.status!=='completed'||row.projectId!==scope.projectId||row.domain!==scope.domain)return undefined;
 if(isCiTestPayload(row.payload))return readCiTestObservation(store,row.payload,id,scope);
 if(!isLocalTestPayload(row.payload))return undefined;
 const p=row.payload,o=p.observation,a=p.accepted;
 if(o.id!==id||o.projectId!==scope.projectId||o.domain!==scope.domain||p.digest!==digest(o)||p.acceptedDigest!==digest(a)||id!==stableId('local-test-observation',a.runId,digest(o.origin),digest({...o,id:''})))return undefined;
 const origin=o.origin;if(origin.kind!=='local')return undefined;
 if(origin.attemptId!==a.attemptId||origin.taskId!==a.taskId||origin.taskVersion!==a.taskVersion||origin.inputHash!==a.inputHash||origin.planHash!==a.planHash||origin.artifactHash!==a.artifactHash||origin.runId!==a.runId||origin.role!==a.role)return undefined;
 const attempt=store.get('attempts',a.attemptId),source=store.get('sources',o.sourceId),project=store.get('projects',scope.projectId);
 if(!attempt||attempt.status!=='succeeded'||attempt.projectId!==scope.projectId||attempt.domain!==scope.domain||attempt.taskId!==a.taskId||attempt.taskVersion!==a.taskVersion||attempt.role!==a.role||attempt.runner!==a.runner||attempt.provider!==a.provider||attempt.model!==a.model||attempt.inputHash!==a.inputHash||!source||source.status!=='active'||source.revision!==o.sourceRevision||source.projectId!==scope.projectId||source.domain!==scope.domain||digest(source)!==a.sourceHash||!project||project.projectId!==scope.projectId||project.domain!==scope.domain||project.repository!==o.repository||knowledgePolicyHash(project)!==a.policyHash)return undefined;
 if(JSON.stringify(p.sourceRefs)!==JSON.stringify([{id:source.id,revision:source.revision}])||!knowledgeSourceRefs(store,source.id,scope))return undefined;
 return {observation:structuredClone(o),hosts:[]};
}

export function readTestObservation(store:Store,id:string,scope:Scope):TestObservation|undefined {return store.readSnapshot(()=>readTestObservationBody(store,id,scope));}
function readTestObservationBody(store:Store,id:string,scope:Scope):TestObservation|undefined {
 return readRetainedTestObservation(store,id,scope)?.observation;
}

// Canonical repository payload validation stays transport-free and Store is type-only.
const text=z.string().min(1).max(10000),hash=z.string().regex(/^[a-f0-9]{64}$/),time=z.string().datetime({offset:true});
const ref=z.object({id:text,revision:text}).strict();
const refs=z.array(ref).min(1).max(256);
const scope={projectId:text,domain:text};
export const hostObservationSchema:z.ZodType<HostObservation>=z.object({schemaVersion:z.literal(1),id:text,...scope,claim:atomicClaimSchema,
 origin:z.object({kind:z.enum(['provider','host-test']),provider:z.enum(['github','gitlab']).optional(),repository:text,producerId:text,originalEventId:text,independentOrigin:text,derivedFrom:z.array(text).max(256)}).strict(),
 sourceRefs:refs,responseDigest:hash,locator:text,observedAt:time,eventAt:time.optional(),bindingHash:hash}).strict();
/** Pure bounded comparison of retained observations; no supplied object can admit canonical authority. */
export function compareIndependentClaim(claim:AtomicClaim,observations:readonly HostObservation[]):boolean {
 if(claim.kind!=='test-result'||!atomicClaimSchema.safeParse(claim).success||observations.length<2||observations.length>32)return false;
 if(observations.some(o=>!hostObservationSchema.safeParse(o).success||JSON.stringify(o.claim)!==JSON.stringify(claim)||(o.projectId!==observations[0]!.projectId||o.domain!==observations[0]!.domain)||o.origin.repository!==claim.subject.repository||o.origin.derivedFrom.some(v=>v.startsWith('unknown')||v===o.id||v===o.origin.originalEventId)))return false;
 // Any contradiction or unsupported atom in the supplied set fails closed, even if another pair would agree.
 for(let i=0;i<observations.length;i++)for(let j=i+1;j<observations.length;j++){
  const a=observations[i]!,b=observations[j]!,ar=new Set([a.id,a.origin.originalEventId,...a.origin.derivedFrom]),br=new Set([b.id,b.origin.originalEventId,...b.origin.derivedFrom]);
  const aSources=new Set(a.sourceRefs.map(r=>`source:${r.id}:${r.revision}`)),bSources=new Set(b.sourceRefs.map(r=>`source:${r.id}:${r.revision}`));
  if(a.origin.derivedFrom.some(r=>bSources.has(r))||b.origin.derivedFrom.some(r=>aSources.has(r)))continue;
  if(a.id===b.id||a.origin.originalEventId===b.origin.originalEventId||a.origin.independentOrigin===b.origin.independentOrigin||[...ar].some(r=>br.has(r)))continue;
  return true;
 }
 return false;
}

const checkRequest=z.object({runId:z.string().regex(/^[1-9][0-9]*$/).max(32),jobId:z.string().regex(/^[1-9][0-9]*$/).max(32),checkName:text}).strict();
const request=z.object({repository:text,headSha:z.string().regex(/^[a-f0-9]{40}$/),changeNumber:z.number().int().positive().safe().optional(),checks:z.array(checkRequest).max(20),filePaths:z.array(text).max(128),issueSource:ref.optional(),testReportPath:text.optional(),current:z.object({changeNumber:z.number().int().positive().safe(),checkNames:z.array(text).max(20)}).strict().optional()}).strict();
const attestation=z.object({observationId:text,producerId:text,originalEventId:text,reportPath:text,reportDigest:hash,snapshotDigest:hash,testDefinitionDigest:hash}).strict();
export const canonicalHostPayloadSchema:z.ZodType<CanonicalHostObservationPayload>=z.object({schemaVersion:z.literal(1),observation:hostObservationSchema,digest:hash,sourceHash:hash,policyHash:hash,issueSourceHash:hash.optional(),request,requestHash:hash,sourceRefs:refs,attestation:attestation.optional()}).strict();
const retractedHostPayloadSchema=z.union([
 z.object({retracted:z.literal(true),sourceIds:z.array(text).min(1)}).strict(),
 z.object({phase:z.literal('invalid'),errorCode:z.literal('source_invalidated'),retracted:z.literal(true),sourceIds:z.tuple([text])}).strict(),
]);
/** Recognize only the host's privacy tombstones, backed by revoked same-scope sources. */
export function isRetractedHostObservation(store:Store,row:ActionRecord):boolean {
 if(row.kind!=='knowledge.host-observation'||row.status!=='completed')return false;
 const parsed=retractedHostPayloadSchema.safeParse(row.payload);if(!parsed.success)return false;
 const ids=parsed.data.sourceIds;if(new Set(ids).size!==ids.length)return false;
 return ids.every(id=>{const source=store.get('sources',id);return !!source&&source.projectId===row.projectId&&source.domain===row.domain&&source.status!=='active';});
}
const factualContext=z.object({id:text,...scope,observedAt:time,projectPolicyHash:hash,source:ref,sourceHash:hash,task:z.object({id:text,version:z.number().int().positive()}).strict(),observations:z.array(z.object({id:text,hash}).strict()).min(1).max(32)}).strict();
export const canonicalFactualContextPayloadSchema=z.object({schemaVersion:z.literal(1),context:factualContext,digest:hash,sourceRefs:refs}).strict().superRefine((value,ctx)=>{if(new Set(value.context.observations.map(item=>item.id)).size!==value.context.observations.length||new Set(value.sourceRefs.map(item=>item.id)).size!==value.sourceRefs.length||!value.sourceRefs.some(ref=>ref.id===value.context.source.id&&ref.revision===value.context.source.revision))ctx.addIssue({code:'custom',message:'Current context bindings must be unique and include the source.'});});
// A context audit contains only identity, hashes and revocation metadata.
const auditRef=z.object({id:text,revisionHash:hash}).strict();
export const factualContextTombstonePayloadSchema=z.object({
 schemaVersion:z.literal(1),phase:z.literal('invalid'),errorCode:z.literal('source_invalidated'),retracted:z.literal(true),
 sourceIds:z.tuple([text]),primarySourceId:text,taskVersion:z.number().int().positive().safe(),contextHash:hash,
 sourceRefs:z.array(auditRef).min(1).max(256),auditHash:hash,
}).strict().superRefine((value,ctx)=>{
 if(new Set(value.sourceRefs.map(ref=>ref.id)).size!==value.sourceRefs.length||
   !value.sourceRefs.some(ref=>ref.id===value.primarySourceId)||!value.sourceRefs.some(ref=>ref.id===value.sourceIds[0]))
  ctx.addIssue({code:'custom',message:'Audit references must uniquely include the primary and invalidated source.'});
});
type FactualContextTombstone=z.infer<typeof factualContextTombstonePayloadSchema>;
export function factualContextAuditDigest(action:ActionRecord,payload:Record<string,unknown>):string {
 const {auditHash:_auditHash,...body}=payload;
 return digest({id:action.id,projectId:action.projectId,domain:action.domain,taskId:action.taskId,payload:body});
}
/** Validate every referenced source and its complete scoped parent closure. */
function validAuditRefs(store:Store,action:ActionRecord,p:FactualContextTombstone,revoked:boolean):boolean {
 if(action.kind!=='knowledge.factual-context'||action.status!=='completed'||!action.taskId||!/^[a-f0-9]{32}$/.test(action.id)||
   p.auditHash!==factualContextAuditDigest(action,p))return false;
 const task=store.get('tasks',action.taskId);
 if(!task||task.projectId!==action.projectId||task.domain!==action.domain||task.sourceId!==p.primarySourceId||task.version<p.taskVersion)return false;
 const indexed=new Map(p.sourceRefs.map(ref=>[ref.id,ref.revisionHash])),visiting=new Set<string>(),visited=new Set<string>();
 const visit=(id:string):boolean=>{
  if(visiting.has(id))return false;if(visited.has(id))return true;
  const source=store.get('sources',id);
  const expected=indexed.get(id),parents=source&&store.sourceParentAuditRefs(source);
  if(!source||source.projectId!==action.projectId||source.domain!==action.domain||!expected||!store.sourceRevisionHashMatches(source,expected)||!parents)return false;
  visiting.add(id);
  if(!parents.every(parent=>parent.revisionHash===indexed.get(parent.id)&&visit(parent.id)))return false;
  visiting.delete(id);visited.add(id);return true;
 };
 if(!p.sourceRefs.every(ref=>visit(ref.id)))return false;
 const invalidated=store.get('sources',p.sourceIds[0]);
 return !!invalidated&&(!revoked||invalidated.status==='superseded');
}
/** Build only from the prior canonical action while its source bindings still exist. */
export function factualContextTombstone(store:Store,action:ActionRecord,sourceId:string):Record<string,unknown>|undefined {
 if(action.kind!=='knowledge.factual-context'||action.status!=='completed')return undefined;
 const parsed=canonicalFactualContextPayloadSchema.safeParse(action.payload);if(!parsed.success)return undefined;
 const p=parsed.data,c=p.context;
 if(c.id!==action.id||c.projectId!==action.projectId||c.domain!==action.domain||c.task.id!==action.taskId||
   p.digest!==digest(c)||!p.sourceRefs.some(ref=>ref.id===sourceId))return undefined;
 const indexed=new Map(p.sourceRefs.map(ref=>[ref.id,ref.revision]));
 if(c.observations.some(entry=>{
  const row=store.get('actions',entry.id),record=row&&readCanonicalHostRecord(row);
  return !record||row!.projectId!==action.projectId||row!.domain!==action.domain||digest(record.observation)!==entry.hash||
   record.sourceRefs.some(ref=>indexed.get(ref.id)!==ref.revision);
 }))return undefined;
 const payload={schemaVersion:1 as const,phase:'invalid' as const,errorCode:'source_invalidated' as const,retracted:true as const,
  sourceIds:[sourceId] as [string],primarySourceId:c.source.id,taskVersion:c.task.version,contextHash:p.digest,
  sourceRefs:p.sourceRefs.map(ref=>({id:ref.id,revisionHash:digest(ref.revision)})),auditHash:''};
 payload.auditHash=factualContextAuditDigest(action,payload);
 if(!factualContextTombstonePayloadSchema.safeParse(payload).success||!validAuditRefs(store,action,payload,false))return undefined;
 return payload;
}
/** Only a canonical-to-audit transition or an identical audit rewrite can persist. */
export function validFactualContextTombstoneTransition(previous:ActionRecord|undefined,action:ActionRecord):boolean {
 const next=factualContextTombstonePayloadSchema.safeParse(action.payload);if(!previous||!next.success||
  previous.id!==action.id||previous.projectId!==action.projectId||previous.domain!==action.domain||previous.taskId!==action.taskId||
  previous.kind!==action.kind||previous.status!=='completed')return false;
 const oldAudit=factualContextTombstonePayloadSchema.safeParse(previous.payload);
 if(oldAudit.success)return digest(previous.payload)===digest(action.payload);
 const old=canonicalFactualContextPayloadSchema.safeParse(previous.payload);if(!old.success)return false;
 const c=old.data.context,p=next.data;
 return c.id===action.id&&c.task.id===action.taskId&&c.projectId===action.projectId&&c.domain===action.domain&&
  old.data.digest===digest(c)&&p.contextHash===old.data.digest&&p.primarySourceId===c.source.id&&p.taskVersion===c.task.version&&
  digest(p.sourceRefs)===digest(old.data.sourceRefs.map(ref=>({id:ref.id,revisionHash:digest(ref.revision)})))&&
  p.auditHash===factualContextAuditDigest(action,p);
}
const link=z.object({schemaVersion:z.literal(1),...scope,cardId:text,candidateHash:hash,claimHash:hash,observationIds:z.array(text).min(1).max(32),observationHashes:z.array(hash).min(1).max(32),basis:z.enum(['authoritative-record','independent-corroboration']),sourceRefs:refs,createdAt:time}).strict();
export const canonicalKnowledgePayloadSchema:z.ZodType<CanonicalKnowledgeEvidencePayload>=z.object({schemaVersion:z.literal(1),link,digest:hash,sourceRefs:refs}).strict();
const file=z.object({path:text,sha256:hash,mode:text}).strict();
const observedCheck=z.object({id:text,name:text.optional(),command:text.optional(),testFile:text.optional(),result:z.enum(['success','failure','incomplete']),outputDigest:hash,process:observedProcessSchema.optional()}).strict();
const ciTestObservation=z.object({schemaVersion:z.literal(1),id:text,...scope,sourceId:text,sourceRevision:text,repository:text,observedAt:time,
 snapshot:z.object({revision:text,overlayHash:hash.optional(),files:z.array(file).max(128)}).strict(),checks:z.array(observedCheck).min(1).max(128),
 environment:z.object({observed:z.record(z.string(),text),unknown:z.array(text).max(128)}).strict(),comparable:z.object({snapshotDigest:hash,testDefinitionDigest:hash}).strict().optional(),
 origin:z.object({kind:z.literal('ci'),provider:z.enum(['github','gitlab']),runId:text,jobId:text,producerId:text,headSha:text,url:text,responseDigest:hash,receiptId:text.optional()}).strict()}).strict();
export const canonicalCiTestPayloadSchema:z.ZodType<CanonicalCiTestObservationPayload>=z.object({schemaVersion:z.literal(1),observation:ciTestObservation,digest:hash,sourceHash:hash,policyHash:hash,issueSourceHash:hash.optional(),request,requestHash:hash,sourceRefs:refs,hostObservationIds:z.array(text).min(1).max(32),hostObservationHashes:z.array(hash).min(1).max(32)}).strict().superRefine((value,ctx)=>{
 if(value.hostObservationIds.length!==value.hostObservationHashes.length||new Set(value.hostObservationIds).size!==value.hostObservationIds.length||value.hostObservationIds.some((id,i)=>i>0&&value.hostObservationIds[i-1]!>id))ctx.addIssue({code:'custom',message:'Canonical host observation bindings must be unique, ordered and paired.'});
 if(!!value.request.issueSource!==!!value.issueSourceHash||!value.sourceRefs.some(ref=>ref.id===value.observation.sourceId&&ref.revision===value.observation.sourceRevision)||value.request.issueSource&&!value.sourceRefs.some(ref=>ref.id===value.request.issueSource!.id&&ref.revision===value.request.issueSource!.revision))ctx.addIssue({code:'custom',message:'Canonical source bindings must include the primary and requested issue revisions.'});
});
const localTestObservation=ciTestObservation.extend({origin:z.object({kind:z.literal('local'),taskId:text,taskVersion:z.number().int(),attemptId:text,inputHash:hash,planHash:hash,artifactHash:hash,role:z.enum(['execute','check']),runId:text}).strict()}).strict();
const localTestPayload=z.object({schemaVersion:z.literal(1),observation:localTestObservation,digest:hash,sourceRefs:refs,accepted:z.object({attemptId:text,taskId:text,taskVersion:z.number().int(),role:z.enum(['execute','check']),runner:text,provider:text,model:text,inputHash:hash,outputHash:hash,planHash:hash,artifactHash:hash,runId:text,sourceHash:hash,policyHash:hash}).strict(),acceptedDigest:hash}).strict();
type LocalTestPayload=z.infer<typeof localTestPayload>;
function isLocalTestPayload(value:unknown):value is LocalTestPayload{return localTestPayload.safeParse(value).success;}
function isCiTestPayload(value:unknown):value is CanonicalCiTestObservationPayload{return canonicalCiTestPayloadSchema.safeParse(value).success;}
export const experienceAssociationSchema:z.ZodType<ExperienceAssociation>=z.object({schemaVersion:z.literal(1),cardId:text,candidateHash:hash,sourceId:text,sourceRevision:text,observationId:text,observationHash:hash,
 checkIds:z.array(text).min(1).max(128),files:z.array(file).min(1).max(128),subject:z.object({kind:z.enum(['task','issue']),id:text,revision:text}).strict(),
 relevance:z.object({kind:z.enum(['named-regression','resolution-with-checks']),recordSourceId:text,recordRevision:text,quote:text,locator:text,interpretation:z.enum(['reported','inference'])}).strict(),
 versionBinding:z.object({reported:z.literal('unknown'),observedRevision:text}).strict().optional()}).strict();
export const canonicalExperiencePayloadSchema=z.object({schemaVersion:z.literal(1),association:experienceAssociationSchema,digest:hash,sourceRefs:refs}).strict();
// A redacted link may retain only the candidate's normalization origin. It is never a link or observation.
export const normalizationOriginPayloadSchema=z.object({retracted:z.literal(true),sourceIds:z.array(text).min(1),phase:z.literal('invalid').optional(),errorCode:z.literal('source_invalidated').optional(),
 sourceRefs:refs,normalizationOrigin:z.object({cardId:text,candidateHash:hash,sourceId:text,sourceRevision:text,reported:z.literal('unknown'),observedRevision:text}).strict()}).strict();

/** Revalidate the sole G5 retained CI row against its live host records and lineage. */
function readCiTestObservation(store:Store,p:CanonicalCiTestObservationPayload,id:string,scope:Scope):RetainedTestObservation|undefined {
 const o=p.observation,source=store.get('sources',o.sourceId),project=store.get('projects',scope.projectId);
 if(!source||!project||o.origin.kind!=='ci'||o.id!==id||o.projectId!==scope.projectId||o.domain!==scope.domain||p.digest!==digest(o)||p.requestHash!==digest(p.request)||digest(source)!==p.sourceHash||knowledgePolicyHash(project)!==p.policyHash||project.projectId!==scope.projectId||project.domain!==scope.domain||o.repository!==project.repository||o.origin.provider!==project.repositoryProvider||o.snapshot.revision!==o.origin.headSha||id!==canonicalCiTestObservationId(o,p.sourceHash,p.policyHash,p.requestHash,p.hostObservationIds))return undefined;
 if(digest(knowledgeRequestSourceRefs(store,source.id,scope,p.request)??[])!==digest(p.sourceRefs))return undefined;
 if(p.request.issueSource){const issue=store.get('sources',p.request.issueSource.id);if(!issue||digest(issue)!==p.issueSourceHash)return undefined;}else if(p.issueSourceHash!==undefined)return undefined;
 const records=p.hostObservationIds.map((hostId,index)=>{const host=readHostObservation(store,hostId,scope);return host&&digest(hostObservationSchema.parse(host))===p.hostObservationHashes[index]?host:undefined;});
 if(records.some(record=>!record))return undefined;
 const hosts=records.filter((record):record is HostObservation=>record!==undefined),origin=o.origin;
 if(!o.checks.every(check=>hosts.some(host=>matchesCiTestCheck(host,o,check))))return undefined;
 if(o.checks.some(check=>origin.provider==='gitlab'?check.id!==`gitlab-job:${origin.jobId}`:!/^github-check-run:[1-9][0-9]*$/.test(check.id)))return undefined;
 if(o.snapshot.files.some(f=>!p.request.filePaths.includes(f.path))||new Set(o.snapshot.files.map(f=>f.path)).size!==o.snapshot.files.length)return undefined;
 if(o.comparable&&(!hosts.some(host=>host.claim.kind==='test-result'&&host.claim.subject.snapshotDigest===o.comparable?.snapshotDigest&&host.claim.subject.testDefinitionDigest===o.comparable?.testDefinitionDigest)||snapshotDigest(o.snapshot)!==o.comparable.snapshotDigest))return undefined;
 return {observation:structuredClone(o),hosts};
}

function matchesCiTestCheck(host:HostObservation,o:TestObservation,check:TestObservation['checks'][number]):boolean {
 const origin=o.origin;if(origin.kind!=='ci'||host.claim.kind!=='ci-result')return false;
 return host.origin.kind==='provider'&&host.origin.provider===origin.provider&&host.origin.producerId===origin.producerId&&host.responseDigest===origin.responseDigest&&host.locator===origin.url&&host.claim.subject.repository===o.repository&&host.claim.subject.headSha===origin.headSha&&host.claim.subject.runId===origin.runId&&host.claim.subject.jobId===origin.jobId&&host.claim.subject.checkName===check.name&&check.result===(host.claim.value.conclusion==='success'?'success':host.claim.value.conclusion==='failure'?'failure':'incomplete');
}

/** One synchronous read validates host bindings once and derives their execution times. */
export function readTestObservationWithTimes(store:Store,id:string,scope:Scope):{observation:TestObservation;times:Map<string,string>}|undefined {return store.readSnapshot(()=>readTestObservationWithTimesBody(store,id,scope));}
function readTestObservationWithTimesBody(store:Store,id:string,scope:Scope):{observation:TestObservation;times:Map<string,string>}|undefined {
 const retained=readRetainedTestObservation(store,id,scope);if(!retained)return undefined;
 const {observation,hosts}=retained,times=new Map<string,string>();
 if(observation.origin.kind==='local'){
  for(const check of observation.checks)if(check.process&&Date.parse(check.process.startedAt)<=Date.parse(check.process.finishedAt))times.set(check.id,check.process.finishedAt);
  return {observation,times};
 }
 for(const check of observation.checks){
  const matched=hosts.filter(host=>matchesCiTestCheck(host,observation,check));
  if(matched.length===1&&matched[0]!.eventAt)times.set(check.id,matched[0]!.eventAt!);
 }
 return {observation,times};
}

export function testObservationExecutionTimes(store:Store,observation:TestObservation,scope:Scope):Map<string,string> {return store.readSnapshot(()=>testObservationExecutionTimesBody(store,observation,scope));}
function testObservationExecutionTimesBody(store:Store,observation:TestObservation,scope:Scope):Map<string,string> {
 const retained=readTestObservationWithTimes(store,observation.id,scope);
 return retained&&digest(retained.observation)===digest(observation)?retained.times:new Map();
}

export function canonicalCiTestObservationId(observation:TestObservation,sourceHash:string,policyHash:string,requestHash:string,hostObservationIds:string[]):string {
 return stableId('canonical-ci-test-observation',{...observation,id:undefined,observedAt:undefined},sourceHash,policyHash,requestHash,hostObservationIds);
}

/** Resolve and validate current host-recorded lineage. Common request/source is not an evidence root. */
export function wellFormedParentSources(value:unknown):value is SourceRef[]|undefined {
 if(value===undefined)return true;
 if(!Array.isArray(value)||value.length>256)return false;
 const ids=new Set<string>();
 return value.every(ref=>{
  if(!ref||typeof ref!=='object'||Array.isArray(ref)||Object.keys(ref).length!==2||!Object.hasOwn(ref,'id')||!Object.hasOwn(ref,'revision')||typeof ref.id!=='string'||!ref.id.trim()||ref.id.length>10000||typeof ref.revision!=='string'||!ref.revision.trim()||ref.revision.length>10000||ids.has(ref.id))return false;
  ids.add(ref.id);return true;
 });
}
export function knowledgeSourceRefs(store:Store,sourceId:string,scope:Scope):SourceRef[]|undefined {
 const visiting=new Set<string>(),all=new Map<string,SourceRef>();
 const visit=(id:string,revision?:string):boolean=>{
  if(visiting.has(id))return false;const s=store.get('sources',id);
  if(!s||s.status!=='active'||s.projectId!==scope.projectId||s.domain!==scope.domain||(revision!==undefined&&s.revision!==revision)||!wellFormedParentSources(s.parentSources))return false;
  if(all.has(id))return all.get(id)!.revision===s.revision;
  visiting.add(id);if(!(s.parentSources??[]).every(p=>visit(p.id,p.revision)))return false;visiting.delete(id);all.set(id,{id:s.id,revision:s.revision});return true;
 };
 return visit(sourceId)?[...all.values()].sort((a,b)=>a.id.localeCompare(b.id)):undefined;
}
/** Bind a read to both the primary source and any authorized issue used by its request. */
export function knowledgeRequestSourceRefs(store:Store,sourceId:string,scope:Scope,request:RepositoryReadRequest,options:{allowExpired?:boolean}={}):SourceRef[]|undefined {
 const primary=knowledgeSourceRefs(store,sourceId,scope);if(!primary)return undefined;
 let issue:SourceRef[]=[];
 if(request.issueSource){
  const source=store.get('sources',request.issueSource.id);
  if(!source||source.revision!==request.issueSource.revision)return undefined;
  const lineage=knowledgeSourceRefs(store,source.id,scope);if(!lineage)return undefined;issue=lineage;
 }
 const all=new Map<string,SourceRef>();
 for(const ref of [...primary,...issue]){const old=all.get(ref.id);if(old&&old.revision!==ref.revision)return undefined;all.set(ref.id,ref);}
 const refs=[...all.values()].sort((a,b)=>a.id.localeCompare(b.id));
 if(!options.allowExpired&&refs.some(ref=>{const source=store.get('sources',ref.id);return source?.retention==='ephemeral'&&!source.content;}))return undefined;
 return refs;
}
export function knowledgeActionDependencies(action:ActionRecord,store?:Store):{refs:SourceRef[];unresolved:boolean} {
 if(action.kind==='decision.evidence'||action.kind==='decision.review'){
  const payload=action.payload as Record<string,unknown>,known:SourceRef[]=[];let unresolved=false;
  const add=(id:unknown,revision:unknown)=>{if(typeof id!=='string'||!id||typeof revision!=='string'||!revision)unresolved=true;else known.push({id,revision});};
  if(payload?.retracted===true){
   if(!Array.isArray(payload.sourceIds))return {refs:[],unresolved:true};
   return {refs:payload.sourceIds.filter((id):id is string=>typeof id==='string'&&!!id).map(id=>({id,revision:''})),unresolved:false};
  }
  const evidence=(value:unknown)=>{
   if(!value||typeof value!=='object'||Array.isArray(value)){unresolved=true;return;}
   const item=value as Record<string,unknown>;add(item.sourceId,item.sourceRevision);
   const attribution=item.attribution as {citations?:unknown}|undefined;
   if(!attribution||!Array.isArray(attribution.citations)){unresolved=true;return;}
   for(const citation of attribution.citations){if(!citation||typeof citation!=='object'||Array.isArray(citation)){unresolved=true;continue;}const c=citation as Record<string,unknown>;add(c.sourceId,c.revision);}
  };
  if(action.kind==='decision.evidence')evidence(payload?.evidence);
  else{
   const review=payload?.review as {sourceRefs?:unknown;evidence?:unknown}|undefined;
   if(!review||!Array.isArray(review.sourceRefs)||!Array.isArray(review.evidence))unresolved=true;
   else{for(const ref of review.sourceRefs){if(!ref||typeof ref!=='object'||Array.isArray(ref)){unresolved=true;continue;}const r=ref as Record<string,unknown>;add(r.id,r.revision);}for(const item of review.evidence)evidence(item);}
  }
  return {refs:[...new Map(known.map(value=>[`${value.id}\0${value.revision}`,value])).values()],unresolved};
 }
 const tombstone=action.kind==='knowledge.factual-context'&&factualContextTombstonePayloadSchema.safeParse(action.payload);
 if(tombstone&&tombstone.success){
  return {refs:tombstone.data.sourceRefs.map(ref=>({id:ref.id,revision:''})),
   unresolved:!store||!validAuditRefs(store,action,tombstone.data,true)};
 }
 if(!['knowledge.host-observation','knowledge.evidence-link','knowledge.structured-ingest','knowledge.factual-context','experience.test-observation','experience.evidence-link'].includes(action.kind))return {refs:[],unresolved:false};
 if(!action.payload||typeof action.payload!=='object'||Array.isArray(action.payload))return {refs:[],unresolved:true};
 // A valid source ID is useful for privacy even when its revision cannot admit a fact.
 const payload=action.payload as Record<string,unknown>,candidates:unknown[]=[payload.sourceRefs];let unresolved=false;
 if(action.kind==='knowledge.factual-context'&&!canonicalFactualContextPayloadSchema.safeParse(payload).success)unresolved=true;
 if(action.kind==='knowledge.structured-ingest'&&Object.keys(payload).some(key=>!['schemaVersion','sourceId','sourceRevision','sourceHash','sourceRefs','phase','tries','runAfter','errorCode'].includes(key)))unresolved=true;
 if(action.kind==='experience.test-observation'&&!canonicalCiTestPayloadSchema.safeParse(payload).success&&!localTestPayload.safeParse(payload).success)unresolved=true;
 if(action.kind==='experience.evidence-link'){
  const parsed=canonicalExperiencePayloadSchema.safeParse(payload),origin=normalizationOriginPayloadSchema.safeParse(payload);
  if(parsed.success)candidates.push([{id:parsed.data.association.sourceId,revision:parsed.data.association.sourceRevision},{id:parsed.data.association.relevance.recordSourceId,revision:parsed.data.association.relevance.recordRevision}]);
  else if(origin.success)candidates.push([{id:origin.data.normalizationOrigin.sourceId,revision:origin.data.normalizationOrigin.sourceRevision}]);
  else unresolved=true;
 }
 for(const key of ['observation','link'])if(key in payload && action.kind!=='experience.test-observation'){
  const value=payload[key];
  if(!value||typeof value!=='object'||Array.isArray(value)||!('sourceRefs' in value))unresolved=true;
  else candidates.push((value as Record<string,unknown>).sourceRefs);
 }
 if(action.kind==='knowledge.structured-ingest')candidates.push([{id:payload.sourceId,revision:payload.sourceRevision}]);
 if(action.kind==='experience.test-observation'){
  const o=payload.observation;
  if(!o||typeof o!=='object'||Array.isArray(o))unresolved=true;
  else {const v=o as Record<string,unknown>;candidates.push([{id:v.sourceId,revision:v.sourceRevision}]);}
 }
 const known:SourceRef[]=[];
 for(const raw of candidates){
  if(!Array.isArray(raw)||!raw.length){unresolved=true;continue;}
  for(const value of raw){
   if(!value||typeof value!=='object'||Array.isArray(value)||!text.safeParse((value as Record<string,unknown>).id).success){unresolved=true;continue;}
   const item=value as {id:string;revision?:unknown};if(['knowledge.structured-ingest','experience.test-observation','experience.evidence-link'].includes(action.kind)&&!text.safeParse(item.revision).success)unresolved=true;known.push({id:item.id,revision:typeof item.revision==='string'?item.revision:''});
  }
 }
 return {refs:[...new Map(known.map(value=>[`${value.id}\0${value.revision}`,value])).values()],unresolved};
}
export function knowledgeActionSourceRefs(action:ActionRecord):SourceRef[] {return knowledgeActionDependencies(action).refs;}
/** Bind all normalized facts and origin metadata; repeated read timestamps do not mint executions. */
export function hostObservationId(o:HostObservation):string {
 return stableId('canonical-host-observation',o.origin.originalEventId,{...o,id:undefined,observedAt:undefined});
}
/** Validate the retained envelope without relying on current policy or source liveness. */
export function readCanonicalHostRecord(row:ActionRecord):CanonicalHostObservationPayload|undefined {
 if(row.kind!=='knowledge.host-observation'||row.status!=='completed')return undefined;
 const parsed=canonicalHostPayloadSchema.safeParse(row.payload);if(!parsed.success)return undefined;
 // Hashes bind the serialized producer object; schema parsing may reorder keys.
 const p=row.payload as unknown as CanonicalHostObservationPayload,o=p.observation;
 if(o.id!==row.id||hostObservationId(o)!==row.id||o.projectId!==row.projectId||o.domain!==row.domain||p.digest!==digest(o)||p.requestHash!==digest(p.request)||digest(o.sourceRefs)!==digest(p.sourceRefs)||o.bindingHash!==digest({source:p.sourceHash,policy:p.policyHash,request:p.request,...(p.issueSourceHash?{issueSourceHash:p.issueSourceHash}:{})}))return undefined;
 return p;
}
function respectsHistoricalExecutions(request:CanonicalHostObservationPayload['request'],execution:{headSha:string;runId:string;jobId:string;checkName:string}):boolean {
 return request.checks.every(check=>
  (check.runId!==execution.runId||request.headSha===execution.headSha)&&
  (check.jobId!==execution.jobId||(check.runId===execution.runId&&request.headSha===execution.headSha&&check.checkName===execution.checkName))
 );
}
export function readHostObservation(store:Store,id:string,scope:Scope):HostObservation|undefined {return store.readSnapshot(()=>readHostObservationBody(store,id,scope));}
function readHostObservationBody(store:Store,id:string,scope:Scope):HostObservation|undefined {
 const row=store.get('actions',id);
 if(!row||row.kind!=='knowledge.host-observation'||row.status!=='completed'||row.projectId!==scope.projectId||row.domain!==scope.domain)return referenceExperienceObservation(store,id,scope);
 if(isRetractedHostObservation(store,row))return undefined;
 const p=readCanonicalHostRecord(row);if(!p)return undefined;
 const o=p.observation,sourceId=p.sourceRefs.find(r=>digest({source:p.sourceHash,policy:p.policyHash,request:p.request,...(p.issueSourceHash?{issueSourceHash:p.issueSourceHash}:{})})===o.bindingHash&&store.get('sources',r.id)&&digest(store.get('sources',r.id)!)===p.sourceHash)?.id;
 const source=sourceId?store.get('sources',sourceId):undefined,project=store.get('projects',scope.projectId);
 if(!source||!project||project.projectId!==scope.projectId||project.domain!==scope.domain||o.projectId!==scope.projectId||o.domain!==scope.domain||o.id!==id||id!==hostObservationId(o)||p.digest!==digest(o)||p.requestHash!==digest(p.request)||knowledgePolicyHash(project)!==p.policyHash||o.origin.repository!==project.repository||o.claim.subject.repository!==project.repository||o.claim.subject.provider!==project.repositoryProvider||digest(o.sourceRefs)!==digest(p.sourceRefs)||digest(knowledgeRequestSourceRefs(store,source.id,scope,p.request)??[])!==digest(p.sourceRefs))return undefined;
 if(p.request.issueSource){const issue=store.get('sources',p.request.issueSource.id);if(!issue||!p.issueSourceHash||digest(issue)!==p.issueSourceHash)return undefined;}
 else if(p.issueSourceHash!==undefined)return undefined;
 try{
  assertKnowledgeSource(store,source,project);
  const parsedSource=parseStructuredKnowledge(source,project);if(!parsedSource)return undefined;
  const expected=structuredRepositoryRequest(store,source,project,parsedSource),request=p.request;
  if(request.repository!==expected.repository||request.headSha!==expected.headSha||request.changeNumber!==expected.changeNumber||
    JSON.stringify(request.checks)!==JSON.stringify(expected.checks)||JSON.stringify(request.issueSource??null)!==JSON.stringify(expected.issueSource??null)||
    (request.testReportPath!==undefined&&request.testReportPath!==expected.testReportPath)||
    (parsedSource.kind==='experience'&&JSON.stringify(request.filePaths)!==JSON.stringify(expected.filePaths))||
    request.filePaths.some(path=>Buffer.byteLength(path)>1024||!pathAllowed(path,project.allowedPaths))||
    request.checks.some(c=>!project.trustedChecks.includes(c.checkName))||
    request.current?.checkNames.some(name=>!project.trustedChecks.includes(name)))return undefined;
 }catch(error){if(isKnowledgeSnapshotFailure(error))throw error;return undefined;}
 const claim=o.claim,origin=o.origin,provider=project.repositoryProvider;
 const root=origin.originalEventId.match(new RegExp(`^${provider}:([1-9][0-9]*):(.*)$`));
 if(!root||!Number.isSafeInteger(Number(root[1]))||origin.kind!=='provider'||origin.provider!==provider||
   origin.independentOrigin!==`${provider}:${root[1]}:producer:${origin.producerId}`||
   JSON.stringify(origin.derivedFrom)!==JSON.stringify(p.sourceRefs.filter(r=>r.id!==source.id).map(r=>`source:${r.id}:${r.revision}`)))return undefined;
 if(claim.kind==='change-head'){
  if(origin.producerId!=='repository'||root[2]!==`${provider==='github'?'pull':'mr'}:${claim.subject.number}`||
    claim.subject.number!==p.request.changeNumber&&claim.subject.number!==p.request.current?.changeNumber)return undefined;
 }else if(claim.kind==='commit-exists'){
  if(origin.producerId!=='repository'||claim.subject.sha!==p.request.headSha||root[2]!==`commit:${claim.subject.sha}`)return undefined;
 }else{
  if(!/^[1-9][0-9]*$/.test(origin.producerId)||!project.trustedAppIds.includes(Number(origin.producerId)))return undefined;
  const rootPrefix=provider==='github'?'run':'pipeline';
  if(claim.kind==='ci-result'){
   const {headSha,runId,jobId,checkName}=claim.subject;
   if(root[2]!==`${rootPrefix}:${runId}:job:${jobId}`)return undefined;
   // A known run fixes its head; a known job fixes its run, head, and check.
   if(!respectsHistoricalExecutions(p.request,{headSha,runId,jobId,checkName}))return undefined;
   const historical=headSha===p.request.headSha&&p.request.checks.some(c=>c.runId===runId&&c.jobId===jobId&&c.checkName===checkName);
   if(!historical){
    if(!p.request.current?.checkNames.includes(checkName))return undefined;
    const currentHead=store.hostObservationActions(scope,p.sourceHash,p.requestHash,'change-head').some(a=>{
     if(a.kind!=='knowledge.host-observation'||a.id===id||a.projectId!==scope.projectId||a.domain!==scope.domain)return false;
     const candidate=canonicalHostPayloadSchema.safeParse(a.payload);
     if(!candidate.success||candidate.data.sourceHash!==p.sourceHash||candidate.data.requestHash!==p.requestHash||candidate.data.observation.claim.kind!=='change-head')return false;
     const current=readHostObservation(store,a.id,scope);
     return current?.claim.kind==='change-head'&&current.origin.originalEventId.startsWith(`${provider}:${root[1]}:`)&&current.claim.subject.number===p.request.current!.changeNumber&&current.claim.value.headSha===headSha;
    });
    if(!currentHead)return undefined;
   }
  }else{
   if(claim.subject.testedRevision!==p.request.headSha||!p.request.checks.some(c=>root[2]===`${rootPrefix}:${c.runId}:job:${c.jobId}`))return undefined;
  }
 }
 if(o.claim.kind==='test-result'){
  const a=p.attestation;if(!a||a.producerId!==o.origin.producerId||a.originalEventId!==o.origin.originalEventId||a.snapshotDigest!==o.claim.subject.snapshotDigest||a.testDefinitionDigest!==o.claim.subject.testDefinitionDigest||a.reportPath!==p.request.testReportPath||o.responseDigest!==a.reportDigest)return undefined;
  if(provider!=='gitlab'||o.claim.value.result!=='success'||p.request.checks.length!==1)return undefined;
  const testedRevision=o.claim.subject.testedRevision;
  const related=store.hostObservationActions(scope,p.sourceHash,p.requestHash,'ci-result',origin.originalEventId).flatMap(row=>{
   if(row.kind!=='knowledge.host-observation'||row.id===id||row.projectId!==scope.projectId||row.domain!==scope.domain)return [];
   const candidate=canonicalHostPayloadSchema.safeParse(row.payload);
   if(!candidate.success||candidate.data.sourceHash!==p.sourceHash||candidate.data.requestHash!==p.requestHash||candidate.data.observation.origin.originalEventId!==origin.originalEventId||candidate.data.observation.claim.kind!=='ci-result')return [];
   const retained=readHostObservation(store,row.id,scope);return retained?.claim.kind==='ci-result'?[retained]:[];
  });
  if(!related.some(ci=>ci.claim.kind==='ci-result'&&ci.claim.value.conclusion==='success')||related.some(ci=>ci.claim.kind!=='ci-result'||ci.origin.producerId!==origin.producerId||ci.origin.independentOrigin!==origin.independentOrigin||ci.claim.subject.headSha!==testedRevision||ci.claim.value.conclusion==='failure'||ci.claim.value.conclusion==='cancelled'))return undefined;
 }else if(o.origin.kind!=='provider'||p.attestation)return undefined;
 return structuredClone(o);
}
/** Project the same retained local run; never persist a second countable event. */
export function referenceExperienceObservation(store:Store,observationId:string,requestedScope?:Scope):HostObservation|undefined {return store.readSnapshot(()=>referenceExperienceObservationBody(store,observationId,requestedScope));}
function referenceExperienceObservationBody(store:Store,observationId:string,requestedScope?:Scope):HostObservation|undefined {
 try{
  const row=store.get('actions',observationId);if(!row)return undefined;const scope={projectId:requestedScope?.projectId??row.projectId,domain:requestedScope?.domain??row.domain};
  const o=readTestObservation(store,observationId,scope),a=row.payload.accepted as AcceptedLocalProvenance|undefined,project=store.get('projects',scope.projectId);
  if(!o||!a||!project||!o.comparable||o.origin.kind!=='local'||o.snapshot.revision.length!==40||o.comparable.snapshotDigest!==snapshotDigest(o.snapshot)||!o.checks.length)return undefined;
  const sourceRefs=knowledgeSourceRefs(store,o.sourceId,scope);if(!sourceRefs)return undefined;
  const result=o.checks.some(c=>c.result==='failure')?'failure':o.checks.every(c=>c.result==='success')?'success':'incomplete';
  return {...scope,schemaVersion:1,id:o.id,claim:{kind:'test-result',subject:{provider:project.repositoryProvider,repository:o.repository,testedRevision:o.snapshot.revision,...o.comparable},value:{result}},
   origin:{kind:'host-test',repository:o.repository,producerId:`${a.provider}:${a.runner}`,originalEventId:`local:${a.attemptId}:${a.runId}`,independentOrigin:`local:${a.provider}:${a.runner}`,derivedFrom:sourceRefs.filter(r=>r.id!==o.sourceId).map(r=>`source:${r.id}:${r.revision}`)},
   sourceRefs,responseDigest:digest(o),locator:`local-run:${a.runId}`,observedAt:o.observedAt,bindingHash:digest(a)};
 }catch(error){if(isKnowledgeSnapshotFailure(error))throw error;return undefined;}
}
