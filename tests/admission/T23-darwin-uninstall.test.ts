import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createDarwinUninstallController, uninstallPlanSha256 } from '../../deploy/host/uninstall.js';
import type { GenerationEnrollment } from '../../deploy/runtime/lifecycle-generation.js';
import type { LifecycleEvidenceSubject } from '../../deploy/runtime/lifecycle-journal.js';

const { invoke, withConfirmedGeneration, withStoppedGenerationWriters } = vi.hoisted(() => ({
  invoke: vi.fn(), withConfirmedGeneration: vi.fn(), withStoppedGenerationWriters: vi.fn(),
}));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawnSync: invoke,
}));
vi.mock('../../deploy/runtime/lifecycle-generation.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../deploy/runtime/lifecycle-generation.js')>(),
  withConfirmedGeneration, withStoppedGenerationWriters,
}));

const root = '/Library/LaunchDaemons';
const service = 'com.patrick.service';
const hub = 'com.patrick.autoloop-hub';
const supervisor = 'com.patrick.service-supervisor';
const journalIdentity = { installationId: 'demo-install', accountId: 'owner', scopeId: 'scope',
  deviceId: 'mac', configRevision: 'rev', domains: ['personal'] };
const node = { device: '1', inode: '1', birthtimeNs: '1' };
const generation: GenerationEnrollment = {
  installationId: journalIdentity.installationId, identity: journalIdentity,
  hostId: 'mac', target: { os: 'darwin', arch: 'arm64' }, root: '/fixture', rootNode: node,
  stores: { releases: node, packages: node, data: node, history: node },
  serviceRole: { controllerOwned: true, uid: 402, gid: 402, rootNode: node, writerNode: node },
  hubRole: { rootNode: node, lockNode: node, writerNode: node },
  publicKey: 'fixture', releases: [], generations: [],
};
const location = { path: root, device: 1, inode: 1 };
const enrollment = {
  launchDaemons: location,
  jobs: [supervisor, service, hub].map((label, index) => ({ label, device: 1, inode: index + 2, sha256: 'a'.repeat(64) })),
};
const subject: LifecycleEvidenceSubject = {
  claimSha256: 'b'.repeat(64),
  binding: {
    protocol: 'patrick-installed-lifecycle-v1', operationId: 'remove', root: { ...location, path: '/journal' },
    identity: journalIdentity, journalKeyId: 'test', evidenceVersion: 'test',
    plan: { command: 'uninstall', targetId: generation.installationId, expectedGeneration: 'first',
      nextGeneration: null, releaseSha256: null,
      planSha256: uninstallPlanSha256(journalIdentity, 'first', location, enrollment.jobs) },
  },
};

function controller() {
  return createDarwinUninstallController(enrollment, generation, undefined, vi.fn());
}

function jobs(paths: Record<string, string> = {}) {
  const present = new Set([service, hub, supervisor]);
  const writes: string[] = [];
  invoke.mockImplementation((program, [action, target]) => {
    expect(program).toBe('/bin/launchctl');
    const label = target.replace(/^system\//, '');
    if (action === 'bootout') {
      writes.push(label);
      present.delete(label);
      return { status: 0, stdout: '', stderr: '', signal: null };
    }
    expect(action).toBe('print');
    return present.has(label)
      ? { status: 0, stdout: `${target} = {\n\tpath = ${paths[label] ?? `${root}/${label}.plist`}\n\ttype = LaunchDaemon\n}\n`,
        stderr: '', signal: null }
      : { status: 113, stdout: '', stderr: `Bad request.\nCould not find service "${label}" in domain for system\n`, signal: null };
  });
  return { present, writes };
}

beforeEach(() => {
  vi.stubGlobal('process', Object.create(process, {
    platform: { value: 'darwin' }, getuid: { value: () => 0 }, geteuid: { value: () => 0 },
  }));
  withConfirmedGeneration.mockImplementation(async (_generation, _owner, use) =>
    use({ order: { generation: { id: 'first' } } }, undefined, () => {}));
  withStoppedGenerationWriters.mockImplementation(async (_generation, use) => use(() => {}));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

test('Darwin unloads registered jobs in dependency order and holds both writer fences during removal', async () => {
  const { present, writes } = jobs();
  let fenced = false;
  withStoppedGenerationWriters.mockImplementation(async (_generation, use) => {
    fenced = true;
    try { return await use(() => {}); } finally { fenced = false; }
  });
  const native = controller();
  const check = vi.fn(async () => {});
  await native.withStoppedWriters(async () => {
    expect(fenced).toBe(true);
    expect(present.size).toBe(0);
    await expect(native.absent(service)).resolves.toBe(true);
  }, check, subject);
  expect(writes).toEqual([service, hub, supervisor]);
  expect(check).toHaveBeenCalled();
});

test('Darwin refuses a loaded job whose registered label points at a different plist before unloading anything', async () => {
  const { writes } = jobs({ [hub]: '/Library/LaunchDaemons/com.other.plist' });
  await expect(controller().withStoppedWriters(async () => {}, async () => {}, subject)).rejects.toThrow('UNINSTALL_ADMISSION_FAILED');
  expect(writes).toEqual([]);
  expect(withStoppedGenerationWriters).not.toHaveBeenCalled();
});

test('Darwin refuses to stop when the selected generation differs from the operation', async () => {
  const { writes } = jobs();
  withConfirmedGeneration.mockImplementation(async (_generation, _owner, use) =>
    use({ order: { generation: { id: 'next' } } }, undefined, () => {}));
  await expect(controller().withStoppedWriters(async () => {}, async () => {}, subject)).rejects.toThrow('UNINSTALL_ADMISSION_FAILED');
  expect(writes).toEqual([]);
});

test('Darwin refuses to inspect or stop jobs for a different signed install inventory', async () => {
  const foreign = structuredClone(subject);
  foreign.binding.plan.planSha256 = 'c'.repeat(64);
  await expect(controller().withStoppedWriters(async () => {}, async () => {}, foreign)).rejects.toThrow('UNINSTALL_ADMISSION_FAILED');
  expect(invoke).not.toHaveBeenCalled();
});
