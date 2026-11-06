import { isIP } from 'node:net';

const runners=new Set(['grok','codex','dsh']);
const userPattern=/^patrick-[a-z][a-z0-9-]{0,23}$/;
const fail=()=>{throw new Error('Worker entry denied.');};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const text=(value,max=1024)=>typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=max&&!value.includes('\0')&&value.isWellFormed();
const integer=(value,min,max=2147483647)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
function contextValid(value) {
  return exact(value,['runner','user','projectId','domain'])&&runners.has(value.runner)&&typeof value.user==='string'&&userPattern.test(value.user)&&text(value.projectId)&&/^[a-zA-Z0-9_-]+$/.test(value.projectId)&&text(value.domain);
}
export function validateContext(value) {if(!contextValid(value))fail();return {...value};}
function validHost(value) {
  return text(value,253)&&value===value.toLowerCase()&&!isIP(value)&&!/^\d+(?:\.\d+)*$/.test(value)&&value.includes('.')&&value.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
function validCidr(value) {
  if(!text(value,64))return false;
  const parts=value.split('/');if(parts.length!==2||!/^\d{1,3}$/.test(parts[1]))return false;
  const family=isIP(parts[0]);return family!==0&&Number(parts[1])<=(family===4?32:128);
}
export function parsePolicy(raw) {
  if(!exact(raw,['version','proxyUser','workers','deniedCidrs'])||raw.version!==1||raw.proxyUser!=='patrick-proxy'||!Array.isArray(raw.workers)||!raw.workers.length||raw.workers.length>3||!Array.isArray(raw.deniedCidrs)||!raw.deniedCidrs.length||raw.deniedCidrs.length>128||!raw.deniedCidrs.every(validCidr)||new Set(raw.deniedCidrs).size!==raw.deniedCidrs.length)fail();
  const seen={runner:new Set(),user:new Set(),proxyPort:new Set()};
  const workers=raw.workers.map(worker=>{
    if(!exact(worker,['runner','user','projectId','domain','proxyPort','hosts'])||!contextValid({runner:worker.runner,user:worker.user,projectId:worker.projectId,domain:worker.domain})||worker.user===raw.proxyUser||!integer(worker.proxyPort,1024,65535)||!Array.isArray(worker.hosts)||worker.hosts.length>64||!worker.hosts.every(validHost)||new Set(worker.hosts).size!==worker.hosts.length)fail();
    for(const key of ['runner','user','proxyPort']){if(seen[key].has(worker[key]))fail();seen[key].add(worker[key]);}
    return Object.freeze({...worker,hosts:Object.freeze([...worker.hosts])});
  });
  return Object.freeze({version:1,proxyUser:'patrick-proxy',workers:Object.freeze(workers),deniedCidrs:Object.freeze([...raw.deniedCidrs])});
}
function validateAccount(user,account) {
  if(!exact(account,['uid','gid','home','groups'])||!integer(account.uid,1000)||!integer(account.gid,1000)||account.home!==`/var/lib/${user}`||!Array.isArray(account.groups)||account.groups.length)fail();
}
export function validateEntry(context,command,policy,account) {
  validateContext(context);const parsed=parsePolicy(policy);
  const profile=parsed.workers.find(worker=>['runner','user','projectId','domain'].every(key=>worker[key]===context[key]));
  if(!profile||!Array.isArray(command)||!command.length||command.length>256||!text(command[0],131072)||command.some(arg=>typeof arg!=='string'||arg.includes('\0')||!arg.isWellFormed()||Buffer.byteLength(arg)>131072)||command.reduce((sum,arg)=>sum+Buffer.byteLength(arg),0)>1048576)fail();
  validateAccount(context.user,account);
  return Object.freeze({...context,uid:account.uid,gid:account.gid,home:account.home,proxyPort:profile.proxyPort,command:Object.freeze([...command])});
}
export function validateAccounts(policy,accounts) {
  const parsed=parsePolicy(policy);if(!object(accounts))fail();
  for(const user of [...parsed.workers.map(worker=>worker.user),parsed.proxyUser]) {
    const account=accounts[user];validateAccount(user,account);
    for(const [other,facts] of Object.entries(accounts))if(other!==user&&(!facts||facts.uid===account.uid||facts.gid===account.gid))fail();
  }
  return accounts;
}

// This module is checked as one file before privileged helper import. Keep its
// dependencies limited to Node built-ins; proxy-only parsing lives separately.
export function parseAuthority(authority,allowed) {
  if(typeof authority!=='string'||!authority.endsWith(':443'))throw new Error('AUTHORITY');
  const host=authority.slice(0,-4);
  if(!validHost(host)||/^(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+))*$/.test(host)||!allowed.has(host))throw new Error('AUTHORITY');
  return host;
}
export function renderNft(policy,accounts) {
  const parsed=parsePolicy(policy),users=[...parsed.workers.map(worker=>worker.user),parsed.proxyUser];
  if(!object(accounts)||Reflect.ownKeys(accounts).length!==users.length||!users.every(user=>Object.hasOwn(accounts,user)))fail();
  const uids=new Map(users.map(user=>[user,accounts[user]]));
  if(![...uids.values()].every(uid=>integer(uid,1000))||new Set(uids.values()).size!==users.length)fail();
  const lines=['table inet patrick_worker {','  chain output {','    type filter hook output priority -50; policy accept;'];
  for(const worker of parsed.workers)lines.push(`    meta skuid ${uids.get(worker.user)} jump ${worker.runner}_out`);
  lines.push('  }');
  for(const worker of parsed.workers)lines.push(`  chain ${worker.runner}_out {`,`    oifname "lo" ip daddr 127.0.0.1 tcp dport ${worker.proxyPort} accept`,'    reject with icmpx type admin-prohibited','  }');
  return [...lines,'}',''].join('\n');
}
