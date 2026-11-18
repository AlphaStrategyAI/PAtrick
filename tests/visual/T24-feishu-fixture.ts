import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createVite, type ViteDevServer } from 'vite';
import type { Page } from '@playwright/test';
import { createCredentialStore } from '@patrick/host';
import { createLocalHubPort, encodeHubAnswer } from '@patrick/integrations/autoloop/answers';
import { createFeishuChannel } from '../../packages/integrations/feishu/connection.js';
import { openDatabase } from '@patrick/storage';
import { createServiceRuntime } from '../../apps/service/src/app.js';
import { issueCallerSession } from '../../apps/service/src/auth.js';
import { stamp } from './T24-vault-fixture.js';

export const synthetic = { app: 'cli_t24_fixture', tenant: 't24_fixture_tenant', owner: 'ou_t24_fixture', chat: 'oc_t24_fixture' };
export const sample = 'PAtrick 连接测试，不含业务资料。';
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const host = 'feishu.localhost';

// Normal Vite app on loopback TLS. Certificate trust is limited to the disposable browser context.
export async function withSecureWeb(run: (origin: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t24-feishu-tls-'));
  let server: ViteDevServer | undefined;
  try {
    const key = join(dir, 'local.key'), cert = join(dir, 'local.crt');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=' + host,
      '-keyout', key, '-out', cert], { stdio: 'ignore' });
    server = await createVite({ root: fileURLToPath(new URL('../../apps/web/', import.meta.url)),
      cacheDir: join(dir, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false,
        https: { key: readFileSync(key), cert: readFileSync(cert) } } });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback TLS port');
    await run('https://' + host + ':' + address.port);
  } finally {
    try { await server?.close(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
}

export async function withChannel(page: Page, origin: string, admitted: boolean, run: (fx: {
  db: ReturnType<typeof openDatabase>; receive: (code: string) => Promise<void>;
  requests: Array<{ method: string; path: string; status: number }>;
}) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t24-feishu-'));
  const databasePath = join(dir, 'local.sqlite');
  const credentialDirectory = join(dir, 'session');
  const now = () => new Date(stamp);
  const db = openDatabase(databasePath);
  const hub = createLocalHubPort(join(dir, 'fixture-hub.sqlite'));
  let runtime: ReturnType<typeof createServiceRuntime> | undefined;
  try {
    db.prepare("INSERT INTO accounts VALUES ('owner',1,1,?)").run(stamp);
    const id = 'conn_' + hash('owner').slice(0, 12);
    if (admitted) {
      // A separate T10-style pre-admitted starting state. No staged connection is promoted by the test.
      db.prepare(`INSERT INTO channel_connections (connection_id,account_id,data_domain,app_id,tenant_key,credential_ref,
        credential_version,config_revision,channel_incarnation,connection_epoch,binding_revision,status,transport_mode,
        schema_version,created_at,updated_at) VALUES (?,'owner','personal',?,?,'synthetic-ref',1,1,1,1,1,'needs_binding','probe','1.0',?,?)`)
        .run(id, synthetic.app, synthetic.tenant, stamp, stamp);
    }
    const { token } = issueCallerSession(db, { accountId: 'owner', callerId: 'web', domain: 'personal', permissions: ['owner'] },
      now, createCredentialStore(credentialDirectory, now));
    await page.context().addCookies([{ name: 'patrick_session', value: token, url: origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
    runtime = createServiceRuntime({ databasePath, credentialDirectory, now, browserAuthority: { origin, rpId: host },
      feishuCredentials: createCredentialStore(join(dir, 'fixture-store'), now) });
    const { app } = runtime;
    const requests: Array<{ method: string; path: string; status: number }> = [];
    await page.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) return route.abort('blockedbyclient');
      if (!url.pathname.startsWith('/api/v1/')) return route.continue();
      if (url.pathname === '/api/v1/events') return route.fulfill({ status: 503, body: '' });
      const response = await app.request(req.url(), { method: req.method(), headers: await req.allHeaders(), body: req.postData() });
      const text = await response.text();
      requests.push({ method: req.method(), path: url.pathname, status: response.status });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: text });
    });
    const channel = createFeishuChannel(db, { connectionId: id, hub, encode: encodeHubAnswer, domain: 'personal', now });
    await run({ db, requests, receive: code => channel.receivePairingMessage({ code, open_id: synthetic.owner, chat_id: synthetic.chat }) });
  } finally {
    try { await page.unrouteAll({ behavior: 'wait' }); }
    finally {
      try { await runtime?.drain(); }
      finally { hub.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
    }
  }
}
