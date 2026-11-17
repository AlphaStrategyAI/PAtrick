import { execFile } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { readMacObsidianState } from './doctor.mjs';

const exec = promisify(execFile);
const options = { timeout: 5000, env: { ...process.env, LC_ALL: 'C' } };
export type ProcessIdentity = { pid: number; uid: number; startedKey: string };
export type EditorObservation = { running: boolean; bundlePath: string; pid: number | null };
type Bundle = { path: string; signature: string; architecture: string | null };
type AppKitProcess = { pid: number; bundlePath: string; executablePath: string };
type KernelProcess = ProcessIdentity & { executablePath: string };

const same = (a: string, b: string) => a.normalize('NFC') === b.normalize('NFC');

export function matchEditorProcess(bundle: Bundle | null, apps: readonly AppKitProcess[] | null,
  listed: readonly Pick<KernelProcess, 'pid' | 'uid' | 'executablePath'>[] | null, uid: number): EditorObservation | null {
  if (!bundle || bundle.signature !== 'verified' || bundle.architecture !== 'universal' ||
      !isAbsolute(bundle.path) || !apps || !listed) return null;
  if (apps.length === 0 && listed.length === 0) return { running: false, bundlePath: bundle.path, pid: null };
  if (apps.length !== 1 || listed.length !== 1) return null;
  const app = apps[0];
  const kernel = listed[0];
  const executable = join(bundle.path, 'Contents', 'MacOS', 'Obsidian');
  if (!Number.isSafeInteger(app.pid) || app.pid <= 0 || app.pid !== kernel.pid || kernel.uid !== uid ||
      typeof app.bundlePath !== 'string' || typeof app.executablePath !== 'string' ||
      !same(app.bundlePath, bundle.path) || !same(app.executablePath, executable) || !same(kernel.executablePath, executable)) return null;
  return { running: true, bundlePath: bundle.path, pid: app.pid };
}

export async function observeProcess(pid: number): Promise<KernelProcess | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const { stdout } = await exec('/bin/ps', ['-ww', '-p', String(pid), '-o', 'pid=', '-o', 'uid=', '-o', 'lstart=', '-o', 'comm='], options);
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}) +(.+)$/.exec(stdout.trimEnd());
    if (!match || Number(match[1]) !== pid) return null;
    return { pid, uid: Number(match[2]), startedKey: match[3], executablePath: match[4] };
  } catch { return null; }
}

export async function observeSignedEditor(uid: number): Promise<EditorObservation | null> {
  const result = await Promise.allSettled([readMacObsidianState(), appKitProcesses(), processIds(uid)]);
  if (result[0].status !== 'fulfilled' || result[1].status !== 'fulfilled' || result[2].status !== 'fulfilled') return null;
  const bundle = result[0].value?.application;
  const apps = result[1].value;
  const ids = result[2].value;
  if (!bundle || !apps || !ids) return null;
  const listed = await Promise.all(ids.map(observeProcess));
  if (listed.some((entry) => entry === null)) return null;
  return matchEditorProcess(bundle, apps, listed.map((entry) => entry!), uid);
}

async function processIds(uid: number): Promise<number[] | null> {
  try {
    const { stdout } = await exec('/usr/bin/pgrep', ['-u', String(uid), '-x', 'Obsidian'], options);
    return /^\d+(?:\s+\d+)*$/.test(stdout.trim()) ? stdout.trim().split(/\s+/).map(Number) : null;
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return failure.code === 1 && typeof failure.stderr === 'string' && !failure.stderr.trim() ? [] : null;
  }
}

async function appKitProcesses(): Promise<AppKitProcess[] | null> {
  try {
    const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `
      ObjC.import("AppKit");
      const apps = ObjC.unwrap($.NSWorkspace.sharedWorkspace.runningApplications)
        .filter((item) => ObjC.unwrap(item.bundleIdentifier) === "md.obsidian")
        .map((item) => ({
          pid: Number(item.processIdentifier),
          bundlePath: ObjC.unwrap(item.bundleURL.path),
          executablePath: ObjC.unwrap(item.executableURL.path)
        }));
      JSON.stringify(apps);
    `], options);
    const apps: unknown = JSON.parse(stdout);
    return Array.isArray(apps) && apps.every((entry) => entry && typeof entry === 'object') ? apps : null;
  } catch { return null; }
}
