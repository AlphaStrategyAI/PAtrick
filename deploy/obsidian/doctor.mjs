import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { readFile, realpath, statfs } from 'node:fs/promises';
import { homedir, hostname, platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { obsidianFileUri } from '../../packages/integrations/vault/uri.ts';
import { obsidianSigningRequirement } from './mac-install.mjs';
import { checkRoot, draftDirs, hasServiceIdentity, optionalStat, permission, readerDirs, samePath } from './scope.mjs';

const exec = promisify(execFile);
const workbench = new URL('../../upstream.lock.json', import.meta.url);
const sha256 = /^[a-f0-9]{64}$/;
const hasControl = (text) => Array.from(text).some((char) => char < ' ');
const scope = {
  reader: readerDirs.map((dir) => dir + '/'),
  draftWriter: draftDirs.map((dir) => dir + '/'),
  projector: ['系统视图/'],
  kitInstaller: ['模板/', '系统视图/'],
};

export function createObsidianInspector({ localDeviceId, lockedVersion, installerHash, readMacState }) {
  return async function inspectObsidian(deviceId) {
    const installer = {
      status: sha256.test(installerHash ?? '') && lockedVersion ? 'pinned' : 'unverified',
      version: lockedVersion,
      sha256: installerHash,
    };
    const unknown = { deviceId, application: { status: 'unknown' }, installer, uri: 'unknown', process: 'unknown' };
    if (deviceId !== localDeviceId) return unknown;
    const observed = await readMacState();
    if (!observed) return unknown;
    const bundle = observed.application;
    const application = !bundle ? { status: 'missing' } : {
      ...bundle,
      status: bundle.signature === 'invalid' || bundle.signature === 'unexpected_signer' ? 'untrusted'
        : bundle.version !== lockedVersion || bundle.architecture !== 'universal' ? 'incompatible'
        : bundle.signature === 'verified' ? 'ready' : 'unknown',
    };
    const uri = observed.uriHandler === undefined ? 'unknown'
      : observed.uriHandler === null ? 'unregistered'
      : bundle && samePath(bundle.path, observed.uriHandler) ? 'registered' : 'different_handler';
    return {
      deviceId, application, installer, uri,
      process: observed.running === undefined ? 'unknown' : observed.running ? 'running' : 'stopped',
    };
  };
}

export async function inspectObsidian(deviceId) {
  const lock = JSON.parse(await readFile(workbench, 'utf8'));
  // An installed application's version and architecture are not an installer hash.
  const installer = lock.probes?.['obsidian-installer-arch'] ?? {};
  return createObsidianInspector({
    localDeviceId: hostname(),
    lockedVersion: installer.installerVersion ?? null,
    installerHash: installer.packageHashSha256 ?? null,
    readMacState: readMacObsidianState,
  })(deviceId);
}

export function createVaultActivityReader(db) {
  const lastRevision = db.prepare(`SELECT revision_id AS revisionId, created_at AS observedAt
    FROM vault_revisions WHERE vault_id = ? AND account_id = ? AND data_domain = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`);
  const lastProjection = db.prepare(`SELECT p.projection_revision AS revision, p.updated_at AS observedAt
    FROM projection_pointers p
    JOIN projection_batches b ON b.data_domain = p.data_domain AND b.view_kind = p.view_kind
      AND b.projection_revision = p.projection_revision AND b.intent_id = p.intent_id
    JOIN vaults v ON v.vault_id = b.vault_id AND v.data_domain = b.data_domain
    WHERE v.vault_id = ? AND v.account_id = ? AND v.data_domain = ? AND b.applied = 1 AND b.cleanup_state = 'current'
    ORDER BY p.updated_at DESC, p.rowid DESC LIMIT 1`);
  return (vault) => ({
    collection: lastRevision.get(vault.vault_id, vault.account_id, vault.data_domain) ?? null,
    projection: lastProjection.get(vault.vault_id, vault.account_id, vault.data_domain) ?? null,
  });
}

export function createObsidianDoctor(options) {
  return {
    async inspect(deviceId, vaultId) {
      const editor = await options.inspectObsidian(deviceId);
      const permissions = { reader: 'unknown', draftWriter: 'unknown', projector: 'unknown' };
      const result = { editor, permissions, scope, connection: null, recent: null, disk: null, sync: 'unknown', editorAccess: 'unknown' };
      const vault = await options.loadVault(vaultId);
      if (vault.capture_host !== options.captureHost || !hasServiceIdentity(options.serviceUid)) return result;
      try {
        await checkRoot(vault);
        result.connection = { ...await options.inspectVault(deviceId, vaultId), projection_status: 'unknown' };
        if (options.syncMode === 'single_device' && result.connection.status === 'connected') result.sync = 'single_device';
        const root = vault.root_path;
        const [reader, draftWriter, projector, disk] = await Promise.all([
          permission(root, readerDirs, constants.R_OK),
          permission(root, draftDirs, constants.W_OK),
          permission(root, ['系统视图'], constants.W_OK),
          statfs(root, { bigint: true }),
        ]);
        Object.assign(permissions, { reader, draftWriter, projector });
        if (options.editorUid === options.serviceUid && hasServiceIdentity(options.editorUid)) {
          result.editorAccess = await permission(root, draftDirs, constants.R_OK | constants.W_OK);
        }
        result.disk = { availableBytes: (disk.bavail * disk.bsize).toString() };
        if (options.readRecent) {
          result.recent = await options.readRecent(vault);
          result.connection.projection_status = result.recent.projection ? 'ready' : 'missing';
        }
      } catch (error) {
        if (['EACCES', 'EPERM'].includes(error.code)) {
          Object.assign(permissions, { reader: 'denied', draftWriter: 'denied', projector: 'denied' });
        } else if (!['VAULT_ROOT_CHANGED', 'VAULT_UNSAFE_PATH', 'VAULT_NESTED', 'ENOENT'].includes(error.message) && error.code !== 'ENOENT') {
          throw error;
        }
      }
      return result;
    },
  };
}

export function obsidianEditTarget(editor, mapping, edit) {
  const path = edit.relativePath;
  if (typeof path !== 'string' || !path.endsWith('.md') || /[\\:]/.test(path) || hasControl(path)) return { kind: 'unavailable' };
  const parts = path.split('/');
  if (parts.length < 2 || !draftDirs.includes(parts[0]) ||
      parts.some((part) => part === '' || part === '..' || part.startsWith('.'))) return { kind: 'unavailable' };
  if (editor.application.status !== 'ready' || editor.uri !== 'registered' ||
      !mapping || mapping.deviceId !== editor.deviceId || mapping.vaultId !== edit.vaultId ||
      !Number.isInteger(mapping.mappingRevision) || mapping.mappingRevision < 1 ||
      mapping.mappingRevision !== edit.mappingRevision || typeof mapping.alias !== 'string' ||
      !mapping.alias.trim() || /[\\/]/.test(mapping.alias) || hasControl(mapping.alias)) {
    return { kind: 'relative_path', relativePath: path };
  }
  return { kind: 'obsidian_uri', uri: obsidianFileUri(mapping.alias, path) };
}

export async function readMacObsidianState() {
  if (platform() !== 'darwin') return null;
  const app = '/Applications/Obsidian.app';
  const candidates = [app, join(homedir(), 'Applications', 'Obsidian.app')];
  const workspace = observeLaunchServices();
  let application = null;
  for (const candidate of candidates) {
    const info = await optionalStat(candidate);
    if (!info) continue;
    if (!info.isDirectory() || !samePath(await realpath(candidate), candidate)) {
      application = { path: candidate, version: null, architecture: null, signature: 'invalid' };
      break;
    }
    const response = await Promise.allSettled([
      exec('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(candidate, 'Contents', 'Info.plist')]),
      exec('/usr/bin/file', ['-b', join(candidate, 'Contents', 'MacOS', 'Obsidian')]),
      exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', candidate]),
      exec('/usr/bin/codesign', ['--verify', '--strict', '-R',
        obsidianSigningRequirement, candidate]),
    ]);
    const version = response[0].status === 'fulfilled' ? response[0].value.stdout.trim() : null;
    const binary = response[1].status === 'fulfilled' ? response[1].value.stdout : '';
    const architecture = /universal binary/.test(binary) && /\barm64\b/.test(binary) && /\bx86_64\b/.test(binary)
      ? 'universal' : null;
    const signature = response[2].status === 'rejected' ? 'invalid'
      : response[3].status === 'fulfilled' ? 'verified' : 'unexpected_signer';
    application = { path: candidate, version, architecture, signature };
    break;
  }
  return { application, ...await workspace };
}

async function observeLaunchServices() {
  try {
    const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `
      ObjC.import("AppKit");
      const workspace = $.NSWorkspace.sharedWorkspace;
      const app = workspace.URLForApplicationToOpenURL($.NSURL.URLWithString("obsidian://open"));
      const handler = app.isNil() ? null : ObjC.unwrap(app.path);
      const running = ObjC.unwrap(workspace.runningApplications).some(
        (process) => ObjC.unwrap(process.bundleIdentifier) === "md.obsidian");
      JSON.stringify({uriHandler: handler, running});
    `], { timeout: 5000 });
    return JSON.parse(stdout);
  } catch {
    return {};
  }
}
