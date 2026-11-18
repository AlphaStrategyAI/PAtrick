import { readFileSync } from 'node:fs';

const usage = `Usage: node scripts/summarize-pilot.mjs <reviewed-pilot-facts.json>

Summarize one frozen work scope and standard domain from supplied, reviewed evidence.
Input JSON fields:
  scope: { workScopeId, standardDomainId }
  workFacts: [{ workId, revision, inScope, outcome?, automatic?, effective?, rework?,
                citations?, critical?, interventionSeconds? }]
  caseFacts?: [{ caseId, cohort, verified?, independent? }]
  caseCoverage?: { seed?, holdout? }
  maintenanceWeeks?: [{ weekStart, elapsedSeconds?, faults? }]

Supply every terminal work in the observation population, with its authoritative
per-work integer revision(s), including failures, cancellations, and manual paths.
The latest revision supplies the entire snapshot. inScope is the producer's
membership decision for the named frozen scope and authorization boundary.
outcome is completed, failed, cancelled, manual (human hand-off or completion),
or rejected. automatic is true only for verified completion within authorization.
A known non-completed outcome or observed unauthorized action excludes a work
from the authorized completion numerator. The work remains in the denominator
and any observed unauthorized action fails the critical gate. Absent or null
observations otherwise remain unknown. effective and rework are reviewed booleans.
citations is { accurate, checked } for a complete per-work citation review
(0 of 0 records an observed absence of applicable citations).
critical contains reviewed booleans for unauthorized, missedRequiredQuestion,
and recalledWithdrawnMaterial. A false value records an observed absence.
interventionSeconds counts the person's total intervention for the work.

caseFacts supplies distinct reviewed seed or holdout case identities (cohort).
verified records actual verification and independent records holdout independence.
caseCoverage records complete or partial coverage for each cohort. Omit a cohort
for unknown coverage. Sufficient qualifying cases establish the minimum. Falling
short establishes failure only for a complete, nonempty cohort whose qualifying
and unknown cases together cannot reach the minimum. Empty cohorts remain unknown.
Case denominators count the distinct supplied cases.
maintenanceWeeks supplies Monday YYYY-MM-DD calendar week starts in a consistent
reporting calendar, elapsed wall-clock seconds, and reviewed fault-code counts.
An empty faults object records an observed week without faults. The first
observed over-limit streak that triggers a pause supplies the highest-frequency
faults. Incomplete history can leave an earlier trigger unknown.

Counts and durations use nonnegative safe integers, with revisions starting at 1.
Work rates are null for incomplete observations or an empty population.
Citation rates and intervention totals describe the observed sample only.
The summary evaluates the supplied observations against the frozen policy.
It relies on T25 and the operator to establish completeness, attribution,
and provenance. The JSON report describes the supplied evidence population.`;

const outcomes = ['completed', 'failed', 'cancelled', 'manual', 'rejected'];
const criticalFields = ['unauthorized', 'missedRequiredQuestion', 'recalledWithdrawnMaterial'];
const cohorts = ['seed', 'holdout'];
const dayMilliseconds = 86_400_000;
const weekMilliseconds = 7 * dayMilliseconds;

class EvidenceError extends Error {}

function fail(field, reason) {
  throw new EvidenceError(`${field}: ${reason}`);
}

function record(value, fields, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(field, 'expected an object');
  }
  if (fields && Object.keys(value).some(key => !fields.includes(key))) {
    fail(field, 'unexpected field');
  }
  return value;
}

function list(value, field) {
  if (!Array.isArray(value)) fail(field, 'expected an array');
  return value;
}

function identifier(value, field) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    fail(field, 'expected a nonempty identifier without surrounding whitespace');
  }
  return value;
}

function choice(value, allowed, field) {
  if (!allowed.includes(value)) fail(field, 'unexpected value');
  return value;
}

function observation(value, field) {
  if (value == null) return null;
  if (typeof value !== 'boolean') fail(field, 'expected a boolean or null');
  return value;
}

function count(value, field, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(field, `expected a safe integer of at least ${minimum}`);
  }
  return value;
}

function addCount(total, amount, field) {
  return count(total + amount, field);
}

function normalizeCitations(value, field) {
  if (value == null) return null;
  const row = record(value, ['accurate', 'checked'], field);
  const accurate = count(row.accurate, `${field}.accurate`);
  const checked = count(row.checked, `${field}.checked`);
  if (accurate > checked) fail(field, 'accurate exceeds checked');
  return { accurate, checked };
}

function normalizeCritical(value, field) {
  const row = value == null ? {} : record(value, criticalFields, field);
  return Object.fromEntries(criticalFields.map(key => [key, observation(row[key], `${field}.${key}`)]));
}

function normalizeWork(value, index) {
  const field = `workFacts[${index}]`;
  const row = record(value, ['workId', 'revision', 'inScope', 'outcome', 'automatic', 'effective',
    'rework', 'citations', 'critical', 'interventionSeconds'], field);
  const workId = identifier(row.workId, `${field}.workId`);
  const revision = count(row.revision, `${field}.revision`, 1);
  const inScope = choice(row.inScope, [true, false], `${field}.inScope`);
  const outcome = row.outcome == null ? null : choice(row.outcome, outcomes, `${field}.outcome`);
  const automatic = observation(row.automatic, `${field}.automatic`);
  const nonCompletion = outcome !== null && outcome !== 'completed';
  if (nonCompletion && automatic === true) fail(`${field}.automatic`, 'contradicts outcome');
  return {
    workId, revision, inScope, outcome,
    automatic: nonCompletion ? false : automatic,
    effective: observation(row.effective, `${field}.effective`),
    rework: observation(row.rework, `${field}.rework`),
    citations: normalizeCitations(row.citations, `${field}.citations`),
    critical: normalizeCritical(row.critical, `${field}.critical`),
    interventionSeconds: row.interventionSeconds == null ? null : count(row.interventionSeconds, `${field}.interventionSeconds`),
  };
}

function normalizeCase(value, index) {
  const field = `caseFacts[${index}]`;
  const row = record(value, ['caseId', 'cohort', 'verified', 'independent'], field);
  const cohort = choice(row.cohort, cohorts, `${field}.cohort`);
  return {
    caseId: identifier(row.caseId, `${field}.caseId`),
    cohort,
    verified: observation(row.verified, `${field}.verified`),
    independent: observation(row.independent, `${field}.independent`),
  };
}

function normalizeWeek(value, index) {
  const field = `maintenanceWeeks[${index}]`;
  const row = record(value, ['weekStart', 'elapsedSeconds', 'faults'], field);
  const date = typeof row.weekStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.weekStart)
    ? new Date(`${row.weekStart}T00:00:00.000Z`)
    : null;
  if (date?.getUTCDay() !== 1 || date.toISOString().slice(0, 10) !== row.weekStart) {
    fail(`${field}.weekStart`, 'expected a Monday date in YYYY-MM-DD format');
  }
  const faultCounts = row.faults == null ? null : record(row.faults, null, `${field}.faults`);
  const faults = faultCounts === null ? null : Object.keys(faultCounts).sort().map(code => [
    identifier(code, `${field}.faults code`),
    count(faultCounts[code], `${field}.faults frequency`, 1),
  ]);
  return {
    weekStart: row.weekStart,
    timestamp: date.getTime(),
    elapsedSeconds: row.elapsedSeconds == null ? null : count(row.elapsedSeconds, `${field}.elapsedSeconds`),
    faults,
  };
}

// All records have a fixed normalized shape, so equality ignores JSON property order.
function keepUnique(records, keyOf, label) {
  const unique = new Map();
  for (const row of records) {
    const key = keyOf(row);
    const previous = unique.get(key);
    if (!previous) unique.set(key, row);
    else if (JSON.stringify(row) !== JSON.stringify(previous)) fail(label, 'distinct snapshots share one identity');
  }
  return [...unique.values()];
}

function selectCurrent(facts) {
  const revisions = keepUnique(facts, row => JSON.stringify([row.workId, row.revision]), 'conflicting work facts');
  const current = new Map();
  for (const row of revisions) {
    const previous = current.get(row.workId);
    if (!previous || row.revision > previous.revision) current.set(row.workId, row);
  }
  return {
    inScope: [...current.values()].filter(row => row.inScope),
    duplicateDeliveries: facts.length - revisions.length,
    supersededRevisions: revisions.length - current.size,
    uniqueWorks: current.size,
  };
}

function summarizeBoolean(values) {
  const denominator = values.length;
  const numerator = values.filter(value => value === true).length;
  const unknown = values.filter(value => value === null).length;
  return {
    numerator, denominator, samples: denominator - unknown, unknown,
    rate: denominator > 0 && unknown === 0 ? numerator / denominator : null,
  };
}

function authorizedAutomatic(row) {
  return row.critical.unauthorized === true ? false : row.automatic;
}

export function automaticCompletion(finalFacts) {
  const current = selectCurrent(list(finalFacts, 'workFacts').map(normalizeWork));
  const { numerator, denominator } = summarizeBoolean(current.inScope.map(authorizedAutomatic));
  return { numerator, denominator };
}

function summarizeCitations(works, minimum) {
  const reviews = works.map(row => row.citations).filter(review => review !== null);
  const numerator = reviews.reduce((sum, review) => addCount(sum, review.accurate, 'total accurate citations'), 0);
  const denominator = reviews.reduce((sum, review) => addCount(sum, review.checked, 'total checked citations'), 0);
  const unknownWorks = works.length - reviews.length;
  let status = 'unknown';
  if (denominator > 0 && unknownWorks === 0) {
    status = BigInt(numerator) * 100n >= BigInt(denominator) * BigInt(minimum) ? 'met' : 'not_met';
  }
  return {
    numerator, denominator, workDenominator: works.length, workSamples: reviews.length, unknownWorks,
    observedRate: denominator > 0 ? numerator / denominator : null,
    status,
  };
}

function summarizeCritical(works, maximums) {
  return Object.fromEntries(criticalFields.map(key => {
    const metric = summarizeBoolean(works.map(row => row.critical[key]));
    let status = 'unknown';
    if (metric.numerator > maximums[key]) status = 'not_met';
    else if (metric.samples > 0 && metric.unknown === 0) status = 'met';
    return [key, { ...metric, status }];
  }));
}

function summarizeIntervention(works) {
  const observed = works.map(row => row.interventionSeconds).filter(value => value !== null);
  const total = observed.reduce((sum, seconds) => addCount(sum, seconds, 'total intervention seconds'), 0);
  return {
    denominator: works.length, samples: observed.length, unknown: works.length - observed.length,
    observedTotalSeconds: observed.length > 0 ? total : null,
    observedMeanSeconds: observed.length > 0 ? total / observed.length : null,
  };
}

function qualifiesAsHoldout(row) {
  if (row.verified === false || row.independent === false) return false;
  if (row.verified === null || row.independent === null) return null;
  return true;
}

function summarizeCases(values, minimum, coverage) {
  const { numerator: qualifying, denominator, samples, unknown } = summarizeBoolean(values);
  let status = 'unknown';
  if (qualifying >= minimum) status = 'met';
  else if (coverage === 'complete' && denominator > 0 && qualifying + unknown < minimum) status = 'not_met';
  return { coverage, minimum, qualifying, denominator, samples, unknown, status };
}

function highestFrequencyFaults(weeks) {
  if (weeks.some(week => week.faults === null)) return null;
  const totals = new Map();
  for (const week of weeks) {
    for (const [code, count] of week.faults) {
      totals.set(code, addCount(totals.get(code) ?? 0, count, 'total maintenance fault frequency'));
    }
  }
  const highest = [...totals.values()].reduce((max, count) => Math.max(max, count), 0);
  return [...totals.keys()].sort()
    .filter(code => totals.get(code) === highest)
    .map(code => ({ code, count: highest }));
}

function summarizeMaintenance(weeks, rule) {
  const ordered = [...weeks].sort((a, b) => a.timestamp - b.timestamp);
  const samples = ordered.filter(week => week.elapsedSeconds !== null).length;
  const unknown = ordered.length - samples;
  const span = ordered.length === 0 ? 0 : (ordered.at(-1).timestamp - ordered[0].timestamp) / weekMilliseconds + 1;
  const missingWeeks = span - ordered.length;
  const limitSeconds = rule.maximumWeeklyMinutes * 60;
  let streak = [];
  let firstObservedPause = [];
  for (const week of ordered) {
    const last = streak.at(-1);
    if (last && week.timestamp - last.timestamp !== weekMilliseconds) streak = [];
    if (week.elapsedSeconds !== null && week.elapsedSeconds > limitSeconds) streak.push(week);
    else streak = [];
    if (streak.length === rule.pauseAfterConsecutiveOverLimitWeeks) {
      firstObservedPause = streak;
      break;
    }
  }
  let status = 'unknown';
  if (firstObservedPause.length > 0) status = 'pause_expansion';
  else if (samples >= rule.pauseAfterConsecutiveOverLimitWeeks && unknown === 0 && missingWeeks === 0) {
    status = 'not_triggered';
  }
  return {
    status,
    firstObservedPauseWeek: firstObservedPause.at(-1)?.weekStart ?? null,
    weeks: ordered.length, samples, unknown, missingWeeks,
    highestFrequencyFaults: firstObservedPause.length > 0 ? highestFrequencyFaults(firstObservedPause) : null,
  };
}

function summarizePilot(document, policy) {
  const input = record(document, ['scope', 'workFacts', 'caseFacts', 'caseCoverage', 'maintenanceWeeks'], 'input');
  const scopeFields = record(input.scope, ['workScopeId', 'standardDomainId'], 'scope');
  const scope = {
    workScopeId: identifier(scopeFields.workScopeId, 'scope.workScopeId'),
    standardDomainId: identifier(scopeFields.standardDomainId, 'scope.standardDomainId'),
  };
  const facts = list(input.workFacts, 'workFacts').map(normalizeWork);
  const caseFacts = list(input.caseFacts === undefined ? [] : input.caseFacts, 'caseFacts').map(normalizeCase);
  const coverage = record(input.caseCoverage === undefined ? {} : input.caseCoverage, cohorts, 'caseCoverage');
  const caseCoverage = Object.fromEntries(cohorts.map(cohort => [
    cohort, coverage[cohort] === undefined
      ? 'unknown'
      : choice(coverage[cohort], ['complete', 'partial'], `caseCoverage.${cohort}`),
  ]));
  const weekFacts = list(input.maintenanceWeeks === undefined ? [] : input.maintenanceWeeks, 'maintenanceWeeks').map(normalizeWeek);

  const { inScope, ...counts } = selectCurrent(facts);
  const cases = keepUnique(caseFacts, row => row.caseId, 'conflicting case facts');
  const weeks = keepUnique(weekFacts, row => row.weekStart, 'conflicting maintenance weeks');
  const workOutcomes = Object.fromEntries([...outcomes, 'unknown'].map(outcome => [outcome, 0]));
  for (const row of inScope) workOutcomes[row.outcome ?? 'unknown']++;

  return {
    policyVersion: policy.version,
    scope,
    work: {
      receivedFacts: facts.length, ...counts, inScope: inScope.length,
      outOfScope: counts.uniqueWorks - inScope.length, outcomes: workOutcomes,
    },
    metrics: {
      automaticCompletion: summarizeBoolean(inScope.map(authorizedAutomatic)),
      citationAccuracy: summarizeCitations(inScope, policy.minimumCitationAccuracyPercent),
      effectiveOutcomes: summarizeBoolean(inScope.map(row => row.effective)),
      rework: summarizeBoolean(inScope.map(row => row.rework)),
      criticalFailures: summarizeCritical(inScope, policy.maximumCriticalFailures),
      personalIntervention: summarizeIntervention(inScope),
    },
    cases: {
      seed: summarizeCases(cases.filter(row => row.cohort === 'seed').map(row => row.verified),
        policy.minimumCases.seed, caseCoverage.seed),
      independentHoldout: summarizeCases(cases.filter(row => row.cohort === 'holdout').map(qualifiesAsHoldout),
        policy.minimumCases.independentHoldout, caseCoverage.holdout),
    },
    maintenance: summarizeMaintenance(weeks, policy.maintenance),
  };
}

function readJson(path, label) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    fail(label, 'could not read file');
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(label, 'invalid JSON');
  }
}

function run(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(usage);
    return;
  }
  if (args.length !== 1 || args[0].startsWith('-')) fail('arguments', usage.split('\n')[0]);
  const policy = readJson(new URL('../fixtures/pilot/quality-policy.json', import.meta.url), 'quality policy');
  const document = readJson(args[0], 'input');
  console.log(JSON.stringify(summarizePilot(document, policy), null, 2));
}

if (import.meta.main) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof EvidenceError ? error.message : 'pilot summary failed');
    process.exitCode = 1;
  }
}
