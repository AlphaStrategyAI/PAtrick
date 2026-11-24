export type HostedCandidateEntry = Readonly<{
  architecture: string;
  commit: string;
  snapshotSha256: string | null;
  lockSha256: string | null;
  node: string;
  modules: string;
  npm: string;
  sqlite: string;
  archiveSha256: string;
  inventorySha256: string;
  payloadFiles: number;
  nativeSha256: string;
  nativeDescription: string;
  sourceCandidateSha256: string;
  sourceManifestSha256: string;
}>;

export type VerifyCandidateTreeOptions = Readonly<{
  workspace?: string;
  expectedCommit?: string;
  inspectNative?: (path: string, architecture: string) => string;
}>;

export function verifyCandidateTree(
  tree: string,
  options?: VerifyCandidateTreeOptions,
): Readonly<Record<string, HostedCandidateEntry>>;
