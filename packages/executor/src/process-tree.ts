import { execFileSync } from 'node:child_process';

type ProcessRow = { pid: number; ppid: number };

export function processTreeStopped(rootPid: number): boolean {
  return liveTree(rootPid).length === 0;
}

export async function stopProcessTreeAndWait(rootPid: number, timeoutMs = 2000): Promise<boolean> {
  signal(rootPid, 'SIGTERM');
  if (await untilStopped(rootPid, timeoutMs)) return true;
  signal(rootPid, 'SIGKILL');
  return untilStopped(rootPid, timeoutMs);
}

function liveTree(rootPid: number): number[] {
  const table = processRows();
  const children = new Map<number, number[]>();
  for (const row of table) {
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const alive = new Set(table.map((row) => row.pid));
  const found: number[] = [];
  const pending = [rootPid];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    if (alive.has(pid)) found.push(pid);
    for (const child of children.get(pid) ?? []) pending.push(child);
  }
  return found;
}

function processRows(): ProcessRow[] {
  const text = execFileSync('ps', ['-ax', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  const rows: ProcessRow[] = [];
  for (const line of text.split('\n')) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) rows.push({ pid, ppid });
  }
  return rows;
}

function signal(rootPid: number, name: NodeJS.Signals): void {
  try {
    process.kill(-rootPid, name);
  } catch {
    try {
      process.kill(rootPid, name);
    } catch {
      // The process tree is already gone.
    }
  }
}

async function untilStopped(rootPid: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (processTreeStopped(rootPid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return processTreeStopped(rootPid);
}
