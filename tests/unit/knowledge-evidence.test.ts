import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest, type KnowledgeCard } from '../../src/domain.js';
import type { AtomicClaim, HostObservation } from '../../src/knowledge-contract.js';
import { snapshotDigest, testDefinitionDigest, knowledgeCandidateHash } from '../../src/knowledge-identity.js';
import { Store } from '../../src/store.js';
import { repositoryKnowledgeFixture, H, H2, reportPath } from '../fixtures/repository-knowledge.js';
import * as evidence from '../../src/knowledge-evidence.js';
import { canonicalCiTestPayloadSchema, readHostObservation, knowledgeActionSourceRefs, hostObservationId } from '../../src/knowledge-records.js';
import { enqueueStructuredKnowledge, readyStructuredKnowledgeJobs } from '../../src/knowledge-jobs.js';

function candidate(s:ReturnType<typeof repositoryKnowledgeFixture>,claim?:AtomicClaim):KnowledgeCard {
 const card:KnowledgeCard={id:'card',projectId:s.project.id,domain:s.project.domain,sourceId:s.source.id,sourceRevision:s.source.revision,title:'Requested check',body:'users lost drafts; solution and revenue remain reported',quote:'Requested check',locator:s.source.locator,kind:'fact',verification:'reported',status:'active',aliases:[],createdAt:''};
 if(claim)card.claim={schemaVersion:1,claim,quote:card.quote,interpretation:'reported'};
 else card.pendingClaim={kind:'change-head',repository:s.project.repository,number:17};
 s.store.save('cards',card);return card;
}
async function read(s:ReturnType<typeof repositoryKnowledgeFixture>){return s.reader.read(s.project,s.source,s.request,new AbortController().signal);}
const snapshot={revision:H,overlayHash:digest({state:'measured',files:[]}),files:[{path:'docs/test.ts',sha256:'a'.repeat(64),mode:'100644'}]};
const definitions=[{command:'literal test;$(id)',files:snapshot.files}];
const testClaim:AtomicClaim={kind:'test-result',subject:{provider:'gitlab',repository:'owner/repo',testedRevision:H,snapshotDigest:snapshotDigest(snapshot),testDefinitionDigest:testDefinitionDigest(definitions)},value:{result:'success'}};
function observation(id:string,event:string,origin:string):HostObservation{return {schemaVersion:1,id,projectId:'p',domain:'personal',claim:structuredClone(testClaim),origin:{kind:'host-test',repository:'owner/repo',producerId:origin,originalEventId:event,independentOrigin:origin,derivedFrom:[]},sourceRefs:[{id:'common-source',revision:'r1'}],responseDigest:'c'.repeat(64),locator:'local:'+id,observedAt:'2026-11-04T12:00:00Z',bindingHash:'d'.repeat(64)};}

describe('canonical repository evidence admission',()=>{
 it.each(['active-source','missing-source','foreign-source','pending','extra','malformed'] as const)('does not treat a %s payload as a host retraction',async kind=>{
  const s=repositoryKnowledgeFixture();try{
   const revoked={...s.source,id:'revoked',status:'withdrawn' as const};s.store.save('sources',revoked);
   if(kind==='foreign-source')s.store.save('sources',{...revoked,id:'foreign',projectId:'elsewhere'});
   const sourceId=kind==='active-source'?s.source.id:kind==='missing-source'?'missing':kind==='foreign-source'?'foreign':'revoked';
   const payload=kind==='malformed'?{retracted:true,sourceIds:[17]}:{retracted:true,sourceIds:[sourceId],...(kind==='extra'?{raw:'private'}:{})};
   s.store.save('actions',{id:'not-a-tombstone',projectId:s.project.id,domain:s.project.domain,kind:'knowledge.host-observation',status:kind==='pending'?'pending':'completed',payload,updatedAt:''});
   const readback=await read(s);expect(()=>evidence.acceptRepositoryReadback(s.store,s.source.id,readback)).toThrow();
   expect(readHostObservation(s.store,'not-a-tombstone',s.project)).toBeUndefined();
  }finally{s.close();}
 });
 it.each(['digest','id','status'] as const)('fails closed on a structurally plausible active canonical row with invalid %s',async kind=>{
  const s=repositoryKnowledgeFixture();try{
   const ids=evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s)),row=s.store.get('actions',ids.find(id=>(s.store.get('actions',id)!.payload.observation as HostObservation).claim.kind==='ci-result')!)!;
   if(kind==='id'){s.store.delete('actions',row.id);s.store.save('actions',{...row,id:'incorrect-id'});}
   else if(kind==='status')s.store.save('actions',{...row,status:'pending'});
   else s.store.save('actions',{...row,payload:{...row.payload,digest:'0'.repeat(64)}});
   const readback=await read(s);expect(()=>evidence.acceptRepositoryReadback(s.store,s.source.id,readback)).toThrow();
  }finally{s.close();}
 });
 it('retains one bound CI observation alongside the admitted host records',async()=>{
  const s=repositoryKnowledgeFixture('gitlab');try{
   const readback=await read(s),ids=evidence.acceptRepositoryReadback(s.store,s.source.id,readback);
   const rows=s.store.list('actions').filter(a=>a.kind==='experience.test-observation');
   expect(ids).toHaveLength(3);expect(rows).toHaveLength(1);
   expect(rows[0]!.payload).toMatchObject({schemaVersion:1,sourceHash:digest(s.source),sourceRefs:[{id:s.source.id,revision:s.source.revision}],observation:{sourceId:s.source.id,sourceRevision:s.source.revision,checks:[{result:'success'}],origin:{kind:'ci',runId:'52',jobId:'71'}}});
   expect((rows[0]!.payload.hostObservationIds as string[]).every(id=>ids.includes(id))).toBe(true);
   expect(canonicalCiTestPayloadSchema.safeParse({...rows[0]!.payload,hostObservationIds:[...(rows[0]!.payload.hostObservationIds as string[]),ids[0]]}).success).toBe(false);
   evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s));
   expect(s.store.list('actions').filter(a=>a.kind==='experience.test-observation')).toHaveLength(1);
  }finally{s.close();}
 });
 it.each([['success','success'],['failed','failure'],['running','incomplete']] as const)('retains actual GitLab %s CI state without adding comparable authority',async(status,result)=>{
  const s=repositoryKnowledgeFixture('gitlab');try{
   s.routes['/jobs/71'].status=status;if(status==='running')s.routes['/jobs/71'].finished_at=null;
   const ids=evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s)),ci=s.store.list('actions').filter(a=>a.kind==='experience.test-observation');
   expect(ci).toHaveLength(1);expect(ci[0]!.payload).toMatchObject({observation:{checks:[{result}],environment:{observed:{},unknown:['execution-environment']},origin:{kind:'ci',runId:'52',jobId:'71'}}});
   expect((ci[0]!.payload.observation as any).comparable).toBeUndefined();
   expect(ci[0]!.payload.hostObservationIds).toHaveLength(1);expect(ids).toContain((ci[0]!.payload.hostObservationIds as string[])[0]);
  }finally{s.close();}
 });
 it('admits only actual one-use readback then links a fresh exact PR atom without verifying prose',async()=>{
  const s=repositoryKnowledgeFixture();try{const card=candidate(s),oldHash=knowledgeCandidateHash(card),r=await read(s),ids=evidence.acceptRepositoryReadback(s.store,s.source.id,r);expect(ids).toHaveLength(3);
   expect(()=>evidence.linkKnowledgeEvidence(s.store,card.id,ids)).toThrow();
   const o=ids.map(id=>readHostObservation(s.store,id,s.project)!).find(o=>o.claim.kind==='change-head')!;
   expect(o.claim).toMatchObject({value:{headSha:H2,state:'open'}});card.claim={schemaVersion:1,claim:o.claim,quote:card.quote,interpretation:'reported'};delete card.pendingClaim;s.store.save('cards',card);
   const link=evidence.linkKnowledgeEvidence(s.store,card.id,[o.id]);expect(link).toMatchObject({basis:'authoritative-record',candidateHash:knowledgeCandidateHash(card),claimHash:digest(o.claim)});expect(link.candidateHash).not.toBe(oldHash);
   expect(s.store.get('cards',card.id)?.verification).toBe('reported');expect(()=>evidence.acceptRepositoryReadback(s.store,s.source.id,r)).toThrow();
   expect(knowledgeActionSourceRefs(s.store.list('actions').find(a=>a.kind==='knowledge.evidence-link')!)).toEqual(link.sourceRefs);
  }finally{s.close();}
 });
 it.each(['copy','prototype','mutation','wrong-source','policy','source','request','scope','withdraw-parent'])('rejects %s before canonical save',async kind=>{
  const s=repositoryKnowledgeFixture();try{const r=await read(s);let input=r,sourceId=s.source.id;
   if(kind==='copy')input=structuredClone(r);if(kind==='prototype')input=Object.create(r);if(kind==='mutation')r.observations[0]!.claim.value={headSha:H,state:'closed'} as any;
   if(kind==='wrong-source')sourceId='other';if(kind==='source')s.store.save('sources',{...s.source,content:s.source.content+' '});if(kind==='policy')s.store.save('projects',{...s.project,trustedChecks:[]});
   if(kind==='request')r.observations[0]!.bindingHash='0'.repeat(64);if(kind==='scope')s.store.save('sources',{...s.source,domain:'elsewhere'});
   if(kind==='withdraw-parent'){s.store.save('sources',{...s.source,parentSources:[{id:'missing',revision:'r1'}]});}
   expect(()=>evidence.acceptRepositoryReadback(s.store,sourceId,input)).toThrow();expect(s.store.list('actions')).toEqual([]);
  }finally{s.close();}
 });
 it('repeated reads are idempotent, contradictory same execution fails closed and timestamps do not mint new execution',async()=>{
  const s=repositoryKnowledgeFixture('gitlab');try{const ids=evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s));expect(evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s))).toEqual(ids);
   s.routes['/jobs/71'].status='failed';s.routes['/jobs/71'].finished_at='2026-11-04T13:00:00Z';expect(()=>s.store.transaction(()=>evidence.acceptRepositoryReadback(s.store,s.source.id,{} as any))).toThrow();
   const changed=await read(s);expect(()=>evidence.acceptRepositoryReadback(s.store,s.source.id,changed)).toThrow();expect(s.store.list('actions').filter(a=>a.kind==='knowledge.host-observation')).toHaveLength(3);expect(s.store.list('actions').filter(a=>a.kind==='experience.test-observation')).toHaveLength(1);
  }finally{s.close();}
 });
 it.each(['success','failed','canceled'] as const)('retains one GitLab job history from pending to %s and rejects stale pending',async status=>{
  const s=repositoryKnowledgeFixture('gitlab');try{
   s.routes['/jobs/71'].status='pending';s.routes['/jobs/71'].finished_at=null;
   const pending=await read(s),stale=await read(s),first=evidence.acceptRepositoryReadback(s.store,s.source.id,pending);
   const initial=first.map(id=>readHostObservation(s.store,id,s.project)!).find(o=>o.claim.kind==='ci-result')!;
   expect(initial.claim.value).toEqual({conclusion:'pending'});
   s.routes['/jobs/71'].status=status;s.routes['/jobs/71'].finished_at='2026-11-04T13:00:00Z';
   const completed=evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s));
   const final=completed.map(id=>readHostObservation(s.store,id,s.project)!).find(o=>o.claim.kind==='ci-result')!;
   expect(final.claim.value).toEqual({conclusion:status==='failed'?'failure':status==='canceled'?'cancelled':'success'});
   expect(final.origin.originalEventId).toBe(initial.origin.originalEventId);
   expect(final.id).not.toBe(initial.id);
   expect(readHostObservation(s.store,initial.id,s.project)).toBeDefined();
   expect(evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s))).toEqual(completed);
   expect(()=>evidence.acceptRepositoryReadback(s.store,s.source.id,stale)).toThrow();
  }finally{s.close();}
 });
 it('retains a separately selected current change and check without treating it as a historical request',async()=>{
  const s=repositoryKnowledgeFixture('gitlab');try{
   s.project.trustedChecks=['validate','other'];s.store.save('projects',s.project);
   s.request.current={changeNumber:18,checkNames:['validate','other']};
   s.routes['/merge_requests/18']={...s.routes['/merge_requests/17'],iid:18};
   s.routes['/merge_requests/18/pipelines']=[{id:53,sha:H2},{id:54,sha:H2}];
   s.routes['/pipelines/53']={...s.routes['/pipelines/52'],id:53,sha:H2};
   s.routes['/pipelines/54']={...s.routes['/pipelines/52'],id:54,sha:H2};
   s.routes['/jobs/72']={...s.routes['/jobs/71'],id:72,pipeline:{id:53,project_id:42,sha:H2},commit:{id:H2}};
   s.routes['/jobs/73']={...s.routes['/jobs/71'],id:73,name:'other',pipeline:{id:54,project_id:42,sha:H2},commit:{id:H2}};
   s.routes['/pipelines/53/jobs']=[{...s.routes['/pipelines/52/jobs'][0],id:72,pipeline:{id:53,project_id:42,sha:H2},commit:{id:H2}}];
   s.routes['/pipelines/54/jobs']=[{...s.routes['/pipelines/52/jobs'][0],id:73,name:'other',pipeline:{id:54,project_id:42,sha:H2},commit:{id:H2}}];
   const ids=evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s));
   const claims=ids.map(id=>readHostObservation(s.store,id,s.project)?.claim);
   expect(claims).toContainEqual({kind:'ci-result',subject:{provider:'gitlab',repository:s.project.repository,headSha:H2,runId:'53',jobId:'72',checkName:'validate'},value:{conclusion:'success'}});
   const currentId=ids.find(id=>{const claim=readHostObservation(s.store,id,s.project)?.claim;return claim?.kind==='ci-result'&&claim.subject.headSha===H2;})!;
   const currentChange=ids.find(id=>{const claim=readHostObservation(s.store,id,s.project)?.claim;return claim?.kind==='change-head'&&claim.subject.number===18;})!;
   s.store.delete('actions',currentChange);
   expect(readHostObservation(s.store,currentId,s.project)).toBeUndefined();
  }finally{s.close();}
 });
 it('requires private producer attestation for comparable tests and retains ordinary narrower CI',async()=>{
  const s=repositoryKnowledgeFixture('gitlab');try{s.request.testReportPath=reportPath;const r=await read(s),ids=evidence.acceptRepositoryReadback(s.store,s.source.id,r);expect(ids.map(id=>readHostObservation(s.store,id,s.project)?.claim.kind)).toContain('test-result');
   const retained=ids.map(id=>readHostObservation(s.store,id,s.project)!).find(o=>o.claim.kind==='test-result')!;
   expect(evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s))).toEqual(ids);expect(evidence.compareIndependentClaim(retained.claim,[retained,retained])).toBe(false);
   const forged=structuredClone(r);expect(()=>evidence.acceptRepositoryReadback(s.store,s.source.id,forged)).toThrow();
   s.setOverride(path=>path.includes('/artifacts/')?new Response('',{status:404}):undefined);const narrow=await read(s);expect(narrow.tests[0]!.comparable).toBeUndefined();expect(evidence.acceptRepositoryReadback(s.store,s.source.id,narrow).map(id=>readHostObservation(s.store,id,s.project)?.claim.kind)).not.toContain('test-result');
  }finally{s.close();}
 });
 it.each(['body','wrong-atom','wrong-value','forged-id','malformed','scope','source','policy','withdrawal','expiry'])('refuses %s evidence links',async kind=>{
  const s=repositoryKnowledgeFixture();try{const ids=evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s)),o=readHostObservation(s.store,ids[0]!,s.project)!;const card=candidate(s,o.claim);let selected=[o.id];
   if(kind==='body')delete card.claim;if(kind==='wrong-atom')card.claim!.claim={kind:'commit-exists',subject:{provider:'github',repository:'owner/repo',sha:H},value:{exists:true}};
   if(kind==='wrong-value')(card.claim!.claim as any).value.headSha=H;if(kind==='expiry')card.expiresAt='2000-01-01T00:00:00Z';s.store.save('cards',card);
   if(kind==='forged-id'){const a=s.store.get('actions',o.id)!;s.store.save('actions',{...a,id:'forged'});selected=['forged'];}
   if(kind==='malformed'){const a=s.store.get('actions',o.id)!;s.store.save('actions',{...a,payload:{...a.payload,extra:true}});}
   if(kind==='scope')s.store.save('sources',{...s.source,domain:'elsewhere'});if(kind==='source')s.store.save('sources',{...s.source,revision:'r2'});if(kind==='withdrawal')s.store.save('sources',{...s.source,status:'withdrawn'});if(kind==='policy')s.store.save('projects',{...s.project,trustedAppIds:[]});
   expect(()=>evidence.linkKnowledgeEvidence(s.store,card.id,selected)).toThrow();
  }finally{s.close();}
 });
});

describe('bounded independent atomic comparison',()=>{
 it('accepts two actual execution roots with different producer origins despite common repository, candidate and request',()=>{expect(evidence.compareIndependentClaim(testClaim,[observation('a','local:run','host:runner'),observation('b','gitlab:job','gitlab:731')])).toBe(true);});
 it.each(['same-event','pipeline-job','two-artifacts','alias','rerun-alias','same-producer','mirrored','derived','derived-source','self','shared-root','unknown','revision','overlay','file','mode','command','definition','result','scope','contradiction'])('fails closed for %s',kind=>{
  const a=observation('a','event:a','origin:a'),b=observation('b','event:b','origin:b');
  if(['same-event','pipeline-job','two-artifacts','alias','rerun-alias'].includes(kind))b.origin.originalEventId=a.origin.originalEventId;
  if(kind==='same-producer')b.origin.independentOrigin=a.origin.independentOrigin;
  if(['mirrored','shared-root'].includes(kind)){a.origin.derivedFrom=['source:root:r1'];b.origin.derivedFrom=['source:root:r1'];}
  if(kind==='derived')b.origin.derivedFrom=[a.id];if(kind==='derived-source'){a.sourceRefs=[{id:'a-source',revision:'r1'}];b.sourceRefs=[{id:'b-source',revision:'r1'},{id:'a-source',revision:'r1'}];b.origin.derivedFrom=['source:a-source:r1'];}if(kind==='self')b.origin.derivedFrom=[b.id];if(kind==='unknown')b.origin.derivedFrom=['unknown'];
  if(kind==='revision')(b.claim as any).subject.testedRevision=H2;
  if(kind==='overlay')(b.claim as any).subject.snapshotDigest=snapshotDigest({...snapshot,overlayHash:undefined});
  if(kind==='file')(b.claim as any).subject.snapshotDigest=snapshotDigest({...snapshot,files:[{...snapshot.files[0]!,sha256:'e'.repeat(64)}]});
  if(kind==='mode')(b.claim as any).subject.snapshotDigest=snapshotDigest({...snapshot,files:[{...snapshot.files[0]!,mode:'100755'}]});
  if(kind==='command')(b.claim as any).subject.testDefinitionDigest=testDefinitionDigest([{...definitions[0]!,command:'another command'}]);
  if(kind==='definition')(b.claim as any).subject.testDefinitionDigest=testDefinitionDigest([{...definitions[0]!,files:[{...snapshot.files[0]!,path:'docs/other-test.ts'}]}]);
  if(['result','contradiction'].includes(kind))(b.claim as any).value.result='failure';if(kind==='scope')b.domain='other';
  expect(evidence.compareIndependentClaim(testClaim,[a,b])).toBe(false);
 });
});

describe('task-independent temporary canonical evidence',()=>{
 it.each(['permanent','ephemeral'] as const)('preserves accepted local observation %s retention and unrelated actions',retention=>{
  const dir=mkdtempSync(join(tmpdir(),'patrick-g5-local-retention-'));let store=new Store(join(dir,'db'));
  try{
   store.save('sources',{id:'s',projectId:'p',domain:'personal',kind:'manual',externalId:'s',revision:'r',title:'Source',content:'text',locator:'s',authorId:'owner',status:'active',retention,createdAt:''});
   const h='a'.repeat(64),observation={schemaVersion:1,id:'local',projectId:'p',domain:'personal',sourceId:'s',sourceRevision:'r',repository:'a/b',observedAt:'2026-11-04T12:00:00Z',snapshot:{revision:'baseline',files:[]},checks:[{id:'check',result:'failure',outputDigest:h}],environment:{observed:{},unknown:[]},origin:{kind:'local',taskId:'task',taskVersion:1,attemptId:'attempt',inputHash:h,planHash:h,artifactHash:h,role:'execute',runId:'run'}};
   const accepted={attemptId:'attempt',taskId:'task',taskVersion:1,role:'execute',runner:'grok',provider:'provider',model:'model',inputHash:h,outputHash:h,planHash:h,artifactHash:h,runId:'run',sourceHash:h,policyHash:h};
   store.save('actions',{id:'local',projectId:'p',domain:'personal',kind:'experience.test-observation',status:'completed',payload:{schemaVersion:1,observation,digest:digest(observation),accepted,acceptedDigest:digest(accepted),sourceRefs:[{id:'s',revision:'r'}]},updatedAt:''});
   store.save('actions',{id:'unrelated',projectId:'p',domain:'personal',kind:'unrelated',status:'completed',payload:{dependencies:{unknown:true}},updatedAt:''});
   store.close();store=new Store(join(dir,'db'));expect(!!store.get('actions','local')).toBe(retention==='permanent');expect(store.get('actions','unrelated')).toBeDefined();
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
 it('does not schedule a job after a temporary source ancestor expires',()=>{
  const s=repositoryKnowledgeFixture();try{
   const parent={...s.source,id:'parent',externalId:'parent',retention:'ephemeral' as const,content:'private ancestor'};s.store.save('sources',parent);
   const child={...s.source,parentSources:[{id:parent.id,revision:parent.revision}]};s.store.save('sources',child);
   expect(enqueueStructuredKnowledge(s.store,child)).toBeDefined();expect(readyStructuredKnowledgeJobs(s.store,new Date().toISOString(),4)).toHaveLength(1);
   s.store.save('sources',{...parent,content:''});expect(readyStructuredKnowledgeJobs(s.store,new Date().toISOString(),4)).toEqual([]);
  }finally{s.close();}
 });
 it.each(['parent','malformed','missing','cycle','retention-switch'] as const)('keeps a task-free structured job private for %s',kind=>{
  const dir=mkdtempSync(join(tmpdir(),'patrick-g5-job-private-'));let store=new Store(join(dir,'db'));
  try{
   const base=repositoryKnowledgeFixture();const project=base.project,template=base.source;base.close();store.save('projects',project);
   const parent={...template,id:'parent',externalId:'parent',retention:'ephemeral' as const,content:'private parent'};
   if(kind==='parent')store.save('sources',parent);
   let source={...template,id:'child',externalId:'child',...(kind==='parent'?{parentSources:[{id:parent.id,revision:parent.revision}]}:kind==='missing'?{parentSources:[{id:'absent',revision:'r1'}]}:kind==='cycle'?{parentSources:[{id:'child',revision:'r1'}]}:{})};
   store.save('sources',source);
   let id:string|undefined;
   if(kind==='malformed'||kind==='missing'||kind==='cycle'){
    id='PRIVATE_G5_JOB_ID';const sourceRefs=kind==='malformed'?[{id:'child',revision:4}]:[{id:'child',revision:'r1'}];
    store.save('actions',{id,projectId:project.id,domain:project.domain,kind:'knowledge.structured-ingest',status:'pending',payload:{schemaVersion:1,sourceId:'child',sourceRevision:'r1',sourceHash:digest(source.content),sourceRefs,phase:'queued',tries:0,runAfter:'2026-11-04T12:00:00Z'},updatedAt:''});
   }else id=enqueueStructuredKnowledge(store,source);
   expect(id).toBeDefined();expect(store.get('actions',id!)).toBeDefined();
   if(kind==='retention-switch'){source={...source,retention:'ephemeral'};store.save('sources',source);}
   store.close();expect(readFileSync(join(dir,'db')).includes(Buffer.from(id!))).toBe(false);
   store=new Store(join(dir,'db'));expect(store.get('actions',id!)).toBeUndefined();
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
 it.each(['knowledge.structured-ingest','experience.test-observation'] as const)('keeps %s with an unrecognized dependency shape private',kind=>{
  const dir=mkdtempSync(join(tmpdir(),'patrick-g5-unknown-'));let store=new Store(join(dir,'db'));
  try{
   store.save('sources',{id:'s',projectId:'p',domain:'personal',kind:'manual',externalId:'s',revision:'r',title:'source',content:'text',locator:'s',authorId:'owner',status:'active',retention:'permanent',createdAt:''});
   const common={schemaVersion:1,sourceRefs:[{id:'s',revision:'r'}],dependencies:{unrecognized:'PRIVATE_G5_UNKNOWN_DEPENDENCY'}};
   const payload=kind==='knowledge.structured-ingest'?{...common,sourceId:'s',sourceRevision:'r',sourceHash:digest('text'),phase:'queued',tries:0,runAfter:'2026-11-04T12:00:00Z'}:{...common,observation:{sourceId:'s',sourceRevision:'r'}};
   store.save('actions',{id:'row',projectId:'p',domain:'personal',kind,status:'pending',payload,updatedAt:''});
   expect(store.get('actions','row')).toBeDefined();store.close();
   expect(readFileSync(join(dir,'db')).includes(Buffer.from('PRIVATE_G5_UNKNOWN_DEPENDENCY'))).toBe(false);
   store=new Store(join(dir,'db'));expect(store.get('actions','row')).toBeUndefined();
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
 it('accepts an exact 256-ref canonical link',async()=>{
  const s=repositoryKnowledgeFixture();try{
   const parentSources=[];
   for(let i=0;i<255;i++){const id=`ancestor-${i}`;s.store.save('sources',{...s.source,id,content:'Ancestral source'});parentSources.push({id,revision:'r1'});}
   s.source.parentSources=parentSources;s.store.save('sources',s.source);
   const ids=evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s));
   const o=ids.map(id=>readHostObservation(s.store,id,s.project)!).find(o=>o.claim.kind==='commit-exists')!;
   const link=evidence.linkKnowledgeEvidence(s.store,candidate(s,o.claim).id,[o.id]);
   expect(link.sourceRefs).toHaveLength(256);
   expect(s.store.list('actions').filter(a=>a.kind==='knowledge.evidence-link')).toHaveLength(1);
  }finally{s.close();}
 });
 it('rejects a 302-ref union of two authentic independent test graphs before saving private bytes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'patrick-evidence-union-'));let store=new Store(join(dir,'db'),join(dir,'vault'));
  const s=repositoryKnowledgeFixture('gitlab',{store,project:{id:'p',projectId:'p',domain:'personal',name:'P',description:'',repository:'owner/repo',repositoryProvider:'gitlab',prdPath:'docs/PRD.md',allowedPaths:['docs/'],trustedChecks:['validate'],trustedAppIds:[731,732],ownerId:'owner',autoMerge:false,budgetUsd:0,createdAt:''}});
  try{
   const b=repositoryKnowledgeFixture('gitlab',{store,project:s.project});b.source={...b.source,id:'second-source'};
   const envelope=JSON.parse(b.source.content);envelope.checks=[{runId:'53',jobId:'72',checkName:'validate'}];b.source.content=JSON.stringify(envelope);b.request.checks=envelope.checks;
   b.routes['/pipelines/53']={...b.routes['/pipelines/52'],id:53,user:{id:732}};
   b.routes['/jobs/72']={...b.routes['/jobs/71'],id:72,pipeline:{id:53,project_id:42,sha:H}};
   b.routes['/pipelines/53/jobs']=[{...b.routes['/pipelines/52/jobs'][0],id:72,pipeline:{id:53,project_id:42,sha:H}}];
   b.report.runId='53';b.report.jobId='72';b.report.checks[0]!.id='gitlab-job:72';b.routes[`/jobs/72/artifacts/${reportPath}`]=b.report;
   for(const [fixture,prefix] of [[s,'first'],[b,'second']] as const){
    const parentSources=[];
    for(let i=0;i<150;i++){const id=`${prefix}-ancestor-${i}`;store.save('sources',{...fixture.source,id,content:'Ancestral source'});parentSources.push({id,revision:'r1'});}
    fixture.source.parentSources=parentSources;if(fixture===s)fixture.source.retention='ephemeral';store.save('sources',fixture.source);
   }
   s.routes['/merge_requests/17'].web_url+='PRIVATE_G4_UNION_SENTINEL';
   s.request.testReportPath=b.request.testReportPath=reportPath;
   const firstIds=evidence.acceptRepositoryReadback(store,s.source.id,await read(s));
   const secondIds=evidence.acceptRepositoryReadback(store,b.source.id,await read(b));
   const first=firstIds.map(id=>readHostObservation(store,id,s.project)!).find(o=>o.claim.kind==='test-result')!;
   const second=secondIds.map(id=>readHostObservation(store,id,s.project)!).find(o=>o.claim.kind==='test-result')!;
   expect(first.sourceRefs).toHaveLength(151);expect(second.sourceRefs).toHaveLength(151);expect(first.claim).toEqual(second.claim);
   const card=candidate(s,first.claim);
   expect(()=>evidence.linkKnowledgeEvidence(store,card.id,[first.id,second.id])).toThrow();
   expect(store.list('actions').filter(a=>a.kind==='knowledge.evidence-link')).toEqual([]);
   await store.backup(join(dir,'backup'));store.close();
   for(const name of readdirSync(dir,{recursive:true}) as string[]){const file=join(dir,name);if(statSync(file).isFile())expect(readFileSync(file).includes(Buffer.from('PRIVATE_G4_UNION_SENTINEL'))).toBe(false);}
   store=new Store(join(dir,'db'),join(dir,'vault'));
   expect(store.list('actions').some(a=>a.id===first.id)).toBe(false);
   expect(store.list('actions').filter(a=>a.kind==='knowledge.evidence-link')).toEqual([]);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
 it.each(['oversized','malformed','nested'] as const)('keeps named %s temporary dependencies private',async kind=>{
  const dir=mkdtempSync(join(tmpdir(),'patrick-evidence-malformed-deps-'));let store=new Store(join(dir,'db'));
  try{
   store.save('sources',{id:'temporary',projectId:'p',domain:'personal',kind:'manual',externalId:'s',revision:'r',title:'temp',content:'',locator:'s',authorId:'owner',status:'active',retention:'ephemeral',createdAt:''});
   const sourceRefs=Array.from({length:256},(_,i)=>({id:`other-${i}`,revision:'r'})) as unknown[];
   sourceRefs.push({id:'temporary',revision:'r'},...(kind==='malformed'?[{id:9,revision:'r'}]:[]));
   const payload=kind==='nested'?{sourceRefs:{invalid:true},link:{sourceRefs:[{id:'temporary',revision:'r'}]},private:'PRIVATE_G4_DEPS_SENTINEL'}:{sourceRefs,private:'PRIVATE_G4_DEPS_SENTINEL'};
   store.save('actions',{id:'bad',projectId:'p',domain:'personal',kind:'knowledge.evidence-link',status:'completed',payload,updatedAt:''});
   expect(knowledgeActionSourceRefs(store.get('actions','bad')!)).toContainEqual({id:'temporary',revision:'r'});
   await store.backup(join(dir,'backup'));store.close();
   for(const name of readdirSync(dir)){const file=join(dir,name);if(statSync(file).isFile())expect(readFileSync(file).includes(Buffer.from('PRIVATE_G4_DEPS_SENTINEL'))).toBe(false);}
   store=new Store(join(dir,'db'));expect(store.get('actions','bad')).toBeUndefined();
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
 it.each([false,true])('keeps raw private canonical bytes out of SQLite/Vault/backup across reopen, parent=%s',async parent=>{
  const dir=mkdtempSync(join(tmpdir(),'patrick-evidence-retention-'));let store=new Store(join(dir,'db'),join(dir,'vault'));const base=repositoryKnowledgeFixture('gitlab');const project=base.project;base.close();const s=repositoryKnowledgeFixture('gitlab',{store,project});try{
   if(parent)store.save('sources',{...s.source,id:'temporary-parent',retention:'ephemeral',content:'PRIVATE_PARENT_SENTINEL'});
   s.source={...s.source,retention:parent?'permanent':'ephemeral',...(parent?{parentSources:[{id:'temporary-parent',revision:'r1'}]}:{})};store.save('sources',s.source);
   s.routes['/merge_requests/17'].web_url+='PRIVATE_OBSERVATION_SENTINEL';const ids=evidence.acceptRepositoryReadback(store,s.source.id,await read(s));const o=readHostObservation(store,ids[0]!,project)!;const c=candidate(s,o.claim);evidence.linkKnowledgeEvidence(store,c.id,[o.id]);
   expect(store.list('actions').filter(a=>a.kind==='knowledge.host-observation')).toHaveLength(3);expect(store.list('actions').filter(a=>a.kind==='knowledge.evidence-link')).toHaveLength(1);expect(store.list('actions').filter(a=>a.kind==='experience.test-observation')).toHaveLength(1);await store.backup(join(dir,'backup'));store.close();
   for(const name of readdirSync(dir,{recursive:true}) as string[]){const file=join(dir,name);if(statSync(file).isFile())expect(readFileSync(file).includes(Buffer.from('PRIVATE_OBSERVATION_SENTINEL'))).toBe(false);}
   store=new Store(join(dir,'db'),join(dir,'vault'));expect(store.list('actions')).toEqual([]);expect(readHostObservation(store,o.id,project)).toBeUndefined();
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
 it('rejects permanent cards depending on temporary-only observations across sources',async()=>{
  const s=repositoryKnowledgeFixture();try{s.source.retention='ephemeral';s.store.save('sources',s.source);const ids=evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s)),o=readHostObservation(s.store,ids[0]!,s.project)!;s.store.save('sources',{...s.source,id:'permanent',retention:'permanent'});const c=candidate(s,o.claim);s.store.save('cards',{...c,sourceId:'permanent'});expect(()=>evidence.linkKnowledgeEvidence(s.store,c.id,[o.id])).toThrow();}finally{s.close();}
 });
 it('reads canonical permanent evidence after reopen and redacts authority immediately on retraction',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'patrick-evidence-persist-'));let store=new Store(join(dir,'db'));const base=repositoryKnowledgeFixture();const project=base.project;base.close();const s=repositoryKnowledgeFixture('github',{store,project});try{const ids=evidence.acceptRepositoryReadback(store,s.source.id,await read(s));store.close();store=new Store(join(dir,'db'));expect(readHostObservation(store,ids[0]!,project)).toBeDefined();store.save('sources',{...s.source,status:'withdrawn'});expect(readHostObservation(store,ids[0]!,project)).toBeUndefined();}finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
});

describe('G4 canonical self-review regressions',()=>{
 it.each(['commit','head','run','job','check','producer','root','provider','ancestry','request','source'] as const)('rejects recomputed %s semantic tampering',async kind=>{
  const s=repositoryKnowledgeFixture('github');try{
   if(kind==='ancestry'){
    s.store.save('sources',{...s.source,id:'ancestor',content:'Original source'});
    s.source.parentSources=[{id:'ancestor',revision:'r1'}];s.store.save('sources',s.source);
   }
   const ids=evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s));
   const old=ids.map(id=>s.store.get('actions',id)!).find(a=>(a.payload.observation as HostObservation).claim.kind===((kind==='commit'||kind==='root'||kind==='ancestry'||kind==='request'||kind==='source')?'commit-exists':'ci-result'))!;
   const row=structuredClone(old),p=row.payload as any,o=p.observation as HostObservation;
   if(kind==='commit')(o.claim as any).subject.sha='f'.repeat(40);
   if(kind==='head')(o.claim as any).subject.headSha='f'.repeat(40);
   if(kind==='run')(o.claim as any).subject.runId='53';
   if(kind==='job')(o.claim as any).subject.jobId='72';
   if(kind==='check')(o.claim as any).subject.checkName='other';
   if(kind==='producer'){o.origin.producerId='999';o.origin.independentOrigin='github:42:producer:999';}
   if(kind==='root')o.origin.originalEventId='github:42:commit:'+('f'.repeat(40));
   if(kind==='provider'){o.origin.provider='gitlab';(o.claim as any).subject.provider='gitlab';}
   if(kind==='ancestry')o.origin.derivedFrom=[];
   if(kind==='request')p.request.headSha='f'.repeat(40);
   if(kind==='source')p.sourceHash='f'.repeat(64);
   if(kind==='request'||kind==='source'){
    p.requestHash=digest(p.request);
    o.bindingHash=digest({source:p.sourceHash,policy:p.policyHash,request:p.request});
   }
   o.id=hostObservationId(o);row.id=o.id;p.digest=digest(o);
   s.store.delete('actions',old.id);s.store.save('actions',row);
   expect(readHostObservation(s.store,row.id,s.project)).toBeUndefined();
  }finally{s.close();}
 });
 it('rejects rehashed canonical origin tampering rather than accepting the old observation ID',async()=>{
  const s=repositoryKnowledgeFixture();try{const ids=evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s)),a=s.store.get('actions',ids[0]!)!,o=a.payload.observation as HostObservation;o.origin.independentOrigin='invented-independent-origin';a.payload.digest=digest(o);s.store.save('actions',a);expect(readHostObservation(s.store,a.id,s.project)).toBeUndefined();}finally{s.close();}
 });
 it('rejects a malformed previously occupied canonical link ID',async()=>{
  const s=repositoryKnowledgeFixture();try{const ids=evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s)),o=readHostObservation(s.store,ids[0]!,s.project)!,c=candidate(s,o.claim);evidence.linkKnowledgeEvidence(s.store,c.id,[o.id]);const a=s.store.list('actions').find(a=>a.kind==='knowledge.evidence-link')!;s.store.save('actions',{...a,payload:{schemaVersion:1,link:{invented:true}}});expect(()=>evidence.linkKnowledgeEvidence(s.store,c.id,[o.id])).toThrow();}finally{s.close();}
 });
 it('migrates retained canonical actions into memory when their source becomes ephemeral',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'patrick-evidence-transition-'));let store=new Store(join(dir,'db'));const base=repositoryKnowledgeFixture();const project=base.project;base.close();const s=repositoryKnowledgeFixture('github',{store,project});try{evidence.acceptRepositoryReadback(store,s.source.id,await read(s));expect(store.list('actions').filter(a=>a.kind==='knowledge.host-observation')).toHaveLength(3);expect(store.list('actions').filter(a=>a.kind==='experience.test-observation')).toHaveLength(1);store.save('sources',{...s.source,retention:'ephemeral'});expect(store.list('actions').filter(a=>a.kind==='knowledge.host-observation')).toHaveLength(3);expect(store.list('actions').filter(a=>a.kind==='experience.test-observation')).toHaveLength(1);store.close();store=new Store(join(dir,'db'));expect(store.list('actions')).toEqual([]);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
 it('keeps named malformed payloads with explicit temporary dependencies private while refusing their authority',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'patrick-evidence-malformed-'));let store=new Store(join(dir,'db'));try{store.save('sources',{id:'s',projectId:'p',domain:'personal',kind:'manual',externalId:'s',revision:'r',title:'temp',content:'',locator:'s',authorId:'owner',status:'active',retention:'ephemeral',createdAt:''});store.save('actions',{id:'bad',projectId:'p',domain:'personal',kind:'knowledge.host-observation',status:'completed',payload:{schemaVersion:1,sourceRefs:[{id:'s',revision:'r'}],private:'MALFORMED_PRIVATE_SENTINEL'},updatedAt:''});expect(readHostObservation(store,'bad',{projectId:'p',domain:'personal'})).toBeUndefined();store.close();expect(readFileSync(join(dir,'db')).includes(Buffer.from('MALFORMED_PRIVATE_SENTINEL'))).toBe(false);store=new Store(join(dir,'db'));expect(store.list('actions')).toEqual([]);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
});

describe('authenticated canonical source ancestry comparison',()=>{
 it.each(['independent','mirrored','derived','unknown'] as const)('uses real reader executions and host source edges for %s',async kind=>{
  const a=repositoryKnowledgeFixture('gitlab');try{
   a.project.trustedAppIds=[731,732];a.store.save('projects',a.project);
   const b=repositoryKnowledgeFixture('gitlab',{store:a.store,project:a.project});b.source={...b.source,id:'second-source'};
   if(kind==='mirrored'){
    a.store.save('sources',{...a.source,id:'root',content:'Original repository report'});
    a.source.parentSources=b.source.parentSources=[{id:'root',revision:'r1'}];a.store.save('sources',a.source);
   }
   if(kind==='derived')b.source.parentSources=[{id:a.source.id,revision:a.source.revision}];
   if(kind==='unknown')b.source.parentSources=[{id:'missing',revision:'r1'}];
   const envelope=JSON.parse(b.source.content);envelope.checks=[{runId:'53',jobId:'72',checkName:'validate'}];b.source.content=JSON.stringify(envelope);b.store.save('sources',b.source);b.request.checks=envelope.checks;
   b.routes['/pipelines/53']={...b.routes['/pipelines/52'],id:53,user:{id:732}};
   b.routes['/jobs/72']={...b.routes['/jobs/71'],id:72,pipeline:{id:53,project_id:42,sha:H}};
   b.routes['/pipelines/53/jobs']=[{...b.routes['/pipelines/52/jobs'][0],id:72,pipeline:{id:53,project_id:42,sha:H}}];
   b.report.runId='53';b.report.jobId='72';b.report.checks[0]!.id='gitlab-job:72';b.routes[`/jobs/72/artifacts/${reportPath}`]=b.report;
   a.request.testReportPath=b.request.testReportPath=reportPath;
   const ids=evidence.acceptRepositoryReadback(a.store,a.source.id,await read(a)),first=ids.map(id=>readHostObservation(a.store,id,a.project)!).find(o=>o.claim.kind==='test-result')!;
   if(kind==='unknown'){await expect(read(b)).rejects.toBeDefined();return;}
   const secondIds=evidence.acceptRepositoryReadback(b.store,b.source.id,await read(b)),second=secondIds.map(id=>readHostObservation(b.store,id,b.project)!).find(o=>o.claim.kind==='test-result')!;
   expect(first.claim).toEqual(second.claim);expect(first.origin.originalEventId).not.toBe(second.origin.originalEventId);expect(first.origin.independentOrigin).not.toBe(second.origin.independentOrigin);
   expect(evidence.compareIndependentClaim(first.claim,[first,second])).toBe(kind==='independent');
   b.close();
  }finally{a.close();}
 });
});

it('retains historical canonical authority across cosmetic project changes and loses it on parent withdrawal',async()=>{
 const s=repositoryKnowledgeFixture();try{
  s.store.save('sources',{...s.source,id:'ancestor',content:'Authentic repository source'});s.source.parentSources=[{id:'ancestor',revision:'r1'}];s.store.save('sources',s.source);
  const ids=evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s));s.store.save('projects',{...s.project,name:'Renamed',description:'Cosmetic'});expect(readHostObservation(s.store,ids[0]!,s.project)).toBeDefined();
  s.store.save('sources',{...s.store.get('sources','ancestor')!,status:'withdrawn'});expect(readHostObservation(s.store,ids[0]!,s.project)).toBeUndefined();
 }finally{s.close();}
});

it('limits independent comparison to the reviewed test-result family',()=>{
 const a=observation('a','execution:a','producer:a'),b=observation('b','execution:b','producer:b');
 const claim:AtomicClaim={kind:'commit-exists',subject:{provider:'gitlab',repository:'owner/repo',sha:H},value:{exists:true}};a.claim=b.claim=claim;
 expect(evidence.compareIndependentClaim(claim,[a,b])).toBe(false);
});

// Second review packet: these exercise real admitted rows before recomputed mutations.
function currentReviewFixture(){
 const s=repositoryKnowledgeFixture('gitlab');
 s.project.trustedChecks=['validate','other'];s.store.save('projects',s.project);
 s.request.current={changeNumber:18,checkNames:['validate','other']};
 s.routes['/merge_requests/18']={...s.routes['/merge_requests/17'],iid:18};
 s.routes['/merge_requests/18/pipelines']=[{id:53,sha:H2},{id:54,sha:H2}];
 s.routes['/pipelines/53']={...s.routes['/pipelines/52'],id:53,sha:H2};
 s.routes['/pipelines/54']={...s.routes['/pipelines/52'],id:54,sha:H2};
 s.routes['/jobs/72']={...s.routes['/jobs/71'],id:72,pipeline:{id:53,project_id:42,sha:H2},commit:{id:H2}};
 s.routes['/jobs/73']={...s.routes['/jobs/71'],id:73,name:'other',pipeline:{id:54,project_id:42,sha:H2},commit:{id:H2}};
 s.routes['/pipelines/53/jobs']=[{...s.routes['/pipelines/52/jobs'][0],id:72,pipeline:{id:53,project_id:42,sha:H2},commit:{id:H2}}];
 s.routes['/pipelines/54/jobs']=[{...s.routes['/pipelines/52/jobs'][0],id:73,name:'other',pipeline:{id:54,project_id:42,sha:H2},commit:{id:H2}}];
 return s;
}
function sameHeadCurrentReviewFixture(){
 const s=currentReviewFixture();
 s.routes['/merge_requests/18'].sha=H;
 s.routes['/merge_requests/18/pipelines']=[{id:52,sha:H}];
 s.routes['/jobs/72']={...s.routes['/jobs/71'],id:72,name:'other',pipeline:{id:52,project_id:42,sha:H},commit:{id:H}};
 s.routes['/pipelines/52/jobs']=[s.routes['/pipelines/52/jobs'][0],{id:72,name:'other',pipeline:{id:52,project_id:42,sha:H},commit:{id:H}}];
 return s;
}
function rehashRow(s:ReturnType<typeof repositoryKnowledgeFixture>,id:string,mutate:(p:any)=>void,remove=true){
 const row=structuredClone(s.store.get('actions',id)!);const p=row.payload as any;mutate(p);
 p.observation.id=hostObservationId(p.observation);p.digest=digest(p.observation);row.id=p.observation.id;
 if(remove)s.store.delete('actions',id);s.store.save('actions',row);return row.id;
}

describe('independent historical execution constraints',()=>{
 it.each([
  {name:'a known job in a different run at the current head',run:'53',job:'71'},
  {name:'a known run with a different job at the current head',run:'52',job:'72'},
 ])('rejects $name',async({run,job})=>{
  const s=currentReviewFixture();try{
   const ids=evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s));
   const rows=ids.map(id=>readHostObservation(s.store,id,s.project)!);
   const historical=rows.find(o=>o.claim.kind==='ci-result'&&o.claim.subject.runId==='52')!;
   expect(historical.claim).toMatchObject({subject:{headSha:H,runId:'52',jobId:'71',checkName:'validate'}});
   expect(rows).toContainEqual(expect.objectContaining({claim:expect.objectContaining({kind:'change-head',subject:expect.objectContaining({number:18}),value:expect.objectContaining({headSha:H2})})}));
   expect(rows).toContainEqual(expect.objectContaining({claim:expect.objectContaining({kind:'ci-result',subject:expect.objectContaining({headSha:H2,runId:'53',jobId:'72'})})}));
   const changed=rehashRow(s,historical.id,p=>{
    Object.assign(p.observation.claim.subject,{headSha:H2,runId:run,jobId:job});
    p.observation.origin.originalEventId=`gitlab:42:pipeline:${run}:job:${job}`;
   });
   expect(readHostObservation(s.store,changed,s.project)).toBeUndefined();
  }finally{s.close();}
 });
 it.each([
  {name:'a known job in another run at the same head',run:'53',check:'validate'},
  {name:'a known job under a different check name',run:'52',check:'other'},
 ])('rejects $name',async({run,check})=>{
  const s=sameHeadCurrentReviewFixture();try{
   const ids=evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s));
   const rows=ids.map(id=>readHostObservation(s.store,id,s.project)!);
   const historical=rows.find(o=>o.claim.kind==='ci-result'&&o.claim.subject.jobId==='71')!;
   expect(rows).toContainEqual(expect.objectContaining({claim:expect.objectContaining({kind:'change-head',subject:expect.objectContaining({number:18}),value:expect.objectContaining({headSha:H})})}));
   const changed=rehashRow(s,historical.id,p=>{
    Object.assign(p.observation.claim.subject,{runId:run,checkName:check});
    p.observation.origin.originalEventId=`gitlab:42:pipeline:${run}:job:71`;
   });
   expect(readHostObservation(s.store,changed,s.project)).toBeUndefined();
  }finally{s.close();}
 });
 it('keeps an authorized new job in the historical run at the same head readable',async()=>{
  const s=sameHeadCurrentReviewFixture();try{
   const ids=evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s));
   const claims=ids.map(id=>readHostObservation(s.store,id,s.project)?.claim);
   expect(claims).toContainEqual({kind:'ci-result',subject:{provider:'gitlab',repository:s.project.repository,headSha:H,runId:'52',jobId:'71',checkName:'validate'},value:{conclusion:'success'}});
   expect(claims).toContainEqual({kind:'ci-result',subject:{provider:'gitlab',repository:s.project.repository,headSha:H,runId:'52',jobId:'72',checkName:'other'},value:{conclusion:'success'}});
  }finally{s.close();}
 });
});

describe('G4 second packet retained consistency and privacy',()=>{
 it('binds a historical execution to its requested head even with a real current selection',async()=>{
  const s=currentReviewFixture();try{
   const ids=evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s));
   const rows=ids.map(id=>readHostObservation(s.store,id,s.project)!);
   const historical=rows.find(o=>o.claim.kind==='ci-result'&&o.claim.subject.runId==='52')!;
   expect(historical.claim).toMatchObject({subject:{headSha:H,jobId:'71',checkName:'validate'}});
   expect(rows.filter(o=>o.claim.kind==='ci-result'&&o.claim.subject.headSha===H2)).toHaveLength(2);
   const changed=rehashRow(s,historical.id,p=>{p.observation.claim.subject.headSha=H2;});
   expect(readHostObservation(s.store,changed,s.project)).toBeUndefined();
  }finally{s.close();}
 });
 it('binds the current CI repository ID to its admitted current change-head',async()=>{
  const s=currentReviewFixture();try{
   const ids=evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s));
   const rows=ids.map(id=>readHostObservation(s.store,id,s.project)!);
   const current=rows.find(o=>o.claim.kind==='ci-result'&&o.claim.subject.runId==='53')!;
   expect(current).toBeDefined();expect(rows.filter(o=>o.claim.kind==='ci-result'&&o.claim.subject.headSha===H2)).toHaveLength(2);
   const changed=rehashRow(s,current.id,p=>{p.observation.origin.originalEventId=p.observation.origin.originalEventId.replace('gitlab:42:','gitlab:99:');p.observation.origin.independentOrigin='gitlab:99:producer:731';});
   expect(readHostObservation(s.store,changed,s.project)).toBeUndefined();
  }finally{s.close();}
 });
 it('rejects a repository ID outside the provider positive safe-integer schema',async()=>{
  const s=repositoryKnowledgeFixture('gitlab');try{
   const ids=evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s));
   const commit=ids.map(id=>readHostObservation(s.store,id,s.project)!).find(o=>o.claim.kind==='commit-exists')!;expect(commit).toBeDefined();
   const changed=rehashRow(s,commit.id,p=>{p.observation.origin.originalEventId=p.observation.origin.originalEventId.replace('gitlab:42:','gitlab:999999999999999999999999:');p.observation.origin.independentOrigin='gitlab:999999999999999999999999:producer:repository';});
   expect(readHostObservation(s.store,changed,s.project)).toBeUndefined();
  }finally{s.close();}
 });
 it.each(['other-trusted-producer','failure','incomplete','missing-ci','contradictory-ci'] as const)('requires matching successful admitted CI for an attested report: %s',async kind=>{
  const s=repositoryKnowledgeFixture('gitlab');try{
   s.project.trustedAppIds=[731,732];s.store.save('projects',s.project);s.request.testReportPath=reportPath;
   const ids=evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s));
   const rows=ids.map(id=>readHostObservation(s.store,id,s.project)!);
   const test=rows.find(o=>o.claim.kind==='test-result')!,ci=rows.find(o=>o.claim.kind==='ci-result')!;
   expect(test).toBeDefined();expect(ci.claim).toMatchObject({value:{conclusion:'success'}});expect(test.origin.originalEventId).toBe(ci.origin.originalEventId);
   let testId=test.id;
   if(kind==='other-trusted-producer')testId=rehashRow(s,test.id,p=>{p.observation.origin.producerId='732';p.observation.origin.independentOrigin='gitlab:42:producer:732';p.attestation.producerId='732';});
   if(kind==='failure'||kind==='incomplete')testId=rehashRow(s,test.id,p=>{p.observation.claim.value.result=kind;});
   if(kind==='missing-ci')s.store.delete('actions',ci.id);
   if(kind==='contradictory-ci')rehashRow(s,ci.id,p=>{p.observation.claim.value.conclusion='failure';},false);
   expect(readHostObservation(s.store,testId,s.project)).toBeUndefined();
  }finally{s.close();}
 });
 it.each(['direct','nested','unknown','unidentifiable','primitive'] as const)('keeps %s malformed dependencies private through backup and reopen',async kind=>{
  const dir=mkdtempSync(join(tmpdir(),'patrick-evidence-fix2-private-'));let store=new Store(join(dir,'db'),join(dir,'vault'));
  try{
   const base={projectId:'p',domain:'personal',kind:'manual' as const,externalId:'s',revision:'r',title:'source',content:'',locator:'s',authorId:'owner',status:'active' as const,createdAt:''};
   store.save('sources',{...base,id:'temporary',retention:'ephemeral'});store.save('sources',{...base,id:'permanent',retention:'permanent'});
   const malformed={id:'temporary',revision:9};
   const payload=kind==='direct'?{sourceRefs:[malformed]}:kind==='nested'?{sourceRefs:[{id:'permanent',revision:'r'}],observation:{sourceRefs:[malformed]}}:kind==='unidentifiable'?{sourceRefs:[{revision:'r'}]}:{sourceRefs:{unexpected:[malformed]}};
   const row={id:'malformed',projectId:'p',domain:'personal',kind:'knowledge.host-observation',status:'completed' as const,payload:kind==='primitive'?'PRIVATE_FIX2_MALFORMED_SENTINEL' as any:{...payload,private:'PRIVATE_FIX2_MALFORMED_SENTINEL'},updatedAt:''};
   store.save('actions',row);expect(readHostObservation(store,row.id,{projectId:'p',domain:'personal'})).toBeUndefined();
   if(kind==='direct'||kind==='nested')expect(knowledgeActionSourceRefs(row).map(ref=>ref.id)).toContain('temporary');
   expect(()=>store.transaction(()=>{store.save('actions',{...row,id:'rollback'});throw Error('rollback');})).toThrow('rollback');expect(store.get('actions','rollback')).toBeUndefined();
   await store.backup(join(dir,'backup'));store.close();
   for(const name of readdirSync(dir,{recursive:true}) as string[]){const file=join(dir,name);if(statSync(file).isFile())expect(readFileSync(file).includes(Buffer.from('PRIVATE_FIX2_MALFORMED_SENTINEL'))).toBe(false);}
   store=new Store(join(dir,'db'),join(dir,'vault'));expect(store.get('actions',row.id)).toBeUndefined();
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
 it('migrates a malformed-revision dependency when its known source becomes temporary',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'patrick-evidence-fix2-migrate-'));let store=new Store(join(dir,'db'));
  try{
   const source={id:'temporary',projectId:'p',domain:'personal',kind:'manual' as const,externalId:'s',revision:'r',title:'source',content:'',locator:'s',authorId:'owner',status:'active' as const,retention:'permanent' as const,createdAt:''};
   store.save('sources',source);const row={id:'migration',projectId:'p',domain:'personal',kind:'knowledge.evidence-link',status:'completed' as const,payload:{sourceRefs:[{id:'temporary',revision:9}],private:'PRIVATE_FIX2_MIGRATION_SENTINEL'},updatedAt:''};
   store.save('actions',row);expect(knowledgeActionSourceRefs(row).map(ref=>ref.id)).toContain('temporary');
   store.close();store=new Store(join(dir,'db'));expect(store.get('actions',row.id)).toBeDefined();
   store.save('sources',{...source,retention:'ephemeral'});expect(store.get('actions',row.id)).toBeDefined();
   await store.backup(join(dir,'backup'));store.close();
   for(const name of readdirSync(dir)){const file=join(dir,name);if(statSync(file).isFile())expect(readFileSync(file).includes(Buffer.from('PRIVATE_FIX2_MIGRATION_SENTINEL'))).toBe(false);}
   store=new Store(join(dir,'db'));expect(store.get('actions',row.id)).toBeUndefined();
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
 it.each(['empty-observation','null-payload'] as const)('ignores %s current-head candidates and returns undefined after the valid head is removed',async kind=>{
  const s=currentReviewFixture();try{
   s.source.retention='ephemeral';s.store.save('sources',s.source);
   const ids=evidence.acceptRepositoryReadback(s.store,s.source.id,await read(s));const rows=ids.map(id=>readHostObservation(s.store,id,s.project)!);
   const currents=rows.filter(o=>o.claim.kind==='ci-result'&&o.claim.subject.headSha===H2);expect(currents).toHaveLength(2);
   const head=rows.find(o=>o.claim.kind==='change-head'&&o.claim.subject.number===18)!;
   const headRow=s.store.get('actions',head.id)!,template=s.store.get('actions',currents[0]!.id)!;
   s.store.delete('actions',head.id);s.store.save('actions',{...template,id:'malformed-before-head',payload:kind==='null-payload'?null as any:{...template.payload,observation:{}}});s.store.save('actions',headRow);
   expect(s.store.list('actions').findIndex(a=>a.id==='malformed-before-head')).toBeLessThan(s.store.list('actions').findIndex(a=>a.id===head.id));
   for(const current of currents)expect(readHostObservation(s.store,current.id,s.project)).toEqual(current);
   s.store.delete('actions',head.id);for(const current of currents)expect(readHostObservation(s.store,current.id,s.project)).toBeUndefined();
  }finally{s.close();}
 });
});
