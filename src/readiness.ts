import type { AppConfig, Attempt, AuditEvent, Runner, RunnerPolicy, Task } from './domain.js';
import { setupSteps } from './setup-guide.js';
import type { BillingStatus } from './billing.js';
const exactPolicies = Symbol('current-policy-statuses');
export type BillingStatuses = Record<string, Partial<Record<Runner, BillingStatus>>> & {
  [exactPolicies]?: Map<string, Map<RunnerPolicy, BillingStatus>>;
};
/** Per-request exact policy bindings stay internal; JSON contains only safe summaries. */
export function recordPolicyStatus(statuses: BillingStatuses, projectId: string, policy: RunnerPolicy, status: BillingStatus): void {
  if (!statuses[exactPolicies]) Object.defineProperty(statuses, exactPolicies, { value: new Map<string, Map<RunnerPolicy, BillingStatus>>() });
  const projects = statuses[exactPolicies]!;
  if (!projects.has(projectId)) projects.set(projectId, new Map());
  projects.get(projectId)!.set(policy, status);
  const summary = statuses[projectId] ??= {};
  summary[policy.runner] ??= status;
}
export function policyBillingStatus(statuses: BillingStatuses | undefined, projectId: string, policy: RunnerPolicy): BillingStatus | undefined {
  return statuses?.[exactPolicies]?.get(projectId)?.get(policy);
}
export type TaskBillingStatus = BillingStatus & { attempts: number; additionalSpendingCapUsd: number };

export interface ReadinessItem {name:string;ready:boolean;detail:string}
export type SourceCoverageState = 'ready' | 'unset' | 'uncovered' | 'unconnected';
export interface SourceCoverageItem { name: string; detail: string; state: SourceCoverageState }
/** Channels without an authorized automatic entry stay uncovered. Daily work does not add forward, tag, or export actions. */
export function sourceCoverage(project: { sourceDir?: string } | undefined, feishuConfigured: boolean, connected: boolean | { githubBranch?: boolean; xBookmarks?: boolean; gmail?: boolean; feishu?: boolean } = {}): SourceCoverageItem[] {
  const flags = typeof connected === 'boolean' ? { githubBranch: connected } : connected;
  const uncovered = '没有获准的自动入口。日常不增加转发、贴标签或导出。';
  const feishuState = !feishuConfigured ? 'unset' : flags.feishu ? 'ready' : 'unconnected';
  return [
    { name: '手动输入', detail: '直接加入获准的原始资料', state: project ? 'ready' : 'unset' },
    { name: '本地同步目录', detail: project?.sourceDir ? '按配置路径监听与补扫' : '在项目配置中设置 sourceDir', state: project?.sourceDir ? 'ready' : 'unset' },
    { name: '飞书', detail: feishuState === 'ready' ? '已完成一次历史补读。之后的消息按同一条来源修订入账。' : feishuState === 'unconnected' ? '已保存飞书应用和本人身份。还没有一次成功的历史补读，所以还没有接入，不能算已覆盖。' : '尚未配置应用与本人身份', state: feishuState },
    { name: '公众号', detail: uncovered, state: 'uncovered' },
    { name: '个人微信', detail: uncovered, state: 'uncovered' },
    { name: '第三方 Grok', detail: uncovered, state: 'uncovered' },
    { name: 'GitHub 远端分支', detail: flags.githubBranch ? '默认分支已有一次成功扫描。之后只导入授权路径上的新提交，并跳过本程序自己的交付。' : '实时模式会在保存 GitHub 令牌后扫描默认分支。还没有一次成功扫描，所以还没有接入，不能算已覆盖。', state: flags.githubBranch ? 'ready' : 'unconnected' },
    { name: 'X 书签', detail: flags.xBookmarks ? '已读到最新一页书签。解释、关联、反例和到期复核仍要逐条核验后才算完成。' : '在设置页保存 X 书签令牌后，实时模式读取最新一页。还没有一次成功扫描，所以还没有接入，不能算已覆盖。', state: flags.xBookmarks ? 'ready' : 'unconnected' },
    { name: '邮箱', detail: flags.gmail ? '已记下 Gmail 历史位置。之后只导入新邮件，更早的邮件不会被补进来。' : '在设置页保存 Gmail 增量令牌后，实时模式先记下历史位置。还没有一次成功扫描，所以还没有接入，不能算已覆盖。', state: flags.gmail ? 'ready' : 'unconnected' },
    { name: 'Grok Bot', detail: '设计里可以采集获准对话，这一版还没有接入，所以不能算已覆盖。', state: 'unconnected' },
  ];
}
export function readiness(config:AppConfig,billing:BillingStatuses={}):ReadinessItem[] {
  if(config.mode!=='live')return [{name:'演示工作区',ready:true,detail:'使用独立的示例数据和回放执行器，不会修改远程仓库。'}];
  return [
    {name:'项目与来源',ready:config.projects.length>0,detail:config.projects.length?'已配置项目；来源目录由常驻采集器补扫。':'创建项目并指定 productIdeas 目录与 PRD 路径。'},
    {name:'GitHub 交付',ready:!!config.githubToken&&config.projects.some(p=>p.trustedChecks.length&&p.trustedAppIds.length&&p.autoMerge),detail:'需要仓库令牌、允许路径、可信 CI App 与必需检查；配置完成后仍须真实交付验收。'},
    {name:'隔离 worker',ready:config.projects.some(project=>config.runnerPolicies.some(policy=>policy.admitted&&policy.domains.includes(project.domain)&&!!config.workers[policy.runner]&&['included-admitted','positive-reservation'].includes(policyBillingStatus(billing,project.id,policy)?.state??''))),detail:'每个角色须在 Lima 内验证模型、授权域、权限与费用，并准入备选运行器。'},
    {name:'飞书连接配置',ready:!!config.feishu?.chatId,detail:'配置应用、本人私聊和历史权限；HTTP 回调另需验证凭据，实际收发仍须联调。'},
    {name:'双语查证',ready:!!config.researchUrl,detail:'配置获准的检索网关；宿主逐条打开中英文原始资料，保留证据缺口。'},
    ...setupSteps(config).filter(step => ['isolation', 'backup', 'network'].includes(step.id)).map(step => ({ name: step.title, ready: step.done, detail: step.detail })),
  ];
}

/** Public presentation contains accounting scalars and fixed host reasons only. */
export function taskBillingStatus(task: Task, config: AppConfig, billing: BillingStatuses = {}): TaskBillingStatus {
  const limit = Math.min(task.attemptLimit ?? config.maxAttemptsPerTask ?? 32, config.maxAttemptsPerTask ?? 32);
  const relevant = config.runnerPolicies.filter(p => p.admitted && p.domains.includes(task.domain) && p.roles.some(role => role === task.stage) && config.runnerPolicies.find(first => first.admitted && first.runner === p.runner && first.domains.includes(task.domain) && first.roles.some(role => role === task.stage)) === p && ((p.billing?.mode === 'included-subscription') === ((task.billingBoundary ?? config.billingBoundary ?? 'metered-only') === 'included-only'))).map(p => policyBillingStatus(billing, task.projectId, p)).filter((s): s is BillingStatus => !!s);
  const status: BillingStatus = task.billingStop ? { state: 'blocked', reason: task.billingStop.code, attemptsLimit: limit }
    : task.attempts >= limit ? { state: 'blocked', reason: 'subscription_attempt_limit', attemptsLimit: limit }
    : relevant.find(s => s.state === 'included-admitted' || s.state === 'positive-reservation') ?? relevant[0] ?? { state: 'pending-proof', reason: 'subscription_unverified', attemptsLimit: limit };
  return { ...status, attemptsLimit: limit, attempts: task.attempts, additionalSpendingCapUsd: task.budgetUsd };
}
export function billingMessage(status?: BillingStatus & { attempts?: number }): string {
  if (status?.reason === 'billing_policy_violation') return '已暂停：发现订阅费用边界异常，保留任务与账本，等待本人核查。';
  if (status?.reason === 'subscription_attempt_limit') return `已达到任务总尝试上限（已用 ${status.attempts ?? 0} / 上限 ${status.attemptsLimit}）；重试不会重置。`;
  if (status?.reason === 'subscription_profile_unavailable') return '订阅额度或认证暂不可用；等待新的宿主核验。';
  if (status?.state === 'included-admitted') return '已核验订阅内额度；额外计费路径禁用，调度前仍需复核。';
  if (status?.state === 'positive-reservation' || status?.reason === 'budget_exceeded') return '需正数保守费用预留；0 美元上限将阻止调用。';
  return '订阅费用边界待核验；0 美元不会自动准入。';
}
const publicErrorCodes = new Set(['billing_policy_violation', 'subscription_attempt_limit', 'subscription_unverified', 'subscription_expired', 'subscription_scope', 'subscription_profile_unavailable', 'billing_policy_invalid', 'billing_route_forbidden', 'billing_boundary_mismatch', 'worker_unavailable', 'worker_failed', 'worker_aborted', 'invalid_cost', 'invalid_worker_output', 'provider_not_admitted', 'stale_attempt', 'attempt_abandoned_after_host_restart']);
const ownerStopMessages: Record<string, string> = {
  baseline_changed: '仓库基线已变化；将重新规划并验证。',
  workers_unavailable: '当前没有可接这个角色的运行器。任务已保留，到点会再探测。这不需要你回答。',
  repairs_exhausted: '已返修两轮，检查仍未通过。没有发布未经验证的改动。任务已保留。',
  invalid_plan: '执行方案未通过校验。任务已保留，没有开始改动文件。',
  invalid_artifact: '执行结果未通过校验。没有发布未经验证的改动。',
  invalid_review: '检查结果未通过校验。没有发布未经验证的改动。',
  invalid_receipt: '交付回执与合并后的文件不一致。这次没有记成已交付。',
  nonindependent_review: '检查和执行用了同一个未获准独立复核的运行器。没有发布。',
  missing_test_evidence: '方案要求的检查没有完整记录。没有发布。',
  insufficient_research: '中英文查证还不足以提出两个可行建议。任务已保留。',
  invalid_recommendations: '决策卡不完整。任务已保留，还没有提问。',
  baseline_unavailable: '读不到仓库基线。任务已保留，没有改动文件。',
  pending_ci: '必需检查还没完成。到点会再查。这不需要你回答。',
  remote_unavailable: '仓库暂时连不上。到点会再试。这不需要你回答。',
  technical_failure: '运行暂时不可用；任务与账本已保留。',
  feedback_retry: '反馈没有完成。交付还不能算完成，到点会再试。这不需要你回答。',
  owner_changed: '你明确改了主意。旧决定从这条消息起不再自动引用。未完成的任务会重新判断。这不需要你回答。',
  rules_conflict: '这两条决定互相冲突，两侧都保留，但都暂停自动引用。未完成的任务会重新判断。这不需要你回答。',
  rule_expired: '这条规则已到复核期，暂停自动引用。原文仍保留。未完成的任务会重新判断。这不需要你回答。',
  ephemeral_expired: '临时资料已过期。任务已保留，没有继续使用它。',
  stale_attempt: '这次尝试已经过期。任务已保留，会按当前版本继续。',
  invalid_test_observation: '检查记录对不上这次执行。没有把它当成通过。',
};
export function publicError(value?: string): string | undefined {
  if (value && ownerStopMessages[value]) return ownerStopMessages[value];
  return value === undefined ? undefined : publicErrorCodes.has(value) ? value : '运行暂时不可用；任务与账本已保留。';
}
export function publicTask(task: Task): Task {
  return { ...task, error: publicError(task.error), ...(task.billingStop ? { billingStop: { code: task.billingStop.code, at: task.billingStop.at } } : {}) };
}
export type PublicAttempt = Omit<Attempt, 'billing'> & { configurationSource?: 'host-validated' | 'configured' | 'unverified' };
export function publicAttempt(attempt: Attempt): PublicAttempt {
  const { billing, ...safe } = attempt;
  // Host authority writes this tuple at reservation and validates result equality
  // before success. A later policy revision does not rewrite historical provenance.
  // This is a trusted host-ledger boundary, not protection against root DB rewrites.
  const hostReserved = billing && Number.isSafeInteger(billing.ordinal) && billing.ordinal >= 1
    && Number.isSafeInteger(billing.attemptLimit) && billing.ordinal <= billing.attemptLimit && billing.attemptLimit <= 256
    && Number.isFinite(billing.reserveUsd) && billing.reserveUsd >= 0
    && typeof billing.policyHash === 'string' && /^[a-f0-9]{64}$/.test(billing.policyHash)
    && typeof billing.authorityEpoch === 'string' && /^[a-f0-9-]{36}$/.test(billing.authorityEpoch)
    && ['reserved', 'dispatched', 'adapter-entered'].includes(billing.dispatchState)
    && (billing.mode === 'included-subscription' && billing.billingBoundary === 'included-only' || billing.mode === 'metered-api' && billing.billingBoundary === 'metered-only');
  return { ...safe, error: publicError(attempt.error), provider: hostReserved ? attempt.provider : '[unverified]', model: hostReserved ? attempt.model : '[unverified]', configurationSource: hostReserved ? attempt.status === 'succeeded' ? 'host-validated' : 'configured' : 'unverified' };
}
export function publicEvent(event: AuditEvent): AuditEvent {
  if (event.type === 'baseline.changed') return { ...event, message: publicError('baseline_changed')!, data: {} };
  if (publicErrorCodes.has(event.type) || event.type === 'technical_failure' || event.data && 'stage' in event.data && 'runAfter' in event.data) return { ...event, type: publicErrorCodes.has(event.type) ? event.type : 'technical_failure', message: publicError(event.type)!, data: {} };
  return event;
}
