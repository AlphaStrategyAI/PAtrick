import { openDatabase } from '@patrick/storage';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { renameSync, type BigIntStats } from 'node:fs';
import { createServer } from 'node:https';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { budgetInstallVolume, observeInstallSession, previewFirstInstall, type InstallPreviewEnrollment } from '../../deploy/runtime/install-preview.js';
import { createPatrickCli } from '../../deploy/cli/patrick.mjs';
import { createInstalledCli } from '../../deploy/runtime/cli.js';
import { createRuntimeProvisioning } from '../../deploy/runtime/composition.js';
import { deploymentPaths } from '../../deploy/lib/deployment-templates.mjs';
import { sha256 } from '../../deploy/lib/release.mjs';

// Narrow OS fault: emulate an independent device number for only the enrolled Lima
// mount. All space, inode, file, package, TLS and other host reads remain real.
const simulatedMount = vi.hoisted(() => ({ path: '', device: 0n }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, lstatSync(path: string, options?: { bigint?: boolean }) {
    const observed = fs.lstatSync(path, options);
    if (observed && path === simulatedMount.path && options?.bigint) {
      const changed: BigIntStats = Object.create(observed);
      Object.defineProperty(changed, 'dev', { value: simulatedMount.device });
      return changed;
    }
    return observed;
  } };
});

test('requires an independent first-install registration', async () => {
  expect(await previewFirstInstall(() => undefined, 'release')).toEqual({ status: 'blocked', code: 'INSTALL_PREVIEW_REGISTRATION' });
});

test('refuses distinct APFS volumes sharing 100 bytes when each role fits its volume', () => {
  const rows = { releases: { device: '1', required: 10n, available: 100n },
    data: { device: '1', required: 50n, available: 100n }, lima: { device: '2', required: 50n, available: 100n } };
  expect(() => budgetInstallVolume(rows)).toThrow();
  expect(() => budgetInstallVolume({ ...rows, lima: { ...rows.lima, required: 1n } })).toThrow();
  expect(budgetInstallVolume({ ...rows, lima: { device: '1', required: 40n, available: 100n } }))
    .toEqual([{ roles: ['releases', 'data', 'lima'], requiredBytes: '100' }]);
});

const fixturePath = process.env.PATRICK_TEST_SIGNED_INSTALL_FIXTURE;
const fixturePinsSha256 = '842a7aa93d2dfb478458ea74562c5581c638aeabef72d1540819303ee23fb69a';
const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const storeNames = ['packages', 'releases', 'data', 'history', 'lima'] as const;
async function pin(path: string) {
  const s = await lstat(path, { bigint: true });
  return { device: String(s.dev), inode: String(s.ino), birthtimeNs: String(s.birthtimeNs) };
}
async function snapshot(path: string): Promise<unknown> {
  const s = await lstat(path, { bigint: true });
  return { pin: await pin(path), mode: s.mode.toString(), ctime: s.ctimeNs.toString(),
    content: s.isDirectory() ? await Promise.all((await readdir(path)).sort().map(async name =>
      ({ name, state: await snapshot(join(path, name)) }))) : sha256(await readFile(path)) };
}

// Supply the retained T23-release-promotion-evidence directory. Its detached public
// policy is pinned here independently of the archive and is never derived from it.
describe.skipIf(!fixturePath)('independently registered signed Darwin installation', () => {
  let temporary: string;
  let otherCa: string;
  let e: InstallPreviewEnrollment;
  let archive: string;
  let selected: InstallPreviewEnrollment;
  const trace: string[] = [];
  let subject = 'owner';
  let during: (() => void) | undefined;
  const token = 'synthetic-only-token';
  const preview = () => previewFirstInstall(() => selected, 'release');
  const observe = () => observeInstallSession(() => selected, 'release');
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    const pins = await readFile(join(fixturePath!, 'fixture-pins.json'));
    expect(sha256(pins)).toBe(fixturePinsSha256);
    const { expected, policy } = JSON.parse(pins.toString());
    temporary = await mkdtemp(join(await realpath(tmpdir()), 'install-preview-'));
    const root = join(temporary, 'instance');
    await mkdir(root, { mode: 0o700 });
    for (const name of storeNames) await mkdir(join(root, name), { mode: 0o700 });
    archive = join(root, 'packages', expected.packageSha256 + '.json');
    await copyFile(join(fixturePath!, 'candidate.json'), archive);
    await chmod(archive, 0o600);
    const cert = join(temporary, 'local.pem');
    const key = join(temporary, 'local.key');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key,
      '-out', cert, '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    const ca = await readFile(cert, 'utf8');
    const otherCert = join(temporary, 'other.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', join(temporary, 'other.key'), '-out', otherCert, '-subj', '/CN=Unrelated-Fixture-CA'], { stdio: 'ignore' });
    otherCa = await readFile(otherCert, 'utf8');
    server = createServer({ key: await readFile(key), cert: ca }, (req, res) => {
      trace.push('GET session');
      during?.();
      if (req.method !== 'GET' || req.url !== '/api/v1/session' || req.headers.authorization !== 'Bearer ' + token) {
        res.writeHead(401).end(); return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ schema_version: '1.0', scope: { account_id: subject, permission_epoch: 1, data_domain: 'personal' },
        data: { account_id: subject, caller_id: 'web', auth_epoch: 1, domains: ['personal'] } }));
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture listener');
    const template = (name: keyof typeof deploymentPaths) => readFile(join(repo, deploymentPaths[name]), 'utf8');
    const node = await realpath(process.execPath);
    const controllerSha256 = 'a'.repeat(64);
    let held = false;
    e = { installationId: 'installation', releaseId: 'release', expected, policy, uid: process.geteuid!(), hostname: hostname(),
      identity: { accountId: 'owner', scopeId: 'workspace', deviceId: 'device', domains: ['personal'], configRevision: 'r1' },
      node: { path: node, sha256: sha256(await readFile(node)) }, root, rootNode: await pin(root),
      stores: { releases: await pin(join(root, 'releases')), packages: await pin(join(root, 'packages')),
        data: await pin(join(root, 'data')), history: await pin(join(root, 'history')), lima: await pin(join(root, 'lima')) },
      reserveBytes: { releases: 1000000, data: 2000000, lima: 3000000 }, targetSchema: 2,
      owner: { async withExclusiveReadRoot(read) {
        if (held) throw new Error('duplicate exclusive acquisition');
        held = true; trace.push('acquire');
        try { return await read(root); } finally { held = false; trace.push('release'); }
      } },
      deployment: { instanceRoot: root, controllerSha256, controllerPath: join(temporary, controllerSha256, 'patrick-host-controller'),
        accounts: { caddy: '_proxy', service: '_service', hub: '_hub', worker: '_worker' },
        origin: 'https://127.0.0.1:' + address.port, listener: { host: '127.0.0.1', port: address.port === 43123 ? 43124 : 43123 },
        certificatePath: root + '/caddy/trust/origin.pem', keyPath: root + '/caddy/trust/key.ref' },
      templates: { caddy: await template('caddy'), service: await template('service'), hub: await template('hub'), worker: await template('worker') },
      tls: { caSha256: sha256(Buffer.from(ca)), rpId: '127.0.0.1' } };
    selected = e;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    try {
      const plan = await preview();
      if (plan.status !== 'preview') throw new Error('initial empty-store fixture plan: ' + JSON.stringify(plan));
      e.session = { bootstrapPlanSha256: plan.planSha256, ca, callerId: 'web', authEpoch: 1, credentialRevision: 'session-v1',
        readBearer: async () => { expect(held).toBe(true); return token; } };
    } finally {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(address.port, '127.0.0.1', resolve); });
    }
  });
  afterAll(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });

  test('previews an empty store with no schema, bearer or listener', async () => {
    const { session: _credential, ...bootstrap } = e;
    expect(_credential).toBeDefined();
    const before = await snapshot(bootstrap.root);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture listener');
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    expect(server.listening).toBe(false);
    selected = bootstrap;
    trace.length = 0;
    try {
      expect(await previewFirstInstall(() => selected, 'release')).toMatchObject({ status: 'preview', phase: 'bootstrap',
        activationAuthorized: false, outstanding: ['schema-bootstrap', 'fixed-origin-tls', 'owner-passkey', 'authenticated-session'] });
      expect(trace).toEqual(['acquire', 'release']);
      expect(await snapshot(bootstrap.root)).toEqual(before);
    } finally {
      selected = e;
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(address.port, '127.0.0.1', resolve); });
    }
  });

  test('observes a session after schema bootstrap against the retained plan without changing data', async () => {
    const file = join(e.root, 'data', 'service.sqlite');
    const db = openDatabase(file);
    try { expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='passkey_credentials'").get()).toBeDefined(); }
    finally { db.close(); }
    try {
      const before = await snapshot(e.root);
      expect(await preview()).toMatchObject({ status: 'blocked', code: 'INSTALL_PREVIEW_LAYOUT' });
      trace.length = 0;
      const result = await observe();
      expect(result).toMatchObject({ status: 'session-observed', planSha256: e.session!.bootstrapPlanSha256,
        observed: ['fixed-origin-tls', 'authenticated-session'], outstanding: ['schema-bootstrap', 'owner-passkey'],
        activationAuthorized: false, delegationAuthorized: false });
      expect(trace).toEqual(['acquire', 'GET session', 'release']);
      expect(await snapshot(e.root)).toEqual(before);
      selected = { ...e, identity: { ...e.identity, configRevision: 'r2' } };
      trace.length = 0;
      expect(await observe()).toEqual({ status: 'blocked', code: 'INSTALL_PREVIEW_SESSION' });
      expect(trace).toEqual(['acquire', 'release']);
    } finally { selected = e; await rm(file); }
  });

  function installedFixture() {
    const origin = 'https://preview.example.test:8443';
    const onLease: { before?: () => void; after?: () => void } = {};
    const owner = { async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>): Promise<T> {
      expect(this).toBe(owner);
      onLease.before?.();
      const result = await e.owner.withExclusiveReadRoot(read);
      onLease.after?.();
      return result;
    } };
    const enrollment = { ...e, owner, deployment: { ...e.deployment, origin }, tls: { ...e.tls, rpId: 'preview.example.test' },
      session: { ...e.session!, readBearer: async () => { throw new Error('unexpected credential access'); } } };
    const registry: Record<string, InstallPreviewEnrollment> = { release: enrollment };
    const legacy = { identity: e.identity, candidatePath: join(temporary, 'unavailable-source'),
      expected: { version: '1', commit: '0'.repeat(40), os: 'darwin', arch: 'arm64', schema: 1 },
      policy: { keys: [], requiredEvidence: [] },
      staging: { async withExclusiveReadRoot<T>(): Promise<T> { trace.push('legacy'); throw new Error('source missing'); } } };
    const caps = { installPreviews: registry, releases: { release: legacy, source: legacy } };
    const provisioning = createRuntimeProvisioning({
      registration: { identity: e.identity, captureHost: e.hostname, serviceUid: e.uid, minimumFreeBytes: 1,
        dataRoot: join(e.root, 'data'), profile: 'test', origin, rpId: enrollment.tls.rpId,
        listener: { ...e.deployment.listener, origin } },
      hostCapabilities: caps,
      service: { databasePath: join(e.root, 'data', 'service.sqlite'), credentialDirectory: join(e.root, 'credentials'),
        recoveryRuntime: { attach() { throw new Error('unexpected database startup'); } },
        bindRecoveryOperations() { throw new Error('unexpected recovery startup'); } },
    });
    return { cli: createInstalledCli(provisioning), provisioning, registry, enrollment, caps, onLease };
  }

  test('installed CLI previews a registered signed deployment without effects', async () => {
    const { cli, enrollment } = installedFixture();
    const before = await snapshot(e.root);
    trace.length = 0;
    const result = await cli.run(['install', '--release', 'release']);
    const { status, ...expected } = await previewFirstInstall(() => enrollment, 'release');
    expect(status).toBe('preview');
    expect(result).toMatchObject({ command: 'install', action: 'preview', status: 'preview', code: 'INSTALL_BOOTSTRAP_PREVIEW',
      identity: e.identity, exitCode: 0 });
    expect(result.installPreview).toEqual(expected);
    expect(await cli.run(['install', '--release', 'release', '--preview'])).toEqual(result);
    expect(trace).toEqual(['acquire', 'release', 'acquire', 'release', 'acquire', 'release']);
    expect(await snapshot(e.root)).toEqual(before);
    for (const secret of [e.root, enrollment.deployment.origin, e.session!.ca, token]) expect(JSON.stringify(result)).not.toContain(secret);
  });

  test('installed preview owns a failed selection and preserves the original guard and other action routes', async () => {
    const { cli, enrollment, registry, provisioning } = installedFixture();
    trace.length = 0;
    const run = (...extra: string[]) => cli.run(['install', '--release', 'release', ...extra]);
    registry.release = { ...enrollment, expected: { ...enrollment.expected, materialSha256: '0'.repeat(64) } };
    expect(await run()).toMatchObject({ status: 'blocked', code: 'INSTALL_PREVIEW_PACKAGE' });
    registry.release = { ...enrollment, identity: { ...enrollment.identity, configRevision: 'wrong' } };
    expect(await run()).toMatchObject({ status: 'blocked', code: 'HOST_IDENTITY_MISMATCH' });
    registry.release = enrollment;
    expect(await run('--preview', '--operation', 'unused')).toMatchObject({ status: 'invalid' });
    expect(await run('--readback', '--operation', 'unknown')).toMatchObject({ code: 'LIFECYCLE_READBACK_REQUIRED' });
    expect(trace).toEqual(['acquire', 'release']);
    const guarded = createPatrickCli(provisioning.host, () => ({ status: 'blocked', code: 'RECOVERY_SERVICE_HANDLE_MISMATCH', exitCode: 5 }));
    expect(await guarded.run(['install', '--release', 'release'])).toMatchObject({ code: 'RECOVERY_SERVICE_HANDLE_MISMATCH' });
    let calls = 0;
    const forged = createPatrickCli({ ...provisioning.host, runtime: { ...provisioning.host.runtime,
      previewFirstInstall: async () => { calls++; throw new Error('arbitrary observer'); } } });
    expect(await forged.run(['install', '--release', 'release'])).toMatchObject({ code: 'INSTALL_PREVIEW_RUNTIME_REQUIRED' });
    expect(calls).toBe(0);
    expect(trace).toEqual(['acquire', 'release']);
    // Legacy verification still owns an unselected source ID, execute and upgrade.
    for (const args of [['install', '--release', 'source'], ['install', '--release', 'release', '--execute', '--operation', 'op'],
      ['upgrade', '--release', 'release']]) expect(await cli.run(args)).toMatchObject({ code: 'RELEASE_VERIFICATION_FAILED' });
    expect(trace.slice(2)).toEqual(['legacy', 'legacy', 'legacy']);
  });

  test('installed CLI refuses a class enrollment revised during lease acknowledgement', async () => {
    const { cli, registry, enrollment, onLease } = installedFixture();
    const original = Object.assign(new class Enrollment {}(), enrollment);
    registry.release = original;
    onLease.after = () => { original.targetSchema = 1; };
    const result = await cli.run(['install', '--release', 'release']);
    expect(result.status).toBe('blocked');
    expect(result.installPreview).toBeUndefined();
  });

  test('direct preview snapshots nested class plan data and refuses an acknowledged change', async () => {
    class BudgetRegistration {
      releases = e.reserveBytes.releases;
      data = e.reserveBytes.data;
      lima = e.reserveBytes.lima;
    }
    const reserveBytes = new BudgetRegistration();
    let revise = false;
    class ReadOwner {
      #receiver = true;
      async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>): Promise<T> {
        expect(this.#receiver).toBe(true);
        const answer = await e.owner.withExclusiveReadRoot(read);
        if (revise) reserveBytes.data++;
        return answer;
      }
    }
    const original = Object.assign(new class Enrollment {}(), e, { reserveBytes, owner: new ReadOwner() });
    const observed = await previewFirstInstall(() => original, 'release');
    expect(observed).toEqual(await previewFirstInstall(() => e, 'release'));
    expect(observed.status).toBe('preview');
    revise = true;
    expect(await previewFirstInstall(() => original, 'release')).toEqual({ status: 'blocked', code: 'INSTALL_PREVIEW_LEASE' });
  });

  test('checks configuration on the original class credential receiver without using it for bootstrap', async () => {
    const credential = e.session!;
    class Credential {
      #bearer = token;
      bootstrapPlanSha256 = credential.bootstrapPlanSha256;
      ca = credential.ca;
      callerId = credential.callerId;
      authEpoch = credential.authEpoch;
      credentialRevision = credential.credentialRevision;
      async readBearer() { reads++; return this.#bearer; }
    }
    let reads = 0;
    let revise = false;
    const session = new Credential();
    const original = Object.assign(new class Enrollment {}(), e, { session,
      owner: { async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) {
        const answer = await e.owner.withExclusiveReadRoot(read);
        if (revise) session.credentialRevision += 'x';
        return answer;
      } } });
    expect((await previewFirstInstall(() => original, 'release')).status).toBe('preview');
    expect(reads).toBe(0);
    expect((await observeInstallSession(() => original, 'release')).status).toBe('session-observed');
    revise = true;
    expect((await observeInstallSession(() => original, 'release')).status).toBe('blocked');
    expect(reads).toBe(2);
  });

  test('invokes only the original port methods without reading callable metadata', async () => {
    const { cli, registry, enrollment } = installedFixture();
    const metadataReads: string[] = [];
    let leases = 0;
    let credentials = 0;
    class Owner {
      #original = e.owner;
      async withExclusiveReadRoot<T>(read: (root: string) => Promise<T>) {
        leases++;
        return this.#original.withExclusiveReadRoot(read);
      }
    }
    class Credential {
      #token = token;
      async readBearer() { credentials++; return this.#token; }
    }
    const owner = new Owner();
    const { readBearer: _originalReader, ...metadata } = e.session!;
    expect(typeof _originalReader).toBe('function');
    const session = Object.assign(new Credential(), metadata);
    for (const [port, method] of [['owner', owner.withExclusiveReadRoot], ['credential', session.readBearer]] as const) {
      for (const key of ['name', 'length', 'bind'] as const) {
        const previous = method[key];
        Object.defineProperty(method, key, { get() { metadataReads.push(port + '.' + key); return previous; } });
      }
    }
    registry.release = { ...enrollment, owner, session };
    expect((await cli.run(['install', '--release', 'release'])).status).toBe('preview');
    expect(credentials).toBe(0);
    expect(leases).toBe(1);
    expect.soft([...metadataReads]).toEqual([]);
    // The direct authenticated observation uses the independently retained loopback plan.
    const original = { ...e, owner, session };
    expect((await observeInstallSession(() => original, 'release')).status).toBe('session-observed');
    expect(credentials).toBe(1);
    expect(leases).toBe(2);
    expect(metadataReads).toEqual([]);
  });

  test.each(['identity', 'budget', 'method'] as const)('rejects accessor-backed %s without invoking its getter', async kind => {
    const { cli, registry, enrollment } = installedFixture();
    let reads = 0;
    const original = Object.assign(new class Enrollment {}(), enrollment, {
      reserveBytes: Object.assign(new class Budget {}(), enrollment.reserveBytes),
      owner: Object.assign(new class Owner {}(), enrollment.owner),
    });
    registry.release = original;
    const target = kind === 'identity' ? [original, 'identity'] as const :
      kind === 'budget' ? [original.reserveBytes, 'data'] as const : [original.owner, 'withExclusiveReadRoot'] as const;
    Object.defineProperty(target[0], target[1], { enumerable: true, get() { reads++; throw new Error('unexpected accessor'); } });
    expect((await cli.run(['install', '--release', 'release'])).status).toBe('blocked');
    expect((await previewFirstInstall(() => original, 'release')).status).toBe('blocked');
    expect(reads).toBe(0);
  });

  test.each(['before', 'after'] as const)('rechecks original installed registration %s the owner callback', async when => {
    const { cli, caps, registry, onLease } = installedFixture();
    onLease[when] = () => { caps.installPreviews = { ...registry }; };
    const result = await cli.run(['install', '--release', 'release']);
    expect(result).toMatchObject({ status: 'blocked', code: 'HOST_IDENTITY_MISMATCH' });
    expect(result.installPreview).toBeUndefined();
  });

  test('reads an exact signed plan under one lease with no filesystem mutations', async () => {
    const before = await snapshot(e.root);
    trace.length = 0;
    const first = await preview();
    expect(first).toMatchObject({ status: 'preview', packageSha256: e.expected.packageSha256,
      activeSchema: 1, targetSchema: 2, volumes: [{ roles: ['releases', 'data', 'lima'] }] });
    expect(trace).toEqual(['acquire', 'release']);
    expect(JSON.stringify(first)).not.toContain(e.root);
    expect(JSON.stringify(first)).not.toContain(token);
    expect(await preview()).toEqual(first);
    expect(await snapshot(e.root)).toEqual(before);
    selected = { ...e, reserveBytes: { ...e.reserveBytes, data: e.reserveBytes.data + 1 } };
    try {
      const changed = await preview();
      expect(changed.status).toBe('preview');
      if (first.status === 'preview' && changed.status === 'preview') {
        expect(BigInt(changed.volumes[0].requiredBytes)).toBe(BigInt(first.volumes[0].requiredBytes) + 1n);
        expect(changed.planSha256).not.toBe(first.planSha256);
      }
    } finally { selected = e; }
  });

  test('blocks individually sufficient APFS volumes with shared unreserved capacity', async () => {
    const disk = await statfs(e.root, { bigint: true });
    const available = disk.bavail * disk.bsize;
    const each = Number(available * 3n / 5n);
    expect(BigInt(each)).toBeLessThan(available);
    expect(BigInt(each) * 2n).toBeGreaterThan(available);
    simulatedMount.path = join(e.root, 'lima');
    simulatedMount.device = BigInt(e.stores.lima.device) + 1n;
    selected = { ...e, stores: { ...e.stores, lima: { ...e.stores.lima, device: String(simulatedMount.device) } },
      reserveBytes: { releases: 1, data: each, lima: each } };
    try { expect(await preview()).toEqual({ status: 'blocked', code: 'INSTALL_PREVIEW_CAPACITY' }); }
    finally { simulatedMount.path = ''; selected = e; }
  });

  test('rejects real capacity shortfall, foreign architecture, stale key, trust and credential', async () => {
    const otherKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const disk = await statfs(e.root, { bigint: true });
    const halfPlus = Number(disk.bavail * disk.bsize / 2n + 512n * 1024n * 1024n);
    const cases: [InstallPreviewEnrollment, string][] = [
      [{ ...e, reserveBytes: { releases: 1, data: halfPlus, lima: halfPlus } }, 'CAPACITY'],
      [{ ...e, reserveBytes: { ...e.reserveBytes, lima: Number.MAX_SAFE_INTEGER } }, 'CAPACITY'],
      [{ ...e, expected: { ...e.expected, target: { ...e.expected.target, arch: 'x64' } } }, 'HOST'],
      [{ ...e, expected: { ...e.expected, profile: 'runtime-only' } }, 'REGISTRATION'],
      [{ ...e, policy: { ...e.policy, keys: [{ id: 'fixture', publicKey: otherKey }] } }, 'PACKAGE'],
      [{ ...e, session: { ...e.session!, ca: otherCa } }, 'SESSION'],
      [{ ...e, session: { ...e.session!, readBearer: async () => 'wrong' } }, 'SESSION'],
    ];
    try {
      for (const [registration, reason] of cases) {
        selected = registration;
        expect(await observe()).toEqual({ status: 'blocked', code: 'INSTALL_PREVIEW_' + reason });
      }
      selected = e;
      selected = { ...e, tls: { ...e.tls, caSha256: sha256(Buffer.from(otherCa)) } };
      const badTrust = await preview();
      if (badTrust.status !== 'preview') throw new Error('fixture trust plan');
      selected.session = { ...e.session!, bootstrapPlanSha256: badTrust.planSha256, ca: otherCa };
      trace.length = 0;
      expect(await observe()).toEqual({ status: 'blocked', code: 'INSTALL_PREVIEW_SESSION' });
      expect(trace).toEqual(['acquire', 'release']);
      selected = e;
      subject = 'other';
      expect(await observe()).toMatchObject({ status: 'blocked', code: 'INSTALL_PREVIEW_SESSION' });
    } finally { selected = e; subject = 'owner'; }
  });
  test('rechecks registration after authenticated TLS and refuses loss of lease acknowledgement', async () => {
    during = () => { selected = { ...e }; };
    try { expect((await observe()).status).toBe('blocked'); } finally { selected = e; during = undefined; }
    const original = join(e.root, 'lima');
    const foreign = join(temporary, 'empty-foreign');
    const saved = join(temporary, 'enrolled-lima');
    await mkdir(foreign, { mode: 0o700 });
    during = () => { renameSync(original, saved); renameSync(foreign, original); };
    try { expect(await observe()).toMatchObject({ status: 'blocked', code: 'INSTALL_PREVIEW_LAYOUT' }); }
    finally { during = undefined; await rename(original, foreign); await rename(saved, original); }
    selected = { ...e, owner: { async withExclusiveReadRoot(read) {
      await e.owner.withExclusiveReadRoot(read); throw new Error('private path ' + e.root);
    } } };
    try { expect(await observe()).toEqual({ status: 'blocked', code: 'INSTALL_PREVIEW_LEASE' }); } finally { selected = e; }
  });

  test('preserves foreign entries and blocks exchanged root identities or modified archive bytes', async () => {
    const path = join(e.root, 'data');
    const saved = join(temporary, 'original-data');
    await rename(path, saved);
    await mkdir(path, { mode: 0o700 });
    expect(await preview()).toMatchObject({ code: 'INSTALL_PREVIEW_LAYOUT' });
    await rm(path, { recursive: true });
    await rename(saved, path);
    const foreign = join(path, 'existing');
    await writeFile(foreign, 'preserve');
    expect(await preview()).toMatchObject({ code: 'INSTALL_PREVIEW_LAYOUT' });
    expect(await readFile(foreign, 'utf8')).toBe('preserve');
    await rm(foreign);
    const bytes = await readFile(archive);
    bytes[100] ^= 1;
    await writeFile(archive, bytes);
    expect(await preview()).toEqual({ status: 'blocked', code: 'INSTALL_PREVIEW_PACKAGE' });
    expect(sha256(await readFile(archive))).toBe(sha256(bytes));
  });
});
