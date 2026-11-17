import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { routes } from '@patrick/contracts';
import { openDatabase } from '../../packages/storage/src/database.js';
import { appendDomainEvent } from '../../packages/storage/src/outbox.js';
import { createProjectionCursorCodec } from '../../packages/storage/src/views/cursors.js';
import { createWorkProjection, type WorkFact } from '../../packages/storage/src/views/work.js';
import { deriveWorkBatch } from '../../packages/storage/src/views/work-source.js';
import { createDelegationApi } from '../../packages/domain/src/delegation.js';
import { publishHubEvent, toHubEventBody } from '../../packages/integrations/autoloop/client.js';
import { storeHubView } from '../../packages/integrations/autoloop/observer.js';
import { createCredentialStore } from '../../packages/host/src/credentials.js';
import { createApp } from '../../apps/service/src/app.js';
import { issueCallerSession } from '../../apps/service/src/auth.js';
import { mountWorkProjectionRoutes } from '../../apps/service/src/routes/work.js';
import { mountProjectionEventRoutes } from '../../apps/service/src/routes/events.js';
import { createProductViewService } from '../../apps/service/src/product-views.js';

const codec = createProjectionCursorCodec(Buffer.alloc(32, 7));
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const scope = {
  accountId: 'owner', callerId: 'web', dataDomain: 'personal', permissionEpoch: 1,
  permissionDigest: digest('events.read|work.read'), sessionDigest: digest('session-1'),
};
const window = { epoch: 2, floor: 13, head: 16 };

test('stable-work-and-watermark: a stream cursor only resumes the same authorized retained view', () => {
  const cursor = codec.stream(scope, { epoch: 2, seq: 14 });
  expect(codec.readStream(cursor, scope, window)).toEqual({ epoch: 2, seq: 14 });
  expect(codec.readStream(cursor, { ...scope, dataDomain: 'company' }, window)).toBeNull();
  expect(codec.readStream(cursor, { ...scope, sessionDigest: digest('session-2') }, window)).toBeNull();
  // Changing permissions can shrink visibility without changing the account epoch.
  expect(codec.readStream(cursor, { ...scope, permissionDigest: digest('events.read') }, window)).toBeNull();
  expect(codec.readStream(cursor, { ...scope, permissionEpoch: 2 }, window)).toBeNull();
  expect(codec.readStream(cursor, scope, { ...window, epoch: 3 })).toBeNull();
  expect(codec.readStream(cursor, scope, { ...window, floor: 15 })).toBeNull();
  expect(codec.readStream(cursor, scope, { ...window, head: 13 })).toBeNull();
  const [payload, signature] = cursor.split('.');
  expect(codec.readStream(`${payload}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`, scope, window)).toBeNull();
});

test('paging cannot cross filters or reuse a stream cursor', () => {
  const filter = digest('state=open;sort=updated_at:desc,work_id');
  const cursor = codec.page(scope, { epoch: 2, seq: 16, filter, sortKey: '2026-11-17T04:00:00.000Z', workId: 'W-017' });
  expect(codec.readPage(cursor, scope, window, filter)).toMatchObject({ seq: 16, workId: 'W-017' });
  expect(codec.readPage(cursor, scope, { ...window, head: 17 }, filter)).toBeNull();
  expect(codec.readPage(cursor, scope, window, digest('state=waiting'))).toBeNull();
  expect(codec.readStream(cursor, scope, window)).toBeNull();
});

test('stable-work-and-watermark: a committed projection replays one scoped change after its snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t13-'));
  const db = openDatabase(join(dir, 'view.sqlite'));
  try {
    const projection = createWorkProjection(db, codec);
    const company = { ...scope, dataDomain: 'company' };
    const start = '2026-11-17T04:00:00.000Z';
    const later = '2026-11-17T04:01:00.000Z';
    const work: WorkFact = { work_id: 'W-017', generation: 1, updated_at: start,
      state: 'awaiting_answer', attempt_ids: [8, 12], question_id: 'q-017', delivery_id: null };
    projection.apply(scope, { watermark: { hub_seq: 12, domain_seq: 8 }, at: start, coverage: 'fresh', items: [work] });
    projection.apply(company, { watermark: { hub_seq: 12, domain_seq: 8 }, at: start, coverage: 'fresh', items: [{ ...work, work_id: 'W-company' }] });
    const before = projection.readList(scope, { state: 'open' });
    expect(before.data.items.map(({ work_id }) => work_id)).toEqual(['W-017']);
    expect(before).toMatchObject({ freshness: 'fresh', as_of: start, watermark: { hub_seq: 12, domain_seq: 8 } });
    expect(before.data.counts).toEqual({ open: 1, awaiting_answer: 1, blocked: 0 });

    const delivering: WorkFact = { ...work, state: 'verifying', question_id: null, updated_at: later };
    projection.apply(scope, { watermark: { hub_seq: 13, domain_seq: 9 }, at: later, coverage: 'syncing', items: [delivering] });
    projection.apply(scope, { watermark: { hub_seq: 13, domain_seq: 9 }, at: later, coverage: 'syncing', items: [delivering] });
    const replay = projection.eventsAfter(scope, before.stream_cursor!);
    expect(replay).toMatchObject({ status: 'ok', events: [{ event: { type: 'work.changed', resource_id: 'W-017', resource_revision: 2,
      scope: { data_domain: 'personal' }, watermark: { hub_seq: 13, domain_seq: 9 } } }] });
    if (replay.status !== 'ok') throw new Error('unexpected cursor reset');
    expect(replay.events).toHaveLength(1);
    expect(projection.eventsAfter(scope, replay.events[0].id)).toEqual({ status: 'ok', events: [] });
    expect(projection.eventsAfter(company, before.stream_cursor!)).toEqual({ status: 'reset_required' });
    expect(projection.readList(scope, { state: 'open' })).toMatchObject({ freshness: 'syncing', as_of: start });
    expect(projection.readDetail(scope, 'W-017')?.data.state).toBe('verifying');
    expect(projection.readDetail(scope, 'W-company')).toBeNull();

    projection.archive(scope, 2);
    expect(projection.eventsAfter(scope, before.stream_cursor!)).toEqual({ status: 'reset_required' });
    projection.apply(scope, { watermark: { hub_seq: 10, domain_seq: 7 }, at: later, coverage: 'fresh', items: [work] });
    expect(projection.readDetail(scope, 'W-017')?.data.state).toBe('verifying');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stable-work-and-watermark: only scoped work facts and verified effect receipts prove delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t13-source-'));
  const db = openDatabase(join(dir, 'source.sqlite'));
  try {
    const at = '2026-11-17T04:00:00.000Z';
    const now = () => new Date(at);
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(scope.accountId, 1, 1, at);
    db.prepare(`INSERT INTO vaults (vault_id,source_id,account_id,data_domain,capture_host,root_path,isolation_root,
      root_identity,physical_root,scope_hash,config_revision,connection_epoch,status,schema_version,created_at,updated_at)
      VALUES ('v-17','source-17','owner','personal','host','/private/vault','/private/isolated','dev:inode',
        '/private/vault',?,1,3,'needs_permission','1.0',?,?)`).run('a'.repeat(64), at, at);
    const delegation = createDelegationApi(db, { account_id: scope.accountId, caller_id: scope.callerId, auth_epoch: 1,
      domains: ['personal'], operations: ['owner'] }, { domain: 'personal', now });
    const permissions = { actions: ['judge'], resources: ['work'], effects: [], domains: ['personal'],
      risk: 'low' as const, level: 'L1' as const, budget_micros: 1000 };
    await delegation.registerMandateType({ ...permissions, type_id: 'type', config_version: 1 });
    await delegation.openMandate({ ...permissions, mandate_id: 'mandate', type_id: 'type', expires_at: '2026-11-18T00:00:00.000Z' });
    await delegation.openWork({ work_id: 'W-017', generation: 1, mandate_id: 'mandate', phase: 'judgment', next_action: 'judge', budget_micros: 1000 });
    const upstream = { event_id: 'work-W-017', root: 'W-017', cause: 'source-r4', generation: 1, hops: 0, kind: 'work.requested' as const };
    appendDomainEvent(db, { eventId: upstream.event_id, aggregateId: 'W-017', aggregateVersion: 1,
      accountId: 'owner', dataDomain: 'personal', payload: { type: 'work.requested', work_id: 'W-017', generation: 1 }, destination: 'autoloop' });
    await publishHubEvent(db, { postEvent: async () => ({ event: 42, duplicate: false, routed: ['来源变化'] }) }, upstream, at);
    const event = toHubEventBody(upstream);
    const observed = { hub_seq: 30, cards: [], runs: [8, 12, 13].map((id) => ({ id, rule: '来源变化', state: 'done', attempts: 1,
      summary: '', error: '', events: [{ source: 'patrick', type: event.type, summary: '', subject: id === 13 ? 'unknown-other-scope' : event.subject }] })) };
    storeHubView(db, observed, at);
    expect(deriveWorkBatch(db, scope, now())).toMatchObject({ watermark: { hub_seq: 30, domain_seq: 1 },
      coverage: 'fresh', items: [{ work_id: 'W-017', state: 'researching', attempt_ids: [8, 12], delivery_id: null }],
      health: { connections: { vault: { status: 'needs_permission', revision: 1, epoch: 3 }, feishu: null } } });
    expect(deriveWorkBatch(db, { ...scope, dataDomain: 'company' }, now()).items).toEqual([]);
    expect(deriveWorkBatch(db, { ...scope, dataDomain: 'company' }, now()).health?.connections.vault).toBeNull();
    const initial = createProductViewService(db, now);
    initial.refresh(scope);
    expect(initial.projection.readHealth(scope).freshness).toBe('fresh');
    db.prepare('DELETE FROM hub_snapshots').run();
    initial.refresh(scope);
    expect(initial.projection.readHealth(scope)).toMatchObject({ freshness: 'syncing', as_of: at, watermark: { hub_seq: 30, domain_seq: 1 } });
    storeHubView(db, observed, at);
    initial.refresh(scope);
    const health = initial.projection.readHealth(scope);
    expect(health.data).toMatchObject({ service: 'running', impact: 'vault_needs_permission' });
    expect(routes.find((route) => route.operationId === 'getSystemHealth')?.response.safeParse(health).success).toBe(true);

    appendDomainEvent(db, { eventId: 'work-delivered-without-receipt', aggregateId: 'W-017', aggregateVersion: 1,
      accountId: 'owner', dataDomain: 'personal', payload: { type: 'work.delivered', work_id: 'W-017', generation: 1, intent_id: 'missing' }, destination: 'local' });
    expect(deriveWorkBatch(db, scope, now())).toMatchObject({ coverage: 'syncing',
      watermark: { hub_seq: 30, domain_seq: 2 }, items: [{ state: 'verifying', delivery_id: null }] });
    const restarted = createProductViewService(db, now);
    restarted.refresh(scope);
    expect(restarted.projection.eventsAfter(scope, health.stream_cursor!)).toMatchObject({ status: 'ok',
      events: [{ event: { type: 'work.changed', resource_id: 'W-017', resource_revision: 2 } }] });
    expect(restarted.projection.readHealth(scope).data).toMatchObject({ service: 'unknown', impact: 'projection_syncing' });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a connected stream rechecks work permission and closes when the domain grant is withdrawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t13-http-'));
  const db = openDatabase(join(dir, 'http.sqlite'));
  const stop = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>> | undefined;
  try {
    const time = '2026-11-17T04:00:00.000Z';
    const now = () => new Date(time);
    const credentials = createCredentialStore(join(dir, 'creds'), now);
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(scope.accountId, 1, 1, time);
    const session = issueCallerSession(db, { accountId: scope.accountId, callerId: scope.callerId,
      domain: scope.dataDomain, permissions: ['work.read', 'events.read'] }, now, credentials);
    const projection = createWorkProjection(db, codec);
    const work: WorkFact = { work_id: 'W-017', generation: 1, updated_at: time, state: 'researching',
      attempt_ids: [], question_id: null, delivery_id: null };
    projection.apply(scope, { watermark: { hub_seq: 1, domain_seq: 1 }, at: time, coverage: 'fresh', items: [work] });
    const app = new Hono();
    const ready = () => ({ db, credentials, now, projection });
    mountWorkProjectionRoutes(app, ready);
    mountProjectionEventRoutes(app, ready, { pollMs: 5 });
    for (const [eventId, dataDomain] of [['domain-event', 'personal'], ['other-domain-event', 'company']]) {
      appendDomainEvent(db, { eventId, aggregateId: 'q-017', aggregateVersion: 1, accountId: 'owner', dataDomain,
        payload: { type: 'answer.verified', work_id: 'W-017', generation: 1, raw_text: 'not projection content' }, destination: 'local' });
    }
    const snapshot = await app.request('/api/v1/work?state=open&domain=personal', { headers: { authorization: session.authorization } });
    expect(snapshot.status).toBe(200);
    const body = await snapshot.json() as { stream_cursor: string };
    expect(routes.find((route) => route.operationId === 'listWork')?.response.safeParse(body).success).toBe(true);
    const timeline = await app.request('/api/v1/work/W-017/timeline?domain=personal', { headers: { authorization: session.authorization } });
    expect(timeline.status).toBe(200);
    const history = await timeline.json() as { data: { items: unknown[] } };
    expect(history.data.items).toEqual([{ event_id: 'domain-event', type: 'answer.verified', at: expect.any(String) }]);
    projection.apply(scope, { watermark: { hub_seq: 2, domain_seq: 1 }, at: time, coverage: 'fresh',
      items: [{ ...work, state: 'paused' }] });
    const live = await app.request('/api/v1/events?domain=personal&after=ignored', { signal: stop.signal,
      headers: { authorization: session.authorization, 'last-event-id': body.stream_cursor } });
    expect(live.status).toBe(200);
    expect(live.headers.get('content-type')).toContain('text/event-stream');
    reader = live.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('event: work.changed');
    db.prepare(`UPDATE caller_scopes SET revoked_at=? WHERE account_id=? AND caller_id=? AND data_domain=? AND permission='work.read'`)
      .run(time, scope.accountId, scope.callerId, scope.dataDomain);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: scope_revoked');
    expect((await reader.read()).done).toBe(true);
    expect((await app.request('/api/v1/work?domain=personal', { headers: { authorization: session.authorization } })).status).toBe(403);
  } finally {
    stop.abort();
    await reader?.cancel();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read paging uses a constant query count and rebuild invalidates an old stream cursor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t13-pagination-'));
  const db = openDatabase(join(dir, 'paging.sqlite'));
  try {
    const projection = createWorkProjection(db, codec);
    const at = '2026-11-17T05:00:00.000Z';
    projection.apply(scope, { watermark: { hub_seq: 22, domain_seq: 35 }, at, coverage: 'fresh',
      items: Array.from({ length: 51 }, (_, index) => ({ work_id: `W-${String(index + 1).padStart(3, '0')}`, generation: 1,
        updated_at: at, state: 'researching', attempt_ids: [], question_id: null, delivery_id: null })) });
    const prepared = vi.spyOn(db, 'prepare');
    const small = projection.readList(scope, { state: 'open', limit: 1 });
    const firstPageQueries = prepared.mock.calls.length;
    prepared.mockClear();
    const large = projection.readList(scope, { state: 'open', limit: 50 });
    expect(prepared.mock.calls.length).toBe(firstPageQueries);
    expect(small.data.items).toHaveLength(1);
    expect(large.data.items).toHaveLength(50);
    expect(large.data.counts.open).toBe(51);
    expect(projection.readList(scope, { state: 'open', limit: 50, cursor: large.data.next_cursor! }).data.items.map((item) => item.work_id))
      .toEqual(['W-051']);
    expect(projection.eventsAfter(scope, large.stream_cursor!)).toEqual({ status: 'ok', events: [] });
    projection.invalidateAfterRebuild(scope);
    expect(projection.eventsAfter(scope, large.stream_cursor!)).toEqual({ status: 'reset_required' });
    expect(projection.readList(scope, { state: 'open' })).toMatchObject({ freshness: 'syncing' });
    prepared.mockRestore();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the configured application observes Hub and serves signed-in product snapshots without exposing other domains', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t13-app-'));
  const databasePath = join(dir, 'app.sqlite');
  const credentialDirectory = join(dir, 'creds');
  const db = openDatabase(databasePath);
  const stop = new AbortController();
  const time = '2026-11-17T04:00:00.000Z';
  const now = () => new Date(time);
  const state = vi.fn(async (_before?: number, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    return { seq: 19, cards: [], runs: [], lines: [], hasMore: false, nextBefore: null };
  });
  try {
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(scope.accountId, 1, 1, time);
    const session = issueCallerSession(db, { accountId: scope.accountId, callerId: scope.callerId,
      domain: scope.dataDomain, permissions: ['work.read', 'events.read'] }, now, createCredentialStore(credentialDirectory, now));
    const app = createApp({ databasePath, credentialDirectory, now, productViewHub: { hub: { state }, signal: stop.signal } });
    const headers = { authorization: session.authorization };
    const base = '/api/v1/system/health';
    expect((await app.request(base)).status).toBe(401);
    expect((await app.request(base + '?domain=company', { headers })).status).toBe(403);
    const work = await app.request('/api/v1/work?domain=personal', { headers });
    expect(work.status).toBe(200);
    expect(await work.json()).toMatchObject({ scope: { account_id: 'owner', data_domain: 'personal' }, data: { items: [] } });
    await expect.poll(async () => {
      const response = await app.request(base + '?domain=personal', { headers });
      return await response.json();
    }, { timeout: 3000 }).toMatchObject({
      scope: { account_id: 'owner', data_domain: 'personal' },
      freshness: 'fresh', watermark: { hub_seq: 19, domain_seq: 0 }, stream_cursor: expect.any(String),
    });
    expect(state).toHaveBeenCalledTimes(2);
    // A WAL reader must still complete while another connection owns the write lock.
    db.exec('BEGIN IMMEDIATE');
    try {
      const reads = await Promise.all(Array.from({ length: 30 }, () =>
        app.request('/api/v1/work?limit=50&domain=personal', { headers })));
      expect(reads.map((response) => response.status)).toEqual(Array(30).fill(200));
    } finally {
      db.exec('ROLLBACK');
    }
  } finally {
    stop.abort();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a health change remains a visible projection notice when a work notice shares its transaction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t13-batch-'));
  const db = openDatabase(join(dir, 'batch.sqlite'));
  try {
    const projection = createWorkProjection(db, codec);
    const time = '2026-11-17T04:00:00.000Z';
    const base = { watermark: { hub_seq: 1, domain_seq: 1 }, at: time, coverage: 'fresh' as const };
    const work: WorkFact = { work_id: 'W-017', generation: 1, updated_at: time, state: 'researching',
      attempt_ids: [], question_id: null, delivery_id: null };
    const health = { connections: { vault: null, feishu: null }, edits: { pending: 1, failed: 0 } };
    projection.apply(scope, { ...base, items: [work], health });
    const snapshot = projection.readHealth(scope);
    projection.apply(scope, { ...base, at: '2026-11-17T04:01:00.000Z', watermark: { hub_seq: 1, domain_seq: 2 },
      items: [{ ...work, state: 'verifying' }], health: { ...health, edits: { pending: 0, failed: 1 } } });
    const replay = projection.eventsAfter(scope, snapshot.stream_cursor!);
    expect(replay).toMatchObject({ status: 'ok', events: [
      { event: { type: 'work.changed', resource_id: 'W-017' } },
      { event: { type: 'projection.changed', resource_id: null, watermark: { hub_seq: 1, domain_seq: 2 } } },
    ] });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([{ count: 70, extraBytes: 0, tailBatch: 20 }, { count: 24, extraBytes: 12_000, tailBatch: 24 }])('SSE buffers a slow reader up to its frame or byte cap ($count frames)', async ({ count, extraBytes, tailBatch }) => {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t13-slow-'));
  const db = openDatabase(join(dir, 'slow.sqlite'));
  let slowReader: ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>> | undefined;
  let fastReader: ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>> | undefined;
  const stop = new AbortController();
  try {
    const time = '2026-11-17T04:00:00.000Z';
    const now = () => new Date(time);
    const credentials = createCredentialStore(join(dir, 'creds'), now);
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(scope.accountId, 1, 1, time);
    const session = issueCallerSession(db, { accountId: scope.accountId, callerId: scope.callerId,
      domain: scope.dataDomain, permissions: ['work.read', 'events.read'] }, now, credentials);
    const projection = createWorkProjection(db, codec);
    const base = { watermark: { hub_seq: 1, domain_seq: 1 }, at: time, coverage: 'fresh' as const };
    projection.apply(scope, { ...base, items: [] });
    const app = new Hono();
    const ready = () => ({ db, credentials, now, projection });
    mountWorkProjectionRoutes(app, ready);
    mountProjectionEventRoutes(app, ready, { pollMs: 5 });
    const authorization = session.authorization;
    const snapshot = await (await app.request('/api/v1/work?domain=personal', { headers: { authorization } })).json() as { stream_cursor: string };
    const connect = () => app.request('/api/v1/events?domain=personal', { signal: stop.signal,
      headers: { authorization, 'last-event-id': snapshot.stream_cursor } });
    const replay = vi.spyOn(projection, 'eventsAfter');
    const slow = await connect();
    expect(slow.status).toBe(200);
    projection.apply(scope, { ...base, watermark: { hub_seq: 2, domain_seq: 2 }, items: Array.from({ length: count }, (_, index): WorkFact => ({
      work_id: 'W-' + String(index + 1).padStart(3, '0') + 'x'.repeat(extraBytes), generation: 1, updated_at: time, state: 'researching',
      attempt_ids: [], question_id: null, delivery_id: null,
    })) });
    await expect.poll(() => replay.mock.results.some((result) => result.value?.events?.length === tailBatch), { timeout: 1000 }).toBe(true);
    slowReader = slow.body!.getReader();
    expect((await slowReader.read()).done).toBe(true);
    const fast = await connect();
    fastReader = fast.body!.getReader();
    const records = new Set<string>();
    const decoder = new TextDecoder();
    while (records.size < count) {
      const { done, value } = await fastReader.read();
      expect(done).toBe(false);
      for (const id of decoder.decode(value).matchAll(/"resource_id":"([^"]+)"/gu)) records.add(id[1]);
    }
    expect(records.has('W-' + String(count).padStart(3, '0') + 'x'.repeat(extraBytes))).toBe(true);
  } finally {
    stop.abort();
    await Promise.all([slowReader?.cancel(), fastReader?.cancel()]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unchanged Hub polls skip projection derivation without suppressing stale and recovered freshness', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t13-idempotent-poll-'));
  const db = openDatabase(join(dir, 'poll.sqlite'));
  const stop = new AbortController();
  try {
    let observedAt = new Date('2026-11-17T04:00:00.000Z');
    const now = () => observedAt;
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(scope.accountId, 1, 1, now().toISOString());
    issueCallerSession(db, { accountId: scope.accountId, callerId: scope.callerId, domain: scope.dataDomain,
      permissions: ['work.read'] }, now, createCredentialStore(join(dir, 'creds'), now));
    const product = createProductViewService(db, now);
    const statements = vi.spyOn(db, 'prepare');
    const derivations = () => statements.mock.calls.filter(([sql]) => sql.includes('WITH latest AS')).length;
    const sweeps = () => statements.mock.calls.filter(([sql]) => sql.includes('SELECT DISTINCT account_id,data_domain')).length;
    const view = { hub_seq: 19, runs: [], cards: [] };
    // Exercise the same store used by the configured Hub observer.
    const observe = (time: Date) => product.recordHubObservation(view, time.toISOString());
    observe(now());
    product.start({ signal: stop.signal, intervalMs: 5 });
    const read = () => product.projection.readHealth(scope);
    await expect.poll(() => read().freshness).toBe('fresh');
    const firstCount = derivations();
    expect(firstCount).toBe(1);
    const firstSweep = sweeps();
    observedAt = new Date('2026-11-17T04:00:01.000Z');
    observe(now());
    await expect.poll(sweeps).toBeGreaterThan(firstSweep + 1);
    expect(derivations()).toBe(firstCount);
    observedAt = new Date('2026-11-17T04:01:02.000Z');
    await expect.poll(() => read().freshness).toBe('stale');
    expect(derivations()).toBe(firstCount + 1);
    expect(read().as_of).toBe('2026-11-17T04:00:00.000Z');
    observe(now());
    await expect.poll(() => read().freshness).toBe('fresh');
    expect(derivations()).toBe(firstCount + 2);
    expect(read().as_of).toBe(now().toISOString());
    statements.mockRestore();
  } finally {
    stop.abort();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
