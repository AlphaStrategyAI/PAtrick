import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readConfig } from '../src/config.js';
import { collectDoctorChecks } from './doctor-checks.js';
if(existsSync('.env'))process.loadEnvFile('.env');
const config=readConfig();
const checks=collectDoctorChecks(config,process.versions.node,name=>{const probe=spawnSync(name,['--version'],{timeout:5000,encoding:'utf8'});return {ready:probe.status===0,detail:probe.status===0?'Installed; device/permissions still require acceptance.':'Not installed or unavailable.'};});
if(config.githubToken){try{const response=await fetch('https://api.github.com/user',{headers:{Authorization:`Bearer ${config.githubToken}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(10000)});checks.push({name:'GitHub authentication probe',ready:response.ok,detail:`HTTP ${response.status}`,live:config.mode==='live'&&response.ok});}catch{checks.push({name:'GitHub authentication probe',ready:false,detail:'Connection unavailable.',live:false});}}
console.log(JSON.stringify({mode:config.mode,dataDir:config.dataDir,vaultDir:config.vaultDir,checks},null,2));
if(checks.some(check=>!check.ready))process.exitCode=2;
