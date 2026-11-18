import { RELEASE_LIMITS as limits, sha256 } from '../deploy/lib/release.mjs';
import {
  artifactTable, check, compareTree, encode, freeze, inspectBytes, inspectEvidence, leased,
  logPath, paths, publishPackage, readLeased, readTree, signatureSet,
} from '../deploy/lib/emitted-release.mjs';

const preparedSets = new WeakMap();

async function snapshot(input, evidence, expectedMaterialSha256) {
  const { staging, ...supplied } = input;
  const options = structuredClone(supplied);
  const observations = evidence && structuredClone(evidence);
  return leased(staging, async lease => {
    const budget = { files: 0, bytes: 0 };
    const tree = await readTree(lease, options.artifactRoot, undefined, budget);
    const files = new Map(tree.files);
    async function include(key, path, expectedHash) {
      check(!files.has(key), 'duplicate material path');
      const { data, binding } = await readLeased(lease, path, limits.artifactBytes, budget);
      check((binding.info.mode & 0o7777n) === 0o644n, 'sidecar mode mismatch');
      check(sha256(data) === expectedHash, 'explicit input digest mismatch ' + key);
      files.set(key, data);
    }
    await include(paths.lock, options.lockPath, options.expectedSource.lockSha256);
    await include(paths.toolchain, options.toolchain.path, options.toolchain.sha256);
    const result = inspectBytes(files, { profile: options.profile, version: options.version, target: options.target, schema: options.schema,
      source: options.expectedSource, inventorySha256: options.expectedInventorySha256, toolchainSha256: options.toolchain.sha256 });
    const { identity, materialSha256, sbom } = result;
    compareTree(tree, identity.materials);
    if (!observations) return freeze({ ...identity, materialSha256 });
    check(expectedMaterialSha256 === materialSha256, 'pre-evidence material identity mismatch');
    files.set(paths.sbom, sbom);
    budget.files++;
    budget.bytes += sbom.length;
    await include(paths.report, observations.report.path, observations.report.sha256);
    check(Array.isArray(observations.logs) && observations.logs.length <= limits.files - budget.files, 'execution log count');
    for (const log of observations.logs) await include(logPath(log.id), log.path, log.sha256);
    const logs = inspectEvidence(files, identity, materialSha256, { executionReportSha256: observations.report.sha256,
      requiredScenarios: observations.logs.map(log => ({ id: log.id, evidenceSha256: log.sha256 })) });
    const artifacts = artifactTable(files, identity, logs);
    const manifest = { format: 'patrick-emitted-runtime-manifest-v1', kind: 'emitted-runtime-candidate', identity, materialSha256, artifacts };
    const manifestBytes = encode(manifest);
    const prepared = freeze({ signingManifestBase64: manifestBytes.toString('base64'), manifestSha256: sha256(manifestBytes),
      materialSha256, inventorySha256: identity.inventorySha256 });
    preparedSets.set(prepared, { manifest, files });
    return prepared;
  });
}
export function inspectEmittedRuntimeMaterial(input) { return snapshot(input); }
export async function prepareEmittedRuntimeCandidate({ expectedMaterialSha256, evidence, ...input }) {
  check(evidence && Array.isArray(evidence.logs), 'explicit evidence required');
  return snapshot(input, evidence, expectedMaterialSha256);
}
export async function packEmittedRuntimeCandidate(prepared, { signatures, outputPath, outputStaging }) {
  const set = preparedSets.get(prepared);
  check(set, 'genuine prepared candidate required');
  const detached = structuredClone(signatures);
  signatureSet(detached);
  const { manifest } = set;
  const files = manifest.artifacts.map(r => ({ path: r.path, data: '' }));
  const envelope = { format: 'patrick-emitted-runtime-envelope-v1', manifest, signatures: detached, files };
  const encodedBytes = manifest.artifacts.reduce((sum, row) => sum + 4 * Math.ceil(row.bytes / 3), encode(envelope).length);
  check(encodedBytes <= limits.packageBytes, 'encoded envelope limit');
  for (const file of files) file.data = set.files.get(file.path).toString('base64');
  const data = encode(envelope);
  check(data.length === encodedBytes, 'encoded envelope length mismatch');
  const packageSha256 = sha256(data);
  await publishPackage(outputStaging, outputPath, data, packageSha256);
  return freeze({ packageSha256, manifestSha256: prepared.manifestSha256, materialSha256: prepared.materialSha256,
    inventorySha256: prepared.inventorySha256, bytes: data.length });
}
