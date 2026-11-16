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

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('limactl', args, { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

console.log(`lima home ${limaHome}`);
console.log(`template ${yaml}`);

try {
  if (existsSync(join(limaHome, name))) {
    // limactl start of an existing instance does not re-run provision.
    console.log(`recreate ${name} from ${yaml}`);
    const deleted = await run(['--tty=false', 'delete', '--force', name]);
    if (deleted !== 0) process.exit(deleted);
  }
  const started = await run([
    '--tty=false',
    'start',
    `--name=${name}`,
    '--timeout=10m',
    `--mount-only=${root}`,
    yaml,
  ]);
  process.exit(started);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
