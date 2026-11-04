import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { addCompletedQualificationNetworkOperation, corruptQualificationSession, malformedQualificationSessionCases, type QualificationSessionFault } from '../fixtures/lima-qualification-session-cases.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { dirname, join } from 'node:path';
import { fixture } from '../fixtures/lima-lifetime.mjs';
const lifetime=await import(new URL('../../scripts/lima/stage-lifetime.mjs',import.meta.url).href);
const token='a'.repeat(32),scope={runner:'grok',user:'patrick-grok',projectId:'fixture',domain:'personal'};
const account={uid:1101,gid:1101,home:'/var/lib/patrick-grok',groups:[]};
const using=async(fn:(f:ReturnType<typeof fixture>)=>Promise<void>)=>{const f=fixture();try{await fn(f);}finally{f.close();}};
const durable='/var/lib/patrick-worker',records=durable+'/invocations',marker=records+'/.authority.json',witness='/etc/patrick-worker/registry-identity.json',legacy=records,recordPath=records+'/'+token+'.json';
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const canonical=(value:any):any=>value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const metadataBytes=(value:any)=>Buffer.from(JSON.stringify(canonical(value))+'\n');
const metadata=(f:ReturnType<typeof fixture>,path=witness)=>JSON.parse(f.io.readFileSync(path,'utf8'));
function privateSessionFixture(f:ReturnType<typeof fixture>,network=false):any {
 const names=['.patrick-synthetic-auth','.patrick-synthetic-config'];for(const name of names)f.io.writeFileSync(account.home+'/'+name,'synthetic',{mode:0o444});fs.mkdirSync(f.physical('/etc/patrick-worker'),{recursive:true,mode:0o700});
 const session:any={version:2,registry:f.seedAuthority(),phase:'active',generation:'9'.repeat(32),artifactHash:'d'.repeat(64),policyHash:'c'.repeat(64),inventoryHash:'e'.repeat(64),records:[],codeHashes:Object.fromEntries(['worker-enter.mjs','policy.mjs','connect-proxy.mjs','address-policy.mjs','tls-clienthello.mjs','install-guest.mjs','probe-guest.mjs','stage-lifetime.mjs','synthetic-worker.mjs','synthetic-network.mjs','installed-network.mjs','entry','probe'].map(name=>[name,'f'.repeat(64)])),bindings:['grok','codex','dsh'].map((runner,index)=>({...scope,runner,user:'patrick-'+runner,uid:1101+index,gid:1101+index,home:'/var/lib/patrick-'+runner,proxyPort:18743+index,baseline:'0'.repeat(64),homeIno:f.io.lstatSync(account.home).ino,markers:names.map(name=>({name,ino:f.io.lstatSync(account.home+'/'+name).ino,hash:hash(Buffer.from('synthetic')),removeIntended:false,removed:false}))}))};
 if(network)addCompletedQualificationNetworkOperation(session);
 return session;
}
describe('fixed durable registry authority codec and reader',()=>{
 it('encodes exact schemas independently of insertion order with exactly one LF',()=>{
  const first={version:1,authorityId:'a'.repeat(32),root:{dev:0,ino:1},records:{dev:2,ino:3}},second={records:{ino:3,dev:2},root:{ino:1,dev:0},authorityId:first.authorityId,version:1};
  const bytes=lifetime.encodeRegistryMetadata(first);expect(bytes).toEqual(lifetime.encodeRegistryMetadata(second));
  expect(bytes.toString()).toBe('{"authorityId":"'+first.authorityId+'","records":{"dev":2,"ino":3},"root":{"dev":0,"ino":1},"version":1}\n');
 });
 it.each(['extra','negative-zero','unsafe-integer','zero-inode','coercion','wrong-version','uppercase-id','initializing-identities','ready-null','wrong-boot','unknown-initializer','nonfinite'])('rejects %s before metadata encoding',kind=>using(async f=>{
  f.seedAuthority();const value=metadata(f);
  if(kind==='extra')value.extra=true;if(kind==='negative-zero')value.root.dev=-0;if(kind==='unsafe-integer')value.root.ino=Number.MAX_SAFE_INTEGER+1;if(kind==='zero-inode')value.root.ino=0;if(kind==='coercion')value.root.dev='0';if(kind==='wrong-version')value.version=2;if(kind==='uppercase-id')value.authorityId='A'.repeat(32);if(kind==='initializing-identities')value.phase='initializing';if(kind==='ready-null')value.marker=null;if(kind==='wrong-boot')value.initializedBy.boot='boot';if(kind==='unknown-initializer')value.initializedBy.extra=true;if(kind==='nonfinite')value.root.dev=Infinity;
  expect(()=>lifetime.encodeRegistryMetadata(value)).toThrow();
 }));
 it('binds fixed directory and marker identities, with witness digest excluding LF and marker digest including LF',()=>using(async f=>{
  const reference=f.seedAuthority(),authority=lifetime.readRegistryAuthority(f.io,reference),ready=metadata(f),bytes=f.io.readFileSync(witness);
  expect(authority).toEqual({...reference,root:ready.root,records:ready.records,marker:ready.marker});expect(reference.witnessHash).toBe(hash(bytes.subarray(0,-1)));expect(reference.witnessHash).not.toBe(hash(bytes));expect(ready.marker.hash).toBe(hash(f.io.readFileSync(marker)));
  f.setBoot('22222222-2222-4222-8222-222222222222');expect(lifetime.readRegistryAuthority(f.io,reference)).toEqual(authority);
 }));
 it.each(['missing','initializing','oversized','invalid-utf8','owner','group','mode','nlink','duplicate-key','unknown-key','missing-lf','extra-lf','space','crlf','bom','reordered','marker-hash','marker-inode','reference','reference-extra','root-missing','root-substituted','symlink-ancestor','runtime-mode','runtime-special-mode'])('refuses %s without creating authority state',kind=>using(async f=>{
  const reference={...f.seedAuthority()},ready=metadata(f),bytes=f.io.readFileSync(witness);
  if(kind==='missing')f.io.unlinkSync(witness);
  if(kind==='initializing')f.io.writeFileSync(witness,lifetime.encodeRegistryMetadata({...ready,phase:'initializing',root:null,records:null,marker:null}));
  if(kind==='oversized')f.io.writeFileSync(witness,Buffer.alloc(4097,0x20));if(kind==='invalid-utf8')f.io.writeFileSync(witness,Buffer.from([0xff,10]));
  if(kind==='owner')f.io.chownSync(witness,1,0);if(kind==='group')f.io.chownSync(witness,0,1);if(kind==='mode')f.io.chmodSync(witness,0o640);if(kind==='nlink')f.io.linkSync(witness,'/etc/patrick-worker/witness-link');
  if(kind==='duplicate-key')f.io.writeFileSync(witness,'{"version":1,'+bytes.toString().slice(1));if(kind==='unknown-key')f.io.writeFileSync(witness,metadataBytes({...ready,unknown:true}));
  if(kind==='missing-lf')f.io.writeFileSync(witness,bytes.subarray(0,-1));if(kind==='extra-lf')f.io.writeFileSync(witness,Buffer.concat([bytes,Buffer.from('\n')]));if(kind==='space')f.io.writeFileSync(witness,Buffer.concat([bytes.subarray(0,-1),Buffer.from(' \n')]));if(kind==='crlf')f.io.writeFileSync(witness,Buffer.concat([bytes.subarray(0,-1),Buffer.from('\r\n')]));if(kind==='bom')f.io.writeFileSync(witness,Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),bytes]));if(kind==='reordered')f.io.writeFileSync(witness,JSON.stringify({...ready,version:undefined}).replace('"authorityId"','"version":1,"authorityId"')+'\n');
  if(kind==='marker-hash')f.io.writeFileSync(marker,Buffer.concat([f.io.readFileSync(marker),Buffer.from('\n')]));
  if(kind==='marker-inode'){fs.renameSync(f.physical(marker),f.physical(records+'/.saved'));f.io.writeFileSync(marker,lifetime.encodeRegistryMetadata(metadata(f,records+'/.saved')),{mode:0o600});}
  if(kind==='reference')reference.witnessHash='0'.repeat(64);if(kind==='reference-extra')(reference as any).extra=true;
  if(kind==='root-missing')fs.renameSync(f.physical(durable),f.physical(durable+'.saved'));
  if(kind==='root-substituted'){fs.renameSync(f.physical(durable),f.physical(durable+'.saved'));fs.mkdirSync(f.physical(records),{recursive:true,mode:0o700});fs.copyFileSync(f.physical(durable+'.saved/invocations/.authority.json'),f.physical(marker));}
  if(kind==='symlink-ancestor'){fs.renameSync(f.physical('/etc/patrick-worker'),f.physical('/etc/worker-saved'));fs.symlinkSync(f.physical('/etc/worker-saved'),f.physical('/etc/patrick-worker'));}
  if(kind==='runtime-mode')f.io.chmodSync('/run/patrick-worker',0o755);
  if(kind==='runtime-special-mode')f.io.chmodSync('/run/patrick-worker',0o1700);
  const before=f.events.length;expect(()=>lifetime.readRegistryAuthority(f.io,reference)).toThrow();expect(f.events.slice(before).every(event=>event.startsWith('open:'))).toBe(true);
 }));
 it('rejects a recreated directory even with a copied marker',()=>using(async f=>{
  const reference=f.seedAuthority(),bytes=f.io.readFileSync(marker);fs.renameSync(f.physical(records),f.physical(records+'.saved'));fs.mkdirSync(f.physical(records),{mode:0o700});f.io.writeFileSync(marker,bytes,{mode:0o600});expect(()=>lifetime.readRegistryAuthority(f.io,reference)).toThrow();
 }));
 it.each(['marker','witness'])('rejects noncanonical %s bytes even with a recomputed expected digest',kind=>using(async f=>{
  const reference={...f.seedAuthority()},path=kind==='marker'?marker:witness,bytes=f.io.readFileSync(path);f.io.writeFileSync(path,bytes.subarray(0,-1));
  if(kind==='marker'){const ready=metadata(f);ready.marker.hash=hash(bytes.subarray(0,-1));f.io.writeFileSync(witness,lifetime.encodeRegistryMetadata(ready));reference.witnessHash=hash(f.io.readFileSync(witness).subarray(0,-1));}else reference.witnessHash=hash(bytes.subarray(0,-1));
  expect(()=>lifetime.readRegistryAuthority(f.io,reference)).toThrow();
 }));
 it.each(['witness','marker','record'])('rejects %s substitution between lstat and open',kind=>using(async f=>{
  const reference=f.seedAuthority();if(kind==='record')await f.run();const path=kind==='record'?recordPath:kind==='witness'?witness:marker,open=f.io.openSync;let replaced=false;
  f.io.openSync=(p,...args)=>{if(p===path&&!replaced){replaced=true;fs.renameSync(f.physical(p),f.physical(p+'.saved'));fs.copyFileSync(f.physical(p+'.saved'),f.physical(p));}return open(p,...args);};
  expect(()=>kind==='record'?lifetime.registryQuiescent(f.io):lifetime.readRegistryAuthority(f.io,reference)).toThrow();expect(replaced).toBe(true);
 }));
 it.each(['witness','marker'])('bounds %s fstat and reads when lstat understates size',kind=>using(async f=>{
  f.seedAuthority();const path=kind==='witness'?witness:marker,lstat=f.io.lstatSync;f.io.writeFileSync(path,Buffer.alloc(4097));f.io.lstatSync=p=>{const stat=lstat(p);return p===path?Object.assign(Object.create(stat),{size:0}):stat;};expect(()=>lifetime.readRegistryAuthority(f.io)).toThrow();
 }));
 it.each(['witness','marker','record'])('reads at most the fixed bound plus one byte when %s grows after fstat',kind=>using(async f=>{
  f.seedAuthority();if(kind==='record')await f.run();const path=kind==='witness'?witness:kind==='marker'?marker:recordPath,limit=kind==='record'?131072:4096,open=f.io.openSync,stat=f.io.fstatSync,read=f.io.readSync;let target:number|undefined,grown=false,total=0;
  f.io.openSync=(p,...args)=>{const fd=open(p,...args);if(p===path)target=fd;return fd;};f.io.fstatSync=fd=>{const value=stat(fd);if(fd===target&&!grown){grown=true;fs.appendFileSync(f.physical(path),Buffer.alloc(limit));}return value;};f.io.readSync=(fd,...args)=>{const count=read(fd,...args);if(fd===target)total+=count;return count;};
  expect(()=>kind==='record'?lifetime.registryQuiescent(f.io):lifetime.readRegistryAuthority(f.io)).toThrow();expect(grown).toBe(true);expect(total).toBe(limit+1);
 }));
 it('copies, moves and deletes only successful synthetic ownership aliases and keeps descriptors bound',()=>using(async f=>{
  const source='/run/patrick-worker/source',target='/run/patrick-worker/target',moved=target+'-moved';f.io.writeFileSync(source,'fixture',{mode:0o600});f.io.chownSync(source,1101,1102);const fd=f.io.openSync(source,fs.constants.O_RDONLY);
  try{f.io.linkSync(source,target);expect(f.io.lstatSync(source)).toMatchObject({uid:1101,gid:1102});expect(f.io.lstatSync(target)).toMatchObject({uid:1101,gid:1102});expect(()=>f.io.linkSync(source,target)).toThrow();f.io.renameSync(target,moved);expect(f.io.lstatSync(moved)).toMatchObject({uid:1101,gid:1102});f.io.unlinkSync(source);expect(f.io.fstatSync(fd)).toMatchObject({uid:1101,gid:1102});f.io.writeFileSync(source,'new',{mode:0o600});expect(f.io.lstatSync(source)).toMatchObject({uid:0,gid:0});expect(f.io.lstatSync(moved)).toMatchObject({uid:1101,gid:1102});expect(()=>f.io.unlinkSync(target)).toThrow();expect(f.io.lstatSync(moved)).toMatchObject({uid:1101,gid:1102});}finally{f.io.closeSync(fd);}
 }));
 it('has no real filesystem fallback when a bounded fixture reader is absent',()=>using(async f=>{
  f.seedAuthority();delete (f.io as any).readSync;expect(()=>lifetime.readRegistryAuthority(f.io)).toThrow();expect(()=>f.physical('/../etc')).toThrow();expect(()=>f.io.readFileSync(999999)).toThrow('foreign fd');
 }));
});
describe('bounded no-replace record publication through controller saves',()=>{
 it('fsyncs the file and both publication directory states before submission',()=>using(async f=>{
  const submit=f.deps.manager.submit;f.deps.manager.submit=spec=>{const all=f.events.filter(event=>event.includes(legacy)),first=all.findIndex(event=>event.startsWith('open:'+legacy+'/.write-')),trace=all.slice(first),temp=trace.find(event=>event.startsWith('open:'+legacy+'/.write-'))?.slice(5);expect(temp).toMatch(new RegExp('^'+legacy+'/\\.write-'+token+'-[a-f0-9]{32}\\.tmp$'));expect(trace.slice(0,6)).toEqual(['open:'+temp,'fsync:'+temp,'link:'+temp+'->'+recordPath,'open:'+legacy,'fsync:'+legacy,'unlink:'+temp]);expect(trace.slice(6,8)).toEqual(['open:'+legacy,'fsync:'+legacy]);expect(f.io.lstatSync(recordPath)).toMatchObject({uid:0,gid:0,nlink:1});return submit(spec);};await f.run();
 }));
 it('rejects oversized serialized records before opening a registry temporary file and retains the UID lock',()=>using(async f=>{
  await expect(f.run('prepare','exec',token,{...scope,projectId:'x'.repeat(131072)})).rejects.toMatchObject({retainUidLock:true});expect(f.events.some(event=>event.startsWith('open:'+legacy+'/.write-'))).toBe(false);expect(fs.existsSync(f.physical('/run/patrick-worker/uid-1101.lock'))).toBe(true);expect(f.submissions).toEqual([]);
 }));
 it.each([false,true])('preserves fixed qualification-session enrollment through the bounded writer with network=%s',network=>using(async f=>{
  const session=privateSessionFixture(f,network);
  f.io.writeFileSync('/etc/patrick-worker/qualification.json',JSON.stringify(session)+'\n',{mode:0o600});await expect(f.run()).resolves.toMatchObject({code:0});expect(metadata(f,'/etc/patrick-worker/qualification.json')).toEqual({...session,records:[token]});
 }));
 it('exports the fixed pure qualification-session predicate without mutating parsed input',()=>using(async f=>{
  const session=privateSessionFixture(f,true),before=JSON.stringify(session),freeze=(value:any):any=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
  expect(typeof lifetime.validQualificationSession).toBe('function');expect(lifetime.validQualificationSession(freeze(session))).toBe(true);expect(JSON.stringify(session)).toBe(before);
  for(const malformed of [null,[],{}, {...session,records:null},{...session,bindings:[null,...session.bindings.slice(1)]},{...session,bindings:[{...session.bindings[0],markers:[null,null]},...session.bindings.slice(1)]}])expect(lifetime.validQualificationSession(malformed)).toBe(false);
 }));
 it.each([...malformedQualificationSessionCases] as string[])('refuses %s private session through the controller before enrollment or submission',kind=>using(async f=>{
  const session=privateSessionFixture(f,true);
  corruptQualificationSession(session,kind as QualificationSessionFault);
  const path='/etc/patrick-worker/qualification.json',bytes=JSON.stringify(session)+'\n';f.io.writeFileSync(path,bytes,{mode:0o600});
  await expect(f.run()).rejects.toThrow('Worker entry denied.');expect(f.submissions).toEqual([]);expect(f.io.readFileSync(path,'utf8')).toBe(bytes);for(const name of ['.patrick-synthetic-auth','.patrick-synthetic-config'])expect(f.io.readFileSync(account.home+'/'+name,'utf8')).toBe('synthetic');
 }));
 it('loses a two-publisher first-link race with EEXIST and preserves the winner bytes',()=>using(async f=>{
  const link=f.io.linkSync,other=legacy+'/.write-'+token+'-'+'f'.repeat(32)+'.tmp';let winning:Buffer|undefined,loserCode:string|undefined;
  f.io.linkSync=(from,to)=>{if(to===recordPath&&!winning){winning=Buffer.from(f.io.readFileSync(from));const value=JSON.parse(winning.toString());value.context.domain='winner';winning=Buffer.from(JSON.stringify(value)+'\n');f.io.writeFileSync(other,winning,{mode:0o600});link(other,to);f.io.unlinkSync(other);}try{link(from,to);}catch(error){loserCode=(error as NodeJS.ErrnoException).code;throw error;}};
  await expect(f.run()).rejects.toMatchObject({retainUidLock:true});expect(loserCode).toBe('EEXIST');expect(f.io.readFileSync(recordPath)).toEqual(winning);expect(fs.readdirSync(f.physical(legacy))).toEqual(['.authority.json',token+'.json']);expect(f.submissions).toEqual([]);
 }));
 it.each(['write','file-fsync','link','directory-fsync','after-link','after-unlink-fsync','rename','after-rename'])('does not acknowledge %s failure and preserves uncertain published state',fault=>using(async f=>{
  const replacing=['rename','after-rename'].includes(fault);if(replacing)await f.run();const prior=replacing?f.io.readFileSync(recordPath):undefined;f.events.length=0;f.submissions.length=0;
  const open=f.io.openSync,write=f.io.writeFileSync,sync=f.io.fsyncSync,link=f.io.linkSync,rename=f.io.renameSync,paths=new Map<number,string>();let tripped=false,directorySyncs=0;
  const trip=()=>{tripped=true;throw Error('injected '+fault);};
  f.io.openSync=(p,...args)=>{const fd=open(p,...args);paths.set(fd,p);return fd;};
  f.io.writeFileSync=(p,...args)=>{if(!tripped&&fault==='write'&&typeof p==='number'&&paths.get(p)?.startsWith(legacy+'/.write-'))trip();return write(p,...args);};
  f.io.fsyncSync=fd=>{const p=paths.get(fd);if(!tripped&&p?.startsWith(legacy+'/.write-')&&fault==='file-fsync')trip();if(p===legacy){directorySyncs++;if(!tripped&&(fault==='directory-fsync'||fault==='after-unlink-fsync'&&directorySyncs===2))trip();}sync(fd);};
  f.io.linkSync=(from,to)=>{if(to===recordPath&&!tripped&&fault==='link')trip();link(from,to);if(to===recordPath&&!tripped&&fault==='after-link')trip();};
  f.io.renameSync=(from,to)=>{if(to===recordPath&&!tripped&&fault==='rename')trip();rename(from,to);if(to===recordPath&&!tripped&&fault==='after-rename')trip();};
  await expect(f.run(replacing?'cli':'prepare')).rejects.toMatchObject({retainUidLock:true});expect(tripped).toBe(true);expect(f.submissions).toEqual([]);expect(fs.existsSync(f.physical('/run/patrick-worker/uid-1101.lock'))).toBe(true);
  const names=fs.readdirSync(f.physical(legacy));if(['directory-fsync','after-link'].includes(fault)){expect(names.filter(name=>name.startsWith('.write-'))).toHaveLength(1);expect(names).toContain(token+'.json');expect(()=>lifetime.registryQuiescent(f.io)).toThrow();}else expect(names.filter(name=>name.startsWith('.write-'))).toHaveLength(0);
  if(fault==='rename')expect(f.io.readFileSync(recordPath)).toEqual(prior);if(fault==='after-rename')expect(f.io.readFileSync(recordPath)).not.toEqual(prior);if(['write','file-fsync','link'].includes(fault))expect(names).toEqual(['.authority.json']);
  f.setObserved({workerProcessesAbsent:true,privateMountsAbsent:true,cgroupsEmpty:true});expect(await f.run('cli','stop')).toMatchObject({invocationClosed:false,reason:'control_unavailable'});
 }));
 it('never cleans up a substituted or unowned temporary inode',()=>using(async f=>{
  const open=f.io.openSync,write=f.io.writeFileSync,paths=new Map<number,string>();let replaced:string|undefined;
  f.io.openSync=(p,...args)=>{const fd=open(p,...args);paths.set(fd,p);return fd;};f.io.writeFileSync=(p,...args)=>{const path=typeof p==='number'?paths.get(p):undefined;if(!replaced&&path?.startsWith(legacy+'/.write-')){replaced=path;fs.renameSync(f.physical(path),f.physical(path+'.held'));fs.writeFileSync(f.physical(path),'foreign',{mode:0o600});throw Error('substituted temp');}return write(p,...args);};
  await expect(f.run()).rejects.toMatchObject({retainUidLock:true});expect(replaced).toBeDefined();expect(f.io.readFileSync(replaced!,'utf8')).toBe('foreign');expect(f.events).not.toContain('unlink:'+replaced);
 }));
 it('refuses replacement if an existing record changes authority or inode before rename',()=>using(async f=>{
  await f.run();const open=f.io.openSync;let changed=false;f.io.openSync=(p,...args)=>{const fd=open(p,...args);if(!changed&&p.startsWith(legacy+'/.write-')){changed=true;fs.renameSync(f.physical(recordPath),f.physical(recordPath+'.saved'));const raw=JSON.parse(f.io.readFileSync(recordPath+'.saved','utf8'));raw.generation='f'.repeat(32);raw.stages[0].unit='patrick-worker-'+raw.generation+'-1.service';raw.stages[0].description='patrick-worker:'+raw.generation+':'+token+':1';f.io.writeFileSync(recordPath,JSON.stringify(raw)+'\n',{mode:0o600});}return fd;};await expect(f.run('cli')).rejects.toMatchObject({retainUidLock:true});expect(f.record().generation).toBe('f'.repeat(32));
 }));
});
describe('serialized trusted stage lifetime',()=>{
 it('records root-owned empty allocation and pending root-generated unit before submission',()=>using(async f=>{
  const submit=f.deps.manager.submit;f.deps.manager.submit=spec=>{const record=f.record();expect(record.stages[0]).toMatchObject({phase:'pending',stage:'prepare',profile:'task-only'});expect(record.layout.path).toBe('/var/lib/patrick-workspaces/'+token+'/work');expect(fs.readdirSync(f.physical(record.layout.path))).toEqual([]);expect(f.io.lstatSync(record.layout.path)).toMatchObject({uid:1101,gid:1101});expect(fs.statSync(f.physical('/var/lib/patrick-worker/invocations/'+token+'.json')).mode&0o777).toBe(0o600);return submit(spec);};
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
  await f.run();const file=f.physical('/var/lib/patrick-worker/invocations/'+token+'.json'),r=f.record();r.boot='22222222-2222-4222-8222-222222222222';fs.writeFileSync(file,JSON.stringify(r));expect(await f.run('cli','stop')).toMatchObject({invocationClosed:false});expect(f.stops).toEqual([]);
  fs.writeFileSync(file,'{}');expect(()=>lifetime.registryQuiescent(f.io)).toThrow();await expect(f.run('prepare','exec','b'.repeat(32))).rejects.toThrow();
  fs.unlinkSync(file);await expect(f.run('prepare','exec','b'.repeat(32))).rejects.toThrow();
 }));
 it('rejects corrupt closure receipts instead of trusting a closed label',()=>using(async f=>{
  await f.run();await f.run('cli','stop');await f.run('cleanup');await f.run('cleanup','reconcile');const original=f.record(),file=f.physical('/var/lib/patrick-worker/invocations/'+token+'.json');
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
   const retained=n%2?r:{version:2,kind:'denial-only',authorityId:r.authorityId,invocation:r.invocation,context:r.context,identity:r.identity,authorization:{policyHash:r.admission.policyHash,artifactHash:r.admission.artifactHash},boot:r.boot,state:'denied',payloadSealed:true};
   fs.writeFileSync(f.physical('/var/lib/patrick-worker/invocations/'+r.invocation+'.json'),JSON.stringify(retained),{mode:0o600});
  }
  for(const fresh of ['b'.repeat(32),'c'.repeat(32)]){
   expect(lifetime.registryQuiescent(f.io)).toBe(true);await expect(f.run()).rejects.toThrow();
   await f.run('prepare','exec',fresh);await f.run('cleanup','stop',fresh);await f.run('cleanup','exec',fresh);await f.run('cleanup','reconcile',fresh);
  }
  expect(lifetime.registryQuiescent(f.io)).toBe(true);
  const file=f.physical('/var/lib/patrick-worker/invocations/'+token+'.json');
  fs.writeFileSync(file,'{}');expect(()=>lifetime.registryQuiescent(f.io)).toThrow();fs.writeFileSync(file,JSON.stringify(closed));
  const unknown=f.physical('/var/lib/patrick-worker/invocations/unrecognized');fs.writeFileSync(unknown,'{}');expect(()=>lifetime.registryQuiescent(f.io)).toThrow();fs.unlinkSync(unknown);
  await f.run('prepare','exec','d'.repeat(32));expect(lifetime.registryQuiescent(f.io)).toBe(false);
 }),20000);
 it('closes each streamed history handle exactly once on success, active return and corrupt denial',()=>using(async f=>{
  let opened=0,closed=0;const open=f.io.opendirSync;
  f.io.opendirSync=(path,options)=>{const directory=open(path,options),close=directory.closeSync.bind(directory);opened++;directory.closeSync=()=>{closed++;close();};return directory;};
  expect(lifetime.registryQuiescent(f.io)).toBe(true);expect({opened,closed}).toEqual({opened:1,closed:1});
  await f.run();expect(lifetime.registryQuiescent(f.io)).toBe(false);expect(opened).toBe(closed);
  fs.writeFileSync(f.physical('/var/lib/patrick-worker/invocations/'+token+'.json'),'{}');expect(()=>lifetime.registryQuiescent(f.io)).toThrow();expect(opened).toBe(closed);
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
   const kernel={lstatSync:()=>({isDirectory:()=>true,isSymbolicLink:()=>false,uid:1101,gid:1101,mode:0o40700}),statfsSync:()=>({type,bsize:4096,blocks:4096,files:1024}),writeFileSync:()=>{},unlinkSync:()=>{},existsSync:()=>false,readFileSync:(p:string)=>{if(p.includes('.patrick-synthetic-'))throw Object.assign(Error('absent'),{code:'ENOENT'});return p==='/proc/self/mountinfo'?'1 0 0:1 / /var/lib/patrick-grok rw - tmpfs tmpfs rw\n':p==='/proc/self/status'?status:p==='/proc/net/route'?'Iface Destination\n':'{"summary":"actual fixed read"}';},readdirSync:()=>alias?['9']:[],readlinkSync:()=>'/var/lib/patrick-grok/secret'};
   try{runInNewContext(lifetime.guestScripts.read,{require:(name:string)=>{if(name==='node:child_process')return {spawnSync:()=>({status:0})};expect(name).toBe('node:fs');return kernel;},process:{env:{HOME:account.home},getuid:()=>1101,geteuid:()=>1101,getgid:()=>1101,getegid:()=>1101,getgroups:()=>[],argv:['node','/var/lib/patrick-workspaces/'+token+'/work'],stdout:{write:(v:string)=>output+=v},stderr:{write:()=>{}},exit:(code:number)=>{exit=code;throw Error('fixture exit');}}});}catch{}return {output,exit};}
  expect(evaluate()).toEqual({output:'{"summary":"actual fixed read"}',exit:0});expect(evaluate(0xef53)).toEqual({output:'',exit:78});expect(evaluate(0x01021994,true)).toEqual({output:'',exit:78});
 });
});

describe('trusted finite stage observation',()=>{
 it('persists independent observations after exact manager ACK and before payload release',()=>using(async f=>{
  const postDrop={uid:1101,gid:1101,groups:[],noNewPrivileges:true,capEffective:'0',capPermitted:'0',capInheritable:'0',capAmbient:'0',capBounding:'0',homeMatches:true,fixedEnvironmentMatches:true,extraEnvironmentKeys:[],unknownEnvironmentKeyPresent:false,derivedPwdMatchesHome:true,derivedOldPwdMatchesTrustedCwd:true};
  const profileFacts={persistentMarkerReadable:false,persistentMarkerUnchanged:true,persistentConfigUnchanged:true,privateHomeWritable:true,privateScratchRemoved:true,workspaceMatchesRecord:true,closedNetworkObserved:true};
  const observe=vi.fn(async({stage,record}:any)=>{expect(stage.invocationId).toBe('e'.repeat(32));expect(stage.controlGroup).toBe('/system.slice/'+stage.unit);expect(record.identity.uid).toBe(1101);return {pid:7777,start:'13',directEnvironmentClean:true,postDrop,profileFacts};});
  (f.deps.manager as any).observeStage=observe;const submit=f.deps.manager.submit;let released=false;f.deps.manager.submit=spec=>{const launched=submit(spec);return {...launched,completion:launched.completion.then((v:any)=>({...v,assertion:{version:1,stage:spec.stage,persistentMarkerReadable:false,privateHomeWritable:true,privateScratchRemoved:true,initialHomeEmpty:true,closedNetworkDenied:true}})),release:()=>{expect(f.record().stages[0].observation).toMatchObject({directEnvironmentClean:true,postDrop});released=true;}};};
  await f.run();expect(observe).toHaveBeenCalledOnce();expect(released).toBe(true);expect(f.record().stages[0].observation.postDrop.uid).toBe(1101);
  const projected=lifetime.qualificationObservations({records:[token],artifactHash:'d'.repeat(64),policyHash:'c'.repeat(64)},f.io);expect(projected).toEqual([{stage:'prepare',profile:'task-only',role:'grok',postDrop,profileFacts,outcome:{phase:'complete',code:0,submitterExited:true,invocationClosed:false}}]);expect(JSON.stringify(projected)).not.toMatch(/pid|start|unit|controlGroup/);
  const completed=f.hold(),failed=f.run('cli');completed.resolve({code:23});await expect(failed).rejects.toThrow();expect(lifetime.qualificationObservations({records:[token],artifactHash:'d'.repeat(64),policyHash:'c'.repeat(64)},f.io).at(-1).outcome).toEqual({phase:'complete',code:23,submitterExited:true,invocationClosed:false});
 }));
 it('does not release payload for invalid trusted evidence',()=>using(async f=>{
  (f.deps.manager as any).observeStage=async()=>({pid:-1,postDrop:{uid:0}});const submit=f.deps.manager.submit;let released=false;f.deps.manager.submit=spec=>({...submit(spec),release:()=>{released=true;}});
  await expect(f.run()).rejects.toThrow();expect(released).toBe(false);expect(f.record().state).toBe('quarantined');
 }));
 it('fixed exec gate consumes only its one line and forwards exact argv/environment via execve',()=>{
  const bytes=Buffer.from('patrick-payload-release\noriginal\nstdin'),calls:any[]=[];let offset=0,executed:any;
  const io={readSync:(_fd:number,b:Buffer,_off:number,length:number)=>{expect(length).toBe(1);if(offset===bytes.length)return 0;b[0]=bytes[offset++]!;return 1;},accessSync:(path:string)=>{calls.push(path);if(path!=='/usr/bin/synthetic-command')throw Error('missing');},constants:{X_OK:1}};
  runInNewContext(lifetime.execGateProgram,{require:(name:string)=>{if(name!=='node:fs')throw Error('unexpected');return io;},Buffer,process:{argv:['node','synthetic-command','literal;$(id)'],env:{HOME:'/synthetic',PATH:'/usr/local/bin:/usr/bin:/bin'},execve:(path:string,args:string[],env:any)=>{executed={path,args,env};},exit:()=>{throw Error('exit');}}});
  expect(executed).toEqual({path:'/usr/bin/synthetic-command',args:['synthetic-command','literal;$(id)'],env:{HOME:'/synthetic',PATH:'/usr/local/bin:/usr/bin:/bin'}});expect(bytes.subarray(offset).toString()).toBe('original\nstdin');
 });
});

describe('supplementary assertions and exec gate failure protocol',()=>{
 it('requires one strict fixed-stage frame and never parses client stderr as authority',()=>{
  const value={version:1,stage:'prepare',persistentMarkerReadable:false,privateHomeWritable:true,privateScratchRemoved:true,initialHomeEmpty:true,closedNetworkDenied:true},frame='patrick-synthetic-observation:'+JSON.stringify(value)+'\n';
  for(const bytes of ['',frame+frame,frame.replace('prepare','tests'),'patrick-synthetic-observation:{"raw":"secret"}\n']){const collector=lifetime.assertionCollector('prepare',()=>{});collector.write(Buffer.from(bytes));expect(collector.finish().invalid).toBe(true);}
  const forwarded:Buffer[]=[],collector=lifetime.assertionCollector('prepare',(b:Buffer)=>forwarded.push(b));collector.write(Buffer.from(frame.slice(0,9)));collector.write(Buffer.from(frame.slice(9)+'ordinary error\n'));expect(collector.finish()).toEqual({assertion:value,invalid:false});expect(Buffer.concat(forwarded).toString()).toBe('ordinary error\n');
  const client:Buffer[]=[],cli=lifetime.assertionCollector('cli',(b:Buffer)=>client.push(b));cli.write(Buffer.from(frame));expect(cli.finish()).toEqual({assertion:null,invalid:false});expect(Buffer.concat(client).toString()).toBe(frame);
 });
 it.each(['','wrong\n','patrick-payload-release\n'])('never execs on EOF, invalid line or unsupported execve %j',bytes=>{
  let offset=0,exits=0,execs=0;const b=Buffer.from(bytes);const processFixture={argv:['node','command'],env:{PATH:'/bin'},execve:bytes==='patrick-payload-release\n'?undefined:()=>execs++,exit:()=>{exits++;throw Error('exit');}};
  expect(()=>runInNewContext(lifetime.execGateProgram,{Buffer,require:()=>({readSync:(_fd:number,out:Buffer)=>{if(offset===b.length)return 0;out[0]=b[offset++]!;return 1;}}),process:processFixture})).toThrow();expect(exits).toBe(1);expect(execs).toBe(0);
 });
});

describe('root kernel boundary parser (synthetic kernel facts only)',()=>{
 function kernelFixture(phase:'direct'|'post'){
  const home='/var/lib/patrick-grok',workspace='/var/lib/patrick-workspaces/'+token+'/work',unit='patrick-worker-'+token+'-1.service',stage={stage:'prepare',profile:'task-only',unit,description:'patrick-worker:'+token+':'+token+':1',invocationId:'e'.repeat(32),controlGroup:'/system.slice/'+unit};
  const record={context:scope,identity:account,admission:{proxyPort:18743,policyHash:'c'.repeat(64),artifactHash:'d'.repeat(64)},layout:{path:workspace,workIno:42}};
  const command=['node','-e',lifetime.guestScripts.prepare,workspace],original=['/usr/local/bin/node',...command.slice(1)],node=['/usr/local/bin/node','--no-addons','--disable-warning=ExperimentalWarning','-e',lifetime.execGateProgram,'--',...original],argv=phase==='direct'?['/usr/bin/dash','-c',lifetime.gateWrapper,'patrick-worker',...node]:node;
  const environment:Record<string,string>={HOME:home,USER:'patrick-grok',LOGNAME:'patrick-grok',PATH:'/usr/local/bin:/usr/bin:/bin',TMPDIR:'/tmp',HTTP_PROXY:'http://127.0.0.1:18743',HTTPS_PROXY:'http://127.0.0.1:18743',NO_PROXY:'',...(phase==='post'?{PWD:home,OLDPWD:'/'}:{})};
  const text:Record<string,string>={'/proc/99/stat':'99 (node) '+['S',...Array(18).fill('0'),'13'].join(' '),'/proc/99/status':['Uid: 1101 1101 1101 1101','Gid: 1101 1101 1101 1101','Groups:','NoNewPrivs: 1',...['CapEff','CapPrm','CapInh','CapAmb','CapBnd'].map(k=>k+': 0000000000000000')].join('\n'),'/proc/99/cgroup':'0::'+stage.controlGroup+'\n','/proc/99/mountinfo':'1 0 0:1 / '+home+' rw - tmpfs tmpfs rw\n','/proc/99/net/route':'Iface Destination\n'};
  const io={readFileSync:(path:string,encoding?:string)=>{let value=path==='/proc/99/cmdline'?argv.join('\0')+'\0':path==='/proc/99/environ'?Object.entries(environment).map(([k,v])=>k+'='+v).join('\0')+'\0':text[path];if(value===undefined)throw Error('unexpected kernel read');return encoding?value:Buffer.from(value);},lstatSync:(path:string)=>{if(path==='/proc/99/root'+home||path==='/proc/99/root'+workspace)return {isDirectory:()=>true,isSymbolicLink:()=>false,uid:1101,gid:1101,mode:0o40700,ino:path.endsWith('/work')?42:43};throw Object.assign(Error('missing'),{code:'ENOENT'});},realpathSync:(path:string)=>path==='/proc/99/exe'?(phase==='direct'?'/usr/bin/dash':'/usr/local/bin/node'):path,readlinkSync:(path:string)=>path==='/proc/99/cwd'?(phase==='direct'?'/':home):path==='/proc/99/ns/net'?'net:[2]':path==='/proc/self/ns/net'?'net:[1]':(()=>{throw Error('unexpected link');})(),readdirSync:()=>[],statfsSync:()=>({type:0x01021994,bsize:4096,blocks:4096,files:1024})};
  const facts={...stage,active:true,empty:false,mainPid:99};return {request:{stage,record,command,phase,witness:phase==='post'?{pid:99,start:'13'}:undefined},deps:{io,unitFacts:()=>facts},environment,text,facts};
 }
 it.each(['direct','post'] as const)('requires actual %s exec-time environment, UID/caps/cgroup and masked HOME namespace facts',phase=>{
  const f=kernelFixture(phase),observed=lifetime.inspectTrustedStage(f.request,f.deps);expect(observed.postDrop).toMatchObject({uid:1101,gid:1101,groups:[],noNewPrivileges:true,homeMatches:true,fixedEnvironmentMatches:true,unknownEnvironmentKeyPresent:false});expect(observed.profileFacts).toMatchObject({persistentMarkerReadable:false,workspaceMatchesRecord:true,closedNetworkObserved:true});
  f.environment.NODE_OPTIONS='raw-secret-never-report';expect(()=>lifetime.inspectTrustedStage(f.request,f.deps)).toThrow();delete f.environment.NODE_OPTIONS;
  f.facts.mainPid=100;expect(()=>lifetime.inspectTrustedStage(f.request,f.deps)).toThrow();
 });
});

it('requires the fixed closed-socket supplementary boolean alongside root namespace evidence',()=>{
 const value={version:1,stage:'tests',persistentMarkerReadable:false,privateHomeWritable:true,privateScratchRemoved:true,initialHomeEmpty:true,closedNetworkDenied:true};const c=lifetime.assertionCollector('tests',()=>{});c.write(Buffer.from('patrick-synthetic-observation:'+JSON.stringify(value)+'\n'));expect(c.finish()).toEqual({assertion:value,invalid:false});expect(lifetime.guestScripts.tests).toContain('closedNetworkDenied');expect(lifetime.guestScripts.tests).toContain('EAFNOSUPPORT');
});

it.skipIf(typeof process.execve!=='function')('uses the real host Node execve to preserve stdin after the fixed second gate (actualGuest=false)',async()=>{
 const payload='original prompt\n{"jsonrpc":"2.0"}\n';const child=spawn(process.execPath,['--no-addons','--disable-warning=ExperimentalWarning','-e',lifetime.execGateProgram,'--',process.execPath,'-e','process.stdin.pipe(process.stdout)'],{env:{PATH:'/usr/bin:/bin'},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);const closed=new Promise(resolve=>child.once('close',code=>resolve(code)));child.stdin.end(lifetime.payloadReleaseLine+payload);expect(await closed).toBe(0);expect(stdout).toBe(payload);expect(stderr).toBe('');
});

it('preserves ordinary fixed-script stderr bytes across large and split UTF-8 chunks while bounding control frames',()=>{
 const value={version:1,stage:'read',persistentMarkerReadable:false,privateHomeWritable:true,privateScratchRemoved:true,initialHomeEmpty:true,closedNetworkDenied:true},frame=Buffer.from('patrick-synthetic-observation:'+JSON.stringify(value)+'\n'),ordinary=Buffer.from('错误'.repeat(10000)+'\nunterminated'),out:Buffer[]=[];const c=lifetime.assertionCollector('read',(b:Buffer)=>out.push(b));c.write(frame.subarray(0,4));c.write(Buffer.concat([frame.subarray(4),ordinary.subarray(0,1)]));c.write(ordinary.subarray(1));expect(c.finish()).toEqual({assertion:value,invalid:false});expect(Buffer.concat(out)).toEqual(ordinary);
});

it('allows exact recorded cleanup through synthetic-session drift but keeps closure and UID reuse quarantined',()=>using(async f=>{
 await f.run();await f.run('cli');await f.run('cli','stop');fs.mkdirSync(f.physical('/etc/patrick-worker'),{recursive:true,mode:0o755});fs.writeFileSync(f.physical('/etc/patrick-worker/qualification.json'),'{}',{mode:0o600});
 await expect(f.run('cleanup')).resolves.toMatchObject({code:0});expect(f.record().cleanupConfirmed).toBe(true);expect(fs.existsSync(f.physical(f.record().layout.path))).toBe(false);expect(await f.run('cleanup','reconcile')).toMatchObject({state:'quarantined',invocationClosed:false});await expect(f.run('prepare','exec','b'.repeat(32))).rejects.toThrow();
}));


describe('durable registered ownership across boot boundaries',()=>{
 it('writes registered2 only at the witnessed durable path',()=>using(async f=>{
  const reference=f.seedAuthority();await f.run();
  const r=JSON.parse(f.io.readFileSync(records+'/'+token+'.json','utf8'));expect(r).toMatchObject({version:2,kind:'registered',authorityId:reference.authorityId,bootRevocation:null});
  expect(f.io.readdirSync('/run/patrick-worker/invocations')).toEqual([]);
 }));
 it('revokes old active ownership without touching a reused manager unit',()=>using(async f=>{
  f.seedAuthority();await f.run();const old=f.record(),inspect=vi.fn(),stop=vi.fn();
  f.setBoot('22222222-2222-4222-8222-222222222222');f.deps.manager.inspect=inspect;f.deps.manager.stop=stop;
  expect(await f.run('cli','stop')).toMatchObject({state:'quarantined',invocationClosed:false});
  expect(f.record()).toMatchObject({boot:old.boot,payloadSealed:true,state:'quarantined',bootRevocation:'22222222-2222-4222-8222-222222222222',cleanupConsumed:false});
  expect(inspect).not.toHaveBeenCalled();expect(stop).not.toHaveBeenCalled();await expect(f.run('cleanup')).rejects.toThrow();
  const bytes=f.io.readFileSync(records+'/'+token+'.json');f.setBoot('33333333-3333-4333-8333-333333333333');await f.run('cli','reconcile');expect(f.io.readFileSync(records+'/'+token+'.json')).toEqual(bytes);
 }));
 it('returns old closed history without manager callbacks or record rewrites',()=>using(async f=>{
  f.seedAuthority();await f.run();await f.run('cli','stop');await f.run('cleanup');await f.run('cleanup','reconcile');
  const path=records+'/'+token+'.json',bytes=f.io.readFileSync(path);f.setBoot('22222222-2222-4222-8222-222222222222');
  f.deps.manager.inspect=vi.fn(()=>{throw Error('reused unit');});f.deps.manager.stop=vi.fn(()=>{throw Error('reused unit');});
  for(const op of ['stop','reconcile'])expect(await f.run('cli',op)).toMatchObject({state:'closed',invocationClosed:true,workspacesAbsent:true});
  expect(f.io.readFileSync(path)).toEqual(bytes);expect(f.deps.manager.inspect).not.toHaveBeenCalled();
 }));
});


it('reinstantiates after runtime loss with retained records and no authority recreation',async()=>{
 const f=fixture();try{
  await f.run();const reference=f.seedAuthority(),old=f.record(),markerBytes=f.io.readFileSync(marker),witnessBytes=f.io.readFileSync(witness);
  fs.rmSync(f.physical('/run/patrick-worker'),{recursive:true});const next=fixture({root:f.root,boot:'22222222-2222-4222-8222-222222222222'});
  expect(fs.existsSync(next.physical('/run/patrick-worker'))).toBe(false);next.deps.manager.inspect=vi.fn(()=>{throw Error('old manager');});next.deps.manager.stop=vi.fn(()=>{throw Error('old manager');});
  expect(await next.run('cli','stop')).toMatchObject({state:'quarantined',reason:'boot_mismatch',invocationClosed:false});
  expect(next.record()).toMatchObject({authorityId:reference.authorityId,boot:old.boot,bootRevocation:'22222222-2222-4222-8222-222222222222'});
  expect(next.io.readFileSync(marker)).toEqual(markerBytes);expect(next.io.readFileSync(witness)).toEqual(witnessBytes);expect(next.io.readdirSync('/run/patrick-worker')).toEqual([]);
  await expect(next.run('cli')).rejects.toThrow();await expect(next.run('cleanup')).rejects.toThrow();expect(next.deps.manager.inspect).not.toHaveBeenCalled();
 }finally{f.close();}
});


describe('recovery binding and terminal preservation',()=>{
 it('keeps historical closure and bytes when current observation fails',()=>using(async f=>{
  await f.run();await f.run('cli','stop');await f.run('cleanup');await f.run('cleanup','reconcile');const bytes=f.io.readFileSync(recordPath);
  f.deps.observe=()=>{throw Error('current facts unavailable');};
  expect(await f.run('cli','stop')).toMatchObject({state:'closed',invocationClosed:true,reason:'unknown',cgroupsEmpty:false,workerProcessesAbsent:false,privateMountsAbsent:false,workspacesAbsent:false});expect(f.io.readFileSync(recordPath)).toEqual(bytes);
 }));
 it('observes historical closure with no old units and a fresh token-root absence check',()=>using(async f=>{
  await f.run();await f.run('cli','stop');await f.run('cleanup');await f.run('cleanup','reconcile');const before=f.io.readFileSync(recordPath),observe=f.deps.observe;
  f.deps.observe=r=>{expect(r?.stages).toEqual([]);return observe(r);};fs.mkdirSync(f.physical(f.record().layout.root),{mode:0o700});
  expect(await f.run('cli','reconcile')).toMatchObject({state:'closed',invocationClosed:true,reason:'unknown',workspacesAbsent:false});expect(f.io.readFileSync(recordPath)).toEqual(before);
 }));
 it.each(['identity','authority'])('rechecks %s under the selected UID mutex before admission',kind=>using(async f=>{
  const recover=f.deps.recover;let reads=0;f.deps.recover=async c=>{const value=await recover(c);if(++reads===2){if(kind==='identity')value.identity={...value.identity,uid:1201,gid:1201};else value.registry={...value.registry,authorityId:'f'.repeat(32)};}return value;};
  await expect(f.run()).rejects.toThrow();expect(reads).toBe(2);expect(f.submissions).toEqual([]);expect(f.events).not.toContain('admit');expect(f.io.readdirSync(records)).toEqual(['.authority.json']);
 }));
 it('never recreates runtime after durable identity loss',()=>using(async f=>{
  const reference=f.seedAuthority();fs.rmSync(f.physical('/run/patrick-worker'),{recursive:true});f.io.unlinkSync(witness);
  expect(()=>lifetime.ensureRuntimeBase(f.deps,reference)).toThrow();expect(fs.existsSync(f.physical('/run/patrick-worker'))).toBe(false);expect(await f.run('cli','stop')).toMatchObject({reason:'control_unavailable',invocationClosed:false});
 }));
 it('checks referenced terminal records without treating missing history or arbitrary token sets as closure',()=>using(async f=>{
  const reference=f.seedAuthority();expect(lifetime.registryRecordsClosed(f.io,reference,[])).toBe(true);expect(lifetime.registryRecordsClosed(f.io,reference,[token])).toBe(false);
  await f.run();expect(lifetime.registryRecordsClosed(f.io,reference,[token])).toBe(false);await f.run('cli','stop');await f.run('cleanup');await f.run('cleanup','reconcile');expect(lifetime.registryRecordsClosed(f.io,reference,[token])).toBe(true);
  for(const values of [[token,token],['invalid'],Array.from({length:65},(_,n)=>n.toString(16).padStart(32,'0'))])expect(()=>lifetime.registryRecordsClosed(f.io,reference,values)).toThrow();
  const r=f.record();r.authorityId='f'.repeat(32);f.io.writeFileSync(recordPath,JSON.stringify(r));expect(lifetime.registryRecordsClosed(f.io,reference,[token])).toBe(false);
 }));
});


describe('durable pre-registration denial and control IPC2',()=>{
 it('stop before prepare registration durably denies only that token',()=>using(async f=>{
  const global=f.physical('/run/patrick-worker/install.lock');fs.mkdirSync(global,{mode:0o700});
  const late=f.run().catch(error=>error);await f.waitFor('mkdir-attempt:/run/patrick-worker/install.lock');
  try{
   expect(await f.run('cleanup','stop')).toMatchObject({version:2,kind:'denial-only',state:'denied',closure:'never-registered',invocationClosed:true,reason:'ok'});
  }finally{fs.rmdirSync(global);await late;}
  expect(await late).toBeInstanceOf(Error);expect(f.submissions).toEqual([]);
  const record=f.record();expect(record.kind).toBe('denial-only');
  for(const key of ['generation','stages','layout','drain','cleanupConsumed','cleanupConfirmed'])expect(Object.hasOwn(record,key)).toBe(false);
  for(const stage of ['prepare','cli','acp','read','tests','cleanup'])await expect(f.run(stage)).rejects.toThrow();
  await expect(f.run('prepare','exec','b'.repeat(32))).resolves.toMatchObject({code:0});
 }));
 it('prepare registration owns the token before ACK while stop waits on the real UID lock',()=>using(async f=>{
  const done=f.hold(),ack=f.ack(),prepare=f.run().catch(error=>error);await f.waitFor('ack-wait');
  expect(f.record()).toMatchObject({kind:'registered',stages:[{phase:'pending'}]});
  let stopped=false;const stopping=f.run('cleanup','stop').then(value=>{stopped=true;return value;});await f.waitFor('mkdir-attempt:/run/patrick-worker/uid-1101.lock',2);
  expect(stopped).toBe(false);expect(f.record().kind).toBe('registered');ack.resolve(undefined);
  expect(await stopping).toMatchObject({version:2,kind:'registered',state:'drained',closure:'none',invocationClosed:false});done.resolve({code:0});await prepare;
 }));
 it('absent reconcile writes nothing; stop and repeat controls retain a byte-preserving denial across boots',()=>using(async f=>{
  expect(await f.run('cleanup','reconcile')).toEqual({version:2,kind:'unknown',state:'quarantined',closure:'none',invocationClosed:false,reason:'unknown',cgroupsEmpty:false,workerProcessesAbsent:false,workspacesAbsent:false,privateMountsAbsent:false});
  expect(f.io.readdirSync(records)).toEqual(['.authority.json']);
  expect(await f.run('cleanup','stop')).toMatchObject({kind:'denial-only',reason:'ok'});const bytes=f.io.readFileSync(recordPath);
  f.setBoot('22222222-2222-4222-8222-222222222222');f.deps.manager.inspect=vi.fn(()=>{throw Error('no stage authority');});f.deps.manager.stop=vi.fn(()=>{throw Error('no stage authority');});
  for(const operation of ['stop','reconcile'])expect(await f.run('cleanup',operation)).toMatchObject({version:2,kind:'denial-only',state:'denied',closure:'never-registered',reason:'ok'});
  expect(f.io.readFileSync(recordPath)).toEqual(bytes);expect(lifetime.registryQuiescent(f.io)).toBe(true);expect(lifetime.registryRecordsClosed(f.io,f.seedAuthority(),[token])).toBe(true);
 }));
 it('denial observes the token root and leaves unrelated work and residuals untouched',()=>using(async f=>{
  await f.run();f.setObserved({cgroupsEmpty:false,workerProcessesAbsent:false});
  const other='b'.repeat(32);expect(await f.run('cleanup','stop',other)).toMatchObject({kind:'denial-only',invocationClosed:true,reason:'unknown',cgroupsEmpty:false,workerProcessesAbsent:false});expect(f.stops).toEqual([]);expect(f.record().state).toBe('active');
  const root='/var/lib/patrick-workspaces/'+other;fs.mkdirSync(f.physical(root),{mode:0o700});f.io.chownSync(root,account.uid,account.gid);f.setObserved({cgroupsEmpty:true,workerProcessesAbsent:true});
  expect(await f.run('cleanup','reconcile',other)).toMatchObject({kind:'denial-only',reason:'workspace_residual',workspacesAbsent:false});expect(fs.existsSync(f.physical(root))).toBe(true);expect(f.submissions).toHaveLength(1);
 }));
 it('never mutates a denial through foreign scope, account, malformed record or withdrawn cancellation authority',()=>using(async f=>{
  const recover=f.deps.recover;f.deps.recover=async c=>({...await recover(c),cancellationBinding:null});
  expect(await f.run('cleanup','stop')).toMatchObject({kind:'unknown',invocationClosed:false});expect(f.io.readdirSync(records)).toEqual(['.authority.json']);f.deps.recover=recover;
  await f.run('cleanup','stop');const bytes=f.io.readFileSync(recordPath);
  expect(await f.run('cleanup','stop',token,{...scope,domain:'foreign'})).toMatchObject({kind:'unknown',invocationClosed:false});
  f.setIdentity(false);expect(await f.run('cleanup','reconcile')).toMatchObject({kind:'unknown',invocationClosed:false});f.setIdentity(true);expect(f.io.readFileSync(recordPath)).toEqual(bytes);
  const denial=f.record();for(const key of ['layout','stages','generation','drain','cleanupConsumed']){f.io.writeFileSync(recordPath,JSON.stringify({...denial,[key]:null})+'\n');expect(()=>lifetime.registryQuiescent(f.io)).toThrow();}f.io.writeFileSync(recordPath,bytes);
 }));
 it.each(['write','file-fsync','directory-fsync'])('denial %s failure never confirms closure and retains UID lock',fault=>using(async f=>{
  const open=f.io.openSync,write=f.io.writeFileSync,sync=f.io.fsyncSync,paths=new Map<number,string>();let tripped=false;
  f.io.openSync=(p,...args)=>{const fd=open(p,...args);paths.set(fd,p);return fd;};
  f.io.writeFileSync=(p,...args)=>{if(!tripped&&fault==='write'&&typeof p==='number'&&paths.get(p)?.startsWith(records+'/.write-')){tripped=true;throw Error('write failed');}return write(p,...args);};
  f.io.fsyncSync=fd=>{const p=paths.get(fd);if(!tripped&&(fault==='file-fsync'&&p?.startsWith(records+'/.write-')||fault==='directory-fsync'&&p===records)){tripped=true;throw Error('fsync failed');}sync(fd);};
  expect(await f.run('cleanup','stop')).toMatchObject({version:2,kind:'unknown',reason:'control_unavailable',invocationClosed:false});expect(tripped).toBe(true);expect(fs.existsSync(f.physical('/run/patrick-worker/uid-1101.lock'))).toBe(true);expect(f.submissions).toEqual([]);
 }));
 it('re-reads a no-replace cross-UID winner without quarantining or replacing its bytes',()=>using(async f=>{
  const link=f.io.linkSync;let winner:Buffer|undefined;f.io.linkSync=(from,to)=>{if(to===recordPath&&!winner){const r=JSON.parse(f.io.readFileSync(from,'utf8'));r.identity={uid:1201,gid:1201,home:'/var/lib/patrick-codex'};r.context={...r.context,runner:'codex',user:'patrick-codex'};winner=Buffer.from(JSON.stringify(r)+'\n');f.io.writeFileSync(to,winner,{mode:0o600});}link(from,to);};
  expect(await f.run('cleanup','stop')).toMatchObject({kind:'unknown',invocationClosed:false});expect(f.io.readFileSync(recordPath)).toEqual(winner);expect(fs.existsSync(f.physical('/run/patrick-worker/uid-1101.lock'))).toBe(false);expect(f.submissions).toEqual([]);
 }));
});


it('keeps denial closure historical while fresh observer, root metadata and current binding fail closed',()=>using(async f=>{
 await f.run('cleanup','stop');const bytes=f.io.readFileSync(recordPath),observe=f.deps.observe;
 f.deps.observe=()=>{throw Error('observer unavailable');};expect(await f.run('cleanup','reconcile')).toMatchObject({kind:'denial-only',invocationClosed:true,reason:'unknown',cgroupsEmpty:false,workerProcessesAbsent:false,privateMountsAbsent:false,workspacesAbsent:false});f.deps.observe=observe;
 const root='/var/lib/patrick-workspaces/'+token;fs.symlinkSync(f.physical(account.home),f.physical(root));expect(await f.run('cleanup','reconcile')).toMatchObject({kind:'denial-only',reason:'unknown',workspacesAbsent:false});fs.unlinkSync(f.physical(root));
 fs.mkdirSync(f.physical(root),{mode:0o700});expect(await f.run('cleanup','reconcile')).toMatchObject({kind:'denial-only',reason:'unknown',workspacesAbsent:false});fs.rmdirSync(f.physical(root));
 const lstat=f.io.lstatSync;f.io.lstatSync=p=>{if(p===root)throw Object.assign(Error('unreadable root'),{code:'EACCES'});return lstat(p);};expect(await f.run('cleanup','reconcile')).toMatchObject({kind:'denial-only',reason:'unknown',workspacesAbsent:false});f.io.lstatSync=lstat;
 const recover=f.deps.recover;f.deps.recover=async c=>({...await recover(c),cancellationBinding:null});expect(await f.run('cleanup','stop')).toMatchObject({kind:'denial-only',reason:'ok'});expect(f.io.readFileSync(recordPath)).toEqual(bytes);
}));
it.each(['missing-witness','bad-marker','foreign-record','unknown-file'])('never mints absent denial through %s registry uncertainty',kind=>using(async f=>{
 if(kind==='missing-witness')f.io.unlinkSync(witness);if(kind==='bad-marker')f.io.writeFileSync(marker,'{}\n');
 if(kind==='unknown-file')f.io.writeFileSync(records+'/unowned','preserve');
 if(kind==='foreign-record'){await f.run('cleanup','stop','b'.repeat(32));const other=records+'/'+'b'.repeat(32)+'.json',r=JSON.parse(f.io.readFileSync(other,'utf8'));r.authorityId='f'.repeat(32);f.io.writeFileSync(other,JSON.stringify(r)+'\n');}
 expect(await f.run('cleanup','stop')).toMatchObject({kind:'unknown',invocationClosed:false});expect(fs.existsSync(f.physical(recordPath))).toBe(false);expect(f.submissions).toEqual([]);
}));
it('keeps exact record131072 readable and rejects131073; padded marker4096 and4097 never become authority',()=>using(async f=>{
 await f.run('cleanup','stop');const r=f.record(),base=Buffer.byteLength(JSON.stringify(r)+'\n');r.context.projectId+='x'.repeat(131072-base);const bytes=Buffer.from(JSON.stringify(r)+'\n');expect(bytes.length).toBe(131072);f.io.writeFileSync(recordPath,bytes);expect(lifetime.registryQuiescent(f.io)).toBe(true);
 f.io.writeFileSync(recordPath,Buffer.concat([bytes,Buffer.from(' ')]));expect(()=>lifetime.registryQuiescent(f.io)).toThrow();
 const original=f.io.readFileSync(marker);for(const size of [4096,4097]){f.io.writeFileSync(marker,Buffer.concat([original,Buffer.alloc(size-original.length,32)]));expect(()=>lifetime.readRegistryAuthority(f.io)).toThrow();}f.io.writeFileSync(marker,original);
}));


it.each(['denial','closed'])('refuses fresh workspace absence through an untrusted workspace base for %s history',kind=>using(async f=>{
 if(kind==='denial')await f.run('cleanup','stop');else{await f.run();await f.run('cleanup','stop');await f.run('cleanup');await f.run('cleanup','reconcile');}
 const bytes=f.io.readFileSync(recordPath),base='/var/lib/patrick-workspaces';fs.renameSync(f.physical(base),f.physical(base+'.saved'));fs.symlinkSync(f.physical(account.home),f.physical(base));
 expect(await f.run('cleanup','reconcile')).toMatchObject({invocationClosed:true,reason:'unknown',workspacesAbsent:false});expect(f.io.readFileSync(recordPath)).toEqual(bytes);
}));
it.each(['denial','closed'])('refuses writable workspace-base metadata for %s history',kind=>using(async f=>{
 if(kind==='denial')await f.run('cleanup','stop');else{await f.run();await f.run('cleanup','stop');await f.run('cleanup');await f.run('cleanup','reconcile');}
 const bytes=f.io.readFileSync(recordPath),base='/var/lib/patrick-workspaces';
 const inode=f.io.lstatSync(recordPath).ino;
 for(const mode of [0o777,0o770,0o707]){
  fs.chmodSync(f.physical(base),mode);
  for(const operation of ['stop','reconcile'] as const){
   expect(await f.run('cleanup',operation)).toMatchObject({invocationClosed:true,reason:'unknown',workspacesAbsent:false});
   expect(f.io.readFileSync(recordPath)).toEqual(bytes);
   expect(f.io.lstatSync(recordPath).ino).toBe(inode);
   expect(f.io.lstatSync(base).mode&0o7777).toBe(mode);
  }
 }
 fs.chmodSync(f.physical(base),0o750);
 expect(await f.run('cleanup','reconcile')).toMatchObject({invocationClosed:true,reason:'ok',workspacesAbsent:true});
 expect(f.io.readFileSync(recordPath)).toEqual(bytes);
}));
