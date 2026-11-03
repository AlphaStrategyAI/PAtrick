import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readConfig } from './config.js';
import { DomainError, now, stableId, type AppConfig, type DeliveryWriter } from './domain.js';
import { Store } from './store.js';
import { Workbench } from './orchestrator.js';
import { configureDemo, DemoWorker, demoResearch, demoWriter, seedDemo } from './demo.js';
import { liveWorkers } from './integrations/workers.js';
import { GitHubWriter } from './integrations/github.js';
import { GitLabWriter } from './integrations/gitlab.js';
import { BilingualResearch } from './integrations/research.js';
import { SourceCollector } from './collector.js';
import { FeishuChannel } from './integrations/feishu.js';
import { NetworkGuardian, readNetworkTargets, systemNetworkActions } from './integrations/network.js';
import { acquireHostLease } from './lease.js';

export async function createRuntime(config:AppConfig=readConfig()) {
  mkdirSync(config.dataDir,{recursive:true,mode:0o700});
  const modeFile=join(config.dataDir,'workspace-mode');
  if(existsSync(modeFile)&&readFileSync(modeFile,'utf8').trim()!==config.mode)throw new DomainError('Demo and live workspaces must use separate data directories.','workspace_mode',409);
  if(!existsSync(modeFile))writeFileSync(modeFile,config.mode,{mode:0o600,flag:'wx'});
  const {release}=acquireHostLease(config.dataDir);
  try {
    if(config.mode==='demo')configureDemo(config);
    if(config.mode==='live'&&!config.authToken) {
      const tokenFile=join(config.dataDir,'access-token');
      if(!existsSync(tokenFile))writeFileSync(tokenFile,randomBytes(32).toString('base64url'),{mode:0o600,flag:'wx'});
      config.authToken=readFileSync(tokenFile,'utf8').trim();
      if(config.authToken.length<24)throw new DomainError('The persisted access token is too short. Replace it with a strong token.','configuration');
    }
    config.sessionSecret ||= config.authToken;
    const store=new Store(join(config.dataDir,'patrick.db'),config.vaultDir);
    for(const p of config.projects)store.save('projects',p);
    config.projects=store.list('projects');
    const github=new GitHubWriter(store,config);
    const gitlab=new GitLabWriter(store,config),choose=(project:AppConfig['projects'][number])=>project.repositoryProvider==='gitlab'?gitlab:github;
    const writer:DeliveryWriter={baseline:project=>choose(project).baseline(project),readBaseline:(project,sha)=>choose(project).readBaseline(project,sha),deliver:(task,project)=>choose(project).deliver(task,project)};
    let feishu:FeishuChannel|undefined;let guardian:NetworkGuardian|undefined;
    const engine=new Workbench({store,config,writer:config.mode==='demo'?demoWriter:writer,workers:config.mode==='demo'?['grok','dsh','codex'].map(name=>new DemoWorker(name as 'grok'|'dsh'|'codex')):liveWorkers(config),research:config.mode==='demo'?demoResearch:new BilingualResearch(config),notifier:config.mode==='demo'?{send:async message=>({remoteId:`demo-notification:${message.id}`})}:config.feishu?{send:message=>feishu!.send(message)}:undefined,canRun:project=>!guardian||guardian.canRun(project.domain)});
    if(config.mode==='live'&&config.networkFile)guardian=new NetworkGuardian(readNetworkTargets(config.networkFile),systemNetworkActions(),result=>{for(const project of store.list('projects').filter(p=>p.domain===result.domain))store.save('events',{id:stableId('network',project.id,result.id,result.checkedAt),projectId:project.id,domain:project.domain,type:'network.path',message:result.reason,data:{state:result.state,targetId:result.id},createdAt:now()});});
    if(config.mode==='live'&&config.feishu)feishu=new FeishuChannel(store,config,engine);
    if(config.mode==='demo')await seedDemo(store,config,engine);
    const collector=new SourceCollector(store,config,engine);
    let closing:Promise<void>|undefined;let networkCheck:Promise<unknown>|undefined;
    const checkNetwork=()=>networkCheck??=(async()=>{if(!guardian)return;const resume=await engine.pause();try{await guardian.check();}finally{resume();}})().finally(()=>{networkCheck=undefined;});
    return {config,store,engine,collector,feishu,guardian,checkNetwork,close(){return closing??=(async()=>{await collector.stop();await engine.shutdown();await feishu?.shutdown();await guardian?.shutdown();await networkCheck;store.close();release();})();}};
  }catch(error){release();throw error;}
}
