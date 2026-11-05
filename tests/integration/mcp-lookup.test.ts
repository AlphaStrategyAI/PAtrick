import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { configureDemo, demoResearch, demoWriter } from '../../src/demo.js';
import { DomainError } from '../../src/domain.js';
import { Workbench } from '../../src/orchestrator.js';
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
