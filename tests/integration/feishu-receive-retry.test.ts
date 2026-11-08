import { afterEach, expect, it } from 'vitest';
import { now, type AppConfig, type Project } from '../../src/domain.js';
import { FeishuChannel } from '../../src/integrations/feishu.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));

it('keeps the received message when delivery fails and finishes it from the same message', async () => {
  const store = new Store(':memory:');
  stores.push(store);
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: 'Product', description: '', repository: 'owner/product', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/'], trustedChecks: ['test'], trustedAppIds: [1], ownerId: 'owner', autoMerge: true, budgetUsd: 1, createdAt: now() };
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: '/tmp', vaultDir: '/tmp', ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, runnerPolicies: [], scanIntervalMs: 1000, feishu: { appId: 'app', appSecret: 'test', ownerOpenId: 'owner-open', chatId: 'owner-chat' } };
  const engine = new Workbench({ store, config, workers: [], writer: { async baseline() { throw new Error('unused'); }, async deliver() { throw new Error('unused'); } }, research: { async research() { throw new Error('unused'); } } });
  const original = engine.ingest.bind(engine);
  let failed = false;
  engine.ingest = input => {
    if (!failed && input.kind === 'feishu') { failed = true; throw new Error('collect failed'); }
    return original(input);
  };
  const channel = new FeishuChannel(store, config, engine, { im: { message: { async list() { return { code: 0, data: { items: [], has_more: false } }; }, async create() { throw new Error('unused'); } } } });
  const receive = () => channel.receive({ sender: { sender_type: 'user', sender_id: { open_id: 'owner-open' } }, message: { message_id: 'idea-1', chat_id: 'owner-chat', message_type: 'text', create_time: '1000', update_time: '1000', content: JSON.stringify({ text: '保留导出失败后的草稿' }) } });
  await expect(receive()).rejects.toThrow('collect failed');
  expect(store.list('tasks')).toEqual([]);
  expect(store.list('actions').filter(action => action.kind === 'feishu_receive')).toEqual([expect.objectContaining({ status: 'pending' })]);
  await receive();
  expect(store.list('tasks')).toHaveLength(1);
  expect(store.list('actions').filter(action => action.kind === 'feishu_receive')).toEqual([expect.objectContaining({ status: 'completed' })]);
});
