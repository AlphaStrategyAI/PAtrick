import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { Store } from '../../src/store.js';
import { Workbench } from '../../src/orchestrator.js';

const stores:Store[]=[];afterEach(()=>stores.splice(0).forEach(s=>s.close()));
function setup(mode:'live'|'demo'='live') {
  const config=readConfig({PATRICK_MODE:mode,PATRICK_TOKEN:'test-owner-token-at-least-32-characters'}),store=new Store(':memory:');stores.push(store);
  const engine=new Workbench({store,config,workers:[],writer:{baseline:async()=>'',deliver:async()=>{throw Error('No remote proof');}},research:{research:async()=>{throw Error('No research');}}});
  return {app:createApp({store,config,engine}),store,config};
}
describe('authenticated workbench HTTP',()=>{
  const validProject = { name: 'Budget regression', repository: 'owner/repo', prdPath: 'docs/PRD.md', allowedPaths: 'docs/PRD.md' };

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
