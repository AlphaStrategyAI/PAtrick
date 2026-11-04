import { describe, expect, it } from 'vitest';
import { readConfig, projectSchema } from '../../src/config.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('configuration', () => {
  function withWorkers(workers: unknown) {
    const dir=mkdtempSync(join(tmpdir(),'patrick-worker-config-'));
    try { const file=join(dir,'config.json');writeFileSync(file,JSON.stringify({workers}));return readConfig({PATRICK_CONFIG:file}); }
    finally { rmSync(dir,{recursive:true,force:true}); }
  }
  const worker={command:'fixture',args:[],isolation:'lima',instance:'fixture'};
  it('resolves dedicated default guest identities and accepts an explicit dedicated identity',()=>{
    expect(withWorkers({grok:worker,codex:{...worker,guestUser:'patrick-review'}}).workers).toMatchObject({grok:{guestUser:'patrick-grok'},codex:{guestUser:'patrick-review'}});
  });
  it.each(['root','admin','1000','--root','patrick-a b','patrick-a\nb','patrick-a\n','patrick-a\r','patrick-a;id','patrick-'+ 'a'.repeat(25),'patrick-1','patrick-'])('rejects unsafe guest identity %j',guestUser=>{
    expect(()=>withWorkers({grok:{...worker,guestUser}})).toThrow();
  });
  it('rejects explicit and omitted-default identity collisions on one instance',()=>{
    expect(()=>withWorkers({grok:worker,codex:{...worker,guestUser:'patrick-grok'}})).toThrow();
    expect(()=>withWorkers({grok:{...worker,guestUser:'patrick-shared'},codex:{...worker,guestUser:'patrick-shared'}})).toThrow();
    expect(()=>withWorkers({grok:worker,codex:{...worker,guestUser:'patrick-grok',instance:'other'}})).not.toThrow();
  });
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

describe('billing policy configuration', () => {
  const policy = { runner: 'codex', roles: ['plan'], domains: ['personal'], provider: 'synthetic', model: 'synthetic', admitted: false, costPerRunUsd: 0 };
  function parse(value: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'patrick-SYNTHETIC-policy-'));
    try { const file = join(dir, 'config.json'); writeFileSync(file, JSON.stringify(value)); return readConfig({ PATRICK_CONFIG: file }); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
  it('emits legacy metered host default and common attempt default without inferring included from zero', () => {
    expect(readConfig({})).toMatchObject({ billingBoundary: 'metered-only', maxAttemptsPerTask: 32 });
    expect(parse({ runnerPolicies: [policy] }).runnerPolicies[0]?.billing).toBeUndefined();
    expect(parse({ runnerPolicies: [{ ...policy, billing: { mode: 'metered-api' } }] }).runnerPolicies[0]?.billing).toEqual({ mode: 'metered-api' });
  });
  it.each(['included-only', 'metered-only'])('parses host boundary %s', billingBoundary => { expect(parse({ billingBoundary }).billingBoundary).toBe(billingBoundary); });
  it.each(['free', '', null, 0])('rejects invalid explicit host boundary %j', billingBoundary => { expect(() => parse({ billingBoundary })).toThrow(); });
  it.each([1, 32, 256])('accepts attempt limit %s', maxAttemptsPerTask => { expect(parse({ maxAttemptsPerTask }).maxAttemptsPerTask).toBe(maxAttemptsPerTask); });
  it.each([0, 257, 1.5, NaN, Infinity, '32'])('rejects invalid attempt limit %j', maxAttemptsPerTask => { expect(() => parse({ maxAttemptsPerTask })).toThrow(); });
  it('preserves included mode only with explicit ID and exactly zero cost', () => { expect(parse({ runnerPolicies: [{ ...policy, billing: { mode: 'included-subscription', admissionId: 'synthetic_1' } }] }).runnerPolicies[0]?.billing).toEqual({ mode: 'included-subscription', admissionId: 'synthetic_1' }); });
  it.each([{ mode: 'free' }, { mode: 'metered-api', admissionId: 'extra' }, { mode: 'included-subscription' }, { mode: 'included-subscription', admissionId: '../bad' }, { mode: 'included-subscription', admissionId: 'a'.repeat(65) }, { mode: 'included-subscription', admissionId: 'x', secret: 'extra' }])('rejects unknown/malformed billing contract %j', billing => { expect(() => parse({ runnerPolicies: [{ ...policy, billing }] })).toThrow(); });
  it.each([.01, -1, Infinity, NaN])('rejects included cost %j', costPerRunUsd => { expect(() => parse({ runnerPolicies: [{ ...policy, costPerRunUsd, billing: { mode: 'included-subscription', admissionId: 'synthetic' } }] })).toThrow(); });
  it.each([Infinity, NaN, -1])('rejects metered nonfinite/negative cost %j', costPerRunUsd => { expect(() => parse({ runnerPolicies: [{ ...policy, costPerRunUsd }] })).toThrow(); });
});
