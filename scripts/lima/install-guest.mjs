#!/usr/local/bin/node
// Guest-admin entry point. Local modules are imported only after the complete
// root-owned code set is checked. A staged manifest is an integrity record;
// the parent must bind its hashes to separately reviewed sources before copy.
import * as fs from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/** @typedef {import('./worker-enter.mjs').TrustedModules} TrustedModules */
/** @typedef {import('./worker-enter.mjs').InstalledManifest} InstalledManifest */
/** @typedef {import('./worker-enter.mjs').RecordAuthorityState} RecordAuthorityState */
/** @typedef {ReturnType<typeof productionDependencies> & {installerPid?:number,registryModules?:TrustedModules,summary?:(value:object)=>void}} InstallDependencies */
/** @typedef {Readonly<{artifactHash:string,policyHash:string}>} InstallTarget */
/** @typedef {Readonly<{version:1,kind:'installer',pid:number,startTime:string,bootId:string,artifactHash:string,policyHash:string}>} InstallerLockOwner */
/** @typedef {Readonly<{kind:'pristine'}>|Readonly<{kind:'existing'|'first-apply-retry',registry:import('./stage-lifetime.mjs').RegistryReference}>} InstallRegistryClass */

const HERE=dirname(fileURLToPath(import.meta.url));
export const CODE='/usr/local/libexec/patrick-worker';
export const CONFIG='/etc/patrick-worker';
export const NODE='/opt/patrick/node-v24.22.2-linux-arm64/bin/node';
export const ARTIFACTS=Object.freeze(['worker-enter.mjs','policy.mjs','connect-proxy.mjs','address-policy.mjs','tls-clienthello.mjs','install-guest.mjs','probe-guest.mjs','stage-lifetime.mjs','synthetic-worker.mjs','synthetic-network.mjs','installed-network.mjs','patrick-worker-firewall.service','patrick-worker-proxy.service','patrick-worker-sudoers','patrick-worker-probe','route-inventory.json']);
const SOURCES={identity:'5c3f5188e41f04eff3a2564cd38208a7e3768019',proxy:'43659a3d6dc7a22e914ef654163842b158de428c'};
const REASONS=new Set(['arguments','not_root','untrusted_artifact','dependency','account_conflict','inventory_incomplete','policy_invalid','active_worker','nft_check','nft_apply','service_state','installed_mismatch']);
const RUNTIME='/run/patrick-worker',DURABLE='/var/lib/patrick-worker',REGISTRY=DURABLE+'/invocations',WITNESS=CONFIG+'/registry-identity.json',MARKER=REGISTRY+'/.authority.json';
const ENV=Object.freeze({PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C'});
const LAUNCHER='#!/usr/bin/dash\nexec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C \\\n  /usr/local/bin/node --no-addons \\\n  /usr/local/libexec/patrick-worker/worker-enter.mjs "$@"\n';
const fail=reason=>{const error=new Error(reason);error.reason=reason;throw error;};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const sha=value=>createHash('sha256').update(value).digest('hex');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const absolute=value=>typeof value==='string'&&value.startsWith('/')&&value.length<=4096&&resolve(value)===value&&!value.includes('\0')&&value.isWellFormed();
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const same=(a,b)=>canonical(a)===canonical(b);
const registryReference=value=>exact(value,['version','authorityId','witnessHash'])&&value.version===1&&/^[a-f0-9]{32}$/.test(value.authorityId)&&digest(value.witnessHash);
const referenceOf=authority=>({version:1,authorityId:authority.authorityId,witnessHash:authority.witnessHash});
const numeric=value=>Number.isSafeInteger(value)&&value>=1000&&value<=2147483647;
const safeName=value=>typeof value==='string'&&/^[a-z_][a-z0-9_-]{0,31}$/.test(value);
const exists=(path,io)=>{try{io.lstatSync(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};

export function parseInstallArguments(argv) {
  if(!Array.isArray(argv))fail('arguments');
  const result={};
  for(let index=0;index<argv.length;index++){
    const key=argv[index];
    if(!['--policy','--artifacts','--check','--apply'].includes(key)||Object.hasOwn(result,key))fail('arguments');
    if(key==='--policy'||key==='--artifacts'){if(!absolute(argv[++index]))fail('arguments');result[key]=argv[index];}else result[key]=true;
  }
  if(!result['--policy']||!result['--artifacts']||Boolean(result['--check'])===Boolean(result['--apply']))fail('arguments');
  return {policyPath:result['--policy'],artifactDir:result['--artifacts'],apply:Boolean(result['--apply'])};
}

export function trustedPath(path,{kind='file',uid=0,gid,mode}={},io=fs) {
  if(!absolute(path))fail('untrusted_artifact');
  const chain=[];for(let current=path;;current=dirname(current)){chain.unshift(current);if(current==='/')break;}
  for(const current of chain){const info=io.lstatSync(current),leaf=current===path;
    if(info.isSymbolicLink()||info.uid!==(leaf?uid:0)||(info.mode&0o022)!==0||(leaf&&kind==='file'?!info.isFile():!info.isDirectory())||(leaf&&gid!==undefined&&info.gid!==gid)||(leaf&&mode!==undefined&&(info.mode&0o777)!==mode))fail('untrusted_artifact');
  }
}
export function trustedRead(path,io=fs,max=1048576) {
  trustedPath(path,{},io);const fd=io.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {const info=io.fstatSync(fd);if(!info.isFile()||info.uid!==0||(info.mode&0o022)!==0||info.size>max)fail('untrusted_artifact');const bytes=io.readFileSync(fd);if(!Buffer.isBuffer(bytes)||bytes.length>max||!isUtf8(bytes))fail('untrusted_artifact');return bytes.toString('utf8');}finally{io.closeSync(fd);}
}
// Same complete-component traversal and lossless UTF-8 semantics as reviewed
// worker-enter. This bootstrap cannot import that module before trusting it.
export function trustedExecutable(path,io=fs,executable=true) {
  if(!absolute(path))fail('dependency');
  try {
    const root=io.lstatSync('/');if(root.uid!==0||(root.mode&0o022)||!root.isDirectory()||root.isSymbolicLink())fail('dependency');
    let current='/',pending=path.slice(1).split('/'),links=0,steps=0;
    while(pending.length){if(++steps>4096)fail('dependency');const component=pending.shift();if(component===''||component==='.')continue;if(component==='..'){current=dirname(current);continue;}
      const candidate=current==='/'?`/${component}`:`${current}/${component}`,info=io.lstatSync(candidate);if(info.uid!==0)fail('dependency');
      if(info.isSymbolicLink()){if(++links>40)fail('dependency');const bytes=io.readlinkSync(candidate,{encoding:'buffer'});if(!Buffer.isBuffer(bytes)||!isUtf8(bytes))fail('dependency');const target=bytes.toString('utf8');if(!target||target.length>4096||target.includes('\0'))fail('dependency');const absoluteTarget=target.startsWith('/');if(absoluteTarget)current='/';pending=[...(absoluteTarget?target.slice(1):target).split('/'),...pending];}
      else {if(info.mode&0o022)fail('dependency');if(pending.length){if(!info.isDirectory())fail('dependency');current=candidate;}else{if(!info.isFile()||(executable&&!(info.mode&0o111))||((info.mode&0o6000)&&path!=='/usr/bin/sudo'))fail('dependency');return;}}
    }fail('dependency');
  } catch {fail('dependency');}
}
export function inspectArtifacts(directory,io=fs) {
  try {
    trustedPath(directory,{kind:'directory'},io);
    if(!same(io.readdirSync(directory).sort(),[...ARTIFACTS,'manifest.json'].sort()))fail('untrusted_artifact');
    const manifest=JSON.parse(trustedRead(join(directory,'manifest.json'),io));
    if(!exact(manifest,['version','controlAdmin','reviewedSources','policyHash','files'])||manifest.version!==1||!safeName(manifest.controlAdmin)||manifest.controlAdmin==='root'||manifest.controlAdmin.startsWith('patrick-')||!exact(manifest.reviewedSources,['identity','proxy'])||!same(manifest.reviewedSources,SOURCES)||!digest(manifest.policyHash)||!exact(manifest.files,ARTIFACTS))fail('untrusted_artifact');
    const contents={};for(const name of ARTIFACTS){const path=join(directory,name);trustedPath(path,{mode:name==='route-inventory.json'?0o600:0o644},io);contents[name]=trustedRead(path,io);if(!digest(manifest.files[name])||sha(contents[name])!==manifest.files[name])fail('untrusted_artifact');}
    return {manifest,contents,artifactHash:sha(canonical(manifest))};
  } catch {fail('untrusted_artifact');}
}

export function planAccounts(policy,facts,admin) {
  const names=[...policy.workers.map(worker=>worker.user),policy.proxyUser];
  if(!safeName(admin)||admin==='root'||names.includes(admin)||!facts||typeof facts!=='object'||!facts[admin]||!numeric(facts[admin].uid)||!numeric(facts[admin].gid))fail('account_conflict');
  const missing=[];
  for(const name of names){const account=facts[name];if(!account){missing.push(name);continue;}
    if(!numeric(account.uid)||!numeric(account.gid)||account.home!==`/var/lib/${name}`||!Array.isArray(account.groups)||account.groups.length||account.shell!=='/usr/sbin/nologin'||account.locked!==true||account.primaryGroup!==name)fail('account_conflict');
    for(const [other,value] of Object.entries(facts))if(other!==name&&(!value||value.uid===account.uid||value.gid===account.gid))fail('account_conflict');
  }
  return {names,missing};
}
function canonicalCidr(value,family) {
  if(typeof value!=='string'||value.length>64)fail('inventory_incomplete');const parts=value.split('/');if(parts.length!==2||!/^(0|[1-9]\d{0,2})$/.test(parts[1])||isIP(parts[0])!==family)fail('inventory_incomplete');
  const bits=family===4?32:128,prefix=Number(parts[1]);if(prefix>bits)fail('inventory_incomplete');
  let words;if(family===4)words=parts[0].split('.').map(Number);else {if(parts[0]!==parts[0].toLowerCase()||parts[0].includes('.'))fail('inventory_incomplete');const halves=parts[0].split('::'),left=halves[0]?halves[0].split(':'):[],right=halves[1]?halves[1].split(':'):[];words=(halves.length===2?[...left,...Array(8-left.length-right.length).fill('0'),...right]:left).map(word=>parseInt(word,16));}
  const step=family===4?8:16,number=words.reduce((sum,word)=>(sum<<BigInt(step))|BigInt(word),0n),shift=BigInt(bits-prefix);
  if((number>>shift)<<shift!==number)fail('inventory_incomplete');
  // IPv6 canonical spelling uses Node's URL normalizer, including :: compression.
  const normalized=family===4?words.join('.'):new URL(`http://[${parts[0]}]/`).hostname.slice(1,-1);
  if(value!==`${normalized}/${prefix}`)fail('inventory_incomplete');return value;
}
const SOURCE_KINDS=['guest-addresses','guest-routes','guest-resolvers','guest-host-aliases','lima-host-gateway','mac-addresses','lan-vpn-routes','host-resolvers','translator','guest-admin-sockets'];
const INTERNET=new Set(['0.0.0.0/0','0.0.0.0/1','128.0.0.0/1','::/0','::/1','8000::/1']);
export function validateInventory(raw,policy,guest,now=Date.now()) {
  try {
    if(!exact(raw,['version','collectedAt','sources','sourceVersion','translator','translatorPrefixes','extraPrivilegedSocketPaths','guest','host','lima','exclusions','routes','fingerprint'])||raw.version!==1||raw.sourceVersion!==1||!same(raw.sources,SOURCE_KINDS.map(kind=>({kind,version:1})))||!['unknown','disabled','complete'].includes(raw.translator)||!Array.isArray(raw.translatorPrefixes)||raw.translatorPrefixes.length>16||!Array.isArray(raw.exclusions)||raw.exclusions.length>128||!Array.isArray(raw.routes)||raw.routes.length>256||!digest(raw.fingerprint))fail('inventory_incomplete');
    if(!Array.isArray(raw.extraPrivilegedSocketPaths)||raw.extraPrivilegedSocketPaths.length>64||new Set(raw.extraPrivilegedSocketPaths).size!==raw.extraPrivilegedSocketPaths.length||raw.extraPrivilegedSocketPaths.some(path=>!absolute(path)||path==='/'||/[\x00-\x1f\x7f*?\[\]{}]/.test(path)))fail('inventory_incomplete');
    const {fingerprint,...data}=raw;if(sha(JSON.stringify(data))!==fingerprint||!same(raw.guest,guest))fail('inventory_incomplete');
    const time=Date.parse(raw.collectedAt);if(!Number.isFinite(time)||now-time>3600000||now<time||new Date(time).toISOString()!==raw.collectedAt)fail('inventory_incomplete');
    const exclusions=[];
    for(const entry of raw.exclusions){if(!exact(entry,['family','cidr','categories'])||![4,6].includes(entry.family)||!Array.isArray(entry.categories)||!entry.categories.length||entry.categories.length>7||new Set(entry.categories).size!==entry.categories.length||!entry.categories.every(category=>['guest','gateway','resolver','host','lan','vpn','translator'].includes(category))||INTERNET.has(entry.cidr))fail('inventory_incomplete');exclusions.push(canonicalCidr(entry.cidr,entry.family));}
    if(new Set(exclusions).size!==exclusions.length)fail('inventory_incomplete');
    for(const route of raw.routes){if(!exact(route,['family','cidr','classification'])||![4,6].includes(route.family)||!['internet','enterprise','private','local'].includes(route.classification))fail('inventory_incomplete');canonicalCidr(route.cidr,route.family);if(INTERNET.has(route.cidr)?route.classification!=='internet':route.classification==='internet'||!exclusions.includes(route.cidr))fail('inventory_incomplete');}
    if(!exact(guest,['addresses','routes','resolvers','hostAliases'])||!Object.values(guest).every(value=>Array.isArray(value)&&value.length<=256))fail('inventory_incomplete');
    const requireAddress=(address,category)=>{const family=isIP(address);if(!family||!raw.exclusions.some(entry=>entry.categories.includes(category)&&entry.cidr===`${address}/${family===4?32:128}`))fail('inventory_incomplete');};
    for(const address of guest.addresses){if(!exact(address,['family','address'])||![4,6].includes(address.family))fail('inventory_incomplete');canonicalCidr(address.address,address.family);if(!exclusions.includes(address.address))fail('inventory_incomplete');}
    for(const route of guest.routes){if(!exact(route,['family','destination','gateway'])||![4,6].includes(route.family))fail('inventory_incomplete');canonicalCidr(route.destination,route.family);if(!raw.routes.some(entry=>entry.family===route.family&&entry.cidr===route.destination))fail('inventory_incomplete');if(route.gateway)requireAddress(route.gateway,'gateway');}
    for(const address of guest.resolvers)requireAddress(address,'resolver');for(const address of guest.hostAliases)requireAddress(address,'host');
    if(!exact(raw.host,['addresses','routes','resolvers'])||!Object.values(raw.host).every(value=>Array.isArray(value)&&value.length<=256)||!exact(raw.lima,['hostAddresses','gatewayAddresses'])||!Object.values(raw.lima).every(value=>Array.isArray(value)&&value.length<=256)||!raw.lima.hostAddresses.length||!raw.lima.gatewayAddresses.length)fail('inventory_incomplete');
    for(const address of raw.host.addresses)requireAddress(address,'host');for(const address of raw.host.resolvers)requireAddress(address,'resolver');
    for(const address of raw.lima.hostAddresses)requireAddress(address,'host');for(const address of raw.lima.gatewayAddresses)requireAddress(address,'gateway');
    for(const route of raw.host.routes){if(!exact(route,['family','destination','gateway'])||![4,6].includes(route.family))fail('inventory_incomplete');canonicalCidr(route.destination,route.family);if(!raw.routes.some(entry=>entry.family===route.family&&entry.cidr===route.destination))fail('inventory_incomplete');if(route.gateway)requireAddress(route.gateway,'gateway');}
    for(const prefix of raw.translatorPrefixes){canonicalCidr(prefix,6);if(!raw.exclusions.some(entry=>entry.categories.includes('translator')&&entry.cidr===prefix))fail('inventory_incomplete');}
    const ipv6UpstreamDisabled=raw.translator!=='complete';if(raw.translator==='complete'&&!raw.translatorPrefixes.length)fail('inventory_incomplete');
    for(const prefix of policy.deniedCidrs)canonicalCidr(prefix,isIP(prefix.split('/')[0]));
    const deniedCidrs=[...new Set([...policy.deniedCidrs,...exclusions,...(ipv6UpstreamDisabled?['::/0']:[])])];if(deniedCidrs.length>128)fail('inventory_incomplete');
    return {deniedCidrs,ipv6UpstreamDisabled,fingerprint,coverage:[...SOURCE_KINDS],extraPrivilegedSocketPaths:[...raw.extraPrivilegedSocketPaths]};
  } catch {fail('inventory_incomplete');}
}

function command(deps,path,args,input,reason='dependency',allowMissing=false) {
  const result=deps.run(path,args,input);
  if(!result||result.error||result.signal||!Number.isInteger(result.status)||(result.status!==0&&!(allowMissing&&result.status===1))||typeof result.stdout!=='string'||Buffer.byteLength(result.stdout)>1048576)fail(reason);
  return result;
}
export function productionDependencies() {
  return {io:fs,effectiveUid:()=>process.geteuid?.(),now:()=>Date.now(),run:(path,args,input)=>spawnSync(path,args,{input,encoding:'utf8',timeout:10000,maxBuffer:1048576,cwd:'/',env:ENV,stdio:[input===undefined?'ignore':'pipe','pipe','pipe']}),loadModules:async()=>({...await import('./policy.mjs'),...await import('./worker-enter.mjs'),...await import('./stage-lifetime.mjs')})};
}
function trustCode(deps) {
  for(const name of ['install-guest.mjs','probe-guest.mjs','policy.mjs','worker-enter.mjs','stage-lifetime.mjs'])trustedPath(join(HERE,name),{},deps.io);
}
export async function loadModules(deps) {trustCode(deps);return deps.loadModules();}
function dependencies(deps) {
  for(const path of ['/usr/local/bin/node',NODE,'/usr/bin/env','/usr/bin/dash','/usr/bin/setpriv','/usr/sbin/nft','/usr/bin/systemctl','/usr/bin/systemd-run','/usr/bin/sudo','/usr/sbin/visudo','/usr/sbin/useradd','/usr/sbin/groupadd','/usr/sbin/nologin','/usr/sbin/ip','/usr/bin/journalctl'])trustedExecutable(path,deps.io);
  if(deps.io.realpathSync('/usr/local/bin/node')!==NODE)fail('dependency');
  if(command(deps,'/usr/local/bin/node',['--no-addons','--version']).stdout.trim()!=='v24.22.2')fail('dependency');
  for(const [path,required] of [['/usr/bin/env',['--ignore-environment']],['/usr/bin/systemd-run',['--unit','--property','--wait','--pipe','--collect']],['/usr/sbin/useradd',['--uid','--gid','--no-user-group','--no-create-home','--home-dir','--shell','--password']],['/usr/sbin/groupadd',['--gid']]]){
    const help=command(deps,path,['--help']).stdout;for(const flag of required)if(!help.includes(flag))fail('dependency');
  }
  const flags=command(deps,'/usr/bin/setpriv',['--help']).stdout;for(const flag of ['--reuid','--regid','--clear-groups','--no-new-privs','--bounding-set','--inh-caps','--ambient-caps'])if(!flags.includes(flag))fail('dependency');
  const version=command(deps,'/usr/bin/systemctl',['--version']).stdout;if(!/^systemd 255\b/.test(version))fail('dependency');
  if(!/^nftables v1\.0\.9\b/.test(command(deps,'/usr/sbin/nft',['--version']).stdout))fail('dependency');
}
export function readAccounts(deps) {
  try {
    const passwd=trustedRead('/etc/passwd',deps.io),groups=trustedRead('/etc/group',deps.io),shadow=trustedRead('/etc/shadow',deps.io);
    const groupLines=groups.trim().split('\n').map(line=>line.split(':')),facts={},seen=new Set();
    for(const group of groupLines){if(group.length!==4||!safeName(group[0])||seen.has(group[0])||!/^\d+$/.test(group[2]))fail('account_conflict');seen.add(group[0]);}
    const shadows=new Map();for(const line of shadow.trim().split('\n')){const fields=line.split(':');if(fields.length!==9||shadows.has(fields[0]))fail('account_conflict');shadows.set(fields[0],fields[1]);}
    for(const line of passwd.trim().split('\n')){const fields=line.split(':');if(fields.length!==7||!safeName(fields[0])||Object.hasOwn(facts,fields[0])||!/^\d+$/.test(fields[2])||!/^\d+$/.test(fields[3]))fail('account_conflict');const primary=groupLines.filter(group=>Number(group[2])===Number(fields[3]));
      facts[fields[0]]={uid:Number(fields[2]),gid:Number(fields[3]),home:fields[5],groups:groupLines.filter(group=>group[3].split(',').includes(fields[0])&&Number(group[2])!==Number(fields[3])).map(group=>Number(group[2])),shell:fields[6],locked:/^[!*]/.test(shadows.get(fields[0])??''),primaryGroup:primary.length===1?primary[0][0]:null};
    }return {facts,groupIds:groupLines.map(group=>Number(group[2])),groupNames:groupLines.map(group=>group[0])};
  } catch {fail('account_conflict');}
}
const policyAccounts=facts=>Object.fromEntries(Object.entries(facts).map(([name,{uid,gid,home,groups}])=>[name,{uid,gid,home,groups}]));
export function observeGuest(deps) {
  try {
    const addresses=[];for(const item of JSON.parse(command(deps,'/usr/sbin/ip',['-j','address','show']).stdout))for(const info of item.addr_info??[]){if(!['inet','inet6'].includes(info.family)||info.scope==='host'||info.scope==='link')continue;const family=info.family==='inet'?4:6;addresses.push({family,address:`${info.local}/${family===4?32:128}`});}
    const routes=[];for(const [family,flag] of [[4,'-4'],[6,'-6']])for(const item of JSON.parse(command(deps,'/usr/sbin/ip',['-j',flag,'route','show','table','all']).stdout)){if(item.type&&item.type!=='unicast')continue;if(typeof item.dst!=='string'&&item.dst!==undefined)fail('inventory_incomplete');routes.push({family,destination:item.dst==='default'||item.dst===undefined?(family===4?'0.0.0.0/0':'::/0'):item.dst,gateway:item.gateway??''});}
    trustedExecutable('/etc/resolv.conf',deps.io,false);
    const resolvers=trustedRead(deps.io.realpathSync('/etc/resolv.conf'),deps.io).split('\n').map(line=>line.replace(/#.*/,'').trim()).filter(line=>/^nameserver\s/.test(line)).map(line=>line.split(/\s+/)[1]);
    const hostAliases=trustedRead('/etc/hosts',deps.io).split('\n').map(line=>line.replace(/#.*/,'').trim()).filter(Boolean).map(line=>line.split(/\s+/)[0]).filter(address=>address!=='127.0.0.1'&&address!=='::1');
    const order=(a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b));return {addresses:addresses.sort(order),routes:routes.sort(order),resolvers:[...new Set(resolvers)].sort(),hostAliases:[...new Set(hostAliases)].sort()};
  } catch {fail('inventory_incomplete');}
}
function originalHomeAliases(home,rows){const candidates=rows.filter(row=>home===row.point||home.startsWith(row.point==='/'?'/':row.point+'/')).sort((a,b)=>b.point.length-a.point.length),base=candidates[0];if(!base)fail('active_worker');const source=base.root.replace(/\/$/,'')+home.slice(base.point==='/'?0:base.point.length);return rows.some(row=>row!==base&&row.device===base.device&&(source===row.root||source.startsWith(row.root==='/'?'/':row.root+'/'))&&row.point.replace(/\/$/,'')+source.slice(row.root==='/'?0:row.root.length)!==home);}
function drain(deps,facts,names,modules,classification) {
  if(classification?.kind!=='pristine'){try{if(!modules.registryQuiescent(deps.io,classification?.registry))fail('active_worker');}catch{fail('active_worker');}}
  if(exists('/var/lib/patrick-workspaces',deps.io)){trustedPath('/var/lib/patrick-workspaces',{kind:'directory'},deps.io);if(deps.io.readdirSync('/var/lib/patrick-workspaces').length)fail('active_worker');}
  const mounts=deps.io.readFileSync('/proc/self/mountinfo','utf8');if(Buffer.byteLength(mounts)>1048576)fail('active_worker');
  const rows=mounts.trim().split('\n').map(line=>{const halves=line.split(' - '),fields=halves[0].split(' ');if(halves.length!==2||fields.length<6||/[\\\n\r]/.test(fields[3]+fields[4]))fail('active_worker');return {device:fields[2],root:fields[3],point:fields[4],type:halves[1].split(' ')[0]};});
  if(rows.some(row=>['virtiofs','9p'].includes(row.type)||row.point==='/var/lib/patrick-workspaces'||row.point.startsWith('/var/lib/patrick-workspaces/')||names.some(name=>row.point==='/var/lib/'+name||row.point.startsWith('/var/lib/'+name+'/')))||names.some(name=>originalHomeAliases('/var/lib/'+name,rows)))fail('active_worker');
  const units=command(deps,'/usr/bin/systemctl',['list-units','--all','--no-pager','--no-legend','--plain','patrick-worker-*.service'],undefined,'active_worker').stdout.trim().split('\n').filter(Boolean);
  if(units.length>256||units.some(line=>!['patrick-worker-firewall.service','patrick-worker-proxy.service'].includes(line.trim().split(/\s+/)[0])))fail('active_worker');
  const uids=new Set(names.flatMap(name=>facts[name]?[facts[name].uid]:[]));
  try {for(const pid of deps.io.readdirSync('/proc').filter(name=>/^\d+$/.test(name))){let status;try{status=deps.io.readFileSync(`/proc/${pid}/status`,'utf8');}catch(error){if(error.code==='ENOENT')continue;throw error;}const line=status.split('\n').find(line=>line.startsWith('Uid:'));if(!line)fail('active_worker');const ids=line.slice(4).trim().split(/\s+/).map(Number);if(ids.some(uid=>uids.has(uid)))fail('active_worker');}}catch{fail('active_worker');}
}
function inspectHomes(deps,facts,names,missing,admin) {
  for(const name of names){const home=`/var/lib/${name}`;if(missing.includes(name)){if(exists(home,deps.io))fail('account_conflict');trustedPath('/var/lib',{kind:'directory'},deps.io);}else {trustedPath(home,{kind:'directory',uid:facts[name].uid,gid:facts[name].gid,mode:0o700},deps.io);if(exists(`${home}/.ssh`,deps.io))fail('account_conflict');}}
}
const ADMIN_SOCKETS=Object.freeze(['/run/systemd/private','/run/docker.sock','/run/containerd/containerd.sock','/run/podman/podman.sock','/run/libvirt/libvirt-sock','/run/libvirt/libvirt-admin-sock','/run/lima-guestagent.sock']);
// Fixed post-drop program. Only validated numeric identities and the finite
// trusted baseline/inventory path list follow it; there is no probe-path CLI.
const SOCKET_ACCESS_PROGRAM=`const fs=require('node:fs');
try {
  const uid=Number(process.argv[1]),gid=Number(process.argv[2]),paths=JSON.parse(process.argv[3]);
  if(!Number.isSafeInteger(uid)||uid<1000||!Number.isSafeInteger(gid)||gid<1000||process.getuid()!==uid||process.geteuid()!==uid||process.getgid()!==gid||process.getegid()!==gid||process.getgroups().length||!Array.isArray(paths)||!paths.length||paths.length>128)throw 0;
  const status=fs.readFileSync('/proc/self/status','utf8');
  for(const key of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']){const rows=status.split('\\n').filter(line=>line.startsWith(key+':'));if(rows.length!==1||!/^0{1,32}$/.test(rows[0].slice(key.length+1).trim()))throw 0;}
  const nnp=status.split('\\n').filter(line=>line.startsWith('NoNewPrivs:'));if(nnp.length!==1||nnp[0].slice(11).trim()!=='1')throw 0;
  let accessible=false;for(const path of paths){if(typeof path!=='string'||!path.startsWith('/')||path.length>4096||path.includes('\\0'))throw 0;try{fs.accessSync(path,fs.constants.W_OK);accessible=true;}catch(error){if(!['EACCES','EPERM','ENOENT','ENOTDIR'].includes(error.code))throw 0;}}
  process.stdout.write(accessible?'accessible\\n':'denied\\n');
}catch{process.stdout.write('unknown\\n');process.exitCode=78;}`;
function auditSockets(deps,facts,names,admin,inventory) {
  const runtime=`/run/user/${facts[admin].uid}`;
  const paths=[...new Set([...ADMIN_SOCKETS,`${runtime}/bus`,`${runtime}/gnupg/S.gpg-agent`,`${runtime}/gnupg/S.gpg-agent.extra`,`${runtime}/gnupg/S.gpg-agent.ssh`,`${runtime}/gnupg/S.gpg-agent.browser`,`${runtime}/keyring/control`,`${runtime}/keyring/ssh`,...inventory.extraPrivilegedSocketPaths])];
  for(const name of names){const account=facts[name];if(!account)continue;
    const args=[`--reuid=${account.uid}`,`--regid=${account.gid}`,'--clear-groups','--no-new-privs','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--','/usr/bin/env','-i','PATH=/usr/local/bin:/usr/bin:/bin','LANG=C','/usr/local/bin/node','--no-addons','-e',SOCKET_ACCESS_PROGRAM,String(account.uid),String(account.gid),JSON.stringify(paths)];
    const result=deps.run('/usr/bin/setpriv',args);if(!result||result.error||result.signal||result.status!==0||result.stdout!=='denied\n'||result.stderr!=='')fail('dependency');
  }
}

function auditSudo(deps,names) {
  const raw=trustedRead('/proc/sys/kernel/hostname',deps.io),hostname=raw.endsWith('\n')?raw.slice(0,-1):raw;if(!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(hostname))fail('dependency');
  for(const name of names){if(!safeName(name))fail('account_conflict');const result=deps.run('/usr/bin/sudo',['-n','-l','-U',name]),denial=`User ${name} is not allowed to run sudo on ${hostname}.`;
    // Observed guest sudo returns EXIT 0 even for denial. Only this exact C
    // locale denial is accepted; successful exit alone proves no restriction.
    if(!result||result.error||result.signal||result.status!==0||(result.stdout!==denial&&result.stdout!==denial+'\n')||result.stderr!=='')fail('account_conflict');
  }
}
function atomicWrite(deps,path,data,mode=0o644,uid=0,gid=0) {
  const parent=dirname(path);trustedPath(parent,{kind:'directory'},deps.io);
  if(exists(path,deps.io))trustedPath(path,{mode},deps.io);
  const temporary=`${path}.tmp-${randomBytes(12).toString('hex')}`;let fd;
  try {fd=deps.io.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,mode);deps.io.writeFileSync(fd,data);deps.io.chownSync(temporary,uid,gid);deps.io.chmodSync(temporary,mode);deps.io.fsyncSync(fd);deps.io.closeSync(fd);fd=undefined;deps.io.renameSync(temporary,path);const directory=deps.io.openSync(parent,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{deps.io.fsyncSync(directory);}finally{deps.io.closeSync(directory);}}finally{if(fd!==undefined)deps.io.closeSync(fd);if(exists(temporary,deps.io))deps.io.unlinkSync(temporary);}
}
function ensureDirectory(deps,path,mode=0o755) {if(!exists(path,deps.io))deps.io.mkdirSync(path,{mode});trustedPath(path,{kind:'directory',mode},deps.io);}
function syncDirectory(deps,path){const fd=deps.io.openSync(path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{deps.io.fsyncSync(fd);}finally{deps.io.closeSync(fd);}}
const nodeOf=stat=>({dev:stat.dev,ino:stat.ino});
const sameNode=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
function registryMetadata(deps,path){
  trustedPath(path,{gid:0,mode:0o600},deps.io);const before=deps.io.lstatSync(path),fd=deps.io.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const valid=st=>{if(!st.isFile()||st.isSymbolicLink()||st.uid!==0||st.gid!==0||(st.mode&0o7777)!==0o600||st.nlink!==1||!Number.isSafeInteger(st.size)||st.size<0||st.size>4096)fail('installed_mismatch');};
  try{const opened=deps.io.fstatSync(fd);valid(before);valid(opened);if(!sameNode(before,opened))fail('installed_mismatch');const buffer=Buffer.alloc(4097);let size=0;while(size<buffer.length){const count=deps.io.readSync(fd,buffer,size,buffer.length-size,null);if(!Number.isSafeInteger(count)||count<0||count>buffer.length-size)fail('installed_mismatch');if(!count)break;size+=count;}const after=deps.io.fstatSync(fd),current=deps.io.lstatSync(path);valid(after);valid(current);if(size>4096||!sameNode(opened,after)||!sameNode(opened,current))fail('installed_mismatch');const bytes=buffer.subarray(0,size);if(!isUtf8(bytes))fail('installed_mismatch');const value=JSON.parse(bytes.toString());if(!bytes.equals(deps.registryModules.encodeRegistryMetadata(value)))fail('installed_mismatch');return {value,bytes,stat:after};}finally{deps.io.closeSync(fd);}
}
// This fixed-schema publisher is private to first installation. No helper may
// initialize or repair missing identity, even when all runtime files vanished.
function publishRegistryMetadata(deps,path,value,previous){
  const bytes=deps.registryModules.encodeRegistryMetadata(value),io=deps.io,parent=dirname(path),temporary=parent+'/.write-'+value.authorityId+'-'+randomBytes(16).toString('hex')+'.tmp';let fd,owned,published=false;
  const ownedFile=(p,links=1)=>{const st=io.lstatSync(p);if(!owned||!sameNode(st,owned)||!st.isFile()||st.isSymbolicLink()||st.uid!==0||st.gid!==0||(st.mode&0o7777)!==0o600||st.nlink!==links)fail('installed_mismatch');};
  try{fd=io.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);const st=io.fstatSync(fd);if(!st.isFile()||st.uid!==0||st.gid!==0||st.nlink!==1)fail('installed_mismatch');owned=nodeOf(st);io.fchmodSync(fd,0o600);ownedFile(temporary);io.writeFileSync(fd,bytes);io.fsyncSync(fd);const closing=fd;fd=undefined;io.closeSync(closing);ownedFile(temporary);
    if(previous){const current=registryMetadata(deps,path);if(!sameNode(current.stat,previous.stat)||!current.bytes.equals(previous.bytes)||current.value.authorityId!==value.authorityId)fail('installed_mismatch');io.renameSync(temporary,path);published=true;syncDirectory(deps,parent);}
    else{io.linkSync(temporary,path);published=true;syncDirectory(deps,parent);ownedFile(temporary,2);if(!sameNode(io.lstatSync(path),owned))fail('installed_mismatch');io.unlinkSync(temporary);syncDirectory(deps,parent);}
  }catch(error){if(fd!==undefined){try{io.closeSync(fd);}catch{}}if(owned&&!published){try{published=sameNode(io.lstatSync(path),owned);}catch{}}if(owned&&!published){try{ownedFile(temporary);io.unlinkSync(temporary);}catch{}}throw error;}
}
function validateRuntime(deps,ownedLock){
  if(!exists(RUNTIME,deps.io))return;trustedPath(RUNTIME,{kind:'directory',gid:0,mode:0o700},deps.io);if((deps.io.lstatSync(RUNTIME).mode&0o7777)!==0o700)fail('installed_mismatch');
  for(const name of deps.io.readdirSync(RUNTIME)){
    if(name==='invocations'){const path=RUNTIME+'/'+name;trustedPath(path,{kind:'directory',gid:0,mode:0o700},deps.io);if((deps.io.lstatSync(path).mode&0o7777)!==0o700||deps.io.readdirSync(path).length)fail('installed_mismatch');}
    else if(name==='install.lock'&&ownedLock){const path=RUNTIME+'/'+name;trustedPath(path,{kind:'directory',gid:0,mode:0o700},deps.io);trustedPath(path+'/owner.json',{gid:0,mode:0o600},deps.io);const st=deps.io.lstatSync(path+'/owner.json');if((deps.io.lstatSync(path).mode&0o7777)!==0o700||st.nlink!==1||(st.mode&0o7777)!==0o600||!same(deps.io.readdirSync(path),['owner.json'])||trustedRead(path+'/owner.json',deps.io)!==JSON.stringify(ownedLock)+'\n')fail('installed_mismatch');}
    else fail('installed_mismatch');
  }
}
function classifyInstallRegistry(deps,target,ownedLock){
  try{
    validateRuntime(deps,ownedLock);const manifest=installedManifest(deps);
    if(manifest){const authority=deps.registryModules.readRegistryAuthority(deps.io,manifest.installation.registry);return {kind:'existing',registry:referenceOf(authority)};}
    const ownedPaths=[CODE,'/usr/local/libexec/patrick-worker-enter','/usr/local/libexec/patrick-worker-probe','/etc/systemd/system/patrick-worker-firewall.service','/etc/systemd/system/patrick-worker-proxy.service','/etc/systemd/system/patrick-worker-firewall.service.d','/etc/systemd/system/patrick-worker-proxy.service.d','/etc/sudoers.d/patrick-worker',CONFIG+'/policy.json',CONFIG+'/firewall.nft',CONFIG+'/route-inventory.json'];
    if(ownedPaths.some(path=>exists(path,deps.io))||currentNft(deps))fail('installed_mismatch');
    if(exists(CONFIG,deps.io)){trustedPath(CONFIG,{kind:'directory'},deps.io);if(deps.io.readdirSync(CONFIG).some(name=>!['registry-identity.json','install-state.json'].includes(name)))fail('installed_mismatch');}
    const witness=exists(WITNESS,deps.io),durable=exists(DURABLE,deps.io),fence=exists(CONFIG+'/install-state.json',deps.io);
    if(!witness&&!durable&&!fence)return {kind:'pristine'};
    if(!witness||!durable||!fence)fail('installed_mismatch');
    const authority=deps.registryModules.readRegistryAuthority(deps.io),ready=registryMetadata(deps,WITNESS).value,state=readInstallState(deps,target.artifactHash,target.policyHash);
    if(ready.phase!=='ready'||ready.initializedBy.artifactHash!==target.artifactHash||ready.initializedBy.policyHash!==target.policyHash||!['applying','failed'].includes(state.status))fail('installed_mismatch');
    return {kind:'first-apply-retry',registry:referenceOf(authority)};
  }catch{fail('installed_mismatch');}
}
function preparePristineInstallRuntime(deps,target){
  if(deps.effectiveUid()!==0)fail('not_root');if(classifyInstallRegistry(deps,target).kind!=='pristine')fail('installed_mismatch');
  trustedPath('/run',{kind:'directory'},deps.io);if(!exists(RUNTIME,deps.io)){deps.io.mkdirSync(RUNTIME,{mode:0o700});syncDirectory(deps,'/run');}validateRuntime(deps);
}
function acquireInstallerMutex(deps,target){
  try{deps.io.mkdirSync(RUNTIME+'/install.lock',{mode:0o700});}catch{fail('active_worker');}
  try{const owner={version:1,kind:'installer',...processWitness(deps),artifactHash:target.artifactHash,policyHash:target.policyHash};atomicWrite(deps,RUNTIME+'/install.lock/owner.json',JSON.stringify(owner)+'\n',0o600);syncDirectory(deps,RUNTIME);return owner;}catch{throw Object.assign(new Error('service_state'),{reason:'service_state',retainInstallLock:true});}
}
function initializeRegistry(deps,target,boot){
  const initial={version:1,phase:'initializing',authorityId:randomBytes(16).toString('hex'),initializedBy:{...target,boot},root:null,records:null,marker:null};
  publishRegistryMetadata(deps,WITNESS,initial);const previous=registryMetadata(deps,WITNESS);
  for(const [path,parent]of [[DURABLE,'/var/lib'],[REGISTRY,DURABLE]]){trustedPath(parent,{kind:'directory'},deps.io);deps.io.mkdirSync(path,{mode:0o700});trustedPath(path,{kind:'directory',gid:0,mode:0o700},deps.io);syncDirectory(deps,parent);}
  const root=nodeOf(deps.io.lstatSync(DURABLE)),records=nodeOf(deps.io.lstatSync(REGISTRY)),marker={version:1,authorityId:initial.authorityId,root,records};publishRegistryMetadata(deps,MARKER,marker);
  const markerFile=registryMetadata(deps,MARKER),ready={...initial,phase:'ready',root,records,marker:{...nodeOf(markerFile.stat),hash:sha(markerFile.bytes)}};publishRegistryMetadata(deps,WITNESS,ready,previous);
  return referenceOf(deps.registryModules.readRegistryAuthority(deps.io));
}
function expectedProxy(policy,accounts) {const account=accounts[policy.proxyUser];return {user:policy.proxyUser,...account,mainPid:2,activeState:'active',subState:'running',listeners:policy.workers.map(worker=>({address:'127.0.0.1',port:worker.proxyPort,uid:account.uid,pid:2}))};}
export function assertNftOnly(modules,nft,policy,accounts) {
  // Unit1's exact nft grammar is bundled with its listener validator. This
  // internal expected proxy shape checks only the nft half and NEVER attests
  // actual proxy readiness or authorizes a worker.
  try {modules.assertReadiness(nft,expectedProxy(policy,accounts),policy,accounts);}catch{fail('installed_mismatch');}
}
function currentNft(deps) {
  const table=command(deps,'/usr/sbin/nft',['-j','list','tables']).stdout;let tables;try{tables=JSON.parse(table);}catch{fail('installed_mismatch');}
  if(!tables||!Array.isArray(tables.nftables))fail('installed_mismatch');
  const found=tables.nftables.filter(item=>item.table?.family==='inet'&&item.table?.name==='patrick_worker');if(found.length>1)fail('installed_mismatch');
  if(!found.length)return null;try{return JSON.parse(command(deps,'/usr/sbin/nft',['-j','list','table','inet','patrick_worker']).stdout);}catch{fail('installed_mismatch');}
}
function assertUnits(deps,contents,allowAbsent=false) {
  for(const name of ['patrick-worker-firewall.service','patrick-worker-proxy.service']){
    const path=`/etc/systemd/system/${name}`,dropIn=`${path}.d`;
    if(exists(dropIn,deps.io))fail('service_state');
    const facts=command(deps,'/usr/bin/systemctl',['show',name,'--no-pager','--property=FragmentPath,DropInPaths,LoadState']).stdout;
    const fields=properties(facts);
    if(!exact(fields,['FragmentPath','DropInPaths','LoadState'])||fields.DropInPaths||!(fields.LoadState==='loaded'&&fields.FragmentPath===path||allowAbsent&&fields.LoadState==='not-found'&&fields.FragmentPath===''))fail('service_state');
    if(exists(path,deps.io)&&trustedRead(path,deps.io)!==contents[name])fail('service_state');
  }
}
export function proxyFacts(deps,modules) {
  try {
    const properties=modules.parseServiceProperties(command(deps,'/usr/bin/systemctl',['show','patrick-worker-proxy.service','--no-pager','--property=User,Group,MainPID,ActiveState,SubState,FragmentPath,DropInPaths']).stdout);
    if(properties.FragmentPath!=='/etc/systemd/system/patrick-worker-proxy.service')fail('service_state');trustedPath(properties.FragmentPath,{},deps.io);
    const pid=Number(properties.MainPID),sockets=deps.io.readdirSync(`/proc/${pid}/fd`).flatMap(fd=>{try{const link=deps.io.readlinkSync(`/proc/${pid}/fd/${fd}`);return /^socket:\[\d+\]$/.test(link)?[link.slice(8,-1)]:[];}catch{return [];}});
    return modules.parseProxyFacts(properties,deps.io.readFileSync(`/proc/${pid}/status`,'utf8'),deps.io.readFileSync(`/proc/${pid}/net/tcp`,'utf8'),deps.io.readFileSync(`/proc/${pid}/net/tcp6`,'utf8'),sockets);
  } catch {fail('service_state');}
}
function checkLimits(deps) {
  const raw=command(deps,'/usr/bin/systemctl',['show','patrick-worker-proxy.service','--no-pager','--property=NoNewPrivileges,CapabilityBoundingSet,AmbientCapabilities,LimitNOFILE,TasksMax,MemoryMax,PrivateNetwork']).stdout;
  const fields=properties(raw);
  if(!same(fields,{NoNewPrivileges:'yes',CapabilityBoundingSet:'',AmbientCapabilities:'',LimitNOFILE:'256',TasksMax:'32',MemoryMax:'268435456',PrivateNetwork:'no'}))fail('service_state');
}
function installedManifest(deps) {if(!exists(`${CONFIG}/manifest.json`,deps.io))return null;try {const raw=JSON.parse(trustedRead(`${CONFIG}/manifest.json`,deps.io));if(!exact(raw,['version','controlAdmin','reviewedSources','policyHash','files','installation'])||raw.version!==1||!safeName(raw.controlAdmin)||raw.controlAdmin==='root'||raw.controlAdmin.startsWith('patrick-')||!same(raw.reviewedSources,SOURCES)||!digest(raw.policyHash)||!exact(raw.files,ARTIFACTS)||!Object.values(raw.files).every(digest)||!exact(raw.installation,['artifactHash','policyHash','accounts','nftHash','registry'])||!digest(raw.installation.artifactHash)||!digest(raw.installation.policyHash)||!digest(raw.installation.nftHash)||!registryReference(raw.installation.registry)||!raw.installation.accounts||typeof raw.installation.accounts!=='object'||Array.isArray(raw.installation.accounts)||Object.values(raw.installation.accounts).some(a=>!exact(a,['uid','gid','home','groups'])||!numeric(a.uid)||!numeric(a.gid)||typeof a.home!=='string'||!Array.isArray(a.groups)||a.groups.length))fail('installed_mismatch');const {installation,...staged}=raw;if(sha(canonical(staged))!==installation.artifactHash)fail('installed_mismatch');return raw;}catch{fail('installed_mismatch');}}
function properties(text) {
  const fields={};for(const line of text.trim().split('\n')){const at=line.indexOf('=');if(at<=0||Object.hasOwn(fields,line.slice(0,at)))fail('service_state');fields[line.slice(0,at)]=line.slice(at+1);}return fields;
}
function processWitness(deps,pid=deps.installerPid??process.pid) {
  if(!Number.isSafeInteger(pid)||pid<2||pid>2147483647)fail('service_state');
  const bootId=deps.io.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),stat=deps.io.readFileSync(`/proc/${pid}/stat`,'utf8');
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId)||!stat.startsWith(pid+' (')||stat.length>65536)fail('service_state');
  const tail=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/),startTime=tail[19];if(!/^[1-9]\d{0,19}$/.test(startTime??''))fail('service_state');
  return {pid,startTime,bootId};
}
export function readInstallState(deps,artifactHash,policyHash) {
  try {
    const path=`${CONFIG}/install-state.json`;
    trustedPath(path,{mode:0o600},deps.io);
    const state=JSON.parse(trustedRead(path,deps.io));
    if(!exact(state,['version','status','artifactHash','policyHash','installer'])||
      state.version!==1||!['applying','failed','ready'].includes(state.status)||
      !digest(state.artifactHash)||!digest(state.policyHash)||
      state.artifactHash!==artifactHash||state.policyHash!==policyHash||
      !exact(state.installer,['pid','startTime','bootId'])||
      !Number.isSafeInteger(state.installer.pid)||state.installer.pid<2||state.installer.pid>2147483647||
      !/^[1-9]\d{0,19}$/.test(state.installer.startTime)||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(state.installer.bootId))fail('installed_mismatch');
    return state;
  } catch {fail('installed_mismatch');}
}
export function liveInstaller(deps,state,manifest) {
  try {
    trustedPath('/run/patrick-worker/install.lock',{kind:'directory',mode:0o700},deps.io);
    trustedPath('/run/patrick-worker/install.lock/owner.json',{mode:0o600},deps.io);
    const owner=JSON.parse(trustedRead('/run/patrick-worker/install.lock/owner.json',deps.io));if(!same(owner,{version:1,kind:'installer',...state.installer,artifactHash:state.artifactHash,policyHash:state.policyHash}))return false;
    if(!same(processWitness(deps,state.installer.pid),state.installer))return false;
    const status=deps.io.readFileSync(`/proc/${state.installer.pid}/status`,'utf8'),uids=status.split('\n').filter(line=>line.startsWith('Uid:'));if(uids.length!==1||!/^Uid:\s+0\s+0\s+0\s+0\s*$/.test(uids[0]))return false;
    const exe=deps.io.readlinkSync(`/proc/${state.installer.pid}/exe`,{encoding:'buffer'});if(!Buffer.isBuffer(exe)||!isUtf8(exe)||exe.toString('utf8')!==NODE)return false;
    const raw=deps.io.readFileSync(`/proc/${state.installer.pid}/cmdline`);if(!Buffer.isBuffer(raw)||raw.length>16384||!isUtf8(raw)||raw.at(-1)!==0)return false;const argv=raw.toString('utf8').slice(0,-1).split('\0');
    if(argv[0]!=='/usr/local/bin/node'||argv[1]!=='--no-addons'||!absolute(argv[2])||sha(trustedRead(argv[2],deps.io))!==manifest.files['install-guest.mjs'])return false;
    const input=parseInstallArguments(argv.slice(3));if(!input.apply)return false;const artifacts=inspectArtifacts(input.artifactDir,deps.io);
    return artifacts.artifactHash===state.artifactHash&&sha(trustedRead(input.policyPath,deps.io))===artifacts.manifest.policyHash;
  }catch{return false;}
}
function renderSudo(template,admin) {if(template.split('@CONTROL_ADMIN@').length!==9)fail('untrusted_artifact');return template.replaceAll('@CONTROL_ADMIN@',admin);}
function stopProxy(deps) {
  command(deps,'/usr/bin/systemctl',['stop','patrick-worker-proxy.service'],undefined,'service_state');
  const text=command(deps,'/usr/bin/systemctl',['show','patrick-worker-proxy.service','--no-pager','--property=ActiveState,SubState,MainPID']).stdout;
  const fields=properties(text);
  if(!same(fields,{ActiveState:'inactive',SubState:'dead',MainPID:'0'}))fail('service_state');
}
async function inspect(input,deps,modules,ownedLock) {
  dependencies(deps);
  const artifacts=inspectArtifacts(input.artifactDir,deps.io),policyText=trustedRead(input.policyPath,deps.io);
  if(sha(policyText)!==artifacts.manifest.policyHash)fail('untrusted_artifact');
  let policy;
  try {
    policy=modules.parsePolicy(JSON.parse(policyText));
    if(policy.workers.some(worker=>worker.proxyPort!==({grok:18743,codex:18744,dsh:18745})[worker.runner]))fail('policy_invalid');
  } catch {fail('policy_invalid');}
  const accountData=readAccounts(deps),plan=planAccounts(policy,accountData.facts,artifacts.manifest.controlAdmin);
  if(plan.missing.some(name=>accountData.groupNames.includes(name)))fail('account_conflict');
  inspectHomes(deps,accountData.facts,plan.names,plan.missing,artifacts.manifest.controlAdmin);
  auditSudo(deps,plan.names.filter(name=>!plan.missing.includes(name)));
  const inventory=validateInventory(JSON.parse(artifacts.contents['route-inventory.json']),policy,observeGuest(deps),deps.now());
  auditSockets(deps,accountData.facts,plan.names,artifacts.manifest.controlAdmin,inventory);
  policy=modules.parsePolicy({...policy,deniedCidrs:inventory.deniedCidrs});
  const policyOutput=JSON.stringify(policy)+'\n',target={artifactHash:artifacts.artifactHash,policyHash:sha(policyOutput)},classification=classifyInstallRegistry(deps,target,ownedLock);
  drain(deps,accountData.facts,plan.names.filter(name=>name!==policy.proxyUser),modules,classification);
  const accounts=policyAccounts(accountData.facts),previous=installedManifest(deps),nft=currentNft(deps);
  // Previous bytes establish ownership only. Their inventory may be expired or
  // describe the old topology; neither can qualify the new target or readiness.
  if(previous){
    const owned=verifyInstalledGeneration(deps,modules,previous,true);
    if(nft)assertNftOnly(modules,nft,owned.policy,owned.accounts);
  } else {
    if(nft)fail('installed_mismatch');
    assertUnits(deps,artifacts.contents,true);
  }
  const sudoers=renderSudo(artifacts.contents['patrick-worker-sudoers'],artifacts.manifest.controlAdmin);
  command(deps,'/usr/sbin/visudo',['-c','-f','-'],sudoers,'dependency');
  return {artifacts,policy,inventory,accountData,plan,accounts,previous,nft,sudoers,policyText:policyOutput,target,classification};
}
function filesFor(state) {
  const files=new Map();for(const name of ARTIFACTS.filter(name=>name.endsWith('.mjs')))files.set(`${CODE}/${name}`,{text:state.artifacts.contents[name],mode:0o755});
  files.set('/usr/local/libexec/patrick-worker-enter',{text:LAUNCHER,mode:0o755});files.set('/usr/local/libexec/patrick-worker-probe',{text:state.artifacts.contents['patrick-worker-probe'],mode:0o755});
  files.set(`${CONFIG}/policy.json`,{text:state.policyText,mode:0o644});files.set(`${CONFIG}/route-inventory.json`,{text:state.artifacts.contents['route-inventory.json'],mode:0o600});
  for(const name of ['patrick-worker-firewall.service','patrick-worker-proxy.service'])files.set(`/etc/systemd/system/${name}`,{text:state.artifacts.contents[name],mode:0o644});
  files.set('/etc/sudoers.d/patrick-worker',{text:state.sudoers,mode:0o440});return files;
}
function deployment(state,modules,accounts=state.accounts,registry=state.classification.registry) {
  const nftText=modules.renderNft(state.policy,Object.fromEntries(state.plan.names.map(name=>[name,accounts[name].uid])));
  const manifest={...state.artifacts.manifest,installation:{artifactHash:state.artifacts.artifactHash,policyHash:sha(state.policyText),accounts:Object.fromEntries(state.plan.names.map(name=>[name,accounts[name]])),nftHash:sha(nftText),registry}};
  const files=filesFor(state);files.set(`${CONFIG}/firewall.nft`,{text:nftText,mode:0o644});files.set(`${CONFIG}/manifest.json`,{text:JSON.stringify(manifest)+'\n',mode:0o644});return {files,manifest,nftText};
}
async function assertInstalledLive(deps) {
  const state=await inspectInstalled(deps);if(state.fence.status!=='ready')fail('installed_mismatch');
  if(exists('/run/patrick-worker/install.lock',deps.io))fail('active_worker');
  state.drain();
  try{state.modules.assertReadiness(state.nft(),state.proxy(),state.policy,state.accounts);}catch{fail('service_state');}
}
function fileDrift(deps,files) {let count=0;for(const [path,file] of files){if(!exists(path,deps.io)){count++;continue;}trustedPath(path,{mode:file.mode},deps.io);if(trustedRead(path,deps.io)!==file.text)count++;}return count;}
function allocate(deps,state) {
  let {facts,groupIds,groupNames}=state.accountData;
  for(const name of state.plan.missing){if(groupNames.includes(name))fail('account_conflict');let id=1000;const used=new Set([...Object.values(facts).flatMap(account=>[account.uid,account.gid]),...groupIds]);while(used.has(id))id++;if(id>60000)fail('account_conflict');
    command(deps,'/usr/sbin/groupadd',['--gid',String(id),name],undefined,'account_conflict');
    command(deps,'/usr/sbin/useradd',['--uid',String(id),'--gid',String(id),'--no-user-group','--no-create-home','--home-dir',`/var/lib/${name}`,'--shell','/usr/sbin/nologin','--password','!',name],undefined,'account_conflict');
    const home=`/var/lib/${name}`;if(exists(home,deps.io))fail('account_conflict');deps.io.mkdirSync(home,{mode:0o700});deps.io.chownSync(home,id,id);deps.io.chmodSync(home,0o700);
    ({facts,groupIds,groupNames}=readAccounts(deps));planAccounts(state.policy,facts,state.artifacts.manifest.controlAdmin);
  }
  const current=readAccounts(deps);const plan=planAccounts(state.policy,current.facts,state.artifacts.manifest.controlAdmin);if(plan.missing.length)fail('account_conflict');inspectHomes(deps,current.facts,plan.names,[],state.artifacts.manifest.controlAdmin);auditSudo(deps,plan.names);auditSockets(deps,current.facts,plan.names,state.artifacts.manifest.controlAdmin,state.inventory);const accounts=policyAccounts(current.facts);return accounts;
}
export function firewallTransaction(deps,modules,policy,accounts,nftText,existing) {
  const text=(existing?'delete table inet patrick_worker\n':'')+nftText;
  const path=`${CONFIG}/firewall.transaction-${randomBytes(12).toString('hex')}.nft`;
  try {atomicWrite(deps,path,text,0o600);const before=trustedRead(path,deps.io);command(deps,'/usr/sbin/nft',['-c','-f',path],undefined,'nft_check');if(trustedRead(path,deps.io)!==before)fail('nft_check');command(deps,'/usr/sbin/nft',['-f',path],undefined,'nft_apply');assertNftOnly(modules,currentNft(deps),policy,accounts);}finally{if(exists(path,deps.io))deps.io.unlinkSync(path);}
}
export async function installGuest(input,dependenciesOverride) {
  let deps=dependenciesOverride??productionDependencies();let locked=false,proxyUnitPresent=false,retainLock=false,fence,owner,summary={version:1,mode:input?.apply?'apply':'check',outcome:'fail',reason:'arguments',policyHash:'',artifactHash:'',accountsToCreate:0,filesToReplace:0,ownedTableToReplace:false};
  try {
    if(!exact(input,['policyPath','artifactDir','apply'])||!absolute(input.policyPath)||!absolute(input.artifactDir)||typeof input.apply!=='boolean')fail('arguments');
    if(deps.effectiveUid()!==0)fail('not_root');
    const modules=await loadModules(deps);deps={...deps,registryModules:modules};let state=await inspect(input,deps,modules);
    if(exists('/run/patrick-worker/install.lock',deps.io))fail('active_worker');
    if(state.plan.missing.length&&(state.previous||exists(`${CONFIG}/firewall.nft`,deps.io)))fail('installed_mismatch');
    const files=state.plan.missing.length?filesFor(state):deployment(state,modules).files;
    summary={...summary,policyHash:sha(state.policyText),artifactHash:state.artifacts.artifactHash,accountsToCreate:state.plan.missing.length,filesToReplace:fileDrift(deps,files)+(state.plan.missing.length?2:0),ownedTableToReplace:!state.nft||fileDrift(deps,files)>0||state.plan.missing.length>0};
    if(!input.apply){if(state.previous)await assertInstalledLive(deps);summary.outcome='pass';summary.reason='ok';deps.summary?.(Object.freeze(summary));return Object.freeze({applied:false,policyHash:summary.policyHash});}
    if(state.previous&&state.nft&&summary.filesToReplace===0){let ready=false;try{await assertInstalledLive(deps);ready=true;}catch{}if(ready){summary.outcome='pass';summary.reason='ok';deps.summary?.(Object.freeze(summary));return Object.freeze({applied:true,policyHash:summary.policyHash});}}
    summary.ownedTableToReplace=true;
    // Initial inspection has established the existing unit's trusted ownership.
    // Remember it before lock-owner/fence writes and their durability failures.
    proxyUnitPresent=exists('/etc/systemd/system/patrick-worker-proxy.service',deps.io);
    const initialClass=state.classification;
    if(initialClass.kind==='pristine')preparePristineInstallRuntime(deps,state.target);else{const witness=processWitness(deps);modules.ensureRuntimeBase({io:deps.io,boot:()=>witness.bootId,witness:()=>({pid:witness.pid,start:witness.startTime})},initialClass.registry);}
    owner=acquireInstallerMutex(deps,state.target);locked=true;
    // The lock prevents concurrent installers. Worker admission remains denied
    // by exact live rules/listener checks until the complete apply succeeds.
    state=await inspect(input,deps,modules,owner);if(!same(initialClass,state.classification)||state.target.artifactHash!==owner.artifactHash||state.target.policyHash!==owner.policyHash)fail('installed_mismatch');
    // The two trusted directories/serialization lock are the only necessary
    // bootstrap mutations before the durable generation fence exists.
    ensureDirectory(deps,CONFIG);
    fence={version:1,status:'applying',artifactHash:state.artifacts.artifactHash,policyHash:sha(state.policyText),installer:processWitness(deps)};
    atomicWrite(deps,`${CONFIG}/install-state.json`,JSON.stringify(fence)+'\n',0o600);
    const registry=state.classification.kind==='pristine'?initializeRegistry(deps,state.target,fence.installer.bootId):state.classification.registry;
    if(proxyUnitPresent)stopProxy(deps);
    const accounts=allocate(deps,state);modules.validateAccounts(state.policy,accounts);drain(deps,accounts,state.plan.names.filter(name=>name!==state.policy.proxyUser),modules,{kind:'existing',registry});
    if(!same(observeGuest(deps),JSON.parse(state.artifacts.contents['route-inventory.json']).guest))fail('inventory_incomplete');
    ensureDirectory(deps,'/usr/local/libexec');ensureDirectory(deps,CONFIG);ensureDirectory(deps,'/var/lib/patrick-workspaces');
    const {nftText,manifest:installed,files:installedFiles}=deployment(state,modules,accounts,registry);
    // No service enable/start until the checked single owned-table transaction.
    firewallTransaction(deps,modules,state.policy,accounts,nftText,Boolean(state.nft));
    ensureDirectory(deps,CODE);
    for(const [path,file] of installedFiles){
      if(!exists(path,deps.io)||trustedRead(path,deps.io)!==file.text){
        if(path==='/etc/systemd/system/patrick-worker-proxy.service')proxyUnitPresent=true;
        atomicWrite(deps,path,file.text,file.mode);
      }
    }
    proxyUnitPresent=true;
    command(deps,'/usr/sbin/visudo',['-c','-f','/etc/sudoers.d/patrick-worker'],undefined,'dependency');
    auditSudo(deps,state.plan.names);
    auditSockets(deps,accounts,state.plan.names,state.artifacts.manifest.controlAdmin,state.inventory);
    command(deps,'/usr/bin/systemctl',['daemon-reload'],undefined,'service_state');
    command(deps,'/usr/bin/systemctl',['enable','patrick-worker-firewall.service','patrick-worker-proxy.service'],undefined,'service_state');
    command(deps,'/usr/bin/systemctl',['start','patrick-worker-firewall.service'],undefined,'service_state');
    command(deps,'/usr/bin/systemctl',['start','patrick-worker-proxy.service'],undefined,'service_state');
    assertUnits(deps,state.artifacts.contents);checkLimits(deps);modules.assertReadiness(currentNft(deps),proxyFacts(deps,modules),state.policy,accounts);
    const final=await inspectInstalled(deps);final.modules.assertReadiness(final.nft(),final.proxy(),final.policy,final.accounts);
    if(!liveInstaller(deps,fence,installed))fail('service_state');
    atomicWrite(deps,`${CONFIG}/install-state.json`,JSON.stringify({...fence,status:'ready'})+'\n',0o600);
    try{releaseInstallerLock(deps,owner);locked=false;}catch{retainLock=true;fail('service_state');}
    summary.outcome='pass';summary.reason='ok';deps.summary?.(Object.freeze(summary));return Object.freeze({applied:true,policyHash:summary.policyHash});
  } catch(error){
    if(error?.retainInstallLock){retainLock=true;locked=true;}
    if(fence){
      try {
        atomicWrite(deps,`${CONFIG}/install-state.json`,JSON.stringify({...fence,status:'failed'})+'\n',0o600);
      } catch {retainLock=true;}
    }
    if(locked&&proxyUnitPresent&&(fence||error?.retainInstallLock)){
      try {stopProxy(deps);}catch {retainLock=true;}
    }
    if(locked&&!retainLock){
      try {releaseInstallerLock(deps,owner);locked=false;}catch {retainLock=true;}
    }
    summary.reason=retainLock?'service_state':REASONS.has(error?.reason)?error.reason:'untrusted_artifact';
    deps.summary?.(Object.freeze(summary));
    throw Object.assign(new Error(summary.reason),{reason:summary.reason});
  }
}
function releaseInstallerLock(deps,owner) {
  const directory='/run/patrick-worker/install.lock';trustedPath(directory,{kind:'directory',mode:0o700},deps.io);
  if(owner){const path=directory+'/owner.json';trustedPath(path,{mode:0o600},deps.io);if(!same(deps.io.readdirSync(directory),['owner.json'])||!same(JSON.parse(trustedRead(path,deps.io)),owner))fail('service_state');deps.io.unlinkSync(path);}else if(deps.io.readdirSync(directory).length)fail('service_state');
  syncDirectory(deps,directory);deps.io.rmdirSync(directory);syncDirectory(deps,RUNTIME);
}

export async function withInstallationMutex(deps,operation) {
  if(deps.effectiveUid()!==0)fail('not_root');const state=await inspectRecordAuthority(deps),reference=state.manifest.installation.registry,witness=processWitness(deps);
  try{return await state.modules.withInstallMutex({io:deps.io,boot:()=>witness.bootId,witness:()=>({pid:witness.pid,start:witness.startTime})},reference,async()=>{const fresh=await inspectRecordAuthority(deps);if(!same(reference,fresh.manifest.installation.registry))fail('installed_mismatch');return operation();});}catch(error){if(REASONS.has(error?.reason))throw error;fail('service_state');}
}

/** @param {InstallDependencies} deps @returns {Promise<RecordAuthorityState>} */
export async function inspectRecordAuthority(deps=productionDependencies()){
  if(deps.effectiveUid()!==0)fail('not_root');const modules=await loadModules(deps),manifest=installedManifest(deps);if(!manifest)fail('installed_mismatch');return verifyRecordAuthority(deps,modules,manifest);
}
export async function inspectInstalled(deps=productionDependencies()) {
  if(deps.effectiveUid()!==0)fail('not_root');
  const modules=await loadModules(deps);
  dependencies(deps);
  const manifest=installedManifest(deps);
  if(!manifest)fail('installed_mismatch');
  return verifyInstalledGeneration(deps,modules,manifest,false);
}
function verifyRecordAuthority(deps,modules,manifest){
  for(const path of ['/usr/local/bin/node',NODE,'/usr/bin/env','/usr/bin/dash','/usr/bin/setpriv','/usr/bin/systemctl','/usr/bin/systemd-run','/usr/sbin/visudo','/usr/bin/sudo'])trustedExecutable(path,deps.io);
  if(deps.io.realpathSync('/usr/local/bin/node')!==NODE||command(deps,'/usr/local/bin/node',['--no-addons','--version']).stdout.trim()!=='v24.22.2')fail('dependency');
  for(const name of ARTIFACTS.filter(name=>name.endsWith('.mjs'))){trustedPath(`${CODE}/${name}`,{mode:0o755},deps.io);if(sha(trustedRead(`${CODE}/${name}`,deps.io))!==manifest.files[name])fail('installed_mismatch');}
  for(const path of ['/usr/local/libexec/patrick-worker-enter','/usr/local/libexec/patrick-worker-probe'])trustedPath(path,{mode:0o755},deps.io);
  if(trustedRead('/usr/local/libexec/patrick-worker-enter',deps.io)!==LAUNCHER||sha(trustedRead('/usr/local/libexec/patrick-worker-probe',deps.io))!==manifest.files['patrick-worker-probe'])fail('installed_mismatch');
  const sudoers=trustedRead('/etc/sudoers.d/patrick-worker',deps.io);trustedPath('/etc/sudoers.d/patrick-worker',{mode:0o440},deps.io);
  const template=sudoers.split('\n').map(line=>line.startsWith(manifest.controlAdmin+' ')?'@CONTROL_ADMIN@'+line.slice(manifest.controlAdmin.length):line).join('\n');if(sha(template)!==manifest.files['patrick-worker-sudoers'])fail('installed_mismatch');
  command(deps,'/usr/sbin/visudo',['-c','-f','/etc/sudoers.d/patrick-worker'],undefined,'installed_mismatch');
  const policyText=trustedRead(`${CONFIG}/policy.json`,deps.io);if(sha(policyText)!==manifest.installation.policyHash)fail('installed_mismatch');const policy=modules.parsePolicy(JSON.parse(policyText));
  const {facts}=readAccounts(deps),plan=planAccounts(policy,facts,manifest.controlAdmin);if(plan.missing.length)fail('account_conflict');inspectHomes(deps,facts,plan.names,[],manifest.controlAdmin);auditSudo(deps,plan.names);const accounts=policyAccounts(facts);modules.validateAccounts(policy,accounts);
  if(!same(manifest.installation.accounts,Object.fromEntries(plan.names.map(name=>[name,accounts[name]]))))fail('installed_mismatch');
  let registry;try{registry=modules.readRegistryAuthority(deps.io,manifest.installation.registry);}catch{fail('installed_mismatch');}
  return {modules,manifest,policy,accounts,registry};
}
function verifyInstalledGeneration(deps,modules,manifest,historical) {
  // A failed update can already have fenced the target generation while these
  // old manifest-bound files still prove ownership. Only the fresh installed
  // inspection may return a fence or be used to establish current readiness.
  const fence=historical?null:readInstallState(deps,manifest.installation.artifactHash,manifest.installation.policyHash);
  const {policy,accounts,registry}=verifyRecordAuthority(deps,modules,manifest),{facts}=readAccounts(deps),plan=planAccounts(policy,facts,manifest.controlAdmin);
  trustedPath(`${CONFIG}/route-inventory.json`,{mode:0o600},deps.io);
  const inventoryText=trustedRead(`${CONFIG}/route-inventory.json`,deps.io);
  if(sha(inventoryText)!==manifest.files['route-inventory.json'])fail('installed_mismatch');
  const rawInventory=JSON.parse(inventoryText);
  const inventory=validateInventory(rawInventory,policy,historical?rawInventory.guest:observeGuest(deps),historical?Date.parse(rawInventory.collectedAt):deps.now());
  auditSockets(deps,facts,plan.names,manifest.controlAdmin,inventory);
  const nftText=trustedRead(`${CONFIG}/firewall.nft`,deps.io);if(sha(nftText)!==manifest.installation.nftHash||nftText!==modules.renderNft(policy,Object.fromEntries(plan.names.map(name=>[name,accounts[name].uid]))))fail('installed_mismatch');
  const contents={};for(const name of ['patrick-worker-firewall.service','patrick-worker-proxy.service']){contents[name]=trustedRead(`/etc/systemd/system/${name}`,deps.io);if(sha(contents[name])!==manifest.files[name])fail('installed_mismatch');}assertUnits(deps,contents);
  return {modules,manifest,fence,policy,accounts,registry,inventory,nftText,drain:()=>drain(deps,facts,plan.names.filter(name=>name!==policy.proxyUser),modules,{kind:'existing',registry:manifest.installation.registry}),nft:()=>currentNft(deps),proxy:()=>{checkLimits(deps);return proxyFacts(deps,modules);}};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){let emitted=false;const deps=productionDependencies();deps.summary=value=>{emitted=true;process.stdout.write(JSON.stringify(value)+'\n');};try{await installGuest(parseInstallArguments(process.argv.slice(2)),deps);}catch(error){const reason=REASONS.has(error?.reason)?error.reason:'arguments';if(!emitted)process.stdout.write(JSON.stringify({version:1,mode:process.argv.includes('--apply')?'apply':'check',outcome:'fail',reason,policyHash:'',artifactHash:'',accountsToCreate:0,filesToReplace:0,ownedTableToReplace:false})+'\n');process.stderr.write(reason+'\n');process.exitCode=78;}}
