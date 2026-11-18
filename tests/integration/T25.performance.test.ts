import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { issueCallerSession } from '../../apps/service/src/auth.js';
import { createProductViewService } from '../../apps/service/src/product-views.js';
import { mountProjectionEventRoutes } from '../../apps/service/src/routes/events.js';
import { mountStatsRoutes } from '../../apps/service/src/routes/stats.js';
import { mountWorkProjectionRoutes } from '../../apps/service/src/routes/work.js';
import { createDelegationApi } from '../../packages/domain/src/delegation.js';
import { createCredentialStore } from '../../packages/host/src/credentials.js';
import { BUSY_TIMEOUT_MS, openDatabase } from '../../packages/storage/src/database.js';
import { STATS_BATCH_LIMIT } from '../../packages/storage/src/views/stats.js';
import { appendDomainEvent, ackOutbox } from '../../packages/storage/src/outbox.js';

const baseline = JSON.parse(readFileSync(new URL('../../fixtures/perf/baseline.json', import.meta.url), 'utf8')) as {
  queued_updates: number; stats_facts: number; data_domains: [string, string]; slow_subscribers: number;
  stats_window: { period: string; timezone: string; as_of: string };
};
const { as_of: at, period, timezone } = baseline.stats_window;
const now = () => new Date(at);
const accountId = 'local-benchmark';
const [personal, other] = baseline.data_domains;
const sampleCount = 24;

function distribution(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1];
  return { samples: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}

async function receiveWork(reader: ReadableStreamDefaultReader<Uint8Array>, count: number) {
  const ids: string[] = [];
  let bytes = 0;
  while (ids.length < count) {
    const { value, done } = await reader.read();
    if (done) throw new Error('Healthy subscriber closed before receiving all expected updates');
    bytes += value.byteLength;
    for (const frame of new TextDecoder().decode(value).split('\n\n').filter(Boolean)) {
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      if (!data) continue; // Heartbeat
      const event = JSON.parse(data.slice(6));
      expect(event).toMatchObject({ type: 'work.changed', scope: { data_domain: personal } });
      ids.push(event.resource_id);
    }
  }
  expect(ids).toHaveLength(count);
  return { ids, bytes };
}

test('locked local workload isolates work, statistics and a stalled SSE reader, then catches up the WAL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t25-perf-'));
  const path = join(dir, 'local.sqlite');
  openDatabase(path).close();
  // Native SQLite execution trace includes transaction boundaries and cached statements.
  let trace: string[] | undefined;
  const db = new Database(path, { verbose: (sql) => trace?.push(String(sql)) });
  const pin = new Database(path);
  const stop = new AbortController();
  const streamLifetime = AbortSignal.any([stop.signal, AbortSignal.timeout(15_000)]);
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    db.pragma('foreign_keys=ON');
    db.pragma('busy_timeout=' + BUSY_TIMEOUT_MS);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    const service = createProductViewService(db, now);
    const credentials = createCredentialStore(join(dir, 'creds'), now);
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(accountId, 1, 1, at);
    const app = new Hono();
    const ready = () => ({ db, credentials, now, ...service });
    mountWorkProjectionRoutes(app, ready);
    mountStatsRoutes(app, ready);
    mountProjectionEventRoutes(app, ready, { pollMs: 5 });
    const scopes = baseline.data_domains.map((dataDomain) => ({ accountId, dataDomain }));
    const authorizations = scopes.map(({ dataDomain }) => issueCallerSession(db, {
      accountId, callerId: 'viewer-' + dataDomain, domain: dataDomain, permissions: ['events.read', 'work.read', 'stats.read'],
    }, now, credentials).authorization);
    const slowIndex = authorizations.length;
    authorizations.push(issueCallerSession(db, {
      accountId, callerId: 'stalled', domain: personal, permissions: ['events.read', 'work.read', 'stats.read'],
    }, now, credentials).authorization);
    const get = (url: string, domainIndex = 0, signal?: AbortSignal) =>
      app.request('/api/v1/' + url, { headers: { authorization: authorizations[domainIndex] }, signal });
    const statsUrl = 'stats?' + new URLSearchParams({ period, timezone });
    for (const route of ['work?', statsUrl + '&', 'events?']) {
      expect((await get(route + 'domain=' + other)).status).toBe(403);
    }

    service.recordHubObservation({ hub_seq: 1, cards: [], runs: [] }, at);
    const delegates = scopes.map(({ dataDomain }) => createDelegationApi(db, { account_id: accountId, caller_id: 'seed',
      auth_epoch: 1, domains: [dataDomain], operations: ['owner'] }, { domain: dataDomain, now }));
    for (const [i, domain] of baseline.data_domains.entries()) {
      const policy = { actions: ['judge'], resources: ['work'], effects: [], domains: [domain], risk: 'low',
        level: 'L1' as const, budget_micros: 1000 };
      await delegates[i].registerMandateType({ ...policy, type_id: domain, config_version: 1 });
      await delegates[i].openMandate({ ...policy, mandate_id: domain, type_id: domain, expires_at: '2026-01-01T00:00:00.000Z' });
      service.refresh(scopes[i]);
    }
    const initial = await (await get('work')).json();
    const slowInitial = await (await get('work', slowIndex)).json();
    const stream = async (cursor: string, index = 0) => {
      const response = await get('events?after=' + encodeURIComponent(cursor), index, streamLifetime);
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      readers.push(reader);
      return reader;
    };
    expect(baseline.slow_subscribers).toBe(1);
    const slow = await stream(slowInitial.stream_cursor, slowIndex);
    const healthy = await stream(initial.stream_cursor);
    const pending = () => (db.prepare('SELECT count(*) AS n FROM outbox WHERE result IS NULL').get() as { n: number }).n;
    const queued: string[] = [];
    const visible: string[][] = [[], []];
    const domainFor = (index: number) => index < 64 ? 0 : index % scopes.length;
    const idFor = (index: number) => scopes[domainFor(index)].dataDomain + '-' + index;
    async function openQueuedWork(index: number) {
      const i = domainFor(index);
      await delegates[i].openWork({ work_id: idFor(index), generation: 1, mandate_id: scopes[i].dataDomain,
        phase: 'judgment', next_action: 'judge', budget_micros: 1 });
      visible[i].push(idFor(index));
    }

    pin.exec('BEGIN');
    pin.prepare('SELECT count(*) FROM domain_events').get();
    const enqueueStart = performance.now();
    for (let index = 0; index < baseline.queued_updates; index++) {
      const id = idFor(index);
      appendDomainEvent(db, { eventId: id, aggregateId: id, aggregateVersion: 1, accountId,
        dataDomain: scopes[domainFor(index)].dataDomain, payload: { type: 'work.requested', work_id: id, generation: 1 },
        destination: 'local' });
      queued.push(id);
    }
    expect(pending()).toBe(baseline.queued_updates);
    const head = (db.prepare('SELECT MAX(seq) AS n FROM domain_events').get() as { n: number }).n;
    const lagBefore = head - (await (await get('work')).json()).watermark.domain_seq;
    expect(lagBefore).toBe(baseline.queued_updates);

    // Unequal domain totals and out-of-window decoys distinguish the date and scope predicates.
    const insert = db.prepare(`INSERT INTO stats_facts (account_id,data_domain,kind,fact_key,first_seq,occurred_at,valid)
      VALUES (?,?,'owner_decision',?,1,?,1)`);
    const activity = [0, 0];
    db.transaction(() => {
      for (let index = 0; index < baseline.stats_facts; index++) {
        const domainIndex = index % 3 === 0 ? 1 : 0;
        const inWindow = index % 5 !== 0;
        insert.run(accountId, scopes[domainIndex].dataDomain, 'fact-' + index, inWindow ? at : '2025-01-01T00:00:00.000Z');
        if (inWindow) activity[domainIndex]++;
      }
    }).immediate();

    // Session-bound IDs have fixed-length signatures and scope digests. Frame sizes match.
    // Observe the unread subscription's catch-up before publishing its 64th notification.
    const firstReplay = service.projection.eventsAfter.bind(service.projection);
    let stalledAtTail = false;
    let tailCursor = '';
    const replay = vi.spyOn(service.projection, 'eventsAfter').mockImplementation((scope, cursor) => {
      const batch = firstReplay(scope, cursor);
      if (scope.callerId === 'stalled' && batch.status === 'ok' && batch.events.length === 0 && cursor === tailCursor) {
        stalledAtTail = true;
      }
      return batch;
    });

    for (let index = 0; index < 63; index++) await openQueuedWork(index);
    service.refresh(scopes[0]);
    tailCursor = (await (await get('work', slowIndex)).json()).stream_cursor;
    const prefix = await receiveWork(healthy, 63);
    expect([...prefix.ids].sort()).toEqual([...visible[0]].sort());
    await vi.waitFor(() => expect(stalledAtTail).toBe(true));
    replay.mockRestore();
    await openQueuedWork(63);
    const overflowStart = performance.now();
    service.refresh(scopes[0]);
    await slow.closed;
    streamLifetime.throwIfAborted();
    const overflowMs = performance.now() - overflowStart;
    expect(await slow.read()).toMatchObject({ done: true });
    expect((await receiveWork(healthy, 1)).ids).toEqual([personal + '-63']);
    for (let index = 64; index < baseline.queued_updates; index++) await openQueuedWork(index);
    for (const scope of scopes) {
      db.prepare(`INSERT INTO stats_producer_coverage (account_id,data_domain,kind,producer,work_epoch,domain_seq,
        hub_seq,available_since,verified_through,complete_history,evidence_sha256)
        VALUES (?,?,'owner_decision','answer_gate',1,?,1,'2025-01-01T00:00:00.000Z',?,1,?)`)
        .run(accountId, scope.dataDomain, head, at, 'c'.repeat(64));
      for (let sweep = 0; sweep <= Math.ceil(head / STATS_BATCH_LIMIT); sweep++) {
        service.refresh(scope);
        const cp = db.prepare('SELECT domain_seq FROM stats_checkpoints WHERE account_id=? AND data_domain=?')
          .get(accountId, scope.dataDomain) as { domain_seq: number } | undefined;
        if (cp?.domain_seq === head) break;
      }
    }
    const enqueueToProjectionMs = performance.now() - enqueueStart;
    const remaining = visible[0].slice(64).sort();
    expect((await receiveWork(healthy, remaining.length)).ids.sort()).toEqual(remaining);
    await healthy.cancel();
    // Reconnect from the retained pre-overflow snapshot and receive the same first work again.
    const resumed = await stream(slowInitial.stream_cursor, slowIndex);
    const first = await resumed.read();
    expect(new TextDecoder().decode(first.value).split('\n\n')[0]).toContain('"resource_id":"' + prefix.ids[0] + '"');
    await resumed.cancel();

    const samples: Record<string, { latency: ReturnType<typeof distribution>; sqlPerRequest: number }> = {};
    let statsPlan: string[] = [];
    for (const [key, route, limit] of [['work1', 'work?state=open&limit=1', 1],
      ['work50', 'work?state=open&limit=50', 50], ['stats', statsUrl, 0]] as const) {
      const durations: number[] = [];
      const statementCounts = new Set<number>();
      for (let run = 0; run < sampleCount; run++) {
        trace = [];
        const start = performance.now();
        const response = await get(route);
        const body = await response.json();
        durations.push(performance.now() - start);
        const statements = trace;
        trace = undefined;
        expect(response.status).toBe(200);
        expect(body).toMatchObject({ scope: { data_domain: personal }, freshness: 'fresh', watermark: { domain_seq: head } });
        statementCounts.add(statements.length);
        if (limit) {
          expect(body.data.items).toHaveLength(limit);
          expect(body.data.counts.open).toBe(visible[0].length);
          expect(body.data.items.every((item: { work_id: string }) => item.work_id.startsWith(personal + '-'))).toBe(true);
        } else {
          expect(body.data.activity.owner_decisions).toBe(activity[0]);
          if (run === 0) {
            const sql = statements.find((statement) => statement.includes('FROM stats_facts'));
            expect(sql).toBeDefined();
            statsPlan = (db.prepare('EXPLAIN QUERY PLAN ' + sql).all() as { detail: string }[]).map((row) => row.detail);
          }
        }
      }
      expect(statementCounts.size).toBe(1);
      samples[key] = { latency: distribution(durations), sqlPerRequest: [...statementCounts][0] };
    }
    expect(samples.work1.sqlPerRequest).toBeGreaterThan(0);
    expect(samples.work1.sqlPerRequest).toBe(samples.work50.sqlPerRequest);
    expect(statsPlan.join(' ')).toMatch(/stats_valid_activity_window.*account_id=\? AND data_domain=\? AND kind=\? AND occurred_at>\? AND occurred_at<\?/);
    expect(await (await get(statsUrl, 1)).json()).toMatchObject({ scope: { data_domain: other },
      data: { activity: { owner_decisions: activity[1] }, work: { open: visible[1].length } } });

    type WalProgress = { busy: number; log: number; checkpointed: number };
    const checkpoint = () => (db.pragma('wal_checkpoint(PASSIVE)') as WalProgress[])[0];
    const pinned = checkpoint();
    expect(pinned.log).toBeGreaterThan(pinned.checkpointed);
    for (const id of queued) ackOutbox(db, id, 'local', 'accepted');
    expect(pending()).toBe(0);
    // The pinned reader forbids WAL recycling during the workload.
    const peakWalBytes = statSync(path + '-wal').size;
    pin.exec('COMMIT');
    const drained = checkpoint();
    expect(drained.busy).toBe(0);
    expect(drained.log).toBeGreaterThan(0);
    expect(drained.checkpointed).toBe(drained.log);
    // A second local connection contends for the writer with a short fixture timeout.
    pin.pragma('busy_timeout=30');
    db.exec('BEGIN IMMEDIATE');
    const lockStart = performance.now();
    try {
      expect(() => pin.exec('BEGIN IMMEDIATE')).toThrow(expect.objectContaining({ code: 'SQLITE_BUSY' }));
    } finally { db.exec('ROLLBACK'); }
    const busyWaitMs = performance.now() - lockStart;
    pin.exec('BEGIN IMMEDIATE');
    pin.exec('ROLLBACK');
    console.info('T25-local-performance', JSON.stringify({ samples, statsPlan, activity, queuedUpdates: queued.length,
      lagBefore, lagAfter: head - (await (await get('work')).json()).watermark.domain_seq, peakWalBytes,
      pinned, drained, enqueueToProjectionMs, busyTimeoutMs: 30, busyWaitMs, queuedFrameBytesFromSameSizePeer: prefix.bytes, queuedFrames: 63, overflowMs }));
  } finally {
    stop.abort();
    await Promise.all(readers.map((reader) => reader.cancel()));
    pin.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
