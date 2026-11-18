import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export type PilotTrace = {
  route: 'direct-pr' | 'answered-pr' | 'stale-blocked';
  workId: string;
  generation: number;
  sourceRevision: string;
  standardRevision: string;
  evidenceEpoch: number;
  caseId: string | null;
  grantId: string | null;
  answerReceiptId: string | null;
  pr: { effectId: string; headSha: string; treeSha: string } | null;
  observedWorkIds: string[];
  verifiedPrCount: number;
  unauthorizedEffects: number;
  evidenceRefs: string[];
};

type Subject = Pick<PilotTrace, 'workId' | 'generation' | 'sourceRevision' | 'standardRevision' | 'evidenceEpoch'>;
export type PilotEvidence = {
  version: '1.0';
  kind: 'source' | 'standard' | 'audit' | 'grant' | 'answer' | 'pr' | 'case' | 'blocker';
  subject: Subject;
  value: Record<string, unknown>;
};

const routes = ['direct-pr', 'answered-pr', 'stale-blocked'] as const;
const kinds = ['source', 'standard', 'audit', 'grant', 'answer', 'pr', 'case', 'blocker'] as const;
const maxEvidenceBytes = 1024 * 1024;
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/;
const hashPattern = /^[0-9a-f]{40}$/;
const refPattern = /^([a-zA-Z0-9][a-zA-Z0-9._/-]{0,239}\.json)#sha256=([0-9a-f]{64})$/;

function validName(value: unknown): value is string {
  return typeof value === 'string' && namePattern.test(value);
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function exactRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()));
}

function traceError(): never { throw new Error('PILOT_TRACE_INVALID'); }
function evidenceError(): never { throw new Error('PILOT_EVIDENCE_INVALID'); }

function validateTraces(traces: readonly PilotTrace[]) {
  if (!Array.isArray(traces) || traces.length !== routes.length) traceError();
  const workIds = new Set<string>();
  const sourceRevisions = new Set<string>();
  const grants = new Set<string>();
  const answers = new Set<string>();
  const effects = new Set<string>();
  for (const [index, trace] of traces.entries()) {
    if (!exactRecord(trace, ['route', 'workId', 'generation', 'sourceRevision', 'standardRevision', 'evidenceEpoch',
      'caseId', 'grantId', 'answerReceiptId', 'pr', 'observedWorkIds', 'verifiedPrCount', 'unauthorizedEffects', 'evidenceRefs'])
      || trace.route !== routes[index] || !validName(trace.workId) || !validName(trace.sourceRevision) || !validName(trace.standardRevision)
      || !count(trace.generation) || trace.generation === 0 || !count(trace.evidenceEpoch)
      || ![trace.caseId, trace.grantId, trace.answerReceiptId].every(value => value === null || validName(value))
      || !Array.isArray(trace.observedWorkIds) || !trace.observedWorkIds.every(validName)
      || new Set(trace.observedWorkIds).size !== trace.observedWorkIds.length
      || !count(trace.verifiedPrCount) || !count(trace.unauthorizedEffects) || trace.unauthorizedEffects !== 0
      || !Array.isArray(trace.evidenceRefs) || trace.evidenceRefs.length < 1 || trace.evidenceRefs.length > kinds.length
      || !trace.evidenceRefs.every(value => typeof value === 'string')) traceError();
    if (workIds.has(trace.workId) || sourceRevisions.has(trace.sourceRevision)) traceError();
    workIds.add(trace.workId);
    sourceRevisions.add(trace.sourceRevision);
    if (typeof trace.grantId === 'string') {
      if (grants.has(trace.grantId)) traceError();
      grants.add(trace.grantId);
    }
    if (typeof trace.answerReceiptId === 'string') {
      if (answers.has(trace.answerReceiptId)) traceError();
      answers.add(trace.answerReceiptId);
    }
    if (index < 2) {
      if (!trace.caseId || !trace.grantId || trace.verifiedPrCount !== 1 || !exactRecord(trace.pr, ['effectId', 'headSha', 'treeSha'])
        || !validName(trace.pr.effectId) || typeof trace.pr.headSha !== 'string' || !hashPattern.test(trace.pr.headSha)
        || typeof trace.pr.treeSha !== 'string' || !hashPattern.test(trace.pr.treeSha)) traceError();
      if (effects.has(trace.pr.effectId)) traceError();
      effects.add(trace.pr.effectId);
    } else if (trace.pr !== null || trace.verifiedPrCount !== 0) traceError();
    if (trace.route === 'direct-pr' && trace.answerReceiptId !== null) traceError();
    if (trace.route === 'answered-pr' && (!trace.answerReceiptId || !isDeepStrictEqual(trace.observedWorkIds, [trace.workId]))) traceError();
  }
}

function readEvidence(root: string, reference: string): unknown {
  const match = refPattern.exec(reference);
  if (!match || match[1].split('/').some(part => !part || part.startsWith('.'))) evidenceError();
  const parts = match[1].split('/');
  let path = root;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) evidenceError();
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxEvidenceBytes) evidenceError();
    const bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, size);
      if (!read) break;
      size += read;
    }
    const after = fstatSync(fd);
    const named = lstatSync(path);
    if (size !== before.size || !named.isFile() || named.dev !== before.dev || named.ino !== before.ino
      || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || named.size !== before.size || after.mtimeMs !== before.mtimeMs || named.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || named.ctimeMs !== before.ctimeMs
      || createHash('sha256').update(bytes.subarray(0, size)).digest('hex') !== match[2]) evidenceError();
    return JSON.parse(bytes.subarray(0, size).toString('utf8'));
  } finally { closeSync(fd); }
}

function validateEvidence(trace: PilotTrace, root: string, references: Set<string>, effects: Set<string>) {
  const subject = { workId: trace.workId, generation: trace.generation, sourceRevision: trace.sourceRevision,
    standardRevision: trace.standardRevision, evidenceEpoch: trace.evidenceEpoch };
  const expected: Record<string, unknown> = {
    source: { sourceRevision: trace.sourceRevision },
    standard: { standardRevision: trace.standardRevision, evidenceEpoch: trace.evidenceEpoch },
    audit: { observedWorkIds: trace.observedWorkIds, verifiedPrCount: trace.verifiedPrCount, unauthorizedEffects: trace.unauthorizedEffects },
  };
  if (trace.grantId) expected.grant = { grantId: trace.grantId };
  if (trace.answerReceiptId) expected.answer = { answerReceiptId: trace.answerReceiptId, validity: 'verified' };
  if (trace.pr) expected.pr = { ...trace.pr, status: 'verified' };
  if (trace.caseId) expected.case = { caseId: trace.caseId };
  const seen = new Set<string>();
  let blockedByAnswer = false;
  let blockedByEffect = false;
  for (const reference of trace.evidenceRefs) {
    if (references.has(reference)) evidenceError();
    references.add(reference);
    const record = readEvidence(root, reference);
    if (!exactRecord(record, ['version', 'kind', 'subject', 'value']) || record.version !== '1.0'
      || typeof record.kind !== 'string' || seen.has(record.kind) || !isDeepStrictEqual(record.subject, subject)) evidenceError();
    if (record.kind === 'blocker') {
      if (trace.route !== 'stale-blocked' || !trace.grantId || !exactRecord(record.value, ['effectId', 'grantId', 'status', 'reason'])
        || !validName(record.value.effectId) || record.value.grantId !== trace.grantId || record.value.status !== 'conflict'
        || !validName(record.value.reason) || effects.has(record.value.effectId)) evidenceError();
      effects.add(record.value.effectId);
      blockedByEffect = true;
      seen.add(record.kind);
      continue;
    }
    if (!Object.hasOwn(expected, record.kind)) evidenceError();
    let answerStatus = false;
    if (record.kind === 'answer' && trace.route === 'stale-blocked' && exactRecord(record.value, ['answerReceiptId', 'validity'])) {
      const validity = record.value.validity;
      answerStatus = record.value.answerReceiptId === trace.answerReceiptId
        && typeof validity === 'string'
        && ['verified', 'stale', 'rejected', 'conflict', 'deferred', 'clarification_required', 'uncertain', 'audit_only'].includes(validity);
      blockedByAnswer = answerStatus && (validity === 'stale' || validity === 'conflict');
    }
    if (!answerStatus && !isDeepStrictEqual(record.value, expected[record.kind])) evidenceError();
    seen.add(record.kind);
  }
  if (!Object.keys(expected).every(kind => seen.has(kind)) || trace.route === 'stale-blocked' && !blockedByAnswer && !blockedByEffect) {
    evidenceError();
  }
}

/** Each evidence reference has the form `relative/path.json#sha256=<hex digest>`.
 * The JSON contains one PilotEvidence record projected from the corresponding
 * captured source, standard, audit, grant, answer, PR, case or blocked-effect evidence. The
 * evidence directory is supplied by the caller and must be independently trusted.
 *
 * Checks the consistency of supplied capture records. The caller must independently
 * establish their origin, authorized scope, and connection to actual provider receipts.
 * A digest and consistent claims do not establish that an external action occurred.
 */
export function assertPilotTraceConsistency(traces: readonly PilotTrace[], evidenceRoot: string): {
  status: 'consistent'; provenance: 'not_assessed';
} {
  validateTraces(traces);
  try {
    if (!isAbsolute(evidenceRoot) || resolve(evidenceRoot) !== evidenceRoot || realpathSync(evidenceRoot) !== evidenceRoot
      || !lstatSync(evidenceRoot).isDirectory()) evidenceError();
    const refs = new Set<string>();
    const effects = new Set(traces.flatMap(trace => trace.pr ? [trace.pr.effectId] : []));
    for (const trace of traces) validateEvidence(trace, evidenceRoot, refs, effects);
  } catch { evidenceError(); }
  return { status: 'consistent', provenance: 'not_assessed' };
}
