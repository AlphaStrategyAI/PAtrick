import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { constants } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const enabled = process.env.PATRICK_T23_CONTROLLED_LAUNCH === '1';
const clang = '/Library/Developer/CommandLineTools/usr/bin/clang++';
const clangSha = '1590ac950a3d627817d09ade5cb60b2115f17a72182a3141e010b4bcc482a0c9';
const nodeSha = '533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4';
const source = fileURLToPath(new URL('../../deploy/host-controller/main.cc', import.meta.url));
const entry = fileURLToPath(new URL('../../deploy/host-controller/service-bootstrap.ts', import.meta.url));

async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// Opt in with the verified Darwin arm64 Node 26.13.0 and matching Apple CLT.
describe.skipIf(!enabled)('fixed synthetic role launch', { concurrent: false }, () => {
  let root: string;
  let node: string;
  let bootstrap: string;
  let cwd: string;
  let endpoint: string;
  let controller: string;
  let unregistered: string;

  beforeAll(async () => {
    expect([process.platform, process.arch, process.version]).toEqual(['darwin', 'arm64', 'v26.13.0']);
    expect(await digest(process.execPath)).toBe(nodeSha);
    expect(await digest(clang)).toBe(clangSha);
    root = await mkdtemp('/private/tmp/patrick-role-');
    node = join(root, 'node');
    // .mts fixes ESM interpretation independently of the enclosing package.
    bootstrap = join(root, 'service-bootstrap.mts');
    cwd = join(root, 'service');
    endpoint = join(root, 'control.sock');
    controller = join(root, 'controller');
    unregistered = join(root, 'unregistered');
    await mkdir(cwd, { mode: 0o700 });
    await mkdir(join(cwd, 'home'), { mode: 0o700 });
    await copyFile(process.execPath, node);
    await copyFile(entry, bootstrap);
    await chmod(node, 0o500);
    await chmod(bootstrap, 0o400);
    const directory = await stat(root, { bigint: true });
    const header = [
      '#define PATRICK_SYNTHETIC_REGISTRATION 1',
      `constexpr char fixture_root[] = ${JSON.stringify(root)};`,
      `constexpr auto fixture_device = ${directory.dev}ULL;`,
      `constexpr auto fixture_inode = ${directory.ino}ULL;`,
      `constexpr auto fixture_uid = ${directory.uid}U;`,
      `constexpr char bootstrap_sha[] = "${await digest(bootstrap)}";`,
    ].join('\n');
    const headerPath = join(root, 'registration.h');
    await writeFile(headerPath, header);
    const sdk = await realpath('/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk');
    const args = ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-O2', '-arch', 'arm64', '-isysroot', sdk,
      '-isystem', join(sdk, 'usr/include/c++/v1'), '--ld-path=/Library/Developer/CommandLineTools/usr/bin/ld'];
    for (const [output, extra] of [[unregistered, []], [controller, ['-include', headerPath]]] as const) {
      const argv = [...args, ...extra, source, '-o', output];
      const result = spawnSync(clang, argv, {
        cwd: root, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TMPDIR: root },
        timeout: 30_000, encoding: 'utf8',
      });
      expect(result.status, result.error?.message ?? result.stderr).toBe(0);
      console.info(JSON.stringify({ clang, clangSha, arch: process.arch, sdk, argv,
        controllerSha256: await digest(output), nodeSha256: await digest(node),
        bootstrapSha256: await digest(bootstrap), headerSha256: await digest(headerPath) }));
    }
  }, 60_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  test.each([
    ['wrong role', true, ['run-role', 'editor'], 64],
    ['extra argument', true, ['run-role', 'service', 'other'], 64],
    ['absent registration', false, ['run-role', 'service'], 78],
  ] as const)('%s exits before connecting', (_reason, registered, argv, code) => {
    const result = spawnSync(registered ? controller : unregistered, argv, {
      env: {}, cwd: root, timeout: 5000, encoding: 'utf8',
    });
    expect([result.error, result.signal, result.status]).toEqual([undefined, null, code]);
  });

  async function runLocalChild(server: Server, executable: string, sentinels: number[],
    onSpawn: (child: ChildProcess) => void) {
    const peers = new Set<Socket>();
    server.on('connection', socket => {
      peers.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => peers.delete(socket));
    });
    try {
      const listening = once(server, 'listening');
      server.listen(endpoint);
      await listening;
      const child = spawn(executable, ['run-role', 'service'], {
        cwd: root, env: { PATRICK_FIXTURE_PARENT: 'discard', HOME: root },
        stdio: ['ignore', 'ignore', 'ignore', ...sentinels.map(() => 'pipe' as const)],
      });
      type Status = [number | null, NodeJS.Signals | null];
      let exit: Status | undefined;
      child.once('exit', (code, signal) => { exit = [code, signal]; });
      // Node emits close after either exit or a failed spawn. An error must not
      // settle this promise ahead of actual descriptor cleanup.
      const closed = new Promise<Status>(resolve => {
        child.once('close', (code, signal) => resolve([code, signal]));
      });
      let error: Error | undefined;
      const started = new Promise<void>(resolve => {
        child.once('spawn', resolve);
        child.on('error', reason => { error = reason; resolve(); });
      });
      const deadline = setTimeout(() => child.kill('SIGKILL'), 8000);
      try {
        await started;
        if (!error) onSpawn(child);
        const close = await closed;
        return { pid: child.pid, error, exit, close };
      } finally {
        clearTimeout(deadline);
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed;
      }
    } finally {
      if (server.listening) {
        const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        for (const peer of peers) peer.destroy();
        await stopped;
      }
    }
  }

  test('missing executable closes the child handle and private listener', async () => {
    const server = createServer({ allowHalfOpen: true });
    let serverClosed = false;
    server.once('close', () => { serverClosed = true; });
    const result = await runLocalChild(server, join(root, 'absent-controller'), [3, 4], () => {
      throw new Error('unexpected spawn of missing fixture executable');
    });
    expect(result.error).toMatchObject({ code: 'ENOENT' });
    expect([result.pid, result.exit, result.close]).toEqual([undefined, undefined, [-constants.errno.ENOENT, null]]);
    expect([server.listening, serverClosed]).toEqual([false, true]);
    await expect(stat(endpoint)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 12_000);

  test.each([
    'accepted', 'accepted with only stdio', 'wrong version', 'oversize', 'premature EOF', 'missing acknowledgement',
    'wrong acknowledgement', 'trailing bytes',
  ] as const)('%s has a bounded process exit', async (scenario) => {
    const session = randomBytes(16).toString('hex');
    const server = createServer({ allowHalfOpen: true });
    let response = '';
    let connections = 0;
    let acknowledged = false;
    // The parent checks the two extra pipe ends before ACK. Node may reuse their fd numbers.
    const sentinels = scenario === 'accepted with only stdio' ? [] : [3, 4];
    const expected = (pid: number | undefined) => ({
      version: 1, role: 'service', session, pid, uid: process.getuid!(),
      execPath: node, argv: [node, bootstrap], execArgv: ['--no-addons'], cwd,
      umask: 0o077, environmentMatches: true,
    });
    const result = await runLocalChild(server, controller, sentinels, child => {
      const sentinelEnd = Promise.all(sentinels.map(index => {
        const stream = child.stdio[index] as Socket;
        const ended = once(stream, 'end').then(() => true, () => false);
        stream.resume();
        return ended;
      }));
      server.on('connection', socket => {
        connections++;
        if (scenario === 'premature EOF') return socket.end('HELLO 1 ser');
        if (scenario === 'oversize') return socket.write('X'.repeat(100));
        if (scenario === 'wrong version') return socket.end(`HELLO 2 service ${session}\n`);
        socket.write(`HELLO 1 service ${session}\n`);
        socket.on('data', (bytes: Buffer) => {
          response += bytes.toString('utf8');
          if (response.length > 4096) return socket.destroy();
          if (!response.endsWith('\n') || scenario === 'missing acknowledgement' || acknowledged) return;
          try {
            if (!isDeepStrictEqual(JSON.parse(response), expected(child.pid))) return socket.destroy();
          } catch {
            return socket.destroy();
          }
          acknowledged = true;
          void sentinelEnd.then(ended => {
            if (ended.includes(false)) return socket.destroy();
            const value = scenario === 'wrong acknowledgement' ? 'invalid' : session;
            const extra = scenario === 'trailing bytes' ? 'unexpected\n' : '';
            socket.end(`ACK 1 service ${value}\n${extra}`);
          });
        });
      });
    });
    const accepted = scenario === 'accepted' || scenario === 'accepted with only stdio';
    const code = accepted ? 0 : 76;
    expect(result.error).toBeUndefined();
    expect(result.exit).toEqual([code, null]);
    expect(result.close).toEqual([code, null]);
    expect(connections).toBe(1);
    if (['wrong version', 'oversize', 'premature EOF'].includes(scenario)) {
      expect(response).toBe('');
    } else {
      const report = JSON.parse(response);
      expect(report).toEqual(expected(result.pid));
      expect(acknowledged).toBe(scenario !== 'missing acknowledgement');
      if (accepted) console.info(JSON.stringify({ report, exit: result.exit, childPid: result.pid, sentinels }));
    }
  }, 12_000);
});
