import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { createCredentialStore } from '@patrick/host';
import { connectVault, requireVault } from '@patrick/integrations/vault/connection';
import { openDatabase } from '@patrick/storage';
import { createServiceRuntime } from '../../apps/service/src/app.js';
import { issueCallerSession } from '../../apps/service/src/auth.js';

export const stamp = '2026-11-17T05:00:00.000Z';
export const device = 't24-device';

export async function withVault(page: Page, vault: string, run: (fixture: {
  db: ReturnType<typeof openDatabase>;
  state: () => { status: string; epoch: number; revision: number; receipts: number; changes: number; vaultEvents: number };
  requests: Array<{ method: string; path: string; status: number }>;
}) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t24-vault-'));
  const databasePath = join(dir, 'settings.sqlite');
  const credentialDirectory = join(dir, 'credentials');
  const now = () => new Date(stamp);
  const db = openDatabase(databasePath);
  let runtime: ReturnType<typeof createServiceRuntime> | undefined;
  try {
    db.prepare("INSERT INTO accounts VALUES ('owner',1,1,?)").run(stamp);
    const root = join(dir, 'Vault');
    mkdirSync(root);
    await connectVault(db, { accountId: 'owner', deviceId: device, vaultId: vault, root,
      domain: 'personal', captureHost: hostname(), now: stamp });
    const { token } = issueCallerSession(db, { accountId: 'owner', callerId: 'web', domain: 'personal', permissions: ['owner'] },
      now, createCredentialStore(credentialDirectory, now));
    await page.context().addCookies([{ name: 'patrick_session', value: token, url: 'http://localhost', httpOnly: true, sameSite: 'Strict' }]);
    runtime = createServiceRuntime({ databasePath, credentialDirectory, now });
    const { app } = runtime;
    const requests: Array<{ method: string; path: string; status: number }> = [];
    await page.route('**/api/v1/**', async route => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      // T17 isolates SSE; every settings, command and incident read/write reaches the real service.
      if (path === '/api/v1/events') return route.fulfill({ status: 503, body: '' });
      const response = await app.request(req.url(), { method: req.method(), headers: await req.allHeaders(), body: req.postData() });
      const body = await response.text();
      requests.push({ method: req.method(), path, status: response.status });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
    });
    function state() {
      const current = requireVault(db, vault);
      return { status: current.status, epoch: current.connection_epoch, revision: current.config_revision,
        receipts: Number(db.prepare('SELECT COUNT(*) FROM control_receipts').pluck().get()),
        changes: Number(db.prepare('SELECT COUNT(*) FROM settings_changes').pluck().get()),
        vaultEvents: Number(db.prepare('SELECT COUNT(*) FROM domain_events WHERE aggregate_id=?').pluck().get(vault)) };
    }
    await run({ db, state, requests });
  } finally {
    try {
      await page.unrouteAll({ behavior: 'wait' });
      if (runtime) { runtime.stop(); await runtime.drain(); }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
