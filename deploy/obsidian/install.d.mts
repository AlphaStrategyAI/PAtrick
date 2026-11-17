import type { VaultConnection, VaultRecord } from '../../packages/integrations/vault/connection.js';

export type VaultDeploymentPorts = {
  captureHost: string;
  serviceUid: number;
  editorUid: number;
  loadVault: (vaultId: string) => VaultRecord | Promise<VaultRecord>;
  inspectVault: (deviceId: string, vaultId: string) => VaultConnection | Promise<VaultConnection>;
};

export type VaultKitReceipt = {
  vaultId: string;
  sourceId: string;
  configRevision: number;
  scopeHash: string;
  version: string;
  manifestSha256: string;
  manifestPath: string;
  files: { path: string; state: 'created' | 'preserved'; sha256: string }[];
};

export function createVaultKitInstaller(options: VaultDeploymentPorts & {
  deviceId: string;
  assetRoot?: string;
  stageParent?: string;
}): { installVaultKit(vaultId: string): Promise<VaultKitReceipt> };

export function verifyObsidianInstaller(dmgPath: string, lock: {
  version: string;
  sha256: string | null;
}): Promise<{ version: string; sha256: string; status: 'hash_verified' }>;

export function createMacObsidianInstaller(options?: {
  // Command overrides and an alternative Applications root are for isolated admission fixtures.
  runCommand?: (command: string, argv: readonly string[]) => Promise<{ stdout: string }>;
  applicationsDirectory?: string;
  scratchDirectory?: string;
  platform?: NodeJS.Platform;
}): {
  install(input: { dmgPath: string; lock: { version: string; sha256: string | null }; authorizedDestination: string }):
    Promise<{ status: 'installed'; path: string; version: string; installerSha256: string }>;
};
