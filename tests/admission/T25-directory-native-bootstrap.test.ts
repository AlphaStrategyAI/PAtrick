import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test.each(['host SDK', 'without O_NOFOLLOW', 'without O_CLOEXEC'])('native directory primitive: %s', async (profile) => {
  const scratch = await mkdtemp(join(tmpdir(), 'patrick-directory-core-'));
  try {
    const source = fileURLToPath(new URL('../../packages/integrations/sources/native/directory-core.cc', import.meta.url));
    const harness = fileURLToPath(new URL('../native/T25-directory-core-harness.cc', import.meta.url));
    const binary = join(scratch, 'harness');
    const flags = ['-std=c++17', '-Wall', '-Wextra', '-Werror'];
    if (profile !== 'host SDK') {
      // Mask one SDK definition after including its header in each test translation unit.
      const header = join(scratch, 'fixture-flags.h');
      const flag = profile === 'without O_NOFOLLOW' ? 'O_NOFOLLOW' : 'O_CLOEXEC';
      await writeFile(header, `#include <fcntl.h>\n#undef ${flag}\n`);
      flags.push('-include', header);
    }
    const compilerOptions = {
      cwd: scratch, env: { ...process.env, TMPDIR: scratch }, encoding: 'utf8' as const, timeout: 30_000,
    };
    const definitions = spawnSync('c++', [...flags, '-x', 'c++', '-dM', '-E', '-'], {
      ...compilerOptions, input: '#include <fcntl.h>\n',
    });
    expect(definitions.status, definitions.error?.message ?? definitions.stderr).toBe(0);
    const macros = new Set(definitions.stdout.split('\n').map(line => line.split(/\s+/)[1]));
    const supported = ['__APPLE__', 'O_NOFOLLOW', 'O_CLOEXEC'].every(name => macros.has(name));
    if (profile !== 'host SDK') expect(supported).toBe(false);
    const build = spawnSync('c++', [...flags, source, harness, '-o', binary], compilerOptions);
    expect(build.status, build.error?.message ?? build.stderr).toBe(0);
    const fixture = join(scratch, 'fixture');
    await mkdir(fixture);
    await mkdir(join(fixture, 'folder'));
    await writeFile(join(fixture, 'ordinary'), Buffer.from([65, 0, 90, 255]));
    await writeFile(join(fixture, 'large'), 'q'.repeat(9000));
    await writeFile(join(fixture, 'empty'), '');
    await writeFile(join(fixture, 'denied'), 'private');
    await chmod(join(fixture, 'denied'), 0);
    await symlink('ordinary', join(fixture, 'link'));
    const run = spawnSync(binary, [], { cwd: fixture, encoding: 'utf8', timeout: 10_000 });
    expect(run.status, run.error?.message ?? run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe(supported ? 'fixture passed' : 'unsupported');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 60_000);
