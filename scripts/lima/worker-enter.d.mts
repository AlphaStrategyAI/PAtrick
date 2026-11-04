import type { Admission, LifetimeContext, RegistryAuthority, RecoveryBinding } from './stage-lifetime.mjs';
import type { Account, Entry, GuestContext, GuestPolicy } from './policy.mjs';
export type Invocation={command:string;args:string[]};
export type TrustedStat={uid:number;gid:number;mode:number;isFile():boolean;isDirectory():boolean;isSymbolicLink():boolean};
export type Dependencies={effectiveUid():number|undefined;trust(entry?:Entry):void;readPolicy():unknown;accounts():Record<string,Account>;readiness(policy:GuestPolicy,accounts:Record<string,Account>):{nft:unknown;proxy:unknown};dispatch(request:{context:GuestContext;lifetime:LifetimeContext;command:string[]}):unknown};
export function loadTrustedPolicy<T>(deps:{effectiveUid():number|undefined;trust():void;load():Promise<T>}):Promise<T>;
export function parseArguments(argv:string[]):{context:GuestContext;lifetime:LifetimeContext;command:string[]};
export function buildInvocation(entry:Entry):Invocation;
export function assertTrustedPath(path:string,options:{kind:'file'|'directory';uid:number;gid?:number;private?:boolean},io?:{lstatSync(path:string):TrustedStat}):void;
export function trustExecutable(path:string,io?:{lstatSync(path:string):TrustedStat;readlinkSync(path:string,options:{encoding:'buffer'}):Buffer}):void;
export function readTrustedFile(path:string,max?:number,io?:{lstatSync(path:string):TrustedStat;openSync(path:string,flags:number):number;fstatSync(fd:number):TrustedStat&{size?:number};readFileSync(fd:number,encoding:string):string;closeSync(fd:number):void}):string;
export function parseAccounts(passwd:string,groups:string):Record<string,Account>;
export function parseServiceProperties(text:string):Record<string,string>;
export function parseProxyFacts(properties:Record<string,string>,status:string,tcp:string,tcp6:string,socketInodes:string[]):{user:string;uid:number;gid:number;groups:number[];mainPid:number;activeState:string;subState:string;listeners:{address:string;port:number;uid:number;pid:number}[]};
export function assertReadiness(nft:unknown,proxy:unknown,policy:GuestPolicy,accounts:Record<string,Account>):void;
export function enterWorker(argv:string[],deps:Dependencies):unknown;

export function productionDependencies():Dependencies;

export type InstalledManifest=Readonly<{version:1;controlAdmin:string;reviewedSources:Readonly<{identity:string;proxy:string}>;policyHash:string;files:Readonly<Record<string,string>>;installation:Readonly<{artifactHash:string;policyHash:string;accounts:Record<string,Account>;nftHash:string;registry:import('./stage-lifetime.mjs').RegistryReference}>}>;
export type TrustedModules=typeof import('./policy.mjs') & typeof import('./worker-enter.mjs') & typeof import('./stage-lifetime.mjs');
export type RecordAuthorityState=Readonly<{modules:TrustedModules;manifest:InstalledManifest;policy:GuestPolicy;accounts:Record<string,Account>;registry:RegistryAuthority}>;
export function recoveryBinding(context:GuestContext,state:RecordAuthorityState):RecoveryBinding;
export function installedAdmission(context:GuestContext,command:string[],state:{fence:{status:string};policy:GuestPolicy;accounts:Record<string,Account>;manifest:{installation:{artifactHash:string;policyHash:string}};nft:()=>unknown;proxy:()=>unknown}):Admission;
