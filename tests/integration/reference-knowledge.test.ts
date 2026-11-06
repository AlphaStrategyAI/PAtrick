import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { now, roles, type AppConfig, type Project, type WorkerAdapter, type WorkerInput } from '../../src/domain.js';
import { caseVersions } from '../../src/cases.js';
import { BillingAuthority } from '../../src/billing.js';
import { Workbench } from '../../src/orchestrator.js';
import { weeklyReport } from '../../src/reports.js';
import { Store } from '../../src/store.js';
import { makeBillingFixture } from '../fixtures/billing.js';

const stores: Store[] = [], roots: string[] = [];
const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: 'Product', description: '', repository: 'owner/product', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/'], trustedChecks: ['test'], trustedAppIds: [1], ownerId: 'owner', autoMerge: true, budgetUsd: 1, createdAt: now() };
function setup(options: { admitted?: boolean; database?: string; vaultDir?: string; run?: (input: WorkerInput) => Promise<void> } = {}) {
  const store = new Store(options.database ?? ':memory:', options.vaultDir); stores.push(store);
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: '/tmp', vaultDir: '/tmp', ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, runnerPolicies: [{ runner: 'grok', roles: [...roles], domains: ['personal'], provider: 'provider', model: 'model', admitted: options.admitted ?? true, costPerRunUsd: .01, independentReview: false }], scanIntervalMs: 1000 };
  const calls: WorkerInput[] = [];
  const worker: WorkerAdapter = { name: 'grok', async run(input) {
    calls.push(structuredClone(input)); await options.run?.(input);
    const output = input.role !== 'knowledge_extract' ? { observations: [] } : input.source.purpose === 'reference' ? { cards: [{ title: 'Reference fact', body: 'Reported reference.', quote: 'Keep drafts.', aliases: [], verification: 'reported', kind: 'knowledge' }], caseMentions: [{ quote: 'Keep drafts.', locator: input.source.locator, title: 'Reported choice', choiceText: 'Keep drafts.', rationale: null, alternatives: [] }] } : { cards: [] };
    return { output, costUsd: .01, provider: 'provider', model: 'model' };
  } };
  const engine = new Workbench({ store, config, workers: [worker], writer: { async baseline() { throw new Error('reference must not call writer'); }, async deliver() { throw new Error('reference must not call writer'); } }, research: { async research() { throw new Error('reference must not research'); } } });
  const reference = { projectId: 'p', externalId: 'reference', revision: 'r1', title: 'Reference', content: 'Keep drafts.', purpose: 'reference' as const };
  return { store, config, engine, calls, reference };
}
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('ordinary reference knowledge work', () => {
  it('prioritizes foreground work, extracts one reference once and terminates without a delivery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'patrick-reference-')); roots.push(root);
    const database = join(root, 'db.sqlite'), vaultDir = join(root, 'vault'), f = setup({ database, vaultDir }), reference = { ...f.reference, retention: 'ephemeral' as const };
    expect(f.engine.ingest(reference)).toBeUndefined();
    const task = f.engine.ingest({ projectId: 'p', externalId: 'foreground', title: 'Foreground', content: 'Foreground task.' })!;
    await f.engine.tick();
    expect(f.calls.map(call => call.source.externalId)).toEqual(['foreground']);
    f.engine.cancel(task.id);
    await f.engine.runUntilIdle();
    const referenceTask = f.store.list('tasks').find(t => (t as { kind?: string }).kind === 'reference_knowledge');
    expect(referenceTask).toMatchObject({ kind: 'reference_knowledge', stage: 'knowledge_extract', status: 'completed', attempts: 1 });
    expect(f.calls.map(call => call.source.externalId)).toEqual(['foreground', 'reference']);
    expect(f.calls[1]).toMatchObject({ role: 'knowledge_extract', cards: [], facts: [], rules: [], referenceKnowledge: { schemaVersion: 1, sourceRefs: [expect.objectContaining({ id: referenceTask!.sourceId })] } });
    expect(f.store.list('cards').filter(card => card.sourceId === referenceTask!.sourceId)).toHaveLength(1);
    expect(caseVersions(f.store, f.config, project)).toMatchObject([{ identity: 'unresolved', authority: 'source-report', choiceText: 'Keep drafts.' }]);
    expect(f.store.list('receipts')).toEqual([]);
    expect(weeklyReport(f.store, project).metrics).toMatchObject({ acceptedTasks: 1, deliveredTasks: 0 });
    f.engine.ingest(reference); await f.engine.runUntilIdle();
    expect(f.store.list('tasks').filter(t => (t as { kind?: string }).kind === 'reference_knowledge')).toHaveLength(1);
    expect(f.calls).toHaveLength(2);
    f.store.close();
    const reopened = setup({ database, vaultDir });
    expect(JSON.stringify([reopened.store.list('sources'), reopened.store.list('tasks'), reopened.store.list('actions'), reopened.store.list('cards')])).not.toContain('Keep drafts.');
    expect(reopened.store.get('tasks', referenceTask!.id)).toMatchObject({ kind: 'reference_knowledge', status: 'completed', attempts: 1 });
    expect(reopened.engine.ingest(reference)).toBeUndefined();
    expect(reopened.store.list('cards').filter(card => card.sourceId === referenceTask!.sourceId)).toEqual([]);
    expect(caseVersions(reopened.store, reopened.config, project)).toEqual([]);
    expect(reopened.store.list('actions').find(a => a.kind === 'knowledge.structured-ingest' && a.payload.sourceId === referenceTask!.sourceId)).toMatchObject({ status: 'completed', payload: { phase: 'ordinary' } });
    await reopened.engine.runUntilIdle();
    expect(reopened.store.get('tasks', referenceTask!.id)).toMatchObject({ status: 'completed', attempts: 2, sourceRevision: 'r1' });
    expect(reopened.calls).toHaveLength(1);
    expect(reopened.store.searchCards('drafts', project)).toHaveLength(1);
    expect(caseVersions(reopened.store, reopened.config, project)).toMatchObject([{ identity: 'unresolved', authority: 'source-report', choiceText: 'Keep drafts.' }]);
    reopened.engine.ingest(reference); await reopened.engine.runUntilIdle();
    expect(reopened.calls).toHaveLength(1);
    reopened.engine.ingest({ ...reopened.reference, externalId: 'permanent-reference' }); await reopened.engine.runUntilIdle();
    const permanent = reopened.store.list('sources').find(s => s.externalId === 'permanent-reference')!;
    expect(reopened.store.list('tasks').find(t => t.sourceId === permanent.id)).toMatchObject({ kind: 'reference_knowledge', status: 'completed' });
    reopened.store.close();
    const olderLedger = new Store(database); olderLedger.delete('sources', permanent.id); olderLedger.close();
    const recovered = setup({ database, vaultDir });
    expect(recovered.store.get('sources', permanent.id)).toMatchObject({ purpose: 'reference', status: 'active' });
  });
  it('keeps an unadmitted reference blocked without dispatch and cancels it on withdrawal', async () => {
    const f = setup({ admitted: false }); f.engine.ingest(f.reference); await f.engine.runUntilIdle();
    const task = f.store.list('tasks').find(t => (t as { kind?: string }).kind === 'reference_knowledge')!;
    expect(task).toMatchObject({ status: 'blocked', attempts: 0 });
    expect(f.calls).toEqual([]); expect(f.store.list('attempts')).toEqual([]);
    f.engine.withdraw(task.sourceId);
    expect(f.store.get('tasks', task.id)?.status).toBe('cancelled');
    expect(caseVersions(f.store, f.config, project)).toEqual([]);
  });
  it('does not publish a reference result withdrawn while the admitted synthetic worker is running', async () => {
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const f = setup({ run: async () => { started(); await gate; } });
    f.engine.ingest(f.reference); await f.engine.tick();
    const source = f.store.list('sources').find(s => s.externalId === 'reference')!;
    const pending = f.engine.tick(); await entered;
    f.engine.withdraw(source.id); release(); await pending;
    expect(f.store.list('cards')).toEqual([]); expect(caseVersions(f.store, f.config, project)).toEqual([]);
    expect(f.store.list('tasks').find(t => (t as { kind?: string }).kind === 'reference_knowledge')?.status).toBe('cancelled');
  });
  it('retains the reservation but rejects a result when its current runner admission is revoked', async () => {
    const f = setup({ run: async () => { f.config.runnerPolicies[0]!.admitted = false; f.config.runnerPolicies[0]!.costPerRunUsd = .5; } });
    f.engine.ingest(f.reference); await f.engine.runUntilIdle();
    const task = f.store.list('tasks').find(t => t.kind === 'reference_knowledge')!;
    expect(task).toMatchObject({ status: 'blocked', attempts: 1, spentUsd: .01 });
    expect(f.store.list('attempts')).toMatchObject([{ status: 'failed', costUsd: .01 }]);
    expect(f.store.list('cards')).toEqual([]); expect(caseVersions(f.store, f.config, project)).toEqual([]);
    const priceOnly = setup({ run: async () => { priceOnly.config.runnerPolicies[0]!.costPerRunUsd = .5; } });
    priceOnly.engine.ingest(priceOnly.reference); await priceOnly.engine.runUntilIdle();
    expect(priceOnly.store.list('tasks').find(t => t.kind === 'reference_knowledge')).toMatchObject({ status: 'completed', attempts: 1, spentUsd: .01 });
    expect(priceOnly.store.list('attempts')).toMatchObject([{ status: 'succeeded', costUsd: .01 }]);
  });
  it('does not publish when its allocated included-subscription proof is removed during worker I/O', async () => {
    const f = makeBillingFixture(); f.config.ownerId = f.project.ownerId;
    try {
      let calls = 0, contextReads = 0;
      const billing = new BillingAuthority(f.store, f.config, { async read() { contextReads++; return f.currentProvider.read(); } }, { proofRoot: f.root, now: f.now });
      const worker: WorkerAdapter = { name: 'codex', async run(input) {
        calls++; rmSync(f.proofPath);
        return { output: { cards: [{ title: 'Reference fact', body: 'Reported reference.', quote: 'Keep drafts.', aliases: [], verification: 'reported', kind: 'knowledge' }], caseMentions: [{ quote: 'Keep drafts.', locator: input.source.locator, title: 'Reported choice', choiceText: 'Keep drafts.', rationale: null, alternatives: [] }] }, costUsd: 0, provider: 'synthetic-provider', model: 'synthetic-model' };
      } };
      const engine = new Workbench({ store: f.store, config: f.config, workers: [worker], billing, writer: { async baseline() { throw new Error('unused'); }, async deliver() { throw new Error('unused'); } }, research: { async research() { throw new Error('unused'); } } });
      engine.cancel(f.task.id);
      engine.ingest({ projectId: f.project.id, externalId: 'included-reference', title: 'Reference', content: 'Keep drafts.', purpose: 'reference' });
      await engine.runUntilIdle();
      const task = f.store.list('tasks').find(value => value.kind === 'reference_knowledge')!;
      expect(task).toMatchObject({ status: 'blocked', attempts: 1, spentUsd: 0 });
      expect(f.store.list('attempts').filter(attempt => attempt.taskId === task.id)).toMatchObject([{ status: 'failed', costUsd: 0, billing: { mode: 'included-subscription', ordinal: 1, reserveUsd: 0 } }]);
      expect(calls).toBe(1); expect(contextReads).toBe(2);
      expect(f.store.list('cards')).toEqual([]); expect(caseVersions(f.store, f.config, f.project)).toEqual([]);
    } finally { f.dispose(); }
  });
});
