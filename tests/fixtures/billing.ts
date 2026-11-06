/** Synthetic mechanics only: never production admission evidence. */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path';
import { readConfig, projectSchema } from '../../src/config.js';
import { ingestSource } from '../../src/intake.js';
import { Store } from '../../src/store.js';
import { digest, type AppConfig, type RunnerPolicy, type WorkerInput } from '../../src/domain.js';
import { BillingAuthority, type CurrentBillingContext, type IncludedAdmission } from '../../src/billing.js';

// Match the loader's ancestor and sync-storage rules before creating any proof.
function syntheticProofRoot(prefix: string) {
  const uid = process.geteuid?.();
  const safeParent = (candidate: string): string | undefined => {
    try {
      if (uid === undefined) return undefined;
      const path = realpathSync(candidate);
      if (path.split(sep).some(part => /^(?:同步空间|vault|\.git|dropbox|onedrive(?: - .*)?|google drive|googledrive|mobile documents|cloudstorage|syncthing|icloud(?: drive)?)$/i.test(part))) return undefined;
      const chain = [];
      for (let current = path;; current = dirname(current)) {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
        chain.unshift(stat);
        if (current === parse(current).root) break;
      }
      let privateBoundary = false;
      for (const stat of chain) {
        const mode = stat.mode & 0o7777;
        if (stat.uid !== 0 && stat.uid !== uid) return undefined;
        if (stat.uid === uid && mode === 0o700) privateBoundary = true;
        if (privateBoundary ? stat.uid !== uid || mode !== 0o700 : (mode & 0o022) !== 0) return undefined;
      }
      return path;
    } catch { return undefined; }
  };
  const cwd = realpathSync(process.cwd());
  const outsideCwd = (path: string) => { const value = relative(cwd, path); return value === '..' || value.startsWith('..' + sep) || isAbsolute(value); };
  const temporary = safeParent(tmpdir());
  let parent = temporary && outsideCwd(temporary) ? temporary : undefined;
  if (!parent && process.env.GITHUB_ACTIONS === 'true' && ['true', '1'].includes(process.env.CI ?? '')) {
    const project = safeParent(cwd);
    let workspace: string | undefined;
    try { if (process.env.GITHUB_WORKSPACE) workspace = realpathSync(process.env.GITHUB_WORKSPACE); } catch { /* no verified checkout */ }
    if (project && project === workspace && existsSync(join(project, 'package.json')) && existsSync(join(project, 'src', 'billing.ts'))) {
      const runnerTemp = process.env.RUNNER_TEMP ? safeParent(process.env.RUNNER_TEMP) : undefined;
      const sibling = safeParent(dirname(project));
      parent = runnerTemp && outsideCwd(runnerTemp) ? runnerTemp : sibling && outsideCwd(sibling) ? sibling : undefined;
    }
  }
  if (!parent) throw new Error('No verified private synthetic proof parent');
  const root = mkdtempSync(join(parent, prefix));
  const created = lstatSync(root);
  const remove = () => {
    try {
      const current = lstatSync(root);
      if (!current.isSymbolicLink() && current.isDirectory() && current.uid === uid && current.dev === created.dev && current.ino === created.ino) rmSync(root, { recursive: true, force: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
  try { chmodSync(root, 0o700); } catch (error) { remove(); throw error; }
  return { root, remove };
}

export function makeBillingFixture(options: { maxAttemptsPerTask?: number; persistent?: boolean; retention?: 'permanent' | 'ephemeral' } = {}) {
  const { root, remove } = syntheticProofRoot('patrick-SYNTHETIC-billing-');
  const databasePath = options.persistent ? join(root, 'billing.sqlite') : ':memory:';
  let store!: Store;
  try {
  store = new Store(databasePath);
  const project = projectSchema.parse({ id: 'synthetic', projectId: 'synthetic', domain: 'synthetic', name: 'Synthetic', repository: 'fixture/repo', prdPath: 'docs/PRD.md', allowedPaths: ['docs/'], ownerId: 'synthetic-owner', budgetUsd: 0 });
  const included: RunnerPolicy = { runner: 'codex', roles: ['knowledge_extract'], domains: ['synthetic'], provider: 'synthetic-provider', model: 'synthetic-model', admitted: true, costPerRunUsd: 0, independentReview: false, billing: { mode: 'included-subscription', admissionId: 'synthetic-proof' } };
  const config: AppConfig = { ...readConfig({ PATRICK_MODE: 'test' }), billingBoundary: 'included-only' as const, maxAttemptsPerTask: options.maxAttemptsPerTask ?? 32, projects: [project], runnerPolicies: [included] };
  store.save('projects', project);
  const task = ingestSource(store, config, { projectId: project.id, externalId: 'synthetic-source', title: 'Synthetic', content: 'Synthetic fixture only.', retention: options.retention })!;
  task.attemptLimit = config.maxAttemptsPerTask; store.save('tasks', task);
  const source = store.get('sources', task.sourceId)!;
  let at = new Date();
  const verifiedAt = new Date(at.getTime() - 1000).toISOString();
  const proof: IncludedAdmission = { schemaVersion: 1, id: 'synthetic-proof', projectId: project.id, domain: project.domain, ownerFingerprint: 'synthetic-owner', runner: 'codex', provider: 'synthetic-provider', model: 'synthetic-model', accountFingerprint: 'synthetic-account', workspaceFingerprint: 'synthetic-workspace', authRouteFingerprint: 'synthetic-route', authMode: 'subscription-oauth', cliVersion: 'synthetic-1', commandPolicyHash: 'synthetic-command', networkPolicyHash: 'synthetic-network', runtimeIdentityHash: 'synthetic-runtime', allowance: { state: 'verified-available', checkedAt: verifiedAt, evidenceDigest: 'synthetic-allowance' }, noAdditionalBilling: { state: 'provider-enforced', paidOverflow: 'verified-disabled', additionalCredits: 'verified-disabled', autoRefill: 'verified-disabled', evidenceDigest: 'synthetic-no-charge' }, verifiedAt, expiresAt: new Date(at.getTime() + 3600000).toISOString(), evidenceDigest: 'synthetic-evidence' };
  // Intentionally independently specified: do not derive principal bindings from receipt.
  const current: CurrentBillingContext = { projectId: 'synthetic', domain: 'synthetic', ownerFingerprint: 'synthetic-owner', runner: 'codex', provider: 'synthetic-provider', model: 'synthetic-model', accountFingerprint: 'synthetic-account', workspaceFingerprint: 'synthetic-workspace', authRouteFingerprint: 'synthetic-route', authMode: 'subscription-oauth', cliVersion: 'synthetic-1', commandPolicyHash: 'synthetic-command', networkPolicyHash: 'synthetic-network', runtimeIdentityHash: 'synthetic-runtime', checkedAt: at.toISOString(), principalVerifiedAt: at.toISOString(), allowance: 'available', noAdditionalBilling: 'provider-enforced', paidOverflow: 'disabled', additionalCredits: 'disabled', autoRefill: 'disabled' };
  const proofPath = join(root, 'synthetic-proof.json');
  const writeProof = (value: unknown = proof) => writeFileSync(proofPath, JSON.stringify(value), { mode: 0o600 });
  writeProof();
  const input: WorkerInput = { task, project, source, role: 'knowledge_extract', cards: [], facts: [], rules: [] };
  let disposed = false;
  return { root, proofRoot: root, proofPath, get store() { return store; }, reopen() { if (!options.persistent) throw Error('Persistent fixture required'); store.close(); store = new Store(databasePath); return store; }, config, project, source, task, input, included, proof, current, get at() { return at; }, now: () => at, setTime: (value: Date) => { at = value; }, currentProvider: { async read() { return structuredClone(current); } }, writeProof, dispose() { if (disposed) return; disposed = true; try { store.close(); } finally { remove(); } } };
  } catch (error) { try { store?.close(); } finally { remove(); } throw error; }
}

/** Bind a harmless Lima protocol stub to real authoritative records and synthetic proof.
 * The receipt and independently specified current principal are mechanics, never admission.
 */
export function bindSyntheticLimaBilling(config: AppConfig, input: WorkerInput) {
  const { root, remove } = syntheticProofRoot('patrick-SYNTHETIC-lima-proof-');
  let store!: Store;
  try {
  const proofRoot = join(root, 'proof'), vault = join(root, 'vault');
  mkdirSync(proofRoot, { mode: 0o700 }); mkdirSync(vault, { mode: 0o700 });
  config.vaultDir = vault; config.billingBoundary = 'included-only'; config.maxAttemptsPerTask ??= 32;
  input.task.billingBoundary = 'included-only'; input.task.attemptLimit = config.maxAttemptsPerTask;
  const policy = config.runnerPolicies[0]!, runner = policy.runner, worker = config.workers[runner]!;
  policy.billing = { mode: 'included-subscription', admissionId: 'synthetic-lima-proof' };
  const at = new Date(), verifiedAt = new Date(at.getTime() - 1000).toISOString();
  const commandPolicyHash = digest({ command: worker.command, args: worker.args, model: policy.model });
  const runtimeIdentityHash = digest({ instance: worker.instance, runner, user: worker.guestUser ?? `patrick-${runner}`, projectId: input.project.projectId, domain: input.project.domain });
  const proof: IncludedAdmission = { schemaVersion: 1, id: 'synthetic-lima-proof', projectId: input.project.id, domain: input.project.domain, ownerFingerprint: config.ownerId, runner, provider: policy.provider, model: policy.model, accountFingerprint: 'synthetic-account', workspaceFingerprint: 'synthetic-workspace', authRouteFingerprint: 'synthetic-route', authMode: 'subscription-oauth', cliVersion: 'synthetic-cli-1', commandPolicyHash, networkPolicyHash: 'synthetic-network', runtimeIdentityHash, allowance: { state: 'verified-available', checkedAt: verifiedAt, evidenceDigest: 'synthetic-allowance' }, noAdditionalBilling: { state: 'provider-enforced', paidOverflow: 'verified-disabled', additionalCredits: 'verified-disabled', autoRefill: 'verified-disabled', evidenceDigest: 'synthetic-no-charge' }, verifiedAt, expiresAt: new Date(at.getTime() + 3600000).toISOString(), evidenceDigest: 'synthetic-evidence' };
  // Current principal is explicitly supplied separately, never copied from the receipt.
  const current: CurrentBillingContext = { projectId: input.project.id, domain: input.project.domain, ownerFingerprint: config.ownerId, runner, provider: policy.provider, model: policy.model, accountFingerprint: 'synthetic-account', workspaceFingerprint: 'synthetic-workspace', authRouteFingerprint: 'synthetic-route', authMode: 'subscription-oauth', cliVersion: 'synthetic-cli-1', commandPolicyHash: digest({ command: worker.command, args: worker.args, model: policy.model }), networkPolicyHash: 'synthetic-network', runtimeIdentityHash: digest({ instance: worker.instance, runner, user: worker.guestUser ?? `patrick-${runner}`, projectId: input.project.projectId, domain: input.project.domain }), checkedAt: at.toISOString(), principalVerifiedAt: at.toISOString(), allowance: 'available', noAdditionalBilling: 'provider-enforced', paidOverflow: 'disabled', additionalCredits: 'disabled', autoRefill: 'disabled' };
  const proofPath = join(proofRoot, 'synthetic-lima-proof.json');
  writeFileSync(proofPath, JSON.stringify(proof), { mode: 0o600 });
  store = new Store(':memory:');
  store.save('projects', input.project); store.save('sources', input.source); store.save('tasks', input.task);
  const billing = new BillingAuthority(store, config, { async read() { return structuredClone(current); } }, { proofRoot, now: () => at });
  let disposed = false;
  return { billing, store, proofRoot, proofPath, proof, current, at, dispose() { if (disposed) return; disposed = true; try { store.close(); } finally { remove(); } } };
  } catch (error) { try { store?.close(); } finally { remove(); } throw error; }
}
