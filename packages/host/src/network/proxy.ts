import { connect, type Socket } from 'node:net';

export type ConnectProxy = Readonly<{ server: string; port: number }>;
export type ProxyConnector = (proxy: ConnectProxy, destination: Readonly<{ host: string; port: number }>,
  signal: AbortSignal, timeoutMs: number) => Promise<Socket>;

/** Fixed HTTPS CONNECT only. No credentials, PAC evaluation, redirects, or direct fallback. */
export const connectHttpProxy: ProxyConnector = (proxy, destination, signal, timeoutMs) => new Promise((resolve, reject) => {
  const socket = connect({ host: proxy.server, port: proxy.port, signal });
  let response = Buffer.alloc(0);
  const fail = (error: Error) => { cleanup(); socket.destroy(); reject(error); };
  const onTimeout = () => fail(new Error('NETWORK_PROXY_TIMEOUT'));
  const onClosed = () => fail(new Error('NETWORK_PROXY_CLOSED'));
  const cleanup = () => {
    socket.removeListener('error', fail);
    socket.removeListener('timeout', onTimeout);
    socket.removeListener('data', receive);
    socket.removeListener('end', onClosed);
    socket.removeListener('close', onClosed);
  };
  const receive = (chunk: Buffer) => {
    response = Buffer.concat([response, chunk]);
    if (response.length > 16 * 1024) { fail(new Error('NETWORK_PROXY_RESPONSE_LIMIT')); return; }
    const end = response.indexOf('\r\n\r\n');
    if (end < 0) return;
    const status = /^HTTP\/1\.[01] (\d{3})[^\r\n]*\r\n/u.exec(response.toString('latin1'))?.[1];
    if (status !== '200') { fail(new Error(status === '407' ? 'NETWORK_PROXY_AUTH_REQUIRED' : 'NETWORK_PROXY_REJECTED')); return; }
    cleanup();
    socket.setTimeout(0);
    if (response.length > end + 4) socket.unshift(response.subarray(end + 4));
    resolve(socket);
  };
  socket.setTimeout(timeoutMs);
  socket.once('error', fail);
  socket.once('timeout', onTimeout);
  socket.once('end', onClosed);
  socket.once('close', onClosed);
  socket.on('data', receive);
  socket.once('connect', () => {
    const authority = `${destination.host.includes(':') ? `[${destination.host}]` : destination.host}:${destination.port}`;
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nConnection: keep-alive\r\n\r\n`);
  });
});
