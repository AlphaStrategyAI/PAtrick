import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openDatabase, type SqliteDatabase } from '@patrick/storage';

type GateModule = typeof import('../../packages/storage/src/recovery-gate.js');
const roots: string[] = [];
const handles: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function gates(): Promise<GateModule> {
  const module = await import('../../packages/storage/src/recovery-gate.js').catch(() => undefined);
  expect(module, 'business writers require a connection-bound recovery gate').toBeDefined();
  return module!;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-recovery-gate-'));
  roots.push(root);
  const path = join(root, 'service.sqlite');
  const db = openDatabase(path);
  handles.push(db);
  return { db, path };
}
function row(db: SqliteDatabase, status = 'blocked', epoch = 'epoch-a') {
  db.prepare(`INSERT INTO recovery_domain_gates VALUES ('personal', ?, ?, 'activation-a', 'witness-2', NULL, NULL, '2026-11-17')
    ON CONFLICT(data_domain) DO UPDATE SET writer_epoch=excluded.writer_epoch,status=excluded.status`).run(epoch, status);
}
const admission = { domain: 'personal', writerEpoch: 'epoch-a', activationId: 'activation-a', witnessRevision: 'witness-2' };

test('legacy databases remain usable until recovery state or required admission exists', async () => {
  const { recoveryWriteAllowed, createRecoveryRuntimeGate } = await gates();
  const { db } = fixture();
  expect(recoveryWriteAllowed(db, 'personal')).toBe(true);
  createRecoveryRuntimeGate(db);
  expect(recoveryWriteAllowed(db, 'personal')).toBe(false);
});

test('persisted open state alone cannot authorize either a new handle or another domain', async () => {
  const { recoveryWriteAllowed } = await gates();
  const { db } = fixture();
  row(db, 'open');
  expect(recoveryWriteAllowed(db, 'personal')).toBe(false);
  expect(recoveryWriteAllowed(db, 'company')).toBe(false);
});

test('runtime admission binds the exact handle, epoch and independent activation identity', async () => {
  const { recoveryWriteAllowed, createRecoveryRuntimeGate } = await gates();
  const { db, path } = fixture();
  row(db);
  const controller = createRecoveryRuntimeGate(db);
  expect(() => controller.admit({ ...admission, activationId: 'wrong' })).toThrow('RECOVERY_ADMISSION_MISMATCH');
  controller.admit(admission);
  expect(recoveryWriteAllowed(db, 'personal')).toBe(false);
  row(db, 'open');
  expect(recoveryWriteAllowed(db, 'personal')).toBe(true);
  const reopened = openDatabase(path);
  handles.push(reopened);
  expect(recoveryWriteAllowed(reopened, 'personal')).toBe(false);
  row(db, 'open', 'epoch-b');
  expect(recoveryWriteAllowed(db, 'personal')).toBe(false);
});

test.each(['blocked', 'protection_pending', 'importing', 'imported'])('closed status %s overrides prior admission', async (status) => {
  const { recoveryWriteAllowed, createRecoveryRuntimeGate } = await gates();
  const { db } = fixture();
  row(db, 'open');
  createRecoveryRuntimeGate(db).admit(admission);
  row(db, status);
  expect(recoveryWriteAllowed(db, 'personal')).toBe(false);
});

test('a durable pending withdrawal overrides open state and cannot be admitted', async () => {
  const { recoveryWriteAllowed, createRecoveryRuntimeGate } = await gates();
  const { db } = fixture();
  row(db, 'open');
  const controller = createRecoveryRuntimeGate(db);
  controller.admit(admission);
  db.prepare(`INSERT INTO withdrawal_events VALUES ('withdrawal-a', 'personal', 'knowledge', 'knowledge-a', 1, 1, 'owner', '2026-11-17')`).run();
  row(db, 'open');
  expect(recoveryWriteAllowed(db, 'personal')).toBe(false);
  expect(() => controller.admit(admission)).toThrow('RECOVERY_WITHDRAWAL_PENDING');
});

test('revoking a runtime admission immediately closes ordinary writes', async () => {
  const { assertRecoveryWriteAllowed, createRecoveryRuntimeGate } = await gates();
  const { db } = fixture();
  row(db, 'open');
  const controller = createRecoveryRuntimeGate(db);
  controller.admit(admission);
  expect(() => assertRecoveryWriteAllowed(db, 'personal')).not.toThrow();
  controller.revoke('personal');
  expect(() => assertRecoveryWriteAllowed(db, 'personal')).toThrow('RECOVERY_WRITE_BLOCKED');
});
