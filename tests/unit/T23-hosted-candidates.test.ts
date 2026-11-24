import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { canonicalize } from '../../deploy/lib/release.mjs';
import { verifyCandidateTree } from '../../scripts/verify-hosted-candidates.mjs';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const nativePath = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';
const commit = 'a'.repeat(40);
const directories: string[] = [];

afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

function workspace() {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'patrick-candidate-fixture-'));
  directories.push(directory);
  return directory;
}

const inspect = (path: string, architecture: string) =>
  `Mach-O 64-bit ${path.endsWith('/patrick-host-controller') ? 'executable' : 'bundle'} ${architecture === 'arm64' ? 'arm64' : 'x86_64'}`;

function buildTree(root: string, options: {
  commit?: string; x64Commit?: string; inventoryCommit?: string; node?: string; modules?: string; sign?: boolean; changePayload?: 'bytes' | 'mode';
  controller?: 'legacy' | 'missing' | 'changed';
} = {}) {
  for (const architecture of ['arm64', 'x64']) {
    const sourceCommit = (architecture === 'x64' ? options.x64Commit : undefined) ?? options.commit ?? commit;
    const materials = join(root, `patrick-darwin-${architecture}-unsigned-deployment-complete-materials`);
    const candidate = join(root, `patrick-darwin-${architecture}-unsigned-source-candidate`);
    const payload = join(root, `payload-${architecture}`);
    mkdirSync(join(payload, 'metadata'), { recursive: true });
    mkdirSync(join(payload, 'node_modules/better-sqlite3/build/Release'), { recursive: true });
    const nativeBytes = Buffer.from(`native-${architecture}\n`);
    const runtimePath = 'runtime/cli.mjs';
    const runtimeBytes = Buffer.from('export {};\n');
    mkdirSync(join(payload, 'runtime'));
    writeFileSync(join(payload, nativePath), nativeBytes);
    chmodSync(join(payload, nativePath), 0o755);
    writeFileSync(join(payload, runtimePath), options.changePayload === 'bytes' ? Buffer.from('export {} \n') : runtimeBytes);
    chmodSync(join(payload, runtimePath), options.changePayload === 'mode' ? 0o755 : 0o644);
    const files = [
      { path: nativePath, role: 'native-addon', bytes: nativeBytes.length, sha256: sha(nativeBytes), mode: '100755' },
      { path: runtimePath, role: 'runtime-entry', bytes: runtimeBytes.length, sha256: sha(runtimeBytes), mode: '100644' },
    ];
    const source = { kind: 'commit', commit: sourceCommit, snapshotSha256: 'b'.repeat(64), lockSha256: 'c'.repeat(64) };
    const observed = { platform: 'darwin', arch: architecture, node: options.node ?? 'v26.13.0', modules: options.modules ?? '147', npm: '11.20.0' };
    const native = { path: nativePath, sha256: sha(nativeBytes), bytes: nativeBytes.length, format: 'mach-o',
      architecture, observedArchitecture: architecture, observedNode: observed.node,
      observedModules: observed.modules, observedLoad: true, sqlite: '3.53.2' };
    const inventory = Buffer.from(JSON.stringify({
      source: { ...source, commit: options.inventoryCommit ?? sourceCommit }, observed, native, files,
    }, null, 2) + '\n');
    writeFileSync(join(payload, 'metadata/runtime-materials.json'), inventory);
    mkdirSync(materials, { recursive: true });
    const archive = join(materials, 'runtime-materials.tar');
    const tar = spawnSync('/usr/bin/tar', ['-cf', archive, '-C', payload, '.']);
    expect(tar.status, tar.stderr?.toString()).toBe(0);
    const archiveSha256 = sha(readFileSync(archive));
    const controllerName = 'patrick-host-controller';
    const controllerBytes = Buffer.from(`controller-${architecture}\n`);
    const controller = { name: controllerName, sha256: sha(controllerBytes), bytes: controllerBytes.length };
    const legacy = options.controller === 'legacy';
    if (!legacy && options.controller !== 'missing') {
      writeFileSync(join(materials, controllerName), options.controller === 'changed'
        ? Buffer.alloc(controllerBytes.length) : controllerBytes);
    }
    writeFileSync(join(materials, 'SHA256SUMS'), `${archiveSha256}  runtime-materials.tar\n` +
      (legacy ? '' : `${controller.sha256}  ${controllerName}\n`));
    const receipt = {
      kind: 'unsigned-deployment-complete-materials',
      source, observed, native,
      archive: { name: 'runtime-materials.tar', sha256: archiveSha256 },
      ...(!legacy && { controller }),
      readback: { status: 'verified', profile: 'deployment-complete', files: files.length,
        bytes: nativeBytes.length + runtimeBytes.length, inventoryBytes: inventory.length, inventorySha256: sha(inventory) },
    };
    writeFileSync(join(materials, 'readback-receipt.json'), JSON.stringify(receipt, null, 2));
    mkdirSync(candidate, { recursive: true });
    const envelope = {
      format: 'patrick-release-envelope-v1',
      manifest: { format: 'patrick-release-manifest-v1', kind: 'source-candidate', commit: sourceCommit,
        version: '0.0.0', target: { os: 'darwin', arch: architecture }, schema: { min: 1, max: 1 },
        artifacts: [{ path: 'source/package.json', mode: '100644', bytes: 1, sha256: 'd'.repeat(64) }] },
      files: [],
      signatures: options.sign ? [{ keyId: 'fixture', signature: 'signature' }] : [],
    };
    const candidateFile = join(candidate, `patrick-darwin-${architecture}.candidate.json`);
    writeFileSync(candidateFile, JSON.stringify(envelope));
    const candidateSha256 = sha(readFileSync(candidateFile));
    writeFileSync(join(candidate, 'SHA256SUMS'), `${candidateSha256}  candidate/patrick-darwin-${architecture}.candidate.json\n`);
    writeFileSync(join(candidate, 'receipt.json'), JSON.stringify({ status: 'unsigned-candidate', installable: false,
      keyId: null, sha256: candidateSha256, bytes: readFileSync(candidateFile).length,
      manifestSha256: sha(Buffer.from(canonicalize(envelope.manifest))), runtime: { status: 'unavailable', prerequisites: [] } }));
  }
  return root;
}

it('registers both architectures from the downloaded bytes and their own digests', () => {
  const tree = buildTree(workspace());
  const entries = verifyCandidateTree(tree, { inspectNative: inspect });
  expect(Object.keys(entries)).toEqual(['arm64', 'x64']);
  expect(entries.arm64.node).toBe('v26.13.0');
  expect(entries.arm64.modules).toBe('147');
  expect(entries.arm64.commit).toBe(commit);
  expect(entries.arm64.nativeDescription).toContain('Mach-O 64-bit bundle arm64');
  expect(entries.x64.nativeDescription).toContain('Mach-O 64-bit bundle x86_64');
  expect(entries.arm64.payloadFiles).toBe(3);
  expect(entries.arm64.sourceCandidateSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(entries.arm64.controller).toEqual({
    sha256: sha(Buffer.from('controller-arm64\n')), bytes: 17, description: 'Mach-O 64-bit executable arm64',
  });
  expect(entries.x64.controller?.description).toBe('Mach-O 64-bit executable x86_64');
});

it.each([
  ['missing', 'CANDIDATE_CONTROLLER_MISSING'],
  ['changed', 'CANDIDATE_CONTROLLER_DIGEST_MISMATCH'],
] as const)('rejects a %s published controller', (controller, code) => {
  const tree = buildTree(workspace(), { controller });
  expect(() => verifyCandidateTree(tree, { inspectNative: inspect })).toThrow(code);
});

it('checks controller bytes against the receipt and checksum list', () => {
  const tree = buildTree(workspace());
  const materials = join(tree, 'patrick-darwin-arm64-unsigned-deployment-complete-materials');
  const receiptPath = join(materials, 'readback-receipt.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  writeFileSync(receiptPath, JSON.stringify({ ...receipt, controller: { ...receipt.controller, bytes: 1 } }));
  expect(() => verifyCandidateTree(tree, { inspectNative: inspect })).toThrow('CANDIDATE_CONTROLLER_RECEIPT_MISMATCH');
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const sums = join(materials, 'SHA256SUMS');
  writeFileSync(sums, readFileSync(sums, 'utf8').replace(receipt.controller.sha256, 'e'.repeat(64)));
  expect(() => verifyCandidateTree(tree, { inspectNative: inspect })).toThrow('CANDIDATE_CONTROLLER_DIGEST_MISMATCH');
});

it.each(['Mach-O 64-bit executable x86_64', 'Mach-O 64-bit bundle arm64'])(
  'rejects a controller described as %s on arm64', description => {
    const tree = buildTree(workspace());
    const inspectArtifact = (path: string, architecture: string) =>
      path.endsWith('/patrick-host-controller') ? description : inspect(path, architecture);
    expect(() => verifyCandidateTree(tree, { inspectNative: inspectArtifact })).toThrow('CANDIDATE_CONTROLLER_ARCHITECTURE_MISMATCH');
  },
);

it('preserves previous hosted receipts unless controller delivery is required', () => {
  const tree = buildTree(workspace(), { controller: 'legacy' });
  expect(verifyCandidateTree(tree, { inspectNative: inspect }).arm64.controller).toBeUndefined();
  expect(() => verifyCandidateTree(tree, { inspectNative: inspect, requireController: true })).toThrow('CANDIDATE_CONTROLLER_MISSING');
});

it.each(['bytes', 'mode'] as const)('rejects changed runtime %s even when the archive digest matches its receipt', changePayload => {
  const tree = buildTree(workspace(), { changePayload });
  expect(() => verifyCandidateTree(tree, { inspectNative: inspect })).toThrow('CANDIDATE_PAYLOAD_DESCRIPTOR_MISMATCH');
});

it('rejects a tampered archive, a foreign runtime, a mismatched commit and a signed source', () => {
  const tree = buildTree(workspace());
  const materials = join(tree, 'patrick-darwin-arm64-unsigned-deployment-complete-materials');
  const archive = join(materials, 'runtime-materials.tar');
  writeFileSync(archive, Buffer.concat([readFileSync(archive), Buffer.from('tampered\n')]));
  expect(() => verifyCandidateTree(tree, { inspectNative: inspect })).toThrow(/CANDIDATE_ARCHIVE_DIGEST_MISMATCH/);

  const foreign = buildTree(workspace(), { node: 'v24.9.0' });
  expect(() => verifyCandidateTree(foreign, { inspectNative: inspect })).toThrow(/CANDIDATE_RUNTIME_MISMATCH/);

  const moved = buildTree(workspace(), { commit: 'b'.repeat(40) });
  const candidate = join(moved, 'patrick-darwin-x64-unsigned-source-candidate/patrick-darwin-x64.candidate.json');
  const envelope = JSON.parse(readFileSync(candidate, 'utf8'));
  envelope.manifest.commit = 'e'.repeat(40);
  writeFileSync(candidate, JSON.stringify(envelope));
  expect(() => verifyCandidateTree(moved, { inspectNative: inspect })).toThrow(/CANDIDATE_SOURCE_DIGEST_MISMATCH/);

  const signed = buildTree(workspace(), { sign: true });
  expect(() => verifyCandidateTree(signed, { inspectNative: inspect })).toThrow(/CANDIDATE_SOURCE_SIGNED/);
});

it('rejects a native extension whose machine architecture does not match the target', () => {
  const tree = buildTree(workspace());
  const inspectArtifact = (path: string, architecture: string) =>
    inspect(path, path.endsWith(nativePath) ? 'x64' : architecture);
  expect(() => verifyCandidateTree(tree, { inspectNative: inspectArtifact })).toThrow(/CANDIDATE_NATIVE_ARCHITECTURE_MISMATCH/);
});

it('binds both architecture builds to the hosted run commit', () => {
  const tree = buildTree(workspace());
  expect(() => verifyCandidateTree(tree, { inspectNative: inspect, expectedCommit: 'c'.repeat(40) }))
    .toThrow(/CANDIDATE_BUILD_COMMIT_MISMATCH/);
  const mixed = buildTree(workspace(), { x64Commit: 'c'.repeat(40) });
  expect(() => verifyCandidateTree(mixed, { inspectNative: inspect })).toThrow(/CANDIDATE_BUILD_COMMIT_MISMATCH/);
});

it('rejects a valid archive whose internal inventory identifies a different build', () => {
  const tree = buildTree(workspace(), { inventoryCommit: 'c'.repeat(40) });
  expect(() => verifyCandidateTree(tree, { inspectNative: inspect, expectedCommit: commit })).toThrow('CANDIDATE_INVENTORY_IDENTITY_MISMATCH');
});

it('checks the inventory and source manifest digests directly against their receipts', () => {
  const tree = buildTree(workspace());
  const materialsReceipt = join(tree, 'patrick-darwin-arm64-unsigned-deployment-complete-materials/readback-receipt.json');
  const original = readFileSync(materialsReceipt, 'utf8');
  const receipt = JSON.parse(original);
  receipt.readback.inventorySha256 = 'e'.repeat(64);
  writeFileSync(materialsReceipt, JSON.stringify(receipt));
  expect(() => verifyCandidateTree(tree, { inspectNative: inspect })).toThrow(/CANDIDATE_INVENTORY_DIGEST_MISMATCH/);
  writeFileSync(materialsReceipt, original);

  const sourceReceipt = join(tree, 'patrick-darwin-arm64-unsigned-source-candidate/receipt.json');
  const source = JSON.parse(readFileSync(sourceReceipt, 'utf8'));
  writeFileSync(sourceReceipt, JSON.stringify({ ...source, manifestSha256: 'e'.repeat(64) }));
  expect(() => verifyCandidateTree(tree, { inspectNative: inspect })).toThrow(/CANDIDATE_SOURCE_RECEIPT_DIGEST_MISMATCH/);
});

it('rejects a missing architecture and an unreadable receipt', () => {
  const tree = buildTree(workspace());
  rmSync(join(tree, 'patrick-darwin-x64-unsigned-source-candidate'), { recursive: true, force: true });
  expect(() => verifyCandidateTree(tree, { inspectNative: inspect })).toThrow(/CANDIDATE_ARTIFACT_MISSING/);

  const broken = buildTree(workspace());
  writeFileSync(join(broken, 'patrick-darwin-arm64-unsigned-deployment-complete-materials/readback-receipt.json'), '{');
  expect(() => verifyCandidateTree(broken, { inspectNative: inspect })).toThrow(/CANDIDATE_RECEIPT_INVALID/);
});
