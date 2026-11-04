import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { z } from 'zod';
import { policySchema } from './config.js';
import { DomainError, SubscriptionAccessError, WorkerUnavailable, digest, roleSchemas, stableId, type AppConfig, type Attempt, type BillingBoundary, type HostSubscriptionObservation, type Project, type Runner, type RunnerPolicy, type Task, type WorkerAdapter, type WorkerInput, type WorkerResult } from './domain.js';
import { Store } from './store.js';

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const text = z.string().min(1).max(1024);
const date = z.iso.datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)));
const bindings = {
  projectId: text, domain: text, ownerFingerprint: text,
  runner: z.enum(['grok', 'dsh', 'codex']), provider: text, model: text,
  accountFingerprint: text, workspaceFingerprint: text, authRouteFingerprint: text,
  authMode: z.literal('subscription-oauth'), cliVersion: text, commandPolicyHash: text,
  networkPolicyHash: text, runtimeIdentityHash: text,
};
const admissionSchema = z.object({
  schemaVersion: z.literal(1), id: idSchema, ...bindings,
  allowance: z.object({ state: z.literal('verified-available'), checkedAt: date, evidenceDigest: text }).strict(),
  noAdditionalBilling: z.object({ state: z.literal('provider-enforced'), paidOverflow: z.literal('verified-disabled'), additionalCredits: z.literal('verified-disabled'), autoRefill: z.literal('verified-disabled'), evidenceDigest: text }).strict(),
  verifiedAt: date, expiresAt: date, evidenceDigest: text,
}).strict();
const currentSchema = z.object({
  ...bindings, checkedAt: date, principalVerifiedAt: date,
  allowance: z.literal('available'), noAdditionalBilling: z.literal('provider-enforced'),
  paidOverflow: z.literal('disabled'), additionalCredits: z.literal('disabled'), autoRefill: z.literal('disabled'),
}).strict();
export type IncludedAdmission = z.infer<typeof admissionSchema>;
export type CurrentBillingContext = z.infer<typeof currentSchema>;
export interface CurrentBillingContextProvider {
  read(policy: RunnerPolicy, project: Project): Promise<CurrentBillingContext | undefined>;
}
// The brand is type-only; the private identity registry below supplies authority.
declare const permitBrand: unique symbol;
export type HostDispatchPermit = { readonly [permitBrand]: true };
export interface ReservedDispatch { readonly attempt: Attempt; readonly permit: HostDispatchPermit }
const switchContextSchema = z.object({ fromAttemptId: text, reason: z.enum(['worker_unavailable', 'subscription_unavailable']) }).strict();
/** Trusted scheduler bookkeeping only; all scope and runner fields come from Store. */
export type TrustedSwitchContext = z.infer<typeof switchContextSchema>;
/** Preserve business input across host accounting/status updates; grants no dispatch permission. */
export function billingSwitchInputHash(input: WorkerInput, canonicalBoundary: BillingBoundary): string {
  const { attempts, spentUsd, attemptLimit, status, updatedAt, runAfter, error, blockedFrom, billingBoundary, ...task } = input.task;
  // Only an absent legacy value inherits the already validated host/Store route.
  return digest({ schemaVersion: 1, input: { ...input, task: { ...task, billingBoundary: billingBoundary === undefined ? canonicalBoundary : billingBoundary } } });
}
export type BillingDecision =
  | { allowed: true; reserveUsd: number; mode: 'metered-api' | 'included-subscription' }
  | { allowed: false; code: string; reserveUsd: 0 };
export type BillingStatus = {
  state: 'pending-proof' | 'included-admitted' | 'positive-reservation' | 'blocked';
  reason?: string; attemptsLimit: number; reserveUsd?: number;
};

const maxProofBytes = 64 * 1024;
function inside(path: string, root: string): boolean {
  const rel = relative(root, path); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function sameDirectory(a: Stats, b: Stats): boolean {
  // Unrelated child entries change directory size/link count/times, not its namespace identity or permissions.
  return a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
}
function validReceiptDates(proof: IncludedAdmission, at: number): boolean {
  return Date.parse(proof.allowance.checkedAt) <= Date.parse(proof.verifiedAt) && Date.parse(proof.verifiedAt) <= at && at < Date.parse(proof.expiresAt);
}

/** Fail-closed private-file mechanics. Does not establish real host/root qualification. */
export function loadIncludedAdmission(root: string, admissionId: string, excludedRoots: readonly string[]): IncludedAdmission | undefined {
  let fd: number | undefined;
  try {
    if (!idSchema.safeParse(admissionId).success || !isAbsolute(root) || !process.geteuid) return undefined;
    const resolved = resolve(root);
    // Reject known sync storage even if an exclusion was inadvertently omitted.
    if (resolved.split(sep).some(part => /^(?:同步空间|vault|\.git|dropbox|onedrive(?: - .*)?|google drive|googledrive|mobile documents|cloudstorage|syncthing|icloud(?: drive)?)$/i.test(part))) return undefined;
    for (const excluded of excludedRoots) {
      if (!isAbsolute(excluded)) return undefined;
      const canonical = (() => { try { return realpathSync(excluded); } catch { return resolve(excluded); } })();
      if (inside(resolved, canonical) || inside(resolved, resolve(excluded))) return undefined;
    }
    const uid = process.geteuid();
    const ancestors: { path: string; stat: Stats }[] = [];
    for (let path = resolved;; path = dirname(path)) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
      ancestors.unshift({ path, stat });
      if (path === parse(path).root) break;
    }
    let privateBoundary = false;
    for (const { path, stat } of ancestors) {
      const mode = stat.mode & 0o7777;
      if (stat.uid !== 0 && stat.uid !== uid) return undefined;
      if (stat.uid === uid && mode === 0o700) privateBoundary = true;
      if (privateBoundary || path === resolved) {
        if (stat.uid !== uid || mode !== 0o700) return undefined;
      } else if ((mode & 0o022) !== 0) return undefined;
    }
    const file = join(resolved, `${admissionId}.json`);
    const before = lstatSync(file);
    const safeFile = (stat: Stats) => stat.isFile() && stat.uid === uid && (stat.mode & 0o7777) === 0o600 && stat.nlink === 1 && stat.size <= maxProofBytes;
    if (!safeFile(before)) return undefined;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!safeFile(fstatSync(fd)) || !sameFile(before, fstatSync(fd))) return undefined;
    const bytes = Buffer.alloc(maxProofBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > maxProofBytes || size !== before.size || !sameFile(before, fstatSync(fd)) || !sameFile(before, lstatSync(file))) return undefined;
    for (const entry of ancestors) if (!sameDirectory(entry.stat, lstatSync(entry.path))) return undefined;
    const result = admissionSchema.safeParse(JSON.parse(bytes.subarray(0, size).toString('utf8')));
    if (!result.success || result.data.id !== admissionId || !validReceiptDates(result.data, Date.now())) return undefined;
    return result.data;
  } catch { return undefined; }
  finally {
    if (fd !== undefined) {
      // Attempt close once: a failure may occur after the descriptor was released.
      try { closeSync(fd); } catch { return undefined; }
    }
  }
}

/** Decision helper over an already host-pinned snapshot; never a dispatch gate. */
export function evaluateBilling(policy: RunnerPolicy, task: Task, project: Project, admission: IncludedAdmission | undefined, current: CurrentBillingContext | undefined, at: Date): BillingDecision {
  const deny = (code: string): BillingDecision => ({ allowed: false, code, reserveUsd: 0 });
  const parsed = policySchema.safeParse(policy);
  if (!parsed.success || !policy.admitted) return deny('billing_policy_invalid');
  const mode = policy.billing?.mode ?? 'metered-api';
  const boundary = task.billingBoundary === undefined ? 'metered-only' : task.billingBoundary;
  if (boundary !== 'metered-only' && boundary !== 'included-only') return deny('billing_policy_invalid');
  if ((mode === 'included-subscription') !== (boundary === 'included-only')) return deny('billing_route_forbidden');
  if (task.projectId !== project.id || project.projectId !== project.id || task.domain !== project.domain || !policy.domains.includes(project.domain) || !policy.roles.some(role => role === task.stage)) return deny('subscription_scope');
  if (task.billingStop) return deny(task.billingStop.code);
  if (['cancelled', 'archived', 'delivered'].includes(task.status)) return deny('billing_task_inactive');
  const limit = task.attemptLimit === undefined ? 32 : task.attemptLimit;
  if (!Number.isSafeInteger(task.attempts) || task.attempts < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 256) return deny('billing_counter_invalid');
  if (task.attempts >= limit) return deny('subscription_attempt_limit');
  if (![task.budgetUsd, project.budgetUsd, task.spentUsd].every(value => Number.isFinite(value) && value >= 0)) return deny('billing_budget_invalid');
  if (mode === 'metered-api') {
    const reserveUsd = policy.costPerRunUsd;
    if (!(reserveUsd > 0)) return deny('billing_policy_invalid');
    const spent = task.spentUsd + reserveUsd;
    if (!Number.isFinite(spent) || spent > task.budgetUsd || spent > project.budgetUsd) return deny('budget_exceeded');
    return { allowed: true, reserveUsd, mode };
  }
  const proof = admissionSchema.safeParse(admission), observed = currentSchema.safeParse(current);
  if (!proof.success || !observed.success || !Number.isFinite(at.getTime())) return deny('subscription_unverified');
  const receipt = proof.data, context = observed.data;
  if (policy.billing?.mode !== 'included-subscription' || receipt.id !== policy.billing.admissionId || receipt.projectId !== project.id || receipt.domain !== project.domain || receipt.runner !== policy.runner || receipt.provider !== policy.provider || receipt.model !== policy.model) return deny('subscription_scope');
  for (const key of Object.keys(bindings) as (keyof typeof bindings)[]) if (receipt[key] !== context[key]) return deny('subscription_scope');
  const time = at.getTime(), verified = Date.parse(receipt.verifiedAt);
  if (time >= Date.parse(receipt.expiresAt)) return deny('subscription_expired');
  if (!validReceiptDates(receipt, time)) return deny('subscription_unverified');
  for (const value of [context.checkedAt, context.principalVerifiedAt]) {
    const checked = Date.parse(value);
    if (checked < verified || checked > time || time - checked > 60000) return deny('subscription_unverified');
  }
  return { allowed: true, reserveUsd: 0, mode };
}

const refusalReasons = z.enum(['quota', 'persistent-rate-limit', 'expired-credential', 'invalid-credential', 'provider-refusal']);
const incidentReasons = z.enum(['positive-included-cost', 'paid-route-used', 'extra-credit-used', 'no-charge-boundary-breached', 'charge-danger-unknown']);
const observationSchema = z.discriminatedUnion('disposition', [
  z.object({ disposition: z.literal('verified-no-charge-refusal'), reason: refusalReasons, observedAt: date, evidenceDigest: text, noChargeEvidenceDigest: text }).strict(),
  z.object({ disposition: z.literal('billing-incident'), reason: z.enum(['paid-route-used', 'extra-credit-used', 'no-charge-boundary-breached', 'charge-danger-unknown']), observedAt: date, evidenceDigest: text }).strict(),
]);
const holdSchema = z.object({ schemaVersion: z.literal(1), profileHash: text.optional(), admissionId: idSchema, code: z.literal('billing_policy_violation'), reason: incidentReasons, attemptId: text, evidenceDigest: text, detectedAt: date }).strict();
const availabilitySchema = z.object({ schemaVersion: z.literal(1), profileHash: text, admissionId: idSchema, attemptId: text, reason: refusalReasons, observedAt: date, evidenceDigest: text, noChargeEvidenceDigest: text, restoredAt: date.optional(), restorationEvidenceDigest: text.optional() }).strict();
type Evidence = { admission?: IncludedAdmission; current?: CurrentBillingContext };
type PermitRecord = {
  authority: BillingAuthority; store: Store; epoch: string; attempt: Attempt; policy: RunnerPolicy;
  inputHash: string; sourceHash: string; runtimeHash: string; proofHash?: string; profileHash?: string;
  state: 'reserved' | 'dispatching' | 'dispatched' | 'entering' | 'adapter-entered' | 'settled'; owner: 'scheduler' | 'direct';
};
type RegistrationSnapshot = { taskHash: string; attemptsHash: string; switchRows?: { noticeId: string; noticeHash: string; eventId: string; eventHash: string } };
const permits = new WeakMap<HostDispatchPermit, PermitRecord>();
const authorityBindings = new WeakMap<BillingAuthority, { store: Store; config: AppConfig }>();
/** Lima has no separate Store: its authority owns that binding; config must be canonical. */
export function assertBillingAuthorityConfig(authority: BillingAuthority, config: AppConfig): void {
  const binding = authorityBindings.get(authority);
  if (!binding || binding.config !== config) throw error('billing_authority_mismatch');
}
/** Validate shared host identity without exposing a Store/config getter or rebinding operation. */
export function assertBillingAuthorityBinding(authority: BillingAuthority, store: Store, config: AppConfig): void {
  const binding = authorityBindings.get(authority);
  if (!binding || binding.store !== store || binding.config !== config) throw error('billing_authority_mismatch');
}
const terminal = new Set(['cancelled', 'archived', 'delivered']);
function error(code: string): DomainError { return new DomainError(`Billing authorization denied: ${code}.`, code, 409); }
function profileHash(proof: IncludedAdmission): string {
  return digest({ projectId: proof.projectId, domain: proof.domain, owner: proof.ownerFingerprint, account: proof.accountFingerprint, workspace: proof.workspaceFingerprint, provider: proof.provider, authRoute: proof.authRouteFingerprint, authMode: proof.authMode });
}
function boundary(config: AppConfig): BillingBoundary {
  const value = config.billingBoundary === undefined ? 'metered-only' : config.billingBoundary;
  if (value !== 'included-only' && value !== 'metered-only') throw error('billing_policy_invalid');
  return value;
}
function configuredLimit(config: AppConfig): number {
  const limit = config.maxAttemptsPerTask === undefined ? 32 : config.maxAttemptsPerTask;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw error('billing_counter_invalid');
  return limit;
}
function projectRoute(project: Project): object {
  const { id, projectId, domain, repository, repositoryProvider, prdPath, allowedPaths, trustedChecks, trustedAppIds, ownerId, autoMerge, executionRunner, sourceDir } = project;
  return { id, projectId, domain, repository, repositoryProvider, prdPath, allowedPaths, trustedChecks, trustedAppIds, ownerId, autoMerge, executionRunner, sourceDir };
}

/** Single leased host authority. Never serialize a permit or await within a Store transaction. */
export class BillingAuthority {
  private readonly epoch = randomUUID();
  private readonly clock: () => Date;
  private readonly proofRoot?: string;
  private faulted = false;
  constructor(private readonly store: Store, private readonly config: AppConfig, private readonly current: CurrentBillingContextProvider, options: { proofRoot?: string; now?: () => Date } = {}) {
    this.clock = options.now ?? (() => new Date()); this.proofRoot = options.proofRoot;
    authorityBindings.set(this, { store, config });
  }

  /** Caller must own the exclusive host lease before using this initialization operation. */
  reconcileAbandoned(): void {
    try {
      this.store.transaction(() => {
        const at = this.timestamp();
        for (const attempt of this.store.list('attempts')) {
          if (attempt.status !== 'running' || attempt.billing?.authorityEpoch === this.epoch) continue;
          this.store.save('attempts', { ...attempt, status: 'failed', finishedAt: at, error: 'attempt_abandoned_after_host_restart', ...(attempt.billing ? { billing: { ...attempt.billing, abandonedAt: at } } : {}) });
        }
      });
    } catch { this.faulted = true; throw error('attempt_recovery_required'); }
  }

  async reserve(input: WorkerInput, runner: Runner, switchContext?: TrustedSwitchContext): Promise<ReservedDispatch> {
    this.assertOperational();
    const inputHash = digest(input), policy = this.policy(runner, input), project = this.store.get('projects', input.task.projectId);
    if (!project) throw error('subscription_scope');
    this.pin(input);
    const evidence = await this.evidence(policy, project);
    this.pin(input);
    let pending: PermitRecord | undefined, snapshot: RegistrationSnapshot | undefined;
    let outcome: PermitRecord | string;
    try { outcome = this.store.transaction((): PermitRecord | string => {
      this.assertOperational();
      if (digest(input) !== inputHash || digest(this.policy(runner, input)) !== digest(policy)) throw error('input_mutated');
      let task = this.scope(input); const authoritativeProject = this.store.get('projects', task.projectId)!;
      const hostBoundary = boundary(this.config);
      if (task.billingBoundary === undefined) { task = { ...task, billingBoundary: hostBoundary }; this.store.save('tasks', task); }
      this.assertBoundary(task, input, policy);
      const limit = this.limit(task); task = { ...task, attemptLimit: limit }; this.store.save('tasks', task);
      if (task.billingStop) return task.billingStop.code;
      if (task.attempts >= limit) { this.stopAtLimit(task); return 'subscription_attempt_limit'; }
      if (this.store.list('attempts').some(a => a.taskId === task.id && a.status === 'running')) throw error('attempt_in_progress');
      const decision = evaluateBilling(policy, task, authoritativeProject, evidence.admission, evidence.current, this.clock());
      if (!decision.allowed) return decision.code;
      this.assertProofUnchanged(policy, evidence);
      this.checkHolds(authoritativeProject, policy, evidence, true);
      this.assertChecker(task, policy);
      const switchInputHash = billingSwitchInputHash(input, task.billingBoundary!);
      const prior = switchContext === undefined ? undefined : this.switchPrior(task, runner, inputHash, switchInputHash, switchContext);
      const at = this.timestamp(), ordinal = task.attempts + 1;
      const attempt: Attempt = { id: randomUUID(), projectId: task.projectId, domain: task.domain, taskId: task.id, taskVersion: task.version, role: input.role, runner, model: policy.model, provider: policy.provider, inputHash, status: 'running', costUsd: decision.reserveUsd, startedAt: at,
        billing: { mode: decision.mode, reserveUsd: decision.reserveUsd, ordinal, attemptLimit: limit, policyHash: digest(policy), billingBoundary: hostBoundary, authorityEpoch: this.epoch, dispatchState: 'reserved', switchInputHash, ...(evidence.admission ? { admissionId: evidence.admission.id, evidenceDigest: evidence.admission.evidenceDigest, profileHash: profileHash(evidence.admission) } : {}) } };
      const switchRows = prior ? { noticeId: stableId('fallback', prior.id, attempt.id), eventId: stableId('switch-event', prior.id, attempt.id) } : undefined;
      snapshot = { taskHash: digest(task), attemptsHash: digest(this.store.list('attempts').filter(a => a.taskId === task.id)), ...(switchRows ? { switchRows: { ...switchRows, noticeHash: digest(this.store.get('outbox', switchRows.noticeId) ?? {}), eventHash: digest(this.store.get('events', switchRows.eventId) ?? {}) } } : {}) };
      pending = { authority: this, store: this.store, epoch: this.epoch, attempt: structuredClone(attempt), policy: structuredClone(policy), inputHash, sourceHash: digest(input.source), runtimeHash: this.runtimeHash(runner), ...(evidence.admission ? { proofHash: digest(evidence.admission), profileHash: profileHash(evidence.admission) } : {}), state: 'reserved', owner: 'scheduler' };
      this.store.save('attempts', attempt);
      this.store.save('tasks', { ...task, attempts: ordinal, spentUsd: task.spentUsd + decision.reserveUsd, updatedAt: at });
      if (prior && switchRows) {
        this.store.save('outbox', { id: switchRows.noticeId, projectId: task.projectId, domain: task.domain, taskId: task.id, channel: this.config.feishu ? 'feishu' : 'origin', recipient: this.config.feishu?.ownerOpenId ?? this.config.ownerId, text: `${task.title} · ${task.stage}: ${prior.runner} → ${runner}. 原因：${prior.error}。已继续原任务。`, status: 'pending', attempts: 0, runAfter: at, createdAt: at });
        this.store.save('events', { id: switchRows.eventId, projectId: task.projectId, domain: task.domain, taskId: task.id, type: 'worker.switched', message: `${task.stage}: ${prior.runner} → ${runner}`, createdAt: at, data: { from: prior.runner, to: runner, role: task.stage } });
      }
      return pending;
    }); } catch (cause) {
      if (pending && snapshot) this.registrationFailure(pending, snapshot);
      throw cause;
    }
    if (typeof outcome === 'string') throw error(outcome);
    // No capability exists until Store has confirmed the complete allocation committed.
    const permit = Object.freeze({}) as HostDispatchPermit;
    permits.set(permit, outcome);
    return { attempt: structuredClone(outcome.attempt), permit };
  }

  private switchPrior(task: Task, runner: Runner, inputHash: string, switchInputHash: string, context: TrustedSwitchContext): Attempt {
    const parsed = switchContextSchema.safeParse(context);
    if (!parsed.success) throw error('billing_switch_invalid');
    const prior = this.store.get('attempts', parsed.data.fromAttemptId), latest = this.store.list('attempts').filter(a => a.taskId === task.id && a.taskVersion === task.version && a.role === task.stage).at(-1);
    if (!prior || latest?.id !== prior.id || prior.projectId !== task.projectId || prior.domain !== task.domain || prior.taskId !== task.id || prior.taskVersion !== task.version || prior.role !== task.stage || prior.runner === runner || !['grok', 'dsh', 'codex'].includes(prior.runner) || prior.status !== 'unavailable' || prior.error !== parsed.data.reason || prior.inputHash !== inputHash && prior.billing?.switchInputHash !== switchInputHash) throw error('billing_switch_invalid');
    return prior;
  }

  private registrationFailure(record: PermitRecord, snapshot: RegistrationSnapshot): void {
    try {
      const rows = snapshot.switchRows;
      if (!this.store.get('attempts', record.attempt.id) && digest(this.store.get('tasks', record.attempt.taskId) ?? {}) === snapshot.taskHash && digest(this.store.list('attempts').filter(a => a.taskId === record.attempt.taskId)) === snapshot.attemptsHash && (!rows || digest(this.store.get('outbox', rows.noticeId) ?? {}) === rows.noticeHash && digest(this.store.get('events', rows.eventId) ?? {}) === rows.eventHash)) return;
    } catch { /* Unreadable post-allocation state is not proof of rollback. */ }
    this.faulted = true;
    try {
      const attempt = this.store.get('attempts', record.attempt.id);
      if (attempt && digest(attempt) === digest(record.attempt)) this.store.save('attempts', { ...attempt, status: 'failed', error: 'billing_registration_failed', finishedAt: this.timestamp() });
    } catch { /* Keep this authority closed even when terminalization cannot persist. */ }
    throw error('billing_registration_failed');
  }

  async dispatch(reserved: ReservedDispatch, input: WorkerInput, worker: WorkerAdapter, signal?: AbortSignal): Promise<WorkerResult> {
    const record = this.record(reserved.permit);
    if (record.state !== 'reserved' || digest(reserved.attempt) !== digest(record.attempt) || worker.name !== record.attempt.runner) throw error('billing_permit_invalid');
    record.state = 'dispatching';
    try {
      await this.transition(record, input, 'dispatching', 'dispatched');
      if (signal?.aborted) throw error('worker_aborted');
      const result = await worker.run(input, signal, reserved.permit);
      return this.settleResult(record, input, result);
    } catch (cause) { throw this.settleFailure(record, cause); }
    finally { record.state = 'settled'; }
  }

  async runLima(input: WorkerInput, runner: Runner, signal: AbortSignal | undefined, permit: HostDispatchPermit | undefined, launch: (policy: RunnerPolicy, signal?: AbortSignal) => Promise<WorkerResult>): Promise<WorkerResult> {
    if (permit !== undefined) {
      const record = this.record(permit);
      if (record.attempt.runner !== runner || record.state !== 'dispatched') throw error('billing_permit_invalid');
      record.state = 'entering';
      await this.transition(record, input, 'entering', 'adapter-entered');
      if (signal?.aborted) throw error('worker_aborted');
      return launch(structuredClone(record.policy), signal);
    }
    const reserved = await this.reserve(input, runner), record = this.record(reserved.permit); record.owner = 'direct';
    return this.dispatch(reserved, input, { name: runner, run: async (_input, activeSignal) => {
      record.state = 'entering';
      await this.transition(record, input, 'entering', 'adapter-entered');
      if (activeSignal?.aborted) throw error('worker_aborted');
      return launch(structuredClone(record.policy), activeSignal);
    } }, signal);
  }

  async status(project: Project, policy: RunnerPolicy): Promise<BillingStatus> {
    let attemptsLimit = 32;
    try {
      attemptsLimit = configuredLimit(this.config); this.assertOperational();
      const currentProject = this.store.get('projects', project.id);
      if (!currentProject || currentProject.domain !== project.domain || !policySchema.safeParse(policy).success || !policy.admitted) throw error('billing_policy_invalid');
      if (digest(this.config.runnerPolicies.find(p => p.runner === policy.runner && p.admitted && p.domains.includes(project.domain)) ?? {}) !== digest(policy)) throw error('billing_policy_invalid');
      const evidence = await this.evidence(policy, currentProject);
      const task = { projectId: project.id, domain: project.domain, stage: policy.roles[0], billingBoundary: boundary(this.config), attempts: 0, attemptLimit: attemptsLimit, budgetUsd: currentProject.budgetUsd, spentUsd: 0, status: 'queued' } as Task;
      const decision = evaluateBilling(policy, task, currentProject, evidence.admission, evidence.current, this.clock());
      if (!decision.allowed) return { state: decision.code.startsWith('subscription_') ? 'pending-proof' : 'blocked', reason: decision.code, attemptsLimit };
      this.checkHolds(currentProject, policy, evidence, false);
      return { state: decision.mode === 'included-subscription' ? 'included-admitted' : 'positive-reservation', reserveUsd: decision.reserveUsd, attemptsLimit };
    } catch (cause) { return { state: 'blocked', reason: cause instanceof DomainError ? cause.code : 'billing_policy_invalid', attemptsLimit }; }
  }

  private timestamp(): string { const at = this.clock(); if (!Number.isFinite(at.getTime())) throw error('billing_policy_invalid'); return at.toISOString(); }
  private assertOperational(): void {
    if (this.faulted) throw error('billing_policy_violation');
    if (this.store.list('attempts').some(a => a.status === 'running' && a.billing?.authorityEpoch !== this.epoch)) throw error('attempt_recovery_required');
  }
  private record(permit: HostDispatchPermit): PermitRecord {
    const record = typeof permit === 'object' && permit !== null ? permits.get(permit) : undefined;
    if (!record || record.authority !== this || record.store !== this.store || record.epoch !== this.epoch || record.state === 'settled') throw error('billing_permit_invalid');
    return record;
  }
  private policy(runner: Runner, input: WorkerInput): RunnerPolicy {
    const policy = this.config.runnerPolicies.find(p => p.runner === runner && p.admitted && p.roles.includes(input.role) && p.domains.includes(input.task.domain));
    if (!policy || !policySchema.safeParse(policy).success) throw error('billing_policy_invalid');
    return structuredClone(policy);
  }
  private scope(input: WorkerInput): Task {
    const task = this.store.get('tasks', input.task.id), project = task && this.store.get('projects', task.projectId), source = task && this.store.get('sources', task.sourceId);
    if (project && digest(projectRoute(project)) !== digest(projectRoute(input.project))) throw error('subscription_scope');
    if (!task || !project || !source || task.projectId !== project.id || project.projectId !== project.id || task.domain !== project.domain || source.projectId !== project.id || source.domain !== project.domain || input.project.id !== project.id || input.project.projectId !== project.id || input.project.domain !== project.domain || input.task.projectId !== task.projectId || input.task.domain !== task.domain || task.version !== input.task.version || task.stage !== input.task.stage || task.stage !== input.role || task.sourceId !== input.task.sourceId || task.sourceRevision !== input.task.sourceRevision || source.status !== 'active' || source.revision !== task.sourceRevision || digest(source) !== digest(input.source) || terminal.has(task.status)) throw error('stale_attempt');
    return task;
  }
  private assertBoundary(task: Task, input: WorkerInput, policy: RunnerPolicy): void {
    const host = boundary(this.config);
    if (task.billingBoundary !== host || (input.task.billingBoundary !== undefined && input.task.billingBoundary !== task.billingBoundary)) throw error('billing_boundary_mismatch');
    if ((policy.billing?.mode === 'included-subscription') !== (host === 'included-only')) throw error('billing_route_forbidden');
  }
  private pin(input: WorkerInput): void {
    this.store.transaction(() => {
      const current = this.scope(input), host = boundary(this.config), task = { ...current, billingBoundary: current.billingBoundary === undefined ? host : current.billingBoundary };
      if (task.billingBoundary !== host || (input.task.billingBoundary !== undefined && input.task.billingBoundary !== task.billingBoundary)) throw error('billing_boundary_mismatch');
      const limit = this.limit(task);
      if (task.billingBoundary !== current.billingBoundary || limit !== current.attemptLimit) this.store.save('tasks', { ...task, attemptLimit: limit });
    });
  }
  private limit(task: Task): number {
    const configured = configuredLimit(this.config), persisted = task.attemptLimit === undefined ? configured : task.attemptLimit;
    if (!Number.isSafeInteger(persisted) || persisted < 1 || persisted > 256 || !Number.isSafeInteger(task.attempts) || task.attempts < 0) throw error('billing_counter_invalid');
    const history = this.store.list('attempts').filter(a => a.taskId === task.id), ordinals = new Set<number>();
    if (history.length > task.attempts) throw error('billing_counter_invalid');
    for (const attempt of history) {
      if (attempt.projectId !== task.projectId || attempt.domain !== task.domain || !Number.isFinite(attempt.costUsd) || attempt.costUsd < 0) throw error('billing_counter_invalid');
      if (attempt.billing) {
        const ordinal = attempt.billing.ordinal;
        if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > task.attempts || ordinals.has(ordinal)) throw error('billing_counter_invalid');
        ordinals.add(ordinal);
      }
    }
    return Math.min(configured, persisted);
  }
  private assertChecker(task: Task, policy: RunnerPolicy): void {
    if (task.stage !== 'check') return;
    const executor = this.store.list('attempts').filter(a => a.taskId === task.id && a.taskVersion === task.version && a.role === 'execute' && a.status === 'succeeded').at(-1);
    if (executor?.runner === policy.runner && !policy.independentReview) throw error('independent_review_required');
  }
  private excludedRoots(): string[] {
    return [process.cwd(), this.config.vaultDir, this.store.vaultDirectory() ?? '', ...this.config.projects.map(p => p.sourceDir ?? ''), join(homedir(), '同步空间'), join(homedir(), 'Dropbox'), join(homedir(), 'Library', 'CloudStorage'), join(homedir(), 'Library', 'Mobile Documents')].filter(path => path !== '' && isAbsolute(path));
  }
  private proof(policy: RunnerPolicy): IncludedAdmission | undefined {
    return this.proofRoot && policy.billing?.mode === 'included-subscription' ? loadIncludedAdmission(this.proofRoot, policy.billing.admissionId, this.excludedRoots()) : undefined;
  }
  private async evidence(policy: RunnerPolicy, project: Project): Promise<Evidence> {
    if (policy.billing?.mode !== 'included-subscription') return {};
    let current: CurrentBillingContext | undefined;
    try { current = await this.current.read(structuredClone(policy), structuredClone(project)); } catch { current = undefined; }
    return { admission: this.proof(policy), current: current && structuredClone(current) };
  }
  private assertProofUnchanged(policy: RunnerPolicy, evidence: Evidence): void {
    if (policy.billing?.mode === 'included-subscription' && digest(this.proof(policy) ?? {}) !== digest(evidence.admission ?? {})) throw error('subscription_unverified');
  }
  private runtimeHash(runner: Runner): string { return digest(this.config.workers[runner] ?? {}); }

  private checkHolds(project: Project, policy: RunnerPolicy, evidence: Evidence, restore: boolean): void {
    if (policy.billing?.mode !== 'included-subscription') return;
    const admissionId = policy.billing.admissionId, hash = evidence.admission && profileHash(evidence.admission);
    const holdIds = [stableId('billing-admission-hold', project.id, project.domain, admissionId), ...(hash ? [stableId('billing-hold', project.id, project.domain, hash)] : [])];
    for (const id of holdIds) {
      const hold = this.store.get('actions', id);
      if (hold) { if (!holdSchema.safeParse(hold.payload).success || hold.kind !== 'billing_hold' || hold.projectId !== project.id || hold.domain !== project.domain) throw error('billing_policy_violation'); throw error('billing_policy_violation'); }
    }
    if (!hash) throw error('subscription_unverified');
    const refusals = this.store.list('actions').filter(a => a.projectId === project.id && a.domain === project.domain && a.kind === 'billing_profile_unavailable');
    for (const action of refusals) {
      const parsed = availabilitySchema.safeParse(action.payload);
      if (!parsed.success) throw error('billing_policy_violation');
      if (action.status === 'completed' && (!parsed.data.restoredAt || !parsed.data.restorationEvidenceDigest || Date.parse(parsed.data.restoredAt) <= Date.parse(parsed.data.observedAt))) throw error('billing_policy_violation');
      if (parsed.data.profileHash !== hash || action.status === 'completed') continue;
      const refusal = Date.parse(parsed.data.observedAt), proof = evidence.admission, current = evidence.current;
      if (!proof || !current || ![proof.allowance.checkedAt, proof.verifiedAt, current.checkedAt, current.principalVerifiedAt].every(value => Date.parse(value) > refusal)) throw error('subscription_profile_unavailable');
      if (restore) this.store.save('actions', { ...action, status: 'completed', payload: { ...parsed.data, restoredAt: this.timestamp(), restorationEvidenceDigest: proof.evidenceDigest }, updatedAt: this.timestamp() });
    }
  }

  private async transition(record: PermitRecord, input: WorkerInput, expected: 'dispatching' | 'entering', next: 'dispatched' | 'adapter-entered'): Promise<void> {
    if (record.state !== expected) throw error('billing_permit_invalid');
    this.pin(input);
    const evidence = await this.evidence(record.policy, this.store.get('projects', record.attempt.projectId) ?? input.project);
    this.pin(input);
    this.store.transaction(() => {
      if (record.state !== expected) throw error('billing_permit_invalid'); this.assertOperational();
      if (digest(input) !== record.inputHash || digest(this.policy(record.attempt.runner, input)) !== digest(record.policy) || this.runtimeHash(record.attempt.runner) !== record.runtimeHash) throw error('billing_permit_invalid');
      const task = this.scope(input), project = this.store.get('projects', task.projectId)!, attempt = this.store.get('attempts', record.attempt.id), allocated = record.attempt.billing!;
      this.assertBoundary(task, input, record.policy);
      if (task.billingStop && task.billingStop.code !== 'subscription_attempt_limit') throw error(task.billingStop.code);
      const limit = this.limit(task);
      if (!attempt || attempt.status !== 'running' || attempt.inputHash !== record.inputHash || attempt.taskVersion !== record.attempt.taskVersion || attempt.runner !== record.attempt.runner || attempt.model !== record.attempt.model || attempt.provider !== record.attempt.provider || attempt.projectId !== record.attempt.projectId || attempt.domain !== record.attempt.domain || !attempt.billing || digest({ ...attempt.billing, dispatchState: 'reserved' }) !== digest(allocated) || attempt.billing.dispatchState !== (expected === 'dispatching' ? 'reserved' : 'dispatched') || allocated.ordinal > limit || task.attempts < allocated.ordinal || digest(input.source) !== record.sourceHash) throw error('billing_permit_invalid');
      const latest = this.store.list('attempts').filter(a => a.taskId === task.id && a.taskVersion === task.version && a.role === input.role).at(-1);
      if (latest?.id !== attempt.id) throw error('stale_attempt');
      // Validate this allocated slot. It is not a request for a new count or paid reservation.
      const snapshot = { ...task, attempts: allocated.ordinal - 1, attemptLimit: limit, billingStop: undefined, spentUsd: task.spentUsd - allocated.reserveUsd };
      const decision = evaluateBilling(record.policy, snapshot, project, evidence.admission, evidence.current, this.clock());
      if (!decision.allowed) throw error(decision.code);
      this.assertProofUnchanged(record.policy, evidence);
      if (record.proofHash && (!evidence.admission || digest(evidence.admission) !== record.proofHash || profileHash(evidence.admission) !== record.profileHash)) throw error('subscription_scope');
      this.checkHolds(project, record.policy, evidence, false); this.assertChecker(task, record.policy);
      this.store.save('attempts', { ...attempt, billing: { ...attempt.billing, dispatchState: next } }); record.state = next;
    });
  }

  private charge(record: PermitRecord, reported: number): void {
    if (!Number.isFinite(reported) || reported < 0) return;
    this.store.transaction(() => {
      const attempt = this.store.get('attempts', record.attempt.id), task = this.store.get('tasks', record.attempt.taskId);
      if (!attempt || !task || !Number.isFinite(attempt.costUsd) || !Number.isFinite(task.spentUsd)) { this.faulted = true; throw error('billing_counter_invalid'); }
      const costUsd = Math.max(attempt.costUsd, reported), delta = costUsd - attempt.costUsd;
      if (!Number.isFinite(task.spentUsd + delta)) { this.faulted = true; throw error('billing_counter_invalid'); }
      this.store.save('attempts', { ...attempt, costUsd }); this.store.save('tasks', { ...task, spentUsd: task.spentUsd + delta, updatedAt: this.timestamp() });
    });
  }
  private settleResult(record: PermitRecord, input: WorkerInput, result: WorkerResult): WorkerResult {
    // Accounting precedes all mutable input, stale scope, provider and schema validation.
    const includedCharge = record.attempt.billing?.mode === 'included-subscription' && Number.isFinite(result?.costUsd) && result.costUsd > 0;
    try { this.charge(record, result?.costUsd); }
    catch (cause) { this.faulted = true; if (includedCharge) throw this.incident(record, 'positive-included-cost'); throw cause; }
    if (includedCharge) throw this.incident(record, 'positive-included-cost');
    if (digest(input) !== record.inputHash) throw error('input_mutated');
    const task = this.scope(input), attempt = this.store.get('attempts', record.attempt.id);
    const latest = this.store.list('attempts').filter(a => a.taskId === task.id && a.taskVersion === task.version && a.role === input.role).at(-1);
    if (attempt?.status !== 'running' || attempt.inputHash !== record.inputHash || attempt.taskId !== record.attempt.taskId || attempt.taskVersion !== record.attempt.taskVersion || attempt.role !== record.attempt.role || attempt.runner !== record.attempt.runner || attempt.projectId !== record.attempt.projectId || attempt.domain !== record.attempt.domain || attempt.provider !== record.attempt.provider || attempt.model !== record.attempt.model || latest?.id !== attempt.id) throw error('stale_attempt');
    if (!Number.isFinite(result?.costUsd) || result.costUsd < 0) throw error('invalid_cost');
    if (result.provider !== record.policy.provider || result.model !== record.policy.model) throw error('provider_not_admitted');
    const output = roleSchemas[input.role].safeParse(result.output); if (!output.success) throw error('invalid_worker_output');
    const project = this.store.get('projects', task.projectId)!;
    if (task.spentUsd > Math.min(task.budgetUsd, project.budgetUsd)) throw error('budget_exhausted');
    this.store.save('attempts', { ...attempt, status: 'succeeded', finishedAt: this.timestamp() });
    return { ...result, output: output.data };
  }
  private settleFailure(record: PermitRecord, cause: unknown): unknown {
    if (cause instanceof SubscriptionAccessError && record.attempt.billing?.mode === 'included-subscription') {
      const observation = observationSchema.safeParse(cause.observation), attempt = this.store.get('attempts', record.attempt.id);
      if (!observation.success || Date.parse(observation.data.observedAt) > this.clock().getTime() || Date.parse(observation.data.observedAt) < Date.parse(record.attempt.startedAt) || !record.profileHash || (attempt?.costUsd ?? 0) > 0) return this.incident(record, 'charge-danger-unknown');
      if (observation.data.disposition === 'billing-incident') return this.incident(record, observation.data.reason, observation.data.evidenceDigest);
      const observed = observation.data;
      try {
        this.store.transaction(() => {
          const currentAttempt = this.store.get('attempts', record.attempt.id)!;
          this.store.save('attempts', { ...currentAttempt, status: 'unavailable', finishedAt: this.timestamp(), error: 'subscription_unavailable' });
          this.store.save('actions', { id: stableId('billing-profile-refusal', record.attempt.projectId, record.attempt.domain, record.profileHash, record.attempt.id), projectId: record.attempt.projectId, domain: record.attempt.domain, kind: 'billing_profile_unavailable', status: 'pending', payload: { schemaVersion: 1, profileHash: record.profileHash!, admissionId: record.attempt.billing!.admissionId!, attemptId: record.attempt.id, reason: observed.reason, observedAt: observed.observedAt, evidenceDigest: observed.evidenceDigest, noChargeEvidenceDigest: observed.noChargeEvidenceDigest }, updatedAt: this.timestamp() });
        });
      } catch { return this.incident(record, 'charge-danger-unknown'); }
      return new SubscriptionAccessError(observed, 'Verified included access is currently unavailable.');
    }
    const attempt = this.store.get('attempts', record.attempt.id);
    if (attempt?.error === 'billing_policy_violation') return error('billing_policy_violation');
    if (attempt?.status === 'running') {
      const code = cause instanceof DomainError ? cause.code : cause instanceof WorkerUnavailable ? 'worker_unavailable' : 'worker_failed';
      this.store.save('attempts', { ...attempt, status: cause instanceof WorkerUnavailable ? 'unavailable' : code === 'stale_attempt' && record.state !== 'dispatching' ? 'stale' : 'failed', error: code, finishedAt: this.timestamp() });
    }
    return cause;
  }
  private incident(record: PermitRecord, reason: z.infer<typeof incidentReasons>, evidenceDigest?: string): DomainError {
    const at = this.timestamp(), admissionId = record.attempt.billing?.admissionId ?? (record.policy.billing?.mode === 'included-subscription' ? record.policy.billing.admissionId : 'unknown');
    const holdId = record.profileHash ? stableId('billing-hold', record.attempt.projectId, record.attempt.domain, record.profileHash) : stableId('billing-admission-hold', record.attempt.projectId, record.attempt.domain, admissionId);
    const stopTask = () => {
      const task = this.store.get('tasks', record.attempt.taskId);
      if (task) this.store.save('tasks', { ...task, ...(!terminal.has(task.status) ? { status: 'blocked' as const } : {}), billingStop: { code: 'billing_policy_violation', at, holdId }, error: 'billing_policy_violation', updatedAt: at });
    };
    try {
      this.store.transaction(() => {
        stopTask(); const attempt = this.store.get('attempts', record.attempt.id);
        if (attempt) this.store.save('attempts', { ...attempt, status: 'failed', finishedAt: at, error: 'billing_policy_violation' });
        if (!this.store.get('actions', holdId)) {
          const payload = { schemaVersion: 1, ...(record.profileHash ? { profileHash: record.profileHash } : {}), admissionId, code: 'billing_policy_violation', reason, attemptId: record.attempt.id, evidenceDigest: evidenceDigest ?? record.attempt.billing?.evidenceDigest ?? 'unavailable', detectedAt: at };
          this.store.save('actions', { id: holdId, projectId: record.attempt.projectId, domain: record.attempt.domain, kind: 'billing_hold', status: 'pending', payload, updatedAt: at });
        }
        this.notice(record.attempt, stableId('billing-incident-notice', holdId), 'Included billing boundary violation. Automatic model work is stopped. Owner review is required.');
      });
    } catch { this.faulted = true; try { stopTask(); } catch { /* This authority remains fail-closed if storage is unavailable. */ } }
    return error('billing_policy_violation');
  }
  private stopAtLimit(task: Task): void {
    const at = this.timestamp();
    this.store.save('tasks', { ...task, status: 'blocked', billingStop: { code: 'subscription_attempt_limit', at }, error: 'subscription_attempt_limit', updatedAt: at });
    this.notice(task, stableId('billing-attempt-limit', task.id), 'The shared task attempt limit is exhausted. Automatic model work is stopped.');
  }
  private notice(scope: { projectId: string; domain: string }, id: string, message: string): void {
    if (this.store.get('outbox', id)) return; const at = this.timestamp();
    this.store.save('outbox', { id, projectId: scope.projectId, domain: scope.domain, channel: this.config.feishu ? 'feishu' : 'origin', recipient: this.config.feishu?.ownerOpenId ?? this.config.ownerId, text: message, status: 'pending', attempts: 0, runAfter: at, createdAt: at });
  }
}
