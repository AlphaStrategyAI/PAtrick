import { expect, test } from 'vitest';
import { probeExecutorReadiness } from '../../packages/executor/src/readiness.js';
import { LOCKED_DSH_VERSION } from '../../packages/executor/src/backends/dsh.js';

type Command = { command: string; args: readonly string[] };

function answering(stdout: string) {
  const calls: Command[] = [];
  return {
    calls,
    runner: async (command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] });
      return { exitCode: 0, stdout, stderr: '', error: null };
    },
  };
}

test('the readiness check only asks each backend for its version', async () => {
  const { calls, runner } = answering('1.2.3');
  const results = await probeExecutorReadiness({ isolated: true, runner });
  expect(calls.map((call) => `${call.command} ${call.args.join(' ')}`)).toEqual([
    'codex --version', 'grok --version', 'dsh --version',
  ]);
  expect(results.map((result) => result.backend)).toEqual(['codex', 'grok', 'dsh']);
  expect(results.every((result) => result.observation.includes('the live terminal and tool call are exercised by the T09 admission run'))).toBe(true);
});

test('a backend outside the isolated guest stays blocked', async () => {
  const { runner } = answering('1.2.3');
  const results = await probeExecutorReadiness({ isolated: false, runner });
  expect(results.every((result) => result.status === 'blocked')).toBe(true);
  expect(results[0].reason).toBe('blocked: the executor is not inside the lima guest');
});

test('a DSH that is not the locked version is blocked', async () => {
  const { runner } = answering('0.0.1-other');
  const results = await probeExecutorReadiness({ isolated: true, runner });
  const dsh = results.find((result) => result.backend === 'dsh');
  expect(dsh?.status).toBe('blocked');
  expect(dsh?.reason).toBe(`blocked: the installed version does not match the locked package ${LOCKED_DSH_VERSION}`);
});

test('a backend that does not answer is blocked', async () => {
  const results = await probeExecutorReadiness({ isolated: true, runner: async () => ({
    exitCode: 127, stdout: '', stderr: '', error: 'ENOENT',
  }) });
  expect(results.every((result) => result.status === 'blocked')).toBe(true);
  expect(results[0].reason).toBe('blocked: the command did not answer');
});
