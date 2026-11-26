import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createFirstInstallCli } from '../../deploy/runtime/composition.js';
import { createUninstallRemovalEvidence, uninstallPlanSha256, type UninstallEnrollment } from '../../deploy/host/uninstall.js';
import { digest } from '../../packages/host/src/recovery/files.js';

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'patrick-uninstall-'));
  temporary.push(root);
  const launchDaemons = join(root, 'LaunchDaemons');
  const dataRoot = join(root, 'data');
  const journalRoot = join(root, 'journal');
  await Promise.all([launchDaemons, dataRoot, journalRoot].map(path => mkdir(path, { mode: 0o700 })));
  const afterStop = join(launchDaemons, 'com.patrick.service.plist');
  const unrelated = join(launchDaemons, 'unrelated.plist');
  const retained = ['service.sqlite', 'vault-original.md', 'shared-credential'].map(name => join(dataRoot, name));
  const bytes = 'registered plist bytes';
  await Promise.all([writeFile(afterStop, bytes), writeFile(unrelated, 'unrelated'),
    ...retained.map(path => writeFile(path, 'retain these bytes'))]);
  const directory = async (path: string) => {
    const physical = await stat(path);
    return { path, device: physical.dev, inode: physical.ino };
  };
  const identity = { installationId: 'installed-one', accountId: 'owner', scopeId: 'scope',
    deviceId: 'mac', configRevision: 'rev', domains: ['personal'] };
  const location = await directory(launchDaemons);
  const job = await directory(afterStop);
  const jobs = [{ label: 'com.patrick.service', sha256: digest(bytes), device: job.device, inode: job.inode }];
  const key = generateKeyPairSync('ed25519');
  const authority = { keyId: 'journal', async verify(bytes: Uint8Array, signature: string, keyId: string) {
    return keyId === 'journal' && verify(null, bytes, key.publicKey, Buffer.from(signature, 'base64'));
  } };
  const signer = { sign: vi.fn(async (bytes: Uint8Array) => sign(null, bytes, key.privateKey).toString('base64')) };
  const evidenceRoot = await directory(journalRoot);
  const removal = createUninstallRemovalEvidence(evidenceRoot);
  const withStoppedWriters = vi.fn(async (use: () => Promise<void>) => { await use(); });
  const absent = vi.fn(async () => true);
  const recordRemoved = vi.fn(removal.recordRemoved);
  const enrollment: UninstallEnrollment = {
    operationId: 'remove-one', launchDaemons: location, jobs, signer,
    controller: { withStoppedWriters, absent, recordRemoved },
    journal: { root: evidenceRoot, identity, authority,
      plan: { command: 'uninstall', targetId: identity.installationId, expectedGeneration: 'generation-one',
        nextGeneration: null, releaseSha256: null, planSha256: uninstallPlanSha256(identity, 'generation-one', location, jobs) },
      evidence: removal.evidence,
    },
  };
  const cli = () => createFirstInstallCli({ identity, captureHost: hostname(), serviceUid: process.geteuid!(),
    profile: 'test', dataRoot, minimumFreeBytes: 0, uninstallOperations: { [enrollment.operationId]: enrollment } });
  const run = (action: 'preview' | 'execute' | 'readback', operationId = enrollment.operationId) =>
    cli().run(['uninstall', '--' + action, '--operation', operationId]);
  return { run, enrollment, afterStop, unrelated, retained, withStoppedWriters, absent, recordRemoved, signer };
}

test('uninstall removes only the enrolled launchd entries under verified stop and replays its receipt', async () => {
  const fx = await fixture();
  await expect(fx.run('preview')).resolves.toMatchObject({ code: 'UNINSTALL_PREVIEW', status: 'preview' });
  expect(fx.withStoppedWriters).not.toHaveBeenCalled();
  const completed = await fx.run('execute');
  expect(completed).toMatchObject({ code: 'UNINSTALL_COMPLETED', status: 'completed' });
  await expect(stat(fx.afterStop)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(fx.unrelated, 'utf8')).resolves.toBe('unrelated');
  for (const path of fx.retained) await expect(readFile(path, 'utf8')).resolves.toBe('retain these bytes');
  await expect(fx.run('execute')).resolves.toMatchObject({ lifecycleReceipt: completed.lifecycleReceipt });
  await expect(fx.run('readback')).resolves.toMatchObject({ lifecycleReceipt: completed.lifecycleReceipt });
  expect(fx.withStoppedWriters).toHaveBeenCalledTimes(1);
  expect(fx.recordRemoved).toHaveBeenCalledTimes(1);
});

test('uninstall refuses a replacement plist before stopping any jobs', async () => {
  const fx = await fixture();
  await rm(fx.afterStop);
  await symlink(fx.retained[0], fx.afterStop);
  await expect(fx.run('execute')).resolves.toMatchObject({ code: 'UNINSTALL_ADMISSION_FAILED', status: 'blocked' });
  expect(fx.withStoppedWriters).not.toHaveBeenCalled();
  await expect(readFile(fx.retained[0], 'utf8')).resolves.toBe('retain these bytes');
});

test('uninstall keeps the registered file when a job is still present and does not repeat a claimed effect', async () => {
  const fx = await fixture();
  fx.absent.mockResolvedValue(false);
  await expect(fx.run('execute')).resolves.toMatchObject({ code: 'LIFECYCLE_OUTCOME_UNCERTAIN' });
  await expect(readFile(fx.afterStop, 'utf8')).resolves.toBe('registered plist bytes');
  await expect(fx.run('execute')).resolves.toMatchObject({ code: 'LIFECYCLE_OUTCOME_UNCERTAIN' });
  expect(fx.withStoppedWriters).toHaveBeenCalledTimes(1);
  expect(fx.recordRemoved).not.toHaveBeenCalled();
});

test('uninstall rejects changed file identity at the removal boundary even if the content matches', async () => {
  const fx = await fixture();
  fx.absent.mockImplementationOnce(async () => {
    await rename(fx.afterStop, fx.afterStop + '.previous');
    await writeFile(fx.afterStop, 'registered plist bytes');
    return true;
  });
  await expect(fx.run('execute')).resolves.toMatchObject({ code: 'LIFECYCLE_OUTCOME_UNCERTAIN' });
  await expect(readFile(fx.afterStop, 'utf8')).resolves.toBe('registered plist bytes');
  expect(fx.recordRemoved).not.toHaveBeenCalled();
});

test('uninstall never calls the controller for an operation ID outside enrollment', async () => {
  const fx = await fixture();
  await expect(fx.run('execute', 'another-operation')).resolves.toMatchObject({ code: 'UNINSTALL_RUNTIME_REQUIRED' });
  await expect(readFile(fx.afterStop, 'utf8')).resolves.toBe('registered plist bytes');
  expect(fx.withStoppedWriters).not.toHaveBeenCalled();
});

test('uninstall admits just one controller under concurrent execution', async () => {
  const fx = await fixture();
  const attempts = await Promise.all([fx.run('execute'), fx.run('execute')]);
  expect(attempts.map(attempt => attempt.status)).toContain('completed');
  expect(attempts.every(attempt => ['completed', 'uncertain'].includes(attempt.status))).toBe(true);
  await expect(fx.run('readback')).resolves.toMatchObject({ code: 'UNINSTALL_COMPLETED' });
  expect(fx.withStoppedWriters).toHaveBeenCalledTimes(1);
  expect(fx.recordRemoved).toHaveBeenCalledTimes(1);
});

test('uninstall preserves an uncertain claim if the removal receipt is lost', async () => {
  const fx = await fixture();
  fx.recordRemoved.mockRejectedValueOnce(new Error('receipt unavailable'));
  await expect(fx.run('execute')).resolves.toMatchObject({ code: 'LIFECYCLE_OUTCOME_UNCERTAIN' });
  await expect(stat(fx.afterStop)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fx.run('execute')).resolves.toMatchObject({ code: 'LIFECYCLE_OUTCOME_UNCERTAIN' });
  expect(fx.withStoppedWriters).toHaveBeenCalledTimes(1);
});

test('uninstall completes from the persisted proof after losing the terminal signature without stopping jobs again', async () => {
  const fx = await fixture();
  const writeEvidence = fx.recordRemoved.getMockImplementation()!;
  fx.recordRemoved.mockImplementationOnce(async (subject, evidenceId) => {
    await writeEvidence(subject, evidenceId);
    fx.signer.sign.mockRejectedValueOnce(new Error('terminal signature temporarily unavailable'));
  });
  await expect(fx.run('execute')).resolves.toMatchObject({ code: 'LIFECYCLE_OUTCOME_UNCERTAIN' });
  await expect(fx.run('readback')).resolves.toMatchObject({ code: 'LIFECYCLE_OUTCOME_UNCERTAIN' });
  await expect(fx.run('execute')).resolves.toMatchObject({ code: 'UNINSTALL_COMPLETED' });
  await expect(fx.run('readback')).resolves.toMatchObject({ code: 'UNINSTALL_COMPLETED' });
  expect(fx.withStoppedWriters).toHaveBeenCalledTimes(1);
  expect(fx.recordRemoved).toHaveBeenCalledTimes(1);
});
