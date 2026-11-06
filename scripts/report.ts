import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig } from '../src/config.js';
if(existsSync('.env'))process.loadEnvFile('.env');const config=readConfig(),project=process.argv[2]??config.projects[0]?.id;
if(!project)throw Error('Pass an authorized project ID: npm run report -- PROJECT_ID');
const token=config.authToken||(existsSync(join(config.dataDir,'access-token'))?readFileSync(join(config.dataDir,'access-token'),'utf8').trim():'');
const response=await fetch(`http://${config.host}:${config.port}/api/reports/weekly?project=${encodeURIComponent(project)}`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},signal:AbortSignal.timeout(15000)});
if(!response.ok)throw Error(`PAtrick report returned HTTP ${response.status}.`);console.log(JSON.stringify(await response.json(),null,2));
