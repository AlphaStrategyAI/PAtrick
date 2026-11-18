export type EmittedReleaseProfile = 'runtime-only' | 'deployment-complete';
export type DeploymentJob = 'service' | 'hub' | 'worker';
export type DeploymentKey = 'caddy' | DeploymentJob | 'lima';
export type DeploymentRole = 'caddy-template' | 'service-launchd-template' | 'hub-launchd-template' | 'worker-launchd-template' | 'lima-executor-template';
export const deploymentPaths: Readonly<Record<DeploymentKey, string>>;
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
