import type { Duplex } from 'node:stream';
import type { GuestPolicy } from './policy.mjs';
export type ProxySocket=Duplex&{readonly remoteAddress?:string};
export type ProxyServer={
  on(event:'error',listener:(error:Error)=>void):unknown;
  once(event:'error',listener:(error:Error)=>void):unknown;
  removeListener(event:'error',listener:(error:Error)=>void):unknown;
  listen(options:{host:'127.0.0.1';port:number;exclusive:true},listener:()=>void):unknown;
  close(listener:(error?:Error)=>void):unknown;
};
export type ProxyDependencies={
  lookup?:(hostname:string)=>Promise<string[]>;
  connect?:(address:string,port:443)=>ProxySocket;
  serverFactory?:(accept:(client:ProxySocket)=>void)=>ProxyServer;
  report?:(reason:string,count:number)=>void;
};
export function createProxy(policy:GuestPolicy,dependencies?:ProxyDependencies):{start():Promise<void>;close():Promise<void>};
