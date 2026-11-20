import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { createLocalHubPort, encodeHubAnswer } from '../../packages/integrations/autoloop/answers.js';
import { type Principal } from '../../packages/domain/src/answer-gate.js';
import { createFeishuChannel } from '../../packages/integrations/feishu/connection.js';
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
    writeFileSync(enablePath, JSON.stringify({
      status: 'ready',
      testMessageId: messageId,
      readback: 'match',
    }, null, 2) + '\n', { mode: 0o600 });
  } finally {
    hub.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 6 * 60 * 1000);

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
