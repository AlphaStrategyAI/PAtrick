import { knowledgeReference } from './knowledge-use.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { z, ZodError } from 'zod';
import { DomainError, digest, now, stableId, type AppConfig, type Project, type QuestionAnswer, type Runner } from './domain.js';
import { projectSchema } from './config.js';
import { sameSecret, sessionToken, validSession } from './auth.js';
import { readiness, publicTask, publicAttempt, publicEvent, taskBillingStatus } from './readiness.js';
import { recordMaintenance } from './evaluation.js';
import { weeklyReport } from './reports.js';
import { outcomeReviewViews, recordOutcomeEvidence, runOutcomeReviews } from './reviews.js';
import { isKnowledgeSnapshotFailure, PrivacyCheckpointError, VaultSyncError, type Store } from './store.js';
import type { Workbench } from './orchestrator.js';
import { renderPage, renderLogin } from './web/pages.js';
import { connectionSecretsSchema, openRunnerLogin, saveConnectionSecrets } from './setup-guide.js';

export interface AppOptions {store:Store;config:AppConfig;engine:Workbench;feishu?:{webhook:(payload:unknown,headers:Record<string,string>)=>Promise<unknown>};launchRunnerLogin?:(runner:Runner)=>Promise<void>}
export function createApp({store,config,engine,feishu,launchRunnerLogin}:AppOptions):Hono {
  const app=new Hono();let loginAttempts:number[]=[];
  app.use('*',async(c,next)=>{
    c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','same-origin');c.header('X-Frame-Options','DENY');
    c.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    c.header('Cache-Control','no-store');await next();
  });
  app.use('*',bodyLimit({maxSize:1_100_000,onError:c=>c.json({error:'内容超过 1 MB，请先拆分资料。'},413)}));
  app.get('/health',c=>c.json({status:'ok',mode:config.mode}));
  app.use('/assets/*',serveStatic({root:fileURLToPath(new URL('../public',import.meta.url)),rewriteRequestPath:path=>path.replace(/^\/assets/,'')}));
  app.post('/webhooks/feishu',async c=>{
    if(!feishu)return c.json({error:'Feishu is not configured.'},503);
    const result=await feishu.webhook(await c.req.json(),Object.fromEntries(c.req.raw.headers));
    return c.json(result??{code:0});
  });
  app.get('/login',c=>c.html(renderLogin()));
  app.post('/login',async c=>{
    const origin=c.req.header('Origin');if(origin&&origin!==new URL(c.req.url).origin)return c.json({error:'来源不匹配。'},403);
    loginAttempts=loginAttempts.filter(at=>at>Date.now()-60000);
    if(loginAttempts.length>=10)return c.html(renderLogin('尝试次数过多，请一分钟后重试。'),429);
    loginAttempts.push(Date.now());const body=await c.req.parseBody();
    if(!config.authToken||!sameSecret(String(body.token??''),config.authToken))return c.html(renderLogin('访问令牌不正确。'),401);
    loginAttempts=[];setCookie(c,'patrick_session',sessionToken(config),{httpOnly:true,sameSite:'Strict',secure:new URL(c.req.url).protocol==='https:',path:'/',maxAge:7*86400});return c.redirect('/',303);
  });
  app.use('*',async(c,next)=>{
    const bearer=c.req.header('Authorization')?.replace(/^Bearer /,'');
    const tokenAuth=!!bearer&&!!config.authToken&&sameSecret(bearer,config.authToken);
    const demo=config.mode!=='live'&&['127.0.0.1','localhost','::1'].includes(config.host);
    if(!demo&&!tokenAuth&&!validSession(getCookie(c,'patrick_session'),config))return c.req.path.startsWith('/api/')?c.json({error:'请先登录。'},401):c.redirect('/login',303);
    if(!['GET','HEAD','OPTIONS'].includes(c.req.method)&&!tokenAuth){
      const origin=c.req.header('Origin'),site=c.req.header('Sec-Fetch-Site');
      if(site==='cross-site'||origin&&origin!==new URL(c.req.url).origin||!demo&&!origin)return c.json({error:'请求来源不匹配，请刷新页面重试。'},403);
    }
    await next();
  });
  app.post('/logout',c=>{deleteCookie(c,'patrick_session',{path:'/'});return c.redirect('/login',303);});
  const body=async(c:any):Promise<Record<string,unknown>>=>c.req.header('Content-Type')?.includes('application/json')?c.req.json():c.req.parseBody();
  const respond=(c:any,data:Record<string,unknown>,redirect:string)=>c.req.header('Accept')?.includes('application/json')?c.json({...data,redirect}):c.redirect(redirect,303);
  const ownedProject=(projectId:string|undefined,domain?:string)=>{
    const project=store.get('projects',projectId??'');
    if(!project||domain!==undefined&&project.domain!==domain)throw new DomainError('Project not found.','not_found',404);
    if(project.ownerId!==config.ownerId)throw new DomainError('Only the current project owner may access this project.','forbidden',403);
    return project;
  };
  const sameProjects=(a:Project[],b:Project[])=>digest([...a].sort((x,y)=>x.id.localeCompare(y.id)))===digest([...b].sort((x,y)=>x.id.localeCompare(y.id)));
  const assertProjects=(before:Project[],after:Project[])=>{if(!sameProjects(before,after))throw new DomainError('Project state changed; retry.','stale_project_state',409);};
  app.post('/api/reference-sources',async c=>{
    const data=z.object({projectId:z.string().min(1),domain:z.string().min(1),externalId:z.string().trim().min(1),revision:z.string().trim().min(1),title:z.string().trim().min(1).max(200),content:z.string().min(1).max(1_000_000).refine(text=>text.trim().length>0,'Reference text is required.'),retention:z.enum(['permanent','ephemeral']),locator:z.string().optional()}).strict().parse(await body(c));
    const project=ownedProject(data.projectId,data.domain);
    engine.ingest({...data,kind:'reading',purpose:'reference',authorId:config.ownerId});
    const source=store.get('sources',stableId('source',{projectId:project.id,domain:project.domain},'reading',data.externalId,data.revision))!;
    const {content,...metadata}=source;
    return c.json({source:metadata});
  });
  app.post('/api/judgments/:id/evidence',async c=>c.json({evidence:recordOutcomeEvidence(store,config,c.req.param('id'),await body(c),config.ownerId)}));
  app.get('/api/reviews',c=>{
    const project=ownedProject(c.req.query('project'),c.req.query('domain')??'');
    return c.json({reviews:outcomeReviewViews(store,project)});
  });
  app.post('/api/reviews/run',async c=>{
    const scope=z.object({projectId:z.string().min(1),domain:z.string().min(1)}).strict().parse(await body(c));
    const project=ownedProject(scope.projectId,scope.domain);
    runOutcomeReviews(store,new Date(),project);
    return c.json({reviews:outcomeReviewViews(store,project)});
  });
  app.get('/api/state',async c=>{
    const requested=c.req.query('project'),project=requested?ownedProject(requested):undefined;
    const projects=project?[project]:store.list('projects').filter(p=>p.ownerId===config.ownerId);
    const billing=await engine.billingStatuses(projects);
    const data=store.readSnapshot(()=>{
      const live=requested?[store.get('projects',requested)].filter((p):p is Project=>!!p&&p.ownerId===config.ownerId):store.list('projects').filter(p=>p.ownerId===config.ownerId);
      assertProjects(projects,live);
      const scopes=new Map(live.map(p=>[p.id,p.domain]));
      const scope=(v:{projectId:string;domain:string})=>scopes.get(v.projectId)===v.domain;
      return {mode:config.mode,projects:live,tasks:store.list('tasks').filter(scope).map(publicTask),questions:store.list('questions').filter(scope),cards:store.list('cards').filter(scope).filter(v=>v.status==='active').flatMap(card=>{const view=knowledgeReference(store,card,card,{usage:'browse'});return view?[view]:[];}),rules:store.list('rules').filter(scope),sources:store.list('sources').filter(scope).map(({content,...v})=>v),events:store.list('events').filter(scope).slice(-100).map(publicEvent),billing,readiness:readiness({...config,projects:live},billing)};
    });
    return c.json(data);
  });
  app.get('/api/tasks/:id',async c=>{const task=store.get('tasks',c.req.param('id'));if(!task||c.req.query('project')&&task.projectId!==c.req.query('project')||c.req.query('domain')&&task.domain!==c.req.query('domain'))return c.json({error:'Task not found.'},404);const project=ownedProject(task.projectId,task.domain),billing=await engine.billingStatuses([project]);return c.json({task:publicTask(task),billing:taskBillingStatus(task,config,billing),question:task.questionId?store.get('questions',task.questionId):undefined,events:store.list('events').filter(e=>e.taskId===task.id).map(publicEvent),attempts:store.list('attempts').filter(a=>a.taskId===task.id).map(publicAttempt),receipt:task.receiptId?store.get('receipts',task.receiptId):undefined});});
  app.get('/api/lookup',c=>{
    const data=store.readSnapshot(()=>{const project=store.get('projects',c.req.query('project')??'');
      if(!project||project.domain!==c.req.query('domain'))return {cards:[]};
      ownedProject(project.id,project.domain);
      return {cards:store.searchCards((c.req.query('q')??'').slice(0,500),project,10)};
    });return c.json(data);
  });
  app.get('/api/reports/weekly',c=>{const project=store.get('projects',c.req.query('project')??'');if(!project||c.req.query('domain')&&project.domain!==c.req.query('domain'))return c.json({error:'Project not found.'},404);ownedProject(project.id,project.domain);return c.json(weeklyReport(store,project));});
  app.post('/api/maintenance',async c=>{
    const data=z.object({projectId:z.string().min(1),domain:z.string().min(1),minutes:z.number().int().min(1).max(1440),note:z.string().max(500).optional(),eventId:z.string().uuid()}).strict().parse(await body(c));
    const project=ownedProject(data.projectId,data.domain);
    const record=recordMaintenance(store,project,{eventId:data.eventId,minutes:data.minutes,note:data.note});
    return c.json({record,report:weeklyReport(store,project)});
  });
  app.get('/api/questions/:id',c=>{const question=store.get('questions',c.req.param('id'));if(!question||c.req.query('project')&&question.projectId!==c.req.query('project')||c.req.query('domain')&&question.domain!==c.req.query('domain'))return c.json({error:'Question not found.'},404);ownedProject(question.projectId,question.domain);return c.json({question});});
  app.post('/api/tasks',async c=>{
    const value=await body(c),data=z.object({projectId:z.string().min(1),domain:z.string().optional(),requestId:z.string().uuid().optional(),title:z.string().trim().min(1).max(200),content:z.string().trim().min(1).max(1_000_000),externalId:z.string().optional(),kind:z.literal('manual').optional()}).strict().parse(value);
    const project=ownedProject(data.projectId,data.domain);
    const externalId=data.requestId?`mcp:${data.requestId}`:data.externalId??`manual:${randomUUID()}`;
    const revision=data.requestId?digest({title:data.title,content:data.content}):undefined;
    if(data.requestId&&store.list('sources').some(source=>source.projectId===project.id&&source.domain===project.domain&&source.kind==='manual'&&store.sourceExternalIdMatches(source,externalId)&&source.revision!==revision))throw new DomainError('Request identity already used for different content.','request_conflict',409);
    try {
      const task=engine.ingest({projectId:data.projectId,title:data.title,content:data.content,kind:'manual',externalId,revision,authorId:config.ownerId,retention:'permanent'});
      return respond(c,{task,message:'资料已接收，PAtrick 会继续处理。'},task?`/tasks/${task.id}`:'/');
    } catch(error) {
      if(error instanceof PrivacyCheckpointError&&data.requestId&&revision){
        const sourceId=stableId('source',{projectId:project.id,domain:project.domain},'manual',externalId,revision),taskId=stableId('task',sourceId),task=store.get('tasks',taskId);
        if(task&&task.projectId===project.id&&task.domain===project.domain)return c.json({error:error.message,code:error.code,committed:true,taskId},503);
      }
      throw error;
    }
  });
  app.post('/api/conversations',async c=>{
    const data=z.object({projectId:z.string(),domain:z.string(),sessionId:z.string().min(1),turnId:z.string().min(1),revision:z.string().min(1),content:z.string().min(1).max(100000),tool:z.enum(['codex','cursor']),retention:z.enum(['permanent','ephemeral'])}).strict().parse(await body(c));
    const project=ownedProject(data.projectId,data.domain);
    const content=data.content.replace(/<patrick-memory>[\s\S]*?<\/patrick-memory>/g,'').trim();
    if(!content)return c.json({recorded:false});
    const task=engine.ingest({projectId:project.id,kind:'conversation',externalId:`${data.tool}:${data.sessionId}:${data.turnId}`,revision:data.revision,title:`${data.tool} · ${data.sessionId.slice(0,40)}`,content,authorId:`tool:${data.tool}`,retention:data.retention,locator:`${data.tool}://${data.sessionId}/${data.turnId}`});
    return c.json({recorded:!!task,task});
  });
  app.post('/api/questions/:id/answer',async c=>{
    const value=await body(c);const answer={...value,questionId:c.req.param('id'),taskVersion:Number(value.taskVersion),questionVersion:Number(value.questionVersion),actorId:config.ownerId,eventId:String(value.eventId??randomUUID())} as QuestionAnswer;
    const question=store.get('questions',answer.questionId);if(!question)throw new DomainError('Question not found.','not_found',404);ownedProject(question.projectId,question.domain);
    const task=engine.answer(answer);return respond(c,{task,message:'已记录你的决定，原任务继续处理。'},`/tasks/${task.id}`);
  });
  const ownedTask=(id:string)=>{const task=store.get('tasks',id);if(!task)throw new DomainError('Task not found.','not_found',404);ownedProject(task.projectId,task.domain);return task;};
  app.post('/api/tasks/:id/retry',c=>{const task=engine.retry(ownedTask(c.req.param('id')).id);return respond(c,{task,message:'已安排重试。'},`/tasks/${task.id}`);});
  app.post('/api/tasks/:id/cancel',c=>{const task=engine.cancel(ownedTask(c.req.param('id')).id);return respond(c,{task,message:'任务已取消。'},`/tasks/${task.id}`);});
  app.post('/api/sources/:id/withdraw',c=>{
    const source=store.get('sources',c.req.param('id'));if(!source)throw new DomainError('Source not found.','not_found',404);
    ownedProject(source.projectId,source.domain);
    engine.withdraw(source.id);return respond(c,{message:'来源已撤回，相关知识与规则已停用。'},`/sources?project=${source.projectId}`);
  });
  app.post('/api/search/rebuild',async c=>{store.rebuildIndex();return respond(c,{message:'已从当前有效资料重建搜索索引。'},'/knowledge');});
  app.post('/api/settings/connections',async c=>{
    const value=await body(c);
    const text=(key:string)=>typeof value[key]==='string'?value[key]:typeof value.feishu==='object'&&value.feishu&&typeof (value.feishu as Record<string,unknown>)[key]==='string'?(value.feishu as Record<string,string>)[key]:undefined;
    const input=connectionSecretsSchema.parse({githubToken:value.githubToken,gitlabToken:value.gitlabToken,researchUrl:value.researchUrl,researchToken:value.researchToken,feishu:{appId:text('feishuAppId')??text('appId'),appSecret:text('feishuAppSecret')??text('appSecret'),ownerOpenId:text('feishuOwnerOpenId')??text('ownerOpenId'),chatId:text('feishuChatId')??text('chatId'),verificationToken:text('feishuVerificationToken')??text('verificationToken'),encryptKey:text('feishuEncryptKey')??text('encryptKey')}});
    saveConnectionSecrets(config,input);
    return respond(c,{saved:true,message:'连接已保存在本机。页面不会显示密钥。'},'/settings#connections');
  });
  app.post('/api/settings/runners/:runner/login',async c=>{
    const runner=z.enum(['grok','codex','dsh']).parse(c.req.param('runner'));
    if(launchRunnerLogin)await launchRunnerLogin(runner);
    else await openRunnerLogin(runner);
    return respond(c,{opened:true,message:'已打开终端。请在那里完成登录，不要把密码填回这个页面。'},'/settings#runners');
  });
  app.post('/api/projects',async c=>{
    const value=await body(c),name=String(value.name??'').trim(),id=stableId('project',name,randomUUID()).slice(0,12);
    const array=(v:unknown)=>Array.isArray(v)?v.map(String):String(v??'').split(/[,\n]/).map(x=>x.trim()).filter(Boolean);
    const interval=value.reviewIntervalDays;
    const reviewIntervalDays=!c.req.header('Content-Type')?.includes('application/json')&&typeof interval==='string'?(interval.trim()?Number(interval):undefined):interval;
    const rawBudget=value.budgetUsd;
    const budgetUsd=rawBudget===undefined||(typeof rawBudget==='string'&&rawBudget.trim()==='')
      ?5
      :typeof rawBudget==='string'
        ?/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(rawBudget.trim())?Number(rawBudget):Number.NaN
        :rawBudget;
    const project=projectSchema.parse({id,projectId:id,name,domain:value.domain||'personal',description:value.description??'',repository:value.repository,repositoryProvider:value.repositoryProvider??'github',prdPath:value.prdPath,allowedPaths:array(value.allowedPaths),trustedChecks:array(value.trustedChecks),trustedAppIds:array(value.trustedAppIds).map(Number),ownerId:config.ownerId,autoMerge:value.autoMerge===true||value.autoMerge==='on',budgetUsd,sourceDir:value.sourceDir||undefined,executionRunner:value.executionRunner??'grok',reviewIntervalDays,createdAt:now()});
    store.save('projects',project);config.projects.push(project);return respond(c,{project,message:'项目已创建。外部连接可在连接设置中核对。'},`/?project=${id}`);
  });
  const pages:Record<string,string>={'/':'workbench','/knowledge':'knowledge','/standards':'standards','/sources':'sources','/activity':'activity','/settings':'settings'};
  for(const [path,page] of Object.entries(pages))app.get(path,async c=>{
    const projects=store.list('projects').filter(p=>p.ownerId===config.ownerId),billing=await engine.billingStatuses(projects);
    if(page!=='knowledge')return c.html(renderPage({page,store,config,url:new URL(c.req.url),projectId:c.req.query('project'),billing,readiness:readiness({...config,projects},billing)}));
    const rendered=store.readSnapshot(()=>{
      const live=store.list('projects').filter(p=>p.ownerId===config.ownerId);assertProjects(projects,live);
      const value=renderPage({page,store,config,url:new URL(c.req.url),projectId:c.req.query('project'),billing,readiness:readiness({...config,projects:live},billing)});
      if(value&&typeof (value as {then?:unknown}).then==='function')throw new Error('Page rendering must be synchronous.');
      return String(value);
    });return c.html(rendered);
  });
  app.get('/tasks/:id',async c=>{if(!store.get('tasks',c.req.param('id')))return c.notFound();return c.html(renderPage({page:'task',store,config,url:new URL(c.req.url),projectId:store.get('tasks',c.req.param('id'))?.projectId,billing:await engine.billingStatuses(store.list('projects').filter(p=>p.ownerId===config.ownerId))}));});
  app.notFound(c=>c.req.path.startsWith('/api/')?c.json({error:'没有找到这个资源。'},404):c.html('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>PAtrick · 404</title><body><h1>没有找到这个页面</h1><a href="/">返回工作台</a></body></html>',404));
  app.onError(async(error,c)=>{
    const privacyFailure=error instanceof PrivacyCheckpointError,syncFailure=error instanceof VaultSyncError,snapshotFailure=isKnowledgeSnapshotFailure(error);
    if(syncFailure||snapshotFailure||error instanceof DomainError&&error.code==='stale_project_state'){
      const code=privacyFailure?'privacy_checkpoint_unavailable':syncFailure?'vault_sync_unavailable':snapshotFailure?'knowledge_snapshot_unavailable':'stale_project_state';
      const safeMessage=privacyFailure?error.message:syncFailure?'Changes may have been saved, but Vault synchronization failed; retry.':snapshotFailure?'Knowledge temporarily unavailable; retry.':'Project state changed; retry.';
      const status=code==='stale_project_state'?409:503;
      if(c.req.header('Accept')?.includes('text/html'))return c.html(`<!doctype html><html><head><meta charset="utf-8"><title>PAtrick</title></head><body><h1>${safeMessage}</h1></body></html>`,status as 400);
      return c.json({error:safeMessage,code,...(privacyFailure?{committed:true}:{})},status as 400);
    }
    const status=error instanceof DomainError?error.status:error instanceof ZodError?400:500;
    const message=error instanceof DomainError?error.message:error instanceof ZodError?error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('；'):'处理暂时失败，请稍后重试。';
    if(status!==403&&c.req.header('Accept')?.includes('text/html')) {
      const questionId=c.req.path.match(/^\/api\/questions\/([^/]+)\/answer$/)?.[1],question=questionId?store.get('questions',questionId):undefined;
      const taskId=question?.taskId??c.req.path.match(/^\/api\/tasks\/([^/]+)\//)?.[1];
      const task=taskId?store.get('tasks',taskId):undefined;
      const target=task?`/tasks/${task.id}`:c.req.path.includes('/projects')?'/settings':c.req.path.includes('/sources')?'/sources':'/';
      return c.html(renderPage({page:task?'task':target==='/settings'?'settings':target==='/sources'?'sources':'workbench',store,config,url:new URL(target,c.req.url),projectId:task?.projectId,notice:message,billing:await engine.billingStatuses(store.list('projects').filter(p=>p.ownerId===config.ownerId))}),status as 400);
    }
    return c.json({error:message,code:error instanceof DomainError?error.code:'invalid_request'},status as 400);
  });
  return app;
}
