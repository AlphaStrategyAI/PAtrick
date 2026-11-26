import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoloopHub } from '../deploy/lib/deployment-templates.mjs';
import { canonicalize, sha256 } from '../deploy/lib/release.mjs';
import { inspectEmittedRuntimeMaterial, prepareEmittedRuntimeCandidate } from './pack-runtime.mjs';

const scenarioScript = realpathSync(fileURLToPath(new URL('./runtime-execution-scenario.mjs', import.meta.url)));
const sourceRoot = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const inventoryName = 'metadata/runtime-materials.json';
const scenarioIds = ['relocated-node-import', 'service-cli-drain', 'sqlite-migrate-reopen', 'worker-role-readback'];
const entries = ['runtime/cli.mjs', 'runtime/composition.mjs', 'runtime/service.mjs', 'runtime/worker.mjs'];
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

function observe(path) {
  const physicalPath = realpathSync(path);
  const bytes = readFileSync(physicalPath);
  return { path: physicalPath, sha256: sha256(bytes), bytes: bytes.length };
}

function observePackage(path) {
  return { ...observe(path), version: readJson(path).version };
}

function command(path, args) {
  return execFileSync(path, args, { cwd: sourceRoot, encoding: 'utf8', timeout: 5000 }).trim();
}

function write(path, bytes) {
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o644 });
}

const [work, artifactRoot, repeatRoot, sourceCandidate] = process.argv.slice(2).map(path => realpathSync(path));
const manifest = readJson(sourceCandidate).manifest;
const inventoryPath = join(artifactRoot, inventoryName);
const inventory = readJson(inventoryPath);
const observed = inventory.observed;
assert.equal(inventory.profile, 'deployment-complete');
assert.equal(inventory.source.commit, manifest.commit);
assert.deepEqual(manifest.target, { os: process.platform, arch: process.arch });
assert.equal(observed.node, process.version);
assert.equal(observed.modules, process.versions.modules);
assert.equal(observed.platform, 'darwin');
assert.equal(observed.arch, process.arch);
assert.equal(command('/usr/bin/uname', ['-m']), process.arch === 'arm64' ? 'arm64' : 'x86_64');
const translation = spawnSync('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'], { encoding: 'utf8', timeout: 5000 });
assert.equal((translation.stdout ?? '').trim() || '0', '0');

const firstInventory = observe(inventoryPath);
const repeatInventory = observe(join(repeatRoot, inventoryName));
assert.notEqual(firstInventory.path, repeatInventory.path);
assert.equal(firstInventory.sha256, repeatInventory.sha256);
const totals = {};
for (const row of inventory.files) {
  totals[row.role] ??= { files: 0, bytes: 0 };
  totals[row.role].files++;
  totals[row.role].bytes += row.bytes;
}
const nodeRequire = createRequire(join(sourceRoot, 'package.json'));
const vitePath = createRequire(join(sourceRoot, 'apps/web/package.json')).resolve('vite/package.json');
const viteRequire = createRequire(vitePath);
const npmPath = command('/usr/bin/which', ['npm']);
const nativePath = join(artifactRoot, inventory.native.path);
const toolchain = {
  observed, source: inventory.source, node: observe(process.execPath),
  npm: { ...observe(npmPath), version: command(process.execPath, [realpathSync(npmPath), '--version']) },
  git: { path: '/usr/bin/git', version: command('/usr/bin/git', ['--version']) },
  esbuild: observePackage(nodeRequire.resolve('esbuild/package.json')),
  esbuildBinary: observe(join(sourceRoot, `node_modules/@esbuild/darwin-${process.arch}/bin/esbuild`)),
  vite: observePackage(vitePath),
  viteEsbuild: observePackage(viteRequire.resolve('esbuild/package.json')),
  viteRollup: observePackage(viteRequire.resolve('rollup/package.json')),
  inventory: firstInventory, repeatInventory, totals,
  largestRecord: inventory.files.reduce((largest, row) => largest.bytes >= row.bytes ? largest : row),
  native: { ...inventory.native, fileMode: (statSync(nativePath).mode & 0o777).toString(8),
    binaryDescription: command('/usr/bin/file', ['-b', nativePath]) },
  packages: inventory.packages,
  packageFiles: inventory.files.filter(row => row.path.startsWith('node_modules/')),
  runtimeFiles: inventory.files.filter(row => row.path.startsWith('runtime/')),
};

process.umask(0o022);
const output = join(work, 'signing-input');
mkdirSync(output);
const dataRoot = mkdtempSync(join(work, 'execution-'));
const toolchainPath = join(output, 'toolchain.json');
const lockPath = join(output, 'package-lock.json');
write(toolchainPath, canonicalize(toolchain));
write(lockPath, readFileSync(join(sourceRoot, 'package-lock.json')));
const input = {
  profile: inventory.profile,
  artifactRoot,
  staging: { withExclusiveReadRoot: use => use(work) },
  version: manifest.version, target: manifest.target, schema: manifest.schema, expectedSource: inventory.source,
  expectedInventorySha256: firstInventory.sha256, lockPath, toolchain: observe(toolchainPath),
};
const material = await inspectEmittedRuntimeMaterial(input);
const scenarios = [];
const logs = [];
for (const id of scenarioIds) {
  const args = ['--permission', '--allow-addons', '--allow-net', `--allow-fs-read=${artifactRoot}/*`,
    `--allow-fs-read=${dataRoot}/*`, `--allow-fs-read=${scenarioScript}`, `--allow-fs-write=${dataRoot}/*`,
    scenarioScript, id, artifactRoot, material.materialSha256, sourceRoot, autoloopHub.commit];
  const startedUtc = new Date().toISOString();
  const result = spawnSync(process.execPath, args, { cwd: dataRoot, env: {}, timeout: 30_000, encoding: 'utf8' });
  const endedUtc = new Date().toISOString();
  assert.equal(result.status, 0, `${id}: ${result.error ?? result.stderr}`);
  const observation = JSON.parse(result.stdout);
  assert.equal(observation.id, id);
  assert.equal(observation.materialSha256, material.materialSha256);
  assert.equal(observation.inventorySha256, material.inventorySha256);
  assert.equal(observation.nativeSha256, inventory.native.sha256);
  assert.equal(observation.arch, process.arch);
  const path = join(output, `${id}.log`);
  write(path, result.stdout);
  const log = observe(path);
  logs.push({ id, ...log });
  scenarios.push({ id, argv: [process.execPath, ...args], cwd: dataRoot, startedUtc, endedUtc,
    status: 'passed', exitCode: 0, evidenceSha256: log.sha256 });
}
const reportPath = join(output, 'execution-report.json');
write(reportPath, canonicalize({
  format: 'patrick-emitted-runtime-execution-v1', materialSha256: material.materialSha256,
  inventorySha256: material.inventorySha256, toolchainSha256: material.toolchainSha256,
  nativeSha256: inventory.native.sha256, observed, native: inventory.native, entries, scenarios,
}));
const report = observe(reportPath);
const prepared = await prepareEmittedRuntimeCandidate({ ...input, expectedMaterialSha256: material.materialSha256,
  evidence: { report, logs } });
write(join(output, 'signing-input.json'), canonicalize({
  format: 'patrick-runtime-signing-input-v1',
  version: input.version, source: input.expectedSource, target: input.target, schema: input.schema,
  materialSha256: prepared.materialSha256, inventorySha256: prepared.inventorySha256, manifestSha256: prepared.manifestSha256,
  toolchainSha256: material.toolchainSha256, executionReportSha256: report.sha256,
  requiredScenarios: logs.map(({ id, sha256: evidenceSha256 }) => ({ id, evidenceSha256 })),
}));
console.log(JSON.stringify({ sourceCommit: inventory.source.commit, target: input.target, manifestSha256: prepared.manifestSha256 }));
