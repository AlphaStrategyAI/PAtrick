import type { Context, Hono } from 'hono';
import type { SqliteDatabase } from '@patrick/storage';
import { snapshot } from '../auth.js';
import { ApiError } from '../errors.js';
import type { createVaultApi } from '@patrick/integrations/vault/drafts';
import { handle, requirePermission, routeId } from './http.js';

type VaultApi = ReturnType<typeof createVaultApi>;
type Ready = () => { db: SqliteDatabase; api: VaultApi; now: () => Date };

export function mountVaultRoutes(app: Hono, ready: Ready): void {
  app.get('/api/v1/vaults', (c) => handle(c, () => listVaults(c, ready)));
  app.get('/api/v1/vaults/:id/connection', (c) => handle(c, () => readConnection(c, ready)));
}

async function listVaults(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'vault.read');
  const { db, now } = ready();
  const items = db.prepare(`SELECT vault_id, status, data_domain FROM vaults
    WHERE account_id = ? ORDER BY vault_id`).all(principal.account_id) as { vault_id: string; status: string; data_domain: string }[];
  return c.json(snapshot(principal, { items: items.filter((item) => principal.domains.includes(item.data_domain)) }, now(), db));
}

async function readConnection(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'vault.read');
  const { db, api, now } = ready();
  const vaultId = routeId(c.req.param('id'));
  const vault = db.prepare('SELECT account_id, data_domain FROM vaults WHERE vault_id = ?').get(vaultId) as {
    account_id: string;
    data_domain: string;
  } | undefined;
  if (!vault || vault.account_id !== principal.account_id || !principal.domains.includes(vault.data_domain)) {
    throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  }
  const client = db.prepare('SELECT device_id FROM vault_clients WHERE vault_id = ? ORDER BY mapping_revision DESC LIMIT 1').get(vaultId) as {
    device_id: string;
  } | undefined;
  const connection = await api.inspectVault(client?.device_id ?? 'unmapped', vaultId);
  return c.json(snapshot(principal, connection, now(), db));
}
