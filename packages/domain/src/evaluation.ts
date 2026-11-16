import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type StandardRule = {
  when: string[];
  unless: string[];
  choice: string;
};

export type FrozenCase = {
  case_id: string;
  role: 'training' | 'holdout';
  situation: string;
  visible_evidence: string[];
  options: string[];
  expected_choice: string;
  case_version: number;
};

export type TrainingScore = {
  correct: number;
  total: number;
  leak: boolean;
};

export type Decision = 'pass' | 'fail' | 'insufficient' | 'leak';

export type ProductCase = {
  case_id: string;
  role: 'training' | 'holdout';
  situation: string;
  visible_evidence: string[];
  options: string[];
  expected_choice: string;
};

export type ProductFixture = {
  dataset_id: string;
  policy_id: string;
  policy_version: number;
  min_samples: number;
  threshold_thousandths: number;
  budget_micros: number;
  external_method: {
    id: string;
    revision: string;
    rules: StandardRule[];
  };
  candidate_rules: StandardRule[];
  cases: ProductCase[];
};

const FIXTURE_PATH = fileURLToPath(new URL('../../../fixtures/evaluation/product/manifest.json', import.meta.url));

export function readProductFixture(): ProductFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as ProductFixture;
}

export function parseRules(body: string): StandardRule[] {
  const match = /```json\s*([\s\S]*?)```/.exec(body);
  if (!match?.[1]) throw new Error('UNPROCESSABLE');
  const parsed: unknown = JSON.parse(match[1]);
  if (!parsed || typeof parsed !== 'object' || !('rules' in parsed) || !Array.isArray(parsed.rules)) {
    throw new Error('UNPROCESSABLE');
  }
  return parsed.rules.map((rule) => {
    if (!isRule(rule)) throw new Error('UNPROCESSABLE');
    return { when: [...rule.when], unless: [...rule.unless], choice: rule.choice };
  });
}

export function choose(rules: readonly StandardRule[], evidence: readonly string[]): string {
  const tokens = new Set(evidence);
  for (const rule of rules) {
    if (rule.unless.some((token) => tokens.has(token))) continue;
    if (rule.when.every((token) => tokens.has(token))) return rule.choice;
  }
  return 'abstain';
}

export function scoreTrainingOnly(
  rules: readonly StandardRule[],
  cases: readonly FrozenCase[],
  holdoutIds: readonly string[],
): TrainingScore {
  const blocked = new Set(holdoutIds);
  if (cases.some((item) => item.role !== 'training' || blocked.has(item.case_id))) {
    return { correct: 0, total: cases.length, leak: true };
  }
  let correct = 0;
  for (const item of cases) {
    if (choose(rules, item.visible_evidence) === item.expected_choice) correct += 1;
  }
  return { correct, total: cases.length, leak: false };
}

export function compareCases(rules: readonly StandardRule[], cases: readonly FrozenCase[]): { correct: number; total: number } {
  let correct = 0;
  for (const item of cases) {
    if (choose(rules, item.visible_evidence) === item.expected_choice) correct += 1;
  }
  return { correct, total: cases.length };
}

export function decideTraining(
  score: TrainingScore,
  policy: { min_samples: number; threshold_thousandths: number },
): Decision {
  if (score.leak) return 'leak';
  if (score.total < policy.min_samples) return 'insufficient';
  if (score.correct * 1000 < policy.threshold_thousandths * score.total) return 'fail';
  return 'pass';
}

export function evaluateFrozen(input: {
  rules: readonly StandardRule[];
  training: readonly FrozenCase[];
  holdout: readonly FrozenCase[];
  holdoutIds: readonly string[];
  baselineRules: readonly StandardRule[] | null;
  externalRules: readonly StandardRule[];
  minSamples: number;
  thresholdThousandths: number;
}): {
  decision: Decision;
  training: TrainingScore;
  holdout: { correct: number; total: number };
  baselineCorrect: number | null;
  externalCorrect: number;
} {
  const training = scoreTrainingOnly(input.rules, input.training, input.holdoutIds);
  const decision = decideTraining(training, {
    min_samples: input.minSamples,
    threshold_thousandths: input.thresholdThousandths,
  });
  const holdout = compareCases(input.rules, input.holdout);
  const baselineCorrect = input.baselineRules ? compareCases(input.baselineRules, input.training).correct : null;
  const externalCorrect = compareCases(input.externalRules, input.training).correct;
  return { decision, training, holdout, baselineCorrect, externalCorrect };
}

function isRule(value: unknown): value is StandardRule {
  if (!value || typeof value !== 'object') return false;
  const rule = value as { when?: unknown; unless?: unknown; choice?: unknown };
  return Array.isArray(rule.when)
    && rule.when.every((token) => typeof token === 'string')
    && Array.isArray(rule.unless)
    && rule.unless.every((token) => typeof token === 'string')
    && typeof rule.choice === 'string'
    && rule.choice.length > 0;
}
