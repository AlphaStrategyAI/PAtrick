import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => { throw new Error('unexpected subprocess while reading fixtures'); }),
}));

const script = new URL('../../scripts/observe-darwin-toolchain.mjs', import.meta.url);
async function helper() {
  expect(existsSync(fileURLToPath(script)), 'missing Darwin observation helper').toBe(true);
  return import(script.href);
}
const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 't25-observe-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const unavailable = (reason: string) => ({ status: 'unavailable', reason });

it('hashes only physical bounded fixture files and redacts failure details', async () => {
  const { identity } = await helper();
  const root = fixture();
  writeFileSync(join(root, 'header.h'), '1234');
  symlinkSync('header.h', join(root, 'alias.h'));
  expect(identity(root, 'header.h', 4)).toEqual({ bytes: 4, sha256: digest('1234') });
  expect(identity(root, 'header.h', 3)).toEqual(unavailable('size-limit'));
  expect(identity(root, 'alias.h', 4)).toEqual(unavailable('linked-path'));
  expect(identity(root, 'absent.h', 4)).toEqual(unavailable('missing'));
  expect(identity(root, '../private-fixture', 4)).toEqual(unavailable('unsupported-path'));
});

it('records the three fixed SDK inputs and skips preprocessing without a verified private header view', async () => {
  const { observeSdkInputs } = await helper();
  const sdk = fixture();
  mkdirSync(join(sdk, 'usr/lib'), { recursive: true });
  writeFileSync(join(sdk, 'SDKSettings.json'), '{}');
  writeFileSync(join(sdk, 'usr/lib/libSystem.B.tbd'), 'stub');
  vi.mocked(spawnSync).mockClear();
  expect(observeSdkInputs(sdk)).toEqual({
    fixedInputs: [
      { path: 'sdk/SDKSettings.json', bytes: 2, sha256: digest('{}') },
      { path: 'sdk/usr/lib/libSystem.B.tbd', bytes: 4, sha256: digest('stub') },
      { path: 'sdk/usr/lib/libc++.1.tbd', ...unavailable('missing') },
    ],
    dependencyScan: unavailable('verified-private-sdk-and-resource-inputs-unavailable'),
  });
  expect(spawnSync).not.toHaveBeenCalled();
});

it('keeps typed linker edges and redacts unsupported paths even inside tool output', async () => {
  const { parseLoads } = await helper();
  const load = (cmd: string, field: string, path: string) =>
    'Load command 1\n          cmd ' + cmd + '\n      cmdsize 64\n         ' + field + ' ' + path + ' (offset 24)\n';
  const dependencies = parseLoads(load('LC_LOAD_DYLIB', 'name', '/usr/lib/libSystem.B.dylib') +
    load('LC_LOAD_WEAK_DYLIB', 'name', '@rpath/libtapi.dylib') +
    load('LC_RPATH', 'path', '@loader_path/../lib') +
    load('LC_LOAD_DYLIB', 'name', '/unrelated/PRIVATE_FIXTURE/libX.dylib'));
  expect(dependencies).toEqual([
    { command: 'LC_LOAD_DYLIB', path: '/usr/lib/libSystem.B.dylib' },
    { command: 'LC_LOAD_WEAK_DYLIB', path: '@rpath/libtapi.dylib' },
    { command: 'LC_RPATH', path: '@loader_path/../lib' },
    { command: 'LC_LOAD_DYLIB', ...unavailable('unsupported-install-name') },
  ]);
  expect(parseLoads('Load command 0\n cmd LC_LOAD_DYLIB\n')).toEqual(unavailable('unexpected-load-command'));
});

it('requires positive native Intel evidence when the translation oid is absent', async () => {
  const { hostCheck } = await helper();
  const host = { platform: 'darwin', arch: 'x64', node: 'v26.13.0', modules: '147', machine: 'x86_64',
    translated: '', cpuVendor: 'GenuineIntel', kernelBuildArch: 'X86_64' };
  expect(hostCheck(host, 'x64')).toBe('consistent-with-runner-target');
  expect(hostCheck({ ...host, kernelBuildArch: 'ARM64' }, 'x64')).toEqual(unavailable('native-host-mismatch'));
  expect(hostCheck({ ...host, cpuVendor: '' }, 'x64')).toEqual(unavailable('native-host-mismatch'));
  expect(hostCheck({ ...host, translated: '1' }, 'x64')).toEqual(unavailable('native-host-mismatch'));
  // A host on another Node ABI line is not the runner target.
  expect(hostCheck({ ...host, modules: '137' }, 'x64')).toEqual(unavailable('native-host-mismatch'));
  expect(hostCheck(host, 'arm64')).toEqual(unavailable('native-host-mismatch'));
});

it('stages only the exact bytes measured against the pin', async () => {
  const { stagePinned } = await helper();
  const source = fixture(), stage = fixture();
  writeFileSync(join(source, 'archive'), 'fixture-bytes');
  const expected = digest('fixture-bytes');
  expect(stagePinned(source, 'archive', 13, expected, stage)).toEqual({ bytes: 13, sha256: expected, matchesPin: true });
  expect(readFileSync(join(stage, 'archive'), 'utf8')).toBe('fixture-bytes');
});

it('leaves no staged file for a wrong pin, missing input, link or oversized input', async () => {
  const { stagePinned } = await helper();
  const source = fixture(), stage = fixture();
  writeFileSync(join(source, 'archive'), '1234');
  symlinkSync('archive', join(source, 'alias'));
  const expected = digest('1234');
  for (const [name, limit, pin, reason] of [
    ['archive', 4, digest('other'), 'pin-mismatch'],
    ['absent', 4, expected, 'missing'],
    ['alias', 4, expected, 'linked-path'],
    ['archive', 3, expected, 'size-limit'],
  ] as const) {
    expect(stagePinned(source, name, limit, pin, stage)).toMatchObject({ ...unavailable(reason), matchesPin: false });
    expect(existsSync(join(stage, name))).toBe(false);
  }
});
it('retains the actual trailing slash in the Apple linker search path', async () => {
  const { parseLoads } = await helper();
  expect(parseLoads('Load command 0\n cmd LC_RPATH\n path @executable_path/../lib/ (offset 12)'))
    .toEqual([{ command: 'LC_RPATH', path: '@executable_path/../lib/' }]);
});

it('records a linked SDK selector separately from its strictly named physical sibling', async () => {
  const { sdkLocation } = await helper();
  const root = fixture();
  mkdirSync(join(root, 'MacOSX.sdk'));
  symlinkSync('MacOSX.sdk', join(root, 'MacOSX15.5.sdk'));
  expect(sdkLocation(root, 'MacOSX15.5.sdk', '15.5')).toEqual({
    selector: unavailable('linked-path'), sibling: 'MacOSX.sdk', physicalSdk: join(root, 'MacOSX.sdk'),
  });
  symlinkSync('unrelated', join(root, 'MacOSX15.4.sdk'));
  expect(sdkLocation(root, 'MacOSX15.4.sdk', '15.4').physicalSdk).toEqual(unavailable('unsupported-sdk-alias'));
});

it('attaches an informational sidecar to each existing native matrix tuple with commit and architecture', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/release-darwin.yml', import.meta.url), 'utf8');
  expect(workflow).toContain('node scripts/observe-darwin-toolchain.mjs "$TARGET_ARCH" "$GITHUB_SHA"');
  expect(workflow).toContain('patrick-darwin-${{ matrix.arch }}-${{ github.sha }}-unsigned-toolchain-observation');
  expect(workflow).toContain('dependencyScan: r.dependencyScan');
  expect(workflow).toContain('contents: read');
  expect(workflow).toContain('patrick-darwin-${{ matrix.arch }}-unsigned-deployment-complete-materials');
});
