import { execFileSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { accessSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { canonical, digest } from '../../packages/host/src/recovery/files.js';
import type { RecoveryJournalRoot } from '../../packages/host/src/recovery/operations.js';
import type { VaultConnection, VaultRecord } from '../../packages/integrations/vault/connection.js';
import { INDEX_PATH, indexSeedMatches, readIndexFile, SEED_PROOF_PATH } from '../../packages/integrations/vault/index-proof.js';
import { bindHostRegistration, bindRegistration, projectIdentity, sameIdentity, type HostIdentity, type RegisteredHost } from '../lib/doctor.mjs';
import { leased, type ExclusiveRuntimeStaging } from '../lib/emitted-release.mjs';
import { canonicalize, readRegularFile } from '../lib/release.mjs';
import { createVaultKitInstaller } from '../obsidian/install.mjs';
import { createLifecycleJournal, createLifecycleJournalReader, type LifecycleEvidenceSubject, type LifecycleRegistration,
  type LifecycleRequest, type LifecycleStatus } from './lifecycle-journal.js';

const layout = ['知识笔记', '判断案例', '标准修订', '附件', '模板', '系统视图'];
const intentPath = '系统视图/.patrick-index-seed.intent.json';
// The independent observer covers the same seven fixed T27 destinations.
const kitTargets = ['模板/知识笔记.md', '模板/判断案例.md', '模板/标准修订.md', INDEX_PATH,
  '系统视图/知识.base', '系统视图/标准.base', '系统视图/知识关系.canvas'];
const evidenceVersion = 'vault-kit-files-v1';
const evidenceId = 'installed-vault-kit';
type Root = RecoveryJournalRoot;
type Signer = Parameters<typeof createLifecycleJournal>[1];
type Lease = { root: string; guard(): void };
type PublishedKit = Readonly<{ release: Root; controllerUid: number }>;
export type VaultInitEnrollment = {
  installationId: string; operationId: string; identity: HostIdentity; captureHost: string; serviceUid: number; editorUid: number;
  vault: VaultRecord; mappingRevision: number; owner: Root; journal: Root; assets: Root; stage: Root;
  kitVersion: string; kitSha256: string; approvalPublicKey: string; journalKeyId: string; journalPublicKey: string;
  publishedKit?: PublishedKit;
};
type FileStamp = { identity: string; sha256: string };
type Snapshot = { directories: Record<string, string | null>; files: Record<string, FileStamp | null> };
type KitSubject = { vaultId: string; sourceId: string; configRevision: number; scopeHash: string; kitVersion: string; manifestSha256: string };
export type VaultInitPlan = Snapshot & {
  format: 'patrick-vault-init-v1'; operationId: string; enrollmentSha256: string; subject: KitSubject;
};
type Kit = { files: { path: string; sha256: string }[]; manifestPath: string };
const stagingDirectories = ['模板/.patrick-staging', '系统视图/.patrick-staging'];

function check(value: unknown): asserts value { if (!value) throw new Error('VAULT_INIT_BINDING_INVALID'); }
function captureMethod<T extends object, K extends keyof T>(object: T, key: K) {
  check(object && (typeof object === 'object' || typeof object === 'function'));
  const chain: Array<{ object: object; prototype: object | null }> = [];
  let descriptor: PropertyDescriptor | undefined;
  for (let at: object | null = object; at; at = Object.getPrototypeOf(at)) {
    chain.push({ object: at, prototype: Object.getPrototypeOf(at) });
    descriptor = Object.getOwnPropertyDescriptor(at, key);
    if (descriptor) break;
  }
  check(descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function');
  const initial = descriptor;
  const value = initial.value as T[K];
  return { value, validate() {
    for (let index = 0; index < chain.length; index++) {
      const item = chain[index]!;
      check(Object.getPrototypeOf(item.object) === item.prototype);
      const live = Object.getOwnPropertyDescriptor(item.object, key);
      if (index < chain.length - 1) check(!live);
      else check(live && Object.hasOwn(live, 'value') && Object.is(live.value, value) &&
        live.configurable === initial.configurable && live.enumerable === initial.enumerable && live.writable === initial.writable);
    }
  } };
}
const hash = (value: unknown) => digest(canonicalize(JSON.parse(JSON.stringify(value))));
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const token = (s: string) => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(s);
const sha = (s: string) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const physical = (path: string) => realpathSync.native(path).normalize('NFC') === path.normalize('NFC');
const stat = (path: string) => lstatSync(path, { bigint: true, throwIfNoEntry: false });
const node = (s: NonNullable<ReturnType<typeof stat>>) => [s.dev, s.ino, s.birthtimeNs].join(':');
function dir(path: string): string | null {
  const s = stat(path);
  if (!s) return null;
  check(s.isDirectory() && physical(path) && s.uid === BigInt(process.geteuid!()) && (s.mode & 0o022n) === 0n);
  return node(s);
}
function rootMatches(root: Root) {
  const s = stat(root.path);
  check(s?.isDirectory() && resolve(root.path) === root.path && physical(root.path) && s.uid === BigInt(process.geteuid!()) &&
    (s.mode & 0o022n) === 0n && s.dev === BigInt(root.device) && s.ino === BigInt(root.inode));
}
const sourceName = (target: string) => target.startsWith('模板/') ? target.slice('模板/'.length) : target;
const within = (root: string, path: string) => {
  const boundary = root.normalize('NFC'), candidate = path.normalize('NFC');
  return candidate === boundary || candidate.startsWith(boundary === sep ? sep : boundary + sep);
};

function capturePublishedKit({ release, controllerUid }: PublishedKit, assets: Root) {
  const releaseStore = dirname(release.path);
  const files = ['manifest.json', ...kitTargets.map(sourceName)].map(path => join(assets.path, path));
  const directories = new Set(files.map(dirname));
  for (let parent = dirname(assets.path); ; parent = dirname(parent)) {
    directories.add(parent);
    if (parent === sep) break;
  }
  const paths = [...directories, ...files];
  const uid = BigInt(controllerUid);
  function fingerprint(path: string) {
    const info = stat(path);
    check(info);
    const inRelease = within(release.path, path);
    if (directories.has(path)) {
      const stickyAncestor = !within(releaseStore, path) && info.uid === 0n && (info.mode & 0o1000n) !== 0n;
      check(info.isDirectory() && (inRelease ? info.uid === uid : info.uid === uid || info.uid === 0n) &&
        ((info.mode & 0o022n) === 0n || stickyAncestor));
    } else {
      check(info.isFile() && info.uid === uid && info.nlink === 1n && (info.mode & 0o7777n) === 0o644n);
    }
    const pin = path === release.path ? release : path === assets.path ? assets : undefined;
    if (pin) check(info.dev === BigInt(pin.device) && info.ino === BigInt(pin.inode));
    const identity = [node(info), info.uid, info.gid, info.mode].join('/');
    return inRelease ? [identity, info.ctimeNs, info.mtimeNs, info.size].join('/') : identity;
  }
  function verifyAcl() {
    if (process.platform !== 'darwin') return;
    check(paths.length <= 64 && paths.every(path => Array.from(path).every(character => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })));
    const entries = execFileSync('/bin/ls', ['-ldneq', ...paths], {
      env: { LC_ALL: 'C' }, encoding: 'utf8', timeout: 2000, maxBuffer: 256 * 1024,
    }).trimEnd().split('\n');
    let found = 0;
    for (const entry of entries) {
      if (/^[d-][rwxStTs-]{9}[@+]? +\d+ /.test(entry)) found++;
      else check(/^ +\d+: [a-zA-Z0-9:_-]+ (inherited )?deny [a-z_,]+$/.test(entry));
    }
    check(found === paths.length);
  }
  const identities = paths.map(path => {
    check(physical(path));
    return fingerprint(path);
  });
  return (verifyPermissions = false) => {
    if (verifyPermissions) verifyAcl();
    paths.forEach((path, index) => check(fingerprint(path) === identities[index]));
  };
}
function verifiedKey(pem: string) {
  const key = createPublicKey(pem);
  check(key.asymmetricKeyType === 'ed25519');
  return (data: Uint8Array, signature: string) => typeof signature === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(signature) &&
    Buffer.from(signature, 'base64').toString('base64') === signature && verify(null, data, key, Buffer.from(signature, 'base64'));
}
/** Approval is issued by the independently enrolled host controller for one exact immutable preview. */
export function vaultInitApproval(plan: VaultInitPlan) {
  return Buffer.from(canonical({ purpose: 'patrick-authorize-vault-init-v1', operationId: plan.operationId, planSha256: hash(plan) }));
}

function enrollment(current: () => VaultInitEnrollment, owner: ExclusiveRuntimeStaging) {
  const binding = bindRegistration(current);
  const e = binding.value, vault = e.vault;
  const contract = hash(e);
  const verifyApproval = verifiedKey(e.approvalPublicKey), verifyJournal = verifiedKey(e.journalPublicKey);
  const ownerLease = captureMethod(owner, 'withExclusiveReadRoot');
  check(e.owner.path !== sep && resolve(e.owner.path) === e.owner.path && token(e.installationId) && token(e.operationId) && token(e.journalKeyId) &&
    token(vault.vault_id) && vault.scope_hash === hash({ domain: vault.data_domain, paths: layout }) && sha(e.kitSha256) && /^\d+\.\d+\.\d+$/.test(e.kitVersion) &&
    sameIdentity(projectIdentity(e.identity), e.identity) && e.identity.accountId === vault.account_id &&
    e.identity.domains.includes(vault.data_domain) && vault.capture_host === e.captureHost && vault.status === 'connected' &&
    vault.physical_root === vault.root_path && vault.config_revision >= 1 && vault.connection_epoch >= 1 &&
    Number.isSafeInteger(e.mappingRevision) && e.mappingRevision >= 1 && e.serviceUid === process.geteuid!() && e.editorUid === e.serviceUid);
  const subject: KitSubject = { vaultId: vault.vault_id, sourceId: vault.source_id, configRevision: vault.config_revision,
    scopeHash: vault.scope_hash, kitVersion: e.kitVersion, manifestSha256: e.kitSha256 };
  const components = vault.root_path.normalize('NFC').toLowerCase().split(sep);
  check(!components.includes('.obsidian') && !components.some((name, i) => name === 'obsidian' && components[i-1] === 'application support'));
  const published = e.publishedKit;
  if (published !== undefined) {
    check(published && Number.isSafeInteger(published.controllerUid) && published.controllerUid >= 0 &&
      published.controllerUid <= 0x7fffffff && resolve(published.release.path) === published.release.path &&
      sha(basename(published.release.path)) && e.assets.path === join(published.release.path, 'assets', 'vault-kit') &&
      !within(e.owner.path, published.release.path) && !within(published.release.path, e.owner.path));
  }
  const ownedRoots = [e.owner, e.journal, e.stage, ...(published ? [] : [e.assets])];
  const roots = [...ownedRoots.slice(1).map(root => root.path), vault.root_path];
  for (const path of roots) check(resolve(path) === path && path.startsWith(e.owner.path + sep) &&
    roots.filter(other => other === path || other.startsWith(path + sep)).length === 1);
  const ancestors = new Set<string>();
  for (const path of roots) {
    for (let parent = dirname(path); parent !== e.owner.path; parent = dirname(parent)) ancestors.add(parent);
  }
  function guard(lease: Lease) {
    lease.guard();
    binding.validate(); ownerLease.validate();
    check(lease.root === e.owner.path && hostname() === e.captureHost &&
      process.geteuid!() === e.serviceUid);
    for (const parent of ancestors) check(dir(parent));
    for (const root of ownedRoots) rootMatches(root);
    const s = stat(vault.root_path);
    check(s?.isDirectory() && physical(vault.root_path) && s.uid === BigInt(e.serviceUid) && (s.mode & 0o022n) === 0n && vault.root_identity === s.dev + ':' + s.ino);
  }
  async function underOwner<T>(work: (lease: Lease) => Promise<T>, extra?: () => void) {
    const admission = () => { binding.validate(); ownerLease.validate(); extra?.(); };
    let guardPublished: ReturnType<typeof capturePublishedKit> | undefined;
    const result = await leased(owner, async serviceLease => {
      serviceLease.guard();
      if (published) {
        guardPublished = capturePublishedKit(published, e.assets);
        guardPublished(true);
      }
      const lease = { root: serviceLease.root, guard() { serviceLease.guard(); guardPublished?.(); } };
      guard(lease); const answer = await work(lease); guard(lease); return answer;
    }, true, admission);
    admission();
    guardPublished?.(true);
    return result;
  }
  const read = (lease: Lease, path: string, root = e.owner.path) =>
    readRegularFile(path, 16 * 1024 * 1024, { root, validate: () => guard(lease) });
  async function kit(lease: Lease): Promise<Kit> {
    const readRoot = published?.release.path ?? e.owner.path;
    const manifest = await read(lease, join(e.assets.path, 'manifest.json'), readRoot);
    check(digest(manifest) === e.kitSha256);
    const value = JSON.parse(manifest.toString());
    check(value.name === 'vault-kit' && value.version === e.kitVersion && Array.isArray(value.files) && value.files.length === 7);
    const remaining = new Set(kitTargets), files: Kit['files'] = [];
    for (const row of value.files) {
      check(remaining.delete(row.path) && sha(row.sha256));
      const source = sourceName(row.path);
      check(row.source === source && digest(await read(lease, join(e.assets.path, source), readRoot)) === row.sha256);
      files.push({ path: row.path, sha256: row.sha256 });
    }
    check(remaining.size === 0);
    const manifestPath = '系统视图/.patrick-vault-kit-' + e.kitVersion + '-' + e.kitSha256.slice(0, 12) + '.json';
    files.push({ path: manifestPath, sha256: e.kitSha256 });
    return { files, manifestPath };
  }
  async function snapshot(lease: Lease, k: Kit): Promise<Snapshot> {
    guard(lease);
    // T27 excludes nested Vaults and unsafe configuration/staging directories.
    for (let parent = dirname(vault.root_path); parent !== dirname(parent); parent = dirname(parent)) {
      check(!stat(join(parent, '.obsidian')));
    }
    const directories = Object.fromEntries([...layout, ...stagingDirectories, '.obsidian'].map(d => [d, dir(join(vault.root_path, d))]));
    const files: Snapshot['files'] = {};
    for (const name of [...k.files.map(f => f.path), intentPath, SEED_PROOF_PATH]) {
      const path = join(vault.root_path, name);
      const s = stat(path);
      if (!s) { files[name] = null; continue; }
      check(s.isFile() && s.nlink === 1n && s.uid === BigInt(e.serviceUid) && (s.mode & 0o022n) === 0n && physical(path));
      const sha256 = digest(await read(lease, path));
      const after = stat(path);
      check(after && node(after) === node(s) && after.size === s.size && after.ctimeNs === s.ctimeNs);
      files[name] = { identity: node(s), sha256 };
    }
    guard(lease);
    return { directories, files };
  }
  function checkInstallAccess(k: Kit, actual: Snapshot) {
    const mask = process.umask();
    check((mask & 0o700) === 0); // T27 requires usable owner bits even for an existing kit.
    const writeAccess = constants.W_OK | constants.X_OK;
    const pendingParents = new Set(k.files.filter(file => !actual.files[file.path]).map(file => dirname(file.path)));
    accessSync(e.stage.path, writeAccess); // T27 creates a temporary directory on every invocation.
    for (const name of layout) {
      if (actual.directories[name] === null) {
        accessSync(vault.root_path, writeAccess);
      } else {
        const parent = join(vault.root_path, name);
        const writable = name === '知识笔记' || name === '标准修订' || pendingParents.has(name);
        accessSync(parent, constants.R_OK | constants.X_OK | (writable ? constants.W_OK : 0));
        // T27 checks every existing staging directory, including when all files are present.
        const staging = join(parent, '.patrick-staging'), st = stat(staging);
        if (st) {
          check(st.isDirectory() && physical(staging));
          accessSync(staging, writeAccess);
          continue;
        }
      }
      // A pending publication creates missing target-side staging with mode 0777.
      if (pendingParents.has(name)) check((mask & 0o022) === 0o022);
    }
  }
  async function preview(lease: Lease): Promise<VaultInitPlan> {
    const k = await kit(lease), baseline = await snapshot(lease, k);
    const manifest = baseline.files[k.manifestPath];
    check(!manifest || manifest.sha256 === e.kitSha256);
    checkInstallAccess(k, baseline);
    if (!baseline.files[INDEX_PATH]) {
      check(!baseline.files[intentPath] && !baseline.files[SEED_PROOF_PATH]);
    } else if (baseline.files[intentPath]) {
      // T27 requires attestation when an intent and an index already coexist.
      check(baseline.files[SEED_PROOF_PATH]);
      const index = await readIndexFile(join(vault.root_path, INDEX_PATH));
      check(index);
      const seed = k.files.find(file => file.path === INDEX_PATH)!;
      if (index.sha256 === seed.sha256) check(await indexSeedMatches(vault.root_path, vault, index));
      guard(lease);
    }
    return { format: 'patrick-vault-init-v1', operationId: e.operationId, enrollmentSha256: contract, subject: { ...subject }, ...baseline };
  }
  async function observeFiles(lease: Lease, plan: VaultInitPlan, complete: boolean) {
    const k = await kit(lease), actual = await snapshot(lease, k);
    if (!complete) checkInstallAccess(k, actual);
    for (const d of [...layout, ...stagingDirectories]) {
      if (plan.directories[d] !== null) check(plan.directories[d] === actual.directories[d]);
    }
    check(plan.directories['.obsidian'] === actual.directories['.obsidian']);
    if (complete) check(layout.every(d => actual.directories[d] !== null));
    for (const item of k.files) {
      const before = plan.files[item.path], after = actual.files[item.path];
      if (before !== null) check(equal(before, after));
      else if (after !== null) check(after.sha256 === item.sha256);
      else check(!complete);
    }
    if (plan.files[INDEX_PATH] !== null) {
      for (const path of [intentPath, SEED_PROOF_PATH]) check(equal(plan.files[path], actual.files[path]));
    } else {
      const seed = k.files.find(file => file.path === INDEX_PATH)!;
      const intent = JSON.stringify({ format: 1, vaultId: vault.vault_id, rootIdentity: vault.root_identity,
        configRevision: vault.config_revision, scopeHash: vault.scope_hash, sha256: seed.sha256 }) + '\n';
      if (complete || actual.files[intentPath] || actual.files[INDEX_PATH]) check(actual.files[intentPath]?.sha256 === digest(intent));
      if (complete || actual.files[SEED_PROOF_PATH]) {
        const index = await readIndexFile(join(vault.root_path, INDEX_PATH));
        check(index && await indexSeedMatches(vault.root_path, vault, index));
      }
    }
    guard(lease);
    return actual;
  }
  function request(plan: VaultInitPlan): LifecycleRequest {
    check(plan.format === 'patrick-vault-init-v1' && plan.operationId === e.operationId && plan.enrollmentSha256 === contract && equal(plan.subject, subject));
    return { command: 'init', operationId: e.operationId, targetId: vault.vault_id, expectedGeneration: null, planSha256: hash(plan) };
  }
  function journal(lease: Lease, plan: VaultInitPlan, verifyLive?: () => Promise<void>) {
    const req = request(plan);
    const identity = { ...e.identity, domains: [...e.identity.domains].sort(), installationId: e.installationId };
    const subjectPlan = { command: req.command, targetId: req.targetId, expectedGeneration: null, nextGeneration: null,
      releaseSha256: null, planSha256: req.planSha256 };
    const registration: LifecycleRegistration = {
      root: e.journal, identity, plan: subjectPlan,
      authority: { keyId: e.journalKeyId, async verify(data, signature, key) { return key === e.journalKeyId && verifyJournal(data, signature); } },
      evidence: { version: evidenceVersion, async observe(subject: LifecycleEvidenceSubject, id: string) {
        guard(lease);
        check(id === evidenceId && sha(subject.claimSha256) && equal(subject.binding, { protocol: 'patrick-installed-lifecycle-v1',
          operationId: e.operationId, root: e.journal, identity, plan: subjectPlan, journalKeyId: e.journalKeyId, evidenceVersion }));
        await verifyLive?.();
        const actual = await observeFiles(lease, plan, true);
        guard(lease);
        return { evidenceId, claimSha256: subject.claimSha256, evidenceSha256: hash({ version: evidenceVersion, subject, actual }) };
      } },
    };
    return { req, registration: () => { guard(lease); return registration; } };
  }
  return { e, verifyApproval, guard, underOwner, preview, journal, observeFiles };
}

export function createVaultInitReader(current: () => VaultInitEnrollment, owner: ExclusiveRuntimeStaging, original: VaultInitPlan) {
  const registration = enrollment(current, owner);
  const plan = JSON.parse(canonical(original)) as VaultInitPlan;
  return { read: () => registration.underOwner(lease => {
    const j = registration.journal(lease, plan);
    return createLifecycleJournalReader(j.registration).read(j.req);
  }) };
}

/** The live T06 ports are used only for the preview and a newly owned execution.
 * The host lease excludes edits to this synthetic Vault, its inputs, and enrolled
 * physical ancestry across the baseline, native action and evidence readback. */
export function createVaultInitController(current: () => VaultInitEnrollment, owner: ExclusiveRuntimeStaging, host: RegisteredHost, signer: Signer) {
  const registration = enrollment(current, owner), { e } = registration;
  const vaultId = e.vault.vault_id;
  const signerMethod = captureMethod(signer, 'sign');
  const hostBinding = bindHostRegistration(host);
  const target = bindRegistration(() => host.vaults && Object.hasOwn(host.vaults, vaultId) ? host.vaults[vaultId] : undefined);
  function checkLiveRegistration() {
    signerMethod.validate();
    hostBinding.validate();
    target.validate();
  }
  function live(lease: Lease, owned?: () => Promise<void>) {
    const guard = () => { registration.guard(lease); checkLiveRegistration(); };
    guard();
    const v = target.value, options = v?.installer;
    check(v && options && sameIdentity(host.identity, e.identity) && sameIdentity(v.identity, e.identity) &&
      host.captureHost === e.captureHost && host.serviceUid === e.serviceUid && host.runtime?.createVaultKitInstaller === createVaultKitInstaller &&
      v.configRevision === e.vault.config_revision && v.scopeHash === e.vault.scope_hash && options.assetRoot === e.assets.path &&
      options.stageParent === e.stage.path && options.deviceId === e.identity.deviceId && options.captureHost === e.captureHost &&
      options.serviceUid === e.serviceUid && options.editorUid === e.editorUid);
    const loadVault = async (id: string) => {
      guard(); check(id === vaultId); const record = await options.loadVault(id); await owned?.(); guard();
      check(equal(record, e.vault)); return structuredClone(record);
    };
    const inspectVault = async (device: string, id: string) => {
      guard(); check(id === vaultId && device === e.identity.deviceId); const c: VaultConnection = await options.inspectVault(device, id); await owned?.(); guard();
      check(c.vault_id === id && c.status === 'connected' && c.collection_status === 'ready' && c.source_id === e.vault.source_id &&
        c.root_identity === e.vault.root_identity && c.config_revision === e.vault.config_revision && c.scope_hash === e.vault.scope_hash &&
        c.capture_host === e.captureHost && c.client_mapping_revision === e.mappingRevision); return structuredClone(c);
    };
    return {
      guard,
      async inspect() { await loadVault(vaultId); await inspectVault(e.identity.deviceId, vaultId); guard(); },
      async install() {
        // This is the exact native T27 factory used by the Vault CLI adapter.
        const receipt = await createVaultKitInstaller({ ...options, loadVault, inspectVault }).installVaultKit(vaultId);
        guard();
        check(receipt.vaultId === vaultId && receipt.sourceId === e.vault.source_id && receipt.configRevision === e.vault.config_revision &&
          receipt.scopeHash === e.vault.scope_hash && receipt.version === e.kitVersion && receipt.manifestSha256 === e.kitSha256);
      },
    };
  }
  async function stablePreflight(lease: Lease, v: ReturnType<typeof live>) {
    await v.inspect();
    const plan = await registration.preview(lease);
    await v.inspect();
    check(equal(await registration.preview(lease), plan));
    v.guard();
    return plan;
  }
  return {
    async preview() {
      const plan = await registration.underOwner(lease => stablePreflight(lease, live(lease)), checkLiveRegistration);
      checkLiveRegistration();
      return plan;
    },
    async execute(original: VaultInitPlan, signature: string): Promise<LifecycleStatus> {
      const plan = JSON.parse(canonical(original)) as VaultInitPlan;
      check(registration.verifyApproval(vaultInitApproval(plan), signature));
      let attempted = false;
      try {
        const result = await registration.underOwner(async lease => {
          const historical = registration.journal(lease, plan);
          const previous = await createLifecycleJournalReader(historical.registration).read(historical.req);
          if (previous.status === 'completed' || previous.status === 'running_or_uncertain') return previous;
          const v = live(lease);
          const j = registration.journal(lease, plan, v.inspect);
          const checkBaseline = async () => {
            await v.inspect();
            check(equal(await registration.preview(lease), plan));
            v.guard();
          };
          const guardedSigner: Signer = { async sign(bytes) {
            v.guard();
            const { kind } = JSON.parse(Buffer.from(bytes).toString('utf8'));
            const signature = await Reflect.apply(signerMethod.value, signer, [bytes]);
            v.guard();
            if (kind === 'reservation' || kind === 'claim') {
              // The enrolled signer can yield or alter an input before returning.
              await checkBaseline();
              if (kind === 'claim') attempted = true;
            }
            return signature;
          } };
          const journal = createLifecycleJournal(() => { v.guard(); return j.registration(); }, guardedSigner);
          check(equal(await stablePreflight(lease, v), plan));
          const reserved = await journal.reserve(j.req);
          if (reserved.status !== 'reserved') return reserved;
          const claim = await journal.claim(j.req);
          if (claim.status !== 'claimed') return claim;
          await checkBaseline();
          const requireClaim = async () => { check(equal(await journal.readOwnedClaim(claim.token), claim.subject)); };
          const installer = live(lease, async () => {
            await registration.observeFiles(lease, plan, false);
            await requireClaim();
          });
          await requireClaim(); installer.guard();
          await installer.install();
          await v.inspect();
          const fd = openSync(e.vault.root_path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { const s = fstatSync(fd); check(e.vault.root_identity === s.dev + ':' + s.ino); fsyncSync(fd); } finally { closeSync(fd); }
          v.guard();
          return await journal.markCompleted(claim.token, evidenceId);
        }, checkLiveRegistration);
        if (attempted) checkLiveRegistration();
        return result;
      } catch (error) {
        if (attempted) return { status: 'running_or_uncertain' };
        throw error;
      }
    },
  };
}
