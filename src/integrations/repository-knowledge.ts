import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError, digest, now, pathAllowed, stableId, type AppConfig, type Project, type SourceRevision } from '../domain.js';
import { observedProcessSchema } from '../knowledge-contract.js';
import type { AtomicClaim, CiTestReportV1, HostObservation, ObservedFile, ReadbackProvenance, RepositoryReadback, RepositoryReadRequest, TestObservation } from '../knowledge-contract.js';
import { knowledgePolicyHash, snapshotDigest, testDefinitionDigest } from '../knowledge-identity.js';
import { assertKnowledgeSource, parseKnowledgeJson, parseStructuredKnowledge, structuredRepositoryRequest } from '../structured-knowledge.js';
import { isKnowledgeSnapshotFailure, type Store } from '../store.js';
import { GitHubWriter } from './github.js';
import { GitLabWriter } from './gitlab.js';

export interface RepositoryKnowledgeReader {
  read(project:Project,source:SourceRevision,request:RepositoryReadRequest,signal:AbortSignal):Promise<RepositoryReadback>;
}
type Receipt = {provenance:ReadbackProvenance;readbackHash:string;projectHash:string;assertCurrent:()=>void};
// Internal transport receipts cannot be consumed as authority. Only composition promotes one.
const completedReads=new WeakMap<RepositoryReadback,Receipt>();
const provenance=new WeakMap<RepositoryReadback,Receipt>();
export function createRepositoryKnowledgeReader(github:GitHubWriter,gitlab:GitLabWriter):RepositoryKnowledgeReader {
  if(!(github instanceof GitHubWriter)||!(gitlab instanceof GitLabWriter))throw new DomainError('Concrete authorized repository writers required.','scope',403);
  const githubRead=GitHubWriter.prototype.readKnowledge,gitlabRead=GitLabWriter.prototype.readKnowledge;
  return {async read(project,source,request,signal){
    const p=structuredClone(project),s=structuredClone(source),r=structuredClone(request);
    const readback=project.repositoryProvider==='github'?await githubRead.call(github,p,s,r,signal):await gitlabRead.call(gitlab,p,s,r,signal);
    const receipt=completedReads.get(readback);completedReads.delete(readback);
    if(!receipt||receipt.provenance.sourceHash!==digest(source)||receipt.projectHash!==digest(project)||receipt.provenance.requestHash!==digest(request)||receipt.readbackHash!==digest(readback))throw new DomainError('Repository read lost its source binding.','stale_source',409);
    signal.throwIfAborted();receipt.assertCurrent();provenance.set(readback,receipt);return readback;
  }};
}
export function takeRepositoryReadback(readback:RepositoryReadback,onConsumed?:()=>void):ReadbackProvenance|undefined {
  const receipt=provenance.get(readback);provenance.delete(readback);
  if(!receipt)return undefined;
  // Identity proves only that a handoff was consumed, even if its body was changed.
  // This fact can only deny a later read. It never supplies evidence authority.
  onConsumed?.();
  if(receipt.readbackHash!==digest(readback))return undefined;
  try{receipt.assertCurrent();return structuredClone(receipt.provenance);}catch(error){if(isKnowledgeSnapshotFailure(error))throw error;return undefined;}
}

function invalid(message='Invalid authenticated repository response.'):never {throw new DomainError(message,'remote_invalid',503);}
const sha=z.string().regex(/^[a-f0-9]{40}$/),hash=z.string().regex(/^[a-f0-9]{64}$/),numeric=z.number().int().positive().safe();
const text=z.string().min(1).refine(v=>Buffer.byteLength(v)<=10_000);
const id=z.string().regex(/^[1-9][0-9]*$/).max(32);
const timestamp=z.string().datetime({offset:true});
const optionalTime=timestamp.nullable().optional();
const file=z.object({path:text.refine(v=>Buffer.byteLength(v)<=1024),sha256:hash,mode:z.enum(['100644','100755'])}).strict();
const check=z.object({id:text,name:text.optional(),command:text.optional(),testFile:text.optional(),result:z.enum(['success','failure','incomplete']),outputDigest:hash,
  process:observedProcessSchema.optional()}).strict();
const reportSchema:z.ZodType<CiTestReportV1>=z.object({schemaVersion:z.literal(1),repository:text,headSha:sha,runId:id,jobId:id,
  snapshot:z.object({revision:sha,overlayHash:hash.optional(),files:z.array(file).min(1).max(128)}).strict(),
  definitions:z.array(z.object({command:text,files:z.array(file).min(1).max(128)}).strict()).min(1).max(128),checks:z.array(check).min(1).max(128),
  environment:z.object({observed:z.record(z.string(),text).refine(v=>Object.keys(v).length<=128&&Object.keys(v).every(k=>Buffer.byteLength(k)<=10_000)),unknown:z.array(text).max(128)}).strict(),
}).strict();
function parse<T>(schema:z.ZodType<T>,value:unknown):T {const result=schema.safeParse(value);if(!result.success)invalid();return result.data;}
const binaryHash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function base64(value:string,size:number):Buffer {
  const compact=value.replace(/[\r\n]/g,'');if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact))invalid();
  const bytes=Buffer.from(compact,'base64');if(bytes.length!==size||bytes.toString('base64')!==compact)invalid();return bytes;
}

class ReadSession {
  private aggregate=0;
  private readonly signal:AbortSignal;
  constructor(readonly provider:'github'|'gitlab',private base:string,private token:string,private fetcher:typeof fetch,signal:AbortSignal){
    this.signal=AbortSignal.any([signal,AbortSignal.timeout(30_000)]);
  }
  async bytes(path:string,limit=2_000_000,aggregate=false,missing=false):Promise<Uint8Array|undefined>{
    this.signal.throwIfAborted();const url=new URL(this.base+path),origin=new URL(this.base);
    if(url.protocol!=='https:'||url.origin!==origin.origin||url.username||url.password||url.hash)invalid();
    let response:Response;
    try{response=await this.fetcher(url.href,{method:'GET',redirect:'error',signal:this.signal,headers:this.provider==='github'?{Authorization:`Bearer ${this.token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}:{'PRIVATE-TOKEN':this.token,Accept:'application/json'}});}catch{throw new DomainError('Repository knowledge read interrupted.','remote_unavailable',503);}
    this.signal.throwIfAborted();
    if(response.redirected||(response.url&&new URL(response.url).href!==url.href))invalid();
    if(missing&&response.status===404){await response.body?.cancel();return undefined;}
    if(!response.ok){await response.body?.cancel();throw new DomainError('Repository knowledge read unavailable.',response.status===401||response.status===403?'remote_auth':'remote_unavailable',503);}
    const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit)){await response.body?.cancel();invalid();}
    const chunks:Uint8Array[]=[];let size=0;const reader=response.body?.getReader();
    if(reader)try{for(;;){this.signal.throwIfAborted();const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limit||(aggregate&&this.aggregate+size>2_000_000)){await reader.cancel();invalid();}chunks.push(part.value);}}catch(error){if(error instanceof DomainError)throw error;throw new DomainError('Repository response body interrupted.','remote_unavailable',503);}finally{reader.releaseLock();}
    this.signal.throwIfAborted();if(aggregate)this.aggregate+=size;return Buffer.concat(chunks,size);
  }
  async json(path:string,limit=2_000_000,aggregate=false,missing=false):Promise<any>{const bytes=await this.bytes(path,limit,aggregate,missing);if(bytes===undefined)return undefined;try{return parseKnowledgeJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return invalid();}}
  url(value:string,api=false):string{let url:URL;try{url=new URL(value);}catch{return invalid();}const origin=this.provider==='github'?(api?'https://api.github.com':'https://github.com'):new URL(this.base).origin;if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password||url.search||url.hash)invalid();return url.href;}
  async pages(path:string,key?:string):Promise<any[]>{const all:any[]=[];let total:number|undefined;for(let page=1;page<=100;page++){const data=await this.json(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);const batch=key?data?.[key]:data;if(!Array.isArray(batch)||batch.length>100)invalid();if(key&&data.total_count!==undefined){if(!Number.isSafeInteger(data.total_count)||data.total_count<0||data.total_count>10000||(total!==undefined&&total!==data.total_count))invalid();total=data.total_count;}all.push(...batch);if(batch.length<100){if(total!==undefined&&total!==all.length)invalid();return all;}}return invalid('Repository pagination exceeded its bound.');}
}

function validateRequest(project:Project,source:SourceRevision,request:RepositoryReadRequest):void{
  if(!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(project.repository)||project.repository.split('/').some(p=>p==='.'||p==='..')||(project.repositoryProvider==='github'&&project.repository.split('/').length!==2))invalid();
  if(request.repository!==project.repository||!sha.safeParse(request.headSha).success||request.checks.length>20||request.filePaths.length>128||new Set(request.filePaths).size!==request.filePaths.length)invalid();
  if(request.changeNumber!==undefined&&!numeric.safeParse(request.changeNumber).success)invalid();
  if(new Set(request.checks.map(v=>v.checkName)).size!==request.checks.length||request.checks.some(c=>!id.safeParse(c.runId).success||!id.safeParse(c.jobId).success||!project.trustedChecks.includes(c.checkName)))invalid();
  if(request.filePaths.some(p=>Buffer.byteLength(p)>1024||!pathAllowed(p,project.allowedPaths)))invalid();
  if(request.testReportPath&&(Buffer.byteLength(request.testReportPath)>1024||request.testReportPath.split('/').at(-1)!=='patrick-test-observation-v1.json'||!pathAllowed(request.testReportPath,project.allowedPaths)))invalid();
  // Report locator must actually be authorized by this canonical envelope.
  if(request.testReportPath){let envelope:any;try{envelope=JSON.parse(source.content);}catch{return invalid();}if(envelope.testReportPath!==request.testReportPath)invalid();}
  if(request.current&&(!numeric.safeParse(request.current.changeNumber).success||request.current.checkNames.length>20||new Set(request.current.checkNames).size!==request.current.checkNames.length||request.current.checkNames.some(n=>!project.trustedChecks.includes(n))))invalid();
}
type Execution={head:string;run:string;job:string;name:string;canonicalId:string;producer:string;root:string;url:string;conclusion:'success'|'failure'|'pending'|'cancelled';eventAt?:string;response:object;attestable:boolean};
function ghResult(status:string,conclusion:string|null):Execution['conclusion']{
  if(['queued','in_progress','waiting','requested','pending'].includes(status)&&conclusion===null)return 'pending';
  if(status!=='completed')return invalid();
  if(conclusion==='success'||conclusion==='failure'||conclusion==='cancelled')return conclusion;
  if(['timed_out','action_required','startup_failure'].includes(conclusion??''))return 'failure';
  return invalid('Unsupported GitHub check result.');
}
function glResult(status:string):Execution['conclusion']{if(status==='success')return 'success';if(status==='failed')return 'failure';if(status==='canceled')return 'cancelled';if(['created','pending','preparing','running','waiting_for_resource','scheduled','manual'].includes(status))return 'pending';return invalid('Unsupported GitLab job result.');}

/** Bounded authenticated implementation used only through concrete writers' existing credentials. */
export async function readAuthenticatedRepositoryKnowledge(provider:'github'|'gitlab',store:Store,config:Pick<AppConfig,'githubToken'|'gitlabToken'|'gitlabUrl'>,fetcher:typeof fetch,project:Project,source:SourceRevision,request:RepositoryReadRequest,signal:AbortSignal,githubApi='https://api.github.com'):Promise<RepositoryReadback>{
  signal.throwIfAborted();assertKnowledgeSource(store,source,project);if(project.repositoryProvider!==provider)invalid();validateRequest(project,source,request);
  const parsed=parseStructuredKnowledge(source,project);
  if(parsed){const expected=structuredRepositoryRequest(store,source,project,parsed);
    if(request.headSha!==expected.headSha||request.changeNumber!==expected.changeNumber||digest(request.checks)!==digest(expected.checks)||digest(request.issueSource??{})!==digest(expected.issueSource??{})||(parsed.kind==='experience'&&digest(request.filePaths)!==digest(expected.filePaths)))invalid('Repository request differs from its canonical source envelope.');
  }
  let base=provider==='github'?githubApi:config.gitlabUrl??'';let approved:URL;try{approved=new URL(base);}catch{return invalid();}
  if(approved.protocol!=='https:'||approved.username||approved.password||approved.search||approved.hash||(provider==='github'&&(approved.origin!=='https://api.github.com'||approved.pathname!=='/')))invalid();
  base=approved.href.replace(/\/+$/,'');const token=provider==='github'?config.githubToken:config.gitlabToken;if(!token)throw new DomainError('Repository credentials unavailable.','remote_auth',403);
  const session=new ReadSession(provider,base,token,fetcher,signal),root=provider==='github'?`/repos/${project.repository}`:`/api/v4/projects/${encodeURIComponent(project.repository)}`;
  const repository=provider==='github'?parse(z.object({id:numeric,full_name:text}),await session.json(root)):parse(z.object({id:numeric,path_with_namespace:text}),await session.json(root));
  if(('full_name' in repository?repository.full_name:repository.path_with_namespace)!==project.repository)invalid();
  const repositoryId=repository.id,result:RepositoryReadback={observations:[],files:[],tests:[],gaps:[]};
  const attested:ReadbackProvenance['attestedTests']=[],scope={projectId:project.id,domain:project.domain},observedAt=now();
  const bindingHash=digest({source:digest(source),policy:knowledgePolicyHash(project),request});
  function observe(claim:AtomicClaim,response:object,locator:string,producerId:string,originalEventId:string,eventAt?:string):void{
    const responseDigest=digest(response),observation:HostObservation={...scope,schemaVersion:1,id:stableId('repository-observation',originalEventId,claim,responseDigest,bindingHash),claim,
      origin:{kind:'provider',provider,repository:project.repository,producerId,originalEventId,independentOrigin:`${provider}:${repositoryId}:producer:${producerId}`,derivedFrom:[]},sourceRefs:[{id:source.id,revision:source.revision}],responseDigest,locator,observedAt,bindingHash};
    if(eventAt)observation.eventAt=eventAt;if(!result.observations.some(o=>o.id===observation.id))result.observations.push(observation);
  }
  const subject={provider,repository:project.repository};
  async function change(number:number):Promise<string>{
    if(provider==='github'){
      const pr=parse(z.object({number:numeric,state:z.enum(['open','closed']),merged:z.boolean(),head:z.object({sha,repo:z.object({id:numeric,full_name:text})}),base:z.object({repo:z.object({id:numeric,full_name:text})}),html_url:text,updated_at:optionalTime}),await session.json(`${root}/pulls/${number}`));
      if(pr.number!==number||pr.head.repo.id!==repositoryId||pr.base.repo.id!==repositoryId||pr.head.repo.full_name!==project.repository||pr.base.repo.full_name!==project.repository)invalid();
      observe({kind:'change-head',subject:{...subject,number},value:{headSha:pr.head.sha,state:pr.merged?'merged':pr.state}},pr,session.url(pr.html_url),'repository',`github:${repositoryId}:pull:${number}`,pr.updated_at??undefined);return pr.head.sha;
    }
    const mr=parse(z.object({iid:numeric,project_id:numeric,source_project_id:numeric,target_project_id:numeric,state:z.enum(['opened','closed','merged','locked']),sha,web_url:text,updated_at:optionalTime}),await session.json(`${root}/merge_requests/${number}`));
    if(mr.iid!==number||mr.project_id!==repositoryId||mr.source_project_id!==repositoryId||mr.target_project_id!==repositoryId)invalid();
    observe({kind:'change-head',subject:{...subject,number},value:{headSha:mr.sha,state:mr.state==='opened'||mr.state==='locked'?'open':mr.state}},mr,session.url(mr.web_url),'repository',`gitlab:${repositoryId}:mr:${number}`,mr.updated_at??undefined);return mr.sha;
  }
  let observedHead:string|undefined;if(request.changeNumber!==undefined)observedHead=await change(request.changeNumber);
  if(observedHead&&observedHead!==request.headSha)result.gaps.push('requested_head_differs_from_change_head');
  const commit=provider==='github'?parse(z.object({sha,commit:z.object({committer:z.object({date:optionalTime}).nullable().optional(),tree:z.object({sha}).optional()}).optional()}),await session.json(`${root}/commits/${request.headSha}`)):parse(z.object({id:sha,committed_date:optionalTime}),await session.json(`${root}/repository/commits/${request.headSha}`));
  if(('sha' in commit?commit.sha:commit.id)!==request.headSha)invalid();
  observe({kind:'commit-exists',subject:{...subject,sha:request.headSha},value:{exists:true}},commit,provider==='github'?`https://github.com/${project.repository}/commit/${request.headSha}`:`${base}/${project.repository}/-/commit/${request.headSha}`,'repository',`${provider}:${repositoryId}:commit:${request.headSha}`);

  const ghJob=z.object({id:numeric,run_id:numeric,head_sha:sha,name:text,status:text,conclusion:text.nullable(),completed_at:optionalTime,check_run_url:text,html_url:text});
  const glJob=z.object({id:numeric,project_id:numeric.optional(),name:text,status:text,pipeline:z.object({id:numeric,project_id:numeric,sha}),commit:z.object({id:sha}),finished_at:optionalTime,web_url:text});
  // Exact execution membership includes retained attempts; current selection stays separate below.
  const runCache=new Map<string,any>(),historicalJobsCache=new Map<string,any[]>();
  async function execution(head:string,runId:string,jobId:string,name:string):Promise<Execution>{
    if(provider==='github'){
      let run=runCache.get(runId);if(!run){run=parse(z.object({id:numeric,head_sha:sha,repository:z.object({id:numeric,full_name:text}),status:text,conclusion:text.nullable(),html_url:text,updated_at:optionalTime}),await session.json(`${root}/actions/runs/${runId}`));runCache.set(runId,run);}
      if(String(run.id)!==runId||run.head_sha!==head||run.repository.id!==repositoryId||run.repository.full_name!==project.repository)invalid();session.url(run.html_url);
      let jobs=historicalJobsCache.get(runId);if(!jobs){jobs=(await session.pages(`${root}/actions/runs/${runId}/jobs?filter=all`,'jobs')).map(v=>parse(ghJob,v));historicalJobsCache.set(runId,jobs);}
      if(new Set(jobs.map(j=>j.id)).size!==jobs.length)invalid();const matches=jobs.filter(j=>String(j.id)===jobId);if(matches.length!==1)invalid();const job=matches[0]!;
      if(String(job.run_id)!==runId||job.head_sha!==head||job.name!==name)invalid();
      const relationship=new URL(session.url(job.check_run_url,true));const prefix=`${root}/check-runs/`;const match=relationship.pathname.startsWith(prefix)?relationship.pathname.slice(prefix.length).match(/^([1-9][0-9]*)$/):null;if(!match)invalid();
      const checkId=match[1]!,c=parse(z.object({id:numeric,head_sha:sha,name:text,status:text,conclusion:text.nullable(),app:z.object({id:numeric}),completed_at:optionalTime,html_url:text}),await session.json(`${root}/check-runs/${checkId}`));
      if(String(c.id)!==checkId||c.head_sha!==head||c.name!==name||!project.trustedAppIds.includes(c.app.id))invalid();
      const conclusion=ghResult(c.status,c.conclusion);if(ghResult(job.status,job.conclusion)!==conclusion)invalid();
      return {head,run:runId,job:jobId,name,canonicalId:`github-check-run:${c.id}`,producer:String(c.app.id),root:`github:${repositoryId}:run:${runId}:job:${jobId}`,url:session.url(c.html_url),conclusion,eventAt:c.completed_at??undefined,response:{run,job,check:c},attestable:false};
    }
    let pipeline=runCache.get(runId);if(!pipeline){pipeline=parse(z.object({id:numeric,project_id:numeric,sha,status:text,source:text,user:z.object({id:numeric}).nullable().optional(),finished_at:optionalTime,web_url:text}),await session.json(`${root}/pipelines/${runId}`));runCache.set(runId,pipeline);}
    if(String(pipeline.id)!==runId||pipeline.project_id!==repositoryId||pipeline.sha!==head||!pipeline.user||!project.trustedAppIds.includes(pipeline.user.id))invalid();session.url(pipeline.web_url);
    const job=parse(glJob,await session.json(`${root}/jobs/${jobId}`));
    if(String(job.id)!==jobId||job.name!==name||(job.project_id!==undefined&&job.project_id!==repositoryId)||String(job.pipeline.id)!==runId||job.pipeline.project_id!==repositoryId||job.pipeline.sha!==head||job.commit.id!==head)invalid();
    let jobs=historicalJobsCache.get(runId);if(!jobs){jobs=await session.pages(`${root}/pipelines/${runId}/jobs?include_retried=true`);historicalJobsCache.set(runId,jobs);}
    const members=jobs.filter(j=>String(j.id)===jobId);if(members.length!==1)invalid();const member=parse(z.object({id:numeric,name:text,pipeline:z.object({id:numeric,project_id:numeric,sha}),commit:z.object({id:sha})}),members[0]);
    if(member.name!==name||String(member.pipeline.id)!==runId||member.pipeline.project_id!==repositoryId||member.pipeline.sha!==head||member.commit.id!==head)invalid();
    const conclusion=glResult(job.status);
    return {head,run:runId,job:jobId,name,canonicalId:`gitlab-job:${job.id}`,producer:String(pipeline.user.id),root:`gitlab:${repositoryId}:pipeline:${runId}:job:${jobId}`,url:session.url(job.web_url),conclusion,eventAt:job.finished_at??undefined,response:{pipeline,job},attestable:conclusion==='success'&&pipeline.status==='success'&&pipeline.source==='merge_request_event'&&!!pipeline.finished_at&&!!job.finished_at};
  }

  const fileCache=new Map<string,ObservedFile>();let ghTree:any[]|undefined;
  async function measuredFile(path:string):Promise<ObservedFile>{
    if(!pathAllowed(path,project.allowedPaths)||Buffer.byteLength(path)>1024)invalid();const cached=fileCache.get(path);if(cached)return cached;
    if(fileCache.size>=128)invalid();let bytes:Uint8Array,mode:string;
    if(provider==='github'){
      if(!ghTree){const tree=parse(z.object({sha,truncated:z.literal(false),tree:z.array(z.object({path:text,type:text,mode:text,sha}))}),await session.json(`${root}/git/trees/${request.headSha}?recursive=1`));if(!('commit' in commit)||!commit.commit?.tree||tree.sha!==commit.commit.tree.sha)invalid();ghTree=tree.tree;}
      const entries=ghTree.filter(v=>v.path===path);if(entries.length!==1||entries[0].type!=='blob'||!['100644','100755'].includes(entries[0].mode))invalid();const entry=entries[0];mode=entry.mode;
      const blob=parse(z.object({sha,encoding:z.literal('base64'),size:z.number().int().nonnegative().max(2_000_000),content:z.string()}),await session.json(`${root}/git/blobs/${entry.sha}`,2_000_000,true));if(blob.sha!==entry.sha)invalid();bytes=base64(blob.content,blob.size);
    }else{
      const directory=path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';
      const entries=await session.pages(`${root}/repository/tree?ref=${request.headSha}&path=${encodeURIComponent(directory)}`);const matches=entries.filter(e=>e.path===path);
      if(matches.length!==1)invalid();const entry=parse(z.object({id:sha,path:text,type:z.literal('blob'),mode:z.enum(['100644','100755'])}),matches[0]);mode=entry.mode;
      const metadata=parse(z.object({file_path:text,blob_id:sha,commit_id:sha,encoding:z.literal('base64'),size:z.number().int().nonnegative().max(2_000_000),content_sha256:hash.optional()}),await session.json(`${root}/repository/files/${encodeURIComponent(path)}?ref=${request.headSha}`));
      if(metadata.file_path!==path||metadata.commit_id!==request.headSha||metadata.blob_id!==entry.id)invalid();bytes=(await session.bytes(`${root}/repository/files/${encodeURIComponent(path)}/raw?ref=${request.headSha}`,2_000_000,true))!;
      if(bytes.length!==metadata.size||(metadata.content_sha256&&metadata.content_sha256!==binaryHash(bytes)))invalid();
    }
    const value={path,sha256:binaryHash(bytes),mode};fileCache.set(path,value);return value;
  }
  for(const path of request.filePaths)result.files.push(await measuredFile(path));
  const executions:Execution[]=[];
  function addExecution(e:Execution):TestObservation{
    observe({kind:'ci-result',subject:{...subject,headSha:e.head,runId:e.run,jobId:e.job,checkName:e.name},value:{conclusion:e.conclusion}},e.response,e.url,e.producer,e.root,e.eventAt);
    const observation:TestObservation={...scope,schemaVersion:1,id:'',sourceId:source.id,sourceRevision:source.revision,repository:project.repository,observedAt,
      snapshot:{revision:e.head,files:e.head===request.headSha?[...result.files]:[]},checks:[{id:e.canonicalId,name:e.name,result:e.conclusion==='success'?'success':e.conclusion==='failure'?'failure':'incomplete',outputDigest:digest(e.response)}],environment:{observed:{},unknown:['execution-environment']},
      origin:{kind:'ci',provider,runId:e.run,jobId:e.job,producerId:e.producer,headSha:e.head,url:e.url,responseDigest:digest(e.response)}};
    observation.id=stableId('ci-test',e.root,{...observation,id:undefined,observedAt:undefined});
    const existing=result.tests.find(t=>t.id===observation.id);if(existing)return existing;result.tests.push(observation);return observation;
  }
  for(const check of request.checks){const e=await execution(request.headSha,check.runId,check.jobId,check.checkName);executions.push(e);addExecution(e);}

  if(request.current){
    const head=request.current.changeNumber===request.changeNumber?observedHead!:await change(request.current.changeNumber);
    for(const name of request.current.checkNames){
      let selected:{run:string;job:string}[]=[];
      if(provider==='github'){
        const runs=await session.pages(`${root}/actions/runs?head_sha=${head}`,'workflow_runs');
        for(const value of runs){const run=parse(z.object({id:numeric,head_sha:sha,repository:z.object({id:numeric,full_name:text})}),value);if(run.head_sha!==head||run.repository.id!==repositoryId||run.repository.full_name!==project.repository)invalid();const jobs=await session.pages(`${root}/actions/runs/${run.id}/jobs?filter=latest`,'jobs');selected.push(...jobs.filter(j=>j.name===name&&j.head_sha===head&&j.run_id===run.id).map(j=>({run:String(run.id),job:String(parse(numeric,j.id))})));}
      }else{
        const pipelines=await session.pages(`${root}/merge_requests/${request.current.changeNumber}/pipelines`);
        for(const value of pipelines){const p=parse(z.object({id:numeric,sha}),value);if(p.sha!==head)continue;const jobs=await session.pages(`${root}/pipelines/${p.id}/jobs?include_retried=false`);selected.push(...jobs.filter(j=>j.name===name).map(j=>({run:String(p.id),job:String(parse(numeric,j.id))})));}
      }
      if(selected.length!==1){result.gaps.push(`current_check_identity_unavailable:${name}`);continue;}
      const e=await execution(head,selected[0]!.run,selected[0]!.job,name);addExecution(e);
    }
  }
  if(request.testReportPath){
    let available=false;
    if(provider==='gitlab'&&executions.length===1&&executions[0]!.attestable){const e=executions[0]!;
      try{
        const raw=await session.bytes(`${root}/jobs/${e.job}/artifacts/${request.testReportPath.split('/').map(encodeURIComponent).join('/')}`,512_000,true,true);
        if(raw===undefined)throw new Error('missing');const report=parse(reportSchema,parseKnowledgeJson(new TextDecoder('utf-8',{fatal:true}).decode(raw)));
        if(report.repository!==project.repository||report.headSha!==e.head||report.runId!==e.run||report.jobId!==e.job||report.snapshot.revision!==e.head||(report.snapshot.overlayHash!==undefined&&report.snapshot.overlayHash!==digest({state:'measured',files:[]})))invalid();
        if(new Set(report.snapshot.files.map(f=>f.path)).size!==report.snapshot.files.length||new Set(report.definitions.map(d=>d.command)).size!==report.definitions.length||report.checks.length!==1||report.definitions.length!==1)invalid();
        const c=report.checks[0]!,definition=report.definitions[0]!;
        if(c.id!==e.canonicalId||c.name!==e.name||definition.command!==c.command||c.result!=='success'||!c.testFile||!definition.files.some(f=>f.path===c.testFile)||new Set(definition.files.map(f=>f.path)).size!==definition.files.length)invalid();
        if(c.process&&(c.process.exitCode!==0||c.process.signal!==null||c.process.timedOut||c.process.errorCode!==undefined||c.process.finishedAt<c.process.startedAt))invalid();
        for(const f of [...report.snapshot.files,...definition.files]){if(!request.filePaths.includes(f.path)||digest(await measuredFile(f.path))!==digest(f))invalid();}
        if(report.snapshot.files.length!==request.filePaths.length||definition.files.some(f=>!report.snapshot.files.some(s=>digest(s)===digest(f))))invalid();
        const test=result.tests.find(t=>t.origin.kind==='ci'&&t.origin.runId===e.run&&t.origin.jobId===e.job)!;
        test.snapshot=report.snapshot;test.checks=report.checks;test.environment=report.environment;test.comparable={snapshotDigest:snapshotDigest(report.snapshot),testDefinitionDigest:testDefinitionDigest(report.definitions)};
        test.id=stableId('ci-test',e.root,{...test,id:undefined,observedAt:undefined},binaryHash(raw));
        attested.push({observationId:test.id,producerId:e.producer,originalEventId:e.root,reportPath:request.testReportPath,reportDigest:binaryHash(raw),...test.comparable});available=true;
      }catch{/* Optional attestation failure cannot invent comparable authority or remove ordinary CI. */}
    }
    if(!available)result.gaps.push('comparable_attestation_unavailable');
  }
  if(request.issueSource){const issue=store.get('sources',request.issueSource.id);if(issue&&issue.revision===request.issueSource.revision){try{assertKnowledgeSource(store,issue,project);result.resolution={sourceId:issue.id,revision:issue.revision,quote:issue.content,locator:issue.locator};}catch(error){if(isKnowledgeSnapshotFailure(error))throw error;result.gaps.push('resolution_source_unavailable');}}else result.gaps.push('resolution_source_unavailable');}
  signal.throwIfAborted();assertKnowledgeSource(store,source,project);
  completedReads.set(result,{provenance:{sourceHash:digest(source),policyHash:knowledgePolicyHash(project),requestHash:digest(request),request:structuredClone(request),attestedTests:attested},projectHash:digest(project),readbackHash:digest(result),assertCurrent:()=>assertKnowledgeSource(store,source,project)});
  return result;
}
