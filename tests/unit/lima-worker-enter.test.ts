import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// Root helper dependencies model Linux control-plane facts; no sudo, setpriv, VM or provider runs.
import { parsePolicy, validateEntry, validateAccounts } from '../../scripts/lima/policy.mjs';
import { parseArguments, buildInvocation, assertReadiness, assertTrustedPath, trustExecutable, readTrustedFile, parseAccounts, parseServiceProperties, parseProxyFacts, loadTrustedPolicy, enterWorker } from '../../scripts/lima/worker-enter.mjs';

const scope={runner:'grok',user:'patrick-grok',projectId:'fixture-project',domain:'私人领域'};
const account={uid:1101,gid:1101,home:'/var/lib/patrick-grok',groups:[]};
const rawPolicy={version:1,proxyUser:'patrick-proxy',workers:[{...scope,proxyPort:18081,hosts:['api.example.com']}],deniedCidrs:['127.0.0.0/8','::1/128']};
const legacyArgv=['--runner',scope.runner,'--user',scope.user,'--project',scope.projectId,'--domain',scope.domain,'--','node','-e','$(touch /tmp/forbidden); echo literal'];
const argv=[...legacyArgv.slice(0,8),'--invocation','a'.repeat(32),'--stage','cli','--operation','exec',...legacyArgv.slice(8)];
const accounts={'patrick-grok':account,'patrick-proxy':{uid:1100,gid:1100,home:'/var/lib/patrick-proxy',groups:[]},admin:{uid:1000,gid:1000,home:'/home/admin',groups:[27]}};
const match=(left:unknown,right:unknown)=>({match:{op:'==',left,right}});
function nft() {return {nftables:[{metainfo:{version:'1.0.9',release_name:'Old Doc Yak #3',json_schema_version:1}},{table:{family:'inet',name:'patrick_worker',handle:1}},{chain:{family:'inet',table:'patrick_worker',name:'output',handle:2,type:'filter',hook:'output',prio:-50,policy:'accept'}},{chain:{family:'inet',table:'patrick_worker',name:'grok_out',handle:3}},{rule:{family:'inet',table:'patrick_worker',chain:'output',handle:4,expr:[match({meta:{key:'skuid'}},1101),{jump:{target:'grok_out'}}]}},{rule:{family:'inet',table:'patrick_worker',chain:'grok_out',handle:5,expr:[match({meta:{key:'oifname'}},'lo'),match({payload:{protocol:'ip',field:'daddr'}},'127.0.0.1'),match({payload:{protocol:'tcp',field:'dport'}},18081),{accept:null}]}},{rule:{family:'inet',table:'patrick_worker',chain:'grok_out',handle:6,expr:[{reject:{type:'icmpx',expr:'admin-prohibited'}}]}}]};}
const proxy={user:'patrick-proxy',uid:1100,gid:1100,mainPid:4321,activeState:'active',subState:'running',listeners:[{address:'127.0.0.1',port:18081,uid:1100,pid:4321}],groups:[]};
const stat=(kind='file',uid=0,mode=0o100644)=>({uid,gid:0,mode,isFile:()=>kind==='file',isDirectory:()=>kind==='directory',isSymbolicLink:()=>kind==='symlink'});
const trustedFs={lstatSync:vi.fn((path:string)=>stat(path==='/etc/patrick-worker/policy.json'?'file':'directory',0,path==='/etc/patrick-worker/policy.json'?0o100644:0o40755))};

// Real file/link resolution in an owned temporary namespace. Only Linux UID facts
// are supplied: creating/chowning root or worker host files is unnecessary.
function executableFixture() {
  const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'patrick-executable-')));
  const owners=new Map<string,number>(),physical=(path:string)=>root+(path==='/'?'':path);
  const logical=(path:string)=>path===root?'/':path.startsWith(root+'/')?path.slice(root.length):path;
  function readlinkSync(path:string,options:{encoding:'buffer'}):Buffer;
  function readlinkSync(path:string):string;
  function readlinkSync(path:string,options?:{encoding:'buffer'}):Buffer|string {
    const raw=fs.readlinkSync(physical(path),{encoding:'buffer'}),prefix=Buffer.from(root+'/');
    const target=raw.subarray(0,prefix.length).equals(prefix)?Buffer.concat([Buffer.from('/'),raw.subarray(prefix.length)]):raw;
    return options?.encoding==='buffer'?target:target.toString('utf8');
  }
  const io={
    lstatSync:(path:string)=>{const value=fs.lstatSync(physical(path));return {uid:owners.get(path)??0,gid:0,mode:value.mode,isFile:()=>value.isFile(),isDirectory:()=>value.isDirectory(),isSymbolicLink:()=>value.isSymbolicLink()};},
    readlinkSync,
    realpathSync:(path:string)=>logical(fs.realpathSync(physical(path))),
    statSync:(path:string)=>fs.statSync(physical(path)),
  };
  return {io,
    directory:(path:string,uid=0,mode=0o755)=>{fs.mkdirSync(physical(path),{recursive:true,mode});fs.chmodSync(physical(path),mode);owners.set(path,uid);},
    file:(path:string,mode=0o755)=>{fs.mkdirSync(dirname(physical(path)),{recursive:true});fs.writeFileSync(physical(path),'fixture',{mode});fs.chmodSync(physical(path),mode);},
    link:(path:string,target:string|Buffer,uid=0)=>{fs.mkdirSync(dirname(physical(path)),{recursive:true});const bytes=Buffer.isBuffer(target)?target:Buffer.from(target);fs.symlinkSync(bytes[0]===47?Buffer.concat([Buffer.from(root),bytes]):bytes,physical(path));owners.set(path,uid);},
    close:()=>fs.rmSync(root,{recursive:true,force:true}),
  };
}

describe('privileged executable resolution',()=>{
  it('starts no child for an invalid UTF-8 link target even when its decoded U+FFFD decoy is trusted',()=>{
    const fixture=executableFixture(),exec=vi.fn();
    try {
      fixture.file('/opt/\uFFFD/tool');
      const target=Buffer.concat([Buffer.from('/opt/'),Buffer.from([0xff]),Buffer.from('/tool')]);
      fixture.link('/usr/bin/tool',target);
      expect(fixture.io.readlinkSync('/usr/bin/tool',{encoding:'buffer'})).toEqual(target);
      expect(fixture.io.readlinkSync('/usr/bin/tool')).toBe('/opt/\uFFFD/tool');
      expect(()=>fixture.io.statSync('/usr/bin/tool')).toThrow();
      const deps={effectiveUid:()=>0,trust:()=>trustExecutable('/usr/bin/tool',fixture.io),readPolicy:()=>rawPolicy,accounts:()=>accounts,readiness:()=>({nft:nft(),proxy}),dispatch:exec};
      let error;try {enterWorker(argv,deps);} catch(caught) {error=caught;}
      expect(exec).not.toHaveBeenCalled();
      expect(error).toEqual(new Error('Worker entry denied.'));
    } finally {fixture.close();}
  });
  it('preserves a valid UTF-8 target including its leading BOM and literal U+FFFD',()=>{
    const fixture=executableFixture(),exec=vi.fn();
    try {
      const target='\uFEFF目标-\uFFFD/tool';
      fixture.file(`/usr/bin/${target}`);
      // A BOM-stripping decoder would traverse this worker-owned decoy instead.
      fixture.directory('/usr/bin/目标-\uFFFD',1101);
      fixture.link('/usr/bin/tool',target);
      expect(fixture.io.realpathSync('/usr/bin/tool')).toBe(`/usr/bin/${target}`);
      expect(fixture.io.readlinkSync('/usr/bin/tool',{encoding:'buffer'})).toEqual(Buffer.from(target));
      enterWorker(argv,{effectiveUid:()=>0,trust:()=>trustExecutable('/usr/bin/tool',fixture.io),readPolicy:()=>rawPolicy,accounts:()=>accounts,readiness:()=>({nft:nft(),proxy}),dispatch:exec});
      expect(exec).toHaveBeenCalledTimes(1);
    } finally {fixture.close();}
  });
  it.each(['worker-link','worker-directory','writable-directory'])('starts no child through a root-owned original link with a mutable intermediate %s',kind=>{
    const fixture=executableFixture(),exec=vi.fn();
    try {
      fixture.file('/opt/trusted/tool');
      fixture.directory('/var/lib/patrick-grok',kind==='worker-directory'?1101:0,kind==='writable-directory'?0o777:0o755);
      fixture.link('/var/lib/patrick-grok/hop','/opt/trusted/tool',kind==='worker-link'?1101:0);
      fixture.link('/usr/bin/tool','/var/lib/patrick-grok/hop');
      // Establish the actual attack shape: the original link resolves to a
      // trusted final binary. The real resolver must inspect the hidden hop.
      expect(fixture.io.realpathSync('/usr/bin/tool')).toBe('/opt/trusted/tool');
      const deps={effectiveUid:()=>0,trust:()=>trustExecutable('/usr/bin/tool',fixture.io),readPolicy:()=>rawPolicy,accounts:()=>accounts,readiness:()=>({nft:nft(),proxy}),dispatch:exec};
      let error;try {enterWorker(argv,deps);} catch(caught) {error=caught;}
      expect(exec).not.toHaveBeenCalled();
      expect(error).toEqual(new Error('Worker entry denied.'));
    } finally {fixture.close();}
  });
  it('checks traversed ancestors before resolving parent-directory segments in a link target',()=>{
    const fixture=executableFixture();
    try {
      fixture.file('/opt/trusted/tool');fixture.directory('/var/lib/patrick-grok',1101);
      fixture.link('/usr/bin/tool','/var/lib/patrick-grok/../../../opt/trusted/tool');
      expect(fixture.io.realpathSync('/usr/bin/tool')).toBe('/opt/trusted/tool');
      expect(()=>trustExecutable('/usr/bin/tool',fixture.io)).toThrow();
    } finally {fixture.close();}
  });
  it('bounds a long root-controlled symlink chain',()=>{
    const fixture=executableFixture();
    try {
      fixture.file('/opt/trusted/tool');
      for(let index=0;index<41;index++)fixture.link(`/usr/bin/link${index}`,index===40?'/opt/trusted/tool':`link${index+1}`);
      expect(()=>trustExecutable('/usr/bin/link0',fixture.io)).toThrow();
    } finally {fixture.close();}
  });
  it('accepts root-controlled distribution directory and chained relative binary links',()=>{
    const fixture=executableFixture();
    try {
      fixture.file('/opt/trusted/tool');fixture.directory('/usr/bin');
      fixture.link('/bin','usr/bin');
      fixture.link('/usr/bin/tool','../../opt/trusted/hop');
      fixture.link('/opt/trusted/hop','tool');
      expect(()=>trustExecutable('/bin/tool',fixture.io)).not.toThrow();
    } finally {fixture.close();}
  });
  it('accepts the root-owned /usr/local/bin/node to /opt pinned runtime layout',()=>{
    const fixture=executableFixture();
    try {
      fixture.file('/opt/patrick/node-v24.22.2-linux-arm64/bin/node');
      fixture.link('/usr/local/bin/node','/opt/patrick/node-v24.22.2-linux-arm64/bin/node');
      expect(()=>trustExecutable('/usr/local/bin/node',fixture.io)).not.toThrow();
    } finally {fixture.close();}
  });
  it.each(['cycle','missing','directory','nonexecutable','writable-file','writable-ancestor'])('rejects a %s executable dependency',kind=>{
    const fixture=executableFixture();
    try {
      fixture.file('/opt/trusted/tool',kind==='nonexecutable'?0o644:kind==='writable-file'?0o775:0o755);
      if(kind==='writable-ancestor')fixture.directory('/opt/trusted',0,0o775);
      fixture.link('/usr/bin/tool',kind==='cycle'?'/usr/bin/hop':kind==='missing'?'/opt/missing':kind==='directory'?'/opt/trusted':'/opt/trusted/tool');
      if(kind==='cycle')fixture.link('/usr/bin/hop','tool');
      expect(()=>trustExecutable('/usr/bin/tool',fixture.io)).toThrow();
    } finally {fixture.close();}
  });
});

describe('root-owned Lima policy',()=>{
  it('preserves explicit Unicode scope and validates exact policy shape',()=>{
    expect(parsePolicy(rawPolicy)).toEqual(rawPolicy);
    expect(validateEntry(scope,['node','literal;$(id)'],parsePolicy(rawPolicy),account)).toStrictEqual({...scope,uid:1101,gid:1101,home:account.home,proxyPort:18081,command:['node','literal;$(id)']});
  });
  it.each([
    {...rawPolicy,version:2},{...rawPolicy,proxyUser:'root'},{...rawPolicy,extra:true},{...rawPolicy,workers:[]},{...rawPolicy,deniedCidrs:[]},{...rawPolicy,deniedCidrs:['127.0.0.0/99']},
    ...['root','--root','patrick-x y','patrick-'+ 'x'.repeat(25)].map(user=>({...rawPolicy,workers:[{...rawPolicy.workers[0],user}]})),
    ...['*','*.example.com','https://example.com','127.0.0.1','::1','example.com/path'].map(host=>({...rawPolicy,workers:[{...rawPolicy.workers[0],hosts:[host]}]})),
    ...['runner','user','proxyPort'].map(field=>({...rawPolicy,workers:[rawPolicy.workers[0],{...rawPolicy.workers[0],runner:'codex',user:'patrick-codex',proxyPort:18082,[field]:rawPolicy.workers[0]![field as keyof typeof rawPolicy.workers[0]]}]})),
  ])('rejects undeclared or ambiguous policy %j',raw=>expect(()=>parsePolicy(raw)).toThrow());
  it.each([{...scope,runner:'codex'},{...scope,user:'patrick-other'},{...scope,projectId:'another'},{...scope,domain:'another'}])('rejects a different identity tuple %j',context=>expect(()=>validateEntry(context,['node'],parsePolicy(rawPolicy),account)).toThrow());
  it.each([{...account,uid:0},{...account,gid:0},{...account,uid:999},{...account,home:'/root'},{...account,groups:[27]}])('rejects privileged account facts %j',facts=>expect(()=>validateEntry(scope,['node'],parsePolicy(rawPolicy),facts)).toThrow());
  it('rejects UID/GID aliases, missing mappings and supplementary memberships across all accounts',()=>{
    const policy=parsePolicy(rawPolicy);
    expect(()=>validateAccounts(policy,accounts)).not.toThrow();
    for(const value of [{...accounts,admin:{...accounts.admin,uid:1101}},{...accounts,admin:{...accounts.admin,gid:1101}},{...accounts,'patrick-proxy':{...accounts['patrick-proxy'],uid:1101}},{...accounts,'patrick-grok':undefined}])expect(()=>validateAccounts(policy,value)).toThrow();
  });
});

describe('actual helper entry',()=>{
  it('verifies root and trusted code before loading any local policy module',async()=>{
    const events:string[]=[],load=vi.fn(async()=>{events.push('load');return {module:'fixture'};});
    await expect(loadTrustedPolicy({effectiveUid:()=>0,trust:()=>{events.push('trust');},load})).resolves.toEqual({module:'fixture'});
    expect(events).toEqual(['trust','load']);
    for(const failed of [{effectiveUid:()=>1000,trust:vi.fn(),load},{effectiveUid:()=>0,trust:()=>{throw Error('private path');},load}]){
      load.mockClear();await expect(loadTrustedPolicy(failed)).rejects.toThrow('Worker entry denied.');expect(load).not.toHaveBeenCalled();
    }
  });
  it('parses one fixed tuple and preserves shell syntax only as command argv',()=>{
    expect(parseArguments(argv)).toEqual({context:scope,lifetime:{invocation:'a'.repeat(32),stage:'cli',profile:'authenticated-client',operation:'exec'},command:argv.slice(15)});
  });
  it.each([[],argv.slice(0,8),['--test',...argv],['--runner','grok',...argv],argv.slice(0,9),[...argv.slice(0,8),'--','']].map(args=>({args})))('rejects missing duplicate unknown or empty entry args %j',({args})=>expect(()=>parseArguments(args)).toThrow());
  it('builds a fixed privilege drop and clean environment that argv cannot replace',()=>{
    const entry=validateEntry(scope,['env','HOME=/root','--uid=0','literal;$(id)'],parsePolicy(rawPolicy),account);
    const invocation=buildInvocation(entry);
    expect(invocation.command).toBe('/usr/bin/setpriv');
    expect(invocation.args).toEqual(['--reuid=1101','--regid=1101','--clear-groups','--no-new-privs','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--','/usr/bin/env','-i','HOME=/var/lib/patrick-grok','USER=patrick-grok','LOGNAME=patrick-grok','PATH=/usr/local/bin:/usr/bin:/bin','TMPDIR=/tmp','HTTP_PROXY=http://127.0.0.1:18081','HTTPS_PROXY=http://127.0.0.1:18081','NO_PROXY=','/usr/bin/dash','-c','cd -- "$HOME" && exec "$@"','patrick-worker','env','HOME=/root','--uid=0','literal;$(id)']);
  });
  it('rejects mutable, symlinked, wrong-owner and nonregular policy paths',()=>{
    expect(()=>assertTrustedPath('/etc/patrick-worker/policy.json',{kind:'file',uid:0},trustedFs)).not.toThrow();
    for(const bad of [stat('symlink'),stat('file',1000),stat('file',0,0o100664),stat('directory')])expect(()=>assertTrustedPath('/etc/patrick-worker/policy.json',{kind:'file',uid:0},{lstatSync:(p:string)=>p.endsWith('.json')?bad:stat('directory',0,0o40755)})).toThrow();
    expect(()=>assertTrustedPath('/etc/patrick-worker/policy.json',{kind:'file',uid:0},{lstatSync:(p:string)=>p==='/etc'?stat('directory',0,0o40777):trustedFs.lstatSync(p)})).toThrow();
  });
  it('validates private home ownership including the primary group',()=>{
    const io={lstatSync:(path:string)=>path==='/var/lib/patrick-grok'?stat('directory',1101,0o40700):stat('directory',0,0o40755)};
    expect(()=>assertTrustedPath('/var/lib/patrick-grok',{kind:'directory',uid:1101,gid:1101,private:true},io)).toThrow();
  });
  it('checks the opened no-follow descriptor and always closes a rejected policy file',()=>{
    const closeSync=vi.fn(),openSync=vi.fn((_path:string,_flags:number)=>42);
    const io={...trustedFs,openSync,closeSync,fstatSync:()=>stat('file',1000),readFileSync:vi.fn(()=>'{"untrusted":true}')};
    expect(()=>readTrustedFile('/etc/patrick-worker/policy.json',1024,io)).toThrow();
    expect(openSync.mock.calls[0]?.[1]).toBeDefined();expect(closeSync).toHaveBeenCalledWith(42);expect(io.readFileSync).not.toHaveBeenCalled();
  });
  it('derives account facts from root account files and rejects primary group aliases',()=>{
    const passwd='root:x:0:0:root:/root:/bin/sh\npatrick-grok:x:1101:1101::/var/lib/patrick-grok:/usr/sbin/nologin\n';
    expect(parseAccounts(passwd,'root:x:0:\npatrick-grok:x:1101:\n')['patrick-grok']).toEqual(account);
    expect(parseAccounts(passwd,'root:x:0:\npatrick-grok:x:1101:patrick-grok\n')['patrick-grok']).toEqual(account);
    expect(()=>parseAccounts(passwd,'root:x:0:\npatrick-grok:x:1101:\nadmin:x:1101:\n')).toThrow();
  });
  it('parses root systemd and kernel socket observations without accepting a readiness marker',()=>{
    const serviceText='User=patrick-proxy\nGroup=patrick-proxy\nMainPID=4321\nActiveState=active\nSubState=running\nFragmentPath=/etc/systemd/system/patrick-worker-proxy.service\nDropInPaths=\n';
    const properties=parseServiceProperties(serviceText);
    const status='Name:\tnode\nUid:\t1100\t1100\t1100\t1100\nGid:\t1100\t1100\t1100\t1100\nGroups:\t\n';
    const tcp='  sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n  0: 0100007F:46A1 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1100 0 9876 1\n';
    expect(parseProxyFacts(properties,status,tcp,'header\n',['9876'])).toEqual(proxy);
    for(const text of [serviceText+'User=root\n',serviceText.replace('Group=patrick-proxy','Group=root'),serviceText.replace('DropInPaths=','DropInPaths=/tmp/override.conf'), 'ready=true\n'])expect(()=>parseServiceProperties(text)).toThrow();
    expect(()=>parseProxyFacts(properties,status.replace('1100\t1100\t1100\t1100','1100\t0\t1100\t1100'),tcp,'header\n',['9876'])).toThrow();
    expect(parseProxyFacts(properties,status,tcp,'header\n',[]).listeners).toEqual([]);
  });
  it('requires exact kernel rules and the actual service-owned loopback listener',()=>{
    expect(()=>assertReadiness(nft(),proxy,parsePolicy(rawPolicy),accounts)).not.toThrow();
    expect(()=>assertReadiness(nft(),{...proxy,groups:[1100]},parsePolicy(rawPolicy),accounts)).not.toThrow();
    const permissive=nft();permissive.nftables.push({rule:{family:'inet',table:'patrick_worker',chain:'grok_out',handle:7,expr:[{accept:null}]}} as never);
    const missing=nft();missing.nftables.pop();
    const wrongUid=nft();(wrongUid.nftables[4] as any).rule.expr[0].match.right=1000;
    const wrongPort=nft();(wrongPort.nftables[5] as any).rule.expr[2].match.right=18082;
    for(const value of [{},permissive,missing,wrongUid,wrongPort])expect(()=>assertReadiness(value,proxy,parsePolicy(rawPolicy),accounts)).toThrow();
    const unknownMetadata=nft();unknownMetadata.nftables[0]={metainfo:{ready:true}} as never;
    expect(()=>assertReadiness(unknownMetadata,proxy,parsePolicy(rawPolicy),accounts)).toThrow();
    for(const value of [{...proxy,activeState:'inactive'},{...proxy,user:'root'},{...proxy,uid:0},{...proxy,groups:[27]},{...proxy,groups:[1100,1100]},{...proxy,listeners:[]},{...proxy,listeners:[{...proxy.listeners[0],address:'0.0.0.0'}]},{...proxy,listeners:[{...proxy.listeners[0],port:18082}]},{...proxy,listeners:[{...proxy.listeners[0],pid:1}]}])expect(()=>assertReadiness(nft(),value,parsePolicy(rawPolicy),accounts)).toThrow();
  });

  it('matches canonical installed Linux nft JSON while rejecting unknown expressions',()=>{
    // Captured by the parent in a disposable network namespace, without guest rules changes.
    const kernel={"nftables":[{"metainfo":{"version":"1.0.9","release_name":"Old Doc Yak #3","json_schema_version":1}},{"table":{"family":"inet","name":"patrick_worker","handle":2}},{"chain":{"family":"inet","table":"patrick_worker","name":"output","handle":1,"type":"filter","hook":"output","prio":-50,"policy":"accept"}},{"chain":{"family":"inet","table":"patrick_worker","name":"grok_out","handle":2}},{"chain":{"family":"inet","table":"patrick_worker","name":"codex_out","handle":3}},{"chain":{"family":"inet","table":"patrick_worker","name":"dsh_out","handle":4}},{"rule":{"family":"inet","table":"patrick_worker","chain":"output","handle":5,"expr":[{"match":{"op":"==","left":{"meta":{"key":"skuid"}},"right":1001}},{"jump":{"target":"grok_out"}}]}},{"rule":{"family":"inet","table":"patrick_worker","chain":"output","handle":6,"expr":[{"match":{"op":"==","left":{"meta":{"key":"skuid"}},"right":1002}},{"jump":{"target":"codex_out"}}]}},{"rule":{"family":"inet","table":"patrick_worker","chain":"output","handle":7,"expr":[{"match":{"op":"==","left":{"meta":{"key":"skuid"}},"right":1003}},{"jump":{"target":"dsh_out"}}]}},{"rule":{"family":"inet","table":"patrick_worker","chain":"grok_out","handle":8,"expr":[{"match":{"op":"==","left":{"meta":{"key":"oifname"}},"right":"lo"}},{"match":{"op":"==","left":{"payload":{"protocol":"ip","field":"daddr"}},"right":"127.0.0.1"}},{"match":{"op":"==","left":{"payload":{"protocol":"tcp","field":"dport"}},"right":18743}},{"accept":null}]}},{"rule":{"family":"inet","table":"patrick_worker","chain":"grok_out","handle":9,"expr":[{"reject":{"type":"icmpx","expr":"admin-prohibited"}}]}},{"rule":{"family":"inet","table":"patrick_worker","chain":"codex_out","handle":10,"expr":[{"match":{"op":"==","left":{"meta":{"key":"oifname"}},"right":"lo"}},{"match":{"op":"==","left":{"payload":{"protocol":"ip","field":"daddr"}},"right":"127.0.0.1"}},{"match":{"op":"==","left":{"payload":{"protocol":"tcp","field":"dport"}},"right":18744}},{"accept":null}]}},{"rule":{"family":"inet","table":"patrick_worker","chain":"codex_out","handle":11,"expr":[{"reject":{"type":"icmpx","expr":"admin-prohibited"}}]}},{"rule":{"family":"inet","table":"patrick_worker","chain":"dsh_out","handle":12,"expr":[{"match":{"op":"==","left":{"meta":{"key":"oifname"}},"right":"lo"}},{"match":{"op":"==","left":{"payload":{"protocol":"ip","field":"daddr"}},"right":"127.0.0.1"}},{"match":{"op":"==","left":{"payload":{"protocol":"tcp","field":"dport"}},"right":18745}},{"accept":null}]}},{"rule":{"family":"inet","table":"patrick_worker","chain":"dsh_out","handle":13,"expr":[{"reject":{"type":"icmpx","expr":"admin-prohibited"}}]}}]};
    const policy=parsePolicy({...rawPolicy,workers:['grok','codex','dsh'].map((runner,index)=>({...scope,runner,user:'patrick-'+runner,proxyPort:18743+index,hosts:['api.example.com']}))});
    const mapped={admin:accounts.admin,'patrick-proxy':accounts['patrick-proxy'],...Object.fromEntries(policy.workers.map((worker,index)=>[worker.user,{uid:1001+index,gid:1001+index,home:'/var/lib/'+worker.user,groups:[]}]))};
    const service={...proxy,listeners:policy.workers.map(worker=>({address:'127.0.0.1',port:worker.proxyPort,uid:1100,pid:4321}))};
    expect(()=>assertReadiness(kernel,service,policy,mapped)).not.toThrow();
    (kernel.nftables[9] as any).rule.expr.unshift({counter:{packets:0,bytes:0}});
    expect(()=>assertReadiness(kernel,service,policy,mapped)).toThrow();
  });
  it('starts no child until every real dependency check has passed, and sanitizes rejection',()=>{
    const deps={effectiveUid:()=>0,trust:vi.fn(),readPolicy:()=>rawPolicy,accounts:()=>accounts,readiness:()=>({nft:nft(),proxy}),dispatch:vi.fn()};
    enterWorker(argv,deps);expect(deps.dispatch).toHaveBeenCalledOnce();
    for(const failed of [{...deps,effectiveUid:()=>1000},{...deps,trust:()=>{throw Error('private raw path');}},{...deps,readPolicy:()=>({...rawPolicy,proxyUser:'root'})},{...deps,readiness:()=>({nft:{},proxy})}]) {
      deps.dispatch.mockClear();expect(()=>enterWorker(argv,failed)).toThrow('Worker entry denied.');expect(deps.dispatch).not.toHaveBeenCalled();
    }
  });
});


describe('contained lifetime grammar',()=>{
  it('rejects the retired uncontained entry grammar',()=>{
    expect(()=>parseArguments(legacyArgv)).toThrow('Worker entry denied.');
  });
  it('accepts command-free stop with finite metadata and rejects target selectors',()=>{
    const prefix=argv.slice(0,8),suffix=['--invocation','a'.repeat(32),'--stage','cli','--operation','stop'];
    expect(parseArguments([...prefix,...suffix,'--'])).toMatchObject({context:scope,command:[],lifetime:{invocation:'a'.repeat(32),stage:'cli',profile:'authenticated-client',operation:'stop'}});
    for(const extra of [['--unit','foreign.service'],['--profile','authenticated-client'],['--pid','123'],['--deadline','5']])expect(()=>parseArguments([...prefix,...suffix,...extra,'--'])).toThrow();
    expect(()=>parseArguments([...prefix,...suffix,'--','node'])).toThrow();
  });
});
