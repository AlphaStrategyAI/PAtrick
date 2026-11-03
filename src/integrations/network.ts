import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { z } from 'zod';
import { now } from '../domain.js';

export type ProbeKind='healthy'|'network'|'auth'|'rate_limit'|'mfa';
export interface NetworkTarget {id:string;url:string;domain:string;corporate?:boolean;requiredDns?:string[];requiredRoute?:string;heartbeat?:boolean;adapter?:{kind:'shortcuts';status:string;connect:string;disconnect:string}}
export interface Probe {kind:ProbeKind;detail:string}
export interface NetworkResult {id:string;domain:string;state:'healthy'|'blocked';reason:string;checkedAt:string;retryAt?:string}
export interface NetworkActions {diagnose:(target:NetworkTarget)=>Promise<boolean>;probe:(target:NetworkTarget)=>Promise<Probe>;reconnect:(target:NetworkTarget)=>Promise<void>;rollback:(target:NetworkTarget)=>Promise<void>}
export function classifyStatus(status:number):ProbeKind{return status===401||status===403?'auth':status===429?'rate_limit':status>=200&&status<400?'healthy':'network';}

/** Targets and repair commands are operator-approved. A route repair never rotates authentication or asks a business question. */
export class NetworkGuardian {
  private busy=false;private stopping=false;private idleWaiters:(()=>void)[]=[];private results:NetworkResult[]=[];private failures=new Map<string,{count:number;next:number}>();
  constructor(private targets:NetworkTarget[],private actions:NetworkActions,private notify?:(result:NetworkResult)=>void) {}
  canRun(domain:string):boolean {if(this.busy||this.stopping)return false;const approved=this.targets.filter(t=>t.domain===domain);return approved.length>0&&approved.every(t=>this.results.some(r=>r.id===t.id&&r.state==='healthy'));}
  current():NetworkResult[]{return structuredClone(this.results);}
  async shutdown():Promise<void>{this.stopping=true;if(this.busy)await new Promise<void>(resolve=>this.idleWaiters.push(resolve));}
  async check():Promise<NetworkResult[]> {
    if(this.busy||this.stopping)return this.current();this.busy=true;
    try {
      const probes=new Map<string,Probe>();
      for(const target of this.targets){try{probes.set(target.id,await this.actions.diagnose(target)?await this.actions.probe(target):{kind:'network',detail:'Local DNS or routing prerequisites are not verified.'});}catch{probes.set(target.id,{kind:'network',detail:'Approved path unavailable.'});}}
      const healthy=this.targets.filter(t=>probes.get(t.id)?.kind==='healthy'),next:NetworkResult[]=[];
      for(const target of this.targets){
        let probe=probes.get(target.id)!,state:NetworkResult['state']=probe.kind==='healthy'?'healthy':'blocked',reason=probe.detail;
        const previous=this.failures.get(target.id)??{count:0,next:0};
        if(probe.kind==='network'&&target.adapter&&Date.now()>=previous.next&&previous.count<3){
          try {
            await this.actions.reconnect(target);
            const fixed=await this.actions.diagnose(target)?await this.actions.probe(target):{kind:'network' as const,detail:'Local path remains unverified.'};
            const stillHealthy=await Promise.all(healthy.filter(t=>t.id!==target.id).map(async t=>await this.actions.diagnose(t)&&(await this.actions.probe(t)).kind==='healthy'));
            if(fixed.kind!=='healthy'||stillHealthy.some(value=>!value)){await this.actions.rollback(target);for(const prior of healthy){try{probes.set(prior.id,await this.actions.diagnose(prior)?await this.actions.probe(prior):{kind:'network',detail:'Rollback path is not verified.'});}catch{probes.set(prior.id,{kind:'network',detail:'Rollback path unavailable.'});}}reason='Repair did not preserve the failed path, originally healthy paths and heartbeat; prior state restored.';}
            else{state='healthy';reason='Approved path recovered and healthy paths rechecked.';}
          }catch{try{await this.actions.rollback(target);}catch{}reason='Approved route repair failed; no task was resumed.';}
          if(state==='healthy')this.failures.delete(target.id);else this.failures.set(target.id,{count:previous.count+1,next:Date.now()+Math.min(3600000,60000*2**previous.count)});
        }else if(probe.kind==='healthy')this.failures.delete(target.id);
        const retry=this.failures.get(target.id),result:NetworkResult={id:target.id,domain:target.domain,state,reason,checkedAt:now(),...(retry?{retryAt:new Date(retry.next).toISOString()}:{})};
        next.push(result);if(this.results.find(r=>r.id===target.id)?.state!==state)this.notify?.(result);
      }
      // Repairs of later targets may have damaged an earlier target; derive admission from a final fresh pass.
      for(const result of next){const target=this.targets.find(t=>t.id===result.id)!;let final:Probe;try{final=await this.actions.diagnose(target)?await this.actions.probe(target):{kind:'network',detail:'Local path is not verified.'};}catch{final={kind:'network',detail:'Path unavailable after recovery.'};}if(final.kind!=='healthy'){result.state='blocked';result.reason=final.detail;}}
      this.results=next;return this.current();
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
      if(url.protocol!=='https:'&&!(target.heartbeat&&url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))return false;
      if(process.platform==='darwin'){
        await exec('/sbin/ifconfig',['-a'],{timeout:5000,maxBuffer:200000});
        const dns=(await exec('/usr/sbin/scutil',['--dns'],{timeout:5000,maxBuffer:200000})).stdout;
        if(target.corporate&&(!target.requiredDns?.length||!target.requiredDns.every(server=>dns.includes(server))))return false;
        const route=(await exec('/sbin/route',['-n','get',url.hostname],{timeout:5000,maxBuffer:200000})).stdout;
        if(target.corporate&&(!target.requiredRoute||!route.includes(target.requiredRoute)))return false;
      }else if(target.corporate)return false;
      await lookup(url.hostname);return true;
    },
    probe:async target=>{try{const response=await fetch(target.url,{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(10000)});const mfa=response.headers.get('www-authenticate')?.toLowerCase().includes('mfa');return {kind:mfa?'mfa':classifyStatus(response.status),detail:mfa?'MFA requires owner authentication.':`HTTP ${response.status}`};}catch{return {kind:'network',detail:'Network, proxy or TLS path unavailable.'};}},
    reconnect:async target=>{if(!target.adapter)throw Error('No approved path adapter.');const status=(await shortcut(target.adapter.status)).toLowerCase();if(!['connected','disconnected'].includes(status))throw Error('Shortcut status is not verified.');previousStatus.set(target.id,status);if(status==='connected')await shortcut(target.adapter.disconnect);await shortcut(target.adapter.connect);},
    rollback:async target=>{if(target.adapter)await shortcut(previousStatus.get(target.id)==='connected'?target.adapter.connect:target.adapter.disconnect);},
  };
}
const targetSchema=z.object({id:z.string().min(1),url:z.string().url(),domain:z.string().min(1),corporate:z.boolean().optional(),requiredDns:z.array(z.string()).optional(),requiredRoute:z.string().optional(),heartbeat:z.boolean().optional(),adapter:z.object({kind:z.literal('shortcuts'),status:z.string().min(1),connect:z.string().min(1),disconnect:z.string().min(1)}).optional()});
export function readNetworkTargets(file:string):NetworkTarget[]{return z.array(targetSchema).parse(JSON.parse(readFileSync(file,'utf8')));}
