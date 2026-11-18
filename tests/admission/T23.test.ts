import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, renameSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalize, verifyRelease, requireInstallableRelease, readRegularFile, admitReadRoot } from '../../deploy/lib/release.mjs';

const temporary: string[] = [];
async function packRelease(options: { sourceRoot: string; commit: string; version: string; arch: string; schema: { min: number; max: number }; output: string; evidenceDirectory?: string }, timeout = 3000) {
  execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/pack-release.mjs', import.meta.url)), options.sourceRoot, options.commit, options.version, options.arch, String(options.schema.min), String(options.schema.max), options.output, ...(options.evidenceDirectory ? [options.evidenceDirectory] : [])], { stdio: 'pipe', timeout, env: { ...process.env } });
}
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'patrick-t23-'));
  temporary.push(root);
  const source = join(root, 'source');
  mkdirSync(join(source, 'deploy/lima'), { recursive: true });
  writeFileSync(join(source, 'package.json'), '{"name":"fixture","version":"1.2.3"}\n');
  writeFileSync(join(source, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
  writeFileSync(join(source, 'deploy/lima/executor.yaml'), 'arch: default\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  const commit = git('rev-parse', 'HEAD');
  const evidence = join(root, 'evidence');
  mkdirSync(evidence);
  writeFileSync(join(evidence, 'probe.txt'), 'fixture acceptance only\n');
  writeFileSync(join(evidence, 'T25.json'), JSON.stringify({ task: 'T25', versions: { release: '1.2.3', commit, os: 'darwin', arch: 'arm64' }, scenarios: [{ id: 'fixture', command: 'fixture probe', exitCode: 0, versions: { fixture: '1' }, status: 'passed', evidenceFile: 'evidence/probe.txt', evidenceSha256: hash(readFileSync(join(evidence, 'probe.txt'))) }] }));
  const output = join(root, 'candidate.json');
  const options = { sourceRoot: source, commit, version: '1.2.3', arch: 'arm64', schema: { min: 1, max: 2 }, evidenceDirectory: evidence, output };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const policy = { keys: [{ id: 'fixture', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }], requiredEvidence: ['T25'] };
  const expected = { version: '1.2.3', commit, os: 'darwin', arch: 'arm64', schema: 2 };
  return { root, source, output, options, privateKey, policy, expected };
}
function signed(f: ReturnType<typeof fixture>) {
  const bundle = JSON.parse(readFileSync(f.output, 'utf8'));
  bundle.signatures = [{ keyId: 'fixture', signature: sign(null, Buffer.from(canonicalize(bundle.manifest)), f.privateKey).toString('base64') }];
  writeFileSync(f.output, canonicalize(bundle));
  return bundle;
}

describe('T23 finite release candidates', () => {
  it('round trips deterministic real files and retains unavailable runtime admission', async () => {
    const f = fixture();
    await packRelease(f.options);
    expect(existsSync(f.output)).toBe(true);
    const first = readFileSync(f.output);
    await packRelease(f.options);
    expect(readFileSync(f.output).equals(first)).toBe(true);
    const bundle = signed(f);
    expect(bundle.manifest.artifacts.filter((a: { path: string }) => a.path === 'source/deploy/lima/executor.yaml')).toHaveLength(1);
    const verified = await verifyRelease(f.output, { readRoot: f.root, policy: f.policy, expected: f.expected });
    expect(verified.status).toBe('verified-candidate');
    expect(verified.installable).toBe(false);
    expect(() => requireInstallableRelease(verified)).toThrow(/runtime-unavailable/);
    expect(() => requireInstallableRelease({ installable: true })).toThrow(/unverified/);
  });
  it('rejects unsigned, untrusted and substituted candidate bytes', async () => {
    const f = fixture();
    await packRelease(f.options);
    await expect(verifyRelease(f.output, { readRoot: f.root, policy: f.policy, expected: f.expected })).rejects.toThrow(/signature/);
    const bundle = signed(f);
    await expect(verifyRelease(f.output, { readRoot: f.root, policy: { ...f.policy, keys: [] }, expected: f.expected })).rejects.toThrow(/trust/);
    await expect(verifyRelease(f.output, { readRoot: f.root, policy: { ...f.policy, keys: [{ ...f.policy.keys[0], id: 'different-identity' }] }, expected: f.expected })).rejects.toThrow(/trust/);
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await expect(verifyRelease(f.output, { readRoot: f.root, policy: { ...f.policy, keys: [{ id: 'fixture', publicKey: other }] }, expected: f.expected })).rejects.toThrow(/signature/);
    bundle.files[0].content = Buffer.from('substitution').toString('base64');
    writeFileSync(f.output, canonicalize(bundle));
    await expect(verifyRelease(f.output, { readRoot: f.root, policy: f.policy, expected: f.expected })).rejects.toThrow(/artifact/);
  });
  it.each([{ os: 'linux' }, { arch: 'x64' }, { schema: 3 }, { version: '9.0.0' }, { commit: '0'.repeat(40) }])('rejects expectation mismatch %j', async mismatch => {
    const f = fixture(); await packRelease(f.options); signed(f);
    await expect(verifyRelease(f.output, { readRoot: f.root, policy: f.policy, expected: { ...f.expected, ...mismatch } })).rejects.toThrow(/mismatch/);
  });
  it('requires independently selected passed acceptance evidence', async () => {
    const f = fixture(); await packRelease(f.options); signed(f);
    await expect(verifyRelease(f.output, { readRoot: f.root, policy: { ...f.policy, requiredEvidence: ['T26'] }, expected: f.expected })).rejects.toThrow(/evidence/);
    const report = JSON.parse(readFileSync(join(f.options.evidenceDirectory, 'T25.json'), 'utf8'));
    report.scenarios[0].status = 'pending';
    writeFileSync(join(f.options.evidenceDirectory, 'T25.json'), JSON.stringify(report));
    await packRelease(f.options); signed(f);
    await expect(verifyRelease(f.output, { readRoot: f.root, policy: f.policy, expected: f.expected })).rejects.toThrow(/evidence/);
  });
  it.each(['../escape', '/absolute', 'source/../escape', 'source\\escape', 'SOURCE/package.json'])('rejects unsafe or ambiguous path %s', async path => {
    const f = fixture(); await packRelease(f.options);
    const bundle = signed(f);
    bundle.files[0].path = path;
    writeFileSync(f.output, canonicalize(bundle));
    await expect(verifyRelease(f.output, { readRoot: f.root, policy: f.policy, expected: f.expected })).rejects.toThrow(/path|artifact/);
  });
  it('rejects duplicate and extra files and symlink inputs without installation effects', async () => {
    const f = fixture(); await packRelease(f.options);
    const bundle = signed(f);
    bundle.files[1].path = bundle.files[0].path;
    writeFileSync(f.output, canonicalize(bundle));
    await expect(verifyRelease(f.output, { readRoot: f.root, policy: f.policy, expected: f.expected })).rejects.toThrow(/path|artifact/);
    symlinkSync('/etc/hosts', join(f.options.evidenceDirectory, 'link'));
    await expect(packRelease(f.options)).rejects.toThrow(/symlink/);
    expect(readFileSync(join(f.source, 'package.json'), 'utf8')).toContain('fixture');
  });
  it('rejects altered signed metadata and candidate-supplied signer keys', async () => {
    const f = fixture(); await packRelease(f.options);
    const bundle = signed(f);
    bundle.manifest.schema.max = 3;
    writeFileSync(f.output, canonicalize(bundle));
    await expect(verifyRelease(f.output, { readRoot: f.root, policy: f.policy, expected: f.expected })).rejects.toThrow(/signature/);
    bundle.signatures[0].publicKey = f.policy.keys[0].publicKey;
    writeFileSync(f.output, canonicalize(bundle));
    await expect(verifyRelease(f.output, { readRoot: f.root, policy: f.policy, expected: f.expected })).rejects.toThrow(/signature/);
  });
  it('rejects missing files, noncanonical encodings and symlink candidates', async () => {
    const f = fixture(); await packRelease(f.options);
    const bundle = signed(f);
    bundle.files.pop();
    writeFileSync(f.output, canonicalize(bundle));
    await expect(verifyRelease(f.output, { readRoot: f.root, policy: f.policy, expected: f.expected })).rejects.toThrow(/artifact/);
    await packRelease(f.options); signed(f);
    writeFileSync(f.output, readFileSync(f.output, 'utf8') + '\n');
    await expect(verifyRelease(f.output, { readRoot: f.root, policy: f.policy, expected: f.expected })).rejects.toThrow(/noncanonical/);
    const link = join(f.root, 'candidate-link'); symlinkSync(f.output, link);
    await expect(verifyRelease(link, { readRoot: f.root, policy: f.policy, expected: f.expected })).rejects.toThrow();
  });
  it('rejects evidence for a different commit or corrupted evidence attachment', async () => {
    const f = fixture();
    const path = join(f.options.evidenceDirectory, 'T25.json');
    const report = JSON.parse(readFileSync(path, 'utf8'));
    report.versions.commit = '0'.repeat(40);
    writeFileSync(path, JSON.stringify(report));
    await packRelease(f.options); signed(f);
    await expect(verifyRelease(f.output, { readRoot: f.root, policy: f.policy, expected: f.expected })).rejects.toThrow(/evidence/);
    report.versions.commit = f.expected.commit;
    writeFileSync(path, JSON.stringify(report));
    writeFileSync(join(f.options.evidenceDirectory, 'probe.txt'), 'changed');
    await packRelease(f.options); signed(f);
    await expect(verifyRelease(f.output, { readRoot: f.root, policy: f.policy, expected: f.expected })).rejects.toThrow(/evidence/);
  });
  it('binds release version to locked package version and ignores dirty worktree bytes', async () => {
    const f = fixture();
    await expect(packRelease({ ...f.options, version: '9.9.9' })).rejects.toThrow(/version/);
    await packRelease(f.options); const original = readFileSync(f.output);
    writeFileSync(join(f.source, 'package.json'), 'dirty content');
    await packRelease(f.options);
    expect(readFileSync(f.output).equals(original)).toBe(true);
  });

  it('refuses cross-target native binaries and source symlinks in the locked tree', async () => {
    const f = fixture();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.source, stdio: 'pipe' }).toString().trim();
    writeFileSync(join(f.source, 'packages.node'), 'untrusted native bytes');
    mkdirSync(join(f.source, 'packages/native'), { recursive: true });
    writeFileSync(join(f.source, 'packages/native/sqlite.node'), 'untrusted native bytes');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'native fixture');
    await expect(packRelease({ ...f.options, commit: git('rev-parse', 'HEAD') })).rejects.toThrow(/target-native/);
    rmSync(join(f.source, 'packages/native/sqlite.node'));
    symlinkSync('/etc/hosts', join(f.source, 'packages/native/link'));
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'symlink fixture');
    await expect(packRelease({ ...f.options, commit: git('rev-parse', 'HEAD') })).rejects.toThrow(/symlink/);
  });
  it('produces a distinct x64 candidate with exact target-bound fixture evidence', async () => {
    const f = fixture(); await packRelease(f.options);
    const arm = hash(readFileSync(f.output));
    const path = join(f.options.evidenceDirectory, 'T25.json');
    const report = JSON.parse(readFileSync(path, 'utf8')); report.versions.arch = 'x64';
    writeFileSync(path, JSON.stringify(report));
    await packRelease({ ...f.options, arch: 'x64' }); signed(f);
    const verified = await verifyRelease(f.output, { readRoot: f.root, policy: f.policy, expected: { ...f.expected, arch: 'x64' } });
    expect(verified.target.arch).toBe('x64');
    expect(verified.sha256).not.toBe(arm);
  });

  it('binds the exact accepted package digest when supplied by publication policy', async () => {
    const f = fixture(); await packRelease(f.options); signed(f);
    await expect(verifyRelease(f.output, { readRoot: f.root, policy: f.policy, expected: { ...f.expected, packageSha256: '0'.repeat(64) } })).rejects.toThrow(/package digest mismatch/);
    const verified = await verifyRelease(f.output, { readRoot: f.root, policy: f.policy, expected: { ...f.expected, packageSha256: hash(readFileSync(f.output)) } });
    expect(verified.sha256).toBe(hash(readFileSync(f.output)));
  });

  it('refuses malformed acceptance scenario version metadata', async () => {
    const f = fixture();
    const path = join(f.options.evidenceDirectory, 'T25.json');
    const report = JSON.parse(readFileSync(path, 'utf8')); report.scenarios[0].versions = ['fixture'];
    writeFileSync(path, JSON.stringify(report));
    await packRelease(f.options); signed(f);
    await expect(verifyRelease(f.output, { readRoot: f.root, policy: f.policy, expected: f.expected })).rejects.toThrow(/evidence/);
  });

  it('keeps the explicit commit tree when replacement refs are present', async () => {
    const f = fixture();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.source, encoding: 'utf8' }).trim();
    writeFileSync(join(f.source, 'deploy/lima/executor.yaml'), 'replacement tree');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'replacement');
    git('replace', f.options.commit, git('rev-parse', 'HEAD'));
    await packRelease(f.options);
    const bundle = JSON.parse(readFileSync(f.output, 'utf8'));
    expect(Buffer.from(bundle.files.find((file: { path: string }) => file.path === 'source/deploy/lima/executor.yaml').content, 'base64').toString()).toBe('arch: default\n');
  });
  it('ignores inherited repository redirection', async () => {
    const f = fixture(); const other = fixture();
    const originalBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: other.source, encoding: 'utf8' }).trim();
    execFileSync('git', ['checkout', '--orphan', 'other'], { cwd: other.source, stdio: 'pipe' });
    writeFileSync(join(other.source, 'package.json'), '{"name":"other","version":"1.2.3"}');
    execFileSync('git', ['add', '.'], { cwd: other.source });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'other'], { cwd: other.source });
    execFileSync('git', ['branch', '-D', originalBranch], { cwd: other.source, stdio: 'pipe' });
    execFileSync('git', ['reflog', 'expire', '--expire=now', '--all'], { cwd: other.source });
    execFileSync('git', ['prune', '--expire=now'], { cwd: other.source });
    const old = process.env.GIT_DIR;
    process.env.GIT_DIR = join(other.source, '.git');
    try { await packRelease(f.options); }
    finally { if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old; }
    expect(JSON.parse(readFileSync(f.output, 'utf8')).manifest.commit).toBe(f.options.commit);
  });
  it('promptly refuses FIFO candidates and evidence in bounded child processes', async () => {
    const f = fixture();
    const fifo = join(f.root, 'fifo');
    execFileSync('mkfifo', [fifo]);
    const moduleUrl = new URL('../../deploy/lib/release.mjs', import.meta.url).href;
    const probe = execFileSync(process.execPath, ['--input-type=module', '-e', `import { verifyRelease } from ${JSON.stringify(moduleUrl)}; try { await verifyRelease(${JSON.stringify(fifo)}, {readRoot:${JSON.stringify(f.root)}}); process.exit(2); } catch { process.exit(0); }`], { timeout: 1500 });
    expect(probe.length).toBe(0);
  });
  it('promptly refuses FIFO evidence in a bounded child process', async () => {
    const f = fixture();
    execFileSync('mkfifo', [join(f.options.evidenceDirectory, 'fifo')]);
    await expect(packRelease(f.options)).rejects.toThrow(/regular|special/);
  });
  it('refuses symlinked candidate and evidence ancestors', async () => {
    const f = fixture(); await packRelease(f.options); signed(f);
    const alias = join(f.root, 'alias'); symlinkSync(f.root, alias);
    await expect(verifyRelease(join(alias, 'candidate.json'), { readRoot: f.root, policy: f.policy, expected: f.expected })).rejects.toThrow(/symlink|ancestor/);
    await expect(packRelease({ ...f.options, evidenceDirectory: join(alias, 'evidence') })).rejects.toThrow(/symlink|ancestor/);
  });
  it('refuses a directory swapped after read admission even with the same leaf inode', async () => {
    const f = fixture(); await packRelease(f.options);
    const pending = readRegularFile(f.output, undefined, admitReadRoot(f.root));
    renameSync(f.root, f.root + '-moved');
    temporary.push(f.root + '-moved');
    symlinkSync(f.root + '-moved', f.root);
    await expect(pending).rejects.toThrow(/changed|symlink|ancestor/);
  });

  it('enforces approved physical root containment and root identity', async () => {
    const f = fixture(); await packRelease(f.options); signed(f);
    await expect(verifyRelease(f.output, { policy: f.policy, expected: f.expected, readRoot: f.options.evidenceDirectory })).rejects.toThrow(/outside/);
    const admission = admitReadRoot(f.root);
    const moved = f.root + '-root-moved';
    renameSync(f.root, moved); temporary.push(moved); mkdirSync(f.root);
    writeFileSync(join(f.root, 'candidate.json'), 'replacement');
    await expect(readRegularFile(f.output, undefined, admission)).rejects.toThrow(/changed/);
  });
  it('rejects device inputs before reading', async () => {
    await expect(readRegularFile('/dev/null', undefined, admitReadRoot('/dev'))).rejects.toThrow(/regular/);
  });

  it('refuses leaf replacement between admission and open', async () => {
    const f = fixture(); await packRelease(f.options);
    const pending = readRegularFile(f.output, undefined, admitReadRoot(f.root));
    renameSync(f.output, f.output + '.original');
    writeFileSync(f.output, 'replacement');
    await expect(pending).rejects.toThrow(/changed/);
  });
  it('refuses evidence directory replacement at the directory-open boundary', async () => {
    const f = fixture();
    const packer = new URL('../../scripts/pack-release.mjs', import.meta.url).href;
    const script = `import fs from 'node:fs';
      const directory = ${JSON.stringify(f.options.evidenceDirectory)};
      const original = fs.promises.opendir;
      fs.promises.opendir = async (...args) => {
        const handle = await original(...args);
        if (args[0] === directory) {
          fs.renameSync(directory, directory + '-moved');
          fs.symlinkSync(directory + '-moved', directory);
        }
        return handle;
      };
      const { packRelease } = await import(${JSON.stringify(packer)});
      try { await packRelease(${JSON.stringify(f.options)}); process.exit(2); }
      catch (error) { if (!/changed|symlink|ancestor/.test(error.message)) throw error; }
    `;
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 3000 }).length).toBe(0);
  });

  it('bounds a wide evidence root containing only empty directories', async () => {
    const f = fixture();
    for (let index = 0; index < 10001; index++) mkdirSync(join(f.options.evidenceDirectory, `empty-${index}`));
    await expect(packRelease(f.options, 15000)).rejects.toThrow(/evidence entry limit/);
    expect(existsSync(f.output)).toBe(false);
  }, 20000);
  it('bounds evidence entries globally across multiple directories', async () => {
    const f = fixture();
    for (let parent = 0; parent < 101; parent++) {
      const directory = join(f.options.evidenceDirectory, `group-${parent}`); mkdirSync(directory);
      for (let child = 0; child < 100; child++) mkdirSync(join(directory, `empty-${child}`));
    }
    await expect(packRelease(f.options, 15000)).rejects.toThrow(/evidence entry limit/);
    expect(existsSync(f.output)).toBe(false);
  }, 20000);
  it('bounds evidence directory depth independently of entry count', async () => {
    const f = fixture(); let directory = f.options.evidenceDirectory;
    for (let depth = 0; depth < 65; depth++) { directory = join(directory, 'd'); mkdirSync(directory); }
    await expect(packRelease(f.options)).rejects.toThrow(/evidence depth limit/);
    expect(existsSync(f.output)).toBe(false);
  });

});
