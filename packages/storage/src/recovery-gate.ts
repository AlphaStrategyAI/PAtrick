import type { SqliteDatabase } from './database.js';

export type RecoveryRuntimeAdmission = Readonly<{
  domain: string; writerEpoch: string; activationId: string; witnessRevision: string;
}>;
type GateRow = { writer_epoch: string; status: string; activation_id: string | null; witness_revision: string | null };
type RuntimeState = { admitted: Map<string, RecoveryRuntimeAdmission> };
const runtimes = new WeakMap<SqliteDatabase, RuntimeState>();

function gate(db: SqliteDatabase, domain: string): GateRow | undefined {
  return db.prepare(`SELECT writer_epoch,status,activation_id,witness_revision FROM recovery_domain_gates
    WHERE data_domain=?`).get(domain) as GateRow | undefined;
}
function withdrawalPending(db: SqliteDatabase, domain: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM recovery_withdrawal_pending WHERE data_domain=? LIMIT 1').get(domain));
}
function matches(row: GateRow, admission: RecoveryRuntimeAdmission): boolean {
  return row.writer_epoch === admission.writerEpoch && row.activation_id === admission.activationId
    && row.witness_revision === admission.witnessRevision;
}

/** Only the trusted runtime activation controller receives this connection-bound capability.
 * Call admit after independent witness, fencing, epoch installation and credential-scope readback.
 * Persisted SQL never installs admission, including when a copied database already says open.
 */
export function createRecoveryRuntimeGate(db: SqliteDatabase) {
  const state = runtimes.get(db) ?? { admitted: new Map<string, RecoveryRuntimeAdmission>() };
  runtimes.set(db, state);
  return Object.freeze({
    admit(admission: RecoveryRuntimeAdmission): void {
      if (Object.values(admission).some((value) => !value.trim()) || admission.writerEpoch === 'unregistered') {
        throw new Error('RECOVERY_ADMISSION_MISMATCH');
      }
      if (withdrawalPending(db, admission.domain)) throw new Error('RECOVERY_WITHDRAWAL_PENDING');
      const row = gate(db, admission.domain);
      if (!row || !['blocked', 'open'].includes(row.status) || !matches(row, admission)) {
        throw new Error('RECOVERY_ADMISSION_MISMATCH');
      }
      state.admitted.set(admission.domain, Object.freeze({ ...admission }));
    },
    revoke(domain: string): void { state.admitted.delete(domain); },
  });
}

/** Check within the writer transaction and again immediately before file/external handoff. */
export function recoveryWriteAllowed(db: SqliteDatabase, domain: string): boolean {
  if (!domain.trim() || withdrawalPending(db, domain)) return false;
  const row = gate(db, domain);
  const runtime = runtimes.get(db);
  if (row) {
    const admission = runtime?.admitted.get(domain);
    return row.status === 'open' && Boolean(admission && matches(row, admission));
  }
  if (runtime) return false;
  // Only a database with no recovery state can retain legacy admission. A restored/imported
  // database cannot open an omitted domain simply by presenting no gate row for that domain.
  return !db.prepare(`SELECT 1 FROM recovery_domain_gates
    UNION ALL SELECT 1 FROM recovery_withdrawal_pending
    UNION ALL SELECT 1 FROM recovery_imports LIMIT 1`).get();
}

export function assertRecoveryWriteAllowed(db: SqliteDatabase, domain: string): void {
  if (!recoveryWriteAllowed(db, domain)) throw new Error('RECOVERY_WRITE_BLOCKED');
}
