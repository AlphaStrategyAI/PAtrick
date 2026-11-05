import { DomainError, digest, now, type Scope } from './domain.js';
import type { AtomicClaim, CanonicalHostObservationPayload, CanonicalCiTestObservationPayload, HostObservation, KnowledgeEvidenceLink, RepositoryReadback, ReadbackProvenance, SourceRef } from './knowledge-contract.js';
import { atomicClaimSchema } from './knowledge-contract.js';
import { knowledgeCandidateHash, knowledgePolicyHash, snapshotDigest } from './knowledge-identity.js';
import { canonicalCiTestObservationId, canonicalCiTestPayloadSchema, canonicalHostPayloadSchema, canonicalKnowledgePayloadSchema, compareIndependentClaim, hostObservationId, hostObservationSchema, isRetractedHostObservation, knowledgeRequestSourceRefs, knowledgeSourceRefs, readCanonicalHostRecord, readHostObservation } from './knowledge-records.js';
import { assertKnowledgeSource, parseStructuredKnowledge, structuredRepositoryRequest } from './structured-knowledge.js';
import { isStructuredKnowledgeCard, structuredIngestJobSchema, structuredKnowledgeJobId, validStructuredJobRefs } from './knowledge-jobs.js';
import { takeRepositoryReadback } from './integrations/repository-knowledge.js';
import type { Store } from './store.js';
export { compareIndependentClaim } from './knowledge-records.js';

function invalid():never {throw new DomainError('Knowledge evidence is unavailable or incompatible.','invalid_knowledge_evidence',409);}
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const union=(values:SourceRef[][]):SourceRef[]=>[...new Map(values.flat().map(r=>[r.id,r])).values()].sort((a,b)=>a.id.localeCompare(b.id));
function temporary(store:Store,refs:SourceRef[]):boolean{return refs.some(r=>store.get('sources',r.id)?.retention==='ephemeral');}
function sameScope(a:Scope,b:Scope):boolean{return a.projectId===b.projectId&&a.domain===b.domain;}

/** Consume a concrete authenticated handoff before the final synchronous canonical transaction. */
export interface AdmittedRepositoryReadback {ids:string[];current?:{observedAt:string;observations:{id:string;hash:string}[]}}
export function acceptRepositoryReadback(store:Store,sourceId:string,readback:RepositoryReadback,onConsumed?:()=>void):string[] {
 return acceptRepositoryReadbackWithReceipt(store,sourceId,readback,onConsumed).ids;
}
export function acceptRepositoryReadbackWithReceipt(store:Store,sourceId:string,readback:RepositoryReadback,onConsumed?:()=>void):AdmittedRepositoryReadback {
 const provenance=takeRepositoryReadback(readback,onConsumed);if(!provenance)invalid();
 return store.transaction(()=>acceptRepositoryReadbackBody(store,sourceId,readback,provenance));
}
function acceptRepositoryReadbackBody(store:Store,sourceId:string,readback:RepositoryReadback,provenance:ReadbackProvenance):AdmittedRepositoryReadback {
 const source=store.get('sources',sourceId),project=source?store.get('projects',source.projectId):undefined;
 if(!source||!project||digest(source)!==provenance.sourceHash||knowledgePolicyHash(project)!==provenance.policyHash||digest(provenance.request)!==provenance.requestHash)invalid();
 assertKnowledgeSource(store,source,project);
 const parsed=parseStructuredKnowledge(source,project);if(!parsed)invalid();const expected=structuredRepositoryRequest(store,source,project,parsed),request=provenance.request;
 if(request.repository!==expected.repository||request.headSha!==expected.headSha||request.changeNumber!==expected.changeNumber||!equal(request.checks,expected.checks)||!equal(request.issueSource??null,expected.issueSource??null)||request.testReportPath!==expected.testReportPath&&request.testReportPath!==undefined)invalid();
 const sourceRefs=knowledgeRequestSourceRefs(store,source.id,project,request);if(!sourceRefs)invalid();
 let issueSourceHash:string|undefined;
 if(request.issueSource){const issue=store.get('sources',request.issueSource.id),resolution=readback.resolution;
  if(!issue||issue.revision!==request.issueSource.revision||!resolution||resolution.sourceId!==issue.id||resolution.revision!==issue.revision||resolution.quote!==issue.content||resolution.locator!==issue.locator)invalid();
  assertKnowledgeSource(store,issue,project);
  issueSourceHash=digest(issue);
 }
 const rawBindingHash=digest({source:provenance.sourceHash,policy:provenance.policyHash,request});
 const bindingHash=issueSourceHash?digest({source:provenance.sourceHash,policy:provenance.policyHash,request,issueSourceHash}):rawBindingHash;
 const ancestry=sourceRefs.filter(r=>r.id!==source.id).map(r=>`source:${r.id}:${r.revision}`);
 const rows:CanonicalHostObservationPayload[]=[],rawToCanonical=new Map<string,string>();
 const add=(raw:HostObservation,attestation?:CanonicalHostObservationPayload['attestation'])=>{
  if(!hostObservationSchema.safeParse(raw).success||!sameScope(raw,project)||raw.bindingHash!==rawBindingHash||raw.origin.repository!==project.repository||raw.claim.subject.repository!==project.repository||raw.claim.subject.provider!==project.repositoryProvider||!equal(raw.sourceRefs,[{id:source.id,revision:source.revision}]))invalid();
  const observation={...structuredClone(raw),bindingHash,sourceRefs,origin:{...raw.origin,derivedFrom:ancestry}};observation.id=hostObservationId(observation);
  const payload:CanonicalHostObservationPayload={schemaVersion:1,observation,digest:digest(observation),sourceHash:provenance.sourceHash,policyHash:provenance.policyHash,...(issueSourceHash?{issueSourceHash}:{}),request,requestHash:provenance.requestHash,sourceRefs,...(attestation?{attestation}:{})};
  if(!canonicalHostPayloadSchema.safeParse(payload).success)invalid();rows.push(payload);rawToCanonical.set(raw.id,observation.id);
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
   if(o.claim.kind!=='change-head')for(const existing of store.hostObservationRootActions(project,o.origin.originalEventId)){
    if(isRetractedHostObservation(store,existing))continue;
    const previous=readCanonicalHostRecord(existing);if(!previous)invalid();const old=previous.observation;
    if(old.origin.originalEventId===o.origin.originalEventId&&old.claim.kind===o.claim.kind&&!equal(old.claim,o.claim)){
     const completion=old.claim.kind==='ci-result'&&o.claim.kind==='ci-result'&&old.claim.value.conclusion==='pending'&&o.claim.value.conclusion!=='pending'&&
      equal(old.claim.subject,o.claim.subject)&&old.origin.producerId===o.origin.producerId&&old.origin.independentOrigin===o.origin.independentOrigin;
     if(!completion)invalid();
    }
   }
   const old=store.get('actions',o.id);if(old){const existing=readCanonicalHostRecord(old);if(!existing||!sameScope(old,project)||!equal({...existing.observation,observedAt:o.observedAt},o)||!equal(existing.sourceRefs,sourceRefs))invalid();continue;}
   store.save('actions',{id:o.id,projectId:project.id,domain:project.domain,kind:'knowledge.host-observation',status:'completed',payload:p as unknown as Record<string,unknown>,updatedAt:now()});
  }
  // Normalize only the exact one-use readback while its authenticated identity is local.
  for(const raw of readback.tests){
   const origin=raw.origin;
   if(origin.kind!=='ci'||!sameScope(raw,project)||raw.sourceId!==source.id||raw.sourceRevision!==source.revision||raw.repository!==project.repository||origin.provider!==project.repositoryProvider||raw.snapshot.revision!==origin.headSha||!raw.checks.length)invalid();
   // The authenticated reader has no managed-receipt locator seam in G5.
   if(origin.receiptId!==undefined)invalid();
   const providers=rows.filter(p=>{const o=p.observation,c=o.claim;
    return o.origin.kind==='provider'&&c.kind==='ci-result'&&o.origin.provider===origin.provider&&o.origin.producerId===origin.producerId&&o.responseDigest===origin.responseDigest&&
     c.subject.headSha===origin.headSha&&c.subject.runId===origin.runId&&c.subject.jobId===origin.jobId&&raw.checks.some(t=>t.name===c.subject.checkName&&t.result===(c.value.conclusion==='success'?'success':c.value.conclusion==='failure'?'failure':'incomplete'));
   });
   if(!providers.length||raw.checks.some(c=>!providers.some(p=>p.observation.claim.kind==='ci-result'&&p.observation.claim.subject.checkName===c.name)))invalid();
   const hostRows=[...providers,...rows.filter(p=>p.observation.claim.kind==='test-result'&&providers.some(provider=>provider.observation.origin.originalEventId===p.observation.origin.originalEventId)&&p.attestation?.observationId===raw.id)];
   const hostObservationIds=[...new Set(hostRows.map(p=>p.observation.id))].sort();
   const hostObservationHashes=hostObservationIds.map(id=>{const record=store.get('actions',id),parsed=record&&canonicalHostPayloadSchema.safeParse(record.payload);if(!parsed||!parsed.success)invalid();return digest(parsed.data.observation);});
   const observation=structuredClone(raw);observation.id=canonicalCiTestObservationId(observation,provenance.sourceHash,provenance.policyHash,provenance.requestHash,hostObservationIds);
   const payload:CanonicalCiTestObservationPayload={schemaVersion:1,observation,digest:digest(observation),sourceHash:provenance.sourceHash,policyHash:provenance.policyHash,...(issueSourceHash?{issueSourceHash}:{}),request,requestHash:provenance.requestHash,sourceRefs,hostObservationIds,hostObservationHashes};
   if(!canonicalCiTestPayloadSchema.safeParse(payload).success)invalid();
   const old=store.get('actions',observation.id);
   if(old){const parsed=canonicalCiTestPayloadSchema.safeParse(old.payload),previous=old.payload as unknown as CanonicalCiTestObservationPayload;if(old.kind!=='experience.test-observation'||old.status!=='completed'||!sameScope(old,project)||!parsed.success||previous.digest!==digest(previous.observation)||!equal({...previous.observation,observedAt:observation.observedAt},observation)||!equal({...previous,observation:payload.observation,digest:payload.digest},payload))invalid();continue;}
   store.save('actions',{id:observation.id,projectId:project.id,domain:project.domain,kind:'experience.test-observation',status:'completed',payload:payload as unknown as Record<string,unknown>,updatedAt:now()});
  }
  const ids=rows.map(p=>p.observation.id);
  if(!provenance.current)return {ids};
  if(!request.current||!provenance.current.rawObservationIds.length||new Set(provenance.current.rawObservationIds).size!==provenance.current.rawObservationIds.length)invalid();
  const selected=provenance.current.rawObservationIds.map(id=>{const canonicalId=rawToCanonical.get(id),action=canonicalId&&store.get('actions',canonicalId),record=action&&readCanonicalHostRecord(action);if(!record)invalid();return {id:record.observation.id,hash:digest(record.observation)};});
  return {ids,current:{observedAt:provenance.current.observedAt,observations:selected}};
 });
}

export function linkKnowledgeEvidence(store:Store,cardId:string,observationIds:string[]):KnowledgeEvidenceLink {return store.transaction(()=>linkKnowledgeEvidenceBody(store,cardId,observationIds));}
function linkKnowledgeEvidenceBody(store:Store,cardId:string,observationIds:string[]):KnowledgeEvidenceLink {
 const card=store.get('cards',cardId);if(!card||card.status!=='active'||!card.claim||card.pendingClaim||!atomicClaimSchema.safeParse(card.claim.claim).success||card.expiresAt&&Date.parse(card.expiresAt)<=Date.now()||!observationIds.length||observationIds.length>32||new Set(observationIds).size!==observationIds.length)invalid();
 const source=store.get('sources',card.sourceId),project=store.get('projects',card.projectId);if(!source||!project||source.revision!==card.sourceRevision||!source.content.includes(card.quote)||card.claim.quote!==card.quote)invalid();assertKnowledgeSource(store,source,project);
 let cardRefs=knowledgeSourceRefs(store,source.id,card);
 if(isStructuredKnowledgeCard(card)){
  const action=store.get('actions',structuredKnowledgeJobId(source)),job=action&&structuredIngestJobSchema.safeParse(action.payload);
  if(!action||action.kind!=='knowledge.structured-ingest'||!job?.success||job.data.sourceId!==source.id||job.data.sourceRevision!==source.revision||!validStructuredJobRefs(store,source,job.data.sourceRefs))invalid();
  cardRefs=job.data.sourceRefs;
 }
 if(!cardRefs)invalid();
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
