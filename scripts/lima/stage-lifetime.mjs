// Fixed stage programs and root lifetime controller. Importing this file has no
// filesystem/process side effects; privileged callers trust it before import.
import * as fs from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { randomBytes } from 'node:crypto';
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
export const guestScripts=Object.freeze({prepare:taskGuard+prepareScript,tests:taskGuard+testsScript,read:taskGuard+readScript,cleanup:taskGuard+cleanupScript});

export const cliWrapper='cd "$1" && shift && exec "$@"';
export const releaseLine='patrick-stage-release\n';
export const gateWrapper='IFS= read -r patrick_gate && [ "$patrick_gate" = "patrick-stage-release" ] && cd -- "$HOME" && exec "$@"';
const BASE='/run/patrick-worker',REGISTRY=BASE+'/invocations',ROOT='/var/lib/patrick-workspaces';
const stages=['prepare','cli','read','tests','cleanup','acp'],states=['active','stopping','drained','cleaning','closed','quarantined'];
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
 for(let p=path;;p=dirname(p)){const s=io.lstatSync(p),leaf=p===path;if(s.isSymbolicLink()||s.uid!==(leaf?uid:0)||(leaf?kind==='directory'?!s.isDirectory():!s.isFile():!s.isDirectory())||(leaf&&gid!==undefined&&s.gid!==gid)||(leaf&&mode!==undefined&&(s.mode&0o777)!==mode)||(!leaf&&(s.mode&0o022)))fail();if(p==='/')break;}
}
function read(path,io){trustPath(path,io,{kind:'file',mode:0o600});const fd=io.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const s=io.fstatSync(fd);if(!s.isFile()||s.uid!==0||(s.mode&0o777)!==0o600||s.size>131072)fail();const bytes=io.readFileSync(fd);if(!Buffer.isBuffer(bytes)||bytes.length>131072||!isUtf8(bytes))fail();return JSON.parse(bytes.toString('utf8'));}finally{io.closeSync(fd);}}
function syncDir(path,io){const fd=io.openSync(path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{io.fsyncSync(fd);}finally{io.closeSync(fd);}}
function write(path,value,io,exclusive=false){const temp=exclusive?path:`${path}.${randomBytes(16).toString('hex')}.tmp`;let fd;
 try{fd=io.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);io.writeFileSync(fd,JSON.stringify(value)+'\n');io.fsyncSync(fd);io.closeSync(fd);fd=undefined;if(!exclusive)io.renameSync(temp,path);syncDir(dirname(path),io);}catch(e){if(fd!==undefined)io.closeSync(fd);throw e;}}
function recordValid(r){
 if(!exact(r,['version','invocation','context','identity','admission','boot','generation','state','payloadSealed','cleanupConsumed','sequence','stages','layout','baseline','drain','cleanupConfirmed'])||r.version!==1||!token(r.invocation)||!contextValid(r.context)||!identityValid(r.context,{...r.identity,groups:[]})||!exact(r.identity,['uid','gid','home'])||!exact(r.admission,['policyHash','artifactHash','proxyPort'])||!digest(r.admission.policyHash)||!digest(r.admission.artifactHash)||!Number.isSafeInteger(r.admission.proxyPort)||r.admission.proxyPort<1024||r.admission.proxyPort>65535||!token(r.generation)||typeof r.boot!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(r.boot)||!states.includes(r.state)||typeof r.payloadSealed!=='boolean'||typeof r.cleanupConsumed!=='boolean'||typeof r.cleanupConfirmed!=='boolean'||!Number.isSafeInteger(r.sequence)||r.sequence<1||r.sequence>6||!Array.isArray(r.stages)||r.stages.length!==r.sequence||!exact(r.layout,['root','path','rootIno','workIno','status'])||r.layout.root!==ROOT+'/'+r.invocation||r.layout.path!==r.layout.root+'/work'||!['intended','allocated','removed'].includes(r.layout.status)||!exact(r.baseline,['workerProcessesAbsent','privateMountsAbsent','cgroupsEmpty'])||!Object.values(r.baseline).every(v=>v===true))fail();
 for(const [i,s]of r.stages.entries())if(!exact(s,['stage','profile','sequence','unit','description','phase','invocationId','controlGroup','submission','submitterExited','code'])||!stages.includes(s.stage)||s.profile!==profileFor(s.stage)||s.sequence!==i+1||s.unit!==`patrick-worker-${r.generation}-${i+1}.service`||s.description!==`patrick-worker:${r.generation}:${r.invocation}:${i+1}`||!['pending','acknowledged','complete','unknown','cancelled'].includes(s.phase)||!(s.invocationId===null||token(s.invocationId))||!(s.controlGroup===null||s.controlGroup==='/system.slice/'+s.unit)||!(s.submission===null||exact(s.submission,['pid','start'])&&Number.isSafeInteger(s.submission.pid)&&s.submission.pid>1&&/^[1-9]\d{0,19}$/.test(s.submission.start))||typeof s.submitterExited!=='boolean'||!(s.code===null||Number.isInteger(s.code)))fail();
 const inode=n=>Number.isSafeInteger(n)&&n>0;
 if(!(r.layout.rootIno===null||inode(r.layout.rootIno))||!(r.layout.workIno===null||inode(r.layout.workIno))||r.layout.status!=='intended'&&(!inode(r.layout.rootIno)||!inode(r.layout.workIno))||!(r.drain===null||exact(r.drain,['generation','sequence'])&&r.drain.generation===r.generation&&Number.isSafeInteger(r.drain.sequence)&&r.drain.sequence>=1&&r.drain.sequence<=r.sequence)||r.state==='active'&&r.payloadSealed||r.state!=='active'&&!r.payloadSealed)fail();
 const purposes=r.stages.map(s=>s.stage),cleanup=r.stages.find(s=>s.stage==='cleanup');
 if(purposes[0]!=='prepare'||new Set(purposes).size!==purposes.length||cleanup&&purposes.at(-1)!=='cleanup'||r.cleanupConsumed!==Boolean(cleanup)||r.cleanupConfirmed&&(!r.cleanupConsumed||!r.drain||cleanup.code!==0||cleanup.phase!=='complete')||r.stages.some(s=>(s.invocationId===null)!==(s.controlGroup===null)||['acknowledged','complete'].includes(s.phase)&&!s.invocationId))fail();
 const payload=purposes.filter(p=>p!=='cleanup'),normal=r.context.runner==='dsh'?['prepare','acp','tests']:r.context.runner==='codex'?['prepare','cli','read','tests']:['prepare','cli','tests'];
 if(!same(payload,normal.slice(0,payload.length)))fail();
 if(r.state==='closed' &&(!r.payloadSealed||!r.cleanupConfirmed||r.layout.status!=='removed'||r.stages.some(s=>!['complete','cancelled'].includes(s.phase))))fail();return r;
}
function recordPath(invocation){if(!token(invocation))fail();return `${REGISTRY}/${invocation}.json`;}
function readRecord(invocation,io){const record=recordValid(read(recordPath(invocation),io));if(record.invocation!==invocation)fail();return record;}
function save(r,deps,exclusive=false){recordValid(r);try{write(recordPath(r.invocation),r,deps.io,exclusive);}catch{throw Object.assign(new Error('Worker entry denied.'),{retainUidLock:true});}}
export function registryQuiescent(io){
 if(!exists(REGISTRY,io))return true;trustPath(REGISTRY,io,{mode:0o700});
 // Closed tokens remain replay tombstones. Stream exact validation so ordinary
 // history uses bounded memory without imposing a total-job admission ceiling.
 const directory=io.opendirSync(REGISTRY,{bufferSize:32});try{let entry;while((entry=directory.readSync())!==null){const name=entry.name;if(!/^[a-f0-9]{32}\.json$/.test(name))fail();if(readRecord(name.slice(0,32),io).state!=='closed')return false;}return true;}finally{directory.closeSync();}
}
async function lock(path,deps,kind){trustPath(BASE,deps.io,{mode:0o700});const end=Date.now()+Math.min(deps.lockTimeoutMs??1500,2000);let owner;
 while(true){try{deps.io.mkdirSync(path,{mode:0o700});break;}catch(e){if(e.code!=='EEXIST'||Date.now()>=end)fail();await new Promise(r=>setTimeout(r,10));}}
 try{owner={version:1,kind,boot:deps.boot(),...deps.witness(),nonce:randomBytes(16).toString('hex')};write(path+'/owner.json',owner,deps.io,true);}catch{fail();}
 return ()=>{trustPath(path,deps.io,{mode:0o700});if(!same(deps.io.readdirSync(path),['owner.json'])||!same(read(path+'/owner.json',deps.io),owner))fail();deps.io.unlinkSync(path+'/owner.json');syncDir(path,deps.io);deps.io.rmdirSync(path);syncDir(BASE,deps.io);};
}
async function locked(deps,uid,global,fn){let releaseGlobal,releaseUid,retainUid=false;try{if(global)releaseGlobal=await lock(BASE+'/install.lock',deps,'stage');releaseUid=await lock(BASE+`/uid-${uid}.lock`,deps,'stage');return await fn();}catch(error){retainUid=error?.retainUidLock===true;throw error;}finally{try{if(!retainUid)releaseUid?.();}finally{releaseGlobal?.();}}}
function bound(r,request,deps){if(!same(r.context,request.context)||r.boot!==deps.boot())fail();const current=deps.identity(request.context);if(!identityValid(request.context,current)||!same(r.identity,{uid:current.uid,gid:current.gid,home:current.home}))fail();return current;}
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
function result(r,facts,reason='unknown'){return Object.freeze({version:1,state:r?.state??'quarantined',cgroupsEmpty:facts?.cgroupsEmpty===true,workerProcessesAbsent:facts?.workerProcessesAbsent===true,workspacesAbsent:r?.layout.status==='removed',privateMountsAbsent:facts?.privateMountsAbsent===true,invocationClosed:r?.state==='closed',reason:r?.state==='closed'?'ok':reason});}
async function admissionMatches(r,request,deps){try{const admission=await deps.admit(request.context,['node']);return admission.policyHash===r.admission.policyHash&&admission.artifactHash===r.admission.artifactHash&&identityValid(request.context,admission.entry)&&same(r.identity,{uid:admission.entry.uid,gid:admission.entry.gid,home:admission.entry.home});}catch{return false;}}
async function control(request,deps,account){return locked(deps,account.uid,false,async()=>{
 let r;try{r=readRecord(request.lifetime.invocation,deps.io);bound(r,request,deps);if(r.state==='closed')return result(r,observed(deps,r),'ok');
 if(request.lifetime.operation==='stop'){r.payloadSealed=true;r.state='stopping';save(r,deps);const units=await reconcileUnits(r,deps,true),facts=observed(deps,r);if(units==='empty'&&empty(facts)){r.state='drained';r.drain={generation:r.generation,sequence:r.sequence};}else r.state='quarantined';save(r,deps);return result(r,facts,units==='empty'&&empty(facts)?'ok':'unknown');}
 const units=await reconcileUnits(r,deps,false),facts=observed(deps,r);if(units==='active'&&r.state==='active'&&!r.payloadSealed)return result(r,facts,'active');if(units!=='empty'||!empty(facts)){r.payloadSealed=true;r.state='quarantined';save(r,deps);return result(r,facts,'unknown');}
 // Observation never manufactures stop's persisted drain receipt.
 if(r.payloadSealed&&r.drain&&r.cleanupConsumed&&r.cleanupConfirmed&&r.stages.find(s=>s.stage==='cleanup')?.code===0&&await admissionMatches(r,request,deps)){
 if(r.layout.status!=='removed'){layout(r,deps,false);if(deps.io.readdirSync(r.layout.root).length){save(r,deps);return result(r,facts,'workspace_residual');}deps.io.rmdirSync(r.layout.root);syncDir(ROOT,deps.io);r.layout.status='removed';}
 r.state='closed';save(r,deps);return result(r,facts,'ok');}
 save(r,deps);return result(r,facts,r.layout.status==='removed'?'unknown':'workspace_residual');
 }catch{if(r&&same(r.context,request.context)){try{r.payloadSealed=true;r.state='quarantined';save(r,deps);}catch(error){if(error?.retainUidLock)throw error;}}return result(r,undefined,'unknown');}
 });}
export async function executeStage(request,deps){requestValid(request);if(deps.effectiveUid()!==0)fail();deps.trust();let account;try{account=deps.identity(request.context);}catch{if(request.lifetime.operation!=='exec')return result(undefined,undefined,'unknown');fail();}if(!identityValid(request.context,account)){
 if(request.lifetime.operation!=='exec')return result(undefined,undefined,'unknown');fail();}
 if(request.lifetime.operation!=='exec'){try{return await control(request,deps,account);}catch{return result(undefined,undefined,'control_unavailable');}}
 envelope(request);const cleanup=request.lifetime.stage==='cleanup';let launched,recordGeneration,sequence;
 await locked(deps,account.uid,!cleanup,async()=>{
 trustPath(REGISTRY,deps.io,{mode:0o700});let r;const path=recordPath(request.lifetime.invocation);
 if(exists(path,deps.io)){r=readRecord(request.lifetime.invocation,deps.io);bound(r,request,deps);}else if(request.lifetime.stage!=='prepare')fail();
 let admission;
 if(cleanup){if(!r||r.state!=='drained'||!r.payloadSealed||!r.drain||r.drain.generation!==r.generation||r.drain.sequence!==r.sequence||r.cleanupConsumed||!empty(observed(deps,r))||(await reconcileUnits(r,deps,false))!=='empty')fail();layout(r,deps);admission={entry:{...r.context,...r.identity,proxyPort:r.admission.proxyPort,command:request.command}};r.state='cleaning';r.cleanupConsumed=true;}
 else {if(r&&(r.state!=='active'||r.payloadSealed))fail();admission=await deps.admit(request.context,request.command);if(!identityValid(request.context,admission.entry)||!same({uid:admission.entry.uid,gid:admission.entry.gid,home:admission.entry.home},{uid:account.uid,gid:account.gid,home:account.home})||!digest(admission.policyHash)||!digest(admission.artifactHash))fail();
 if(r){if(!same(r.admission,{policyHash:admission.policyHash,artifactHash:admission.artifactHash,proxyPort:admission.entry.proxyPort}))fail();order(r,request.lifetime.stage);layout(r,deps);}else{
 if(!registryQuiescent(deps.io))fail();trustPath(ROOT,deps.io);const baseline=observed(deps,{context:request.context,identity:account,stages:[],layout:{root:ROOT+'/'+request.lifetime.invocation,path:ROOT+'/'+request.lifetime.invocation+'/work'}});if(!empty(baseline)||deps.io.readdirSync(ROOT).length)fail();
 r={version:1,invocation:request.lifetime.invocation,context:request.context,identity:{uid:account.uid,gid:account.gid,home:account.home},admission:{policyHash:admission.policyHash,artifactHash:admission.artifactHash,proxyPort:admission.entry.proxyPort},boot:deps.boot(),generation:randomBytes(16).toString('hex'),state:'active',payloadSealed:false,cleanupConsumed:false,sequence:0,stages:[],layout:{root:ROOT+'/'+request.lifetime.invocation,path:ROOT+'/'+request.lifetime.invocation+'/work',rootIno:null,workIno:null,status:'intended'},baseline,drain:null,cleanupConfirmed:false};
 }}
 const s={stage:request.lifetime.stage,profile:request.lifetime.profile,sequence:++r.sequence,unit:`patrick-worker-${r.generation}-${r.sequence}.service`,description:`patrick-worker:${r.generation}:${r.invocation}:${r.sequence}`,phase:'pending',invocationId:null,controlGroup:null,submission:null,submitterExited:false,code:null};r.stages.push(s);save(r,deps,!exists(path,deps.io));recordGeneration=r.generation;sequence=s.sequence;
 try{
 if(r.layout.status==='intended'){if(exists(r.layout.root,deps.io))fail();deps.io.mkdirSync(r.layout.root,{mode:0o700});deps.io.chownSync(r.layout.root,account.uid,account.gid);r.layout.rootIno=deps.io.lstatSync(r.layout.root).ino;save(r,deps);deps.io.mkdirSync(r.layout.path,{mode:0o700});deps.io.chownSync(r.layout.path,account.uid,account.gid);r.layout.workIno=deps.io.lstatSync(r.layout.path).ino;r.layout.status='allocated';syncDir(r.layout.root,deps.io);syncDir(ROOT,deps.io);save(r,deps);layout(r,deps);}
 const spec=buildServiceInvocation(admission.entry,request.lifetime,{unit:s.unit,description:s.description,workspace:r.layout.path});launched=deps.manager.submit({...spec,unit:s.unit,description:s.description,stage:s.stage,workspace:r.layout.path});s.submission=launched.witness??null;save(r,deps);
 // Always observe process completion, including acknowledgement failure.
 launched.completion.then(outcome=>finish(request,deps,recordGeneration,sequence,outcome),()=>finish(request,deps,recordGeneration,sequence,{code:null})).catch(()=>{});
 const facts=await deps.manager.acknowledge(s.unit);if(!managerMatch(s,facts))fail();s.invocationId=facts.invocationId;s.controlGroup=facts.controlGroup;s.phase='acknowledged';save(r,deps);launched.release?.();
 }catch{r.payloadSealed=true;r.state='quarantined';save(r,deps);launched?.cancelInput?.();throw new Error('Worker entry denied.');}
 });
 const outcome=await launched.completion,confirmed=await finish(request,deps,recordGeneration,sequence,outcome);if(outcome.code!==0||!confirmed)fail();return outcome;
}
async function finish(request,deps,generation,sequence,outcome){const a=deps.identity(request.context);if(!identityValid(request.context,a))fail();return locked(deps,a.uid,false,async()=>{const r=readRecord(request.lifetime.invocation,deps.io);bound(r,request,deps);if(r.state==='closed')return true;if(r.generation!==generation)fail();const s=r.stages[sequence-1];if(!s||s.sequence!==sequence)fail();s.submitterExited=true;s.code=Number.isInteger(outcome.code)?outcome.code:null;const facts=await deps.manager.inspect(s.unit),observation=observed(deps,r);
 let confirmed=Boolean(s.invocationId&&(!facts||managerMatch(s,facts)&&!facts.active&&facts.empty)&&!(await deps.manager.pending(s.unit))&&empty(observation));
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
 const command=['prepare','read','tests','cleanup'].includes(lifetime.stage)?['/usr/local/bin/node',...entry.command.slice(1)]:entry.command;const drop=buildDropInvocation({...entry,command},gateWrapper);
 return {command:'/usr/bin/systemd-run',args:['--quiet','--pipe','--wait','--collect','--service-type=exec',`--unit=${owned.unit}`,...properties.map(p=>'--property='+p),'--',drop.command,...drop.args]};
}
// Production uses only fixed Linux control commands and kernel observations.
// Test callers supply the complete owned io/manager object to executeStage;
// there is no per-method fallback into these production paths.
const ADMIN_ENV=Object.freeze({PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C'});
function command(path,args){const r=spawnSync(path,args,{encoding:'utf8',timeout:750,maxBuffer:1048576,cwd:'/',env:ADMIN_ENV,stdio:['ignore','pipe','pipe']});if(r.error||r.signal||r.status!==0||typeof r.stdout!=='string'||Buffer.byteLength(r.stdout)>1048576)fail();return r.stdout;}
function cgroupEmpty(unit){const directory='/sys/fs/cgroup/system.slice/'+unit;if(!exists(directory,fs))return true;trustPath(directory,fs);const events=fs.readFileSync(directory+'/cgroup.events','utf8');const rows=events.trim().split('\n').filter(line=>line.startsWith('populated '));if(rows.length!==1||!/^populated [01]$/.test(rows[0]))fail();return rows[0]==='populated 0';}
function unitFacts(unit){if(!/^patrick-worker-[a-f0-9]{32}-[1-6]\.service$/.test(unit))fail();
 const text=command('/usr/bin/systemctl',['show',unit,'--no-pager','--property=Description,InvocationID,ControlGroup,ActiveState,SubState,LoadState,User,Group,DropInPaths,FragmentPath']),fields={};for(const row of text.trim().split('\n')){const i=row.indexOf('=');if(i<1||Object.hasOwn(fields,row.slice(0,i)))fail();fields[row.slice(0,i)]=row.slice(i+1);}
 if(!exact(fields,['Description','InvocationID','ControlGroup','ActiveState','SubState','LoadState','User','Group','DropInPaths','FragmentPath']))fail();if(fields.LoadState==='not-found'){if(fields.InvocationID||fields.ControlGroup||!cgroupEmpty(unit))fail();return null;}
 if(fields.LoadState!=='loaded'||fields.User!=='root'||fields.Group!=='root'||fields.DropInPaths!==''||fields.FragmentPath!=='/run/systemd/transient/'+unit||!token(fields.InvocationID)||!(fields.ControlGroup==='/system.slice/'+unit||fields.ControlGroup===''&&['inactive','failed'].includes(fields.ActiveState)&&cgroupEmpty(unit)))fail();
 return {description:fields.Description,invocationId:fields.InvocationID,controlGroup:'/system.slice/'+unit,active:!['inactive','failed'].includes(fields.ActiveState),empty:cgroupEmpty(unit)};
}
function pendingUnit(unit){const rows=command('/usr/bin/systemctl',['list-jobs','--no-pager','--no-legend','--plain']).trim().split('\n').filter(Boolean);if(rows.length>4096)fail();return rows.some(row=>row.trim().split(/\s+/)[1]===unit);}
export function productionManager(){return {
 submit:spec=>{
  const environment=command('/usr/bin/systemctl',['show-environment']).split('\n').filter(Boolean).map(line=>{const i=line.indexOf('=');if(i<1||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0,i)))fail();return line.slice(0,i);});if(environment.length>4096)fail();
  const args=[...spec.args],delimiter=args.indexOf('--');if(delimiter<0)fail();args.splice(delimiter,0,'--property=UnsetEnvironment='+[...new Set([...environment,'LD_PRELOAD','LD_LIBRARY_PATH','LD_AUDIT','NODE_OPTIONS','NODE_PATH','ENV','BASH_ENV','HOME','PATH','PWD','OLDPWD'])].join(' '));
  const child=spawn(spec.command,args,{cwd:'/',env:ADMIN_ENV,stdio:['pipe','pipe','pipe']});let released=false,earlyBytes=0;const earlyOut=[],earlyErr=[];
  const capture=(chunks,chunk)=>{earlyBytes+=chunk.length;if(earlyBytes>1048576){child.kill('SIGKILL');return;}chunks.push(chunk);};
  const out=chunk=>capture(earlyOut,chunk),err=chunk=>capture(earlyErr,chunk);child.stdout.on('data',out);child.stderr.on('data',err);child.stdin.on('error',()=>{});
  const completion=new Promise(resolve=>{child.once('error',()=>resolve({code:null}));child.once('close',(code,signal)=>{process.stdin.unpipe(child.stdin);resolve({code:signal?null:code});});});
  let witness=null;try{const stat=fs.readFileSync(`/proc/${child.pid}/stat`,'utf8'),start=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19];if(Number.isSafeInteger(child.pid)&&child.pid>1&&/^[1-9]\d{0,19}$/.test(start))witness={pid:child.pid,start};}catch{}
  return {completion,witness,release:()=>{if(released||earlyBytes!==0)fail();released=true;child.stdout.off('data',out);child.stderr.off('data',err);child.stdout.pipe(process.stdout,{end:false});child.stderr.pipe(process.stderr,{end:false});child.stdin.write(releaseLine);process.stdin.pipe(child.stdin);},cancelInput:()=>{process.stdin.unpipe(child.stdin);child.stdin.destroy();}};
 },
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
export function productionLifetimeDependencies({trust,identity,admit}){return {io:fs,effectiveUid:()=>process.geteuid?.(),trust,identity,admit,manager:productionManager(),observe:observeLinux,boot:()=>{const id=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))fail();return id;},witness:()=>{const text=fs.readFileSync('/proc/self/stat','utf8'),end=text.lastIndexOf(')'),start=text.slice(end+2).trim().split(/\s+/)[19];if(!/^\d+$/.test(start))fail();return {pid:process.pid,start};}};}
// The administrative snapshot uses the identical filesystem mutex as payload
// registration and installation, with a distinct trusted owner context.
export async function withInstallMutex(deps,operation){const release=await lock(BASE+'/install.lock',deps,'probe');try{return await operation();}finally{release();}}
