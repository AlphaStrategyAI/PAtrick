import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, chownSync, linkSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
vi.mock('node:fs', async importOriginal => { const actual = await importOriginal<typeof import('node:fs')>(); return { ...actual, readSync: vi.fn(actual.readSync), closeSync: vi.fn(actual.closeSync) }; });
import { join } from 'node:path';
import { evaluateBilling, loadIncludedAdmission } from '../../src/billing.js';
import { ingestSource } from '../../src/intake.js';
import { SubscriptionAccessError } from '../../src/domain.js';
import { makeBillingFixture } from '../fixtures/billing.js';
const fixtures: ReturnType<typeof makeBillingFixture>[] = [];
function fixture() { const f = makeBillingFixture(); fixtures.push(f); return f; }
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) f.dispose(); });
function evaluate(f: ReturnType<typeof fixture>) { return evaluateBilling(f.included, f.task, f.project, f.proof, f.current, f.at); }

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
  it('uses typed provider observations without model JSON permits', () => { expect(new SubscriptionAccessError('subscription_quota', 'Synthetic')).toMatchObject({ code: 'subscription_quota', status: 409 }); const f = fixture(); expect(f.input).not.toHaveProperty('permit'); });
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
