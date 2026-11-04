import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig, WorkerInput } from '../../src/domain.js';
import { LimaWorker, parseWorkerOutput, commandFor, guestScripts } from '../../src/integrations/workers.js';
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
    try {
      const bin = join(root, 'bin'), home = join(root, 'home'), temporary = join(root, 'tmp');
      const limaHome = privateHome ? join(root, 'private-lima') : join(home, '.lima');
      for (const path of [bin, home, temporary, limaHome]) mkdirSync(path, { recursive: true });
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
const argv = process.argv.slice(2), prefix = argv.slice(3,16), args = argv.slice(16), dir = '/tmp/patrick-Fixture123';
function fail(message) { fs.writeFileSync(${JSON.stringify(failurePath)}, message + ': ' + keys.join(',')); process.exit(78); }
if (leaked.length || keys.some(key => !['PATH', 'HOME', 'TMPDIR', 'LIMA_HOME'].includes(key))) fail('Host environment leaked');
if (argv[0] !== 'shell' || argv[1] !== 'fixture-instance' || argv[2] !== '--') fail('Unexpected limactl command');
if (JSON.stringify(prefix) !== JSON.stringify(['/usr/bin/sudo','-n','--','/usr/local/libexec/patrick-worker-enter','--runner','grok','--user','patrick-grok','--project','fixture-project','--domain','personal','--'])) fail('Missing fixed identity and scope');
if (!fs.existsSync(path.join(limaHome, 'fixture-instance'))) fail('Fixture instance unavailable in selected Lima home');
const active = path.join(limaHome, 'workspace-active');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  let stage;
  if (args[0] === 'node' && args[1] === '-e' && args[2] === scripts.prepare) {
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

      const run = new LimaWorker('grok', config).run({ task, project, source, role: 'feedback', cards: [], rules: [] }).catch(error => {
        if (existsSync(failurePath)) error.message += ` ${readFileSync(failurePath, 'utf8')}`;
        throw error;
      });
      await expect(run).resolves.toEqual({ output, costUsd: 0, provider: 'fixture-provider', model: 'fixture-model' });
      const events = readFileSync(eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const keys = ['PATH', 'HOME', 'TMPDIR', ...(privateHome ? ['LIMA_HOME'] : [])].sort();
      expect(events).toEqual(['prepare', 'cli', 'cleanup'].map(stage => ({ stage, limaHome, keys, leaked: [], PATH: bin, HOME: home, TMPDIR: temporary })));
      expect(existsSync(join(limaHome, 'workspace-active'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

type FixtureOptions={runner?:'grok'|'codex'|'dsh';role?:'feedback'|'execute';fail?:string;holdCli?:boolean;cleanupFailure?:boolean};
function protocolFixture(options:FixtureOptions={}) {
  const root=mkdtempSync(join(tmpdir(),'patrick-identity-protocol-')),bin=join(root,'bin'),eventsPath=join(root,'events');mkdirSync(bin);
  const runner=options.runner??'grok',role=options.role??'feedback',createdAt='2026-01-01T00:00:00.000Z';
  const project:WorkerInput['project']={id:'bound-project',projectId:'bound-project',domain:'私人领域',name:'Fixture',description:'',repository:'fixture/repo',repositoryProvider:'github',prdPath:'docs/PRD.md',allowedPaths:['docs/'],trustedChecks:[],trustedAppIds:[],ownerId:'owner',autoMerge:false,budgetUsd:0,createdAt};
  const source:WorkerInput['source']={id:'source',projectId:project.id,domain:project.domain,kind:'manual',externalId:'fixture',revision:'revision',title:'fixture',content:'',locator:'fixture',authorId:'owner',retention:'ephemeral',status:'active',createdAt};
  const task:WorkerInput['task']={id:'task',projectId:project.id,domain:project.domain,sourceId:source.id,sourceRevision:source.revision,title:'fixture',description:'',status:'feedback',version:1,createdAt,updatedAt:createdAt,runAfter:createdAt,attempts:0,repairCount:0,budgetUsd:0,spentUsd:0,stage:role};
  const literal='fixture-model;$(touch /tmp/never-executed)';
  const config:AppConfig={mode:'test',host:'localhost',port:1,dataDir:root,vaultDir:root,ownerId:'owner',authToken:'',sessionSecret:'',projects:[project],scanIntervalMs:1000,workers:{[runner]:{command:`fixture-${runner}`,args:['literal;$(id)'],isolation:'lima',instance:'fixture-instance',guestUser:'patrick-dedicated',timeoutMs:5000}},runnerPolicies:[{runner,roles:[role],domains:[project.domain],provider:'fixture',model:literal,admitted:true,costPerRunUsd:0,independentReview:false}]};
  const input:WorkerInput={task,project,source,role,cards:[],rules:[],...(role==='execute'?{plan:{taskVersion:1,sourceRevision:'revision',baselineSha:'base',summary:'fixture',paths:['docs/PRD.md'],steps:['write'],tests:['literal test;$(id)'],stopConditions:['stop']}}:{})};
  const output=role==='execute'?{taskVersion:1,planHash:'hash',baselineSha:'base',files:[{path:'docs/PRD.md',content:'fixture'}],tests:[{command:'declared',passed:false,output:'untrusted'}],summary:'fixture'}:{summary:'fixture',observations:[]};
  const prefix=['/usr/bin/sudo','-n','--','/usr/local/libexec/patrick-worker-enter','--runner',runner,'--user','patrick-dedicated','--project',project.projectId,'--domain',project.domain,'--'];
  writeFileSync(join(bin,'limactl'),`#!${process.execPath}
const fs=require('node:fs'),readline=require('node:readline');
const options=${JSON.stringify(options)},scripts=${JSON.stringify(guestScripts)},output=${JSON.stringify(output)},prefix=${JSON.stringify(prefix)};
const argv=process.argv.slice(2),args=argv.slice(16),dir='/tmp/patrick-Scope123';
if(JSON.stringify(argv.slice(0,3))!==JSON.stringify(['shell','fixture-instance','--'])||JSON.stringify(argv.slice(3,16))!==JSON.stringify(prefix))process.exit(78);
let stage=args[0]==='node'?(args[2]===scripts.prepare?'prepare':args[2]===scripts.tests?'tests':args[2]===scripts.read?'read':args[2]===scripts.cleanup?'cleanup':'invalid'):args[0]==='sh'?'cli':args[0]==='fixture-dsh'?'acp':'invalid';
fs.appendFileSync(${JSON.stringify(eventsPath)},JSON.stringify({stage,prefix,args})+'\\n');
if(stage===options.fail||(stage==='cleanup'&&options.cleanupFailure))process.exit(78);
if(stage==='cli'&&options.holdCli){setInterval(()=>{},1000);process.stdin.resume();}
else if(stage==='acp') {
 const lines=readline.createInterface({input:process.stdin});
 const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
 lines.on('line',line=>{const message=JSON.parse(line);let result;
 if(message.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:false}};
 else if(message.method==='session/new')result={sessionId:'fixture-session'};
 else if(message.method==='session/prompt'){send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(output)}}}});result={stopReason:'end_turn'};}
 else process.exit(78);
 send({jsonrpc:'2.0',id:message.id,result});});
} else {let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
 if(stage==='prepare')process.stdout.write(JSON.stringify({dir}));
 else if(stage==='cli'){if(!args.includes(${JSON.stringify(literal)})||!args.includes('literal;$(id)'))process.exit(78);process.stdout.write(JSON.stringify(output));}
 else if(stage==='read')process.stdout.write(JSON.stringify(output));
 else if(stage==='tests'){const payload=JSON.parse(input);if(payload.commands[0]!=='literal test;$(id)')process.exit(78);process.stdout.write(JSON.stringify([{command:payload.commands[0],passed:true,output:'actual synthetic test'}]));}
 else if(stage!=='cleanup')process.exit(78);
 });}
`,{mode:0o700});
  vi.stubEnv('PATH',bin);
  return {input,config,events:()=>existsSync(eventsPath)?readFileSync(eventsPath,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[],close:()=>{vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});}};
}

describe('enforced guest identity across adapter stages',()=>{
  it.each([{runner:'grok',role:'execute',stages:['prepare','cli','tests','cleanup']},{runner:'codex',role:'feedback',stages:['prepare','cli','read','cleanup']},{runner:'dsh',role:'feedback',stages:['prepare','acp','cleanup']}] as const)('keeps the bound tuple for $runner $role',async scenario=>{
    const fixture=protocolFixture(scenario);
    try {
      const result=await new LimaWorker(scenario.runner,fixture.config).run(fixture.input);
      expect(result.costUsd).toBe(0);
      const events=fixture.events();expect(events.map(event=>event.stage)).toEqual(scenario.stages);
      expect(new Set(events.map(event=>JSON.stringify(event.prefix))).size).toBe(1);
      if(scenario.role==='execute')expect((result.output as any).tests[0].output).toBe('actual synthetic test');
    } finally {fixture.close();}
  });
  it.each(['prepare','cli','read','tests','acp'])('fails closed at %s and cleans known workspaces using the original tuple',async fail=>{
    const runner=fail==='read'?'codex':fail==='acp'?'dsh':'grok',fixture=protocolFixture({runner,role:fail==='tests'?'execute':'feedback',fail});
    try {
      await expect(new LimaWorker(runner,fixture.config).run(fixture.input)).rejects.toMatchObject({name:'WorkerUnavailable'});
      const events=fixture.events();expect(events.at(-1).stage).toBe(fail==='prepare'?'prepare':'cleanup');
      expect(new Set(events.map(event=>JSON.stringify(event.prefix))).size).toBe(1);
    } finally {fixture.close();}
  });
  it.each([false,true])('refuses cleanup uncertainty with primary failure: %s',async primaryFailure=>{
    const fixture=protocolFixture({cleanupFailure:true,...(primaryFailure?{fail:'cli'}:{})});
    try {
      const error=await new LimaWorker('grok',fixture.config).run(fixture.input).catch(error=>error);
      expect(error).toMatchObject({name:'DomainError',code:'worker_cleanup_unconfirmed',message:'Isolated worker cleanup could not be confirmed.'});
      if(primaryFailure)expect(error.cause).toMatchObject({name:'WorkerUnavailable'});else expect(error.cause).toBeUndefined();
    } finally {fixture.close();}
  });
  it('uses a fresh cleanup signal and frozen tuple after cancellation and caller mutation',async()=>{
    const fixture=protocolFixture({holdCli:true}),controller=new AbortController();
    try {
      const run=new LimaWorker('grok',fixture.config).run(fixture.input,controller.signal).catch(error=>error);
      for(let attempt=0;attempt<100&&fixture.events().at(-1)?.stage!=='cli';attempt++)await new Promise(resolve=>setTimeout(resolve,10));
      expect(fixture.events().at(-1)?.stage).toBe('cli');
      fixture.input.project.domain='mutated';fixture.input.project.projectId='mutated';fixture.config.workers.grok!.guestUser='patrick-mutated';
      controller.abort();
      expect(await run).toMatchObject({name:'WorkerUnavailable'});
      const events=fixture.events();expect(events.map(event=>event.stage)).toEqual(['prepare','cli','cleanup']);
      expect(new Set(events.map(event=>JSON.stringify(event.prefix))).size).toBe(1);
    } finally {fixture.close();}
  });
});
