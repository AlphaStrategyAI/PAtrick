import type { DarwinTarget, EmittedMaterialIdentity, EmittedSourceIdentity, ExclusiveRuntimeStaging, SchemaInterval } from '../deploy/lib/emitted-release.mjs';
export type { EmittedMaterialIdentity, EmittedWriteFailure, EmittedWriteOutcome } from '../deploy/lib/emitted-release.mjs';
export type EmittedMaterialInput = Readonly<{
  staging: ExclusiveRuntimeStaging; artifactRoot: string; version: string; target: DarwinTarget; schema: SchemaInterval;
  expectedSource: EmittedSourceIdentity; expectedInventorySha256: string; lockPath: string;
  toolchain: Readonly<{ path: string; sha256: string }>;
}>;
export type ExplicitEvidenceInput = Readonly<{
  report: Readonly<{ path: string; sha256: string }>;
  logs: readonly Readonly<{ id: string; path: string; sha256: string }>[];
}>;
declare const prepared: unique symbol;
export type PreparedEmittedRuntimeCandidate = Readonly<{
  [prepared]: true; signingManifestBase64: string; manifestSha256: string; materialSha256: string; inventorySha256: string;
}>;
export type DetachedReleaseSignature = Readonly<{ keyId: string; signature: string }>;
export type PackedEmittedRuntimeCandidate = Readonly<{
  packageSha256: string; manifestSha256: string; materialSha256: string; inventorySha256: string; bytes: number;
}>;
export function inspectEmittedRuntimeMaterial(input: EmittedMaterialInput): Promise<EmittedMaterialIdentity>;
export function prepareEmittedRuntimeCandidate(input: EmittedMaterialInput & {
  expectedMaterialSha256: string; evidence: ExplicitEvidenceInput;
}): Promise<PreparedEmittedRuntimeCandidate>;
/** Read a failed lease completion with readEmittedWriteOutcome from the trusted verifier module. */
export function packEmittedRuntimeCandidate(prepared: PreparedEmittedRuntimeCandidate, options: {
  signatures: readonly DetachedReleaseSignature[]; outputPath: string; outputStaging: ExclusiveRuntimeStaging;
}): Promise<PackedEmittedRuntimeCandidate>;
