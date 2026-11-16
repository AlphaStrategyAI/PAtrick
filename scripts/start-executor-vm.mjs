import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const yaml = fileURLToPath(new URL('../deploy/lima/executor.yaml', import.meta.url));
const name = 'patrick-executor';
// Lima's ssh.sock path must stay under UNIX_PATH_MAX (104). Keep this directory short.
const limaHome = process.env.PATRICK_LIMA_HOME ?? join(homedir(), '.patrick-lima');

mkdirSync(limaHome, { recursive: true });
const env = { ...process.env, LIMA_HOME: limaHome };

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

const exists = existsSync(join(limaHome, name, 'lima.yaml'));
const args = exists
  ? ['--tty=false', 'start', name]
  : ['--tty=false', 'start', `--name=${name}`, '--timeout=10m', `--mount-only=${root}`, yaml];

console.log(`lima home ${limaHome}`);
console.log(`template ${yaml}`);
const child = spawn('limactl', args, { env, stdio: 'inherit' });
child.on('error', fail);
child.on('exit', (code) => {
  process.exit(code ?? 1);
});
