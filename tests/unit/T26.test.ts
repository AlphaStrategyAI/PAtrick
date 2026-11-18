import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = new URL('../../scripts/summarize-pilot.mjs', import.meta.url);
const scope = { workScopeId: 'pilot-work-scope', standardDomainId: 'pilot-standard-domain' };
const critical = {
  unauthorized: false,
  missedRequiredQuestion: false,
  recalledWithdrawnMaterial: false,
};

function input(workFacts: object[] = [], evidence: object = {}) {
  return { scope, workFacts, ...evidence };
}

function work(workId: string, fields: object = {}) {
  return { workId, revision: 1, inScope: true, ...fields };
}

function run(document: object | string) {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t26-'));
  try {
    const path = join(dir, 'evidence.json');
    writeFileSync(path, typeof document === 'string' ? document : JSON.stringify(document));
    return spawnSync(process.execPath, [fileURLToPath(script), path], { encoding: 'utf8', cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function output(document: object) {
  const result = run(document);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  return result.stdout;
}

describe('T26 offline pilot summary', () => {
  it('freezes only plan quality and maintenance limits', () => {
    const path = new URL('../../fixtures/pilot/quality-policy.json', import.meta.url);
    expect(() => readFileSync(path, 'utf8')).not.toThrow();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      minimumCitationAccuracyPercent: 95,
      minimumCases: { seed: 10, independentHoldout: 5 },
      maximumCriticalFailures: {
        unauthorized: 0,
        missedRequiredQuestion: 0,
        recalledWithdrawnMaterial: 0,
      },
      maintenance: { maximumWeeklyMinutes: 60, pauseAfterConsecutiveOverLimitWeeks: 2 },
    });
  });

  it('counts the plan’s duplicate-delivery and superseded-revision example once per work', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { automaticCompletion } from ${JSON.stringify(script.href)};
      const row = { workId: '1', revision: 2, inScope: true, automatic: true };
      const sample = [
        row, { ...row }, { ...row, revision: 1, automatic: false },
        { ...row, workId: '2', revision: 1, automatic: false },
        { ...row, workId: '3', revision: 1, automatic: false },
      ];
      assert.deepEqual(automaticCompletion(sample), { numerator: 1, denominator: 3 });
      const unauthorized = { ...row, outcome: 'completed', critical: { unauthorized: true } };
      assert.deepEqual(automaticCompletion([unauthorized]), { numerator: 0, denominator: 1 });
    `], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('uses the latest scope membership and keeps failures, cancellations, hand-offs, and rejections in scope', () => {
    const complete = work('1', { revision: 2, outcome: 'completed', automatic: true });
    const workFacts = [
      work('1', { inScope: false, outcome: 'failed' }),
      complete,
      { ...complete },
      work('2', { outcome: 'failed' }),
      work('3', { outcome: 'cancelled' }),
      work('4', { outcome: 'manual' }),
      work('5', { outcome: 'rejected' }),
      work('6', { outcome: 'completed' }),
      work('7', { outcome: 'completed', automatic: true }),
      work('7', { revision: 2, inScope: false, outcome: 'completed', automatic: true }),
    ];
    const first = output(input(workFacts));
    expect(output(input([...workFacts].reverse()))).toBe(first);
    expect(JSON.parse(first)).toMatchObject({
      scope,
      work: {
        receivedFacts: 10, duplicateDeliveries: 1, supersededRevisions: 2,
        uniqueWorks: 7, inScope: 6, outOfScope: 1,
        outcomes: { completed: 2, failed: 1, cancelled: 1, manual: 1, rejected: 1, unknown: 0 },
      },
      metrics: {
        automaticCompletion: { numerator: 1, denominator: 6, samples: 5, unknown: 1, rate: null },
      },
    });
  });

  it('reports per-work unknowns, citation sample coverage, and observed intervention seconds', () => {
    const report = JSON.parse(output(input([
      work('1', {
        outcome: 'completed', automatic: true, effective: true, rework: false,
        citations: { accurate: 19, checked: 20 }, critical, interventionSeconds: 0,
      }),
      work('2', {
        outcome: 'failed', effective: false, rework: true,
        citations: { accurate: 0, checked: 0 }, interventionSeconds: 120,
        critical: { ...critical, unauthorized: true },
      }),
      work('3', { outcome: 'cancelled', effective: null }),
      work('4', { inScope: false, effective: true, citations: { accurate: 1, checked: 1 } }),
    ])));
    expect(report.metrics).toMatchObject({
      citationAccuracy: {
        numerator: 19, denominator: 20, workDenominator: 3, workSamples: 2, unknownWorks: 1,
        observedRate: 0.95, status: 'unknown',
      },
      effectiveOutcomes: { numerator: 1, denominator: 3, samples: 2, unknown: 1, rate: null },
      rework: { numerator: 1, denominator: 3, samples: 2, unknown: 1, rate: null },
      criticalFailures: {
        unauthorized: { numerator: 1, denominator: 3, samples: 2, unknown: 1, status: 'not_met' },
        missedRequiredQuestion: { numerator: 0, denominator: 3, samples: 2, unknown: 1, status: 'unknown' },
        recalledWithdrawnMaterial: { numerator: 0, denominator: 3, samples: 2, unknown: 1, status: 'unknown' },
      },
      personalIntervention: {
        denominator: 3, samples: 2, unknown: 1, observedTotalSeconds: 120, observedMeanSeconds: 60,
      },
    });
  });

  it('keeps an unauthorized automated work in scope and preserves the measured hard stop', () => {
    const result = JSON.parse(output(input([
      work('1', { outcome: 'completed', automatic: true, critical: { unauthorized: true } }),
    ])));
    expect(result.metrics.automaticCompletion).toMatchObject({
      numerator: 0, denominator: 1, samples: 1, unknown: 0, rate: 0,
    });
    expect(result.metrics.criticalFailures.unauthorized).toMatchObject({
      numerator: 1, denominator: 1, samples: 1, unknown: 0, status: 'not_met',
    });
  });

  it('evaluates the citation and critical gates at the frozen boundaries with full coverage', () => {
    const full = work('1', {
      outcome: 'completed', automatic: true, effective: true, rework: false,
      citations: { accurate: 19, checked: 20 }, critical, interventionSeconds: 0,
    });
    const atTarget = JSON.parse(output(input([full])));
    expect(atTarget.metrics.citationAccuracy).toMatchObject({ observedRate: 0.95, status: 'met' });
    expect(atTarget.metrics.automaticCompletion).toMatchObject({ rate: 1, samples: 1, unknown: 0 });
    expect(atTarget.metrics.rework).toMatchObject({ rate: 0, samples: 1, unknown: 0 });
    expect(atTarget.metrics.criticalFailures.recalledWithdrawnMaterial.status).toBe('met');
    const below = JSON.parse(output(input([
      { ...full, citations: { accurate: 94, checked: 100 }, critical: { ...critical, missedRequiredQuestion: true } },
    ])));
    expect(below.metrics.citationAccuracy.status).toBe('not_met');
    expect(below.metrics.criticalFailures.missedRequiredQuestion.status).toBe('not_met');
    const zero = JSON.parse(output(input([{ ...full, citations: { accurate: 0, checked: 0 } }])));
    expect(zero.metrics.citationAccuracy).toMatchObject({ denominator: 0, observedRate: null, status: 'unknown' });
  });

  it('gives no quality or maintenance pass for missing evidence', () => {
    const report = JSON.parse(output(input()));
    expect(report.metrics.automaticCompletion).toEqual({
      numerator: 0, denominator: 0, samples: 0, unknown: 0, rate: null,
    });
    expect(report.metrics.citationAccuracy).toMatchObject({ observedRate: null, status: 'unknown' });
    expect(report.metrics.criticalFailures.unauthorized.status).toBe('unknown');
    expect(report.metrics.personalIntervention).toMatchObject({
      observedTotalSeconds: null, observedMeanSeconds: null,
    });
    expect(report.cases.seed.status).toBe('unknown');
    expect(report.cases.independentHoldout.status).toBe('unknown');
    expect(report.maintenance).toMatchObject({ status: 'unknown', firstObservedPauseWeek: null, highestFrequencyFaults: null });
  });

  it('counts verified distinct seeds and independently verified holdouts with unknown eligibility visible', () => {
    const seeds = Array.from({ length: 10 }, (_, i) => ({ caseId: `seed-${i}`, cohort: 'seed', verified: true }));
    const holdouts = Array.from({ length: 5 }, (_, i) => ({
      caseId: `holdout-${i}`, cohort: 'holdout', verified: true, independent: i === 4 ? null : true,
    }));
    const sharedMaterial = { caseId: 'shared', cohort: 'holdout', verified: true, independent: false };
    const caseFacts = [...seeds, { ...seeds[0] }, ...holdouts, sharedMaterial];
    const caseCoverage = { seed: 'complete', holdout: 'complete' };
    const first = JSON.parse(output(input([], { caseFacts, caseCoverage })));
    expect(first.cases).toEqual({
      seed: { coverage: 'complete', minimum: 10, qualifying: 10, denominator: 10, samples: 10, unknown: 0, status: 'met' },
      independentHoldout: {
        coverage: 'complete', minimum: 5, qualifying: 4, denominator: 6, samples: 5, unknown: 1, status: 'unknown',
      },
    });
    holdouts[4].independent = false;
    expect(JSON.parse(output(input([], { caseFacts, caseCoverage }))).cases.independentHoldout.status).toBe('not_met');
    holdouts[4].independent = true;
    expect(JSON.parse(output(input([], { caseFacts }))).cases.independentHoldout.status).toBe('met');
    expect(run(input([], { caseFacts: [...caseFacts, { ...sharedMaterial, caseId: 'seed-0' }] })).stderr)
      .toContain('conflicting case facts');
  });

  it('uses both case cohort bounds only when the supplied nonempty cohort is complete', () => {
    const seeds = Array.from({ length: 9 }, (_, i) => ({
      caseId: `seed-${i}`, cohort: 'seed', verified: i === 8 ? null : true,
    }));
    const holdouts = Array.from({ length: 4 }, (_, i) => ({
      caseId: `holdout-${i}`, cohort: 'holdout', verified: true, independent: i === 3 ? null : true,
    }));
    const caseFacts = [...seeds, ...holdouts];
    const completeCoverage = { seed: 'complete', holdout: 'complete' };
    const impossible = JSON.parse(output(input([], { caseFacts, caseCoverage: completeCoverage }))).cases;
    expect(impossible.seed).toMatchObject({
      coverage: 'complete', denominator: 9, qualifying: 8, samples: 8, unknown: 1, status: 'not_met',
    });
    expect(impossible.independentHoldout).toMatchObject({
      coverage: 'complete', denominator: 4, qualifying: 3, samples: 3, unknown: 1, status: 'not_met',
    });
    const possible = JSON.parse(output(input([], {
      caseFacts: [...caseFacts, { ...seeds[8], caseId: 'seed-9' }, { ...holdouts[3], caseId: 'holdout-4' }],
      caseCoverage: completeCoverage,
    }))).cases;
    expect(possible.seed).toMatchObject({ denominator: 10, unknown: 2, status: 'unknown' });
    expect(possible.independentHoldout).toMatchObject({ denominator: 5, unknown: 2, status: 'unknown' });

    const partial = JSON.parse(output(input([], { caseFacts, caseCoverage: { seed: 'partial' } }))).cases;
    expect(partial.seed).toMatchObject({ coverage: 'partial', denominator: 9, unknown: 1, status: 'unknown' });
    expect(partial.independentHoldout).toMatchObject({ coverage: 'unknown', denominator: 4, unknown: 1, status: 'unknown' });
  });

  it('only pauses for adjacent over-limit weeks and keeps the recorded trigger after later weeks', () => {
    const week = (weekStart: string, elapsedSeconds: number | null, faults?: object) => (
      { weekStart, elapsedSeconds, ...(faults === undefined ? {} : { faults }) }
    );
    const first = week('2026-10-26', 3601, { recovery: 2, deployment: 1, intake: 2 });
    const second = week('2026-11-02', 3610, { recovery: 1, intake: 1 });
    const later = week('2026-11-09', 3600, {});
    const result = output(input([], { maintenanceWeeks: [later, second, first, { ...first }] }));
    expect(output(input([], { maintenanceWeeks: [first, second, later] }))).toBe(result);
    expect(JSON.parse(result).maintenance).toEqual({
      status: 'pause_expansion', firstObservedPauseWeek: '2026-11-02', weeks: 3, samples: 3, unknown: 0, missingWeeks: 0,
      highestFrequencyFaults: [{ code: 'intake', count: 3 }, { code: 'recovery', count: 3 }],
    });
    const gap = JSON.parse(output(input([], {
      maintenanceWeeks: [first, { ...later, elapsedSeconds: 3601 }],
    }))).maintenance;
    expect(gap).toMatchObject({ status: 'unknown', missingWeeks: 1, firstObservedPauseWeek: null });
    const unknown = JSON.parse(output(input([], { maintenanceWeeks: [first, week('2026-11-02', null)] })));
    expect(unknown.maintenance).toMatchObject({ status: 'unknown', samples: 1, unknown: 1 });
    const exact = JSON.parse(output(input([], { maintenanceWeeks: [second, later] })));
    expect(exact.maintenance.status).toBe('not_triggered');
    const missingFaults = JSON.parse(output(input([], {
      maintenanceWeeks: [first, week('2026-11-02', 3610)],
    })));
    expect(missingFaults.maintenance).toMatchObject({ status: 'pause_expansion', highestFrequencyFaults: null });
  });

  it('labels a proven pause after incomplete history as the first observed trigger', () => {
    const { maintenance } = JSON.parse(output(input([], {
      maintenanceWeeks: [
        { weekStart: '2026-03-02', elapsedSeconds: null },
        { weekStart: '2026-03-09', elapsedSeconds: 3601, faults: { previous: 9 } },
        { weekStart: '2026-03-16', elapsedSeconds: 3600, faults: {} },
        { weekStart: '2026-03-23', elapsedSeconds: 3601, faults: { observed: 1 } },
        { weekStart: '2026-03-30', elapsedSeconds: 3601, faults: { observed: 2 } },
      ],
    })));
    expect(maintenance).toMatchObject({
      status: 'pause_expansion', firstObservedPauseWeek: '2026-03-30', unknown: 1,
      highestFrequencyFaults: [{ code: 'observed', count: 3 }],
    });
    expect(maintenance).not.toHaveProperty('firstPauseWeek');
  });

  it.each([
    [work('bad', { revision: 0 }), 'revision'],
    [work('bad', { revision: '2' }), 'revision'],
    [work('bad', { inScope: 'false' }), 'inScope'],
    [work('bad', { inScope: false, outcome: 'running' }), 'outcome'],
    [work('bad', { inScope: false, automatic: 'yes' }), 'automatic'],
    [work('bad', { outcome: 'failed', automatic: true }), 'automatic'],
    [work('bad', { citations: { accurate: 2, checked: 1 } }), 'citations'],
    [work('bad', { interventionSeconds: -1 }), 'interventionSeconds'],
    [work('bad', { critical: { unauthorized: 0 } }), 'critical.unauthorized'],
    [work('bad', { efective: false }), 'unexpected field'],
  ])('rejects a malformed fact even when superseded by a valid revision: %j', (bad, field) => {
    const result = run(input([bad, work('bad', { revision: 3 })]));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(field);
  });

  it('rejects conflicting equal-revision deliveries in either order, including superseded facts', () => {
    const rows = [
      work('id', { outcome: 'completed', automatic: true }),
      work('id', { outcome: 'completed', automatic: false }),
      work('id', { revision: 2, inScope: false }),
    ];
    const a = run(input(rows));
    const b = run(input([...rows].reverse()));
    expect(a.status).toBe(1);
    expect(a.stdout).toBe('');
    expect(a.stderr).toContain('conflicting work facts');
    expect(b.status).toBe(1);
    expect(b.stderr).toBe(a.stderr);
  });

  it('rejects malformed cohorts, non-Monday weeks, and invalid JSON without echoing supplied values', () => {
    const unsupported = run(input([], { caseFacts: [{ caseId: 'private-payload', cohort: 'training' }] }));
    expect(unsupported.status).toBe(1);
    expect(unsupported.stderr).toContain('cohort');
    expect(unsupported.stderr).not.toContain('private-payload');
    const coverage = run(input([], { caseCoverage: { holdout: true } }));
    expect(coverage.status).toBe(1);
    expect(coverage.stderr).toContain('caseCoverage.holdout');
    const week = run(input([], { maintenanceWeeks: [{ weekStart: '2026-11-08', elapsedSeconds: 100 }] }));
    expect(week.status).toBe(1);
    expect(week.stderr).toContain('weekStart');
    const invalid = run('{"private-payload":');
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('invalid JSON');
    expect(invalid.stderr).not.toContain('private-payload');
  });
});
