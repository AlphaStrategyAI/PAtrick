import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { createCredentialStore } from '@patrick/host';
import { canonicalPayload, type Json } from '../../packages/contracts/src/envelope.js';
import { createApp } from '../../apps/service/src/app.js';
import { issueBootstrapTicket, issueCallerSession, ORIGIN } from '../../apps/service/src/auth.js';
import { registerFeishuSettings } from '../../apps/service/src/routes/feishu.js';
import { clearSettingsOperations, runSettingsOperation, settingsOperations } from '../../apps/service/src/settings/registry.js';
import {
  createAnswerGate,
  channelPermit,
  type AnswerCommand,
  type AnswerGate,
  type BindQuestionInput,
  type CardAnswer,
  type Principal,
  type QuestionBinding,
} from '../../packages/domain/src/answer-gate.js';
import { createDelegationApi, type AdmissionPrincipal } from '../../packages/domain/src/delegation.js';
import { createStopFixture, createWorkControlApi } from '../../packages/domain/src/work-control.js';
import {
  claimContinuation,
  confirmCollectedEvidence,
  dispatchDelivery,
  emitStage,
  recordCollectionRound,
  writePullRequest,
  type ResumeKey,
} from '../../packages/domain/src/work-continuation.js';
import { settleNativeAnswer, type ContinuationPort } from '../../packages/integrations/autoloop/agent.js';
import { createLocalHubPort, encodeHubAnswer, type LocalHubPort } from '../../packages/integrations/autoloop/answers.js';
import { requiresChannelReconciliation } from '../../packages/integrations/feishu/channel-gate.js';
import { createFeishuChannel, openSupervisedSocket, PAIRING_TTL_MS } from '../../packages/integrations/feishu/connection.js';
import { openDatabase, type SqliteDatabase } from '../../packages/storage/src/database.js';
import { createRecoveryRuntimeGate } from '@patrick/storage';

const NOW = '2026-11-17T02:00:00.000Z';
const DOMAIN = 'product';
const WORK_ID = 'W-017';
const GENERATION = 2;

const webPrincipal: Principal = {
  account_id: 'owner',
  caller_id: 'web',
  auth_epoch: 1,
  domains: [DOMAIN],
  operations: ['owner', 'questions.answer'],
};

const feishuPrincipal: Principal = {
  ...webPrincipal,
  caller_id: 'feishu',
};

function closeAnswerDomain(db: SqliteDatabase) {
  createRecoveryRuntimeGate(db);
}

test('recovery admission prevents binding a new answer card', async () => {
  const scene = await openScene({ crashAfterAccept: false });
  try {
    closeAnswerDomain(scene.db);
    await expect(scene.bind(questionInput('Q-recovery-bind', 18, proceedOptions(), []))).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(scene.db.prepare('SELECT COUNT(*) AS n FROM question_bindings').get()).toEqual({ n: 0 });
  } finally { scene.close(); }
});

test('recovery admission prevents answer intents and channel permits', async () => {
  const scene = await openScene({ crashAfterAccept: false });
  try {
    const binding = await scene.bind(questionInput('Q-recovery-submit', 18, proceedOptions(), []));
    closeAnswerDomain(scene.db);
    const command = scene.command(webPrincipal, 'closed-answer', binding, { kind: 'option', option_id: 'A' });
    await expect(scene.web.submitAnswer(webPrincipal, command)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(scene.db.prepare('SELECT COUNT(*) AS n FROM answer_intents').get()).toEqual({ n: 0 });
    expect(() => channelPermit(scene.db, 'conn-017', 'closed-inbound', binding.question_id, NOW)).toThrow('RECOVERY_WRITE_BLOCKED');
    expect(scene.db.prepare('SELECT COUNT(*) AS n FROM channel_permits').get()).toEqual({ n: 0 });
    expect(await scene.hub.read(binding.question_id)).toBeNull();
  } finally { scene.close(); }
});

test('recovery admission prevents channel send permits', async () => {
  const scene = await openScene({ crashAfterAccept: false });
  try {
    const binding = await scene.bind(questionInput('Q-recovery-permit', 18, proceedOptions(), []));
    closeAnswerDomain(scene.db);
    expect(() => channelPermit(scene.db, 'conn-017', 'closed-inbound', binding.question_id, NOW)).toThrow('RECOVERY_WRITE_BLOCKED');
    expect(scene.db.prepare('SELECT COUNT(*) AS n FROM channel_permits').get()).toEqual({ n: 0 });
  } finally { scene.close(); }
});

test('answer checks recovery admission after encoding and immediately before Hub handoff', async () => {
  const scene = await openScene({ crashAfterAccept: false });
  try {
    const binding = await scene.bind(questionInput('Q-recovery-handoff', 18, proceedOptions(), []));
    const gate = createAnswerGate(scene.db, {
      domain: DOMAIN, now: scene.now, hub: scene.hub,
      encode(answer) { closeAnswerDomain(scene.db); return encodeHubAnswer(answer); },
    });
    const command = scene.command(webPrincipal, 'closed-handoff', binding, { kind: 'option', option_id: 'A' });
    await expect(gate.submitAnswer(webPrincipal, command)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(await scene.hub.read(binding.question_id)).toBeNull();
    expect(scene.db.prepare('SELECT COUNT(*) AS n FROM resume_intents').get()).toEqual({ n: 0 });
  } finally { scene.close(); }
});

test('accepted answer readback while recovery is closed cannot grant a continuation', async () => {
  const scene = await openScene({ crashAfterAccept: true });
  try {
    const binding = await scene.bind(questionInput('Q-recovery-readback', 18, proceedOptions(), []));
    const command = scene.command(webPrincipal, 'accepted-before-close', binding, { kind: 'option', option_id: 'A' });
    await expect(scene.web.submitAnswer(webPrincipal, command)).rejects.toThrow('RECEIPT_LOST');
    const intent = scene.db.prepare('SELECT intent_id FROM answer_intents').get() as { intent_id: string };
    closeAnswerDomain(scene.db);
    const receipt = await scene.web.recoverAnswer(intent.intent_id);
    expect(receipt.validity).toBe('audit_only');
    expect(scene.db.prepare('SELECT COUNT(*) AS n FROM resume_intents').get()).toEqual({ n: 0 });
    expect(scene.db.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE json_extract(payload,'$.type') = 'answer.verified'").get()).toEqual({ n: 0 });
  } finally { scene.close(); }
});

test('recovery denial is a nonretryable answer API conflict', async () => {
  const scene = await openScene({ crashAfterAccept: false });
  const credentials = mkdtempSync(join(tmpdir(), 'patrick-t10-recovery-auth-'));
  try {
    const binding = await scene.bind(questionInput('Q-recovery-api', 18, proceedOptions(), []));
    const store = createCredentialStore(credentials, scene.now);
    issueBootstrapTicket(scene.db, { accountId: 'owner' }, scene.now);
    const session = issueCallerSession(scene.db, { accountId: 'owner', callerId: 'web', domain: DOMAIN,
      permissions: ['owner'] }, scene.now, store);
    const app = createApp({ databasePath: scene.db.name, credentialDirectory: credentials,
      now: scene.now, recoveryRuntime: { attach() {} } });
    const { client_request_id, expected_revision, payload_hash, payload } = scene.command(webPrincipal,
      'closed-answer-api', binding, { kind: 'option', option_id: 'A' });
    const response = await app.request(`/api/v1/questions/${binding.question_id}/answers`, {
      method: 'POST', headers: { authorization: session.authorization, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ client_request_id, expected_revision, payload_hash, payload }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'CONFLICT', params: { reason: 'recovery_write_blocked' }, retryable: false });
    expect(scene.db.prepare('SELECT COUNT(*) AS n FROM answer_intents').get()).toEqual({ n: 0 });
  } finally { scene.close(); rmSync(credentials, { recursive: true, force: true }); }
});


test('answer-once', async () => {
  const scene = await openScene({ crashAfterAccept: true });
  try {
    const binding = await scene.bind(questionInput('Q-017', 17, proceedOptions(), []));
    const optionA = scene.command(webPrincipal, 'web-req-a', binding, { kind: 'option', option_id: 'A' });
    const optionB = scene.command(feishuPrincipal, 'feishu-req-b', binding, { kind: 'option', option_id: 'B' });
    const webAnswer = { submit: (command: AnswerCommand) => scene.web.submitAnswer(webPrincipal, command) };
    const feishuAnswer = { submit: (command: AnswerCommand) => scene.feishu.submitAnswer(feishuPrincipal, command) };
    const hubAnswersFor = (questionId: string) => scene.hub.list(questionId);
    const consumeNativeAnswerBeforeReceipt = (questionId: string) => scene.consumeNative(questionId);
    const modelCallsFor = async (workId: string) => scene.calls(workId).model;
    const retryCallsFor = async (workId: string) => scene.calls(workId).retry;
    const restartServiceAndReconcile = () => scene.restart();
    const drainResumeQueue = () => scene.drain();
    const verifiedReceiptsFor = (questionId: string) => scene.verified(questionId);
    const attemptsForResumeKey = (workId: string, generation: number, questionId: string, phase: ResumeKey['phase']) =>
      scene.attempts(workId, generation, questionId, phase);

    const contenders = await Promise.allSettled([webAnswer.submit(optionA), feishuAnswer.submit(optionB)]);
    expect(contenders).toHaveLength(2);
    expect(await hubAnswersFor('Q-017')).toHaveLength(1);
    await consumeNativeAnswerBeforeReceipt('Q-017');
    expect(await modelCallsFor('W-017')).toBe(0);
    expect(await retryCallsFor('W-017')).toBe(0);
    await restartServiceAndReconcile();
    await drainResumeQueue();
    expect(await verifiedReceiptsFor('Q-017')).toHaveLength(1);
    expect(await attemptsForResumeKey('W-017', 2, 'Q-017', 'answer')).toBe(1);
    expect(scene.encodeCalls).toBe(1);
    expect(contenders.some((item) => item.status === 'rejected')).toBe(true);
    const source = readFileSync(fileURLToPath(new URL('../../packages/domain/src/work-continuation.ts', import.meta.url)), 'utf8');
    expect(source).toContain(`UPDATE resume_intents SET state = 'claimed', attempt_id = @attempt_id
WHERE work_id = @work_id AND generation = @generation AND question_id = @question_id
  AND answer_event_id = @answer_event_id AND phase = @phase AND state = 'ready'
RETURNING next_action, evidence_ref;`);
    const stored = await scene.hub.read('Q-017');
    expect(stored?.body).toEqual(encodeHubAnswer({ kind: 'choice', index: stored?.body && 'choice' in stored.body ? stored.body.choice : -1 }));
    const basis = scene.basisHash();
    expect(basis).toMatch(/^[a-f0-9]{64}$/);
    expect(scene.basisHash()).toBe(basis);
  } finally {
    scene.close();
  }
});

test('a dropped hub reopens from the same file and recovers one verified receipt', async () => {
  const scene = await openScene({ crashAfterAccept: true });
  try {
    const binding = await scene.bind(questionInput('Q-017', 17, proceedOptions(), []));
    await expect(scene.web.submitAnswer(
      webPrincipal,
      scene.command(webPrincipal, 'web-hub-drop', binding, { kind: 'option', option_id: 'A' }),
    )).rejects.toThrow(/RECEIPT_LOST/);
    const closed = scene.hub;
    scene.reopenHub();
    expect(scene.hub).not.toBe(closed);
    await expect(closed.read('Q-017')).rejects.toThrow();
    expect((await scene.hub.read('Q-017'))?.state).toBe('answered');
    await scene.restart();
    expect(await scene.verified('Q-017')).toHaveLength(1);
  } finally {
    scene.close();
  }
});

test('an open attempt waits without forging a stopped tree', async () => {
  const scene = await openScene({ crashAfterAccept: false });
  try {
    const binding = await scene.bind(questionInput('Q-017', 17, proceedOptions(), []));
    const receipt = await scene.web.submitAnswer(
      webPrincipal,
      scene.command(webPrincipal, 'web-open-attempt', binding, { kind: 'option', option_id: 'A' }),
    );
    expect(receipt.validity).toBe('verified');
    scene.db.prepare(`UPDATE work_generations
      SET attempt_closed = 0, process_tree_stopped = 0, effects_reconciled = 0, control_state = 'paused'
      WHERE work_id = ? AND generation = ?`).run(WORK_ID, GENERATION);
    expect(claimContinuation(scene.db, webPrincipal, DOMAIN, scene.key('Q-017', 'answer'), 'attempt-open', scene.now())).toEqual({
      status: 'waiting',
    });
    expect(scene.db.prepare(`SELECT attempt_closed, process_tree_stopped, effects_reconciled, control_state
      FROM work_generations WHERE work_id = ? AND generation = ?`).get(WORK_ID, GENERATION)).toEqual({
      attempt_closed: 0,
      process_tree_stopped: 0,
      effects_reconciled: 0,
      control_state: 'paused',
    });
    expect(scene.attempts(WORK_ID, GENERATION, 'Q-017', 'answer')).toBe(0);
  } finally {
    scene.close();
  }
});

test('bounded-evidence-resume', async () => {
  const scene = await openScene({ crashAfterAccept: false });
  try {
    const binding = await scene.bind(questionInput('Q-017', 17, [collectOption()], []));
    const receipt = await scene.web.submitAnswer(
      webPrincipal,
      scene.command(webPrincipal, 'web-collect', binding, { kind: 'option', option_id: 'collect' }),
    );
    expect(receipt.validity).toBe('verified');
    expect(scene.stageCount('draft.requested')).toBe(0);
    expect(scene.prSends).toBe(0);
    expect(scene.stageCount('work.delivered')).toBe(0);
    const answerKey = scene.key('Q-017', 'answer');
    expect(claimContinuation(scene.db, webPrincipal, DOMAIN, { ...answerKey, phase: 'evidence_ready' }, 'attempt-too-soon', scene.now())).toEqual({
      status: 'waiting',
    });
    expect(() => dispatchDelivery(scene.db, WORK_ID, GENERATION)).toThrow(/WAITING_EVIDENCE/);
    expect(() => emitStage(scene.db, WORK_ID, GENERATION, 'draft.requested', scene.now())).toThrow(/WAITING_EVIDENCE/);
    expect(() => writePullRequest(scene.db, WORK_ID, GENERATION)).toThrow(/WAITING_EVIDENCE/);
    expect(scene.stageCount('draft.requested')).toBe(0);
    expect(scene.prSends).toBe(0);
    expect(scene.stageCount('work.delivered')).toBe(0);

    const collect = claimContinuation(scene.db, webPrincipal, DOMAIN, answerKey, 'attempt-collect', scene.now());
    expect(collect.status).toBe('claimed');
    if (collect.status === 'claimed') {
      expect(collect.grant.phase).toBe('collect_evidence');
      expect(collect.grant.allowed_effects).toEqual(['collect:col-017']);
      expect(collect.grant.basis_hash).toBe(scene.basisHash());
    }
    recordCollectionRound(scene.db, webPrincipal, {
      question_id: 'Q-017',
      material: 'material-017',
      evidence_ref: 'material-017',
    }, scene.now());
    confirmCollectedEvidence(scene.db, webPrincipal, DOMAIN, answerKey, 'material-017', scene.now());
    await scene.restart();
    confirmCollectedEvidence(scene.db, webPrincipal, DOMAIN, answerKey, 'material-017', scene.now());
    const deliveryKey = scene.key('Q-017', 'evidence_ready');
    const first = claimContinuation(scene.db, webPrincipal, DOMAIN, deliveryKey, 'attempt-deliver', scene.now());
    const second = claimContinuation(scene.db, webPrincipal, DOMAIN, deliveryKey, 'attempt-deliver-2', scene.now());
    expect(first.status).toBe('claimed');
    expect(second.status).toBe('duplicate');
    expect(scene.attempts(WORK_ID, GENERATION, 'Q-017', 'evidence_ready')).toBe(1);
    if (first.status === 'claimed') {
      expect(first.grant.phase).toBe('delivery');
      expect(first.grant.allowed_effects).toEqual(['publish_pr']);
      expect(first.grant.basis_hash).toBe(scene.basisHash());
    }
    expect(scene.stageCount('draft.requested')).toBe(0);
    expect(scene.prSends).toBe(0);
    expect(scene.stageCount('work.delivered')).toBe(0);
  } finally {
    scene.close();
  }
});

test('channel-lifecycle', async () => {
  const scene = await openScene({ crashAfterAccept: false });
  try {
    const channel = createFeishuChannel(scene.db, {
      now: scene.now,
      hub: scene.hub,
      encode: encodeHubAnswer,
      domain: DOMAIN,
    });
    const currentTest = await channel.prepareSentTest();
    const oldCallback = { inbound_id: 'old-card', epoch: 0, question_id: 'Q-017' };
    const businessAnswerCount = async () => {
      const row = scene.db.prepare(`SELECT COUNT(*) AS n FROM answer_receipts WHERE validity = 'verified'`).get() as { n: number };
      return row.n;
    };
    const verifiedReceiptsFor = (questionId: string) => scene.verified(questionId);
    const attemptsForResumeKey = (workId: string, generation: number, questionId: string, phase: ResumeKey['phase']) =>
      scene.attempts(workId, generation, questionId, phase);

    await channel.recordTestCallback(currentTest);
    expect((await channel.readTest(currentTest.test_id)).status).toBe('verified');
    expect((await channel.readConnection()).status).toBe('needs_enable');
    expect(await businessAnswerCount()).toBe(0);
    const currentProof = channel.currentProof();
    await channel.applyTrustedEnable(currentProof);
    const binding = await scene.bind(questionInput('Q-017', 17, proceedOptions(), []));
    await channel.submitHeld(feishuPrincipal, scene.command(feishuPrincipal, 'feishu-held', binding, { kind: 'option', option_id: 'A' }));
    expect((await channel.disableWhileHubIsUncertain()).status).toBe('draining');
    expect((await channel.receive(oldCallback)).disposition).toBe('audit_only');
    await channel.releaseAcceptedHubAnswerReadback();
    await scene.bind(questionInput('Q-other', 19, proceedOptions(), []));
    scene.db.prepare(`INSERT INTO resume_intents (
      work_id, generation, question_id, answer_event_id, phase, state, next_action, evidence_ref
    ) VALUES (?, ?, 'Q-other', 'hub:Q-other:19', 'answer', 'ready', 'judge', NULL)`).run(WORK_ID, GENERATION);
    expect((await channel.finishAfterReconciliation()).status).toBe('disabled');
    expect(await verifiedReceiptsFor('Q-017')).toHaveLength(1);
    expect(await attemptsForResumeKey('W-017', 2, 'Q-017', 'answer')).toBe(1);
    expect(await attemptsForResumeKey('W-017', 2, 'Q-other', 'answer')).toBe(0);
    expect(scene.db.prepare(`SELECT state FROM resume_intents WHERE question_id = 'Q-other'`).get()).toEqual({ state: 'ready' });
    expect(requiresChannelReconciliation({ permitRecorded: true, dispatchSeq: 1, terminal: false }, 1)).toBe(true);
    expect(requiresChannelReconciliation({ permitRecorded: true, dispatchSeq: 2, terminal: false }, 1)).toBe(false);
    expect(requiresChannelReconciliation({ permitRecorded: false, dispatchSeq: 1, terminal: false }, 1)).toBe(false);
    expect(requiresChannelReconciliation({ permitRecorded: true, dispatchSeq: null, terminal: false }, 1)).toBe(false);
    expect(requiresChannelReconciliation({ permitRecorded: true, dispatchSeq: 1, terminal: true }, 1)).toBe(false);
  } finally {
    scene.close();
  }
});

test('trusted disable drains a dispatch whose Hub response has not returned', async () => {
  const scene = await openScene({ crashAfterAccept: false });
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const channel = createFeishuChannel(scene.db, { now: scene.now, hub: scene.hub, encode: encodeHubAnswer, domain: DOMAIN });
  const gate = createAnswerGate(scene.db, {
    domain: DOMAIN, now: scene.now, encode: encodeHubAnswer,
    hub: {
      accept: async (questionId, cardId, body) => {
        const accepted = await scene.hub.accept(questionId, cardId, body);
        entered();
        await hold;
        return accepted;
      },
      read: (questionId) => scene.hub.read(questionId),
    },
  });
  const binding = await scene.bind(questionInput('Q-in-flight', 121, proceedOptions(), []));
  const answer = gate.submitAnswer(feishuPrincipal, scene.command(feishuPrincipal, 'in-flight', binding, { kind: 'option', option_id: 'A' }));
  try {
    await Promise.race([started, answer.then(() => { throw new Error('Dispatched without waiting for the Hub response'); })]);
    const stopped = await channel.disableTrusted({ accountId: 'owner', configRevision: 1, epoch: 1 });
    expect(stopped).toEqual({ status: 'draining', epoch: 2 });
    expect(scene.db.prepare('SELECT dispatch_seq,cutoff,terminal FROM channel_permits WHERE inbound_id=?').get('in-in-flight'))
      .toEqual({ dispatch_seq: 1, cutoff: 1, terminal: 0 });
    expect((await channel.finishAfterReconciliation()).status).toBe('draining');
    release();
    expect(await answer).toMatchObject({ validity: 'verified' });
    expect((await channel.finishAfterReconciliation()).status).toBe('disabled');
    expect(scene.db.prepare('SELECT terminal FROM channel_permits WHERE inbound_id=?').get('in-in-flight')).toEqual({ terminal: 1 });
  } finally {
    release();
    await answer.catch(() => {});
    scene.close();
  }
});

test('pairing codes stay hashed and every channel step rechecks the binding', async () => {
  const scene = await openScene({ crashAfterAccept: false });
  try {
    let current = new Date(NOW);
    const channel = createFeishuChannel(scene.db, {
      now: () => current,
      hub: scene.hub,
      encode: encodeHubAnswer,
      domain: DOMAIN,
    });
    await channel.configure();
    const first = await channel.createPairing();
    const second = await channel.createPairing();
    expect(first.code).not.toBe(second.code);
    expect(first.code.length).toBeGreaterThan(16);
    const stored = scene.db.prepare('SELECT code_hash, expires_at, status FROM channel_pairings WHERE pairing_id = ?').get(second.pairing_id) as {
      code_hash: string;
      expires_at: string;
      status: string;
    };
    expect(stored.code_hash).toBe(sha256(second.code));
    expect(JSON.stringify(scene.db.prepare('SELECT * FROM channel_pairings').all())).not.toContain(second.code);
    expect(new Date(stored.expires_at).getTime() - current.getTime()).toBe(PAIRING_TTL_MS);
    await channel.receivePairingMessage({ code: second.code, open_id: 'ou-owner', chat_id: 'oc-owner' });
    expect(() => channel.confirmPairing({ ...webPrincipal, account_id: 'other' }, second.pairing_id)).toThrow(/FORBIDDEN/);
    channel.confirmPairing(webPrincipal, second.pairing_id);
    expect((scene.db.prepare('SELECT status FROM channel_pairings WHERE pairing_id = ?').get(second.pairing_id) as { status: string }).status).toBe('consumed');
    expect(() => channel.confirmPairing(webPrincipal, second.pairing_id)).toThrow(/PAIRING_CONSUMED/);

    const expired = await channel.createPairing();
    current = new Date(current.getTime() + PAIRING_TTL_MS + 1);
    await expect(channel.receivePairingMessage({ code: expired.code, open_id: 'ou-owner', chat_id: 'oc-owner' })).rejects.toThrow(/PAIRING_EXPIRED/);

    current = new Date(NOW);
    const fresh = await channel.createPairing();
    await channel.receivePairingMessage({ code: fresh.code, open_id: 'ou-owner', chat_id: 'oc-owner' });
    channel.confirmPairing(webPrincipal, fresh.pairing_id);
    const preview = channel.createTest('ou-owner');
    channel.setConfigRevision(9);
    expect(() => channel.sendTest(preview)).toThrow(/BINDING_STALE/);
    channel.setConfigRevision(1);
    channel.sendTest(preview);
    channel.setConfigRevision(9);
    await expect(channel.recordTestCallback({
      test_id: preview.test_id,
      message_id: 'local-recheck',
      inbound_evidence: 'local-recheck',
    })).rejects.toThrow(/BINDING_STALE/);
    channel.setConfigRevision(1);
    await channel.recordTestCallback({
      test_id: preview.test_id,
      message_id: 'local-recheck',
      inbound_evidence: 'local-recheck',
    });
    const proof = channel.currentProof();
    channel.setConfigRevision(9);
    await expect(channel.applyTrustedEnable(proof)).rejects.toThrow(/BINDING_STALE/);
    channel.setConfigRevision(1);
    await channel.applyTrustedEnable(proof);
    expect((await channel.readConnection()).status).toBe('ready');
    const socketA = openSupervisedSocket('app-017', 'tenant-socket');
    const socketB = openSupervisedSocket('app-017', 'tenant-socket');
    expect(socketA).toBe(socketB);
  } finally {
    scene.close();
  }
});

test('revoking the mandate audits the accepted hub answer and web can answer another question', async () => {
  const scene = await openScene({ crashAfterAccept: false });
  try {
    const delegation = createDelegationApi(scene.db, webPrincipal, { now: scene.now, domain: DOMAIN });
    await delegation.openMandate({
      mandate_id: 'mandate-W-018',
      type_id: 'type-judge',
      actions: ['judge', 'collect', 'publish_pr'],
      resources: ['work'],
      effects: ['publish_pr'],
      domains: [DOMAIN],
      risk: 'low',
      level: 'L1',
      budget_micros: 5000,
      expires_at: '2027-01-01T00:00:00.000Z',
    });
    await delegation.openWork({
      work_id: 'W-018',
      generation: GENERATION,
      mandate_id: 'mandate-W-018',
      phase: 'judgment',
      next_action: 'judge',
      budget_micros: 5000,
    });
    await delegation.authorizeAction({
      work_id: 'W-018',
      generation: GENERATION,
      attempt_id: 'attempt-w018',
      phase: 'judgment',
      next_action: 'judge',
      allowed_effects: [],
      expires_at: '2026-11-18T00:00:00.000Z',
    });
    const channel = createFeishuChannel(scene.db, {
      now: scene.now,
      hub: scene.hub,
      encode: encodeHubAnswer,
      domain: DOMAIN,
    });
    const currentTest = await channel.prepareSentTest();
    await channel.recordTestCallback(currentTest);
    await channel.applyTrustedEnable(channel.currentProof());
    const binding = await scene.bind(questionInput('Q-017', 17, proceedOptions(), []));
    await channel.submitHeld(feishuPrincipal, scene.command(feishuPrincipal, 'feishu-revoked', binding, { kind: 'option', option_id: 'A' }));
    await delegation.stopMandate('mandate-W-017');
    expect((await channel.disableWhileHubIsUncertain()).status).toBe('draining');
    expect((await channel.receive({ inbound_id: 'old-card', epoch: 0, question_id: 'Q-017' })).disposition).toBe('audit_only');
    await channel.releaseAcceptedHubAnswerReadback();
    expect(await delegation.activeGrantCount(WORK_ID, GENERATION)).toBe(0);
    const rows = scene.db.prepare(`SELECT validity FROM answer_receipts WHERE question_id = 'Q-017'`).all() as { validity: string }[];
    expect(rows.some((row) => row.validity === 'verified')).toBe(false);
    expect(rows.some((row) => row.validity === 'audit_only')).toBe(true);
    const other = await scene.bind(questionInput('Q-018', 18, proceedOptions(), [], 'W-018'));
    const webReceipt = await scene.web.submitAnswer(
      webPrincipal,
      scene.command(webPrincipal, 'web-other', other, { kind: 'option', option_id: 'A' }),
    );
    expect(webReceipt.validity).toBe('verified');
    expect(webReceipt.question_id).toBe('Q-018');
  } finally {
    scene.close();
  }
});

test('custom-replacement', async () => {
  const scene = await openScene({ crashAfterAccept: false });
  try {
    const original = await scene.bind(questionInput('Q-017', 17, proceedOptions(), [
      {
        includes: 'OUT_OF_SCOPE',
        disposition: 'clarification_required',
        reason_code: 'OUT_OF_SCOPE',
        next_action: null,
        difference: '请求超出原授权范围',
        missing: [],
        collection_id: null,
        expected_material: null,
      },
    ]));
    const missingCard = await scene.bind(questionInput('Q-018', 18, proceedOptions(), [
      {
        includes: 'MISSING_INPUT',
        disposition: 'clarification_required',
        reason_code: 'MISSING_INPUT',
        next_action: null,
        difference: null,
        missing: ['预算上限'],
        collection_id: null,
        expected_material: null,
      },
    ]));
    const basis = scene.basisHash();
    const scope = scene.scopeHash();
    const first = await scene.web.submitAnswer(
      webPrincipal,
      scene.command(webPrincipal, 'web-scope', original, { kind: 'custom', raw_text: 'OUT_OF_SCOPE 改成发布到生产' }),
    );
    const again = await scene.web.submitAnswer(
      webPrincipal,
      scene.command(webPrincipal, 'web-scope-again', original, { kind: 'custom', raw_text: 'OUT_OF_SCOPE 再提一次扩权' }),
    );
    expect(first.disposition).toBe('clarification_required');
    expect(first.reason_code).toBe('OUT_OF_SCOPE');
    expect(first.difference).toBe('请求超出原授权范围');
    expect(first.successor_question_id).toBeTruthy();
    expect(again.successor_question_id).toBe(first.successor_question_id);
    expect(scene.successorCount('Q-017')).toBe(1);
    const successor = scene.question(first.successor_question_id ?? '');
    expect(successor.work_id).toBe(WORK_ID);
    expect(successor.judgment_basis_hash).toBe(basis);
    const late = await scene.web.submitAnswer(
      webPrincipal,
      scene.command(webPrincipal, 'web-late', original, { kind: 'option', option_id: 'A' }),
    );
    expect(late.validity).toBe('rejected');
    expect(scene.scopeHash()).toBe(scope);
    expect(scene.basisHash()).toBe(basis);
    expect(scene.workId(WORK_ID)).toBe(WORK_ID);
    expect(await scene.hub.list('Q-017')).toHaveLength(0);
    expect(scene.encodeCalls).toBe(0);

    const asked = await scene.web.submitAnswer(
      webPrincipal,
      scene.command(webPrincipal, 'web-missing', missingCard, { kind: 'custom', raw_text: 'MISSING_INPUT 还缺预算上限' }),
    );
    expect(asked.reason_code).toBe('MISSING_INPUT');
    expect(asked.missing).toEqual(['预算上限']);
    expect(asked.question_id).toBe('Q-018');
    expect(scene.question('Q-018').status).toBe('open');
    const follow = await scene.web.submitAnswer(
      webPrincipal,
      scene.command(webPrincipal, 'web-follow', missingCard, { kind: 'option', option_id: 'A' }),
    );
    expect(follow.validity).toBe('verified');
    expect(follow.question_id).toBe('Q-018');
    expect(scene.question('Q-018').work_id).toBe(WORK_ID);
    expect(scene.basisHash()).toBe(basis);
    expect(scene.scopeHash()).toBe(scope);
    expect(scene.encodeCalls).toBe(1);
  } finally {
    scene.close();
  }
});

test('feishu enable and disable are registered on inspect, validate, apply, and recheck', async () => {
  const scene = await openScene({ crashAfterAccept: false });
  try {
    registerFeishuSettings(() => ({ db: scene.db, now: scene.now, hub: scene.hub }));
    expect(settingsOperations().slice().sort()).toEqual(['apply', 'inspect', 'recheck', 'validate']);
    const channel = createFeishuChannel(scene.db, {
      now: scene.now,
      hub: scene.hub,
      encode: encodeHubAnswer,
      domain: DOMAIN,
    });
    const current = await channel.prepareSentTest();
    await channel.recordTestCallback(current);
    const proof = channel.currentProof();
    expect(await runSettingsOperation('validate', { action: 'enable', connection_id: 'conn-017', proof })).toEqual({ valid: true });
    expect(await runSettingsOperation('apply', { action: 'enable', connection_id: 'conn-017', proof })).toEqual({
      effects: [{ item: 'enable', effect: 'ready' }],
    });
    expect((await channel.readConnection()).status).toBe('ready');
    expect(await runSettingsOperation('inspect', { connection_id: 'conn-017' })).toEqual({
      records: [{ target: 'feishu', observed: 'ready' }],
    });
    scene.db.prepare(`INSERT INTO channel_permits (
      permit_id, connection_id, inbound_id, question_id, account_id, permit_recorded, dispatch_seq, terminal,
      incarnation, epoch, config_revision, binding_revision, cutoff, disposition, intent_id, schema_version, created_at
    ) VALUES ('permit-settings', 'conn-017', 'in-settings', 'Q-settings', 'owner', 1, 1, 0, 1, 1, 1, 1, NULL, NULL, NULL, '1.0', ?)`).run(NOW);
    expect(await runSettingsOperation('apply', { action: 'disable', connection_id: 'conn-017' })).toEqual({
      effects: [{ item: 'disable', effect: 'draining' }],
    });
    const checked = await runSettingsOperation('recheck', { connection_id: 'conn-017' }) as { ok: boolean; status: string };
    expect(checked.ok).toBe(true);
    expect(checked.status).toBe('draining');
  } finally {
    clearSettingsOperations();
    scene.close();
  }
});

test('a repeated pairing request returns the original pairing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t10-pair-'));
  const databasePath = join(dir, 'patrick.sqlite');
  const credentialDirectory = join(dir, 'credentials');
  const db = openDatabase(databasePath);
  try {
    const now = () => new Date(NOW);
    const store = createCredentialStore(credentialDirectory, now);
    issueBootstrapTicket(db, { accountId: 'owner' }, now);
    const session = issueCallerSession(db, {
      accountId: 'owner',
      callerId: 'web',
      domain: 'personal',
      permissions: ['owner'],
    }, now, store);
    const app = createApp({ databasePath, credentialDirectory, now });
    expect(settingsOperations().slice().sort()).toEqual(['apply', 'inspect', 'recheck', 'validate']);
    const headers = { authorization: session.authorization, origin: ORIGIN, 'content-type': 'application/json' };
    seedFeishuApiProbe(db);
    const payload = {};
    const body = {
      client_request_id: 'pair-once',
      expected_revision: null,
      payload_hash: sha256(canonicalPayload(payload)),
      payload,
    };
    const created = await app.request('/api/v1/channels/feishu/bindings', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    expect(created.status).toBe(202);
    const createdBody = await created.json() as { command_id: string; state: string; receipt_url: string };
    const replay = await app.request('/api/v1/channels/feishu/bindings', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(createdBody);
    expect(db.prepare('SELECT COUNT(*) AS n FROM channel_pairings').get()).toEqual({ n: 1 });
    const inspection = await app.request('/api/v1/channels/feishu/inspections', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, client_request_id: 'inspect-once' }),
    });
    expect(inspection.status).toBe(202);
    const validation = await app.request('/api/v1/channels/feishu/validations', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, client_request_id: 'validate-once' }),
    });
    expect(validation.status).toBe(202);
  } finally {
    clearSettingsOperations();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed pairing write rolls back the pairing and command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t10-pair-rollback-'));
  const databasePath = join(dir, 'patrick.sqlite');
  const credentialDirectory = join(dir, 'credentials');
  const db = openDatabase(databasePath);
  try {
    const now = () => new Date(NOW);
    const store = createCredentialStore(credentialDirectory, now);
    issueBootstrapTicket(db, { accountId: 'owner' }, now);
    const session = issueCallerSession(db, {
      accountId: 'owner',
      callerId: 'web',
      domain: 'personal',
      permissions: ['owner'],
    }, now, store);
    const app = createApp({ databasePath, credentialDirectory, now });
    const headers = { authorization: session.authorization, origin: ORIGIN, 'content-type': 'application/json' };
    seedFeishuApiProbe(db);
    db.exec(`CREATE TRIGGER abort_pairing_command BEFORE INSERT ON command_records
      WHEN NEW.operation = 'createFeishuBinding'
      BEGIN SELECT RAISE(ABORT, 'pairing_command_write_failed'); END`);
    const payload = {};
    const body = {
      client_request_id: 'pair-rollback',
      expected_revision: null,
      payload_hash: sha256(canonicalPayload(payload)),
      payload,
    };
    const failed = await app.request('/api/v1/channels/feishu/bindings', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    expect(failed.status).toBe(503);
    expect(db.prepare('SELECT COUNT(*) AS n FROM channel_pairings').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM command_inbox').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT current_pairing_id FROM channel_connections LIMIT 1').get()).toEqual({ current_pairing_id: null });
  } finally {
    clearSettingsOperations();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale send does not record the command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t10-send-stale-'));
  const databasePath = join(dir, 'patrick.sqlite');
  const credentialDirectory = join(dir, 'credentials');
  const db = openDatabase(databasePath);
  try {
    const now = () => new Date(NOW);
    const store = createCredentialStore(credentialDirectory, now);
    issueBootstrapTicket(db, { accountId: 'owner' }, now);
    const session = issueCallerSession(db, {
      accountId: 'owner',
      callerId: 'web',
      domain: 'personal',
      permissions: ['owner'],
    }, now, store);
    const app = createApp({ databasePath, credentialDirectory, now });
    const headers = { authorization: session.authorization, origin: ORIGIN, 'content-type': 'application/json' };
    seedFeishuApiProbe(db);
    const bindPayload = {};
    await app.request('/api/v1/channels/feishu/bindings', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        client_request_id: 'bind-send-stale',
        expected_revision: null,
        payload_hash: sha256(canonicalPayload(bindPayload)),
        payload: bindPayload,
      }),
    });
    const pairing = db.prepare('SELECT current_pairing_id AS pairing_id FROM channel_connections LIMIT 1').get() as { pairing_id: string };
    db.prepare(`UPDATE channel_pairings SET status = 'candidate', candidate_open_id = ?, candidate_chat_id = ? WHERE pairing_id = ?`).run(
      'ou-owner',
      'oc-owner',
      pairing.pairing_id,
    );
    const confirmPayload = {};
    await app.request(`/api/v1/channels/feishu/bindings/${pairing.pairing_id}/confirm`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        client_request_id: 'confirm-send-stale',
        expected_revision: null,
        payload_hash: sha256(canonicalPayload(confirmPayload)),
        payload: confirmPayload,
      }),
    });
    const testPayload = { destination: 'ou-owner' };
    await app.request('/api/v1/channels/feishu/tests', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        client_request_id: 'test-send-stale',
        expected_revision: null,
        payload_hash: sha256(canonicalPayload(testPayload)),
        payload: testPayload,
      }),
    });
    const test = db.prepare('SELECT current_test_id AS test_id FROM channel_connections LIMIT 1').get() as { test_id: string };
    const row = db.prepare('SELECT preview_hash, destination FROM channel_tests WHERE test_id = ?').get(test.test_id) as {
      preview_hash: string;
      destination: string;
    };
    db.prepare('UPDATE channel_connections SET config_revision = 9 WHERE account_id = ?').run('owner');
    const sendPayload = { test_id: test.test_id, preview_hash: row.preview_hash, destination: row.destination };
    const sendBody = {
      client_request_id: 'send-stale-once',
      expected_revision: null,
      payload_hash: sha256(canonicalPayload(sendPayload)),
      payload: sendPayload,
    };
    const failed = await app.request(`/api/v1/channels/feishu/tests/${test.test_id}/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify(sendBody),
    });
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({ params: { reason: 'stale_test_preview' } });
    expect(db.prepare('SELECT COUNT(*) AS n FROM command_inbox WHERE client_request_id = ?').get('send-stale-once')).toEqual({ n: 0 });
    expect(db.prepare('SELECT status FROM channel_tests WHERE test_id = ?').get(test.test_id)).toEqual({ status: 'previewed' });
    db.prepare('UPDATE channel_connections SET config_revision = 1 WHERE account_id = ?').run('owner');
    const accepted = await app.request(`/api/v1/channels/feishu/tests/${test.test_id}/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify(sendBody),
    });
    expect(accepted.status).toBe(503);
    expect(await accepted.json()).toMatchObject({ params: { reason: 'transport_not_configured' } });
    expect(db.prepare('SELECT status FROM channel_tests WHERE test_id = ?').get(test.test_id)).toEqual({ status: 'previewed' });
  } finally {
    clearSettingsOperations();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

type Scene = {
  db: SqliteDatabase;
  web: AnswerGate;
  feishu: AnswerGate;
  hub: LocalHubPort;
  reopenHub: () => void;
  encodeCalls: number;
  prSends: number;
  now: () => Date;
  bind: (input: BindQuestionInput) => Promise<QuestionBinding>;
  command: (principal: Principal, requestId: string, binding: QuestionBinding, answer: CardAnswer) => AnswerCommand;
  consumeNative: (questionId: string) => Promise<void>;
  calls: (workId: string) => { model: number; retry: number };
  restart: () => Promise<void>;
  drain: () => void;
  verified: (questionId: string) => Promise<{ receipt_id: string }[]>;
  attempts: (workId: string, generation: number, questionId: string, phase: ResumeKey['phase']) => number;
  stageCount: (kind: string) => number;
  key: (questionId: string, phase: ResumeKey['phase']) => ResumeKey;
  basisHash: () => string;
  scopeHash: () => string;
  successorCount: (questionId: string) => number;
  question: (questionId: string) => { work_id: string; status: string; judgment_basis_hash: string };
  workId: (workId: string) => string;
  close: () => void;
};

async function openScene(options: { crashAfterAccept: boolean }): Promise<Scene> {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t10-'));
  const databasePath = join(dir, 'patrick.sqlite');
  let db = openDatabase(databasePath);
  const peer = openDatabase(databasePath);
  const hubPath = join(dir, 'hub-answers.sqlite');
  let hub = createLocalHubPort(hubPath);
  let encodeCalls = 0;
  const encode = (answer: { kind: 'choice'; index: number } | { kind: 'custom'; raw_text: string }) => {
    encodeCalls += 1;
    return encodeHubAnswer(answer);
  };
  let armed = options.crashAfterAccept;
  const afterHubAccept = () => {
    if (!armed) return;
    armed = false;
    throw new Error('RECEIPT_LOST');
  };
  const now = () => new Date(NOW);
  const gateOptions = {
    domain: DOMAIN,
    now,
    hub,
    encode,
    afterHubAccept: options.crashAfterAccept ? afterHubAccept : undefined,
  };
  let web = createAnswerGate(db, gateOptions);
  const feishu = createAnswerGate(peer, gateOptions);
  const admitted = await admit(db, now);
  let modelCalls = 0;
  let retryCalls = 0;

  const scene: Scene = {
    get db() {
      return db;
    },
    get web() {
      return web;
    },
    feishu,
    get hub() {
      return hub;
    },
    reopenHub() {
      hub.close();
      hub = createLocalHubPort(hubPath);
    },
    get encodeCalls() {
      return encodeCalls;
    },
    get prSends() {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM stage_events WHERE work_id = ? AND kind = 'pr.sent'`).get(WORK_ID) as { n: number };
      return row.n;
    },
    now,
    bind: (input) => web.bindQuestion(webPrincipal, input),
    command: (principal, requestId, binding, answer) => commandFor(principal, requestId, binding, answer),
    async consumeNative(questionId: string) {
      const found = await hub.read(questionId);
      const key: ResumeKey = {
        work_id: WORK_ID,
        generation: GENERATION,
        question_id: questionId,
        answer_event_id: found?.answer_event_id ?? 'missing',
        phase: 'answer',
      };
      const port: ContinuationPort = {
        claimContinuation: (resumeKey, attemptId) => {
          const result = claimContinuation(db, webPrincipal, DOMAIN, resumeKey, attemptId, now());
          if (result.status !== 'claimed') return result;
          return {
            status: 'claimed',
            grant: {
              grant_id: result.grant.grant_id,
              subject_kind: 'work',
              work_id: result.grant.work_id,
              generation: result.grant.generation,
              phase: resumeKey.phase,
              answer_event_id: resumeKey.answer_event_id,
            },
          };
        },
      };
      const settlement = await settleNativeAnswer(port, key, 'attempt-native');
      if (settlement.claim.status === 'claimed') {
        modelCalls += 1;
        retryCalls += 1;
      }
    },
    calls(workId: string) {
      if (workId !== WORK_ID) return { model: 0, retry: 0 };
      return { model: modelCalls, retry: retryCalls };
    },
    async restart() {
      if (db.open) db.close();
      if (peer.open) peer.close();
      hub.close();
      hub = createLocalHubPort(hubPath);
      db = openDatabase(databasePath);
      web = createAnswerGate(db, { domain: DOMAIN, now, hub, encode });
      const intents = db.prepare('SELECT intent_id FROM answer_intents').all() as { intent_id: string }[];
      for (const row of intents) await web.recoverAnswer(row.intent_id);
    },
    drain() {
      const rows = db.prepare(`SELECT work_id, generation, question_id, answer_event_id, phase
        FROM resume_intents WHERE state = 'ready'`).all() as ResumeKey[];
      for (const row of rows) claimContinuation(db, webPrincipal, DOMAIN, row, `attempt-${row.phase}`, now());
    },
    async verified(questionId: string) {
      return db.prepare(`SELECT receipt_id FROM answer_receipts WHERE question_id = ? AND validity = 'verified'`).all(questionId) as {
        receipt_id: string;
      }[];
    },
    attempts(workId, generation, questionId, phase) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM resume_intents
        WHERE work_id = ? AND generation = ? AND question_id = ? AND phase = ? AND state = 'claimed'`).get(
        workId,
        generation,
        questionId,
        phase,
      ) as { n: number };
      return row.n;
    },
    stageCount(kind: string) {
      const row = db.prepare('SELECT COUNT(*) AS n FROM stage_events WHERE work_id = ? AND kind = ?').get(WORK_ID, kind) as { n: number };
      return row.n;
    },
    key(questionId, phase) {
      const row = db.prepare(`SELECT answer_event_id FROM resume_intents
        WHERE work_id = ? AND generation = ? AND question_id = ? AND phase = ?`).get(WORK_ID, GENERATION, questionId, phase) as {
        answer_event_id: string;
      } | undefined;
      const hubRow = hubReadSync(questionId);
      return {
        work_id: WORK_ID,
        generation: GENERATION,
        question_id: questionId,
        answer_event_id: row?.answer_event_id ?? hubRow,
        phase,
      };
    },
    basisHash() {
      const row = db.prepare('SELECT basis_hash FROM judgment_bases WHERE work_id = ? AND generation = ?').get(WORK_ID, GENERATION) as {
        basis_hash: string;
      };
      return row.basis_hash;
    },
    scopeHash() {
      const row = db.prepare('SELECT scope_hash FROM mandates WHERE mandate_id = ?').get(admitted.mandateId) as { scope_hash: string };
      return row.scope_hash;
    },
    successorCount(questionId: string) {
      const row = db.prepare('SELECT COUNT(*) AS n FROM question_replacements WHERE question_id = ?').get(questionId) as { n: number };
      return row.n;
    },
    question(questionId: string) {
      const row = db.prepare(`SELECT work_id, status, judgment_basis_hash FROM question_bindings
        WHERE question_id = ? ORDER BY question_version DESC LIMIT 1`).get(questionId) as {
        work_id: string;
        status: string;
        judgment_basis_hash: string;
      };
      return row;
    },
    workId(workId: string) {
      const row = db.prepare('SELECT work_id FROM work_generations WHERE work_id = ? AND generation = ?').get(workId, GENERATION) as {
        work_id: string;
      };
      return row.work_id;
    },
    close() {
      hub.close();
      if (db.open) db.close();
      if (peer.open) peer.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };

  function hubReadSync(questionId: string): string {
    return `pending:${questionId}`;
  }

  db.prepare(`INSERT INTO channel_connections (
    connection_id, account_id, data_domain, app_id, tenant_key, credential_ref, credential_version,
    config_revision, channel_incarnation, connection_epoch, binding_revision, current_pairing_id,
    current_test_id, owner_open_id, chat_id, status, transport_mode, reason_code, cutoff_seq,
    schema_version, created_at, updated_at
  ) VALUES (
    'conn-017', 'owner', ?, 'app-017', 'tenant-017', 'cred-017', 1,
    1, 1, 1, 1, NULL,
    NULL, 'ou-owner', 'oc-owner', 'ready', 'active', NULL, NULL,
    '1.0', ?, ?
  )`).run(DOMAIN, NOW, NOW);
  return scene;
}

function commandFor(principal: Principal, requestId: string, binding: QuestionBinding, answer: CardAnswer): AnswerCommand {
  const payload = {
    work_id: binding.work_id,
    generation: binding.generation,
    question_id: binding.question_id,
    question_version: binding.question_version,
    proposal_revision: binding.proposal_revision,
    options_hash: binding.options_hash,
    answer,
  };
  return {
    client_request_id: requestId,
    expected_revision: binding.proposal_revision,
    payload_hash: sha256(canonicalPayload(payload as unknown as Json)),
    entry: principal.caller_id === 'feishu' ? 'feishu' : 'web',
    connection_id: principal.caller_id === 'feishu' ? 'conn-017' : undefined,
    inbound_id: principal.caller_id === 'feishu' ? `in-${requestId}` : undefined,
    payload,
  };
}

function questionInput(
  questionId: string,
  hubCardId: number,
  options: BindQuestionInput['options'],
  customRules: BindQuestionInput['custom_rules'],
  workId = WORK_ID,
): BindQuestionInput {
  return {
    question_id: questionId,
    question_version: 3,
    work_id: workId,
    generation: GENERATION,
    proposal_revision: 8,
    hub_card_id: hubCardId,
    custom_allowed: true,
    options,
    custom_rules: customRules,
  };
}

function proceedOptions(): BindQuestionInput['options'] {
  return [
    {
      option_id: 'A',
      index: 0,
      label: '方案 A',
      disposition: 'proceed',
      reason_code: null,
      next_action: 'judge',
      difference: null,
      missing: [],
      collection_id: null,
      expected_material: null,
    },
    {
      option_id: 'B',
      index: 1,
      label: '方案 B',
      disposition: 'proceed',
      reason_code: null,
      next_action: 'judge',
      difference: null,
      missing: [],
      collection_id: null,
      expected_material: null,
    },
  ];
}

function collectOption(): BindQuestionInput['options'][number] {
  return {
    option_id: 'collect',
    index: 0,
    label: '先补证',
    disposition: 'proceed',
    reason_code: null,
    next_action: 'collect_evidence',
    difference: null,
    missing: [],
    collection_id: 'col-017',
    expected_material: 'material-017',
  };
}

async function admit(db: SqliteDatabase, now: () => Date) {
  const delegation = createDelegationApi(db, webPrincipal as AdmissionPrincipal, { now, domain: DOMAIN });
  await delegation.registerMandateType({
    type_id: 'type-judge',
    actions: ['judge', 'collect', 'publish_pr'],
    resources: ['work'],
    effects: ['publish_pr'],
    domains: [DOMAIN],
    risk: 'low',
    level: 'L1',
    budget_micros: 5000,
    config_version: 1,
  });
  const mandate = await delegation.openMandate({
    mandate_id: 'mandate-W-017',
    type_id: 'type-judge',
    actions: ['judge', 'collect', 'publish_pr'],
    resources: ['work'],
    effects: ['publish_pr'],
    domains: [DOMAIN],
    risk: 'low',
    level: 'L1',
    budget_micros: 5000,
    expires_at: '2027-01-01T00:00:00.000Z',
  });
  await delegation.setCapability({
    profile_id: 'cap-W-017',
    level: 'L2',
    actions: ['judge', 'collect', 'publish_pr'],
    report_id: 'report-1',
    report_version: 1,
    config_version: 1,
  });
  await delegation.ensureJudgmentPolicy();
  await delegation.openWork({
    work_id: WORK_ID,
    generation: GENERATION,
    mandate_id: mandate.mandate_id,
    phase: 'judgment',
    next_action: 'judge',
    budget_micros: 5000,
  });
  await delegation.authorizeAction({
    work_id: WORK_ID,
    generation: GENERATION,
    attempt_id: 'attempt-1',
    phase: 'judgment',
    next_action: 'judge',
    allowed_effects: [],
    expires_at: '2026-11-18T00:00:00.000Z',
  });
  const stopPort = createStopFixture();
  stopPort.report(WORK_ID, GENERATION, { process_tree_stopped: true, effects_reconciled: true });
  await createWorkControlApi(db, webPrincipal, { now, stopPort }).applyWorkControl(webPrincipal, {
    work_id: WORK_ID,
    type: 'stop',
    generation: GENERATION,
    expected_revision: 0,
  });
  return { mandateId: mandate.mandate_id };
}

function seedFeishuApiProbe(db: SqliteDatabase) {
  db.prepare(`INSERT INTO channel_connections (
    connection_id, account_id, data_domain, app_id, tenant_key, credential_ref, credential_version,
    config_revision, channel_incarnation, connection_epoch, binding_revision, status, transport_mode,
    schema_version, created_at, updated_at
  ) VALUES (?, 'owner', 'personal', 'cli_fixture', 'tenant_fixture', 'cred_fixture', 1,
    1, 1, 1, 1, 'needs_binding', 'probe', '1.0', ?, ?)`).run(`conn_${sha256('owner').slice(0, 12)}`, NOW, NOW);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
