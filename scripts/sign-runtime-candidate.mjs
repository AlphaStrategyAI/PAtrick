import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyEmittedRuntimeCandidate } from '../deploy/lib/emitted-release.mjs';
import { sha256 } from '../deploy/lib/release.mjs';
import { packEmittedRuntimeCandidate, prepareEmittedRuntimeCandidate } from './pack-runtime.mjs';

function observe(path) {
  const bytes = readFileSync(path);
  return { path, sha256: sha256(bytes), bytes: bytes.length };
}

function readSigner(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(descriptor);
    assert.ok(info.isFile() && info.uid === process.geteuid() && (info.mode & 0o077) === 0 &&
      info.size > 0 && info.size <= 8192, 'PRIVATE_SIGNER_PERMISSIONS_INVALID');
    const key = createPrivateKey(readFileSync(descriptor));
    assert.equal(key.asymmetricKeyType, 'ed25519');
    return key;
  } finally { closeSync(descriptor); }
}

const [workspace, materials, evidence, approvedCommit, approvedManifest, keyId, privateKeyPath] = process.argv.slice(2);
assert.match(approvedCommit, /^[0-9a-f]{40}$/);
assert.match(approvedManifest, /^[0-9a-f]{64}$/);
assert.match(keyId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
const work = realpathSync(workspace);
const artifactRoot = realpathSync(materials);
const evidenceRoot = realpathSync(evidence);
const input = JSON.parse(readFileSync(join(evidenceRoot, 'signing-input.json'), 'utf8'));
assert.equal(input.format, 'patrick-runtime-signing-input-v1');
assert.equal(input.source.commit, approvedCommit);
assert.equal(input.manifestSha256, approvedManifest);
assert.ok(input.target.os === 'darwin' && ['arm64', 'x64'].includes(input.target.arch));
const { requiredScenarios } = input;
assert.ok(Array.isArray(requiredScenarios) && requiredScenarios.length === 4);
const logs = requiredScenarios.map(({ id, evidenceSha256 }) => {
  assert.match(id, /^[a-z][a-z0-9-]{1,79}$/);
  const observation = observe(join(evidenceRoot, `${id}.log`));
  assert.equal(observation.sha256, evidenceSha256);
  return { id, ...observation };
});
const report = observe(join(evidenceRoot, 'execution-report.json'));
assert.equal(report.sha256, input.executionReportSha256);
const toolchain = observe(join(evidenceRoot, 'toolchain.json'));
assert.equal(toolchain.sha256, input.toolchainSha256);
const staging = { withExclusiveReadRoot: use => use(work), withExclusiveWriteRoot: use => use(work) };
const profile = 'deployment-complete';
const prepared = await prepareEmittedRuntimeCandidate({
  profile, artifactRoot, staging, version: input.version, target: input.target, schema: input.schema,
  expectedSource: input.source, expectedInventorySha256: input.inventorySha256, expectedMaterialSha256: input.materialSha256,
  toolchain, lockPath: join(evidenceRoot, 'package-lock.json'), evidence: { report, logs },
});
assert.equal(prepared.manifestSha256, approvedManifest);
const signer = readSigner(privateKeyPath);
const publicKey = createPublicKey(signer).export({ type: 'spki', format: 'pem' });
const signature = sign(null, Buffer.from(prepared.signingManifestBase64, 'base64'), signer).toString('base64');
const output = join(work, `signed-${input.target.arch}`);
mkdirSync(output, { mode: 0o700 });
const outputPath = join(output, `patrick-darwin-${input.target.arch}.signed.json`);
const packed = await packEmittedRuntimeCandidate(prepared, { outputPath, outputStaging: staging, signatures: [{ keyId, signature }] });
const { observed } = JSON.parse(readFileSync(report.path, 'utf8'));
const expected = {
  profile, version: input.version, source: input.source, target: input.target, schema: input.schema, activeSchema: input.schema.min,
  runtime: { node: observed.node, modules: observed.modules },
  packageSha256: packed.packageSha256, materialSha256: packed.materialSha256, inventorySha256: packed.inventorySha256,
  toolchainSha256: input.toolchainSha256,
};
const policy = { keys: [{ id: keyId, publicKey }], executionReportSha256: report.sha256, requiredScenarios };
const receipt = await verifyEmittedRuntimeCandidate(outputPath, { staging, expected, policy });
assert.equal(receipt.packageSha256, packed.packageSha256);
chmodSync(outputPath, 0o600);
writeFileSync(join(output, 'pins.json'), JSON.stringify({ expected, policy }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ outputPath, sourceCommit: approvedCommit, target: receipt.target,
  packageSha256: packed.packageSha256, manifestSha256: packed.manifestSha256, verifiedFiles: receipt.materials.length }));
