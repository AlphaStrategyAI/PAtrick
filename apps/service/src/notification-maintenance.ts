import { createTaskLifetime } from './lifecycle.js';
import { randomUUID } from 'node:crypto';
import { type HubClient, type HubJob, NOTIFICATION_RULE, NOTIFICATION_WORKER } from '@patrick/integrations/autoloop/client';
import { recoveryWriteAllowed, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { createNotifications, type NotificationIntent, type NotificationPort } from '../../../packages/domain/src/notifications.js';
import { notificationObservations, publishPrOwnerBlockerRequirement } from './notification-source.js';

type Scope = { accountId: string; dataDomain: string };
export type NotificationMaintenanceOptions = {
  hub: Pick<HubClient, 'claim' | 'heartbeat' | 'result'>;
  transport: NotificationPort;
  credentialUsable(ref: string): boolean;
  timezone: string;
  scopes: readonly Scope[];
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
};

type Work = { work_id: string; revision: number; state: 'awaiting_answer' | 'researching' | 'verifying' | 'paused' | 'blocked' | 'delivered';
  updated_at: string; question_id: string | null; question_version: number | null; question_at: string | null };
type Claim = { hub_run: number; schedule_key: string; status: 'running' | 'done' | 'cancelled'; holder: string | null; lease_until: string | null };
const baseLeaseMs = 90_000;
const notificationLifetime = 48 * 60 * 60_000;
const pageSize = 8;
const boundary = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/u;

function scheduleKey(job: HubJob): string | null {
  if (!Number.isSafeInteger(job.run) || job.run < 1 || job.context.answers.length || job.context.timers?.length || !job.context.events.length) return null;
  const prefix = NOTIFICATION_RULE + '@';
  const keys = job.context.events.map(({ source, type, id }) => {
    const timestamp = id?.startsWith(prefix) ? id.slice(prefix.length) : '';
    return source === 'schedule' && type === 'schedule.tick' && boundary.test(timestamp) && Number.isFinite(Date.parse(timestamp))
      && new Date(timestamp).toISOString() === timestamp ? id! : null;
  });
  return keys.some((key) => key === null) ? null : keys.sort()[0]!;
}

export function createNotificationMaintenance(db: SqliteDatabase, now: () => Date, options: NotificationMaintenanceOptions) {
  const lifetime = createTaskLifetime(options.signal);
  options = { ...options, signal: lifetime.signal };
  if (options.scopes.length < 1 || options.scopes.length > 16) throw new Error('NOTIFICATION_SCOPE_INVALID');
  const scopes = options.scopes.map(({ accountId, dataDomain }) => {
    if (![accountId, dataDomain].every((s) => typeof s === 'string' && s.length >= 1 && s.length <= 160)) {
      throw new Error('NOTIFICATION_SCOPE_INVALID');
    }
    return { accountId, dataDomain };
  });
  if (new Set(scopes.map((scope) => JSON.stringify(scope))).size !== scopes.length) throw new Error('NOTIFICATION_SCOPE_INVALID');
  new Intl.DateTimeFormat('en-US', { timeZone: options.timezone });

  const read = db.prepare('SELECT * FROM notification_maintenance_runs WHERE hub_run=?');
  const byKey = db.prepare('SELECT * FROM notification_maintenance_runs WHERE schedule_key=?');
  const owner = randomUUID();
  const queued = db.prepare(`SELECT v.work_id,v.revision,v.state,v.updated_at,q.question_id,q.question_version,q.created_at AS question_at
    FROM product_work_views v LEFT JOIN question_bindings q ON v.state='awaiting_answer' AND q.rowid=(
      SELECT q2.rowid FROM question_bindings q2
      WHERE q2.account_id=v.account_id AND q2.data_domain=v.data_domain AND q2.work_id=v.work_id AND q2.status='open'
        AND q2.question_id=json_extract(v.payload,'$.question_id') AND q2.generation=json_extract(v.payload,'$.generation')
      ORDER BY q2.question_version DESC LIMIT 1)
    WHERE v.account_id=? AND v.data_domain=? AND v.visible=1 AND v.work_id>? ORDER BY v.work_id LIMIT ?`);
  const due = db.prepare(`SELECT intent_id FROM notification_intents WHERE account_id=? AND data_domain=? AND intent_id>?
    AND status IN ('pending','quiet','sending','uncertain','retry_wait')
    AND (next_at IS NULL OR next_at<=?) AND (lease_until IS NULL OR lease_until<=?) ORDER BY intent_id LIMIT ?`);
  const observations = notificationObservations(db, { now, timezone: options.timezone, credentialUsable: options.credentialUsable });
  const positions = scopes.map(() => ({ objects: '', receipts: '' }));
  let scopeIndex = 0;
  let running = false;
  let started = false;

  const bounded = (ms: number, signal?: AbortSignal) =>
    AbortSignal.any([AbortSignal.timeout(ms), ...[options.signal, signal].filter((signal): signal is AbortSignal => !!signal)]);
  function own(run: number) {
    const row = read.get(run) as Claim | undefined;
    return row?.holder === owner && !!row.lease_until && row.lease_until > now().toISOString() && row.status === 'running';
  }
  function acquire(run: number, key: string): Claim['status'] | 'busy' {
    const at = now();
    return withImmediateTransaction(db, () => {
      const scheduled = byKey.get(key) as Claim | undefined;
      const existing = read.get(run) as Claim | undefined;
      if (existing && existing.schedule_key !== key) throw new Error('NOTIFICATION_RUN_CONFLICT');
      if (scheduled && scheduled.hub_run !== run) return scheduled.status === 'running' ? 'busy' : scheduled.status;
      if (existing && existing.status !== 'running') return existing.status;
      if (existing && existing.holder !== owner && existing.lease_until! > at.toISOString()) return 'busy';
      db.prepare(`INSERT INTO notification_maintenance_runs(hub_run,schedule_key,status,holder,lease_until)
        VALUES (?,?,'running',?,?) ON CONFLICT(hub_run) DO UPDATE SET holder=excluded.holder,lease_until=excluded.lease_until`)
        .run(run, key, owner, new Date(+at + baseLeaseMs).toISOString());
      return 'running';
    });
  }
  function settle(run: number, status: 'done' | 'cancelled') {
    return withImmediateTransaction(db, () => {
      if (!own(run)) return false;
      return db.prepare(`UPDATE notification_maintenance_runs SET status=?,holder=NULL,lease_until=NULL
        WHERE hub_run=? AND holder=? AND status='running'`).run(status, run, owner).changes === 1;
    });
  }

  function register(scope: Scope, after: string, at: Date): string {
    if (!recoveryWriteAllowed(db, scope.dataDomain)) return after;
    const entries = queued.all(scope.accountId, scope.dataDomain, after, pageSize) as Work[];
    const engine = createNotifications(db, { ...observations, now });
    for (const entry of entries) {
      const isDecision = entry.state === 'awaiting_answer';
      if (isDecision && (entry.question_id === null || entry.question_version === null || !entry.question_at)) continue;
      const kind: NotificationIntent['kind'] = isDecision ? 'decision'
        : entry.state === 'paused' || entry.state === 'blocked' ? 'blocker' : entry.state === 'delivered' ? 'delivered' : 'progress';
      const created = Date.parse(isDecision ? entry.question_at! : entry.updated_at);
      if (!Number.isFinite(created) || created > +at || created + notificationLifetime <= +at) continue;
      const intent: NotificationIntent = { accountId: scope.accountId, domain: scope.dataDomain, kind,
        objectId: isDecision ? entry.question_id! : entry.work_id, eventVersion: isDecision ? entry.question_version! : entry.revision,
        channel: 'feishu', expiresAt: new Date(created + notificationLifetime).toISOString() };
      if (kind === 'blocker') publishPrOwnerBlockerRequirement(db, scope.accountId, scope.dataDomain, entry.work_id, at);
      const subject = observations.inspect(intent);
      if (subject?.current && subject.destination) {
        const intentId = engine.enqueue(intent);
        if (kind === 'blocker' && subject.needsOwner) {
          db.prepare("UPDATE notification_intents SET status='pending',updated_at=? WHERE intent_id=? AND status='digest'")
            .run(at.toISOString(), intentId);
        }
      }
    }
    return entries.length === pageSize ? entries.at(-1)!.work_id : '';
  }

  async function runTick() {
    if (running || options.signal?.aborted) return;
    running = true;
    try {
      const job = await options.hub.claim(NOTIFICATION_WORKER, bounded(4000));
      if (!job || options.signal?.aborted) return;
      if (job.rule.name !== NOTIFICATION_RULE) throw new Error('NOTIFICATION_WORKER_KEY_SCOPE');
      if (!Number.isSafeInteger(job.run) || job.run < 1 || !job.token) throw new Error('NOTIFICATION_JOB_INVALID');
      const key = scheduleKey(job);
      if (!key) {
        await options.hub.result(job.run, job.token, { outcome: 'nothing', summary: 'invalid maintenance envelope' }, bounded(4000));
        return;
      }
      const claim = acquire(job.run, key);
      if (claim === 'busy') return;
      if (claim === 'done' || claim === 'cancelled') {
        await options.hub.result(job.run, job.token, { outcome: claim }, bounded(4000));
        return;
      }
      if (job.cancelled) {
        if (settle(job.run, 'cancelled')) await options.hub.result(job.run, job.token, { outcome: 'cancelled' }, bounded(4000));
        return;
      }
      const abort = new AbortController();
      let cancelled = false;
      let timer: NodeJS.Timeout | undefined;
      async function heartbeat() {
        if (abort.signal.aborted || options.signal?.aborted) return;
        const cancel = await options.hub.heartbeat(NOTIFICATION_WORKER, job!.run, bounded(4000, abort.signal));
        if (cancel.includes(job!.run)) {
          cancelled = true;
          abort.abort();
        }
      }
      function watch() {
        if (abort.signal.aborted || options.signal?.aborted) return;
        timer = setTimeout(() => {
          void lifetime.track(heartbeat()).catch(() => abort.abort()).finally(watch);
        }, 5000);
        timer.unref();
      }
      try {
        await heartbeat();
        if (!abort.signal.aborted && !options.signal?.aborted && own(job.run)) {
          watch();
          const scope = scopes[scopeIndex];
          const position = positions[scopeIndex];
          scopeIndex = (scopeIndex + 1) % scopes.length;
          const at = now();
          position.objects = withImmediateTransaction(db, () => {
            if (!own(job.run)) return position.objects;
            return register(scope, position.objects, at);
          });
          const transport: NotificationPort = {
            send(delivery, beforeSend, signal) {
              return lifetime.track(options.transport.send(delivery, () => {
                if (!own(job.run) || abort.signal.aborted || options.signal?.aborted) throw new Error('NOTIFICATION_MAINTENANCE_LEASE');
                beforeSend();
              }, AbortSignal.any([signal, abort.signal, ...[options.signal].filter((signal): signal is AbortSignal => !!signal)])));
            },
            lookup: (delivery, signal) => lifetime.track(options.transport.lookup(delivery,
              AbortSignal.any([signal, abort.signal, ...[options.signal].filter((signal): signal is AbortSignal => !!signal)]))),
          };
          const engine = createNotifications(db, { ...observations, now, transport });
          const asOf = at.toISOString();
          const rows = due.all(scope.accountId, scope.dataDomain, position.receipts, asOf, asOf, 3) as { intent_id: string }[];
          for (const row of rows) {
            if (abort.signal.aborted || options.signal?.aborted || !own(job.run)) break;
            await engine.dispatchNotification(row.intent_id);
            position.receipts = row.intent_id;
          }
          if (rows.length < 3) position.receipts = '';
        }
        if ((cancelled || !abort.signal.aborted) && !options.signal?.aborted) {
          const status = cancelled ? 'cancelled' : 'done';
          if (settle(job.run, status)) await options.hub.result(job.run, job.token, { outcome: status }, bounded(4000));
        }
      } finally {
        abort.abort();
        clearTimeout(timer);
      }
    } finally { running = false; }
  }

  function tick() { return lifetime.run(runTick); }

  function start() {
    if (started || options.signal?.aborted) return;
    started = true;
    let timer: NodeJS.Timeout | undefined;
    options.signal?.addEventListener('abort', () => clearTimeout(timer), { once: true });
    function poll(wait: number) {
      if (options.signal?.aborted) return;
      timer = setTimeout(() => {
        void tick().catch((error: unknown) => {
          try { options.onError?.(error); } catch { /* Reporters must not stop claiming. */ }
        }).finally(() => poll(1000));
      }, wait);
      timer.unref();
    }
    poll(0);
  }
  return { start, tick, stop: lifetime.stop, join: lifetime.join, errors: lifetime.errors, get active() { return lifetime.active; } };
}
