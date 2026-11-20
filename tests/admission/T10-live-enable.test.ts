import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { canonicalPayload, type Json } from '../../packages/contracts/src/envelope.js';
import {
  createAnswerGate,
  type AnswerCommand,
  type Principal,
  type QuestionBinding,
} from '../../packages/domain/src/answer-gate.js';
import { createDelegationApi } from '../../packages/domain/src/delegation.js';
import { createStopFixture, createWorkControlApi } from '../../packages/domain/src/work-control.js';
import { createLocalHubPort, encodeHubAnswer, type LocalHubPort } from '../../packages/integrations/autoloop/answers.js';
import { createFeishuChannel } from '../../packages/integrations/feishu/connection.js';
import { type SqliteDatabase } from '../../packages/storage/src/database.js';
import { openDatabase } from '../../packages/storage/src/database.js';

const require = createRequire(import.meta.url);
const lark = require('@larksuiteoapi/node-sdk');
const receiptPath = join(homedir(), '.patrick', 'run', 'feishu-pairing.json');
const enablePath = join(homedir(), '.patrick', 'run', 'feishu-enable.json');

test.skipIf(!process.env.PATRICK_FEISHU_ENABLE)('trusted enable uses the paired Feishu identity and a read-back test message', async () => {
  const pairing = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
    openId: string;
    chatId: string;
    tenantKey: string;
  };
  const credentials = readCredentials();
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t10-enable-'));
  const db = openDatabase(join(dir, 'patrick.sqlite'));
  const hub = createLocalHubPort(join(dir, 'hub.sqlite'));
  const now = () => new Date();
  const domain = 'personal';
  const principal: Principal = {
    account_id: 'owner',
    caller_id: 'web',
    auth_epoch: 1,
    domains: [domain],
    operations: ['owner'],
  };
  try {
    const stamped = now().toISOString();
    db.prepare(`INSERT INTO channel_connections (
      connection_id, account_id, data_domain, app_id, tenant_key, credential_ref, credential_version,
      config_revision, channel_incarnation, connection_epoch, binding_revision, current_pairing_id,
      current_test_id, owner_open_id, chat_id, status, transport_mode, reason_code, cutoff_seq,
      schema_version, created_at, updated_at
    ) VALUES (
      'conn-live', 'owner', ?, ?, ?, 'cred-live', 1,
      1, 1, 1, 1, NULL,
      NULL, NULL, NULL, 'needs_binding', 'probe', NULL, NULL,
      '1.0', ?, ?
    )`).run(domain, credentials.appId, pairing.tenantKey, stamped, stamped);
    const channel = createFeishuChannel(db, {
      domain,
      now,
      hub,
      encode: encodeHubAnswer,
      connectionId: 'conn-live',
    });
    await prepareWorks(db, principal, now, domain);
    const created = channel.createPairing();
    writeFileSync(enablePath, JSON.stringify({ status: 'waiting', code: created.code }, null, 2) + '\n', { mode: 0o600 });
    console.log(`FEISHU_PAIR_CODE ${created.code}`);
    const inbound = await waitForCode(credentials, created.code, pairing.openId);
    expect(inbound.chatId).toBe(pairing.chatId);
    await channel.receivePairingMessage({ code: created.code, open_id: inbound.openId, chat_id: inbound.chatId });
    channel.confirmPairing(principal, created.pairing_id);
    const preview = channel.createTest(inbound.openId);
    const client = new lark.Client({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.error,
    });
    const sent = await client.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: inbound.openId,
        msg_type: 'text',
        content: JSON.stringify({ text: 'PAtrick 连接测试，不含业务资料。' }),
        uuid: createHash('sha256').update(preview.test_id).digest('hex').slice(0, 32),
      },
    });
    const messageId = sent?.data?.message_id as string;
    const readback = await client.im.v1.message.get({ path: { message_id: messageId } });
    const readId = readback?.data?.items?.[0]?.message_id ?? readback?.data?.message_id;
    expect(readId).toBe(messageId);
    channel.sendTest(preview);
    await channel.recordTestCallback({
      test_id: preview.test_id,
      message_id: messageId,
      inbound_evidence: `readback:${messageId}`,
    });
    await channel.applyTrustedEnable(channel.currentProof());
    expect(await channel.readConnection()).toEqual({ status: 'ready', transport_mode: 'active' });
    const raced = await raceAndDrain({
      db, hub, channel, now, domain, credentials, principal,
    });
    writeFileSync(enablePath, JSON.stringify({
      status: 'ready',
      testMessageId: messageId,
      readback: 'match',
      ...raced,
    }, null, 2) + '\n', { mode: 0o600 });
  } finally {
    hub.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10 * 60 * 1000);

function readCredentials(): { appId: string; appSecret: string } {
  const values = new Map<string, string>();
  for (const line of readFileSync(join(homedir(), '.patrick', 'secrets', 'feishu.env'), 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    values.set(match[1]!, match[2]!.trim().replace(/^["']|["']$/g, ''));
  }
  const appId = values.get('FEISHU_APP_ID') ?? '';
  const appSecret = values.get('FEISHU_APP_SECRET') ?? '';
  if (!appId || !appSecret) throw new Error('missing Feishu app credential');
  return { appId, appSecret };
}

function waitForCode(
  credentials: { appId: string; appSecret: string },
  code: string,
  expectedOpenId: string,
): Promise<{ openId: string; chatId: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close({ force: true });
      reject(new Error('pairing timed out'));
    }, 5 * 60 * 1000);
    const ws = new lark.WSClient({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.error,
      autoReconnect: true,
    });
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1'(data: {
        message?: { content?: string; chat_type?: string; chat_id?: string; message_type?: string };
        sender?: { sender_id?: { open_id?: string } };
      }) {
        const message = data.message ?? {};
        let text = '';
        try { text = JSON.parse(message.content || '{}').text || ''; } catch { text = ''; }
        const openId = data.sender?.sender_id?.open_id ?? '';
        if (message.message_type !== 'text' || message.chat_type !== 'p2p' || text.trim() !== code) return;
        if (openId !== expectedOpenId) return;
        clearTimeout(timer);
        ws.close({ force: true });
        resolve({ openId, chatId: message.chat_id ?? '' });
      },
    });
    ws.start({ eventDispatcher: dispatcher }).catch((error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function prepareWorks(db: SqliteDatabase, principal: Principal, now: () => Date, domain: string) {
  const delegation = createDelegationApi(db, principal, { now, domain });
  await delegation.registerMandateType({
    type_id: 'type-judge',
    actions: ['judge', 'collect', 'publish_pr'],
    resources: ['work'],
    effects: ['publish_pr'],
    domains: [domain],
    risk: 'low',
    level: 'L1',
    budget_micros: 5000,
    config_version: 1,
  });
  await delegation.setCapability({
    profile_id: 'cap-live',
    level: 'L2',
    actions: ['judge', 'collect', 'publish_pr'],
    report_id: 'report-1',
    report_version: 1,
    config_version: 1,
  });
  await delegation.ensureJudgmentPolicy();
  for (const workId of ['W-017', 'W-018']) {
    await delegation.openMandate({
      mandate_id: `mandate-${workId}`,
      type_id: 'type-judge',
      actions: ['judge', 'collect', 'publish_pr'],
      resources: ['work'],
      effects: ['publish_pr'],
      domains: [domain],
      risk: 'low',
      level: 'L1',
      budget_micros: 5000,
      expires_at: '2027-01-01T00:00:00.000Z',
    });
    await delegation.openWork({
      work_id: workId,
      generation: 2,
      mandate_id: `mandate-${workId}`,
      phase: 'judgment',
      next_action: 'judge',
      budget_micros: 5000,
    });
    await delegation.authorizeAction({
      work_id: workId,
      generation: 2,
      attempt_id: `attempt-${workId}`,
      phase: 'judgment',
      next_action: 'judge',
      allowed_effects: [],
      expires_at: '2027-01-01T00:00:00.000Z',
    });
  }
  const stopPort = createStopFixture();
  stopPort.report('W-017', 2, { process_tree_stopped: true, effects_reconciled: true });
  await createWorkControlApi(db, principal, { now, stopPort }).applyWorkControl(principal, {
    work_id: 'W-017',
    type: 'stop',
    generation: 2,
    expected_revision: 0,
  });
}

async function raceAndDrain(input: {
  db: SqliteDatabase;
  hub: LocalHubPort;
  channel: ReturnType<typeof createFeishuChannel>;
  now: () => Date;
  domain: string;
  credentials: { appId: string; appSecret: string };
  principal: Principal;
}) {
  const { db, hub, channel, now, credentials, principal } = input;
  const gate = createAnswerGate(db, { domain: input.domain, now, hub, encode: encodeHubAnswer });
  const feishu: Principal = { ...principal, caller_id: 'feishu' };
  const delegation = createDelegationApi(db, principal, { now, domain: input.domain });
  const raceBinding = await gate.bindQuestion(principal, question('Q-race', 17, 'W-017'));
  const raceCardId = await sendCard(credentials, '双入口', '请点「选项 A」。不含业务资料。', [
    ['option-a', '选项 A'],
    ['option-b', '选项 B'],
  ]);
  const clickPromise = waitForAction(credentials, raceCardId, 120000);
  const webReceipt = await gate.submitAnswer(principal, command(principal, 'web-race', raceBinding, { kind: 'option', option_id: 'B' }));
  const click = await clickPromise;
  const chosen = click.actionName === 'option-a' ? 'A' : 'B';
  const feishuReceipt = await gate.submitAnswer(feishu, command(feishu, 'feishu-race', raceBinding, { kind: 'option', option_id: chosen }, click.messageId));
  const verified = [webReceipt, feishuReceipt].filter((receipt) => receipt.validity === 'verified');
  expect(verified).toHaveLength(1);
  expect(await hub.list('Q-race')).toHaveLength(1);

  const drainBinding = await gate.bindQuestion(principal, question('Q-drain', 18, 'W-017'));
  const drainCardId = await sendCard(credentials, '停用核对', '请点「暂缓」。不含业务资料。', [['defer', '暂缓']]);
  const drainClick = waitForAction(credentials, drainCardId, 120000);
  await channel.submitHeld(feishu, command(feishu, 'feishu-drain', drainBinding, { kind: 'option', option_id: 'A' }, 'in-held'));
  await delegation.stopMandate('mandate-W-017');
  expect((await channel.disableWhileHubIsUncertain()).status).toBe('draining');
  const drained = await drainClick;
  expect((await channel.receive({ inbound_id: drained.messageId, epoch: 0, question_id: 'Q-drain' })).disposition).toBe('audit_only');
  await channel.releaseAcceptedHubAnswerReadback();
  expect(await delegation.activeGrantCount('W-017', 2)).toBe(0);
  const other = await gate.bindQuestion(principal, question('Q-018', 19, 'W-018'));
  const otherReceipt = await gate.submitAnswer(principal, command(principal, 'web-other', other, { kind: 'option', option_id: 'A' }));
  expect(otherReceipt.validity).toBe('verified');
  return {
    raceWinner: verified[0]?.question_id === 'Q-race' ? (webReceipt.validity === 'verified' ? 'web' : 'feishu') : 'unknown',
    raceMessageId: click.messageId,
    drainMessageId: drained.messageId,
    drain: 'audit_only',
    otherQuestion: otherReceipt.question_id,
  };
}

function question(questionId: string, hubCardId: number, workId: string) {
  return {
    question_id: questionId,
    question_version: 3,
    work_id: workId,
    generation: 2,
    proposal_revision: 8,
    hub_card_id: hubCardId,
    custom_allowed: false,
    options: [
      option('A', 0, '选项 A'),
      option('B', 1, '选项 B'),
    ],
    custom_rules: [],
  };
}

function option(optionId: 'A' | 'B', index: number, label: string) {
  return {
    option_id: optionId,
    index,
    label,
    disposition: 'proceed' as const,
    reason_code: null,
    next_action: 'judge',
    difference: null,
    missing: [],
    collection_id: null,
    expected_material: null,
  };
}

function command(principal: Principal, requestId: string, binding: QuestionBinding, answer: { kind: 'option'; option_id: 'A' | 'B' }, inboundId?: string): AnswerCommand {
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
    connection_id: principal.caller_id === 'feishu' ? 'conn-live' : undefined,
    inbound_id: principal.caller_id === 'feishu' ? inboundId : undefined,
    payload,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function sendCard(
  credentials: { appId: string; appSecret: string },
  title: string,
  body: string,
  buttons: Array<[string, string]>,
): Promise<string> {
  const pairing = JSON.parse(readFileSync(receiptPath, 'utf8')) as { openId: string };
  const client = new lark.Client({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    domain: lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.error,
  });
  const card = {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: title }, template: 'blue' },
    body: {
      elements: [
        { tag: 'markdown', content: body },
        ...buttons.map(([name, label]) => ({
          tag: 'button',
          type: name === 'option-a' ? 'primary' : 'default',
          text: { tag: 'plain_text', content: label },
          value: { sample: name },
          name,
        })),
      ],
    },
  };
  const sent = await client.im.v1.message.create({
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: pairing.openId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
      uuid: sha256(`${title}:${Date.now()}`).slice(0, 32),
    },
  });
  const messageId = sent?.data?.message_id as string;
  if (!messageId) throw new Error('card was not sent');
  return messageId;
}

function waitForAction(
  credentials: { appId: string; appSecret: string },
  cardMessageId: string,
  timeoutMs: number,
): Promise<{ actionName: string; messageId: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close({ force: true });
      reject(new Error('card timed out'));
    }, timeoutMs);
    const ws = new lark.WSClient({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.error,
      autoReconnect: true,
    });
    const onCard = (data: { action?: { name?: string; value?: { sample?: string } }; context?: { open_message_id?: string } }) => {
      const messageId = data.context?.open_message_id ?? '';
      if (messageId !== cardMessageId) return;
      clearTimeout(timer);
      ws.close({ force: true });
      resolve({ actionName: data.action?.name || data.action?.value?.sample || '', messageId });
    };
    const dispatcher = new lark.EventDispatcher({}).register({
      'card.action.trigger': onCard,
      'card.action.trigger_v1': onCard,
    });
    ws.start({ eventDispatcher: dispatcher }).catch((error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
