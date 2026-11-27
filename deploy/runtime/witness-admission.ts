import { randomUUID } from 'node:crypto';
import { createRecoveryRuntimeGate, recoveryWriteAllowed, type RecoveryRuntimeAdmission, type SqliteDatabase } from '@patrick/storage';
import { createRecoveryWitness, type RecoveryWitness, type RecoveryWitnessPort, type RecoveryWitnessRecord } from '../../packages/host/src/recovery/witness.js';

/** Only an independently enrolled HTTPS witness may drive this controller.
 * A copied database, a settings draft, or an environment string cannot install admission.
 */
export type WitnessAdmissionEnrollment = Readonly<{
  domain: string;
  writerId: string;
  port: RecoveryWitnessPort;
  /** Proves the previous writer stopped before a sealed record may be claimed. */
  verifySealedProof?: (record: RecoveryWitnessRecord) => Promise<boolean>;
}>;

export type WitnessAdmissionOutcome =
  | 'admitted'
  | 'revoked'
  | 'witness_unreachable'
  | 'writer_lost'
  | 'proof_unverified'
  | 'domain_unregistered';

export type WitnessAdmissionController = Readonly<{
  /** First install, restart, and the start that follows a recovery handoff. */
  reconcile(): Promise<Readonly<Record<string, WitnessAdmissionOutcome>>>;
  /** One pass of the live watch: unreachable, sealed, or foreign records lose admission immediately. */
  recheck(): Promise<Readonly<Record<string, WitnessAdmissionOutcome>>>;
  stop(): void;
}>;

type GateRow = {
  writer_epoch: string; status: string; activation_id: string | null; witness_revision: string | null;
};

const domainId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const token = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function enrolled(port: RecoveryWitnessPort): boolean {
  return port.independence === 'independent_authority' && port.consistency === 'linearizable' && Boolean(port.authorityId);
}

function validEnrollment(enrollment: WitnessAdmissionEnrollment): boolean {
  return domainId.test(enrollment.domain) && token.test(enrollment.writerId) && enrolled(enrollment.port);
}

function gate(database: SqliteDatabase, domain: string): GateRow | undefined {
  return database.prepare(`SELECT writer_epoch, status, activation_id, witness_revision FROM recovery_domain_gates
    WHERE data_domain = ?`).get(domain) as GateRow | undefined;
}

function matches(row: GateRow, record: RecoveryWitnessRecord): boolean {
  return row.status === 'open' && row.writer_epoch === record.writerEpoch
    && row.activation_id === record.activationId && row.witness_revision === record.revision;
}

function admit(database: SqliteDatabase, admission: ReturnType<typeof createRecoveryRuntimeGate>, record: RecoveryWitnessRecord): boolean {
  const identity: RecoveryRuntimeAdmission = {
    domain: record.domain, writerEpoch: record.writerEpoch,
    activationId: record.activationId!, witnessRevision: record.revision,
  };
  admission.admit(identity);
  return recoveryWriteAllowed(database, record.domain);
}

/** Binds one service database to the witness records of its enrolled domains.
 * The controller never writes the gate table: restoration and the withdrawal journal own those rows.
 */
export function createWitnessAdmissionController(
  database: SqliteDatabase, enrollments: readonly WitnessAdmissionEnrollment[],
): WitnessAdmissionController {
  if (enrollments.length < 1 || enrollments.length > 64) throw new Error('WITNESS_ADMISSION_ENROLLMENT_INVALID');
  const domains = new Set<string>();
  const witnesses = new Map<string, { witness: RecoveryWitness; writerId: string }>();
  for (const enrollment of enrollments) {
    if (!validEnrollment(enrollment) || domains.has(enrollment.domain)) throw new Error('WITNESS_ADMISSION_ENROLLMENT_INVALID');
    domains.add(enrollment.domain);
    witnesses.set(enrollment.domain, {
      writerId: enrollment.writerId,
      witness: createRecoveryWitness({
        writerId: enrollment.writerId, port: enrollment.port, verifySealedProof: enrollment.verifySealedProof,
      }),
    });
  }
  const admission = createRecoveryRuntimeGate(database);
  let stopped = false;
  let running: Promise<void> | undefined;

  async function reconcileDomain(domain: string): Promise<WitnessAdmissionOutcome> {
    const { witness, writerId } = witnesses.get(domain)!;
    const record = await witness.current(domain);
    if (!record) {
      admission.revoke(domain);
      return 'witness_unreachable';
    }
    if (record.writerId !== writerId) {
      admission.revoke(domain);
      return 'writer_lost';
    }
    if (record.state === 'sealed') {
      admission.revoke(domain);
      if (!record.certificate || !await witness.verifySealed(record)) return 'proof_unverified';
      const activationId = randomUUID();
      const claim = await witness.claimRecoveryWriter(domain, record.revision, activationId);
      if (claim !== 'acquired') return claim === 'lost' ? 'writer_lost' : 'proof_unverified';
      const winner = await witness.current(domain);
      if (winner?.state !== 'open' || winner.writerId !== writerId || winner.activationId !== activationId
        || winner.parentSealedRevision !== record.revision) return 'proof_unverified';
      const row = gate(database, domain);
      if (!row || !matches(row, winner)) return 'domain_unregistered';
      return admit(database, admission, winner) ? 'admitted' : 'revoked';
    }
    const row = gate(database, domain);
    if (!row || row.status === 'protection_pending') {
      admission.revoke(domain);
      return 'domain_unregistered';
    }
    if (!matches(row, record) || record.activationId === null) {
      admission.revoke(domain);
      return 'revoked';
    }
    return admit(database, admission, record) ? 'admitted' : 'revoked';
  }

  function run(action: () => Promise<Readonly<Record<string, WitnessAdmissionOutcome>>>) {
    if (stopped) throw new Error('WITNESS_ADMISSION_STOPPED');
    const pass = (running ?? Promise.resolve()).then(action, action);
    running = pass.then(() => undefined, () => undefined);
    return pass;
  }

  return Object.freeze({
    reconcile: () => run(async () => {
      const outcomes: Record<string, WitnessAdmissionOutcome> = {};
      for (const domain of domains) outcomes[domain] = await reconcileDomain(domain);
      return Object.freeze(outcomes);
    }),
    recheck: () => run(async () => {
      const outcomes: Record<string, WitnessAdmissionOutcome> = {};
      for (const domain of domains) {
        const record = await witnesses.get(domain)!.witness.current(domain);
        const row = gate(database, domain);
        if (!record || record.state !== 'open' || record.writerId !== witnesses.get(domain)!.writerId
          || !row || !matches(row, record)) {
          admission.revoke(domain);
          outcomes[domain] = record ? 'revoked' : 'witness_unreachable';
        } else outcomes[domain] = recoveryWriteAllowed(database, domain) ? 'admitted' : 'revoked';
      }
      return Object.freeze(outcomes);
    }),
    stop() { stopped = true; },
  });
}
