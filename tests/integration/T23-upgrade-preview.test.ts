import { generateKeyPairSync } from 'node:crypto';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, vi } from 'vitest';
import { createInstalledCli } from '../../deploy/runtime/cli.js';
import { createRuntimeProvisioning } from '../../deploy/runtime/composition.js';
import type { GenerationEnrollment } from '../../deploy/runtime/lifecycle-generation.js';
import type { ExclusiveRuntimeStaging } from '../../deploy/lib/emitted-release.mjs';

function fixture() {
  const identity = { accountId: 'account', scopeId: 'scope', domains: ['personal'], deviceId: 'device', configRevision: '1' };
  const root = resolve('unused-upgrade-root');
  const dataRoot = join(root, 'data', 'selected');
  const rootNode = { device: '0', inode: '0', birthtimeNs: '0' };
  const origin = 'https://preview.example.test:8443';
  const packageSha256 = 'a'.repeat(64);
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const target = { os: 'darwin', arch: 'arm64' } as const;
  const policy = { keys: [{ id: 'release', publicKey }], executionReportSha256: 'b'.repeat(64), requiredScenarios: [] };
  const enrollment: GenerationEnrollment = {
    installationId: 'install', hostId: 'host', identity, target, root, rootNode, publicKey,
    stores: { data: rootNode, history: rootNode, packages: rootNode, releases: rootNode },
    generations: [],
    releases: [{
      expected: {
        packageSha256, schema: { min: 1, max: 2 }, activeSchema: 1, profile: 'deployment-complete', target,
        version: '1.0.0',
        source: { kind: 'commit', commit: 'c'.repeat(40), snapshotSha256: 'd'.repeat(64), lockSha256: 'e'.repeat(64) },
        runtime: { node: process.version, modules: process.versions.modules },
        toolchainSha256: 'f'.repeat(64), inventorySha256: '1'.repeat(64), materialSha256: '2'.repeat(64),
      },
      policy,
    }],
  };
  const acquire = vi.fn(async (): Promise<never> => { throw Error('unexpected lease acquisition'); });
  const owner: ExclusiveRuntimeStaging = { withExclusiveReadRoot: acquire };
  const input = {
    registration: { identity, captureHost: hostname(), serviceUid: process.geteuid!(), dataRoot, profile: 'test',
      minimumFreeBytes: 1, origin, rpId: 'preview.example.test',
      listener: { host: '127.0.0.1' as const, port: 8443, origin } },
    upgradePreview: { enrollment, owner, successorSchemas: { [packageSha256]: 2 } },
    service: { databasePath: join(dataRoot, 'service.sqlite'), credentialDirectory: join(dataRoot, 'credentials'),
      recoveryRuntime: { attach(): never { throw Error('unexpected database startup'); } },
      bindRecoveryOperations(): never { throw Error('unexpected recovery startup'); } },
  };
  return { input, owner, acquire, packageSha256, policy, root, args: ['upgrade', '--release', packageSha256] };
}

test('upgrade preview refuses a staging method accessor at provisioning without invoking it', () => {
  const { input, owner, acquire } = fixture();
  const getter = vi.fn(() => acquire);
  Object.defineProperty(owner, 'withExclusiveReadRoot', { get: getter });
  expect(() => createRuntimeProvisioning(input)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

test.each(['replacement', 'accessor'])('upgrade preview refuses a staging method %s installed after provisioning', async change => {
  const { input, owner, args, acquire } = fixture();
  const provisioning = createRuntimeProvisioning(input);
  const replacement = vi.fn(async (): Promise<never> => { throw Error('unexpected replacement'); });
  const getter = vi.fn(() => replacement);
  Object.defineProperty(owner, 'withExclusiveReadRoot', change === 'accessor' ? { get: getter } : { value: replacement });
  expect(await createInstalledCli(provisioning).run(args)).toMatchObject({ status: 'blocked' });
  expect(replacement).not.toHaveBeenCalled();
  expect(getter).not.toHaveBeenCalled();
  expect(acquire).not.toHaveBeenCalled();
});

test('upgrade preview requires an explicit successor schema pin', () => {
  const { input, acquire } = fixture();
  Reflect.deleteProperty(input.upgradePreview, 'successorSchemas');
  expect(() => createRuntimeProvisioning(input)).toThrow();
  expect(acquire).not.toHaveBeenCalled();
});

test.each([0, 3, 1.5, undefined])('upgrade preview rejects invalid or incompatible successor schema %s', (targetSchema) => {
  const { input, packageSha256, acquire } = fixture();
  Object.defineProperty(input.upgradePreview.successorSchemas, packageSha256, { value: targetSchema });
  expect(() => createRuntimeProvisioning(input)).toThrow();
  expect(acquire).not.toHaveBeenCalled();
});

test('upgrade preview does not select a historical release without explicit successor enrollment', async () => {
  const { input, args, acquire } = fixture();
  input.upgradePreview.successorSchemas = {};
  expect(await createInstalledCli(createRuntimeProvisioning(input)).run(args)).toMatchObject({
    status: 'unavailable', code: 'RELEASE_REGISTRATION_REQUIRED',
  });
  expect(acquire).not.toHaveBeenCalled();
});

test.each(['policy', 'key'] as const)('upgrade preview rejects a class-backed release %s at provisioning', field => {
  const { input, policy, acquire } = fixture();
  class ReleasePolicy {
    keys = policy.keys;
    executionReportSha256 = policy.executionReportSha256;
    requiredScenarios = policy.requiredScenarios;
  }
  class PolicyKey {
    id = policy.keys[0].id;
    publicKey = policy.keys[0].publicKey;
  }
  if (field === 'policy') input.upgradePreview.enrollment.releases[0].policy = new ReleasePolicy();
  else policy.keys[0] = new PolicyKey();
  expect(() => createRuntimeProvisioning(input)).toThrow('HOST_IDENTITY_MISMATCH');
  expect(acquire).not.toHaveBeenCalled();
});

test('upgrade preview rejects nested policy descriptor mutation after provisioning', async () => {
  const { input, policy, args, acquire } = fixture();
  const cli = createInstalledCli(createRuntimeProvisioning(input));
  Object.defineProperty(policy.keys[0], 'publicKey', { writable: false });
  expect(await cli.run(args)).toMatchObject({ status: 'blocked', code: 'HOST_IDENTITY_MISMATCH' });
  expect(acquire).not.toHaveBeenCalled();
});

test('upgrade preview rechecks the provisioned trust policy inside the lease callback', async () => {
  const { input, policy, args, owner, root } = fixture();
  const observed = vi.fn();
  owner.withExclusiveReadRoot = async read => {
    const pending = read(root);
    Object.defineProperty(policy.keys[0], 'publicKey', { writable: false });
    try { return await pending; } catch (error) { observed(error); throw error; }
  };
  expect(await createInstalledCli(createRuntimeProvisioning(input)).run(args)).toMatchObject({
    status: 'blocked', code: 'HOST_IDENTITY_MISMATCH',
  });
  expect(observed).toHaveBeenCalledWith(expect.objectContaining({ message: 'HOST_IDENTITY_MISMATCH' }));
});
