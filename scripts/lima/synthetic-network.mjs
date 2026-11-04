// First-party isolated fixture only. No CLI, environment switch or module-load
// side effects. The public root probe verifies all installed hashes first.
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const CODE='/usr/local/libexec/patrick-worker',address='93.184.216.34';
const fail=(reason='dependency')=>{throw Object.assign(new Error(reason),{reason});};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

async function upstreamProgram(configuration) {
 const fs=await import('node:fs'),net=await import('node:net');const byte=Buffer.alloc(1);let line='';while(line.length<64){if(fs.readSync(0,byte,0,1,null)!==1)process.exit(78);line+=byte.toString();if(byte[0]===10)break;}if(line!=='network-release\n')process.exit(78);
 let upstream=0,closing=false;const sockets=new Set(),settled=[];
 const track=socket=>{sockets.add(socket);settled.push(new Promise(resolve=>socket.once('close',()=>{sockets.delete(socket);resolve();})));socket.on('error',()=>{});if(closing)socket.destroy();};
 const server=net.createServer(socket=>{upstream++;process.stdout.write(JSON.stringify({upstream})+'\n');track(socket);socket.once('data',()=>socket.end('synthetic-upstream-ok'));}),other=net.createServer(socket=>{track(socket);socket.end();});
 const listen=(server,port,host)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen({host,port,exclusive:true},resolve);});
 try{await listen(server,24443,configuration.address);await listen(other,24444,'127.0.0.1');process.stdout.write('{"ready":true}\n');process.once('SIGTERM',()=>{closing=true;void(async()=>{const stopped=[server,other].map(server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())));for(const socket of sockets)socket.destroy();await Promise.all(stopped);await Promise.all(settled);await new Promise((resolve,reject)=>process.stdout.write(JSON.stringify({final:upstream})+'\n',error=>error?reject(error):resolve()));})().catch(()=>process.exit(78));});}catch{process.exit(78);}
}
async function proxyProgram(configuration) {
 const fs=await import('node:fs'),net=await import('node:net');
 const byte=Buffer.alloc(1);let line='';while(line.length<64){if(fs.readSync(0,byte,0,1,null)!==1)process.exit(78);line+=byte.toString();if(byte[0]===10)break;}if(line!=='network-release\n')process.exit(78);
 const {createProxy}=await import('/usr/local/libexec/patrick-worker/connect-proxy.mjs');const counts={},sockets=new Set(),settled=[];
 const track=socket=>{sockets.add(socket);settled.push(new Promise(resolve=>socket.once('close',()=>{sockets.delete(socket);resolve();})));return socket;};
 try{const proxy=createProxy(configuration.policy,{serverFactory:accept=>net.createServer({allowHalfOpen:true},socket=>accept(track(socket))),lookup:async()=>[configuration.address],connect:(selected,port)=>{if(selected!==configuration.address||port!==443)throw Error('fixture');return track(net.createConnection({host:selected,port:24443,allowHalfOpen:true}));},report:(reason,count)=>{counts[reason]=count;process.stdout.write(JSON.stringify({counts:{...counts}})+'\n');}});await proxy.start();process.stdout.write('{"ready":true}\n');process.once('SIGTERM',()=>{void(async()=>{await proxy.close();for(const socket of sockets)socket.destroy();await Promise.all(settled);await new Promise((resolve,reject)=>process.stdout.write(JSON.stringify({final:{...counts}})+'\n',error=>error?reject(error):resolve()));})().catch(()=>process.exit(78));});}catch{process.exit(78);}
}
async function clientProgram(configuration) {
 const fs=await import('node:fs'),net=await import('node:net');
 const byte=Buffer.alloc(1);let line='';while(line.length<64){if(fs.readSync(0,byte,0,1,null)!==1)process.exit(78);line+=byte.toString();if(byte[0]===10)break;}if(line!=='network-release\n')process.exit(78);
 const u16=n=>Buffer.from([n>>8,n&255]);
 const hello=(host,ech=false)=>{const name=Buffer.from(host),list=Buffer.concat([Buffer.from([0]),u16(name.length),name]),sni=Buffer.concat([u16(0),u16(list.length+2),u16(list.length),list]),extensions=Buffer.concat([sni,...(ech?[Buffer.from([0xfe,0x0d,0,1,0])]:[])]),body=Buffer.concat([Buffer.from([3,3]),Buffer.alloc(32,0x42),Buffer.from([0]),u16(2),Buffer.from([0x13,1,1,0]),u16(extensions.length),extensions]),handshake=Buffer.concat([Buffer.from([1,body.length>>16,body.length>>8&255,body.length&255]),body]);return Buffer.concat([Buffer.from([22,3,3]),u16(handshake.length),handshake]);};
 const request=authority=>`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`;
 async function through(authority,kind){return new Promise(resolve=>{const socket=net.createConnection({host:'127.0.0.1',port:configuration.port});let connected=false,header=false,data='',done=false;const finish=value=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();resolve(value);};const timer=setTimeout(()=>finish(false),1000);socket.on('error',()=>finish(false));socket.on('connect',()=>{connected=true;socket.write(request(authority));});socket.on('data',chunk=>{data+=chunk.toString();if(data.length>8192)return finish(false);if(!header&&data==='HTTP/1.1 200 Connection Established\r\n\r\n'){header=true;data='';if(kind==='header')return finish(false);socket.write(hello(kind==='sni'?'wrong.patrick.invalid':'synthetic.patrick.invalid',kind==='ech'));}else if(header&&kind==='positive'&&data==='synthetic-upstream-ok')finish(true);});socket.on('close',()=>finish(connected&&(kind==='header'?!header&&data==='':(kind==='sni'||kind==='ech')&&header&&data==='')));});}
 async function denied(port,host){return new Promise(resolve=>{const socket=net.createConnection({host,port}),timer=setTimeout(()=>{socket.destroy();resolve(false);},1000);socket.once('connect',()=>{clearTimeout(timer);socket.destroy();resolve(false);});socket.once('error',error=>{clearTimeout(timer);resolve(['EACCES','EPERM'].includes(error.code));});});}
 try{
  let positive=0,proxyDenials=0,firewallDenials=0;
  if(configuration.runner==='grok'){
   if(!await through('synthetic.patrick.invalid:443','positive'))process.exit(78);positive++;
   for(const authority of ['disallowed.patrick.invalid:443','synthetic.patrick.invalid:444',configuration.address+':443']){if(!await through(authority,'header'))process.exit(78);proxyDenials++;}
   for(const kind of ['sni','ech']){if(!await through('synthetic.patrick.invalid:443',kind))process.exit(78);proxyDenials++;}
  }else{if(!await through('synthetic.patrick.invalid:443','header'))process.exit(78);proxyDenials++;}
  for(const [port,host]of [[24443,configuration.address],[24444,'127.0.0.1'],[443,'::1'],...configuration.otherPorts.map(port=>[port,'127.0.0.1'])]){if(!await denied(port,host))process.exit(78);firewallDenials++;}
  process.stdout.write(JSON.stringify({positive,proxyDenials,firewallDenials})+'\n');
 }catch{process.exit(78);}
}
async function coordinator(configuration) {
 const fs=await import('node:fs'),cp=await import('node:child_process');
 const ENV={PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C'},children=[],deadline=setTimeout(()=>process.exit(78),15000);
 const run=(path,args,input)=>{const r=cp.spawnSync(path,args,{input,encoding:'utf8',timeout:2000,maxBuffer:1048576,cwd:'/',env:ENV});if(r.error||r.signal||r.status!==0)throw Error('fixture');return r.stdout;};
 const readGate=async(child,identity,expected)=>{const end=Date.now()+2000;let witness;do{try{const base='/proc/'+child.pid,status=fs.readFileSync(base+'/status','utf8'),row=key=>{const a=status.split('\n').filter(l=>l.startsWith(key+':'));if(a.length!==1)throw 0;return a[0].slice(key.length+1).trim();};const raw=fs.readFileSync(base+'/stat','utf8'),start=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/)[19];if(!/^[1-9]\d{0,19}$/.test(start)||witness&&witness!==start)throw 0;witness=start;const cmd=fs.readFileSync(base+'/cmdline','utf8').split('\0');cmd.pop();if(JSON.stringify(cmd)!==JSON.stringify(expected))throw 0;if(row('Uid').split(/\s+/).length!==4||row('Gid').split(/\s+/).length!==4||row('Uid').split(/\s+/).some(v=>!/^\d+$/.test(v)||Number(v)!==identity.uid)||row('Gid').split(/\s+/).some(v=>!/^\d+$/.test(v)||Number(v)!==identity.gid)||row('Groups')!==''||row('NoNewPrivs')!=='1'||['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].some(k=>!/^0{1,16}$/.test(row(k)))||fs.realpathSync(base+'/exe')!==fs.realpathSync('/usr/local/bin/node')||fs.readlinkSync(base+'/ns/net')!==fs.readlinkSync('/proc/self/ns/net'))throw 0;return;}catch{}await new Promise(r=>setTimeout(r,5));}while(Date.now()<end);throw Error('fixture');};
 const finished=child=>new Promise(resolve=>{child.once('error',()=>resolve(false));child.once('close',(code,signal)=>resolve(code===0&&!signal));});
 const start=async(identity,program,data)=>{
  const {buildDropInvocation}=await import('/usr/local/libexec/patrick-worker/stage-lifetime.mjs');
  const payload=['/usr/local/bin/node','--input-type=module','-e',`(${program})(${JSON.stringify(data)}).catch(()=>process.exit(78));`],drop=buildDropInvocation({...identity,user:identity.user,proxyPort:data.port??18743,command:payload});
  const child=cp.spawn(drop.command,drop.args,{cwd:'/',env:ENV,stdio:['pipe','pipe','pipe']});children.push(child);const completion=finished(child);let stdout='',stderr=0,invalid=false;child.stdin.on('error',()=>{});child.stdout.on('data',c=>{stdout+=c;if(Buffer.byteLength(stdout)>65536){invalid=true;child.kill('SIGKILL');}});child.stderr.on('data',c=>{stderr+=c.length;if(stderr>65536){invalid=true;child.kill('SIGKILL');}});await readGate(child,identity,payload);child.stdin.end('network-release\n');return {child,completion:completion.then(success=>success&&!invalid),output:()=>stdout};
 };
 try{
  run('/usr/sbin/ip',['link','set','lo','up']);run('/usr/sbin/ip',['address','add',configuration.address+'/32','dev','lo']);
  const links=JSON.parse(run('/usr/sbin/ip',['-j','link','show']));if(links.length!==1||links[0].ifname!=='lo')throw 0;
  run('/usr/sbin/nft',['-c','-f','-'],configuration.nftText);run('/usr/sbin/nft',['-f','-'],configuration.nftText);
  const {assertReadiness,parseProxyFacts}=await import('/usr/local/libexec/patrick-worker/worker-enter.mjs');
  const proxyIdentity={user:configuration.policy.proxyUser,...configuration.accounts[configuration.policy.proxyUser]},upstream=await start(proxyIdentity,configuration.upstreamProgram,{address:configuration.address}),proxy=await start(proxyIdentity,configuration.proxyProgram,{address:configuration.address,policy:configuration.policy});
  const upstreamDeadline=Date.now()+2000;let upstreamReady=false;do{try{const base='/proc/'+upstream.child.pid,sockets=new Set(fs.readdirSync(base+'/fd').flatMap(fd=>{try{const m=/^socket:\[(\d+)\]$/.exec(fs.readlinkSync(base+'/fd/'+fd));return m?[m[1]]:[];}catch{return [];}})),rows=fs.readFileSync(base+'/net/tcp','utf8').trim().split('\n').slice(1).map(l=>l.trim().split(/\s+/)).filter(f=>f[3]==='0A'&&sockets.has(f[9]));upstreamReady=rows.length===2&&rows.every(f=>Number(f[7])===proxyIdentity.uid)&&rows.some(f=>f[1]==='22D8B85D:5F7B')&&rows.some(f=>f[1]==='0100007F:5F7C');}catch{}if(!upstreamReady)await new Promise(r=>setTimeout(r,10));}while(!upstreamReady&&Date.now()<upstreamDeadline);if(!upstreamReady)throw 0;
  const end=Date.now()+2000;let ready=false;
  do{try{
   const base='/proc/'+proxy.child.pid,status=fs.readFileSync(base+'/status','utf8'),inodes=fs.readdirSync(base+'/fd').flatMap(fd=>{try{const m=/^socket:\[(\d+)\]$/.exec(fs.readlinkSync(base+'/fd/'+fd));return m?[m[1]]:[];}catch{return [];}}),properties={User:proxyIdentity.user,MainPID:String(proxy.child.pid),ActiveState:'active',SubState:'running',SupplementaryGroups:'',Group:String(proxyIdentity.gid)};
   // parseProxyFacts consumes real proc identity/listener/socket facts. The
   // enclosing disposable process is the fixture's manager, not systemd.
   const facts=parseProxyFacts(properties,status,fs.readFileSync(base+'/net/tcp','utf8'),fs.readFileSync(base+'/net/tcp6','utf8'),inodes);
   const nft=JSON.parse(run('/usr/sbin/nft',['-j','list','table','inet','patrick_worker']));assertReadiness(nft,facts,configuration.policy,configuration.accounts);ready=true;
  }catch{}if(!ready)await new Promise(r=>setTimeout(r,10));}while(!ready&&Date.now()<end);if(!ready)throw 0;
  let positive=0,proxyDenials=0,firewallDenials=0;
  for(const worker of configuration.policy.workers){const identity={user:worker.user,...configuration.accounts[worker.user]},client=await start(identity,configuration.clientProgram,{runner:worker.runner,port:worker.proxyPort,otherPorts:configuration.policy.workers.filter(w=>w!==worker).map(w=>w.proxyPort),address:configuration.address});if(!await client.completion)throw 0;const result=JSON.parse(client.output());if(Object.keys(result).sort().join(',')!=='firewallDenials,positive,proxyDenials'||!Object.values(result).every(n=>Number.isSafeInteger(n)&&n>=0&&n<=16))throw 0;positive+=result.positive;proxyDenials+=result.proxyDenials;firewallDenials+=result.firewallDenials;}
  // Completion, rather than a polling snapshot, is the evidence boundary.
  // Drain every proxy socket before closing the upstream listener; then consume
  // both streams only after close (which includes stdout EOF).
  if(!proxy.child.kill('SIGTERM')||!await proxy.completion)throw 0;
  if(!upstream.child.kill('SIGTERM')||!await upstream.completion)throw 0;
  if(positive!==1||proxyDenials!==7||firewallDenials!==15||!validateNetworkStreams(upstream.output(),proxy.output()))throw 0;
  process.stdout.write(JSON.stringify({version:1,positive,proxyDenials,firewallDenials,ownedProcessesGone:true})+'\n');
 }catch{process.exitCode=78;}finally{clearTimeout(deadline);for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');if(process.exitCode===78)process.exit(78);}
}

/** Validate only terminal, LF-complete bounded streams. Embedded verbatim in
 * the fixed coordinator; tests exercise this identical acceptance predicate. */
export function validateNetworkStreams(upstreamText,proxyText) {
 const denied=()=>{throw Error('fixture');},exact=(value,key)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&Object.hasOwn(value,key);
 const frames=text=>{if(typeof text!=='string'||text.length>65536||!text.endsWith('\n')||/[^\x20-\x7e\n]/.test(text))denied();const rows=text.slice(0,-1).split('\n');if(rows.length<2||rows.length>128)denied();return rows.map(line=>{try{return JSON.parse(line);}catch{denied();}});};
 const upstream=frames(upstreamText);if(!exact(upstream[0],'ready')||upstream[0].ready!==true)denied();let accepted=0;
 for(const frame of upstream.slice(1,-1)){if(!exact(frame,'upstream')||!Number.isSafeInteger(frame.upstream)||frame.upstream!==accepted+1)denied();accepted=frame.upstream;}
 const finalUpstream=upstream.at(-1);if(!exact(finalUpstream,'final')||finalUpstream.final!==accepted||accepted!==1)denied();
 const proxy=frames(proxyText);if(!exact(proxy[0],'ready')||proxy[0].ready!==true)denied();const reasons=['HEADER','DNS','TLS','CONNECT','REMOTE','CAPACITY','IDLE','LIFETIME','BYTES','SOCKET','CANCEL','CLOSE'];let counts={};
 const validCounts=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.entries(value).every(([key,n])=>reasons.includes(key)&&Number.isSafeInteger(n)&&n>0&&n<=64);
 for(const frame of proxy.slice(1,-1)){
  if(!exact(frame,'counts')||!validCounts(frame.counts))denied();let increments=0;
  for(const key of reasons){const before=counts[key]??0,after=frame.counts[key]??0;if(after===before+1)increments++;else if(after!==before)denied();}
  if(increments!==1)denied();counts=frame.counts;
 }
 const finalProxy=proxy.at(-1);if(!exact(finalProxy,'final')||!validCounts(finalProxy.final)||reasons.some(key=>finalProxy.final[key]!==counts[key])||counts.HEADER!==5||counts.TLS!==2)denied();return true;
}

export function syntheticNetworkRecipe(state) {
 const policy=state?.policy,accounts=state?.accounts;
 if(!policy||policy.proxyUser!=='patrick-proxy'||!Array.isArray(policy.workers)||!same(policy.workers.map(w=>w.runner),['grok','codex','dsh'])||!accounts)fail();
 const names=[...policy.workers.map(w=>w.user),policy.proxyUser],uids=[];
 for(const name of names){const a=accounts[name];if(!/^patrick-[a-z][a-z0-9-]{0,23}$/.test(name)||!a||!Number.isSafeInteger(a.uid)||a.uid<1000||a.uid>2147483647||!Number.isSafeInteger(a.gid)||a.gid<1000||a.gid>2147483647||a.home!=='/var/lib/'+name||!same(a.groups,[]))fail();uids.push(a.uid);}if(new Set(uids).size!==4)fail();
 const lines=['table inet patrick_worker {','  chain output {','    type filter hook output priority -50; policy accept;'];for(const w of policy.workers)lines.push(`    meta skuid ${accounts[w.user].uid} jump ${w.runner}_out`);lines.push('  }');for(const w of policy.workers){if(w.proxyPort!==({grok:18743,codex:18744,dsh:18745})[w.runner])fail();lines.push(`  chain ${w.runner}_out {`,`    oifname "lo" ip daddr 127.0.0.1 tcp dport ${w.proxyPort} accept`,'    reject with icmpx type admin-prohibited','  }');}if(state.nftText!==[...lines,'}',''].join('\n'))fail();
 const syntheticPolicy={...policy,workers:policy.workers.map(w=>({...w,hosts:w.runner==='grok'?['synthetic.patrick.invalid']:[]}))};
 const input={policy:syntheticPolicy,accounts:Object.fromEntries(names.map(n=>[n,accounts[n]])),nftText:state.nftText,address,proxyProgram:proxyProgram.toString(),upstreamProgram:upstreamProgram.toString(),clientProgram:clientProgram.toString()};
 const program=`const validateNetworkStreams=${validateNetworkStreams.toString()};(${coordinator.toString()})(${JSON.stringify(input)}).catch(()=>process.exit(78));`;
 return Object.freeze({command:'/usr/bin/unshare',args:['--mount','--net','--pid','--fork','--kill-child=KILL','--mount-proc','/usr/local/bin/node','--input-type=module','-e',program],program,input});
}
function uidInventory(uids){const output=[];const pids=fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p));if(pids.length>131072)fail('lifetime');for(const pid of pids){try{const status=fs.readFileSync('/proc/'+pid+'/status','utf8'),rows=status.split('\n').filter(l=>l.startsWith('Uid:'));if(rows.length!==1)fail('lifetime');const ids=rows[0].slice(4).trim().split(/\s+/);if(ids.length!==4||ids.some(v=>!/^\d+$/.test(v)))fail('lifetime');if(ids.some(v=>uids.has(Number(v)))){if(ids.some(v=>v!==ids[0]))fail('lifetime');const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8'),start=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19];if(!/^[1-9]\d{0,19}$/.test(start))fail('lifetime');output.push(pid+':'+start+':'+ids[0]);}}catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}}return output.sort();}
export async function runSyntheticNetwork(state,deps) {
 // A virtual filesystem is never permission to invoke real host utilities.
 if(deps?.io!==fs||deps.effectiveUid()!==0)fail();
 const {trustedExecutable,trustedRead,CODE:code}=await import('./install-guest.mjs');
 for(const path of ['/usr/bin/unshare','/usr/local/bin/node','/usr/bin/setpriv','/usr/sbin/ip','/usr/sbin/nft'])trustedExecutable(path,deps.io);
 for(const name of ['synthetic-network.mjs','connect-proxy.mjs','policy.mjs','address-policy.mjs','tls-clienthello.mjs','stage-lifetime.mjs','worker-enter.mjs'])if(createHash('sha256').update(trustedRead(code+'/'+name,deps.io)).digest('hex')!==state.manifest.files[name])fail();
 const {validateResolved}=await import('./address-policy.mjs');validateResolved([address],state.policy.deniedCidrs);
 const help=deps.run('/usr/bin/unshare',['--help']);if(help.status!==0||typeof help.stdout!=='string'||['--mount','--net','--pid','--fork','--kill-child','--mount-proc'].some(flag=>!help.stdout.includes(flag)))fail();
 const recipe=syntheticNetworkRecipe(state),original=fs.readlinkSync('/proc/self/ns/net'),uids=new Set(Object.values(recipe.input.accounts).map(a=>a.uid)),before=uidInventory(uids);
 const outcome=await new Promise(resolve=>{const child=spawn(recipe.command,recipe.args,{cwd:'/',env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C'},stdio:['ignore','pipe','pipe']});let stdout='',bytes=0,namespace,expired=false;const timer=setTimeout(()=>{expired=true;child.kill('SIGKILL');},20000),poll=setInterval(()=>{try{const current=fs.readlinkSync('/proc/'+child.pid+'/ns/net');if(current!==original)namespace=current;}catch{}},5);child.stdout.on('data',c=>{stdout+=c;if(Buffer.byteLength(stdout)>65536){expired=true;child.kill('SIGKILL');}});child.stderr.on('data',c=>{bytes+=c.length;if(bytes>65536){expired=true;child.kill('SIGKILL');}});child.once('error',()=>{clearTimeout(timer);clearInterval(poll);resolve({stdout,namespace,success:false});});child.once('close',(code,signal)=>{clearTimeout(timer);clearInterval(poll);resolve({stdout,namespace,success:code===0&&!signal&&!expired&&Boolean(namespace)});});});
 if(!same(before,uidInventory(uids)))fail('lifetime');
 const pids=fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p));if(pids.length>131072)fail();for(const pid of pids){try{if(outcome.namespace&&fs.readlinkSync('/proc/'+pid+'/ns/net')===outcome.namespace)fail('lifetime');}catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')throw e;}}
 if(!outcome.success)fail('network');
 let result;try{result=JSON.parse(outcome.stdout);}catch{fail();}if(!result||Object.keys(result).sort().join(',')!=='firewallDenials,ownedProcessesGone,positive,proxyDenials,version'||result.version!==1||result.positive!==1||result.proxyDenials!==7||result.firewallDenials!==15||result.ownedProcessesGone!==true)fail();
 return Object.freeze({version:1,operation:'synthetic-network',outcome:'pass',reason:'ok',actualGuest:true,synthetic:true,environment:'isolated-fixture',positive:1,proxyDenials:7,firewallDenials:15});
}
