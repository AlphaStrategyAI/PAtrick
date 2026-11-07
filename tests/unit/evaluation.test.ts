import { expect, it } from 'vitest';
import { admitReplayTrial, type ReplayCase } from '../../src/evaluation.js';

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

it('does not spend more than the original replay or count another product as the fix', () => {
  expect(admitReplayTrial({ ...budgets, candidateBudget: 2, cases: [replay()] }).reasons).toContain('budget');
  const other = admitReplayTrial({ ...budgets, cases: [replay({ projectId: 'other-product', crossDomain: true })] });
  expect(other.trial).toBe('none');
  expect(other.sampleSize).toBe(0);
  expect(other.reasons).toEqual(expect.arrayContaining(['no-held-out', 'cross-domain']));
});
