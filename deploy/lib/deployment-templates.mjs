import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

// This table belongs to the trusted builder/verifier. A new template revision
// needs review here as well as in the five material files.
export const deploymentPaths = Object.freeze({
  caddy: 'deploy/Caddyfile',
  service: 'deploy/launchd/com.patrick.service.plist',
  hub: 'deploy/launchd/com.patrick.autoloop-hub.plist',
  worker: 'deploy/launchd/com.patrick.autoloop-worker.plist',
  lima: 'deploy/lima/executor.yaml',
});
const templates = new Map([
  [deploymentPaths.caddy, ['caddy-template', '915c1bba63f43d6ba86fe5b4d2c475f5e8d084a8a6e12106248878edb711abfb']],
  [deploymentPaths.service, ['service-launchd-template', '4a1abcdf6623764e61d673295935df6c495a5461af2012b177a1ca166bb3d332']],
  [deploymentPaths.hub, ['hub-launchd-template', '57502d907c6d1c90c3c384d6ac46a2e15febdd7367583c3e1c315b1c2cf8a322']],
  [deploymentPaths.worker, ['worker-launchd-template', '72ef5cac63d4e326f0fc25b135eefd94c1dca4d57b9b1e404541e1dc12ce9d5d']],
  [deploymentPaths.lima, ['lima-executor-template', 'cc79f86740be5cc0c40d6ca82c2126c535bfa75fcb556854dea238fdf5676c45']],
]);
const byDigest = new Map([...templates].map(([path, [, digest]]) => [digest, path]));
const jobs = ['service', 'hub', 'worker'];

export const nativeProfile = 'deployment-complete-native-v3';
export const directoryPath = 'native/patrick-directory.node';
export const directoryRole = 'directory-diagnostic-addon';
export const nativeSources = Object.freeze(['directory-core.cc', 'directory-core.h', 'directory-module.cc']
  .map(name => 'packages/integrations/sources/native/' + name));
export const directoryHeadersSha256 = '4db1e4f2bc0a1787810a24a54e351e3e49889a13cbf987041a5d462c157fbf48';
export const directoryExports = Object.freeze(['_napi_register_module_v1', '_node_api_module_get_api_version_v1']);
export const directoryHandshake = Object.freeze({ format: 'patrick-directory-module', interfaceVersion: 1, napiVersion: 8 });
// Each entry is an independently reviewed build-host / output-target pair.
const directoryRecipes = new Map([
  ['arm64', {
    id: 'darwin-arm64-clt27-native-directory-v1', mode: 'native', clangArch: 'arm64',
    host: { os: 'darwin', processArch: 'arm64', machine: 'arm64' }, target: { os: 'darwin', arch: 'arm64' },
    linkerSha256: '374d9f0713bce2c8a9e1e82bde51615d5433516a10d99b63107eb6ee70542e4c',
  }],
]);
function directoryRecipe(target) {
  const recipe = directoryRecipes.get(target?.arch);
  if (!recipe || !isDeepStrictEqual(target, recipe.target)) throw new Error('RUNTIME_DIRECTORY_TARGET_UNAPPROVED');
  return recipe;
}
export function checkDirectoryTarget(target) { directoryRecipe(target); }
export const directoryLinkerLibraries = Object.freeze(['libLTO.dylib', 'libcodedirectory.dylib', 'libswiftDemangle.dylib', 'libtapi.dylib']);
const commandSizes = Object.freeze({ 2: 24, 11: 80, 29: 16, 38: 16, 41: 16,
  [0x80000022]: 48, [0x80000033]: 16, [0x80000034]: 16 });
const directoryLibraries = ['/usr/lib/libSystem.B.dylib', '/usr/lib/libc++.1.dylib'];
const sqlitePath = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';
const hashValue = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const byteCount = value => Number.isSafeInteger(value) && value > 0 && value <= 16 * 1024 * 1024;
function requireDirectory(value) { if (!value) throw new Error('RUNTIME_DIRECTORY_MATERIAL_INVALID'); }
export function completeProfile(profile) { return profile === 'deployment-complete' || profile === nativeProfile; }
export function inventoryVersion(profile) { return profile === nativeProfile ? 3 : profile === 'deployment-complete' ? 2 : 1; }

// Only normalized relative arguments reach the private compile directory. The
// compiler has no implicit host/system search paths. The linker sees two fixed stubs.
export function directoryCommands(arch) {
  const target = directoryRecipe({ os: 'darwin', arch }).clangArch;
  const compile = ['--no-default-config', '-target', target + '-apple-macos14.0', '-std=c++17',
    '-Wall', '-Wextra', '-Werror', '-fno-modules', '-fno-autolink', '-nostdinc', '-nostdinc++',
    '-isysroot', 'tools/sdk', '-isystem', 'tools/sdk/usr/include/c++/v1', '-isystem', 'tools/resource',
    '-isystem', 'tools/sdk/usr/include', '-I', 'node-v24.9.0/include/node', '-DNAPI_VERSION=8',
    '-fvisibility=hidden', '-fvisibility-inlines-hidden'];
  return [
    ...['directory-module', 'directory-core'].map(unit => ({ tool: 'compiler',
      argv: [...compile, '-c', 'inputs/packages/integrations/sources/native/' + unit + '.cc', '-o', unit + '.o'] })),
    { tool: 'linker', argv: ['-Z', '-arch', target, '-platform_version', 'macos', '14.0', '27.0',
      '-syslibroot', 'tools/sdk', '-no_uuid', '-bundle', '-undefined', 'dynamic_lookup',
      ...directoryExports.flatMap(symbol => ['-exported_symbol', symbol]), 'directory-module.o', 'directory-core.o',
      'tools/sdk/usr/lib/libSystem.B.tbd', 'tools/sdk/usr/lib/libc++.1.tbd', '-o', 'materials/' + directoryPath] },
    { tool: 'nm', argv: ['-gUj', 'materials/' + directoryPath] },
  ];
}

export function checkDirectoryAuthority(authority, target, buildHost) {
  const recipe = directoryRecipe(target);
  const libraries = authority?.linkerLibraries;
  if (!libraries || Object.getPrototypeOf(libraries) !== Object.prototype ||
      !isDeepStrictEqual(Object.keys(libraries).sort(), directoryLinkerLibraries) ||
      !Object.values(libraries).every(hashValue)) throw new Error('RUNTIME_DIRECTORY_LINKER_CLOSURE_INVALID');
  fields(authority, ['format', 'recipe', 'buildHost', 'buildMode', 'target', 'tools', 'linkerLibraries', 'inputs', 'headersSha256', 'sqliteObservation']);
  requireDirectory(authority.format === 'patrick-directory-build-authority-v3' && authority.recipe === recipe.id &&
    authority.headersSha256 === directoryHeadersSha256);
  if (authority.buildMode !== recipe.mode || !isDeepStrictEqual(authority.target, recipe.target) ||
      !isDeepStrictEqual(authority.buildHost, recipe.host) || !isDeepStrictEqual(buildHost, recipe.host)) {
    throw new Error('RUNTIME_DIRECTORY_RECIPE_TARGET_MISMATCH');
  }
  fields(authority.tools, ['node', 'compiler', 'linker', 'nm']);
  requireDirectory(authority.tools.linker === recipe.linkerSha256 && Object.values(authority.tools).every(hashValue) && Array.isArray(authority.inputs) &&
    authority.inputs.length > 0 && authority.inputs.length <= 8192);
  let prior = '', total = 0;
  for (const item of authority.inputs) {
    fields(item, ['path', 'bytes', 'sha256']);
    requireDirectory(typeof item.path === 'string' && item.path.length <= 512 && item.path > prior &&
      /^(?:(?:sdk\/usr\/include|resource)\/[\w.+/-]+|sdk\/(?:SDKSettings\.json|usr\/lib\/(?:libSystem\.B|libc\+\+\.1)\.tbd))$/.test(item.path) &&
      item.path.split('/').every(part => part && part !== '.' && part !== '..') &&
      byteCount(item.bytes) && (total += item.bytes) <= 128 * 1024 * 1024 && hashValue(item.sha256));
    prior = item.path;
  }
  for (const path of ['sdk/SDKSettings.json', 'sdk/usr/lib/libSystem.B.tbd', 'sdk/usr/lib/libc++.1.tbd'])
    requireDirectory(authority.inputs.some(item => item.path === path));
  const observation = authority.sqliteObservation;
  fields(observation, ['source', 'inventorySha256', 'packageFilesSha256', 'native']);
  fields(observation.source, ['kind', 'commit', 'snapshotSha256', 'lockSha256']);
  const native = observation.native;
  fields(native, ['path','sha256','bytes','format','architecture','observedArchitecture','observedNode','observedModules','observedLoad','sqlite']);
  requireDirectory(['commit','pinned-snapshot'].includes(observation.source.kind) && /^[a-f0-9]{40}$/.test(observation.source.commit) &&
    [observation.source.snapshotSha256, observation.source.lockSha256, observation.inventorySha256, observation.packageFilesSha256, native.sha256].every(hashValue) &&
    native.path === sqlitePath && native.format === 'mach-o' && native.architecture === target.arch &&
    native.observedArchitecture === target.arch && native.observedNode === 'v24.9.0' && native.observedModules === '137' &&
    native.observedLoad === true && byteCount(native.bytes) && /^\d+\.\d+\.\d+$/.test(native.sqlite));
}

// n_sect is a one-based ordinal across all LC_SEGMENT_64 commands. These
// two external functions must occupy file-backed instructions in __TEXT,__text.
export function checkDirectoryDefinition(sections, ordinal, value, headerEnd, fileSize) {
  requireDirectory(Number.isInteger(ordinal) && ordinal > 0 && ordinal <= sections.length);
  const section = sections[ordinal - 1], segment = section.segment;
  const segmentVmEnd = segment.address + segment.size;
  const segmentFileEnd = segment.fileOffset + segment.fileBytes;
  requireDirectory(segment.name === '__TEXT' && section.segmentName === segment.name && section.name === '__text' &&
    segment.protection === 5 && section.flags === 0x80000400 && segmentVmEnd <= (1n << 64n) &&
    segment.fileBytes <= segment.size && segmentFileEnd <= fileSize && section.size > 0n &&
    section.address >= segment.address && section.address + section.size <= segmentVmEnd &&
    section.fileOffset >= headerEnd && section.fileOffset >= segment.fileOffset &&
    section.fileOffset + section.size <= segmentFileEnd &&
    section.fileOffset - segment.fileOffset === section.address - segment.address &&
    value >= section.address && value < section.address + section.size);
}
function segmentSections(body, fileSize, sections) {
  requireDirectory(body.length >= 72 && body.length === 72 + body.readUInt32LE(64) * 80 &&
    sections.length + body.readUInt32LE(64) <= 255);
  const name = offset => body.subarray(offset, offset + 16).toString('latin1').replace(/\0+$/, '');
  const segment = { name: name(8), address: body.readBigUInt64LE(24), size: body.readBigUInt64LE(32),
    fileOffset: body.readBigUInt64LE(40), fileBytes: body.readBigUInt64LE(48), protection: body.readUInt32LE(60) };
  requireDirectory(segment.fileOffset + segment.fileBytes <= fileSize);
  for (let offset = 72; offset < body.length; offset += 80) {
    sections.push({ segment, name: name(offset), segmentName: name(offset + 16), address: body.readBigUInt64LE(offset + 32),
      size: body.readBigUInt64LE(offset + 40), fileOffset: BigInt(body.readUInt32LE(offset + 48)), flags: body.readUInt32LE(offset + 64) });
  }
}

// Parse only the thin, little-endian 64-bit bundle and allowlisted load
// commands emitted by this recipe. No host tool is invoked on candidate bytes.
export function directoryIdentity(data, arch) {
  requireDirectory(Buffer.isBuffer(data) && data.length >= 32 && ['arm64','x64'].includes(arch) &&
    data.readUInt32LE(0) === 0xfeedfacf && data.readUInt32LE(4) === (arch === 'arm64' ? 0x0100000c : 0x01000007) &&
    data.readUInt32LE(8) === (arch === 'arm64' ? 0 : 3) && data.readUInt32LE(12) === 8 && data.readUInt32LE(28) === 0);
  const count = data.readUInt32LE(16), end = 32 + data.readUInt32LE(20);
  requireDirectory(count > 0 && count <= 64 && end <= data.length);
  const libraries = [], sections = [];
  let offset = 32, platformSeen = false;
  const seen = new Set();
  let symbolTable, dynamicSymbols;
  for (let i = 0; i < count; i++) {
    requireDirectory(offset + 8 <= end);
    const cmd = data.readUInt32LE(offset), size = data.readUInt32LE(offset + 4);
    requireDirectory(size >= 8 && size % 8 === 0 && offset + size <= end);
    const body = data.subarray(offset, offset + size);
    if (cmd === 0xc) {
      requireDirectory(size >= 32 && body.readUInt32LE(8) === 24);
      const nul = body.indexOf(0, 24);
      requireDirectory(nul > 24 && body.subarray(nul).every(byte => byte === 0));
      libraries.push(body.subarray(24, nul).toString('latin1'));
    } else if (cmd === 0x32) {
      requireDirectory(!platformSeen && size >= 24 && size === 24 + body.readUInt32LE(20) * 8 &&
        body.readUInt32LE(8) === 1 && body.readUInt32LE(12) === 0x0e0000 && body.readUInt32LE(16) === 0x1b0000);
      platformSeen = true;
    } else if (cmd === 0x2a) { // LC_SOURCE_VERSION
      requireDirectory(size === 16 && body.readBigUInt64LE(8) === 0n && !seen.has(cmd));
    } else if (cmd === 0x19) {
      segmentSections(body, BigInt(data.length), sections);
    } else {
      requireDirectory(Object.hasOwn(commandSizes, cmd) && size === commandSizes[cmd] && !seen.has(cmd));
      if (cmd === 2) symbolTable = body;
      else if (cmd === 11) dynamicSymbols = body;
      else {
        for (let field = 8; field < size; field += 8)
          requireDirectory(body.readUInt32LE(field) + body.readUInt32LE(field + 4) <= data.length);
      }
    }
    seen.add(cmd);
    offset += size;
  }
  requireDirectory(offset === end && platformSeen && seen.has(0x19) && seen.has(2) && seen.has(11) &&
    isDeepStrictEqual(libraries.sort(), directoryLibraries));
  const symbolsStart = symbolTable.readUInt32LE(8), symbolsCount = symbolTable.readUInt32LE(12);
  const stringsStart = symbolTable.readUInt32LE(16), stringsSize = symbolTable.readUInt32LE(20);
  const externalStart = dynamicSymbols.readUInt32LE(16), externalCount = dynamicSymbols.readUInt32LE(20);
  requireDirectory(symbolsStart >= end && symbolsStart + symbolsCount * 16 <= data.length && stringsStart >= end &&
    stringsStart + stringsSize <= data.length && externalStart + externalCount <= symbolsCount && externalCount === directoryExports.length);
  const strings = data.subarray(stringsStart, stringsStart + stringsSize);
  const exports = [];
  for (let i = externalStart; i < externalStart + externalCount; i++) {
    const symbol = symbolsStart + i * 16, index = data.readUInt32LE(symbol);
    requireDirectory((data[symbol + 4] & 0xff) === 0x0f && index > 0 && index < strings.length);
    checkDirectoryDefinition(sections, data[symbol + 5], data.readBigUInt64LE(symbol + 8), BigInt(end), BigInt(data.length));
    const nul = strings.indexOf(0, index);
    requireDirectory(nul > index && nul - index <= 128);
    exports.push(strings.subarray(index, nul).toString('latin1'));
  }
  requireDirectory(isDeepStrictEqual(exports.sort(), directoryExports));
  return { path: directoryPath, role: directoryRole, mode: '100755', sha256: createHash('sha256').update(data).digest('hex'),
    bytes: data.length, format: 'mach-o', fileType: 'MH_BUNDLE', architecture: arch, deploymentTarget: '14.0',
    sdk: '27.0', dependencies: libraries, interfaceVersion: 1, napiVersion: 8 };
}

export function releaseProfile(value = 'runtime-only') {
  if (value !== 'runtime-only' && !completeProfile(value)) throw new Error('unsupported release profile');
  return value;
}
export function deploymentRole(path) { return templates.get(path)?.[0]; }
export function checkDeploymentRecord(profile, path, mode, digest) {
  const template = templates.get(path);
  if (template) {
    if (!completeProfile(profile) || mode !== '100644' || digest !== template[1]) {
      throw new Error('deployment template profile/mode/content mismatch: ' + path);
    }
  } else if (byDigest.has(digest)) {
    throw new Error('deployment template alias: ' + path);
  }
}

function fields(value, names) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) {
    throw new Error('invalid deployment registration fields');
  }
}
function pathValue(path) {
  // Caddyfile quotes never receive control bytes, quotes, placeholders,
  // environment substitutions or escape sequences. XML escapes '&' below.
  if (typeof path !== 'string' || path.length > 1024 || !path.startsWith('/') ||
      path.slice(1).split('/').some(part => !/^[A-Za-z0-9_&.-][A-Za-z0-9_ &.-]{0,126}$/.test(part) ||
        ['.', '..', 'current'].includes(part.toLowerCase()) || part.endsWith(' '))) {
    throw new Error('invalid deployment registration path');
  }
  return path;
}
function render(key, bytes, substitutions) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 16 * 1024) throw new Error('invalid deployment template');
  const data = Buffer.from(bytes);
  checkDeploymentRecord('deployment-complete', deploymentPaths[key], '100644', createHash('sha256').update(data).digest('hex'));
  return data.toString('utf8').replace(/@@([A-Z]+)@@/g, (_, token) => {
    if (!Object.hasOwn(substitutions, token)) throw new Error('unknown deployment template field');
    return substitutions[token];
  });
}

// Pure render. The host independently admits these principals, protected
// physical roots, controller binary digest and TLS references before effects.
export function renderDeploymentTemplates(sources, registration) {
  fields(sources, ['caddy', ...jobs]);
  fields(registration, ['instanceRoot', 'controllerPath', 'controllerSha256', 'accounts', 'origin', 'listener', 'certificatePath', 'keyPath']);
  const { accounts, listener, origin, controllerPath, controllerSha256, certificatePath, keyPath } = registration;
  fields(accounts, ['caddy', ...jobs]);
  fields(listener, ['host', 'port']);
  const names = Object.values(accounts);
  if (names.some(name => typeof name !== 'string' || !/^_?[a-z][a-z0-9_-]{0,30}$/.test(name) ||
      ['root', 'daemon', 'nobody'].includes(name)) || new Set(names).size !== names.length) throw new Error('invalid deployment accounts');
  const root = pathValue(registration.instanceRoot);
  const trust = root + '/caddy/trust';
  const controller = pathValue(controllerPath);
  if (typeof controllerSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(controllerSha256) ||
      !controller.endsWith('/' + controllerSha256 + '/patrick-host-controller') ||
      controller.toLowerCase().startsWith(root.toLowerCase() + '/') || root.toLowerCase().startsWith(controller.toLowerCase() + '/') ||
      root.toLowerCase() === controller.toLowerCase()) throw new Error('invalid registered controller path');
  if (![certificatePath, keyPath].every(path => pathValue(path).startsWith(trust + '/')) ||
      certificatePath.toLowerCase() === keyPath.toLowerCase()) throw new Error('invalid registered TLS references');
  if (typeof origin !== 'string' || origin.length > 512) throw new Error('invalid deployment HTTPS origin');
  const url = URL.parse(origin);
  if (!url || url.origin !== origin || url.protocol !== 'https:' || url.port === '0' || url.port === '80' ||
      !(/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(url.hostname) || /^\[[0-9a-f:]+\]$/.test(url.hostname))) throw new Error('invalid deployment HTTPS origin');
  if (!['127.0.0.1', '::1'].includes(listener.host) || !Number.isInteger(listener.port) || listener.port < 1 || listener.port > 65535) {
    throw new Error('invalid deployment loopback endpoint');
  }
  // Caddy binds the public port on all interfaces, including both loopback families.
  if (Number(url.port || 443) === listener.port) throw new Error('deployment listener ports overlap');
  const base = root + '/caddy';
  const caddy = render('caddy', sources.caddy, { ORIGIN: origin, AUTHORITY: url.host, CERT: certificatePath, KEY: keyPath, STORAGE: base + '/data',
    UPSTREAM: (listener.host === '::1' ? '[::1]' : listener.host) + ':' + listener.port });
  const plists = {};
  for (const job of jobs) {
    const work = root + '/runtime/' + job;
    const log = root + '/logs/' + job;
    const substitutions = { CONTROLLER: controller, ACCOUNT: accounts[job], WORK: work, HOME: work + '/home',
      STDOUT: log + '/redacted.stdout.log', STDERR: log + '/redacted.stderr.log' };
    plists[job] = render(job, sources[job], Object.fromEntries(Object.entries(substitutions).map(([k,v]) => [k,v.replaceAll('&','&amp;')])));
  }
  return Object.freeze({ caddy, plists: Object.freeze(plists), caddyProcess: Object.freeze({
    account: accounts.caddy, configPath: base + '/config/Caddyfile', workingDirectory: base,
    environment: Object.freeze({ HOME: base + '/home', XDG_CONFIG_HOME: base + '/config', XDG_DATA_HOME: base + '/data' }),
  }) });
}
