import { afterEach, describe, expect, it } from 'vitest';
import { parseStructuredKnowledge, structuredRepositoryRequest } from '../../src/structured-knowledge.js';
import { knowledgeCandidateHash, knowledgePolicyHash, snapshotDigest, testDefinitionDigest } from '../../src/knowledge-identity.js';
import { knowledgeOutputSchema, type KnowledgeCard, type Project, type SourceRevision } from '../../src/domain.js';
import { Store } from '../../src/store.js';

const H = 'b'.repeat(40), quote = 'The validate run was requested.';
const project: Project = { id:'p',projectId:'p',domain:'personal',name:'P',description:'',repository:'owner/repo',repositoryProvider:'github',prdPath:'docs/PRD.md',allowedPaths:['docs/'],trustedChecks:['validate'],trustedAppIds:[15368],ownerId:'owner',autoMerge:false,budgetUsd:0,createdAt:'' };
const envelope = () => ({schemaVersion:1,kind:'repository-facts',quote,repository:project.repository,changeNumber:17,headSha:H,checks:[{runId:'52',jobId:'71',checkName:'validate'}]});
const experience = () => ({schemaVersion:1,quote,repository:project.repository,headSha:H,runId:'52',jobId:'71',checkIds:['validate'],details:{schemaVersion:1,problem:'Error',symptomAliases:['failure'],solution:'Reported fix',files:['docs/PRD.md'],productId:'p',codeVersion:'unknown',environment:'Node24; browser unknown',invalidationConditions:['Inputs change']}});
const source = (input:unknown):SourceRevision => ({id:'s',projectId:'p',domain:'personal',kind:'manual',externalId:'note',revision:'r1',title:'Source',content:typeof input==='string'?input:JSON.stringify(input),locator:'note',authorId:'owner',retention:'permanent',status:'active',createdAt:''});
const stores:Store[]=[];
afterEach(()=>stores.splice(0).forEach(store=>store.close()));
function setup(input:unknown) { const store=new Store(':memory:');stores.push(store);const s=source(input);store.save('projects',project);store.save('sources',s);return {store,s}; }

describe('one strict structured knowledge parser',()=>{
  it('keeps PR17 H run52/job71 as locators with no state or conclusion',()=>{
    const {store,s}=setup(envelope()),parsed=parseStructuredKnowledge(s,project)!;
    expect(parsed).toEqual({kind:'repository-facts',input:envelope()});
    expect(structuredRepositoryRequest(store,s,project,parsed)).toEqual({repository:project.repository,headSha:H,changeNumber:17,checks:envelope().checks,filePaths:[]});
    expect(JSON.stringify(parsed)).not.toMatch(/"(?:state|conclusion|exists|observations|verified)"/);
  });
  it('uses the complete existing experience description and exact selectors',()=>{
    const {store,s}=setup(experience()),parsed=parseStructuredKnowledge(s,project)!;
    expect(parsed).toEqual({kind:'experience',input:experience()});
    expect(structuredRepositoryRequest(store,s,project,parsed)).toEqual({repository:project.repository,headSha:H,checks:envelope().checks,filePaths:['docs/PRD.md']});
  });
  it('leaves ordinary prose and unrelated JSON alone',()=>{expect(parseStructuredKnowledge(source('Ordinary prose'),project)).toBeUndefined();expect(parseStructuredKnowledge(source({message:'hello'}),project)).toBeUndefined();});
  it.each([
    (v:any)=>{v.verified=true;}, (v:any)=>{v.current={changeNumber:17,checkNames:['validate']};},
    (v:any)=>{v.checks[0].conclusion='success';},(v:any)=>{v.observations=[];},
    (v:any)=>{v.headSha='bad';},(v:any)=>{v.checks[0].jobId='071';},(v:any)=>{v.checks[0].runId=52;},
    (v:any)=>{v.repository='foreign/repo';},(v:any)=>{v.quote='absent';v.quote='x'.repeat(10001);},
    (v:any)=>{v.checks.push({...v.checks[0],jobId:'72'});},(v:any)=>{v.testReportPath='../patrick-test-observation-v1.json';},
  ])('rejects malformed, conflicting or authority-bearing repository inputs %#',edit=>{const value=envelope();edit(value);expect(()=>parseStructuredKnowledge(source(value),project)).toThrowError(expect.objectContaining({code:'invalid_structured_knowledge'}));});
  it('rejects nested experience authority and byte overflows without a second schema',()=>{
    const v:any=experience();v.details.verified=true;expect(()=>parseStructuredKnowledge(source(v),project)).toThrow();
    delete v.details.verified;v.details.problem='界'.repeat(4000);expect(()=>parseStructuredKnowledge(source(v),project)).toThrow();
  });
  it('rejects conflicting duplicate JSON keys rather than silently taking the last value',()=>{
    const raw=JSON.stringify(envelope()).replace('"schemaVersion":1','"schemaVersion":2,"schemaVersion":1');
    expect(()=>parseStructuredKnowledge(source(raw),project)).toThrowError(expect.objectContaining({code:'invalid_structured_knowledge'}));
  });
  it('rechecks canonical current source, scope, exact quote, and full frozen project',()=>{
    const {store,s}=setup(envelope()),parsed=parseStructuredKnowledge(s,project)!;
    store.save('sources',{...s,content:s.content+' edited'});expect(()=>structuredRepositoryRequest(store,s,project,parsed)).toThrow();
    expect(()=>parseStructuredKnowledge({...s,status:'withdrawn'},project)).toThrow();
    expect(()=>parseStructuredKnowledge({...s,domain:'company'},project)).toThrow();
    store.save('sources',s);store.save('projects',{...project,name:'edited'});expect(()=>structuredRepositoryRequest(store,s,project,parsed)).toThrow();
  });
  it('resolves only retained in-scope issue SourceRevision IDs and current parent lineage',()=>{
    const v={...experience(),issueId:'issue'}, {store,s}=setup(v),parsed=parseStructuredKnowledge(s,project)!;
    expect(structuredRepositoryRequest(store,s,project,parsed).issueSource).toBeUndefined();
    const issue={...source('Reported resolution'),id:'issue',revision:'issue-r1',parentSources:[{id:'parent',revision:'a'}]};store.save('sources',issue);
    expect(structuredRepositoryRequest(store,s,project,parsed).issueSource).toBeUndefined();
    store.save('sources',{...source('parent'),id:'parent',revision:'a'});
    expect(structuredRepositoryRequest(store,s,project,parsed).issueSource).toEqual({id:'issue',revision:'issue-r1'});
  });
  it('rejects unsupported selectors and forged parsed branches on request construction',()=>{
    const v=experience();v.checkIds=['unconfigured'];expect(()=>parseStructuredKnowledge(source(v),project)).toThrow();
    const {store,s}=setup(envelope()),parsed=parseStructuredKnowledge(s,project)!;
    (parsed.input as any).headSha='a'.repeat(40);expect(()=>structuredRepositoryRequest(store,s,project,parsed)).toThrow();
  });
});

describe('shared candidate, policy and measured identities',()=>{
  it('strictly accepts bounded proposed claims/locators and rejects authority at every nested layer',()=>{
    const card={title:'Requested check',body:'Reported',quote,aliases:[],verification:'reported',kind:'fact',pendingClaim:{kind:'ci-result',repository:project.repository,headSha:H,runId:'52',jobId:'71',checkName:'validate'}};
    expect(knowledgeOutputSchema.safeParse({cards:[card]}).success).toBe(true);
    expect(knowledgeOutputSchema.safeParse({cards:[{...card,pendingClaim:{...card.pendingClaim,conclusion:'success'}}]}).success).toBe(false);
    expect(knowledgeOutputSchema.safeParse({cards:[{...card,factual:{eligible:true}}]}).success).toBe(false);
  });
  it('binds claim and pending locator content while excluding display verification',()=>{
    const card:KnowledgeCard={id:'c',sourceId:'s',sourceRevision:'r1',projectId:'p',domain:'personal',title:'T',body:'B',quote,locator:'note',aliases:[],kind:'fact',verification:'reported',status:'active',createdAt:''};
    const h=knowledgeCandidateHash(card);card.pendingClaim={kind:'commit-exists',repository:project.repository,sha:H};expect(knowledgeCandidateHash(card)).not.toBe(h);
    const bound=knowledgeCandidateHash(card);card.verification='verified';expect(knowledgeCandidateHash(card)).toBe(bound);
  });
  it('sorts policy lists and measured files, retains explicit overlay identity',()=>{
    expect(knowledgePolicyHash(project)).toBe(knowledgePolicyHash({...project,name:'Cosmetic',description:'different'}));
    expect(knowledgePolicyHash({...project,trustedAppIds:[1]})).not.toBe(knowledgePolicyHash(project));
    const files=[{path:'docs/a',sha256:'a'.repeat(64),mode:'100644'},{path:'docs/b',sha256:'b'.repeat(64),mode:'100755'}];
    expect(snapshotDigest({revision:H,files})).toBe(snapshotDigest({revision:H,files:[...files].reverse()}));
    expect(snapshotDigest({revision:H,files})).not.toBe(snapshotDigest({revision:H,files,overlayHash:'overlay'}));
    expect(testDefinitionDigest([{command:'validate',files}])).not.toBe(testDefinitionDigest([{command:'other',files}]));
  });
  it('canonicalizes proposed claim field order in full candidate hashes',()=>{
    const card:KnowledgeCard={id:'c',sourceId:'s',sourceRevision:'r1',projectId:'p',domain:'personal',title:'T',body:'B',quote,locator:'note',aliases:[],kind:'fact',verification:'reported',status:'active',createdAt:'',pendingClaim:{kind:'commit-exists',repository:project.repository,sha:H}};
    const value=knowledgeCandidateHash(card);card.pendingClaim={sha:H,repository:project.repository,kind:'commit-exists'};expect(knowledgeCandidateHash(card)).toBe(value);
  });
});
