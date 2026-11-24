import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { assertPilotTraceConsistency, type PilotEvidence, type PilotTrace } from '../support/pilot-trace.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'patrick-t25-traces-'));
  roots.push(root);
  const traces: PilotTrace[] = (['direct-pr', 'answered-pr', 'stale-blocked'] as const).map((route, index) => ({
    route, workId: `work-${index}`, generation: 1, sourceRevision: `source-${index}`,
    standardRevision: 'standard-4', evidenceEpoch: 3, caseId: index < 2 ? `case-${index}` : null,
    grantId: `grant-${index}`, answerReceiptId: index === 1 ? 'answer-1' : null,
    pr: index < 2 ? { effectId: `effect-${index}`, headSha: 'a'.repeat(40), treeSha: 'b'.repeat(40) } : null,
    observedWorkIds: [`work-${index}`], verifiedPrCount: index < 2 ? 1 : 0, unauthorizedEffects: 0,
    evidenceRefs: [],
  }));
  const records: PilotEvidence[][] = [];
  for (const [index, trace] of traces.entries()) {
    const subject = { workId: trace.workId, generation: trace.generation, sourceRevision: trace.sourceRevision,
      standardRevision: trace.standardRevision, evidenceEpoch: trace.evidenceEpoch };
    const files: PilotEvidence[] = [
      { version: '1.0', kind: 'source', subject, value: { sourceRevision: trace.sourceRevision } },
      { version: '1.0', kind: 'standard', subject, value: { standardRevision: trace.standardRevision, evidenceEpoch: trace.evidenceEpoch } },
      { version: '1.0', kind: 'audit', subject, value: { observedWorkIds: trace.observedWorkIds,
        verifiedPrCount: trace.verifiedPrCount, unauthorizedEffects: trace.unauthorizedEffects } },
    ];
    if (trace.grantId) files.push({ version: '1.0', kind: 'grant', subject, value: { grantId: trace.grantId } });
    if (trace.answerReceiptId) files.push({ version: '1.0', kind: 'answer', subject,
      value: { answerReceiptId: trace.answerReceiptId, validity: 'verified' } });
    if (trace.pr) files.push({ version: '1.0', kind: 'pr', subject, value: { ...trace.pr, status: 'verified' } });
    if (trace.caseId) files.push({ version: '1.0', kind: 'case', subject, value: { caseId: trace.caseId } });
    if (trace.route === 'stale-blocked') files.push({ version: '1.0', kind: 'blocker', subject,
      value: { effectId: 'intent-2', grantId: trace.grantId, status: 'conflict', reason: 'fixed_branch_conflict' } } as unknown as PilotEvidence);
    mkdirSync(join(root, `route-${index}`));
    records.push(files);
    for (const record of files) write(index, record);
  }
  function write(index: number, record: PilotEvidence) {
    const path = `route-${index}/${record.kind}.json`;
    const text = JSON.stringify(record);
    writeFileSync(join(root, path), text);
    const ref = `${path}#sha256=${hash(text)}`;
    const trace = traces[index];
    trace.evidenceRefs = [...trace.evidenceRefs.filter(value => !value.startsWith(path + '#')), ref];
  }
  return { root, traces, records, write };
}

test('the pilot inventory leaves all three external routes pending', () => {
  const inventory = JSON.parse(readFileSync(new URL('../../fixtures/pilot/acceptance.json', import.meta.url), 'utf8'));
  expect(inventory.routes.map((route: { route: string }) => route.route)).toEqual(['direct-pr', 'answered-pr', 'stale-blocked']);
  expect(inventory.routes.every((route: { status: string; evidenceRefs: string[] }) =>
    route.status === 'pending' && route.evidenceRefs.length === 0)).toBe(true);
});

test('a complete synthetic trace set is internally consistent without asserting real-provider provenance', () => {
  const { root, traces } = fixture();
  expect(assertPilotTraceConsistency(traces, root)).toEqual({ status: 'consistent', provenance: 'not_assessed' });
});

test('checks collected route files with the same validator as the local trace tests', () => {
  const { root, traces } = fixture();
  const script = fileURLToPath(new URL('../../scripts/check-pilot-traces.mjs', import.meta.url));
  const path = join(root, 'traces.json');
  const check = () => spawnSync(process.execPath, [script, path], { encoding: 'utf8' });
  writeFileSync(path, JSON.stringify(traces.slice(0, 2)));
  expect(check()).toMatchObject({ status: 1, stderr: 'PILOT_TRACE_INVALID\n' });
  const content = JSON.stringify(traces);
  writeFileSync(path, content);
  const result = check();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ status: 'consistent', provenance: 'not_assessed',
    traceSha256: hash(content), routes: traces.map(({ route, evidenceRefs }) => ({ route, evidenceRefs })) });
  writeFileSync(join(root, 'route-0/pr.json'), '{}');
  expect(check()).toMatchObject({ status: 1, stderr: 'PILOT_EVIDENCE_INVALID\n' });
});

test('the blocked route needs evidence of a stale answer or a conflicted effect', () => {
  const { root, traces } = fixture();
  traces[2].evidenceRefs = traces[2].evidenceRefs.filter(ref => !ref.startsWith('route-2/blocker.json#'));
  expect(() => assertPilotTraceConsistency(traces, root)).toThrow('PILOT_EVIDENCE_INVALID');
});

test('a blocked route may record a conflicting effect bound to its own work grant', () => {
  const { root, traces, write } = fixture();
  const trace = traces[2];
  trace.grantId = 'grant-2';
  const subject = { workId: trace.workId, generation: trace.generation, sourceRevision: trace.sourceRevision,
    standardRevision: trace.standardRevision, evidenceEpoch: trace.evidenceEpoch };
  write(2, { version: '1.0', kind: 'grant', subject, value: { grantId: trace.grantId } });
  write(2, { version: '1.0', kind: 'blocker', subject, value: {
    effectId: 'intent-2', grantId: trace.grantId, status: 'conflict', reason: 'fixed_branch_conflict',
  } } as unknown as PilotEvidence);
  expect(assertPilotTraceConsistency(traces, root)).toEqual({ status: 'consistent', provenance: 'not_assessed' });
});

test('a verified publication requires the case recorded with the work', () => {
  const { root, traces } = fixture();
  traces[0].caseId = null;
  traces[0].evidenceRefs = traces[0].evidenceRefs.filter(ref => !ref.startsWith('route-0/case.json#'));
  expect(() => assertPilotTraceConsistency(traces, root)).toThrow('PILOT_TRACE_INVALID');
});

test('a stale answer is enough to establish the blocked outcome without an effect attempt', () => {
  const { root, traces, write } = fixture();
  const trace = traces[2];
  trace.grantId = null;
  trace.answerReceiptId = 'answer-stale';
  trace.evidenceRefs = trace.evidenceRefs.filter(ref => !ref.startsWith('route-2/blocker.json#') && !ref.startsWith('route-2/grant.json#'));
  write(2, { version: '1.0', kind: 'answer', subject: { workId: trace.workId, generation: trace.generation,
    sourceRevision: trace.sourceRevision, standardRevision: trace.standardRevision, evidenceEpoch: trace.evidenceEpoch },
  value: { answerReceiptId: trace.answerReceiptId, validity: 'stale' } });
  expect(assertPilotTraceConsistency(traces, root)).toEqual({ status: 'consistent', provenance: 'not_assessed' });
});

test.each(['stale', 'conflict', 'verified'] as const)(
  'rejects an array containing the answer status %s', validity => {
    const { root, traces, write } = fixture();
    const trace = traces[2];
    trace.answerReceiptId = 'answer-malformed';
    if (validity !== 'verified') trace.evidenceRefs = trace.evidenceRefs.filter(ref => !ref.startsWith('route-2/blocker.json#'));
    write(2, { version: '1.0', kind: 'answer', subject: { workId: trace.workId, generation: trace.generation,
      sourceRevision: trace.sourceRevision, standardRevision: trace.standardRevision, evidenceEpoch: trace.evidenceEpoch },
    value: { answerReceiptId: trace.answerReceiptId, validity: [validity] } });
    expect(() => assertPilotTraceConsistency(traces, root)).toThrow('PILOT_EVIDENCE_INVALID');
  },
);

test.each(['verified', 'rejected', 'deferred', 'uncertain'] as const)(
  'answer status %s alone does not establish a stale or conflict result', validity => {
    const { root, traces, write } = fixture();
    const trace = traces[2];
    trace.answerReceiptId = 'answer-other';
    trace.evidenceRefs = trace.evidenceRefs.filter(ref => !ref.startsWith('route-2/blocker.json#'));
    write(2, { version: '1.0', kind: 'answer', subject: { workId: trace.workId, generation: trace.generation,
      sourceRevision: trace.sourceRevision, standardRevision: trace.standardRevision, evidenceEpoch: trace.evidenceEpoch },
    value: { answerReceiptId: trace.answerReceiptId, validity } });
    expect(() => assertPilotTraceConsistency(traces, root)).toThrow('PILOT_EVIDENCE_INVALID');
  },
);

test.each(['grantId', 'effectId', 'status', 'reason'] as const)(
  'rejects conflicting effect evidence with a changed %s', field => {
    const { root, traces, records, write } = fixture();
    const record = structuredClone(records[2].find(item => item.kind === 'blocker')!);
    record.value[field] = field === 'status' ? 'blocked' : field === 'effectId' ? 'effect-0' : field === 'reason' ? '' : 'grant-other';
    write(2, record);
    expect(() => assertPilotTraceConsistency(traces, root)).toThrow('PILOT_EVIDENCE_INVALID');
  },
);

test('a blocked conflict may retain an earlier verified answer while publishing no PR', () => {
  const { root, traces, write } = fixture();
  const trace = traces[2];
  trace.answerReceiptId = 'prior-answer';
  write(2, { version: '1.0', kind: 'answer', subject: { workId: trace.workId, generation: trace.generation,
    sourceRevision: trace.sourceRevision, standardRevision: trace.standardRevision, evidenceEpoch: trace.evidenceEpoch },
  value: { answerReceiptId: trace.answerReceiptId, validity: 'verified' } });
  expect(assertPilotTraceConsistency(traces, root)).toEqual({ status: 'consistent', provenance: 'not_assessed' });
});

test('a blocked trace may cite an answer marked conflict by AnswerGate', () => {
  const { root, traces, write } = fixture();
  const trace = traces[2];
  trace.answerReceiptId = 'conflicted-answer';
  write(2, { version: '1.0', kind: 'answer', subject: { workId: trace.workId, generation: trace.generation,
    sourceRevision: trace.sourceRevision, standardRevision: trace.standardRevision, evidenceEpoch: trace.evidenceEpoch },
  value: { answerReceiptId: trace.answerReceiptId, validity: 'conflict' } });
  expect(assertPilotTraceConsistency(traces, root)).toEqual({ status: 'consistent', provenance: 'not_assessed' });
});

test.each([
  ['route order', (traces: PilotTrace[]) => { [traces[0], traces[1]] = [traces[1], traces[0]]; }],
  ['duplicate work', (traces: PilotTrace[]) => { traces[1].workId = traces[0].workId; }],
  ['duplicate source revision', (traces: PilotTrace[]) => { traces[1].sourceRevision = traces[0].sourceRevision; }],
  ['grant assigned to different work', (traces: PilotTrace[]) => { traces[1].grantId = traces[0].grantId; }],
  ['effect assigned to different work', (traces: PilotTrace[]) => { traces[1].pr!.effectId = traces[0].pr!.effectId; }],
  ['answer assigned to different work', (traces: PilotTrace[]) => { traces[2].answerReceiptId = traces[1].answerReceiptId; }],
  ['answer for another work', (traces: PilotTrace[]) => { traces[1].observedWorkIds = ['work-0']; }],
  ['missing answer', (traces: PilotTrace[]) => { traces[1].answerReceiptId = null; }],
  ['unexpected direct answer', (traces: PilotTrace[]) => { traces[0].answerReceiptId = 'answer-1'; }],
  ['missing delivered PR', (traces: PilotTrace[]) => { traces[0].pr = null; }],
  ['PR on stale route', (traces: PilotTrace[]) => { traces[2].pr = traces[0].pr; }],
  ['unauthorized action', (traces: PilotTrace[]) => { traces[2].unauthorizedEffects = 1; }],
  ['wrong PR count', (traces: PilotTrace[]) => { traces[0].verifiedPrCount = 0; }],
  ['invalid generation', (traces: PilotTrace[]) => { traces[0].generation = 0; }],
  ['coerced generation', (traces: PilotTrace[]) => { traces[0].generation = '1' as unknown as number; }],
  ['coerced evidence epoch', (traces: PilotTrace[]) => { traces[0].evidenceEpoch = [3] as unknown as number; }],
  ['coerced verified count', (traces: PilotTrace[]) => { traces[0].verifiedPrCount = [1] as unknown as number; }],
  ['coerced unauthorized count', (traces: PilotTrace[]) => { traces[0].unauthorizedEffects = [0] as unknown as number; }],
  ['invalid Git object', (traces: PilotTrace[]) => { traces[0].pr!.headSha = 'abc'; }],
  ['Git object unsupported by the publisher', (traces: PilotTrace[]) => { traces[0].pr!.headSha = 'a'.repeat(64); }],
] as const)('rejects %s in the three-route set', (_name, mutate) => {
  const { root, traces } = fixture();
  mutate(traces);
  expect(() => assertPilotTraceConsistency(traces, root)).toThrow('PILOT_TRACE_INVALID');
});

test.each(['sourceRevision', 'standardRevision', 'evidenceEpoch', 'workId', 'generation'] as const)(
  'rejects an evidence subject with a changed %s even if its digest is updated', field => {
    const { root, traces, records, write } = fixture();
    const record = structuredClone(records[1].find(item => item.kind === 'answer')!);
    if (field === 'generation' || field === 'evidenceEpoch') record.subject[field]++;
    else record.subject[field] += '-other';
    write(1, record);
    expect(() => assertPilotTraceConsistency(traces, root)).toThrow('PILOT_EVIDENCE_INVALID');
  },
);

test.each([
  ['grant', 'grantId'], ['answer', 'answerReceiptId'], ['pr', 'effectId'], ['pr', 'headSha'],
  ['pr', 'treeSha'], ['case', 'caseId'], ['audit', 'verifiedPrCount'], ['audit', 'unauthorizedEffects'],
] as const)('rejects a changed %s evidence %s with a recomputed digest', (kind, field) => {
  const { root, traces, records, write } = fixture();
  const record = structuredClone(records[1].find(item => item.kind === kind)!);
  const value = record.value as Record<string, unknown>;
  value[field] = typeof value[field] === 'number' ? Number(value[field]) + 1 : 'f'.repeat(40);
  write(1, record);
  expect(() => assertPilotTraceConsistency(traces, root)).toThrow('PILOT_EVIDENCE_INVALID');
});

test('an answered delivery requires the verified AnswerGate receipt', () => {
  const { root, traces, records, write } = fixture();
  const record = structuredClone(records[1].find(item => item.kind === 'answer')!);
  record.value.validity = 'stale';
  write(1, record);
  expect(() => assertPilotTraceConsistency(traces, root)).toThrow('PILOT_EVIDENCE_INVALID');
});

test('rejects a missing reference, modified bytes, duplicate kinds, and traversal', () => {
  const { root, traces, records, write } = fixture();
  const saved = [...traces[0].evidenceRefs];
  traces[0].evidenceRefs = saved.filter(ref => !ref.startsWith('route-0/source.json#'));
  expect(() => assertPilotTraceConsistency(traces, root)).toThrow('PILOT_EVIDENCE_INVALID');
  traces[0].evidenceRefs = saved;
  writeFileSync(join(root, 'route-0/source.json'), '{}');
  expect(() => assertPilotTraceConsistency(traces, root)).toThrow('PILOT_EVIDENCE_INVALID');
  write(0, records[0].find(item => item.kind === 'source')!);
  traces[0].evidenceRefs.push(traces[0].evidenceRefs[0]);
  expect(() => assertPilotTraceConsistency(traces, root)).toThrow('PILOT_EVIDENCE_INVALID');
  traces[0].evidenceRefs.pop();
  traces[0].evidenceRefs.push(`../outside.json#sha256=${'0'.repeat(64)}`);
  expect(() => assertPilotTraceConsistency(traces, root)).toThrow('PILOT_EVIDENCE_INVALID');
});

test('rejects symlinked evidence files and parent directories', () => {
  const { root, traces } = fixture();
  const content = readFileSync(join(root, 'route-0/source.json'));
  rmSync(join(root, 'route-0/source.json'));
  writeFileSync(join(root, 'outside.json'), content);
  symlinkSync(join(root, 'outside.json'), join(root, 'route-0/source.json'));
  expect(() => assertPilotTraceConsistency(traces, root)).toThrow('PILOT_EVIDENCE_INVALID');
  rmSync(join(root, 'route-0/source.json'));
  writeFileSync(join(root, 'route-0/source.json'), content);
  symlinkSync(join(root, 'route-0'), join(root, 'alias'));
  traces[0].evidenceRefs[0] = traces[0].evidenceRefs[0].replace('route-0/', 'alias/');
  expect(() => assertPilotTraceConsistency(traces, root)).toThrow('PILOT_EVIDENCE_INVALID');
});

test('rejects duplicate kinds and evidence over the finite size limit', () => {
  const { root, traces, records } = fixture();
  const extra = JSON.stringify(records[0].find(item => item.kind === 'source'));
  writeFileSync(join(root, 'route-0/duplicate.json'), extra);
  traces[0].evidenceRefs.push(`route-0/duplicate.json#sha256=${hash(extra)}`);
  expect(() => assertPilotTraceConsistency(traces, root)).toThrow('PILOT_EVIDENCE_INVALID');
  traces[0].evidenceRefs.pop();
  const huge = 'x'.repeat(1024 * 1024 + 1);
  writeFileSync(join(root, 'route-0/source.json'), huge);
  traces[0].evidenceRefs[0] = `route-0/source.json#sha256=${hash(huge)}`;
  expect(() => assertPilotTraceConsistency(traces, root)).toThrow('PILOT_EVIDENCE_INVALID');
});
