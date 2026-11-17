import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Hono } from 'hono';
import { createProductViewService } from '../../apps/service/src/product-views.js';
import { mountStatsRoutes } from '../../apps/service/src/routes/stats.js';
import { countActivitySql, createStatsProjection } from '../../packages/storage/src/views/stats.js';
import { issueCallerSession } from '../../apps/service/src/auth.js';
import { createCredentialStore } from '../../packages/host/src/credentials.js';
import { openDatabase } from '../../packages/storage/src/database.js';
import { createDelegationApi } from '../../packages/domain/src/delegation.js';
import { createBlobStore } from '../../packages/storage/src/blob-store.js';
import { createSourceRegistry } from '../../packages/integrations/sources/registry.js';
import type { FactKind } from '../../packages/storage/src/views/stats-source.js';
import { createProjectionCursorCodec } from '../../packages/storage/src/views/cursors.js';
import { createWorkProjection } from '../../packages/storage/src/views/work.js';
import type { WorkFact } from '../../packages/storage/src/views/work.js';

const now = new Date('2025-03-10T12:00:00.000Z');
const at = now.toISOString();
const scope = {
  accountId: 'owner', callerId: 'web', dataDomain: 'personal', permissionEpoch: 1,
  permissionDigest: 'c'.repeat(64), sessionDigest: 'd'.repeat(64),
};
const foreign = { ...scope, dataDomain: 'other' };
const codec = createProjectionCursorCodec(Buffer.alloc(32, 19));

function fixture(syntheticCoverage: boolean) {
  const tmp = mkdtempSync(join(tmpdir(), 'patrick-t19-'));
  const db = openDatabase(join(tmp, 'stats.sqlite'));
  const work = createWorkProjection(db, codec);
  function emit(id: string, aggregate: string, payload: object, created: string, selected = scope) {
    const result = db.prepare(`INSERT INTO domain_events (event_id,aggregate_id,aggregate_version,account_id,data_domain,schema_version,payload,created_at)
      VALUES (?,?,1,?,?,'1.0',?,?) RETURNING seq`).get(id, aggregate, selected.accountId, selected.dataDomain, JSON.stringify(payload), created) as { seq: number };
    db.prepare(`INSERT INTO projection_cursors VALUES ('local',0,?,?) ON CONFLICT(name) DO UPDATE SET domain_seq=excluded.domain_seq`).run(result.seq, created);
    return result.seq;
  }
  function answer(id: string, answerId: string, created: string, selected = scope) {
    db.prepare(`INSERT INTO answer_receipts (receipt_id,intent_id,account_id,data_domain,question_id,question_version,work_id,generation,
      validity,disposition,hub_answer_event_id,result_revision,missing_json,schema_version,created_at)
      VALUES (?,?,?,?,?,1,?,1,'verified','proceed',?,1,'[]','1.0',?)`).run('receipt-'+id, 'intent-'+id, selected.accountId,
      selected.dataDomain, 'question-'+id, 'work-'+id, answerId, created);
    duplicateAnswer(id, answerId, created, selected);
  }
  function duplicateAnswer(id: string, answerId: string, created: string, selected = scope) {
    emit('answer-'+id+'-'+created, 'question-'+id,
      { type: 'answer.verified', work_id: 'work-'+id, generation: 1, question_id: 'question-'+id, answer_event_id: answerId }, created, selected);
  }
  function certify(kind: FactKind, opts: { since?: string; through?: string; history?: boolean; selected?: typeof scope;
    domainSeq?: number; hubSeq?: number; epoch?: number } = {}) {
    const selected = opts.selected ?? scope;
    const producer = { owner_decision: 'answer_gate', automatic_decision: 'decision_commit', delivered_work: 'pr_delivery' }[kind];
    const checkpoint = db.prepare(`SELECT epoch,hub_seq,domain_seq,trusted_as_of FROM product_view_checkpoints
      WHERE account_id=? AND data_domain=?`).get(selected.accountId, selected.dataDomain) as
      { epoch: number; hub_seq: number; domain_seq: number; trusted_as_of: string };
    db.prepare(`INSERT INTO stats_producer_coverage (account_id,data_domain,kind,producer,work_epoch,domain_seq,
      hub_seq,available_since,verified_through,complete_history,evidence_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id,data_domain,kind,work_epoch) DO UPDATE SET domain_seq=excluded.domain_seq,
      hub_seq=excluded.hub_seq,available_since=excluded.available_since,verified_through=excluded.verified_through,
      complete_history=excluded.complete_history,evidence_sha256=excluded.evidence_sha256`)
      .run(selected.accountId, selected.dataDomain, kind, producer, opts.epoch ?? checkpoint.epoch, opts.domainSeq ?? checkpoint.domain_seq,
        opts.hubSeq ?? checkpoint.hub_seq, opts.since ?? '2025-02-01T00:00:00.000Z', opts.through ?? checkpoint.trusted_as_of,
        opts.history === false ? 0 : 1, 'c'.repeat(64));
  }
  function sync(time = now, freshness: 'fresh' | 'stale' = 'fresh', selected = scope) {
    const local = db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM domain_events').get() as { seq: number };
    const items: WorkFact[] = [
      { work_id: 'waiting', generation: 1, updated_at: at, state: 'awaiting_answer', attempt_ids: [], question_id: 'q', delivery_id: null },
      { work_id: 'paused', generation: 1, updated_at: at, state: 'paused', attempt_ids: [], question_id: null, delivery_id: null },
    ];
    work.apply(selected, { watermark: { hub_seq: 6, domain_seq: local.seq }, at: time.toISOString(), coverage: freshness, items });
    if (syntheticCoverage && freshness === 'fresh') {
      for (const kind of ['owner_decision', 'automatic_decision', 'delivered_work'] as const) certify(kind, { selected });
    }
    return work.readList(selected, { state: 'open', limit: 1 });
  }
  return { tmp, db, work, emit, answer, duplicateAnswer, sync, certify, cleanup() { db.close(); rmSync(tmp, { recursive: true, force: true }); } };
}

function setup(syntheticCoverage = true) {
  const migration = readFileSync(new URL('../../packages/storage/migrations/0019_stats.sql', import.meta.url), 'utf8');
  const fx = fixture(syntheticCoverage);
  if (!fx.db.prepare("SELECT 1 FROM schema_migrations WHERE file='0019_stats.sql'").get()) fx.db.exec(migration);
  return { ...fx, view: createStatsProjection(fx.db) };
}

test('natural-day activity survives a DST boundary, counts verified canonical facts once and filters scope before aggregation', async () => {
  const fx = setup();
  try {
    fx.answer('valid', 'hub-valid', '2025-03-04T05:00:00.000Z');
    fx.duplicateAnswer('valid', 'hub-valid', '2025-03-05T17:00:00.000Z');
    fx.answer('before', 'hub-before', '2025-03-04T04:59:59.999Z');
    fx.answer('after', 'hub-after', '2025-03-10T12:00:00.001Z');
    fx.answer('foreign', 'hub-foreign', '2025-03-08T12:00:00.000Z', foreign);
    fx.emit('clear', 'candidate', { type: 'answer.verified', answer_event_id: 'controller-close' }, '2025-03-10T08:00:00.000Z');
    fx.emit('test-feishu', 'hub-valid', { type: 'channel.test.updated' }, '2025-03-10T08:00:00.000Z');
    fx.emit('edit-supplement', 'known', { type: 'edit.receipt.changed' }, '2025-03-10T08:00:00.000Z');
    fx.emit('unverified-delivery', 'work-stub', { type: 'work.delivered', work_id: 'work-stub', intent_id: 'missing' }, '2025-03-10T08:00:00.000Z');
    fx.emit('suggestion', 'work-stub', { type: 'decision.committed', decision_event_id: 'not-admitted' }, '2025-03-10T08:00:00.000Z');
    const work = fx.sync();
    fx.view.refresh(scope, now);
    const snapshot = fx.view.readStats(scope, '7d', 'America/New_York', now);
    expect(snapshot).toMatchObject({ freshness: 'fresh', watermark: work.watermark, as_of: work.as_of });
    expect(snapshot.data.window_start).toBe('2025-03-04T05:00:00.000Z');
    expect(snapshot.data.window_end).toBe('2025-03-11T04:00:00.000Z');
    expect(snapshot.data.activity).toEqual({ owner_decisions: 1, delivered_work: 0, automatic_decisions: 0 });
    expect(snapshot.data.work).toEqual(work.data.counts);
    const thirty = fx.view.readStats(scope, '30d', 'America/New_York', now);
    expect(thirty.data.stock).toEqual(snapshot.data.stock);
    expect(thirty.data.activity.owner_decisions).toBe(2);
    expect(fx.view.readStats(foreign, '7d', 'America/New_York', now).data.activity.owner_decisions).toBeNull();
  } finally { fx.cleanup(); }
});

test('an unobserved scope returns null; compensation corrects the original bucket and a rebuild agrees', async () => {
  const fx = setup();
  try {
    const empty = fx.view.readStats(scope, 'all', 'America/Toronto', now);
    expect(empty).toMatchObject({ freshness: 'unknown', data: { activity: { owner_decisions: null }, stock: { active_standards: null } } });
    fx.answer('valid', 'hub-valid', '2025-03-08T12:00:00.000Z');
    fx.sync();
    fx.view.refresh(scope, now);
    const before = fx.view.readStats(scope, '7d', 'America/Toronto', now);
    expect(before.data.activity.owner_decisions).toBe(1);
    fx.emit('evil-compensate', 'hub-valid', { type: 'stats.fact.invalidated', kind: 'owner_decision', fact_key: 'hub-valid' }, at, foreign);
    const after = new Date('2025-03-10T12:01:00.000Z');
    fx.sync(after);
    fx.view.refresh(scope, after);
    expect(fx.view.readStats(scope, '7d', 'America/Toronto', after).data.activity.owner_decisions).toBe(1);
    fx.emit('good-compensate', 'hub-valid', { type: 'stats.fact.invalidated', kind: 'owner_decision', fact_key: 'hub-valid' }, at);
    fx.duplicateAnswer('valid', 'hub-valid', '2025-03-10T12:00:01.000Z');
    const beforeRebuild = new Date('2025-03-10T12:02:00.000Z');
    fx.sync(beforeRebuild);
    fx.view.refresh(scope, beforeRebuild);
    const snapshot = fx.view.readStats(scope, 'all', 'America/Toronto', beforeRebuild);
    expect(snapshot.data.activity.owner_decisions).toBe(0);
    fx.view.rebuild(scope, beforeRebuild);
    expect(fx.view.readStats(scope, 'all', 'America/Toronto', beforeRebuild)).toEqual(snapshot);
    const disconnected = new Date('2025-03-11T14:00:00.000Z');
    fx.sync(disconnected, 'stale');
    fx.view.refresh(scope, disconnected);
    expect(fx.view.readStats(scope, 'all', 'America/Toronto', disconnected)).toMatchObject({
      freshness: 'stale', as_of: snapshot.as_of, watermark: snapshot.watermark, data: snapshot.data,
    });
  } finally { fx.cleanup(); }
});

test('HTTP Stats requires both scoped statistics and work permissions and rejects offset-only timezones', async () => {
  const fx = setup();
  try {
    const credentials = createCredentialStore(join(fx.tmp, 'credentials'), () => now);
    fx.db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(scope.accountId, 1, 1, at);
    function session(callerId: string, permissions: string[], domain = scope.dataDomain) {
      return issueCallerSession(fx.db, { accountId: scope.accountId, callerId, domain, permissions }, () => now, credentials);
    }
    const both = session('viewer', ['work.read', 'stats.read']);
    const only = session('stats-only', ['stats.read']);
    session('viewer', ['work.read'], foreign.dataDomain);
    const app = new Hono();
    mountStatsRoutes(app, () => ({ db: fx.db, credentials, now: () => now, projection: fx.work, stats: fx.view }));
    const url = '/api/v1/stats?period=7d&timezone=America%2FNew_York';
    const read = (authorization: string, suffix = '') => app.request(url + suffix, { headers: { authorization } });
    expect((await app.request(url)).status).toBe(401);
    expect((await read(only.authorization)).status).toBe(403);
    expect((await read(both.authorization, '&domain=other')).status).toBe(403);
    expect((await read(both.authorization, '&period=30d')).status).toBe(422);
    expect((await app.request('/api/v1/stats?period=7d&timezone=%2B01%3A00',
      { headers: { authorization: both.authorization } })).status).toBe(422);
    fx.answer('visible', 'visible-answer', '2025-03-08T14:00:00.000Z');
    fx.sync();
    fx.view.refresh(scope, now);
    const result = await read(both.authorization);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ scope: { account_id: 'owner', data_domain: 'personal' },
      data: { activity: { owner_decisions: 1 }, work: { open: 2, awaiting_answer: 1, blocked: 1 } } });
  } finally { fx.cleanup(); }
});

test('all-time includes a verified first receipt recorded before its durable domain event', () => {
  const fx = setup(false);
  try {
    const receiptAt = '2025-03-08T11:59:59.900Z';
    fx.answer('first', 'first-answer', receiptAt);
    fx.db.prepare('UPDATE domain_events SET created_at=?').run('2025-03-08T12:00:00.200Z');
    fx.sync();
    fx.certify('owner_decision', { since: receiptAt });
    fx.view.refresh(scope, now);
    const snapshot = fx.view.readStats(scope, 'all', 'UTC', now);
    expect(snapshot.data.window_start).toBe(receiptAt);
    expect(snapshot.data.activity.owner_decisions).toBe(1);
  } finally { fx.cleanup(); }
});

test('baseline: SQLite prunes 10,000 statistics facts by account, domain, kind, and civil-day window', () => {
  const fx = setup();
  try {
    const fixture = JSON.parse(readFileSync(new URL('../../fixtures/perf/baseline.json', import.meta.url), 'utf8')) as {
      stats_facts: number; data_domains: string[];
    };
    const add = fx.db.prepare(`INSERT INTO stats_facts (account_id,data_domain,kind,fact_key,first_seq,occurred_at,valid)
      VALUES ('owner',?,'owner_decision',?,1,?,1)`);
    fx.db.transaction(() => {
      for (let index = 0; index < fixture.stats_facts; index += 1) {
        const time = index % 4 < 2 ? '2025-03-07T00:00:00.000Z' : '2025-02-14T00:00:00.000Z';
        add.run(fixture.data_domains[index % fixture.data_domains.length], 'answer-' + index, time);
      }
    }).immediate();
    const query = { account_id: 'owner', data_domain: 'personal', kind: 'owner_decision',
      window_start: '2025-03-04T05:00:00.000Z', window_end: '2025-03-11T04:00:00.000Z', as_of: at, domain_seq: 1 };
    const plan = fx.db.prepare('EXPLAIN QUERY PLAN ' + countActivitySql).all(query) as { detail: string }[];
    expect(plan.some(({ detail }) => detail.includes('stats_valid_activity_window')
      && detail.includes('account_id=? AND data_domain=? AND kind=? AND occurred_at>? AND occurred_at<?'))).toBe(true);
    expect(fx.db.prepare(countActivitySql).get(query)).toEqual({ count: 2500 });
  } finally { fx.cleanup(); }
});

test('current stock deduplicates live records and expires a delegation without advancing the work watermark', async () => {
  const fx = setup();
  try {
    const principal = { account_id: scope.accountId, caller_id: scope.callerId, auth_epoch: 1, domains: [scope.dataDomain], operations: ['owner'] };
    const delegation = createDelegationApi(fx.db, principal, { domain: scope.dataDomain, now: () => now });
    const policy = { actions: ['judge'], resources: ['work'], effects: [], domains: [scope.dataDomain],
      risk: 'low', level: 'L1' as const, budget_micros: 1000 };
    await delegation.registerMandateType({ ...policy, type_id: 'type', config_version: 1 });
    await delegation.registerMandateType({ ...policy, type_id: 'registered-only', config_version: 1 });
    await delegation.openMandate({ ...policy, mandate_id: 'first', type_id: 'type', expires_at: '2025-03-10T12:30:00.000Z' });
    await delegation.openMandate({ ...policy, mandate_id: 'second', type_id: 'type', expires_at: '2025-03-10T12:10:00.000Z' });
    const addKnowledge = fx.db.prepare(`INSERT INTO knowledge_records VALUES (?,?,?,?,1,?,'sample','sample','1.0',?,?)`);
    for (const [id, canonical, status, selected] of [['a', 'same', 'available', scope], ['b', 'same', 'available', scope],
      ['c', 'other-domain', 'available', foreign], ['d', 'unverified', 'candidate', scope], ['e', 'withdrawn', 'withdrawn', scope]] as const) {
      addKnowledge.run(id, canonical, selected.accountId, selected.dataDomain, status, at, at);
    }
    fx.db.prepare("INSERT INTO standards VALUES ('accepted','owner','personal',2,2,'1.0',?,?),('candidate','owner','personal',NULL,0,'1.0',?,?)")
      .run(at, at, at, at);
    const addVersion = fx.db.prepare(`INSERT INTO standard_versions
      (standard_id,version,data_domain,scope_text,rules_json,exceptions_text,counterexamples_text,source_text,status,schema_version,created_at)
      VALUES ('accepted',?,'personal','scope','[]','','','source',?,'1.0',?)`);
    addVersion.run(1, 'retained', at);
    addVersion.run(2, 'active', at);
    const work = fx.sync();
    fx.view.refresh(scope, now);
    const before = fx.view.readStats(scope, '7d', 'Asia/Shanghai', now);
    expect(before.data.stock).toEqual({ active_standards: 1, knowledge_entries: 1, delegation_types: 1, active_delegation_types: 1 });

    const later = new Date('2025-03-11T14:00:00.000Z');
    fx.view.refresh(scope, later);
    const after = fx.view.readStats(scope, '7d', 'Asia/Shanghai', later);
    expect(after).toMatchObject({ as_of: later.toISOString(), watermark: work.watermark, freshness: 'fresh' });
    expect(after.data.stock).toEqual({ ...before.data.stock, active_delegation_types: 0 });
    expect(after.data.work).toEqual(work.data.counts);
    expect(after.data.window_end).toBe('2025-03-11T16:00:00.000Z');
  } finally { fx.cleanup(); }
});

test('a bounded backlog publishes neither new facts nor pending compensations under the previous watermark', () => {
  const fx = setup();
  try {
    fx.answer('existing', 'first-answer', '2025-03-08T11:59:00.000Z');
    fx.sync();
    expect(fx.view.refresh(scope, now)).toBe(true);
    const before = fx.view.readStats(scope, '7d', 'America/New_York', now);
    fx.emit('withdraw-first', 'first-answer', { type: 'stats.fact.invalidated', kind: 'owner_decision', fact_key: 'first-answer' }, at);
    fx.answer('new', 'second-answer', '2025-03-08T12:00:00.000Z');
    for (let i = 0; i < 1000; i += 1) fx.emit('queued-' + i, 'test', { type: 'channel.test.updated' }, at);
    const later = new Date('2025-03-10T12:01:00.000Z');
    const work = fx.sync(later);
    expect(fx.view.refresh(scope, later)).toBe(false);
    expect(fx.view.readStats(scope, '7d', 'America/New_York', later)).toEqual({ ...before, freshness: 'syncing' });
    for (let i = 0; i < 2; i += 1) expect(fx.view.refresh(scope, later)).toBe(false);
    expect(fx.view.refresh(scope, later)).toBe(true);
    expect(fx.view.readStats(scope, '7d', 'America/New_York', later)).toMatchObject({ freshness: 'fresh', watermark: work.watermark,
      data: { activity: { owner_decisions: 1 } } });
  } finally { fx.cleanup(); }
});

test('a committed automatic decision needs the exact admitted grant and source, and replay does not add another', async () => {
  const fx = setup(false);
  try {
    const sourceRoot = join(fx.tmp, 'requests');
    mkdirSync(sourceRoot);
    writeFileSync(join(sourceRoot, 'demand.md'), 'Synthetic local demand');
    writeFileSync(join(sourceRoot, 'unrelated.md'), 'Another independently admitted demand');
    const registry = createSourceRegistry(fx.db, { blobs: createBlobStore(join(fx.tmp, 'blobs')), now: () => at });
    const active = await registry.enableSource({ accountId: scope.accountId, dataDomain: scope.dataDomain },
      { type: 'directory', target: sourceRoot, hasTriggerRule: true, excludes: [], frequency: 'poll', history: 'none' });
    await registry.collectSource(active.sourceId, active.configRevision);
    const sources = fx.db.prepare(`SELECT r.revision_id,s.locator FROM source_revisions r
      JOIN source_objects s USING (source_id,object_id) WHERE r.source_id=? ORDER BY s.locator`)
      .all(active.sourceId) as { revision_id: string; locator: string }[];
    expect(sources.map((row) => row.locator)).toEqual(['demand.md', 'unrelated.md']);
    const [sourceRevision, unrelatedRevision] = sources.map((row) => row.revision_id);
    fx.db.prepare("INSERT INTO standards VALUES ('trusted','owner','personal',1,1,'1.0',?,?)").run(at, at);
    fx.db.prepare(`INSERT INTO standard_versions
      (standard_id,version,data_domain,scope_text,rules_json,exceptions_text,counterexamples_text,source_text,status,schema_version,created_at)
      VALUES ('trusted',1,'personal','scope','[]','','','source','active','1.0',?)`).run(at);
    const principal = { account_id: scope.accountId, caller_id: scope.callerId, auth_epoch: 1, domains: [scope.dataDomain], operations: ['owner'] };
    const delegation = createDelegationApi(fx.db, principal, { domain: scope.dataDomain, now: () => now });
    const policy = { actions: ['judge'], resources: ['work'], effects: [], domains: [scope.dataDomain],
      risk: 'low', level: 'L1' as const, budget_micros: 1000 };
    await delegation.registerMandateType({ ...policy, type_id: 'type', config_version: 1 });
    await delegation.openMandate({ ...policy, mandate_id: 'mandate', type_id: 'type', expires_at: '2025-03-11T12:00:00.000Z' });
    await delegation.setCapability({ profile_id: 'profile', level: 'L2', actions: ['judge'],
      report_id: 'report', report_version: 1, config_version: 1 });
    const workId = 'work:' + sourceRevision;
    await delegation.openWork({ work_id: workId, generation: 1, mandate_id: 'mandate', phase: 'judgment', next_action: 'judge', budget_micros: 1000 });
    const grant = await delegation.authorizeAction({ work_id: workId, generation: 1, attempt_id: 'attempt', phase: 'judgment',
      next_action: 'judge', allowed_effects: [], expires_at: '2025-03-11T11:00:00.000Z' });
    const fact = { type: 'decision.committed', decision_event_id: 'confirmed', work_id: workId, generation: 1,
      grant_id: grant.grant_id, basis_hash: grant.basis_hash, source_revision_id: sourceRevision, mandate_id: 'mandate' };
    fx.emit('committed', workId, fact, at);
    fx.emit('replayed', workId, fact, at);
    fx.emit('wrong-local-source', workId, { ...fact, decision_event_id: 'unrelated-source', source_revision_id: unrelatedRevision }, at);
    fx.emit('misbound', workId, { ...fact, decision_event_id: 'missing-basis', basis_hash: '0'.repeat(64) }, at);
    fx.emit('wrong-account', workId, { ...fact, decision_event_id: 'foreign' }, at, { ...scope, accountId: 'different-owner' });
    fx.sync();
    fx.certify('owner_decision');
    fx.certify('delivered_work');
    fx.view.refresh(scope, now);
    expect(fx.view.readStats(scope, '7d', 'UTC', now).data.activity.automatic_decisions).toBeNull();
    fx.certify('automatic_decision');
    fx.view.refresh(scope, now);
    expect(fx.view.readStats(scope, '7d', 'UTC', now).data.activity).toEqual({
      automatic_decisions: 1, delivered_work: 0, owner_decisions: 0,
    });
  } finally { fx.cleanup(); }
});

test('a Work projection epoch reset hides the previous statistics until replay completes', () => {
  const fx = setup();
  try {
    fx.answer('existing', 'first-answer', '2025-03-08T11:59:00.000Z');
    fx.sync();
    fx.view.refresh(scope, now);
    expect(fx.view.readStats(scope, '7d', 'UTC', now).data.activity.owner_decisions).toBe(1);
    fx.work.invalidateAfterRebuild(scope);
    expect(fx.view.readStats(scope, '7d', 'UTC', now)).toMatchObject({
      freshness: 'unknown', data: { activity: { owner_decisions: null } },
    });
    const time = new Date('2025-03-10T12:01:00.000Z');
    const work = fx.sync(time);
    expect(fx.view.refresh(scope, time)).toBe(false);
    expect(fx.view.refresh(scope, time)).toBe(true);
    expect(fx.view.readStats(scope, '7d', 'UTC', time)).toMatchObject({
      freshness: 'fresh', watermark: work.watermark, data: { activity: { owner_decisions: 1 } },
    });
  } finally { fx.cleanup(); }
});

test('an authoritative compensation seen before a delayed duplicate does not resurrect the original bucket', () => {
  const fx = setup();
  try {
    fx.emit('early-compensation', 'late-answer', { type: 'stats.fact.invalidated', kind: 'owner_decision', fact_key: 'late-answer' }, at);
    fx.answer('late', 'late-answer', '2025-03-08T01:00:00.000Z');
    fx.sync();
    fx.view.refresh(scope, now);
    expect(fx.view.readStats(scope, '7d', 'UTC', now).data.activity.owner_decisions).toBe(0);
  } finally { fx.cleanup(); }
});

test('a same-day ledger observation cannot establish seven-day activity coverage', () => {
  const fx = setup(false);
  try {
    fx.emit('initial-other-event', 'test', { type: 'channel.test.updated' }, '2025-03-10T08:00:00.000Z');
    fx.sync();
    fx.view.refresh(scope, now);
    expect(fx.view.readStats(scope, '7d', 'UTC', now)).toMatchObject({
      freshness: 'fresh',
      data: {
        coverage: { status: 'unknown', available_since: null, through: null },
        activity: { owner_decisions: null, automatic_decisions: null, delivered_work: null },
        stock: { active_standards: 0, knowledge_entries: 0, delegation_types: 0, active_delegation_types: 0 },
        work: { open: 2, awaiting_answer: 1, blocked: 1 },
      },
    });
  } finally { fx.cleanup(); }
});

test('a producer attestation establishes only its own covered period and watermark', () => {
  const fx = setup(false);
  try {
    fx.sync();
    fx.certify('owner_decision', { since: '2025-03-10T08:00:00.000Z', history: false });
    fx.certify('delivered_work', { hubSeq: 5 });
    fx.view.refresh(scope, now);
    const narrow = fx.view.readStats(scope, '7d', 'UTC', now);
    expect(narrow.data.activity).toEqual({ owner_decisions: null, delivered_work: null, automatic_decisions: null });
    expect(narrow.data.coverage).toMatchObject({ status: 'partial', by_activity: {
      owner_decision: { status: 'partial', available_since: '2025-03-10T08:00:00.000Z', through: at },
      delivered_work: { status: 'unknown' },
      automatic_decision: { status: 'unknown' },
    } });
    fx.certify('owner_decision', { since: '2025-03-04T00:00:00.000Z', history: false });
    fx.view.refresh(scope, now);
    expect(fx.view.readStats(scope, '7d', 'UTC', now).data.activity).toEqual({
      owner_decisions: 0, delivered_work: null, automatic_decisions: null,
    });
    expect(fx.view.readStats(scope, '30d', 'UTC', now).data.activity.owner_decisions).toBeNull();
    expect(fx.view.readStats(scope, 'all', 'UTC', now).data.window_start).toBeNull();
    expect(fx.view.readStats(scope, 'all', 'UTC', now).data.activity.owner_decisions).toBeNull();
  } finally { fx.cleanup(); }
});

test('a real-looking committed automation row does not make the producer covered when its witness is missing', () => {
  const fx = setup(false);
  try {
    fx.emit('advice-only', 'work-1', { type: 'decision.committed', decision_event_id: 'no-producer', grant_id: 'guess' }, at);
    fx.sync();
    fx.certify('owner_decision');
    fx.view.refresh(scope, now);
    expect(fx.view.readStats(scope, '7d', 'UTC', now).data).toMatchObject({
      activity: { owner_decisions: 0, automatic_decisions: null, delivered_work: null },
      coverage: { status: 'partial', by_activity: { automatic_decision: { status: 'unknown' } } },
    });
  } finally { fx.cleanup(); }
});

test('a March 10 producer proof cannot supply a March 28 activity count at the unchanged Work watermark', () => {
  const fx = setup(false);
  try {
    const work = fx.sync();
    fx.certify('owner_decision');
    fx.view.refresh(scope, now);
    const original = fx.view.readStats(scope, '30d', 'America/New_York', now);
    expect(original.data.activity.owner_decisions).toBe(0);
    expect(original.data.coverage.by_activity.owner_decision.status).toBe('complete');

    const later = new Date('2025-03-28T12:00:00.000Z');
    const elapsed = fx.view.readStats(scope, '30d', 'America/New_York', later);
    expect(elapsed).toMatchObject({ as_of: at, watermark: work.watermark, data: {
      window_end: '2025-03-29T04:00:00.000Z',
      activity: { owner_decisions: null },
      coverage: { by_activity: { owner_decision: { status: 'partial', through: at } } },
      stock: original.data.stock, work: original.data.work,
    } });

    // An offline read still gives the original historical window and its certified value.
    fx.sync(later, 'stale');
    expect(fx.view.readStats(scope, '30d', 'America/New_York', later)).toEqual({ ...original, freshness: 'stale' });

    fx.sync(later);
    fx.certify('owner_decision', { through: later.toISOString() });
    fx.view.refresh(scope, later);
    expect(fx.view.readStats(scope, '30d', 'America/New_York', later)).toMatchObject({
      freshness: 'fresh', as_of: later.toISOString(), watermark: work.watermark, data: {
        activity: { owner_decisions: 0, automatic_decisions: null },
        coverage: { by_activity: { owner_decision: { status: 'complete', through: later.toISOString() } } },
        stock: original.data.stock, work: original.data.work,
      },
    });
  } finally { fx.cleanup(); }
});

test('a proof ending before the published observation cannot certify its activity even on the same local day', () => {
  const fx = setup(false);
  try {
    fx.sync();
    fx.certify('owner_decision', { through: '2025-03-10T12:01:00.000Z' });
    const readAt = new Date('2025-03-10T12:02:00.000Z');
    fx.view.refresh(scope, readAt);
    expect(fx.view.readStats(scope, 'all', 'UTC', readAt)).toMatchObject({
      as_of: readAt.toISOString(), data: { activity: { owner_decisions: null },
        coverage: { by_activity: { owner_decision: { status: 'partial', through: '2025-03-10T12:01:00.000Z' } } } },
    });
  } finally { fx.cleanup(); }
});

test('the service observation publishes Stats and Work at the same watermark without certifying absent producers', () => {
  const fx = setup(false);
  try {
    const service = createProductViewService(fx.db, () => now);
    service.recordHubObservation({ hub_seq: 9, cards: [], runs: [] }, at);
    service.refresh(scope, true);
    const work = service.projection.readList(scope, { state: 'open' });
    const first = service.stats.readStats(scope, '7d', 'America/New_York', now);
    expect(first).toMatchObject({ freshness: 'fresh', watermark: work.watermark, data: { work: work.data.counts,
      activity: { automatic_decisions: null, owner_decisions: null, delivered_work: null } } });
    const changes = fx.db.prepare('SELECT total_changes() AS n').get();
    service.refresh(scope, true);
    expect(fx.db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    expect(service.stats.readStats(scope, '7d', 'America/New_York', now)).toEqual(first);
  } finally { fx.cleanup(); }
});
