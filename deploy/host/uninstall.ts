import { spawnSync } from 'node:child_process';
import {
  closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync, type Stats,
} from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { bindRegistration, projectIdentity, sameIdentity, type HostIdentity } from '../lib/doctor.mjs';
import type { ExclusiveRuntimeStaging } from '../lib/emitted-release.mjs';
import { canonical, digest } from '../../packages/host/src/recovery/files.js';
import {
  createLifecycleJournal, createLifecycleJournalReader, type LifecycleEvidenceSubject,
  type LifecycleRegistration, type LifecycleRequest,
} from '../runtime/lifecycle-journal.js';
import { withConfirmedGeneration, withStoppedGenerationWriters, type GenerationEnrollment } from '../runtime/lifecycle-generation.js';

const stopOrder = [
  'com.patrick.caddy', 'com.patrick.autoloop-worker', 'com.patrick.service', 'com.patrick.autoloop-hub',
  'com.patrick.service-supervisor', 'com.patrick.autoloop-hub-supervisor',
];
const labels = new Set(stopOrder);
const systemLaunchDaemons = '/Library/LaunchDaemons';
const maxPlistBytes = 64 * 1024;
type FileIdentity = { device: number; inode: number };
type LaunchDirectory = FileIdentity & { path: string };
type LaunchJob = FileIdentity & { label: string; sha256: string };
type UninstallTarget = { launchDaemons: LaunchDirectory; jobs: readonly LaunchJob[] };

export type UninstallEnrollment = UninstallTarget & {
  operationId: string;
  journal: LifecycleRegistration;
  signer?: Parameters<typeof createLifecycleJournal>[1];
  controller?: {
    withStoppedWriters(use: (guard?: () => void) => Promise<void>, checkEnrollment: () => Promise<void>,
      subject: LifecycleEvidenceSubject): Promise<void>;
    absent(label: string): Promise<boolean>;
    recordRemoved(subject: LifecycleEvidenceSubject, evidenceId: string): Promise<void>;
  };
};

function requireUninstall(condition: unknown): asserts condition {
  if (!condition) throw new Error('UNINSTALL_ADMISSION_FAILED');
}

type UninstallController = NonNullable<UninstallEnrollment['controller']>;

function removalEvidenceId(operationId: string) {
  return 'uninstall-' + digest(operationId);
}

export function createUninstallRemovalEvidence(root: LifecycleRegistration['root']) {
  const binding = bindRegistration(() => root);
  const directory = binding.value;
  function openDirectory() {
    binding.validate();
    checkedDirectory(directory);
    const fd = openSync(directory.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      requireUninstall(owned(info, directory) && (info.mode & 0o077) === 0);
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  const version = 'uninstall-removal-v1';
  function fact(subject: LifecycleEvidenceSubject, id: string) {
    const { plan, root: registeredRoot, operationId, evidenceVersion } = subject.binding;
    requireUninstall(plan.command === 'uninstall' && evidenceVersion === version &&
      canonical(directory) === canonical(registeredRoot) && id === removalEvidenceId(operationId));
    return { path: join(directory.path, id + '.json'), expected: Buffer.from(canonical({ subject, id })) };
  }
  return {
    async recordRemoved(subject: LifecycleEvidenceSubject, id: string) {
      const { path, expected } = fact(subject, id);
      const dir = openDirectory();
      try {
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          writeFileSync(fd, expected);
          fsyncSync(fd);
        } finally { closeSync(fd); }
        fsyncSync(dir);
      } finally { closeSync(dir); }
    },
    evidence: { version, async observe(subject: LifecycleEvidenceSubject, id: string) {
      const { path, expected } = fact(subject, id);
      const dir = openDirectory();
      try {
        const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        try {
          const before = fstatSync(fd);
          requireUninstall(before.isFile() && before.nlink === 1 && before.uid === process.geteuid?.() &&
            (before.mode & 0o7777) === 0o600 && before.size === expected.length);
          const bytes = readBounded(fd, expected.length);
          const after = lstatSync(path);
          requireUninstall(expected.equals(bytes) && after.isFile() && after.dev === before.dev &&
            after.ino === before.ino && after.ctimeMs === before.ctimeMs);
          checkedDirectory(directory);
          return { evidenceId: id, claimSha256: subject.claimSha256, evidenceSha256: digest(bytes) };
        } finally { closeSync(fd); }
      } finally { closeSync(dir); }
    } },
  };
}

export function createDarwinUninstallEnrollment(
  enrollment: Omit<UninstallEnrollment, 'controller' | 'journal'> & { journal: Omit<LifecycleRegistration, 'evidence'> },
  generation: GenerationEnrollment, owner?: ExclusiveRuntimeStaging,
): UninstallEnrollment {
  const removal = createUninstallRemovalEvidence(enrollment.journal.root);
  return {
    ...enrollment, journal: { ...enrollment.journal, evidence: removal.evidence },
    controller: createDarwinUninstallController(enrollment, generation, owner, removal.recordRemoved),
  };
}

export function createDarwinUninstallController(
  registration: UninstallTarget,
  generation: GenerationEnrollment, owner: ExclusiveRuntimeStaging | undefined,
  recordRemoved: UninstallController['recordRemoved'],
): UninstallController {
  const configuration = { registration, generation };
  const binding = bindRegistration(() => configuration);
  const enrolled = binding.value.registration;
  const installed = binding.value.generation;
  function guard() {
    binding.validate();
    requireUninstall(process.platform === 'darwin' && process.getuid?.() === 0 && process.geteuid?.() === 0 &&
      enrolled.launchDaemons.path === systemLaunchDaemons);
  }
  const registered = new Set(enrolled.jobs.map(job => job.label));
  requireUninstall(installed.serviceRole?.controllerOwned === true && installed.hubRole &&
    registered.has('com.patrick.service') && registered.has('com.patrick.autoloop-hub') &&
    enrolled.jobs.every(job => labels.has(job.label)) && registered.size === enrolled.jobs.length);
  const selected = stopOrder.filter(label => registered.has(label));

  function launchctl(action: 'print' | 'bootout', label: string) {
    guard();
    requireUninstall(registered.has(label));
    const output = spawnSync('/bin/launchctl', [action, `system/${label}`], {
      encoding: 'utf8', env: { LC_ALL: 'C' }, timeout: 15_000, maxBuffer: 64 * 1024,
    });
    requireUninstall(!output.error && output.signal === null && output.status !== null);
    return output;
  }
  function stopped(label: string) {
    const observed = launchctl('print', label);
    if (observed.status === 113 && observed.stderr ===
      `Bad request.\nCould not find service "${label}" in domain for system\n`) return true;
    requireUninstall(observed.status === 0 && observed.stdout.startsWith(`system/${label} = {\n`) &&
      observed.stdout.split('\n').includes(`\tpath = ${systemLaunchDaemons}/${label}.plist`) &&
      observed.stdout.split('\n').includes('\ttype = LaunchDaemon'));
    return false;
  }
  return {
    async withStoppedWriters(use, checkEnrollment, subject) {
      guard();
      const { identity, plan } = subject.binding;
      requireUninstall(plan.command === 'uninstall' && plan.targetId === installed.installationId &&
        identity.installationId === installed.installationId && sameIdentity(identity, installed.identity) &&
        typeof plan.expectedGeneration === 'string' &&
        plan.planSha256 === uninstallPlanSha256(identity, plan.expectedGeneration, enrolled.launchDaemons, enrolled.jobs));
      await withConfirmedGeneration(installed, owner, async (current, _deployment, checkGeneration) => {
        requireUninstall(current.order.generation.id === plan.expectedGeneration);
        for (const label of selected) stopped(label);
        for (const label of selected) {
          await checkEnrollment();
          checkGeneration();
          if (!stopped(label)) requireUninstall(launchctl('bootout', label).status === 0 && stopped(label));
        }
        await withStoppedGenerationWriters(installed, async checkWriters => {
          const check = () => { guard(); checkGeneration(); checkWriters(); };
          check();
          await use(check);
          check();
        }, owner);
      });
    },
    async absent(label) { return stopped(label); },
    recordRemoved,
  };
}

export function uninstallPlanSha256(
  identity: LifecycleRegistration['identity'], generation: string,
  launchDaemons: LaunchDirectory, jobs: readonly LaunchJob[],
) {
  return digest(canonical({
    protocol: 'patrick-uninstall-v1',
    identity: { ...projectIdentity(identity), installationId: identity.installationId, domains: [...identity.domains].sort() },
    generation, launchDaemons,
    jobs: [...jobs].sort((left, right) => left.label.localeCompare(right.label, 'en')),
  }));
}

function owned(info: Stats, binding: FileIdentity) {
  return info.dev === binding.device && info.ino === binding.inode &&
    (info.uid === process.geteuid?.() || info.uid === 0) && (info.mode & 0o022) === 0;
}

function checkedDirectory(directory: LaunchDirectory) {
  const { path } = directory;
  requireUninstall(isAbsolute(path) && resolve(path) === path && parse(path).root !== path &&
    realpathSync.native(path) === path);
  const info = lstatSync(path);
  requireUninstall(info.isDirectory() && owned(info, directory));
}

function readBounded(fd: number, length: number) {
  const bytes = Buffer.alloc(length + 1);
  let size = 0;
  while (size < bytes.length) {
    const count = readSync(fd, bytes, size, bytes.length - size, size);
    if (!count) break;
    size += count;
  }
  return bytes.subarray(0, size);
}

function checkedJob(directory: LaunchDirectory, job: LaunchJob) {
  checkedDirectory(directory);
  const path = join(directory.path, job.label + '.plist');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    requireUninstall(info.isFile() && info.nlink === 1 && owned(info, job) &&
      info.size > 0 && info.size <= maxPlistBytes);
    const bytes = readBounded(fd, info.size);
    const named = lstatSync(path);
    requireUninstall(bytes.length === info.size && digest(bytes) === job.sha256 &&
      named.isFile() && owned(named, job) && named.nlink === 1 && named.size === info.size &&
      named.mtimeMs === info.mtimeMs && named.ctimeMs === info.ctimeMs);
    return path;
  } finally { closeSync(fd); }
}

function removeJobs(directory: LaunchDirectory, jobs: readonly LaunchJob[]) {
  checkedDirectory(directory);
  const fd = openSync(directory.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    requireUninstall(owned(fstatSync(fd), directory));
    for (const job of jobs) checkedJob(directory, job);
    for (const job of jobs) unlinkSync(checkedJob(directory, job));
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export async function runUninstall(
  enrollment: UninstallEnrollment, identity: HostIdentity, operationId: string,
  action: 'preview' | 'execute' | 'readback', validate: () => void,
) {
  const { journal, launchDaemons, jobs, controller, signer } = enrollment;
  const plan = journal.plan;
  requireUninstall(enrollment.operationId === operationId && sameIdentity(identity, journal.identity) && plan.command === 'uninstall' &&
    plan.targetId === journal.identity.installationId && typeof plan.expectedGeneration === 'string' &&
    plan.nextGeneration === null && plan.releaseSha256 === null && jobs.length > 0 &&
    jobs.length <= labels.size && jobs.every(job => labels.has(job.label) &&
      Number.isSafeInteger(job.device) && job.device >= 0 && Number.isSafeInteger(job.inode) && job.inode > 0 &&
      typeof job.sha256 === 'string' && /^[a-f0-9]{64}$/.test(job.sha256)) &&
    new Set(jobs.map(job => job.label)).size === jobs.length &&
    plan.planSha256 === uninstallPlanSha256(journal.identity, plan.expectedGeneration, launchDaemons, jobs));
  const request: LifecycleRequest = { operationId, command: 'uninstall', targetId: plan.targetId,
    expectedGeneration: plan.expectedGeneration, planSha256: plan.planSha256 };
  const current = () => { validate(); return journal; };
  const reader = createLifecycleJournalReader(current);
  const prior = await reader.read(request);
  validate();
  if (action === 'readback' || prior.status === 'completed') return prior;
  const evidenceId = removalEvidenceId(operationId);
  if (prior.status === 'running_or_uncertain') {
    if (action !== 'execute' || !signer) return prior;
    try {
      return await createLifecycleJournal(current, signer).reconcileCompleted(request, evidenceId);
    } catch {
      validate();
      return prior;
    }
  }

  if (action === 'preview') {
    for (const job of jobs) checkedJob(launchDaemons, job);
    return { status: 'preview' as const, labels: jobs.map(job => job.label) };
  }
  if (!controller || !signer) return { status: 'unavailable' as const };

  const operations = createLifecycleJournal(current, signer);
  try {
    for (const job of jobs) checkedJob(launchDaemons, job);
    await operations.reserve(request);
    validate();
    const claim = await operations.claim(request);
    if (claim.status !== 'claimed') return claim;
    let invoked = false;
    let recorded = false;
    let active = true;
    const checkEnrollment = async () => {
      await operations.readOwnedClaim(claim.token);
      validate();
      for (const job of jobs) checkedJob(launchDaemons, job);
    };
    try {
      await controller.withStoppedWriters(async guard => {
        requireUninstall(active && !invoked);
        invoked = true;
        await operations.readOwnedClaim(claim.token);
        validate();
        for (const job of jobs) requireUninstall(await controller.absent(job.label) === true);
        await operations.readOwnedClaim(claim.token);
        validate();
        requireUninstall(active);
        guard?.();
        removeJobs(launchDaemons, jobs);
        await controller.recordRemoved(claim.subject, evidenceId);
        validate();
        guard?.();
        recorded = true;
      }, checkEnrollment, claim.subject);
    } finally { active = false; }
    requireUninstall(recorded);
    validate();
    return await operations.markCompleted(claim.token, evidenceId);
  } catch (error) {
    const observed = await reader.read(request);
    if (observed.status === 'running_or_uncertain' || observed.status === 'completed') return observed;
    throw error;
  }
}
