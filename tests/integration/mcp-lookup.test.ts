import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { configureDemo, demoResearch, demoWriter } from '../../src/demo.js';
import { DomainError } from '../../src/domain.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';
import { ingestSource } from '../../src/intake.js';
import { repositoryKnowledgeFixture } from '../fixtures/repository-knowledge.js';

const sdk=vi.hoisted(()=>({handlers:new Map<string,(input:any)=>Promise<any>>() }));
vi.mock('@modelcontextprotocol/sdk/server/mcp.js',()=>({McpServer:class {
  registerTool(name:string,_options:unknown,handler:(input:any)=>Promise<any>){sdk.handlers.set(name,handler);}
  async connect(){}
}}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js',()=>({StdioServerTransport:class {}}));
afterEach(()=>{sdk.handlers.clear();vi.unstubAllEnvs();vi.unstubAllGlobals();vi.resetModules();});

it('returns an MCP tool error for the exact knowledge 503 and recovers without partial cards',async()=>{
  const f=repositoryKnowledgeFixture();let engine:Workbench|undefined;
  try{
    const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];config.ownerId=f.project.ownerId;
    engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch});
    const app=createApp({store:f.store,config,engine});
    vi.stubEnv('PATRICK_URL','http://127.0.0.1:4317');vi.stubEnv('PATRICK_MCP_PROJECT',f.project.id);vi.stubEnv('PATRICK_MCP_DOMAIN',f.project.domain);vi.stubEnv('PATRICK_TOKEN','');
    vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>app.request(String(input),init));
    const search=vi.spyOn(f.store,'searchCards').mockImplementation(()=>{throw new DomainError('Knowledge temporarily unavailable; retry.','knowledge_snapshot_unavailable',503);});
    await import('../../src/mcp.js');const handler=sdk.handlers.get('lookup')!;
    const failed=await handler({query:'cache'});expect(failed.isError).toBe(true);expect(JSON.stringify(failed)).toContain('Knowledge temporarily unavailable; retry.');expect(JSON.stringify(failed)).not.toContain('cards');
    search.mockRestore();const recovered=await handler({query:'cache'});expect(recovered.isError).not.toBe(true);expect(JSON.parse(recovered.content[0].text)).toEqual({cards:[]});
  }finally{await engine?.shutdown();f.close();}
});

it('recovers a committed MCP ask through get_task and retries without duplication',async()=>{
  const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {default:Database}=await import('better-sqlite3');const {serve}=await import('@hono/node-server');
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
  const root=mkdtempSync(join(tmpdir(),'mcp-committed-')),db=join(root,'db.sqlite'),f=repositoryKnowledgeFixture();const store=new Store(db);let reader:InstanceType<typeof Database>|undefined;let engine:Workbench|undefined;let server:ReturnType<typeof serve>|undefined;let client:InstanceType<typeof Client>|undefined;
  try{
    const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];config.ownerId=f.project.ownerId;store.save('projects',f.project);
    engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch});const app=createApp({store,config,engine});
    server=serve({fetch:app.fetch,port:0,hostname:'127.0.0.1'});await new Promise<void>(resolve=>server!.once('listening',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('No listener');
    ingestSource(store,config,{projectId:f.project.id,externalId:'checkpoint',title:'Reference',content:'Reference',purpose:'reference'});const source=store.list('sources').find(s=>s.externalId==='checkpoint')!;
    reader=new Database(db);reader.exec('BEGIN');reader.prepare('SELECT * FROM sources').all();(store as any).db.pragma('busy_timeout = 10');
    expect(()=>store.save('sources',{...source,retention:'ephemeral'})).toThrow();
    const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','src/mcp.ts'],env:{...process.env,PATRICK_URL:`http://127.0.0.1:${address.port}`,PATRICK_MCP_PROJECT:f.project.id,PATRICK_MCP_DOMAIN:f.project.domain,PATRICK_TOKEN:''} as Record<string,string>});
    client=new Client({name:'test',version:'1'});await client.connect(transport);
    const input={requestId:'8c54a565-579f-4cc4-9a46-f4815e0c4561',title:'Question',question:'What happened?'};
    const first=await client.callTool({name:'ask',arguments:input});const result=JSON.parse((first.content as {text:string}[])[0]!.text);
    expect(result).toMatchObject({committed:true,code:'privacy_checkpoint_unavailable',taskId:expect.any(String)});
    reader.exec('ROLLBACK');reader.close();reader=undefined;store.reconcileVault();
    const recovered=await client.callTool({name:'get_task',arguments:{taskId:result.taskId}});expect(JSON.parse((recovered.content as {text:string}[])[0]!.text).task.id).toBe(result.taskId);
    const retry=await client.callTool({name:'ask',arguments:input});expect(JSON.parse((retry.content as {text:string}[])[0]!.text).task.id).toBe(result.taskId);
    expect(store.list('tasks')).toHaveLength(1);
    const changed=await client.callTool({name:'ask',arguments:{...input,question:'Different'}});expect(changed.isError).toBe(true);expect(store.list('tasks')).toHaveLength(1);
  }finally{await client?.close();if(reader){reader.exec('ROLLBACK');reader.close();}await new Promise<void>(resolve=>server?server.close(()=>resolve()):resolve());await engine?.shutdown();store.close();f.close();rmSync(root,{recursive:true,force:true});}
},15000);
