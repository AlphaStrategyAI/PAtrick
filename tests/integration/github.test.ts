import { afterEach, describe, expect, it } from 'vitest';
import { GitHubWriter } from '../../src/integrations/github.js';
import { Store } from '../../src/store.js';
import { readConfig } from '../../src/config.js';
import { digest, now, type Project, type Task } from '../../src/domain.js';
const BASE='a'.repeat(40),HEAD='b'.repeat(40),MERGE='c'.repeat(40),stores:Store[]=[];
afterEach(()=>stores.splice(0).forEach(store=>store.close()));
function setup(){
  const store=new Store(':memory:');stores.push(store);
  const project:Project={id:'p',projectId:'p',domain:'personal',name:'P',description:'',repository:'owner/repo',repositoryProvider:'github',prdPath:'docs/PRD.md',allowedPaths:['docs/PRD.md'],trustedChecks:['validate'],trustedAppIds:[15368],ownerId:'owner',autoMerge:true,budgetUsd:1,createdAt:now()};
  const task:Task={id:'task',projectId:'p',domain:'personal',sourceId:'source',sourceRevision:'r1',title:'Update PRD',description:'',status:'publishing',stage:'delivery',version:1,attempts:0,repairCount:0,budgetUsd:1,spentUsd:0,createdAt:now(),updatedAt:now(),runAfter:now(),plan:{taskVersion:1,sourceRevision:'r1',baselineSha:BASE,summary:'Plan',paths:[project.prdPath],steps:['Update'],tests:['validate'],stopConditions:['Source changed']}};
  task.artifact={taskVersion:1,planHash:digest(task.plan!),baselineSha:BASE,files:[{path:project.prdPath,content:'Verified PRD\n'}],tests:[{command:'validate',passed:true,output:'ok'}],summary:'PRD update'};
  task.review={taskVersion:1,planHash:digest(task.plan!),artifactHash:digest(task.artifact),verdict:'pass',summary:'Checked independently',issues:[],tests:[{command:'validate',passed:true,output:'ok'}]};
  store.save('projects',project);store.save('sources',{id:'source',projectId:'p',domain:'personal',kind:'manual',externalId:'idea',revision:'r1',title:'Idea',content:'Verified requirement',locator:'note',authorId:'owner',retention:'permanent',status:'active',createdAt:now()});store.save('tasks',task);
  const remote=new FakeGitHub(project,task);return {store,project,task,remote,writer:new GitHubWriter(store,{...readConfig({}),githubToken:'fixture-token'},remote.fetch)};
}
class FakeGitHub{
  baseline=BASE;defaultBranch='main';branch?:string;branchSha=BASE;commitMessage='';pr:any;creates=0;commits=0;merges=0;lost:'ref'|'pr'|'merge'|undefined;
  checkConclusion='success';checkHead=HEAD;checkApp=15368;noChecks=false;mode='100644';readback='Verified PRD\n';headContent='Verified PRD\n';extraFile=false;
  beforeReturn?: (path:string,method:string)=>void;requests:{path:string;method:string}[]=[];
  constructor(private project:Project,private task:Task){}
  fetch:typeof fetch=async(input,init)=>{
    const url=new URL(String(input)),method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):undefined,path=url.pathname.replace('/repos/owner/repo','');this.requests.push({path,method});
    expect(url.origin).toBe('https://api.github.com');expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-token');
    let data:any,status=200;
    if(path==='')data={default_branch:this.defaultBranch};
    else if(path==='/git/ref/heads/main')data={object:{sha:this.baseline}};
    else if(path.startsWith('/git/ref/heads/')){data=this.branch?{object:{sha:this.branchSha}}:{};status=this.branch?200:404;}
    else if(path==='/git/refs'&&method==='POST'){this.branch=body.ref.slice('refs/heads/'.length);this.branchSha=body.sha;data={};}
    else if(path===`/git/commits/${BASE}`)data={tree:{sha:'tree-base'}};
    else if(path===`/git/commits/${HEAD}`)data={message:this.commitMessage,parents:[{sha:BASE}]};
    else if(path==='/git/blobs'){expect(body.content).toBe(this.task.artifact!.files[0]!.content);data={sha:'blob'};}
    else if(path==='/git/trees'&&method==='POST')data={sha:'tree-new'};
    else if(path===`/git/trees/${HEAD}`)data={truncated:false,tree:[{path:this.project.prdPath,type:'blob',mode:this.mode,sha:'blob'}]};
    else if(path==='/git/commits'&&method==='POST'){this.commits++;expect(body.parents).toEqual([BASE]);this.commitMessage=body.message;data={sha:HEAD};}
    else if(path.startsWith('/git/refs/heads/')&&method==='PATCH'){expect(body.force).toBe(false);this.branchSha=body.sha;if(this.lost==='ref'){this.lost=undefined;throw Error('lost ref response');}data={};}
    else if(path==='/pulls'&&method==='GET')data=this.pr&&(!url.searchParams.has('base')||url.searchParams.get('base')===this.pr.base.ref)?[this.pr]:[];
    else if(path==='/pulls'&&method==='POST'){this.creates++;this.pr={number:4,body:body.body,state:'open',html_url:'https://github.com/owner/repo/pull/4',head:{sha:HEAD,repo:{full_name:this.project.repository}},base:{ref:'main',repo:{full_name:this.project.repository}},merged_at:null,merge_commit_sha:null};if(this.lost==='pr'){this.lost=undefined;throw Error('lost PR response');}data=this.pr;}
    else if(path==='/pulls/4'&&method==='GET')data=this.pr;
    else if(path==='/pulls/4/files')data=[{filename:this.project.prdPath,status:'modified'},...(this.extraFile?[{filename:'.github/workflows/ci.yml',status:'modified'}]:[])];
    else if(path===`/commits/${HEAD}/check-runs`)data={check_runs:this.noChecks?[]:[{name:'validate',conclusion:this.checkConclusion,head_sha:this.checkHead,app:{id:this.checkApp},html_url:'https://github.com/owner/repo/actions/runs/5'}]};
    else if(path==='/pulls/4/merge'&&method==='PUT'){expect(body.sha).toBe(HEAD);this.merges++;this.pr={...this.pr,state:'closed',merged_at:now(),merge_commit_sha:MERGE};this.baseline=MERGE;if(this.lost==='merge'){this.lost=undefined;throw Error('lost merge response');}data={merged:true,sha:MERGE};}
    else if(path==='/contents/docs/PRD.md'){const ref=url.searchParams.get('ref');data={type:'file',encoding:'base64',content:Buffer.from(ref===MERGE?this.readback:ref===HEAD?this.headContent:'Original PRD\n').toString('base64')};}
    else throw Error(`Unexpected GitHub request: ${method} ${path}`);
    this.beforeReturn?.(path,method);return Response.json(data,{status});
  };
}
describe('GitHub remote delivery proof and recovery',()=>{
  it('persists one verified receipt after exact CI and merge file readback',async()=>{
    const f=setup(),receipt=await f.writer.deliver(f.task,f.project);expect(receipt.mergeSha).toBe(MERGE);expect(receipt.contentHash).toBe(digest('Verified PRD\n'));expect(f.store.get('receipts',receipt.id)).toEqual(receipt);expect(await f.writer.deliver(f.task,f.project)).toEqual(receipt);expect([f.remote.commits,f.remote.creates,f.remote.merges]).toEqual([1,1,1]);
  });
  it.each(['ref','pr','merge'] as const)('reconciles a lost %s response before retrying external writes',async fault=>{
    const f=setup();f.remote.lost=fault;await expect(f.writer.deliver(f.task,f.project)).rejects.toMatchObject({code:'remote_unavailable'});expect(f.store.list('receipts')).toHaveLength(0);expect((await f.writer.deliver(f.task,f.project)).mergeSha).toBe(MERGE);expect([f.remote.commits,f.remote.creates,f.remote.merges]).toEqual([1,1,1]);
  });
  it.each(['none','skipped','foreign-app','old-head'] as const)('does not merge with %s trusted CI evidence',async fault=>{
    const f=setup();if(fault==='none')f.remote.noChecks=true;if(fault==='skipped')f.remote.checkConclusion='skipped';if(fault==='foreign-app')f.remote.checkApp=999;if(fault==='old-head')f.remote.checkHead=BASE;
    await expect(f.writer.deliver(f.task,f.project)).rejects.toMatchObject({code:'pending_ci'});expect(f.remote.merges).toBe(0);
  });
  it('rejects a retargeted PR after a lost creation response instead of creating a duplicate',async()=>{
    const f=setup();f.remote.lost='pr';await expect(f.writer.deliver(f.task,f.project)).rejects.toThrow();f.remote.pr.base.ref='feature';await expect(f.writer.deliver(f.task,f.project)).rejects.toMatchObject({code:'remote_conflict'});expect(f.remote.creates).toBe(1);expect(f.remote.merges).toBe(0);
  });
  it.each(['mode','extra-file','head-content'] as const)('rejects unchecked remote %s changes',async fault=>{
    const f=setup();if(fault==='mode')f.remote.mode='100755';if(fault==='extra-file')f.remote.extraFile=true;if(fault==='head-content')f.remote.headContent='Other';await expect(f.writer.deliver(f.task,f.project)).rejects.toMatchObject({code:'remote_conflict'});expect(f.remote.merges).toBe(0);
  });
  it('does not issue a receipt for mismatching merged content',async()=>{
    const f=setup();f.remote.readback='Wrong PRD';await expect(f.writer.deliver(f.task,f.project)).rejects.toMatchObject({code:'readback_mismatch'});expect(f.store.list('receipts')).toHaveLength(0);
  });
  it('rechecks the source after an awaited baseline before merging',async()=>{
    const f=setup();let baselineReads=0;f.remote.beforeReturn=(path)=>{if(path==='/git/ref/heads/main'&&++baselineReads===2)f.store.save('sources',{...f.store.get('sources','source')!,status:'withdrawn'});};await expect(f.writer.deliver(f.task,f.project)).rejects.toMatchObject({code:'stale_source'});expect(f.remote.merges).toBe(0);
  });
  it('rechecks the same-version artifact before the first repository mutation',async()=>{
    const f=setup();f.remote.beforeReturn=(path)=>{if(path.startsWith('/git/ref/heads/'))f.store.save('tasks',{...f.task,artifact:{...f.task.artifact!,summary:'Replaced at same version'}});};await expect(f.writer.deliver(f.task,f.project)).rejects.toMatchObject({code:'stale_artifact'});expect(f.remote.creates).toBe(0);
  });
});
