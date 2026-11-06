import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { GitHubWriter } from '../../src/integrations/github.js';
import { GitLabWriter } from '../../src/integrations/gitlab.js';
import { createRepositoryKnowledgeReader, takeRepositoryReadback } from '../../src/integrations/repository-knowledge.js';
import { snapshotDigest, testDefinitionDigest } from '../../src/knowledge-identity.js';
import { parseStructuredKnowledge, structuredRepositoryRequest } from '../../src/structured-knowledge.js';
import { Store } from '../../src/store.js';
import type { AppConfig, Project, SourceRevision } from '../../src/domain.js';
import type { CiTestReportV1, RepositoryReadRequest } from '../../src/knowledge-contract.js';

import { repositoryKnowledgeFixture, H, H2, blob, time, bytes, sha256, measured, reportPath } from '../fixtures/repository-knowledge.js';
const stores:Store[]=[];afterEach(()=>stores.splice(0).forEach(s=>s.close()));
function setup(provider:'github'|'gitlab'='github'){const s=repositoryKnowledgeFixture(provider);stores.push(s.store);return s;}

function retainedRetry(s:ReturnType<typeof setup>,provider:'github'|'gitlab') {
  s.request.current={changeNumber:17,checkNames:['validate']};
  const path=provider==='github'?'/actions/runs/52/jobs':'/pipelines/52/jobs';
  const old=provider==='github'?s.routes[path].jobs[0]:s.routes[path][0];
  const latest={...structuredClone(old),id:72};
  if(provider==='github'){
    s.routes['/pulls/17'].head.sha=H;
    latest.check_run_url='https://api.github.com/repos/owner/repo/check-runs/100';
    s.routes['/check-runs/100']={...s.routes['/check-runs/99'],id:100};
    s.routes['/actions/runs']={total_count:1,workflow_runs:[{id:52,head_sha:H,repository:{id:42,full_name:'owner/repo'}}]};
  }else{
    s.routes['/merge_requests/17'].sha=H;
    s.routes['/merge_requests/17/pipelines']=[{id:52,sha:H}];
    s.routes['/jobs/72']={...structuredClone(s.routes['/jobs/71']),id:72};
  }
  const retained=[old,latest];
  s.setOverride((p,_value,url)=>{
    if(p!==path)return undefined;
    const all=provider==='github'?url.searchParams.get('filter')==='all':url.searchParams.get('include_retried')==='true';
    const jobs=all?retained:[latest];
    return new Response(JSON.stringify(provider==='github'?{total_count:jobs.length,jobs}:jobs));
  });
  return {old,retained,path};
}

describe('G2 complete findings regressions',()=>{
  it.each((['github','gitlab'] as const).flatMap(provider=>(['prototype','instance-prototype','shallow-copy'] as const).map(kind=>({provider,kind}))))('refuses constructor-forged $provider $kind before supplied fetch',async({provider,kind})=>{
    const s=setup(provider),genuine=provider==='github'?s.github:s.gitlab;
    const forged=Object.assign(Object.create(kind==='instance-prototype'?genuine:Object.getPrototypeOf(genuine)),kind==='shallow-copy'?{...genuine}:{},
      {store:s.store,config:s.config,fetcher:s.fetcher,apiUrl:'https://api.github.com',gitlabUrl:s.config.gitlabUrl,gitlabToken:s.config.gitlabToken});
    expect(forged instanceof (provider==='github'?GitHubWriter:GitLabWriter)).toBe(true);
    const receipt=await (async()=>{
      try{const reader=createRepositoryKnowledgeReader(provider==='github'?forged:s.github,provider==='gitlab'?forged:s.gitlab);return takeRepositoryReadback(await reader.read(s.project,s.source,s.request,new AbortController().signal));}
      catch{return undefined;}
    })();
    expect(s.requests).toHaveLength(0);expect(receipt).toBeUndefined();
  });
  it.each(['github','gitlab'] as const)('uses constructor-private %s read dependencies despite ordinary property tampering',async provider=>{
    const s=setup(provider),writer=provider==='github'?s.github:s.gitlab;let replacementCalls=0;
    Object.assign(writer,{fetcher:async(...args:Parameters<typeof fetch>)=>{replacementCalls++;return s.fetcher(...args);}});
    const r=await s.reader.read(s.project,s.source,s.request,new AbortController().signal);
    expect(replacementCalls).toBe(0);expect(s.requests.length).toBeGreaterThan(0);expect(takeRepositoryReadback(r)).toBeDefined();
    const foreign=new Store(':memory:');stores.push(foreign);
    Object.assign(writer,{store:foreign,config:{githubToken:'tampered'},apiUrl:'https://foreign.test',gitlabUrl:'https://foreign.test',gitlabToken:'tampered'});
    s.config.githubToken='tampered';s.config.gitlabUrl='https://foreign.test';s.config.gitlabToken='tampered';
    const next=await s.reader.read(s.project,s.source,s.request,new AbortController().signal);
    expect(replacementCalls).toBe(0);expect(takeRepositoryReadback(next)).toBeDefined();expect(takeRepositoryReadback(next)).toBeUndefined();
  });
  it.each(['github','gitlab'] as const)('retains exact historical %s job71 after same-run retry72 while current selects72',async provider=>{
    const s=setup(provider),retry=retainedRetry(s,provider);
    const read=s.reader.read(s.project,s.source,s.request,new AbortController().signal);
    await expect(read).resolves.toMatchObject({observations:expect.any(Array)});const r=await read;
    const claims=r.observations.filter(o=>o.claim.kind==='ci-result').map(o=>o.claim);
    expect(claims).toEqual([expect.objectContaining({subject:expect.objectContaining({headSha:H,runId:'52',jobId:'71'})}),expect.objectContaining({subject:expect.objectContaining({headSha:H,runId:'52',jobId:'72'})})]);
    const queries=s.requests.filter(r=>r.url.pathname.endsWith(retry.path)).map(r=>r.url.searchParams);
    expect(queries.some(q=>provider==='github'?q.get('filter')==='all':q.get('include_retried')==='true')).toBe(true);
    expect(queries.some(q=>provider==='github'?q.get('filter')==='latest':q.get('include_retried')==='false')).toBe(true);
    expect(takeRepositoryReadback(r)).toBeDefined();
  });
  it.each((['github','gitlab'] as const).flatMap(provider=>(['missing','foreign','head','producer'] as const).map(kind=>({provider,kind}))))('rejects $provider retained history $kind mismatch without substituting retry72',async({provider,kind})=>{
    const s=setup(provider),retry=retainedRetry(s,provider);
    if(kind==='missing')retry.retained.shift();
    if(provider==='github'){
      if(kind==='foreign')retry.old.run_id=53;if(kind==='head')retry.old.head_sha=H2;if(kind==='producer')s.routes['/check-runs/99'].app.id=999;
    }else{
      if(kind==='foreign')retry.old.pipeline={...retry.old.pipeline,project_id:99};if(kind==='head')retry.old.commit={id:H2};if(kind==='producer')s.routes['/pipelines/52'].user.id=999;
    }
    await expect(s.reader.read(s.project,s.source,s.request,new AbortController().signal)).rejects.toBeDefined();
  });
  it('accepts real Store diamond ancestry and revalidates the shared ancestor before consumption',async()=>{
    const s=setup();s.source.parentSources=[{id:'a',revision:'r1'},{id:'b',revision:'r1'}];s.store.save('sources',s.source);
    for(const id of ['a','b','x'])s.store.save('sources',{...s.source,id,content:id,parentSources:id==='x'?[]:[{id:'x',revision:'r1'}]});
    expect(()=>structuredRepositoryRequest(s.store,s.source,s.project,parseStructuredKnowledge(s.source,s.project)!)).not.toThrow();
    const r=await s.reader.read(s.project,s.source,s.request,new AbortController().signal);expect(r.observations).toHaveLength(3);
    s.store.save('sources',{...s.store.get('sources','x')!,status:'withdrawn'});expect(takeRepositoryReadback(r)).toBeUndefined();
  });
  it.each(['cycle','missing','stale','scope','withdrawn'])('rejects real Store %s ancestry before provider fetch',async kind=>{
    const s=setup();s.source.parentSources=[{id:'a',revision:'r1'},{id:'b',revision:'r1'}];s.store.save('sources',s.source);
    for(const id of ['a','b','x'])s.store.save('sources',{...s.source,id,content:id,parentSources:id==='x'?[]:[{id:'x',revision:'r1'}]});
    const x=s.store.get('sources','x')!;
    if(kind==='cycle')x.parentSources=[{id:'a',revision:'r1'}];if(kind==='missing')x.parentSources=[{id:'absent',revision:'r1'}];if(kind==='stale')x.revision='r2';if(kind==='scope')x.domain='company';if(kind==='withdrawn')x.status='withdrawn';s.store.save('sources',x);
    await expect(s.reader.read(s.project,s.source,s.request,new AbortController().signal)).rejects.toMatchObject({code:'stale_source'});expect(s.requests).toHaveLength(0);
  });
  it.each(['valid','definition','name','id'])('keeps job selector distinct from the actual measured command: %s',async kind=>{
    const s=setup('gitlab'),path='tests/regression.test.ts',command='npm test -- tests/regression.test.ts';
    const content=Buffer.from("import { expect, it } from 'vitest';\nit('regression',()=>expect(2+2).toBe(4));\n");
    const file={path,sha256:createHash('sha256').update(content).digest('hex'),mode:'100644'};
    s.project.allowedPaths.push('tests/');s.store.save('projects',s.project);s.request.filePaths=[path];s.request.testReportPath=reportPath;
    s.routes['/repository/tree']=[{id:blob,path,name:'regression.test.ts',mode:'100644',type:'blob'}];
    s.routes[`/repository/files/${encodeURIComponent(path)}`]={file_path:path,blob_id:blob,commit_id:H,encoding:'base64',size:content.length,content_sha256:file.sha256};
    s.routes[`/repository/files/${encodeURIComponent(path)}/raw`]=content;
    s.report.snapshot.files=[file];s.report.definitions=[{command,files:[file]}];s.report.checks[0]!.command=command;s.report.checks[0]!.testFile=path;
    if(kind==='definition')s.report.definitions[0]!.command='npm test -- foreign.test.ts';if(kind==='name')s.report.checks[0]!.name='foreign';if(kind==='id')s.report.checks[0]!.id='gitlab-job:72';
    const r=await s.reader.read(s.project,s.source,s.request,new AbortController().signal),receipt=takeRepositoryReadback(r);
    expect(r.observations[2]?.claim).toMatchObject({subject:{jobId:'71',checkName:'validate'},value:{conclusion:'success'}});
    if(kind==='valid'){
      expect(r.files).toEqual([file]);expect(r.tests[0]?.checks[0]).toMatchObject({id:'gitlab-job:71',name:'validate',command});
      expect(r.tests[0]?.comparable).toEqual({snapshotDigest:snapshotDigest(s.report.snapshot),testDefinitionDigest:testDefinitionDigest(s.report.definitions)});
      expect(receipt?.attestedTests).toHaveLength(1);expect(r.gaps).not.toContain('comparable_attestation_unavailable');
    }else{expect(r.tests[0]?.comparable).toBeUndefined();expect(receipt?.attestedTests).toEqual([]);expect(r.gaps).toContain('comparable_attestation_unavailable');}
  });
});
describe('actual authenticated repository knowledge readers',()=>{
  it.each(['github','gitlab'] as const)('reads exact immutable %s execution, bytes and moved change independently',async provider=>{
    const s=setup(provider),r=await s.reader.read(s.project,s.source,s.request,new AbortController().signal);
    expect(r.observations.map(o=>o.claim.kind)).toEqual(['change-head','commit-exists','ci-result']);
    expect(r.observations[0]?.claim).toMatchObject({value:{headSha:H2,state:'open'}});
    expect(r.observations[2]?.claim).toMatchObject({subject:{headSha:H,runId:'52',jobId:'71',checkName:'validate'},value:{conclusion:'success'}});
    expect(r.files).toEqual([measured]);expect(r.tests[0]?.checks[0]?.id).toBe(provider==='github'?'github-check-run:99':'gitlab-job:71');
    expect(r.tests[0]?.comparable).toBeUndefined();expect(r.observations[2]?.eventAt).toBe(time);
    expect(r.gaps).toContain('requested_head_differs_from_change_head');
    const copy=structuredClone(r);expect(takeRepositoryReadback(copy)).toBeUndefined();expect(takeRepositoryReadback(r)).toMatchObject({attestedTests:[]});expect(takeRepositoryReadback(r)).toBeUndefined();
    expect(s.store.list('actions')).toEqual([]);
  });
  it.each([['success','success'],['failure','failure'],['pending','pending'],['cancelled','cancelled']] as const)('normalizes authenticated GitHub %s, with real incomplete time',async(status,expected)=>{
    const s=setup(),job=s.routes['/actions/runs/52/jobs'].jobs[0],check=s.routes['/check-runs/99'];
    job.conclusion=check.conclusion=status==='pending'?null:status;job.status=check.status=status==='pending'?'in_progress':'completed';job.completed_at=check.completed_at=status==='pending'?null:time;
    const r=await s.reader.read(s.project,s.source,s.request,new AbortController().signal);
    expect(r.observations[2]?.claim).toMatchObject({value:{conclusion:expected}});expect(r.observations[2]?.eventAt).toBe(status==='pending'?undefined:time);
  });
  it.each([['failed','failure'],['running','pending'],['canceled','cancelled']] as const)('normalizes authenticated GitLab %s',async(status,expected)=>{
    const s=setup('gitlab');s.routes['/jobs/71'].status=status;s.routes['/jobs/71'].finished_at=status==='running'?null:time;
    const r=await s.reader.read(s.project,s.source,s.request,new AbortController().signal);expect(r.observations[2]?.claim).toMatchObject({value:{conclusion:expected}});
  });
  it.each([
    (s:ReturnType<typeof setup>)=>{s.routes[''].full_name='foreign/repo';},
    (s:ReturnType<typeof setup>)=>{s.routes['/actions/runs/52'].head_sha=H2;},
    (s:ReturnType<typeof setup>)=>{s.routes['/actions/runs/52/jobs'].jobs[0].run_id=53;},
    (s:ReturnType<typeof setup>)=>{s.routes['/check-runs/99'].id=71;},
    (s:ReturnType<typeof setup>)=>{s.routes['/check-runs/99'].app.id=99;},
    (s:ReturnType<typeof setup>)=>{s.routes['/actions/runs/52/jobs'].jobs[0].check_run_url='https://evil.test/check-runs/99';},
    (s:ReturnType<typeof setup>)=>{s.routes['/actions/runs/52/jobs'].jobs[0].check_run_url='https://secret@api.github.com/repos/owner/repo/check-runs/99';},
    (s:ReturnType<typeof setup>)=>{s.routes[`/git/trees/${H}`].truncated=true;},
    (s:ReturnType<typeof setup>)=>{s.routes[`/git/trees/${H}`].tree[0].mode='120000';},
    (s:ReturnType<typeof setup>)=>{s.routes[`/git/trees/${H}`].tree=[];},
    (s:ReturnType<typeof setup>)=>{s.routes['/actions/runs/52/jobs'].jobs.push({...s.routes['/actions/runs/52/jobs'].jobs[0]});},
  ])('fails closed for GitHub identity/path/producer conflicts %#',async edit=>{const s=setup();edit(s);await expect(s.reader.read(s.project,s.source,s.request,new AbortController().signal)).rejects.toBeDefined();});
  it.each(['project','pipeline','commit','producer'])('fails closed for GitLab %s mismatch',async kind=>{
    const s=setup('gitlab');if(kind==='project')s.routes['/jobs/71'].pipeline.project_id=99;if(kind==='pipeline')s.routes['/jobs/71'].pipeline.id=53;if(kind==='commit')s.routes['/jobs/71'].commit.id=H2;if(kind==='producer')s.routes['/pipelines/52'].user.id=99;
    await expect(s.reader.read(s.project,s.source,s.request,new AbortController().signal)).rejects.toBeDefined();
  });
  it.each(['source','project'])('rejects late %s edit before provenance insertion',async kind=>{
    const s=setup();s.setAfter(path=>{if(path.startsWith('/check-runs/')){if(kind==='source')s.store.save('sources',{...s.source,content:'changed'});else s.store.save('projects',{...s.project,name:'changed'});}});
    await expect(s.reader.read(s.project,s.source,s.request,new AbortController().signal)).rejects.toBeDefined();
  });
  it.each(['oversized','malformed','redirect'])('rejects bounded transport %s',async kind=>{
    const s=setup();s.setOverride(path=>path===''?kind==='redirect'?new Response('',{status:302}):new Response(kind==='malformed'?'{': 'x'.repeat(2_000_001)):undefined);
    await expect(s.reader.read(s.project,s.source,s.request,new AbortController().signal)).rejects.toBeDefined();
  });
  it('rejects abort and unauthorized request paths before reading',async()=>{const s=setup(),a=new AbortController();a.abort();await expect(s.reader.read(s.project,s.source,s.request,a.signal)).rejects.toBeDefined();expect(s.requests).toHaveLength(0);s.request.filePaths=['secret'];await expect(s.reader.read(s.project,s.source,s.request,new AbortController().signal)).rejects.toBeDefined();expect(s.requests).toHaveLength(0);});
  it('does not accept a fake writer or monkeypatched readback as authenticated authority',async()=>{
    const s=setup();expect(()=>createRepositoryKnowledgeReader({readKnowledge:async()=>({observations:[],files:[],tests:[],gaps:[]})} as any,s.gitlab)).toThrow();
    s.github.readKnowledge=async()=>({observations:[],files:[],tests:[],gaps:[]});const r=await s.reader.read(s.project,s.source,s.request,new AbortController().signal);expect(r.observations).toHaveLength(3);
  });
  it.each(['github','gitlab'] as const)('resolves %s current identities at H2 and preserves exact H1 history',async provider=>{
    const s=setup(provider);s.request.current={changeNumber:17,checkNames:['validate']};
    if(provider==='github'){
      s.routes['/actions/runs']={total_count:1,workflow_runs:[{id:53,head_sha:H2,repository:{id:42,full_name:'owner/repo'}}]};
      s.routes['/actions/runs/53']={...s.routes['/actions/runs/52'],id:53,head_sha:H2};
      s.routes['/actions/runs/53/jobs']={total_count:1,jobs:[{...s.routes['/actions/runs/52/jobs'].jobs[0],id:72,run_id:53,head_sha:H2,check_run_url:'https://api.github.com/repos/owner/repo/check-runs/100'}]};
      s.routes['/check-runs/100']={...s.routes['/check-runs/99'],id:100,head_sha:H2};
    }else{
      s.routes['/merge_requests/17/pipelines']=[{id:53,sha:H2}];s.routes['/pipelines/53']={...s.routes['/pipelines/52'],id:53,sha:H2};
      s.routes['/jobs/72']={...s.routes['/jobs/71'],id:72,pipeline:{id:53,project_id:42,sha:H2},commit:{id:H2}};
      s.routes['/pipelines/53/jobs']=[s.routes['/jobs/72']];
    }
    const r=await s.reader.read(s.project,s.source,s.request,new AbortController().signal);
    const claims=r.observations.filter(o=>o.claim.kind==='ci-result').map(o=>o.claim);
    expect(claims).toHaveLength(2);expect(claims[0]).toMatchObject({subject:{headSha:H,runId:'52',jobId:'71'}});expect(claims[1]).toMatchObject({subject:{headSha:H2,runId:'53',jobId:'72'}});
    expect(r.tests[1]?.snapshot.files).toEqual([]);
  });
  it.each(['github','gitlab'] as const)('leaves %s absent/ambiguous current mapping unsupported',async provider=>{
    const s=setup(provider);s.request.current={changeNumber:17,checkNames:['validate']};s.routes[provider==='github'?'/actions/runs':'/merge_requests/17/pipelines']=provider==='github'?{total_count:0,workflow_runs:[]}:[];
    const r=await s.reader.read(s.project,s.source,s.request,new AbortController().signal);expect(r.observations).toHaveLength(3);expect(r.gaps).toContain('current_check_identity_unavailable:validate');
  });
  it('never promotes direct writer readbacks, and consumes tampered/canonical-stale receipts without authority',async()=>{
    const s=setup();const direct=await s.github.readKnowledge(s.project,s.source,s.request,new AbortController().signal);expect(takeRepositoryReadback(direct)).toBeUndefined();
    const r=await s.reader.read(s.project,s.source,s.request,new AbortController().signal);r.observations[0]!.locator='tampered';expect(takeRepositoryReadback(r)).toBeUndefined();
    const next=await s.reader.read(s.project,s.source,s.request,new AbortController().signal);s.store.save('sources',{...s.source,status:'withdrawn'});expect(takeRepositoryReadback(next)).toBeUndefined();
  });
  it.each(['SQLITE_BUSY_SNAPSHOT','SQLITE_LOCKED','SQLITE_SCHEMA'])('propagates %s from the consumed receipt current-source check',async code=>{
    const s=setup(),readback=await s.reader.read(s.project,s.source,s.request,new AbortController().signal);
    const get=s.store.get.bind(s.store);
    const spy=vi.spyOn(s.store,'get').mockImplementation(((...args:Parameters<typeof get>)=>{
      if(new Error().stack?.includes('takeRepositoryReadback'))throw Object.assign(new Error('injected SQLite failure'),{code});
      return get(...args);
    }) as typeof s.store.get);
    expect(()=>takeRepositoryReadback(readback)).toThrowError(expect.objectContaining({code}));
    spy.mockRestore();
    expect(takeRepositoryReadback(readback)).toBeUndefined();
  });
  it.each(['SQLITE_BUSY','SQLITE_LOCKED','SQLITE_SCHEMA'])('propagates %s from repository issue-source validation after the read',async code=>{
    const s=setup(),issue={...s.source,id:'issue',externalId:'issue',content:'Reported issue',locator:'issue:1'};s.store.save('sources',issue);
    s.source.content=JSON.stringify({schemaVersion:1,quote:'Resolution report',details:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear cache',files:[measured.path],productId:s.project.id,codeVersion:H,environment:'reported',invalidationConditions:['changes']},repository:s.project.repository,headSha:H,runId:'52',jobId:'71',checkIds:['validate'],issueId:issue.id});
    s.store.save('sources',s.source);const parsed=parseStructuredKnowledge(s.source,s.project)!;
    const request=structuredRepositoryRequest(s.store,s.source,s.project,parsed),get=s.store.get.bind(s.store);let injected=false;
    const spy=vi.spyOn(s.store,'get').mockImplementation(((...args:Parameters<typeof get>)=>{
      if(!injected&&s.requests.length>0&&args[0]==='sources'&&args[1]===issue.id&&new Error().stack?.includes('assertKnowledgeSource')){injected=true;throw Object.assign(new Error('injected SQLite failure'),{code});}
      return get(...args);
    }) as typeof s.store.get);
    try{await expect(s.reader.read(s.project,s.source,request,new AbortController().signal)).rejects.toMatchObject({code});expect(injected).toBe(true);}finally{spy.mockRestore();}
    const recovered=await s.reader.read(s.project,s.source,request,new AbortController().signal);expect(recovered.resolution).toMatchObject({sourceId:issue.id,revision:issue.revision});
  });
  it('rejects GitHub aggregate file bytes and per-page item overflow',async()=>{
    const s=setup(),large=Buffer.alloc(1_010_000,65);s.request.filePaths=[measured.path,'docs/second.ts'];
    s.routes[`/git/trees/${H}`].tree.push({path:'docs/second.ts',mode:'100644',type:'blob',sha:'e'.repeat(40)});
    for(const name of [blob,'e'.repeat(40)])s.routes[`/git/blobs/${name}`]={sha:name,encoding:'base64',size:large.length,content:large.toString('base64')};
    await expect(s.reader.read(s.project,s.source,s.request,new AbortController().signal)).rejects.toBeDefined();
    s.request.filePaths=[];s.routes['/actions/runs/52/jobs'].jobs=Array(101).fill(s.routes['/actions/runs/52/jobs'].jobs[0]);await expect(s.reader.read(s.project,s.source,s.request,new AbortController().signal)).rejects.toBeDefined();
  });
  it('rejects mismatched immutable requests before authenticated reads',async()=>{
    const s=setup();s.request.headSha=H2;
    await expect(s.reader.read(s.project,s.source,s.request,new AbortController().signal)).rejects.toBeDefined();expect(s.requests).toHaveLength(0);
  });
  it('rejects bounded stream failures with sanitized errors',async()=>{
    const s=setup();s.setOverride(path=>path===''?new Response(new ReadableStream({start(controller){controller.error(new Error('private transport detail'));}})):undefined);
    await expect(s.reader.read(s.project,s.source,s.request,new AbortController().signal)).rejects.toMatchObject({code:'remote_unavailable'});
  });
  it('leaves ambiguous current jobs without a supported current CI fact',async()=>{
    const s=setup('gitlab');s.request.current={changeNumber:17,checkNames:['validate']};s.routes['/merge_requests/17/pipelines']=[{id:53,sha:H2}];
    s.routes['/pipelines/53/jobs']=[{id:72,name:'validate'},{id:73,name:'validate'}];
    const r=await s.reader.read(s.project,s.source,s.request,new AbortController().signal);expect(r.observations).toHaveLength(3);expect(r.gaps).toContain('current_check_identity_unavailable:validate');
  });
  it.each(['github','gitlab'] as const)('keeps %s terminal conclusion with an unknown event time',async provider=>{
    const s=setup(provider);
    if(provider==='github'){s.routes['/check-runs/99'].completed_at=null;s.routes['/actions/runs/52/jobs'].jobs[0].completed_at=null;}
    else{s.routes['/jobs/71'].finished_at=null;s.routes['/pipelines/52'].finished_at=null;s.request.testReportPath=reportPath;}
    const r=await s.reader.read(s.project,s.source,s.request,new AbortController().signal);
    expect(r.observations[2]?.claim).toMatchObject({value:{conclusion:'success'}});expect(r.observations[2]?.eventAt).toBeUndefined();expect(r.tests[0]?.comparable).toBeUndefined();
  });
  it('stops a full-page provider collection at 100 pages',async()=>{
    const s=setup();s.request.filePaths=[];s.setOverride(path=>path==='/actions/runs/52/jobs'?new Response(JSON.stringify({total_count:10000,jobs:Array.from({length:100},(_,i)=>({id:(Number(s.requests.at(-1)!.url.searchParams.get('page'))-1)*100+i+1}))})):undefined);
    await expect(s.reader.read(s.project,s.source,s.request,new AbortController().signal)).rejects.toBeDefined();expect(s.requests.filter(r=>r.url.pathname.endsWith('/jobs'))).toHaveLength(100);
  });
});
describe('optional producer-attested comparable report',()=>{
  it('binds exact job-owned GitLab artifact and separately measured files/definitions',async()=>{
    const s=setup('gitlab');s.request.testReportPath=reportPath;const r=await s.reader.read(s.project,s.source,s.request,new AbortController().signal);
    const comparable={snapshotDigest:snapshotDigest(s.report.snapshot),testDefinitionDigest:testDefinitionDigest(s.report.definitions)};
    expect(r.tests).toHaveLength(1);expect(r.tests[0]?.comparable).toEqual(comparable);
    expect(takeRepositoryReadback(r)?.attestedTests).toEqual([expect.objectContaining({...comparable,observationId:r.tests[0]?.id,producerId:'731',originalEventId:'gitlab:42:pipeline:52:job:71',reportPath})]);
    expect(s.requests.some(r=>r.url.pathname.endsWith('/jobs/71/artifacts/'+reportPath))).toBe(true);
    expect(r.observations[2]?.origin.originalEventId).toBe('gitlab:42:pipeline:52:job:71');
  });
  it.each(['missing','foreign','bytes','command','overlay','authority','oversized'])('preserves ordinary CI but no comparable authority for %s report',async kind=>{
    const s=setup('gitlab');s.request.testReportPath=reportPath;
    if(kind==='missing')s.setOverride(path=>path.includes('/artifacts/')?new Response('',{status:404}):undefined);
    if(kind==='foreign')s.report.jobId='72';if(kind==='bytes')s.report.snapshot.files[0]!.sha256='f'.repeat(64);if(kind==='command')s.report.definitions[0]!.command='foreign';
    if(kind==='overlay')s.report.snapshot.overlayHash='unwitnessed';if(kind==='authority')(s.report as any).verified=true;
    if(kind==='oversized')s.setOverride(path=>path.includes('/artifacts/')?new Response('x'.repeat(512001)):undefined);
    const r=await s.reader.read(s.project,s.source,s.request,new AbortController().signal);expect(r.observations[2]?.claim.kind).toBe('ci-result');expect(r.tests[0]?.comparable).toBeUndefined();expect(takeRepositoryReadback(r)?.attestedTests).toEqual([]);expect(r.gaps).toContain('comparable_attestation_unavailable');
  });
  it('keeps GitHub ordinary CI when comparable report mapping is unsupported',async()=>{const s=setup();s.request.testReportPath=reportPath;const r=await s.reader.read(s.project,s.source,s.request,new AbortController().signal);expect(r.gaps).toContain('comparable_attestation_unavailable');expect(r.tests[0]?.comparable).toBeUndefined();expect(takeRepositoryReadback(r)?.attestedTests).toEqual([]);});
});


describe('bounded optional captured process errors',()=>{
 const processFacts={exitCode:0,signal:null,timedOut:false,startedAt:time,finishedAt:time};
 it('accepts absent codes and only the five bounded codes in the single shared schema',async()=>{
  const contract=await import('../../src/knowledge-contract.js');const schema=(contract as any).observedProcessSchema;expect(schema).toBeDefined();expect(schema.safeParse(processFacts).success).toBe(true);
  for(const errorCode of ['ETIMEDOUT','ENOBUFS','ENOENT','EACCES','PROCESS_ERROR'])expect(schema.safeParse({...processFacts,errorCode}).success).toBe(true);
  for(const errorCode of ['',null,'UNBOUNDED secret/path'])expect(schema.safeParse({...processFacts,errorCode}).success).toBe(false);expect(schema.safeParse({...processFacts,rawError:'private'}).success).toBe(false);
 });
 it('retains backwards-compatible comparable process facts with absent errorCode',async()=>{
  const s=setup('gitlab');s.request.testReportPath=reportPath;s.report.checks[0]!.process=processFacts;const r=await s.reader.read(s.project,s.source,s.request,new AbortController().signal);expect(r.tests[0]?.comparable).toBeDefined();expect(r.tests[0]?.checks[0]?.process).toEqual(processFacts);
 });
 it.each(['ETIMEDOUT','ENOBUFS','ENOENT','EACCES','PROCESS_ERROR','unknown-code','extra-key'])('preserves ordinary CI but refuses a success/error comparable report with %s',async code=>{
  const s=setup('gitlab');s.request.testReportPath=reportPath;(s.report.checks[0] as any).process={...processFacts,...(code==='extra-key'?{rawError:'private exception'}:{errorCode:code})};
  const r=await s.reader.read(s.project,s.source,s.request,new AbortController().signal);expect(r.tests[0]?.comparable).toBeUndefined();expect(r.observations[2]?.claim).toMatchObject({kind:'ci-result',value:{conclusion:'success'}});expect(r.gaps).toContain('comparable_attestation_unavailable');expect(takeRepositoryReadback(r)?.attestedTests).toEqual([]);
 });
});

describe('G4 measured empty overlay attestation',()=>{
 it.each(['absent','measured-empty','arbitrary','unknown-baseline','changed'] as const)('preserves explicit overlay identity for %s',async kind=>{
  const s=setup('gitlab');s.request.testReportPath=reportPath;
  const {digest}=await import('../../src/domain.js');
  if(kind==='measured-empty')s.report.snapshot.overlayHash=digest({state:'measured',files:[]});
  if(kind==='arbitrary')s.report.snapshot.overlayHash='e'.repeat(64);
  if(kind==='unknown-baseline')s.report.snapshot.overlayHash=digest({state:'unknown-baseline',files:[]});
  if(kind==='changed')s.report.snapshot.overlayHash=digest({state:'measured',files:s.report.snapshot.files});
  const r=await s.reader.read(s.project,s.source,s.request,new AbortController().signal);
  expect(!!r.tests[0]?.comparable).toBe(['absent','measured-empty'].includes(kind));
  if(kind==='measured-empty'){
   expect(r.tests[0]!.snapshot.overlayHash).toBe(s.report.snapshot.overlayHash);
   expect(r.tests[0]!.comparable!.snapshotDigest).not.toBe(snapshotDigest({...r.tests[0]!.snapshot,overlayHash:undefined}));
  }
 });
});
