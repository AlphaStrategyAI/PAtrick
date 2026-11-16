import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { canonicalPayload, type Json } from '../../packages/contracts/src/envelope.js';
import { createAnswerGate, type Principal } from '../../packages/domain/src/answer-gate.js';
import { createDelegationApi } from '../../packages/domain/src/delegation.js';
import { createLocalHubPort, encodeHubAnswer } from '../../packages/integrations/autoloop/answers.js';
import { probeDeferredCard } from '../../packages/integrations/feishu/connection.js';
import { openDatabase } from '../../packages/storage/src/database.js';

const MATRIX = fileURLToPath(new URL('../../fixtures/contracts/admission-matrix.json', import.meta.url));
const NOW = '2026-11-17T02:00:00.000Z';

test('feishu deferred card is blocked without app credentials and the web entry remains', async () => {
  const probe = probeDeferredCard();
  expect(probe.status).toBe('blocked');
  expect(probe.messageId).toBeNull();
  expect(probe.evidenceSha256).toBe(sha256(probe.observation));
  expect(probe.observation).toContain('missing Feishu app credential');
  expect(probe.observation).toContain('ERR_MODULE_NOT_FOUND');
  expect(probe.observation).toContain('channel blocked');
  expect(probe.observation).toContain('web entry remains');
  expect(probe.observation).toContain('message_id: none');
  expect(probe.observation).not.toMatch(/om_[A-Za-z0-9]{8,}/);
  expect(probe.command).toContain('--input-type=module');

  const matrix = JSON.parse(readFileSync(MATRIX, 'utf8')) as {
    feishu_deferred_card: {
      upstream: { sdk: string; version: string };
      status: string;
      command: string;
      observation: string;
      evidenceSha256: string | null;
    };
  };
  matrix.feishu_deferred_card = {
    upstream: matrix.feishu_deferred_card.upstream,
    status: 'blocked',
    command: probe.command,
    observation: probe.observation,
    evidenceSha256: probe.evidenceSha256,
  };
  writeFileSync(MATRIX, `${JSON.stringify(matrix, null, 2)}\n`);
  const stored = JSON.parse(readFileSync(MATRIX, 'utf8')).feishu_deferred_card as {
    status: string;
    command: string;
    observation: string;
    evidenceSha256: string;
  };
  expect(stored.status).toBe('blocked');
  expect(stored.command).toBe(probe.command);
  expect(stored.observation).toBe(probe.observation);
  expect(stored.evidenceSha256).toBe(sha256(stored.observation));
  expect(stored.observation).toContain('channel blocked');
  expect(stored.observation).toContain('web entry remains');

  const receipt = await submitWebAnswer();
  expect(receipt.validity).toBe('verified');
  expect(receipt.question_id).toBe('Q-017');
});

async function submitWebAnswer() {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t10-admit-'));
  const db = openDatabase(join(dir, 'patrick.sqlite'));
  const hub = createLocalHubPort(join(dir, 'hub-answers.sqlite'));
  try {
    const now = () => new Date(NOW);
    const principal: Principal = {
      account_id: 'owner',
      caller_id: 'web',
      auth_epoch: 1,
      domains: ['product'],
      operations: ['owner', 'questions.answer'],
    };
    const delegation = createDelegationApi(db, principal, { now, domain: 'product' });
    await delegation.registerMandateType({
      type_id: 'type-judge',
      actions: ['judge'],
      resources: ['work'],
      effects: [],
      domains: ['product'],
      risk: 'low',
      level: 'L1',
      budget_micros: 5000,
      config_version: 1,
    });
    await delegation.openMandate({
      mandate_id: 'mandate-web',
      type_id: 'type-judge',
      actions: ['judge'],
      resources: ['work'],
      effects: [],
      domains: ['product'],
      risk: 'low',
      level: 'L1',
      budget_micros: 5000,
      expires_at: '2027-01-01T00:00:00.000Z',
    });
    await delegation.setCapability({
      profile_id: 'cap-web',
      level: 'L2',
      actions: ['judge'],
      report_id: 'report-1',
      report_version: 1,
      config_version: 1,
    });
    await delegation.ensureJudgmentPolicy();
    await delegation.openWork({
      work_id: 'W-017',
      generation: 2,
      mandate_id: 'mandate-web',
      phase: 'judgment',
      next_action: 'judge',
      budget_micros: 5000,
    });
    await delegation.authorizeAction({
      work_id: 'W-017',
      generation: 2,
      attempt_id: 'attempt-web',
      phase: 'judgment',
      next_action: 'judge',
      allowed_effects: [],
      expires_at: '2026-11-18T00:00:00.000Z',
    });
    const gate = createAnswerGate(db, {
      domain: 'product',
      now,
      hub,
      encode: encodeHubAnswer,
    });
    const options = [{
      option_id: 'A',
      index: 0,
      label: '方案 A',
      disposition: 'proceed' as const,
      reason_code: null,
      next_action: 'judge',
      difference: null,
      missing: [],
      collection_id: null,
      expected_material: null,
    }];
    const binding = await gate.bindQuestion(principal, {
      question_id: 'Q-017',
      question_version: 3,
      work_id: 'W-017',
      generation: 2,
      proposal_revision: 8,
      hub_card_id: 17,
      custom_allowed: false,
      options,
      custom_rules: [],
    });
    const payload = {
      work_id: 'W-017',
      generation: 2,
      question_id: 'Q-017',
      question_version: 3,
      proposal_revision: 8,
      options_hash: binding.options_hash,
      answer: { kind: 'option' as const, option_id: 'A' },
    };
    return await gate.submitAnswer(principal, {
      client_request_id: 'web-remains',
      expected_revision: 8,
      payload_hash: sha256(canonicalPayload(payload as unknown as Json)),
      entry: 'web',
      payload,
    });
  } finally {
    hub.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
