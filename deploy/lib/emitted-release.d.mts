import type { DeploymentKey, DeploymentRole, EmittedReleaseProfile } from './deployment-templates.mjs';
export type DarwinTarget = Readonly<{ os: 'darwin'; arch: 'arm64' | 'x64' }>;
export type SchemaInterval = Readonly<{ min: number; max: number }>;
export type EmittedSourceIdentity = Readonly<{
  kind: 'commit' | 'pinned-snapshot'; commit: string; snapshotSha256: string; lockSha256: string;
}>;
export type EmittedNativeIdentity = Readonly<{
  path: string; sha256: string; bytes: number; format: 'mach-o'; architecture: DarwinTarget['arch'];
  observedArchitecture: DarwinTarget['arch']; observedNode: string; observedModules: string; observedLoad: true; sqlite: string;
}>;
export type NativeByteProfile = 'deployment-complete-native-v3';
type StageableProfile = Exclude<EmittedReleaseProfile, NativeByteProfile>;
export type DirectoryNativeIdentity = Readonly<{
  path: 'native/patrick-directory.node'; role: 'directory-diagnostic-addon'; mode: '100755'; sha256: string; bytes: number;
  format: 'mach-o'; fileType: 'MH_BUNDLE'; architecture: DarwinTarget['arch']; deploymentTarget: '14.0'; sdk: '27.0';
  dependencies: readonly ['/usr/lib/libSystem.B.dylib', '/usr/lib/libc++.1.dylib']; interfaceVersion: 1; napiVersion: 8;
}>;
export type EmittedRuntimeIdentity = Readonly<{ node: string; modules: string; npm: string; native: EmittedNativeIdentity }>;
export type NativeByteRuntimeIdentity = EmittedRuntimeIdentity & Readonly<{
  node: 'v26.13.0'; modules: '147'; napi: '10'; directoryNative: DirectoryNativeIdentity;
}>;
export type EmittedRuntimeMaterial = Readonly<{
  path: string; mode: '100644' | '100755'; bytes: number; sha256: string;
  role: DeploymentRole | 'runtime-entry' | 'runtime-shared-chunk' | 'storage-migration-manifest' | 'storage-migration' | 'web-entry' |
    'web-asset' | 'runtime-package-code' | 'runtime-package-metadata' | 'runtime-package-license' | 'native-addon' | 'directory-diagnostic-addon' | 'runtime-inventory';
}>;
export type EmittedMaterialIdentity = Readonly<{
  version: string; source: EmittedSourceIdentity; target: DarwinTarget;
  schema: SchemaInterval; runtime: EmittedRuntimeIdentity; toolchainSha256: string; inventorySha256: string; sbomSha256: string;
  materials: readonly EmittedRuntimeMaterial[]; materialSha256: string;
} & ({ format: 'patrick-emitted-runtime-material-identity-v1'; profile?: never } |
  { format: 'patrick-emitted-runtime-material-identity-v2'; profile: 'deployment-complete' } |
  { format: 'patrick-emitted-runtime-material-identity-v3'; profile: NativeByteProfile; runtime: NativeByteRuntimeIdentity; directoryAuthoritySha256: string })>;
/** Provisioned by the trusted host. Writers are excluded through callback completion, including awaited use. */
export interface ExclusiveRuntimeStaging {
  /** Optional trusted registration. Both canonical directories must exist apart from
   * the archive under this owner, which excludes all competing writes and renames. */
  readonly publication?: Readonly<{ stagingRoot: string; releasesRoot: string }>;
  withExclusiveReadRoot<T>(read: (physicalRoot: string) => Promise<T>): Promise<T>;
}
type InstalledOwnerNode = Readonly<{ device: string; inode: string; birthtimeNs: string }>;
export function createInstalledRootOwner(registration: Readonly<{
  root: string; rootNode: InstalledOwnerNode; lockNode: InstalledOwnerNode;
}>): ExclusiveRuntimeStaging;
declare const runtimeLease: unique symbol;
/** The live value is issued only to a `leased` callback and expires with it. */
export type RuntimeLease = Readonly<{ root: string; guard(): void; readonly [runtimeLease]: true }>;
/** An additional admission check strengthens every guard and never substitutes
 * the exact owner identity or any genuine derived parent guard. */
export function leased<T>(owner: ExclusiveRuntimeStaging, work: (lease: RuntimeLease) => Promise<T>, joinWork?: boolean,
  validate?: () => void): Promise<T>;
/** Use the exact returned object with `leased` or fixed emitted-release APIs; wrappers
 * and direct callbacks cannot discard its live parent guard. The root cannot widen. */
export function deriveRuntimeStaging(parent: RuntimeLease, root: string,
  publication?: NonNullable<ExclusiveRuntimeStaging['publication']>): ExclusiveRuntimeStaging;
export type EmittedReleaseExpectation = Readonly<{
  profile?: StageableProfile; version: string; target: DarwinTarget; schema: SchemaInterval; activeSchema: number; source: EmittedSourceIdentity;
  runtime: Readonly<{ node: string; modules: string }>; toolchainSha256: string; inventorySha256: string;
  materialSha256: string; packageSha256: string;
}>;
export type NativeByteReleaseExpectation = Omit<EmittedReleaseExpectation, 'profile'> & Readonly<{
  profile: NativeByteProfile; directoryAuthoritySha256: string; directoryNativeSha256: string;
}>;
export type EmittedReleaseTrustPolicy = Readonly<{
  keys: readonly Readonly<{ id: string; publicKey: string }>[];
  executionReportSha256: string;
  requiredScenarios: readonly Readonly<{ id: string; evidenceSha256: string }>[];
}>;
declare const verified: unique symbol;
declare const staged: unique symbol;
export type VerifiedEmittedRuntimeCandidate = Readonly<Omit<EmittedMaterialIdentity, 'format' | 'sbomSha256' | 'profile'> & {
  profile: StageableProfile; [verified]: true; kind: 'emitted-runtime-candidate'; packageSha256: string; manifestSha256: string; nativeSha256: string;
}>;
export type VerifiedNativeByteCandidate = Omit<VerifiedEmittedRuntimeCandidate, 'profile' | 'runtime'> & Readonly<{
  profile: NativeByteProfile; runtime: NativeByteRuntimeIdentity; directoryAuthoritySha256: string; directoryNativeSha256: string;
}>;
export type StagedEmittedRuntime = Readonly<{ [staged]: true; profile: StageableProfile; packageSha256: string; materialSha256: string }>;
type StagedRuntimePaths = Readonly<{
  root: string; entrypoints: Readonly<Record<'composition' | 'service' | 'cli' | 'worker', string>>;
  packageSha256: string; materialSha256: string; inventorySha256: string; runtime: EmittedRuntimeIdentity;
}>;
export type AdmittedDeployment = Readonly<StagedRuntimePaths & {
  profile: 'deployment-complete'; templates: Readonly<Record<DeploymentKey, string>>;
  servicePreflight?: Readonly<{ path: string; sha256: string }>;
  autoloopHub?: Readonly<{ commit: string; root: string; entry: string; initializer: string }>;
}>;
export type AdmittedEmittedRuntime = AdmittedDeployment | Readonly<StagedRuntimePaths & { profile: 'runtime-only' }>;
export function withStagedDeployment<T>(receipt: VerifiedEmittedRuntimeCandidate, staged: StagedEmittedRuntime,
  use: (runtime: AdmittedDeployment) => Promise<T>): Promise<T>;
/**
 * The host registers the canonical releasesRoot and the same exclusive owner used
 * to verify the separate package. Both locations must be below that physical owner.
 * Paths are valid during awaited use. A late rejection can follow an executed callback.
 */
export function withPublishedDeployment<T>(receipt: VerifiedEmittedRuntimeCandidate, options: {
  staging: ExclusiveRuntimeStaging; releasesRoot: string; hubGroup?: number;
}, use: (runtime: AdmittedDeployment) => Promise<T>): Promise<T>;
export function verifyEmittedRuntimeCandidate(candidatePath: string, options: {
  staging: ExclusiveRuntimeStaging; expected: NativeByteReleaseExpectation; policy: EmittedReleaseTrustPolicy;
}): Promise<VerifiedNativeByteCandidate>;
export function verifyEmittedRuntimeCandidate(candidatePath: string, options: {
  staging: ExclusiveRuntimeStaging; expected: EmittedReleaseExpectation; policy: EmittedReleaseTrustPolicy;
}): Promise<VerifiedEmittedRuntimeCandidate>;
export type EmittedWriteFailure = Readonly<Error & {
  code: 'EMITTED_WRITE_ROLLED_BACK' | 'EMITTED_WRITE_UNCERTAIN';
  operation: 'pack' | 'stage'; path: string; packageSha256: string;
}>;
export type EmittedWriteOutcome = Readonly<Pick<EmittedWriteFailure, 'operation' | 'path' | 'packageSha256'> & (
  { state: 'absent' | 'owned' | 'partial' | 'changed'; owned: number; changed: number; absent: number } |
  { state: 'unavailable' }
)>;
/** Read-only reconciliation of the original failure under its privately retained host lease. */
export function readEmittedWriteOutcome(failure: unknown): Promise<EmittedWriteOutcome>;
/** A failed lease completion can reject with EmittedWriteFailure. */
export function stageVerifiedEmittedRuntime(receipt: VerifiedEmittedRuntimeCandidate, options: {
  staging: ExclusiveRuntimeStaging; destination: string; hubGroup?: number;
}): Promise<StagedEmittedRuntime>;
/** Entry paths may be consumed inside the awaited callback while the host lease is held. */
export function withStagedEmittedRuntime<T>(receipt: VerifiedEmittedRuntimeCandidate, staged: StagedEmittedRuntime,
  use: (runtime: AdmittedEmittedRuntime) => Promise<T>): Promise<T>;

export type EmittedPublicationUncertain = Readonly<Error & {
  code: 'EMITTED_PUBLICATION_UNCERTAIN'; path: string; packageSha256: string;
}>;
/** Atomically publishes a genuine paired stage to its owner's enrolled digest slot.
 * Requires a same-volume, exclusively controlled store. Once rename is attempted,
 * any failure (including lease completion loss) is EmittedPublicationUncertain.
 * Reconcile read-only with withPublishedDeployment before any later lifecycle decision. */
export function publishStagedDeployment(receipt: VerifiedEmittedRuntimeCandidate, staged: StagedEmittedRuntime):
  Promise<Readonly<{ path: string; packageSha256: string }>>;
