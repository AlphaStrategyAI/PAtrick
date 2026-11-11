import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { collectDoctorChecks } from '../../scripts/doctor-checks.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const missing = () => ({ ready: false, detail: 'Not installed or unavailable.' });

function config(mode: 'live' | 'demo' | 'test') {
  const dataDir = mkdtempSync(join(tmpdir(), 'patrick-doctor-'));
  dirs.push(dataDir);
  return readConfig({ PATRICK_MODE: mode, PATRICK_DATA_DIR: dataDir, PATRICK_TOKEN: 'test-owner-token-at-least-32-characters', PATRICK_OWNER_ID: 'owner' });
}

describe('doctor readiness', () => {
  it('shows Lima, runners, Feishu, CI and the research gateway unready when they are not configured', () => {
    const checks = collectDoctorChecks(config('live'), '24.22.2', missing);
    const ready = Object.fromEntries(checks.map(check => [check.name, check.ready]));
    expect(ready['Node.js 24']).toBe(true);
    for (const name of ['项目与来源', 'GitHub 交付', '隔离 worker', '飞书连接配置', '双语查证', '准备隔离环境', 'limactl', 'restic']) expect(ready[name], name).toBe(false);
  });
  it('does not mark a demo or test workspace as live and does not print secrets', () => {
    const demo = config('demo');
    demo.githubToken = 'unique-github-token-value';
    demo.feishu = { appId: 'cli_app', appSecret: 'unique-feishu-secret', ownerOpenId: 'ou_owner', chatId: 'oc_chat' };
    const checks = collectDoctorChecks(demo, '24.22.2', missing);
    expect(checks.some(check => check.live)).toBe(false);
    expect(checks.find(check => check.name === 'live 准入')).toMatchObject({ ready: false, live: false });
    const printed = JSON.stringify(checks);
    expect(printed).not.toContain('unique-github-token-value');
    expect(printed).not.toContain('unique-feishu-secret');
    const testMode = collectDoctorChecks(config('test'), '26.0.0', missing);
    expect(testMode.find(check => check.name === 'Node.js 24')?.ready).toBe(false);
    expect(testMode.some(check => check.live)).toBe(false);
  });
});
