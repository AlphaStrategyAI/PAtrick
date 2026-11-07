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
export function sourceCoverage(project: { sourceDir?: string } | undefined, feishuConfigured: boolean, connected: boolean | { githubBranch?: boolean; xBookmarks?: boolean; gmail?: boolean } = {}): SourceCoverageItem[] {
  const flags = typeof connected === 'boolean' ? { githubBranch: connected } : connected;
  const uncovered = '没有获准的自动入口。日常不增加转发、贴标签或导出。';
  return [
    { name: '手动输入', detail: '直接加入获准的原始资料', state: project ? 'ready' : 'unset' },
    { name: '本地同步目录', detail: project?.sourceDir ? '按配置路径监听与补扫' : '在项目配置中设置 sourceDir', state: project?.sourceDir ? 'ready' : 'unset' },
    { name: '飞书', detail: feishuConfigured ? '仍以设置页准入检查为准' : '尚未配置应用与本人身份', state: feishuConfigured ? 'ready' : 'unset' },
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
export function publicError(value?: string): string | undefined {
  if (value === 'baseline_changed') return '仓库基线已变化；将重新规划并验证。';
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
