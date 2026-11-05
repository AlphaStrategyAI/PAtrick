import { DomainError, digest, now, type Scope } from './domain.js';
import type { AtomicClaim, CanonicalHostObservationPayload, HostObservation, KnowledgeEvidenceLink, RepositoryReadback, SourceRef } from './knowledge-contract.js';
import { atomicClaimSchema } from './knowledge-contract.js';
import { knowledgeCandidateHash, knowledgePolicyHash, snapshotDigest } from './knowledge-identity.js';
import { canonicalHostPayloadSchema, canonicalKnowledgePayloadSchema, hostObservationId, hostObservationSchema, knowledgeSourceRefs, readHostObservation } from './knowledge-records.js';
import { assertKnowledgeSource, parseStructuredKnowledge, structuredRepositoryRequest } from './structured-knowledge.js';
import { takeRepositoryReadback } from './integrations/repository-knowledge.js';
import type { Store } from './store.js';

function invalid():never {throw new DomainError('Knowledge evidence is unavailable or incompatible.','invalid_knowledge_evidence',409);}
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const union=(values:SourceRef[][]):SourceRef[]=>[...new Map(values.flat().map(r=>[r.id,r])).values()].sort((a,b)=>a.id.localeCompare(b.id));
function temporary(store:Store,refs:SourceRef[]):boolean{return refs.some(r=>store.get('sources',r.id)?.retention==='ephemeral');}
function sameScope(a:Scope,b:Scope):boolean{return a.projectId===b.projectId&&a.domain===b.domain;}

/** Consume a concrete authenticated handoff before the final synchronous canonical transaction. */
export function acceptRepositoryReadback(store:Store,sourceId:string,readback:RepositoryReadback):string[] {
 const provenance=takeRepositoryReadback(readback);if(!provenance)invalid();
 const source=store.get('sources',sourceId),project=source?store.get('projects',source.projectId):undefined;
 if(!source||!project||digest(source)!==provenance.sourceHash||knowledgePolicyHash(project)!==provenance.policyHash||digest(provenance.request)!==provenance.requestHash)invalid();
 assertKnowledgeSource(store,source,project);
 const parsed=parseStructuredKnowledge(source,project);if(!parsed)invalid();const expected=structuredRepositoryRequest(store,source,project,parsed),request=provenance.request;
 if(request.repository!==expected.repository||request.headSha!==expected.headSha||request.changeNumber!==expected.changeNumber||!equal(request.checks,expected.checks)||!equal(request.issueSource??null,expected.issueSource??null)||request.testReportPath!==expected.testReportPath&&request.testReportPath!==undefined)invalid();
 const sourceRefs=knowledgeSourceRefs(store,source.id,project);if(!sourceRefs)invalid();
 const bindingHash=digest({source:provenance.sourceHash,policy:provenance.policyHash,request});
 const ancestry=sourceRefs.filter(r=>r.id!==source.id).map(r=>`source:${r.id}:${r.revision}`);
 const rows:CanonicalHostObservationPayload[]=[];
 const add=(raw:HostObservation,attestation?:CanonicalHostObservationPayload['attestation'])=>{
  if(!hostObservationSchema.safeParse(raw).success||!sameScope(raw,project)||raw.bindingHash!==bindingHash||raw.origin.repository!==project.repository||raw.claim.subject.repository!==project.repository||raw.claim.subject.provider!==project.repositoryProvider||!equal(raw.sourceRefs,[{id:source.id,revision:source.revision}]))invalid();
  const observation={...structuredClone(raw),sourceRefs,origin:{...raw.origin,derivedFrom:ancestry}};observation.id=hostObservationId(observation);
  const payload:CanonicalHostObservationPayload={schemaVersion:1,observation,digest:digest(observation),sourceHash:provenance.sourceHash,policyHash:provenance.policyHash,request,requestHash:provenance.requestHash,sourceRefs,...(attestation?{attestation}:{})};
  if(!canonicalHostPayloadSchema.safeParse(payload).success)invalid();rows.push(payload);
 };
 for(const o of readback.observations){if(o.origin.kind!=='provider'||o.claim.kind==='test-result')invalid();add(o);}
 for(const t of readback.tests){
  if(!t.comparable)continue;const a=provenance.attestedTests.find(a=>a.observationId===t.id),origin=t.origin;
  if(!a||origin.kind!=='ci'||a.producerId!==origin.producerId||a.snapshotDigest!==t.comparable.snapshotDigest||a.testDefinitionDigest!==t.comparable.testDefinitionDigest||snapshotDigest(t.snapshot)!==a.snapshotDigest||a.reportPath!==request.testReportPath||!sameScope(t,project)||t.sourceId!==source.id||t.sourceRevision!==source.revision||!t.checks.length)invalid();
  const provider=readback.observations.find(o=>o.origin.originalEventId===a.originalEventId&&o.origin.producerId===a.producerId&&o.claim.kind==='ci-result'&&o.claim.subject.runId===origin.runId&&o.claim.subject.jobId===origin.jobId&&o.claim.subject.headSha===origin.headSha&&o.claim.value.conclusion==='success');if(!provider)invalid();
  add({...provider,id:'attested',claim:{kind:'test-result',subject:{provider:origin.provider,repository:t.repository,testedRevision:t.snapshot.revision,...t.comparable},value:{result:t.checks.every(c=>c.result==='success')?'success':t.checks.some(c=>c.result==='failure')?'failure':'incomplete'}},responseDigest:a.reportDigest},a);
 }
 return store.transaction(()=>{
  assertKnowledgeSource(store,source,project);
  for(const p of rows){
   const o=p.observation;
   // Mutable PR state is separately timestamped. A running job can complete once; terminal outcomes cannot change.
   if(o.claim.kind!=='change-head')for(const existing of store.list('actions').filter(a=>a.kind==='knowledge.host-observation'&&sameScope(a,project))){
    const previous=canonicalHostPayloadSchema.safeParse(existing.payload);if(!previous.success)invalid();const old=(existing.payload as unknown as CanonicalHostObservationPayload).observation;
    if(old.origin.originalEventId===o.origin.originalEventId&&old.claim.kind===o.claim.kind&&!equal(old.claim,o.claim)){
     const completion=old.claim.kind==='ci-result'&&o.claim.kind==='ci-result'&&old.claim.value.conclusion==='pending'&&o.claim.value.conclusion!=='pending'&&
      equal(old.claim.subject,o.claim.subject)&&old.origin.producerId===o.origin.producerId&&old.origin.independentOrigin===o.origin.independentOrigin;
     if(!completion)invalid();
    }
   }
   const old=store.get('actions',o.id);if(old){const existing=canonicalHostPayloadSchema.safeParse(old.payload);if(!existing.success||old.kind!=='knowledge.host-observation'||!sameScope(old,project)||!equal({...((old.payload as unknown as CanonicalHostObservationPayload).observation),observedAt:o.observedAt},o)||!equal(existing.data.sourceRefs,sourceRefs))invalid();continue;}
   store.save('actions',{id:o.id,projectId:project.id,domain:project.domain,kind:'knowledge.host-observation',status:'completed',payload:p as unknown as Record<string,unknown>,updatedAt:now()});
  }
  return rows.map(p=>p.observation.id);
 });
}

/** Pure bounded comparison of retained observations; no supplied object can admit canonical authority. */
export function compareIndependentClaim(claim:AtomicClaim,observations:readonly HostObservation[]):boolean {
 if(claim.kind!=='test-result'||!atomicClaimSchema.safeParse(claim).success||observations.length<2||observations.length>32)return false;
 if(observations.some(o=>!hostObservationSchema.safeParse(o).success||!equal(o.claim,claim)||!sameScope(o,observations[0]!)||o.origin.repository!==claim.subject.repository||o.origin.derivedFrom.some(v=>v.startsWith('unknown')||v===o.id||v===o.origin.originalEventId)))return false;
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

export function linkKnowledgeEvidence(store:Store,cardId:string,observationIds:string[]):KnowledgeEvidenceLink {
 const card=store.get('cards',cardId);if(!card||card.status!=='active'||!card.claim||card.pendingClaim||!atomicClaimSchema.safeParse(card.claim.claim).success||card.expiresAt&&Date.parse(card.expiresAt)<=Date.now()||!observationIds.length||observationIds.length>32||new Set(observationIds).size!==observationIds.length)invalid();
 const source=store.get('sources',card.sourceId),project=store.get('projects',card.projectId);if(!source||!project||source.revision!==card.sourceRevision||!source.content.includes(card.quote)||card.claim.quote!==card.quote)invalid();assertKnowledgeSource(store,source,project);
 const cardRefs=knowledgeSourceRefs(store,source.id,card);if(!cardRefs)invalid();
 const observations=observationIds.map(id=>readHostObservation(store,id,card));if(observations.some(o=>!o))invalid();const actual=observations as HostObservation[],claim=card.claim.claim;
 if(actual.some(o=>!equal(o.claim,claim)||o.origin.derivedFrom.includes(`card:${card.id}`)))invalid();
 const sourceRefs=union([cardRefs,...actual.map(o=>o.sourceRefs)]);
 if(!temporary(store,cardRefs)&&temporary(store,sourceRefs))invalid();
 const authoritative=actual.length===1&&actual[0]!.origin.kind==='provider'&&claim.kind!=='test-result';
 if(!authoritative&&!compareIndependentClaim(claim,actual))invalid();
 const link:KnowledgeEvidenceLink={schemaVersion:1,projectId:card.projectId,domain:card.domain,cardId,candidateHash:knowledgeCandidateHash(card),claimHash:digest(claim),observationIds:[...observationIds],observationHashes:actual.map(o=>digest(o)),basis:authoritative?'authoritative-record':'independent-corroboration',sourceRefs,createdAt:now()};
 if(!canonicalKnowledgePayloadSchema.safeParse({schemaVersion:1,link,digest:digest(link),sourceRefs}).success)invalid();
 return store.transaction(()=>{
  const current=store.get('cards',cardId);if(!current||knowledgeCandidateHash(current)!==link.candidateHash)invalid();assertKnowledgeSource(store,source,project);
  if(actual.some(o=>!equal(readHostObservation(store,o.id,card),o)))invalid();
  const id=`knowledge-link:${digest({...link,createdAt:undefined})}`,old=store.get('actions',id);if(old){const p=canonicalKnowledgePayloadSchema.safeParse(old.payload),prior=old.payload.link as KnowledgeEvidenceLink|undefined;if(!p.success||old.kind!=='knowledge.evidence-link'||old.status!=='completed'||!sameScope(old,card)||!prior||old.payload.digest!==digest(prior)||!equal({...prior,createdAt:link.createdAt},link)||!equal(old.payload.sourceRefs,sourceRefs))invalid();return structuredClone(prior);}
  store.save('actions',{id,projectId:card.projectId,domain:card.domain,kind:'knowledge.evidence-link',status:'completed',payload:{schemaVersion:1,link,digest:digest(link),sourceRefs},updatedAt:now()});return link;
 });
}
