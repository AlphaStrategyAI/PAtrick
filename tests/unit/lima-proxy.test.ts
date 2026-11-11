import { afterEach, describe, expect, it, vi } from 'vitest';
import { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { parsePolicy } from '../../scripts/lima/policy.mjs';
import { readClientHelloSni } from '../../scripts/lima/tls-clienthello.mjs';
import { assertSessionUploadCap, createProxy, sessionUploadBytes } from '../../scripts/lima/connect-proxy.mjs';

const u16=(n:number)=>Buffer.from([n>>8,n&255]);
const extension=(type:number,data:Buffer)=>Buffer.concat([u16(type),u16(data.length),data]);
const name=(host:string,type=0)=>{const b=Buffer.from(host);return Buffer.concat([Buffer.from([type]),u16(b.length),b]);};
const sni=(host='auth.x.ai')=>{const b=name(host);return extension(0,Buffer.concat([u16(b.length),b]));};
function handshake(extensions:Buffer[]= [sni()]) {
  const exts=Buffer.concat(extensions),body=Buffer.concat([Buffer.from([3,3]),Buffer.alloc(32,0x42),Buffer.from([0]),u16(2),Buffer.from([0x13,1]),Buffer.from([1,0]),u16(exts.length),exts]);
  return Buffer.concat([Buffer.from([1,body.length>>16,(body.length>>8)&255,body.length&255]),body]);
}
function record(data:Buffer,version=3) {return Buffer.concat([Buffer.from([22,3,version]),u16(data.length),data]);}
const hello=()=>record(handshake());
// Literal high bytes make these length fields impossible before their low bytes arrive.
const impossibleLengthPrefixes=()=>{
  const nested=(bodyOffset:number)=>{const bytes=hello();bytes[9+bodyOffset]=0xff;return bytes.subarray(0,10+bodyOffset);};
  return [
    ['record',Buffer.from([22,3,3,0x41])],
    ['handshake',Buffer.from([22,3,3,0,4,1,1])],
    ['split handshake',Buffer.concat([record(Buffer.from([1,1])),Buffer.from([22,3,3])])],
    ['record exceeds remaining handshake',Buffer.concat([record(handshake().subarray(0,8)),Buffer.from([22,3,3,1])])],
    ['cipher vector',nested(35)],['extension vector',nested(41)],
    ['extension data',nested(45)],['SNI list',nested(47)],['SNI name',nested(50)],
  ] as const;
};
const request=(authority='auth.x.ai:443')=>Buffer.from(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);

class Wire extends Duplex {
  remoteAddress='8.8.8.8'; writes:Buffer[]=[]; hold=false; callbacks:Array<()=>void>=[]; destructions=0;
  constructor(){super({allowHalfOpen:true,highWaterMark:64});}
  _read() {}
  _write(data:Buffer,_encoding:BufferEncoding,cb:()=>void){this.writes.push(Buffer.from(data));if(this.hold)this.callbacks.push(cb);else cb();}
  _destroy(_error:Error|null,cb:(error?:Error|null)=>void){this.destructions++;for(const callback of this.callbacks.splice(0))callback();cb();}
  send(data:Buffer|string){this.push(typeof data==='string'?Buffer.from(data):data);}
  eof(){this.push(null);}
  release(){this.hold=false;for(const cb of this.callbacks.splice(0))cb();}
  output(){return Buffer.concat(this.writes);}
}
class Server extends EventEmitter {
  options:any; closed=false;
  constructor(readonly accept:(socket:Wire)=>void,readonly fails=false){super();}
  listen(options:any,cb:()=>void){this.options=options;queueMicrotask(()=>this.fails?this.emit('error',new Error('unique-server-secret')):cb());return this;}
  close(cb:(error?:Error)=>void){this.closed=true;queueMicrotask(()=>cb());return this;}
}
const flush=async()=>{for(let i=0;i<8;i++)await new Promise<void>(resolve=>setImmediate(resolve));};
const running:Array<ReturnType<typeof createProxy>>=[];
function harness(options:{lookup?:(host:string)=>Promise<string[]>;manualConnect?:boolean;remote?:string;failBind?:number;openAll?:boolean}={}) {
  const raw=JSON.parse(readFileSync(new URL('../../scripts/lima/worker-policy.json',import.meta.url),'utf8'));
  if(options.openAll)for(const worker of raw.workers)worker.hosts=['auth.x.ai'];
  const servers:Server[]=[],upstreams:Wire[]=[],logs:unknown[][]=[];
  const lookup=vi.fn(options.lookup??(async()=>['8.8.8.8','2606:4700:4700::1111']));
  const connect=vi.fn((_address:string,_port:443)=>{const w=new Wire();w.remoteAddress=options.remote??'8.8.8.8';upstreams.push(w);if(!options.manualConnect)queueMicrotask(()=>w.emit('connect'));return w;});
  const proxy=createProxy(parsePolicy(raw),{lookup,connect,serverFactory:(accept:any)=>{const server=new Server(accept,servers.length===options.failBind);servers.push(server);return server as never;},report:(...args:unknown[])=>logs.push(args)});
  running.push(proxy);
  const client=(index=0)=>{const w=new Wire();servers[index]!.accept(w);return w;};
  return {proxy,servers,lookup,connect,upstreams,logs,client};
}
async function admitted(h:ReturnType<typeof harness>,index=0) {
  const client=h.client(index);client.send(request());await flush();client.send(hello());await flush();return client;
}
afterEach(async()=>{for(const p of running.splice(0))await p.close();vi.useRealTimers();});

describe('bounded visible TLS ClientHello parser',()=>{
  it('supports every TCP prefix and multiple handshake records with exact synthetic lengths',()=>{
    const data=hello();for(let i=0;i<data.length;i++)expect(readClientHelloSni(data.subarray(0,i))).toEqual({status:'need-more'});
    expect(readClientHelloSni(data)).toEqual({status:'ok',hostname:'auth.x.ai'});
    const h=handshake(),fragmented=Buffer.concat([record(h.subarray(0,2),1),record(h.subarray(2,13)),record(h.subarray(13))]);
    for(let i=0;i<fragmented.length;i++)expect(readClientHelloSni(fragmented.subarray(0,i))).toEqual({status:'need-more'});
    expect(readClientHelloSni(fragmented)).toEqual({status:'ok',hostname:'auth.x.ai'});
  });
  it.each(impossibleLengthPrefixes())('rejects impossible partial %s length immediately',(_field,bytes)=>{
    expect(()=>readClientHelloSni(bytes)).toThrow(/^TLS$/);
  });
  it.each([
    Buffer.from([22,3,3,0x40]),Buffer.from([22,3,3,0,4,1,0]),
    Buffer.from([22,3,3,0,4,1,0,0]),
  ])('keeps feasible partial length prefixes incomplete (%#)',bytes=>{
    expect(readClientHelloSni(bytes)).toEqual({status:'need-more'});
  });
  it('rejects absent, duplicate, unsupported or malformed SNI and encryption extensions',()=>{
    const duplicateNames=Buffer.concat([name('auth.x.ai'),name('auth.x.ai')]);
    for(const exts of [[],[sni(),sni()],[extension(0,Buffer.concat([u16(duplicateNames.length),duplicateNames]))],[extension(0,Buffer.concat([u16(4),name('a',1)]))],[extension(0,Buffer.from([0,1,0]))],[sni('AUTH.X.AI')],[sni('8.8.8.8')],[sni('auth.x.ai.')],[sni(),extension(65037,Buffer.from([0]))],[sni(),extension(64768,Buffer.from([2,0,0]))],[sni(),extension(65486,Buffer.alloc(0))]])expect(()=>readClientHelloSni(record(handshake(exts)))).toThrow(/^TLS$/);
    const badList=sni();badList[5]=255;expect(()=>readClientHelloSni(record(handshake([badList])))).toThrow('TLS');
  });
  it('rejects wrong framing, lengths, excess early bytes and oversized raw input',()=>{
    const variants=[Buffer.from([23]),Buffer.from([22,2]),Buffer.from([22,3,2]),Buffer.from([22,3,3,0,0]),Buffer.from([22,3,3,0x40,1]),record(Buffer.from([2,0,0,1,0])),record(Buffer.from([1,1,0,0]))];
    const trailing=Buffer.concat([hello(),Buffer.from([22])]);variants.push(trailing,record(Buffer.concat([handshake(),Buffer.from([0])])),Buffer.alloc(65537));
    const odd=handshake();odd[40]=3;variants.push(record(odd));
    const sid=handshake();sid[38]=33;variants.push(record(sid));
    for(const b of variants)expect(()=>readClientHelloSni(b)).toThrow(/^TLS$/);
    const truncated=hello().subarray(0,-1);expect(readClientHelloSni(truncated)).toEqual({status:'need-more'});
  });
  it('returns need-more only while already received nested fields remain a valid prefix',()=>{
    const badVersion=hello();badVersion[5+4]=2;
    expect(()=>readClientHelloSni(badVersion.subarray(0,5+4+2))).toThrow(/^TLS$/);
    const badSession=hello();badSession[5+4+34]=33;
    expect(()=>readClientHelloSni(badSession.subarray(0,5+4+35))).toThrow(/^TLS$/);
    const badExtensions=hello();badExtensions[5+4+41]=255;
    expect(()=>readClientHelloSni(badExtensions.subarray(0,5+4+43))).toThrow(/^TLS$/);
  });
});

describe('actual CONNECT protocol with in-memory duplex sockets',()=>{
  it('binds only exact loopback ports, waits for approved SNI, then writes identical bytes to one numeric address',async()=>{
    const h=harness();await h.proxy.start();
    expect(h.servers.map(s=>s.options)).toEqual([18743,18744,18745].map(port=>({host:'127.0.0.1',port,exclusive:true})));
    const c=h.client(),req=request();c.send(req.subarray(0,12));await flush();expect(h.lookup).not.toHaveBeenCalled();
    c.send(req.subarray(12));await flush();expect(h.lookup).toHaveBeenCalledExactlyOnceWith('auth.x.ai');expect(h.connect).not.toHaveBeenCalled();
    expect(c.output().toString()).toBe('HTTP/1.1 200 Connection Established\r\n\r\n');
    const bytes=hello();c.send(bytes.subarray(0,11));await flush();expect(h.connect).not.toHaveBeenCalled();
    c.send(bytes.subarray(11));await flush();expect(h.connect).toHaveBeenCalledExactlyOnceWith('8.8.8.8',443);expect(h.upstreams[0]!.output()).toEqual(bytes);
    c.send('synthetic-outgoing');h.upstreams[0]!.send('synthetic-incoming');await flush();
    expect(h.upstreams[0]!.output().subarray(bytes.length).toString()).toBe('synthetic-outgoing');expect(c.output().toString()).toContain('synthetic-incoming');
  });
  it('keeps empty Codex/dsh lists closed with zero DNS and no fallback',async()=>{
    const h=harness();await h.proxy.start();for(const i of [1,2]){const c=h.client(i);c.send(request());await flush();expect(c.destroyed).toBe(true);}
    expect(h.lookup).not.toHaveBeenCalled();expect(h.connect).not.toHaveBeenCalled();
  });
  it.each([
    'GET auth.x.ai:443 HTTP/1.1\r\nHost: auth.x.ai:443\r\n\r\n',
    'CONNECT auth.x.ai:443 HTTP/1.0\r\nHost: auth.x.ai:443\r\n\r\n',
    'CONNECT  auth.x.ai:443 HTTP/1.1\r\nHost: auth.x.ai:443\r\n\r\n',
    'CONNECT auth.x.ai:443 HTTP/1.1\r\nHost: auth.x.ai:443\r\nHost: auth.x.ai:443\r\n\r\n',
    'CONNECT auth.x.ai:443 HTTP/1.1\r\nHost: other.example:443\r\n\r\n',
    'CONNECT auth.x.ai:443 HTTP/1.1\r\n\r\n',
    ...['Proxy-Authorization: secret-unique-token','Transfer-Encoding: chunked','Content-Length: 0',' Host: auth.x.ai:443','Host : auth.x.ai:443','X-Marker:\tsecret-unique-token','X-Marker: a\x00b'].map(line=>`CONNECT auth.x.ai:443 HTTP/1.1\r\nHost: auth.x.ai:443\r\n${line}\r\n\r\n`),
    request().toString()+'body-unique-token',request().toString()+request().toString(),request().toString()+'\x16',
    ...['AUTH.X.AI:443','auth.x.ai.:443','auth.x.ai.evil:443','[::1]:443','8.8.8.8:443','auth.x.ai:80','u@auth.x.ai:443'].map(a=>request(a).toString()),
  ])('rejects HTTP ambiguity before DNS (%#)',async input=>{
    const h=harness();await h.proxy.start();const c=h.client();c.send(input);await flush();expect(c.destroyed).toBe(true);expect(h.lookup).not.toHaveBeenCalled();expect(h.connect).not.toHaveBeenCalled();expect(JSON.stringify(h.logs)).not.toContain('unique-token');
  });
  it('rejects overflow and slow headers with bounded fixed diagnostics',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const h=harness();await h.proxy.start();const large=h.client();large.send(Buffer.alloc(8193,65));await flush();expect(large.destroyed).toBe(true);
    const slow=h.client();slow.send('CONNECT auth.x.ai:443 HTTP/1.1\r\n');await vi.advanceTimersByTimeAsync(5000);expect(slow.destroyed).toBe(true);expect(h.lookup).not.toHaveBeenCalled();expect(h.logs).toEqual([['HEADER',1],['HEADER',2]]);
  });
  it('rejects TLS arriving during DNS, any mixed/private DNS and late DNS after cancellation or shutdown',async()=>{
    let resolve!:(ips:string[])=>void;const h=harness({lookup:()=>new Promise(r=>{resolve=r;})});await h.proxy.start();const c=h.client();c.send(request());await flush();c.send(hello());await flush();expect(c.destroyed).toBe(true);resolve(['8.8.8.8']);await flush();expect(h.connect).not.toHaveBeenCalled();
    const mixed=harness({lookup:async()=>['8.8.8.8','127.0.0.1']});await mixed.proxy.start();const m=mixed.client();m.send(request());await flush();expect(m.destroyed).toBe(true);expect(m.output().length).toBe(0);
    for(const shutdown of [false,true]){let finish!:(ips:string[])=>void;const late=harness({lookup:()=>new Promise(r=>{finish=r;})});await late.proxy.start();const l=late.client();l.send(request());await flush();if(shutdown)await late.proxy.close();else l.destroy();await flush();finish(['8.8.8.8']);await flush();expect(late.connect).not.toHaveBeenCalled();expect(l.output().length).toBe(0);}
  });
  it('times out DNS and drops rejected raw resolver messages',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const h=harness({lookup:()=>new Promise(()=>{})});await h.proxy.start();const c=h.client();c.send(request());await flush();await vi.advanceTimersByTimeAsync(5000);expect(c.destroyed).toBe(true);expect(h.logs).toEqual([['DNS',1]]);
    const rejected=harness({lookup:async()=>{throw new Error('unique-lookup-secret');}});await rejected.proxy.start();rejected.client().send(request());await flush();expect(JSON.stringify(rejected.logs)).not.toContain('unique-lookup-secret');
  });
  it('rejects wrong/invalid/extra TLS without an outbound socket',async()=>{
    const h=harness();await h.proxy.start();for(const bytes of [record(handshake([sni('cdn.example')])),record(handshake([])),record(handshake([sni(),extension(65037,Buffer.alloc(1))])),Buffer.concat([hello(),Buffer.from([23])]),Buffer.alloc(65537)]){const c=h.client();c.send(request());await flush();c.send(bytes);await flush();expect(c.destroyed).toBe(true);}
    expect(h.connect).not.toHaveBeenCalled();
  });
  it.each(impossibleLengthPrefixes())('closes impossible partial %s length with zero outbound sockets',async(_field,bytes)=>{
    const h=harness();await h.proxy.start();const c=h.client();c.send(request());await flush();
    c.send(bytes);await flush();expect(c.destroyed).toBe(true);
    expect(h.connect).not.toHaveBeenCalled();expect(h.upstreams).toHaveLength(0);expect(h.logs).toEqual([['TLS',1]]);
  });
  it('enforces TLS/connect deadlines and cancels late connects without reopening sockets',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const h=harness({manualConnect:true});await h.proxy.start();const c=h.client();c.send(request());await flush();c.send(hello().subarray(0,-1));await vi.advanceTimersByTimeAsync(5000);expect(c.destroyed).toBe(true);expect(h.connect).not.toHaveBeenCalled();
    const late=await admitted(h);expect(h.upstreams).toHaveLength(1);await vi.advanceTimersByTimeAsync(10000);expect(late.destroyed).toBe(true);h.upstreams[0]!.emit('connect');await flush();expect(h.upstreams[0]!.output().length).toBe(0);expect(h.upstreams[0]!.destructions).toBe(1);
    const cancelled=await admitted(h);cancelled.destroy();await flush();h.upstreams[1]!.emit('connect');await flush();expect(h.upstreams[1]!.destroyed).toBe(true);expect(h.upstreams[1]!.output().length).toBe(0);
  });
  it('rejects remote mismatch and never retries an error',async()=>{
    const mismatch=harness({remote:'1.1.1.1'});await mismatch.proxy.start();const c=await admitted(mismatch);expect(c.destroyed).toBe(true);expect(mismatch.upstreams[0]!.destroyed).toBe(true);expect(mismatch.upstreams[0]!.output().length).toBe(0);expect(mismatch.connect).toHaveBeenCalledTimes(1);
    const failing=harness({manualConnect:true});await failing.proxy.start();const f=await admitted(failing);failing.upstreams[0]!.emit('error',new Error('unique-connect-secret'));await flush();expect(f.destroyed).toBe(true);expect(failing.connect).toHaveBeenCalledTimes(1);expect(JSON.stringify(failing.logs)).not.toContain('unique-connect-secret');
  });
  it('normalizes connected IPv6 without a second DNS operation',async()=>{
    const h=harness({lookup:async()=>['2606:4700:4700::1111'],remote:'2606:4700:4700:0:0:0:0:1111'});await h.proxy.start();const c=await admitted(h);expect(c.destroyed).toBe(false);expect(h.connect).toHaveBeenCalledExactlyOnceWith('2606:4700:4700:0:0:0:0:1111',443);expect(h.lookup).toHaveBeenCalledTimes(1);
  });
});

describe('bounded lifecycle, backpressure and shutdown',()=>{
  it('counts each phase per listener independently and releases slots once',async()=>{
    const h=harness({openAll:true,lookup:()=>new Promise(()=>{})});await h.proxy.start();const clients:Wire[]=[];
    for(let listener=0;listener<3;listener++){for(let i=0;i<8;i++){const c=h.client(listener);clients.push(c);if(i%2===0)c.send(request());}const extra=h.client(listener);await flush();expect(extra.destroyed).toBe(true);}
    expect(clients).toHaveLength(24);expect(clients.every(c=>!c.destroyed)).toBe(true);clients[1]!.destroy();await flush();const next=h.client(0);expect(next.destroyed).toBe(false);await h.proxy.close();await flush();expect(clients.every(c=>c.destroyed)).toBe(true);expect(h.servers.every(s=>s.closed)).toBe(true);expect(h.client().destroyed).toBe(true);
  });
  it('retains capacity for cancelled DNS until its late operation settles',async()=>{
    const completions:Array<(ips:string[])=>void>=[];
    const h=harness({lookup:()=>new Promise(resolve=>completions.push(resolve))});await h.proxy.start();
    const clients=Array.from({length:8},()=>h.client());for(const c of clients)c.send(request());await flush();
    for(const c of clients)c.destroy();await flush();expect(h.client().destroyed).toBe(true);expect(h.lookup).toHaveBeenCalledTimes(8);
    completions[0]!(['8.8.8.8']);await flush();const fresh=h.client();expect(fresh.destroyed).toBe(false);expect(h.connect).not.toHaveBeenCalled();
    await h.proxy.close();for(const finish of completions.slice(1))finish(['8.8.8.8']);await flush();expect(h.connect).not.toHaveBeenCalled();
  });
  it('pauses the source on backpressure, including the retained ClientHello, then resumes',async()=>{
    const h=harness({manualConnect:true});await h.proxy.start();const c=await admitted(h),u=h.upstreams[0]!;u.hold=true;u.emit('connect');await flush();expect(c.isPaused()).toBe(true);c.send('waiting-client-marker');await flush();expect(u.output()).toEqual(hello());u.release();await flush();expect(u.output().toString()).toContain('waiting-client-marker');
    c.hold=true;u.send(Buffer.alloc(128,65));await flush();expect(u.isPaused()).toBe(true);c.release();await flush();expect(u.isPaused()).toBe(false);
  });
  it('enforces idle and absolute lifetime despite activity and clears all timers on close',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const h=harness();await h.proxy.start();const idle=await admitted(h);await vi.advanceTimersByTimeAsync(60000);expect(idle.destroyed).toBe(true);
    const active=await admitted(h);for(let i=0;i<60;i++){active.send('x');await flush();await vi.advanceTimersByTimeAsync(30000);}expect(active.destroyed).toBe(true);expect(h.logs.map(l=>l[0])).toContain('LIFETIME');await h.proxy.close();expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['client','upstream'])('limits 32MiB in the %s direction before forwarding excess',async direction=>{
    const h=harness();await h.proxy.start();const c=await admitted(h),u=h.upstreams[0]!;
    for(let i=0;i<33&&!c.destroyed;i++){(direction==='client'?c:u).send(Buffer.alloc(1024*1024,65));await flush();}
    expect(c.destroyed).toBe(true);expect(u.destroyed).toBe(true);expect((direction==='client'?u:c).output().length).toBeLessThanOrEqual(32*1024*1024+100);expect(h.logs.map(l=>l[0])).toContain('BYTES');
  });
  it('propagates half closes and destroys both peers on errors without raw logs',async()=>{
    const h=harness();await h.proxy.start();const c=await admitted(h),u=h.upstreams[0]!;c.eof();await flush();expect(u.writableEnded).toBe(true);expect(c.destroyed).toBe(false);u.send('final-synthetic-response');await flush();expect(c.output().toString()).toContain('final-synthetic-response');u.eof();await flush();expect(c.destroyed).toBe(true);expect(u.destroyed).toBe(true);
    const e=await admitted(h),eu=h.upstreams[1]!;eu.emit('error',new Error('unique-error-secret'));await flush();expect(e.destructions).toBe(1);expect(eu.destructions).toBe(1);expect(JSON.stringify(h.logs)).not.toContain('unique-error-secret');
  });
  it('waits for queued writes to drain after both peers half-close',async()=>{
    const h=harness();await h.proxy.start();const c=await admitted(h),u=h.upstreams[0]!;u.hold=true;
    c.send(Buffer.alloc(128,65));await flush();c.eof();u.eof();await flush();
    expect(u.destroyed).toBe(false);expect(u.writableFinished).toBe(false);u.release();await flush();
    expect(u.writableFinished).toBe(true);expect(u.destroyed).toBe(true);expect(c.destroyed).toBe(true);
  });
  it('closes all listeners after a partial bind failure and refuses restart',async()=>{
    const h=harness({failBind:1});await expect(h.proxy.start()).rejects.toThrow(/^START$/);expect(h.servers.every(s=>s.closed)).toBe(true);expect(h.client().destroyed).toBe(true);await expect(h.proxy.start()).rejects.toThrow();expect(h.connect).not.toHaveBeenCalled();
  });
  it('fails the whole startup if an earlier listener errors during a later bind',async()=>{
    const h=harness(),started=h.proxy.start();
    await Promise.resolve();await Promise.resolve();
    expect(h.servers.length).toBeGreaterThan(1);h.servers[0]!.emit('error',new Error('unique-bind-secret'));
    await expect(started).rejects.toThrow(/^START$/);expect(h.servers.every(server=>server.closed)).toBe(true);
  });
  it('cancels a pending start during shutdown and discards late listen completion',async()=>{
    const h=harness(),started=h.proxy.start();await h.proxy.close();
    await expect(started).rejects.toThrow(/^START$/);await flush();expect(h.servers.every(server=>server.closed)).toBe(true);expect(h.client().destroyed).toBe(true);
  });
  it('destroys pending connecting and tunneled sockets once, including late completion',async()=>{
    const h=harness({manualConnect:true});await h.proxy.start();const c=await admitted(h);await h.proxy.close();h.upstreams[0]!.emit('connect');await flush();expect(c.destructions).toBe(1);expect(h.upstreams[0]!.destructions).toBe(1);expect(h.upstreams[0]!.output().length).toBe(0);
    const tunnel=harness();await tunnel.proxy.start();const t=await admitted(tunnel);await tunnel.proxy.close();expect(t.destructions).toBe(1);expect(tunnel.upstreams[0]!.destructions).toBe(1);
  });
  it('leaves no CLI caller-selected policy, dependency or argument overrides',()=>{
    const source=readFileSync(new URL('../../scripts/lima/connect-proxy.mjs',import.meta.url),'utf8');
    expect(source).toContain('/etc/patrick-worker/policy.json');expect(source).toContain('/etc/patrick-worker/session-upload-bytes');expect(source).toContain('process.argv.length');expect(source).not.toMatch(/process\.env|--(?:policy|port|test|skip|resolver|connector)/);
    expect(()=>assertSessionUploadCap(`${sessionUploadBytes}\n`)).not.toThrow();
    expect(()=>assertSessionUploadCap(`${sessionUploadBytes}`)).toThrow(/^START$/);
    expect(()=>assertSessionUploadCap(`${sessionUploadBytes+1}\n`)).toThrow(/^START$/);
  });
});
