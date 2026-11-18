import type { SqliteDatabase } from '@patrick/storage';

export type WithdrawalHead = { seq: number; hash: string };
export type RecoveryDomain = { domain: string; writerEpoch: string; withdrawal: WithdrawalHead };
export type RecoveryResource = { kind: 'vault' | 'blob' | 'handoff' | 'vault_kit' | 'version_lock'; root: string; domain?: string; vaultId?: string };
export type RecoveryScope = { setId: string; domains: RecoveryDomain[]; resources: RecoveryResource[]; versionLocks: Record<string, string> };
export type RecoveryManifestAuthority = {
  keyId: string;
  sign(bytes: Uint8Array): Promise<string>;
  verify(bytes: Uint8Array, signature: string, keyId: string): Promise<boolean>;
};
export type RecoveryFreezeLease = {
  cutId: string; ingressFrozen: boolean; claimsFrozen: boolean; receiptsFrozen: boolean;
  effectsFrozen: boolean; executionTreesStopped: boolean; uncertainCallsJournaled: boolean;
  durableHandoff: boolean; release(): Promise<void>;
};
export type RecoveryFreezePort = { acquire(domains: readonly string[]): Promise<RecoveryFreezeLease> };
export type RecoveryDatabases = { service: SqliteDatabase; hub: SqliteDatabase };
export type RecoveryDatabaseState = {
  hubSeq: number; domainSeq: number; schemaHistory: Array<{ file: string; sha256: string }>;
};
export type RecoveryDatabaseQuery = { prepare(sql: string): { get(): unknown; all(): unknown[] } };
export type RecoveryDatabaseReader = (db: SqliteDatabase, role: 'service' | 'hub') => RecoveryDatabaseState;
export type RecoveryArtifact = {
  path: string; hash: string; bytes: number; kind: 'database' | RecoveryResource['kind']; domain: string | null;
};
export type RecoveryProtection = {
  status: 'local_only' | 'off_host_verified'; targetId: string | null; snapshotId: string | null;
  recoveryCredentialRef: string | null; verifiedAt: string | null;
};
export type RecoveryVault = {
  vaultId: string; accountId: string; sourceId: string; domain: string; physicalRoot: string;
  canonicalRoot: string | null; rootIdentity: string; scopeHash: string; resourcePrefix: string | null;
};
export type RecoveryManifest = {
  schemaVersion: '1.0'; setId: string; createdAt: string; cutId: string; domains: RecoveryDomain[];
  versionLocks: Record<string, string>; databases: { service: RecoveryDatabaseState; hub: RecoveryDatabaseState };
  artifacts: RecoveryArtifact[]; vaults: RecoveryVault[]; completeness: { recoverable: boolean; gaps: string[] };
  protection: RecoveryProtection;
};
export type RecoverySet = { directory: string; manifest: RecoveryManifest; manifestHash: string };
export type RecoveryOffHostPort = {
  protect(set: RecoverySet): Promise<{
    encrypted: true; offHost: true; verified: true; domains: string[]; targetId: string;
    snapshotId: string; recoveryCredentialRef: string; verifiedAt: string; manifestHash: string;
  }>;
};
export type WithdrawalEntry = {
  domain: string; seq: number; writerEpoch: string; previousHash: string; hash: string;
  event: { eventId: string; targetKind: string; targetId: string; targetVersion: number; epoch: number; reason: string; createdAt: string };
};
export type RecoveryStage = { stage: string; startedAt: string; finishedAt: string; status: 'complete' | 'blocked'; reasons: string[] };
export type RecoveryDomainReceipt = { status: 'blocked' | 'open' | 'imported'; writerEpoch: string | null; activationId: string | null; reasons: string[] };
export type RecoveryReceipt = {
  receiptId: string; setId: string; mode: 'drill' | 'activate' | 'owner_import'; directory: string;
  startedAt: string; finishedAt: string; elapsedMs: number; rpoMs: number | null;
  orderlyHandoff: boolean; external_writes: number; channels: { feishu: 'requires_reauthorization' };
  data_domains: Record<string, RecoveryDomainReceipt>; stages: RecoveryStage[];
  conflicts: Array<{ domain: string; vaultId?: string; path: string; backupHash: string; survivorHash: string; preservedBackupPath: string }>;
};
export type RecoveryRestoreReceipt = RecoveryReceipt & { manifestHash: string };
