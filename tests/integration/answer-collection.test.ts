import { afterEach, describe, expect, it } from 'vitest';
import { now, stableId, type AppConfig, type Entities, type Project, type Question, type SourceRevision, type Table } from '../../src/domain.js';
import { FeishuChannel } from '../../src/integrations/feishu.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';

class FlakyStore extends Store {
  failCollects = 1;
  override save<T extends Table>(table: T, entity: Entities[T]): void {
    const source = entity as SourceRevision;
    if (this.failCollects > 0 && table === 'sources' && source.externalId?.startsWith('answer:')) {
      this.failCollects -= 1;
      throw new Error('source collection failed');
    }
    super.save(table, entity);
  }
}

const stores: Store[] = [];
const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: 'Product', description: '', repository: 'owner/product', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/'], trustedChecks: ['test'], trustedAppIds: [1], ownerId: 'owner', autoMerge: true, budgetUsd: 1, createdAt: now() };
function setup() {
  const store = new FlakyStore(':memory:'); stores.push(store);
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: '/tmp', vaultDir: '/tmp', ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, runnerPolicies: [], scanIntervalMs: 1000, feishu: { appId: 'app', appSecret: 'test', ownerOpenId: 'owner-open', chatId: 'owner-chat' } };
  const engine = new Workbench({ store, config, workers: [], writer: { async baseline() { throw new Error('unused'); }, async deliver() { throw new Error('unused'); } }, research: { async research() { throw new Error('unused'); } } });
  const channel = new FeishuChannel(store, config, engine, { im: { message: { async list() { return { code: 0, data: { items: [], has_more: false } }; }, async create() { throw new Error('unused'); } } } });
  const task = engine.ingest({ projectId: 'p', externalId: 'question-source', title: 'Drafts', content: 'Keep drafts.' })!;
  const suggestion = (label: string) => ({ label, description: label, rationale: 'Evidence', tradeoff: 'Cost', evidenceUrls: ['https://example.com'] });
  const question: Question = { id: 'question', projectId: 'p', domain: 'personal', taskId: task.id, taskVersion: 1, version: 1, ownerId: 'owner', title: 'Keep?', context: 'Choose', options: { A: suggestion('Keep'), B: suggestion('Delete') }, research: { queries: [], summary: '', gaps: [] }, status: 'open', createdAt: now() };
  store.save('questions', question);
  store.save('tasks', { ...task, stage: 'decide', status: 'awaiting_answer', questionId: question.id });
  const receive = () => channel.receive({ sender: { sender_type: 'user', sender_id: { open_id: 'owner-open' } }, message: { message_id: 'answer-1', chat_id: 'owner-chat', message_type: 'text', create_time: '1000', update_time: '1000', content: JSON.stringify({ text: '/answer question 1.1 C 保留到导出成功' }) } });
  return { store, engine, receive };
}
afterEach(() => stores.splice(0).forEach(store => store.close()));

describe('answer collection retry', () => {
  it('keeps an accepted answer when saving its source fails, then finishes the source without asking again', async () => {
    const f = setup();
    await f.receive();
    const accepted = f.store.get('tasks', f.store.get('questions', 'question')!.taskId)!;
    const answer = f.store.get('questions', 'question')!;
    expect(answer.status).toBe('answered');
    expect(answer.answer?.text).toBe('保留到导出成功');
    expect(accepted).toMatchObject({ version: 2, status: 'deciding', stage: 'decide' });
    expect(f.store.get('sources', stableId('owner-answer', 'question'))).toBeUndefined();
    expect(f.store.get('actions', stableId('owner-answer-collect', 'question'))).toMatchObject({ status: 'pending' });
    expect(f.store.list('actions').find(action => action.kind === 'feishu_receive')?.status).toBe('pending');
    expect(f.store.list('events').map(event => event.message)).toContain('答复已经接纳。来源还没记上，到点会再补。这不需要你再答一次。');
    f.store.save('tasks', { ...accepted, runAfter: '2999-01-01T00:00:00.000Z' });
    await f.engine.tick();
    expect(f.store.get('sources', stableId('owner-answer', 'question'))?.content).toBe('保留到导出成功');
    expect(f.store.get('actions', stableId('owner-answer-collect', 'question'))?.status).toBe('completed');
    expect(f.store.get('tasks', accepted.id)).toMatchObject({ version: 2, status: 'deciding' });
    expect(f.store.get('questions', 'question')).toMatchObject({ status: 'answered', answer: answer.answer });
    await f.receive();
    expect(f.store.get('tasks', accepted.id)?.version).toBe(2);
    expect(f.store.list('cases')).toHaveLength(1);
    expect(f.store.list('actions').find(action => action.kind === 'feishu_receive')?.status).toBe('completed');
  });
});
