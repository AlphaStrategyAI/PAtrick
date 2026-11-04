import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { policySchema } from './config.js';
import type { Attempt, Project, RunnerPolicy, Task } from './domain.js';

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
// A type contract only. No issuer or dispatch capability exists in Task 1.
declare const permitBrand: unique symbol;
export type HostDispatchPermit = { readonly [permitBrand]: true };
export interface ReservedDispatch { readonly attempt: Attempt; readonly permit: HostDispatchPermit }
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
