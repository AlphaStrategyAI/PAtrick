import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer as createNetServer } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { openDatabase } from '@patrick/storage';
import { createCredentialStore } from '@patrick/host';
import { connectVault, requireVault } from '@patrick/integrations/vault/connection';
import { issueCallerSession } from '../../apps/service/src/auth.js';
import { createApp } from '../../apps/service/src/app.js';
import { bindUnreserved, withHealthService } from '../visual/T24-baseline-fixture.js';

async function setup(page: Page, withVault = false, permissions = ['owner']) {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t17-browser-'));
  const databasePath = join(dir, 't17.sqlite');
  const credentialDirectory = join(dir, 'cred');
  const now = () => new Date('2026-11-17T05:00:00.000Z');
  const db = openDatabase(databasePath);
  db.prepare("INSERT INTO accounts VALUES ('owner',1,1,?)").run(now().toISOString());
  if (withVault) {
    const root = join(dir, 'Vault');
    mkdirSync(root);
    await connectVault(db, { accountId: 'owner', deviceId: 'test-device', vaultId: 't17-browser-vault',
      root, domain: 'personal', captureHost: hostname(), now: now().toISOString() });
  }
  const credentials = createCredentialStore(credentialDirectory, now);
  const { token } = issueCallerSession(db, { accountId: 'owner', callerId: 'web', domain: 'personal', permissions }, now, credentials);
  await page.context().addCookies([{ name: 'patrick_session', value: token, url: 'http://localhost', httpOnly: true, sameSite: 'Strict' }]);
  const app = createApp({ databasePath, credentialDirectory, now });
  await page.route('**/api/v1/**', async (route) => {
    const browser = route.request();
    if (browser.url().includes('/api/v1/events')) {
      await route.fulfill({ status: 503, body: '' });
      return;
    }
    const body = browser.postData();
    const upstream = await app.request(browser.url(), {
      method: browser.method(), headers: await browser.allHeaders(), ...(body ? { body } : {}),
    });
    await route.fulfill({ status: upstream.status, headers: Object.fromEntries(upstream.headers), body: await upstream.text() });
  });
  return { db, async close() {
    try { if (!page.isClosed()) { await page.goto('about:blank'); await page.unrouteAll({ behavior: 'wait' }); } }
    finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  } };
}

test('account preferences read back after reload and a failed save keeps the local language', async ({ page }) => {
  const fx = await setup(page);
  try {
    await page.goto('/settings/preferences');
    const button = page.getByRole('button', { name: 'Save to account' });
    await expect(button).toBeEnabled();
    const pane = page.locator('main');
    await pane.getByRole('checkbox').check();
    const committed = page.waitForResponse((response) => response.url().endsWith('/api/v1/preferences') && response.request().method() === 'PATCH');
    await button.click();
    expect((await committed).status()).toBe(200);
    await expect(page.getByText('Saved to your account')).toBeVisible();
    await page.reload();
    await expect(button).toBeEnabled();
    await expect(pane.getByRole('checkbox')).toBeChecked();
    await page.route('**/api/v1/preferences', async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      await route.fulfill({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ code: 'UNAVAILABLE', params: {}, retryable: true, correlation_id: 'test-unavailable' }) });
    });
    await pane.getByRole('combobox').selectOption('zh');
    await page.getByRole('button', { name: '保存到账户' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(pane.getByRole('alert')).toBeVisible();
    expect(fx.db.prepare("SELECT revision FROM account_preferences WHERE account_id='owner'").get()).toEqual({ revision: 1 });
  } finally { await fx.close(); }
});

test('settings offer six groups and distinguish unconfigured host actions from the registered Vault handler', async ({ page }) => {
  const fx = await setup(page);
  try {
    await page.goto('/settings');
    await expect(page.locator('main nav a')).toHaveCount(6);
    await page.goto('/settings/materials');
    await expect(page.getByText('Connect a Vault: Available')).toBeVisible();
    await page.goto('/settings/operation');
    await expect(page.getByText('Check the host: Unavailable in this installation')).toBeVisible();
  } finally { await fx.close(); }
});

test('a registered Vault uses the three-step review before applying and shows the same receipt on System', async ({ page }) => {
  const fx = await setup(page, true);
  try {
    await page.goto('/settings/materials');
    await page.getByLabel('Registered target').selectOption(JSON.stringify(['t17-browser-vault', 'test-device']));
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Validation passed')).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    const confirm = page.getByRole('button', { name: 'Confirm and apply' });
    await expect(confirm).toBeVisible();
    expect(requireVault(fx.db, 't17-browser-vault').status).toBe('awaiting_confirmation');
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM control_receipts').get()).toEqual({ n: 0 });
    await confirm.click();
    const receipt = page.getByTestId('settings-change-receipt');
    await expect(receipt.getByText('Verified after applying')).toBeVisible();
    const id = await receipt.locator('code').textContent();
    expect(id).toMatch(/^settings_[a-f0-9-]{36}$/u);
    expect(requireVault(fx.db, 't17-browser-vault')).toMatchObject({ status: 'connected', connection_epoch: 1 });
    await receipt.getByRole('link', { name: 'System' }).click();
    await expect(receipt.locator('code')).toHaveText(id!);
    await expect(receipt.getByText('Verified after applying')).toBeVisible();
  } finally { await fx.close(); }
});

test('the first account read does not overwrite a language choice made while it is in flight', async ({ page }) => {
  const fx = await setup(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    await page.route('**/api/v1/preferences', async (route) => {
      if (route.request().method() === 'GET') await held;
      await route.fallback();
    });
    await page.goto('/settings/preferences');
    await page.locator('main').getByRole('combobox').selectOption('zh');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    release();
    await expect(page.getByRole('button', { name: '保存到账户' })).toBeEnabled();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    expect(fx.db.prepare("SELECT revision FROM account_preferences WHERE account_id='owner'").get()).toBeUndefined();
  } finally { release(); await fx.close(); }
});

test('Feishu setup reports unavailable ingress instead of asking for a secret on local HTTP', async ({ page }) => {
  const fx = await setup(page);
  try {
    await page.goto('/settings/interaction');
    const bot = page.getByRole('region', { name: 'Feishu bot' });
    await expect(bot.getByText('Not configured', { exact: true })).toBeVisible();
    await bot.getByText('Connection setup', { exact: true }).click();
    await expect(bot.getByText('Secure credential setup is unavailable in this installation.')).toBeVisible();
    await expect(bot.getByLabel('App Secret')).toHaveCount(0);
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM channel_connections').get()).toEqual({ n: 0 });
  } finally { await fx.close(); }
});

test('Feishu confirms the scoped pairing, previews the exact test and leaves delivery unverified without a transport', async ({ page }) => {
  const fx = await setup(page);
  try {
    const stamp = '2026-11-17T05:00:00.000Z';
    const id = 'conn_' + createHash('sha256').update('owner').digest('hex').slice(0, 12);
    fx.db.prepare(`INSERT INTO channel_connections (
      connection_id, account_id, data_domain, app_id, tenant_key, credential_ref, credential_version,
      config_revision, channel_incarnation, connection_epoch, binding_revision, current_pairing_id, status,
      transport_mode, schema_version, created_at, updated_at
    ) VALUES (?, 'owner', 'personal', 'cli_browser_fixture', 'tenant_fixture', 'cred_fixture', 1,
      1, 1, 1, 1, 'pair_fixture', 'needs_binding', 'probe', '1.0', ?, ?)`).run(id, stamp, stamp);
    fx.db.prepare(`INSERT INTO channel_pairings (
      pairing_id, connection_id, account_id, data_domain, code_hash, expires_at, candidate_open_id,
      candidate_chat_id, app_id, tenant_key, config_revision, credential_version, binding_revision, incarnation, epoch,
      status, schema_version, created_at
    ) VALUES ('pair_fixture', ?, 'owner', 'personal', ?, '2026-11-17T05:05:00.000Z', 'ou_browser_fixture',
      'oc_browser_fixture', 'cli_browser_fixture', 'tenant_fixture', 1, 1, 1, 1, 1, 'candidate', '1.0', ?)`).run(id, 'a'.repeat(64), stamp);
    await page.goto('/settings/interaction');
    const bot = page.getByRole('region', { name: 'Feishu bot' });
    await bot.getByText('Connection setup', { exact: true }).click();
    await expect(bot.getByText('Personal chat identity: ou_browser_fixture')).toBeVisible();
    await expect(bot.getByText('Data scope: personal')).toBeVisible();
    await bot.getByRole('button', { name: 'Confirm identity and data scope' }).click();
    await bot.getByRole('button', { name: 'Preview test' }).click();
    await expect(bot.getByText('PAtrick 连接测试，不含业务资料。')).toBeVisible();
    await expect(bot.getByText('Previewed; no message sent')).toBeVisible();
    await expect(bot.getByRole('button', { name: 'Send test message' })).toBeDisabled();
    await expect(bot.getByText('The supervised Feishu connection is not configured.')).toBeVisible();
    await page.reload();
    await bot.getByText('Connection setup', { exact: true }).click();
    await expect(bot.getByText('Previewed; no message sent')).toBeVisible();
    expect(fx.db.prepare('SELECT status, transport_mode FROM channel_connections').get()).toEqual({ status: 'needs_test', transport_mode: 'probe' });
    expect(fx.db.prepare('SELECT status, message_id, inbound_evidence FROM channel_tests').get()).toEqual({
      status: 'previewed', message_id: null, inbound_evidence: null,
    });
  } finally { await fx.close(); }
});


test('opening interaction settings does not revoke a session that cannot read channels', async ({ page }) => {
  const fx = await setup(page, false, ['settings.read']);
  try {
    const channelRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/channels/feishu')) channelRequests.push(request.url());
    });
    await page.goto('/settings/interaction');
    await expect(page.getByRole('region', { name: 'Feishu bot' })).toContainText('Feishu settings are unavailable with this permission.');
    await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
    expect(channelRequests).toEqual([]);
  } finally { await fx.close(); }
});

test('settings overview does not turn an unobserved snapshot into checks or a known device', async ({ page }) => {
  const fx = await setup(page);
  const healthRequests: string[] = [];
  const writes: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/system/health') healthRequests.push(request.method());
    if (path.startsWith('/api/v1/') && request.method() !== 'GET') writes.push(request.method() + ' ' + path);
  });
  try {
    await page.goto('/settings');
    const overview = page.getByRole('region', { name: 'Service projection snapshot' });
    await expect(overview).toBeVisible();
    await expect(overview).toContainText('Service projection status: Unknown');
    await expect(overview).toContainText('Current device: Unknown');
    await expect(overview).toContainText('No verified snapshot available');
    await expect(overview.locator('time')).toHaveCount(0);
    await expect(overview.getByRole('button', { name: 'Run checks' })).toBeDisabled();
    await expect(overview).toContainText('Combined checks are not supported yet.');
    const count = healthRequests.length;
    const refresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/system/health');
    await overview.getByRole('button', { name: 'Refresh health snapshot' }).click();
    expect((await refresh).status()).toBe(200);
    expect(healthRequests.length).toBeGreaterThan(count);
    expect(healthRequests.every(method => method === 'GET')).toBe(true);
    expect(writes).toEqual([]);
    await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh');
    const chinese = page.getByRole('region', { name: '服务投影快照' });
    await expect(chinese).toContainText('服务投影状态：未知');
    await expect(chinese).toContainText('当前设备：未知');
    await expect(chinese).toContainText('暂无可验证的快照');
    await expect(chinese.getByRole('button', { name: '运行检查' })).toBeDisabled();
    await expect(chinese).toContainText('尚不支持统一检查。');
  } finally { await fx.close(); }
});


const overviewCopy = {
  en: { region: 'Service projection snapshot', current: 'Service projection status: Current', unknown: 'Service projection status: Unknown',
    device: 'Current device: Unknown', at: 'Snapshot as of', last: 'Last verified snapshot', stale: 'The snapshot is stale.',
    offline: 'The connection is lost.', unavailable: 'The health snapshot is unavailable.', issue: 'Vault needs permission.', issueOther: 'Feishu connection needs attention.',
    system: 'View in System', refresh: 'Refresh health snapshot' },
  zh: { region: '服务投影快照', current: '服务投影状态：最新', unknown: '服务投影状态：未知',
    device: '当前设备：未知', at: '快照时间', last: '上次可验证快照', stale: '快照已过期。',
    offline: '连接已断开。', unavailable: '健康快照暂不可用。', issue: '资料库需要权限。', issueOther: '飞书连接需要处理。',
    system: '前往系统', refresh: '刷新健康快照' },
} as const;
const overviewFacts = { connections: { vault: { status: 'needs_permission', revision: 1, epoch: 1 },
  feishu: { status: 'degraded', revision: 1, epoch: 1 } }, edits: { pending: 0, failed: 2 } };

for (const locale of ['en', 'zh'] as const) {
  test.describe(locale + ' scoped settings health overview', () => {
    test.use({ locale: locale === 'en' ? 'en-US' : 'zh-CN' });
    test('reports only the current projection and one known issue, then preserves the last verified snapshot', async ({ page }, info) => {
      const t = overviewCopy[locale];
      await withHealthService(page, async service => {
        await page.goto('/settings');
        const visibleSource = (await page.content()) + await page.evaluate(async () => (await fetch('/@vite/env')).text());
        expect(visibleSource.includes(process.env.PATRICK_OVERVIEW_TRANSPORT_KEY!)).toBe(false);
        const transport = { port: Number(process.env.PATRICK_OVERVIEW_PROXY_PORT), directory: process.env.PATRICK_OVERVIEW_DIRECTORY!,
          controlPort: Number(process.env.PATRICK_OVERVIEW_CONTROL_PORT), backendPort: service.backendPort, owner: Number(process.env.PATRICK_OVERVIEW_PROXY_OWNER), worker: process.pid, parent: process.ppid, observedAt: new Date().toISOString() };
        expect(transport.owner).toBe(transport.parent);
        expect(transport.port).not.toBe(43155);
        expect(statSync(transport.directory).mode & 0o777).toBe(0o700);
        expect(new Set([transport.port, transport.controlPort, service.backendPort, 43155]).size).toBe(4);
        writeFileSync(info.outputPath('overview-transport.json'), JSON.stringify(transport, null, 2));
        await expect(page.locator('.desktop-sidebar .brand [role=status]')).toHaveText(locale === 'en' ? 'Running' : '运行中', { timeout: 22_000 });
        const overview = page.getByRole('region', { name: t.region });
        await expect(overview).toContainText(t.current);
        await expect(overview).toContainText(t.device);
        await expect(overview).toContainText(t.at);
        await expect(overview.locator('time')).toHaveAttribute('datetime', '2026-11-17T04:58:00.000Z');
        await expect(overview).toContainText(t.issue);
        await expect(overview).not.toContainText(t.issueOther);
        await expect(overview.getByRole('link', { name: t.system })).toHaveAttribute('href', '/system');
        await expect(overview).not.toContainText(/all systems (?:are )?ready|全部系统就绪/i);
        // Abort one GET while the real SSE remains connected; this is a transport-failure injection.
        const healthRoute = '**/api/v1/system/health?*';
        await page.route(healthRoute, route => route.abort('failed'));
        const failure = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname === '/api/v1/system/health');
        await overview.getByRole('button', { name: t.refresh }).click();
        await failure;
        await expect(overview).toContainText(t.unknown);
        await expect(overview).toContainText(t.unavailable);
        await expect(overview).not.toContainText(t.offline);
        await expect(overview).toContainText(t.last);
        await page.unroute(healthRoute);
        const recovery = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/system/health');
        await overview.getByRole('button', { name: t.refresh }).click();
        expect((await recovery).status()).toBe(200);
        await expect(overview).toContainText(t.current);
        service.setProjection('stale', '2026-11-17T04:59:00.000Z', overviewFacts);
        const updated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/system/health');
        await overview.getByRole('button', { name: t.refresh }).click();
        expect((await updated).status()).toBe(200);
        await expect(overview).toContainText(t.unknown);
        await expect(overview).toContainText(t.stale);
        await expect(overview).toContainText(t.last);
        await expect(overview.locator('time')).toHaveAttribute('datetime', '2026-11-17T04:58:00.000Z');
        await expect(overview).not.toContainText(t.issue);
        service.disconnectEvents();
        await expect(overview).toContainText(t.offline);
        await expect(overview).toContainText(t.unknown);
        await expect(overview.locator('time')).toHaveAttribute('datetime', '2026-11-17T04:58:00.000Z');
        service.setProjection('fresh', '2026-11-17T05:00:00.000Z', overviewFacts);
        const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/system/health');
        await overview.getByRole('button', { name: t.refresh }).click();
        expect((await refreshed).status()).toBe(200);
        await expect(overview).toContainText(t.unknown);
        await expect(overview).toContainText(t.offline);
        await expect(overview).toContainText(t.last);
        await expect(overview.locator('time')).toHaveAttribute('datetime', '2026-11-17T05:00:00.000Z');
        await expect(overview).not.toContainText(t.issue);
        const reads = service.requests.filter(request => ['/api/v1/session', '/api/v1/system/health', '/api/v1/events'].includes(request.path));
        expect(reads.length).toBeGreaterThan(2);
        expect(reads.every(request => request.method === 'GET' && request.status === 200 && request.hasCookie && !request.hasAuthorization)).toBe(true);
        expect(service.requests.filter(request => request.method !== 'GET')).toEqual([]);
      }, { freshness: 'fresh', at: '2026-11-17T04:58:00.000Z', facts: overviewFacts });
    });
    test('does not invent a verified timestamp from an initially stale projection', async ({ page }) => {
      const t = overviewCopy[locale];
      await withHealthService(page, async () => {
        await page.goto('/settings');
        const overview = page.getByRole('region', { name: t.region });
        await expect(overview).toContainText(t.unknown);
        await expect(overview).toContainText(t.stale);
        await expect(overview.locator('time')).toHaveCount(0);
        await expect(overview).not.toContainText(t.issue);
      }, { freshness: 'stale', at: '2026-11-17T04:00:00.000Z', facts: overviewFacts });
    });
    test('does not invent a verified timestamp for an initially unobserved projection', async ({ page }) => {
      const t = overviewCopy[locale];
      await withHealthService(page, async () => {
        await page.goto('/settings');
        const overview = page.getByRole('region', { name: t.region });
        await expect(overview).toContainText(t.unknown);
        await expect(overview).toContainText(t.device);
        await expect(overview.locator('time')).toHaveCount(0);
      });
    });
  });
}


test('health fixture cleans up when its TCP port is occupied without touching its owner', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'p24-fail-'));
  const owner = createNetServer(connection => connection.end('owner-alive'));
  const port = await bindUnreserved(owner, new Set([Number(process.env.PATRICK_OVERVIEW_PROXY_PORT), Number(process.env.PATRICK_OVERVIEW_CONTROL_PORT)]));
  let cleanup: unknown;
  try {
    await expect(withHealthService(page, async () => {}, undefined, {
      backendPort: port, scratchRoot: root, onCleanup: result => { cleanup = result; },
    })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(cleanup).toMatchObject({ databaseOpen: false, runtimeStatus: 'closed', serviceListening: false });
    expect(readdirSync(root)).toEqual([]);
    const received = await new Promise<string>((resolve, reject) => {
      const connection = createConnection({ host: '127.0.0.1', port });
      let text = '';
      connection.on('data', chunk => { text += chunk.toString(); });
      connection.once('end', () => resolve(text));
      connection.once('error', reject);
    });
    expect(received).toBe('owner-alive');
  } finally {
    await new Promise<void>((resolve, reject) => owner.close(error => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

for (const change of ['same-scope revalidation', 'different-domain switch'] as const) {
  test('settings snapshot time is cleared on ' + change, async ({ page }) => {
    test.setTimeout(60_000);
    const oldTime = '2026-11-17T04:58:00.000Z';
    await withHealthService(page, async service => {
      await page.goto('/settings');
      const overview = page.getByRole('region', { name: 'Service projection snapshot' });
      await expect(page.locator('.desktop-sidebar .brand [role=status]')).toHaveText('Running', { timeout: 22_000 });
      await expect(overview.locator('time')).toHaveAttribute('datetime', oldTime);
      const before = await page.evaluate(async () => await (await fetch('/api/v1/session')).json());
      const held = service.holdNextSession();
      try {
        if (change === 'different-domain switch') await service.switchDomain();
        service.setProjection('stale', '2026-11-17T04:59:00.000Z', overviewFacts);
        const revalidated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/session' && response.status() === 200);
        service.resetProjection();
        await held.ready;
        await expect(page.locator(`main time[datetime="${oldTime}"]`)).toHaveCount(0);
        if (change === 'same-scope revalidation') service.addPermission();
        held.release();
        const after = await (await revalidated).json();
        if (change === 'same-scope revalidation') {
          expect(after.scope).toEqual(before.scope);
          expect(before.data.scope_operations).not.toContain('settings.read');
          expect(after.data.scope_operations).toContain('settings.read');
        } else expect(after.scope).toMatchObject({ account_id: 'owner', data_domain: 'company', permission_epoch: before.scope.permission_epoch });
        await expect(overview).toContainText('No verified snapshot available');
        await expect(overview.locator('time')).toHaveCount(0);
        expect(service.requests.filter(request => ['/api/v1/session', '/api/v1/system/health', '/api/v1/events'].includes(request.path))
          .every(request => request.hasCookie)).toBe(true);
      } finally { held.release(); }
    }, { freshness: 'fresh', at: oldTime, facts: overviewFacts });
  });
}


test('nested independent process reserves and releases a different overview proxy', async () => {
  const parent = { port: Number(process.env.PATRICK_OVERVIEW_PROXY_PORT), directory: process.env.PATRICK_OVERVIEW_DIRECTORY!,
    owner: Number(process.env.PATRICK_OVERVIEW_PROXY_OWNER) };
  expect(parent.owner).toBe(process.ppid);
  const moduleUrl = new URL('../visual/T24-baseline-fixture.ts', import.meta.url).href;
  const code = `import { overviewProxyTarget } from ${JSON.stringify(moduleUrl)};
    const target = await overviewProxyTarget();
    console.log(JSON.stringify({ target, directory: process.env.PATRICK_OVERVIEW_DIRECTORY, owner: Number(process.env.PATRICK_OVERVIEW_PROXY_OWNER), pid: process.pid }));
    process.stdin.resume();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  try {
    const [line] = await once(lines, 'line') as [string];
    const nested = JSON.parse(line) as { target: string; directory: string; owner: number; pid: number };
    expect(nested.owner).toBe(nested.pid);
    expect(nested.target).not.toBe(`http://127.0.0.1:${parent.port}`);
    expect(nested.directory).not.toBe(parent.directory);
    expect(statSync(nested.directory).mode & 0o777).toBe(0o700);
    expect((await fetch(nested.target)).status).toBe(503);
    child.stdin.end();
    expect((await exited)[0]).toBe(0);
    expect(existsSync(nested.directory)).toBe(false);
    expect(existsSync(parent.directory)).toBe(true);
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
  }
});

test('health fixture removes its own resources on normal and exceptional callback exits', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'p24-cleanup-'));
  const proxy = `http://127.0.0.1:${process.env.PATRICK_OVERVIEW_PROXY_PORT}`;
  try {
    for (const failure of [false, true]) {
      let cleanup: unknown;
      const run = withHealthService(page, async () => {
        expect((await fetch(proxy + '/api/v1/session')).status).toBe(401);
        if (failure) throw new Error('fixture-body-failed');
      }, undefined, { scratchRoot: root, onCleanup: result => { cleanup = result; } });
      if (failure) await expect(run).rejects.toThrow('fixture-body-failed');
      else await expect(run).resolves.toBeUndefined();
      expect(cleanup).toMatchObject({ databaseOpen: false, runtimeStatus: 'closed', serviceListening: false });
      expect(readdirSync(root)).toEqual([]);
      await expect.poll(async () => (await fetch(proxy)).status).toBe(503);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('proxy exit preserves an unowned socket in its private directory', async () => {
  const moduleUrl = new URL('../visual/T24-baseline-fixture.ts', import.meta.url).href;
  const code = `import { overviewProxyTarget } from ${JSON.stringify(moduleUrl)};
    await overviewProxyTarget();
    console.log(JSON.stringify({ directory: process.env.PATRICK_OVERVIEW_DIRECTORY }));
    process.stdin.resume();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  let owner: ReturnType<typeof createNetServer> | undefined;
  let directory: string | undefined;
  try {
    const [line] = await once(lines, 'line') as [string];
    directory = (JSON.parse(line) as { directory: string }).directory;
    const socket = join(directory, 'foreign.sock');
    owner = createNetServer(connection => connection.end('foreign-owner-alive'));
    await new Promise<void>((resolve, reject) => { owner!.once('error', reject); owner!.listen(socket, resolve); });
    child.stdin.end();
    expect((await exited)[0]).toBe(0);
    expect(existsSync(socket)).toBe(true);
    const received = await new Promise<string>((resolve, reject) => {
      const connection = createConnection(socket);
      let text = '';
      connection.on('data', chunk => { text += chunk.toString(); });
      connection.once('end', () => resolve(text));
      connection.once('error', reject);
    });
    expect(received).toBe('foreign-owner-alive');
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
    if (owner?.listening) await new Promise<void>((resolve, reject) => owner!.close(error => error ? reject(error) : resolve()));
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});


// Runs in an isolated Node child with fake http.createServer; no socket is opened by the probe.
const reservedPortProbe = String.raw`
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
const scenario = process.env.PATRICK_PORT_TEST_CASE;
const events = [];
const servers = [];
let directory;
const originalMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = (...args) => { directory = originalMkdtemp(...args); return directory; };
class Fake extends EventEmitter {
  listening = false;
  listens = 0;
  closes = 0;
  constructor() { super(); this.id = servers.length; servers.push(this); }
  listen(port, host, callback) {
    assert.equal(port, 0);
    assert.equal(host, '127.0.0.1');
    assert.equal(this.listening, false, 'prior close must complete before retry');
    this.listens++;
    events.push('listen:' + this.id + ':' + this.listens);
    if (scenario === 'listen-error' && this.id === 0) {
      process.nextTick(() => this.emit('error', new Error('synthetic listen error')));
      return this;
    }
    this.listening = true;
    process.nextTick(callback);
    return this;
  }
  address() {
    if (scenario === 'invalid-address' && this.id === 0) return null;
    if (scenario === 'exhaustion' && this.id === 0) return { port: 43155 };
    if (scenario === 'control-exhaustion' && this.id === 1) return { port: 43155 };
    if (scenario === 'fixed-low-a' && this.id === 0) return { port: [4179, 4183, 4185, 4187, 4188, 4191, 4192, 54001][this.listens - 1] };
    if (scenario === 'fixed-low-b' && this.id === 0) return { port: [4193, 4194, 4195, 4196, 4197, 4198, 43155, 54001][this.listens - 1] };
    if (scenario === 'fixed-other' && this.id === 0) return { port: [4431, 5173, 8443, 43123, 43124, 54001][this.listens - 1] };
    if (scenario === 'duplicate-control' && this.id === 1 && this.listens === 1) return { port: 54001 };
    if (scenario === 'backend-duplicate') return { port: [4187, 54001, 54002, 54003][this.listens - 1] };
    if (scenario === 'skip-reserved' && this.id === 0 && this.listens === 1) return { port: 43155 };
    if (scenario === 'control-skip' && this.id === 1 && this.listens === 1) return { port: 43155 };
    return { port: this.id === 0 ? 54001 : 54002 };
  }
  close(callback) {
    this.closes++;
    events.push('close-start:' + this.id + ':' + this.closes);
    process.nextTick(() => {
      this.listening = false;
      events.push('close-done:' + this.id + ':' + this.closes);
      callback?.();
    });
    return this;
  }
  unref() { return this; }
}
http.createServer = () => new Fake();
net.createServer = () => new Fake();
syncBuiltinESMExports();
const { overviewProxyTarget, bindUnreserved } = await import(process.env.PATRICK_FIXTURE_URL);
if (scenario === 'backend-duplicate') {
  const server = net.createServer();
  assert.equal(await bindUnreserved(server, new Set([54001, 54002])), 54003);
  assert.equal(server.listens, 4);
  assert.equal(server.closes, 3);
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  assert.equal(server.listening, false);
} else if (['skip-reserved', 'control-skip', 'fixed-low-a', 'fixed-low-b', 'fixed-other', 'duplicate-control'].includes(scenario)) {
  const target = await overviewProxyTarget();
  assert.equal(target, 'http://127.0.0.1:54001');
  assert.equal(await overviewProxyTarget(), target);
  assert.equal(process.env.PATRICK_OVERVIEW_PROXY_PORT, '54001');
  assert.equal(process.env.PATRICK_OVERVIEW_CONTROL_PORT, '54002');
  assert.equal(servers.length, 2);
  const retried = ['control-skip', 'duplicate-control'].includes(scenario) ? servers[1] : servers[0];
  const expectedAttempts = scenario === 'fixed-low-a' || scenario === 'fixed-low-b' ? 8 : scenario === 'fixed-other' ? 6 : 2;
  assert.equal(retried.listens, expectedAttempts);
  assert.equal(retried.closes, expectedAttempts - 1);
  assert.ok(events.indexOf('close-done:' + retried.id + ':1') < events.indexOf('listen:' + retried.id + ':2'));
  assert.equal(servers.every(server => server.listening), true);
} else {
  const message = scenario === 'exhaustion' || scenario === 'control-exhaustion' ? 'Overview proxy port allocation exhausted' :
    scenario === 'listen-error' ? 'synthetic listen error' : 'Missing overview proxy port';
  await assert.rejects(overviewProxyTarget(), { message });
  assert.equal(fs.existsSync(directory), false);
  assert.equal(servers.every(server => !server.listening), true);
  assert.equal(process.env.PATRICK_OVERVIEW_PROXY_PORT, undefined);
  assert.equal(process.env.PATRICK_OVERVIEW_CONTROL_PORT, undefined);
  assert.equal(process.env.PATRICK_OVERVIEW_TRANSPORT_KEY, undefined);
  if (scenario === 'exhaustion') { assert.equal(servers[0].listens, 8); assert.equal(servers[0].closes, 8); }
  if (scenario === 'control-exhaustion') { assert.equal(servers[1].listens, 8); assert.equal(servers[1].closes, 8); assert.equal(servers[0].closes, 1); }
  if (scenario === 'listen-error') { assert.equal(servers[0].listens, 1); assert.equal(servers[0].closes, 0); }
  if (scenario === 'invalid-address') { assert.equal(servers[0].listens, 1); assert.equal(servers[0].closes, 1); }
}
console.log(JSON.stringify({ scenario, servers: servers.map(server => ({ id: server.id, listens: server.listens,
  closes: server.closes, listening: server.listening })), events, directory }));
`;

for (const scenario of ['skip-reserved', 'control-skip', 'fixed-low-a', 'fixed-low-b', 'fixed-other', 'duplicate-control', 'backend-duplicate', 'exhaustion', 'control-exhaustion', 'listen-error', 'invalid-address'] as const) {
  test('overview proxy allocation without sockets: ' + scenario, async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATRICK_FIXTURE_URL: new URL('../visual/T24-baseline-fixture.ts', import.meta.url).href,
      PATRICK_PORT_TEST_CASE: scenario };
    for (const key of ['PATRICK_OVERVIEW_PROXY_PORT', 'PATRICK_OVERVIEW_PROXY_OWNER', 'PATRICK_OVERVIEW_SOCKET',
      'PATRICK_OVERVIEW_DIRECTORY', 'PATRICK_OVERVIEW_CONTROL_PORT', 'PATRICK_OVERVIEW_TRANSPORT_KEY', 'TEST_WORKER_INDEX']) delete env[key];
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', reservedPortProbe], { env, encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    const observation = JSON.parse(result.stdout.trim()) as { scenario: string; directory?: string };
    expect(observation.scenario).toBe(scenario);
    if (observation.directory) expect(existsSync(observation.directory)).toBe(false);
  });
}

test('replacement Playwright worker rejects dead registration and opens a fresh fixture', async () => {
  test.setTimeout(45_000);
  const root = mkdtempSync(join(tmpdir(), 'p24-worker-restart-'));
  const scratch = join(root, 'scratch');
  mkdirSync(scratch);
  const fixtureUrl = new URL('../visual/T24-baseline-fixture.ts', import.meta.url).href;
  const playwrightUrl = new URL('../../node_modules/@playwright/test/index.mjs', import.meta.url).href;
  const cli = fileURLToPath(new URL('../../node_modules/@playwright/test/cli.js', import.meta.url));
  const transport = join(root, 'transport.json');
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(root, 'worker-probe.config.mts'), `import { defineConfig } from ${JSON.stringify(playwrightUrl)};
    import { overviewProxyTarget } from ${JSON.stringify(fixtureUrl)};
    import { writeFileSync } from 'node:fs';
    await overviewProxyTarget();
    writeFileSync(${JSON.stringify(transport)}, JSON.stringify({directory: process.env.PATRICK_OVERVIEW_DIRECTORY}));
    export default defineConfig({ testDir: ${JSON.stringify(root)}, testMatch: 'worker-probe.spec.ts', workers: 1,
      timeout: 25000, use: { browserName: 'chromium' } });`);
  writeFileSync(join(root, 'worker-probe.spec.ts'), `import { test, expect } from ${JSON.stringify(playwrightUrl)};
    import { withHealthService } from ${JSON.stringify(fixtureUrl)};
    test('intentional worker SIGKILL', async ({page}) => {
      await withHealthService(page, async () => { process.kill(process.pid, 'SIGKILL'); }, undefined, { scratchRoot: ${JSON.stringify(scratch)} });
    });
    test('replacement worker opens fixture', async ({page}) => {
      const proxy = 'http://127.0.0.1:' + process.env.PATRICK_OVERVIEW_PROXY_PORT;
      await expect.poll(async () => (await fetch(proxy + '/api/v1/session')).status).toBe(503);
      await withHealthService(page, async () => {
        expect((await fetch(proxy + '/api/v1/session')).status).toBe(401);
      }, undefined, { scratchRoot: ${JSON.stringify(scratch)} });
    });`);
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0' };
    delete env.NO_COLOR;
    const result = spawnSync(process.execPath, [cli, 'test', '--config', join(root, 'worker-probe.config.mts'),
      '--workers=1', '--output=' + join(root, 'output'), '--reporter=line'], { env, encoding: 'utf8', timeout: 35_000 });
    const output = result.stdout + result.stderr;
    expect(result.status, output).toBe(1);
    expect(output).toContain('signal=SIGKILL');
    expect(output).toContain('1 failed');
    expect(output).toContain('1 passed');
    expect(output).not.toContain('EADDRINUSE');
    expect(readdirSync(scratch).filter(name => name.startsWith('patrick-settings-overview-'))).toHaveLength(1);
    const { directory } = JSON.parse(readFileSync(transport, 'utf8')) as { directory: string };
    expect(existsSync(directory)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('TCP transport rejects unregistered, invalid, oversized and idle handshakes', async ({ page }) => {
  const proxy = `http://127.0.0.1:${process.env.PATRICK_OVERVIEW_PROXY_PORT}`;
  const controlPort = Number(process.env.PATRICK_OVERVIEW_CONTROL_PORT);
  expect((await fetch(proxy + '/api/v1/session')).status).toBe(503);
  const probe = (port: number, payload?: string) => new Promise<string>((resolve, reject) => {
    const connection = createConnection({ host: '127.0.0.1', port });
    let response = '';
    const timer = setTimeout(() => { connection.destroy(); reject(new Error('Handshake did not close')); }, 5_000);
    connection.on('data', chunk => { response += chunk.toString(); });
    connection.once('connect', () => { if (payload !== undefined) connection.write(payload); });
    connection.once('error', () => {});
    connection.once('close', () => { clearTimeout(timer); resolve(response); });
  });
  const fakeRegistration = '1:12345:' + '0'.repeat(64) + ':' + '0'.repeat(64) + '\n';
  expect(await probe(controlPort, fakeRegistration)).toBe('');
  expect((await fetch(proxy + '/api/v1/session')).status).toBe(503);
  await withHealthService(page, async ({ backendPort, requests }) => {
    expect(backendPort).toBeGreaterThan(0);
    expect(await probe(backendPort, '0'.repeat(64) + ':' + '0'.repeat(64) + '\n')).toBe('');
    expect(await probe(backendPort, 'x'.repeat(131))).toBe('');
    expect(await probe(backendPort)).toBe('');
    const elapsed = await new Promise<number>((resolve, reject) => {
      const started = Date.now();
      const connection = createConnection({ host: '127.0.0.1', port: backendPort });
      const slow = setInterval(() => connection.write('a'), 400);
      const deadline = setTimeout(() => { connection.destroy(); reject(new Error('Slow handshake exceeded its deadline')); }, 3_500);
      connection.once('error', () => {});
      connection.once('close', () => { clearInterval(slow); clearTimeout(deadline); resolve(Date.now() - started); });
    });
    expect(elapsed).toBeLessThan(3_200);
    expect(requests).toEqual([]);
    expect((await fetch(proxy + '/api/v1/session')).status).toBe(401);
  });
  await expect.poll(async () => (await fetch(proxy + '/api/v1/session')).status).toBe(503);
});


test('proxy sends no HTTP to an impostor backend with an invalid server proof', async ({ page }) => {
  const proxy = `http://127.0.0.1:${process.env.PATRICK_OVERVIEW_PROXY_PORT}`;
  await withHealthService(page, async service => {
    await service.stopBackend();
    let wire = '';
    const impostor = createNetServer(connection => {
      connection.on('data', chunk => { wire += chunk.toString(); connection.write('0'.repeat(64) + '\n'); });
    });
    await new Promise<void>((resolve, reject) => { impostor.once('error', reject); impostor.listen(service.backendPort, '127.0.0.1', resolve); });
    try {
      expect((await fetch(proxy + '/synthetic-private-marker')).status).toBe(503);
      expect(wire.length).toBe(130);
      expect(wire.includes('GET ')).toBe(false);
      expect(wire.includes('synthetic-private-marker')).toBe(false);
    } finally { await new Promise<void>((resolve, reject) => impostor.close(error => error ? reject(error) : resolve())); }
  });
});

async function openBrowserSse(page: Page) {
  const document = await page.goto('/api/v1/system/health?domain=personal');
  expect(document?.status()).toBe(200);
  return page.evaluate(async () => {
    const health = await fetch('/api/v1/system/health?domain=personal');
    const snapshot = await health.json();
    const preferences = await fetch('/api/v1/preferences');
    const preferencesBody = await preferences.json();
    const events = await fetch('/api/v1/events?domain=personal&after=' + encodeURIComponent(snapshot.stream_cursor));
    if (!events.body) throw new Error('Missing SSE body');
    const reader = events.body.getReader();
    const first = await reader.read();
    (globalThis as typeof globalThis & { t24SseReader: ReadableStreamDefaultReader<Uint8Array> }).t24SseReader = reader;
    return { health: health.status, preferences: preferences.status, mode: preferencesBody.data.mode,
      events: events.status, firstChunk: !first.done };
  });
}

async function browserSseCompletion(page: Page) {
  return page.evaluate(async () => {
    const reader = (globalThis as typeof globalThis & { t24SseReader: ReadableStreamDefaultReader<Uint8Array> }).t24SseReader;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), 3_000); });
    const completion = (async () => {
      try { while (!(await reader.read()).done) { /* Drain any already buffered events. */ } return 'done' as const; }
      catch { return 'error' as const; }
    })();
    try { return await Promise.race([completion, timeout]); }
    finally { clearTimeout(timer); }
  });
}

for (const ending of ['abrupt backend close', 'graceful backend close', 'browser cancellation'] as const) {
  test('real same-origin SSE handles ' + ending + ' and cleans up', async ({ page }) => {
    const scratch = mkdtempSync(join(tmpdir(), 'p24-sse-cleanup-'));
    let cleanup: { databaseOpen: boolean; runtimeStatus: string; serviceListening: boolean } | undefined;
    try {
      await withHealthService(page, async service => {
        expect(await openBrowserSse(page)).toEqual({ health: 200, preferences: 200, mode: 'system', events: 200, firstChunk: true });
        if (ending === 'abrupt backend close') {
          await service.stopBackend();
          expect(['done', 'error']).toContain(await browserSseCompletion(page));
          expect(await page.evaluate(async () => (await fetch('/api/v1/system/health?domain=personal')).status)).toBe(503);
        } else {
          if (ending === 'graceful backend close') {
            service.disconnectEvents();
            expect(await browserSseCompletion(page)).toBe('done');
          } else {
            const done = await page.evaluate(async () => {
              const reader = (globalThis as typeof globalThis & { t24SseReader: ReadableStreamDefaultReader<Uint8Array> }).t24SseReader;
              await reader.cancel();
              return (await reader.read()).done;
            });
            expect(done).toBe(true);
          }
          const after = await page.evaluate(async () => {
            const health = await fetch('/api/v1/system/health?domain=personal');
            const preferences = await fetch('/api/v1/preferences');
            return { health: health.status, snapshot: (await health.json()).scope.data_domain,
              preferences: preferences.status, mode: (await preferences.json()).data.mode };
          });
          expect(after).toEqual({ health: 200, snapshot: 'personal', preferences: 200, mode: 'system' });
        }
        const reads = service.requests.filter(request => ['/api/v1/system/health', '/api/v1/preferences', '/api/v1/events'].includes(request.path));
        expect(reads.length).toBeGreaterThanOrEqual(4);
        expect(reads.every(request => request.method === 'GET' && request.status === 200 && request.hasCookie && !request.hasAuthorization)).toBe(true);
      }, { freshness: 'fresh', at: '2026-11-17T05:00:00.000Z', facts: overviewFacts },
      { scratchRoot: scratch, onCleanup: result => { cleanup = result; } });
      expect(cleanup).toEqual({ databaseOpen: false, runtimeStatus: 'closed', serviceListening: false });
      expect(readdirSync(scratch)).toEqual([]);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
}

test('idle authenticated SSE forwards headers before its first event', async ({ page }) => {
  const scratch = mkdtempSync(join(tmpdir(), 'p24-sse-headers-'));
  let cleanup: { databaseOpen: boolean; runtimeStatus: string; serviceListening: boolean } | undefined;
  try {
    await withHealthService(page, async service => {
      const target = 'http://127.0.0.1:' + process.env.PATRICK_OVERVIEW_PROXY_PORT;
      const cookie = (await page.context().cookies('http://localhost')).find(value => value.name === 'patrick_session');
      expect(cookie).toBeTruthy();
      const headers = { cookie: cookie!.name + '=' + cookie!.value };
      const health = await fetch(target + '/api/v1/system/health?domain=personal', { headers });
      expect(health.status).toBe(200);
      const snapshot = await health.json() as { stream_cursor: string };
      const response = fetch(target + '/api/v1/events?domain=personal&after=' + encodeURIComponent(snapshot.stream_cursor),
        { headers, signal: AbortSignal.timeout(3_000) });
      await expect.poll(() => service.requests.filter(request => request.path === '/api/v1/events' && request.status === 200).length)
        .toBeGreaterThan(0);
      const events = await response;
      expect(events.status).toBe(200);
      expect(events.headers.get('content-type')).toContain('text/event-stream');
      expect(events.headers.get('cache-control')).toBe('no-cache, no-transform');
      expect(events.headers.get('x-accel-buffering')).toBe('no');
      await events.body!.cancel();
      const denied = await fetch(target + '/api/v1/session');
      expect(denied.status).toBe(401);
      expect((await denied.text()).length).toBeGreaterThan(0);
      const preferences = await fetch(target + '/api/v1/preferences', { headers });
      expect(preferences.status).toBe(200);
      expect(preferences.headers.get('content-type')).toContain('application/json');
      expect((await preferences.json() as { data: { mode: string } }).data.mode).toBe('system');
      expect(service.requests.filter(request => request.path === '/api/v1/events')
        .every(request => request.hasCookie && !request.hasAuthorization)).toBe(true);
    }, { freshness: 'fresh', at: '2026-11-17T05:00:00.000Z', facts: overviewFacts },
    { scratchRoot: scratch, onCleanup: result => { cleanup = result; } });
    expect(cleanup).toEqual({ databaseOpen: false, runtimeStatus: 'closed', serviceListening: false });
    expect(readdirSync(scratch)).toEqual([]);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('same-origin Vite forwards idle SSE headers before its first event', async ({ page }) => {
  await withHealthService(page, async service => {
    expect((await page.goto('/api/v1/system/health?domain=personal'))?.status()).toBe(200);
    const received = page.evaluate(async () => {
      const health = await fetch('/api/v1/system/health?domain=personal');
      const snapshot = await health.json();
      try {
        const events = await fetch('/api/v1/events?domain=personal&after=' + encodeURIComponent(snapshot.stream_cursor),
          { signal: AbortSignal.timeout(3_000) });
        const result = { status: events.status, contentType: events.headers.get('content-type'),
          cacheControl: events.headers.get('cache-control'), buffering: events.headers.get('x-accel-buffering') };
        await events.body?.cancel();
        return result;
      } catch (error) { return { error: (error as Error).name }; }
    });
    await expect.poll(() => service.requests.filter(request => request.path === '/api/v1/events' && request.status === 200).length)
      .toBeGreaterThan(0);
    expect(await received).toEqual({ status: 200, contentType: 'text/event-stream; charset=utf-8',
      cacheControl: 'no-cache, no-transform', buffering: 'no' });
    expect(service.requests.filter(request => request.path === '/api/v1/events')
      .every(request => request.hasCookie && !request.hasAuthorization)).toBe(true);
  }, { freshness: 'fresh', at: '2026-11-17T05:00:00.000Z', facts: overviewFacts });
});

test('same-origin Vite preserves ordinary success and error responses', async ({ page }) => {
  const scratch = mkdtempSync(join(tmpdir(), 'p24-vite-http-'));
  let cleanup: { databaseOpen: boolean; runtimeStatus: string; serviceListening: boolean } | undefined;
  try {
    await withHealthService(page, async service => {
      expect((await page.goto('/api/v1/system/health?domain=personal'))?.status()).toBe(200);
      const result = await page.evaluate(async () => {
        const preferences = await fetch('/api/v1/preferences');
        const missing = await fetch('/api/v1/this-route-does-not-exist');
        return { status: preferences.status, type: preferences.headers.get('content-type'),
          mode: (await preferences.json()).data.mode, missingStatus: missing.status, missingBody: await missing.text() };
      });
      expect(result.status).toBe(200);
      expect(result.type).toContain('application/json');
      expect(result.mode).toBe('system');
      expect(result.missingStatus).toBe(404);
      expect(result.missingBody.length).toBeGreaterThan(0);
      await page.context().clearCookies();
      const denied = await page.evaluate(async () => {
        const response = await fetch('/api/v1/session');
        return { status: response.status, type: response.headers.get('content-type'), body: await response.text() };
      });
      expect(denied.status).toBe(401);
      expect(denied.type).toContain('application/json');
      expect(denied.body.length).toBeGreaterThan(0);
      expect(service.requests.some(request => request.path === '/api/v1/preferences' && request.status === 200 && request.hasCookie && !request.hasAuthorization)).toBe(true);
      expect(service.requests.some(request => request.path === '/api/v1/session' && request.status === 401 && !request.hasCookie && !request.hasAuthorization)).toBe(true);
    }, { freshness: 'fresh', at: '2026-11-17T05:00:00.000Z', facts: overviewFacts },
    { scratchRoot: scratch, onCleanup: result => { cleanup = result; } });
    expect(cleanup).toEqual({ databaseOpen: false, runtimeStatus: 'closed', serviceListening: false });
    expect(readdirSync(scratch)).toEqual([]);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('same-origin Vite returns 503 when an in-flight GET loses its backend', async ({ page }) => {
  const scratch = mkdtempSync(join(tmpdir(), 'p24-vite-inflight-'));
  let cleanup: { databaseOpen: boolean; runtimeStatus: string; serviceListening: boolean } | undefined;
  try {
    await withHealthService(page, async service => {
      expect((await page.goto('/api/v1/system/health?domain=personal'))?.status()).toBe(200);
      const held = service.holdNextSession();
      try {
        const pending = page.evaluate(async () => (await fetch('/api/v1/session')).status);
        await held.ready;
        await service.stopBackend();
        held.release();
        expect(await pending).toBe(503);
      } finally { held.release(); }
    }, { freshness: 'fresh', at: '2026-11-17T05:00:00.000Z', facts: overviewFacts },
    { scratchRoot: scratch, onCleanup: result => { cleanup = result; } });
    expect(cleanup).toEqual({ databaseOpen: false, runtimeStatus: 'closed', serviceListening: false });
    expect(readdirSync(scratch)).toEqual([]);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
