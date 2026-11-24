import type { selectVaultInit, VaultInitCliEntry } from '../runtime/vault-init-cli.js';
import type { InstallPreviewEnrollment, InstallReleaseEnrollment, observeInstallSession, prepareFirstInstallGeneration, previewFirstInstall, runFirstInstallRelease } from '../runtime/install-preview.js';
import type { createLifecycleJournalReader, LifecycleRegistration } from '../runtime/lifecycle-journal.js';
import type { createRecoveryBackupReader, createRecoveryOperations } from '../../packages/host/src/recovery/operations.js';
import type { createNetworkInspector } from '../../packages/host/src/network/probes.js';
import type { createNodeNetworkProbePorts } from '../../packages/host/src/network/node-probes.js';
import type { createObsidianDoctor } from '../obsidian/doctor.mjs';
import type { createVaultKitInstaller } from '../obsidian/install.mjs';
import type { ReleaseExpectation, ReleaseTrustPolicy } from './release.mjs';
export type HostIdentity = { accountId: string; scopeId: string; domains: string[]; deviceId: string; configRevision: string };
export type DoctorState = 'ready' | 'blocked' | 'unavailable' | 'unknown';
export type DoctorCheck = {
  status: DoctorState; impact: 'core' | 'task' | 'editor' | 'channel';
  evidence: Record<string, unknown>; observedAt: string; nextStep: string;
};
export type DoctorReport = { identity?: HostIdentity; checks: Record<string, DoctorCheck> };
export type VaultRegistration = {
  identity: HostIdentity; configRevision: number; scopeHash: string;
  options: Parameters<typeof createObsidianDoctor>[0];
  installer?: Parameters<typeof createVaultKitInstaller>[0];
};
/** Supplied in-process by a trusted installed controller. Never deserialize these ports from requests or task environment. */
export type RegisteredHost = {
  identity: HostIdentity; captureHost: string; serviceUid: number; profile: string;
  dataRoot: string; minimumFreeBytes: number;
  runtime?: {
    createRecoveryOperations?: typeof createRecoveryOperations;
    createRecoveryBackupReader?: typeof createRecoveryBackupReader;
    selectVaultInit?: typeof selectVaultInit;
    previewFirstInstall?: typeof previewFirstInstall;
    observeInstallSession?: typeof observeInstallSession;
    prepareFirstInstallGeneration?: typeof prepareFirstInstallGeneration;
    runFirstInstallRelease?: typeof runFirstInstallRelease;
    createLifecycleJournalReader?: typeof createLifecycleJournalReader;
    createNetworkInspector?: typeof createNetworkInspector;
    createNodeNetworkProbePorts?: typeof createNodeNetworkProbePorts;
    createObsidianDoctor?: typeof createObsidianDoctor;
    createVaultKitInstaller?: typeof createVaultKitInstaller;
  };
  recovery?: Parameters<typeof createRecoveryOperations>[0];
  backupReadback?: Parameters<typeof createRecoveryBackupReader>[0];
  vaultInitOperations?: Readonly<Record<string, VaultInitCliEntry>>;
  installPreviews?: Readonly<Record<string, InstallPreviewEnrollment>>;
  installOperations?: Readonly<Record<string, InstallReleaseEnrollment>>;
  lifecycleReadbacks?: Readonly<Record<string, LifecycleRegistration>>;
  recoveryReadbacks?: readonly { targetId: string; backupOperationId: string; drillOperationId: string; manifestHash: string }[];
  network?: {
    identity: HostIdentity; policy: Parameters<typeof createNetworkInspector>[0];
    ports?: Parameters<typeof createNetworkInspector>[1];
    node?: Parameters<typeof createNodeNetworkProbePorts>[0]; originTargetId: string; origin?: string;
  };
  origin?: string; rpId?: string;
  dependencies?: readonly { id: string; path: string }[];
  vaults?: Record<string, VaultRegistration>;
  /** Owns the exclusive staging tree and ancestry throughout the callback, preventing concurrent untrusted mutation.
   * The callback receives an independently provisioned physical root. This is a host authority port, never a request boolean.
   * Public Node path APIs retain the documented hostile replace-and-restore ABA boundary.
   */
  releases?: Record<string, {
    identity: HostIdentity; candidatePath: string; expected: ReleaseExpectation; policy: ReleaseTrustPolicy;
    staging?: { withExclusiveReadRoot<T>(read: (physicalRoot: string) => Promise<T>): Promise<T> };
  }>;
  readiness?: Partial<Record<'service' | 'executor' | 'plugins' | 'channels', {
    identity: HostIdentity;
    inspect(signal: AbortSignal): Promise<Partial<Record<'liveness' | 'readiness' | 'capability' | 'receive' | 'send' | 'callback', DoctorState>>>;
  }>>;
};
/** Exact bounded public identity projection. Trusted configuration binding retains its full input. */
export function projectIdentity(identity: HostIdentity): HostIdentity;
export function sameIdentity(left: HostIdentity | undefined, right: HostIdentity | undefined): boolean;
export function inspectLocalHost(host?: RegisteredHost): Promise<Record<string, DoctorCheck>>;
export function doctor(host?: RegisteredHost, vaultId?: string): Promise<DoctorReport>;

/** Captures plain configuration while preserving executable ports and opaque runtime handles.
 * validate re-reads the current selection and rejects replacement or in-place changes.
 */
export function bindRegistration<T>(read: () => T): { value: T; validate(): void };
export function bindHostRegistration(host?: RegisteredHost): {
  value: Pick<RegisteredHost, 'identity' | 'captureHost' | 'serviceUid' | 'profile' | 'dataRoot' | 'minimumFreeBytes' | 'runtime' | 'dependencies'> | undefined;
  validate(): void;
};
