import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BillingAuthority } from '../../src/billing.js';
import { Workbench } from '../../src/orchestrator.js';
import { createRuntime } from '../../src/runtime.js';
import { acquireHostLease } from '../../src/lease.js';
import { Store } from '../../src/store.js';
import { liveWorkers } from '../../src/integrations/workers.js';
import { DomainError, SubscriptionAccessError, WorkerUnavailable, type RunnerPolicy, type WorkerInput } from '../../src/domain.js';
import { Scheduler } from '../../src/scheduler.js';
import { makeBillingFixture } from '../fixtures/billing.js';

const fixtures: ReturnType<typeof makeBillingFixture>[] = [];
const runtimes: Awaited<ReturnType<typeof createRuntime>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const runtime of runtimes.splice(0)) await runtime.close(); for (const fixture of fixtures.splice(0)) fixture.dispose(); });
function fixture(options: Parameters<typeof makeBillingFixture>[0] & { manualLease?: boolean } = {}) {
  const f = makeBillingFixture(options);
  // Persistent hold/quarantine fixtures own the actual single-host writer lease.
  // Restart matrices below use explicit release/reacquire assertions instead.
  if (options.persistent && !options.manualLease) {
    const directory = join(f.root, 'lease'); let lease = acquireHostLease(directory);
    const reopen = f.reopen, dispose = f.dispose;
    f.reopen = () => { lease.release(); const store = reopen(); lease = acquireHostLease(directory); return store; };
    f.dispose = () => { lease.release(); dispose(); };
  }
  fixtures.push(f); return f;
}
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

// Durable mechanics use actual SQLite and the same exclusive lease as runtime.
function authority(f: ReturnType<typeof fixture>) { return new BillingAuthority(f.store, f.config, f.currentProvider, { proofRoot: f.proofRoot, now: f.now }); }
function engineFor(f: ReturnType<typeof fixture>, billing = authority(f), workers: ConstructorParameters<typeof Workbench>[0]['workers'] = []) {
  return new Workbench({ store: f.store, config: f.config, workers, writer, research, billing });
}
function successful(f: ReturnType<typeof fixture>) { return { output: { cards: [] }, costUsd: 0, provider: f.included.provider, model: f.included.model }; }
function paid(f: ReturnType<typeof fixture>) {
  f.config.billingBoundary = 'metered-only'; f.included.billing = { mode: 'metered-api' }; f.included.costPerRunUsd = 1;
  f.project.budgetUsd = f.task.budgetUsd = 20; f.task.billingBoundary = 'metered-only';
  f.store.save('projects', f.project); f.store.save('tasks', f.task);
}
async function refuse(f: ReturnType<typeof fixture>, billing: BillingAuthority, reason: 'quota' | 'expired-credential' = 'quota') {
  return billing.runLima(f.input, 'codex', undefined, undefined, async () => { throw new SubscriptionAccessError({ disposition: 'verified-no-charge-refusal', reason, observedAt: f.at.toISOString(), evidenceDigest: 'synthetic-refusal', noChargeEvidenceDigest: 'synthetic-no-charge' }, 'Synthetic verified refusal'); });
}
function refresh(f: ReturnType<typeof fixture>) {
  const at = new Date(f.at.getTime() + 1000); f.setTime(at); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at);
  f.current.checkedAt = f.current.principalVerifiedAt = at.toISOString();
  f.proof.verifiedAt = f.proof.allowance.checkedAt = at.toISOString(); f.writeProof();
}

for (const mode of ['included', 'metered'] as const) for (const state of ['reserved', 'dispatched', 'adapter-entered'] as const) {
  it(`reopens ${mode} ${state} below cap with a leased new ordinal and never reuses the old permit`, async () => {
    const f = fixture({ persistent: true, maxAttemptsPerTask: 3, manualLease: true }); if (mode === 'metered') paid(f);
    let lease = acquireHostLease(join(f.root, 'lease'));
    try {
      const old = authority(f), reserved = await old.reserve(f.input, 'codex');
      if (state !== 'reserved') {
        let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
        void old.dispatch(reserved, f.input, { name: 'codex', async run(_input, signal, permit) {
          if (state === 'adapter-entered') return old.runLima(f.input, 'codex', signal, permit, async () => { entered(); return new Promise(() => {}); });
          entered(); return new Promise(() => {});
        } });
        await ready;
      }
      expect(f.store.get('attempts', reserved.attempt.id)?.billing?.dispatchState).toBe(state);
      // A higher previously recorded paid amount also survives restart without a refund.
      if (mode === 'metered') { f.store.save('attempts', { ...f.store.get('attempts', reserved.attempt.id)!, costUsd: 2 }); f.store.save('tasks', { ...f.store.get('tasks', f.task.id)!, spentUsd: 2 }); }
      lease.release(); f.reopen(); lease = acquireHostLease(join(f.root, 'lease'));
      const current = authority(f), calls = vi.fn(async () => ({ ...successful(f), costUsd: mode === 'metered' ? 1 : 0 }));
      await expect(current.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'attempt_recovery_required' });
      current.reconcileAbandoned(); current.reconcileAbandoned();
      expect(f.store.get('attempts', reserved.attempt.id)).toMatchObject({ status: 'failed', error: 'attempt_abandoned_after_host_restart', costUsd: mode === 'metered' ? 2 : 0, billing: { ordinal: 1, abandonedAt: f.at.toISOString() } });
      expect(f.store.get('tasks', f.task.id)).toMatchObject({ attempts: 1, attemptLimit: 3, spentUsd: mode === 'metered' ? 2 : 0 });
      await expect(current.dispatch(reserved, f.input, { name: 'codex', run: calls })).rejects.toMatchObject({ code: 'billing_permit_invalid' });
      const next = await current.reserve(f.input, 'codex'); expect(next.attempt.billing?.ordinal).toBe(2);
      await current.dispatch(next, f.input, { name: 'codex', run: calls });
      expect(calls).toHaveBeenCalledTimes(1); expect(f.store.get('tasks', f.task.id)).toMatchObject({ attempts: 2, spentUsd: mode === 'metered' ? 3 : 0 });
      expect(f.store.get('attempts', reserved.attempt.id)?.status).toBe('failed');
    } finally { lease.release(); }
  });
}

it('same epoch reconciliation never abandons a live slot, and abort consumes it before a safe next launch', async () => {
  const f = fixture({ persistent: true, maxAttemptsPerTask: 3 }); paid(f); const billing = authority(f), first = await billing.reserve(f.input, 'codex');
  billing.reconcileAbandoned(); billing.reconcileAbandoned();
  await expect(billing.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'attempt_in_progress' });
  const signal = new AbortController(); signal.abort(); const calls = vi.fn(async () => successful(f));
  await expect(billing.dispatch(first, f.input, { name: 'codex', run: calls }, signal.signal)).rejects.toMatchObject({ code: 'worker_aborted' });
  expect(calls).not.toHaveBeenCalled(); expect(f.store.get('tasks', f.task.id)).toMatchObject({ attempts: 1, spentUsd: 1 });
  expect(f.store.get('attempts', first.attempt.id)?.status).toBe('failed');
  // Fixed runtime lifecycle remains an independent gate, represented by this safe fake.
  let safe = false; const runtime = { name: 'codex' as const, async run() { if (!safe) throw new WorkerUnavailable('synthetic orphan cleanup stop'); return { ...successful(f), costUsd: 1 }; } };
  const blocked = await billing.reserve(f.input, 'codex'); await expect(billing.dispatch(blocked, f.input, runtime)).rejects.toBeInstanceOf(WorkerUnavailable);
  safe = true; const next = await billing.reserve(f.input, 'codex'); await billing.dispatch(next, f.input, runtime);
  expect(f.store.get('tasks', f.task.id)).toMatchObject({ attempts: 3, spentUsd: 3 });
});

it.each(['permanent', 'ephemeral'] as const)('preserves exhausted %s counters and stop through leased restart and version reconstruction', async retention => {
  const f = fixture({ persistent: true, retention, maxAttemptsPerTask: 1, manualLease: true }); let lease = acquireHostLease(join(f.root, 'lease'));
  try {
    const old = authority(f), reserved = await old.reserve(f.input, 'codex');
    await expect(old.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'subscription_attempt_limit' });
    lease.release(); f.reopen(); lease = acquireHostLease(join(f.root, 'lease')); const current = authority(f); current.reconcileAbandoned();
    if (retention === 'permanent') await expect(current.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'subscription_attempt_limit' });
    const stored = f.store.get('tasks', f.task.id)!; const reconstructed = { ...stored, version: stored.version + 1, repairCount: stored.repairCount + 1 };
    f.store.save('tasks', reconstructed); f.config.maxAttemptsPerTask = 256;
    if (retention === 'permanent') {
      await expect(current.reserve({ ...f.input, task: reconstructed }, 'codex')).rejects.toMatchObject({ code: 'subscription_attempt_limit' });
      expect(() => engineFor(f, current).retry(f.task.id)).toThrowError(expect.objectContaining({ code: 'subscription_attempt_limit', status: 409 }));
    } else {
      expect(f.store.get('sources', f.source.id)?.content).toBe('');
      await expect(current.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'stale_attempt' });
    }
    expect(f.store.get('tasks', f.task.id)).toMatchObject({ attempts: 1, attemptLimit: 1, billingBoundary: 'included-only', spentUsd: 0 });
    await expect(current.dispatch(reserved, f.input, { name: 'codex', async run() { throw Error('must not launch'); } })).rejects.toMatchObject({ code: 'billing_permit_invalid' });
  } finally { lease.release(); }
});

it.each(['positive', 'paid-route-used', 'extra-credit-used', 'no-charge-boundary-breached', 'charge-danger-unknown'] as const)('hard incident %s prevents scans, explicit retry and direct calls after 30 seconds and restart', async reason => {
  const f = fixture({ persistent: true, maxAttemptsPerTask: 3 }), billing = authority(f);
  await expect(billing.runLima(f.input, 'codex', undefined, undefined, async () => {
    if (reason === 'positive') return { ...successful(f), costUsd: 0.25 };
    throw new SubscriptionAccessError({ disposition: 'billing-incident', reason, observedAt: f.at.toISOString(), evidenceDigest: 'synthetic-incident' }, 'Synthetic incident');
  })).rejects.toMatchObject({ code: 'billing_policy_violation' });
  const original = f.store.get('tasks', f.task.id)!; f.reopen(); refresh(f);
  const current = authority(f), reads = vi.spyOn(f.currentProvider, 'read'), calls = vi.fn(async () => successful(f));
  const engine = engineFor(f, current, [{ name: 'codex', run: calls }]);
  f.store.save('tasks', { ...f.store.get('tasks', f.task.id)!, runAfter: new Date(Date.now() - 60000).toISOString() });
  await engine.tick(); await engine.tick();
  expect(reads).not.toHaveBeenCalled(); expect(calls).not.toHaveBeenCalled();
  expect(() => engine.retry(f.task.id)).toThrowError(expect.objectContaining({ code: 'billing_policy_violation', status: 409 }));
  await expect(current.runLima(f.input, 'codex', undefined, undefined, calls)).rejects.toMatchObject({ code: 'billing_policy_violation' });
  expect(f.store.get('tasks', f.task.id)).toMatchObject({ attempts: 1, attemptLimit: 3, spentUsd: original.spentUsd, billingStop: original.billingStop, billingBoundary: 'included-only' });
  expect(f.store.list('outbox')).toHaveLength(1); expect(f.store.list('actions').filter(a => a.kind === 'billing_hold')).toHaveLength(1);
});

it('fail preserves the hard billing incident and emits no second automatic retry promise', async () => {
  const f = fixture({ persistent: true }), billing = authority(f), engine = engineFor(f, billing, [{ name: 'codex', async run() { return { ...successful(f), costUsd: 0.2 }; } }]);
  await engine.tick(); const task = f.store.get('tasks', f.task.id)!;
  expect(task).toMatchObject({ status: 'blocked', error: 'billing_policy_violation', billingStop: { code: 'billing_policy_violation' } });
  expect(f.store.list('outbox')).toHaveLength(1);
  expect(f.store.list('outbox')[0]?.text).not.toContain('下次重试');
});

it.each(['quota', 'expired-credential'] as const)('persists %s quarantine through reopen, stale receipt replacement and retry, then requires all fresh observations', async reason => {
  const f = fixture({ persistent: true, maxAttemptsPerTask: 3 }), old = authority(f);
  await expect(refuse(f, old, reason)).rejects.toBeInstanceOf(SubscriptionAccessError);
  f.reopen(); const current = authority(f), calls = vi.fn(async () => successful(f));
  expect(f.store.list('actions')[0]).toMatchObject({ kind: 'billing_profile_unavailable', status: 'pending' });
  const engine = engineFor(f, current, [{ name: 'codex', run: calls }]);
  f.store.save('tasks', { ...f.store.get('tasks', f.task.id)!, status: 'blocked' }); engine.retry(f.task.id); await engine.tick();
  expect(calls).not.toHaveBeenCalled(); expect(f.store.get('tasks', f.task.id)?.billingStop).toBeUndefined();
  f.included.billing = { mode: 'included-subscription', admissionId: 'synthetic-new-receipt' };
  f.writeProof({ ...f.proof, id: 'synthetic-new-receipt' });
  // Keep the same profile, but a new receipt file ID alone does not restore it.
  const { writeFileSync } = await import('node:fs'); writeFileSync(join(f.root, 'synthetic-new-receipt.json'), JSON.stringify({ ...f.proof, id: 'synthetic-new-receipt' }), { mode: 0o600 });
  await expect(current.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'subscription_profile_unavailable' });
  f.included.billing = { mode: 'included-subscription', admissionId: 'synthetic-proof' }; refresh(f);
  expect(await current.status(f.project, f.included)).toMatchObject({ state: 'included-admitted' });
  expect(f.store.list('actions')[0]?.status).toBe('pending'); // Read-only status never restores or allocates.
  await current.runLima(f.input, 'codex', undefined, undefined, calls);
  expect(calls).toHaveBeenCalledTimes(1); expect(f.store.get('tasks', f.task.id)?.attempts).toBe(2);
  expect(f.store.list('actions')[0]).toMatchObject({ status: 'completed', payload: { reason, restoredAt: f.at.toISOString() } });
});

it.each(['incident', 'quarantine'] as const)('ephemeral %s metadata survives persistence without source text', async kind => {
  const f = fixture({ persistent: true, retention: 'ephemeral' }), billing = authority(f);
  if (kind === 'quarantine') await expect(refuse(f, billing)).rejects.toBeInstanceOf(SubscriptionAccessError);
  else await expect(billing.runLima(f.input, 'codex', undefined, undefined, async () => ({ ...successful(f), costUsd: 0.3 }))).rejects.toMatchObject({ code: 'billing_policy_violation' });
  const before = f.store.list('actions'); f.reopen();
  expect(f.store.list('actions')).toEqual(before); expect(f.store.get('tasks', f.task.id)).toMatchObject({ attempts: 1, attemptLimit: 32, spentUsd: kind === 'incident' ? 0.3 : 0 });
  if (kind === 'incident') { expect(f.store.get('tasks', f.task.id)?.billingStop?.code).toBe('billing_policy_violation'); expect(f.store.list('outbox')[0]?.text).toContain('boundary violation'); }
  expect(f.store.get('sources', f.source.id)?.content).toBe('');
});

it('a manual retry at the last consumed slot durably records one cap stop even before a scan notices exhaustion', async () => {
  const f = fixture({ persistent: true, maxAttemptsPerTask: 1 }), billing = authority(f);
  await billing.runLima(f.input, 'codex', undefined, undefined, async () => successful(f));
  f.store.save('tasks', { ...f.store.get('tasks', f.task.id)!, status: 'blocked' });
  const engine = engineFor(f, billing);
  expect(() => engine.retry(f.task.id)).toThrowError(expect.objectContaining({ code: 'subscription_attempt_limit', status: 409 }));
  expect(f.store.get('tasks', f.task.id)?.billingStop?.code).toBe('subscription_attempt_limit');
  f.reopen(); expect(f.store.get('tasks', f.task.id)?.billingStop?.code).toBe('subscription_attempt_limit');
  expect(f.store.list('outbox')).toHaveLength(1);
});
it('a raw DomainError from a worker never reaches task, events or outbox', async () => {
  const f = fixture(), billing = authority(f), engine = engineFor(f, billing, [{ name: 'codex', async run() { throw new DomainError('RAW-PROVIDER-SECRET account fingerprint', 'private-provider-detail'); } }]);
  await engine.tick();
  expect(JSON.stringify({ task: f.store.get('tasks', f.task.id), events: f.store.list('events'), outbox: f.store.list('outbox') })).not.toContain('RAW-PROVIDER-SECRET');
});

it('ephemeral abandoned attempt retains its safe accounting marker after a second reopen', async () => {
  const f = fixture({ persistent: true, retention: 'ephemeral' }), first = await authority(f).reserve(f.input, 'codex');
  f.reopen(); const billing = authority(f); billing.reconcileAbandoned(); f.reopen();
  expect(f.store.get('attempts', first.attempt.id)).toMatchObject({ status: 'failed', costUsd: 0, error: 'attempt_abandoned_after_host_restart', billing: { ordinal: 1, abandonedAt: f.at.toISOString() } });
});

it.each(['missing', 'stale'] as const)('leased restart does not admit an included attempt with %s fresh proof', async proof => {
  const f = fixture({ persistent: true, maxAttemptsPerTask: 3, manualLease: true }); let lease = acquireHostLease(join(f.root, 'lease'));
  try {
    await authority(f).reserve(f.input, 'codex'); lease.release(); f.reopen(); lease = acquireHostLease(join(f.root, 'lease'));
    const billing = new BillingAuthority(f.store, f.config, proof === 'missing' ? { async read() { return undefined; } } : f.currentProvider, { proofRoot: f.proofRoot, now: f.now });
    billing.reconcileAbandoned(); if (proof === 'stale') f.setTime(new Date(f.at.getTime() + 61000));
    const launches = vi.fn(async () => successful(f));
    await expect(billing.runLima(f.input, 'codex', undefined, undefined, launches)).rejects.toMatchObject({ code: 'subscription_unverified' });
    expect(launches).not.toHaveBeenCalled(); expect(f.store.get('tasks', f.task.id)?.attempts).toBe(1);
  } finally { lease.release(); }
});
it('a failed reconciliation keeps the fresh authority closed with no further allocation', async () => {
  const f = fixture({ persistent: true }); await authority(f).reserve(f.input, 'codex'); f.reopen();
  const billing = authority(f), transaction = vi.spyOn(f.store, 'transaction').mockImplementationOnce(() => { throw Error('Synthetic database failure'); });
  expect(() => billing.reconcileAbandoned()).toThrowError(expect.objectContaining({ code: 'attempt_recovery_required' })); transaction.mockRestore();
  await expect(billing.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'billing_policy_violation' }); expect(f.store.get('tasks', f.task.id)?.attempts).toBe(1);
});
it('a separately included backup remains eligible after refused-profile SQLite reopen, with no metered escape', async () => {
  const f = fixture({ persistent: true, maxAttemptsPerTask: 3 }); await expect(refuse(f, authority(f))).rejects.toBeInstanceOf(SubscriptionAccessError); f.reopen();
  const backup: RunnerPolicy = { ...f.included, runner: 'grok', billing: { mode: 'included-subscription', admissionId: 'synthetic-backup' } };
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(f.root, 'synthetic-backup.json'), JSON.stringify({ ...f.proof, id: 'synthetic-backup', runner: 'grok', accountFingerprint: 'synthetic-independent-backup' }), { mode: 0o600 });
  f.config.runnerPolicies.push(backup, { ...f.included, runner: 'dsh', costPerRunUsd: 1, billing: { mode: 'metered-api' } });
  const billing = new BillingAuthority(f.store, f.config, { async read(policy) { return policy.runner === 'grok' ? { ...f.current, runner: 'grok', accountFingerprint: 'synthetic-independent-backup' } : structuredClone(f.current); } }, { proofRoot: f.root, now: f.now });
  const calls: string[] = [], scheduler = new Scheduler(f.store, f.config, [
    { name: 'grok', async run() { calls.push('backup'); return successful(f); } },
    { name: 'codex', async run() { calls.push('refused'); return successful(f); } },
    { name: 'dsh', async run() { calls.push('metered'); return successful(f); } },
  ], billing);
  const input: WorkerInput = { ...f.input, task: f.store.get('tasks', f.task.id)! };
  expect(await scheduler.run(input.task, f.project, input)).toEqual({ cards: [] }); expect(calls).toEqual(['backup']);
  expect(f.store.get('tasks', f.task.id)).toMatchObject({ attempts: 2, attemptLimit: 3, spentUsd: 0 }); expect(f.store.get('tasks', f.task.id)?.billingStop).toBeUndefined();
  expect(f.store.list('actions')[0]).toMatchObject({ kind: 'billing_profile_unavailable', status: 'pending' });
  expect(f.store.list('outbox').filter(row => row.text.includes('已继续'))).toHaveLength(1);
});
it.each(['allowance', 'receipt', 'principal', 'current'] as const)('quarantine cannot be restored when the %s observation predates refusal', async missing => {
  const f = fixture({ persistent: true }), original = f.at.toISOString(); await expect(refuse(f, authority(f))).rejects.toBeInstanceOf(SubscriptionAccessError); f.reopen(); refresh(f);
  if (missing === 'allowance') f.proof.allowance.checkedAt = original;
  if (missing === 'receipt') f.proof.verifiedAt = original;
  if (missing === 'principal') f.current.principalVerifiedAt = original;
  if (missing === 'current') f.current.checkedAt = original;
  f.writeProof();
  await expect(authority(f).reserve(f.input, 'codex')).rejects.toBeInstanceOf(DomainError);
  expect(f.store.get('tasks', f.task.id)?.attempts).toBe(1); expect(f.store.list('actions')[0]?.status).toBe('pending');
});
it.each(['cap', 'runtime', 'role', 'checker'] as const)('fresh availability evidence never bypasses the independent %s gate', async gate => {
  const f = fixture({ persistent: true, maxAttemptsPerTask: gate === 'cap' ? 1 : 3 }); await expect(refuse(f, authority(f))).rejects.toBeInstanceOf(SubscriptionAccessError); f.reopen(); refresh(f);
  const billing = authority(f), launches = vi.fn(async () => successful(f));
  if (gate === 'role') f.included.roles = ['decide'];
  if (gate === 'checker') {
    f.included.roles = ['check']; const task = { ...f.store.get('tasks', f.task.id)!, stage: 'check' as const }; f.store.save('tasks', task);
    const attempt = f.store.list('attempts')[0]!; f.store.save('attempts', { ...attempt, role: 'execute', status: 'succeeded' });
    const input: WorkerInput = { ...f.input, role: 'check', task };
    await expect(billing.runLima(input, 'codex', undefined, undefined, launches)).rejects.toMatchObject({ code: 'independent_review_required' });
  } else await expect(billing.runLima(f.input, 'codex', undefined, undefined, gate === 'runtime' ? async () => { throw new DomainError('Synthetic orphan runtime stop', 'worker_cleanup_unconfirmed'); } : launches)).rejects.toBeInstanceOf(DomainError);
  expect(launches).not.toHaveBeenCalled();
  expect(f.store.get('tasks', f.task.id)?.attempts).toBe(gate === 'runtime' ? 2 : 1);
});
