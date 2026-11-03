import { digest, now, stableId, type AppConfig, type DeliveryWriter, type Project, type ResearchAdapter, type Runner, type WorkerAdapter, type WorkerInput, type WorkerResult } from './domain.js';
import type { Store } from './store.js';
import type { Workbench } from './orchestrator.js';

export function configureDemo(config:AppConfig):void {
  if(config.mode!=='demo'&&config.mode!=='test')throw Error('Demo fixtures cannot be used in live mode.');
  const project:Project={id:'demo-studio',projectId:'demo-studio',domain:'personal',name:'拾光笔记',description:'让想法有出处，让决定有下文。',repository:'AlphaStrategyAI/PAtrick',repositoryProvider:'github',prdPath:'docs/product/PRD.md',allowedPaths:['docs/product/PRD.md'],trustedChecks:['validate'],trustedAppIds:[15368],ownerId:config.ownerId,autoMerge:true,budgetUsd:5,createdAt:now()};
  config.projects=[project];
  config.runnerPolicies=config.runnerPolicies.map(p=>({...p,admitted:true,model:`${p.runner}-demo`,costPerRunUsd:0.005,independentReview:true}));
}
export class DemoWorker implements WorkerAdapter {
  constructor(public name:Runner) {}
  async run(input:WorkerInput):Promise<WorkerResult> {
    const {task,source,project}=input;const quote=source.content.split('\n').find(line=>line.trim()&&!line.startsWith('['))??source.content;
    const citation={sourceId:source.id,revision:source.revision,quote,locator:source.locator};
    const command='node -e "console.log(\'PRD acceptance conditions checked\')"';
    const tests=[{command,passed:true,output:'演示回放：验收条件检查通过（未执行外部模型或 CI）'}];
    let output:unknown;
    if(input.role==='knowledge_extract')output={cards:[{title:source.title,body:`${quote}\n\n当前标记为用户报告，后续以测试和交付回执核实。`,quote,aliases:['草稿','恢复','导出','draft','recovery'],verification:'reported',kind:'fact'}]};
    else if(input.role==='case_extract')output={observations:[{title:'先保留可恢复的工作进展',statement:'在用户已投入时间的流程中，评估中断后的恢复路径。此项为观察，尚不代表本人的通用原则。',quote,conditions:project.name,exceptions:'敏感资料与明确的删除要求需单独判断。'}]};
    else if(input.role==='decide') {
      if(source.externalId.includes('hypothesis'))output={action:'archive',summary:'已收进待验证的产品假设',rationale:'新想法缺少用户证据，先保留原文与验证问题。',citations:[citation],ruleIds:[]};
      else if(source.externalId.includes('question')&&!input.answer) {
        const A={label:'保留到下次成功导出',description:'仅在本产品保留失败草稿，成功导出后清理。',rationale:'给用户一次恢复机会，并以成功导出作为明确的清理节点。',tradeoff:'需要区分导出失败与成功的状态。',evidenceUrls:['https://example.com/patrick-demo/zh']};
        const B={label:'保留七天',description:'为失败草稿设置七天恢复窗口，到期自动清理。',rationale:'适合用户可能隔几天再回来的场景。',tradeoff:'有固定存储期限，也需要提醒与清理逻辑。',evidenceUrls:['https://example.com/patrick-demo/en']};
        output={action:'ask',summary:'两个要求存在冲突，需要确定草稿恢复窗口。',rationale:'资料同时出现“失败即删”和“保留七天”，当前范围相同。',citations:[citation],ruleIds:[],question:{title:'导出失败后，草稿应该保留多久？',context:'我们已核对资料范围与恢复需求。这个选择会影响用户恢复机会与资料留存时间。',A,B}};
      } else output={action:'proceed',summary:input.answer?'按你的决定补充验收条件':'将有出处的草稿恢复条件补入 PRD',rationale:input.answer??'已有同项目原句支持，可直接修订并检查。',citations:[citation],ruleIds:input.rules.filter(r=>r.kind==='principle').map(r=>r.id)};
    } else if(input.role==='plan')output={taskVersion:task.version,sourceRevision:task.sourceRevision,baselineSha:input.baselineSha,summary:'在现有 PRD 中补充草稿恢复验收条件。',paths:[project.prdPath],steps:['保留已有目标与范围','加入有原句支持的验收条件','核对失败与恢复场景'],tests:[command],stopConditions:['来源、允许路径或基线发生变化时重新规划']};
    else if(input.role==='execute')output={taskVersion:task.version,planHash:digest(task.plan!),baselineSha:task.plan!.baselineSha,files:[{path:project.prdPath,content:`# ${project.name} · 产品需求\n\n## 草稿恢复\n\n${quote}\n\n## 验收条件\n\n- 导出失败时，用户已输入的内容仍可恢复。\n- ${input.answer??'重新打开产品后可继续编辑草稿。'}\n- 以当前提交的测试与合并读回作为交付依据。\n\n> PAtrick 演示样例，不会提交到远程仓库。\n`}],tests,summary:'已补充草稿恢复的验收条件和清理节点。'};
    else if(input.role==='check')output={taskVersion:task.version,planHash:digest(task.plan!),artifactHash:digest(task.artifact!),verdict:'pass',summary:'原文、适用范围与验收条件一致。演示回放未产生外部写入。',issues:[],tests};
    else output={summary:'草稿恢复条件已完成演示交付，保留了来源、判断、检查与读回记录。真实仓库写入需切换到 live 并完成连接验收。',observations:['下一步观察用户在导出失败后的草稿找回情况。']};
    return {output,costUsd:0.005,model:`${this.name}-demo`,provider:this.name==='grok'?'xai':this.name==='codex'?'openai':'deepseek'};
  }
}
export const demoWriter:DeliveryWriter={
  baseline:async()=>digest('demo-baseline'),
  readBaseline:async project=>[{path:project.prdPath,content:`# ${project.name}\n\n本地演示 PRD。`}],
  deliver:async(task,project)=>({id:stableId('demo-receipt',task.id,task.version),taskId:task.id,projectId:project.id,domain:project.domain,repository:project.repository,path:project.prdPath,pullRequestUrl:`https://example.com/patrick-demo/pull/${task.version}`,pullRequestNumber:task.version,headSha:digest(task.artifact!),mergeSha:digest(`demo-merge-${task.id}`),contentHash:digest(task.artifact!.files.find(f=>f.path===project.prdPath)!.content),verifiedAt:now(),checks:[{name:'validate',conclusion:'success',headSha:digest(task.artifact!),appId:15368,url:'https://example.com/patrick-demo/checks'}]}),
};
export const demoResearch:ResearchAdapter={research:async question=>({queries:(['zh','en'] as const).map(language=>({language,query:`${question} ${language==='zh'?'草稿恢复 实践':'draft recovery tradeoffs'}`,searchedAt:now(),sources:[{url:`https://example.com/patrick-demo/${language}`,canonicalUrl:`https://example.com/patrick-demo/${language}`,title:language==='zh'?'草稿恢复的样例资料（演示）':'Draft recovery example (demo)',language,publishedAt:'2026-11-03',accessedAt:now(),excerpt:'演示资料：比较草稿恢复机会、保存期限与成功导出后的清理节点。',primary:true,conditions:'仅用于本地演示回放，不作为真实决策证据。'}]})),summary:'演示记录展示中英文查证流程；live 模式会实际检索并打开原文。',gaps:['本页为示例资料，未执行在线查证。']})};
export async function seedDemo(store:Store,config:AppConfig,engine:Workbench):Promise<void> {
  if(store.get('cursors','demo-seeded'))return;
  const project=config.projects[0]!;
  engine.ingest({projectId:project.id,externalId:'demo-delivered',title:'把草稿恢复条件补入产品 PRD',content:'用户报告：导出失败后草稿消失，重新打开也无法继续编辑。评审已经确认，本产品应在失败后保留可恢复的草稿。',kind:'manual',authorId:config.ownerId,locator:'productIdeas/拾光笔记/导出体验.md'});
  engine.ingest({projectId:project.id,externalId:'demo-question',title:'确认导出失败后的草稿保留时间',content:'用户报告：导出失败后需要恢复草稿。当前评审同时要求失败即删和保留七天，适用范围都是拾光笔记，请确认清理时机。',kind:'manual',authorId:config.ownerId,locator:'productIdeas/拾光笔记/草稿保留.md'});
  engine.ingest({projectId:project.id,externalId:'demo-hypothesis',title:'为第一次使用设计一个轻量引导',content:'想法：在用户第一次打开时提供一个可跳过的引导。尚未取得用户访谈或行为证据，先作为待验证假设。',kind:'manual',authorId:config.ownerId,locator:'productIdeas/拾光笔记/首次体验.md'});
  await engine.runUntilIdle(100);
  const scheduled=engine.ingest({projectId:project.id,externalId:'demo-scheduled',title:'整理下一轮用户反馈',content:'收集本周导出体验的反馈，在下一轮访谈完成后补充证据与反例。此项是已接收、尚待排程的演示任务。',kind:'manual',authorId:config.ownerId,locator:'productIdeas/拾光笔记/下一轮反馈.md'});
  if(scheduled)store.save('tasks',{...scheduled,runAfter:new Date(Date.now()+86400000).toISOString()});
  store.save('cursors',{id:'demo-seeded',projectId:project.id,domain:project.domain,value:'1',updatedAt:now()});
}
