import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { Store } from '../../src/store.js';
import { Workbench } from '../../src/orchestrator.js';
import { DEFAULT_ALLOWED_PATHS, DEFAULT_PRD_PATH, loadWorkspaceSetup } from '../../src/workspace-setup.js';

const stores: Store[] = [];
const roots: string[] = [];
afterEach(() => {
  stores.splice(0).forEach(store => store.close());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  vi.unstubAllGlobals();
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-setup-http-'));
  roots.push(root);
  const config = readConfig({ PATRICK_MODE: 'live', PATRICK_DATA_DIR: root, PATRICK_TOKEN: 'test-owner-token-at-least-32-characters', PATRICK_HOST: '127.0.0.1' });
  const store = new Store(':memory:');
  stores.push(store);
  const engine = new Workbench({ store, config, workers: [], writer: { baseline: async () => '', deliver: async () => { throw new Error('no'); } }, research: { research: async () => { throw new Error('no'); } } });
  return { app: createApp({ store, config, engine }), store, config };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('workspace onboarding HTTP', () => {
  it('renders the three-step onboarding wizard before projects exist', async () => {
    const { app } = setup();
    const page = await (await app.request('/', { headers: { Authorization: 'Bearer test-owner-token-at-least-32-characters' } })).text();
    expect(page).toContain('三步进入七层链路');
    expect(page).toContain('自动采集输入');
    expect(page).toContain('开发项目根目录');
    expect(page).toContain('交互设置');
    expect(page).toContain('/api/setup/ideas');
  });

  it('probes, scans, creates projects and completes feishu verification', async () => {
    const { app, store, config } = setup();
    const auth = { Authorization: 'Bearer test-owner-token-at-least-32-characters', Accept: 'application/json' };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/repos/acme/ideas')) return json({ full_name: 'acme/ideas', name: 'ideas', private: false });
      if (target.includes('/orgs/acme/repos')) return json([{ full_name: 'acme/ship', name: 'Ship', description: 'Delivery' }, { full_name: 'acme/ideas', name: 'ideas' }]);
      if (target.includes('tenant_access_token')) return json({ code: 0, tenant_access_token: 't-token' });
      if (target.includes('/messages?receive_id_type=open_id') && init?.method === 'POST') return json({ code: 0, data: { message_id: 'om_1', chat_id: 'oc_chat' } });
      if (target.includes('/messages?container_id_type=chat')) return json({ code: 0, data: { items: [{ message_id: 'om_1' }] } });
      return json({ message: `unexpected ${target}` }, 404);
    }));

    const ideas = await app.request('/api/setup/ideas', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ideasGithub: 'acme/ideas', githubToken: 'ghp_setup_token_value' }),
    });
    expect(ideas.status).toBe(200);
    expect(loadWorkspaceSetup(config).ideasGithub).toBe('acme/ideas');
    expect(config.githubToken).toBe('ghp_setup_token_value');

    const rootsResponse = await app.request('/api/setup/roots', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ githubRoot: 'acme', create: true }),
    });
    expect(rootsResponse.status).toBe(200);
    const created = await rootsResponse.json();
    expect(created.created).toHaveLength(1);
    expect(created.created[0]).toMatchObject({ repository: 'acme/ship', prdPath: DEFAULT_PRD_PATH, allowedPaths: [...DEFAULT_ALLOWED_PATHS] });
    expect(store.list('projects')).toHaveLength(1);

    const feishu = await app.request('/api/setup/feishu', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'cli_demo', appSecret: 'secret-value', ownerOpenId: 'ou_owner', ownerName: 'Pat' }),
    });
    expect(feishu.status).toBe(200);
    expect(loadWorkspaceSetup(config).completed).toBe(true);
    expect(config.feishu).toMatchObject({ appId: 'cli_demo', ownerOpenId: 'ou_owner', chatId: 'oc_chat' });

    const workbench = await (await app.request('/', { headers: auth })).text();
    expect(workbench).toContain('工作台');
    expect(workbench).not.toContain('三步进入七层链路');
  });
});
