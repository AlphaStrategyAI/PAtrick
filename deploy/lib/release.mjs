import { createHash, createPublicKey, verify } from 'node:crypto';
import { constants, lstatSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { open } from 'node:fs/promises';

export const RELEASE_LIMITS = Object.freeze({ packageBytes: 64 * 1024 * 1024, artifactBytes: 16 * 1024 * 1024, totalBytes: 40 * 1024 * 1024, files: 10000, evidenceEntries: 10000, evidenceDepth: 64 });
const admitted = new WeakSet();
const digestPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new Error('invalid canonical value');
}
function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
function exactKeys(value, keys, label) {
  requireCondition(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','), `invalid ${label} fields`);
}
export function validatePaths(paths) {
  const seen = new Set();
  for (const path of paths) {
    requireCondition(typeof path === 'string' && path.length <= 512 && /^[A-Za-z0-9_.\-/]+$/.test(path) && !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..' && !part.endsWith('.')), 'unsafe artifact path');
    const folded = path.toLowerCase();
    requireCondition(!seen.has(folded), 'duplicate or ambiguous artifact path');
    seen.add(folded);
  }
  for (const path of seen) {
    const parts = path.split('/');
    parts.pop();
    while (parts.length) {
      requireCondition(!seen.has(parts.join('/')), 'ambiguous file/directory path');
      parts.pop();
    }
  }
  requireCondition(paths.every((path, index) => index === 0 || paths[index - 1] < path), 'artifact paths must be sorted');
}
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.ctimeMs === right.ctimeMs;
// Callers must provision a trusted, exclusively controlled staging root. These
// identity checks detect persistent replacements. Node's public path-based fs API
// cannot exclude an adversarial replace-and-restore (ABA) between system calls.
export function admitReadRoot(root) {
  requireCondition(typeof root === 'string' && isAbsolute(root) && resolve(root) === root, 'physical absolute read root required');
  const components = [sep];
  for (const part of root.split(sep).filter(Boolean)) components.push(resolve(components.at(-1), part));
  const ancestors = components.map(path => {
    const info = lstatSync(path);
    requireCondition(info.isDirectory() && !info.isSymbolicLink(), 'symlink or invalid read ancestor');
    return { path, info };
  });
  function validate() {
    for (const { path, info } of ancestors) requireCondition(sameIdentity(info, lstatSync(path)), 'read root or ancestor changed');
  }
  return Object.freeze({ root, validate });
}
export async function readRegularFile(path, limit = RELEASE_LIMITS.artifactBytes, admission) {
  requireCondition(admission && typeof admission.validate === 'function', 'approved read root required');
  const absolute = resolve(path);
  const local = relative(admission.root, absolute);
  requireCondition(local && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local), 'file outside approved read root');
  admission.validate();
  const ancestors = [];
  let directory = admission.root;
  for (const part of local.split(sep).slice(0, -1)) {
    directory = resolve(directory, part);
    const info = lstatSync(directory);
    requireCondition(info.isDirectory() && !info.isSymbolicLink(), 'symlink or invalid read ancestor');
    ancestors.push({ path: directory, info });
  }
  const leaf = lstatSync(absolute);
  requireCondition(leaf.isFile() && leaf.size <= limit, 'invalid or oversized regular file');
  function validate() {
    admission.validate();
    for (const ancestor of ancestors) requireCondition(sameIdentity(ancestor.info, lstatSync(ancestor.path)), 'read ancestor changed');
    requireCondition(sameIdentity(leaf, lstatSync(absolute)), 'file identity changed');
  }
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    validate();
    const before = await handle.stat();
    requireCondition(before.isFile() && before.size <= limit && sameIdentity(leaf, before), 'invalid or changed regular file');
    const storage = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < storage.length) {
      const { bytesRead } = await handle.read(storage, offset, storage.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const bytes = storage.subarray(0, offset);
    const after = await handle.stat();
    validate();
    requireCondition(sameIdentity(before, after) && bytes.length === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs, 'file changed during read');
    return bytes;
  } finally { await handle.close(); }
}

function parseCanonical(bytes) {
  const value = JSON.parse(bytes.toString('utf8'));
  requireCondition(canonicalize(value) === bytes.toString('utf8'), 'noncanonical candidate encoding');
  return value;
}
function validateManifest(manifest) {
  exactKeys(manifest, ['format', 'version', 'commit', 'target', 'schema', 'kind', 'runtime', 'artifacts', 'inputs', 'sbom', 'evidence'], 'manifest');
  requireCondition(manifest.format === 'patrick-release-manifest-v1' && manifest.kind === 'source-candidate', 'unsupported release manifest');
  requireCondition(typeof manifest.version === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version) && commitPattern.test(manifest.commit), 'invalid release version/commit');
  exactKeys(manifest.target, ['os', 'arch'], 'target');
  requireCondition(manifest.target.os === 'darwin' && ['arm64', 'x64'].includes(manifest.target.arch), 'unsupported target');
  exactKeys(manifest.schema, ['min', 'max'], 'schema');
  requireCondition(Number.isSafeInteger(manifest.schema.min) && manifest.schema.min >= 0 && Number.isSafeInteger(manifest.schema.max) && manifest.schema.max >= manifest.schema.min, 'invalid schema range');
  requireCondition(canonicalize(manifest.runtime) === canonicalize({ status: 'unavailable', prerequisites: ['installed-service-bootstrap', 'installed-hub-worker-bootstrap', 'target-native-sqlite-runtime', 'native-host-acceptance'] }), 'unsupported runtime admission');
  requireCondition(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0 && manifest.artifacts.length <= RELEASE_LIMITS.files, 'invalid artifact count');
  validatePaths(manifest.artifacts.map(artifact => artifact.path));
  let total = 0;
  for (const artifact of manifest.artifacts) {
    exactKeys(artifact, ['path', 'sha256', 'bytes', 'mode'], 'artifact');
    requireCondition(digestPattern.test(artifact.sha256) && Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0 && artifact.bytes <= RELEASE_LIMITS.artifactBytes && ['100644', '100755'].includes(artifact.mode), 'invalid artifact metadata');
    requireCondition(!artifact.path.endsWith('.node'), 'native runtime artifacts require unavailable target-native packaging contract');
    total += artifact.bytes;
  }
  requireCondition(total <= RELEASE_LIMITS.totalBytes, 'oversized artifacts');
  requireCondition(Array.isArray(manifest.inputs), 'invalid inputs');
  const source = manifest.artifacts.filter(artifact => artifact.path.startsWith('source/'));
  requireCondition(manifest.inputs.length === source.length, 'input manifest mismatch');
  manifest.inputs.forEach((input, index) => {
    exactKeys(input, ['path', 'gitBlob', 'sha256', 'bytes', 'mode'], 'input');
    requireCondition(commitPattern.test(input.gitBlob) && canonicalize({ path: `source/${input.path}`, sha256: input.sha256, bytes: input.bytes, mode: input.mode }) === canonicalize(source[index]), 'source input mismatch');
  });
  requireCondition(manifest.sbom === 'metadata/sbom.json' && manifest.artifacts.some(artifact => artifact.path === manifest.sbom), 'missing SBOM');
  requireCondition(Array.isArray(manifest.evidence), 'invalid evidence references');
  validatePaths(manifest.evidence.map(reference => reference.path));
  const ids = new Set();
  for (const reference of manifest.evidence) {
    exactKeys(reference, ['id', 'path'], 'evidence');
    requireCondition(/^T\d{2}$/.test(reference.id) && !ids.has(reference.id) && reference.path === `evidence/${reference.id}.json` && manifest.artifacts.some(artifact => artifact.path === reference.path), 'invalid evidence reference');
    ids.add(reference.id);
  }
}
function verifyEvidence(manifest, files, required) {
  requireCondition(Array.isArray(required) && required.length > 0 && required.every(id => /^T\d{2}$/.test(id)) && new Set(required).size === required.length, 'missing required evidence policy');
  for (const id of required) {
    const reference = manifest.evidence.find(reference => reference.id === id);
    requireCondition(reference, `missing required evidence ${id}`);
    const report = JSON.parse(files.get(reference.path).toString('utf8'));
    requireCondition(report.task === id && canonicalize(report.versions) === canonicalize({ release: manifest.version, commit: manifest.commit, ...manifest.target }) && Array.isArray(report.scenarios) && report.scenarios.length > 0, 'evidence release binding mismatch');
    const ids = new Set();
    for (const scenario of report.scenarios) {
      requireCondition(typeof scenario.id === 'string' && scenario.id.length > 0 && !ids.has(scenario.id) && typeof scenario.command === 'string' && scenario.command.length > 0 && scenario.versions && typeof scenario.versions === 'object' && !Array.isArray(scenario.versions) && Object.keys(scenario.versions).length > 0 && scenario.status === 'passed' && scenario.exitCode === 0, 'required evidence not passed');
      ids.add(scenario.id);
      requireCondition(typeof scenario.evidenceFile === 'string' && scenario.evidenceFile.startsWith('evidence/') && files.has(scenario.evidenceFile) && digestPattern.test(scenario.evidenceSha256) && sha256(files.get(scenario.evidenceFile)) === scenario.evidenceSha256, 'evidence digest mismatch');
    }
  }
}
export async function verifyRelease(path, { policy, expected, readRoot }) {
  const bytes = await readRegularFile(path, RELEASE_LIMITS.packageBytes, admitReadRoot(readRoot));
  if (expected?.packageSha256 !== undefined) {
    requireCondition(digestPattern.test(expected.packageSha256) && sha256(bytes) === expected.packageSha256, 'package digest mismatch');
  }
  const bundle = parseCanonical(bytes);
  exactKeys(bundle, ['format', 'manifest', 'signatures', 'files'], 'envelope');
  requireCondition(bundle.format === 'patrick-release-envelope-v1', 'unsupported envelope');
  const manifest = bundle.manifest;
  validateManifest(manifest);
  requireCondition(expected && manifest.version === expected.version && manifest.commit === expected.commit && manifest.target.os === expected.os && manifest.target.arch === expected.arch && Number.isSafeInteger(expected.schema) && expected.schema >= manifest.schema.min && expected.schema <= manifest.schema.max, 'release expectation mismatch');

  requireCondition(policy && Array.isArray(policy.keys) && policy.keys.length > 0, 'missing pinned trust policy');
  const pinned = new Map();
  for (const key of policy.keys) {
    exactKeys(key, ['id', 'publicKey'], 'trust key');
    requireCondition(typeof key.id === 'string' && key.id.length > 0 && !pinned.has(key.id), 'ambiguous trust identity');
    const publicKey = createPublicKey(key.publicKey);
    requireCondition(publicKey.asymmetricKeyType === 'ed25519', 'unsupported trust key');
    pinned.set(key.id, publicKey);
  }
  requireCondition(Array.isArray(bundle.signatures) && bundle.signatures.length > 0 && bundle.signatures.length <= 16, 'missing release signature');
  const seenSigners = new Set();
  for (const signature of bundle.signatures) {
    exactKeys(signature, ['keyId', 'signature'], 'signature');
    requireCondition(pinned.has(signature.keyId) && !seenSigners.has(signature.keyId), 'unknown or duplicate trust identity');
    seenSigners.add(signature.keyId);
    requireCondition(typeof signature.signature === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(signature.signature) && verify(null, Buffer.from(canonicalize(manifest)), pinned.get(signature.keyId), Buffer.from(signature.signature, 'base64')), 'invalid release signature');
  }

  requireCondition(Array.isArray(bundle.files) && bundle.files.length === manifest.artifacts.length, 'artifact file count mismatch');
  validatePaths(bundle.files.map(file => file.path));
  const contents = new Map();
  bundle.files.forEach((file, index) => {
    exactKeys(file, ['path', 'content'], 'artifact file');
    requireCondition(typeof file.content === 'string', 'invalid artifact encoding');
    const content = Buffer.from(file.content, 'base64');
    const artifact = manifest.artifacts[index];
    requireCondition(content.toString('base64') === file.content && artifact.path === file.path && artifact.bytes === content.length && artifact.sha256 === sha256(content), 'artifact digest/length/path mismatch');
    contents.set(file.path, content);
  });
  for (const input of manifest.inputs) {
    const content = contents.get(`source/${input.path}`);
    requireCondition(createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex') === input.gitBlob, 'source git blob mismatch');
  }
  requireCondition(JSON.parse(contents.get('source/package.json').toString('utf8')).version === manifest.version, 'locked package version mismatch');
  const lockBytes = contents.get('source/package-lock.json');
  const lock = JSON.parse(lockBytes.toString('utf8'));
  const sbom = JSON.parse(contents.get(manifest.sbom).toString('utf8'));
  requireCondition(sbom.format === 'patrick-lock-sbom-v1' && sbom.commit === manifest.commit && sbom.lockSha256 === sha256(lockBytes) && canonicalize(sbom.packages) === canonicalize(lock.packages), 'SBOM lock mismatch');
  verifyEvidence(manifest, contents, policy.requiredEvidence);

  const receipt = Object.freeze({ status: 'verified-candidate', installable: false, sha256: sha256(bytes), manifestSha256: sha256(Buffer.from(canonicalize(manifest))), version: manifest.version, commit: manifest.commit, target: Object.freeze({ ...manifest.target }), runtime: Object.freeze({ status: 'unavailable', prerequisites: Object.freeze([...manifest.runtime.prerequisites]) }) });
  admitted.add(receipt);
  return receipt;
}
export function requireInstallableRelease(receipt) {
  requireCondition(receipt && admitted.has(receipt), 'unverified release receipt');
  throw new Error('runtime-unavailable: source candidate cannot be installed');
}
