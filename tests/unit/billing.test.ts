import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, chownSync, linkSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
vi.mock('node:fs', async importOriginal => { const actual = await importOriginal<typeof import('node:fs')>(); return { ...actual, readSync: vi.fn(actual.readSync), closeSync: vi.fn(actual.closeSync) }; });
import { join } from 'node:path';
import { BillingAuthority, billingSwitchInputHash, evaluateBilling, loadIncludedAdmission, type HostDispatchPermit, type CurrentBillingContext, type IncludedAdmission } from '../../src/billing.js';
import { ingestSource } from '../../src/intake.js';
import { digest, stableId, DomainError, roles, SubscriptionAccessError, WorkerUnavailable, type HostSubscriptionObservation, type Runner, type RunnerPolicy, type WorkerAdapter, type WorkerResult } from '../../src/domain.js';
import { structuredKnowledgeJobId } from '../../src/knowledge-jobs.js';
import { Scheduler } from '../../src/scheduler.js';
import { Store } from '../../src/store.js';
import { makeBillingFixture } from '../fixtures/billing.js';
const fixtures: ReturnType<typeof makeBillingFixture>[] = [];
function fixture() { const f = makeBillingFixture(); fixtures.push(f); return f; }
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) f.dispose(); });
function evaluate(f: ReturnType<typeof fixture>) { return evaluateBilling(f.included, f.task, f.project, f.proof, f.current, f.at); }
function financialActions(store:Store){return store.list('actions').filter(row=>row.kind==='billing_hold'||row.kind==='billing_profile_unavailable');}
function oneFinancialAction(store:Store,kind:'billing_hold'|'billing_profile_unavailable'){
  const rows=financialActions(store);expect(rows).toHaveLength(1);const row=rows[0]!;expect(row.kind).toBe(kind);
  const p=row.payload;expect(p.attemptId).toEqual(expect.any(String));
  expect(row.id).toBe(kind==='billing_profile_unavailable'?stableId('billing-profile-refusal',row.projectId,row.domain,p.profileHash,p.attemptId):p.profileHash?stableId('billing-hold',row.projectId,row.domain,p.profileHash):stableId('billing-admission-hold',row.projectId,row.domain,p.admissionId));
  return row;
}
function expectIndependentJob(f:ReturnType<typeof fixture>,financialKind?:'billing_hold'|'billing_profile_unavailable'){
  const financial=financialKind?[oneFinancialAction(f.store,financialKind)]:[];
  const job=expect.objectContaining({id:structuredKnowledgeJobId(f.source),kind:'knowledge.structured-ingest',projectId:f.source.projectId,domain:f.source.domain,status:'pending',payload:expect.objectContaining({schemaVersion:1,sourceId:f.source.id,sourceRevision:f.source.revision,sourceHash:digest(f.source.content),sourceRefs:[{id:f.source.id,revision:f.source.revision}],phase:'queued',tries:0})});
  const actions=f.store.list('actions');expect(actions).toHaveLength(1+financial.length);expect(actions).toEqual(expect.arrayContaining([job,...financial]));
}

it('rejects an unexpected authority row when checking the complete action population',()=>{
  const f=fixture();f.store.save('actions',{id:'unexpected-link',projectId:f.project.id,domain:f.project.domain,kind:'knowledge.evidence-link',status:'completed',payload:{unexpected:true},updatedAt:f.at.toISOString()});
  expect(()=>expectIndependentJob(f)).toThrow();
});

describe('bounded billing decision', () => {
  it('permits strict included zero with independent matching proof/current context', () => { expect(evaluate(fixture())).toEqual({ allowed: true, reserveUsd: 0, mode: 'included-subscription' }); });
  it('denies missing proof and missing current provider capability', () => { const f = fixture(); expect(evaluateBilling(f.included, f.task, f.project, undefined, f.current, f.at)).toMatchObject({ allowed: false, code: 'subscription_unverified' }); expect(evaluateBilling(f.included, f.task, f.project, f.proof, undefined, f.at)).toMatchObject({ allowed: false }); });
  it('never infers included from missing/explicit metered zero even in test mode', () => { const f = fixture(); f.task.billingBoundary = 'metered-only'; for (const billing of [undefined, { mode: 'metered-api' as const }]) expect(evaluateBilling({ ...f.included, billing }, f.task, f.project, f.proof, f.current, f.at)).toMatchObject({ allowed: false, code: 'billing_policy_invalid' }); });
  it('forbids metered candidates under included boundary even with positive budgets', () => { const f = fixture(); f.task.budgetUsd = f.project.budgetUsd = 100; expect(evaluateBilling({ ...f.included, billing: undefined, costPerRunUsd: 1 }, f.task, f.project, f.proof, f.current, f.at)).toMatchObject({ allowed: false, code: 'billing_route_forbidden' }); });
  it('requires separately authorized metered boundary, positive finite reservation and both money caps', () => { const f = fixture(); f.task.billingBoundary = 'metered-only'; f.task.budgetUsd = f.project.budgetUsd = 1; const p = { ...f.included, billing: undefined, costPerRunUsd: 1 }; expect(evaluateBilling(p, f.task, f.project, undefined, undefined, f.at)).toMatchObject({ allowed: true, reserveUsd: 1 }); for (const cap of [0, .99, NaN, Infinity, -1]) { f.project.budgetUsd = cap; expect(evaluateBilling(p, f.task, f.project, undefined, undefined, f.at)).toMatchObject({ allowed: false }); } });
  it.each(['ownerFingerprint', 'accountFingerprint', 'workspaceFingerprint', 'authRouteFingerprint', 'cliVersion', 'commandPolicyHash', 'networkPolicyHash', 'runtimeIdentityHash', 'provider', 'model', 'domain', 'projectId', 'runner'] as const)('rejects independently changed current binding %s', field => { const f = fixture(); Object.assign(f.current, { [field]: field === 'runner' ? 'grok' : 'different' }); expect(evaluate(f)).toMatchObject({ allowed: false, code: 'subscription_scope' }); });
  it('rejects project/task/policy scope mismatches and unadmitted policies', () => { const f = fixture(); f.task.domain = 'other'; expect(evaluate(f)).toMatchObject({ allowed: false }); f.task.domain = f.project.domain; f.included.admitted = false; expect(evaluate(f)).toMatchObject({ allowed: false }); });
  it('rejects unpinned included tasks rather than selecting a route from zero', () => { const f = fixture(); delete f.task.billingBoundary; expect(evaluate(f)).toMatchObject({ allowed: false }); });
  it('allows last slot, rejects exhausted and corrupt counters', () => { const f = fixture(); f.task.attemptLimit = 2; f.task.attempts = 1; expect(evaluate(f)).toMatchObject({ allowed: true }); f.task.attempts = 2; expect(evaluate(f)).toMatchObject({ allowed: false, code: 'subscription_attempt_limit' }); for (const n of [-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) { f.task.attempts = n; expect(evaluate(f)).toMatchObject({ allowed: false }); } });
  it.each([0, 257, 1.5, NaN, Infinity])('denies corrupt persisted limit %s', attemptLimit => { const f = fixture(); f.task.attemptLimit = attemptLimit; expect(evaluate(f)).toMatchObject({ allowed: false }); });
  it('denies durable task stop and terminal task', () => { const f = fixture(); f.task.billingStop = { code: 'subscription_auth', at: f.at.toISOString() }; expect(evaluate(f)).toMatchObject({ allowed: false }); delete f.task.billingStop; f.task.status = 'cancelled'; expect(evaluate(f)).toMatchObject({ allowed: false }); });
  it('requires receipt verifiedAt <= now < expiry with allowance no later than verification', () => { const f = fixture(); f.proof.verifiedAt = f.at.toISOString(); f.proof.allowance.checkedAt = f.at.toISOString(); expect(evaluate(f)).toMatchObject({ allowed: true }); f.proof.expiresAt = f.at.toISOString(); expect(evaluate(f)).toMatchObject({ allowed: false, code: 'subscription_expired' }); f.proof.expiresAt = new Date(f.at.getTime() + 1000).toISOString(); f.proof.allowance.checkedAt = new Date(f.at.getTime() + 1).toISOString(); expect(evaluate(f)).toMatchObject({ allowed: false }); });
  it.each(['checkedAt', 'principalVerifiedAt'] as const)('checks exact 60-second current freshness and receipt ordering for %s', field => { const f = fixture(); f.proof.verifiedAt = new Date(f.at.getTime() - 61000).toISOString(); f.proof.allowance.checkedAt = f.proof.verifiedAt; f.current[field] = new Date(f.at.getTime() - 60000).toISOString(); expect(evaluate(f)).toMatchObject({ allowed: true }); f.current[field] = new Date(f.at.getTime() - 60001).toISOString(); expect(evaluate(f)).toMatchObject({ allowed: false }); f.current[field] = new Date(f.at.getTime() + 1).toISOString(); expect(evaluate(f)).toMatchObject({ allowed: false }); f.current[field] = 'bad-date'; expect(evaluate(f)).toMatchObject({ allowed: false }); });
  it('requires provider enforced no-charge states and strict evidence schemas', () => { const f = fixture(); Object.assign(f.proof, { extra: true }); expect(evaluate(f)).toMatchObject({ allowed: false }); delete (f.proof as unknown as Record<string, unknown>).extra; Object.assign(f.current, { paidOverflow: 'enabled' }); expect(evaluate(f)).toMatchObject({ allowed: false }); });
  it.each(['ownerFingerprint', 'accountFingerprint', 'workspaceFingerprint', 'authRouteFingerprint', 'cliVersion', 'commandPolicyHash', 'networkPolicyHash', 'runtimeIdentityHash'] as const)('denies a second otherwise identical receipt with changed %s', field => {
    const f = fixture(); const different = { ...f.proof, [field]: 'second-synthetic-binding' };
    expect(evaluateBilling(f.included, f.task, f.project, different, f.current, f.at)).toMatchObject({ allowed: false, code: 'subscription_scope' });
  });
  it('rejects future verification, current observation preceding verification and invalid host time', () => {
    const f = fixture(); f.proof.verifiedAt = new Date(f.at.getTime() + 1).toISOString();
    expect(evaluate(f)).toMatchObject({ allowed: false });
    f.proof.verifiedAt = f.at.toISOString(); f.current.principalVerifiedAt = new Date(f.at.getTime() - 1).toISOString();
    expect(evaluate(f)).toMatchObject({ allowed: false });
    expect(evaluateBilling(f.included, f.task, f.project, f.proof, f.current, new Date(NaN))).toMatchObject({ allowed: false });
  });
  it('does not normalize explicit null task bindings or limits into defaults', () => {
    const f = fixture(); Object.assign(f.task, { attemptLimit: null }); expect(evaluate(f)).toMatchObject({ allowed: false });
    f.task.attemptLimit = 32; Object.assign(f.task, { billingBoundary: null }); expect(evaluate(f)).toMatchObject({ allowed: false });
  });
  it.each(['paidOverflow', 'additionalCredits', 'autoRefill'] as const)('requires disabled current and receipt %s', field => {
    const f = fixture(); Object.assign(f.current, { [field]: 'enabled' }); expect(evaluate(f)).toMatchObject({ allowed: false });
    Object.assign(f.current, { [field]: 'disabled' }); Object.assign(f.proof.noAdditionalBilling, { [field]: 'unverified' }); expect(evaluate(f)).toMatchObject({ allowed: false });
  });
  it('checks both positive metered caps and finite spent accounting including exact limit', () => {
    const f = fixture(); f.task.billingBoundary = 'metered-only'; f.project.budgetUsd = 10; f.task.budgetUsd = 1; f.task.spentUsd = .5;
    const p = { ...f.included, billing: { mode: 'metered-api' as const }, costPerRunUsd: .5 };
    expect(evaluateBilling(p, f.task, f.project, undefined, undefined, f.at)).toMatchObject({ allowed: true });
    f.task.spentUsd = .50001; expect(evaluateBilling(p, f.task, f.project, undefined, undefined, f.at)).toMatchObject({ allowed: false });
    for (const spent of [NaN, Infinity, -1]) { f.task.spentUsd = spent; expect(evaluateBilling(p, f.task, f.project, undefined, undefined, f.at)).toMatchObject({ allowed: false }); }
  });
  it('uses typed provider observations without model JSON permits', () => { expect(new SubscriptionAccessError({ disposition: 'verified-no-charge-refusal', reason: 'quota', observedAt: new Date().toISOString(), evidenceDigest: 'synthetic-refusal', noChargeEvidenceDigest: 'synthetic-no-charge' }, 'Synthetic')).toMatchObject({ code: 'subscription_unavailable', status: 409 }); const f = fixture(); expect(f.input).not.toHaveProperty('permit'); });
});

describe('private receipt loader mechanics', () => {
  it('loads only an owner-private synthetic receipt', () => { const f = fixture(); expect(loadIncludedAdmission(f.root, f.proof.id, [])).toEqual(f.proof); });
  it('loads a receipt when an unrelated sibling changes its private ancestor during read', () => {
    const f = fixture(), root = join(f.root, 'receipts'); mkdirSync(root, { mode: 0o700 });
    writeFileSync(join(root, `${f.proof.id}.json`), JSON.stringify(f.proof), { mode: 0o600 });
    const before = fs.lstatSync(f.root), read = fs.readSync; let changed = false;
    vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      if (!changed) { changed = true; mkdirSync(join(f.root, 'unrelated-synthetic-sibling'), { mode: 0o700 }); }
      return Reflect.apply(read, fs, args);
    });
    const result = loadIncludedAdmission(root, f.proof.id, []), after = fs.lstatSync(f.root);
    const metadata = ['size', 'nlink', 'mtimeMs', 'ctimeMs'] as const;
    const differences = metadata.filter(field => before[field] !== after[field]);
    expect(changed).toBe(true);
    expect(differences.length).toBeGreaterThan(0);
    for (const field of ['dev', 'ino', 'uid', 'gid', 'mode'] as const) expect(after[field]).toBe(before[field]);
    expect(result).toEqual(f.proof);
  });
  it.each(['ancestor', 'root'])('rejects private %s permission changes during bounded read', location => {
    const f = fixture(), root = join(f.root, 'receipts'); mkdirSync(root, { mode: 0o700 });
    writeFileSync(join(root, `${f.proof.id}.json`), JSON.stringify(f.proof), { mode: 0o600 });
    const read = fs.readSync; let changed = false;
    vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      if (!changed) { changed = true; chmodSync(location === 'root' ? root : f.root, 0o755); }
      return Reflect.apply(read, fs, args);
    });
    expect(loadIncludedAdmission(root, f.proof.id, [])).toBeUndefined();
    expect(changed).toBe(true);
  });
  it.each(['valid', 'malformed'])('sanitizes one close failure after a %s synthetic receipt and permits loading after restore', receipt => {
    const f = fixture();
    if (receipt === 'malformed') writeFileSync(f.proofPath, '{');
    const close = fs.closeSync;
    const closeFailure = vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
      close(fd);
      throw new Error('synthetic-private-close-marker-7d4a');
    });
    try {
      let result: ReturnType<typeof loadIncludedAdmission>;
      expect(() => { result = loadIncludedAdmission(f.root, f.proof.id, []); }).not.toThrow();
      expect(result).toBeUndefined();
      expect(closeFailure).toHaveBeenCalledTimes(1);
    } finally { closeFailure.mockRestore(); }
    f.writeProof();
    expect(loadIncludedAdmission(f.root, f.proof.id, [])).toEqual(f.proof);
  });
  it.each(['../synthetic-proof', '/absolute', 'a/b', 'x.json', '', 'a'.repeat(65)])('rejects ID traversal or invalid ID %j', id => { const f = fixture(); expect(loadIncludedAdmission(f.root, id, [])).toBeUndefined(); });
  it('denies absent, malformed, oversized, unknown schema, mismatched ID and expired receipts', () => { const f = fixture(); for (const value of ['{', ' '.repeat(65537), JSON.stringify({ ...f.proof, extra: true }), JSON.stringify({ ...f.proof, id: 'different' }), JSON.stringify({ ...f.proof, expiresAt: new Date(0).toISOString() })]) { writeFileSync(f.proofPath, value); expect(loadIncludedAdmission(f.root, f.proof.id, [])).toBeUndefined(); } rmSync(f.proofPath); expect(loadIncludedAdmission(f.root, f.proof.id, [])).toBeUndefined(); });
  it.each([0o644, 0o640, 0o400, 0o666])('denies file mode %s', mode => { const f = fixture(); chmodSync(f.proofPath, mode); expect(loadIncludedAdmission(f.root, f.proof.id, [])).toBeUndefined(); });
  it('denies permissive root, symlinked root/parent/file, hardlinks and excluded containment', () => { const f = fixture(); chmodSync(f.root, 0o755); expect(loadIncludedAdmission(f.root, f.proof.id, [])).toBeUndefined(); chmodSync(f.root, 0o700); expect(loadIncludedAdmission(f.root, f.proof.id, [f.root])).toBeUndefined(); const sibling = join(f.root, 'link.json'); linkSync(f.proofPath, sibling); expect(loadIncludedAdmission(f.root, f.proof.id, [])).toBeUndefined(); rmSync(sibling); renameSync(f.proofPath, sibling); symlinkSync(sibling, f.proofPath); expect(loadIncludedAdmission(f.root, f.proof.id, [])).toBeUndefined(); rmSync(f.proofPath); renameSync(sibling, f.proofPath); const parent = join(f.root, 'parent'); mkdirSync(parent, { mode: 0o700 }); symlinkSync(f.root, join(parent, 'alias')); expect(loadIncludedAdmission(join(parent, 'alias'), f.proof.id, [])).toBeUndefined(); });
  it('rejects final file replacement during bounded read', () => { const f = fixture(); const read = fs.readSync; let replaced = false; vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => { if (!replaced) { replaced = true; renameSync(f.proofPath, join(f.root, 'old.json')); f.writeProof(); } return Reflect.apply(read, fs, args); }); expect(loadIncludedAdmission(f.root, f.proof.id, [])).toBeUndefined(); });
  it('rejects private root inode replacement during bounded read', () => {
    const f = fixture(), root = join(f.root, 'receipts'); mkdirSync(root, { mode: 0o700 });
    writeFileSync(join(root, `${f.proof.id}.json`), JSON.stringify(f.proof), { mode: 0o600 });
    const read = fs.readSync; let replaced = false;
    vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      if (!replaced) { replaced = true; renameSync(root, join(f.root, 'old-root')); mkdirSync(root, { mode: 0o700 }); writeFileSync(join(root, `${f.proof.id}.json`), JSON.stringify(f.proof), { mode: 0o600 }); }
      return Reflect.apply(read, fs, args);
    });
    expect(loadIncludedAdmission(root, f.proof.id, [])).toBeUndefined();
  });
  it('accepts exactly 64 KiB but refuses directories and private-parent permission changes', () => {
    const f = fixture(), json = JSON.stringify(f.proof);
    writeFileSync(f.proofPath, json + ' '.repeat(65536 - Buffer.byteLength(json)));
    expect(loadIncludedAdmission(f.root, f.proof.id, [])).toEqual(f.proof);
    rmSync(f.proofPath); mkdirSync(f.proofPath, { mode: 0o700 }); expect(loadIncludedAdmission(f.root, f.proof.id, [])).toBeUndefined();
    rmSync(f.proofPath, { recursive: true }); f.writeProof(); const child = join(f.root, 'child'); mkdirSync(child, { mode: 0o700 });
    writeFileSync(join(child, `${f.proof.id}.json`), json, { mode: 0o600 }); chmodSync(f.root, 0o755);
    expect(loadIncludedAdmission(child, f.proof.id, [])).toBeUndefined();
  });
  it('rejects known sync storage and symlink aliases into excluded roots', () => {
    const f = fixture(), root = join(f.root, 'Dropbox'); mkdirSync(root, { mode: 0o700 });
    writeFileSync(join(root, `${f.proof.id}.json`), JSON.stringify(f.proof), { mode: 0o600 });
    expect(loadIncludedAdmission(root, f.proof.id, [])).toBeUndefined();
    const alias = join(f.root, 'excluded-alias'); symlinkSync(root, alias);
    expect(loadIncludedAdmission(root, f.proof.id, [alias])).toBeUndefined();
  });
  it.skipIf(process.geteuid?.() !== 0)('rejects wrong owner (requires root chown capability)', () => { const f = fixture(); chownSync(f.proofPath, 65534, 65534); expect(loadIncludedAdmission(f.root, f.proof.id, [])).toBeUndefined(); });
});

describe('host task route pinning', () => {
  it('resolves only an absent host boundary to legacy metered-only', () => {
    const f = fixture(); const input = { projectId: f.project.id, externalId: 'legacy', title: 'Synthetic', content: 'Synthetic' };
    const config = { projects: f.config.projects };
    expect(ingestSource(f.store, config, input)?.billingBoundary).toBe('metered-only');
    expect(() => ingestSource(f.store, { ...config, billingBoundary: null } as never, { ...input, externalId: 'invalid' })).toThrow();
  });
  it('pins from host despite extra caller payload and preserves frozen route on reconstructed versions', () => { const f = fixture(); expect(f.task.billingBoundary).toBe('included-only'); const config = { ...f.config, billingBoundary: 'metered-only' as const }; const input = { projectId: f.project.id, externalId: 'ephemeral', title: 'Synthetic ephemeral', content: 'Synthetic', retention: 'ephemeral' as const, billingBoundary: 'included-only' }; const task = ingestSource(f.store, config, input)!; expect(task.billingBoundary).toBe('metered-only'); const source = f.store.get('sources', task.sourceId)!; f.store.save('sources', { ...source, content: '' }); const rebuilt = ingestSource(f.store, f.config, input)!; expect(rebuilt.version).toBe(task.version + 1); expect(rebuilt.billingBoundary).toBe('metered-only'); });
});

function authority(f: ReturnType<typeof fixture>) { return new BillingAuthority(f.store, f.config, f.currentProvider, { proofRoot: f.root, now: f.now }); }
function result(f: ReturnType<typeof fixture>, costUsd = 0): WorkerResult { return { output: { cards: [] }, provider: f.included.provider, model: f.included.model, costUsd }; }
function adapter(f: ReturnType<typeof fixture>, run = async () => result(f)): WorkerAdapter { return { name: 'codex', run }; }
function paid(f: ReturnType<typeof fixture>) {
  f.config.billingBoundary = f.task.billingBoundary = 'metered-only'; f.task.budgetUsd = f.project.budgetUsd = 100;
  f.included.billing = { mode: 'metered-api' }; f.included.costPerRunUsd = 1;
  f.store.save('projects', f.project); f.store.save('tasks', f.task);
}
function backup(f: ReturnType<typeof fixture>, sameProfile = false) {
  const policy: RunnerPolicy = { ...f.included, runner: 'grok' as const, billing: { mode: 'included-subscription' as const, admissionId: 'synthetic-backup' } };
  const proof: IncludedAdmission = { ...f.proof, id: 'synthetic-backup', runner: 'grok' as const, accountFingerprint: sameProfile ? f.proof.accountFingerprint : 'synthetic-backup-account' };
  const current: CurrentBillingContext = { ...f.current, runner: 'grok' as const, accountFingerprint: sameProfile ? f.current.accountFingerprint : 'synthetic-backup-account' };
  writeFileSync(join(f.root, 'synthetic-backup.json'), JSON.stringify(proof), { mode: 0o600 });
  // Grok is first in knowledge extraction, so move the original synthetic profile to it.
  const originalProof = { ...f.proof, runner: 'grok' as const }, originalCurrent = { ...f.current, runner: 'grok' as const };
  f.included.runner = 'grok'; f.writeProof(originalProof); Object.assign(f.current, originalCurrent);
  policy.runner = 'codex'; proof.runner = 'codex'; current.runner = 'codex';
  writeFileSync(join(f.root, 'synthetic-backup.json'), JSON.stringify(proof), { mode: 0o600 });
  f.config.runnerPolicies.push(policy);
  return { policy, proof, current, provider: { async read(p: { runner: Runner }) { return structuredClone(p.runner === 'grok' ? f.current : current); } } };
}
function refusal(f: ReturnType<typeof fixture>, reason: Extract<HostSubscriptionObservation, { disposition: 'verified-no-charge-refusal' }>['reason'] = 'quota'): SubscriptionAccessError {
  return new SubscriptionAccessError({ disposition: 'verified-no-charge-refusal', reason, observedAt: f.at.toISOString(), evidenceDigest: 'synthetic-refusal', noChargeEvidenceDigest: 'synthetic-no-charge-refusal' }, 'Synthetic private refusal');
}
function threeCandidates(f: ReturnType<typeof fixture>) {
  const b = backup(f), policy: RunnerPolicy = { ...b.policy, runner: 'dsh', billing: { mode: 'included-subscription', admissionId: 'synthetic-third' } };
  const proof: IncludedAdmission = { ...b.proof, id: 'synthetic-third', runner: 'dsh', accountFingerprint: 'synthetic-third-account' };
  const current: CurrentBillingContext = { ...b.current, runner: 'dsh', accountFingerprint: 'synthetic-third-account' };
  f.config.runnerPolicies.push(policy); writeFileSync(join(f.root, 'synthetic-third.json'), JSON.stringify(proof), { mode: 0o600 });
  for (const [p, receipt, observed] of [[f.included, { ...f.proof, runner: 'grok' }, f.current], [policy, proof, current], [b.policy, b.proof, b.current]] as const)
    expect(evaluateBilling(p, f.task, f.project, receipt, observed, f.at)).toMatchObject({ allowed: true, reserveUsd: 0 });
  return { policy, provider: { async read(p: RunnerPolicy) { return structuredClone(p.runner === 'dsh' ? current : await b.provider.read(p)); } } };
}

describe('Store-backed one-use billing authority', () => {
  it('accepts only a Scheduler authority bound to the identical Store and config objects', async () => {
    const f = fixture(), foreign = fixture(); let calls = 0;
    const worker = adapter(f, async () => { calls++; return result(f); });
    const wrongStore = authority(foreign), wrongConfig = new BillingAuthority(f.store, structuredClone(f.config), f.currentProvider, { proofRoot: f.root, now: f.now });
    for (const wrong of [wrongStore, wrongConfig]) expect(() => new Scheduler(f.store, f.config, [worker], wrong)).toThrowError(expect.objectContaining({ code: 'billing_authority_mismatch' }));
    expect(calls).toBe(0); expect(f.store.list('attempts')).toEqual([]); expect(foreign.store.list('attempts')).toEqual([]);
    const correct = new Scheduler(f.store, f.config, [worker], authority(f)); expect(await correct.run(f.task, f.project, f.input)).toEqual({ cards: [] }); expect(calls).toBe(1);
  });
  it('reserves atomically and does not revoke the last legal permit after a denied next reservation', async () => {
    const f = fixture(); f.config.maxAttemptsPerTask = 1; const a = authority(f);
    const reservations = await Promise.allSettled([a.reserve(f.input, 'codex'), a.reserve(f.input, 'codex')]);
    expect(reservations.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.store.list('attempts')).toHaveLength(1); expect(f.store.get('tasks', f.task.id)?.attempts).toBe(1);
    const allocated = reservations.find(r => r.status === 'fulfilled')!;
    if (allocated.status !== 'fulfilled') throw new Error('Expected allocated slot');
    let launches = 0;
    const worker: WorkerAdapter = { name: 'codex', run: (input, signal, permit) => a.runLima(input, 'codex', signal, permit, async () => { launches++; return result(f); }) };
    await expect(a.dispatch(allocated.value, f.input, worker)).resolves.toMatchObject({ costUsd: 0 });
    expect(launches).toBe(1); expect(f.store.get('tasks', f.task.id)?.attempts).toBe(1);
    await expect(a.dispatch(allocated.value, f.input, worker)).rejects.toMatchObject({ code: 'billing_permit_invalid' });
  });
  it('consumes exactly the bounded default 32 attempts even with unchanged caller counters', async () => {
    const f = fixture(), a = authority(f); delete f.config.maxAttemptsPerTask; delete f.task.attemptLimit; f.store.save('tasks', f.task);
    for (let ordinal = 1; ordinal <= 32; ordinal++) {
      const reserved = await a.reserve(f.input, 'codex'); expect(reserved.attempt.billing?.ordinal).toBe(ordinal);
      await a.dispatch(reserved, f.input, adapter(f));
    }
    await expect(a.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'subscription_attempt_limit' });
    expect(f.input.task.attempts).toBe(0); expect(f.store.list('attempts')).toHaveLength(32);
    expect(f.store.get('tasks', f.task.id)).toMatchObject({ attempts: 32, attemptLimit: 32, billingStop: { code: 'subscription_attempt_limit' } });
    expect(f.store.list('outbox')).toHaveLength(1);
  });
  it.each(roles)('admits the last legal %s slot against stored count and denies the next without allocation', async role => {
    const f = fixture(); f.task.stage = f.input.role = role; f.included.roles = [role]; f.task.attempts = 1; f.task.attemptLimit = f.config.maxAttemptsPerTask = 2;
    f.store.save('tasks', f.task); const a = authority(f);
    const reserved = await a.reserve(f.input, 'codex'); expect(reserved.attempt.billing?.ordinal).toBe(2);
    // Claim mechanics are exercised independently of each role's schema.
    await expect(a.runLima(f.input, 'codex', undefined, reserved.permit, async () => result(f))).rejects.toMatchObject({ code: 'billing_permit_invalid' });
    await expect(a.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'subscription_attempt_limit' });
    expect(f.store.list('attempts')).toHaveLength(1);
  });
  it('pins before selection and can tighten but never raise a persisted limit', async () => {
    const f = fixture(); delete f.task.billingBoundary; delete f.task.attemptLimit; f.store.save('tasks', f.task);
    f.config.maxAttemptsPerTask = 3; const a = authority(f); const r = await a.reserve(f.input, 'codex'); await a.dispatch(r, f.input, adapter(f));
    f.config.maxAttemptsPerTask = 10; const r2 = await a.reserve(f.input, 'codex'); expect(r2.attempt.billing?.attemptLimit).toBe(3); await a.dispatch(r2, f.input, adapter(f));
    f.config.maxAttemptsPerTask = 2; await expect(a.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'subscription_attempt_limit' });
    expect(f.store.get('tasks', f.task.id)).toMatchObject({ billingBoundary: 'included-only', attemptLimit: 2, attempts: 2 });
  });
  it('permanently tightens the limit observed at dispatch even if the host subsequently raises it', async () => {
    const f = fixture(); f.config.maxAttemptsPerTask = 3; const a = authority(f), r = await a.reserve(f.input, 'codex');
    f.config.maxAttemptsPerTask = 1; await a.dispatch(r, f.input, adapter(f)); f.config.maxAttemptsPerTask = 3;
    await expect(a.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'subscription_attempt_limit' }); expect(f.store.get('tasks', f.task.id)?.attemptLimit).toBe(1);
  });
  it.each([0, 257, 1.5, NaN, Infinity, null])('fails closed on invalid hand-built host limit %s', async limit => {
    const f = fixture(); Object.assign(f.config, { maxAttemptsPerTask: limit });
    await expect(authority(f).reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'billing_counter_invalid' }); expect(f.store.list('attempts')).toEqual([]);
  });
  it('rejects forged, copied, wrong-authority and concurrently replayed capabilities before launch', async () => {
    const f = fixture(), a = authority(f), other = authority(f), r = await a.reserve(f.input, 'codex'); let calls = 0;
    const launch = async () => { calls++; return result(f); };
    for (const permit of [{}, structuredClone(r.permit)] as HostDispatchPermit[]) await expect(a.runLima(f.input, 'codex', undefined, permit, launch)).rejects.toMatchObject({ code: 'billing_permit_invalid' });
    await expect(other.dispatch(r, f.input, adapter(f, launch))).rejects.toMatchObject({ code: 'billing_permit_invalid' });
    const worker: WorkerAdapter = { name: 'codex', run: async (input, signal, permit) => {
      const claims = await Promise.allSettled([a.runLima(input, 'codex', signal, permit, launch), a.runLima(input, 'codex', signal, permit, launch)]);
      expect(claims.filter(c => c.status === 'fulfilled')).toHaveLength(1); return result(f);
    } };
    await a.dispatch(r, f.input, worker); expect(calls).toBe(1);
  });
  it('a concurrent duplicate dispatch cannot fail or consume the original valid dispatch', async () => {
    const f = fixture(), a = authority(f), r = await a.reserve(f.input, 'codex'); let calls = 0;
    const attempts = await Promise.allSettled([a.dispatch(r, f.input, adapter(f, async () => { calls++; return result(f); })), a.dispatch(r, f.input, adapter(f))]);
    expect(attempts.filter(x => x.status === 'fulfilled')).toHaveLength(1); expect(calls).toBe(1); expect(f.store.get('attempts', r.attempt.id)?.status).toBe('succeeded');
  });
  it.each(['input', 'task', 'source', 'policy', 'runtime', 'proof', 'current', 'boundary'] as const)('revalidates changed %s before dispatch and retains the reservation', async changed => {
    const f = fixture(); paid(f); if (['proof', 'current'].includes(changed)) { f.config.billingBoundary = f.task.billingBoundary = 'included-only'; f.included.billing = { mode: 'included-subscription', admissionId: f.proof.id }; f.included.costPerRunUsd = 0; f.store.save('tasks', f.task); }
    const a = authority(f), r = await a.reserve(f.input, 'codex'); let calls = 0;
    if (changed === 'input') f.input.cards.push({} as never);
    if (changed === 'task') f.store.save('tasks', { ...f.store.get('tasks', f.task.id)!, version: 2 });
    if (changed === 'source') f.store.save('sources', { ...f.source, revision: 'changed' });
    if (changed === 'policy') f.included.model = 'changed';
    if (changed === 'runtime') f.config.workers.codex = { command: 'changed', args: [], timeoutMs: 1000, isolation: 'lima', instance: 'synthetic' };
    if (changed === 'proof') f.writeProof({ ...f.proof, evidenceDigest: 'changed' });
    if (changed === 'current') f.current.runtimeIdentityHash = 'changed';
    if (changed === 'boundary') f.config.billingBoundary = 'included-only';
    await expect(a.dispatch(r, f.input, adapter(f, async () => { calls++; return result(f, 1); }))).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(0); expect(f.store.get('tasks', f.task.id)?.attempts).toBe(1);
    expect(f.store.get('attempts', r.attempt.id)).toMatchObject({ status: 'failed', costUsd: r.attempt.costUsd });
  });
  it('revalidates current capability again at adapter entry', async () => {
    const f = fixture(), a = authority(f), r = await a.reserve(f.input, 'codex'); let calls = 0;
    await expect(a.dispatch(r, f.input, { name: 'codex', async run(input, signal, permit) { f.current.runtimeIdentityHash = 'changed'; return a.runLima(input, 'codex', signal, permit, async () => { calls++; return result(f); }); } })).rejects.toMatchObject({ code: 'subscription_scope' });
    expect(calls).toBe(0); expect(f.store.get('tasks', f.task.id)?.attempts).toBe(1);
  });
  it('rejects an initial caller project repository change even under the same scope', async () => {
    const f = fixture(); f.input = { ...f.input, project: { ...f.project, repository: 'attacker/repo' } };
    await expect(authority(f).reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'subscription_scope' }); expect(f.store.list('attempts')).toEqual([]);
  });
  it('requires independent review for direct calls against the actual successful executor', async () => {
    const f = fixture(); f.task.stage = f.input.role = 'check'; f.task.attempts = 1; f.included.roles = ['check']; f.store.save('tasks', f.task);
    f.store.save('attempts', { id: 'synthetic-execution', projectId: f.project.id, domain: f.project.domain, taskId: f.task.id, taskVersion: 1, role: 'execute', runner: 'codex', model: f.included.model, provider: f.included.provider, inputHash: digest(f.input), status: 'succeeded', costUsd: 0, startedAt: f.at.toISOString() });
    let calls = 0; await expect(authority(f).runLima(f.input, 'codex', undefined, undefined, async () => { calls++; return result(f); })).rejects.toMatchObject({ code: 'independent_review_required' });
    expect(calls).toBe(0); expect(f.store.get('tasks', f.task.id)?.attempts).toBe(1);
  });
  it('a scheduled Lima claim cannot use a different authority over the same Store', async () => {
    const f = fixture(), a = authority(f), wrong = authority(f), reserved = await a.reserve(f.input, 'codex'); let launches = 0;
    await expect(a.dispatch(reserved, f.input, { name: 'codex', run: (input, signal, permit) => wrong.runLima(input, 'codex', signal, permit, async () => { launches++; return result(f); }) })).rejects.toMatchObject({ code: 'billing_permit_invalid' });
    expect(launches).toBe(0); expect(f.store.get('tasks', f.task.id)?.attempts).toBe(1);
  });
  it('direct synthetic Lima mechanics allocate and settle once per invocation without bypassing cap', async () => {
    const f = fixture(); f.config.maxAttemptsPerTask = 2; const a = authority(f); let calls = 0;
    const launch = async () => { calls++; return result(f); };
    await a.runLima(f.input, 'codex', undefined, undefined, launch); await a.runLima(f.input, 'codex', undefined, undefined, launch);
    await expect(a.runLima(f.input, 'codex', undefined, undefined, launch)).rejects.toMatchObject({ code: 'subscription_attempt_limit' });
    expect(calls).toBe(2); expect(f.store.list('attempts').map(x => [x.billing?.ordinal, x.status])).toEqual([[1, 'succeeded'], [2, 'succeeded']]);
  });
  it('reconciles only foreign unfinished attempts, retains charges, and allocates the next ordinal below cap', async () => {
    const f = fixture(); paid(f); f.config.maxAttemptsPerTask = 3; const old = authority(f), prior = await old.reserve(f.input, 'codex'), a = authority(f);
    await expect(a.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'attempt_recovery_required' }); a.reconcileAbandoned(); a.reconcileAbandoned();
    expect(f.store.get('attempts', prior.attempt.id)).toMatchObject({ status: 'failed', error: 'attempt_abandoned_after_host_restart', costUsd: 1, billing: { ordinal: 1, abandonedAt: f.at.toISOString() } });
    await expect(a.dispatch(prior, f.input, adapter(f))).rejects.toMatchObject({ code: 'billing_permit_invalid' });
    const next = await a.reserve(f.input, 'codex'); expect(next.attempt.billing?.ordinal).toBe(2); a.reconcileAbandoned(); expect(f.store.get('attempts', next.attempt.id)?.status).toBe('running');
    await a.dispatch(next, f.input, adapter(f, async () => result(f, .1))); expect(f.store.get('tasks', f.task.id)?.spentUsd).toBe(2);
  });
  it('reconciliation at cap never refunds or invents a new slot', async () => {
    const f = fixture(); paid(f); f.config.maxAttemptsPerTask = 1; await authority(f).reserve(f.input, 'codex'); const a = authority(f); a.reconcileAbandoned();
    await expect(a.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'subscription_attempt_limit' }); expect(f.store.get('tasks', f.task.id)).toMatchObject({ attempts: 1, spentUsd: 1 });
  });
  it('persists abandoned accounting across a real SQLite reopen and admits only a fresh ordinal', async () => {
    const f = fixture(); paid(f); f.config.maxAttemptsPerTask = 3; const path = join(f.root, 'synthetic-restart.sqlite');
    let db = new Store(path);
    try {
      db.save('projects', f.project); db.save('sources', f.source); db.save('tasks', f.task);
      const old = new BillingAuthority(db, f.config, f.currentProvider), prior = await old.reserve(f.input, 'codex');
      db.close(); db = new Store(path); const current = new BillingAuthority(db, f.config, f.currentProvider);
      await expect(current.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'attempt_recovery_required' }); current.reconcileAbandoned();
      await expect(current.dispatch({ ...prior, permit: structuredClone(prior.permit) }, f.input, adapter(f))).rejects.toMatchObject({ code: 'billing_permit_invalid' });
      const next = await current.reserve(f.input, 'codex'); await current.dispatch(next, f.input, adapter(f, async () => result(f, 1)));
      expect(db.get('tasks', f.task.id)).toMatchObject({ spentUsd: 2, attempts: 2, attemptLimit: 3 }); expect(next.attempt.billing?.ordinal).toBe(2);
      expect(db.get('attempts', prior.attempt.id)?.error).toBe('attempt_abandoned_after_host_restart');
    } finally { db.close(); }
  });
  it('reconciles legacy unfinished rows without inventing billing metadata or refunding them', async () => {
    const f = fixture(); paid(f); f.task.attempts = 1; f.task.spentUsd = 1; f.store.save('tasks', f.task);
    f.store.save('attempts', { id: 'synthetic-legacy', projectId: f.project.id, domain: f.project.domain, taskId: f.task.id, taskVersion: 1, role: f.input.role, runner: 'codex', model: f.included.model, provider: f.included.provider, inputHash: digest(f.input), status: 'running', costUsd: 1, startedAt: f.at.toISOString() });
    const a = authority(f); await expect(a.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'attempt_recovery_required' }); a.reconcileAbandoned();
    expect(f.store.get('attempts', 'synthetic-legacy')).toMatchObject({ status: 'failed', costUsd: 1 }); expect(f.store.get('attempts', 'synthetic-legacy')?.billing).toBeUndefined();
    const next = await a.reserve(f.input, 'codex'); expect(next.attempt.billing?.ordinal).toBe(2); expect(f.store.get('tasks', f.task.id)?.spentUsd).toBe(2);
  });
  it('rejects duplicate live work and corrupt historical counters without reconciliation bypass', async () => {
    const f = fixture(), a = authority(f); const r = await a.reserve(f.input, 'codex'); a.reconcileAbandoned();
    await expect(a.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'attempt_in_progress' }); await a.dispatch(r, f.input, adapter(f));
    f.store.save('tasks', { ...f.store.get('tasks', f.task.id)!, attempts: 0 }); await expect(a.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'billing_counter_invalid' });
  });
  it.each(['malformed', 'provider', 'mutation', 'stale'] as const)('charges included positive cost before %s rejection and preserves hard hold', async kind => {
    const f = fixture(), a = authority(f), r = await a.reserve(f.input, 'codex');
    await expect(a.dispatch(r, f.input, adapter(f, async () => { if (kind === 'mutation') f.input.answer = 'changed'; if (kind === 'stale') f.store.save('tasks', { ...f.store.get('tasks', f.task.id)!, status: 'cancelled', version: 2 }); return { ...result(f, 3), ...(kind === 'malformed' ? { output: {} } : {}), ...(kind === 'provider' ? { provider: 'wrong' } : {}) }; }))).rejects.toMatchObject({ code: 'billing_policy_violation' });
    expect(f.store.get('tasks', f.task.id)).toMatchObject({ spentUsd: 3, billingStop: { code: 'billing_policy_violation' }, ...(kind === 'stale' ? { status: 'cancelled' } : {}) });
    expect(f.store.get('attempts', r.attempt.id)).toMatchObject({ costUsd: 3, status: 'failed', error: 'billing_policy_violation' });
    expect(oneFinancialAction(f.store,'billing_hold').taskId).toBeUndefined();
    expect(f.store.list('outbox')).toHaveLength(1); expect(f.store.list('outbox')[0]?.taskId).toBeUndefined(); expect(JSON.stringify(f.store.list('outbox'))).not.toContain('synthetic-account');
    await expect(a.dispatch(r, f.input, adapter(f))).rejects.toMatchObject({ code: 'billing_permit_invalid' }); expect(f.store.get('tasks', f.task.id)?.spentUsd).toBe(3);
    expect(f.store.list('outbox')).toHaveLength(1);
  });
  it.each([NaN, Infinity, -1, .1])('never refunds the paid conservative reservation on cost %s', async cost => {
    const f = fixture(); paid(f); const a = authority(f), r = await a.reserve(f.input, 'codex');
    const settlement = a.dispatch(r, f.input, adapter(f, async () => result(f, cost))); if (cost === .1) await settlement; else await expect(settlement).rejects.toMatchObject({ code: 'invalid_cost' });
    expect(f.store.get('tasks', f.task.id)?.spentUsd).toBe(1); expect(f.store.get('attempts', r.attempt.id)?.costUsd).toBe(1);
  });
  it.each(['malformed', 'provider', 'mutation', 'stale'] as const)('charges higher paid reports before %s validation', async kind => {
    const f = fixture(); paid(f); const a = authority(f), r = await a.reserve(f.input, 'codex');
    await expect(a.dispatch(r, f.input, adapter(f, async () => {
      if (kind === 'mutation') f.input.answer = 'changed'; if (kind === 'stale') f.store.save('tasks', { ...f.store.get('tasks', f.task.id)!, version: 2 });
      return { ...result(f, 4), ...(kind === 'malformed' ? { output: {} } : {}), ...(kind === 'provider' ? { provider: 'wrong' } : {}) };
    }))).rejects.toBeInstanceOf(Error);
    expect(f.store.get('tasks', f.task.id)?.spentUsd).toBe(4); expect(f.store.get('attempts', r.attempt.id)?.costUsd).toBe(4);
    await expect(a.dispatch(r, f.input, adapter(f))).rejects.toMatchObject({ code: 'billing_permit_invalid' }); expect(f.store.get('tasks', f.task.id)?.spentUsd).toBe(4);
  });
  it('charges a result but rejects a changed persisted attempt input hash before success', async () => {
    const f = fixture(); paid(f); const a = authority(f), r = await a.reserve(f.input, 'codex');
    await expect(a.dispatch(r, f.input, adapter(f, async () => { f.store.save('attempts', { ...f.store.get('attempts', r.attempt.id)!, inputHash: 'synthetic-rebound-input' }); return result(f, 3); }))).rejects.toMatchObject({ code: 'stale_attempt' });
    expect(f.store.get('tasks', f.task.id)?.spentUsd).toBe(3); expect(f.store.get('attempts', r.attempt.id)?.status).toBe('stale');
  });
  it('fails closed on hold persistence failure and retains the conservative charged amount', async () => {
    const f = fixture(), a = authority(f), r = await a.reserve(f.input, 'codex'), save = f.store.save.bind(f.store);
    vi.spyOn(f.store, 'save').mockImplementation(((table: string, entity: never) => { if (table === 'actions') throw new Error('Synthetic persistence failure'); return save(table as never, entity); }) as typeof f.store.save);
    await expect(a.dispatch(r, f.input, adapter(f, async () => result(f, 2)))).rejects.toMatchObject({ code: 'billing_policy_violation' });
    expect(f.store.get('tasks', f.task.id)?.spentUsd).toBe(2); await expect(a.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'billing_policy_violation' });
  });
  it('reports sanitized unavailable proof and only actual synthetic admission status', async () => {
    const f = fixture(); expect(await authority(f).status(f.project, f.included)).toMatchObject({ state: 'included-admitted', reserveUsd: 0, attemptsLimit: 32 });
    expect(await new BillingAuthority(f.store, f.config, { async read() { return undefined; } }).status(f.project, f.included)).toMatchObject({ state: 'pending-proof' });
  });
  it('excludes the actual Store Vault directory even if the config names a different Vault', async () => {
    const f = fixture(), db = new Store(':memory:', f.root);
    try {
      db.save('projects', f.project); db.save('sources', f.source); db.save('tasks', f.task);
      const a = new BillingAuthority(db, f.config, f.currentProvider, { proofRoot: f.root, now: f.now });
      await expect(a.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'subscription_unverified' }); expect(db.list('attempts')).toEqual([]);
    } finally { db.close(); }
  });
  it('persists a profile incident across receipt replacement, a different task and authority restart', async () => {
    const f = fixture(), a = authority(f), first = await a.reserve(f.input, 'codex');
    await expect(a.dispatch(first, f.input, adapter(f, async () => result(f, 1)))).rejects.toMatchObject({ code: 'billing_policy_violation' });
    const replacement = { ...f.proof, id: 'synthetic-replacement', evidenceDigest: 'synthetic-new-proof' };
    writeFileSync(join(f.root, 'synthetic-replacement.json'), JSON.stringify(replacement), { mode: 0o600 }); f.included.billing = { mode: 'included-subscription', admissionId: replacement.id };
    const task = { ...f.task, id: 'synthetic-other-task', attempts: 0, billingStop: undefined }; f.store.save('tasks', task);
    await expect(authority(f).reserve({ ...f.input, task }, 'codex')).rejects.toMatchObject({ code: 'billing_policy_violation' }); expect(f.store.list('attempts')).toHaveLength(1);
  });
  it('keeps ephemeral incident holds and sanitized notices durable after SQLite reopen', async () => {
    const f = fixture(), path = join(f.root, 'synthetic-ephemeral.sqlite'); let db = new Store(path);
    try {
      db.save('projects', f.project);
      const task = ingestSource(db, f.config, { projectId: f.project.id, externalId: 'synthetic-ephemeral-incident', title: 'EPHEMERAL_BILLING_SECRET', content: 'EPHEMERAL_BILLING_SECRET', retention: 'ephemeral' })!;
      const input = { ...f.input, task, source: db.get('sources', task.sourceId)! }, a = new BillingAuthority(db, f.config, f.currentProvider, { proofRoot: f.root, now: f.now }), r = await a.reserve(input, 'codex');
      await expect(a.dispatch(r, input, adapter(f, async () => result(f, .5)))).rejects.toMatchObject({ code: 'billing_policy_violation' });
      db.close(); db = new Store(path);
      expect(db.get('tasks', task.id)).toMatchObject({ spentUsd: .5, billingStop: { code: 'billing_policy_violation' } });
      const hold=oneFinancialAction(db,'billing_hold');expect(hold).toMatchObject({ kind: 'billing_hold', status: 'pending' });expect(hold.taskId).toBeUndefined();
      expect(db.list('outbox')[0]).toMatchObject({ status: 'pending' }); expect(db.list('outbox')[0]?.taskId).toBeUndefined(); expect(db.list('outbox')[0]?.text).toContain('billing boundary violation');
      expect(JSON.stringify([db.list('tasks'), db.list('attempts'), db.list('actions'), db.list('outbox')])).not.toContain('EPHEMERAL_BILLING_SECRET');
    } finally { db.close(); }
  });
});

describe('included Scheduler fallback and host-only observations', () => {
  it.each([0, 100])('never falls back to metered after generic included unavailability under cap %s', async budget => {
    const f = fixture(); f.project.budgetUsd = f.task.budgetUsd = budget; f.store.save('projects', f.project); f.store.save('tasks', f.task);
    f.included.runner = 'grok'; f.writeProof({ ...f.proof, runner: 'grok' }); f.current.runner = 'grok';
    f.config.runnerPolicies.push({ ...f.included, runner: 'dsh', costPerRunUsd: 1, billing: { mode: 'metered-api' } }); let metered = 0;
    const s = new Scheduler(f.store, f.config, [{ name: 'grok', async run() { throw new WorkerUnavailable('offline'); } }, { name: 'dsh', async run() { metered++; return result(f, 1); } }], authority(f));
    expect(await s.run(f.task, f.project, f.input)).toBeUndefined(); expect(metered).toBe(0); expect(f.store.list('attempts')).toHaveLength(1);
    expect(f.store.get('tasks', f.task.id)?.spentUsd).toBe(0); expect(financialActions(f.store)).toEqual([]);expectIndependentJob(f); expect(f.store.list('outbox').some(x => x.text.includes('已继续'))).toBe(false);
  });
  for (const reason of ['quota', 'persistent-rate-limit', 'expired-credential', 'invalid-credential', 'provider-refusal'] as const) {
    it.each([0, 100])(`quarantines verified no-charge ${reason} and uses one independently included backup at cap %s`, async budget => {
      const f = fixture(), b = backup(f); f.project.budgetUsd = f.task.budgetUsd = budget; f.store.save('projects', f.project); f.store.save('tasks', f.task);
      const a = new BillingAuthority(f.store, f.config, b.provider, { proofRoot: f.root, now: f.now }); const calls: string[] = [];
      f.config.runnerPolicies.splice(1, 0, { ...f.included, runner: 'dsh', costPerRunUsd: 1, billing: { mode: 'metered-api' } });
      const s = new Scheduler(f.store, f.config, [{ name: 'grok', async run() { calls.push('grok'); throw refusal(f, reason); } }, { name: 'dsh', async run() { calls.push('metered'); return result(f, 1); } }, { name: 'codex', async run() { calls.push('codex'); return result(f); } }], a);
      expect(await s.run(f.task, f.project, f.input)).toEqual({ cards: [] }); expect(calls).toEqual(['grok', 'codex']);
      expect(f.store.list('attempts').map(x => [x.billing?.ordinal, x.status])).toEqual([[1, 'unavailable'], [2, 'succeeded']]); expect(f.store.get('tasks', f.task.id)?.billingStop).toBeUndefined();
      const quarantine = oneFinancialAction(f.store,'billing_profile_unavailable'); expect(quarantine).toMatchObject({ kind: 'billing_profile_unavailable', status: 'pending', payload: { reason } }); expect(quarantine.taskId).toBeUndefined();expectIndependentJob(f,'billing_profile_unavailable');
      expect(f.store.list('outbox').filter(x => x.text.includes('已继续'))).toHaveLength(1);
    });
  }
  it('does not let same-profile receipt IDs, stale evidence or time alone restore availability', async () => {
    const f = fixture(), b = backup(f, true), a = new BillingAuthority(f.store, f.config, b.provider, { proofRoot: f.root, now: f.now }); let calls = 0;
    const s = new Scheduler(f.store, f.config, [{ name: 'grok', async run() { calls++; throw refusal(f); } }, { name: 'codex', async run() { calls++; return result(f); } }], a);
    expect(await s.run(f.task, f.project, f.input)).toBeUndefined(); expect(calls).toBe(1); expect(f.store.list('attempts')).toHaveLength(1);
    expect(await s.run(f.task, f.project, f.input)).toBeUndefined(); expect(calls).toBe(1); expect(f.store.list('outbox')).toHaveLength(1); expect(f.store.get('tasks', f.task.id)?.billingStop).toBeUndefined();
    f.setTime(new Date(f.at.getTime() + 1000)); vi.spyOn(Date, 'now').mockImplementation(() => f.at.getTime()); f.current.checkedAt = f.current.principalVerifiedAt = f.at.toISOString();
    f.writeProof({ ...f.proof, runner: 'grok', id: f.proof.id, verifiedAt: f.at.toISOString(), allowance: f.proof.allowance });
    await expect(a.reserve(f.input, 'grok')).rejects.toMatchObject({ code: 'subscription_profile_unavailable' });
  });
  it('restores availability only after every independent observation is strictly newer', async () => {
    const f = fixture(), a = authority(f), first = await a.reserve(f.input, 'codex'); await expect(a.dispatch(first, f.input, adapter(f, async () => { throw refusal(f); }))).rejects.toMatchObject({ code: 'subscription_unavailable' });
    f.setTime(new Date(f.at.getTime() + 1000)); vi.spyOn(Date, 'now').mockImplementation(() => f.at.getTime()); const fresh = f.at.toISOString(); f.current.checkedAt = f.current.principalVerifiedAt = fresh;
    f.writeProof({ ...f.proof, verifiedAt: fresh, allowance: { ...f.proof.allowance, checkedAt: fresh, evidenceDigest: 'synthetic-restored' }, evidenceDigest: 'synthetic-restoration' });
    const next = await a.reserve(f.input, 'codex'); await a.dispatch(next, f.input, adapter(f)); expect(next.attempt.billing?.ordinal).toBe(2);
    expect(oneFinancialAction(f.store,'billing_profile_unavailable')).toMatchObject({ status: 'completed', payload: { restoredAt: fresh, restorationEvidenceDigest: 'synthetic-restoration', reason: 'quota' } });expectIndependentJob(f,'billing_profile_unavailable');
  });
  it('rejects a completed quarantine record without the required newer restoration evidence', async () => {
    const f = fixture(), a = authority(f), r = await a.reserve(f.input, 'codex'); await expect(a.dispatch(r, f.input, adapter(f, async () => { throw refusal(f); }))).rejects.toMatchObject({ code: 'subscription_unavailable' });
    const row = oneFinancialAction(f.store,'billing_profile_unavailable'); f.store.save('actions', { ...row, status: 'completed' });expectIndependentJob(f,'billing_profile_unavailable');
    await expect(a.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'billing_policy_violation' }); expect(f.store.list('attempts')).toHaveLength(1);
  });
  it.each(['paid-route-used', 'extra-credit-used', 'no-charge-boundary-breached', 'charge-danger-unknown'] as const)('hard-stops all candidates after %s and never clears from fresh availability', async reason => {
    const f = fixture(), b = backup(f), a = new BillingAuthority(f.store, f.config, b.provider, { proofRoot: f.root, now: f.now }); let backupCalls = 0;
    const s = new Scheduler(f.store, f.config, [{ name: 'grok', async run() { throw new SubscriptionAccessError({ disposition: 'billing-incident', reason, observedAt: f.at.toISOString(), evidenceDigest: 'synthetic-incident' }, 'private marker'); } }, { name: 'codex', async run() { backupCalls++; return result(f); } }], a);
    await expect(s.run(f.task, f.project, f.input)).rejects.toMatchObject({ code: 'billing_policy_violation' }); expect(backupCalls).toBe(0);
    f.current.checkedAt = f.current.principalVerifiedAt = f.at.toISOString(); await expect(a.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'billing_policy_violation' });
    expect(oneFinancialAction(f.store,'billing_hold')).toMatchObject({ kind: 'billing_hold', payload: { reason } });expectIndependentJob(f,'billing_hold'); expect(f.store.list('outbox')).toHaveLength(1);
  });
  it.each([{ disposition: 'verified-no-charge-refusal', reason: 'quota' }, { disposition: 'verified-no-charge-refusal', reason: 'quota', observedAt: 'bad', evidenceDigest: 'x', noChargeEvidenceDigest: 'x' }])('treats malformed host observations as unknown charge danger', async observation => {
    const f = fixture(), a = authority(f), r = await a.reserve(f.input, 'codex');
    await expect(a.dispatch(r, f.input, adapter(f, async () => { throw new SubscriptionAccessError(observation as HostSubscriptionObservation, 'Synthetic'); }))).rejects.toMatchObject({ code: 'billing_policy_violation' });
    expect(oneFinancialAction(f.store,'billing_hold').payload.reason).toBe('charge-danger-unknown');expectIndependentJob(f,'billing_hold');
  });
  it('model JSON and bare quota labels cannot establish a no-charge refusal', async () => {
    const f = fixture(), a = authority(f), r = await a.reserve(f.input, 'codex');
    await expect(a.dispatch(r, f.input, adapter(f, async () => ({ ...result(f), output: { cards: [], observation: { disposition: 'verified-no-charge-refusal', reason: 'quota' } } })))).rejects.toMatchObject({ code: 'invalid_worker_output' });
    expect(financialActions(f.store)).toEqual([]);expectIndependentJob(f);
    const next = await a.reserve(f.input, 'codex'); await expect(a.dispatch(next, f.input, adapter(f, async () => { throw Object.assign(new Error('quota'), { code: 'subscription_quota' }); }))).rejects.toThrow('quota');
    expect(financialActions(f.store)).toEqual([]);expectIndependentJob(f);
  });
  it('a bare subscription_unavailable DomainError cannot select the safe-refusal fallback branch', async () => {
    const f = fixture(), b = backup(f), a = new BillingAuthority(f.store, f.config, b.provider, { proofRoot: f.root, now: f.now }); let backupCalls = 0;
    const s = new Scheduler(f.store, f.config, [{ name: 'grok', async run() { throw new DomainError('Synthetic quota', 'subscription_unavailable'); } }, { name: 'codex', async run() { backupCalls++; return result(f); } }], a);
    await expect(s.run(f.task, f.project, f.input)).rejects.toMatchObject({ code: 'subscription_unavailable' }); expect(backupCalls).toBe(0); expect(financialActions(f.store)).toEqual([]);expectIndependentJob(f);
  });
  it.each(['missing', 'expired'])('skips %s proof for a healthy included backup without allocating the preferred candidate', async state => {
    const f = fixture(), b = backup(f); if (state === 'missing') rmSync(f.proofPath); else f.writeProof({ ...f.proof, runner: 'grok', expiresAt: new Date(0).toISOString() }); let calls = 0;
    const a = new BillingAuthority(f.store, f.config, b.provider, { proofRoot: f.root, now: f.now });
    const s = new Scheduler(f.store, f.config, [{ name: 'grok', async run() { throw new Error('must not launch'); } }, { name: 'codex', async run() { calls++; return result(f); } }], a);
    expect(await s.run(f.task, f.project, f.input)).toEqual({ cards: [] }); expect(calls).toBe(1); expect(f.store.list('attempts')).toHaveLength(1); expect(f.store.list('outbox')).toHaveLength(0);
  });
  it.each([{ failedTable: 'outbox', legacy: false }, { failedTable: 'events', legacy: false }, { failedTable: 'outbox', legacy: true }] as const)('rolls back allocation when switch $failedTable save fails (legacy=$legacy) and retries on the same authority', async ({ failedTable, legacy }) => {
    const f = fixture(), b = backup(f), a = new BillingAuthority(f.store, f.config, b.provider, { proofRoot: f.root, now: f.now }); const calls: Runner[] = [];
    if (legacy) { delete f.task.billingBoundary; f.store.save('tasks', f.task); }
    const s = new Scheduler(f.store, f.config, [{ name: 'grok', async run() { calls.push('grok'); throw refusal(f); } }, { name: 'codex', async run() { calls.push('codex'); return result(f); } }], a);
    const save = f.store.save.bind(f.store), injected = vi.spyOn(f.store, 'save').mockImplementation((table, entity) => {
      save(table, entity);
      if (table === failedTable && (table === 'outbox' && 'text' in entity && entity.text.includes('已继续') || table === 'events' && 'type' in entity && entity.type === 'worker.switched')) throw new Error(`Synthetic switch ${failedTable} save failure`);
    });
    await expect(s.run(f.task, f.project, f.input)).rejects.toThrow(`Synthetic switch ${failedTable} save failure`);
    expect(calls).toEqual(['grok']);
    expect(f.store.list('attempts').map(x => [x.runner, x.status, x.billing?.ordinal])).toEqual([['grok', 'unavailable', 1]]);
    expect(f.store.get('tasks', f.task.id)).toMatchObject({ attempts: 1, spentUsd: 0 }); expect(f.store.get('tasks', f.task.id)?.billingStop).toBeUndefined();
    expect(f.store.list('outbox')).toEqual([]); expect(f.store.list('events').filter(x => x.type === 'worker.switched')).toEqual([]);
    injected.mockRestore();
    const resumed = { ...structuredClone(f.input), task: f.store.get('tasks', f.task.id)! };
    expect(resumed.task.billingBoundary).toBe('included-only');
    expect(f.store.list('attempts')[0]?.inputHash).toBe(digest(f.input));
    expect(digest(resumed)).not.toBe(digest(f.input));
    expect(await s.run(resumed.task, f.project, resumed)).toEqual({ cards: [] }); expect(calls).toEqual(['grok', 'codex']);
    expect(f.store.list('attempts').map(x => [x.runner, x.status, x.billing?.ordinal])).toEqual([['grok', 'unavailable', 1], ['codex', 'succeeded', 2]]);
    expect(f.store.get('tasks', f.task.id)).toMatchObject({ attempts: 2, spentUsd: 0 }); expect(f.store.get('tasks', f.task.id)?.billingStop).toBeUndefined();
    expect(f.store.list('outbox').filter(x => x.text.includes('已继续'))).toHaveLength(1);
    expect(f.store.list('events').filter(x => x.type === 'worker.switched').map(x => x.data)).toEqual([{ from: 'grok', to: 'codex', role: f.input.role }]);
  });
  it('keeps an explicit conflicting route bound and rejects it after a canonical legacy pin', async () => {
    const f = fixture(), b = backup(f), a = new BillingAuthority(f.store, f.config, b.provider, { proofRoot: f.root, now: f.now });
    delete f.task.billingBoundary; f.store.save('tasks', f.task);
    const first = await a.reserve(f.input, 'grok'); await expect(a.dispatch(first, f.input, { name: 'grok', async run() { throw refusal(f); } })).rejects.toMatchObject({ code: 'subscription_unavailable' });
    const pinned = f.store.get('tasks', f.task.id)!, conflicting = { ...structuredClone(f.input), task: { ...pinned, billingBoundary: 'metered-only' as const } };
    expect(pinned.billingBoundary).toBe('included-only');
    expect(billingSwitchInputHash(conflicting, pinned.billingBoundary!)).not.toBe(billingSwitchInputHash({ ...f.input, task: pinned }, pinned.billingBoundary!));
    await expect(a.reserve(conflicting, 'codex', { fromAttemptId: first.attempt.id, reason: 'subscription_unavailable' })).rejects.toMatchObject({ code: 'billing_boundary_mismatch' });
    let calls = 0; const s = new Scheduler(f.store, f.config, [{ name: 'codex', async run() { calls++; return result(f); } }], a);
    expect(await s.run(conflicting.task, f.project, conflicting)).toBeUndefined(); expect(calls).toBe(0);
    expect(f.store.list('attempts')).toHaveLength(1); expect(f.store.get('tasks', f.task.id)).toMatchObject({ attempts: 1, spentUsd: 0, billingBoundary: 'included-only' });
    expect(f.store.list('events').filter(x => x.type === 'worker.switched')).toEqual([]); expect(f.store.list('outbox').filter(x => x.text.includes('已继续'))).toEqual([]);
  });
  it.each(['cards', 'rules', 'plan', 'artifact'] as const)('does not reuse a prior switch binding when frozen %s change on a later round', async field => {
    const f = fixture(), b = backup(f), a = new BillingAuthority(f.store, f.config, b.provider, { proofRoot: f.root, now: f.now });
    const first = await a.reserve(f.input, 'grok'); await expect(a.dispatch(first, f.input, { name: 'grok', async run() { throw refusal(f); } })).rejects.toMatchObject({ code: 'subscription_unavailable' });
    const resumed = { ...structuredClone(f.input), task: f.store.get('tasks', f.task.id)! };
    Object.assign(resumed, { [field]: ['cards', 'rules'].includes(field) ? [{ title: 'Different synthetic business input' }] : { summary: 'Different synthetic business input' } });
    const s = new Scheduler(f.store, f.config, [{ name: 'codex', async run() { return result(f); } }], a);
    expect(await s.run(resumed.task, f.project, resumed)).toEqual({ cards: [] });
    expect(f.store.list('attempts').map(x => x.billing?.ordinal)).toEqual([1, 2]);
    expect(f.store.list('events').filter(x => x.type === 'worker.switched')).toEqual([]); expect(f.store.list('outbox')).toEqual([]);
  });
  it('terminalizes an uncertain committed switch without refunding or launching its paid allocation', async () => {
    const f = fixture(), b = backup(f); paid(f); b.policy.billing = { mode: 'metered-api' }; b.policy.costPerRunUsd = 1;
    const a = new BillingAuthority(f.store, f.config, b.provider, { proofRoot: f.root, now: f.now }); let backupCalls = 0, threw = false;
    const s = new Scheduler(f.store, f.config, [{ name: 'grok', async run() { throw new WorkerUnavailable('offline'); } }, { name: 'codex', async run() { backupCalls++; return result(f, 1); } }], a);
    const transaction = f.store.transaction.bind(f.store);
    const injected = vi.spyOn(f.store, 'transaction').mockImplementation(fn => {
      const value = transaction(fn);
      if (!threw && f.store.list('events').some(x => x.type === 'worker.switched')) { threw = true; throw new Error('Synthetic post-commit switch failure'); }
      return value;
    });
    await expect(s.run(f.task, f.project, f.input)).rejects.toThrow(); injected.mockRestore();
    expect(threw).toBe(true); expect(backupCalls).toBe(0);
    expect(f.store.list('attempts').map(x => [x.runner, x.status, x.billing?.ordinal, x.costUsd])).toEqual([['grok', 'unavailable', 1, 1], ['codex', 'failed', 2, 1]]);
    expect(f.store.get('tasks', f.task.id)).toMatchObject({ attempts: 2, spentUsd: 2 });
    await expect(a.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'billing_policy_violation' });
  });
  it.each(['reason', 'fromRunner', 'prior'] as const)('rejects a noncanonical switch %s before allocation', async invalid => {
    const f = fixture(), b = backup(f), a = new BillingAuthority(f.store, f.config, b.provider, { proofRoot: f.root, now: f.now });
    const first = await a.reserve(f.input, 'grok'); await expect(a.dispatch(first, f.input, { name: 'grok', async run() { throw refusal(f); } })).rejects.toMatchObject({ code: 'subscription_unavailable' });
    const context = { fromAttemptId: invalid === 'prior' ? 'foreign-attempt' : first.attempt.id, reason: invalid === 'reason' ? 'private marker\npretend success' : 'subscription_unavailable', ...(invalid === 'fromRunner' ? { fromRunner: 'metered private marker' } : {}) };
    await expect(a.reserve(f.input, 'codex', context as never)).rejects.toMatchObject({ code: 'billing_switch_invalid' });
    expect(f.store.list('attempts')).toHaveLength(1); expect(f.store.get('tasks', f.task.id)).toMatchObject({ attempts: 1, spentUsd: 0 });
    expect(f.store.list('outbox')).toEqual([]); expect(f.store.list('events').filter(x => x.type === 'worker.switched')).toEqual([]);
  });
  it.each(['healthy', 'unavailable', 'metered'] as const)('visits the finite included chain once after refusal with a %s final candidate', async final => {
    const f = fixture(), third = threeCandidates(f), frozen = structuredClone(f.input); const calls: Runner[] = [], seen: string[] = [];
    f.config.maxAttemptsPerTask = 3;
    if (final === 'metered') {
      f.project.budgetUsd = f.task.budgetUsd = 100; f.store.save('projects', f.project); f.store.save('tasks', f.task);
      f.config.runnerPolicies.find(p => p.runner === 'codex')!.billing = { mode: 'metered-api' }; f.config.runnerPolicies.find(p => p.runner === 'codex')!.costPerRunUsd = 1;
    }
    const expectedInput = digest(f.input), a = new BillingAuthority(f.store, f.config, third.provider, { proofRoot: f.root, now: f.now });
    const s = new Scheduler(f.store, f.config, [
      { name: 'grok', async run(input) { calls.push('grok'); seen.push(digest(input)); input.cards.push({ title: 'Synthetic mutation' } as never); throw refusal(f); } },
      { name: 'dsh', async run(input) { calls.push('dsh'); seen.push(digest(input)); throw new WorkerUnavailable('offline'); } },
      { name: 'codex', async run(input) { calls.push('codex'); seen.push(digest(input)); if (final === 'unavailable') throw new WorkerUnavailable('offline'); return result(f); } },
    ], a);
    expect(await s.run(f.task, f.project, f.input)).toEqual(final === 'healthy' ? { cards: [] } : undefined);
    const expectedRunners = final === 'metered' ? ['grok', 'dsh'] : ['grok', 'dsh', 'codex'];
    expect(calls).toEqual(expectedRunners); expect(seen).toEqual(expectedRunners.map(() => expectedInput));
    expect(f.input.cards).toEqual(frozen.cards); expect(f.input.source).toEqual(frozen.source);
    const attempts = f.store.list('attempts');
    expect(attempts.map(x => [x.runner, x.billing?.ordinal, x.status, x.inputHash])).toEqual(expectedRunners.map((runner, i) => [runner, i + 1, final === 'healthy' && runner === 'codex' ? 'succeeded' : 'unavailable', expectedInput]));
    expect(f.store.get('tasks', f.task.id)).toMatchObject({ attempts: expectedRunners.length, spentUsd: 0 }); expect(f.store.get('tasks', f.task.id)?.billingStop).toBeUndefined();
    expect(f.store.get('tasks', f.task.id)?.status === 'blocked').toBe(final !== 'healthy');
    const switches = f.store.list('events').filter(x => x.type === 'worker.switched');
    expect(switches.map(x => x.data)).toEqual(expectedRunners.slice(1).map((to, i) => ({ from: expectedRunners[i], to, role: f.input.role })));
    expect(f.store.list('outbox').filter(x => x.text.includes('已继续'))).toHaveLength(expectedRunners.length - 1);
  });
  it('will not allocate a fallback without a remaining shared slot or promise continuation', async () => {
    const f = fixture(), b = backup(f); f.config.maxAttemptsPerTask = 1;
    const a = new BillingAuthority(f.store, f.config, b.provider, { proofRoot: f.root, now: f.now }); let backupCalls = 0;
    const s = new Scheduler(f.store, f.config, [{ name: 'grok', async run() { throw refusal(f); } }, { name: 'codex', async run() { backupCalls++; return result(f); } }], a);
    expect(await s.run(f.task, f.project, f.input)).toBeUndefined(); expect(backupCalls).toBe(0); expect(f.store.list('attempts')).toHaveLength(1);
    expect(f.store.get('tasks', f.task.id)?.billingStop?.code).toBe('subscription_attempt_limit'); expect(f.store.list('outbox').some(x => x.text.includes('已继续'))).toBe(false);
  });
  it('rechecks source identity before allowing a no-charge-refusal backup', async () => {
    const f = fixture(), b = backup(f), a = new BillingAuthority(f.store, f.config, b.provider, { proofRoot: f.root, now: f.now }); let backupCalls = 0;
    const s = new Scheduler(f.store, f.config, [{ name: 'grok', async run() { f.store.save('sources', { ...f.source, revision: 'superseded' }); throw refusal(f); } }, { name: 'codex', async run() { backupCalls++; return result(f); } }], a);
    await expect(s.run(f.task, f.project, f.input)).rejects.toMatchObject({ code: 'stale_attempt' }); expect(backupCalls).toBe(0); expect(f.store.list('attempts')).toHaveLength(1);
  });
  it('preserves actual executor exclusion when selecting a verified-refusal backup for check', async () => {
    const f = fixture(); f.task.stage = f.input.role = 'check'; f.task.attempts = 1; f.included.roles = ['check']; f.store.save('tasks', f.task);
    const b = { ...f.included, runner: 'grok' as const, billing: { mode: 'included-subscription' as const, admissionId: 'synthetic-check-backup' } }, proof = { ...f.proof, id: 'synthetic-check-backup', runner: 'grok', accountFingerprint: 'synthetic-checker-account' }, current = { ...f.current, runner: 'grok' as const, accountFingerprint: 'synthetic-checker-account' };
    f.config.runnerPolicies.push(b); writeFileSync(join(f.root, 'synthetic-check-backup.json'), JSON.stringify(proof), { mode: 0o600 });
    f.store.save('attempts', { id: 'actual-executor', projectId: f.project.id, domain: f.project.domain, taskId: f.task.id, taskVersion: 1, role: 'execute', runner: 'grok', model: b.model, provider: b.provider, inputHash: digest(f.input), status: 'succeeded', costUsd: 0, startedAt: f.at.toISOString() });
    const a = new BillingAuthority(f.store, f.config, { async read(p) { return p.runner === 'grok' ? current : f.current; } }, { proofRoot: f.root, now: f.now }); let backupCalls = 0;
    const s = new Scheduler(f.store, f.config, [{ name: 'codex', async run() { throw refusal(f); } }, { name: 'grok', async run() { backupCalls++; return result(f); } }], a);
    expect(await s.run(f.task, f.project, f.input)).toBeUndefined(); expect(backupCalls).toBe(0); expect(f.store.list('attempts')).toHaveLength(2); expect(f.store.get('tasks', f.task.id)?.billingStop).toBeUndefined();
  });
  it('a host boundary change cannot loosen a frozen included task', async () => {
    const f = fixture(); paid(f); f.task.billingBoundary = 'included-only'; f.store.save('tasks', f.task); const a = authority(f); let calls = 0;
    await expect(a.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'billing_boundary_mismatch' });
    const s = new Scheduler(f.store, f.config, [adapter(f, async () => { calls++; return result(f, 1); })], a); await s.run(f.task, f.project, f.input);
    expect(calls).toBe(0); expect(f.store.list('attempts')).toEqual([]); expect(f.store.get('tasks', f.task.id)?.billingBoundary).toBe('included-only');
  });
});
