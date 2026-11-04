import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { dirname, join } from 'node:path';
import { fixture } from '../fixtures/lima-lifetime.mjs';
const lifetime=await import(new URL('../../scripts/lima/stage-lifetime.mjs',import.meta.url).href);
const token='a'.repeat(32),scope={runner:'grok',user:'patrick-grok',projectId:'fixture',domain:'personal'};
const account={uid:1101,gid:1101,home:'/var/lib/patrick-grok',groups:[]};
const using=async(fn:(f:ReturnType<typeof fixture>)=>Promise<void>)=>{const f=fixture();try{await fn(f);}finally{f.close();}};
describe('serialized trusted stage lifetime',()=>{
 it('records root-owned empty allocation and pending root-generated unit before submission',()=>using(async f=>{
  const submit=f.deps.manager.submit;f.deps.manager.submit=spec=>{const record=f.record();expect(record.stages[0]).toMatchObject({phase:'pending',stage:'prepare',profile:'task-only'});expect(record.layout.path).toBe('/var/lib/patrick-workspaces/'+token+'/work');expect(fs.readdirSync(f.physical(record.layout.path))).toEqual([]);expect(f.io.lstatSync(record.layout.path)).toMatchObject({uid:1101,gid:1101});expect(fs.statSync(f.physical('/run/patrick-worker/invocations/'+token+'.json')).mode&0o777).toBe(0o600);return submit(spec);};
  await f.run();expect(f.submissions[0].unit).toMatch(/^patrick-worker-[a-f0-9]{32}-1.service$/);expect(f.record().stages[0]).toMatchObject({phase:'complete',invocationId:'e'.repeat(32)});
 }));
 it('closes normal success only after seal, drained cleanup and final reconciliation, retaining replay tombstone',()=>using(async f=>{
  await f.run();await f.run('cli');await expect(f.run('cleanup')).rejects.toThrow();
  expect(await f.run('cli','stop')).toMatchObject({state:'drained',invocationClosed:false,cgroupsEmpty:true});
  await f.run('cleanup');expect(await f.run('cleanup','reconcile')).toMatchObject({state:'closed',invocationClosed:true,workspacesAbsent:true});
  expect(lifetime.registryQuiescent(f.io)).toBe(true);await expect(f.run()).rejects.toThrow();expect(f.submissions).toHaveLength(3);
 }));
 it.each(['proxy','nft','policy','artifact','withdrawn'])('stops recorded units through %s drift while denying payload and release',drift=>using(async f=>{
  await f.run();f.setAdmission(drift);await expect(f.run('cli')).rejects.toThrow();const historical=f.record().admission;
  expect(await f.run('cli','stop')).toMatchObject({state:'drained',invocationClosed:false});expect(f.stops).toEqual([f.submissions[0].unit]);expect(f.record().admission).toEqual(historical);
  await f.run('cleanup');expect(await f.run('cleanup','reconcile')).toMatchObject({invocationClosed:false});await expect(f.run('prepare','exec','b'.repeat(32))).rejects.toThrow();
 }));
 it('denies cross-scope token, duplicate stage, wrong order/runner and a second active UID',()=>using(async f=>{
  await f.run();for(const req of [f.request(),f.request('read'),f.request('acp'),f.request('cli','exec',token,{...scope,domain:'foreign'}),f.request('prepare','exec','b'.repeat(32))])await expect(lifetime.executeStage(req,f.deps)).rejects.toThrow();expect(f.submissions).toHaveLength(1);
 }));
 it('denies identity aliases and reused unit names without targeting unrelated processes',()=>using(async f=>{
  await f.run();f.units.get(f.submissions[0].unit).invocationId='f'.repeat(32);expect(await f.run('cli','stop')).toMatchObject({state:'quarantined',invocationClosed:false});expect(f.stops).toEqual([]);
  f.setIdentity(false);expect(await f.run('cli','reconcile')).toMatchObject({invocationClosed:false});expect(f.stops).toEqual([]);
 }));
 it('checks the fence atomically after a delayed payload waits on the real global lock',()=>using(async f=>{
  await f.run();fs.mkdirSync(f.physical('/run/patrick-worker/install.lock'),{mode:0o700});
  const late=f.run('cli');await f.run('cli','stop');fs.rmdirSync(f.physical('/run/patrick-worker/install.lock'));
  await expect(late).rejects.toThrow();expect(f.submissions).toHaveLength(1);
 }));
 it('exec winning registration is included in stop; late completion cannot reopen sealed state',()=>using(async f=>{
  await f.run();const pending=f.hold(),ack=f.ack();const cli=f.run('cli');for(let i=0;i<50&&f.submissions.length<2;i++)await new Promise(r=>setTimeout(r,2));
  const stopping=f.run('cli','stop');ack.resolve(undefined);expect(await stopping).toMatchObject({state:'drained'});expect(f.stops).toContain(f.submissions[1].unit);pending.resolve({code:0});await cli;expect(f.record()).toMatchObject({payloadSealed:true,state:'drained'});
 }));
 it('observes acknowledged active work without changing authority or sealing the next legal stage',()=>using(async f=>{
  await f.run();const done=f.hold(),cli=f.run('cli');
  for(let i=0;i<50&&f.record().stages.at(-1).phase!=='acknowledged';i++)await new Promise(r=>setTimeout(r,2));
  const before=f.record();expect(before.stages.at(-1).phase).toBe('acknowledged');
  f.setObserved({workerProcessesAbsent:false,cgroupsEmpty:false});
  expect(await f.run('cli','reconcile')).toMatchObject({state:'active',reason:'active',invocationClosed:false,cgroupsEmpty:false,workerProcessesAbsent:false});
  expect(f.record()).toEqual(before);expect(f.stops).toEqual([]);
  f.setObserved({workerProcessesAbsent:true,cgroupsEmpty:true});done.resolve({code:0});await cli;
  await f.run('tests');expect(f.record()).toMatchObject({state:'active',payloadSealed:false});
  expect(f.submissions.map(s=>s.stage)).toEqual(['prepare','cli','tests']);
 }));
 it('quarantines pending unacknowledged launch and unknown mount teardown; never consumes cleanup',()=>using(async f=>{
  f.deps.manager.acknowledge=async()=>null;await expect(f.run()).rejects.toThrow();expect(f.record()).toMatchObject({state:'quarantined'});f.deps.manager.inspect=async()=>null;f.deps.manager.pending=async()=>true;f.setObserved({privateMountsAbsent:false});
  expect(await f.run('cli','stop')).toMatchObject({invocationClosed:false,state:'quarantined'});await expect(f.run('cleanup')).rejects.toThrow();expect(f.record().cleanupConsumed).toBe(false);
 }));
 it('serializes stop during cleanup and never repeats cleanup',()=>using(async f=>{
  await f.run();await f.run('cli','stop');const done=f.hold(),clean=f.run('cleanup');for(let i=0;i<50&&f.submissions.length<2;i++)await new Promise(r=>setTimeout(r,2));
  await f.run('cleanup','stop');done.resolve({code:0});await clean;await expect(f.run('cleanup')).rejects.toThrow();expect(f.record().payloadSealed).toBe(true);expect(f.submissions.filter(s=>s.stage==='cleanup')).toHaveLength(1);
 }));
 it('leaves residuals, substituted workspace and ambiguous cleanup unclosed',()=>using(async f=>{
  await f.run();await f.run('cli','stop');f.setObserved({privateMountsAbsent:false});await expect(f.run('cleanup')).rejects.toThrow();expect(await f.run('cli','reconcile')).toMatchObject({invocationClosed:false});
 }));
 it('fails closed for an abandoned cross-process lock without deleting it',()=>using(async f=>{
  fs.mkdirSync(f.physical('/run/patrick-worker/install.lock'),{mode:0o700});fs.writeFileSync(f.physical('/run/patrick-worker/install.lock/owner.json'),'abandoned',{mode:0o600});
  await expect(f.run()).rejects.toThrow();expect(f.submissions).toEqual([]);expect(fs.readFileSync(f.physical('/run/patrick-worker/install.lock/owner.json'),'utf8')).toBe('abandoned');
 }));
 it('checks global then UID order, durable ACK before gate release and no payload runtime lock',()=>using(async f=>{
  const writes:string[]=[],mkdir=f.io.mkdirSync;f.io.mkdirSync=(p,o)=>{writes.push(p);return mkdir(p,o);};const gate=f.ack(),done=f.hold(),submit=f.deps.manager.submit;let released=false;
  f.deps.manager.submit=spec=>({...submit(spec),release:()=>{expect(f.record().stages[0].phase).toBe('acknowledged');released=true;}});
  const stage=f.run();for(let i=0;i<50&&!f.submissions.length;i++)await new Promise(r=>setTimeout(r,2));expect(released).toBe(false);expect(writes.slice(0,2)).toEqual(['/run/patrick-worker/install.lock','/run/patrick-worker/uid-1101.lock']);
  gate.resolve(undefined);for(let i=0;i<50&&!released;i++)await new Promise(r=>setTimeout(r,2));expect(released).toBe(true);expect(fs.existsSync(f.physical('/run/patrick-worker/install.lock'))).toBe(false);done.resolve({code:0});await stage;
 }));
 it('preserves interrupted allocation intent and refuses preexisting or substituted workspaces',()=>using(async f=>{
  const mkdir=f.io.mkdirSync;f.io.mkdirSync=(p,o)=>{if(p.endsWith('/work'))throw Error('interrupted allocation');return mkdir(p,o);};await expect(f.run()).rejects.toThrow();expect(f.record()).toMatchObject({state:'quarantined',layout:{status:'intended',path:'/var/lib/patrick-workspaces/'+token+'/work'}});expect(f.submissions).toHaveLength(0);expect(await f.run('cli','stop')).toMatchObject({invocationClosed:false});
 }));
 it('requires inode identity and never recursively removes residual token-parent entries',()=>using(async f=>{
  await f.run();await f.run('cli','stop');const r=f.record();fs.rmdirSync(f.physical(r.layout.path));fs.mkdirSync(f.physical(r.layout.path));f.io.chownSync(r.layout.path,1101,1101);await expect(f.run('cleanup')).rejects.toThrow();expect(f.record().cleanupConsumed).toBe(false);
 }));
 it('quarantines changed boot, malformed record and missing registry while blocking subsequent admission',()=>using(async f=>{
  await f.run();const file=f.physical('/run/patrick-worker/invocations/'+token+'.json'),r=f.record();r.boot='22222222-2222-4222-8222-222222222222';fs.writeFileSync(file,JSON.stringify(r));expect(await f.run('cli','stop')).toMatchObject({invocationClosed:false});expect(f.stops).toEqual([]);
  fs.writeFileSync(file,'{}');expect(()=>lifetime.registryQuiescent(f.io)).toThrow();await expect(f.run('prepare','exec','b'.repeat(32))).rejects.toThrow();
  fs.unlinkSync(file);await expect(f.run('prepare','exec','b'.repeat(32))).rejects.toThrow();
 }));
 it('rejects corrupt closure receipts instead of trusting a closed label',()=>using(async f=>{
  await f.run();await f.run('cli','stop');await f.run('cleanup');await f.run('cleanup','reconcile');const original=f.record(),file=f.physical('/run/patrick-worker/invocations/'+token+'.json');
  for(const change of [(r:any)=>r.drain={generation:'f'.repeat(32),sequence:999},(r:any)=>r.layout.rootIno='caller-inode',(r:any)=>r.stages[0].invocationId=null]){const r=structuredClone(original);change(r);fs.writeFileSync(file,JSON.stringify(r));expect(()=>lifetime.registryQuiescent(f.io)).toThrow();}
 }));
 it('never converts a missing cleanup effect or residual parent file into successful closure',()=>using(async f=>{
  await f.run();await f.run('cli','stop');const submit=f.deps.manager.submit;f.deps.manager.submit=spec=>{const launched=submit({...spec,stage:'unconfirmed-cleanup'});return launched;};await expect(f.run('cleanup')).rejects.toThrow();expect(await f.run('cleanup','reconcile')).toMatchObject({invocationClosed:false});expect(f.record()).toMatchObject({payloadSealed:true,cleanupConsumed:true,cleanupConfirmed:false});
 }));
 it('leaves extra token-directory entries to trusted recovery rather than deleting them',()=>using(async f=>{
  await f.run();await f.run('cli','stop');await f.run('cleanup');const root=f.record().layout.root;fs.writeFileSync(f.physical(root+'/residual'),'synthetic residual');expect(await f.run('cleanup','reconcile')).toMatchObject({invocationClosed:false,reason:'workspace_residual'});expect(fs.readFileSync(f.physical(root+'/residual'),'utf8')).toBe('synthetic residual');
 }));
 it('does not break a lock held and then abandoned by a separate owned fixture process',()=>using(async f=>{
  const path=f.physical('/run/patrick-worker/install.lock'),child=spawn(process.execPath,['-e',"const fs=require('node:fs');fs.mkdirSync(process.argv[1],{mode:0o700});fs.writeFileSync(process.argv[1]+'/owner.json','owned child',{mode:0o600});process.stdout.write('ready');setInterval(()=>{},1000);",path],{cwd:f.root,env:{},stdio:['ignore','pipe','pipe']});child.stderr.resume();const closed=new Promise(resolve=>child.on('close',resolve));
  try{await new Promise(resolve=>child.stdout.once('data',resolve));await expect(f.run()).rejects.toThrow();child.kill('SIGTERM');await closed;await expect(f.run()).rejects.toThrow();expect(fs.readFileSync(path+'/owner.json','utf8')).toBe('owned child');expect(f.submissions).toEqual([]);}finally{child.kill('SIGKILL');await closed;}
 }));
 it('keeps a missing unacknowledged submission unknown after submitter exit and delayed manager publication',()=>using(async f=>{
  const completion=f.hold();f.deps.manager.acknowledge=async()=>null;await expect(f.run()).rejects.toThrow();
  const inspect=f.deps.manager.inspect;let published=false;f.deps.manager.inspect=async unit=>published?inspect(unit):null;
  f.deps.manager.settled=async()=>true;completion.resolve({code:null});
  for(let i=0;i<50&&!f.record().stages[0].submitterExited;i++)await new Promise(r=>setTimeout(r,2));
  expect(f.record().stages[0].submitterExited).toBe(true);
  expect(await f.run('cli','stop')).toMatchObject({state:'quarantined',invocationClosed:false});
  expect(f.record().drain).toBe(null);await expect(f.run('cleanup')).rejects.toThrow();
  expect(await f.run('cli','reconcile')).toMatchObject({invocationClosed:false});
  await expect(f.run('cli')).rejects.toThrow();await expect(f.run('prepare','exec','b'.repeat(32))).rejects.toThrow();
  expect(f.submissions).toHaveLength(1);expect(f.stops).toEqual([]);expect(f.record().cleanupConsumed).toBe(false);
  published=true;const owned=f.units.get(f.submissions[0].unit);owned.active=true;owned.empty=false;
  expect(await f.run('cli','stop')).toMatchObject({state:'drained',invocationClosed:false});
  expect(f.stops).toEqual([f.submissions[0].unit]);expect(f.record().stages[0].invocationId).toBe(owned.invocationId);
  f.deps.manager.acknowledge=inspect;f.hold().resolve({code:0});await f.run('cleanup');
  expect(await f.run('cleanup','reconcile')).toMatchObject({state:'closed',invocationClosed:true});
 }));
 it('retains the UID mutex when neither the stop fence nor quarantine can be durably replaced',()=>using(async f=>{
  await f.run();const rename=f.io.renameSync;f.io.renameSync=(a,b)=>{if(b.endsWith('/'+token+'.json'))throw Error('durability unavailable');return rename(a,b);};
  expect(await f.run('cli','stop')).toMatchObject({invocationClosed:false});expect(fs.existsSync(f.physical('/run/patrick-worker/uid-1101.lock'))).toBe(true);await expect(f.run('cli')).rejects.toThrow();expect(f.submissions).toHaveLength(1);
 }));
 it('keeps 4096 and 4097 completed tombstones quiescent and replay-safe while admitting fresh work',()=>using(async f=>{
  await f.run();await f.run('cleanup','stop');await f.run('cleanup');await f.run('cleanup','reconcile');
  const closed=f.record();
  for(let n=1;n<4096;n++){
   const r=structuredClone(closed);r.invocation=n.toString(16).padStart(32,'0');r.generation=r.invocation;
   r.layout.root='/var/lib/patrick-workspaces/'+r.invocation;r.layout.path=r.layout.root+'/work';r.drain.generation=r.generation;
   for(const stage of r.stages){stage.unit=`patrick-worker-${r.generation}-${stage.sequence}.service`;stage.description=`patrick-worker:${r.generation}:${r.invocation}:${stage.sequence}`;stage.controlGroup='/system.slice/'+stage.unit;}
   fs.writeFileSync(f.physical('/run/patrick-worker/invocations/'+r.invocation+'.json'),JSON.stringify(r),{mode:0o600});
  }
  for(const fresh of ['b'.repeat(32),'c'.repeat(32)]){
   expect(lifetime.registryQuiescent(f.io)).toBe(true);await expect(f.run()).rejects.toThrow();
   await f.run('prepare','exec',fresh);await f.run('cleanup','stop',fresh);await f.run('cleanup','exec',fresh);await f.run('cleanup','reconcile',fresh);
  }
  expect(lifetime.registryQuiescent(f.io)).toBe(true);
  const file=f.physical('/run/patrick-worker/invocations/'+token+'.json');
  fs.writeFileSync(file,'{}');expect(()=>lifetime.registryQuiescent(f.io)).toThrow();fs.writeFileSync(file,JSON.stringify(closed));
  const unknown=f.physical('/run/patrick-worker/invocations/unrecognized');fs.writeFileSync(unknown,'{}');expect(()=>lifetime.registryQuiescent(f.io)).toThrow();fs.unlinkSync(unknown);
  await f.run('prepare','exec','d'.repeat(32));expect(lifetime.registryQuiescent(f.io)).toBe(false);
 }),20000);
 it('closes each streamed history handle exactly once on success, active return and corrupt denial',()=>using(async f=>{
  let opened=0,closed=0;const open=f.io.opendirSync;
  f.io.opendirSync=(path,options)=>{const directory=open(path,options),close=directory.closeSync.bind(directory);opened++;directory.closeSync=()=>{closed++;close();};return directory;};
  expect(lifetime.registryQuiescent(f.io)).toBe(true);expect({opened,closed}).toEqual({opened:1,closed:1});
  await f.run();expect(lifetime.registryQuiescent(f.io)).toBe(false);expect(opened).toBe(closed);
  fs.writeFileSync(f.physical('/run/patrick-worker/invocations/'+token+'.json'),'{}');expect(()=>lifetime.registryQuiescent(f.io)).toThrow();expect(opened).toBe(closed);
 }));
 it('never touches the real filesystem through omitted fixture path methods',()=>using(async f=>{
  delete (f.io as any).openSync;await expect(f.run()).rejects.toThrow();expect(f.submissions).toEqual([]);
 }));
});
describe('finite stage profiles and envelopes',()=>{
 it.each(['prepare','tests','read','cleanup','cli','acp'])('derives %s exposure without opening an original HOME alias',stage=>using(async f=>{
  const spec=lifetime.buildServiceInvocation({...scope,...account,proxyPort:18081,command:['literal','--profile','authenticated-client']},{invocation:token,stage,profile:lifetime.profileFor(stage),operation:'exec'},{unit:'patrick-worker-'+token+'-1.service',description:'owned',workspace:'/var/lib/patrick-workspaces/'+token+'/work'});
  const props=spec.args.filter((a:string)=>a.startsWith('--property='));expect(props).toContain('--property=ProtectSystem=strict');expect(props).toContain('--property=PrivateTmp=yes');expect(props).toContain('--property=CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_SETPCAP');
  if(['cli','acp'].includes(stage)){expect(props).not.toContain('--property=PrivateNetwork=yes');expect(props).toContain('--property=ReadWritePaths=/var/lib/patrick-grok /var/lib/patrick-workspaces/'+token);}
  else {expect(props).toContain('--property=PrivateNetwork=yes');expect(props).toContain('--property=RestrictAddressFamilies=AF_UNIX');expect(props).toContain('--property=TemporaryFileSystem=/var/lib/patrick-grok:rw,nosuid,nodev,size=16M,nr_inodes=1024,mode=0700,uid=1101,gid=1101');expect(props.some((p:string)=>p.startsWith('--property=ReadWritePaths=')&&p.includes('patrick-grok'))).toBe(false);}
  expect(spec.args.slice(-2)).toEqual(['--profile','authenticated-client']);
 }));
 it('rejects the diagnostic masked-HOME overlap shape and arbitrary profile/identity/path',()=>{
  expect(()=>lifetime.assertProfilePaths('task-only','/var/lib/patrick-grok',['/var/lib/patrick-grok/task'])).toThrow();
  for(const path of ['/var','/var/lib','/var/lib/patrick-grok','/var/lib/patrick-grok/task'])expect(()=>lifetime.assertProfilePaths('task-only','/var/lib/patrick-grok',[path])).toThrow();
 });
 it('requires exact fixed scripts/workspace and rejects caller profile injection before spawn',()=>using(async f=>{
  for(const req of [{...f.request(),command:['node','-e','arbitrary']},{...f.request(),lifetime:{...f.request().lifetime,profile:'authenticated-client'}},{...f.request(),command:['node','-e',lifetime.guestScripts.prepare,'/tmp/foreign']}])await expect(lifetime.executeStage(req,f.deps)).rejects.toThrow();expect(f.submissions).toEqual([]);
 }));
 it('keeps tests HOME private and receives a bound argv workspace instead of JSON dir',()=>{
  expect(lifetime.guestScripts.tests).toContain('HOME:process.env.HOME');expect(lifetime.guestScripts.tests).toContain('process.argv[1]');expect(lifetime.guestScripts.tests).not.toContain('p.dir');expect(lifetime.guestScripts.prepare).not.toContain('mkdtemp');
 });
});


describe('fixed post-drop gate protocol',()=>{
 it.each(['prompt\n--stage cleanup\n{"literal":"$(id)"}','{"jsonrpc":"2.0","method":"initialize"}\n'])('preserves original prompt and ACP bytes after the gate: %s',async payload=>{
  const root=fs.mkdtempSync(join(tmpdir(),'patrick-gate-'));
  try {const child=spawn('/bin/sh',['-c',lifetime.gateWrapper,'patrick-worker',process.execPath,'-e',"process.stdin.pipe(process.stdout)"],{cwd:root,env:{HOME:root},stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',c=>output+=c);child.stderr.resume();const closed=new Promise(resolve=>child.on('close',code=>resolve(code)));await new Promise(r=>setTimeout(r,20));expect(output).toBe('');child.stdin.end(lifetime.releaseLine+payload);expect(await closed).toBe(0);expect(output).toBe(payload);}finally{fs.rmSync(root,{recursive:true,force:true});}
 });
 it.each(['','wrong-gate\npayload'])('does not run any payload after EOF or invalid gate %j',async bytes=>{
  const root=fs.mkdtempSync(join(tmpdir(),'patrick-gate-'));try {const child=spawn('/bin/sh',['-c',lifetime.gateWrapper,'patrick-worker',process.execPath,'-e',"process.stdout.write('started')"],{cwd:root,env:{HOME:root},stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',c=>output+=c);child.stderr.resume();const closed=new Promise(resolve=>child.on('close',code=>resolve(code)));child.stdin.end(bytes);expect(await closed).not.toBe(0);expect(output).toBe('');}finally{fs.rmSync(root,{recursive:true,force:true});}
 });
 it('checks actual namespace facts before a fixed read, including the masked-HOME overlap failure',()=>{
  function evaluate(type=0x01021994,alias=false){let output='',exit=0;const status=['CapInh: 0000000000000000','CapPrm: 0000000000000000','CapEff: 0000000000000000','CapBnd: 0000000000000000','CapAmb: 0000000000000000','NoNewPrivs: 1'].join('\n');
   const kernel={lstatSync:()=>({isDirectory:()=>true,isSymbolicLink:()=>false,uid:1101,gid:1101,mode:0o40700}),statfsSync:()=>({type,bsize:4096,blocks:4096,files:1024}),readFileSync:(p:string)=>p==='/proc/self/mountinfo'?'1 0 0:1 / /var/lib/patrick-grok rw - tmpfs tmpfs rw\n':p==='/proc/self/status'?status:p==='/proc/net/route'?'Iface Destination\n':'{"summary":"actual fixed read"}',readdirSync:()=>alias?['9']:[],readlinkSync:()=>'/var/lib/patrick-grok/secret'};
   try{runInNewContext(lifetime.guestScripts.read,{require:(name:string)=>{expect(name).toBe('node:fs');return kernel;},process:{env:{HOME:account.home},getuid:()=>1101,geteuid:()=>1101,getgid:()=>1101,getegid:()=>1101,getgroups:()=>[],argv:['node','/var/lib/patrick-workspaces/'+token+'/work'],stdout:{write:(v:string)=>output+=v},exit:(code:number)=>{exit=code;throw Error('fixture exit');}}});}catch{}return {output,exit};}
  expect(evaluate()).toEqual({output:'{"summary":"actual fixed read"}',exit:0});expect(evaluate(0xef53)).toEqual({output:'',exit:78});expect(evaluate(0x01021994,true)).toEqual({output:'',exit:78});
 });
});
