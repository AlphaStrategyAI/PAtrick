import type { RegisteredHost, HostIdentity, DoctorCheck } from '../lib/doctor.mjs';
export type CliCommand = 'init' | 'doctor' | 'install' | 'start' | 'stop' | 'backup' | 'restore' | 'upgrade' | 'uninstall';
export type CliRequest = Readonly<{
  command: CliCommand; action: 'preview' | 'execute' | 'readback'; operation?: string;
  target?: string; vault?: string; release?: string; manifest?: string; mode?: 'drill';
}>;
export type CliResult = {
  command?: CliCommand; action?: CliRequest['action'];
  status: 'preview' | 'completed' | 'invalid' | 'unavailable' | 'blocked' | 'uncertain' | 'absent' | 'reserved';
  code: string; exitCode: number; nextStep?: string; identity?: HostIdentity;
  manifestHash?: string; mode?: 'backup' | 'drill'; externalWrites?: number; checks?: Record<string, DoctorCheck>;
  prerequisites?: readonly string[];
  candidate?: { sha256: string; manifestSha256: string; installable: false; runtime: 'unavailable' };
};
export function parseArguments(argv: readonly string[]): CliRequest;
export function createPatrickCli(host?: RegisteredHost): {
  run(argv: readonly string[]): Promise<CliResult>;
};

/** Trusted lifecycle-controller adapter. Installation is create-only and uses T27 scope/readback checks. */
export function createVaultKitAdapter(host: RegisteredHost): {
  install(vaultId: string): Promise<{ vaultId: string; configRevision: number; scopeHash: string; manifestSha256: string }>;
};
