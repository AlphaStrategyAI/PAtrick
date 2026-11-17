import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { checkDmgLock, snapshotDmg, verifyObsidianInstaller } from './dmg.mjs';
import { optionalStat, samePath } from './scope.mjs';

const runNative = promisify(execFile);
const bundleId = 'md.obsidian';
const applicationName = 'Obsidian.app';
// Apple Developer ID trust is independent of the download digest.
export const obsidianSigningRequirement =
  'anchor apple generic and identifier "md.obsidian" and certificate leaf[subject.OU] = "6JSW4SJWN9"';

const publishWithoutReplacement = `
  ObjC.import("Foundation");
  function run(argv) {
    if (argv.length !== 2 ||
        !$.NSFileManager.defaultManager.moveItemAtPathToPathError(argv[0], argv[1], null)) {
      throw new Error("Unable to publish bundle without replacing the destination");
    }
  }
`;

export function createMacObsidianInstaller(options = {}) {
  const platform = options.runCommand ? options.platform ?? process.platform : process.platform;
  const applicationRoot = options.runCommand ? options.applicationsDirectory ?? '/Applications' : '/Applications';
  const scratchRoot = options.scratchDirectory ?? tmpdir();
  const run = options.runCommand ?? ((command, argv) => runNative(command, argv, { timeout: 120_000, maxBuffer: 1024 * 1024 }));
  return {
    async install({ dmgPath, lock, authorizedDestination }) {
      if (platform !== 'darwin') throw new Error('OBSIDIAN_REQUIRES_MACOS');
      const destination = join(applicationRoot, applicationName);
      if (!isAbsolute(applicationRoot) || resolve(applicationRoot) !== applicationRoot ||
          authorizedDestination !== destination ||
          !samePath(await realpath(applicationRoot), applicationRoot)) throw new Error('OBSIDIAN_DESTINATION_UNAUTHORIZED');
      checkDmgLock(dmgPath, lock);
      if (await optionalStat(destination)) throw new Error('OBSIDIAN_DESTINATION_EXISTS');
      const scratch = await mkdtemp(join(await realpath(scratchRoot), 'patrick-obsidian-mount-'));
      let appStage;
      let mountUncertain = false;
      try {
        const image = join(scratch, 'verified.dmg');
        const mountpoint = join(scratch, 'mount');
        await snapshotDmg(dmgPath, image);
        const verified = await verifyObsidianInstaller(image, lock);
        await mkdir(mountpoint, { mode: 0o700 });
        const mountedBundle = join(mountpoint, applicationName);
        mountUncertain = true;
        let stageError;
        try {
          await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountpoint, image]);
          await verifyBundle(run, mountedBundle, verified.version);
          appStage = await mkdtemp(join(applicationRoot, '.patrick-obsidian-'));
          const stagedBundle = join(appStage, applicationName);
          await run('/usr/bin/ditto', [mountedBundle, stagedBundle]);
          await verifyBundle(run, stagedBundle, verified.version);
        } catch (error) {
          stageError = error;
        }
        try {
          await run('/usr/bin/hdiutil', ['detach', mountpoint]);
          mountUncertain = false;
        } catch (error) {
          // A mounted path must not be recursively removed after a failed detach.
          throw new AggregateError(stageError ? [stageError, error] : [error],
            `OBSIDIAN_MOUNT_CLEANUP_REQUIRED: ${mountpoint}`, { cause: error });
        }
        if (stageError) throw stageError;
        if (!appStage) throw new Error('OBSIDIAN_STAGE_MISSING');
        if (await optionalStat(destination)) throw new Error('OBSIDIAN_DESTINATION_EXISTS');
        await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', publishWithoutReplacement, '--', join(appStage, applicationName), destination]);
        await verifyBundle(run, destination, verified.version);
        return { status: 'installed', path: destination, version: verified.version, installerSha256: verified.sha256 };
      } finally {
        if (appStage) await rm(appStage, { recursive: true, force: true });
        if (!mountUncertain) await rm(scratch, { recursive: true, force: true });
      }
    },
  };
}

async function verifyBundle(run, path, version) {
  const plist = join(path, 'Contents', 'Info.plist');
  const binary = join(path, 'Contents', 'MacOS', 'Obsidian');
  if (!(await lstat(path)).isDirectory() || !samePath(await realpath(path), path) ||
      !(await lstat(plist)).isFile() || !samePath(await realpath(plist), plist) ||
      !(await lstat(binary)).isFile() || !samePath(await realpath(binary), binary)) throw new Error('OBSIDIAN_BUNDLE_UNSAFE');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', path]);
  await run('/usr/bin/codesign', ['--verify', '--strict', '-R', obsidianSigningRequirement, path]);
  const identity = await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist]);
  const release = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist]);
  const arch = await run('/usr/bin/file', ['-b', binary]);
  if (identity.stdout.trim() !== bundleId || release.stdout.trim() !== version ||
      !/universal binary/.test(arch.stdout) || !/\barm64\b/.test(arch.stdout) || !/\bx86_64\b/.test(arch.stdout)) {
    throw new Error('OBSIDIAN_BUNDLE_INCOMPATIBLE');
  }
}
