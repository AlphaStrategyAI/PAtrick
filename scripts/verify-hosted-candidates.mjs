#!/usr/bin/env node
// Registers the dual-architecture Darwin candidates of a hosted GitHub Actions
// run. The downloaded bytes are verified against their own digests, against the
// readback receipt and against the machine architecture of the extracted native
// extension, so the registry only records what an independent check confirmed.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize } from '../deploy/lib/release.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const architectures = Object.freeze(['arm64', 'x64']);
const expectedNode = Object.freeze({ node: 'v26.13.0', modules: '147' });
const nativePath = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';
const nativeMachO = Object.freeze({ arm64: 'arm64', x64: 'x86_64' });

function fail(code) {
  throw new Error(code);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('CANDIDATE_RECEIPT_INVALID');
  }
}

function parseSums(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line.trim());
    if (!match) continue;
    entries.push({ sha256: match[1], path: match[2] });
  }
  if (entries.length === 0) fail('CANDIDATE_DIGEST_LIST_INVALID');
  return entries;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) fail(options.failure ?? 'CANDIDATE_COMMAND_FAILED');
  return result.stdout.trim();
}

function countPayloadFiles(root) {
  const files = [];
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
      else if (entry.isFile()) files.push(`${prefix}${entry.name}`);
    }
  };
  walk(root, '');
  return files;
}

function verifyNative(archive, architecture, workspace, inspect) {
  const extracted = join(workspace, architecture);
  mkdirSync(extracted, { recursive: true });
  run('/usr/bin/tar', ['-xf', archive, '-C', extracted], { failure: 'CANDIDATE_ARCHIVE_INVALID' });
  const native = join(extracted, nativePath);
  if (!existsSync(native)) fail('CANDIDATE_NATIVE_MISSING');
  const digest = sha256(readFileSync(native));
  const description = inspect(native, architecture);
  if (!description.includes('Mach-O 64-bit bundle ' + nativeMachO[architecture])) fail('CANDIDATE_NATIVE_ARCHITECTURE_MISMATCH');
  return { sha256: digest, description };
}

/**
 * Verifies one downloaded candidate tree and returns the registry entry for it.
 * The tree is the directory that `gh run download` writes for a single run.
 */
export function verifyCandidateTree(tree, options = {}) {
  const workspace = options.workspace ?? mkdtempSync(join(tmpdir(), 'patrick-candidate-verify-'));
  const ownWorkspace = !options.workspace;
  const inspect = options.inspectNative ?? ((path) => run('/usr/bin/file', ['-b', path], { failure: 'CANDIDATE_NATIVE_UNREADABLE' }));
  try {
    const entries = {};
    let expectedCommit = options.expectedCommit;
    for (const architecture of architectures) {
      const materials = join(tree, `patrick-darwin-${architecture}-unsigned-deployment-complete-materials`);
      const candidate = join(tree, `patrick-darwin-${architecture}-unsigned-source-candidate`);
      if (!existsSync(materials) || !existsSync(candidate)) fail('CANDIDATE_ARTIFACT_MISSING');
      const archive = join(materials, 'runtime-materials.tar');
      if (!existsSync(archive)) fail('CANDIDATE_ARCHIVE_MISSING');
      const archiveSha256 = sha256(readFileSync(archive));
      const listed = parseSums(readFileSync(join(materials, 'SHA256SUMS'), 'utf8'));
      const listedArchive = listed.find(entry => entry.path.endsWith('runtime-materials.tar'));
      if (!listedArchive || listedArchive.sha256 !== archiveSha256) fail('CANDIDATE_ARCHIVE_DIGEST_MISMATCH');
      const receipt = readJson(join(materials, 'readback-receipt.json'));
      if (receipt.kind !== 'unsigned-deployment-complete-materials') fail('CANDIDATE_RECEIPT_KIND_MISMATCH');
      if (receipt.readback?.status !== 'verified') fail('CANDIDATE_RECEIPT_NOT_VERIFIED');
      if (!/^[a-f0-9]{40}$/.test(receipt.source?.commit ?? '')) fail('CANDIDATE_COMMIT_MISSING');
      expectedCommit ??= receipt.source.commit;
      if (receipt.source.commit !== expectedCommit) fail('CANDIDATE_BUILD_COMMIT_MISMATCH');
      if (receipt.observed?.platform !== 'darwin' || receipt.observed?.arch !== architecture) fail('CANDIDATE_TARGET_MISMATCH');
      if (receipt.observed?.node !== expectedNode.node || receipt.observed?.modules !== expectedNode.modules) fail('CANDIDATE_RUNTIME_MISMATCH');
      if (receipt.native?.format !== 'mach-o' || receipt.native?.architecture !== architecture ||
          receipt.native?.observedArchitecture !== architecture) fail('CANDIDATE_NATIVE_TARGET_MISMATCH');
      if (receipt.native?.observedNode !== expectedNode.node || receipt.native?.observedModules !== expectedNode.modules) fail('CANDIDATE_NATIVE_RUNTIME_MISMATCH');
      if (receipt.archive?.sha256 !== archiveSha256) fail('CANDIDATE_RECEIPT_ARCHIVE_MISMATCH');
      const native = verifyNative(archive, architecture, workspace, inspect);
      if (receipt.native?.sha256 !== native.sha256) fail('CANDIDATE_NATIVE_DIGEST_MISMATCH');
      const payload = countPayloadFiles(extracted(workspace, architecture));
      const inventoryPath = join(extracted(workspace, architecture), 'metadata/runtime-materials.json');
      if (!existsSync(inventoryPath)) fail('CANDIDATE_INVENTORY_MISSING');
      const inventoryBytes = readFileSync(inventoryPath);
      if (inventoryBytes.length !== receipt.readback?.inventoryBytes) fail('CANDIDATE_INVENTORY_SIZE_MISMATCH');
      if (sha256(inventoryBytes) !== receipt.readback?.inventorySha256) fail('CANDIDATE_INVENTORY_DIGEST_MISMATCH');
      const inventory = readJson(inventoryPath);
      if (!Array.isArray(inventory.files) || inventory.files.length !== receipt.readback?.files) fail('CANDIDATE_PAYLOAD_COUNT_MISMATCH');
      if (payload.length !== inventory.files.length + 1) fail('CANDIDATE_ARCHIVE_PAYLOAD_MISMATCH');
      const candidateSums = parseSums(readFileSync(join(candidate, 'SHA256SUMS'), 'utf8'));
      const candidateFile = `patrick-darwin-${architecture}.candidate.json`;
      const listedCandidate = candidateSums.find(entry => entry.path.endsWith(candidateFile));
      if (!listedCandidate) fail('CANDIDATE_SOURCE_DIGEST_MISSING');
      const candidateSha256 = sha256(readFileSync(join(candidate, candidateFile)));
      if (listedCandidate.sha256 !== candidateSha256) fail('CANDIDATE_SOURCE_DIGEST_MISMATCH');
      const envelope = readJson(join(candidate, candidateFile));
      if (envelope.manifest?.commit !== receipt.source.commit) fail('CANDIDATE_SOURCE_COMMIT_MISMATCH');
      if (envelope.manifest?.target?.os !== 'darwin' || envelope.manifest?.target?.arch !== architecture) fail('CANDIDATE_SOURCE_ARCH_MISMATCH');
      if (envelope.manifest?.kind !== 'source-candidate') fail('CANDIDATE_SOURCE_KIND_MISMATCH');
      if (!Array.isArray(envelope.manifest?.artifacts) || envelope.manifest.artifacts.length === 0) fail('CANDIDATE_SOURCE_EMPTY');
      if ((envelope.signatures ?? []).length !== 0) fail('CANDIDATE_SOURCE_SIGNED');
      const sourceReceipt = readJson(join(candidate, 'receipt.json'));
      if (sourceReceipt.status !== 'unsigned-candidate' || sourceReceipt.installable !== false) fail('CANDIDATE_SOURCE_STATE_MISMATCH');
      const sourceManifestSha256 = sha256(Buffer.from(canonicalize(envelope.manifest)));
      if (sourceReceipt.sha256 !== candidateSha256 || sourceReceipt.manifestSha256 !== sourceManifestSha256) {
        fail('CANDIDATE_SOURCE_RECEIPT_DIGEST_MISMATCH');
      }
      entries[architecture] = {
        architecture,
        commit: receipt.source.commit,
        snapshotSha256: receipt.source.snapshotSha256 ?? null,
        lockSha256: receipt.source.lockSha256 ?? null,
        node: receipt.observed.node,
        modules: receipt.observed.modules,
        npm: receipt.observed.npm,
        sqlite: receipt.native.sqlite,
        archiveSha256,
        inventorySha256: receipt.readback.inventorySha256,
        payloadFiles: payload.length,
        nativeSha256: native.sha256,
        nativeDescription: native.description,
        sourceCandidateSha256: candidateSha256,
        sourceManifestSha256,
      };
    }
    return entries;
  } finally {
    if (ownWorkspace) rmSync(workspace, { recursive: true, force: true });
  }
}

function extracted(workspace, architecture) {
  return join(workspace, architecture);
}

function downloadRun(runId) {
  const directory = mkdtempSync(join(tmpdir(), 'patrick-candidate-download-'));
  run('gh', ['run', 'download', runId, '--dir', directory], { failure: 'CANDIDATE_DOWNLOAD_FAILED' });
  return directory;
}

function runSummary(runId) {
  const raw = run('gh', ['run', 'view', runId, '--json', 'conclusion,headSha,url,jobs'], { failure: 'CANDIDATE_RUN_UNREADABLE' });
  const view = JSON.parse(raw);
  if (view.conclusion !== 'success') fail('CANDIDATE_RUN_INCOMPLETE');
  if (typeof view.headSha !== 'string' || !/^[a-f0-9]{40}$/.test(view.headSha)) fail('CANDIDATE_COMMIT_MISSING');
  for (const architecture of architectures) {
    const job = (view.jobs ?? []).find(entry => new RegExp(`,\\s*${architecture}\\)$`).test(entry.name ?? ''));
    if (!job || job.conclusion !== 'success') fail('CANDIDATE_JOB_INCOMPLETE');
  }
  return view;
}

function main() {
  const runId = process.env.PATRICK_DARWIN_RELEASE_RUN?.trim() || process.argv[2];
  if (!runId) fail('CANDIDATE_RUN_UNSPECIFIED');
  const view = runSummary(runId);
  const tree = downloadRun(runId);
  try {
    const entries = verifyCandidateTree(tree, { expectedCommit: view.headSha });
    const receipt = {
      format: 'patrick-hosted-candidates-v1',
      run: String(runId),
      commit: view.headSha,
      url: view.url,
      node: expectedNode.node,
      modules: expectedNode.modules,
      architectures: entries,
    };
    const text = JSON.stringify(receipt, null, 2) + '\n';
    if (process.env.PATRICK_CANDIDATE_RECEIPT) {
      const target = process.env.PATRICK_CANDIDATE_RECEIPT;
      if (!target.startsWith(repo)) fail('CANDIDATE_RECEIPT_PATH_OUTSIDE_REPOSITORY');
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, text);
    }
    process.stdout.write(text);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(JSON.stringify({ status: 'failed', code: error instanceof Error ? error.message : 'CANDIDATE_VERIFICATION_FAILED' }) + '\n');
    process.exitCode = 1;
  }
}
