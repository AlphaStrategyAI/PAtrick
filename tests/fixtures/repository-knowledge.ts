import { expect } from 'vitest';
import { createHash } from 'node:crypto';
import { GitHubWriter } from '../../src/integrations/github.js';
import { GitLabWriter } from '../../src/integrations/gitlab.js';
import { createRepositoryKnowledgeReader } from '../../src/integrations/repository-knowledge.js';
import { Store } from '../../src/store.js';
import type { AppConfig, Project, SourceRevision } from '../../src/domain.js';
import type { CiTestReportV1, RepositoryReadRequest } from '../../src/knowledge-contract.js';

export const H='b'.repeat(40),H2='c'.repeat(40),blob='d'.repeat(40),time='2026-11-04T12:00:00Z';
export const bytes=Buffer.from('measured bytes\n');
const defaultBytes=bytes;
export const sha256=createHash('sha256').update(bytes).digest('hex');
export const measured={path:'docs/test.ts',sha256,mode:'100644'},reportPath='docs/patrick-test-observation-v1.json';
export function repositoryKnowledgeFixture(provider:'github'|'gitlab'='github',binding?:{store:Store;project:Project;bytes?:Buffer;path?:string;command?:string}){
  const store=binding?.store??new Store(':memory:');
  const bytes=binding?.bytes??defaultBytes,sha256=createHash('sha256').update(bytes).digest('hex');
  const measured={path:binding?.path??'docs/test.ts',sha256,mode:'100644'};
  const project:Project=binding?.project??{id:'p',projectId:'p',domain:'personal',name:'P',description:'',repository:'owner/repo',repositoryProvider:provider,prdPath:'docs/PRD.md',allowedPaths:['docs/'],trustedChecks:['validate'],trustedAppIds:[provider==='github'?15368:731],ownerId:'owner',autoMerge:false,budgetUsd:0,createdAt:''};
  const source:SourceRevision={id:'s',projectId:project.id,domain:project.domain,kind:'manual',externalId:'note',revision:'r1',title:'Read',content:JSON.stringify({schemaVersion:1,kind:'repository-facts',quote:'Requested check',repository:project.repository,headSha:H,changeNumber:17,checks:[{runId:'52',jobId:'71',checkName:'validate'}],testReportPath:reportPath}),locator:'note',authorId:'owner',status:'active',retention:'permanent',createdAt:''};
  if(!store.get('projects',project.id))store.save('projects',project);
  else expect(store.get('projects',project.id)).toEqual(project);
  store.save('sources',source);
  const config={githubToken:'fixture-gh',gitlabUrl:'https://gitlab.test',gitlabToken:'fixture-gl'} as AppConfig;
  const root=provider==='github'?'/repos/owner/repo':'/api/v4/projects/owner%2Frepo';
  const web=provider==='github'?'https://github.com/owner/repo':'https://gitlab.test/owner/repo';
  const routes:Record<string,any>=provider==='github'?{
    '':{id:42,full_name:'owner/repo'},
    '/pulls/17':{number:17,state:'open',merged:false,head:{sha:H2,repo:{id:42,full_name:'owner/repo'}},base:{repo:{id:42,full_name:'owner/repo'}},html_url:web+'/pull/17',updated_at:time},
    [`/commits/${H}`]:{sha:H,commit:{committer:{date:time},tree:{sha:'e'.repeat(40)}}},
    '/actions/runs/52':{id:52,head_sha:H,repository:{id:42,full_name:'owner/repo'},status:'completed',conclusion:'success',html_url:web+'/actions/runs/52',updated_at:time},
    '/actions/runs/52/jobs':{total_count:1,jobs:[{id:71,run_id:52,head_sha:H,name:'validate',status:'completed',conclusion:'success',completed_at:time,check_run_url:'https://api.github.com/repos/owner/repo/check-runs/99',html_url:web+'/actions/runs/52/job/71'}]},
    '/check-runs/99':{id:99,head_sha:H,name:'validate',status:'completed',conclusion:'success',app:{id:15368},completed_at:time,html_url:web+'/runs/99'},
    [`/git/trees/${H}`]:{sha:'e'.repeat(40),truncated:false,tree:[{path:measured.path,mode:'100644',type:'blob',sha:blob}]},
    [`/git/blobs/${blob}`]:{sha:blob,encoding:'base64',size:bytes.length,content:bytes.toString('base64')},
  }:{
    '':{id:42,path_with_namespace:'owner/repo'},
    '/merge_requests/17':{iid:17,project_id:42,source_project_id:42,target_project_id:42,state:'opened',sha:H2,web_url:web+'/-/merge_requests/17',updated_at:time},
    [`/repository/commits/${H}`]:{id:H,committed_date:time},
    '/pipelines/52':{id:52,project_id:42,sha:H,status:'success',source:'merge_request_event',user:{id:731},finished_at:time,web_url:web+'/-/pipelines/52'},
    '/jobs/71':{id:71,project_id:42,name:'validate',status:'success',pipeline:{id:52,project_id:42,sha:H},commit:{id:H},finished_at:time,web_url:web+'/-/jobs/71'},
    '/pipelines/52/jobs':[{id:71,name:'validate',pipeline:{id:52,project_id:42,sha:H},commit:{id:H}}],
    '/repository/tree':[{id:blob,path:measured.path,name:'test.ts',mode:'100644',type:'blob'}],
    [`/repository/files/${encodeURIComponent(measured.path)}`]:{file_path:measured.path,blob_id:blob,commit_id:H,encoding:'base64',size:bytes.length,content_sha256:sha256},
    [`/repository/files/${encodeURIComponent(measured.path)}/raw`]:bytes,
  };
  const report:CiTestReportV1={schemaVersion:1,repository:project.repository,headSha:H,runId:'52',jobId:'71',snapshot:{revision:H,files:[{...measured}]},definitions:[{command:binding?.command??'validate',files:[{...measured}]}],checks:[{id:'gitlab-job:71',name:'validate',command:binding?.command??'validate',testFile:measured.path,result:'success',outputDigest:'a'.repeat(64)}],environment:{observed:{node:'24'},unknown:['browser']}};
  routes[`/jobs/71/artifacts/${reportPath}`]=report;
  const requests:{url:URL;init:RequestInit}[]=[];
  let after:((path:string)=>void)|undefined, override:((path:string,value:any,url:URL)=>Response|undefined)|undefined;
  const fetcher:typeof fetch=async(input,init)=>{
    const url=new URL(String(input)),path=url.pathname.slice(root.length);requests.push({url,init:init!});
    expect(init?.method).toBe('GET');expect(init?.redirect).toBe('error');expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(url.origin).toBe(provider==='github'?'https://api.github.com':'https://gitlab.test');expect(url.username+url.password).toBe('');
    expect(new Headers(init?.headers).get(provider==='github'?'Authorization':'PRIVATE-TOKEN')).toBe(provider==='github'?'Bearer fixture-gh':'fixture-gl');
    const value=routes[path];if(value===undefined)throw new Error('Unexpected fixture route: '+path);
    const response=override?.(path,value,url)??new Response(value instanceof Uint8Array?Uint8Array.from(value).buffer:JSON.stringify(value),{headers:{'content-type':'application/json'}});
    after?.(path);return response;
  };
  const github=new GitHubWriter(store,config,fetcher),gitlab=new GitLabWriter(store,config,fetcher);
  const request:RepositoryReadRequest={repository:project.repository,headSha:H,changeNumber:17,checks:[{runId:'52',jobId:'71',checkName:'validate'}],filePaths:[measured.path]};
  return {close:()=>{if(!binding)store.close();},store,config,fetcher,project,source,request,routes,report,requests,github,gitlab,reader:createRepositoryKnowledgeReader(github,gitlab),setAfter:(f:typeof after)=>{after=f;},setOverride:(f:typeof override)=>{override=f;}};
}
