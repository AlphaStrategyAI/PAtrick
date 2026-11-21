import { isIP } from 'node:net';
import { parseNetworkPolicy } from './vpn.js';
import type { NetworkPolicy } from './vpn.js';

const connectivityLabel = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/u;
export const defaultConnectivityTargets = Object.freeze({
  intranet: 'git.lifepilot.xyz',
  public: 'www.google.com',
});

/** A connectivity target is a DNS hostname. It is not a URL, port, path, or address. */
export function parseConnectivityHostname(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253 || value !== value.trim()) {
    throw new Error('CONNECTIVITY_HOST_INVALID');
  }
  if (/[:/?#@\s\\]/u.test(value) || value.includes('..') || value.startsWith('.') || value.endsWith('.')) {
    throw new Error('CONNECTIVITY_HOST_INVALID');
  }
  const host = value.toLowerCase();
  if (isIP(host)) throw new Error('CONNECTIVITY_HOST_INVALID');
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((label) => !connectivityLabel.test(label))) throw new Error('CONNECTIVITY_HOST_INVALID');
  return host;
}

/** Probe hosts come from the last rechecked record. A missing record keeps the current defaults. */
export function connectivityProbeHosts(verified: { intranet: string; public: string } | null): { intranet: string; public: string } {
  if (!verified) return { intranet: defaultConnectivityTargets.intranet, public: defaultConnectivityTargets.public };
  return { intranet: parseConnectivityHostname(verified.intranet), public: parseConnectivityHostname(verified.public) };
}

type RegisteredTarget = NetworkPolicy['targets'][number];
export type ProbeReading = 'passed' | 'failed' | 'unknown';
export type ProbeEvidence = ProbeReading | 'skipped' | 'not_applicable';
type TargetProbe<Result = ProbeReading> = (target: RegisteredTarget, signal: AbortSignal) => Promise<Result>;
type HttpOutcome = 'identity' | 'rate_limit' | 'target' | 'healthy';
export type NetworkOutcome = HttpOutcome | 'interface' | 'route' | 'dns' | 'proxy' | 'tcp' | 'tls' | 'peer' | 'mfa' | 'unknown';

export type NetworkHttpReading = Readonly<{
  status: number;
  /** A 2xx response alone does not prove the configured principal can use this target. */
  identity?: 'verified' | 'rejected' | 'unconfirmed' | 'mfa';
  retryAfterMs?: number;
}>;

/** Trusted host adapters bind each ID to its fixed, read-only check. They honor cancellation,
 * keep TLS verification enabled, and return HTTP redirects as observed rather than following them. */
export type NetworkProbePorts = Readonly<{
  /** A failure means the host has no usable interface; partial visibility is unknown. */
  interfaces?: (signal: AbortSignal) => Promise<ProbeReading>;
  route?: TargetProbe;
  dns: TargetProbe<ProbeReading | 'not_applicable'>;
  proxy?: TargetProbe<ProbeReading | 'not_applicable'>;
  tcp: TargetProbe;
  tls: TargetProbe;
  http: TargetProbe<NetworkHttpReading>;
  peer?: TargetProbe;
}>;

export type TargetNetworkReport = Readonly<{
  targetId: string;
  role: RegisteredTarget['role'];
  outcome: NetworkOutcome;
  layers: Readonly<Record<'route' | 'dns' | 'proxy' | 'tcp' | 'tls' | 'http' | 'identity' | 'peer', ProbeEvidence>>;
  httpStatus: number | null;
  /** A reported backoff hint, not a scheduled retry. */
  retryAfterMs: number | null;
}>;

export type NetworkReport = Readonly<{
  deviceId: string;
  policyRevision: number;
  startedAt: string;
  observedAt: string;
  interfaces: ProbeEvidence;
  targets: readonly TargetNetworkReport[];
}>;

export type NetworkInspector = (targets: readonly string[], signal?: AbortSignal) => Promise<NetworkReport>;

export function classifyHttp(status: number): HttpOutcome {
  if (status === 401 || status === 403) return 'identity';
  if (status === 429) return 'rate_limit';
  return Number.isInteger(status) && status >= 200 && status < 300 ? 'healthy' : 'target';
}

/** Bind once to the device's trusted policy; callers only supply registered IDs. */
export function createNetworkInspector(policy: NetworkPolicy, ports: NetworkProbePorts): NetworkInspector {
  const registered = parseNetworkPolicy(policy);
  const registry = new Map(registered.targets.map((target) => [target.id, target]));
  return async (targets, callerSignal) => {
    const unique = new Set(targets);
    const selected = Array.from(unique, (id) => {
      const target = registry.get(id);
      if (!target) throw new Error('NETWORK_TARGET_NOT_REGISTERED');
      return target;
    });
    const startedAt = new Date().toISOString();
    const deadline = new AbortController();
    const watchdog = setTimeout(() => deadline.abort(), registered.limits.deadline_ms);
    const signal = callerSignal ? AbortSignal.any([deadline.signal, callerSignal]) : deadline.signal;
    try {
      const interfaces = selected.length === 0 ? 'skipped' : await readStage(signal, () => ports.interfaces?.(signal));
      const reports = await Promise.all(selected.map((target) => inspectTarget(target, interfaces, ports, signal)));
      return {
        deviceId: registered.device_id, policyRevision: registered.revision,
        startedAt, observedAt: new Date().toISOString(), interfaces, targets: reports,
      };
    } finally {
      clearTimeout(watchdog);
    }
  };
}

async function inspectTarget(target: RegisteredTarget, interfaces: ProbeEvidence, ports: NetworkProbePorts,
  signal: AbortSignal): Promise<TargetNetworkReport> {
  const layers: Record<keyof TargetNetworkReport['layers'], ProbeEvidence> = {
    route: 'skipped', dns: 'skipped', proxy: 'skipped', tcp: 'skipped', tls: 'skipped', http: 'skipped',
    identity: 'skipped', peer: target.role === 'peer' ? 'skipped' : 'not_applicable',
  };
  let httpStatus: number | null = null;
  let retryAfterMs: number | null = null;
  const report = (outcome: NetworkOutcome): TargetNetworkReport => ({
    targetId: target.id, role: target.role, outcome, layers, httpStatus, retryAfterMs,
  });
  if (interfaces === 'failed') return report('interface');
  if (signal.aborted) return report('unknown');

  layers.route = await readStage(signal, () => ports.route?.(target, signal));
  layers.dns = await readStage(signal, () => ports.dns(target, signal), true);
  layers.proxy = await readStage(signal, () => ports.proxy?.(target, signal), true);
  for (const local of ['route', 'dns', 'proxy'] as const) {
    if (layers[local] === 'failed') return report(local);
  }
  if (signal.aborted || layers.dns === 'unknown' || layers.dns === 'skipped' || layers.proxy === 'unknown') return report('unknown');

  for (const transport of ['tcp', 'tls'] as const) {
    const evidence = layers[transport] = await readStage(signal, () => ports[transport](target, signal));
    if (evidence !== 'passed') return report(evidence === 'failed' ? transport : 'unknown');
  }

  const http = await observe(signal, () => ports.http(target, signal));
  if (!http || !Number.isInteger(http.status) || http.status < 100 || http.status > 599) {
    layers.http = 'unknown';
    return report('unknown');
  }
  httpStatus = http.status;
  layers.http = 'passed';
  const httpOutcome = classifyHttp(httpStatus);
  if (httpOutcome === 'rate_limit') {
    if (typeof http.retryAfterMs === 'number' && Number.isSafeInteger(http.retryAfterMs) && http.retryAfterMs >= 0) {
      retryAfterMs = http.retryAfterMs;
    }
    return report(httpOutcome);
  }
  if (http.identity === 'mfa') {
    layers.identity = 'failed';
    return report('mfa');
  }
  if (httpOutcome === 'identity') layers.identity = 'failed';
  if (httpOutcome !== 'healthy') return report(httpOutcome);
  if (http.identity === 'rejected') {
    layers.identity = 'failed';
    return report('identity');
  }
  if (http.identity !== 'verified') {
    layers.identity = 'unknown';
    return report('unknown');
  }
  layers.identity = 'passed';
  if (target.role === 'peer') {
    const peer = layers.peer = await readStage(signal, () => ports.peer?.(target, signal));
    if (peer !== 'passed') return report(peer === 'failed' ? 'peer' : 'unknown');
  }
  return report('healthy');
}

async function readStage(signal: AbortSignal, read: () => Promise<ProbeEvidence> | undefined,
  allowNotApplicable = false): Promise<ProbeEvidence> {
  if (signal.aborted) return 'skipped';
  const result = await observe(signal, read);
  if (result === 'passed' || result === 'failed' || (allowNotApplicable && result === 'not_applicable')) return result;
  return 'unknown';
}

function observe<T>(signal: AbortSignal, read: () => Promise<T> | undefined): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const finish = (result: T | undefined) => {
      signal.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = () => finish(undefined);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => signal.aborted ? undefined : read()).then(finish, () => finish(undefined));
  });
}
