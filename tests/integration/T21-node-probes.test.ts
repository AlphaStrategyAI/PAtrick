import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { createServer as createProxyServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createNodeNetworkProbePorts } from '../../packages/host/src/network/node-probes.js';
import { createNetworkInspector } from '../../packages/host/src/network/probes.js';
import { parseNetworkPolicy } from '../../packages/host/src/network/vpn.js';

test('native read-only probes use real DNS, TCP, verified TLS and target identity on registered loopback endpoints', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'patrick-t21-tls-'));
  const keyPath = join(directory, 'key.pem');
  const certificatePath = join(directory, 'cert.pem');
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', keyPath, '-out', certificatePath, '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
  { stdio: 'ignore' });
  const requests: string[] = [];
  const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certificatePath) }, (request, response) => {
    requests.push(request.url!);
    if (request.url === '/redirect') { response.writeHead(302, { location: '/healthy' }); response.end(); return; }
    if (request.url === '/limited') { response.writeHead(429, { 'Retry-After': '15' }); response.end(); return; }
    if (request.url === '/login') { response.writeHead(401); response.end(); return; }
    response.end('verified-local-principal');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const sockets = new Set<Socket>();
  let tunnels = 0;
  const proxy = createProxyServer();
  proxy.on('connect', (incoming, client, head) => {
    if (incoming.url === '127.0.0.1:1') { client.destroy(); return; }
    const address = server.address();
    if (!address || typeof address === 'string' || incoming.url !== `127.0.0.1:${address.port}`) {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return;
    }
    tunnels += 1;
    const upstream = connect({ host: '127.0.0.1', port: address.port }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    sockets.add(upstream);
    sockets.add(client as Socket);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => { upstream.destroy(); sockets.delete(client as Socket); });
    upstream.on('close', () => sockets.delete(upstream));
  });
  await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no loopback address');
    const policy = parseNetworkPolicy({
      schema_version: '1.0', device_id: 'local-harness', revision: 1,
      targets: [{ id: 'hub', role: 'hub' }, { id: 'peer', role: 'peer' }, { id: 'bad-tls', role: 'target' },
        { id: 'login', role: 'target' }, { id: 'limited', role: 'target' }, { id: 'redirect', role: 'target' },
        { id: 'proxied', role: 'target' }, { id: 'closed-proxy', role: 'target' }],
      vpn_paths: [], repairs: [], limits: { maximum_attempts: 1, cooldown_ms: 5_000, deadline_ms: 5_000 }, fallback: 'none',
    });
    const ports = createNodeNetworkProbePorts({
      policy, localDeviceId: 'local-harness',
      proxy: async (targetId) => {
        const proxyAddress = proxy.address();
        if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('no proxy address');
        return ['proxied', 'closed-proxy'].includes(targetId) ? { server: '127.0.0.1', port: proxyAddress.port } : null;
      },
      endpoints: policy.targets.map(({ id }) => ({ targetId: id,
        url: `https://127.0.0.1:${id === 'closed-proxy' ? 1 : address.port}/${['hub', 'peer', 'bad-tls', 'proxied'].includes(id) ? 'healthy' : id}`,
        ...(id === 'bad-tls' ? {} : { ca: readFileSync(certificatePath) }),
        identity: ({ body }) => body.toString() === 'verified-local-principal' ? 'verified' as const : 'unconfirmed' as const,
        peer: async () => 'passed' as const,
      })),
    });
    const report = await createNetworkInspector(policy, ports)(policy.targets.map(({ id }) => id));
    expect.soft(report.targets).toMatchObject([
      { targetId: 'hub', outcome: 'healthy', layers: { dns: 'not_applicable', tcp: 'passed', tls: 'passed', identity: 'passed' } },
      { targetId: 'peer', outcome: 'healthy', layers: { peer: 'passed' } },
      { targetId: 'bad-tls', outcome: 'tls', layers: { http: 'skipped' } },
      { targetId: 'login', outcome: 'identity' },
      { targetId: 'limited', outcome: 'rate_limit', retryAfterMs: 15_000 },
      { targetId: 'redirect', outcome: 'target', httpStatus: 302 },
      { targetId: 'proxied', outcome: 'healthy', layers: { proxy: 'passed', tcp: 'passed', tls: 'passed', identity: 'passed' } },
      { targetId: 'closed-proxy', outcome: 'proxy', layers: { proxy: 'failed', http: 'skipped' } },
    ]);
    expect.soft(requests.filter((url) => url === '/healthy')).toHaveLength(3);
    expect.soft(tunnels).toBe(4);
    server.setSecureContext({
      key: readFileSync(keyPath),
      cert: (() => {
        execFileSync('/usr/bin/openssl', ['req', '-new', '-x509', '-key', keyPath, '-days', '1',
          '-out', certificatePath, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
        return readFileSync(certificatePath);
      })(),
    });
    const wrongIdentityPorts = createNodeNetworkProbePorts({ policy, localDeviceId: 'local-harness',
      endpoints: policy.targets.map(({ id }) => ({ targetId: id, url: `https://127.0.0.1:${address.port}/healthy`,
        ca: readFileSync(certificatePath), identity: () => 'verified' as const })),
      proxy: async () => ({ server: '127.0.0.1', port: (proxy.address() as { port: number }).port }),
    });
    const signal = new AbortController().signal;
    await wrongIdentityPorts.dns(policy.targets[0], signal);
    await wrongIdentityPorts.proxy!(policy.targets[0], signal);
    await expect(wrongIdentityPorts.http(policy.targets[0], signal)).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    expect(JSON.stringify(report)).not.toContain('127.0.0.1');
    expect(() => createNodeNetworkProbePorts({ policy, localDeviceId: 'other', endpoints: [] })).toThrow('NETWORK_DEVICE_NOT_REGISTERED');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);
