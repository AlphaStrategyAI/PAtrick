import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { FixedNetworkActuator } from './supervisor.js';
import { networkPolicyDigest } from './supervisor.js';
import { parseNetworkPolicy, vpnClientForBundle, vpnClientRole, type FixedRepair, type NetworkOwner, type NetworkPolicy, type VpnClient, type VpnRole } from './vpn.js';
import type { ConnectProxy } from './proxy.js';
import type { ProbeReading } from './probes.js';

type Proxy = Readonly<{ enabled: boolean; server: string; port: number }>;
type Proxies = Readonly<{ web: Proxy; secure: Proxy; socks: Proxy }>;
type Binding = (Readonly<{ repairId: string; service: string }> & (
  Readonly<{ servers: readonly string[]; proxies?: never }> | Readonly<{ proxies: Proxies; servers?: never }>))
  | Readonly<{ repairId: string; client: 'openvpn' | 'shadowrocket'; configuration: string }>;
type VpnSnapshot = Readonly<{ vpn_state: 'CONNECTED' | 'EXITING' | 'DISCONNECTED' }>;
type Snapshot = readonly string[] | Proxies | VpnSnapshot;
type Journal = { device: string; policy: string; repairId: string; owner: NetworkOwner;
  priorRule: string; changedRule: string; before: Snapshot };
type Command = (file: string, args: readonly string[], signal: AbortSignal) => Promise<{ stdout: string }>;
const proxyKinds = ['web', 'secure', 'socks'] as const;
const proxyCommands = { web: 'webproxy', secure: 'securewebproxy', socks: 'socksfirewallproxy' } as const;
const canonical = (value: Snapshot): Snapshot => Array.isArray(value) || 'vpn_state' in value ? value
  : Object.fromEntries(proxyKinds.map((kind) => {
    const proxy = (value as Proxies)[kind];
    return [kind, { enabled: proxy.enabled, server: proxy.server, port: proxy.port }];
  })) as Proxies;
const digest = (value: Snapshot) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const safeLabel = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 160 &&
  !value.startsWith('-') && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const vpnActions = { read: 'status', connect: 'start', disconnect: 'stop' } as const;
const vpnState = (stdout: string): VpnSnapshot['vpn_state'] => {
  const line = stdout.trim().split(/\r?\n/u)[0]?.trim();
  if (line === 'Connected') return 'CONNECTED';
  if (line === 'Connecting' || line === 'Disconnecting') return 'EXITING';
  if (line === 'Disconnected') return 'DISCONNECTED';
  throw new Error('NETWORK_NATIVE_UNKNOWN');
};
const restorable = (snapshot: Snapshot) => Array.isArray(snapshot) || ('vpn_state' in snapshot ? snapshot.vpn_state === 'CONNECTED' :
  proxyKinds.every((kind) => (snapshot as Proxies)[kind].server.length > 0 && (snapshot as Proxies)[kind].port > 0));
const permissionError = (error: unknown) => error && typeof error === 'object' &&
  (('code' in error && ['EACCES', 'EPERM'].includes(String(error.code))) ||
    ('message' in error && /not authorized to send Apple events|\(-1743\)/iu.test(String(error.message))));


export type RegisteredVpnService = Readonly<{
  serviceId: string; client: VpnClient; role: VpnRole;
  state: 'connected' | 'connecting' | 'disconnecting' | 'disconnected';
}>;
const vpnListLine = /^\* \((Connected|Connecting|Disconnecting|Disconnected)\)\s+([0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}) VPN \(([^)]+)\) /u;
const listedVpnState = { Connected: 'connected', Connecting: 'connecting', Disconnecting: 'disconnecting', Disconnected: 'disconnected' } as const;
export function parseRegisteredVpnServices(stdout: string): readonly RegisteredVpnService[] {
  if (typeof stdout !== 'string' || stdout.length > 64 * 1024) throw new Error('NETWORK_NATIVE_UNKNOWN');
  const services: RegisteredVpnService[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.length === 0 || line.startsWith('Available network connection services')) continue;
    const match = vpnListLine.exec(line);
    if (!match) {
      if (line.includes(' VPN (')) throw new Error('NETWORK_NATIVE_UNKNOWN');
      continue;
    }
    const serviceId = match[2];
    const key = serviceId.toUpperCase();
    if (seen.has(key)) throw new Error('NETWORK_NATIVE_UNKNOWN');
    seen.add(key);
    const client = vpnClientForBundle(match[3]);
    if (!client) continue;
    const state = listedVpnState[match[1] as keyof typeof listedVpnState];
    services.push(Object.freeze({ serviceId, client, role: vpnClientRole(client), state }));
  }
  return Object.freeze(services);
}

export function createMacNetworkActuator(options: {
  policy: NetworkPolicy; localDeviceId: string; bindings: readonly Binding[]; snapshotDirectory: string;
  platform?: string; runCommand?: Command;
}): FixedNetworkActuator {
  const policy = parseNetworkPolicy(options.policy);
  if (policy.device_id !== options.localDeviceId) throw new Error('NETWORK_DEVICE_NOT_REGISTERED');
  const bindings = new Map<string, Binding>();
  for (const raw of options.bindings) {
    const binding = structuredClone(raw);
    const repair = policy.repairs.find(({ id }) => id === binding.repairId);
    const valid = repair?.kind === 'reconnect_vpn'
      ? 'client' in binding && (binding.client === 'openvpn' || binding.client === 'shadowrocket') && safeLabel(binding.configuration) &&
        policy.vpn_paths.some(({ id, client }) => id === repair.path && client === binding.client)
      : !('client' in binding) && safeLabel(binding.service) &&
        (repair?.kind === 'refresh_dns' ? validDns(binding.servers)
          : validProxies(binding.proxies) && restorable(binding.proxies));
    if (!repair || bindings.has(binding.repairId) || !valid) {
      throw new Error('NETWORK_NATIVE_BINDING_INVALID');
    }
    bindings.set(binding.repairId, binding);
  }
  const policyDigest = createHash('sha256').update(JSON.stringify([networkPolicyDigest(policy),
    [...bindings.values()].sort((left, right) => left.repairId.localeCompare(right.repairId)).map((binding) => [
      binding.repairId, ...('client' in binding ? [binding.client, binding.configuration]
        : [binding.service, canonical(binding.servers ?? binding.proxies!)]),
    ])])).digest('hex');
  const run = options.runCommand ?? runCommand;
  const compatible = (options.platform ?? process.platform) === 'darwin';
  const registered = (repair: FixedRepair) => {
    const exact = policy.repairs.find(({ id }) => id === repair.id);
    return exact && JSON.stringify(exact) === JSON.stringify(repair) ? bindings.get(repair.id) : undefined;
  };
  const command = (args: readonly string[], signal: AbortSignal) => run('/usr/sbin/networksetup', args, signal);
  const vpnCommand = (binding: Extract<Binding, { client: string }>, action: 'read' | 'connect' | 'disconnect', signal: AbortSignal) =>
    run('/usr/sbin/scutil', ['--nc', vpnActions[action], binding.configuration], signal);
  async function read(binding: Binding, signal: AbortSignal): Promise<Snapshot> {
    if ('client' in binding) {
      const { stdout } = await vpnCommand(binding, 'read', signal);
      return { vpn_state: vpnState(stdout) };
    }
    if (binding.servers) {
      const { stdout } = await command(['-getdnsservers', binding.service], signal);
      if (/^There aren't any DNS Servers set on /u.test(stdout.trim())) return [];
      const servers = stdout.trim().split(/\r?\n/u);
      if (!validDns(servers)) throw new Error('NETWORK_NATIVE_UNKNOWN');
      return servers;
    }
    const entries = await Promise.all(proxyKinds.map(async (kind) => {
      const { stdout } = await command([`-get${proxyCommands[kind]}`, binding.service], signal);
      const enabled = /^Enabled: (Yes|No)$/mu.exec(stdout);
      const server = /^Server: (.*)$/mu.exec(stdout);
      const port = /^Port: (\d+)$/mu.exec(stdout);
      const authenticated = /^Authenticated Proxy Enabled: (\d+)$/mu.exec(stdout);
      if (!enabled || !server || !port || authenticated?.[1] !== '0') throw new Error('NETWORK_NATIVE_UNKNOWN');
      return [kind, { enabled: enabled[1] === 'Yes', server: server[1], port: Number(port[1]) }] as const;
    }));
    const proxies = Object.fromEntries(entries) as Proxies;
    if (!validProxies(proxies)) throw new Error('NETWORK_NATIVE_UNKNOWN');
    return proxies;
  }
  async function set(binding: Binding, snapshot: Snapshot, signal: AbortSignal, assertEffect: () => void) {
    if ('client' in binding && 'vpn_state' in snapshot) {
      const desired = snapshot.vpn_state;
      if (digest(await read(binding, signal)) === digest(snapshot)) return;
      assertEffect();
      await vpnCommand(binding, desired === 'CONNECTED' ? 'connect' : 'disconnect', signal);
      if (desired === 'EXITING') throw new Error('NETWORK_VPN_DISCONNECT_UNSETTLED');
      for (let count = 0; count < 150; count += 1) {
        try { if (digest(await read(binding, signal)) === digest(snapshot)) return; } catch {
          if (signal.aborted) throw new Error('NETWORK_NATIVE_ABORTED');
        }
        await delay(100, undefined, { signal });
      }
      throw new Error('NETWORK_VPN_STATE_UNRESOLVED');
    }
    if ('client' in binding) throw new Error('NETWORK_NATIVE_UNKNOWN');
    if (Array.isArray(snapshot)) {
      assertEffect();
      await command(['-setdnsservers', binding.service, ...(snapshot.length ? snapshot : ['Empty'])], signal);
      return;
    }
    for (const kind of proxyKinds) {
      const value = (snapshot as Proxies)[kind];
      if (value.server) {
        assertEffect();
        await command([`-set${proxyCommands[kind]}`, binding.service, value.server, String(value.port)], signal);
      }
      assertEffect();
      await command([`-set${proxyCommands[kind]}state`, binding.service, value.enabled ? 'on' : 'off'], signal);
    }
  }
  const journalPath = (repair: FixedRepair, owner: NetworkOwner) => join(options.snapshotDirectory, createHash('sha256')
    .update(JSON.stringify([policy.device_id, policyDigest, repair.id, owner.operationId, owner.epoch])).digest('hex') + '.json');
  return {
    registrationDigest: policyDigest,
    async readRule(repair, signal) {
      const binding = registered(repair);
      if (!compatible || !binding) return { state: 'incompatible' };
      if (signal.aborted) return null;
      try {
        const snapshot = await read(binding, signal);
        return restorable(snapshot) ? digest(snapshot) : { state: 'incompatible' };
      } catch (error) {
        return permissionError(error) ? { state: 'permission' } : null;
      }
    },
    async apply(repair, context) {
      const binding = registered(repair);
      if (!compatible || !binding || context.signal.aborted) return { state: 'unknown' };
      let changed = false;
      try {
        const before = await read(binding, context.signal);
        if (!restorable(before)) return { state: 'conflict' };
        if (digest(before) !== context.expectedRule) return { state: 'conflict' };
        const desired = 'client' in binding ? { vpn_state: 'CONNECTED' as const } : binding.servers ?? binding.proxies!;
        const revision = digest(desired);
        if (revision === context.expectedRule && !('client' in binding)) return { state: 'unchanged' };
        const journal: Journal = { device: policy.device_id, policy: policyDigest, repairId: repair.id,
          owner: context.owner, priorRule: context.expectedRule, changedRule: revision, before };
        await mkdir(options.snapshotDirectory, { recursive: true, mode: 0o700 });
        await writeFile(journalPath(repair, context.owner), JSON.stringify(journal), { flag: 'wx', mode: 0o600, flush: true });
        if (digest(await read(binding, context.signal)) !== context.expectedRule) return { state: 'conflict' };
        changed = true;
        if ('client' in binding && 'vpn_state' in before && before.vpn_state === 'CONNECTED') {
          await set(binding, { vpn_state: 'EXITING' }, context.signal, context.assertEffect);
        }
        await set(binding, desired, context.signal, context.assertEffect);
        return digest(await read(binding, context.signal)) === revision
          ? { state: 'changed', revision, ...('client' in binding ? { reconnected: true } : {}) } : { state: 'unknown' };
      } catch (error) {
        return { state: !changed && permissionError(error) ? 'permission' : 'unknown' };
      }
    },
    async restore(repair, context) {
      const binding = registered(repair);
      if (!compatible || !binding || context.signal.aborted) return 'unknown';
      try {
        const applyOwner = { operationId: context.owner.operationId, epoch: context.owner.epoch - 1 };
        const journal = JSON.parse(await readFile(journalPath(repair, applyOwner), 'utf8')) as Journal;
        if (journal.device !== policy.device_id || journal.policy !== policyDigest || journal.repairId !== repair.id ||
            journal.owner.operationId !== applyOwner.operationId || journal.owner.epoch !== applyOwner.epoch ||
            journal.priorRule !== context.priorRule || journal.changedRule !== context.expectedRule ||
            !('client' in binding ? validVpn(journal.before) : binding.servers ? validDns(journal.before) : validProxies(journal.before)) ||
            !restorable(journal.before) ||
            digest(journal.before) !== context.priorRule || digest(await read(binding, context.signal)) !== context.expectedRule) return 'conflict';
        await set(binding, journal.before, context.signal, context.assertEffect);
        return digest(await read(binding, context.signal)) === context.priorRule ? 'restored' : 'unknown';
      } catch (error) {
        return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' ? 'conflict' : 'unknown';
      }
    },
  };
}

function validVpn(value: unknown): value is VpnSnapshot {
  return Boolean(value && typeof value === 'object' && Object.keys(value).length === 1 && 'vpn_state' in value &&
    (value.vpn_state === 'CONNECTED' || value.vpn_state === 'EXITING' || value.vpn_state === 'DISCONNECTED'));
}

function validDns(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 8 && value.every((server) => typeof server === 'string' && isIP(server) !== 0) &&
    new Set(value).size === value.length;
}

function validProxies(value: unknown): value is Proxies {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 3) return false;
  return proxyKinds.every((kind) => {
    const proxy = (value as Proxies)[kind];
    return proxy && typeof proxy.enabled === 'boolean' && typeof proxy.server === 'string' &&
      (!proxy.server || (safeLabel(proxy.server) && !/[\s/:@]/u.test(proxy.server))) &&
      Number.isSafeInteger(proxy.port) && proxy.port >= 0 && proxy.port <= 65535 &&
      (!proxy.enabled || (proxy.server.length > 0 && proxy.port > 0));
  });
}

/** Read only the explicitly registered HTTPS service; unsupported PAC/auth/SOCKS paths stay unknown. */
export async function readMacSecureProxy(options: {
  service: string; platform?: string; runCommand?: Command;
}, signal: AbortSignal): Promise<ConnectProxy | null | undefined> {
  if (!safeLabel(options.service) || (options.platform ?? process.platform) !== 'darwin') return undefined;
  const read = async (action: string) => (await (options.runCommand ?? runCommand)(
    '/usr/sbin/networksetup', [action, options.service], signal)).stdout;
  const [automatic, discovery, output] = await Promise.all([
    read('-getautoproxyurl'), read('-getproxyautodiscovery'), read('-getsecurewebproxy'),
  ]);
  if (!/^Enabled: No$/mu.test(automatic) || !/^Auto Proxy Discovery: Off$/mu.test(discovery) ||
      !/^Authenticated Proxy Enabled: 0$/mu.test(output)) return undefined;
  const enabled = /^Enabled: (Yes|No)$/mu.exec(output)?.[1];
  if (enabled === 'No') {
    const socks = await read('-getsocksfirewallproxy');
    return /^Enabled: No$/mu.test(socks) ? null : undefined;
  }
  const server = /^Server: (.+)$/mu.exec(output)?.[1];
  const port = Number(/^Port: (\d+)$/mu.exec(output)?.[1]);
  if (enabled !== 'Yes' || !server || !safeLabel(server) || /[\s/:@]/u.test(server) ||
      !Number.isSafeInteger(port) || port < 1 || port > 65535) return undefined;
  return { server, port };
}

export async function readMacRoute(options: {
  host: string; platform?: string; runCommand?: Command;
}, signal: AbortSignal): Promise<ProbeReading> {
  if ((options.platform ?? process.platform) !== 'darwin' || !safeLabel(options.host) || signal.aborted) return 'unknown';
  try {
    const { stdout } = await (options.runCommand ?? runCommand)('/sbin/route', ['-n', 'get', options.host], signal);
    return /^\s*interface: \S+/mu.test(stdout) ? 'passed' : 'unknown';
  } catch (error) {
    if (signal.aborted || !error || typeof error !== 'object' || !('code' in error) || error.code !== 1 ||
        !('stderr' in error)) return 'unknown';
    return /^route: writing to routing socket: not in table\s*$/u.test(String(error.stderr)) ? 'failed' : 'unknown';
  }
}

function runCommand(file: string, args: readonly string[], signal: AbortSignal): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => execFile(file, [...args], {
    signal, timeout: 15_000, maxBuffer: 64 * 1024, encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' },
  }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve({ stdout })));
}
