import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const hostRegistryRoot = '/Library/Application Support/PAtrick/controller-v1';
export const hostRegistryRoles = Object.freeze(['service', 'hub', 'worker'] as const);
export const hostRegistrySupervisor = 'hub-supervisor';

const directoryMode = 0o755;
const nodeMode = 0o555;
const entryMode = 0o444;
const maxEntryBytes = 256 * 1024;

export type HostRoleAccount = Readonly<{ uid: number; gid: number; entry: string }>;
export type HostRegistryRegistration = Readonly<{
  registryRoot: string;
  node: Readonly<{ path: string; sha256: string }>;
  roles: Readonly<Record<'service' | 'hub' | 'worker', HostRoleAccount>>;
  supervisor: Readonly<{ entry: string }>;
  cli?: Readonly<{ entry: string }>;
}>;

export type HostRegistryFile = Readonly<{
  path: string; mode: number; sha256: string; bytes: number;
  source: Readonly<{ kind: 'bytes'; bytes: Buffer } | { kind: 'file'; path: string }>;
}>;

export type HostRegistryPlan = Readonly<{
  registryRoot: string;
  directories: readonly Readonly<{ path: string; mode: number }>[];
  files: readonly HostRegistryFile[];
}>;

function digest(value: Buffer | string) {
  return createHash('sha256').update(value).digest('hex');
}

function account(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('HOST_REGISTRY_ACCOUNT_INVALID');
  const { uid, gid } = value as { uid?: unknown; gid?: unknown };
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || (uid as number) <= 0 || (gid as number) <= 0 ||
      (uid as number) > 0x7fffffff || (gid as number) > 0x7fffffff) throw new Error('HOST_REGISTRY_ACCOUNT_INVALID');
  return { uid: uid as number, gid: gid as number };
}

function entry(value: unknown) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maxEntryBytes) {
    throw new Error('HOST_REGISTRY_ENTRY_INVALID');
  }
  return value;
}

/**
 * Describes the protected host registration that the native controller admits.
 * The plan is pure; applying it is the only step that touches the host.
 */
export function planHostRegistry(registration: HostRegistryRegistration): HostRegistryPlan {
  if (!registration || typeof registration !== 'object') throw new Error('HOST_REGISTRY_INVALID');
  const root = registration.registryRoot;
  if (typeof root !== 'string' || root.includes('\0') || !isAbsolute(root) || resolve(root) !== root || root === '/') {
    throw new Error('HOST_REGISTRY_ROOT_INVALID');
  }
  const node = registration.node;
  if (!node || typeof node !== 'object' || typeof node.path !== 'string' || node.path.includes('\0') ||
      !isAbsolute(node.path) || resolve(node.path) !== node.path ||
      typeof node.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(node.sha256)) {
    throw new Error('HOST_REGISTRY_NODE_INVALID');
  }
  const roles = registration.roles;
  if (!roles || typeof roles !== 'object') throw new Error('HOST_REGISTRY_ACCOUNT_INVALID');
  const seen = new Set<number>();
  const accounts = new Map<string, { uid: number; gid: number; entry: string }>();
  for (const role of hostRegistryRoles) {
    const record = (roles as Record<string, unknown>)[role];
    const identity = account(record);
    if (seen.has(identity.uid)) throw new Error('HOST_REGISTRY_ACCOUNT_INVALID');
    seen.add(identity.uid);
    accounts.set(role, { ...identity, entry: entry((record as { entry?: unknown }).entry) });
  }
  const supervisor = registration.supervisor;
  if (!supervisor || typeof supervisor !== 'object') throw new Error('HOST_REGISTRY_ENTRY_INVALID');
  const supervisorEntry = entry((supervisor as { entry?: unknown }).entry);

  const directories = [
    { path: root, mode: directoryMode },
    ...hostRegistryRoles.map(role => ({ path: join(root, role), mode: directoryMode })),
    { path: join(root, hostRegistrySupervisor), mode: directoryMode },
  ];
  const files: HostRegistryFile[] = [
    { path: join(root, 'node'), mode: nodeMode, sha256: node.sha256, bytes: 0, source: { kind: 'file', path: node.path } },
  ];
  for (const role of hostRegistryRoles) {
    const identity = accounts.get(role)!;
    const directory = join(root, role);
    const accountBytes = Buffer.from(`${identity.uid}:${identity.gid}\n`, 'utf8');
    files.push({ path: join(directory, 'account'), mode: entryMode, sha256: digest(accountBytes), bytes: accountBytes.length,
      source: { kind: 'bytes', bytes: accountBytes } });
    const entryBytes = Buffer.from(identity.entry, 'utf8');
    files.push({ path: join(directory, 'entry.mjs'), mode: entryMode, sha256: digest(entryBytes), bytes: entryBytes.length,
      source: { kind: 'bytes', bytes: entryBytes } });
    if (role === 'hub') {
      files.push({ path: join(directory, 'supervisor-required'), mode: entryMode, sha256: digest(''), bytes: 0,
        source: { kind: 'bytes', bytes: Buffer.alloc(0) } });
    }
  }
  const supervisorBytes = Buffer.from(supervisorEntry, 'utf8');
  files.push({ path: join(root, hostRegistrySupervisor, 'entry.mjs'), mode: entryMode, sha256: digest(supervisorBytes),
    bytes: supervisorBytes.length, source: { kind: 'bytes', bytes: supervisorBytes } });
  if (registration.cli !== undefined) {
    const cliRoot = join(root, 'cli');
    const cliBytes = Buffer.from(entry(registration.cli?.entry), 'utf8');
    directories.push({ path: cliRoot, mode: 0o700 });
    files.push({ path: join(cliRoot, 'entry.mjs'), mode: 0o400, sha256: digest(cliBytes), bytes: cliBytes.length,
      source: { kind: 'bytes', bytes: cliBytes } });
  }
  return Object.freeze({ registryRoot: root, directories: Object.freeze(directories), files: Object.freeze(files) });
}

async function fileBytes(file: HostRegistryFile) {
  const bytes = file.source.kind === 'bytes' ? file.source.bytes : await readFile(file.source.path);
  if (digest(bytes) !== file.sha256) throw new Error('HOST_REGISTRY_FILE_MISMATCH');
  return bytes;
}

async function protectedDirectory(path: string, owner: number, mode?: number) {
  const info = await lstat(path);
  const permissions = info.mode & 0o7777;
  if (!info.isDirectory() || info.uid !== owner || (permissions & 0o7022) !== 0 ||
      (mode !== undefined && permissions !== mode)) throw new Error('HOST_REGISTRY_DIRECTORY_INVALID');
}

async function syncDirectory(path: string) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); }
  finally { await directory.close(); }
}

function registryOwner(plan: HostRegistryPlan) {
  const owner = process.geteuid?.();
  if (owner === undefined || owner !== process.getuid?.() || (plan.registryRoot === hostRegistryRoot && owner !== 0)) {
    throw new Error('HOST_REGISTRY_OWNER_INVALID');
  }
  return owner;
}

async function existingRegistry(plan: HostRegistryPlan) {
  const existing = await lstat(plan.registryRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!existing) return false;
  await readHostRegistry(plan);
  return true;
}

/**
 * Publishes the completed tree in a protected host directory.
 */
export async function applyHostRegistry(plan: HostRegistryPlan): Promise<void> {
  if (!plan || !Array.isArray(plan.directories) || !Array.isArray(plan.files)) throw new Error('HOST_REGISTRY_INVALID');
  const owner = registryOwner(plan);
  const parent = dirname(plan.registryRoot);
  if (plan.registryRoot === hostRegistryRoot) {
    const systemParent = dirname(parent);
    await protectedDirectory('/', owner);
    await protectedDirectory(dirname(systemParent), owner);
    await protectedDirectory(systemParent, owner);
    await mkdir(parent, { mode: directoryMode }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
  }
  await protectedDirectory(parent, owner);
  if (await realpath(parent) !== parent) throw new Error('HOST_REGISTRY_DIRECTORY_INVALID');
  if (await existingRegistry(plan)) return;

  const staged = await mkdtemp(join(parent, '.patrick-registry-'));
  const stagedPath = (path: string) => {
    const child = relative(plan.registryRoot, path);
    if (child === '..' || child.startsWith('../') || isAbsolute(child)) throw new Error('HOST_REGISTRY_INVALID');
    return join(staged, child);
  };
  try {
    for (const directory of plan.directories) {
      const path = stagedPath(directory.path);
      if (path !== staged) await mkdir(path, { mode: directory.mode });
    }
    for (const file of plan.files) {
      const bytes = await fileBytes(file);
      const descriptor = await open(stagedPath(file.path),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await descriptor.writeFile(bytes);
        await descriptor.chmod(file.mode);
        await descriptor.sync();
      } finally { await descriptor.close(); }
    }
    for (const directory of [...plan.directories].reverse()) {
      const path = stagedPath(directory.path);
      await chmod(path, directory.mode);
      await syncDirectory(path);
    }
    try { await rename(staged, plan.registryRoot); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '') ||
          !await existingRegistry(plan)) throw error;
    }
    await syncDirectory(parent);
  } finally {
    await rm(staged, { force: true, recursive: true });
  }
}

/** Reads the applied tree back and reports the observed digests. */
export async function readHostRegistry(plan: HostRegistryPlan): Promise<readonly Readonly<{ path: string; sha256: string }>[]> {
  const owner = registryOwner(plan);
  for (const directory of plan.directories) await protectedDirectory(directory.path, owner, directory.mode);
  return Promise.all(plan.files.map(async file => {
    const descriptor = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await descriptor.stat();
      if (!info.isFile() || info.uid !== owner || info.nlink !== 1 || (info.mode & 0o7777) !== file.mode) {
        throw new Error('HOST_REGISTRY_FILE_CONFLICT');
      }
      const sha256 = digest(await descriptor.readFile());
      if (sha256 !== file.sha256) throw new Error('HOST_REGISTRY_FILE_CONFLICT');
      return { path: file.path, sha256 };
    } finally { await descriptor.close(); }
  }));
}
