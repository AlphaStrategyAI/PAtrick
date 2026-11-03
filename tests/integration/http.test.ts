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
});
