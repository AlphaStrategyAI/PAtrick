import { lookup } from 'node:dns/promises';
import { request, type ClientRequest, type IncomingMessage } from 'node:http';
import { isIPv4 } from 'node:net';
import { connect, checkServerIdentity, rootCertificates, type ConnectionOptions, type TLSSocket } from 'node:tls';
import type { attemptFeishuConnectionTest } from './provider-protocol.js';

type Transport = Parameters<typeof attemptFeishuConnectionTest>[1];
type Reply = Awaited<ReturnType<Transport>>;
type IO = {
  resolve(host: string): Promise<string[]>;
  select(answers: string[]): string;
  port: number;
  roots: readonly string[];
  dial(options: ConnectionOptions & { family: 4 }): TLSSocket;
};
function failure() { return new Error('FEISHU_TRANSPORT'); }

function selectAddress(answers: string[]): string {
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > 16) throw failure();
  // IPv4 only. Reject whole /8s containing fragmented special-purpose allocations
  // at 192, 198 and 203, deliberately sacrificing availability for a simpler policy.
  for (const candidate of answers) {
    if (!isIPv4(candidate)) throw failure();
    const [first, second] = candidate.split('.').map(Number);
    if ([0, 10, 127, 192, 198, 203].includes(first) || first >= 224
      || (first === 100 && second >= 64 && second <= 127) || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)) throw failure();
  }
  return answers[0];
}
const oauth = 'https://accounts.feishu.cn/oauth/v3/token';
const message = 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id';
const bodyLimit = 64 * 1024;

// Install error and close listeners synchronously for each newly acquired resource.
function closed(resource: ClientRequest | IncomingMessage | TLSSocket, fail: () => void) {
  resource.on('error', fail);
  return new Promise<void>((done) => resource.once('close', done));
}

function createTransport(io: IO): Transport {
  return async (url, take, signal) => {
    if ((url !== oauth && url !== message) || signal.aborted) throw failure();
    const target = new URL(url);
    let socket: TLSSocket | undefined;
    let req: ClientRequest | undefined;
    let res: IncomingMessage | undefined;
    let failed = false;
    let reply: Reply | undefined;
    let requestClose: Promise<void> | undefined;
    let responseClose: Promise<void> | undefined;
    let socketClose: Promise<void> | undefined;
    const chunks: Buffer[] = [];
    const fail = () => {
      failed = true;
      res?.destroy();
      req?.destroy();
      socket?.destroy();
    };
    signal.addEventListener('abort', fail, { once: true });
    const timer = setTimeout(fail, 10_000);
    try {
      const answers = await io.resolve(target.hostname);
      if (failed) throw failure();
      const address = io.select(answers);
      const peer = io.dial({ host: address, family: 4, port: io.port, servername: target.hostname,
        rejectUnauthorized: true, checkServerIdentity, ca: [...io.roots], ALPNProtocols: ['http/1.1'],
        minVersion: 'TLSv1.2' });
      socket = peer;
      socketClose = closed(peer, fail);
      peer.once('secureConnect', () => {
        try {
          if (failed || signal.aborted || !peer.authorized || peer.remoteAddress !== address
            || peer.remotePort !== io.port || peer.destroyed) throw failure();
          const wire = take(url);
          if (!wire || failed || signal.aborted || peer.destroyed) throw failure();
          // No agent option. A synchronous createConnection returns only this authenticated stream.
          req = request({ hostname: target.hostname, path: target.pathname + target.search,
            method: wire.method, headers: { ...wire.headers, 'content-length': wire.body.byteLength, connection: 'close' },
            maxHeaderSize: 16 * 1024, insecureHTTPParser: false, createConnection: () => peer });
          requestClose = closed(req, fail);
          req.maxHeadersCount = 0; // Preserve every raw pair inside the byte cap.
          // Node detaches the verified socket and gives us a separate IncomingMessage.
          // Refuse the upgrade and own both resources until each has emitted close.
          req.once('upgrade', (incoming) => {
            res = incoming;
            responseClose = closed(incoming, fail);
            fail();
          });
          req.on('information', fail);
          req.once('response', (incoming) => {
            res = incoming;
            responseClose = closed(incoming, fail);
            if (failed) { fail(); return; }
            let bytes = 0;
            incoming.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (failed || bytes > bodyLimit) { fail(); return; }
              chunks.push(chunk);
            });
            incoming.once('aborted', fail);
            incoming.once('end', () => {
              if (failed || !incoming.complete || incoming.rawTrailers.length) { fail(); return; }
              const headers: [string, string][] = [];
              for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
                headers.push([incoming.rawHeaders[i], incoming.rawHeaders[i + 1]]);
              }
              reply = { status: incoming.statusCode ?? 0, headers, body: Buffer.concat(chunks, bytes) };
              peer.destroy();
            });
          });
          req.end(wire.body);
        } catch { fail(); }
      });
      await socketClose;
    } catch { fail(); }
    finally {
      // IncomingMessage can be created after request construction. Socket closure
      // marks the boundary after which no further HTTP input can be acquired.
      await socketClose;
      await requestClose;
      await responseClose;
      clearTimeout(timer);
      signal.removeEventListener('abort', fail);
      for (const chunk of chunks) chunk.fill(0);
    }
    if (!reply || failed || signal.aborted) { reply?.body.fill(0); throw failure(); }
    return reply;
  };
}

function createNativeTransport(): Transport {
  return createTransport({
    resolve: async (host) => (await lookup(host, { family: 4, all: true, verbatim: true })).map((item) => item.address),
    select: selectAddress, port: 443, dial: connect,
    // Explicit bundled Mozilla roots shipped with this Node runtime. OS and extra CA stores
    // are not selected. The runtime, its primitives and its local resolver must be trusted.
    roots: rootCertificates,
  });
}
// Keep native assembly private and inert pending an authenticated enrollment and admission owner.
void createNativeTransport;
