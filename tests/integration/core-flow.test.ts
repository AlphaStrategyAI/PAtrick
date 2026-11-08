import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/store.js';
import { ingestSource } from '../../src/intake.js';
import { publishObservations } from '../../src/standards.js';
import { Workbench } from '../../src/orchestrator.js';
import { createBackup } from '../../src/backup.js';
import { restoreBackup } from '../../scripts/restore.js';
import { digest, stableId, DomainError, WorkerUnavailable, type AppConfig, type DeliveryReceipt, type Project, type Role, type Runner, type WorkerAdapter, type WorkerInput, type ResearchRecord, type OutboxMessage } from '../../src/domain.js';
import { openReleaseFollowUp } from '../../src/operations.js';
import { createApp } from '../../src/app.js';
import { weeklyReport } from '../../src/reports.js';

const roots: string[] = []; const stores: Store[] = [];
const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: 'Product', description: 'Test', repository: 'owner/product', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/'], trustedChecks: ['test'], trustedAppIds: [123], ownerId: 'owner', autoMerge: true, budgetUsd: 10, createdAt: new Date().toISOString() };
const research: ResearchRecord = { queries: (['zh', 'en'] as const).map(language => ({ language, query: language === 'zh' ? '草稿 恢复' : 'draft recovery', searchedAt: new Date().toISOString(), sources: [{ language, url: `https://${language}.example.com/original`, canonicalUrl: `https://${language}.example.com/original`, title: 'Source', publishedAt: '2026-01-01', accessedAt: new Date().toISOString(), excerpt: 'Evidence for both alternatives', primary: true, conditions: 'Draft export' }] })), summary: 'A and B both viable', gaps: [] };
const suggestion = (label: string) => ({ label, description: `Choose ${label}`, rationale: 'Evidence', tradeoff: 'A cost', evidenceUrls: research.queries.flatMap(q => q.sources.map(s => s.url)) });
interface Options { ask?: boolean; noReceipt?: boolean; badReview?: boolean; badFeedback?: boolean; repair?: number; workerUnavailable?: Partial<Record<Runner, Role[]>>; budget?: number; notifierOffline?: boolean; research?: ResearchRecord; researchFromQuestion?: (question: string) => ResearchRecord; mutateOutput?: (input: WorkerInput, output: unknown) => unknown; beforeRun?: (input: WorkerInput) => Promise<void>; canRun?: (project: Project) => boolean; mutateReceipt?: (receipt: DeliveryReceipt) => DeliveryReceipt }
function setup(options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'patrick-core-flow-')); roots.push(root);
  const store = new Store(join(root, 'db.sqlite'), join(root, 'vault')); stores.push(store);
  const p = { ...project, budgetUsd: options.budget ?? 10 }; store.save('projects', p);
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: root, vaultDir: join(root, 'vault'), ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [p], scanIntervalMs: 1000, workers: {}, runnerPolicies: (['grok', 'dsh', 'codex'] as const).map(runner => ({ runner, roles: ['knowledge_extract', 'case_extract', 'decide', 'plan', 'execute', 'check', 'feedback'], domains: ['personal'], provider: `${runner}-provider`, model: `${runner}-model`, admitted: true, costPerRunUsd: .01, independentReview: false })) };
  const calls: { runner: Runner; role: Role; input: WorkerInput }[] = []; const notifications: OutboxMessage[] = []; let checks = 0; let deliveries = 0;
  const workers: WorkerAdapter[] = (['grok', 'dsh', 'codex'] as const).map(name => ({ name, async run(input) {
    calls.push({ runner: name, role: input.role, input: structuredClone(input) });
    if (options.beforeRun) await options.beforeRun(input);
    if (options.workerUnavailable?.[name]?.includes(input.role)) throw new WorkerUnavailable(`${name} offline`);
    let output: unknown;
    if (input.role === 'knowledge_extract') output = { cards: [{ title: '草稿恢复', body: '保留草稿以供恢复', quote: '保留草稿', aliases: ['恢复'], verification: 'reported', kind: 'fact' }] };
    if (input.role === 'case_extract') output = { observations: [{ title: 'Candidate', statement: '保留草稿', quote: '保留草稿', conditions: 'This source', exceptions: 'unknown' }] };
    if (input.role === 'decide') output = { action: options.ask && !input.answer ? 'ask' : 'proceed', summary: 'Update PRD', rationale: 'Evidence supports update', citations: [{ sourceId: input.source.id, revision: input.source.revision, quote: '保留草稿', locator: input.source.locator }], ruleIds: [], grounds:{statements:[{citation:{sourceId:input.source.id,revision:input.source.revision,quote:'保留草稿',locator:input.source.locator},purpose:'requirement',binding:'task-request'}],facts:[],unresolved:[]}, ...(options.ask && !input.answer ? { question: { title: 'Retain drafts?', context: 'Two viable approaches', A: suggestion('Retain'), B: suggestion('Delete') } } : {}) };
    if (input.role === 'plan') output = { taskVersion: input.task.version, sourceRevision: input.task.sourceRevision, baselineSha: 'baseline', summary: 'Update PRD', paths: ['docs/PRD.md'], steps: ['Update'], tests: ['test'], stopConditions: ['Source changes'] };
    if (input.role === 'execute') output = { taskVersion: input.task.version, planHash: digest(input.plan!), baselineSha: input.plan!.baselineSha, files: [{ path: 'docs/PRD.md', content: '# PRD\nKeep drafts.' }], tests: [{ command: 'test', passed: true, output: '1 passed' }], summary: 'Updated' };
    if (input.role === 'check') { checks++; output = { taskVersion: input.task.version, planHash: digest(input.plan!), artifactHash: digest(input.artifact!), verdict: options.badReview || checks <= (options.repair ?? 0) ? 'repair' : 'pass', summary: 'Independent checks', issues: [], tests: [{ command: 'test', passed: !(options.badReview || checks <= (options.repair ?? 0)), output: options.badReview ? 'failed' : '1 passed' }] }; }
    if (input.role === 'feedback') output = options.badFeedback ? { summary: '', observations: [] } : { summary: 'Merged and verified', observations: ['Successful delivery'] };
    return { output: options.mutateOutput?.(input, output) ?? output, costUsd: .01, model: `${name}-model`, provider: `${name}-provider` };
  } }));
  const writer = { async baseline() { return 'baseline'; }, async deliver(task: WorkerInput['task']) { deliveries++; if (options.noReceipt) throw new Error('remote offline'); const receipt = { id: `receipt-${task.id}`, projectId: task.projectId, domain: task.domain, taskId: task.id, repository: p.repository, path: p.prdPath, pullRequestUrl: 'https://github.com/owner/product/pull/1', pullRequestNumber: 1, headSha: 'head', mergeSha: 'merged', contentHash: digest(task.artifact!.files.find(f => f.path === p.prdPath)!.content), verifiedAt: new Date().toISOString(), checks: [{ name: 'test', conclusion: 'success', headSha: 'head', appId: 123, url: 'https://github.com/owner/product/actions/1' }] } satisfies DeliveryReceipt; return options.mutateReceipt?.(receipt) ?? receipt; } };
  const notifier = { async send(message: OutboxMessage) { if (options.notifierOffline) throw new Error('notifier offline'); notifications.push(message); return { remoteId: `remote-${message.id}` }; } };
  const create = (target = store) => new Workbench({ store: target, config, workers, writer, research: { async research(question) { return options.researchFromQuestion?.(question) ?? options.research ?? research; } }, notifier, canRun: options.canRun });
  const engine = create();
  const ingest = () => engine.ingest({ projectId: 'p', externalId: 'idea', kind: 'manual', title: 'Draft handling', content: '导出失败后保留草稿，以供恢复。', authorId: 'owner' })!;
  return { store, config, engine, calls, notifications, ingest, create, options, deliveryCount: () => deliveries };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function workerStarted(calls: unknown[]) {
  for (let turn = 0; turn < 32 && calls.length === 0; turn++) await Promise.resolve();
  expect(calls).toHaveLength(1);
}

describe('single worker durable business flow', () => {
  it('rejects a quote missing from the source and counts that rejection once', async () => {
    const f = setup({ mutateOutput: (input, output) => input.role === 'knowledge_extract' ? { cards: [{ title: '伪造', body: '伪造', quote: '这句话不在原文里', aliases: [], verification: 'reported', kind: 'fact' }] } : output });
    try {
      const task = f.ingest();
      await f.engine.tick();
      expect(f.store.list('cards')).toEqual([]);
      expect(f.store.get('tasks', task.id)?.status).toBe('blocked');
      expect(f.store.list('events').filter(event => event.type === 'citation.rejected')).toHaveLength(1);
      expect(weeklyReport(f.store, { projectId: 'p', domain: 'personal' }).metrics.incorrectCitations).toBe(1);
      await f.engine.tick();
      expect(f.store.list('events').filter(event => event.type === 'citation.rejected')).toHaveLength(1);
    } finally { await f.engine.shutdown(); }
  });

  it.each(['rule','citation'] as const)('does not admit an effective-temporary descendant as a permanent-task %s',async mode=>{
    let dependent:{id:string;revision:string;content:string;locator:string}|undefined;
    const f=setup({mutateOutput:(input,output)=>input.role==='decide'&&mode==='citation'&&dependent?{...output as object,citations:[...(output as {citations:unknown[]}).citations,{sourceId:dependent.id,revision:dependent.revision,quote:dependent.content,locator:dependent.locator}]}:output});
    try{
      f.engine.ingest({projectId:'p',externalId:'guard-parent',revision:'v1',title:'Parent',content:'Parent',retention:'ephemeral',purpose:'reference'});
      const parent=f.store.list('sources').find(source=>source.externalId==='guard-parent')!;
      ingestSource(f.store,f.config,{projectId:'p',externalId:'guard-child',revision:'v1',title:'Child',content:'TEMPORARY_DESCENDANT_CITATION',retention:'permanent',purpose:'reference'},[{id:parent.id,revision:parent.revision}]);
      dependent=f.store.list('sources').find(source=>source.externalId==='guard-child')!;
      const [rule]=publishObservations(f.store,dependent as typeof parent,{observations:[{title:'Temporary rule',statement:'Temporary rule',quote:dependent.content,conditions:'Always',exceptions:'None'}]});
      const task=f.ingest();
      for(let i=0;i<20&&!f.calls.some(call=>call.role==='decide'&&call.input.task.id===task.id);i++)await f.engine.tick();
      const input=f.calls.find(call=>call.role==='decide'&&call.input.task.id===task.id)!.input;
      if(mode==='rule')expect(input.rules.some(value=>value.id===rule!.id)).toBe(false);
      else {expect(f.store.get('tasks',task.id)).toMatchObject({stage:'decide',status:'blocked'});expect(f.store.list('actions').some(action=>action.taskId===task.id&&action.kind==='decision.snapshot')).toBe(false);}
    }finally{await f.engine.shutdown();}
  });

  it('reconstructs an explicitly retried permanent-labeled child after temporary ancestry and a consumed stage',async()=>{
    const f=setup(),parentInput={projectId:'p',externalId:'retry-parent',revision:'v1',title:'Parent',content:'Parent',retention:'ephemeral' as const,purpose:'reference' as const};
    const childInput={projectId:'p',kind:'conversation' as const,externalId:'retry-child',revision:'v1',title:'Child',content:'保留草稿',retention:'permanent' as const};
    f.engine.ingest(parentInput);const parent=f.store.list('sources').find(source=>source.externalId===parentInput.externalId)!;
    const task=ingestSource(f.store,f.config,childInput,[{id:parent.id,revision:parent.revision}])!;let engine=f.engine;
    try{
      while(f.store.get('tasks',task.id)?.stage!=='execute')await engine.tick();
      const before=f.store.get('tasks',task.id)!,transaction=f.store.transaction.bind(f.store);let injected=false;
      const fault=vi.spyOn(f.store,'transaction').mockImplementation(((fn:()=>unknown)=>{
        if(!injected&&new Error().stack?.includes('Workbench.process')&&f.store.list('attempts').some(attempt=>attempt.taskId===task.id&&attempt.role==='execute'&&attempt.taskVersion===before.version&&attempt.status==='succeeded')){injected=true;throw Object.assign(new Error('post-result fault'),{code:'SQLITE_BUSY'});}
        return transaction(fn);
      }) as typeof f.store.transaction);
      await expect(engine.tick()).rejects.toMatchObject({code:'SQLITE_BUSY'});fault.mockRestore();expect(injected).toBe(true);
      const calls=f.calls.filter(call=>call.role==='execute').length;await engine.shutdown();f.store.close();
      const reopened=new Store(join(f.config.dataDir,'db.sqlite'),f.config.vaultDir);stores.push(reopened);engine=f.create(reopened);
      engine.ingest(parentInput);const restored=engine.ingest(childInput)!;
      expect(restored).toMatchObject({id:task.id,version:before.version,stage:'execute',status:'blocked'});
      await engine.tick();expect(f.calls.filter(call=>call.role==='execute')).toHaveLength(calls);
      const retried=engine.retry(task.id);
      expect(retried).toMatchObject({version:before.version+1,stage:'knowledge_extract',status:'queued'});
      expect(f.calls.filter(call=>call.role==='execute')).toHaveLength(calls);
    }finally{await engine.shutdown();}
  });

  it('allows active temporary tasks to use temporary-derived rules and citations',async()=>{
    let dependent:{id:string;revision:string;content:string;locator:string}|undefined;
    const f=setup({mutateOutput:(input,output)=>input.role==='decide'&&dependent?{...output as object,citations:[...(output as {citations:unknown[]}).citations,{sourceId:dependent.id,revision:dependent.revision,quote:dependent.content,locator:dependent.locator}]}:output});
    try{
      f.engine.ingest({projectId:'p',externalId:'temporary-rule-parent',revision:'v1',title:'Parent',content:'Parent',retention:'ephemeral',purpose:'reference'});
      const parent=f.store.list('sources').find(source=>source.externalId==='temporary-rule-parent')!;
      ingestSource(f.store,f.config,{projectId:'p',externalId:'temporary-rule-child',revision:'v1',title:'Child',content:'Temporary citation',retention:'permanent',purpose:'reference'},[{id:parent.id,revision:parent.revision}]);
      dependent=f.store.list('sources').find(source=>source.externalId==='temporary-rule-child')!;
      const [rule]=publishObservations(f.store,dependent as typeof parent,{observations:[{title:'Temporary rule',statement:'Temporary rule',quote:dependent.content,conditions:'Always',exceptions:'None'}]});
      const task=f.engine.ingest({projectId:'p',externalId:'temporary-guard-task',title:'Task',content:'保留草稿',retention:'ephemeral'})!;
      for(let i=0;i<20&&f.store.get('tasks',task.id)?.stage!=='plan';i++)await f.engine.tick();
      expect(f.store.get('tasks',task.id)?.stage).toBe('plan');
      expect(f.calls.find(call=>call.role==='decide'&&call.input.task.id===task.id)?.input.rules.some(value=>value.id===rule!.id)).toBe(true);
    }finally{await f.engine.shutdown();}
  });

  it('preserves completed delivery identity when a permanent-labeled child loses temporary feedback context',async()=>{
    const f=setup(),parentInput={projectId:'p',externalId:'feedback-ancestor',revision:'v1',title:'Parent',content:'Parent',retention:'ephemeral' as const,purpose:'reference' as const};
    const childInput={projectId:'p',kind:'conversation' as const,externalId:'feedback-descendant',revision:'v1',title:'Child',content:'保留草稿',retention:'permanent' as const};
    f.engine.ingest(parentInput);const parent=f.store.list('sources').find(source=>source.externalId===parentInput.externalId)!;
    const task=ingestSource(f.store,f.config,childInput,[{id:parent.id,revision:parent.revision}])!;let engine=f.engine;
    try{
      while(f.store.get('tasks',task.id)?.stage!=='feedback')await engine.tick();
      const before=f.store.get('tasks',task.id)!;expect(before.receiptId).toBeTruthy();expect(f.deliveryCount()).toBe(1);
      await engine.shutdown();f.store.close();const reopened=new Store(join(f.config.dataDir,'db.sqlite'),f.config.vaultDir);stores.push(reopened);engine=f.create(reopened);
      engine.ingest(parentInput);const restored=engine.ingest(childInput)!;
      expect(restored).toMatchObject({id:task.id,version:before.version,stage:'feedback',receiptId:before.receiptId,status:'blocked'});
      expect(()=>engine.retry(task.id)).toThrowError(expect.objectContaining({code:'feedback_context_unavailable'}));
      await engine.tick();expect(f.deliveryCount()).toBe(1);expect(f.calls.filter(call=>call.role==='feedback')).toHaveLength(0);expect(reopened.get('receipts',before.receiptId!)).toBeDefined();
    }finally{await engine.shutdown();}
  });
  it.each((['ephemeral','permanent'] as const).flatMap(retention=>(['supersession','withdrawal'] as const).map(mode=>[retention,mode] as const)))('fix6 cancels historical research dependency (%s, %s)',async (retention,mode)=>{
    let dependency: {id:string;revision:string;locator:string;content:string}|undefined; let questionSeen='';
    const f=setup({researchFromQuestion:question=>{questionSeen=question;return {...research,summary:`Derived from ${question}`};},mutateOutput:(input,output)=>input.role==='decide'&&!input.research&&dependency?{...output as object,action:'ask',citations:[...(output as {citations:unknown[]}).citations,{sourceId:dependency.id,revision:dependency.revision,locator:dependency.locator,quote:dependency.content}],question:{title:'Historical dependency question',context:'Secondary evidence context',A:suggestion('Retain'),B:suggestion('Delete')}}:output});
    const ref={projectId:'p',kind:'reading' as const,purpose:'reference' as const,externalId:'fix6-ref',revision:'r1',title:'Reference',content:'Supporting reference',retention:'permanent' as const};
    f.engine.ingest(ref);dependency=f.store.list('sources').find(s=>s.externalId===ref.externalId)!;
    const task=f.engine.ingest({projectId:'p',kind:'manual',externalId:'fix6-primary',revision:'r1',title:'Primary',content:'保留草稿',retention})!;
    try{
      for(let i=0;i<30&&f.store.get('tasks',task.id)?.stage!=='feedback';i++)await f.engine.tick();
      const before=f.store.get('tasks',task.id)!;expect(before.stage).toBe('feedback');expect(f.store.list('cases').filter(c=>c.taskId===task.id)).toHaveLength(0);
      const snapshots=f.store.list('actions').filter(a=>a.taskId===task.id&&a.kind==='decision.snapshot');
      expect(snapshots.some(a=>JSON.stringify(a.payload).includes(dependency!.id))).toBe(true);
      expect(before.decision?.citations.some(c=>c.sourceId===dependency!.id)).toBe(false);
      expect(questionSeen).toContain('Historical dependency question');expect(f.store.list('actions').some(a=>a.taskId===task.id&&a.kind==='research'&&(a.payload.research as ResearchRecord | undefined)?.summary===`Derived from ${questionSeen}`)).toBe(true);
      const decisionCall=f.calls.filter(c=>c.role==='decide').at(-1)!;expect(decisionCall.input.research?.summary).toContain(questionSeen);
      const receipt=f.store.get('receipts',before.receiptId!)!;if(mode==='withdrawal')f.engine.withdraw(dependency.id);else f.engine.ingest({...ref,revision:'r2'});
      expect(f.store.get('tasks',task.id)).toMatchObject({stage:'feedback',status:'cancelled',version:before.version,receiptId:before.receiptId,attempts:before.attempts});
      for(let i=0;i<8;i++)await f.engine.tick();expect(f.calls.filter(c=>c.role==='feedback')).toHaveLength(0);expect(f.deliveryCount()).toBe(1);expect(f.store.get('receipts',receipt.id)).toEqual(receipt);
    }finally{await f.engine.shutdown();}
  });
  it('fix6 ignores unrelated, cross-scope and malformed historical snapshots',async()=>{
    const f=setup(),ref={projectId:'p',kind:'reading' as const,purpose:'reference' as const,externalId:'fix6-unrelated',revision:'r1',title:'Reference',content:'Supporting reference'};
    f.engine.ingest(ref);const dependency=f.store.list('sources').find(s=>s.externalId===ref.externalId)!;const task=f.ingest();
    try{
      while(f.store.get('tasks',task.id)?.stage!=='feedback')await f.engine.tick();
      const before=f.store.get('tasks',task.id)!,original=f.store.list('actions').find(a=>a.taskId===task.id&&a.kind==='decision.snapshot')!;
      const snapshot=original.payload.snapshot as Record<string,unknown>;
      for(const [id,projectId,domain,payload] of [
        ['cross-project','other','personal',{snapshot:{...snapshot,projectId:'other',sourceRefs:[{id:dependency.id}]}}],
        ['cross-domain','p','other',{snapshot:{...snapshot,domain:'other',sourceRefs:[{id:dependency.id}]}}],
        ['wrong-snapshot-scope','p','personal',{snapshot:{...snapshot,projectId:'other',sourceRefs:[{id:dependency.id}]}}],
        ['malformed','p','personal',{snapshot:{...snapshot,sourceRefs:null}}],
      ] as const)f.store.save('actions',{...original,id,projectId,domain,payload});
      f.engine.ingest({...ref,revision:'r2'});expect(f.store.get('tasks',task.id)).toMatchObject({status:'feedback',version:before.version,receiptId:before.receiptId});
      await f.engine.runUntilIdle();expect(f.store.get('tasks',task.id)?.status).toBe('delivered');expect(f.deliveryCount()).toBe(1);
    }finally{await f.engine.shutdown();}
  });
  it.each(['missing-id','mismatched-id','pending','kind','schema','version','attempt','derived-id','future-version','source-id','source-revision','ref-id','ref-revision','valid-older'] as const)('fix7 validates historical snapshot identity (%s)',async mode=>{
    const f=setup(),ref={projectId:'p',kind:'reading' as const,purpose:'reference' as const,externalId:`fix7-${mode}`,revision:'r1',title:'Reference',content:'Supporting reference'};
    f.engine.ingest(ref);const dependency=f.store.list('sources').find(s=>s.externalId===ref.externalId)!;const task=f.ingest();
    try{
      while(f.store.get('tasks',task.id)?.stage!=='feedback')await f.engine.tick();
      const before=f.store.get('tasks',task.id)!,original=f.store.list('actions').find(a=>a.taskId===task.id&&a.kind==='decision.snapshot')!;
      const snapshot:Record<string,unknown>={...(original.payload.snapshot as Record<string,unknown>),sourceRefs:[{id:dependency.id,revision:dependency.revision}]};
      if(mode==='missing-id')delete snapshot.id;
      if(mode==='mismatched-id')snapshot.id='wrong';
      if(mode==='schema')snapshot.schemaVersion=2;
      if(mode==='version')snapshot.taskVersion=0;
      if(mode==='attempt')snapshot.attemptId='';
      if(mode==='derived-id')snapshot.attemptId='different-attempt';
      if(mode==='future-version'){snapshot.taskVersion=before.version+1;snapshot.id=stableId('decision-snapshot',task.id,snapshot.taskVersion,snapshot.attemptId);}
      if(mode==='source-id')snapshot.sourceId='unrelated-source';
      if(mode==='source-revision')snapshot.sourceRevision='other-revision';
      if(mode==='ref-id')snapshot.sourceRefs=[{id:dependency.id,revision:dependency.revision}, {id:'',revision:'r1'}];
      if(mode==='ref-revision')snapshot.sourceRefs=[{id:dependency.id,revision:''}];
      f.store.save('actions',{...original,id:mode==='future-version'?snapshot.id as string:original.id,kind:mode==='kind'?'research':original.kind,status:mode==='pending'?'pending':'completed',payload:{snapshot}});
      if(mode==='valid-older')f.store.save('tasks',{...before,version:before.version+1});
      f.engine.ingest({...ref,revision:'r2'});
      expect(f.store.get('tasks',task.id)).toMatchObject({status:mode==='valid-older'?'cancelled':'feedback',version:before.version+(mode==='valid-older'?1:0),receiptId:before.receiptId});
      expect(f.deliveryCount()).toBe(1);expect(f.calls.filter(c=>c.role==='feedback')).toHaveLength(0);
    }finally{await f.engine.shutdown();}
  });
  it.each(['missing','null','nonarray','null-entry','nonobject-entry','missing-id','mismatched-id'] as const)('fix8 withdrawal ignores malformed historical dependency (%s)',async mode=>{
    const f=setup(),ref={projectId:'p',kind:'reading' as const,purpose:'reference' as const,externalId:`fix8-${mode}`,revision:'r1',title:'Private reference title',content:'Private reference content'};
    f.engine.ingest(ref);const dependency=f.store.list('sources').find(s=>s.externalId===ref.externalId)!;const task=f.ingest();
    f.store.save('cards',{id:'fix8-card',projectId:dependency.projectId,domain:dependency.domain,sourceId:dependency.id,sourceRevision:dependency.revision,title:'Private card title',body:'Private card derivative',quote:dependency.content,locator:dependency.locator,aliases:[],kind:'fact',verification:'reported',status:'active',createdAt:dependency.createdAt});
    try{
      while(f.store.get('tasks',task.id)?.stage!=='feedback')await f.engine.tick();
      const before=f.store.get('tasks',task.id)!,original=f.store.list('actions').find(a=>a.taskId===task.id&&a.kind==='decision.snapshot')!;
      const snapshot:Record<string,unknown>={...(original.payload.snapshot as Record<string,unknown>),sourceRefs:[{id:dependency.id,revision:dependency.revision}]};
      if(mode==='missing')delete snapshot.sourceRefs;
      if(mode==='null')snapshot.sourceRefs=null;
      if(mode==='nonarray')snapshot.sourceRefs='bad';
      if(mode==='null-entry')snapshot.sourceRefs=[null];
      if(mode==='nonobject-entry')snapshot.sourceRefs=['bad'];
      if(mode==='missing-id')delete snapshot.id;
      if(mode==='mismatched-id')snapshot.id='wrong';
      f.store.save('actions',{...original,payload:{snapshot,opaque:dependency.content}});
      f.engine.withdraw(dependency.id);
      expect(f.store.get('sources',dependency.id)).toMatchObject({status:'withdrawn',content:'',title:'[withdrawn]'});
      expect(f.store.get('tasks',task.id)).toEqual(before);
      expect(f.store.get('cards','fix8-card')).toMatchObject({status:'withdrawn',title:'[withdrawn]',body:'',quote:''});
      expect(JSON.stringify(f.store.get('actions',original.id)?.payload)).not.toContain(dependency.content);
      expect(f.deliveryCount()).toBe(1);expect(f.calls.filter(c=>c.role==='feedback')).toHaveLength(0);
    }finally{await f.engine.shutdown();}
  });
  it('fix6 replans historical dependencies before delivery',async()=>{
    let dependency: {id:string;revision:string;locator:string;content:string}|undefined;
    const f=setup({mutateOutput:(input,output)=>input.role==='decide'&&!input.research&&dependency?{...output as object,action:'ask',citations:[...(output as {citations:unknown[]}).citations,{sourceId:dependency.id,revision:dependency.revision,locator:dependency.locator,quote:dependency.content}],question:{title:'Research first',context:'Context',A:suggestion('Retain'),B:suggestion('Delete')}}:output});
    const ref={projectId:'p',kind:'reading' as const,purpose:'reference' as const,externalId:'fix6-predelivery',revision:'r1',title:'Reference',content:'Supporting reference'};f.engine.ingest(ref);dependency=f.store.list('sources').find(s=>s.externalId===ref.externalId)!;const task=f.ingest();
    try{for(let i=0;i<20&&f.store.get('tasks',task.id)?.stage!=='plan';i++)await f.engine.tick();const before=f.store.get('tasks',task.id)!;expect(before.stage).toBe('plan');expect(before.decision?.citations.some(c=>c.sourceId===dependency!.id)).toBe(false);
      f.engine.ingest({...ref,revision:'r2'});expect(f.store.get('tasks',task.id)).toMatchObject({stage:'decide',status:'deciding',version:before.version+1});expect(f.deliveryCount()).toBe(0);
    }finally{await f.engine.shutdown();}
  });
  it.each(['persisted','hold-write-unavailable'] as const)('retries temporary feedback in place while its delivery context remains available (%s)',async mode=>{
    const f=setup(),input={projectId:'p',kind:'conversation' as const,externalId:`feedback-same-${mode}`,revision:'r1',title:'Temporary',content:'保留草稿',retention:'ephemeral' as const};
    const task=f.engine.ingest(input)!,engine=f.engine;
    try{
      while(f.store.get('tasks',task.id)?.stage!=='feedback')await engine.tick();
      const before=f.store.get('tasks',task.id)!,receipt=f.store.get('receipts',before.receiptId!)!,transaction=f.store.transaction.bind(f.store),save=f.store.save.bind(f.store);let injected=false,holdFailures=0;
      const tx=vi.spyOn(f.store,'transaction').mockImplementation(((fn:()=>unknown)=>{if(!injected&&new Error().stack?.includes('Workbench.process')&&f.store.list('attempts').some(a=>a.taskId===task.id&&a.role==='feedback'&&a.status==='succeeded')){injected=true;throw Object.assign(new Error('post-feedback fault'),{code:'SQLITE_BUSY'});}return transaction(fn);}) as typeof f.store.transaction);
      const hold=vi.spyOn(f.store,'save').mockImplementation(((...args:Parameters<typeof save>)=>{if(mode==='hold-write-unavailable'&&new Error().stack?.includes('holdLocalTask')){holdFailures++;throw Object.assign(new Error('hold fault'),{code:'SQLITE_BUSY'});}return save(...args);}) as typeof f.store.save);
      await expect(engine.tick()).rejects.toMatchObject({code:'SQLITE_BUSY'});tx.mockRestore();hold.mockRestore();expect(injected).toBe(true);expect(holdFailures).toBe(mode==='hold-write-unavailable'?1:0);
      const attempts=f.store.get('tasks',task.id)!.attempts;
      const retried=engine.retry(task.id);expect(retried).toMatchObject({version:before.version,stage:'feedback',receiptId:receipt.id});
      await engine.runUntilIdle();expect(f.store.get('tasks',task.id)).toMatchObject({version:before.version,stage:'feedback',status:'delivered',receiptId:receipt.id});
      expect(f.store.get('tasks',task.id)!.attempts).toBe(attempts+1);expect(f.store.get('receipts',receipt.id)).toEqual(receipt);expect(f.deliveryCount()).toBe(1);
    }finally{await engine.shutdown();}
  });
  it.each(['persisted','hold-write-unavailable','no-feedback-attempt'] as const)('keeps completed temporary delivery on reopen and replay (%s)',async mode=>{
    const raw='TEMPORARY_FEEDBACK_RAW_SENTINEL',derived='TEMPORARY_FEEDBACK_DERIVED_SENTINEL';
    const f=setup({mutateOutput:(worker,output)=>worker.role==='execute'?{...output as object,files:[{path:'docs/PRD.md',content:`# PRD\n${derived}`}],summary:derived}:worker.role==='feedback'?{summary:derived,observations:[]}:output});
    const input={projectId:'p',kind:'conversation' as const,externalId:`feedback-reopen-${mode}`,revision:'r1',title:'Temporary',content:`${raw} 保留草稿`,retention:'ephemeral' as const};
    const task=f.engine.ingest(input)!;let engine=f.engine;
    try{
      while(f.store.get('tasks',task.id)?.stage!=='feedback')await engine.tick();
      const before=f.store.get('tasks',task.id)!,receipt=f.store.get('receipts',before.receiptId!)!;
      if(mode!=='no-feedback-attempt'){
        const transaction=f.store.transaction.bind(f.store),save=f.store.save.bind(f.store);let injected=false,holdFailures=0;
        const tx=vi.spyOn(f.store,'transaction').mockImplementation(((fn:()=>unknown)=>{if(!injected&&new Error().stack?.includes('Workbench.process')&&f.store.list('attempts').some(a=>a.taskId===task.id&&a.role==='feedback'&&a.status==='succeeded')){injected=true;throw Object.assign(new Error('post-feedback fault'),{code:'SQLITE_BUSY'});}return transaction(fn);}) as typeof f.store.transaction);
        const hold=vi.spyOn(f.store,'save').mockImplementation(((...args:Parameters<typeof save>)=>{if(mode==='hold-write-unavailable'&&new Error().stack?.includes('holdLocalTask')){holdFailures++;throw Object.assign(new Error('hold fault'),{code:'SQLITE_BUSY'});}return save(...args);}) as typeof f.store.save);
        await expect(engine.tick()).rejects.toMatchObject({code:'SQLITE_BUSY'});tx.mockRestore();hold.mockRestore();expect(injected).toBe(true);expect(holdFailures).toBe(mode==='hold-write-unavailable'?1:0);
      }
      const attempts=f.store.get('tasks',task.id)!.attempts;
      const backup=join(f.config.dataDir,'feedback-backup');await createBackup(f.store,backup,{mode:'test',vaultDir:f.config.vaultDir});
      const inspect=(path:string)=>{try{for(const secret of [raw,derived])expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false);}catch(error){if((error as NodeJS.ErrnoException).code!=='EISDIR')throw error;}};
      for(const path of [join(f.config.dataDir,'db.sqlite'),join(f.config.dataDir,'db.sqlite-wal')])if(existsSync(path))inspect(path);
      for(const dir of [f.config.vaultDir,backup])for(const name of readdirSync(dir,{recursive:true}).map(String))inspect(join(dir,name));
      const destination=join(f.config.dataDir,'feedback-restored');restoreBackup({snapshot:backup,destination,writerRevoked:true,reconciled:true});
      const restoredStore=new Store(join(destination,'patrick.db'),join(destination,'vault')),restoredEngine=f.create(restoredStore);
      try{
        expect(restoredEngine.ingest(input)).toMatchObject({id:task.id,version:before.version,stage:'feedback',status:'blocked',receiptId:receipt.id});
        expect(()=>restoredEngine.retry(task.id)).toThrowError(expect.objectContaining({code:'feedback_context_unavailable'}));
        for(let i=0;i<5;i++)await restoredEngine.tick();expect(f.deliveryCount()).toBe(1);
        for(const path of [join(destination,'patrick.db'),join(destination,'patrick.db-wal')])if(existsSync(path))inspect(path);
        for(const name of readdirSync(join(destination,'vault'),{recursive:true}).map(String))inspect(join(destination,'vault',name));
      }finally{await restoredEngine.shutdown();restoredStore.close();}
      await engine.shutdown();f.store.close();const reopened=new Store(join(f.config.dataDir,'db.sqlite'),f.config.vaultDir);stores.push(reopened);engine=f.create(reopened);
      expect(()=>engine.retry(task.id)).toThrowError(expect.objectContaining({code:'feedback_context_unavailable'}));
      await engine.tick();expect(reopened.get('tasks',task.id)).toMatchObject({version:before.version,stage:'feedback',status:'blocked',receiptId:receipt.id});
      const replay=engine.ingest(input)!;expect(replay).toMatchObject({id:task.id,version:before.version,stage:'feedback',status:'blocked',receiptId:receipt.id});
      expect(replay.error).toContain('feedback context expired');
      expect(()=>engine.retry(task.id)).toThrowError(expect.objectContaining({code:'feedback_context_unavailable'}));
      for(let i=0;i<15;i++)await engine.tick();
      expect(reopened.get('tasks',task.id)).toMatchObject({version:before.version,stage:'feedback',status:'blocked',receiptId:receipt.id,attempts});
      expect(reopened.get('receipts',receipt.id)).toEqual(receipt);expect(f.deliveryCount()).toBe(1);
      for(const path of [join(f.config.dataDir,'db.sqlite'),join(f.config.dataDir,'db.sqlite-wal')])if(existsSync(path))inspect(path);
    }finally{await engine.shutdown();}
  });
  it('preserves the delivered task receipt when a new temporary source revision is authorized',async()=>{
    const f=setup(),input={projectId:'p',kind:'conversation' as const,externalId:'feedback-new-revision',revision:'r1',title:'Temporary',content:'保留草稿',retention:'ephemeral' as const};
    const task=f.engine.ingest(input)!;
    try{
      while(f.store.get('tasks',task.id)?.stage!=='feedback')await f.engine.tick();
      const delivered=f.store.get('tasks',task.id)!,receipt=f.store.get('receipts',delivered.receiptId!)!;
      const next=f.engine.ingest({...input,revision:'r2'})!;
      expect(next.id).not.toBe(task.id);expect(next).toMatchObject({version:1,stage:'knowledge_extract'});
      expect(f.store.get('tasks',task.id)).toMatchObject({version:delivered.version,stage:'feedback',status:'cancelled',receiptId:receipt.id});
      expect(f.store.get('receipts',receipt.id)).toEqual(receipt);
      await f.engine.runUntilIdle();expect(f.deliveryCount()).toBe(2);expect(f.store.get('tasks',next.id)?.receiptId).not.toBe(receipt.id);
    }finally{await f.engine.shutdown();}
  });
  it.each(['direct','indirect'] as const)('fix5 preserves temporary feedback identity on %s withdrawal',async mode=>{
    let dependency: {id:string;revision:string;locator:string;content:string}|undefined;
    const derived='TEMPORARY_FIX5_DERIVED_SENTINEL';
    const f=setup({mutateOutput:(input,output)=>input.role==='execute'?{...output as object,files:[{path:'docs/PRD.md',content:`# PRD\n${derived}`}],summary:derived}:input.role==='decide'&&dependency?{...output as object,citations:[...(output as {citations:unknown[]}).citations,{sourceId:dependency.id,revision:dependency.revision,locator:dependency.locator,quote:dependency.content}]}:output});
    f.engine.ingest({projectId:'p',kind:'reading',purpose:'reference',externalId:'fix5-dependency',revision:'r1',title:'Dependency',content:'Supporting reference',retention:'permanent'});
    dependency=f.store.list('sources').find(s=>s.externalId==='fix5-dependency')!;
    const input={projectId:'p',kind:'conversation' as const,externalId:'fix5-primary',revision:'r1',title:'Temporary',content:'TEMPORARY_FIX5_RAW_SENTINEL 保留草稿',retention:'ephemeral' as const};const task=f.engine.ingest(input)!;
    try{
      while(f.store.get('tasks',task.id)?.stage!=='feedback')await f.engine.tick();
      const before=f.store.get('tasks',task.id)!,receipt=f.store.get('receipts',before.receiptId!)!;expect(before.artifact?.files[0]?.content).toContain(derived);f.engine.withdraw(mode==='direct'?task.sourceId:dependency.id);
      expect(f.store.get('tasks',task.id)).toMatchObject({stage:'feedback',status:'cancelled',version:before.version,receiptId:before.receiptId,attempts:before.attempts});
      expect(f.store.get('sources',mode==='direct'?task.sourceId:dependency.id)?.status).toBe('withdrawn');
      for(let i=0;i<12;i++)await f.engine.tick();expect(f.deliveryCount()).toBe(1);expect(f.store.get('receipts',receipt.id)).toEqual(receipt);
      const backup=join(f.config.dataDir,'fix5-backup');await createBackup(f.store,backup,{mode:'test',vaultDir:f.config.vaultDir});
      const inspect=(path:string)=>{try{for(const sentinel of ['TEMPORARY_FIX5_RAW_SENTINEL',derived])expect(readFileSync(path).includes(Buffer.from(sentinel))).toBe(false);}catch(error){if((error as NodeJS.ErrnoException).code!=='EISDIR')throw error;}};
      for(const path of [join(f.config.dataDir,'db.sqlite'),join(f.config.dataDir,'db.sqlite-wal')])if(existsSync(path))inspect(path);
      for(const dir of [f.config.vaultDir,backup])for(const name of readdirSync(dir,{recursive:true}).map(String))inspect(join(dir,name));
      const destination=join(f.config.dataDir,'fix5-restore');restoreBackup({snapshot:backup,destination,writerRevoked:true,reconciled:true});
      const restored=new Store(join(destination,'patrick.db'),join(destination,'vault')),engine=f.create(restored);
      try{expect(restored.get('tasks',task.id)).toMatchObject({stage:'feedback',status:'cancelled',version:before.version,receiptId:receipt.id,attempts:before.attempts});
        if(mode==='indirect')expect(engine.ingest(input)).toMatchObject({id:task.id,stage:'feedback',status:'cancelled',version:before.version,receiptId:receipt.id});
        for(let i=0;i<5;i++)await engine.tick();expect(f.deliveryCount()).toBe(1);
        for(const path of [join(destination,'patrick.db'),join(destination,'patrick.db-wal')])if(existsSync(path))inspect(path);
        for(const name of readdirSync(join(destination,'vault'),{recursive:true}).map(String))inspect(join(destination,'vault',name));
      }finally{await engine.shutdown();restored.close();}
    }finally{await f.engine.shutdown();}
  });
  it.each(['null-extra','null-checks','bad-head','bad-check-field'] as const)('fix5 rejects malformed adapter receipt (%s)',async mode=>{
    const f=setup({mutateReceipt:receipt=>({ ...receipt, ...(mode==='null-extra'?{checks:[...receipt.checks,null]}:mode==='null-checks'?{checks:null}:mode==='bad-head'?{headSha:42}:{checks:[{...receipt.checks[0],appId:'123'}]}) } as unknown as DeliveryReceipt)}),task=f.ingest();
    try{for(let i=0;i<25&&f.store.get('tasks',task.id)?.status!=='blocked';i++)await f.engine.tick();
      expect(f.store.get('tasks',task.id)).toMatchObject({stage:'delivery',status:'blocked'});expect(f.store.list('receipts')).toHaveLength(0);expect(f.deliveryCount()).toBe(1);
    }finally{await f.engine.shutdown();}
  });
  it.each(['direct-withdrawal','indirect-supersession','direct-supersession'] as const)('fix5 retains permanent delivery identity after %s',async mode=>{
    let dependency: {id:string;revision:string;locator:string;content:string}|undefined;
    const f=setup({mutateOutput:(input,output)=>input.role==='decide'&&dependency?{...output as object,citations:[...(output as {citations:unknown[]}).citations,{sourceId:dependency.id,revision:dependency.revision,locator:dependency.locator,quote:dependency.content}]}:output});
    const ref={projectId:'p',kind:'reading' as const,purpose:'reference' as const,externalId:'fix5-permanent-dependency',revision:'r1',title:'Dependency',content:'Supporting reference',retention:'permanent' as const};
    f.engine.ingest(ref);dependency=f.store.list('sources').find(s=>s.externalId===ref.externalId)!;
    const input={projectId:'p',kind:'manual' as const,externalId:'fix5-permanent-primary',revision:'r1',title:'Primary',content:'保留草稿',retention:'permanent' as const};const task=f.engine.ingest(input)!;
    try{while(f.store.get('tasks',task.id)?.stage!=='feedback')await f.engine.tick();const before=f.store.get('tasks',task.id)!;
      if(mode==='direct-withdrawal')f.engine.withdraw(task.sourceId);else if(mode==='indirect-supersession')f.engine.ingest({...ref,revision:'r2'});else f.engine.ingest({...input,revision:'r2'});
      expect(f.store.get('tasks',task.id)).toMatchObject({stage:'feedback',status:'cancelled',version:before.version,receiptId:before.receiptId,attempts:before.attempts});
      if(mode!=='direct-supersession'){for(let i=0;i<12;i++)await f.engine.tick();expect(f.deliveryCount()).toBe(1);}
    }finally{await f.engine.shutdown();}
  });
  it('fix5 isolates retained malformed receipt from unrelated work',async()=>{
    const f=setup(),task=f.engine.ingest({projectId:'p',kind:'conversation',externalId:'fix5-receipt',revision:'r1',title:'Temporary',content:'保留草稿',retention:'ephemeral'})!;
    try{
      while(f.store.get('tasks',task.id)?.stage!=='feedback')await f.engine.tick();
      const before=f.store.get('tasks',task.id)!,receipt=f.store.get('receipts',before.receiptId!)!;
      f.store.save('receipts',{...receipt,checks:[...receipt.checks,null] as unknown as DeliveryReceipt['checks']});
      f.store.save('projects',{...f.store.get('projects','p')!,trustedChecks:['test','new-check']});
      const other=f.engine.ingest({projectId:'p',kind:'manual',externalId:'fix5-other',revision:'r1',title:'Other',content:'保留草稿',retention:'permanent'})!;
      await f.engine.tick();expect(f.store.get('tasks',task.id)).toMatchObject({stage:'feedback',status:'blocked',version:before.version,receiptId:before.receiptId});
      expect(()=>f.engine.retry(task.id)).toThrowError(expect.objectContaining({code:'feedback_context_unavailable'}));
      expect(f.store.get('tasks',other.id)?.stage).not.toBe('knowledge_extract');expect(f.deliveryCount()).toBe(1);
    }finally{await f.engine.shutdown();}
  });
  it('refuses feedback retry when the current temporary delivery context is malformed',async()=>{
    const f=setup(),task=f.engine.ingest({projectId:'p',kind:'conversation',externalId:'feedback-invalid-context',revision:'r1',title:'Temporary',content:'保留草稿',retention:'ephemeral'})!;
    try{
      while(f.store.get('tasks',task.id)?.stage!=='feedback')await f.engine.tick();
      const before=f.store.get('tasks',task.id)!;
      f.store.save('tasks',{...before,status:'blocked',plan:JSON.parse('{}')});
      expect(()=>f.engine.retry(task.id)).toThrowError(expect.objectContaining({code:'feedback_context_unavailable'}));
      await f.engine.tick();expect(f.deliveryCount()).toBe(1);expect(f.store.get('tasks',task.id)).toMatchObject({stage:'feedback',status:'blocked',version:before.version,receiptId:before.receiptId});
    }finally{await f.engine.shutdown();}
  });
  it('preserves the attempt cap and receipt when retrying completed temporary delivery',async()=>{
    const f=setup(),task=f.engine.ingest({projectId:'p',kind:'conversation',externalId:'feedback-attempt-cap',revision:'r1',title:'Temporary',content:'保留草稿',retention:'ephemeral'})!;
    try{
      while(f.store.get('tasks',task.id)?.stage!=='feedback')await f.engine.tick();
      const before=f.store.get('tasks',task.id)!;f.store.save('tasks',{...before,status:'blocked',attempts:32,attemptLimit:32});
      const calls=f.calls.length;expect(()=>f.engine.retry(task.id)).toThrowError(expect.objectContaining({code:'subscription_attempt_limit'}));
      await f.engine.tick();expect(f.calls).toHaveLength(calls);expect(f.deliveryCount()).toBe(1);
      expect(f.store.get('tasks',task.id)).toMatchObject({version:before.version,stage:'feedback',receiptId:before.receiptId,attempts:32,billingStop:{code:'subscription_attempt_limit'}});
    }finally{await f.engine.shutdown();}
  });
  it('propagates temporary feedback context snapshot contention without treating it as lost context',async()=>{
    const f=setup(),task=f.engine.ingest({projectId:'p',kind:'conversation',externalId:'feedback-snapshot-contention',revision:'r1',title:'Temporary',content:'保留草稿',retention:'ephemeral'})!;
    try{
      while(f.store.get('tasks',task.id)?.stage!=='feedback')await f.engine.tick();
      const before=f.store.get('tasks',task.id)!;f.store.save('tasks',{...before,status:'blocked'});
      const list=f.store.list.bind(f.store),fault=vi.spyOn(f.store,'list').mockImplementation(((...args:Parameters<typeof list>)=>{if(new Error().stack?.includes('validateReview'))throw new DomainError('Knowledge temporarily unavailable; retry.','knowledge_snapshot_unavailable',503);return list(...args);}) as typeof f.store.list);
      try{expect(()=>f.engine.retry(task.id)).toThrowError(expect.objectContaining({code:'knowledge_snapshot_unavailable'}));}finally{fault.mockRestore();}
      expect(f.store.get('tasks',task.id)).toMatchObject({version:before.version,stage:'feedback',status:'blocked',receiptId:before.receiptId});expect(f.deliveryCount()).toBe(1);
    }finally{await f.engine.shutdown();}
  });
  it.each((['knowledge_extract','execute','check'] as const).flatMap(role=>(['persisted','hold-write-unavailable'] as const).map(mode=>[role,mode] as const)))('keeps a consumed temporary conversation %s result held across reopen (%s)',async(role,mode)=>{
    const sentinel='TEMPORARY_MODEL_BODY_SENTINEL',derived='TEMPORARY_MODEL_DERIVED_SENTINEL';
    const f=setup({mutateOutput:(worker,output)=>{
      if(worker.role==='knowledge_extract')return {cards:[{title:derived,body:derived,quote:'保留草稿',aliases:[],verification:'reported',kind:'fact'}]};
      if(worker.role===role)return {...output as object,summary:derived};
      return output;
    }});
    const input={projectId:'p',kind:'conversation' as const,externalId:`codex:session:${role}:${mode}`,revision:'r1',title:sentinel,content:`${sentinel} 保留草稿`,retention:'ephemeral' as const};
    const task=f.engine.ingest(input)!;let engine=f.engine;vi.useFakeTimers({toFake:['Date']});
    try{
      while(f.store.get('tasks',task.id)?.stage!==role)await engine.tick();
      const before=f.store.get('tasks',task.id)!,transaction=f.store.transaction.bind(f.store),save=f.store.save.bind(f.store);let injected=false;
      const tx=vi.spyOn(f.store,'transaction').mockImplementation(((fn:()=>unknown)=>{
        if(!injected&&new Error().stack?.includes('Workbench.process')&&f.store.list('attempts').some(a=>a.taskId===task.id&&a.role===role&&a.taskVersion===before.version&&a.status==='succeeded')){
          injected=true;throw Object.assign(new Error('post-result fault'),{code:'SQLITE_BUSY'});
        }
        return transaction(fn);
      }) as typeof f.store.transaction);
      const saveSpy=vi.spyOn(f.store,'save').mockImplementation(((...args:Parameters<typeof save>)=>{
        if(mode==='hold-write-unavailable'&&new Error().stack?.includes('holdLocalTask'))throw Object.assign(new Error('hold fault'),{code:'SQLITE_BUSY'});
        return save(...args);
      }) as typeof f.store.save);
      await expect(engine.tick()).rejects.toMatchObject({code:'SQLITE_BUSY'});tx.mockRestore();
      expect(injected).toBe(true);const firstCalls=f.calls.filter(c=>c.role===role).length;
      const firstAttempts=f.store.list('attempts').filter(a=>a.role===role&&a.taskId===task.id);expect(firstAttempts.at(-1)?.status).toBe('succeeded');
      for(let i=0;i<48;i++){vi.setSystemTime(Date.now()+1000);await engine.tick();}
      expect(f.calls.filter(c=>c.role===role)).toHaveLength(firstCalls);
      const backup=join(f.config.dataDir,'privacy-backup');await createBackup(f.store,backup,{mode:'test',vaultDir:f.config.vaultDir});
      const assertPrivate=(path:string)=>{try{const bytes=readFileSync(path);for(const secret of [sentinel,derived])expect(bytes.includes(Buffer.from(secret))).toBe(false);}catch(error){if((error as NodeJS.ErrnoException).code!=='EISDIR')throw error;}};
      for(const path of [join(f.config.dataDir,'db.sqlite'),join(f.config.dataDir,'db.sqlite-wal')])if(existsSync(path))assertPrivate(path);
      for(const dir of [f.config.vaultDir,backup])for(const name of readdirSync(dir,{recursive:true}).map(String))assertPrivate(join(dir,name));
      const restoredDir=join(f.config.dataDir,'restored');restoreBackup({snapshot:backup,destination:restoredDir,writerRevoked:true,reconciled:true});
      const restoredStore=new Store(join(restoredDir,'patrick.db'),join(restoredDir,'vault')),restoredEngine=f.create(restoredStore);
      try{
        expect(restoredEngine.ingest(input)).toMatchObject({id:task.id,version:before.version,stage:role,status:'blocked'});
        await restoredEngine.tick();expect(f.calls.filter(c=>c.role===role)).toHaveLength(firstCalls);
      }finally{await restoredEngine.shutdown();restoredStore.close();}
      await engine.shutdown();saveSpy.mockRestore();f.store.close();
      const reopened=new Store(join(f.config.dataDir,'db.sqlite'),f.config.vaultDir);stores.push(reopened);engine=f.create(reopened);
      expect(reopened.get('sources',task.sourceId)?.content).toBe('');
      const restored=engine.ingest(input)!;
      expect(restored).toMatchObject({id:task.id,version:before.version,stage:role,status:'blocked'});
      for(let i=0;i<5;i++){vi.setSystemTime(Date.now()+1000);await engine.tick();}
      expect(f.calls.filter(c=>c.role===role)).toHaveLength(firstCalls);
      expect(reopened.list('attempts').filter(a=>a.taskId===task.id&&a.role===role)).toHaveLength(firstAttempts.length);
      for(const secret of [sentinel,derived])expect(readFileSync(join(f.config.dataDir,'db.sqlite')).includes(Buffer.from(secret))).toBe(false);
      engine.retry(task.id);
      for(let i=0;i<12&&f.calls.filter(c=>c.role===role).length===firstCalls;i++)await engine.tick();
      expect(f.calls.filter(c=>c.role===role)).toHaveLength(firstCalls+1);
      const attempts=reopened.list('attempts').filter(a=>a.taskId===task.id&&a.role===role);
      expect(attempts.at(-1)!.billing!.ordinal).toBeGreaterThan(firstAttempts.at(-1)!.billing!.ordinal);
    }finally{vi.useRealTimers();await engine.shutdown();}
  });
  it('permits a new authorized temporary conversation revision after a consumed result',async()=>{
    const f=setup(),input={projectId:'p',kind:'conversation' as const,externalId:'codex:session:new-revision',revision:'r1',title:'Temporary',content:'保留草稿',retention:'ephemeral' as const};
    const task=f.engine.ingest(input)!;let engine=f.engine;
    try{
      const transaction=f.store.transaction.bind(f.store);let injected=false;
      const spy=vi.spyOn(f.store,'transaction').mockImplementation(((fn:()=>unknown)=>{
        if(!injected&&new Error().stack?.includes('Workbench.process')&&f.store.list('attempts').some(a=>a.taskId===task.id&&a.status==='succeeded')){injected=true;throw Object.assign(new Error('post-result fault'),{code:'SQLITE_BUSY'});}
        return transaction(fn);
      }) as typeof f.store.transaction);
      await expect(engine.tick()).rejects.toMatchObject({code:'SQLITE_BUSY'});spy.mockRestore();expect(injected).toBe(true);
      await engine.shutdown();f.store.close();const reopened=new Store(join(f.config.dataDir,'db.sqlite'),f.config.vaultDir);stores.push(reopened);engine=f.create(reopened);
      const next=engine.ingest({...input,revision:'r2'})!;expect(next.id).not.toBe(task.id);expect(next.version).toBe(1);
      await engine.tick();expect(f.calls.filter(call=>call.role==='knowledge_extract')).toHaveLength(2);
      expect(reopened.list('attempts').filter(a=>a.taskId===next.id)).toMatchObject([{status:'succeeded',billing:{ordinal:1}}]);
    }finally{await engine.shutdown();}
  });
  it('recovers automatically after unavailable workers in a repeated stage with a migrated legacy success',async()=>{
    let asks=0;
    const f=setup({mutateOutput:(input,output)=>input.role==='check'&&asks++===0?{...(output as object),verdict:'ask'}:output});
    const task=f.ingest();vi.useFakeTimers({toFake:['Date']});
    try{
      while(f.store.get('tasks',task.id)?.stage!=='check')await f.engine.tick();
      const first=f.store.list('attempts').find(a=>a.taskId===task.id&&a.role==='decide'&&a.status==='succeeded')!;
      const {billing: _legacyBilling,...legacy}=first;f.store.save('attempts',legacy);
      await f.engine.tick();expect(f.store.get('tasks',task.id)?.stage).toBe('decide');
      f.options.workerUnavailable={grok:['decide'],dsh:['decide'],codex:['decide']};
      await f.engine.tick();
      expect(f.store.list('attempts').filter(a=>a.role==='decide').map(a=>a.status)).toEqual(['succeeded','unavailable','unavailable','unavailable']);
      // Exercise an already-opened modern action from before prior-ID snapshots existed.
      const action=f.store.list('actions').find(a=>a.taskId===task.id&&a.kind==='decide'&&a.status==='pending')!;
      const {priorSucceededAttemptIds: _prior,...olderPayload}=action.payload;
      f.store.save('actions',{...action,payload:olderPayload});
      const before=f.store.get('tasks',task.id)!;expect(before.error).not.toBe('knowledge_snapshot_unavailable');
      f.options.workerUnavailable={};vi.setSystemTime(Date.parse(before.runAfter)+1);
      await f.engine.tick();
      expect(f.store.get('tasks',task.id)).toMatchObject({stage:'plan'});
      const decide=f.store.list('attempts').filter(a=>a.role==='decide');
      expect(decide.map(a=>a.status)).toEqual(['succeeded','unavailable','unavailable','unavailable','succeeded']);
      expect(decide.at(-1)?.billing?.ordinal).toBe(f.store.get('tasks',task.id)?.attempts);
      expect(f.calls.filter(call=>call.role==='decide')).toHaveLength(5);
    }finally{vi.useRealTimers();await f.engine.shutdown();}
  });
  it.each(['persisted','hold-write-unavailable'] as const)('keeps a new repeated-stage success held through reopen and owner retry (%s)',async mode=>{
    let asks=0;const f=setup({mutateOutput:(input,output)=>input.role==='check'&&asks++===0?{...(output as object),verdict:'ask'}:output});
    const task=f.ingest();let engine=f.engine;vi.useFakeTimers({toFake:['Date']});
    try{
      while(f.store.get('tasks',task.id)?.stage!=='check')await engine.tick();
      const first=f.store.list('attempts').find(a=>a.taskId===task.id&&a.role==='decide'&&a.status==='succeeded')!;
      const {billing:_billing,...legacy}=first;f.store.save('attempts',legacy);
      await engine.tick();expect(f.store.get('tasks',task.id)?.stage).toBe('decide');
      const transaction=f.store.transaction.bind(f.store),save=f.store.save.bind(f.store);let injected=false;
      const txSpy=vi.spyOn(f.store,'transaction').mockImplementation(((fn:()=>unknown)=>{
        if(!injected&&new Error().stack?.includes('Workbench.process')&&f.store.list('attempts').filter(a=>a.role==='decide'&&a.status==='succeeded').length===2){injected=true;throw Object.assign(new Error('post-result failure'),{code:'SQLITE_BUSY'});}
        return transaction(fn);
      }) as typeof f.store.transaction);
      const saveSpy=vi.spyOn(f.store,'save').mockImplementation(((...args:Parameters<typeof save>)=>{
        if(mode==='hold-write-unavailable'&&new Error().stack?.includes('holdLocalTask'))throw Object.assign(new Error('hold failure'),{code:'SQLITE_BUSY'});
        return save(...args);
      }) as typeof f.store.save);
      await expect(engine.tick()).rejects.toMatchObject({code:'SQLITE_BUSY'});txSpy.mockRestore();expect(injected).toBe(true);
      for(let i=0;i<48;i++){vi.setSystemTime(Date.now()+750);await engine.tick();}
      expect(f.calls.filter(call=>call.role==='decide')).toHaveLength(2);
      await engine.shutdown();saveSpy.mockRestore();f.store.close();
      const reopened=new Store(join(f.config.dataDir,'db.sqlite'),f.config.vaultDir);stores.push(reopened);engine=f.create(reopened);
      for(let i=0;i<4;i++){vi.setSystemTime(Date.now()+750);await engine.tick();}
      expect(f.calls.filter(call=>call.role==='decide')).toHaveLength(2);
      expect(reopened.get('tasks',task.id)).toMatchObject({stage:'decide',status:'blocked',error:'knowledge_snapshot_unavailable'});
      engine.retry(task.id);await engine.tick();
      const attempts=reopened.list('attempts').filter(a=>a.role==='decide');
      expect(attempts.map(a=>a.status)).toEqual(['succeeded','succeeded','succeeded']);
      expect(attempts[1]?.billing?.ordinal).toBeLessThan(attempts[2]!.billing!.ordinal);
      expect(f.calls.filter(call=>call.role==='decide')).toHaveLength(3);
    }finally{vi.useRealTimers();await engine.shutdown();}
  });
  it.each(['missing-boundary','incomplete-suffix'] as const)('conservatively holds an ambiguous legacy pending action (%s)',async mode=>{
    let asks=0;const f=setup({mutateOutput:(input,output)=>input.role==='check'&&asks++===0?{...(output as object),verdict:'ask'}:output});
    const task=f.ingest();vi.useFakeTimers({toFake:['Date']});
    try{
      while(f.store.get('tasks',task.id)?.stage!=='check')await f.engine.tick();
      const first=f.store.list('attempts').find(a=>a.role==='decide'&&a.status==='succeeded')!;
      const {billing:_billing,...legacy}=first;f.store.save('attempts',legacy);
      await f.engine.tick();f.options.workerUnavailable={grok:['decide'],dsh:['decide'],codex:['decide']};await f.engine.tick();
      const action=f.store.list('actions').find(a=>a.taskId===task.id&&a.kind==='decide'&&a.status==='pending')!;
      const {priorSucceededAttemptIds:_prior,attemptsBefore:boundary,...rest}=action.payload;
      f.store.save('actions',{...action,payload:mode==='missing-boundary'?rest:{...rest,attemptsBefore:boundary}});
      if(mode==='incomplete-suffix')f.store.delete('attempts',f.store.list('attempts').filter(a=>a.role==='decide').at(-1)!.id);
      const calls=f.calls.length;f.options.workerUnavailable={};vi.setSystemTime(Date.parse(f.store.get('tasks',task.id)!.runAfter)+1);
      await f.engine.tick();expect(f.calls).toHaveLength(calls);
      expect(f.store.get('tasks',task.id)).toMatchObject({stage:'decide',status:'blocked',error:'knowledge_snapshot_unavailable'});
    }finally{vi.useRealTimers();await f.engine.shutdown();}
  });
  it('reconciles retained Vault work on an ordinary tick after the fault is removed', async () => {
    const f = setup(), task = f.ingest(), s = f.store.get('sources', task.sourceId)!;
    const state = f.store as unknown as { vaultJobs: Map<string, unknown>; publish: (job: { table: string }) => void }, publish = state.publish.bind(f.store); let injected = false;
    const spy = vi.spyOn(state, 'publish').mockImplementation(job => { if (!injected && job.table === 'cards') { injected = true; throw new Error('synthetic projection failure'); } return publish(job); });
    try { f.store.save('cards', { id: 'pending-tick-card', projectId: s.projectId, domain: s.domain, sourceId: s.id, sourceRevision: s.revision, title: 'Pending', body: 'PENDING_TICK_SENTINEL', quote: '保留草稿', locator: s.locator, aliases: [], kind: 'fact', verification: 'reported', status: 'active', createdAt: s.createdAt }); } catch {} spy.mockRestore();
    expect(injected).toBe(true); expect(state.vaultJobs.size).toBe(1);
    await f.engine.tick(); expect(state.vaultJobs.size).toBe(0);
    expect(readFileSync(join(f.config.vaultDir, 'p', 'personal', 'cards', 'pending-tick-card.md'), 'utf8')).toContain('PENDING_TICK_SENTINEL');
    await f.engine.shutdown();
  });

  it.each((['knowledge_extract', 'case_extract', 'decide', 'plan', 'feedback'] as const).flatMap(role => (['persisted', 'hold-write-unavailable'] as const).map(mode => [role, mode] as const)))('holds a successful %s result after publication contention across reopen (%s)', async (role, mode) => {
    const f = setup(); const task = f.ingest(); let reopened: Store | undefined; let engine: Workbench | undefined = f.engine;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      while (f.store.get('tasks', task.id)?.stage !== role) await engine.tick();
      const transaction = f.store.transaction.bind(f.store), save = f.store.save.bind(f.store); let injected = false;
      const transactionSpy = vi.spyOn(f.store, 'transaction').mockImplementation(((fn: () => unknown) => {
        if (!injected && new Error().stack?.includes('Workbench.process') && f.store.list('attempts').some(a => a.taskId === task.id && a.role === role && a.status === 'succeeded')) {
          injected = true; throw Object.assign(new Error('synthetic post-result contention'), { code: 'SQLITE_BUSY' });
        }
        return transaction(fn);
      }) as typeof f.store.transaction);
      const saveSpy = vi.spyOn(f.store, 'save').mockImplementation(((...args: Parameters<typeof save>) => {
        if (mode === 'hold-write-unavailable' && new Error().stack?.includes('holdLocalTask')) throw Object.assign(new Error('synthetic hold contention'), { code: 'SQLITE_BUSY' });
        return save(...args);
      }) as typeof f.store.save);
      await expect(engine.tick()).rejects.toMatchObject({ code: 'SQLITE_BUSY' }); transactionSpy.mockRestore();
      expect(injected).toBe(true);
      for (let i = 0; i < 48; i++) { vi.setSystemTime(Date.now() + 750); await engine.tick(); }
      expect(f.calls.filter(call => call.role === role)).toHaveLength(1);
      expect(f.store.list('attempts').filter(a => a.taskId === task.id && a.role === role).map(a => a.status)).toEqual(['succeeded']);
      await engine.shutdown(); saveSpy.mockRestore(); f.store.close();
      reopened = new Store(join(f.config.dataDir, 'db.sqlite'), f.config.vaultDir); stores.push(reopened); engine = f.create(reopened);
      for (let i = 0; i < 4; i++) { vi.setSystemTime(Date.now() + 750); await engine.tick(); }
      expect(f.calls.filter(call => call.role === role)).toHaveLength(1);
      expect(reopened.get('tasks', task.id)).toMatchObject({ stage: role, status: 'blocked', error: 'knowledge_snapshot_unavailable' });
      engine.retry(task.id); await engine.tick();
      expect(f.calls.filter(call => call.role === role)).toHaveLength(2);
      expect(reopened.list('attempts').filter(a => a.taskId === task.id && a.role === role).map(a => a.status)).toEqual(['succeeded', 'succeeded']);
    } finally { vi.useRealTimers(); await engine?.shutdown(); }
  });
  it('runs all seven roles without a question and delivers only after receipt and feedback', async () => {
    const f = setup(); const task = f.ingest(); await f.engine.runUntilIdle();
    expect(f.store.get('tasks', task.id)?.status).toBe('delivered');
    expect(f.calls.map(c => c.role)).toEqual(['knowledge_extract', 'case_extract', 'decide', 'plan', 'execute', 'check', 'feedback']);
    expect(f.calls.find(c => c.role === 'decide')?.runner).toBe('grok');
    expect(f.calls.find(c => c.role === 'plan')?.runner).toBe('codex');
    expect(f.calls.find(c => c.role === 'check')?.runner).toBe('codex');
    expect(f.store.list('questions')).toEqual([]);
    expect(f.store.list('rules').every(r => r.kind === 'observation')).toBe(true);
    expect(f.ingest()?.id).toBe(task.id); expect(f.store.list('tasks')).toHaveLength(1);
  });

  it.each(['A', 'B', 'C'] as const)('accepts an owner %s answer once and resumes the same task with frozen scope', async choice => {
    const f = setup({ ask: true }); const task = f.ingest(); await f.engine.runUntilIdle();
    const question = f.store.list('questions')[0]!;
    expect(Object.keys(question.options)).toEqual(['A', 'B']);
    expect(new Set(question.research.queries.map(q => q.language))).toEqual(new Set(['zh', 'en']));
    const answer = { questionId: question.id, taskVersion: question.taskVersion, questionVersion: question.version, actorId: 'owner', choice, text: choice === 'C' ? '只保留到下次导出成功' : undefined, eventId: 'answer-1' };
    expect(() => f.engine.answer({ ...answer, actorId: 'intruder' })).toThrow();
    const resumed = f.engine.answer(answer); expect(f.engine.answer({ ...answer, eventId: 'same-via-backfill' }).id).toBe(resumed.id);
    expect(f.store.list('cases')).toHaveLength(1); expect(f.store.list('rules').filter(r => r.kind === 'principle')).toHaveLength(1);
    const rule = f.store.list('rules').find(r => r.kind === 'principle')!; expect(rule.projectId).toBe('p'); expect(rule.domain).toBe('personal'); expect(rule.conditions).toContain(question.id);
    await f.engine.runUntilIdle(); expect(f.store.get('tasks', task.id)?.status).toBe('delivered');
    expect(f.deliveryCount()).toBe(1); expect(f.calls.filter(c => c.role === 'plan')).toHaveLength(1);
  });

  it('invalidates obsolete answers, cards, rules and actions on source replacement or withdrawal', async () => {
    const f = setup({ ask: true }); const old = f.ingest(); await f.engine.runUntilIdle(); const question = f.store.list('questions')[0]!;
    f.engine.ingest({ projectId: 'p', externalId: 'idea', kind: 'manual', title: 'Edited', content: '新的资料仍须保留草稿。', authorId: 'owner' });
    expect(() => f.engine.answer({ questionId: question.id, taskVersion: question.taskVersion, questionVersion: question.version, actorId: 'owner', choice: 'A', eventId: 'late' })).toThrow();
    expect(f.store.get('tasks', old.id)?.status).toBe('cancelled'); expect(f.store.get('questions', question.id)?.status).toBe('stale');
    expect(f.store.list('rules').every(r => r.status !== 'active')).toBe(true);
    f.engine.withdraw(f.store.list('sources').find(s => s.status === 'active')!.id); f.store.rebuildIndex();
    expect(f.store.searchCards('草稿', project)).toEqual([]);
  });

  it('commits a fallback notice with the new attempt and retries it after an offline restart', async () => {
    const f = setup({ workerUnavailable: { grok: ['knowledge_extract'] }, notifierOffline: true }); const task = f.ingest();
    await f.engine.tick();
    const notice = f.store.list('outbox').find(m => m.text.includes('grok') && m.text.includes('dsh'))!;
    expect(notice.status).toBe('pending'); expect(notice.attempts).toBe(1);
    expect(f.store.list('attempts').map(a => a.status)).toEqual(['unavailable', 'succeeded']);
    f.options.notifierOffline = false;
    f.store.save('outbox', { ...notice, runAfter: new Date(0).toISOString() });
    await f.create().runUntilIdle();
    expect(f.store.get('tasks', task.id)?.status).toBe('delivered'); expect(f.notifications.filter(m => m.id === notice.id)).toHaveLength(1);
    expect(f.store.list('cards')).toHaveLength(1);
  });

  it('blocks without a question when all runners are unavailable or the budget is exhausted', async () => {
    const f = setup({ workerUnavailable: { grok: ['knowledge_extract'], dsh: ['knowledge_extract'], codex: ['knowledge_extract'] } }); const task = f.ingest(); await f.engine.runUntilIdle();
    const blocked = f.store.get('tasks', task.id)!; expect(blocked.status).toBe('blocked'); expect(Date.parse(blocked.runAfter)).toBeGreaterThan(Date.now()); expect(f.store.list('questions')).toEqual([]);
    const budget = setup({ budget: .001 }); const tiny = budget.ingest(); await budget.engine.runUntilIdle();
    expect(budget.store.get('tasks', tiny.id)?.status).toBe('blocked'); expect(budget.calls).toEqual([]);
  });

  it('keeps a failed feedback incomplete and schedules another try', async () => {
    const f = setup({ badFeedback: true });
    const task = f.ingest();
    await f.engine.runUntilIdle();
    const current = f.store.get('tasks', task.id)!;
    expect(current).toMatchObject({ status: 'retrying', stage: 'feedback', error: 'feedback_retry' });
    expect(current.receiptId).toBeTruthy();
    expect(current.feedback).toBeUndefined();
    expect(f.deliveryCount()).toBe(1);
    expect(f.store.list('events').some(event => event.type === 'feedback_retry' && event.message.includes('交付还不能算完成'))).toBe(true);
    const html = await (await createApp({ store: f.store, config: f.config, engine: f.engine }).request(`/tasks/${task.id}`)).text();
    expect(html).toContain('反馈没有完成。');
    expect(html).toContain('这不需要你回答。');
  });

  it('bounds repairs at two and never treats business test failure as runner unavailability', async () => {
    const f = setup({ badReview: true }); const task = f.ingest(); await f.engine.runUntilIdle();
    expect(f.store.get('tasks', task.id)?.status).toBe('blocked'); expect(f.store.get('tasks', task.id)?.repairCount).toBe(2); expect(f.store.get('tasks', task.id)?.error).toBe('repairs_exhausted');
    expect(f.store.list('events').some(event => event.type === 'repairs_exhausted' && event.message.includes('没有发布未经验证的改动'))).toBe(true);
    const html = await (await createApp({ store: f.store, config: f.config, engine: f.engine }).request(`/tasks/${task.id}`)).text();
    expect(html).toContain('已返修两轮，检查仍未通过。');
    expect(html).toContain('没有发布未经验证的改动');
    expect(f.calls.filter(c => c.role === 'execute')).toHaveLength(3); expect(f.store.list('attempts').some(a => a.status === 'unavailable')).toBe(false); expect(f.deliveryCount()).toBe(0);
  });

  it('rejects check results bound to a different artifact and never fabricates delivery', async () => {
    const f = setup({ mutateOutput: (input, output) => input.role === 'check' ? { ...(output as object), artifactHash: 'wrong' } : output }); const task = f.ingest(); await f.engine.runUntilIdle();
    expect(f.store.get('tasks', task.id)?.status).toBe('blocked'); expect(f.deliveryCount()).toBe(0);
    const offline = setup({ noReceipt: true }); const t = offline.ingest(); await offline.engine.runUntilIdle();
    expect(offline.store.get('tasks', t.id)?.status).not.toBe('delivered'); expect(offline.store.list('receipts')).toEqual([]);
  });

  it('requires both actual language searches before opening a question', async () => {
    const f = setup({ ask: true, research: { ...research, queries: research.queries.filter(q => q.language === 'en') } }); const task = f.ingest(); await f.engine.runUntilIdle();
    expect(f.store.get('tasks', task.id)?.status).toBe('blocked'); expect(f.store.list('questions')).toEqual([]);
  });

  it('keeps every temporary derivative in memory and retains only execution metadata after restart', async () => {
    const secret = 'EPHEMERAL_DERIVATIVE_SECRET';
    const f = setup({ mutateOutput: (input, output) => {
      if (input.role === 'knowledge_extract') return { cards: [{ title: secret, body: secret, quote: '保留草稿', aliases: [secret], verification: 'reported', kind: 'fact' }] };
      if (input.role === 'case_extract') return { observations: [{ title: secret, statement: secret, quote: '保留草稿', conditions: secret, exceptions: secret }] };
      return { ...(output as object), summary: secret };
    } });
    const task = f.engine.ingest({ projectId: 'p', externalId: 'temporary', title: secret, content: `${secret} 保留草稿`, retention: 'ephemeral' })!;
    await f.engine.runUntilIdle(); expect(f.store.get('tasks', task.id)?.status).toBe('delivered');
    f.store.close();
    const reopened = new Store(join(f.config.dataDir, 'db.sqlite'), f.config.vaultDir); stores.push(reopened);
    expect(readFileSync(join(f.config.dataDir, 'db.sqlite')).includes(Buffer.from(secret))).toBe(false);
    expect(reopened.get('tasks', task.id)?.plan).toBeUndefined(); expect(reopened.get('tasks', task.id)?.artifact).toBeUndefined();
    expect(reopened.get('sources', task.sourceId)?.content).toBe(''); expect(reopened.list('cards')).toEqual([]);
  });

  it('withdraws a verified owner answer before any dependent work can use it again', async () => {
    const f = setup({ ask: true }); const task = f.ingest(); await f.engine.runUntilIdle(); const q = f.store.list('questions')[0]!;
    f.engine.answer({ questionId: q.id, taskVersion: q.taskVersion, questionVersion: q.version, actorId: 'owner', choice: 'C', text: '保留到导出成功', eventId: 'once' });
    const answerSource = f.store.list('sources').find(s => s.externalId === `answer:${q.id}`)!;
    f.engine.withdraw(answerSource.id);
    expect(f.store.get('questions', q.id)?.status).toBe('stale');
    expect(f.store.get('tasks', task.id)?.questionId).toBeUndefined();
    expect(f.store.list('rules').filter(r => r.kind === 'principle').every(r => r.status === 'suspended')).toBe(true);
  });

  it('re-ingests an expired temporary revision into the same task and reconstructs its stages', async () => {
    const f = setup(); const task = f.engine.ingest({ projectId: 'p', externalId: 'temporary-restart', title: 'Temporary', content: '仍要保留草稿', retention: 'ephemeral' })!;
    for (let i = 0; i < 4; i++) await f.engine.tick();
    expect(f.store.get('tasks', task.id)?.stage).toBe('execute');
    f.store.close();
    const reopened = new Store(join(f.config.dataDir, 'db.sqlite'), f.config.vaultDir); stores.push(reopened);
    const engine = new Workbench({ store: reopened, config: f.config, workers: [], writer: { async baseline() { return 'baseline'; }, async deliver() { throw new Error('unused'); } }, research: { async research() { return research; } } });
    const resumed = engine.ingest({ projectId: 'p', externalId: 'temporary-restart', title: 'Temporary', content: '仍要保留草稿', retention: 'ephemeral' })!;
    expect(resumed.id).toBe(task.id); expect(resumed.stage).toBe('knowledge_extract'); expect(resumed.version).toBe(2); expect(reopened.list('tasks')).toHaveLength(1);
  });

  it('drains a held worker and refuses new task stages after shutdown starts', async () => {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const f = setup({ beforeRun: async input => { if (input.role === 'knowledge_extract') await held; } }); f.ingest();
    const running = f.engine.tick(); await workerStarted(f.calls);
    let closed = false; const closing = f.engine.shutdown().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    await f.engine.tick(); expect(f.store.list('attempts')).toHaveLength(1);
    release(); await running; await closing; expect(closed).toBe(true);
    await f.engine.tick(); await f.engine.runUntilIdle(); expect(f.calls).toHaveLength(1); expect(f.store.list('attempts')).toHaveLength(1);
  });

  it('holds tasks while their project network route is not admitted and resumes after recovery', async () => {
    let available = false; const f = setup({ canRun: () => available }); const task = f.ingest();
    await f.engine.runUntilIdle(); expect(f.calls).toEqual([]); expect(f.store.get('tasks', task.id)?.status).toBe('queued');
    available = true; await f.engine.runUntilIdle(); expect(f.store.get('tasks', task.id)?.status).toBe('delivered');
  });

  it('removes retracted originals and derived text from every durable entity and Vault file, including delivered history', async () => {
    const secret = 'RETRACT_EVERY_DERIVATIVE_SENTINEL';
    const f = setup({ mutateOutput: (input, output) => {
      if (input.role === 'knowledge_extract') return { cards: [{ title: secret, body: secret, quote: '保留草稿', aliases: [secret], verification: 'reported', kind: 'fact' }] };
      if (input.role === 'case_extract') return { observations: [{ title: secret, statement: secret, quote: '保留草稿', conditions: secret, exceptions: secret }] };
      return { ...(output as object), summary: secret };
    } });
    const task = f.engine.ingest({ projectId: 'p', externalId: 'retraction', title: secret, content: `${secret} 保留草稿` })!;
    await f.engine.runUntilIdle(); expect(f.store.get('tasks', task.id)?.status).toBe('delivered');
    f.engine.withdraw(task.sourceId); f.store.close();
    const reopened = new Store(join(f.config.dataDir, 'db.sqlite'), f.config.vaultDir); stores.push(reopened);
    const serialized = ['sources', 'tasks', 'cards', 'rules', 'cases', 'questions', 'events', 'attempts', 'outbox', 'actions', 'cursors'].map(table => JSON.stringify(reopened.list(table as any))).join('\n');
    expect(serialized).not.toContain(secret); expect(reopened.get('tasks', task.id)?.status).toBe('delivered'); expect(reopened.list('receipts')).toHaveLength(1);
    const markdown = readdirSync(f.config.vaultDir, { recursive: true }).map(String).filter(path => path.endsWith('.md')).map(path => readFileSync(join(f.config.vaultDir, path), 'utf8')).join('\n');
    expect(markdown).not.toContain(secret); expect(reopened.searchCards('草稿', project)).toEqual([]);
  });

  it('blocks unsupported proceed decisions before planning or publishing', async () => {
    const f = setup({ mutateOutput: (input, output) => input.role === 'decide' ? { ...(output as object), citations: [] } : output }); const task = f.ingest();
    await f.engine.runUntilIdle(); expect(f.store.get('tasks', task.id)?.status).toBe('blocked');
    expect(f.calls.filter(call => call.role === 'plan')).toHaveLength(0); expect(f.deliveryCount()).toBe(0);
  });

  it('reserves budget for malformed paid runs so retries cannot obtain unbounded free attempts', async () => {
    const f = setup({ budget: .025, beforeRun: async () => { throw new DomainError('Paid runtime returned malformed JSON.', 'worker_output'); } }); const task = f.ingest();
    for (let i = 0; i < 5; i++) { await f.engine.runUntilIdle(); if (i < 4) f.engine.retry(task.id); }
    expect(f.calls).toHaveLength(2); expect(f.store.get('tasks', task.id)?.spentUsd).toBeCloseTo(.02);
    expect(f.store.list('attempts').every(attempt => attempt.costUsd === .01)).toBe(true);
  });

  it('reserves unavailable candidate costs before admitting a fallback and fails closed on zero estimates', async () => {
    const f = setup({ budget: .025, workerUnavailable: { grok: ['knowledge_extract'], dsh: ['knowledge_extract'], codex: ['knowledge_extract'] } }); const task = f.ingest(); await f.engine.runUntilIdle();
    expect(f.calls).toHaveLength(2); expect(f.store.get('tasks', task.id)?.spentUsd).toBeCloseTo(.02);
    const zero = setup(); zero.config.runnerPolicies.forEach(policy => { policy.costPerRunUsd = 0; }); const tiny = zero.ingest(); await zero.engine.tick();
    expect(zero.calls).toHaveLength(0); expect(zero.store.get('tasks', tiny.id)?.status).toBe('blocked');
  });

  it('dispatches one follow-up chain from a merged receipt and recorded evidence', async () => {
    const f = setup();
    try {
      const task = f.ingest();
      await f.engine.runUntilIdle();
      const delivered = f.store.get('tasks', task.id)!;
      const followUp = openReleaseFollowUp(f.store, f.config, { receiptId: delivered.receiptId!, evidenceSourceId: delivered.sourceId });
      expect(openReleaseFollowUp(f.store, f.config, { receiptId: delivered.receiptId!, evidenceSourceId: delivered.sourceId }).id).toBe(followUp.id);
      await f.engine.runUntilIdle();
      expect(f.store.get('tasks', followUp.id)?.status).toBe('delivered');
      expect(f.deliveryCount()).toBe(2);
      expect(f.store.list('actions').find(action => action.kind === 'operations.follow-up')?.payload).toMatchObject({ receiptId: delivered.receiptId, mergeSha: 'merged', taskId: followUp.id, errorRate: null, rollback: null });
      expect(f.store.list('tasks').filter(item => item.kind !== 'reference_knowledge' && item.id !== task.id && item.id !== followUp.id)).toHaveLength(0);
    } finally { await f.engine.shutdown(); }
  });

  it('retains a paid attempt reservation when source withdrawal rejects a late result', async () => {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const f = setup({ beforeRun: async () => held }); const task = f.ingest(); const running = f.engine.tick(); await workerStarted(f.calls);
    f.engine.withdraw(task.sourceId); release(); await running;
    expect(f.store.get('tasks', task.id)?.status).toBe('cancelled'); expect(f.store.get('tasks', task.id)?.spentUsd).toBeCloseTo(.01);
    expect(f.store.list('attempts')[0]?.costUsd).toBe(.01); expect(f.store.list('attempts')[0]?.status).toBe('stale'); expect(f.store.list('cards')).toHaveLength(0);
  });
});
