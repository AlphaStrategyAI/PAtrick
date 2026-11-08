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
  it('tells the owner about authentication, throttling and MFA without reconnecting',async()=>{
    const targets:NetworkTarget[]=[{id:'github',url:'https://api.github.com',domain:'personal',adapter:{kind:'shortcuts',status:'s',connect:'c',disconnect:'d'}}];
    const notices:string[]=[];let reconnects=0;
    const kinds=['auth','rate_limit','mfa'] as const;
    for(const kind of kinds){
      const guardian=new NetworkGuardian(targets,{diagnose:async()=>true,probe:async()=>({kind,detail:'HTTP'}),reconnect:async()=>{reconnects++;},rollback:async()=>{}},result=>notices.push(result.reason));
      const first=await guardian.check();
      await guardian.check();
      expect(first[0]).toMatchObject({id:'github',state:'blocked'});
    }
    expect(reconnects).toBe(0);
    expect(notices.filter(notice=>notice.includes('认证没有通过'))).toHaveLength(1);
    expect(notices.filter(notice=>notice.includes('暂时被限流'))).toHaveLength(1);
    expect(notices.filter(notice=>notice.includes('本人完成登录'))).toHaveLength(1);
    expect(notices.some(notice=>notice.includes('不会自动重连'))).toBe(true);
  });
  it('reconnects only the failed approved path and rolls back a healthy-path regression',async()=>{
    const targets:NetworkTarget[]=[{id:'github',url:'https://api.github.com',domain:'personal',adapter:{kind:'shortcuts',status:'github-status',connect:'github-connect',disconnect:'github-disconnect'}},{id:'corporate',url:'https://git.example.org',domain:'company'}];
    let changed=false,rolledBack=false;const actions:string[]=[];
    const guardian=new NetworkGuardian(targets,{diagnose:async()=>true,probe:async target=>({kind:target.id==='github'?!changed?'network':'healthy':changed&&!rolledBack?'network':'healthy',detail:'test'}),reconnect:async target=>{actions.push(target.id);changed=true;},rollback:async()=>{rolledBack=true;}});
    const results=await guardian.check();expect(actions).toEqual(['github']);expect(rolledBack).toBe(true);expect(results.find(r=>r.id==='github')?.state).toBe('blocked');
  });
});
