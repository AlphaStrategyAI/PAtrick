import { createHash } from 'node:crypto';
import type { KnowledgeCard, Project } from './domain.js';
import type { AtomicClaim, ObservedFile, RequestedRepositoryClaim, TestObservation } from './knowledge-contract.js';

const normalizedAliases = (values: string[]): string[] => [...new Set(values.map(value => value.trim()).filter(Boolean))].sort();
function claimIdentity(claim:AtomicClaim):AtomicClaim {
  const subject={provider:claim.subject.provider,repository:claim.subject.repository};
  switch(claim.kind){
    case 'change-head':return {kind:claim.kind,subject:{...subject,number:claim.subject.number},value:{headSha:claim.value.headSha,state:claim.value.state}};
    case 'commit-exists':return {kind:claim.kind,subject:{...subject,sha:claim.subject.sha},value:{exists:claim.value.exists}};
    case 'ci-result':return {kind:claim.kind,subject:{...subject,headSha:claim.subject.headSha,runId:claim.subject.runId,jobId:claim.subject.jobId,checkName:claim.subject.checkName},value:{conclusion:claim.value.conclusion}};
    case 'test-result':return {kind:claim.kind,subject:{...subject,testedRevision:claim.subject.testedRevision,snapshotDigest:claim.subject.snapshotDigest,testDefinitionDigest:claim.subject.testDefinitionDigest},value:{result:claim.value.result}};
  }
}
function locatorIdentity(claim:RequestedRepositoryClaim):RequestedRepositoryClaim {
  switch(claim.kind){
    case 'change-head':return {kind:claim.kind,repository:claim.repository,number:claim.number};
    case 'commit-exists':return {kind:claim.kind,repository:claim.repository,sha:claim.sha};
    case 'ci-result':return {kind:claim.kind,repository:claim.repository,headSha:claim.headSha,runId:claim.runId,jobId:claim.jobId,checkName:claim.checkName};
  }
}

/** Bind candidate content, never its display verification, timestamps or derived authority. */
export function knowledgeCandidateHash(card: KnowledgeCard): string {
  const experience = card.experience;
  const identity = {
    id: card.id, sourceId: card.sourceId, sourceRevision: card.sourceRevision,
    projectId: card.projectId, domain: card.domain, title: card.title, body: card.body,
    quote: card.quote, locator: card.locator, aliases: normalizedAliases(card.aliases), kind: card.kind,
    experience: experience ? {
      schemaVersion: experience.schemaVersion, problem: experience.problem,
      symptomAliases: normalizedAliases(experience.symptomAliases), solution: experience.solution,
      files: normalizedAliases(experience.files), productId: experience.productId, codeVersion: experience.codeVersion,
      environment: experience.environment, invalidationConditions: normalizedAliases(experience.invalidationConditions),
    } : null,
    claim: card.claim ? {schemaVersion:card.claim.schemaVersion,claim:claimIdentity(card.claim.claim),quote:card.claim.quote,interpretation:card.claim.interpretation} : null,
    pendingClaim: card.pendingClaim ? locatorIdentity(card.pendingClaim) : null,
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const files = (values: readonly ObservedFile[]) => values.map(v=>({path:v.path,sha256:v.sha256,mode:v.mode})).sort((a,b)=>a.path.localeCompare(b.path));
export function knowledgePolicyHash(project: Project): string {
  return hash({id:project.id,projectId:project.projectId,domain:project.domain,repository:project.repository,repositoryProvider:project.repositoryProvider,
    allowedPaths:[...new Set(project.allowedPaths)].sort(),trustedChecks:[...new Set(project.trustedChecks)].sort(),trustedAppIds:[...new Set(project.trustedAppIds)].sort((a,b)=>a-b),ownerId:project.ownerId});
}
export function snapshotDigest(snapshot: TestObservation['snapshot']): string {
  return hash({revision:snapshot.revision,overlayHash:snapshot.overlayHash??null,files:files(snapshot.files)});
}
export function testDefinitionDigest(definitions: readonly {command:string;files:ObservedFile[]}[]): string {
  return hash(definitions.map(v=>({command:v.command,files:files(v.files)})).sort((a,b)=>a.command.localeCompare(b.command)));
}
