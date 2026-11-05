import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { DomainError, now, safeRelativePath } from './domain.js';
import { Store } from './store.js';

const manifestSchema=z.object({version:z.literal(1),createdAt:z.string(),files:z.array(z.object({path:z.string(),sha256:z.string()}))});
function sha(path:string){return createHash('sha256').update(readFileSync(path)).digest('hex');}
function files(dir:string,root=dir):{path:string;sha256:string}[] {
  return readdirSync(dir,{withFileTypes:true}).flatMap(item=>{
    const path=join(dir,item.name);if(item.isSymbolicLink())throw new DomainError('Snapshot contains a symbolic link.','invalid_backup');
    if(item.isDirectory())return files(path,root);
    return relative(root,path)==='manifest.json'?[]:[{path:relative(root,path).split('\\').join('/'),sha256:sha(path)}];
  });
}
/** Reserve the final name without replacing any existing directory or file.
 * The manifest is installed last, so verification rejects incomplete or
 * contaminated reservations. A failed reservation is left in place: removing it could
 * delete a concurrent owner's replacement or newly populated directory.
 */
function publish(staging:string,destination:string):void {
  try{mkdirSync(destination,{mode:0o700});}
  catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new DomainError('Backup destination already exists.','backup_exists',409);throw error;}
  const reserved=lstatSync(destination);
  const assertReservation=()=>{
    const current=lstatSync(destination);
    if(!current.isDirectory()||current.dev!==reserved.dev||current.ino!==reserved.ino)throw new Error('Backup destination reservation changed.');
  };
  const install=(from:string,to:string,root=false):void=>{
    for(const item of readdirSync(from,{withFileTypes:true})){
      if(root&&item.name==='manifest.json')continue;
      assertReservation();const source=join(from,item.name),target=join(to,item.name);
      if(item.isDirectory()){mkdirSync(target,{mode:statSync(source).mode&0o777});install(source,target);}
      else if(item.isFile())linkSync(source,target); // Hard links never replace an existing name.
      else throw new DomainError('Snapshot contains a non-file entry.','invalid_backup');
    }
  };
  install(staging,destination,true);
  assertReservation();linkSync(join(staging,'manifest.json'),join(destination,'manifest.json'));assertReservation();
}
/** A consistent SQLite snapshot regenerates published Vault files; credentials and machine leases are excluded. */
export async function createBackup(store:Store,destination:string,options:{mode?:'live'|'demo'|'test';vaultDir?:string}={}):Promise<void> {
  if(existsSync(destination))throw new DomainError('Backup destination already exists.','backup_exists',409);
  mkdirSync(dirname(destination),{recursive:true,mode:0o700});
  const staging=`${destination}.partial-${randomUUID()}`;mkdirSync(staging,{mode:0o700});
  try{
    const vaultDir=options.vaultDir??store.vaultDirectory?.();
    if(typeof store.rebuildIndex==='function')store.rebuildIndex();
    if(vaultDir&&existsSync(vaultDir)){
      files(vaultDir); // Reject symlinks before copying authorized originals and preserved conflict versions.
      cpSync(vaultDir,join(staging,'vault'),{recursive:true,filter:path=>statSync(path).isDirectory()||path.endsWith('.md')&&!path.includes('.tmp-')});
    }
    await store.backup(join(staging,'patrick.db'));
    const snapshot=new Store(join(staging,'patrick.db'),join(staging,'vault'));snapshot.close();
    writeFileSync(join(staging,'workspace-mode'),options.mode??'live',{mode:0o600});
    writeFileSync(join(staging,'manifest.json'),JSON.stringify({version:1,createdAt:now(),files:files(staging)},null,2),{mode:0o600});
    verifyBackup(staging);
    publish(staging,destination);
    verifyBackup(destination);
    rmSync(staging,{recursive:true,force:true});
  }catch(error){
    try{rmSync(staging,{recursive:true,force:true});}
    catch(cleanupError){throw new AggregateError([error,cleanupError],'Backup failed and temporary backup cleanup also failed.',{cause:error});}
    throw error;
  }
}
export function verifyBackup(directory:string):z.infer<typeof manifestSchema> {
  const actual=files(directory); // Refuse symlinked snapshot components, including parent directories.
  const manifest=manifestSchema.parse(JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8')));
  if(new Set(manifest.files.map(f=>f.path)).size!==manifest.files.length||actual.length!==manifest.files.length||actual.some(file=>!manifest.files.some(expected=>expected.path===file.path&&expected.sha256===file.sha256)))throw new DomainError('Snapshot contains unverified or duplicate files.','invalid_backup');
  if(!manifest.files.some(file=>file.path==='patrick.db'))throw new DomainError('Snapshot lacks its task ledger.','invalid_backup');
  for(const file of manifest.files){safeRelativePath(file.path);const path=join(directory,file.path);if(!existsSync(path)||!statSync(path).isFile()||sha(path)!==file.sha256)throw new DomainError(`Snapshot integrity check failed: ${file.path}`,'invalid_backup');}
  return manifest;
}
