import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import { canonicalPayload, type Json } from '../../packages/contracts/src/envelope.js';
import { createAnswerGate, type Principal } from '../../packages/domain/src/answer-gate.js';
import { createDelegationApi } from '../../packages/domain/src/delegation.js';
import { createLocalHubPort, encodeHubAnswer } from '../../packages/integrations/autoloop/answers.js';
import { probeDeferredCard } from '../../packages/integrations/feishu/connection.js';
import { openDatabase } from '../../packages/storage/src/database.js';

const MATRIX = fileURLToPath(new URL('../../fixtures/contracts/admission-matrix.json', import.meta.url));
const NOW = '2026-11-17T02:00:00.000Z';

const credentialEnvironment = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'LARK_APP_ID', 'LARK_APP_SECRET'] as const;

test.each(['absent', 'present'] as const)(
  'feishu deferred card is blocked without app credentials and the web entry remains with %s ambient credentials', async (ambient) => {
    const directory = mkdtempSync(join(tmpdir(), 'patrick-t10-probe-'));
    try {
      for (const key of credentialEnvironment) {
        vi.stubEnv(key, ambient === 'present' ? `synthetic-test-${key}` : undefined);
      }
      const beforeProbe = credentialEnvironment.map((key) => process.env[key]);
      let probe: ReturnType<typeof probeDeferredCard>;
      const previousFile = process.env.PATRICK_FEISHU_CREDENTIALS_FILE;
      try {
        for (const key of credentialEnvironment) delete process.env[key];
        process.env.PATRICK_FEISHU_CREDENTIALS_FILE = join(directory, 'absent.env');
        probe = probeDeferredCard();
      } finally {
        if (previousFile === undefined) delete process.env.PATRICK_FEISHU_CREDENTIALS_FILE;
        else process.env.PATRICK_FEISHU_CREDENTIALS_FILE = previousFile;
        for (const [index, key] of credentialEnvironment.entries()) {
          const previous = beforeProbe[index];
          if (previous === undefined) delete process.env[key];
          else process.env[key] = previous;
        }
      }
      expect(credentialEnvironment.every((key, index) => process.env[key] === beforeProbe[index])).toBe(true);
      expect(probe.status).toBe('blocked');
      expect(probe.messageId).toBeNull();
      expect(probe.evidenceSha256).toBe(sha256(probe.observation));
      expect(probe.observation).toMatch(/^exit: 1$/m);
      expect(probe.observation).toContain('missing Feishu app credential');
      const sdk = /^sdk-exit: (0|1)\n([\s\S]*?)\nchannel blocked$/m.exec(probe.observation);
      expect(sdk, 'the actual SDK import must have an observed exit and matching diagnostic').not.toBeNull();
      if (sdk![1] === '0') expect(sdk![2].trim()).toBe('');
      else expect(sdk![2].trim()).not.toBe('');
      expect(probe.observation).toContain('channel blocked');
      expect(probe.observation).toContain('web entry remains');
      expect(probe.observation).toContain('message_id: none');
      expect(probe.observation).not.toMatch(/om_[A-Za-z0-9]{8,}/);
      expect(probe.command).toContain('--input-type=module');

      const recordedMatrix = readFileSync(MATRIX, 'utf8');
      const temporaryMatrix = join(directory, 'admission-matrix.json');
      writeFileSync(temporaryMatrix, recordedMatrix);
      const matrix = JSON.parse(readFileSync(temporaryMatrix, 'utf8')) as {
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
      writeFileSync(temporaryMatrix, `${JSON.stringify(matrix, null, 2)}\n`);
      const stored = JSON.parse(readFileSync(temporaryMatrix, 'utf8')).feishu_deferred_card as {
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
      expect(sha256(readFileSync(MATRIX, 'utf8'))).toBe(sha256(recordedMatrix));

      const receipt = await submitWebAnswer();
      expect(receipt.validity).toBe('verified');
      expect(receipt.question_id).toBe('Q-017');
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

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
    const receipt = await gate.submitAnswer(principal, {
      client_request_id: 'web-remains',
      expected_revision: 8,
      payload_hash: sha256(canonicalPayload(payload as unknown as Json)),
      entry: 'web',
      payload,
    });
    expect(await hub.read('Q-017')).toMatchObject({ cardId: 17, state: 'answered', body: { choice: 0 } });
    return receipt;
  } finally {
    hub.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the recorded Feishu round trip reads back defer and a later decision', () => {
  const stored = JSON.parse(readFileSync(MATRIX, 'utf8')).feishu_deferred_card as {
    status: string;
    observation: string;
    evidenceSha256: string;
    upstream: { sdk: string; version: string };
  };
  expect(stored.upstream).toEqual({ sdk: '@larksuiteoapi/node-sdk', version: '1.76.0' });
  expect(stored.status).toBe('verified');
  expect(stored.evidenceSha256).toBe(sha256(stored.observation));
  expect(stored.observation).toContain('pairing_message_id: om_x100b7f34326608a8b1eea24cd689a30');
  expect(stored.observation).toContain('outbound_message_id: om_x100b7f34ccd56ca0df690c6dfae28a9');
  expect(stored.observation).toContain('outbound_readback: match');
  expect(stored.observation).toContain('defer_callback_message_id: om_x100b7f34cce104a0dd62f48ae5e98fa');
  expect(stored.observation).toContain('defer_action: defer');
  expect(stored.observation).toContain('answer_after_defer_message_id: om_x100b7f34c085acb0df234097f84ee4c');
  expect(stored.observation).toContain('answer_after_defer_action: option-a');
  expect(stored.observation).toContain('answer_card_distinct_from_defer: true');
  expect(stored.observation).toContain('business_facts: none');
  expect(stored.observation).toContain('enable_status: ready');
  expect(stored.observation).toContain('enable_test_message_id: om_x100b7f34f81f97ecdf7cfcb2b645e6e');
  expect(stored.observation).toContain('enable_readback: match');
  expect(stored.observation).not.toMatch(/app_secret|FEISHU_APP_SECRET|ou_|oc_|tenant_key/i);
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
