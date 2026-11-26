import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync } from 'node:fs';
import { chmod, chown, link, mkdir, open, opendir, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { admitReadRoot, canonicalize, readRegularFile, RELEASE_LIMITS as limits, sha256, validatePaths } from './release.mjs';

import { autoloopHub, hasAutoloopHub, checkDeploymentRecord, deploymentPaths, deploymentRole, releaseProfile, nativeProfile, completeProfile, servicePreflight,
  inventoryVersion, directoryPath, directoryRole, directoryIdentity, checkDirectoryTarget, checkDirectoryAuthority, directoryExports,
  directoryCommands, nativeSources, directoryHandshake } from './deployment-templates.mjs';

export const paths = Object.freeze({
  inventory: 'metadata/runtime-materials.json', lock: 'provenance/package-lock.json',
  toolchain: 'provenance/toolchain-observed.json', sbom: 'provenance/runtime-sbom.json', report: 'evidence/runtime-execution.json',
});
const entryNames = ['cli', 'composition', 'service', 'worker'];
const entries = entryNames.map(name => 'runtime/' + name + '.mjs');
const baseline = ['relocated-node-import', 'service-cli-drain', 'sqlite-migrate-reopen', 'worker-role-readback'];
const addon = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';
const semver = /^\d+\.\d+\.\d+$/;
const verified = new WeakMap();
const staged = new WeakMap();
const activeLeases = new WeakMap();
const derivedPorts = new WeakMap();
const installedOwners = new WeakMap();
const leaseCallbacks = new WeakMap();
const unresolvedWrites = new WeakMap();
const own = Object.hasOwn;
export function check(value, message) { if (!value) throw new Error(message); }
export const encode = value => Buffer.from(canonicalize(value));
const equal = (left, right, message) => check(canonicalize(left) === canonicalize(right), message);
const isHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const uint = value => Number.isSafeInteger(value) && value >= 0;
const scenarioId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(id);
const json = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
function shape(value, names, label) {
  check(value && Object.getPrototypeOf(value) === Object.prototype, 'invalid ' + label);
  equal(Object.keys(value).sort(), names.split(' ').sort(), 'invalid ' + label + ' fields');
}
export function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export function descriptor(path, role, mode, data) { return { path, role, mode, bytes: data.length, sha256: sha256(data) }; }
export function ordered(records) { return [...records].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); }
function table(records) {
  check(Array.isArray(records) && records.length && records.length <= limits.files, 'material count limit');
  const prefixes = new Map();
  let sum = 0;
  for (const r of records) {
    shape(r, 'path role mode bytes sha256', 'descriptor');
    check(uint(r.bytes) && r.bytes <= limits.artifactBytes && (sum += r.bytes) <= limits.totalBytes, 'material byte limit');
    check(typeof r.path === 'string' && r.path.length <= 512 && r.path.split('/').length <= limits.evidenceDepth, 'material path limit');
    check(['100644', '100755'].includes(r.mode) && isHash(r.sha256) && typeof r.role === 'string', 'invalid descriptor');
    for (let dir = dirname(r.path); dir !== '.' && dir !== '/'; dir = dirname(dir)) {
      const folded = dir.toLowerCase();
      check(!prefixes.has(folded) || prefixes.get(folded) === dir, 'ambiguous directory spelling');
      prefixes.set(folded, dir);
    }
  }
  validatePaths(records.map(r => r.path));
}
const versions = { 'better-sqlite3': '12.11.1', bindings: '1.5.0', 'file-uri-to-path': '1.0.0' };
const mains = { 'better-sqlite3': 'lib/index.js', bindings: './bindings.js', 'file-uri-to-path': 'index.js' };
const dependencies = { 'better-sqlite3': { bindings: '^1.5.0', 'prebuild-install': '^7.1.1' }, bindings: { 'file-uri-to-path': '1.0.0' }, 'file-uri-to-path': {} };
const closure = new Map();
for (const pkg of Object.keys(versions)) {
  const prefix = 'node_modules/' + pkg + '/';
  closure.set(prefix + 'package.json', 'runtime-package-metadata');
  closure.set(prefix + (pkg === 'bindings' ? 'LICENSE.md' : 'LICENSE'), 'runtime-package-license');
}
for (const name of ['database', 'index', 'sqlite-error', 'util', ...['aggregate','backup','function','inspect','pragma','serialize','table','transaction','wrappers'].map(n => 'methods/' + n)]) {
  closure.set('node_modules/better-sqlite3/lib/' + name + '.js', 'runtime-package-code');
}
closure.set('node_modules/bindings/bindings.js', 'runtime-package-code');
closure.set('node_modules/file-uri-to-path/index.js', 'runtime-package-code');
closure.set(addon, 'native-addon');
const fixed = new Map([...closure, ...entries.map(path => [path, 'runtime-entry']), ['migrations/manifest.json', 'storage-migration-manifest'], ['web/index.html', 'web-entry']]);
function role(path, profile) {
  if (profile === nativeProfile && path === directoryPath) return directoryRole;
  if (completeProfile(profile) && deploymentRole(path)) return deploymentRole(path);
  if (fixed.has(path)) return fixed.get(path);
  if (/^runtime\/chunk-[A-Z0-9]+\.mjs$/.test(path)) return 'runtime-shared-chunk';
  if (/^migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(path)) return 'storage-migration';
  if (/^web\/(?:assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2?)|fonts\/[A-Za-z0-9_./-]+\.(?:woff2?|txt))$/.test(path)) return 'web-asset';
  throw new Error('unsupported runtime path ' + path);
}
function materialGraph(files, rows) {
  const byRole = name => rows.filter(row => row.role === name);
  for (const path of fixed.keys()) check(files.has(path), 'missing runtime material ' + path);
  const chunks = byRole('runtime-shared-chunk');
  check(chunks.length === 1, 'expected one shared runtime graph');
  for (const path of entries) {
    // The v1 esbuild wrappers have named static imports and import.meta.url.
    // Refuse unrecognized module-edge syntax instead of evaluating the wrapper.
    const imports = [];
    const body = files.get(path).toString('utf8').replace(/^import \{[\w\s,$]*\} from "([^"\n]+)";$/gm, (_text, specifier) => {
      imports.push(specifier);
      return '';
    });
    check(!/\b(?:import|require|from)\b/.test(body.replaceAll('import.meta.url', '')), 'unsupported runtime entry graph');
    const locals = imports.filter(name => !/^node:(?:crypto|fs|fs\/promises|http|path|stream|stream\/promises|url)$/.test(name));
    equal(locals, ['./' + chunks[0].path.slice('runtime/'.length)], 'runtime entry graph mismatch');
  }
  const migrations = json(files.get('migrations/manifest.json'));
  check(Array.isArray(migrations) && migrations.length > 0 && migrations.length <= 128, 'invalid migration manifest');
  migrations.forEach(row => shape(row, 'file sha256', 'migration'));
  equal(migrations, byRole('storage-migration').map(r => ({ file: r.path.slice('migrations/'.length), sha256: r.sha256 })), 'migration manifest mismatch');
  const refs = [...files.get('web/index.html').toString('utf8').matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
  check(refs.some(p => p.endsWith('.js')) && refs.some(p => p.endsWith('.css')) &&
    refs.every(p => /^\/assets\/[A-Za-z0-9_.-]+$/.test(p) && files.has('web' + p)), 'web entry references missing assets');
  for (const stylesheet of refs.filter(p => p.endsWith('.css'))) {
    const css = files.get('web' + stylesheet).toString('utf8');
    for (const match of css.matchAll(/url\(\s*["']?([^)"'\s]+)["']?\s*\)/gi)) {
      const ref = match[1];
      if (/^data:font\/woff2?;base64,[A-Za-z0-9+/]+=*$/.test(ref)) continue;
      check(/^\/(?:assets|fonts)\/[A-Za-z0-9_.-]+$/.test(ref) && files.has('web' + ref), 'missing or unsupported CSS asset');
    }
  }
}
function checkDirectoryBuild(t, inventory, inventoryBytes, target) {
  const b = t.directoryBuild;
  shape(b, 'authority authoritySha256 buildHost sources commands objects exportLogSha256 output', 'directory build');
  // Use the signed build observation and independent output target. The
  // machine performing this byte-only check may differ from the builder.
  checkDirectoryAuthority(b.authority, target, b.buildHost);
  check(b.buildHost.os === inventory.observed.platform && b.buildHost.processArch === inventory.observed.arch, 'directory build host mismatch');
  check(b.authoritySha256 === sha256(encode(b.authority)) && inventory.directoryBuildSha256 === sha256(encode(b)), 'directory build identity mismatch');
  equal(t.repeatDirectoryBuild, b, 'repeat directory build mismatch');
  check(t.inventory.path !== t.repeatInventory.path && t.repeatInventory.sha256 === sha256(inventoryBytes), 'distinct repeat inventory required');
  equal(t.directoryNative, inventory.directoryNative, 'toolchain directory observation');
  equal(b.output, inventory.directoryNative, 'directory build output mismatch');
  equal(b.commands, directoryCommands(target.arch), 'directory recipe arguments');
  equal(b.authority.sqliteObservation.native, inventory.native, 'independent SQLite observation mismatch');
  check(b.authority.tools.node === t.node.sha256 && b.authority.sqliteObservation.source.lockSha256 === inventory.source.lockSha256 &&
    b.authority.sqliteObservation.packageFilesSha256 === sha256(encode(t.packageFiles)), 'independent directory toolchain/SQLite mismatch');
  check(b.exportLogSha256 === sha256(directoryExports.join('\n') + '\n'), 'directory export observation');
  equal(b.sources.map(row => row.path), nativeSources, 'directory build source list');
  equal(b.objects.map(row => row.path), ['directory-module.o','directory-core.o'], 'directory link inputs');
  for (const row of b.sources) {
    shape(row, 'path mode sha256 bytes', 'directory source');
    check(row.mode === '100644' && isHash(row.sha256) && uint(row.bytes) && row.bytes > 0, 'directory source identity');
  }
  for (const row of b.objects) {
    shape(row, 'path sha256 bytes', 'directory object');
    check(isHash(row.sha256) && uint(row.bytes) && row.bytes > 0, 'directory object identity');
  }
  return b;
}

function checkToolchain(raw, inventory, inventoryBytes, lock, target) {
  const t = json(raw);
  shape(t, 'observed node npm git esbuild esbuildBinary vite viteEsbuild viteRollup source inventory repeatInventory totals largestRecord native packages packageFiles runtimeFiles' +
    (inventory.profile === nativeProfile ? ' directoryBuild repeatDirectoryBuild directoryNative' : ''), 'toolchain');
  for (const key of ['observed', 'source', 'packages']) equal(t[key], inventory[key], 'toolchain ' + key + ' mismatch');
  const totals = {};
  for (const row of inventory.files) {
    totals[row.role] ??= { files: 0, bytes: 0 };
    totals[row.role].files++;
    totals[row.role].bytes += row.bytes;
  }
  equal(t.totals, totals, 'toolchain role totals');
  equal(t.largestRecord, inventory.files.reduce((a,b) => a.bytes >= b.bytes ? a : b), 'toolchain largest material');
  for (const [key, prefix] of [['packageFiles','node_modules/'],['runtimeFiles','runtime/']]) {
    equal(t[key], inventory.files.filter(f => f.path.startsWith(prefix)), 'toolchain material subset');
  }
  const toolVersions = { npm: inventory.observed.npm, esbuild: inventory.tools.esbuild, vite: inventory.tools.vite,
    viteEsbuild: lock.packages['apps/web/node_modules/vite/node_modules/esbuild']?.version ?? lock.packages['node_modules/esbuild']?.version,
    viteRollup: lock.packages['apps/web/node_modules/vite/node_modules/rollup']?.version ?? lock.packages['node_modules/rollup']?.version };
  for (const key of ['node','esbuildBinary','inventory','repeatInventory', ...Object.keys(toolVersions)]) {
    const item = t[key];
    shape(item, own(toolVersions, key) ? 'path sha256 bytes version' : 'path sha256 bytes', 'measured tool');
    check(typeof item.path === 'string' && item.path.length <= 4096 && isAbsolute(item.path) && isHash(item.sha256) && uint(item.bytes) && item.bytes > 0, 'invalid measured tool');
    if (own(toolVersions, key)) check(typeof item.version === 'string' && item.version === toolVersions[key], 'tool version mismatch');
    if (key === 'inventory' || key === 'repeatInventory') check(item.sha256 === sha256(inventoryBytes) && item.bytes === inventoryBytes.length, 'toolchain inventory mismatch');
  }
  shape(t.git, 'path version', 'git observation');
  check(typeof t.git.path === 'string' && isAbsolute(t.git.path) && /^git version \d+\.\d+/.test(t.git.version), 'invalid git observation');
  const { fileMode, binaryDescription, ...native } = t.native;
  equal(native, inventory.native, 'toolchain native observation');
  const archName = inventory.observed.arch === 'arm64' ? 'arm64' : 'x86_64';
  check(fileMode === '755' && typeof binaryDescription === 'string' && binaryDescription.includes('Mach-O') && binaryDescription.includes(archName), 'native tool observation');
  if (inventory.profile === nativeProfile) return checkDirectoryBuild(t, inventory, inventoryBytes, target);
}
function makeSbom(files, inventory, lock, version, directoryBuild) {
  check(lock.lockfileVersion === 3 && lock.version === version && lock.packages['']?.version === version && lock.name === 'patrick' && lock.packages[''].name === 'patrick', 'lock release mismatch');
  const packages = inventory.packages.map(({ name, version }) => {
    const prefix = 'node_modules/' + name;
    const installed = json(files.get(prefix + '/package.json'));
    const record = lock.packages[prefix];
    check(installed.name === name && installed.version === version && installed.main === mains[name] && record?.version === version &&
      record.integrity?.startsWith('sha512-') && typeof record.resolved === 'string', 'package closure mismatch');
    equal(record.dependencies ?? {}, dependencies[name], 'lock dependency edges');
    equal(installed.dependencies ?? {}, dependencies[name], 'installed dependency edges');
    return { name, version, integrity: record.integrity, resolved: record.resolved, dependencies: Object.keys(dependencies[name]).filter(n => own(versions,n)),
      files: inventory.files.filter(r => r.path.startsWith(prefix + '/')) };
  });
  const hubFiles = inventory.files.filter(row => row.role === 'autoloop-hub-source');
  return encode({
    format: directoryBuild || hubFiles.length ? 'patrick-emitted-runtime-sbom-v2' : 'patrick-emitted-runtime-sbom-v1',
    packages,
    ...(directoryBuild && { firstParty: [{ name: 'patrick-directory-module', source: inventory.source, sources: directoryBuild.sources,
      material: inventory.files.find(row => row.path === directoryPath) }] }),
    ...(hubFiles.length && { thirdPartySources: [{ name: 'agent-autoloop', commit: autoloopHub.commit, files: hubFiles }] }),
  });
}

// Pure validation shared by the packer and the independently trusted host verifier.
export function inspectBytes(files, { version, source, target, schema, inventorySha256, toolchainSha256, profile: selection }) {
  const profile = releaseProfile(selection);
  const complete = completeProfile(profile);
  const v3 = profile === nativeProfile;
  const raw = files.get(paths.inventory);
  check(raw && sha256(raw) === inventorySha256, 'inventory digest mismatch');
  const inv = json(raw);
  shape(inv, 'schemaVersion materialKind source tools observed packages native files' + (complete ? ' profile' : '') +
    (v3 ? ' directoryNative directoryBuildSha256' : ''), 'inventory');
  check(inv.schemaVersion === inventoryVersion(profile) && (!complete || inv.profile === profile) && inv.materialKind === 'emitted-runtime-materials', 'unsupported inventory');
  shape(inv.source, 'kind commit snapshotSha256 lockSha256', 'source');
  check(['commit','pinned-snapshot'].includes(inv.source.kind) && typeof inv.source.commit === 'string' && /^[0-9a-f]{40}$/.test(inv.source.commit) &&
    isHash(inv.source.snapshotSha256) && isHash(inv.source.lockSha256), 'invalid source identity');
  equal(inv.source, source, 'source mismatch');
  shape(target, 'os arch', 'target');
  if (v3) checkDirectoryTarget(target);
  shape(schema, 'min max', 'schema interval');
  check(typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) && uint(schema.min) && uint(schema.max) && schema.max >= schema.min, 'invalid release/schema');
  shape(inv.observed, 'platform arch node modules npm' + (v3 ? ' napi' : ''), 'runtime observation');
  if (v3) check(inv.observed.node === 'v26.13.0' && inv.observed.modules === '147' && inv.observed.napi === '10', 'directory runtime mismatch');
  const { platform, arch, node, modules, npm } = inv.observed;
  check(platform === 'darwin' && target.os === platform && ['arm64','x64'].includes(arch) && target.arch === arch &&
    typeof node === 'string' && /^v\d+\.\d+\.\d+$/.test(node) && typeof modules === 'string' && /^\d+$/.test(modules) && typeof npm === 'string' && semver.test(npm), 'target/runtime mismatch');
  equal(inv.tools, { esbuild: '0.28.2', vite: '7.3.8' }, 'unsupported build tools');
  equal(inv.packages, Object.entries(versions).map(([name, version]) => ({ name, version })), 'unsupported package closure');
  table(inv.files);
  hasAutoloopHub(inv.files.map(row => row.path));
  if (complete) {
    const materialPaths = new Set(inv.files.map(row => row.path));
    if (v3) check(materialPaths.has(addon) && materialPaths.has(directoryPath), 'missing native material');
    for (const path of Object.values(deploymentPaths)) check(materialPaths.has(path), 'missing deployment template ' + path);
  }
  for (const r of inv.files) {
    checkDeploymentRecord(profile, r.path, r.mode, r.sha256);
    check(r.role === role(r.path, profile) && r.mode === ((r.path === addon || (v3 && r.path === directoryPath)) ? '100755' : '100644'), 'material role/mode mismatch ' + r.path);
    const data = files.get(r.path);
    check(data && data.length === r.bytes && sha256(data) === r.sha256, 'runtime material mismatch ' + r.path);
  }
  materialGraph(files, inv.files);
  const native = inv.native;
  shape(native, 'path sha256 bytes format architecture observedArchitecture observedNode observedModules observedLoad sqlite', 'native');
  const binary = files.get(addon);
  check(native.path === addon && native.format === 'mach-o' && binary.length >= 32 && binary.readUInt32LE(0) === 0xfeedfacf &&
    binary.readUInt32LE(4) === (arch === 'arm64' ? 0x0100000c : 0x01000007) && native.architecture === arch && native.observedArchitecture === arch &&
    native.observedNode === node && native.observedModules === modules && native.observedLoad === true && typeof native.sqlite === 'string' && semver.test(native.sqlite) &&
    native.bytes === binary.length && native.sha256 === sha256(binary), 'native binary/ABI mismatch');
  if (v3) equal(inv.directoryNative, directoryIdentity(files.get(directoryPath), arch), 'directory native identity mismatch');
  const lockBytes = files.get(paths.lock);
  const toolBytes = files.get(paths.toolchain);
  check(sha256(lockBytes) === source.lockSha256 && sha256(toolBytes) === toolchainSha256, 'provenance digest mismatch');
  const lock = json(lockBytes);
  const directoryBuild = checkToolchain(toolBytes, inv, raw, lock, target);
  const sbom = makeSbom(files, inv, lock, version, directoryBuild);
  const materials = ordered([...inv.files, descriptor(paths.inventory, 'runtime-inventory', '100644', raw)]);
  table(materials);
  const identity = { ...(complete ? { format: 'patrick-emitted-runtime-material-identity-v' + inventoryVersion(profile), profile } :
    { format: 'patrick-emitted-runtime-material-identity-v1' }), version, source: inv.source, target, schema,
    runtime: { node, modules, npm, native, ...(v3 && { napi: inv.observed.napi, directoryNative: inv.directoryNative }) },
    ...(v3 && { directoryAuthoritySha256: directoryBuild.authoritySha256 }), toolchainSha256, inventorySha256, sbomSha256: sha256(sbom), materials };
  return { identity, materialSha256: sha256(encode(identity)), sbom };
}
export const logPath = id => { check(scenarioId(id), 'invalid scenario id'); return 'evidence/logs/' + id + '.log'; };
export function inspectEvidence(files, identity, materialSha256, policy) {
  const reportBytes = files.get(paths.report);
  check(reportBytes && sha256(reportBytes) === policy.executionReportSha256, 'execution report pin mismatch');
  const report = json(reportBytes);
  const v3 = identity.profile === nativeProfile;
  shape(report, 'format materialSha256 inventorySha256 toolchainSha256 nativeSha256 observed native entries scenarios' +
    (v3 ? ' directoryNative directoryHandshake' : ''), 'execution report');
  const { runtime, target } = identity;
  check(report.format === (v3 ? 'patrick-emitted-runtime-execution-v2' : 'patrick-emitted-runtime-execution-v1') && report.materialSha256 === materialSha256 && report.inventorySha256 === identity.inventorySha256 &&
    report.toolchainSha256 === identity.toolchainSha256 && report.nativeSha256 === runtime.native.sha256, 'execution material binding mismatch');
  equal(report.observed, { platform: target.os, arch: target.arch, node: runtime.node, modules: runtime.modules, npm: runtime.npm,
    ...(v3 && { napi: runtime.napi }) }, 'execution runtime mismatch');
  if (v3) {
    equal(report.directoryNative, runtime.directoryNative, 'execution directory material mismatch');
    equal(report.directoryHandshake, directoryHandshake, 'directory handshake mismatch');
  }
  equal(report.native, runtime.native, 'execution native mismatch');
  equal(report.entries, entries, 'execution entry mismatch');
  const requirements = policy.requiredScenarios;
  check(Array.isArray(requirements) && requirements.length >= baseline.length && requirements.length <= limits.files, 'required scenarios missing');
  const required = new Map();
  for (const r of requirements) {
    shape(r, 'id evidenceSha256', 'scenario requirement');
    check(scenarioId(r.id) && isHash(r.evidenceSha256) && !required.has(r.id), 'invalid or duplicate required scenario');
    required.set(r.id, r.evidenceSha256);
  }
  const mandatory = v3 ? [...baseline, 'directory-module-info-relocated'] : baseline;
  check(mandatory.every(id => required.has(id)) && Array.isArray(report.scenarios) && report.scenarios.length === required.size, 'required scenario set mismatch');
  const logs = [];
  for (const s of report.scenarios) {
    shape(s, 'id argv cwd startedUtc endedUtc status exitCode evidenceSha256', 'scenario');
    const path = logPath(s.id);
    const data = files.get(path);
    check(data?.length && required.has(s.id) && s.evidenceSha256 === required.get(s.id) && sha256(data) === s.evidenceSha256, 'scenario log mismatch');
    check(s.status === 'passed' && s.exitCode === 0 && Array.isArray(s.argv) && s.argv.length > 0 && s.argv.length <= 128 &&
      s.argv.every(a => typeof a === 'string' && a.length <= 8192) && typeof s.cwd === 'string' && isAbsolute(s.cwd) &&
      typeof s.startedUtc === 'string' && typeof s.endedUtc === 'string' && new Date(s.startedUtc).toISOString() === s.startedUtc &&
      new Date(s.endedUtc).toISOString() === s.endedUtc && s.startedUtc <= s.endedUtc, 'invalid execution metadata');
    required.delete(s.id);
    logs.push(descriptor(path, 'execution-log', '100644', data));
  }
  return logs;
}
export function artifactTable(files, identity, logs) {
  const sidecars = [[paths.lock, 'source-lock'], [paths.toolchain, 'toolchain-observation'], [paths.sbom, 'runtime-sbom'], [paths.report, 'execution-report']];
  const records = ordered([...identity.materials, ...sidecars.map(([path,role]) => descriptor(path,role,'100644',files.get(path))), ...logs]);
  table(records);
  check(records.length === files.size && records.every(r => files.has(r.path)), 'unexpected or missing material');
  return records;
}

const stat = path => lstatSync(path, { bigint: true });
function physical(info) { return [info.dev, info.ino, info.mode, info.uid, info.gid].join('/'); }
function stable(info) { return [physical(info), info.ctimeNs, info.mtimeNs, info.size, info.nlink].join('/'); }
function requireOwnedDirectory(info) {
  check(info.isDirectory() && info.uid === BigInt(process.geteuid()) && (info.mode & 0o022n) === 0n, 'directory ownership or permissions changed');
}
function ancestry(path, ownerRoot) {
  check(typeof path === 'string' && isAbsolute(path) && path === resolve(path), 'physical absolute path required');
  const parts = path.split(sep).filter(Boolean);
  const result = new Map();
  let current = sep;
  for (const part of ['', ...parts]) {
    current = join(current, part);
    const info = stat(current);
    check(info.isDirectory(), 'invalid physical ancestor');
    if (ownerRoot === sep || current === ownerRoot || current.startsWith(ownerRoot + sep)) requireOwnedDirectory(info);
    result.set(current, physical(info));
  }
  return result;
}
function recheck(capture, fingerprint = physical) {
  for (const [path, identity] of capture) check(fingerprint(stat(path)) === identity, 'physical identity changed ' + path);
}
export function inside(root, path) {
  check(typeof path === 'string' && resolve(path) === path, 'absolute normalized path required');
  const local = relative(root, path);
  check(local && !isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep), 'path outside staging root');
  return path;
}

export function createInstalledRootOwner(registration) {
  shape(registration, 'root rootNode lockNode', 'installed root owner');
  const { root } = registration;
  const pin = (value) => {
    shape(value, 'device inode birthtimeNs', 'installed node');
    check(Object.values(value).every(part => typeof part === 'string' && /^\d{1,32}$/.test(part)), 'INSTALLED_ROOT_OWNER_INVALID');
    return Object.freeze({ ...value });
  };
  const rootNode = pin(registration.rootNode);
  const lockNode = pin(registration.lockNode);
  check(root !== sep && realpathSync.native(root) === root, 'INSTALLED_ROOT_OWNER_INVALID');
  const directory = root + '.owner';
  const lockPath = join(directory, 'lease.sqlite');
  const rootTree = ancestry(root, root);
  const lockTree = ancestry(directory, directory);
  const uid = BigInt(process.geteuid());
  const matches = (info, expected) => String(info.dev) === expected.device && String(info.ino) === expected.inode &&
    String(info.birthtimeNs) === expected.birthtimeNs;
  function validate() {
    try {
      recheck(rootTree);
      recheck(lockTree);
      const info = stat(lockPath);
      check(matches(stat(root), rootNode) && (stat(directory).mode & 0o7777n) === 0o700n &&
        matches(info, lockNode) && info.isFile() && info.nlink === 1n && info.uid === uid &&
        (info.mode & 0o7777n) === 0o600n, 'invalid owner nodes');
    } catch (error) {
      throw new Error('INSTALLED_ROOT_OWNER_INVALID', { cause: error });
    }
  }
  validate();
  let current;
  const owner = Object.freeze({
    async withExclusiveReadRoot(read) {
      check(this === owner && leaseCallbacks.get(read) === owner, 'original installed lease callback required');
      validate();
      check(!current, 'INSTALLED_ROOT_OWNER_BUSY');
      const database = new DatabaseSync(lockPath, { timeout: 0 });
      try {
        validate();
        try { database.exec('BEGIN IMMEDIATE'); }
        catch (error) {
          if ([5, 6].includes(error?.errcode & 0xff)) throw new Error('INSTALLED_ROOT_OWNER_BUSY', { cause: error });
          throw error;
        }
        check(database.prepare('PRAGMA journal_mode').get()?.journal_mode === 'delete' &&
          database.prepare('PRAGMA user_version').get()?.user_version === 1, 'INSTALLED_ROOT_OWNER_INVALID');
        current = database;
        guard();
        const result = await read(root);
        guard();
        return result;
      } finally {
        if (current === database) current = undefined;
        database.close();
      }
    },
  });
  function guard() {
    check(current?.isTransaction, 'INSTALLED_ROOT_OWNER_INVALID');
    validate();
  }
  installedOwners.set(owner, guard);
  return owner;
}

/** A view can only narrow a currently held genuine lease. Every consumer must
 * pass this exact object so leased() can propagate the parent guard. */
export function deriveRuntimeStaging(parentLease, root, publication) {
  const parent = activeLeases.get(parentLease);
  check(parent, 'genuine parent lease required');
  parent.guard();
  check(typeof root === 'string' && resolve(root) === root && (root === parent.root || inside(parent.root, root)),
    'derived root outside parent');
  let registered;
  const roots = [root];
  if (publication !== undefined) {
    check(publication && [null, Object.prototype].includes(Object.getPrototypeOf(publication)) &&
      Reflect.ownKeys(publication).length === 2, 'invalid derived publication');
    const stage = Object.getOwnPropertyDescriptor(publication, 'stagingRoot');
    const releases = Object.getOwnPropertyDescriptor(publication, 'releasesRoot');
    check(stage && releases && own(stage, 'value') && own(releases, 'value'), 'invalid derived publication fields');
    const stagingRoot = inside(root, stage.value), releasesRoot = inside(root, releases.value);
    check(stagingRoot !== releasesRoot && !stagingRoot.startsWith(releasesRoot + sep) &&
      !releasesRoot.startsWith(stagingRoot + sep), 'overlapping derived publication roots');
    roots.push(stagingRoot, releasesRoot);
    registered = Object.freeze({ stagingRoot, releasesRoot });
  }
  const captures = roots.map(path => {
    check(realpathSync.native(path) === path, 'noncanonical derived root');
    const tree = ancestry(path, parent.root);
    const births = new Map([...tree.keys()].map(name => [name, stat(name).birthtimeNs]));
    return { path, tree, births };
  });
  let invalid = false;
  const guard = () => {
    check(!invalid, 'derived lease invalid');
    try {
      parent.guard();
      for (const capture of captures) {
        recheck(capture.tree);
        for (const [path, birth] of capture.births) check(stat(path).birthtimeNs === birth, 'derived root birth identity changed');
        check(realpathSync.native(capture.path) === capture.path, 'derived root changed');
      }
    } catch (error) { invalid = true; throw error; }
  };
  guard();
  const port = Object.freeze({ ...(registered ? { publication: registered } : {}),
    async withExclusiveReadRoot(read) {
      check(this === port && leaseCallbacks.get(read) === port, 'original derived lease callback required');
      guard();
      check(typeof read === 'function' && !parent.child, 'concurrent derived lease');
      const token = {};
      parent.child = token;
      try { const result = await read(root); guard(); return result; }
      finally { if (parent.child === token) parent.child = undefined; }
    },
  });
  derivedPorts.set(port, { guard, parent });
  return port;
}
// The independently registered host MUST exclude competing writers throughout this
// callback. Public path-based Node APIs cannot exclude a hostile swap-and-restore
// between two syscalls. Device/inode checks only detect observable exchanges.
function captureLeaseMethod(port) {
  check(port && (typeof port === 'object' || typeof port === 'function'), 'exclusive host staging required');
  const chain = [];
  let descriptor;
  for (let current = port; current; current = Object.getPrototypeOf(current)) {
    chain.push({ object: current, prototype: Object.getPrototypeOf(current) });
    descriptor = Object.getOwnPropertyDescriptor(current, 'withExclusiveReadRoot');
    if (descriptor) break;
  }
  check(descriptor && own(descriptor, 'value') && typeof descriptor.value === 'function', 'exclusive host staging required');
  const initial = descriptor;
  const value = initial.value;
  return { value, validate() {
    for (let index = 0; index < chain.length; index++) {
      const item = chain[index];
      check(Object.getPrototypeOf(item.object) === item.prototype, 'exclusive host staging changed');
      const current = Object.getOwnPropertyDescriptor(item.object, 'withExclusiveReadRoot');
      if (index < chain.length - 1) check(!current, 'exclusive host staging changed');
      else check(current && own(current, 'value') && Object.is(current.value, value) &&
        current.configurable === initial.configurable && current.enumerable === initial.enumerable &&
        current.writable === initial.writable, 'exclusive host staging changed');
    }
  } };
}
export async function leased(port, work, joinWork = false, validate) {
  const method = captureLeaseMethod(port);
  check(validate === undefined || typeof validate === 'function', 'invalid lease admission');
  const inherited = derivedPorts.get(port);
  let active = true;
  let calls = 0;
  let finished = false;
  let firstCall;
  let answer;
  const marker = Object.freeze({});
  let start;
  const starting = new Promise(resolve => { start = resolve; });
  function checkBinding() {
    inherited?.guard();
    method.validate();
    if (validate) {
      Reflect.apply(validate, undefined, []);
      method.validate();
      inherited?.guard();
    }
  }
  function valid() { check(active && calls === 1, 'exclusive lease callback violation'); checkBinding(); }
  let callback;
  try {
    callback = root => {
      calls++;
      const run = async () => {
        await starting;
        // Allow an immediately settled owner to be observed before starting work.
        await new Promise(resolve => setImmediate(resolve));
        valid();
        admitReadRoot(root).validate();
        const tree = ancestry(root, root);
        const state = { root, open: true, invalid: false, child: undefined, guard: undefined, scope: inherited?.parent.scope };
        state.scope ??= state;
        const guard = () => {
          check(!state.invalid, 'lease invalid');
          try { valid(); check(state.open, 'lease callback ended'); installedOwners.get(port)?.(); recheck(tree); }
          catch (error) { state.invalid = true; throw error; }
        };
        state.guard = guard;
        const lease = Object.freeze({ root, tree: new Map(tree), guard });
        activeLeases.set(lease, state);
        guard();
        try {
          answer = await work(lease);
          guard();
          check(!state.child, 'derived lease still active');
          finished = true;
          return marker;
        } finally { state.open = false; }
      };
      const promise = run();
      if (calls === 1) firstCall = promise;
      // A malformed adapter may discard this promise. The enclosing identity
      // check still refuses it and closes the guard on return.
      promise.catch(() => {});
      return promise;
    };
    leaseCallbacks.set(callback, port);
    checkBinding();
    const returned = Reflect.apply(method.value, port, [callback]);
    const observed = Promise.resolve(returned).then(result => {
      if (!finished) active = false;
      return result;
    }, error => { active = false; throw error; });
    start();
    const result = await observed;
    valid();
    check(finished && result === marker, 'exclusive lease callback incomplete or result substituted');
    return answer;
  } finally {
    active = false;
    if (callback) leaseCallbacks.delete(callback);
    start();
    // Complete in-flight system calls before reacquiring for write recovery.
    if (joinWork) await firstCall?.catch(() => {});
  }
}
function leaf(lease, path) {
  inside(lease.root, path);
  lease.guard();
  const tree = ancestry(dirname(path), lease.root);
  const info = stat(path);
  check(info.isFile() && info.nlink === 1n, 'expected singly linked regular file');
  check(info.uid === BigInt(process.geteuid()) && (info.mode & 0o022n) === 0n, 'file ownership or permissions changed');
  return { tree, leaseRoot: lease.root, identity: stable(info), info };
}
function checkLeaf(lease, path, binding) {
  lease.guard();
  check(lease.root === binding.leaseRoot, 'original physical lease root required');
  recheck(binding.tree);
  check(stable(stat(path)) === binding.identity, 'file identity changed ' + path);
}
export async function readLeased(lease, path, limit, budget) {
  const binding = leaf(lease, path);
  const size = Number(binding.info.size);
  check(uint(size) && size <= limit, 'file byte limit');
  if (budget) {
    budget.bytes += size;
    budget.files++;
    check(budget.bytes <= limits.totalBytes && budget.files <= limits.files, 'aggregate material limit');
  }
  checkLeaf(lease, path, binding);
  const data = await readRegularFile(path, limit, { root: lease.root, validate: lease.guard });
  checkLeaf(lease, path, binding);
  return { data, binding };
}
export async function readTree(lease, root, expected, budget = { bytes: 0, files: 0 }) {
  lease.guard();
  inside(lease.root, root);
  const boundary = ancestry(root, lease.root);
  const captures = new Map();
  const files = new Map();
  const modes = new Map();
  let count = 0;
  async function visit(path, local, depth) {
    check(++count <= limits.evidenceEntries && depth <= limits.evidenceDepth && local.length <= 512, 'runtime walk limit');
    lease.guard();
    const info = stat(path);
    const identity = stable(info);
    if (expected) check(expected.nodes.get(path) === identity, 'staged file/directory identity changed');
    captures.set(path, identity);
    if (info.isDirectory()) {
      requireOwnedDirectory(info);
      const dir = await opendir(path);
      let children = 0;
      try {
        for (;;) {
          lease.guard();
          const item = await dir.read();
          lease.guard();
          if (!item) break;
          children++;
          const child = local ? local + '/' + item.name : item.name;
          validatePaths([child]);
          await visit(join(path, item.name), child, depth + 1);
          lease.guard();
        }
      } finally { await dir.close(); }
      lease.guard();
      check(children > 0, 'unexpected empty runtime directory');
    } else {
      const mode = info.mode & 0o7777n;
      check(mode === 0o644n || mode === 0o755n, 'runtime material mode');
      const { data } = await readLeased(lease, path, limits.artifactBytes, budget);
      lease.guard();
      files.set(local, data);
      modes.set(local, '100' + mode.toString(8));
    }
    lease.guard();
    check(stable(stat(path)) === identity, 'runtime tree changed during read');
  }
  if (expected) recheck(expected.boundary);
  await visit(root, '', 0);
  lease.guard();
  recheck(boundary);
  recheck(captures, stable);
  if (expected) check(captures.size === expected.nodes.size, 'staged inventory count changed');
  return { files, modes, boundary, nodes: captures };
}
export function compareTree(tree, materials) {
  check(tree.files.size === materials.length, 'runtime tree membership mismatch');
  for (const r of materials) {
    const data = tree.files.get(r.path);
    check(data && data.length === r.bytes && sha256(data) === r.sha256 && tree.modes.get(r.path) === r.mode, 'runtime tree descriptor mismatch ' + r.path);
  }
}
function base64(text, length) {
  check(typeof text === 'string' && text.length === Math.ceil(length / 3) * 4, 'invalid base64 length');
  const bytes = Buffer.from(text, 'base64');
  check(bytes.length === length && bytes.toString('base64') === text, 'noncanonical base64');
  return bytes;
}
export function signatureSet(signatures) {
  check(Array.isArray(signatures) && signatures.length > 0 && signatures.length <= 16, 'detached signature count');
  const ids = new Set();
  for (const item of signatures) {
    shape(item, 'keyId signature', 'detached signature');
    check(typeof item.keyId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(item.keyId) && !ids.has(item.keyId), 'duplicate/invalid signature key');
    base64(item.signature, 64);
    ids.add(item.keyId);
  }
}
// Material paths have already passed table(), including depth, spelling and
// file/directory conflicts. The physical walker also counts the destination.
function runtimeDirectories(materials) {
  const directories = new Set(['.']);
  for (const row of materials) {
    let parent = dirname(row.path);
    while (!directories.has(parent)) {
      directories.add(parent);
      check(materials.length + directories.size <= limits.evidenceEntries, 'runtime tree entry limit');
      parent = dirname(parent);
    }
  }
  check(materials.length + directories.size <= limits.evidenceEntries, 'runtime tree entry limit');
  return [...directories].sort();
}
function hubTraversalDirectories(receipt, hubGroup) {
  if (hubGroup === undefined) return new Set();
  check(Number.isSafeInteger(hubGroup) && hubGroup > 0 && hubGroup <= 0x7fffffff, 'invalid installed Hub group');
  check(receipt.profile === 'deployment-complete' && hasAutoloopHub(receipt.materials.map(({ path }) => path)),
    'signed Hub closure required');
  return new Set(runtimeDirectories(receipt.materials).filter(directory =>
    directory === '.' || directory === dirname(autoloopHub.root) ||
    directory === autoloopHub.root || directory.startsWith(autoloopHub.root + '/')));
}
const serviceTraversalRoots = new Set(['runtime', 'web', 'migrations', 'assets', 'metadata', 'node_modules']);
function runtimeDirectoryAccess(receipt, hubGroup, serviceGroup) {
  const hubDirectories = hubTraversalDirectories(receipt, hubGroup);
  const hubAccess = { mode: 0o710, group: hubGroup, mismatch: 'installed Hub access mismatch' };
  if (serviceGroup === undefined) return new Map([...hubDirectories].map(directory => [directory, hubAccess]));
  check(Number.isSafeInteger(serviceGroup) && serviceGroup > 0 && serviceGroup <= 0x7fffffff, 'invalid installed Service group');
  const serviceAccess = { mode: 0o710, group: serviceGroup, mismatch: 'installed Service access mismatch' };
  const sharedAccess = { mode: 0o711, mismatch: 'installed shared role access mismatch' };
  const privateAccess = { mode: 0o700, mismatch: 'installed private directory access mismatch' };
  const access = new Map();
  for (const directory of runtimeDirectories(receipt.materials)) {
    const hub = hubDirectories.has(directory);
    const inHubClosure = directory === autoloopHub.root || directory.startsWith(autoloopHub.root + '/');
    const service = !inHubClosure && (directory === '.' || serviceTraversalRoots.has(directory.split('/')[0]));
    if (hub && service && hubGroup !== serviceGroup) access.set(directory, sharedAccess);
    else if (hub) access.set(directory, hubAccess);
    else access.set(directory, service ? serviceAccess : privateAccess);
  }
  return access;
}
function checkRuntimeDirectoryAccess(lease, root, nodes, access) {
  for (const [directory, { mode, group, mismatch }] of access) {
    lease.guard();
    const path = join(root, directory);
    const info = stat(path);
    check(info.isDirectory() && (info.mode & 0o7777n) === BigInt(mode) &&
      (group === undefined || info.gid === BigInt(group)), mismatch);
    check(stable(info) === nodes.get(path), 'runtime directory changed after read');
  }
}
function signaturesValid(signatures, bytes, keys) {
  signatureSet(signatures);
  check(Array.isArray(keys) && keys.length > 0 && keys.length <= 64, 'trusted keys required');
  const trust = new Map();
  for (const key of keys) {
    shape(key, 'id publicKey', 'pinned key');
    check(typeof key.id === 'string' && !trust.has(key.id) && typeof key.publicKey === 'string' && key.publicKey.startsWith('-----BEGIN PUBLIC KEY-----') && key.publicKey.length < 8192, 'invalid pinned key');
    const parsed = createPublicKey(key.publicKey);
    check(parsed.asymmetricKeyType === 'ed25519', 'expected Ed25519 key');
    trust.set(key.id, parsed);
  }
  for (const item of signatures) {
    check(trust.has(item.keyId) && verify(null, bytes, trust.get(item.keyId), base64(item.signature, 64)), 'detached signature verification failed');
  }
}
function decodePackage(data, expected, policy) {
  const packageSha256 = sha256(data);
  check(isHash(expected.packageSha256) && packageSha256 === expected.packageSha256, 'finished package digest mismatch');
  const envelope = json(data);
  shape(envelope, 'format manifest files signatures', 'envelope');
  check(envelope.format === 'patrick-emitted-runtime-envelope-v1', 'unsupported emitted envelope');
  const m = envelope.manifest;
  shape(m, 'format kind identity materialSha256 artifacts', 'manifest');
  check(m.kind === 'emitted-runtime-candidate' && m.format === 'patrick-emitted-runtime-manifest-v1', 'unsupported emitted manifest');
  table(m.artifacts);
  const identity = m.identity;
  const profile = releaseProfile(expected.profile);
  const complete = completeProfile(profile);
  const v3 = profile === nativeProfile;
  check(complete ? identity?.format === 'patrick-emitted-runtime-material-identity-v' + inventoryVersion(profile) && identity.profile === profile :
    identity?.format === 'patrick-emitted-runtime-material-identity-v1' && !own(identity, 'profile'), 'independent release profile mismatch');
  shape(identity, 'format version source target schema runtime toolchainSha256 inventorySha256 sbomSha256 materials' + (complete ? ' profile' : '') +
    (v3 ? ' directoryAuthoritySha256' : ''), 'material identity');
  table(identity.materials);
  runtimeDirectories(identity.materials);
  for (const key of ['version','source','target','schema','toolchainSha256','inventorySha256']) equal(identity[key], expected[key], 'independent expectation mismatch ' + key);
  if (v3) check(isHash(expected.directoryAuthoritySha256) && identity.directoryAuthoritySha256 === expected.directoryAuthoritySha256 &&
    isHash(expected.directoryNativeSha256) && identity.runtime.directoryNative.sha256 === expected.directoryNativeSha256, 'independent directory digest mismatch');
  equal({ node: identity.runtime.node, modules: identity.runtime.modules }, expected.runtime, 'expected runtime mismatch');
  check(uint(expected.activeSchema) && expected.activeSchema >= expected.schema.min && expected.activeSchema <= expected.schema.max, 'schema inactive');
  check(m.materialSha256 === expected.materialSha256 && m.materialSha256 === sha256(encode(identity)), 'expected material identity mismatch');
  const manifestBytes = encode(m);
  signaturesValid(envelope.signatures, manifestBytes, policy.keys);
  check(Array.isArray(envelope.files) && envelope.files.length === m.artifacts.length, 'envelope file set mismatch');
  const files = new Map();
  for (const [index, item] of envelope.files.entries()) {
    const r = m.artifacts[index];
    shape(item, 'path data', 'file payload');
    check(item.path === r.path, 'signed file table mismatch');
    const value = base64(item.data, r.bytes);
    check(sha256(value) === r.sha256, 'signed file hash mismatch');
    files.set(r.path, value);
  }
  check(encode(envelope).equals(data), 'noncanonical envelope');
  const actual = inspectBytes(files, { ...identity, profile });
  equal(identity, actual.identity, 'material identity projection mismatch');
  check(files.get(paths.sbom)?.equals(actual.sbom), 'SBOM mismatch');
  const logs = inspectEvidence(files, identity, m.materialSha256, policy);
  equal(m.artifacts, artifactTable(files, identity, logs), 'signed descriptor mismatch');
  return { files, identity, manifestSha256: sha256(manifestBytes), packageSha256, materialSha256: actual.materialSha256 };
}
// Enrollment comes from the trusted owner itself. A command cannot select a
// destination at publication time. Keep the physical bindings from admission.
function capturePublication(lease, registration, archive) {
  if (registration === undefined) return undefined;
  check(lease.root !== sep, 'non-root physical owner required');
  const { stagingRoot, releasesRoot } = registration;
  const roots = [stagingRoot, releasesRoot];
  const boundary = new Map();
  for (const root of roots) {
    inside(lease.root, root);
    for (const [path, id] of ancestry(root, lease.root)) boundary.set(path, id);
    check(realpathSync.native(root) === root, 'noncanonical publication root');
  }
  check(realpathSync.native(archive) === archive, 'noncanonical archive');
  const names = [...roots, archive];
  for (const name of names) {
    check(names.filter(other => other === name || other.startsWith(name + sep)).length === 1, 'overlapping publication paths');
  }
  return { stagingRoot, releasesRoot, boundary };
}

function checkPublication(lease, record) {
  checkLeaf(lease, record.path, record.binding);
  const { stagingRoot, releasesRoot, boundary } = record.publication;
  const registration = record.staging.publication;
  check(registration?.stagingRoot === stagingRoot && registration.releasesRoot === releasesRoot, 'publication enrollment changed');
  recheck(boundary);
  for (const path of [stagingRoot, releasesRoot, record.path]) {
    check(realpathSync.native(path) === path, 'noncanonical publication path');
  }
}

export async function verifyEmittedRuntimeCandidate(path, { staging, expected, policy }) {
  const pins = structuredClone({ expected, policy });
  const { projection, binding, publication } = await leased(staging, async lease => {
    const { data, binding } = await readLeased(lease, path, limits.packageBytes);
    lease.guard();
    const { identity, manifestSha256, packageSha256, materialSha256 } = decodePackage(data, pins.expected, pins.policy);
    const { version, source, target, schema, runtime, inventorySha256, toolchainSha256, materials } = identity;
    const publication = capturePublication(lease, staging.publication, path);
    return { binding, publication, projection: { kind: 'emitted-runtime-candidate', profile: releaseProfile(identity.profile), version, source, target, schema, runtime, packageSha256,
      manifestSha256, materialSha256, inventorySha256, toolchainSha256, nativeSha256: runtime.native.sha256,
      ...(identity.profile === nativeProfile && { directoryNativeSha256: runtime.directoryNative.sha256, directoryAuthoritySha256: identity.directoryAuthoritySha256 }), materials } };
  });
  const receipt = freeze(projection);
  verified.set(receipt, { path, staging, binding, pins, publication });
  return receipt;
}
const failedWrites = new WeakMap();
const objectId = info => [info.dev, info.ino, info.birthtimeNs, info.uid, info.mode & 0o170000n].join('/');

function checkWriteScope(lease, journal) {
  lease.guard();
  check(lease.root === journal.root, 'original physical write lease required');
  recheck(journal.boundary);
}
function guardOutput(lease, journal, path) {
  checkWriteScope(lease, journal);
  const parents = [];
  for (let p = dirname(path); p !== journal.parent; p = dirname(p)) parents.push(p);
  for (const parent of parents.reverse()) {
    const entry = journal.entries.get(parent);
    const info = stat(parent);
    requireOwnedDirectory(info);
    check(entry?.directory && entry.id === objectId(info), 'owned output ancestor exchanged');
  }
}
function namedInfo(path) {
  try { return stat(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

// Entries are inserted parent first. A missing or exchanged parent is never
// traversed. A name created just before losing the lease may have no proven id.
function inspectCreated(lease, journal) {
  checkWriteScope(lease, journal);
  const states = new Map();
  for (const [path, entry] of journal.entries) {
    const parentState = states.get(dirname(path));
    let state = parentState;
    if (!parentState || parentState === 'owned') {
      const info = namedInfo(path);
      if (!info) state = 'absent';
      else if (entry.id !== objectId(info) || (entry.directory && (info.mode & 0o022n) !== 0n) ||
        (entry.stamp && entry.stamp !== stable(info))) state = 'changed';
      else state = 'owned';
    }
    states.set(path, state);
  }
  return states;
}

async function cleanupCreated(lease, journal, reacquired = false) {
  const states = inspectCreated(lease, journal);
  const observations = [...states.values()];
  check(!observations.includes('changed'), 'created output exchanged');
  // An early lease release may have interrupted an in-flight write. Without its
  // completed, sealed identities, a later lease cannot safely unlink that data.
  check(!reacquired || journal.complete || observations.every(s => s === 'absent'), 'incomplete write identity after lease loss');
  for (const [path, entry] of [...journal.entries].reverse()) {
    if (states.get(path) === 'absent') continue;
    guardOutput(lease, journal, path);
    const current = stat(path);
    check(entry.id === objectId(current), 'created output exchanged');
    // Removing an owned child updates the parent's timestamps. Its physical
    // identity must still match immediately before rmdir. Never recurse.
    if (entry.directory) await rmdir(path);
    else {
      check(!entry.stamp || entry.stamp === stable(current), 'created file changed');
      await unlink(path);
    }
  }
  checkWriteScope(lease, journal);
  check([...inspectCreated(lease, journal).values()].every(state => state === 'absent'), 'incomplete output cleanup');
}
function writeFailure(journal, staging, code) {
  const error = Object.assign(new Error(code), { code, operation: journal.operation, path: journal.path, packageSha256: journal.packageSha256 });
  failedWrites.set(error, { journal, staging });
  if (code === 'EMITTED_WRITE_UNCERTAIN' && journal.pending) {
    const owner = derivedPorts.get(staging)?.parent.scope ?? staging;
    unresolvedWrites.set(owner, error);
  }
  return Object.freeze(error);
}
export async function readEmittedWriteOutcome(error) {
  const failed = failedWrites.get(error);
  check(failed, 'genuine emitted write failure required');
  const { journal, staging } = failed;
  const { operation, path, packageSha256 } = journal;
  try {
    return await leased(staging, async lease => {
      checkWriteScope(lease, journal);
      if (journal.pending) return freeze({ operation, path, packageSha256, state: 'unavailable' });
      const states = inspectCreated(lease, journal);
      let owned = 0, absent = 0, changed = 0;
      for (const [name, state] of states) {
        if (state === 'absent') { absent++; continue; }
        if (state === 'changed') { changed++; continue; }
        const entry = journal.entries.get(name);
        if (journal.complete && !entry.directory) {
          const { data } = await readLeased(lease, name, operation === 'pack' ? limits.packageBytes : limits.artifactBytes);
          checkWriteScope(lease, journal);
          if (sha256(data) !== entry.sha256) { changed++; continue; }
        }
        owned++;
      }
      const state = changed ? 'changed' : !owned ? 'absent' : journal.complete && !absent ? 'owned' : 'partial';
      checkWriteScope(lease, journal);
      return freeze({ operation, path, packageSha256, state, owned, changed, absent });
    });
  } catch {
    return freeze({ operation, path, packageSha256, state: 'unavailable' });
  }
}

async function writeUnderLease(staging, operation, path, packageSha256, work) {
  const owner = derivedPorts.get(staging)?.parent.scope ?? staging;
  const unresolved = unresolvedWrites.get(owner);
  if (unresolved) throw unresolved;
  let journal;
  let originalFailure;
  try {
    return await leased(staging, async lease => {
      inside(lease.root, path);
      const parent = dirname(path);
      journal = { operation, path, packageSha256, root: lease.root, parent,
        boundary: ancestry(parent, lease.root), entries: new Map(), complete: false, pending: undefined };
      try {
        const result = await work(lease, journal);
        checkWriteScope(lease, journal);
        for (const [name, entry] of journal.entries) {
          guardOutput(lease, journal, name);
          const info = stat(name);
          check(entry.id === objectId(info), 'created output exchanged before lease completion');
          entry.stamp = stable(info);
        }
        journal.complete = true;
        return result;
      } catch (error) {
        if (journal.pending && error?.code !== 'EEXIST') {
          let absent = false;
          try { guardOutput(lease, journal, journal.pending); absent = !namedInfo(journal.pending); } catch { /* Ownership was lost. */ }
          if (!absent) throw writeFailure(journal, staging, 'EMITTED_WRITE_UNCERTAIN');
        }
        journal.pending = undefined;
        if (journal.entries.size) await cleanupCreated(lease, journal);
        originalFailure = { error };
        throw error;
      }
    }, true);
  } catch (error) {
    if (failedWrites.has(error)) throw error;
    if (!journal?.entries.size || (originalFailure && originalFailure.error === error)) throw error;
    try {
      await leased(staging, lease => cleanupCreated(lease, journal, true), true);
    } catch {
      throw writeFailure(journal, staging, 'EMITTED_WRITE_UNCERTAIN');
    }
    throw writeFailure(journal, staging, 'EMITTED_WRITE_ROLLED_BACK');
  }
}

async function writeNew(lease, journal, path, data, mode, digest) {
  guardOutput(lease, journal, path);
  journal.pending = path;
  const handle = await open(path, 'wx', 0o600);
  const entry = { directory: false, sha256: digest };
  journal.entries.set(path, entry);
  try {
    guardOutput(lease, journal, path);
    entry.id = objectId(await handle.stat({ bigint: true }));
    guardOutput(lease, journal, path);
    journal.pending = undefined;
    guardOutput(lease, journal, path);
    await handle.writeFile(data);
    guardOutput(lease, journal, path);
    await handle.chmod(mode);
    guardOutput(lease, journal, path);
    await handle.sync();
    guardOutput(lease, journal, path);
    const named = stat(path);
    check(entry.id === objectId(named) && named.nlink === 1n, 'output file exchanged');
  } finally { await handle.close(); }
}
export function publishPackage(staging, path, data, packageSha256) {
  return writeUnderLease(staging, 'pack', path, packageSha256, async (lease, journal) => {
    const tmp = join(journal.parent, '.candidate-' + randomUUID());
    await writeNew(lease, journal, tmp, data, 0o600, packageSha256);
    guardOutput(lease, journal, path);
    journal.pending = path;
    await link(tmp, path);
    journal.entries.set(path, { ...journal.entries.get(tmp) });
    journal.pending = undefined;
    guardOutput(lease, journal, tmp);
    check(objectId(stat(tmp)) === journal.entries.get(tmp).id, 'temporary package exchanged');
    await unlink(tmp);
    journal.entries.delete(tmp);
    const actual = await readLeased(lease, path, limits.packageBytes);
    guardOutput(lease, journal, path);
    check(actual.data.equals(data), 'package output readback mismatch');
  });
}
async function createTree(lease, journal, materials, files, directoryAccess) {
  for (const dir of runtimeDirectories(materials)) {
    const path = join(journal.path, dir);
    guardOutput(lease, journal, path);
    journal.pending = path;
    await mkdir(path, { mode: 0o700 });
    const entry = { directory: true };
    journal.entries.set(path, entry);
    guardOutput(lease, journal, path);
    const info = stat(path);
    requireOwnedDirectory(info);
    entry.id = objectId(info);
    journal.pending = undefined;
    const access = directoryAccess.get(dir);
    if (access) {
      if (access.group !== undefined) {
        await chown(path, process.geteuid(), access.group);
        guardOutput(lease, journal, path);
      }
      await chmod(path, access.mode);
      guardOutput(lease, journal, path);
    }
  }
  for (const r of materials) await writeNew(lease, journal, join(journal.path, r.path), files.get(r.path), parseInt(r.mode.slice(3), 8), r.sha256);
}
export async function stageVerifiedEmittedRuntime(receipt, { staging, destination, hubGroup, serviceGroup }) {
  const record = verified.get(receipt);
  check(record && record.staging === staging, 'genuine verified receipt and bound staging required');
  check(receipt.profile !== nativeProfile, 'byte-only native candidate cannot be staged');
  check(hubGroup === undefined || record.publication, 'Hub access requires bound publication');
  check(serviceGroup === undefined || record.publication, 'Service access requires bound publication');
  const directoryAccess = runtimeDirectoryAccess(receipt, hubGroup, serviceGroup);
  const capture = await writeUnderLease(staging, 'stage', destination, receipt.packageSha256, async (lease, journal) => {
    if (record.publication) {
      checkPublication(lease, record);
      inside(record.publication.stagingRoot, destination);
      check(realpathSync.native(dirname(destination)) === dirname(destination), 'noncanonical stage parent');
    }
    checkLeaf(lease, record.path, record.binding);
    const { data } = await readLeased(lease, record.path, limits.packageBytes);
    lease.guard();
    const { files } = decodePackage(data, record.pins.expected, record.pins.policy);
    await createTree(lease, journal, receipt.materials, files, directoryAccess);
    lease.guard();
    const tree = await readTree(lease, destination);
    lease.guard();
    compareTree(tree, receipt.materials);
    if (serviceGroup !== undefined) checkRuntimeDirectoryAccess(lease, destination, tree.nodes, directoryAccess);
    checkLeaf(lease, record.path, record.binding);
    return { nodes: tree.nodes, boundary: tree.boundary, leaseRoot: lease.root };
  });
  const token = freeze({ profile: receipt.profile, packageSha256: receipt.packageSha256, materialSha256: receipt.materialSha256 });
  staged.set(token, { receipt, destination, capture });
  return token;
}

async function verifiedTreeCapture(lease, record, receipt, root, expected) {
  checkLeaf(lease, record.path, record.binding);
  const { data } = await readLeased(lease, record.path, limits.packageBytes);
  lease.guard();
  check(sha256(data) === receipt.packageSha256, 'staging package changed');
  const tree = await readTree(lease, root, expected);
  lease.guard();
  compareTree(tree, receipt.materials);
  checkLeaf(lease, record.path, record.binding);
  return { nodes: tree.nodes, boundary: tree.boundary };
}

async function useVerifiedTree(lease, record, receipt, root, use, stageCapture, directoryAccess) {
  const readback = async expected => {
    const capture = await verifiedTreeCapture(lease, record, receipt, root, expected);
    lease.guard();
    // On case-insensitive volumes the digest slot must still use its enrolled spelling.
    if (!stageCapture) check(realpathSync.native(root) === root, 'noncanonical published release path');
    if (directoryAccess) checkRuntimeDirectoryAccess(lease, root, capture.nodes, directoryAccess);
    return capture;
  };
  const capture = await readback(stageCapture);
  try {
    lease.guard();
    const preflight = receipt.materials.find(({ path }) => path === servicePreflight.path);
    const hub = hasAutoloopHub(receipt.materials.map(({ path }) => path));
    const deployment = receipt.profile === 'deployment-complete' ? {
      templates: Object.fromEntries(Object.entries(deploymentPaths).map(([key, path]) => [key, join(root, path)])),
      ...(preflight && { servicePreflight: { path: join(root, preflight.path), sha256: preflight.sha256 } }),
      ...(hub && { autoloopHub: { commit: autoloopHub.commit, root: join(root, autoloopHub.root),
        entry: join(root, autoloopHub.root, autoloopHub.entry), initializer: join(root, autoloopHub.root, autoloopHub.initializer) } }),
    } : {};
    return await use(freeze({ root, profile: receipt.profile, ...deployment, entrypoints: Object.fromEntries(entryNames.map(name => [name, join(root, 'runtime', name + '.mjs')])),
      runtime: receipt.runtime, packageSha256: receipt.packageSha256, materialSha256: receipt.materialSha256, inventorySha256: receipt.inventorySha256 }));
  } finally { await readback(capture); }
}

export async function withStagedEmittedRuntime(receipt, token, use) {
  const record = verified.get(receipt);
  const stage = staged.get(token);
  check(record && stage?.receipt === receipt && typeof use === 'function', 'matching genuine stage and verified receipt required');
  return leased(record.staging, lease => {
    check(!stage.claimed && lease.root === stage.capture.leaseRoot, 'staging root changed or already claimed');
    return useVerifiedTree(lease, record, receipt, stage.destination, use, stage.capture);
  });
}

// Install consumers require a genuine complete profile in addition to the original
// same-instance receipt, stage and leased readback checks.
export async function withStagedDeployment(receipt, token, use) {
  check(verified.has(receipt) && receipt.profile === 'deployment-complete', 'complete deployment profile required');
  return withStagedEmittedRuntime(receipt, token, use);
}

export async function withPublishedDeployment(receipt, { staging, releasesRoot, hubGroup, serviceGroup }, use) {
  const record = verified.get(receipt);
  check(record && record.staging === staging && receipt.profile === 'deployment-complete' && typeof use === 'function',
    'genuine complete deployment receipt and bound staging required');
  const directoryAccess = runtimeDirectoryAccess(receipt, hubGroup, serviceGroup);
  return leased(staging, lease => {
    check(lease.root !== sep, 'non-root physical owner required');
    inside(lease.root, releasesRoot);
    if (record.publication) {
      check(releasesRoot === record.publication.releasesRoot, 'registered release store required');
      checkPublication(lease, record);
    }
    const root = join(releasesRoot, receipt.packageSha256);
    return useVerifiedTree(lease, record, receipt, root, use, undefined, directoryAccess);
  });
}

function syncDirectory(path, id, fingerprint = physical) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    check(fingerprint(fstatSync(fd, { bigint: true })) === id, 'directory sync identity changed');
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export async function publishStagedDeployment(receipt, token, confirmPublication) {
  const record = verified.get(receipt);
  const stage = staged.get(token);
  check(record?.publication && stage?.receipt === receipt && receipt.profile === 'deployment-complete',
    'bound complete deployment receipt, stage and publication enrollment required');
  const { releasesRoot, stagingRoot } = record.publication;
  const path = join(releasesRoot, receipt.packageSha256);
  const source = inside(stagingRoot, stage.destination);
  const parent = dirname(source);
  const result = Object.freeze({ path, packageSha256: receipt.packageSha256 });
  let attempted = false;
  try {
    await leased(record.staging, async lease => {
      check(!stage.claimed && lease.root === stage.capture.leaseRoot, 'stage already claimed or owner changed');
      checkPublication(lease, record);
      check(realpathSync.native(source) === source, 'noncanonical stage');
      const parents = ancestry(parent, lease.root);
      const sourceInfo = stat(source);
      const volume = stat(releasesRoot).dev;
      check(sourceInfo.dev === volume && stat(parent).dev === volume, 'same-volume publication required');
      check(!namedInfo(path), 'occupied release slot');
      const capture = await verifiedTreeCapture(lease, record, receipt, source, stage.capture);
      lease.guard();
      // Material files were synced at staging. Flush the directory entries from
      // leaves to root before the rename makes them reachable in the store.
      for (const local of runtimeDirectories(receipt.materials).reverse()) {
        const dir = join(source, local);
        syncDirectory(dir, capture.nodes.get(dir), stable);
      }
      checkPublication(lease, record);
      recheck(capture.boundary);
      recheck(capture.nodes, stable);
      check(realpathSync.native(source) === source, 'noncanonical stage');
      check(!namedInfo(path), 'occupied release slot');
      confirmPublication?.();
      // Node has no Darwin RENAME_EXCL. Only the registered host's exclusion
      // of all competing writers makes the absence check and rename no-clobber.
      stage.claimed = true;
      attempted = true;
      renameSync(source, path);
      recheck(parents);
      recheck(record.publication.boundary);
      syncDirectory(parent, parents.get(parent));
      syncDirectory(releasesRoot, record.publication.boundary.get(releasesRoot));
      check(!namedInfo(source) && realpathSync.native(path) === path, 'relocation names changed');
      // A rename can update the moved directory's ctime. Pin its original
      // physical object and mode, and keep every descendant's full stage stamp.
      const moved = stat(path);
      check(objectId(moved) === objectId(sourceInfo) && physical(moved) === physical(sourceInfo), 'relocated root identity changed');
      const nodes = new Map();
      for (const [name, identity] of capture.nodes) {
        nodes.set(join(path, relative(source, name)), name === source ? stable(moved) : identity);
      }
      await verifiedTreeCapture(lease, record, receipt, path, { boundary: ancestry(path, lease.root), nodes });
      checkPublication(lease, record);
      recheck(parents);
      check(!namedInfo(source), 'stage name reappeared');
      confirmPublication?.();
    }, true);
    return result;
  } catch (error) {
    if (!attempted) throw error;
    throw Object.freeze(Object.assign(new Error('EMITTED_PUBLICATION_UNCERTAIN'), {
      code: 'EMITTED_PUBLICATION_UNCERTAIN', ...result,
    }));
  }
}
