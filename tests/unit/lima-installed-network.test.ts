import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
const install=await import(new URL('../../scripts/lima/install-guest.mjs',import.meta.url).href);
const probe=await import(new URL('../../scripts/lima/probe-guest.mjs',import.meta.url).href);
const lifetime=await import(new URL('../../scripts/lima/stage-lifetime.mjs',import.meta.url).href);
const url=new URL('../../scripts/lima/installed-network.mjs',import.meta.url);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const policy={version:1,proxyUser:'patrick-proxy',workers:['grok','codex','dsh'].map((runner,index)=>({runner,user:`patrick-${runner}`,projectId:'fixture',domain:'personal',proxyPort:18743+index,hosts:[]})),deniedCidrs:['10.0.0.0/8','::/0']};
const guest={addresses:[{family:4,address:'192.0.2.10/32'}],routes:[{family:4,destination:'0.0.0.0/0',gateway:'192.0.2.1'}],resolvers:['192.0.2.53'],hostAliases:['192.0.2.2']};
function inventory() {
  const data={version:1,collectedAt:'2026-11-04T00:00:00.000Z',sources:['guest-addresses','guest-routes','guest-resolvers','guest-host-aliases','lima-host-gateway','mac-addresses','lan-vpn-routes','host-resolvers','translator','guest-admin-sockets'].map(kind=>({kind,version:1})),sourceVersion:1,translator:'unknown',translatorPrefixes:[],extraPrivilegedSocketPaths:[],guest,host:{addresses:[],routes:[],resolvers:[]},lima:{hostAddresses:['192.0.2.2'],gatewayAddresses:['192.0.2.1']},exclusions:[
    {family:4,cidr:'192.0.2.10/32',categories:['guest']}, {family:4,cidr:'192.0.2.1/32',categories:['gateway']}, {family:4,cidr:'192.0.2.53/32',categories:['resolver']}, {family:4,cidr:'192.0.2.2/32',categories:['host']},
  ],routes:[{family:4,cidr:'0.0.0.0/0',classification:'internet'},{family:4,cidr:'0.0.0.0/1',classification:'internet'},{family:4,cidr:'128.0.0.0/1',classification:'internet'}]};
  return {...data,fingerprint:hash(JSON.stringify(data))};
}
function accounts() {return Object.fromEntries(['patrick-proxy','patrick-grok','patrick-codex','patrick-dsh'].map((name,index)=>[name,{uid:1100+index,gid:1100+index,home:`/var/lib/${name}`,groups:[],shell:'/usr/sbin/nologin',locked:true,primaryGroup:name}]));}

function filesystemFixture() {
  const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'patrick-install-')));
  const owners=new Map<string,{uid:number;gid:number}>(),descriptors=new Map<number,{path:string;owner:{uid:number;gid:number}}>();const mutations:string[]=[];
  const physical=(path:string)=>{if(typeof path!=='string'||!path.startsWith('/')||path.split('/').includes('..')||path.includes('\0'))throw Error('outside fixture');return path.includes('//')||path.includes('/./')||path.endsWith('/.')?join(root,path):root+path;};
  const descriptor=(fd:number)=>{const value=descriptors.get(fd);if(!value)throw Error('foreign fd');return value;};
  const io:any={readSync:(fd:number,...args:any[])=>{descriptor(fd);return fs.readSync(fd,...args as [any,any,any,any]);},closeSync:(fd:number)=>{descriptor(fd);fs.closeSync(fd);descriptors.delete(fd);},fsyncSync:(fd:number)=>{descriptor(fd);fs.fsyncSync(fd);},fchmodSync:(fd:number,mode:number)=>{descriptor(fd);fs.fchmodSync(fd,mode);},
    lstatSync:(path:string)=>{const stat=fs.lstatSync(physical(path));return Object.assign(stat,{uid:owners.get(path)?.uid??0,gid:owners.get(path)?.gid??0});},
    readFileSync:(path:string|number,...args:any[])=>{if(typeof path==='number')descriptor(path);return fs.readFileSync(typeof path==='number'?path:physical(path),...args as [any]);},
    openSync:(path:string,flags:number,mode?:number)=>{if(flags&fs.constants.O_CREAT)mutations.push(`open:${path}`);const fd=fs.openSync(physical(path),flags,mode);descriptors.set(fd,{path,owner:owners.get(path)??{uid:0,gid:0}});return fd;},
    fstatSync:(fd:number)=>{const value=descriptor(fd),stat=fs.fstatSync(fd);return Object.assign(stat,value.owner);},
    readdirSync:(path:string)=>fs.readdirSync(physical(path)),opendirSync:(path:string,options:any)=>fs.opendirSync(physical(path),options),readlinkSync:(path:string,options:any)=>{const raw=fs.readlinkSync(physical(path),{encoding:'buffer'});const prefix=Buffer.from(root+'/');const bytes=raw.subarray(0,prefix.length).equals(prefix)?Buffer.concat([Buffer.from('/'),raw.subarray(prefix.length)]):raw;return options?.encoding==='buffer'?bytes:bytes.toString('utf8');},
    realpathSync:(path:string)=>fs.realpathSync(physical(path)).slice(root.length)||'/',
    mkdirSync:(path:string,options:any)=>{mutations.push(`mkdir:${path}`);return fs.mkdirSync(physical(path),options);},
    rmdirSync:(path:string)=>{mutations.push(`rmdir:${path}`);return fs.rmdirSync(physical(path));},
    writeFileSync:(path:string|number,data:any,options:any)=>{mutations.push(`write:${path}`);if(typeof path==='number')descriptor(path);return fs.writeFileSync(typeof path==='number'?path:physical(path),data,options);},
    linkSync:(from:string,to:string)=>{mutations.push(`link:${to}`);fs.linkSync(physical(from),physical(to));const owner=owners.get(from)??{uid:0,gid:0};owners.set(to,{uid:owner.uid,gid:owner.gid});},
    renameSync:(from:string,to:string)=>{mutations.push(`rename:${to}`);fs.renameSync(physical(from),physical(to));owners.set(to,owners.get(from)??{uid:0,gid:0});owners.delete(from);},
    unlinkSync:(path:string)=>{mutations.push(`unlink:${path}`);fs.unlinkSync(physical(path));owners.delete(path);},
    chmodSync:(path:string,mode:number)=>{mutations.push(`chmod:${path}`);return fs.chmodSync(physical(path),mode);},
    chownSync:(path:string,uid:number,gid:number)=>{mutations.push(`chown:${path}`);owners.set(path,{uid,gid});},
  };
  const file=(path:string,data:string,mode=0o644)=>{fs.mkdirSync(dirname(physical(path)),{recursive:true,mode:0o755});fs.writeFileSync(physical(path),data,{mode});fs.chmodSync(physical(path),mode);};
  fs.chmodSync(root,0o755);
  return {io,file,owners,mutations,physical,close:()=>fs.rmSync(root,{recursive:true,force:true})};
}
async function prepared() {
  const fixture=filesystemFixture(),calls:{path:string;args:string[];input?:string}[]=[],summaries:any[]=[];
  const directory=new URL('../../scripts/lima/',import.meta.url);
  for(const name of ['install-guest.mjs','probe-guest.mjs','policy.mjs','worker-enter.mjs','stage-lifetime.mjs'])fixture.file(decodeURI(new URL(name,directory).pathname),fs.readFileSync(new URL(name,directory),'utf8'));
  const contents:Record<string,string>={};
  for(const name of install.ARTIFACTS){
    if(name==='route-inventory.json')contents[name]=JSON.stringify(inventory());
    else if(name.startsWith('patrick-worker'))contents[name]=fs.readFileSync(new URL('../../examples/lima/'+name,import.meta.url),'utf8');
    else contents[name]=fs.readFileSync(new URL(name,directory),'utf8');
    fixture.file('/stage/'+name,contents[name]!,name==='route-inventory.json'?0o600:0o644);
  }
  fixture.file('/policy-input',JSON.stringify(policy));
  const manifest={version:1,controlAdmin:'admin',reviewedSources:{identity:'5c3f5188e41f04eff3a2564cd38208a7e3768019',proxy:'43659a3d6dc7a22e914ef654163842b158de428c'},policyHash:hash(JSON.stringify(policy)),files:Object.fromEntries(Object.entries(contents).map(([name,text])=>[name,hash(text)]))};
  fixture.file('/stage/manifest.json',JSON.stringify(manifest));
  const accountFacts=accounts();
  fixture.file('/etc/passwd','root:x:0:0::/root:/bin/sh\nadmin:x:1000:1000::/home/admin:/bin/bash\n'+Object.entries(accountFacts).map(([name,account])=>`${name}:x:${account.uid}:${account.gid}::${account.home}:${account.shell}`).join('\n')+'\n');
  fixture.file('/etc/group','root:x:0:\nadmin:x:1000:\n'+Object.entries(accountFacts).map(([name,account])=>`${name}:x:${account.gid}:`).join('\n')+'\n');
  fixture.file('/etc/shadow','root:!:1:0:99999:7:::\nadmin:$fixture:1:0:99999:7:::\n'+Object.keys(accountFacts).map(name=>`${name}:!:1:0:99999:7:::`).join('\n')+'\n',0o600);
  for(const [name,account] of Object.entries(accountFacts)){fs.mkdirSync(fixture.physical(`/var/lib/${name}`),{recursive:true,mode:0o700});fixture.owners.set(`/var/lib/${name}`,{uid:account.uid,gid:account.gid});}
  for(const path of ['/usr/local/bin/node',install.NODE,'/usr/bin/env','/usr/bin/dash','/usr/bin/setpriv','/usr/sbin/nft','/usr/bin/systemctl','/usr/bin/systemd-run','/usr/bin/sudo','/usr/sbin/visudo','/usr/sbin/useradd','/usr/sbin/groupadd','/usr/sbin/nologin','/usr/sbin/ip','/usr/bin/journalctl'])fixture.file(path,'fixture executable',0o755);
  fs.unlinkSync(fixture.physical('/usr/local/bin/node'));fs.symlinkSync(fixture.physical(install.NODE),fixture.physical('/usr/local/bin/node'));
  for(const path of ['/usr/local/libexec','/etc/systemd/system','/etc/sudoers.d','/run','/proc/4321/fd'])fs.mkdirSync(fixture.physical(path),{recursive:true,mode:0o755});
  fixture.file('/etc/resolv.conf','nameserver 192.0.2.53\n');fixture.file('/etc/hosts','127.0.0.1 localhost\n::1 localhost\n192.0.2.2 host.lima.internal\n');fixture.file('/proc/net/unix','Num RefCount Protocol Flags Type St Inode Path\n');
  fixture.file('/proc/4321/status','Name:\tnode\nUid:\t1100\t1100\t1100\t1100\nGid:\t1100\t1100\t1100\t1100\nGroups:\t\n');
  fixture.file('/proc/sys/kernel/random/boot_id','01234567-89ab-4cde-8fab-0123456789ab\n');fixture.file('/proc/5678/stat','5678 (node) '+['S',...Array(18).fill('0'),'12345'].join(' ')+'\n');fixture.file('/proc/5678/status','Uid:\t0\t0\t0\t0\n');fixture.file('/proc/5678/cmdline',Buffer.from(['/usr/local/bin/node','--no-addons',decodeURI(new URL('install-guest.mjs',directory).pathname),'--policy','/policy-input','--artifacts','/stage','--apply',''].join('\0')).toString());fs.symlinkSync(fixture.physical(install.NODE),fixture.physical('/proc/5678/exe'));
  fixture.file('/proc/self/mountinfo','1 0 0:1 / / rw - ext4 /dev/root rw\n');
  fixture.file('/proc/sys/kernel/hostname','fixture-host\n');
  fixture.file('/proc/4321/net/tcp','header\n'+[18743,18744,18745].map((port,index)=>`0: 0100007F:${port.toString(16)} 00000000:0000 0A 0:0 0:0 0 1100 0 ${9000+index} 1`).join('\n')+'\n');fixture.file('/proc/4321/net/tcp6','header\n');
  for(let index=0;index<3;index++)fs.symlinkSync(`socket:[${9000+index}]`,fixture.physical(`/proc/4321/fd/${index}`));
  const policyLibrary=await import(new URL('policy.mjs',directory).href),entryLibrary=await import(new URL('worker-enter.mjs',directory).href),lifetimeLibrary=await import(new URL('stage-lifetime.mjs',directory).href);
  let liveNft:any=null,transactionText='',failCommand='',activeState='active';
  const match=(left:any,right:any)=>({match:{op:'==',left,right}});
  function kernelNft(){const current=install.readAccounts(deps).facts,base={family:'inet',table:'patrick_worker'};return {nftables:[{metainfo:{version:'1.0.9',release_name:'fixture',json_schema_version:1}},{table:{family:'inet',name:'patrick_worker'}},{chain:{...base,name:'output',type:'filter',hook:'output',prio:-50,policy:'accept'}},...policy.workers.map(worker=>({chain:{...base,name:worker.runner+'_out'}})),...policy.workers.flatMap(worker=>[{rule:{...base,chain:'output',expr:[match({meta:{key:'skuid'}},current[worker.user]!.uid),{jump:{target:worker.runner+'_out'}}]}},{rule:{...base,chain:worker.runner+'_out',expr:[match({meta:{key:'oifname'}},'lo'),match({payload:{protocol:'ip',field:'daddr'}},'127.0.0.1'),match({payload:{protocol:'tcp',field:'dport'}},worker.proxyPort),{accept:null}]}},{rule:{...base,chain:worker.runner+'_out',expr:[{reject:{type:'icmpx',expr:'admin-prohibited'}}]}}])]};}
  const deps={io:fixture.io,installerPid:5678,effectiveUid:()=>0,now:()=>Date.parse('2026-11-04T00:01:00Z'),loadModules:async()=>({...policyLibrary,...entryLibrary,...lifetimeLibrary}),summary:(value:any)=>summaries.push(value),run:(path:string,args:string[],input?:string)=>{
    calls.push({path,args:[...args],input});const key=path+' '+args.join(' ');if(failCommand&&key.includes(failCommand))return {status:1,stdout:'private secret must not be reported'};
    let stdout='';
    if(path==='/usr/local/bin/node')stdout='v24.22.2\n';
    else if(path==='/usr/bin/env')stdout='--ignore-environment';
    else if(path==='/usr/bin/systemd-run')stdout='--unit --property --wait --pipe --collect';
    else if(path==='/usr/bin/sudo')stdout=`User ${args[3]} is not allowed to run sudo on fixture-host.\n`;
    else if(path==='/usr/bin/setpriv')stdout=args[0]==='--help'?'--reuid --regid --clear-groups --no-new-privs --bounding-set --inh-caps --ambient-caps':'denied\n';
    else if(path==='/usr/sbin/ip')stdout=JSON.stringify(args.includes('address')?[{addr_info:[{family:'inet',local:'192.0.2.10',scope:'global'}]}]:args.includes('-4')?[{dst:'default',gateway:'192.0.2.1'}]:[]);
    else if(path==='/usr/sbin/nft'){
      if(args[0]==='--version')stdout='nftables v1.0.9 (fixture)\n';
      else if(args.join(' ')==='-j list tables')stdout=JSON.stringify({nftables:liveNft?[{table:{family:'inet',name:'unrelated'}},{table:{family:'inet',name:'patrick_worker'}}]:[{table:{family:'inet',name:'unrelated'}}]});
      else if(args.join(' ')==='-j list table inet patrick_worker')stdout=JSON.stringify(liveNft);
      else if(args[0]==='-c')transactionText=fixture.io.readFileSync(args[2],'utf8');
      else if(args[0]==='-f'){expect(fixture.io.readFileSync(args[1],'utf8')).toBe(transactionText);liveNft=kernelNft();}
      else throw Error('unexpected nft command');
    }
    else if(path==='/usr/bin/systemctl'){
      if(args[0]==='--version')stdout='systemd 255 (fixture)\n';
      else if(args[0]==='list-units')stdout='';
      else if(args.includes('--property=FragmentPath,DropInPaths,LoadState')){const name=args[1];const loaded=fs.existsSync(fixture.physical('/etc/systemd/system/'+name));stdout=`FragmentPath=${loaded?'/etc/systemd/system/'+name:''}\nDropInPaths=\nLoadState=${loaded?'loaded':'not-found'}\n`;}
      else if(args.includes('--property=User,Group,MainPID,ActiveState,SubState,FragmentPath,DropInPaths'))stdout=`User=patrick-proxy\nGroup=patrick-proxy\nMainPID=4321\nActiveState=${activeState}\nSubState=running\nFragmentPath=/etc/systemd/system/patrick-worker-proxy.service\nDropInPaths=\n`;
      else if(args.includes('--property=ActiveState,SubState,MainPID'))stdout='ActiveState=inactive\nSubState=dead\nMainPID=0\n';
      else if(args.some(arg=>arg.startsWith('--property=NoNewPrivileges')))stdout='MemoryMax=268435456\nTasksMax=32\nPrivateNetwork=no\nAmbientCapabilities=\nCapabilityBoundingSet=\nNoNewPrivileges=yes\nLimitNOFILE=256\n';
      else if(!['daemon-reload','enable','start','stop'].includes(args[0]!))throw Error('unexpected systemctl command');
    }else if(path==='/usr/sbin/groupadd'){if(args[0]==='--help')stdout='--gid';else{const name=args.at(-1),id=args[1];fixture.file('/etc/group',fixture.io.readFileSync('/etc/group','utf8')+`${name}:x:${id}:\n`);}}
    else if(path==='/usr/sbin/useradd'){if(args[0]==='--help')stdout='--uid --gid --no-user-group --no-create-home --home-dir --shell --password';else{const name=args.at(-1),uid=args[1],gid=args[3];fixture.file('/etc/passwd',fixture.io.readFileSync('/etc/passwd','utf8')+`${name}:x:${uid}:${gid}::/var/lib/${name}:/usr/sbin/nologin\n`);fixture.file('/etc/shadow',fixture.io.readFileSync('/etc/shadow','utf8')+`${name}:!:1:0:99999:7:::\n`,0o600);}}
    else if(path!=='/usr/sbin/visudo')throw Error('unexpected process '+path);
    return {status:0,stdout,stderr:''};
  }};
  fixture.mutations.length=0;
  return {...fixture,deps,calls,summaries,manifest,contents,kernelNft,transaction:()=>transactionText,setFailure:(value:string)=>{failCommand=value;},setNft:(value:any)=>{liveNft=value;},setActive:(value:string)=>{activeState=value;},input:{policyPath:'/policy-input',artifactDir:'/stage',apply:false}};
}

describe('installed network qualification contract', () => {
 it('exports the fixed 21 IDs and root-internal runner with no general CLI', async () => {
  const module = await import(url.href);
  expect(module.networkProbeIds).toHaveLength(21);
  expect(new Set(module.networkProbeIds).size).toBe(21);
  expect(module.networkProbeIds).toEqual(JSON.parse(readFileSync(new URL('../fixtures/lima-qualification-cases.json', import.meta.url),'utf8')).gates['installed-network']);
  expect(typeof module.runInstalledNetwork).toBe('function');
  expect(Object.keys(module).sort()).toEqual(['networkProbeIds','runInstalledNetwork']);
 });
 it('refuses a host fixture without complete virtual dependencies before a privileged child', async () => {
  const module = await import(url.href);
  await expect(module.runInstalledNetwork({}, {}, {io:{},effectiveUid:()=>0})).rejects.toThrow('dependency');
 });
});

// Real installer and production lifetime controller over bounded virtual Linux
// FS/manager facts. The socket client is the very program passed to the helper.
async function networkFixture(options:any={}) {
 const f=await prepared();
 // Only test input policy/inventory is staged, before any installed generation.
 const raw=inventory();raw.exclusions.push({family:4,cidr:'10.20.0.0/16',categories:['lan']} as any);
 raw.routes.push({family:4,cidr:'10.20.0.0/16',classification:'private'});
 if(options.vpn)raw.exclusions.push({family:4,cidr:'100.90.0.0/16',categories:['vpn']} as any);
 if(options.moreHosts){(raw.host as any).addresses=['192.0.2.21','192.0.2.22'];for(const host of raw.host.addresses)raw.exclusions.push({family:4,cidr:host+'/32',categories:['host']} as any);}
 const {fingerprint:_,...data}=raw;raw.fingerprint=hash(JSON.stringify(data));
 const changedPolicy={...policy,workers:policy.workers.map(w=>({...w,hosts:w.runner==='grok'?['core.example.com']:options.nonempty?[`${w.runner}.example.com`]:[]}))};
 const text=JSON.stringify(changedPolicy);f.file('/policy-input',text);f.manifest.policyHash=hash(text);
 f.contents['route-inventory.json']=JSON.stringify(raw);f.manifest.files['route-inventory.json']=hash(f.contents['route-inventory.json']);f.file('/stage/route-inventory.json',f.contents['route-inventory.json'],0o600);f.file('/stage/manifest.json',JSON.stringify(f.manifest));
 f.file('/usr/bin/journalctl','fixture executable',0o755);
 await install.installGuest({...f.input,apply:true},f.deps);
 const state=await install.inspectInstalled(f.deps);const session=await probe.probeGuest('qualification-start',f.deps);
 const tlsModule=await import(new URL('../../scripts/lima/tls-clienthello.mjs',import.meta.url).href);
 const units=new Map<string,any>(),submissions:any[]=[],requests:any[]=[],events:any[]=[],children:any[]=[];
 const boot='0123456789ab4cde8fab0123456789ab',invocation='e'.repeat(32);
 let counter=0,counts:any={HEADER:0,TLS:0},pending=0;
 const journal:any[]=[];
 const log=(reason:string)=>{counts[reason]=(counts[reason]??0)+1;journal.push({__CURSOR:'s=fixture;i='+(++counter),__REALTIME_TIMESTAMP:String(100000+counter),__MONOTONIC_TIMESTAMP:String(1000+counter),_BOOT_ID:boot,_SYSTEMD_UNIT:'patrick-worker-proxy.service',_SYSTEMD_INVOCATION_ID:invocation,_PID:'4321',_TRANSPORT:'stdout',MESSAGE:reason+' '+counts[reason]});};
 if(!options.noBaseline){log('HEADER');log('TLS');}
 const run=f.deps.run;
 f.deps.run=(path:string,args:string[],input?:string)=>{
  if(path==='/usr/bin/journalctl'){
   let rows=journal;const cursor=args.find(a=>a.startsWith('--cursor='));if(cursor){const i=journal.findIndex(r=>r.__CURSOR===cursor.slice(9));rows=i<0?[]:journal.slice(i);}
   let output=rows.map(r=>JSON.stringify(r)).join('\n')+(rows.length?'\n-- cursor: '+rows.at(-1).__CURSOR+'\n':'');
   if(options.journal==='wrong-lineage'&&rows.length)output=output.replaceAll('"_PID":"4321"','"_PID":"4322"');
   if(options.journal==='truncated'&&output)output=output.slice(0,-1);
   if(options.journal==='duplicate'&&rows.length)output=JSON.stringify(rows[0])+'\n'+output;
   if(options.journal==='regression'&&rows.length)output=output.replace(/HEADER [1-9][0-9]*/, 'HEADER 0');
   if(options.journal==='unknown-reason'&&rows.length)output=output.replace(/HEADER [1-9][0-9]*/, 'UNKNOWN 1');
   return {status:0,stdout:output,stderr:''};
  }
  if(path==='/usr/bin/systemctl'&&args.includes('--property=InvocationID,MainPID,ActiveState,SubState'))return {status:0,stdout:`InvocationID=${invocation}\nMainPID=4321\nActiveState=active\nSubState=running\n`,stderr:''};
  const result=run(path,args,input);
  if(options.proxyDrift&&requests.length&&path==='/usr/bin/systemctl'&&args.includes('--property=User,Group,MainPID,ActiveState,SubState,FragmentPath,DropInPaths'))return {...result,stdout:result.stdout.replace('MainPID=4321','MainPID=4322')};
  if(options.nftDrift&&requests.length&&path==='/usr/sbin/nft'&&args.join(' ')==='-j list table inet patrick_worker')return {...result,stdout:JSON.stringify({nftables:[]})};
  return result;
 };
 function observation(spec:any,context:any){const a=state.accounts[context.user],auth=['cli','acp'].includes(spec.stage);return {pid:7000+submissions.length,start:'12',directEnvironmentClean:true,postDrop:{uid:a.uid,gid:a.gid,groups:[],noNewPrivileges:true,capEffective:'0',capPermitted:'0',capInheritable:'0',capAmbient:'0',capBounding:'0',homeMatches:true,fixedEnvironmentMatches:true,extraEnvironmentKeys:[],unknownEnvironmentKeyPresent:false,derivedPwdMatchesHome:true,derivedOldPwdMatchesTrustedCwd:true},profileFacts:{persistentMarkerReadable:auth,persistentMarkerUnchanged:true,persistentConfigUnchanged:true,privateHomeWritable:true,privateScratchRemoved:true,workspaceMatchesRecord:true,closedNetworkObserved:!auth}};}
 function clientProcess(program:string,configuration:any,child:any){
  const input:Buffer[]=[],waiters:any[]=[];let ended=false;
  const pump=()=>{while(waiters.length&&(input.length||ended)){const [buffer,callback]=waiters.shift();if(!input.length)callback(null,0,buffer);else{const first=input[0]!;buffer[0]=first[0]!;input[0]=first.subarray(1);if(!input[0]!.length)input.shift();callback(null,1,buffer);}}};
  child.stdin.on('data',(b:Buffer)=>{input.push(options.badContinuation?Buffer.from('network-continue:999\n'):Buffer.from(b));pump();});child.stdin.on('end',()=>{ended=true;pump();});
  const fakeFs={read:(fd:number,buffer:Buffer,offset:number,length:number,position:null,callback:any)=>{expect([fd,offset,length,position]).toEqual([0,0,1,null]);waiters.push([buffer,callback]);pump();}};
  const socket=(udp=false,direct=false)=>{
   const s:any=Object.assign(new EventEmitter(),{destroyed:false,remoteAddress:'127.0.0.1',end:()=>{s.destroy();},destroy:()=>{if(s.destroyed)return;s.destroyed=true;queueMicrotask(()=>s.emit('close'));},setTimeout:()=>s,connect:()=>s,close:()=>s.destroy(),send:(_b:Buffer,_p:number,_h:string,cb:any)=>{requests.push({kind:'udp',target:_h,port:_p});queueMicrotask(()=>{const e=Object.assign(Error(),{code:options.socketError??'EPERM'});cb?.(e);s.emit('error',e);});},write:(b:Buffer|string)=>{const bytes=Buffer.from(b);if(bytes.toString().startsWith('CONNECT ')){const authority=bytes.toString().split(' ')[1]!;requests.push({kind:'connect',target:authority});const allowed=changedPolicy.workers.find(w=>w.proxyPort===configuration.proxyPort)!.hosts.some(h=>authority===h+':443');queueMicrotask(()=>{if(allowed&&options.dnsFailure){log('DNS');s.destroy();}else if(allowed){s.emit('data',Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n'));}else{log('HEADER');s.destroy();}});}else{let parsed:any;try{parsed=tlsModule.readClientHelloSni(bytes);}catch{}if(configuration.steps.find((t:any)=>t.hello==='wrong-sni')&&parsed?.status==='complete')expect(parsed.hostname).not.toBe('core.example.com');requests.push({kind:'tls',parsed:parsed??'denied'});queueMicrotask(()=>{log(options.allowUpstream?'CONNECT':options.tlsReason??'TLS');if(options.extraEvent)log('TLS');if(options.allowUpstream)s.emit('data',Buffer.from('unexpected upstream'));s.destroy();});}return true;}});
   if(!udp&&!direct)queueMicrotask(()=>s.emit('connect'));return s;
  };
  const fakeNet={createConnection:(o:any)=>{if(o.host==='127.0.0.1'&&o.port===configuration.proxyPort)return socket();requests.push({kind:'tcp',...o});const s=socket(false,true);queueMicrotask(()=>s.emit('error',Object.assign(Error(),{code:options.socketError??'EPERM'})));s.removeAllListeners('connect');return s;}};
  const fakeDgram={createSocket:()=>socket(true)};
  const fakeProcess={stdout:{write:(b:string)=>{const frame=JSON.parse(b);if(options.clientFrame==='skip'&&frame.next===0)child.stdout.write(JSON.stringify({next:1})+'\n');else if(options.clientFrame==='repeat'&&frame.next===0){child.stdout.write(b);child.stdout.write(b);}else if(options.clientFrame==='truncated'&&Object.hasOwn(frame,'done'))child.stdout.write(b.slice(0,-1));else child.stdout.write(b);if(options.extraRecord&&frame.index===0){const v=JSON.parse(f.io.readFileSync('/etc/patrick-worker/qualification.json','utf8'));v.records.push('b'.repeat(32));f.file('/etc/patrick-worker/qualification.json',JSON.stringify(v),0o600);}if(options.markerDrift&&frame.index===0){fs.chmodSync(f.physical(configuration.home+'/.patrick-synthetic-auth'),0o644);f.file(configuration.home+'/.patrick-synthetic-auth','changed',0o444);}return true;}},stderr:{write:(b:string)=>{child.stderr.write(b);return true;}},argv:['node',JSON.stringify(configuration)],exitCode:0,getuid:()=>configuration.uid,geteuid:()=>configuration.uid,getgid:()=>configuration.gid,getegid:()=>configuration.gid,getgroups:()=>[],env:{HOME:configuration.home,HTTP_PROXY:'http://127.0.0.1:'+configuration.proxyPort}};
  return runInNewContext(program,{require:(n:string)=>n==='node:fs'?fakeFs:n==='node:net'?fakeNet:n==='node:dgram'?fakeDgram:(()=>{throw Error('forbidden import '+n);})(),process:fakeProcess,Buffer,setTimeout,clearTimeout,queueMicrotask,Promise,console:undefined}).then(()=>({code:fakeProcess.exitCode}));
 }
 (f.deps as any).spawn=(command:string,args:string[],opts:any)=>{
  expect(command).toBe('/usr/local/libexec/patrick-worker-enter');expect(fs.existsSync(f.physical('/run/patrick-worker/install.lock'))).toBe(false);
  expect(opts).toEqual({cwd:'/',env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C'},stdio:['pipe','pipe','pipe']});
  const parsed=state.modules.parseArguments(args),{context,lifetime:life}=parsed;events.push({stage:life.stage,operation:life.operation,role:context.runner});
  const child:any=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),kill:()=>{child.stdin.end();return true;}});children.push(child);
  const manager={
   submit:(spec:any)=>{submissions.push(spec);const facts={description:spec.description,invocationId:'f'.repeat(32),controlGroup:'/system.slice/'+spec.unit,active:true,empty:false};units.set(spec.unit,facts);let complete:any;
    const completion=new Promise<any>(resolve=>{complete=resolve;});
    return {completion:completion.then(value=>{facts.active=false;facts.empty=true;if(spec.stage==='cleanup'&&!options.cleanupFail)fs.rmSync(f.physical(spec.workspace),{recursive:true,force:true});return value;}),release:()=>{pending++;
     if(['cli','acp'].includes(spec.stage)){
      const cmd=parsed.command,program=cmd[cmd.indexOf('-e')+1],config=JSON.parse(cmd.at(-1));
      clientProcess(program,config,child).then(complete,()=>complete({code:78})).finally(()=>pending--);
     }else{let raw='';child.stdin.on('data',(b:Buffer)=>raw+=b);child.stdin.on('end',()=>{if(spec.stage==='prepare')child.stdout.write(JSON.stringify({dir:spec.workspace}));pending--;complete({code:spec.stage==='cleanup'&&options.cleanupFail?78:0,assertion:{version:1,stage:spec.stage,persistentMarkerReadable:false,privateHomeWritable:true,privateScratchRemoved:true,initialHomeEmpty:true,closedNetworkDenied:true}});});}
    }};
   },acknowledge:async(unit:string)=>units.get(unit),inspect:async(unit:string)=>units.get(unit),pending:async()=>false,stop:async(unit:string)=>{if(options.stopFail)throw Error('virtual owned stop failure');const facts=units.get(unit);if(facts){facts.active=false;facts.empty=true;}},observeStage:async({stage}:any)=>observation(stage,context)
  };
  const ld={io:f.io,effectiveUid:()=>0,trust:()=>{},identity:()=>state.accounts[context.user],recover:async(c:any)=>state.modules.recoveryBinding(c,await install.inspectRecordAuthority(f.deps)),admit:async(c:any,command:any)=>state.modules.installedAdmission(c,command,state),manager,observe:()=>({workerProcessesAbsent:true,privateMountsAbsent:true,cgroupsEmpty:true}),boot:()=> '01234567-89ab-4cde-8fab-0123456789ab',witness:()=>({pid:5678,start:'12345'})};
  queueMicrotask(()=>lifetime.executeStage(parsed,ld).then((result:any)=>{if(result?.version===1)child.stdout.write(JSON.stringify(result)+'\n');child.stdout.end();child.stderr.end();child.emit('close',0,null);},(error:any)=>{child.stderr.write('Worker entry denied.\n');child.stdout.end();child.stderr.end();child.emit('close',78,null);}));return child;
 };
 const privateSession=()=>JSON.parse(f.io.readFileSync('/etc/patrick-worker/qualification.json','utf8'));
 f.mutations.length=0;f.calls.length=0;
 return {...f,state,session:privateSession(),privateSession,events,requests,submissions,journal,counts,pending:()=>pending};
}

describe('fixed installed client, targets, journal and lifetime',()=>{
 it('visits every derived target for all three roles through the common helper and reports 59 pairs',async()=>{
  const f=await networkFixture();try{
   const {runInstalledNetwork}=await import(url.href);const report=await runInstalledNetwork(f.state,f.session,f.deps);
   expect(report).toMatchObject({version:1,operation:'qualification-network',outcome:'pass',reason:'ok',actualGuest:false,preconditionRequests:{header:0,tls:0}});
   expect(report.results).toHaveLength(59);expect(new Set(report.results.map((r:any)=>r.id+'/'+r.role)).size).toBe(59);
   expect(report.results.find((r:any)=>r.id==='network-vpn'&&r.role==='grok')).toMatchObject({status:'not_applicable',network:{targets:0,attempted:0,denied:0,basis:'no-inventory-target',gate:'inventory'}});
   expect(report.results.find((r:any)=>r.id==='network-loopback-ipv6'&&r.role==='grok')).toMatchObject({status:'pass',network:{targets:1,attempted:1,denied:1}});
   expect(report.results.find((r:any)=>r.id==='network-empty-codex')).toMatchObject({status:'pass',role:'codex',network:{targets:5,attempted:5,denied:5,basis:'empty-allowlist'}});
   expect(f.requests.some((r:any)=>r.host==='10.20.0.1')).toBe(true);
   expect(f.events.filter((e:any)=>e.operation==='exec').map((e:any)=>e.stage)).toEqual(['prepare','cli','cleanup','prepare','cli','cleanup','prepare','acp','cleanup']);
   expect(f.events.filter((e:any)=>e.operation==='stop')).toHaveLength(3);expect(f.events.filter((e:any)=>e.operation==='reconcile')).toHaveLength(3);
   expect(f.privateSession().networkOperation.phase).toBe('complete');expect(f.privateSession().networkOperation.roles.every((r:any)=>r.phase==='closed')).toBe(true);
   expect(f.pending()).toBe(0);expect(f.calls.every((c:any)=>!(c.path==='/usr/bin/systemctl'&&['stop','start','enable','daemon-reload'].includes(c.args[0]))&&!(c.path==='/usr/sbin/nft'&&c.args[0]==='-f'))).toBe(true);
  }finally{f.close();}
 });
 it.each(['ECONNREFUSED','ETIMEDOUT','ENETUNREACH'])('does not substitute %s for permission-denial evidence',async socketError=>{
  const f=await networkFixture({socketError});try{const {runInstalledNetwork}=await import(url.href),r=await runInstalledNetwork(f.state,f.session,f.deps);expect(r.outcome).toBe('fail');expect(r.results.find((v:any)=>v.id==='network-direct-ip443')).toMatchObject({status:'fail',network:{attempted:1,denied:0}});}finally{f.close();}
 });
 it.each([{tlsReason:'HEADER'},{extraEvent:true},{journal:'wrong-lineage'},{journal:'truncated'},{journal:'duplicate'},{journal:'regression'},{journal:'unknown-reason'},{dnsFailure:true},{allowUpstream:true}])('requires the intended exact journal interval %j',async options=>{
  const f=await networkFixture(options);try{const {runInstalledNetwork}=await import(url.href),r=await runInstalledNetwork(f.state,f.session,f.deps);expect(r.outcome).toBe('fail');expect(r.results.some((v:any)=>v.status==='fail')).toBe(true);}finally{f.close();}
 });
 it('records at most one separate precondition per reason across the whole operation',async()=>{
  const f=await networkFixture({noBaseline:true});try{const {runInstalledNetwork}=await import(url.href),r=await runInstalledNetwork(f.state,f.session,f.deps);expect(r).toMatchObject({outcome:'pass',preconditionRequests:{header:1,tls:1}});expect(f.privateSession().networkOperation.preconditionRequests).toEqual({header:1,tls:1});expect(r.results.find((v:any)=>v.id==='network-wrong-sni'&&v.role==='grok').network.attempted).toBe(1);}finally{f.close();}
 });
 it('refuses duplicate operations and finish while running, even before any payload record',async()=>{
  const f=await networkFixture();try{const {runInstalledNetwork}=await import(url.href);const saved=f.privateSession();saved.networkOperation={phase:'running'};f.file('/etc/patrick-worker/qualification.json',JSON.stringify(saved),0o600);await expect(runInstalledNetwork(f.state,f.session,f.deps)).rejects.toThrow();await expect(probe.probeGuest('qualification-finish',f.deps)).rejects.toThrow();expect(f.submissions).toEqual([]);}finally{f.close();}
 });
 it('rejects incomplete inventory, installed-byte drift and unexpected records without absence exemptions',async()=>{
  for(const kind of ['inventory','extra-record','code']){const f=await networkFixture();try{
   if(kind==='inventory')f.file('/etc/patrick-worker/route-inventory.json','{}',0o600);
   if(kind==='extra-record'){const v=f.privateSession();v.records.push('b'.repeat(32));f.file('/etc/patrick-worker/qualification.json',JSON.stringify(v),0o600);}
   if(kind==='code')f.file('/usr/local/libexec/patrick-worker/installed-network.mjs','drift',0o755);
   const {runInstalledNetwork}=await import(url.href);await expect(runInstalledNetwork(f.state,f.session,f.deps)).rejects.toThrow();expect(f.submissions).toEqual([]);
  }finally{f.close();}}
 });
});


describe('network operation interrupted ownership and byte protocol',()=>{
 it.each([{clientFrame:'skip'},{clientFrame:'repeat'},{clientFrame:'truncated'},{badContinuation:true}])('refuses ambiguous client/parent framing %j and still closes exact owned work',async options=>{
  const f=await networkFixture(options);try{const {runInstalledNetwork}=await import(url.href);const r=await runInstalledNetwork(f.state,f.session,f.deps);expect(r.outcome).toBe('fail');expect(r.results.every((v:any)=>v.status!=='pass')).toBe(true);expect(f.events.filter((e:any)=>e.operation==='stop')).toHaveLength(3);expect(f.events.filter((e:any)=>e.operation==='exec'&&e.stage==='cleanup')).toHaveLength(3);expect(f.privateSession().networkOperation.phase).toBe('complete');}finally{f.close();}
 });
 it.each([{stopFail:true},{cleanupFail:true},{markerDrift:true}])('retains uncertainty/cleanup precedence for %j without repeating cleanup',async options=>{
  const f=await networkFixture(options);try{const {runInstalledNetwork}=await import(url.href);const r=await runInstalledNetwork(f.state,f.session,f.deps);expect(r).toMatchObject({outcome:'fail',reason:'lifetime'});expect(f.events.filter((e:any)=>e.operation==='stop')).toHaveLength(1);expect(f.events.filter((e:any)=>e.operation==='exec'&&e.stage==='cleanup').length).toBeLessThanOrEqual(1);expect(f.privateSession().networkOperation.phase).not.toBe('complete');await expect(probe.probeGuest('qualification-finish',f.deps)).rejects.toThrow();expect(f.events.filter((e:any)=>e.operation==='exec'&&e.stage==='prepare')).toHaveLength(1);}finally{f.close();}
 });
 it('covers all configured addresses, representative routes, VPN and nonempty-list applicability',async()=>{
  const f=await networkFixture({moreHosts:true,vpn:true,nonempty:true});try{const {runInstalledNetwork}=await import(url.href);const r=await runInstalledNetwork(f.state,f.session,f.deps);expect(r.outcome).toBe('pass');for(const host of ['192.0.2.21','192.0.2.22','10.20.0.1','100.90.0.1'])expect(f.requests.filter((q:any)=>q.host===host)).toHaveLength(3);expect(r.results.find((v:any)=>v.id==='network-empty-codex')).toMatchObject({status:'not_applicable',network:{targets:0,attempted:0,denied:0,basis:'nonempty-allowlist',gate:'inventory'}});}finally{f.close();}
 });
 it('refuses a running operation before its first child; a second caller cannot replace its private ownership',async()=>{
  const f=await networkFixture();try{
   const {runInstalledNetwork}=await import(url.href),original=(f.deps as any).spawn;let resume!:()=>void;const blocked=new Promise<void>(resolve=>{resume=resolve;});let first=true;
   (f.deps as any).spawn=(...args:any[])=>{if(first){first=false;const child:any=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),kill:()=>true});blocked.then(()=>{const real=original(...args);child.stdin.pipe(real.stdin);real.stdout.pipe(child.stdout);real.stderr.pipe(child.stderr);real.on('close',(...v:any[])=>child.emit('close',...v));});return child;}return original(...args);};
   const running=runInstalledNetwork(f.state,f.session,f.deps);for(let n=0;n<200&&!fs.existsSync(f.physical('/run/patrick-worker/install.lock'))&&(!f.privateSession().networkOperation||f.privateSession().networkOperation.roles[0].phase!=='submitting');n++)await new Promise(r=>setTimeout(r,5));
   const saved=f.privateSession();expect(saved.networkOperation.phase).toBe('running');expect(saved.records).toEqual([]);
   await expect(runInstalledNetwork(f.state,f.session,f.deps)).rejects.toThrow();await expect(probe.probeGuest('qualification-finish',f.deps)).rejects.toThrow();expect(f.privateSession()).toEqual(saved);resume();await running;
  }finally{f.close();}
 });
 it('never resurrects a deleted/replaced session when an awaited trust check returns',async()=>{
  for(const mode of ['delete','replace']){const f=await networkFixture();try{
   const load=f.deps.loadModules;let injected=false;
   f.deps.loadModules=async()=>{const modules=await load();if(!injected&&f.privateSession().networkOperation?.roles[0].phase==='prepared'){injected=true;if(mode==='delete')fs.unlinkSync(f.physical('/etc/patrick-worker/qualification.json'));else{const v=f.privateSession();v.generation='f'.repeat(32);f.file('/etc/patrick-worker/qualification.json',JSON.stringify(v),0o600);}}return modules;};
   const {runInstalledNetwork}=await import(url.href);await runInstalledNetwork(f.state,f.session,f.deps);expect(injected).toBe(true);if(mode==='delete')expect(fs.existsSync(f.physical('/etc/patrick-worker/qualification.json'))).toBe(false);else expect(f.privateSession().generation).toBe('f'.repeat(32));
  }finally{f.close();}}
 });
});


describe('network unchanged root policy and session observations',()=>{
 it.each([{proxyDrift:true},{nftDrift:true},{extraRecord:true}])('does not clear ownership or pass after %j and still attempts the exact owned stop',async options=>{
  const f=await networkFixture(options);try{const {runInstalledNetwork}=await import(url.href);const r=await runInstalledNetwork(f.state,f.session,f.deps);expect(r.outcome).toBe('fail');expect(r.results.every((v:any)=>v.status!=='pass')).toBe(true);expect(f.events.filter((e:any)=>e.operation==='stop')).toHaveLength(1);expect(f.privateSession().networkOperation.phase).not.toBe('complete');await expect(probe.probeGuest('qualification-finish',f.deps)).rejects.toThrow();}finally{f.close();}
 });
});
