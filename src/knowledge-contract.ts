import { z } from 'zod';
import type { Citation, KnowledgeCard, Scope } from './domain.js';

/** Reported experience description only; host evidence and derived views live separately. */
export interface ExperienceDetails {
  schemaVersion: 1;
  problem: string;
  symptomAliases: string[];
  solution: string;
  files: string[];
  productId: string;
  codeVersion: string;
  environment: string;
  invalidationConditions: string[];
}

export interface ObservedFile { path: string; sha256: string; mode: string }
export interface TestEnvironment { observed: Record<string, string>; unknown: string[] }
export interface ObservedCheck {
  id: string; name?: string; command?: string; testFile?: string;
  result: 'success' | 'failure' | 'incomplete'; outputDigest: string;
  process?: { exitCode: number | null; signal: string | null; timedOut: boolean; startedAt: string; finishedAt: string; errorCode?:'ETIMEDOUT'|'ENOBUFS'|'ENOENT'|'EACCES'|'PROCESS_ERROR' };
}
/** Shared bounded process facts; raw exception text is never part of evidence. */
export const observedProcessSchema:z.ZodType<NonNullable<ObservedCheck['process']>>=z.object({
 exitCode:z.number().int().nullable(),signal:z.string().min(1).max(10000).nullable(),timedOut:z.boolean(),
 startedAt:z.string().datetime({offset:true}),finishedAt:z.string().datetime({offset:true}),
 errorCode:z.enum(['ETIMEDOUT','ENOBUFS','ENOENT','EACCES','PROCESS_ERROR']).optional(),
}).strict();
export interface ComparableTestIdentity { snapshotDigest: string; testDefinitionDigest: string }
export interface TestObservation extends Scope {
  schemaVersion: 1; id: string; sourceId: string; sourceRevision: string; repository: string; observedAt: string;
  snapshot: { revision: string; overlayHash?: string; files: ObservedFile[] };
  checks: ObservedCheck[]; environment: TestEnvironment; comparable?: ComparableTestIdentity;
  origin:
    | { kind:'local'; taskId:string; taskVersion:number; attemptId:string; inputHash:string; planHash:string; artifactHash:string; role:'execute'|'check'; runId:string }
    | { kind:'ci'; provider:'github'|'gitlab'; runId:string; jobId:string; producerId:string; headSha:string; url:string; responseDigest:string; receiptId?:string };
}
export interface StructuredExperienceInput {
  schemaVersion:1; quote:string; details:ExperienceDetails; repository:string; headSha:string;
  runId:string; jobId:string; checkIds:string[]; issueId?:string; testReportPath?:string;
}
export interface RepositoryFactInput {
  schemaVersion:1; kind:'repository-facts'; quote:string; repository:string; changeNumber?:number; headSha:string;
  checks:{runId:string;jobId:string;checkName:string}[]; testReportPath?:string;
}
export type ParsedStructuredKnowledge = {kind:'repository-facts';input:RepositoryFactInput} | {kind:'experience';input:StructuredExperienceInput};
export type RequestedRepositoryClaim =
  | {kind:'change-head';repository:string;number:number}
  | {kind:'commit-exists';repository:string;sha:string}
  | {kind:'ci-result';repository:string;headSha:string;runId:string;jobId:string;checkName:string};
export interface SourceRef {id:string;revision:string}
export type RepositorySubject = {provider:'github'|'gitlab';repository:string};
export type AtomicClaim =
  | {kind:'change-head';subject:RepositorySubject & {number:number};value:{headSha:string;state:'open'|'closed'|'merged'}}
  | {kind:'commit-exists';subject:RepositorySubject & {sha:string};value:{exists:true}}
  | {kind:'ci-result';subject:RepositorySubject & {headSha:string;runId:string;jobId:string;checkName:string};value:{conclusion:'success'|'failure'|'pending'|'cancelled'}}
  | {kind:'test-result';subject:RepositorySubject & {testedRevision:string;snapshotDigest:string;testDefinitionDigest:string};value:{result:'success'|'failure'|'incomplete'}};
export interface ClaimCandidate {schemaVersion:1;claim:AtomicClaim;quote:string;interpretation:'reported'|'inference'}
export interface HostObservation extends Scope {
  schemaVersion:1;id:string;claim:AtomicClaim;
  origin:{kind:'provider'|'host-test';provider?:'github'|'gitlab';repository:string;producerId:string;originalEventId:string;independentOrigin:string;derivedFrom:string[]};
  sourceRefs:SourceRef[];responseDigest:string;locator:string;observedAt:string;eventAt?:string;bindingHash:string;
}
export interface KnowledgeEvidenceLink extends Scope {
  schemaVersion:1;cardId:string;candidateHash:string;claimHash:string;observationIds:string[];observationHashes:string[];
  basis:'authoritative-record'|'independent-corroboration';sourceRefs:SourceRef[];createdAt:string;
}
export type FactRequest = {temporal:'historical'} | {temporal:'current';contextId:string};
export interface FactRef {cardId:string;claimHash:string;request:FactRequest}
export interface FactualContext extends Scope {
  id:string;observedAt:string;projectPolicyHash:string;source:SourceRef;sourceHash:string;task?:{id:string;version:number};observations:{id:string;hash:string}[];
}
export interface CanonicalFact extends Scope {
  ref:FactRef;claim:AtomicClaim;text:string;basis:KnowledgeEvidenceLink['basis'];observationIds:string[];sourceRefs:SourceRef[];
  observedAt:string[];eventAt:(string|null)[];temporal:'historical'|'current';limitations:string[];
}
export type FactGate =
  | {eligible:false;reason:'unverified'|'unsupported-claim'|'stale-source'|'out-of-scope'|'withdrawn'|'expired'|'needs-current-readback'|'conflicting-evidence'|'missing-authority'}
  | {eligible:true;fact:CanonicalFact};
export interface StatementUse {citation:Citation;purpose:'requirement'|'author-statement';binding:'task-request'|'accepted-owner-answer'|'source-statement'}
export interface DecisionGrounds {statements:StatementUse[];facts:FactRef[];unresolved:{text:string;citation?:Citation;status:'reported'|'inference'}[]}
export interface FactualUseView {facts:CanonicalFact[];statements:StatementUse[];unresolved:DecisionGrounds['unresolved'];interpretationLabel:'assistant-inference'}
export interface ExperienceAssociation {
  schemaVersion:1;cardId:string;candidateHash:string;sourceId:string;sourceRevision:string;observationId:string;observationHash:string;
  checkIds:string[];files:ObservedFile[];subject:{kind:'task'|'issue';id:string;revision:string};
  relevance:{kind:'named-regression'|'resolution-with-checks';recordSourceId:string;recordRevision:string;quote:string;locator:string;interpretation:'reported'|'inference'};
  versionBinding?:{reported:string;observedRevision:string};
}
export interface CurrentExperienceContext extends Scope {repository:string;revision?:string;environment:Record<string,string>;observedAt:string}
export interface ExperienceReference {
  label:'historical-test-backed-reference';observationIds:string[];reportedSolution:{text:string;status:'reported'|'inference'};
  observed:{checks:ObservedCheck[];snapshot:TestObservation['snapshot'];environment:TestEnvironment;relevance:ExperienceAssociation['relevance'];observationId?:string;observedAt?:string;eventAt?:string;timeBasis?:'provider-completion'|'local-process'|'unknown';checkTimes?:{checkId:string;eventAt?:string;timeBasis:'provider-completion'|'local-process'|'unknown'}[];evidenceLocator?:string}[];
  invalidationConditions:string[];currentApplicability:{status:'unknown'|'needs-revalidation'|'checked';reasons:string[];evidenceIds:string[]};versionBinding?:ExperienceAssociation['versionBinding'];
  delivery?:{receiptId:string;headSha:string;mergeSha:string};
}
export type ExperienceGate = {eligible:false;state:'pending'|'invalidated';reason:string} | {eligible:true;state:'historical';reference:ExperienceReference};
export type KnowledgeView = KnowledgeCard & {
  experienceReference?:ExperienceReference;experienceState?:{state:'pending'|'invalidated';reason:string};factual?:FactGate;reportedStatement?:{text:string;status:'reported'|'inference'};
};
export interface KnowledgeReferenceOptions {usage?:'reference'|'browse';request?:FactRequest;context?:FactualContext;current?:CurrentExperienceContext}
export interface RepositoryReadRequest {
  repository:string;headSha:string;changeNumber?:number;checks:RepositoryFactInput['checks'];filePaths:string[];issueSource?:SourceRef;testReportPath?:string;
  current?:{changeNumber:number;checkNames:string[]};
}
export interface RepositoryReadback {observations:HostObservation[];files:ObservedFile[];tests:TestObservation[];resolution?:{sourceId:string;revision:string;quote:string;locator:string};gaps:string[]}
export type CiReadback = Pick<RepositoryReadback,'tests'|'resolution'>;
export interface ReadbackProvenance {
  sourceHash:string;policyHash:string;requestHash:string;request:RepositoryReadRequest;
  attestedTests:{observationId:string;producerId:string;originalEventId:string;reportPath:string;reportDigest:string;snapshotDigest:string;testDefinitionDigest:string}[];
}
export interface CiTestReportV1 {
  schemaVersion:1;repository:string;headSha:string;runId:string;jobId:string;snapshot:TestObservation['snapshot'];
  definitions:{command:string;files:ObservedFile[]}[];checks:ObservedCheck[];environment:TestEnvironment;
}

// Proposed input only: strict at every level, with no observation/link/context authority.
const text = z.string().min(1).refine(v=>Buffer.byteLength(v)<=10_000);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[1-9][0-9]*$/).max(32);
const number = z.number().int().positive().safe();
const subject = z.object({provider:z.enum(['github','gitlab']),repository:text}).strict();
export const atomicClaimSchema:z.ZodType<AtomicClaim> = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('change-head'),subject:subject.extend({number}).strict(),value:z.object({headSha:sha,state:z.enum(['open','closed','merged'])}).strict()}).strict(),
  z.object({kind:z.literal('commit-exists'),subject:subject.extend({sha}).strict(),value:z.object({exists:z.literal(true)}).strict()}).strict(),
  z.object({kind:z.literal('ci-result'),subject:subject.extend({headSha:sha,runId:id,jobId:id,checkName:text}).strict(),value:z.object({conclusion:z.enum(['success','failure','pending','cancelled'])}).strict()}).strict(),
  z.object({kind:z.literal('test-result'),subject:subject.extend({testedRevision:sha,snapshotDigest:hash,testDefinitionDigest:hash}).strict(),value:z.object({result:z.enum(['success','failure','incomplete'])}).strict()}).strict(),
]);
export const claimCandidateSchema:z.ZodType<ClaimCandidate> = z.object({schemaVersion:z.literal(1),claim:atomicClaimSchema,quote:text,interpretation:z.enum(['reported','inference'])}).strict();
export const requestedRepositoryClaimSchema:z.ZodType<RequestedRepositoryClaim> = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('change-head'),repository:text,number}).strict(),
  z.object({kind:z.literal('commit-exists'),repository:text,sha}).strict(),
  z.object({kind:z.literal('ci-result'),repository:text,headSha:sha,runId:id,jobId:id,checkName:text}).strict(),
]);

/** Private canonical action payloads; never accepted as a provider admission receipt. */
export interface CanonicalHostObservationPayload {
 schemaVersion:1;observation:HostObservation;digest:string;sourceHash:string;policyHash:string;issueSourceHash?:string;
 request:RepositoryReadRequest;requestHash:string;sourceRefs:SourceRef[];
 attestation?:ReadbackProvenance['attestedTests'][number];
}
export interface CanonicalKnowledgeEvidencePayload {schemaVersion:1;link:KnowledgeEvidenceLink;digest:string;sourceRefs:SourceRef[]}
export interface CanonicalCiTestObservationPayload {
 schemaVersion:1;observation:TestObservation;digest:string;sourceHash:string;policyHash:string;issueSourceHash?:string;
 request:RepositoryReadRequest;requestHash:string;sourceRefs:SourceRef[];hostObservationIds:string[];hostObservationHashes:string[];
}
