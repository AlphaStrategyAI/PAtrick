import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { canonicalPayload, type Json } from '@patrick/contracts';
import { createCredentialStore } from '@patrick/host';
import { openDatabase } from '@patrick/storage';
import { createApp } from '../../apps/service/src/app.js';
import { observeWorkStop } from '../../apps/service/src/work-stop.js';
import { issueCallerSession, ORIGIN } from '../../apps/service/src/auth.js';
import { createDelegationApi } from '../../packages/domain/src/delegation.js';

test('work control resolves its own version and exact once-only receipt; unconfigured stop does not pretend success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t15-control-'));
  const databasePath = join(dir, 'data.sqlite');
  const credentialDirectory = join(dir, 'credentials');
  const db = openDatabase(databasePath);
  const now = () => new Date('2026-11-17T00:00:00.000Z');
  const lifecycle = new AbortController();
  const account = 't15-owner';
  const domain = 'personal';
  const workId = 'W-015';
  try {
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(account, 1, 1, now().toISOString());
    const credentials = createCredentialStore(credentialDirectory, now);
    const issue = (callerId: string, permissions: string[]) =>
      issueCallerSession(db, { accountId: account, callerId, domain, permissions }, now, credentials).authorization;
    const authorized = issue('web', ['owner']);
    const readonly = issue('reader', ['work.read']);
    const principal = { account_id: account, caller_id: 'web', auth_epoch: 1, domains: [domain], operations: ['owner'] };
    const service = createDelegationApi(db, principal, { domain, now });
    const baseline = { type_id: 't15-work', domains: [domain], actions: ['judge'], resources: ['work'], effects: [],
      risk: 'low', level: 'L1' as const, budget_micros: 10_000 };
    await service.registerMandateType({ ...baseline, config_version: 1 });
    await service.openMandate({ ...baseline, mandate_id: 'M-015', expires_at: '2026-12-01T00:00:00.000Z' });
    await service.openWork({ work_id: workId, generation: 4, mandate_id: 'M-015', phase: 'judgment', next_action: 'judge', budget_micros: 1 });
    const app = createApp({ databasePath, credentialDirectory, now });
    const url = '/api/v1/work/' + workId + '/controls';
    const get = (path: string, auth = authorized) => app.request(path, { headers: { authorization: auth } });
    const post = (id: string, revision: number, payload: Json, auth = authorized) => app.request(url, {
      method: 'POST', headers: { authorization: auth, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ client_request_id: id, expected_revision: revision, payload,
        payload_hash: createHash('sha256').update(canonicalPayload(payload)).digest('hex') }),
    });
    const cold = await get('/api/v1/work/' + workId);
    expect(cold.status).toBe(503);
    expect(await cold.json()).toMatchObject({ code: 'UNAVAILABLE', params: { reason: 'projection_syncing' }, retryable: true });
    expect((await get('/api/v1/work/nonexistent')).status).toBe(403);
    const available = await get(url);
    expect(available.status).toBe(200);
    expect(await available.json()).toMatchObject({ data: { work_id: workId, generation: 4, control_revision: 0, actions: ['pause'] } });
    expect(await (await get(url, readonly)).json()).toMatchObject({ data: { actions: [] } });
    expect((await post('unauthorized', 0, { generation: 4, type: 'pause' }, readonly)).status).toBe(403);
    const pause = () => post('lost-pause', 0, { generation: 4, type: 'pause' });
    const first = await pause();
    expect(first.status).toBe(202);
    const accepted = await first.json() as { receipt_url: string; command_id: string };
    expect(accepted.receipt_url).toMatch(/^\/api\/v1\/work\/W-015\/controls\/wcr_/u);
    expect(await (await pause()).json()).toEqual(accepted);
    expect(fxCount(db)).toBe(1);
    expect((await get(accepted.receipt_url, readonly)).status).toBe(403);
    const result = await get(accepted.receipt_url);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ data: { work_id: workId, generation: 4, type: 'pause', state: 'paused', revision: 1 } });
    expect((await post('stale-cas', 0, { generation: 4, type: 'resume' })).status).toBe(409);
    expect((await post('missing-stop', 1, { generation: 4, type: 'stop' })).status).toBe(503);
    expect(fxCount(db)).toBe(1);
    const stopInput = { generation: 4, type: 'stop' };
    const submit = (server: ReturnType<typeof createApp>) => server.request(url, {
      method: 'POST', headers: { authorization: authorized, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ client_request_id: 'atomic-stop', expected_revision: 1, payload: stopInput,
        payload_hash: createHash('sha256').update(canonicalPayload(stopInput)).digest('hex') }),
    });
    const idleSupervisor = { signal: lifecycle.signal, reconcile: vi.fn(async () => null) };
    const withSupervisor = createApp({ databasePath, credentialDirectory, now, workStopSupervisor: idleSupervisor });
    db.exec(`CREATE TRIGGER fail_stop_command BEFORE INSERT ON command_records
      WHEN NEW.operation='controlWork' BEGIN SELECT RAISE(ABORT,'fixture-write-failure'); END`);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { expect((await submit(withSupervisor)).status).toBe(503); } finally { logged.mockRestore(); }
    db.exec('DROP TRIGGER fail_stop_command');
    expect(fxCount(db)).toBe(1);
    expect(db.prepare("SELECT 1 FROM outbox WHERE destination='work-stop-supervisor'").get()).toBeUndefined();
    expect(idleSupervisor.reconcile).not.toHaveBeenCalled();

    const stop = await submit(withSupervisor);
    expect(stop.status).toBe(202);
    const stopping = await stop.json() as { receipt_url: string };
    expect(await (await get(stopping.receipt_url)).json()).toMatchObject({ data: { state: 'processing' } });
    const never = vi.fn(() => new Promise<never>(() => {}));
    const pendingSeq = await observeWorkStop(db, { reconcile: never }, now, 0, 20);
    expect(pendingSeq).toBeGreaterThan(0);
    expect(never).toHaveBeenCalledTimes(1);
    expect(await (await get(stopping.receipt_url)).json()).toMatchObject({ data: { state: 'processing' } });
    const readback = vi.fn().mockResolvedValueOnce({ process_tree_stopped: true, effects_reconciled: false })
      .mockResolvedValueOnce({ process_tree_stopped: true, effects_reconciled: true });
    expect(await observeWorkStop(db, { reconcile: readback }, now)).toBeGreaterThan(0);
    expect(await (await get(stopping.receipt_url)).json()).toMatchObject({ data: { state: 'processing' } });
    expect(await observeWorkStop(db, { reconcile: readback }, now)).toBeGreaterThan(0);
    expect(await (await get(stopping.receipt_url)).json()).toMatchObject({ data: { state: 'stopped' } });
    expect(readback.mock.calls[0][0]).toMatchObject({ accountId: account, dataDomain: domain, workId, generation: 4 });
    expect(readback.mock.calls[0][0]).toEqual(readback.mock.calls[1][0]);
    expect(await observeWorkStop(db, { reconcile: readback }, now)).toBe(0);
    expect((await (await submit(withSupervisor)).json())).toEqual(stopping);
    expect(fxCount(db)).toBe(2);
    lifecycle.abort();
    const shutdown = createApp({ databasePath, credentialDirectory, now, workStopSupervisor: idleSupervisor });
    const inactive = await shutdown.request(url, { headers: { authorization: authorized } });
    expect(await inactive.json()).toMatchObject({ data: { state: 'stopped', actions: [] } });
  } finally {
    lifecycle.abort();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const fxCount = (db: ReturnType<typeof openDatabase>) =>
  (db.prepare('SELECT COUNT(*) AS n FROM work_control_receipts').get() as { n: number }).n;
