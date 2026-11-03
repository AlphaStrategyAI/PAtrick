import { afterEach, describe, expect, it } from 'vitest';
import { FeishuChannel } from '../../src/integrations/feishu.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';
import { now, stableId, type AppConfig, type OutboxMessage, type Project, type Question } from '../../src/domain.js';

const stores: Store[] = [];
const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: 'P', description: '', repository: 'owner/p', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/'], trustedChecks: ['test'], trustedAppIds: [123], ownerId: 'owner', autoMerge: true, budgetUsd: 1, createdAt: now() };
const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: '/tmp/unused', vaultDir: '/tmp/unused', ownerId: 'owner', authToken: 'a', sessionSecret: 'b', projects: [project], runnerPolicies: [], workers: {}, scanIntervalMs: 1000, feishu: { appId: 'cli_app', appSecret: 'secret', ownerOpenId: 'ou_owner', verificationToken: 'verification', chatId: 'oc_dm' } };
const sdkMessage = (id: string, text: string, update = '1000') => ({ message_id: id, chat_id: 'oc_dm', msg_type: 'text', create_time: '1000', update_time: update, sender: { id: 'ou_owner', id_type: 'open_id', sender_type: 'user' }, body: { content: JSON.stringify({ text }) } });
function event(id: string, text: string, update = '1000', owner = 'ou_owner') { return { event_id: `event-${id}-${update}`, event_type: 'im.message.receive_v1', sender: { sender_type: 'user', sender_id: { open_id: owner } }, message: { message_id: id, chat_id: 'oc_dm', chat_type: 'p2p', create_time: '1000', update_time: update, message_type: 'text', content: JSON.stringify({ text }) } }; }
function setup(overrides: Partial<AppConfig> = {}) {
  const store = new Store(':memory:'); stores.push(store); const c = { ...config, ...overrides };
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
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe('authenticated durable Feishu channel', () => {
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
    expect(f.store.get('tasks', old.id)?.status).toBe('cancelled'); expect(f.store.list('sources').filter(s => s.status === 'active')).toHaveLength(1);
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
    const offline = setup(); offline.setList(async () => ({ code: 99991672, msg: 'permission denied' }));
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
