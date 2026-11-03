import { DomainError, digest, now, pathAllowed, stableId, type ActionRecord, type AppConfig, type CheckEvidence, type DeliveryReceipt, type DeliveryWriter, type Project, type Task } from '../domain.js';
import type { Store } from '../store.js';

export function validateDelivery(task: Task, project: Project): void {
  const { plan, artifact, review } = task;
  if (!project.autoMerge) throw new DomainError('Automatic merging is not enabled for this project.', 'delivery_unready',409);
  if (task.projectId !== project.id || task.domain !== project.domain) throw new DomainError('Repository scope changed.', 'scope',403);
  if (!plan || !artifact || !review || review.verdict !== 'pass') throw new DomainError('A complete plan, artifact and passing independent review are required.', 'review_required',409);
  if (plan.taskVersion!==task.version || artifact.taskVersion!==task.version || review.taskVersion!==task.version || plan.sourceRevision!==task.sourceRevision || artifact.baselineSha!==plan.baselineSha || artifact.planHash!==digest(plan) || review.planHash!==digest(plan) || review.artifactHash!==digest(artifact)) throw new DomainError('The checked artifact is stale. Replan and check the current version.', 'stale_artifact',409);
  if (!artifact.tests.length || !review.tests.length || [...artifact.tests,...review.tests].some(t=>!t.passed)) throw new DomainError('Execution and independent review must both include successful tests.', 'tests_failed',409);
  if (!artifact.files.length || new Set(artifact.files.map(f=>f.path)).size!==artifact.files.length || !artifact.files.some(f=>f.path===project.prdPath)) throw new DomainError('Delivery must contain one unambiguous PRD update.', 'invalid_patch',409);
  for (const file of artifact.files) if (!pathAllowed(file.path,project.allowedPaths) || !plan.paths.includes(file.path)) throw new DomainError('The patch exceeds the approved paths.', 'forbidden_path',403);
  if (!project.trustedChecks.length || !project.trustedAppIds.length) throw new DomainError('Configure named required checks and their trusted app IDs.', 'ci_unconfigured',409);
}

export function validateChecks(checks: CheckEvidence[], project: Project, headSha: string): void {
  if (!project.trustedChecks.length || !project.trustedAppIds.length) throw new DomainError('Required CI is not configured.', 'ci_unconfigured',409);
  for (const name of project.trustedChecks) {
    const matching=checks.filter(c=>c.name===name && c.headSha===headSha && project.trustedAppIds.includes(c.appId));
    if (!matching.length || matching.some(c=>c.conclusion!=='success')) throw new DomainError(`Waiting for trusted CI: ${name}.`, 'pending_ci',409);
  }
}

type Json = Record<string, any>;
export class GitHubWriter implements DeliveryWriter {
  constructor(private store: Store, private config: AppConfig, private fetcher: typeof fetch = fetch, private apiUrl='https://api.github.com') {}

  private async api(path:string, method='GET', body?:unknown, missing=false):Promise<any> {
    if (!this.config.githubToken) throw new DomainError('Set PATRICK_GITHUB_TOKEN for repository delivery.', 'delivery_unready',409);
    let response:Response;
    try { response=await this.fetcher(`${this.apiUrl}${path}`,{method,headers:{Authorization:`Bearer ${this.config.githubToken}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)}); }
    catch { throw new DomainError('GitHub connection interrupted. The persisted action will be reconciled before retry.', 'remote_unavailable',503); }
    if (missing && response.status===404) return undefined;
    if (!response.ok) throw new DomainError(`GitHub returned ${response.status}; the action remains pending.`, response.status===401||response.status===403?'remote_auth':'remote_unavailable',response.status===401||response.status===403?403:503);
    if (response.status===204) return {};
    return response.json();
  }
  private root(project:Project) { if(project.repositoryProvider!=='github')throw new DomainError('This writer only accepts GitHub projects.','provider_mismatch',403);return `/repos/${project.repository}`; }
  private async repo(project:Project):Promise<Json> { return this.api(this.root(project)); }
  async baseline(project:Project):Promise<string> {
    const repo=await this.repo(project);
    const ref=await this.api(`${this.root(project)}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
    if (typeof ref.object?.sha!=='string') throw new DomainError('GitHub did not return a baseline commit.','remote_invalid',503);
    return ref.object.sha;
  }
  async readBaseline(project:Project,sha:string):Promise<{path:string;content:string}[]> {
    const path=project.prdPath.split('/').map(encodeURIComponent).join('/');
    const data=await this.api(`${this.root(project)}/contents/${path}?ref=${encodeURIComponent(sha)}`,'GET',undefined,true);
    if(data===undefined)return [];
    if(data.encoding!=='base64'||typeof data.content!=='string'||data.type!=='file')throw new DomainError('Invalid baseline file response.','remote_invalid',503);
    return [{path:project.prdPath,content:Buffer.from(data.content,'base64').toString('utf8')}];
  }
  private assertCurrent(task:Task,project:Project):void {
    const current=this.store.get('tasks',task.id), source=this.store.get('sources',task.sourceId), policy=this.store.get('projects',project.id);
    if (!current || current.version!==task.version || current.status==='cancelled' || !source || source.status!=='active' || source.revision!==task.sourceRevision) throw new DomainError('Task or source changed before delivery.','stale_source',409);
    if(current.stage!=='delivery'||current.status!=='publishing'||digest(current.plan??{})!==digest(task.plan??{})||digest(current.artifact??{})!==digest(task.artifact??{})||digest(current.review??{})!==digest(task.review??{}))throw new DomainError('The current checked artifact changed before delivery.','stale_artifact',409);
    if (!policy || digest(policy)!==digest(project)) throw new DomainError('Project authorization changed before delivery.','scope',403);
    validateDelivery(current,policy);
  }
  private async checks(project:Project,head:string):Promise<CheckEvidence[]> {
    const all:CheckEvidence[]=[];
    for (let page=1;page<=100;page++) {
      const data=await this.api(`${this.root(project)}/commits/${head}/check-runs?per_page=100&page=${page}&filter=latest`);
      if (!Array.isArray(data.check_runs)) throw new DomainError('Invalid CI response.','remote_invalid',503);
      all.push(...data.check_runs.map((c:Json)=>({name:String(c.name),conclusion:String(c.conclusion??'pending'),headSha:String(c.head_sha),appId:Number(c.app?.id),url:String(c.html_url??'')})));
      if (data.check_runs.length<100) return all;
    }
    throw new DomainError('CI pagination exceeded its bound.','remote_invalid',503);
  }
  private async content(project:Project,path:string,ref:string):Promise<string> {
    const data=await this.api(`${this.root(project)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
    if (data.encoding!=='base64' || typeof data.content!=='string' || data.type!=='file') throw new DomainError('Repository file could not be read back.','remote_invalid',503);
    return Buffer.from(data.content,'base64').toString('utf8');
  }
  private async verifyPatch(project:Project,task:Task,pr:Json,expectedBase:string):Promise<void> {
    if (typeof pr.head?.sha!=='string' || pr.base?.ref!==expectedBase || pr.base?.repo?.full_name?.toLowerCase()!==project.repository.toLowerCase() || pr.head?.repo?.full_name?.toLowerCase()!==project.repository.toLowerCase()) throw new DomainError('Unexpected PR repository or target branch.','remote_conflict',409);
    const files:Json[]=[];
    for (let page=1;page<=30;page++) {
      const batch=await this.api(`${this.root(project)}/pulls/${pr.number}/files?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new DomainError('Invalid PR file list.','remote_invalid',503);
      files.push(...batch); if (batch.length<100) break;
    }
    const expected=task.artifact!.files;
    if (files.length!==expected.length || files.some(f=>!expected.some(e=>e.path===f.filename)||f.status==='removed'||f.status==='renamed')) throw new DomainError('The remote PR changed beyond the checked artifact.','remote_conflict',409);
    const tree=await this.api(`${this.root(project)}/git/trees/${pr.head.sha}?recursive=1`);
    if(tree.truncated||!Array.isArray(tree.tree)||expected.some(file=>!tree.tree.some((entry:Json)=>entry.path===file.path&&entry.type==='blob'&&entry.mode==='100644')))throw new DomainError('The remote file mode or tree differs from the checked artifact.','remote_conflict',409);
    for (const file of expected) if (digest(await this.content(project,file.path,pr.head.sha))!==digest(file.content)) throw new DomainError('The remote PR content no longer matches the checked artifact.','remote_conflict',409);
  }
  async deliver(task:Task,project:Project):Promise<DeliveryReceipt> {
    this.assertCurrent(task,project);
    const root=this.root(project), id=stableId(project.domain,project.id,task.id,task.version,digest(task.artifact!));
    const existingReceipt=this.store.get('receipts',id);
    if (existingReceipt) return existingReceipt;
    const branch=`patrick/${task.id.slice(0,12)}-v${task.version}-${id.slice(0,8)}`;
    let action=this.store.get('actions',id);
    if (!action) { action={id,projectId:project.id,domain:project.domain,taskId:task.id,kind:'repository_delivery',status:'pending',payload:{branch},updatedAt:now()}; this.store.save('actions',action); }
    const repo=await this.repo(project), base=String(repo.default_branch);
    const candidates=await this.api(`${root}/pulls?state=all&head=${encodeURIComponent(project.repository.split('/')[0]+':'+branch)}&per_page=100`);
    if (!Array.isArray(candidates)) throw new DomainError('Invalid PR reconciliation response.','remote_invalid',503);
    let pr:Json|undefined=candidates.find((p:Json)=>String(p.body??'').includes(`<!-- patrick:${id} -->`));
    if (candidates.length && !pr) throw new DomainError('Branch already belongs to another change.','remote_conflict',409);
    if (!pr?.merged_at) {
      if (await this.baseline(project)!==task.plan!.baselineSha) throw new DomainError('The repository baseline changed; planning must run again.','baseline_changed',409);
      if (!pr) {
        let ref=await this.api(`${root}/git/ref/heads/${encodeURIComponent(branch)}`,'GET',undefined,true);
        if (!ref) { this.assertCurrent(task,project); await this.api(`${root}/git/refs`,'POST',{ref:`refs/heads/${branch}`,sha:task.plan!.baselineSha}); ref={object:{sha:task.plan!.baselineSha}}; }
        if (ref.object?.sha===task.plan!.baselineSha) {
          const baseline=await this.api(`${root}/git/commits/${task.plan!.baselineSha}`);
          const tree=[];
          for (const file of task.artifact!.files) {
            const blob=await this.api(`${root}/git/blobs`,'POST',{content:file.content,encoding:'utf-8'});
            tree.push({path:file.path,mode:'100644',type:'blob',sha:blob.sha});
          }
          const newTree=await this.api(`${root}/git/trees`,'POST',{base_tree:baseline.tree.sha,tree});
          const commit=await this.api(`${root}/git/commits`,'POST',{message:`docs: ${task.title}\n\nPAtrick action ${id}`,tree:newTree.sha,parents:[task.plan!.baselineSha]});
          this.assertCurrent(task,project);
          await this.api(`${root}/git/refs/heads/${encodeURIComponent(branch)}`,'PATCH',{sha:commit.sha,force:false});
          action.payload.headSha=commit.sha;this.store.save('actions',action);
        } else {
          const commit=await this.api(`${root}/git/commits/${ref.object?.sha}`);
          if (!String(commit.message).includes(`PAtrick action ${id}`)) throw new DomainError('Unexpected branch commit; refusing to overwrite.','remote_conflict',409);
          action.payload.headSha=ref.object.sha;this.store.save('actions',action);
        }
        this.assertCurrent(task,project);
        pr=await this.api(`${root}/pulls`,'POST',{title:`[PAtrick] ${task.title}`,head:branch,base,body:`${task.artifact!.summary}\n\nSource revision: \`${task.sourceRevision}\`\nPlan: \`${digest(task.plan!)}\`\n\n<!-- patrick:${id} -->`});
      }
      if (!pr) throw new DomainError('PR creation was not confirmed.','remote_unavailable',503);
      const opened:Json=await this.api(`${root}/pulls/${pr.number}`);pr=opened;
      if (opened.state!=='open') throw new DomainError('The delivery PR was closed without merging.','remote_conflict',409);
      await this.verifyPatch(project,task,opened,base);
      const checks=await this.checks(project,opened.head.sha);validateChecks(checks,project,opened.head.sha);
      this.assertCurrent(task,project);
      if (await this.baseline(project)!==task.plan!.baselineSha) throw new DomainError('The baseline changed before merge.','baseline_changed',409);
      if((await this.repo(project)).default_branch!==base)throw new DomainError('The default target branch changed before merge.','baseline_changed',409);
      const finalPr:Json=await this.api(`${root}/pulls/${opened.number}`);
      if(finalPr.base?.ref!==base||finalPr.head?.sha!==opened.head.sha)throw new DomainError('The PR head or target branch changed before merge.','remote_conflict',409);
      validateChecks(await this.checks(project,opened.head.sha),project,opened.head.sha);
      this.assertCurrent(task,project);
      const merged=await this.api(`${root}/pulls/${opened.number}/merge`,'PUT',{sha:opened.head.sha,merge_method:'squash'});
      if (!merged.merged) throw new DomainError('GitHub did not confirm the merge.','merge_unconfirmed',409);
      pr=await this.api(`${root}/pulls/${opened.number}`);
    }
    if (!pr?.merged_at || !pr.merge_commit_sha) throw new DomainError('A verified merge is required.','merge_unconfirmed',409);
    await this.verifyPatch(project,task,pr,base);
    const checks=await this.checks(project,pr.head.sha);validateChecks(checks,project,pr.head.sha);
    const actual=await this.content(project,project.prdPath,pr.merge_commit_sha);
    const wanted=task.artifact!.files.find(f=>f.path===project.prdPath)!;
    if (digest(actual)!==digest(wanted.content)) throw new DomainError('Merged PRD readback does not match the checked change.','readback_mismatch',409);
    const receipt:DeliveryReceipt={id,projectId:project.id,domain:project.domain,taskId:task.id,repository:project.repository,path:project.prdPath,pullRequestUrl:pr.html_url,pullRequestNumber:pr.number,headSha:pr.head.sha,mergeSha:pr.merge_commit_sha,contentHash:digest(actual),verifiedAt:now(),checks:checks.filter(c=>project.trustedChecks.includes(c.name)&&project.trustedAppIds.includes(c.appId))};
    this.store.transaction(()=>{this.store.save('receipts',receipt);this.store.save('actions',{...action!,status:'completed',payload:{...action!.payload,receiptId:id},updatedAt:now()});});
    return receipt;
  }
}
