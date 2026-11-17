import { createHash } from 'node:crypto';
import { assertRecoveryWriteAllowed, recoveryWriteAllowed, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';

export type NotificationSignal = { current: boolean; kind: 'decision' | 'blocker' | 'delivered' | 'progress'; needsOwner: boolean; subscribed: boolean };
export function interrupts(signal: NotificationSignal): boolean {
  return signal.current && (((signal.kind === 'decision' || signal.kind === 'blocker') && signal.needsOwner) ||
    (signal.kind === 'delivered' && signal.subscribed));
}

type Channel = 'feishu';
export type NotificationIntent = Pick<NotificationSignal, 'kind'> & { accountId: string; domain: string; objectId: string;
  eventVersion: number; channel: Channel; expiresAt: string };
export type NotificationSubject = Pick<NotificationIntent, 'accountId' | 'domain' | 'objectId' | 'eventVersion'> &
  Omit<NotificationSignal, 'kind'> & { availability?: 'verified' | 'unavailable'; authEpoch: number; destination: { binding: string; target: string } | null };
type Target = NonNullable<NotificationSubject['destination']>;
export type QuietPreferences = { timezone: string; quiet: { start: string; end: string } | null };
type Observation = { outcome: 'unknown' } | { outcome: 'delivered' | 'not_delivered'; deliveryKey: string; evidence: string };
type Lookup = { deliveryKey: string; accountId: string; domain: string; channel: Channel; binding: string };
type Delivery = Lookup & { kind: NotificationIntent['kind']; destination: string };
export type NotificationPort = {
  send(delivery: Readonly<Delivery>, beforeSend: () => void, signal: AbortSignal): Promise<Observation>;
  lookup(delivery: Readonly<Lookup>, signal: AbortSignal): Promise<Observation>;
};
type Status = 'pending' | 'quiet' | 'digest' | 'sending' | 'uncertain' | 'retry_wait' | 'sent' | 'superseded' | 'blocked';
type Receipt = { intentId: string; status: Status; attempts: number; checkedAt: string; evidenceHash: string | null };
type Row = {
  intent_id: string; account_id: string; data_domain: string; object_id: string; event_version: number;
  kind: NotificationIntent['kind']; channel: Channel; expires_at: string; binding_hash: string; auth_epoch: number;
  status: Status; attempts: number; next_at: string | null; lease_until: string | null; evidence_hash: string | null; updated_at: string;
};
type Options = {
  now?: () => Date;
  inspect(intent: Readonly<NotificationIntent>): NotificationSubject | null;
  preferences(accountId: string): QuietPreferences;
  transport?: NotificationPort;
  retryMs?: number;
};
const leaseMs = 60_000;
const maximumAttempts = 4;
const sha = (data: string) => createHash('sha256').update(data).digest('hex');
const field = (input: string) => typeof input === 'string' && input.length >= 1 && input.length <= 160 && ![...input].some((point) => point.charCodeAt(0) < 32 || point.charCodeAt(0) === 127);
const binding = (input: string) => /^[a-f0-9]{64}$/u.test(input);
const minute = (input: string) => /^([01][0-9]|2[0-3]):[0-5][0-9]$/u.test(input);
const settled = new Set<Status>(['sent', 'superseded', 'blocked', 'digest']);
class HandoffClosed extends Error {
  constructor(readonly status: 'pending' | 'quiet' | 'superseded' | 'blocked') { super(status); }
}
export function createNotifications(db: SqliteDatabase, options: Options) {
  const { transport } = options;
  const now = options.now ?? (() => new Date());
  const retryMs = options.retryMs ?? 30_000;
  if (!Number.isSafeInteger(retryMs) || retryMs < 3000 || retryMs > 600_000) throw new Error('NOTIFICATION_RETRY_INVALID');
  const byId = db.prepare('SELECT * FROM notification_intents WHERE intent_id=?');
  const handedOff = db.prepare('SELECT COUNT(*) AS total FROM notification_attempts WHERE intent_id=? AND handed_off_at IS NOT NULL');
  const handoffBudgetUsed = (row: Row) => (handedOff.get(row.intent_id) as { total: number }).total >= maximumAttempts;
  const find = (id: string) => byId.get(id) as Row | undefined;
  function load(id: string): Row {
    const row = find(id);
    if (!row) throw new Error('NOTIFICATION_NOT_FOUND');
    return row;
  }
  const receipt = (row: Row): Receipt => ({ intentId: row.intent_id, status: row.status,
    attempts: row.attempts, checkedAt: row.updated_at, evidenceHash: row.evidence_hash });
  const toIntent = (row: Row): NotificationIntent => ({ accountId: row.account_id, domain: row.data_domain, objectId: row.object_id,
    eventVersion: row.event_version, kind: row.kind, channel: row.channel, expiresAt: row.expires_at });
  const query = (row: Row): Lookup => ({ deliveryKey: row.intent_id, accountId: row.account_id, domain: row.data_domain,
    channel: row.channel, binding: row.binding_hash });

  function assess(row: Row, at: Date): { status: 'send'; target: Target } | { status: 'pending' | 'quiet' | 'digest' | 'superseded' | 'blocked' } {
    if (!recoveryWriteAllowed(db, row.data_domain)) return { status: 'pending' };
    if (row.expires_at <= at.toISOString()) return { status: 'superseded' };
    const subject = options.inspect(toIntent(row));
    if (!matches(row, subject) || !subject.destination ||
        subject.destination.binding !== row.binding_hash || !field(subject.destination.target) || subject.authEpoch !== row.auth_epoch) {
      return { status: 'superseded' };
    }
    if (subject.availability === 'unavailable') return { status: 'pending' };
    if (!subject.current) return { status: 'superseded' };
    const eligible = interrupts({ ...subject, kind: row.kind });
    const prefs = options.preferences(subject.accountId);
    try {
      if (!eligible) return { status: 'digest' };
      if (!transport) return { status: 'blocked' };
      if (inQuietHours(at, prefs)) return { status: 'quiet' };
      return { status: 'send', target: subject.destination };
    } catch { return { status: 'blocked' }; }
  }

  function update(row: Row, status: Status, at: Date, nextAt: string | null = null, evidence: string | null = null): Row {
    if (row.status === status && row.next_at === nextAt && row.evidence_hash === evidence) return row;
    db.prepare('UPDATE notification_intents SET status=?,next_at=?,lease_until=NULL,evidence_hash=?,updated_at=? WHERE intent_id=?')
      .run(status, nextAt, evidence, at.toISOString(), row.intent_id);
    return load(row.intent_id);
  }

  function finish(row: Row, result: 'sent' | 'uncertain' | 'not_delivered' | 'superseded' | 'blocked', at: Date, evidence: string | null = null): void {
    db.prepare('UPDATE notification_attempts SET outcome=?,finished_at=?,evidence_hash=? WHERE intent_id=? AND attempt=?')
      .run(result, at.toISOString(), evidence, row.intent_id, row.attempts);
  }

  function recordObservation(row: Row, outcome: Observation, at: Date): Row {
    const checked = outcome.outcome !== 'unknown' && outcome.deliveryKey === row.intent_id && field(outcome.evidence) ? outcome : null;
    if (!checked) {
      if (row.status === 'uncertain') return row;
      finish(row, 'uncertain', at);
      return update(row, 'uncertain', at);
    }
    const evidence = sha(checked.evidence);
    if (checked.outcome === 'delivered') {
      finish(row, 'sent', at, evidence);
      return update(row, 'sent', at, null, evidence);
    }
    finish(row, 'not_delivered', at, evidence);
    return handoffBudgetUsed(row)
      ? update(row, 'blocked', at, null, evidence)
      : update(row, 'retry_wait', at, new Date(+at + retryMs).toISOString(), evidence);
  }

  return {
    enqueue(intent: NotificationIntent): string {
      if (![intent.accountId, intent.domain, intent.objectId].every(field) || !Number.isSafeInteger(intent.eventVersion) || intent.eventVersion < 0 ||
          !['decision', 'blocker', 'delivered', 'progress'].includes(intent.kind) || intent.channel !== 'feishu' ||
          !Number.isFinite(Date.parse(intent.expiresAt)) || new Date(intent.expiresAt).toISOString() !== intent.expiresAt) {
        throw new Error('NOTIFICATION_INTENT_INVALID');
      }
      const id = 'notification_' + sha(JSON.stringify([intent.accountId, intent.domain, intent.objectId, intent.eventVersion, intent.channel]));
      return withImmediateTransaction(db, () => {
        assertRecoveryWriteAllowed(db, intent.domain);
        const existing = find(id);
        if (existing) {
          if (existing.kind !== intent.kind || existing.expires_at !== intent.expiresAt) throw new Error('NOTIFICATION_INTENT_CONFLICT');
          return id;
        }
        const subject = options.inspect(intent);
        if (!subject || subject.accountId !== intent.accountId || subject.domain !== intent.domain || subject.objectId !== intent.objectId ||
            subject.eventVersion !== intent.eventVersion || !Number.isSafeInteger(subject.authEpoch) || subject.authEpoch < 1 ||
            !subject.destination || !binding(subject.destination.binding)) throw new Error('NOTIFICATION_UNAUTHORIZED');
        assertRecoveryWriteAllowed(db, intent.domain);
        db.prepare(`INSERT INTO notification_intents(intent_id,account_id,data_domain,object_id,event_version,kind,channel,auth_epoch,binding_hash,expires_at,status,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?)`).run(id, intent.accountId, intent.domain, intent.objectId, intent.eventVersion,
          intent.kind, intent.channel, subject.authEpoch, subject.destination.binding, intent.expiresAt, now().toISOString());
        return id;
      });
    },

    readScoped(accountId: string, domain: string, intentId: string): Receipt {
      const row = load(intentId);
      if (row.account_id !== accountId || row.data_domain !== domain) throw new Error('NOTIFICATION_NOT_FOUND');
      return receipt(row);
    },

    async dispatchNotification(intentId: string): Promise<Receipt> {
      const claim = withImmediateTransaction(db, () => {
        const at = now();
        const row = load(intentId);
        if (settled.has(row.status) || (row.status === 'sending' && row.lease_until && row.lease_until > at.toISOString())) {
          return { action: 'none' as const, row };
        }
        if (!recoveryWriteAllowed(db, row.data_domain) && row.status !== 'uncertain') {
          const prior = db.prepare('SELECT handed_off_at FROM notification_attempts WHERE intent_id=? AND attempt=?')
            .get(intentId, row.attempts) as { handed_off_at: string | null } | undefined;
          if (row.status !== 'sending' || prior?.handed_off_at === null) return { action: 'none' as const, row };
        }
        if (row.status === 'sending') {
          const attempt = db.prepare('SELECT handed_off_at FROM notification_attempts WHERE intent_id=? AND attempt=?')
            .get(intentId, row.attempts) as { handed_off_at: string | null } | undefined;
          if (attempt?.handed_off_at === null) {
            finish(row, 'not_delivered', at);
            return { action: 'none' as const, row: update(row, 'retry_wait', at, new Date(+at + retryMs).toISOString()) };
          }
          finish(row, 'uncertain', at);
          return { action: 'lookup' as const, row: update(row, 'uncertain', at) };
        }
        if (row.status === 'uncertain') return { action: 'lookup' as const, row };
        const effective = assess(row, at);
        if (!recoveryWriteAllowed(db, row.data_domain)) return { action: 'none' as const, row };
        if (effective.status !== 'send') {
          const retryAt = effective.status === 'pending' || effective.status === 'quiet' ? row.next_at : null;
          return { action: 'none' as const, row: update(row, effective.status, at, retryAt) };
        }
        if (row.next_at && row.next_at > at.toISOString()) return { action: 'none' as const, row };
        if (handoffBudgetUsed(row)) return { action: 'none' as const, row: update(row, 'blocked', at) };
        const attempt = row.attempts + 1;
        db.prepare(`UPDATE notification_intents SET status='sending',attempts=?,next_at=NULL,lease_until=?,updated_at=? WHERE intent_id=?`)
          .run(attempt, new Date(+at + leaseMs).toISOString(), at.toISOString(), intentId);
        db.prepare('INSERT INTO notification_attempts(intent_id,attempt,started_at) VALUES (?,?,?)').run(intentId, attempt, at.toISOString());
        return { action: 'send' as const, row: load(intentId), target: effective.target };
      });
      if (!transport || claim.action === 'none') return receipt(claim.row);
      const signal = AbortSignal.timeout(12_000);
      if (claim.action === 'lookup') {
        let found: Observation;
        try { found = await bounded(transport.lookup(Object.freeze(query(claim.row)), signal), signal); }
        catch { found = { outcome: 'unknown' }; }
        return withImmediateTransaction(db, () => {
          const live = load(intentId);
          if (live.status !== 'uncertain' || live.attempts !== claim.row.attempts) return receipt(live);
          return receipt(recordObservation(live, found, now()));
        });
      }
      let granted = false;
      let rejected: HandoffClosed | undefined;
      const beforeSend = () => {
        signal.throwIfAborted();
        if (granted || rejected) throw new HandoffClosed('blocked');
        const denial = withImmediateTransaction(db, () => {
          const at = now();
          const live = load(intentId);
          if (live.status !== 'sending' || live.attempts !== claim.row.attempts || !live.lease_until || live.lease_until <= at.toISOString()) {
            return new HandoffClosed('blocked');
          }
          const effective = assess(live, at);
          if (!recoveryWriteAllowed(db, live.data_domain)) return new HandoffClosed('pending');
          if (effective.status === 'pending' || effective.status === 'quiet' || effective.status === 'blocked') return new HandoffClosed(effective.status);
          if (effective.status !== 'send' || effective.target.target !== claim.target.target) return new HandoffClosed('superseded');
          const changed = db.prepare('UPDATE notification_attempts SET handed_off_at=? WHERE intent_id=? AND attempt=? AND handed_off_at IS NULL')
            .run(at.toISOString(), intentId, live.attempts).changes;
          return changed === 1 ? undefined : new HandoffClosed('blocked');
        });
        if (denial) { rejected = denial; throw denial; }
        granted = true;
      };
      let observation: Observation = { outcome: 'unknown' };
      try {
        const request = Object.freeze({ ...query(claim.row), kind: claim.row.kind, destination: claim.target.target });
        const result = await bounded(transport.send(request, beforeSend, signal), signal);
        if (granted) observation = result;
      } catch { /* Only provider observations can settle an ambiguous handoff. */ }
      return withImmediateTransaction(db, () => {
        const at = now();
        const live = load(intentId);
        if (live.status !== 'sending' || live.attempts !== claim.row.attempts) return receipt(live);
        if (!granted && !recoveryWriteAllowed(db, live.data_domain)) return receipt(live);
        if (rejected && !granted) {
          finish(live, (rejected.status === 'quiet' || rejected.status === 'pending') ? 'not_delivered' : rejected.status, at);
          return receipt(update(live, rejected.status, at));
        }
        if (!granted) {
          finish(live, 'not_delivered', at);
          return receipt(update(live, 'retry_wait', at, new Date(+at + retryMs).toISOString()));
        }
        return receipt(recordObservation(live, observation, at));
      });
    },
  };
}

function matches(row: Row, subject: NotificationSubject | null): subject is NotificationSubject {
  return !!subject && subject.accountId === row.account_id && subject.domain === row.data_domain &&
    subject.objectId === row.object_id && subject.eventVersion === row.event_version;
}

function inQuietHours(now: Date, prefs: QuietPreferences): boolean {
  if (!prefs.quiet) return false;
  const { start, end } = prefs.quiet;
  if (!minute(start) || !minute(end)) throw new Error('NOTIFICATION_QUIET_INVALID');
  if (start === end) return false;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: prefs.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now);
  const local = parts.find((part) => part.type === 'hour')?.value + ':' + parts.find((part) => part.type === 'minute')?.value;
  return start < end ? local >= start && local < end : local >= start || local < end;
}

async function bounded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      cancel = () => reject(signal.reason);
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    })]);
  } finally { if (cancel) signal.removeEventListener('abort', cancel); }
}
