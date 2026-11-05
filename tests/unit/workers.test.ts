import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture as lifetimeFixture } from '../fixtures/lima-lifetime.mjs';
import { describe, expect, it, vi } from 'vitest';
import { DomainError, SubscriptionAccessError, digest, stableId, type AppConfig, type WorkerInput, type WorkerResult } from '../../src/domain.js';
import { LimaWorker, limaFailureEvidence, parseWorkerOutput, commandFor, guestScripts, takeHostTestRun } from '../../src/integrations/workers.js';
import { bindSyntheticLimaBilling } from '../fixtures/billing.js';
import { Scheduler } from '../../src/scheduler.js';
import { BillingAuthority, type HostDispatchPermit } from '../../src/billing.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';

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
  if(operation!=='exec'){stage=operation;process.stdout.write(JSON.stringify({version:2,kind:'registered',closure:operation==='stop'?'none':'workspace-cleaned',state:operation==='stop'?'drained':'closed',cgroupsEmpty:true,workerProcessesAbsent:true,workspacesAbsent:operation==='reconcile',privateMountsAbsent:true,invocationClosed:operation==='reconcile',reason:'ok'}));}
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

      const input: WorkerInput = { task, project, source, role: 'feedback', cards: [], facts: [], rules: [] };
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

// Live polling may see a writer's incomplete final append. Confirmed terminal
// reads require LF framing; complete malformed records always remain failures.
function readProtocolEvents(path:string,complete=true):any[]{
 if(!existsSync(path))return [];const text=readFileSync(path,'utf8');if(complete&&text&&!text.endsWith('\n'))throw Error('Incomplete terminal fixture event');const end=text.lastIndexOf('\n');return end<0?[]:text.slice(0,end).split('\n').map(line=>JSON.parse(line));
}
function isServerEvent(value:any,event:string){return value!==null&&typeof value==='object'&&Object.keys(value).length===1&&value.event===event;}
function protocolDiagnostic(events:any[],outcome:unknown){
 return JSON.stringify({events,outcome},(_key,value)=>value instanceof Error?{name:value.name,message:value.message,...('code' in value?{code:value.code}:{})}:value);
}
// Observe only this fixture's LF-complete events. Startup is bounded by the
// worker and Vitest signals, independently of ACP's fixed completion grace.
function waitForAcpInputEof(f:{events:(complete?:boolean)=>any[]},run:Promise<unknown>,signal:AbortSignal):Promise<void>{
 return new Promise((resolve,reject)=>{
  let done=false,events:any[]=[];
  const finish=(error?:Error)=>{if(done)return;done=true;clearInterval(interval);signal.removeEventListener('abort',aborted);error?reject(error):resolve();};
  const aborted=()=>finish(new Error('ACP readiness cancelled: '+protocolDiagnostic(events,signal.reason),{cause:signal.reason}));
  const inspect=()=>{if(done)return;try{
   events=f.events(false);const eof=events.findIndex(e=>isServerEvent(e,'input-eof'));
   if(eof<0)return;
   if(!events.slice(0,eof).some(e=>isServerEvent(e,'end_turn')))throw Error('ACP input EOF without preceding end_turn');
   finish();
  }catch(error){finish(new Error('Invalid ACP readiness: '+protocolDiagnostic(events,error),{cause:error}));}};
  const interval=setInterval(inspect,5);
  // Settlement never flushes events into success: the held worker must still
  // be running when readiness is observed, including an already-settled run.
  run.then(value=>finish(new Error('Worker settled before ACP input EOF: '+protocolDiagnostic(events,value))),error=>finish(new Error('Worker failed before ACP input EOF: '+protocolDiagnostic(events,error),{cause:error})));
  signal.addEventListener('abort',aborted,{once:true});
  if(signal.aborted)aborted();else queueMicrotask(inspect);
 });
}
const fixtureFrame=String.raw`const crypto=require('node:crypto'),os=require('node:os'),at=new Date().toISOString(),hash=v=>crypto.createHash('sha256').update(v).digest('hex');const outputBytes=typeof options!=='undefined'&&options.largeTail?Buffer.alloc(12000,171):typeof options!=='undefined'&&options.binaryTail?Buffer.from([255,0,195,40,254,240,159,152,128]):Buffer.from('actual synthetic test SYNTHETIC_PRIVATE_STDOUT_SENTINEL');const measured=p.measurement.paths.filter(path=>p.files.some(f=>f.path===path)).map(path=>({path,sha256:hash(p.files.find(f=>f.path===path).content),mode:'100644'}));const frame={schemaVersion:1,kind:'patrick-tests',nonce:p.nonce,tests:p.commands.map(command=>({command,passed:true,outputBase64:outputBytes.toString('base64')})),measurement:{observedAt:at,before:measured,after:measured,missing:p.measurement.paths.filter(path=>!measured.some(f=>f.path===path)),unstable:[],checks:p.commands.map(command=>({id:hash(JSON.stringify(['local-check',command])).slice(0,32),command,result:'success',outputDigest:hash(outputBytes),process:{exitCode:0,signal:null,timedOut:false,startedAt:at,finishedAt:at}})),environment:{observed:{node:process.versions.node,platform:process.platform,arch:process.arch,osRelease:os.release()},unknown:['browserVersion','databaseVersion','serviceVersions','dependencyClosure']}}};if(typeof options!=='undefined'&&options.capturedError){for(const t of frame.tests)t.passed=false;for(const c of frame.measurement.checks){c.result='failure';c.process.exitCode=null;c.process.errorCode=options.capturedError;}}if(typeof options!=='undefined'&&options.frameFault){if(options.frameFault==='nonce')frame.nonce='0'.repeat(32);if(options.frameFault==='id')frame.measurement.checks[0].id='0'.repeat(32);if(options.frameFault==='oversized')frame.tests[0].outputBase64='x'.repeat(512001);if(options.frameFault==='encoding')frame.tests[0].outputBase64='???';if(options.frameFault==='padding')frame.tests[0].outputBase64='Zh==';if(options.frameFault==='whitespace')frame.tests[0].outputBase64='Zg==\n';if(options.frameFault==='legacy'){frame.tests[0].output='legacy ambiguous text';delete frame.tests[0].outputBase64;}if(options.frameFault==='tail')frame.tests[0].outputBase64=Buffer.alloc(12001).toString('base64');if(['encoding','padding','whitespace','tail'].includes(options.frameFault))frame.measurement.checks[0].outputDigest=hash(Buffer.from(frame.tests[0].outputBase64,'base64'));if(options.frameFault==='digest')frame.measurement.checks[0].outputDigest='0'.repeat(64);if(options.frameFault==='malformed'){process.stdout.write('{');}else if(options.frameFault==='trailing')process.stdout.write(JSON.stringify(frame)+'{}');else if(options.frameFault==='duplicate')process.stdout.write(JSON.stringify(frame).replace('\"schemaVersion\":1','\"schemaVersion\":1,\"schemaVersion\":1'));else process.stdout.write(JSON.stringify(frame));}else process.stdout.write(JSON.stringify(frame));`;
type FixtureOptions={comparableRepository?:boolean;largeTail?:boolean;binaryTail?:boolean;baselineContent?:string;testFiles?:string[];bindingMismatch?:'plan'|'artifact';capturedError?:'ENOBUFS';stopDelayMs?:number;frameFault?:'nonce'|'malformed'|'trailing'|'duplicate'|'id'|'oversized'|'encoding'|'padding'|'whitespace'|'legacy'|'tail'|'digest';controlReceipt?:unknown;runner?:'grok'|'codex'|'dsh';role?:'feedback'|'execute'|'check';fail?:string;holdCli?:boolean;cleanupFailure?:boolean;acpBehavior?:'unrelated-early'|'early'|'non-end-turn'|'permission'|'stdout-overflow'|'stderr-overflow'|'abort'};
function protocolFixture(options:FixtureOptions={}) {
  const root=mkdtempSync(join(tmpdir(),'patrick-identity-protocol-')),bin=join(root,'bin'),eventsPath=join(root,'events');mkdirSync(bin);
  const runner=options.runner??'grok',role=options.role??'feedback',createdAt='2026-01-01T00:00:00.000Z';
  const project:WorkerInput['project']={id:'bound-project',projectId:'bound-project',domain:'私人领域',name:'Fixture',description:'',repository:'fixture/repo',repositoryProvider:'github',prdPath:'docs/PRD.md',allowedPaths:['docs/'],trustedChecks:[],trustedAppIds:[],ownerId:'owner',autoMerge:false,budgetUsd:0,createdAt};
  if(options.comparableRepository)Object.assign(project,{repository:'owner/repo',repositoryProvider:'gitlab',trustedChecks:['validate'],trustedAppIds:[731]});
  const source:WorkerInput['source']={id:'source',projectId:project.id,domain:project.domain,kind:'manual',externalId:'fixture',revision:'revision',title:'fixture',content:'',locator:'fixture',authorId:'owner',retention:'permanent',status:'active',createdAt};
  if(options.comparableRepository)source.content='Measured local run';
  const task:WorkerInput['task']={id:'task',projectId:project.id,domain:project.domain,sourceId:source.id,sourceRevision:source.revision,title:'fixture',description:'',status:'feedback',version:1,createdAt,updatedAt:createdAt,runAfter:createdAt,attempts:0,repairCount:0,budgetUsd:0,spentUsd:0,stage:role};
  const literal='fixture-model;$(touch /tmp/never-executed)';
  const config:AppConfig={mode:'test',host:'localhost',port:1,dataDir:root,vaultDir:root,ownerId:'owner',authToken:'',sessionSecret:'',projects:[project],scanIntervalMs:1000,workers:{[runner]:{command:`fixture-${runner}`,args:['literal;$(id)'],isolation:'lima',instance:'fixture-instance',guestUser:'patrick-dedicated',timeoutMs:5000}},runnerPolicies:[{runner,roles:[role],domains:[project.domain],provider:'fixture',model:literal,admitted:true,costPerRunUsd:0,independentReview:false}]};
  const input:WorkerInput={task,project,source,role,cards:[],facts:[],rules:[],...(['execute','check'].includes(role)?{plan:{taskVersion:1,sourceRevision:'revision',baselineSha:'base',summary:'fixture',paths:['docs/PRD.md'],steps:['write'],tests:['literal test;$(id)'],stopConditions:['stop']}}:{})};
  if(input.plan){input.task.plan=input.plan;input.plan.testFiles=options.testFiles??(options.comparableRepository?['docs/PRD.md']:[]);input.baselineFiles=[{path:'docs/PRD.md',content:options.baselineContent??'fixture'}];}
  const output=role==='check'?{taskVersion:1,planHash:'hash',artifactHash:'artifact',verdict:'pass',summary:'fixture',issues:[],tests:[{command:'declared',passed:false,output:'untrusted'}]}:role==='execute'?{taskVersion:1,planHash:'hash',baselineSha:'base',files:[{path:'docs/PRD.md',content:'fixture'}],tests:[{command:'declared',passed:false,output:'untrusted'}],summary:'fixture'}:{summary:'fixture',observations:[]};
  if(role==='check')input.artifact={taskVersion:1,planHash:'hash',baselineSha:'base',files:[{path:'docs/PRD.md',content:'fixture'}],tests:[{command:'declared',passed:false,output:'untrusted'}],summary:'fixture'};
  if(options.comparableRepository&&input.plan){input.plan.baselineSha='b'.repeat(40);if('baselineSha' in output)output.baselineSha=input.plan.baselineSha;if(input.artifact)input.artifact.baselineSha=input.plan.baselineSha;}
  if(input.plan){output.planHash=digest(input.plan);if(input.artifact){input.artifact.tests=input.plan.tests.map(command=>({command,passed:true,output:'accepted earlier process status'}));input.artifact.planHash=digest(input.plan);input.task.artifact=input.artifact;output.artifactHash=digest(input.artifact);}input.task.status=role==='check'?'checking':'executing';}
  if(options.bindingMismatch==='plan'&&input.plan)output.planHash='mismatched-plan';if(options.bindingMismatch==='artifact'&&role==='check')output.artifactHash='mismatched-artifact';
  const prefix=['/usr/bin/sudo','-n','--','/usr/local/libexec/patrick-worker-enter','--runner',runner,'--user','patrick-dedicated','--project',project.projectId,'--domain',project.domain,'--'];
  writeFileSync(join(bin,'limactl'),`#!${process.execPath}
const fs=require('node:fs'),readline=require('node:readline');
const options=${JSON.stringify(options)},scripts=${JSON.stringify(guestScripts)},output=${JSON.stringify(output)},prefix=${JSON.stringify(prefix)};
const argv=process.argv.slice(2),args=argv.slice(22),invocation=argv[16],operation=argv[20],dir='/var/lib/patrick-workspaces/'+invocation+'/work';
if(JSON.stringify(argv.slice(0,3))!==JSON.stringify(['shell','fixture-instance','--'])||JSON.stringify(argv.slice(3,15))!==JSON.stringify(prefix.slice(0,-1))||!/^[a-f0-9]{32}$/.test(invocation)||argv[15]!=='--invocation'||argv[17]!=='--stage'||argv[19]!=='--operation'||argv[21]!=='--')process.exit(78);
let stage=operation!=='exec'?operation:args[0]==='node'?(args[2]===scripts.prepare?'prepare':args[2]===scripts.tests?'tests':args[2]===scripts.read?'read':args[2]===scripts.cleanup?'cleanup':'invalid'):args[0]==='sh'?'cli':args[0]==='fixture-dsh'?'acp':'invalid';
fs.appendFileSync(${JSON.stringify(eventsPath)},JSON.stringify({stage,prefix,args,invocation,profile:['cli','acp'].includes(argv[18])?'authenticated-client':'task-only',purpose:argv[18],operation})+'\\n');
if(stage===options.fail||(stage==='cleanup'&&options.cleanupFailure))process.exit(78);
if(stage==='stop'||stage==='reconcile'){const receipt=JSON.stringify(Object.hasOwn(options,'controlReceipt')?options.controlReceipt:{version:2,kind:'registered',closure:stage==='stop'?'none':'workspace-cleaned',state:stage==='stop'?'drained':'closed',cgroupsEmpty:true,workerProcessesAbsent:true,workspacesAbsent:stage==='reconcile',privateMountsAbsent:true,invocationClosed:stage==='reconcile',reason:'ok'});if(stage==='stop'&&options.stopDelayMs)setTimeout(()=>process.stdout.write(receipt),options.stopDelayMs);else process.stdout.write(receipt);}
else if(stage==='cli'&&options.holdCli){setInterval(()=>{},1000);process.stdin.resume();}
else if(stage==='acp') {
 if(options.acpBehavior==='early')process.exit(0);
 if(options.acpBehavior==='unrelated-early'){process.stdout.write('{}\\n');process.exit(0);}
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
 if(stage==='prepare'){const payload=JSON.parse(input);if(JSON.stringify(Object.keys(payload).sort())!==JSON.stringify(['files','prompt','schema'])||/synthetic-(account|workspace|route|evidence)|noChargeEvidenceDigest|[\"]permit[\"]/.test(payload.prompt))process.exit(78);fs.writeFileSync(${JSON.stringify(join(root,'last-prompt'))},payload.prompt);process.stdout.write(JSON.stringify({dir}));}
 else if(stage==='cli'){if(!args.includes(${JSON.stringify(literal)})||!args.includes('literal;$(id)'))process.exit(78);process.stdout.write(JSON.stringify(output));}
 else if(stage==='read')process.stdout.write(JSON.stringify(output));
 else if(stage==='tests'){const payload=JSON.parse(input);if(payload.commands[0]!=='literal test;$(id)')process.exit(78);const p=payload;${fixtureFrame}}
 else if(stage!=='cleanup')process.exit(78);
 });}
`,{mode:0o700});
  vi.stubEnv('PATH',bin);
  const bound=bindSyntheticLimaBilling(config,input);
  return {root,bin,output,input,config,...bound,events:(complete=true)=>readProtocolEvents(eventsPath,complete),close:()=>{bound.dispose();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});}};
}

// Host-protocol fixture: real root lifecycle records/locks/ACK gate with a
// local NDJSON server. No Linux service/profile/guest qualification is claimed.
function lifecycleProtocolFixture(role:'execute'|'check',unconfirmed=false,probe:{bootstrapDelayMs?:number;exitCode?:number;holdInputOpen?:boolean;releaseOnEarlyTests?:boolean;holdInitialPrepare?:boolean}={}) {
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
lines.on('close',()=>{log('input-eof');const interval=setInterval(()=>{if(fs.existsSync(release)){clearInterval(interval);log('server-exit');process.exit(${probe.exitCode??0});}},5);});
`;
 writeFileSync(join(f.bin,'limactl'),`#!${process.execPath}
(async()=>{
 const fs=require('node:fs'),{spawn}=require('node:child_process');
 if(process.argv[20]==='acp'&&${probe.bootstrapDelayMs??0})await new Promise(resolve=>setTimeout(resolve,${probe.bootstrapDelayMs??0}));
 const {fixture}=await import(${JSON.stringify(fixtureModule)}),lifetime=await import(${JSON.stringify(lifetimeModule)});
 const f=fixture(${JSON.stringify(options)}),argv=process.argv.slice(2),stage=argv[18],operation=argv[20],invocation=argv[16],command=argv.slice(22);
 const request={context:${JSON.stringify(context)},lifetime:{invocation,stage,operation,profile:lifetime.profileFor(stage)},command};
 const events=${JSON.stringify(events)},log=event=>fs.appendFileSync(events,JSON.stringify({event,stage,operation})+'\\n');
 log('request');
 if(stage==='prepare'&&operation==='exec'&&${probe.holdInitialPrepare===true}&&!fs.existsSync(${JSON.stringify(join(root,'prepare-held'))})){fs.writeFileSync(${JSON.stringify(join(root,'prepare-held'))},'held');log('prepare-held');process.stdin.resume();await new Promise(()=>{setInterval(()=>{},1000);});}
 if(stage==='tests'&&operation==='exec'){
  const r=f.record(invocation),prior=r.stages.at(-1);
  if(prior.stage!=='acp'||prior.phase!=='complete'||r.payloadSealed){log('tests-before-confirmation');${probe.releaseOnEarlyTests?"fs.writeFileSync("+JSON.stringify(release)+",'early tests observed');":''}}
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
    server.stdin.write(lifetime.releaseLine);process.stdin.pipe(server.stdin,{end:${!probe.holdInputOpen}});
   }else{
    let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
     if(spec.stage==='prepare'){const p=JSON.parse(input);if(!p.prompt.includes('FROZEN INPUT:'))throw Error('lost prompt');process.stdout.write(JSON.stringify({dir:spec.workspace}));}
     if(spec.stage==='tests'){const p=JSON.parse(input);${fixtureFrame}}
     done.resolve({code:0});
    });process.stdin.resume();
   }
  },cancelInput:()=>{server?.kill('SIGKILL');}};
 };
 try{const result=await lifetime.executeStage(request,f.deps);log('helper-confirmed');if(operation!=='exec')process.stdout.write(JSON.stringify(result));process.exitCode=0;}
 catch{log('helper-unconfirmed');process.exitCode=78;}
})().catch(()=>{process.exitCode=78;});
`,{mode:0o700});
 return {...f,controller,release:()=>writeFileSync(release,'complete'),events:(complete=true)=>readProtocolEvents(events,complete)};
}

function assertAcpTerminal(f:ReturnType<typeof lifecycleProtocolFixture>,result:unknown){
 const events=f.events(),endTurn=events.findIndex(e=>isServerEvent(e,'end_turn')),eof=events.findIndex(e=>isServerEvent(e,'input-eof')),exit=events.findIndex(e=>isServerEvent(e,'server-exit'));
 const confirmed=events.findIndex(e=>e.stage==='acp'&&e.event==='helper-confirmed'),tests=events.findIndex(e=>e.stage==='tests'&&e.event==='request');
 expect(events.some(e=>e.event==='tests-before-confirmation'),'Tests started before ACP helper confirmation').toBe(false);
 expect(endTurn).toBeGreaterThan(-1);expect(eof).toBeGreaterThan(endTurn);expect(exit).toBeGreaterThan(eof);expect(confirmed).toBeGreaterThan(exit);expect(tests).toBeGreaterThan(confirmed);
 expect(result).toMatchObject({costUsd:0,output:{tests:[{passed:true,output:expect.stringContaining('exit 0')}]}});
 const token=readdirSync(f.controller.physical('/var/lib/patrick-worker/invocations')).find(name=>/^[a-f0-9]{32}\.json$/.test(name)&&f.controller.record(name.slice(0,32)).kind==='registered')!.slice(0,32);
 expect(f.controller.record(token)).toMatchObject({state:'closed',payloadSealed:true});
}
async function assertHeldAcpHandoff(f:ReturnType<typeof lifecycleProtocolFixture>,signal:AbortSignal){
 let outcome:unknown='pending';const run=new LimaWorker('dsh',f.config,f.billing).run(f.input,signal).catch(error=>error).then(value=>{outcome=value;return value;});
 try{
  await waitForAcpInputEof(f,run,signal);
  expect(f.events(false).filter(e=>e.stage==='tests')).toEqual([]);
  const token=readdirSync(f.controller.physical('/var/lib/patrick-worker/invocations')).find(name=>/^[a-f0-9]{32}\.json$/.test(name)&&f.controller.record(name.slice(0,32)).kind==='registered')!.slice(0,32);
  expect(f.controller.record(token)).toMatchObject({state:'active',payloadSealed:false,sequence:2,stages:[{stage:'prepare',phase:'complete'},{stage:'acp',phase:'acknowledged'}]});
  expect(f.events(false).filter(e=>e.stage==='acp'&&e.event==='helper-confirmed')).toEqual([]);
  f.release();assertAcpTerminal(f,await run);
 }catch(error){
  let events:any[]=[],eventReadFailure:unknown;try{events=f.events(false);}catch(readError){eventReadFailure=readError;}
  // Retain the prefix at failure and the eventual real outcome before finally
  // disposes this fixture, including failures during startup observation.
  f.release();await run;
  throw new Error('ACP handoff failed: '+protocolDiagnostic(events,{worker:outcome,eventReadFailure}),{cause:error});
 }finally{f.release();await run;f.close();}
}

describe('ACP actual lifecycle stage handoff',()=>{
 it('accepts delayed ACP bootstrap before observing the held completion',async({signal})=>{
  await assertHeldAcpHandoff(lifecycleProtocolFixture('execute',false,{bootstrapDelayMs:1250}),signal);
 });
 it.for(['execute','check'] as const)('waits for successful ACP helper completion before %s tests',async(role,{signal})=>{
  await assertHeldAcpHandoff(lifecycleProtocolFixture(role),signal);
 });
 it('retains the terminal guard against deterministic tests before helper confirmation',async({signal})=>{
  const f=lifecycleProtocolFixture('execute',false,{releaseOnEarlyTests:true}),worker=new LimaWorker('dsh',f.config,f.billing);
  const adapter=worker as unknown as {acpRun:(...args:any[])=>Promise<string>},original=adapter.acpRun.bind(worker);
  let run:Promise<any>,background:Promise<unknown>|undefined;
  adapter.acpRun=async(...args)=>{background=original(...args).catch(error=>error);await waitForAcpInputEof(f,run,signal);return JSON.stringify(f.output);};
  run=worker.run(f.input,signal).catch(error=>error);
  try{
   const result=await run;await background;
   expect(f.events().some(e=>e.event==='tests-before-confirmation')).toBe(true);
   expect(()=>assertAcpTerminal(f,result)).toThrow('Tests started before ACP helper confirmation');
  }finally{f.release();await run;await background;f.close();}
 });
 it('rejects abnormal ACP server exit without starting tests',async({signal})=>{
  const f=lifecycleProtocolFixture('execute',false,{exitCode:23});
  try{
   f.release();const result=await new LimaWorker('dsh',f.config,f.billing).run(f.input,signal).catch(error=>error);
   expect(result).toMatchObject({name:'WorkerUnavailable'});expect(f.events().filter(e=>e.stage==='tests')).toEqual([]);
   expect(f.events().some(e=>e.stage==='acp'&&e.event==='helper-unconfirmed')).toBe(true);
  }finally{f.release();f.close();}
 });
 it('rejects readiness when ACP input EOF never arrives',async({signal})=>{
  const f=lifecycleProtocolFixture('execute',false,{holdInputOpen:true}),run=new LimaWorker('dsh',f.config,f.billing).run(f.input,signal).catch(error=>error);
  try{
   await expect(waitForAcpInputEof(f,run,signal)).rejects.toThrow('Worker settled before ACP input EOF');
   expect(await run).toMatchObject({name:'WorkerUnavailable',message:'ACP runtime did not confirm completion.'});
   expect(f.events().some(e=>e.event==='input-eof')).toBe(false);expect(f.events().filter(e=>e.stage==='tests')).toEqual([]);
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
 it('does not brand an unrelated protocol failure followed by normal exit as the no-output early-exit scenario',async()=>{
  const f=protocolFixture({runner:'dsh',role:'execute',acpBehavior:'unrelated-early'}),diagnostic=vi.spyOn(console,'error').mockImplementation(()=>{});try{const error=await new LimaWorker('dsh',f.config,f.billing).run(f.input).catch(e=>e);expect(error).toMatchObject({name:'WorkerUnavailable'});expect(limaFailureEvidence(error)).toBeUndefined();expect(limaFailureEvidence(Object.assign(new Error(),{stage:'acp',kind:'acp-early-exit'}))).toBeUndefined();expect(diagnostic).toHaveBeenCalledExactlyOnceWith('Invalid message',{message:{}});}finally{diagnostic.mockRestore();f.close();}
 });
 it.each(['early','non-end-turn','permission','stdout-overflow','stderr-overflow','abort'] as const)('fails closed for ACP %s with terminal controls',async acpBehavior=>{
  const f=protocolFixture({runner:'dsh',role:'execute',acpBehavior}),abort=new AbortController();
  try{
   const run=new LimaWorker('dsh',f.config,f.billing).run(f.input,abort.signal).catch(error=>error);
   if(acpBehavior==='abort'){for(let i=0;i<100&&!f.events(false).some(e=>e.stage==='acp');i++)await new Promise(r=>setTimeout(r,5));abort.abort();}
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
      if(scenario.role==='execute')expect((result.output as any).tests[0].output).toContain('exit 0');
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
      for(let attempt=0;attempt<100&&fixture.events(false).at(-1)?.stage!=='cli';attempt++)await new Promise(resolve=>setTimeout(resolve,10));
      expect(fixture.events(false).at(-1)?.stage).toBe('cli');
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

it('polls only complete fixture records and rejects truncated terminal or malformed complete records',()=>{
 const f=protocolFixture();try{const path=join(f.root,'events');writeFileSync(path,'{"stage":"prepare"}\n{"stage":');expect(f.events(false)).toEqual([{stage:'prepare'}]);expect(()=>f.events()).toThrow('Incomplete terminal fixture event');writeFileSync(path,'{"stage":"prepare"}\n{"stage":"cli"}\n');expect(f.events()).toEqual([{stage:'prepare'},{stage:'cli'}]);writeFileSync(path,'{malformed}\n');expect(()=>f.events(false)).toThrow(SyntaxError);expect(()=>f.events()).toThrow(SyntaxError);}finally{f.close();}
});

describe('ACP readiness observation',()=>{
 it('requires an exact LF-complete input EOF after end_turn and disposes the poll',async()=>{
  const root=mkdtempSync(join(tmpdir(),'patrick-acp-observer-')),path=join(root,'events'),controller=new AbortController();
  vi.useFakeTimers();let wait:Promise<unknown>|undefined;
  try{
   writeFileSync(path,'{"event":"end_turn"}\n{"event":"input-eof"}');
   let ready=false;wait=waitForAcpInputEof({events:complete=>readProtocolEvents(path,complete)},new Promise(()=>{}),controller.signal).then(()=>{ready=true;},error=>error);
   await vi.advanceTimersByTimeAsync(5);expect(ready).toBe(false);
   writeFileSync(path,'{"event":"end_turn"}\n{"event":"input-eof","extra":true}\n');
   await vi.advanceTimersByTimeAsync(5);expect(ready).toBe(false);
   writeFileSync(path,'{"event":"end_turn"}\n{"event":"input-eof"}\n');
   await vi.advanceTimersByTimeAsync(5);await wait;expect(ready).toBe(true);expect(vi.getTimerCount()).toBe(0);
  }finally{controller.abort();await wait;vi.useRealTimers();rmSync(root,{recursive:true,force:true});}
 });
 it.each(['fulfilled','rejected','already-settled','cancelled','invalid-order','malformed'] as const)('rejects %s readiness and disposes the poll',async kind=>{
  const root=mkdtempSync(join(tmpdir(),'patrick-acp-observer-')),path=join(root,'events'),controller=new AbortController();
  let fulfill!:(value:unknown)=>void,reject!:(error:unknown)=>void;
  const pending=new Promise((resolve,fail)=>{fulfill=resolve;reject=fail;});
  vi.useFakeTimers();let wait:Promise<unknown>|undefined;
  try{
   writeFileSync(path,'{"event":"end_turn"}\n');
   if(kind==='already-settled')writeFileSync(path,'{"event":"end_turn"}\n{"event":"input-eof"}\n');
   if(kind==='invalid-order')writeFileSync(path,'{"event":"input-eof"}\n{"event":"end_turn"}\n');
   if(kind==='malformed')writeFileSync(path,'{malformed}\n');
   wait=waitForAcpInputEof({events:complete=>readProtocolEvents(path,complete)},kind==='already-settled'?Promise.resolve('unexpected success'):pending,controller.signal).catch(error=>error);
   if(kind==='fulfilled')fulfill('unexpected success');
   if(kind==='rejected')reject(Error('actual worker failure'));
   if(kind==='cancelled')controller.abort(Error('framework deadline'));
   await vi.advanceTimersByTimeAsync(5);
   const error=await wait;expect(error).toBeInstanceOf(Error);
   expect(String(error)).toContain(kind==='cancelled'?'ACP readiness cancelled':kind==='rejected'?'Worker failed':kind==='invalid-order'||kind==='malformed'?'Invalid ACP readiness':'Worker settled');
   expect(vi.getTimerCount()).toBe(0);
  }finally{controller.abort();await wait;vi.useRealTimers();rmSync(root,{recursive:true,force:true});}
 });
});


describe('strict ordinary control IPC2 finalization',()=>{
 const denied={version:2,kind:'denial-only',state:'denied',closure:'never-registered',invocationClosed:true,reason:'ok',cgroupsEmpty:true,workerProcessesAbsent:true,workspacesAbsent:true,privateMountsAbsent:true};
 it.each([
  ['state',{...denied,state:'closed'}],['kind',{...denied,kind:'registered'}],['closure',{...denied,closure:'workspace-cleaned'}],
  ['nonclosed',{...denied,invocationClosed:false}],['extra',{...denied,extra:true}],['v1',{...denied,version:1}],
  ['false workspace',{...denied,workspacesAbsent:false}],['false process',{...denied,workerProcessesAbsent:false}],['false group',{...denied,cgroupsEmpty:false}],['false mounts',{...denied,privateMountsAbsent:false}],
  ['unavailable',{...denied,reason:'control_unavailable'}],['active reason',{...denied,reason:'active'}],['unknown reason',{...denied,reason:'unknown'}],
  ['unknown true facts',{...denied,kind:'unknown',state:'quarantined',closure:'none',invocationClosed:false,reason:'unknown'}],
  ['registered closure',{...denied,kind:'registered',state:'drained',closure:'workspace-cleaned',invocationClosed:false}],
  ['registered closed',{...denied,kind:'registered',state:'closed',closure:'none'}],
  ['boot mismatch',{...denied,kind:'registered',state:'quarantined',closure:'none',invocationClosed:false,reason:'boot_mismatch'}],
  ['unknown control',{version:2,kind:'unknown',state:'quarantined',closure:'none',invocationClosed:false,reason:'control_unavailable',cgroupsEmpty:false,workerProcessesAbsent:false,workspacesAbsent:false,privateMountsAbsent:false}],
 ] as const)('rejects forged %s receipt through subprocess bytes',async(_name,controlReceipt)=>{
  const f=protocolFixture({fail:'prepare',controlReceipt});try{await expect(new LimaWorker('grok',f.config,f.billing).run(f.input)).rejects.toMatchObject({code:'worker_cleanup_unconfirmed',cause:{name:'WorkerUnavailable'}});expect(f.events().at(-1).stage).toBe('reconcile');}finally{f.close();}
 });
 it('rejects denial without a primary failed or cancelled attempt',async()=>{
  const f=protocolFixture({controlReceipt:denied});try{await expect(new LimaWorker('grok',f.config,f.billing).run(f.input)).rejects.toMatchObject({code:'worker_cleanup_unconfirmed'});expect(f.events().filter(e=>e.stage==='cleanup')).toEqual([]);}finally{f.close();}
 });
 it('cancels before real registration, persists denial using fresh controls, then completes a fresh ordinary attempt',async({signal})=>{
  const f=lifecycleProtocolFixture('execute',false,{holdInitialPrepare:true}),abort=new AbortController(),worker=new LimaWorker('dsh',f.config,f.billing);
  const run=worker.run(f.input,AbortSignal.any([signal,abort.signal])).catch(error=>error);
  try{
   await new Promise<void>((resolve,reject)=>{
    const timer=setInterval(()=>{if(f.events(false).some(e=>e.event==='prepare-held')){clearInterval(timer);signal.removeEventListener('abort',cancel);resolve();}},5);
    const cancel=()=>{clearInterval(timer);reject(signal.reason);};signal.addEventListener('abort',cancel,{once:true});
    run.then(outcome=>{clearInterval(timer);signal.removeEventListener('abort',cancel);reject(Error('settled before prepare barrier: '+protocolDiagnostic(f.events(false),outcome)));});
   });
   expect(f.controller.io.readdirSync('/var/lib/patrick-worker/invocations')).toEqual(['.authority.json']);abort.abort();
   const error=await run;expect(error).toMatchObject({name:'WorkerUnavailable'});expect(error.code).not.toBe('worker_cleanup_unconfirmed');
   const events=f.events();expect(events.filter(e=>e.operation==='exec').map(e=>e.stage)).toEqual(['prepare','prepare']);expect(events.some(e=>e.operation==='stop')).toBe(true);expect(events.some(e=>e.operation==='reconcile')).toBe(true);
   const names=f.controller.io.readdirSync('/var/lib/patrick-worker/invocations').filter(n=>n.endsWith('.json')&&!n.startsWith('.'));expect(names).toHaveLength(1);const token=names[0]!.slice(0,32);expect(f.controller.record(token)).toMatchObject({kind:'denial-only',state:'denied'});
   f.release();const fresh=await worker.run(f.input,signal);assertAcpTerminal(f,fresh);
   expect(f.controller.record(token)).toMatchObject({kind:'denial-only',state:'denied'});
  }finally{abort.abort();f.release();await run;f.close();}
 });
});


describe('G7-FIX1 decision transport',()=>{
 it('serializes host-owned labels and prompt instructions for a stored legacy decision',async()=>{
  const f=protocolFixture();
  try{
   f.input.task.decision={action:'proceed',summary:'Prior interpretation',rationale:'Prior reasoning',expectedOutcome:'Predicted change',citations:[],ruleIds:[]};
   f.store.save('tasks',f.input.task);
   (f.input as any).decisionInterpretation={summary:'source-fact',rationale:'source-fact',expectedOutcome:'observed-result'};
   await new LimaWorker('grok',f.config,f.billing).run(f.input);
   const prompt=readFileSync(join(f.root,'last-prompt'),'utf8');
   expect(prompt).toContain('prior task.decision summary and rationale as assistant interpretations and expectedOutcome as an assistant prediction');
   expect(prompt).toContain('question option rationales are assistant interpretations and their tradeoffs are predictions');
   const serialized=JSON.parse(prompt.split('FROZEN INPUT:\n')[1]!);
   expect(serialized.task.decision).toMatchObject({summary:'Prior interpretation',rationale:'Prior reasoning',expectedOutcome:'Predicted change'});
   expect(serialized.task.decision.grounds).toBeUndefined();
   expect(serialized.decisionInterpretation).toEqual({summary:'assistant-inference',rationale:'assistant-inference',expectedOutcome:'assistant-prediction'});
  }finally{f.close();}
 });
});

describe('authentic accepted local observations',()=>{
 it('instructs knowledge extraction to preserve a whole declared relation block without inventing evidence',async()=>{
  const f=protocolFixture();try{
   f.input.role='knowledge_extract';f.input.task.stage='knowledge_extract';f.input.task.status='extracting';
   f.config.runnerPolicies[0]!.roles=['knowledge_extract'];f.store.save('tasks',f.input.task);
   await new LimaWorker('grok',f.config,f.billing).run(f.input).catch(()=>undefined);
   const prompt=readFileSync(join(f.root,'last-prompt'),'utf8');
   expect(prompt).toContain('@@experience-relations-v1');
   expect(prompt).toContain('entire declaration block byte-for-byte as the quote prefix');
   expect(prompt).toContain('only contiguous source text');
   expect(prompt).toContain('Do not invent slots, source text, check results, or claims of verification');
  }finally{f.close();}
 });
 it.each((['execute','check'] as const).flatMap(role=>(['persisted','hold-write-unavailable'] as const).map(mode=>[role,mode] as const)))('holds a consumed %s identity across reopen and requires explicit retry (%s)',async(role,mode)=>{
  const f=protocolFixture({role});let engine:Workbench|undefined,original:WorkerResult|undefined,reopened:Store|undefined;
  vi.useFakeTimers({toFake:['Date']});
  try{
   const worker=new LimaWorker('grok',f.config,f.billing);
   engine=new Workbench({store:f.store,config:f.config,billing:f.billing,workers:[{name:'grok',async run(input,signal,permit){original=await worker.run(input,signal,permit);return original;}}],writer:{async baseline(){return 'base';},async deliver(){throw Error('not used');}},research:{async research(){throw Error('not used');}}});
   (engine as any).input=()=>f.input;
   const transaction=f.store.transaction.bind(f.store);let injected=false;
   const spy=vi.spyOn(f.store,'transaction').mockImplementation(((fn:()=>unknown)=>{
    if(!injected&&new Error().stack?.includes('recordLocalTests')){injected=true;throw Object.assign(new Error('post-consumption contention'),{code:'SQLITE_BUSY_SNAPSHOT'});}
    return transaction(fn);
   }) as typeof f.store.transaction);
   const save=f.store.save.bind(f.store);
   const saveSpy=vi.spyOn(f.store,'save').mockImplementation(((...args:Parameters<typeof save>)=>{
    if(mode==='hold-write-unavailable'&&new Error().stack?.includes('holdLocalTask'))throw Object.assign(new Error('hold unavailable'),{code:'SQLITE_BUSY'});
    return save(...args);
   }) as typeof f.store.save);
   await engine.tick().catch(()=>undefined);spy.mockRestore();if(mode==='persisted')saveSpy.mockRestore();
   expect(injected).toBe(true);expect(original).toBeDefined();expect(takeHostTestRun(original!)).toBeUndefined();
   expect(f.store.list('attempts')).toMatchObject([{status:'succeeded'}]);expect(f.store.list('actions').filter(a=>a.kind==='experience.test-observation')).toEqual([]);
   for(let i=0;i<48;i++){vi.setSystemTime(new Date(Date.now()+750));await engine.tick().catch(()=>undefined);}
   expect(f.events().filter(e=>e.stage==='tests')).toHaveLength(1);
   expect(f.store.list('attempts')).toHaveLength(1);
   await engine.shutdown();
   if(mode==='hold-write-unavailable')expect(f.store.get('tasks',f.input.task.id)?.status).toBe(role==='execute'?'executing':'checking');
   const path=join(f.root,'held-local.sqlite');await f.store.backup(path);saveSpy.mockRestore();reopened=new Store(path);
   const billing=new BillingAuthority(reopened,f.config,{async read(){return structuredClone(f.current);}},{proofRoot:f.proofRoot,now:()=>f.at});
   const freshWorker=new LimaWorker('grok',f.config,billing);
   engine=new Workbench({store:reopened,config:f.config,billing,workers:[freshWorker],writer:{async baseline(){return 'base';},async deliver(){throw Error('not used');}},research:{async research(){throw Error('not used');}}});
   (engine as any).input=()=>({...f.input,task:reopened!.get('tasks',f.input.task.id)!});
   for(let i=0;i<4;i++){vi.setSystemTime(new Date(Date.now()+750));await engine.tick();}
   expect(reopened.list('attempts')).toHaveLength(1);expect(f.events().filter(e=>e.stage==='tests')).toHaveLength(1);
   expect(reopened.get('tasks',f.input.task.id)?.status).toBe('blocked');
   engine.retry(f.input.task.id);await engine.tick();
   expect(reopened.list('attempts').map(attempt=>attempt.status)).toEqual(['succeeded','succeeded']);
   expect(f.events().filter(e=>e.stage==='tests')).toHaveLength(2);
   expect(reopened.list('actions').filter(action=>action.kind==='experience.test-observation')).toHaveLength(1);
   await engine.shutdown();
  }finally{vi.useRealTimers();await engine?.shutdown();reopened?.close();f.close();}
 });
 it.each(['execute','check'] as const)('captures raw %s identity across Billing clone exactly once',async role=>{
  const f=protocolFixture({role});try{
   const worker=new LimaWorker('grok',f.config,f.billing);let original:WorkerResult|undefined,accepted:WorkerResult|undefined;
   const dispatch=f.billing.dispatch.bind(f.billing);vi.spyOn(f.billing,'dispatch').mockImplementation(async(...args)=>{accepted=await dispatch(...args);expect(takeHostTestRun(accepted)).toBeUndefined();return accepted;});
   const scheduler=new Scheduler(f.store,f.config,[{name:'grok',async run(input,signal,permit){original=await worker.run(input,signal,permit);expect(takeHostTestRun({...original})).toBeUndefined();return original;}}],f.billing);
   const output=await scheduler.run(f.input.task,f.input.project,f.input);
   const actions=f.store.list('actions').filter(a=>a.kind==='experience.test-observation');expect(actions).toHaveLength(1);
   const observation=actions[0]!.payload.observation as any,attempt=f.store.list('attempts')[0]!;
   expect(accepted).not.toBe(original);expect(output).not.toBe(original!.output);expect(takeHostTestRun(original!)).toBeUndefined();expect(takeHostTestRun({...original!})).toBeUndefined();
   expect(observation.origin).toMatchObject({kind:'local',role,taskId:f.input.task.id,attemptId:attempt.id,inputHash:attempt.inputHash,planHash:digest(f.input.plan!),artifactHash:digest(role==='check'?f.input.artifact! :output as object)});
   expect(observation.snapshot).toMatchObject({revision:'base',overlayHash:digest({state:'measured',files:[]}),files:[{path:'docs/PRD.md',mode:'100644'}]});expect(observation.checks[0].id).toBe(stableId('local-check',f.input.plan!.tests[0]));
   expect(attempt).toMatchObject({status:'succeeded',costUsd:0});expect(f.store.list('attempts')).toHaveLength(1);expect(f.events().filter(e=>e.stage==='tests')).toHaveLength(1);
   const {readTestObservation}=await import('../../src/knowledge-records.js');expect(readTestObservation(f.store,observation.id,f.input.project)).toEqual(observation);
   f.store.save('tasks',{...f.store.get('tasks',f.input.task.id)!,version:2,stage:'delivery',status:'publishing'});expect(readTestObservation(f.store,observation.id,f.input.project)).toEqual(observation);
  }finally{f.close();}
 });
});


describe('local observation fail-closed boundaries',()=>{
 it.each(['nonce','malformed','trailing','duplicate','id','oversized','encoding','padding','whitespace','legacy','tail','digest'] as const)('rejects %s private frames without canonical evidence',async frameFault=>{
  const f=protocolFixture({role:'execute',frameFault});try{await new Scheduler(f.store,f.config,[new LimaWorker('grok',f.config,f.billing)],f.billing).run(f.input.task,f.input.project,f.input);expect(f.store.list('actions').filter(a=>a.kind==='experience.test-observation')).toEqual([]);expect(f.events().slice(-3).map(e=>e.stage)).toEqual(['stop','cleanup','reconcile']);}finally{f.close();}
 });
 const kinds=['stale','cancelled','source','project','output','binding','billing-stop','latest'] as const;
 it.each(kinds.flatMap(kind=>['before-settlement','after-settlement'].map(at=>({kind,at}))))('consumes then rejects $kind $at',async({kind,at})=>{
  const f=protocolFixture({role:'execute'});let original:WorkerResult|undefined;
  const mutate=(result:WorkerResult)=>{const task=f.store.get('tasks',f.input.task.id)!;
   if(kind==='stale')f.store.save('tasks',{...task,version:2});
   if(kind==='cancelled')f.store.save('tasks',{...task,status:'cancelled'});
   if(kind==='source')f.store.save('sources',{...f.input.source,content:'edited after test completion'});
   if(kind==='project')f.store.save('projects',{...f.input.project,allowedPaths:['docs/','other/']});
   if(kind==='output')(result.output as any).summary='changed after private frame';
   if(kind==='binding')(result.output as any).planHash='unbound';
   if(kind==='billing-stop')f.store.save('tasks',{...task,billingStop:{code:'subscription_auth',at:new Date().toISOString()}});
   if(kind==='latest'){const attempt=f.store.list('attempts').at(-1)!;f.store.save('attempts',{...attempt,id:'later-attempt'});}
  };
  if(at==='after-settlement'){const dispatch=f.billing.dispatch.bind(f.billing);vi.spyOn(f.billing,'dispatch').mockImplementation(async(...args)=>{const result=await dispatch(...args);mutate(result);return result;});}
  const worker=new LimaWorker('grok',f.config,f.billing),scheduler=new Scheduler(f.store,f.config,[{name:'grok',async run(input,signal,permit){original=await worker.run(input,signal,permit);if(at==='before-settlement')mutate(original);return original;}}],f.billing);
  try{await scheduler.run(f.input.task,f.input.project,f.input).catch(()=>undefined);expect(original).toBeDefined();expect(takeHostTestRun(original!)).toBeUndefined();expect(f.store.list('actions').filter(a=>a.kind==='experience.test-observation')).toEqual([]);expect(f.events().filter(e=>e.stage==='tests')).toHaveLength(1);}finally{f.close();}
 });
 it.each(['cleanup','reconcile','timeout'] as const)('never admits a passing frame with unconfirmed %s',async kind=>{
  const f=protocolFixture({role:'execute',...(kind==='cleanup'?{cleanupFailure:true}:kind==='reconcile'?{fail:'reconcile'}:{holdCli:true})});if(kind==='timeout')f.config.workers.grok!.timeoutMs=200;
  try{await new Scheduler(f.store,f.config,[new LimaWorker('grok',f.config,f.billing)],f.billing).run(f.input.task,f.input.project,f.input).catch(()=>undefined);expect(f.store.list('actions').filter(a=>a.kind==='experience.test-observation')).toEqual([]);}finally{f.close();}
 });
 it('discards the private tail before result, canonical rows, restart and later prompt',async()=>{
  const f=protocolFixture({role:'execute'});try{const scheduler=new Scheduler(f.store,f.config,[new LimaWorker('grok',f.config,f.billing)],f.billing),output=await scheduler.run(f.input.task,f.input.project,f.input);
   const action=f.store.list('actions').find(a=>a.kind==='experience.test-observation')!,observation=action.payload.observation as any;expect(observation.comparable).toBeDefined();
   const retainedText=JSON.stringify(output)+JSON.stringify(f.store.list('actions'));expect(retainedText).not.toContain('SYNTHETIC_PRIVATE_STDOUT_SENTINEL');expect(retainedText).not.toContain(Buffer.from('actual synthetic test SYNTHETIC_PRIVATE_STDOUT_SENTINEL').toString('base64'));expect(retainedText).not.toContain('outputBase64');
   const {Store}=await import('../../src/store.js'),db=join(f.root,'retained.sqlite');let retained=new Store(db);for(const table of ['projects','sources','tasks','attempts','actions'] as const)for(const row of f.store.list(table))retained.save(table,row as any);retained.close();retained=new Store(db);
   try{const {readTestObservation}=await import('../../src/knowledge-records.js');expect(readTestObservation(retained,observation.id,f.input.project)).toEqual(observation);retained.save('sources',{...f.input.source,status:'withdrawn'});expect(readTestObservation(retained,observation.id,f.input.project)).toBeUndefined();}finally{retained.close();}
   await scheduler.run(f.input.task,f.input.project,{...f.input,artifact:output as any});expect(readFileSync(join(f.root,'last-prompt'),'utf8')).not.toContain('SYNTHETIC_PRIVATE_STDOUT_SENTINEL');
  }finally{f.close();}
 });
});


it('consumes private evidence when accepted attempt runner is changed after settlement',async()=>{
 const f=protocolFixture({role:'execute'});let original:WorkerResult|undefined;const dispatch=f.billing.dispatch.bind(f.billing);
 vi.spyOn(f.billing,'dispatch').mockImplementation(async(...args)=>{const result=await dispatch(...args),attempt=f.store.list('attempts').at(-1)!;f.store.save('attempts',{...attempt,runner:'codex'});return result;});
 try{const worker=new LimaWorker('grok',f.config,f.billing);await new Scheduler(f.store,f.config,[{name:'grok',async run(input,signal,permit){original=await worker.run(input,signal,permit);return original;}}],f.billing).run(f.input.task,f.input.project,f.input);expect(f.store.list('actions').filter(a=>a.kind==='experience.test-observation')).toEqual([]);expect(takeHostTestRun(original!)).toBeUndefined();}finally{f.close();}
});


it('does not publish private provenance when global timeout expires during successful finalization',async()=>{
 const f=protocolFixture({role:'execute',stopDelayMs:2800});f.config.workers.grok!.timeoutMs=2500;
 try{await new Scheduler(f.store,f.config,[new LimaWorker('grok',f.config,f.billing)],f.billing).run(f.input.task,f.input.project,f.input).catch(()=>undefined);expect(f.events().filter(e=>e.stage==='tests')).toHaveLength(1);expect(f.store.list('actions').filter(a=>a.kind==='experience.test-observation')).toEqual([]);}finally{f.close();}
});


it('retains captured process failure without comparable identity or error-code-as-name',async()=>{
 const f=protocolFixture({role:'execute',capturedError:'ENOBUFS'});try{const output:any=await new Scheduler(f.store,f.config,[new LimaWorker('grok',f.config,f.billing)],f.billing).run(f.input.task,f.input.project,f.input),o:any=f.store.list('actions').find(a=>a.kind==='experience.test-observation')!.payload.observation;expect(output.tests[0].passed).toBe(false);expect(o.comparable).toBeUndefined();expect(o.checks[0]).toMatchObject({result:'failure',process:{errorCode:'ENOBUFS'}});expect(o.checks[0].name).toBeUndefined();}finally{f.close();}
});


it.each([{role:'execute',bindingMismatch:'plan'},{role:'check',bindingMismatch:'artifact'}] as const)('rejects actual model structural $bindingMismatch mismatch before canonical admission',async options=>{
 const f=protocolFixture(options);let original:WorkerResult|undefined;try{const worker=new LimaWorker('grok',f.config,f.billing),output:any=await new Scheduler(f.store,f.config,[{name:'grok',async run(input,signal,permit){original=await worker.run(input,signal,permit);return original;}}],f.billing).run(f.input.task,f.input.project,f.input);expect(output.tests[0].passed).toBe(true);expect(f.store.list('attempts')[0]?.status).toBe('succeeded');expect(f.store.list('actions').filter(a=>a.kind==='experience.test-observation')).toEqual([]);expect(takeHostTestRun(original!)).toBeUndefined();}finally{f.close();}
});


it.each([{testFiles:['docs/missing-test.js'],baselineContent:'fixture',incomplete:true},{testFiles:[],baselineContent:'earlier baseline',incomplete:false}])('retains actual process outcome with bounded measurement limits %j',async options=>{
 const f=protocolFixture({role:'execute',...options});try{const output:any=await new Scheduler(f.store,f.config,[new LimaWorker('grok',f.config,f.billing)],f.billing).run(f.input.task,f.input.project,f.input),o:any=f.store.list('actions').find(a=>a.kind==='experience.test-observation')!.payload.observation;expect(output.tests[0].passed).toBe(true);expect(o.checks[0].result).toBe(options.incomplete?'incomplete':'success');
  if(options.incomplete){expect(o.comparable).toBeUndefined();expect(o.environment.unknown).toContain('fileMeasurement');}else{expect(o.comparable).toBeDefined();expect(o.snapshot.overlayHash).toBe(digest({state:'measured',files:o.snapshot.files}));expect(o.snapshot.overlayHash).not.toBe(digest({state:'measured',files:[]}));}
 }finally{f.close();}
});


it('recomputes exact binary output SHA on the host and discards the private Base64 carrier',async()=>{
 const f=protocolFixture({role:'execute',binaryTail:true});try{const output=await new Scheduler(f.store,f.config,[new LimaWorker('grok',f.config,f.billing)],f.billing).run(f.input.task,f.input.project,f.input),action=f.store.list('actions').find(a=>a.kind==='experience.test-observation')!,o:any=action.payload.observation,bytes=Buffer.from([255,0,195,40,254,240,159,152,128]),{createHash}=await import('node:crypto');expect(o.checks[0].outputDigest).toBe(createHash('sha256').update(bytes).digest('hex'));expect(JSON.stringify(output)+JSON.stringify(action)).not.toContain(bytes.toString('base64'));expect(JSON.stringify(output)+JSON.stringify(action)).not.toContain('outputBase64');}finally{f.close();}
});


it('accepts exactly12000 decoded private bytes at the host boundary',async()=>{
 const f=protocolFixture({role:'execute',largeTail:true});try{await new Scheduler(f.store,f.config,[new LimaWorker('grok',f.config,f.billing)],f.billing).run(f.input.task,f.input.project,f.input);const o:any=f.store.list('actions').find(a=>a.kind==='experience.test-observation')!.payload.observation,{createHash}=await import('node:crypto');expect(o.checks[0].outputDigest).toBe(createHash('sha256').update(Buffer.alloc(12000,171)).digest('hex'));}finally{f.close();}
});

describe('G4 independent actual local and repository producer paths',()=>{
 it('compares retained accepted Lima/Billing/Scheduler observation with authenticated attested GitLab execution',async()=>{
  const f=protocolFixture({role:'execute',comparableRepository:true});try{
   const {repositoryKnowledgeFixture,reportPath}=await import('../fixtures/repository-knowledge.js');
   const {acceptRepositoryReadback,linkKnowledgeEvidence,compareIndependentClaim}=await import('../../src/knowledge-evidence.js');
   const {readHostObservation,referenceExperienceObservation}=await import('../../src/knowledge-records.js');
   await new Scheduler(f.store,f.config,[new LimaWorker('grok',f.config,f.billing)],f.billing).run(f.input.task,f.input.project,f.input);
   const action=f.store.list('actions').find(a=>a.kind==='experience.test-observation')!,local=referenceExperienceObservation(f.store,action.id)!;
   expect(local).toBeDefined();expect(local.claim.kind).toBe('test-result');
   const ci=repositoryKnowledgeFixture('gitlab',{store:f.store,project:f.input.project,bytes:Buffer.from('fixture'),path:'docs/PRD.md',command:'literal test;$(id)'});
   const sourceBefore=digest(f.store.get('sources',f.input.source.id)!),projectBefore=digest(f.store.get('projects',f.input.project.id)!);
   ci.request.testReportPath=reportPath;ci.report.snapshot.overlayHash=digest({state:'measured',files:[]});
   const readback=await ci.reader.read(ci.project,ci.source,ci.request,new AbortController().signal),ids=acceptRepositoryReadback(f.store,ci.source.id,readback),external=ids.map(id=>readHostObservation(f.store,id,f.input.project)!).find(o=>o.claim.kind==='test-result')!;
   expect(external).toBeDefined();expect(external.claim).toEqual(local.claim);expect(compareIndependentClaim(local.claim,[local,external])).toBe(true);
   expect(local.origin.originalEventId).not.toBe(external.origin.originalEventId);expect(local.origin.independentOrigin).not.toBe(external.origin.independentOrigin);
   expect(digest(f.store.get('sources',f.input.source.id)!)).toBe(sourceBefore);expect(digest(f.store.get('projects',f.input.project.id)!)).toBe(projectBefore);
   f.store.save('cards',{id:'independent',projectId:f.input.project.id,domain:f.input.project.domain,sourceId:f.input.source.id,sourceRevision:f.input.source.revision,title:'Retained measured result',body:'reported solution',quote:'Measured local run',locator:'fixture',kind:'fact',verification:'reported',status:'active',aliases:[],createdAt:'',claim:{schemaVersion:1,claim:local.claim,quote:'Measured local run',interpretation:'reported'}});
   expect(linkKnowledgeEvidence(f.store,'independent',[local.id,external.id]).basis).toBe('independent-corroboration');
   f.store.save('tasks',{...f.store.get('tasks',f.input.task.id)!,version:2,stage:'feedback'});expect(referenceExperienceObservation(f.store,action.id)).toEqual(local);
   const repeat=acceptRepositoryReadback(f.store,ci.source.id,await ci.reader.read(ci.project,ci.source,ci.request,new AbortController().signal));expect(compareIndependentClaim(local.claim,[external,readHostObservation(f.store,repeat.at(-1)!,f.input.project)!])).toBe(false);
   const observations=f.store.list('actions').filter(a=>a.kind==='experience.test-observation');expect(observations).toHaveLength(2);
   const localRows=observations.filter(a=>(a.payload.observation as any).origin.kind==='local'),ciRows=observations.filter(a=>(a.payload.observation as any).origin.kind==='ci');
   expect(localRows).toHaveLength(1);expect(localRows[0]!.id).toBe(action.id);expect(ciRows).toHaveLength(1);
   expect(ciRows[0]!.payload).toMatchObject({sourceHash:digest(ci.source),sourceRefs:[{id:ci.source.id,revision:ci.source.revision}],observation:{sourceId:ci.source.id,sourceRevision:ci.source.revision,origin:{kind:'ci',runId:'52',jobId:'71'},checks:[{result:'success'}]}});
   expect((ciRows[0]!.payload.hostObservationIds as string[])).toContain(external.id);expect(f.store.list('actions').filter(a=>a.kind==='knowledge.host-observation'&&(a.payload.observation as any).origin.kind==='host-test')).toHaveLength(0);
   ci.close();
  }finally{f.close();}
 });
});
