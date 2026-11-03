import { z } from 'zod';
import { citationSchema, DomainError, digest, stableId, type ActionRecord, type AppConfig, type DecisionCase, type DecisionSnapshot, type Scope, type SourceRevision, type Task } from './domain.js';
import type { Store } from './store.js';
const quotedText = z.string().min(1).refine(value => value.trim().length > 0, 'A quotation must contain substantive text.');
const attributionCitationSchema = citationSchema.extend({ quote: quotedText }).strict();
const isoDate = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString());
export const metricObservationSchema = z.object({
    schemaVersion: z.literal(1), name: z.string().trim().min(1), value: z.number().finite(), baseline: z.number().finite().optional(),
    unit: z.string().trim().min(1), sampleSize: z.number().int().positive().optional(), periodStart: isoDate, periodEnd: isoDate,
}).strict().refine(v => Date.parse(v.periodStart) <= Date.parse(v.periodEnd), 'Measurement dates must be ordered.');
export type MetricObservation = z.infer<typeof metricObservationSchema>;
export const outcomeEvidenceInputSchema = z.object({
    projectId: z.string().min(1), domain: z.string().min(1), kind: z.enum(['correction', 'metric', 'failure', 'abandonment']),
    sourceId: z.string().min(1), sourceRevision: z.string().min(1), quote: quotedText.max(2000000), observedAt: isoDate,
    attribution: z.object({ method: z.enum(['none', 'controlled_comparison', 'direct_measurement']), citations: z.array(attributionCitationSchema) }).strict().default({ method: 'none', citations: [] }),
}).strict().refine(v => v.attribution.method === 'none' || v.attribution.citations.length > 0, 'Attribution requires quoted material.');
export type OutcomeEvidenceInput = z.input<typeof outcomeEvidenceInputSchema>;
export type OutcomeEvidence = z.output<typeof outcomeEvidenceInputSchema> & {
    schemaVersion: 1;
    id: string;
    snapshotId: string;
    taskId: string;
    authorId: string;
    actorId: string;
    recordedAt: string;
    metric?: MetricObservation;
};
export interface OutcomeReview extends Scope {
    schemaVersion: 1;
    id: string;
    snapshotId: string;
    taskId: string;
    round: number;
    scheduledAt: string;
    checkedAt: string;
    nextReviewAt: string;
    evidenceIds: string[];
    sourceRefs: {
        id: string;
        revision: string;
    }[];
    receiptIds: string[];
    ownerChoices: {
        caseId: string;
        choice: 'A' | 'B' | 'C';
        createdAt: string;
    }[];
    failedTests: {
        command: string;
        passed: boolean;
        output: string;
    }[];
    taskState: Task['status'];
    status: 'observing' | 'evidence_linked';
    gaps: string[];
    evidence: OutcomeEvidence[];
}
export interface OutcomeReviewView extends Scope {
    snapshotId: string;
    taskId: string;
    snapshot: DecisionSnapshot;
    scheduledAt: string;
    reviewIntervalDays: number;
    latestReview?: OutcomeReview;
    evidence: OutcomeEvidence[];
}
const sameScope = (a: Scope, b: Scope) => a.projectId === b.projectId && a.domain === b.domain;
const before = (date: string, at: Date) => Number.isFinite(Date.parse(date)) && Date.parse(date) <= +at;
function source(store: Store, scope: Scope, id: string, revision: string, temporary: boolean, at: Date, quote?: string, locator?: string): SourceRevision {
    const s = store.get('sources', id);
    if (!s || s.status !== 'active' || s.revision !== revision || !sameScope(s, scope) || !before(s.createdAt, at) || !temporary && s.retention === 'ephemeral')
        throw new DomainError('Evidence source is obsolete, out of scope or outside retention/time bounds.', 'invalid_evidence_source', 409);
    if (quote !== undefined && (!quote.trim() || !s.content.includes(quote) || locator !== undefined && locator !== s.locator))
        throw new DomainError('Evidence must quote the current source exactly.', 'invalid_quote');
    return s;
}
function subject(store: Store, snapshotId: string, at: Date): {
    snapshot: DecisionSnapshot;
    task: Task;
    temporary: boolean;
} {
    const action = store.get('actions', snapshotId), snapshot = action?.payload.snapshot as DecisionSnapshot | undefined;
    const task = snapshot && store.get('tasks', snapshot.taskId), attempt = snapshot && store.get('attempts', snapshot.attemptId);
    if (!snapshot || snapshot.schemaVersion !== 1 || action?.kind !== 'decision.snapshot' || action.status !== 'completed' || action.id !== snapshot.id || !sameScope(action, snapshot) || action.taskId !== snapshot.taskId || !task || !sameScope(task, snapshot) || task.sourceId !== snapshot.sourceId || task.sourceRevision !== snapshot.sourceRevision || !attempt || attempt.role !== 'decide' || attempt.status !== 'succeeded' || !sameScope(attempt, snapshot) || attempt.taskId !== snapshot.taskId || attempt.taskVersion !== snapshot.taskVersion || attempt.inputHash !== snapshot.inputHash || !before(snapshot.recordedAt, at))
        throw new DomainError('Original host judgment is unavailable or invalid.', 'invalid_decision_snapshot', 409);
    const temporary = store.get('sources', task.sourceId)?.retention === 'ephemeral';
    source(store, snapshot, snapshot.sourceId, snapshot.sourceRevision, temporary, at);
    for (const ref of snapshot.sourceRefs)
        source(store, snapshot, ref.id, ref.revision, temporary, at);
    return { snapshot, task, temporary };
}
function validateEvidence(store: Store, snapshot: DecisionSnapshot, temporary: boolean, e: OutcomeEvidence, at: Date): void {
    if (!sameScope(e, snapshot) || e.snapshotId !== snapshot.id || e.taskId !== snapshot.taskId || !before(e.recordedAt, at) || !before(e.observedAt, at) || Date.parse(e.observedAt) < Date.parse(snapshot.recordedAt))
        throw new DomainError('Evidence is outside judgment time or scope.');
    source(store, snapshot, e.sourceId, e.sourceRevision, temporary, at, e.quote);
    for (const c of e.attribution.citations)
        source(store, snapshot, c.sourceId, c.revision, temporary, at, c.quote, c.locator);
}
export function recordOutcomeEvidence(store: Store, config: AppConfig, snapshotId: string, raw: unknown, actorId: string, at = new Date()): OutcomeEvidence {
    const input = outcomeEvidenceInputSchema.parse(raw), { snapshot, task, temporary } = subject(store, snapshotId, at);
    const project = store.get('projects', snapshot.projectId) ?? config.projects.find(p => p.id === snapshot.projectId);
    if (!project || !sameScope(project, snapshot) || actorId !== project.ownerId)
        throw new DomainError('Only the project owner may record outcome evidence.', 'forbidden', 403);
    const s = source(store, snapshot, input.sourceId, input.sourceRevision, temporary, at, input.quote);
    let metric: MetricObservation | undefined;
    if (input.kind === 'metric') {
        try {
            metric = metricObservationSchema.parse(JSON.parse(input.quote));
        }
        catch {
            throw new DomainError('Metric evidence must be quoted measurement JSON.');
        }
        if (metric.periodEnd !== input.observedAt || Date.parse(metric.periodStart) < Date.parse(snapshot.recordedAt))
            throw new DomainError('Measurement period must follow the judgment and end at the observation.');
    }
    const id = stableId('decision-evidence', snapshotId, input.kind, input.sourceId, input.sourceRevision, digest(input.quote));
    const e: OutcomeEvidence = { ...input, schemaVersion: 1, id, snapshotId, taskId: task.id, authorId: s.authorId, actorId, recordedAt: at.toISOString(), ...(metric ? { metric } : {}) };
    validateEvidence(store, snapshot, temporary, e, at);
    const existing = store.get('actions', id);
    if (existing) {
        const original = existing.payload.evidence as OutcomeEvidence | undefined;
        if (existing.kind !== 'decision.evidence' || !original || digest({ ...original, recordedAt: '' }) !== digest({ ...e, recordedAt: '' }))
            throw new DomainError('Evidence identifier has conflicting metadata.', 'evidence_conflict', 409);
        return original;
    }
    store.save('actions', { id, ...{ projectId: task.projectId, domain: task.domain }, taskId: task.id, kind: 'decision.evidence', status: 'completed', payload: { evidence: e }, updatedAt: e.recordedAt });
    return e;
}
function cadence(s: DecisionSnapshot, at: Date) {
    const interval = s.reviewIntervalDays ?? 7, first = Date.parse(s.reviewAt ?? new Date(Date.parse(s.recordedAt) + 7 * 86400000).toISOString());
    const round = Math.max(0, Math.floor((+at - first) / (interval * 86400000)));
    return { interval, round, scheduledAt: new Date(first + round * interval * 86400000).toISOString(), nextReviewAt: new Date(first + (round + 1) * interval * 86400000).toISOString(), due: +at >= first };
}
function currentEvidence(store: Store, actions: ActionRecord[], snapshot: DecisionSnapshot, temporary: boolean, at: Date): OutcomeEvidence[] {
    return actions.flatMap(a => {
        const e = a.payload.evidence as OutcomeEvidence | undefined;
        if (a.kind !== 'decision.evidence' || a.status !== 'completed' || !e || e.snapshotId !== snapshot.id || a.taskId !== snapshot.taskId || !sameScope(a, snapshot))
            return [];
        try {
            validateEvidence(store, snapshot, temporary, e, at);
            return [e];
        }
        catch {
            return [];
        }
    }).sort((a, b) => a.id.localeCompare(b.id));
}
/** Legacy deterministic IDs need an independently bound question; task/version alone is ambiguous. */
function caseMatchesSnapshot(store: Store, c: DecisionCase, snapshot: DecisionSnapshot): boolean {
    if (c.decisionSnapshot && c.decisionSnapshot.id !== snapshot.id) return false;
    if (c.decisionId === snapshot.id) return true;
    if (c.decisionId !== stableId('decision', snapshot.taskId, snapshot.taskVersion)) return false;
    const q = store.get('questions', c.questionId);
    return !!q && sameScope(q, snapshot) && q.taskId === snapshot.taskId && q.taskVersion === snapshot.taskVersion && q.decisionSnapshotId === snapshot.id;
}
/** Parse the ledger once, then reuse each subject's evidence/reports throughout this operation. */
function actionIndex(store: Store): { actions: ActionRecord[]; bySnapshot: Map<string, ActionRecord[]> } {
    const actions = store.list('actions'), bySnapshot = new Map<string, ActionRecord[]>();
    for (const a of actions) {
        const id = a.kind === 'decision.evidence' ? (a.payload.evidence as OutcomeEvidence | undefined)?.snapshotId
            : a.kind === 'decision.review' ? (a.payload.review as OutcomeReview | undefined)?.snapshotId : undefined;
        if (!id) continue;
        const group = bySnapshot.get(id) ?? [];
        group.push(a); bySnapshot.set(id, group);
    }
    return { actions, bySnapshot };
}
function reportInputs(store: Store, actions: ActionRecord[], snapshot: DecisionSnapshot, task: Task, temporary: boolean, at: Date) {
    const project = store.get('projects', snapshot.projectId)!;
    const evidence = currentEvidence(store, actions, snapshot, temporary, at);
    const deliveredFile = task.artifact?.files.find(f => f.path === project.prdPath);
    const receipts = store.list('receipts').filter(r => {
        if (r.taskId !== task.id || !sameScope(r, snapshot) || !before(r.verifiedAt, at) || Date.parse(r.verifiedAt) < Date.parse(snapshot.recordedAt)) return false;
        if (!project.autoMerge || !deliveredFile || r.contentHash !== digest(deliveredFile.content) || r.repository !== project.repository || r.path !== project.prdPath) return false;
        if (!r.mergeSha.trim() || !r.headSha.trim() || !Number.isInteger(r.pullRequestNumber) || r.pullRequestNumber < 1) return false;
        try { if (new URL(r.pullRequestUrl).protocol !== 'https:') return false; } catch { return false; }
        return project.trustedChecks.length > 0 && project.trustedChecks.every(name => r.checks.some(c =>
            c.name === name && c.conclusion === 'success' && c.headSha === r.headSha && project.trustedAppIds.includes(c.appId) && !!c.url));
    });
    const ownerChoices = store.list('cases').filter(c => c.taskId === task.id && sameScope(c, snapshot) && caseMatchesSnapshot(store, c, snapshot) && c.status === 'active' && c.actorId === project.ownerId && before(c.createdAt, at) && Date.parse(c.createdAt) >= Date.parse(snapshot.recordedAt) && store.get('sources', c.sourceId)?.status === 'active').map(c => ({ caseId: c.id, choice: c.choice, createdAt: c.createdAt }));
    const failedTests = before(task.updatedAt, at) ? [...(task.artifact?.tests ?? []), ...(task.review?.tests ?? [])].filter(t => !t.passed && task.plan?.tests.includes(t.command)) : [];
    const taskState = before(task.updatedAt, at) ? task.status : 'deciding';
    const gaps: string[] = [];
    if (!receipts.length)
        gaps.push('No current verified delivery receipt.');
    const metrics = evidence.filter(e => e.metric);
    if (!metrics.length)
        gaps.push('No current quoted measurement.');
    if (metrics.some(e => !e.metric?.sampleSize))
        gaps.push('Measurement sample size is unknown.');
    if (metrics.some(e => e.attribution.method === 'none' || !e.attribution.citations.length))
        gaps.push('Measurement attribution material is missing.');
    if (metrics.length && receipts.length && !metrics.some(e => receipts.some(r => Date.parse(e.metric!.periodStart) >= Date.parse(r.verifiedAt))))
        gaps.push('Measurement predates verified delivery.');
    const linked = metrics.some(e => e.metric!.sampleSize && e.attribution.method !== 'none' && e.attribution.citations.length && receipts.some(r => Date.parse(e.metric!.periodStart) >= Date.parse(r.verifiedAt)));
    if (taskState === 'cancelled' || taskState === 'archived' || taskState === 'blocked')
        gaps.push(`Task execution state: ${taskState}; this is not a measured business failure.`);
    const sourceRefs = [...new Map(evidence.flatMap(e => [{ id: e.sourceId, revision: e.sourceRevision }, ...e.attribution.citations.map(c => ({ id: c.sourceId, revision: c.revision }))]).map(r => [r.id, r])).values()];
    return { evidence, evidenceIds: evidence.map(e => e.id), sourceRefs, receiptIds: receipts.map(r => r.id).sort(), ownerChoices, failedTests, taskState, status: linked ? 'evidence_linked' as const : 'observing' as const, gaps };
}
export function runOutcomeReviews(store: Store, at = new Date(), scope?: Scope): number {
    let count = 0;
    const {actions, bySnapshot} = actionIndex(store);
    for (const action of actions) {
        if (action.kind !== 'decision.snapshot' || scope && !sameScope(action, scope))
            continue;
        try {
            const { snapshot, task, temporary } = subject(store, action.id, at), dates = cadence(snapshot, at);
            if (!dates.due)
                continue;
            const inputs = reportInputs(store, bySnapshot.get(snapshot.id) ?? [], snapshot, task, temporary, at);
            const id = stableId('decision-review', snapshot.id, dates.round, digest(inputs));
            if (store.get('actions', id))
                continue;
            const review: OutcomeReview = { schemaVersion: 1, id, snapshotId: snapshot.id, taskId: task.id, projectId: snapshot.projectId, domain: snapshot.domain, round: dates.round, scheduledAt: dates.scheduledAt, checkedAt: at.toISOString(), nextReviewAt: dates.nextReviewAt, ...inputs };
            store.save('actions', { id, projectId: snapshot.projectId, domain: snapshot.domain, taskId: task.id, kind: 'decision.review', status: 'completed', payload: { review }, updatedAt: review.checkedAt });
            count++;
        }
        catch (error) {
            if (!(error instanceof DomainError))
                throw error;
        }
    }
    return count;
}
export function outcomeReviewViews(store: Store, scope: Scope, at = new Date()): OutcomeReviewView[] {
    const project = store.get('projects', scope.projectId);
    if (!project || !sameScope(project, scope))
        return [];
    const {actions, bySnapshot} = actionIndex(store);
    return actions.flatMap(action => {
        if (action.kind !== 'decision.snapshot' || !sameScope(action, scope))
            return [];
        try {
            const { snapshot, task, temporary } = subject(store, action.id, at), dates = cadence(snapshot, at), inputs = reportInputs(store, bySnapshot.get(snapshot.id) ?? [], snapshot, task, temporary, at);
            const latestReview = (bySnapshot.get(snapshot.id) ?? []).flatMap(a => {
                const r = a.payload.review as OutcomeReview | undefined;
                if (a.kind !== 'decision.review' || a.status !== 'completed' || !r || r.snapshotId !== snapshot.id || a.taskId !== snapshot.taskId || !sameScope(a, snapshot) || !before(r.checkedAt, at))
                    return [];
                // Audit records stay immutable; only a report matching currently permitted inputs is current.
                const { schemaVersion: _v, id: _id, snapshotId: _s, taskId: _t, projectId: _p, domain: _d, round: _r, scheduledAt: _date, checkedAt: _at, nextReviewAt: _next, ...recordedInputs } = r;
                return digest(recordedInputs) === digest(inputs) ? [r] : [];
            }).sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0];
            return [{ projectId: snapshot.projectId, domain: snapshot.domain, snapshotId: snapshot.id, taskId: task.id, snapshot, scheduledAt: dates.scheduledAt, reviewIntervalDays: dates.interval, ...(latestReview ? { latestReview } : {}), evidence: inputs.evidence }];
        }
        catch {
            return [];
        }
    });
}
