// Unsigned informational observation on a native CI runner. The working tree,
// system commands and tool installation are controlled by the runner owner.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdtempSync,
  openSync, readlinkSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { directoryHeadersSha256, nativeSources } from '../deploy/lib/deployment-templates.mjs';

const MiB = 1024 * 1024;
const repo = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const archive = 'node-v24.9.0-headers.tar.xz';
const clt = '/Library/Developer/CommandLineTools';
const unavailable = reason => ({ status: 'unavailable', reason });
const scanUnavailable = Object.freeze(unavailable('verified-private-sdk-and-resource-inputs-unavailable'));
const safeRelative = value => typeof value === 'string' && value.length <= 512 &&
  value.split('/').every(part => /^[\w.+-]+$/.test(part) && part !== '.' && part !== '..');
const fixedInputs = ['sdk/SDKSettings.json', 'sdk/usr/lib/libSystem.B.tbd', 'sdk/usr/lib/libc++.1.tbd'];
const sourcePins = {
  'directory-core.cc': '62920636cdd9222dbc945627f74b0b23d02c28d625a35eec88a5aac1357122a6',
  'directory-core.h': '83f4d9f46b09adcf7821267c667e44fdcf824f3a337f370cb06c2393369222d1',
  'directory-module.cc': '5f38a196db957b9853cfd89f537827ac578e675f488df63eada7a3ff17d52c7d',
};
function safeError(error) {
  return unavailable(error?.code === 'ENOENT' ? 'missing' : 'unreadable');
}
function physical(root, name, directory = false) {
  if (!safeRelative(name) || !root || !root.startsWith('/') || resolve(root) !== root) return unavailable('unsupported-path');
  try {
    if (realpathSync(root) !== root) return unavailable('linked-path');
    let part = root;
    for (const component of name.split('/')) {
      part = join(part, component);
      if (lstatSync(part).isSymbolicLink()) return unavailable('linked-path');
    }
    const stat = lstatSync(part);
    return (directory ? stat.isDirectory() : stat.isFile()) ? part : unavailable('wrong-file-kind');
  } catch (error) { return safeError(error); }
}
function measure(root, name, limit, retain) {
  const path = physical(root, name);
  if (typeof path !== 'string') return path;
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > limit) return unavailable('size-limit');
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(Math.min(MiB, stat.size));
    const content = retain ? Buffer.allocUnsafe(stat.size) : undefined;
    let bytes = 0;
    while (bytes < stat.size) {
      const n = readSync(fd, buffer, 0, Math.min(stat.size - bytes, buffer.length));
      if (!n) return unavailable('file-changed');
      const chunk = buffer.subarray(0, n);
      hash.update(chunk);
      if (content) chunk.copy(content, bytes);
      bytes += n;
    }
    if (fstatSync(fd).size !== bytes) return unavailable('file-changed');
    const measured = { bytes, sha256: hash.digest('hex') };
    return content ? { ...measured, content } : measured;
  } catch (error) { return safeError(error); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function identity(root, name, limit) {
  return measure(root, name, limit, false);
}
export function stagePinned(root, name, limit, pin, stage) {
  const { content, ...measured } = measure(root, name, limit, true);
  if (!content) return { ...measured, matchesPin: false };
  if (measured.sha256 !== pin) return { ...measured, ...unavailable('pin-mismatch'), matchesPin: false };
  writeFileSync(join(stage, basename(name)), content, { flag: 'wx', mode: 0o400 });
  return { ...measured, matchesPin: true };
}
export function hostCheck(host, target) {
  const intel = target === 'x64' && host.machine === 'x86_64' && host.cpuVendor === 'GenuineIntel' && host.kernelBuildArch === 'X86_64' &&
    (host.translated === '' || host.translated === '0');
  const arm = target === 'arm64' && host.machine === 'arm64' && host.kernelBuildArch === 'ARM64' && host.translated === '0';
  return host.platform === 'darwin' && host.arch === target && host.node === 'v24.9.0' &&
    host.modules === '137' && (intel || arm) ? 'consistent-with-runner-target' : unavailable('native-host-mismatch');
}
// No independently checked target-specific header inventory is available.
// Only read the three fixed SDK files. Never give the host include trees to clang.
export function observeSdkInputs(sdk) {
  return {
    fixedInputs: typeof sdk === 'string' ? fixedInputs.map(path => ({
      path, ...identity(sdk, path.slice('sdk/'.length), 16 * MiB),
    })) : unavailable('missing-sdk'),
    dependencyScan: scanUnavailable,
  };
}

const dylib = /^lib[\w.+-]{1,96}\.dylib$/;
const systemName = path => (path.startsWith('/usr/lib/') || path.startsWith('/System/Library/')) && safeRelative(path.slice(1));
const loadCommands = new Set(['LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB',
  'LC_LAZY_LOAD_DYLIB', 'LC_LOAD_UPWARD_DYLIB', 'LC_RPATH', 'LC_ID_DYLIB', 'LC_LOAD_DYLINKER']);
function permittedName(name, developer) {
  if (systemName(name) || ['@loader_path/../lib', '@executable_path/../lib', '@executable_path/../lib/', '@loader_path/../lib/', '@loader_path'].includes(name)) return true;
  if (developer && name.startsWith(developer + '/') && safeRelative(name.slice(developer.length + 1))) return true;
  return ['@rpath/', '@loader_path/', '@loader_path/../lib/', '@executable_path/../lib/']
    .some(prefix => name.startsWith(prefix) && dylib.test(name.slice(prefix.length)));
}
export function parseLoads(output, developer) {
  if (typeof output !== 'string' || output.length > MiB) return unavailable('load-command-limit');
  const chunks = output.split(/^Load command \d+\s*$/m).slice(1);
  if (!chunks.length || chunks.length > 512) return unavailable('unexpected-load-command');
  const result = [];
  for (const chunk of chunks) {
    const cmd = /^\s*cmd (LC_[A-Z0-9_]+)\s*$/m.exec(chunk)?.[1];
    if (!cmd) return unavailable('unexpected-load-command');
    if (!loadCommands.has(cmd)) {
      if (/DYLIB|RPATH|DYLINKER|DYLD_ENVIRONMENT|FVM/i.test(cmd)) return unavailable('unsupported-load-command');
      continue;
    }
    const path = /^\s*(?:name|path) (\S+) \(offset \d+\)\s*$/m.exec(chunk)?.[1];
    if (!path) return unavailable('unexpected-load-command');
    result.push(permittedName(path, developer) ? { command: cmd, path } : { command: cmd, ...unavailable('unsupported-install-name') });
  }
  return result;
}

function run(program, args, { developer, cwd = '/', stderr = false } = {}) {
  const env = { PATH: '/usr/bin:/bin', LC_ALL: 'C' };
  if (developer) env.DEVELOPER_DIR = developer;
  const r = spawnSync(program, args, { cwd, env, encoding: 'utf8', timeout: 30000, maxBuffer: MiB });
  return r.status === 0 ? (stderr ? r.stdout + r.stderr : r.stdout).trim() : undefined;
}
const version = /^\d+(?:\.\d+){0,3}$/;
const developerName = path => path === clt || /^\/Applications\/Xcode(?:[_-][\d.]+(?:_[a-zA-Z0-9.]+)?)?\.app\/Contents\/Developer$/.test(path);
const value = (raw, pattern) => typeof raw === 'string' && pattern.test(raw) ? raw : unavailable('unavailable-or-unrecognized');
function architectures(path, developer) {
  return value(run('/usr/bin/lipo', ['-archs', path], { developer }), /^(?:arm64e?|x86_64h?)(?: (?:arm64e?|x86_64h?))*$/);
}
function toolRecord(developer, toolchain, name) {
  const selected = run('/usr/bin/xcrun', ['--find', name], { developer });
  const path = join(toolchain, 'usr/bin', name);
  if (selected !== path) return { selected: unavailable(selected ? 'unsupported-tool-path' : 'missing') };
  const file = identity(toolchain, 'usr/bin/' + name, 512 * MiB);
  if (file.status) return { selected, ...file };
  let pattern = /(?:Apple (?:clang|LLVM) version|LLVM version) (\d+(?:\.\d+){0,3})(?: \(([\w.-]+)\))?/;
  if (name === 'ld') pattern = /PROJECT:(ld[\w.-]{1,64})/;
  const output = run(path, name === 'ld' ? ['-v'] : ['--version'], { developer, stderr: true });
  const match = pattern.exec(output ?? '');
  return { selected, ...file, architectures: architectures(path, developer),
    version: match ? match.slice(1).filter(Boolean).join(' ') : unavailable('unavailable-or-unrecognized') };
}
function loadGraph(developer, toolchain, linker, machine) {
  if (!linker.sha256) return unavailable('linker-unavailable');
  const lib = join(toolchain, 'usr/lib'), bin = dirname(linker.selected);
  const queue = [linker.selected], files = new Map(), nodes = [];
  let remaining = 1024 * MiB;
  // Resolve only a direct private load or an unambiguous local LC_RPATH.
  // Other dyld search chains require independent review on the host.
  for (const path of queue) {
    const loads = parseLoads(run('/usr/bin/otool', ['-arch', machine, '-l', path], { developer }), developer);
    const node = { path, loads };
    nodes.push(node);
    if (!Array.isArray(loads)) continue;
    const rpaths = loads.filter(row => row.command === 'LC_RPATH');
    for (const row of loads) {
      const name = row.path;
      if (!name || ['LC_ID_DYLIB', 'LC_RPATH'].includes(row.command) || systemName(name)) continue;
      const expand = part => part.replace(/^@loader_path(?=\/|$)/, dirname(path)).replace(/^@executable_path(?=\/|$)/, bin);
      let expanded;
      if (name.startsWith('@rpath/')) {
        if (rpaths.length === 1 && rpaths[0].path) expanded = join(expand(rpaths[0].path), name.slice(7));
      } else expanded = expand(name);
      const resolved = expanded?.startsWith('/') && resolve(expanded);
      if (!resolved || dirname(resolved) !== lib || !dylib.test(basename(resolved))) {
        row.identity = unavailable('unresolved-private-load');
        continue;
      }
      row.resolved = resolved;
      if (!files.has(resolved)) {
        if (files.size >= 24) { row.identity = unavailable('library-limit'); continue; }
        const file = identity(lib, basename(resolved), Math.min(512 * MiB, remaining));
        files.set(resolved, file);
        remaining -= file.bytes ?? 0;
        if (file.sha256) queue.push(resolved);
      }
      row.identity = files.get(resolved);
    }
  }
  return nodes;
}

// Versioned Xcode SDK selectors are often symlinks. Never open an input
// through the selector. A single named sibling can be probed independently.
export function sdkLocation(parent, name, sdkVersion) {
  const names = ['MacOSX.sdk'];
  if (typeof sdkVersion === 'string' && version.test(sdkVersion)) names.push('MacOSX' + sdkVersion + '.sdk');
  if (!names.includes(name)) return { physicalSdk: unavailable('unsupported-sdk-name') };
  const selector = physical(parent, name, true);
  if (typeof selector === 'string' || selector.reason !== 'linked-path') return { selector, physicalSdk: selector };
  try {
    if (realpathSync(parent) !== parent) return { selector, physicalSdk: unavailable('linked-path') };
    const sibling = readlinkSync(join(parent, name));
    if (sibling === name || !names.includes(sibling)) return { selector, physicalSdk: unavailable('unsupported-sdk-alias') };
    return { selector, sibling, physicalSdk: physical(parent, sibling, true) };
  } catch (error) { return { selector, physicalSdk: safeError(error) }; }
}
function sdkAndResources(developer, toolchain, compiler) {
  const sdk = run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { developer });
  const sdkVersion = value(run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-version'], { developer }), version);
  const sdkBuild = value(run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-build-version'], { developer }), /^[\dA-Za-z.]{1,32}$/);
  const sdkParent = developer === clt ? 'SDKs/' : 'Platforms/MacOSX.platform/Developer/SDKs/';
  const name = sdk && basename(sdk);
  const approved = /^MacOSX(?:\d+(?:\.\d+){0,2})?\.sdk$/.test(name) && sdk === join(developer, sdkParent, name);
  const selected = approved ? sdk : unavailable('unsupported-sdk-path');
  const location = approved ? sdkLocation(dirname(sdk), name, sdkVersion) : { physicalSdk: selected };
  const resource = compiler.sha256 && run(compiler.selected, ['-print-resource-dir'], { developer });
  const resourcePrefix = join(toolchain, 'usr/lib/clang') + '/';
  const safeResource = resource && resource.startsWith(resourcePrefix) && version.test(resource.slice(resourcePrefix.length));
  const physicalResource = safeResource ? physical(toolchain, resource.slice(toolchain.length + 1) + '/include', true) :
    unavailable('unsupported-resource-path');
  return { selected, version: sdkVersion, build: sdkBuild, ...location, resourceInclude: physicalResource };
}
function observePinnedInputs(runnerTemp) {
  const stage = mkdtempSync(join(runnerTemp, 'patrick-observation-inputs-'));
  try {
    const header = stagePinned(runnerTemp, archive, 32 * MiB, directoryHeadersSha256, stage);
    return {
      headers: { name: archive, expectedSha256: directoryHeadersSha256, ...header },
      sources: nativeSources.map(path => {
        const expectedSha256 = sourcePins[basename(path)];
        return { path, expectedSha256, ...stagePinned(repo, path, MiB, expectedSha256, stage) };
      }),
    };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
function observe(target, commit, runnerTemp) {
  if (!['arm64', 'x64'].includes(target) || !/^[0-9a-f]{40}$/.test(commit) ||
      run('/usr/bin/git', ['--no-replace-objects', 'rev-parse', 'HEAD'], { cwd: repo }) !== commit)
    throw new Error('invalid-target-or-source');
  const record = { format: 'patrick-unsigned-darwin-toolchain-observation-v1', trust: 'untrusted-pending-independent-release-authority-review',
    unverified: ['production-signature', 'approved-toolchain', 'v3-admission', 'native-addon-handshake', 'production-readiness'],
    dependencyScan: scanUnavailable, commit, target };
  const translated = run('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated']);
  const host = { platform: value(process.platform, /^darwin$/), arch: value(process.arch, /^(arm64|x64)$/),
    machine: value(run('/usr/bin/uname', ['-m']), /^(x86_64|arm64)$/), node: value(process.version, /^v\d+\.\d+\.\d+$/),
    modules: value(process.versions.modules, /^\d+$/), translated: value(translated, /^(0|1)?$/),
    cpuVendor: value(run('/usr/sbin/sysctl', ['-in', 'machdep.cpu.vendor']), /^(GenuineIntel|)$/),
    osVersion: value(run('/usr/bin/sw_vers', ['-productVersion']), version),
    osBuild: value(run('/usr/bin/sw_vers', ['-buildVersion']), /^[0-9]+[A-Z][0-9]+[a-z]?$/) };
  record.host = host;
  host.kernelBuildArch = value(/\/RELEASE_(X86_64|ARM64)(?:_|$)/.exec(run('/usr/sbin/sysctl', ['-n', 'kern.version']) ?? '')?.[1], /^(X86_64|ARM64)$/);
  record.nodeProcessTranslation = unavailable('no-in-process-translation-query');
  record.hostConsistency = hostCheck(host, target);
  if (record.hostConsistency !== 'consistent-with-runner-target') return record;
  record.nodeExecutable = identity(dirname(process.execPath), basename(process.execPath), 512 * MiB);
  Object.assign(record, observePinnedInputs(runnerTemp));
  const defaultDeveloper = run('/usr/bin/xcode-select', ['-p']);
  const developer = process.env.DEVELOPER_DIR || defaultDeveloper;
  record.xcodeSelect = developerName(defaultDeveloper) ? defaultDeveloper : unavailable('unsupported-developer-path');
  if (!developerName(developer) || typeof physical('/', developer.slice(1), true) !== 'string') {
    record.developer = unavailable('unsupported-developer-path');
    return record;
  }
  record.developer = developer;
  const toolchain = developer === clt ? developer : join(developer, 'Toolchains/XcodeDefault.xctoolchain');
  record.toolchain = toolchain;
  const xcode = run('/usr/bin/xcodebuild', ['-version'], { developer });
  const xcodeVersion = /^Xcode (\d+(?:\.\d+){0,3})\nBuild version ([\dA-Za-z.]{1,32})$/.exec(xcode ?? '');
  record.xcode = xcodeVersion ? { version: xcodeVersion[1], build: xcodeVersion[2] } : unavailable('xcode-version-unavailable');
  if (developer === clt) {
    const receipt = run('/usr/sbin/pkgutil', ['--pkg-info', 'com.apple.pkg.CLTools_Executables']);
    record.cltPackageVersion = value(/^version: ([\d.]{1,80})$/m.exec(receipt ?? '')?.[1], /^[\d.]+$/);
  }
  record.tools = Object.fromEntries(['clang', 'clang++', 'ld', 'nm', 'llvm-nm'].map(name =>
    [name, toolRecord(developer, toolchain, name)]));
  record.linkerGraph = loadGraph(developer, toolchain, record.tools.ld, host.machine);
  record.sdk = sdkAndResources(developer, toolchain, record.tools.clang);
  Object.assign(record, observeSdkInputs(record.sdk.physicalSdk));
  return record;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [target, commit] = process.argv.slice(2);
    const record = observe(target, commit, realpathSync(process.env.RUNNER_TEMP));
    process.stdout.write(JSON.stringify(record, null, 2) + '\n');
  } catch {
    process.stderr.write('Darwin observation failed to validate its invocation.\n');
    process.exitCode = 1;
  }
}
