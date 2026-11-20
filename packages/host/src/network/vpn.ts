/** Local policy only. The supervisor applies an approved repair under its host lock. */
type TargetRole = 'hub' | 'target' | 'peer';
type Target = Readonly<{ id: string; role: TargetRole }>;
export type VpnClient = 'openvpn' | 'shadowrocket';
export type VpnRole = 'intranet' | 'public';
type VpnPath = Readonly<{ id: string; client: VpnClient; targets: readonly string[] }>;
export type FixedRepair =
  | Readonly<{ id: string; kind: 'refresh_dns' | 'refresh_proxy'; target: string }>
  | Readonly<{ id: string; kind: 'reconnect_vpn'; target: string; path: string }>;
type Fallback = 'device_split' | 'controlled_rotation';
export type NetworkPolicy = Readonly<{
  schema_version: '1.0'; device_id: string; revision: number; targets: readonly Target[]; vpn_paths: readonly VpnPath[];
  repairs: readonly FixedRepair[]; limits: Readonly<{ maximum_attempts: number; cooldown_ms: number; deadline_ms: number }>;
  fallback: Fallback | 'none';
}>;

type Outcome = 'passed' | 'failed' | 'unknown';
export type VpnTrial = Readonly<{
  deviceId: string;
  policyRevision: number;
  environmentDigest: string;
  order: readonly [string, string];
  observedAt: string;
  concurrentAccess: Outcome;
  enterpriseDns: Outcome;
  reconnect: Outcome;
  peer: Outcome;
}>;
export type VpnCapability =
  | Readonly<{ dual_path: null; state: 'unknown'; fallback: null; observed_at: string | null }>
  | Readonly<{ dual_path: true; state: 'supported'; fallback: null; observed_at: string }>
  | Readonly<{ dual_path: false; state: 'conflict'; fallback: Fallback | null; observed_at: string }>;

const vpnEvidenceAgeMs = 60 * 60_000;
const idPattern = /^[a-z0-9][a-z0-9_-]{0,79}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const roles = ['hub', 'target', 'peer'] as const;
const clients = ['openvpn', 'shadowrocket'] as const;
const clientRoles: Readonly<Record<VpnClient, VpnRole>> = Object.freeze({ openvpn: 'intranet', shadowrocket: 'public' });
const clientBundles: Readonly<Record<string, VpnClient>> = Object.freeze({
  'org.openvpn.client.app': 'openvpn',
  'com.liguangming.Shadowrocket': 'shadowrocket',
});
export function vpnClientRole(client: VpnClient): VpnRole {
  return clientRoles[client];
}
export function vpnClientForBundle(bundleId: string): VpnClient | null {
  return clientBundles[bundleId] ?? null;
}
const fallbacks = ['none', 'device_split', 'controlled_rotation'] as const;
const outcomes = ['passed', 'failed', 'unknown'] as const;
const allowedFailure: Readonly<Record<FixedRepair['kind'], string>> = Object.freeze({
  refresh_dns: 'dns', refresh_proxy: 'proxy', reconnect_vpn: 'route',
});

export function parseNetworkPolicy(raw: unknown): NetworkPolicy {
  const spec = exactObject(raw, ['schema_version', 'device_id', 'revision', 'targets', 'vpn_paths', 'repairs', 'limits', 'fallback']);
  if (spec.schema_version !== '1.0') invalid();
  const targets = collection(spec.targets, 2, 12).map((input): Target => {
    const target = exactObject(input, ['id', 'role']);
    return Object.freeze({ id: id(target.id), role: choice(target.role, roles) });
  });
  unique(targets.map((target) => target.id));
  if (!targets.some(({ role }) => role === 'hub') || !targets.some(({ role }) => role === 'peer')) invalid();
  const vpnPaths = collection(spec.vpn_paths, 0, 2).map((input): VpnPath => {
    const path = exactObject(input, ['id', 'client', 'targets']);
    const namedTargets = collection(path.targets, 1, 12).map(id);
    unique(namedTargets);
    if (namedTargets.some((name) => !targets.some((target) => target.id === name && target.role === 'target'))) invalid();
    const client = choice(path.client, clients);
    return Object.freeze({ id: id(path.id), client, targets: Object.freeze(namedTargets) });
  });
  unique(vpnPaths.map((path) => path.id));
  unique(vpnPaths.map((path) => path.client));
  const repairs = collection(spec.repairs, 0, 24).map((input): FixedRepair => {
    const kind = choice(object(input).kind, ['refresh_dns', 'refresh_proxy', 'reconnect_vpn'] as const);
    const repair = exactObject(input, kind === 'reconnect_vpn' ? ['id', 'kind', 'target', 'path'] : ['id', 'kind', 'target']);
    const name = id(repair.id);
    const target = id(repair.target);
    if (!targets.some((entry) => entry.id === target)) invalid();
    if (kind !== 'reconnect_vpn') return Object.freeze({ id: name, kind, target });
    const path = id(repair.path);
    if (!vpnPaths.some((entry) => entry.id === path && entry.targets.includes(target))) invalid();
    return Object.freeze({ id: name, kind, target, path });
  });
  unique(repairs.map((repair) => repair.id));
  const bounds = exactObject(spec.limits, ['maximum_attempts', 'cooldown_ms', 'deadline_ms']);
  const maximum_attempts = integer(bounds.maximum_attempts, 1, 4);
  const cooldown_ms = integer(bounds.cooldown_ms, 5_000, 600_000);
  const deadline_ms = integer(bounds.deadline_ms, 5_000, 900_000);
  if (cooldown_ms > deadline_ms || (maximum_attempts - 1) * cooldown_ms >= deadline_ms) invalid();
  const fallback = choice(spec.fallback, fallbacks);
  if (fallback !== 'none' && vpnPaths.length !== 2) invalid();
  return Object.freeze({
    schema_version: '1.0', device_id: id(spec.device_id), revision: integer(spec.revision, 1, Number.MAX_SAFE_INTEGER),
    targets: Object.freeze(targets), vpn_paths: Object.freeze(vpnPaths), repairs: Object.freeze(repairs),
    limits: Object.freeze({ maximum_attempts, cooldown_ms, deadline_ms }), fallback,
  });
}

export function selectFixedRepair(policy: NetworkPolicy,
  request: Readonly<{ deviceId: string; targetId: string; repairId: string; problem: string }>): FixedRepair | null {
  if (request.deviceId !== policy.device_id) return null;
  const repair = policy.repairs.find((item) => item.id === request.repairId && item.target === request.targetId);
  return repair && allowedFailure[repair.kind] === request.problem ? repair : null;
}

export function repairVerificationTargets(policy: NetworkPolicy, failedTarget: string, previouslyHealthy: readonly string[]): readonly string[] {
  const registered = new Set(policy.targets.map(({ id }) => id));
  if (![failedTarget, ...previouslyHealthy].every((id) => registered.has(id))) throw new Error('NETWORK_TARGET_NOT_REGISTERED');
  const checks = new Set([...previouslyHealthy, ...policy.targets.filter(({ role }) => role === 'peer').map(({ id }) => id)]);
  checks.delete(failedTarget);
  return [failedTarget, ...[...checks].sort()];
}

export type NetworkOwner = Readonly<{ operationId: string; epoch: number }>;
/** Compare inside the shared host lock; matching this pair does not acquire the lock. */
export function mayRevert(owned: NetworkOwner, current: NetworkOwner): boolean {
  return typeof owned.operationId === 'string' && /^[a-z0-9][a-z0-9_-]{0,159}$/u.test(owned.operationId) &&
    Number.isSafeInteger(owned.epoch) && owned.epoch >= 0 &&
    owned.operationId === current.operationId && owned.epoch === current.epoch;
}

/** Use observations produced by the trusted device supervisor; this result never performs a fallback action. */
export function assessVpnCapability(policy: NetworkPolicy, environmentDigest: string,
  trials: readonly VpnTrial[], now: Date): VpnCapability {
  const unknown = (observed_at: string | null): VpnCapability => ({ dual_path: null, state: 'unknown', fallback: null, observed_at });
  const at = now.getTime();
  if (policy.vpn_paths.length !== 2 || !digestPattern.test(environmentDigest) || !Number.isFinite(at)) return unknown(null);
  const keys = policy.vpn_paths.map(({ id }) => id);
  const latest = new Map<string, { time: number; stamp: string; result: string; mixed: boolean }>();
  for (const trial of trials) {
    if (trial.deviceId !== policy.device_id || trial.policyRevision !== policy.revision || trial.environmentDigest !== environmentDigest) continue;
    if (!Array.isArray(trial.order) || trial.order.length !== 2 || trial.order[0] === trial.order[1] ||
      trial.order.some((key) => !keys.includes(key))) continue;
    const timestamp = instant(trial.observedAt);
    if (timestamp === null || timestamp > at || at - timestamp > vpnEvidenceAgeMs) continue;
    const observations = [trial.concurrentAccess, trial.enterpriseDns, trial.reconnect, trial.peer];
    if (observations.some((value) => !outcomes.includes(value))) continue;
    const key = trial.order[0];
    const prior = latest.get(key);
    const result = observations.join(':');
    if (!prior || prior.time < timestamp) latest.set(key, { time: timestamp, stamp: trial.observedAt, result, mixed: false });
    else if (prior.time === timestamp && prior.result !== result) prior.mixed = true;
  }
  const selected = [...latest.values()];
  const atResult = selected.map(({ stamp }) => stamp).sort()[0] ?? null;
  if (!atResult || selected.some(({ mixed }) => mixed)) return unknown(atResult);
  if (selected.some(({ result }) => result.includes('failed'))) {
    return { dual_path: false, state: 'conflict', fallback: policy.fallback === 'none' ? null : policy.fallback, observed_at: atResult };
  }
  if (selected.length !== 2 || selected.some(({ result }) => result.includes('unknown'))) return unknown(atResult);
  // Preserve the older of the two required observations so the combined proof cannot look newer than either half.
  return { dual_path: true, state: 'supported', fallback: null, observed_at: atResult };
}

function invalid(): never { throw new Error('NETWORK_POLICY_INVALID'); }

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  return value as Record<string, unknown>;
}

function exactObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const record = object(value);
  if (Object.keys(record).length !== fields.length || fields.some((field) => !Object.hasOwn(record, field))) invalid();
  return record;
}

function collection(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid();
  if (Array.from({ length: value.length }).some((_, index) => !Object.hasOwn(value, index))) invalid();
  return value as unknown[];
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !idPattern.test(value)) invalid();
  return value;
}

function unique(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) invalid();
}

function choice<const T extends string>(value: unknown, allowed: readonly T[]): T {
  return allowed.find((item) => item === value) ?? invalid();
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid();
  return value;
}

function instant(stamp: string): number | null {
  if (typeof stamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(stamp)) return null;
  const parsed = Date.parse(stamp);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === stamp ? parsed : null;
}
