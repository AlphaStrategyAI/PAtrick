import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { readConfig } from './config.js';
import { createRuntime } from './runtime.js';
import { createApp } from './app.js';

if(existsSync('.env'))process.loadEnvFile('.env');
if(process.argv.includes('--demo'))process.env.PATRICK_MODE='demo';
const runtime=await createRuntime(readConfig());
const app=createApp(runtime);
const server=serve({fetch:app.fetch,hostname:runtime.config.host,port:runtime.config.port},info=>{
  console.log(`PAtrick · ${runtime.config.mode} · http://${runtime.config.host}:${info.port}`);
  if(runtime.config.mode==='live')console.log(`Access token: use PATRICK_TOKEN or read ${join(runtime.config.dataDir,'access-token')}`);
});
await runtime.collector.start();
await runtime.scanGithubBranches();
await runtime.checkNetwork();
if(runtime.feishu)void runtime.feishu.start().catch(()=>console.error('Feishu is not ready. Check the configured chat, identity, and history permissions.'));
const timer=setInterval(()=>void runtime.engine.tick(),750);timer.unref();
const historyTimer=setInterval(()=>void runtime.feishu?.catchup().catch(()=>{}),runtime.config.scanIntervalMs);historyTimer.unref();
const networkTimer=setInterval(()=>void runtime.checkNetwork(),60000);networkTimer.unref();
const githubTimer=setInterval(()=>void runtime.scanGithubBranches(),runtime.config.scanIntervalMs);githubTimer.unref();
let closing=false;
async function close(){if(closing)return;closing=true;clearInterval(timer);clearInterval(historyTimer);clearInterval(networkTimer);clearInterval(githubTimer);await new Promise<void>(resolve=>server.close(()=>resolve()));await runtime.close();process.exit(0);}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
process.on('unhandledRejection',()=>console.error('A background connection failed; durable tasks remain available for retry.'));
