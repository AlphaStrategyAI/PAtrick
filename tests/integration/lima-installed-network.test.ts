import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkProbeIds } from '../../scripts/lima/installed-network.mjs';
import { qualify, sanitizeQualificationReport } from '../../scripts/lima/qualify.js';
const hash='a'.repeat(64);
const common={actualGuest:false,synthetic:true,environment:'installed',profile:'authenticated-client'};
function result(id:string,role='grok'){return {id,role,...common,status:'pass',reason:'ok',network:{targets:1,attempted:1,denied:1,basis:id.startsWith('network-empty-')?'empty-allowlist':'socket-policy',gate:['network-wrong-sni','network-ech'].includes(id)?'proxy-tls':['network-disallowed-host','network-alternate-port','network-ip-connect','network-empty-codex','network-empty-dsh'].includes(id)?'proxy-header':'nft'}};}
function report(results:unknown[]){return {version:1,observedAt:'2026-11-05T00:00:00.000Z',instanceKind:'local-trial',limaVersion:'1',guestVersion:'24.04',systemdVersion:'255',artifactHash:hash,policyHash:hash,inventoryHash:hash,results,realModelCalls:0,costUsd:0,realProviderAdmission:false,providerAccountFeePrivacyQualified:false,productionMiniQualified:false};}
const pairs=()=>networkProbeIds.flatMap(id=>(id==='network-empty-codex'?['codex']:id==='network-empty-dsh'?['dsh']:['grok','codex','dsh']).map(role=>{
 const row=result(id,role);if(role!=='grok'&&row.network.gate.startsWith('proxy-')){row.network.basis='empty-allowlist';row.network.gate='proxy-header';}if(id.startsWith('network-empty-'))row.network.targets=row.network.attempted=row.network.denied=5;return row;
}));
const unobservedPairs=()=>pairs().map(r=>({...r,status:'not_run',reason:'not_run',network:{targets:0,attempted:0,denied:0,basis:'unobserved',gate:'unobserved'}}));
type HostFailure='unhealthy-adapter'|'unavailable-network'|'invalid-network'|'untrusted-network'|'later-failure';
/** The sole subprocess surface is a finite local fake limactl. The actual
 * qualifier still creates its ordinary Store/billing binding and LimaWorker. */
function hostFixture(failure:HostFailure){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'patrick-unobserved-network-')),bin=join(root,'bin'),eventsPath=join(root,'events'),reportPath=join(root,'report.json');chmodSync(root,0o700);mkdirSync(bin,{mode:0o700});
 const fixtureHash=createHash('sha256').update(readFileSync(new URL('../../scripts/lima/synthetic-worker.mjs',import.meta.url))).digest('hex');
 const bindings=(['grok','codex','dsh'] as const).map((runner,i)=>({runner,user:'patrick-'+runner,projectId:'synthetic',domain:'synthetic',uid:1101+i,gid:1101+i,home:'/var/lib/patrick-'+runner,proxyPort:18743+i}));
 const control={version:1,outcome:'pass',reason:'ok',synthetic:true,artifactHash:hash,policyHash:hash,inventoryHash:hash,fixtureHash,guestVersion:'24.04',systemdVersion:'255',bindings,observations:[]};
 const network={version:1,operation:'qualification-network',outcome:'pass',reason:'ok',synthetic:true,environment:'installed',actualGuest:failure!=='untrusted-network',artifactHash:hash,policyHash:hash,inventoryHash:hash,preconditionRequests:{header:1,tls:1},results:pairs().map(r=>({...r,actualGuest:failure!=='untrusted-network'}))};
 writeFileSync(join(bin,'limactl'),`#!${process.execPath}
const fs=require('node:fs'),argv=process.argv.slice(2),failure=${JSON.stringify(failure)},events=${JSON.stringify(eventsPath)};
const emit=value=>process.stdout.write(JSON.stringify(value)),log=value=>fs.appendFileSync(events,JSON.stringify(value)+'\\n');
if(JSON.stringify(argv)===JSON.stringify(['--version'])){process.stdout.write('limactl version 1.0.0\\n');process.exit(0);}
const prefix=['shell','synthetic-instance','--','/usr/bin/sudo','-n','--'];
if(JSON.stringify(argv.slice(0,6))!==JSON.stringify(prefix))process.exit(78);
if(argv[6]==='/usr/local/libexec/patrick-worker-probe'&&argv.length===9&&argv[7]==='--operation'){
 const operation=argv[8];log(operation);
 if(['qualification','qualification-start','qualification-finish'].includes(operation)){
  if(operation==='qualification-finish'&&failure==='later-failure')process.exit(78);
  emit({...${JSON.stringify(control)},operation,sessionActive:operation==='qualification-start'||operation==='qualification'&&fs.existsSync(events)&&fs.readFileSync(events,'utf8').includes('qualification-start')});
 }else if(operation==='qualification-network'){
  if(failure==='unavailable-network')process.exit(78);
  emit(failure==='invalid-network'?{version:1}: ${JSON.stringify(network)});
 }else if(operation==='synthetic-network')process.exit(78);else process.exit(78);
}else if(argv[6]==='/usr/local/libexec/patrick-worker-enter'){
 const runner=argv[8],binding=${JSON.stringify(bindings)}.find(b=>b.runner===runner),stage=argv[18],operation=argv[20];
 if(!binding||argv[7]!=='--runner'||argv[9]!=='--user'||argv[10]!==binding.user||argv[11]!=='--project'||argv[12]!==binding.projectId||argv[13]!=='--domain'||argv[14]!==binding.domain||argv[15]!=='--invocation'||! /^[a-f0-9]{32}$/.test(argv[16])||argv[17]!=='--stage'||argv[19]!=='--operation'||argv[21]!=='--')process.exit(78);
 log({stage,operation});
 if(operation==='exec'&&stage==='prepare')process.exit(78);
 if(stage!=='cleanup'||argv.length!==22||!['stop','reconcile'].includes(operation)||failure==='unhealthy-adapter')process.exit(78);
 emit({version:2,kind:'registered',closure:operation==='stop'?'none':'workspace-cleaned',state:operation==='stop'?'drained':'closed',cgroupsEmpty:true,workerProcessesAbsent:true,workspacesAbsent:true,privateMountsAbsent:true,invocationClosed:operation==='reconcile',reason:'ok'});
}else process.exit(78);
`,{mode:0o700});
 return {root,bin,reportPath,events:()=>readFileSync(eventsPath,'utf8').trim().split('\n').map(line=>JSON.parse(line)),close(){rmSync(root,{recursive:true,force:true});}};
}
function expectUnobservedReport(value:ReturnType<typeof sanitizeQualificationReport>){
 const rows=value.results.filter(r=>(networkProbeIds as readonly string[]).includes(r.id));
 expect(rows).toHaveLength(59);expect(new Set(rows.map(r=>r.id+'/'+r.role)).size).toBe(59);
 for(const row of rows)expect(row).toMatchObject({status:'not_run',reason:'not_run',actualGuest:false,synthetic:true,environment:'installed',profile:'authenticated-client',network:{targets:0,attempted:0,denied:0,basis:'unobserved',gate:'unobserved'}});
 expect(value).not.toHaveProperty('networkPreconditionRequests');expect(value).toMatchObject({realModelCalls:0,costUsd:0,realProviderAdmission:false,providerAccountFeePrivacyQualified:false,productionMiniQualified:false});
 const pending=['profile-setup-failure','workspace-substitution','prepare-interrupted','startup-stop','aborted-test','aborted-cleanup','private-mount-removal','abort-cli','abort-acp','timeout','cleanup-denied','control-unavailable','token-collision','lingering-process','runtime-expiry','ssh-disconnect','vm-unavailable','reboot-registry','proxy-stopped','firewall-removed','proxy-restart','firewall-restart','vm-restart'];
 expect(value.results.filter(r=>pending.includes(r.id))).toHaveLength(23);for(const id of pending)expect(value.results.find(r=>r.id===id)).toMatchObject({status:'not_run',actualGuest:false});
}
describe('qualifier failure reporting through the real coordinator (host-only process fixture)',()=>{
 it.each(['unhealthy-adapter','unavailable-network','invalid-network','untrusted-network'] as const)('persists private unobserved coverage after %s',async failure=>{
  const f=hostFixture(failure);vi.stubEnv('PATH',f.bin);
  try{const value=await qualify({instance:'synthetic-instance',user:'patrick-grok',reportPath:f.reportPath});expectUnobservedReport(value);expectUnobservedReport(sanitizeQualificationReport(JSON.parse(readFileSync(f.reportPath,'utf8'))));expect(statSync(f.reportPath).mode&0o777).toBe(0o600);expect(f.events()).toContain('qualification-finish');expect(f.events().includes('qualification-network')).toBe(failure!=='unhealthy-adapter');}
  finally{vi.unstubAllEnvs();f.close();}
 },10000);
 it('keeps the CLI incomplete and nonzero after saving an unhealthy-adapter report',async()=>{
  const f=hostFixture('unhealthy-adapter');
  try{const cli=fileURLToPath(new URL('../../scripts/lima/qualify.ts',import.meta.url));const result=await new Promise<{code:number|null;stderr:string}>((resolve,reject)=>{
   const child=spawn(process.execPath,['--import','tsx',cli,'--instance','synthetic-instance','--user','patrick-grok','--report',f.reportPath],{env:{...process.env,PATH:f.bin},stdio:['ignore','ignore','pipe']});let stderr='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('fixture deadline'));},10000);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);resolve({code,stderr});});
  });expect(result).toEqual({code:1,stderr:''});expectUnobservedReport(sanitizeQualificationReport(JSON.parse(readFileSync(f.reportPath,'utf8'))));expect(statSync(f.reportPath).mode&0o777).toBe(0o600);}
  finally{f.close();}
 },15000);
 it('retains already trusted observed counts after a later control failure',async()=>{
  const f=hostFixture('later-failure');vi.stubEnv('PATH',f.bin);
  try{const value=await qualify({instance:'synthetic-instance',user:'patrick-grok',reportPath:f.reportPath});expect(value.networkPreconditionRequests).toEqual({header:1,tls:1});expect(value.results.filter(r=>(networkProbeIds as readonly string[]).includes(r.id))).toEqual(pairs().map(r=>({...r,actualGuest:true})));expect(sanitizeQualificationReport(JSON.parse(readFileSync(f.reportPath,'utf8')))).toEqual(value);}
  finally{vi.unstubAllEnvs();f.close();}
 },10000);
});
describe('installed network strict host report/control integration (actualGuest=false)',()=>{
 it('admits report-only unobserved coverage as one complete zero-attempt bundle',()=>{
  const value=sanitizeQualificationReport(report(unobservedPairs()));expect(value.results).toEqual(unobservedPairs());expect(value).not.toHaveProperty('networkPreconditionRequests');
  for(const reason of ['control_unavailable','lifetime'])expect(sanitizeQualificationReport(report(unobservedPairs().map(r=>({...r,reason})))).results).toHaveLength(59);
 });
 it.each(['missing','duplicate','wrong-role','mixed','partially-observed','pass','fail','not_applicable','actual-guest','profile','environment','synthetic','stage','profile-facts','post-drop','reason','targets','attempted','denied','fraction','extra-coverage','gate','basis','preconditions','undefined-preconditions','private-count','provider-admission','provider-privacy','production','model-calls','cost'])('rejects %s unobserved report laundering',kind=>{
  const value:any=report(unobservedPairs()),row=value.results[0];
  if(kind==='missing')value.results.pop();if(kind==='duplicate')value.results[value.results.length-1]=row;if(kind==='wrong-role')row.role='codex';if(kind==='mixed')value.results[0]=pairs()[0];if(kind==='partially-observed')value.results=value.results.slice(0,1);
  if(['pass','fail','not_applicable'].includes(kind)){row.status=kind;row.reason=kind==='pass'?'ok':kind==='fail'?'network':'not_applicable';}
  if(kind==='actual-guest')row.actualGuest=true;if(kind==='profile')row.profile='task-only';if(kind==='environment')row.environment='host-protocol';if(kind==='synthetic')row.synthetic=false;if(kind==='stage')row.stage='cli';if(kind==='profile-facts')row.profileFacts={};if(kind==='post-drop')row.postDrop={};if(kind==='reason')row.reason='trust';
  if(['targets','attempted','denied'].includes(kind))row.network[kind]=1;if(kind==='fraction')row.network.targets=0.5;if(kind==='extra-coverage')row.network.privateTargets=0;if(kind==='gate')row.network.gate='nft';if(kind==='basis')row.network.basis='socket-policy';
  if(kind==='preconditions')value.networkPreconditionRequests={header:0,tls:0};if(kind==='undefined-preconditions')value.networkPreconditionRequests=undefined;if(kind==='private-count')value.privateNetworkRequests=0;
  if(kind==='provider-admission')value.realProviderAdmission=true;if(kind==='provider-privacy')value.providerAccountFeePrivacyQualified=true;if(kind==='production')value.productionMiniQualified=true;if(kind==='model-calls')value.realModelCalls=1;if(kind==='cost')value.costUsd=1;
  expect(()=>sanitizeQualificationReport(value)).toThrow();
 });
 it('still rejects the contradictory observed empty-list fallback even with all counts zero',()=>{
  const rows=pairs().map(r=>({...r,status:'not_run',reason:'not_run',network:{...r.network,targets:0,attempted:0,denied:0}}));
  for(const row of rows)if(!row.id.startsWith('network-empty-')){row.network.basis='socket-policy';if(['network-wrong-sni','network-ech'].includes(row.id))row.network.gate='proxy-tls';}
  expect(()=>sanitizeQualificationReport(report(rows))).toThrow('inconsistent network pairs');
 });
 it('accepts the finite 59 distinct network result pairs and conservative applicability',()=>{
  const rows=pairs();rows[rows.findIndex(r=>r.id==='network-vpn'&&r.role==='grok')]={...result('network-vpn'),status:'not_applicable',reason:'not_applicable',network:{targets:0,attempted:0,denied:0,basis:'no-inventory-target',gate:'inventory'}};
  const value=sanitizeQualificationReport(report(rows));expect(value.results).toHaveLength(59);expect(value.realProviderAdmission).toBe(false);
 });
 it.each(['nonnetwork','attempt','denied','fraction','overflow','extra','wrong-role','no-profile','no-coverage','duplicate','invalid-basis','loopback-skip','pass-zero'])('rejects %s report laundering',kind=>{
  const row:any=result('network-vpn');if(kind==='nonnetwork'){row.id='grok-pass';row.status='not_applicable';row.reason='not_applicable';}
  if(kind==='attempt')row.network.attempted=2;if(kind==='denied')row.network.denied=2;if(kind==='fraction')row.network.targets=1.5;if(kind==='overflow')row.network.targets=1025;
  if(kind==='extra')row.network.destination='private.invalid';if(kind==='wrong-role')row.id='network-empty-codex';if(kind==='no-profile')delete row.profile;if(kind==='no-coverage')delete row.network;
  if(kind==='invalid-basis'||kind==='loopback-skip'){row.status='not_applicable';row.reason='not_applicable';row.network={targets:0,attempted:0,denied:0,basis:'no-inventory-target',gate:'inventory'};if(kind==='invalid-basis')row.network.basis='ipv6-upstream-disabled';else row.id='network-loopback-ipv6';}
  if(kind==='pass-zero')row.network={targets:0,attempted:0,denied:0,basis:'socket-policy',gate:'nft'};
  expect(()=>sanitizeQualificationReport(report(kind==='duplicate'?[row,row]:[row]))).toThrow();
 });
 it('retains only finite separately observed precondition counts in the private report',()=>{
  const base=report(pairs());expect(sanitizeQualificationReport({...base,networkPreconditionRequests:{header:1,tls:1}})).toHaveProperty('networkPreconditionRequests',{header:1,tls:1});expect(sanitizeQualificationReport(base)).not.toHaveProperty('networkPreconditionRequests');
  for(const counts of [{header:2,tls:0},{header:0},{header:0,tls:0,raw:'private'}])expect(()=>sanitizeQualificationReport({...base,networkPreconditionRequests:counts})).toThrow();
 });
 it('strictly parses root operation results rather than trusting outcome pass',async()=>{
  const {parseInstalledNetworkControl}=await import('../../scripts/lima/qualify.js');
  const value={version:1,operation:'qualification-network',outcome:'pass',reason:'ok',synthetic:true,environment:'installed',actualGuest:false,artifactHash:hash,policyHash:hash,inventoryHash:hash,preconditionRequests:{header:0,tls:1},results:pairs()};
  expect(parseInstalledNetworkControl(value).results).toHaveLength(59);
  for(const outcome of ['pass','fail'])expect(()=>parseInstalledNetworkControl({...value,outcome,reason:outcome==='pass'?'ok':'network',results:unobservedPairs()})).toThrow();
  for(const invalid of [{...value,results:value.results.slice(1)},{...value,results:[...value.results,value.results[0]]},{...value,results:value.results.map((r,i)=>i? r:{...r,status:'fail',reason:'network',network:{...r.network,denied:0}})},{...value,results:value.results.map(r=>r.id==='network-empty-codex'?{...r,network:{...r.network,targets:6,attempted:6,denied:6}}:r)},{...value,preconditionRequests:{header:2,tls:0}},{...value,raw:'private'}])expect(()=>parseInstalledNetworkControl(invalid)).toThrow();
 });
});
