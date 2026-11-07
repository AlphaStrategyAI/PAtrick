import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { commandOnPath, nextSetupStep, saveConnectionSecrets, setupSteps } from '../../src/setup-guide.js';

it('saves connection secrets on this machine and does not replace them with a blank form', () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-setup-'));
  try {
    const config = readConfig({ PATRICK_MODE: 'test', PATRICK_DATA_DIR: root, PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
    saveConnectionSecrets(config, { githubToken: 'github-token-value', feishu: { appId: 'cli_app', appSecret: 'feishu-secret-value', ownerOpenId: 'ou_owner' } });
    expect(config.githubToken).toBe('github-token-value');
    expect(config.feishu?.appSecret).toBe('feishu-secret-value');
    saveConnectionSecrets(config, { githubToken: '', feishu: { appSecret: '' } });
    expect(config.githubToken).toBe('github-token-value');
    expect(config.feishu?.appSecret).toBe('feishu-secret-value');
    const restarted = readConfig({ PATRICK_MODE: 'test', PATRICK_DATA_DIR: root, PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
    expect(restarted.githubToken).toBe('github-token-value');
    expect(restarted.feishu?.ownerOpenId).toBe('ou_owner');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('guides the first launch through project, credential, Feishu, and an installed runner', () => {
  const config = readConfig({ PATRICK_MODE: 'live', PATRICK_DATA_DIR: mkdtempSync(join(tmpdir(), 'patrick-setup-live-')), PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
  const installed = { grok: false, codex: false, dsh: false };
  expect(nextSetupStep(config, installed)?.id).toBe('project');
  config.projects.push({ id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/'], trustedChecks: [], trustedAppIds: [], ownerId: 'owner', autoMerge: false, budgetUsd: 0, sourceDir: '/tmp/ideas', createdAt: '2026-11-07T00:00:00.000Z' });
  expect(nextSetupStep(config, installed)?.id).toBe('repository');
  config.githubToken = 'github-token-value';
  expect(nextSetupStep(config, installed)?.id).toBe('feishu');
  config.feishu = { appId: 'cli_app', appSecret: 'feishu-secret-value', ownerOpenId: 'ou_owner' };
  expect(nextSetupStep(config, installed)?.id).toBe('runner');
  expect(nextSetupStep(config, { grok: true, codex: false, dsh: false })).toBeUndefined();
  expect(setupSteps(config, { grok: true, codex: false, dsh: false }).find(step => step.id === 'research')?.required).toBe(false);
  expect(commandOnPath('grok', '/usr/bin', path => path === '/usr/bin/grok')).toBe(true);
  expect(commandOnPath('../grok', '/usr/bin', () => true)).toBe(false);
});
