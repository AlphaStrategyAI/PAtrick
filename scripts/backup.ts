import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import Database from 'better-sqlite3';
import { readConfig } from '../src/config.js';
import { createBackup, verifyBackup } from '../src/backup.js';
import { Store } from '../src/store.js';
if(existsSync('.env'))process.loadEnvFile('.env');
const config=readConfig(),target=resolve(process.argv[2]??process.env.PATRICK_BACKUP_DIR??join(config.dataDir,'backups',new Date().toISOString().replace(/[:.]/g,'-')));
if(!existsSync(join(config.dataDir,'patrick.db')))throw Error('Start PAtrick before taking a backup.');
// Open the active database read-only; do not construct another host or import the active Vault.
const db=new Database(join(config.dataDir,'patrick.db'),{readonly:true});
const source={backup:(path:string)=>db.backup(path)} as unknown as Store;
try{await createBackup(source,target,{mode:config.mode,vaultDir:config.vaultDir});}finally{db.close();}
verifyBackup(target);console.log(`Verified snapshot: ${target}`);
if(process.env.RESTIC_REPOSITORY){await promisify(execFile)('restic',['backup',target],{timeout:600000});console.log('Encrypted restic backup completed.');}
