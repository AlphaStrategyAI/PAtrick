import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { canonicalPayload } from '../../packages/contracts/src/envelope.js';
import { createAnswerGate } from '../../packages/domain/src/answer-gate.js';
import { createDelegationApi } from '../../packages/domain/src/delegation.js';
import { createStandardsApi } from '../../packages/domain/src/standards.js';
import { createLocalHubPort, encodeHubAnswer } from '../../packages/integrations/autoloop/answers.js';
import { publishHubEvent, toHubEventBody } from '../../packages/integrations/autoloop/client.js';
import { storeHubView } from '../../packages/integrations/autoloop/observer.js';
import { openDatabase } from '../../packages/storage/src/database.js';
import { appendDomainEvent } from '../../packages/storage/src/outbox.js';
import { deriveWorkBatch } from '../../packages/storage/src/views/work-source.js';

const at = '2026-11-17T02:00:00.000Z';
const now = () => new Date(at);
const principal = { account_id: 'owner', caller_id: 'web', auth_epoch: 1,
  domains: ['personal'], operations: ['owner', 'questions.answer'] };
const domain = 'personal';
const scope = { accountId: principal.account_id, dataDomain: domain };

async function answeredWork(action: 'collect_evidence' | 'judge') {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t13-answer-'));
  const db = openDatabase(join(dir, 'view.sqlite'));
  const hub = createLocalHubPort(join(dir, 'hub.sqlite'));
  const close = () => {
    hub.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(principal.account_id, 1, 1, at);
    const delegation = createDelegationApi(db, principal, { now, domain });
    const permissions = { actions: ['judge', 'collect'], resources: ['work'], effects: [],
      domains: [domain], risk: 'low' as const, level: 'L1' as const, budget_micros: 1000 };
    await delegation.registerMandateType({ ...permissions, type_id: 'type-judge', config_version: 1 });
    await delegation.openMandate({ ...permissions, type_id: 'type-judge', mandate_id: 'mandate',
      expires_at: '2026-11-18T00:00:00.000Z' });
    await delegation.ensureJudgmentPolicy();
    await delegation.openWork({ work_id: 'W-017', generation: 1, mandate_id: 'mandate',
      phase: 'judgment', next_action: 'judge', budget_micros: 1000 });
    await createStandardsApi(db, principal, { now, domain }).freezeJudgmentBasis('W-017', 1);
    const gate = createAnswerGate(db, { domain, now, hub, encode: encodeHubAnswer });
    const binding = await gate.bindQuestion(principal, {
      question_id: 'Q-017', question_version: 1, work_id: 'W-017', generation: 1,
      proposal_revision: 1, hub_card_id: 17, custom_allowed: false, custom_rules: [],
      options: [{ option_id: 'A', index: 0, label: 'A', disposition: 'proceed', reason_code: null,
        next_action: action, difference: null, missing: [],
        collection_id: action === 'collect_evidence' ? 'col-17' : null,
        expected_material: action === 'collect_evidence' ? 'material-17' : null }],
    });
    storeHubView(db, { hub_seq: 11, runs: [],
      cards: [{ id: 17, title: '', state: 'open', choice: null, answer: null }] }, at);
    const before = deriveWorkBatch(db, scope, now());
    expect(before).toMatchObject({ coverage: 'fresh', items: [{ state: 'awaiting_answer', question_id: 'Q-017' }] });

    const payload = { work_id: binding.work_id, generation: binding.generation,
      question_id: binding.question_id, question_version: binding.question_version, proposal_revision: binding.proposal_revision,
      options_hash: binding.options_hash, answer: { kind: 'option' as const, option_id: 'A' } };
    const receipt = await gate.submitAnswer(principal, { client_request_id: 'answer-17', expected_revision: 1,
      payload_hash: createHash('sha256').update(canonicalPayload(payload)).digest('hex'), entry: 'web', payload });
    expect(receipt.validity).toBe('verified');
    expect(db.prepare('SELECT awaiting_answer FROM work_generations').get()).toEqual({ awaiting_answer: 1 });
    expect(db.prepare('SELECT status FROM question_bindings').get()).toEqual({ status: 'closed' });
    storeHubView(db, { hub_seq: 12, runs: [],
      cards: [{ id: 17, title: '', state: 'answered', choice: null, answer: null }] }, at);
    return { db, close, receipt };
  } catch (error) {
    close();
    throw error;
  }
}

test('verified AnswerGate receipt preserves a fresh waiting-evidence stage after its question closes', async () => {
  const { db, close, receipt } = await answeredWork('collect_evidence');
  try {
    expect(db.prepare('SELECT stage FROM work_stages').get()).toEqual({ stage: 'waiting_evidence' });
    expect(deriveWorkBatch(db, scope, now())).toMatchObject({ coverage: 'fresh', watermark: { hub_seq: 12, domain_seq: 1 },
      items: [{ state: 'verifying', question_id: null }] });

    const observed = db.prepare("SELECT event_id,payload FROM domain_events WHERE aggregate_id='Q-017'").get() as
      { event_id: string; payload: string };
    db.prepare("UPDATE domain_events SET payload=json_set(payload,'$.generation',2) WHERE event_id=?").run(observed.event_id);
    expect(deriveWorkBatch(db, scope, now())).toMatchObject({ coverage: 'syncing', items: [{ state: 'verifying' }] });
    db.prepare('UPDATE domain_events SET payload=? WHERE event_id=?').run(observed.payload, observed.event_id);

    // The remaining stage and newest Hub card cannot make a foreign receipt authoritative.
    db.prepare("UPDATE answer_receipts SET data_domain='company' WHERE receipt_id=?").run(receipt.receipt_id);
    expect(deriveWorkBatch(db, scope, now())).toMatchObject({ coverage: 'syncing', items: [{ state: 'verifying' }] });
  } finally {
    close();
  }
});

test('a current Hub snapshot does not hide a lagging local watermark', async () => {
  const { db, close } = await answeredWork('judge');
  try {
    db.prepare("UPDATE work_generations SET awaiting_answer=0,phase='delivery' WHERE work_id='W-017'").run();
    db.prepare("UPDATE projection_cursors SET domain_seq=0 WHERE name='local'").run();
    expect(deriveWorkBatch(db, scope, now())).toMatchObject({ coverage: 'syncing', watermark: { hub_seq: 12, domain_seq: 0 },
      items: [{ state: 'verifying' }] });
    db.prepare("UPDATE projection_cursors SET domain_seq=1 WHERE name='local'").run();
    expect(deriveWorkBatch(db, scope, now())).toMatchObject({ coverage: 'fresh', items: [{ state: 'verifying' }] });
  } finally {
    close();
  }
});

test('a Hub attempt is not attributed before the watermark of its supporting local event', async () => {
  const { db, close } = await answeredWork('judge');
  try {
    const request = { event_id: 'request-17', root: 'W-017', cause: 'source-17', generation: 1,
      hops: 0, kind: 'work.requested' as const };
    appendDomainEvent(db, { eventId: request.event_id, aggregateId: request.root, aggregateVersion: 1,
      accountId: scope.accountId, dataDomain: scope.dataDomain,
      payload: { type: request.kind, work_id: request.root, generation: 1 }, destination: 'autoloop' });
    await publishHubEvent(db, { postEvent: async () => ({ event: 1, duplicate: false, routed: ['来源变化'] }) }, request, at);
    const event = toHubEventBody(request);
    storeHubView(db, { hub_seq: 13, cards: [], runs: [{ id: 7, rule: '来源变化', state: 'done', attempts: 1,
      summary: '', error: '', events: [{ source: 'patrick', type: event.type, summary: '', subject: event.subject }] }] }, at);
    db.prepare("UPDATE projection_cursors SET domain_seq=1 WHERE name='local'").run();
    expect(deriveWorkBatch(db, scope, now())).toMatchObject({ coverage: 'syncing', items: [{ attempt_ids: [] }] });
    db.prepare("UPDATE projection_cursors SET domain_seq=2 WHERE name='local'").run();
    expect(deriveWorkBatch(db, scope, now())).toMatchObject({ coverage: 'fresh', items: [{ attempt_ids: [7] }] });
  } finally {
    close();
  }
});
