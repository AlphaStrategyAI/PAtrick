import { z } from 'zod';
import { digest, DomainError, now, stableId, type DecisionCase, type Scope } from './domain.js';
import type { Store } from './store.js';

const WEEK_MS = 7 * 86400000;
const eventId = z.string().uuid();

export interface MaintenanceRecord { id: string; minutes: number; note: string; recordedAt: string }

/** Record one real maintenance session. The same event id returns the original record. */
export function recordMaintenance(store: Store, scope: Scope, input: { eventId: string; minutes: number; note?: string; recordedAt?: string }): MaintenanceRecord {
  if (!eventId.safeParse(input.eventId).success) throw new DomainError('Maintenance needs a stable event id.', 'invalid_maintenance');
  if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 1440) throw new DomainError('Record maintenance as whole minutes from 1 to 1440.', 'invalid_maintenance');
  const note = input.note?.trim() ?? '';
  if (note.length > 500) throw new DomainError('Maintenance note is too long.', 'invalid_maintenance');
  const recordedAt = input.recordedAt ?? now();
  if (Number.isNaN(Date.parse(recordedAt))) throw new DomainError('Maintenance time is invalid.', 'invalid_maintenance');
  const id = stableId('maintenance', scope.projectId, scope.domain, input.eventId);
  const existing = store.get('actions', id);
  if (existing) {
    const saved = existing.payload as Partial<MaintenanceRecord>;
    if (existing.kind !== 'maintenance.session' || existing.projectId !== scope.projectId || existing.domain !== scope.domain || saved.minutes !== input.minutes || saved.note !== note || saved.recordedAt !== recordedAt) throw new DomainError('This maintenance event already has different details.', 'maintenance_conflict', 409);
    return { id, minutes: input.minutes, note, recordedAt };
  }
  store.save('actions', { id, projectId: scope.projectId, domain: scope.domain, kind: 'maintenance.session', status: 'completed', payload: { minutes: input.minutes, note, recordedAt }, updatedAt: recordedAt });
  return { id, minutes: input.minutes, note, recordedAt };
}

function sessions(store: Store, scope: Scope): MaintenanceRecord[] {
  return store.list('actions').flatMap(action => {
    if (action.kind !== 'maintenance.session' || action.status !== 'completed' || action.projectId !== scope.projectId || action.domain !== scope.domain) return [];
    const saved = action.payload as Partial<MaintenanceRecord>;
    const minutes = saved.minutes;
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || typeof saved.recordedAt !== 'string' || typeof saved.note !== 'string') return [];
    return [{ id: action.id, minutes, note: saved.note, recordedAt: saved.recordedAt }];
  });
}

/** Sum of recorded sessions in [since, until]. Null means the week was not measured. */
export function recordedMaintenanceMinutes(store: Store, scope: Scope, since: string, until: string): number | null {
  const start = Date.parse(since), end = Date.parse(until);
  const rows = sessions(store, scope).filter(row => {
    const time = Date.parse(row.recordedAt);
    return time >= start && time <= end;
  });
  return rows.length ? rows.reduce((sum, row) => sum + row.minutes, 0) : null;
}

export function slowestRecordedMaintenance(store: Store, scope: Scope, since: string, until: string): { minutes: number; note: string } | null {
  const start = Date.parse(since), end = Date.parse(until);
  const rows = sessions(store, scope).filter(row => {
    const time = Date.parse(row.recordedAt);
    return time >= start && time <= end;
  });
  const slowest = rows.sort((a, b) => b.minutes - a.minutes || a.recordedAt.localeCompare(b.recordedAt))[0];
  return slowest ? { minutes: slowest.minutes, note: slowest.note } : null;
}

/**
 * Pause adding a new source connector after two consecutive measured weeks each exceed 60 minutes.
 * A week with no recorded session stays unknown and does not count as over the limit.
 */
export function sourceExpansionPaused(store: Store, scope: Scope, at = new Date()): boolean {
  const recentStart = at.getTime() - WEEK_MS, previousStart = at.getTime() - 2 * WEEK_MS;
  const recent = recordedMaintenanceMinutes(store, scope, new Date(recentStart).toISOString(), at.toISOString());
  const previousRows = sessions(store, scope).filter(row => {
    const time = Date.parse(row.recordedAt);
    return time >= previousStart && time < recentStart;
  });
  const previous = previousRows.length ? previousRows.reduce((sum, row) => sum + row.minutes, 0) : null;
  return recent !== null && previous !== null && recent > 60 && previous > 60;
}

export interface ReplayCase {
  id: string;
  projectId: string;
  heldOut: boolean;
  critical: boolean;
  previouslyWrong: boolean;
  oldCorrect: boolean;
  candidateCorrect: boolean;
  unauthorized: boolean;
  duplicateExternalAction: boolean;
  fakeDelivery: boolean;
  withdrawalLeak: boolean;
  crossDomain: boolean;
  changesOwnerValue: boolean;
}

export interface TrialDecision {
  trial: 'none' | 'single-product';
  principle: 'unchanged';
  suggestionOnly: boolean;
  reasons: string[];
  sampleSize: number;
  fixedWrong: number;
  criticalRegressions: number;
  unauthorized: number;
  duplicateExternalActions: number;
  fakeDeliveries: number;
  withdrawalLeaks: number;
  crossDomainReturns: number;
}

/** Decide whether a read-only replay may be tried on the evidence's own project. It never replaces a principle. */
export function admitReplayTrial(input: { projectId: string; oldBudget: number; candidateBudget: number; cases: ReplayCase[] }): TrialDecision {
  const scoped = input.cases.filter(item => item.heldOut && item.projectId === input.projectId);
  const counts = {
    unauthorized: input.cases.filter(item => item.unauthorized).length,
    duplicateExternalActions: input.cases.filter(item => item.duplicateExternalAction).length,
    fakeDeliveries: input.cases.filter(item => item.fakeDelivery).length,
    withdrawalLeaks: input.cases.filter(item => item.withdrawalLeak).length,
    crossDomainReturns: input.cases.filter(item => item.crossDomain || item.projectId !== input.projectId && item.candidateCorrect).length,
  };
  const fixedWrong = scoped.filter(item => item.previouslyWrong && !item.oldCorrect && item.candidateCorrect).length;
  const criticalRegressions = scoped.filter(item => item.critical && item.oldCorrect && !item.candidateCorrect).length;
  const suggestionOnly = scoped.some(item => item.changesOwnerValue);
  const reasons: string[] = [];
  if (!Number.isFinite(input.oldBudget) || !Number.isFinite(input.candidateBudget) || input.candidateBudget < 0 || input.candidateBudget > input.oldBudget) reasons.push('budget');
  if (!scoped.length) reasons.push('no-held-out');
  if (scoped.length && !fixedWrong) reasons.push('no-held-out-fix');
  if (criticalRegressions) reasons.push('critical-regression');
  if (counts.unauthorized) reasons.push('unauthorized');
  if (counts.duplicateExternalActions) reasons.push('duplicate-external-action');
  if (counts.fakeDeliveries) reasons.push('fake-delivery');
  if (counts.withdrawalLeaks) reasons.push('withdrawal-leak');
  if (counts.crossDomainReturns) reasons.push('cross-domain');
  if (suggestionOnly) reasons.push('owner-value');
  return {
    trial: reasons.length ? 'none' : 'single-product',
    principle: 'unchanged',
    suggestionOnly,
    reasons,
    sampleSize: scoped.length,
    fixedWrong,
    criticalRegressions,
    ...counts,
  };
}

const genericExceptions = new Set([
  'Reconfirm after source changes or outside this decision.',
  '没有额外例外',
  '[withdrawn]',
]);

export interface ChoiceComparison {
  alignment: 'matched' | 'different' | 'unknown';
  reason: 'none' | 'missed_fact' | 'preference' | 'rule_exception' | 'unresolved';
}

/** Separate a different owner choice from a later business result. A is the preferred suggestion. */
export function classifyOwnerChoice(input: { choice: 'A' | 'B' | 'C'; words: string; citedQuotes: string[]; earlierSourceTexts: string[]; exceptions: string[]; hasSnapshot: boolean }): ChoiceComparison {
  if (!input.hasSnapshot) return { alignment: 'unknown', reason: 'unresolved' };
  if (input.choice === 'A') return { alignment: 'matched', reason: 'none' };
  const specific = input.exceptions.map(item => item.trim()).filter(item => item.length >= 8 && !genericExceptions.has(item));
  if (specific.some(item => input.words.includes(item))) return { alignment: 'different', reason: 'rule_exception' };
  const cited = input.citedQuotes.map(item => item.trim()).filter(Boolean);
  const missed = input.earlierSourceTexts.map(item => item.trim()).filter(item => item.length >= 12 && input.words.includes(item) && !cited.some(quote => quote.includes(item)));
  if (missed.length) return { alignment: 'different', reason: 'missed_fact' };
  if (cited.length) return { alignment: 'different', reason: 'preference' };
  return { alignment: 'different', reason: 'unresolved' };
}

export interface MonthlyComparison {
  month: string; sampleSize: number; ownerCorrections: number; matchedSuggestions: number; observedResults: number;
  candidateId: string | null; candidateAnswers: number; trial: TrialDecision['trial']; principle: 'unchanged'; ownerValue: boolean;
  reverted?: boolean;
}

export interface HeldOutReplay {
  caseId: string; candidateId: string; month: string; candidateCorrect: boolean;
  unauthorized: boolean; duplicateExternalAction: boolean; fakeDelivery: boolean; withdrawalLeak: boolean; crossDomain: boolean; changesOwnerValue: boolean;
}

/** Store one read-only replay. It does not change the principle. */
export function recordHeldOutReplay(store: Store, scope: Scope, input: HeldOutReplay): HeldOutReplay {
  const month = /^\d{4}-\d{2}$/.test(input.month) ? input.month : '';
  const item = store.get('cases', input.caseId);
  const candidate = store.get('rules', input.candidateId);
  const flags = [input.candidateCorrect, input.unauthorized, input.duplicateExternalAction, input.fakeDelivery, input.withdrawalLeak, input.crossDomain, input.changesOwnerValue];
  if (!month || !item || item.projectId !== scope.projectId || item.domain !== scope.domain || item.status !== 'active' || !candidate || candidate.projectId !== scope.projectId || candidate.domain !== scope.domain || candidate.kind !== 'observation' || candidate.status !== 'active' || candidate.caseIds.includes(item.id) || flags.some(flag => typeof flag !== 'boolean')) throw new DomainError('A held-out replay needs this month, an active owner case, and an observation that does not already use that case.', 'invalid_replay');
  const saved: HeldOutReplay = { caseId: item.id, candidateId: candidate.id, month, candidateCorrect: input.candidateCorrect, unauthorized: input.unauthorized, duplicateExternalAction: input.duplicateExternalAction, fakeDelivery: input.fakeDelivery, withdrawalLeak: input.withdrawalLeak, crossDomain: input.crossDomain, changesOwnerValue: input.changesOwnerValue };
  const id = stableId('held-out-replay', scope.projectId, scope.domain, saved.month, saved.candidateId, saved.caseId);
  const existing = store.get('actions', id);
  const previous = existing?.payload.replay;
  if (existing && (existing.kind !== 'decision.replay' || !previous || typeof previous !== 'object' || digest(previous) !== digest(saved))) throw new DomainError('This held-out replay was already recorded with different answers.', 'replay_conflict', 409);
  if (!existing) store.save('actions', { id, projectId: scope.projectId, domain: scope.domain, kind: 'decision.replay', status: 'completed', payload: { replay: saved }, updatedAt: now() });
  return saved;
}

function replayFor(store: Store, scope: Scope, month: string, candidateId: string, caseId: string): HeldOutReplay | undefined {
  const action = store.get('actions', stableId('held-out-replay', scope.projectId, scope.domain, month, candidateId, caseId));
  const replay = action?.kind === 'decision.replay' ? action.payload.replay as HeldOutReplay | undefined : undefined;
  return replay?.caseId === caseId && replay.candidateId === candidateId && replay.month === month ? replay : undefined;
}

const finishedTrialTask = new Set(['delivered', 'completed', 'archived', 'cancelled']);

/** A withdrawn trial returns unfinished work to the standing principle. It does not rewrite that principle. */
function reconcileRevokedTrial(store: Store, scope: Scope, comparison: MonthlyComparison): void {
  const candidateId = comparison.candidateId;
  if (!candidateId) return;
  const id = stableId('trial-reconcile', scope.projectId, scope.domain, comparison.month, candidateId, digest({ ...comparison, reverted: false }));
  if (store.get('actions', id)) return;
  const at = now();
  const taskIds: string[] = [];
  for (const task of store.list('tasks')) {
    if (task.projectId !== scope.projectId || task.domain !== scope.domain || finishedTrialTask.has(task.status) || task.receiptId) continue;
    if (!task.decision?.ruleIds.includes(candidateId)) continue;
    for (const question of store.list('questions')) if (question.taskId === task.id && question.status === 'open') store.save('questions', { ...question, status: 'stale' });
    store.save('tasks', { ...task, version: task.version + 1, status: 'deciding', stage: 'decide', updatedAt: at, runAfter: at, decision: undefined, decisionSnapshotId: undefined, plan: undefined, artifact: undefined, review: undefined, questionId: undefined, error: '试用已收回，未完成的任务按原来的原则重判。' });
    taskIds.push(task.id);
  }
  store.save('actions', { id, projectId: scope.projectId, domain: scope.domain, kind: 'decision.trial-reconcile', status: 'completed', payload: { month: comparison.month, candidateId, taskIds }, updatedAt: at });
}

function recordedReplays(store: Store, scope: Scope, month: string, candidateId: string, heldOut: { id: string; projectId: string; choice: 'A' | 'B' | 'C' }[]): ReplayCase[] {
  return heldOut.flatMap(item => {
    const replay = replayFor(store, scope, month, candidateId, item.id);
    return replay ? [{ id: item.id, projectId: item.projectId, heldOut: true, critical: true, previouslyWrong: item.choice !== 'A', oldCorrect: item.choice === 'A', candidateCorrect: replay.candidateCorrect, unauthorized: replay.unauthorized, duplicateExternalAction: replay.duplicateExternalAction, fakeDelivery: replay.fakeDelivery, withdrawalLeak: replay.withdrawalLeak, crossDomain: replay.crossDomain, changesOwnerValue: replay.changesOwnerValue }] : [];
  });
}

/** Prefer an observation that already solves a held-out miss. A newer observation with no replay does not replace it. */
function selectMonthlyCandidate(store: Store, scope: Scope, cases: DecisionCase[], month: string) {
  const observations = store.list('rules').filter(rule => rule.projectId === scope.projectId && rule.domain === scope.domain && rule.kind === 'observation' && rule.status === 'active').sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const scored = observations.map(candidate => {
    const heldOut = cases.filter(item => !candidate.caseIds.includes(item.id));
    const replayed = recordedReplays(store, scope, month, candidate.id, heldOut);
    const unanswered = heldOut.map(item => ({ id: item.id, projectId: item.projectId, heldOut: true, critical: true, previouslyWrong: item.choice !== 'A', oldCorrect: item.choice === 'A', candidateCorrect: false, unauthorized: false, duplicateExternalAction: false, fakeDelivery: false, withdrawalLeak: false, crossDomain: false, changesOwnerValue: false }));
    return { candidate, heldOut, replayed, decision: admitReplayTrial({ projectId: scope.projectId, oldBudget: 0, candidateBudget: 0, cases: replayed.length ? replayed : unanswered }) };
  });
  return scored.find(item => item.replayed.length > 0 && item.decision.trial === 'single-product') ?? scored.find(item => item.replayed.length > 0) ?? scored[0];
}

/** Compare this month's held-out owner decisions with the current version. Only a recorded replay counts as a candidate answer, and the principle stays. */
export function runMonthlyComparison(store: Store, scope: Scope, at = new Date()): MonthlyComparison | null {
  const cases = store.list('cases').filter(item => item.projectId === scope.projectId && item.domain === scope.domain && item.status === 'active' && item.createdAt <= at.toISOString() && store.get('sources', item.sourceId)?.status === 'active');
  if (!cases.length) return latestMonthlyComparison(store, scope);
  const month = at.toISOString().slice(0, 7);
  const selected = selectMonthlyCandidate(store, scope, cases, month);
  const candidate = selected?.candidate;
  const heldOut = selected?.heldOut ?? cases;
  const replayed = selected?.replayed ?? [];
  const decision = selected?.decision ?? admitReplayTrial({ projectId: scope.projectId, oldBudget: 0, candidateBudget: 0, cases: [] });
  const comparison: MonthlyComparison = { month, sampleSize: heldOut.length, ownerCorrections: heldOut.filter(item => item.choice !== 'A').length, matchedSuggestions: heldOut.filter(item => item.choice === 'A').length, observedResults: heldOut.filter(item => !!(item.outcome || item.outcomes?.length)).length, candidateId: candidate?.id ?? null, candidateAnswers: replayed.length, trial: decision.trial, principle: 'unchanged', ownerValue: replayed.some(item => item.changesOwnerValue) };
  const id = stableId('monthly-comparison', scope.projectId, scope.domain, comparison.month);
  const existing = store.get('actions', id);
  const saved = existing?.kind === 'decision.monthly-comparison' ? existing.payload.comparison as MonthlyComparison | undefined : undefined;
  const reverted = !!(saved?.trial === 'single-product' && saved.candidateId && saved.candidateId === comparison.candidateId && comparison.trial === 'none');
  const next = { ...comparison, reverted };
  if (saved && digest(saved) === digest(next)) return saved;
  if (reverted) reconcileRevokedTrial(store, scope, next);
  store.save('actions', { id, projectId: scope.projectId, domain: scope.domain, kind: 'decision.monthly-comparison', status: 'completed', payload: { comparison: next }, updatedAt: at.toISOString() });
  return next;
}

/** Say what the stored comparison actually decided. A trial still does not change the principle. */
export function monthlyComparisonMessage(monthly: MonthlyComparison | null): string {
  if (!monthly) return '还没有用留出案例做过本月对照。';
  const base = `留出 ${monthly.sampleSize} 个案例，本人纠正 ${monthly.ownerCorrections} 次。`;
  if (monthly.candidateAnswers === 0) return `${base}候选版本还没有回答这些案例，原则保持不变。`;
  const reconciled = monthly.reverted ? '先前的试用已经收回，仍用原来的原则。' : '';
  if (monthly.ownerValue) return `${base}候选碰到价值取舍，仍要你的真实决定，因此还不能试用。原则保持不变。${reconciled}`;
  if (monthly.trial === 'single-product') return `${base}候选已回答 ${monthly.candidateAnswers} 个留出案例，可以在本项目试用。原则保持不变。`;
  return `${base}候选已回答 ${monthly.candidateAnswers} 个留出案例，但还不能试用。原则保持不变。${reconciled}`;
}

export function latestMonthlyComparison(store: Store, scope: Scope): MonthlyComparison | null {
  const saved = store.list('actions').filter(action => action.kind === 'decision.monthly-comparison' && action.projectId === scope.projectId && action.domain === scope.domain).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.payload.comparison as MonthlyComparison | undefined;
  return saved ?? null;
}
