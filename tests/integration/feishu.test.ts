import { createCipheriv, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WSClient } from '@larksuiteoapi/node-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeishuChannel } from '../../src/integrations/feishu.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';
import { now, stableId, type AppConfig, type OutboxMessage, type Project, type Question } from '../../src/domain.js';

const stores: Store[] = [];
const directories: string[] = [];
const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: 'P', description: '', repository: 'owner/p', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/'], trustedChecks: ['test'], trustedAppIds: [123], ownerId: 'owner', autoMerge: true, budgetUsd: 1, createdAt: now() };
const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: '/tmp/unused', vaultDir: '/tmp/unused', ownerId: 'owner', authToken: 'a', sessionSecret: 'b', projects: [project], runnerPolicies: [], workers: {}, scanIntervalMs: 1000, feishu: { appId: 'cli_app', appSecret: 'secret', ownerOpenId: 'ou_owner', verificationToken: 'verification', chatId: 'oc_dm' } };
const sdkMessage = (id: string, text: string, update = '1000') => ({ message_id: id, chat_id: 'oc_dm', msg_type: 'text', create_time: '1000', update_time: update, sender: { id: 'ou_owner', id_type: 'open_id', sender_type: 'user' }, body: { content: JSON.stringify({ text }) } });
function event(id: string, text: string, update = '1000', owner = 'ou_owner') { return { event_id: `event-${id}-${update}`, event_type: 'im.message.receive_v1', sender: { sender_type: 'user', sender_id: { open_id: owner } }, message: { message_id: id, chat_id: 'oc_dm', chat_type: 'p2p', create_time: '1000', update_time: update, message_type: 'text', content: JSON.stringify({ text }) } }; }
function setup(overrides: Partial<AppConfig> = {}, persistence?: { databasePath: string; vaultDir: string }) {
  const store = new Store(persistence?.databasePath ?? ':memory:', persistence?.vaultDir); stores.push(store); const c = { ...config, ...overrides };
  const engine = new Workbench({ store, config: c, workers: [], writer: { async baseline() { throw new Error('unused'); }, async deliver() { throw new Error('unused'); } }, research: { async research() { throw new Error('unused'); } } });
  const messages: any[] = []; let creates = 0; let listCalls = 0; let loseCreateResponse = false;
  let list = async (_input: any) => ({ code: 0, data: { items: messages, has_more: false } } as any);
  const sdk = { im: { message: { async list(input: any) { listCalls++; return list(input); }, async create(input: any) { creates++; const message = { message_id: `om_${creates}`, sender: { id: 'cli_app', id_type: 'app_id', sender_type: 'app' }, chat_id: 'oc_dm', body: { content: input.data.content }, msg_type: 'text', create_time: String(Date.now()) }; messages.push(message); if (loseCreateResponse) throw new Error('socket closed after send'); return { code: 0, data: { message_id: message.message_id } }; }, async get() { return { code: 0, data: { items: messages } }; } } } };
  const channel = new FeishuChannel(store, c, engine, sdk);
  const notice = (): OutboxMessage => ({ id: 'notice', projectId: 'p', domain: 'personal', channel: 'feishu', recipient: 'ou_owner', text: 'Switch grok → dsh', status: 'pending', attempts: 0, createdAt: now(), runAfter: now() });
  const question = () => {
    const task = engine.ingest({ projectId: 'p', externalId: 'question-source', title: 'Drafts', content: 'Keep drafts' })!;
    const suggestion = (label: string) => ({ label, description: label, rationale: 'Evidence', tradeoff: 'Cost', evidenceUrls: ['https://example.com'] });
    const q: Question = { id: 'question', projectId: 'p', domain: 'personal', taskId: task.id, taskVersion: 1, version: 1, ownerId: 'owner', title: 'Keep?', context: 'Choose', options: { A: suggestion('Keep'), B: suggestion('Delete') }, research: { queries: [], summary: '', gaps: [] }, status: 'open', createdAt: now() };
    store.save('questions', q); store.save('tasks', { ...task, stage: 'decide', status: 'awaiting_answer', questionId: q.id });
    store.save('outbox', { ...notice(), id: stableId('question-notice', q.id), taskId: task.id, status: 'sent', remoteId: 'om_question' });
    return { task, q };
  };
  return { store, engine, channel, sdk, messages, notice, question, counts: () => ({ creates, listCalls }), setList: (fn: typeof list) => { list = fn; }, loseResponse: () => { loseCreateResponse = true; } };
}
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function encryptedCallback(payload: unknown, encryptKey: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  const iv = Buffer.alloc(16, 7);
  const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(encryptKey).digest(), iv);
  const raw = { encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(payload)), cipher.final()]).toString('base64') };
  const nonce = 'fake-nonce';
  const signature = createHash('sha256').update(timestamp + nonce + encryptKey + JSON.stringify(raw)).digest('hex');
  return { raw, headers: { 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': signature } };
}

describe('authenticated durable Feishu channel', () => {
  it('supports authenticated WS receive, history recovery and send without an HTTP callback token', async () => {
    const f = setup({ feishu: { ...config.feishu!, verificationToken: undefined } });
    expect(f.channel.ready().ready).toBe(false);
    f.messages.push(sdkMessage('offline-owner', 'Offline idea'), { ...sdkMessage('history-wrong-owner', 'Ignore intruder history'), sender: { id: 'ou_other', id_type: 'open_id', sender_type: 'user' } }, { ...sdkMessage('history-wrong-chat', 'Ignore other chat history'), chat_id: 'oc_other' });
    await f.channel.catchup();
    expect(f.channel.ready()).toEqual({ ready: true });
    expect(f.store.list('tasks')).toHaveLength(1);
    await f.channel.dispatcher.invoke({ schema: '2.0', header: { event_type: 'im.message.receive_v1' }, event: event('ws-owner', 'Live idea') }, { needCheck: false });
    await f.channel.receive(event('wrong-owner', 'Ignore intruder', '1000', 'ou_other'));
    const wrongChat = event('wrong-chat', 'Ignore other chat'); wrongChat.message.chat_id = 'oc_other';
    await f.channel.receive(wrongChat);
    expect(f.store.list('tasks')).toHaveLength(2);
    expect(await f.channel.send(f.notice())).toEqual({ remoteId: 'om_1' });
    await expect(f.channel.send({ ...f.notice(), id: 'wrong-recipient', recipient: 'ou_other' })).rejects.toMatchObject({ code: 'feishu_recipient' });
    expect(f.counts().creates).toBe(1);
  });

  it('starts the official WS client only after authorized history without an HTTP callback token', async () => {
    const start = vi.spyOn(WSClient.prototype, 'start').mockResolvedValue(undefined);
    const f = setup({ feishu: { ...config.feishu!, verificationToken: undefined } });
    await f.channel.start();
    expect(f.counts().listCalls).toBe(1);
    expect(start).toHaveBeenCalledWith({ eventDispatcher: f.channel.dispatcher });
    expect(f.channel.ready()).toEqual({ ready: true });
  });

  it.each(['appId', 'appSecret', 'ownerOpenId', 'chatId'] as const)('keeps missing %s unready with no HTTP callback token', async key => {
    const f = setup({ feishu: { ...config.feishu!, verificationToken: undefined, [key]: undefined } as AppConfig['feishu'] });
    expect(f.channel.ready().ready).toBe(false);
    await expect(f.channel.catchup()).rejects.toMatchObject({ code: 'feishu_unready' });
    await expect(f.channel.send(f.notice())).rejects.toMatchObject({ code: 'feishu_unready' });
    expect(f.counts()).toEqual({ listCalls: 0, creates: 0 });
  });

  it.each([undefined, '', '   '])('denies every HTTP callback form without an actual verification token (%s)', async verificationToken => {
    const f = setup({ feishu: { ...config.feishu!, verificationToken } });
    await f.channel.catchup(); expect(f.channel.ready()).toEqual({ ready: true });
    const challenge = { type: 'url_verification', token: verificationToken, challenge: 'unauthenticated-challenge' };
    const incoming = { schema: '2.0', header: { token: verificationToken, event_type: 'im.message.receive_v1' }, event: event('http-without-token', 'Do not ingest') };
    for (const payload of [challenge, incoming]) {
      await expect(f.channel.webhook(payload, {})).rejects.toMatchObject({ code: 'feishu_verification', status: 403 });
    }
    const key = 'fake-encryption-key';
    const encrypted = setup({ feishu: { ...config.feishu!, verificationToken, encryptKey: key } });
    await encrypted.channel.catchup(); expect(encrypted.channel.ready()).toEqual({ ready: true });
    for (const payload of [challenge, incoming]) {
      const callback = encryptedCallback(payload, key);
      await expect(encrypted.channel.webhook(callback.raw, callback.headers)).rejects.toMatchObject({ code: 'feishu_verification', status: 403 });
    }
    expect(f.store.list('sources')).toHaveLength(0); expect(encrypted.store.list('sources')).toHaveLength(0);
  });

  it('keeps reserved pairing text out of business records and readable SQLite/Vault bytes across replay and restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'patrick-feishu-pair-')); directories.push(root);
    const persistence = { databasePath: join(root, 'patrick.db'), vaultDir: join(root, 'vault') };
    const f = setup({}, persistence);
    const commands = ['/pair PAIR_PRIVATE_SENTINEL_1', '  /PAIR PAIR_PRIVATE_SENTINEL_2', '/pair', '/pair\nPAIR_PRIVATE_SENTINEL_3'];
    await f.channel.receive(event('unknown-pair', commands[0]!, '1000', 'ou_other'));
    expect(f.store.list('actions')).toHaveLength(0); expect(f.store.list('cursors')).toHaveLength(0);
    for (const [i, command] of commands.entries()) {
      if (i < 2) await f.channel.receive(event(`pair-${i}`, command));
      f.messages.push(sdkMessage(`pair-${i}`, command));
    }
    await f.channel.catchup(); await f.channel.catchup();
    const assertNoBusinessRecords = (store: Store) => {
      for (const table of ['sources', 'tasks', 'cases', 'rules', 'cards', 'outbox'] as const) expect(store.list(table)).toHaveLength(0);
      expect(store.list('actions')).toHaveLength(commands.length);
      expect(store.list('cursors')).toHaveLength(commands.length + 1);
    };
    const assertNoCommandBytes = () => {
      for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const bytes = readFileSync(join(entry.parentPath, entry.name));
        for (const command of commands) expect(bytes.includes(Buffer.from(command))).toBe(false);
        expect(bytes.includes(Buffer.from('PAIR_PRIVATE_SENTINEL'))).toBe(false);
      }
    };
    assertNoBusinessRecords(f.store); assertNoCommandBytes(); f.store.close();
    const reopened = setup({}, persistence); reopened.messages.push(...f.messages); await reopened.channel.catchup();
    assertNoBusinessRecords(reopened.store); assertNoCommandBytes();
  });

  it('preserves encrypted callback authentication, freshness and exact signed body binding', async () => {
    const key = 'fake-encryption-key'; const f = setup({ feishu: { ...config.feishu!, encryptKey: key } });
    const challenge = encryptedCallback({ type: 'url_verification', token: 'verification', challenge: 'encrypted-challenge' }, key);
    expect(await f.channel.webhook(challenge.raw, challenge.headers)).toEqual({ challenge: 'encrypted-challenge' });
    const payload = { schema: '2.0', header: { token: 'verification', event_type: 'im.message.receive_v1' }, event: event('encrypted-owner', 'Encrypted idea') };
    const valid = encryptedCallback(payload, key);
    await expect(f.channel.webhook(valid.raw, { ...valid.headers, 'x-lark-signature': 'wrong' })).rejects.toMatchObject({ status: 403 });
    const stale = encryptedCallback(payload, key, String(Math.floor(Date.now() / 1000) - 600));
    await expect(f.channel.webhook(stale.raw, stale.headers)).rejects.toMatchObject({ status: 403 });
    const modified = encryptedCallback({ ...payload, event: event('changed-body', 'Different idea') }, key);
    await expect(f.channel.webhook(modified.raw, valid.headers)).rejects.toMatchObject({ status: 403 });
    const wrongToken = encryptedCallback({ ...payload, header: { ...payload.header, token: 'wrong' } }, key);
    await expect(f.channel.webhook(wrongToken.raw, wrongToken.headers)).rejects.toMatchObject({ status: 403 });
    expect(f.store.list('sources')).toHaveLength(0);
    await f.channel.webhook(valid.raw, valid.headers);
    expect(f.store.list('sources')).toHaveLength(1);
  });

  it('accepts only the owner open_id and deduplicates live and history delivery of the same revision', async () => {
    const f = setup(); await f.channel.receive(event('one', '保留草稿', '1000', 'intruder'));
    await f.channel.receive({ ...event('bot', 'notification'), sender: { sender_type: 'app', sender_id: { open_id: 'ou_owner' } } });
    expect(f.store.list('sources')).toHaveLength(0);
    await f.channel.receive(event('one', '保留草稿')); await f.channel.receive({ ...event('one', '保留草稿'), event_id: 'backfill' });
    expect(f.store.list('tasks')).toHaveLength(1); expect(f.store.list('sources')[0]?.authorId).toBe('owner');
  });

  it('records an authenticated answer once without creating a second business task', async () => {
    const f = setup(); const { task } = f.question();
    await f.channel.receive(event('answer', '/answer question 1.1 C 保留到下次导出成功'));
    await f.channel.receive({ ...event('answer', '/answer question 1.1 C 保留到下次导出成功'), event_id: 'history-answer' });
    expect(f.store.list('cases')).toHaveLength(1); expect(f.store.list('tasks')).toHaveLength(1);
    expect(f.store.get('tasks', task.id)?.version).toBe(2); expect(f.store.list('cases')[0]?.actorId).toBe('owner');
  });

  it('acknowledges an incomplete C answer so it cannot poison offline history replay', async () => {
    const f = setup(); f.question();
    await expect(f.channel.receive(event('incomplete', '/answer question 1.1 C'))).resolves.toBeUndefined();
    expect(f.store.get('questions', 'question')?.status).toBe('open'); expect(f.store.list('cases')).toHaveLength(0);
    expect(f.store.list('outbox').filter(m => m.status === 'pending')).toHaveLength(1);
    await f.channel.receive(event('incomplete', '/answer question 1.1 C'));
    expect(f.store.list('outbox').filter(m => m.status === 'pending')).toHaveLength(1);
  });

  it('sends a Feishu decision card and resumes the original task once', async () => {
    const f = setup(); const { task, q } = f.question();
    const notice = f.store.get('outbox', stableId('question-notice', q.id))!;
    f.store.save('outbox', { ...notice, status: 'pending' });
    await f.channel.send(f.store.get('outbox', notice.id)!);
    const card = JSON.parse(f.messages.at(-1).body.content);
    expect(card.schema).toBe('2.0');
    expect(JSON.stringify(card)).toContain('A · Keep');
    expect(JSON.stringify(card)).toContain('B · Delete');
    expect(JSON.stringify(card)).toContain('C · 我自己决定');
    expect(JSON.stringify(card)).toContain(`[PAtrick:${notice.id}]`);
    const press = (choice: 'A' | 'B' | 'C', words?: string) => f.channel.dispatcher.invoke({ schema: '2.0', header: { event_type: 'card.action.trigger' }, event: { operator: { open_id: 'ou_owner' }, action: { value: { questionId: q.id, taskVersion: 1, questionVersion: 1, choice }, ...(words ? { form_value: { words } } : {}) }, context: { open_chat_id: 'oc_dm', open_message_id: 'om_1' } } }, { needCheck: false });
    await press('C');
    expect(f.store.get('tasks', task.id)?.status).toBe('awaiting_answer');
    expect(f.store.list('outbox').some(item => item.text.includes('C 需要写下你自己的决定'))).toBe(true);
    await press('A');
    expect(f.store.get('tasks', task.id)).toMatchObject({ status: 'deciding', stage: 'decide', version: 2 });
    await press('A');
    await press('B');
    expect(f.store.get('tasks', task.id)?.version).toBe(2);
    expect(f.store.list('cases')).toHaveLength(1);
  });

  it('binds a reply A/B/C to the original remote question notification', async () => {
    const f = setup(); f.question(); const input = event('reply', 'A'); input.message = { ...input.message, parent_id: 'om_question' } as typeof input.message;
    await f.channel.receive(input); expect(f.store.list('cases')[0]?.choice).toBe('A');
    expect(f.store.list('tasks')).toHaveLength(1);
  });

  it('revokes the accepted owner principle when the answer message is recalled', async () => {
    const f = setup(); f.question(); await f.channel.receive(event('answer-recalled', '/answer question 1.1 C Keep until success'));
    await f.channel.receive({ event_type: 'im.message.recalled_v1', message_id: 'answer-recalled', chat_id: 'oc_dm', recall_time: '3000' });
    expect(f.store.get('questions', 'question')?.status).toBe('stale');
    expect(f.store.list('rules').filter(r => r.kind === 'principle').every(r => r.status === 'suspended')).toBe(true);
  });

  it('keeps status and lookup commands out of the knowledge source loop', async () => {
    const f = setup(); await f.channel.receive(event('status', '/status')); await f.channel.receive(event('lookup', '/lookup p 草稿'));
    expect(f.store.list('tasks')).toHaveLength(0); expect(f.store.list('sources')).toHaveLength(0); expect(f.store.list('outbox')).toHaveLength(2);
  });
  it('retracts short private titles from pending status replies using source provenance',async()=>{
    const f=setup(),task=f.engine.ingest({projectId:'p',externalId:'short-private',title:'私密',content:'Private body'})!;
    await f.channel.receive(event('short-status','/status'));
    const message=f.store.list('outbox').find(m=>m.text.includes('私密'))!;expect(message.sourceIds).toContain(task.sourceId);
    f.engine.withdraw(task.sourceId);expect(f.store.get('outbox',message.id)?.text).not.toContain('私密');expect(f.store.get('outbox',message.id)?.status).toBe('sent');
  });

  it('keeps denied corporate data out of status, lookup and outbound personal-channel messages', async () => {
    const secret = 'CORPORATE_EGRESS_SENTINEL'; const corporate = { ...project, id: 'corp', projectId: 'corp', domain: 'company', name: secret };
    const f = setup({ projects: [project, corporate] }); f.engine.ingest({ projectId: 'corp', externalId: 'corporate', title: secret, content: secret });
    await f.channel.receive(event('corp-status', '/status')); await f.channel.receive(event('corp-lookup', '/lookup corp sensitive'));
    expect(f.store.list('outbox').every(message => !message.text.includes(secret))).toBe(true);
    await expect(f.channel.send({ ...f.notice(), projectId: 'corp', domain: 'company', text: secret })).rejects.toThrow();
    expect(f.counts().listCalls).toBe(0); expect(f.counts().creates).toBe(0);
  });

  it('redacts a standalone lookup reply by source provenance when a short-title source is withdrawn', async () => {
    const f = setup(); const secret = 'WITHDRAW_LOOKUP_BODY_SENTINEL';
    const task = f.engine.ingest({ projectId: 'p', externalId: 'lookup-source', title: 'Idea', content: secret })!;
    const source = f.store.get('sources', task.sourceId)!;
    f.store.save('cards', { id: 'lookup-card', projectId: 'p', domain: 'personal', sourceId: source.id, sourceRevision: source.revision, title: 'Fact', body: secret, quote: secret, locator: source.locator, kind: 'fact', verification: 'reported', status: 'active', aliases: [], createdAt: now() });
    await f.channel.receive(event('lookup-reply', '/lookup p WITHDRAW_LOOKUP_BODY_SENTINEL'));
    const reply = f.store.list('outbox').find(message => message.text.includes(secret))!; expect(reply.sourceIds).toEqual([source.id]);
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    f.setList(async () => { await held; return { code: 0, data: { items: [], has_more: false } }; });
    const sending = f.channel.send(reply);
    f.engine.withdraw(source.id);
    release(); await expect(sending).rejects.toThrow(); expect(f.counts().creates).toBe(0);
    const redacted = f.store.get('outbox', reply.id)!; expect(redacted.text).not.toContain(secret); expect(redacted.status).toBe('sent');
  });

  it('invalidates edited and recalled owner source revisions', async () => {
    const f = setup(); await f.channel.receive(event('edit', '原方案')); const old = f.store.list('tasks')[0]!;
    await f.channel.receive(event('edit', '新方案', '2000'));
    expect(f.store.get('tasks', old.id)).toMatchObject({ id: old.id, status: 'queued', version: old.version + 1, description: '新方案' });
    expect(f.store.list('tasks').filter(task => task.status !== 'cancelled')).toHaveLength(1);
    expect(f.store.list('sources').filter(s => s.status === 'active')).toEqual([expect.objectContaining({ content: '新方案' })]);
    await f.channel.receive({ event_type: 'im.message.recalled_v1', message_id: 'edit', chat_id: 'oc_dm', recall_time: '3000' });
    expect(f.store.list('sources').filter(s => s.status === 'active')).toHaveLength(0);
    await f.channel.receive(event('edit', '原方案')); expect(f.store.list('sources').filter(s => s.status === 'active')).toHaveLength(0);
  });

  it('recovers a send accepted before disconnect by its stable marker instead of sending twice', async () => {
    const f = setup(); f.loseResponse();
    await expect(f.channel.send(f.notice())).rejects.toThrow(); expect(f.counts().creates).toBe(1);
    const receipt = await f.channel.send(f.notice()); expect(receipt.remoteId).toBe('om_1'); expect(f.counts().creates).toBe(1);
    expect(f.messages[0].body.content).toContain('PAtrick:notice');
  });

  it('does not advance the catchup watermark beyond an unprocessed page and safely replays completed pages', async () => {
    const f = setup(); let fail = true;
    f.setList(async input => { if (!input.params.page_token) return { code: 0, data: { items: [sdkMessage('first', 'First idea')], has_more: true, page_token: 'second' } }; if (fail) throw new Error('offline'); return { code: 0, data: { items: [sdkMessage('second', 'Second idea')], has_more: false } }; });
    await expect(f.channel.catchup()).rejects.toThrow(); expect(f.store.list('tasks')).toHaveLength(1);
    expect(f.store.list('cursors').filter(c => c.id === stableId('feishu-history', 'oc_dm'))).toHaveLength(0);
    fail = false; await f.channel.catchup(); expect(f.store.list('tasks')).toHaveLength(2);
    expect(f.store.get('cursors', stableId('feishu-history', 'oc_dm'))).toBeDefined();
  });

  it('drains an active history scan and suppresses future channel work during shutdown', async () => {
    const f = setup(); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    f.setList(async () => { await held; return { code: 0, data: { items: [], has_more: false } }; });
    const scan = f.channel.catchup(); let closed = false; const closing = f.channel.shutdown().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    await expect(f.channel.send(f.notice())).rejects.toThrow(); expect(f.counts().creates).toBe(0);
    release(); await scan; await closing; expect(closed).toBe(true);
    const calls = f.counts().listCalls; await f.channel.catchup(); await f.channel.receive(event('late', 'Late idea'));
    expect(f.counts().listCalls).toBe(calls); expect(f.store.list('tasks')).toHaveLength(0);
  });

  it('fails readiness when reliable history deduplication is unavailable', async () => {
    const f = setup({ feishu: { ...config.feishu!, chatId: undefined } });
    expect(f.channel.ready().ready).toBe(false); await expect(f.channel.send(f.notice())).rejects.toThrow(); expect(f.counts().creates).toBe(0);
    const offline = setup({ feishu: { ...config.feishu!, verificationToken: undefined } }); offline.setList(async () => ({ code: 99991672, msg: 'permission denied' }));
    await expect(offline.channel.send(offline.notice())).rejects.toThrow(); expect(offline.channel.ready().ready).toBe(false); expect(offline.counts().creates).toBe(0);
  });

  it('verifies webhook tokens before dispatch and supports the verified URL challenge', async () => {
    const f = setup();
    await expect(f.channel.webhook({ schema: '2.0', header: { token: 'wrong', event_type: 'im.message.receive_v1' }, event: event('forged', 'secret') }, {})).rejects.toThrow();
    expect(await f.channel.webhook({ type: 'url_verification', token: 'verification', challenge: 'challenge' }, {})).toEqual({ challenge: 'challenge' });
    await f.channel.webhook({ schema: '2.0', header: { token: 'verification', event_type: 'im.message.receive_v1' }, event: event('verified', 'A verified idea') }, {});
    expect(f.store.list('sources')).toHaveLength(1);
  });
});
