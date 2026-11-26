import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { chmod, chown, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

  test.for([
    { role: 'service', field: 'serviceSupervisor' },
    { role: 'worker', field: 'workerSupervisor' },
  ] as const)('indexes the $role supervisor and marker only when enrolled', async ({ role, field }) => {
    const roleRoot = join(root, `${role}-enrollment`);
    const supervisorRoot = join(roleRoot, `${role}-supervisor`);
    const supervisorEntry = join(supervisorRoot, 'entry.mjs');
    const marker = join(roleRoot, role, 'supervisor-required');
    const base = registration({ registryRoot: roleRoot });
    const legacy = planHostRegistry(base);
    expect(legacy.directories.map(directory => directory.path)).not.toContain(supervisorRoot);
    expect(legacy.files.map(file => file.path)).not.toContain(marker);
    expect(() => planHostRegistry({ ...base, [field]: { entry: '' } })).toThrow('HOST_REGISTRY_ENTRY_INVALID');
    const plan = planHostRegistry({ ...base, [field]: { entry: roleEntry } });
    expect(plan.directories).toContainEqual({ path: supervisorRoot, mode: 0o755 });
    expect(plan.files.find(file => file.path === supervisorEntry)?.mode).toBe(0o444);
    expect(plan.files.find(file => file.path === marker)?.mode).toBe(0o444);
    await applyHostRegistry(plan);
    for (const path of [supervisorRoot, supervisorEntry, marker]) expect((await stat(path)).uid).toBe(process.geteuid!());
    expect(await readFile(marker, 'utf8')).toBe('');
    await expect(readHostRegistry(plan)).resolves.toEqual(plan.files.map(file => ({ path: file.path, sha256: file.sha256 })));
    await expect(applyHostRegistry(legacy)).rejects.toThrow('HOST_REGISTRY_ENTRY_CONFLICT');
    execFileSync('/bin/chmod', ['+a', 'everyone allow write', marker]);
    try { await expect(readHostRegistry(plan)).rejects.toThrow('HOST_REGISTRY_FILE_CONFLICT'); }
    finally { execFileSync('/bin/chmod', ['-a#', '0', marker]); }
  });

  test('the native service supervisor requires enrollment and adopts only its fixed listening socket', async () => {
    const executableRoot = join(root, 'service-native');
    const fixture = registration({ registryRoot: executableRoot, node: { path: process.execPath, sha256: sha256File(process.execPath) } });
    const roles = { ...fixture.roles,
      service: { ...fixture.roles.service, uid: process.getuid!(), entry: 'console.log(process.env.PATRICK_SUPERVISOR_FD ?? "legacy");' },
      hub: { ...fixture.roles.hub, uid: process.getuid!() + 1 },
    };
    await applyHostRegistry(planHostRegistry({ ...fixture, roles }));
    const socketPath = join(executableRoot, 'service', 'supervisor.sock');
    const otherSocket = join(root, 'other.sock');
    const relocatedSocket = join(executableRoot, 'service-supervisor', 'activated.sock');
    const header = join(root, 'service-activation.h');
    await writeFile(header, `
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <launch.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#define PATRICK_NATIVE_REGISTRY_TEST 1
constexpr char registry_root[] = ${JSON.stringify(executableRoot)};
constexpr auto registry_owner = ${process.geteuid!()}U;
inline int fixture_activation(const char* key, int** descriptors, size_t* count) {
  const char* path = std::getenv("PATRICK_FIXTURE_SOCKET");
  if (std::strcmp(key, "ServiceControl") != 0 || !path) return ENOENT;
  sockaddr_un address {};
  if (std::strlen(path) >= sizeof(address.sun_path)) return ENAMETOOLONG;
  address.sun_family = AF_UNIX;
  std::strcpy(address.sun_path, path);
  address.sun_len = SUN_LEN(&address);
  const int listener = socket(AF_UNIX, SOCK_STREAM, 0);
  if (listener < 0) return errno;
  if (bind(listener, reinterpret_cast<sockaddr*>(&address), address.sun_len) != 0 ||
      chown(path, static_cast<uid_t>(-1), getgid()) != 0 || chmod(path, 0660) != 0 ||
      (!std::getenv("PATRICK_FIXTURE_BOUND_ONLY") && listen(listener, 2) != 0)) {
    const int failure = errno;
    close(listener);
    return failure;
  }
  const char* published = std::getenv("PATRICK_FIXTURE_PUBLISHED_SOCKET");
  if (published && std::rename(path, published) != 0) {
    const int failure = errno;
    close(listener);
    return failure;
  }
  *descriptors = static_cast<int*>(std::malloc(sizeof(listener)));
  if (!*descriptors) { close(listener); return ENOMEM; }
  **descriptors = listener;
  *count = 1;
  return 0;
}
#define launch_activate_socket fixture_activation
`);
    const controller = join(root, 'service-controller');
    execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', 'clang++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
      '-O2', '-include', header, source, '-o', controller], { cwd: root, timeout: 30_000 });
    const supervisor = (path?: string, boundOnly = false, published?: string) => spawnSync(controller, ['run-supervisor', 'service'], {
      cwd: root, env: { ...(path ? { PATRICK_FIXTURE_SOCKET: path } : {}),
        ...(published ? { PATRICK_FIXTURE_PUBLISHED_SOCKET: published } : {}),
        ...(boundOnly ? { PATRICK_FIXTURE_BOUND_ONLY: '1' } : {}), NODE_OPTIONS: '--unsupported-fixture-option' },
      encoding: 'utf8', timeout: 5000,
    });
    expect((await exec(controller, ['run-role', 'service'])).stdout).toBe('legacy\n');
    expect(supervisor(socketPath).status).toBe(78);
    await rm(executableRoot, { recursive: true });
    await applyHostRegistry(planHostRegistry({ ...fixture, roles, serviceSupervisor: { entry: [
      'import { fstatSync } from "node:fs";',
      'console.log(JSON.stringify({ cwd: process.cwd(), fd: process.env.PATRICK_SUPERVISOR_LISTENER_FD,',
      '  socket: fstatSync(3).isSocket(), umask: process.umask(), env: process.env.PATRICK_FIXTURE_SOCKET ?? null }));',
    ].join('\n') } }));
    await expect(exec(controller, ['run-role', 'service'])).rejects.toMatchObject({ code: 78 });
    expect(supervisor().status).toBe(78);
    expect(supervisor(socketPath, true)).toMatchObject({ status: 78, stderr: 'PATRICK_SERVICE_LISTENER_ADDRESS_INVALID\n' });
    await rm(socketPath);
    const otherListener = createServer(socket => socket.destroy());
    otherListener.listen(socketPath);
    await once(otherListener, 'listening');
    try {
      await chown(socketPath, process.getuid!(), process.getgid!());
      await chmod(socketPath, 0o660);
      expect(supervisor(otherSocket)).toMatchObject({ status: 78, stderr: 'PATRICK_SERVICE_LISTENER_ADDRESS_INVALID\n' });
    } finally {
      otherListener.close();
      await once(otherListener, 'close');
    }
    const result = supervisor(socketPath);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      cwd: join(executableRoot, 'service-supervisor'), fd: '3', socket: true, umask: 0o077, env: null,
    });
    await rm(socketPath);
    const relocated = supervisor(relocatedSocket, false, socketPath);
    expect(relocated.status, relocated.stderr).toBe(0);
    expect(JSON.parse(relocated.stdout)).toEqual(JSON.parse(result.stdout));
  }, 60_000);

  test('the native controller admits the applied registry', async () => {
    const executableRoot = join(root, 'native-registry');
    const executable = process.execPath;
    const cliEntry = [
      'import { fstatSync } from "node:fs";',
      'const sentinel = fstatSync(0);',
      'const inherited = [3, 9].filter(fd => {',
      '  try { const observed = fstatSync(fd); return observed.dev === sentinel.dev && observed.ino === sentinel.ino; }',
      '  catch { return false; }',
      '});',
      'process.stdout.write(JSON.stringify({',
      '  args: process.argv.slice(2), cwd: process.cwd(), umask: process.umask(), inherited,',
      '  options: process.env.NODE_OPTIONS ?? null, caller: process.env.PATRICK_CALLER ?? null,',
      '}));',
      'process.exitCode = 5;',
    ].join('\n');
    const plan = planHostRegistry(registration({
      registryRoot: executableRoot, node: { path: executable, sha256: sha256File(executable) },
      cli: { entry: cliEntry },
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
    const cliRoot = join(executableRoot, 'cli');
    const cliPath = join(cliRoot, 'entry.mjs');
    const descriptor = openSync(node, 'r');
    try {
      const args = ['--unsupported-fixture-option', '', '隔离 Vault #1'];
      const result = spawnSync(controller, ['run-cli', ...args], {
        cwd: root, env: { NODE_OPTIONS: '--unsupported-fixture-option', PATRICK_CALLER: 'ignored' },
        stdio: [descriptor, 'pipe', 'pipe', descriptor, 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', descriptor],
        encoding: 'utf8', timeout: 15_000,
      });
      expect(result.status, result.error?.message ?? result.stderr).toBe(5);
      expect(JSON.parse(result.stdout)).toEqual({
        args, cwd: cliRoot, umask: 0o077, inherited: [], options: null, caller: null,
      });
    } finally { closeSync(descriptor); }
    expect((await stat(cliRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(cliPath)).mode & 0o777).toBe(0o400);
    await chmod(cliPath, 0o644);
    await expect(exec(controller, ['run-cli', 'doctor'])).rejects.toMatchObject({ code: 78 });
    await chmod(cliPath, 0o400);
    for (const [path, code] of [[cliPath, 'HOST_REGISTRY_FILE_CONFLICT'],
      [join(executableRoot, 'node'), 'HOST_REGISTRY_FILE_CONFLICT'],
      [cliRoot, 'HOST_REGISTRY_DIRECTORY_INVALID'], [executableRoot, 'HOST_REGISTRY_DIRECTORY_INVALID']]) {
      execFileSync('/bin/chmod', ['+a', 'everyone allow write', path]);
      try {
        await expect(exec(controller, ['run-cli', 'doctor'])).rejects.toMatchObject({ code: 78 });
        await expect(readHostRegistry(plan)).rejects.toThrow(code);
      } finally { execFileSync('/bin/chmod', ['-a#', '0', path]); }
    }
    const disabled = planHostRegistry(registration({
      registryRoot: executableRoot, node: { path: executable, sha256: sha256File(executable) },
    }));
    await expect(applyHostRegistry(disabled)).rejects.toThrow('HOST_REGISTRY_ENTRY_CONFLICT');
    await expect(readHostRegistry(plan)).resolves.toEqual(plan.files.map(file => ({ path: file.path, sha256: file.sha256 })));
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
