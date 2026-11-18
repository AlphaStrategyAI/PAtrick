export interface ReleaseExpectation {
  version: string;
  commit: string;
  os: string;
  arch: string;
  schema: number;
  packageSha256?: string;
}
export interface ReleaseTrustPolicy {
  keys: readonly { id: string; publicKey: string }[];
  requiredEvidence: readonly string[];
}
export interface VerifiedReleaseCandidate {
  readonly status: 'verified-candidate';
  readonly installable: false;
  readonly sha256: string;
  readonly manifestSha256: string;
  readonly version: string;
  readonly commit: string;
  readonly target: Readonly<{ os: 'darwin'; arch: 'arm64' | 'x64' }>;
  readonly runtime: Readonly<{ status: 'unavailable'; prerequisites: readonly string[] }>;
}
export const RELEASE_LIMITS: Readonly<{ packageBytes: number; artifactBytes: number; totalBytes: number; files: number; evidenceEntries: number; evidenceDepth: number }>;
export function canonicalize(value: unknown): string;
export function sha256(bytes: Uint8Array): string;
export function validatePaths(paths: readonly string[]): void;
export interface ReadRootAdmission { readonly root: string; validate(): void }
/** Physical root and ancestors must remain exclusively controlled during reads. */
export function admitReadRoot(root: string): ReadRootAdmission;
export function readRegularFile(path: string, limit: number | undefined, admission: ReadRootAdmission): Promise<Buffer>;
export function verifyRelease(path: string, options: { policy: ReleaseTrustPolicy; expected: ReleaseExpectation; readRoot: string }): Promise<VerifiedReleaseCandidate>;
export function requireInstallableRelease(receipt: unknown): never;
