import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
const source=new URL('../../scripts/lima/synthetic-network.mjs',import.meta.url);
describe('fixed isolated no-model network recipe (host protocol only)',()=>{
 it('copies only the owned table and binds distinct installed numeric proxy/client identities',async()=>{
  const module=await import(source.href);
  const policy=JSON.parse(readFileSync(new URL('../../scripts/lima/worker-policy.json',import.meta.url),'utf8'));
  const accounts=Object.fromEntries([...policy.workers.map((w:any,i:number)=>[w.user,{uid:1101+i,gid:1101+i,home:'/var/lib/'+w.user,groups:[]}]),['patrick-proxy',{uid:1100,gid:1100,home:'/var/lib/patrick-proxy',groups:[]}]]);
  const {renderNft}=await import('../../scripts/lima/policy.mjs');const nftText=renderNft(policy,Object.fromEntries(Object.entries(accounts).map(([n,v]:any)=>[n,v.uid])));
  const recipe=module.syntheticNetworkRecipe({policy,accounts,nftText});
  expect(()=>new Function(recipe.program)).not.toThrow();for(const program of [recipe.input.proxyProgram,recipe.input.upstreamProgram,recipe.input.clientProgram])expect(()=>new Function('return ('+program+')')).not.toThrow();expect(recipe.command).toBe('/usr/bin/unshare');expect(recipe.args.slice(0,6)).toEqual(['--mount','--net','--pid','--fork','--kill-child=KILL','--mount-proc']);
  expect(recipe.program).toContain('createProxy');expect(recipe.program).toContain('buildDropInvocation');expect(recipe.program).not.toMatch(/flush ruleset|https:\/\/|fetch\(/);expect(recipe.input.nftText).toBe(nftText);expect(recipe.input.accounts['patrick-proxy'].uid).toBe(1100);
  expect(recipe.input.policy.workers[0].hosts).toEqual(['synthetic.patrick.invalid']);expect(recipe.input.policy.workers.slice(1).every((w:any)=>w.hosts.length===0)).toBe(true);
  expect(()=>module.syntheticNetworkRecipe({policy,accounts:{...accounts,'patrick-proxy':accounts['patrick-grok']},nftText})).toThrow();
 });
 it('cannot run an actual privileged child through a host-fixture dependency object',async()=>{
  const module=await import(source.href);await expect(module.runSyntheticNetwork({}, {io:{},effectiveUid:()=>0})).rejects.toThrow('dependency');
 });
});


describe('completed upstream acceptance evidence (hermetic event harness, no sockets)',()=>{
 async function harness(){
  const module=await import(source.href),policy=JSON.parse(readFileSync(new URL('../../scripts/lima/worker-policy.json',import.meta.url),'utf8'));
  const accounts=Object.fromEntries([...policy.workers.map((w:any,i:number)=>[w.user,{uid:1101+i,gid:1101+i,home:'/var/lib/'+w.user,groups:[]}]),['patrick-proxy',{uid:1100,gid:1100,home:'/var/lib/patrick-proxy',groups:[]}]]);
  const {renderNft}=await import('../../scripts/lima/policy.mjs'),recipe=module.syntheticNetworkRecipe({policy,accounts,nftText:renderNft(policy,Object.fromEntries(Object.entries(accounts).map(([n,v]:any)=>[n,v.uid])))});
  const servers:any[]=[],control=new EventEmitter();let output='',offset=0,finish!:()=>void;const terminal=new Promise<void>(resolve=>{finish=resolve;});const gate=Buffer.from('network-release\n');
  const net={createServer:(accept:(socket:any)=>void)=>{const server=Object.assign(new EventEmitter(),{accept,listen:(_options:any,ready:()=>void)=>{ready();},close:(done?:()=>void)=>{queueMicrotask(()=>done?.());}});servers.push(server);return server;}};
  const io={readSync:(_fd:number,byte:Buffer)=>{if(offset===gate.length)return 0;byte[0]=gate[offset++]!;return 1;}};
  const process={stdout:{write:(s:string,done?:(error?:Error)=>void)=>{output+=s;queueMicrotask(()=>{done?.();if(s.startsWith('{\"final\":'))finish();});return true;}},on:control.on.bind(control),once:control.once.bind(control),exit:(code:number)=>{throw Error('exit '+code);}};
  await new Function('imports','process','Buffer','configuration','return ('+recipe.input.upstreamProgram.replaceAll('await import(', 'await imports(').replaceAll('__vite_ssr_dynamic_import__','imports')+')(configuration)')(async(name:string)=>name==='node:fs'?io:net,process,Buffer,{address:recipe.input.address});
  const accept=(data=false)=>{const socket=Object.assign(new EventEmitter(),{destroyed:false,end:()=>{},destroy(this:EventEmitter&{destroyed:boolean}){this.destroyed=true;queueMicrotask(()=>this.emit('close'));}});servers[0].accept(socket);if(data)socket.emit('data',Buffer.from('hello'));return socket;};
  const stop=async()=>{control.emit('SIGTERM');await terminal;return output;};
  return {accept,stop,output:()=>output};
 }
 it('counts an extra zero-byte connection at accept and rejects it after complete drain',async()=>{
  const module=await import(source.href),h=await harness();h.accept(true);h.accept(false);
  expect(h.output().trim().split('\n').map((line:string)=>JSON.parse(line))).toEqual([{ready:true},{upstream:1},{upstream:2}]);
  const output=await h.stop();expect(output.endsWith('{"final":2}\n')).toBe(true);expect(()=>module.validateNetworkStreams(output,'')).toThrow();
 });
 it('requires exactly one total acceptance, a final monotonic count and complete finite streams',async()=>{
  const module=await import(source.href),proxy='{"ready":true}\n{"counts":{"HEADER":1}}\n{"counts":{"HEADER":2}}\n{"counts":{"HEADER":3}}\n{"counts":{"HEADER":3,"TLS":1}}\n{"counts":{"HEADER":3,"TLS":2}}\n{"counts":{"HEADER":4,"TLS":2}}\n{"counts":{"HEADER":5,"TLS":2}}\n{"final":{"HEADER":5,"TLS":2}}\n';
  const h=await harness();h.accept(true);const valid=await h.stop();expect(module.validateNetworkStreams(valid,proxy)).toBe(true);
  for(const invalid of ['{"ready":true}\n{"upstream":1}\n{"upstream":2}\n{"final":2}\n',valid.slice(0,-1),valid+'{"final":1}\n',valid.replace('{"final":1}', '{"final":0}'),valid.replace('{"upstream":1}', '{"upstream":2}'),'{"ready":true}\n{"upstream":1}\n'])expect(()=>module.validateNetworkStreams(invalid,proxy)).toThrow();
  for(const invalid of [proxy.slice(0,-1),proxy+'{}\n',proxy.replace('{"HEADER":2}', '{"HEADER":1}'),proxy.replace('{"final":{"HEADER":5,"TLS":2}}','{"final":{"HEADER":4,"TLS":2}}')])expect(()=>module.validateNetworkStreams(valid,invalid)).toThrow();
 });
});
