import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { z } from 'zod';
import { now } from '../domain.js';

export type ProbeKind='healthy'|'network'|'auth'|'rate_limit'|'mfa';
export type PathStage='nic'|'dns'|'route'|'proxy'|'tls'|'peer';
export const heartbeatIntervalMs=60_000;
export interface NetworkTarget {id:string;url:string;domain:string;corporate?:boolean;requiredDns?:string[];requiredRoute?:string;heartbeat?:boolean;adapter?:{kind:'shortcuts';status:string;connect:string;disconnect:string}}
export interface Probe {kind:ProbeKind;detail:string;stage?:PathStage}
export interface NetworkResult {id:string;domain:string;state:'healthy'|'blocked';reason:string;checkedAt:string;retryAt?:string}
export interface PathAssessment {ok:boolean;stage:PathStage;kind:ProbeKind;detail:string}
export interface PathObservation {nic:boolean;dnsServers:string[];dnsAnswers:string[];route:string;proxy:'none'|'ok'|'failed';tls:'ok'|'failed';peer:ProbeKind}
export interface DualVpnEvidence {splitTunnel?:boolean;startOrders?:string[];concurrent?:boolean;singlePathRepair?:boolean}
export interface NetworkActions {diagnose:(target:NetworkTarget)=>Promise<boolean|PathAssessment>;probe:(target:NetworkTarget)=>Promise<Probe>;reconnect:(target:NetworkTarget)=>Promise<void>;rollback:(target:NetworkTarget)=>Promise<void>}
export interface NetworkOptions {dualVpn?:DualVpnEvidence;reconcile?:()=>void}
export function classifyStatus(status:number):ProbeKind{return status===401||status===403?'auth':status===429?'rate_limit':status>=200&&status<400?'healthy':'network';}
/** Authorization, throttling and MFA stay distinct. None of them is treated as a route to reconnect. */
export function ownerProbeReason(probe:Probe):string {
  if(probe.kind==='mfa')return '这条路径要求你本人完成登录。不会自动重连，也不需要在任务里回答。';
  if(probe.kind==='auth')return '这条路径的认证没有通过。不会把它当成断线去重连。';
  if(probe.kind==='rate_limit')return '这条路径暂时被限流。不会把它当成断线去重连。';
  return probe.detail;
}
function failedPath(stage:PathStage,kind:ProbeKind,detail:string):PathAssessment {return {ok:false,stage,kind,detail};}
/** Local facts are judged in order: NIC, enterprise or public DNS, route, proxy, TLS, then the peer. */
export function inspectPath(target:NetworkTarget,observation:PathObservation):PathAssessment {
  if(!observation.nic)return failedPath('nic','network','网卡未就绪。');
  if(target.corporate){
    if(!target.requiredDns?.length||!target.requiredDns.every(server=>observation.dnsServers.includes(server)))return failedPath('dns','network','企业 DNS 未就绪。');
    if(observation.dnsAnswers.length===0)return failedPath('dns','network','企业名称未解析。');
    if(!target.requiredRoute||!observation.route.includes(target.requiredRoute))return failedPath('route','network','企业路由未就绪。');
  }else if(observation.dnsAnswers.length===0)return failedPath('dns','network','DNS 未解析。');
  else if(!observation.route)return failedPath('route','network','路由未就绪。');
  if(observation.proxy==='failed')return failedPath('proxy','network','代理未就绪。');
  if(observation.tls!=='ok')return failedPath('tls','network','TLS 未就绪。');
  if(observation.peer!=='healthy')return failedPath('peer',observation.peer,ownerProbeReason({kind:observation.peer,detail:'peer'}));
  return {ok:true,stage:'peer',kind:'healthy',detail:'路径健康。'};
}
/** Both startup orders, split tunnel, concurrency and single-path repair are required. Missing evidence stays closed. */
export function admitDualVpn(evidence?:DualVpnEvidence):{admitted:boolean;reason:string} {
  const orders=new Set(evidence?.startOrders??[]);
  if(evidence?.splitTunnel===true&&orders.has('personal-first')&&orders.has('enterprise-first')&&evidence.concurrent===true&&evidence.singlePathRepair===true)return {admitted:true,reason:'企业分流、两种启动顺序、并发和单路修复都已通过。'};
  return {admitted:false,reason:'企业分流、两种启动顺序、并发或单路修复未全部通过，双 VPN 不准入。'};
}
function prerequisiteProbe(value:boolean|PathAssessment):Probe|undefined {
  if(value===true)return undefined;
  if(value===false)return {kind:'network',detail:'Local DNS or routing prerequisites are not verified.',stage:'route'};
  if(value.ok)return undefined;
  return {kind:value.kind,detail:value.detail,stage:value.stage};
}

/** Targets and repair commands are operator-approved. A route repair never rotates authentication or asks a business question. */
export class NetworkGuardian {
  private busy=false;private stopping=false;private idleWaiters:(()=>void)[]=[];private results:NetworkResult[]=[];private failures=new Map<string,{count:number;next:number}>();
  constructor(private targets:NetworkTarget[],private actions:NetworkActions,private notify?:(result:NetworkResult)=>void,private options:NetworkOptions={}) {}
  canRun(domain:string):boolean {if(this.busy||this.stopping)return false;const approved=this.targets.filter(t=>t.domain===domain);if(approved.length===0||!approved.every(t=>this.results.some(r=>r.id===t.id&&r.state==='healthy')))return false;return approved.filter(t=>t.adapter).length<2||admitDualVpn(this.options.dualVpn).admitted;}
  current():NetworkResult[]{return structuredClone(this.results);}
  async shutdown():Promise<void>{this.stopping=true;if(this.busy)await new Promise<void>(resolve=>this.idleWaiters.push(resolve));}
  async check():Promise<NetworkResult[]> {
    if(this.busy||this.stopping)return this.current();this.busy=true;
    try {
      const probes=new Map<string,Probe>();
      for(const target of this.targets){try{const blocked=prerequisiteProbe(await this.actions.diagnose(target));probes.set(target.id,blocked??await this.actions.probe(target));}catch{probes.set(target.id,{kind:'network',detail:'Approved path unavailable.',stage:'peer'});}}
      const healthy=this.targets.filter(t=>probes.get(t.id)?.kind==='healthy'),next:NetworkResult[]=[];
      for(const target of this.targets){
        let probe=probes.get(target.id)!,state:NetworkResult['state']=probe.kind==='healthy'?'healthy':'blocked',reason=ownerProbeReason(probe);
        const previous=this.failures.get(target.id)??{count:0,next:0};
        if(probe.kind==='network'&&target.adapter&&Date.now()>=previous.next&&previous.count<3){
          try {
            await this.actions.reconnect(target);
            const fixedBlocked=prerequisiteProbe(await this.actions.diagnose(target));const fixed=fixedBlocked??await this.actions.probe(target);
            const stillHealthy=await Promise.all(healthy.filter(t=>t.id!==target.id).map(async t=>{const blocked=prerequisiteProbe(await this.actions.diagnose(t));return (blocked??await this.actions.probe(t)).kind==='healthy';}));
            if(fixed.kind!=='healthy'||stillHealthy.some(value=>!value)){await this.actions.rollback(target);for(const prior of healthy){try{const blocked=prerequisiteProbe(await this.actions.diagnose(prior));probes.set(prior.id,blocked??await this.actions.probe(prior));}catch{probes.set(prior.id,{kind:'network',detail:'Rollback path unavailable.',stage:'peer'});}}reason='Repair did not preserve the failed path, originally healthy paths and heartbeat; prior state restored.';}
            else{state='healthy';reason='Approved path recovered and healthy paths rechecked.';}
          }catch{try{await this.actions.rollback(target);}catch{}reason='Approved route repair failed; no task was resumed.';}
          if(state==='healthy')this.failures.delete(target.id);else this.failures.set(target.id,{count:previous.count+1,next:Date.now()+Math.min(3600000,60000*2**previous.count)});
        }else if(probe.kind==='healthy')this.failures.delete(target.id);
        const retry=this.failures.get(target.id),result:NetworkResult={id:target.id,domain:target.domain,state,reason,checkedAt:now(),...(retry?{retryAt:new Date(retry.next).toISOString()}:{})};
        next.push(result);if(this.results.find(r=>r.id===target.id)?.state!==state)this.notify?.(result);
      }
      // Repairs of later targets may have damaged an earlier target; derive admission from a final fresh pass.
      for(const result of next){const target=this.targets.find(t=>t.id===result.id)!;let final:Probe;try{const blocked=prerequisiteProbe(await this.actions.diagnose(target));final=blocked??await this.actions.probe(target);}catch{final={kind:'network',detail:'Path unavailable after recovery.',stage:'peer'};}if(final.kind!=='healthy'){result.state='blocked';result.reason=ownerProbeReason(final);}}
      const recovered=next.some(result=>result.state==='healthy'&&this.results.find(prior=>prior.id===result.id)?.state!=='healthy');
      this.results=next;if(recovered)this.options.reconcile?.();return this.current();
    }finally{this.busy=false;this.idleWaiters.splice(0).forEach(resolve=>resolve());}
  }
}

const exec=promisify(execFile);
export function systemNetworkActions():NetworkActions {
  const previousStatus=new Map<string,string>();
  const shortcut=async(name:string)=>{if(!name.trim())throw Error('Unconfigured shortcut');return (await exec('shortcuts',['run',name],{timeout:30000,maxBuffer:100000})).stdout.trim();};
  return {
    diagnose:async target=>{
      const url=new URL(target.url);
      if(url.protocol!=='https:'&&!(target.heartbeat&&url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))return {ok:false,stage:'tls',kind:'network',detail:'未获准的地址不会探测。'};
      let nic=process.platform!=='darwin',dnsServers:string[]=[],route=process.platform==='darwin'?'':'host-route-not-collected';
      if(process.platform==='darwin'){
        try{await exec('/sbin/ifconfig',['-a'],{timeout:5000,maxBuffer:200000});nic=true;}catch{nic=false;}
        try{dnsServers=(await exec('/usr/sbin/scutil',['--dns'],{timeout:5000,maxBuffer:200000})).stdout.split(/\s+/);}catch{dnsServers=[];}
        try{route=(await exec('/sbin/route',['-n','get',url.hostname],{timeout:5000,maxBuffer:200000})).stdout;}catch{route='';}
      }else if(target.corporate)return {ok:false,stage:'route',kind:'network',detail:'企业路径只在已核验的 macOS 主机上检查。'};
      let dnsAnswers:string[]=[];try{dnsAnswers=[(await lookup(url.hostname)).address];}catch{dnsAnswers=[];}
      const local=inspectPath(target,{nic,dnsServers,dnsAnswers,route,proxy:'none',tls:'ok',peer:'healthy'});
      return local.ok?true:local;
    },
    probe:async target=>{try{const response=await fetch(target.url,{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(10000)});const mfa=response.headers.get('www-authenticate')?.toLowerCase().includes('mfa');return {kind:mfa?'mfa':classifyStatus(response.status),detail:mfa?'MFA requires owner authentication.':`HTTP ${response.status}`,stage:'peer'};}catch{return {kind:'network',detail:'Network, proxy or TLS path unavailable.',stage:'tls'};}},
    reconnect:async target=>{if(!target.adapter)throw Error('No approved path adapter.');const status=(await shortcut(target.adapter.status)).toLowerCase();if(!['connected','disconnected'].includes(status))throw Error('Shortcut status is not verified.');previousStatus.set(target.id,status);if(status==='connected')await shortcut(target.adapter.disconnect);await shortcut(target.adapter.connect);},
    rollback:async target=>{if(target.adapter)await shortcut(previousStatus.get(target.id)==='connected'?target.adapter.connect:target.adapter.disconnect);},
  };
}
const targetSchema=z.object({id:z.string().min(1),url:z.string().url(),domain:z.string().min(1),corporate:z.boolean().optional(),requiredDns:z.array(z.string()).optional(),requiredRoute:z.string().optional(),heartbeat:z.boolean().optional(),adapter:z.object({kind:z.literal('shortcuts'),status:z.string().min(1),connect:z.string().min(1),disconnect:z.string().min(1)}).optional()});
export function readNetworkTargets(file:string):NetworkTarget[]{return z.array(targetSchema).parse(JSON.parse(readFileSync(file,'utf8')));}
