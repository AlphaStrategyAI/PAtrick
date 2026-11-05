import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { Store } from '../../src/store.js';
import { Workbench } from '../../src/orchestrator.js';
import { configureDemo, DemoWorker, demoResearch, demoWriter } from '../../src/demo.js';
import * as pages from '../../src/web/pages.js';

const stores:Store[]=[],roots:string[]=[];afterEach(()=>{stores.splice(0).forEach(s=>s.close());roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true}));});
function setup(mode:'live'|'demo'='live',providedStore?:Store) {
  const config=readConfig({PATRICK_MODE:mode,PATRICK_TOKEN:'test-owner-token-at-least-32-characters'}),store=providedStore??new Store(':memory:');stores.push(store);
  const engine=new Workbench({store,config,workers:[],writer:{baseline:async()=>'',deliver:async()=>{throw Error('No remote proof');}},research:{research:async()=>{throw Error('No research');}}});
  return {app:createApp({store,config,engine}),store,config,engine};
}
describe('authenticated workbench HTTP',()=>{
  const validProject = { name: 'Budget regression', repository: 'owner/repo', prdPath: 'docs/PRD.md', allowedPaths: 'docs/PRD.md' };

  it('reports unavailable feedback context after a delivered temporary conversation is replayed',async()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-http-delivered-replay-'));roots.push(root);
    const config=readConfig({PATRICK_MODE:'demo',PATRICK_DATA_DIR:root});configureDemo(config);
    const workers=(['grok','dsh','codex'] as const).map(name=>new DemoWorker(name));let deliveries=0;
    const writer={...demoWriter,async deliver(...args:Parameters<typeof demoWriter.deliver>){deliveries++;return demoWriter.deliver(...args);}};
    let store=new Store(join(root,'db.sqlite'),join(root,'vault')),engine=new Workbench({store,config,workers,writer,research:demoResearch}),app=createApp({store,config,engine});
    const payload={projectId:config.projects[0]!.id,domain:config.projects[0]!.domain,sessionId:'feedback',turnId:'1',revision:'r1',content:'保留草稿，以供恢复。',tool:'codex',retention:'ephemeral'};
    const post=()=>app.request('/api/conversations',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(payload)});
    try{
      const initial=await (await post()).json(),id=initial.task.id;
      for(let i=0;i<20&&store.get('tasks',id)?.stage!=='feedback';i++)await engine.tick();
      const before=store.get('tasks',id)!;expect(before.stage).toBe('feedback');expect(deliveries).toBe(1);
      await engine.shutdown();store.close();store=new Store(join(root,'db.sqlite'),join(root,'vault'));engine=new Workbench({store,config,workers,writer,research:demoResearch});app=createApp({store,config,engine});
      const replay=await (await post()).json();expect(replay.task).toMatchObject({id,version:before.version,stage:'feedback',status:'blocked',receiptId:before.receiptId});
      expect(replay.task.error).toContain('feedback context expired');
      const response=await app.request(`/api/tasks/${id}/retry`,{method:'POST',headers:{Accept:'application/json'}});
      expect(response.status).toBe(409);expect(await response.json()).toMatchObject({code:'feedback_context_unavailable',error:'Delivery completed, but feedback context expired; automatic recovery is unavailable.'});
      for(let i=0;i<10;i++)await engine.tick();expect(deliveries).toBe(1);
    }finally{await engine.shutdown();store.close();}
  });

  it.each(['application/json','text/html'] as const)('reports committed Vault synchronization failures safely as %s without database rereads',async accept=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-vault-http-'));roots.push(root);
    const store=new Store(join(root,'db'),join(root,'vault')),{app}=setup('demo',store);
    const created=await app.request('/api/projects',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(validProject)}),{project}=await created.json();
    const state=store as unknown as {db:{inTransaction:boolean};vaultJobs:Map<string,unknown>;publish:(job:{table:string},startup?:boolean)=>void},publish=state.publish.bind(store);let failed=false;
    const publication=vi.spyOn(state,'publish').mockImplementation((job,startup)=>{if(!state.db.inTransaction&&job.table==='sources'){failed=true;throw Object.assign(new Error('PRIVATE_SQLITE_MESSAGE'),{code:'SQLITE_BUSY'});}return publish(job,startup);});
    const get=store.get.bind(store),getSpy=vi.spyOn(store,'get').mockImplementation(((...args:Parameters<typeof get>)=>{if(failed)throw Error('unexpected database reread');return get(...args);}) as typeof store.get);
    const list=store.list.bind(store),listSpy=vi.spyOn(store,'list').mockImplementation(((...args:Parameters<typeof list>)=>{if(failed)throw Error('unexpected database reread');return list(...args);}) as typeof store.list);
    let response:Response;
    try{response=await app.request('/api/tasks',{method:'POST',headers:{'Content-Type':'application/json',Accept:accept},body:JSON.stringify({projectId:project.id,title:'Saved source',content:'SYNTHETIC_HTTP_SENTINEL'})});}
    finally{publication.mockRestore();getSpy.mockRestore();listSpy.mockRestore();}
    expect(failed).toBe(true);expect(response.status).toBe(503);const text=await response.text();
    expect(text).toContain('Changes may have been saved, but Vault synchronization failed; retry.');expect(text).not.toContain('PRIVATE_SQLITE_MESSAGE');
    if(accept==='application/json')expect(JSON.parse(text).code).toBe('vault_sync_unavailable');
    expect(store.list('sources').some(source=>source.content==='SYNTHETIC_HTTP_SENTINEL')).toBe(true);expect(state.vaultJobs.size).toBeGreaterThan(0);
  });

  it.each(['application/json','text/html'] as const)('maps raw SQLite errors to safe %s without database rereads',async accept=>{
    const {app,store,engine}=setup('demo');
    const created=await app.request('/api/projects',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(validProject)}),{project}=await created.json();
    let failed=false;const ingest=vi.spyOn(engine,'ingest').mockImplementation(()=>{failed=true;throw Object.assign(new Error('PRIVATE_RAW_SQLITE_MESSAGE'),{code:'SQLITE_LOCKED'});});
    const get=store.get.bind(store),getSpy=vi.spyOn(store,'get').mockImplementation(((...args:Parameters<typeof get>)=>{if(failed)throw Error('unexpected database reread');return get(...args);}) as typeof store.get);
    const list=store.list.bind(store),listSpy=vi.spyOn(store,'list').mockImplementation(((...args:Parameters<typeof list>)=>{if(failed)throw Error('unexpected database reread');return list(...args);}) as typeof store.list);
    let response:Response;
    try{response=await app.request('/api/tasks',{method:'POST',headers:{'Content-Type':'application/json',Accept:accept},body:JSON.stringify({projectId:project.id,title:'Source',content:'ordinary source'})});}
    finally{ingest.mockRestore();getSpy.mockRestore();listSpy.mockRestore();}
    expect(response.status).toBe(503);const text=await response.text();expect(text).toContain('Knowledge temporarily unavailable; retry.');expect(text).not.toContain('PRIVATE_RAW_SQLITE_MESSAGE');
  });

  it('renders the knowledge page inside one synchronous snapshot and rejects a thenable without leaking it',async()=>{
    const {app,store}=setup('demo');
    const created=await app.request('/api/projects',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(validProject)}),{project}=await created.json();
    let depth=0;const render=vi.spyOn(pages,'renderPage').mockImplementationOnce(()=>{depth=(store as any).readDepth;return Promise.resolve('PRIVATE_ASYNC_PAGE') as never;});
    try{
      const response=await app.request(`/knowledge?project=${project.id}`,{headers:{Accept:'application/json'}});
      expect(depth).toBe(1);expect(response.status).toBe(500);expect(await response.text()).not.toContain('PRIVATE_ASYNC_PAGE');
    }finally{render.mockRestore();}
    expect((store as any).operation).toBeUndefined();expect((await app.request(`/knowledge?project=${project.id}`)).status).toBe(200);
  });
  it('returns generic JSON and static HTML on knowledge contention without reading the Store again',async()=>{
    const {app,store}=setup('demo');
    const created=await app.request('/api/projects',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(validProject)}),{project}=await created.json();
    let failed=false;
    const lookup=vi.spyOn(store,'searchCards').mockImplementation(()=>{failed=true;throw new DomainError('Knowledge temporarily unavailable; retry.','knowledge_snapshot_unavailable',503);});
    const get=store.get.bind(store),getSpy=vi.spyOn(store,'get').mockImplementation(((...args:Parameters<typeof get>)=>{if(failed)throw Error('unexpected Store reread');return get(...args);}) as typeof store.get);
    const list=store.list.bind(store),listSpy=vi.spyOn(store,'list').mockImplementation(((...args:Parameters<typeof list>)=>{if(failed)throw Error('unexpected Store reread');return list(...args);}) as typeof store.list);
    try{
      const url=`/api/lookup?project=${project.id}&domain=${project.domain}&q=term`;
      const json=await app.request(url,{headers:{Accept:'application/json'}});expect(json.status).toBe(503);expect(await json.json()).toEqual({error:'Knowledge temporarily unavailable; retry.',code:'knowledge_snapshot_unavailable'});
      failed=false;const html=await app.request(url,{headers:{Accept:'text/html'}});expect(html.status).toBe(503);expect(await html.text()).toContain('Knowledge temporarily unavailable; retry.');
      failed=false;lookup.mockRestore();getSpy.mockRestore();listSpy.mockRestore();
      expect((await app.request(url)).status).toBe(200);
    }finally{lookup.mockRestore();getSpy.mockRestore();listSpy.mockRestore();}
  });

  it.each(['/api/state','/knowledge'])('returns stale_project_state when billing project inputs change before %s projection',async path=>{
    const {app,store,engine}=setup('demo');
    const created=await app.request('/api/projects',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(validProject)}),{project}=await created.json();
    const billing=vi.spyOn(engine,'billingStatuses').mockImplementation(async()=>{store.save('projects',{...project,name:'Changed during billing'});return {};});
    try{const response=await app.request(`${path}?project=${project.id}`,{headers:{Accept:path==='/knowledge'?'text/html':'application/json'}});expect(response.status).toBe(409);expect(await response.text()).toContain('Project state changed; retry.');}
    finally{billing.mockRestore();}
  });

  it.each(['task','conversation'] as const)('rejects internal refresh on %s intake without scheduling or GET',async kind=>{
    const {app,store,engine}=setup('demo');
    const created=await app.request('/api/projects',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(validProject)});
    const {project}=await created.json(),before={tasks:store.list('tasks'),sources:store.list('sources'),actions:store.list('actions'),attempts:store.list('attempts')};
    const payload=kind==='task'?{projectId:project.id,title:'Task',content:'source',refresh:'current'}:{projectId:project.id,domain:project.domain,sessionId:'session',turnId:'turn',revision:'r1',content:'source',tool:'codex',retention:'permanent',refresh:'current'};
    const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw new Error('unexpected provider GET');});
    try{
      const response=await app.request(kind==='task'?'/api/tasks':'/api/conversations',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(payload)});
      expect(response.status).toBe(400);await engine.runUntilIdle();
      expect(store.list('tasks')).toEqual(before.tasks);expect(store.list('sources')).toEqual(before.sources);expect(store.list('actions')).toEqual(before.actions);expect(store.list('attempts')).toEqual(before.attempts);expect(fetch).not.toHaveBeenCalled();
    }finally{fetch.mockRestore();}
  });

  it('accepts the existing manual task form with its fixed kind field',async()=>{
    const {app,store}=setup('demo');
    const created=await app.request('/api/projects',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(validProject)}),{project}=await created.json();
    const response=await app.request('/api/tasks',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams({projectId:project.id,kind:'manual',title:'Task',content:'source'})});
    expect(response.status).toBe(200);expect(store.list('tasks')).toHaveLength(1);expect(store.list('sources')[0]?.kind).toBe('manual');
  });

  for (const encoding of ['json', 'form'] as const) {
    it.each([
      ['numeric zero', 0, 0], ['string zero', '0', 0], ['missing', undefined, 5],
      ['blank', '', 5], ['whitespace', '  ', 5], ['positive', .25, .25],
      ['maximum', '10000', 10000], ['decimal', '.25', .25],
      ['scientific', '  +2.5e-1  ', .25],
    ] as const)(`preserves/defaults ${encoding} project budget: %s`, async (_, budgetUsd, expected) => {
      const { app, store } = setup('demo');
      const payload = { ...validProject, ...(budgetUsd === undefined ? {} : { budgetUsd }) };
      const response = await app.request('/api/projects', { method: 'POST', headers: { 'Content-Type': encoding === 'json' ? 'application/json' : 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: encoding === 'json' ? JSON.stringify(payload) : new URLSearchParams(Object.entries(payload).map(([key, value]) => [key, String(value)])) });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.project.budgetUsd).toBe(expected);
      expect(data.redirect).toBe(`/?project=${data.project.id}`);
      expect(store.get('projects', data.project.id)?.budgetUsd).toBe(expected);
      if (expected === 0) {
        const settings = await app.request(`/settings?project=${data.project.id}`);
        expect(await settings.text()).toContain('<dt>单任务预算</dt><dd>$0.00</dd>');
      }
    });

    it.each(['-1', '10000.01', 'Infinity', '-Infinity', 'NaN', 'oops', '0x10', '0b10', '0o10', '1_000', '1,000', '1e999'])(`rejects invalid ${encoding} budget %s without persisting a project`, async budgetUsd => {
      const { app, store, config } = setup('demo');
      const payload = { ...validProject, budgetUsd };
      const response = await app.request('/api/projects', { method: 'POST', headers: { 'Content-Type': encoding === 'json' ? 'application/json' : 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: encoding === 'json' ? JSON.stringify(payload) : new URLSearchParams(payload) });
      expect(response.status).toBe(400);
      expect(store.list('projects')).toEqual([]);
      expect(config.projects).toEqual([]);
    });
  }

  it.each([true, false, null, [], [0], {}, -1, 10000.01])('rejects invalid JSON budget %j without persisting a project', async budgetUsd => {
    const { app, store, config } = setup('demo');
    const response = await app.request('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ ...validProject, budgetUsd }) });
    expect(response.status).toBe(400);
    expect(store.list('projects')).toEqual([]);
    expect(config.projects).toEqual([]);
  });

  it('renders a zero-dollar starting budget with a pending-entitlement explanation', async () => {
    const { app } = setup('demo');
    const response = await app.request('/settings');
    const html = await response.text();
    const budgetInput = html.match(/<input[^>]*name="budgetUsd"[^>]*>/)?.[0];
    expect(budgetInput).toContain('type="number" min="0" max="10000" step="0.01"');
    expect(budgetInput).toContain('value="0"');
    expect(html).toContain('0 将阻止需要费用预留的运行器；订阅权限仍需单独核验。');
  });

  it('keeps business state private and rejects hostile origins',async()=>{
    const {app,config}=setup();
    expect((await app.request('/api/state')).status).toBe(401);
    expect((await app.request('/api/state',{headers:{Authorization:`Bearer ${config.authToken}`}})).status).toBe(200);
    const login=await app.request('/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:'http://localhost'},body:new URLSearchParams({token:config.authToken})});
    expect(login.status).toBe(303);
    const cookie=login.headers.get('set-cookie')!;
    expect((await app.request('/api/search/rebuild',{method:'POST',headers:{Cookie:cookie,Origin:'https://evil.example'}})).status).toBe(403);
  });
  it('validates project settings and renders useful empty states',async()=>{
    const {app}=setup('demo');
    const response=await app.request('/');expect(response.status).toBe(200);expect(await response.text()).toContain('PAtrick');
    expect((await app.request('/api/projects',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({name:'Bad',repository:'owner/repo',prdPath:'../secret',allowedPaths:'../secret'})})).status).toBe(400);
  });
  it('does not accept a caller-supplied identity for answers',async()=>{
    const {app}=setup('demo');
    const response=await app.request('/api/questions/missing/answer',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({taskVersion:1,questionVersion:1,choice:'A',actorId:'someone-else',eventId:'e'})});
    expect(response.status).toBe(404);
  });
  it('persists the owner-selected dsh execution preference in a new project',async()=>{
    const {app,store}=setup('demo');const response=await app.request('/api/projects',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({name:'Execution preference',repository:'owner/repo',prdPath:'docs/PRD.md',allowedPaths:['docs/PRD.md'],executionRunner:'dsh'})});
    expect(response.status).toBe(200);const data=await response.json();expect(data.project.executionRunner).toBe('dsh');expect(store.get('projects',data.project.id)?.executionRunner).toBe('dsh');
  });
});

// Current synthetic host evidence is injected through Workbench's canonical authority.
import { BillingAuthority } from '../../src/billing.js';
import { readiness } from '../../src/readiness.js';
import { makeBillingFixture } from '../fixtures/billing.js';
import { DomainError, SubscriptionAccessError, type WorkerAdapter } from '../../src/domain.js';
const billingFixtures: ReturnType<typeof makeBillingFixture>[] = [];
afterEach(() => billingFixtures.splice(0).forEach(f => f.dispose()));
function billingHttp(current = true, workers: WorkerAdapter[] = []) {
  const f = makeBillingFixture(); billingFixtures.push(f); f.config.ownerId = f.project.ownerId; f.config.mode = 'live'; f.config.authToken = 'synthetic-http-owner-at-least-32-characters';
  f.config.workers.codex = { instance: 'synthetic', command: 'synthetic', args: [], timeoutMs: 1000, isolation: 'lima' };
  const billing = new BillingAuthority(f.store, f.config, current ? f.currentProvider : { async read() { return undefined; } }, { proofRoot: f.proofRoot, now: f.now });
  const engine = new Workbench({ store: f.store, config: f.config, workers, billing, writer: { async baseline() { return ''; }, async deliver() { throw Error('Synthetic only'); } }, research: { async research() { throw Error('Synthetic only'); } } });
  const app = createApp({ store: f.store, config: f.config, engine });
  return { ...f, billing, engine, app, headers: { Authorization: `Bearer ${f.config.authToken}` } };
}
const pendingCopy = '订阅费用边界待核验；0 美元不会自动准入。';
const includedCopy = '已核验订阅内额度；额外计费路径禁用，调度前仍需复核。';
const incidentCopy = '已暂停：发现订阅费用边界异常，保留任务与账本，等待本人核查。';

it('synchronous readiness fails closed with admitted zero policy and no current statuses', () => {
  const f = billingHttp();
  expect(readiness(f.config).find(v => v.name === '隔离 worker')?.ready).toBe(false);
});
it.each([true, false])('HTTP settings/state uses current authority evidence (%s) without allocating', async current => {
  const f = billingHttp(current);
  const state = await (await f.app.request('/api/state', { headers: f.headers })).json();
  expect(state.billing[f.project.id].codex).toMatchObject({ state: current ? 'included-admitted' : 'pending-proof', attemptsLimit: 32 });
  expect(state.readiness.find((v: { name: string }) => v.name === '隔离 worker').ready).toBe(current);
  const html = await (await f.app.request('/settings', { headers: f.headers })).text();
  expect(html).toContain(current ? includedCopy : pendingCopy);
  if (!current) expect(html).not.toContain(includedCopy);
  expect(html).toContain('额外支出上限'); expect(html).toContain('$0.00');
  expect(f.store.list('attempts')).toHaveLength(0); expect(f.store.get('tasks', f.task.id)?.attempts).toBe(0);
  for (const secret of [f.proofPath, f.proof.evidenceDigest, f.proof.accountFingerprint, f.proof.workspaceFingerprint, f.proof.authRouteFingerprint]) { expect(JSON.stringify(state)).not.toContain(secret); expect(html).not.toContain(secret); }
});
it('task HTTP suppresses raw provider errors/private billing metadata and exposes only safe accounting status', async () => {
  const f = billingHttp();
  await expect(f.billing.runLima(f.input, 'codex', undefined, undefined, async () => { throw new Error('RAW-PROVIDER-SECRET synthetic-account /private/proof'); })).rejects.toThrow('RAW-PROVIDER');
  const attempt = f.store.list('attempts')[0]!;
  f.store.save('attempts', { ...attempt, billing: undefined, error: 'RAW-PROVIDER-SECRET /private/proof', provider: 'RAW-PROVIDER-SECRET', model: 'RAW-PROVIDER-SECRET' });
  f.store.save('tasks', { ...f.store.get('tasks', f.task.id)!, status: 'blocked', error: 'RAW-PROVIDER-SECRET /private/proof' });
  for (const path of ['/api/state', `/api/tasks/${f.task.id}`, `/tasks/${f.task.id}`, '/']) {
    const text = await (await f.app.request(path, { headers: f.headers })).text();
    expect(text).not.toContain('RAW-PROVIDER-SECRET'); expect(text).not.toContain('/private/proof'); expect(text).not.toContain('profileHash'); expect(text).not.toContain('evidenceDigest'); expect(text).not.toContain('authorityEpoch');
  }
  const detail = await (await f.app.request(`/api/tasks/${f.task.id}`, { headers: f.headers })).json();
  expect(detail.billing).toMatchObject({ attempts: 1, attemptsLimit: 32, additionalSpendingCapUsd: 0 });
});
it.each(['cap', 'incident'] as const)('manual HTTP retry preserves %s hold and renders truthful no-JS task explanation', async kind => {
  const f = billingHttp();
  if (kind === 'cap') {
    f.config.maxAttemptsPerTask = 1;
    await f.billing.runLima(f.input, 'codex', undefined, undefined, async () => ({ output: { cards: [] }, provider: f.included.provider, model: f.included.model, costUsd: 0 }));
    await expect(f.billing.reserve(f.input, 'codex')).rejects.toMatchObject({ code: 'subscription_attempt_limit' });
  } else await expect(f.billing.runLima(f.input, 'codex', undefined, undefined, async () => ({ output: { cards: [] }, provider: f.included.provider, model: f.included.model, costUsd: 0.2 }))).rejects.toMatchObject({ code: 'billing_policy_violation' });
  const before = f.store.get('tasks', f.task.id)!;
  const response = await f.app.request(`/api/tasks/${f.task.id}/retry`, { method: 'POST', headers: { ...f.headers, Accept: 'application/json' } });
  expect(response.status).toBe(409); expect((await response.json()).code).toBe(before.billingStop?.code);
  expect(f.store.get('tasks', f.task.id)).toEqual(before);
  const html = await (await f.app.request(`/tasks/${f.task.id}`, { headers: f.headers })).text();
  expect(html).toContain(kind === 'cap' ? '已达到任务总尝试上限（已用 1 / 上限 1）；重试不会重置。' : incidentCopy);
  expect(html).not.toContain(`action="/api/tasks/${f.task.id}/retry"`);
  const form = await f.app.request(`/api/tasks/${f.task.id}/retry`, { method: 'POST', headers: { ...f.headers, Accept: 'text/html' } });
  expect(form.status).toBe(409); expect(await form.text()).toContain(kind === 'cap' ? '重试不会重置' : incidentCopy);
});
it('a no-charge profile refusal is blocked availability, without financial incident or claimed fallback success', async () => {
  const f = billingHttp();
  await expect(f.billing.runLima(f.input, 'codex', undefined, undefined, async () => { throw new SubscriptionAccessError({ disposition: 'verified-no-charge-refusal', reason: 'quota', observedAt: f.at.toISOString(), evidenceDigest: 'synthetic-refusal-private', noChargeEvidenceDigest: 'synthetic-charge-private' }, 'Synthetic verified refusal'); })).rejects.toBeInstanceOf(SubscriptionAccessError);
  const state = await (await f.app.request('/api/state', { headers: f.headers })).json();
  expect(state.billing[f.project.id].codex).toMatchObject({ state: 'blocked', reason: 'subscription_profile_unavailable' });
  const html = await (await f.app.request('/settings', { headers: f.headers })).text();
  expect(html).toContain('订阅额度或认证暂不可用；等待新的宿主核验。'); expect(html).not.toContain(incidentCopy); expect(html).not.toContain(includedCopy); expect(html).not.toContain('已继续原任务');
});
it('metered settings explains positive reservation even when zero additional-spending cap blocks admission', async () => {
  const f = billingHttp(); f.config.billingBoundary = 'metered-only'; f.included.billing = { mode: 'metered-api' }; f.included.costPerRunUsd = 1;
  const html = await (await f.app.request('/settings', { headers: f.headers })).text();
  expect(html).toContain('需正数保守费用预留；0 美元上限将阻止调用。'); expect(html).not.toContain(includedCopy);
});
it('settings distinguishes configured model/provider from currently verified billing', async () => {
  const f = billingHttp(false);
  const html = await (await f.app.request('/settings', { headers: f.headers })).text();
  expect(html).not.toContain('>已准入<'); expect(html).toContain(`已配置：${f.included.provider} · ${f.included.model}`);
  expect(html).toContain(pendingCopy); expect(f.store.list('attempts')).toHaveLength(0);
});

it.each(['accepted', 'mismatched-result'] as const)('task trace preserves canonical host provider/model with truthful %s provenance and no private metadata', async outcome => {
  const f = billingHttp();
  const run = f.billing.runLima(f.input, 'codex', undefined, undefined, async () => ({ output: { cards: [] }, provider: outcome === 'accepted' ? f.included.provider : 'UNTRUSTED-RESULT-PROVIDER', model: f.included.model, costUsd: 0 }));
  if (outcome === 'accepted') await run; else await expect(run).rejects.toMatchObject({ code: 'provider_not_admitted' });
  const response = await f.app.request(`/api/tasks/${f.task.id}`, { headers: f.headers }), data = await response.json();
  expect(data.attempts[0]).toMatchObject({ provider: f.included.provider, model: f.included.model, configurationSource: outcome === 'accepted' ? 'host-validated' : 'configured' });
  expect(data.attempts[0].billing).toBeUndefined();
  const html = await (await f.app.request(`/tasks/${f.task.id}`, { headers: f.headers })).text();
  expect(html).toContain(f.included.provider); expect(html).toContain(f.included.model);
  expect(html).toContain(outcome === 'accepted' ? '宿主核验的实际运行配置' : '已配置的运行参数（本次未取得已接受结果）');
  for (const text of [JSON.stringify(data), html]) { expect(text).not.toContain('UNTRUSTED-RESULT-PROVIDER'); expect(text).not.toContain('profileHash'); expect(text).not.toContain('evidenceDigest'); expect(text).not.toContain('authorityEpoch'); }
});
it('historical provider failure events are sanitized along with task errors on every owner surface', async () => {
  const f = billingHttp();
  f.store.save('events', { id: 'synthetic-old-provider-failure', projectId: f.project.id, domain: f.project.domain, taskId: f.task.id, type: 'private-provider-detail', message: 'OLD-RAW-PROVIDER-SECRET', data: { stage: f.task.stage, runAfter: f.at.toISOString(), accountFingerprint: 'OLD-RAW-PROVIDER-SECRET' }, createdAt: f.at.toISOString() });
  for (const path of ['/api/state', `/api/tasks/${f.task.id}`, `/tasks/${f.task.id}`, '/activity']) {
    expect(await (await f.app.request(path, { headers: f.headers })).text()).not.toContain('OLD-RAW-PROVIDER-SECRET');
  }
});

it('a live baseline-change worker error replans without exposing raw details or resetting accounting', async () => {
  const marker = 'SYNTHETIC-LIVE-BASELINE-PROVIDER-SECRET';
  let calls = 0;
  const f = billingHttp(true, [{ name: 'codex', async run() { calls++; throw new DomainError(marker, 'baseline_changed', 409); } }]);
  f.config.maxAttemptsPerTask = 7;
  await f.billing.runLima(f.input, 'codex', undefined, undefined, async () => ({ output: { cards: [] }, provider: f.included.provider, model: f.included.model, costUsd: 0 }));
  const before = { ...f.store.get('tasks', f.task.id)!, attemptLimit: 7, repairCount: 1,
    plan: { taskVersion: f.task.version, sourceRevision: f.task.sourceRevision, baselineSha: 'synthetic-old-baseline', summary: 'Synthetic old plan', paths: ['docs/PRD.md'], steps: ['Synthetic step'], tests: ['synthetic check'], stopConditions: ['Synthetic stop'] },
    artifact: { taskVersion: f.task.version, planHash: 'synthetic-plan', baselineSha: 'synthetic-old-baseline', files: [{ path: 'docs/PRD.md', content: 'Synthetic only' }], tests: [{ command: 'synthetic check', passed: true, output: 'Synthetic' }], summary: 'Synthetic artifact' },
    review: { taskVersion: f.task.version, planHash: 'synthetic-plan', artifactHash: 'synthetic-artifact', verdict: 'repair' as const, summary: 'Synthetic review', issues: [], tests: [{ command: 'synthetic check', passed: true, output: 'Synthetic' }] },
    baselineFiles: [{ path: 'docs/PRD.md', content: 'Synthetic baseline' }], receiptId: 'synthetic-old-receipt' };
  f.store.save('tasks', before);
  await f.engine.tick();
  const after = f.store.get('tasks', f.task.id)!;
  expect(calls).toBe(1);
  expect(after).toMatchObject({ version: before.version + 1, stage: 'plan', status: 'planning', attempts: before.attempts + 1, attemptLimit: 7, billingBoundary: before.billingBoundary, spentUsd: before.spentUsd, budgetUsd: before.budgetUsd, repairCount: 0, error: 'baseline_changed' });
  expect(after.billingStop).toEqual(before.billingStop);
  for (const key of ['plan', 'artifact', 'review', 'baselineFiles', 'receiptId'] as const) expect(after[key]).toBeUndefined();
  expect(f.store.list('attempts').filter(a => a.taskId === f.task.id)).toHaveLength(2);
  expect(f.store.list('attempts').find(a => a.status === 'failed')).toMatchObject({ taskVersion: before.version, error: 'baseline_changed', billing: { ordinal: 2, attemptLimit: 7 } });
  expect(f.store.list('actions').filter(a => a.taskId === f.task.id && a.kind === before.stage)).toMatchObject([{ status: 'completed', payload: { taskVersion: before.version } }]);
  expect(f.store.list('events').filter(e => e.type === 'baseline.changed')).toHaveLength(1);
  for (const path of ['/api/state', `/api/tasks/${f.task.id}`, `/tasks/${f.task.id}`, '/activity']) {
    const response = await f.app.request(path, { headers: f.headers });
    const text = await response.text();
    expect(response.status).toBe(200); expect.soft(text, path).not.toContain(marker);
    expect(text).toContain('仓库基线已变化；将重新规划并验证。'); expect(text).toContain('baseline.changed');
  }
  expect(JSON.stringify({ task: after, events: f.store.list('events'), outbox: f.store.list('outbox') })).not.toContain(marker);
});

it('historical baseline-change events with empty data hide raw details on every owner surface', async () => {
  const f = billingHttp(), marker = 'SYNTHETIC-HISTORICAL-BASELINE-PROVIDER-SECRET';
  f.store.save('events', { id: 'synthetic-old-baseline-change', projectId: f.project.id, domain: f.project.domain, taskId: f.task.id, type: 'baseline.changed', message: marker, data: {}, createdAt: f.at.toISOString() });
  const before = f.store.get('tasks', f.task.id);
  for (const path of ['/api/state', `/api/tasks/${f.task.id}`, `/tasks/${f.task.id}`, '/activity']) {
    const response = await f.app.request(path, { headers: f.headers });
    const text = await response.text();
    expect(response.status).toBe(200); expect.soft(text, path).not.toContain(marker);
    expect(text).toContain('仓库基线已变化；将重新规划并验证。'); expect(text).toContain('baseline.changed');
  }
  expect(f.store.get('tasks', f.task.id)).toEqual(before);
  expect(f.store.list('attempts')).toHaveLength(0);
  expect(f.store.get('events', 'synthetic-old-baseline-change')?.message).toBe(marker);
});

it('a successful host-ledger trace retains historical provider/model after ordinary policy revision while current admission returns pending', async () => {
  const f = billingHttp(), provider = f.included.provider, model = f.included.model;
  await f.billing.runLima(f.input, 'codex', undefined, undefined, async () => ({ output: { cards: [] }, provider, model, costUsd: 0 }));
  f.included.provider = 'synthetic-revised-provider'; f.included.model = 'synthetic-revised-model';
  const data = await (await f.app.request(`/api/tasks/${f.task.id}`, { headers: f.headers })).json();
  expect(data.attempts[0]).toMatchObject({ provider, model, configurationSource: 'host-validated' });
  expect(data.billing.state).toBe('pending-proof'); expect(data.attempts[0].billing).toBeUndefined();
  const html = await (await f.app.request(`/tasks/${f.task.id}`, { headers: f.headers })).text();
  expect(html).toContain(provider); expect(html).toContain(model); expect(html).toContain(pendingCopy);
});
it('current billing status is bound to the exact admitted role policy rather than another policy for the same runner', async () => {
  const f = billingHttp();
  f.config.runnerPolicies.push({ ...f.included, roles: ['decide'], model: 'synthetic-other-role-model' });
  f.store.save('tasks', { ...f.task, stage: 'decide' });
  const data = await (await f.app.request(`/api/tasks/${f.task.id}`, { headers: f.headers })).json();
  expect(data.billing.state).toBe('pending-proof');
  const html = await (await f.app.request('/settings', { headers: f.headers })).text();
  expect(html.match(/>费用边界已核验</g)).toHaveLength(1);
});
it('an unadmitted earlier policy never hides the canonical admitted policy status for the same runner', async () => {
  const f = billingHttp(); f.config.runnerPolicies.unshift({ ...f.included, admitted: false });
  const state = await (await f.app.request('/api/state', { headers: f.headers })).json();
  expect(state.billing[f.project.id].codex.state).toBe('included-admitted');
});
it('two independently verified canonical role/model policies on one runner both receive their own current status', async () => {
  const f = billingHttp();
  const second = { ...f.included, roles: ['knowledge_extract' as const, 'decide' as const], model: 'synthetic-independent-decide-model', billing: { mode: 'included-subscription' as const, admissionId: 'synthetic-decide-proof' } };
  f.config.runnerPolicies.push(second);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`${f.root}/synthetic-decide-proof.json`, JSON.stringify({ ...f.proof, id: 'synthetic-decide-proof', model: second.model }), { mode: 0o600 });
  const reads: string[] = [];
  const provider = { async read(policy: typeof f.included) { reads.push(policy.model); return { ...f.current, model: policy.model }; } };
  const billing = new BillingAuthority(f.store, f.config, provider, { proofRoot: f.root, now: f.now });
  expect(await billing.status(f.project, second)).toMatchObject({ state: 'included-admitted' }); reads.length = 0;
  const engine = new Workbench({ store: f.store, config: f.config, workers: [], billing, writer: { async baseline() { return ''; }, async deliver() { throw Error('Synthetic only'); } }, research: { async research() { throw Error('Synthetic only'); } } });
  const app = createApp({ store: f.store, config: f.config, engine });
  f.store.save('tasks', { ...f.task, stage: 'decide' });
  const data = await (await app.request(`/api/tasks/${f.task.id}`, { headers: f.headers })).json();
  expect(data.billing.state).toBe('included-admitted');
  expect(reads.sort()).toEqual([f.included.model, second.model].sort()); reads.length = 0;
  const html = await (await app.request('/settings', { headers: f.headers })).text();
  expect(html.match(/>费用边界已核验</g)).toHaveLength(2);
  expect(reads.sort()).toEqual([f.included.model, second.model].sort());
  expect(f.store.list('attempts')).toHaveLength(0);
});
