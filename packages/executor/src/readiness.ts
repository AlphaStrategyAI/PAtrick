import { runCommand } from './command.js';
import { LOCKED_DSH_VERSION } from './backends/dsh.js';
import { evidenceSha256 } from './hash.js';
import { limaGuestMarkerPresent, versionCommand } from './probe.js';
import type { BackendId } from './types.js';

export type ExecutorReadiness = {
  backend: BackendId;
  status: 'verified' | 'blocked';
  command: string;
  version: string | null;
  reason: string | null;
  observation: string;
  evidenceSha256: string;
};

/** Reports what each backend can be observed to do, without invoking the model.
 *
 * This check answers the version command and looks for the isolated guest
 * marker. It never starts a backend run, because a run spends the owner's
 * budget and a status request must not do that silently. A backend therefore
 * stays blocked until the isolated guest is present and its locked version
 * matches; the live terminal and tool call are exercised by the admission run
 * in T09, not here.
 */
export async function probeExecutorReadiness(
  options: { isolated?: boolean; timeoutMs?: number; runner?: typeof runCommand } = {},
): Promise<ExecutorReadiness[]> {
  const isolated = options.isolated ?? limaGuestMarkerPresent();
  const timeoutMs = options.timeoutMs ?? 20_000;
  const runner = options.runner ?? runCommand;
  const results: ExecutorReadiness[] = [];
  for (const backend of ['codex', 'grok', 'dsh'] as BackendId[]) {
    const spec = versionCommand(backend);
    const version = await withDeadline(runner(spec.command, spec.args, timeoutMs), timeoutMs, backend);
    const installed = version.exitCode === 0 && version.error === null && version.stdout.trim().length > 0;
    const pinned = backend === 'dsh' ? version.stdout.trim() === LOCKED_DSH_VERSION : installed;
    const lines = [`${spec.command} ${spec.args.join(' ')}`];
    if (version.error) lines.push(version.error);
    if (version.stdout.trim()) lines.push(version.stdout.trim());
    if (version.stderr.trim()) lines.push(version.stderr.trim());
    if (!installed) lines.push('blocked: the command did not answer');
    else if (!pinned) lines.push(`blocked: the installed version does not match the locked package ${LOCKED_DSH_VERSION}`);
    else if (!isolated) lines.push('blocked: the executor is not inside the lima guest');
    const reason = lines.find((line) => line.startsWith('blocked:')) ?? null;
    const observation = [...lines, 'note: the live terminal and tool call are exercised by the T09 admission run, not by this check'].join('\n');
    results.push({
      backend,
      status: installed && pinned && isolated ? 'verified' : 'blocked',
      command: `${spec.command} ${spec.args.join(' ')}`,
      version: installed ? version.stdout.trim() : null,
      reason,
      observation,
      evidenceSha256: evidenceSha256(observation),
    });
  }
  return results;
}

async function withDeadline<T>(work: Promise<T>, timeoutMs: number, backend: BackendId): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`EXECUTOR_PROBE_TIMEOUT:${backend}`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
