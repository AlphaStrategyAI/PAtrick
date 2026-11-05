import { digest, pathAllowed, stableId, type Scope, type ActionRecord } from './domain.js';
import type { Store } from './store.js';
import { z } from 'zod';
import { atomicClaimSchema, observedProcessSchema, type TestObservation, type HostObservation, type SourceRef, type RepositoryReadRequest, type CanonicalHostObservationPayload, type CanonicalKnowledgeEvidencePayload, type CanonicalCiTestObservationPayload } from './knowledge-contract.js';
import { snapshotDigest, knowledgePolicyHash } from './knowledge-identity.js';
import { assertKnowledgeSource, parseStructuredKnowledge, structuredRepositoryRequest } from './structured-knowledge.js';

export interface AcceptedLocalProvenance {
 attemptId:string;taskId:string;taskVersion:number;role:'execute'|'check';runner:string;provider:string;model:string;
 inputHash:string;outputHash:string;planHash:string;artifactHash:string;runId:string;sourceHash:string;policyHash:string;
}

/** Read retained accepted facts, independently of the task's later workflow. */
export function readTestObservation(store:Store,id:string,scope:Scope):TestObservation|undefined {
 const row=store.get('actions',id);
 if(!row||row.kind!=='experience.test-observation'||row.status!=='completed'||row.projectId!==scope.projectId||row.domain!==scope.domain)return undefined;
 const p=row.payload,o=p.observation as TestObservation|undefined,a=p.accepted as AcceptedLocalProvenance|undefined;
 if(p.schemaVersion!==1||!o||!a||o.schemaVersion!==1||o.id!==id||o.projectId!==scope.projectId||o.domain!==scope.domain||o.origin.kind!=='local'||p.digest!==digest(o)||p.acceptedDigest!==digest(a)||id!==stableId('local-test-observation',a.runId,digest(o.origin),digest({...o,id:''})))return undefined;
 const origin=o.origin;
 if(origin.attemptId!==a.attemptId||origin.taskId!==a.taskId||origin.taskVersion!==a.taskVersion||origin.inputHash!==a.inputHash||origin.planHash!==a.planHash||origin.artifactHash!==a.artifactHash||origin.runId!==a.runId||origin.role!==a.role)return undefined;
 const attempt=store.get('attempts',a.attemptId),source=store.get('sources',o.sourceId),project=store.get('projects',scope.projectId);
 if(!attempt||attempt.status!=='succeeded'||attempt.projectId!==scope.projectId||attempt.domain!==scope.domain||attempt.taskId!==a.taskId||attempt.taskVersion!==a.taskVersion||attempt.role!==a.role||attempt.runner!==a.runner||attempt.provider!==a.provider||attempt.model!==a.model||attempt.inputHash!==a.inputHash||!source||source.status!=='active'||source.revision!==o.sourceRevision||source.projectId!==scope.projectId||source.domain!==scope.domain||digest(source)!==a.sourceHash||!project||project.projectId!==scope.projectId||project.domain!==scope.domain||project.repository!==o.repository||knowledgePolicyHash(project)!==a.policyHash)return undefined;
 if(JSON.stringify(p.sourceRefs)!==JSON.stringify([{id:source.id,revision:source.revision}]))return undefined;
 return structuredClone(o);
}

// Canonical repository payload validation stays transport-free and Store is type-only.
const text=z.string().min(1).max(10000),hash=z.string().regex(/^[a-f0-9]{64}$/),time=z.string().datetime({offset:true});
const ref=z.object({id:text,revision:text}).strict();
const refs=z.array(ref).min(1).max(256);
const scope={projectId:text,domain:text};
export const hostObservationSchema:z.ZodType<HostObservation>=z.object({schemaVersion:z.literal(1),id:text,...scope,claim:atomicClaimSchema,
 origin:z.object({kind:z.enum(['provider','host-test']),provider:z.enum(['github','gitlab']).optional(),repository:text,producerId:text,originalEventId:text,independentOrigin:text,derivedFrom:z.array(text).max(256)}).strict(),
 sourceRefs:refs,responseDigest:hash,locator:text,observedAt:time,eventAt:time.optional(),bindingHash:hash}).strict();
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
export function canonicalCiTestObservationId(observation:TestObservation,sourceHash:string,policyHash:string,requestHash:string,hostObservationIds:string[]):string {
 return stableId('canonical-ci-test-observation',{...observation,id:undefined,observedAt:undefined},sourceHash,policyHash,requestHash,hostObservationIds);
}

/** Resolve and validate current host-recorded lineage. Common request/source is not an evidence root. */
export function knowledgeSourceRefs(store:Store,sourceId:string,scope:Scope):SourceRef[]|undefined {
 const visiting=new Set<string>(),all=new Map<string,SourceRef>();
 const visit=(id:string,revision?:string):boolean=>{
  if(visiting.has(id))return false;const s=store.get('sources',id);
  if(!s||s.status!=='active'||s.projectId!==scope.projectId||s.domain!==scope.domain||(revision!==undefined&&s.revision!==revision))return false;
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
export function knowledgeActionDependencies(action:ActionRecord):{refs:SourceRef[];unresolved:boolean} {
 if(!['knowledge.host-observation','knowledge.evidence-link','knowledge.structured-ingest','experience.test-observation'].includes(action.kind))return {refs:[],unresolved:false};
 if(!action.payload||typeof action.payload!=='object'||Array.isArray(action.payload))return {refs:[],unresolved:true};
 // A valid source ID is useful for privacy even when its revision cannot admit a fact.
 const payload=action.payload as Record<string,unknown>,candidates:unknown[]=[payload.sourceRefs];let unresolved=false;
 if(action.kind==='knowledge.structured-ingest'&&Object.keys(payload).some(key=>!['schemaVersion','sourceId','sourceRevision','sourceHash','sourceRefs','phase','tries','runAfter','errorCode'].includes(key)))unresolved=true;
 if(action.kind==='experience.test-observation'&&!canonicalCiTestPayloadSchema.safeParse(payload).success&&!localTestPayload.safeParse(payload).success)unresolved=true;
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
   const item=value as {id:string;revision?:unknown};if(['knowledge.structured-ingest','experience.test-observation'].includes(action.kind)&&!text.safeParse(item.revision).success)unresolved=true;known.push({id:item.id,revision:typeof item.revision==='string'?item.revision:''});
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
export function readHostObservation(store:Store,id:string,scope:Scope):HostObservation|undefined {
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
 }catch{return undefined;}
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
    const currentHead=store.list('actions').some(a=>{
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
  const related=store.list('actions').flatMap(row=>{
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
export function referenceExperienceObservation(store:Store,observationId:string,requestedScope?:Scope):HostObservation|undefined {
 try{
  const row=store.get('actions',observationId);if(!row)return undefined;const scope={projectId:requestedScope?.projectId??row.projectId,domain:requestedScope?.domain??row.domain};
  const o=readTestObservation(store,observationId,scope),a=row.payload.accepted as AcceptedLocalProvenance|undefined,project=store.get('projects',scope.projectId);
  if(!o||!a||!project||!o.comparable||o.origin.kind!=='local'||o.snapshot.revision.length!==40||o.comparable.snapshotDigest!==snapshotDigest(o.snapshot)||!o.checks.length)return undefined;
  const sourceRefs=knowledgeSourceRefs(store,o.sourceId,scope);if(!sourceRefs)return undefined;
  const result=o.checks.some(c=>c.result==='failure')?'failure':o.checks.every(c=>c.result==='success')?'success':'incomplete';
  return {...scope,schemaVersion:1,id:o.id,claim:{kind:'test-result',subject:{provider:project.repositoryProvider,repository:o.repository,testedRevision:o.snapshot.revision,...o.comparable},value:{result}},
   origin:{kind:'host-test',repository:o.repository,producerId:`${a.provider}:${a.runner}`,originalEventId:`local:${a.attemptId}:${a.runId}`,independentOrigin:`local:${a.provider}:${a.runner}`,derivedFrom:sourceRefs.filter(r=>r.id!==o.sourceId).map(r=>`source:${r.id}:${r.revision}`)},
   sourceRefs,responseDigest:digest(o),locator:`local-run:${a.runId}`,observedAt:o.observedAt,bindingHash:digest(a)};
 }catch{return undefined;}
}
