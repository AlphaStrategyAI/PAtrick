import { z } from 'zod';
import { DomainError, now, stableId, type Scope } from './domain.js';
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
