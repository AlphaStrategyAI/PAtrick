import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { watch } from 'node:fs';
import { chmod, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, test as runTest, vi } from 'vitest';
import { canonicalize, RELEASE_LIMITS, sha256, verifyRelease } from '../../deploy/lib/release.mjs';
import { publishStagedDeployment, readEmittedWriteOutcome, stageVerifiedEmittedRuntime, verifyEmittedRuntimeCandidate, withPublishedDeployment, withStagedDeployment, withStagedEmittedRuntime } from '../../deploy/lib/emitted-release.mjs';
import { checkDirectoryAuthority, checkDirectoryDefinition, directoryCommands, deploymentPaths, deploymentRole, directoryIdentity, releaseProfile, renderDeploymentTemplates } from '../../deploy/lib/deployment-templates.mjs';
import type { EmittedReleaseExpectation, NativeByteReleaseExpectation, EmittedReleaseTrustPolicy, ExclusiveRuntimeStaging, VerifiedEmittedRuntimeCandidate } from '../../deploy/lib/emitted-release.mjs';
import { inspectEmittedRuntimeMaterial, prepareEmittedRuntimeCandidate, packEmittedRuntimeCandidate } from '../../scripts/pack-runtime.mjs';
import type { EmittedMaterialInput, ExplicitEvidenceInput, PreparedEmittedRuntimeCandidate } from '../../scripts/pack-runtime.mjs';
import { createInstalledCli } from '../../deploy/runtime/cli.js';
import { createRuntimeProvisioning, prepareFirstInstallGeneration } from '../../deploy/runtime/composition.js';
import { installReleaseApproval, runFirstInstallRelease, type InstallPreviewEnrollment, type InstallReleaseEnrollment } from '../../deploy/runtime/install-preview.js';
import { createGenerationStore, type InstalledGeneration } from '../../deploy/runtime/lifecycle-generation.js';

const lowSpace = vi.hoisted(() => ({ path: '' }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, statfsSync(path: string, options?: { bigint?: boolean }) {
    const observed = fs.statfsSync(path, options);
    return path === lowSpace.path && options?.bigint ? { ...observed, bavail: 0n } : observed;
  } };
});

const test = runTest;
let hook: ReturnType<typeof registerHooks>;
let candidateLoads = 0;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ids = ['relocated-node-import', 'service-cli-drain', 'sqlite-migrate-reopen', 'worker-role-readback'];
const entries = ['cli', 'composition', 'service', 'worker'].map(name => 'runtime/' + name + '.mjs');
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
let temporary: string;
let input: EmittedMaterialInput;
let evidence: ExplicitEvidenceInput;
let policy: EmittedReleaseTrustPolicy;
let expected: EmittedReleaseExpectation;
let prepared: PreparedEmittedRuntimeCandidate;
let receipt: VerifiedEmittedRuntimeCandidate;
let packagePath: string;
let material: Awaited<ReturnType<typeof inspectEmittedRuntimeMaterial>>;
let artifact: string;
let nextRead = Promise.resolve();
const staging: ExclusiveRuntimeStaging = { withExclusiveReadRoot(read) {
  const result = nextRead.then(() => read(temporary));
  nextRead = result.then(() => {}, () => {});
  return result;
} };
const bytes = (value: unknown) => Buffer.from(canonicalize(value));
const signature = (data: Buffer) => ({ keyId: 'fixture', signature: sign(null, data, keys.privateKey).toString('base64') });
const verify = (changes = {}, trust = policy) => verifyEmittedRuntimeCandidate(packagePath, { staging, expected: { ...expected, ...changes }, policy: trust });

function child(argv: string[], cwd = root, executable = process.execPath) {
  const result = spawnSync(executable, argv, { cwd, encoding: 'utf8', timeout: 90_000,
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_PATH: '', NODE_OPTIONS: '' } });
  expect(result.status, String(result.error ?? result.stderr)).toBe(0);
  return result.stdout;
}

async function observe(path: string) {
  const physical = await realpath(path);
  const data = await readFile(physical);
  return { path: physical, sha256: sha256(data), bytes: data.length };
}

async function observePackage(path: string) {
  return { ...await observe(path), version: JSON.parse(await readFile(path, 'utf8')).version };
}

const base = '/fixture/Patrick & Co';
const digest = 'a'.repeat(64);
const registration = {
  instanceRoot: base, controllerSha256: digest, controllerPath: '/fixture/Controllers & Tools/'+digest+'/patrick-host-controller',
  accounts: { caddy: '_proxy', service: '_service', hub: '_hub', worker: '_worker' },
  origin: 'https://patrick.example.test:8443', listener: { host: '::1' as const, port: 43123 },
  certificatePath: base+'/caddy/trust/endpoint & chain.pem', keyPath: base+'/caddy/trust/private-key.ref',
};

// Request tuples only. These Intel and cross-target examples are not build observations.
const arm64Target = { os: 'darwin', arch: 'arm64' } as const;
const intelTarget = { os: 'darwin', arch: 'x64' } as const;
const arm64Host = { os: 'darwin', processArch: 'arm64', machine: 'arm64' } as const;
const intelHost = { os: 'darwin', processArch: 'x64', machine: 'x86_64' } as const;

test.skipIf(!process.env.PATRICK_T25_TEST_RECIPE)('directory recipe approves the observed arm64 host and native target together', async () => {
  const a = JSON.parse(await readFile(process.env.PATRICK_T25_TEST_RECIPE!, 'utf8'));
  expect(() => checkDirectoryAuthority(a, arm64Target, arm64Host)).not.toThrow();
  expect(() => checkDirectoryAuthority(a, arm64Target, intelHost)).toThrow('RUNTIME_DIRECTORY_RECIPE_TARGET_MISMATCH');
  expect(() => checkDirectoryAuthority(a, arm64Target, { ...arm64Host, processArch: 'x64' })).toThrow('RUNTIME_DIRECTORY_RECIPE_TARGET_MISMATCH');
  expect(() => checkDirectoryAuthority(a, arm64Target, { ...arm64Host, machine: 'x86_64' })).toThrow('RUNTIME_DIRECTORY_RECIPE_TARGET_MISMATCH');
  expect(() => checkDirectoryAuthority({ ...a, buildMode: 'cross' }, arm64Target, arm64Host)).toThrow('RUNTIME_DIRECTORY_RECIPE_TARGET_MISMATCH');
  expect(() => checkDirectoryAuthority({ ...a, buildHost: intelHost }, arm64Target, arm64Host)).toThrow('RUNTIME_DIRECTORY_RECIPE_TARGET_MISMATCH');
  expect(() => checkDirectoryAuthority({ ...a, target: intelTarget }, arm64Target, arm64Host)).toThrow('RUNTIME_DIRECTORY_RECIPE_TARGET_MISMATCH');
});
test.skipIf(!process.env.PATRICK_T25_TEST_RECIPE)('unregistered Intel native and cross-target recipe requests have no approved tool selection', async () => {
  const a = JSON.parse(await readFile(process.env.PATRICK_T25_TEST_RECIPE!, 'utf8'));
  expect(() => directoryCommands('x64')).toThrow('RUNTIME_DIRECTORY_TARGET_UNAPPROVED');
  expect(() => checkDirectoryAuthority(a, intelTarget, arm64Host)).toThrow('RUNTIME_DIRECTORY_TARGET_UNAPPROVED');
  expect(() => checkDirectoryAuthority(a, intelTarget, intelHost)).toThrow('RUNTIME_DIRECTORY_TARGET_UNAPPROVED');
});

// Ordinary section metadata; no modified executable or loader is involved.
test('directory definitions require a concrete file-backed code section and address', () => {
  const segment = { name: '__TEXT', address: 0x1000n, size: 0x1000n, fileOffset: 0n, fileBytes: 0x800n, protection: 5 };
  const section = { segment, segmentName: '__TEXT', name: '__text', address: 0x1200n, size: 0x40n, fileOffset: 0x200n, flags: 0x80000400 };
  const check = (sections = [section], ordinal = 1, value = 0x1210n) =>
    checkDirectoryDefinition(sections, ordinal, value, 0x80n, 0x800n);
  expect(() => check()).not.toThrow();
  expect(() => check([{ ...section, name: '__cstring' }, section], 2, section.address + section.size - 1n)).not.toThrow();
  expect(() => check([], 1)).toThrow('RUNTIME_DIRECTORY_MATERIAL_INVALID');
  expect(() => check([section], 0)).toThrow('RUNTIME_DIRECTORY_MATERIAL_INVALID');
  expect(() => check([section], 1, section.address + section.size)).toThrow('RUNTIME_DIRECTORY_MATERIAL_INVALID');
  expect(() => check([{ ...section, fileOffset: 0x7f0n }])).toThrow('RUNTIME_DIRECTORY_MATERIAL_INVALID');
  expect(() => check([{ ...section, segment: { ...segment, size: 0x100n } }])).toThrow('RUNTIME_DIRECTORY_MATERIAL_INVALID');
  expect(() => check([{ ...section, segmentName: '__DATA' }])).toThrow('RUNTIME_DIRECTORY_MATERIAL_INVALID');
  expect(() => check([{ ...section, fileOffset: 0x201n }])).toThrow('RUNTIME_DIRECTORY_MATERIAL_INVALID');
  expect(() => check([{ ...section, segment: { ...segment, protection: 1 } }])).toThrow('RUNTIME_DIRECTORY_MATERIAL_INVALID');
});

test('v3 profile keeps legacy defaults and rejects unrecognized versions', () => {
  expect(releaseProfile()).toBe('runtime-only');
  expect(releaseProfile('deployment-complete')).toBe('deployment-complete');
  expect(releaseProfile('deployment-complete-native-v3')).toBe('deployment-complete-native-v3');
  expect(() => releaseProfile('deployment-complete-native-v4' as never)).toThrow(/unsupported release profile/);
});

describe('offline deployment renderer', () => {
  let sources: Parameters<typeof renderDeploymentTemplates>[0];
  beforeAll(async () => {
    const read = (key: keyof typeof deploymentPaths) => readFile(join(root, deploymentPaths[key]));
    sources = { caddy: await read('caddy'), service: await read('service'), hub: await read('hub'), worker: await read('worker') };
  });

  for (const host of ['127.0.0.1', '::1'] as const) {
    test.each([
      ['https://patrick.example.test:80', 43123],
      ['https://patrick.example.test', 443],
      ['https://patrick.example.test:8443', 8443],
    ] as const)('refuses frontend %s with '+host+' upstream port %d', (origin, port) => {
      expect(() => renderDeploymentTemplates(sources, { ...registration, origin, listener: { host, port } })).toThrow();
    });
    test.each(['https://patrick.example.test', 'https://patrick.example.test:8443'])(
      'renders distinct frontend %s and '+host+' upstream', origin => {
        const rendered = renderDeploymentTemplates(sources, { ...registration, origin, listener: { host, port: 43123 } });
        expect(rendered.caddy).toContain(origin + ' {');
        expect(rendered.caddy).toContain((host === '::1' ? '[::1]' : host) + ':43123');
      });
  }
  test('redacts the malformed HTTPS origin in error properties and serialization', () => {
    const marker = 'malformed-origin-fixture-marker';
    let failure: unknown;
    try { renderDeploymentTemplates(sources, { ...registration, origin: 'invalid input ' + marker }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    const error = failure as Error;
    expect.soft(error.message).toBe('invalid deployment HTTPS origin');
    expect.soft(Object.hasOwn(error, 'cause')).toBe(false);
    expect.soft(Object.hasOwn(error, 'input')).toBe(false);
    expect.soft(JSON.stringify(error)).not.toContain(marker);
    for (const key of Reflect.ownKeys(error)) expect.soft(String(Reflect.get(error, key))).not.toContain(marker);
  });
});

describe.skipIf(process.platform !== 'darwin')('Darwin runtime admission', () => {
beforeAll(async () => {
  temporary = await mkdtemp(join(await realpath(tmpdir()), 'emitted-admission-'));
  const prefix = pathToFileURL(temporary).href + '/';
  hook = registerHooks({ load(url, context, next) {
    if (url.startsWith(prefix)) { candidateLoads++; throw new Error('candidate module execution during admission'); }
    return next(url, context);
  } });
  ({ input, evidence, prepared, packagePath, expected, policy, material, artifact } = await buildSignedFixture(temporary));
}, 120_000);

const nativeProfile = 'deployment-complete-native-v3' as const;
const directoryPath = 'native/patrick-directory.node';
const directoryScenario = 'directory-module-info-relocated';
async function buildSignedFixture(temporary: string, profile?: 'deployment-complete') {
  const fixture = await buildFixture(temporary, profile);
  return { ...fixture, expected: { ...fixture.expected, ...(profile && { profile }) } };
}

async function buildFixture(temporary: string, profile?: 'deployment-complete' | typeof nativeProfile) {
  const v3 = profile === nativeProfile;
  const git = '/usr/bin/git';
  const commit = child(['--no-replace-objects', 'rev-parse', 'HEAD'], root, git).trim();
  const source = ['--source-root', root, '--source-commit', commit, ...(profile ? ['--profile', profile] : [])];
  const build = join(root, 'scripts/build-runtime.mjs');
  const snapshot = JSON.parse(child([build, 'snapshot', ...source]));
  const built = join(temporary, 'original');
  const artifact = join(temporary, 'relocated');
  const flags = [...(snapshot.changed ? ['--source-snapshot', snapshot.snapshotSha256] : []),
    ...(v3 ? ['--directory-authority', process.env.PATRICK_T25_TEST_RECIPE!,
      '--directory-authority-sha256', process.env.PATRICK_T25_TEST_RECIPE_SHA256!, '--node-headers', process.env.PATRICK_T25_NODE_HEADERS_ARCHIVE!] : [])];
  const buildAt = (path: string) => JSON.parse(child([build, 'build', ...source, '--output-root', path, ...flags]));
  const first = buildAt(built);
  const second = v3 ? buildAt(artifact) : undefined;
  if (!v3) await cp(built, artifact, { recursive: true });
  else expect(first.inventorySha256).toBe(second.inventorySha256);
  const metadata = 'metadata/runtime-materials.json';
  const inventory = JSON.parse(await readFile(join(artifact, metadata), 'utf8'));
  type Record = { role: string; bytes: number; path: string };
  const files: Record[] = inventory.files;
  const totals: { [role: string]: { files: number; bytes: number } } = {};
  for (const file of files) {
    totals[file.role] ??= { files: 0, bytes: 0 };
    totals[file.role].files++;
    totals[file.role].bytes += file.bytes;
  }
  const vite = join(root, 'apps/web/node_modules/vite/package.json');
  const fromVite = createRequire(vite);
  const npm = await observe(join(dirname(process.execPath), 'npm'));
  const toolchain = {
    ...(v3 && { directoryBuild: second.directoryBuild, repeatDirectoryBuild: first.directoryBuild, directoryNative: inventory.directoryNative }),
    observed: inventory.observed, source: inventory.source,
    node: await observe(process.execPath), npm: { ...npm, version: child([npm.path, '--global', '--version'], temporary).trim() },
    git: { path: git, version: child(['--version'], root, git).trim() },
    esbuild: await observePackage(join(root, 'node_modules/esbuild/package.json')),
    esbuildBinary: await observe(join(root, 'node_modules/@esbuild', process.platform + '-' + process.arch, 'bin/esbuild')),
    vite: await observePackage(vite), viteEsbuild: await observePackage(fromVite.resolve('esbuild/package.json')),
    viteRollup: await observePackage(fromVite.resolve('rollup/package.json')),
    inventory: await observe(join(artifact, metadata)), repeatInventory: await observe(join(built, metadata)), totals,
    largestRecord: [...files].sort((a, b) => b.bytes - a.bytes)[0],
    native: { ...inventory.native, fileMode: '755', binaryDescription: child(['-b', join(artifact, inventory.native.path)], root, '/usr/bin/file').trim() },
    packages: inventory.packages, packageFiles: files.filter(f => f.path.startsWith('node_modules/')), runtimeFiles: files.filter(f => f.path.startsWith('runtime/')),
  };
  const toolchainPath = join(temporary, 'toolchain.json');
  await writeFile(toolchainPath, bytes(toolchain));
  const lockPath = join(temporary, 'package-lock.json');
  await cp(join(root, 'package-lock.json'), lockPath);
  const input: EmittedMaterialInput = { ...(profile && { profile }), staging, artifactRoot: artifact, version: JSON.parse(await readFile(lockPath, 'utf8')).version,
    target: { os: 'darwin', arch: inventory.observed.arch }, schema: { min: 1, max: 2 },
    expectedSource: inventory.source, expectedInventorySha256: toolchain.inventory.sha256, lockPath,
    toolchain: { path: toolchainPath, sha256: sha256(bytes(toolchain)) } };
  const material = await inspectEmittedRuntimeMaterial(input);
  const runner = join(temporary, 'scenario.mjs');
  await writeFile(runner, scenarioRunner);
  const scenarios = [];
  const logs = [];
  for (const id of v3 ? [...ids, directoryScenario] : ids) {
    const path = join(temporary, id + '.log');
    const argv = ['--permission', '--allow-addons', '--allow-fs-read=' + temporary + '/*', '--allow-fs-write=' + temporary + '/*',
      ...(process.allowedNodeEnvironmentFlags.has('--allow-net') ? ['--allow-net'] : []), runner, id, artifact, material.materialSha256, root];
    const startedUtc = new Date().toISOString();
    const transcript = v3 ? 'SYNTHETIC byte-contract fixture: ' + id + '\n' : child(argv, temporary);
    const endedUtc = new Date().toISOString();
    await writeFile(path, transcript);
    const hash = sha256(Buffer.from(transcript));
    scenarios.push({ id, argv: v3 ? ['synthetic-evidence', id] : [process.execPath, ...argv], cwd: temporary, startedUtc, endedUtc, exitCode: 0, status: 'passed', evidenceSha256: hash });
    logs.push({ id, path, sha256: hash });
  }
  const report = { format: v3 ? 'patrick-emitted-runtime-execution-v2' : 'patrick-emitted-runtime-execution-v1',
    ...(v3 && { directoryNative: inventory.directoryNative,
      directoryHandshake: { format: 'patrick-directory-module', interfaceVersion: 1, napiVersion: 8 } }),
    materialSha256: material.materialSha256, inventorySha256: material.inventorySha256,
    toolchainSha256: material.toolchainSha256, nativeSha256: inventory.native.sha256, observed: inventory.observed, native: inventory.native, entries, scenarios };
  const reportPath = join(temporary, 'report.json');
  await writeFile(reportPath, bytes(report));
  const evidence: ExplicitEvidenceInput = { report: { path: reportPath, sha256: sha256(bytes(report)) }, logs };
  const prepared: PreparedEmittedRuntimeCandidate = await prepareEmittedRuntimeCandidate({ ...input, expectedMaterialSha256: material.materialSha256, evidence });
  const packagePath: string = join(temporary, 'candidate.json');
  const packed = await packEmittedRuntimeCandidate(prepared, { signatures: [signature(Buffer.from(prepared.signingManifestBase64, 'base64'))], outputPath: packagePath, outputStaging: staging });
  const expected: EmittedReleaseExpectation = { version: input.version, target: input.target, schema: input.schema, activeSchema: 1, source: input.expectedSource,
    runtime: { node: process.version, modules: process.versions.modules }, toolchainSha256: material.toolchainSha256, inventorySha256: material.inventorySha256,
    materialSha256: material.materialSha256, packageSha256: packed.packageSha256 };
  const policy: EmittedReleaseTrustPolicy = { keys: [{ id: 'fixture', publicKey }], executionReportSha256: evidence.report.sha256, requiredScenarios: logs.map(log => ({ id: log.id, evidenceSha256: log.sha256 })) };
  return { input, evidence, prepared, packagePath, expected, policy, material, artifact, built };
}

afterAll(async () => {
  hook?.deregister();
  if (temporary) await rm(temporary, { recursive: true, force: true });
  expect(candidateLoads).toBe(0);
});

describe.skipIf(!process.env.PATRICK_T25_TEST_RECIPE)('independently configured local native build and synthetic byte admission', () => {
  let v3: Awaited<ReturnType<typeof buildFixture>>;
  let pins: NativeByteReleaseExpectation;
  beforeAll(async () => {
    const dir = join(temporary, 'native-v3');
    await mkdir(dir);
    v3 = await buildFixture(dir, nativeProfile);
    pins = { ...v3.expected, profile: nativeProfile, directoryAuthoritySha256: process.env.PATRICK_T25_TEST_RECIPE_SHA256!,
      directoryNativeSha256: sha256(await readFile(join(v3.built, directoryPath))) };
  }, 120_000);

  test('v3 binds both genuine build outputs and rejects consumption of its byte receipt', async () => {
    const verifyNative = (expected = pins, policy = v3.policy) =>
      verifyEmittedRuntimeCandidate(v3.packagePath, { staging, expected, policy });
    const checked = await verifyNative();
    const sidecar = JSON.parse(await readFile(v3.input.toolchain.path, 'utf8'));
    expect(sidecar.directoryBuild.buildHost).toEqual(arm64Host);
    expect(sidecar.directoryBuild.authority).toMatchObject({ buildHost: arm64Host, buildMode: 'native', target: arm64Target });
    expect(checked.directoryAuthoritySha256).toBe(sha256(bytes(sidecar.directoryBuild.authority)));
    expect(checked).toMatchObject({ profile: nativeProfile, directoryNativeSha256: pins.directoryNativeSha256,
      nativeSha256: checked.runtime.native.sha256, runtime: { node: 'v26.13.0', modules: '147', napi: '10', directoryNative: {
        path: directoryPath, fileType: 'MH_BUNDLE', architecture: process.arch, interfaceVersion: 1, napiVersion: 8 } } });
    expect(checked.materials.filter(row => row.path.endsWith('.node')).map(row => [row.path, row.role, row.mode])).toEqual([
      [directoryPath, 'directory-diagnostic-addon', '100755'], [checked.runtime.native.path, 'native-addon', '100755']]);
    expect(checked.materials.filter(row => row.path.startsWith('deploy/'))).toHaveLength(5);
    const binary = await readFile(join(v3.built, directoryPath));
    expect(() => directoryIdentity(binary, process.arch === 'arm64' ? 'x64' : 'arm64')).toThrow('RUNTIME_DIRECTORY_MATERIAL_INVALID');
    expect(() => directoryIdentity(binary.subarray(0, 32), checked.target.arch)).toThrow('RUNTIME_DIRECTORY_MATERIAL_INVALID');
    const destination = join(temporary, 'native-stage');
    // @ts-expect-error native byte receipts have no staging authority
    await expect(stageVerifiedEmittedRuntime(checked, { staging, destination })).rejects.toThrow(/byte-only/);
    // @ts-expect-error native byte receipts have no published deployment authority
    await expect(withPublishedDeployment(checked, { staging, releasesRoot: temporary }, async () => 0)).rejects.toThrow(/complete deployment/);
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const key of ['directoryAuthoritySha256','directoryNativeSha256','materialSha256'] as const)
      await expect(verifyNative({ ...pins, [key]: '0'.repeat(64) })).rejects.toThrow(/independent|expected material/);
    await expect(verifyNative(pins, { ...v3.policy, requiredScenarios: v3.policy.requiredScenarios.filter(s => s.id !== directoryScenario) })).rejects.toThrow(/scenario set/);
    await expect(verifyNative(pins, { ...v3.policy, requiredScenarios: v3.policy.requiredScenarios.map(s =>
      s.id === directoryScenario ? { ...s, evidenceSha256: '0'.repeat(64) } : s) })).rejects.toThrow(/scenario log/);
    await expect(verifyNative(pins, { ...v3.policy, keys: [] })).rejects.toThrow();
    await expect(verify()).resolves.toMatchObject({ profile: 'runtime-only' });
    for (const profile of ['runtime-only', 'deployment-complete'] as const)
      await expect(verifyEmittedRuntimeCandidate(v3.packagePath, { staging, policy: v3.policy, expected: { ...v3.expected, profile } })).rejects.toThrow(/profile/);
    await expect(verifyEmittedRuntimeCandidate(packagePath, { staging, policy, expected: { ...pins, packageSha256: expected.packageSha256 } })).rejects.toThrow(/profile/);
  }, 120_000);

  test('v3 rejects a newly signed synthetic report for the wrong directory material', async () => {
    const envelope = JSON.parse(await readFile(v3.packagePath, 'utf8'));
    const name = 'evidence/runtime-execution.json';
    const file = envelope.files.find((row: { path: string }) => row.path === name);
    const report = JSON.parse(Buffer.from(file.data, 'base64').toString());
    report.directoryNative.sha256 = '0'.repeat(64);
    const raw = bytes(report);
    file.data = raw.toString('base64');
    Object.assign(envelope.manifest.artifacts.find((row: { path: string }) => row.path === name), { bytes: raw.length, sha256: sha256(raw) });
    envelope.signatures = [signature(bytes(envelope.manifest))];
    const encoded = bytes(envelope), copy = join(temporary, 'native-wrong-evidence');
    await writeFile(copy, encoded);
    await expect(verifyEmittedRuntimeCandidate(copy, { staging, expected: { ...pins, packageSha256: sha256(encoded) },
      policy: { ...v3.policy, executionReportSha256: sha256(raw) } })).rejects.toThrow(/execution directory material/);
  }, 60_000);

  test('byte inspection checks the independent target and the observed builder host', async () => {
    await expect(inspectEmittedRuntimeMaterial({ ...v3.input, target: intelTarget })).rejects.toThrow('RUNTIME_DIRECTORY_TARGET_UNAPPROVED');
    const path = v3.input.toolchain.path, original = await readFile(path);
    try {
      const sidecar = JSON.parse(original.toString());
      sidecar.directoryBuild.buildHost = { ...arm64Host, machine: 'x86_64' };
      const raw = bytes(sidecar);
      await writeFile(path, raw);
      await expect(inspectEmittedRuntimeMaterial({ ...v3.input, toolchain: { path, sha256: sha256(raw) } }))
        .rejects.toThrow('RUNTIME_DIRECTORY_RECIPE_TARGET_MISMATCH');
    } finally { await writeFile(path, original); }
  }, 60_000);

  test('standalone v3 verification requires Darwin SQLite metadata', async () => {
    const path = join(v3.artifact, 'metadata/runtime-materials.json');
    const original = await readFile(path);
    const inv = JSON.parse(original.toString());
    inv.native.format = 'elf';
    try {
      await writeFile(path, JSON.stringify(inv));
      const result = spawnSync(process.execPath, [join(root, 'scripts/build-runtime.mjs'), 'verify',
        '--profile', nativeProfile, '--artifact-root', v3.artifact], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('RUNTIME_NATIVE_PLATFORM_MISMATCH');
    } finally { await writeFile(path, original); }
  });

  test('directory build identity binds the inventory after both sidecar inventory observations match', async () => {
    const path = join(v3.artifact, 'metadata/runtime-materials.json'), sidecarPath = v3.input.toolchain.path;
    const [original, originalTool] = await Promise.all([readFile(path), readFile(sidecarPath)]);
    const inv = JSON.parse(original.toString()), tool = JSON.parse(originalTool.toString());
    inv.directoryBuildSha256 = '0'.repeat(64);
    const raw = bytes(inv), sha = sha256(raw);
    for (const observation of [tool.inventory, tool.repeatInventory]) Object.assign(observation, { sha256: sha, bytes: raw.length });
    const sidecar = bytes(tool);
    try {
      await writeFile(path, raw);
      await writeFile(sidecarPath, sidecar);
      await expect(inspectEmittedRuntimeMaterial({ ...v3.input, expectedInventorySha256: sha,
        toolchain: { path: sidecarPath, sha256: sha256(sidecar) } })).rejects.toThrow('directory build identity mismatch');
    } finally { await writeFile(path, original); await writeFile(sidecarPath, originalTool); }
  }, 60_000);

  test('v3 rejects changed role, mode, architecture, version and missing native rows at material inspection', async () => {
    const path = join(v3.artifact, 'metadata/runtime-materials.json');
    const original = await readFile(path);
    const wrong = '0'.repeat(64);
    type Row = { path: string; mode: string; role: string; sha256: string; bytes: number };
    try {
      for (const change of ['role','mode','architecture','missing-directory','missing-sqlite','duplicate','version','unknown-field','toolchain'] as const) {
        const inv = JSON.parse(original.toString());
        const row = inv.files.find((row: Row) => row.path === directoryPath);
        if (change === 'role') row.role = 'native-addon';
        if (change === 'mode') row.mode = '100644';
        if (change === 'architecture') inv.directoryNative.architecture = process.arch === 'arm64' ? 'x64' : 'arm64';
        if (change === 'missing-directory' || change === 'missing-sqlite') inv.files = inv.files.filter((r: Row) => r.path !== (change === 'missing-directory' ? directoryPath : inv.native.path));
        if (change === 'duplicate') inv.files.splice(inv.files.indexOf(row), 0, { ...row });
        if (change === 'version') inv.schemaVersion = 2;
        if (change === 'unknown-field') inv.future = 4;
        if (change === 'toolchain') inv.directoryBuildSha256 = wrong;
        const raw = bytes(inv);
        await writeFile(path, raw);
        const errors = { role: /role.*mode/, mode: /role.*mode/, architecture: /directory native identity/,
          'missing-directory': /missing native material/, 'missing-sqlite': /missing native material/, duplicate: /duplicate/,
          version: /unsupported inventory/, 'unknown-field': /inventory fields/, toolchain: /toolchain inventory mismatch/ };
        await expect(inspectEmittedRuntimeMaterial({ ...v3.input, expectedInventorySha256: sha256(raw) })).rejects.toThrow(errors[change]);
      }
    } finally { await writeFile(path, original); }
    const tool = await readFile(v3.input.toolchain.path);
    try {
      const sidecar = JSON.parse(tool.toString());
      sidecar.repeatDirectoryBuild.objects[0].sha256 = wrong;
      const altered = bytes(sidecar);
      await writeFile(v3.input.toolchain.path, altered);
      await expect(inspectEmittedRuntimeMaterial({ ...v3.input, toolchain: {
        path: v3.input.toolchain.path, sha256: sha256(altered) } })).rejects.toThrow(/repeat directory build mismatch/);
    } finally { await writeFile(v3.input.toolchain.path, tool); }
  }, 120_000);
});

describe('signed deployment material', () => {
let dir: string;
let complete: Awaited<ReturnType<typeof buildSignedFixture>>;
beforeAll(async () => {
  dir = join(temporary, 'complete');
  await mkdir(dir);
  complete = await buildSignedFixture(dir, 'deployment-complete');
}, 120_000);

test('legacy profiles keep their own runtime target checks independently of native recipe approval', async () => {
  const other = process.arch === 'arm64' ? intelTarget : arm64Target;
  for (const original of [input, complete.input]) {
    await expect(inspectEmittedRuntimeMaterial({ ...original, target: other })).rejects.toThrow('target/runtime mismatch');
  }
}, 60_000);

test('standalone v2 verification rejects v3 runtime observation fields', async () => {
  const path = join(complete.artifact, 'metadata/runtime-materials.json'), original = await readFile(path);
  const inv = JSON.parse(original.toString());
  inv.observed.napi = '10';
  try {
    await writeFile(path, JSON.stringify(inv));
    const result = spawnSync(process.execPath, [join(root, 'scripts/build-runtime.mjs'), 'verify',
      '--profile', 'deployment-complete', '--artifact-root', complete.artifact], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('RUNTIME_INVENTORY_INVALID');
  } finally { await writeFile(path, original); }
});

test('requires an independent complete profile pin and the genuine deployment stage', async () => {
  await expect(verify({ profile: 'deployment-complete' })).rejects.toThrow(/profile/);
  const options = { staging, expected: complete.expected, policy: complete.policy };
  const checked = await verifyEmittedRuntimeCandidate(complete.packagePath, options);
  expect(checked.profile).toBe('deployment-complete');
  for (const profile of [undefined, 'runtime-only', 'unknown'] as const) {
    await expect(verifyEmittedRuntimeCandidate(complete.packagePath, { ...options,
      expected: { ...complete.expected, profile } as EmittedReleaseExpectation })).rejects.toThrow(/profile/);
  }
  const otherPolicy = { ...options, policy };
  await expect(verifyEmittedRuntimeCandidate(complete.packagePath, otherPolicy)).rejects.toThrow(/report pin/);
  const roles = {
    caddy: ['deploy/Caddyfile', 'caddy-template'],
    service: ['deploy/launchd/com.patrick.service.plist', 'service-launchd-template'],
    hub: ['deploy/launchd/com.patrick.autoloop-hub.plist', 'hub-launchd-template'],
    worker: ['deploy/launchd/com.patrick.autoloop-worker.plist', 'worker-launchd-template'],
    lima: ['deploy/lima/executor.yaml', 'lima-executor-template'],
  } as const;
  const templates = checked.materials.filter(row => row.path.startsWith('deploy/'));
  expect(templates).toHaveLength(5);
  const destination = join(dir, 'stage');
  const token = await stageVerifiedEmittedRuntime(checked, { staging, destination });
  const v1 = await verify();
  const v1Token = await stageVerifiedEmittedRuntime(v1, { staging, destination: join(dir, 'stage-runtime') });
  let effects = 0;
  const effect = async () => ++effects;
  await expect(withStagedDeployment(v1, v1Token, effect)).rejects.toThrow(/complete deployment profile/);
  await expect(withStagedDeployment({ ...checked }, token, effect)).rejects.toThrow();
  await expect(withStagedDeployment(checked, v1Token, effect)).rejects.toThrow();
  expect(effects).toBe(0);
  expect(token.profile).toBe('deployment-complete');
  await withStagedDeployment(checked, token, async admitted => {
    expect(admitted.profile).toBe('deployment-complete');
    for (const [key, [path, role]] of Object.entries(roles)) {
      const source = await readFile(join(root, path));
      expect(templates).toContainEqual({ path, role, mode: '100644', bytes: source.length, sha256: sha256(source) });
      const staged = admitted.templates[key as keyof typeof roles];
      expect(staged).toBe(join(destination, path));
      expect(await readFile(staged)).toEqual(source);
    }
    const sources = {
      caddy: await readFile(admitted.templates.caddy), service: await readFile(admitted.templates.service),
      hub: await readFile(admitted.templates.hub), worker: await readFile(admitted.templates.worker),
    };
    const rendered = renderDeploymentTemplates(sources, registration);
    expect(rendered.caddy).toContain('reverse_proxy @registered [::1]:43123');
    expect(rendered.caddy).toContain('https://patrick.example.test:8443 {');
    expect(rendered.caddy).toContain('tls "' + registration.certificatePath + '" "' + registration.keyPath + '"');
    expect(rendered.caddy).not.toMatch(/header_up|@@|localhost|127\.0\.0\.1/);
    expect(rendered.caddyProcess).toEqual({
      account: '_proxy', configPath: base+'/caddy/config/Caddyfile', workingDirectory: base+'/caddy',
      environment: { HOME: base+'/caddy/home', XDG_CONFIG_HOME: base+'/caddy/config', XDG_DATA_HOME: base+'/caddy/data' },
    });
    await writeFile(join(dir, 'Caddyfile'), rendered.caddy);
    for (const role of ['service','hub','worker'] as const) {
      const path = join(dir, role+'.plist');
      await writeFile(path, rendered.plists[role]);
      child(['-lint', path], dir, '/usr/bin/plutil');
      const parsed = JSON.parse(child(['-convert', 'json', '-o', '-', path], dir, '/usr/bin/plutil'));
      const label = 'com.patrick.' + (role === 'service' ? role : 'autoloop-' + role);
      expect(parsed).toEqual({ Label: label, ProgramArguments: [registration.controllerPath, 'run-role', role],
        UserName: registration.accounts[role], WorkingDirectory: base+'/runtime/'+role,
        EnvironmentVariables: { HOME: base+'/runtime/'+role+'/home' }, StandardOutPath: base+'/logs/'+role+'/redacted.stdout.log',
        StandardErrorPath: base+'/logs/'+role+'/redacted.stderr.log', Umask: 63, ProcessType: 'Background', RunAtLoad: true, KeepAlive: true });
    }
    for (const bad of [
      { origin: 'http://patrick.example.test' }, { origin: 'https://patrick.example.test/extra' },
      { origin: 'https://user@patrick.example.test' }, { origin: 'https://*.example.test' },
      { listener: { host: '0.0.0.0', port: 43123 } }, { listener: { host: '::1', port: 0 } },
      { keyPath: registration.certificatePath }, { keyPath: base+'/caddy/trust/../keys/key' },
      { certificatePath: base+'/caddy/trust/\n import evil' }, { instanceRoot: '/fixture/{env.HOME}' },
      { controllerPath: '/bin/sh' }, { controllerPath: '/controllers/CURRENT/'+digest+'/patrick-host-controller' },
      { controllerPath: base+'/'+digest+'/patrick-host-controller' }, { args: ['-c','echo'] },
      { accounts: { ...registration.accounts, service: 'root' } }, { accounts: { ...registration.accounts, worker: registration.accounts.hub } },
    ]) expect(() => renderDeploymentTemplates(sources, { ...registration, ...bad } as typeof registration)).toThrow();
    expect(() => renderDeploymentTemplates({ ...sources, worker: sources.hub }, registration)).toThrow(/content/);
    expect(renderDeploymentTemplates(sources, { ...registration, listener: { host: '127.0.0.1', port: 4431 } }).caddy).toContain('127.0.0.1:4431');
  });
  // A separately provisioned consumer can re-open this explicit pin set and
  // the fixture public key in a fresh process without retaining signing keys.
  await writeFile(join(dir, 'fixture-pins.json'), bytes({ expected: complete.expected, policy: complete.policy }));
}, 120_000);

async function publishFixture(label: string) {
  const releasesRoot = join(dir, label);
  await mkdir(releasesRoot, { mode: 0o700 });
  const options = { staging, expected: complete.expected, policy: complete.policy };
  const checked = await verifyEmittedRuntimeCandidate(complete.packagePath, options);
  const destination = join(dir, label + '-stage');
  const stage = await stageVerifiedEmittedRuntime(checked, { staging, destination });
  const installed = join(releasesRoot, checked.packageSha256);
  await rename(destination, installed);
  return { scope: { staging, releasesRoot }, installed, checked, stage };
}

// The fixture host serializes every lease under its private temporary root.
async function promotionHost(label: string) {
  const owner = join(dir, label);
  await mkdir(owner, { mode: 0o700 });
  const stagingRoot = join(owner, 'staging');
  const releasesRoot = join(owner, 'releases');
  const archive = join(owner, 'archive');
  await mkdir(stagingRoot);
  await mkdir(releasesRoot);
  await cp(complete.packagePath, archive);
  const hooks: { before?: () => Promise<void>; after?: () => Promise<void> } = {};
  const port = {
    publication: Object.freeze({ stagingRoot, releasesRoot }),
    withExclusiveReadRoot<T>(read: (root: string) => Promise<T>) {
      return staging.withExclusiveReadRoot(async () => {
        await hooks.before?.();
        const result = await read(owner);
        await hooks.after?.();
        return result;
      });
    },
  };
  const pins = { expected: complete.expected, policy: complete.policy };
  const checked = await verifyEmittedRuntimeCandidate(archive, { staging: port, ...pins });
  const destination = join(stagingRoot, 'first');
  const stage = await stageVerifiedEmittedRuntime(checked, { staging: port, destination });
  return { port, hooks, checked, stage, destination, installed: join(releasesRoot, checked.packageSha256),
    archive, stagingRoot, scope: { staging: port, releasesRoot }, pins };
}

test('first-install CLI publishes only the approved release and reads back the same claim after acknowledgement loss', async ({ onTestFinished }) => {
  const instanceRoot = join(dir, 'first-install-cli');
  await mkdir(instanceRoot, { mode: 0o700 });
  const stores = ['packages', 'releases', 'data', 'history', 'lima'] as const;
  const pin = async (path: string) => {
    const info = await lstat(path, { bigint: true });
    return { device: String(info.dev), inode: String(info.ino), birthtimeNs: String(info.birthtimeNs) };
  };
  const storePins = await Promise.all(stores.map(async name => {
    const path = join(instanceRoot, name);
    await mkdir(path, { mode: 0o700 });
    return [name, await pin(path)];
  }));
  const { expected, policy } = complete;
  await cp(complete.packagePath, join(instanceRoot, 'packages', expected.packageSha256 + '.json'));
  const identity = { accountId: 'owner', scopeId: 'workspace', deviceId: 'darwin', domains: ['personal'], configRevision: 'r1' };
  const certificate = join(dir, 'install-session.pem');
  const privateKey = join(dir, 'install-session.key');
  child(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', privateKey,
    '-out', certificate, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], dir, '/usr/bin/openssl');
  const ca = await readFile(certificate, 'utf8');
  const bearer = randomBytes(32).toString('hex');
  let requests = 0;
  const endpoint = createServer({ cert: ca, key: await readFile(privateKey) }, (request, response) => {
    requests++;
    if (request.url !== '/api/v1/session' || request.method !== 'GET' || request.headers.authorization !== 'Bearer ' + bearer) {
      response.writeHead(401).end();
      return;
    }
    response.end(JSON.stringify({ schema_version: '1.0', scope: { account_id: identity.accountId, permission_epoch: 1, data_domain: 'personal' },
      data: { account_id: identity.accountId, caller_id: 'web', auth_epoch: 1, domains: identity.domains } }));
  });
  await new Promise<void>((resolve, reject) => { endpoint.once('error', reject); endpoint.listen(0, '127.0.0.1', resolve); });
  onTestFinished(() => new Promise<void>((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve())));
  const address = endpoint.address();
  if (!address || typeof address === 'string') throw new Error('fixture endpoint missing');
  const origin = 'https://localhost:' + address.port;
  const uid = process.geteuid!();
  const captureHost = hostname();
  const node = await realpath(process.execPath);
  let loseAck = false;
  let queue: Promise<unknown> = Promise.resolve();
  const enrollment: InstallPreviewEnrollment = {
    installationId: 'first-install', releaseId: 'release', identity, hostname: captureHost, uid, root: instanceRoot,
    firstGenerationId: 'first-generation',
    rootNode: await pin(instanceRoot), stores: Object.fromEntries(storePins), node: { path: node, sha256: sha256(await readFile(node)) },
    expected, policy, targetSchema: expected.activeSchema, reserveBytes: { releases: 1000, data: 1000, lima: 1000 },
    deployment: { ...registration, instanceRoot, origin, listener: { ...registration.listener, port: address.port === 43123 ? 43124 : 43123 },
      certificatePath: join(instanceRoot, 'caddy/trust', 'cert.pem'),
      keyPath: join(instanceRoot, 'caddy/trust', 'key.ref') },
    templates: Object.fromEntries(await Promise.all(Object.entries(deploymentPaths).map(async ([role, path]) => [role, await readFile(join(root, path), 'utf8')]))),
    tls: { rpId: new URL(origin).hostname, caSha256: sha256(Buffer.from(ca)) },
    owner: { withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) {
      const run = queue.then(async () => {
        const result = await read(instanceRoot);
        if (loseAck) { loseAck = false; throw new Error('lost owner response'); }
        return result;
      });
      queue = run.catch(() => {});
      return run;
    } },
  };
  const approvals = generateKeyPairSync('ed25519');
  const journal = generateKeyPairSync('ed25519');
  const pem = (key: typeof approvals.publicKey) => key.export({ type: 'spki', format: 'pem' }) as string;
  const installOperations: Record<string, InstallReleaseEnrollment> = {};
  const provisioning = createRuntimeProvisioning({
    registration: { identity, captureHost, serviceUid: uid, minimumFreeBytes: 1, dataRoot: join(instanceRoot, 'data'),
      profile: 'test', origin, rpId: enrollment.tls.rpId, listener: { ...enrollment.deployment.listener, origin } },
    hostCapabilities: { installPreviews: { release: enrollment }, installOperations },
    service: { databasePath: join(instanceRoot, 'data', 'service.sqlite'), credentialDirectory: join(instanceRoot, 'credentials'),
      recoveryRuntime: { attach() { throw new Error('unexpected runtime start'); } },
      bindRecoveryOperations() { throw new Error('unexpected recovery startup'); } },
  });
  const cli = createInstalledCli(provisioning);
  const args = ['install', '--release', 'release'];
  const operationId = 'publish';
  const run = (action: string) => cli.run([...args, '--operation', operationId, '--' + action]);
  const preview = await cli.run(args);
  expect(preview.status, preview.code).toBe('preview');
  expect(preview.installPreview?.firstGenerationId).toBe('first-generation');
  const planSha256 = preview.installPreview!.planSha256;
  const approve = (plan: string, id = operationId, key = approvals.privateKey) => sign(null, installReleaseApproval({
    installationId: enrollment.installationId, releaseId: 'release', planSha256: plan,
  }, id), key).toString('base64');
  const records = () => readdir(join(instanceRoot, 'history'));
  const releaseStore = join(instanceRoot, 'releases');
  const published = join(releaseStore, expected.packageSha256);
  const signer = { signJournal: async (bytes: Uint8Array) => sign(null, bytes, journal.privateKey).toString('base64') };
  const operation = { releaseId: 'release', planSha256, journalKeyId: 'host-controller',
    journalPublicKey: pem(journal.publicKey), approvalPublicKey: pem(approvals.publicKey) };
  await expect(runFirstInstallRelease(() => enrollment, 'release', operationId, 'preview' as never,
    { ...operation, ...signer }, () => {})).rejects.toThrow();
  installOperations[operationId] = operation;
  expect(await run('readback')).toMatchObject({ status: 'absent' });
  expect(await run('execute')).toMatchObject({ status: 'unavailable', code: 'INSTALL_RELEASE_APPROVAL_REQUIRED' });
  for (const invalid of [approve('0'.repeat(64)), approve(planSha256, 'other-operation'),
    approve(planSha256, operationId, journal.privateKey)]) {
    installOperations[operationId] = { ...operation, ...signer, approval: invalid };
    expect(await run('execute')).toMatchObject({ status: 'blocked', code: 'INSTALL_RELEASE_ADMISSION_FAILED' });
  }
  installOperations[operationId] = { ...operation, ...signer, approvalPublicKey: operation.journalPublicKey,
    approval: approve(planSha256, operationId, journal.privateKey) };
  expect(await run('execute')).toMatchObject({ status: 'blocked', code: 'INSTALL_RELEASE_ADMISSION_FAILED' });
  installOperations[operationId] = { ...operation, ...signer, approval: approve(planSha256) };
  const dataReserve = enrollment.reserveBytes.data;
  enrollment.reserveBytes.data++;
  expect(await run('execute')).toMatchObject({ status: 'blocked', code: 'INSTALL_RELEASE_ADMISSION_FAILED' });
  enrollment.reserveBytes.data = dataReserve;
  expect(await records()).toEqual([]);
  expect(await readdir(releaseStore)).toEqual([]);
  const approved = installOperations[operationId]!;
  let interruptedTerminal = false;
  installOperations[operationId] = { ...approved, async signJournal(bytes) {
    if (JSON.parse(Buffer.from(bytes).toString()).kind === 'terminal') {
      interruptedTerminal = true;
      throw new Error('terminal signing interrupted');
    }
    return signer.signJournal(bytes);
  } };
  expect(await run('execute')).toMatchObject({ status: 'uncertain', code: 'LIFECYCLE_OUTCOME_UNCERTAIN' });
  expect(interruptedTerminal).toBe(true);
  expect(await run('readback')).toMatchObject({ status: 'uncertain' });
  expect(await records()).toHaveLength(2);
  const publishedInode = (await lstat(published)).ino;
  installOperations[operationId] = approved;
  loseAck = true;
  const [first, retry] = await Promise.all([run('execute'), run('execute')]);
  expect(first).toMatchObject({ status: 'uncertain', code: 'LIFECYCLE_OUTCOME_UNCERTAIN' });
  const readback = await run('readback');
  expect(readback).toMatchObject({ status: 'completed', code: 'INSTALL_RELEASE_PUBLISHED', operationId,
    prerequisites: ['schema-bootstrap', 'fixed-origin-tls', 'owner-passkey', 'authenticated-session'] });
  expect(retry.lifecycleReceipt).toEqual(readback.lifecycleReceipt);
  installOperations[operationId] = operation;
  expect((await run('readback')).lifecycleReceipt).toEqual(readback.lifecycleReceipt);
  expect(await readdir(releaseStore)).toEqual([expected.packageSha256]);
  expect((await lstat(published)).ino).toBe(publishedInode);
  expect(await readdir(join(instanceRoot, 'data'))).toEqual([]);
  expect(await readdir(join(instanceRoot, 'lima'))).toEqual([]);
  expect(await records()).toHaveLength(3);

  const prepare = (kernelPath: string | undefined, operationName = operationId, publication: InstallReleaseEnrollment = operation) =>
    prepareFirstInstallGeneration(() => enrollment, 'release', operationName,
      { ...publication, generation: { id: 'first-generation', kernelPath } }, () => {});
  const wrongKernel = join(dir, 'wrong-kernel.ts');
  await writeFile(wrongKernel, 'export function initialize() {}');
  await expect(prepare(wrongKernel, operationId, { ...operation, ...signer })).rejects.toThrow('AUTOLOOP_BOOTSTRAP_SOURCE_INVALID');
  expect(await readdir(join(instanceRoot, 'data'))).toEqual([]);
  expect(await run('prepare-generation')).toMatchObject({ status: 'unavailable', code: 'INSTALL_GENERATION_ENROLLMENT_REQUIRED' });
  const kernelPath = process.env.PATRICK_T23_AUTOLOOP_KERNEL;
  const dataRoot = join(instanceRoot, 'data', 'first-generation');
  let generation: InstalledGeneration;
  if (kernelPath) {
    await expect(prepare(kernelPath, 'wrong-operation')).rejects.toThrow();
    await expect(prepare(kernelPath, operationId, { ...operation, planSha256: '0'.repeat(64) })).rejects.toThrow();
    expect(await readdir(join(instanceRoot, 'data'))).toEqual([]);
    installOperations[operationId] = { ...operation, generation: { id: 'first-generation', kernelPath } };
    expect(await run('prepare-generation')).toMatchObject({ status: 'unavailable', code: 'INSTALL_GENERATION_SIGNER_REQUIRED' });
    installOperations[operationId] = { ...installOperations[operationId]!, ...signer, generation: { id: 'other-generation', kernelPath } };
    expect(await run('prepare-generation')).toMatchObject({ status: 'blocked', code: 'INSTALL_GENERATION_ADMISSION_FAILED' });
    installOperations[operationId] = { ...installOperations[operationId]!, generation: { id: 'first-generation', kernelPath } };
    lowSpace.path = join(instanceRoot, 'data');
    expect(await run('prepare-generation').finally(() => { lowSpace.path = ''; })).toMatchObject({
      status: 'blocked', code: 'INSTALL_GENERATION_ADMISSION_FAILED',
    });
    const staged = join(instanceRoot, 'data', '.bootstrap-first-generation');
    await mkdir(staged, { mode: 0o700 });
    expect(await run('prepare-generation')).toMatchObject({ status: 'uncertain', code: 'INSTALL_GENERATION_INTERRUPTED' });
    expect(await readdir(staged)).toEqual([]);
    await rm(staged, { recursive: true });
    loseAck = true;
    expect(await run('prepare-generation')).toMatchObject({ status: 'uncertain', code: 'INSTALL_GENERATION_INTERRUPTED' });
    const initializedInode = (await lstat(dataRoot)).ino;
    installOperations[operationId] = { ...operation, generation: { id: 'first-generation' } };
    lowSpace.path = join(instanceRoot, 'data');
    expect(await run('prepare-generation').finally(() => { lowSpace.path = ''; })).toMatchObject({
      action: 'prepare-generation', status: 'completed', code: 'INSTALL_GENERATION_PREPARED',
      operationId, generationId: 'first-generation', prerequisites: ['fixed-origin-tls', 'owner-passkey', 'authenticated-session'],
    });
    expect((await lstat(dataRoot)).ino).toBe(initializedInode);
    generation = await prepare(undefined);
    const readSchema = (name: string, sql: string) => {
      const db = new DatabaseSync(join(dataRoot, name), { readOnly: true });
      try { return db.prepare(sql).all(); } finally { db.close(); }
    };
    const manifest = JSON.parse(await readFile(join(published, 'migrations', 'manifest.json'), 'utf8'));
    expect(readSchema('service.sqlite', 'SELECT file, sha256 FROM schema_migrations ORDER BY position')).toEqual(manifest);
    expect(readSchema('hub.sqlite', 'SELECT name FROM sqlite_schema WHERE type = \'table\' ORDER BY name')).toEqual(
      ['facts', 'projection_meta', 'projection_pending', 'projection_refs', 'projections'].map(name => ({ name })));
    expect(readSchema('answers.sqlite', 'SELECT question_id, card_id, body_json, answer_event_id FROM hub_answers')).toEqual([]);
    expect(await readdir(dataRoot)).toHaveLength(7);
    const hubDb = join(dataRoot, 'hub.sqlite');
    const originalHub = await readFile(hubDb);
    const modified = new DatabaseSync(hubDb);
    try { modified.exec("INSERT INTO projections (collection, key, data) VALUES ('cards', 'fixture', '{}')"); }
    finally { modified.close(); }
    try { await expect(prepare(kernelPath)).rejects.toThrow(); }
    finally { await writeFile(hubDb, originalHub); }
    expect(await records()).toHaveLength(3);
    await expect(lstat(join(instanceRoot, 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
    installOperations[operationId] = operation;
  } else {
    await mkdir(dataRoot, { mode: 0o700 });
    const roles = Object.fromEntries(await Promise.all(
      ['service.sqlite', 'hub.sqlite', 'answers.sqlite', 'credentials', 'blobs', 'projections'].map(async role => {
        const path = join(dataRoot, role);
        if (role.endsWith('.sqlite')) await writeFile(path, '', { mode: 0o600 });
        else await mkdir(path, { mode: 0o700 });
        return [role, await pin(path)];
      }),
    )) as InstalledGeneration['roles'];
    generation = { id: 'first-generation', schema: expected.activeSchema, packageSha256: expected.packageSha256,
      releaseRoot: await pin(published), dataRoot: await pin(dataRoot), roles };
  }
  const generationKey = generateKeyPairSync('ed25519');
  const { packages, releases, data, history } = enrollment.stores;
  const store = createGenerationStore({
    installationId: enrollment.installationId, hostId: 'fixture-host', identity, root: instanceRoot,
    target: expected.target, publicKey: pem(generationKey.publicKey), rootNode: enrollment.rootNode,
    stores: { packages, releases, data, history }, releases: [{ expected, policy }], generations: [generation],
  }, enrollment.owner, {
    async signRecord(payload) { return sign(null, payload, generationKey.privateKey).toString('base64'); },
  });
  await expect(store.observe()).resolves.toEqual({ current: null, pending: null, historical: null });
  const unknownRecord = join(instanceRoot, 'history', 'lifecycle-v1.publish.unrecognized.json');
  await writeFile(unknownRecord, '{}', { mode: 0o600 });
  await expect(store.observe()).rejects.toThrow('GENERATION_BINDING_INVALID');
  await unlink(unknownRecord);
  const order = store.order('select-first', null, generation.id);
  const selection = canonicalize({ order, signature: sign(null, bytes(order), generationKey.privateKey).toString('base64') });
  await expect(store.select(selection)).resolves.toMatchObject({ current: { order }, pending: null });
  await expect(store.observe('select-first')).resolves.toMatchObject({ current: { order }, historical: { order }, pending: null });
  if (kernelPath) await expect(prepare(kernelPath)).rejects.toThrow();
  expect((await run('readback')).lifecycleReceipt).toEqual(readback.lifecycleReceipt);

  expect(requests).toBe(0);
  enrollment.session = { bootstrapPlanSha256: planSha256, ca, callerId: 'web', authEpoch: 1, credentialRevision: 'local-fixture',
    readBearer: async () => bearer };
  const checkSession = () => cli.run([...args, '--check-session']);
  lowSpace.path = join(instanceRoot, 'data');
  const session = await checkSession().finally(() => { lowSpace.path = ''; });
  expect(session).toMatchObject({ action: 'check-session', status: 'completed', code: 'INSTALL_SESSION_OBSERVED',
    installSession: { phase: 'authenticated-session', planSha256, observed: ['fixed-origin-tls', 'authenticated-session'],
      outstanding: ['schema-bootstrap', 'owner-passkey'], activationAuthorized: false, delegationAuthorized: false } });
  for (const privateValue of [bearer, ca, origin, instanceRoot]) expect(JSON.stringify(session)).not.toContain(privateValue);
  expect(requests).toBe(1);
  enrollment.session = { ...enrollment.session, authEpoch: 2 };
  expect(await checkSession()).toMatchObject({ status: 'blocked', code: 'INSTALL_PREVIEW_SESSION' });
  expect(requests).toBe(2);
  expect((await run('readback')).lifecycleReceipt).toEqual(readback.lifecycleReceipt);

  await writeFile(join(published, 'extra-file'), 'modified');
  expect(await run('readback')).toMatchObject({ status: 'blocked', code: 'INSTALL_RELEASE_ADMISSION_FAILED' });
}, 120_000);

test.each(['owner-lost', 'live-ack-lost'])('reports an actual derived stage mkdir as uncertain on %s', async mode => {
  const owner = join(dir, 'parent-lease-mkdir-' + mode);
  await mkdir(owner, { mode: 0o700 });
  const stagingRoot = join(owner, 'staging'), releasesRoot = join(owner, 'releases'), archive = join(owner, 'archive');
  await mkdir(stagingRoot); await mkdir(releasesRoot); await cp(complete.packagePath, archive);
  const verifier = pathToFileURL(join(root, 'deploy/lib/emitted-release.mjs')).href;
  const probe = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    const [root, archive, stagingRoot, releasesRoot, pins, mode] = process.argv.slice(1);
    const destination = join(stagingRoot, 'candidate');
    let signal, resume;
    const started = new Promise(resolve => signal = resolve);
    const continueMkdir = new Promise(resolve => resume = resolve);
    let released = false, lateMkdirs = 0, mkdirAttempts = 0, created = false;
    const original = fs.promises.mkdir;
    fs.promises.mkdir = async function(path, ...args) {
      if (String(path).startsWith(destination) && released) lateMkdirs++;
      if (path === destination) mkdirAttempts++;
      const result = await Reflect.apply(original, this, [path, ...args]);
      if (path === destination) {
        created = true; fs.writeFileSync(join(destination, 'foreign-sentinel'), 'untouched'); signal();
        if (mode === 'owner-lost') await continueMkdir;
        throw Error('mkdir acknowledgement lost');
      }
      return result;
    };
    syncBuiltinESMExports();
    const { leased, deriveRuntimeStaging, verifyEmittedRuntimeCandidate, stageVerifiedEmittedRuntime,
      readEmittedWriteOutcome } = await import(${JSON.stringify(verifier)});
    const owner = { async withExclusiveReadRoot(read) {
      const pending = read(root);
      if (mode !== 'owner-lost') return await pending;
      pending.catch(() => {});
      await started;
      released = true;
      setImmediate(resume);
    } };
    let stageFailure, savedStaging, savedReceipt;
    const run = leased(owner, async parent => {
      const staging = deriveRuntimeStaging(parent, root, { stagingRoot, releasesRoot });
      const checked = await verifyEmittedRuntimeCandidate(archive, { staging, ...JSON.parse(pins) });
      savedStaging = staging; savedReceipt = checked;
      try { await stageVerifiedEmittedRuntime(checked, { staging, destination }); }
      catch (error) {
        stageFailure = error;
        if (mode === 'owner-lost') throw error;
        assert.equal((await readEmittedWriteOutcome(error)).state, 'unavailable');
        const parked = destination + '-preserved';
        fs.renameSync(destination, parked);
        const repeated = await stageVerifiedEmittedRuntime(checked, { staging, destination }).catch(error => error);
        assert.equal(repeated, error);
        const another = deriveRuntimeStaging(parent, root, { stagingRoot, releasesRoot });
        const anotherReceipt = await verifyEmittedRuntimeCandidate(archive, { staging: another, ...JSON.parse(pins) });
        const alternate = await stageVerifiedEmittedRuntime(anotherReceipt, { staging: another, destination }).catch(error => error);
        assert.equal(alternate, error);
        const different = destination + '-different';
        const otherPath = await stageVerifiedEmittedRuntime(anotherReceipt, { staging: another, destination: different }).catch(error => error);
        assert.equal(otherPath, error);
        assert(!fs.existsSync(different));
        const intermediate = deriveRuntimeStaging(parent, root);
        await leased(intermediate, async nestedParent => {
          const nested = deriveRuntimeStaging(nestedParent, root, { stagingRoot, releasesRoot });
          const nestedReceipt = await verifyEmittedRuntimeCandidate(archive, { staging: nested, ...JSON.parse(pins) });
          const deepRetry = await stageVerifiedEmittedRuntime(nestedReceipt, { staging: nested, destination }).catch(error => error);
          assert.equal(deepRetry, error);
        }, true);
        assert(!fs.existsSync(destination));
        assert.equal(fs.readFileSync(join(parked, 'foreign-sentinel'), 'utf8'), 'untouched');
        fs.renameSync(parked, destination);
      }
    }, true);
    if (mode === 'owner-lost') await assert.rejects(run); else await run;
    assert(created && fs.existsSync(destination));
    assert.equal(lateMkdirs, 0);
    assert.equal(stageFailure?.code, 'EMITTED_WRITE_UNCERTAIN');
    assert.equal((await readEmittedWriteOutcome(stageFailure)).state, 'unavailable');
    const inode = fs.lstatSync(destination, { bigint: true }).ino;
    const repeated = await stageVerifiedEmittedRuntime(savedReceipt, { staging: savedStaging, destination }).catch(error => error);
    assert.equal(repeated, stageFailure);
    assert.equal(mkdirAttempts, 1);
    assert.equal(fs.lstatSync(destination, { bigint: true }).ino, inode);
    assert.equal(fs.readFileSync(join(destination, 'foreign-sentinel'), 'utf8'), 'untouched');
  `;
  child(['--input-type=module', '-e', probe, owner, archive, stagingRoot, releasesRoot, JSON.stringify({ expected: complete.expected, policy: complete.policy }), mode]);
}, 120_000);

test('a derived stage rejects an existing foreign directory without claiming or changing it', async () => {
  const owner = join(dir, 'parent-lease-foreign');
  await mkdir(owner, { mode: 0o700 });
  const stagingRoot = join(owner, 'staging'), releasesRoot = join(owner, 'releases'), archive = join(owner, 'archive');
  await mkdir(stagingRoot); await mkdir(releasesRoot); await cp(complete.packagePath, archive);
  const verifier = pathToFileURL(join(root, 'deploy/lib/emitted-release.mjs')).href;
  const probe = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { join } from 'node:path';
    const [root, archive, stagingRoot, releasesRoot, pins] = process.argv.slice(1);
    const destination = join(stagingRoot, 'foreign');
    fs.mkdirSync(destination, { mode: 0o700 });
    fs.writeFileSync(join(destination, 'sentinel'), 'private original');
    const before = fs.lstatSync(destination, { bigint: true });
    const { leased, deriveRuntimeStaging, verifyEmittedRuntimeCandidate, stageVerifiedEmittedRuntime } = await import(${JSON.stringify(verifier)});
    const owner = { async withExclusiveReadRoot(read) { return await read(root); } };
    await leased(owner, async parent => {
      const staging = deriveRuntimeStaging(parent, root, { stagingRoot, releasesRoot });
      const checked = await verifyEmittedRuntimeCandidate(archive, { staging, ...JSON.parse(pins) });
      await assert.rejects(stageVerifiedEmittedRuntime(checked, { staging, destination }), { code: 'EEXIST' });
    }, true);
    assert.equal(fs.lstatSync(destination, { bigint: true }).ino, before.ino);
    assert.deepEqual(fs.readdirSync(destination), ['sentinel']);
    assert.equal(fs.readFileSync(join(destination, 'sentinel'), 'utf8'), 'private original');
  `;
  child(['--input-type=module', '-e', probe, owner, archive, stagingRoot, releasesRoot, JSON.stringify({ expected: complete.expected, policy: complete.policy })]);
}, 120_000);

test.each(['success', 'before-rename-loss', 'after-rename-loss'])('holds the derived owner through publication: %s', async mode => {
  const owner = join(dir, 'parent-lease-publish-' + mode);
  await mkdir(owner, { mode: 0o700 });
  const stagingRoot = join(owner, 'staging'), releasesRoot = join(owner, 'releases'), archive = join(owner, 'archive');
  await mkdir(stagingRoot); await mkdir(releasesRoot); await cp(complete.packagePath, archive);
  const verifier = pathToFileURL(join(root, 'deploy/lib/emitted-release.mjs')).href;
  const probe = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    const [root, archive, stagingRoot, releasesRoot, pins, mode] = process.argv.slice(1);
    const destination = join(stagingRoot, 'candidate');
    let signal, resume;
    const triggered = new Promise(resolve => signal = resolve);
    const proceed = new Promise(resolve => resume = resolve);
    let renames = 0, released = false, lateRenames = 0;
    const originalRename = fs.renameSync;
    fs.renameSync = function(from, to) {
      if (from === destination) {
        renames++; if (released) lateRenames++;
        const result = Reflect.apply(originalRename, this, [from, to]);
        if (mode === 'after-rename-loss') { signal(); throw Error('rename acknowledgement lost'); }
        return result;
      }
      return Reflect.apply(originalRename, this, [from, to]);
    };
    syncBuiltinESMExports();
    const { leased, deriveRuntimeStaging, verifyEmittedRuntimeCandidate, stageVerifiedEmittedRuntime,
      publishStagedDeployment, withPublishedDeployment } = await import(${JSON.stringify(verifier)});
    const owner = { async withExclusiveReadRoot(read) {
      const pending = read(root);
      if (mode === 'success') return await pending;
      pending.catch(() => {});
      await triggered; released = true; setImmediate(resume);
    } };
    let failure, staging, checked, token, installed;
    const run = leased(owner, async parent => {
      staging = deriveRuntimeStaging(parent, root, { stagingRoot, releasesRoot });
      checked = await verifyEmittedRuntimeCandidate(archive, { staging, ...JSON.parse(pins) });
      installed = join(releasesRoot, checked.packageSha256);
      token = await stageVerifiedEmittedRuntime(checked, { staging, destination });
      if (mode === 'before-rename-loss') { signal(); await proceed; await new Promise(resolve => setImmediate(resolve)); }
      try {
        await publishStagedDeployment(checked, token);
        assert.equal(await withPublishedDeployment(checked, { staging, releasesRoot }, async value => value.root), installed);
      } catch (error) { failure = error; throw error; }
    }, true);
    if (mode === 'success') await run; else await assert.rejects(run);
    if (mode === 'before-rename-loss') {
      assert.equal(renames, 0); assert.equal(lateRenames, 0);
      assert(fs.existsSync(destination)); assert(!fs.existsSync(installed)); assert(failure);
    } else {
      assert.equal(renames, 1); assert.equal(lateRenames, 0);
      assert(!fs.existsSync(destination)); assert(fs.existsSync(installed));
      if (mode === 'after-rename-loss') {
        assert.equal(failure?.code, 'EMITTED_PUBLICATION_UNCERTAIN');
        await assert.rejects(publishStagedDeployment(checked, token));
        assert.equal(renames, 1);
      }
    }
  `;
  child(['--input-type=module', '-e', probe, owner, archive, stagingRoot, releasesRoot,
    JSON.stringify({ expected: complete.expected, policy: complete.policy }), mode]);
}, 120_000);

test('publishes the exact staged deployment and authenticates its new slot in a fresh process', async () => {
  const { scope, installed, checked, stage, destination, archive } = await promotionHost('promotion');
  const pathsToCheck = ['', ...checked.materials.map(row => row.path)];
  const identities = async (directory: string) => Promise.all(pathsToCheck.map(async path => {
    const info = await lstat(join(directory, path), { bigint: true });
    return [info.dev, info.ino, info.birthtimeNs, info.mode];
  }));
  const before = await identities(destination);
  expect(typeof publishStagedDeployment).toBe('function');
  await expect(publishStagedDeployment(checked, stage)).resolves.toEqual({ path: installed, packageSha256: checked.packageSha256 });
  expect(await identities(installed)).toEqual(before);
  await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(publishStagedDeployment(checked, stage)).rejects.toThrow();
  let staleCalls = 0;
  await expect(withStagedDeployment(checked, stage, async () => ++staleCalls)).rejects.toThrow();
  expect(staleCalls).toBe(0);
  expect(typeof withPublishedDeployment).toBe('function');
  // Only the test host supplies the repository, registered locations, independent pins and public key.
  const verifier = pathToFileURL(join(root, 'deploy/lib/emitted-release.mjs')).href;
  const probe = `
    import { readFile } from 'node:fs/promises';
    import { createHash } from 'node:crypto';
    import { withPublishedDeployment, verifyEmittedRuntimeCandidate } from ${JSON.stringify(verifier)};
    const [owner, releasesRoot, archive, pins] = process.argv.slice(1);
    let held = false;
    const staging = { async withExclusiveReadRoot(read) {
      if (held) throw Error('nested lease');
      held = true;
      try { return await read(owner); } finally { held = false; }
    } };
    const receipt = await verifyEmittedRuntimeCandidate(archive, { staging, ...JSON.parse(pins) });
    const observed = await withPublishedDeployment(receipt, { staging, releasesRoot }, async deployment => {
      const files = [];
      for (const path of [...Object.values(deployment.entrypoints), ...Object.values(deployment.templates)]) {
        const data = await readFile(path);
        if (!held) throw Error('lease ended during use');
        files.push({ path, sha256: createHash('sha256').update(data).digest('hex') });
      }
      return { ...deployment, files };
    });
    console.log(JSON.stringify(observed));
  `;
  const observed = JSON.parse(child(['--input-type=module', '-e', probe, dirname(archive), scope.releasesRoot, archive,
    JSON.stringify({ expected: complete.expected, policy: complete.policy })]));
  expect(observed).toMatchObject({ root: installed, profile: 'deployment-complete', runtime: checked.runtime,
    packageSha256: checked.packageSha256, materialSha256: checked.materialSha256, inventorySha256: checked.inventorySha256 });
  const paths = [...entries, ...Object.values(deploymentPaths)];
  expect(observed.files).toEqual(paths.map(path => ({ path: join(installed, path), sha256: checked.materials.find(row => row.path === path)?.sha256 })));
}, 120_000);

test('refuses publication before rename on a foreign token, store, archive or occupied slot', async () => {
  const { port, stage, checked, destination, archive, installed, scope, pins, stagingRoot, hooks } = await promotionHost('promotion-refusals');
  const untrustedKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString();
  await expect(verifyEmittedRuntimeCandidate(archive, {
    staging: port, ...pins, policy: { ...pins.policy, keys: [{ id: 'fixture', publicKey: untrustedKey }] },
  })).rejects.toThrow(/signature/);
  const again = await verifyEmittedRuntimeCandidate(archive, { staging: port, ...pins });
  const secondary = join(stagingRoot, 'secondary');
  const other = await stageVerifiedEmittedRuntime(again, { staging: port, destination: secondary });
  const runtimeOnly = await verify();
  const runtimeToken = await stageVerifiedEmittedRuntime(runtimeOnly, { staging, destination: join(dir, 'promotion-runtime') });
  await expect(publishStagedDeployment(runtimeOnly, runtimeToken)).rejects.toThrow();
  await expect(publishStagedDeployment({ ...checked }, stage)).rejects.toThrow();
  await expect(publishStagedDeployment(again, stage)).rejects.toThrow();
  await expect(publishStagedDeployment(checked, other)).rejects.toThrow();
  await expect(publishStagedDeployment(checked, { ...stage })).rejects.toThrow();
  await expect(stageVerifiedEmittedRuntime(checked, { staging: { ...port }, destination: secondary + '-cross' })).rejects.toThrow();
  const unregistered = await verifyEmittedRuntimeCandidate(archive, { staging, ...pins });
  const unset = await stageVerifiedEmittedRuntime(unregistered, { staging, destination: join(stagingRoot, 'unenrolled') });
  await expect(publishStagedDeployment(unregistered, unset)).rejects.toThrow();
  const original = await lstat(destination, { bigint: true });
  const unchanged = async () => expect((await lstat(destination, { bigint: true })).ino).toBe(original.ino);
  for (const create of [
    () => mkdir(installed),
    () => writeFile(installed, 'foreign'),
    () => symlink(destination, installed),
  ]) {
    await create();
    const existing = await lstat(installed, { bigint: true });
    await expect(publishStagedDeployment(checked, stage)).rejects.toThrow(/occupied/);
    expect((await lstat(installed, { bigint: true })).ino).toBe(existing.ino);
    await unchanged();
    await rm(installed, { recursive: true });
  }
  const alias = join(dirname(archive), 'alias');
  await symlink(scope.releasesRoot, alias);
  const badScopes = [
    { releasesRoot: stagingRoot, stagingRoot },
    { releasesRoot: dirname(archive), stagingRoot },
    { releasesRoot: scope.releasesRoot, stagingRoot: scope.releasesRoot + '/.' },
    { releasesRoot: alias, stagingRoot },
    { releasesRoot: temporary, stagingRoot },
    { releasesRoot: scope.releasesRoot, stagingRoot: dirname(archive) },
  ];
  for (const publication of badScopes) {
    const invalid = { ...port, publication };
    await expect(verifyEmittedRuntimeCandidate(archive, { staging: invalid, ...pins })).rejects.toThrow();
  }
  const wrongDestination = join(scope.releasesRoot, 'not-a-stage');
  await expect(stageVerifiedEmittedRuntime(checked, { staging: port, destination: wrongDestination })).rejects.toThrow();
  await expect(lstat(wrongDestination)).rejects.toMatchObject({ code: 'ENOENT' });
  await chmod(scope.releasesRoot, 0o777);
  try { await expect(publishStagedDeployment(checked, stage)).rejects.toThrow(); }
  finally { await chmod(scope.releasesRoot, 0o755); }
  hooks.before = async () => {
    await rename(scope.releasesRoot, scope.releasesRoot + '-old');
    await mkdir(scope.releasesRoot);
  };
  await expect(publishStagedDeployment(checked, stage)).rejects.toThrow(/identity/);
  delete hooks.before;
  await rm(scope.releasesRoot, { recursive: true });
  await rename(scope.releasesRoot + '-old', scope.releasesRoot);
  const file = join(secondary, deploymentPaths.caddy);
  await cp(file, file + '.replacement');
  await rename(file + '.replacement', file);
  await expect(publishStagedDeployment(again, other)).rejects.toThrow(/identity/);
  await rename(archive, archive + '-signed');
  await cp(archive + '-signed', archive);
  await expect(publishStagedDeployment(checked, stage)).rejects.toThrow(/identity/);
  await unchanged();
  await expect(lstat(installed)).rejects.toMatchObject({ code: 'ENOENT' });
}, 120_000);

test('preserves a published slot and refuses replay after lost lease completion', async () => {
  const { stage, checked, port, stagingRoot, hooks, destination, installed, scope } = await promotionHost('promotion-uncertain');
  const otherPath = join(stagingRoot, 'second');
  const other = await stageVerifiedEmittedRuntime(checked, { staging: port, destination: otherPath });
  hooks.after = async () => {
    expect((await lstat(installed)).isDirectory()).toBe(true);
    throw new Error('fixture lost completion');
  };
  await expect(publishStagedDeployment(checked, stage)).rejects.toMatchObject({
    code: 'EMITTED_PUBLICATION_UNCERTAIN', path: installed, packageSha256: checked.packageSha256,
  });
  delete hooks.after;
  await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(publishStagedDeployment(checked, stage)).rejects.toThrow();
  await expect(publishStagedDeployment(checked, other)).rejects.toThrow(/occupied/);
  await expect(withStagedDeployment(checked, stage, async () => true)).rejects.toThrow();
  await expect(withPublishedDeployment(checked, scope, async release => release.root)).resolves.toBe(installed);
  expect((await lstat(otherPath)).isDirectory()).toBe(true);
}, 120_000);

test('reports a post-rename physical substitution during publication readback as uncertain', async () => {
  const { checked, stage, destination, installed, scope } = await promotionHost('promotion-substitution');
  const copy = join(dirname(scope.releasesRoot), 'replacement');
  const original = join(destination, deploymentPaths.caddy);
  const target = join(installed, deploymentPaths.caddy);
  await cp(original, copy);
  const replacement = await lstat(copy, { bigint: true });
  // Deliberately violate fixture ownership during readback. A same-byte
  // substitution must fail the stage identity check even when all digests match.
  let exchange: Promise<void> | undefined;
  const watcher = watch(scope.releasesRoot, (_event, name) => {
    if (name === checked.packageSha256 && !exchange) {
      exchange = rename(copy, target);
      exchange.catch(() => {});
    }
  });
  try {
    await expect(publishStagedDeployment(checked, stage)).rejects.toMatchObject({ code: 'EMITTED_PUBLICATION_UNCERTAIN' });
    expect(exchange).toBeDefined();
    await exchange;
  } finally { watcher.close(); }
  expect((await lstat(target, { bigint: true })).ino).toBe(replacement.ino);
  await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(publishStagedDeployment(checked, stage)).rejects.toThrow();
  await expect(withPublishedDeployment(checked, scope, async release => release.root)).resolves.toBe(installed);
}, 120_000);

test('checks device identity and syncs both rename parents, preserving uncertainty on sync failure', async () => {
  const { scope, archive, stagingRoot, pins } = await promotionHost('promotion-durability');
  const verifier = pathToFileURL(join(root, 'deploy/lib/emitted-release.mjs')).href;
  const probe = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { dirname, join } from 'node:path';
    const [archive, stagingRoot, releasesRoot, pins, fault] = process.argv.slice(1);
    const owner = dirname(archive);
    const source = join(stagingRoot, fault);
    const storeId = fs.statSync(releasesRoot, { bigint: true }).ino;
    const sourceParentId = fs.statSync(stagingRoot, { bigint: true }).ino;
    const { lstatSync, renameSync, fsyncSync } = fs;
    let renamed = false;
    const synced = [];
    // Model a second device without mounting a host volume. All bytes, names,
    // descriptor syncs and the following same-volume rename are actual OS I/O.
    fs.lstatSync = function(path, options) {
      const info = lstatSync(path, options);
      if (fault === 'volume' && path === releasesRoot && options?.bigint) info.dev += 1n;
      return info;
    };
    fs.renameSync = function(from, to) {
      renameSync(from, to);
      renamed = true;
    };
    fs.fsyncSync = function(fd) {
      fsyncSync(fd);
      if (renamed) {
        const id = fs.fstatSync(fd, { bigint: true }).ino;
        synced.push(id);
        if (id === storeId) throw new Error('fixture lost store sync acknowledgement');
      }
    };
    syncBuiltinESMExports();
    const { verifyEmittedRuntimeCandidate, stageVerifiedEmittedRuntime, publishStagedDeployment } = await import(${JSON.stringify(verifier)});
    let held = false;
    const staging = { publication: { stagingRoot, releasesRoot }, async withExclusiveReadRoot(work) {
      assert(!held);
      held = true;
      try { return await work(owner); } finally { held = false; }
    } };
    const receipt = await verifyEmittedRuntimeCandidate(archive, { staging, ...JSON.parse(pins) });
    const token = await stageVerifiedEmittedRuntime(receipt, { staging, destination: source });
    const slot = join(releasesRoot, receipt.packageSha256);
    if (fault === 'volume') {
      await assert.rejects(publishStagedDeployment(receipt, token), /same-volume/);
      assert(!renamed && fs.existsSync(source) && !fs.existsSync(slot));
    } else {
      await assert.rejects(publishStagedDeployment(receipt, token), { code: 'EMITTED_PUBLICATION_UNCERTAIN' });
      assert(renamed && !fs.existsSync(source) && fs.existsSync(slot));
      assert.deepEqual(synced.sort(), [sourceParentId, storeId].sort());
      await assert.rejects(publishStagedDeployment(receipt, token), /claimed/);
    }
  `;
  for (const fault of ['volume', 'sync']) child(['--input-type=module', '-e', probe, archive, stagingRoot,
    scope.releasesRoot, JSON.stringify(pins), fault]);
}, 120_000);

test('refuses unbound published deployment receipts, locations and material before use', async () => {
  const { scope, installed, checked } = await publishFixture('published-controls');
  let calls = 0;
  const use = async () => ++calls;
  const open = (releasesRoot: string) => withPublishedDeployment(checked, { staging, releasesRoot }, use);
  await expect(withPublishedDeployment({ ...checked }, scope, use)).rejects.toThrow();
  await expect(withPublishedDeployment(await verify(), scope, use)).rejects.toThrow();
  await expect(withPublishedDeployment(checked, { ...scope, staging: { ...staging } }, use)).rejects.toThrow();
  for (const path of [dirname(temporary), temporary, scope.releasesRoot + '/.']) await expect(open(path)).rejects.toThrow();
  const alias = join(dir, 'store-alias');
  await symlink(scope.releasesRoot, alias);
  await expect(open(alias)).rejects.toThrow();
  await chmod(scope.releasesRoot, 0o777);
  try { await expect(open(scope.releasesRoot)).rejects.toThrow(); }
  finally { await chmod(scope.releasesRoot, 0o700); }

  const wrongSlot = join(scope.releasesRoot, 'another-generation');
  await rename(installed, wrongSlot);
  await expect(open(scope.releasesRoot)).rejects.toThrow();
  await symlink(wrongSlot, installed);
  await expect(open(scope.releasesRoot)).rejects.toThrow();
  await unlink(installed);
  const upperSlot = join(scope.releasesRoot, checked.packageSha256.toUpperCase());
  await rename(wrongSlot, upperSlot);
  await expect(open(scope.releasesRoot)).rejects.toThrow();
  await rename(upperSlot, installed);

  const template = join(installed, deploymentPaths.caddy);
  const original = await readFile(template);
  await chmod(template, 0o755);
  await expect(open(scope.releasesRoot)).rejects.toThrow();
  await chmod(template, 0o644);
  await writeFile(template, Buffer.alloc(original.length));
  await expect(open(scope.releasesRoot)).rejects.toThrow();
  await unlink(template);
  await expect(open(scope.releasesRoot)).rejects.toThrow();
  await writeFile(template, original, { mode: 0o644 });
  await writeFile(join(installed, 'unsigned'), 'extra bytes');
  await expect(open(scope.releasesRoot)).rejects.toThrow();
  expect(calls).toBe(0);
}, 120_000);

test('rechecks the published deployment and signed archive through callback settlement', async () => {
  const { scope, installed } = await publishFixture('published-change');
  const archive = join(dir, 'published-archive');
  await cp(complete.packagePath, archive);
  const checked = await verifyEmittedRuntimeCandidate(archive, { staging, expected: complete.expected, policy: complete.policy });
  let calls = 0;
  const use = (change: () => Promise<void>) => withPublishedDeployment(checked, scope, async () => { calls++; await change(); });
  const repaint = async (path: string) => {
    const copy = path + '.new';
    await cp(path, copy);
    await rename(copy, path);
  };
  await expect(use(() => repaint(join(installed, deploymentPaths.caddy)))).rejects.toThrow(/identity|changed/);
  await expect(use(async () => {
    const oldStore = scope.releasesRoot + '-old';
    await rename(scope.releasesRoot, oldStore);
    await mkdir(scope.releasesRoot);
    await rename(join(oldStore, checked.packageSha256), installed);
    throw Error('callback failure');
  })).rejects.toThrow(/identity|changed/);
  await expect(use(() => repaint(archive))).rejects.toThrow(/identity|changed/);
  await expect(use(async () => {})).rejects.toThrow(/identity|changed/);
  expect(calls).toBe(3);
}, 120_000);

test('refuses independently re-signed incomplete, aliased or substituted templates', async () => {
  const candidate = join(dir, 'variant');
  const fixture = { packagePath: complete.packagePath, expected: complete.expected, policy: complete.policy };
  const control = await signedVariant(candidate, false, undefined, fixture);
  expect((await verifyEmittedRuntimeCandidate(candidate, control)).profile).toBe('deployment-complete');
  const reasons = { omit: /missing deployment template/, extra: /deployment template alias/, alias: /missing deployment template/,
    duplicate: /duplicate or ambiguous/, role: /role\/mode mismatch/, mode: /deployment template profile\/mode\/content/,
    substitute: /deployment template profile\/mode\/content/, 'under-web': /deployment template alias/, version: /unsupported inventory/ };
  for (const variant of Object.keys(reasons) as (keyof typeof reasons)[]) {
    const options = await signedVariant(candidate, false, undefined, fixture, variant);
    await expect(verifyEmittedRuntimeCandidate(candidate, options)).rejects.toThrow(reasons[variant]);
  }
}, 120_000);

test('checks profile selection for build, capture, material inspection and independent readback', async () => {
  const build = join(root, 'scripts/build-runtime.mjs');
  const source = ['--source-root', root, '--source-commit', expected.source.commit];
  const snapshot = (profile: string) => JSON.parse(child([build, 'snapshot', '--profile', profile, ...source]));
  const v1 = snapshot('runtime-only');
  const v2 = snapshot('deployment-complete');
  expect(v2.files).toBe(v1.files + 5);
  expect(v2.snapshotSha256).toBe(complete.expected.source.snapshotSha256);
  expect(v2.snapshotSha256).not.toBe(v1.snapshotSha256);
  expect(JSON.parse(child([build, 'verify', '--profile', 'deployment-complete', '--artifact-root', complete.artifact])).profile).toBe('deployment-complete');
  for (const args of [
    ['verify', '--profile', 'runtime-only', '--artifact-root', complete.artifact],
    ['verify', '--profile', 'deployment-complete', '--artifact-root', artifact],
    ['snapshot', '--profile', 'unknown', ...source],
    ['build', ...source, '--profile', 'deployment-complete', '--source-snapshot', v1.snapshotSha256, '--output-root', join(dir,'wrong-output')],
  ]) expect(spawnSync(process.execPath, [build, ...args], { cwd: root, timeout: 30_000 }).status).toBe(1);
  await expect(lstat(join(dir, 'wrong-output'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(inspectEmittedRuntimeMaterial({ ...complete.input, profile: 'runtime-only' })).rejects.toThrow();
  await expect(inspectEmittedRuntimeMaterial({ ...input, profile: 'deployment-complete' })).rejects.toThrow();
  await expect(prepareEmittedRuntimeCandidate({ ...complete.input, expectedMaterialSha256: complete.material.materialSha256, evidence })).rejects.toThrow('execution material binding mismatch');
}, 60_000);
});

test('admits the real material and pins the exact package, manifest and runtime', async () => {
  receipt = await verify();
  expect(receipt.packageSha256).toBe(sha256(await readFile(packagePath)));
  expect(receipt.materialSha256).toBe(material.materialSha256);
  expect(Object.isFrozen(receipt.runtime.native)).toBe(true);
  const signatures = [signature(Buffer.from(prepared.signingManifestBase64, 'base64'))];
  const path = join(temporary, 'repeat.json');
  expect((await packEmittedRuntimeCandidate(prepared, { outputStaging: staging, outputPath: path, signatures })).packageSha256).toBe(receipt.packageSha256);
  await expect(packEmittedRuntimeCandidate(prepared, { outputStaging: staging, outputPath: path, signatures })).rejects.toThrow();
  await expect(packEmittedRuntimeCandidate({ ...prepared }, { outputStaging: staging, outputPath: path, signatures })).rejects.toThrow(/prepared/i);
}, 60_000);

test('requires independent expected identity and evidence policy', async () => {
  const wrong = '0'.repeat(64);
  for (const change of [{ version: '9.9.9' }, { source: { ...expected.source, kind: 'pinned-snapshot', commit: '0'.repeat(40) } },
    { activeSchema: 3 }, { runtime: { ...expected.runtime, modules: '999' } }, { target: { os: 'darwin', arch: 'bogus' } },
    ...['toolchainSha256', 'inventorySha256', 'materialSha256', 'packageSha256'].map(key => ({ [key]: wrong }))]) {
    await expect(verify(change)).rejects.toThrow();
  }
  for (const modified of [{ ...policy, keys: [] }, { ...policy, keys: [{ id: 'other', publicKey }] },
    { ...policy, executionReportSha256: wrong }, { ...policy, requiredScenarios: [] },
    { ...policy, requiredScenarios: [...policy.requiredScenarios, policy.requiredScenarios[0]] },
    { ...policy, requiredScenarios: policy.requiredScenarios.map(s => ({ ...s, evidenceSha256: wrong })) }]) {
    await expect(verify({}, modified)).rejects.toThrow();
  }
}, 60_000);

test('requires genuine receipts under the same port and rechecks all staged identities before effects', async () => {
  const destination = join(temporary, 'stage');
  const options = { staging, destination };
  const verified = await verify();
  for (const fake of [JSON.parse(JSON.stringify(verified)), { ...verified }, { installable: false }]) {
    await expect(stageVerifiedEmittedRuntime(fake, options)).rejects.toThrow();
  }
  await expect(stageVerifiedEmittedRuntime(verified, { ...options, staging: { ...staging } })).rejects.toThrow();
  const staged = await stageVerifiedEmittedRuntime(verified, options);
  let effects = 0;
  const use = async () => ++effects;
  await withStagedEmittedRuntime(verified, staged, async admitted => {
    expect(await readFile(admitted.entrypoints.cli)).toEqual(await readFile(join(artifact, 'runtime/cli.mjs')));
    expect(admitted.root).toBe(destination);
  });
  await withStagedEmittedRuntime(verified, staged, use);
  await expect(withStagedEmittedRuntime(await verify(), staged, use)).rejects.toThrow();
  await expect(withStagedEmittedRuntime(verified, { ...staged }, use)).rejects.toThrow();
  const foreign = await import(pathToFileURL(join(root, 'deploy/lib/emitted-release.mjs')).href + '?isolated-authority');
  await expect(foreign.withStagedEmittedRuntime(verified, staged, use)).rejects.toThrow();
  const path = join(destination, 'runtime/cli.mjs');
  await rename(path, path + '.old');
  await cp(path + '.old', path);
  await unlink(path + '.old');
  await expect(withStagedEmittedRuntime(verified, staged, use)).rejects.toThrow();
  expect(effects).toBe(1);
}, 60_000);

test('bounds disk input and rejects alternate inode links, modes, and unexpected directories', async () => {
  const path = join(artifact, 'runtime/cli.mjs');
  for (const kind of ['symlink', 'hardlink', 'fifo', 'empty', 'oversize', 'mode']) {
    const extra = join(artifact, 'extra');
    if (kind === 'symlink') await symlink(path, extra);
    if (kind === 'hardlink') await link(path, extra);
    if (kind === 'fifo') child([extra], temporary, '/usr/bin/mkfifo');
    if (kind === 'empty') await mkdir(extra);
    if (kind === 'oversize') { await writeFile(extra, ''); await truncate(extra, RELEASE_LIMITS.artifactBytes + 1); }
    if (kind === 'mode') await chmod(path, 0o755);
    try { await expect(inspectEmittedRuntimeMaterial(input)).rejects.toThrow(); }
    finally { if (kind === 'mode') await chmod(path, 0o644); else await rm(extra, { recursive: true }); }
  }
}, 60_000);

// This program runs only in an isolated ordinary-Node child, outside material inspection and admission.
const scenarioRunner = String.raw`
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rename } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire, registerHooks } from 'node:module';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
const [id, artifact, materialSha256, checkout] = process.argv.slice(2);
const dataRoot = await mkdtemp(join(process.cwd(), 'data-'));
const modules = {};
for (const name of ['composition', 'cli', 'service', 'worker']) {
  modules[name] = await import(pathToFileURL(join(artifact, 'runtime', name + '.mjs')));
}
const { openRuntimeDatabase, createRuntimeProvisioning } = modules.composition;
const require = createRequire(join(artifact, 'runtime/composition.mjs'));
const sqliteResolved = require.resolve('better-sqlite3');
assert.ok(sqliteResolved.startsWith(artifact + '/node_modules/'));
await assert.rejects(readFile(join(checkout, 'node_modules/better-sqlite3/package.json')), { code: 'ERR_ACCESS_DENIED' });
const inventory = JSON.parse(await readFile(join(artifact, 'metadata/runtime-materials.json')));
const sqlite = new (require('better-sqlite3'))(':memory:');
const sqliteVersion = sqlite.prepare('select sqlite_version() as v').get().v;
sqlite.close();
assert.equal(sqliteVersion, inventory.native.sqlite);
assert.equal(process.versions.modules, inventory.observed.modules);
assert.equal(process.version, inventory.observed.node);
assert.equal(process.arch, inventory.observed.arch);
assert.equal(process.platform, inventory.observed.platform);
const digest = data => createHash('sha256').update(data).digest('hex');
const nativeSha256 = digest(await readFile(join(artifact, inventory.native.path)));
assert.equal(nativeSha256, inventory.native.sha256);
const outcome = {};
if (id === 'relocated-node-import') {
  for (const [name, fn] of Object.entries({ composition: 'createRuntimeProvisioning', cli: 'createInstalledCli', service: 'runInstalledService', worker: 'runInstalledWorker' })) assert.equal(typeof modules[name][fn], 'function');
  outcome.entries = Object.keys(modules);
} else if (id === 'sqlite-migrate-reopen') {
  const file = join(dataRoot, 'main.sqlite');
  const read = () => {
    const db = openRuntimeDatabase(file);
    const count = db.prepare('select count(*) as n from schema_migrations').get().n;
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    db.close();
    return count;
  };
  outcome.migrations = read();
  assert.ok(outcome.migrations > 0);
  assert.equal(read(), outcome.migrations);
} else {
  const identity = { accountId: 'account-1', scopeId: 'scope-1', domains: ['personal'], deviceId: 'device-1', configRevision: '1' };
  const credentials = join(dataRoot, 'credentials');
  const recoveryRoot = join(dataRoot, 'recovery');
  await mkdir(credentials);
  await mkdir(recoveryRoot);
  const now = new Date().toISOString();
  let database;
  let admission;
  const service = { databasePath: join(dataRoot, 'service.sqlite'), credentialDirectory: credentials,
    recoveryRuntime: { attach(context) {
      database = context.database;
      admission = context.admission;
      database.prepare('INSERT OR IGNORE INTO recovery_domain_gates(data_domain,writer_epoch,status,activation_id,witness_revision,reason,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run('personal', 'epoch', 'open', 'activation', 'witness', 'fixture', now);
      context.admission.admit({ domain: 'personal', writerEpoch: 'epoch', activationId: 'activation', witnessRevision: 'witness' });
    } },
    bindRecoveryOperations() { return { root: recoveryRoot, authority, targets: {} }; },
  };
  const authority = { keyId: 'fixture', async sign() { throw Error('unused'); }, async verify() { return false; } };
  const registration = { identity, captureHost: hostname(), serviceUid: process.geteuid(), profile: 'test', dataRoot,
    minimumFreeBytes: 0, origin: 'http://localhost', rpId: 'localhost', listener: { host: '127.0.0.1', port: 0, origin: 'http://localhost' } };
  if (id === 'service-cli-drain') {
    const token = createRuntimeProvisioning({ registration, service, hostCapabilities: {
      recovery: { root: recoveryRoot, authority, targets: { backup: { identity } } } } });
    outcome.preview = (await modules.cli.createInstalledCli(token).run(['backup', '--preview', '--target', 'backup'])).code;
    assert.equal(outcome.preview, 'RECOVERY_PREVIEW');
    const runtime = modules.service.createInstalledService(token);
    const listener = await modules.service.startServiceListener(runtime, token);
    const home = await fetch(listener.url + '/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /<title>PAtrick/);
    const challenge = async (ticket) => {
      const response = await fetch(listener.url + '/api/v1/auth/challenge', {
        method: 'POST',
        headers: { origin: registration.origin, 'content-type': 'application/json', 'x-patrick-bootstrap': ticket },
        body: JSON.stringify({ rp_id: registration.rpId }),
      });
      return { status: response.status, body: await response.json() };
    };
    const first = listener.issueOwnerBootstrap();
    assert.ok(Date.parse(first.expires_at) > Date.now());
    const pending = await challenge(first.ticket);
    assert.equal(pending.status, 200);
    assert.equal(pending.body.challenge.user.name, identity.accountId);
    const second = listener.issueOwnerBootstrap();
    const third = listener.issueOwnerBootstrap();
    assert.notEqual(third.ticket, second.ticket);
    assert.equal((await challenge(second.ticket)).status, 403);
    assert.notEqual(database.prepare('SELECT consumed_at FROM auth_challenges WHERE challenge_id = ?')
      .get(pending.body.challenge_id).consumed_at, null);
    assert.deepEqual(database.prepare('SELECT account_id, ticket_hash FROM bootstrap_tickets WHERE consumed_at IS NULL').all(),
      [{ account_id: identity.accountId, ticket_hash: digest(third.ticket) }]);
    admission.revoke('personal');
    assert.throws(() => listener.issueOwnerBootstrap(), /RECOVERY_WRITE_BLOCKED/);
    assert.equal((await challenge(third.ticket)).status, 409);
    admission.admit({ domain: 'personal', writerEpoch: 'epoch', activationId: 'activation', witnessRevision: 'witness' });
    database.prepare('INSERT INTO passkey_credentials VALUES (?,?,?,?,?)')
      .run('registered', identity.accountId, Buffer.from('fixture'), 0, now);
    assert.throws(() => listener.issueOwnerBootstrap(), /OWNER_PASSKEY_ALREADY_REGISTERED/);
    assert.equal((await challenge(third.ticket)).body.params.reason, 'owner_passkey_already_registered');
    database.prepare('DELETE FROM passkey_credentials WHERE credential_id = ?').run('registered');
    const inactiveDatabase = service.databasePath + '.inactive';
    await rename(service.databasePath, inactiveDatabase);
    try {
      const inactive = await challenge(third.ticket);
      assert.equal(inactive.status, 409);
      assert.equal(inactive.body.params.reason, 'owner_bootstrap_unavailable');
    } finally {
      await rename(inactiveDatabase, service.databasePath);
    }
    outcome.drain = await listener.drain({ timeoutMs: 5000 });
    assert.equal(outcome.drain.listener, 'closed');
    assert.equal(outcome.drain.runtime.status, 'closed');
    assert.throws(() => listener.issueOwnerBootstrap(), /OWNER_BOOTSTRAP_UNAVAILABLE/);
  } else {
    assert.equal(id, 'worker-role-readback');
    const commit = '45aecbf578289cda72d1fc773dcad069bfe7778b';
    const events = [];
    const hub = createServer(async (req, res) => {
      if (req.url === '/healthz') return res.end(JSON.stringify({ ok: true, commit }));
      assert.equal(req.headers.authorization, 'Bearer fixture-source');
      if (req.url === '/v1/events' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        events.push(JSON.parse(body).type);
        return res.end(JSON.stringify({ event: 1, duplicate: false, routed: ['咨询'] }));
      }
      if (req.url === '/v1/events/1') return res.end(JSON.stringify({ event: 1, runs: [{ run: 1, rule: '咨询', state: 'queued' }] }));
      res.writeHead(404).end();
    });
    hub.listen(0, '127.0.0.1');
    await once(hub, 'listening');
    const token = createRuntimeProvisioning({ registration: { ...registration, operationalHub: { origin: 'http://127.0.0.1:' + hub.address().port, commit } },
      hostCapabilities: {}, service, worker: { keys: { owner: 'fixture-owner', worker: 'fixture-worker', source: 'fixture-source' } } });
    const runtime = modules.service.createInstalledService(token);
    const db = database;
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(identity.accountId, 1, 1, now);
    db.prepare('INSERT INTO caller_scopes VALUES (?,?,?,?,NULL)').run(identity.accountId, 'web', 'personal', 'owner');
    const secret = 'a'.repeat(48);
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)').run(digest(secret), identity.accountId, 'web', 1, new Date(Date.now()+60000).toISOString(), now, 'fixture');
    const payload = { parent_work_id: null, request_scope: { account_id: identity.accountId, caller_id: 'web', data_domain: 'personal', permission_epoch: 1 }, text: 'Finite candidate fixture' };
    const reply = await runtime.app.request('http://localhost/api/v1/consultations', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost', cookie: ['patrick_session', secret].join('=') },
      body: JSON.stringify({ client_request_id: 'fixture-dispatch', expected_revision: null, payload, payload_hash: digest(JSON.stringify(payload)) }) });
    assert.equal(reply.status, 202, await reply.text());
    const worker = await modules.worker.runInstalledWorker(token);
    const deadline = Date.now()+5000;
    do {
      outcome.outbox = db.prepare("SELECT result FROM outbox WHERE destination='autoloop'").get()?.result;
      if (outcome.outbox) break;
      await wait(15);
    } while (Date.now() < deadline);
    assert.equal(outcome.outbox, 'accepted');
    assert.deepEqual(events, ['consultation.requested']);
    outcome.events = events;
    assert.equal((await worker.drain({ timeoutMs: 5000 })).status, 'closed');
    assert.equal((await runtime.drain({ timeoutMs: 5000 })).status, 'closed');
    await new Promise(done => hub.close(done));
  }
}
console.log(JSON.stringify({ id, materialSha256, inventorySha256: digest(await readFile(join(artifact, 'metadata/runtime-materials.json'))),
  nativeSha256, os: process.platform, arch: process.arch, node: process.version, modules: process.versions.modules, sqliteVersion, sqliteResolved, outcome }));
`;

test('binds even a genuine port to its originally admitted physical root', async () => {
  const privateRoot = join(temporary, 'narrow-root');
  await mkdir(privateRoot, { mode: 0o700 });
  const path = join(privateRoot, 'candidate.json');
  await cp(packagePath, path);
  let currentRoot = privateRoot;
  const port: ExclusiveRuntimeStaging = { withExclusiveReadRoot: read => read(currentRoot) };
  const original = await verifyEmittedRuntimeCandidate(path, { staging: port, expected, policy });
  currentRoot = temporary;
  await expect(stageVerifiedEmittedRuntime(original, { staging: port, destination: join(temporary, 'wider-stage') })).rejects.toThrow(/root|lease/);
}, 60_000);

test('rejects incomplete, duplicate and substituted lease callbacks', async () => {
  const ports: ExclusiveRuntimeStaging[] = [
    { withExclusiveReadRoot: async <T>() => ({} as T) },
    { withExclusiveReadRoot: async <T>(read: (root: string) => Promise<T>) => { await read(temporary); return {} as T; } },
    { withExclusiveReadRoot: async read => { const first = await read(temporary); await read(temporary).catch(() => {}); return first; } },
    { withExclusiveReadRoot: async <T>(read: (root: string) => Promise<T>) => { void read(temporary).catch(() => {}); return {} as T; } },
  ];
  for (const port of ports) await expect(verifyEmittedRuntimeCandidate(packagePath, { staging: port, expected, policy })).rejects.toThrow(/lease|callback/);
}, 60_000);

test('denies signed structural changes and malformed encodings within finite size limits', async () => {
  const encoded = await readFile(packagePath);
  const path = join(temporary, 'malformed.json');
  async function reject(raw: Buffer, message: RegExp) {
    await writeFile(path, raw);
    await expect(verifyEmittedRuntimeCandidate(path, { staging, expected: { ...expected, packageSha256: sha256(raw) }, policy })).rejects.toThrow(message);
  }
  const valid = JSON.parse(encoded.toString('utf8'));
  type Row = { path: string; mode: string; bytes: number; sha256: string; role: string };
  for (const kind of ['empty', 'duplicate', 'altered', 'count', 'noncanonical', 'base64', 'hash', 'source', 'size', 'total', 'files', 'depth', 'path', 'traversal', 'prefix']) {
    const m = structuredClone(valid.manifest);
    const first: Row = m.artifacts[0];
    const envelope = { ...valid, manifest: m, files: [...valid.files], signatures: [...valid.signatures] };
    let pattern = /signature/;
    if (kind === 'empty') envelope.signatures = [];
    if (kind === 'duplicate') envelope.signatures.push(valid.signatures[0]);
    if (kind === 'count') envelope.signatures = Array(17).fill(valid.signatures[0]);
    if (kind === 'altered') envelope.signatures = [{ keyId: 'fixture', signature: Buffer.alloc(64).toString('base64') }];
    if (kind === 'noncanonical') { await reject(Buffer.concat([encoded, Buffer.from('\n')]), /noncanonical/); continue; }
    if (kind === 'base64') { envelope.files[0] = { ...valid.files[0], data: '*' + valid.files[0].data.slice(1) }; pattern = /base64/; }
    if (kind === 'hash') { first.sha256 = '0'.repeat(64); pattern = /hash/; }
    if (kind === 'source') { m.kind = 'source-candidate'; pattern = /manifest/; }
    if (kind === 'size') { first.bytes = RELEASE_LIMITS.artifactBytes + 1; pattern = /byte limit/; }
    if (kind === 'total') { m.artifacts.slice(0, 3).forEach((r: Row) => { r.bytes = RELEASE_LIMITS.artifactBytes; }); pattern = /byte limit/; }
    if (kind === 'files') { m.artifacts = Array(RELEASE_LIMITS.files + 1).fill(first); pattern = /count/; }
    if (kind === 'depth') { first.path = 'a/'.repeat(64) + 'b'; pattern = /path limit/; }
    if (kind === 'path') { first.path = 'a'.repeat(513); pattern = /path limit/; }
    if (kind === 'traversal') { first.path = '../outside'; pattern = /path/; }
    if (kind === 'prefix') {
      const r = m.artifacts.find((r: Row) => r.path.startsWith('web/assets/'));
      r.path = r.path.replace('web/assets/', 'web/Assets/');
      pattern = /directory spelling/;
    }
    if (!['empty','duplicate','altered','count'].includes(kind)) envelope.signatures = [signature(bytes(m))];
    await reject(bytes(envelope), pattern);
  }
  await writeFile(path, '');
  await truncate(path, RELEASE_LIMITS.packageBytes + 1);
  await expect(verifyEmittedRuntimeCandidate(path, { staging, expected, policy })).rejects.toThrow(/file byte limit/);
}, 90_000);

test('rejects missing runtime components and coordinated omissions with a repinned inventory', async () => {
  const inventoryPath = join(artifact, 'metadata/runtime-materials.json');
  const raw = await readFile(inventoryPath);
  const inventory = JSON.parse(raw.toString('utf8'));
  const names = ['runtime-entry','runtime-shared-chunk','storage-migration-manifest','storage-migration','web-entry','web-asset','runtime-package-code','runtime-package-metadata','native-addon'];
  for (const role of names) {
    const row = inventory.files.find((r: {role: string; path: string}) => r.role === role && (role !== 'web-asset' || r.path.endsWith('.js')));
    const file = join(artifact, row.path);
    const content = await readFile(file);
    const changed = bytes({ ...inventory, files: inventory.files.filter((r: { path: string }) => r.path !== row.path) });
    await unlink(file);
    await writeFile(inventoryPath, changed);
    try { await expect(inspectEmittedRuntimeMaterial({ ...input, expectedInventorySha256: sha256(changed) })).rejects.toThrow(/missing|graph|migration|empty runtime directory/i); }
    finally {
      await writeFile(file, content, { mode: parseInt(row.mode.slice(3),8) });
      await writeFile(inventoryPath, raw);
    }
  }
}, 60_000);

test('rejects a repinned native binary with the wrong physical architecture', async () => {
  const inventoryPath = join(artifact, 'metadata/runtime-materials.json');
  const raw = await readFile(inventoryPath);
  const inv = JSON.parse(raw.toString('utf8'));
  const path = join(artifact, inv.native.path);
  const original = await readFile(path);
  const changed = Buffer.from(original);
  changed.writeUInt32LE(0,4);
  const digest = sha256(changed);
  inv.native.sha256 = digest;
  inv.files.find((r: { path: string }) => r.path === inv.native.path).sha256 = digest;
  const encoded = bytes(inv);
  try {
    await writeFile(path, changed);
    await writeFile(inventoryPath, encoded);
    await expect(inspectEmittedRuntimeMaterial({ ...input, expectedInventorySha256: sha256(encoded) })).rejects.toThrow(/native binary/);
  } finally { await writeFile(path, original); await writeFile(inventoryPath, raw); }
}, 60_000);

test('checks report content after independent report hashing and distinguishes evidence from material identity', async () => {
  const changedPath = join(temporary, 'alternate-report.json');
  const original = JSON.parse(await readFile(evidence.report.path, 'utf8'));
  for (const kind of ['material', 'abi', 'failed', 'duplicate', 'log', 'metadata']) {
    const report = structuredClone(original);
    if (kind === 'material') report.materialSha256 = '0'.repeat(64);
    if (kind === 'abi') report.observed.modules = '1';
    if (kind === 'failed') report.scenarios[0].exitCode = 1;
    if (kind === 'duplicate') report.scenarios[0] = report.scenarios[1];
    if (kind === 'log') report.scenarios[0].evidenceSha256 = '0'.repeat(64);
    if (kind === 'metadata') report.scenarios.reverse();
    const raw = bytes(report);
    await writeFile(changedPath, raw);
    const alternate = { ...evidence, report: { path: changedPath, sha256: sha256(raw) } };
    const next = prepareEmittedRuntimeCandidate({ ...input, expectedMaterialSha256: material.materialSha256, evidence: alternate });
    if (kind === 'metadata') {
      const valid = await next;
      expect(valid.materialSha256).toBe(material.materialSha256);
      const packed = await packEmittedRuntimeCandidate(valid, { outputStaging: staging, outputPath: join(temporary,'alternate.json'), signatures: [signature(Buffer.from(valid.signingManifestBase64,'base64'))] });
      expect(packed.packageSha256).not.toBe(expected.packageSha256);
    } else await expect(next).rejects.toThrow(/execution|scenario/);
  }
  const different = { ...input, schema: { min: 1, max: 3 } };
  const actual = await inspectEmittedRuntimeMaterial(different);
  expect(actual.materialSha256).not.toBe(material.materialSha256);
  await expect(prepareEmittedRuntimeCandidate({ ...different, expectedMaterialSha256: actual.materialSha256, evidence })).rejects.toThrow(/execution material/);
}, 90_000);

test('rechecks package, stage and ancestry before and after trusted use', async () => {
  for (const kind of ['ancestor', 'mode', 'new-entry', 'bytes', 'during-use', 'package-inode']) {
    const parent = join(temporary, 'physical-' + kind);
    await mkdir(parent);
    const path = join(parent, 'candidate.json');
    await cp(packagePath, path);
    const verified = await verifyEmittedRuntimeCandidate(path, { staging, expected, policy });
    const dest = join(parent, 'runtime-root');
    const stage = await stageVerifiedEmittedRuntime(verified, { staging, destination: dest });
    const entry = join(dest, 'runtime/cli.mjs');
    if (kind === 'ancestor') {
      await rename(parent, parent + '-old');
      await mkdir(parent);
      await rename(join(parent + '-old', 'runtime-root'), dest);
      await rename(join(parent + '-old', 'candidate.json'), path);
    }
    if (kind === 'mode') await chmod(entry, 0o755);
    if (kind === 'new-entry') await mkdir(join(dest, 'unexpected'));
    if (kind === 'bytes') await writeFile(entry, 'changed');
    if (kind === 'package-inode') { await rename(path, path + '-old'); await cp(path + '-old', path); }
    let entered = 0;
    await expect(withStagedEmittedRuntime(verified, stage, async () => {
      entered++;
      if (kind === 'during-use') await chmod(entry, 0o755);
    })).rejects.toThrow();
    expect(entered).toBe(kind === 'during-use' ? 1 : 0);
  }
}, 90_000);

test('rejects signed evidence from another material and stale pinned transcripts after a fresh signature', async () => {
  const envelope = JSON.parse(await readFile(packagePath, 'utf8'));
  const path = join(temporary, 'stale-evidence.json');
  const name = 'evidence/runtime-execution.json';
  const payload = envelope.files.find((f: { path: string }) => f.path === name);
  const report = JSON.parse(Buffer.from(payload.data, 'base64').toString('utf8'));
  report.materialSha256 = '0'.repeat(64);
  const raw = bytes(report);
  payload.data = raw.toString('base64');
  Object.assign(envelope.manifest.artifacts.find((r: {path: string}) => r.path === name), { bytes: raw.length, sha256: sha256(raw) });
  envelope.signatures = [signature(bytes(envelope.manifest))];
  const encoded = bytes(envelope);
  await writeFile(path, encoded);
  await expect(verifyEmittedRuntimeCandidate(path, { staging, expected: { ...expected, packageSha256: sha256(encoded) },
    policy: { ...policy, executionReportSha256: sha256(raw) } })).rejects.toThrow(/execution material/);
}, 60_000);

test('rejects a genuine source receipt at the emitted stage gate', async () => {
  const source = join(temporary, 'source-fixture');
  const out = join(temporary, 'source-release.json');
  const evidenceDir = join(temporary, 'source-evidence');
  await mkdir(join(source,'deploy/lima'), {recursive:true});
  await mkdir(evidenceDir);
  await writeFile(join(source,'package.json'), JSON.stringify({name:'fixture',version:'1.2.3'}));
  await writeFile(join(source,'package-lock.json'), JSON.stringify({lockfileVersion:3,packages:{}}));
  await writeFile(join(source,'deploy/lima/executor.yaml'), 'arch: default\n');
  const git = (argv: string[]) => child(argv,source,'/usr/bin/git');
  git(['init','-q']); git(['add','.']); git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','source fixture']);
  const commit = git(['rev-parse','HEAD']).trim();
  const transcript = Buffer.from('fixture only');
  await writeFile(join(evidenceDir,'probe.log'),transcript);
  await writeFile(join(evidenceDir,'T25.json'),JSON.stringify({ task:'T25', versions:{ release:'1.2.3',commit,os:'darwin',arch:'arm64' },
    scenarios:[{id:'fixture',command:'fixture',exitCode:0,status:'passed',versions:{fixture:'1'},evidenceFile:'evidence/probe.log',evidenceSha256:sha256(transcript)}] }));
  child([join(root,'scripts/pack-release.mjs'),source,commit,'1.2.3','arm64','1','2',out,evidenceDir]);
  const candidate = JSON.parse(await readFile(out,'utf8'));
  candidate.signatures = [signature(bytes(candidate.manifest))];
  await writeFile(out,bytes(candidate));
  const sourceReceipt = await verifyRelease(out,{readRoot:temporary,expected:{version:'1.2.3',commit,os:'darwin',arch:'arm64',schema:1},
    policy:{ keys:[{id:'fixture',publicKey}],requiredEvidence:['T25']} });
  expect(sourceReceipt.installable).toBe(false);
  await expect(stageVerifiedEmittedRuntime(sourceReceipt as unknown as VerifiedEmittedRuntimeCandidate, { staging, destination: join(temporary,'wrong-kind') })).rejects.toThrow(/verified receipt/);
},60_000);

test('rejects executable provenance or evidence files before signing', async () => {
  await chmod(input.toolchain.path, 0o755);
  try { await expect(inspectEmittedRuntimeMaterial(input)).rejects.toThrow(/mode/); }
  finally { await chmod(input.toolchain.path, 0o644); }
  await chmod(evidence.report.path, 0o755);
  try { await expect(prepareEmittedRuntimeCandidate({ ...input, expectedMaterialSha256: material.materialSha256, evidence })).rejects.toThrow(/mode/); }
  finally { await chmod(evidence.report.path, 0o644); }
});

test('checks the fixed emitted wrapper imports and CSS asset references as data', async () => {
  const invPath = join(artifact, 'metadata/runtime-materials.json');
  const raw = await readFile(invPath);
  for (const kind of ['wrapper','css']) {
    const inv = JSON.parse(raw.toString('utf8'));
    const row = inv.files.find((r: { path:string }) => kind === 'wrapper' ? r.path === 'runtime/cli.mjs' : r.path.endsWith('.css'));
    const path = join(artifact, row.path);
    const original = await readFile(path);
    const altered = Buffer.concat([original,Buffer.from(kind === 'wrapper' ? '\nimport("./undeclared.mjs");\n' : '\n.fixture { background: url(/assets/absent.woff); }\n')]);
    row.bytes = altered.length;
    row.sha256 = sha256(altered);
    const changed = bytes(inv);
    try {
      await writeFile(path, altered);
      await writeFile(invPath, changed);
      await expect(inspectEmittedRuntimeMaterial({...input,expectedInventorySha256:sha256(changed)})).rejects.toThrow(kind === 'wrapper' ? /entry graph/ : /CSS asset/);
    } finally { await writeFile(path,original); await writeFile(invPath,raw); }
  }
},60_000);

test('reprepares the exact pinned inputs after physical relocation with the same detached signature', async () => {
  const moved = join(temporary, 'moved');
  await mkdir(moved, { mode: 0o700 });
  const port: ExclusiveRuntimeStaging = { withExclusiveReadRoot: read => staging.withExclusiveReadRoot(() => read(moved)) };
  const duplicate = async (path: string, name: string) => { const copy = join(moved,name); await cp(path,copy,{recursive:true}); return copy; };
  const relocated = { ...input, staging: port, artifactRoot: await duplicate(artifact,'tree'),
    lockPath: await duplicate(input.lockPath,'lock.json'), toolchain: { ...input.toolchain, path: await duplicate(input.toolchain.path,'tools.json') } };
  const data = { report: { ...evidence.report, path: await duplicate(evidence.report.path,'report.json') },
    logs: await Promise.all(evidence.logs.map(async r => ({ ...r, path: await duplicate(r.path,r.id + '.log') }))) };
  const next = await prepareEmittedRuntimeCandidate({...relocated,expectedMaterialSha256:material.materialSha256,evidence:data});
  const out = await packEmittedRuntimeCandidate(next,{ signatures:[signature(Buffer.from(prepared.signingManifestBase64,'base64'))],
    outputStaging:port,outputPath:join(moved,'packed.json') });
  expect(out.packageSha256).toBe(expected.packageSha256);
},60_000);

test('requires controlled directory permissions through the material and destination ancestry', async () => {
  const inner = join(artifact,'runtime');
  await chmod(inner,0o777);
  try { await expect(inspectEmittedRuntimeMaterial(input)).rejects.toThrow(/ownership|permissions/); }
  finally { await chmod(inner,0o755); }
  const writable = join(temporary,'shared-output');
  await mkdir(writable);
  await chmod(writable,0o777);
  await expect(stageVerifiedEmittedRuntime(await verify(),{staging,destination:join(writable,'stage')})).rejects.toThrow(/ownership|permissions/);
},60_000);

type MaterialRow = { path: string; role: string; mode: string; sha256: string; bytes: number };

// Independently frame a signed contract-test variant. Its new report and all four
// logs explicitly describe a synthetic fixture; they never reuse execution logs.
async function signedVariant(path: string, omitEntry: boolean, requestedNodes?: number,
  fixture = { packagePath, expected, policy }, variant?: 'omit' | 'extra' | 'alias' | 'duplicate' | 'role' | 'mode' | 'substitute' | 'under-web' | 'version') {
  const env = JSON.parse(await readFile(fixture.packagePath,'utf8'));
  const manifest = env.manifest;
  const original = manifest.identity;
  const payload = new Map<string, Buffer>(env.files.map((f: {path:string;data:string}) => [f.path, Buffer.from(f.data,'base64')]));
  const descriptors = new Map<string,MaterialRow>((manifest.artifacts as MaterialRow[]).map(r => [r.path,r]));
  const meta = 'metadata/runtime-materials.json';
  const tool = 'provenance/toolchain-observed.json';
  const reportPath = 'evidence/runtime-execution.json';
  const inv = JSON.parse(payload.get(meta)!.toString());
  const observed = JSON.parse(payload.get(tool)!.toString());
  function put(key: string, data: Buffer, role: string) {
    const row = {path:key,role,mode:'100644',bytes:data.length,sha256:sha256(data)};
    payload.set(key,data);
    descriptors.set(key,row);
    return row;
  }
  const runtime = new Map<string,MaterialRow>((original.materials as MaterialRow[]).map(r=>[r.path,r]));
  if (omitEntry) {
    for (const map of [runtime,payload,descriptors]) map.delete('runtime/cli.mjs');
  }
  if (variant) {
    const caddy = 'deploy/Caddyfile';
    const originalRow = runtime.get(caddy)!;
    if (variant === 'omit' || variant === 'alias') {
      for (const map of [runtime,payload,descriptors]) map.delete(caddy);
    }
    if (['alias', 'extra', 'under-web'].includes(variant)) {
      const path = variant === 'alias' ? 'deploy/caddyfile' : variant === 'extra' ? 'deploy/lima/second.yaml' : 'web/fonts/shadow.txt';
      runtime.set(path, put(path, await readFile(join(root, 'deploy/lima/executor.yaml')), variant === 'under-web' ? 'web-asset' : 'lima-executor-template'));
    }
    if (variant === 'role' || variant === 'mode') {
      const row = { ...originalRow, ...(variant === 'role' ? { role: 'lima-executor-template' } : { mode: '100755' }) };
      runtime.set(caddy, row);
      descriptors.set(caddy, row);
    }
    if (variant === 'substitute') runtime.set(caddy, put(caddy, Buffer.from('unregistered.example.test'), originalRow.role));
    if (variant === 'version') inv.schemaVersion = 3;
  }
  const nodes = new Set<string>(['.']);
  function count(key:string) {
    for (let p = key; !nodes.has(p); p = dirname(p)) nodes.add(p);
  }
  for (const key of runtime.keys()) count(key);
  for (let n=0; requestedNodes && nodes.size < requestedNodes; n++) {
    const remaining = requestedNodes - nodes.size;
    const prefix = remaining === 1 ? 'web/fonts/' : 'web/fonts/d' + n + '/';
    const key = prefix + 'f' + n + '.txt';
    runtime.set(key,put(key,Buffer.alloc(0),'web-asset'));
    count(key);
  }
  function sorted<T extends {path:string}>(rows: Iterable<T>) {
    return [...rows].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  inv.files = sorted(runtime.values()).filter(r=>r.path!==meta);
  if (variant === 'duplicate') inv.files = sorted([...inv.files, runtime.get('deploy/Caddyfile')!]);
  const inventory = put(meta,bytes(inv),'runtime-inventory');
  runtime.set(meta,inventory);
  observed.totals = {};
  for (const r of inv.files) {
    observed.totals[r.role] ??= {files:0,bytes:0};
    observed.totals[r.role].files++; observed.totals[r.role].bytes += r.bytes;
  }
  observed.runtimeFiles = inv.files.filter((r:MaterialRow)=>r.path.startsWith('runtime/'));
  for (const key of ['inventory','repeatInventory']) Object.assign(observed[key],{sha256:inventory.sha256,bytes:inventory.bytes});
  const toolchain = put(tool,bytes(observed),'toolchain-observation');
  const identity = {...original, materials:sorted(runtime.values()), inventorySha256:inventory.sha256, toolchainSha256:toolchain.sha256};
  const materialSha256 = sha256(bytes(identity));
  const report = JSON.parse(payload.get(reportPath)!.toString());
  Object.assign(report,{materialSha256,inventorySha256:inventory.sha256,toolchainSha256:toolchain.sha256});
  const requiredScenarios = [];
  for (const scenario of report.scenarios) {
    const log = put('evidence/logs/'+scenario.id+'.log',Buffer.from('Synthetic parser test only: '+scenario.id+' '+materialSha256),'execution-log');
    Object.assign(scenario,{argv:['synthetic-parser-fixture'],cwd:'/fixture',startedUtc:'2000-01-01T00:00:00.000Z',endedUtc:'2000-01-01T00:00:00.000Z',evidenceSha256:log.sha256});
    requiredScenarios.push({id:scenario.id,evidenceSha256:log.sha256});
  }
  const execution = put(reportPath,bytes(report),'execution-report');
  Object.assign(manifest,{identity,materialSha256,artifacts:sorted(descriptors.values())});
  env.files = manifest.artifacts.map((r:MaterialRow)=>({path:r.path,data:payload.get(r.path)!.toString('base64')}));
  env.signatures = [signature(bytes(manifest))];
  const raw = bytes(env);
  await writeFile(path,raw);
  return {nodes:nodes.size,expected:{...fixture.expected,materialSha256,inventorySha256:inventory.sha256,toolchainSha256:toolchain.sha256,packageSha256:sha256(raw)},
    policy:{...fixture.policy,executionReportSha256:execution.sha256,requiredScenarios},staging};
}

test('rejects an uncontrolled nested directory before enumerating its empty descendant', async () => {
  const extra = join(artifact,'unchecked');
  await mkdir(join(extra,'nested'),{recursive:true});
  await chmod(extra,0o777);
  try { await expect(inspectEmittedRuntimeMaterial(input)).rejects.toThrow(/directory ownership or permissions/); }
  finally { await rm(extra,{recursive:true}); }
});

test('reconciles the signed omission after refreshing the independent fixture identity and policy',async () => {
  const path = join(temporary,'signed-missing-cli');
  const control = await signedVariant(path,false);
  expect((await verifyEmittedRuntimeCandidate(path,control)).materialSha256).toBe(control.expected.materialSha256);
  const pins = await signedVariant(path,true);
  await expect(verifyEmittedRuntimeCandidate(path,pins)).rejects.toThrow('missing runtime material runtime/cli.mjs');
},60_000);

test('preflights unique staged nodes before receipt or destination creation',async () => {
  const path = join(temporary,'node-boundary');
  const parent = join(temporary,'node-boundary-parent');
  await mkdir(parent);
  const max = RELEASE_LIMITS.evidenceEntries;
  const atLimit = await signedVariant(path,false,max);
  expect(atLimit.nodes).toBe(max);
  expect((await verifyEmittedRuntimeCandidate(path,atLimit)).packageSha256).toBe(atLimit.expected.packageSha256);
  const over = await signedVariant(path,false,max+1);
  expect(over.nodes).toBe(max+1);
  const before = await lstat(parent,{bigint:true});
  const admitted = await verifyEmittedRuntimeCandidate(path,over).catch((error: Error) => error);
  if (!(admitted instanceof Error)) {
    await stageVerifiedEmittedRuntime(admitted,{staging,destination:join(parent,'destination')}).catch(() => {});
  }
  expect((await lstat(parent,{bigint:true})).ctimeNs,'over-limit admission created a destination').toBe(before.ctimeNs);
  expect(admitted).toBeInstanceOf(Error);
  expect((admitted as Error).message).toMatch(/runtime tree entry limit/);
},120_000);

for (const operation of ['pack','stage'] as const) {
  test('recovers '+operation+' output after an external post-callback lease failure',async () => {
    const ownerRoot = join(temporary,'failed-lease-'+operation);
    await mkdir(ownerRoot,{mode:0o700});
    const candidate = join(ownerRoot,'candidate');
    await cp(packagePath,candidate);
    const output = join(ownerRoot,'output');
    let after: ((value: unknown) => Promise<unknown>) | undefined;
    let denied = false;
    let duplicate = false;
    let alternateRoot = '';
    const port: ExclusiveRuntimeStaging = {async withExclusiveReadRoot<T>(read:(root:string)=>Promise<T>) {
      if (denied) throw new Error('fixture lease unavailable');
      return staging.withExclusiveReadRoot(async () => {
        const value = await read(alternateRoot || ownerRoot);
        if (duplicate) { duplicate = false; await read(ownerRoot).catch(() => {}); }
        const action = after;
        after = undefined;
        return action ? await action(value) as T : value;
      });
    }};
    const verified = await verifyEmittedRuntimeCandidate(candidate,{staging:port,expected,policy});
    const signatures = [signature(Buffer.from(prepared.signingManifestBase64,'base64'))];
    const write = () => operation==='pack'
      ? packEmittedRuntimeCandidate(prepared,{signatures,outputPath:output,outputStaging:port})
      : stageVerifiedEmittedRuntime(verified,{staging:port,destination:output});
    async function failure() {
      try { await write(); } catch(error) {return error;}
      throw new Error('expected lease failure');
    }
    for (const mode of ['reject','substitute','duplicate','empty-rejection']) {
      if (mode==='duplicate') duplicate = true;
      else after = async () => {
        if (mode==='reject') throw new Error('release failed');
        if (mode==='empty-rejection') return Promise.reject();
        return {};
      };
      const error = await failure();
      expect(error).toMatchObject({code:'EMITTED_WRITE_ROLLED_BACK'});
      await expect(lstat(output)).rejects.toMatchObject({code:'ENOENT'});
      await write();
      await expect(write()).rejects.toMatchObject({code:'EEXIST'});
      expect((await lstat(output)).isDirectory()).toBe(operation==='stage');
      await rm(output,{recursive:true});
    }
    after = async () => { denied=true; throw new Error('lost lease'); };
    const unknown = await failure();
    expect(unknown).toMatchObject({code:'EMITTED_WRITE_UNCERTAIN'});
    expect(await readEmittedWriteOutcome(unknown)).toMatchObject({state:'unavailable',operation,path:output,packageSha256:expected.packageSha256});
    denied=false;
    alternateRoot=join(temporary,'alternate-root-'+operation);
    await mkdir(alternateRoot,{mode:0o700});
    expect(await readEmittedWriteOutcome(unknown)).toMatchObject({state:'unavailable'});
    alternateRoot='';
    expect(await readEmittedWriteOutcome(unknown)).toMatchObject({state:'owned'});
    expect((await lstat(output)).isDirectory()).toBe(operation==='stage');
    await rm(output,{recursive:true});
    expect(await readEmittedWriteOutcome(unknown)).toMatchObject({state:'absent'});
    const savedRoot = ownerRoot+'-original';
    after = async () => {
      await rename(ownerRoot,savedRoot);
      await mkdir(ownerRoot,{mode:0o700});
      await rename(join(savedRoot,'output'),output);
      throw new Error('same output inode under an exchanged lease root');
    };
    const wrongRoot = await failure();
    expect(wrongRoot).toMatchObject({code:'EMITTED_WRITE_UNCERTAIN'});
    expect(await readEmittedWriteOutcome(wrongRoot)).toMatchObject({state:'unavailable'});
    await rename(output,join(savedRoot,'output'));
    await rm(ownerRoot,{recursive:true});
    await rename(savedRoot,ownerRoot);
    expect(['owned','changed']).toContain((await readEmittedWriteOutcome(wrongRoot)).state);
    await rm(output,{recursive:true});
    after = async () => {
      await rename(output,output+'.original');
      await writeFile(output,'replacement');
      throw new Error('exchanged after lease callback');
    };
    const exchanged = await failure();
    expect(exchanged).toMatchObject({code:'EMITTED_WRITE_UNCERTAIN'});
    expect(await readEmittedWriteOutcome(exchanged)).toMatchObject({state:'changed'});
    expect(await readFile(output,'utf8')).toBe('replacement');
    expect((await lstat(output+'.original')).isDirectory()).toBe(operation==='stage');
    await expect(readEmittedWriteOutcome({...exchanged as object})).rejects.toThrow(/genuine/);
  },90_000);
}

});

// Portable format/authority fixture. None of the material or scenario labels
// here represent execution. Only the native suite above measures target behavior.
async function offlineSignedFixture(dir: string, arch: 'arm64' | 'x64', profile?: 'deployment-complete') {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const port: ExclusiveRuntimeStaging = {withExclusiveReadRoot: work => work(dir)};
  const tree = join(dir,'tree');
  const files: Array<{path:string;role:string;mode:string;bytes:number;sha256:string}> = [];
  async function put(path:string, role:string, data:Buffer, mode=0o644) {
    await mkdir(dirname(join(tree,path)),{recursive:true,mode:0o700});
    await writeFile(join(tree,path),data,{mode});
    files.push({path,role,mode:'100'+mode.toString(8),bytes:data.length,sha256:sha256(data)});
  }
  const fixtureCode = Buffer.from('throw Error("offline fixture was executed");');
  const sourceLock = JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'));
  const packages = ['better-sqlite3','bindings','file-uri-to-path'].map(name=>({name,version:sourceLock.packages['node_modules/'+name].version as string}));
  for (const [index,{name,version}] of packages.entries()) {
    const prefix = 'node_modules/'+name+'/';
    await put(prefix+'package.json','runtime-package-metadata',bytes({name,version,main:['lib/index.js','./bindings.js','index.js'][index],
      dependencies:sourceLock.packages['node_modules/'+name].dependencies ?? {}}));
    await put(prefix+(name==='bindings'?'LICENSE.md':'LICENSE'),'runtime-package-license',Buffer.from('fixture only'));
  }
  const sqliteFiles = ['database','index','sqlite-error','util',...['aggregate','backup','function','inspect','pragma','serialize','table','transaction','wrappers'].map(name=>'methods/'+name)];
  for (const name of [...sqliteFiles.map(name=>'better-sqlite3/lib/'+name+'.js'),'bindings/bindings.js','file-uri-to-path/index.js']) {
    await put('node_modules/'+name,'runtime-package-code',fixtureCode);
  }
  for (const path of entries) await put(path,'runtime-entry',Buffer.from('import { fake } from "./chunk-TEST.mjs";'));
  await put('runtime/chunk-TEST.mjs','runtime-shared-chunk',fixtureCode);
  const sql = Buffer.from('select 1;');
  await put('migrations/0001_fixture.sql','storage-migration',sql);
  await put('migrations/manifest.json','storage-migration-manifest',bytes([{file:'0001_fixture.sql',sha256:sha256(sql)}]));
  await put('web/index.html','web-entry',Buffer.from('<script src="/assets/test.js"></script><link href="/assets/test.css">'));
  await put('web/assets/test.js','web-asset',fixtureCode);
  await put('web/assets/test.css','web-asset',Buffer.from('body{}'));
  if (profile) {
    for (const path of Object.values(deploymentPaths)) {
      await put(path, deploymentRole(path)!, await readFile(join(root, path)));
    }
  }
  const binary = Buffer.alloc(32);
  binary.writeUInt32LE(0xfeedfacf);
  binary.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007,4);
  const nativePath = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';
  await put(nativePath,'native-addon',binary,0o755);
  const lock = bytes(sourceLock), lockPath = join(dir,'lock.json');
  await writeFile(lockPath,lock);
  const source = {kind:profile ? 'commit' as const : 'pinned-snapshot' as const, commit:'1'.repeat(40),snapshotSha256:sha256(fixtureCode),lockSha256:sha256(lock)};
  const observed = {platform:'darwin',arch,node:'v1.0.0',modules:'1',npm:'1.0.0'};
  const tools = {esbuild:'0.28.2',vite:'7.3.8'};
  const native = {path:nativePath,sha256:sha256(binary),bytes:binary.length,format:'mach-o',architecture:arch,observedArchitecture:arch,
    observedNode:observed.node,observedModules:observed.modules,observedLoad:true,sqlite:'1.0.0'};
  files.sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0);
  const inventory = bytes({schemaVersion:profile ? 2 : 1,...(profile && { profile }),materialKind:'emitted-runtime-materials',source,tools,observed,packages,native,files});
  await mkdir(join(tree,'metadata'));
  await writeFile(join(tree,'metadata/runtime-materials.json'),inventory);
  const measure = {path:'/synthetic/tool',sha256:sha256(fixtureCode),bytes:fixtureCode.length};
  const inv = {path:'/synthetic/inventory',sha256:sha256(inventory),bytes:inventory.length};
  const totals: Record<string,{files:number;bytes:number}> = {};
  for (const row of files) { totals[row.role] ??= {files:0,bytes:0}; totals[row.role].files++; totals[row.role].bytes+=row.bytes; }
  const toolchain = bytes({source,observed,packages,inventory:inv,repeatInventory:inv,node:measure,npm:{...measure,version:observed.npm},
    git:{path:'/synthetic/git',version:'git version 1.0'},esbuild:{...measure,version:tools.esbuild},esbuildBinary:measure,vite:{...measure,version:tools.vite},
    viteEsbuild:{...measure,version:sourceLock.packages['node_modules/esbuild'].version},viteRollup:{...measure,version:sourceLock.packages['node_modules/rollup'].version},
    totals,largestRecord:files.reduce((left,right)=>left.bytes>=right.bytes?left:right),native:{...native,fileMode:'755',binaryDescription:'synthetic Mach-O '+(arch === 'arm64' ? arch : 'x86_64')},
    packageFiles:files.filter(file=>file.path.startsWith('node_modules/')),runtimeFiles:files.filter(file=>file.path.startsWith('runtime/'))});
  const toolPath = join(dir,'tools.json');
  await writeFile(toolPath,toolchain);
  const input = {staging:port,artifactRoot:tree,version:sourceLock.version as string,target:{os:'darwin' as const,arch}, ...(profile && { profile }),
    schema:{min:1,max:1},expectedSource:source,expectedInventorySha256:inv.sha256,lockPath,toolchain:{path:toolPath,sha256:sha256(toolchain)}};
  const identity = await inspectEmittedRuntimeMaterial(input);
  const logs = await Promise.all(ids.map(async id=>{
    const path=join(dir,id+'.log'), data=Buffer.from('synthetic contract fixture only '+id);
    await writeFile(path,data);
    return {id,path,sha256:sha256(data)};
  }));
  const report = bytes({format:'patrick-emitted-runtime-execution-v1',materialSha256:identity.materialSha256,inventorySha256:inv.sha256,
    toolchainSha256:input.toolchain.sha256,nativeSha256:native.sha256,native,observed,entries,scenarios:logs.map(log=>({
      id:log.id,argv:['synthetic-format-fixture'],cwd:'/synthetic',startedUtc:'2000-01-01T00:00:00.000Z',endedUtc:'2000-01-01T00:00:00.000Z',
      exitCode:0,status:'passed',evidenceSha256:log.sha256}))});
  const reportPath = join(dir,'execution.json');
  await writeFile(reportPath,report);
  const ready = await prepareEmittedRuntimeCandidate({...input,expectedMaterialSha256:identity.materialSha256,evidence:{report:{path:reportPath,sha256:sha256(report)},logs}});
  const path = join(dir,'signed');
  const signed = await packEmittedRuntimeCandidate(ready,{signatures:[signature(Buffer.from(ready.signingManifestBase64,'base64'))],outputStaging:port,outputPath:path});
  const expected = {version:input.version,source,target:input.target,schema:input.schema,activeSchema:1,runtime:{node:observed.node,modules:observed.modules}, ...(profile && { profile }),
    inventorySha256:inv.sha256,toolchainSha256:input.toolchain.sha256,materialSha256:identity.materialSha256,packageSha256:signed.packageSha256};
  const policy = {keys:[{id:'fixture',publicKey}],executionReportSha256:sha256(report),requiredScenarios:logs.map(log=>({id:log.id,evidenceSha256:log.sha256}))};
  return { path, port, expected, policy };
}

runTest('verifies an offline signed format fixture and refuses copied capabilities',async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()),'emitted-offline-'));
  try {
    const { path, port, expected, policy } = await offlineSignedFixture(dir, 'arm64');
    const options = {staging:port,expected,policy};
    const verified = await verifyEmittedRuntimeCandidate(path,options);
    expect(verified.materialSha256).toBe(expected.materialSha256);
    await expect(verifyEmittedRuntimeCandidate(path,{...options,policy:{...policy,executionReportSha256:'0'.repeat(64)}})).rejects.toThrow(/report pin/);
    const destination = join(dir,'stage');
    await expect(stageVerifiedEmittedRuntime({...verified},{staging:port,destination})).rejects.toThrow(/genuine/);
    const env = JSON.parse(await readFile(path,'utf8'));
    env.signatures[0].signature = Buffer.alloc(64).toString('base64');
    const invalid = bytes(env);
    await writeFile(path,invalid);
    await expect(verifyEmittedRuntimeCandidate(path,{...options,expected:{...expected,packageSha256:sha256(invalid)}})).rejects.toThrow(/signature verification/);
  } finally {await rm(dir,{recursive:true,force:true});}
},30_000);

runTest('verifies both signed Darwin assets against independent release pins and reports success only for the pair', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'signed-darwin-assets-'));
  try {
    const arm64 = await offlineSignedFixture(join(dir, 'arm64'), 'arm64', 'deployment-complete');
    const x64 = await offlineSignedFixture(join(dir, 'x64'), 'x64', 'deployment-complete');
    const candidatePaths = [arm64.path, x64.path];
    const pins = {
      arm64: { expected: arm64.expected, policy: arm64.policy },
      x64: { expected: x64.expected, policy: x64.policy },
    };
    const pinFile = join(dir, 'trusted-pins.json');
    const assetScript = join(root, 'scripts/verify-signed-darwin-assets.mjs');
    async function verifyAssets(releasePins: unknown, paths = candidatePaths) {
      await writeFile(pinFile, JSON.stringify(releasePins));
      return spawnSync(process.execPath, [assetScript, pinFile, ...paths], { encoding: 'utf8', timeout: 10_000 });
    }
    function rejected(output: Awaited<ReturnType<typeof verifyAssets>>, message: string) {
      expect(output.status, output.stderr).toBe(1);
      expect(output.stdout).toBe('');
      expect(output.stderr).toContain(message);
    }

    const result = await verifyAssets(pins);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'verified-signed-darwin-assets', commit: arm64.expected.source.commit, version: arm64.expected.version,
      assets: {
        arm64: { packageSha256: arm64.expected.packageSha256, materialSha256: arm64.expected.materialSha256 },
        x64: { packageSha256: x64.expected.packageSha256, materialSha256: x64.expected.materialSha256 },
      },
    });
    rejected(await verifyAssets(pins, [x64.path, arm64.path]), 'finished package digest mismatch');
    rejected(await verifyAssets({ arm64: pins.arm64 }), 'exactly arm64 and x64');
    rejected(await verifyAssets({ ...pins, x64: { ...pins.x64, expected: arm64.expected } }), 'invalid x64 deployment pins');
    rejected(await verifyAssets({ ...pins, x64: { ...pins.x64,
      expected: { ...x64.expected, source: { ...x64.expected.source, commit: '2'.repeat(40) } },
    } }), 'one release');
    rejected(await verifyAssets({ ...pins, x64: { ...pins.x64,
      policy: { ...x64.policy, executionReportSha256: '0'.repeat(64) },
    } }), 'execution report pin mismatch');

    const original = await readFile(x64.path);
    const envelope = JSON.parse(original.toString());
    envelope.signatures[0].signature = Buffer.alloc(64).toString('base64');
    const tampered = bytes(envelope);
    const tamperedPath = join(dir, 'tampered.json');
    await writeFile(tamperedPath, tampered);
    rejected(await verifyAssets({ ...pins, x64: { ...pins.x64,
      expected: { ...x64.expected, packageSha256: sha256(tampered) },
    } }, [arm64.path, tamperedPath]), 'detached signature verification failed');
    expect(await readFile(x64.path)).toEqual(original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
