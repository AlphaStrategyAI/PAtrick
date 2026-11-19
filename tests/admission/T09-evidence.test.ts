import { expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { probe as probeCodex } from '../../packages/executor/src/backends/codex.js';
import { probe as probeDsh } from '../../packages/executor/src/backends/dsh.js';
import { probe as probeGrok } from '../../packages/executor/src/backends/grok.js';
import { runCommand } from '../../packages/executor/src/command.js';
import { assessProbe, limaGuestMarkerPresent, versionCommand } from '../../packages/executor/src/probe.js';

const GUEST_MARKER = '/etc/patrick-executor-vm';
const PROBES = { codex: probeCodex, grok: probeGrok, dsh: probeDsh };

type BackendRecord = {
  backend: string;
  status: string;
  available: boolean;
  command: string;
  installedVersion: string | null;
  liveTerminal: boolean;
  liveToolCall: boolean;
  isolated: boolean;
  observation: string;
  evidenceSha256: string;
};

test('the executor admission evidence names what each backend can do', async () => {
  const isolated = limaGuestMarkerPresent(GUEST_MARKER);
  const records: BackendRecord[] = [];
  for (const backend of ['codex', 'grok', 'dsh'] as const) {
    const spec = versionCommand(backend);
    let capability: Awaited<ReturnType<typeof probeCodex>>;
    try {
      capability = await PROBES[backend]();
    } catch (error) {
      capability = { backend, command: `${spec.command} ${spec.args.join(' ')}`, version: null,
        resumeSupported: false, liveTerminal: false, liveToolCall: false,
        error: error instanceof Error ? error.message : String(error) } as Awaited<ReturnType<typeof probeCodex>>;
    }
    const version = await runCommand(spec.command, spec.args, 8000);
    const record = assessProbe(backend, version, {
      isolated,
      liveTerminal: capability.liveTerminal,
      liveToolCall: capability.liveToolCall,
    }, [
      capability.version ? `version: ${capability.version}` : 'version: unavailable',
      'error' in capability && capability.error ? `probe error: ${String(capability.error)}` : null,
    ].filter(Boolean) as string[]);
    records.push({
      backend,
      status: record.status,
      available: record.available,
      command: record.command,
      installedVersion: capability.version ?? null,
      liveTerminal: capability.liveTerminal,
      liveToolCall: capability.liveToolCall,
      isolated,
      observation: record.observation,
      evidenceSha256: record.evidenceSha256,
    });
  }
  const report = {
    kind: 'executor-admission',
    guest: isolated ? 'lima-guest' : 'host',
    guestMarkerPresent: existsSync(GUEST_MARKER),
    backends: records,
  };
  const target = process.env.PATRICK_ADMISSION_EVIDENCE;
  if (target) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report));
  expect(records.map((record) => record.backend)).toEqual(['codex', 'grok', 'dsh']);
  for (const record of records) {
    expect(record.observation.length).toBeGreaterThan(0);
    expect(record.evidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
    // A backend that is not ready must say why; readiness is never assumed.
    if (!record.available) expect(record.observation).toMatch(/blocked:/u);
  }
}, 120_000);
