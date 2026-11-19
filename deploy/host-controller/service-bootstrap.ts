import { closeSync, constants, openSync } from 'node:fs';
import { Socket } from 'node:net';
import { join } from 'node:path';

const protocolFailure = 76;
const maxLineBytes = 64;

function handshake() {
  // Darwin /dev/fd duplicates the inherited socket. Node's fs.open creates
  // a close-on-exec descriptor. Drop the original inheritable descriptor.
  const fd = openSync('/dev/fd/3', constants.O_RDWR);
  closeSync(3);
  const socket = new Socket({ fd, readable: true, writable: true, allowHalfOpen: true });
  let session: string | undefined;
  let acknowledged = false;
  let pending = '';
  const deadline = setTimeout(() => socket.destroy(), 2500);

  socket.on('close', () => clearTimeout(deadline));
  socket.on('error', () => socket.destroy());
  socket.on('data', (bytes: Buffer) => {
    // latin1 is one byte per character, preserving non-ASCII bytes for rejection.
    if (acknowledged || pending.length + bytes.length > maxLineBytes) return socket.destroy();
    pending += bytes.toString('latin1');
    const newline = pending.indexOf('\n');
    if (newline === -1) return;
    if (newline !== pending.length - 1) return socket.destroy();
    const line = pending.slice(0, newline);
    pending = '';
    if (session === undefined) {
      const hello = /^HELLO 1 service ([a-f0-9]{32})$/.exec(line);
      if (!hello || hello[0] !== line) return socket.destroy();
      session = hello[1];
      const cwd = process.cwd();
      const uid = process.getuid!();
      const encoding = `0x${uid.toString(16).toUpperCase()}:0x0:0x0`;
      const report = {
        version: 1, role: 'service', session, pid: process.pid, uid,
        execPath: process.execPath, argv: process.argv, execArgv: process.execArgv,
        cwd, umask: process.umask(),
        environmentMatches: Object.keys(process.env).length === 2 && process.env.HOME === join(cwd, 'home') &&
          process.env.__CF_USER_TEXT_ENCODING === encoding,
      };
      const reply = JSON.stringify(report) + '\n';
      if (!report.environmentMatches || Buffer.byteLength(reply) > 4096) return socket.destroy();
      socket.write(reply);
    } else {
      if (line !== `ACK 1 service ${session}`) return socket.destroy();
      acknowledged = true;
    }
  });
  socket.on('end', () => {
    // Peer half-close frames the end of the exchange; trailing input invalidates it.
    if (acknowledged && pending === '' && !socket.destroyed) process.exitCode = 0;
    socket.destroy();
  });
}

process.exitCode = protocolFailure;
try {
  handshake();
} catch {
  // No inherited connection or unusable descriptor. Exit without exposing host data.
}
