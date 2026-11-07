import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { DomainError, now, pathAllowed, roles, safeRelativePath, type AppConfig, type Project, type RunnerPolicy } from './domain.js';
import { loadConnectionSecrets } from './setup-guide.js';

const repoPath = z.string().min(1).refine(value => { try { safeRelativePath(value); return true; } catch { return false; } }, 'Unsafe repository path');
export const projectSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/), projectId: z.string().min(1), domain: z.string().min(1),
  name: z.string().trim().min(1).max(100), description: z.string().max(2000).default(''),
  repository: z.string().regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/), repositoryProvider: z.enum(['github', 'gitlab']).default('github'),
  prdPath: repoPath, allowedPaths: z.array(repoPath.or(z.string().regex(/^[a-zA-Z0-9_./-]+\/$/))).min(1),
  trustedChecks: z.array(z.string().min(1)).default([]), trustedAppIds: z.array(z.number().int().positive()).default([]),
  ownerId: z.string().min(1), autoMerge: z.boolean().default(false), budgetUsd: z.number().finite().nonnegative().max(10000).default(5),
  executionRunner: z.enum(['grok', 'dsh']).default('grok'),
  reviewIntervalDays: z.number().int().min(1).max(365).default(7), sourceDir: z.string().optional(), createdAt: z.string().default(now),
}).superRefine((p, ctx) => {
  if (p.id !== p.projectId) ctx.addIssue({ code: 'custom', message: 'Project ID must match scope.' });
  if(p.repository.split('/').some(segment=>segment==='.'||segment==='..'))ctx.addIssue({code:'custom',message:'Repository namespace cannot contain traversal segments.'});
  if(p.repositoryProvider==='github'&&p.repository.split('/').length!==2)ctx.addIssue({code:'custom',message:'GitHub repository must use owner/repo.'});
  if (p.autoMerge && (!p.trustedChecks.length || !p.trustedAppIds.length)) ctx.addIssue({ code: 'custom', message: 'Auto merge requires named checks and trusted CI app IDs.' });
  try { if (!pathAllowed(p.prdPath, p.allowedPaths)) ctx.addIssue({ code: 'custom', message: 'PRD path must be allowed.' }); } catch { ctx.addIssue({ code: 'custom', message: 'Allowed paths must be safe.' }); }
  for (const path of p.allowedPaths) { try { safeRelativePath(path.endsWith('/') ? path.slice(0,-1) : path); } catch { ctx.addIssue({ code:'custom',message:'Unsafe allowed path.' }); } }
});

export const billingPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('metered-api') }).strict(),
  z.object({ mode: z.literal('included-subscription'), admissionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/) }).strict(),
]);
export const policySchema = z.object({
  runner: z.enum(['grok', 'dsh', 'codex']), roles: z.array(z.enum(roles)), domains: z.array(z.string().min(1)),
  provider: z.string().min(1), model: z.string().min(1), admitted: z.boolean(),
  costPerRunUsd: z.number().finite().nonnegative(), independentReview: z.boolean().default(false), billing: billingPolicySchema.optional(),
}).superRefine((policy, ctx) => {
  if (policy.billing?.mode === 'included-subscription' && policy.costPerRunUsd !== 0) ctx.addIssue({ code: 'custom', message: 'Included subscription requires exactly zero reservation.', path: ['costPerRunUsd'] });
});
const workerSchema = z.object({ command: z.string().min(1), args: z.array(z.string()).default([]), timeoutMs: z.number().int().min(1000).max(3600000).default(180000), isolation:z.literal('lima'), instance:z.string().regex(/^[a-zA-Z0-9_-]+$/), guestUser:z.string().regex(/^patrick-[a-z][a-z0-9-]{0,23}$/).optional() });
const fileSchema = z.object({
  billingBoundary: z.enum(['included-only', 'metered-only']).default('metered-only'),
  maxAttemptsPerTask: z.number().int().min(1).max(256).default(32),
  projects:z.array(projectSchema).default([]), runnerPolicies:z.array(policySchema).optional(),
  workers:z.object({grok:workerSchema.optional(),dsh:workerSchema.optional(),codex:workerSchema.optional()}).default({}),
  egressPolicies:z.array(z.object({domain:z.string().min(1),research:z.boolean(),feishu:z.boolean()})).default([{domain:'personal',research:true,feishu:true}]),
}).strict().superRefine((config,ctx)=>{
  const identities=new Set<string>();
  for(const [runner,worker] of Object.entries(config.workers)) {
    if(!worker)continue;
    worker.guestUser??=`patrick-${runner}`;
    const identity=`${worker.instance}:${worker.guestUser}`;
    if(identities.has(identity))ctx.addIssue({code:'custom',message:'Worker guest identities must be distinct on each instance.',path:['workers',runner,'guestUser']});
    identities.add(identity);
  }
});

export function defaultPolicies(): RunnerPolicy[] {
  return (['grok','dsh','codex'] as const).map(runner => ({runner,roles:[...roles],domains:['personal'],provider:runner==='grok'?'xai':runner==='dsh'?'deepseek':'openai',model:'unconfigured',admitted:false,costPerRunUsd:0,independentReview:false}));
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = z.enum(['live','demo','test']).parse(env.PATRICK_MODE ?? 'live');
  const host = env.PATRICK_HOST ?? '127.0.0.1';
  const authToken = env.PATRICK_TOKEN ?? '';
  if (!['127.0.0.1','localhost','::1'].includes(host) && authToken.length < 24) throw new DomainError('A strong PATRICK_TOKEN (24+ characters) is required for remote access.', 'configuration');
  const defaultDir=mode==='demo'?join(tmpdir(),'patrick-demo'):(platform()==='darwin' ? join(homedir(),'Library','Application Support','PAtrick') : join(homedir(),'.local','share','patrick'));
  const dataDir = resolve(env.PATRICK_DATA_DIR ?? defaultDir);
  const file = env.PATRICK_CONFIG;
  if (file && !existsSync(file)) throw new DomainError('PATRICK_CONFIG does not exist.', 'configuration');
  const parsed = fileSchema.parse(file ? JSON.parse(readFileSync(file,'utf8')) : {});
  const port = z.coerce.number().int().min(1).max(65535).parse(env.PATRICK_PORT ?? 4317);
  const ownerId = env.PATRICK_OWNER_ID ?? 'owner';
  const config: AppConfig = {
    billingBoundary: parsed.billingBoundary, maxAttemptsPerTask: parsed.maxAttemptsPerTask,
    mode,host,port,dataDir,vaultDir:resolve(env.PATRICK_VAULT_DIR ?? join(dataDir,'vault')),ownerId,authToken,
    sessionSecret:env.PATRICK_SESSION_SECRET ?? authToken, projects:parsed.projects as Project[],
    runnerPolicies:parsed.runnerPolicies ?? defaultPolicies(),workers:parsed.workers,
    githubToken:env.PATRICK_GITHUB_TOKEN ?? env.GITHUB_TOKEN ?? env.GH_TOKEN,
    gitlabToken:env.PATRICK_GITLAB_TOKEN, gitlabUrl:env.PATRICK_GITLAB_URL,
    ...(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && env.FEISHU_OWNER_OPEN_ID ? { feishu:{appId:env.FEISHU_APP_ID,appSecret:env.FEISHU_APP_SECRET,verificationToken:env.FEISHU_VERIFICATION_TOKEN,encryptKey:env.FEISHU_ENCRYPT_KEY,ownerOpenId:env.FEISHU_OWNER_OPEN_ID,chatId:env.FEISHU_CHAT_ID} } : {}),
    researchUrl:env.PATRICK_RESEARCH_URL,researchToken:env.PATRICK_RESEARCH_TOKEN,
    egressPolicies:parsed.egressPolicies,networkFile:env.PATRICK_NETWORK_CONFIG,
    scanIntervalMs:z.coerce.number().min(1000).parse(env.PATRICK_SCAN_INTERVAL_MS ?? 60000),
  };
  loadConnectionSecrets(config);
  return config;
}
