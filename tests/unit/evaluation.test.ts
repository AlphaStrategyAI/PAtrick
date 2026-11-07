import { expect, it } from 'vitest';
import { admitReplayTrial, classifyOwnerChoice, monthlyComparisonMessage, type ReplayCase } from '../../src/evaluation.js';

function replay(overrides: Partial<ReplayCase> = {}): ReplayCase {
  return {
    id: 'held-out-fix', projectId: 'demo-studio', heldOut: true, critical: true,
    previouslyWrong: true, oldCorrect: false, candidateCorrect: true,
    unauthorized: false, duplicateExternalAction: false, fakeDelivery: false,
    withdrawalLeak: false, crossDomain: false, changesOwnerValue: false, ...overrides,
  };
}

const budgets = { projectId: 'demo-studio', oldBudget: 1, candidateBudget: 1 };

it('tries a same-budget replay on one product after it fixes a held-out miss without a critical regression', () => {
  const decision = admitReplayTrial({ ...budgets, cases: [replay(), replay({ id: 'critical-kept', previouslyWrong: false, oldCorrect: true, candidateCorrect: true })] });
  expect(decision).toMatchObject({ trial: 'single-product', principle: 'unchanged', suggestionOnly: false, sampleSize: 2, fixedWrong: 1, criticalRegressions: 0, reasons: [] });
});

it('refuses a candidate that fixes the average case but fabricates delivery', () => {
  const decision = admitReplayTrial({ ...budgets, cases: [replay({ fakeDelivery: true })] });
  expect(decision.trial).toBe('none');
  expect(decision.principle).toBe('unchanged');
  expect(decision.reasons).toContain('fake-delivery');
  expect(decision.fakeDeliveries).toBe(1);
});

it('refuses a candidate that repairs one miss and regresses a critical case', () => {
  const decision = admitReplayTrial({ ...budgets, cases: [replay({ id: 'fixed', critical: false }), replay({ id: 'critical', previouslyWrong: false, oldCorrect: true, candidateCorrect: false })] });
  expect(decision.trial).toBe('none');
  expect(decision.reasons).toContain('critical-regression');
});

it('keeps an owner value change as a suggestion instead of starting a trial', () => {
  const decision = admitReplayTrial({ ...budgets, cases: [replay({ changesOwnerValue: true })] });
  expect(decision).toMatchObject({ trial: 'none', principle: 'unchanged', suggestionOnly: true });
  expect(decision.reasons).toContain('owner-value');
});

it('keeps an accepted recommendation separate from a later result', () => {
  expect(classifyOwnerChoice({ choice: 'A', words: '按首选保留。', citedQuotes: ['导出失败后应恢复草稿。'], earlierSourceTexts: ['另一份当时可见的用户原文。'], exceptions: [], hasSnapshot: true })).toEqual({ alignment: 'matched', reason: 'none' });
});

it('classifies a different choice as a missed fact, a preference, or a recorded exception', () => {
  const cited = ['导出失败后应恢复草稿。'];
  expect(classifyOwnerChoice({ choice: 'C', words: '还要看另一份当时可见的用户原文。', citedQuotes: cited, earlierSourceTexts: ['另一份当时可见的用户原文。'], exceptions: ['没有额外例外'], hasSnapshot: true })).toEqual({ alignment: 'different', reason: 'missed_fact' });
  expect(classifyOwnerChoice({ choice: 'B', words: '只保留七天。', citedQuotes: cited, earlierSourceTexts: [], exceptions: [], hasSnapshot: true })).toEqual({ alignment: 'different', reason: 'preference' });
  expect(classifyOwnerChoice({ choice: 'C', words: '敏感草稿需单独确认，其余保留到下次导出。', citedQuotes: cited, earlierSourceTexts: [], exceptions: ['敏感草稿需单独确认'], hasSnapshot: true })).toEqual({ alignment: 'different', reason: 'rule_exception' });
  expect(classifyOwnerChoice({ choice: 'C', words: '我自己决定。', citedQuotes: [], earlierSourceTexts: [], exceptions: [], hasSnapshot: false })).toEqual({ alignment: 'unknown', reason: 'unresolved' });
});

it('does not spend more than the original replay or count another project as the fix', () => {
  expect(admitReplayTrial({ ...budgets, candidateBudget: 2, cases: [replay()] }).reasons).toContain('budget');
  const other = admitReplayTrial({ ...budgets, cases: [replay({ projectId: 'other-product', crossDomain: true })] });
  expect(other.trial).toBe('none');
  expect(other.sampleSize).toBe(0);
  expect(other.reasons).toEqual(expect.arrayContaining(['no-held-out', 'cross-domain']));
});

it('states whether a recorded monthly replay can be tried without changing the principle', () => {
  const base = { month: '2026-11', sampleSize: 1, ownerCorrections: 1, matchedSuggestions: 0, observedResults: 0, candidateId: 'observation', principle: 'unchanged' as const, ownerValue: false };
  expect(monthlyComparisonMessage(null)).toBe('还没有用留出案例做过本月对照。');
  expect(monthlyComparisonMessage({ ...base, candidateAnswers: 0, trial: 'none' })).toContain('还没有回答这些案例');
  expect(monthlyComparisonMessage({ ...base, candidateAnswers: 1, trial: 'single-product' })).toContain('可以在本项目试用');
  expect(monthlyComparisonMessage({ ...base, candidateAnswers: 1, trial: 'none' })).toContain('还不能试用');
  expect(monthlyComparisonMessage({ ...base, candidateAnswers: 1, trial: 'none', ownerValue: true })).toContain('仍要你的真实决定');
});
