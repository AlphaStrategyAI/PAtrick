import type { Citation, DecisionSnapshot, Scope } from './domain.js';
import { z } from 'zod';

const prose = z.string().min(1).max(10000).refine(value => !!value.trim());
const hashRef = z.object({ id: prose, version: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const scopeSchema = z.object({ projectId: prose, domain: prose, taskId: prose.optional(), validFrom: z.string().datetime({ offset: true }).optional(), validUntil: z.string().datetime({ offset: true }).optional() }).strict();
const improvementRef = z.union([
  hashRef.extend({ kind: z.enum(['rule-version', 'candidate-version']), historyId: prose }).strict(),
  z.object({ kind: z.literal('source-lesson'), source: z.object({ id: prose, revision: prose }).strict(), quote: prose, hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
export const caseMentionSchema = z.object({
  quote: prose, locator: prose.describe('Use the exact source locator; if the quote occurs more than once, append #chars=start-end with zero-based UTF-16 offsets.'), title: z.string().min(1).max(240).refine(value => !!value.trim()), choiceText: prose, rationale: prose.nullable(), alternatives: z.array(prose).max(40), originalDecisionLocator: prose.optional(),
  ownerDeclaration: z.object({ quote: prose, scopeQuote: prose, declaredScope: scopeSchema, baseline: hashRef.optional(), relation: z.enum(['owner-change', 'bounded-exception']).optional(), improvement: z.object({ ref: improvementRef, relation: z.enum(['adopted', 'rejected']), quote: prose, binding: z.enum(['native-reply', 'exact-quoted-version']) }).strict().optional() }).strict().optional(),
}).strict();

export interface CaseRef { id: string; version: number; hash: string }
export interface SourceRef { id: string; revision: string }
export type ImprovementRef =
  | { kind: 'rule-version' | 'candidate-version'; id: string; version: number; hash: string; historyId: string }
  | { kind: 'source-lesson'; source: SourceRef; quote: string; hash: string };
export interface OriginalOwnerDecision {
  source: SourceRef; quote: string; scopeQuote: string;
  declaredScope: { projectId: string; domain: string; taskId?: string; validFrom?: string; validUntil?: string };
  baseline?: { id: string; version: number; hash: string };
  relation?: 'owner-change' | 'bounded-exception';
  improvement?: { ref: ImprovementRef; relation: 'adopted' | 'rejected'; quote: string; binding: 'native-reply' | 'exact-quoted-version' };
}
export interface OwnerOriginRef { id: string; hash: string }
export interface CaseMention {
  quote: string; locator: string; title: string; choiceText: string; rationale: string | null; alternatives: string[];
  originalDecisionLocator?: string; ownerDeclaration?: Omit<OriginalOwnerDecision, 'source'>;
}
export interface CanonicalCaseVersion extends Scope {
  schemaVersion: 1; id: string; version: number; hash: string; identity: 'host-bound' | 'unresolved';
  original: { kind: 'question' | 'authenticated-message' | 'authenticated-source-decision' | 'source-fragment'; id: string; revision: string };
  authority: 'owner-explicit' | 'source-report'; ownerId?: string; ownerCaseId?: string; taskId?: string; decisionSnapshotId?: string;
  frozenJudgment: Pick<DecisionSnapshot, 'id' | 'taskVersion' | 'inputHash' | 'decision' | 'rules' | 'expectedOutcome' | 'recordedAt'> | null;
  sourceRefs: SourceRef[]; citations: Citation[]; choiceText: string; rationale: string | null; alternatives: string[];
  ruleVersions: { id: string; version: number; hash: string }[]; expectedOutcome: string | null;
  observationRefs: { kind: 'receipt' | 'outcome-evidence' | 'outcome-review' | 'planned-test' | 'host-knowledge'; id: string; hash: string }[];
  effectiveAt: string; recordedAt: string;
}
export interface CaseBatch extends Scope {
  schemaVersion: 1; id: string; policyVersion: 'r042-v1'; purpose: 'observation' | 'evaluation-training'; policyHash: string;
  retention: 'permanent' | 'ephemeral'; cases: CaseRef[]; sourceRefs: SourceRef[];
  observationRefs: CanonicalCaseVersion['observationRefs']; createdAt: string;
}
export interface CaseEvidenceRef { case: CaseRef; citation: Citation }
export interface ObservationCandidate {
  title: string; statement: string; conditions: string; exceptions: string; supports: CaseEvidenceRef[]; opposes: CaseEvidenceRef[];
  relation: 'pattern' | 'possible-change-of-mind' | 'bounded-exception' | 'conflict'; baseline?: CaseRef;
  proposedScope: { projectId: string; domain: string; taskId?: string; validFrom?: string; validUntil?: string };
}
export interface ObservationResult { schemaVersion: 1; batchId: string; batchHash: string; observations: ObservationCandidate[] }
export interface RuleHistory extends Scope {
  schemaVersion: 1; id: string; ruleId: string; version: number; previous?: CaseRef; kind: 'observation' | 'principle';
  relation: ObservationCandidate['relation'] | 'owner-change' | 'initial' | 'revision'; effectiveAt: string; validUntil?: string;
  supports: CaseEvidenceRef[]; opposes: CaseEvidenceRef[]; confirmation: CaseRef | null; scopeCitation?: Citation;
  application: { taskId?: string; exceptionOf?: string }; batchId?: string; ruleHash: string; createdAt: string;
}
export interface RuleChangeProposal {
  candidateId: string; candidateHash: string; baseline?: CaseRef; scope: ObservationCandidate['proposedScope'];
  relation: 'owner-change' | 'bounded-exception'; statement: string; conditions: string; exceptions: string;
}
