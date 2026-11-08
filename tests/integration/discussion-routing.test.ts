import { afterEach, describe, expect, it } from 'vitest';
import { now, type AppConfig, type Project } from '../../src/domain.js';
import { FeishuChannel } from '../../src/integrations/feishu.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';

const stores: Store[] = [];
const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: 'Product', description: '', repository: 'owner/product', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/'], trustedChecks: ['test'], trustedAppIds: [1], ownerId: 'owner', autoMerge: true, budgetUsd: 1, createdAt: now() };
function setup() {
  const store = new Store(':memory:'); stores.push(store);
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: '/tmp', vaultDir: '/tmp', ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, runnerPolicies: [], scanIntervalMs: 1000, feishu: { appId: 'app', appSecret: 'test', ownerOpenId: 'owner-open', chatId: 'owner-chat' } };
  const engine = new Workbench({ store, config, workers: [], writer: { async baseline() { throw new Error('unused'); }, async deliver() { throw new Error('unused'); } }, research: { async research() { throw new Error('unused'); } } });
  const channel = new FeishuChannel(store, config, engine, { im: { message: { async list() { return { code: 0, data: { items: [], has_more: false } }; }, async create() { throw new Error('unused'); } } } });
  const receive = (id: string, text: string, extra: Record<string, unknown> = {}) => channel.receive({ sender: { sender_type: 'user', sender_id: { open_id: 'owner-open' } }, message: { message_id: id, chat_id: 'owner-chat', message_type: 'text', create_time: '1000', update_time: '1000', content: JSON.stringify({ text }), ...extra } });
  return { store, receive };
}
afterEach(() => stores.splice(0).forEach(store => store.close()));

describe('subscribed discussion routing', () => {
  it('continues the same task when the original Feishu message is edited', async () => {
    const f = setup();
    await f.receive('root', '导出失败后保留草稿');
    const first = f.store.list('tasks')[0]!;
    await f.receive('root', '导出失败后保留草稿七天', { update_time: '2000' });
    expect(f.store.list('tasks').filter(task => task.status !== 'cancelled')).toEqual([expect.objectContaining({ id: first.id, version: first.version + 1, description: '导出失败后保留草稿七天' })]);
    expect(f.store.get('tasks', first.id)?.status).not.toBe('cancelled');
    expect(f.store.list('events').map(event => event.message)).toContain('资料有了新修订。原任务重新处理一次。');
  });

  it('sends a later message in the same thread to the original task once', async () => {
    const f = setup();
    await f.receive('root', '导出失败后保留草稿');
    const first = f.store.list('tasks')[0]!;
    await f.receive('follow', '导出前提示用户可以恢复', { parent_id: 'root' });
    await f.receive('follow', '导出前提示用户可以恢复', { parent_id: 'root' });
    expect(f.store.list('tasks')).toHaveLength(1);
    expect(f.store.get('tasks', first.id)).toMatchObject({ id: first.id, version: 2, status: 'queued', stage: 'knowledge_extract', description: '导出前提示用户可以恢复' });
    expect(f.store.list('events').map(event => event.message)).toContain('这条讨论有了新消息。原任务继续处理一次。');
    await f.receive('nested', '只在本产品这样做', { root_id: 'root', parent_id: 'follow' });
    expect(f.store.get('tasks', first.id)?.version).toBe(3);
    await f.receive('other', '另一件完全不同的事');
    expect(f.store.list('tasks')).toHaveLength(2);
  });

  it('keeps a finished discussion on the original task instead of opening another one', async () => {
    const f = setup();
    await f.receive('root', '导出失败后保留草稿');
    const first = f.store.list('tasks')[0]!;
    f.store.save('tasks', { ...first, status: 'delivered', stage: 'feedback', receiptId: 'receipt-1' });
    await f.receive('follow', '后来又丢了一次草稿', { parent_id: 'root' });
    await f.receive('follow', '后来又丢了一次草稿', { parent_id: 'root' });
    expect(f.store.list('tasks')).toEqual([expect.objectContaining({ id: first.id, status: 'delivered', version: first.version })]);
    expect(f.store.list('sources').filter(source => source.purpose === 'reference')).toHaveLength(1);
    expect(f.store.list('events').map(event => event.message)).toContain('这条讨论有了新消息。原任务已经结束，不会另开一件。');
  });
});
