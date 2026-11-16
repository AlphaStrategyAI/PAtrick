import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { canonicalCommand, canonicalPayload, commandEnvelope } from '../../packages/contracts/src/envelope.js';
import { createBlobStore, commitBlobRevision } from '../../packages/storage/src/blob-store.js';
import { acceptCommand, recordCommand } from '../../packages/storage/src/commands.js';
import {
  BUSY_TIMEOUT_MS,
  openDatabase,
  pendingMigrations,
  type MigrationEntry,
  type SqliteDatabase,
} from '../../packages/storage/src/database.js';
import { ackOutbox, appendDomainEvent } from '../../packages/storage/src/outbox.js';

const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));
const MANIFEST_PATH = fileURLToPath(new URL('../../packages/storage/migrations/manifest.json', import.meta.url));
const OPERATION = 'storage.command';
const DATA_DOMAIN = 'personal';

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'patrick-t02-'));
}

function closeQuietly(db: { close?: () => void } | undefined): void {
  db?.close?.();
}

test('duplicate command key returns the original command and rejects a different fingerprint', () => {
  const dir = temporaryDirectory();
  const db1 = openDatabase(join(dir, 'patrick.sqlite'));
  const db2 = openDatabase(join(dir, 'patrick.sqlite'));
  try {
    const first = {
      account_id: 'owner',
      caller_id: 'web',
      client_request_id: 'req-1',
      command_fingerprint: 'a'.repeat(64),
      command_id: 'cmd-1',
    };
    expect(recordCommand(db1, first)).toEqual({ command_id: 'cmd-1', created: true });
    expect(recordCommand(db2, { ...first, command_id: 'cmd-2' })).toEqual({ command_id: 'cmd-1', created: false });
    expect(() => recordCommand(db2, { ...first, command_fingerprint: 'b'.repeat(64) })).toThrow('IDEMPOTENCY_CONFLICT');
  } finally {
    closeQuietly(db1);
    closeQuietly(db2);
  }
});

test('openDatabase sets foreign keys, WAL, and the tested busy timeout', () => {
  const db = openDatabase(join(temporaryDirectory(), 'patrick.sqlite'));
  try {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(BUSY_TIMEOUT_MS);
    const migrationSql = readFileSync(fileURLToPath(new URL('../../packages/storage/migrations/0002_core.sql', import.meta.url)), 'utf8');
    expect(migrationSql).toContain(`CREATE TABLE command_inbox (
  account_id TEXT NOT NULL, caller_id TEXT NOT NULL, client_request_id TEXT NOT NULL,
  command_id TEXT NOT NULL UNIQUE,
  command_fingerprint TEXT NOT NULL CHECK(length(command_fingerprint) = 64),
  PRIMARY KEY (account_id, caller_id, client_request_id)
) STRICT;`);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    expect(tables.map((row) => row.name)).toEqual([
      'accounts',
      'adoption_facts',
      'answer_intents',
      'answer_receipts',
      'auth_challenges',
      'authority_facts',
      'blobs',
      'bootstrap_tickets',
      'budget_reservations',
      'business_budgets',
      'caller_scopes',
      'capability_profiles',
      'case_outcomes',
      'cases',
      'channel_audit',
      'channel_bindings',
      'channel_connections',
      'channel_inbound',
      'channel_pairings',
      'channel_permits',
      'channel_receipts',
      'channel_tests',
      'collection_receipts',
      'collection_rounds',
      'command_inbox',
      'command_records',
      'consultations',
      'control_proposals',
      'control_receipts',
      'decision_submissions',
      'delete_sweeps',
      'dependency_checks',
      'domain_events',
      'draft_intents',
      'edit_intents',
      'edit_receipts',
      'evaluation_datasets',
      'evaluation_policies',
      'evaluation_reports',
      'evidence_dependencies',
      'evidence_proofs',
      'evidence_refs',
      'execution_grants',
      'hub_events',
      'hub_snapshots',
      'judgment_bases',
      'knowledge_aliases',
      'knowledge_fts',
      'knowledge_fts_config',
      'knowledge_fts_content',
      'knowledge_fts_data',
      'knowledge_fts_docsize',
      'knowledge_fts_idx',
      'knowledge_members',
      'knowledge_records',
      'maintenance_jobs',
      'mandate_types',
      'mandates',
      'object_revisions',
      'outbox',
      'passkey_credentials',
      'projection_batches',
      'projection_cursors',
      'projection_locks',
      'projection_pointers',
      'question_bindings',
      'question_locks',
      'question_replacements',
      'raw_custom_answers',
      'resume_intents',
      'schema_migrations',
      'sessions',
      'source_configs',
      'source_cursors',
      'source_objects',
      'source_revisions',
      'source_versions',
      'stage_events',
      'standard_candidates',
      'standard_versions',
      'standards',
      'usage_receipts',
      'vault_clients',
      'vault_documents',
      'vault_revisions',
      'vaults',
      'webhook_deliveries',
      'withdrawal_events',
      'work_control_receipts',
      'work_generations',
      'work_stages',
    ]);
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as MigrationEntry[];
    expect(manifest.map((entry) => entry.file)).toEqual(['0002_core.sql', '0003_auth_control.sql', '0004_hub_work.sql', '0005_sources.sql', '0006_vault_evidence.sql', '0007_standards.sql', '0008_admission_budget.sql', '0010_answers_channels.sql']);
    const applied = db.prepare('SELECT file, sha256 FROM schema_migrations ORDER BY position').all();
    expect(applied).toEqual(manifest);
    expect(() => db.prepare('INSERT INTO outbox (event_id, destination) VALUES (?, ?)').run('missing-event', 'hub')).toThrow();
  } finally {
    closeQuietly(db);
  }
});

test('BEGIN IMMEDIATE waits inside busy_timeout while another writer holds the lock', async () => {
  const dir = temporaryDirectory();
  const dbPath = join(dir, 'patrick.sqlite');
  const db = openDatabase(dbPath);
  const workerPath = writeLockWorker(dir);
  let worker: Worker | undefined;
  try {
    db.exec('BEGIN IMMEDIATE');
    const inbox = messageQueue();
    worker = new Worker(workerPath, {
      workerData: {
        packageJson: PACKAGE_JSON,
        dbPath,
        mode: 'immediate',
        busyTimeout: BUSY_TIMEOUT_MS,
        requestId: 'lock-wait',
        commandId: 'cmd-lock-wait',
      },
    });
    worker.on('message', inbox.push);
    worker.on('error', inbox.fail);
    worker.postMessage('go');
    expect((await inbox.next()).phase).toBe('started');
    await delay(400);
    const done = inbox.next();
    db.exec('COMMIT');
    const result = await done;
    expect(result.ok).toBe(true);
    expect(result.elapsed).toBeGreaterThanOrEqual(300);
    expect(result.elapsed).toBeLessThan(BUSY_TIMEOUT_MS);
    expect(db.prepare('SELECT command_id FROM command_inbox WHERE client_request_id = ?').get('lock-wait')).toEqual({
      command_id: 'cmd-lock-wait',
    });
  } finally {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The writer committed before cleanup.
    }
    await worker?.terminate();
    closeQuietly(db);
  }
}, 15_000);

test('a deferred transaction that already read cannot upgrade while BEGIN IMMEDIATE is held', async () => {
  const dir = temporaryDirectory();
  const dbPath = join(dir, 'patrick.sqlite');
  const db = openDatabase(dbPath);
  const workerPath = writeLockWorker(dir);
  let reader: Worker | undefined;
  let worker: Worker | undefined;
  try {
    db.exec('BEGIN');
    db.prepare('SELECT count(*) AS n FROM command_inbox').get();
    const readerStillOpen = messageQueue();
    reader = new Worker(workerPath, {
      workerData: {
        packageJson: PACKAGE_JSON,
        dbPath,
        mode: 'immediate',
        busyTimeout: BUSY_TIMEOUT_MS,
        requestId: 'while-reader',
        commandId: 'cmd-while-reader',
      },
    });
    reader.on('message', readerStillOpen.push);
    reader.on('error', readerStillOpen.fail);
    reader.postMessage('go');
    expect((await readerStillOpen.next()).phase).toBe('started');
    const readerResult = await readerStillOpen.next();
    expect(readerResult.ok).toBe(true);
    expect(readerResult.elapsed).toBeLessThan(500);
    db.exec('COMMIT');
    await reader.terminate();

    db.exec('BEGIN IMMEDIATE');
    const inbox = messageQueue();
    worker = new Worker(workerPath, {
      workerData: {
        packageJson: PACKAGE_JSON,
        dbPath,
        mode: 'upgrade',
        busyTimeout: BUSY_TIMEOUT_MS,
        requestId: 'lock-upgrade',
        commandId: 'cmd-lock-upgrade',
      },
    });
    worker.on('message', inbox.push);
    worker.on('error', inbox.fail);
    worker.postMessage('go');
    const result = await inbox.next();
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SQLITE_BUSY');
    expect(result.elapsed).toBeLessThan(200);
    expect(result.elapsed).toBeLessThan(BUSY_TIMEOUT_MS / 2);
  } finally {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The immediate transaction may already be finished.
    }
    await reader?.terminate();
    await worker?.terminate();
    closeQuietly(db);
  }
}, 15_000);

test('a crash after the blob is durable leaves no command or revision', async () => {
  const dir = temporaryDirectory();
  const dbPath = join(dir, 'patrick.sqlite');
  const blobs = createBlobStore(join(dir, 'blobs'));
  const db = openDatabase(dbPath);
  const bytes = new TextEncoder().encode('orphan-before-commit');
  const hash = createHash('sha256').update(bytes).digest('hex');
  try {
    await expect(commitBlobRevision(db, blobs, {
      bytes,
      objectId: 'obj-crash',
      accountId: 'owner',
      dataDomain: DATA_DOMAIN,
      command: {
        account_id: 'owner',
        caller_id: 'web',
        client_request_id: 'req-crash',
        command_fingerprint: 'c'.repeat(64),
        command_id: 'cmd-crash',
      },
      eventId: 'evt-crash',
      destination: 'hub',
      beforeCommit() {
        throw new Error('CRASH_BEFORE_COMMIT');
      },
    })).rejects.toThrow('CRASH_BEFORE_COMMIT');
    expect(new Uint8Array(readFileSync(blobs.pathFor(hash)))).toEqual(bytes);
  } finally {
    closeQuietly(db);
  }

  const reopened = openDatabase(dbPath);
  try {
    expect(reopened.prepare('SELECT command_id FROM command_inbox WHERE command_id = ?').get('cmd-crash')).toBeUndefined();
    expect(reopened.prepare('SELECT object_id FROM object_revisions WHERE blob_ref = ?').get(hash)).toBeUndefined();
    expect(reopened.prepare('SELECT COUNT(*) AS n FROM domain_events').get()).toEqual({ n: 0 });
    expect(reopened.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 0 });
  } finally {
    closeQuietly(reopened);
  }
});

test('A then B then A keeps the first blob bytes and every revision', async () => {
  const dir = temporaryDirectory();
  const db = openDatabase(join(dir, 'patrick.sqlite'));
  const blobs = createBlobStore(join(dir, 'blobs'));
  const bytesA = new TextEncoder().encode('content-A');
  const bytesB = new TextEncoder().encode('content-B');
  try {
    const first = await commitObserved(db, blobs, 'obj-aba', bytesA, 'req-a1', 'cmd-a1', 'evt-a1');
    const inode = statSync(blobs.pathFor(first.sha256)).ino;
    const second = await commitObserved(db, blobs, 'obj-aba', bytesB, 'req-b', 'cmd-b', 'evt-b');
    const third = await commitObserved(db, blobs, 'obj-aba', bytesA, 'req-a2', 'cmd-a2', 'evt-a2');
    expect(third.sha256).toBe(first.sha256);
    expect(second.sha256).not.toBe(first.sha256);
    expect(statSync(blobs.pathFor(first.sha256)).ino).toBe(inode);
    expect(new Uint8Array(readFileSync(blobs.pathFor(first.sha256)))).toEqual(bytesA);
    expect(new Uint8Array(readFileSync(blobs.pathFor(second.sha256)))).toEqual(bytesB);
    expect(db.prepare('SELECT revision, blob_ref FROM object_revisions WHERE object_id = ? ORDER BY revision').all('obj-aba')).toEqual([
      { revision: 1, blob_ref: first.sha256 },
      { revision: 2, blob_ref: second.sha256 },
      { revision: 3, blob_ref: first.sha256 },
    ]);
  } finally {
    closeQuietly(db);
  }
});

test('the same command key returns the original receipt after the object revision advances', async () => {
  const dir = temporaryDirectory();
  const db = openDatabase(join(dir, 'patrick.sqlite'));
  try {
    db.prepare(`INSERT INTO object_revisions (
      object_id, revision, account_id, data_domain, schema_version, blob_ref, command_id, created_at
    ) VALUES ('W-017', 3, 'owner', 'personal', '1.0', NULL, NULL, '2026-01-01T00:00:00.000Z')`).run();
    const app = createCommandTestApp(db);
    const payload = { text: 'same-body' };
    const payloadHash = createHash('sha256').update(canonicalPayload(payload)).digest('hex');
    const body = {
      client_request_id: 'req-w',
      expected_revision: 3,
      payload_hash: payloadHash,
      payload,
    };
    const first = await postCommand(app, 'W-017', body);
    expect(first.status).toBe(202);
    const receipt = await first.json() as { command_id: string; state: string; receipt_url: string };
    expect(receipt.state).toBe('received');
    expect(receipt.receipt_url).toBe(`/api/v1/commands/${receipt.command_id}`);
    expect(db.prepare('SELECT MAX(revision) AS revision FROM object_revisions WHERE object_id = ?').get('W-017')).toEqual({ revision: 4 });
    const fingerprint = createHash('sha256').update(canonicalCommand({
      operation: OPERATION,
      resource_id: 'W-017',
      data_domain: DATA_DOMAIN,
      expected_revision: 3,
      payload_hash: payloadHash,
    })).digest('hex');
    expect(db.prepare('SELECT command_fingerprint FROM command_inbox WHERE command_id = ?').get(receipt.command_id)).toEqual({
      command_fingerprint: fingerprint,
    });

    db.prepare(`INSERT INTO object_revisions (
      object_id, revision, account_id, data_domain, schema_version, blob_ref, command_id, created_at
    ) VALUES ('W-017', 8, 'owner', 'personal', '1.0', NULL, NULL, '2026-01-02T00:00:00.000Z')`).run();
    const repeat = await postCommand(app, 'W-017', body);
    expect(repeat.status).toBe(202);
    expect(await repeat.json()).toEqual(receipt);
    expect(db.prepare('SELECT MAX(revision) AS revision FROM object_revisions WHERE object_id = ?').get('W-017')).toEqual({ revision: 8 });

    const conflict = await postCommand(app, 'W-018', body);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', retryable: false });
    const shifted = await postCommand(app, 'W-017', { ...body, expected_revision: 4 });
    expect(shifted.status).toBe(409);
    expect(await shifted.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM command_inbox').get()).toEqual({ n: 1 });
  } finally {
    closeQuietly(db);
  }
});

test('null expected revision creates a new object; zero matches an empty object', async () => {
  const dir = temporaryDirectory();
  const db = openDatabase(join(dir, 'patrick.sqlite'));
  try {
    const app = createCommandTestApp(db);
    const payload = { text: 'create' };
    const payloadHash = createHash('sha256').update(canonicalPayload(payload)).digest('hex');
    const createBody = {
      client_request_id: 'req-create-null',
      expected_revision: null,
      payload_hash: payloadHash,
      payload,
    };
    const first = await postCommand(app, 'obj-null', createBody);
    expect(first.status).toBe(202);
    const receipt = await first.json() as { command_id: string; state: string; receipt_url: string };
    expect(receipt.state).toBe('received');
    expect(db.prepare('SELECT MAX(revision) AS revision FROM object_revisions WHERE object_id = ?').get('obj-null')).toEqual({ revision: 1 });

    const repeat = await postCommand(app, 'obj-null', createBody);
    expect(repeat.status).toBe(202);
    expect(await repeat.json()).toEqual(receipt);
    expect(db.prepare('SELECT MAX(revision) AS revision FROM object_revisions WHERE object_id = ?').get('obj-null')).toEqual({ revision: 1 });

    const secondKey = await postCommand(app, 'obj-null', { ...createBody, client_request_id: 'req-create-null-2' });
    expect(secondKey.status).toBe(409);
    expect(await secondKey.json()).toMatchObject({ code: 'REVISION_CONFLICT', retryable: false });

    const zeroBody = {
      client_request_id: 'req-create-zero',
      expected_revision: 0,
      payload_hash: payloadHash,
      payload,
    };
    const zeroCreate = await postCommand(app, 'obj-zero', zeroBody);
    expect(zeroCreate.status).toBe(202);
    expect(db.prepare('SELECT MAX(revision) AS revision FROM object_revisions WHERE object_id = ?').get('obj-zero')).toEqual({ revision: 1 });

    const zeroConflict = await postCommand(app, 'obj-zero', { ...zeroBody, client_request_id: 'req-create-zero-2' });
    expect(zeroConflict.status).toBe(409);
    expect(await zeroConflict.json()).toMatchObject({ code: 'REVISION_CONFLICT', retryable: false });
  } finally {
    closeQuietly(db);
  }
});

test('ackOutbox updates only an existing outbox row and only for accepted or duplicate', () => {
  const db = openDatabase(join(temporaryDirectory(), 'patrick.sqlite'));
  try {
    appendDomainEvent(db, {
      eventId: 'evt-ack',
      aggregateId: 'obj-1',
      aggregateVersion: 1,
      accountId: 'owner',
      dataDomain: DATA_DOMAIN,
      payload: { kind: 'stored' },
      destination: 'hub',
    });
    ackOutbox(db, 'evt-ack', 'hub', 'accepted');
    expect(db.prepare('SELECT result FROM outbox WHERE event_id = ? AND destination = ?').get('evt-ack', 'hub')).toEqual({ result: 'accepted' });
    expect(() => ackOutbox(db, 'evt-ack', 'hub', 'duplicate')).toThrow('OUTBOX_NOT_ACKABLE');
    expect(db.prepare('SELECT result FROM outbox WHERE event_id = ?').get('evt-ack')).toEqual({ result: 'accepted' });

    const before = db.prepare('SELECT COUNT(*) AS n FROM outbox').get();
    expect(() => ackOutbox(db, 'missing-event', 'hub', 'accepted')).toThrow('OUTBOX_NOT_ACKABLE');
    expect(() => ackOutbox(db, 'evt-ack', 'other', 'duplicate')).toThrow('OUTBOX_NOT_ACKABLE');
    expect(db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual(before);
    expect(() => ackOutbox(db, 'evt-ack', 'hub', 'rejected' as 'accepted')).toThrow('OUTBOX_RESULT_INVALID');

    appendDomainEvent(db, {
      eventId: 'evt-dup',
      aggregateId: 'obj-1',
      aggregateVersion: 2,
      accountId: 'owner',
      dataDomain: DATA_DOMAIN,
      payload: { kind: 'again' },
      destination: 'hub',
    });
    ackOutbox(db, 'evt-dup', 'hub', 'duplicate');
    expect(db.prepare('SELECT result FROM outbox WHERE event_id = ?').get('evt-dup')).toEqual({ result: 'duplicate' });
    expect(db.prepare('SELECT domain_seq FROM projection_cursors WHERE name = ?').get('local')).toEqual({ domain_seq: 2 });
  } finally {
    closeQuietly(db);
  }
});

test('manifest order applies the unapplied suffix and a changed applied hash is refused', () => {
  expect(pendingMigrations(
    [
      { file: '0002_core.sql', sha256: 'a'.repeat(64) },
      { file: '0012_beta.sql', sha256: 'b'.repeat(64) },
    ],
    [
      { file: '0002_core.sql', sha256: 'a'.repeat(64) },
      { file: '0012_beta.sql', sha256: 'b'.repeat(64) },
      { file: '0011_alpha.sql', sha256: 'c'.repeat(64) },
    ],
  )).toEqual([{ file: '0011_alpha.sql', sha256: 'c'.repeat(64) }]);
  expect(() => pendingMigrations(
    [{ file: '0002_core.sql', sha256: 'a'.repeat(64) }],
    [{ file: '0002_core.sql', sha256: 'd'.repeat(64) }],
  )).toThrow('SCHEMA_HISTORY_MISMATCH');

  const dir = temporaryDirectory();
  const migrationsDir = join(dir, 'migrations');
  const entries = writeMigrations(migrationsDir, [
    {
      file: '0002_core.sql',
      sql: `CREATE TABLE schema_migrations (
  position INTEGER PRIMARY KEY,
  file TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64)
) STRICT;
CREATE TABLE mig_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  file TEXT NOT NULL
) STRICT;
INSERT INTO mig_log (file) VALUES ('0002');
`,
    },
    {
      file: '0012_beta.sql',
      sql: `INSERT INTO mig_log (file) VALUES ('0012');
CREATE TABLE migrated_0012 (id INTEGER PRIMARY KEY) STRICT;
`,
    },
    {
      file: '0011_alpha.sql',
      sql: `INSERT INTO mig_log (file) VALUES ('0011');
CREATE TABLE migrated_0011 (id INTEGER PRIMARY KEY) STRICT;
`,
    },
  ]);

  const upgradedPath = join(dir, 'upgraded.sqlite');
  const partial = openDatabase(upgradedPath, { migrationsDir, manifest: entries.slice(0, 2) });
  expect(logNames(partial)).toEqual(['0002', '0012']);
  closeQuietly(partial);
  const upgraded = openDatabase(upgradedPath, { migrationsDir, manifest: entries });
  expect(logNames(upgraded)).toEqual(['0002', '0012', '0011']);
  expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migrated_0011'").get()).toEqual({ name: 'migrated_0011' });
  closeQuietly(upgraded);

  const fresh = openDatabase(join(dir, 'fresh.sqlite'), { migrationsDir, manifest: entries });
  expect(logNames(fresh)).toEqual(['0002', '0012', '0011']);
  expect(fresh.prepare('SELECT file FROM schema_migrations ORDER BY position').all()).toEqual([
    { file: '0002_core.sql' },
    { file: '0012_beta.sql' },
    { file: '0011_alpha.sql' },
  ]);
  closeQuietly(fresh);

  const tamperedPath = join(dir, 'tampered.sqlite');
  const base = openDatabase(tamperedPath, { migrationsDir, manifest: entries.slice(0, 2) });
  closeQuietly(base);
  const tampered = [{ ...entries[0]!, sha256: 'f'.repeat(64) }, entries[1]!, entries[2]!];
  expect(() => openDatabase(tamperedPath, { migrationsDir, manifest: tampered })).toThrow('SCHEMA_HISTORY_MISMATCH');
  const unchanged = openDatabase(tamperedPath, { migrationsDir, manifest: entries.slice(0, 2) });
  try {
    expect(logNames(unchanged)).toEqual(['0002', '0012']);
    expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migrated_0011'").get()).toBeUndefined();
  } finally {
    closeQuietly(unchanged);
  }
});

function commitObserved(
  db: SqliteDatabase,
  blobs: ReturnType<typeof createBlobStore>,
  objectId: string,
  bytes: Uint8Array,
  clientRequestId: string,
  commandId: string,
  eventId: string,
) {
  return commitBlobRevision(db, blobs, {
    bytes,
    objectId,
    accountId: 'owner',
    dataDomain: DATA_DOMAIN,
    command: {
      account_id: 'owner',
      caller_id: 'web',
      client_request_id: clientRequestId,
      command_fingerprint: 'd'.repeat(64),
      command_id: commandId,
    },
    eventId,
    destination: 'hub',
  });
}

function createCommandTestApp(db: SqliteDatabase): Hono {
  const app = new Hono();
  const schema = commandEnvelope(z.strictObject({ text: z.string() }));
  app.post('/api/v1/commands/:resourceId', async (c) => {
    const parsed = schema.safeParse(await c.req.json());
    const correlationId = randomUUID();
    if (!parsed.success) {
      return c.json({ code: 'UNPROCESSABLE', params: {}, retryable: false, correlation_id: correlationId }, 422);
    }
    const actualHash = createHash('sha256').update(canonicalPayload(parsed.data.payload)).digest('hex');
    if (actualHash !== parsed.data.payload_hash) {
      return c.json({ code: 'PAYLOAD_HASH_MISMATCH', params: {}, retryable: false, correlation_id: correlationId }, 422);
    }
    try {
      const receipt = acceptCommand(db, {
        accountId: 'owner',
        callerId: 'web',
        operation: OPERATION,
        resourceId: c.req.param('resourceId'),
        dataDomain: DATA_DOMAIN,
        clientRequestId: parsed.data.client_request_id,
        expectedRevision: parsed.data.expected_revision,
        payloadHash: parsed.data.payload_hash,
      });
      return c.json({
        command_id: receipt.command_id,
        state: 'received' as const,
        receipt_url: `/api/v1/commands/${receipt.command_id}`,
      }, 202);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'IDEMPOTENCY_CONFLICT' || code === 'REVISION_CONFLICT') {
        return c.json({ code, params: {}, retryable: false, correlation_id: correlationId }, 409);
      }
      throw error;
    }
  });
  return app;
}

function postCommand(app: Hono, resourceId: string, body: unknown): Promise<Response> {
  return Promise.resolve(app.request(`/api/v1/commands/${resourceId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

function writeMigrations(dir: string, files: { file: string; sql: string }[]): MigrationEntry[] {
  mkdirSync(dir, { recursive: true });
  return files.map(({ file, sql }) => {
    const fullPath = join(dir, file);
    writeFileSync(fullPath, sql);
    return {
      file,
      sha256: createHash('sha256').update(readFileSync(fullPath)).digest('hex'),
    };
  });
}

function logNames(db: SqliteDatabase): string[] {
  return (db.prepare('SELECT file FROM mig_log ORDER BY seq').all() as { file: string }[]).map((row) => row.file);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageQueue(): {
  push: (message: LockMessage) => void;
  fail: (error: unknown) => void;
  next: () => Promise<LockMessage>;
} {
  const pending: LockMessage[] = [];
  const waiters: { resolve: (message: LockMessage) => void; reject: (error: Error) => void }[] = [];
  let failed: Error | undefined;
  return {
    push(message) {
      if (failed) return;
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else pending.push(message);
    },
    fail(error) {
      if (failed) return;
      failed = error instanceof Error ? error : new Error(String(error));
      for (const waiter of waiters.splice(0)) waiter.reject(failed);
    },
    next() {
      if (failed) return Promise.reject(failed);
      const queued = pending.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
  };
}

type LockMessage = { phase?: string; ok?: boolean; elapsed?: number; code?: string; message?: string };

function writeLockWorker(dir: string): string {
  const path = join(dir, 'lock-worker.mjs');
  const fingerprintA = 'a'.repeat(64);
  const fingerprintB = 'b'.repeat(64);
  writeFileSync(path, `import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

const insert = 'INSERT INTO command_inbox (account_id, caller_id, client_request_id, command_id, command_fingerprint) VALUES (?, ?, ?, ?, ?)';

parentPort.once('message', () => {
  let db;
  const startedAt = Date.now();
  try {
    const Database = createRequire(workerData.packageJson)('better-sqlite3');
    db = new Database(workerData.dbPath, { timeout: workerData.busyTimeout });
    db.pragma('busy_timeout = ' + workerData.busyTimeout);
    db.pragma('foreign_keys = ON');
    if (workerData.mode === 'immediate') {
      parentPort.postMessage({ phase: 'started' });
      const lockStarted = Date.now();
      db.exec('BEGIN IMMEDIATE');
      db.prepare(insert).run('owner', 'web', workerData.requestId, workerData.commandId, '${fingerprintA}');
      db.exec('COMMIT');
      parentPort.postMessage({ phase: 'done', ok: true, elapsed: Date.now() - lockStarted });
    } else {
      db.exec('BEGIN');
      db.prepare('SELECT count(*) AS n FROM command_inbox').get();
      const writeStarted = Date.now();
      try {
        db.prepare(insert).run('owner', 'web', workerData.requestId, workerData.commandId, '${fingerprintB}');
        db.exec('COMMIT');
        parentPort.postMessage({ phase: 'done', ok: true, elapsed: Date.now() - writeStarted });
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* upgrade failed before a write transaction */ }
        parentPort.postMessage({
          phase: 'done',
          ok: false,
          elapsed: Date.now() - writeStarted,
          code: error && error.code,
          message: String(error && error.message || error),
        });
      }
    }
  } catch (error) {
    try { db?.exec('ROLLBACK'); } catch { /* no open transaction */ }
    parentPort.postMessage({
      phase: 'done',
      ok: false,
      elapsed: Date.now() - startedAt,
      code: error && error.code,
      message: String(error && error.message || error),
    });
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
});
`);
  return path;
}
