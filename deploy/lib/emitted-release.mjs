import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { link, mkdir, open, opendir, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { admitReadRoot, canonicalize, readRegularFile, RELEASE_LIMITS as limits, sha256, validatePaths } from './release.mjs';

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
function role(path) {
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
function checkToolchain(raw, inventory, inventoryBytes, lock) {
  const t = json(raw);
  shape(t, 'observed node npm git esbuild esbuildBinary vite viteEsbuild viteRollup source inventory repeatInventory totals largestRecord native packages packageFiles runtimeFiles', 'toolchain');
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
}
function makeSbom(files, inventory, lock, version) {
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
  return encode({ format: 'patrick-emitted-runtime-sbom-v1', packages });
}

// Pure validation shared by the packer and the independently trusted host verifier.
export function inspectBytes(files, { version, source, target, schema, inventorySha256, toolchainSha256 }) {
  const raw = files.get(paths.inventory);
  check(raw && sha256(raw) === inventorySha256, 'inventory digest mismatch');
  const inv = json(raw);
  shape(inv, 'schemaVersion materialKind source tools observed packages native files', 'inventory');
  check(inv.schemaVersion === 1 && inv.materialKind === 'emitted-runtime-materials', 'unsupported inventory');
  shape(inv.source, 'kind commit snapshotSha256 lockSha256', 'source');
  check(['commit','pinned-snapshot'].includes(inv.source.kind) && typeof inv.source.commit === 'string' && /^[0-9a-f]{40}$/.test(inv.source.commit) &&
    isHash(inv.source.snapshotSha256) && isHash(inv.source.lockSha256), 'invalid source identity');
  equal(inv.source, source, 'source mismatch');
  shape(target, 'os arch', 'target');
  shape(schema, 'min max', 'schema interval');
  check(typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) && uint(schema.min) && uint(schema.max) && schema.max >= schema.min, 'invalid release/schema');
  shape(inv.observed, 'platform arch node modules npm', 'runtime observation');
  const { platform, arch, node, modules, npm } = inv.observed;
  check(platform === 'darwin' && target.os === platform && ['arm64','x64'].includes(arch) && target.arch === arch &&
    typeof node === 'string' && /^v\d+\.\d+\.\d+$/.test(node) && typeof modules === 'string' && /^\d+$/.test(modules) && typeof npm === 'string' && semver.test(npm), 'target/runtime mismatch');
  equal(inv.tools, { esbuild: '0.28.2', vite: '7.3.8' }, 'unsupported build tools');
  equal(inv.packages, Object.entries(versions).map(([name, version]) => ({ name, version })), 'unsupported package closure');
  table(inv.files);
  for (const r of inv.files) {
    check(r.role === role(r.path) && r.mode === (r.path === addon ? '100755' : '100644'), 'material role/mode mismatch ' + r.path);
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
  const lockBytes = files.get(paths.lock);
  const toolBytes = files.get(paths.toolchain);
  check(sha256(lockBytes) === source.lockSha256 && sha256(toolBytes) === toolchainSha256, 'provenance digest mismatch');
  const lock = json(lockBytes);
  checkToolchain(toolBytes, inv, raw, lock);
  const sbom = makeSbom(files, inv, lock, version);
  const materials = ordered([...inv.files, descriptor(paths.inventory, 'runtime-inventory', '100644', raw)]);
  table(materials);
  const identity = { format: 'patrick-emitted-runtime-material-identity-v1', version, source: inv.source, target, schema,
    runtime: { node, modules, npm, native }, toolchainSha256, inventorySha256, sbomSha256: sha256(sbom), materials };
  return { identity, materialSha256: sha256(encode(identity)), sbom };
}
export const logPath = id => { check(scenarioId(id), 'invalid scenario id'); return 'evidence/logs/' + id + '.log'; };
export function inspectEvidence(files, identity, materialSha256, policy) {
  const reportBytes = files.get(paths.report);
  check(reportBytes && sha256(reportBytes) === policy.executionReportSha256, 'execution report pin mismatch');
  const report = json(reportBytes);
  shape(report, 'format materialSha256 inventorySha256 toolchainSha256 nativeSha256 observed native entries scenarios', 'execution report');
  const { runtime, target } = identity;
  check(report.format === 'patrick-emitted-runtime-execution-v1' && report.materialSha256 === materialSha256 && report.inventorySha256 === identity.inventorySha256 &&
    report.toolchainSha256 === identity.toolchainSha256 && report.nativeSha256 === runtime.native.sha256, 'execution material binding mismatch');
  equal(report.observed, { platform: target.os, arch: target.arch, node: runtime.node, modules: runtime.modules, npm: runtime.npm }, 'execution runtime mismatch');
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
  check(baseline.every(id => required.has(id)) && Array.isArray(report.scenarios) && report.scenarios.length === required.size, 'required scenario set mismatch');
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
function physical(info) { return [info.dev, info.ino, info.mode, info.uid].join('/'); }
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
// The independently registered host MUST exclude competing writers throughout this
// callback. Public path-based Node APIs cannot exclude a hostile swap-and-restore
// between two syscalls. Device/inode checks only detect observable exchanges.
export async function leased(port, work, joinWork = false) {
  check(typeof port?.withExclusiveReadRoot === 'function', 'exclusive host staging required');
  let active = true;
  let calls = 0;
  let finished = false;
  let firstCall;
  let answer;
  const marker = Object.freeze({});
  function valid() { check(active && calls === 1, 'exclusive lease callback violation'); }
  try {
    const result = await port.withExclusiveReadRoot(root => {
      calls++;
      const run = async () => {
        valid();
        admitReadRoot(root).validate();
        const tree = ancestry(root, root);
        const guard = () => { valid(); recheck(tree); };
        guard();
        answer = await work({ root, tree, guard });
        guard();
        finished = true;
        return marker;
      };
      const promise = run();
      if (calls === 1) firstCall = promise;
      // A malformed adapter may discard this promise. The enclosing identity
      // check still refuses it and closes the guard on return.
      promise.catch(() => {});
      return promise;
    });
    valid();
    check(finished && result === marker, 'exclusive lease callback incomplete or result substituted');
    return answer;
  } finally {
    active = false;
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
      for await (const item of dir) {
        children++;
        const child = local ? local + '/' + item.name : item.name;
        validatePaths([child]);
        await visit(join(path, item.name), child, depth + 1);
      }
      check(children > 0, 'unexpected empty runtime directory');
    } else {
      const mode = info.mode & 0o7777n;
      check(mode === 0o644n || mode === 0o755n, 'runtime material mode');
      const { data } = await readLeased(lease, path, limits.artifactBytes, budget);
      files.set(local, data);
      modes.set(local, '100' + mode.toString(8));
    }
    check(stable(stat(path)) === identity, 'runtime tree changed during read');
  }
  if (expected) recheck(expected.boundary);
  await visit(root, '', 0);
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
  shape(identity, 'format version source target schema runtime toolchainSha256 inventorySha256 sbomSha256 materials', 'material identity');
  table(identity.materials);
  runtimeDirectories(identity.materials);
  for (const key of ['version','source','target','schema','toolchainSha256','inventorySha256']) equal(identity[key], expected[key], 'independent expectation mismatch ' + key);
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
  const actual = inspectBytes(files, identity);
  equal(identity, actual.identity, 'material identity projection mismatch');
  check(files.get(paths.sbom)?.equals(actual.sbom), 'SBOM mismatch');
  const logs = inspectEvidence(files, identity, m.materialSha256, policy);
  equal(m.artifacts, artifactTable(files, identity, logs), 'signed descriptor mismatch');
  return { files, identity, manifestSha256: sha256(manifestBytes), packageSha256, materialSha256: actual.materialSha256 };
}
export async function verifyEmittedRuntimeCandidate(path, { staging, expected, policy }) {
  const pins = structuredClone({ expected, policy });
  const { projection, binding } = await leased(staging, async lease => {
    const { data, binding } = await readLeased(lease, path, limits.packageBytes);
    const { identity, manifestSha256, packageSha256, materialSha256 } = decodePackage(data, pins.expected, pins.policy);
    const { version, source, target, schema, runtime, inventorySha256, toolchainSha256, materials } = identity;
    return { binding, projection: { kind: 'emitted-runtime-candidate', version, source, target, schema, runtime, packageSha256,
      manifestSha256, materialSha256, inventorySha256, toolchainSha256, nativeSha256: runtime.native.sha256, materials } };
  });
  const receipt = freeze(projection);
  verified.set(receipt, { path, staging, binding, pins });
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
  return Object.freeze(error);
}
export async function readEmittedWriteOutcome(error) {
  const failed = failedWrites.get(error);
  check(failed, 'genuine emitted write failure required');
  const { journal, staging } = failed;
  const { operation, path, packageSha256 } = journal;
  try {
    return await leased(staging, async lease => {
      const states = inspectCreated(lease, journal);
      let owned = 0, absent = 0, changed = 0;
      for (const [name, state] of states) {
        if (state === 'absent') { absent++; continue; }
        if (state === 'changed') { changed++; continue; }
        const entry = journal.entries.get(name);
        if (journal.complete && !entry.directory) {
          const { data } = await readLeased(lease, name, operation === 'pack' ? limits.packageBytes : limits.artifactBytes);
          if (sha256(data) !== entry.sha256) { changed++; continue; }
        }
        owned++;
      }
      const state = changed ? 'changed' : !owned ? 'absent' : journal.complete && !absent ? 'owned' : 'partial';
      return freeze({ operation, path, packageSha256, state, owned, changed, absent });
    });
  } catch {
    return freeze({ operation, path, packageSha256, state: 'unavailable' });
  }
}

async function writeUnderLease(staging, operation, path, packageSha256, work) {
  let journal;
  let originalFailure;
  try {
    return await leased(staging, async lease => {
      inside(lease.root, path);
      const parent = dirname(path);
      journal = { operation, path, packageSha256, root: lease.root, parent,
        boundary: ancestry(parent, lease.root), entries: new Map(), complete: false };
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
        if (journal.entries.size) await cleanupCreated(lease, journal);
        originalFailure = { error };
        throw error;
      }
    }, true);
  } catch (error) {
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
  const handle = await open(path, 'wx', 0o600);
  const entry = { directory: false, sha256: digest };
  journal.entries.set(path, entry);
  try {
    entry.id = objectId(await handle.stat({ bigint: true }));
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
    await link(tmp, path);
    journal.entries.set(path, { ...journal.entries.get(tmp) });
    guardOutput(lease, journal, tmp);
    check(objectId(stat(tmp)) === journal.entries.get(tmp).id, 'temporary package exchanged');
    await unlink(tmp);
    journal.entries.delete(tmp);
    const actual = await readLeased(lease, path, limits.packageBytes);
    check(actual.data.equals(data), 'package output readback mismatch');
  });
}
async function createTree(lease, journal, materials, files) {
  for (const dir of runtimeDirectories(materials)) {
    const path = join(journal.path, dir);
    guardOutput(lease, journal, path);
    await mkdir(path, { mode: 0o700 });
    const entry = { directory: true };
    journal.entries.set(path, entry);
    guardOutput(lease, journal, path);
    const info = stat(path);
    requireOwnedDirectory(info);
    entry.id = objectId(info);
  }
  for (const r of materials) await writeNew(lease, journal, join(journal.path, r.path), files.get(r.path), parseInt(r.mode.slice(3), 8), r.sha256);
}
export async function stageVerifiedEmittedRuntime(receipt, { staging, destination }) {
  const record = verified.get(receipt);
  check(record && record.staging === staging, 'genuine verified receipt and bound staging required');
  const capture = await writeUnderLease(staging, 'stage', destination, receipt.packageSha256, async (lease, journal) => {
    checkLeaf(lease, record.path, record.binding);
    const { data } = await readLeased(lease, record.path, limits.packageBytes);
    const { files } = decodePackage(data, record.pins.expected, record.pins.policy);
    await createTree(lease, journal, receipt.materials, files);
    const tree = await readTree(lease, destination);
    compareTree(tree, receipt.materials);
    checkLeaf(lease, record.path, record.binding);
    return { nodes: tree.nodes, boundary: tree.boundary, leaseRoot: lease.root };
  });
  const token = freeze({ packageSha256: receipt.packageSha256, materialSha256: receipt.materialSha256 });
  staged.set(token, { receipt, destination, capture });
  return token;
}

export async function withStagedEmittedRuntime(receipt, token, use) {
  const record = verified.get(receipt);
  const stage = staged.get(token);
  check(record && stage?.receipt === receipt && typeof use === 'function', 'matching genuine stage and verified receipt required');
  return leased(record.staging, async lease => {
    check(lease.root === stage.capture.leaseRoot, 'staging root changed');
    async function readback() {
      checkLeaf(lease, record.path, record.binding);
      const { data } = await readLeased(lease, record.path, limits.packageBytes);
      check(sha256(data) === receipt.packageSha256, 'staging package changed');
      compareTree(await readTree(lease, stage.destination, stage.capture), receipt.materials);
      checkLeaf(lease, record.path, record.binding);
    }
    await readback();
    const root = stage.destination;
    try {
      return await use(freeze({ root, entrypoints: Object.fromEntries(entryNames.map(name => [name, join(root, 'runtime', name + '.mjs')])),
        runtime: receipt.runtime, packageSha256: receipt.packageSha256, materialSha256: receipt.materialSha256, inventorySha256: receipt.inventorySha256 }));
    } finally { await readback(); }
  });
}
