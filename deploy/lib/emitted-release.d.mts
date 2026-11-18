export type DarwinTarget = Readonly<{ os: 'darwin'; arch: 'arm64' | 'x64' }>;
export type SchemaInterval = Readonly<{ min: number; max: number }>;
export type EmittedSourceIdentity = Readonly<{
  kind: 'commit' | 'pinned-snapshot'; commit: string; snapshotSha256: string; lockSha256: string;
}>;
export type EmittedNativeIdentity = Readonly<{
  path: string; sha256: string; bytes: number; format: 'mach-o'; architecture: DarwinTarget['arch'];
  observedArchitecture: DarwinTarget['arch']; observedNode: string; observedModules: string; observedLoad: true; sqlite: string;
}>;
export type EmittedRuntimeIdentity = Readonly<{ node: string; modules: string; npm: string; native: EmittedNativeIdentity }>;
export type EmittedRuntimeMaterial = Readonly<{
  path: string; mode: '100644' | '100755'; bytes: number; sha256: string;
  role: 'runtime-entry' | 'runtime-shared-chunk' | 'storage-migration-manifest' | 'storage-migration' | 'web-entry' |
    'web-asset' | 'runtime-package-code' | 'runtime-package-metadata' | 'runtime-package-license' | 'native-addon' | 'runtime-inventory';
}>;
export type EmittedMaterialIdentity = Readonly<{
  format: 'patrick-emitted-runtime-material-identity-v1'; version: string; source: EmittedSourceIdentity; target: DarwinTarget;
  schema: SchemaInterval; runtime: EmittedRuntimeIdentity; toolchainSha256: string; inventorySha256: string; sbomSha256: string;
  materials: readonly EmittedRuntimeMaterial[]; materialSha256: string;
}>;
/** Provisioned by the trusted host. Writers are excluded through callback completion, including awaited use. */
export interface ExclusiveRuntimeStaging {
  withExclusiveReadRoot<T>(read: (physicalRoot: string) => Promise<T>): Promise<T>;
}
export type EmittedReleaseExpectation = Readonly<{
  version: string; target: DarwinTarget; schema: SchemaInterval; activeSchema: number; source: EmittedSourceIdentity;
  runtime: Readonly<{ node: string; modules: string }>; toolchainSha256: string; inventorySha256: string;
  materialSha256: string; packageSha256: string;
}>;
export type EmittedReleaseTrustPolicy = Readonly<{
  keys: readonly Readonly<{ id: string; publicKey: string }>[];
  executionReportSha256: string;
  requiredScenarios: readonly Readonly<{ id: string; evidenceSha256: string }>[];
}>;
declare const verified: unique symbol;
declare const staged: unique symbol;
export type VerifiedEmittedRuntimeCandidate = Readonly<Omit<EmittedMaterialIdentity, 'format' | 'sbomSha256'> & {
  [verified]: true; kind: 'emitted-runtime-candidate'; packageSha256: string; manifestSha256: string; nativeSha256: string;
}>;
export type StagedEmittedRuntime = Readonly<{ [staged]: true; packageSha256: string; materialSha256: string }>;
export type AdmittedEmittedRuntime = Readonly<{
  root: string; entrypoints: Readonly<Record<'composition' | 'service' | 'cli' | 'worker', string>>;
  packageSha256: string; materialSha256: string; inventorySha256: string; runtime: EmittedRuntimeIdentity;
}>;
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
  staging: ExclusiveRuntimeStaging; destination: string;
}): Promise<StagedEmittedRuntime>;
/** Entry paths may be consumed inside the awaited callback while the host lease is held. */
export function withStagedEmittedRuntime<T>(receipt: VerifiedEmittedRuntimeCandidate, staged: StagedEmittedRuntime,
  use: (runtime: AdmittedEmittedRuntime) => Promise<T>): Promise<T>;
