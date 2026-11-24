import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { verifyEmittedRuntimeCandidate } from '../deploy/lib/emitted-release.mjs';
import { admitReadRoot, canonicalize, readRegularFile, RELEASE_LIMITS } from '../deploy/lib/release.mjs';

const architectures = ['arm64', 'x64'];
const usage = 'usage: node scripts/verify-signed-darwin-assets.mjs <trusted-pins.json> <arm64-envelope> <x64-envelope>';

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function readInput(input, limit) {
  const path = resolve(input);
  return readRegularFile(path, limit, admitReadRoot(dirname(path)));
}

export async function verifySignedDarwinAssets(pinsPath, arm64Path, x64Path) {
  const assets = [arm64Path, x64Path];
  const pins = JSON.parse(await readInput(pinsPath, RELEASE_LIMITS.artifactBytes));
  requireCondition(pins && Object.keys(pins).length === architectures.length &&
    architectures.every(arch => Object.hasOwn(pins, arch)), 'expected deployment pins for exactly arm64 and x64');
  for (const arch of architectures) {
    const { expected, policy } = pins[arch] ?? {};
    requireCondition(expected?.profile === 'deployment-complete' && expected.target?.os === 'darwin' &&
      expected.target.arch === arch && expected.source?.kind === 'commit' && policy, `invalid ${arch} deployment pins`);
  }
  const { source, version, schema } = pins.arm64.expected;
  requireCondition(version === pins.x64.expected.version &&
    canonicalize(source) === canonicalize(pins.x64.expected.source) &&
    canonicalize(schema) === canonicalize(pins.x64.expected.schema), 'both deployment pins must describe one release');

  const directory = await mkdtemp(join(await realpath(tmpdir()), 'patrick-signed-assets-'));
  const staging = { withExclusiveReadRoot: read => read(directory) };
  const receipts = {};
  try {
    for (const [index, arch] of architectures.entries()) {
      try {
        const data = await readInput(assets[index], RELEASE_LIMITS.packageBytes);
        const staged = join(directory, arch + '.json');
        await writeFile(staged, data, { flag: 'wx', mode: 0o400 });
        const { expected, policy } = pins[arch];
        const checked = await verifyEmittedRuntimeCandidate(staged, { staging, expected, policy });
        const { packageSha256, manifestSha256, materialSha256, inventorySha256, nativeSha256 } = checked;
        receipts[arch] = { packageSha256, manifestSha256, materialSha256, inventorySha256, nativeSha256 };
      } catch (error) {
        throw new Error(`${arch}: ${error.message}`, { cause: error });
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return { status: 'verified-signed-darwin-assets', commit: source.commit, version, assets: receipts };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    requireCondition(args.length === 3 && args.every(arg => arg && !arg.startsWith('-')), usage);
    console.log(JSON.stringify(await verifySignedDarwinAssets(...args), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
