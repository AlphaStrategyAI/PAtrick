import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readConfig } from '../src/config.js';
import { readNetworkTargets } from '../src/integrations/network.js';

const flags = ['output-dir', 'env-file', 'backup-env-file', 'config', 'data-dir', 'network-config', 'node', 'repo-dir', 'log-dir'] as const;
type Flag = typeof flags[number];
const usage = 'Usage: install-service.ts --output-dir DIR --env-file PRIVATE_SERVICE_ENV --backup-env-file PRIVATE_BACKUP_ENV --config FILE --data-dir DIR --network-config FILE [--node NODE24] [--repo-dir DIR] [--log-dir DIR]';
function xml(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new Error('Paths must contain valid XML characters.');
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
const shell = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
function privateFile(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw new Error(`Use a regular, owner-only environment file (chmod 600): ${path}`);
}

/** Generate reviewable launchd files only. No service, VM, log or data directory is installed. */
export function generateService(args: string[]): string {
  if (process.platform !== 'darwin') throw new Error('This generator targets macOS launchd.');
  const input: Partial<Record<Flag, string>> = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]?.replace(/^--/, '') as Flag;
    if (!args[index]?.startsWith('--') || !flags.includes(flag) || input[flag] !== undefined) throw new Error(usage);
    const value = args[++index]; if (!value || value.startsWith('--')) throw new Error(usage);
    input[flag] = value;
  }
  const required = (flag: Flag) => { const value = input[flag]; if (!value) throw new Error(`Missing --${flag}. ${usage}`); if (!isAbsolute(value)) throw new Error(`--${flag} must be an absolute path.`); return resolve(value); };
  const output = required('output-dir'), envFile = required('env-file'), backupEnvFile = required('backup-env-file'), config = required('config'), dataDir = required('data-dir'), network = required('network-config');
  const repo = realpathSync(input['repo-dir'] ? required('repo-dir') : resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const node = realpathSync(input.node ? required('node') : process.execPath);
  const logDir = input['log-dir'] ? required('log-dir') : join(dataDir, 'logs');
  if (!/^v24\./.test(execFileSync(node, ['--version'], { encoding: 'utf8' }).trim())) throw new Error('Choose the absolute Node 24 executable with --node.');
  if (!existsSync(join(repo, 'dist', 'index.js'))) throw new Error('Build prerequisite missing: run npm ci and npm run build under Node 24 before generating a service.');
  if (!existsSync(join(repo, 'node_modules', 'tsx'))) throw new Error('The daily backup requires the installed tsx package. Run npm ci including development dependencies.');
  privateFile(envFile); privateFile(backupEnvFile);
  readConfig({ PATRICK_MODE: 'live', PATRICK_HOST: '127.0.0.1', PATRICK_CONFIG: config, PATRICK_DATA_DIR: dataDir });
  readNetworkTargets(network);
  const values: Record<string, string> = { NODE: node, ENV_FILE: envFile, BACKUP_ENV_FILE: backupEnvFile, REPO: repo, CONFIG: config, DATA_DIR: dataDir, NETWORK_CONFIG: network, LOG_DIR: logDir, PATH: [...new Set([dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':') };
  const names = ['com.patrick.workbench.plist', 'com.patrick.backup.plist'];
  const plists = names.map(name => readFileSync(join(repo, 'examples', 'launchd', `${name}.template`), 'utf8').replace(/\{\{([A-Z_]+)\}\}/g, (_match, key: string) => { if (!(key in values)) throw new Error(`Unknown template variable: ${key}`); return xml(values[key]!); }));
  const install = `# Review and activate PAtrick\n\nGenerated for Node ${node}, repository ${repo}, data ${dataDir}. Environment file contents were not read or embedded.\n\nRun these commands yourself after reviewing the plists and private configuration. The generator did not run them. User LaunchAgents run while the account is logged in.\n\n\`\`\`sh\ninstall -d -m 700 ${shell(dataDir)} ${shell(logDir)} "$HOME/Library/LaunchAgents"\nplutil -lint ${names.map(name => shell(join(output, name))).join(' ')}\ncp ${shell(join(output, names[0]!))} "$HOME/Library/LaunchAgents/com.patrick.workbench.plist"\ncp ${shell(join(output, names[1]!))} "$HOME/Library/LaunchAgents/com.patrick.backup.plist"\nchmod 600 "$HOME/Library/LaunchAgents/com.patrick.workbench.plist" "$HOME/Library/LaunchAgents/com.patrick.backup.plist"\nlaunchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.patrick.workbench.plist"\nlaunchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.patrick.backup.plist"\nlaunchctl print "gui/$(id -u)/com.patrick.workbench"\n\`\`\`\n\nThe service runs built dist/index.js with the existing startup/60-second network guardian. The backup job runs daily at 03:15 local time; its optional restic step needs an initialized approved repository and externally protected password file. Inspect job exit status and perform an isolated restore drill before claiming backup acceptance.\n\nTo stop before recovery or upgrades:\n\n\`\`\`sh\nlaunchctl bootout "gui/$(id -u)/com.patrick.workbench"\nlaunchctl bootout "gui/$(id -u)/com.patrick.backup"\n\`\`\`\n\nWait for the host to exit and release writer.lock. An active or unknown lease blocks restore. Do not delete the lease as a shortcut. Keep logs private and rotate them through an approved host policy. See docs/deployment.md for Lima, VPN/DNS/routes, credentials and takeover checks.\n`;
  for (const name of [...names, 'INSTALL.md']) if (existsSync(join(output, name))) throw new Error(`Output already exists; choose a new --output-dir: ${join(output, name)}`);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  names.forEach((name, index) => writeFileSync(join(output, name), plists[index]!, { mode: 0o600, flag: 'wx' }));
  writeFileSync(join(output, 'INSTALL.md'), install, { mode: 0o600, flag: 'wx' });
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) console.log(usage);
  else { console.log(`Generated reviewable launchd files: ${generateService(process.argv.slice(2))}`); console.log('Read INSTALL.md. No service or VM was installed or started.'); }
}
