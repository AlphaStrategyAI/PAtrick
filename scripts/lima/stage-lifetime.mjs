// Fixed stage programs and root lifetime controller. Importing this file has no
// filesystem/process side effects; privileged callers trust it before import.
import * as fs from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const prepareScript=String.raw`
const fs=require('node:fs'),path=require('node:path');
let raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{
 try {
  const mounts=fs.readFileSync('/proc/mounts','utf8');
  if (/virtiofs|\s9p\s|\/Users\//.test(mounts)||process.env.SSH_AUTH_SOCK) throw new Error('Unapproved host mounts or agent forwarding');
  const p=JSON.parse(raw),dir=process.argv[1];if(!/^\/var\/lib\/patrick-workspaces\/[a-f0-9]{32}\/work$/.test(dir))throw Error('Unsafe workspace');
  fs.writeFileSync(path.join(dir,'schema.json'),JSON.stringify(p.schema));fs.writeFileSync(path.join(dir,'prompt.txt'),p.prompt);
  for(const file of p.files){if(!file.path||path.isAbsolute(file.path)||file.path.split('/').some(x=>x==='..'||x==='.git'))throw new Error('Unsafe file');const dest=path.join(dir,file.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,file.content);}
  process.stdout.write(JSON.stringify({dir}));
 }catch(e){process.exitCode=78;}
});`;
const testsScript=String.raw`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');let raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{
 try {const p=JSON.parse(raw),dir=process.argv[1];if(!/^\/var\/lib\/patrick-workspaces\/[a-f0-9]{32}\/work$/.test(dir))throw Error('Unsafe workspace');
 for(const f of p.files){const dest=path.resolve(dir,f.path);if(!dest.startsWith(dir+'/')||f.path.split('/').includes('.git'))throw Error('Unsafe file');fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,f.content);}
 const tests=p.commands.map(command=>{const r=cp.spawnSync('/bin/sh',['-c',command],{cwd:dir,timeout:60000,maxBuffer:256000,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:dir}});return {command,passed:r.status===0&&!r.error,output:((r.stdout||'').toString()+(r.stderr||'').toString()).slice(-12000)||('exit '+r.status)};});process.stdout.write(JSON.stringify(tests));
 }catch(e){process.exitCode=78;}
});`;
const readScript=String.raw`const fs=require('node:fs'),d=process.argv[1];if(!/^\/var\/lib\/patrick-workspaces\/[a-f0-9]{32}\/work$/.test(d))process.exit(78);process.stdout.write(fs.readFileSync(d+'/result.json','utf8'));`;
const cleanupScript=String.raw`const fs=require('node:fs');const d=process.argv[1];if(!/^\/var\/lib\/patrick-workspaces\/[a-f0-9]{32}\/work$/.test(d))process.exit(78);fs.rmSync(d,{recursive:true,force:true});`;
const taskGuard=String.raw`{
 const f=require('node:fs'),h=process.env.HOME,u=process.getuid(),g=process.getgid();
 try {
  if(!/^\/var\/lib\/patrick-[a-z][a-z0-9-]{0,23}$/.test(h)||u<1000||process.geteuid()!==u||g<1000||process.getegid()!==g||process.getgroups().length)throw 0;
  const st=f.lstatSync(h),v=f.statfsSync(h),mounts=f.readFileSync('/proc/self/mountinfo','utf8').trim().split('\n').map(l=>l.split(' - '));
  if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==u||st.gid!==g||(st.mode&0o777)!==0o700||v.type!==0x01021994||v.bsize*v.blocks>16*1024*1024||v.files>1024||mounts.filter(m=>m[0].split(' ')[4]===h&&m[1].split(' ')[0]==='tmpfs').length!==1)throw 0;
  const status=f.readFileSync('/proc/self/status','utf8');for(const key of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']){const rows=status.split('\n').filter(l=>l.startsWith(key+':'));if(rows.length!==1||!/^0{1,32}$/.test(rows[0].slice(key.length+1).trim()))throw 0;}
  if(!/^NoNewPrivs:\s+1$/m.test(status)||f.readFileSync('/proc/net/route','utf8').trim().split('\n').length!==1)throw 0;
  for(const fd of f.readdirSync('/proc/self/fd')){let target;try{target=f.readlinkSync('/proc/self/fd/'+fd);}catch(e){if(e.code==='ENOENT')continue;throw e;}if(target===h||target.startsWith(h+'/'))throw 0;}
 }catch{process.exit(78);}
}
`;
const closedSocketProgram=String.raw`const net=require('node:net');try{const m=/^http:\/\/127\.0\.0\.1:([0-9]{1,5})$/.exec(process.argv[1]);if(!m)process.exit(78);Promise.all([["127.0.0.1",Number(m[1])],["93.184.216.34",443]].map(([host,port])=>new Promise(resolve=>{let socket;try{socket=net.createConnection({host,port});}catch(e){resolve(['EAFNOSUPPORT','EACCES','EPERM','ENETUNREACH'].includes(e.code));return;}const timer=setTimeout(()=>{socket.destroy();resolve(false);},500);socket.once('connect',()=>{clearTimeout(timer);socket.destroy();resolve(false);});socket.once('error',e=>{clearTimeout(timer);resolve(['EAFNOSUPPORT','EACCES','EPERM','ENETUNREACH'].includes(e.code));});}))).then(results=>process.exit(results.every(Boolean)?0:78),()=>process.exit(78));}catch{process.exit(78);}`;
const syntheticAssertions=stage=>String.raw`{
 const f=require('node:fs'),h=process.env.HOME,names=['.patrick-synthetic-auth','.patrick-synthetic-config'];
 let persistentMarkerReadable=false,privateHomeWritable=false,privateScratchRemoved=false,initialHomeEmpty=false,closedNetworkDenied=false;
 try{initialHomeEmpty=f.readdirSync(h).length===0;for(const n of names){try{f.readFileSync(h+'/'+n);persistentMarkerReadable=true;}catch(e){if(!['ENOENT','EACCES'].includes(e.code))throw e;}f.writeFileSync(h+'/'+n,'synthetic-poison',{flag:'wx'});f.unlinkSync(h+'/'+n);}const scratch=h+'/.patrick-synthetic-scratch';f.writeFileSync(scratch,'synthetic',{flag:'wx'});privateHomeWritable=true;f.unlinkSync(scratch);privateScratchRemoved=!f.existsSync(scratch);}catch{}
 try{const c=require('node:child_process').spawnSync('/usr/local/bin/node',['--no-addons','-e',${JSON.stringify(closedSocketProgram)},process.env.HTTP_PROXY],{timeout:1000,maxBuffer:1024,stdio:'ignore',env:{PATH:process.env.PATH,HOME:h}});closedNetworkDenied=c.status===0&&!c.signal&&!c.error;}catch{}
 process.stderr.write('patrick-synthetic-observation:'+JSON.stringify({version:1,stage:'${stage}',persistentMarkerReadable,privateHomeWritable,privateScratchRemoved,initialHomeEmpty,closedNetworkDenied})+'\n');
 if(persistentMarkerReadable||!privateHomeWritable||!privateScratchRemoved||!initialHomeEmpty||!closedNetworkDenied)process.exit(78);
}
`;
export const guestScripts=Object.freeze({prepare:taskGuard+syntheticAssertions('prepare')+prepareScript,tests:taskGuard+syntheticAssertions('tests')+testsScript,read:taskGuard+syntheticAssertions('read')+readScript,cleanup:taskGuard+syntheticAssertions('cleanup')+cleanupScript});

export const cliWrapper='cd "$1" && shift && exec "$@"';
export const releaseLine='patrick-stage-release\n';
export const payloadReleaseLine='patrick-payload-release\n';
export const execGateProgram=String.raw`const fs=require('node:fs');try{if(typeof process.execve!=='function')throw 0;const b=Buffer.alloc(1);let line='';for(;;){if(fs.readSync(0,b,0,1,null)!==1)throw 0;line+=b.toString();if(line.length>64)throw 0;if(b[0]===10)break;}if(line!=='patrick-payload-release\n')throw 0;const args=process.argv.slice(1);if(!args.length||!args[0])throw 0;let executable=args[0];if(!executable.includes('/')){executable=process.env.PATH.split(':').map(d=>d+'/'+args[0]).find(p=>{try{fs.accessSync(p,fs.constants.X_OK);return true;}catch{return false;}});if(!executable)throw 0;}process.execve(executable,args,process.env);}catch{process.exit(78);}`;
export const gateWrapper='IFS= read -r patrick_gate && [ "$patrick_gate" = "patrick-stage-release" ] && cd -- "$HOME" && exec "$@"';
const BASE='/run/patrick-worker',DURABLE='/var/lib/patrick-worker',REGISTRY=DURABLE+'/invocations',LEGACY=BASE+'/invocations',ROOT='/var/lib/patrick-workspaces';
const MARKER=REGISTRY+'/.authority.json',WITNESS='/etc/patrick-worker/registry-identity.json';
const stages=['prepare','cli','read','tests','cleanup','acp'],states=['active','stopping','drained','cleaning','closed','quarantined'];
const bootValid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const token=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value),digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=()=>{throw new Error('Worker entry denied.');};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const numeric=n=>Number.isSafeInteger(n)&&n>=1000&&n<=2147483647;
const exists=(path,io)=>{try{io.lstatSync(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
export function profileFor(stage){if(!stages.includes(stage))fail();return ['cli','acp'].includes(stage)?'authenticated-client':'task-only';}
function contextValid(c){return exact(c,['runner','user','projectId','domain'])&&['grok','codex','dsh'].includes(c.runner)&&/^patrick-[a-z][a-z0-9-]{0,23}$/.test(c.user)&&/^[a-zA-Z0-9_-]+$/.test(c.projectId)&&typeof c.domain==='string'&&c.domain.length>0&&Buffer.byteLength(c.domain)<=1024&&!c.domain.includes('\0')&&c.domain.isWellFormed();}
function identityValid(context,a){return a&&numeric(a.uid)&&numeric(a.gid)&&a.home===`/var/lib/${context.user}`&&Array.isArray(a.groups)&&a.groups.length===0;}
function requestValid(r){if(!exact(r,['context','lifetime','command'])||!contextValid(r.context)||!exact(r.lifetime,['invocation','stage','profile','operation'])||!token(r.lifetime.invocation)||!stages.includes(r.lifetime.stage)||r.lifetime.profile!==profileFor(r.lifetime.stage)||!['exec','stop','reconcile'].includes(r.lifetime.operation)||!Array.isArray(r.command))fail();if(r.lifetime.operation!=='exec'&&r.command.length)fail();}
function trustPath(path,io,{uid=0,gid,mode,kind='directory'}={}){
 if(typeof path!=='string'||!path.startsWith('/')||path.includes('\0')||path.split('/').includes('..'))fail();
 let entry;for(let p=path;;p=dirname(p)){const s=io.lstatSync(p),leaf=p===path;if(s.isSymbolicLink()||s.uid!==(leaf?uid:0)||(leaf?kind==='directory'?!s.isDirectory():!s.isFile():!s.isDirectory())||(leaf&&gid!==undefined&&s.gid!==gid)||(leaf&&mode!==undefined&&(s.mode&0o7777)!==mode)||(!leaf&&(s.mode&0o022)))fail();if(leaf)entry=s;if(p==='/')break;}return entry;
}
const nodeIdentity=s=>({dev:s.dev,ino:s.ino});
const nodeValid=v=>exact(v,['dev','ino'])&&Number.isSafeInteger(v.dev)&&v.dev>=0&&!Object.is(v.dev,-0)&&Number.isSafeInteger(v.ino)&&v.ino>0;
const nodeSame=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
function fileValid(s,limit){if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||s.gid!==0||(s.mode&0o7777)!==0o600||s.nlink!==1||!nodeValid(nodeIdentity(s))||!Number.isSafeInteger(s.size)||s.size<0||s.size>limit)fail();}
function readBounded(path,io,limit){
 const before=trustPath(path,io,{kind:'file',gid:0,mode:0o600});fileValid(before,limit);
 const fd=io.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const opened=io.fstatSync(fd);fileValid(opened,limit);if(!nodeSame(before,opened))fail();
  // Read at most limit+1 even if the opened file grows after fstat.
  const buffer=Buffer.alloc(limit+1);let length=0;while(length<buffer.length){const count=io.readSync(fd,buffer,length,buffer.length-length,null);if(!Number.isSafeInteger(count)||count<0||count>buffer.length-length)fail();if(count===0)break;length+=count;}if(length>limit)fail();
  const after=io.fstatSync(fd);fileValid(after,limit);const current=io.lstatSync(path);fileValid(current,limit);if(!nodeSame(opened,after)||!nodeSame(opened,current))fail();
  const bytes=buffer.subarray(0,length);if(!isUtf8(bytes))fail();return {value:JSON.parse(bytes.toString('utf8')),bytes,stat:after};
 }finally{io.closeSync(fd);}
}
function read(path,io){return readBounded(path,io,131072).value;}
function metadataExact(value,keys){return exact(value,keys)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>{const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor.enumerable&&Object.hasOwn(descriptor,'value');});}
function metadataNodeValid(value){return metadataExact(value,['dev','ino'])&&nodeValid(value);}
function markerIdentityValid(value){return metadataExact(value,['dev','ino','hash'])&&metadataNodeValid({dev:value.dev,ino:value.ino})&&digest(value.hash);}
function markerValid(value){return metadataExact(value,['version','authorityId','root','records'])&&value.version===1&&token(value.authorityId)&&metadataNodeValid(value.root)&&metadataNodeValid(value.records);}
function witnessValid(value){return metadataExact(value,['version','phase','authorityId','initializedBy','root','records','marker'])&&value.version===1&&token(value.authorityId)&&metadataExact(value.initializedBy,['artifactHash','policyHash','boot'])&&digest(value.initializedBy.artifactHash)&&digest(value.initializedBy.policyHash)&&typeof value.initializedBy.boot==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.initializedBy.boot)&&(value.phase==='initializing'?value.root===null&&value.records===null&&value.marker===null:value.phase==='ready'&&metadataNodeValid(value.root)&&metadataNodeValid(value.records)&&markerIdentityValid(value.marker));}
function referenceValid(value){return metadataExact(value,['version','authorityId','witnessHash'])&&value.version===1&&token(value.authorityId)&&digest(value.witnessHash);}
function metadataCanonical(value){if(value===null||typeof value!=='object')return value;if(Array.isArray(value))return value.map(metadataCanonical);return Object.fromEntries(Object.keys(value).sort().map(key=>[key,metadataCanonical(value[key])]));}
function metadataJsonBytes(value){return Buffer.from(JSON.stringify(metadataCanonical(value)),'utf8');}
function metadataFileBytes(value){return Buffer.concat([metadataJsonBytes(value),Buffer.from([0x0a])]);}
function metadataDigest(bytes){return createHash('sha256').update(bytes).digest('hex');}
export function encodeRegistryMetadata(value){if(!witnessValid(value)&&!markerValid(value))fail();const bytes=metadataFileBytes(value);if(bytes.length>4096)fail();return bytes;}
export function readRegistryAuthority(io,expected){
 if(expected!==undefined&&!referenceValid(expected))fail();
 if(exists(BASE,io))trustPath(BASE,io,{gid:0,mode:0o700});
 if(exists(LEGACY,io)){trustPath(LEGACY,io,{gid:0,mode:0o700});if(io.readdirSync(LEGACY).length)fail();}
 const root=trustPath(DURABLE,io,{gid:0,mode:0o700}),records=trustPath(REGISTRY,io,{gid:0,mode:0o700});
 if(!nodeValid(nodeIdentity(root))||!nodeValid(nodeIdentity(records)))fail();
 const witness=readBounded(WITNESS,io,4096),ready=witness.value;if(!witnessValid(ready)||ready.phase!=='ready'||!witness.bytes.equals(encodeRegistryMetadata(ready)))fail();
 if(!nodeSame(root,ready.root)||!nodeSame(records,ready.records))fail();
 const marker=readBounded(MARKER,io,4096);if(!nodeSame(marker.stat,ready.marker)||metadataDigest(marker.bytes)!==ready.marker.hash)fail();
 if(!markerValid(marker.value)||!marker.bytes.equals(encodeRegistryMetadata(marker.value))||marker.value.authorityId!==ready.authorityId||!nodeSame(marker.value.root,ready.root)||!nodeSame(marker.value.records,ready.records))fail();
 for(const [path,identity]of [[DURABLE,root],[REGISTRY,records]])if(!nodeSame(trustPath(path,io,{gid:0,mode:0o700}),identity))fail();
 const reference={version:1,authorityId:ready.authorityId,witnessHash:metadataDigest(metadataJsonBytes(ready))};if(expected!==undefined&&(reference.authorityId!==expected.authorityId||reference.witnessHash!==expected.witnessHash))fail();
 return {...reference,root:nodeIdentity(root),records:nodeIdentity(records),marker:{dev:marker.stat.dev,ino:marker.stat.ino,hash:ready.marker.hash}};
}
function syncDir(path,io){const fd=io.openSync(path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{io.fsyncSync(fd);}finally{io.closeSync(fd);}}
function ownedTemporary(path,identity,io,links=1){const stat=io.lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==0||stat.gid!==0||(stat.mode&0o7777)!==0o600||stat.nlink!==links||!nodeSame(stat,identity))fail();}
function publishBytes(path,bytes,limit,tokenId,io,exclusive,validateExisting){
 if(!Buffer.isBuffer(bytes)||bytes.length>limit||!token(tokenId))fail();
 const previous=exclusive?undefined:validateExisting(),parent=dirname(path),temp=parent+'/.write-'+tokenId+'-'+randomBytes(16).toString('hex')+'.tmp';let fd,owned,published=false;
 try{
  fd=io.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  const created=io.fstatSync(fd);if(!created.isFile()||created.uid!==0||created.gid!==0||created.nlink!==1||!nodeValid(nodeIdentity(created)))fail();owned=nodeIdentity(created);io.fchmodSync(fd,0o600);fileValid(io.fstatSync(fd),limit);ownedTemporary(temp,owned,io);
  io.writeFileSync(fd,bytes);io.fsyncSync(fd);const closing=fd;fd=undefined;io.closeSync(closing);ownedTemporary(temp,owned,io);
  if(exclusive){io.linkSync(temp,path);published=true;syncDir(parent,io);ownedTemporary(temp,owned,io,2);if(!nodeSame(io.lstatSync(path),owned))fail();io.unlinkSync(temp);syncDir(parent,io);}
  else{if(!nodeSame(previous,validateExisting()))fail();io.renameSync(temp,path);published=true;syncDir(parent,io);}
 }catch(error){
  if(fd!==undefined){try{io.closeSync(fd);}catch{}}
  if(owned&&!published){try{published=nodeSame(io.lstatSync(path),owned);}catch{}}
  if(owned&&!published){try{ownedTemporary(temp,owned,io);io.unlinkSync(temp);}catch{}}
  throw error;
 }
}
function write(path,value,io,exclusive=false){
 const bytes=Buffer.from(JSON.stringify(value)+'\n','utf8');
 const validateExisting=()=>{const existing=readBounded(path,io,131072);
  if(path===QUALIFICATION){const {records:before,...fixed}=existing.value,{records:after,...next}=value;if(!same(fixed,next)||!Array.isArray(before)||!Array.isArray(after)||after.length!==before.length+1||!same(before,after.slice(0,-1))||!token(after.at(-1)))fail();}
  else{const record=recordValid(existing.value);if(record.kind!=='registered')fail();for(const key of ['version','kind','authorityId','invocation','generation','boot','context','identity','admission'])if(!same(record[key],value[key]))fail();if(record.payloadSealed&&!value.payloadSealed||record.cleanupConsumed&&!value.cleanupConsumed||record.bootRevocation!==null&&record.bootRevocation!==value.bootRevocation||record.state==='closed')fail();}return existing.stat;};
 publishBytes(path,bytes,131072,value.invocation??value.nonce??value.generation,io,exclusive,validateExisting);
}
const profileFactKeys=['persistentMarkerReadable','persistentMarkerUnchanged','persistentConfigUnchanged','privateHomeWritable','privateScratchRemoved','workspaceMatchesRecord','closedNetworkObserved'];
const postDropKeys=['uid','gid','groups','noNewPrivileges','capEffective','capPermitted','capInheritable','capAmbient','capBounding','homeMatches','fixedEnvironmentMatches','extraEnvironmentKeys','unknownEnvironmentKeyPresent','derivedPwdMatchesHome','derivedOldPwdMatchesTrustedCwd'];
function observationValid(o){return exact(o,['pid','start','directEnvironmentClean','postDrop','profileFacts'])&&Number.isSafeInteger(o.pid)&&o.pid>1&&/^[1-9]\d{0,19}$/.test(o.start)&&o.directEnvironmentClean===true&&exact(o.postDrop,postDropKeys)&&numeric(o.postDrop.uid)&&numeric(o.postDrop.gid)&&Array.isArray(o.postDrop.groups)&&o.postDrop.groups.length===0&&o.postDrop.noNewPrivileges===true&&['capEffective','capPermitted','capInheritable','capAmbient','capBounding'].every(k=>typeof o.postDrop[k]==='string'&&/^0{1,16}$/.test(o.postDrop[k]))&&['homeMatches','fixedEnvironmentMatches','derivedPwdMatchesHome','derivedOldPwdMatchesTrustedCwd'].every(k=>o.postDrop[k]===true)&&o.postDrop.unknownEnvironmentKeyPresent===false&&Array.isArray(o.postDrop.extraEnvironmentKeys)&&new Set(o.postDrop.extraEnvironmentKeys).size===o.postDrop.extraEnvironmentKeys.length&&o.postDrop.extraEnvironmentKeys.every(k=>['PWD','OLDPWD'].includes(k))&&exact(o.profileFacts,profileFactKeys)&&Object.values(o.profileFacts).every(v=>typeof v==='boolean');}
function recordValid(r){
 if(r?.kind==='denial-only'){
  if(!exact(r,['version','kind','authorityId','invocation','context','identity','authorization','boot','state','payloadSealed'])||r.version!==2||!token(r.authorityId)||!token(r.invocation)||!contextValid(r.context)||!exact(r.identity,['uid','gid','home'])||!identityValid(r.context,{...r.identity,groups:[]})||!exact(r.authorization,['policyHash','artifactHash'])||!digest(r.authorization.policyHash)||!digest(r.authorization.artifactHash)||!bootValid(r.boot)||r.state!=='denied'||r.payloadSealed!==true)fail();return r;
 }
 if(!exact(r,['version','kind','authorityId','invocation','context','identity','admission','boot','generation','state','payloadSealed','cleanupConsumed','sequence','stages','layout','baseline','drain','cleanupConfirmed','bootRevocation'])||r.version!==2||r.kind!=='registered'||!token(r.authorityId)||!(r.bootRevocation===null||bootValid(r.bootRevocation)&&r.bootRevocation!==r.boot&&r.state==='quarantined'&&r.payloadSealed===true)||!token(r.invocation)||!contextValid(r.context)||!identityValid(r.context,{...r.identity,groups:[]})||!exact(r.identity,['uid','gid','home'])||!exact(r.admission,['policyHash','artifactHash','proxyPort'])||!digest(r.admission.policyHash)||!digest(r.admission.artifactHash)||!Number.isSafeInteger(r.admission.proxyPort)||r.admission.proxyPort<1024||r.admission.proxyPort>65535||!token(r.generation)||typeof r.boot!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(r.boot)||!states.includes(r.state)||typeof r.payloadSealed!=='boolean'||typeof r.cleanupConsumed!=='boolean'||typeof r.cleanupConfirmed!=='boolean'||!Number.isSafeInteger(r.sequence)||r.sequence<1||r.sequence>6||!Array.isArray(r.stages)||r.stages.length!==r.sequence||!exact(r.layout,['root','path','rootIno','workIno','status'])||r.layout.root!==ROOT+'/'+r.invocation||r.layout.path!==r.layout.root+'/work'||!['intended','allocated','removed'].includes(r.layout.status)||!exact(r.baseline,['workerProcessesAbsent','privateMountsAbsent','cgroupsEmpty'])||!Object.values(r.baseline).every(v=>v===true))fail();
 for(const [i,s]of r.stages.entries())if(!(exact(s,['stage','profile','sequence','unit','description','phase','invocationId','controlGroup','submission','submitterExited','code'])||exact(s,['stage','profile','sequence','unit','description','phase','invocationId','controlGroup','submission','submitterExited','code','observation']))||s.observation!=null&&(!observationValid(s.observation)||s.observation.postDrop.uid!==r.identity.uid||s.observation.postDrop.gid!==r.identity.gid)||!stages.includes(s.stage)||s.profile!==profileFor(s.stage)||s.sequence!==i+1||s.unit!==`patrick-worker-${r.generation}-${i+1}.service`||s.description!==`patrick-worker:${r.generation}:${r.invocation}:${i+1}`||!['pending','acknowledged','complete','unknown','cancelled'].includes(s.phase)||!(s.invocationId===null||token(s.invocationId))||!(s.controlGroup===null||s.controlGroup==='/system.slice/'+s.unit)||!(s.submission===null||exact(s.submission,['pid','start'])&&Number.isSafeInteger(s.submission.pid)&&s.submission.pid>1&&/^[1-9]\d{0,19}$/.test(s.submission.start))||typeof s.submitterExited!=='boolean'||!(s.code===null||Number.isInteger(s.code)))fail();
 const inode=n=>Number.isSafeInteger(n)&&n>0;
 if(!(r.layout.rootIno===null||inode(r.layout.rootIno))||!(r.layout.workIno===null||inode(r.layout.workIno))||r.layout.status!=='intended'&&(!inode(r.layout.rootIno)||!inode(r.layout.workIno))||!(r.drain===null||exact(r.drain,['generation','sequence'])&&r.drain.generation===r.generation&&Number.isSafeInteger(r.drain.sequence)&&r.drain.sequence>=1&&r.drain.sequence<=r.sequence)||r.state==='active'&&r.payloadSealed||r.state!=='active'&&!r.payloadSealed)fail();
 const purposes=r.stages.map(s=>s.stage),cleanup=r.stages.find(s=>s.stage==='cleanup');
 if(purposes[0]!=='prepare'||new Set(purposes).size!==purposes.length||cleanup&&purposes.at(-1)!=='cleanup'||r.cleanupConsumed!==Boolean(cleanup)||r.cleanupConfirmed&&(!r.cleanupConsumed||!r.drain||cleanup.code!==0||cleanup.phase!=='complete')||r.stages.some(s=>(s.invocationId===null)!==(s.controlGroup===null)||['acknowledged','complete'].includes(s.phase)&&!s.invocationId))fail();
 const payload=purposes.filter(p=>p!=='cleanup'),normal=r.context.runner==='dsh'?['prepare','acp','tests']:r.context.runner==='codex'?['prepare','cli','read','tests']:['prepare','cli','tests'];
 if(!same(payload,normal.slice(0,payload.length)))fail();
 if(r.state==='closed' &&(r.bootRevocation!==null||!r.payloadSealed||!r.cleanupConfirmed||r.layout.status!=='removed'||r.stages.some(s=>!['complete','cancelled'].includes(s.phase))))fail();return r;
}
function recordPath(invocation){if(!token(invocation))fail();return `${REGISTRY}/${invocation}.json`;}
function readCanonicalRecord(invocation,io,authorityId){const record=recordValid(read(recordPath(invocation),io));if(record.invocation!==invocation||record.authorityId!==authorityId)fail();return record;}
function readRecord(invocation,io,expected){const authority=readRegistryAuthority(io,expected);return readCanonicalRecord(invocation,io,authority.authorityId);}
function save(r,deps,exclusive=false){recordValid(r);try{const authority=readRegistryAuthority(deps.io,deps.registry);if(r.authorityId!==authority.authorityId)fail();write(recordPath(r.invocation),r,deps.io,exclusive);}catch(error){if(exclusive&&r.kind==='denial-only'&&error.code==='EEXIST')throw error;throw Object.assign(new Error('Worker entry denied.'),{retainUidLock:true});}}
export function registryQuiescent(io,expected){
 const authority=readRegistryAuthority(io,expected);let markerSeen=false,quiescent=true;
 // Stream retained history with one bounded record and 32 directory entries.
 const directory=io.opendirSync(REGISTRY,{bufferSize:32});try{let entry;while((entry=directory.readSync())!==null){const name=entry.name;if(name==='.authority.json'){if(markerSeen)fail();markerSeen=true;continue;}if(!/^[a-f0-9]{32}\.json$/.test(name))fail();const record=readCanonicalRecord(name.slice(0,32),io,authority.authorityId);if(record.kind!=='denial-only'&&record.state!=='closed')quiescent=false;}if(!markerSeen)fail();readRegistryAuthority(io,authorityReference(authority));return quiescent;}finally{directory.closeSync();}
}
function authorityReference(authority){return {version:1,authorityId:authority.authorityId,witnessHash:authority.witnessHash};}
export function registryRecordsClosed(io,expected,invocations){
 const authority=readRegistryAuthority(io,expected);if(!Array.isArray(invocations)||invocations.length>64||new Set(invocations).size!==invocations.length||invocations.some(v=>!token(v)))fail();
 for(const invocation of invocations){try{const record=readCanonicalRecord(invocation,io,authority.authorityId);if(record.kind!=='denial-only'&&record.state!=='closed')return false;}catch{return false;}}readRegistryAuthority(io,expected);return true;
}
export function ensureRuntimeBase(deps,expected){
 readRegistryAuthority(deps.io,expected);trustPath('/run',deps.io);
 if(!exists(BASE,deps.io)){deps.io.mkdirSync(BASE,{mode:0o700});trustPath(BASE,deps.io,{gid:0,mode:0o700});syncDir('/run',deps.io);}
 trustPath(BASE,deps.io,{gid:0,mode:0o700});for(const name of deps.io.readdirSync(BASE)){
  if(name==='invocations'){trustPath(LEGACY,deps.io,{gid:0,mode:0o700});if(deps.io.readdirSync(LEGACY).length)fail();}
  else if(name==='install.lock'||/^uid-[1-9]\d{3,9}\.lock$/.test(name))trustPath(BASE+'/'+name,deps.io,{gid:0,mode:0o700});else fail();
 }
}
async function recover(request,deps,account){
 const recovery=await deps.recover(request.context);if(!recovery||!identityValid(request.context,recovery.identity)||!same({uid:recovery.identity.uid,gid:recovery.identity.gid,home:recovery.identity.home},{uid:account.uid,gid:account.gid,home:account.home}))fail();
 const authority=readRegistryAuthority(deps.io,recovery.registry);if(deps.registry&&!same(deps.registry,authorityReference(authority)))fail();if(!(recovery.cancellationBinding===null||exact(recovery.cancellationBinding,['policyHash','artifactHash'])&&digest(recovery.cancellationBinding.policyHash)&&digest(recovery.cancellationBinding.artifactHash)))fail();return {...recovery,registry:authorityReference(authority)};
}
function revokeOldBoot(r,deps){if(r.state==='closed'||r.boot===deps.boot()&&r.bootRevocation===null)return false;if(r.bootRevocation===null){r.payloadSealed=true;r.state='quarantined';r.bootRevocation=deps.boot();save(r,deps);}return true;}
async function lock(path,deps,kind){trustPath(BASE,deps.io,{mode:0o700});const end=Date.now()+Math.min(deps.lockTimeoutMs??1500,2000);let owner;
 while(true){try{deps.io.mkdirSync(path,{mode:0o700});break;}catch(e){if(e.code!=='EEXIST'||Date.now()>=end)fail();await new Promise(r=>setTimeout(r,10));}}
 try{owner={version:1,kind,boot:deps.boot(),...deps.witness(),nonce:randomBytes(16).toString('hex')};write(path+'/owner.json',owner,deps.io,true);}catch{fail();}
 return ()=>{trustPath(path,deps.io,{mode:0o700});if(!same(deps.io.readdirSync(path),['owner.json'])||!same(read(path+'/owner.json',deps.io),owner))fail();deps.io.unlinkSync(path+'/owner.json');syncDir(path,deps.io);deps.io.rmdirSync(path);syncDir(BASE,deps.io);};
}
async function locked(deps,uid,global,fn){let releaseGlobal,releaseUid,retainUid=false;try{if(global)releaseGlobal=await lock(BASE+'/install.lock',deps,'stage');releaseUid=await lock(BASE+`/uid-${uid}.lock`,deps,'stage');return await fn();}catch(error){retainUid=error?.retainUidLock===true;throw error;}finally{try{if(!retainUid)releaseUid?.();}finally{releaseGlobal?.();}}}
function bound(r,request,deps){if(!same(r.context,request.context))fail();const current=deps.identity(request.context);if(!identityValid(request.context,current)||!same(r.identity,{uid:current.uid,gid:current.gid,home:current.home}))fail();return current;}
function layout(r,deps,work=true){const {io}=deps;trustPath(ROOT,io);trustPath(r.layout.root,io,{uid:r.identity.uid,gid:r.identity.gid,mode:0o700});if(io.lstatSync(r.layout.root).ino!==r.layout.rootIno)fail();if(work){const st=io.lstatSync(r.layout.path);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==r.identity.uid||st.gid!==r.identity.gid||(st.mode&0o777)!==0o700||st.ino!==r.layout.workIno)fail();}}
function envelope(request){const {stage,invocation}=request.lifetime,args=request.command,workspace=`${ROOT}/${invocation}/work`;
 if(!args.length||args.length>256||args.some(a=>typeof a!=='string'||!a.isWellFormed()||a.includes('\0')||Buffer.byteLength(a)>131072)||args.reduce((n,a)=>n+Buffer.byteLength(a),0)>1048576)fail();
 if(['prepare','read','tests','cleanup'].includes(stage)){if(!same(args,['node','-e',guestScripts[stage],workspace]))fail();}
 else if(stage==='cli'){if(request.context.runner==='dsh'||args.length<6||args[0]!=='sh'||args[1]!=='-c'||args[2]!==cliWrapper||args[3]!=='patrick'||args[4]!==workspace)fail();}
 else if(stage==='acp'&&request.context.runner!=='dsh')fail();
}
function order(r,stage){if(r.stages.some(s=>s.stage===stage)||r.stages.some(s=>!['complete','cancelled'].includes(s.phase)))fail();const done=r.stages.map(s=>s.stage);if(stage==='prepare'){if(done.length)fail();}else if(stage==='cli'||stage==='acp'){if(!same(done,['prepare']))fail();}else if(stage==='read'){if(r.context.runner!=='codex'||!same(done,['prepare','cli']))fail();}else if(stage==='tests'){if(r.context.runner==='codex'?!same(done,['prepare','cli','read']):!same(done,['prepare',r.context.runner==='dsh'?'acp':'cli']))fail();}}
function observed(deps,r){const value=deps.observe(r);if(!exact(value,['workerProcessesAbsent','privateMountsAbsent','cgroupsEmpty'])||Object.values(value).some(v=>typeof v!=='boolean'))fail();return value;}
function empty(value){return value.workerProcessesAbsent&&value.privateMountsAbsent&&value.cgroupsEmpty;}
function managerMatch(s,facts){return facts&&facts.description===s.description&&token(facts.invocationId)&&facts.controlGroup==='/system.slice/'+s.unit&&(!s.invocationId||s.invocationId===facts.invocationId)&&(!s.controlGroup||s.controlGroup===facts.controlGroup);}
async function reconcileUnits(r,deps,stop){let unknown=false,active=false;for(const s of r.stages){const facts=await deps.manager.inspect(s.unit);
 if(facts){if(!managerMatch(s,facts)){unknown=true;continue;}if(!s.invocationId){s.invocationId=facts.invocationId;s.controlGroup=facts.controlGroup;s.phase='acknowledged';save(r,deps);}if(stop){await deps.manager.stop(s.unit);const after=await deps.manager.inspect(s.unit);if(after&&(!managerMatch(s,after)||after.active||!after.empty)){unknown=true;continue;}}else if(facts.active||!facts.empty){active=true;if(await deps.manager.pending(s.unit))unknown=true;continue;}
 if(await deps.manager.pending(s.unit)){unknown=true;continue;}s.phase='complete';
 // A disappeared submitter cannot cancel a request already sent to the manager.
 // Missing unacknowledged ownership stays unknown, even after empty snapshots.
 }else if(s.invocationId&&!(await deps.manager.pending(s.unit))){s.phase='complete';}else unknown=true;
 }return unknown?'unknown':active?'active':'empty';}
const noFacts=Object.freeze({cgroupsEmpty:false,workerProcessesAbsent:false,workspacesAbsent:false,privateMountsAbsent:false});
function unknownResult(reason='unknown'){return Object.freeze({version:2,kind:'unknown',state:'quarantined',closure:'none',invocationClosed:false,reason,...noFacts});}
function trustedWorkspaceBase(io){const base=trustPath(ROOT,io);if(base.mode&0o022)fail();return base;}
function workspaceAbsent(root,deps){trustedWorkspaceBase(deps.io);return !exists(root,deps.io);}
function result(r,facts,reason='unknown',deps){
 if(!r)return unknownResult(reason);let absent=false;try{absent=workspaceAbsent(r.layout.root,deps);}catch{}
 return Object.freeze({version:2,kind:'registered',state:r.state,closure:r.state==='closed'?'workspace-cleaned':'none',invocationClosed:r.state==='closed',reason,cgroupsEmpty:facts?.cgroupsEmpty===true,workerProcessesAbsent:facts?.workerProcessesAbsent===true,workspacesAbsent:absent,privateMountsAbsent:facts?.privateMountsAbsent===true});
}
function observeDenial(deps,r){
 const root=ROOT+'/'+r.invocation,subject={context:r.context,identity:r.identity,stages:[],layout:{root,path:root+'/work'}};
 let facts;try{facts=observed(deps,subject);}catch{return {...noFacts,reason:'unknown'};}
 try{trustedWorkspaceBase(deps.io);}catch{return {...facts,workspacesAbsent:false,reason:'unknown'};}
 let absent=false,residual=false;try{const stat=deps.io.lstatSync(root);residual=stat.isDirectory()&&!stat.isSymbolicLink()&&stat.uid===r.identity.uid&&stat.gid===r.identity.gid&&(stat.mode&0o7777)===0o700;}catch(error){if(error.code==='ENOENT')absent=true;}
 return {...facts,workspacesAbsent:absent,reason:empty(facts)&&absent?'ok':empty(facts)&&residual?'workspace_residual':'unknown'};
}
function denialResult(r,observation){const {reason,...facts}=observation;return Object.freeze({version:2,kind:'denial-only',state:'denied',closure:'never-registered',invocationClosed:true,reason,...facts});}
async function admissionMatches(r,request,deps){try{const admission=await deps.admit(request.context,['node']);return admission.policyHash===r.admission.policyHash&&admission.artifactHash===r.admission.artifactHash&&identityValid(request.context,admission.entry)&&same(r.identity,{uid:admission.entry.uid,gid:admission.entry.gid,home:admission.entry.home});}catch{return false;}}
function historicalResult(r,deps){
 let facts;try{facts=observed(deps,{context:r.context,identity:r.identity,stages:[],layout:r.layout});}catch{return Object.freeze({...result(r,undefined,'unknown',deps),workspacesAbsent:false});}
 const receipt=result(r,facts,'unknown',deps);return Object.freeze({...receipt,reason:empty(facts)&&receipt.workspacesAbsent?'ok':'unknown'});
}
async function control(request,deps,account){return locked(deps,account.uid,false,async()=>{
 let r,binding=false;try{
 const recovery=await recover(request,deps,account),path=recordPath(request.lifetime.invocation);
 if(!exists(path,deps.io)){
  if(request.lifetime.operation!=='stop'||!recovery.cancellationBinding)return unknownResult();
  // Validate the complete bounded registry; other live tokens do not authorize
  // any stop and do not prevent this token's exclusive historical denial.
  registryQuiescent(deps.io,recovery.registry);
  if(!exists(path,deps.io)){
   const denial={version:2,kind:'denial-only',authorityId:recovery.registry.authorityId,invocation:request.lifetime.invocation,context:request.context,identity:{uid:account.uid,gid:account.gid,home:account.home},authorization:recovery.cancellationBinding,boot:deps.boot(),state:'denied',payloadSealed:true};
   try{save(denial,deps,true);}catch(error){if(error.code!=='EEXIST')throw error;try{registryQuiescent(deps.io,recovery.registry);}catch{throw Object.assign(new Error('Worker entry denied.'),{retainUidLock:true});}}
  }
 }
 r=readRecord(request.lifetime.invocation,deps.io,deps.registry);bound(r,request,deps);binding=true;
 if(r.kind==='denial-only')return denialResult(r,observeDenial(deps,r));
 if(r.state==='closed')return historicalResult(r,deps);if(revokeOldBoot(r,deps))return result(r,undefined,'boot_mismatch',deps);
 if(request.lifetime.operation==='stop'){r.payloadSealed=true;r.state='stopping';save(r,deps);const units=await reconcileUnits(r,deps,true),facts=observed(deps,r);if(units==='empty'&&empty(facts)){r.state='drained';r.drain={generation:r.generation,sequence:r.sequence};}else r.state='quarantined';save(r,deps);return result(r,facts,units==='empty'&&empty(facts)?'ok':'unknown',deps);}
 const units=await reconcileUnits(r,deps,false),facts=observed(deps,r);if(units==='active'&&r.state==='active'&&!r.payloadSealed)return result(r,facts,'active',deps);if(units!=='empty'||!empty(facts)){r.payloadSealed=true;r.state='quarantined';save(r,deps);return result(r,facts,'unknown',deps);}
 // Observation never manufactures stop's persisted drain receipt.
 if(r.bootRevocation===null&&r.payloadSealed&&r.drain&&r.cleanupConsumed&&r.cleanupConfirmed&&r.stages.find(s=>s.stage==='cleanup')?.code===0&&await admissionMatches(r,request,deps)){
 if(r.layout.status!=='removed'){layout(r,deps,false);if(deps.io.readdirSync(r.layout.root).length){save(r,deps);return result(r,facts,'workspace_residual',deps);}deps.io.rmdirSync(r.layout.root);syncDir(ROOT,deps.io);r.layout.status='removed';}
 let qualificationHealthy=true;try{qualificationSession(r,deps.io,false);}catch{qualificationHealthy=false;}if(!qualificationHealthy||r.stages.some(s=>Object.hasOwn(s,'observation')&&(!s.observation||!s.observation.profileFacts.persistentMarkerUnchanged||!s.observation.profileFacts.persistentConfigUnchanged))){r.state='quarantined';save(r,deps);return result(r,facts,'unknown',deps);}
 r.state='closed';save(r,deps);return result(r,facts,'ok',deps);}
 save(r,deps);return result(r,facts,r.layout.status==='removed'?'unknown':'workspace_residual',deps);
 }catch(caught){if(caught?.retainUidLock)throw caught;if(r?.kind==='denial-only'&&binding)return denialResult(r,{...noFacts,reason:'unknown'});if(r?.state==='closed'&&binding)return result(r,undefined,'unknown',deps);if(r?.kind==='registered'&&binding&&r.bootRevocation===null){try{r.payloadSealed=true;r.state='quarantined';save(r,deps);}catch(error){if(error?.retainUidLock)throw error;}}return result(binding?r:undefined,undefined,'unknown',deps);}
 });}
export async function executeStage(request,deps){requestValid(request);if(deps.effectiveUid()!==0)fail();deps.trust();let account;try{account=deps.identity(request.context);}catch{if(request.lifetime.operation!=='exec')return result(undefined,undefined,'unknown');fail();}if(!identityValid(request.context,account)){
 if(request.lifetime.operation!=='exec')return result(undefined,undefined,'unknown');fail();}
 let registry;try{registry=(await recover(request,deps,account)).registry;ensureRuntimeBase(deps,registry);}catch{if(request.lifetime.operation!=='exec')return result(undefined,undefined,'control_unavailable');fail();}deps={...deps,registry};
 if(request.lifetime.operation!=='exec'){try{return await control(request,deps,account);}catch{return result(undefined,undefined,'control_unavailable');}}
 envelope(request);const cleanup=request.lifetime.stage==='cleanup';let launched,recordGeneration,sequence;
 await locked(deps,account.uid,!cleanup,async()=>{
 await recover(request,deps,account);let r;const path=recordPath(request.lifetime.invocation);
 if(exists(path,deps.io)){r=readRecord(request.lifetime.invocation,deps.io,deps.registry);bound(r,request,deps);if(r.kind!=='registered'||revokeOldBoot(r,deps))fail();}else if(request.lifetime.stage!=='prepare')fail();
 let admission;
 if(cleanup){if(!r||r.state!=='drained'||!r.payloadSealed||!r.drain||r.drain.generation!==r.generation||r.drain.sequence!==r.sequence||r.cleanupConsumed||!empty(observed(deps,r))||(await reconcileUnits(r,deps,false))!=='empty')fail();layout(r,deps);admission={entry:{...r.context,...r.identity,proxyPort:r.admission.proxyPort,command:request.command}};r.state='cleaning';r.cleanupConsumed=true;}
 else {if(r&&(r.state!=='active'||r.payloadSealed))fail();admission=await deps.admit(request.context,request.command);if(!identityValid(request.context,admission.entry)||!same({uid:admission.entry.uid,gid:admission.entry.gid,home:admission.entry.home},{uid:account.uid,gid:account.gid,home:account.home})||!digest(admission.policyHash)||!digest(admission.artifactHash))fail();
 if(r){if(!same(r.admission,{policyHash:admission.policyHash,artifactHash:admission.artifactHash,proxyPort:admission.entry.proxyPort}))fail();order(r,request.lifetime.stage);layout(r,deps);}else{
 if(!registryQuiescent(deps.io,deps.registry))fail();trustPath(ROOT,deps.io);const baseline=observed(deps,{context:request.context,identity:account,stages:[],layout:{root:ROOT+'/'+request.lifetime.invocation,path:ROOT+'/'+request.lifetime.invocation+'/work'}});if(!empty(baseline)||deps.io.readdirSync(ROOT).length)fail();
 r={version:2,kind:'registered',authorityId:deps.registry.authorityId,bootRevocation:null,invocation:request.lifetime.invocation,context:request.context,identity:{uid:account.uid,gid:account.gid,home:account.home},admission:{policyHash:admission.policyHash,artifactHash:admission.artifactHash,proxyPort:admission.entry.proxyPort},boot:deps.boot(),generation:randomBytes(16).toString('hex'),state:'active',payloadSealed:false,cleanupConsumed:false,sequence:0,stages:[],layout:{root:ROOT+'/'+request.lifetime.invocation,path:ROOT+'/'+request.lifetime.invocation+'/work',rootIno:null,workIno:null,status:'intended'},baseline,drain:null,cleanupConfirmed:false};
 }}
 const s={stage:request.lifetime.stage,profile:request.lifetime.profile,sequence:++r.sequence,unit:`patrick-worker-${r.generation}-${r.sequence}.service`,description:`patrick-worker:${r.generation}:${r.invocation}:${r.sequence}`,phase:'pending',invocationId:null,controlGroup:null,submission:null,submitterExited:false,code:null,...(deps.manager.observeStage?{observation:null}:{})};r.stages.push(s);save(r,deps,!exists(path,deps.io));recordGeneration=r.generation;sequence=s.sequence;
 try{
 if(r.layout.status==='intended'){if(exists(r.layout.root,deps.io))fail();deps.io.mkdirSync(r.layout.root,{mode:0o700});deps.io.chownSync(r.layout.root,account.uid,account.gid);r.layout.rootIno=deps.io.lstatSync(r.layout.root).ino;save(r,deps);deps.io.mkdirSync(r.layout.path,{mode:0o700});deps.io.chownSync(r.layout.path,account.uid,account.gid);r.layout.workIno=deps.io.lstatSync(r.layout.path).ino;r.layout.status='allocated';syncDir(r.layout.root,deps.io);syncDir(ROOT,deps.io);save(r,deps);layout(r,deps);}
 if(!cleanup)qualificationSession(r,deps.io,true);const spec=buildServiceInvocation(admission.entry,request.lifetime,{unit:s.unit,description:s.description,workspace:r.layout.path});launched=deps.manager.submit({...spec,unit:s.unit,description:s.description,stage:s.stage,workspace:r.layout.path});s.submission=launched.witness??null;save(r,deps);
 // Always observe process completion, including acknowledgement failure.
 launched.completion.then(outcome=>finish(request,deps,recordGeneration,sequence,outcome),()=>finish(request,deps,recordGeneration,sequence,{code:null})).catch(()=>{});
 const facts=await deps.manager.acknowledge(s.unit);if(!managerMatch(s,facts))fail();s.invocationId=facts.invocationId;s.controlGroup=facts.controlGroup;s.phase='acknowledged';save(r,deps);if(deps.manager.observeStage){const observation=await deps.manager.observeStage({stage:s,record:r,launch:launched,command:request.command});if(!observationValid(observation))fail();s.observation=observation;save(r,deps);}launched.release?.();
 }catch{r.payloadSealed=true;r.state='quarantined';save(r,deps);launched?.cancelInput?.();throw new Error('Worker entry denied.');}
 });
 const outcome=await launched.completion,confirmed=await finish(request,deps,recordGeneration,sequence,outcome);if(outcome.code!==0||!confirmed)fail();return outcome;
}
async function finish(request,deps,generation,sequence,outcome){const a=deps.identity(request.context);if(!identityValid(request.context,a))fail();return locked(deps,a.uid,false,async()=>{await recover(request,deps,a);const r=readRecord(request.lifetime.invocation,deps.io,deps.registry);bound(r,request,deps);if(r.kind!=='registered'||r.generation!==generation)fail();if(r.state==='closed')return true;if(revokeOldBoot(r,deps))return false;const s=r.stages[sequence-1];if(!s||s.sequence!==sequence)fail();s.submitterExited=true;s.code=Number.isInteger(outcome.code)?outcome.code:null;let markerFailure=false;if(s.observation){try{qualificationSession(r,deps.io,false);}catch{markerFailure=true;s.observation.profileFacts.persistentMarkerUnchanged=false;s.observation.profileFacts.persistentConfigUnchanged=false;}if(['prepare','read','tests','cleanup'].includes(s.stage)){const a=outcome.assertion;if(!assertionValid(a,s.stage)||a.persistentMarkerReadable||!a.initialHomeEmpty||!a.privateHomeWritable||!a.privateScratchRemoved||!a.closedNetworkDenied){s.phase='unknown';r.payloadSealed=true;r.state='quarantined';save(r,deps);return false;}Object.assign(s.observation.profileFacts,{privateHomeWritable:a.privateHomeWritable,privateScratchRemoved:a.privateScratchRemoved,closedNetworkObserved:s.observation.profileFacts.closedNetworkObserved&&a.closedNetworkDenied});}}const facts=await deps.manager.inspect(s.unit),observation=observed(deps,r);
 let confirmed=Boolean((s.stage==='cleanup'||!markerFailure)&&s.invocationId&&(!facts||managerMatch(s,facts)&&!facts.active&&facts.empty)&&!(await deps.manager.pending(s.unit))&&empty(observation));
 if(s.stage==='cleanup')confirmed=confirmed&&s.code===0&&!exists(r.layout.path,deps.io);
 if(confirmed){s.phase='complete';if(s.stage==='cleanup'){r.cleanupConfirmed=true;if(r.state==='cleaning')r.state='drained';}}
 else {s.phase='unknown';r.payloadSealed=true;r.state='quarantined';}save(r,deps);return confirmed;
 });}

export function assertProfilePaths(profile,home,paths){if(!['task-only','authenticated-client'].includes(profile)||!/^\/var\/lib\/patrick-[a-z][a-z0-9-]{0,23}$/.test(home)||!Array.isArray(paths)||paths.some(p=>typeof p!=='string'||!/^\/var\/lib\/patrick-workspaces\/[a-f0-9]{32}$/.test(p)&&!(profile==='authenticated-client'&&p===home)))fail();if(profile==='task-only'&&paths.some(p=>p===home||p.startsWith(home+'/')||home.startsWith(p+'/')))fail();}
export function buildDropInvocation(entry,wrapper='cd -- "$HOME" && exec "$@"'){
 return {command:'/usr/bin/setpriv',args:[`--reuid=${entry.uid}`,`--regid=${entry.gid}`,'--clear-groups','--no-new-privs','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--','/usr/bin/env','-i',`HOME=${entry.home}`,`USER=${entry.user}`,`LOGNAME=${entry.user}`,'PATH=/usr/local/bin:/usr/bin:/bin','TMPDIR=/tmp',`HTTP_PROXY=http://127.0.0.1:${entry.proxyPort}`,`HTTPS_PROXY=http://127.0.0.1:${entry.proxyPort}`,'NO_PROXY=','/usr/bin/dash','-c',wrapper,'patrick-worker',...entry.command]};
}
export function buildServiceInvocation(entry,lifetime,owned){
 if(!identityValid(entry,{...entry,groups:[]})||lifetime.profile!==profileFor(lifetime.stage)||!/^patrick-worker-[a-f0-9]{32}-[1-6]\.service$/.test(owned.unit)||owned.workspace!==ROOT+'/'+lifetime.invocation+'/work'||typeof owned.description!=='string')fail();
 const parent=dirname(owned.workspace),auth=lifetime.profile==='authenticated-client';assertProfilePaths(lifetime.profile,entry.home,auth?[entry.home,parent]:[parent]);
 const properties=['User=root','Group=root','SupplementaryGroups=','CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_SETPCAP','AmbientCapabilities=','NoNewPrivileges=yes','ProtectControlGroups=yes','ProtectSystem=strict','PrivateTmp=yes','KillMode=control-group','TimeoutStopSec=1s','SendSIGKILL=yes','Restart=no','RemainAfterExit=no',`RuntimeMaxSec=${lifetime.stage==='cleanup'?10:1800}s`,'WorkingDirectory=/','PassEnvironment=','Environment=',`Description=${owned.description}`];
 if(auth)properties.push(`ReadWritePaths=${entry.home} ${parent}`);else properties.push('PrivateNetwork=yes','RestrictAddressFamilies=AF_UNIX',`TemporaryFileSystem=${entry.home}:rw,nosuid,nodev,size=16M,nr_inodes=1024,mode=0700,uid=${entry.uid},gid=${entry.gid}`,`${lifetime.stage==='read'?'ReadOnlyPaths':'ReadWritePaths'}=${parent}`);
 const command=['prepare','read','tests','cleanup'].includes(lifetime.stage)?['/usr/local/bin/node',...entry.command.slice(1)]:entry.command;const drop=buildDropInvocation({...entry,command:['/usr/local/bin/node','--no-addons','--disable-warning=ExperimentalWarning','-e',execGateProgram,'--',...command]},gateWrapper);
 return {command:'/usr/bin/systemd-run',args:['--quiet','--pipe','--wait','--collect','--service-type=exec',`--unit=${owned.unit}`,...properties.map(p=>'--property='+p),'--',drop.command,...drop.args]};
}
// Production uses only fixed Linux control commands and kernel observations.
// Test callers supply the complete owned io/manager object to executeStage;
// there is no per-method fallback into these production paths.
const ADMIN_ENV=Object.freeze({PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C'});
function command(path,args){const r=spawnSync(path,args,{encoding:'utf8',timeout:750,maxBuffer:1048576,cwd:'/',env:ADMIN_ENV,stdio:['ignore','pipe','pipe']});if(r.error||r.signal||r.status!==0||typeof r.stdout!=='string'||Buffer.byteLength(r.stdout)>1048576)fail();return r.stdout;}
function cgroupEmpty(unit){const directory='/sys/fs/cgroup/system.slice/'+unit;if(!exists(directory,fs))return true;trustPath(directory,fs);const events=fs.readFileSync(directory+'/cgroup.events','utf8');const rows=events.trim().split('\n').filter(line=>line.startsWith('populated '));if(rows.length!==1||!/^populated [01]$/.test(rows[0]))fail();return rows[0]==='populated 0';}
function unitFacts(unit){if(!/^patrick-worker-[a-f0-9]{32}-[1-6]\.service$/.test(unit))fail();
 const text=command('/usr/bin/systemctl',['show',unit,'--no-pager','--property=Description,InvocationID,ControlGroup,ActiveState,SubState,LoadState,User,Group,DropInPaths,FragmentPath,MainPID']),fields={};for(const row of text.trim().split('\n')){const i=row.indexOf('=');if(i<1||Object.hasOwn(fields,row.slice(0,i)))fail();fields[row.slice(0,i)]=row.slice(i+1);}
 if(!exact(fields,['Description','InvocationID','ControlGroup','ActiveState','SubState','LoadState','User','Group','DropInPaths','FragmentPath','MainPID']))fail();if(fields.LoadState==='not-found'){if(fields.InvocationID||fields.ControlGroup||!cgroupEmpty(unit))fail();return null;}
 if(fields.LoadState!=='loaded'||fields.User!=='root'||fields.Group!=='root'||fields.DropInPaths!==''||fields.FragmentPath!=='/run/systemd/transient/'+unit||!token(fields.InvocationID)||!(fields.ControlGroup==='/system.slice/'+unit||fields.ControlGroup===''&&['inactive','failed'].includes(fields.ActiveState)&&cgroupEmpty(unit)))fail();
 if(!/^[0-9]+$/.test(fields.MainPID)||!Number.isSafeInteger(Number(fields.MainPID)))fail();return {mainPid:Number(fields.MainPID),description:fields.Description,invocationId:fields.InvocationID,controlGroup:'/system.slice/'+unit,active:!['inactive','failed'].includes(fields.ActiveState),empty:cgroupEmpty(unit)};
}
function pendingUnit(unit){const rows=command('/usr/bin/systemctl',['list-jobs','--no-pager','--no-legend','--plain']).trim().split('\n').filter(Boolean);if(rows.length>4096)fail();return rows.some(row=>row.trim().split(/\s+/)[1]===unit);}
const assertionPrefix='patrick-synthetic-observation:';
function assertionValid(a,stage){return exact(a,['version','stage','persistentMarkerReadable','privateHomeWritable','privateScratchRemoved','initialHomeEmpty','closedNetworkDenied'])&&a.version===1&&a.stage===stage&&['persistentMarkerReadable','privateHomeWritable','privateScratchRemoved','initialHomeEmpty','closedNetworkDenied'].every(k=>typeof a[k]==='boolean');}
export function assertionCollector(stage,forward){
 const fixed=['prepare','read','tests','cleanup'].includes(stage),prefix=Buffer.from(assertionPrefix);let mode='prefix',pending=[],parts=[],size=0,overflow=false,assertion=null,invalid=false;
 const endFrame=()=>{if(!overflow){try{const bytes=Buffer.concat(parts);if(bytes.some(b=>b>127))throw 0;const value=JSON.parse(bytes.toString());if(assertion||!assertionValid(value,stage))throw 0;assertion=value;}catch{invalid=true;}}parts=[];size=0;overflow=false;mode='prefix';};
 return {write(value){const chunk=Buffer.isBuffer(value)?value:Buffer.from(value);if(!fixed){forward(chunk);return;}let offset=0;while(offset<chunk.length){
  if(mode==='ordinary'){const newline=chunk.indexOf(10,offset),end=newline<0?chunk.length:newline+1;forward(chunk.subarray(offset,end));offset=end;if(newline>=0)mode='prefix';continue;}
  if(mode==='prefix'){const byte=chunk[offset++],index=pending.length;pending.push(byte);if(byte!==prefix[index]){forward(Buffer.from(pending));pending=[];mode=byte===10?'prefix':'ordinary';}else if(pending.length===prefix.length){pending=[];mode='frame';}continue;}
  const newline=chunk.indexOf(10,offset),end=newline<0?chunk.length:newline,part=chunk.subarray(offset,end);size+=part.length;if(size>8192){invalid=true;overflow=true;parts=[];}else if(!overflow)parts.push(Buffer.from(part));offset=newline<0?chunk.length:newline+1;if(newline>=0)endFrame();
 }},finish(){if(mode==='prefix'&&pending.length){forward(Buffer.from(pending));pending=[];}if(mode==='frame')invalid=true;return {assertion,invalid:invalid||fixed&&!assertion};}};
}
const QUALIFICATION='/etc/patrick-worker/qualification.json';
const markerNames=['.patrick-synthetic-auth','.patrick-synthetic-config'];
const sessionCodeNames=['worker-enter.mjs','policy.mjs','connect-proxy.mjs','address-policy.mjs','tls-clienthello.mjs','install-guest.mjs','probe-guest.mjs','stage-lifetime.mjs','synthetic-worker.mjs','synthetic-network.mjs','installed-network.mjs','entry','probe'];
function validNetworkOperation(op,session){
 const tok=v=>typeof v==='string'&&/^[a-f0-9]{32}$/.test(v),phases=['reserved','submitting','prepared','client','closing','closed','never-submitted','unknown'];
 return exact(op,['version','generation','artifactHash','policyHash','inventoryHash','owner','phase','preconditionRequests','roles'])&&op.version===1&&['generation','artifactHash','policyHash','inventoryHash'].every(k=>op[k]===session[k])&&exact(op.owner,['pid','startTime','bootId'])&&Number.isSafeInteger(op.owner.pid)&&op.owner.pid>1&&op.owner.pid<=2147483647&&/^[1-9]\d{0,19}$/.test(op.owner.startTime)&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(op.owner.bootId)&&['running','complete','unknown'].includes(op.phase)&&exact(op.preconditionRequests,['header','tls'])&&Object.values(op.preconditionRequests).every(n=>n===0||n===1)&&Array.isArray(op.roles)&&op.roles.length===3&&['grok','codex','dsh'].every((role,i)=>exact(op.roles[i],['role','token','phase','steps'])&&op.roles[i].role===role&&tok(op.roles[i].token)&&phases.includes(op.roles[i].phase)&&Number.isSafeInteger(op.roles[i].steps)&&op.roles[i].steps>=0&&op.roles[i].steps<=1024)&&new Set(op.roles.map(r=>r.token)).size===3&&op.roles.every(r=>!session.records.includes(r.token)||!['reserved','never-submitted'].includes(r.phase))&&(op.phase!=='complete'||op.roles.every(r=>['closed','never-submitted'].includes(r.phase)));
}
// Pure finite session schema shared by both bounded trusted readers.
export function validQualificationSession(value){try{if(!(exact(value,['version','generation','artifactHash','policyHash','inventoryHash','bindings','records','codeHashes','phase','registry'])||exact(value,['version','generation','artifactHash','policyHash','inventoryHash','bindings','records','codeHashes','phase','registry','networkOperation'])&&validNetworkOperation(value.networkOperation,value))||value.version!==2||!referenceValid(value.registry)||!['active','finishing'].includes(value.phase)||!/^[a-f0-9]{32}$/.test(value.generation)||!['artifactHash','policyHash','inventoryHash'].every(k=>/^[a-f0-9]{64}$/.test(value[k]))||!Array.isArray(value.bindings)||value.bindings.length!==3||!Array.isArray(value.records)||value.records.length>64||new Set(value.records).size!==value.records.length||value.records.some(t=>typeof t!=='string'||!/^[a-f0-9]{32}$/.test(t))||!exact(value.codeHashes,sessionCodeNames)||!Object.values(value.codeHashes).every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h)))return false;for(const b of value.bindings){if(!exact(b,['runner','user','projectId','domain','uid','gid','home','proxyPort','homeIno','baseline','markers'])||!['grok','codex','dsh'].includes(b.runner)||!/^patrick-[a-z][a-z0-9-]{0,23}$/.test(b.user)||b.home!=='/var/lib/'+b.user||!/^[a-zA-Z0-9_-]+$/.test(b.projectId)||typeof b.domain!=='string'||!b.domain||b.domain.includes('\0')||Buffer.byteLength(b.domain)>1024||!['uid','gid'].every(k=>Number.isSafeInteger(b[k])&&b[k]>=1000&&b[k]<=2147483647)||!Number.isSafeInteger(b.homeIno)||b.homeIno<=0||!Number.isSafeInteger(b.proxyPort)||b.proxyPort<1024||b.proxyPort>65535||!/^[a-f0-9]{64}$/.test(b.baseline)||!Array.isArray(b.markers)||b.markers.length!==2||new Set(b.markers.map(m=>m.name)).size!==2||b.markers.some(m=>!exact(m,['name','ino','hash','removeIntended','removed'])||typeof m.removeIntended!=='boolean'||typeof m.removed!=='boolean'||m.removed&&!m.removeIntended||!markerNames.includes(m.name)||!Number.isSafeInteger(m.ino)||m.ino<=0||!/^[a-f0-9]{64}$/.test(m.hash)))return false;}if(new Set(value.bindings.map(b=>b.runner)).size!==3||new Set(value.bindings.map(b=>b.uid)).size!==3)return false;return true;}catch(error){if(error instanceof TypeError)return false;throw error;}}
function qualificationSession(r,io,enroll){if(!exists(QUALIFICATION,io))return null;const session=read(QUALIFICATION,io);if(!validQualificationSession(session))fail();readRegistryAuthority(io,session.registry);if(session.registry.authorityId!==r.authorityId||session.version!==2||session.phase!=='active'||!token(session.generation)||session.artifactHash!==r.admission.artifactHash||session.policyHash!==r.admission.policyHash||!Array.isArray(session.bindings)||!Array.isArray(session.records)||session.records.length>64)fail();const b=session.bindings.find(b=>['runner','user','projectId','domain'].every(k=>b[k]===r.context[k]));if(!b||b.uid!==r.identity.uid||b.gid!==r.identity.gid||b.home!==r.identity.home||io.lstatSync(b.home).ino!==b.homeIno||!Array.isArray(b.markers)||b.markers.length!==2)fail();for(const name of ['.patrick-synthetic-auth','.patrick-synthetic-config']){const m=b.markers.find(m=>m.name===name),p=b.home+'/'+name,st=io.lstatSync(p);if(!m||st.isSymbolicLink()||!st.isFile()||st.uid!==0||st.gid!==0||(st.mode&0o777)!==0o444||st.ino!==m.ino||st.nlink!==1||st.size>128||createHash('sha256').update(io.readFileSync(p)).digest('hex')!==m.hash)fail();}if(exists(b.home+'/.patrick-synthetic-scratch',io))fail();
 if(enroll&&!session.records.includes(r.invocation)){if(session.records.length>=64)fail();if(r.kind!=='registered'||r.stages[0]?.stage!=='prepare'||r.sequence!==1)fail();session.records.push(r.invocation);write(QUALIFICATION,session,io);}return b;}
export function qualificationObservations(session,io){readRegistryAuthority(io,session.registry);if(!Array.isArray(session.records)||session.records.length>64)fail();const output=[];for(const invocation of session.records){if(!token(invocation))fail();const r=readRecord(invocation,io,session.registry);if(r.kind!=='registered'||r.admission.artifactHash!==session.artifactHash||r.admission.policyHash!==session.policyHash)fail();for(const s of r.stages){if(!s.observation||!s.invocationId||!s.controlGroup||!observationValid(s.observation))fail();output.push({stage:s.stage,profile:s.profile,role:r.context.runner,postDrop:s.observation.postDrop,profileFacts:s.observation.profileFacts,outcome:{phase:s.phase,code:s.code,submitterExited:s.submitterExited,invocationClosed:r.state==='closed'}});}}return output;}
export function inspectTrustedStage({stage,record,command:expectedCommand,phase,witness},deps){
 if(!deps?.io||typeof deps.unitFacts!=='function'||!['direct','post'].includes(phase)||!contextValid(record?.context)||!identityValid(record.context,{...record.identity,groups:[]})||!stages.includes(stage?.stage)||stage.profile!==profileFor(stage.stage)||!/^patrick-worker-[a-f0-9]{32}-[1-6]\.service$/.test(stage.unit))fail();const io=deps.io;
 const facts=deps.unitFacts(stage.unit);if(!managerMatch(stage,facts)||!facts.active||facts.mainPid<=1)fail();const pid=facts.mainPid,base='/proc/'+pid,stat=io.readFileSync(base+'/stat','utf8'),start=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19];if(!/^[1-9]\d{0,19}$/.test(start)||witness&&(witness.pid!==pid||witness.start!==start))fail();
 const status=io.readFileSync(base+'/status','utf8'),row=key=>{const rows=status.split('\n').filter(l=>l.startsWith(key+':'));if(rows.length!==1)fail();return rows[0].slice(key.length+1).trim();};
 const ids=key=>{const values=row(key).split(/\s+/);if(values.length!==4||values.some(v=>!/^\d+$/.test(v)))fail();return values.map(Number);};if(ids('Uid').some(v=>v!==record.identity.uid)||ids('Gid').some(v=>v!==record.identity.gid)||row('Groups')!==''||row('NoNewPrivs')!=='1')fail();
 const caps={};for(const [key,field]of Object.entries({CapEff:'capEffective',CapPrm:'capPermitted',CapInh:'capInheritable',CapAmb:'capAmbient',CapBnd:'capBounding'})){const value=row(key).toLowerCase();if(!/^0{1,16}$/.test(value))fail();caps[field]=value;}
 if(io.readFileSync(base+'/cgroup','utf8')!=='0::'+stage.controlGroup+'\n')fail();
 const original=['prepare','read','tests','cleanup'].includes(stage.stage)?['/usr/local/bin/node',...expectedCommand.slice(1)]:expectedCommand;
 const nodeArgs=['/usr/local/bin/node','--no-addons','--disable-warning=ExperimentalWarning','-e',execGateProgram,'--',...original];
 const expected=phase==='direct'?['/usr/bin/dash','-c',gateWrapper,'patrick-worker',...nodeArgs]:nodeArgs;
 const cmdline=io.readFileSync(base+'/cmdline');if(cmdline.length>1048576||cmdline[cmdline.length-1]!==0||!same(cmdline.subarray(0,-1).toString().split('\0'),expected)||io.realpathSync(base+'/exe')!==io.realpathSync(phase==='direct'?'/usr/bin/dash':'/usr/local/bin/node'))fail();
 const environment=io.readFileSync(base+'/environ');if(environment.length>65536||environment[environment.length-1]!==0)fail();const env={};for(const value of environment.subarray(0,-1).toString().split('\0')){const i=value.indexOf('=');if(i<1||Object.hasOwn(env,value.slice(0,i)))fail();env[value.slice(0,i)]=value.slice(i+1);}
 const h=record.identity.home,port=record.admission.proxyPort,expectedEnv={HOME:h,USER:record.context.user,LOGNAME:record.context.user,PATH:'/usr/local/bin:/usr/bin:/bin',TMPDIR:'/tmp',HTTP_PROXY:'http://127.0.0.1:'+port,HTTPS_PROXY:'http://127.0.0.1:'+port,NO_PROXY:''};
 const extra=Object.keys(env).filter(k=>!Object.hasOwn(expectedEnv,k));if(Object.entries(expectedEnv).some(([k,v])=>env[k]!==v)||extra.some(k=>phase==='direct'||!['PWD','OLDPWD'].includes(k))||Object.hasOwn(env,'PWD')&&env.PWD!==h||Object.hasOwn(env,'OLDPWD')&&env.OLDPWD!=='/')fail();
 if(io.readlinkSync(base+'/cwd')!==(phase==='direct'?'/':h))fail();
 const root=base+'/root',homeStat=io.lstatSync(root+h),workspaceStat=io.lstatSync(root+record.layout.path);if(!homeStat.isDirectory()||homeStat.isSymbolicLink()||homeStat.uid!==record.identity.uid||homeStat.gid!==record.identity.gid||(homeStat.mode&0o777)!==0o700||!workspaceStat.isDirectory()||workspaceStat.isSymbolicLink()||workspaceStat.ino!==record.layout.workIno||workspaceStat.uid!==record.identity.uid||workspaceStat.gid!==record.identity.gid)fail();
 const task=stage.profile==='task-only',netDifferent=io.readlinkSync(base+'/ns/net')!==io.readlinkSync('/proc/self/ns/net');if(task!==netDifferent)fail();
 if(task){const volume=io.statfsSync(root+h);if(!['bsize','blocks','files'].every(k=>Number.isSafeInteger(volume[k])&&volume[k]>0)||volume.bsize*volume.blocks>16*1024*1024||volume.files>1024||io.readdirSync(root+h).length!==0)fail();const mounts=io.readFileSync(base+'/mountinfo','utf8');if(Buffer.byteLength(mounts)>1048576||/virtiofs|\s9p\s/.test(mounts)||mounts.split('\n').filter(l=>l.split(' - ')[0].split(' ')[4]===h&&l.split(' - ')[1]?.startsWith('tmpfs ')).length!==1||io.statfsSync(root+h).type!==0x01021994||io.readFileSync(base+'/net/route','utf8').trim().split('\n').length!==1)fail();}
 let b,markerUnchanged=true;try{b=qualificationSession(record,io,false);}catch(error){if(stage.stage!=='cleanup')throw error;markerUnchanged=false;}let markerReadable=false;if(b){for(const name of ['.patrick-synthetic-auth','.patrick-synthetic-config']){const p=root+h+'/'+name;if(task){if(exists(p,io))fail();}else{const st=io.lstatSync(p),m=b.markers.find(m=>m.name===name);if(st.ino!==m.ino)fail();markerReadable=true;}}}
 return {pid,start,directEnvironmentClean:phase==='direct',postDrop:{uid:record.identity.uid,gid:record.identity.gid,groups:[],noNewPrivileges:true,...caps,homeMatches:true,fixedEnvironmentMatches:true,extraEnvironmentKeys:extra,unknownEnvironmentKeyPresent:false,derivedPwdMatchesHome:!Object.hasOwn(env,'PWD')||env.PWD===h,derivedOldPwdMatchesTrustedCwd:!Object.hasOwn(env,'OLDPWD')||env.OLDPWD==='/'},profileFacts:{persistentMarkerReadable:markerReadable,persistentMarkerUnchanged:markerUnchanged,persistentConfigUnchanged:markerUnchanged,privateHomeWritable:!task,privateScratchRemoved:!exists(root+h+'/.patrick-synthetic-scratch',io),workspaceMatchesRecord:true,closedNetworkObserved:task}};
}
async function waitBoundary(stage,record,command,phase,witness){const end=Date.now()+3000;do{try{return inspectTrustedStage({stage,record,command,phase,witness},{io:fs,unitFacts});}catch{}await new Promise(r=>setTimeout(r,10));}while(Date.now()<end);fail();}
export function productionManager(){return {
 submit:spec=>{
  const environment=command('/usr/bin/systemctl',['show-environment']).split('\n').filter(Boolean).map(line=>{const i=line.indexOf('=');if(i<1||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0,i)))fail();return line.slice(0,i);});if(environment.length>4096)fail();
  const args=[...spec.args],delimiter=args.indexOf('--');if(delimiter<0)fail();args.splice(delimiter,0,'--property=UnsetEnvironment='+[...new Set([...environment,'LD_PRELOAD','LD_LIBRARY_PATH','LD_AUDIT','NODE_OPTIONS','NODE_PATH','ENV','BASH_ENV','HOME','PATH','PWD','OLDPWD'])].join(' '));
  const child=spawn(spec.command,args,{cwd:'/',env:ADMIN_ENV,stdio:['pipe','pipe','pipe']});let released=false,advanced=false,earlyBytes=0;const earlyOut=[],earlyErr=[];const assertions=assertionCollector(spec.stage,chunk=>process.stderr.write(chunk));
  const capture=(chunks,chunk)=>{earlyBytes+=chunk.length;if(earlyBytes>1048576){child.kill('SIGKILL');return;}chunks.push(chunk);};
  const out=chunk=>capture(earlyOut,chunk),err=chunk=>capture(earlyErr,chunk);child.stdout.on('data',out);child.stderr.on('data',err);child.stdin.on('error',()=>{});
  const completion=new Promise(resolve=>{child.once('error',()=>resolve({code:null}));child.once('close',(code,signal)=>{process.stdin.unpipe(child.stdin);const proof=assertions.finish();resolve({code:signal||proof.invalid?null:code,assertion:proof.assertion});});});
  let witness=null;try{const stat=fs.readFileSync(`/proc/${child.pid}/stat`,'utf8'),start=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19];if(Number.isSafeInteger(child.pid)&&child.pid>1&&/^[1-9]\d{0,19}$/.test(start))witness={pid:child.pid,start};}catch{}
  return {completion,witness,advance:()=>{if(advanced||released||earlyBytes!==0)fail();advanced=true;child.stdin.write(releaseLine);},release:()=>{if(released||earlyBytes!==0)fail();released=true;child.stdout.off('data',out);child.stderr.off('data',err);child.stdout.pipe(process.stdout,{end:false});child.stderr.on('data',chunk=>assertions.write(chunk));child.stdin.write(advanced?payloadReleaseLine:releaseLine);process.stdin.pipe(child.stdin);},cancelInput:()=>{process.stdin.unpipe(child.stdin);child.stdin.destroy();}};
 },
 observeStage:async({stage,record,launch,command})=>{const direct=await waitBoundary(stage,record,command,'direct');launch.advance();const post=await waitBoundary(stage,record,command,'post',direct);post.directEnvironmentClean=direct.directEnvironmentClean;return post;},
 acknowledge:async unit=>{const end=Date.now()+3000;do{const facts=unitFacts(unit);if(facts)return facts;await new Promise(r=>setTimeout(r,10));}while(Date.now()<end);return null;},
 inspect:async unit=>unitFacts(unit),pending:async unit=>pendingUnit(unit),
 stop:async unit=>{command('/usr/bin/systemctl',['stop','--no-block',unit]);const end=Date.now()+3000;do{const facts=unitFacts(unit);if((!facts||!facts.active&&facts.empty)&&!pendingUnit(unit))return;await new Promise(r=>setTimeout(r,20));}while(Date.now()<end);fail();},
 };}
function mountRows(){const text=fs.readFileSync('/proc/self/mountinfo','utf8');if(Buffer.byteLength(text)>1048576)fail();return text.trim().split('\n').map(line=>{const halves=line.split(' - '),f=halves[0].split(' ');if(halves.length!==2||f.length<6||/[\\\n\r]/.test(f[3]+f[4]))fail();return {device:f[2],root:f[3],point:f[4],type:halves[1].split(' ')[0]};});}
function originalHomeAliases(home,rows){const candidates=rows.filter(row=>home===row.point||home.startsWith(row.point==='/'?'/':row.point+'/')).sort((a,b)=>b.point.length-a.point.length),base=candidates[0];if(!base)fail();const source=base.root.replace(/\/$/,'')+home.slice(base.point==='/'?0:base.point.length);return rows.some(row=>row!==base&&row.device===base.device&&(source===row.root||source.startsWith(row.root==='/'?'/':row.root+'/'))&&row.point.replace(/\/$/,'')+source.slice(row.root==='/'?0:row.root.length)!==home);}
function observeLinux(record){const uid=record.identity.uid;if(!numeric(uid))fail();let absent=true;const pids=fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p));if(pids.length>131072)fail();for(const pid of pids){let status;try{status=fs.readFileSync(`/proc/${pid}/status`,'utf8');}catch(e){if(e.code==='ENOENT')continue;throw e;}const rows=status.split('\n').filter(line=>line.startsWith('Uid:'));if(rows.length!==1)fail();const ids=rows[0].slice(4).trim().split(/\s+/);if(ids.length!==4||ids.some(id=>!/^\d+$/.test(id)))fail();if(ids.some(id=>Number(id)===uid))absent=false;}
 const mounts=mountRows(),units=command('/usr/bin/systemctl',['list-units','--all','--no-pager','--no-legend','--plain','patrick-worker-*.service']).trim().split('\n').filter(Boolean);if(units.length>256)fail();const known=new Set(['patrick-worker-firewall.service','patrick-worker-proxy.service',...record.stages.map(s=>s.unit)]);const cgroupsEmpty=units.every(line=>known.has(line.trim().split(/\s+/)[0]))&&record.stages.every(s=>cgroupEmpty(s.unit));const noResidual=fs.readdirSync('/tmp').every(name=>!name.startsWith('patrick-'));
 const privateMountsAbsent=cgroupsEmpty&&absent&&!mounts.some(row=>row.point===record.layout.root||row.point.startsWith(record.layout.root+'/'))&&!originalHomeAliases(record.identity.home,mounts)&&!mounts.some(row=>['virtiofs','9p'].includes(row.type));
 return {workerProcessesAbsent:absent&&noResidual,privateMountsAbsent,cgroupsEmpty};
}
export function productionLifetimeDependencies({trust,identity,admit,recover}){return {io:fs,effectiveUid:()=>process.geteuid?.(),trust,identity,admit,recover,manager:productionManager(),observe:observeLinux,boot:()=>{const id=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))fail();return id;},witness:()=>{const text=fs.readFileSync('/proc/self/stat','utf8'),end=text.lastIndexOf(')'),start=text.slice(end+2).trim().split(/\s+/)[19];if(!/^\d+$/.test(start))fail();return {pid:process.pid,start};}};}
// The administrative snapshot uses the identical filesystem mutex as payload
// registration and installation, with a distinct trusted owner context.
export async function withInstallMutex(deps,expected,operation){ensureRuntimeBase(deps,expected);const release=await lock(BASE+'/install.lock',deps,'probe');try{readRegistryAuthority(deps.io,expected);return await operation();}finally{release();}}
