#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { hostname } from 'node:os';
import { doctor, sameIdentity, bindRegistration, bindHostRegistration, projectIdentity } from '../lib/doctor.mjs';
import { bindInstallPreviewEnrollment, installBootstrapRequirements, observeInstallSession, prepareFirstInstallGeneration, previewFirstInstall, runFirstInstallRelease } from '../runtime/install-preview.ts';
import { verifyRelease } from '../lib/release.mjs';
import { leased } from '../lib/emitted-release.mjs';

const commands = new Set(['init', 'doctor', 'install', 'start', 'stop', 'backup', 'restore', 'upgrade', 'uninstall']);
const lifecycleCommands = new Set(['init', 'install', 'start', 'stop', 'upgrade', 'uninstall']);
const id = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
function captureDataField(object, key) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) return;
  const chain = [];
  let descriptor;
  for (let at = object; at; at = Object.getPrototypeOf(at)) {
    chain.push({ object: at, prototype: Object.getPrototypeOf(at) });
    descriptor = Object.getOwnPropertyDescriptor(at, key);
    if (descriptor) break;
  }
  if (descriptor && !Object.hasOwn(descriptor, 'value')) throw new Error('HOST_IDENTITY_MISMATCH');
  const initial = descriptor, value = descriptor?.value;
  return { value, validate() {
    for (let index = 0; index < chain.length; index++) {
      const item = chain[index];
      if (Object.getPrototypeOf(item.object) !== item.prototype) throw new Error('HOST_IDENTITY_MISMATCH');
      const live = Object.getOwnPropertyDescriptor(item.object, key);
      if (index < chain.length - 1 || !initial) {
        if (live) throw new Error('HOST_IDENTITY_MISMATCH');
      } else if (!live || !Object.hasOwn(live, 'value') || !Object.is(live.value, value) ||
        live.configurable !== initial.configurable || live.enumerable !== initial.enumerable || live.writable !== initial.writable) {
        throw new Error('HOST_IDENTITY_MISMATCH');
      }
    }
  } };
}
// The registration binder preserves opaque class instances by reference. Trust
// inputs therefore need their own detached data snapshot and live descriptor
// checks, including every nested record and array.
function captureReleaseData(input) {
  const seen = new WeakMap(), checks = [];
  function copy(value, depth = 0) {
    if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return value;
    if (typeof value !== 'object' || depth > 64) throw new Error('HOST_IDENTITY_MISMATCH');
    if (seen.has(value)) return seen.get(value);
    const prototype = Object.getPrototypeOf(value);
    // A custom prototype may supply an inherited digest or evidence policy.
    // Only own-data records and ordinary arrays have a detached representation.
    if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype) {
      throw new Error('HOST_IDENTITY_MISMATCH');
    }
    const names = Object.getOwnPropertyNames(value).sort();
    if (Object.getOwnPropertySymbols(value).length) throw new Error('HOST_IDENTITY_MISMATCH');
    const descriptors = new Map();
    const output = Array.isArray(value) ? [] : Object.create(null);
    seen.set(value, output);
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('HOST_IDENTITY_MISMATCH');
      descriptors.set(name, descriptor);
      if (Array.isArray(value) && name === 'length') continue;
      Object.defineProperty(output, name, { value: copy(descriptor.value, depth + 1),
        enumerable: descriptor.enumerable, writable: true, configurable: true });
    }
    if (Array.isArray(value)) output.length = descriptors.get('length').value;
    checks.push(() => {
      if (Object.getPrototypeOf(value) !== prototype || Object.getOwnPropertySymbols(value).length ||
        JSON.stringify(Object.getOwnPropertyNames(value).sort()) !== JSON.stringify(names)) throw new Error('HOST_IDENTITY_MISMATCH');
      for (const [name, initial] of descriptors) {
        const live = Object.getOwnPropertyDescriptor(value, name);
        if (!live || !Object.hasOwn(live, 'value') || !Object.is(live.value, initial.value) ||
          live.configurable !== initial.configurable || live.enumerable !== initial.enumerable || live.writable !== initial.writable) {
          throw new Error('HOST_IDENTITY_MISMATCH');
        }
      }
    });
    return Object.freeze(output);
  }
  const value = copy(input);
  return { value, validate() { for (const check of checks) check(); } };
}
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
  let explicitAction = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!flag.startsWith('--') || seen.has(flag)) throw new Error('CLI_ARGUMENT_INVALID');
    seen.add(flag);
    const name = flag.slice(2);
    if (['preview', 'execute', 'readback', 'check-session', 'prepare-generation'].includes(name)) {
      if (explicitAction || command === 'doctor' && name !== 'preview' ||
        ['check-session', 'prepare-generation'].includes(name) && command !== 'install') throw new Error('CLI_ARGUMENT_INVALID');
      explicitAction = true;
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
  if (request.action === 'check-session') {
    if (!request.release || request.operation) throw new Error('CLI_ARGUMENT_INVALID');
  } else if (request.action !== 'preview' && !request.operation) throw new Error('CLI_ARGUMENT_INVALID');
  if (request.action === 'prepare-generation' && !request.release) throw new Error('CLI_ARGUMENT_INVALID');
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
function projectLifecycle(request, context, result) {
  if (result.status === 'completed') {
    const { evidenceId, claimSha256, evidenceSha256 } = result.receipt;
    return response(request, 'completed', 'LIFECYCLE_COMPLETED', 'Retain the signed lifecycle records and verified evidence.',
      { ...context, lifecycleReceipt: { evidenceId, claimSha256, evidenceSha256 } });
  }
  if (result.status === 'running_or_uncertain') return response(request, 'uncertain', 'LIFECYCLE_OUTCOME_UNCERTAIN',
    'Read the same operation ID without repeating its effects.', context);
  return response(request, result.status, 'LIFECYCLE_' + result.status.toUpperCase(),
    'Read back this registered operation ID after its authorized controller runs.', context);
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
    let vaultInit;
    let legacyVaultReadback;
    const typedInit = request.command === 'init' && request.operation && host?.vaultInitOperations;
    if (typedInit) {
      const selectVaultInit = host.runtime?.selectVaultInit;
      if (typeof selectVaultInit !== 'function') return response(request, 'unavailable', 'VAULT_INIT_ENROLLMENT_REQUIRED',
        'Provision the exact Vault operation and authority for this action.');
      const selected = selectVaultInit(host, request);
      if (selected?.legacy) legacyVaultReadback = selected.legacy;
      else vaultInit = selected;
    }
    const enrolledReadback = request.command === 'backup' && request.action === 'readback' && request.target
      ? host?.backupReadback : undefined;
    const readbackTargets = enrolledReadback?.targets;
    const coldTargetSelected = readbackTargets && Object.hasOwn(readbackTargets, request.target);
    const prepareGeneration = request.action === 'prepare-generation';
    const installOperations = request.command === 'install' && ['execute', 'readback', 'prepare-generation'].includes(request.action)
      ? host?.installOperations : undefined;
    const installSelected = installOperations && Object.hasOwn(installOperations, request.operation);
    const lifecycleReadbacks = request.action === 'readback' && lifecycleCommands.has(request.command)
      ? host?.lifecycleReadbacks : undefined;
    const lifecycle = legacyVaultReadback ? legacyVaultReadback.registration
      : lifecycleReadbacks && !vaultInit && !installSelected && Object.hasOwn(lifecycleReadbacks, request.operation)
        ? typedInit ? Object.getOwnPropertyDescriptor(lifecycleReadbacks, request.operation)?.value
          : lifecycleReadbacks[request.operation] : undefined;
    const lifecycleTarget = lifecycle?.plan?.targetId;
    const requestedTarget = request.command === 'init' ? request.vault
      : request.command === 'install' || request.command === 'upgrade' ? request.release : lifecycleTarget;
    const lifecycleSelected = lifecycleTarget && lifecycle.plan.command === request.command && lifecycleTarget === requestedTarget;
    if (!coldTargetSelected && !lifecycleSelected && !vaultInit?.publicRead && !(installSelected && request.action === 'readback')) {
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
    if (vaultInit) {
      let result;
      try { result = await vaultInit.run(() => hostBinding.validate()); }
      catch (error) {
        const code = Object.getOwnPropertyDescriptor(error ?? {}, 'message')?.value === 'HOST_IDENTITY_MISMATCH'
          ? 'HOST_IDENTITY_MISMATCH' : request.action === 'readback' ? 'LIFECYCLE_READBACK_FAILED' : 'VAULT_INIT_ADMISSION_FAILED';
        return response(request, 'blocked', code, 'Reconcile the enrolled plan, host, and signed records before continuing.', context);
      }
      if (result.status === 'unavailable') return response(request, 'unavailable', 'VAULT_INIT_ENROLLMENT_REQUIRED',
        'Provision the exact Vault operation and authority for this action.', context);
      const selected = { ...context, operationId: request.operation, vaultId: request.vault };
      if (result.status === 'preview') return response(request, 'preview', 'VAULT_INIT_KIT_PREVIEW',
        'Approve the exact retained plan through the trusted host controller.', { ...selected, vaultInitPreview: result.preview });
      return projectLifecycle(request, selected, result);
    }
    if (request.command === 'doctor') {
      const report = await doctor(host, request.vault);
      const ready = Object.values(report.checks).filter((check) => check.impact === 'core').every((check) => check.status === 'ready');
      return response(request, ready ? 'completed' : 'blocked', ready ? 'DOCTOR_READY' : 'DOCTOR_PREREQUISITES', 'Resolve each core prerequisite before service admission.', report);
    }
    if (lifecycleSelected) {
      const binding = bindRegistration(() => {
        if (legacyVaultReadback) {
          legacyVaultReadback.validate();
          return legacyVaultReadback.registration;
        }
        if (host.lifecycleReadbacks !== lifecycleReadbacks || !Object.hasOwn(lifecycleReadbacks, request.operation)
          || (typedInit ? Object.getOwnPropertyDescriptor(lifecycleReadbacks, request.operation)?.value
            : lifecycleReadbacks[request.operation]) !== lifecycle) throw new Error('HOST_IDENTITY_MISMATCH');
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
        return projectLifecycle(request, context, result);
      } catch {
        let code = 'LIFECYCLE_READBACK_FAILED';
        try { validate(); } catch { code = 'HOST_IDENTITY_MISMATCH'; }
        return response(request, 'blocked', code, 'Inspect the signed records and independent evidence through the trusted controller.', context);
      }
    }
    const installs = request.command === 'install' && request.release !== undefined
      ? host.installPreviews : undefined;
    const installEnrolled = installs && Object.hasOwn(installs, request.release);
    const checkSession = request.action === 'check-session';
    if (prepareGeneration && (!installSelected || !installEnrolled)) return response(request, 'unavailable',
      'INSTALL_GENERATION_ENROLLMENT_REQUIRED', 'Provision the release operation and first generation through the registered controller.', context);
    if (checkSession && !installEnrolled) return response(request, 'unavailable', 'INSTALL_SESSION_ENROLLMENT_REQUIRED',
      'Provision the exact install plan and session credential through the registered controller.', context);
    if (installSelected || (request.action === 'preview' || checkSession) && installEnrolled) {
      if (request.action === 'preview' && request.operation !== undefined) return response(request, 'invalid', 'CLI_ARGUMENT_INVALID',
        'Use install --release ID to preview this registration.');
      const enrollment = installs && Object.getOwnPropertyDescriptor(installs, request.release)?.value;
      const current = () => {
        hostBinding.validate();
        if (host.installPreviews !== installs || !enrollment || Object.getOwnPropertyDescriptor(installs, request.release)?.value !== enrollment) {
          throw new Error('HOST_IDENTITY_MISMATCH');
        }
        return enrollment;
      };
      const binding = bindInstallPreviewEnrollment(current);
      const selected = binding.value;
      const validate = () => {
        try { binding.validate(); } catch { throw new Error('HOST_IDENTITY_MISMATCH'); }
        if (!sameIdentity(identity, selected.identity) || selected.releaseId !== request.release ||
          selected.hostname !== host.captureHost || selected.uid !== host.serviceUid ||
          selected.deployment.origin !== host.origin || selected.tls.rpId !== host.rpId) throw new Error('HOST_IDENTITY_MISMATCH');
      };
      validate();
      if (installSelected) {
        if (hostBinding.value.runtime?.runFirstInstallRelease !== runFirstInstallRelease) return response(request, 'unavailable',
          'INSTALL_RELEASE_RUNTIME_REQUIRED', 'Provision the registered first-install controller.', context);
        const operation = Object.getOwnPropertyDescriptor(installOperations, request.operation)?.value;
        if (!operation || ![Object.prototype, null].includes(Object.getPrototypeOf(operation))) throw new Error('HOST_IDENTITY_MISMATCH');
        const operationBinding = bindRegistration(() => {
          if (host.installOperations !== installOperations ||
            Object.getOwnPropertyDescriptor(installOperations, request.operation)?.value !== operation ||
            host.lifecycleReadbacks && Object.hasOwn(host.lifecycleReadbacks, request.operation)) throw new Error('HOST_IDENTITY_MISMATCH');
          return operation;
        });
        const signing = captureDataField(operation, 'signJournal');
        const validateOperation = () => { validate(); operationBinding.validate(); signing.validate(); };
        const run = { ...operationBinding.value };
        if (typeof signing.value === 'function') run.signJournal = async (bytes) => {
          validateOperation();
          const signature = await Reflect.apply(signing.value, operation, [bytes]);
          validateOperation();
          return signature;
        };
        const details = { ...context, operationId: request.operation };
        if (prepareGeneration) {
          if (!run.generation || hostBinding.value.runtime?.prepareFirstInstallGeneration !== prepareFirstInstallGeneration) {
            return response(request, 'unavailable', 'INSTALL_GENERATION_ENROLLMENT_REQUIRED',
              'Provision the fixed Autoloop kernel and first generation through the registered controller.', details);
          }
          try {
            const generation = await prepareFirstInstallGeneration(current, request.release, request.operation, run, validateOperation);
            return response(request, 'completed', 'INSTALL_GENERATION_PREPARED',
              'Retain the generation evidence and complete the remaining bootstrap checks.', {
                ...details, generationId: generation.id,
                prerequisites: installBootstrapRequirements.filter(requirement => requirement !== 'schema-bootstrap'),
              });
          } catch (error) {
            if (error instanceof Error && error.message === 'INSTALL_GENERATION_SIGNER_REQUIRED') {
              return response(request, 'unavailable', 'INSTALL_GENERATION_SIGNER_REQUIRED',
                'Provision the enrolled journal signer to prepare the first generation.', details);
            }
            if (error instanceof Error && error.message === 'INSTALL_GENERATION_INTERRUPTED') {
              return response(request, 'uncertain', 'INSTALL_GENERATION_INTERRUPTED',
                'Read back the same generation and inspect any incomplete staging directory through the controller.', details);
            }
            return response(request, 'blocked', 'INSTALL_GENERATION_ADMISSION_FAILED',
              'Inspect the authenticated release publication, kernel source and generation layout.', details);
          }
        }
        let result;
        try {
          validateOperation();
          result = await runFirstInstallRelease(current, request.release, request.operation, request.action, run, validateOperation);
        } catch {
          return response(request, 'blocked', 'INSTALL_RELEASE_ADMISSION_FAILED',
            'Reconcile the signed release plan, host registration, and retained operation records.', details);
        }
        if (result.status === 'approval-required') return response(request, 'unavailable', 'INSTALL_RELEASE_APPROVAL_REQUIRED',
          'Approve the exact release preview and operation ID through the enrolled controller.', details);
        if (result.status === 'completed') return response(request, 'completed', 'INSTALL_RELEASE_PUBLISHED',
          'Retain the publication receipt and complete the registered host bootstrap.', {
            ...details, lifecycleReceipt: result.receipt, prerequisites: installBootstrapRequirements,
          });
        return projectLifecycle(request, details, result);
      }
      // Only the specific module installed by trusted provisioning can select this route.
      // Never execute a function selected by registration, command input or candidate contents.
      const probe = checkSession ? observeInstallSession : previewFirstInstall;
      const registeredProbe = checkSession ? hostBinding.value.runtime?.observeInstallSession : hostBinding.value.runtime?.previewFirstInstall;
      if (registeredProbe !== probe) return response(request, 'unavailable',
        checkSession ? 'INSTALL_SESSION_RUNTIME_REQUIRED' : 'INSTALL_PREVIEW_RUNTIME_REQUIRED',
        'Provision the registered controller with its first-install verifier.', context);
      const result = await probe(() => { validate(); return enrollment; }, request.release);
      validate();
      if (result.status === 'blocked') return response(request, 'blocked', result.code,
        'Inspect the registered release and physical installation prerequisites.', context);
      const { phase, installationId, releaseId, packageSha256, planSha256, activeSchema, targetSchema,
        firstGenerationId, volumes, outstanding, activationAuthorized, delegationAuthorized } = result;
      const report = { phase, installationId, releaseId, packageSha256, planSha256, activeSchema, targetSchema,
        ...(firstGenerationId === undefined ? {} : { firstGenerationId }),
        volumes, outstanding, activationAuthorized, delegationAuthorized };
      if (result.status === 'session-observed') {
        const { credentialBindingSha256, observed } = result;
        return response(request, 'completed', 'INSTALL_SESSION_OBSERVED',
          'Retain the session observation and verify schema bootstrap and owner passkey enrollment.', {
            ...context, installSession: { ...report, credentialBindingSha256, observed },
          });
      }
      return response(request, 'preview', 'INSTALL_BOOTSTRAP_PREVIEW',
        'Retain the plan digest and complete the outstanding bootstrap checks through the enrolled controller.', {
          ...context, installPreview: report,
        });
    }
    if (['install', 'upgrade'].includes(request.command)) {
      const entries = host.releases;
      const selected = () => {
        if (host.releases !== entries) throw new Error('HOST_IDENTITY_MISMATCH');
        const row = entries && Object.getOwnPropertyDescriptor(entries, request.release);
        if (row && !Object.hasOwn(row, 'value')) throw new Error('HOST_IDENTITY_MISMATCH');
        return row?.value;
      };
      const originalRelease = selected();
      const releaseBinding = bindRegistration(() => {
        const live = selected();
        if (live !== originalRelease) throw new Error('HOST_IDENTITY_MISMATCH');
        return live;
      });
      const release = releaseBinding.value;
      if (!release) return response(request, 'unavailable', 'RELEASE_REGISTRATION_REQUIRED', 'Select an independently registered exact release candidate.', context);
      const identityField = captureDataField(originalRelease, 'identity');
      const candidateField = captureDataField(originalRelease, 'candidatePath');
      const expectedField = captureDataField(originalRelease, 'expected');
      const policyField = captureDataField(originalRelease, 'policy');
      const identityData = captureReleaseData(identityField?.value);
      const expectedData = captureReleaseData(expectedField?.value);
      const policyData = captureReleaseData(policyField?.value);
      const stagingField = captureDataField(originalRelease, 'staging');
      const staging = stagingField?.value;
      const ownerMethod = captureDataField(staging, 'withExclusiveReadRoot');
      const validate = () => {
        hostBinding.validate(); releaseBinding.validate();
        identityField?.validate(); candidateField?.validate(); expectedField?.validate(); policyField?.validate();
        identityData.validate(); expectedData.validate(); policyData.validate(); stagingField?.validate(); ownerMethod?.validate();
      };
      if (!sameIdentity(identity, identityData.value)) return response(request, 'blocked', 'HOST_IDENTITY_MISMATCH', 'Reconcile the registered release configuration revision.', context);
      if (typeof ownerMethod?.value !== 'function') return response(request, 'unavailable', 'CONTROLLED_STAGING_REQUIRED',
        'Provision a physical staging root with exclusive trusted control of the tree and ancestors throughout verification.', context);
      if (request.action === 'readback') return response(request, 'unavailable', 'LIFECYCLE_READBACK_REQUIRED', 'Provision the durable installed lifecycle readback authority.', context);
      try {
        // Only the trusted staging owner can supply the physical root while holding its exclusive lease.
        validate();
        const verified = await leased(staging, async lease => {
          validate();
          const result = await verifyRelease(candidateField?.value, { policy: policyData.value, expected: expectedData.value,
            readRoot: lease.root, validate: lease.guard });
          validate();
          return result;
        }, true, validate);
        validate();
        if (!verified) throw new Error('unverified');
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
