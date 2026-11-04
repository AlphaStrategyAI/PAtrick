import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture as lifetimeFixture } from '../fixtures/lima-lifetime.mjs';
import { describe, expect, it, vi } from 'vitest';
import { DomainError, SubscriptionAccessError, type AppConfig, type WorkerInput, type WorkerResult } from '../../src/domain.js';
import { LimaWorker, parseWorkerOutput, commandFor, guestScripts } from '../../src/integrations/workers.js';
import { bindSyntheticLimaBilling } from '../fixtures/billing.js';
import { Scheduler } from '../../src/scheduler.js';
import { BillingAuthority, type HostDispatchPermit } from '../../src/billing.js';

describe('worker protocols', () => {
  it('ships syntactically executable isolation, test and cleanup scripts', () => {
    for(const script of Object.values(guestScripts))expect(()=>new Function(script)).not.toThrow();
  });
  it('unwraps structured CLI envelopes without accepting arbitrary logs as JSON', () => {
    expect(parseWorkerOutput('{"structured_output":{"summary":"ok"}}')).toEqual({summary:'ok'});
    expect(parseWorkerOutput('```json\n{"summary":"ok"}\n```')).toEqual({summary:'ok'});
    expect(()=>parseWorkerOutput('Authorization failed')).toThrow();
  });
  it('uses read-only, ephemeral noninteractive Codex and constrained Grok output', () => {
    expect(commandFor('codex','model').args).toContain('read-only');
    expect(commandFor('codex','model').args).toContain('--ephemeral');
    expect(commandFor('codex','model').args).not.toContain('--ignore-rules');
    expect(commandFor('grok','model').args).toContain('--no-subagents');
    expect(commandFor('grok','model').args).toContain('--json-schema');
  });
});

describe('Lima host transport environment', () => {
  it.each([true, false])('uses the selected instance store with private LIMA_HOME configured: %s', async privateHome => {
    const root = mkdtempSync(join(tmpdir(), 'patrick-lima-home-'));
    let bound: ReturnType<typeof bindSyntheticLimaBilling> | undefined;
    try {
      const bin = join(root, 'bin'), home = join(root, 'home'), temporary = join(root, 'tmp');
      const limaHome = privateHome ? join(root, 'private-lima') : join(home, '.lima');
      for (const path of [bin, home, temporary, limaHome]) mkdirSync(path, { recursive: true, mode: 0o700 });
      writeFileSync(join(limaHome, 'fixture-instance'), 'synthetic instance only');
      const eventsPath = join(root, 'events.jsonl');
      const failurePath = join(root, 'failure.txt');
      const blocked = ['FEISHU_APP_SECRET', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'OPENAI_API_KEY', 'RESEARCH_TOKEN', 'PATRICK_AUTH_TOKEN', 'SSH_AUTH_SOCK', 'LIMA_SENTINEL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'];
      const output = { summary: 'Fixture protocol completed', observations: ['Synthetic result'] };
      // Model only the limactl process protocol; never execute guest scripts or a real runner.
      writeFileSync(join(bin, 'limactl'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const scripts = ${JSON.stringify(guestScripts)}, output = ${JSON.stringify(output)};
const eventsPath = ${JSON.stringify(eventsPath)}, blocked = ${JSON.stringify(blocked)};
const limaHome = process.env.LIMA_HOME ?? path.join(process.env.HOME, '.lima');
// macOS adds this runtime metadata even when spawn receives an explicit environment.
const keys = Object.keys(process.env).filter(key => key !== '__CF_USER_TEXT_ENCODING').sort();
const leaked = blocked.filter(key => process.env[key] !== undefined);
const argv = process.argv.slice(2), prefix = argv.slice(3,15), args = argv.slice(22), invocation=argv[16], operation=argv[20], dir = '/var/lib/patrick-workspaces/'+invocation+'/work';
function fail(message) { fs.writeFileSync(${JSON.stringify(failurePath)}, message + ': ' + keys.join(',')); process.exit(78); }
if (leaked.length || keys.some(key => !['PATH', 'HOME', 'TMPDIR', 'LIMA_HOME'].includes(key))) fail('Host environment leaked');
if (argv[0] !== 'shell' || argv[1] !== 'fixture-instance' || argv[2] !== '--') fail('Unexpected limactl command');
if (JSON.stringify(prefix) !== JSON.stringify(['/usr/bin/sudo','-n','--','/usr/local/libexec/patrick-worker-enter','--runner','grok','--user','patrick-grok','--project','fixture-project','--domain','personal'])) fail('Missing fixed identity and scope');
if (!fs.existsSync(path.join(limaHome, 'fixture-instance'))) fail('Fixture instance unavailable in selected Lima home');
const active = path.join(limaHome, 'workspace-active');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  let stage;
  if(operation!=='exec'){stage=operation;process.stdout.write(JSON.stringify({version:1,state:operation==='stop'?'drained':'closed',cgroupsEmpty:true,workerProcessesAbsent:true,workspacesAbsent:operation==='reconcile',privateMountsAbsent:true,invocationClosed:operation==='reconcile',reason:'ok'}));}
  else if (args[0] === 'node' && args[1] === '-e' && args[2] === scripts.prepare) {
    const payload = JSON.parse(input);
    if (payload.schema.type !== 'object' || !payload.prompt.includes('feedback worker') || payload.files.length) fail('Invalid preparation payload');
    stage = 'prepare'; fs.writeFileSync(active, dir); process.stdout.write(JSON.stringify({ dir }));
  } else if (args[0] === 'sh' && args[4] === dir && args[5] === 'fixture-grok' && args.includes('fixture-model')) {
    if (!fs.existsSync(active) || input !== '') fail('CLI started without prepared workspace');
    stage = 'cli'; process.stdout.write(JSON.stringify({ structured_output: output }));
  } else if (args[0] === 'node' && args[1] === '-e' && args[2] === scripts.cleanup && args[3] === dir) {
    if (!fs.existsSync(active)) fail('Cleanup without prepared workspace');
    stage = 'cleanup'; fs.unlinkSync(active);
  } else fail('Unexpected guest command');
  fs.appendFileSync(eventsPath, JSON.stringify({ stage, limaHome, keys, leaked, PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }) + '\\n');
});
`, { mode: 0o700 });
      vi.stubEnv('PATH', bin);
      vi.stubEnv('HOME', home);
      vi.stubEnv('TMPDIR', temporary);
      vi.stubEnv('LIMA_HOME', privateHome ? limaHome : undefined);
      for (const key of blocked) vi.stubEnv(key, `synthetic-${key}`);

      const createdAt = '2026-01-01T00:00:00.000Z';
      const project: WorkerInput['project'] = { id: 'fixture-project', projectId: 'fixture-project', domain: 'personal', name: 'Fixture', description: 'Synthetic transport test', repository: 'fixture/repo', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/'], trustedChecks: [], trustedAppIds: [], ownerId: 'fixture-owner', autoMerge: false, budgetUsd: 1, createdAt };
      const source: WorkerInput['source'] = { id: 'fixture-source', projectId: project.id, domain: project.domain, kind: 'manual', externalId: 'fixture', revision: 'fixture-revision', title: 'Fixture', content: 'Synthetic input', locator: 'manual:fixture', authorId: project.ownerId, retention: 'ephemeral', status: 'active', createdAt };
      const task: WorkerInput['task'] = { id: 'fixture-task', projectId: project.id, domain: project.domain, sourceId: source.id, sourceRevision: source.revision, title: source.title, description: source.content, status: 'feedback', version: 1, createdAt, updatedAt: createdAt, runAfter: createdAt, attempts: 0, repairCount: 0, budgetUsd: 1, spentUsd: 0, stage: 'feedback' };
      const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: root, vaultDir: root, ownerId: project.ownerId, authToken: 'synthetic-auth', sessionSecret: 'synthetic-session', projects: [project], scanIntervalMs: 1000, workers: { grok: { command: 'fixture-grok', args: [], timeoutMs: 5000, isolation: 'lima', instance: 'fixture-instance' } }, runnerPolicies: [{ runner: 'grok', roles: ['feedback'], domains: [project.domain], provider: 'fixture-provider', model: 'fixture-model', admitted: true, costPerRunUsd: 0, independentReview: false }] };

      const input: WorkerInput = { task, project, source, role: 'feedback', cards: [], rules: [] };
      bound = bindSyntheticLimaBilling(config, input);
      const run = new LimaWorker('grok', config, bound.billing).run(input).catch(error => {
        if (existsSync(failurePath)) error.message += ` ${readFileSync(failurePath, 'utf8')}`;
        throw error;
      });
      await expect(run).resolves.toEqual({ output, costUsd: 0, provider: 'fixture-provider', model: 'fixture-model' });
      const events = readFileSync(eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const keys = ['PATH', 'HOME', 'TMPDIR', ...(privateHome ? ['LIMA_HOME'] : [])].sort();
      expect(events).toEqual(['prepare', 'cli', 'stop', 'cleanup', 'reconcile'].map(stage => ({ stage, limaHome, keys, leaked: [], PATH: bin, HOME: home, TMPDIR: temporary })));
      expect(existsSync(join(limaHome, 'workspace-active'))).toBe(false);
      expect(bound.store.list('attempts')).toHaveLength(1);
    } finally {
      bound?.dispose();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

type FixtureOptions={runner?:'grok'|'codex'|'dsh';role?:'feedback'|'execute'|'check';fail?:string;holdCli?:boolean;cleanupFailure?:boolean;acpBehavior?:'early'|'non-end-turn'|'permission'|'stdout-overflow'|'stderr-overflow'|'abort'};
function protocolFixture(options:FixtureOptions={}) {
  const root=mkdtempSync(join(tmpdir(),'patrick-identity-protocol-')),bin=join(root,'bin'),eventsPath=join(root,'events');mkdirSync(bin);
  const runner=options.runner??'grok',role=options.role??'feedback',createdAt='2026-01-01T00:00:00.000Z';
  const project:WorkerInput['project']={id:'bound-project',projectId:'bound-project',domain:'私人领域',name:'Fixture',description:'',repository:'fixture/repo',repositoryProvider:'github',prdPath:'docs/PRD.md',allowedPaths:['docs/'],trustedChecks:[],trustedAppIds:[],ownerId:'owner',autoMerge:false,budgetUsd:0,createdAt};
  const source:WorkerInput['source']={id:'source',projectId:project.id,domain:project.domain,kind:'manual',externalId:'fixture',revision:'revision',title:'fixture',content:'',locator:'fixture',authorId:'owner',retention:'ephemeral',status:'active',createdAt};
  const task:WorkerInput['task']={id:'task',projectId:project.id,domain:project.domain,sourceId:source.id,sourceRevision:source.revision,title:'fixture',description:'',status:'feedback',version:1,createdAt,updatedAt:createdAt,runAfter:createdAt,attempts:0,repairCount:0,budgetUsd:0,spentUsd:0,stage:role};
  const literal='fixture-model;$(touch /tmp/never-executed)';
  const config:AppConfig={mode:'test',host:'localhost',port:1,dataDir:root,vaultDir:root,ownerId:'owner',authToken:'',sessionSecret:'',projects:[project],scanIntervalMs:1000,workers:{[runner]:{command:`fixture-${runner}`,args:['literal;$(id)'],isolation:'lima',instance:'fixture-instance',guestUser:'patrick-dedicated',timeoutMs:5000}},runnerPolicies:[{runner,roles:[role],domains:[project.domain],provider:'fixture',model:literal,admitted:true,costPerRunUsd:0,independentReview:false}]};
  const input:WorkerInput={task,project,source,role,cards:[],rules:[],...(['execute','check'].includes(role)?{plan:{taskVersion:1,sourceRevision:'revision',baselineSha:'base',summary:'fixture',paths:['docs/PRD.md'],steps:['write'],tests:['literal test;$(id)'],stopConditions:['stop']}}:{})};
  const output=role==='check'?{taskVersion:1,planHash:'hash',artifactHash:'artifact',verdict:'pass',summary:'fixture',issues:[],tests:[{command:'declared',passed:false,output:'untrusted'}]}:role==='execute'?{taskVersion:1,planHash:'hash',baselineSha:'base',files:[{path:'docs/PRD.md',content:'fixture'}],tests:[{command:'declared',passed:false,output:'untrusted'}],summary:'fixture'}:{summary:'fixture',observations:[]};
  if(role==='check')input.artifact={taskVersion:1,planHash:'hash',baselineSha:'base',files:[{path:'docs/PRD.md',content:'fixture'}],tests:[{command:'declared',passed:false,output:'untrusted'}],summary:'fixture'};
  const prefix=['/usr/bin/sudo','-n','--','/usr/local/libexec/patrick-worker-enter','--runner',runner,'--user','patrick-dedicated','--project',project.projectId,'--domain',project.domain,'--'];
  writeFileSync(join(bin,'limactl'),`#!${process.execPath}
const fs=require('node:fs'),readline=require('node:readline');
const options=${JSON.stringify(options)},scripts=${JSON.stringify(guestScripts)},output=${JSON.stringify(output)},prefix=${JSON.stringify(prefix)};
const argv=process.argv.slice(2),args=argv.slice(22),invocation=argv[16],operation=argv[20],dir='/var/lib/patrick-workspaces/'+invocation+'/work';
if(JSON.stringify(argv.slice(0,3))!==JSON.stringify(['shell','fixture-instance','--'])||JSON.stringify(argv.slice(3,15))!==JSON.stringify(prefix.slice(0,-1))||!/^[a-f0-9]{32}$/.test(invocation)||argv[15]!=='--invocation'||argv[17]!=='--stage'||argv[19]!=='--operation'||argv[21]!=='--')process.exit(78);
let stage=operation!=='exec'?operation:args[0]==='node'?(args[2]===scripts.prepare?'prepare':args[2]===scripts.tests?'tests':args[2]===scripts.read?'read':args[2]===scripts.cleanup?'cleanup':'invalid'):args[0]==='sh'?'cli':args[0]==='fixture-dsh'?'acp':'invalid';
fs.appendFileSync(${JSON.stringify(eventsPath)},JSON.stringify({stage,prefix,args,invocation,profile:['cli','acp'].includes(argv[18])?'authenticated-client':'task-only',purpose:argv[18],operation})+'\\n');
if(stage===options.fail||(stage==='cleanup'&&options.cleanupFailure))process.exit(78);
if(stage==='stop'||stage==='reconcile'){process.stdout.write(JSON.stringify({version:1,state:stage==='stop'?'drained':'closed',cgroupsEmpty:true,workerProcessesAbsent:true,workspacesAbsent:stage==='reconcile',privateMountsAbsent:true,invocationClosed:stage==='reconcile',reason:'ok'}));}
else if(stage==='cli'&&options.holdCli){setInterval(()=>{},1000);process.stdin.resume();}
else if(stage==='acp') {
 if(options.acpBehavior==='early')process.exit(0);
 if(options.acpBehavior==='stdout-overflow')process.stdout.write('x'.repeat(2000001));
 if(options.acpBehavior==='stderr-overflow')process.stderr.write('x'.repeat(2000001));
 let promptId;
 const lines=readline.createInterface({input:process.stdin});
 const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
 lines.on('line',line=>{const message=JSON.parse(line);let result;
 if(message.id===999&&!message.method){if(message.result?.outcome?.outcome!=='cancelled')process.exit(78);fs.appendFileSync(${JSON.stringify(eventsPath)},JSON.stringify({stage:'permission-cancelled'})+'\\n');send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}});return;}
 if(message.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:false}};
 else if(message.method==='session/new')result={sessionId:'fixture-session'};
 else if(message.method==='session/prompt'){
 if(options.acpBehavior==='abort'){setInterval(()=>{},1000);return;}
 if(options.acpBehavior==='permission'){promptId=message.id;send({jsonrpc:'2.0',id:999,method:'session/request_permission',params:{sessionId:'fixture-session',toolCall:{toolCallId:'fixture-tool'},options:[{optionId:'allow',name:'Allow',kind:'allow_once'}]}});return;}
 send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(output)}}}});result={stopReason:options.acpBehavior==='non-end-turn'?'max_tokens':'end_turn'};}
 else process.exit(78);
 send({jsonrpc:'2.0',id:message.id,result});});
} else {let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
 if(stage==='prepare'){const payload=JSON.parse(input);if(JSON.stringify(Object.keys(payload).sort())!==JSON.stringify(['files','prompt','schema'])||/synthetic-(account|workspace|route|evidence)|noChargeEvidenceDigest|[\"]permit[\"]/.test(payload.prompt))process.exit(78);process.stdout.write(JSON.stringify({dir}));}
 else if(stage==='cli'){if(!args.includes(${JSON.stringify(literal)})||!args.includes('literal;$(id)'))process.exit(78);process.stdout.write(JSON.stringify(output));}
 else if(stage==='read')process.stdout.write(JSON.stringify(output));
 else if(stage==='tests'){const payload=JSON.parse(input);if(payload.commands[0]!=='literal test;$(id)')process.exit(78);process.stdout.write(JSON.stringify([{command:payload.commands[0],passed:true,output:'actual synthetic test'}]));}
 else if(stage!=='cleanup')process.exit(78);
 });}
`,{mode:0o700});
  vi.stubEnv('PATH',bin);
  const bound=bindSyntheticLimaBilling(config,input);
  return {root,bin,output,input,config,...bound,events:()=>existsSync(eventsPath)?readFileSync(eventsPath,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[],close:()=>{bound.dispose();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});}};
}

// Host-protocol fixture: real root lifecycle records/locks/ACK gate with a
// local NDJSON server. No Linux service/profile/guest qualification is claimed.
function lifecycleProtocolFixture(role:'execute'|'check',unconfirmed=false) {
 const f=protocolFixture({runner:'dsh',role}),root=join(f.root,'lifecycle');mkdirSync(root);
 const context={runner:'dsh',user:'patrick-dedicated',projectId:f.input.project.projectId,domain:f.input.project.domain};
 const options={root,scope:context,account:{uid:1101,gid:1101,home:'/var/lib/patrick-dedicated',groups:[]}};
 const controller=lifetimeFixture(options),events=join(root,'protocol-events'),release=join(root,'finish-acp');
 const fixtureModule=new URL('../fixtures/lima-lifetime.mjs',import.meta.url).href,lifetimeModule=new URL('../../scripts/lima/stage-lifetime.mjs',import.meta.url).href;
 const server=String.raw`
const fs=require('node:fs'),readline=require('node:readline'),events=process.argv[1],release=process.argv[2],output=JSON.parse(process.argv[3]);
const log=event=>fs.appendFileSync(events,JSON.stringify({event})+'\n');
const lines=readline.createInterface({input:process.stdin}),send=value=>process.stdout.write(JSON.stringify(value)+'\n');
lines.on('line',line=>{const m=JSON.parse(line);let result;
 if(m.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:false}};
 else if(m.method==='session/new')result={sessionId:'fixture-session'};
 else if(m.method==='session/prompt'){
  if(!m.params.prompt[0].text.includes('FROZEN INPUT:')||m.params.sessionId!=='fixture-session')process.exit(78);
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(output)}}}});
  result={stopReason:'end_turn'};log('end_turn');
 }else process.exit(78);
 send({jsonrpc:'2.0',id:m.id,result});
});
lines.on('close',()=>{log('input-eof');const interval=setInterval(()=>{if(fs.existsSync(release)){clearInterval(interval);log('server-exit');process.exit(0);}},5);});
`;
 writeFileSync(join(f.bin,'limactl'),`#!${process.execPath}
(async()=>{
 const fs=require('node:fs'),{spawn}=require('node:child_process');
 const {fixture}=await import(${JSON.stringify(fixtureModule)}),lifetime=await import(${JSON.stringify(lifetimeModule)});
 const f=fixture(${JSON.stringify(options)}),argv=process.argv.slice(2),stage=argv[18],operation=argv[20],invocation=argv[16],command=argv.slice(22);
 const request={context:${JSON.stringify(context)},lifetime:{invocation,stage,operation,profile:lifetime.profileFor(stage)},command};
 const events=${JSON.stringify(events)},log=event=>fs.appendFileSync(events,JSON.stringify({event,stage,operation})+'\\n');
 log('request');
 if(stage==='tests'&&operation==='exec'){
  const r=f.record(invocation),prior=r.stages.at(-1);
  if(prior.stage!=='acp'||prior.phase!=='complete'||r.payloadSealed){log('tests-before-confirmation');}
 }
 f.deps.observe=()=>({workerProcessesAbsent:true,privateMountsAbsent:true,cgroupsEmpty:!fs.existsSync(${JSON.stringify(join(root,'uncertain'))})});
 const submit=f.deps.manager.submit;let server;
 process.on('SIGTERM',()=>{server?.kill('SIGKILL');process.exit(143);});
 f.deps.manager.submit=spec=>{
  const done=f.hold(),launched=submit(spec);
  return {...launched,release:()=>{
   if(f.record(invocation).stages.at(-1).phase!=='acknowledged')throw Error('gate before ACK');log('gate-release');
   if(spec.stage==='acp'){
    server=spawn('/bin/sh',['-c',lifetime.gateWrapper,'patrick-worker',${JSON.stringify(process.execPath)},'-e',${JSON.stringify(server)},events,${JSON.stringify(release)},${JSON.stringify(JSON.stringify(f.output))}],{cwd:f.root,env:{HOME:f.root},stdio:['pipe','pipe','pipe']});
    server.stdout.pipe(process.stdout,{end:false});server.stderr.resume();server.stdin.on('error',()=>{});
    server.on('close',(code,signal)=>{${unconfirmed?"fs.writeFileSync("+JSON.stringify(join(root,'uncertain'))+",'unconfirmed drain');":''}done.resolve({code:signal?null:code});});
    server.stdin.write(lifetime.releaseLine);process.stdin.pipe(server.stdin);
   }else{
    let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
     if(spec.stage==='prepare'){const p=JSON.parse(input);if(!p.prompt.includes('FROZEN INPUT:'))throw Error('lost prompt');process.stdout.write(JSON.stringify({dir:spec.workspace}));}
     if(spec.stage==='tests'){const p=JSON.parse(input);process.stdout.write(JSON.stringify(p.commands.map(command=>({command,passed:true,output:'actual synthetic test'}))));}
     done.resolve({code:0});
    });process.stdin.resume();
   }
  },cancelInput:()=>{server?.kill('SIGKILL');}};
 };
 try{const result=await lifetime.executeStage(request,f.deps);log('helper-confirmed');if(operation!=='exec')process.stdout.write(JSON.stringify(result));process.exitCode=0;}
 catch{log('helper-unconfirmed');process.exitCode=78;}
})().catch(()=>{process.exitCode=78;});
`,{mode:0o700});
 return {...f,controller,release:()=>writeFileSync(release,'complete'),events:()=>existsSync(events)?readFileSync(events,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[]};
}

describe('ACP actual lifecycle stage handoff',()=>{
 it.each(['execute','check'] as const)('waits for successful ACP helper completion before %s tests',async role=>{
  const f=lifecycleProtocolFixture(role);let run:Promise<any>|undefined;
  try{
   run=new LimaWorker('dsh',f.config,f.billing).run(f.input).catch(error=>error);
   for(let i=0;i<200&&!f.events().some(e=>e.event==='end_turn');i++)await new Promise(r=>setTimeout(r,5));
   expect(f.events().some(e=>e.event==='end_turn')).toBe(true);
   await new Promise(r=>setTimeout(r,75));
   expect(f.events().filter(e=>e.stage==='tests')).toEqual([]);
   const token=readdirSync(f.controller.physical('/run/patrick-worker/invocations'))[0]!.slice(0,32);
   expect(f.controller.record(token)).toMatchObject({state:'active',payloadSealed:false,sequence:2,stages:[{stage:'prepare',phase:'complete'},{stage:'acp',phase:'acknowledged'}]});
   expect(f.events().filter(e=>e.stage==='acp'&&e.event==='helper-confirmed')).toEqual([]);
   f.release();const result=await run;expect(result).toMatchObject({costUsd:0,output:{tests:[{passed:true,output:'actual synthetic test'}]}});
   const events=f.events(),confirmed=events.findIndex(e=>e.stage==='acp'&&e.event==='helper-confirmed'),tests=events.findIndex(e=>e.stage==='tests'&&e.event==='request');
   expect(confirmed).toBeGreaterThan(-1);expect(tests).toBeGreaterThan(confirmed);expect(events.some(e=>e.event==='tests-before-confirmation')).toBe(false);
   expect(events.some(e=>e.event==='input-eof')).toBe(true);expect(f.controller.record(token)).toMatchObject({state:'closed',payloadSealed:true});
  }finally{f.release();await run;f.close();}
 });
 it('fails a lingering ACP server after the fixed completion grace without starting tests',async()=>{
  const f=lifecycleProtocolFixture('execute');
  try{
   const error=await new LimaWorker('dsh',f.config,f.billing).run(f.input).catch(error=>error);
   expect(error).toMatchObject({name:'WorkerUnavailable',message:'ACP runtime did not confirm completion.'});
   expect(f.events().some(e=>e.event==='input-eof')).toBe(true);expect(f.events().filter(e=>e.stage==='tests')).toEqual([]);
   expect(f.events().filter(e=>e.stage==='acp'&&e.event==='helper-confirmed')).toEqual([]);
   expect(f.events().some(e=>e.operation==='stop')).toBe(true);expect(f.events().some(e=>e.operation==='reconcile')).toBe(true);
  }finally{f.release();f.close();}
 },7000);
 it.each(['early','non-end-turn','permission','stdout-overflow','stderr-overflow','abort'] as const)('fails closed for ACP %s with terminal controls',async acpBehavior=>{
  const f=protocolFixture({runner:'dsh',role:'execute',acpBehavior}),abort=new AbortController();
  try{
   const run=new LimaWorker('dsh',f.config,f.billing).run(f.input,abort.signal).catch(error=>error);
   if(acpBehavior==='abort'){for(let i=0;i<100&&!f.events().some(e=>e.stage==='acp');i++)await new Promise(r=>setTimeout(r,5));abort.abort();}
   expect(await run).toMatchObject({name:'WorkerUnavailable'});expect(f.events().filter(e=>e.stage==='tests')).toEqual([]);
   expect(f.events().slice(-3).map(e=>e.stage)).toEqual(['stop','cleanup','reconcile']);
   if(acpBehavior==='permission')expect(f.events().some(e=>e.stage==='permission-cancelled')).toBe(true);
  }finally{f.close();}
 });
 it.each(['execute','check'] as const)('denies %s tests when ACP server exit cannot confirm root drain',async role=>{
  const f=lifecycleProtocolFixture(role,true);
  try{
   f.release();const error=await new LimaWorker('dsh',f.config,f.billing).run(f.input).catch(error=>error);
   expect(error).toMatchObject({code:'worker_cleanup_unconfirmed',cause:{name:'WorkerUnavailable'}});
   expect(f.events().filter(e=>e.stage==='tests')).toEqual([]);
   expect(f.events().some(e=>e.stage==='acp'&&e.event==='helper-unconfirmed')).toBe(true);
   expect(f.events().slice(-2).map(e=>e.operation)).toEqual(['reconcile','reconcile']);
  }finally{f.close();}
 });
});

describe('enforced guest identity across adapter stages',()=>{
  it.each([{runner:'grok',role:'execute',stages:['prepare','cli','tests','stop','cleanup','reconcile']},{runner:'codex',role:'feedback',stages:['prepare','cli','read','stop','cleanup','reconcile']},{runner:'dsh',role:'feedback',stages:['prepare','acp','stop','cleanup','reconcile']}] as const)('keeps the bound tuple for $runner $role',async scenario=>{
    const fixture=protocolFixture(scenario);
    try {
      const result=await new LimaWorker(scenario.runner,fixture.config,fixture.billing).run(fixture.input);
      expect(result.costUsd).toBe(0);
      const events=fixture.events();expect(events.map(event=>event.stage)).toEqual(scenario.stages);
      expect(new Set(events.map(event=>JSON.stringify(event.prefix))).size).toBe(1);expect(new Set(events.map(event=>event.invocation)).size).toBe(1);
      if(scenario.role==='execute')expect((result.output as any).tests[0].output).toBe('actual synthetic test');
    } finally {fixture.close();}
  });
  it.each(['prepare','cli','read','tests','acp'])('fails closed at %s and cleans known workspaces using the original tuple',async fail=>{
    const runner=fail==='read'?'codex':fail==='acp'?'dsh':'grok',fixture=protocolFixture({runner,role:fail==='tests'?'execute':'feedback',fail});
    try {
      await expect(new LimaWorker(runner,fixture.config,fixture.billing).run(fixture.input)).rejects.toMatchObject({name:'WorkerUnavailable'});
      const events=fixture.events();expect(events.slice(-3).map(e=>e.stage)).toEqual(['stop','cleanup','reconcile']);
      expect(new Set(events.map(event=>JSON.stringify(event.prefix))).size).toBe(1);expect(new Set(events.map(event=>event.invocation)).size).toBe(1);
    } finally {fixture.close();}
  });
  it.each([false,true])('refuses cleanup uncertainty with primary failure: %s',async primaryFailure=>{
    const fixture=protocolFixture({cleanupFailure:true,...(primaryFailure?{fail:'cli'}:{})});
    try {
      const error=await new LimaWorker('grok',fixture.config,fixture.billing).run(fixture.input).catch(error=>error);
      expect(error).toMatchObject({name:'DomainError',code:'worker_cleanup_unconfirmed',message:'Isolated worker cleanup could not be confirmed.'});
      if(primaryFailure)expect(error.cause).toMatchObject({name:'WorkerUnavailable'});else expect(error.cause).toBeUndefined();
    } finally {fixture.close();}
  });
  it.each(['stop','reconcile'])('overrides apparent success when %s is unavailable and still attempts final reconciliation',async fail=>{
    const f=protocolFixture({fail});try{await expect(new LimaWorker('grok',f.config,f.billing).run(f.input)).rejects.toMatchObject({code:'worker_cleanup_unconfirmed'});expect(f.events().at(-1).stage).toBe('reconcile');expect(f.events().filter(e=>e.stage==='prepare')).toHaveLength(1);}finally{f.close();}
  });
  it('uses a fresh cleanup signal and frozen tuple after cancellation and caller mutation',async()=>{
    const fixture=protocolFixture({holdCli:true}),controller=new AbortController();
    try {
      const run=new LimaWorker('grok',fixture.config,fixture.billing).run(fixture.input,controller.signal).catch(error=>error);
      for(let attempt=0;attempt<100&&fixture.events().at(-1)?.stage!=='cli';attempt++)await new Promise(resolve=>setTimeout(resolve,10));
      expect(fixture.events().at(-1)?.stage).toBe('cli');
      fixture.input.project.domain='mutated';fixture.input.project.projectId='mutated';fixture.config.workers.grok!.guestUser='patrick-mutated';
      controller.abort();
      expect(await run).toMatchObject({name:'WorkerUnavailable'});
      const events=fixture.events();expect(events.map(event=>event.stage)).toEqual(['prepare','cli','stop','cleanup','reconcile']);
      expect(new Set(events.map(event=>JSON.stringify(event.prefix))).size).toBe(1);expect(new Set(events.map(event=>event.invocation)).size).toBe(1);
    } finally {fixture.close();}
  });
});


describe('protected direct Lima billing entry',()=>{
  it.each(['test','demo','live'] as const)('requires authority before prepare in %s mode',async mode=>{
    const f=protocolFixture(); f.config.mode=mode;
    try { await expect(new LimaWorker('grok',f.config).run(f.input)).rejects.toMatchObject({code:'billing_authority_required'}); expect(f.events()).toEqual([]); expect(f.store.list('attempts')).toEqual([]); } finally {f.close();}
  });
  it.each(['proof','current'] as const)('requires independently available %s before prepare',async missing=>{
    const f=protocolFixture();
    try { if(missing==='proof')rmSync(f.proofPath); const billing=missing==='current'?new BillingAuthority(f.store,f.config,{async read(){return undefined;}},{proofRoot:f.proofRoot,now:()=>f.at}):f.billing; await expect(new LimaWorker('grok',f.config,billing).run(f.input)).rejects.toMatchObject({code:'subscription_unverified'}); expect(f.events()).toEqual([]); expect(f.store.list('attempts')).toEqual([]); } finally {f.close();}
  });
  it('denies an included-only metered route with positive budgets and no hold',async()=>{
    const f=protocolFixture();
    try {f.input.task.budgetUsd=f.input.project.budgetUsd=100;f.store.save('projects',f.input.project);f.store.save('tasks',f.input.task);f.config.runnerPolicies[0]!.billing={mode:'metered-api'};f.config.runnerPolicies[0]!.costPerRunUsd=1;
      await expect(new LimaWorker('grok',f.config,f.billing).run(f.input)).rejects.toMatchObject({code:'billing_route_forbidden'});expect(f.events()).toEqual([]);expect(f.store.list('attempts')).toEqual([]);
    } finally {f.close();}
  });
  it.each(['project','task'] as const)('denies authorized metered route with zero %s cap',async cap=>{
    const f=protocolFixture();
    try {f.config.billingBoundary='metered-only';f.input.task.billingBoundary='metered-only';f.input.task.budgetUsd=f.input.project.budgetUsd=10;if(cap==='project')f.input.project.budgetUsd=0;else f.input.task.budgetUsd=0;f.store.save('projects',f.input.project);f.store.save('tasks',f.input.task);f.config.runnerPolicies[0]!.billing={mode:'metered-api'};f.config.runnerPolicies[0]!.costPerRunUsd=1;
      await expect(new LimaWorker('grok',f.config,f.billing).run(f.input)).rejects.toMatchObject({code:'budget_exceeded'});expect(f.events()).toEqual([]);expect(f.store.list('attempts')).toEqual([]);
    } finally {f.close();}
  });
  it.each(['source','task','project','role'] as const)('denies changed %s before prepare',async field=>{
    const f=protocolFixture();try {if(field==='source')f.input.source.revision='wrong';if(field==='task')f.input.task.id='wrong';if(field==='project')f.input.project.repository='other/repo';if(field==='role')f.input.role='decide';await expect(new LimaWorker('grok',f.config,f.billing).run(f.input)).rejects.toBeDefined();expect(f.events()).toEqual([]);expect(f.store.list('attempts')).toEqual([]);} finally {f.close();}
  });
  it('denies a direct check by the successful executor without independent-review policy',async()=>{
    const f=protocolFixture();try {f.input.role=f.input.task.stage='check';f.store.save('tasks',{...f.input.task,attempts:1});f.config.runnerPolicies[0]!.roles=['check'];f.store.save('attempts',{id:'executor',projectId:f.input.project.id,domain:f.input.project.domain,taskId:f.input.task.id,taskVersion:1,role:'execute',runner:'grok',provider:'fixture',model:'fixture',inputHash:'synthetic',status:'succeeded',costUsd:0,startedAt:f.at.toISOString()});await expect(new LimaWorker('grok',f.config,f.billing).run(f.input)).rejects.toMatchObject({code:'independent_review_required'});expect(f.events()).toEqual([]);expect(f.store.list('attempts')).toHaveLength(1);} finally {f.close();}
  });
  it('allocates distinct durable ordinals from identical direct input up to the common cap',async()=>{
    const f=protocolFixture();try {f.config.maxAttemptsPerTask=3;const worker=new LimaWorker('grok',f.config,f.billing);for(let i=0;i<3;i++)await worker.run(f.input);await expect(worker.run(f.input)).rejects.toMatchObject({code:'subscription_attempt_limit'});expect(f.store.list('attempts').map(a=>a.billing?.ordinal)).toEqual([1,2,3]);expect(f.store.get('tasks',f.input.task.id)?.attempts).toBe(3);expect(f.input.task.attempts).toBe(0);expect(f.events().filter(e=>e.stage==='prepare')).toHaveLength(3);} finally {f.close();}
  });
  it('launches the authority-bound runner even if the adapter label changes during proof awaits',async()=>{
    const f=protocolFixture();try {const worker=new LimaWorker('grok',f.config,f.billing),run=worker.run(f.input);worker.name='codex';await expect(run).resolves.toMatchObject({costUsd:0,provider:'fixture'});expect(f.store.list('attempts')).toEqual([expect.objectContaining({runner:'grok',status:'succeeded'})]);expect(f.events().map(e=>e.stage)).toEqual(['prepare','cli','stop','cleanup','reconcile']);expect(f.events().every(e=>e.prefix[5]==='grok')).toBe(true);} finally {f.close();}
  });
  it('uses the last legal scheduled permit once without another increment',async()=>{
    const f=protocolFixture();try {f.config.maxAttemptsPerTask=1;const worker=new LimaWorker('grok',f.config,f.billing),reserved=await f.billing.reserve(f.input,'grok');await expect(f.billing.dispatch(reserved,f.input,worker)).resolves.toMatchObject({costUsd:0});await expect(worker.run(f.input,undefined,reserved.permit)).rejects.toMatchObject({code:'billing_permit_invalid'});expect(f.store.get('tasks',f.input.task.id)?.attempts).toBe(1);expect(f.events().filter(e=>e.stage==='prepare')).toHaveLength(1);} finally {f.close();}
  });
  it('never prepares twice for concurrent claims of the same dispatched permit',async()=>{
    const f=protocolFixture();try {const worker=new LimaWorker('grok',f.config,f.billing),reserved=await f.billing.reserve(f.input,'grok');await f.billing.dispatch(reserved,f.input,{name:'grok',async run(input,signal,permit){const results=await Promise.allSettled([worker.run(input,signal,permit),worker.run(input,signal,permit)]);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);const success=results.find(r=>r.status==='fulfilled');if(success?.status!=='fulfilled')throw Error('no first claim');return success.value;}});expect(f.events().filter(e=>e.stage==='prepare')).toHaveLength(1);expect(f.store.get('tasks',f.input.task.id)?.attempts).toBe(1);} finally {f.close();}
  });
  it.each(['handmade','cloned','foreign'] as const)('rejects %s permit without a new reservation',async kind=>{
    const f=protocolFixture();try {const reserved=await f.billing.reserve(f.input,'grok'),foreign=new BillingAuthority(f.store,f.config,{async read(){return undefined;}});const permit=kind==='handmade'?{}:kind==='cloned'?JSON.parse(JSON.stringify(reserved.permit)):reserved.permit;await expect(new LimaWorker('grok',f.config,kind==='foreign'?foreign:f.billing).run(f.input,undefined,permit as HostDispatchPermit)).rejects.toMatchObject({code:'billing_permit_invalid'});expect(f.store.list('attempts')).toHaveLength(1);expect(f.events()).toEqual([]);} finally {f.close();}
  });
  it('rejects an authority bound to a different canonical config before allocating',async()=>{
    const f=protocolFixture();try {await expect(async()=>new LimaWorker('grok',{...f.config},f.billing).run(f.input)).rejects.toMatchObject({code:'billing_authority_mismatch'});expect(f.store.list('attempts')).toEqual([]);expect(f.events()).toEqual([]);} finally {f.close();}
  });
});


describe('direct Lima authoritative settlement',()=>{
  // Inject an explicitly synthetic host outcome at the protected launch callback.
  // No subprocess JSON/stderr is classified as subscription evidence.
  function launchStub(f:ReturnType<typeof protocolFixture>) {
    const runLima=f.billing.runLima.bind(f.billing),launch=vi.fn<()=>Promise<WorkerResult>>();
    const gate=vi.spyOn(f.billing,'runLima').mockImplementation((input,runner,signal,permit)=>runLima(input,runner,signal,permit,launch));
    return Object.assign(launch,{mockRestore:()=>gate.mockRestore()});
  }
  it('charges positive included cost once and persists the task/profile hard stop',async()=>{
    const f=protocolFixture();try {const worker=new LimaWorker('grok',f.config,f.billing),launch=launchStub(f).mockResolvedValue({output:{summary:'synthetic',observations:[]},costUsd:.25,provider:'fixture',model:f.config.runnerPolicies[0]!.model});await expect(worker.run(f.input)).rejects.toMatchObject({code:'billing_policy_violation'});expect(f.store.get('tasks',f.input.task.id)).toMatchObject({attempts:1,spentUsd:.25,billingStop:{code:'billing_policy_violation'}});expect(f.store.list('attempts')).toEqual([expect.objectContaining({status:'failed',costUsd:.25,billing:{...f.store.list('attempts')[0]!.billing,ordinal:1}})]);expect(f.store.list('actions').map(a=>a.kind)).toEqual(['billing_hold']);await expect(worker.run(f.input)).rejects.toMatchObject({code:'billing_policy_violation'});expect(launch).toHaveBeenCalledTimes(1);expect(f.events()).toEqual([]);launch.mockRestore();} finally {f.close();}
  });
  it.each(['quota','invalid-credential','provider-refusal'] as const)('quarantines verified no-charge %s without financial stop or direct fallback',async reason=>{
    const f=protocolFixture();try {const worker=new LimaWorker('grok',f.config,f.billing),observation={disposition:'verified-no-charge-refusal' as const,reason,observedAt:f.at.toISOString(),evidenceDigest:'synthetic-refusal',noChargeEvidenceDigest:'synthetic-no-charge'},launch=launchStub(f).mockRejectedValue(new SubscriptionAccessError(observation,'Synthetic host observation'));await expect(worker.run(f.input)).rejects.toBeInstanceOf(SubscriptionAccessError);expect(f.store.get('tasks',f.input.task.id)).toMatchObject({attempts:1,spentUsd:0});expect(f.store.get('tasks',f.input.task.id)?.billingStop).toBeUndefined();expect(f.store.list('attempts')).toEqual([expect.objectContaining({runner:'grok',status:'unavailable',error:'subscription_unavailable'})]);expect(f.store.list('actions')).toEqual([expect.objectContaining({kind:'billing_profile_unavailable',status:'pending'})]);expect(f.store.list('events')).toEqual([]);await expect(worker.run(f.input)).rejects.toMatchObject({code:'subscription_profile_unavailable'});expect(f.store.list('attempts')).toHaveLength(1);expect(launch).toHaveBeenCalledTimes(1);expect(f.events()).toEqual([]);launch.mockRestore();} finally {f.close();}
  });
  it.each(['paid-route-used','charge-danger-unknown'] as const)('persists hard holds for host-observed %s including ambiguous overflow',async reason=>{
    const f=protocolFixture();try {const worker=new LimaWorker('grok',f.config,f.billing),launch=launchStub(f).mockRejectedValue(new SubscriptionAccessError({disposition:'billing-incident',reason,observedAt:f.at.toISOString(),evidenceDigest:'synthetic-incident'},'Synthetic host observation'));await expect(worker.run(f.input)).rejects.toMatchObject({code:'billing_policy_violation'});expect(f.store.get('tasks',f.input.task.id)?.billingStop?.code).toBe('billing_policy_violation');expect(f.store.list('actions')).toEqual([expect.objectContaining({kind:'billing_hold',payload:expect.objectContaining({reason})})]);await expect(worker.run(f.input)).rejects.toMatchObject({code:'billing_policy_violation'});expect(launch).toHaveBeenCalledTimes(1);expect(f.store.list('attempts')).toHaveLength(1);expect(f.events()).toEqual([]);launch.mockRestore();} finally {f.close();}
  });
});


describe('Scheduler lifetime nonfallback contract',()=>{
 it.each([false,true])('never allocates or calls a backup after worker_cleanup_unconfirmed, primary cause %s',async primary=>{
  const f=protocolFixture();try{const error=new DomainError('Isolated worker cleanup could not be confirmed.','worker_cleanup_unconfirmed',503),cause=new Error('Synthetic primary CLI error');if(primary)error.cause=cause;
   const backup=vi.fn(async()=>({output:{summary:'forbidden backup',observations:[]},costUsd:0,provider:'fixture',model:'fixture'}));
   f.config.workers.codex={...f.config.workers.grok!,command:'fixture-codex'};f.config.runnerPolicies.push({...f.config.runnerPolicies[0]!,runner:'codex'});
   const scheduler=new Scheduler(f.store,f.config,[{name:'grok',async run(){throw error;}},{name:'codex',run:backup}],f.billing);
   await expect(scheduler.run(f.input.task,f.input.project,f.input)).rejects.toBe(error);expect(error.cause).toBe(primary?cause:undefined);expect(backup).not.toHaveBeenCalled();expect(f.store.list('attempts')).toHaveLength(1);expect(f.store.list('attempts')[0]).toMatchObject({runner:'grok',error:'worker_cleanup_unconfirmed'});expect(f.store.list('events').filter(e=>e.type==='worker.switched')).toEqual([]);
  }finally{f.close();}
 });
});
