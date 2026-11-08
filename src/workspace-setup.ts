import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DomainError, now, stableId, type AppConfig, type Project } from './domain.js';
import { projectSchema } from './config.js';
import { saveConnectionSecrets } from './setup-guide.js';

export const DEFAULT_PRD_PATH = 'docs/requirements/PRD.md';
export const DEFAULT_ALLOWED_PATHS = ['docs/requirements/', 'docs/designs/'] as const;

const repoName = z.string().trim().regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/);
const rootName = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,98}$/);
const optionalRepo = z.union([repoName, z.literal('')]).optional();
const optionalRoot = z.union([rootName, z.literal('')]).optional();

export const workspaceSetupSchema = z.object({
  ideasGithub: z.string().default(''),
  ideasGitlab: z.string().default(''),
  githubRoot: z.string().default(''),
  gitlabRoot: z.string().default(''),
  feishuOwnerName: z.string().default(''),
  completed: z.boolean().default(false),
  completedAt: z.string().optional(),
  createdProjectIds: z.array(z.string()).default([]),
}).strict();
export type WorkspaceSetup = z.infer<typeof workspaceSetupSchema>;

export type RepositoryProbe = {
  provider: 'github' | 'gitlab';
  repository: string;
  ok: boolean;
  detail: string;
  name?: string;
  private?: boolean;
  defaultBranch?: string;
};

export type RootScanResult = {
  provider: 'github' | 'gitlab';
  root: string;
  repositories: { repository: string; name: string; description: string; private: boolean }[];
  detail: string;
};

export type FeishuVerifyResult = {
  ok: boolean;
  tokenOk: boolean;
  sendOk: boolean;
  receiveOk: boolean;
  chatId?: string;
  detail: string;
};

export function setupPath(config: Pick<AppConfig, 'dataDir'>): string {
  return join(config.dataDir, 'workspace-setup.json');
}

export function loadWorkspaceSetup(config: Pick<AppConfig, 'dataDir'>): WorkspaceSetup {
  const path = setupPath(config);
  if (!existsSync(path)) return workspaceSetupSchema.parse({});
  try { return workspaceSetupSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { return workspaceSetupSchema.parse({}); }
}

export function saveWorkspaceSetup(config: Pick<AppConfig, 'dataDir'>, input: Partial<WorkspaceSetup>): WorkspaceSetup {
  const next = workspaceSetupSchema.parse({ ...loadWorkspaceSetup(config), ...input });
  mkdirSync(config.dataDir, { recursive: true });
  const path = setupPath(config);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
  return next;
}

export function onboardingNeeded(config: AppConfig, projectCount: number): boolean {
  if (config.mode !== 'live') return false;
  const setup = loadWorkspaceSetup(config);
  if (setup.completed) return false;
  // Existing workspaces already have projects and never went through the wizard.
  if (projectCount > 0 && !setup.githubRoot && !setup.ideasGithub) return false;
  return true;
}

export function defaultDeliveryPaths(): { prdPath: string; allowedPaths: string[] } {
  return { prdPath: DEFAULT_PRD_PATH, allowedPaths: [...DEFAULT_ALLOWED_PATHS] };
}

export function projectFromRemote(input: {
  name: string;
  repository: string;
  repositoryProvider: 'github' | 'gitlab';
  ownerId: string;
  description?: string;
}): Project {
  const id = stableId('project', input.repository).slice(0, 12);
  const paths = defaultDeliveryPaths();
  return projectSchema.parse({
    id, projectId: id, domain: 'personal', name: input.name.slice(0, 100),
    description: (input.description ?? '').slice(0, 2000),
    repository: input.repository, repositoryProvider: input.repositoryProvider,
    prdPath: paths.prdPath, allowedPaths: paths.allowedPaths,
    trustedChecks: [], trustedAppIds: [], ownerId: input.ownerId,
    autoMerge: false, budgetUsd: 0, executionRunner: 'grok', reviewIntervalDays: 7, createdAt: now(),
  });
}

async function githubJson(token: string | undefined, path: string, fetcher: typeof fetch, apiUrl = 'https://api.github.com'): Promise<{ ok: boolean; status: number; data: unknown }> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'PAtrick-setup' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetcher(`${apiUrl}${path}`, { headers, signal: AbortSignal.timeout(15000) });
  let data: unknown = undefined;
  try { data = await response.json(); } catch { data = undefined; }
  return { ok: response.ok, status: response.status, data };
}

async function gitlabJson(token: string | undefined, path: string, fetcher: typeof fetch, apiUrl: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers['PRIVATE-TOKEN'] = token;
  const response = await fetcher(`${apiUrl.replace(/\/$/, '')}${path}`, { headers, signal: AbortSignal.timeout(15000) });
  let data: unknown = undefined;
  try { data = await response.json(); } catch { data = undefined; }
  return { ok: response.ok, status: response.status, data };
}

export async function probeRepository(input: {
  provider: 'github' | 'gitlab';
  repository: string;
  token?: string;
  gitlabUrl?: string;
}, fetcher: typeof fetch = fetch): Promise<RepositoryProbe> {
  const repository = repoName.parse(input.repository);
  if (input.provider === 'github') {
    if (repository.split('/').length !== 2) throw new DomainError('GitHub 仓库须为 owner/repo。', 'invalid_repository', 400);
    const result = await githubJson(input.token, `/repos/${repository}`, fetcher);
    if (!result.ok) {
      const detail = result.status === 404 ? '找不到该仓库，或当前令牌无权访问。' : result.status === 401 ? 'GitHub 令牌无效。' : `GitHub 返回 HTTP ${result.status}。`;
      return { provider: 'github', repository, ok: false, detail };
    }
    const data = result.data as { full_name?: string; name?: string; private?: boolean; default_branch?: string };
    return { provider: 'github', repository: data.full_name ?? repository, ok: true, detail: data.private ? '已确认可访问（私有仓库）。' : '已确认可访问（公开仓库）。', name: data.name, private: data.private, defaultBranch: data.default_branch };
  }
  const encoded = encodeURIComponent(repository);
  const result = await gitlabJson(input.token, `/api/v4/projects/${encoded}`, fetcher, input.gitlabUrl ?? 'https://gitlab.com');
  if (!result.ok) {
    const detail = result.status === 404 ? '找不到该项目，或当前令牌无权访问。' : result.status === 401 ? 'GitLab 令牌无效。' : `GitLab 返回 HTTP ${result.status}。`;
    return { provider: 'gitlab', repository, ok: false, detail };
  }
  const data = result.data as { path_with_namespace?: string; name?: string; visibility?: string; default_branch?: string };
  return { provider: 'gitlab', repository: data.path_with_namespace ?? repository, ok: true, detail: data.visibility === 'private' ? '已确认可访问（私有项目）。' : '已确认可访问。', name: data.name, private: data.visibility === 'private', defaultBranch: data.default_branch };
}

export async function scanRootRepositories(input: {
  provider: 'github' | 'gitlab';
  root: string;
  token?: string;
  gitlabUrl?: string;
  exclude?: string[];
}, fetcher: typeof fetch = fetch): Promise<RootScanResult> {
  const root = rootName.parse(input.root);
  const exclude = new Set((input.exclude ?? []).map(item => item.toLowerCase()));
  if (input.provider === 'github') {
    if (!input.token) throw new DomainError('扫描 GitHub 根目录需要令牌。', 'github_token_required', 400);
    let path = `/orgs/${encodeURIComponent(root)}/repos?per_page=100&type=all&sort=full_name`;
    let result = await githubJson(input.token, path, fetcher);
    if (result.status === 404) {
      path = `/users/${encodeURIComponent(root)}/repos?per_page=100&type=owner&sort=full_name`;
      result = await githubJson(input.token, path, fetcher);
    }
    if (!result.ok) throw new DomainError(result.status === 401 ? 'GitHub 令牌无效。' : `无法读取 GitHub 根目录（HTTP ${result.status}）。`, 'root_unavailable', result.status === 401 ? 401 : 400);
    const rows = Array.isArray(result.data) ? result.data as { full_name?: string; name?: string; description?: string | null; private?: boolean; archived?: boolean; fork?: boolean }[] : [];
    const repositories = rows
      .filter(row => row.full_name && !row.archived && !exclude.has(row.full_name.toLowerCase()))
      .map(row => ({ repository: row.full_name!, name: row.name ?? row.full_name!.split('/')[1]!, description: row.description ?? '', private: !!row.private }));
    return { provider: 'github', root, repositories, detail: `在 ${root} 下发现 ${repositories.length} 个可导入仓库。` };
  }
  if (!input.token) throw new DomainError('扫描 GitLab 根目录需要令牌。', 'gitlab_token_required', 400);
  const api = input.gitlabUrl ?? 'https://gitlab.com';
  const group = await gitlabJson(input.token, `/api/v4/groups/${encodeURIComponent(root)}/projects?per_page=100&include_subgroups=false`, fetcher, api);
  let rows: { path_with_namespace?: string; name?: string; description?: string | null; visibility?: string; archived?: boolean }[] = [];
  if (group.ok && Array.isArray(group.data)) rows = group.data as typeof rows;
  else {
    const user = await gitlabJson(input.token, `/api/v4/users?username=${encodeURIComponent(root)}`, fetcher, api);
    const id = Array.isArray(user.data) ? (user.data[0] as { id?: number } | undefined)?.id : undefined;
    if (!id) throw new DomainError('找不到该 GitLab 组或用户。', 'root_unavailable', 400);
    const projects = await gitlabJson(input.token, `/api/v4/users/${id}/projects?per_page=100`, fetcher, api);
    if (!projects.ok || !Array.isArray(projects.data)) throw new DomainError(`无法读取 GitLab 根目录（HTTP ${projects.status}）。`, 'root_unavailable', 400);
    rows = projects.data as typeof rows;
  }
  const repositories = rows
    .filter(row => row.path_with_namespace && !row.archived && !exclude.has(row.path_with_namespace.toLowerCase()))
    .map(row => ({ repository: row.path_with_namespace!, name: row.name ?? row.path_with_namespace!.split('/').at(-1)!, description: row.description ?? '', private: row.visibility === 'private' }));
  return { provider: 'gitlab', root, repositories, detail: `在 ${root} 下发现 ${repositories.length} 个可导入项目。` };
}

export async function verifyFeishuChannel(input: {
  appId: string;
  appSecret: string;
  ownerOpenId: string;
  ownerName?: string;
  chatId?: string;
}, fetcher: typeof fetch = fetch): Promise<FeishuVerifyResult> {
  const appId = input.appId.trim();
  const appSecret = input.appSecret.trim();
  const ownerOpenId = input.ownerOpenId.trim();
  if (!appId || !appSecret || !ownerOpenId) throw new DomainError('请填写飞书应用 ID、App Secret 和本人 Open ID。', 'feishu_incomplete', 400);
  const tokenResponse = await fetcher('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(15000),
  });
  const tokenBody = await tokenResponse.json().catch(() => ({})) as { code?: number; tenant_access_token?: string; msg?: string };
  if (!tokenResponse.ok || tokenBody.code !== 0 || !tokenBody.tenant_access_token) {
    return { ok: false, tokenOk: false, sendOk: false, receiveOk: false, detail: tokenBody.msg ? `应用鉴权失败：${tokenBody.msg}` : '应用 ID 或 App Secret 无效。' };
  }
  const token = tokenBody.tenant_access_token;
  const marker = `PAtrick setup ${Date.now()}`;
  const sendResponse = await fetcher('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ receive_id: ownerOpenId, msg_type: 'text', content: JSON.stringify({ text: `${marker}${input.ownerName ? ` · ${input.ownerName}` : ''}` }) }),
    signal: AbortSignal.timeout(15000),
  });
  const sendBody = await sendResponse.json().catch(() => ({})) as { code?: number; msg?: string; data?: { message_id?: string; chat_id?: string } };
  if (!sendResponse.ok || sendBody.code !== 0 || !sendBody.data?.message_id) {
    return { ok: false, tokenOk: true, sendOk: false, receiveOk: false, detail: sendBody.msg ? `发送失败：${sendBody.msg}` : '无法向本人 Open ID 发送测试消息。' };
  }
  let chatId = input.chatId?.trim() || sendBody.data.chat_id;
  if (!chatId && sendBody.data.message_id) {
    const message = await fetcher(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(sendBody.data.message_id)}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
    });
    const messageBody = await message.json().catch(() => ({})) as { data?: { items?: { chat_id?: string }[] } };
    chatId = messageBody.data?.items?.[0]?.chat_id;
  }
  if (!chatId) {
    return { ok: false, tokenOk: true, sendOk: true, receiveOk: false, detail: '测试消息已发送，但未能解析私聊 Chat ID；请在设置页补填 Chat ID。', chatId: undefined };
  }
  const history = await fetcher(`https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(chatId)}&page_size=5&sort_type=ByCreateTimeDesc`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
  });
  const historyBody = await history.json().catch(() => ({})) as { code?: number; msg?: string; data?: { items?: unknown[] } };
  if (!history.ok || historyBody.code !== 0 || !Array.isArray(historyBody.data?.items)) {
    return { ok: false, tokenOk: true, sendOk: true, receiveOk: false, chatId, detail: historyBody.msg ? `历史读取失败：${historyBody.msg}` : '发送成功，但读取会话历史失败；请确认应用已开通读消息权限。' };
  }
  return { ok: true, tokenOk: true, sendOk: true, receiveOk: true, chatId, detail: '飞书应用鉴权、发送与历史读取均已通过。' };
}

export async function applyIdeasStep(config: AppConfig, input: {
  ideasGithub?: string;
  ideasGitlab?: string;
  githubToken?: string;
  gitlabToken?: string;
}, fetcher: typeof fetch = fetch): Promise<{ setup: WorkspaceSetup; probes: RepositoryProbe[] }> {
  const ideasGithub = input.ideasGithub?.trim() ?? '';
  const ideasGitlab = input.ideasGitlab?.trim() ?? '';
  if (!ideasGithub) throw new DomainError('请填写想法项目的 GitHub 路径。', 'ideas_required', 400);
  if (input.githubToken?.trim() || input.gitlabToken?.trim()) {
    saveConnectionSecrets(config, {
      githubToken: input.githubToken?.trim() || '',
      gitlabToken: input.gitlabToken?.trim() || '',
    });
  }
  const probes: RepositoryProbe[] = [];
  const github = await probeRepository({ provider: 'github', repository: ideasGithub, token: config.githubToken }, fetcher);
  probes.push(github);
  if (!github.ok) throw new DomainError(github.detail, 'ideas_unavailable', 400);
  if (ideasGitlab) {
    const gitlab = await probeRepository({ provider: 'gitlab', repository: ideasGitlab, token: config.gitlabToken, gitlabUrl: config.gitlabUrl }, fetcher);
    probes.push(gitlab);
    if (!gitlab.ok) throw new DomainError(gitlab.detail, 'ideas_unavailable', 400);
  }
  const setup = saveWorkspaceSetup(config, { ideasGithub: github.repository, ideasGitlab });
  return { setup, probes };
}

export async function applyRootStep(config: AppConfig, store: { get: (table: 'projects', id: string) => Project | undefined; save: (table: 'projects', project: Project) => void; list: (table: 'projects') => Project[] }, input: {
  githubRoot?: string;
  gitlabRoot?: string;
  create?: boolean;
}, fetcher: typeof fetch = fetch): Promise<{ setup: WorkspaceSetup; github?: RootScanResult; gitlab?: RootScanResult; created: Project[] }> {
  const githubRoot = input.githubRoot?.trim() ?? '';
  const gitlabRoot = input.gitlabRoot?.trim() ?? '';
  if (!githubRoot) throw new DomainError('请填写 GitHub 开发根目录。', 'root_required', 400);
  const setupState = loadWorkspaceSetup(config);
  const exclude = [setupState.ideasGithub, setupState.ideasGitlab].filter(Boolean);
  const github = await scanRootRepositories({ provider: 'github', root: githubRoot, token: config.githubToken, exclude }, fetcher);
  let gitlab: RootScanResult | undefined;
  if (gitlabRoot) gitlab = await scanRootRepositories({ provider: 'gitlab', root: gitlabRoot, token: config.gitlabToken, gitlabUrl: config.gitlabUrl, exclude }, fetcher);
  const created: Project[] = [];
  if (input.create !== false) {
    const existing = new Set(store.list('projects').map(project => `${project.repositoryProvider}:${project.repository.toLowerCase()}`));
    for (const item of github.repositories) {
      const key = `github:${item.repository.toLowerCase()}`;
      if (existing.has(key)) continue;
      const project = projectFromRemote({ name: item.name, repository: item.repository, repositoryProvider: 'github', ownerId: config.ownerId, description: item.description });
      if (store.get('projects', project.id)) continue;
      store.save('projects', project);
      if (!config.projects.some(entry => entry.id === project.id)) config.projects.push(project);
      created.push(project);
      existing.add(key);
    }
    for (const item of gitlab?.repositories ?? []) {
      const key = `gitlab:${item.repository.toLowerCase()}`;
      if (existing.has(key)) continue;
      const project = projectFromRemote({ name: item.name, repository: item.repository, repositoryProvider: 'gitlab', ownerId: config.ownerId, description: item.description });
      if (store.get('projects', project.id)) continue;
      store.save('projects', project);
      if (!config.projects.some(entry => entry.id === project.id)) config.projects.push(project);
      created.push(project);
      existing.add(key);
    }
  }
  const setup = saveWorkspaceSetup(config, {
    githubRoot, gitlabRoot,
    createdProjectIds: [...new Set([...(setupState.createdProjectIds ?? []), ...created.map(project => project.id)])],
  });
  return { setup, github, gitlab, created };
}

export async function applyFeishuStep(config: AppConfig, input: {
  appId: string;
  appSecret: string;
  ownerOpenId: string;
  ownerName?: string;
  chatId?: string;
}, fetcher: typeof fetch = fetch): Promise<{ setup: WorkspaceSetup; verify: FeishuVerifyResult }> {
  const verify = await verifyFeishuChannel(input, fetcher);
  if (!verify.ok) throw new DomainError(verify.detail, 'feishu_verify_failed', 400);
  saveConnectionSecrets(config, {
    feishu: {
      appId: input.appId.trim(),
      appSecret: input.appSecret.trim(),
      ownerOpenId: input.ownerOpenId.trim(),
      chatId: verify.chatId ?? input.chatId?.trim() ?? '',
    },
  });
  const setup = saveWorkspaceSetup(config, {
    feishuOwnerName: input.ownerName?.trim() ?? '',
    completed: true,
    completedAt: now(),
  });
  return { setup, verify };
}
