import { describe, expect, it } from 'vitest';
import { parsePolicy, validateEntry, parseAuthority, renderNft } from '../../scripts/lima/policy.mjs';
import { assertReadiness } from '../../scripts/lima/worker-enter.mjs';
import { validateResolved } from '../../scripts/lima/address-policy.mjs';
import { readFileSync } from 'node:fs';

const raw = () => ({version:1, proxyUser:'patrick-proxy', workers:[
  {runner:'grok',user:'patrick-grok',projectId:'patrick',domain:'personal',proxyPort:18743,hosts:['cli-chat-proxy.grok.com','auth.x.ai']},
  {runner:'codex',user:'patrick-codex',projectId:'patrick',domain:'personal',proxyPort:18744,hosts:[]},
  {runner:'dsh',user:'patrick-dsh',projectId:'patrick',domain:'personal',proxyPort:18745,hosts:[]},
], deniedCidrs:['192.168.0.0/16','10.0.0.0/8']});

describe('closed listener compatibility', () => {
  it('accepts empty Codex/dsh host lists while retaining immutable exact entry scope', () => {
    const input=raw(),policy=parsePolicy(input);
    expect(policy.workers[1]!.hosts).toEqual([]);
    expect(policy.workers[2]!.hosts).toEqual([]);
    expect(Object.isFrozen(policy.workers[1]!.hosts)).toBe(true);
    input.workers[0]!.hosts.push('untrusted.example');
    expect(policy.workers[0]!.hosts).not.toContain('untrusted.example');
    const context={runner:'codex',user:'patrick-codex',projectId:'patrick',domain:'personal'};
    expect(validateEntry(context,['/usr/bin/true'],policy,{uid:1102,gid:1102,home:'/var/lib/patrick-codex',groups:[]}).proxyPort).toBe(18744);
    expect(()=>validateEntry({...context,projectId:'other'},['/usr/bin/true'],policy,{uid:1102,gid:1102,home:'/var/lib/patrick-codex',groups:[]})).toThrow();
  });
});

describe('exact CONNECT authority',()=>{
  const allowed=new Set(['cli-chat-proxy.grok.com','auth.x.ai']);
  it('returns only an exact permitted hostname',()=>{
    expect(parseAuthority('auth.x.ai:443',allowed)).toBe('auth.x.ai');
    expect(()=>parseAuthority('auth.x.ai:443',new Set())).toThrow('AUTHORITY');
  });
  it.each(['AUTH.X.AI:443','auth.x.ai.:443','auth.x.ai.evil.example:443','evil-auth.x.ai:443','auth.x.ai:0443','auth.x.ai:80','https://auth.x.ai:443','u@auth.x.ai:443','auth%2ex.ai:443','auth.x.ai:443/path','auth.x.ai:443\r\n','127.0.0.1:443','2130706433:443','0x7f000001:443','0177.0.0.1:443','[::1]:443','[::ffff:8.8.8.8]:443','auth.x.ai :443'])('rejects %j without echoing input',value=>{
    expect(()=>parseAuthority(value,allowed)).toThrow(/^AUTHORITY$/);
  });
  it('rejects legacy numeric IPv4 forms even if a malformed allowlist contains them',()=>{
    for(const host of ['0x7f.0.0.1','0177.0.0.1','127.1','0x8.010.8.8'])expect(()=>parseAuthority(host+':443',new Set([host]))).toThrow(/^AUTHORITY$/);
  });
});

describe('dedicated numeric nft rules',()=>{
  const ids={'patrick-proxy':1100,'patrick-grok':1101,'patrick-codex':1102,'patrick-dsh':1103};
  // Translate only the complete narrow renderer grammar into the actual Unit1
  // canonical Linux JSON contract. Unknown/extra rules cannot disappear here.
  function nftJson(source:string) {
    const base={family:'inet',table:'patrick_worker'},items:any[]=[{metainfo:{version:'1.0.9',release_name:'Old Doc Yak #3',json_schema_version:1}}];
    const lines=source.trimEnd().split('\n');
    expect(lines.shift()).toBe('table inet patrick_worker {');expect(lines.pop()).toBe('}');
    items.push({table:{family:'inet',name:'patrick_worker'}});
    let chain='';
    const match=(left:unknown,right:unknown)=>({match:{op:'==',left,right}});
    for(const line of lines) {
      let m;
      if((m=/^  chain (output|grok_out|codex_out|dsh_out) \{$/.exec(line))){chain=m[1]!;items.push({chain:{...base,name:chain,...(chain==='output'?{type:'filter',hook:'output',prio:-50,policy:'accept'}:{})}});}
      else if(line==='    type filter hook output priority -50; policy accept;'){expect(chain).toBe('output');}
      else if(line==='  }') chain='';
      else if((m=/^    meta skuid (\d+) jump (grok_out|codex_out|dsh_out)$/.exec(line))){expect(chain).toBe('output');items.push({rule:{...base,chain,expr:[match({meta:{key:'skuid'}},Number(m[1])),{jump:{target:m[2]}}]}});}
      else if((m=/^    oifname "lo" ip daddr 127\.0\.0\.1 tcp dport (\d+) accept$/.exec(line))){expect(chain).not.toBe('output');items.push({rule:{...base,chain,expr:[match({meta:{key:'oifname'}},'lo'),match({payload:{protocol:'ip',field:'daddr'}},'127.0.0.1'),match({payload:{protocol:'tcp',field:'dport'}},Number(m[1])),{accept:null}]}});}
      else if(line==='    reject with icmpx type admin-prohibited')items.push({rule:{...base,chain,expr:[{reject:{type:'icmpx',expr:'admin-prohibited'}}]}});
      else throw new Error('Unexpected nft grammar');
    }
    return {nftables:items};
  }
  it('matches the real helper canonical rule contract, including reject ordering and closed listeners',()=>{
    const policy=parsePolicy(raw()),text=renderNft(policy,ids),nft=nftJson(text);
    const accounts=Object.fromEntries(Object.entries(ids).map(([user,uid])=>[user,{uid,gid:uid,home:'/var/lib/'+user,groups:[]}]));
    const proxy={user:'patrick-proxy',uid:1100,gid:1100,groups:[],mainPid:4321,activeState:'active',subState:'running',listeners:policy.workers.map(w=>({address:'127.0.0.1',port:w.proxyPort,uid:1100,pid:4321}))};
    expect(()=>assertReadiness(nft,proxy,policy,accounts)).not.toThrow();
    const changed=raw();changed.workers[0]!.hosts=['other.example'];
    expect(renderNft(parsePolicy(changed),ids)).toBe(text);
    expect(text).not.toMatch(/flush|established|counter|udp|ip6|0\.0\.0\.0|skuid 0/);
    const rules=nft.nftables.filter(i=>i.rule?.chain==='codex_out');rules.reverse();
    const broken={nftables:[...nft.nftables.filter(i=>i.rule?.chain!=='codex_out'),...rules]};
    expect(()=>assertReadiness(broken,proxy,policy,accounts)).toThrow();
  });
  it('requires the complete exact distinct numeric UID map',()=>{
    for(const bad of [{...ids,admin:1200},{...ids,'--uid':1200},{...ids,'patrick-grok':1100},{...ids,'patrick-grok':999},{...ids,'patrick-grok':'1101'},{...ids,'patrick-grok':NaN},Object.fromEntries(Object.entries(ids).slice(1)),Object.assign(Object.create(ids),{})])expect(()=>renderNft(parsePolicy(raw()),bad as never)).toThrow();
    expect(()=>renderNft(parsePolicy(raw()),{...ids,[Symbol('extra')]:1234})).toThrow();
  });
  it('snapshots numeric account values once before any rendering',()=>{
    let reads=0;const changing={...ids};Object.defineProperty(changing,'patrick-grok',{enumerable:true,get:()=>++reads===1?1101:'raw-injection-marker'});
    expect(renderNft(parsePolicy(raw()),changing)).toBe(renderNft(parsePolicy(raw()),ids));expect(reads).toBe(1);
  });
  it('keeps the privileged module self-contained and the template conservative',()=>{
    const source=readFileSync(new URL('../../scripts/lima/policy.mjs',import.meta.url),'utf8');
    expect(source).not.toMatch(/(?:from\s*|import\s*\()['"]\./);
    const template=parsePolicy(JSON.parse(readFileSync(new URL('../../scripts/lima/worker-policy.json',import.meta.url),'utf8')));
    expect(template.workers.map(w=>[w.runner,w.user,w.projectId,w.domain,w.proxyPort,w.hosts])).toEqual(raw().workers.map(w=>[w.runner,w.user,w.projectId,w.domain,w.proxyPort,w.hosts]));
    expect(template.deniedCidrs.length).toBeGreaterThan(0);
  });
});

describe('numeric all-answer public address classification',()=>{
  const v4=['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.0.0.0/24','192.0.2.0/24','192.31.196.0/24','192.52.193.0/24','192.88.99.0/24','192.168.0.0/16','192.175.48.0/24','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/4','240.0.0.0/4'];
  const v6=['::','::1','::ffff:8.8.8.8','64:ff9b::808:808','64:ff9b:1::1','100::1','100:0:0:1::1','2001::1','2001:1::1','2001:db8::1','2002:808:808::1','2620:4f:8000::1','3fff::1','5f00::1','fc00::1','fe80::1','ff02::1','fec0::1','::8.8.8.8','3ffe:831f::1','2001:1000::1','2001:4e00::1','2610:200::1','3000::1'];
  it('accepts ordinary allocated numeric candidates and normalizes IPv6',()=>{
    expect(validateResolved(['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2410::1'],[])).toEqual(['8.8.8.8','1.1.1.1','2606:4700:4700:0:0:0:0:1111','2410:0:0:0:0:0:0:1']);
    expect(validateResolved(['100.128.0.1'],[])).toEqual(['100.128.0.1']);
  });
  it.each(['2001:200','2001:400','2001:600','2001:800','2001:c00','2001:e00','2001:1200','2001:1400','2001:1800','2001:1a00','2001:1c00','2001:2000','2001:4000','2001:4200','2001:4400','2001:4600','2001:4800','2001:4a00','2001:4c00','2001:5000','2001:8000','2001:a000','2001:b000','2003','2400','2410','2600','2610','2620','2630','2800','2a00','2a10','2c00'])('retains allocated envelope %s with special-purpose denials still applied',prefix=>{
    expect(validateResolved([prefix+'::1'],[])).toHaveLength(1);
  });
  it.each([...v4.map(c=>c.split('/')[0]!),...v6])('rejects the whole answer set containing %s',ip=>{
    expect(()=>validateResolved(['8.8.8.8',ip],[])).toThrow(/^ADDRESS$/);
  });
  it('applies supplied public host routes using full CIDR arithmetic',()=>{
    expect(()=>validateResolved(['8.8.8.8'],['8.8.8.8/32'])).toThrow('ADDRESS');
    expect(()=>validateResolved(['2606:4700:4700::1111'],['2606:4700:4700::/48'])).toThrow('ADDRESS');
    expect(validateResolved(['8.8.8.9'],['8.8.8.8/32'])).toEqual(['8.8.8.9']);
    expect(()=>validateResolved(['8.8.8.8'],['0.0.0.0/0'])).toThrow();
  });
  it('rejects malformed numeric input, CIDRs and oversize lists without echoing values',()=>{
    for(const ip of ['unique-secret.invalid','8.8.8.08','2130706433','0x8080808','2606:4700::1%en0',' 8.8.8.8','8.8.8.8/32',''])expect(()=>validateResolved([ip],[])).toThrow(/^ADDRESS$/);
    for(const cidr of ['8.8.8.8','8.8.8.8/33','::/129','bad/24','8.8.8.8/-1','8.8.8.8/01'])expect(()=>validateResolved(['8.8.8.8'],[cidr])).toThrow(/^ADDRESS$/);
    expect(()=>validateResolved([],[])).toThrow();expect(()=>validateResolved(Array(65).fill('8.8.8.8'),[])).toThrow();
    expect(()=>validateResolved(new Array(1),[])).toThrow(/^ADDRESS$/);
    expect(()=>validateResolved(['8.8.8.8'],new Array(1))).toThrow(/^ADDRESS$/);
  });
});
