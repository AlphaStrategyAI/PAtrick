// Root-internal installed network qualification. No command-line entry point.
import * as fs from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
export const networkProbeIds=Object.freeze([
 'network-direct-ip443','network-dns-udp','network-dns-tcp',
 'network-public-ipv6','network-loopback-ipv6','network-host-alias',
 'network-host-ip','network-lan','network-gateway','network-resolver',
 'network-vpn','network-metadata','network-other-loopback',
 'network-other-provider-port','network-disallowed-host',
 'network-alternate-port','network-ip-connect','network-wrong-sni',
 'network-ech','network-empty-codex','network-empty-dsh'
]);
const fail=reason=>{throw Object.assign(new Error(reason),{reason});};
const roles=['grok','codex','dsh'],sessionPath='/etc/patrick-worker/qualification.json';
const sha=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const finite=n=>Number.isSafeInteger(n)&&n>=0&&n<=1024;
const copy=v=>JSON.parse(JSON.stringify(v));
const privateSession=v=>{const {records,networkOperation,...fixed}=v;return fixed;};
function persist(value,io){
 const tmp=sessionPath+'.'+randomBytes(16).toString('hex')+'.tmp';let fd;
 try{fd=io.openSync(tmp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);io.writeFileSync(fd,JSON.stringify(value)+'\n');io.chmodSync(tmp,0o600);io.fsyncSync(fd);io.closeSync(fd);fd=undefined;io.renameSync(tmp,sessionPath);const directory=io.openSync('/etc/patrick-worker',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{io.fsyncSync(directory);}finally{io.closeSync(directory);}}
 finally{if(fd!==undefined)io.closeSync(fd);try{io.unlinkSync(tmp);}catch{}}
}
function verifyMarkers(session,io){
 for(const b of session.bindings){const home=io.lstatSync(b.home);if(home.isSymbolicLink()||!home.isDirectory()||home.ino!==b.homeIno||home.uid!==b.uid||home.gid!==b.gid||sha(JSON.stringify([home.ino,home.uid,home.gid,home.mode]))!==b.baseline)fail('trust');
  for(const marker of b.markers){const path=b.home+'/'+marker.name,fd=io.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const stat=io.fstatSync(fd),bytes=io.readFileSync(fd);if(!stat.isFile()||stat.uid!==0||stat.gid!==0||(stat.mode&0o777)!==0o444||stat.ino!==marker.ino||stat.nlink!==1||stat.size>128||!Buffer.isBuffer(bytes)||bytes.length>128||sha(bytes)!==marker.hash)fail('trust');}finally{io.closeSync(fd);}}
 }
}
function witness(deps){
 const pid=deps.io===fs?process.pid:deps.installerPid,bootId=deps.io.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),stat=deps.io.readFileSync('/proc/'+pid+'/stat','utf8');
 const startTime=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19];
 if(!Number.isSafeInteger(pid)||pid<2||!stat.startsWith(pid+' (')||stat.length>65536||!/^[1-9]\d{0,19}$/.test(startTime??'')||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId))fail('trust');
 return {pid,startTime,bootId};
}
function representative(cidr){
 const [address,prefixText]=cidr.split('/'),family=isIP(address),bits=family===4?32:128,prefix=Number(prefixText);
 if(!family||!Number.isSafeInteger(prefix)||prefix<0||prefix>bits)fail('trust');
 let value;
 if(family===4)value=address.split('.').reduce((n,w)=>(n<<8n)|BigInt(w),0n);
 else{const [l,r]=address.split('::'),left=l?l.split(':'):[],right=r?r.split(':'):[];value=(address.includes('::')?[...left,...Array(8-left.length-right.length).fill('0'),...right]:left).reduce((n,w)=>(n<<16n)|BigInt('0x'+w),0n);}
 // One deterministic host within each classified route, plus explicit endpoints.
 if(prefix<bits)value+=1n;
 if(family===4)return [24n,16n,8n,0n].map(n=>Number(value>>n&255n)).join('.');
 return new URL('http://['+Array.from({length:8},(_,i)=>(value>>BigInt((7-i)*16)&65535n).toString(16)).join(':')+']/').hostname.slice(1,-1);
}
function targetPlan(state,raw,worker){
 const rows=new Map(networkProbeIds.filter(id=>!id.startsWith('network-empty-')).map(id=>[id,[]]));
 const add=(id,host,port=443,kind='tcp',extra={})=>{if(!rows.has(id)||!isIP(host)&&kind==='tcp'||!Number.isSafeInteger(port)||port<1||port>65535)fail('trust');const row={id,kind,host,port,...extra},list=rows.get(id);if(!list.some(t=>same(t,row)))list.push(row);};
 add('network-direct-ip443','93.184.216.34');
 const resolvers=[...new Set(['1.1.1.1',...raw.guest.resolvers,...raw.host.resolvers,...raw.exclusions.filter(e=>e.categories.includes('resolver')).map(e=>representative(e.cidr))])];
 for(const host of resolvers){add('network-dns-udp',host,53,'udp');add('network-dns-tcp',host,53);}
 const upstreamV6=raw.guest.addresses.some(a=>a.family===6&&!/^(?:fc|fd|fe8|fe9|fea|feb|::)/.test(a.address))&&raw.guest.routes.some(r=>r.family===6&&['::/0','::/1','8000::/1'].includes(r.destination));
 const disabled=!upstreamV6&&state.inventory.ipv6UpstreamDisabled&&state.policy.deniedCidrs.includes('::/0');
 if(!disabled)add('network-public-ipv6','2606:4700:4700::1111');
 add('network-loopback-ipv6','::1');
 for(const host of raw.guest.hostAliases)add('network-host-alias',host);
 for(const host of [...raw.host.addresses,...raw.lima.hostAddresses,...raw.guest.addresses.map(a=>a.address.split('/')[0])])add('network-host-ip',host);
 for(const host of [...raw.lima.gatewayAddresses,...raw.guest.routes.map(r=>r.gateway),...raw.host.routes.map(r=>r.gateway)].filter(Boolean))add('network-gateway',host);
 for(const host of resolvers)add('network-resolver',host);
 for(const e of raw.exclusions){for(const [category,id]of [['host','network-host-ip'],['guest','network-host-ip'],['gateway','network-gateway'],['resolver','network-resolver'],['lan','network-lan'],['vpn','network-vpn']])if(e.categories.includes(category))add(id,representative(e.cidr));}
 for(const r of raw.routes)if(['private','enterprise','local'].includes(r.classification)){
  const exclusions=raw.exclusions.filter(e=>e.cidr===r.cidr);if(!exclusions.length)fail('trust');
  const vpn=exclusions.some(e=>e.categories.includes('vpn'));add(vpn?'network-vpn':'network-lan',representative(r.cidr));
 }
 add('network-metadata','169.254.169.254',80);add('network-other-loopback','127.0.0.2');
 for(const w of state.policy.workers)if(w.runner!==worker.runner)add('network-other-provider-port','127.0.0.1',w.proxyPort);
 const denied=Array.from({length:65},(_,i)=>'denied-'+i+'.patrick.invalid').find(h=>!worker.hosts.includes(h));if(!denied)fail('trust');
 const allowed=worker.hosts[0]??'unlisted.patrick.invalid',header=(id,authority,hello='')=>rows.get(id).push({id,kind:'proxy',host:'127.0.0.1',port:worker.proxyPort,authority,hello,reason:hello&&worker.hosts.length?'TLS':'HEADER'});
 header('network-disallowed-host',denied+':443');header('network-alternate-port',allowed+':444');header('network-ip-connect','93.184.216.34:443');
 header('network-wrong-sni',allowed+':443','wrong-sni');header('network-ech',allowed+':443','ech');
 const cases=[];for(const id of networkProbeIds){if(id.startsWith('network-empty-'))continue;const targets=rows.get(id);if(targets.length>1024)fail('trust');
  let applicability=null;if(!targets.length){if(id==='network-public-ipv6'&&disabled)applicability='ipv6-upstream-disabled';else if(['network-host-alias','network-host-ip','network-lan','network-gateway','network-resolver','network-vpn','network-dns-udp','network-dns-tcp'].includes(id))applicability='no-inventory-target';else fail('trust');}
  cases.push({id,targets,applicability,basis:targets[0]?.kind==='proxy'&&!worker.hosts.length?'empty-allowlist':'socket-policy',gate:targets[0]?.kind==='proxy'?(targets[0].reason==='TLS'?'proxy-tls':'proxy-header'):'nft'});
 }
 const emptyId='network-empty-'+worker.runner;if(networkProbeIds.includes(emptyId))cases.push({id:emptyId,targets:worker.hosts.length?[]:cases.flatMap(c=>c.targets.filter(t=>t.kind==='proxy')),applicability:worker.hosts.length?'nonempty-allowlist':null,basis:'empty-allowlist',gate:'proxy-header',aggregate:true});
 if(cases.flatMap(c=>c.aggregate?[]:c.targets).length>1024)fail('trust');return cases;
}
// This is the exact first-party program executed in the admitted client stage.
// It has no provider import, credential path, child process or model protocol.
async function client(configuration){
 const fs=require('node:fs'),net=require('node:net'),dgram=require('node:dgram');
 const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
 const read=()=>new Promise((resolve,reject)=>{let line='';const byte=Buffer.alloc(1);const next=()=>fs.read(0,byte,0,1,null,(e,n)=>{if(e||n!==1)return reject(Error());if(byte[0]>127||byte[0]===13||line.length>64)return reject(Error());line+=byte.toString();if(byte[0]===10)resolve(line);else next();});next();});
 const hello=(name,ech)=>{const word=n=>Buffer.from([n>>8,n&255]),sni=Buffer.concat([word(name.length+3),Buffer.from([0]),word(name.length),Buffer.from(name)]),extensions=Buffer.concat([word(0),word(sni.length),sni,...(ech?[word(65037),word(1),Buffer.from([0])]:[])]),body=Buffer.concat([word(0x0303),Buffer.alloc(32),Buffer.from([0]),word(2),word(0x1301),Buffer.from([1,0]),word(extensions.length),extensions]),handshake=Buffer.concat([Buffer.from([1,body.length>>16,body.length>>8&255,body.length&255]),body]);return Buffer.concat([Buffer.from([22,3,1]),word(handshake.length),handshake]);};
 const probe=target=>new Promise(resolve=>{
  let socket,done=false,timer,established=false,sent=false,buffer=Buffer.alloc(0);
  const finish=(event,error='')=>{if(done)return;done=true;clearTimeout(timer);try{target.kind==='udp'?socket?.close():socket?.destroy();}catch{}resolve({event,error,established,tlsSent:sent});};
  timer=setTimeout(()=>finish('timeout'),6500);
  try{
   if(target.kind==='udp'){socket=dgram.createSocket(target.host.includes(':')?'udp6':'udp4');socket.once('error',e=>finish('error',['EACCES','EPERM','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','ETIMEDOUT','EAFNOSUPPORT'].includes(e.code)?e.code:'OTHER'));socket.once('message',()=>finish('data'));socket.send(Buffer.from([0,0,1,0,0,1,0,0,0,0,0,0,0,0,1,0,1]),target.port,target.host,e=>{if(e)finish('error',['EACCES','EPERM'].includes(e.code)?e.code:'OTHER');});return;}
   socket=net.createConnection({host:target.host,port:target.port});
   socket.once('error',e=>finish('error',['EACCES','EPERM','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','ETIMEDOUT','EAFNOSUPPORT'].includes(e.code)?e.code:'OTHER'));
   socket.once('connect',()=>{if(target.kind!=='proxy')return finish('connected');socket.write('CONNECT '+target.authority+' HTTP/1.1\r\nHost: '+target.authority+'\r\n\r\n');});
   socket.on('data',bytes=>{if(target.kind!=='proxy')return finish('data');buffer=Buffer.concat([buffer,bytes]);if(buffer.length>1024||established)return finish('data');const end=buffer.indexOf('\r\n\r\n');if(end<0)return;if(!buffer.equals(Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n'))||!target.hello)return finish('data');established=true;sent=true;socket.write(hello(target.hello==='wrong-sni'?(target.authority.slice(0,-4)==='wrong.patrick.invalid'?'other.patrick.invalid':'wrong.patrick.invalid'):target.authority.slice(0,-4),target.hello==='ech'));buffer=Buffer.alloc(0);});
   socket.once('close',()=>finish('closed'));
  }catch(e){finish('error',['EACCES','EPERM'].includes(e.code)?e.code:'OTHER');}
 });
 try{
  if(process.getuid()!==configuration.uid||process.geteuid()!==configuration.uid||process.getgid()!==configuration.gid||process.getegid()!==configuration.gid||process.getgroups().length||process.env.HOME!==configuration.home||process.env.HTTP_PROXY!=='http://127.0.0.1:'+configuration.proxyPort)throw Error();
  for(let index=0;index<configuration.steps.length;index++){send({next:index});if(await read()!=='network-continue:'+index+'\n')throw Error();send({index,...await probe(configuration.steps[index])});}
  send({done:configuration.steps.length});
 }catch{process.exitCode=78;}
}
const clientProgram='('+client.toString()+')(JSON.parse(process.argv[1]))';
function command(deps,path,args){const r=deps.run(path,args);if(!r||r.error||r.signal||r.status!==0||typeof r.stdout!=='string'||typeof r.stderr!=='string'||r.stderr!==''||Buffer.byteLength(r.stdout)>1048576)fail('network');return r.stdout;}
function lineage(deps,proxy,owner){
 const text=command(deps,'/usr/bin/systemctl',['show','patrick-worker-proxy.service','--no-pager','--property=InvocationID,MainPID,ActiveState,SubState']),fields={};
 if(!text.endsWith('\n'))fail('trust');for(const line of text.trimEnd().split('\n')){const [k,...v]=line.split('=');if(Object.hasOwn(fields,k))fail('trust');fields[k]=v.join('=');}
 if(!exact(fields,['InvocationID','MainPID','ActiveState','SubState'])||!/^[a-f0-9]{32}$/.test(fields.InvocationID)||fields.MainPID!==String(proxy.mainPid)||fields.ActiveState!=='active'||fields.SubState!=='running')fail('trust');
 return {boot:owner.bootId.replaceAll('-',''),invocation:fields.InvocationID,pid:fields.MainPID};
}
const journalFields=['__CURSOR','__REALTIME_TIMESTAMP','__MONOTONIC_TIMESTAMP','_BOOT_ID','_SYSTEMD_UNIT','_SYSTEMD_INVOCATION_ID','_PID','_TRANSPORT','MESSAGE'];
const proxyReasons=['HEADER','DNS','TLS','CONNECT','REMOTE','CAPACITY','IDLE','LIFETIME','BYTES','SOCKET','CANCEL','CLOSE'];
function journal(deps,identity,baseline){
 const args=['--no-pager','--quiet','--all','--output=json','--output-fields='+journalFields.join(','),'--unit=patrick-worker-proxy.service','_BOOT_ID='+identity.boot,'_SYSTEMD_INVOCATION_ID='+identity.invocation,'_PID='+identity.pid,'--show-cursor',...(baseline?.last?['--cursor='+baseline.last.__CURSOR]:[])];
 const text=command(deps,'/usr/bin/journalctl',args);if(text===''&&!baseline)return {counts:{},last:null};
 if(!text.endsWith('\n')||text.includes('\r')||Buffer.byteLength(text)>1048576)fail('network');
 const lines=text.slice(0,-1).split('\n'),footer=lines.pop();if(!footer?.startsWith('-- cursor: ')||!lines.length||lines.length>4096)fail('network');
 const counts={...(baseline?.counts??{})},seen=new Set();let last=null,time=0n;const delta=[];
 for(const [i,line]of lines.entries()){
  let row;try{row=JSON.parse(line);}catch{fail('network');}
  if(!exact(row,journalFields)||Object.values(row).some(v=>typeof v!=='string')||row._BOOT_ID!==identity.boot||row._SYSTEMD_UNIT!=='patrick-worker-proxy.service'||row._SYSTEMD_INVOCATION_ID!==identity.invocation||row._PID!==identity.pid||row._TRANSPORT!=='stdout'||!/^[A-Za-z0-9;=._-]{1,512}$/.test(row.__CURSOR)||seen.has(row.__CURSOR)||!/^\d{1,20}$/.test(row.__MONOTONIC_TIMESTAMP)||!/^\d{1,20}$/.test(row.__REALTIME_TIMESTAMP)||BigInt(row.__MONOTONIC_TIMESTAMP)<=time)fail('network');
  time=BigInt(row.__MONOTONIC_TIMESTAMP);seen.add(row.__CURSOR);const match=/^([A-Z]+) ([1-9]\d{0,15})$/.exec(row.MESSAGE);if(!match||!proxyReasons.includes(match[1])||!Number.isSafeInteger(Number(match[2])))fail('network');
  const reason=match[1],count=Number(match[2]);
  if(baseline?.last&&i===0){if(!same(row,baseline.last))fail('network');}
  else{if(Object.hasOwn(counts,reason)?count!==counts[reason]+1:count!==1)fail('network');counts[reason]=count;delta.push(reason);}
  last=row;
 }
 if(footer!=='-- cursor: '+last.__CURSOR)fail('network');return {counts,last,delta};
}
function helperArgs(binding,token,stage,operation,command){return ['--runner',binding.runner,'--user',binding.user,'--project',binding.projectId,'--domain',binding.domain,'--invocation',token,'--stage',stage,'--operation',operation,'--',...command];}
function helper(deps,args,input,onLine,timeout=15000){
 const create=deps.io===fs?spawn:deps.spawn,child=create('/usr/local/libexec/patrick-worker-enter',args,{cwd:'/',env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C'},stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='',bytes=0,pending=Buffer.alloc(0),invalid=false,processing=Promise.resolve();
 const timer=setTimeout(()=>{invalid=true;child.kill('SIGKILL');},timeout);
 const done=new Promise(resolve=>{
  child.once('error',()=>{invalid=true;});child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>1048576){invalid=true;child.kill('SIGKILL');return;}if(!onLine){stdout+=chunk.toString('utf8');return;}pending=Buffer.concat([pending,chunk]);if(pending.length>8192){invalid=true;child.kill('SIGKILL');return;}let end;while((end=pending.indexOf(10))>=0){const line=pending.subarray(0,end);pending=pending.subarray(end+1);processing=processing.then(async()=>{if(invalid||!isUtf8(line)||line.includes(13))fail('network');let value;try{value=JSON.parse(line.toString());}catch{fail('network');}await onLine(value,frame=>child.stdin.write(frame));}).catch(()=>{invalid=true;child.kill('SIGKILL');});}});
  child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>1048576||!isUtf8(chunk)){invalid=true;child.kill('SIGKILL');}else stderr+=chunk.toString();});child.stdin.on('error',()=>{});
  child.once('close',async(code,signal)=>{clearTimeout(timer);await processing;if(pending.length)invalid=true;resolve({code,signal,stdout,stderr,valid:!invalid&&code===0&&!signal&&stderr===''});});
 });
 if(input!==null)child.stdin.end(input??'');return {done,child};
}
function closure(value){return exact(value,['version','state','reason','invocationClosed','cgroupsEmpty','workerProcessesAbsent','privateMountsAbsent','workspacesAbsent'])&&value.version===1&&value.state==='closed'&&value.reason==='ok'&&['invocationClosed','cgroupsEmpty','workerProcessesAbsent','privateMountsAbsent','workspacesAbsent'].every(k=>value[k]===true);}
function observed(rows,binding,expected,closed){
 if(rows.length!==expected.length||!same(rows.map(r=>r.stage),expected))return false;
 return rows.every(r=>r.role===binding.runner&&r.profile===(['cli','acp'].includes(r.stage)?'authenticated-client':'task-only')&&r.postDrop.uid===binding.uid&&r.postDrop.gid===binding.gid&&r.postDrop.groups.length===0&&r.postDrop.noNewPrivileges&&['capEffective','capPermitted','capInheritable','capAmbient','capBounding'].every(k=>/^0+$/.test(r.postDrop[k]))&&r.postDrop.homeMatches&&r.postDrop.fixedEnvironmentMatches&&!r.postDrop.unknownEnvironmentKeyPresent&&r.postDrop.derivedPwdMatchesHome&&r.postDrop.derivedOldPwdMatchesTrustedCwd&&r.profileFacts.persistentMarkerUnchanged&&r.profileFacts.persistentConfigUnchanged&&r.profileFacts.workspaceMatchesRecord&&r.profileFacts.privateScratchRemoved&&(r.profile==='authenticated-client'?r.profileFacts.persistentMarkerReadable:r.profileFacts.closedNetworkObserved&&r.profileFacts.privateHomeWritable&&!r.profileFacts.persistentMarkerReadable)&&(closed?r.outcome.phase==='complete'&&r.outcome.code===0&&r.outcome.submitterExited&&r.outcome.invocationClosed:r.stage===expected.at(-1)?r.outcome.phase==='acknowledged'&&!r.outcome.invocationClosed:r.outcome.phase==='complete'&&r.outcome.code===0&&r.outcome.submitterExited));
}
export async function runInstalledNetwork(state,session,deps){
 if(!deps?.io||typeof deps.effectiveUid!=='function'||typeof deps.run!=='function'||typeof deps.loadModules!=='function'||deps.io!==fs&&typeof deps.spawn!=='function')fail('dependency');
 if(deps.effectiveUid()!==0||!session||session.phase!=='active'||session.networkOperation)fail('trust');
 const installer=await import('./install-guest.mjs'),io=deps.io;let owned,originalNft,originalProxy,identity,current=copy(session),operation,activeToken=null;
 const load=()=>{installer.trustedPath(sessionPath,{mode:0o600},io);let v;try{v=JSON.parse(installer.trustedRead(sessionPath,io,131072));}catch{fail('trust');}if(!same(privateSession(v),privateSession(session))||v.phase!=='active'||!Array.isArray(v.records)||new Set(v.records).size!==v.records.length)fail('trust');return v;};
 const boundState=async()=>{const fresh=await installer.inspectInstalled(deps);if(fresh.fence.status!=='ready'||!same(fresh.manifest,state.manifest)||!same(fresh.accounts,state.accounts)||!same(fresh.inventory,state.inventory)||!same(fresh.policy,state.policy))fail('trust');return fresh;};
 const revalidate=async(ready=false)=>{const v=load();if(!same(v.networkOperation,operation)||v.records.some(t=>!session.records.includes(t)&&!operation.roles.some(r=>r.token===t&&r.phase!=='reserved'&&r.phase!=='never-submitted'))||!same(v.records.slice(0,session.records.length),session.records)||!same(v.records.filter(t=>session.records.includes(t)),session.records)||!same(witness(deps),owned))fail('trust');const enrolled=operation.roles.filter(r=>v.records.includes(r.token));if(!same(v.records,[...session.records,...enrolled.map(r=>r.token)])||operation.roles.some(r=>['prepared','client','closing','closed'].includes(r.phase)&&!v.records.includes(r.token)))fail('trust');verifyMarkers(session,io);current=v;const fresh=await boundState();fresh.modules.assertReadiness(fresh.nft(),fresh.proxy(),fresh.policy,fresh.accounts);if(!same(fresh.nft(),originalNft)||!same(fresh.proxy(),originalProxy)||!same(lineage(deps,originalProxy,owned),identity))fail('trust');if(ready)fresh.drain();return fresh;};
 const update=async(change,ready=false)=>installer.withInstallationMutex(deps,async()=>{const fresh=await revalidate(ready);if(!same(load(),current))fail('trust');change(operation);current.networkOperation=copy(operation);persist(current,io);return fresh;});
 const initial=await installer.withInstallationMutex(deps,async()=>{
  const v=load();if(v.networkOperation||!same(v.records,session.records))fail('trust');const fresh=await boundState();verifyMarkers(session,io);fresh.drain();fresh.modules.assertReadiness(fresh.nft(),fresh.proxy(),fresh.policy,fresh.accounts);owned=witness(deps);originalNft=fresh.nft();originalProxy=fresh.proxy();identity=lineage(deps,originalProxy,owned);installer.trustedExecutable('/usr/bin/journalctl',io);installer.trustedPath('/usr/local/libexec/patrick-worker-enter',{mode:0o755},io);
  const rawText=installer.trustedRead('/etc/patrick-worker/route-inventory.json',io);if(sha(rawText)!==fresh.manifest.files['route-inventory.json'])fail('trust');let raw;try{raw=JSON.parse(rawText);}catch{fail('trust');}const inventory=installer.validateInventory(raw,fresh.policy,installer.observeGuest(deps),deps.now());if(!same(inventory,fresh.inventory))fail('trust');
  operation={version:1,generation:session.generation,artifactHash:session.artifactHash,policyHash:session.policyHash,inventoryHash:session.inventoryHash,owner:owned,phase:'running',preconditionRequests:{header:0,tls:0},roles:roles.map(role=>({role,token:randomBytes(16).toString('hex'),phase:'reserved',steps:0}))};if(!same(load(),v))fail('trust');current=v;current.networkOperation=copy(operation);persist(current,io);return {fresh,raw};
 });
 const results=[];let lifetimeFailure=false,trustFailure=false,preconditionsHealthy=true;
 const markRemaining=()=>{for(const r of operation.roles)if(r.phase==='reserved')r.phase='never-submitted';};
 for(const ownedRole of operation.roles){
  const b=session.bindings.find(b=>b.runner===ownedRole.role),worker=initial.fresh.policy.workers.find(w=>w.runner===ownedRole.role),plan=targetPlan(initial.fresh,initial.raw,worker),stage=b.runner==='dsh'?'acp':'cli',workspace='/var/lib/patrick-workspaces/'+ownedRole.token+'/work';
  const roleResults=plan.map(c=>({id:c.id,role:b.runner,status:c.applicability?'not_applicable':'not_run',reason:c.applicability?'not_applicable':'not_run',actualGuest:io===fs,synthetic:true,environment:'installed',profile:'authenticated-client',network:{targets:c.targets.length,attempted:0,denied:0,basis:c.applicability??c.basis,gate:c.applicability?'inventory':c.gate}}));
  if(lifetimeFailure||trustFailure){results.push(...roleResults.map(r=>r.status==='not_applicable'?{...r,status:'not_run',reason:lifetimeFailure?'lifetime':'trust'}:{...r,reason:lifetimeFailure?'lifetime':'trust'}));continue;}
  let roleGood=true,submitted=false;activeToken=ownedRole.token;
  try{
   await update(op=>{op.roles.find(r=>r.role===b.runner).phase='submitting';},true);submitted=true;
   const prepare=await helper(deps,helperArgs(b,activeToken,'prepare','exec',['node','-e',initial.fresh.modules.guestScripts.prepare,workspace]),JSON.stringify({schema:{},prompt:'Fixed no-model network qualification',files:[]})).done;
   if(!prepare.valid||prepare.stdout!==JSON.stringify({dir:workspace}))fail('lifetime');
   await update(op=>{op.roles.find(r=>r.role===b.runner).phase='prepared';});
   let base=journal(deps,identity),steps=[];
   for(const reason of ['HEADER','TLS']){
    const key=reason.toLowerCase();if(!Object.hasOwn(base.counts,reason)&&!operation.preconditionRequests[key]&&(reason==='HEADER'||worker.hosts.length)){
     const template=plan.flatMap(c=>c.aggregate?[]:c.targets).find(t=>t.kind==='proxy'&&t.reason===reason);if(!template)fail('network');steps.push({...template,precondition:reason});
    }
   }
   steps.push(...plan.flatMap(c=>c.aggregate?[]:c.targets));if(steps.length>1024)fail('network');
   const configuration={uid:b.uid,gid:b.gid,home:b.home,proxyPort:b.proxyPort,steps};let next=0,waiting=false,finished=false,baseline=null;
   const argv=b.runner==='dsh'?['/usr/local/bin/node','--no-addons','-e',clientProgram,JSON.stringify(configuration)]:['sh','-c',initial.fresh.modules.cliWrapper,'patrick',workspace,'/usr/local/bin/node','--no-addons','-e',clientProgram,JSON.stringify(configuration)];
   await update(op=>{op.roles.find(r=>r.role===b.runner).phase='client';});
   const execution=helper(deps,helperArgs(b,activeToken,stage,'exec',argv),null,async(value,send)=>{
    if(exact(value,['next'])&&value.next===next&&!waiting&&!finished&&next<steps.length){
     await installer.withInstallationMutex(deps,async()=>{const fresh=await revalidate();const rows=fresh.modules.qualificationObservations({...current,records:[activeToken]},io);if(!observed(rows,b,['prepare',stage],false))fail('trust');baseline=journal(deps,identity);});
     const step=steps[next];if(step.precondition)await update(op=>{if(op.preconditionRequests[step.precondition.toLowerCase()])fail('trust');op.preconditionRequests[step.precondition.toLowerCase()]=1;});
     waiting=true;send('network-continue:'+next+'\n');return;
    }
    if(exact(value,['index','event','error','established','tlsSent'])&&waiting&&value.index===next&&['error','timeout','data','connected','closed'].includes(value.event)&&['','EACCES','EPERM','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','ETIMEDOUT','EAFNOSUPPORT','OTHER'].includes(value.error)&&typeof value.established==='boolean'&&typeof value.tlsSent==='boolean'){
     const step=steps[next];let evidence=false;
     try{const after=journal(deps,identity,baseline);const delta=after.delta??[];if(step.kind==='proxy')evidence=delta.length===1&&delta[0]===step.reason&&value.event==='closed'&&value.error===''&&(step.reason==='TLS'?value.established&&value.tlsSent:!value.established&&!value.tlsSent)&&(step.precondition||Object.hasOwn(baseline.counts,step.reason));else evidence=delta.length===0&&value.event==='error'&&['EACCES','EPERM'].includes(value.error)&&!value.established&&!value.tlsSent;
     }catch{evidence=false;}
     if(step.precondition){if(!evidence){preconditionsHealthy=false;roleGood=false;}}
     else{for(const r of roleResults)if(r.id===step.id||r.id==='network-empty-'+b.runner&&step.kind==='proxy'&&!worker.hosts.length){r.actualGuest=io===fs;r.network.attempted++;if(evidence&&preconditionsHealthy)r.network.denied++;}}
     await update(op=>{op.roles.find(r=>r.role===b.runner).steps=next+1;});waiting=false;next++;return;
    }
    if(exact(value,['done'])&&value.done===steps.length&&next===steps.length&&!waiting&&!finished){finished=true;send('');return;}
    fail('network');
   },Math.min(900000,20000+steps.length*7500));
   const completed=await execution.done;if(!completed.valid||!finished||next!==steps.length)fail('network');
  }catch(error){roleGood=false;if(error?.reason==='trust'||error?.reason==='installed_mismatch'||error?.reason==='account_conflict')trustFailure=true;}
  finally{
   let closed=false;
   if(submitted){try{await update(op=>{op.roles.find(r=>r.role===b.runner).phase='closing';});}catch{trustFailure=true;}try{
    // Recovery deliberately does not require current readiness. The production
    // record alone authorizes its own stop and once-only nonroot cleanup.
    const stopped=await helper(deps,helperArgs(b,activeToken,stage,'stop',[]),'').done;let stop;try{stop=JSON.parse(stopped.stdout);}catch{}
    if(stopped.valid&&stop?.state==='drained'&&stop.reason==='ok'&&stop.cgroupsEmpty&&stop.workerProcessesAbsent&&stop.privateMountsAbsent){
     const cleaned=await helper(deps,helperArgs(b,activeToken,'cleanup','exec',['node','-e',initial.fresh.modules.guestScripts.cleanup,workspace]),'').done;
     const reconciled=await helper(deps,helperArgs(b,activeToken,'cleanup','reconcile',[]),'').done;let receipt;try{receipt=JSON.parse(reconciled.stdout);}catch{}
     closed=cleaned.valid&&reconciled.valid&&closure(receipt);
    }
   }catch{} }
   if(!closed){lifetimeFailure=true;roleGood=false;try{await update(op=>{op.roles.find(r=>r.role===b.runner).phase='unknown';op.phase='unknown';markRemaining();});}catch{trustFailure=true;}}
   else{try{await update(op=>{op.roles.find(r=>r.role===b.runner).phase='closed';},true);const rows=initial.fresh.modules.qualificationObservations({...current,records:[activeToken]},io);if(!observed(rows,b,['prepare',stage,'cleanup'],true))roleGood=false;}catch{trustFailure=true;roleGood=false;}}
  }
  for(const r of roleResults){if(r.status==='not_applicable'){if(!roleGood){r.status='not_run';r.reason=lifetimeFailure?'lifetime':trustFailure?'trust':'network';}continue;}const pass=roleGood&&r.network.targets>0&&r.network.attempted===r.network.targets&&r.network.denied===r.network.targets;r.status=pass?'pass':'fail';r.reason=pass?'ok':lifetimeFailure?'lifetime':trustFailure?'trust':'network';}
  results.push(...roleResults);activeToken=null;
 }
 try{await update(op=>{markRemaining();if(op.roles.every(r=>['closed','never-submitted'].includes(r.phase)))op.phase='complete';else op.phase='unknown';},true);}catch{trustFailure=true;}
 if(trustFailure||lifetimeFailure)for(const r of results)if(['pass','not_applicable'].includes(r.status)){r.status='fail';r.reason=lifetimeFailure?'lifetime':'trust';if(r.network.targets===0){r.status='not_run';}}
 const pass=!trustFailure&&!lifetimeFailure&&results.length===59&&results.every(r=>['pass','not_applicable'].includes(r.status));
 return {version:1,operation:'qualification-network',outcome:pass?'pass':'fail',reason:pass?'ok':lifetimeFailure?'lifetime':trustFailure?'trust':'network',synthetic:true,environment:'installed',actualGuest:io===fs,artifactHash:session.artifactHash,policyHash:session.policyHash,inventoryHash:session.inventoryHash,preconditionRequests:copy(operation.preconditionRequests),results};
}
