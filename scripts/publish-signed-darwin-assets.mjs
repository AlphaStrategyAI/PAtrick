import { spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySignedDarwinAssets } from './verify-signed-darwin-assets.mjs';

const assetNames = ['patrick-darwin-arm64.signed.json', 'patrick-darwin-x64.signed.json'];
const evidenceChecker = fileURLToPath(new URL('./check-release-evidence.mjs', import.meta.url));
const commitPattern = /^[0-9a-f]{40}$/;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function command(binary, args, output) {
  const stdout = output === undefined ? 'pipe' : openSync(output, 'wx', 0o600);
  try {
    const result = spawnSync(binary, args, { encoding: 'utf8', stdio: ['ignore', stdout, 'pipe'], maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    requireCondition(result.status === 0, result.stderr.trim() || `${binary} exited with status ${result.status}`);
    return result.stdout ?? '';
  } finally {
    if (output !== undefined) closeSync(stdout);
  }
}

export async function promoteDarwinRelease({ repo, pinFile, artifactRoot }, github = (args, output) => command('gh', args, output)) {
  requireCondition(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? ''), 'GitHub repository is required');
  const root = resolve(artifactRoot);
  const paths = assetNames.map(name => join(root, name));
  const accepted = await verifySignedDarwinAssets(pinFile, ...paths);
  const { commit, version } = accepted;
  command(process.execPath, [evidenceChecker, '--require-complete', commit, join(root, 'release-evidence')]);
  const sizes = await Promise.all(paths.map(async path => (await stat(path)).size));
  const tag = `v${version}`;
  const endpoint = `repos/${repo}`;

  async function get(path, ...flags) {
    return JSON.parse(await github(['api', '--method=GET', endpoint + path, ...flags]));
  }

  async function checkTag(required = false) {
    const ref = `refs/tags/${tag}`;
    const matches = await get(`/git/matching-refs/tags/${tag}`);
    let object = matches.find(candidate => candidate.ref === ref)?.object;
    if (!object) {
      requireCondition(!required, 'published release tag is missing');
      return;
    }
    for (let depth = 0; object.type === 'tag' && depth < 8; depth++) {
      requireCondition(commitPattern.test(object.sha), 'invalid annotated tag');
      ({ object } = await get(`/git/tags/${object.sha}`));
    }
    requireCondition(object.type === 'commit' && object.sha === commit, 'release tag points to a different commit');
  }

  async function readRelease() {
    const pages = await get('/releases?per_page=100', '--paginate', '--slurp');
    const matches = pages.flat().filter(release => release.tag_name === tag);
    requireCondition(matches.length <= 1, 'multiple releases match the version tag');
    const release = matches[0];
    if (!release) return undefined;
    requireCondition(Number.isSafeInteger(release.id) && release.id > 0 && typeof release.draft === 'boolean' &&
      Array.isArray(release.assets) && (!release.draft || release.target_commitish === commit), 'release identity differs from the accepted candidate');
    const uploaded = new Map();
    for (const asset of release.assets) {
      const index = assetNames.indexOf(asset.name);
      requireCondition(index >= 0 && !uploaded.has(asset.name) && asset.state === 'uploaded' &&
        asset.size === sizes[index] && Number.isSafeInteger(asset.id) && asset.id > 0, 'release contains an unexpected asset');
      uploaded.set(asset.name, asset.id);
    }
    return { id: release.id, draft: release.draft, uploaded };
  }

  async function readback(release, phase) {
    requireCondition(release?.uploaded.size === assetNames.length, `${phase} is missing accepted assets`);
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'patrick-darwin-readback-'));
    try {
      const downloaded = assetNames.map(name => join(directory, name));
      for (const [index, name] of assetNames.entries()) {
        await github(['api', '--method=GET', `${endpoint}/releases/assets/${release.uploaded.get(name)}`,
          '-H', 'Accept: application/octet-stream'], downloaded[index]);
      }
      return await verifySignedDarwinAssets(pinFile, ...downloaded);
    } catch (error) {
      throw new Error(`${phase}: ${error.message}`, { cause: error });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  await checkTag();
  let release = await readRelease();
  if (!release) {
    await github(['release', 'create', tag, '--repo', repo, '--draft', '--target', commit,
      '--title', `PAtrick ${version}`, '--notes', 'Accepted PAtrick macOS deployment packages.',
      ...(version.includes('-') ? ['--prerelease'] : [])]);
    release = await readRelease();
    requireCondition(release?.draft, 'draft release could not be read back');
  }
  if (release.draft) {
    const missing = paths.filter((_path, index) => !release.uploaded.has(assetNames[index]));
    if (missing.length) {
      await github(['release', 'upload', tag, ...missing, '--repo', repo]);
    }
    const draft = await readRelease();
    requireCondition(draft?.id === release.id && draft.draft, 'draft release changed during upload');
    await readback(draft, 'draft readback');
    const current = await readRelease();
    requireCondition(current?.id === draft.id && current.draft &&
      assetNames.every(name => current.uploaded.get(name) === draft.uploaded.get(name)), 'draft release changed after verification');
    await checkTag();
    await github(['api', '--method=PATCH', `${endpoint}/releases/${draft.id}`, '-F', 'draft=false']);
  }

  const published = await readRelease();
  requireCondition(published?.id === release.id && !published.draft, 'published release could not be read back');
  await checkTag(true);
  const verified = await readback(published, 'published readback');
  return { ...verified, status: 'published', tag, releaseId: published.id };
}

if (import.meta.main) {
  try {
    const [repo, pinFile, artifactRoot, ...rest] = process.argv.slice(2);
    requireCondition(repo && pinFile && artifactRoot && rest.length === 0,
      'usage: node scripts/publish-signed-darwin-assets.mjs <owner/repo> <trusted-pins.json> <promotion-artifact-dir>');
    console.log(JSON.stringify(await promoteDarwinRelease({ repo, pinFile, artifactRoot }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
