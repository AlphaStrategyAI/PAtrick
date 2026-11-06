import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DomainError } from './domain.js';

const markerSchema=z.object({pid:z.number().int().positive(),leaseId:z.string().regex(/^[a-f0-9]{32}$/),startedAt:z.string().datetime()}).strict();
export function acquireHostLease(dataDir:string):{release:()=>void;marker:z.infer<typeof markerSchema>} {
  mkdirSync(dataDir,{recursive:true,mode:0o700});
  const db=new Database(join(dataDir,'host-lease.db'));
  try{db.pragma('busy_timeout = 0');db.exec('BEGIN EXCLUSIVE');}catch{db.close();throw new DomainError('Another host owns the PAtrick writer lease.','writer_active',409);}
  const path=join(dataDir,'writer.lock'),marker={pid:process.pid,leaseId:randomBytes(16).toString('hex'),startedAt:new Date().toISOString()};let released=false;
  const release=()=>{
    if(released)return;released=true;
    try{if(existsSync(path)&&JSON.parse(readFileSync(path,'utf8')).leaseId===marker.leaseId)unlinkSync(path);}catch{}
    finally{try{db.exec('ROLLBACK');}finally{db.close();}}
  };
  try {
    if(existsSync(path)){
      let previous:z.infer<typeof markerSchema>;
      try{previous=markerSchema.parse(JSON.parse(readFileSync(path,'utf8')));}catch{throw new DomainError('Writer ownership is unverifiable. Inspect writer.lock before takeover.','writer_active',409);}
      try{process.kill(previous.pid,0);throw new DomainError('Another PAtrick writer is still active.','writer_active',409);}
      catch(error){if(error instanceof DomainError)throw error;if((error as NodeJS.ErrnoException).code!=='ESRCH')throw new DomainError('Writer process ownership cannot be verified.','writer_active',409);}
      // The SQLite exclusive lease serializes stale marker replacement across every current host.
      unlinkSync(path);
    }
    const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,JSON.stringify(marker));}finally{closeSync(fd);}
    return {release,marker};
  }catch(error){release();throw error;}
}
