import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createBlobStore, createRecoveryRuntimeGate, openDatabase } from '@patrick/storage';
import { storeHubView } from '@patrick/integrations/autoloop/observer';
import { NOTIFICATION_RULE, type HubJob } from '@patrick/integrations/autoloop/client';
import { createSourceRegistry } from '../../packages/integrations/sources/registry.js';
import { createDelegationApi } from '../../packages/domain/src/delegation.js';
import { createStandardsApi } from '../../packages/domain/src/standards.js';
import { createEffectRepository } from '../../packages/domain/src/effects.js';
import { createGitHubClient, createPrPublisher } from '../../packages/integrations/publisher/github.js';
import { createProductViewService } from '../../apps/service/src/product-views.js';
import { createNotificationMaintenance } from '../../apps/service/src/notification-maintenance.js';
import { notificationObservations, recordOwnerBlockerRequirement } from '../../apps/service/src/notification-source.js';
import { createNotifications, type NotificationPort } from '../../packages/domain/src/notifications.js';

const stamp = '2026-11-17T04:00:00.000Z';
const accountId = 'owner';
const domain = 'product';
const principal = { account_id: accountId, caller_id: 'service', auth_epoch: 1, domains: [domain], operations: ['owner'] };
const target = { owner: 'approved', repo: 'plans', repoId: '123', baseRef: 'main' };
const artifact = { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), treeSha: 'c'.repeat(40), title: 'Plan', body: 'Synthetic plan' };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });

async function scene() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t20-production-'));
  const db = openDatabase(join(root, 'ledger.sqlite'));
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  let clock = new Date(stamp);
  const now = () => clock;
  db.prepare('INSERT INTO accounts VALUES (?,1,1,?)').run(accountId, stamp);
  for (const permission of ['owner', 'publish_pr']) {
    db.prepare('INSERT INTO caller_scopes VALUES (?,?,?,?,NULL)').run(accountId, principal.caller_id, domain, permission);
  }
  const sourceRoot = join(root, 'source');
  mkdirSync(sourceRoot);
  writeFileSync(join(sourceRoot, 'demand.md'), 'Synthetic work request');
  const sources = createSourceRegistry(db, { blobs: createBlobStore(join(root, 'blobs')), now: () => now().toISOString() });
  const source = await sources.enableSource({ accountId, dataDomain: domain }, {
    type: 'directory', target: sourceRoot, hasTriggerRule: true, excludes: [], frequency: 'poll', history: 'none',
  });
  await sources.collectSource(source.sourceId, source.configRevision);
  const { event_id: workId } = db.prepare("SELECT event_id FROM outbox WHERE destination='source-work'").get() as { event_id: string };
  const delegation = createDelegationApi(db, principal, { domain, now });
  await createStandardsApi(db, principal, { domain, now }).seedProductDataset();
  const scope = { actions: ['judge', 'collect', 'publish_pr'], resources: ['work', 'github:123'],
    effects: ['publish_pr'], domains: [domain], risk: 'low', level: 'L1' as const, budget_micros: 5000 };
  await delegation.registerMandateType({ ...scope, type_id: 'type', config_version: 1 });
  await delegation.openMandate({ ...scope, mandate_id: 'mandate', type_id: 'type', expires_at: '2026-11-18T00:00:00Z' });
  await delegation.setCapability({ profile_id: 'profile', level: 'L2', actions: scope.actions,
    report_id: 'report', report_version: 1, config_version: 1 });
  await delegation.openWork({ work_id: workId, generation: 1, mandate_id: 'mandate', phase: 'delivery',
    next_action: 'publish_pr', budget_micros: 5000 });
  await delegation.setWorkGate(workId, 1, { evidence_ready: true });
  const grant = await delegation.authorizeAction({ work_id: workId, generation: 1, attempt_id: 'delivery', phase: 'delivery',
    next_action: 'publish_pr', allowed_effects: ['publish_pr'], expires_at: '2026-11-17T05:00:00Z' });
  const repository = createEffectRepository(db, principal, { target, domain, now,
    verifyBuild: async () => ({ artifact, patch: { path: 'plan.md', before: null, after: 'd'.repeat(40), digest: 'e'.repeat(64) } }),
  });
  await repository.prepareBuild({ workId, generation: 1, grant, artifact });
  const { intentId } = repository.freezePr({ workId, generation: 1, grant });
  const writes: string[] = [];
  const github = createGitHubClient({ fetch: async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://api.github.com');
    const path = url.pathname.replace('/repos/approved/plans', '');
    if (init?.method !== 'GET') writes.push(init?.method ?? '');
    if (!path) return Response.json({ id: 123, full_name: 'approved/plans' });
    if (path === '/pulls') return Response.json([]);
    if (path === '/git/ref/heads/main') {
      return Response.json({ ref: 'refs/heads/main', object: { type: 'commit', sha: artifact.baseSha } });
    }
    if (path.startsWith('/git/ref/heads/patrick/')) {
      return Response.json({ ref: 'refs/heads/' + path.slice('/git/ref/heads/'.length),
        object: { type: 'commit', sha: 'f'.repeat(40) } });
    }
    throw new Error('unexpected synthetic GitHub request: ' + path);
  } });
  expect(await createPrPublisher(repository, github).publishPr(intentId)).toMatchObject({ status: 'conflict', reason: 'fixed_branch_conflict' });
  expect(writes).toEqual([]);
  db.prepare(`INSERT INTO channel_connections(connection_id,account_id,data_domain,app_id,tenant_key,credential_ref,
    credential_version,config_revision,channel_incarnation,connection_epoch,binding_revision,current_pairing_id,current_test_id,
    owner_open_id,chat_id,status,transport_mode,schema_version,created_at,updated_at)
    VALUES ('connection',?,?,'app','tenant','fixture',1,1,1,1,1,'pair','test','owner-open','owner-chat','ready','active','1.0',?,?)`)
    .run(accountId, domain, stamp, stamp);
  db.prepare(`INSERT INTO channel_bindings VALUES ('binding','connection','pair',?,?,'owner-open','owner-chat','app','tenant',
    1,1,1,1,1,'1.0',?)`).run(accountId, domain, stamp);
  db.prepare(`INSERT INTO channel_tests(test_id,connection_id,account_id,data_domain,preview_hash,destination,status,message_id,inbound_evidence,
    app_id,tenant_key,config_revision,credential_version,binding_id,incarnation,epoch,schema_version,created_at,updated_at)
    VALUES ('test','connection',?,?,?,'owner-open','verified','fixture-message','fixture-inbound','app','tenant',1,1,'binding',1,1,'1.0',?,?)`)
    .run(accountId, domain, createHash('sha256').update('synthetic').digest('hex'), stamp, stamp);
  storeHubView(db, { hub_seq: 4, cards: [], runs: [] }, stamp);
  const views = createProductViewService(db, now);
  const refresh = () => views.refresh({ accountId, dataDomain: domain });
  refresh();
  expect(db.prepare('SELECT state FROM product_work_views WHERE work_id=?').get(workId)).toEqual({ state: 'blocked' });
  let run = 10;
  const hub = { claim: vi.fn(async (): Promise<HubJob> => ({ run: run++, token: 'synthetic-job', rule: { name: NOTIFICATION_RULE },
    context: { answers: [], events: [{ source: 'schedule', type: 'schedule.tick', subject: '', summary: '',
      id: NOTIFICATION_RULE + '@' + new Date(+now() + run * 60_000).toISOString() }] } })),
  heartbeat: vi.fn(async () => []), result: vi.fn(async () => ({ rejected: [] })) };
  const sent: string[] = [];
  const send = vi.fn<NotificationPort['send']>(async (delivery, beforeSend) => {
    beforeSend();
    sent.push(delivery.deliveryKey);
    return { outcome: 'delivered', deliveryKey: delivery.deliveryKey, evidence: 'synthetic-delivery' };
  });
  const lookup = vi.fn<NotificationPort['lookup']>(async () => ({ outcome: 'unknown' }));
  const observations = notificationObservations(db, { now, timezone: 'UTC', credentialUsable: () => true });
  const maintenance = () => createNotificationMaintenance(db, now, { hub, transport: { send, lookup },
    scopes: [{ accountId, dataDomain: domain }], timezone: 'UTC', credentialUsable: () => true });
  const intent = () => ({ accountId, domain, objectId: workId,
    eventVersion: (db.prepare('SELECT revision FROM product_work_views WHERE work_id=?').get(workId) as { revision: number }).revision,
    kind: 'blocker' as const, channel: 'feishu' as const, expiresAt: '2026-11-19T04:00:00.000Z' });
  const engine = () => createNotifications(db, { ...observations, now, transport: { send, lookup } });
  const blockRecovery = () => db.prepare(`INSERT INTO recovery_domain_gates
    (data_domain,writer_epoch,status,activation_id,witness_revision,updated_at) VALUES (?,'writer','open','activation','witness',?)
    ON CONFLICT(data_domain) DO UPDATE SET status='blocked'`).run(domain, stamp);
  const admitRecovery = () => {
    db.prepare("UPDATE recovery_domain_gates SET status='open'").run();
    const gate = createRecoveryRuntimeGate(db);
    gate.admit({ domain, writerEpoch: 'writer', activationId: 'activation', witnessRevision: 'witness' });
    return gate;
  };
  return { db, now, workId, intentId, sourceId: source.sourceId, views, refresh, maintenance, send, lookup, sent, observations,
    intent, engine, blockRecovery, admitRecovery, at: (value: string) => { clock = new Date(value); } };
}

test('real PR publication conflict produces one owner notification through default maintenance and projection refresh', async () => {
  const fixture = await scene();
  await fixture.maintenance().tick();
  expect(fixture.db.prepare(`SELECT COUNT(*) AS total FROM domain_events
    WHERE json_extract(payload,'$.type')='notification.blocker.requirement'`).get()).toEqual({ total: 1 });
  expect(fixture.sent).toEqual([]);
  expect(fixture.db.prepare('SELECT COUNT(*) AS total FROM notification_intents').get()).toEqual({ total: 0 });
  fixture.refresh();
  await fixture.maintenance().tick();
  const receipt = fixture.db.prepare('SELECT intent_id,status FROM notification_intents').get() as { intent_id: string; status: string };
  expect(receipt.status).toBe('sent');
  await fixture.maintenance().tick();
  expect(fixture.sent).toEqual([receipt.intent_id]);
  expect(fixture.db.prepare('SELECT COUNT(*) AS total FROM notification_attempts').get()).toEqual({ total: 1 });
});

test('an explicit current owner clear is preserved before the first conflict publication', async () => {
  const fixture = await scene();
  const workRevision = (fixture.db.prepare('SELECT revision FROM work_generations WHERE work_id=?').get(fixture.workId) as { revision: number }).revision;
  recordOwnerBlockerRequirement(fixture.db, principal, { factId: 'owner-cleared', domain, workId: fixture.workId, generation: 1,
    workRevision, viewRevision: fixture.intent().eventVersion, policyRevision: 1, needsOwner: false, reason: null }, fixture.now());
  fixture.refresh();
  await fixture.maintenance().tick();
  fixture.refresh();
  await fixture.maintenance().tick();
  expect(fixture.sent).toEqual([]);
  expect(fixture.db.prepare(`SELECT COUNT(*) AS total FROM domain_events
    WHERE json_extract(payload,'$.type')='notification.blocker.requirement'`).get()).toEqual({ total: 1 });
  expect(fixture.db.prepare('SELECT status FROM notification_intents').get()).toEqual({ status: 'digest' });
});

test.each(['reason', 'receipt', 'owner', 'account', 'domain', 'generation', 'attempt', 'source', 'policy', 'work', 'view', 'phase', 'receipt-time'] as const)(
  'a changed %s rejects the production conflict source at the final handoff', async (change) => {
    const fixture = await scene();
    await fixture.maintenance().tick();
    fixture.refresh();
    fixture.send.mockImplementationOnce(async (delivery, beforeSend) => {
      const updates = {
        reason: () => fixture.db.prepare("UPDATE effect_receipts SET reason='arbitrary_owner_input_error' WHERE intent_id=?").run(fixture.intentId),
        receipt: () => fixture.db.prepare("UPDATE effect_receipts SET status='blocked' WHERE intent_id=?").run(fixture.intentId),
        owner: () => fixture.db.prepare("UPDATE caller_scopes SET revoked_at=? WHERE permission='owner'").run(stamp),
        account: () => fixture.db.prepare('UPDATE accounts SET auth_epoch=2').run(),
        domain: () => fixture.db.prepare("UPDATE effect_intents SET data_domain='other' WHERE intent_id=?").run(fixture.intentId),
        generation: () => fixture.db.prepare('UPDATE effect_intents SET generation=0 WHERE intent_id=?').run(fixture.intentId),
        attempt: () => fixture.db.prepare("UPDATE work_generations SET current_attempt_id='replacement' WHERE work_id=?").run(fixture.workId),
        source: () => fixture.db.prepare('UPDATE source_configs SET enabled=0 WHERE source_id=?').run(fixture.sourceId),
        policy: () => fixture.db.prepare('UPDATE accounts SET policy_revision=2').run(),
        work: () => fixture.db.prepare('UPDATE work_generations SET revision=revision+1 WHERE work_id=?').run(fixture.workId),
        view: () => fixture.db.prepare('UPDATE product_work_views SET revision=revision+1 WHERE work_id=?').run(fixture.workId),
        phase: () => fixture.db.prepare("UPDATE work_generations SET phase='judgment',next_action='judge' WHERE work_id=?").run(fixture.workId),
        'receipt-time': () => fixture.db.prepare('UPDATE effect_receipts SET updated_at=? WHERE intent_id=?')
          .run('2026-11-17T04:00:01.000Z', fixture.intentId),
      };
      if (change === 'generation') fixture.db.pragma('foreign_keys = OFF');
      updates[change]();
      beforeSend();
      fixture.sent.push(delivery.deliveryKey);
      return { outcome: 'delivered', deliveryKey: delivery.deliveryKey, evidence: 'must-not-send' };
    });
    await fixture.maintenance().tick();
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.sent).toEqual([]);
    expect(fixture.db.prepare('SELECT handed_off_at FROM notification_attempts').all()).toEqual([{ handed_off_at: null }]);
  });

test('a conflict from a completed delivery phase cannot publish a fresh owner requirement', async () => {
  const fixture = await scene();
  fixture.db.prepare("UPDATE work_generations SET phase='judgment',next_action='judge',revision=revision+1 WHERE work_id=?").run(fixture.workId);
  fixture.refresh();
  await fixture.maintenance().tick();
  fixture.refresh();
  await fixture.maintenance().tick();
  expect(fixture.sent).toEqual([]);
  expect(fixture.db.prepare(`SELECT COUNT(*) AS total FROM domain_events
    WHERE json_extract(payload,'$.type')='notification.blocker.requirement'`).get()).toEqual({ total: 0 });
});

test.each(['dispatch_denied', 'arbitrary_owner_input_error', 'artifact_tree_mismatch'])(
  'an unrecognized PR conflict reason %s remains a digest', async (reason) => {
    const fixture = await scene();
    fixture.db.prepare('UPDATE effect_receipts SET reason=? WHERE intent_id=?').run(reason, fixture.intentId);
    await fixture.maintenance().tick();
    expect(fixture.sent).toEqual([]);
    expect(fixture.db.prepare('SELECT status FROM notification_intents').get()).toEqual({ status: 'digest' });
    expect(fixture.db.prepare(`SELECT COUNT(*) AS total FROM domain_events
      WHERE json_extract(payload,'$.type')='notification.blocker.requirement'`).get()).toEqual({ total: 0 });
  });

test('restored domain blocks fact publication and queue writes until runtime admission', async () => {
  const fixture = await scene();
  fixture.blockRecovery();
  const before = fixture.db.prepare('SELECT COUNT(*) AS total FROM domain_events').get();
  await fixture.maintenance().tick();
  expect(fixture.db.prepare('SELECT COUNT(*) AS total FROM domain_events').get()).toEqual(before);
  expect(() => fixture.engine().enqueue(fixture.intent())).toThrow('RECOVERY_WRITE_BLOCKED');
  const workRevision = (fixture.db.prepare('SELECT revision FROM work_generations WHERE work_id=?').get(fixture.workId) as { revision: number }).revision;
  expect(() => recordOwnerBlockerRequirement(fixture.db, principal, { factId: 'blocked-restored-fact', domain, workId: fixture.workId,
    generation: 1, workRevision, viewRevision: fixture.intent().eventVersion, policyRevision: 1,
    needsOwner: true, reason: 'owner_input_required' }, fixture.now())).toThrow('RECOVERY_WRITE_BLOCKED');
  fixture.admitRecovery();
  await fixture.maintenance().tick();
  fixture.refresh();
  await fixture.maintenance().tick();
  expect(fixture.sent).toHaveLength(1);
});

test('recovery revocation at handoff prevents delivery and freezes unhanded business receipts', async () => {
  const fixture = await scene();
  await fixture.maintenance().tick();
  fixture.refresh();
  fixture.blockRecovery();
  const gate = fixture.admitRecovery();
  fixture.send.mockImplementationOnce(async (delivery, beforeSend) => {
    gate.revoke(domain);
    beforeSend();
    fixture.sent.push(delivery.deliveryKey);
    return { outcome: 'delivered', deliveryKey: delivery.deliveryKey, evidence: 'must-not-send' };
  });
  await fixture.maintenance().tick();
  expect(fixture.sent).toEqual([]);
  expect(fixture.db.prepare('SELECT status FROM notification_intents').get()).toEqual({ status: 'sending' });
  expect(fixture.db.prepare('SELECT handed_off_at,finished_at FROM notification_attempts').all())
    .toEqual([{ handed_off_at: null, finished_at: null }]);
});

test('recovery is rechecked after the final preference read before recording a handoff', async () => {
  const fixture = await scene();
  await fixture.maintenance().tick();
  fixture.refresh();
  fixture.blockRecovery();
  const gate = fixture.admitRecovery();
  let preferencesRead = 0;
  const engine = createNotifications(fixture.db, { ...fixture.observations, now: fixture.now,
    transport: { send: fixture.send, lookup: fixture.lookup }, preferences: () => {
      if (++preferencesRead === 2) gate.revoke(domain);
      return { timezone: 'UTC', quiet: null };
    } });
  const intentId = engine.enqueue(fixture.intent());
  expect(await engine.dispatchNotification(intentId)).toMatchObject({ status: 'sending' });
  expect(fixture.sent).toEqual([]);
  expect(fixture.db.prepare('SELECT handed_off_at,finished_at FROM notification_attempts').all())
    .toEqual([{ handed_off_at: null, finished_at: null }]);
});

test('recovery denial keeps an existing pending intent unchanged without claiming a delivery', async () => {
  const fixture = await scene();
  const intentId = fixture.engine().enqueue(fixture.intent());
  fixture.blockRecovery();
  const changes = fixture.db.prepare('SELECT total_changes() AS total').get();
  expect(await fixture.engine().dispatchNotification(intentId)).toMatchObject({ status: 'pending', attempts: 0 });
  expect(fixture.db.prepare('SELECT total_changes() AS total').get()).toEqual(changes);
  expect(fixture.send).not.toHaveBeenCalled();
  expect(fixture.db.prepare('SELECT COUNT(*) AS total FROM notification_attempts').get()).toEqual({ total: 0 });
});

test('recovery denial preserves same-key read-only delivery reconciliation', async () => {
  const fixture = await scene();
  await fixture.maintenance().tick();
  fixture.refresh();
  fixture.send.mockImplementationOnce(async (_delivery, beforeSend) => { beforeSend(); throw new Error('synthetic response lost'); });
  await fixture.maintenance().tick();
  const row = fixture.db.prepare('SELECT intent_id,status FROM notification_intents').get() as { intent_id: string; status: string };
  expect(row.status).toBe('uncertain');
  fixture.blockRecovery();
  fixture.lookup.mockImplementationOnce(async ({ deliveryKey }) => ({ outcome: 'delivered', deliveryKey, evidence: 'synthetic-readback' }));
  expect(await fixture.engine().dispatchNotification(row.intent_id)).toMatchObject({ status: 'sent', attempts: 1 });
  expect(fixture.lookup.mock.calls[0][0].deliveryKey).toBe(row.intent_id);
  expect(fixture.send).toHaveBeenCalledTimes(1);
});
