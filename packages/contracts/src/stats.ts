import { z } from 'zod';

const count = z.number().int().nonnegative().nullable();
const instant = z.iso.datetime().nullable();
const metricCoverage = z.strictObject({
  status: z.enum(['complete', 'partial', 'unknown']), available_since: instant, through: instant,
});

export const statsSnapshotSchema = z.strictObject({
  metric_definition_version: z.literal('1.0'),
  window_start: instant,
  window_end: instant,
  timezone: z.string().min(1).max(100),
  coverage: metricCoverage.extend({ by_activity: z.strictObject({
    owner_decision: metricCoverage, automatic_decision: metricCoverage, delivered_work: metricCoverage,
  }) }),
  activity: z.strictObject({ owner_decisions: count, automatic_decisions: count, delivered_work: count }),
  stock: z.strictObject({ active_standards: count, knowledge_entries: count, delegation_types: count, active_delegation_types: count }),
  work: z.strictObject({ open: count, awaiting_answer: count, blocked: count }),
});
