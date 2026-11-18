import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { createCredentialStore } from '@patrick/host';
import { createBlobStore, openDatabase } from '@patrick/storage';
import { createSourceRegistry } from '@patrick/integrations/sources/registry';
import { sourceEntrySchema } from '@patrick/contracts/resources';
import { issueCallerSession, runWithAuth } from '../../apps/service/src/auth.js';
import { mountSourceRoutes } from '../../apps/service/src/routes/sources.js';

test('directory reader capability is separately readable without changing strict source responses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-block-api-'));
  const db = openDatabase(join(root, 'state.sqlite'));
  const now = () => new Date('2026-11-17T05:20:00.000Z');
  try {
    db.prepare("INSERT INTO accounts VALUES ('owner',1,1,?)").run(now().toISOString());
    const credentials = createCredentialStore(join(root, 'credentials'), now);
    const authorization = issueCallerSession(db, { accountId: 'owner', callerId: 'web', domain: 'personal', permissions: ['owner'] }, now, credentials).authorization;
    db.prepare(`INSERT INTO source_configs VALUES ('legacy','owner','personal','directory','/synthetic/old','/synthetic/old',
      '{}','[]',NULL,'poll','none',0,1,'enabled',1,'1.0',?,?)`).run(now().toISOString(), now().toISOString());
    const registry = createSourceRegistry(db, { blobs: createBlobStore(join(root, 'blobs')) });
    const app = new Hono();
    app.use('*', async (_c, next) => runWithAuth({ db, now, credentials }, next));
    mountSourceRoutes(app, () => ({ db, now, registry }));
    const headers = { authorization };
    const list = await app.request('/api/v1/sources?domain=personal', { headers });
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(sourceEntrySchema.parse(listed.data.items[0])).toMatchObject({ source_id: 'legacy', status: 'enabled' });
    const detail = await app.request('/api/v1/sources/legacy?domain=personal', { headers });
    expect(sourceEntrySchema.parse((await detail.json()).data)).toEqual(listed.data.items[0]);
    const capability = await app.request('/api/v1/source-reader-capabilities?domain=personal', { headers });
    expect(capability.status).toBe(200);
    expect((await capability.json()).data).toEqual({ directory: { state: 'blocked', reason: 'DIRECTORY_READER_UNAVAILABLE' } });
    expect((await app.request('/api/v1/source-reader-capabilities?domain=other', { headers })).status).toBe(403);
    expect((await app.request('/api/v1/source-reader-capabilities?domain=personal')).status).toBe(401);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
