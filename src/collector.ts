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
            watcher.on('add',path=>this.trackCapture(project,path));watcher.on('change',path=>this.trackCapture(project,path));watcher.on('unlink',()=>void this.scan());watcher.on('error',()=>{if(!this.stopping)this.record(project,'watcher_unavailable');});this.watchers.set(project.id,watcher);
          }
          const files=await this.walk(root),seen=new Set<string>();
          for(const file of files){const externalId=`file:${relative(root,file).split(sep).join('/')}`;if(await this.capture(project,file)&&watching&&!this.signaled.has(file))this.recordMiss(project,externalId);seen.add(externalId);}
          this.signaled.clear();
          // Only a fully successful scan can declare that an authorized file disappeared.
          for(const source of this.store.list('sources'))if(source.kind==='file'&&source.projectId===project.id&&source.domain===project.domain&&source.status==='active'&&source.externalId.startsWith('file:')&&!seen.has(source.externalId))this.engine.withdraw(source.id);
          const noticedAt=this.store.list('events').filter(event=>event.projectId===project.id&&event.domain===project.domain&&event.type==='source.connection').map(event=>event.createdAt).sort().at(-1);
          const updatedAt=laterThan(noticedAt);
          this.store.save('cursors',{id:stableId('file-scan',project.domain,project.id),projectId:project.id,domain:project.domain,value:updatedAt,updatedAt});
        }catch(error){this.record(project,error instanceof Error&&error.message.includes('Source root moved')?'root_moved':'scan_paused');}
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
    const name=externalId.replace(/^file:/,'');
    const message=`补扫已收下监听没有报过的文件：${name}。这份资料已经入账，不用再添加一次。`;
    const source=this.store.list('sources').find(item=>item.projectId===project.id&&item.domain===project.domain&&item.kind==='file'&&item.status==='active'&&this.store.sourceExternalIdMatches(item,externalId));
    const task=source?this.store.list('tasks').find(item=>item.sourceId===source.id&&item.kind!=='reference_knowledge'):undefined;
    this.store.save('events',{id:stableId('source-missed',project.id,externalId,createdAt),projectId:project.id,domain:project.domain,...(task?{taskId:task.id}:{}),type:'source.missed',message,data:{externalId},createdAt});
    const noticeId=stableId('missed-file-notice',project.id,externalId,createdAt);
    if(!this.store.get('outbox',noticeId))this.store.save('outbox',{id:noticeId,projectId:project.id,domain:project.domain,...(task?{taskId:task.id}:{}),channel:this.config.feishu?'feishu':'origin',recipient:this.config.feishu?.ownerOpenId??this.config.ownerId,text:message,status:'pending',attempts:0,createdAt,runAfter:createdAt});
  }
  private record(project:Project,code:ScanNoticeCode):void {
    const cursor=this.store.get('cursors',stableId('file-scan',project.domain,project.id));
    const createdAt=laterThan(cursor?.updatedAt);
    const id=stableId('collector-notice',project.id,code,createdAt.slice(0,13));
    if(!this.store.get('events',id))this.store.save('events',{id,projectId:project.id,domain:project.domain,type:'source.connection',message:scanNoticeCopy(code).detail,createdAt,data:{code}});
  }
}

function laterThan(previous?:string):string {
  const current=now();
  if(!previous||current>previous)return current;
  return new Date(Date.parse(previous)+1).toISOString();
}
export type ScanNoticeCode='root_moved'|'scan_paused'|'watcher_unavailable';
export function scanNoticeCopy(code:ScanNoticeCode):{title:string;detail:string} {
  if(code==='root_moved')return {title:'同步目录位置变了',detail:'在设置里重新确认这个目录。下一次扫描成功前，不会读取新位置。已有资料保持有效。'};
  if(code==='watcher_unavailable')return {title:'文件监听暂时不可用',detail:'定时补扫仍会继续。已有资料保持有效。'};
  return {title:'同步目录这次没有扫完',detail:'确认目录还在，并且可以读取。下一次扫描成功前，已有资料保持有效。'};
}
export function missedFileNotice(store:Store,project:{id:string;domain:string},at=new Date()):{title:string;detail:string}|undefined {
  const since=new Date(at.getTime()-7*86400000).toISOString();
  const latest=store.list('events').filter(event=>event.projectId===project.id&&event.domain===project.domain&&event.type==='source.missed'&&event.createdAt>=since).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
  return latest?{title:'补扫补上了一次漏通知',detail:latest.message}:undefined;
}
export function fileScanNotice(store:Store,project:{id:string;domain:string}):{title:string;detail:string}|undefined {
  const cursor=store.get('cursors',stableId('file-scan',project.domain,project.id));
  const unresolved=store.list('events').filter(event=>event.projectId===project.id&&event.domain===project.domain&&event.type==='source.connection'&&(!cursor||event.createdAt>cursor.updatedAt)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const chosen=unresolved.find(event=>event.data.code==='scan_paused'||event.data.code==='root_moved')??unresolved.find(event=>event.data.code==='watcher_unavailable');
  const code=chosen?.data.code;
  if(code!=='root_moved'&&code!=='scan_paused'&&code!=='watcher_unavailable')return undefined;
  return scanNoticeCopy(code);
}
export function fileScanStatus(store:Store,project:{id:string;domain:string;sourceDir?:string}):{title:string;detail:string} {
  if(!project.sourceDir)return {title:'文件监听未配置',detail:'可先手动加入材料，再配置同步目录'};
  const notice=fileScanNotice(store,project);
  if(notice)return notice;
  const cursor=store.get('cursors',stableId('file-scan',project.domain,project.id));
  return cursor?{title:'文件监听已配置',detail:'最近一次扫描已完成。新增、修改和撤回会在扫描成功后入账。'}:{title:'文件监听已配置',detail:'已配置同步目录，还没有完成第一次扫描。'};
}
