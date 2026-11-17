import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendDomainEvent, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import {
  channelPermit,
  createAnswerGate,
  type AnswerCommand,
  type AnswerReceipt,
  type HubPort,
  type Principal,
} from '../../domain/src/answer-gate.js';
import { claimContinuation } from '../../domain/src/work-continuation.js';
import { requiresChannelReconciliation } from './channel-gate.js';

export const PAIRING_TTL_MS = 5 * 60 * 1000;
const CONNECTION_ID = 'conn-017';

type HubAnswerBody = { choice: number } | { text: string };

export type EnableProof = {
  connection_id: string;
  test_id: string;
  preview_hash: string;
  binding_revision: number;
  config_revision: number;
  credential_version: number;
  incarnation: number;
  epoch: number;
  account_id: string;
};

export type FeishuChannelOptions = {
  now: () => Date;
  hub: HubPort;
  encode: (answer: { kind: 'choice'; index: number } | { kind: 'custom'; raw_text: string }) => HubAnswerBody;
  domain: string;
  connectionId?: string;
};

type ConnectionRow = {
  connection_id: string;
  account_id: string;
  data_domain: string;
  app_id: string;
  tenant_key: string;
  credential_ref: string;
  credential_version: number;
  config_revision: number;
  channel_incarnation: number;
  connection_epoch: number;
  binding_revision: number;
  current_pairing_id: string | null;
  current_test_id: string | null;
  owner_open_id: string | null;
  chat_id: string | null;
  status: string;
  transport_mode: string;
  cutoff_seq: number | null;
};

type Snap = {
  app_id: string;
  tenant_key: string;
  config_revision: number;
  credential_version: number;
  binding_revision: number;
  incarnation: number;
  epoch: number;
  account_id: string;
  data_domain: string;
};

const sockets = new Map<string, { id: string }>();

export function openSupervisedSocket(appId: string, tenant: string): { id: string } {
  const key = `${appId}/${tenant}`;
  const existing = sockets.get(key);
  if (existing) return existing;
  const socket = { id: key };
  sockets.set(key, socket);
  return socket;
}

export function probeDeferredCard(): {
  command: string;
  status: 'blocked';
  observation: string;
  evidenceSha256: string;
  messageId: null;
} {
  const script = 'const id = process.env.FEISHU_APP_ID || process.env.LARK_APP_ID || ""; const secret = process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET || ""; if (!id || !secret) throw new Error("missing Feishu app credential");';
  const command = `${process.execPath} --input-type=module -e ${JSON.stringify(script)}`;
  const credential = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  const sdk = spawnSync(process.execPath, ['--input-type=module', '-e', 'import("@larksuiteoapi/node-sdk").then(() => process.exit(0)).catch((error) => { console.error(error && error.code ? error.code : error); process.exit(1); })'], { encoding: 'utf8' });
  const observation = [
    'feishu_deferred_card',
    `command: ${command}`,
    `exit: ${credential.status ?? 'null'}`,
    (credential.stderr || '').trim(),
    `sdk-exit: ${sdk.status ?? 'null'}`,
    (sdk.stderr || sdk.stdout || '').trim(),
    'channel blocked',
    'web entry remains',
    'message_id: none',
  ].join('\n');
  return {
    command,
    status: 'blocked',
    observation,
    evidenceSha256: sha256(observation),
    messageId: null,
  };
}

export function createFeishuChannel(db: SqliteDatabase, options: FeishuChannelOptions) {
  const connectionId = options.connectionId ?? CONNECTION_ID;
  const stamp = () => options.now().toISOString();
  let releaseHold: (() => void) | null = null;
  let pending: Promise<AnswerReceipt> | null = null;

  return {
    async prepareSentTest() {
      const stamped = stamp();
      withImmediateTransaction(db, () => {
        const connection = requireConnection(db, connectionId);
        db.prepare(`INSERT INTO channel_bindings (
          binding_id, connection_id, pairing_id, account_id, data_domain, owner_open_id, chat_id, app_id, tenant_key,
          config_revision, credential_version, binding_revision, incarnation, epoch, schema_version, created_at
        ) VALUES ('bind-017', ?, 'pairing-seed', ?, ?, 'ou-owner', 'oc-owner', ?, ?, ?, ?, ?, ?, ?, '1.0', ?)
        ON CONFLICT(binding_id) DO NOTHING`).run(
          connectionId,
          connection.account_id,
          connection.data_domain,
          connection.app_id,
          connection.tenant_key,
          connection.config_revision,
          connection.credential_version,
          connection.binding_revision,
          connection.channel_incarnation,
          connection.connection_epoch,
          stamped,
        );
        db.prepare(`INSERT INTO channel_tests (
          test_id, connection_id, account_id, data_domain, preview_hash, destination, status, message_id, inbound_evidence,
          app_id, tenant_key, config_revision, credential_version, binding_id, incarnation, epoch, reason_code,
          schema_version, created_at, updated_at
        ) VALUES ('test-017', ?, ?, ?, ?, 'ou-owner', 'sent', NULL, NULL, ?, ?, ?, ?, 'bind-017', ?, ?, NULL, '1.0', ?, ?)
        ON CONFLICT(test_id) DO UPDATE SET status = 'sent', message_id = NULL, inbound_evidence = NULL, updated_at = excluded.updated_at`).run(
          connectionId,
          connection.account_id,
          connection.data_domain,
          sha256('local-test-sample'),
          connection.app_id,
          connection.tenant_key,
          connection.config_revision,
          connection.credential_version,
          connection.channel_incarnation,
          connection.connection_epoch,
          stamped,
          stamped,
        );
        db.prepare(`UPDATE channel_connections SET status = 'needs_test', transport_mode = 'probe', current_test_id = 'test-017',
          owner_open_id = 'ou-owner', chat_id = 'oc-owner', updated_at = ? WHERE connection_id = ?`).run(stamped, connectionId);
      });
      return { test_id: 'test-017', message_id: 'local-test-017', inbound_evidence: 'local-callback-017' };
    },

    currentProof(): EnableProof {
      const connection = requireConnection(db, connectionId);
      const test = requireTest(db, connection.current_test_id ?? '');
      return {
        connection_id: connection.connection_id,
        test_id: test.test_id,
        preview_hash: test.preview_hash,
        binding_revision: connection.binding_revision,
        config_revision: connection.config_revision,
        credential_version: connection.credential_version,
        incarnation: connection.channel_incarnation,
        epoch: connection.connection_epoch,
        account_id: connection.account_id,
      };
    },

    async recordTestCallback(test: { test_id: string; message_id: string; inbound_evidence: string }) {
      const stamped = stamp();
      withImmediateTransaction(db, () => {
        const connection = requireConnection(db, connectionId);
        if (connection.current_test_id !== test.test_id) throw new Error('BINDING_STALE');
        const row = requireTest(db, test.test_id);
        assertSnap(connection, snapFromTest(row));
        assertBindingRow(db, connection, row.binding_id);
        if (row.status !== 'sent' && row.status !== 'sending') throw new Error('BINDING_STALE');
        db.prepare(`UPDATE channel_tests SET status = 'verified', message_id = ?, inbound_evidence = ?, updated_at = ?
          WHERE test_id = ?`).run(test.message_id, test.inbound_evidence, stamped, test.test_id);
        if (connection.status === 'needs_test') {
          db.prepare(`UPDATE channel_connections SET status = 'needs_enable', updated_at = ? WHERE connection_id = ?`).run(
            stamped,
            connectionId,
          );
        }
      });
    },

    async readTest(testId: string) {
      const row = requireTest(db, testId);
      return { status: row.status, test_id: row.test_id };
    },

    async readConnection() {
      const connection = requireConnection(db, connectionId);
      return { status: connection.status, transport_mode: connection.transport_mode };
    },

    async applyTrustedEnable(proof: EnableProof, authorization?: { beforeWrite: () => string }) {
      withImmediateTransaction(db, () => {
        const stamped = authorization?.beforeWrite() ?? stamp();
        const connection = requireConnection(db, connectionId);
        if (connection.status !== 'needs_enable' || connection.data_domain !== options.domain) throw new Error('BINDING_STALE');
        if (proof.connection_id !== connection.connection_id || proof.account_id !== connection.account_id) throw new Error('BINDING_STALE');
        if (proof.test_id !== connection.current_test_id) throw new Error('BINDING_STALE');
        assertSnap(connection, {
          app_id: connection.app_id,
          tenant_key: connection.tenant_key,
          config_revision: proof.config_revision,
          credential_version: proof.credential_version,
          binding_revision: proof.binding_revision,
          incarnation: proof.incarnation,
          epoch: proof.epoch,
          account_id: proof.account_id,
          data_domain: connection.data_domain,
        });
        const test = requireTest(db, proof.test_id);
        if (test.status !== 'verified' || test.preview_hash !== proof.preview_hash) throw new Error('BINDING_STALE');
        assertSnap(connection, snapFromTest(test));
        assertBindingRow(db, connection, test.binding_id);
        db.prepare(`UPDATE channel_connections SET status = 'ready', transport_mode = 'active', updated_at = ? WHERE connection_id = ?`).run(
          stamped,
          connectionId,
        );
        db.prepare(`INSERT INTO channel_receipts (receipt_id, connection_id, kind, status, created_at) VALUES (?, ?, 'enable', 'ready', ?)`).run(
          `ch_${sha256(`${connectionId}:enable:${stamped}`).slice(0, 16)}`,
          connectionId,
          stamped,
        );
      });
    },

    async submitHeld(principal: Principal, command: AnswerCommand) {
      if (!command.connection_id || !command.inbound_id) throw new Error('UNPROCESSABLE');
      channelPermit(db, command.connection_id, command.inbound_id, command.payload.question_id, stamp());
      const hold = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      const gate = createAnswerGate(db, {
        domain: options.domain,
        now: options.now,
        hub: options.hub,
        encode: options.encode,
        afterHubAccept: () => hold,
      });
      pending = gate.submitAnswer(principal, command);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const row = db.prepare(`SELECT 1 AS ok FROM answer_intents WHERE question_id = ? AND send_status = 'accepted' LIMIT 1`).get(
          command.payload.question_id,
        ) as { ok: number } | undefined;
        if (row) return;
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error('HUB_ACCEPT_NOT_RECORDED');
    },

    async disableTrusted(
      proof: { accountId: string; configRevision: number; epoch: number },
      authorization?: { beforeWrite: () => string },
    ) {
      return withImmediateTransaction(db, () => {
        const stamped = authorization?.beforeWrite() ?? stamp();
        const channel = requireConnection(db, connectionId);
        if (channel.account_id !== proof.accountId || channel.data_domain !== options.domain ||
            channel.config_revision !== proof.configRevision || channel.connection_epoch !== proof.epoch ||
            channel.status !== 'ready' || channel.transport_mode !== 'active') throw new Error('BINDING_STALE');
        const { cutoff } = db.prepare(`SELECT MAX(dispatch_seq) AS cutoff FROM channel_permits
          WHERE connection_id=? AND account_id=? AND epoch=? AND incarnation=?
          AND permit_recorded=1 AND terminal=0`).get(connectionId, channel.account_id, proof.epoch, channel.channel_incarnation) as
          { cutoff: number | null };
        const status = cutoff === null ? 'disabled' : 'draining';
        const epoch = proof.epoch + 1;
        const updated = db.prepare(`UPDATE channel_connections SET status=?,transport_mode=?,connection_epoch=?,cutoff_seq=?,updated_at=?
          WHERE connection_id=? AND config_revision=? AND connection_epoch=? AND status='ready' AND transport_mode='active'`)
          .run(status, status, epoch, cutoff, stamped, connectionId, proof.configRevision, proof.epoch);
        if (updated.changes !== 1) throw new Error('BINDING_STALE');
        if (cutoff !== null) db.prepare(`UPDATE channel_permits SET cutoff=? WHERE connection_id=? AND account_id=? AND epoch=?
          AND incarnation=? AND terminal=0 AND permit_recorded=1 AND dispatch_seq<=?`)
          .run(cutoff, connectionId, channel.account_id, proof.epoch, channel.channel_incarnation, cutoff);
        db.prepare(`INSERT INTO channel_receipts(receipt_id,connection_id,kind,status,created_at) VALUES (?,?,'disable',?,?)`)
          .run(`ch_${sha256(`${connectionId}:disable:${epoch}:${status}`).slice(0,16)}`, connectionId, status, stamped);
        appendDomainEvent(db, { eventId: `channel.mode:${connectionId}:${epoch}:${status}`, aggregateId: connectionId,
          aggregateVersion: epoch, accountId: channel.account_id, dataDomain: channel.data_domain, destination: 'local',
          payload: { type: 'channel.mode.changed', connection_id: connectionId, status, epoch } });
        return { status, epoch };
      });
    },

    async disableWhileHubIsUncertain() {
      const stamped = stamp();
      return withImmediateTransaction(db, () => {
        const connection = requireConnection(db, connectionId);
        const pendingPermits = db.prepare(`SELECT dispatch_seq, permit_recorded, terminal FROM channel_permits
          WHERE connection_id = ? AND permit_recorded = 1 AND terminal = 0 AND dispatch_seq IS NOT NULL`).all(connectionId) as Array<{
          dispatch_seq: number;
          permit_recorded: number;
          terminal: number;
        }>;
        if (pendingPermits.length === 0) throw new Error('NOTHING_TO_RECONCILE');
        const cutoff = Math.max(...pendingPermits.map((row) => row.dispatch_seq));
        db.prepare(`UPDATE channel_connections SET status = 'draining', transport_mode = 'draining',
          connection_epoch = connection_epoch + 1, cutoff_seq = ?, updated_at = ? WHERE connection_id = ?`).run(
          cutoff,
          stamped,
          connectionId,
        );
        db.prepare(`UPDATE channel_permits SET cutoff = ? WHERE connection_id = ? AND terminal = 0`).run(cutoff, connectionId);
        void connection;
        return { status: 'draining' as const };
      });
    },

    async receive(callback: { inbound_id: string; epoch: number; question_id: string }) {
      const stamped = stamp();
      return withImmediateTransaction(db, () => {
        const connection = requireConnection(db, connectionId);
        const permitted = db.prepare(`SELECT inbound_id, question_id, epoch FROM channel_permits
          WHERE connection_id = ? AND terminal = 0 AND dispatch_seq IS NOT NULL`).get(connectionId) as {
          inbound_id: string;
          question_id: string;
          epoch: number;
        } | undefined;
        const current = callback.epoch === connection.connection_epoch
          && permitted
          && callback.inbound_id === permitted.inbound_id
          && callback.question_id === permitted.question_id;
        if (!current) {
          db.prepare(`INSERT INTO channel_audit (audit_id, connection_id, inbound_id, disposition, created_at)
            VALUES (?, ?, ?, 'audit_only', ?)`).run(`audit_${randomBytes(8).toString('hex')}`, connectionId, callback.inbound_id, stamped);
          return { disposition: 'audit_only' as const };
        }
        return { disposition: 'reconcile' as const };
      });
    },

    async releaseAcceptedHubAnswerReadback() {
      if (!releaseHold || !pending) throw new Error('NOTHING_TO_RECONCILE');
      releaseHold();
      await pending;
    },

    async finishAfterReconciliation() {
      const stamped = stamp();
      return withImmediateTransaction(db, () => {
        const connection = requireConnection(db, connectionId);
        const cutoff = connection.cutoff_seq ?? 0;
        const permits = db.prepare(`SELECT permit_recorded, dispatch_seq, terminal FROM channel_permits WHERE connection_id = ?`).all(connectionId) as Array<{
          permit_recorded: number;
          dispatch_seq: number | null;
          terminal: number;
        }>;
        const waiting = permits.some((row) => requiresChannelReconciliation({
          permitRecorded: row.permit_recorded === 1,
          dispatchSeq: row.dispatch_seq,
          terminal: row.terminal === 1,
        }, cutoff));
        if (waiting) return { status: connection.status };
        const resumes = db.prepare(`SELECT ri.work_id, ri.generation, ri.question_id, ri.answer_event_id, ri.phase
          FROM resume_intents ri
          JOIN answer_intents ai
            ON ai.work_id = ri.work_id
           AND ai.generation = ri.generation
           AND ai.question_id = ri.question_id
           AND ai.hub_answer_event_id = ri.answer_event_id
          JOIN channel_permits cp
            ON cp.connection_id = ai.connection_id
           AND cp.inbound_id = ai.inbound_event_id
          WHERE ri.state = 'ready'
            AND ri.phase = 'answer'
            AND cp.connection_id = ?
            AND cp.cutoff IS NOT NULL`).all(connectionId) as Array<{
          work_id: string;
          generation: number;
          question_id: string;
          answer_event_id: string;
          phase: 'answer';
        }>;
        for (const row of resumes) {
          claimContinuation(db, {
            account_id: connection.account_id,
            caller_id: 'web',
            auth_epoch: 1,
            domains: [connection.data_domain],
            operations: ['owner'],
          }, connection.data_domain, row, `attempt-${row.phase}`, options.now());
        }
        db.prepare(`UPDATE channel_connections SET status = 'disabled', transport_mode = 'disabled', updated_at = ? WHERE connection_id = ?`).run(
          stamped,
          connectionId,
        );
        db.prepare(`INSERT INTO channel_receipts (receipt_id, connection_id, kind, status, created_at) VALUES (?, ?, 'disable', 'disabled', ?)`).run(
          `ch_${sha256(`${connectionId}:disable:${stamped}`).slice(0, 16)}`,
          connectionId,
          stamped,
        );
        return { status: 'disabled' as const };
      });
    },

    configure() {
      const stamped = stamp();
      withImmediateTransaction(db, () => {
        db.prepare(`UPDATE channel_connections SET status = 'needs_binding', transport_mode = 'probe',
          owner_open_id = NULL, chat_id = NULL, current_pairing_id = NULL, current_test_id = NULL, updated_at = ?
          WHERE connection_id = ?`).run(stamped, connectionId);
      });
    },

    createPairing() {
      const stamped = stamp();
      const code = randomBytes(18).toString('base64url');
      const pairingId = `pair_${randomBytes(8).toString('hex')}`;
      const expires = new Date(options.now().getTime() + PAIRING_TTL_MS).toISOString();
      withImmediateTransaction(db, () => {
        const connection = requireConnection(db, connectionId);
        db.prepare(`UPDATE channel_pairings SET status = 'expired' WHERE connection_id = ? AND status IN ('open', 'candidate')`).run(connectionId);
        db.prepare(`INSERT INTO channel_pairings (
          pairing_id, connection_id, account_id, data_domain, code_hash, expires_at, consumed_at, candidate_open_id,
          candidate_chat_id, app_id, tenant_key, config_revision, credential_version, binding_revision, incarnation, epoch,
          status, schema_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 'open', '1.0', ?)`).run(
          pairingId,
          connectionId,
          connection.account_id,
          connection.data_domain,
          sha256(code),
          expires,
          connection.app_id,
          connection.tenant_key,
          connection.config_revision,
          connection.credential_version,
          connection.binding_revision,
          connection.channel_incarnation,
          connection.connection_epoch,
          stamped,
        );
        db.prepare(`UPDATE channel_connections SET current_pairing_id = ?, updated_at = ? WHERE connection_id = ?`).run(
          pairingId,
          stamped,
          connectionId,
        );
      });
      return { pairing_id: pairingId, code, expires_at: expires };
    },

    async receivePairingMessage(input: { code: string; open_id: string; chat_id: string }) {
      const stamped = stamp();
      withImmediateTransaction(db, () => {
        const connection = requireConnection(db, connectionId);
        const pairing = db.prepare(`SELECT * FROM channel_pairings WHERE connection_id = ? AND code_hash = ? AND status = 'open'`).get(
          connectionId,
          sha256(input.code),
        ) as PairingRow | undefined;
        if (!pairing || pairing.expires_at <= stamped) throw new Error('PAIRING_EXPIRED');
        assertSnap(connection, snapFromPairing(pairing));
        db.prepare(`UPDATE channel_pairings SET status = 'candidate', candidate_open_id = ?, candidate_chat_id = ? WHERE pairing_id = ?`).run(
          input.open_id,
          input.chat_id,
          pairing.pairing_id,
        );
      });
    },

    confirmPairing(principal: Principal, pairingId: string) {
      const stamped = stamp();
      withImmediateTransaction(db, () => {
        const connection = requireConnection(db, connectionId);
        const pairing = db.prepare('SELECT * FROM channel_pairings WHERE pairing_id = ?').get(pairingId) as PairingRow | undefined;
        if (!pairing || pairing.connection_id !== connectionId) throw new Error('NOT_FOUND');
        if (principal.account_id !== pairing.account_id || principal.caller_id !== 'web' || !principal.operations.includes('owner')) {
          throw new Error('FORBIDDEN');
        }
        if (pairing.expires_at <= stamped) throw new Error('PAIRING_EXPIRED');
        if (pairing.status === 'consumed' || pairing.consumed_at) throw new Error('PAIRING_CONSUMED');
        if (pairing.status !== 'candidate' || !pairing.candidate_open_id || !pairing.candidate_chat_id) throw new Error('BINDING_STALE');
        assertSnap(connection, snapFromPairing(pairing));
        if (connection.current_pairing_id !== pairing.pairing_id) throw new Error('BINDING_STALE');
        const nextRevision = connection.binding_revision + 1;
        const info = db.prepare(`UPDATE channel_pairings SET status = 'consumed', consumed_at = ? WHERE pairing_id = ? AND consumed_at IS NULL`).run(
          stamped,
          pairingId,
        );
        if (info.changes !== 1) throw new Error('PAIRING_CONSUMED');
        db.prepare(`INSERT INTO channel_bindings (
          binding_id, connection_id, pairing_id, account_id, data_domain, owner_open_id, chat_id, app_id, tenant_key,
          config_revision, credential_version, binding_revision, incarnation, epoch, schema_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1.0', ?)`).run(
          `bind_${pairingId}`,
          connectionId,
          pairingId,
          principal.account_id,
          pairing.data_domain,
          pairing.candidate_open_id,
          pairing.candidate_chat_id,
          pairing.app_id,
          pairing.tenant_key,
          pairing.config_revision,
          pairing.credential_version,
          nextRevision,
          pairing.incarnation,
          pairing.epoch,
          stamped,
        );
        db.prepare(`UPDATE channel_connections SET status = 'needs_test', owner_open_id = ?, chat_id = ?, binding_revision = ?, updated_at = ?
          WHERE connection_id = ?`).run(pairing.candidate_open_id, pairing.candidate_chat_id, nextRevision, stamped, connectionId);
      });
    },

    createTest(destination: string) {
      const stamped = stamp();
      const preview = 'PAtrick 连接测试，不含业务资料。';
      const previewHash = sha256(preview);
      const testId = `test_${randomBytes(6).toString('hex')}`;
      withImmediateTransaction(db, () => {
        const connection = requireConnection(db, connectionId);
        if (connection.owner_open_id !== destination) throw new Error('BINDING_STALE');
        db.prepare(`UPDATE channel_tests SET status = 'expired', reason_code = 'TEST_REPLACED', updated_at = ?
          WHERE connection_id = ? AND status NOT IN ('expired', 'verified')`).run(stamped, connectionId);
        db.prepare(`INSERT INTO channel_tests (
          test_id, connection_id, account_id, data_domain, preview_hash, destination, status, message_id, inbound_evidence,
          app_id, tenant_key, config_revision, credential_version, binding_id, incarnation, epoch, reason_code,
          schema_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'previewed', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, '1.0', ?, ?)`).run(
          testId,
          connectionId,
          connection.account_id,
          connection.data_domain,
          previewHash,
          destination,
          connection.app_id,
          connection.tenant_key,
          connection.config_revision,
          connection.credential_version,
          `bind_${connection.current_pairing_id ?? 'seed'}`,
          connection.channel_incarnation,
          connection.connection_epoch,
          stamped,
          stamped,
        );
        db.prepare(`UPDATE channel_connections SET current_test_id = ?, updated_at = ? WHERE connection_id = ?`).run(testId, stamped, connectionId);
      });
      return { test_id: testId, preview_hash: previewHash, destination };
    },

    assertTestPreview(input: TestPreview) {
      assertTestPreview(db, connectionId, input);
    },

    sendTest(input: TestPreview) {
      const stamped = stamp();
      withImmediateTransaction(db, () => {
        assertTestPreview(db, connectionId, input);
        db.prepare(`UPDATE channel_tests SET status = 'sent', updated_at = ? WHERE test_id = ?`).run(stamped, input.test_id);
      });
    },

    setConfigRevision(revision: number) {
      db.prepare('UPDATE channel_connections SET config_revision = ?, updated_at = ? WHERE connection_id = ?').run(
        revision,
        stamp(),
        connectionId,
      );
    },
  };
}

type TestPreview = { test_id: string; preview_hash: string; destination: string };

function assertTestPreview(db: SqliteDatabase, connectionId: string, input: TestPreview): void {
  const connection = requireConnection(db, connectionId);
  if (connection.current_test_id !== input.test_id) throw new Error('BINDING_STALE');
  const test = requireTest(db, input.test_id);
  if (test.preview_hash !== input.preview_hash || test.destination !== input.destination || test.status !== 'previewed') {
    throw new Error('BINDING_STALE');
  }
  assertSnap(connection, snapFromTest(test));
  assertBindingRow(db, connection, test.binding_id);
}

type TestRow = {
  test_id: string;
  status: string;
  preview_hash: string;
  destination: string;
  app_id: string;
  tenant_key: string;
  config_revision: number;
  credential_version: number;
  binding_id: string;
  incarnation: number;
  epoch: number;
  account_id: string;
  data_domain: string;
};

type PairingRow = {
  pairing_id: string;
  connection_id: string;
  account_id: string;
  data_domain: string;
  code_hash: string;
  expires_at: string;
  consumed_at: string | null;
  status: string;
  candidate_open_id: string | null;
  candidate_chat_id: string | null;
  app_id: string;
  tenant_key: string;
  config_revision: number;
  credential_version: number;
  binding_revision: number;
  incarnation: number;
  epoch: number;
};

function requireConnection(db: SqliteDatabase, connectionId: string): ConnectionRow {
  const row = db.prepare('SELECT * FROM channel_connections WHERE connection_id = ?').get(connectionId) as ConnectionRow | undefined;
  if (!row) throw new Error('NOT_FOUND');
  return row;
}

function requireTest(db: SqliteDatabase, testId: string): TestRow {
  const row = db.prepare('SELECT * FROM channel_tests WHERE test_id = ?').get(testId) as TestRow | undefined;
  if (!row) throw new Error('NOT_FOUND');
  return row;
}

function snapFromTest(test: TestRow): Snap {
  return {
    app_id: test.app_id,
    tenant_key: test.tenant_key,
    config_revision: test.config_revision,
    credential_version: test.credential_version,
    binding_revision: 0,
    incarnation: test.incarnation,
    epoch: test.epoch,
    account_id: test.account_id,
    data_domain: test.data_domain,
  };
}

function snapFromPairing(pairing: PairingRow): Snap {
  return {
    app_id: pairing.app_id,
    tenant_key: pairing.tenant_key,
    config_revision: pairing.config_revision,
    credential_version: pairing.credential_version,
    binding_revision: pairing.binding_revision,
    incarnation: pairing.incarnation,
    epoch: pairing.epoch,
    account_id: pairing.account_id,
    data_domain: pairing.data_domain,
  };
}

function assertBindingRow(db: SqliteDatabase, connection: ConnectionRow, bindingId: string): void {
  const binding = db.prepare(`SELECT binding_revision, config_revision, credential_version, incarnation, epoch, app_id, tenant_key
    FROM channel_bindings WHERE binding_id = ?`).get(bindingId) as {
    binding_revision: number;
    config_revision: number;
    credential_version: number;
    incarnation: number;
    epoch: number;
    app_id: string;
    tenant_key: string;
  } | undefined;
  if (!binding) throw new Error('BINDING_STALE');
  if (
    binding.binding_revision !== connection.binding_revision
    || binding.config_revision !== connection.config_revision
    || binding.credential_version !== connection.credential_version
    || binding.incarnation !== connection.channel_incarnation
    || binding.epoch !== connection.connection_epoch
    || binding.app_id !== connection.app_id
    || binding.tenant_key !== connection.tenant_key
  ) {
    throw new Error('BINDING_STALE');
  }
}

function assertSnap(connection: ConnectionRow, snap: Snap): void {
  if (
    connection.app_id !== snap.app_id
    || connection.tenant_key !== snap.tenant_key
    || connection.config_revision !== snap.config_revision
    || connection.credential_version !== snap.credential_version
    || connection.channel_incarnation !== snap.incarnation
    || connection.connection_epoch !== snap.epoch
    || connection.account_id !== snap.account_id
    || connection.data_domain !== snap.data_domain
  ) {
    throw new Error('BINDING_STALE');
  }
  if (snap.binding_revision !== 0 && connection.binding_revision !== snap.binding_revision) throw new Error('BINDING_STALE');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
