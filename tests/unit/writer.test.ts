import { describe, expect, it } from 'vitest';
import { GitHubWriter, validateDelivery, validateChecks } from '../../src/integrations/github.js';
import { readConfig } from '../../src/config.js';
import type { Store } from '../../src/store.js';
import { digest, type Artifact, type Project, type Task } from '../../src/domain.js';

const project: Project = { id:'p', projectId:'p', domain:'personal', name:'Product', description:'', repository:'owner/repo', repositoryProvider:'github', prdPath:'docs/PRD.md', allowedPaths:['docs/PRD.md'], trustedChecks:['validate'], trustedAppIds:[123], ownerId:'owner', autoMerge:true, budgetUsd:5, createdAt:'2026-11-03T00:00:00Z' };
const artifact: Artifact = {taskVersion:1,planHash:'',baselineSha:'base',files:[{path:'docs/PRD.md',content:'Requirements'}],tests:[{command:'validate',passed:true,output:'ok'}],summary:'Update PRD'};
const task: Task = { id:'t',projectId:'p',domain:'personal',sourceId:'s',sourceRevision:'v1',title:'Update',description:'',status:'publishing',version:1,createdAt:'',updatedAt:'',runAfter:'',attempts:0,repairCount:0,budgetUsd:5,spentUsd:0,stage:'delivery',plan:{taskVersion:1,sourceRevision:'v1',baselineSha:'base',summary:'Plan',paths:['docs/PRD.md'],steps:['Update'],tests:['validate'],stopConditions:['Source changed']},artifact };
task.artifact!.planHash = digest(task.plan!);
task.review = { taskVersion:1,planHash:digest(task.plan!),artifactHash:digest(task.artifact!),verdict:'pass',summary:'Checked',issues:[],tests:[{command:'validate',passed:true,output:'ok'}] };

describe('repository delivery gate', () => {
  it('rejects a GitLab project before making any GitHub request',async()=>{
    let calls=0;const writer=new GitHubWriter({} as Store,readConfig({}),async()=>{calls++;throw Error('should not fetch');});
    await expect(writer.baseline({...project,repositoryProvider:'gitlab'})).rejects.toThrow(/GitHub/);expect(calls).toBe(0);
  });
  it('allows planning an explicitly allowed new PRD file',async()=>{
    const writer=new GitHubWriter({} as Store,{...readConfig({}),githubToken:'fixture'},async()=>new Response('{}',{status:404}));
    await expect(writer.readBaseline(project,'base')).resolves.toEqual([]);
  });
  it('requires a bound review and rejects forbidden files and missing tests', () => {
    expect(() => validateDelivery(task, project)).not.toThrow();
    expect(() => validateDelivery({...task,review:undefined},project)).toThrow();
    expect(() => validateDelivery({...task,artifact:{...artifact,files:[{path:'.github/workflows/validate.yml',content:'skip'}]}},project)).toThrow();
    expect(() => validateDelivery({...task,version:2},project)).toThrow();
  });
  it('rejects zero, skipped, foreign-app, and stale-head checks', () => {
    expect(() => validateChecks([],project,'head')).toThrow();
    const check = {name:'validate',conclusion:'success',headSha:'head',appId:123,url:'https://github.com/owner/repo/actions/runs/1'};
    expect(() => validateChecks([check],project,'head')).not.toThrow();
    for (const change of [{conclusion:'skipped'},{appId:0},{headSha:'old'}]) expect(() => validateChecks([{...check,...change}],project,'head')).toThrow();
  });
});
