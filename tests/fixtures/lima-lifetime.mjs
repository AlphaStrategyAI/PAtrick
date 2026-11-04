// Shared bounded filesystem and controlled manager fixture; never production authority.
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import * as lifetime from '../../scripts/lima/stage-lifetime.mjs';
const token='a'.repeat(32),defaultScope={runner:'grok',user:'patrick-grok',projectId:'fixture',domain:'personal'},defaultAccount={uid:1101,gid:1101,home:'/var/lib/patrick-grok',groups:[]};
function deferred() {let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
export function fixture(options={}) {
 const scope=options.scope??defaultScope,account=options.account??defaultAccount;
 const root=fs.realpathSync(options.root??fs.mkdtempSync(join(tmpdir(),'patrick-lifetime-'))),fresh=!fs.existsSync(join(root,'owners.json')),fds=new Map(),events=[],waiters=new Map();
 const event=value=>{events.push(value);for(const waiter of waiters.get(value)??[])if(events.filter(e=>e===value).length>=waiter.occurrence)waiter.resolve();};
 const waitFor=(value,occurrence=1)=>events.filter(e=>e===value).length>=occurrence?Promise.resolve():new Promise(resolve=>waiters.set(value,[...(waiters.get(value)??[]),{resolve,occurrence}]));
 const storedMap=name=>options.root?{get:key=>JSON.parse(fs.readFileSync(join(root,name),'utf8'))[key],set:(key,value)=>{const file=join(root,name),data=JSON.parse(fs.readFileSync(file,'utf8'));data[key]=value;fs.writeFileSync(file,JSON.stringify(data));},delete:key=>{const file=join(root,name),data=JSON.parse(fs.readFileSync(file,'utf8'));delete data[key];fs.writeFileSync(file,JSON.stringify(data));}}:new Map();
 for(const name of ['owners.json','units.json'])if(!fs.existsSync(join(root,name)))fs.writeFileSync(join(root,name),'{}',{mode:0o600});
 const owners=storedMap('owners.json');
 const physical=(p)=>{if(typeof p!=='string'||!p.startsWith('/')||p.includes('..'))throw Error('outside fixture');return root+(p==='/'?'':p);};
 const info=(p,st)=>Object.assign(Object.create(st),{uid:owners.get(p)?.uid??0,gid:owners.get(p)?.gid??0});
 const descriptor=fd=>{const value=fds.get(fd);if(!value)throw Error('foreign fd');return value;};
 const io={readSync:(fd,...args)=>{descriptor(fd);return fs.readSync(fd,...args);},lstatSync:(p)=>info(p,fs.lstatSync(physical(p))),readdirSync:(p)=>fs.readdirSync(physical(p)),opendirSync:(p,o)=>fs.opendirSync(physical(p),o),readFileSync:(p,...a)=>{if(typeof p==='number')descriptor(p);return fs.readFileSync(typeof p==='number'?p:physical(p),...a);},openSync:(p,...a)=>{const fd=fs.openSync(physical(p),...a);fds.set(fd,{path:p,owner:owners.get(p)??{uid:0,gid:0}});events.push('open:'+p);return fd;},fstatSync:(fd)=>{const value=descriptor(fd);return Object.assign(Object.create(fs.fstatSync(fd)),value.owner);},writeFileSync:(p,...a)=>{if(typeof p==='number'){descriptor(p);return fs.writeFileSync(p,...a);}return fs.writeFileSync(physical(p),...a);},fsyncSync:(fd)=>{const value=descriptor(fd);fs.fsyncSync(fd);events.push('fsync:'+value.path);},fchmodSync:(fd,m)=>{descriptor(fd);fs.fchmodSync(fd,m);},closeSync:(fd)=>{descriptor(fd);fs.closeSync(fd);fds.delete(fd);},mkdirSync:(p,o)=>{event('mkdir-attempt:'+p);return fs.mkdirSync(physical(p),o);},chmodSync:(p,m)=>fs.chmodSync(physical(p),m),chownSync:(p,uid,gid)=>owners.set(p,{uid,gid}),linkSync:(a,b)=>{fs.linkSync(physical(a),physical(b));const owner=owners.get(a)??{uid:0,gid:0};owners.set(b,{uid:owner.uid,gid:owner.gid});events.push('link:'+a+'->'+b);},renameSync:(a,b)=>{fs.renameSync(physical(a),physical(b));owners.set(b,owners.get(a)??{uid:0,gid:0});owners.delete(a);events.push('rename:'+a+'->'+b);},unlinkSync:(p)=>{fs.unlinkSync(physical(p));owners.delete(p);events.push('unlink:'+p);},rmdirSync:(p)=>fs.rmdirSync(physical(p))};
 for(const p of fresh?['/run/patrick-worker/invocations','/var/lib/patrick-workspaces',account.home]:[])fs.mkdirSync(physical(p),{recursive:true,mode:0o700});
 if(fresh){fs.chmodSync(root,0o755);for(const p of ['/run','/var','/var/lib'])fs.chmodSync(physical(p),0o755);}
 const units=storedMap('units.json'),submissions=[],stops=[];
 let admission='ok',identity=true,observed={workerProcessesAbsent:true,privateMountsAbsent:true,cgroupsEmpty:true},hold,ack,boot=options.boot??'11111111-1111-4111-8111-111111111111';
 const deps={io,effectiveUid:()=>0,trust:()=>{},boot:()=>boot,witness:()=>({pid:5678,start:'9'}),lockTimeoutMs:100,
 identity:()=>{if(!identity)throw Error('alias');return account;},
 admit:async(context,command)=>{events.push('admit');if(admission==='withdrawn'||admission==='proxy'||admission==='nft')throw Error('not ready');return {entry:{...context,...account,proxyPort:18081,command},policyHash:(admission==='policy'?'b':'c').repeat(64),artifactHash:(admission==='artifact'?'b':'d').repeat(64)};},
 observe:()=>({...observed}),manager:{
 submit:(spec)=>{submissions.push(spec);events.push('submit');const item={description:spec.description,invocationId:'e'.repeat(32),controlGroup:'/system.slice/'+spec.unit,active:true,empty:false,pending:false};units.set(spec.unit,item);event('submitted:'+spec.stage);const completion=hold?.promise??Promise.resolve({code:0});return {completion:completion.then(value=>{item.active=false;item.empty=true;units.set(spec.unit,item);if(spec.stage==='cleanup')fs.rmSync(physical(spec.workspace),{recursive:true,force:true});return value;})};},
 acknowledge:async(unit)=>{event('ack-wait');if(ack)await ack.promise;return units.get(unit)??null;},inspect:async(unit)=>units.get(unit)??null,
 settled:async(s)=>s.submitterExited,stop:async(unit)=>{stops.push(unit);const item=units.get(unit);if(item){item.active=false;item.empty=true;units.set(unit,item);}},pending:async()=>false,
 }};
 const request=(stage='prepare',operation='exec',invocation=token,context=scope)=>({context,lifetime:{invocation,stage,operation,profile:['cli','acp'].includes(stage)?'authenticated-client':'task-only'},command:operation!=='exec'?[]:stage==='acp'?['fixture-dsh','--acp']:stage==='cli'?['sh','-c',lifetime.cliWrapper,'patrick',`/var/lib/patrick-workspaces/${invocation}/work`,'fixture-cli','literal;$(id)']:['node','-e',lifetime.guestScripts[stage],`/var/lib/patrick-workspaces/${invocation}/work`]});
 const run=(stage='prepare',operation='exec',invocation=token,context=scope)=>lifetime.executeStage(request(stage,operation,invocation,context),deps);
 const record=(invocation=token)=>JSON.parse(fs.readFileSync(physical(`/var/lib/patrick-worker/invocations/${invocation}.json`),'utf8'));
 const seedAuthority=()=>{
  const durable='/var/lib/patrick-worker',registry=durable+'/invocations',witness='/etc/patrick-worker/registry-identity.json';
  if(fs.existsSync(physical(witness))){const {version,authorityId,witnessHash}=lifetime.readRegistryAuthority(io);return {version,authorityId,witnessHash};}
  for(const p of [durable,registry,'/etc/patrick-worker'])fs.mkdirSync(physical(p),{recursive:true,mode:0o700});
  fs.chmodSync(physical('/etc'),0o755);
  const node=p=>{const s=io.lstatSync(p);return {dev:s.dev,ino:s.ino};},authorityId=randomBytes(16).toString('hex');
  const marker={version:1,authorityId,root:node(durable),records:node(registry)},markerBytes=lifetime.encodeRegistryMetadata(marker),markerPath=registry+'/.authority.json';
  io.writeFileSync(markerPath,markerBytes,{mode:0o600});
  const ready={version:1,phase:'ready',authorityId,initializedBy:{artifactHash:'d'.repeat(64),policyHash:'c'.repeat(64),boot},root:marker.root,records:marker.records,marker:{...node(markerPath),hash:createHash('sha256').update(markerBytes).digest('hex')}};
  const bytes=lifetime.encodeRegistryMetadata(ready);io.writeFileSync(witness,bytes,{mode:0o600});
  return {version:1,authorityId,witnessHash:createHash('sha256').update(bytes.subarray(0,-1)).digest('hex')};
 };
 const registry=fresh?seedAuthority():(()=>{const {version,authorityId,witnessHash}=lifetime.readRegistryAuthority(io);return {version,authorityId,witnessHash};})();
 deps.recover=async()=>({registry,identity:deps.identity(),cancellationBinding:{policyHash:'c'.repeat(64),artifactHash:'d'.repeat(64)}});
 return {root,io,deps,physical,run,request,record,submissions,stops,events,units,waitFor,seedAuthority,setBoot:(id)=>boot=id,setAdmission:(v)=>admission=v,setIdentity:(v)=>identity=v,setObserved:(v)=>observed={...observed,...v},hold:()=>hold=deferred(),ack:()=>ack=deferred(),close:()=>fs.rmSync(root,{recursive:true,force:true})};
}
