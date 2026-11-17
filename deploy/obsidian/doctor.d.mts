import type { SqliteDatabase } from '../../packages/storage/src/database.js';
import type { VaultConnection, VaultRecord } from '../../packages/integrations/vault/connection.js';
import type { VaultDeploymentPorts } from './install.mjs';

type MacApplication = {
  path: string;
  version: string | null;
  signature: 'verified' | 'invalid' | 'unexpected_signer';
  architecture: 'universal' | null;
};

type MacObservation = {
  application: MacApplication | null;
  uriHandler?: string | null;
  running?: boolean;
};

export type ObsidianProbe = {
  deviceId: string;
  application: { status: 'missing' | 'unknown' } | MacApplication & {
    status: 'ready' | 'untrusted' | 'incompatible' | 'unknown';
  };
  installer: { status: 'pinned' | 'unverified'; version: string | null; sha256: string | null };
  uri: 'registered' | 'unregistered' | 'different_handler' | 'unknown';
  process: 'running' | 'stopped' | 'unknown';
};

export function createObsidianInspector(options: {
  localDeviceId: string;
  lockedVersion: string | null;
  installerHash: string | null;
  readMacState: () => Promise<MacObservation | null>;
}): (deviceId: string) => Promise<ObsidianProbe>;

export function inspectObsidian(deviceId: string): Promise<ObsidianProbe>;
export function readMacObsidianState(): Promise<MacObservation | null>;

export type ObsidianDeviceMapping = {
  vaultId: string;
  deviceId: string;
  alias: string;
  mappingRevision: number;
};

export function obsidianEditTarget(editor: ObsidianProbe, mapping: ObsidianDeviceMapping | null, edit: {
  vaultId: string;
  relativePath: string;
  mappingRevision: number;
}): { kind: 'unavailable' } | { kind: 'relative_path'; relativePath: string } | { kind: 'obsidian_uri'; uri: string };

type PermissionStatus = 'allowed' | 'denied' | 'missing' | 'unsafe' | 'unknown';
type RecentVaultActivity = {
  collection: { revisionId: string; observedAt: string } | null;
  projection: { revision: number; observedAt: string } | null;
};

export function createVaultActivityReader(db: SqliteDatabase): (vault: VaultRecord) => RecentVaultActivity;

export function createObsidianDoctor(options: VaultDeploymentPorts & {
  inspectObsidian: (deviceId: string) => Promise<ObsidianProbe>;
  syncMode?: 'single_device';
  readRecent?: (vault: VaultRecord) => RecentVaultActivity | Promise<RecentVaultActivity>;
}): {
  inspect(deviceId: string, vaultId: string): Promise<{
    editor: ObsidianProbe;
    permissions: Record<'reader' | 'draftWriter' | 'projector', PermissionStatus>;
    scope: Record<'reader' | 'draftWriter' | 'projector' | 'kitInstaller', string[]>;
    connection: VaultConnection | null;
    recent: RecentVaultActivity | null;
    disk: { availableBytes: string } | null;
    editorAccess: PermissionStatus;
    sync: 'single_device' | 'unknown';
  }>;
};
