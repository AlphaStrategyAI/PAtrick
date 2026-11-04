#!/usr/local/bin/node
// Finite root observations. No user-selected command, path, environment or
// readiness Boolean can cross this interface.
import * as fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const fail=reason=>{throw Object.assign(new Error(reason),{reason});};
export function parseProbeArguments(argv) {
  if(!Array.isArray(argv)||argv.length!==2||argv[0]!=='--operation'||!['snapshot','firewall-load','synthetic-network'].includes(argv[1]))fail('arguments');return argv[1];
}
function trustBootstrap(io) {
  // The bootstrap imports only one immutable root file. That file checks all
  // local code and executable symlink components before any other import/use.
  for(const path of [fileURLToPath(import.meta.url),`${here}/install-guest.mjs`]){
    for(let current=path;;current=dirname(current)){const stat=io.lstatSync(current),leaf=current===path;if(stat.uid!==0||stat.isSymbolicLink()||(stat.mode&0o022)||(leaf?!stat.isFile():!stat.isDirectory()))fail('untrusted_artifact');if(current==='/')break;}
  }
}
export async function probeGuest(operation,dependenciesOverride) {
  if(!['snapshot','firewall-load','synthetic-network'].includes(operation))fail('arguments');
  const io=dependenciesOverride?.io??fs;
  if((dependenciesOverride?.effectiveUid?.()??process.geteuid?.())!==0)fail('not_root');
  trustBootstrap(io);
  const installer=await import('./install-guest.mjs'),deps=dependenciesOverride??installer.productionDependencies();
  const state=await installer.inspectInstalled(deps);
  if(operation==='firewall-load'){
    state.drain();const current=state.nft();if(current)installer.assertNftOnly(state.modules,current,state.policy,state.accounts);
    installer.firewallTransaction(deps,state.modules,state.policy,state.accounts,state.nftText,Boolean(current));
    if(state.fence.status!=='ready'&&!(state.fence.status==='applying'&&installer.liveInstaller(deps,state.fence,state.manifest)))fail('service_state');
    return Object.freeze({version:1,operation,outcome:'pass',reason:'ok',policyHash:state.manifest.installation.policyHash,topologyFingerprint:state.inventory.fingerprint,inventoryCoverage:state.inventory.coverage,ipv6UpstreamDisabled:state.inventory.ipv6UpstreamDisabled});
  }
  if(state.fence.status!=='ready')fail('installed_mismatch');
  try{io.lstatSync('/run/patrick-worker/install.lock');fail('service_state');}catch(error){if(error.code!=='ENOENT')throw error;}
  // Snapshot is a live kernel/process assertion, never a persisted ready flag.
  state.modules.assertReadiness(state.nft(),state.proxy(),state.policy,state.accounts);
  if(operation==='synthetic-network'){
    // Active synthetic traffic belongs to Task3 and must run after privilege
    // drop. Do not execute a caller fixture or invent successful traffic here.
    fail('dependency');
  }
  return Object.freeze({version:1,operation,outcome:'pass',reason:'ok',policyHash:state.manifest.installation.policyHash,topologyFingerprint:state.inventory.fingerprint,inventoryCoverage:state.inventory.coverage,ipv6UpstreamDisabled:state.inventory.ipv6UpstreamDisabled});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let operation='';try{operation=parseProbeArguments(process.argv.slice(2));process.stdout.write(JSON.stringify(await probeGuest(operation))+'\n');}catch(error){const reasons=new Set(['arguments','not_root','untrusted_artifact','dependency','account_conflict','inventory_incomplete','policy_invalid','active_worker','nft_check','nft_apply','service_state','installed_mismatch']);const reason=reasons.has(error?.reason)?error.reason:'installed_mismatch';process.stdout.write(JSON.stringify({version:1,operation:['snapshot','firewall-load','synthetic-network'].includes(operation)?operation:'',outcome:'fail',reason})+'\n');process.stderr.write(reason+'\n');process.exitCode=78;}
}
