#!/usr/local/bin/node
// Finite root observations. No user-selected command, path, environment or
// readiness Boolean can cross this interface.
import * as fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url));
const operations=['snapshot','firewall-load','synthetic-network','qualification','qualification-start','qualification-finish','qualification-network'];
const fail=reason=>{throw Object.assign(new Error(reason),{reason});};
export function parseProbeArguments(argv) {
  if(!Array.isArray(argv)||argv.length!==2||argv[0]!=='--operation'||!operations.includes(argv[1]))fail('arguments');return argv[1];
}
function trustBootstrap(io) {
  // The bootstrap imports only one immutable root file. That file checks all
  // local code and executable symlink components before any other import/use.
  for(const path of [fileURLToPath(import.meta.url),`${here}/install-guest.mjs`]){
    for(let current=path;;current=dirname(current)){const stat=io.lstatSync(current),leaf=current===path;if(stat.uid!==0||stat.isSymbolicLink()||(stat.mode&0o022)||(leaf?!stat.isFile():!stat.isDirectory()))fail('untrusted_artifact');if(current==='/')break;}
  }
}
const sessionPath='/etc/patrick-worker/qualification.json',markerNames=['.patrick-synthetic-auth','.patrick-synthetic-config'];
const hash=value=>createHash('sha256').update(value).digest('hex');
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===k.length&&k.every(x=>Object.hasOwn(v,x));
function homeIdentityHash(home,io){const root=io.lstatSync(home);if(!root.isDirectory()||root.isSymbolicLink())fail('installed_mismatch');return hash(JSON.stringify([root.ino,root.uid,root.gid,root.mode]));}
function syncDirectory(path,io){const fd=io.openSync(path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{io.fsyncSync(fd);}finally{io.closeSync(fd);}}
function persistSession(session,io){const temp=sessionPath+'.'+randomBytes(16).toString('hex')+'.tmp';let fd;try{fd=io.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);io.writeFileSync(fd,JSON.stringify(session)+'\n');io.chmodSync(temp,0o600);io.fsyncSync(fd);io.closeSync(fd);fd=undefined;io.renameSync(temp,sessionPath);syncDirectory('/etc/patrick-worker',io);}finally{if(fd!==undefined)io.closeSync(fd);try{io.unlinkSync(temp);}catch{}}}
function readSession(installer,io,modules){try{installer.trustedPath(sessionPath,{mode:0o600},io);const value=JSON.parse(installer.trustedRead(sessionPath,io,131072));if(!modules.validQualificationSession(value))fail('installed_mismatch');return value;}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function binding(state){return state.policy.workers.map(w=>({runner:w.runner,user:w.user,projectId:w.projectId,domain:w.domain,uid:state.accounts[w.user].uid,gid:state.accounts[w.user].gid,home:state.accounts[w.user].home,proxyPort:w.proxyPort}));}
function assertSession(session,state){if(JSON.stringify(session.registry)!==JSON.stringify(state.manifest.installation.registry)||session.artifactHash!==state.manifest.installation.artifactHash||session.policyHash!==state.manifest.installation.policyHash||session.inventoryHash!==state.inventory.fingerprint||JSON.stringify(session.bindings.map(({homeIno,baseline,markers,...b})=>b))!==JSON.stringify(binding(state)))fail('installed_mismatch');}
function verifyMarkers(session,io){if(session.phase!=='active')fail('service_state');for(const b of session.bindings){const h=io.lstatSync(b.home);if(h.ino!==b.homeIno||h.uid!==b.uid||h.gid!==b.gid||homeIdentityHash(b.home,io)!==b.baseline)fail('installed_mismatch');for(const marker of b.markers){const path=b.home+'/'+marker.name,s=io.lstatSync(path);if(s.isSymbolicLink()||!s.isFile()||s.uid!==0||s.gid!==0||(s.mode&0o777)!==0o444||s.ino!==marker.ino||s.nlink!==1||s.size>128||hash(io.readFileSync(path))!==marker.hash)fail('installed_mismatch');}}}
async function finishQualification(installer,deps){
 const io=deps.io,modules=await installer.loadModules(deps),session=readSession(installer,io,modules);if(!session||session.networkOperation&&session.networkOperation.phase!=='complete')fail('service_state');
 const names=installer.ARTIFACTS.filter(n=>n.endsWith('.mjs'));if(!exact(session.codeHashes,[...names,'entry','probe']))fail('installed_mismatch');for(const name of [...names,'entry','probe']){const path=name==='entry'?'/usr/local/libexec/patrick-worker-enter':name==='probe'?'/usr/local/libexec/patrick-worker-probe':installer.CODE+'/'+name;installer.trustedPath(path,{mode:0o755},io);if(hash(installer.trustedRead(path,io))!==session.codeHashes[name])fail('installed_mismatch');}
 modules.readRegistryAuthority(io,session.registry);if(!modules.registryRecordsClosed(io,session.registry,session.records))fail('active_worker');const policyText=installer.trustedRead(installer.CONFIG+'/policy.json',io);if(hash(policyText)!==session.policyHash)fail('installed_mismatch');const policy=modules.parsePolicy(JSON.parse(policyText)),rawAccounts=installer.readAccounts(deps).facts,accounts=Object.fromEntries(Object.entries(rawAccounts).map(([name,{uid,gid,home,groups}])=>[name,{uid,gid,home,groups}]));modules.validateAccounts(policy,accounts);
 for(const b of session.bindings){const selected=policy.workers.find(w=>w.runner===b.runner);if(!selected||['user','projectId','domain','proxyPort'].some(k=>selected[k]!==b[k])||accounts[b.user]?.uid!==b.uid||accounts[b.user]?.gid!==b.gid||accounts[b.user]?.home!==b.home)fail('account_conflict');}
 const uids=new Set(session.bindings.map(b=>b.uid)),pids=io.readdirSync('/proc').filter(p=>/^\d+$/.test(p));if(pids.length>131072)fail('active_worker');for(const pid of pids){let text;try{text=io.readFileSync('/proc/'+pid+'/status','utf8');}catch(e){if(e.code==='ENOENT')continue;throw e;}const rows=text.split('\n').filter(l=>l.startsWith('Uid:'));if(rows.length!==1)fail('active_worker');const ids=rows[0].slice(4).trim().split(/\s+/);if(ids.length!==4||ids.some(v=>!/^\d+$/.test(v)))fail('active_worker');if(ids.some(v=>uids.has(Number(v))))fail('active_worker');}
 const units=deps.run('/usr/bin/systemctl',['list-units','--all','--no-pager','--no-legend','--plain','patrick-worker-*.service']);if(units.status!==0||typeof units.stdout!=='string'||units.stdout.split('\n').filter(Boolean).some(l=>!['patrick-worker-firewall.service','patrick-worker-proxy.service'].includes(l.trim().split(/\s+/)[0])))fail('active_worker');
 installer.trustedPath('/var/lib/patrick-workspaces',{kind:'directory'},io);if(io.readdirSync('/var/lib/patrick-workspaces').length)fail('active_worker');
 if(session.phase==='active'){verifyMarkers(session,io);session.phase='finishing';persistSession(session,io);}
 for(const b of session.bindings){if(homeIdentityHash(b.home,io)!==b.baseline)fail('installed_mismatch');for(const m of b.markers){const path=b.home+'/'+m.name;let present=true,st;try{st=io.lstatSync(path);}catch(e){if(e.code!=='ENOENT')throw e;present=false;}if(m.removed){if(present)fail('installed_mismatch');continue;}if(!present&&!m.removeIntended)fail('installed_mismatch');if(present&&(st.isSymbolicLink()||!st.isFile()||st.uid!==0||st.gid!==0||(st.mode&0o777)!==0o444||st.ino!==m.ino||st.nlink!==1||st.size>128||hash(io.readFileSync(path))!==m.hash))fail('installed_mismatch');if(!m.removeIntended){m.removeIntended=true;persistSession(session,io);}if(present)io.unlinkSync(path);syncDirectory(b.home,io);m.removed=true;persistSession(session,io);}}
 io.unlinkSync(sessionPath);syncDirectory('/etc/patrick-worker',io);for(const b of session.bindings)if(homeIdentityHash(b.home,io)!==b.baseline)fail('installed_mismatch');
 return Object.freeze({version:1,operation:'qualification-finish',outcome:'pass',reason:'ok',synthetic:true,sessionActive:false,artifactHash:session.artifactHash,policyHash:session.policyHash,inventoryHash:session.inventoryHash,fixtureHash:session.codeHashes['synthetic-worker.mjs'],guestVersion:'0',systemdVersion:'0',bindings:session.bindings.map(({homeIno,baseline,markers,...b})=>b),observations:[]});
}
async function qualificationOperation(operation,installer,deps){
 return installer.withInstallationMutex(deps,async()=>{
 if(operation==='qualification-finish')return finishQualification(installer,deps);
 const state=await installer.inspectInstalled(deps);if(state.fence.status!=='ready')fail('installed_mismatch');state.drain();state.modules.assertReadiness(state.nft(),state.proxy(),state.policy,state.accounts);const io=deps.io;let session=readSession(installer,io,state.modules);
 if(session){assertSession(session,state);verifyMarkers(session,io);}
 if(operation==='qualification-start'){
  if(session)fail('service_state');const bindings=binding(state).map(b=>({...b,homeIno:io.lstatSync(b.home).ino,baseline:homeIdentityHash(b.home,io),markers:[]}));
  // Inspect every reserved name before the first mutation. Never clobber.
  for(const b of bindings)for(const name of [...markerNames,'.patrick-synthetic-scratch']){try{io.lstatSync(b.home+'/'+name);fail('installed_mismatch');}catch(e){if(e.code!=='ENOENT')throw e;}}
  session={version:2,registry:state.manifest.installation.registry,phase:'active',generation:randomBytes(16).toString('hex'),artifactHash:state.manifest.installation.artifactHash,policyHash:state.manifest.installation.policyHash,inventoryHash:state.inventory.fingerprint,bindings,records:[],codeHashes:Object.fromEntries([...Object.keys(state.manifest.files).filter(n=>n.endsWith('.mjs')).map(n=>[n,state.manifest.files[n]]),['entry',hash(io.readFileSync('/usr/local/libexec/patrick-worker-enter'))],['probe',hash(io.readFileSync('/usr/local/libexec/patrick-worker-probe'))]])};
  const created=[];try{for(const b of bindings)for(const name of markerNames){const path=b.home+'/'+name,bytes=`patrick-synthetic:${name}\n`,fd=io.openSync(path,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o444);try{io.writeFileSync(fd,bytes);io.chmodSync(path,0o444);io.fsyncSync(fd);}finally{io.closeSync(fd);}const st=io.lstatSync(path);created.push({path,ino:st.ino});b.markers.push({name,ino:st.ino,hash:hash(bytes),removeIntended:false,removed:false});syncDirectory(b.home,io);}
   const fd=io.openSync(sessionPath,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{io.writeFileSync(fd,JSON.stringify(session)+'\n');io.chmodSync(sessionPath,0o600);io.fsyncSync(fd);}finally{io.closeSync(fd);}syncDirectory('/etc/patrick-worker',io);
  }catch(error){for(const item of created){try{const s=io.lstatSync(item.path);if(s.ino===item.ino&&s.uid===0)io.unlinkSync(item.path);}catch{}}throw error;}
  verifyMarkers(session,io);
 }
 const observations=session?state.modules.qualificationObservations?.(session,deps.io)??[]:[];
 const rawVersion=deps.run('/usr/bin/systemctl',['--version']).stdout??'',systemdVersion=/^systemd ([0-9][0-9A-Za-z.+_-]{0,63})\b/.exec(rawVersion)?.[1]??'0';
 let guestVersion='0';try{installer.trustedExecutable('/etc/os-release',io,false);const text=installer.trustedRead(io.realpathSync('/etc/os-release'),io);guestVersion=/^VERSION_ID="?([0-9][0-9A-Za-z.+_-]{0,63})"?$/m.exec(text)?.[1]??'0';}catch{}
 return Object.freeze({version:1,operation,outcome:'pass',reason:'ok',synthetic:true,sessionActive:Boolean(session),artifactHash:state.manifest.installation.artifactHash,policyHash:state.manifest.installation.policyHash,inventoryHash:state.inventory.fingerprint,fixtureHash:state.manifest.files['synthetic-worker.mjs'],guestVersion,systemdVersion,bindings:binding(state),observations});
});}
export async function probeGuest(operation,dependenciesOverride) {
  if(!operations.includes(operation))fail('arguments');
  const io=dependenciesOverride?.io??fs;
  if((dependenciesOverride?.effectiveUid?.()??process.geteuid?.())!==0)fail('not_root');
  trustBootstrap(io);
  const installer=await import('./install-guest.mjs'),deps=dependenciesOverride??installer.productionDependencies();
  if(operation==='qualification-network'){
    const prepared=await installer.withInstallationMutex(deps,async()=>{const state=await installer.inspectInstalled(deps);if(state.fence.status!=='ready')fail('installed_mismatch');const session=readSession(installer,io,state.modules);if(!session||session.networkOperation)fail('service_state');assertSession(session,state);verifyMarkers(session,io);state.drain();state.modules.assertReadiness(state.nft(),state.proxy(),state.policy,state.accounts);return {state,session};});
    const network=await import('./installed-network.mjs');return network.runInstalledNetwork(prepared.state,prepared.session,deps);
  }
  if(operation.startsWith('qualification'))return qualificationOperation(operation,installer,deps);
  const state=await installer.inspectInstalled(deps);
  if(operation==='firewall-load'){
    state.drain();const current=state.nft();if(current)installer.assertNftOnly(state.modules,current,state.policy,state.accounts);
    installer.firewallTransaction(deps,state.modules,state.policy,state.accounts,state.nftText,Boolean(current));
    if(state.fence.status!=='ready'&&!(state.fence.status==='applying'&&installer.liveInstaller(deps,state.fence,state.manifest)))fail('service_state');
    return Object.freeze({version:1,operation,outcome:'pass',reason:'ok',policyHash:state.manifest.installation.policyHash,topologyFingerprint:state.inventory.fingerprint,inventoryCoverage:state.inventory.coverage,ipv6UpstreamDisabled:state.inventory.ipv6UpstreamDisabled});
  }
  if(state.fence.status!=='ready')fail('installed_mismatch');
  if(operation==='snapshot')return installer.withInstallationMutex(deps,async()=>{
    const locked=await installer.inspectInstalled(deps);if(locked.fence.status!=='ready')fail('installed_mismatch');locked.drain();locked.modules.assertReadiness(locked.nft(),locked.proxy(),locked.policy,locked.accounts);
    return Object.freeze({version:1,operation,outcome:'pass',reason:'ok',policyHash:locked.manifest.installation.policyHash,topologyFingerprint:locked.inventory.fingerprint,inventoryCoverage:locked.inventory.coverage,ipv6UpstreamDisabled:locked.inventory.ipv6UpstreamDisabled});
  });
  try{io.lstatSync('/run/patrick-worker/install.lock');fail('service_state');}catch(error){if(error.code!=='ENOENT')throw error;}
  state.drain();
  // Snapshot is a live kernel/process assertion, never a persisted ready flag.
  state.modules.assertReadiness(state.nft(),state.proxy(),state.policy,state.accounts);
  if(operation==='synthetic-network'){
    return installer.withInstallationMutex(deps,async()=>{
      const locked=await installer.inspectInstalled(deps);locked.drain();const beforeNft=locked.nft(),beforeProxy=locked.proxy();locked.modules.assertReadiness(beforeNft,beforeProxy,locked.policy,locked.accounts);
      try{const network=await import('./synthetic-network.mjs');return await network.runSyntheticNetwork(locked,deps);}
      finally{const restored=await installer.inspectInstalled(deps);restored.drain();const nft=restored.nft(),proxy=restored.proxy();restored.modules.assertReadiness(nft,proxy,restored.policy,restored.accounts);if(restored.manifest.installation.artifactHash!==locked.manifest.installation.artifactHash||restored.manifest.installation.policyHash!==locked.manifest.installation.policyHash||JSON.stringify(nft)!==JSON.stringify(beforeNft)||JSON.stringify(proxy)!==JSON.stringify(beforeProxy))fail('installed_mismatch');}
    });
  }
  return Object.freeze({version:1,operation,outcome:'pass',reason:'ok',policyHash:state.manifest.installation.policyHash,topologyFingerprint:state.inventory.fingerprint,inventoryCoverage:state.inventory.coverage,ipv6UpstreamDisabled:state.inventory.ipv6UpstreamDisabled});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let operation='';try{operation=parseProbeArguments(process.argv.slice(2));process.stdout.write(JSON.stringify(await probeGuest(operation))+'\n');}catch(error){const reasons=new Set(['arguments','not_root','untrusted_artifact','dependency','account_conflict','inventory_incomplete','policy_invalid','active_worker','nft_check','nft_apply','service_state','installed_mismatch']);const reason=reasons.has(error?.reason)?error.reason:'installed_mismatch';process.stdout.write(JSON.stringify({version:1,operation:operations.includes(operation)?operation:'',outcome:'fail',reason})+'\n');process.stderr.write(reason+'\n');process.exitCode=78;}
}
