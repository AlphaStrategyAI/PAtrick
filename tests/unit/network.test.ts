import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NetworkGuardian, admitDualVpn, classifyStatus, heartbeatIntervalMs, inspectPath, type NetworkTarget, type PathObservation, type ProbeKind } from '../../src/integrations/network.js';
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
  it('reconnects only an approved route failure and leaves auth, limits and MFA alone',async()=>{
    const adapter={kind:'shortcuts' as const,status:'s',connect:'c',disconnect:'d'};
    const cases:Array<{kind:ProbeKind;stage:'dns'|'route'|'tls'|'peer';reconnect:boolean;approved:boolean}>=[
      {kind:'network',stage:'dns',reconnect:true,approved:true},{kind:'network',stage:'route',reconnect:true,approved:true},{kind:'network',stage:'tls',reconnect:true,approved:true},
      {kind:'healthy',stage:'peer',reconnect:false,approved:true},{kind:'auth',stage:'peer',reconnect:false,approved:true},{kind:'rate_limit',stage:'peer',reconnect:false,approved:true},{kind:'mfa',stage:'peer',reconnect:false,approved:true},
      {kind:'network',stage:'dns',reconnect:false,approved:false},
    ];
    for(const item of cases){
      let reconnects=0;
      const target:NetworkTarget={id:'path',url:'https://example.test',domain:'personal',...(item.approved?{adapter}:{})};
      const guardian=new NetworkGuardian([target],{diagnose:async()=>item.stage==='dns'||item.stage==='route'?{ok:false,stage:item.stage,kind:item.kind,detail:item.stage}:true,probe:async()=>({kind:item.kind,detail:item.stage,stage:item.stage}),reconnect:async()=>{reconnects++;},rollback:async()=>{}});
      await guardian.check();
      expect(reconnects,item.stage+item.kind).toBe(item.reconnect?1:0);
    }
  });
  it('locks a failed path behind backoff and suspends a domain with no qualified path',async()=>{
    let reconnects=0;
    const target:NetworkTarget={id:'path',url:'https://example.test',domain:'personal',adapter:{kind:'shortcuts',status:'s',connect:'c',disconnect:'d'}};
    const guardian=new NetworkGuardian([target],{diagnose:async()=>true,probe:async()=>({kind:'network',detail:'down',stage:'tls'}),reconnect:async()=>{reconnects++;},rollback:async()=>{}});
    await guardian.check();await guardian.check();
    expect(reconnects).toBe(1);
    expect(guardian.canRun('personal')).toBe(false);
  });
  it('rechecks the heartbeat before reconciling a recovered path',async()=>{
    let repaired=false;const after:string[]=[];let reconciled=0;
    const targets:NetworkTarget[]=[{id:'work',url:'https://example.test',domain:'personal',adapter:{kind:'shortcuts',status:'s',connect:'c',disconnect:'d'}},{id:'beat',url:'http://127.0.0.1:4317/health',domain:'personal',heartbeat:true}];
    const guardian=new NetworkGuardian(targets,{diagnose:async()=>true,probe:async target=>{if(repaired)after.push(target.id);return {kind:target.id==='work'&&!repaired?'network':'healthy',detail:'probe'};},reconnect:async()=>{repaired=true;},rollback:async()=>{}},undefined,{reconcile:()=>{reconciled++;}});
    await guardian.check();
    expect(repaired).toBe(true);expect(after).toContain('beat');expect(reconciled).toBe(1);expect(guardian.canRun('personal')).toBe(true);
    const beatDown=new NetworkGuardian(targets,{diagnose:async()=>true,probe:async target=>({kind:target.id==='beat'?'network':'healthy',detail:'probe'}),reconnect:async()=>{},rollback:async()=>{}});
    await beatDown.check();expect(beatDown.canRun('personal')).toBe(false);
  });
});
describe('ordered path inspection and dual VPN admission',()=>{
  const local=(patch:Partial<PathObservation>={}):PathObservation=>({nic:true,dnsServers:['10.1.2.3'],dnsAnswers:['203.0.113.5'],route:'interface: en0',proxy:'none',tls:'ok',peer:'healthy',...patch});
  it('stops at the first failed stage and does not treat auth, limits or MFA as route failures',()=>{
    const corporate:NetworkTarget={id:'intranet',url:'https://git.example.org',domain:'company',corporate:true,requiredDns:['10.1.2.3'],requiredRoute:'interface: en0'};
    expect(inspectPath(corporate,local({nic:false})).stage).toBe('nic');
    expect(inspectPath(corporate,local({dnsServers:[]})).stage).toBe('dns');
    expect(inspectPath(corporate,local({dnsAnswers:[]})).stage).toBe('dns');
    expect(inspectPath(corporate,local({route:'interface: other'})).stage).toBe('route');
    expect(inspectPath(corporate,local({proxy:'failed'})).stage).toBe('proxy');
    expect(inspectPath(corporate,local({tls:'failed'})).stage).toBe('tls');
    expect(inspectPath(corporate,local({peer:'auth'}))).toMatchObject({stage:'peer',kind:'auth'});
    expect(inspectPath(corporate,local({peer:'rate_limit'})).kind).toBe('rate_limit');
    expect(inspectPath(corporate,local({peer:'mfa'})).kind).toBe('mfa');
    expect(inspectPath(corporate,local()).ok).toBe(true);
    expect(inspectPath({id:'public',url:'https://example.test',domain:'personal'},local({dnsAnswers:[]})).stage).toBe('dns');
  });
  it('keeps dual VPN closed unless split tunnel, both start orders, concurrency and single-path repair all pass',async()=>{
    expect(admitDualVpn().admitted).toBe(false);
    expect(admitDualVpn({splitTunnel:true,startOrders:['personal-first'],concurrent:true,singlePathRepair:true}).admitted).toBe(false);
    const evidence={splitTunnel:true,startOrders:['personal-first','enterprise-first'],concurrent:true,singlePathRepair:true};
    expect(admitDualVpn(evidence).admitted).toBe(true);
    const targets:NetworkTarget[]=[{id:'personal',url:'https://example.test',domain:'personal',adapter:{kind:'shortcuts',status:'s',connect:'c',disconnect:'d'}},{id:'enterprise',url:'https://git.example.org',domain:'personal',adapter:{kind:'shortcuts',status:'s2',connect:'c2',disconnect:'d2'}}];
    const actions={diagnose:async()=>true,probe:async()=>({kind:'healthy' as const,detail:'ok'}),reconnect:async()=>{},rollback:async()=>{}};
    const closed=new NetworkGuardian(targets,actions);
    const opened=new NetworkGuardian(targets,actions,undefined,{dualVpn:evidence});
    await closed.check();await opened.check();
    expect(closed.canRun('personal')).toBe(false);expect(opened.canRun('personal')).toBe(true);
  });
  it('checks the heartbeat once a minute from the service entry',()=>{
    expect(heartbeatIntervalMs).toBe(60_000);
    expect(readFileSync(new URL('../../src/index.ts',import.meta.url),'utf8')).toContain('heartbeatIntervalMs');
  });
});
