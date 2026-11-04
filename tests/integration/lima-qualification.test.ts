import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandFor, guestScripts } from '../../src/integrations/workers.js';
import { createSyntheticBinding } from '../../scripts/lima/qualify.js';
import { createHash } from 'node:crypto';

const fixturePath=fileURLToPath(new URL('../../scripts/lima/synthetic-worker.mjs',import.meta.url));
const input={role:'execute',task:{version:1,sourceRevision:'synthetic-revision'},plan:{baselineSha:'synthetic-baseline'},project:{projectId:'synthetic'}};
const prompt='SCHEMA:\n{}\nFROZEN INPUT:\n'+JSON.stringify(input);
function run(args:string[],cwd:string,stdin='') {
 return new Promise<{code:number|null;stdout:string;stderr:string}>(resolve=>{
  const child=spawn(process.execPath,[fixturePath,...args],{cwd,env:{HOME:cwd,PATH:process.env.PATH},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.once('close',code=>resolve({code,stdout,stderr}));child.stdin.end(stdin);
 });
}
describe('finite synthetic no-model executable (host protocol; actualGuest=false)',()=>{
 it('accepts actual Grok generated flags and rejects unreviewed fixture selectors',async()=>{
  const root=mkdtempSync(join(tmpdir(),'patrick-qualification-'));
  try{writeFileSync(join(root,'prompt.txt'),prompt);const flags=commandFor('grok','synthetic-model','{}').args;
   const result=await run(['--fixture-case=pass','--fixture-protocol=cli',...flags],root);
   expect(result.code).toBe(0);expect(JSON.parse(result.stdout)).toMatchObject({taskVersion:1,baselineSha:'synthetic-baseline',tests:[{passed:true}]});
   const denied=await run(['--fixture-case=arbitrary','--fixture-protocol=cli',...flags],root);expect(denied.code).toBe(78);expect(denied.stdout+denied.stderr).not.toContain('arbitrary');
  }finally{rmSync(root,{recursive:true,force:true});}
 });
 it('Codex writes the actual result file and emits deliberately irrelevant stdout',async()=>{
  const root=mkdtempSync(join(tmpdir(),'patrick-qualification-'));
  try{const result=await run(['--fixture-case=pass','--fixture-protocol=cli',...commandFor('codex','synthetic-model').args],root,prompt);
   expect(result.code).toBe(0);expect(result.stdout).toBe('synthetic-irrelevant-stdout\n');expect(JSON.parse(readFileSync(join(root,'result.json'),'utf8'))).toMatchObject({taskVersion:1,baselineSha:'synthetic-baseline'});
  }finally{rmSync(root,{recursive:true,force:true});}
 });
 it('qualifier preserves its fixed public signature and rejects duplicate/unknown/missing CLI flags',async()=>{
  const module=await import('../../scripts/lima/qualify.js');
  expect(typeof module.qualify).toBe('function');
  expect(module.parseQualificationArguments(['--instance','local','--user','patrick-grok','--report','/private/report.json'])).toEqual({instance:'local',user:'patrick-grok',reportPath:'/private/report.json'});
  for(const flags of [[],['--skip-control'],['--instance','a','--instance','b'],['--instance','a','--user','patrick-grok','--report','relative']])expect(()=>module.parseQualificationArguments(flags)).toThrow();
 });
});

describe('private sanitized qualification report',()=>{
 it('rejects raw output and invalid identities, and writes an exclusive owner-only report',async()=>{
  const {sanitizeQualificationReport,writeQualificationReport}=await import('../../scripts/lima/qualify.js');
  const root=mkdtempSync(join(realpathSync(tmpdir()),'patrick-qualification-report-'));
  const report={version:1,observedAt:'2026-01-01T00:00:00.000Z',instanceKind:'local-trial',limaVersion:'1.0.0',guestVersion:'24.04',systemdVersion:'255',artifactHash:'a'.repeat(64),policyHash:'b'.repeat(64),inventoryHash:'c'.repeat(64),results:[{id:'grok-pass',status:'pass',reason:'ok',actualGuest:false,synthetic:true,environment:'host-protocol'}],realModelCalls:0,costUsd:0,realProviderAdmission:false,providerAccountFeePrivacyQualified:false,productionMiniQualified:false};
  try{
   expect(()=>sanitizeQualificationReport({...report,raw:'secret'})).toThrow();expect(()=>sanitizeQualificationReport({...report,results:[{...report.results[0],stdout:'secret'}]})).toThrow();
   expect(()=>sanitizeQualificationReport({...report,results:[{...report.results[0],postDrop:{uid:-1}}]})).toThrow();
   const path=join(root,'report.json'),oldMask=process.umask(0o777);try{writeQualificationReport(path,sanitizeQualificationReport(report));}finally{process.umask(oldMask);}expect(statSync(path).mode&0o777).toBe(0o600);
   expect(readFileSync(path,'utf8')).not.toContain('secret');expect(statSync(path).mode&0o777).toBe(0o600);expect(()=>writeQualificationReport(path,sanitizeQualificationReport(report))).toThrow();const unrelated=join(root,'unrelated');writeFileSync(unrelated,'preserved');const linked=join(root,'symlink-report');symlinkSync(unrelated,linked);expect(()=>writeQualificationReport(linked,sanitizeQualificationReport(report))).toThrow();expect(readFileSync(unrelated,'utf8')).toBe('preserved');expect(()=>sanitizeQualificationReport({...report,limaVersion:'https://private.invalid/secret'})).toThrow();
  }finally{rmSync(root,{recursive:true,force:true});}
 });
});

type ProtocolCase='stdout-overflow'|'stderr-overflow'|'pass'|'failed-test'|'exit-nonzero'|'malformed'|'wait'|'codex-missing-result'|'acp-permission'|'acp-non-end-turn'|'acp-early-exit';
function ordinaryFixture(runner:'grok'|'codex'|'dsh',behavior:ProtocolCase='pass',cleanupFailure=false,wrongPermission=false,helperCompletion:'normal'|'nonzero'|'lingering'='normal'){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'patrick-synthetic-adapter-')),bin=join(root,'bin'),workspace=join(root,'work'),eventsPath=join(root,'events'),outcomesPath=join(root,'outcomes');mkdirSync(bin);mkdirSync(workspace);
 const node=process.execPath;
 writeFileSync(join(bin,'limactl'),`#!${node}
(async()=>{
 const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
 const argv=process.argv.slice(2),stage=argv[18],operation=argv[20],args=argv.slice(22),invocation=argv[16],dir='/var/lib/patrick-workspaces/'+invocation+'/work';
 const prefix=['shell','synthetic-instance','--','/usr/bin/sudo','-n','--','/usr/local/libexec/patrick-worker-enter','--runner',${JSON.stringify(runner)},'--user','patrick-synthetic','--project','synthetic','--domain','synthetic'];
 if(JSON.stringify(argv.slice(0,15))!==JSON.stringify(prefix)||argv[15]!=='--invocation'||!/^[a-f0-9]{32}$/.test(invocation)||argv[17]!=='--stage'||argv[19]!=='--operation'||argv[21]!=='--')process.exit(78);
 const scripts=${JSON.stringify(guestScripts)},work=${JSON.stringify(workspace)},log=v=>fs.appendFileSync(${JSON.stringify(eventsPath)},JSON.stringify(v)+'\\n');
 log({stage:operation==='exec'?stage:operation,prefix,invocation});
 let recorded=false;const outcome=code=>{if(recorded)return;recorded=true;fs.appendFileSync(${JSON.stringify(outcomesPath)},JSON.stringify({stage,outcome:{phase:'complete',code,submitterExited:true,invocationClosed:true}})+'\\n');};
 if(operation!=='exec'){
  process.stdin.resume();process.stdout.write(JSON.stringify({version:1,state:operation==='stop'?'drained':'closed',cgroupsEmpty:true,workerProcessesAbsent:true,workspacesAbsent:operation==='reconcile',privateMountsAbsent:true,invocationClosed:operation==='reconcile',reason:'ok'}));return;
 }
 if(stage==='cli'||stage==='acp'){
  const extra=stage==='cli'?args.slice(6):args.slice(1);
  if(stage==='cli'&&(args[0]!=='sh'||args[3]!=='patrick'||args[4]!==dir||args[5]!=='/usr/local/libexec/patrick-worker/synthetic-worker.mjs')||stage==='acp'&&args[0]!=='/usr/local/libexec/patrick-worker/synthetic-worker.mjs')process.exit(78);
  const child=cp.spawn(${JSON.stringify(node)},[${JSON.stringify(fixturePath)},...extra],{cwd:work,env:{HOME:work,PATH:${JSON.stringify(process.env.PATH)}},stdio:['pipe','pipe','pipe']});
  if(${JSON.stringify(wrongPermission)}){let pending='';process.stdin.on('data',chunk=>{pending+=chunk;let index;while((index=pending.indexOf('\\n'))>=0){const line=pending.slice(0,index);pending=pending.slice(index+1);const value=JSON.parse(line);if(value.id===9001)value.result={outcome:{outcome:'selected',optionId:'allow'}};child.stdin.write(JSON.stringify(value)+'\\n');}});process.stdin.on('end',()=>child.stdin.end());}else process.stdin.pipe(child.stdin);child.stdin.on('error',()=>{});let outBytes=0,errBytes=0;child.stdout.on('data',c=>{outBytes+=c.length;if(outBytes>2000000)outcome(null);});child.stderr.on('data',c=>{errBytes+=c.length;if(errBytes>2000000)outcome(null);});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);process.on('SIGTERM',()=>{child.kill('SIGKILL');process.exit(143);});child.once('close',(code,signal)=>{if(stage==='acp'&&${JSON.stringify(helperCompletion)}==='lingering'){setInterval(()=>{},1000);return;}const actual=stage==='acp'&&${JSON.stringify(helperCompletion)}==='nonzero'?78:signal?null:code;outcome(actual);process.exit(actual??78);});return;
 }
 if(args[0]!=='node'||args[1]!=='-e'||args[2]!==scripts[stage]||args[3]!==dir)process.exit(78);
 let data='';for await(const chunk of process.stdin)data+=chunk;
 if(stage==='prepare'){const p=JSON.parse(data);fs.writeFileSync(path.join(work,'prompt.txt'),p.prompt);fs.writeFileSync(path.join(work,'schema.json'),JSON.stringify(p.schema));process.stdout.write(JSON.stringify({dir}));}
 else if(stage==='read'){try{process.stdout.write(fs.readFileSync(path.join(work,'result.json'),'utf8'));}catch{outcome(1);process.exit(1);}}
 else if(stage==='tests'){const p=JSON.parse(data);for(const file of p.files)fs.writeFileSync(path.join(work,file.path),file.content);const results=p.commands.map(command=>{const r=cp.spawnSync('/bin/sh',['-c',command],{cwd:work,env:{PATH:${JSON.stringify(process.env.PATH)},HOME:work},timeout:1000});return {command,passed:r.status===0,output:'exit '+r.status};});process.stdout.write(JSON.stringify(results));}
 else if(stage==='cleanup'){if(${JSON.stringify(cleanupFailure)})process.exit(78);for(const name of fs.readdirSync(work))fs.rmSync(path.join(work,name),{recursive:true,force:true});}else process.exit(78);
 outcome(0);
})().catch(()=>process.exit(78));
`,{mode:0o700});
 vi.stubEnv('PATH',bin);const bound=createSyntheticBinding({instance:'synthetic-instance',binding:{runner,user:'patrick-synthetic',projectId:'synthetic',domain:'synthetic',uid:1101,gid:1101,home:'/var/lib/patrick-synthetic',proxyPort:runner==='grok'?18743:runner==='codex'?18744:18745},fixtureCase:behavior,policyHash:'a'.repeat(64),artifactHash:'b'.repeat(64),inventoryHash:'c'.repeat(64),fixtureHash:createHash('sha256').update(readFileSync(fixturePath)).digest('hex')});
 return {root,...bound,outcomes:()=>existsSync(outcomesPath)?readFileSync(outcomesPath,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[],events:()=>existsSync(eventsPath)?readFileSync(eventsPath,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[],close(){bound.dispose();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});}};
}
describe('ordinary adapters with finite process fixture (host-protocol; actualGuest=false)',()=>{
 it.each(['grok','codex','dsh'] as const)('runs real %s flags/protocol, immutable prefix and finalization',async runner=>{
  const f=ordinaryFixture(runner);try{const result=await f.worker.run(f.input);expect(result).toMatchObject({costUsd:0,model:'synthetic-model',provider:'synthetic-provider',output:{tests:[{passed:true,output:'exit 0'}]}});
   const events=f.events();expect(events.map(e=>e.stage)).toEqual(['prepare',runner==='dsh'?'acp':'cli',...(runner==='codex'?['read']:[]),'tests','stop','cleanup','reconcile']);expect(new Set(events.map(e=>JSON.stringify(e.prefix))).size).toBe(1);expect(new Set(events.map(e=>e.invocation)).size).toBe(1);
  }finally{f.close();}
 });
 it('actual failed planned command overrides fabricated passing model tests',async()=>{const f=ordinaryFixture('grok','failed-test');try{const result=await f.worker.run(f.input);expect(result.output).toMatchObject({tests:[{command:"node -e 'process.exit(23)'",passed:false,output:'exit 23'}]});}finally{f.close();}});
 it.each([['grok','exit-nonzero'],['grok','malformed'],['codex','codex-missing-result'],['dsh','acp-permission'],['dsh','acp-non-end-turn'],['dsh','acp-early-exit']] as const)('rejects %s %s before planned tests and always finalizes',async(runner,behavior)=>{const f=ordinaryFixture(runner,behavior);try{await expect(f.worker.run(f.input)).rejects.toBeDefined();expect(f.events().map(e=>e.stage)).not.toContain('tests');expect(f.events().slice(-3).map(e=>e.stage)).toEqual(['stop','cleanup','reconcile']);}finally{f.close();}});
 it('cleanup failure overrides CLI failure and preserves the primary cause',async()=>{const f=ordinaryFixture('grok','exit-nonzero',true);try{const error=await f.worker.run(f.input).catch(e=>e);expect(error).toMatchObject({code:'worker_cleanup_unconfirmed',cause:{name:'WorkerUnavailable'}});}finally{f.close();}});
 it('abort during real finite wait still performs fresh stop/cleanup/reconcile',async()=>{const f=ordinaryFixture('grok','wait'),controller=new AbortController();try{const pending=f.worker.run(f.input,controller.signal),rejected=expect(pending).rejects.toBeDefined();for(let i=0;i<100&&!f.events().some(e=>e.stage==='cli');i++)await new Promise(r=>setTimeout(r,5));controller.abort();await rejected;expect(f.events().slice(-3).map(e=>e.stage)).toEqual(['stop','cleanup','reconcile']);}finally{f.close();}});
});

it('fixture source has only finite built-in dependencies and the sole same-file detached child case',()=>{
 const source=readFileSync(fixturePath,'utf8'),imports=[...source.matchAll(/from '([^']+)'/g)].map(m=>m[1]);expect(imports.sort()).toEqual(['node:child_process','node:fs','node:readline','node:url']);expect(source.match(/spawn\(/g)).toHaveLength(1);expect(source).toContain("fileURLToPath(import.meta.url),'--fixture-case=wait','--fixture-protocol=cli'");expect(source).not.toMatch(/https?:\/\/|node:net|node:dns|node:https|fetch\(/);
});

it('exposes the genuine fixed synthetic Store/proof factory without a transport or executable override',async()=>{
 const module=await import('../../scripts/lima/qualify.js');expect(typeof module.createSyntheticBinding).toBe('function');
 const declaration={instance:'synthetic-instance',binding:{runner:'grok' as const,user:'patrick-synthetic',projectId:'synthetic',domain:'synthetic',uid:1101,gid:1101,home:'/var/lib/patrick-synthetic',proxyPort:18743},fixtureCase:'pass',policyHash:'a'.repeat(64),artifactHash:'b'.repeat(64),inventoryHash:'c'.repeat(64),fixtureHash:createHash('sha256').update(readFileSync(fixturePath)).digest('hex')};
 for(const value of [{...declaration,fixtureCase:'unreviewed'},{...declaration,fixtureHash:'0'.repeat(64)},{...declaration,binding:{...declaration.binding,uid:0}},{...declaration,command:'codex'},{...declaration,transport:()=>{}}])expect(()=>module.createSyntheticBinding(value)).toThrow('trust');
 const synthetic=module.createSyntheticBinding(declaration);try{expect(Object.keys(synthetic).sort()).toEqual(['dispose','input','worker']);expect(synthetic.input.project.id).toBe('synthetic');}finally{synthetic.dispose();}
});

it('rejects mismatched caller task scope from the genuine factory before any transport',async()=>{
 const f=ordinaryFixture('grok');try{f.input.task.projectId='mismatched-synthetic-project';await expect(f.worker.run(f.input)).rejects.toMatchObject({code:'subscription_scope'});expect(f.events()).toEqual([]);}finally{f.close();}
});


describe('scenario-specific qualification decisions through ordinary adapters (host protocol only)',()=>{
 it.each([['cli-nonzero','grok','exit-nonzero'],['malformed-output','grok','malformed'],['codex-missing-result','codex','codex-missing-result'],['acp-permission','dsh','acp-permission'],['acp-non-end-turn','dsh','acp-non-end-turn'],['acp-early-exit','dsh','acp-early-exit'],['stdout-overflow','grok','stdout-overflow'],['stderr-overflow','grok','stderr-overflow']] as const)('requires the actual %s failure and trusted outcomes',async(id,runner,behavior)=>{
  const f=ordinaryFixture(runner,behavior);try{const error=await f.worker.run(f.input).catch(e=>e),module=await import('../../scripts/lima/qualify.js');expect(module.negativeScenarioMatches(id,error,f.outcomes())).toBe(true);const workers=await import('../../src/integrations/workers.js');expect(Object.isFrozen(workers.limaFailureEvidence(error))).toBe(true);expect(module.negativeScenarioMatches(id,error,f.outcomes().map(o=>({...o,outcome:{...o.outcome,pid:777}})))).toBe(false);expect(module.negativeScenarioMatches(id,error,f.outcomes().map(o=>({...o,outcome:{...o.outcome,phase:'unknown'}})))).toBe(false);expect(module.negativeScenarioMatches(id,new Error('unrelated transport failure'),f.outcomes())).toBe(false);expect(module.negativeScenarioMatches(id,error,f.outcomes().map(o=>({...o,outcome:{...o.outcome,invocationClosed:false}})))).toBe(false);expect(f.events().map(e=>e.stage)).not.toContain('tests');}finally{f.close();}
 });
 it('rejects the wrong ACP permission response even though the adapter requested cancellation',async()=>{
  const f=ordinaryFixture('dsh','acp-permission',false,true);try{const error=await f.worker.run(f.input).catch(e=>e),module=await import('../../scripts/lima/qualify.js');expect(f.outcomes().find(o=>o.stage==='acp')?.outcome.code).toBe(78);expect(module.negativeScenarioMatches('acp-permission',error,f.outcomes())).toBe(false);}finally{f.close();}
 });
 it.each(['nonzero','lingering'] as const)('does not certify cancellation when helper completion is %s',async completion=>{
  const f=ordinaryFixture('dsh','acp-permission',false,false,completion);try{const error=await f.worker.run(f.input).catch(e=>e),module=await import('../../scripts/lima/qualify.js'),workers=await import('../../src/integrations/workers.js');expect(workers.limaFailureEvidence(error)).toBeUndefined();expect(module.negativeScenarioMatches('acp-permission',error,f.outcomes())).toBe(false);expect(f.events().map(e=>e.stage)).not.toContain('tests');}finally{f.close();}
 },7000);
 it('cannot certify malformed output from an unrelated CLI nonzero exit or fabricated error properties',async()=>{
  const f=ordinaryFixture('grok','exit-nonzero');try{const error=await f.worker.run(f.input).catch(e=>e),module=await import('../../scripts/lima/qualify.js');expect(module.negativeScenarioMatches('malformed-output',error,f.outcomes())).toBe(false);expect(module.negativeScenarioMatches('stdout-overflow',Object.assign(new Error(),{name:'WorkerUnavailable',kind:'stdout-overflow'}),f.outcomes())).toBe(false);}finally{f.close();}
 });
});
