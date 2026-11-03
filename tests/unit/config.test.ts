import { describe, expect, it } from 'vitest';
import { readConfig, projectSchema } from '../../src/config.js';

describe('configuration', () => {
  it('starts unconfigured in live mode with no admitted worker or automatic merge', () => {
    const config = readConfig({});
    expect(config.mode).toBe('live');
    expect(config.host).toBe('127.0.0.1');
    expect(config.projects).toEqual([]);
    expect(config.runnerPolicies.every(policy => !policy.admitted)).toBe(true);
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
