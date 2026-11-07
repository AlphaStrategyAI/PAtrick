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
  researchUrl: z.union([z.string().trim().url().max(500), z.literal('')]).optional(),
  researchToken: optionalSecret,
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
  if (parsed.researchUrl) config.researchUrl = parsed.researchUrl;
  if (parsed.researchToken) config.researchToken = parsed.researchToken;
  if (parsed.feishu?.appId && parsed.feishu.appSecret && parsed.feishu.ownerOpenId) {
    config.feishu = { appId: parsed.feishu.appId, appSecret: parsed.feishu.appSecret, ownerOpenId: parsed.feishu.ownerOpenId, chatId: parsed.feishu.chatId || undefined, verificationToken: parsed.feishu.verificationToken || undefined, encryptKey: parsed.feishu.encryptKey || undefined };
  }
}

function storedSecrets(config: AppConfig): ConnectionSecrets {
  return {
    ...(config.githubToken ? { githubToken: config.githubToken } : {}),
    ...(config.gitlabToken ? { gitlabToken: config.gitlabToken } : {}),
    ...(config.researchUrl ? { researchUrl: config.researchUrl } : {}),
    ...(config.researchToken ? { researchToken: config.researchToken } : {}),
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
    researchUrl: keep(input.researchUrl, current.researchUrl),
    researchToken: keep(input.researchToken, current.researchToken),
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
  config.researchUrl = clean.researchUrl || undefined;
  config.researchToken = clean.researchToken || undefined;
  if (clean.feishu?.appId && clean.feishu.appSecret && clean.feishu.ownerOpenId) {
    config.feishu = { appId: clean.feishu.appId, appSecret: clean.feishu.appSecret, ownerOpenId: clean.feishu.ownerOpenId, chatId: clean.feishu.chatId || undefined, verificationToken: clean.feishu.verificationToken || undefined, encryptKey: clean.feishu.encryptKey || undefined };
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
