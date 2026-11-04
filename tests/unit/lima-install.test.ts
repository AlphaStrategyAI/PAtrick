import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { addCompletedQualificationNetworkOperation, corruptQualificationSession, malformedQualificationSessionCases } from '../fixtures/lima-qualification-session-cases.js';
const spawned=vi.hoisted(()=>vi.fn());
vi.mock('node:child_process',()=>({spawnSync:spawned}));

// Import by URL so these administrative JavaScript entry points need no unused
// application declarations. No test invokes a host command or requires root.
const installerUrl=new URL('../../scripts/lima/install-guest.mjs',import.meta.url).href;
const probeUrl=new URL('../../scripts/lima/probe-guest.mjs',import.meta.url).href;
const install=await import(installerUrl);
const probe=await import(probeUrl);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const policy={version:1,proxyUser:'patrick-proxy',workers:['grok','codex','dsh'].map((runner,index)=>({runner,user:`patrick-${runner}`,projectId:'fixture',domain:'personal',proxyPort:18743+index,hosts:[]})),deniedCidrs:['10.0.0.0/8','::/0']};
const guest={addresses:[{family:4,address:'192.0.2.10/32'}],routes:[{family:4,destination:'0.0.0.0/0',gateway:'192.0.2.1'}],resolvers:['192.0.2.53'],hostAliases:['192.0.2.2']};
function inventory() {
  const data={version:1,collectedAt:'2026-11-04T00:00:00.000Z',sources:['guest-addresses','guest-routes','guest-resolvers','guest-host-aliases','lima-host-gateway','mac-addresses','lan-vpn-routes','host-resolvers','translator','guest-admin-sockets'].map(kind=>({kind,version:1})),sourceVersion:1,translator:'unknown',translatorPrefixes:[],extraPrivilegedSocketPaths:[],guest,host:{addresses:[],routes:[],resolvers:[]},lima:{hostAddresses:['192.0.2.2'],gatewayAddresses:['192.0.2.1']},exclusions:[
    {family:4,cidr:'192.0.2.10/32',categories:['guest']}, {family:4,cidr:'192.0.2.1/32',categories:['gateway']}, {family:4,cidr:'192.0.2.53/32',categories:['resolver']}, {family:4,cidr:'192.0.2.2/32',categories:['host']},
  ],routes:[{family:4,cidr:'0.0.0.0/0',classification:'internet'},{family:4,cidr:'0.0.0.0/1',classification:'internet'},{family:4,cidr:'128.0.0.0/1',classification:'internet'}]};
  return {...data,fingerprint:hash(JSON.stringify(data))};
}
function accounts() {return Object.fromEntries(['patrick-proxy','patrick-grok','patrick-codex','patrick-dsh'].map((name,index)=>[name,{uid:1100+index,gid:1100+index,home:`/var/lib/${name}`,groups:[],shell:'/usr/sbin/nologin',locked:true,primaryGroup:name}]));}

describe('fixed installer and probe arguments',()=>{
  it('clears loader, Node, startup, HOME, PATH and cwd contamination before fixed administrative children',()=>{
    const names=['LD_PRELOAD','LD_LIBRARY_PATH','NODE_OPTIONS','NODE_PATH','ENV','BASH_ENV','HOME','PATH','PWD','OLDPWD'];
    try{for(const name of names)vi.stubEnv(name,'fixture-contamination');spawned.mockReturnValue({status:0,stdout:'fixture'});install.productionDependencies().run('/usr/bin/systemctl',['--version']);expect(spawned).toHaveBeenLastCalledWith('/usr/bin/systemctl',['--version'],expect.objectContaining({cwd:'/',env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C'}}));const sudo=fs.readFileSync(new URL('../../examples/lima/patrick-worker-sudoers',import.meta.url),'utf8');for(const token of ['env_reset','!setenv','NOSETENV','LD_*','NODE_*','ENV','BASH_ENV','HOME','PATH','PWD'])expect(sudo).toContain(token);const bootstrap=fs.readFileSync(new URL('../../examples/lima/patrick-worker-probe',import.meta.url),'utf8');expect(bootstrap.startsWith('#!/usr/bin/dash\nexec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C')).toBe(true);expect(bootstrap).toContain('/usr/local/bin/node --no-addons');expect(bootstrap).not.toContain('/usr/bin/env node');}finally{vi.unstubAllEnvs();}
  });
  it('requires exactly 16 artifacts and eight literal control-admin grants',()=>{
    expect(install.ARTIFACTS).toHaveLength(16);expect(install.ARTIFACTS).toContain('installed-network.mjs');expect(install.ARTIFACTS).not.toContain('installed-network.d.mts');
    const sudo=fs.readFileSync(new URL('../../examples/lima/patrick-worker-sudoers',import.meta.url),'utf8');expect(sudo.split('@CONTROL_ADMIN@')).toHaveLength(9);const grants=sudo.split('\n').filter(line=>line.startsWith('@CONTROL_ADMIN@ '));expect(grants).toHaveLength(8);expect(grants.filter(line=>line.endsWith('--operation qualification-network'))).toHaveLength(1);expect(grants.every(line=>!line.includes('*'))).toBe(true);
  });
  it('accepts only absolute policy/artifact paths and one mode',()=>{
    expect(install.parseInstallArguments(['--policy','/stage/policy.json','--artifacts','/stage','--check'])).toEqual({policyPath:'/stage/policy.json',artifactDir:'/stage',apply:false});
  });
  it.each([[],['--policy','relative','--artifacts','/stage','--check'],['--policy','/a/../policy','--artifacts','/stage','--check'],['--policy','/p','--policy','/p','--artifacts','/stage','--check'],['--policy','/p','--artifacts','/stage','--check','--apply'],['--policy','/p','--artifacts','/stage','--unknown'],['--policy','/p','--artifacts','/stage']].map(args=>({args})))('rejects ambiguous installer argv %j',({args})=>expect(()=>install.parseInstallArguments(args)).toThrow('arguments'));
  it('accepts seven finite probe operations without command/path overrides',()=>{
    for(const operation of ['snapshot','firewall-load','synthetic-network','qualification','qualification-start','qualification-finish','qualification-network'])expect(probe.parseProbeArguments(['--operation',operation])).toBe(operation);
    for(const args of [[],['--operation','stop'],['--operation','snapshot','--path','/tmp/a'],['--operation','snapshot','--operation','snapshot']])expect(()=>probe.parseProbeArguments(args)).toThrow('arguments');
  });
});

describe('account and route inventory preconditions',()=>{
  it('validates locked, private, alias-free account identities and explicitly plans missing allocation',()=>{
    const facts={admin:{uid:1000,gid:1000,home:'/home/admin',groups:[27],shell:'/bin/bash',locked:false,primaryGroup:'admin'},...accounts()};
    expect(install.planAccounts(policy,facts,'admin').missing).toEqual([]);
    delete (facts as Record<string,unknown>)['patrick-dsh'];
    expect(install.planAccounts(policy,facts,'admin').missing).toEqual(['patrick-dsh']);
  });
  it.each(['uid','gid','home','groups','shell','locked','primaryGroup','alias','admin'])('rejects an existing conflicting %s without repurposing',field=>{
    const facts:any={admin:{uid:1000,gid:1000,home:'/home/admin',groups:[],shell:'/bin/bash',locked:false,primaryGroup:'admin'},...accounts()};
    const changes:any={uid:0,gid:999,home:'/root',groups:[27],shell:'/bin/bash',locked:false,primaryGroup:'other'};
    if(field==='alias')facts.alias={...facts['patrick-grok']};
    else if(field==='admin')facts.admin={...facts['patrick-grok']};
    else facts['patrick-grok'][field]=changes[field];
    expect(()=>install.planAccounts(policy,facts,'admin')).toThrow('account_conflict');
  });
  it('keeps default/split routes as context and explicitly denies unknown IPv6 translators',()=>{
    const result=install.validateInventory(inventory(),policy,guest,Date.parse('2026-11-04T00:01:00Z'));
    expect(result.ipv6UpstreamDisabled).toBe(true);
    expect(result.deniedCidrs).toContain('::/0');
    expect(result.deniedCidrs).not.toContain('0.0.0.0/0');
    expect(result.deniedCidrs).toContain('192.0.2.1/32');
  });
  it.each(['missing-source','fingerprint','guest-drift','unknown-route','noncanonical','missing-gateway','missing-resolver','stale','future','overflow'])('fails closed for %s inventory',kind=>{
    const value:any=inventory();let live=guest;
    if(kind==='missing-source')value.sources.pop();
    if(kind==='fingerprint')value.fingerprint='0'.repeat(64);
    if(kind==='guest-drift')live={...guest,resolvers:['192.0.2.54']};
    if(kind==='unknown-route')value.routes[0].classification='unknown';
    if(kind==='noncanonical')value.exclusions[0].cidr='192.0.2.11/24';
    if(kind==='missing-gateway')value.exclusions=value.exclusions.filter((entry:any)=>!entry.categories.includes('gateway'));
    if(kind==='missing-resolver')value.exclusions=value.exclusions.filter((entry:any)=>!entry.categories.includes('resolver'));
    if(kind==='stale')value.collectedAt='2020-01-01T00:00:00.000Z';
    if(kind==='future')value.collectedAt='2030-01-01T00:00:00.000Z';
    if(kind==='overflow')value.exclusions=Array.from({length:129},(_,index)=>({family:4,cidr:`198.51.100.${index}/32`,categories:['host']}));
    if(kind!=='fingerprint'){const {fingerprint:_,...data}=value;value.fingerprint=hash(JSON.stringify(data));}
    expect(()=>install.validateInventory(value,policy,live,Date.parse('2026-11-04T00:01:00Z'))).toThrow('inventory_incomplete');
  });
  it('requires actual public host and host-resolver exclusions rather than category labels alone',()=>{
    const value:any=inventory();value.host.addresses=['8.8.4.4'];value.host.resolvers=['8.8.8.8'];const {fingerprint:_,...data}=value;value.fingerprint=hash(JSON.stringify(data));expect(()=>install.validateInventory(value,policy,guest,Date.parse('2026-11-04T00:01:00Z'))).toThrow('inventory_incomplete');
  });
  it('deduplicates one CIDR shared by the Lima host and gateway classifications',()=>{
    const value:any=inventory();value.lima.hostAddresses=['192.0.2.1'];const gateway=value.exclusions.find((entry:any)=>entry.cidr==='192.0.2.1/32');delete gateway.category;gateway.categories=['gateway','host'];const {fingerprint:_,...data}=value;value.fingerprint=hash(JSON.stringify(data));expect(install.validateInventory(value,policy,guest,Date.parse('2026-11-04T00:01:00Z')).deniedCidrs.filter((cidr:string)=>cidr==='192.0.2.1/32')).toHaveLength(1);
  });
  it.each([{paths:['relative']},{paths:['/run/../tmp/agent']},{paths:['/run/*.sock']},{paths:['/run/agent\n.sock']},{paths:['@privileged-abstract']},{paths:['/run/admin.sock','/run/admin.sock']},{paths:Array.from({length:65},(_,index)=>`/run/admin${index}.sock`)},{paths:undefined}])('rejects unsupported or unbounded privileged socket inventory %j',({paths})=>{
    const value:any=inventory();if(paths===undefined)delete value.extraPrivilegedSocketPaths;else value.extraPrivilegedSocketPaths=paths;const {fingerprint:_,...data}=value;value.fingerprint=hash(JSON.stringify(data));expect(()=>install.validateInventory(value,policy,guest,Date.parse('2026-11-04T00:01:00Z'))).toThrow('inventory_incomplete');
  });
});

// Filesystem fixture is bounded to a temporary directory. Ownership is synthetic
// Linux metadata; no real chown, user creation, nft, sudo or systemd is executed.
function filesystemFixture() {
  const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'patrick-install-')));
  const owners=new Map<string,{uid:number;gid:number}>(),descriptors=new Map<number,{path:string;owner:{uid:number;gid:number}}>();const mutations:string[]=[];
  const physical=(path:string)=>{if(typeof path!=='string'||!path.startsWith('/')||path.split('/').includes('..')||path.includes('\0'))throw Error('outside fixture');return path.includes('//')||path.includes('/./')||path.endsWith('/.')?join(root,path):root+path;};
  const descriptor=(fd:number)=>{const value=descriptors.get(fd);if(!value)throw Error('foreign fd');return value;};
  const io:any={readSync:(fd:number,...args:any[])=>{descriptor(fd);return fs.readSync(fd,...args as [any,any,any,any]);},closeSync:(fd:number)=>{descriptor(fd);fs.closeSync(fd);descriptors.delete(fd);},fsyncSync:(fd:number)=>{descriptor(fd);fs.fsyncSync(fd);},fchmodSync:(fd:number,mode:number)=>{descriptor(fd);fs.fchmodSync(fd,mode);},
    lstatSync:(path:string)=>{const stat=fs.lstatSync(physical(path));return Object.assign(stat,{uid:owners.get(path)?.uid??0,gid:owners.get(path)?.gid??0});},
    readFileSync:(path:string|number,...args:any[])=>{if(typeof path==='number')descriptor(path);return fs.readFileSync(typeof path==='number'?path:physical(path),...args as [any]);},
    openSync:(path:string,flags:number,mode?:number)=>{if(flags&fs.constants.O_CREAT)mutations.push(`open:${path}`);const fd=fs.openSync(physical(path),flags,mode);descriptors.set(fd,{path,owner:owners.get(path)??{uid:0,gid:0}});return fd;},
    fstatSync:(fd:number)=>{const value=descriptor(fd),stat=fs.fstatSync(fd);return Object.assign(stat,value.owner);},
    readdirSync:(path:string)=>fs.readdirSync(physical(path)),opendirSync:(path:string,options:any)=>fs.opendirSync(physical(path),options),readlinkSync:(path:string,options:any)=>{const raw=fs.readlinkSync(physical(path),{encoding:'buffer'});const prefix=Buffer.from(root+'/');const bytes=raw.subarray(0,prefix.length).equals(prefix)?Buffer.concat([Buffer.from('/'),raw.subarray(prefix.length)]):raw;return options?.encoding==='buffer'?bytes:bytes.toString('utf8');},
    realpathSync:(path:string)=>fs.realpathSync(physical(path)).slice(root.length)||'/',
    mkdirSync:(path:string,options:any)=>{mutations.push(`mkdir:${path}`);return fs.mkdirSync(physical(path),options);},
    rmdirSync:(path:string)=>{mutations.push(`rmdir:${path}`);return fs.rmdirSync(physical(path));},
    writeFileSync:(path:string|number,data:any,options:any)=>{mutations.push(`write:${path}`);if(typeof path==='number')descriptor(path);return fs.writeFileSync(typeof path==='number'?path:physical(path),data,options);},
    linkSync:(from:string,to:string)=>{mutations.push(`link:${to}`);fs.linkSync(physical(from),physical(to));const owner=owners.get(from)??{uid:0,gid:0};owners.set(to,{uid:owner.uid,gid:owner.gid});},
    renameSync:(from:string,to:string)=>{mutations.push(`rename:${to}`);fs.renameSync(physical(from),physical(to));owners.set(to,owners.get(from)??{uid:0,gid:0});owners.delete(from);},
    unlinkSync:(path:string)=>{mutations.push(`unlink:${path}`);fs.unlinkSync(physical(path));owners.delete(path);},
    chmodSync:(path:string,mode:number)=>{mutations.push(`chmod:${path}`);return fs.chmodSync(physical(path),mode);},
    chownSync:(path:string,uid:number,gid:number)=>{mutations.push(`chown:${path}`);owners.set(path,{uid,gid});},
  };
  const file=(path:string,data:string,mode=0o644)=>{fs.mkdirSync(dirname(physical(path)),{recursive:true,mode:0o755});fs.writeFileSync(physical(path),data,{mode});fs.chmodSync(physical(path),mode);};
  fs.chmodSync(root,0o755);
  return {io,file,owners,mutations,physical,close:()=>fs.rmSync(root,{recursive:true,force:true})};
}
describe('trusted artifact set',()=>{
  it.each(['invalid-utf8','mutable-hop','parent-hop','nonexecutable','writable-file'])('rejects a %s executable chain in kernel traversal order',kind=>{
    const fixture=filesystemFixture();try{
      fixture.file('/opt/trusted/tool','fixture',kind==='nonexecutable'?0o644:kind==='writable-file'?0o777:0o755);fixture.file('/usr/bin/placeholder','');fs.unlinkSync(fixture.physical('/usr/bin/placeholder'));
      if(kind==='invalid-utf8'){fixture.file('/opt/\uFFFD/tool','fixture',0o755);fs.symlinkSync(Buffer.concat([Buffer.from(fixture.physical('/opt/')),Buffer.from([0xff]),Buffer.from('/tool')]),fixture.physical('/usr/bin/tool'));}
      else if(kind==='mutable-hop'||kind==='parent-hop'){fixture.file('/var/lib/patrick-grok/hop','fixture',0o755);fixture.owners.set('/var/lib/patrick-grok',{uid:1101,gid:1101});fs.unlinkSync(fixture.physical('/var/lib/patrick-grok/hop'));fs.symlinkSync(fixture.physical('/opt/trusted/tool'),fixture.physical('/var/lib/patrick-grok/hop'));fs.symlinkSync(kind==='parent-hop'?fixture.physical('/')+'/var/lib/patrick-grok/../../../opt/trusted/tool':fixture.physical('/var/lib/patrick-grok/hop'),fixture.physical('/usr/bin/tool'));}
      else fs.symlinkSync(fixture.physical('/opt/trusted/tool'),fixture.physical('/usr/bin/tool'));
      expect(()=>install.trustedExecutable('/usr/bin/tool',fixture.io)).toThrow('dependency');
    }finally{fixture.close();}
  });
  it('preserves BOM and literal replacement-character bytes in valid executable links',()=>{
    const fixture=filesystemFixture();try{const target='\uFEFF目标-\uFFFD/tool';fixture.file('/usr/bin/'+target,'fixture',0o755);fs.symlinkSync(target,fixture.physical('/usr/bin/tool'));expect(()=>install.trustedExecutable('/usr/bin/tool',fixture.io)).not.toThrow();}finally{fixture.close();}
  });
  it('rejects a root setuid Node dependency and accepts a trusted resolver file symlink',async()=>{
    const fixture=await prepared();try{const lstat=fixture.io.lstatSync;fixture.io.lstatSync=(path:string)=>{const stat=lstat(path);return path===install.NODE?Object.assign(Object.create(stat),{mode:stat.mode|0o4000}):stat;};await expect(install.installGuest(fixture.input,fixture.deps)).rejects.toThrow('dependency');fixture.io.lstatSync=lstat;fixture.file('/run/systemd/resolve/resolv.conf','nameserver 192.0.2.53\n');fs.unlinkSync(fixture.physical('/etc/resolv.conf'));fs.symlinkSync(fixture.physical('/run/systemd/resolve/resolv.conf'),fixture.physical('/etc/resolv.conf'));await expect(install.installGuest(fixture.input,fixture.deps)).resolves.toMatchObject({applied:false});expect(fixture.mutations).toEqual([]);}finally{fixture.close();}
  });
  it('rejects partial future artifacts instead of installing placeholders',()=>{
    const fixture=filesystemFixture();
    try {fixture.file('/stage/manifest.json',JSON.stringify({version:1}));expect(()=>install.inspectArtifacts('/stage',fixture.io)).toThrow('untrusted_artifact');expect(fixture.mutations).toEqual([]);} finally {fixture.close();}
  });
  it('rejects symlinks, mutable ancestors and nonroot inputs before evaluating source',()=>{
    for(const kind of ['symlink','writable','owner']){
      const fixture=filesystemFixture();
      try {
        fixture.file('/stage/manifest.json','{}');
        if(kind==='symlink'){fs.renameSync(fixture.physical('/stage/manifest.json'),fixture.physical('/stage/other'));fs.symlinkSync('other',fixture.physical('/stage/manifest.json'));}
        if(kind==='writable')fs.chmodSync(fixture.physical('/stage'),0o777);
        if(kind==='owner')fixture.owners.set('/stage/manifest.json',{uid:1101,gid:1101});
        expect(()=>install.inspectArtifacts('/stage',fixture.io)).toThrow('untrusted_artifact');expect(fixture.mutations).toEqual([]);
      } finally {fixture.close();}
    }
  });
});

async function prepared() {
  const fixture=filesystemFixture(),calls:{path:string;args:string[];input?:string}[]=[],summaries:any[]=[];
  const directory=new URL('../../scripts/lima/',import.meta.url);
  for(const name of ['install-guest.mjs','probe-guest.mjs','policy.mjs','worker-enter.mjs','stage-lifetime.mjs'])fixture.file(decodeURI(new URL(name,directory).pathname),fs.readFileSync(new URL(name,directory),'utf8'));
  const contents:Record<string,string>={};
  for(const name of install.ARTIFACTS){
    if(name==='route-inventory.json')contents[name]=JSON.stringify(inventory());
    else if(name.startsWith('patrick-worker'))contents[name]=fs.readFileSync(new URL('../../examples/lima/'+name,import.meta.url),'utf8');
    else contents[name]=fs.readFileSync(new URL(name,directory),'utf8');
    fixture.file('/stage/'+name,contents[name]!,name==='route-inventory.json'?0o600:0o644);
  }
  fixture.file('/policy-input',JSON.stringify(policy));
  const manifest={version:1,controlAdmin:'admin',reviewedSources:{identity:'5c3f5188e41f04eff3a2564cd38208a7e3768019',proxy:'43659a3d6dc7a22e914ef654163842b158de428c'},policyHash:hash(JSON.stringify(policy)),files:Object.fromEntries(Object.entries(contents).map(([name,text])=>[name,hash(text)]))};
  fixture.file('/stage/manifest.json',JSON.stringify(manifest));
  const accountFacts=accounts();
  fixture.file('/etc/passwd','root:x:0:0::/root:/bin/sh\nadmin:x:1000:1000::/home/admin:/bin/bash\n'+Object.entries(accountFacts).map(([name,account])=>`${name}:x:${account.uid}:${account.gid}::${account.home}:${account.shell}`).join('\n')+'\n');
  fixture.file('/etc/group','root:x:0:\nadmin:x:1000:\n'+Object.entries(accountFacts).map(([name,account])=>`${name}:x:${account.gid}:`).join('\n')+'\n');
  fixture.file('/etc/shadow','root:!:1:0:99999:7:::\nadmin:$fixture:1:0:99999:7:::\n'+Object.keys(accountFacts).map(name=>`${name}:!:1:0:99999:7:::`).join('\n')+'\n',0o600);
  for(const [name,account] of Object.entries(accountFacts)){fs.mkdirSync(fixture.physical(`/var/lib/${name}`),{recursive:true,mode:0o700});fixture.owners.set(`/var/lib/${name}`,{uid:account.uid,gid:account.gid});}
  for(const path of ['/usr/local/bin/node',install.NODE,'/usr/bin/env','/usr/bin/dash','/usr/bin/setpriv','/usr/sbin/nft','/usr/bin/systemctl','/usr/bin/systemd-run','/usr/bin/sudo','/usr/sbin/visudo','/usr/sbin/useradd','/usr/sbin/groupadd','/usr/sbin/nologin','/usr/sbin/ip','/usr/bin/journalctl'])fixture.file(path,'fixture executable',0o755);
  fs.unlinkSync(fixture.physical('/usr/local/bin/node'));fs.symlinkSync(fixture.physical(install.NODE),fixture.physical('/usr/local/bin/node'));
  for(const path of ['/usr/local/libexec','/etc/systemd/system','/etc/sudoers.d','/run','/proc/4321/fd'])fs.mkdirSync(fixture.physical(path),{recursive:true,mode:0o755});
  fixture.file('/etc/resolv.conf','nameserver 192.0.2.53\n');fixture.file('/etc/hosts','127.0.0.1 localhost\n::1 localhost\n192.0.2.2 host.lima.internal\n');fixture.file('/proc/net/unix','Num RefCount Protocol Flags Type St Inode Path\n');
  fixture.file('/proc/4321/status','Name:\tnode\nUid:\t1100\t1100\t1100\t1100\nGid:\t1100\t1100\t1100\t1100\nGroups:\t\n');
  fixture.file('/proc/sys/kernel/random/boot_id','01234567-89ab-4cde-8fab-0123456789ab\n');fixture.file('/proc/5678/stat','5678 (node) '+['S',...Array(18).fill('0'),'12345'].join(' ')+'\n');fixture.file('/proc/5678/status','Uid:\t0\t0\t0\t0\n');fixture.file('/proc/5678/cmdline',Buffer.from(['/usr/local/bin/node','--no-addons',decodeURI(new URL('install-guest.mjs',directory).pathname),'--policy','/policy-input','--artifacts','/stage','--apply',''].join('\0')).toString());fs.symlinkSync(fixture.physical(install.NODE),fixture.physical('/proc/5678/exe'));
  fixture.file('/proc/self/mountinfo','1 0 0:1 / / rw - ext4 /dev/root rw\n');
  fixture.file('/proc/sys/kernel/hostname','fixture-host\n');
  fixture.file('/proc/4321/net/tcp','header\n'+[18743,18744,18745].map((port,index)=>`0: 0100007F:${port.toString(16)} 00000000:0000 0A 0:0 0:0 0 1100 0 ${9000+index} 1`).join('\n')+'\n');fixture.file('/proc/4321/net/tcp6','header\n');
  for(let index=0;index<3;index++)fs.symlinkSync(`socket:[${9000+index}]`,fixture.physical(`/proc/4321/fd/${index}`));
  const policyLibrary=await import(new URL('policy.mjs',directory).href),entryLibrary=await import(new URL('worker-enter.mjs',directory).href),lifetimeLibrary=await import(new URL('stage-lifetime.mjs',directory).href);
  let liveNft:any=null,transactionText='',failCommand='',activeState='active';
  const match=(left:any,right:any)=>({match:{op:'==',left,right}});
  function kernelNft(){const current=install.readAccounts(deps).facts,base={family:'inet',table:'patrick_worker'};return {nftables:[{metainfo:{version:'1.0.9',release_name:'fixture',json_schema_version:1}},{table:{family:'inet',name:'patrick_worker'}},{chain:{...base,name:'output',type:'filter',hook:'output',prio:-50,policy:'accept'}},...policy.workers.map(worker=>({chain:{...base,name:worker.runner+'_out'}})),...policy.workers.flatMap(worker=>[{rule:{...base,chain:'output',expr:[match({meta:{key:'skuid'}},current[worker.user]!.uid),{jump:{target:worker.runner+'_out'}}]}},{rule:{...base,chain:worker.runner+'_out',expr:[match({meta:{key:'oifname'}},'lo'),match({payload:{protocol:'ip',field:'daddr'}},'127.0.0.1'),match({payload:{protocol:'tcp',field:'dport'}},worker.proxyPort),{accept:null}]}},{rule:{...base,chain:worker.runner+'_out',expr:[{reject:{type:'icmpx',expr:'admin-prohibited'}}]}}])]};}
  const deps={io:fixture.io,installerPid:5678,effectiveUid:()=>0,now:()=>Date.parse('2026-11-04T00:01:00Z'),loadModules:async()=>({...policyLibrary,...entryLibrary,...lifetimeLibrary}),summary:(value:any)=>summaries.push(value),run:(path:string,args:string[],input?:string)=>{
    calls.push({path,args:[...args],input});const key=path+' '+args.join(' ');if(failCommand&&key.includes(failCommand))return {status:1,stdout:'private secret must not be reported'};
    let stdout='';
    if(path==='/usr/local/bin/node')stdout='v24.22.2\n';
    else if(path==='/usr/bin/env')stdout='--ignore-environment';
    else if(path==='/usr/bin/systemd-run')stdout='--unit --property --wait --pipe --collect';
    else if(path==='/usr/bin/sudo')stdout=`User ${args[3]} is not allowed to run sudo on fixture-host.\n`;
    else if(path==='/usr/bin/setpriv')stdout=args[0]==='--help'?'--reuid --regid --clear-groups --no-new-privs --bounding-set --inh-caps --ambient-caps':'denied\n';
    else if(path==='/usr/sbin/ip')stdout=JSON.stringify(args.includes('address')?[{addr_info:[{family:'inet',local:'192.0.2.10',scope:'global'}]}]:args.includes('-4')?[{dst:'default',gateway:'192.0.2.1'}]:[]);
    else if(path==='/usr/sbin/nft'){
      if(args[0]==='--version')stdout='nftables v1.0.9 (fixture)\n';
      else if(args.join(' ')==='-j list tables')stdout=JSON.stringify({nftables:liveNft?[{table:{family:'inet',name:'unrelated'}},{table:{family:'inet',name:'patrick_worker'}}]:[{table:{family:'inet',name:'unrelated'}}]});
      else if(args.join(' ')==='-j list table inet patrick_worker')stdout=JSON.stringify(liveNft);
      else if(args[0]==='-c')transactionText=fixture.io.readFileSync(args[2],'utf8');
      else if(args[0]==='-f'){expect(fixture.io.readFileSync(args[1],'utf8')).toBe(transactionText);liveNft=kernelNft();}
      else throw Error('unexpected nft command');
    }
    else if(path==='/usr/bin/systemctl'){
      if(args[0]==='--version')stdout='systemd 255 (fixture)\n';
      else if(args[0]==='list-units')stdout='';
      else if(args.includes('--property=FragmentPath,DropInPaths,LoadState')){const name=args[1];const loaded=fs.existsSync(fixture.physical('/etc/systemd/system/'+name));stdout=`FragmentPath=${loaded?'/etc/systemd/system/'+name:''}\nDropInPaths=\nLoadState=${loaded?'loaded':'not-found'}\n`;}
      else if(args.includes('--property=User,Group,MainPID,ActiveState,SubState,FragmentPath,DropInPaths'))stdout=`User=patrick-proxy\nGroup=patrick-proxy\nMainPID=4321\nActiveState=${activeState}\nSubState=running\nFragmentPath=/etc/systemd/system/patrick-worker-proxy.service\nDropInPaths=\n`;
      else if(args.includes('--property=ActiveState,SubState,MainPID'))stdout='ActiveState=inactive\nSubState=dead\nMainPID=0\n';
      else if(args.some(arg=>arg.startsWith('--property=NoNewPrivileges')))stdout='MemoryMax=268435456\nTasksMax=32\nPrivateNetwork=no\nAmbientCapabilities=\nCapabilityBoundingSet=\nNoNewPrivileges=yes\nLimitNOFILE=256\n';
      else if(!['daemon-reload','enable','start','stop'].includes(args[0]!))throw Error('unexpected systemctl command');
    }else if(path==='/usr/sbin/groupadd'){if(args[0]==='--help')stdout='--gid';else{const name=args.at(-1),id=args[1];fixture.file('/etc/group',fixture.io.readFileSync('/etc/group','utf8')+`${name}:x:${id}:\n`);}}
    else if(path==='/usr/sbin/useradd'){if(args[0]==='--help')stdout='--uid --gid --no-user-group --no-create-home --home-dir --shell --password';else{const name=args.at(-1),uid=args[1],gid=args[3];fixture.file('/etc/passwd',fixture.io.readFileSync('/etc/passwd','utf8')+`${name}:x:${uid}:${gid}::/var/lib/${name}:/usr/sbin/nologin\n`);fixture.file('/etc/shadow',fixture.io.readFileSync('/etc/shadow','utf8')+`${name}:!:1:0:99999:7:::\n`,0o600);}}
    else if(path!=='/usr/sbin/visudo')throw Error('unexpected process '+path);
    return {status:0,stdout,stderr:''};
  }};
  fixture.mutations.length=0;
  return {...fixture,deps,calls,summaries,manifest,contents,kernelNft,transaction:()=>transactionText,setFailure:(value:string)=>{failCommand=value;},setNft:(value:any)=>{liveNft=value;},setActive:(value:string)=>{activeState=value;},input:{policyPath:'/policy-input',artifactDir:'/stage',apply:false}};
}

describe('hermetic check/apply control plane',()=>{
  function stageGeneration(fixture:Awaited<ReturnType<typeof prepared>>,kind:string) {
    const value=inventory();
    value.collectedAt='2026-11-04T02:00:00.000Z';
    const {fingerprint:_,...data}=value;
    value.fingerprint=hash(JSON.stringify(data));
    fixture.contents['route-inventory.json']=JSON.stringify(value);
    if(kind==='template')fixture.contents['patrick-worker-proxy.service']+='\n# Reviewed generation update\n';
    for(const name of ['route-inventory.json','patrick-worker-proxy.service']){
      fixture.file('/stage/'+name,fixture.contents[name]!,name==='route-inventory.json'?0o600:0o644);
      fixture.manifest.files[name]=hash(fixture.contents[name]!);
    }
    fixture.file('/stage/manifest.json',JSON.stringify(fixture.manifest));
    fixture.deps.now=()=>Date.parse('2026-11-04T02:01:00Z');
  }
  it.each(['inventory','template'])('updates a trusted %s generation after old inventory expires, without absorbing old metadata as readiness',async kind=>{
    const fixture=await prepared();try{
      await install.installGuest({...fixture.input,apply:true},fixture.deps);
      const identities=install.readAccounts(fixture.deps),oldManifest=fixture.io.readFileSync('/etc/patrick-worker/manifest.json','utf8');
      const registryBefore=JSON.parse(oldManifest).installation.registry;
      stageGeneration(fixture,kind);
      fixture.mutations.length=0;fixture.calls.length=0;
      await expect(probe.probeGuest('snapshot',fixture.deps)).rejects.toThrow('inventory_incomplete');
      await expect(install.installGuest(fixture.input,fixture.deps)).rejects.toThrow();
      expect(fixture.mutations).toEqual([]);
      await expect(install.installGuest({...fixture.input,apply:true},fixture.deps)).resolves.toMatchObject({applied:true});
      expect(install.readAccounts(fixture.deps)).toEqual(identities);
      expect(fixture.io.readFileSync('/etc/patrick-worker/manifest.json','utf8')).not.toBe(oldManifest);
      const transaction=fixture.calls.find(call=>call.path==='/usr/sbin/nft'&&call.args[0]==='-c');
      expect(transaction).toBeDefined();
      expect(fixture.transaction().startsWith('delete table inet patrick_worker\ntable inet patrick_worker')).toBe(true);expect(fixture.summaries.at(-1)).toMatchObject({ownedTableToReplace:true});
      expect(fixture.transaction()).not.toContain('unrelated');
      expect(fixture.calls.filter(call=>call.path==='/usr/sbin/nft'&&call.args[0]==='-f')).toHaveLength(1);
      expect(fixture.calls.every(call=>!call.args.includes('flush')&&!call.args.includes('unrelated'))).toBe(true);
      await expect(probe.probeGuest('snapshot',fixture.deps)).resolves.toMatchObject({outcome:'pass'});
      fixture.mutations.length=0;fixture.calls.length=0;
      await install.installGuest(fixture.input,fixture.deps);
      await install.installGuest({...fixture.input,apply:true},fixture.deps);
      expect(JSON.parse(fixture.io.readFileSync('/etc/patrick-worker/manifest.json','utf8')).installation.registry).toEqual(registryBefore);
      expect(fixture.mutations).toEqual([]);
      expect(fixture.calls.filter(call=>['start','stop','enable','daemon-reload','-f'].includes(call.args[0]!))).toEqual([]);
    }finally{fixture.close();}
  });
  it.each(['expired','future','fingerprint','unreviewed-bytes'])('refuses %s new target inventory even though the previous generation is owned',async kind=>{
    const fixture=await prepared();try{
      await install.installGuest({...fixture.input,apply:true},fixture.deps);
      stageGeneration(fixture,'inventory');
      const value=JSON.parse(fixture.contents['route-inventory.json']!);
      if(kind==='expired')value.collectedAt='2026-11-04T00:00:00.000Z';
      if(kind==='future')value.collectedAt='2026-11-04T03:00:00.000Z';
      const {fingerprint:_,...data}=value;
      value.fingerprint=kind==='fingerprint'?'0'.repeat(64):hash(JSON.stringify(data));
      const text=JSON.stringify(value)+(kind==='unreviewed-bytes'?'\n':'');
      fixture.file('/stage/route-inventory.json',text,0o600);
      if(kind!=='unreviewed-bytes')fixture.manifest.files['route-inventory.json']=hash(text);
      fixture.file('/stage/manifest.json',JSON.stringify(fixture.manifest));
      fixture.mutations.length=0;fixture.calls.length=0;
      await expect(install.installGuest({...fixture.input,apply:true},fixture.deps)).rejects.toThrow(kind==='unreviewed-bytes'?'untrusted_artifact':'inventory_incomplete');
      expect(fixture.mutations).toEqual([]);
      expect(fixture.calls.some(call=>['start','stop','-f'].includes(call.args[0]!))).toBe(false);
    }finally{fixture.close();}
  });
  it.each(['table','unit','manifest','inventory','policy','code','account-alias'])('refuses modified previous %s evidence even with a valid refreshed target',async kind=>{
    const fixture=await prepared();try{
      await install.installGuest({...fixture.input,apply:true},fixture.deps);
      stageGeneration(fixture,'template');
      if(kind==='table'){const nft=fixture.kernelNft();nft.nftables.pop();fixture.setNft(nft);}
      if(kind==='unit')fixture.file('/etc/systemd/system/patrick-worker-proxy.service',fixture.contents['patrick-worker-proxy.service']!);
      if(kind==='manifest'){const path='/etc/patrick-worker/manifest.json',value=JSON.parse(fixture.io.readFileSync(path,'utf8'));value.installation.artifactHash='0'.repeat(64);fixture.file(path,JSON.stringify(value));}
      if(kind==='inventory')fixture.file('/etc/patrick-worker/route-inventory.json',fixture.contents['route-inventory.json']!,0o600);
      if(kind==='policy')fixture.file('/etc/patrick-worker/policy.json',JSON.stringify({...policy,deniedCidrs:['::/0']}));
      if(kind==='code')fixture.file(install.CODE+'/connect-proxy.mjs','// tampered\n',0o755);
      if(kind==='account-alias')fixture.file('/etc/passwd',fixture.io.readFileSync('/etc/passwd','utf8')+'alias:x:1101:1101::/home/alias:/bin/sh\n');
      fixture.mutations.length=0;fixture.calls.length=0;
      await expect(install.installGuest({...fixture.input,apply:true},fixture.deps)).rejects.toThrow();
      expect(fixture.mutations).toEqual([]);
      expect(fixture.calls.some(call=>['stop','start','-f'].includes(call.args[0]!))).toBe(false);
    }finally{fixture.close();}
  });
  it.each(['owner-write','owner-directory-fsync','fence-write','fence-rename','fence-directory-fsync'])('stops and verifies an existing proxy after one-shot %s failure',async fault=>{
    const fixture=await prepared();try{
      await install.installGuest({...fixture.input,apply:true},fixture.deps);
      const path='/etc/patrick-worker/install-state.json',state=JSON.parse(fixture.io.readFileSync(path,'utf8'));
      fixture.file(path,JSON.stringify({...state,status:'failed'}),0o600);
      const descriptors=new Map<number,string>(),open=fixture.io.openSync,write=fixture.io.writeFileSync,rename=fixture.io.renameSync,sync=fixture.io.fsyncSync;
      let injected=false,renamedFence=false;
      const trip=()=>{injected=true;throw Object.assign(Error('one-shot fixture I/O fault'),{code:'EIO'});};
      fixture.io.openSync=(name:string,flags:number,mode?:number)=>{const fd=open(name,flags,mode);descriptors.set(fd,name);return fd;};
      fixture.io.writeFileSync=(fd:number,data:any,options:any)=>{const name=descriptors.get(fd)??'';if(!injected&&((fault==='owner-write'&&name.includes('/owner.json.tmp-'))||(fault==='fence-write'&&name.includes('/install-state.json.tmp-'))))trip();return write(fd,data,options);};
      fixture.io.renameSync=(from:string,to:string)=>{if(!injected&&fault==='fence-rename'&&to===path)trip();const result=rename(from,to);if(to===path)renamedFence=true;return result;};
      fixture.io.fsyncSync=(fd:number)=>{const name=descriptors.get(fd);if(!injected&&((fault==='owner-directory-fsync'&&name==='/run/patrick-worker/install.lock')||(fault==='fence-directory-fsync'&&renamedFence&&name==='/etc/patrick-worker')))trip();return sync(fd);};
      fixture.calls.length=0;
      await expect(install.installGuest({...fixture.input,apply:true},fixture.deps)).rejects.toThrow();
      expect(injected).toBe(true);
      expect(fixture.calls.slice(-2).map(call=>call.args)).toEqual([['stop','patrick-worker-proxy.service'],['show','patrick-worker-proxy.service','--no-pager','--property=ActiveState,SubState,MainPID']]);
      expect(JSON.parse(fixture.io.readFileSync(path,'utf8')).status).toBe('failed');
      expect(fs.existsSync(fixture.physical('/run/patrick-worker/install.lock'))).toBe(fault.startsWith('owner-'));
    }finally{fixture.close();}
  });
  it.each(['stop-failed','stop-unknown'])('retains the mutex when an early fence failure leaves proxy state %s',async kind=>{
    const fixture=await prepared();try{
      await install.installGuest({...fixture.input,apply:true},fixture.deps);
      const path='/etc/patrick-worker/install-state.json',state=JSON.parse(fixture.io.readFileSync(path,'utf8'));
      fixture.file(path,JSON.stringify({...state,status:'failed'}),0o600);
      const rename=fixture.io.renameSync,run=fixture.deps.run;let injected=false;
      fixture.io.renameSync=(from:string,to:string)=>{const result=rename(from,to);if(!injected&&to===path){injected=true;throw Error('after fence rename');}return result;};
      fixture.deps.run=(command,args,input)=>command==='/usr/bin/systemctl'&&((kind==='stop-failed'&&args[0]==='stop')||(kind==='stop-unknown'&&args.includes('--property=ActiveState,SubState,MainPID')))?{status:kind==='stop-failed'?1:0,stdout:'ActiveState=active\nSubState=running\nMainPID=4321\n',stderr:''}:run(command,args,input);
      await expect(install.installGuest({...fixture.input,apply:true},fixture.deps)).rejects.toThrow('service_state');
      expect(JSON.parse(fixture.io.readFileSync(path,'utf8')).status).toBe('failed');
      expect(fixture.io.lstatSync('/run/patrick-worker/install.lock').isDirectory()).toBe(true);
    }finally{fixture.close();}
  });
  it('retries a trusted generation update after its new failure fence was persisted over the old installed generation',async()=>{
    const fixture=await prepared();try{
      await install.installGuest({...fixture.input,apply:true},fixture.deps);
      stageGeneration(fixture,'template');
      const path='/etc/patrick-worker/install-state.json',rename=fixture.io.renameSync;
      let injected=false;
      fixture.io.renameSync=(from:string,to:string)=>{const result=rename(from,to);if(!injected&&to===path){injected=true;throw Error('after new generation fence rename');}return result;};
      await expect(install.installGuest({...fixture.input,apply:true},fixture.deps)).rejects.toThrow();
      const fence=JSON.parse(fixture.io.readFileSync(path,'utf8')),previous=JSON.parse(fixture.io.readFileSync('/etc/patrick-worker/manifest.json','utf8'));
      expect(fence.status).toBe('failed');
      expect(fence.artifactHash).not.toBe(previous.installation.artifactHash);
      await expect(probe.probeGuest('snapshot',fixture.deps)).rejects.toThrow('installed_mismatch');
      await expect(install.installGuest({...fixture.input,apply:true},fixture.deps)).resolves.toMatchObject({applied:true});
      await install.installGuest(fixture.input,fixture.deps);
      fixture.mutations.length=0;
      await install.installGuest({...fixture.input,apply:true},fixture.deps);
      expect(fixture.mutations).toEqual([]);
    }finally{fixture.close();}
  });
  it('checks without filesystem, account, service or nft mutations',async()=>{
    const fixture=await prepared();try{await expect(install.installGuest(fixture.input,fixture.deps)).resolves.toMatchObject({applied:false});expect(fixture.mutations).toEqual([]);expect(fixture.calls.some(call=>['-f','enable','start','stop','daemon-reload','--uid','--gid'].includes(call.args[0]!))).toBe(false);expect(fixture.summaries.at(-1)).toMatchObject({outcome:'pass',accountsToCreate:0});}finally{fixture.close();}
  });
  it.each(['version','required-flag'])('rejects missing pinned dependency %s without package fallback',async kind=>{
    const fixture=await prepared();try{const original=fixture.deps.run;fixture.deps.run=(path,args,input)=>kind==='version'&&path==='/usr/local/bin/node'?{status:0,stdout:'v25.0.0\n'}:kind==='required-flag'&&path==='/usr/sbin/useradd'&&args[0]==='--help'?{status:0,stdout:'--uid --gid'}:original(path,args,input);await expect(install.installGuest({...fixture.input,apply:true},fixture.deps)).rejects.toThrow('dependency');expect(fixture.mutations).toEqual([]);expect(fixture.calls.some(call=>/apt|dnf|yum|apk/.test(call.path))).toBe(false);}finally{fixture.close();}
  });
  it.each(['grant-exit-zero','wrong-user','wrong-host','extra-line','plugin-error','wrong-status'])('rejects %s effective sudo output before mutation',async kind=>{
    const fixture=await prepared();try{const original=fixture.deps.run;fixture.deps.run=(path,args,input)=>{if(path!=='/usr/bin/sudo')return original(path,args,input);const user=kind==='wrong-user'?'other':args[3],host=kind==='wrong-host'?'other-host':'fixture-host';return {status:kind==='wrong-status'?1:0,stdout:kind==='grant-exit-zero'?'User fixture may run (ALL) NOPASSWD: ALL\n':`User ${user} is not allowed to run sudo on ${host}.\n`+(kind==='extra-line'?'extra\n':''),stderr:kind==='plugin-error'?'policy plugin failed':''};};await expect(install.installGuest({...fixture.input,apply:true},fixture.deps)).rejects.toThrow('account_conflict');expect(fixture.mutations).toEqual([]);}finally{fixture.close();}
  });
  it.each(['admin-world','root-worker-group'])('rejects accessible %s privileged Unix sockets before mutation',async kind=>{
    const fixture=await prepared();try{fixture.file('/proc/net/unix','Num RefCount Protocol Flags Type St Inode Path\n000: 1 0 0 1 1 123 /run/privileged.sock\n');fixture.file('/run/privileged.sock','synthetic socket',kind==='admin-world'?0o666:0o660);fixture.owners.set('/run/privileged.sock',{uid:kind==='admin-world'?1000:0,gid:kind==='root-worker-group'?1101:1000});const original=fixture.deps.run;fixture.deps.run=(path,args,input)=>path==='/usr/bin/setpriv'&&args[0]==='--reuid=1101'?{status:0,stdout:'accessible\n',stderr:''}:original(path,args,input);await expect(install.installGuest({...fixture.input,apply:true},fixture.deps)).rejects.toThrow('dependency');expect(fixture.mutations).toEqual([]);}finally{fixture.close();}
  });
  it.each(['accessible','unknown'])('rejects effective %s socket results even when mode facts deny access',async result=>{
    const fixture=await prepared();try{const original=fixture.deps.run;fixture.deps.run=(path,args,input)=>path==='/usr/bin/setpriv'&&args[0]!=='--help'?{status:0,stdout:result+'\n',stderr:''}:original(path,args,input);await expect(install.installGuest({...fixture.input,apply:true},fixture.deps)).rejects.toThrow('dependency');expect(fixture.mutations).toEqual([]);}finally{fixture.close();}
  });
  it('does not classify an ordinary public DBus endpoint as admin solely from root ownership',async()=>{
    const fixture=await prepared();try{fixture.file('/proc/net/unix','Num RefCount Protocol Flags Type St Inode Path\n000: 1 0 0 1 1 123 /run/dbus/system_bus_socket\n');fixture.file('/run/dbus/system_bus_socket','synthetic public DBus',0o666);await expect(install.installGuest(fixture.input,fixture.deps)).resolves.toMatchObject({applied:false});expect(fixture.mutations).toEqual([]);}finally{fixture.close();}
  });
  it('uses only the fixed baseline, numeric admin runtime and bound trusted extras after full privilege drop',async()=>{
    const fixture=await prepared();try{const value:any=inventory();value.extraPrivilegedSocketPaths=['/run/operator/admin-control.sock'];const {fingerprint:_,...data}=value;value.fingerprint=hash(JSON.stringify(data));const text=JSON.stringify(value);fixture.file('/stage/route-inventory.json',text,0o600);fixture.manifest.files['route-inventory.json']=hash(text);fixture.file('/stage/manifest.json',JSON.stringify(fixture.manifest));await install.installGuest(fixture.input,fixture.deps);const calls=fixture.calls.filter(call=>call.path==='/usr/bin/setpriv'&&call.args[0]!=='--help');expect(calls).toHaveLength(4);for(const call of calls){expect(call.args.slice(2,16)).toEqual(['--clear-groups','--no-new-privs','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--','/usr/bin/env','-i','PATH=/usr/local/bin:/usr/bin:/bin','LANG=C','/usr/local/bin/node','--no-addons','-e',expect.any(String)]);const paths=JSON.parse(call.args.at(-1)!);expect(paths).toContain('/run/operator/admin-control.sock');expect(paths).toContain('/run/systemd/private');expect(paths).toContain('/run/user/1000/bus');expect(paths).not.toContain('/run/dbus/system_bus_socket');expect(call.args[15]).toContain('fs.accessSync(path,fs.constants.W_OK)');expect(call.args[15]).toContain('NoNewPrivs:');expect(call.args[15]).not.toContain('connect(');}expect(fixture.mutations).toEqual([]);}finally{fixture.close();}
  });
  it('executes the fixed access program against synthetic kernel facts including ACL grants and capability errors',async()=>{
    const fixture=await prepared();try{await install.installGuest(fixture.input,fixture.deps);const call=fixture.calls.find(item=>item.path==='/usr/bin/setpriv'&&item.args[0]!=='--help')!;
      function evaluate(change:{uid?:number;groups?:number[];cap?:string;nnp?:string;acl?:boolean;io?:boolean}={}){let output='';const processFacts={argv:['node',call.args[16],call.args[17],call.args[18]],getuid:()=>change.uid??Number(call.args[16]),geteuid:()=>Number(call.args[16]),getgid:()=>Number(call.args[17]),getegid:()=>Number(call.args[17]),getgroups:()=>change.groups??[],stdout:{write:(text:string)=>{output+=text;}},exitCode:0};const status=['CapInh: 0000000000000000','CapPrm: 0000000000000000',`CapEff: ${change.cap??'0000000000000000'}`,'CapBnd: 0000000000000000','CapAmb: 0000000000000000',`NoNewPrivs: ${change.nnp??'1'}`].join('\n');const kernel={constants:{W_OK:2},readFileSync:(path:string)=>{expect(path).toBe('/proc/self/status');return status;},accessSync:(_path:string,mode:number)=>{expect(mode).toBe(2);if(!change.acl)throw Object.assign(Error('synthetic kernel denial'),{code:change.io?'EIO':'EACCES'});}};runInNewContext(call.args[15]!,{require:(name:string)=>{expect(name).toBe('node:fs');return kernel;},process:processFacts});return {output,exit:processFacts.exitCode};}
      expect(evaluate()).toEqual({output:'denied\n',exit:0});expect(evaluate({acl:true})).toEqual({output:'accessible\n',exit:0});for(const change of [{uid:0},{groups:[1101]},{cap:'0000000000000001'},{nnp:'0'},{io:true}])expect(evaluate(change)).toEqual({output:'unknown\n',exit:78});
    }finally{fixture.close();}
  });
  it('applies, rechecks and reapplies idempotently with one exact owned-table transaction',async()=>{
    const fixture=await prepared();try{
      await install.installGuest({...fixture.input,apply:true},fixture.deps);
      const before=new Map(install.ARTIFACTS.filter((name:string)=>name.endsWith('.mjs')).map((name:string)=>[name,fixture.io.readFileSync(install.CODE+'/'+name,'utf8')]));
      fixture.mutations.length=0;fixture.calls.length=0;
      await install.installGuest(fixture.input,fixture.deps);expect(fixture.mutations).toEqual([]);expect(fixture.summaries.at(-1)).toMatchObject({filesToReplace:0,ownedTableToReplace:false});
      await install.installGuest({...fixture.input,apply:true},fixture.deps);
      expect(fixture.mutations).toEqual([]);
      for(const [name,text] of before)expect(fixture.io.readFileSync(install.CODE+'/'+name,'utf8')).toBe(text);
      expect(fixture.calls.filter(call=>call.path==='/usr/sbin/nft'&&call.args[0]==='-f')).toHaveLength(0);
      const launcher=fixture.io.readFileSync('/usr/local/libexec/patrick-worker-enter','utf8');expect(launcher).not.toContain('\n+');
    }finally{fixture.close();}
  });
  it.each(['not-root','forged-manifest','extra-payload','partial','active','inventory','service-dropin','service-mismatch','account-home','unexpected-table','dependency'])('performs no mutations for failed precondition %s',async kind=>{
    const fixture=await prepared();try{
      if(kind==='not-root')fixture.deps.effectiveUid=()=>1000;
      if(kind==='forged-manifest')fixture.file('/stage/policy.mjs','forged');
      if(kind==='extra-payload')fixture.file('/stage/root-command','payload');
      if(kind==='partial')fs.unlinkSync(fixture.physical('/stage/stage-lifetime.mjs'));
      if(kind==='active')fixture.file('/proc/999/status','Uid:\t1101\t1101\t1101\t1101\n');
      if(kind==='inventory')fixture.file('/etc/resolv.conf','nameserver 192.0.2.54\n');
      if(kind==='service-dropin')fs.mkdirSync(fixture.physical('/etc/systemd/system/patrick-worker-proxy.service.d'));
      if(kind==='service-mismatch')fixture.file('/etc/systemd/system/patrick-worker-proxy.service','[Service]\nUser=root\n');
      if(kind==='account-home')fs.chmodSync(fixture.physical('/var/lib/patrick-grok'),0o755);
      if(kind==='unexpected-table')fixture.setNft(fixture.kernelNft());
      if(kind==='dependency')fixture.setFailure('nft --version');
      await expect(install.installGuest({...fixture.input,apply:true},fixture.deps)).rejects.toThrow();expect(fixture.mutations).toEqual([]);expect(fixture.calls.some(call=>['enable','start','stop'].includes(call.args[0]!))).toBe(false);
      expect(JSON.stringify(fixture.summaries)).not.toContain('192.0.2');expect(JSON.stringify(fixture.summaries)).not.toContain('private secret');
    }finally{fixture.close();}
  });
  it.each(['nft -c','nft -f'])('keeps services closed and never touches unrelated tables on %s failure',async failure=>{
    const fixture=await prepared();try{fixture.setFailure(failure);await expect(install.installGuest({...fixture.input,apply:true},fixture.deps)).rejects.toThrow(failure==='nft -c'?'nft_check':'nft_apply');expect(fixture.calls.some(call=>['enable','start'].includes(call.args[0]!))).toBe(false);expect(fixture.calls.every(call=>!call.args.includes('flush')&&!call.args.includes('unrelated'))).toBe(true);}finally{fixture.close();}
  });
  it('rejects partial actual listeners instead of accepting active text',async()=>{
    const fixture=await prepared();try{fixture.file('/proc/4321/net/tcp','header\n');await expect(install.installGuest({...fixture.input,apply:true},fixture.deps)).rejects.toThrow();expect(fixture.summaries.at(-1)).toMatchObject({outcome:'fail'});}finally{fixture.close();}
  });
  it('stops the proxy after a failed apply and keeps the owned deny table',async()=>{
    const fixture=await prepared();try{fixture.setFailure('systemctl start patrick-worker-proxy.service');await expect(install.installGuest({...fixture.input,apply:true},fixture.deps)).rejects.toThrow('service_state');expect(fixture.calls.slice(-2).map(call=>call.args[0])).toEqual(['stop','show']);expect(fixture.calls.some(call=>call.args.includes('delete'))).toBe(false);}finally{fixture.close();}
  });
  it('validates the complete installed runtime before a snapshot or firewall reload',async()=>{
    const fixture=await prepared();try{await install.installGuest({...fixture.input,apply:true},fixture.deps);await expect(probe.probeGuest('snapshot',fixture.deps)).resolves.toMatchObject({outcome:'pass',ipv6UpstreamDisabled:true});fixture.file('/usr/local/libexec/patrick-worker-enter','#!/usr/bin/dash\nexec /bin/sh "$@"\n',0o755);await expect(probe.probeGuest('snapshot',fixture.deps)).rejects.toThrow('installed_mismatch');}finally{fixture.close();}
  });
  it('reports the future synthetic traffic dependency without claiming a network pass',async()=>{
    const fixture=await prepared();try{await install.installGuest({...fixture.input,apply:true},fixture.deps);await expect(probe.probeGuest('synthetic-network',fixture.deps)).rejects.toThrow('dependency');}finally{fixture.close();}
  });
  it('persists a private failed fence and repairs it only after a complete trusted apply',async()=>{
    const fixture=await prepared();try{fixture.setFailure('nft -f');await expect(install.installGuest({...fixture.input,apply:true},fixture.deps)).rejects.toThrow('nft_apply');expect(JSON.parse(fixture.io.readFileSync('/etc/patrick-worker/install-state.json','utf8'))).toMatchObject({version:1,status:'failed'});expect(fixture.io.lstatSync('/etc/patrick-worker/install-state.json').mode&0o777).toBe(0o600);fixture.setFailure('');await install.installGuest({...fixture.input,apply:true},fixture.deps);expect(JSON.parse(fixture.io.readFileSync('/etc/patrick-worker/install-state.json','utf8'))).toMatchObject({status:'ready'});}finally{fixture.close();}
  });
  it('keeps serialization locked when stopping a failed apply cannot be verified',async()=>{
    const fixture=await prepared();try{await install.installGuest({...fixture.input,apply:true},fixture.deps);fixture.setActive('inactive');fixture.setFailure('systemctl stop');await expect(install.installGuest({...fixture.input,apply:true},fixture.deps)).rejects.toThrow('service_state');expect(fixture.io.lstatSync('/run/patrick-worker/install.lock').isDirectory()).toBe(true);expect(JSON.parse(fixture.io.readFileSync('/etc/patrick-worker/install-state.json','utf8')).status).toBe('failed');}finally{fixture.close();}
  });
  it('fails check for a stopped proxy while preserving all deny rules and files',async()=>{
    const fixture=await prepared();try{await install.installGuest({...fixture.input,apply:true},fixture.deps);fixture.setActive('inactive');fixture.mutations.length=0;await expect(install.installGuest(fixture.input,fixture.deps)).rejects.toThrow('service_state');expect(fixture.mutations).toEqual([]);expect(fixture.calls.some(call=>call.args.includes('flush'))).toBe(false);}finally{fixture.close();}
  });
  it('rejects a missing or nonready installation fence on a live snapshot',async()=>{
    const fixture=await prepared();try{await install.installGuest({...fixture.input,apply:true},fixture.deps);fs.unlinkSync(fixture.physical('/etc/patrick-worker/install-state.json'));await expect(probe.probeGuest('snapshot',fixture.deps)).rejects.toThrow('installed_mismatch');}finally{fixture.close();}
  });
  it('reports prospective account allocation in check and re-resolves numeric identity under apply',async()=>{
    const fixture=await prepared();try{
      for(const path of ['/etc/passwd','/etc/group','/etc/shadow'])fixture.file(path,fixture.io.readFileSync(path,'utf8').split('\n').filter((line:string)=>!line.startsWith('patrick-dsh:')).join('\n'),path==='/etc/shadow'?0o600:0o644);
      fs.rmdirSync(fixture.physical('/var/lib/patrick-dsh'));
      await install.installGuest(fixture.input,fixture.deps);expect(fixture.summaries.at(-1)).toMatchObject({accountsToCreate:1});expect(fixture.calls.some(call=>call.path==='/usr/sbin/useradd'&&call.args[0]!=='--help')).toBe(false);expect(fixture.mutations).toEqual([]);
      await install.installGuest({...fixture.input,apply:true},fixture.deps);expect(install.readAccounts(fixture.deps).facts['patrick-dsh']).toMatchObject({uid:1001,gid:1001,locked:true,groups:[],home:'/var/lib/patrick-dsh'});expect(fixture.calls.filter(call=>call.path==='/usr/sbin/useradd'&&call.args[0]!=='--help')).toHaveLength(1);
    }finally{fixture.close();}
  });
  it.each(['authorized-key','same-name-group','active-record','active-service'])('refuses %s before mutation',async kind=>{
    const fixture=await prepared();try{
      if(kind==='authorized-key')fixture.file('/var/lib/patrick-grok/.ssh/authorized_keys','fixture key');
      if(kind==='same-name-group'){fixture.file('/etc/passwd',fixture.io.readFileSync('/etc/passwd','utf8').split('\n').filter((line:string)=>!line.startsWith('patrick-dsh:')).join('\n'));fs.rmdirSync(fixture.physical('/var/lib/patrick-dsh'));}
      if(kind==='active-record'){fixture.file('/run/patrick-worker/invocations/fixture','record');fs.chmodSync(fixture.physical('/run/patrick-worker'),0o700);fs.chmodSync(fixture.physical('/run/patrick-worker/invocations'),0o700);}
      if(kind==='active-service'){const original=fixture.deps.run;fixture.deps.run=(path,args,input)=>path==='/usr/bin/systemctl'&&args[0]==='list-units'?{status:0,stdout:'patrick-worker-0123456789abcdef-1.service loaded activating start fixture\n'}:original(path,args,input);}
      await expect(install.installGuest({...fixture.input,apply:true},fixture.deps)).rejects.toThrow();expect(fixture.mutations).toEqual([]);
    }finally{fixture.close();}
  });
  it.each(['stale','wrong-uid','wrong-code','wrong-boot'])('restores only the owned table and rejects %s applying witness',async kind=>{
    const fixture=await prepared();try{await install.installGuest({...fixture.input,apply:true},fixture.deps);const path='/etc/patrick-worker/install-state.json',state=JSON.parse(fixture.io.readFileSync(path,'utf8'));state.status='applying';fixture.file(path,JSON.stringify(state),0o600);fs.mkdirSync(fixture.physical('/run/patrick-worker/install.lock'),{mode:0o700});if(kind==='stale')fixture.file('/proc/5678/stat','5678 (node) '+['S',...Array(18).fill('0'),'9999'].join(' ')+'\n');if(kind==='wrong-uid')fixture.file('/proc/5678/status','Uid:\t1000\t1000\t1000\t1000\n');if(kind==='wrong-code')fixture.file(decodeURI(new URL('../../scripts/lima/install-guest.mjs',import.meta.url).pathname),'other trusted root source');if(kind==='wrong-boot')fixture.file('/proc/sys/kernel/random/boot_id','11111111-1111-4111-8111-111111111111\n');fixture.calls.length=0;await expect(probe.probeGuest('firewall-load',fixture.deps)).rejects.toThrow('service_state');expect(fixture.calls.some(call=>call.path==='/usr/sbin/nft'&&call.args[0]==='-f')).toBe(true);expect(fixture.calls.some(call=>['enable','start'].includes(call.args[0]!))).toBe(false);}finally{fixture.close();}
  });
  it('allows firewall startup for the exact live applying installer only',async()=>{
    const fixture=await prepared();try{await install.installGuest({...fixture.input,apply:true},fixture.deps);const path='/etc/patrick-worker/install-state.json',state=JSON.parse(fixture.io.readFileSync(path,'utf8'));state.status='applying';fixture.file(path,JSON.stringify(state),0o600);fs.mkdirSync(fixture.physical('/run/patrick-worker/install.lock'),{mode:0o700});fixture.file('/run/patrick-worker/install.lock/owner.json',JSON.stringify({version:1,kind:'installer',...state.installer,artifactHash:state.artifactHash,policyHash:state.policyHash}),0o600);await expect(probe.probeGuest('firewall-load',fixture.deps)).resolves.toMatchObject({operation:'firewall-load',outcome:'pass'});await expect(probe.probeGuest('snapshot',fixture.deps)).rejects.toThrow('installed_mismatch');}finally{fixture.close();}
  });
  it('never treats an ownerless applying lock as the live installer lock',async()=>{
    const fixture=await prepared();try{await install.installGuest({...fixture.input,apply:true},fixture.deps);const path='/etc/patrick-worker/install-state.json',state=JSON.parse(fixture.io.readFileSync(path,'utf8'));state.status='applying';fixture.file(path,JSON.stringify(state),0o600);fs.mkdirSync(fixture.physical('/run/patrick-worker/install.lock'),{mode:0o700});await expect(probe.probeGuest('firewall-load',fixture.deps)).rejects.toThrow('service_state');}finally{fixture.close();}
  });
});

// A closed tombstone is control metadata, not active worker work. Construct the
// exact finite persisted shape so the real registry validator is exercised.
describe('concrete lifetime installation handoff',()=>{
 it('takes the same global mutex while observing a quiescent ready snapshot',async()=>{
  const f=await prepared();try{await install.installGuest({...f.input,apply:true},f.deps);const run=f.deps.run;let locked=false;f.deps.run=(path,args,input)=>{if(path==='/usr/sbin/nft'&&args.join(' ')==='-j list table inet patrick_worker'){locked=fs.existsSync(f.physical('/run/patrick-worker/install.lock/owner.json'));if(locked)expect(JSON.parse(f.io.readFileSync('/run/patrick-worker/install.lock/owner.json','utf8')).kind).toBe('probe');}return run(path,args,input);};await probe.probeGuest('snapshot',f.deps);expect(locked).toBe(true);expect(fs.existsSync(f.physical('/run/patrick-worker/install.lock'))).toBe(false);}finally{f.close();}
 });
 it.each(['closed','closed4096','closed4097','active','corrupt'])('handles %s invocation records using the concrete registry',async kind=>{
  const f=await prepared();try{
   await install.installGuest({...f.input,apply:true},f.deps);const invocation='a'.repeat(32),generation='b'.repeat(32),context={runner:'grok',user:'patrick-grok',projectId:'fixture',domain:'personal'};
   const stage=(purpose:string,sequence:number)=>({stage:purpose,profile:'task-only',sequence,unit:`patrick-worker-${generation}-${sequence}.service`,description:`patrick-worker:${generation}:${invocation}:${sequence}`,phase:'complete',invocationId:'c'.repeat(32),controlGroup:`/system.slice/patrick-worker-${generation}-${sequence}.service`,submission:null,submitterExited:true,code:0});
   const record={version:2,kind:'registered',authorityId:JSON.parse(f.io.readFileSync('/etc/patrick-worker/manifest.json','utf8')).installation.registry.authorityId,bootRevocation:null,invocation,context,identity:{uid:1101,gid:1101,home:'/var/lib/patrick-grok'},admission:{policyHash:'d'.repeat(64),artifactHash:'e'.repeat(64),proxyPort:18743},boot:'01234567-89ab-4cde-8fab-0123456789ab',generation,state:kind==='active'?'active':'closed',payloadSealed:kind!=='active',cleanupConsumed:true,sequence:2,stages:[stage('prepare',1),stage('cleanup',2)],layout:{root:'/var/lib/patrick-workspaces/'+invocation,path:'/var/lib/patrick-workspaces/'+invocation+'/work',rootIno:1,workIno:2,status:'removed'},baseline:{workerProcessesAbsent:true,privateMountsAbsent:true,cgroupsEmpty:true},drain:{generation,sequence:1},cleanupConfirmed:true};
   f.file('/var/lib/patrick-worker/invocations/'+invocation+'.json',kind==='corrupt'?'{}':JSON.stringify(record),0o600);if(kind==='closed4096'||kind==='closed4097')for(let n=1;n<(kind==='closed4096'?4096:4097);n++){
    const r=structuredClone(record);r.invocation=n.toString(16).padStart(32,'0');r.generation=r.invocation;r.drain.generation=r.generation;r.layout.root='/var/lib/patrick-workspaces/'+r.invocation;r.layout.path=r.layout.root+'/work';
    for(const s of r.stages){s.unit=`patrick-worker-${r.generation}-${s.sequence}.service`;s.description=`patrick-worker:${r.generation}:${r.invocation}:${s.sequence}`;s.controlGroup='/system.slice/'+s.unit;}
    f.file('/var/lib/patrick-worker/invocations/'+r.invocation+'.json',JSON.stringify(r),0o600);
   }f.mutations.length=0;
   if(kind.startsWith('closed')){await expect(install.installGuest(f.input,f.deps)).resolves.toMatchObject({applied:false});await expect(probe.probeGuest('snapshot',f.deps)).resolves.toMatchObject({outcome:'pass'});}else{await expect(install.installGuest({...f.input,apply:true},f.deps)).rejects.toThrow('active_worker');await expect(probe.probeGuest('snapshot',f.deps)).rejects.toThrow('active_worker');}expect(f.mutations.filter((event:string)=>!event.includes('/run/patrick-worker/install.lock')&&!/^write:\d+$/.test(event))).toEqual([]);
  }finally{f.close();}
 });
});

describe('finite root synthetic qualification session',()=>{
 it.each(['valid',...malformedQualificationSessionCases] as const)('reads %s private session through the actual probe without malformed-session mutation',async kind=>{
  const f=await prepared();try{
   await install.installGuest({...f.input,apply:true},f.deps);await probe.probeGuest('qualification-start',f.deps);
   const path='/etc/patrick-worker/qualification.json',session=JSON.parse(f.io.readFileSync(path,'utf8'));
   addCompletedQualificationNetworkOperation(session);
   if(kind!=='valid')corruptQualificationSession(session,kind);
   const bytes=JSON.stringify(session)+'\n';f.file(path,bytes,0o600);f.mutations.length=0;
   if(kind==='valid'){await expect(probe.probeGuest('qualification-finish',f.deps)).resolves.toMatchObject({outcome:'pass',sessionActive:false});expect(fs.existsSync(f.physical(path))).toBe(false);}
   else {await expect(probe.probeGuest('qualification-finish',f.deps)).rejects.toThrow('installed_mismatch');expect(f.io.readFileSync(path,'utf8')).toBe(bytes);expect(f.mutations.filter(change=>change.includes('qualification.json')||change.includes('.patrick-synthetic-'))).toEqual([]);for(const b of session.bindings)for(const name of ['.patrick-synthetic-auth','.patrick-synthetic-config'])expect(f.io.readFileSync(b.home+'/'+name,'utf8')).toBe(`patrick-synthetic:${name}\n`);}
  }finally{f.close();}
 });
 it('binds verified installed identities and exclusive synthetic markers, then removes only owned state',async()=>{
  const f=await prepared();try{await install.installGuest({...f.input,apply:true},f.deps);
   const control=await probe.probeGuest('qualification',f.deps);expect(control).toMatchObject({operation:'qualification',outcome:'pass',synthetic:true,sessionActive:false});expect(control.bindings.map((b:any)=>b.runner)).toEqual(['grok','codex','dsh']);
   const started=await probe.probeGuest('qualification-start',f.deps);expect(started.sessionActive).toBe(true);
   for(const name of ['.patrick-synthetic-auth','.patrick-synthetic-config'])expect(f.io.lstatSync('/var/lib/patrick-grok/'+name)).toMatchObject({uid:0});
   await expect(probe.probeGuest('qualification-start',f.deps)).rejects.toThrow();
   const finished=await probe.probeGuest('qualification-finish',f.deps);expect(finished).toMatchObject({outcome:'pass',sessionActive:false});expect(fs.existsSync(f.physical('/var/lib/patrick-grok/.patrick-synthetic-auth'))).toBe(false);
  }finally{f.close();}
 });
 it('does not clobber a preexisting synthetic basename or remove a substituted marker',async()=>{
  const f=await prepared();try{await install.installGuest({...f.input,apply:true},f.deps);f.file('/var/lib/patrick-grok/.patrick-synthetic-auth','unrelated');await expect(probe.probeGuest('qualification-start',f.deps)).rejects.toThrow();expect(f.io.readFileSync('/var/lib/patrick-grok/.patrick-synthetic-auth','utf8')).toBe('unrelated');fs.unlinkSync(f.physical('/var/lib/patrick-grok/.patrick-synthetic-auth'));
   await probe.probeGuest('qualification-start',f.deps);fs.unlinkSync(f.physical('/var/lib/patrick-grok/.patrick-synthetic-auth'));f.file('/var/lib/patrick-grok/.patrick-synthetic-auth','substituted',0o444);await expect(probe.probeGuest('qualification-finish',f.deps)).rejects.toThrow();expect(f.io.readFileSync('/var/lib/patrick-grok/.patrick-synthetic-auth','utf8')).toBe('substituted');
  }finally{f.close();}
 });
});

it('recovers only exact durable synthetic markers through proxy and inventory admission drift',async()=>{
 const f=await prepared();try{await install.installGuest({...f.input,apply:true},f.deps);await probe.probeGuest('qualification-start',f.deps);f.setActive('inactive');(f.deps as any).now=()=>Date.parse('2030-01-01T00:00:00Z');
  await expect(probe.probeGuest('qualification',f.deps)).rejects.toThrow();await expect(probe.probeGuest('qualification-finish',f.deps)).resolves.toMatchObject({outcome:'pass',sessionActive:false});expect(fs.existsSync(f.physical('/var/lib/patrick-grok/.patrick-synthetic-auth'))).toBe(false);
 }finally{f.close();}
});

it('retains durable marker ownership across a missing runtime registry',async()=>{
 const f=await prepared();try{await install.installGuest({...f.input,apply:true},f.deps);await probe.probeGuest('qualification-start',f.deps);
  fs.rmSync(f.physical('/run/patrick-worker'),{recursive:true,force:true});await expect(probe.probeGuest('qualification-finish',f.deps)).resolves.toMatchObject({outcome:'pass'});
 }finally{f.close();}
});

it('resumes only a durably intended exact synthetic-marker removal after an interruption',async()=>{
 const f=await prepared();try{await install.installGuest({...f.input,apply:true},f.deps);await probe.probeGuest('qualification-start',f.deps);const unlink=f.io.unlinkSync;let injected=false;f.io.unlinkSync=(path:string)=>{if(!injected&&path==='/var/lib/patrick-grok/.patrick-synthetic-config'){injected=true;throw Error('synthetic interrupted unlink');}return unlink(path);};await expect(probe.probeGuest('qualification-finish',f.deps)).rejects.toThrow();f.io.unlinkSync=unlink;expect(fs.existsSync(f.physical('/var/lib/patrick-grok/.patrick-synthetic-auth'))).toBe(false);await expect(probe.probeGuest('qualification-finish',f.deps)).resolves.toMatchObject({outcome:'pass'});
 }finally{f.close();}
});


describe('durable first-install identity and recovery',()=>{
 it('binds a first installation and refuses lost identity before mutation',async()=>{
  const f=await prepared();try{
   await install.installGuest({...f.input,apply:true},f.deps);
   const before=f.io.readFileSync('/etc/patrick-worker/manifest.json','utf8'),reference=JSON.parse(before).installation.registry;
   const lifetime=await import(new URL('../../scripts/lima/stage-lifetime.mjs',import.meta.url).href);
   expect(reference).toBeDefined();expect(lifetime.readRegistryAuthority(f.io,reference).authorityId).toBe(reference.authorityId);
   f.io.unlinkSync('/etc/patrick-worker/registry-identity.json');f.mutations.length=0;
   await expect(install.installGuest({...f.input,apply:true},f.deps)).rejects.toThrow('installed_mismatch');
   expect(f.mutations).toEqual([]);expect(f.io.readFileSync('/etc/patrick-worker/manifest.json','utf8')).toBe(before);
  }finally{f.close();}
 });
 it('recovers record authority without inventory, readiness or runtime',async()=>{
  const f=await prepared();try{
   await install.installGuest({...f.input,apply:true},f.deps);const before=f.io.readFileSync('/etc/patrick-worker/manifest.json','utf8');
   fs.rmSync(f.physical('/run/patrick-worker'),{recursive:true});f.deps.now=()=>Date.parse('2030-01-01T00:00:00Z');f.setFailure('nft');f.calls.length=0;f.mutations.length=0;
   const state=await install.inspectRecordAuthority(f.deps);expect(state.registry.authorityId).toBe(JSON.parse(before).installation.registry.authorityId);
   expect(f.calls.every(c=>!['/usr/sbin/ip','/usr/sbin/nft','/usr/bin/journalctl','/usr/bin/systemctl'].includes(c.path))).toBe(true);expect(f.mutations).toEqual([]);
  }finally{f.close();}
 });
 it.each(['/usr/sbin/visudo','/usr/bin/sudo'].flatMap(path=>['writable','owner','symlink-owner','target-ancestor'].map(kind=>({path,kind}))))('refuses recovery audit $path with $kind trust before execution',async({path,kind})=>{
  const f=await prepared();try{
   await install.installGuest({...f.input,apply:true},f.deps);
   if(kind==='writable')fs.chmodSync(f.physical(path),0o777);
   if(kind==='owner')f.owners.set(path,{uid:1101,gid:1101});
   if(kind==='symlink-owner'||kind==='target-ancestor'){
    const target='/opt/audit-fixture/'+path.split('/').at(-1);f.file(target,'fixture executable',0o755);fs.unlinkSync(f.physical(path));fs.symlinkSync(f.physical(target),f.physical(path));
    if(kind==='symlink-owner')f.owners.set(path,{uid:1101,gid:1101});else fs.chmodSync(f.physical('/opt/audit-fixture'),0o777);
   }
   f.calls.length=0;f.mutations.length=0;
   const refusal=await install.inspectRecordAuthority(f.deps).then(()=>null,(error:unknown)=>error);
   expect(f.calls.filter(call=>call.path===path)).toEqual([]);expect(refusal).toMatchObject({reason:'dependency'});expect(f.mutations).toEqual([]);
  }finally{f.close();}
 });
 it('does not erase session markers when its canonical record is missing',async()=>{
  const f=await prepared();try{
   await install.installGuest({...f.input,apply:true},f.deps);await probe.probeGuest('qualification-start',f.deps);
   const path='/etc/patrick-worker/qualification.json',session=JSON.parse(f.io.readFileSync(path,'utf8'));session.records=['a'.repeat(32)];f.file(path,JSON.stringify(session),0o600);
   await expect(probe.probeGuest('qualification-finish',f.deps)).rejects.toThrow();expect(fs.existsSync(f.physical('/var/lib/patrick-grok/.patrick-synthetic-auth'))).toBe(true);
  }finally{f.close();}
 });
});


describe('first-bootstrap finite crash dispositions',()=>{
 it.each(['fence','witness-link','initializing','durable-mkdir','registry-mkdir','marker-link','ready','published-file','manifest','ready-fence'])('preserves %s interruption without resetting identity',async window=>{
  const f=await prepared();try{
   const open=f.io.openSync,rename=f.io.renameSync,link=f.io.linkSync,mkdir=f.io.mkdirSync;let tripped=false;
   const trip=()=>{tripped=true;throw Error('crash '+window);};
   f.io.openSync=(path:string,...args:any[])=>{if(!tripped&&window==='fence'&&path.startsWith('/etc/patrick-worker/install-state.json.tmp-'))trip();return open(path,...args);};
   f.io.linkSync=(from:string,to:string)=>{link(from,to);if(!tripped&&(window==='witness-link'&&to.endsWith('/registry-identity.json')||window==='marker-link'&&to.endsWith('/.authority.json')))trip();};
   f.io.mkdirSync=(path:string,...args:any[])=>{const result=mkdir(path,...args);if(!tripped&&(window==='durable-mkdir'&&path==='/var/lib/patrick-worker'||window==='registry-mkdir'&&path==='/var/lib/patrick-worker/invocations'))trip();return result;};
   f.io.renameSync=(from:string,to:string)=>{rename(from,to);if(!tripped&&(window==='initializing'&&to.endsWith('/install-state.json')||window==='ready'&&to.endsWith('/registry-identity.json')||window==='published-file'&&to==='/usr/local/libexec/patrick-worker/worker-enter.mjs'||window==='manifest'&&to.endsWith('/manifest.json')||window==='ready-fence'&&to.endsWith('/install-state.json')&&JSON.parse(f.io.readFileSync(to,'utf8')).status==='ready'))trip();};
   await expect(install.installGuest({...f.input,apply:true},f.deps)).rejects.toThrow();expect(tripped).toBe(true);
   f.io.openSync=open;f.io.renameSync=rename;f.io.linkSync=link;f.io.mkdirSync=mkdir;
   const witnessPath='/etc/patrick-worker/registry-identity.json',before=fs.existsSync(f.physical(witnessPath))?f.io.readFileSync(witnessPath):undefined;
   f.mutations.length=0;
   if(['ready','manifest','ready-fence'].includes(window)){
    // A ready-only identity retries before installed code/firewall publication;
    // a complete manifest resumes the ordinary matching-generation path.
    await expect(install.installGuest({...f.input,apply:true},f.deps)).resolves.toMatchObject({applied:true});
   }else{await expect(install.installGuest({...f.input,apply:true},f.deps)).rejects.toThrow('installed_mismatch');expect(f.mutations).toEqual([]);}
   if(before)expect(f.io.readFileSync(witnessPath)).toEqual(before);
  }finally{f.close();}
 });
 it.each(['witness','marker','root','records','reference','legacy-manifest','initializing','substituted-records','substituted-marker','coexisting-legacy'])('refuses lost or substituted %s before mutation',async kind=>{
  const f=await prepared();try{
   await install.installGuest({...f.input,apply:true},f.deps);const witnessPath='/etc/patrick-worker/registry-identity.json',root='/var/lib/patrick-worker',records=root+'/invocations',marker=records+'/.authority.json';
   if(kind==='witness')f.io.unlinkSync(witnessPath);if(kind==='marker')f.io.unlinkSync(marker);if(kind==='root')fs.renameSync(f.physical(root),f.physical(root+'.saved'));if(kind==='records')fs.renameSync(f.physical(records),f.physical(records+'.saved'));
   if(kind==='reference'||kind==='legacy-manifest'){const m=JSON.parse(f.io.readFileSync('/etc/patrick-worker/manifest.json','utf8'));if(kind==='reference')m.installation.registry.witnessHash='0'.repeat(64);else delete m.installation.registry;f.file('/etc/patrick-worker/manifest.json',JSON.stringify(m));}
   if(kind==='initializing'){const lifetime=await import(new URL('../../scripts/lima/stage-lifetime.mjs',import.meta.url).href),w=JSON.parse(f.io.readFileSync(witnessPath,'utf8'));f.file(witnessPath,lifetime.encodeRegistryMetadata({...w,phase:'initializing',root:null,records:null,marker:null}).toString(),0o600);}
   if(kind==='substituted-records'){fs.renameSync(f.physical(records),f.physical(records+'.saved'));fs.mkdirSync(f.physical(records),{mode:0o700});fs.copyFileSync(f.physical(records+'.saved/.authority.json'),f.physical(marker));}
   if(kind==='substituted-marker'){fs.renameSync(f.physical(marker),f.physical(marker+'.saved'));fs.copyFileSync(f.physical(marker+'.saved'),f.physical(marker));}
   if(kind==='coexisting-legacy'){fs.mkdirSync(f.physical('/run/patrick-worker/invocations'),{mode:0o700});f.file('/run/patrick-worker/invocations/'+ 'a'.repeat(32)+'.json','{"version":1,"state":"closed"}',0o600);}
   f.mutations.length=0;for(const apply of [false,true])await expect(install.installGuest({...f.input,apply},f.deps)).rejects.toThrow('installed_mismatch');expect(f.mutations).toEqual([]);
  }finally{f.close();}
 });
 it.each(['active','closed'])('preserves nonempty legacy %s bytes in check and apply',async state=>{
  const f=await prepared();try{const path='/run/patrick-worker/invocations/'+ 'a'.repeat(32)+'.json',bytes=JSON.stringify({version:1,state});f.file(path,bytes,0o600);fs.chmodSync(f.physical('/run/patrick-worker'),0o700);fs.chmodSync(f.physical('/run/patrick-worker/invocations'),0o700);f.mutations.length=0;for(const apply of [false,true])await expect(install.installGuest({...f.input,apply},f.deps)).rejects.toThrow('installed_mismatch');expect(f.io.readFileSync(path,'utf8')).toBe(bytes);expect(f.mutations).toEqual([]);}finally{f.close();}
 });
 it('retains the install mutex if its durable owner publication fails',async()=>{
  const f=await prepared();try{const open=f.io.openSync;f.io.openSync=(path:string,...args:any[])=>{if(path.startsWith('/run/patrick-worker/install.lock/owner.json.tmp-'))throw Error('owner unavailable');return open(path,...args);};await expect(install.installGuest({...f.input,apply:true},f.deps)).rejects.toThrow('service_state');expect(fs.existsSync(f.physical('/run/patrick-worker/install.lock'))).toBe(true);expect(fs.existsSync(f.physical('/etc/patrick-worker/registry-identity.json'))).toBe(false);}finally{f.close();}
 });
 it.each(['workspace','mount','home-alias'])('refuses pristine residual %s before any mutation',async kind=>{
  const f=await prepared();try{if(kind==='workspace')f.file('/var/lib/patrick-workspaces/foreign','residual');else if(kind==='mount')f.file('/proc/self/mountinfo','1 0 0:1 / /var/lib/patrick-grok rw - ext4 /dev/root rw\n');else f.file('/proc/self/mountinfo','1 0 0:1 / / rw - ext4 /dev/root rw\n2 1 0:1 /var/lib/patrick-grok /mnt/home-alias rw - ext4 /dev/root rw\n');f.mutations.length=0;await expect(install.installGuest({...f.input,apply:true},f.deps)).rejects.toThrow();expect(f.mutations).toEqual([]);}finally{f.close();}
 });
});


it.each(['target-artifact','target-policy','missing-fence','empty-code','owned-nft','unknown-config'])('refuses ready-first-apply retry with %s before mutation',async kind=>{
 const f=await prepared();try{
  const rename=f.io.renameSync;let interrupted=false;f.io.renameSync=(from:string,to:string)=>{rename(from,to);if(!interrupted&&to==='/etc/patrick-worker/registry-identity.json'){interrupted=true;throw Error('ready-only crash');}};
  await expect(install.installGuest({...f.input,apply:true},f.deps)).rejects.toThrow();f.io.renameSync=rename;expect(interrupted).toBe(true);
  if(kind==='target-artifact'){const name='synthetic-worker.mjs',text=f.contents[name]+'\n// next reviewed target\n';f.file('/stage/'+name,text);f.manifest.files[name]=hash(text);f.file('/stage/manifest.json',JSON.stringify(f.manifest));}
  if(kind==='target-policy'){const text=JSON.stringify({...policy,workers:policy.workers.map(w=>({...w,domain:'changed'}))});f.file('/policy-input',text);f.manifest.policyHash=hash(text);f.file('/stage/manifest.json',JSON.stringify(f.manifest));}
  if(kind==='missing-fence')f.io.unlinkSync('/etc/patrick-worker/install-state.json');
  if(kind==='empty-code')fs.mkdirSync(f.physical(install.CODE),{mode:0o755});
  if(kind==='owned-nft')f.setNft(f.kernelNft());if(kind==='unknown-config')f.file('/etc/patrick-worker/unowned','preserve');
  const before=f.io.readFileSync('/etc/patrick-worker/registry-identity.json');f.mutations.length=0;
  for(const apply of [false,true])await expect(install.installGuest({...f.input,apply},f.deps)).rejects.toThrow('installed_mismatch');expect(f.mutations).toEqual([]);expect(f.io.readFileSync('/etc/patrick-worker/registry-identity.json')).toEqual(before);
 }finally{f.close();}
});


it('uses real installed record authority for current and withdrawn recovery tuples',async()=>{
 const f=await prepared();try{
  await install.installGuest({...f.input,apply:true},f.deps);const state=await install.inspectRecordAuthority(f.deps),context={runner:'grok',user:'patrick-grok',projectId:'fixture',domain:'personal'};
  const binding=state.modules.recoveryBinding(context,state);expect(binding).toEqual({registry:state.manifest.installation.registry,identity:state.accounts[context.user],cancellationBinding:{policyHash:state.manifest.installation.policyHash,artifactHash:state.manifest.installation.artifactHash}});
  expect(state.modules.recoveryBinding({...context,domain:'withdrawn'},state)).toMatchObject({registry:binding.registry,identity:binding.identity,cancellationBinding:null});
  const recover=async()=>binding,production=state.modules.productionLifetimeDependencies({trust:()=>{},identity:()=>binding.identity,admit:async()=>{throw Error('payload unavailable');},recover});expect(production.recover).toBe(recover);
  fs.unlinkSync(f.physical('/etc/patrick-worker/install-state.json'));f.setActive('inactive');await expect(install.inspectRecordAuthority(f.deps)).resolves.toMatchObject({registry:state.registry});
 }finally{f.close();}
});


it('passes the exact current-process runtime dependency seam to existing apply recovery',async()=>{
 const f=await prepared();try{
  await install.installGuest({...f.input,apply:true},f.deps);const path='/etc/patrick-worker/install-state.json',state=JSON.parse(f.io.readFileSync(path,'utf8'));f.file(path,JSON.stringify({...state,status:'failed'}),0o600);
  const load=f.deps.loadModules;let keys:string[]=[];f.deps.loadModules=async()=>{const modules=await load();return {...modules,ensureRuntimeBase:(runtime:any,reference:any)=>{keys=Object.keys(runtime).sort();expect(runtime.boot()).toBe('01234567-89ab-4cde-8fab-0123456789ab');expect(runtime.witness()).toEqual({pid:5678,start:'12345'});return modules.ensureRuntimeBase(runtime,reference);}};};
  await expect(install.installGuest({...f.input,apply:true},f.deps)).resolves.toMatchObject({applied:true});expect(keys).toEqual(['boot','io','witness']);
 }finally{f.close();}
});


it('preserves confined path mapping, fresh stat identity and descriptor ownership without metadata caching',()=>{
 const f=filesystemFixture();try{
  for(const path of ['/','/safe','/safe/','//safe','/safe//leaf','/safe/./leaf','/safe/.','/safe/....','/safe/..literal','/目标/😀/file','/safe/\uFEFFfile'])expect(f.physical(path)).toBe(join(f.physical('/'),path));
  for(const path of ['', 'relative','/safe/../outside','/../outside','/safe/\0leaf'])expect(()=>f.physical(path)).toThrow('outside fixture');
  f.file('/safe/file','first',0o600);f.io.chownSync('/safe/file',1101,1102);const first=f.io.lstatSync('/safe/file'),second=f.io.lstatSync('/safe/file');expect(first).not.toBe(second);expect(first).toMatchObject({uid:1101,gid:1102,nlink:1,size:5});expect(first.ino).toBe(second.ino);
  const fd=f.io.openSync('/safe/file',fs.constants.O_RDONLY);try{f.io.chownSync('/safe/file',1201,1202);expect(f.io.fstatSync(fd)).toMatchObject({uid:1101,gid:1102});expect(f.io.lstatSync('/safe/file')).toMatchObject({uid:1201,gid:1202});f.file('/safe/file','changed',0o600);expect(f.io.fstatSync(fd).size).toBe(7);expect(first.size).toBe(5);}finally{f.io.closeSync(fd);}
  fs.symlinkSync('file',f.physical('/safe/link'));expect(f.io.lstatSync('/safe/link').isSymbolicLink()).toBe(true);expect(()=>install.trustedPath('/safe/link',{},f.io)).toThrow('untrusted_artifact');
 }finally{f.close();}
});


it.each(['authority','target'])('refuses an under-mutex %s change without stopping the proxy or publishing a fence',async kind=>{
 const f=await prepared();try{
  if(kind==='authority'){await install.installGuest({...f.input,apply:true},f.deps);const path='/etc/patrick-worker/install-state.json',state=JSON.parse(f.io.readFileSync(path,'utf8'));f.file(path,JSON.stringify({...state,status:'failed'}),0o600);}
  const before=kind==='authority'?f.io.readFileSync('/etc/patrick-worker/install-state.json'):undefined,rename=f.io.renameSync,lstat=f.io.lstatSync;let changed=false;
  f.io.renameSync=(from:string,to:string)=>{rename(from,to);if(!changed&&to==='/run/patrick-worker/install.lock/owner.json'){changed=true;if(kind==='target'){const name='synthetic-worker.mjs',text=f.contents[name]+'\n// changed target under lock\n';f.file('/stage/'+name,text);f.manifest.files[name]=hash(text);f.file('/stage/manifest.json',JSON.stringify(f.manifest));}}};
  f.io.lstatSync=(path:string)=>{const value=lstat(path);return changed&&kind==='authority'&&path==='/var/lib/patrick-worker'?Object.assign(Object.create(value),{ino:value.ino+1}):value;};
  f.calls.length=0;f.mutations.length=0;await expect(install.installGuest({...f.input,apply:true},f.deps)).rejects.toThrow('installed_mismatch');expect(changed).toBe(true);
  expect(f.calls.filter(c=>c.path==='/usr/bin/systemctl'&&c.args[0]==='stop'||c.path==='/usr/sbin/nft'&&c.args[0]==='-f')).toEqual([]);expect(fs.existsSync(f.physical('/run/patrick-worker/install.lock'))).toBe(false);
  if(before)expect(f.io.readFileSync('/etc/patrick-worker/install-state.json')).toEqual(before);else expect(fs.existsSync(f.physical('/etc/patrick-worker/install-state.json'))).toBe(false);
 }finally{f.close();}
});
