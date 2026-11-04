import { createHash } from 'node:crypto';
import { z } from 'zod';

export type Runner = 'grok' | 'dsh' | 'codex';
export const roles = ['knowledge_extract', 'case_extract', 'decide', 'plan', 'execute', 'check', 'feedback'] as const;
export type Role = typeof roles[number];
export const taskStatuses = ['queued', 'extracting', 'deciding', 'researching', 'awaiting_answer', 'planning', 'executing', 'checking', 'publishing', 'feedback', 'delivered', 'archived', 'blocked', 'retrying', 'cancelled'] as const;
export type TaskStatus = typeof taskStatuses[number];
export interface Scope { projectId: string; domain: string }
export interface Project extends Scope {
  id: string; name: string; description: string; repository: string; repositoryProvider: 'github' | 'gitlab';
  prdPath: string; allowedPaths: string[]; trustedChecks: string[]; trustedAppIds: number[];
  reviewIntervalDays?: number; ownerId: string; autoMerge: boolean; budgetUsd: number; executionRunner?: 'grok' | 'dsh'; sourceDir?: string; createdAt: string;
}
export interface SourceRevision extends Scope {
  purpose?: 'task' | 'reference'; id: string; kind: 'file' | 'feishu' | 'github' | 'conversation' | 'manual' | 'reading';
  /** Host-recorded Vault dependencies; editable projections cannot replace these edges. */
  parentSources?: { id: string; revision: string }[];
  externalId: string; revision: string; title: string; content: string; locator: string;
  authorId: string; retention: 'permanent' | 'ephemeral'; status: 'active' | 'superseded' | 'withdrawn'; createdAt: string;
}
export interface Task extends Scope {
  id: string; sourceId: string; sourceRevision: string; title: string; description: string; status: TaskStatus;
  version: number; createdAt: string; updatedAt: string; runAfter: string; attempts: number; repairCount: number;
  budgetUsd: number; spentUsd: number; stage: Role | 'research' | 'delivery'; questionId?: string;
  decision?: Decision; decisionSnapshotId?: string; plan?: ExecutionPlan; artifact?: Artifact; review?: Review; receiptId?: string;
  feedback?: string; error?: string; blockedFrom?: TaskStatus; baselineFiles?: {path:string;content:string}[];
}
export interface Citation { sourceId: string; revision: string; quote: string; locator: string }
export interface KnowledgeCard extends Scope {
  id: string; sourceId: string; sourceRevision: string; title: string; body: string; quote: string; locator: string;
  kind: 'fact' | 'knowledge' | 'experience'; verification: 'reported' | 'verified' | 'inference';
  status: 'active' | 'withdrawn'; aliases: string[]; createdAt: string; expiresAt?: string;
}
export interface Rule extends Scope {
  id: string; title: string; statement: string; conditions: string; exceptions: string;
  version: number; kind: 'principle' | 'observation' | 'external'; status: 'active' | 'suspended' | 'superseded';
  caseIds: string[]; citations: Citation[]; createdAt: string; reviewAt: string; supersedes?: string;
}
export interface DecisionCase extends Scope {
  id: string; taskId: string; questionId: string; decisionId: string; actorId: string; choice: 'A' | 'B' | 'C';
  originalWords: string; rationale: string; alternatives: string[]; ruleIds: string[]; sourceId: string;
  status: 'active' | 'withdrawn'; createdAt: string; outcome?: string;
  decisionSnapshot?: DecisionSnapshot; outcomes?: CaseOutcome[];
}
export interface DecisionSnapshot extends Scope {
  schemaVersion: 1; id: string; taskId: string; taskVersion: number; attemptId: string; inputHash: string;
  sourceId: string; sourceRevision: string; goal: { title: string; description: string };
  decision: Decision; rules: Rule[]; sourceRefs: { id: string; revision: string }[];
  reviewAt?: string; reviewIntervalDays?: number; expectedOutcome: string | null; research?: ResearchRecord; recordedAt: string;
}
export interface CaseOutcome { id: string; receiptId: string; recordedAt: string; summary: string }
export interface ResearchSource {
  url: string; title: string; language: 'zh' | 'en'; publishedAt: string; accessedAt: string; excerpt: string;
  primary: boolean; canonicalUrl: string; conditions: string;
}
export interface ResearchRecord {
  queries: { language: 'zh' | 'en'; query: string; searchedAt: string; sources: ResearchSource[] }[];
  summary: string; gaps: string[];
}
export interface Suggestion { label: string; description: string; rationale: string; tradeoff: string; evidenceUrls: string[] }
export interface Question extends Scope {
  id: string; taskId: string; taskVersion: number; version: number; ownerId: string; title: string; context: string;
  options: { A: Suggestion; B: Suggestion }; research: ResearchRecord; status: 'open' | 'answered' | 'stale';
  createdAt: string; answeredAt?: string; answer?: { choice: 'A' | 'B' | 'C'; text: string; actorId: string; eventId: string };
  decisionSnapshotId?: string;
}
export interface AuditEvent extends Scope {
  id: string; taskId?: string; type: string; message: string; createdAt: string; data: Record<string, unknown>;
}
export interface Attempt extends Scope {
  id: string; taskId: string; taskVersion: number; role: Role; runner: Runner; model: string; provider: string;
  inputHash: string; status: 'running' | 'succeeded' | 'unavailable' | 'failed' | 'stale';
  costUsd: number; startedAt: string; finishedAt?: string; error?: string;
}
export interface OutboxMessage extends Scope {
  id: string; taskId?: string; channel: 'feishu' | 'origin'; recipient: string; text: string;
  status: 'pending' | 'sent'; attempts: number; runAfter: string; createdAt: string; remoteId?: string;sourceIds?:string[];
}
export interface DeliveryReceipt extends Scope {
  id: string; taskId: string; repository: string; path: string; pullRequestUrl: string; pullRequestNumber: number;
  headSha: string; mergeSha: string; contentHash: string; verifiedAt: string; checks: CheckEvidence[];
}
export interface CheckEvidence { name: string; conclusion: string; headSha: string; appId: number; url: string }
export interface ActionRecord extends Scope {
  id: string; taskId?: string; kind: string; status: 'pending' | 'completed'; payload: Record<string, unknown>; updatedAt: string;
}
export interface Cursor extends Scope { id: string; value: string; updatedAt: string }
export interface Entities {
  projects: Project; sources: SourceRevision; tasks: Task; cards: KnowledgeCard; rules: Rule; cases: DecisionCase;
  questions: Question; events: AuditEvent; attempts: Attempt; outbox: OutboxMessage; receipts: DeliveryReceipt;
  actions: ActionRecord; cursors: Cursor;
}
export type Table = keyof Entities;

export const citationSchema = z.object({ sourceId: z.string(), revision: z.string(), quote: z.string().min(1), locator: z.string() });
export const suggestionSchema = z.object({ label: z.string().min(1), description: z.string().min(1), rationale: z.string().min(1), tradeoff: z.string().min(1), evidenceUrls: z.array(z.string().url()).min(1) });
export const decisionSchema = z.object({
  action: z.enum(['proceed', 'ask', 'archive']), summary: z.string().min(1), rationale: z.string().min(1),
  citations: z.array(citationSchema), ruleIds: z.array(z.string()),
  expectedOutcome: z.string().min(1).nullable().optional(),
  question: z.object({ title: z.string().min(1), context: z.string(), A: suggestionSchema, B: suggestionSchema }).optional(),
}).superRefine((v, ctx) => {
  if (v.action === 'ask' && !v.question) ctx.addIssue({ code: 'custom', message: 'A question with exactly two recommendations is required.' });
});
export type Decision = z.infer<typeof decisionSchema>;
export const executionPlanSchema = z.object({
  taskVersion: z.number().int().positive(), sourceRevision: z.string(), baselineSha: z.string().min(1),
  summary: z.string().min(1), paths: z.array(z.string()).min(1), steps: z.array(z.string()).min(1),
  tests: z.array(z.string()).min(1), stopConditions: z.array(z.string()).min(1),
});
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;
export const artifactSchema = z.object({
  taskVersion: z.number().int().positive(), planHash: z.string(), baselineSha: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string().max(1_000_000) })).min(1),
  tests: z.array(z.object({ command: z.string(), passed: z.boolean(), output: z.string() })).min(1), summary: z.string(),
});
export type Artifact = z.infer<typeof artifactSchema>;
export const reviewSchema = z.object({
  taskVersion: z.number().int().positive(), planHash: z.string(), artifactHash: z.string(),
  verdict: z.enum(['pass', 'repair', 'ask']), summary: z.string().min(1), issues: z.array(z.string()),
  tests: z.array(z.object({ command: z.string(), passed: z.boolean(), output: z.string() })).min(1),
});
export type Review = z.infer<typeof reviewSchema>;
export const knowledgeOutputSchema = z.object({ cards: z.array(z.object({
  title: z.string().min(1), body: z.string(), quote: z.string().min(1), aliases: z.array(z.string()),
  verification: z.enum(['reported', 'inference']), kind: z.enum(['fact', 'knowledge', 'experience']),
})) });
export const caseOutputSchema = z.object({ observations: z.array(z.object({ title: z.string(), statement: z.string(), quote: z.string().min(1), conditions: z.string(), exceptions: z.string() })) });
export const feedbackSchema = z.object({ summary: z.string().min(1), observations: z.array(z.string()) });
export const roleSchemas = { knowledge_extract: knowledgeOutputSchema, case_extract: caseOutputSchema, decide: decisionSchema, plan: executionPlanSchema, execute: artifactSchema, check: reviewSchema, feedback: feedbackSchema };
export const questionAnswerSchema = z.object({
  questionId: z.string().min(1), taskVersion: z.number().int().positive(), questionVersion: z.number().int().positive(),
  choice: z.enum(['A', 'B', 'C']), text: z.string().trim().max(10000).optional(), actorId: z.string().min(1), eventId: z.string().min(1),
}).superRefine((v, ctx) => { if (v.choice === 'C' && !v.text) ctx.addIssue({ code: 'custom', message: 'Tell PAtrick what you decided.', path: ['text'] }); });
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;

export interface WorkerInput {
  task: Task; project: Project; role: Role; source: SourceRevision; cards: KnowledgeCard[]; rules: Rule[];
  answer?: string; research?: ResearchRecord; receipt?: DeliveryReceipt; plan?: ExecutionPlan; artifact?: Artifact; baselineSha?: string; baselineFiles?: {path:string;content:string}[];
}
export interface WorkerResult { output: unknown; costUsd: number; model: string; provider: string }
export interface WorkerAdapter { name: Runner; run(input: WorkerInput, signal?: AbortSignal): Promise<WorkerResult> }
export interface DeliveryWriter { deliver(task: Task, project: Project): Promise<DeliveryReceipt>; baseline(project: Project): Promise<string>; readBaseline?(project:Project,sha:string):Promise<{path:string;content:string}[]> }
export interface ResearchAdapter { research(question: string, project: Project): Promise<ResearchRecord> }
export interface NotificationAdapter { send(message: OutboxMessage): Promise<{ remoteId: string }> }
export interface RunnerPolicy { runner: Runner; roles: Role[]; domains: string[]; provider: string; model: string; admitted: boolean; costPerRunUsd: number; independentReview: boolean }
export interface AppConfig {
  mode: 'live' | 'demo' | 'test'; host: string; port: number; dataDir: string; vaultDir: string; ownerId: string;
  authToken: string; sessionSecret: string; projects: Project[]; runnerPolicies: RunnerPolicy[];
  workers: Partial<Record<Runner, { command: string; args: string[]; timeoutMs: number; isolation: 'lima'; instance: string }>>;
  githubToken?: string; gitlabToken?: string; gitlabUrl?: string;
  feishu?: { appId: string; appSecret: string; verificationToken?: string; encryptKey?: string; ownerOpenId: string; chatId?: string };
  researchUrl?: string; researchToken?: string; scanIntervalMs: number;
  egressPolicies?: {domain:string;research:boolean;feishu:boolean}[]; networkFile?:string;
}

export class DomainError extends Error {
  constructor(message: string, public code = 'invalid', public status = 400) { super(message); this.name = 'DomainError'; }
}
export class WorkerUnavailable extends Error { constructor(message: string) { super(message); this.name = 'WorkerUnavailable'; } }
export function now(): string { return new Date().toISOString(); }
export function digest(value: string | object): string { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }
export function stableId(...parts: unknown[]): string { return digest(JSON.stringify(parts)).slice(0, 32); }
export function tokenize(text: string): string {
  const terms = text.toLowerCase().match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) ?? [];
  return terms.flatMap((term) => /\p{Script=Han}/u.test(term) && term.length > 1 ? Array.from({ length: term.length - 1 }, (_, i) => term.slice(i, i + 2)) : [term]).join(' ');
}
export function safeRelativePath(path: string): string {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || /^[a-z]:/i.test(path) || path.split('/').some(p => p === '..' || p === '.' || p === '' || p.toLowerCase() === '.git')) throw new DomainError('Path must stay within the allowed repository files.', 'forbidden_path', 403);
  return path;
}
export function pathAllowed(path: string, allowed: string[]): boolean {
  safeRelativePath(path);
  return allowed.some(rule => rule.endsWith('/') ? path.startsWith(rule) : path === rule);
}
