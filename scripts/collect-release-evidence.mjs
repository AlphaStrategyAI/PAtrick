// Collects the release evidence required by docs/plans/PAtrick技术实现计划.md §8.3.
//
// Every scenario runs its command for real. The exit code, the captured output and
// the SHA-256 of that output are recorded, so a scenario can only be `passed` when
// its command actually succeeded. A scenario whose real capability is missing is
// `blocked` or `pending` instead, and the missing prerequisite is machine-checked
// rather than asserted, so the classification cannot drift away from reality.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productCoverage, releaseEvidencePlan } from './release-evidence-plan.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function digestTree(directory, filter = () => true) {
  const entries = [];
  const walk = (current) => {
    for (const name of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, name.name);
      if (name.isDirectory()) walk(path);
      else if (name.isFile() && filter(path)) entries.push(`${path.slice(directory.length)}:${sha256(readFileSync(path))}`);
    }
  };
  walk(directory);
  return sha256(entries.join('\n'));
}

function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function evaluatePrecondition(precondition) {
  if (!precondition) return false;
  switch (precondition.type) {
    case 'path-absent':
      return !existsSync(precondition.path);
    case 'env-absent':
      return !process.env[precondition.name];
    case 'json-status': {
      const document = readJson(join(root, precondition.file));
      const actual = precondition.path.split('.').reduce((value, key) => value?.[key], document);
      return actual === precondition.value;
    }
    case 'json-all-pending': {
      const document = readJson(join(root, precondition.file));
      const items = document[precondition.collection];
      return Array.isArray(items) && items.length > 0
        && items.every((item) => item[precondition.field] === 'pending');
    }
    case 'json-entries-incomplete': {
      // The real capability is missing unless every recorded entry says so.
      const document = readJson(join(root, precondition.file));
      const items = document[precondition.collection];
      if (!Array.isArray(items) || items.length === 0) return true;
      return !items.every((item) => item[precondition.field] === precondition.value);
    }
    default:
      throw new Error(`unknown precondition type: ${precondition.type}`);
  }
}

function runCommand(command) {
  const startedAt = Date.now();
  const result = spawnSync(command, {
    cwd: root,
    shell: '/bin/zsh',
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - startedAt;
  const exitCode = typeof result.status === 'number' ? result.status : -1;
  const output = [
    `$ ${command}`,
    `exit=${exitCode} signal=${result.signal ?? 'none'} durationMs=${durationMs}`,
    result.error ? `error=${result.error.message}` : null,
    '--- stdout ---',
    result.stdout ?? '',
    '--- stderr ---',
    result.stderr ?? '',
  ].filter((line) => line !== null).join('\n');
  return { exitCode, output, durationMs };
}

function versionContext() {
  const migrations = readJson(join(root, 'packages/storage/migrations/manifest.json'));
  const npmVersion = spawnSync('npm', ['-v'], { encoding: 'utf8' }).stdout?.trim() ?? '';
  return {
    code: git('rev-parse', 'HEAD'),
    node: process.version,
    npm: npmVersion,
    platform: `${process.platform}-${process.arch}`,
    osRelease: release(),
    schemaRange: '1..1',
    designInputs: sha256(readFileSync(join(root, 'design-inputs.lock.json'))),
    upstream: sha256(readFileSync(join(root, 'upstream.lock.json'))),
    lockfile: sha256(readFileSync(join(root, 'package-lock.json'))),
    migrations: `${migrations.length}:${sha256(readFileSync(join(root, 'packages/storage/migrations/manifest.json')))}`,
    tests: digestTree(join(root, 'tests')),
    fixtures: digestTree(join(root, 'fixtures')),
  };
}

function parseArguments(argv) {
  const options = { release: '', only: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--only') {
      options.only = String(argv[index + 1] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
      index += 1;
    } else if (!options.release) {
      options.release = argument;
    }
  }
  if (!options.release) throw new Error('usage: node scripts/collect-release-evidence.mjs <release-id> [--only T00,T01]');
  return options;
}

const options = parseArguments(process.argv.slice(2));
const evidenceRoot = join(root, 'release-evidence', options.release);
// The collection runs against a clean checkout: the runtime build refuses an
// overridden working tree, so the report is staged outside the repository and
// only moved into place once every command has run.
const stagingRoot = mkdtempSync(join(tmpdir(), `patrick-release-evidence-${options.release}-`));
const versions = versionContext();
const tasks = Object.keys(releaseEvidencePlan)
  .filter((task) => options.only.length === 0 || options.only.includes(task))
  .sort();

mkdirSync(join(stagingRoot, 'tasks'), { recursive: true });

const summary = { scenarios: 0, passed: 0, failed: 0, blocked: 0, pending: 0 };
const collectedTasks = [];

for (const task of tasks) {
  const entry = releaseEvidencePlan[task];
  const scenarios = [];
  for (const scenario of entry.scenarios) {
    process.stdout.write(`${task}/${scenario.id} … `);
    const blocked = evaluatePrecondition(scenario.blockedBy);
    const pending = !blocked && evaluatePrecondition(scenario.pendingBy);
    const skip = pending && scenario.skipWhenPending;
    const run = skip
      ? { exitCode: -1, output: scenario.pendingReason ?? 'observation not supplied', durationMs: 0 }
      : runCommand(scenario.command);
    const failed = !skip && run.exitCode !== 0;
    const status = failed ? 'failed' : blocked ? 'blocked' : pending ? 'pending' : 'passed';
    summary.scenarios += 1;
    summary[status] += 1;

    const evidenceFile = join('evidence', task, `${scenario.id}.log`);
    mkdirSync(dirname(join(stagingRoot, evidenceFile)), { recursive: true });
    writeFileSync(join(stagingRoot, evidenceFile), run.output);

    const record = {
      id: scenario.id,
      command: scenario.command,
      kind: scenario.kind,
      exitCode: run.exitCode,
      status,
      versions,
      evidenceFile,
      evidenceSha256: sha256(run.output),
      durationMs: run.durationMs,
    };
    if (scenario.note) record.note = scenario.note;
    if (status === 'blocked') record.blockedReason = scenario.blockedReason ?? 'prerequisite missing';
    if (status === 'pending') record.pendingReason = scenario.pendingReason ?? 'observation not supplied';
    scenarios.push(record);
    process.stdout.write(`${status} (exit ${run.exitCode})\n`);
  }
  const clauses = productCoverage.filter((entry) => entry.tasks.includes(task)).map((entry) => entry.id);
  writeFileSync(join(stagingRoot, 'tasks', `${task}.json`), `${JSON.stringify({
    task,
    completedAt: new Date().toISOString(),
    productClauses: clauses,
    scenarios,
  }, null, 2)}\n`);
  collectedTasks.push(task);
}

writeFileSync(join(stagingRoot, 'manifest.json'), `${JSON.stringify({
  release: options.release,
  generatedAt: new Date().toISOString(),
  versions,
  environment: {
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    host: sha256(process.env.HOSTNAME ?? ''),
  },
  tasks: collectedTasks,
  productCoverage,
  summary,
  note: '缺真实能力时标blocked而非passed；豁免与失败保留在本清单中。',
}, null, 2)}\n`);

rmSync(evidenceRoot, { recursive: true, force: true });
mkdirSync(dirname(evidenceRoot), { recursive: true });
try {
  renameSync(stagingRoot, evidenceRoot);
} catch (error) {
  if (error?.code !== 'EXDEV') throw error;
  cpSync(stagingRoot, evidenceRoot, { recursive: true });
  rmSync(stagingRoot, { recursive: true, force: true });
}
console.log(`\nwrote ${collectedTasks.length} task report(s) to release-evidence/${options.release}`);
console.log(`passed ${summary.passed} · failed ${summary.failed} · blocked ${summary.blocked} · pending ${summary.pending}`);
