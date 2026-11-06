import { describe, expect, it } from 'vitest';
import { NetworkGuardian, classifyStatus, type NetworkTarget } from '../../src/integrations/network.js';
describe('network recovery',()=>{
  it('does not admit a domain without an explicitly configured target',async()=>{
    const guardian=new NetworkGuardian([],{diagnose:async()=>true,probe:async()=>({kind:'healthy',detail:'ok'}),reconnect:async()=>{},rollback:async()=>{}});expect(guardian.canRun('company')).toBe(false);await guardian.check();expect(guardian.canRun('company')).toBe(false);
  });
  it.each([false,true])('blocks an earlier healthy path damaged by a later repair (reverse=%s)',async reverse=>{
    const targets:NetworkTarget[]=[{id:'github',url:'https://api.github.com',domain:'personal'},{id:'gitlab',url:'https://git.example.org',domain:'company',adapter:{kind:'shortcuts',status:'s',connect:'c',disconnect:'d'}}];if(reverse)targets.reverse();let damaged=false;
    const guardian=new NetworkGuardian(targets,{diagnose:async()=>true,probe:async target=>({kind:target.id==='github'?(damaged?'network':'healthy'):(damaged?'healthy':'network'),detail:'probe'}),reconnect:async()=>{damaged=true;},rollback:async()=>{}});
    await guardian.check();expect(guardian.canRun('personal')).toBe(false);expect(guardian.canRun('company')).toBe(false);
  });
  it('separates authorization and limits from a failed route',()=>{
    expect(classifyStatus(401)).toBe('auth');expect(classifyStatus(429)).toBe('rate_limit');expect(classifyStatus(200)).toBe('healthy');
  });
  it('reconnects only the failed approved path and rolls back a healthy-path regression',async()=>{
    const targets:NetworkTarget[]=[{id:'github',url:'https://api.github.com',domain:'personal',adapter:{kind:'shortcuts',status:'github-status',connect:'github-connect',disconnect:'github-disconnect'}},{id:'corporate',url:'https://git.example.org',domain:'company'}];
    let changed=false,rolledBack=false;const actions:string[]=[];
    const guardian=new NetworkGuardian(targets,{diagnose:async()=>true,probe:async target=>({kind:target.id==='github'?!changed?'network':'healthy':changed&&!rolledBack?'network':'healthy',detail:'test'}),reconnect:async target=>{actions.push(target.id);changed=true;},rollback:async()=>{rolledBack=true;}});
    const results=await guardian.check();expect(actions).toEqual(['github']);expect(rolledBack).toBe(true);expect(results.find(r=>r.id==='github')?.state).toBe('blocked');
  });
});
