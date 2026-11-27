import { isDeepStrictEqual } from 'node:util';
import {
  createRecoveryBackupReader, type RecoveryBackupReadbackTarget, type RecoveryJournalRoot,
} from '../../packages/host/src/recovery/operations.js';
import type { RecoveryArtifact, RecoveryManifestAuthority, RecoveryScope, RecoverySet } from '../../packages/host/src/recovery/types.js';
import { sameIdentity } from '../lib/doctor.mjs';
import { createLifecycleJournalReader, type LifecycleRegistration, type LifecycleRequest } from './lifecycle-journal.js';

type CutSubject = Readonly<{
  installationId: string;
  generationId: string;
  selectionSha256: string;
  releaseSha256: string;
  claimSha256: string;
  planSha256: string;
  fenceEpoch: string;
  upgradeOperationId: string;
  operationId: string;
  targetId: string;
  setId: string;
  cutId: string;
}>;
type FenceObservation = Readonly<{
  subject: CutSubject;
  status: 'closed_and_fenced';
  fenceReceiptId: string;
  currentFenceEpoch: string;
  manifestHash: string;
  localAnswersSha256: string;
}>;
type Verifier = Pick<RecoveryManifestAuthority, 'keyId' | 'verify'>;
export type VerifiedCutMaterial = Readonly<{ directory: string; artifacts: readonly Readonly<RecoveryArtifact>[] }>;
export type MaintenanceCutReadbackRegistration = {
  subject: CutSubject;
  journalRoot: RecoveryJournalRoot;
  journalAuthority: Verifier;
  target: RecoveryBackupReadbackTarget;
  lifecycle: LifecycleRegistration;
  readContinuousFence(subject: CutSubject): Promise<FenceObservation | undefined>;
};

const sha256 = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const name = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);

export function assertMaintenanceRecoverySet(set: RecoverySet, expected: {
  scope: RecoveryScope; cutId: string; manifestHash: string; localAnswersSha256: string;
}): void {
  const { manifest } = set;
  const { scope, cutId, manifestHash, localAnswersSha256 } = expected;
  const prefix = `resources/${scope.resources.length - 1}/`;
  const handoff = manifest.artifacts.filter((artifact) => artifact.path.startsWith(prefix));
  if (set.manifestHash !== manifestHash || manifest.cutId !== cutId || manifest.setId !== scope.setId ||
      !isDeepStrictEqual(manifest.domains, scope.domains) || manifest.completeness.recoverable !== true ||
      scope.resources.at(-1)?.kind !== 'handoff' || handoff.length !== 1 || handoff[0].kind !== 'handoff' ||
      handoff[0].path !== `${prefix}local-answers.sqlite` || handoff[0].hash !== localAnswersSha256) {
    throw new Error('MAINTENANCE_CUT_MISMATCH');
  }
}

function bindVerifier(authority: Verifier): Verifier {
  return { keyId: authority.keyId, verify: authority.verify.bind(authority) };
}

export function createMaintenanceCutReader(registration: MaintenanceCutReadbackRegistration) {
  const subject = Object.freeze(structuredClone(registration.subject));
  const { installationId, generationId, selectionSha256, releaseSha256, claimSha256, planSha256, fenceEpoch, upgradeOperationId,
    operationId, targetId, setId, cutId } = subject;
  const scope = structuredClone(registration.target.scope);
  if (![installationId, generationId, fenceEpoch, upgradeOperationId, operationId, targetId, setId, cutId].every(name) ||
      ![selectionSha256, releaseSha256, claimSha256, planSha256].every(sha256) ||
      scope.setId !== setId || scope.resources.at(-1)?.kind !== 'handoff') {
    throw new Error('MAINTENANCE_CUT_MISMATCH');
  }
  const lifecycle = createLifecycleJournalReader(() => registration.lifecycle);
  const identity = structuredClone(registration.target.identity);
  const claimRequest: LifecycleRequest = { command: 'upgrade', operationId: upgradeOperationId,
    targetId: releaseSha256, expectedGeneration: generationId, planSha256 };
  const observe = registration.readContinuousFence.bind(registration);
  const { protection } = registration.target;
  const backup = createRecoveryBackupReader({
    root: { ...registration.journalRoot },
    authority: bindVerifier(registration.journalAuthority),
    targets: { [targetId]: {
      ...registration.target,
      identity,
      authority: bindVerifier(registration.target.authority),
      scope,
      protection: protection?.kind === 'off_host' ? { kind: 'off_host', verify: protection.verify.bind(protection) }
        : protection && { ...protection },
    } },
  });

  async function currentFence() {
    const claim = await lifecycle.readClaim(claimRequest);
    if (claim?.claimSha256 !== claimSha256 || claim.binding.plan.releaseSha256 !== releaseSha256 ||
        claim.binding.identity.installationId !== installationId || !sameIdentity(claim.binding.identity, identity)) {
      throw new Error('MAINTENANCE_UPGRADE_CLAIM_UNCONFIRMED');
    }
    const observed = await observe(subject);
    if (!observed || observed.status !== 'closed_and_fenced' || !isDeepStrictEqual(observed.subject, subject) ||
        observed.currentFenceEpoch !== fenceEpoch ||
        !name(observed.fenceReceiptId) || !sha256(observed.manifestHash) || !sha256(observed.localAnswersSha256)) {
      throw new Error('MAINTENANCE_CLOSE_UNCONFIRMED');
    }
    const { fenceReceiptId, manifestHash, localAnswersSha256 } = observed;
    return { fenceReceiptId, manifestHash, localAnswersSha256 };
  }

  async function verifyCut() {
    const fence = await currentFence();
    let verified: VerifiedCutMaterial | undefined;
    const result = await backup.read({ operationId, targetId, mode: 'backup' }, (set) => {
      assertMaintenanceRecoverySet(set, { scope, cutId, ...fence });
      verified = Object.freeze({ directory: set.directory,
        artifacts: Object.freeze(set.manifest.artifacts.map(artifact => Object.freeze({ ...artifact }))) });
    });
    if (result.status !== 'completed' || !verified || !isDeepStrictEqual(await currentFence(), fence)) {
      throw new Error('MAINTENANCE_CLOSE_UNCONFIRMED');
    }
    const receipt = { status: 'verified' as const, operationId, setId, cutId,
      manifestHash: fence.manifestHash, fenceReceiptId: fence.fenceReceiptId };
    return { receipt, verified };
  }
  return Object.freeze({
    async read() { return (await verifyCut()).receipt; },
    async useVerifiedSet<T>(expected: Awaited<ReturnType<typeof verifyCut>>['receipt'], use: (set: VerifiedCutMaterial) => Promise<T>) {
      const { verified, receipt } = await verifyCut();
      if (!isDeepStrictEqual(receipt, expected)) throw new Error('MAINTENANCE_CLOSE_UNCONFIRMED');
      const output = await use(verified);
      if (!isDeepStrictEqual((await verifyCut()).receipt, expected)) throw new Error('MAINTENANCE_CLOSE_UNCONFIRMED');
      return output;
    },
  });
}
