#!/usr/local/bin/node
import * as fs from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const deny=()=>{throw new Error('Worker entry denied.');};
const policyPath='/etc/patrick-worker/policy.json';
const modulePath=fileURLToPath(import.meta.url);
let parsePolicy,validateContext,validateEntry,validateAccounts,lifecycle;
export async function loadTrustedPolicy(deps) {
  try {
    if(deps.effectiveUid()!==0)deny();
    deps.trust();return await deps.load();
  } catch {deny();}
}
export function parseArguments(argv) {
  if(!Array.isArray(argv))deny();
  const fields=['--runner','--user','--project','--domain','--invocation','--stage','--operation'];
  if(argv.length<15||fields.some((field,index)=>argv[index*2]!==field)||argv[14]!=='--')deny();
  const context={runner:argv[1],user:argv[3],projectId:argv[5],domain:argv[7]};validateContext(context);
  const lifetime={invocation:argv[9],stage:argv[11],profile:lifecycle.profileFor(argv[11]),operation:argv[13]},command=argv.slice(15);
  if(!/^[a-f0-9]{32}$/.test(lifetime.invocation)||!['exec','stop','reconcile'].includes(lifetime.operation)||command.some(arg=>typeof arg!=='string'||arg.includes('\0'))||lifetime.operation==='exec'&&(!command.length||!command[0])||lifetime.operation!=='exec'&&command.length)deny();
  return {context:Object.freeze(context),lifetime:Object.freeze(lifetime),command};
}
export function buildInvocation(entry) { return lifecycle.buildDropInvocation(entry); }
export function assertTrustedPath(path,{kind,uid,gid,private:privateMode=false},io=fs) {
  if(typeof path!=='string'||!path.startsWith('/')||resolve(path)!==path)deny();
  const chain=[];for(let current=path;;current=dirname(current)){chain.unshift(current);if(current==='/')break;}
  for(const current of chain) {
    const info=io.lstatSync(current),leaf=current===path;
    if(info.isSymbolicLink()||info.uid!==(leaf?uid:0)||(info.mode&0o022)!==0||(leaf?kind==='file'?!info.isFile():!info.isDirectory():!info.isDirectory()))deny();
    if(leaf&&gid!==undefined&&info.gid!==gid)deny();
    if(leaf&&privateMode&&(info.mode&0o077)!==0)deny();
  }
}
export function readTrustedFile(path,max=1048576,io=fs) {
  assertTrustedPath(path,{kind:'file',uid:0},io);
  const fd=io.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const stat=io.fstatSync(fd);if(!stat.isFile()||stat.uid!==0||(stat.mode&0o022)!==0||stat.size>max)deny();
    const data=io.readFileSync(fd,'utf8');if(Buffer.byteLength(data)>max)deny();return data;
  } finally {io.closeSync(fd);}
}
const canonical=value=>JSON.stringify(sortKeys(value));
function sortKeys(value) {return Array.isArray(value)?value.map(sortKeys):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sortKeys(value[key])])):value;}
function normalizeNft(raw) {
  if(!raw||Object.keys(raw).length!==1||!Array.isArray(raw.nftables)||raw.nftables.length>32)deny();
  let metadataCount=0;
  const entries=raw.nftables.flatMap(item=>{
    if(!item||typeof item!=='object'||Object.keys(item).length!==1)deny();
    const [type]=Object.keys(item);if(type==='metainfo'){
      const metadata=item.metainfo;
      if(++metadataCount!==1||!metadata||Object.keys(metadata).length!==3||!['version','release_name','json_schema_version'].every(key=>Object.hasOwn(metadata,key))||typeof metadata.version!=='string'||!/^\d+\.\d+\.\d+$/.test(metadata.version)||typeof metadata.release_name!=='string'||metadata.release_name.length>256||metadata.json_schema_version!==1)deny();return [];
    }
    if(!['table','chain','rule'].includes(type))deny();
    const value={...item[type]};if(Object.hasOwn(value,'handle')){if(!Number.isSafeInteger(value.handle)||value.handle<0)deny();delete value.handle;}
    return [{[type]:value}];
  });
  if(metadataCount!==1)deny();return entries;
}
const match=(left,right)=>({match:{op:'==',left,right}});
export function assertReadiness(nft,proxy,policy,accounts) {
  const parsed=parsePolicy(policy);validateAccounts(parsed,accounts);
  const base={family:'inet',table:'patrick_worker'};
  const expected=[{table:{family:'inet',name:'patrick_worker'}},{chain:{...base,name:'output',type:'filter',hook:'output',prio:-50,policy:'accept'}}];
  for(const worker of parsed.workers)expected.push({chain:{...base,name:`${worker.runner}_out`}});
  for(const worker of parsed.workers) {
    expected.push({rule:{...base,chain:'output',expr:[match({meta:{key:'skuid'}},accounts[worker.user].uid),{jump:{target:`${worker.runner}_out`}}]}});
    expected.push({rule:{...base,chain:`${worker.runner}_out`,expr:[match({meta:{key:'oifname'}},'lo'),match({payload:{protocol:'ip',field:'daddr'}},'127.0.0.1'),match({payload:{protocol:'tcp',field:'dport'}},worker.proxyPort),{accept:null}]}});
    expected.push({rule:{...base,chain:`${worker.runner}_out`,expr:[{reject:{type:'icmpx',expr:'admin-prohibited'}}]}});
  }
  // Order is significant within each chain; table/chain declaration order is not.
  const actual=normalizeNft(nft);
  const declarations=value=>value.filter(item=>!item.rule).map(canonical).sort();
  if(canonical(declarations(actual))!==canonical(declarations(expected)))deny();
  for(const chain of ['output',...parsed.workers.map(worker=>`${worker.runner}_out`)])if(canonical(actual.filter(item=>item.rule?.chain===chain))!==canonical(expected.filter(item=>item.rule?.chain===chain)))deny();
  if(actual.filter(item=>item.rule).length!==expected.filter(item=>item.rule).length)deny();
  const account=accounts[parsed.proxyUser];
  if(!proxy||proxy.user!==parsed.proxyUser||proxy.uid!==account.uid||proxy.gid!==account.gid||!Array.isArray(proxy.groups)||proxy.groups.length>1||proxy.groups.some(gid=>gid!==account.gid)||!Number.isSafeInteger(proxy.mainPid)||proxy.mainPid<=1||proxy.activeState!=='active'||proxy.subState!=='running'||!Array.isArray(proxy.listeners)||proxy.listeners.length!==parsed.workers.length)deny();
  for(const worker of parsed.workers)if(proxy.listeners.filter(listener=>listener.address==='127.0.0.1'&&listener.port===worker.proxyPort&&listener.uid===account.uid&&listener.pid===proxy.mainPid).length!==1)deny();
}
export function enterWorker(argv,deps) {
  try {
    if(deps.effectiveUid()!==0)deny();
    const request=parseArguments(argv);deps.trust();
    if(request.lifetime.operation==='exec'&&request.lifetime.stage!=='cleanup'){
      const policy=parsePolicy(deps.readPolicy()),accounts=deps.accounts();validateAccounts(policy,accounts);
      const entry=validateEntry(request.context,request.command,policy,accounts[request.context.user]);deps.trust(entry);
      const facts=deps.readiness(policy,accounts);assertReadiness(facts.nft,facts.proxy,policy,accounts);
    }
    const result=deps.dispatch(request);return result&&typeof result.then==='function'?result.catch(()=>deny()):result;
  } catch {deny();}
}
function probe(command,args) {
  const child=spawnSync(command,args,{encoding:'utf8',timeout:3000,maxBuffer:1048576,env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C'},stdio:['ignore','pipe','pipe']});
  if(child.error||child.status!==0||child.signal)deny();return child.stdout;
}
export function parseAccounts(passwd,groupText) {
  if(typeof passwd!=='string'||typeof groupText!=='string'||Buffer.byteLength(passwd)>1048576||Buffer.byteLength(groupText)>1048576)deny();
  const groups=groupText.trim().split('\n').map(line=>line.split(':')),groupNames=new Set();
  for(const group of groups) {
    if(group.length!==4||!group[0]||groupNames.has(group[0])||!/^\d+$/.test(group[2])||!Number.isSafeInteger(Number(group[2])))deny();groupNames.add(group[0]);
  }
  const accounts=Object.create(null);
  for(const line of passwd.trim().split('\n')) {
    const fields=line.split(':');if(fields.length!==7||Object.hasOwn(accounts,fields[0])||!/^\d+$/.test(fields[2])||!/^\d+$/.test(fields[3]))deny();
    accounts[fields[0]]={uid:Number(fields[2]),gid:Number(fields[3]),home:fields[5],groups:groups.filter(group=>Number(group[2])!==Number(fields[3])&&group[3]?.split(',').includes(fields[0])).map(group=>Number(group[2]))};
    if(fields[0].startsWith('patrick-')) {
      const primary=groups.filter(group=>Number(group[2])===Number(fields[3]));if(primary.length!==1||primary[0][0]!==fields[0])deny();
    }
  }
  return {...accounts};
}
export function trustExecutable(path,io=fs) {
  // Resolve in kernel traversal order, checking every directory/link before
  // following it (including components later removed by '..'). All paths that
  // probes/exec reopen are thus immutable to workers, not just the final binary.
  try {
    if(typeof path!=='string'||!path.startsWith('/')||resolve(path)!==path||path.length>4096||path.includes('\0'))deny();
    const root=io.lstatSync('/');
    if(root.uid!==0||(root.mode&0o022)!==0||!root.isDirectory()||root.isSymbolicLink())deny();
    let current='/',pending=path.slice(1).split('/'),links=0,steps=0;
    while(pending.length) {
      if(++steps>4096)deny();
      const component=pending.shift();
      if(component===''||component==='.')continue;
      if(component==='..'){current=dirname(current);continue;}
      const candidate=current==='/'?`/${component}`:`${current}/${component}`;
      const info=io.lstatSync(candidate);if(info.uid!==0)deny();
      if(info.isSymbolicLink()) {
        if(++links>40)deny();
        // Symlink mode bits do not grant write access; its checked parent and
        // owner control replacement. Linux distribution links normally use 777.
        const targetBytes=io.readlinkSync(candidate,{encoding:'buffer'});
        if(!Buffer.isBuffer(targetBytes)||!isUtf8(targetBytes))deny();
        const target=targetBytes.toString('utf8');
        if(!target||target.length>4096||target.includes('\0'))deny();
        const absolute=target.startsWith('/');if(absolute)current='/';
        pending=[...(absolute?target.slice(1):target).split('/'),...pending];
      } else {
        if((info.mode&0o022)!==0)deny();
        if(pending.length){if(!info.isDirectory())deny();current=candidate;}
        else {if(!info.isFile()||(info.mode&0o111)===0)deny();return;}
      }
    }
    deny();
  } catch {deny();}
}
function trust(entry) {
  for(const path of [modulePath,...['policy.mjs','stage-lifetime.mjs','install-guest.mjs','probe-guest.mjs'].map(name=>fileURLToPath(new URL('./'+name,import.meta.url)))])assertTrustedPath(path,{kind:'file',uid:0});
  for(const path of [process.execPath,'/usr/local/bin/node','/usr/bin/setpriv','/usr/bin/env','/usr/bin/dash','/usr/sbin/nft','/usr/bin/systemctl','/usr/bin/systemd-run'])trustExecutable(path);
  assertTrustedPath('/etc/patrick-worker',{kind:'directory',uid:0});
  if(entry)assertTrustedPath(entry.home,{kind:'directory',uid:entry.uid,gid:entry.gid,private:true});
}
export function parseServiceProperties(text) {
  if(typeof text!=='string'||Buffer.byteLength(text)>1048576)deny();
  const fields={};
  for(const line of text.trim().split('\n')){const index=line.indexOf('=');if(index<=0||Object.hasOwn(fields,line.slice(0,index)))deny();fields[line.slice(0,index)]=line.slice(index+1);}
  const keys=['User','Group','MainPID','ActiveState','SubState','FragmentPath','DropInPaths'];
  if(Object.keys(fields).length!==keys.length||!keys.every(key=>Object.hasOwn(fields,key))||fields.User!=='patrick-proxy'||fields.Group!=='patrick-proxy'||fields.DropInPaths!==''||!/^\d+$/.test(fields.MainPID)||!Number.isSafeInteger(Number(fields.MainPID))||Number(fields.MainPID)<=1||!fields.FragmentPath.startsWith('/')||fields.FragmentPath.includes('\0'))deny();
  return fields;
}
export function parseProxyFacts(properties,status,tcp,tcp6,socketInodes) {
  const pid=Number(properties.MainPID);
  const ids=key=>{
    const lines=status.split('\n').filter(line=>line.startsWith(`${key}:`));if(lines.length!==1)deny();
    const fields=lines[0].slice(lines[0].indexOf(':')+1).trim().split(/\s+/).filter(Boolean);
    if(fields.some(value=>!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))))deny();return fields.map(Number);
  };
  const uids=ids('Uid'),gids=ids('Gid'),groups=ids('Groups');
  if(uids.length!==4||gids.length!==4||uids.some(uid=>uid!==uids[0])||gids.some(gid=>gid!==gids[0]))deny();
  const sockets=new Set(socketInodes);
  const listeners=[];
  for(const [file,text] of [['tcp',tcp],['tcp6',tcp6]])for(const line of text.trim().split('\n').slice(1)) {
    const fields=line.trim().split(/\s+/);if(fields[3]!=='0A'||!sockets.has(fields[9]))continue;
    const [address,port]=fields[1].split(':');listeners.push({address:file==='tcp'&&address==='0100007F'?'127.0.0.1':'unapproved',port:parseInt(port,16),uid:Number(fields[7]),pid});
  }
  return {user:properties.User,uid:uids[0],gid:gids[0],groups,mainPid:pid,activeState:properties.ActiveState,subState:properties.SubState,listeners};
}
function serviceFacts() {
  const fields=parseServiceProperties(probe('/usr/bin/systemctl',['show','patrick-worker-proxy.service','--no-pager','--property=User,Group,MainPID,ActiveState,SubState,FragmentPath,DropInPaths']));
  assertTrustedPath(fields.FragmentPath,{kind:'file',uid:0});
  const pid=Number(fields.MainPID),status=fs.readFileSync(`/proc/${pid}/status`,'utf8');
  const sockets=fs.readdirSync(`/proc/${pid}/fd`).flatMap(fd=>{try{const target=fs.readlinkSync(`/proc/${pid}/fd/${fd}`);return /^socket:\[\d+\]$/.test(target)?[target.slice(8,-1)]:[];}catch{return [];}});
  return parseProxyFacts(fields,status,fs.readFileSync(`/proc/${pid}/net/tcp`,'utf8'),fs.readFileSync(`/proc/${pid}/net/tcp6`,'utf8'),sockets);
}
// Preserve policy.validateEntry's canonical command shape while carrying the
// separately validated account group evidence required by the lifetime ABI.
export function installedAdmission(context,command,state){
  if(state?.fence?.status!=='ready')deny();validateAccounts(state.policy,state.accounts);
  const canonical=validateEntry(context,command,state.policy,state.accounts[context.user]);
  assertReadiness(state.nft(),state.proxy(),state.policy,state.accounts);
  const entry=Object.freeze({...canonical,groups:Object.freeze([...state.accounts[context.user].groups])});
  return {entry,policyHash:state.manifest.installation.policyHash,artifactHash:state.manifest.installation.artifactHash};
}
export function productionDependencies() {
  const identity=context=>{
    const passwd=readTrustedFile('/etc/passwd'),all=parseAccounts(passwd,readTrustedFile('/etc/group')),account=all[context.user];
    const rows=passwd.trim().split('\n').map(line=>line.split(':')).filter(fields=>fields[0]===context.user),shadow=readTrustedFile('/etc/shadow').trim().split('\n').map(line=>line.split(':')).filter(fields=>fields[0]===context.user);
    if(rows.length!==1||rows[0][6]!=='/usr/sbin/nologin'||shadow.length!==1||!/^[!*]/.test(shadow[0][1]))deny();
    if(!account||Object.entries(all).some(([name,facts])=>name!==context.user&&(facts.uid===account.uid||facts.gid===account.gid)))deny();
    if(account.home!==`/var/lib/${context.user}`||account.groups.length)deny();trust({...context,...account});return account;
  };
  const admit=async(context,command)=>{
    const installer=await import('./install-guest.mjs'),state=await installer.inspectInstalled();if(state.fence.status!=='ready')deny();
    const admission=installedAdmission(context,command,state);trust(admission.entry);return admission;
  };
  const deps={effectiveUid:()=>process.geteuid?.(),trust,readPolicy:()=>JSON.parse(readTrustedFile(policyPath)),accounts:()=>parseAccounts(readTrustedFile('/etc/passwd'),readTrustedFile('/etc/group')),readiness:(policy,accounts)=>({nft:JSON.parse(probe('/usr/sbin/nft',['-j','list','table','inet','patrick_worker'])),proxy:serviceFacts(policy,accounts)}),dispatch:request=>lifecycle.executeStage(request,lifecycle.productionLifetimeDependencies({trust,identity,admit}))};
  return deps;
}
const directInvocation=(()=>{try{return Boolean(process.argv[1]&&fs.realpathSync(resolve(process.argv[1]))===modulePath);}catch{return false;}})();
if(directInvocation) {
  try {
    // Do not evaluate a sibling module as root until the whole code path is trusted.
    const loaded=await loadTrustedPolicy({effectiveUid:()=>process.geteuid?.(),trust:()=>{assertTrustedPath(resolve(process.argv[1]),{kind:'file',uid:0});trust();},load:async()=>({policy:await import('./policy.mjs'),lifetime:await import('./stage-lifetime.mjs')})});
    ({parsePolicy,validateContext,validateEntry,validateAccounts}=loaded.policy);lifecycle=loaded.lifetime;
    const result=await enterWorker(process.argv.slice(2),productionDependencies());if(result?.version===1)process.stdout.write(JSON.stringify(result)+'\n');
  }
  catch {process.stderr.write('Worker entry denied.\n');process.exitCode=78;}
} else {({parsePolicy,validateContext,validateEntry,validateAccounts}=await import('./policy.mjs'));lifecycle=await import('./stage-lifetime.mjs');}
