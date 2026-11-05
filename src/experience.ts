import { DomainError, digest, experienceDetailsSchema, now, pathAllowed, stableId, type KnowledgeCard, type Scope } from './domain.js';
import type { CurrentExperienceContext, ExperienceAssociation, ExperienceGate, ExperienceReference, SourceRef, TestObservation } from './knowledge-contract.js';
import { knowledgeCandidateHash } from './knowledge-identity.js';
import { canonicalExperiencePayloadSchema, knowledgeSourceRefs, normalizationOriginPayloadSchema, readTestObservation, readTestObservationWithTimes } from './knowledge-records.js';
import { isStructuredKnowledgeCard, structuredIngestJobSchema, structuredKnowledgeCardId, structuredKnowledgeJobId, validStructuredJobRefs } from './knowledge-jobs.js';
import { assertKnowledgeSource, parseStructuredKnowledge, type LocalRelationDeclarationV1 } from './structured-knowledge.js';
import { isKnowledgeSnapshotFailure, type Store } from './store.js';

const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const scopeMatches=(a:Scope,b:Scope)=>a.projectId===b.projectId&&a.domain===b.domain;
function localRelation(declaration:LocalRelationDeclarationV1,card:KnowledgeCard,o:TestObservation,trusted:string[]):{quote:string;selectors:string[];checks:TestObservation['checks']}|undefined {
 const details=card.experience!;
 const matches=declaration.records.filter(record=>record.problem===details.problem&&same([...record.files].sort(),[...details.files].sort()));
 if(matches.length!==1)return undefined;
 const selectors=matches[0]!.checks;
 if(selectors.some(command=>!trusted.includes(command)))return undefined;
 const checks=o.checks.filter(check=>!!check.command&&selectors.includes(check.command)&&check.id===stableId('local-check',check.command)&&(!check.testFile||o.snapshot.files.some(file=>file.path===check.testFile)));
 return {quote:declaration.quote,selectors,checks};
}
function invalid():never {throw new DomainError('Experience evidence is unavailable or incompatible.','invalid_experience_evidence',409);}
function sourceRefs(store:Store,ids:string[],scope:Scope):SourceRef[]|undefined {
 const found=new Map<string,SourceRef>();
 for(const id of ids){const refs=knowledgeSourceRefs(store,id,scope);if(!refs)return undefined;for(const ref of refs){const previous=found.get(ref.id);if(previous&&previous.revision!==ref.revision)return undefined;found.set(ref.id,ref);}}
 const refs=[...found.values()].sort((a,b)=>a.id.localeCompare(b.id));
 if(refs.some(ref=>{const s=store.get('sources',ref.id),hash=store.get('cursors',stableId('source-hash',ref.id))?.value;return !s||!s.content||!!hash&&hash!==digest(s.content);}))return undefined;
 return refs;
}
function associationRefs(store:Store,card:KnowledgeCard,observation:TestObservation,recordSourceId:string):SourceRef[]|undefined {
 const ids=[card.sourceId,observation.sourceId,recordSourceId];
 if(isStructuredKnowledgeCard(card)){
  const source=store.get('sources',card.sourceId),row=source&&store.get('actions',structuredKnowledgeJobId(source)),job=row&&structuredIngestJobSchema.safeParse(row.payload);
  if(!job?.success)return undefined;ids.push(...job.data.sourceRefs.map(ref=>ref.id));
 }
 return sourceRefs(store,ids,card);
}
function candidateValid(store:Store,card:KnowledgeCard,scope:Scope):boolean {
 if(card.kind!=='experience'||!scopeMatches(card,scope)||card.status!=='active'||!experienceDetailsSchema.safeParse(card.experience).success||card.experience?.productId!==scope.projectId||card.expiresAt&&!(Date.parse(card.expiresAt)>Date.now()))return false;
 const source=store.get('sources',card.sourceId),project=store.get('projects',scope.projectId);
 if(!source||!project||source.revision!==card.sourceRevision||source.locator!==card.locator||!source.content.includes(card.quote)||project.id!==scope.projectId||project.projectId!==scope.projectId||project.domain!==scope.domain||card.experience.files.some(path=>!pathAllowed(path,project.allowedPaths))||!sourceRefs(store,[source.id],scope))return false;
 try{assertKnowledgeSource(store,source,project);}catch(error){if(isKnowledgeSnapshotFailure(error))throw error;return false;}
 if(isStructuredKnowledgeCard(card)){
  const job=store.get('actions',structuredKnowledgeJobId(source)),parsed=job&&structuredIngestJobSchema.safeParse(job.payload);
  if(!job||job.kind!=='knowledge.structured-ingest'||!parsed?.success||job.projectId!==scope.projectId||job.domain!==scope.domain||parsed.data.sourceId!==source.id||parsed.data.sourceRevision!==source.revision||parsed.data.sourceHash!==digest(source.content)||!(job.status==='pending'&&['queued','pending-readback'].includes(parsed.data.phase)||job.status==='completed'&&parsed.data.phase==='processed')||!validStructuredJobRefs(store,source,parsed.data.sourceRefs)||card.id!==structuredKnowledgeCardId(card)||!sourceRefs(store,parsed.data.sourceRefs.map(ref=>ref.id),scope))return false;
 }
 return true;
}

/** Derive only an exact relation that the authorized record itself names. */
function derive(store:Store,card:KnowledgeCard,o:TestObservation,versionBinding?:ExperienceAssociation['versionBinding'],includeFailure=false):ExperienceAssociation|undefined {
 if(!candidateValid(store,card,card)||!scopeMatches(o,card)||o.repository!==store.get('projects',card.projectId)?.repository||!card.experience)return undefined;
 const details=card.experience,project=store.get('projects',card.projectId)!,source=store.get('sources',card.sourceId)!;
 if(details.codeVersion!==o.snapshot.revision||versionBinding&&(versionBinding.reported!=='unknown'||versionBinding.observedRevision!==o.snapshot.revision))return undefined;
 if(new Set(o.snapshot.files.map(file=>file.path)).size!==o.snapshot.files.length)return undefined;
 const selectedFiles=details.files.map(path=>o.snapshot.files.find(file=>file.path===path));if(selectedFiles.some(file=>!file))return undefined;
 let record=store.get('sources',o.sourceId),subject:ExperienceAssociation['subject'],kind:ExperienceAssociation['relevance']['kind'],quote:string;
 let checks:TestObservation['checks']=[];
 if(o.origin.kind==='local'){
  const task=store.get('tasks',o.origin.taskId);
  if(!record||!task||!scopeMatches(task,card)||task.sourceId!==record.id||task.sourceRevision!==record.revision||record.revision!==o.sourceRevision||!record.content.includes(card.quote))return undefined;
  const declaration=parseStructuredKnowledge(record,project,'local-relations-v1');
  if(!declaration||!card.quote.startsWith(declaration.quote))return undefined;
  const relation=localRelation(declaration,card,o,project.trustedChecks);if(!relation)return undefined;
  quote=relation.quote;checks=relation.checks;
  subject={kind:'task',id:task.id,revision:record.revision};kind='named-regression';
 }else{
  if(o.sourceId!==source.id||o.sourceRevision!==source.revision)return undefined;
  let parsed:ReturnType<typeof parseStructuredKnowledge>;try{parsed=parseStructuredKnowledge(source,project);}catch{return undefined;}
  if(parsed?.kind!=='experience')return undefined;
  const input=parsed.input;
  const originalDetails={...details,codeVersion:versionBinding?'unknown':details.codeVersion};
  if(!same(input.details,originalDetails)||input.quote!==card.quote||input.repository!==o.repository||input.headSha!==o.snapshot.revision||input.runId!==o.origin.runId||input.jobId!==o.origin.jobId||input.issueId&&!store.get('sources',input.issueId))return undefined;
  const issue=input.issueId?store.get('sources',input.issueId):undefined;
  if(input.issueId&&(!issue||!scopeMatches(issue,card)))return undefined;
  record=source;quote=input.quote;
  checks=o.checks.filter(check=>!!check.name&&input.checkIds.includes(check.name)&&project.trustedChecks.includes(check.name)&&(!check.testFile||o.snapshot.files.some(file=>file.path===check.testFile)));
  subject={kind:'issue',id:issue?.id??record.id,revision:issue?.revision??record.revision};kind='resolution-with-checks';
 }
 if(!record||!quote||Buffer.byteLength(quote)>10000||!checks.length||!checks.some(check=>check.result=== (includeFailure?'failure':'success')))return undefined;
 checks=checks.filter(check=>check.result===(includeFailure?'failure':'success'));
 const paths=new Set([...details.files,...checks.flatMap(check=>check.testFile?[check.testFile]:[])]);
 const files=[...paths].sort().map(path=>o.snapshot.files.find(file=>file.path===path));if(files.some(file=>!file))return undefined;
 const measured=files.filter((file):file is NonNullable<typeof file>=>file!==undefined);
 return {schemaVersion:1,cardId:card.id,candidateHash:knowledgeCandidateHash(card),sourceId:card.sourceId,sourceRevision:card.sourceRevision,observationId:o.id,observationHash:digest(o),checkIds:checks.map(check=>check.id).sort(),files:measured,subject,relevance:{kind,recordSourceId:record.id,recordRevision:record.revision,quote,locator:record.locator,interpretation:'reported'},...(versionBinding?{versionBinding}:{})};
}

function alreadyBoundToDifferentCandidate(store:Store,card:KnowledgeCard,observationId:string):boolean {
 return store.experienceActions('experience.evidence-link',{scope:card,cardId:card.id,observationId}).some(row=>{
  if(row.kind!=='experience.evidence-link'||!scopeMatches(row,card))return false;
  const parsed=canonicalExperiencePayloadSchema.safeParse(row.payload);if(!parsed.success)return false;
  const association=parsed.data.association;
  return association.cardId===card.id&&association.observationId===observationId&&row.id===stableId('experience-evidence-link',association)&&row.payload.digest===digest(association)&&(row.status!=='completed'||association.candidateHash!==knowledgeCandidateHash(card));
 });
}

function normalizationBinding(store:Store,card:KnowledgeCard):ExperienceAssociation['versionBinding']|undefined {
 for(const row of store.experienceActions('experience.evidence-link',{scope:card,cardId:card.id})){
  if(row.status!=='completed')continue;
  const origin=normalizationOriginPayloadSchema.safeParse(row.payload);
  if(origin.success){const value=origin.data.normalizationOrigin,refs=sourceRefs(store,[card.sourceId],card);
   if(value.cardId===card.id&&value.sourceId===card.sourceId&&value.sourceRevision===card.sourceRevision&&value.observedRevision===card.experience?.codeVersion&&refs&&same(refs,origin.data.sourceRefs))return {reported:value.reported,observedRevision:value.observedRevision};
   continue;
  }
  const parsed=canonicalExperiencePayloadSchema.safeParse(row.payload);if(!parsed.success)continue;
  const association=parsed.data.association,binding=association.versionBinding;
  // This recovers metadata only; historical authority is independently rechecked below.
  if(binding?.reported==='unknown'&&binding.observedRevision===card.experience?.codeVersion&&association.cardId===card.id&&association.sourceId===card.sourceId&&association.sourceRevision===card.sourceRevision&&row.id===stableId('experience-evidence-link',association)&&row.payload.digest===digest(association))return binding;
 }
 return undefined;
}

function hasStaleNormalizationOrigin(store:Store,card:KnowledgeCard):boolean {
 const hash=knowledgeCandidateHash(card),binding=normalizationBinding(store,card);
 return store.experienceActions('experience.evidence-link',{scope:card,cardId:card.id}).some(row=>{
  if(row.status!=='completed')return false;
  const parsed=normalizationOriginPayloadSchema.safeParse(row.payload);
  if(parsed.success){const origin=parsed.data.normalizationOrigin;return origin.cardId===card.id&&origin.sourceId===card.sourceId&&origin.sourceRevision===card.sourceRevision&&origin.candidateHash!==hash&&(!binding||binding.observedRevision!==origin.observedRevision);}
  const link=canonicalExperiencePayloadSchema.safeParse(row.payload);if(!link.success||row.status!=='completed'||!scopeMatches(row,card))return false;
  const association=link.data.association;
  return !!association.versionBinding&&association.cardId===card.id&&association.sourceId===card.sourceId&&association.sourceRevision===card.sourceRevision&&association.candidateHash!==hash&&(!binding||binding.observedRevision!==association.versionBinding.observedRevision)&&row.id===stableId('experience-evidence-link',association)&&row.payload.digest===digest(association);
 });
}

/** Internal host-only association writer. It cannot admit a supplied observation. */
export function linkExperienceEvidence(store:Store,cardId:string,observationId:string,association:ExperienceAssociation):void {return store.transaction(()=>linkExperienceEvidenceBody(store,cardId,observationId,association));}
function linkExperienceEvidenceBody(store:Store,cardId:string,observationId:string,association:ExperienceAssociation):void {
 const card=store.get('cards',cardId),observation=card&&readTestObservation(store,observationId,card);
 if(!card||!observation||cardId!==association.cardId||observationId!==association.observationId||alreadyBoundToDifferentCandidate(store,card,observationId)||hasStaleNormalizationOrigin(store,card))invalid();
 const binding=normalizationBinding(store,card),expected=derive(store,card,observation,association.versionBinding),refs=associationRefs(store,card,observation,association.relevance.recordSourceId);
 if(binding&&!same(binding,association.versionBinding)||!expected||!refs||!same(expected,association))invalid();
 if(isStructuredKnowledgeCard(card)){
  const source=store.get('sources',card.sourceId)!,action=store.get('actions',structuredKnowledgeJobId(source)),job=action&&structuredIngestJobSchema.safeParse(action.payload);
  if(!job?.success||job.data.sourceRefs.some(ref=>!refs.some(value=>value.id===ref.id&&value.revision===ref.revision)))invalid();
 }
 const payload={schemaVersion:1 as const,association,digest:digest(association),sourceRefs:refs};
 if(!canonicalExperiencePayloadSchema.safeParse(payload).success)invalid();
 const id=stableId('experience-evidence-link',association),old=store.get('actions',id);
 if(old){if(old.kind!=='experience.evidence-link'||old.status!=='completed'||!scopeMatches(old,card)||!same(old.payload,payload))invalid();return;}
 store.save('actions',{id,projectId:card.projectId,domain:card.domain,kind:'experience.evidence-link',status:'completed',payload,updatedAt:now()});
}

/** Scan only host-retained observations and current, authorized candidates. */
export function linkAvailableExperienceEvidence(store:Store,observationId:string,candidates?:KnowledgeCard[]):number {return store.transaction(()=>linkAvailableExperienceEvidenceBody(store,observationId,candidates));}
function linkAvailableExperienceEvidenceBody(store:Store,observationId:string,candidates?:KnowledgeCard[]):number {
 const row=store.get('actions',observationId);if(!row)return 0;
 const scope={projectId:row.projectId,domain:row.domain},observation=readTestObservation(store,observationId,scope);if(!observation)return 0;
 let count=0;
 for(const current of candidates??store.experienceCandidates(observation)){
  if(!candidateValid(store,current,scope)||!current.experience||hasStaleNormalizationOrigin(store,current))continue;
  try{
  const details=current.experience;let card=current,binding:ExperienceAssociation['versionBinding'];
  if(details.codeVersion==='unknown'){
   binding={reported:'unknown',observedRevision:observation.snapshot.revision};
   const normalized:KnowledgeCard={...card,experience:{...details,codeVersion:observation.snapshot.revision}};
   if(!derive(store,normalized,observation,binding)||alreadyBoundToDifferentCandidate(store,normalized,observation.id))continue;
   const association=derive(store,normalized,observation,binding)!;
   const id=stableId('experience-evidence-link',association),prior=store.get('actions',id);
   store.transaction(()=>{
    const dependencies=associationRefs(store,normalized,observation,association.relevance.recordSourceId);
    if(!dependencies)invalid();
    if(dependencies.some(ref=>store.get('sources',ref.id)?.retention==='ephemeral'))store.saveTemporaryNormalizedExperienceCard(normalized);
    else store.save('cards',normalized);
    const saved=store.get('cards',card.id);
    if(!saved||!candidateValid(store,saved,scope)||knowledgeCandidateHash(saved)!==knowledgeCandidateHash(normalized))invalid();
    linkExperienceEvidence(store,saved.id,observation.id,association);
   });
   if(!prior)count++;continue;
  }
  binding=normalizationBinding(store,card);
  const association=derive(store,card,observation,binding);if(!association||alreadyBoundToDifferentCandidate(store,card,observation.id))continue;
  const id=stableId('experience-evidence-link',association),prior=store.get('actions',id);
  linkExperienceEvidence(store,card.id,observation.id,association);if(!prior)count++;
  }catch(error){if(error instanceof DomainError&&error.code==='invalid_experience_evidence')continue;throw error;}
 }
 return count;
}

/** Publication only revisits observations whose revision and measured target can match each new card. */
export function linkExperienceForCards(store:Store,cards:KnowledgeCard[]):void {return store.transaction(()=>linkExperienceForCardsBody(store,cards));}
function linkExperienceForCardsBody(store:Store,cards:KnowledgeCard[]):void {
 for(const candidate of cards){
  const card=store.get('cards',candidate.id);if(card?.kind!=='experience'||!card.experience?.files.length)continue;
  const query={scope:card,file:card.experience.files[0]!,...(card.experience.codeVersion==='unknown'?{}:{revision:card.experience.codeVersion})};
  for(const row of store.experienceActions('experience.test-observation',query))linkAvailableExperienceEvidence(store,row.id,[store.get('cards',card.id)??card]);
 }
}

/** One retained sweep narrows each observation to matching scoped candidates. */
export function linkRetainedExperienceEvidence(store:Store):void {
 store.transaction(()=>{for(const id of store.experienceObservationIds())linkAvailableExperienceEvidence(store,id);});
}

function retainedDelivery(store:Store,observation:TestObservation):ExperienceReference['delivery']|undefined {
 if(observation.origin.kind!=='local')return undefined;
 const task=store.get('tasks',observation.origin.taskId),project=store.get('projects',observation.projectId),receipt=task?.receiptId&&store.get('receipts',task.receiptId);
 const file=task?.artifact?.files.find(entry=>entry.path===project?.prdPath);
 if(!task||!project||!receipt||!file||!scopeMatches(task,observation)||!scopeMatches(receipt,observation)||receipt.taskId!==task.id||receipt.repository!==project.repository||receipt.path!==project.prdPath||!receipt.id||!receipt.headSha.trim()||!receipt.mergeSha.trim()||!Number.isInteger(receipt.pullRequestNumber)||receipt.pullRequestNumber<1||!Number.isFinite(Date.parse(receipt.verifiedAt))||receipt.contentHash!==digest(file.content)||!project.autoMerge||!project.trustedChecks.length||!project.trustedAppIds.length||!Array.isArray(receipt.checks)||project.trustedChecks.some(name=>!receipt.checks.some(check=>check.name===name&&check.conclusion==='success'&&check.headSha===receipt.headSha&&project.trustedAppIds.includes(check.appId)&&!!check.url)))return undefined;
 try{if(new URL(receipt.pullRequestUrl).protocol!=='https:')return undefined;}catch{return undefined;}
 return {receiptId:receipt.id,headSha:receipt.headSha,mergeSha:receipt.mergeSha};
}

function matchesRelatedTarget(check:TestObservation['checks'][number],targets:Set<string>):boolean {
 return (check.result==='failure'||check.result==='success')&&(!!check.command&&targets.has(`command:${check.command}`)||!!check.name&&targets.has(`name:${check.name}`));
}

// A later result can resolve a failure only for the same measured target and selector.
function sameFailureTarget(card:KnowledgeCard,failed:TestObservation,check:TestObservation['checks'][number],passed:TestObservation,success:TestObservation['checks'][number]):boolean {
 if(failed.snapshot.revision!==passed.snapshot.revision||failed.snapshot.overlayHash!==passed.snapshot.overlayHash||check.testFile!==success.testFile)return false;
 if(!check.command&&!check.name||check.command!==success.command||check.name!==success.name)return false;
 if(failed.comparable&&passed.comparable&&failed.comparable.testDefinitionDigest!==passed.comparable.testDefinitionDigest)return false;
 const paths=new Set([...card.experience!.files,...(check.testFile?[check.testFile]:[])]);
 if(!check.testFile)for(const file of [...failed.snapshot.files,...passed.snapshot.files])paths.add(file.path);
 return [...paths].every(path=>{
  const a=failed.snapshot.files.find(file=>file.path===path),b=passed.snapshot.files.find(file=>file.path===path);
  return !!a&&!!b&&a.sha256===b.sha256&&a.mode===b.mode;
 });
}

function laterRelatedChecks(store:Store,card:KnowledgeCard,o:TestObservation,targets:Set<string>):TestObservation['checks'] {
 const details=card.experience!,project=store.get('projects',card.projectId),record=store.get('sources',o.sourceId);
 if(!project||!record||!scopeMatches(o,card)||o.repository!==project.repository||details.files.some(path=>!o.snapshot.files.some(file=>file.path===path))||!sourceRefs(store,[record.id],card))return [];
 try{assertKnowledgeSource(store,record,project);}catch(error){if(isKnowledgeSnapshotFailure(error))throw error;return [];}
 const target=(check:TestObservation['checks'][number])=>matchesRelatedTarget(check,targets);
 if(o.origin.kind==='local'){
  const task=store.get('tasks',o.origin.taskId);
  if(!task||!scopeMatches(task,card)||task.sourceId!==record.id||task.sourceRevision!==record.revision||record.revision!==o.sourceRevision)return [];
  const declaration=parseStructuredKnowledge(record,project,'local-relations-v1');
  return declaration?localRelation(declaration,card,o,project.trustedChecks)?.checks.filter(target)??[]:[];
 }
 let parsed:ReturnType<typeof parseStructuredKnowledge>;try{parsed=parseStructuredKnowledge(record,project);}catch{return [];}
 if(parsed?.kind!=='experience')return [];
 const input=parsed.input;
 if(input.repository!==o.repository||input.headSha!==o.snapshot.revision||input.runId!==o.origin.runId||input.jobId!==o.origin.jobId||input.details.productId!==card.projectId||input.details.problem!==details.problem||!same([...input.details.files].sort(),[...details.files].sort())||!(input.details.codeVersion==='unknown'||input.details.codeVersion===o.snapshot.revision))return [];
 return o.checks.filter(check=>target(check)&&!!check.name&&input.checkIds.includes(check.name)&&project.trustedChecks.includes(check.name)&&(!check.testFile||o.snapshot.files.some(file=>file.path===check.testFile)));
}

function solutionStatus(store:Store,card:KnowledgeCard):'reported'|'inference' {
 if(card.verification==='inference')return 'inference';
 const source=store.get('sources',card.sourceId),project=store.get('projects',card.projectId),solution=card.experience!.solution;
 if(!source||!project)return 'inference';
 if(isStructuredKnowledgeCard(card)||/^\s*\{/u.test(source.content))try{const parsed=parseStructuredKnowledge(source,project);if(parsed?.kind==='experience')return parsed.input.details.solution===solution?'reported':'inference';}catch{/* An ordinary source needs no structured envelope. */}
 // Ordinary prose supports the full statement only when it explicitly names this candidate.
 // Substrings, paraphrases, and a separate passage do not establish source attribution.
 const whole=(value:string)=>value.trim().replace(/[.!?。]$/u,'').trim();
 const statement=whole(solution),details=card.experience!;
 return statement.includes(details.problem)&&details.files.every(path=>statement.includes(path))&&
  card.quote.split(/(?<=[.!?。])\s+/u).some(part=>whole(part)===statement)?'reported':'inference';
}

// A legacy association can explain a pending state only after all retained
// source, observation and association bindings have independently revalidated.
function unsupportedLegacyRelation(store:Store,card:KnowledgeCard,o:TestObservation,a:ExperienceAssociation):boolean {
 if(o.origin.kind!=='local'||!card.experience)return false;
 const record=store.get('sources',o.sourceId),project=store.get('projects',card.projectId),task=store.get('tasks',o.origin.taskId);
 if(!record||!project||!task||!scopeMatches(task,card)||task.sourceId!==record.id||task.sourceRevision!==record.revision||record.revision!==o.sourceRevision||!record.content.includes(card.quote))return false;
 const declaration=parseStructuredKnowledge(record,project,'local-relations-v1');
 if(declaration&&card.quote.startsWith(declaration.quote))return false;
 if(a.cardId!==card.id||a.candidateHash!==knowledgeCandidateHash(card)||a.sourceId!==card.sourceId||a.sourceRevision!==card.sourceRevision||a.observationId!==o.id||a.observationHash!==digest(o)||
   a.subject.kind!=='task'||a.subject.id!==task.id||a.subject.revision!==record.revision||a.relevance.kind!=='named-regression'||a.relevance.recordSourceId!==record.id||a.relevance.recordRevision!==record.revision||a.relevance.locator!==record.locator||a.relevance.interpretation!=='reported'||!card.quote.includes(a.relevance.quote))return false;
 if(card.experience.codeVersion!==o.snapshot.revision||a.versionBinding&&(a.versionBinding.reported!=='unknown'||a.versionBinding.observedRevision!==o.snapshot.revision)||new Set(o.snapshot.files.map(file=>file.path)).size!==o.snapshot.files.length)return false;
 const checks=a.checkIds.map(id=>o.checks.find(check=>check.id===id));
 if(!checks.length||checks.some(check=>!check||check.result!=='success'||!check.command||!project.trustedChecks.includes(check.command)||check.id!==stableId('local-check',check.command)||check.testFile&&!o.snapshot.files.some(file=>file.path===check.testFile)))return false;
 const paths=new Set([...card.experience.files,...checks.flatMap(check=>check?.testFile?[check.testFile]:[])]);
 const files=[...paths].sort().map(path=>o.snapshot.files.find(file=>file.path===path));
 return files.every(Boolean)&&same(a.files,files);
}

/** The only historical experience predicate; current applicability is a separate label. */
export function experienceReference(store:Store,card:KnowledgeCard,scope:Scope,current?:CurrentExperienceContext):ExperienceGate {return store.readSnapshot(()=>{const live=store.get('cards',card.id);return live?experienceReferenceBody(store,live,scope,current):{eligible:false,state:'invalidated',reason:'candidate_or_source_unavailable'};});}
function experienceReferenceBody(store:Store,card:KnowledgeCard,scope:Scope,current?:CurrentExperienceContext):ExperienceGate {
 if(!candidateValid(store,card,scope))return {eligible:false,state:'invalidated',reason:'candidate_or_source_unavailable'};
 if(hasStaleNormalizationOrigin(store,card))return {eligible:false,state:'invalidated',reason:'normalization_origin_stale'};
 const origin=normalizationBinding(store,card);
 const links=store.experienceActions('experience.evidence-link',{scope,cardId:card.id}).filter(row=>row.status==='completed');
 const valid:{association:ExperienceAssociation;observation:TestObservation;times:Map<string,string>}[]=[];
 let hadLink=false,invalidLink=false;
 for(const row of links){
  const parsed=canonicalExperiencePayloadSchema.safeParse(row.payload);if(!parsed.success||parsed.data.association.cardId!==card.id)continue;hadLink=true;
  const association=parsed.data.association,retained=readTestObservationWithTimes(store,association.observationId,scope),o=retained?.observation,refs=o&&associationRefs(store,card,o,association.relevance.recordSourceId);
  if(!o||!refs||origin&&!same(origin,association.versionBinding)||row.id!==stableId('experience-evidence-link',association)||row.payload.digest!==digest(association)||!same(row.payload.sourceRefs,refs)){invalidLink=true;continue;}
  const expected=derive(store,card,o,association.versionBinding);
  if(expected&&same(expected,association)&&retained)valid.push({association,observation:o,times:retained.times});
  else if(!unsupportedLegacyRelation(store,card,o,association))invalidLink=true;
 }
 if(!valid.length){const invalid=hadLink&&invalidLink;return {eligible:false,state:invalid?'invalidated':'pending',reason:invalid?'evidence_unavailable':'missing_relevance_binding'};}
 valid.sort((a,b)=>Date.parse(a.observation.observedAt)-Date.parse(b.observation.observedAt)||a.observation.id.localeCompare(b.observation.id));
 const successes=valid.flatMap(value=>value.observation.checks.filter(check=>value.association.checkIds.includes(check.id)).map(check=>({value,check,time:value.times.get(check.id)})));
 const dated=successes.filter((item):item is typeof item&{time:string}=>!!item.time).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time)||a.value.observation.id.localeCompare(b.value.observation.id));
 const latest=dated.at(-1)?.value??valid[0]!,lastSuccess=dated.at(-1),reasons:string[]=[],evidenceIds:string[]=[];
 let status:ExperienceReference['currentApplicability']['status']='unknown';
 if(current&&scopeMatches(current,scope)&&current.repository===latest.observation.repository){
  if(current.revision&&current.revision!==latest.observation.snapshot.revision)reasons.push(`Current revision ${current.revision} differs from tested revision ${latest.observation.snapshot.revision}.`);
  for(const [key,value] of Object.entries(current.environment)){const observed=latest.observation.environment.observed[key];if(observed!==undefined&&observed!==value)reasons.push(`Current ${key} ${value} differs from observed ${observed}.`);}
  if(reasons.length)status='needs-revalidation';
  else if(latest.observation.snapshot.overlayHash)reasons.push('The tested snapshot included an overlay whose identity is not supplied by the current context.');
  else if(current.revision===latest.observation.snapshot.revision&&lastSuccess&&Date.parse(lastSuccess.time)>=Date.parse(current.observedAt)&&Object.entries(current.environment).every(([key,value])=>latest.observation.environment.observed[key]===value)){status='checked';evidenceIds.push(latest.observation.id);reasons.push(`A related check succeeded on the requested current revision at ${lastSuccess.time}, after the context was observed.`);}
  else if(!lastSuccess)reasons.push(`The check execution time is unknown; its observation was read at ${latest.observation.observedAt}.`);
  else if(Date.parse(lastSuccess.time)<Date.parse(current.observedAt))reasons.push(`The related check finished at ${lastSuccess.time}, before the current context was observed; its observation was read at ${latest.observation.observedAt}.`);
 }
 const project=store.get('projects',card.projectId)!;
 const targets=new Set(valid.flatMap(({association,observation})=>observation.checks.filter(check=>association.checkIds.includes(check.id)).flatMap(check=>[...(check.command?[`command:${check.command}`]:[]),...(check.name?[`name:${check.name}`]:[])])));
 const independentSuccesses:{observation:TestObservation;check:TestObservation['checks'][number];time:string|undefined}[]=[];
 const pendingFailures:{observation:TestObservation;check:TestObservation['checks'][number];times:Map<string,string>;sameObservation:boolean}[]=[];
 const recordFailure=(observation:TestObservation,check:TestObservation['checks'][number],times:Map<string,string>,sameObservation:boolean)=>{
  const time=times.get(check.id),name=check.name??check.command??check.id;
  const matching=[...successes.map(item=>({observation:item.value.observation,check:item.check,time:item.time,associated:true})),...independentSuccesses.map(item=>({...item,associated:false}))].filter(item=>sameFailureTarget(card,observation,check,item.observation,item.check));
  const snapshot=`tested revision ${observation.snapshot.revision}${observation.snapshot.overlayHash?`, overlay ${observation.snapshot.overlayHash}`:''}`;
  const recovery=time&&matching.filter(item=>item.time&&Date.parse(item.time)>Date.parse(time));
  if(recovery&&recovery.length){
   if(!recovery.some(item=>item.associated)){
    const latest=recovery.sort((a,b)=>Date.parse(b.time!)-Date.parse(a.time!))[0]!;
    if(!evidenceIds.includes(latest.observation.id))evidenceIds.push(latest.observation.id);
    reasons.push(`A related check succeeded at ${latest.time} (${latest.observation.id}) after failure ${observation.id} at ${time}; ${snapshot}, check: ${name}.`);
   }
   return;
  }
  if(!evidenceIds.includes(observation.id))evidenceIds.push(observation.id);
  if(sameObservation&&!matching.length){
   status='needs-revalidation';reasons.push(`A related check failed in the same observation (${observation.id}), read at ${observation.observedAt}; ${snapshot}, check: ${name}.`);
  }else if(!time||matching.some(item=>!item.time)){
   if(status==='checked')status='unknown';
   reasons.push(`A related check failed (${observation.id}, ${name}); execution order is unknown. Observation read at ${observation.observedAt}${time?`; recorded execution ${time}`:''}, ${snapshot}.`);
  }else{
   status='needs-revalidation';reasons.push(matching.length
    ?`A related check failed later at ${time} (${observation.id}); observation read at ${observation.observedAt}, ${snapshot}, check: ${name}.`
    :`A related check failed at ${time} (${observation.id}); no later success for that tested target is retained. Observation read at ${observation.observedAt}, ${snapshot}, check: ${name}.`);
  }
 };
 for(const {association,observation,times} of valid){
  let relatedChecks:TestObservation['checks']=[];
  if(observation.origin.kind==='local'){
   const source=store.get('sources',observation.sourceId),declaration=source&&parseStructuredKnowledge(source,project,'local-relations-v1');
   const relation=declaration&&localRelation(declaration,card,observation,project.trustedChecks),named=relation?.selectors??[];
   for(const command of named)targets.add(`command:${command}`);
   relatedChecks=relation?.checks??[];
   if(observation.id===latest.observation.id){
    const missing=named.filter(command=>!observation.checks.some(check=>check.command===command));
    if(missing.length)reasons.push(`Named checks not observed in ${observation.id}: ${missing.join(', ')}.`);
   }
  }else{
   const source=store.get('sources',observation.sourceId);let parsed:ReturnType<typeof parseStructuredKnowledge>;
   try{parsed=source&&parseStructuredKnowledge(source,project);}catch{parsed=undefined;}
   if(parsed?.kind==='experience'){const names=parsed.input.checkIds;for(const name of names)targets.add(`name:${name}`);relatedChecks=observation.checks.filter(check=>!!check.name&&names.includes(check.name));}
  }
  for(const check of relatedChecks.filter(check=>check.result==='failure'))pendingFailures.push({observation,check,times,sameObservation:true});
 }
 const validIds=new Set(valid.map(value=>value.observation.id));
 const related=store.experienceActions('experience.test-observation',{scope,file:card.experience!.files[0]}).flatMap(row=>{
  const retained=readTestObservationWithTimes(store,row.id,scope),observation=retained?.observation;if(!observation||!retained||validIds.has(observation.id))return [];
  const checks=laterRelatedChecks(store,card,observation,targets);return checks.length?[{observation,checks,times:retained.times}]:[];
 });
 for(const {observation,checks,times} of related){
  for(const check of checks)if(check.result==='failure')pendingFailures.push({observation,check,times,sameObservation:false});
  else if(check.result==='success')independentSuccesses.push({observation,check,time:times.get(check.id)});
 }
 for(const {observation,check,times,sameObservation} of pendingFailures)recordFailure(observation,check,times,sameObservation);
 if(!reasons.length)reasons.push('Current applicability has not been established.');
 if(latest.association.versionBinding)reasons.push(`The source reported an unknown version; observation ${latest.observation.id} supplied tested revision ${latest.association.versionBinding.observedRevision}.`);
 const delivery=valid.map(value=>retainedDelivery(store,value.observation)).find(value=>value!==undefined);
 const reference:ExperienceReference={...(delivery?{delivery}:{}),label:'historical-test-backed-reference',observationIds:valid.map(value=>value.observation.id),reportedSolution:{text:card.experience!.solution,status:solutionStatus(store,card)},observed:valid.map(({association,observation,times})=>{
  const checks=observation.checks.filter(check=>association.checkIds.includes(check.id));
  const checkTimes=checks.map(check=>{const eventAt=times.get(check.id);return {checkId:check.id,...(eventAt?{eventAt}:{}),timeBasis:eventAt?(observation.origin.kind==='ci'?'provider-completion' as const:'local-process' as const):'unknown' as const};});
  const first=checkTimes[0],sameTime=!!first?.eventAt&&checkTimes.every(value=>value.eventAt&&Date.parse(value.eventAt)===Date.parse(first.eventAt!));
  return {observationId:observation.id,observedAt:observation.observedAt,...(sameTime?{eventAt:first!.eventAt,timeBasis:first!.timeBasis}:{timeBasis:'unknown' as const}),checkTimes,evidenceLocator:observation.origin.kind==='local'?`local-run:${observation.origin.runId}`:observation.origin.url,checks,snapshot:observation.snapshot,environment:observation.environment,relevance:association.relevance};
 }),...(latest.association.versionBinding?{versionBinding:latest.association.versionBinding}:{}),invalidationConditions:card.experience!.invalidationConditions,currentApplicability:{status,reasons,evidenceIds}};
 return {eligible:true,state:'historical',reference};
}
