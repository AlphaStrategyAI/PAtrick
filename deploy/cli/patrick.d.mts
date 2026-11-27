import type { VaultInitCliPreview } from '../runtime/vault-init-cli.js';
import type { InstallPreviewResult } from '../runtime/install-preview.js';
import type * as FirstInstall from '../runtime/install-preview.js';
import type { LifecycleReceipt } from '../runtime/lifecycle-journal.js';
import type { runUninstall } from '../host/uninstall.js';
import type { UpgradePreview } from '../runtime/lifecycle-generation.js';
import type { createMaintenanceCutReader } from '../runtime/maintenance-readback.js';
import type { RegisteredHost, HostIdentity, DoctorCheck } from '../lib/doctor.mjs';
export type CliCommand = 'init' | 'doctor' | 'install' | 'start' | 'stop' | 'backup' | 'restore' | 'upgrade' | 'uninstall';
export type CliRequest = Readonly<{
  command: CliCommand; action: 'preview' | 'execute' | 'readback' | 'check-session' | 'prepare-generation'; operation?: string;
  target?: string; vault?: string; release?: string; manifest?: string; mode?: 'drill';
}>;
export type CliResult = {
  command?: CliCommand; action?: CliRequest['action'];
  status: 'preview' | 'completed' | 'invalid' | 'unavailable' | 'blocked' | 'uncertain' | 'absent' | 'reserved';
  code: string; exitCode: number; nextStep?: string; identity?: HostIdentity;
  manifestHash?: string; mode?: 'backup' | 'drill'; externalWrites?: number; elapsedMs?: number;
  rpoMs?: number | null; rtoMs?: number | null; checks?: Record<string, DoctorCheck>;
  installPreview?: Omit<Extract<InstallPreviewResult, { status: 'preview' }>, 'status'>;
  installSession?: Omit<Extract<InstallPreviewResult, { status: 'session-observed' }>, 'status'>;
  upgradePreview?: UpgradePreview;
  operationId?: string; generationId?: string; vaultId?: string; vaultInitPreview?: VaultInitCliPreview;
  lifecycleReceipt?: LifecycleReceipt; prerequisites?: readonly string[];
  uninstallPreview?: { labels: readonly string[] };
  candidate?: { sha256: string; manifestSha256: string; installable: false; runtime: 'unavailable' };
};
export function parseArguments(argv: readonly string[]): CliRequest;
export function captureReleaseData<T>(input: T, options?: { plainRecords?: boolean }): { value: T; validate(): void };
/** The installed live-storage check applies to all requests except exact enrolled readback. */
export function createPatrickCli(
  host?: RegisteredHost, checkLiveStorage?: () => CliResult | undefined,
  firstInstall?: Pick<typeof FirstInstall, 'bindInstallPreviewEnrollment' | 'installBootstrapRequirements' |
    'observeInstallSession' | 'prepareFirstInstallGeneration' | 'previewFirstInstall' | 'runFirstInstallRelease'> &
    { runUninstall?: typeof runUninstall; createMaintenanceCutReader?: typeof createMaintenanceCutReader },
  previewUpgrade?: (packageSha256: string) => Promise<UpgradePreview | undefined>,
): {
  run(argv: readonly string[]): Promise<CliResult>;
};

/** Trusted lifecycle-controller adapter. Installation is create-only and uses T27 scope/readback checks. */
export function createVaultKitAdapter(host: RegisteredHost): {
  install(vaultId: string): Promise<{ vaultId: string; configRevision: number; scopeHash: string; manifestSha256: string }>;
};
