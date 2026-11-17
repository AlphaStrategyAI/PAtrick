import { createHash } from 'node:crypto';

const freshnessValues = ['fresh', 'stale', 'syncing', 'unknown'] as const;
const vaultStatuses = ['not_connected', 'checking', 'needs_install', 'needs_permission',
  'awaiting_confirmation', 'connected', 'degraded'] as const;
const feishuStatuses = ['not_configured', 'checking', 'needs_binding', 'needs_test', 'needs_enable',
  'ready', 'degraded', 'draining', 'disabled', 'requires_reauthorization'] as const;

type DiagnosticFacts = {
  freshness: unknown;
  asOf: unknown;
  work: { open: unknown; awaiting_answer: unknown; blocked: unknown } | null;
  vaultStatus: unknown;
  feishuStatus: unknown;
  edits: { pending: unknown; failed: unknown };
};

// The report does not accept logs, raw records, file paths or identifiers. Every output
// field is independently selected and checked rather than copied from a source object.
export function buildDiagnostics(facts: DiagnosticFacts) {
  const freshness = enumValue(facts.freshness, freshnessValues);
  const ready = freshness === 'fresh';
  const open = count(facts.work?.open);
  const awaitingAnswer = count(facts.work?.awaiting_answer);
  const blocked = count(facts.work?.blocked);
  const pending = count(facts.edits.pending);
  const failed = count(facts.edits.failed);
  const report = {
    schema_version: '1.0' as const,
    projection: {
      freshness,
      as_of: timestamp(facts.asOf),
      work: ready && open !== null && awaitingAnswer !== null && blocked !== null
        ? { open, awaiting_answer: awaitingAnswer, blocked } : null,
      connections: {
        vault: ready ? enumValue(facts.vaultStatus, vaultStatuses) : 'unknown' as const,
        feishu: ready ? enumValue(facts.feishuStatus, feishuStatuses) : 'unknown' as const,
      },
      edits: ready && pending !== null && failed !== null ? { pending, failed } : null,
    },
  };
  const bytes = JSON.stringify(report);
  return { report, bytes, manifestHash: diagnosticDigest(bytes) };
}

export type DiagnosticsReport = ReturnType<typeof buildDiagnostics>['report'];

export function diagnosticDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function enumValue<const T extends string>(value: unknown, choices: readonly T[]): T | 'unknown' {
  return choices.find((choice) => choice === value) ?? 'unknown';
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value ? value : null;
}
