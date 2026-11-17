import { lookup } from 'node:dns/promises';
import { Agent as HttpAgent, request as requestHttp, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as requestHttps } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

type Address = { address: string; family: 4 | 6 };
export type RegisteredHttpSource = {
  sourceId: string; accountId: string; dataDomain: string;
  target: string; allowedUrls: readonly string[];
};
type HttpResponse = { status: number; location: string | null; contentType: string | null; bytes: Uint8Array };
export type HttpReadPort = {
  resolve(host: string, signal: AbortSignal): Promise<readonly { address: string; family: number }[]>;
  request(url: URL, address: Address, signal: AbortSignal, maxBytes: number): Promise<HttpResponse>;
};
type CollectedResponse = HttpResponse & { url: string; redirects: number };

const maxRedirects = 4;
const maxBytes = 2 * 1024 * 1024;
const timeout = 10_000;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const blocked = new BlockList();
for (const [range, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blocked.addSubnet(range, bits, 'ipv4');
for (const [range, bits] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) blocked.addSubnet(range, bits, 'ipv6');
const globalIpv6 = new BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');

export function sourceUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.length > 2048 || raw.includes('\\') || /\s/u.test(raw) ||
      [...raw].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) invalid();
  let url: URL;
  try { url = new URL(raw); } catch { return invalid(); }
  const hostname = url.hostname;
  const namedHost = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.port || isIP(hostname) ||
      !namedHost.test(hostname) || /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/iu.test(hostname) ||
      /%(?:2f|5c|00)/iu.test(url.pathname)) invalid();
  if ([...url.searchParams.keys()].some((key) => /^(?:access_token|token|api[_-]?key|secret|password|auth|signature|credential|x-amz-signature)$/iu.test(key))) {
    invalid();
  }
  url.hash = '';
  return url;
}

export async function readRegisteredHttp(source: RegisteredHttpSource, port: HttpReadPort = nativePort,
  input?: { signal?: AbortSignal; stillAllowed?: (url: string) => boolean | Promise<boolean> }): Promise<CollectedResponse> {
  if (!source.sourceId || !source.accountId || !source.dataDomain || source.allowedUrls.length < 1 || source.allowedUrls.length > 32) denied();
  const allowed = new Set(source.allowedUrls.map((value) => sourceUrl(value).href));
  let target = sourceUrl(source.target);
  const signal = input?.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  const visited = new Set<string>();
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    signal.throwIfAborted();
    if (!allowed.has(target.href) || await input?.stillAllowed?.(target.href) === false) denied();
    if (visited.has(target.href)) throw new Error('SOURCE_REDIRECT_LIMIT');
    visited.add(target.href);
    signal.throwIfAborted();
    const candidates = await untilAbort(port.resolve(target.hostname, signal), signal);
    if (!candidates.length || candidates.length > 32 || !candidates.every(publicAddress)) denied();
    if (await input?.stillAllowed?.(target.href) === false) denied();
    signal.throwIfAborted();
    const pinned = { ...candidates[0] };
    const response = await untilAbort(port.request(new URL(target), pinned, signal, maxBytes), signal);
    if (redirectStatuses.has(response.status)) {
      if (!response.location || redirects === maxRedirects) throw new Error('SOURCE_REDIRECT_LIMIT');
      let next: URL;
      try { next = sourceUrl(new URL(response.location, target).href); }
      catch { return denied(); }
      if (target.protocol === 'https:' && next.protocol !== 'https:') denied();
      target = next;
      continue;
    }
    if (response.status === 401 || response.status === 403 || response.status === 407) login();
    if (response.status !== 200) throw new Error('SOURCE_HTTP_UNAVAILABLE');
    if (response.bytes.byteLength < 1 || response.bytes.byteLength > maxBytes) throw new Error('SOURCE_BODY_SIZE');
    if (response.contentType?.split(';')[0]?.trim().toLowerCase() === 'text/html') {
      if (/<input\b[^>]*\btype\s*=\s*(?:"password"|'password'|password\b)/iu
        .test(new TextDecoder().decode(response.bytes))) login();
    }
    return { ...response, url: target.href, redirects };
  }
  throw new Error('SOURCE_REDIRECT_LIMIT');
}

function publicAddress(row: { address: string; family: number }): row is Address {
  if (typeof row.address !== 'string' || row.address.includes('%')) return false;
  const type = isIP(row.address);
  if (type !== row.family) return false;
  if (type === 4) return !blocked.check(row.address, 'ipv4');
  return type === 6 && globalIpv6.check(row.address, 'ipv6') && !blocked.check(row.address, 'ipv6');
}

async function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

const nativePort: HttpReadPort = {
  resolve: (hostname) => lookup(hostname, { all: true, order: 'verbatim' }),
  async request(url, address, signal, limit) {
    const secure = url.protocol === 'https:';
    const agent = secure ? new HttpsAgent({ keepAlive: false, maxSockets: 1 }) : new HttpAgent({ keepAlive: false, maxSockets: 1 });
    const request = secure ? requestHttps : requestHttp;
    const exact = new BlockList();
    const family = address.family === 6 ? 'ipv6' : 'ipv4';
    exact.addAddress(address.address, family);
    const pinned: LookupFunction = (host, options, cb) => {
      if (host !== url.hostname) cb(new Error('SOURCE_TARGET_OUTSIDE_SCOPE'), '', 0);
      else if (options.all) cb(null, [address]);
      else cb(null, address.address, address.family);
    };
    let response: IncomingMessage | undefined;
    try {
      const req = await new Promise<{ response: IncomingMessage }>((resolve, reject) => {
        const req = request(url, { method: 'GET', agent, family: address.family, lookup: pinned, signal,
          headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html', 'accept-encoding': 'identity' } },
        (incoming) => resolve({ response: incoming }));
        req.once('error', reject);
        req.end();
      });
      response = req.response;
      const peer = response.socket.remoteAddress;
      if (!peer || !exact.check(peer, family)) denied();
      const status = response.statusCode ?? 0;
      const contentType = response.headers['content-type'] ?? null;
      const location = response.headers.location ?? null;
      if (status !== 200) return { status, contentType, location, bytes: new Uint8Array() };
      if (response.headers['content-encoding'] && response.headers['content-encoding'].toLowerCase() !== 'identity') {
        throw new Error('SOURCE_CONTENT_ENCODING');
      }
      if (Number(response.headers['content-length']) > limit) throw new Error('SOURCE_BODY_SIZE');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        signal.throwIfAborted();
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if ((size += bytes.length) > limit) throw new Error('SOURCE_BODY_SIZE');
        chunks.push(bytes);
      }
      return { status, contentType, location, bytes: Buffer.concat(chunks, size) };
    } finally {
      response?.destroy();
      agent.destroy();
    }
  },
};

function invalid(): never { throw new Error('SOURCE_URL_INVALID'); }
function denied(): never { throw new Error('SOURCE_TARGET_OUTSIDE_SCOPE'); }
function login(): never { throw new Error('SOURCE_REQUIRES_LOGIN'); }
