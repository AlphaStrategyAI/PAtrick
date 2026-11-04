import { z } from 'zod';
import { DomainError, digest, now, pathAllowed, stableId, type ActionRecord, type AppConfig, type CheckEvidence, type DeliveryReceipt, type DeliveryWriter, type Project, type Task } from '../domain.js';
import type { Store } from '../store.js';
import type { RepositoryReadback, RepositoryReadRequest } from '../knowledge-contract.js';
import type { SourceRevision } from '../domain.js';
import { readAuthenticatedRepositoryKnowledge } from './repository-knowledge.js';
import { validateChecks, validateDelivery } from './github.js';

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/i);
const projectSchema = z.object({id:z.number().int().positive(),path_with_namespace:z.string(),default_branch:z.string().min(1)});
const branchSchema = z.object({name:z.string(),commit:z.object({id:shaSchema})});
const commitSchema = z.object({id:shaSchema,parent_ids:z.array(shaSchema),message:z.string()});
const mrSchema = z.object({
  iid:z.number().int().positive(),project_id:z.number().int().positive(),source_project_id:z.number().int().positive(),target_project_id:z.number().int().positive(),
  source_branch:z.string(),target_branch:z.string(),description:z.string().nullable(),state:z.string(),sha:shaSchema,web_url:z.string().url(),
  merged_at:z.string().nullable().optional(),merge_commit_sha:shaSchema.nullable().optional(),
  diff_refs:z.object({base_sha:shaSchema,start_sha:shaSchema,head_sha:shaSchema}).nullable().optional(),
  head_pipeline:z.object({id:z.number().int().positive(),sha:shaSchema.optional()}).nullable().optional(),
});
const diffSchema = z.object({old_path:z.string(),new_path:z.string(),new_file:z.boolean(),renamed_file:z.boolean(),deleted_file:z.boolean(),a_mode:z.string(),b_mode:z.string()});
const pipelineSummarySchema = z.object({id:z.number().int().positive(),sha:shaSchema,status:z.string()});
const pipelineSchema = pipelineSummarySchema.extend({
  project_id:z.number().int().positive(),source:z.string(),web_url:z.string().url(),
  user:z.object({id:z.number().int().positive()}).nullable().optional(),
});
const jobSchema = z.object({
  id:z.number().int().positive(),name:z.string(),status:z.string(),web_url:z.string().url(),commit:z.object({id:shaSchema}),
  pipeline:z.object({id:z.number().int().positive(),sha:shaSchema,project_id:z.number().int().positive().optional()}),
});
type GitLabProject = z.infer<typeof projectSchema>;
type MergeRequest = z.infer<typeof mrSchema>;

function parse<T>(schema:z.ZodType<T>,value:unknown,label:string):T {
  const result=schema.safeParse(value);
  if(!result.success) throw new DomainError(`GitLab returned invalid ${label}.`,'remote_invalid',503);
  return result.data;
}

export class GitLabWriter implements DeliveryWriter {
  readonly #knowledgeRead:GitLabWriter['readKnowledge'];
  private readonly gitlabUrl:string|undefined;
  private readonly gitlabToken:string|undefined;
  constructor(private store:Store, config:AppConfig, private fetcher:typeof fetch=fetch) {
    this.gitlabUrl=config.gitlabUrl; this.gitlabToken=config.gitlabToken;
    const readConfig={gitlabUrl:config.gitlabUrl,gitlabToken:config.gitlabToken};
    this.#knowledgeRead=(project,source,request,signal)=>readAuthenticatedRepositoryKnowledge('gitlab',store,readConfig,fetcher,project,source,request,signal);
  }

  readKnowledge(project:Project,source:SourceRevision,request:RepositoryReadRequest,signal:AbortSignal):Promise<RepositoryReadback> {
    if(!(#knowledgeRead in this))throw new DomainError('Concrete authorized repository writer required.','scope',403);
    return this.#knowledgeRead(project,source,request,signal);
  }

  private approvedBase():string {
    let url:URL;
    try { url=new URL(this.gitlabUrl??''); }
    catch { throw new DomainError('Set an explicitly approved HTTPS PATRICK_GITLAB_URL for GitLab delivery.','delivery_unready',409); }
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!this.gitlabToken) throw new DomainError('GitLab requires an approved HTTPS base URL and PATRICK_GITLAB_TOKEN.','delivery_unready',409);
    return url.href.replace(/\/+$/,'');
  }

  private root(project:Project):string {
    if(project.repositoryProvider!=='gitlab') throw new DomainError('The GitLab writer cannot handle another repository provider.','scope',403);
    if(!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(project.repository)||project.repository.split('/').some(part=>part==='.'||part==='..')) throw new DomainError('Invalid GitLab project path.','scope',403);
    this.approvedBase();
    return `/api/v4/projects/${encodeURIComponent(project.repository)}`;
  }

  private async request(path:string,method='GET',body?:unknown,missing=false,beforeWrite?:()=>void):Promise<Response|undefined> {
    const url=`${this.approvedBase()}${path}`;
    beforeWrite?.();
    let response:Response;
    try {
      response=await this.fetcher(url,{method,headers:{'PRIVATE-TOKEN':this.gitlabToken!,Accept:'application/json','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30_000)});
    } catch { throw new DomainError('GitLab connection interrupted. Reconcile the persisted action before retrying.','remote_unavailable',503); }
    if(missing&&response.status===404) return undefined;
    if(!response.ok) {
      const auth=response.status===401||response.status===403;
      const conflict=response.status===409||response.status===422;
      throw new DomainError(`GitLab returned ${response.status}; delivery remains pending.`,auth?'remote_auth':conflict?'remote_conflict':'remote_unavailable',auth?403:conflict?409:503);
    }
    return response;
  }

  private async api(path:string,method='GET',body?:unknown,missing=false,beforeWrite?:()=>void):Promise<unknown> {
    const response=await this.request(path,method,body,missing,beforeWrite);
    if(!response) return undefined;
    try { return await response.json(); }
    catch { throw new DomainError('GitLab returned malformed JSON.','remote_invalid',503); }
  }

  private async list<T>(path:string,schema:z.ZodType<T>):Promise<T[]> {
    const values:T[]=[];
    for(let page=1;page<=100;page++) {
      const batch=parse(z.array(schema),await this.api(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`),'paginated response');
      values.push(...batch);
      if(batch.length<100) return values;
    }
    throw new DomainError('GitLab pagination exceeded its bound.','remote_invalid',503);
  }

  private async repository(project:Project):Promise<GitLabProject> {
    const repo=parse(projectSchema,await this.api(this.root(project)),'project');
    if(repo.path_with_namespace!==project.repository) throw new DomainError('GitLab returned another repository.','remote_conflict',409);
    return repo;
  }

  private async branch(project:Project,name:string,missing=false):Promise<z.infer<typeof branchSchema>|undefined> {
    const data=await this.api(`${this.root(project)}/repository/branches/${encodeURIComponent(name)}`,'GET',undefined,missing);
    if(data===undefined) return undefined;
    const result=parse(branchSchema,data,'branch');
    if(result.name!==name) throw new DomainError('GitLab returned another branch.','remote_conflict',409);
    return result;
  }

  async baseline(project:Project):Promise<string> {
    const repo=await this.repository(project);
    return (await this.branch(project,repo.default_branch))!.commit.id;
  }

  private async content(project:Project,path:string,ref:string,missing=false):Promise<string|undefined> {
    if(!pathAllowed(path,project.allowedPaths)) throw new DomainError('Repository read exceeds approved paths.','forbidden_path',403);
    const response=await this.request(`${this.root(project)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,'GET',undefined,missing);
    if(!response) return undefined;
    try { return await response.text(); }
    catch { throw new DomainError('GitLab file read was interrupted.','remote_unavailable',503); }
  }

  async readBaseline(project:Project,sha:string):Promise<{path:string;content:string}[]> {
    this.root(project);
    if(!shaSchema.safeParse(sha).success) throw new DomainError('GitLab baseline must be an immutable commit SHA.','stale_artifact',409);
    // Only an explicit file 404 means that this is the first PRD; authentication and network failures propagate.
    const content=await this.content(project,project.prdPath,sha,true);
    return content===undefined?[]:[{path:project.prdPath,content}];
  }

  private assertCurrent(task:Task,project:Project):void {
    this.root(project);
    const current=this.store.get('tasks',task.id),source=this.store.get('sources',task.sourceId),policy=this.store.get('projects',project.id);
    if(!current||current.version!==task.version||current.stage!=='delivery'||current.stage!==task.stage||!['publishing','retrying'].includes(current.status)||current.sourceId!==task.sourceId||current.sourceRevision!==task.sourceRevision||!source||source.status!=='active'||source.revision!==task.sourceRevision||source.projectId!==project.id||source.domain!==project.domain) throw new DomainError('Task or source changed before GitLab delivery.','stale_source',409);
    if(!policy||digest(policy)!==digest(project)) throw new DomainError('Project authorization changed before GitLab delivery.','scope',403);
    validateDelivery(current,policy);
    if(current.projectId!==task.projectId||current.domain!==task.domain||digest({plan:current.plan,artifact:current.artifact,review:current.review})!==digest({plan:task.plan,artifact:task.artifact,review:task.review})) throw new DomainError('The reviewed GitLab artifact changed.','stale_artifact',409);
    validateDelivery(task,project);
  }

  private async assertBaseline(project:Project,repo:GitLabProject,baseline:string):Promise<void> {
    const latest=await this.repository(project);
    if(latest.id!==repo.id||latest.default_branch!==repo.default_branch||(await this.branch(project,repo.default_branch))!.commit.id!==baseline) throw new DomainError('The GitLab default branch baseline changed; plan and check again.','baseline_changed',409);
  }

  private trustedUrl(value:string):string {
    const url=new URL(value),base=new URL(this.approvedBase());
    if(url.protocol!=='https:'||url.origin!==base.origin||url.username||url.password) throw new DomainError('GitLab returned an unexpected evidence URL.','remote_invalid',503);
    return value;
  }

  private assertMergeRequest(mr:MergeRequest,repo:GitLabProject,branch:string,marker:string,baseline:string):void {
    if(mr.project_id!==repo.id||mr.source_project_id!==repo.id||mr.target_project_id!==repo.id||mr.source_branch!==branch||mr.target_branch!==repo.default_branch||!mr.description?.includes(marker)) throw new DomainError('GitLab MR scope, branch, or action marker changed.','remote_conflict',409);
    this.trustedUrl(mr.web_url);
    if(!mr.diff_refs||mr.diff_refs.head_sha!==mr.sha||mr.diff_refs.base_sha!==baseline||mr.diff_refs.start_sha!==baseline) throw new DomainError('GitLab MR is not based on the reviewed commit.','remote_conflict',409);
  }

  private async mergeRequest(project:Project,iid:number):Promise<MergeRequest> {
    return parse(mrSchema,await this.api(`${this.root(project)}/merge_requests/${iid}`),'merge request');
  }

  private async verifyCommit(project:Project,head:string,baseline:string,id:string):Promise<void> {
    const commit=parse(commitSchema,await this.api(`${this.root(project)}/repository/commits/${encodeURIComponent(head)}`),'commit');
    if(commit.id!==head||commit.parent_ids.length!==1||commit.parent_ids[0]!==baseline||!commit.message.includes(`PAtrick action ${id}`)) throw new DomainError('GitLab branch has an unexpected commit or parent.','remote_conflict',409);
  }

  private async verifyPatch(project:Project,task:Task,mr:MergeRequest,repo:GitLabProject,branch:string,marker:string,id:string):Promise<void> {
    this.assertMergeRequest(mr,repo,branch,marker,task.plan!.baselineSha);
    await this.verifyCommit(project,mr.sha,task.plan!.baselineSha,id);
    const files=await this.list(`${this.root(project)}/merge_requests/${mr.iid}/diffs`,diffSchema),expected=task.artifact!.files;
    if(files.length!==expected.length||new Set(files.map(file=>file.new_path)).size!==files.length||files.some(file=>file.deleted_file||file.renamed_file||file.old_path!==file.new_path||(file.new_file?file.b_mode!=='100644':!['100644','100755'].includes(file.b_mode)||file.a_mode!==file.b_mode)||!expected.some(wanted=>wanted.path===file.new_path))) throw new DomainError('GitLab MR changed beyond the reviewed files.','remote_conflict',409);
    for(const file of expected) if(digest((await this.content(project,file.path,mr.sha))!)!==digest(file.content)) throw new DomainError('GitLab MR head content differs from the reviewed artifact.','remote_conflict',409);
  }

  private async checks(project:Project,mr:MergeRequest,repo:GitLabProject):Promise<CheckEvidence[]> {
    const pipelines=await this.list(`${this.root(project)}/merge_requests/${mr.iid}/pipelines`,pipelineSummarySchema);
    const latest=pipelines.sort((a,b)=>b.id-a.id)[0];
    if(!latest||latest.sha!==mr.sha||latest.status!=='success'||(mr.head_pipeline&&mr.head_pipeline.id!==latest.id)) throw new DomainError('Waiting for the latest successful GitLab MR-head pipeline.','pending_ci',409);
    const pipeline=parse(pipelineSchema,await this.api(`${this.root(project)}/pipelines/${latest.id}`),'pipeline');
    // GitLab has no GitHub App check identity. For GitLab projects trustedAppIds contains
    // approved CI triggering service-account user IDs; CheckEvidence.appId stores pipeline.user.id.
    const userId=pipeline.user?.id;
    if(pipeline.id!==latest.id||pipeline.project_id!==repo.id||pipeline.sha!==mr.sha||pipeline.status!=='success'||pipeline.source!=='merge_request_event'||userId===undefined||!project.trustedAppIds.includes(userId)) throw new DomainError('GitLab CI lacks a trusted triggering service identity at the reviewed head.','pending_ci',409);
    this.trustedUrl(pipeline.web_url);
    const jobs=await this.list(`${this.root(project)}/pipelines/${pipeline.id}/jobs?include_retried=false`,jobSchema);
    const evidence:CheckEvidence[]=[];
    for(const name of project.trustedChecks) {
      const matches=jobs.filter(job=>job.name===name);
      if(!matches.length||matches.some(job=>job.status!=='success'||job.pipeline.id!==pipeline.id||job.pipeline.sha!==mr.sha||job.commit.id!==mr.sha||(job.pipeline.project_id!==undefined&&job.pipeline.project_id!==repo.id))) throw new DomainError(`Waiting for trusted GitLab CI job: ${name}.`,'pending_ci',409);
      evidence.push(...matches.map(job=>({name:job.name,conclusion:job.status,headSha:job.commit.id,appId:userId,url:this.trustedUrl(job.web_url)})));
    }
    validateChecks(evidence,project,mr.sha);
    return evidence;
  }

  async deliver(task:Task,project:Project):Promise<DeliveryReceipt> {
    this.assertCurrent(task,project);
    const root=this.root(project),baseline=task.plan!.baselineSha;
    if(!shaSchema.safeParse(baseline).success) throw new DomainError('GitLab requires a full reviewed baseline SHA.','stale_artifact',409);
    const id=stableId('gitlab',this.approvedBase(),project.domain,project.id,task.id,task.version,digest(task.artifact!));
    const existingReceipt=this.store.get('receipts',id);
    if(existingReceipt) return existingReceipt;
    const repo=await this.repository(project),branch=`patrick/${id}`,marker=`<!-- patrick:${id} -->`;
    const binding={provider:'gitlab',apiBase:this.approvedBase(),repository:project.repository,repositoryId:repo.id,branch,baseBranch:repo.default_branch,baselineSha:baseline,artifactHash:digest(task.artifact!)};
    let action=this.store.get('actions',id);
    if(action) {
      if(action.projectId!==project.id||action.domain!==project.domain||action.taskId!==task.id||action.kind!=='repository_delivery'||Object.entries(binding).some(([key,value])=>action!.payload[key]!==value)) throw new DomainError('The persisted GitLab action no longer matches this delivery.','remote_conflict',409);
    } else {
      action={id,projectId:project.id,domain:project.domain,taskId:task.id,kind:'repository_delivery',status:'pending',payload:binding,updatedAt:now()};
      this.store.save('actions',action);
    }
    // Reconcile by source branch across every target so a retargeted MR cannot disappear and be duplicated.
    const candidates=await this.list(`${root}/merge_requests?state=all&source_branch=${encodeURIComponent(branch)}`,mrSchema);
    if(candidates.length>1||candidates.some(candidate=>candidate.source_branch!==branch||candidate.target_branch!==repo.default_branch||!candidate.description?.includes(marker))) throw new DomainError('The GitLab delivery branch belongs to another or ambiguous merge request.','remote_conflict',409);
    let mr=candidates[0];
    if(mr) mr=await this.mergeRequest(project,mr.iid);
    if(!mr||mr.state!=='merged') {
      await this.assertBaseline(project,repo,baseline);
      if(!mr) {
        let ref=await this.branch(project,branch,true);
        if(!ref) {
          const actions=[];
          for(const file of task.artifact!.files) actions.push({action:(await this.content(project,file.path,baseline,true))===undefined?'create':'update',file_path:file.path,content:file.content,encoding:'text'});
          const commit=parse(commitSchema,await this.api(`${root}/repository/commits`,'POST',{branch,start_sha:baseline,force:false,commit_message:`docs: ${task.title}\n\nPAtrick action ${id}`,actions},false,()=>this.assertCurrent(task,project)),'created commit');
          ref={name:branch,commit:{id:commit.id}};
        }
        await this.verifyCommit(project,ref.commit.id,baseline,id);
        action.payload.headSha=ref.commit.id; action.updatedAt=now(); this.store.save('actions',action);
        await this.assertBaseline(project,repo,baseline);
        const created=parse(mrSchema,await this.api(`${root}/merge_requests`,'POST',{source_branch:branch,target_branch:repo.default_branch,title:`[PAtrick] ${task.title}`,description:`${task.artifact!.summary}\n\nSource revision: \`${task.sourceRevision}\`\nPlan: \`${digest(task.plan!)}\`\n\n${marker}`,remove_source_branch:false,squash:false},false,()=>this.assertCurrent(task,project)),'created merge request');
        mr=await this.mergeRequest(project,created.iid);
      }
      if(mr.state!=='opened') throw new DomainError('The GitLab delivery MR was closed without merging.','remote_conflict',409);
      await this.verifyPatch(project,task,mr,repo,branch,marker,id);
      await this.checks(project,mr,repo);
      const checkedHead=mr.sha;
      await this.assertBaseline(project,repo,baseline);
      await this.checks(project,mr,repo);
      const latest=await this.mergeRequest(project,mr.iid);
      this.assertMergeRequest(latest,repo,branch,marker,baseline);
      if(latest.state!=='opened'||latest.sha!==checkedHead) throw new DomainError('GitLab MR changed after CI verification.','remote_conflict',409);
      const merged=parse(mrSchema,await this.api(`${root}/merge_requests/${mr.iid}/merge`,'PUT',{sha:checkedHead,auto_merge:false,squash:false,should_remove_source_branch:false},false,()=>this.assertCurrent(task,project)),'merge result');
      if(merged.state!=='merged'||!merged.merged_at||!merged.merge_commit_sha) throw new DomainError('GitLab did not confirm a completed merge.','merge_unconfirmed',409);
      mr=await this.mergeRequest(project,mr.iid);
      if(mr.sha!==checkedHead||mr.merge_commit_sha!==merged.merge_commit_sha) throw new DomainError('GitLab merged a different head or commit.','remote_conflict',409);
    }
    if(mr.state!=='merged'||!mr.merged_at||!mr.merge_commit_sha) throw new DomainError('A completed GitLab merge is required.','merge_unconfirmed',409);
    const latestRepo=await this.repository(project);
    if(latestRepo.id!==repo.id||latestRepo.default_branch!==repo.default_branch) throw new DomainError('GitLab default branch authorization changed.','baseline_changed',409);
    await this.verifyPatch(project,task,mr,repo,branch,marker,id);
    const checks=await this.checks(project,mr,repo);
    let prdContent:string|undefined;
    for(const file of task.artifact!.files) {
      const content=(await this.content(project,file.path,mr.merge_commit_sha))!;
      if(digest(content)!==digest(file.content)) throw new DomainError('Merged GitLab file readback does not match the reviewed artifact.','readback_mismatch',409);
      if(file.path===project.prdPath) prdContent=content;
    }
    this.assertCurrent(task,project);
    const receipt:DeliveryReceipt={id,projectId:project.id,domain:project.domain,taskId:task.id,repository:project.repository,path:project.prdPath,pullRequestUrl:this.trustedUrl(mr.web_url),pullRequestNumber:mr.iid,headSha:mr.sha,mergeSha:mr.merge_commit_sha,contentHash:digest(prdContent!),verifiedAt:now(),checks};
    this.store.transaction(()=>{this.store.save('receipts',receipt);this.store.save('actions',{...action!,status:'completed',payload:{...action!.payload,receiptId:id},updatedAt:now()} satisfies ActionRecord);});
    return receipt;
  }
}
