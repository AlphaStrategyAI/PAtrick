import { constants } from 'node:fs';
import { access, lstat, realpath, statfs } from 'node:fs/promises';
import { hostname, platform, arch } from 'node:os';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const states = new Set(['ready', 'blocked', 'unavailable', 'unknown']);
const identityName = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
export function projectIdentity(identity) {
  const { accountId, scopeId, domains, deviceId, configRevision } = identity ?? {};
  const validName = (value) => typeof value === 'string' && identityName.test(value);
  if (![accountId, scopeId, deviceId, configRevision].every(validName)
    || !Array.isArray(domains) || domains.length < 1 || domains.length > 16) throw new Error('HOST_IDENTITY_MISMATCH');
  const publicDomains = Array.from({ length: domains.length }, (_, index) => domains[index]);
  if (!publicDomains.every(validName) || new Set(publicDomains).size !== publicDomains.length) throw new Error('HOST_IDENTITY_MISMATCH');
  return { accountId, scopeId, domains: publicDomains, deviceId, configRevision };
}
export function sameIdentity(left, right) {
  return Boolean(left && right && ['accountId', 'scopeId', 'deviceId', 'configRevision'].every((key) => left[key] === right[key])
    && Array.isArray(left.domains) && Array.isArray(right.domains)
    && JSON.stringify([...left.domains].sort()) === JSON.stringify([...right.domains].sort()));
}
// Preserve executable ports and opaque runtime handles while copying plain configuration data.
// Validation always re-reads the live selection and rejects replacement and in-place edits.
function capture(value, seen = new WeakMap()) {
  const result = { original: value, copy: value };
  if (!value || typeof value !== 'object') return result;
  if (seen.has(value)) return seen.get(value);
  seen.set(value, result);
  if (Buffer.isBuffer(value)) {
    result.copy = Buffer.from(value);
    result.bytes = Buffer.from(value);
  } else if (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
    result.keys = Object.keys(value).sort();
    result.prototype = Object.getPrototypeOf(value);
    result.arrayLength = Array.isArray(value) ? value.length : undefined;
    result.children = new Map();
    result.copy = Array.isArray(value) ? new Array(value.length) : Object.create(Object.getPrototypeOf(value));
    for (const key of result.keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor.get || descriptor.set) throw new Error('HOST_IDENTITY_MISMATCH');
      const child = capture(value[key], seen);
      result.children.set(key, child);
      Object.defineProperty(result.copy, key, { value: child.copy, writable: true, enumerable: true, configurable: true });
    }
  }
  return result;
}
function unchanged(snapshot, value, seen = new Set()) {
  if (!Object.is(snapshot.original, value)) return false;
  if (seen.has(snapshot)) return true;
  seen.add(snapshot);
  if (snapshot.bytes) return Buffer.isBuffer(value) && snapshot.bytes.equals(value);
  if (!snapshot.keys) return true;
  if (Object.getPrototypeOf(value) !== snapshot.prototype || snapshot.arrayLength !== undefined && value.length !== snapshot.arrayLength) return false;
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(snapshot.keys)) return false;
  return snapshot.keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && !descriptor.get && !descriptor.set && unchanged(snapshot.children.get(key), descriptor.value, seen);
  });
}
export function bindRegistration(read) {
  const snapshot = capture(read());
  let invalid = false;
  return { value: snapshot.copy, validate() {
    invalid ||= !unchanged(snapshot, read());
    if (invalid) throw new Error('HOST_IDENTITY_MISMATCH');
  } };
}
export function bindHostRegistration(host) {
  const keys = ['identity', 'captureHost', 'serviceUid', 'profile', 'dataRoot', 'minimumFreeBytes', 'runtime', 'dependencies'];
  const bindings = keys.map((key) => [key, bindRegistration(() => host?.[key])]);
  return { value: host ? Object.fromEntries(bindings.map(([key, binding]) => [key, binding.value])) : undefined,
    validate() { for (const [, binding] of bindings) binding.validate(); } };
}
function mismatch(checks, names) {
  for (const name of names) checks[name] = check('blocked', checks[name]?.impact ?? 'core', { code: 'HOST_IDENTITY_MISMATCH' },
    'Reconcile the current registered host and selected component configuration before another observation.');
}
// All emitted evidence is selected scalar data. Arbitrary adapter text, paths and errors never cross this boundary.
function check(status, impact, evidence, nextStep) {
  return { status, impact, evidence, observedAt: new Date().toISOString(), nextStep };
}
async function bounded(read, milliseconds = 5000) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(() => read(controller.signal)), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('DOCTOR_TIMEOUT')); }, milliseconds);
    })]);
  } finally { clearTimeout(timer); controller.abort(); }
}
export async function inspectLocalHost(registeredHost) {
  const binding = bindHostRegistration(registeredHost);
  const host = binding.value;
  const checks = {};
  const [major, minor] = process.versions.node.split('.').map(Number);
  checks.node_runtime = check(major > 26 || major === 26 && minor >= 13 ? 'ready' : 'blocked', 'core',
    { version: process.versions.node, platform: platform(), architecture: arch() }, 'Use the pinned supported Node runtime.');
  const uid = process.geteuid?.();
  checks.service_identity = check(!host ? 'unavailable' : uid === host.serviceUid && hostname() === host.captureHost ? 'ready' : 'blocked', 'core',
    { uid: uid ?? null, registered: Boolean(host), probe: 'current_process' }, 'Run under the registered service UID and capture host.');
  checks.host_registration = check(host ? 'ready' : 'unavailable', 'core', { registered: Boolean(host) },
    'Provision the independently registered host identity, configuration and authority ports.');
  checks.binding = check(host ? 'ready' : 'unavailable', 'core', { registered: Boolean(host) }, 'Confirm the account, workspace, domains, scope and configuration revision.');
  try {
    const { disk, safe } = await bounded(async () => {
      let safe = true;
      if (host) {
        const info = await lstat(host.dataRoot);
        safe = isAbsolute(host.dataRoot) && info.isDirectory() && !info.isSymbolicLink()
          && await realpath(host.dataRoot) === host.dataRoot && info.uid === host.serviceUid && !(info.mode & 0o022);
        await access(host.dataRoot, constants.R_OK | constants.W_OK | constants.X_OK);
      }
      return { disk: await statfs(host?.dataRoot ?? '/', { bigint: true }), safe };
    });
    const available = disk.bavail * disk.bsize;
    const required = host?.minimumFreeBytes;
    const configured = Number.isSafeInteger(required) && required > 0;
    checks.filesystem = check(!safe ? 'blocked' : !host || !configured ? 'unknown' : available >= BigInt(required) ? 'ready' : 'blocked', 'core',
      { probe: 'statfs', protectedRoot: safe, availableBytes: available.toString(), requiredBytes: configured ? String(required) : null },
      'Provision the registered data filesystem with the required free capacity.');
  } catch { checks.filesystem = check('unknown', 'core', { probe: 'statfs', code: 'FILESYSTEM_PROBE_UNAVAILABLE' }, 'Inspect the registered data filesystem with the service identity.'); }
  checks.headless_profile = check('unavailable', 'core', { code: 'HEADLESS_PROFILE_REQUIRED' }, 'Provision the protected registered Headless profile.');
  if (host?.profile) {
    try {
      const info = await bounded(async () => {
        if (!isAbsolute(host.profile)) throw new Error('invalid');
        const stat = await lstat(host.profile);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(host.profile) !== host.profile) throw new Error('invalid');
        await access(host.profile, constants.R_OK | constants.X_OK);
        return stat;
      });
      checks.headless_profile = check(info.uid === host.serviceUid && !(info.mode & 0o022) ? 'ready' : 'blocked', 'core',
        { ownerMatchesService: info.uid === host.serviceUid, protected: !(info.mode & 0o022) }, 'Restrict the registered Headless profile to its service identity.');
    } catch { checks.headless_profile = check('blocked', 'core', { code: 'HEADLESS_PROFILE_UNSAFE' }, 'Repair the protected registered Headless profile.'); }
  }
  checks.native_dependencies = check('unavailable', 'core', { code: 'NATIVE_RUNTIME_CONTRACT_REQUIRED' }, 'Install the built service bootstrap and target-native SQLite dependency.');
  if (host?.dependencies?.length > 0 && host.dependencies.length <= 16) {
    try {
      const findings = await bounded(() => Promise.all(host.dependencies.map(async (dependency) => {
        if (!/^[a-z0-9_-]{1,40}$/.test(dependency.id) || !isAbsolute(dependency.path)) throw new Error('invalid');
        const info = await lstat(dependency.path);
        return { id: dependency.id, present: info.isFile() && !info.isSymbolicLink() };
      })));
      checks.native_dependencies = check(findings.every((finding) => finding.present) ? 'unknown' : 'blocked', 'core',
        { files: findings, acceptance: 'requires_runtime_probe' }, 'Run the registered target-native runtime acceptance probes.');
    } catch { checks.native_dependencies = check('blocked', 'core', { code: 'NATIVE_DEPENDENCY_MISSING' }, 'Provision the registered native runtime dependencies.'); }
  }
  try { binding.validate(); } catch { mismatch(checks, Object.keys(checks).filter((name) => name !== 'node_runtime')); }
  return checks;
}
function backupReadiness(completed, offHostProtection) {
  return check(completed ? 'ready' : 'unknown', 'core',
    { localSet: completed ? 'completed' : 'unconfirmed', offHostProtection },
    offHostProtection === 'unverified' ? 'Verify retained off-host copies and recovery credential independence.'
      : 'Retain a verified local RecoverySet and its signed operation record.');
}

function bindColdData(read) {
  const value = structuredClone(read());
  return { value, validate() {
    if (!isDeepStrictEqual(value, structuredClone(read()))) throw new Error('HOST_IDENTITY_MISMATCH');
  } };
}

function bindColdBackup(host, liveRecovery) {
  const cold = host?.backupReadback;
  if (!cold) return;
  const readbacks = bindColdData(() => host.recoveryReadbacks
    .filter(({ targetId }) => !liveRecovery || Object.hasOwn(cold.targets, targetId))
    .map(({ targetId, backupOperationId, manifestHash }) => ({ targetId, backupOperationId, manifestHash })));
  if (readbacks.value.length === 0) return;
  const data = [readbacks, bindColdData(() => cold.root)];
  const verifierFields = (read) => [read, () => read()?.keyId, () => read()?.verify];
  const fields = [() => cold.root, () => cold.targets, ...verifierFields(() => cold.authority)];
  for (const targetId of new Set(readbacks.value.map((readback) => readback.targetId))) {
    const read = () => cold.targets && Object.hasOwn(cold.targets, targetId) ? cold.targets[targetId] : undefined;
    fields.push(read, () => read()?.root, () => read()?.scope, () => read()?.identity, () => read()?.readDatabase,
      ...verifierFields(() => read()?.authority), () => read()?.protection, () => read()?.protection?.kind);
    data.push(bindColdData(() => read()?.scope), bindColdData(() => read()?.identity));
    if (read()?.protection?.kind === 'off_host') fields.push(() => read()?.protection?.verify);
  }
  const bindings = [...fields.map(bindRegistration), ...data];
  // The reader needs the actual verifier receivers, including class instances.
  return { options: cold, readbacks: readbacks.value, validate() {
    if (host.backupReadback !== cold) throw new Error('HOST_IDENTITY_MISMATCH');
    for (const binding of bindings) binding.validate();
  } };
}

export async function doctor(host, vaultId) {
  const hostBinding = bindHostRegistration(host);
  const identity = hostBinding.value ? projectIdentity(hostBinding.value.identity) : undefined;
  const networkBinding = bindRegistration(() => host?.network);
  const recoveryBinding = bindRegistration(() => host?.recovery);
  const readbacksBinding = bindRegistration(() => host?.recoveryReadbacks);
  const runtime = hostBinding.value?.runtime;
  const recovery = recoveryBinding.value;
  const readbacks = readbacksBinding.value;
  let coldBinding;
  let coldBindingFailed = false;
  if (runtime?.createRecoveryBackupReader && readbacks?.length > 0 && readbacks.length <= 16) {
    try { coldBinding = bindColdBackup(host, recovery); }
    catch { coldBindingFailed = true; }
  }
  const vaultBinding = bindRegistration(() => host?.vaults && Object.hasOwn(host.vaults, vaultId) ? host.vaults[vaultId] : undefined);
  const originBinding = bindRegistration(() => host?.origin);
  const rpBinding = bindRegistration(() => host?.rpId);
  const readinessBindings = new Map(['service', 'executor', 'plugins', 'channels'].map((name) => [name, bindRegistration(() => host?.readiness?.[name])]));
  const validations = [];
  const checks = await inspectLocalHost(hostBinding.value);
  try { hostBinding.validate(); } catch {
    mismatch(checks, Object.keys(checks).filter((name) => name !== 'node_runtime'));
    return { ...(identity ? { identity } : {}), checks };
  }
  const validateNetwork = () => { hostBinding.validate(); networkBinding.validate(); originBinding.validate(); rpBinding.validate(); };
  const validateRecovery = () => { hostBinding.validate(); recoveryBinding.validate(); readbacksBinding.validate(); };
  const validateVault = () => { hostBinding.validate(); vaultBinding.validate(); };
  validations.push([validateNetwork, ['network', 'web_origin']], [validateRecovery, ['recovery', 'recovery_backup', 'recovery_drill']],
    [validateVault, ['obsidian_app', 'vault', 'vault_activity', 'vault_sync']]);
  checks.service = check('unavailable', 'core', { code: 'SERVICE_READBACK_REQUIRED' }, 'Provision independent service liveness and readiness readback.');
  checks.executor = check('unavailable', 'task', { code: 'EXECUTOR_PROBE_REQUIRED' }, 'Run the admitted executor CLI and tool probes in its isolated runtime.');
  checks.plugins = check('unavailable', 'task', { code: 'PLUGIN_CAPABILITIES_REQUIRED' }, 'Inspect the registered Headless and plugin capabilities.');
  checks.channels = check('unavailable', 'channel', { code: 'CHANNEL_READBACK_REQUIRED' }, 'Inspect channel receive, send and callback admission separately.');
  checks.network = check('unavailable', 'task', { code: 'NETWORK_POLICY_REQUIRED' }, 'Register the T21 device policy and read-only probe ports.');
  checks.web_origin = check('unavailable', 'core', { code: 'ORIGIN_TLS_REQUIRED' }, 'Register the fixed HTTPS origin, RP ID and trusted TLS probe.');
  const network = networkBinding.value;
  if (network) {
    if (!sameIdentity(identity, network.identity) || network.policy.device_id !== identity.deviceId) {
      checks.network = check('blocked', 'task', { code: 'HOST_IDENTITY_MISMATCH' }, 'Reconcile the T21 device and configuration revision.');
    } else if (runtime?.createNetworkInspector) {
      try {
        validateNetwork();
        const ports = network.ports ?? (network.node && runtime.createNodeNetworkProbePorts?.(network.node));
        if (!ports) throw new Error('ports missing');
        if (network.node && (network.node.localDeviceId !== identity.deviceId || network.node.policy !== network.policy)) throw new Error('mismatch');
        const report = await bounded((signal) => runtime.createNetworkInspector(network.policy, ports)(network.policy.targets.map(({ id }) => id), signal));
        validateNetwork();
        if (report.deviceId !== identity.deviceId || report.policyRevision !== network.policy.revision) throw new Error('mismatch');
        checks.network = check(report.targets.every((target) => target.outcome === 'healthy') ? 'ready' : 'blocked', 'task',
          { policyRevision: report.policyRevision, targets: report.targets.slice(0, 12).map((target) => ({
            outcome: target.outcome, role: target.role, tls: target.layers.tls, identity: target.layers.identity,
          })) }, 'Resolve the first failed T21 layer for the registered target.');
        const target = report.targets.find((target) => target.targetId === network.originTargetId);
        const origin = new URL(originBinding.value);
        const endpoint = network.node?.endpoints.find((endpoint) => endpoint.targetId === network.originTargetId);
        const boundOrigin = endpoint ? new URL(endpoint.url).origin : network.origin;
        const fixed = boundOrigin === origin.origin && origin.protocol === 'https:' && !origin.username && !origin.password && !origin.search && !origin.hash
          && origin.pathname === '/' && origin.hostname === rpBinding.value;
        checks.web_origin = check(!fixed || target?.layers.tls === 'failed' ? 'blocked' : target?.layers.tls === 'passed' ? 'ready' : 'unknown', 'core',
          { fixedOrigin: fixed, tls: target?.layers.tls ?? 'unknown', passkeyEnrollment: 'unverified' }, 'Verify fixed-origin TLS trust and enroll passkeys through the trusted channel.');
      } catch (error) {
        if (error.message === 'HOST_IDENTITY_MISMATCH') mismatch(checks, ['network', 'web_origin']);
        else checks.network = check('unknown', 'task', { code: 'NETWORK_PROBE_UNAVAILABLE' }, 'Inspect the registered T21 read-only probe runtime.');
      }
    }
  }
  checks.recovery = check('unavailable', 'core', { code: 'RECOVERY_RUNTIME_REQUIRED' }, 'Provision registered signed recovery targets, freeze authority and isolated drill ports.');
  if (runtime?.createRecoveryOperations && recovery) {
    const targets = Object.values(recovery.targets);
    const matching = targets.length > 0 && targets.length <= 16 && targets.every((target) => sameIdentity(identity, target.identity));
    checks.recovery = check(matching ? 'unknown' : 'blocked', 'core', { code: matching ? 'RECOVERY_READBACK_REQUIRED' : 'HOST_IDENTITY_MISMATCH',
      targets: Math.min(targets.length, 16) }, 'Read back a signed completed RecoverySet and its isolated drill before declaring backup readiness.');
  }
  checks.recovery_backup = check('unavailable', 'core', { code: 'SIGNED_BACKUP_READBACK_REQUIRED' }, 'Register a completed signed backup operation ID for readback.');
  checks.recovery_drill = check('unavailable', 'core', { code: 'SIGNED_DRILL_READBACK_REQUIRED' }, 'Register a completed signed isolated drill operation ID for readback.');
  let liveOffHostTargets = [];
  if (runtime?.createRecoveryOperations && recovery && readbacks?.length > 0 && readbacks.length <= 16) {
    try {
      validateRecovery();
      const operations = runtime.createRecoveryOperations(recovery);
      const reports = await bounded(() => Promise.all(readbacks.map(async (readback) => {
        const target = Object.hasOwn(recovery.targets, readback.targetId) ? recovery.targets[readback.targetId] : undefined;
        if (!target || !sameIdentity(identity, target.identity)) throw new Error('mismatch');
        validateRecovery();
        const backup = await operations.read({ operationId: readback.backupOperationId, targetId: readback.targetId, mode: 'backup' });
        validateRecovery();
        const drill = await operations.read({ operationId: readback.drillOperationId, targetId: readback.targetId, mode: 'drill', manifestHash: readback.manifestHash });
        validateRecovery();
        return { targetId: readback.targetId, backup: backup.status === 'completed' && backup.outcome.manifestHash === readback.manifestHash,
          offHostConfigured: Boolean(target.backup?.options.offHost),
          drill: drill.status === 'completed' && drill.outcome.manifestHash === readback.manifestHash && drill.outcome.receipt?.external_writes === 0 };
      })));
      validateRecovery();
      liveOffHostTargets = reports.filter((report) => report.offHostConfigured).map((report) => report.targetId);
      checks.recovery_backup = backupReadiness(reports.every((report) => report.backup),
        liveOffHostTargets.length > 0 ? 'unverified' : 'not_configured');
      checks.recovery_drill = check(reports.every((report) => report.drill) ? 'ready' : 'unknown', 'core',
        { isolatedDrill: reports.every((report) => report.drill) ? 'completed' : 'unconfirmed', writerActivation: 'unavailable' }, 'Retain the signed isolated drill receipt and separately provision activation authorities.');
    } catch (error) {
      if (error.message === 'HOST_IDENTITY_MISMATCH') mismatch(checks, ['recovery', 'recovery_backup', 'recovery_drill']);
      else {
        checks.recovery_backup = check('blocked', 'core', { code: 'SIGNED_RECOVERY_READBACK_FAILED' }, 'Reconcile the signed operation, manifest and registered identity.');
        checks.recovery_drill = check('blocked', 'core', { code: 'SIGNED_RECOVERY_READBACK_FAILED' }, 'Reconcile the signed drill receipt and consumed manifest identity.');
      }
    }
  }
  if (coldBindingFailed) mismatch(checks, ['recovery_backup']);
  if (coldBinding) {
    const { options: cold, readbacks: coldReadbacks } = coldBinding;
    const validateCold = () => { validateRecovery(); coldBinding.validate(); };
    validations.push([validateCold, ['recovery_backup']]);
    try {
      validateCold();
      if (hostBinding.value.captureHost !== hostname() || hostBinding.value.serviceUid !== process.geteuid?.()
        || !coldReadbacks.every(({ targetId }) => Object.hasOwn(cold.targets, targetId) && sameIdentity(identity, cold.targets[targetId].identity))) {
        throw new Error('HOST_IDENTITY_MISMATCH');
      }
      const reader = runtime.createRecoveryBackupReader(cold);
      validateCold();
      const verified = await bounded(() => Promise.all(coldReadbacks.map(async ({ targetId, backupOperationId, manifestHash }) => {
        validateCold();
        const backup = await reader.read({ operationId: backupOperationId, targetId, mode: 'backup' });
        validateCold();
        return { targetId, completed: backup.status === 'completed' && backup.outcome.manifestHash === manifestHash,
          offHostConfigured: cold.targets[targetId].protection?.kind === 'off_host' };
      })));
      validateCold();
      const liveBackup = checks.recovery_backup;
      if (liveBackup.status !== 'blocked') {
        const coldOffHost = verified.filter((report) => report.offHostConfigured);
        const offHostConfigured = liveOffHostTargets.length > 0 || coldOffHost.length > 0;
        const offHostVerified = coldOffHost.every((report) => report.completed)
          && liveOffHostTargets.every((targetId) => coldOffHost.some((report) => report.targetId === targetId));
        const offHostProtection = offHostConfigured ? (offHostVerified ? 'verified' : 'unverified') : 'not_configured';
        checks.recovery_backup = backupReadiness(
          verified.every((report) => report.completed) && (!recovery || liveBackup.status === 'ready'), offHostProtection);
      }
    } catch (error) {
      if (error?.message === 'HOST_IDENTITY_MISMATCH') mismatch(checks, ['recovery_backup']);
      else checks.recovery_backup = check('blocked', 'core', { code: 'SIGNED_RECOVERY_READBACK_FAILED' },
        'Reconcile the signed operation, manifest and registered identity.');
    }
  }
  for (const name of ['obsidian_app', 'vault', 'vault_activity', 'vault_sync']) checks[name] = check('unavailable', name === 'obsidian_app' ? 'editor' : 'task',
    { code: 'VAULT_REGISTRATION_REQUIRED' }, 'Select an independently registered T27 Vault and scope receipt.');
  const vault = vaultBinding.value;
  if (vault && runtime?.createObsidianDoctor) {
    try {
      validateVault();
      if (!sameIdentity(identity, vault.identity) || vault.options.captureHost !== hostBinding.value.captureHost || vault.options.serviceUid !== hostBinding.value.serviceUid) throw new Error('mismatch');
      let initialRecord;
      const loadVault = async (selectedId) => {
        validateVault();
        const record = await vault.options.loadVault(selectedId);
        validateVault();
        if (selectedId !== vaultId || record.account_id !== identity.accountId || !identity.domains.includes(record.data_domain)
          || record.vault_id !== vaultId || record.capture_host !== hostBinding.value.captureHost
          || record.config_revision !== vault.configRevision || record.scope_hash !== vault.scopeHash) throw new Error('HOST_IDENTITY_MISMATCH');
        const fields = ['source_id', 'data_domain', 'root_identity', 'physical_root', 'root_path', 'connection_epoch'];
        if (initialRecord && fields.some((field) => record[field] !== initialRecord[field])) throw new Error('HOST_IDENTITY_MISMATCH');
        initialRecord ??= structuredClone(record);
        return record;
      };
      const inspectVault = async (deviceId, selectedId) => {
        validateVault();
        const connection = await vault.options.inspectVault(deviceId, selectedId);
        validateVault();
        return connection;
      };
      await bounded(() => loadVault(vaultId));
      const report = await bounded(() => runtime.createObsidianDoctor({ ...vault.options, loadVault, inspectVault }).inspect(identity.deviceId, vaultId));
      validateVault();
      if (report.editor.deviceId !== identity.deviceId || report.connection && (report.connection.config_revision !== vault.configRevision
        || report.connection.scope_hash !== vault.scopeHash || report.connection.vault_id !== vaultId)) throw new Error('mismatch');
      checks.obsidian_app = check(report.editor.application.status === 'ready' ? 'ready' : 'blocked', 'editor',
        { application: report.editor.application.status, uri: report.editor.uri, process: report.editor.process }, 'Open the verified Obsidian application on the registered editing device.');
      checks.vault = check(report.connection?.status === 'connected' && Object.values(report.permissions).every((value) => value === 'allowed') ? 'ready' : 'blocked', 'task',
        { connection: report.connection?.status ?? 'unknown', permissions: report.permissions, configRevision: vault.configRevision }, 'Confirm the registered Vault roles with the actual service identity.');
      checks.vault_activity = check(report.recent?.collection && report.recent?.projection ? 'ready' : 'unknown', 'task',
        { collection: Boolean(report.recent?.collection), projection: Boolean(report.recent?.projection) }, 'Verify recent background collection and projection readback.');
      checks.vault_sync = check(report.sync === 'single_device' ? 'ready' : 'unknown', 'task', { mode: report.sync }, 'Keep single-device operation until the selected sync mechanism passes acceptance.');
    } catch (error) {
      if (error.message === 'HOST_IDENTITY_MISMATCH') mismatch(checks, ['obsidian_app', 'vault', 'vault_activity', 'vault_sync']);
      else checks.vault = check('blocked', 'task', { code: 'VAULT_BINDING_OR_PROBE_FAILED' }, 'Reconcile the registered Vault account, scope receipt, revision and actual permissions.');
    }
  }
  // A trusted controller may supply fixed read-only service/capability probes. Only finite states are projected.
  for (const name of ['service', 'executor', 'plugins', 'channels']) {
    const binding = readinessBindings.get(name);
    const validate = () => { hostBinding.validate(); binding.validate(); };
    validations.push([validate, [name]]);
    const probe = binding.value;
    if (!probe) continue;
    if (!sameIdentity(identity, probe.identity)) {
      checks[name] = check('blocked', checks[name].impact, { code: 'HOST_IDENTITY_MISMATCH' }, 'Reconcile the registered readiness probe identity.');
      continue;
    }
    try {
      validate();
      const report = await bounded(probe.inspect);
      validate();
      const fields = name === 'service' ? ['liveness', 'readiness'] : name === 'channels' ? ['receive', 'send', 'callback'] : ['capability'];
      if (!fields.every((field) => states.has(report[field]))) throw new Error('invalid');
      checks[name] = check(fields.every((field) => report[field] === 'ready') ? 'ready' : 'blocked', checks[name].impact,
        Object.fromEntries(fields.map((field) => [field, report[field]])), 'Resolve the registered capability prerequisite shown in this check.');
    } catch (error) {
      if (error.message === 'HOST_IDENTITY_MISMATCH') mismatch(checks, [name]);
      else checks[name] = check('unknown', checks[name].impact, { code: 'READINESS_PROBE_UNAVAILABLE' }, 'Inspect the registered read-only capability probe.');
    }
  }
  for (const [validate, names] of validations) {
    try { validate(); } catch { mismatch(checks, names); }
  }
  try { hostBinding.validate(); } catch { mismatch(checks, Object.keys(checks).filter((name) => name !== 'node_runtime')); }
  return { ...(identity ? { identity } : {}), checks };
}
