import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { digest, now, stableId, type AppConfig, type Project } from './domain.js';
import type { Workbench } from './orchestrator.js';
import type { Store } from './store.js';
import { refreshCaseVersions } from './cases.js';

/** Watch notifications accelerate capture; complete scans own deletion detection and recovery. */
export class SourceCollector {
  private watchers=new Map<string,FSWatcher>();private roots=new Map<string,string>();private signaled=new Set<string>();private timer?:NodeJS.Timeout;private scanning=false;private stopping=false;private pending=new Set<Promise<boolean>>();private scanWaiters:(()=>void)[]=[];
  constructor(private store:Store,private config:AppConfig,private engine:Workbench) {}
  async start():Promise<void> {await this.scan();this.timer=setInterval(()=>void this.scan(),this.config.scanIntervalMs);this.timer.unref();}
  async stop():Promise<void> {this.stopping=true;if(this.timer)clearInterval(this.timer);await Promise.all([...this.watchers.values()].map(w=>w.close()));if(this.scanning)await new Promise<void>(resolve=>this.scanWaiters.push(resolve));await Promise.allSettled([...this.pending]);}
  async scan():Promise<void> {
    if(this.scanning||this.stopping)return;this.scanning=true;
    try {
      this.store.rebuildIndex();
      for(const project of this.config.projects)refreshCaseVersions(this.store,this.config,project);
      for(const project of this.store.list('projects')) {
        if(!project.sourceDir)continue;
        try {
          const root=await realpath(project.sourceDir);if(this.roots.has(project.id)&&this.roots.get(project.id)!==root)throw Error('Source root moved; authorize its new path before reading.');this.roots.set(project.id,root);
          const watching=this.watchers.has(project.id);
          if(!watching) {
            const watcher=watch(root,{ignoreInitial:true,followSymlinks:false,awaitWriteFinish:{stabilityThreshold:1000,pollInterval:100},ignored:/(^|[/\\])\.|node_modules/});
            watcher.on('add',path=>this.trackCapture(project,path));watcher.on('change',path=>this.trackCapture(project,path));watcher.on('unlink',()=>void this.scan());watcher.on('error',()=>{if(!this.stopping)this.record(project,'Source watcher unavailable; periodic scans remain enabled.');});this.watchers.set(project.id,watcher);
          }
          const files=await this.walk(root),seen=new Set<string>();
          for(const file of files){const externalId=`file:${relative(root,file).split(sep).join('/')}`;if(await this.capture(project,file)&&watching&&!this.signaled.has(file))this.recordMiss(project,externalId);seen.add(externalId);}
          this.signaled.clear();
          // Only a fully successful scan can declare that an authorized file disappeared.
          for(const source of this.store.list('sources'))if(source.kind==='file'&&source.projectId===project.id&&source.domain===project.domain&&source.status==='active'&&source.externalId.startsWith('file:')&&!seen.has(source.externalId))this.engine.withdraw(source.id);
          this.store.save('cursors',{id:stableId('file-scan',project.domain,project.id),projectId:project.id,domain:project.domain,value:now(),updatedAt:now()});
        }catch{this.record(project,'Source scan paused. Check the authorized directory and device connection. Existing sources remain valid until a complete scan succeeds.');}
      }
    }finally{this.scanning=false;this.scanWaiters.splice(0).forEach(resolve=>resolve());}
  }
  private trackCapture(project:Project,path:string):void{if(this.stopping)return;this.signaled.add(path);const promise=this.capture(project,path);this.pending.add(promise);void promise.catch(()=>{}).finally(()=>this.pending.delete(promise));}
  private async walk(dir:string):Promise<string[]> {
    const files:string[]=[];
    for(const item of await readdir(dir,{withFileTypes:true})) {
      if(item.name.startsWith('.')||item.name==='node_modules'||item.isSymbolicLink())continue;
      const path=join(dir,item.name);
      if(item.isDirectory())files.push(...await this.walk(path));else if(item.isFile()&&['.md','.txt','.markdown'].includes(extname(path).toLowerCase()))files.push(path);
    }
    return files;
  }
  private async capture(project:Project,path:string):Promise<boolean> {
    const root=this.roots.get(project.id);if(!root)return false;
    const resolved=await realpath(path);if(!resolved.startsWith(root+sep)||!(await stat(resolved)).isFile())return false;
    const info=await stat(resolved);if(info.size>1_000_000)throw Error('Source too large');
    if(!['.md','.txt','.markdown'].includes(extname(resolved).toLowerCase()))return false;
    const content=await readFile(resolved,'utf8'),after=await stat(resolved);if(after.mtimeMs!==info.mtimeMs||after.size!==info.size)throw Error('Source is still changing');
    const local=relative(root,resolved).split(sep).join('/');
    const externalId=`file:${local}`,lineage=this.store.list('sources').filter(s=>s.projectId===project.id&&s.domain===project.domain&&s.kind==='file'&&this.store.sourceExternalIdMatches(s,externalId)),current=lineage.find(s=>s.status==='active');
    if(current&&digest(current.content)===digest(content))return false;
    const revision=stableId('file-occurrence',lineage.at(-1)?.id??'first',digest(content),info.mtimeMs);
    this.engine.ingest({projectId:project.id,kind:'file',externalId,revision,title:content.match(/^#\s+(.+)/m)?.[1]??local.replace(/\.(md|txt|markdown)$/,''),content,locator:resolved,authorId:project.ownerId,retention:'permanent'});
    return true;
  }
  private recordMiss(project:Project,externalId:string):void {
    const createdAt=now();
    this.store.save('events',{id:stableId('source-missed',project.id,externalId,createdAt),projectId:project.id,domain:project.domain,type:'source.missed',message:'A periodic scan found a file change the watcher had not reported.',data:{externalId},createdAt});
  }
  private record(project:Project,message:string):void {
    const id=stableId('collector-notice',project.id,message,new Date().toISOString().slice(0,13));
    if(!this.store.get('events',id))this.store.save('events',{id,projectId:project.id,domain:project.domain,type:'source.connection',message,createdAt:now(),data:{}});
  }
}
