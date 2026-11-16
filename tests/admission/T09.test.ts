import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { probe as probeCodex, codexInvocation } from '../../packages/executor/src/backends/codex.js';
import { LOCKED_DSH_VERSION, dshInvocation, probe as probeDsh } from '../../packages/executor/src/backends/dsh.js';
import { grokInvocation, probe as probeGrok } from '../../packages/executor/src/backends/grok.js';
import { runCommand } from '../../packages/executor/src/command.js';
import { evidenceSha256 } from '../../packages/executor/src/hash.js';
import { assessProbe, limaGuestMarkerPresent, versionCommand } from '../../packages/executor/src/probe.js';
import type { BackendId, CommandResult } from '../../packages/executor/src/types.js';

const BACKENDS: readonly BackendId[] = ['codex', 'grok', 'dsh'];
const PROBES = { codex: probeCodex, grok: probeGrok, dsh: probeDsh } as const;

test('each backend probe records the command result and the hash of that observation', async () => {
  const isolated = limaGuestMarkerPresent();
  const tool = await attemptHarnessTool();
  for (const backend of BACKENDS) {
    const home = mkdtempSync(join(tmpdir(), 'patrick-admit-'));
    try {
      const capability = await PROBES[backend]();
      const spec = versionCommand(backend);
      const version = await runCommand(spec.command, spec.args);
      const headless = await attemptHeadless(backend, home);
      const record = assessProbe(backend, version, {
        isolated,
        liveTerminal: capability.liveTerminal,
        liveToolCall: tool.live,
      }, [
        noted(headless.command, headless.args, headless.result),
        noted(tool.command, tool.args, tool.result),
      ]);
      const versionText = version.stdout.trim();
      const commandMatched = version.exitCode === 0 && version.error === null && versionText.length > 0;
      const pinOk = backend === 'dsh' ? versionText === LOCKED_DSH_VERSION : commandMatched;
      const ready = commandMatched && pinOk && isolated && capability.liveTerminal && tool.live;
      expect(capability.backend).toBe(backend);
      expect(capability.command).toBe(`${spec.command} ${spec.args.join(' ')}`);
      expect(record.command).toBe(capability.command);
      expect(capability.version).toBe(commandMatched ? versionText : null);
      expect(record.evidenceSha256).toBe(evidenceSha256(record.observation));
      expect(record.available).toBe(ready);
      expect(record.status).toBe(ready ? 'verified' : 'blocked');
      expect(record.observation).not.toMatch(/thread-fixture|grok-fixture|session-fixture/);
      if (version.error) expect(record.observation).toContain(version.error);
      if (versionText) expect(record.observation).toContain(versionText.split('\n')[0] ?? versionText);
      if (backend === 'dsh' && versionText !== LOCKED_DSH_VERSION) {
        expect(record.observation).toContain(LOCKED_DSH_VERSION);
        expect(record.available).toBe(false);
      }
      if (!commandMatched) {
        expect(capability.resumeSupported).toBe(false);
        expect(capability.liveTerminal).toBe(false);
      }
      if (!isolated) expect(record.observation).toContain('blocked: executor is not inside the lima guest');
      if (!capability.liveTerminal) expect(record.observation).toContain('blocked: no isolated terminal readback');
      if (!tool.live) expect(record.observation).toContain('blocked: no live harness tool call');
      if (headless.result.stdout.trim()) expect(record.observation).toContain(headless.result.stdout.trim().split('\n')[0] ?? '');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
}, 20000);

async function attemptHeadless(backend: BackendId, home: string): Promise<{ command: string; args: readonly string[]; result: CommandResult }> {
  const invocation = backend === 'dsh'
    ? dshInvocation(home)
    : backend === 'codex'
      ? codexInvocation({ home, resumeSession: null })
      : grokInvocation({ home, resumeSession: null, promptFile: join(home, 'prompt.txt') });
  const result = await runCommand(invocation.command, invocation.args, 8000, {
    env: { ...process.env, ...invocation.env },
    pipeStdin: invocation.stdin,
  });
  return { command: invocation.command, args: invocation.args, result };
}

async function attemptHarnessTool(): Promise<{ command: string; args: string[]; result: CommandResult; live: boolean }> {
  const harness = new URL('../../packages/executor/harness/patrick-memory.ts', import.meta.url);
  const dir = mkdtempSync(join(tmpdir(), 'patrick-harness-'));
  const script = join(dir, 'call.ts');
  writeFileSync(script, `import { patrickMemory } from ${JSON.stringify(harness.href)};
const records = await patrickMemory({
  async queryEvidence(query) {
    if (query.domain !== 'product' || query.knowledgeId !== 'k-1' || query.withdrawalEpoch !== 4) {
      throw new Error('UNPROCESSABLE');
    }
    return [{ evidenceId: 'ev-1', documentId: 'doc-1', revisionId: 'rev-1', status: 'supported' }];
  },
}, { domain: 'product', knowledgeId: 'k-1', withdrawalEpoch: 4 });
process.stdout.write(JSON.stringify(records));
`);
  const args = ['--experimental-strip-types', script];
  try {
    const result = await runCommand(process.execPath, args, 8000);
    const live = result.exitCode === 0 && result.error === null && result.stdout.includes('"evidenceId":"ev-1"');
    return { command: process.execPath, args, result, live };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function noted(command: string, args: readonly string[], result: CommandResult): string {
  const lines = [`${command} ${args.join(' ')}`, `exit=${result.exitCode ?? 'null'}`];
  if (result.error) lines.push(result.error);
  if (result.stdout.trim()) lines.push(result.stdout.trim());
  if (result.stderr.trim()) lines.push(result.stderr.trim());
  return lines.join('\n');
}
