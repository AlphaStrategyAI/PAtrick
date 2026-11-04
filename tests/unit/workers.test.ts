import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig, WorkerInput } from '../../src/domain.js';
import { LimaWorker, parseWorkerOutput, commandFor, guestScripts } from '../../src/integrations/workers.js';
describe('worker protocols', () => {
  it('ships syntactically executable isolation, test and cleanup scripts', () => {
    for(const script of Object.values(guestScripts))expect(()=>new Function(script)).not.toThrow();
  });
  it('unwraps structured CLI envelopes without accepting arbitrary logs as JSON', () => {
    expect(parseWorkerOutput('{"structured_output":{"summary":"ok"}}')).toEqual({summary:'ok'});
    expect(parseWorkerOutput('```json\n{"summary":"ok"}\n```')).toEqual({summary:'ok'});
    expect(()=>parseWorkerOutput('Authorization failed')).toThrow();
  });
  it('uses read-only, ephemeral noninteractive Codex and constrained Grok output', () => {
    expect(commandFor('codex','model').args).toContain('read-only');
    expect(commandFor('codex','model').args).toContain('--ephemeral');
    expect(commandFor('grok','model').args).toContain('--no-subagents');
    expect(commandFor('grok','model').args).toContain('--json-schema');
  });
});

describe('Lima host transport environment', () => {
  it.each([true, false])('uses the selected instance store with private LIMA_HOME configured: %s', async privateHome => {
    const root = mkdtempSync(join(tmpdir(), 'patrick-lima-home-'));
    try {
      const bin = join(root, 'bin'), home = join(root, 'home'), temporary = join(root, 'tmp');
      const limaHome = privateHome ? join(root, 'private-lima') : join(home, '.lima');
      for (const path of [bin, home, temporary, limaHome]) mkdirSync(path, { recursive: true });
      writeFileSync(join(limaHome, 'fixture-instance'), 'synthetic instance only');
      const eventsPath = join(root, 'events.jsonl');
      const failurePath = join(root, 'failure.txt');
      const blocked = ['FEISHU_APP_SECRET', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'OPENAI_API_KEY', 'RESEARCH_TOKEN', 'PATRICK_AUTH_TOKEN', 'SSH_AUTH_SOCK', 'LIMA_SENTINEL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'];
      const output = { summary: 'Fixture protocol completed', observations: ['Synthetic result'] };
      // Model only the limactl process protocol; never execute guest scripts or a real runner.
      writeFileSync(join(bin, 'limactl'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const scripts = ${JSON.stringify(guestScripts)}, output = ${JSON.stringify(output)};
const eventsPath = ${JSON.stringify(eventsPath)}, blocked = ${JSON.stringify(blocked)};
const limaHome = process.env.LIMA_HOME ?? path.join(process.env.HOME, '.lima');
// macOS adds this runtime metadata even when spawn receives an explicit environment.
const keys = Object.keys(process.env).filter(key => key !== '__CF_USER_TEXT_ENCODING').sort();
const leaked = blocked.filter(key => process.env[key] !== undefined);
const argv = process.argv.slice(2), args = argv.slice(3), dir = '/tmp/patrick-Fixture123';
function fail(message) { fs.writeFileSync(${JSON.stringify(failurePath)}, message + ': ' + keys.join(',')); process.exit(78); }
if (leaked.length || keys.some(key => !['PATH', 'HOME', 'TMPDIR', 'LIMA_HOME'].includes(key))) fail('Host environment leaked');
if (argv[0] !== 'shell' || argv[1] !== 'fixture-instance' || argv[2] !== '--') fail('Unexpected limactl command');
if (!fs.existsSync(path.join(limaHome, 'fixture-instance'))) fail('Fixture instance unavailable in selected Lima home');
const active = path.join(limaHome, 'workspace-active');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  let stage;
  if (args[0] === 'node' && args[1] === '-e' && args[2] === scripts.prepare) {
    const payload = JSON.parse(input);
    if (payload.schema.type !== 'object' || !payload.prompt.includes('feedback worker') || payload.files.length) fail('Invalid preparation payload');
    stage = 'prepare'; fs.writeFileSync(active, dir); process.stdout.write(JSON.stringify({ dir }));
  } else if (args[0] === 'sh' && args[4] === dir && args[5] === 'fixture-grok' && args.includes('fixture-model')) {
    if (!fs.existsSync(active) || input !== '') fail('CLI started without prepared workspace');
    stage = 'cli'; process.stdout.write(JSON.stringify({ structured_output: output }));
  } else if (args[0] === 'node' && args[1] === '-e' && args[2] === scripts.cleanup && args[3] === dir) {
    if (!fs.existsSync(active)) fail('Cleanup without prepared workspace');
    stage = 'cleanup'; fs.unlinkSync(active);
  } else fail('Unexpected guest command');
  fs.appendFileSync(eventsPath, JSON.stringify({ stage, limaHome, keys, leaked, PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }) + '\\n');
});
`, { mode: 0o700 });
      vi.stubEnv('PATH', bin);
      vi.stubEnv('HOME', home);
      vi.stubEnv('TMPDIR', temporary);
      vi.stubEnv('LIMA_HOME', privateHome ? limaHome : undefined);
      for (const key of blocked) vi.stubEnv(key, `synthetic-${key}`);

      const createdAt = '2026-01-01T00:00:00.000Z';
      const project: WorkerInput['project'] = { id: 'fixture-project', projectId: 'fixture-project', domain: 'personal', name: 'Fixture', description: 'Synthetic transport test', repository: 'fixture/repo', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/'], trustedChecks: [], trustedAppIds: [], ownerId: 'fixture-owner', autoMerge: false, budgetUsd: 1, createdAt };
      const source: WorkerInput['source'] = { id: 'fixture-source', projectId: project.id, domain: project.domain, kind: 'manual', externalId: 'fixture', revision: 'fixture-revision', title: 'Fixture', content: 'Synthetic input', locator: 'manual:fixture', authorId: project.ownerId, retention: 'ephemeral', status: 'active', createdAt };
      const task: WorkerInput['task'] = { id: 'fixture-task', projectId: project.id, domain: project.domain, sourceId: source.id, sourceRevision: source.revision, title: source.title, description: source.content, status: 'feedback', version: 1, createdAt, updatedAt: createdAt, runAfter: createdAt, attempts: 0, repairCount: 0, budgetUsd: 1, spentUsd: 0, stage: 'feedback' };
      const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: root, vaultDir: root, ownerId: project.ownerId, authToken: 'synthetic-auth', sessionSecret: 'synthetic-session', projects: [project], scanIntervalMs: 1000, workers: { grok: { command: 'fixture-grok', args: [], timeoutMs: 5000, isolation: 'lima', instance: 'fixture-instance' } }, runnerPolicies: [{ runner: 'grok', roles: ['feedback'], domains: [project.domain], provider: 'fixture-provider', model: 'fixture-model', admitted: true, costPerRunUsd: 0, independentReview: false }] };

      const run = new LimaWorker('grok', config).run({ task, project, source, role: 'feedback', cards: [], rules: [] }).catch(error => {
        if (existsSync(failurePath)) error.message += ` ${readFileSync(failurePath, 'utf8')}`;
        throw error;
      });
      await expect(run).resolves.toEqual({ output, costUsd: 0, provider: 'fixture-provider', model: 'fixture-model' });
      const events = readFileSync(eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const keys = ['PATH', 'HOME', 'TMPDIR', ...(privateHome ? ['LIMA_HOME'] : [])].sort();
      expect(events).toEqual(['prepare', 'cli', 'cleanup'].map(stage => ({ stage, limaHome, keys, leaked: [], PATH: bin, HOME: home, TMPDIR: temporary })));
      expect(existsSync(join(limaHome, 'workspace-active'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
