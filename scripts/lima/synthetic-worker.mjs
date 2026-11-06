#!/usr/local/bin/node
// Fixed, no-model qualification fixture. No provider, credential or network API.
import * as fs from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cases=new Set(['pass','failed-test','exit-nonzero','malformed','wait','fork-setsid','stdout-overflow','stderr-overflow','codex-missing-result','acp-permission','acp-non-end-turn','acp-early-exit','profile-home-control']);
const fail=()=>{process.stderr.write('synthetic-fixture-denied\n');process.exit(78);};
process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
function selectors(argv){
 if(argv.length<2||!argv[0].startsWith('--fixture-case=')||!argv[1].startsWith('--fixture-protocol='))fail();
 const behavior=argv[0].slice(15),protocol=argv[1].slice(19);if(!cases.has(behavior)||!['cli','acp'].includes(protocol))fail();return {behavior,protocol,args:argv.slice(2)};
}
function frozen(prompt){if(typeof prompt!=='string'||Buffer.byteLength(prompt)>1048576)fail();const index=prompt.indexOf('\nFROZEN INPUT:\n');if(index<0)fail();try{const value=JSON.parse(prompt.slice(index+15));if(!value||!['feedback','execute','check'].includes(value.role)||!Number.isSafeInteger(value.task?.version))fail();return value;}catch{fail();}}
function output(prompt){const p=frozen(prompt),base={taskVersion:p.task.version,planHash:'synthetic-plan'};
 if(p.role==='feedback')return {summary:'synthetic',observations:[]};
 if(p.role==='check')return {...base,artifactHash:'synthetic-artifact',verdict:'pass',summary:'synthetic',issues:[],tests:[{command:'synthetic-fabricated-test',passed:true,output:'synthetic claim'}]};
 return {...base,baselineSha:p.plan?.baselineSha??p.task.plan?.baselineSha,files:[{path:'synthetic.txt',content:'synthetic\n'}],tests:[{command:'synthetic-fabricated-test',passed:true,output:'synthetic claim'}],summary:'synthetic'};
}
function profileControl(){const home=process.env.HOME;if(!home||!home.startsWith('/var/lib/patrick-'))fail();for(const name of ['.patrick-synthetic-auth','.patrick-synthetic-config']){const s=fs.lstatSync(home+'/'+name);if(s.isSymbolicLink()||!s.isFile()||s.uid!==0||(s.mode&0o777)!==0o444||fs.readFileSync(home+'/'+name,'utf8')!==`patrick-synthetic:${name}\n`)fail();}}
function behaviorBefore(behavior){
 if(behavior==='exit-nonzero')process.exit(23);
 if(behavior==='malformed'){process.stdout.write('synthetic malformed\n');return true;}
 if(behavior==='stdout-overflow'||behavior==='stderr-overflow'){(behavior==='stdout-overflow'?process.stdout:process.stderr).write('x'.repeat(2_000_001));return true;}
 if(behavior==='wait'){process.stdin.resume();setInterval(()=>{},1000);return true;}
 if(behavior==='fork-setsid'){
  // The sole child-creation case launches this same reviewed finite fixture.
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--fixture-case=wait','--fixture-protocol=cli'],{detached:true,stdio:'ignore',env:{HOME:process.env.HOME,PATH:'/usr/local/bin:/usr/bin:/bin'}});child.unref();return false;
 }
 if(behavior==='profile-home-control')profileControl();return false;
}
function cliFlags(args){
 if(!args.length)return {runner:'none'};
 if(args[0]==='exec'){
  const fixed=['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--model','synthetic-model','--output-schema','schema.json','--output-last-message','result.json','-'];
  if(JSON.stringify(args)!==JSON.stringify(fixed))fail();return {runner:'codex'};
 }
 const fixed=['--model','synthetic-model','--no-subagents','--no-plan','--permission-mode','plan','--disable-web-search','--json-schema'];
 if(JSON.stringify(args.slice(0,8))!==JSON.stringify(fixed)||typeof args[8]!=='string'||JSON.stringify(args.slice(9))!==JSON.stringify(['--output-format','json','--max-turns','8','--prompt-file','prompt.txt']))fail();
 try{JSON.parse(args[8]);}catch{fail();}return {runner:'grok'};
}
const {behavior,protocol,args}=selectors(process.argv.slice(2));
if(protocol==='cli'){
 const {runner}=cliFlags(args);if(behaviorBefore(behavior)){}else if(runner==='grok'){process.stdout.write(JSON.stringify(output(fs.readFileSync('prompt.txt','utf8'))));}
 else if(runner==='codex'){let prompt='';process.stdin.on('data',c=>{prompt+=c;if(Buffer.byteLength(prompt)>1048576)fail();});process.stdin.on('end',()=>{const result=output(prompt);if(behavior!=='codex-missing-result')fs.writeFileSync('result.json',JSON.stringify(result),{mode:0o600,flag:'wx'});process.stdout.write('synthetic-irrelevant-stdout\n');});}
 else if(behavior!=='wait')fail();
}else{
 if(args.length!==0&&JSON.stringify(args)!==JSON.stringify(['--acp']))fail();
 if(behavior==='acp-early-exit')process.exit(0);if(behaviorBefore(behavior)){}else{
 const lines=createInterface({input:process.stdin}),send=value=>process.stdout.write(JSON.stringify(value)+'\n');let initialized=false,session=false,promptId,done=false;
 lines.on('line',line=>{try{if(Buffer.byteLength(line)>1048576)fail();const m=JSON.parse(line);let result;
  if(m.id===9001&&!m.method){if(behavior!=='acp-permission'||m.result?.outcome?.outcome!=='cancelled')fail();send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}});done=true;return;}
  if(m.method==='initialize'&&!initialized){initialized=true;result={protocolVersion:1,agentCapabilities:{loadSession:false}};}
  else if(m.method==='session/new'&&initialized&&!session){session=true;result={sessionId:'synthetic-session'};}
  else if(m.method==='session/prompt'&&session&&!done){if(m.params?.sessionId!=='synthetic-session'||m.params.prompt?.length!==1||m.params.prompt[0].type!=='text')fail();const value=output(m.params.prompt[0].text);
   if(behavior==='acp-permission'){promptId=m.id;send({jsonrpc:'2.0',id:9001,method:'session/request_permission',params:{sessionId:'synthetic-session',toolCall:{toolCallId:'synthetic-tool'},options:[{optionId:'allow',name:'Allow',kind:'allow_once'}]}});return;}
   send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'synthetic-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(value)}}}});result={stopReason:behavior==='acp-non-end-turn'?'max_tokens':'end_turn'};done=true;
  }else fail();send({jsonrpc:'2.0',id:m.id,result});
 }catch{fail();}});
 }
}
