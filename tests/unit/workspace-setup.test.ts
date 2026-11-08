import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../../src/config.js';
import { Store } from '../../src/store.js';
import {
  DEFAULT_ALLOWED_PATHS,
  DEFAULT_PRD_PATH,
  applyFeishuStep,
  applyIdeasStep,
  applyRootStep,
  loadWorkspaceSetup,
  onboardingNeeded,
  probeRepository,
  projectFromRemote,
  scanRootRepositories,
  verifyFeishuChannel,
} from '../../src/workspace-setup.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function config(mode: 'live' | 'demo' = 'live') {
  const root = mkdtempSync(join(tmpdir(), 'patrick-setup-'));
  roots.push(root);
  return readConfig({ PATRICK_MODE: mode, PATRICK_DATA_DIR: root, PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('workspace setup defaults', () => {
  it('creates projects with dual PRD directories', () => {
    const project = projectFromRemote({ name: 'Notes', repository: 'owner/notes', repositoryProvider: 'github', ownerId: 'owner' });
    expect(project.prdPath).toBe(DEFAULT_PRD_PATH);
    expect(project.allowedPaths).toEqual([...DEFAULT_ALLOWED_PATHS]);
    expect(project.budgetUsd).toBe(0);
    expect(project.autoMerge).toBe(false);
  });

  it('treats legacy workspaces with projects as already onboarded', () => {
    const cfg = config();
    expect(onboardingNeeded(cfg, 0)).toBe(true);
    expect(onboardingNeeded(cfg, 2)).toBe(false);
    expect(loadWorkspaceSetup(cfg).completed).toBe(false);
  });
});

describe('repository probes and root scans', () => {
  it('probes a github repository through the API', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string) => { calls.push(String(url)); return json({ full_name: 'owner/ideas', name: 'ideas', private: true, default_branch: 'main' }); });
    const probe = await probeRepository({ provider: 'github', repository: 'owner/ideas', token: 'token' }, fetcher as typeof fetch);
    expect(probe).toMatchObject({ ok: true, repository: 'owner/ideas', private: true });
    expect(calls[0]).toContain('/repos/owner/ideas');
  });

  it('lists github root repositories and excludes the ideas repo', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).includes('/orgs/')) return json([{ full_name: 'acme/ideas', name: 'ideas' }, { full_name: 'acme/app', name: 'app', description: 'Ship it' }, { full_name: 'acme/old', name: 'old', archived: true }]);
      return json({}, 404);
    });
    const scan = await scanRootRepositories({ provider: 'github', root: 'acme', token: 'token', exclude: ['acme/ideas'] }, fetcher as typeof fetch);
    expect(scan.repositories).toEqual([{ repository: 'acme/app', name: 'app', description: 'Ship it', private: false }]);
  });
});

describe('guided setup steps', () => {
  it('saves ideas after a successful github probe', async () => {
    const cfg = config();
    const fetcher = vi.fn(async () => json({ full_name: 'owner/ideas', name: 'ideas', private: false }));
    const result = await applyIdeasStep(cfg, { ideasGithub: 'owner/ideas', githubToken: 'ghp_test_token_value' }, fetcher as typeof fetch);
    expect(result.setup.ideasGithub).toBe('owner/ideas');
    expect(cfg.githubToken).toBe('ghp_test_token_value');
    expect(onboardingNeeded(cfg, 0)).toBe(true);
  });

  it('creates projects from a github root', async () => {
    const cfg = config();
    const store = new Store(':memory:');
    await applyIdeasStep(cfg, { ideasGithub: 'acme/ideas', githubToken: 'ghp_test_token_value' }, vi.fn(async () => json({ full_name: 'acme/ideas', name: 'ideas' })) as typeof fetch);
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).includes('/orgs/')) return json([{ full_name: 'acme/app', name: 'App', description: 'Product' }, { full_name: 'acme/ideas', name: 'ideas' }]);
      return json({ full_name: 'acme/ideas', name: 'ideas' });
    });
    const result = await applyRootStep(cfg, store, { githubRoot: 'acme', create: true }, fetcher as typeof fetch);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({ repository: 'acme/app', prdPath: DEFAULT_PRD_PATH, allowedPaths: [...DEFAULT_ALLOWED_PATHS] });
    expect(store.list('projects')).toHaveLength(1);
    expect(loadWorkspaceSetup(cfg).githubRoot).toBe('acme');
  });

  it('verifies feishu send and history before completing setup', async () => {
    const cfg = config();
    const store = new Store(':memory:');
    await applyIdeasStep(cfg, { ideasGithub: 'acme/ideas', githubToken: 'ghp_test_token_value' }, vi.fn(async () => json({ full_name: 'acme/ideas', name: 'ideas' })) as typeof fetch);
    await applyRootStep(cfg, store, { githubRoot: 'acme', create: true }, vi.fn(async () => json([{ full_name: 'acme/app', name: 'App' }])) as typeof fetch);
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('tenant_access_token')) return json({ code: 0, tenant_access_token: 't-token' });
      if (String(url).includes('/messages?receive_id_type=open_id') && init?.method === 'POST') return json({ code: 0, data: { message_id: 'om_1', chat_id: 'oc_chat' } });
      if (String(url).includes('/messages?container_id_type=chat')) return json({ code: 0, data: { items: [{ message_id: 'om_1' }] } });
      return json({ code: 1, msg: 'unexpected' }, 400);
    });
    const verify = await verifyFeishuChannel({ appId: 'cli_x', appSecret: 'secret-value', ownerOpenId: 'ou_owner', ownerName: 'Pat' }, fetcher as typeof fetch);
    expect(verify).toMatchObject({ ok: true, tokenOk: true, sendOk: true, receiveOk: true, chatId: 'oc_chat' });
    const result = await applyFeishuStep(cfg, { appId: 'cli_x', appSecret: 'secret-value', ownerOpenId: 'ou_owner', ownerName: 'Pat' }, fetcher as typeof fetch);
    expect(result.setup.completed).toBe(true);
    expect(cfg.feishu).toMatchObject({ appId: 'cli_x', ownerOpenId: 'ou_owner', chatId: 'oc_chat' });
    expect(onboardingNeeded(cfg, store.list('projects').length)).toBe(false);
  });
});
