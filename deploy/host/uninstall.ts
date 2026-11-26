import {
  closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readSync, realpathSync, unlinkSync, type Stats,
} from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { projectIdentity, sameIdentity, type HostIdentity } from '../lib/doctor.mjs';
import { canonical, digest } from '../../packages/host/src/recovery/files.js';
import {
  createLifecycleJournal, createLifecycleJournalReader, type LifecycleEvidenceSubject,
  type LifecycleRegistration, type LifecycleRequest,
} from '../runtime/lifecycle-journal.js';

const labels = new Set([
  'com.patrick.service', 'com.patrick.autoloop-hub', 'com.patrick.autoloop-worker',
  'com.patrick.service-supervisor', 'com.patrick.autoloop-hub-supervisor', 'com.patrick.caddy',
]);
const maxPlistBytes = 64 * 1024;
type FileIdentity = { device: number; inode: number };
type LaunchDirectory = FileIdentity & { path: string };
type LaunchJob = FileIdentity & { label: string; sha256: string };

export type UninstallEnrollment = {
  operationId: string;
  launchDaemons: LaunchDirectory;
  jobs: readonly LaunchJob[];
  journal: LifecycleRegistration;
  signer?: Parameters<typeof createLifecycleJournal>[1];
  controller?: {
    withStoppedWriters(use: () => Promise<void>): Promise<void>;
    absent(label: string): Promise<boolean>;
    recordRemoved(subject: LifecycleEvidenceSubject, evidenceId: string): Promise<void>;
  };
};

function requireUninstall(condition: unknown): asserts condition {
  if (!condition) throw new Error('UNINSTALL_ADMISSION_FAILED');
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

function checkedJob(directory: LaunchDirectory, job: LaunchJob) {
  checkedDirectory(directory);
  const path = join(directory.path, job.label + '.plist');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    requireUninstall(info.isFile() && info.nlink === 1 && owned(info, job) &&
      info.size > 0 && info.size <= maxPlistBytes);
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, size);
      if (!count) break;
      size += count;
    }
    const named = lstatSync(path);
    requireUninstall(size === info.size && digest(bytes.subarray(0, size)) === job.sha256 &&
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
  if (action === 'readback' || prior.status === 'completed' || prior.status === 'running_or_uncertain') return prior;

  if (action === 'preview') {
    for (const job of jobs) checkedJob(launchDaemons, job);
    return { status: 'preview' as const, labels: jobs.map(job => job.label) };
  }
  if (!controller || !signer) return { status: 'unavailable' as const };

  const operations = createLifecycleJournal(current, signer);
  const evidenceId = 'uninstall-' + digest(operationId);
  try {
    for (const job of jobs) checkedJob(launchDaemons, job);
    await operations.reserve(request);
    validate();
    const claim = await operations.claim(request);
    if (claim.status !== 'claimed') return claim;
    let invoked = false;
    let recorded = false;
    let active = true;
    try {
      await controller.withStoppedWriters(async () => {
        requireUninstall(active && !invoked);
        invoked = true;
        await operations.readOwnedClaim(claim.token);
        validate();
        for (const job of jobs) requireUninstall(await controller.absent(job.label) === true);
        await operations.readOwnedClaim(claim.token);
        validate();
        requireUninstall(active);
        removeJobs(launchDaemons, jobs);
        await controller.recordRemoved(claim.subject, evidenceId);
        validate();
        recorded = true;
      });
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
