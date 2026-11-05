import { existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

if(existsSync('.env'))process.loadEnvFile('.env');
const base=new URL(process.env.PATRICK_URL??'http://127.0.0.1:4317');
if(base.protocol!=='https:'&&!(base.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(base.hostname)))throw Error('Use HTTPS or loopback for the PAtrick MCP connection.');
const projectId=process.env.PATRICK_MCP_PROJECT??'',domain=process.env.PATRICK_MCP_DOMAIN??'',token=process.env.PATRICK_TOKEN??'';
class KnowledgeSnapshotUnavailable extends Error {}
async function api(path:string,body?:unknown):Promise<any> {
  const response=await fetch(new URL(path,base),{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
  if(response.status===503){const details=await response.json().catch(()=>undefined) as {code?:unknown}|undefined;if(details?.code==='knowledge_snapshot_unavailable')throw new KnowledgeSnapshotUnavailable('Knowledge temporarily unavailable; retry.');}
  if(!response.ok)throw Error(`PAtrick returned ${response.status}. Check the local host and scoped configuration.`);
  return response.json();
}
function result(value:unknown){return {content:[{type:'text' as const,text:JSON.stringify(value)}]};}
function scoped(entity:{projectId:string;domain:string}|undefined):boolean{return !!projectId&&!!domain&&entity?.projectId===projectId&&entity.domain===domain;}
const server=new McpServer({name:'patrick',version:'0.1.0'});
server.registerTool('lookup',{title:'Search project evidence',description:'Returns scoped source reports and labeled historical observations with exact quotations and source revisions. Current state requires fresh host readback.',inputSchema:{query:z.string().min(1).max(500)},annotations:{readOnlyHint:true}},async({query})=>{
  if(!projectId||!domain)return result({cards:[]});
  try{return result(await api(`/api/lookup?project=${encodeURIComponent(projectId)}&domain=${encodeURIComponent(domain)}&q=${encodeURIComponent(query)}`));}
  catch(error){if(error instanceof KnowledgeSnapshotUnavailable)return {isError:true,content:[{type:'text' as const,text:error.message}]};throw error;}
});
server.registerTool('ask',{title:'Ask PAtrick',description:'Persist a question in the bound project; PAtrick researches, decides or asks its owner. Poll get_task after reconnecting.',inputSchema:{title:z.string().min(1).max(200),question:z.string().min(1).max(100000)},annotations:{idempotentHint:false}},async({title,question})=>{
  if(!projectId||!domain)throw Error('Bind PATRICK_MCP_PROJECT and PATRICK_MCP_DOMAIN first.');
  const state=await api(`/api/state?project=${encodeURIComponent(projectId)}`);if(!state.projects.some((p:any)=>p.id===projectId&&p.domain===domain))throw Error('Unknown project.');
  return result(await api('/api/tasks',{projectId,title,content:question}));
});
server.registerTool('get_task',{title:'Read a task or returned answer',description:'Reconnect with the persisted task ID to read progress and the owner decision.',inputSchema:{taskId:z.string()},annotations:{readOnlyHint:true}},async({taskId})=>{if(!projectId||!domain)throw Error('Bind the project first.');const data=await api(`/api/tasks/${encodeURIComponent(taskId)}?project=${encodeURIComponent(projectId)}&domain=${encodeURIComponent(domain)}`);if(!scoped(data.task))throw Error('Task is outside the bound project.');return result(data);});
server.registerTool('get_answer',{title:'Read a frozen question answer',description:'Returns only the bound project question. Old questions remain identifiable after reconnecting.',inputSchema:{questionId:z.string()},annotations:{readOnlyHint:true}},async({questionId})=>{if(!projectId||!domain)throw Error('Bind the project first.');const data=await api(`/api/questions/${encodeURIComponent(questionId)}?project=${encodeURIComponent(projectId)}&domain=${encodeURIComponent(domain)}`);if(!scoped(data.question))throw Error('Question is outside the bound project.');return result(data);});
server.registerTool('record_conversation',{title:'Capture an authorized turn',description:'Capture approved tool context without injected PAtrick memory. A tool claim is not an authenticated personal principle.',inputSchema:{sessionId:z.string(),turnId:z.string(),revision:z.string(),content:z.string().max(100000),tool:z.enum(['codex','cursor']),retention:z.enum(['permanent','ephemeral'])},annotations:{idempotentHint:true}},async data=>result(await api('/api/conversations',{...data,projectId,domain})));
await server.connect(new StdioServerTransport());
