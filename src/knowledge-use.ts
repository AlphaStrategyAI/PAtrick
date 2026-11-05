import { DomainError, digest, stableId, type KnowledgeCard, type Scope, type SourceRevision } from './domain.js';
import { atomicClaimText, claimCandidateSchema, factRefSchema, factRequestSchema, structuredClaimBody } from './knowledge-contract.js';
import type { CanonicalFact, FactGate, FactRef, FactRequest, FactualContext, HostObservation, KnowledgeEvidenceLink, KnowledgeReferenceOptions, KnowledgeView } from './knowledge-contract.js';
import { experienceReference } from './experience.js';
import { knowledgeCandidateHash, knowledgePolicyHash } from './knowledge-identity.js';
import { isStructuredKnowledgeCard, structuredIngestJobSchema, structuredKnowledgeCardId, structuredKnowledgeJobId, validStructuredJobRefs } from './knowledge-jobs.js';
import { canonicalFactualContextPayloadSchema, canonicalKnowledgePayloadSchema, compareIndependentClaim, knowledgeSourceRefs, readHostObservation } from './knowledge-records.js';
import type { Store } from './store.js';

const cardFields=new Set(['id','projectId','domain','sourceId','sourceRevision','title','body','quote','locator','kind','verification','status','aliases','createdAt','expiresAt','experience','claim','pendingClaim']);
/** Strip copied view/authority fields; the host recomposes every displayed view. */
export function stripDerivedCardFields(card:object):void {for(const field of Object.keys(card))if(!cardFields.has(field))Reflect.deleteProperty(card,field);}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);

/** Resolve canonical records on each use; neither a card badge nor caller-supplied prose grants authority. */
export function factualEligibility(store:Store,card:KnowledgeCard,scope:Scope,request:FactRequest,context?:FactualContext):FactGate {
 return store.readSnapshot(()=>{
  const live=store.get('cards',card.id);
  if(!live||live.projectId!==scope.projectId||live.domain!==scope.domain)return {eligible:false,reason:'out-of-scope'};
  if(live.status!=='active')return {eligible:false,reason:'withdrawn'};
  if(live.expiresAt&&(!Number.isFinite(Date.parse(live.expiresAt))||Date.parse(live.expiresAt)<=Date.now()))return {eligible:false,reason:'expired'};
  const source=store.get('sources',live.sourceId);
  if(!source||source.status!=='active'||source.revision!==live.sourceRevision||source.projectId!==scope.projectId||source.domain!==scope.domain||source.locator!==live.locator||!source.content.includes(live.quote)||!knowledgeSourceRefs(store,source.id,scope))return {eligible:false,reason:'stale-source'};
  if(!live.claim||live.pendingClaim||live.claim.quote!==live.quote||!claimCandidateSchema.safeParse(live.claim).success||!factRequestSchema.safeParse(request).success)return {eligible:false,reason:'unverified'};
  // Only the host's atomic structured publication is eligible; mixed extracted prose remains a report.
  if(isStructuredKnowledgeCard(live)){
   const jobAction=store.get('actions',structuredKnowledgeJobId(source)),job=jobAction&&structuredIngestJobSchema.safeParse(jobAction.payload);
   if(live.id!==structuredKnowledgeCardId(live)||!jobAction||jobAction.kind!=='knowledge.structured-ingest'||jobAction.status!=='completed'||!job?.success||job.data.phase!=='processed'||job.data.sourceId!==source.id||job.data.sourceRevision!==source.revision||!validStructuredJobRefs(store,source,job.data.sourceRefs))return {eligible:false,reason:'missing-authority'};
  }else if(live.kind!=='fact'||live.body!==atomicClaimText(live.claim.claim))return {eligible:false,reason:'unsupported-claim'};
  const candidateHash=knowledgeCandidateHash(live),claimHash=digest(live.claim.claim);
  if(request.temporal==='current'){
   if(!context||request.contextId!==context.id)return {eligible:false,reason:'needs-current-readback'};
   const action=store.get('actions',context.id),parsed=action&&canonicalFactualContextPayloadSchema.safeParse(action.payload),project=store.get('projects',scope.projectId),task=context.task&&store.get('tasks',context.task.id),contextSource=store.get('sources',context.source.id);
   if(!action||!parsed?.success||action.kind!=='knowledge.factual-context'||action.status!=='completed'||action.taskId!==context.task?.id||action.projectId!==scope.projectId||action.domain!==scope.domain||!same(parsed.data.context,context)||parsed.data.digest!==digest(context)||context.projectId!==scope.projectId||context.domain!==scope.domain||!project||knowledgePolicyHash(project)!==context.projectPolicyHash||!contextSource||contextSource.status!=='active'||contextSource.revision!==context.source.revision||digest(contextSource)!==context.sourceHash||live.sourceId!==context.source.id||live.sourceRevision!==context.source.revision||!task||task.version!==context.task?.version||task.sourceId!==context.source.id||task.sourceRevision!==context.source.revision||task.projectId!==scope.projectId||task.domain!==scope.domain||['cancelled','delivered','archived'].includes(task.status)||parsed.data.sourceRefs.some(ref=>{const dep=store.get('sources',ref.id);return !dep||dep.status!=='active'||dep.revision!==ref.revision||dep.projectId!==scope.projectId||dep.domain!==scope.domain||dep.retention==='ephemeral'&&!dep.content;})||!(knowledgeSourceRefs(store,context.source.id,scope)??[]).every(ref=>parsed.data.sourceRefs.some(value=>value.id===ref.id&&value.revision===ref.revision))||context.observations.some(entry=>{const obs=readHostObservation(store,entry.id,scope);return !obs||digest(obs)!==entry.hash||obs.sourceRefs.some(ref=>!parsed.data.sourceRefs.some(value=>value.id===ref.id&&value.revision===ref.revision));}))return {eligible:false,reason:'needs-current-readback'};
  }
  let accepted:{link:KnowledgeEvidenceLink;observations:HostObservation[]}|undefined;
  for(const action of store.knowledgeEvidenceActions(scope,live.id)){
   if(action.kind!=='knowledge.evidence-link'||action.status!=='completed'||action.projectId!==scope.projectId||action.domain!==scope.domain)continue;
   const parsed=canonicalKnowledgePayloadSchema.safeParse(action.payload);if(!parsed.success)continue;
   const link=action.payload.link as KnowledgeEvidenceLink;
   if(link.cardId!==live.id||link.candidateHash!==candidateHash||link.claimHash!==claimHash||action.payload.digest!==digest(link)||!same(action.payload.sourceRefs,link.sourceRefs)||action.id!==`knowledge-link:${digest({...link,createdAt:undefined})}`||link.observationIds.length!==link.observationHashes.length||new Set(link.observationIds).size!==link.observationIds.length)continue;
   if(link.sourceRefs.some(ref=>{const s=store.get('sources',ref.id);return !s||s.status!=='active'||s.revision!==ref.revision||s.projectId!==scope.projectId||s.domain!==scope.domain||s.retention==='ephemeral'&&!s.content;}))continue;
   const observations=link.observationIds.map(id=>readHostObservation(store,id,scope));
   if(observations.some((o,i)=>!o||digest(o)!==link.observationHashes[i]||!same(o.claim,live.claim!.claim)||o.origin.derivedFrom.includes(`card:${live.id}`)))continue;
   const actual=observations.filter((o):o is HostObservation=>!!o);
   if(request.temporal==='current'&&actual.some(o=>!context!.observations.some(x=>x.id===o.id&&x.hash===digest(o))))continue;
   if(link.basis==='authoritative-record'?(actual.length!==1||actual[0]!.origin.kind!=='provider'||actual[0]!.claim.kind==='test-result'):!compareIndependentClaim(live.claim.claim,actual))continue;
   accepted={link,observations:actual};break;
  }
  if(!accepted)return {eligible:false,reason:request.temporal==='current'?'needs-current-readback':'missing-authority'};
  const {link,observations}=accepted;
  const ref:FactRef={cardId:live.id,claimHash,request};
  const fact:CanonicalFact={projectId:scope.projectId,domain:scope.domain,ref,claim:structuredClone(live.claim.claim),text:atomicClaimText(live.claim.claim),basis:link.basis,observationIds:link.observationIds,sourceRefs:link.sourceRefs,observedAt:observations.map(o=>o.observedAt),eventAt:observations.map(o=>o.eventAt??null),temporal:request.temporal,...(request.temporal==='current'?{currentReadAt:context!.observedAt}:{}),limitations:request.temporal==='current'?['Observed at the time of the authenticated read; later state may differ.']:['Historical observation; current state and broader effects are not established.']};
  return {eligible:true,fact};
 });
}

export function expandFactRefs(store:Store,refs:readonly FactRef[],scope:Scope,context?:FactualContext):CanonicalFact[] {
 return store.readSnapshot(()=>refs.map(ref=>{if(!factRefSchema.safeParse(ref).success)throw new DomainError('Fact reference is unavailable.','invalid_fact',403);const card=store.get('cards',ref.cardId);if(!card||!card.claim||digest(card.claim.claim)!==ref.claimHash)throw new DomainError('Fact reference is unavailable.','invalid_fact',403);const gate=factualEligibility(store,card,scope,ref.request,context);if(!gate.eligible)throw new DomainError('Fact reference is unavailable.','invalid_fact',403);return gate.fact;}));
}

function recordedAuthor(store:Store,source:SourceRevision):{id:string;authenticated:boolean} {
 const qid=source.kind==='conversation'&&source.externalId.startsWith('answer:')?source.externalId.slice(7):undefined;
 const question=qid?store.get('questions',qid):undefined,task=question?store.get('tasks',question.taskId):undefined,project=store.get('projects',source.projectId),primary=task?store.get('sources',task.sourceId):undefined;
 const decisionCase=question?store.get('cases',stableId('decision-case',question.id)):undefined;
 const event=question?.answer?store.get('cursors',stableId('answer-event',source.projectId,source.domain,question.answer.eventId)):undefined;
 const authenticated=!!question&&question.status==='answered'&&!!question.answer&&!!task&&!!project&&!!primary&&primary.status==='active'&&primary.revision===task.sourceRevision&&primary.projectId===task.projectId&&primary.domain===task.domain&&question.projectId===source.projectId&&question.domain===source.domain&&task.projectId===source.projectId&&task.domain===source.domain&&task.version>=question.taskVersion+1&&project.ownerId===question.ownerId&&question.answer.actorId===question.ownerId&&source.authorId===question.ownerId&&source.id===stableId('owner-answer',question.id)&&source.revision===digest(question.answer.text)&&source.content===question.answer.text&&source.locator===`question:${question.id}@${question.version}`&&event?.value===digest({questionId:question.id,choice:question.answer.choice,words:question.answer.text})&&!!decisionCase&&decisionCase.status==='active'&&decisionCase.taskId===task.id&&decisionCase.questionId===question.id&&decisionCase.sourceId===source.id&&decisionCase.actorId===question.ownerId&&decisionCase.originalWords===question.answer.text;
 return {id:source.authorId,authenticated};
}

/** A derived view only: never persisted or used as extraction input. */
export function knowledgeReference(store:Store,card:KnowledgeCard,scope:Scope,options:KnowledgeReferenceOptions={}):KnowledgeView|undefined {return store.readSnapshot(()=>{const current=store.get('cards',card.id);return current?knowledgeReferenceBody(store,current,scope,options):undefined;});}
function knowledgeReferenceBody(store:Store,card:KnowledgeCard,scope:Scope,options:KnowledgeReferenceOptions):KnowledgeView|undefined {
 if(card.projectId!==scope.projectId||card.domain!==scope.domain)return undefined;
 const base={...card};stripDerivedCardFields(base);
 const source=store.get('sources',card.sourceId),active=card.status==='active'&&(!card.expiresAt||Date.parse(card.expiresAt)>Date.now())&&source?.status==='active'&&source.revision===card.sourceRevision&&source.projectId===scope.projectId&&source.domain===scope.domain;
 if(!active)return options.usage==='browse'&&card.status==='withdrawn'?base:undefined;
 const hasAuthorizedQuote=!!card.quote&&source.locator===card.locator&&source.content.includes(card.quote);
 const reported=hasAuthorizedQuote?{reportedStatement:{text:card.quote,status:'reported' as const},reportedAuthor:recordedAuthor(store,source)}:{};
 if(!hasAuthorizedQuote)base.quote='';
 const generated=isStructuredKnowledgeCard(card)&&card.claim&&claimCandidateSchema.safeParse(card.claim).success&&card.body===structuredClaimBody(card.claim.claim,card.quote);
 let factual=factualEligibility(store,card,scope,options.request??{temporal:'historical'},options.context);
 // A structured-shaped body is editable. Only the retained historical gate binds
 // its claim to admitted host observations, independent of current-read freshness.
 const historical=options.request?.temporal==='current'?factualEligibility(store,card,scope,{temporal:'historical'}):factual;
 const description=generated?(historical.eligible
  ?{text:atomicClaimText(card.claim!.claim),status:'host-observation' as const}
  :{text:'Unverified repository observation; authenticated evidence is unavailable.',status:'inference' as const})
  :{text:card.body,status:card.verification==='inference'?'inference' as const:'reported-summary' as const};
 // The projected body is descriptive only; keep the canonical stored card untouched.
 if(generated)base.body=description.text;
 let currentEvidenceGap:'needs-current-readback'|undefined;
 if(options.request?.temporal==='current'&&!factual.eligible&&factual.reason==='needs-current-readback'){
  if(historical.eligible){factual=historical;currentEvidenceGap='needs-current-readback';}
 }else if(!options.request&&factual.eligible&&card.claim?.claim.kind!=='test-result')currentEvidenceGap='needs-current-readback';
 if(card.kind!=='experience')return {...base,...reported,description,factual,...(currentEvidenceGap?{currentEvidenceGap}:{})};
 const gate=experienceReference(store,card,scope,options.current);
 const factualView=card.claim?{factual}:{};
 if(gate.eligible)return {...base,...reported,description,...factualView,experienceReference:gate.reference};
 return options.usage==='browse'?{...base,...reported,description,...factualView,experienceState:{state:gate.state,reason:gate.reason}}:undefined;
}
