#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { hostname } from 'node:os';
import { doctor, sameIdentity, bindRegistration, bindHostRegistration, projectIdentity } from '../lib/doctor.mjs';
import { verifyRelease } from '../lib/release.mjs';

const commands = new Set(['init', 'doctor', 'install', 'start', 'stop', 'backup', 'restore', 'upgrade', 'uninstall']);
const lifecycleCommands = new Set(['init', 'install', 'start', 'stop', 'upgrade', 'uninstall']);
const id = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const commandOptions = {
  init: ['vault'], doctor: ['vault'], install: ['release'], start: [], stop: [],
  backup: ['target'], restore: ['target', 'manifest', 'mode'], upgrade: ['release'], uninstall: [],
};
export function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length > 17 || argv.some((part) => typeof part !== 'string' || part.length > 128)) throw new Error('CLI_ARGUMENT_INVALID');
  const [command, ...args] = argv;
  if (!commands.has(command)) throw new Error('CLI_ARGUMENT_INVALID');
  const request = { command, action: 'preview' };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!flag.startsWith('--') || seen.has(flag)) throw new Error('CLI_ARGUMENT_INVALID');
    seen.add(flag);
    const name = flag.slice(2);
    if (['preview', 'execute', 'readback'].includes(name)) {
      if (seen.has('--preview') + seen.has('--execute') + seen.has('--readback') > 1 || command === 'doctor' && name !== 'preview') throw new Error('CLI_ARGUMENT_INVALID');
      request.action = name;
      continue;
    }
    if (![...commandOptions[command], 'operation'].includes(name) || command === 'doctor' && name === 'operation') throw new Error('CLI_ARGUMENT_INVALID');
    const value = args[++index];
    if (name === 'manifest' ? !/^[a-f0-9]{64}$/.test(value ?? '') : !id.test(value ?? '')) throw new Error('CLI_ARGUMENT_INVALID');
    request[name] = value;
  }
  if (command === 'restore') {
    if (request.mode !== undefined && request.mode !== 'drill') throw new Error('CLI_ARGUMENT_INVALID');
    request.mode = 'drill';
  }
  if (request.action !== 'preview' && !request.operation) throw new Error('CLI_ARGUMENT_INVALID');
  return Object.freeze(request);
}
function response(request, status, code, nextStep, extra = {}) {
  const exitCode = { completed: 0, preview: 0, invalid: 2, unavailable: 3, uncertain: 4, blocked: 5, absent: 6, reserved: 6 }[status];
  return { command: request.command, action: request.action, status, code, nextStep, ...extra, exitCode };
}
const errorCodes = new Set(['HOST_IDENTITY_MISMATCH', 'RECOVERY_OPERATION_RECORD_INVALID', 'RECOVERY_OPERATION_BINDING_MISMATCH',
  'RECOVERY_SIGNATURE_INVALID', 'RECOVERY_MANIFEST_HASH_MISMATCH', 'RECOVERY_OPERATION_UNAVAILABLE', 'RECOVERY_SYMLINK_FORBIDDEN']);

function projectRecovery(request, context, operation, validate, result) {
  try { validate(); } catch {
    return response(request, result.status === 'running_or_uncertain' ? 'uncertain' : 'blocked', 'HOST_IDENTITY_MISMATCH',
      'Reconcile the current registration and read the same signed operation without repeating effects.', context);
  }
  if (result.status === 'completed') return response(request, 'completed', 'RECOVERY_COMPLETED', 'Retain the signed operation and RecoverySet records.', {
    ...context, manifestHash: result.outcome.manifestHash, mode: operation.mode,
    ...(operation.mode === 'drill' && result.outcome.receipt ? { externalWrites: result.outcome.receipt.external_writes } : {}),
  });
  if (result.status === 'running_or_uncertain') return response(request, 'uncertain', 'RECOVERY_OUTCOME_UNCERTAIN', 'Read back this operation ID without repeating its effects.', context);
  return response(request, result.status, 'RECOVERY_' + result.status.toUpperCase(), 'Use the same operation ID for the next authorized execute or readback.', context);
}
/** Fixed adapter for the trusted lifecycle controller. The CLI never promotes a kit receipt to host enrollment. */
export function createVaultKitAdapter(host) {
  return { async install(vaultId) {
    const hostBinding = bindHostRegistration(host);
    const binding = bindRegistration(() => host.vaults && Object.hasOwn(host.vaults, vaultId) ? host.vaults[vaultId] : undefined);
    const registration = binding.value;
    const options = registration?.installer;
    const identity = hostBinding.value.identity;
    const validate = () => { hostBinding.validate(); binding.validate(); };
    if (!registration || !options || !host.runtime?.createVaultKitInstaller) throw new Error('VAULT_INSTALLER_RUNTIME_REQUIRED');
    if (!sameIdentity(identity, registration.identity) || options.deviceId !== identity.deviceId
      || options.captureHost !== host.captureHost || options.serviceUid !== host.serviceUid) throw new Error('HOST_IDENTITY_MISMATCH');
    const loadVault = async (id) => {
      validate();
      const vault = await options.loadVault(id);
      validate();
      if (!sameIdentity(identity, host.identity) || !sameIdentity(identity, registration.identity)
        || vault.vault_id !== vaultId || vault.account_id !== identity.accountId || !identity.domains.includes(vault.data_domain)
        || vault.config_revision !== registration.configRevision || vault.scope_hash !== registration.scopeHash) throw new Error('HOST_IDENTITY_MISMATCH');
      return vault;
    };
    const inspectVault = async (deviceId, id) => {
      validate();
      const connection = await options.inspectVault(deviceId, id);
      validate();
      return connection;
    };
    validate();
    const receipt = await hostBinding.value.runtime.createVaultKitInstaller({ ...options, loadVault, inspectVault }).installVaultKit(vaultId);
    validate();
    await loadVault(vaultId);
    if (receipt.vaultId !== vaultId || receipt.configRevision !== registration.configRevision || receipt.scopeHash !== registration.scopeHash
      || !/^[a-f0-9]{64}$/.test(receipt.manifestSha256)) throw new Error('VAULT_RECEIPT_INVALID');
    return { vaultId: receipt.vaultId, configRevision: receipt.configRevision, scopeHash: receipt.scopeHash, manifestSha256: receipt.manifestSha256 };
  } };
}
export function createPatrickCli(host, checkLiveStorage) {
  async function runCommand(request) {
    const enrolledReadback = request.command === 'backup' && request.action === 'readback' && request.target
      ? host?.backupReadback : undefined;
    const readbackTargets = enrolledReadback?.targets;
    const coldTargetSelected = readbackTargets && Object.hasOwn(readbackTargets, request.target);
    const lifecycleReadbacks = request.action === 'readback' && lifecycleCommands.has(request.command)
      ? host?.lifecycleReadbacks : undefined;
    const lifecycle = lifecycleReadbacks && Object.hasOwn(lifecycleReadbacks, request.operation)
      ? lifecycleReadbacks[request.operation] : undefined;
    const lifecycleTarget = lifecycle?.plan?.targetId;
    const requestedTarget = request.command === 'init' ? request.vault
      : request.command === 'install' || request.command === 'upgrade' ? request.release : lifecycleTarget;
    const lifecycleSelected = lifecycleTarget && lifecycle.plan.command === request.command && lifecycleTarget === requestedTarget;
    if (!coldTargetSelected && !lifecycleSelected) {
      const blocked = checkLiveStorage?.();
      if (blocked) return blocked;
    }
    if (!host) return response(request, 'unavailable', 'HOST_REGISTRATION_REQUIRED',
      'Provision an independently registered host bootstrap with trusted runtime and authority ports.',
      request.command === 'doctor' ? await doctor() : {});
    const hostBinding = bindHostRegistration(host);
    const identity = hostBinding.value.identity;
    const context = { identity: projectIdentity(identity) };
    if (request.command !== 'doctor' && (host.serviceUid !== process.geteuid?.() || host.captureHost !== hostname())) {
      return response(request, 'blocked', 'HOST_SERVICE_IDENTITY_MISMATCH', 'Run the trusted controller under the registered service UID and capture host.', context);
    }
    if (request.command === 'doctor') {
      const report = await doctor(host, request.vault);
      const ready = Object.values(report.checks).filter((check) => check.impact === 'core').every((check) => check.status === 'ready');
      return response(request, ready ? 'completed' : 'blocked', ready ? 'DOCTOR_READY' : 'DOCTOR_PREREQUISITES', 'Resolve each core prerequisite before service admission.', report);
    }
    if (lifecycleSelected) {
      const binding = bindRegistration(() => {
        if (host.lifecycleReadbacks !== lifecycleReadbacks || !Object.hasOwn(lifecycleReadbacks, request.operation)
          || lifecycleReadbacks[request.operation] !== lifecycle) throw new Error('HOST_IDENTITY_MISMATCH');
        return lifecycle;
      });
      const selected = binding.value;
      if (!sameIdentity(identity, selected.identity) || selected.plan.command !== request.command
        || selected.plan.targetId !== lifecycleTarget) return response(request, 'blocked', 'HOST_IDENTITY_MISMATCH',
        'Reconcile the registered lifecycle command and configuration revision.', context);
      const createReader = hostBinding.value.runtime?.createLifecycleJournalReader;
      if (typeof createReader !== 'function') return response(request, 'unavailable', 'LIFECYCLE_READBACK_REQUIRED',
        'Install the verification-only lifecycle journal reader.', context);
      const validate = () => { hostBinding.validate(); binding.validate(); };
      try {
        validate();
        const reader = createReader(() => {
          validate();
          return lifecycle;
        });
        validate();
        const { expectedGeneration, planSha256 } = selected.plan;
        const result = await reader.read({ operationId: request.operation, command: request.command,
          targetId: lifecycleTarget, expectedGeneration, planSha256 });
        validate();
        if (result.status === 'completed') {
          const { evidenceId, claimSha256, evidenceSha256 } = result.receipt;
          return response(request, 'completed', 'LIFECYCLE_COMPLETED', 'Retain the signed lifecycle records and verified evidence.',
            { ...context, lifecycleReceipt: { evidenceId, claimSha256, evidenceSha256 } });
        }
        if (result.status === 'running_or_uncertain') return response(request, 'uncertain', 'LIFECYCLE_OUTCOME_UNCERTAIN',
          'Read the same operation ID without repeating its effects.', context);
        return response(request, result.status, 'LIFECYCLE_' + result.status.toUpperCase(),
          'Read back this registered operation ID after its authorized controller runs.', context);
      } catch {
        let code = 'LIFECYCLE_READBACK_FAILED';
        try { validate(); } catch { code = 'HOST_IDENTITY_MISMATCH'; }
        return response(request, 'blocked', code, 'Inspect the signed records and independent evidence through the trusted controller.', context);
      }
    }
    if (['install', 'upgrade'].includes(request.command)) {
      const releaseBinding = bindRegistration(() => host.releases && Object.hasOwn(host.releases, request.release) ? host.releases[request.release] : undefined);
      const release = releaseBinding.value;
      const validate = () => { hostBinding.validate(); releaseBinding.validate(); };
      if (!release) return response(request, 'unavailable', 'RELEASE_REGISTRATION_REQUIRED', 'Select an independently registered exact release candidate.', context);
      if (!sameIdentity(identity, release.identity)) return response(request, 'blocked', 'HOST_IDENTITY_MISMATCH', 'Reconcile the registered release configuration revision.', context);
      if (typeof release.staging?.withExclusiveReadRoot !== 'function') return response(request, 'unavailable', 'CONTROLLED_STAGING_REQUIRED',
        'Provision a physical staging root with exclusive trusted control of the tree and ancestors throughout verification.', context);
      if (request.action === 'readback') return response(request, 'unavailable', 'LIFECYCLE_READBACK_REQUIRED', 'Provision the durable installed lifecycle readback authority.', context);
      try {
        // Only the trusted staging owner can supply the physical root while holding its exclusive lease.
        validate();
        let verified;
        const returned = await release.staging.withExclusiveReadRoot(async (readRoot) => {
          validate();
          verified = await verifyRelease(release.candidatePath, { policy: release.policy, expected: release.expected, readRoot });
          validate();
          return verified;
        });
        validate();
        if (!verified || returned !== verified) throw new Error('unverified');
        const candidate = { sha256: verified.sha256, manifestSha256: verified.manifestSha256, installable: false, runtime: 'unavailable' };
        return response(request, request.action === 'preview' ? 'preview' : 'unavailable',
          request.action === 'preview' ? 'RELEASE_CANDIDATE_PREVIEW' : 'RELEASE_RUNTIME_REQUIRED',
          'Provision the installed service, hub/worker bootstrap, target-native SQLite and native host acceptance before lifecycle execution.', { ...context, candidate });
      } catch (error) { return response(request, 'blocked', error.message === 'HOST_IDENTITY_MISMATCH' ? error.message : 'RELEASE_VERIFICATION_FAILED',
        'Inspect the current registration, pinned trust policy, candidate bytes and controlled staging through the trusted controller.', context); }
    }
    if (request.command === 'init') {
      if (!request.vault) return response(request, 'unavailable', 'INIT_SELECTION_REQUIRED', 'Register the workspace, Vault, data domains and required identity through the trusted enrollment channel.', context);
      const report = await doctor(host, request.vault);
      if (report.checks.vault?.status !== 'ready') return response(request, 'blocked', 'VAULT_INITIALIZATION_BLOCKED', 'Reconcile the registered Vault scope and service-identity permissions.', report);
      return response(request, request.action === 'preview' ? 'preview' : 'unavailable',
        request.action === 'preview' ? 'VAULT_INITIALIZATION_PREVIEW' : 'LIFECYCLE_RUNTIME_REQUIRED',
        'Use the registered lifecycle controller to install the shared T27 Vault kit and complete trusted enrollment with durable readback.', report);
    }
    if (coldTargetSelected) {
      const readbackBinding = bindRegistration(() => {
        if (host.backupReadback !== enrolledReadback || enrolledReadback.targets !== readbackTargets) throw new Error('HOST_IDENTITY_MISMATCH');
        return enrolledReadback;
      });
      const readback = readbackBinding.value;
      const readbackTarget = Object.hasOwn(readback.targets, request.target) ? readback.targets[request.target] : undefined;
      const validate = () => { hostBinding.validate(); readbackBinding.validate(); };
      if (!sameIdentity(identity, readbackTarget?.identity)) return response(request, 'blocked', 'HOST_IDENTITY_MISMATCH',
        'Reconcile the registered backup readback identity and revision.', context);
      const createReader = hostBinding.value.runtime?.createRecoveryBackupReader;
      if (typeof createReader !== 'function') return response(request, 'unavailable', 'RECOVERY_RUNTIME_REQUIRED',
        'Install the verification-only backup readback runtime.', context);
      const operation = { operationId: request.operation, targetId: request.target, mode: 'backup' };
      try {
        validate();
        const reader = createReader(readback);
        validate();
        const result = await reader.read(operation);
        return projectRecovery(request, context, operation, validate, result);
      } catch (error) {
        const message = Object.getOwnPropertyDescriptor(error ?? {}, 'message')?.value;
        let code = message === 'RECOVERY_OFF_HOST_UNCONFIRMED' || errorCodes.has(message) ? message : 'RECOVERY_OPERATION_FAILED';
        try { validate(); } catch { code = 'HOST_IDENTITY_MISMATCH'; }
        return response(request, 'blocked', code, 'Inspect the signed backup records through the trusted host controller.', context);
      }
    }
    if (['backup', 'restore'].includes(request.command)) {
      const recoveryBinding = bindRegistration(() => host.recovery);
      const recovery = recoveryBinding.value;
      const target = recovery && Object.hasOwn(recovery.targets, request.target) ? recovery.targets[request.target] : undefined;
      const validate = () => {
        hostBinding.validate();
        recoveryBinding.validate();
        const selected = host.recovery && Object.hasOwn(host.recovery.targets, request.target) ? host.recovery.targets[request.target] : undefined;
        if (!selected || !sameIdentity(context.identity, selected.identity)) throw new Error('HOST_IDENTITY_MISMATCH');
      };
      if (!target) return response(request, 'unavailable', 'RECOVERY_TARGET_REQUIRED', 'Select an independently registered recovery target.', context);
      if (!sameIdentity(identity, target.identity)) return response(request, 'blocked', 'HOST_IDENTITY_MISMATCH', 'Reconcile the registered recovery target identity and revision.', context);
      if (!host.runtime?.createRecoveryOperations) return response(request, 'unavailable', 'RECOVERY_RUNTIME_REQUIRED', 'Install the built recovery runtime and registered authority ports.', context);
      if (request.command === 'restore' && !request.manifest) return response(request, 'invalid', 'RECOVERY_MANIFEST_REQUIRED', 'Select the verified RecoverySet manifest digest.', context);
      const operation = { operationId: request.operation, targetId: request.target, mode: request.command === 'backup' ? 'backup' : 'drill',
        ...(request.manifest ? { manifestHash: request.manifest } : {}) };
      if (request.action === 'preview') return response(request, 'preview', 'RECOVERY_PREVIEW',
        request.command === 'restore' ? 'Execute an isolated restore drill with a stable operation ID.' : 'Execute the registered backup with a stable operation ID.',
        { ...context, mode: operation.mode, target: request.target });
      let operations;
      const project = (result) => projectRecovery(request, context, operation, validate, result);
      try {
        validate();
        operations = hostBinding.value.runtime.createRecoveryOperations(recovery);
        validate();
        if (request.action === 'readback') return project(await operations.read(operation));
        const prior = await operations.read(operation);
        validate();
        if (prior.status === 'completed' || prior.status === 'running_or_uncertain') return project(prior);
        await operations.reserve(operation);
        validate();
        return project(await operations.run(operation, validate));
      } catch (error) {
        // A durable claim may have reached the effect even when its response was lost.
        try {
          const observed = await operations?.read(operation);
          if (observed?.status === 'running_or_uncertain') return project(observed);
        } catch { /* Invalid signed records remain blocked. */ }
        let code = errorCodes.has(error?.message) ? error.message : 'RECOVERY_OPERATION_FAILED';
        try { validate(); } catch { code = 'HOST_IDENTITY_MISMATCH'; }
        return response(request, 'blocked', code, 'Inspect the signed recovery records through the trusted host controller.', context);
      }
    }
    const prerequisites = {
      start: ['installed-service-hub-worker-bootstrap', 'live-writer-admission-handle', 'owned-process-readback'],
      stop: ['writer-drain-and-fence-authority', 'owned-process-stop-and-readback'],
      uninstall: ['owned-installation-inventory', 'durable-stop-and-removal-readback', 'retain-data-vault-and-shared-credentials'],
    }[request.command];
    return response(request, 'unavailable', request.command.toUpperCase() + '_RUNTIME_REQUIRED',
      'Provision the registered lifecycle controller and its command-specific durable authority ports.', { ...context, prerequisites });
  }
  return { async run(argv) {
    let request;
    try { request = parseArguments(argv); }
    catch { return checkLiveStorage?.() ?? { status: 'invalid', code: 'CLI_ARGUMENT_INVALID', exitCode: 2 }; }
    try { return await runCommand(request); }
    catch (error) {
      // Recovery handles signed claims inside runCommand before this public boundary.
      // Read only an own data property, excluding exception accessors and raw messages.
      let code = 'CLI_CONTEXT_INVALID';
      try {
        if (Object.getOwnPropertyDescriptor(error ?? {}, 'message')?.value === 'HOST_IDENTITY_MISMATCH') code = 'HOST_IDENTITY_MISMATCH';
      } catch { /* Uninspectable exceptions receive the fixed context refusal. */ }
      return response(request, 'blocked', code, 'Repair the trusted host registration before the next command or readback.');
    }
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await createPatrickCli().run(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.exitCode;
}
