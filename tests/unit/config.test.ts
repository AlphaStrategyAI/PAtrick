import { describe, expect, it } from 'vitest';
import { readConfig, projectSchema } from '../../src/config.js';

describe('configuration', () => {
  const project = { id: 'p', projectId: 'p', domain: 'personal', name: 'Notes', repository: 'owner/repo', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], ownerId: 'owner' };

  it.each([0, .01, 5, 10000])('preserves a finite project budget of %s', budgetUsd => {
    expect(projectSchema.parse({ ...project, budgetUsd }).budgetUsd).toBe(budgetUsd);
  });

  it('defaults an omitted project budget to five dollars', () => {
    expect(projectSchema.parse(project).budgetUsd).toBe(5);
  });

  it.each([-1, 10000.01, NaN, Infinity, -Infinity, '0', true, false, null, [], {}])('rejects an invalid schema budget %j', budgetUsd => {
    expect(projectSchema.safeParse({ ...project, budgetUsd }).success).toBe(false);
  });

  it('starts unconfigured in live mode with no admitted worker or automatic merge', () => {
    const config = readConfig({});
    expect(config.mode).toBe('live');
    expect(config.host).toBe('127.0.0.1');
    expect(config.projects).toEqual([]);
    expect(config.runnerPolicies.every(policy => !policy.admitted)).toBe(true);
  });
  it('configures app-authenticated Feishu without an HTTP callback verification token', () => {
    const env = { FEISHU_APP_ID: 'cli_fake', FEISHU_APP_SECRET: 'fake-secret', FEISHU_OWNER_OPEN_ID: 'ou_fake', FEISHU_CHAT_ID: 'oc_fake' };
    const channel = readConfig(env).feishu;
    expect(channel).toEqual({ appId: 'cli_fake', appSecret: 'fake-secret', ownerOpenId: 'ou_fake', chatId: 'oc_fake' });
    expect(channel?.verificationToken).toBeUndefined();
    expect(readConfig({ ...env, FEISHU_VERIFICATION_TOKEN: 'real-callback-token' }).feishu?.verificationToken).toBe('real-callback-token');
    expect(readConfig({ ...env, FEISHU_CHAT_ID: undefined }).feishu?.chatId).toBeUndefined();
    for (const key of ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_OWNER_OPEN_ID'] as const) {
      expect(readConfig({ ...env, [key]: undefined }).feishu).toBeUndefined();
    }
  });
  it('requires a strong token for non-loopback access', () => {
    expect(() => readConfig({ PATRICK_HOST: '0.0.0.0' })).toThrow(/token/i);
    expect(readConfig({ PATRICK_HOST: '0.0.0.0', PATRICK_TOKEN: 'x'.repeat(32) }).host).toBe('0.0.0.0');
  });
  it('rejects unsafe repository paths and vacuous CI configuration for auto merge', () => {
    const base = { id: 'p', projectId: 'p', domain: 'personal', name: 'Notes', repository: 'owner/repo', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], ownerId: 'owner' };
    expect(projectSchema.safeParse({ ...base, autoMerge: true }).success).toBe(false);
    expect(projectSchema.safeParse({ ...base, prdPath: '../key' }).success).toBe(false);
    expect(projectSchema.safeParse({ ...base, autoMerge: true, trustedChecks: ['validate'], trustedAppIds: [123] }).success).toBe(true);
  });
});
