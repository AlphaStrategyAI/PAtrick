#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { machine } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const recipePaths = ['scripts/build-runtime.mjs', 'deploy/lib/release.mjs', 'deploy/lib/deployment-templates.mjs'];
let LIMITS;
let validatePaths;
let canonicalize;
let deployment;
let admitReadRoot;
let readRegularFile;

async function loadRecipe(sourceRoot) {
  const script = fileURLToPath(import.meta.url);
  const checkout = resolve(dirname(script), '..');
  if ((sourceRoot !== undefined && sourceRoot !== checkout) || script !== resolve(checkout, recipePaths[0])) {
    fail('RUNTIME_BUILD_RECIPE_MISMATCH');
  }
  const observed = new Map();
  for (const path of recipePaths) {
    const absolute = resolve(checkout, path);
    const info = await regularFile(absolute);
    if (await realpath(absolute) !== absolute || info.size > 1024 * 1024) fail('RUNTIME_BUILD_RECIPE_MISMATCH');
    observed.set(path, sha256(await readFile(absolute)));
  }
  const helper = await import(pathToFileURL(resolve(checkout, recipePaths[1])).href);
  deployment = await import(pathToFileURL(resolve(checkout, recipePaths[2])).href);
  LIMITS = helper.RELEASE_LIMITS;
  validatePaths = helper.validatePaths;
  canonicalize = helper.canonicalize;
  admitReadRoot = helper.admitReadRoot;
  readRegularFile = helper.readRegularFile;
  await verifyRecipe(checkout, observed);
  return observed;
}

async function verifyRecipe(root, expected, snapshot) {
  for (const [path, sha] of expected) {
    const absolute = resolve(root, path);
    if (await realpath(absolute) !== absolute || sha256(await readFile(absolute)) !== sha ||
        (snapshot && snapshot.files.find((file) => file.path === path)?.sha !== sha)) {
      fail('RUNTIME_BUILD_RECIPE_MISMATCH');
    }
  }
}
const entries = Object.freeze({
  composition: 'deploy/runtime/composition.ts',
  service: 'deploy/runtime/service.ts',
  cli: 'deploy/runtime/cli.ts',
  worker: 'deploy/runtime/worker.ts',
});
const designPath = 'docs/designs/设计资产/v2/';
const sourceRoots = Object.freeze([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'apps/service/package.json',
  'apps/service/src',
  'apps/web/index.html',
  'apps/web/package.json',
  'apps/web/public',
  'apps/web/src',
  'apps/web/tsconfig.json',
  'deploy/cli',
  'deploy/lib',
  'deploy/obsidian',
  designPath + 'icons',
  designPath + 'logo-curious-p.svg',
  ...Object.values(entries),
  'deploy/runtime/lifecycle-generation.ts',
  'deploy/runtime/lifecycle-journal.ts',
  'deploy/runtime/install-preview.ts',
  'deploy/runtime/role-launch.ts',
  'deploy/runtime/hub-process.ts',
  'deploy/runtime/vault-init.ts',
  'deploy/runtime/vault-init-cli.ts',
  'scripts/build-runtime.mjs',
  'packages',
]);
const runtimePackages = Object.freeze({
  'better-sqlite3': [
    'LICENSE',
    'package.json',
    'lib',
    'build/Release/better_sqlite3.node',
  ],
  bindings: ['LICENSE.md', 'package.json', 'bindings.js'],
  'file-uri-to-path': ['LICENSE', 'package.json', 'index.js'],
});
const runtimeVersions = Object.freeze({
  'better-sqlite3': '12.11.1',
  bindings: '1.5.0',
  'file-uri-to-path': '1.0.0',
});
const nativePath = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';
const inventoryFile = 'metadata/runtime-materials.json';
const digestPattern = /^[a-f0-9]{64}$/;
const gitHashPattern = /^[a-f0-9]{40}$/;
const workspaceDirectories = [
  'apps/service', 'packages/contracts', 'packages/domain', 'packages/executor',
  'packages/host', 'packages/integrations', 'packages/storage',
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(code) {
  throw new Error(code);
}

function parse(command, argv) {
  const required = command === 'verify'
    ? ['artifact-root']
    : ['source-root', 'source-commit', ...(command === 'build' ? ['output-root'] : [])];
  const allowed = new Set([...required, 'profile', ...(command === 'build' ?
    ['source-snapshot', 'directory-authority', 'directory-authority-sha256', 'node-headers', 'autoloop-root'] : [])]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || !allowed.has(flag.slice(2)) || value === undefined ||
        value.startsWith('--') || Object.hasOwn(values, flag.slice(2))) {
      fail('RUNTIME_BUILD_ARGUMENT_INVALID');
    }
    values[flag.slice(2)] = value;
  }
  if (required.some((flag) => !Object.hasOwn(values, flag))) {
    fail('RUNTIME_BUILD_ARGUMENT_INVALID');
  }
  return values;
}

function validateMaterialPaths(paths) {
  try { validatePaths(paths); }
  catch { fail('RUNTIME_MATERIAL_PATH_INVALID'); }
}

async function physicalDirectory(path, code) {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path ||
      !(await lstat(path)).isDirectory()) fail(code);
  return path;
}

async function regularFile(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) fail('RUNTIME_MATERIAL_SYMLINK');
  if (!info.isFile()) fail('RUNTIME_MATERIAL_TYPE_INVALID');
  return info;
}

async function walk(root, prefix = '') {
  const directory = resolve(root, prefix);
  const info = await lstat(directory);
  if (info.isSymbolicLink()) fail('RUNTIME_MATERIAL_SYMLINK');
  if (info.isFile()) return [prefix];
  if (!info.isDirectory()) fail('RUNTIME_MATERIAL_TYPE_INVALID');
  const names = (await readdir(directory)).sort();
  if (!names.length) fail('RUNTIME_MATERIAL_EXTRA');
  const files = [];
  for (const name of names) {
    const child = prefix ? `${prefix}/${name}` : name;
    const childInfo = await lstat(resolve(root, child));
    if (childInfo.isSymbolicLink()) fail('RUNTIME_MATERIAL_SYMLINK');
    if (childInfo.isDirectory()) files.push(...await walk(root, child));
    else if (childInfo.isFile()) files.push(child);
    else fail('RUNTIME_MATERIAL_TYPE_INVALID');
  }
  return files;
}

async function copyRegular(source, destination) {
  const info = await regularFile(source);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, info.mode & 0o111 ? 0o755 : 0o644);
}

async function copyAutoloopHub(sourceRoot, materialRoot) {
  const root = admitReadRoot(sourceRoot);
  const hub = deployment.autoloopHub;
  for (const [path, digest] of Object.entries(hub.files)) {
    const source = resolve(root.root, path);
    const bytes = await readRegularFile(source, 128 * 1024, root);
    if (sha256(bytes) !== digest) fail('AUTOLOOP_HUB_SOURCE_MISMATCH');
    const destination = resolve(materialRoot, hub.root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o644 });
  }
}

async function copySelected(sourceRoot, destinationRoot, selected) {
  for (const selectedPath of selected) {
    const source = resolve(sourceRoot, selectedPath);
    const info = await lstat(source);
    if (info.isSymbolicLink()) fail('RUNTIME_MATERIAL_SYMLINK');
    if (info.isFile()) {
      await copyRegular(source, resolve(destinationRoot, selectedPath));
      continue;
    }
    if (!info.isDirectory()) fail('RUNTIME_MATERIAL_TYPE_INVALID');
    for (const file of await walk(source)) {
      await copyRegular(resolve(source, file), resolve(destinationRoot, selectedPath, file));
    }
  }
}

function readGit(root, args) {
  const result = spawnSync('/usr/bin/git', ['--no-replace-objects', '-C', root, ...args], {
    env: {
      PATH: '/usr/bin:/bin',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
    },
    maxBuffer: LIMITS.artifactBytes,
    timeout: 30_000,
  });
  if (result.status !== 0) fail('RUNTIME_SOURCE_COMMIT_INVALID');
  return result.stdout;
}

function sourceTree(root, commit, templatePaths) {
  if (!gitHashPattern.test(commit) ||
      readGit(root, ['rev-parse', '--verify', commit + '^{commit}']).toString().trim() !== commit) {
    fail('RUNTIME_SOURCE_COMMIT_INVALID');
  }
  const gitRoot = readGit(root, ['rev-parse', '--show-toplevel']).toString().trim();
  if (gitRoot !== root) fail('RUNTIME_SOURCE_ROOT_INVALID');
  const tree = readGit(root, ['ls-tree', '-rz', '--full-tree', commit, '--', ...sourceRoots, ...templatePaths]);
  const committed = new Map();
  for (const row of tree.toString().split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
    if (!match) fail('RUNTIME_SOURCE_TYPE_INVALID');
    committed.set(match[3], { mode: match[1], blob: match[2] });
  }
  return committed;
}

async function captureSource(root, commit, profile) {
  if (Object.keys(process.env).some((name) => name.startsWith('GIT_') && name !== 'GIT_PAGER')) {
    fail('RUNTIME_GIT_ENVIRONMENT_FORBIDDEN');
  }
  await physicalDirectory(root, 'RUNTIME_SOURCE_ROOT_INVALID');
  const preflight = deployment.servicePreflight;
  const templatePaths = deployment.completeProfile(profile) ? [...Object.values(deployment.deploymentPaths), preflight.source] : [];
  const committed = sourceTree(root, commit, templatePaths);
  const allowedAdditions = [...Object.values(entries), ...recipePaths, 'deploy/lib/deployment-templates.d.mts',
    'deploy/runtime/vault-init-cli.ts', 'deploy/runtime/role-launch.ts', 'deploy/runtime/hub-process.ts', ...templatePaths];
  const paths = [...new Set([...committed.keys(), ...allowedAdditions])].sort();
  // The reviewed Web source imports SVGs from this single non-ASCII directory.
  // All other source paths and the emitted inventory retain the portable path allowlist.
  validateMaterialPaths(paths.map((path) => path.replace(designPath, 'docs/designs/artwork/v2/')).sort());
  if (paths.length > LIMITS.files) fail('RUNTIME_SOURCE_LIMIT');
  let total = 0;
  let changed = false;
  const files = [];
  for (const path of paths) {
    const absolute = resolve(root, path);
    if (await realpath(absolute) !== absolute) fail('RUNTIME_SOURCE_SYMLINK');
    const info = await regularFile(absolute);
    if (info.size > LIMITS.artifactBytes || total + info.size > LIMITS.totalBytes) fail('RUNTIME_SOURCE_LIMIT');
    const bytes = await readFile(absolute);
    const after = await regularFile(absolute);
    if (after.dev !== info.dev || after.ino !== info.ino || after.size !== bytes.length ||
        after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) fail('RUNTIME_SOURCE_CHANGED');
    total += bytes.length;
    const mode = info.mode & 0o111 ? '100755' : '100644';
    const sha = sha256(bytes);
    if (templatePaths.includes(path)) {
      if (info.nlink !== 1) fail('RUNTIME_TEMPLATE_ALIAS');
      deployment.checkDeploymentRecord(profile, path === preflight.source ? preflight.path : path, fileMode(info), sha);
    }
    const blob = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
    const prior = committed.get(path);
    if (profile === deployment.nativeProfile && deployment.nativeSources.includes(path) &&
        (prior?.blob !== blob || prior?.mode !== '100644' || mode !== '100644')) fail('RUNTIME_DIRECTORY_SOURCE_UNCOMMITTED');
    changed ||= prior?.blob !== blob || prior?.mode !== mode;
    files.push({ path, bytes, mode, sha });
  }
  const digest = sha256(JSON.stringify(files.map(({ path, mode, sha }) => [path, mode, sha])));
  return { files, changed, digest };
}

async function materializeSource(snapshot, sourceRoot) {
  for (const { path, bytes, mode } of snapshot.files) {
    const destination = resolve(sourceRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx', mode: mode === '100755' ? 0o755 : 0o644 });
  }
}

// Admitted workspace sources have no fallback link to the original checkout.
// Only separate, installed non-workspace tool/dependency packages may be linked.
async function linkBuildDependencies(sourceRoot, toolRoot, lock) {
  for (const [path, info] of Object.entries(lock.packages)) {
    if (!/^node_modules\/(?:@[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9_.-]*$/.test(path) ||
        path.startsWith('node_modules/@patrick/') || info.link) continue;
    const installed = resolve(toolRoot, path);
    const stat = await lstat(installed).catch((error) => {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!stat) continue; // npm omits incompatible platform-specific optional dependencies.
    if (!stat.isDirectory() || await realpath(installed) !== installed) fail('RUNTIME_DEPENDENCY_ROOT_INVALID');
    const destination = resolve(sourceRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(installed, destination, 'dir');
  }
}

async function workspaceExports(sourceRoot) {
  const result = new Map();
  for (const path of workspaceDirectories) {
    const workspace = resolve(sourceRoot, path);
    const pkg = JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8'));
    for (const [key, target] of Object.entries(pkg.exports)) {
      if (typeof target !== 'string' || !target.startsWith('./') ||
          !resolve(workspace, target).startsWith(workspace + sep)) fail('RUNTIME_WORKSPACE_EXPORT_INVALID');
      const name = key === '.' ? pkg.name : pkg.name + key.slice(1);
      result.set(name, resolve(workspace, target));
    }
  }
  return result;
}

async function readMigrations(source) {
  const manifestBytes = await readFile(resolve(source, 'manifest.json'));
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    fail('MIGRATION_MANIFEST_INVALID');
  }
  if (!Array.isArray(manifest) || manifest.length < 1 || manifest.length > 128) {
    fail('MIGRATION_MANIFEST_INVALID');
  }
  const names = new Set();
  for (const entry of manifest) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'file,sha256' ||
        !/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(entry.file) ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) || names.has(entry.file)) {
      fail('MIGRATION_MANIFEST_INVALID');
    }
    names.add(entry.file);
    const bytes = await readFile(resolve(source, entry.file));
    if (sha256(bytes) !== entry.sha256) fail('MIGRATION_HASH_MISMATCH');
  }
  names.add('manifest.json');
  const actual = await readdir(source);
  if (actual.length !== names.size || actual.some((name) => !names.has(name))) fail('MIGRATION_MANIFEST_INCOMPLETE');
  return [...names];
}

async function copyMigrations(sourceRoot, outputRoot) {
  const source = resolve(sourceRoot, 'packages/storage/migrations');
  for (const path of await readMigrations(source)) {
    await copyRegular(resolve(source, path), resolve(outputRoot, 'migrations', path));
  }
}

async function loadTool(toolRoot, lock, location, version, entry) {
  const directory = await physicalDirectory(resolve(toolRoot, location), 'RUNTIME_TOOL_ROOT_INVALID');
  const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  if (lock.packages?.[location]?.version !== version || pkg.version !== version) fail('RUNTIME_TOOL_VERSION_MISMATCH');
  const executable = resolve(directory, entry);
  if (await realpath(executable) !== executable) fail('RUNTIME_TOOL_ENTRY_INVALID');
  return import(pathToFileURL(executable).href);
}

async function buildWeb(sourceRoot, outputRoot, vite, exports) {
  await vite.build({
    root: resolve(sourceRoot, 'apps/web'),
    configFile: false,
    envFile: false,
    mode: 'production',
    logLevel: 'silent',
    publicDir: resolve(sourceRoot, 'apps/web/public'),
    esbuild: { jsx: 'automatic' },
    css: { postcss: {} },
    resolve: {
      preserveSymlinks: true,
      alias: [...exports].filter(([name]) => name.startsWith('@patrick/contracts'))
        .map(([name, replacement]) => ({ find: new RegExp('^' + name + '$'), replacement })),
    },
    build: {
      outDir: resolve(outputRoot, 'web'),
      emptyOutDir: true,
      sourcemap: false,
      target: 'es2022',
      minify: 'esbuild',
      cssCodeSplit: true,
    },
  });
}

async function copyRuntimePackages(toolRoot, outputRoot, lock) {
  for (const [name, selected] of Object.entries(runtimePackages)) {
    const source = await physicalDirectory(resolve(toolRoot, 'node_modules', name), 'RUNTIME_DEPENDENCY_ROOT_INVALID');
    const destination = resolve(outputRoot, 'node_modules', name);
    const packageJson = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'));
    const expected = runtimeVersions[name];
    if (packageJson.version !== expected || lock.packages?.['node_modules/' + name]?.version !== expected) {
      fail('RUNTIME_DEPENDENCY_VERSION_MISMATCH');
    }
    for (const path of selected) {
      const absolute = resolve(source, path);
      if (await realpath(absolute) !== absolute) fail('RUNTIME_MATERIAL_SYMLINK');
    }
    await copySelected(source, destination, selected);
  }
}

async function npmVersion(staging) {
  const npm = await realpath(resolve(dirname(process.execPath), 'npm'));
  if (basename(npm) !== 'npm-cli.js') fail('RUNTIME_NPM_VERSION_UNAVAILABLE');
  const observed = spawnSync(process.execPath, [npm, '--global', '--version'], {
    cwd: staging,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', npm_config_userconfig: resolve(staging, 'npmrc'), npm_config_globalconfig: '/dev/null' },
    timeout: 10_000,
  });
  if (observed.status !== 0 || !/^\d+\.\d+\.\d+$/.test(observed.stdout.trim())) {
    fail('RUNTIME_NPM_VERSION_UNAVAILABLE');
  }
  return observed.stdout.trim();
}

function nativeIdentity(bytes) {
  const arches = new Map([[0x01000007, 'x64'], [0x0100000c, 'arm64']]);
  const magic = bytes.subarray(0, 4).toString('hex');
  if (bytes.length >= 20 && magic === 'cffaedfe') {
    return { format: 'mach-o', architecture: arches.get(bytes.readUInt32LE(4)) };
  }
  if (bytes.length >= 20 && magic === '7f454c46' && bytes[4] === 2 && bytes[5] === 1) {
    const machine = bytes.readUInt16LE(18);
    return { format: 'elf', architecture: new Map([[62, 'x64'], [183, 'arm64']]).get(machine) };
  }
  fail('RUNTIME_NATIVE_FORMAT_INVALID');
}

function nativeLoad(outputRoot) {
  const probe = `
    import { createRequire } from 'node:module';
    import { join } from 'node:path';
    const require = createRequire(join(process.cwd(), 'runtime-native-probe.cjs'));
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    const sqlite = db.prepare('SELECT sqlite_version() version').get().version;
    db.close();
    process.stdout.write(JSON.stringify({sqlite, resolved: require.resolve('better-sqlite3')}) + '\\n');
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
    cwd: outputRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      NODE_OPTIONS: '',
      NODE_PATH: '',
    },
    timeout: 30_000,
  });
  if (run.status !== 0) fail('RUNTIME_NATIVE_LOAD_FAILED');
  let result;
  try {
    result = JSON.parse(run.stdout);
  } catch {
    fail('RUNTIME_NATIVE_LOAD_FAILED');
  }
  if (!result.resolved.startsWith(resolve(outputRoot, 'node_modules') + sep)) {
    fail('RUNTIME_NATIVE_RESOLUTION_ESCAPE');
  }
  return result;
}

function role(path, profile) {
  if (profile === deployment.nativeProfile && path === deployment.directoryPath) return deployment.directoryRole;
  if (deployment.completeProfile(profile) && deployment.deploymentRole(path)) return deployment.deploymentRole(path);
  if (/^runtime\/(composition|service|cli|worker)\.mjs$/.test(path)) return 'runtime-entry';
  if (/^runtime\/chunk-[A-Z0-9]+\.mjs$/.test(path)) return 'runtime-shared-chunk';
  if (path === 'migrations/manifest.json') return 'storage-migration-manifest';
  if (/^migrations\/[0-9]{4}_[a-z0-9_]+\.sql$/.test(path)) return 'storage-migration';
  if (path === 'web/index.html') return 'web-entry';
  if (path.startsWith('web/')) {
    if (deployment.completeProfile(profile) &&
        !/^web\/(?:assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2?)|fonts\/[A-Za-z0-9_./-]+\.(?:woff2?|txt))$/.test(path)) {
      fail('RUNTIME_MATERIAL_ROLE_UNKNOWN');
    }
    return 'web-asset';
  }
  if (path === nativePath) return 'native-addon';
  const [, pkg, filename] = path.split('/');
  if (path.startsWith('node_modules/') && Object.hasOwn(runtimePackages, pkg) && runtimePackages[pkg].includes(filename) && path.split('/').length === 3) {
    if (filename === 'package.json') return 'runtime-package-metadata';
    if (filename === 'LICENSE' || filename === 'LICENSE.md') return 'runtime-package-license';
  }
  if (/^node_modules\/(?:better-sqlite3\/lib\/.+\.js|bindings\/bindings\.js|file-uri-to-path\/index\.js)$/.test(path)) return 'runtime-package-code';
  fail('RUNTIME_MATERIAL_ROLE_UNKNOWN');
}

async function materialRecords(root, profile) {
  const paths = (await walk(root)).filter((path) => path !== inventoryFile).sort();
  validateMaterialPaths(paths);
  deployment.hasAutoloopHub(paths);
  if (paths.length > LIMITS.files) fail('RUNTIME_MATERIAL_LIMIT');
  const records = [];
  let total = 0;
  for (const path of paths) {
    const absolute = resolve(root, path);
    const info = await regularFile(absolute);
    if (info.size > LIMITS.artifactBytes) fail('RUNTIME_MATERIAL_LIMIT');
    total += info.size;
    if (total > LIMITS.totalBytes) fail('RUNTIME_MATERIAL_LIMIT');
    const digest = sha256(await readFile(absolute));
    const mode = fileMode(info);
    if (deployment.deploymentRole(path) && info.nlink !== 1) fail('RUNTIME_TEMPLATE_ALIAS');
    deployment.checkDeploymentRecord(profile, path, mode, digest);
    records.push({
      path,
      role: role(path, profile),
      bytes: info.size,
      sha256: digest,
      mode,
    });
  }
  return records;
}

function fileMode(info) {
  const mode = (info.mode & 0o7777).toString(8);
  if (mode !== '644' && mode !== '755') fail('RUNTIME_MATERIAL_MODE_INVALID');
  return '100' + mode;
}

async function verifyArtifact(root, profile) {
  await physicalDirectory(root, 'RUNTIME_ARTIFACT_ROOT_INVALID');
  const inventoryPath = resolve(root, inventoryFile);
  const info = await regularFile(inventoryPath);
  if (await realpath(inventoryPath) !== inventoryPath) fail('RUNTIME_MATERIAL_SYMLINK');
  if (info.size > LIMITS.artifactBytes || fileMode(info) !== '100644') fail('RUNTIME_INVENTORY_INVALID');
  const inventoryBytes = await readFile(inventoryPath);
  let inventory;
  try { inventory = JSON.parse(inventoryBytes.toString('utf8')); }
  catch { fail('RUNTIME_INVENTORY_INVALID'); }
  const complete = deployment.completeProfile(profile);
  const v3 = profile === deployment.nativeProfile;
  if (inventory?.schemaVersion !== deployment.inventoryVersion(profile) ||
      (complete ? inventory.profile !== profile : Object.hasOwn(inventory, 'profile')) || inventory?.materialKind !== 'emitted-runtime-materials' ||
      !Array.isArray(inventory.files) || inventory.files.length > LIMITS.files) fail('RUNTIME_INVENTORY_INVALID');
  const expectedPaths = inventory.files.map((record) => record?.path);
  validateMaterialPaths(expectedPaths);
  const { source, native, observed, tools } = inventory;
  const keys = value => value && Object.keys(value).sort().join(' ');
  const commonKeys = 'files materialKind native observed packages';
  const inventoryKeys = (v3 ? 'directoryBuildSha256 directoryNative ' : '') + commonKeys +
    (complete ? ' profile' : '') + ' schemaVersion source tools';
  if (keys(inventory) !== inventoryKeys || keys(source) !== 'commit kind lockSha256 snapshotSha256' ||
      keys(tools) !== 'esbuild vite' || keys(observed) !== (v3 ? 'arch modules napi node npm platform' : 'arch modules node npm platform') ||
      keys(native) !== 'architecture bytes format observedArchitecture observedLoad observedModules observedNode path sha256 sqlite') {
    fail('RUNTIME_INVENTORY_INVALID');
  }
  if (v3) deployment.checkDirectoryTarget({ os: observed.platform, arch: observed.arch });
  if (native.format !== (observed.platform === 'darwin' ? 'mach-o' : 'elf')) fail('RUNTIME_NATIVE_PLATFORM_MISMATCH');
  if (!gitHashPattern.test(source?.commit) || !digestPattern.test(source?.snapshotSha256) ||
      !digestPattern.test(source?.lockSha256) || !['commit', 'pinned-snapshot'].includes(source?.kind) ||
      tools?.esbuild !== '0.28.2' || tools?.vite !== '7.3.8' ||
      !['darwin', 'linux'].includes(observed?.platform) || !['x64', 'arm64'].includes(observed?.arch) ||
      !/^v\d+\.\d+\.\d+$/.test(observed?.node) || !/^\d+$/.test(observed?.modules) ||
      !/^\d+\.\d+\.\d+$/.test(observed?.npm) || native?.path !== nativePath ||
      native.architecture !== observed.arch || native.observedArchitecture !== observed.arch ||
      native.observedNode !== observed.node || native.observedModules !== observed.modules ||
      native.observedLoad !== true || !/^\d+\.\d+\.\d+$/.test(native.sqlite) ||
      JSON.stringify(inventory.packages) !== JSON.stringify(packageInventory())) fail('RUNTIME_INVENTORY_INVALID');
  const actualPaths = (await walk(root)).filter((path) => path !== inventoryFile).sort();
  const expected = new Set(expectedPaths);
  const actualSet = new Set(actualPaths);
  if (expectedPaths.some((path) => !actualSet.has(path))) fail('RUNTIME_MATERIAL_MISSING');
  if (actualPaths.some((path) => !expected.has(path))) fail('RUNTIME_MATERIAL_EXTRA');
  const required = [
    ...(complete ? Object.values(deployment.deploymentPaths) : []),
    ...(v3 ? [deployment.directoryPath] : []),
    ...Object.keys(entries).map((name) => 'runtime/' + name + '.mjs'),
    'migrations/manifest.json',
    'web/index.html',
    'node_modules/better-sqlite3/lib/index.js',
    nativePath,
    ...Object.entries(runtimePackages).flatMap(([name, items]) => items.filter((path) => path !== 'lib')
      .map((path) => 'node_modules/' + name + '/' + path)),
  ];
  if (required.some((path) => !actualSet.has(path)) ||
      !actualPaths.some((path) => path.startsWith('runtime/chunk-')) ||
      !actualPaths.some((path) => path.startsWith('web/assets/'))) fail('RUNTIME_MATERIAL_MISSING');
  const actual = await materialRecords(root, profile);
  if (JSON.stringify(actual) !== JSON.stringify(inventory.files)) fail('RUNTIME_MATERIAL_MISMATCH');
  await readMigrations(resolve(root, 'migrations'));
  for (const [name, version] of Object.entries(runtimeVersions)) {
    const installed = JSON.parse(await readFile(resolve(root, 'node_modules', name, 'package.json'), 'utf8'));
    if (installed.name !== name || installed.version !== version) fail('RUNTIME_DEPENDENCY_VERSION_MISMATCH');
  }
  const addon = actual.find((record) => record.path === nativePath);
  const nativeBytes = await readFile(resolve(root, nativePath));
  if (v3) {
    const directory = actual.find(row => row.path === deployment.directoryPath);
    const expected = deployment.directoryIdentity(await readFile(resolve(root, deployment.directoryPath)), observed.arch);
    if (observed.platform !== 'darwin' || observed.node !== 'v26.13.0' || observed.modules !== '147' ||
        observed.napi !== '10' || canonicalize(expected) !== canonicalize(inventory.directoryNative) ||
        directory.mode !== '100755' || addon.mode !== '100755' || !digestPattern.test(inventory.directoryBuildSha256)) fail('RUNTIME_INVENTORY_INVALID');
  }
  const architecture = nativeIdentity(nativeBytes);
  if (addon.sha256 !== native.sha256 || addon.bytes !== native.bytes ||
      architecture.format !== native.format || architecture.architecture !== native.architecture) {
    fail('RUNTIME_NATIVE_INVENTORY_MISMATCH');
  }
  const bytes = actual.reduce((sum, record) => sum + record.bytes, 0);
  if (bytes + inventoryBytes.length > LIMITS.totalBytes || actual.length + 1 > LIMITS.files ||
      Math.ceil((bytes + inventoryBytes.length) / 3) * 4 > LIMITS.packageBytes) fail('RUNTIME_MATERIAL_LIMIT');
  return {
    status: 'verified', profile,
    files: actual.length,
    bytes,
    inventoryBytes: inventoryBytes.length,
    inventorySha256: sha256(inventoryBytes),
  };
}

function packageInventory() {
  return Object.entries(runtimeVersions).map(([name, version]) => ({ name, version }));
}

// The caller supplies a separately approved canonical recipe and SQLite observation.
// The candidate has no input into the selection of these bytes or their digest.
async function readDirectoryAuthority(values, buildHost) {
  const path = values['directory-authority'], pin = values['directory-authority-sha256'];
  if (!path || !digestPattern.test(pin) || !values['node-headers']) fail('RUNTIME_DIRECTORY_AUTHORITY_REQUIRED');
  // The builder always targets the running Node architecture. The approved
  // host additionally binds the machine reported by the operating system.
  const target = { os: buildHost.os, arch: buildHost.processArch };
  deployment.checkDirectoryTarget(target);
  if (process.version !== 'v26.13.0' || process.versions.modules !== '147' || process.versions.napi !== '10') fail('RUNTIME_DIRECTORY_TARGET_UNSUPPORTED');
  const info = await regularFile(path);
  if (info.size > LIMITS.artifactBytes) fail('RUNTIME_DIRECTORY_AUTHORITY_INVALID');
  const raw = await readFile(path);
  if (sha256(raw) !== pin) fail('RUNTIME_DIRECTORY_AUTHORITY_MISMATCH');
  const authority = JSON.parse(raw.toString('utf8'));
  if (canonicalize(authority) !== raw.toString('utf8')) fail('RUNTIME_DIRECTORY_AUTHORITY_INVALID');
  deployment.checkDirectoryAuthority(authority, target, buildHost);
  return authority;
}

async function buildDirectoryModule(staging, values, authority, buildHost, snapshot) {
  const developer = '/Library/Developer/CommandLineTools';
  const sdk = join(developer, 'SDKs/MacOSX27.0.sdk');
  const resource = join(developer, 'usr/lib/clang/21/include');
  const linkerRoot = join(staging, 'approved-linker');
  const tools = { compiler: join(developer, 'usr/bin/clang++'), linker: join(linkerRoot, 'bin/ld'), nm: join(developer, 'usr/bin/nm') };
  for (const [key, path] of Object.entries({ compiler: tools.compiler, nm: tools.nm, node: process.execPath })) {
    if (sha256(await readFile(path)) !== authority.tools[key]) fail('RUNTIME_DIRECTORY_TOOL_MISMATCH');
  }
  // Snapshot the checked bytes together. The approved ld resolves its only
  // non-system dylibs relative to this exact private executable.
  await mkdir(join(linkerRoot, 'bin'), { recursive: true });
  await mkdir(join(linkerRoot, 'lib'));
  const linker = await readFile(join(developer, 'usr/bin/ld'));
  if (sha256(linker) !== authority.tools.linker) fail('RUNTIME_DIRECTORY_TOOL_MISMATCH');
  await writeFile(tools.linker, linker, { flag: 'wx', mode: 0o500 });
  for (const name of deployment.directoryLinkerLibraries) {
    const library = await readFile(join(developer, 'usr/lib', name));
    if (sha256(library) !== authority.linkerLibraries[name]) fail('RUNTIME_DIRECTORY_LINKER_LIBRARY_MISMATCH');
    await writeFile(join(linkerRoot, 'lib', name), library, { flag: 'wx', mode: 0o500 });
  }
  const archivePath = values['node-headers'];
  if ((await regularFile(archivePath)).size > LIMITS.artifactBytes) fail('RUNTIME_DIRECTORY_HEADERS_MISMATCH');
  const archive = await readFile(archivePath);
  if (sha256(archive) !== deployment.directoryHeadersSha256) fail('RUNTIME_DIRECTORY_HEADERS_MISMATCH');
  await writeFile(join(staging, 'headers.tar.xz'), archive, { flag: 'wx', mode: 0o600 });
  function run(tool, args) {
    const result = spawnSync(tool, args, { cwd: staging, timeout: 60_000, encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TMPDIR: staging, DEVELOPER_DIR: developer, ZERO_AR_DATE: '1' } });
    if (result.status !== 0) fail('RUNTIME_DIRECTORY_TOOL_FAILED');
    return result.stdout;
  }
  run('/usr/bin/tar', ['-xf', 'headers.tar.xz', 'node-v26.13.0/include/node']);
  for (const input of authority.inputs) {
    const slash = input.path.indexOf('/');
    const root = input.path.startsWith('sdk/') ? sdk : resource;
    const absolute = await realpath(join(root, input.path.slice(slash + 1)));
    if (!absolute.startsWith(root + sep) || (await regularFile(absolute)).size !== input.bytes) fail('RUNTIME_DIRECTORY_INPUT_MISMATCH');
    const bytes = await readFile(absolute);
    if (sha256(bytes) !== input.sha256) fail('RUNTIME_DIRECTORY_INPUT_MISMATCH');
    const destination = join(staging, 'tools', input.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o400 });
  }
  const sources = [];
  for (const path of deployment.nativeSources) {
    const input = snapshot.files.find(file => file.path === path);
    const bytes = await readFile(join(staging, 'inputs', path));
    if (input?.mode !== '100644' || input.sha !== sha256(bytes)) fail('RUNTIME_DIRECTORY_INPUT_MISMATCH');
    sources.push({ path, mode: input.mode, sha256: input.sha, bytes: bytes.length });
  }
  await mkdir(join(staging, 'materials/native'));
  const commands = deployment.directoryCommands(authority.target.arch);
  const objects = [];
  let exportLogSha256;
  for (const { tool, argv } of commands) {
    const stdout = run(tools[tool], argv);
    if (tool === 'compiler') {
      const path = argv.at(-1);
      const bytes = await readFile(join(staging, path));
      objects.push({ path, sha256: sha256(bytes), bytes: bytes.length });
    } else if (tool === 'nm') {
      if (stdout !== deployment.directoryExports.join('\n') + '\n') fail('RUNTIME_DIRECTORY_EXPORT_MISMATCH');
      exportLogSha256 = sha256(stdout);
    }
  }
  const outputPath = join(staging, 'materials', deployment.directoryPath);
  await chmod(outputPath, 0o755);
  const output = deployment.directoryIdentity(await readFile(outputPath), authority.target.arch);
  return { authority, authoritySha256: values['directory-authority-sha256'], buildHost, sources, commands, objects, exportLogSha256, output };
}

async function buildRuntime(values, recipe) {
  const profile = values.profile;
  const autoloopRoot = values['autoloop-root'];
  if (autoloopRoot !== undefined && !deployment.completeProfile(profile)) fail('RUNTIME_BUILD_ARGUMENT_INVALID');
  const v3 = profile === deployment.nativeProfile;
  const buildHost = v3 ? { os: process.platform, processArch: process.arch, machine: machine() } : undefined;
  const authority = v3 ? await readDirectoryAuthority(values, buildHost) : undefined;
  if (!v3 && ['directory-authority','directory-authority-sha256','node-headers'].some(key => Object.hasOwn(values, key))) fail('RUNTIME_BUILD_ARGUMENT_INVALID');
  const toolRoot = values['source-root'];
  const outputRoot = values['output-root'];
  const commit = values['source-commit'];
  const pinnedSnapshot = values['source-snapshot'];
  if (pinnedSnapshot !== undefined && !digestPattern.test(pinnedSnapshot)) fail('RUNTIME_BUILD_ARGUMENT_INVALID');
  const snapshot = await captureSource(toolRoot, commit, profile);
  await verifyRecipe(toolRoot, recipe, snapshot);
  if (pinnedSnapshot !== undefined ? pinnedSnapshot !== snapshot.digest : snapshot.changed) {
    fail('RUNTIME_SOURCE_SNAPSHOT_MISMATCH');
  }
  if (!isAbsolute(outputRoot) || resolve(outputRoot) !== outputRoot) fail('RUNTIME_BUILD_ARGUMENT_INVALID');
  const local = relative(toolRoot, outputRoot);
  if (local === '' || (!local.startsWith('..' + sep) && local !== '..')) fail('RUNTIME_OUTPUT_INSIDE_SOURCE');
  const outputParent = await physicalDirectory(dirname(outputRoot), 'RUNTIME_OUTPUT_PARENT_INVALID');
  const owner = await lstat(outputParent);
  if (owner.uid !== process.geteuid?.() || (owner.mode & 0o022) !== 0) fail('RUNTIME_OUTPUT_PARENT_NOT_EXCLUSIVE');
  try {
    await lstat(outputRoot);
    fail('RUNTIME_OUTPUT_EXISTS');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  process.umask(0o022);
  const staging = await mkdtemp(join(dirname(outputRoot), '.' + basename(outputRoot) + '-build-'));
  const sourceRoot = resolve(staging, 'inputs');
  const materials = resolve(staging, 'materials');
  try {
    await materializeSource(snapshot, sourceRoot);
    for (const name of Object.keys(process.env)) {
      if (/^(?:VITE_|ROLLUP_|BROWSERSLIST(?:_|$)|ESBUILD_BINARY_PATH$|NODE_ENV$)/.test(name)) delete process.env[name];
    }
    const lockBytes = await readFile(resolve(sourceRoot, 'package-lock.json'));
    const lock = JSON.parse(lockBytes.toString('utf8'));
    if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') fail('RUNTIME_LOCKFILE_INVALID');
    await linkBuildDependencies(sourceRoot, toolRoot, lock);
    const esbuild = await loadTool(toolRoot, lock, 'node_modules/esbuild', '0.28.2', 'lib/main.js');
    const vite = await loadTool(toolRoot, lock, 'apps/web/node_modules/vite', '7.3.8', 'dist/node/index.js');
    const exports = await workspaceExports(sourceRoot);
    await esbuild.build({
      absWorkingDir: sourceRoot,
      entryPoints: entries,
      outdir: resolve(materials, 'runtime'),
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'node',
      target: ['node26.13'],
      external: ['better-sqlite3'],
      preserveSymlinks: true,
      tsconfigRaw: { compilerOptions: {} },
      sourcemap: false,
      legalComments: 'eof',
      entryNames: '[name]',
      chunkNames: 'chunk-[hash]',
      outExtension: { '.js': '.mjs' },
      logLevel: 'silent',
      plugins: [{
        name: 'admitted-workspace',
        setup(build) {
          build.onResolve({ filter: /^@patrick\// }, ({ path }) => {
            const target = exports.get(path);
            return target ? { path: target } : { errors: [{ text: 'RUNTIME_WORKSPACE_EXPORT_UNKNOWN' }] };
          });
        },
      }],
    });
    if (deployment.completeProfile(profile)) {
      await copySelected(sourceRoot, materials, Object.values(deployment.deploymentPaths));
      const { source, path } = deployment.servicePreflight;
      await copyRegular(resolve(sourceRoot, source), resolve(materials, path));
      if (autoloopRoot !== undefined) await copyAutoloopHub(autoloopRoot, materials);
    }
    await copyMigrations(sourceRoot, materials);
    await buildWeb(sourceRoot, materials, vite, exports);
    await copyRuntimePackages(toolRoot, materials, lock);
    const nativeBytes = await readFile(resolve(materials, nativePath));
    const native = nativeIdentity(nativeBytes);
    if (native.architecture !== process.arch ||
        native.format !== (process.platform === 'darwin' ? 'mach-o' : 'elf')) fail('RUNTIME_NATIVE_ARCHITECTURE_MISMATCH');
    const directoryBuild = v3 ? await buildDirectoryModule(staging, values, authority, buildHost, snapshot) : undefined;
    const nativeObservation = v3 ? authority.sqliteObservation.native : nativeLoad(materials);
    const files = await materialRecords(materials, profile);
    if (v3 && (nativeObservation.sha256 !== sha256(nativeBytes) || nativeObservation.bytes !== nativeBytes.length ||
        authority.sqliteObservation.source.lockSha256 !== sha256(lockBytes) ||
        authority.sqliteObservation.packageFilesSha256 !== sha256(canonicalize(files.filter(file => file.path.startsWith('node_modules/')))))) {
      fail('RUNTIME_DIRECTORY_SQLITE_OBSERVATION_MISMATCH');
    }
    const inventory = {
      schemaVersion: deployment.inventoryVersion(profile),
      ...(deployment.completeProfile(profile) && { profile }),
      ...(v3 && { directoryNative: directoryBuild.output, directoryBuildSha256: sha256(canonicalize(directoryBuild)) }),
      materialKind: 'emitted-runtime-materials',
      source: {
        kind: pinnedSnapshot === undefined ? 'commit' : 'pinned-snapshot',
        commit,
        snapshotSha256: snapshot.digest,
        lockSha256: sha256(lockBytes),
      },
      tools: { esbuild: '0.28.2', vite: '7.3.8' },
      observed: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        modules: process.versions.modules,
        npm: await npmVersion(staging),
        ...(v3 && { napi: process.versions.napi }),
      },
      packages: packageInventory(),
      native: {
        path: nativePath,
        sha256: sha256(nativeBytes),
        bytes: nativeBytes.length,
        ...native,
        observedArchitecture: process.arch,
        observedNode: process.version,
        observedModules: process.versions.modules,
        observedLoad: true,
        sqlite: nativeObservation.sqlite,
      },
      files,
    };
    await mkdir(resolve(materials, 'metadata'), { recursive: true });
    await writeFile(resolve(materials, inventoryFile), JSON.stringify(inventory, null, 2) + '\n', {
      mode: 0o644, flag: 'wx',
    });
    await verifyArtifact(materials, profile);
    await verifyRecipe(toolRoot, recipe, snapshot);
    await rename(materials, outputRoot);
    const receipt = await verifyArtifact(outputRoot, profile);
    return {
      ...receipt,
      status: 'built',
      sourceCommit: commit,
      sourceSnapshotSha256: snapshot.digest,
      artifactRoot: outputRoot,
      ...(v3 && { directoryBuild }),
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH || process.execArgv.length) fail('RUNTIME_BUILD_LOADER_FORBIDDEN');
  const [command, ...argv] = process.argv.slice(2);
  if (!['build', 'snapshot', 'verify'].includes(command)) fail('RUNTIME_BUILD_ARGUMENT_INVALID');
  const values = parse(command, argv);
  const recipe = await loadRecipe(values['source-root']);
  values.profile = deployment.releaseProfile(values.profile);
  let result;
  if (command === 'snapshot') {
    const snapshot = await captureSource(values['source-root'], values['source-commit'], values.profile);
    await verifyRecipe(values['source-root'], recipe, snapshot);
    result = { status: 'captured', profile: values.profile, snapshotSha256: snapshot.digest, files: snapshot.files.length, changed: snapshot.changed };
  } else {
    result = command === 'build' ? await buildRuntime(values, recipe) : await verifyArtifact(values['artifact-root'], values.profile);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

main().catch((error) => {
  const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : 'RUNTIME_BUILD_FAILED';
  process.stderr.write(JSON.stringify({ status: 'failed', code }) + '\n');
  process.exitCode = 1;
});
