import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { releaseEvidencePlan } from './release-evidence-plan.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJson(path, label) {
  if (!existsSync(path)) fail(`missing ${label}: ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`invalid JSON for ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const args = process.argv.slice(2);
const strict = args[0] === '--require-complete';
const commit = strict ? args[1] : undefined;
const root = strict ? args[2] : args[0];
if (args.length !== (strict ? 3 : 1) || !root || root.startsWith('-') ||
  (strict && !/^[0-9a-f]{40}$/.test(commit ?? ''))) {
  fail('usage: node scripts/check-release-evidence.mjs [--require-complete <candidate-commit>] <release-evidence-dir>');
}

const manifest = readJson(join(root, 'manifest.json'), 'manifest');
if (!manifest || typeof manifest !== 'object') fail('manifest must be an object');
if (!manifest.versions || typeof manifest.versions !== 'object') fail('manifest.versions is required');
if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) fail('manifest.tasks is required');

const incomplete = [];
const tasks = new Set();
if (strict && manifest.versions.code !== commit) incomplete.push('manifest: candidate commit mismatch');
let checked = 0;
for (const taskId of manifest.tasks) {
  if (typeof taskId !== 'string' || !/^T\d{2}$/.test(taskId)) fail(`invalid task id: ${taskId}`);
  if (strict && tasks.has(taskId)) fail(`duplicate release task ${taskId}`);
  tasks.add(taskId);
  const seen = new Set();
  const report = readJson(join(root, 'tasks', `${taskId}.json`), `task ${taskId}`);
  if (report.task !== taskId) fail(`task file ${taskId} has task=${report.task}`);
  if (!Array.isArray(report.scenarios)) fail(`task ${taskId} is missing scenarios`);
  for (const scenario of report.scenarios) {
    const label = `${taskId}/${scenario?.id ?? '<missing-id>'}`;
    if (!scenario || typeof scenario !== 'object') fail(`invalid scenario in ${taskId}`);
    if (typeof scenario.id !== 'string' || scenario.id.length === 0) fail(`scenario id missing in ${taskId}`);
    if (typeof scenario.command !== 'string' || scenario.command.length === 0) fail(`${label} is missing command`);
    if (typeof scenario.exitCode !== 'number' || !Number.isInteger(scenario.exitCode)) {
      fail(`${label} is missing integer exitCode`);
    }
    if (!scenario.versions || typeof scenario.versions !== 'object' || Object.keys(scenario.versions).length === 0) {
      fail(`${label} is missing versions`);
    }
    if (!['passed', 'failed', 'blocked', 'pending'].includes(scenario.status)) {
      fail(`${label} has invalid status ${scenario.status}`);
    }
    if (strict) {
      if (seen.has(scenario.id)) fail(`duplicate scenario ${label}`);
      seen.add(scenario.id);
      if (scenario.status !== 'passed') incomplete.push(`${label}: ${scenario.status}`);
      if (scenario.versions.code !== commit) incomplete.push(`${label}: candidate commit mismatch`);
    }
    if (scenario.status === 'passed') {
      if (scenario.exitCode !== 0) fail(`${label} passed with non-zero exitCode`);
      if (!scenario.evidenceFile || !scenario.evidenceSha256) {
        fail(`cannot mark scenario ${scenario.id} as passed without evidence`);
      }
      if (!/^[a-f0-9]{64}$/.test(scenario.evidenceSha256)) fail(`${label} evidenceSha256 is not sha256 hex`);
      const evidencePath = join(root, scenario.evidenceFile);
      if (!existsSync(evidencePath)) fail(`${label} missing evidence file ${scenario.evidenceFile}`);
      const actual = sha256(readFileSync(evidencePath));
      if (actual !== scenario.evidenceSha256) fail(`${label} evidence hash mismatch`);
    }
    checked += 1;
  }
  if (strict) {
    for (const { id } of releaseEvidencePlan[taskId]?.scenarios ?? []) {
      if (!seen.has(id)) incomplete.push(`missing release scenario ${taskId}/${id}`);
    }
  }
}

if (strict) {
  for (const id of Object.keys(releaseEvidencePlan)) {
    if (!tasks.has(id)) incomplete.push(`missing release task ${id}`);
  }
  if (incomplete.length) fail(incomplete.join('\n'));
}
console.log(`checked ${checked} scenario(s)${strict ? ` for candidate commit ${commit}` : ''}`);
