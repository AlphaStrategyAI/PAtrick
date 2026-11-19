import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test.each(['host SDK', 'without O_NOFOLLOW', 'without O_CLOEXEC'])('native directory primitive: %s', async (profile) => {
  const scratch = await mkdtemp(join(tmpdir(), 'patrick-directory-core-'));
  try {
    const source = fileURLToPath(new URL('../../packages/integrations/sources/native/directory-core.cc', import.meta.url));
    const harness = fileURLToPath(new URL('../native/T25-directory-core-harness.cc', import.meta.url));
    const binary = join(scratch, 'harness');
    const flags = ['-std=c++17', '-Wall', '-Wextra', '-Werror'];
    if (profile !== 'host SDK') {
      // Mask one SDK definition after including its header in each test translation unit.
      const header = join(scratch, 'fixture-flags.h');
      const flag = profile === 'without O_NOFOLLOW' ? 'O_NOFOLLOW' : 'O_CLOEXEC';
      await writeFile(header, `#include <fcntl.h>\n#undef ${flag}\n`);
      flags.push('-include', header);
    }
    const compilerOptions = {
      cwd: scratch, env: { ...process.env, TMPDIR: scratch }, encoding: 'utf8' as const, timeout: 30_000,
    };
    const definitions = spawnSync('c++', [...flags, '-x', 'c++', '-dM', '-E', '-'], {
      ...compilerOptions, input: '#include <fcntl.h>\n',
    });
    expect(definitions.status, definitions.error?.message ?? definitions.stderr).toBe(0);
    const macros = new Set(definitions.stdout.split('\n').map(line => line.split(/\s+/)[1]));
    const supported = ['__APPLE__', 'O_NOFOLLOW', 'O_CLOEXEC'].every(name => macros.has(name));
    if (profile !== 'host SDK') expect(supported).toBe(false);
    const build = spawnSync('c++', [...flags, source, harness, '-o', binary], compilerOptions);
    expect(build.status, build.error?.message ?? build.stderr).toBe(0);
    const fixture = join(scratch, 'fixture');
    await mkdir(fixture);
    await mkdir(join(fixture, 'folder'));
    await writeFile(join(fixture, 'ordinary'), Buffer.from([65, 0, 90, 255]));
    await writeFile(join(fixture, 'large'), 'q'.repeat(9000));
    await writeFile(join(fixture, 'empty'), '');
    await writeFile(join(fixture, 'denied'), 'private');
    await chmod(join(fixture, 'denied'), 0);
    await symlink('ordinary', join(fixture, 'link'));
    const run = spawnSync(binary, [], { cwd: fixture, encoding: 'utf8', timeout: 10_000 });
    expect(run.status, run.error?.message ?? run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe(supported ? 'fixture passed' : 'unsupported');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 60_000);

const headersArchive = process.env.PATRICK_T25_NODE_HEADERS_ARCHIVE;
const headersSha256 = '4db1e4f2bc0a1787810a24a54e351e3e49889a13cbf987041a5d462c157fbf48';
// Approved Darwin arm64 CLT build clang-2100.3.34.2. Review a new digest before accepting an upgrade.
const approvedArm64ClangSha256 = '1590ac950a3d627817d09ade5cb60b2115f17a72182a3141e010b4bcc482a0c9';
const moduleSkip = process.platform !== 'darwin'
  ? 'the native module fixture requires Darwin'
  : headersArchive === undefined ? 'set PATRICK_T25_NODE_HEADERS_ARCHIVE to the official Node 24.9.0 headers archive' : '';

test.skipIf(Boolean(moduleSkip))(`native directory module exposes only its fixed handshake${moduleSkip ? ` (skipped: ${moduleSkip})` : ''}`, async () => {
  expect(process.version, 'use the verified Node 24.9.0 binary').toBe('v24.9.0');
  const arch = process.arch;
  expect(arch, `no approved Darwin ${arch} compiler profile for the module fixture`).toBe('arm64');
  const scratch = await mkdtemp(join(tmpdir(), 'patrick-directory-module-'));
  try {
    // Extract the very bytes hashed here, even when the supplied path is later changed.
    const archive = await readFile(headersArchive!).catch(cause => {
      throw new Error('Cannot read the Node 24.9.0 headers archive supplied by PATRICK_T25_NODE_HEADERS_ARCHIVE', { cause });
    });
    expect(createHash('sha256').update(archive).digest('hex'), 'Node 24.9.0 headers SHA-256').toBe(headersSha256);
    const privateArchive = join(scratch, 'headers.tar.xz');
    await writeFile(privateArchive, archive);
    const developer = '/Library/Developer/CommandLineTools';
    const env = { PATH: '/usr/bin:/bin', LC_ALL: 'C', TMPDIR: scratch, DEVELOPER_DIR: developer };
    function run(command: string, args: string[]) {
      const result = spawnSync(command, args, { cwd: scratch, env, encoding: 'utf8', timeout: 30_000 });
      expect(result.status, result.error?.message ?? `${command}: ${result.stderr}`).toBe(0);
      return result.stdout.trimEnd();
    }
    run('/usr/bin/tar', ['-xf', privateArchive, 'node-v24.9.0/include/node']);
    const native = fileURLToPath(new URL('../../packages/integrations/sources/native/', import.meta.url));
    const sdk = await realpath(join(developer, 'SDKs/MacOSX.sdk'));
    const tool = (name: string) => join(developer, 'usr/bin', name);
    const binary = join(scratch, 'directory.node');
    const compileArgs = [
      '-std=c++17', '-Wall', '-Wextra', '-Werror', '-arch', arch, '-isysroot', sdk,
      '-stdlib=libc++', '-isystem', join(sdk, 'usr/include/c++/v1'), `--ld-path=${tool('ld')}`,
      '-mmacosx-version-min=14.0', '-DNAPI_VERSION=8', '-fvisibility=hidden', '-fvisibility-inlines-hidden',
      '-bundle', '-undefined', 'dynamic_lookup', '-Wl,-exported_symbol,_napi_register_module_v1',
      '-Wl,-exported_symbol,_node_api_module_get_api_version_v1', '-I', join(scratch, 'node-v24.9.0/include/node'),
      join(native, 'directory-module.cc'), join(native, 'directory-core.cc'), '-o', binary,
    ];
    const compiler = tool('clang++');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(compiler)) hash.update(chunk);
    const compilerSha256 = hash.digest('hex');
    expect(compilerSha256, 'unapproved Darwin arm64 clang++ SHA-256').toBe(approvedArm64ClangSha256);
    run(compiler, compileArgs);
    expect(run(tool('lipo'), ['-archs', binary])).toBe(arch);
    const machHeader = run(tool('otool'), ['-hv', binary]);
    expect(machHeader).toMatch(/\bBUNDLE\b/);
    const loadCommands = run(tool('otool'), ['-l', binary]);
    expect(loadCommands).not.toContain('LC_RPATH');
    expect(loadCommands).toMatch(/\bminos 14\.0\b/);
    const dependencies = run(tool('otool'), ['-L', binary]).split('\n').slice(1).map(line => line.trim().split(' ')[0]);
    expect(dependencies.sort()).toEqual(['/usr/lib/libSystem.B.dylib', '/usr/lib/libc++.1.dylib']);
    const symbols = run(tool('nm'), ['-gUj', binary]).split('\n').sort();
    expect(symbols).toEqual(['_napi_register_module_v1', '_node_api_module_get_api_version_v1']);

    // A fresh process loads this exact build and reports its own runtime identity.
    const handshake = JSON.parse(run(process.execPath, ['--input-type=commonjs', '-e', `
      const assert = require('node:assert/strict');
      const addon = require(process.argv[1]);
      assert.deepEqual(Reflect.ownKeys(addon), ['moduleInfo']);
      assert.equal(typeof addon.moduleInfo, 'function');
      const info = addon.moduleInfo();
      assert.deepEqual(Reflect.ownKeys(info).sort(), ['format', 'interfaceVersion', 'napiVersion']);
      assert.throws(() => addon.moduleInfo(undefined), { name: 'TypeError', message: 'moduleInfo takes no arguments' });
      console.log(JSON.stringify({ info, node: process.version, abi: process.versions.modules,
        runtimeNapi: process.versions.napi, arch: process.arch, execPath: process.execPath }));
    `, binary]));
    expect(handshake).toEqual({
      info: { format: 'patrick-directory-module', interfaceVersion: 1, napiVersion: 8 },
      node: 'v24.9.0', abi: '137', runtimeNapi: '10', arch: process.arch, execPath: process.execPath,
    });
    console.info(JSON.stringify({ compiler, compilerSha256, compilerVersion: run(compiler, ['--version']),
      sdk, compileArgs, arch, machHeader, dependencies, symbols, handshake,
      binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex') }));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 60_000);
