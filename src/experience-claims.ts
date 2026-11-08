import { assistantFixClaim, stableId, type DeliveryReceipt, type KnowledgeCard, type SourceRevision, type Task } from './domain.js';
import { publishKnowledge } from './knowledge.js';
import type { Store } from './store.js';

export function claimQuote(content: string): string | undefined {
  const line = content.split('\n').map(item => item.trim()).find(item => assistantFixClaim(item));
  const quote = line ?? content.trim();
  return assistantFixClaim(quote) ? quote.slice(0, 2000) : undefined;
}

/** An assistant fix claim stays pending until a delivery receipt is recovered. */
export function recordFixClaim(store: Store, source: SourceRevision): void {
  if (source.status !== 'active' || source.retention === 'ephemeral') return;
  const quote = claimQuote(source.content);
  if (!quote || !source.content.includes(quote)) return;
  const id = stableId('fix-claim', source.id, source.revision);
  if (store.get('actions', id)) return;
  store.save('actions', { id, projectId: source.projectId, domain: source.domain, kind: 'experience.pending-claim', status: 'pending', payload: { sourceId: source.id, revision: source.revision, quote }, updatedAt: source.createdAt });
  store.save('events', { id: stableId('fix-claim-event', id), projectId: source.projectId, domain: source.domain, type: 'experience.pending', message: '助手说已经修好。这是待核经验，收回交付证据之前，下次任务不会引用它。', data: { sourceId: source.id }, createdAt: source.createdAt });
}

export function recoverFixClaims(store: Store, task: Task, receipt: DeliveryReceipt): KnowledgeCard[] {
  if (task.projectId !== receipt.projectId || task.domain !== receipt.domain || receipt.taskId !== task.id) return [];
  const saved: KnowledgeCard[] = [];
  for (const action of store.list('actions')) {
    if (action.kind !== 'experience.pending-claim' || action.status !== 'pending' || action.projectId !== task.projectId || action.domain !== task.domain) continue;
    const sourceId = action.payload.sourceId, revision = action.payload.revision, quote = action.payload.quote;
    if (typeof sourceId !== 'string' || typeof revision !== 'string' || typeof quote !== 'string') continue;
    const source = store.get('sources', sourceId);
    if (!source || source.status !== 'active' || source.revision !== revision || source.retention === 'ephemeral' || source.projectId !== task.projectId || source.domain !== task.domain || !source.content.includes(quote) || source.createdAt > receipt.verifiedAt) continue;
    const cards = publishKnowledge(store, source, { cards: [{ title: '待核经验', body: `助手说已经修好。交付回执 ${receipt.id} 已收回。这不是本人原则，也不是已核实的解法。`, quote, aliases: ['修好了'], verification: 'reported', kind: 'knowledge' }] });
    store.save('actions', { ...action, status: 'completed', payload: { ...action.payload, receiptId: receipt.id }, updatedAt: receipt.verifiedAt });
    saved.push(...cards);
  }
  return saved;
}

export function fixClaimNote(store: Store, source: SourceRevision): string | undefined {
  const action = store.list('actions').find(item => item.kind === 'experience.pending-claim' && item.payload.sourceId === source.id && item.payload.revision === source.revision);
  if (!action) return undefined;
  return action.status === 'completed' ? '已收回交付回执。下次任务可以对照这句原文。这不是已核实的解法。' : '助手说已经修好。这是待核经验，收回交付证据之前，下次任务不会引用它。';
}
