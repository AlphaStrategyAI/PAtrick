export type Stage='prepare'|'cli'|'read'|'tests'|'cleanup'|'acp';
export type StageProfile='task-only'|'authenticated-client';
export type Operation='exec'|'stop'|'reconcile';
export type InvocationState='active'|'stopping'|'drained'|'cleaning'|'closed'|'quarantined';
export type LifetimeContext=Readonly<{invocation:string;stage:Stage;profile:StageProfile;operation:Operation}>;
export type ReconcileResult=Readonly<{version:1;state:InvocationState;cgroupsEmpty:boolean;workerProcessesAbsent:boolean;workspacesAbsent:boolean;privateMountsAbsent:boolean;invocationClosed:boolean;reason:'ok'|'active'|'unknown'|'workspace_residual'|'control_unavailable'}>;
export const guestScripts:Readonly<Record<'prepare'|'read'|'tests'|'cleanup',string>>;
export const cliWrapper:string;
export const gateWrapper:string;
export const releaseLine:string;
export function profileFor(stage:Stage):StageProfile;

export const execGateProgram:string;
export const payloadReleaseLine:string;
