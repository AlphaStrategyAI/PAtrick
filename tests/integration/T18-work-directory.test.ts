import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { canonicalPayload, type Json } from '@patrick/contracts';
import { createCredentialStore } from '@patrick/host';
import { createBlobStore, openDatabase } from '@patrick/storage';
import { createSourceRegistry } from '@patrick/integrations/sources/registry';
import { issueCallerSession, mountAuthRoutes, ORIGIN, RP_ID, runWithAuth } from '../../apps/service/src/auth.js';
import { mountControlRoutes } from '../../apps/service/src/control.js';
import { mountSettingsRoutes } from '../../apps/service/src/routes/settings.js';
import { createSettingsChanges } from '../../apps/service/src/settings/changes.js';
import { sourceSettingsHandlers } from '../../apps/service/src/settings/sources.js';
import { mountSourceRoutes } from '../../apps/service/src/routes/sources.js';

const now = () => new Date('2026-11-19T03:00:00.000Z');
const own = { account_id: 'owner', caller_id: 'web', data_domain: 'personal', permission_epoch: 1 };
type Draft = { operation: string; domain: string; target: string; input: Json };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-work-directory-'));
  const root = join(dir, 'work');
  mkdirSync(root);
  writeFileSync(join(root, 'note.md'), '# first note\n');
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'second.md'), '# second note\n');
  const db = openDatabase(join(dir, 'service.sqlite'));
  const credentials = createCredentialStore(join(dir, 'credentials'), now);
  for (const account of ['owner', 'other']) db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(account, 1, 1, now().toISOString());
  const session = (accountId: string, domain: string, permissions: string[]) =>
    issueCallerSession(db, { accountId, callerId: 'web', domain, permissions }, now, credentials).authorization;
  const authorization = session('owner', 'personal', ['owner']);
  const other = session('other', 'personal', ['owner']);
  const registry = createSourceRegistry(db, { blobs: createBlobStore(join(dir, 'blobs')), now: () => now().toISOString() });
  const app = new Hono();
  app.use('*', async (_c, next) => runWithAuth({ db, now, credentials }, next));
  mountSourceRoutes(app, () => ({ db, now, registry }));
  mountAuthRoutes(app);
  mountControlRoutes(app);
  const engine = createSettingsChanges({ db, now, handlers: sourceSettingsHandlers({ db, now, credentials, registry }) });
  mountSettingsRoutes(app, () => ({ db, now, credentials, engine }));
  const post = (route: string, client_request_id: string, payload: Json, expected_revision: number | null = null,
    auth = authorization) =>
    app.request('/api/v1' + route, { method: 'POST', headers: { authorization: auth, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ payload, payload_hash: createHash('sha256').update(canonicalPayload(payload)).digest('hex'),
        client_request_id, expected_revision }) });
  const detect = (client_request_id: string, target: string, auth = authorization) => {
    const payload = { target, type: 'directory', request_scope: own };
    return app.request('/api/v1/sources/detect', { method: 'POST',
      headers: { authorization: auth, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ payload, payload_hash: createHash('sha256').update(canonicalPayload(payload)).digest('hex'),
        expected_revision: null, client_request_id }) });
  };
  const challenge = () => app.request('/api/v1/auth/challenge', { method: 'POST',
    headers: { authorization, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ rp_id: RP_ID }) });
  const get = (path: string) => app.request(path, { headers: { authorization } });

  /** Runs the three steps of a settings change and returns the applied receipt. */
  async function change(draft: Draft, expectedRevision: number | null = null) {
    const validation = await post('/settings/validations', 'validate-' + draft.operation + '-' + expectedRevision, draft,
      expectedRevision);
    expect(validation.status).toBe(200);
    const { data: { validation_id } } = await validation.json();
    const { challenge_id } = await (await challenge()).json();
    const staged = await post('/settings/control-proposals', 'prepare-' + draft.operation + '-' + expectedRevision,
      { draft, validation_id, challenge_id }, expectedRevision);
    expect(staged.status).toBe(200);
    const { data: { proposal_id, proposal_hash, base_revision } } = await staged.json();
    const confirmed = await app.request('/api/v1/control-proposals/' + proposal_id + '/confirm', { method: 'POST',
      headers: { authorization, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { proposal_hash, challenge_id },
        payload_hash: createHash('sha256').update(canonicalPayload({ proposal_hash, challenge_id })).digest('hex'),
        client_request_id: 'confirm-' + draft.operation + '-' + expectedRevision, expected_revision: base_revision }) });
    expect(confirmed.status).toBe(202);
    const control = await get((await confirmed.json()).receipt_url);
    const { data: { control_receipt_id } } = await control.json();
    const applied = await post('/settings/changes', 'apply-' + draft.operation + '-' + expectedRevision,
      { draft, validation_id, control_receipt_id }, expectedRevision);
    expect(applied.status).toBe(202);
    const receipt = await get((await applied.json()).receipt_url);
    return receipt.json();
  }

  return { db, registry, root, detect, get, post, change, other,
    dispose() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('a work directory preview resolves the approved root and never enables a source', async () => {
  const fx = setup();
  try {
    const preview = await fx.detect('preview-root', fx.root);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ data: { type: 'directory', target: realpathSync(fx.root),
      duplicate_source_id: null, allowed_urls: [], samples: expect.any(Array) } });
    expect(fx.db.prepare('SELECT 1 FROM source_configs').get()).toBeUndefined();
  } finally { fx.dispose(); }
});

test('a preview of another account cannot be used to register a work directory', async () => {
  const fx = setup();
  try {
    const { data: { preview_id } } = await (await fx.detect('preview-owner', fx.root)).json();
    const draft: Draft = { operation: 'enable_work_directory', domain: 'personal', target: preview_id, input: null };
    const validation = await fx.post('/settings/validations', 'validate-foreign', draft, null, fx.other);
    expect(validation.status).toBe(403);
  } finally { fx.dispose(); }
});

test('the settings command registers the work directory and reports an independent receipt', async () => {
  const fx = setup();
  try {
    const { data: { preview_id, target } } = await (await fx.detect('preview-enable', fx.root)).json();
    const draft: Draft = { operation: 'enable_work_directory', domain: 'personal', target: preview_id, input: null };
    const receipt = await fx.change(draft);
    expect(receipt.data).toMatchObject({ verified: true, applied_revision: 1,
      effects: [{ item: 'source_enable', outcome: 'applied' }] });
    expect(fx.db.prepare('SELECT connector_type,normalized_target,status,config_revision FROM source_configs').get())
      .toEqual({ connector_type: 'directory', normalized_target: target, status: 'enabled', config_revision: 1 });
  } finally { fx.dispose(); }
});

test('one fixed operation pauses, resumes, retimes and disconnects the work directory', async () => {
  const fx = setup();
  try {
    const { data: { preview_id } } = await (await fx.detect('preview-change', fx.root)).json();
    await fx.change({ operation: 'enable_work_directory', domain: 'personal', target: preview_id, input: null });
    const source = fx.db.prepare('SELECT source_id FROM source_configs').get() as { source_id: string };
    const revision = () => (fx.db.prepare('SELECT config_revision FROM source_configs').get() as { config_revision: number }).config_revision;
    const draft = (action: string, frequency?: string): Draft => ({ operation: 'change_work_directory', domain: 'personal',
      target: source.source_id, input: frequency ? { action, frequency } : { action } });

    expect((await fx.change(draft('pause'), revision())).data).toMatchObject({ verified: true, effects: [{ item: 'source_pause', outcome: 'applied' }] });
    expect(fx.db.prepare('SELECT status FROM source_configs').get()).toEqual({ status: 'paused' });
    expect((await fx.change(draft('resume'), revision())).data).toMatchObject({ verified: true, effects: [{ item: 'source_resume', outcome: 'applied' }] });
    expect(fx.db.prepare('SELECT status FROM source_configs').get()).toEqual({ status: 'enabled' });
    expect((await fx.change(draft('modify', '1h'), revision())).data).toMatchObject({ verified: true, effects: [{ item: 'source_modify', outcome: 'applied' }] });
    expect(fx.db.prepare('SELECT frequency FROM source_configs').get()).toEqual({ frequency: '1h' });
    expect((await fx.change(draft('disconnect'), revision())).data).toMatchObject({ verified: true, effects: [{ item: 'source_disconnect', outcome: 'applied' }] });
    expect(fx.db.prepare('SELECT status FROM source_configs').get()).toEqual({ status: 'disconnected' });
  } finally { fx.dispose(); }
});

test('a work directory change without a registered source is refused', async () => {
  const fx = setup();
  try {
    const draft: Draft = { operation: 'change_work_directory', domain: 'personal', target: 'src_missing', input: { action: 'pause' } };
    const validation = await fx.post('/settings/validations', 'validate-missing', draft);
    expect(validation.status).toBe(403);
  } finally { fx.dispose(); }
});
