import type { AppConfig } from './domain.js';
export interface ReadinessItem {name:string;ready:boolean;detail:string}
export function readiness(config:AppConfig):ReadinessItem[] {
  if(config.mode!=='live')return [{name:'演示工作区',ready:true,detail:'使用独立的示例数据和回放执行器，不会修改远程仓库。'}];
  return [
    {name:'项目与来源',ready:config.projects.length>0,detail:config.projects.length?'已配置项目；来源目录由常驻采集器补扫。':'创建项目并指定 productIdeas 目录与 PRD 路径。'},
    {name:'GitHub 交付',ready:!!config.githubToken&&config.projects.some(p=>p.trustedChecks.length&&p.trustedAppIds.length&&p.autoMerge),detail:'需要仓库令牌、允许路径、可信 CI App 与必需检查；配置完成后仍须真实交付验收。'},
    {name:'隔离 worker',ready:config.runnerPolicies.some(p=>p.admitted)&&Object.keys(config.workers).length>0,detail:'每个角色须在 Lima 内验证模型、授权域、权限与费用，并准入备选运行器。'},
    {name:'飞书连接配置',ready:!!config.feishu?.chatId,detail:'配置应用、本人私聊和历史权限；HTTP 回调另需验证凭据，实际收发仍须联调。'},
    {name:'双语查证',ready:!!config.researchUrl,detail:'配置获准的检索网关；宿主逐条打开中英文原始资料，保留证据缺口。'},
  ];
}
