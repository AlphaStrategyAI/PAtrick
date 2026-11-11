#!/usr/local/bin/node
import { createServer, createConnection } from 'node:net';
import { lookup } from 'node:dns/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePolicy, parseAuthority } from './policy.mjs';
import { validateResolved } from './address-policy.mjs';
import { readClientHelloSni } from './tls-clienthello.mjs';

export const sessionUploadBytes=32*1024*1024;
const headerMaximum=8192,tlsMaximum=65536,byteMaximum=sessionUploadBytes;
export function assertSessionUploadCap(text){if(text!==`${sessionUploadBytes}\n`)throw new Error('START');}
const reasons=new Set(['HEADER','DNS','TLS','CONNECT','REMOTE','CAPACITY','IDLE','LIFETIME','BYTES','SOCKET','CANCEL','CLOSE']);
const established=Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n');

function authorityFromHeader(bytes,allowed) {
  // ASCII only; require exact CRLF and single-SP request/header delimiters.
  if(bytes.some(byte=>byte>126||(byte<32&&byte!==13&&byte!==10)))throw new Error('HEADER');
  const lines=bytes.toString('ascii').split('\r\n');
  if(lines.pop()!==''||lines.pop()!=='')throw new Error('HEADER');
  const request=/^CONNECT ([^ ]+) HTTP\/1\.1$/.exec(lines.shift());
  if(!request)throw new Error('HEADER');
  const hostname=parseAuthority(request[1],allowed);let host;
  const seen=new Set();
  for(const line of lines) {
    const header=/^([!#$%&'*+.^_`|~0-9A-Za-z-]+): ([\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?)$/.exec(line);
    if(!header)throw new Error('HEADER');
    const key=header[1].toLowerCase();
    if(seen.has(key)||['proxy-authorization','transfer-encoding','content-length'].includes(key))throw new Error('HEADER');
    seen.add(key);if(key==='host')host=header[2];
  }
  if(host!==request[1])throw new Error('HEADER');
  return hostname;
}

export function createProxy(rawPolicy,dependencies={}) {
  const policy=parsePolicy(rawPolicy);
  const dnsLookup=dependencies.lookup??(async host=>(await lookup(host,{all:true,verbatim:true})).map(answer=>answer.address));
  const connector=dependencies.connect??((address,port)=>createConnection({host:address,port,allowHalfOpen:true}));
  const serverFactory=dependencies.serverFactory??(accept=>createServer({allowHalfOpen:true},accept));
  const report=dependencies.report??(()=>{});
  const counts=new Map(),connections=new Set(),listeners=[],pendingStarts=new Set();
  const active=new Map(policy.workers.map(worker=>[worker.runner,0]));
  let state='new',closing;
  function event(reason) {
    if(!reasons.has(reason))return;
    const count=Math.min(Number.MAX_SAFE_INTEGER,(counts.get(reason)??0)+1);counts.set(reason,count);
    try {report(reason,count);} catch { /* A reporter cannot change admission. */ }
  }
  const destroy=socket=>{if(socket&&!socket.destroyed)socket.destroy();};

  function accept(worker,client) {
    // Keep an error handler on rejected/destroyed sockets as well: late errors
    // must not become uncaught exceptions or expose exception text.
    client.on('error',()=>finish('SOCKET'));
    let finished=false,upstream,phase='header',host,selected;
    let buffer=Buffer.alloc(0),phaseTimer,idleTimer,lifetimeTimer;
    let outgoing=0,incoming=0,clientEnded=false,upstreamEnded=false,lookupPending=false;
    const timers=()=>{clearTimeout(phaseTimer);clearTimeout(idleTimer);clearTimeout(lifetimeTimer);};
    const release=()=>{if(connections.delete(connection))active.set(worker.runner,active.get(worker.runner)-1);};
    function finish(reason) {
      if(finished)return;finished=true;timers();
      // dns.lookup has no cancellation API. A cancelled/timed-out lookup keeps
      // its slot until settlement so repeated cancels cannot queue unbounded DNS.
      if(!lookupPending)release();
      buffer=Buffer.alloc(0);client.removeListener('data',onData);
      if(upstream)upstream.removeListener('data',fromUpstream);
      destroy(client);destroy(upstream);if(reason)event(reason);
    }
    const connection={finish};
    const complete=()=>{if(clientEnded&&upstreamEnded&&client.writableFinished&&upstream.writableFinished)finish();};
    client.on('close',()=>{if(clientEnded&&client.writableFinished)complete();else finish('CANCEL');});
    client.on('finish',complete);
    client.on('end',()=>{
      clientEnded=true;
      if(phase!=='tunnel')return finish('CANCEL');
      upstream.end();complete();
    });
    if(state!=='running'||connections.size>=32||active.get(worker.runner)>=8) {
      finish(state==='running'?'CAPACITY':'CLOSE');return;
    }
    connections.add(connection);active.set(worker.runner,active.get(worker.runner)+1);
    const deadline=(ms,reason)=>{clearTimeout(phaseTimer);phaseTimer=setTimeout(()=>finish(reason),ms);};
    const activity=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>finish('IDLE'),60000);};
    activity();lifetimeTimer=setTimeout(()=>finish('LIFETIME'),30*60*1000);deadline(5000,'HEADER');
    const countBytes=(direction,length)=>{
      if(direction==='out')outgoing+=length;else incoming+=length;
      if(outgoing>byteMaximum||incoming>byteMaximum){finish('BYTES');return false;}
      return true;
    };
    function writeTo(destination,source,bytes) {
      try {
        if(destination.destroyed||destination.writableEnded)return finish('SOCKET');
        if(!destination.write(bytes)) {
          source.pause();
          destination.once('drain',()=>{if(!finished&&phase==='tunnel')source.resume();});
        }
      } catch {finish('SOCKET');}
    }
    function fromUpstream(bytes) {
      if(finished||phase!=='tunnel')return;
      activity();if(countBytes('in',bytes.length))writeTo(client,upstream,bytes);
    }
    async function resolveAuthority() {
      lookupPending=true;
      try {
        // One complete lookup; a late result can never transition a finished
        // request or start a connector after shutdown.
        const addresses=await dnsLookup(host);
        if(finished||state!=='running')return;
        selected=validateResolved(addresses,policy.deniedCidrs)[0];
        phase='tls';deadline(5000,'TLS');
        client.write(established);
      } catch {if(!finished)finish('DNS');}
      finally {lookupPending=false;if(finished)release();}
    }
    function openUpstream() {
      phase='connect';client.pause();deadline(10000,'CONNECT');
      try {
        // Connector receives only the normalized numeric address, never host.
        upstream=connector(selected,443);
        upstream.on('error',()=>finish('SOCKET'));
        upstream.on('close',()=>{if(upstreamEnded&&upstream.writableFinished)complete();else finish('SOCKET');});
        upstream.on('finish',complete);
        upstream.on('end',()=>{
          upstreamEnded=true;if(finished)return;
          if(phase!=='tunnel')return finish('SOCKET');
          client.end();complete();
        });
        upstream.once('connect',()=>{
          if(finished||state!=='running'){destroy(upstream);return;}
          try {
            if(validateResolved([upstream.remoteAddress],policy.deniedCidrs)[0]!==selected)return finish('REMOTE');
          } catch {return finish('REMOTE');}
          clearTimeout(phaseTimer);phase='tunnel';activity();
          upstream.on('data',fromUpstream);
          const retained=buffer;buffer=Buffer.alloc(0);
          if(!countBytes('out',retained.length))return;
          // Write retained bytes first. A false result keeps the client paused
          // until drain; there is never an unbounded proxy-side write queue.
          try {
            if(upstream.destroyed||upstream.writableEnded)return finish('SOCKET');
            if(upstream.write(retained))client.resume();
            else upstream.once('drain',()=>{if(!finished)client.resume();});
          } catch {finish('SOCKET');}
        });
        if(finished||state!=='running')destroy(upstream);
        else if(upstream.destroyed||upstream.writableEnded)finish('CONNECT');
      } catch {finish('CONNECT');}
    }
    function onData(bytes) {
      if(finished)return;
      activity();
      if(phase==='tunnel') {
        if(countBytes('out',bytes.length))writeTo(upstream,client,bytes);return;
      }
      if(phase==='dns')return finish('HEADER');
      if(phase==='connect')return finish('TLS');
      const max=phase==='header'?headerMaximum:tlsMaximum;
      if(buffer.length+bytes.length>max)return finish(phase==='header'?'HEADER':'TLS');
      buffer=Buffer.concat([buffer,bytes]);
      if(phase==='header') {
        const end=buffer.indexOf('\r\n\r\n');
        if(end<0)return;
        if(end+4!==buffer.length)return finish('HEADER');
        try {host=authorityFromHeader(buffer,new Set(worker.hosts));}catch{return finish('HEADER');}
        buffer=Buffer.alloc(0);phase='dns';deadline(5000,'DNS');void resolveAuthority();
      } else {
        try {
          const result=readClientHelloSni(buffer);
          if(result.status==='need-more')return;
          if(result.hostname!==host)return finish('TLS');
        } catch {return finish('TLS');}
        openUpstream();
      }
    }
    client.on('data',onData);
  }

  async function close() {
    if(closing)return closing;
    state='closing';
    for(const cancel of [...pendingStarts])cancel();
    for(const connection of [...connections])connection.finish('CLOSE');
    closing=Promise.all(listeners.map(server=>new Promise(resolveClose=>{
      try {server.close(()=>resolveClose());}catch{resolveClose();}
    }))).then(()=>{state='closed';});
    return closing;
  }
  async function start() {
    if(state!=='new')throw new Error('START');state='starting';
    try {
      for(const worker of policy.workers) {
        if(state!=='starting')throw new Error('START');
        const server=serverFactory(client=>accept(worker,client));listeners.push(server);
        server.on('error',()=>{if(state==='starting'||state==='running')void close();});
        await new Promise((resolveStart,rejectStart)=>{
          const cancel=()=>{pendingStarts.delete(cancel);server.removeListener('error',failed);rejectStart(new Error('START'));};
          const failed=()=>cancel();pendingStarts.add(cancel);server.once('error',failed);
          server.listen({host:'127.0.0.1',port:worker.proxyPort,exclusive:true},()=>{
            pendingStarts.delete(cancel);server.removeListener('error',failed);
            if(state!=='starting'){try{server.close(()=>{});}catch{}rejectStart(new Error('START'));}
            else resolveStart();
          });
        });
      }
      if(state!=='starting')throw new Error('START');state='running';
    } catch {await close();throw new Error('START');}
  }
  return {start,close};
}

const direct=(()=>{try{return Boolean(process.argv[1]&&realpathSync(resolve(process.argv[1]))===fileURLToPath(import.meta.url));}catch{return false;}})();
if(direct) {
  try {
    if(process.argv.length!==2||process.geteuid?.()===0)throw new Error('START');
    assertSessionUploadCap(readFileSync('/etc/patrick-worker/session-upload-bytes','utf8'));
    const policy=parsePolicy(JSON.parse(readFileSync('/etc/patrick-worker/policy.json','utf8')));
    const proxy=createProxy(policy,{report:(reason,count)=>process.stderr.write(`${reason} ${count}\n`)});
    process.once('SIGTERM',()=>{void proxy.close();});process.once('SIGINT',()=>{void proxy.close();});
    await proxy.start();
  } catch {process.stderr.write('START\n');process.exitCode=78;}
}
