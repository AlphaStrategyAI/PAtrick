import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { rehearsePilotRoutes, type RouteOutcome } from '../support/pilot-rehearsal.js';
import { assertPilotTraceConsistency, type PilotEvidence, type PilotTrace } from '../support/pilot-trace.js';

const NOW = '2026-11-17T06:00:00.000Z';

/** Writes the evidence of every route and returns the traces that name it. */
function writeEvidence(outcomes: readonly RouteOutcome[], root: string): PilotTrace[] {
  return outcomes.map((outcome, index) => {
    const subject = { workId: outcome.workId, generation: 1, sourceRevision: outcome.sourceRevision,
      standardRevision: outcome.standardRevision, evidenceEpoch: outcome.evidenceEpoch };
    const records: PilotEvidence[] = [
      { version: '1.0', kind: 'source', subject, value: { sourceRevision: outcome.sourceRevision } },
      { version: '1.0', kind: 'standard', subject,
        value: { standardRevision: outcome.standardRevision, evidenceEpoch: outcome.evidenceEpoch } },
      { version: '1.0', kind: 'audit', subject, value: { observedWorkIds: outcome.observedWorkIds,
        verifiedPrCount: outcome.verifiedPrCount, unauthorizedEffects: outcome.unauthorizedEffects } },
    ];
    if (outcome.grantId) records.push({ version: '1.0', kind: 'grant', subject, value: { grantId: outcome.grantId } });
    if (outcome.answerReceiptId) records.push({ version: '1.0', kind: 'answer', subject,
      value: { answerReceiptId: outcome.answerReceiptId, validity: outcome.answerValidity } });
    if (outcome.pr) records.push({ version: '1.0', kind: 'pr', subject, value: { ...outcome.pr, status: 'verified' } });
    if (outcome.caseId) records.push({ version: '1.0', kind: 'case', subject, value: { caseId: outcome.caseId } });
    const directory = join(root, `route-${index}`);
    mkdirSync(directory, { recursive: true });
    const evidenceRefs: string[] = [];
    for (const record of records) {
      const path = `route-${index}/${record.kind}.json`;
      const text = JSON.stringify(record);
      writeFileSync(join(root, path), text);
      evidenceRefs.push(`${path}#sha256=${createHash('sha256').update(text).digest('hex')}`);
    }
    return {
      route: outcome.route, workId: outcome.workId, generation: 1, sourceRevision: outcome.sourceRevision,
      standardRevision: outcome.standardRevision, evidenceEpoch: outcome.evidenceEpoch, caseId: outcome.caseId,
      grantId: outcome.grantId, answerReceiptId: outcome.answerReceiptId, pr: outcome.pr,
      observedWorkIds: outcome.observedWorkIds, verifiedPrCount: outcome.verifiedPrCount,
      unauthorizedEffects: outcome.unauthorizedEffects, evidenceRefs,
    };
  });
}

test('the three pilot routes run against the local domain and leave the evidence the plan asks for', async () => {
  // The evidence root has to be canonical, so the temporary path is resolved first.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'patrick-t25-rehearsal-')));
  try {
    const rehearsal = await rehearsePilotRoutes({ root, now: () => new Date(NOW) });
    try {
      const outcomes = rehearsal.outcomes;
      expect(outcomes.map(outcome => outcome.route)).toEqual(['direct-pr', 'answered-pr', 'stale-blocked']);
      // The direct route publishes without waiting for an answer.
      expect(outcomes[0]!.answerReceiptId).toBeNull();
      expect(outcomes[0]!.pr).not.toBeNull();
      expect(outcomes[0]!.verifiedPrCount).toBe(1);
      // The answered route waits for the verified answer and then publishes.
      expect(outcomes[1]!.answerValidity).toBe('verified');
      expect(outcomes[1]!.pr).not.toBeNull();
      expect(outcomes[1]!.verifiedPrCount).toBe(1);
      // The blocked route answers a card that is already stale and publishes nothing.
      expect(outcomes[2]!.answerValidity).toBe('stale');
      expect(outcomes[2]!.pr).toBeNull();
      expect(outcomes[2]!.verifiedPrCount).toBe(0);
      // No route published without its own grant.
      expect(outcomes.every(outcome => outcome.unauthorizedEffects === 0)).toBe(true);
      const traces = writeEvidence(outcomes, rehearsal.evidenceRoot);
      console.error('TRACES', JSON.stringify(traces, null, 1));
      expect(assertPilotTraceConsistency(traces, rehearsal.evidenceRoot))
        .toEqual({ status: 'consistent', provenance: 'not_assessed' });
    } finally { rehearsal.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
