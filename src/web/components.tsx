import type { Child } from 'hono/jsx';
import type { AppConfig, Project, Task, TaskStatus } from '../domain.js';

export type IconName = 'grid' | 'book' | 'standards' | 'source' | 'activity' | 'settings' | 'search' | 'plus' | 'chevron' | 'arrow' | 'arrowUp' | 'close' | 'check' | 'clock' | 'file' | 'link' | 'more' | 'menu' | 'spark' | 'shield' | 'refresh' | 'pause' | 'external' | 'command' | 'layers' | 'alert' | 'logout';
const paths: Record<IconName, Child> = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  book: <><path d="M12 5.5C8 3 4 3.5 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-.5-9 1.5Z"/><path d="M12 5.5V20"/></>,
  standards: <><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></>,
  source: <><path d="M9 6H4a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-5"/><rect x="8" y="3" width="8" height="6" rx="1.5"/><path d="M7 13h10M7 17h6"/></>,
  activity: <><path d="M3 12h4l3-8 4 16 3-8h4"/></>,
  settings: <><path d="m9 3-.7 2.2-2 .9L4 5.7 2 9l1.6 1.8v2.4L2 15l2 3.3 2.3-.4 2 .9L9 21h4l.7-2.2 2-.9 2.3.4 2-3.3-1.6-1.8v-2.4L20 9l-2-3.3-2.3.4-2-.9L13 3H9Z"/><circle cx="11" cy="12" r="3"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  plus: <path d="M12 5v14M5 12h14"/>, chevron: <path d="m8 10 4 4 4-4"/>,
  arrow: <><path d="M4 12h16m-6-6 6 6-6 6"/></>, arrowUp: <><path d="M7 17 17 7M7 7h10v10"/></>,
  close: <path d="m6 6 12 12M6 18 18 6"/>, check: <path d="m5 12 4 4L19 6"/>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  file: <><path d="M14 3H5v18h14V8l-5-5Z"/><path d="M14 3v5h5M8 12h8M8 16h5"/></>,
  link: <><path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 1)"/></>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
  spark: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/><path d="m20 2 .5 1.5L22 4l-1.5.5L20 6l-.5-1.5L18 4l1.5-.5L20 2Z"/></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 2M5 16a8 8 0 0 0 13 2"/></>,
  pause: <><path d="M8 5v14M16 5v14"/></>,
  external: <><path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/></>,
  command: <><path d="M9 9V5a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v14a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2V9Z"/></>,
  layers: <><path d="m12 3 10 6-10 6L2 9l10-6ZM2 15l10 6 10-6"/></>,
  alert: <><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3v.1"/></>,
  logout: <><path d="M9 3H3v18h6M13 7l5 5-5 5m-6-5h11"/></>,
};
export function Icon({ name, class: className = '' }: { name: IconName; class?: string }) {
  return <svg class={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
export function Monogram() {
  return <svg class="monogram" viewBox="0 0 36 36" fill="none" aria-hidden="true"><rect width="36" height="36" rx="10" fill="currentColor"/><path d="M11 26V10h8.1c4.6 0 6.9 2.2 6.9 5.7S23.7 22 19.1 22H15" stroke="#FAF9F5" stroke-width="2.2" stroke-linecap="round"/><path d="M16 15h3.2c1.4 0 2.2.5 2.2 1.6 0 1.2-.9 1.9-2.4 1.9h-3" stroke="#FAF9F5" stroke-width="2" stroke-linecap="round"/></svg>;
}
export const statuses: Record<TaskStatus, string> = { queued: '等待处理', extracting: '整理证据', deciding: '形成判断', researching: '查证资料', awaiting_answer: '等你决定', planning: '制定方案', executing: '执行中', checking: '独立检查', publishing: '验证交付', feedback: '整理反馈', delivered: '已交付', completed: '已整理', archived: '已归档', blocked: '暂时阻塞', retrying: '等待重试', cancelled: '已取消' };
export const roleLabels: Record<string, string> = { knowledge_extract: '知识整理', case_extract: '标准提取', decide: '初判', plan: '规划', execute: '执行', check: '检查', feedback: '反馈', research: '双语查证', delivery: '交付验证' };
export const sourceLabels: Record<string, string> = { file: '同步文件', feishu: '飞书', github: 'GitHub', gitlab: 'GitLab', conversation: '对话', manual: '手动输入', reading: '阅读', email: '邮箱' };
export const terminalStatuses = new Set<TaskStatus>(['delivered', 'completed', 'archived', 'cancelled']);
export function relative(value: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  if (!Number.isFinite(elapsed)) return '时间未知';
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)} 天前`;
  return date(value);
}
export function date(value: string, full = false): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', ...(full ? { year: 'numeric', hour: '2-digit', minute: '2-digit' } : {}) }).format(parsed);
}
export function money(amount: number): string { return `$${amount.toFixed(amount < 1 && amount > 0 ? 3 : 2)}`; }
export function shortHash(hash: string): string { return hash.length > 16 ? hash.slice(0, 12) : hash; }
export function safeHref(url: string): string | undefined {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  return undefined;
}
export function ExternalLink({ href, children, class: className = '' }: { href: string; children: Child; class?: string }) {
  return safeHref(href) ? <a href={safeHref(href)} class={`text-link ${className}`} target="_blank" rel="noopener noreferrer">{children}<Icon name="external"/></a> : <span class={className}>{children}</span>;
}
export function Badge({ children, tone = 'neutral' }: { children: Child; tone?: string }) {
  return <span class={`badge badge-${tone}`}>{children}</span>;
}
export function Status({ task }: { task: Task }) {
  const tone = task.status === 'delivered' ? 'green' : task.status === 'awaiting_answer' || task.status === 'blocked' ? 'amber' : 'neutral';
  return <span class={`status status-${tone}`}><span class="status-dot"/>{statuses[task.status]}</span>;
}
export function Empty({ icon = 'layers', title, body, children }: { icon?: IconName; title: string; body: string; children?: Child }) {
  return <div class="empty-state"><div class="empty-icon"><Icon name={icon}/></div><h3>{title}</h3><p>{body}</p>{children}</div>;
}
export function PageHead({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: Child }) {
  return <header class="page-heading"><div><p class="eyebrow">{eyebrow}</p><h1>{title}<span class="heading-period" aria-hidden="true">.</span></h1><p class="page-description">{description}</p></div>{children && <div class="page-heading-actions">{children}</div>}</header>;
}
export function ProjectForm({ config, compact = false }: { config: AppConfig; compact?: boolean }) {
  return <form method="post" action="/api/projects" data-api-form class="stack-form project-form">
    <div class="form-error" role="alert" hidden/>
    <div class="form-grid">
      <label>项目名称<input name="name" required maxlength={100} placeholder="例如：我的产品"/></label>
      <label>数据域<input name="domain" required value="personal" placeholder="personal"/><span class="field-hint">限定可引用资料和运行器的范围。</span></label>
    </div>
    <label>项目说明<textarea name="description" rows={2} maxlength={2000} placeholder="这个项目正在解决什么问题？"/></label>
    <label>仓库服务<select name="repositoryProvider"><option value="github">GitHub</option><option value="gitlab">GitLab</option></select></label>
    <label>执行首选<select name="executionRunner"><option value="grok">Grok Build</option><option value="dsh">DeepSeek Harness</option></select><span class="field-hint">不可用时切换到同一数据域内已准入的备选。检查优先使用与实际执行不同的运行器。</span></label>
    <label>目标仓库<input name="repository" required placeholder="owner/repository"/><span class="field-hint">GitHub 填写 owner/repo；GitLab 可填写带子组的项目路径。</span></label>
    <div class="form-grid">
      <label>PRD 路径<input name="prdPath" required value="docs/PRD.md"/></label>
      <label>单任务预算（USD）<input name="budgetUsd" type="number" min="0" max="10000" step="0.01" required value="0"/><span class="field-hint">0 将阻止需要费用预留的运行器；订阅权限仍需单独核验。</span></label>
    </div>
    <label>结果复核间隔（天）<input name="reviewIntervalDays" type="number" min="1" max="365" step="1" value="7" required/><span class="field-hint">默认 7 天，可设为 1–365 天。每次初判保存当时的间隔；之后调整不改写历史安排。</span></label>
    <label>允许修改的路径<textarea name="allowedPaths" rows={2} required placeholder="docs/PRD.md"/><span class="field-hint">每行一个路径；目录以 / 结尾。</span></label>
    <label>可信必需检查<textarea name="trustedChecks" rows={2} placeholder="例如：validate-prd"/><span class="field-hint">只接受当前提交中通过的检查。每行一个检查名称；启用自动合并时必填。</span></label>
    <label>可信 CI 身份 ID<textarea name="trustedAppIds" rows={2} inputmode="numeric" placeholder="例如：15368, 24680"/><span class="field-hint">GitHub 使用可信 CI App ID；GitLab 使用可信流水线服务用户 ID。填写正整数，以逗号或换行分隔；启用自动合并时必填。</span></label>
    <label>同步目录（可选）<input name="sourceDir" placeholder="例如：/Users/me/productIdeas"/><span class="field-hint">填写本机获准采集的绝对路径；留空时可先手动加入资料。</span></label>
    <label class="checkbox-label"><input name="autoMerge" type="checkbox" value="on"/><span>允许在全部门禁通过后自动合并</span></label>
    <p class="form-note"><Icon name="shield"/>连接凭据通过服务配置和环境变量管理。{config.mode === 'demo' ? '此处仅修改演示项目。' : '项目创建后仍需核对配置，并完成真实链路验证。'}</p>
    <button type="submit" class="button button-primary">{compact ? '创建第一个项目' : '创建项目'}<Icon name="arrow"/></button>
  </form>;
}
export function SourceMeta({ project, source, revision }: { project?: Project; source: string; revision?: string }) {
  return <span class="source-meta"><Icon name="file"/>{project?.name ?? source}{revision && <span class="mono">@{shortHash(revision)}</span>}</span>;
}
