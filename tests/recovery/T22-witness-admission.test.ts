import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openDatabase, recoveryWriteAllowed, type SqliteDatabase } from '@patrick/storage';
import { createWitnessAdmissionController } from '../../deploy/runtime/witness-admission.js';
import type { RecoveryWitnessPort, RecoveryWitnessRecord } from '../../packages/host/src/recovery/witness.js';

const roots: string[] = [];
const handles: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-witness-admission-'));
  roots.push(root);
  const db = openDatabase(join(root, 'service.sqlite'));
  handles.push(db);
  return db;
}

function record(overrides: Partial<RecoveryWitnessRecord> = {}): RecoveryWitnessRecord {
  return {
    domain: 'personal', revision: 'revision-open', writerEpoch: 'epoch-a', writerId: 'writer-a', state: 'open',
    withdrawal: { seq: 0, hash: 'a'.repeat(64) }, certificate: null, activationId: 'activation-a',
    parentSealedRevision: null, ...overrides,
  };
}

function port(current: RecoveryWitnessRecord | undefined, applied = true): RecoveryWitnessPort & { writes: number } {
  const state = { current, writes: 0 };
  const client: RecoveryWitnessPort & { writes: number } = {
    independence: 'independent_authority', consistency: 'linearizable', authorityId: 'witness-a',
    async readAuthoritative(domain) {
      if (!state.current || state.current.domain !== domain) throw new Error('WITNESS_UNREACHABLE');
      return structuredClone(state.current);
    },
    async compareAndSwap(domain, expectedRevision, next) {
      state.writes++;
      if (!applied || !state.current || state.current.domain !== domain || state.current.revision !== expectedRevision) return false;
      state.current = { ...structuredClone(next), revision: 'revision-claimed' };
      return true;
    },
    get writes() { return state.writes; },
  };
  return client;
}

function gate(db: SqliteDatabase, status: 'blocked' | 'open', revision = 'revision-open', activation = 'activation-a') {
  db.prepare(`INSERT INTO recovery_domain_gates VALUES ('personal', 'epoch-a', ?, ?, ?, NULL, NULL, '2026-11-27T00:00:00.000Z')
    ON CONFLICT(data_domain) DO UPDATE SET status = excluded.status, activation_id = excluded.activation_id,
    witness_revision = excluded.witness_revision`).run(status, activation, revision);
}

test('first start stays closed until the witness record and the restored gate row agree', async () => {
  const db = fixture();
  const witness = port(record());
  const controller = createWitnessAdmissionController(db, [{ domain: 'personal', writerId: 'writer-a', port: witness }]);
  expect(await controller.reconcile()).toEqual({ personal: 'domain_unregistered' });
  expect(recoveryWriteAllowed(db, 'personal')).toBe(false);
  gate(db, 'blocked');
  expect(await controller.reconcile()).toEqual({ personal: 'revoked' });
  gate(db, 'open');
  expect(await controller.reconcile()).toEqual({ personal: 'admitted' });
  expect(recoveryWriteAllowed(db, 'personal')).toBe(true);
  expect(witness.writes).toBe(0);
  controller.stop();
});

test('a restart reuses the admitted writer and a lost witness revokes it immediately', async () => {
  const db = fixture();
  gate(db, 'open');
  const witness = port(record());
  const controller = createWitnessAdmissionController(db, [{ domain: 'personal', writerId: 'writer-a', port: witness }]);
  expect(await controller.reconcile()).toEqual({ personal: 'admitted' });
  witness.readAuthoritative = async () => { throw new Error('WITNESS_UNREACHABLE'); };
  expect(await controller.recheck()).toEqual({ personal: 'witness_unreachable' });
  expect(recoveryWriteAllowed(db, 'personal')).toBe(false);
  controller.stop();
});

test('a sealed witness is claimed once and a rejected claim never opens the domain', async () => {
  const db = fixture();
  const sealed = record({
    state: 'sealed', revision: 'revision-sealed', activationId: null,
    certificate: { id: 'handoff', cutId: 'cut-a', previousWriterId: 'writer-a', fenceProof: 'fence', withdrawalsReconciled: true },
  });
  const witness = port(sealed, false);
  const controller = createWitnessAdmissionController(db, [{
    domain: 'personal', writerId: 'writer-a', port: witness, verifySealedProof: async () => true,
  }]);
  expect(await controller.reconcile()).toEqual({ personal: 'proof_unverified' });
  expect(recoveryWriteAllowed(db, 'personal')).toBe(false);
  expect(witness.writes).toBe(1);
  controller.stop();
});

test('a verified sealed record opens only the activation the witness reads back', async () => {
  const db = fixture();
  const sealed = record({
    state: 'sealed', revision: 'revision-sealed', activationId: null,
    certificate: { id: 'handoff', cutId: 'cut-a', previousWriterId: 'writer-a', fenceProof: 'fence', withdrawalsReconciled: true },
  });
  const witness = port(sealed);
  const controller = createWitnessAdmissionController(db, [{
    domain: 'personal', writerId: 'writer-a', port: witness, verifySealedProof: async () => true,
  }]);
  expect(await controller.reconcile()).toEqual({ personal: 'domain_unregistered' });
  const claimed = await witness.readAuthoritative('personal');
  db.prepare(`INSERT INTO recovery_domain_gates VALUES ('personal', ?, 'open', ?, ?, NULL, NULL, '2026-11-27T00:00:00.000Z')`)
    .run(claimed.writerEpoch, claimed.activationId, claimed.revision);
  expect(await controller.reconcile()).toEqual({ personal: 'admitted' });
  expect(recoveryWriteAllowed(db, 'personal')).toBe(true);
  const foreign = record({ writerEpoch: 'epoch-b', activationId: 'activation-b', revision: 'revision-foreign' });
  witness.readAuthoritative = async () => foreign;
  expect(await controller.recheck()).toEqual({ personal: 'revoked' });
  expect(recoveryWriteAllowed(db, 'personal')).toBe(false);
  controller.stop();
});
