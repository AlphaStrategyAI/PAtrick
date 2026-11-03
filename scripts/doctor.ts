import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readConfig } from '../src/config.js';
import { readiness } from '../src/readiness.js';
if(existsSync('.env'))process.loadEnvFile('.env');
const config=readConfig();
const checks=[{name:'Node.js 24',ready:process.versions.node.startsWith('24.'),detail:process.versions.node},...readiness(config)];
for(const command of ['limactl','restic']){const probe=spawnSync(command,['--version'],{timeout:5000,encoding:'utf8'});checks.push({name:command,ready:probe.status===0,detail:probe.status===0?'Installed; device/permissions still require acceptance.':'Not installed or unavailable.'});}
if(config.githubToken){try{const response=await fetch('https://api.github.com/user',{headers:{Authorization:`Bearer ${config.githubToken}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(10000)});checks.push({name:'GitHub authentication probe',ready:response.ok,detail:`HTTP ${response.status}`});}catch{checks.push({name:'GitHub authentication probe',ready:false,detail:'Connection unavailable.'});}}
console.log(JSON.stringify({mode:config.mode,dataDir:config.dataDir,vaultDir:config.vaultDir,checks},null,2));
if(checks.some(check=>!check.ready))process.exitCode=2;
