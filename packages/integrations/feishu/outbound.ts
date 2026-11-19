import { createHash } from 'node:crypto';
import { assertRecoveryWriteAllowed, type SqliteDatabase } from '@patrick/storage';

type TestPreview = Readonly<{ test_id: string; preview_hash: string; destination: string }>;

export type FeishuOutboundTest = TestPreview & Readonly<{
  connection_id: string;
  account_id: string;
  data_domain: string;
  app_id: string;
  tenant_key: string;
  credential_ref: string;
  credential_version: number;
  config_revision: number;
  binding_id: string;
  binding_revision: number;
  incarnation: number;
  epoch: number;
  message: string;
}>;

type OutboundResult = Readonly<{ state: 'sent'; message_id: string }> | Readonly<{ state: 'unknown' }>;

/** The opt-in supervisor uses the exact provider, credential version, and binding in the request.
 * If it cannot establish their validity, it must not send. Use test_id as the stable dispatch key
 * call beforeSend after awaiting credentials and directly before the actual provider handoff,
 * await all work owned by the handoff, and return `sent` only for a provider receipt. */
export type FeishuTestOutbound = Readonly<{
  sendTest: (test: FeishuOutboundTest, signal: AbortSignal, beforeSend: () => void) => Promise<OutboundResult>;
}>;

export type FeishuOutboundLifetime = Readonly<{
  signal: AbortSignal;
  run: (start: () => Promise<void>) => Promise<void>;
}>;

// This is the T10 preview. Matching its stored hash keeps a changed preview and
// an older sender from silently dispatching different content.
const testMessage = 'PAtrick 连接测试，不含业务资料。';
const testHash = createHash('sha256').update(testMessage).digest('hex');

/** Called in the same transaction as recording the canonical T10 command. */
export function claimFeishuOutboundTest(db: SqliteDatabase, preview: TestPreview, scope: Readonly<{
  connection_id: string; account_id: string; data_domain: string;
}>, at: string): FeishuOutboundTest | null {
  if (!db.inTransaction) throw new Error('FEISHU_TEST_TRANSACTION_REQUIRED');
  assertRecoveryWriteAllowed(db, scope.data_domain);
  if (preview.preview_hash !== testHash) return null;
  const row = currentTest(db, preview, scope, 'previewed');
  if (!row) return null;
  const claimed = db.prepare(`UPDATE channel_tests SET status='sending', updated_at=?
    WHERE test_id=? AND status='previewed'`).run(at, row.test_id);
  return claimed.changes === 1 ? Object.freeze({ ...row, message: testMessage }) : null;
}

function currentTest(db: SqliteDatabase, preview: TestPreview, scope: Readonly<{
  connection_id: string; account_id: string; data_domain: string;
}>, status: 'previewed' | 'sending'): Omit<FeishuOutboundTest, 'message'> | undefined {
  return db.prepare(`SELECT t.test_id, t.preview_hash, t.destination, t.connection_id, t.account_id, t.data_domain,
      c.app_id, c.tenant_key, c.credential_ref, t.credential_version, t.config_revision, t.binding_id,
      b.binding_revision, t.incarnation, t.epoch
    FROM channel_tests t
    JOIN channel_connections c ON c.connection_id=t.connection_id AND c.account_id=t.account_id AND c.data_domain=t.data_domain
    JOIN channel_bindings b ON b.binding_id=t.binding_id AND b.connection_id=t.connection_id
      AND b.account_id=t.account_id AND b.data_domain=t.data_domain
    WHERE t.test_id=@test_id AND t.connection_id=@connection_id AND t.account_id=@account_id AND t.data_domain=@data_domain
      AND t.status=@status AND t.preview_hash=@preview_hash AND t.destination=@destination
      AND c.current_test_id=t.test_id AND c.owner_open_id=t.destination AND b.owner_open_id=t.destination
      AND b.pairing_id=c.current_pairing_id AND b.chat_id=c.chat_id
      AND c.status='needs_test' AND c.transport_mode='probe'
      AND c.tenant_key<>'pending-tenant' AND c.reason_code IS NOT 'NATIVE_PROBE_REQUIRED'
      AND t.app_id=c.app_id AND t.tenant_key=c.tenant_key AND b.app_id=c.app_id AND b.tenant_key=c.tenant_key
      AND t.config_revision=c.config_revision AND b.config_revision=c.config_revision
      AND t.credential_version=c.credential_version AND b.credential_version=c.credential_version
      AND t.incarnation=c.channel_incarnation AND b.incarnation=c.channel_incarnation
      AND t.epoch=c.connection_epoch AND b.epoch=c.connection_epoch AND b.binding_revision=c.binding_revision`)
    .get({ ...preview, ...scope, status }) as Omit<FeishuOutboundTest, 'message'> | undefined;
}

function assertCurrentDispatch(db: SqliteDatabase, test: FeishuOutboundTest): void {
  assertRecoveryWriteAllowed(db, test.data_domain);
  const current = currentTest(db, test, test, 'sending');
  if (!current || test.message !== testMessage
    || Object.entries(current).some(([key, value]) => test[key as keyof FeishuOutboundTest] !== value)) {
    throw new Error('FEISHU_TEST_STALE');
  }
}

/** An uncertain send stays with the same test; neither route schedules a retry. */
export async function dispatchClaimedFeishuTest(db: SqliteDatabase, adapter: FeishuTestOutbound, test: FeishuOutboundTest,
  now: () => Date, lifetime: FeishuOutboundLifetime): Promise<void> {
  if (!lifetime || lifetime.signal.aborted) throw new Error('FEISHU_TEST_HANDOFF_CLOSED');
  assertCurrentDispatch(db, test);
  const result = await sendBounded(db, adapter, test, lifetime);
  db.prepare(`UPDATE channel_tests SET status=?, message_id=?, reason_code=?, updated_at=?
    WHERE test_id=? AND connection_id=? AND account_id=? AND data_domain=? AND binding_id=? AND preview_hash=?
      AND incarnation=? AND epoch=? AND status='sending'`).run(
    result.state, result.state === 'sent' ? result.message_id : null,
    result.state === 'unknown' ? 'OUTBOUND_UNCERTAIN' : null, now().toISOString(),
    test.test_id, test.connection_id, test.account_id, test.data_domain, test.binding_id, test.preview_hash, test.incarnation, test.epoch,
  );
}

function sendBounded(db: SqliteDatabase, adapter: FeishuTestOutbound, test: FeishuOutboundTest,
  lifetime: FeishuOutboundLifetime): Promise<OutboundResult> {
  const deadline = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, deadline.signal]);
  return new Promise((resolve, reject) => {
    let closed = false;
    let denied: unknown;
    const beforeSend = () => {
      if (closed || signal.aborted) throw new Error('FEISHU_TEST_HANDOFF_CLOSED');
      if (denied) throw denied;
      try { assertCurrentDispatch(db, test); }
      catch (error) { denied = error; throw error; }
    };
    const timeout = setTimeout(() => deadline.abort(), 10_000);
    const aborted = () => complete();
    function complete(result: OutboundResult = { state: 'unknown' }) {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', aborted);
      if (denied) reject(denied);
      else resolve(result);
    }
    signal.addEventListener('abort', aborted, { once: true });
    // run registers before its starter executes. Only actual adapter settlement releases the owner.
    void lifetime.run(async () => {
      try {
        beforeSend();
        const result = await adapter.sendTest(test, signal, beforeSend);
        if (closed) return;
        const id = result?.state === 'sent' ? result.message_id : undefined;
        complete(typeof id === 'string' && /^[A-Za-z0-9_:-]{1,200}$/u.test(id) ? { state: 'sent', message_id: id } : undefined);
      } catch { complete(); }
    });
  });
}
