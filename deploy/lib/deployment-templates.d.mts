import type { DarwinTarget, DirectoryNativeIdentity } from './emitted-release.mjs';
export type EmittedReleaseProfile = 'runtime-only' | 'deployment-complete' | 'deployment-complete-native-v3';
export type DeploymentJob = 'service' | 'hub' | 'worker';
export type DeploymentKey = 'caddy' | DeploymentJob | 'lima';
export type DeploymentRole = 'caddy-template' | 'service-launchd-template' | 'hub-launchd-template' | 'worker-launchd-template' | 'lima-executor-template' | 'service-bootstrap';
export const nativeProfile: 'deployment-complete-native-v3';
export const directoryPath: 'native/patrick-directory.node';
export const directoryRole: 'directory-diagnostic-addon';
export const directoryHeadersSha256: string;
export const nativeSources: readonly string[];
export const directoryLinkerLibraries: readonly string[];
export const directoryExports: readonly string[];
export const directoryHandshake: Readonly<{ format: 'patrick-directory-module'; interfaceVersion: 1; napiVersion: 8 }>;
export function completeProfile(profile: EmittedReleaseProfile): boolean;
export function inventoryVersion(profile: EmittedReleaseProfile): 1 | 2 | 3;
export function directoryCommands(arch: DarwinTarget['arch']): readonly Readonly<{ tool: 'compiler' | 'linker' | 'nm'; argv: readonly string[] }>[];
export type DirectoryBuildHost = Readonly<{ os: string; processArch: string; machine: string }>;
export function checkDirectoryTarget(target: DarwinTarget): void;
export function checkDirectoryAuthority(authority: unknown, target: DarwinTarget, buildHost: DirectoryBuildHost): void;
type DirectorySection = Readonly<{
  segment: Readonly<{ name: string; address: bigint; size: bigint; fileOffset: bigint; fileBytes: bigint; protection: number }>;
  segmentName: string; name: string; address: bigint; size: bigint; fileOffset: bigint; flags: number;
}>;
export function checkDirectoryDefinition(sections: readonly DirectorySection[], ordinal: number, value: bigint,
  headerEnd: bigint, fileSize: bigint): void;
export function directoryIdentity(data: Buffer, arch: DarwinTarget['arch']): DirectoryNativeIdentity;
export const deploymentPaths: Readonly<Record<DeploymentKey, string>>;
export const servicePreflight: Readonly<{ source: string; path: string; sha256: string }>;
export function releaseProfile(value?: EmittedReleaseProfile): EmittedReleaseProfile;
export function deploymentRole(path: string): DeploymentRole | undefined;
export function checkDeploymentRecord(profile: EmittedReleaseProfile, path: string, mode: string, digest: string): void;
export type DeploymentRegistration = Readonly<{
  instanceRoot: string; controllerPath: string; controllerSha256: string; accounts: Readonly<Record<'caddy' | DeploymentJob, string>>;
  origin: string; listener: Readonly<{ host: '127.0.0.1' | '::1'; port: number }>; certificatePath: string; keyPath: string;
}>;
export function renderDeploymentTemplates(sources: Readonly<Record<'caddy' | DeploymentJob, Uint8Array>>, registration: DeploymentRegistration): Readonly<{
  caddy: string; plists: Readonly<Record<DeploymentJob, string>>;
  caddyProcess: Readonly<{ account: string; configPath: string; workingDirectory: string; environment: Readonly<Record<'HOME' | 'XDG_CONFIG_HOME' | 'XDG_DATA_HOME', string>> }>;
}>;
