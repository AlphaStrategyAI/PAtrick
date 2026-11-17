import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { Agent, request } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { connect, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { connect as tlsConnect } from 'node:tls';
import { parseNetworkPolicy, type NetworkPolicy } from './vpn.js';
import type { NetworkHttpReading, NetworkProbePorts, ProbeReading } from './probes.js';
import { connectHttpProxy, type ConnectProxy, type ProxyConnector } from './proxy.js';

type Endpoint = Readonly<{
  targetId: string; url: string; ca?: string | Buffer;
  headers?: () => Promise<Readonly<Record<string, string>>>;
  identity: (response: Readonly<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>) => NetworkHttpReading['identity'];
  peer?: (signal: AbortSignal) => Promise<ProbeReading>;
}>;

export function createNodeNetworkProbePorts(options: {
  policy: NetworkPolicy; localDeviceId: string; endpoints: readonly Endpoint[];
  local?: Pick<NetworkProbePorts, 'interfaces' | 'route' | 'proxy'>;
  proxy?: (targetId: string, signal: AbortSignal) => Promise<ConnectProxy | null | undefined>;
  connectProxy?: ProxyConnector;
}): NetworkProbePorts {
  const policy = parseNetworkPolicy(options.policy);
  if (options.localDeviceId !== policy.device_id) throw new Error('NETWORK_DEVICE_NOT_REGISTERED');
  const endpoints = new Map<string, Endpoint & { location: URL }>();
  for (const endpoint of options.endpoints) {
    const location = new URL(endpoint.url);
    if (location.protocol !== 'https:' || location.username || location.password || location.hash ||
        !policy.targets.some(({ id }) => id === endpoint.targetId) || endpoints.has(endpoint.targetId) ||
        typeof endpoint.identity !== 'function') throw new Error('NETWORK_ENDPOINT_INVALID');
    endpoints.set(endpoint.targetId, { ...endpoint, location });
  }
  if (endpoints.size !== policy.targets.length) throw new Error('NETWORK_ENDPOINT_UNREGISTERED');
  const observations = new WeakMap<AbortSignal, Map<string, string[]>>();
  const proxyPaths = new WeakMap<AbortSignal, Map<string, ConnectProxy | null>>();
  const openProxy = options.connectProxy ?? connectHttpProxy;
  const endpointFor = (targetId: string) => {
    const endpoint = endpoints.get(targetId);
    if (!endpoint) throw new Error('NETWORK_TARGET_NOT_REGISTERED');
    return endpoint;
  };
  const host = (endpoint: { location: URL }) => endpoint.location.hostname.replace(/^\[|\]$/gu, '');
  const state = (signal: AbortSignal) => {
    let entry = observations.get(signal);
    if (!entry) { entry = new Map(); observations.set(signal, entry); }
    return entry;
  };
  function addressFor(id: string, signal: AbortSignal): string {
    const address = state(signal).get(id)?.[0];
    if (!address) throw new Error('NETWORK_DNS_UNVERIFIED');
    return address;
  }
  const proxyFor = (id: string, signal: AbortSignal) => {
    if (!options.proxy) return null;
    const paths = proxyPaths.get(signal);
    if (!paths?.has(id)) throw new Error('NETWORK_PROXY_UNVERIFIED');
    return paths.get(id)!;
  };
  const tunnel = (proxy: ConnectProxy, targetId: string, signal: AbortSignal, address = addressFor(targetId, signal)) => openProxy(proxy,
    { host: address, port: Number(endpointFor(targetId).location.port || 443) },
    signal, Math.min(1_500, policy.limits.deadline_ms));
  async function transport(targetId: string, signal: AbortSignal, secure: boolean): Promise<ProbeReading> {
    const endpoint = endpointFor(targetId);
    addressFor(targetId, signal);
    const addresses = state(signal).get(targetId)!;
    const proxy = proxyFor(targetId, signal);
    for (const address of addresses) {
      if (signal.aborted) return 'unknown';
      let proxySocket;
      try { proxySocket = proxy ? await tunnel(proxy, targetId, signal, address) : undefined; } catch (error) {
        if (signal.aborted || (error instanceof Error && error.message === 'NETWORK_PROXY_AUTH_REQUIRED')) return 'unknown';
        continue;
      }
      if (proxySocket && !secure) {
        proxySocket.destroy();
        state(signal).set(targetId, [address, ...addresses.filter((candidate) => candidate !== address)]);
        return 'passed';
      }
      const result = await new Promise<ProbeReading>((resolve) => {
        const connection = { host: address, port: Number(endpoint.location.port || 443), signal };
        const socket = secure ? tlsConnect({ ...connection, ...(proxySocket ? { socket: proxySocket } : {}),
          servername: isIP(host(endpoint)) ? undefined : host(endpoint), rejectUnauthorized: true,
          minVersion: 'TLSv1.2', ca: endpoint.ca,
        }) : connect(connection);
        socket.setTimeout(Math.max(1, Math.min(1_500, Math.floor(policy.limits.deadline_ms / addresses.length))));
        socket.once('timeout', () => { resolve('failed'); socket.destroy(); });
        socket.once(secure ? 'secureConnect' : 'connect', () => { resolve('passed'); socket.destroy(); });
        socket.once('error', () => { resolve(signal.aborted ? 'unknown' : 'failed'); socket.destroy(); });
      });
      if (result === 'passed') {
        state(signal).set(targetId, [address, ...addresses.filter((candidate) => candidate !== address)]);
        return result;
      }
    }
    return signal.aborted ? 'unknown' : 'failed';
  }
  return {
    interfaces: options.local?.interfaces ?? (async () => {
      const interfaces = Object.values(networkInterfaces()).flatMap((entries) => entries ?? []);
      return interfaces.some(({ internal }) => !internal) ? 'passed' : 'unknown';
    }),
    route: options.local?.route ?? (async (target, signal) => {
      if (process.platform !== 'darwin') return 'unknown';
      const endpoint = endpointFor(target.id);
      const output = await command('/sbin/route', ['-n', 'get', host(endpoint)], signal);
      return /^\s*interface: \S+/mu.test(output) ? 'passed' : 'unknown';
    }),
    proxy: options.proxy ? async (target, signal) => {
      try {
        const proxy = await options.proxy!(target.id, signal);
        if (proxy === undefined) return 'unknown';
        let paths = proxyPaths.get(signal);
        if (!paths) { paths = new Map(); proxyPaths.set(signal, paths); }
        paths.set(target.id, proxy);
        if (!proxy) return 'not_applicable';
        addressFor(target.id, signal);
        const addresses = state(signal).get(target.id)!;
        for (const address of addresses) {
          if (signal.aborted) return 'unknown';
          try {
            const socket = await tunnel(proxy, target.id, signal, address);
            socket.destroy();
            state(signal).set(target.id, [address, ...addresses.filter((candidate) => candidate !== address)]);
            return 'passed';
          } catch (error) {
            if (signal.aborted || (error instanceof Error && error.message === 'NETWORK_PROXY_AUTH_REQUIRED')) return 'unknown';
          }
        }
        return 'failed';
      } catch (error) {
        return signal.aborted || (error instanceof Error && error.message === 'NETWORK_PROXY_AUTH_REQUIRED') ? 'unknown' : 'failed';
      }
    } : options.local?.proxy ?? (async (_target, signal) => {
      if (process.platform !== 'darwin') return 'unknown';
      const output = await command('/usr/sbin/scutil', ['--proxy'], signal);
      return /(?:HTTP|HTTPS|SOCKS|ProxyAutoConfig)Enable\s*:\s*1/u.test(output) ? 'unknown' : 'not_applicable';
    }),
    async dns(target, signal) {
      const endpoint = endpointFor(target.id);
      const hostname = host(endpoint);
      if (signal.aborted) return 'unknown';
      if (isIP(hostname)) {
        state(signal).set(target.id, [hostname]);
        return 'not_applicable';
      }
      try {
        const answers = await lookup(hostname, { all: true });
        if (signal.aborted) return 'unknown';
        const addresses = [...new Set(answers.map(({ address }) => address))];
        if (addresses.length === 0) return 'failed';
        state(signal).set(target.id, addresses);
        return 'passed';
      } catch { return signal.aborted ? 'unknown' : 'failed'; }
    },
    tcp: (target, signal) => transport(target.id, signal, false),
    tls: (target, signal) => transport(target.id, signal, true),
    async http(target, signal) {
      const endpoint = endpointFor(target.id);
      const headers = await endpoint.headers?.() ?? {};
      const proxy = proxyFor(target.id, signal);
      const socket = proxy ? await tunnel(proxy, target.id, signal) : undefined;
      const agent = socket ? new Agent({ keepAlive: false }) : undefined;
      if (agent) agent.createConnection = () => tlsConnect({ socket,
        host: host(endpoint),
        servername: isIP(host(endpoint)) ? undefined : host(endpoint),
        ca: endpoint.ca, rejectUnauthorized: true, minVersion: 'TLSv1.2',
      });
      return new Promise<NetworkHttpReading>((resolve, reject) => {
        const outbound = request({
          hostname: addressFor(target.id, signal), port: Number(endpoint.location.port || 443),
          servername: isIP(host(endpoint)) ? undefined : host(endpoint),
          path: endpoint.location.pathname + endpoint.location.search, method: 'GET',
          headers: { ...headers, host: endpoint.location.host }, ca: endpoint.ca,
          rejectUnauthorized: true, minVersion: 'TLSv1.2', signal, agent: agent ?? false,
        }, (response) => {
          let bytes = 0;
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 64 * 1024) { outbound.destroy(new Error('NETWORK_RESPONSE_LIMIT')); return; }
            chunks.push(chunk);
          });
          response.once('error', reject);
          response.once('aborted', () => reject(new Error('NETWORK_RESPONSE_ABORTED')));
          response.once('end', () => {
            try {
              const status = response.statusCode ?? 0;
              const retryAfter = response.headers['retry-after'];
              const retryAfterMs = retryAfter && /^\d+$/u.test(retryAfter) ? Number(retryAfter) * 1000
                : retryAfter ? Math.max(0, Date.parse(retryAfter) - Date.now()) : undefined;
              resolve({ status, identity: endpoint.identity({ status, headers: response.headers, body: Buffer.concat(chunks) }),
                ...(Number.isSafeInteger(retryAfterMs) ? { retryAfterMs } : {}) });
            } catch (error) { reject(error); }
          });
        });
        outbound.once('error', (error) => { agent?.destroy(); reject(error); });
        outbound.setTimeout(Math.min(5_000, policy.limits.deadline_ms), () => outbound.destroy(new Error('NETWORK_HTTP_TIMEOUT')));
        outbound.end();
      });
    },
    peer: (target, signal) => endpointFor(target.id).peer?.(signal) ?? Promise.resolve('unknown'),
  };
}

function command(file: string, args: readonly string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, [...args], {
    signal, timeout: 5_000, maxBuffer: 64 * 1024, encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' },
  }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
