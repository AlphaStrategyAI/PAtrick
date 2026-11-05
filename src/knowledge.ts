import { DomainError, digest, knowledgeOutputSchema, now, stableId, type KnowledgeCard, type SourceRevision } from './domain.js';
import type { AtomicClaim, ParsedStructuredKnowledge, RequestedRepositoryClaim } from './knowledge-contract.js';
import { knowledgeCandidateHash } from './knowledge-identity.js';
import { acceptRepositoryReadback, linkKnowledgeEvidence } from './knowledge-evidence.js';
import { enqueueStructuredKnowledge, structuredIngestJobSchema, structuredKnowledgeCardId, structuredKnowledgeJobId, validStructuredJobRefs, type StructuredIngestJobV1 } from './knowledge-jobs.js';
import { knowledgeRequestSourceRefs, knowledgeSourceRefs, readHostObservation } from './knowledge-records.js';
import { assertKnowledgeSource, parseStructuredKnowledge, structuredRepositoryRequest } from './structured-knowledge.js';
import type { RepositoryKnowledgeReader } from './integrations/repository-knowledge.js';
import type { Store } from './store.js';

export function publishKnowledge(store: Store, source: SourceRevision, output: unknown): KnowledgeCard[] {
  return publish(store,source,output,false);
}
function publish(store:Store,source:SourceRevision,output:unknown,structured:boolean):KnowledgeCard[] {
  const parsed = knowledgeOutputSchema.parse(output);
  const current = store.get('sources', source.id);
  if (current?.status !== 'active' || current.revision !== source.revision) throw new DomainError('Knowledge extraction refers to an obsolete source.', 'stale_source', 409);
  const cards = parsed.cards.map(candidate => {
    if (!source.content.includes(candidate.quote)) throw new DomainError('An extracted quote is absent from the authorized source.', 'invalid_quote');
    if (candidate.kind === 'experience' && candidate.experience?.productId !== source.projectId) throw new DomainError('Experience product must match its authorized project.', 'scope', 403);
    const aliases = [...new Set([...candidate.aliases, ...(candidate.experience?.symptomAliases ?? [])].map(value => value.trim()).filter(Boolean))];
    const identity={sourceId:source.id,sourceRevision:source.revision,kind:candidate.kind,title:candidate.title,quote:candidate.quote};
    return { ...candidate, aliases, id: structured?structuredKnowledgeCardId(identity):stableId('card', source.id, source.revision, candidate.kind, candidate.title, candidate.quote), projectId: source.projectId, domain: source.domain, sourceId: source.id, sourceRevision: source.revision, locator: source.locator, status: 'active' as const, createdAt: now() };
  });
  for (const card of cards) {
    const existing=store.get('cards',card.id);
    if (!existing || structured&&existing.status==='withdrawn') store.save('cards',card);
  }
  return cards;
}

export interface StructuredKnowledgeProcessOptions {
  refresh?: 'current';
  readbackUnavailableReason?: 'repository_reader_unavailable' | 'host_egress_unavailable';
}
type Candidate = {title:string;body:string;quote:string;aliases:string[];verification:'reported';kind:'fact'|'experience';experience?:Extract<ParsedStructuredKnowledge,{kind:'experience'}>['input']['details'];pendingClaim?:RequestedRepositoryClaim};

function proposedCandidates(source:SourceRevision,parsed:ParsedStructuredKnowledge):Candidate[] {
 const input=parsed.input, candidates:Candidate[]=[];
 const add=(title:string,pendingClaim:RequestedRepositoryClaim)=>candidates.push({title,body:'Repository locator supplied by the source; its state requires authenticated readback.',quote:input.quote,aliases:[],verification:'reported',kind:'fact',pendingClaim});
 if(parsed.kind==='experience')candidates.push({title:source.title,body:parsed.input.details.problem,quote:input.quote,aliases:parsed.input.details.symptomAliases,verification:'reported',kind:'experience',experience:parsed.input.details});
 if(parsed.kind==='repository-facts'&&parsed.input.changeNumber!==undefined)add(`Change ${parsed.input.changeNumber}`,{kind:'change-head',repository:input.repository,number:parsed.input.changeNumber});
 add(`Commit ${input.headSha}`,{kind:'commit-exists',repository:input.repository,sha:input.headSha});
 const checks=parsed.kind==='repository-facts'?parsed.input.checks:parsed.input.checkIds.map(checkName=>({runId:parsed.input.runId,jobId:parsed.input.jobId,checkName}));
 for(const check of checks)add(`CI ${check.runId}/${check.jobId} ${check.checkName}`,{kind:'ci-result',repository:input.repository,headSha:input.headSha,...check});
 return candidates;
}
function matches(locator:RequestedRepositoryClaim,claim:AtomicClaim):boolean {
 if(locator.kind!==claim.kind||locator.repository!==claim.subject.repository)return false;
 if(locator.kind==='change-head'&&claim.kind==='change-head')return locator.number===claim.subject.number;
 if(locator.kind==='commit-exists'&&claim.kind==='commit-exists')return locator.sha===claim.subject.sha;
 if(locator.kind==='ci-result'&&claim.kind==='ci-result')return locator.headSha===claim.subject.headSha&&locator.runId===claim.subject.runId&&locator.jobId===claim.subject.jobId&&locator.checkName===claim.subject.checkName;
 return false;
}
function updateJob(store:Store,id:string,mutate:(job:StructuredIngestJobV1)=>StructuredIngestJobV1,status:'pending'|'completed'):void {
 const action=store.get('actions',id),result=action&&structuredIngestJobSchema.safeParse(action.payload);
 if(!action||action.kind!=='knowledge.structured-ingest'||action.status!=='pending'||!result||!result.success)return;
 store.save('actions',{...action,status,payload:mutate(result.data) as unknown as Record<string,unknown>,updatedAt:now()});
}

/** Stop waiting even if an adapter ignores abort; its eventual handoff cannot commit. */
function untilAborted<T>(operation:Promise<T>,signal:AbortSignal):Promise<T> {
 return new Promise((resolve,reject)=>{
  const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
  signal.addEventListener('abort',abort,{once:true});
  operation.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  if(signal.aborted)abort();
 });
}

/** One host-only processor; the authenticated readback never crosses a synchronous transaction. */
export async function ingestStructuredKnowledge(store:Store,reader:RepositoryKnowledgeReader|undefined,sourceId:string,signal:AbortSignal,options:StructuredKnowledgeProcessOptions={}):Promise<'ordinary'|'processed'|'pending'> {
 const source=store.get('sources',sourceId),project=source&&store.get('projects',source.projectId);
 if(!source||!project)throw new DomainError('Knowledge source is unavailable.','stale_source',409);
 assertKnowledgeSource(store,source,project);
 const acceptedHash=store.get('cursors',stableId('source-hash',source.id))?.value;
 if(acceptedHash&&acceptedHash!==digest(source.content))throw new DomainError('Knowledge source content changed.','stale_source',409);
 const ancestry=knowledgeSourceRefs(store,source.id,project);
 if(!ancestry||ancestry.some(ref=>{const dependency=store.get('sources',ref.id);return dependency?.retention==='ephemeral'&&!dependency.content;}))throw new DomainError('Temporary source has expired.','ephemeral_expired',409);
 const refresh=options.refresh==='current',id=structuredKnowledgeJobId(source);
 if(!refresh)enqueueStructuredKnowledge(store,source);
 let action=store.get('actions',id),job=action&&structuredIngestJobSchema.safeParse(action.payload);
 if(!refresh&&(!action||action.kind!=='knowledge.structured-ingest'||!job||!job.success))throw new DomainError('Structured ingest job is unavailable.','stale_source',409);
 if(!refresh&&job?.success&&(action!.projectId!==project.id||action!.domain!==project.domain||job.data.sourceId!==source.id||job.data.sourceRevision!==source.revision||job.data.sourceHash!==digest(source.content)||!validStructuredJobRefs(store,source,job.data.sourceRefs)))throw new DomainError('Structured ingest job changed.','stale_source',409);
 if(!refresh&&action?.status==='completed'){
  if(job!.success&&job!.data.phase==='ordinary')return 'ordinary';
  if(job!.success&&job!.data.phase==='processed')return 'processed';
  throw new DomainError('Invalid structured knowledge envelope.','invalid_structured_knowledge',400);
 }
 let parsed:ParsedStructuredKnowledge|undefined;
 try{parsed=parseStructuredKnowledge(source,project);if(parsed?.kind==='experience'&&parsed.input.details.productId!==project.id)throw new DomainError('Invalid structured knowledge envelope.','invalid_structured_knowledge',400);}catch(error){
  if(!refresh)store.transaction(()=>{assertKnowledgeSource(store,source,project);updateJob(store,id,j=>({...j,phase:'invalid',errorCode:'invalid_structured_knowledge'}),'completed');});
  throw error;
 }
 if(!parsed){if(!refresh)store.transaction(()=>{assertKnowledgeSource(store,source,project);updateJob(store,id,j=>({...j,phase:'ordinary',errorCode:undefined}),'completed');});return 'ordinary';}
 const selected=parsed;
 const request=structuredRepositoryRequest(store,source,project,selected);
 if(refresh){
  if(selected.kind!=='repository-facts'||selected.input.changeNumber===undefined)throw new DomainError('Current readback needs an authorized change locator.','invalid_structured_knowledge',400);
  request.current={changeNumber:selected.input.changeNumber,checkNames:[...project.trustedChecks]};
 }
 const issue=request.issueSource&&store.get('sources',request.issueSource.id);
 if(request.issueSource&&(!issue||issue.revision!==request.issueSource.revision))throw new DomainError('Issue source changed.','stale_source',409);
 const requestRefs=knowledgeRequestSourceRefs(store,source.id,project,request,{allowExpired:true});if(!requestRefs)throw new DomainError('Knowledge dependencies changed.','stale_source',409);
 const dependenciesAvailable=!!knowledgeRequestSourceRefs(store,source.id,project,request)&&requestRefs.every(ref=>{const dependency=store.get('sources',ref.id),hash=store.get('cursors',stableId('source-hash',ref.id))?.value;return !!dependency&&(!hash||hash===digest(dependency.content));});
 if(!refresh&&job?.success&&digest(job.data.sourceRefs)!==digest(requestRefs)){
  if(digest(job.data.sourceRefs)!==digest(ancestry))throw new DomainError('Knowledge dependencies changed.','stale_source',409);
  store.transaction(()=>{assertKnowledgeSource(store,source,project);if(issue)assertKnowledgeSource(store,issue,project);
   const live=store.get('actions',id);if(!live||!action||digest(live)!==digest(action))throw new DomainError('Structured ingest job changed.','stale_source',409);
   store.save('actions',{...live,payload:{...job!.data,sourceRefs:requestRefs},updatedAt:now()});
  });
  action=store.get('actions',id);job=action&&structuredIngestJobSchema.safeParse(action.payload);
 }
 const pending=(errorCode:string)=>{
  if(!refresh)store.transaction(()=>{
   const current=store.get('sources',source.id),liveJob=store.get('actions',id);
   if(!liveJob||!action||digest(liveJob)!==digest(action))return;
   if(!current||digest(current)!==digest(source)){
    store.save('actions',{...liveJob,status:'completed',payload:{phase:'invalid',errorCode:'source_invalidated',retracted:true,sourceIds:[source.id]},updatedAt:now()});return;
   }
   updateJob(store,id,j=>({...j,phase:'pending-readback',tries:j.tries+1,runAfter:new Date(Date.now()+30_000).toISOString(),errorCode}),'pending');
  });
  return 'pending' as const;
 };
 // A locator that never resolved remains only a reported locator. A known
 // revoked or unauthorized issue cannot be silently downgraded to that case.
 const knownIssue=selected.kind==='experience'&&selected.input.issueId?store.get('sources',selected.input.issueId):undefined;
 if(knownIssue&&!request.issueSource)return pending('source_dependency_unavailable');
 // A known but expired dependency cannot authorize a readable derivative.
 if(!dependenciesAvailable)return pending('source_dependency_unavailable');
 const cards=store.transaction(()=>{
  assertKnowledgeSource(store,source,project);if(issue)assertKnowledgeSource(store,issue,project);
  const published=publish(store,source,{cards:proposedCandidates(source,selected)},true);
  return published.map(c=>{
   const actual=store.get('cards',c.id);
   if(!actual||actual.status!=='active'||actual.sourceId!==source.id||actual.sourceRevision!==source.revision||actual.id!==structuredKnowledgeCardId(actual))throw new DomainError('Knowledge candidate changed.','stale_source',409);
   if(c.pendingClaim){
    if(actual.pendingClaim&&digest(actual.pendingClaim)!==digest(c.pendingClaim)||actual.claim&&!matches(c.pendingClaim,actual.claim.claim)||!actual.pendingClaim&&!actual.claim)throw new DomainError('Knowledge candidate changed.','stale_source',409);
   }else if(actual.pendingClaim||actual.claim)throw new DomainError('Knowledge candidate changed.','stale_source',409);
   if(knowledgeCandidateHash({...actual,claim:undefined,pendingClaim:c.pendingClaim})!==knowledgeCandidateHash(c))throw new DomainError('Knowledge candidate changed.','stale_source',409);
   store.save('cards',actual);return {id:actual.id,hash:knowledgeCandidateHash(actual)};
  });
 });
 if(!reader)return pending(options.readbackUnavailableReason??'repository_reader_unavailable');
 try{
  signal.throwIfAborted();const readback=await untilAborted(reader.read(project,source,request,signal),signal);signal.throwIfAborted();
  store.transaction(()=>{
   assertKnowledgeSource(store,source,project);if(issue)assertKnowledgeSource(store,issue,project);
   const liveJob=store.get('actions',id);
   if(!refresh&&(!liveJob||!action||digest(liveJob)!==digest(action)))throw new DomainError('Structured ingest job changed.','stale_source',409);
   const reparsed=parseStructuredKnowledge(source,project);
   if(!reparsed||digest(reparsed)!==digest(selected)||digest(structuredRepositoryRequest(store,source,project,selected))!==digest({...request,current:undefined}))throw new DomainError('Knowledge request changed.','stale_source',409);
   for(const c of cards){const current=store.get('cards',c.id);if(!current||current.status!=='active'||knowledgeCandidateHash(current)!==c.hash)throw new DomainError('Knowledge candidate changed.','stale_source',409);}
   const ids=acceptRepositoryReadback(store,source.id,readback);
   const observations=ids.map(observationId=>readHostObservation(store,observationId,project)).filter(o=>o!==undefined);
   for(const c of cards){const current=store.get('cards',c.id)!;if(!current.pendingClaim)continue;const found=observations.find(o=>matches(current.pendingClaim!,o.claim));if(!found)continue;
    const next={...current,claim:{schemaVersion:1 as const,claim:found.claim,quote:current.quote,interpretation:'reported' as const}};delete next.pendingClaim;store.save('cards',next);linkKnowledgeEvidence(store,next.id,[found.id]);
   }
   if(!refresh)updateJob(store,id,j=>({...j,phase:'processed',errorCode:undefined}),'completed');
  });
  return 'processed';
 }catch{return pending('repository_readback_failed');}
}
