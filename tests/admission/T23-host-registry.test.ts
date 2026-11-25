import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { applyHostRegistry, planHostRegistry, readHostRegistry, type HostRegistryRegistration } from '../../deploy/host/registry.js';

const source = fileURLToPath(new URL('../../deploy/host-controller/main.cc', import.meta.url));
const exec = promisify(execFile);
const roleEntry = [
  'import { closeSync, constants, openSync } from "node:fs";',
  'import { Socket } from "node:net";',
  'if (process.env.PATRICK_SUPERVISOR_FD !== "3") process.exit(76);',
  'const fd = openSync("/dev/fd/3", constants.O_RDWR);',
  'closeSync(3);',
  'const connection = new Socket({ fd, readable: true, writable: true });',
  'let response = "";',
  'for await (const part of connection) response += part.toString();',
  'process.stdout.write(response);',
].join('\n');

function sha256File(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe.skipIf(process.platform !== 'darwin')('host role registry', { concurrent: false }, () => {
  let root: string;
  let registry: string;
  let node: string;
  let nodeSha256: string;

  beforeAll(async () => {
    root = await mkdtemp('/private/tmp/patrick-registry-');
    registry = join(root, 'registry');
    node = join(root, 'node');
    await writeFile(node, 'fixture node bytes\n', { mode: 0o555 });
    nodeSha256 = sha256File(node);
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  function registration(overrides: Partial<HostRegistryRegistration> = {}): HostRegistryRegistration {
    const base = {
      registryRoot: registry,
      node: { path: node, sha256: nodeSha256 },
      roles: {
        service: { uid: process.getuid!() + 1, gid: process.getgid!(), entry: roleEntry },
        hub: { uid: process.getuid!(), gid: process.getgid!(), entry: roleEntry },
        worker: { uid: process.getuid!() + 2, gid: process.getgid!(), entry: roleEntry },
      },
      supervisor: { entry: roleEntry },
    };
    return { ...base, ...overrides };
  }

  test('plans and applies the protected role registry', async () => {
    const plan = planHostRegistry(registration());
    expect(plan.directories.map(entry => entry.path)).toEqual([
      registry, join(registry, 'service'), join(registry, 'hub'), join(registry, 'worker'), join(registry, 'hub-supervisor'),
    ]);
    expect(plan.files.map(entry => entry.path)).toEqual([
      join(registry, 'node'),
      join(registry, 'service', 'account'), join(registry, 'service', 'entry.mjs'),
      join(registry, 'hub', 'account'), join(registry, 'hub', 'entry.mjs'), join(registry, 'hub', 'supervisor-required'),
      join(registry, 'worker', 'account'), join(registry, 'worker', 'entry.mjs'),
      join(registry, 'hub-supervisor', 'entry.mjs'),
    ]);
    await applyHostRegistry(plan);
    for (const directory of plan.directories) {
      const info = await stat(directory.path);
      expect([info.isDirectory(), info.mode & 0o777, info.uid]).toEqual([true, 0o755, process.getuid!()]);
    }
    for (const file of plan.files) {
      const info = await stat(file.path);
      expect([info.isFile(), info.mode & 0o777, info.nlink]).toEqual([true, file.mode & 0o777, 1]);
    }
    expect(await readFile(join(registry, 'hub', 'account'), 'utf8')).toBe(`${process.getuid!()}:${process.getgid!()}\n`);
    expect(await readFile(join(registry, 'service', 'entry.mjs'), 'utf8')).toBe(roleEntry);
    expect(await readFile(join(registry, 'hub', 'supervisor-required'), 'utf8')).toBe('');
    expect(sha256File(join(registry, 'node'))).toBe(sha256File(node));
    await expect(readHostRegistry(plan)).resolves.toEqual(plan.files.map(file => ({ path: file.path, sha256: file.sha256 })));
  });

  test('refuses registrations the native controller would reject', () => {
    expect(() => planHostRegistry(registration({ roles: {
      service: { uid: process.getuid!() + 1, gid: process.getgid!(), entry: roleEntry },
      hub: { uid: process.getuid!() + 1, gid: process.getgid!() + 1, entry: roleEntry },
      worker: { uid: process.getuid!() + 2, gid: process.getgid!(), entry: roleEntry },
    } }))).toThrow(/account/i);
    expect(() => planHostRegistry(registration({ roles: {
      service: { uid: 0, gid: process.getgid!(), entry: roleEntry },
      hub: { uid: process.getuid!(), gid: process.getgid!(), entry: roleEntry },
      worker: { uid: process.getuid!() + 2, gid: process.getgid!(), entry: roleEntry },
    } }))).toThrow(/account/i);
    expect(() => planHostRegistry(registration({ roles: {
      service: { uid: process.getuid!() + 1, gid: process.getgid!(), entry: '' },
      hub: { uid: process.getuid!(), gid: process.getgid!(), entry: roleEntry },
      worker: { uid: process.getuid!() + 2, gid: process.getgid!(), entry: roleEntry },
    } }))).toThrow(/entry/i);
    expect(() => planHostRegistry(registration({ node: { path: 'node', sha256: '0'.repeat(64) } }))).toThrow(/node/i);
    expect(() => planHostRegistry(registration({ registryRoot: 'relative/registry' }))).toThrow(/registry/i);
  });

  test('publishes a complete registry and preserves an existing enrollment on retry', async () => {
    const retryRoot = join(root, 'retry');
    const invalid = planHostRegistry(registration({ registryRoot: retryRoot, node: { path: node, sha256: '0'.repeat(64) } }));
    await expect(applyHostRegistry(invalid)).rejects.toThrow('HOST_REGISTRY_FILE_MISMATCH');
    await expect(stat(retryRoot)).rejects.toMatchObject({ code: 'ENOENT' });

    const plan = planHostRegistry(registration({ registryRoot: retryRoot }));
    await Promise.all([applyHostRegistry(plan), applyHostRegistry(plan)]);
    const changed = planHostRegistry(registration({ registryRoot: retryRoot, supervisor: { entry: 'console.log("changed")' } }));
    await expect(applyHostRegistry(changed)).rejects.toThrow('HOST_REGISTRY_FILE_CONFLICT');
    await expect(readHostRegistry(plan)).resolves.toEqual(plan.files.map(file => ({ path: file.path, sha256: file.sha256 })));
  });

  test('the native controller admits the applied registry', async () => {
    const executableRoot = join(root, 'native-registry');
    const executable = process.execPath;
    const plan = planHostRegistry(registration({
      registryRoot: executableRoot, node: { path: executable, sha256: sha256File(executable) },
    }));
    await applyHostRegistry(plan);
    const header = join(root, 'registry.h');
    await writeFile(header, [
      '#define PATRICK_NATIVE_REGISTRY_TEST 1',
      `constexpr char registry_root[] = ${JSON.stringify(executableRoot)};`,
      `constexpr auto registry_owner = ${process.geteuid!()}U;`,
    ].join('\n'));
    const controller = join(root, 'controller');
    execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', 'clang++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
      '-O2', '-include', header, source, '-o', controller], { cwd: root, timeout: 30_000 });
    await chmod(controller, 0o555);
    const socketPath = join(executableRoot, 'hub', 'supervisor.sock');
    const server = createServer(socket => socket.end('supervised\n'));
    const listening = once(server, 'listening');
    server.listen(socketPath);
    await listening;
    try {
      const { stdout } = await exec(controller, ['run-role', 'hub'], {
        cwd: executableRoot, env: {}, encoding: 'utf8', timeout: 15_000,
      });
      expect(stdout).toBe('supervised\n');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 60_000);
});
