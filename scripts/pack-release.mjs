import { createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, opendir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { admitReadRoot, canonicalize, readRegularFile, RELEASE_LIMITS, sha256, validatePaths } from '../deploy/lib/release.mjs';

const execute = promisify(execFile);
const roots = ['package.json', 'package-lock.json', 'tsconfig.json', 'upstream.lock.json', 'design-inputs.lock.json', 'apps/', 'packages/', 'deploy/', 'scripts/'];

/**
 * The trust policy of a release key.
 *
 * The publisher pins the public key here and the installer verifies every
 * candidate against it, so a candidate signed by another key is refused.
 */
export function releaseTrustPolicy(privateKey, keyId, requiredEvidence = []) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(keyId)) throw new Error('invalid release key id');
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('release signing key must be ed25519');
  if (!Array.isArray(requiredEvidence) || requiredEvidence.length === 0
      || !requiredEvidence.every(id => /^T\d{2}$/.test(id)) || new Set(requiredEvidence).size !== requiredEvidence.length) {
    throw new Error('invalid required evidence policy');
  }
  return { keys: [{ id: keyId, publicKey: createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString() }],
    requiredEvidence };
}

export async function packRelease({ sourceRoot, commit, version, arch, schema, output, evidenceDirectory, signingKey, keyId }) {
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) || !['arm64', 'x64'].includes(arch) || !Number.isSafeInteger(schema?.min) || schema.min < 0 || !Number.isSafeInteger(schema?.max) || schema.max < schema.min) throw new Error('invalid candidate commit/version/target/schema');
  const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  gitEnvironment.GIT_NO_REPLACE_OBJECTS = '1';
  const git = async (...args) => (await execute('git', ['--no-replace-objects', '-C', resolve(sourceRoot), ...args], { env: gitEnvironment, encoding: 'buffer', maxBuffer: RELEASE_LIMITS.totalBytes })).stdout;
  if ((await git('rev-parse', '--verify', `${commit}^{commit}`)).toString().trim() !== commit) throw new Error('source commit mismatch');
  const tree = (await git('ls-tree', '-rz', '--full-tree', commit)).toString('utf8').split('\0').filter(Boolean);
  const entries = tree.map(line => {
    const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(line);
    if (!match) throw new Error('invalid git tree');
    return { mode: match[1], type: match[2], gitBlob: match[3], path: match[4] };
  }).filter(entry => roots.some(root => root.endsWith('/') ? entry.path.startsWith(root) : entry.path === root)).sort((a, b) => a.path < b.path ? -1 : 1);
  validatePaths(entries.map(entry => entry.path));
  const files = [];
  const artifacts = [];
  const inputs = [];
  let total = 0;
  function add(path, bytes, mode = '100644') {
    total += bytes.length;
    if (bytes.length > RELEASE_LIMITS.artifactBytes || total > RELEASE_LIMITS.totalBytes || files.length >= RELEASE_LIMITS.files) throw new Error('candidate size limit');
    files.push({ path, content: bytes.toString('base64') });
    artifacts.push({ path, bytes: bytes.length, sha256: sha256(bytes), mode });
  }
  for (const entry of entries) {
    if (!['100644', '100755'].includes(entry.mode) || entry.type !== 'blob') throw new Error('symlink or unsupported source mode');
    if (entry.path.split('/').some(part => ['node_modules', 'dist', '.git'].includes(part)) || entry.path.endsWith('.node')) throw new Error('unavailable target-native runtime input');
    const size = Number((await git('cat-file', '-s', entry.gitBlob)).toString().trim());
    if (!Number.isSafeInteger(size) || size > RELEASE_LIMITS.artifactBytes || total + size > RELEASE_LIMITS.totalBytes) throw new Error('candidate size limit');
    const bytes = await git('cat-file', 'blob', entry.gitBlob);
    add(`source/${entry.path}`, bytes, entry.mode);
    inputs.push({ path: entry.path, gitBlob: entry.gitBlob, bytes: bytes.length, sha256: sha256(bytes), mode: entry.mode });
  }
  for (const required of ['package.json', 'package-lock.json', 'deploy/lima/executor.yaml']) if (!inputs.some(input => input.path === required)) throw new Error(`missing locked input ${required}`);
  const packageFile = files.find(file => file.path === 'source/package.json');
  if (JSON.parse(Buffer.from(packageFile.content, 'base64').toString('utf8')).version !== version) throw new Error('locked package version mismatch');
  const lockFile = files.find(file => file.path === 'source/package-lock.json');
  const lockBytes = Buffer.from(lockFile.content, 'base64');
  const lock = JSON.parse(lockBytes.toString('utf8'));
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') throw new Error('unsupported dependency lock');
  add('metadata/sbom.json', Buffer.from(canonicalize({ format: 'patrick-lock-sbom-v1', commit, lockSha256: sha256(lockBytes), packages: lock.packages })));
  const evidence = [];
  const evidenceRoot = evidenceDirectory ? admitReadRoot(resolve(evidenceDirectory)) : undefined;
  let evidenceEntries = 1; // The selected evidence root also consumes one entry.
  async function collect(directory, prefix, depth = 0) {
    if (depth > RELEASE_LIMITS.evidenceDepth) throw new Error('evidence depth limit');
    const directoryRoot = admitReadRoot(resolve(directory));
    const validateDirectory = () => { evidenceRoot.validate(); directoryRoot.validate(); };
    validateDirectory();
    const children = [];
    const handle = await opendir(directory, { bufferSize: 32 });
    try {
      validateDirectory();
      while (true) {
        const child = await handle.read();
        validateDirectory();
        if (!child) break;
        evidenceEntries += 1;
        if (evidenceEntries > RELEASE_LIMITS.evidenceEntries) throw new Error('evidence entry limit');
        validatePaths([`${prefix}/${child.name}`]);
        children.push(child.name);
      }
    } finally { await handle.close(); }
    validateDirectory();
    for (const child of children.sort()) {
      const path = `${prefix}/${child}`;
      validatePaths([path]);
      const absolute = join(directory, child);
      const info = await lstat(absolute);
      validateDirectory();
      if (info.isSymbolicLink()) throw new Error('symlink evidence input');
      if (info.isDirectory()) await collect(absolute, path, depth + 1);
      else {
        if (!info.isFile()) throw new Error('special evidence input requires regular file');
        add(path, await readRegularFile(absolute, RELEASE_LIMITS.artifactBytes, evidenceRoot));
        if (/^evidence\/T\d{2}\.json$/.test(path)) evidence.push({ id: child.slice(0, -5), path });
      }
    }
    validateDirectory();
  }
  if (evidenceDirectory) {
    await collect(evidenceDirectory, 'evidence');
    evidenceRoot.validate();
  }
  files.sort((a, b) => a.path < b.path ? -1 : 1);
  artifacts.sort((a, b) => a.path < b.path ? -1 : 1);
  evidence.sort((a, b) => a.path < b.path ? -1 : 1);
  validatePaths(files.map(file => file.path));
  const manifest = { format: 'patrick-release-manifest-v1', version, commit, target: { os: 'darwin', arch }, schema, kind: 'source-candidate', runtime: { status: 'unavailable', prerequisites: ['installed-service-bootstrap', 'installed-hub-worker-bootstrap', 'target-native-sqlite-runtime', 'native-host-acceptance'] }, inputs, artifacts, sbom: 'metadata/sbom.json', evidence };
  const signatures = [];
  if (signingKey) {
    const key = typeof signingKey === 'string' ? createPrivateKey(signingKey) : signingKey;
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('release signing key must be ed25519');
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(keyId ?? '')) throw new Error('invalid release key id');
    signatures.push({ keyId, signature: sign(null, Buffer.from(canonicalize(manifest)), key).toString('base64') });
  }
  const bytes = Buffer.from(canonicalize({ format: 'patrick-release-envelope-v1', manifest, signatures, files }));
  if (bytes.length > RELEASE_LIMITS.packageBytes) throw new Error('candidate package size limit');
  await mkdir(dirname(resolve(output)), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, output);
  } finally { await rm(temporary, { force: true }); }
  return Object.freeze({ status: signatures.length > 0 ? 'signed-candidate' : 'unsigned-candidate', installable: false,
    keyId: signatures[0]?.keyId ?? null, sha256: sha256(bytes), bytes: bytes.length,
    manifestSha256: sha256(Buffer.from(canonicalize(manifest))), runtime: manifest.runtime });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const flagNames = ['--sign', '--key-id', '--policy', '--required-evidence'];
  const flag = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const positional = args.filter((value, index) => !value.startsWith('--')
    && !(args[index - 1] && flagNames.includes(args[index - 1])));
  const [sourceRoot, commit, version, arch, min, max, output, evidenceDirectory] = positional;
  if (!output) throw new Error('usage: pack-release.mjs source-root full-commit version arm64|x64 schema-min schema-max output [evidence-directory]');
  const signingKey = flag('--sign');
  const keyId = flag('--key-id');
  const policyOutput = flag('--policy');
  const requiredEvidence = (flag('--required-evidence') ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const key = signingKey ? await readFile(resolve(signingKey), 'utf8') : undefined;
  const receipt = await packRelease({ sourceRoot, commit, version, arch, schema: { min: Number(min), max: Number(max) }, output,
    evidenceDirectory, signingKey: key, keyId });
  if (key && policyOutput) {
    await writeFile(policyOutput, canonicalize(releaseTrustPolicy(key, keyId, requiredEvidence)), { mode: 0o600 });
  }
  console.log(JSON.stringify(receipt));
}
