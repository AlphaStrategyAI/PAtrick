import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { NOTIFICATION_RULE, NOTIFICATION_WORKER, type HubJob } from '@patrick/integrations/autoloop/client';
import { createNotificationMaintenance } from '../../apps/service/src/notification-maintenance.js';
import { storeHubView } from '@patrick/integrations/autoloop/observer';
import { appendDomainEvent, openDatabase, type MigrationEntry } from '@patrick/storage';
import { createDelegationApi } from '../../packages/domain/src/delegation.js';
import { notificationObservations, recordOwnerBlockerRequirement } from '../../apps/service/src/notification-source.js';
import { createNotifications, type NotificationPort, type NotificationSubject } from '../../packages/domain/src/notifications.js';

const request = { accountId: 'owner', domain: 'work', objectId: 'q-17', eventVersion: 4,
  kind: 'decision' as const, channel: 'feishu' as const, expiresAt: '2025-03-12T12:00:00.000Z' };
const target = { binding: 'a'.repeat(64), target: 'approved-recipient' };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t20-notify-'));
  const migrations = new URL('../../packages/storage/migrations/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', migrations), 'utf8')) as MigrationEntry[];
  const file = '0021_notifications.sql';
  const sha256 = createHash('sha256').update(readFileSync(new URL(file, migrations))).digest('hex');
  const db = openDatabase(join(root, 'ledger.sqlite'), { manifest: [...manifest.filter((entry) => entry.file !== file), { file, sha256 }] });
  let clock = new Date('2025-03-10T03:00:00.000Z');
  let quiet = { start: '22:00', end: '08:00' };
  let subject: NotificationSubject = { accountId: 'owner', domain: 'work', objectId: 'q-17', eventVersion: 4,
    current: true, needsOwner: true, subscribed: false, authEpoch: 1, destination: target };
  const lookup = vi.fn<NotificationPort['lookup']>().mockResolvedValue({ outcome: 'unknown' });
  const send = vi.fn<NotificationPort['send']>().mockImplementation(async (delivery, beforeSend) => {
    beforeSend();
    return { outcome: 'delivered', evidence: 'm-fixture', deliveryKey: delivery.deliveryKey };
  });
  const opts = { now: () => clock, inspect: () => subject, transport: { send, lookup },
    preferences: () => ({ timezone: 'America/New_York', quiet }), retryMs: 6000 };
  return { db, send, lookup, now: opts.now, open: () => createNotifications(db, opts), set: (value: Partial<NotificationSubject>) => { subject = { ...subject, ...value }; },
    quiet: (value: typeof quiet) => { quiet = value; },
    at: (iso: string) => { clock = new Date(iso); }, dispose: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('quiet hours do not send, and an answer before quiet ends cancels the same durable intent', async () => {
  const f = fixture();
  try {
    const n = f.open();
    const id = n.enqueue(request);
    expect(await n.dispatchNotification(id)).toMatchObject({ status: 'quiet', attempts: 0 });
    f.at('2025-03-10T12:00:00.000Z');
    f.set({ current: false });
    expect(await f.open().dispatchNotification(id)).toMatchObject({ status: 'superseded', attempts: 0 });
    expect(n.enqueue(request)).toBe(id);
    expect(await n.dispatchNotification(id)).toMatchObject({ status: 'superseded', attempts: 0 });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM domain_events').get()).toEqual({ n: 0 });
  } finally { f.dispose(); }
});

test('unknown delivery is reconciled after reopening, and verified absence alone permits retry of the same key', async () => {
  const f = fixture();
  try {
    f.at('2025-03-10T15:00:00.000Z');
    f.send.mockImplementationOnce(async (_delivery, beforeSend) => { beforeSend(); throw new Error('response lost'); });
    const id = f.open().enqueue(request);
    expect(await f.open().dispatchNotification(id)).toMatchObject({ status: 'uncertain', attempts: 1 });
    expect(await f.open().dispatchNotification(id)).toMatchObject({ status: 'uncertain', attempts: 1 });
    expect(f.send).toHaveBeenCalledTimes(1);
    f.lookup.mockImplementationOnce(async ({ deliveryKey }) => ({ outcome: 'not_delivered', deliveryKey, evidence: 'authoritative-miss' }));
    expect(await f.open().dispatchNotification(id)).toMatchObject({ status: 'retry_wait', attempts: 1 });
    expect(await f.open().dispatchNotification(id)).toMatchObject({ status: 'retry_wait', attempts: 1 });
    f.set({ availability: 'unavailable' });
    f.at('2025-03-10T15:00:01.000Z');
    expect(await f.open().dispatchNotification(id)).toMatchObject({ status: 'pending', attempts: 1 });
    f.set({ availability: 'verified' });
    f.at('2025-03-10T15:00:02.000Z');
    expect(await f.open().dispatchNotification(id)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(f.send).toHaveBeenCalledTimes(1);
    f.at('2025-03-10T15:00:07.000Z');
    const sent = await f.open().dispatchNotification(id);
    expect(sent).toMatchObject({ status: 'sent', attempts: 2 });
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[0][0].deliveryKey).toBe(f.send.mock.calls[1][0].deliveryKey);
    expect(await f.open().dispatchNotification(id)).toEqual(sent);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM domain_events').get()).toEqual({ n: 0 });
  } finally { f.dispose(); }
});

test('the final handoff rejects an effective binding change and no transport call crosses that fence', async () => {
  const f = fixture();
  try {
    f.at('2025-03-10T15:00:00.000Z');
    const write = vi.fn();
    f.send.mockImplementationOnce(async (delivery, beforeSend) => {
      f.set({ destination: { binding: 'b'.repeat(64), target: 'changed-recipient' } });
      beforeSend();
      write(delivery);
      return { outcome: 'delivered', deliveryKey: delivery.deliveryKey, evidence: 'should-not-send' };
    });
    const id = f.open().enqueue(request);
    expect(await f.open().dispatchNotification(id)).toMatchObject({ status: 'superseded', attempts: 1 });
    expect(write).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledTimes(1);
  } finally { f.dispose(); }
});

test.each(['unavailable', 'quiet'] as const)('repeated %s preflight deferrals preserve the four handoff budget and durable history', async (cause) => {
  const fixtureState = fixture();
  try {
    fixtureState.at('2025-03-10T15:00:00.000Z');
    fixtureState.send.mockImplementation(async (delivery, beforeSend) => {
      if (cause === 'unavailable') fixtureState.set({ availability: 'unavailable', current: false });
      else fixtureState.quiet({ start: '10:00', end: '12:00' });
      beforeSend();
      return { outcome: 'delivered', deliveryKey: delivery.deliveryKey, evidence: 'fixture' };
    });
    const id = fixtureState.open().enqueue(request);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      fixtureState.at('2025-03-10T15:00:00.000Z');
      fixtureState.set({ availability: 'verified', current: true });
      fixtureState.quiet({ start: '22:00', end: '08:00' });
      expect(await fixtureState.open().dispatchNotification(id)).toMatchObject({ status: cause === 'unavailable' ? 'pending' : 'quiet', attempts: attempt });
    }
    fixtureState.at('2025-03-10T15:00:00.000Z');
    fixtureState.set({ availability: 'verified', current: true });
    fixtureState.quiet({ start: '22:00', end: '08:00' });
    fixtureState.send.mockImplementation(async (delivery, beforeSend) => {
      beforeSend();
      return { outcome: 'not_delivered', deliveryKey: delivery.deliveryKey, evidence: 'authoritative-absence' };
    });
    for (let handoff = 1; handoff <= 4; handoff += 1) {
      fixtureState.at(`2025-03-10T15:00:${String(handoff * 7).padStart(2, '0')}.000Z`);
      expect(await fixtureState.open().dispatchNotification(id)).toMatchObject({ status: handoff === 4 ? 'blocked' : 'retry_wait', attempts: handoff + 5 });
    }
    expect(fixtureState.db.prepare('SELECT COUNT(*) AS n FROM notification_attempts WHERE intent_id=?').get(id)).toEqual({ n: 9 });
    expect(fixtureState.db.prepare('SELECT COUNT(*) AS n FROM notification_attempts WHERE intent_id=? AND handed_off_at IS NOT NULL').get(id)).toEqual({ n: 4 });
    expect(fixtureState.lookup).not.toHaveBeenCalled();
    expect(fixtureState.open().enqueue(request)).toBe(id);
    await fixtureState.open().dispatchNotification(id);
    expect(fixtureState.send).toHaveBeenCalledTimes(9);
  } finally { fixtureState.dispose(); }
});

test('a provider failure before its handoff remains retryable on the same intent without a delivery lookup', async () => {
  const fixtureState = fixture();
  try {
    fixtureState.at('2025-03-10T15:00:00.000Z');
    fixtureState.send.mockRejectedValueOnce(new Error('preflight unavailable'));
    const id = fixtureState.open().enqueue(request);
    expect(await fixtureState.open().dispatchNotification(id)).toMatchObject({ status: 'retry_wait', attempts: 1 });
    fixtureState.at('2025-03-10T15:00:07.000Z');
    expect(await fixtureState.open().dispatchNotification(id)).toMatchObject({ status: 'sent', attempts: 2 });
    expect(fixtureState.lookup).not.toHaveBeenCalled();
    expect(fixtureState.send.mock.calls.every(([delivery]) => delivery.deliveryKey === id)).toBe(true);
  } finally { fixtureState.dispose(); }
});

test('expired sending without a durable handoff retries after reopening while retaining the old preflight', async () => {
  const fixtureState = fixture();
  try {
    fixtureState.at('2025-03-10T15:00:00.000Z');
    const id = fixtureState.open().enqueue(request);
    fixtureState.db.prepare("UPDATE notification_intents SET status='sending',attempts=1,lease_until='2025-03-10T14:59:00.000Z' WHERE intent_id=?").run(id);
    fixtureState.db.prepare("INSERT INTO notification_attempts(intent_id,attempt,started_at) VALUES (?,1,'2025-03-10T14:58:00.000Z')").run(id);
    expect(await fixtureState.open().dispatchNotification(id)).toMatchObject({ status: 'retry_wait', attempts: 1 });
    fixtureState.at('2025-03-10T15:00:07.000Z');
    expect(await fixtureState.open().dispatchNotification(id)).toMatchObject({ status: 'sent', attempts: 2 });
    expect(fixtureState.lookup).not.toHaveBeenCalled();
    expect(fixtureState.db.prepare('SELECT attempt,handed_off_at,outcome FROM notification_attempts WHERE intent_id=? ORDER BY attempt').all(id))
      .toEqual([{ attempt: 1, handed_off_at: null, outcome: 'not_delivered' },
        { attempt: 2, handed_off_at: '2025-03-10T15:00:07.000Z', outcome: 'sent' }]);
  } finally { fixtureState.dispose(); }
});

test('an admitted handoff stays single use and an expired lease with that handoff still requires authoritative reconciliation', async () => {
  const fixtureState = fixture();
  try {
    fixtureState.at('2025-03-10T15:00:00.000Z');
    fixtureState.send.mockImplementationOnce(async (_delivery, beforeSend) => {
      beforeSend();
      expect(() => beforeSend()).toThrow('blocked');
      return { outcome: 'unknown' };
    });
    const id = fixtureState.open().enqueue(request);
    expect(await fixtureState.open().dispatchNotification(id)).toMatchObject({ status: 'uncertain', attempts: 1 });
    fixtureState.db.prepare("UPDATE notification_intents SET status='sending',lease_until='2025-03-10T14:59:00.000Z' WHERE intent_id=?").run(id);
    expect(await fixtureState.open().dispatchNotification(id)).toMatchObject({ status: 'uncertain', attempts: 1 });
    expect(fixtureState.db.prepare('SELECT COUNT(*) AS n FROM notification_attempts WHERE intent_id=? AND handed_off_at IS NOT NULL').get(id))
      .toEqual({ n: 1 });
    fixtureState.lookup.mockResolvedValueOnce({ outcome: 'delivered', deliveryKey: id, evidence: 'authoritative-delivered' });
    expect(await fixtureState.open().dispatchNotification(id)).toMatchObject({ status: 'sent', attempts: 1 });
    expect(fixtureState.send).toHaveBeenCalledTimes(1);
    expect(fixtureState.lookup).toHaveBeenCalledTimes(2);
  } finally { fixtureState.dispose(); }
});

test('a temporary loss of projection evidence does not supersede an otherwise current intent', async () => {
  const f = fixture();
  try {
    f.at('2025-03-10T15:00:00.000Z');
    const id = f.open().enqueue(request);
    f.set({ availability: 'unavailable', current: false });
    expect(await f.open().dispatchNotification(id)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(f.send).not.toHaveBeenCalled();
    f.set({ availability: 'verified', current: true });
    expect(await f.open().dispatchNotification(id)).toMatchObject({ status: 'sent', attempts: 1 });
  } finally { f.dispose(); }
});

test('current decision proof requires one verified T10 destination and excludes a locally answered question', async () => {
  const f = fixture();
  try {
    const timestamp = '2025-03-10T15:00:00.000Z';
    const now = () => new Date(timestamp);
    f.at(timestamp);
    const { db } = f;
    await seedCurrentQuestion(f, timestamp);
    const observed = notificationObservations(db, { now, timezone: 'America/New_York', credentialUsable: (ref) => ref === 'fixture-ref' });
    const withoutCredential = notificationObservations(db, { now, timezone: 'America/New_York', credentialUsable: () => false });
    expect(withoutCredential.inspect(request)).toMatchObject({ current: true, destination: null });
    expect(observed.inspect(request)).toMatchObject({ current: true, destination: { target: 'verified-connection' } });
    expect(observed.inspect({ ...request, domain: 'other' })).toBeNull();
    const notifications = createNotifications(db, { ...observed, now, transport: { send: f.send, lookup: f.lookup } });
    const id = notifications.enqueue(request);
    storeHubView(db, { hub_seq: 5, cards: [], runs: [] }, timestamp);
    expect(observed.inspect(request)).toMatchObject({ current: false, availability: 'unavailable' });
    expect(await notifications.dispatchNotification(id)).toMatchObject({ status: 'pending', attempts: 0 });
    db.prepare("UPDATE product_view_checkpoints SET hub_seq=5,observed_at=? WHERE account_id='owner'").run('2025-03-10T14:55:00.000Z');
    expect(observed.inspect(request)).toMatchObject({ current: true, availability: 'verified' });
    db.prepare(`INSERT INTO answer_receipts(receipt_id,intent_id,account_id,data_domain,question_id,question_version,work_id,
      generation,validity,disposition,hub_answer_event_id,result_revision,missing_json,schema_version,created_at)
      VALUES ('fixture-receipt','fixture-intent','owner','work','q-17',4,'scope-work',1,'verified','proceed','fixture-answer',1,'[]','1.0',?)`)
      .run(timestamp);
    expect(await notifications.dispatchNotification(id)).toMatchObject({ status: 'superseded', attempts: 0 });
    expect(f.send).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});

test('dedicated scheduled Hub runs register one scoped intent and replay the same receipt after an ack loss', async () => {
  const f = fixture();
  try {
    const timestamp = '2025-03-10T15:00:00.000Z';
    f.at(timestamp);
    await seedCurrentQuestion(f, timestamp);
    const { db, now } = f;
    const job = scheduledJob(7, timestamp);
    const fakeHub = {
      claim: vi.fn().mockResolvedValue(job),
      heartbeat: vi.fn().mockResolvedValue([]),
      result: vi.fn().mockRejectedValueOnce(new Error('ACK_LOST')).mockResolvedValue({ rejected: [] }),
    };
    const options = { hub: fakeHub, transport: { send: f.send, lookup: f.lookup },
      timezone: 'America/New_York', scopes: [{ accountId: 'owner', dataDomain: 'work' }],
      credentialUsable: (ref: string) => ref === 'fixture-ref' };
    const before = db.prepare('SELECT COUNT(*) AS n FROM domain_events').get();
    await expect(createNotificationMaintenance(db, now, options).tick()).rejects.toThrow('ACK_LOST');
    expect(db.prepare('SELECT object_id,event_version,status,attempts FROM notification_intents').all())
      .toEqual([{ object_id: 'q-17', event_version: 4, status: 'sent', attempts: 1 }]);
    expect(fakeHub.claim.mock.calls[0][0]).toBe(NOTIFICATION_WORKER);
    expect(f.send.mock.calls[0][0]).toMatchObject({ channel: 'feishu', accountId: 'owner', domain: 'work' });
    await createNotificationMaintenance(db, now, options).tick();
    expect(fakeHub.result.mock.calls.map((args) => args.slice(0, 3))).toEqual([
      [7, job.token, { outcome: 'done' }], [7, job.token, { outcome: 'done' }],
    ]);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM domain_events').get()).toEqual(before);
  } finally { f.dispose(); }
});

test.each(['required', 'nonowner', 'stale_revision', 'stale_view', 'stale_generation', 'stale_permission', 'stale_auth', 'revoked_caller', 'future', 'cleared'] as const)(
  'maintenance uses independently recorded %s blocker evidence before deciding whether to interrupt', async (proof) => {
    const fixtureState = fixture();
    try {
      const timestamp = '2025-03-10T15:00:00.000Z';
      fixtureState.at(timestamp);
      await seedCurrentQuestion(fixtureState, timestamp);
      fixtureState.db.prepare("UPDATE work_generations SET awaiting_answer=0,control_state='paused',revision=3 WHERE work_id='scope-work'").run();
      fixtureState.db.prepare("UPDATE product_work_views SET state='paused',revision=7 WHERE work_id='scope-work'").run();
      if (proof === 'revoked_caller') {
        fixtureState.db.prepare("INSERT INTO caller_scopes VALUES ('owner','former-owner','work','owner',?)").run(timestamp);
      }
      const fact = { type: 'notification.blocker.requirement', caller_id: 'web', generation: 1, work_revision: 3,
        view_revision: 7, auth_epoch: 1, policy_revision: 1, needs_owner: true, reason_code: 'owner_input_required', observed_at: timestamp };
      if (proof !== 'nonowner') {
        appendDomainEvent(fixtureState.db, { eventId: 'owner-blocker', aggregateId: 'scope-work', aggregateVersion: proof === 'stale_generation' ? 0 : 1,
          accountId: 'owner', dataDomain: 'work', destination: 'local', payload: { ...fact,
            work_revision: proof === 'stale_revision' ? 2 : 3,
            view_revision: proof === 'stale_view' ? 6 : 7, auth_epoch: proof === 'stale_auth' ? 0 : 1,
            observed_at: proof === 'future' ? '2025-03-11T15:00:00.000Z' : timestamp,
            policy_revision: proof === 'stale_permission' ? 0 : 1,
            caller_id: proof === 'revoked_caller' ? 'former-owner' : 'web' } });
        if (proof === 'cleared') appendDomainEvent(fixtureState.db, { eventId: 'cleared-blocker', aggregateId: 'scope-work', aggregateVersion: 1,
          accountId: 'owner', dataDomain: 'work', destination: 'local', payload: { ...fact, needs_owner: false, reason_code: null } });
      }
      fixtureState.db.prepare('UPDATE product_view_checkpoints SET domain_seq=(SELECT COALESCE(MAX(seq),0) FROM domain_events)').run();
      const hub = { claim: vi.fn().mockResolvedValue(scheduledJob(9, timestamp)), heartbeat: vi.fn().mockResolvedValue([]),
        result: vi.fn().mockResolvedValue({ rejected: [] }) };
      const options = { hub, transport: { send: fixtureState.send, lookup: fixtureState.lookup }, timezone: 'America/New_York',
        scopes: [{ accountId: 'owner', dataDomain: 'work' }], credentialUsable: () => true };
      await createNotificationMaintenance(fixtureState.db, fixtureState.now, options).tick();
      await createNotificationMaintenance(fixtureState.db, fixtureState.now, options).tick();
      expect(fixtureState.db.prepare('SELECT object_id,event_version,kind,status FROM notification_intents').all()).toEqual([
        { object_id: 'scope-work', event_version: 7, kind: 'blocker', status: proof === 'required' ? 'sent' : 'digest' },
      ]);
      expect(fixtureState.send).toHaveBeenCalledTimes(proof === 'required' ? 1 : 0);
    } finally { fixtureState.dispose(); }
  },
);

test('recorded owner blocker facts replay durably and promote an existing digest through maintenance on the same intent', async () => {
  const fixtureState = fixture();
  try {
    const timestamp = '2025-03-10T15:00:00.000Z';
    fixtureState.at(timestamp);
    await seedCurrentQuestion(fixtureState, timestamp);
    fixtureState.db.prepare("UPDATE work_generations SET awaiting_answer=0,control_state='paused',revision=3 WHERE work_id='scope-work'").run();
    fixtureState.db.prepare("UPDATE product_work_views SET state='paused',revision=7 WHERE work_id='scope-work'").run();
    const hub = { claim: vi.fn().mockResolvedValueOnce(scheduledJob(10, timestamp))
      .mockResolvedValueOnce(scheduledJob(11, '2025-03-10T15:01:00.000Z'))
      .mockResolvedValue(scheduledJob(12, '2025-03-10T15:02:00.000Z')), heartbeat: vi.fn().mockResolvedValue([]),
    result: vi.fn().mockResolvedValue({ rejected: [] }) };
    const options = { hub, transport: { send: fixtureState.send, lookup: fixtureState.lookup }, timezone: 'America/New_York',
      scopes: [{ accountId: 'owner', dataDomain: 'work' }], credentialUsable: () => true };
    await createNotificationMaintenance(fixtureState.db, fixtureState.now, options).tick();
    const before = fixtureState.db.prepare('SELECT intent_id,status FROM notification_intents').get() as { intent_id: string; status: string };
    expect(before.status).toBe('digest');
    const principal = { account_id: 'owner', caller_id: 'web', auth_epoch: 1, domains: ['work'], operations: ['owner'] };
    const fact = { factId: 'owner-blockage', domain: 'work', workId: 'scope-work', generation: 1,
      workRevision: 3, viewRevision: 7, policyRevision: 1, needsOwner: true, reason: 'owner_input_required' as const };
    const eventId = recordOwnerBlockerRequirement(fixtureState.db, principal, fact, fixtureState.now());
    expect(recordOwnerBlockerRequirement(fixtureState.db, principal, fact, new Date('2025-03-10T15:00:01.000Z'))).toBe(eventId);
    expect(fixtureState.db.prepare('SELECT COUNT(*) AS n FROM domain_events WHERE event_id=?').get(eventId)).toEqual({ n: 1 });
    await createNotificationMaintenance(fixtureState.db, fixtureState.now, options).tick();
    expect(fixtureState.send).not.toHaveBeenCalled();
    fixtureState.db.prepare('UPDATE product_view_checkpoints SET domain_seq=(SELECT MAX(seq) FROM domain_events)').run();
    await createNotificationMaintenance(fixtureState.db, fixtureState.now, options).tick();
    expect(fixtureState.db.prepare('SELECT intent_id,status FROM notification_intents').all()).toEqual([{ intent_id: before.intent_id, status: 'sent' }]);
    expect(fixtureState.send).toHaveBeenCalledTimes(1);
    expect(() => recordOwnerBlockerRequirement(fixtureState.db, { ...principal, caller_id: 'ungranted' }, { ...fact, factId: 'forged' }, fixtureState.now()))
      .toThrow('NOTIFICATION_BLOCKER_FACT_STALE');
    expect(() => recordOwnerBlockerRequirement(fixtureState.db, principal, { ...fact, factId: 'stale', workRevision: 2 }, fixtureState.now()))
      .toThrow('NOTIFICATION_BLOCKER_FACT_STALE');
    expect(() => recordOwnerBlockerRequirement(fixtureState.db, principal, { ...fact, factId: 'stale-policy', policyRevision: 0 }, fixtureState.now()))
      .toThrow('NOTIFICATION_BLOCKER_FACT_STALE');
    expect(() => recordOwnerBlockerRequirement(fixtureState.db, principal, { ...fact, needsOwner: false, reason: null }, fixtureState.now()))
      .toThrow('NOTIFICATION_BLOCKER_FACT_CONFLICT');
  } finally { fixtureState.dispose(); }
});

test.each(['paused', 'blocked'] as const)('maintenance rechecks %s owner blocker authority at the final handoff', async (state) => {
  const fixtureState = fixture();
  try {
    const timestamp = '2025-03-10T15:00:00.000Z';
    fixtureState.at(timestamp);
    await seedCurrentQuestion(fixtureState, timestamp);
    fixtureState.db.prepare("UPDATE work_generations SET awaiting_answer=0,control_state='paused',revision=3 WHERE work_id='scope-work'").run();
    fixtureState.db.prepare('UPDATE product_work_views SET state=?,revision=7 WHERE work_id=?').run(state, 'scope-work');
    recordOwnerBlockerRequirement(fixtureState.db, { account_id: 'owner', caller_id: 'web', auth_epoch: 1, domains: ['work'], operations: ['owner'] },
      { factId: 'owner-blockage', domain: 'work', workId: 'scope-work', generation: 1, workRevision: 3, viewRevision: 7, policyRevision: 1,
        needsOwner: true, reason: 'owner_authorization_required' }, fixtureState.now());
    fixtureState.db.prepare('UPDATE product_view_checkpoints SET domain_seq=(SELECT MAX(seq) FROM domain_events)').run();
    const write = vi.fn();
    fixtureState.send.mockImplementation(async (delivery, beforeSend) => {
      fixtureState.db.prepare("UPDATE work_generations SET revision=4 WHERE work_id='scope-work'").run();
      beforeSend();
      write();
      return { outcome: 'delivered', deliveryKey: delivery.deliveryKey, evidence: 'should-not-send' };
    });
    const hub = { claim: vi.fn().mockResolvedValue(scheduledJob(12, timestamp)), heartbeat: vi.fn().mockResolvedValue([]),
      result: vi.fn().mockResolvedValue({ rejected: [] }) };
    await createNotificationMaintenance(fixtureState.db, fixtureState.now, { hub, transport: { send: fixtureState.send, lookup: fixtureState.lookup },
      timezone: 'America/New_York', scopes: [{ accountId: 'owner', dataDomain: 'work' }], credentialUsable: () => true }).tick();
    expect(fixtureState.send).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(fixtureState.db.prepare('SELECT handed_off_at FROM notification_attempts').all()).toEqual([{ handed_off_at: null }]);
    expect(fixtureState.db.prepare('SELECT status FROM notification_intents').get()).toEqual({ status: 'superseded' });
  } finally { fixtureState.dispose(); }
});

test('replacing the current pairing invalidates a formerly verified notification destination before delivery', async () => {
  const f = fixture();
  try {
    const timestamp = '2025-03-10T15:00:00.000Z';
    f.at(timestamp);
    await seedCurrentQuestion(f, timestamp);
    const observed = notificationObservations(f.db, { now: f.now, timezone: 'America/New_York', credentialUsable: () => true });
    const notifications = createNotifications(f.db, { ...observed, now: f.now, transport: { send: f.send, lookup: f.lookup } });
    const intentId = notifications.enqueue(request);
    f.db.prepare("UPDATE channel_connections SET current_pairing_id='replacement-pair'").run();
    expect(observed.inspect(request)).toMatchObject({ current: true, destination: null });
    expect(await notifications.dispatchNotification(intentId)).toMatchObject({ status: 'superseded', attempts: 0 });
    expect(f.send).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});

test('cancelled and foreign Hub claims never register or dispatch business work', async () => {
  const f = fixture();
  try {
    const timestamp = '2025-03-10T15:00:00.000Z';
    f.at(timestamp);
    await seedCurrentQuestion(f, timestamp);
    const job = scheduledJob(8, timestamp);
    const hub = {
      claim: vi.fn().mockResolvedValueOnce({ ...job, rule: { name: '咨询' } }).mockResolvedValueOnce({ ...job, cancelled: true }),
      heartbeat: vi.fn().mockResolvedValue([]),
      result: vi.fn().mockResolvedValue({ rejected: [] }),
    };
    const worker = createNotificationMaintenance(f.db, f.now, { hub, transport: { send: f.send, lookup: f.lookup },
      scopes: [{ accountId: 'owner', dataDomain: 'work' }], timezone: 'America/New_York', credentialUsable: () => true });
    await expect(worker.tick()).rejects.toThrow('NOTIFICATION_WORKER_KEY_SCOPE');
    expect(hub.result).not.toHaveBeenCalled();
    await worker.tick();
    expect(hub.result.mock.calls[0].slice(0, 3)).toEqual([8, job.token, { outcome: 'cancelled' }]);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM notification_intents').get()).toEqual({ n: 0 });
    expect(f.send).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});

function scheduledJob(run: number, timestamp: string): HubJob {
  return { run, token: 'run-token-for-test', rule: { name: NOTIFICATION_RULE },
    context: { answers: [], events: [{ source: 'schedule', type: 'schedule.tick', subject: '', summary: '',
      id: NOTIFICATION_RULE + '@' + timestamp }] } };
}

async function seedCurrentQuestion({ db, now }: ReturnType<typeof fixture>, timestamp: string) {
  db.prepare("INSERT INTO accounts VALUES ('owner',1,1,?)").run(timestamp);
  db.prepare("INSERT INTO caller_scopes VALUES ('owner','web','work','owner',NULL)").run();
  const grants = createDelegationApi(db, { account_id: 'owner', caller_id: 'web', auth_epoch: 1, domains: ['work'], operations: ['owner'] },
    { domain: 'work', now });
  const permission = { actions: ['judge'], resources: ['work'], effects: [], domains: ['work'],
    risk: 'low' as const, level: 'L1' as const, budget_micros: 1000 };
  await grants.registerMandateType({ ...permission, type_id: 'notify-test', config_version: 1 });
  await grants.openMandate({ ...permission, mandate_id: 'grant', type_id: 'notify-test', expires_at: request.expiresAt });
  await grants.openWork({ work_id: 'scope-work', generation: 1, mandate_id: 'grant', phase: 'judgment', next_action: 'judge', budget_micros: 1000 });
  db.prepare("UPDATE work_generations SET awaiting_answer=1 WHERE work_id='scope-work'").run();
  db.prepare(`INSERT INTO question_bindings(question_id,question_version,work_id,generation,account_id,data_domain,proposal_revision,
    options_hash,hub_card_id,judgment_basis_hash,options_json,custom_rules_json,custom_allowed,status,withdrawal_watermark,schema_version,
    revision,created_at,updated_at) VALUES ('q-17',4,'scope-work',1,'owner','work',1,?,71,?,'[]','{}',0,'open',0,'1.0',4,?,?)`)
    .run('a'.repeat(64), 'b'.repeat(64), timestamp, timestamp);
  db.prepare(`INSERT INTO product_view_checkpoints(account_id,data_domain,epoch,hub_seq,domain_seq,notification_seq,notification_floor,
    observed_at,trusted_as_of,freshness) VALUES ('owner','work',1,4,0,1,0,?,?,'fresh')`).run(timestamp, timestamp);
  db.prepare(`INSERT INTO product_work_views VALUES ('owner','work','scope-work',1,1,'awaiting_answer',?,?)`)
    .run(timestamp, JSON.stringify({ question_id: 'q-17', generation: 1 }));
  storeHubView(db, { hub_seq: 4, cards: [], runs: [] }, timestamp);
  db.prepare(`INSERT INTO channel_connections(connection_id,account_id,data_domain,app_id,tenant_key,credential_ref,
    credential_version,config_revision,channel_incarnation,connection_epoch,binding_revision,current_pairing_id,current_test_id,owner_open_id,chat_id,status,
    transport_mode,schema_version,created_at,updated_at)
    VALUES ('verified-connection','owner','work','app','tenant','fixture-ref',1,1,1,1,1,'fixture-pair','fixture-test','owner-open','owner-chat',
    'ready','active','1.0',?,?)`).run(timestamp, timestamp);
  db.prepare(`INSERT INTO channel_bindings VALUES
    ('verified-binding','verified-connection','fixture-pair','owner','work','owner-open','owner-chat','app','tenant',1,1,1,1,1,'1.0',?)`).run(timestamp);
  db.prepare(`INSERT INTO channel_tests(test_id,connection_id,account_id,data_domain,preview_hash,destination,status,message_id,inbound_evidence,
    app_id,tenant_key,config_revision,credential_version,binding_id,incarnation,epoch,schema_version,created_at,updated_at)
    VALUES ('fixture-test','verified-connection','owner','work',?,'owner-open','verified','fixture-message','fixture-reply','app','tenant',
    1,1,'verified-binding',1,1,'1.0',?,?)`).run('c'.repeat(64), timestamp, timestamp);
}
