import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { AppConfig, Runner } from './domain.js';

const exec = promisify(execFile);
const secret = z.string().trim().min(8).max(2000);
const optionalSecret = z.union([secret, z.literal('')]).optional();
const idText = z.string().trim().min(1).max(200);
const optionalId = z.union([idText, z.literal('')]).optional();

export const connectionSecretsSchema = z.object({
  githubToken: optionalSecret,
  gitlabToken: optionalSecret,
  xToken: optionalSecret,
  researchUrl: z.union([z.string().trim().url().max(500), z.literal('')]).optional(),
  researchToken: optionalSecret,
  resticRepository: z.union([z.string().trim().min(1).max(500), z.literal('')]).optional(),
  resticPassword: optionalSecret,
  limaInstance: z.union([z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/), z.literal('')]).optional(),
  githubShortcutStatus: optionalId,
  githubShortcutConnect: optionalId,
  githubShortcutDisconnect: optionalId,
  feishu: z.object({
    appId: optionalId,
    appSecret: optionalSecret,
    ownerOpenId: optionalId,
    chatId: optionalId,
    verificationToken: optionalSecret,
    encryptKey: optionalSecret,
  }).strict().optional(),
}).strict();
export type ConnectionSecrets = z.infer<typeof connectionSecretsSchema>;

export const runnerLogins: Record<Runner, { label: string; command: string; args: string[] }> = {
  grok: { label: 'Grok Build', command: 'grok', args: ['auth', 'login'] },
  codex: { label: 'Codex', command: 'codex', args: ['login'] },
  dsh: { label: 'dsh', command: 'dsh', args: ['login'] },
};

export function secretsPath(config: Pick<AppConfig, 'dataDir'>): string {
  return join(config.dataDir, 'connection-secrets.json');
}

export function loadConnectionSecrets(config: AppConfig): void {
  const path = secretsPath(config);
  if (!existsSync(path)) return;
  let parsed: ConnectionSecrets;
  try { parsed = connectionSecretsSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { config.secretsUnreadable = true; return; }
  if (parsed.githubToken) config.githubToken = parsed.githubToken;
  if (parsed.gitlabToken) config.gitlabToken = parsed.gitlabToken;
  if (parsed.xToken) config.xToken = parsed.xToken;
  if (parsed.researchUrl) config.researchUrl = parsed.researchUrl;
  if (parsed.researchToken) config.researchToken = parsed.researchToken;
  applyHostSettings(config, parsed);
  if (parsed.feishu?.appId && parsed.feishu.appSecret && parsed.feishu.ownerOpenId) {
    config.feishu = { appId: parsed.feishu.appId, appSecret: parsed.feishu.appSecret, ownerOpenId: parsed.feishu.ownerOpenId, chatId: parsed.feishu.chatId || undefined, verificationToken: parsed.feishu.verificationToken || undefined, encryptKey: parsed.feishu.encryptKey || undefined };
  }
}

function storedSecrets(config: AppConfig): ConnectionSecrets {
  return {
    ...(config.githubToken ? { githubToken: config.githubToken } : {}),
    ...(config.gitlabToken ? { gitlabToken: config.gitlabToken } : {}),
    ...(config.xToken ? { xToken: config.xToken } : {}),
    ...(config.researchUrl ? { researchUrl: config.researchUrl } : {}),
    ...(config.researchToken ? { researchToken: config.researchToken } : {}),
    ...(config.resticRepository ? { resticRepository: config.resticRepository } : {}),
    ...(config.resticPassword ? { resticPassword: config.resticPassword } : {}),
    ...(config.limaInstance ? { limaInstance: config.limaInstance } : {}),
    ...(config.githubShortcutStatus ? { githubShortcutStatus: config.githubShortcutStatus } : {}),
    ...(config.githubShortcutConnect ? { githubShortcutConnect: config.githubShortcutConnect } : {}),
    ...(config.githubShortcutDisconnect ? { githubShortcutDisconnect: config.githubShortcutDisconnect } : {}),
    ...(config.feishu ? { feishu: { appId: config.feishu.appId, appSecret: config.feishu.appSecret, ownerOpenId: config.feishu.ownerOpenId, chatId: config.feishu.chatId ?? '', verificationToken: config.feishu.verificationToken ?? '', encryptKey: config.feishu.encryptKey ?? '' } } : {}),
  };
}

function keep(next: string | undefined, previous: string | undefined): string | undefined {
  const value = next?.trim();
  return value ? value : previous;
}

/** Empty fields keep the saved secret. The saved file is readable only by this user, and values are never returned to the page. */
export function saveConnectionSecrets(config: AppConfig, input: ConnectionSecrets): void {
  const current = storedSecrets(config);
  const feishu = input.feishu;
  const next: ConnectionSecrets = {
    githubToken: keep(input.githubToken, current.githubToken),
    gitlabToken: keep(input.gitlabToken, current.gitlabToken),
    xToken: keep(input.xToken, current.xToken),
    researchUrl: keep(input.researchUrl, current.researchUrl),
    researchToken: keep(input.researchToken, current.researchToken),
    resticRepository: keep(input.resticRepository, current.resticRepository),
    resticPassword: keep(input.resticPassword, current.resticPassword),
    limaInstance: keep(input.limaInstance, current.limaInstance),
    githubShortcutStatus: keep(input.githubShortcutStatus, current.githubShortcutStatus),
    githubShortcutConnect: keep(input.githubShortcutConnect, current.githubShortcutConnect),
    githubShortcutDisconnect: keep(input.githubShortcutDisconnect, current.githubShortcutDisconnect),
    feishu: {
      appId: keep(feishu?.appId, current.feishu?.appId),
      appSecret: keep(feishu?.appSecret, current.feishu?.appSecret),
      ownerOpenId: keep(feishu?.ownerOpenId, current.feishu?.ownerOpenId),
      chatId: keep(feishu?.chatId, current.feishu?.chatId) ?? '',
      verificationToken: keep(feishu?.verificationToken, current.feishu?.verificationToken) ?? '',
      encryptKey: keep(feishu?.encryptKey, current.feishu?.encryptKey) ?? '',
    },
  };
  const clean = connectionSecretsSchema.parse(next);
  mkdirSync(config.dataDir, { recursive: true });
  const path = secretsPath(config);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(clean), { mode: 0o600 });
  renameSync(temporary, path);
  config.githubToken = clean.githubToken || undefined;
  config.gitlabToken = clean.gitlabToken || undefined;
  config.xToken = clean.xToken || undefined;
  config.researchUrl = clean.researchUrl || undefined;
  config.researchToken = clean.researchToken || undefined;
  if (clean.feishu?.appId && clean.feishu.appSecret && clean.feishu.ownerOpenId) {
    config.feishu = { appId: clean.feishu.appId, appSecret: clean.feishu.appSecret, ownerOpenId: clean.feishu.ownerOpenId, chatId: clean.feishu.chatId || undefined, verificationToken: clean.feishu.verificationToken || undefined, encryptKey: clean.feishu.encryptKey || undefined };
  }
  applyHostSettings(config, clean);
}

function applyHostSettings(config: AppConfig, parsed: ConnectionSecrets): void {
  if (parsed.resticRepository) config.resticRepository = parsed.resticRepository;
  if (parsed.resticPassword) config.resticPassword = parsed.resticPassword;
  if (parsed.limaInstance) config.limaInstance = parsed.limaInstance;
  if (parsed.githubShortcutStatus) config.githubShortcutStatus = parsed.githubShortcutStatus;
  if (parsed.githubShortcutConnect) config.githubShortcutConnect = parsed.githubShortcutConnect;
  if (parsed.githubShortcutDisconnect) config.githubShortcutDisconnect = parsed.githubShortcutDisconnect;
  if (config.githubShortcutStatus && config.githubShortcutConnect && config.githubShortcutDisconnect) {
    const file = join(config.dataDir, 'network-targets.json');
    const domain = config.projects[0]?.domain ?? 'personal';
    writeFileSync(file, JSON.stringify([{ id: 'github', url: 'https://github.com', domain, heartbeat: true, adapter: { kind: 'shortcuts', status: config.githubShortcutStatus, connect: config.githubShortcutConnect, disconnect: config.githubShortcutDisconnect } }]), { mode: 0o600 });
    config.networkFile = file;
  }
}

export function commandOnPath(name: string, pathEnv = process.env.PATH ?? '', exists: (path: string) => boolean = existsSync): boolean {
  if (!/^[a-z0-9-]{1,32}$/.test(name)) return false;
  return pathEnv.split(':').some(dir => !!dir && !dir.includes('\0') && exists(join(dir, name)));
}

export interface SetupStep { id: string; title: string; detail: string; href: string; done: boolean; required: boolean }

export function setupSteps(config: AppConfig, installed: Record<Runner, boolean> = { grok: commandOnPath('grok'), codex: commandOnPath('codex'), dsh: commandOnPath('dsh') }): SetupStep[] {
  const project = config.projects[0];
  const needsGitlab = config.projects.some(item => item.repositoryProvider === 'gitlab');
  return [
    { id: 'project', title: '创建一个项目', detail: project?.sourceDir ? '已有项目和同步目录。' : '填写项目、同步目录、目标仓库和允许修改的路径。', href: '/settings#projects', done: !!project?.sourceDir && !!project.repository && project.allowedPaths.length > 0, required: true },
    { id: 'repository', title: needsGitlab ? '保存 GitLab 令牌' : '保存 GitHub 令牌', detail: '令牌只保存在本机，页面不会再显示它。', href: '/settings#connections', done: needsGitlab ? !!config.gitlabToken : !!config.githubToken, required: true },
    { id: 'feishu', title: '连接飞书', detail: '填写应用编号、密钥和你的 Open ID。密钥保存后不再显示。', href: '/settings#connections', done: !!config.feishu?.appId && !!config.feishu.appSecret && !!config.feishu.ownerOpenId, required: true },
    { id: 'runner', title: '登录一个运行器', detail: installed.grok || installed.codex ? '命令已安装。若还没登录，打开终端完成登录，不会在这里输入模型密码。' : '先安装 Grok Build 或 Codex，再在终端登录。', href: '/settings#runners', done: installed.grok || installed.codex, required: true },
    { id: 'research', title: '检索网关（需要提问时）', detail: '做中英文查证前再填写。不填也可以先整理本地资料。', href: '/settings#connections', done: !!config.researchUrl, required: false },
    { id: 'isolation', title: '准备隔离环境', detail: config.limaInstance ? '实例名已保存。安装并启动 Lima 后，执行才会进隔离环境；保存本身不会切换正在运行的虚拟机。' : '安装 Lima，并在设置页填写实例名。', href: '/settings#host', done: !!config.limaInstance && commandOnPath('limactl'), required: false },
    { id: 'backup', title: '设置异机备份', detail: '填写 restic 仓库和密码。密码只留在本机。', href: '/settings#host', done: !!config.resticRepository && !!config.resticPassword && commandOnPath('restic'), required: false },
    { id: 'network', title: '填写 GitHub 网络快捷指令', detail: '填写 Shadowrocket 的状态、连接和断开指令名。保存后重新启动，才会开始探测。', href: '/settings#host', done: !!config.networkFile, required: false },
  ];
}

export function nextSetupStep(config: AppConfig, installed?: Record<Runner, boolean>): SetupStep | undefined {
  return setupSteps(config, installed).find(step => step.required && !step.done);
}

export async function openRunnerLogin(runner: Runner, launch: (command: string, args: string[]) => Promise<void> = openTerminal): Promise<{ label: string; command: string }> {
  const spec = runnerLogins[runner];
  if (!spec) throw new Error('Unknown runner.');
  await launch(spec.command, spec.args);
  return { label: spec.label, command: [spec.command, ...spec.args].join(' ') };
}

async function openTerminal(command: string, args: string[]): Promise<void> {
  const line = [command, ...args].join(' ');
  const script = `tell application "Terminal" to do script ${JSON.stringify(line)}`;
  await exec('osascript', ['-e', script]);
}
