import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BillingAuthority } from '../../src/billing.js';
import { Workbench } from '../../src/orchestrator.js';
import { createRuntime } from '../../src/runtime.js';
import { acquireHostLease } from '../../src/lease.js';
import { Store } from '../../src/store.js';
import { liveWorkers } from '../../src/integrations/workers.js';
import { makeBillingFixture } from '../fixtures/billing.js';

const fixtures: ReturnType<typeof makeBillingFixture>[] = [];
const runtimes: Awaited<ReturnType<typeof createRuntime>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const runtime of runtimes.splice(0)) await runtime.close(); for (const fixture of fixtures.splice(0)) fixture.dispose(); });
function fixture() { const f = makeBillingFixture(); fixtures.push(f); return f; }
const writer = { async baseline() { return 'synthetic'; }, async readBaseline() { return []; }, async deliver() { throw Error('No delivery in synthetic billing tests'); } };
const research = { async research() { return { queries: [], summary: 'Synthetic', gaps: [] }; } };

it('binds Workbench and native fake scheduling to the injected canonical authority', async () => {
  const f = fixture(), billing = new BillingAuthority(f.store, f.config, f.currentProvider, { proofRoot: f.proofRoot, now: f.now });
  const fake = { name: 'codex' as const, async run() { return { output: { summary: 'Synthetic', cards: [] }, costUsd: 0, provider: f.included.provider, model: f.included.model }; } };
  const engine = new Workbench({ store: f.store, config: f.config, workers: [fake], writer, research, billing });
  const scheduler = (engine as unknown as { scheduler: { billing: BillingAuthority; run: (task: typeof f.task, project: typeof f.project, input: typeof f.input) => Promise<unknown> } }).scheduler;
  expect(scheduler.billing).toBe(billing);
  await expect(scheduler.run(f.task, f.project, f.input)).resolves.toEqual({ cards: [] });
  expect(f.store.get('tasks', f.task.id)?.attempts).toBe(1);
});

it('rejects wrong Store or cloned config when injecting Workbench authority', () => {
  const f = fixture(), billing = new BillingAuthority(f.store, f.config, f.currentProvider, { proofRoot: f.proofRoot });
  const other = new Store(':memory:');
  try {
    for (const options of [{ store: other, config: f.config }, { store: f.store, config: { ...f.config } }]) expect(() => new Workbench({ ...options, workers: [], writer, research, billing })).toThrowError(expect.objectContaining({ code: 'billing_authority_mismatch' }));
  } finally { other.close(); }
});

it('requires the supplied canonical authority across all live worker factories', async () => {
  const f = fixture(), billing = new BillingAuthority(f.store, f.config, { async read() { return undefined; } });
  const workers = liveWorkers(f.config, billing);
  for (const worker of workers) expect((worker as unknown as { billing: BillingAuthority }).billing).toBe(billing);
  await expect(workers.find(w => w.name === 'codex')!.run(f.input)).rejects.toMatchObject({ code: 'subscription_unverified' });
  expect(f.store.list('attempts')).toEqual([]);
});

it('runtime acquires the real exclusive lease before reconciliation and shares one authority before exposure', async () => {
  const f = fixture(); f.config.dataDir = join(f.root, 'runtime-data'); f.config.vaultDir = join(f.root, 'runtime-vault'); mkdirSync(f.config.dataDir); mkdirSync(f.config.vaultDir);
  const db = new Store(join(f.config.dataDir, 'patrick.db'), f.config.vaultDir);
  db.save('projects', f.project); db.save('sources', f.source); db.save('tasks', { ...f.task, attempts: 1 });
  db.save('attempts', { id: 'legacy-unfinished', projectId: f.project.id, domain: f.project.domain, taskId: f.task.id, taskVersion: f.task.version, role: 'knowledge_extract', runner: 'codex', provider: f.included.provider, model: f.included.model, inputHash: 'synthetic', status: 'running', costUsd: 0, startedAt: f.at.toISOString() }); db.close();
  const reconcile = BillingAuthority.prototype.reconcileAbandoned;
  let initialized: BillingAuthority | undefined;
  const observed = vi.spyOn(BillingAuthority.prototype, 'reconcileAbandoned').mockImplementation(function (this: BillingAuthority) {
    expect(() => acquireHostLease(f.config.dataDir)).toThrowError(expect.objectContaining({ code: 'writer_active' }));
    initialized = this; reconcile.call(this);
  });
  const runtime = await createRuntime(f.config); runtimes.push(runtime);
  expect(observed).toHaveBeenCalledTimes(1);
  const scheduler = (runtime.engine as unknown as { scheduler: { billing: BillingAuthority; workers: Map<string, { billing: BillingAuthority }> } }).scheduler;
  expect(scheduler.billing).toBe(initialized);
  for (const worker of scheduler.workers.values()) expect(worker.billing).toBe(initialized);
  expect(runtime.store.get('attempts', 'legacy-unfinished')).toMatchObject({ status: 'failed', error: 'attempt_abandoned_after_host_restart', costUsd: 0 });
  expect(runtime.store.get('tasks', f.task.id)?.attempts).toBe(1);
  await expect(scheduler.billing.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'subscription_unverified' });
});

it('a failed exclusive lease never reaches authority reconciliation or exposes runtime', async () => {
  const f = fixture(); f.config.dataDir = join(f.root, 'locked-data'); const lease = acquireHostLease(f.config.dataDir);
  const reconcile = vi.spyOn(BillingAuthority.prototype, 'reconcileAbandoned');
  try { await expect(createRuntime(f.config)).rejects.toMatchObject({ code: 'writer_active' }); expect(reconcile).not.toHaveBeenCalled(); } finally { lease.release(); }
});

it('reconciliation failure denies runtime exposure and releases its lease', async () => {
  const f = fixture(); f.config.dataDir = join(f.root, 'failed-data'); f.config.vaultDir = join(f.root, 'failed-vault');
  const closeStore = vi.spyOn(Store.prototype, 'close');
  vi.spyOn(BillingAuthority.prototype, 'reconcileAbandoned').mockImplementation(() => { throw Error('synthetic reconciliation failure'); });
  await expect(createRuntime(f.config)).rejects.toThrow('synthetic reconciliation failure');
  expect(closeStore).toHaveBeenCalledTimes(1);
  const lease = acquireHostLease(f.config.dataDir); lease.release();
});

it('constructing Workbench preserves an unfinished attempt belonging to the current authority', async () => {
  const f = fixture(), billing = new BillingAuthority(f.store, f.config, f.currentProvider, { proofRoot: f.proofRoot, now: f.now });
  const reserved = await billing.reserve(f.input, 'codex');
  new Workbench({ store: f.store, config: f.config, workers: [], writer, research, billing });
  expect(f.store.get('attempts', reserved.attempt.id)).toMatchObject({ status: 'running', billing: { dispatchState: 'reserved' } });
  expect(f.store.get('tasks', f.task.id)?.attempts).toBe(1);
});
