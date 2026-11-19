import { createHash } from 'node:crypto';
import { isAbsolute, parse, resolve } from 'node:path';
import { canonicalize } from '../lib/release.mjs';
import type { CliRequest } from '../cli/patrick.mjs';
import { bindRegistration, projectIdentity, sameIdentity, type RegisteredHost } from '../lib/doctor.mjs';
import type { ExclusiveRuntimeStaging } from '../lib/emitted-release.mjs';
import { createVaultInitController, createVaultInitReader, vaultInitApproval, type VaultInitEnrollment, type VaultInitPlan } from './vault-init.js';
import type { LifecycleRegistration } from './lifecycle-journal.js';

type Signer = Parameters<typeof createVaultInitController>[3];
type Common = { format: 'patrick-installed-vault-init-v1'; enrollment: VaultInitEnrollment; owner: ExclusiveRuntimeStaging };
export type VaultInitCliEntry = Common & (
  { mode: 'preview'; signer: Signer } | { mode: 'approved'; signer: Signer; plan: VaultInitPlan; approval: string } |
  { mode: 'readback'; plan: VaultInitPlan }
);
export type VaultInitCliPreview = { phase: 'vault-kit'; operationId: string; vaultId: string; kitVersion: string; manifestSha256: string; planSha256: string };

function requireMatch(value: unknown): asserts value { if (!value) throw Error('HOST_IDENTITY_MISMATCH'); }
function own<T extends object, K extends keyof T>(object: T, key: K): T[K] {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  requireMatch(descriptor && Object.hasOwn(descriptor, 'value'));
  return descriptor.value;
}
function captureField<T extends object, K extends keyof T>(object: T, key: K, optional = false) {
  const chain: Array<{ object: object; prototype: object | null }> = [];
  let descriptor: PropertyDescriptor | undefined;
  for (let current: object | null = object; current; current = Object.getPrototypeOf(current)) {
    chain.push({ object: current, prototype: Object.getPrototypeOf(current) });
    descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) break;
  }
  requireMatch(descriptor ? Object.hasOwn(descriptor, 'value') : optional);
  const value = descriptor?.value as T[K];
  return { value, validate() {
    for (let index = 0; index < chain.length; index++) {
      const item = chain[index]!;
      requireMatch(Object.getPrototypeOf(item.object) === item.prototype);
      const current = Object.getOwnPropertyDescriptor(item.object, key);
      if (index < chain.length - 1 || !descriptor) requireMatch(!current);
      else requireMatch(current && Object.hasOwn(current, 'value') && Object.is(current.value, value));
    }
  } };
}
const token = (s: string) => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(s);
const digest = (s: string) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s) && s.length === 64;
// The retained evidence crosses a trust boundary as plain data. Opaque ports
// are checked separately and are always invoked on their original receiver.
function checkData(value: unknown, depth = 0): void {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  requireMatch(typeof value === 'object' && depth < 12);
  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  requireMatch(array ? prototype === Array.prototype : prototype === null || prototype === Object.prototype);
  const keys = Reflect.ownKeys(value);
  requireMatch(keys.length <= 128);
  for (const key of keys) {
    if (array && key === 'length') continue;
    const field = Object.getOwnPropertyDescriptor(value, key)!;
    requireMatch(typeof key === 'string' && field.enumerable && Object.hasOwn(field, 'value'));
    checkData(field.value, depth + 1);
  }
}
function planDigest(plan: VaultInitPlan): string {
  return JSON.parse(vaultInitApproval(plan).toString('utf8')).planSha256;
}

function legacyReadback(host: RegisteredHost, operation: string, vaultId: string | undefined) {
  try {
    const entries = host.lifecycleReadbacks;
    const typed = host.vaultInitOperations;
    if (!entries || !typed || !vaultId) return;
    const entry = own(entries, operation);
    const entryKeys = ['root', 'identity', 'plan', 'authority', 'evidence'] as const;
    requireMatch(entry && Object.getPrototypeOf(entry) === Object.prototype &&
      Reflect.ownKeys(entry).length === entryKeys.length && entryKeys.every(key => {
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
      }));
    const root = own(entry, 'root'), identity = own(entry, 'identity'), plan = own(entry, 'plan');
    const authority = own(entry, 'authority'), evidence = own(entry, 'evidence');
    checkData(root); checkData(identity); checkData(plan);
    const rootKeys = ['path', 'device', 'inode'] as const;
    const identityKeys = ['accountId', 'scopeId', 'domains', 'deviceId', 'configRevision', 'installationId'] as const;
    requireMatch(Object.getOwnPropertyNames(root).length === rootKeys.length && rootKeys.every(key => Object.hasOwn(root, key)) &&
      typeof root.path === 'string' && root.path.length <= 4096 && isAbsolute(root.path) && resolve(root.path) === root.path &&
      parse(root.path).root !== root.path && Number.isSafeInteger(root.device) && Number.isSafeInteger(root.inode) &&
      Object.getOwnPropertyNames(identity).length === identityKeys.length && identityKeys.every(key => Object.hasOwn(identity, key)) &&
      token(identity.installationId));
    const keys = ['command', 'targetId', 'expectedGeneration', 'nextGeneration', 'releaseSha256', 'planSha256'] as const;
    requireMatch(Object.getOwnPropertyNames(plan).length === keys.length && keys.every(key => Object.hasOwn(plan, key)) &&
      plan.command === 'init' && plan.targetId === vaultId && digest(plan.planSha256) &&
      (plan.expectedGeneration === null || token(plan.expectedGeneration)) &&
      (plan.nextGeneration === null || token(plan.nextGeneration)) && plan.releaseSha256 === null);
    projectIdentity(identity);
    const keyId = captureField(authority, 'keyId'), verify = captureField(authority, 'verify');
    const version = captureField(evidence, 'version'), observe = captureField(evidence, 'observe');
    requireMatch(token(keyId.value) && token(version.value) && typeof verify.value === 'function' && typeof observe.value === 'function');
    const binding = bindRegistration(() => own(entries, operation));
    const authorityField = captureField(entry, 'authority'), evidenceField = captureField(entry, 'evidence');
    const validate = () => {
      requireMatch(host.vaultInitOperations === typed && !(operation in typed) && host.lifecycleReadbacks === entries &&
        own(entries, operation) === entry);
      binding.validate(); authorityField.validate(); evidenceField.validate();
      keyId.validate(); verify.validate(); version.validate(); observe.validate();
    };
    const retained = binding.value;
    const registration: LifecycleRegistration = {
      root: retained.root, identity: retained.identity, plan: retained.plan,
      authority: { keyId: keyId.value, async verify(...args) {
        validate(); const result = await Reflect.apply(verify.value, authority, args); validate(); return result;
      } },
      evidence: { version: version.value, async observe(...args) {
        validate(); const result = await Reflect.apply(observe.value, evidence, args); validate(); return result;
      } },
    };
    validate();
    return { registration, validate };
  } catch { return; }
}

function selected(host: RegisteredHost, operation: string, vaultId: string) {
  const entries = host.vaultInitOperations;
  requireMatch(entries && token(operation) && token(vaultId));
  const entry = own(entries, operation);
  requireMatch(entry && [null, Object.prototype].includes(Object.getPrototypeOf(entry)));
  const mode = own(entry, 'mode');
  const fields = ['format', 'mode', 'enrollment', 'owner'];
  if (mode !== 'preview') fields.push('plan');
  if (mode !== 'readback') fields.push('signer');
  if (mode === 'approved') fields.push('approval');
  requireMatch(['preview', 'approved', 'readback'].includes(mode) && Object.getOwnPropertyNames(entry).length === fields.length &&
    fields.every(key => Object.getOwnPropertyDescriptor(entry, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(entry, key)!, 'value')) &&
    own(entry, 'format') === 'patrick-installed-vault-init-v1');
  const enrollment = own(entry, 'enrollment'), owner = own(entry, 'owner');
  const lease = captureField(owner, 'withExclusiveReadRoot');
  requireMatch(typeof lease.value === 'function');
  checkData(enrollment);
  if (entry.mode !== 'preview') checkData(own(entry, 'plan'));
  const data = bindRegistration(() => own(entry, 'enrollment'));
  const e = data.value;
  requireMatch(e.operationId === operation && e.vault.vault_id === vaultId && e.captureHost === host.captureHost &&
    e.serviceUid === host.serviceUid && sameIdentity(projectIdentity(e.identity), host.identity) &&
    typeof e.kitVersion === 'string' && e.kitVersion.length <= 64 && digest(e.kitSha256));
  const plan = entry.mode === 'preview' ? undefined : bindRegistration(() => own(entry, 'plan'));
  if (plan) {
    const original = plan.value;
    requireMatch(original.format === 'patrick-vault-init-v1' && original.operationId === operation &&
      original.enrollmentSha256 === createHash('sha256').update(canonicalize(e)).digest('hex') &&
      original.directories && original.files &&
      original.subject.vaultId === vaultId && original.subject.sourceId === e.vault.source_id &&
      original.subject.configRevision === e.vault.config_revision && original.subject.scopeHash === e.vault.scope_hash &&
      original.subject.kitVersion === e.kitVersion && original.subject.manifestSha256 === e.kitSha256);
  }
  function validate() {
    requireMatch(host.vaultInitOperations === entries && own(entries!, operation) === entry &&
      Object.getOwnPropertyNames(entry).length === fields.length &&
      own(entry, 'format') === 'patrick-installed-vault-init-v1' && own(entry, 'mode') === mode &&
      own(entry, 'owner') === owner &&
      !(host.lifecycleReadbacks && Object.hasOwn(host.lifecycleReadbacks, operation)));
    lease.validate(); data.validate(); plan?.validate();
  }
  validate();
  return { entry, enrollment, owner, plan: plan?.value, validate };
}

/** Constructor deferral still requires an own, selected public-plan capability.
 * Every request independently reevaluates eligibility against current enrollment. */
export function hasVaultInitReadback(host: RegisteredHost) {
  const entries = host.vaultInitOperations;
  return Object.getOwnPropertyNames(entries ?? {}).some(operation => {
    try {
      const entry = own(entries!, operation), e = own(entry, 'enrollment');
      const { plan, owner } = selected(host, operation, own(own(e, 'vault'), 'vault_id'));
      if (!plan) return false;
      createVaultInitReader(() => e, owner, plan);
      return true;
    } catch { return false; }
  });
}

export function selectVaultInit(host: RegisteredHost | undefined, request: CliRequest) {
  if (!host || request.command !== 'init' || !request.operation || !host.vaultInitOperations) return;
  requireMatch(host.runtime?.selectVaultInit === selectVaultInit);
  const operation = request.operation, vaultId = request.vault;
  const entries = host.vaultInitOperations;
  requireMatch([null, Object.prototype].includes(Object.getPrototypeOf(entries)));
  if (!Object.hasOwn(entries, operation)) {
    requireMatch(!(operation in entries));
    const legacy = request.action === 'readback' ? legacyReadback(host, operation, vaultId) : undefined;
    if (legacy) return { legacy };
    return { publicRead: false, async run() { return { status: 'unavailable' } as const; } };
  }
  requireMatch(vaultId);
  const { entry, enrollment, owner, plan, validate } = selected(host, operation, vaultId);
  const publicRead = request.action === 'readback' && !!plan;
  return { publicRead, async run(validateHost: () => void) {
    let validateLive = () => {};
    const current = () => { validateHost(); validate(); validateLive(); return enrollment; };
    current();
    if (request.action === 'readback') {
      if (!plan) return { status: 'unavailable' } as const;
      const result = await createVaultInitReader(current, owner, plan).read();
      current(); return result;
    }
    if (entry.mode === 'readback' || (request.action === 'execute' && entry.mode !== 'approved')) return { status: 'unavailable' } as const;
    const signer = own(entry, 'signer'), sign = captureField(signer, 'sign');
    const approval = entry.mode === 'approved' ? own(entry, 'approval') : undefined;
    requireMatch(typeof sign.value === 'function' && (entry.mode !== 'approved' || typeof approval === 'string'));
    const vaults = host.vaults;
    requireMatch(vaults);
    const target = own(vaults, vaultId);
    requireMatch(target);
    // The T27 controller snapshots its options. Forward through the original
    // enrolled method receivers while checking the unmodified host selection.
    const binding = bindRegistration(() => own(vaults, vaultId));
    for (const key of ['identity', 'configRevision', 'scopeHash', 'installer'] as const) own(target, key);
    const identity = captureField(target, 'identity'), revision = captureField(target, 'configRevision');
    const scope = captureField(target, 'scopeHash'), targetInstaller = captureField(target, 'installer');
    const identityObject = identity.value;
    requireMatch(identityObject && typeof identityObject === 'object');
    for (const key of ['accountId', 'scopeId', 'deviceId', 'configRevision', 'domains'] as const) own(identityObject, key);
    const accountId = captureField(identityObject, 'accountId'), scopeId = captureField(identityObject, 'scopeId');
    const deviceId = captureField(identityObject, 'deviceId'), identityRevision = captureField(identityObject, 'configRevision');
    const domainsField = captureField(identityObject, 'domains');
    const domains = bindRegistration(() => own(identityObject, 'domains'));
    const identitySnapshot = projectIdentity({ accountId: accountId.value, scopeId: scopeId.value, deviceId: deviceId.value,
      configRevision: identityRevision.value, domains: domains.value });
    const installer = targetInstaller.value;
    requireMatch(installer);
    const load = captureField(installer, 'loadVault'), inspect = captureField(installer, 'inspectVault');
    const installerFields = ['assetRoot', 'stageParent', 'deviceId', 'captureHost', 'serviceUid', 'editorUid'] as const;
    const configuration = installerFields.map(key => [key, captureField(installer, key, key === 'assetRoot' || key === 'stageParent')] as const);
    requireMatch(typeof load.value === 'function' && typeof inspect.value === 'function');
    validateLive = () => {
      requireMatch(host.vaults === vaults && own(entry, 'signer') === signer &&
        (entry.mode !== 'approved' || own(entry, 'approval') === approval));
      for (const key of Object.keys(target)) {
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        requireMatch(descriptor && Object.hasOwn(descriptor, 'value'));
      }
      sign.validate(); load.validate(); inspect.validate();
      for (const [, field] of configuration) field.validate();
      for (const field of [identity, revision, scope, targetInstaller, accountId, scopeId, deviceId, identityRevision, domainsField]) field.validate();
      domains.validate();
      binding.validate();
    };
    const liveHost = Object.create(host) as RegisteredHost;
    Object.defineProperty(liveHost, 'vaults', { value: { [vaultId]: { identity: identitySnapshot, configRevision: revision.value, scopeHash: scope.value,
      installer: { ...Object.fromEntries(configuration.map(([key, field]) => [key, field.value])),
      loadVault: (id: string) => Reflect.apply(load.value, installer, [id]),
      inspectVault: (device: string, id: string) => Reflect.apply(inspect.value, installer, [device, id]),
    } } } });
    const guardedSigner: Signer = { sign(bytes) { validateLive(); return Reflect.apply(sign.value, signer, [bytes]); } };
    const controller = createVaultInitController(current, owner, liveHost, guardedSigner);
    if (request.action === 'preview') {
      const observed = await controller.preview();
      current();
      const planSha256 = planDigest(observed);
      requireMatch(!plan || planDigest(plan) === planSha256);
      const preview: VaultInitCliPreview = { phase: 'vault-kit', operationId: operation, vaultId,
        kitVersion: observed.subject.kitVersion, manifestSha256: observed.subject.manifestSha256, planSha256 };
      return { status: 'preview', preview } as const;
    }
    requireMatch(plan && approval);
    const result = await controller.execute(plan, approval);
    try { current(); } catch { return { status: 'running_or_uncertain' } as const; }
    return result;
  } };
}
