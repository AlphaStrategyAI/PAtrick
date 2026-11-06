import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, type AppConfig, type Project, type SourceRevision, type Task } from '../../src/domain.js';
import { Store } from '../../src/store.js';
import { GitLabWriter } from '../../src/integrations/gitlab.js';

const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), MERGE = 'c'.repeat(40);
const roots: string[] = [], stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('knowledge read rejects changed project authorization before delivery transport',async()=>{
  const s=setup();s.store.save('projects',{...s.project,ownerId:'another-owner'});
  await expect(s.writer.readKnowledge(s.project,s.source,{repository:s.project.repository,headSha:HEAD,checks:[],filePaths:[]},new AbortController().signal)).rejects.toMatchObject({code:'scope'});
  expect(s.remote.requests).toEqual([]);expect(s.store.list('actions')).toEqual([]);
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'patrick-gitlab-')); roots.push(directory);
  const store = new Store(join(directory, 'db.sqlite')); stores.push(store);
  const project: Project = { id:'p', projectId:'p', domain:'company', name:'Internal', description:'', repository:'group/team/product', repositoryProvider:'gitlab', prdPath:'docs/PRD.md', allowedPaths:['docs/'], trustedChecks:['validate'], trustedAppIds:[731], ownerId:'owner', autoMerge:true, budgetUsd:5, createdAt:'' };
  const source: SourceRevision = { id:'s', projectId:'p', domain:'company', kind:'file', externalId:'idea.md', revision:'r1', title:'Idea', content:'A verified requirement', locator:'idea.md', authorId:'owner', retention:'permanent', status:'active', createdAt:'' };
  const task: Task = { id:'t', projectId:'p', domain:'company', sourceId:source.id, sourceRevision:source.revision, title:'Update requirements', description:'', status:'publishing', stage:'delivery', version:1, attempts:0, repairCount:0, budgetUsd:5, spentUsd:0, createdAt:'', updatedAt:'', runAfter:'', plan:{taskVersion:1,sourceRevision:source.revision,baselineSha:BASE,summary:'Update PRD',paths:['docs/PRD.md'],steps:['Update'],tests:['validate'],stopConditions:['Source changed']} };
  task.artifact = {taskVersion:1,planHash:digest(task.plan!),baselineSha:BASE,files:[{path:'docs/PRD.md',content:'Reviewed requirements\n'}],tests:[{command:'validate',passed:true,output:'ok'}],summary:'Checked requirement'};
  task.review = {taskVersion:1,planHash:digest(task.plan!),artifactHash:digest(task.artifact),verdict:'pass',summary:'Independent check',issues:[],tests:[{command:'validate',passed:true,output:'ok'}]};
  store.save('projects',project); store.save('sources',source); store.save('tasks',task);
  const config: AppConfig = {mode:'test',host:'127.0.0.1',port:0,dataDir:directory,vaultDir:join(directory,'vault'),ownerId:'owner',authToken:'test',sessionSecret:'test',projects:[project],runnerPolicies:[],workers:{},scanIntervalMs:1000,gitlabUrl:'https://gitlab.company.test',gitlabToken:'company-token',githubToken:'personal-token'};
  const remote = new FakeGitLab(project, task);
  return {store,project,source,task,config,remote,writer: new GitLabWriter(store,config,remote.fetch)};
}

class FakeGitLab {
  requests: {method:string; url:URL; body:Record<string,unknown>|undefined; init:RequestInit|undefined}[] = [];
  branch?: string; message = ''; mr?: Record<string, unknown>;
  baseline = BASE; defaultBranch = 'main'; commitPosts = 0; mrPosts = 0; mergePuts = 0;
  loseCommit = false; loseMr = false; loseMerge = false;
  pipelineStatus = 'success'; pipelineSha = HEAD; pipelineUser: number | undefined = 731;
  jobs: Record<string, unknown>[] = [{id:70,name:'validate',status:'success',web_url:'https://gitlab.company.test/group/team/product/-/jobs/70',pipeline:{id:9,sha:HEAD,project_id:42},commit:{id:HEAD}}];
  extraDiff = false; executableDiff = false; mismatchedHead = false; mismatchedReadback = false; unmarkedMr = false; absentPrd = false;
  rawStatus = 200;
  pipelines?: {id:number;sha:string;status:string}[];
  afterRequest?: (path:string,method:string) => void;
  constructor(private project:Project, private task:Task) {}
  private response(value:unknown,status=200):Response { return Response.json(value,{status}); }
  fetch: typeof fetch = async (input,init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string,unknown> : undefined;
    this.requests.push({method,url,body,init});
    expect(url.origin).toBe('https://gitlab.company.test');
    expect(new Headers(init?.headers).get('PRIVATE-TOKEN')).toBe('company-token');
    expect(init?.redirect).toBe('error');
    const root = `/api/v4/projects/${encodeURIComponent(this.project.repository)}`;
    expect(url.pathname.startsWith(root)).toBe(true);
    const path = url.pathname.slice(root.length);
    let result: Response;
    if (path === '' && method==='GET') result=this.response({id:42,path_with_namespace:this.project.repository,default_branch:this.defaultBranch});
    else if (path.startsWith('/repository/branches/') && method==='GET') {
      const branch=decodeURIComponent(path.slice('/repository/branches/'.length));
      result=branch==='main' ? this.response({name:'main',commit:{id:this.baseline}}) : this.branch===branch ? this.response({name:branch,commit:{id:HEAD}}) : this.response({message:'404'},404);
    } else if (path === '/repository/commits' && method==='POST') {
      this.commitPosts++; expect(body?.start_sha).toBe(BASE); expect(body?.force).toBe(false);
      expect(body?.actions).toEqual([{action:this.absentPrd?'create':'update',file_path:'docs/PRD.md',content:this.task.artifact!.files[0]!.content,encoding:'text'}]);
      this.branch=String(body?.branch); this.message=String(body?.commit_message);
      if (this.loseCommit) { this.loseCommit=false; throw new Error('Response lost after commit'); }
      result=this.response({id:HEAD,parent_ids:[BASE],message:this.message},201);
    } else if (path===`/repository/commits/${HEAD}` && method==='GET') result=this.response({id:HEAD,parent_ids:[BASE],message:this.message});
    else if (path==='/merge_requests' && method==='GET') result=this.response(this.mr&&(!url.searchParams.has('target_branch')||url.searchParams.get('target_branch')===this.mr.target_branch) ? [{...this.mr,description:this.unmarkedMr?'foreign change':this.mr.description}] : []);
    else if (path==='/merge_requests' && method==='POST') {
      this.mrPosts++; expect(body?.source_branch).toBe(this.branch); expect(body?.target_branch).toBe('main');
      this.mr={iid:4,project_id:42,source_project_id:42,target_project_id:42,source_branch:this.branch,target_branch:'main',description:body?.description,state:'opened',sha:HEAD,web_url:'https://gitlab.company.test/group/team/product/-/merge_requests/4',merged_at:null,merge_commit_sha:null,diff_refs:{base_sha:BASE,start_sha:BASE,head_sha:HEAD},head_pipeline:{id:9,sha:HEAD}};
      if(this.loseMr) { this.loseMr=false; throw new Error('Response lost after MR create'); }
      result=this.response(this.mr,201);
    } else if (path==='/merge_requests/4' && method==='GET') result=this.response(this.mr);
    else if (path==='/merge_requests/4/diffs' && method==='GET') result=this.response([{old_path:'docs/PRD.md',new_path:'docs/PRD.md',new_file:false,renamed_file:false,deleted_file:false,a_mode:'100644',b_mode:this.executableDiff?'100755':'100644'},...(this.extraDiff?[{old_path:'.gitlab-ci.yml',new_path:'.gitlab-ci.yml',new_file:false,renamed_file:false,deleted_file:false,a_mode:'100644',b_mode:'100644'}]:[])]);
    else if (path==='/merge_requests/4/pipelines' && method==='GET') result=this.response(this.pipelines??[{id:9,sha:this.pipelineSha,status:this.pipelineStatus}]);
    else if (path==='/pipelines/9' && method==='GET') result=this.response({id:9,project_id:42,sha:this.pipelineSha,status:this.pipelineStatus,source:'merge_request_event',user:this.pipelineUser===undefined?null:{id:this.pipelineUser},web_url:'https://gitlab.company.test/group/team/product/-/pipelines/9'});
    else if (path==='/pipelines/9/jobs' && method==='GET') result=this.response(this.jobs);
    else if (path==='/merge_requests/4/merge' && method==='PUT') {
      this.mergePuts++; expect(body?.sha).toBe(HEAD); expect(body?.auto_merge).toBe(false);
      this.mr={...this.mr,state:'merged',merged_at:'2026-11-03T01:00:00Z',merge_commit_sha:MERGE}; this.baseline=MERGE;
      if(this.loseMerge) { this.loseMerge=false; throw new Error('Response lost after merge'); }
      result=this.response(this.mr);
    } else if (path===`/repository/files/${encodeURIComponent('docs/PRD.md')}/raw` && method==='GET') {
      const ref=url.searchParams.get('ref');
      result=this.rawStatus!==200?this.response({message:'Read failed'},this.rawStatus):ref===BASE&&this.absentPrd ? this.response({message:'404'},404) : new Response(ref===BASE?'Original requirements\n':(ref===MERGE&&this.mismatchedReadback)||(ref===HEAD&&this.mismatchedHead)?'Unexpected requirements\n':this.task.artifact!.files[0]!.content);
    } else throw new Error(`Unexpected GitLab request ${method} ${path}${url.search}`);
    this.afterRequest?.(path,method); return result;
  };
}

describe('GitLab delivery adapter', () => {
  it('reads the explicit GitLab default-branch SHA and PRD at that immutable SHA', async () => {
    const s=setup(); expect(await s.writer.baseline(s.project)).toBe(BASE);
    expect(await s.writer.readBaseline(s.project,BASE)).toEqual([{path:'docs/PRD.md',content:'Original requirements\n'}]);
  });
  it('returns an absent baseline only for a confirmed file 404 and can create the first PRD', async () => {
    const s=setup(); s.remote.absentPrd=true;
    expect(await s.writer.readBaseline(s.project,BASE)).toEqual([]);
    expect((await s.writer.deliver(s.task,s.project)).mergeSha).toBe(MERGE);
  });
  it.each([403,503])('does not treat a %s file read as an absent PRD', async status => {
    const s=setup(); s.remote.rawStatus=status;
    await expect(s.writer.readBaseline(s.project,BASE)).rejects.toMatchObject({code:status===403?'remote_auth':'remote_unavailable'});
  });
  it('commits against the reviewed baseline, proves trusted named MR-head CI, merges, and persists a verified receipt', async () => {
    const s=setup(), receipt=await s.writer.deliver(s.task,s.project);
    expect(receipt).toMatchObject({repository:s.project.repository,path:s.project.prdPath,pullRequestNumber:4,headSha:HEAD,mergeSha:MERGE,contentHash:digest(s.task.artifact!.files[0]!.content),checks:[{name:'validate',conclusion:'success',headSha:HEAD,appId:731}]});
    expect(s.store.get('receipts',receipt.id)).toEqual(receipt); expect(s.store.get('actions',receipt.id)?.status).toBe('completed');
    expect(await s.writer.deliver(s.task,s.project)).toEqual(receipt);
    expect([s.remote.commitPosts,s.remote.mrPosts,s.remote.mergePuts]).toEqual([1,1,1]);
  });
  it.each(['loseCommit','loseMr','loseMerge'] as const)('reconciles %s without repeating committed side effects', async fault => {
    const s=setup(); s.remote[fault]=true;
    await expect(s.writer.deliver(s.task,s.project)).rejects.toMatchObject({code:'remote_unavailable'});
    expect(s.store.list('actions')).toHaveLength(1); expect(s.store.list('receipts')).toHaveLength(0);
    const receipt=await s.writer.deliver(s.task,s.project); expect(receipt.mergeSha).toBe(MERGE);
    expect([s.remote.commitPosts,s.remote.mrPosts,s.remote.mergePuts]).toEqual([1,1,1]);
  });
  it.each([undefined,'http://gitlab.company.test','https://user:secret@gitlab.company.test','https://gitlab.company.test?next=https://other.test'])('rejects unsafe or missing approved GitLab base %s before network', async gitlabUrl => {
    const s=setup(); const writer=new GitLabWriter(s.store,{...s.config,gitlabUrl},s.remote.fetch);
    await expect(writer.baseline(s.project)).rejects.toMatchObject({code:'delivery_unready'}); expect(s.remote.requests).toHaveLength(0);
  });
  it('requires GitLab credentials and rejects a GitHub project before network', async () => {
    const s=setup();
    await expect(new GitLabWriter(s.store,{...s.config,gitlabToken:undefined},s.remote.fetch).baseline(s.project)).rejects.toMatchObject({code:'delivery_unready'});
    await expect(s.writer.baseline({...s.project,repositoryProvider:'github'})).rejects.toMatchObject({code:'scope'});
    await expect(s.writer.deliver(s.task,{...s.project,repositoryProvider:'github'})).rejects.toMatchObject({code:'scope'});
    expect(s.remote.requests).toHaveLength(0);
  });
  it.each(['none','skipped','untrusted','unattested','wrong-head','failed-pipeline','wrong-job-head','wrong-pipeline'] as const)('rejects %s CI without merging', async fault => {
    const s=setup();
    if(fault==='none') s.remote.jobs=[];
    if(fault==='skipped') s.remote.jobs[0]!.status='skipped';
    if(fault==='untrusted') s.remote.pipelineUser=999;
    if(fault==='unattested') s.remote.pipelineUser=undefined;
    if(fault==='wrong-head') s.remote.pipelineSha=BASE;
    if(fault==='failed-pipeline') s.remote.pipelineStatus='failed';
    if(fault==='wrong-job-head') s.remote.jobs[0]!.commit={id:BASE};
    if(fault==='wrong-pipeline') s.remote.jobs[0]!.pipeline={id:8,sha:HEAD,project_id:42};
    await expect(s.writer.deliver(s.task,s.project)).rejects.toMatchObject({code:'pending_ci'});
    expect(s.remote.mergePuts).toBe(0); expect(s.store.list('receipts')).toHaveLength(0);
  });
  it.each(['extraDiff','mismatchedHead','executableDiff'] as const)('rejects remote %s outside the reviewed patch', async fault => {
    const s=setup(); s.remote[fault]=true;
    await expect(s.writer.deliver(s.task,s.project)).rejects.toMatchObject({code:'remote_conflict'}); expect(s.remote.mergePuts).toBe(0);
  });
  it('rejects an MR without its persisted marker on retry', async () => {
    const s=setup(); s.remote.loseMr=true;
    await expect(s.writer.deliver(s.task,s.project)).rejects.toMatchObject({code:'remote_unavailable'});
    s.remote.unmarkedMr=true;
    await expect(s.writer.deliver(s.task,s.project)).rejects.toMatchObject({code:'remote_conflict'}); expect(s.remote.mrPosts).toBe(1); expect(s.remote.mergePuts).toBe(0);
  });
  it('finds and rejects a retargeted MR after a lost create response instead of opening a duplicate', async () => {
    const s=setup(); s.remote.loseMr=true;
    await expect(s.writer.deliver(s.task,s.project)).rejects.toMatchObject({code:'remote_unavailable'});
    s.remote.mr!.target_branch='feature';
    await expect(s.writer.deliver(s.task,s.project)).rejects.toMatchObject({code:'remote_conflict'});
    expect(s.remote.mrPosts).toBe(1); expect(s.remote.mergePuts).toBe(0);
  });
  it('does not issue a receipt when the merged PRD readback differs', async () => {
    const s=setup(); s.remote.mismatchedReadback=true;
    await expect(s.writer.deliver(s.task,s.project)).rejects.toMatchObject({code:'readback_mismatch'});
    expect(s.remote.mergePuts).toBe(1); expect(s.store.list('receipts')).toHaveLength(0); expect(s.store.list('actions')[0]?.status).toBe('pending');
  });
  it('blocks a changed baseline before creating remote state', async () => {
    const s=setup(); s.remote.baseline=MERGE;
    await expect(s.writer.deliver(s.task,s.project)).rejects.toMatchObject({code:'baseline_changed'});
    expect([s.remote.commitPosts,s.remote.mrPosts,s.remote.mergePuts]).toEqual([0,0,0]);
  });
  it.each(['source','policy','artifact'] as const)('rechecks %s after reads and immediately before the first remote mutation', async fault => {
    const s=setup(); s.remote.afterRequest=(path) => {
      if(!path.endsWith('/raw')) return;
      if(fault==='source') s.store.save('sources',{...s.source,status:'withdrawn'});
      if(fault==='policy') s.store.save('projects',{...s.project,autoMerge:false});
      if(fault==='artifact') s.store.save('tasks',{...s.task,artifact:{...s.task.artifact!,summary:'Changed at the same version'}});
    };
    await expect(s.writer.deliver(s.task,s.project)).rejects.toMatchObject({code:fault==='policy'?'scope':fault==='artifact'?'stale_artifact':'stale_source'});
    expect(s.remote.commitPosts).toBe(0);
  });
  it('blocks a permission change during final baseline read before merge', async () => {
    const s=setup(); s.remote.afterRequest=(path) => {if(path==='/repository/branches/main'&&s.remote.mr) s.store.save('projects',{...s.project,autoMerge:false});};
    await expect(s.writer.deliver(s.task,s.project)).rejects.toMatchObject({code:'scope'}); expect(s.remote.mergePuts).toBe(0);
  });
  it.each(['target','default'] as const)('blocks a changed %s branch even when the reviewed head SHA is unchanged', async fault => {
    const s=setup(); s.remote.afterRequest=(path) => {
      if(path!=='/pipelines/9/jobs') return;
      if(fault==='target') s.remote.mr!.target_branch='feature'; else s.remote.defaultBranch='feature';
    };
    await expect(s.writer.deliver(s.task,s.project)).rejects.toMatchObject({code:fault==='target'?'remote_conflict':'baseline_changed'}); expect(s.remote.mergePuts).toBe(0);
  });
  it('rechecks CI when a failed pipeline replaces success during the final baseline read', async () => {
    const s=setup(); s.remote.afterRequest=(path) => { if(path==='/repository/branches/main'&&s.remote.mr) s.remote.pipelineStatus='failed'; };
    await expect(s.writer.deliver(s.task,s.project)).rejects.toMatchObject({code:'pending_ci'}); expect(s.remote.mergePuts).toBe(0);
  });
  it('requires the newest MR pipeline, even when an older pipeline succeeded at the reviewed head', async () => {
    const s=setup(); s.remote.pipelines=[{id:9,sha:HEAD,status:'success'},{id:10,sha:BASE,status:'success'}];
    await expect(s.writer.deliver(s.task,s.project)).rejects.toMatchObject({code:'pending_ci'}); expect(s.remote.mergePuts).toBe(0);
  });
  it('does not continue publishing if the task moves back to another stage at the same version', async () => {
    const s=setup(); s.remote.afterRequest=(path) => { if(path.endsWith('/raw')) s.store.save('tasks',{...s.task,stage:'check',status:'checking'}); };
    await expect(s.writer.deliver(s.task,s.project)).rejects.toMatchObject({code:'stale_source'}); expect(s.remote.commitPosts).toBe(0);
  });
});
