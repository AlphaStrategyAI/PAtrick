import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { createStandardsApi } from '../../packages/domain/src/standards.js';
import { createVaultApi } from '../../packages/integrations/vault/drafts.js';
import { PROJECTION_BATCH_FILES } from '../../packages/integrations/vault/projector.js';
import { createBlobStore } from '../../packages/storage/src/blob-store.js';
import { openDatabase } from '../../packages/storage/src/database.js';
import { confirmVault, connectVault, inspectVault, requireVault } from '../../packages/integrations/vault/connection.js';
import { doctor as deploymentDoctor } from '../../deploy/lib/doctor.mjs';
import { createObsidianDoctor, createObsidianInspector, createVaultActivityReader, obsidianEditTarget } from '../../deploy/obsidian/doctor.mjs';
import { createMacObsidianInstaller, createVaultKitInstaller, verifyObsidianInstaller } from '../../deploy/obsidian/install.mjs';

const now = '2026-11-16T12:00:00.000Z';
const deviceId = 'test-device';
const vaultId = 'test-vault';
const captureHost = 'test-capture';
const assets = fileURLToPath(new URL('../../assets/vault-kit/', import.meta.url));
const entry = new URL('../../deploy/obsidian/install.mjs', import.meta.url).href;
const uriPath = '知识笔记/证据 #1.md';
const missingTemplate = '模板/判断案例.md';
const ownerTemplate = '模板/知识笔记.md';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const getUid = () => process.geteuid?.() ?? -1;
const exec = promisify(execFile);

async function fixture() {
  const tmp = await realpath(tmpdir());
  const dir = await mkdtemp(join(tmp, 'patrick-t27-'));
  const root = join(dir, '个人 Vault');
  const stageParent = join(dir, 'staging');
  await Promise.all([mkdir(root), mkdir(stageParent)]);
  const db = openDatabase(join(dir, 'test.sqlite'));
  await connectVault(db, { deviceId, vaultId, captureHost, now, root, accountId: 'test-owner', domain: 'personal' });
  const options = {
    deviceId, captureHost, serviceUid: getUid(), editorUid: getUid(), stageParent,
    loadVault: (id: string) => requireVault(db, id),
    inspectVault: (device: string, id: string) => inspectVault(db, device, id),
  };
  return { dir, root, db, options, async disconnect() { db.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('the confirmed Vault gets only missing kit files; an edited template and manuscript remain byte-for-byte', async () => {
  const fx = await fixture();
  try {
    const installer = createVaultKitInstaller(fx.options);
    await expect(installer.installVaultKit(vaultId)).rejects.toThrow('VAULT_NOT_CONFIRMED');
    expect(await readdir(fx.root)).toEqual([]);
    await confirmVault(fx.db, deviceId, vaultId, now);
    const owner = Buffer.from([0xef, 0xbb, 0xbf, 35, 32, 65, 13, 10]);
    await mkdir(join(fx.root, '模板'));
    await mkdir(join(fx.root, '知识笔记'));
    await mkdir(join(fx.root, '.obsidian'));
    await writeFile(join(fx.root, ownerTemplate), owner);
    await writeFile(join(fx.root, uriPath), owner);
    await writeFile(join(fx.root, '.obsidian', 'app.json'), '{}');
    const result = await installer.installVaultKit(vaultId);
    expect(result).toMatchObject({
      vaultId, configRevision: 1, version: expect.any(String), manifestSha256: expect.stringMatching(/^[\da-f]{64}$/),
      files: expect.arrayContaining([{ path: ownerTemplate, state: 'preserved', sha256: hash(owner) }]),
    });
    const recorded = JSON.parse(await readFile(join(fx.root, result.manifestPath), 'utf8'));
    expect(recorded.files).toHaveLength(7);
    expect(await readFile(join(fx.root, uriPath))).toEqual(owner);
    expect(await readFile(join(fx.root, ownerTemplate))).toEqual(owner);
    expect(await readFile(join(fx.root, '.obsidian', 'app.json'), 'utf8')).toBe('{}');
    for (const file of result.files.filter(({ state }) => state === 'created')) {
      expect(hash(await readFile(join(fx.root, file.path)))).toBe(file.sha256);
    }
    expect((await installer.installVaultKit(vaultId)).files.every(({ state }) => state === 'preserved')).toBe(true);
  } finally {
    await fx.disconnect();
  }
});

test.each(['directory', 'target', 'staging', 'replaced-root'] as const)('refuses the %s path hazard before publishing files', async (hazard) => {
  const fx = await fixture();
  try {
    await confirmVault(fx.db, deviceId, vaultId, now);
    const outside = join(fx.dir, 'outside');
    await mkdir(outside);
    const sensitive = join(outside, 'sensitive.md');
    await writeFile(sensitive, 'outside content');
    if (hazard === 'directory') await symlink(outside, join(fx.root, '模板'), 'dir');
    if (hazard === 'target' || hazard === 'staging') {
      await mkdir(join(fx.root, '模板'));
      await symlink(hazard === 'target' ? sensitive : outside,
        join(fx.root, hazard === 'target' ? ownerTemplate : '模板/.patrick-staging'));
    }
    if (hazard === 'replaced-root') {
      await rename(fx.root, join(fx.dir, 'old-vault'));
      await symlink(join(fx.dir, 'old-vault'), fx.root, 'dir');
    }
    await expect(createVaultKitInstaller(fx.options).installVaultKit(vaultId)).rejects.toThrow(/VAULT_(UNSAFE_PATH|ROOT_CHANGED)/);
    expect(await readdir(outside)).toEqual(['sensitive.md']);
    expect(await readFile(sensitive, 'utf8')).toBe('outside content');
    await expect(lstat(join(fx.root, '系统视图'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await fx.disconnect();
  }
});

test.each(['../escape.md', 'tampered asset'])('rejects an invalid kit (%s) before any Vault write', async (bad) => {
  const fx = await fixture();
  try {
    await confirmVault(fx.db, deviceId, vaultId, now);
    const assetRoot = join(fx.dir, 'kit');
    await cp(assets, assetRoot, { recursive: true });
    const path = join(assetRoot, 'manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    if (bad === 'tampered asset') await writeFile(join(assetRoot, manifest.files[0].source), 'tampered');
    else {
      manifest.files[0].path = bad;
      await writeFile(path, JSON.stringify(manifest));
    }
    await expect(createVaultKitInstaller({ ...fx.options, assetRoot }).installVaultKit(vaultId)).rejects.toThrow(/KIT_(MANIFEST_INVALID|HASH_MISMATCH)/);
    expect(await readdir(fx.root)).toEqual([]);
  } finally {
    await fx.disconnect();
  }
});

test.each(['before', 'after'] as const)('a process killed %s publication leaves no partial target and retry preserves owner bytes', async (when) => {
  const fx = await fixture();
  try {
    await confirmVault(fx.db, deviceId, vaultId, now);
    await mkdir(join(fx.root, '模板'));
    await mkdir(join(fx.root, '知识笔记'));
    await writeFile(join(fx.root, ownerTemplate), 'owner template\r\n');
    await writeFile(join(fx.root, uriPath), 'owner original\r\n');
    const { loadVault, inspectVault: inspect, ...options } = fx.options;
    const record = loadVault(vaultId);
    const connection = await inspect(deviceId, vaultId);
    const childCode = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { readFileSync } from 'node:fs';
      const link = fs.promises.link;
      fs.promises.link = async function (from, to) {
        if (to === ${JSON.stringify(join(fx.root, missingTemplate))}) {
          if (readFileSync(from).length === 0) process.exit(3);
          if (${JSON.stringify(when)} === 'after') await link(from, to);
          process.kill(process.pid, 'SIGKILL');
        }
        return link(from, to);
      };
      syncBuiltinESMExports();
      const { createVaultKitInstaller } = await import(${JSON.stringify(entry)});
      await createVaultKitInstaller({
        ...${JSON.stringify(options)},
        loadVault: () => (${JSON.stringify(record)}),
        inspectVault: () => (${JSON.stringify(connection)}),
      }).installVaultKit(${JSON.stringify(vaultId)});
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostics = '';
    child.stderr.on('data', (chunk: Buffer) => { diagnostics += chunk.toString(); });
    const signal = await new Promise<string | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, killedBy) => code === null ? resolve(killedBy) : reject(new Error(`exit ${code}: ${diagnostics}`)));
    });
    expect(signal).toBe('SIGKILL');
    const fullTemplate = await readFile(join(assets, '判断案例.md'));
    if (when === 'before') {
      await expect(access(join(fx.root, missingTemplate), constants.F_OK)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(await readFile(join(fx.root, missingTemplate))).toEqual(fullTemplate);
    }
    if (when === 'after') {
      const retry = `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const open = fs.promises.open;
        const events = [];
        const target = ${JSON.stringify(join(fx.root, missingTemplate))};
        const parent = ${JSON.stringify(join(fx.root, '模板'))};
        fs.promises.open = async function (path, ...args) {
          const fd = await open(path, ...args);
          if (path === target || path === parent) {
            const sync = fd.sync.bind(fd);
            fd.sync = async () => {
              await sync();
              events.push(path === target ? 'file' : 'parent');
            };
          }
          return fd;
        };
        syncBuiltinESMExports();
        const { createVaultKitInstaller } = await import(${JSON.stringify(entry)});
        const receipt = await createVaultKitInstaller({
          ...${JSON.stringify(options)},
          loadVault: () => (${JSON.stringify(record)}),
          inspectVault: () => (${JSON.stringify(connection)}),
        }).installVaultKit(${JSON.stringify(vaultId)});
        process.stdout.write(JSON.stringify({ events, receipt }));
      `;
      const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', retry]);
      const result = JSON.parse(stdout) as { events: string[]; receipt: Awaited<ReturnType<ReturnType<typeof createVaultKitInstaller>['installVaultKit']>> };
      expect(result.events.slice(0, 2)).toEqual(['file', 'parent']);
      expect(result.receipt.files.find(({ path }) => path === missingTemplate)).toMatchObject({ state: 'preserved' });
    } else {
      const result = await createVaultKitInstaller(fx.options).installVaultKit(vaultId);
      expect(result.files.find(({ path }) => path === missingTemplate)).toMatchObject({ state: 'created' });
    }
    expect(await readFile(join(fx.root, missingTemplate))).toEqual(fullTemplate);
    expect(await readFile(join(fx.root, ownerTemplate), 'utf8')).toBe('owner template\r\n');
    expect(await readFile(join(fx.root, uriPath), 'utf8')).toBe('owner original\r\n');
  } finally {
    await fx.disconnect();
  }
});

test('doctor reports app, installer and URI independently, and stopped editor leaves file permissions available', async () => {
  const fx = await fixture();
  try {
    await confirmVault(fx.db, deviceId, vaultId, now);
    await createVaultKitInstaller(fx.options).installVaultKit(vaultId);
    const installPath = '/Applications/Obsidian.app';
    const inspectObsidian = createObsidianInspector({
      localDeviceId: deviceId, lockedVersion: '1.15.1', installerHash: null,
      readMacState: async () => ({
        application: { path: installPath, version: '1.15.1', signature: 'verified', architecture: 'universal' },
        uriHandler: installPath, running: false,
      }),
    });
    const doctor = createObsidianDoctor({ ...fx.options, inspectObsidian, syncMode: 'single_device' });
    const ready = await doctor.inspect(deviceId, vaultId);
    expect(ready).toMatchObject({
      editor: { application: { status: 'ready' }, installer: { status: 'unverified' }, uri: 'registered', process: 'stopped' },
      connection: { vault_id: vaultId, status: 'connected' },
      permissions: { reader: 'allowed', draftWriter: 'allowed', projector: 'allowed' },
      sync: 'single_device', editorAccess: 'allowed',
    });
    const denied = await createObsidianDoctor({ ...fx.options, serviceUid: getUid() + 1, inspectObsidian }).inspect(deviceId, vaultId);
    expect(denied.permissions).toEqual({ reader: 'unknown', draftWriter: 'unknown', projector: 'unknown' });
    await expect(createVaultKitInstaller({ ...fx.options, serviceUid: getUid() + 1 }).installVaultKit(vaultId))
      .rejects.toThrow('VAULT_SERVICE_IDENTITY_MISMATCH');
    const missing = await createObsidianInspector({
      localDeviceId: deviceId, lockedVersion: '1.15.1', installerHash: null,
      readMacState: async () => ({ application: null, uriHandler: null, running: false }),
    })(deviceId);
    expect(missing).toMatchObject({ application: { status: 'missing' }, uri: 'unregistered', installer: { status: 'unverified' } });
    expect((await inspectObsidian('other-device')).application.status).toBe('unknown');
    const mapping = { vaultId, deviceId, alias: '个人 Vault', mappingRevision: 1 };
    const ambiguousPaths = [uriPath, '知识笔记/分组 #1/证据.md'];
    expect(ambiguousPaths.map((relativePath) => obsidianEditTarget(ready.editor, mapping,
      { vaultId, relativePath, mappingRevision: 1 })))
      .toEqual(ambiguousPaths.map((relativePath) => ({ kind: 'relative_path', relativePath })));
    expect(obsidianEditTarget(ready.editor, mapping,
      { vaultId, relativePath: '知识笔记/普通证据.md', mappingRevision: 1 })).toEqual({
      kind: 'obsidian_uri',
      uri: 'obsidian://open?vault=%E4%B8%AA%E4%BA%BA%20Vault&file=%E7%9F%A5%E8%AF%86%E7%AC%94%E8%AE%B0%2F%E6%99%AE%E9%80%9A%E8%AF%81%E6%8D%AE.md',
    });
    expect(obsidianEditTarget(ready.editor, mapping, { vaultId, relativePath: '../证据 #1.md', mappingRevision: 1 }))
      .toEqual({ kind: 'unavailable' });
    expect(obsidianEditTarget(missing, null, { vaultId, relativePath: uriPath, mappingRevision: 1 }))
      .toEqual({ kind: 'relative_path', relativePath: uriPath });
    expect(obsidianEditTarget(ready.editor, { vaultId, deviceId, alias: '个人 Vault', mappingRevision: 1 },
      { vaultId, relativePath: '../original.md', mappingRevision: 1 })).toEqual({ kind: 'unavailable' });
  } finally {
    await fx.disconnect();
  }
});

test.skipIf(getUid() === 0)('doctor checks the registered projector isolation path without creating it', async () => {
  const fx = await fixture();
  const isolation = requireVault(fx.db, vaultId).isolation_root;
  try {
    await confirmVault(fx.db, deviceId, vaultId, now);
    await createVaultKitInstaller(fx.options).installVaultKit(vaultId);
    const inspectObsidian = createObsidianInspector({
      localDeviceId: deviceId, lockedVersion: null, installerHash: null, readMacState: async () => null,
    });
    const doctor = createObsidianDoctor({ ...fx.options, inspectObsidian });
    const permissions = async () => (await doctor.inspect(deviceId, vaultId)).permissions;

    await chmod(fx.dir, 0o500);
    expect(await permissions()).toEqual({ reader: 'allowed', draftWriter: 'allowed', projector: 'denied' });
    await expect(lstat(isolation)).rejects.toMatchObject({ code: 'ENOENT' });

    await chmod(fx.dir, 0o700);
    await mkdir(isolation, { mode: 0o700 });
    await chmod(fx.dir, 0o500);
    expect(await permissions()).toMatchObject({ projector: 'allowed' });
    await expect(lstat(join(isolation, vaultId))).rejects.toMatchObject({ code: 'ENOENT' });

    await symlink(fx.root, join(isolation, vaultId));
    expect(await permissions()).toMatchObject({ projector: 'unsafe' });
  } finally {
    await chmod(fx.dir, 0o700);
    await fx.disconnect();
  }
});

test.each([
  { editorUid: getUid(), editorAccess: 'allowed' },
  { editorUid: getUid() + 1, editorAccess: 'unknown' },
])('deployment doctor preserves $editorAccess editor access alongside ready Service permissions', async ({ editorUid, editorAccess }) => {
  const fx = await fixture();
  try {
    await confirmVault(fx.db, deviceId, vaultId, now);
    await createVaultKitInstaller(fx.options).installVaultKit(vaultId);
    const record = requireVault(fx.db, vaultId);
    const identity = {
      accountId: record.account_id, domains: [record.data_domain], scopeId: 'test-scope', deviceId, configRevision: '1',
    };
    const inspectObsidian = createObsidianInspector({
      localDeviceId: deviceId, lockedVersion: null, installerHash: null, readMacState: async () => null,
    });
    const report = await deploymentDoctor({
      identity, captureHost, serviceUid: getUid(), profile: fx.dir, dataRoot: fx.dir, minimumFreeBytes: 1,
      runtime: { createObsidianDoctor },
      vaults: { [vaultId]: {
        identity, configRevision: record.config_revision, scopeHash: record.scope_hash,
        options: { ...fx.options, editorUid, inspectObsidian },
      } },
    }, vaultId);
    expect(report.checks.vault).toMatchObject({
      status: 'ready',
      evidence: {
        connection: 'connected',
        permissions: { reader: 'allowed', draftWriter: 'allowed', projector: 'allowed' },
        editorAccess,
      },
    });
  } finally {
    await fx.disconnect();
  }
});

test('the installer gate requires the separately pinned package bytes', async () => {
  const fx = await fixture();
  try {
    const dmg = join(fx.dir, 'licensed-fixture.dmg');
    await mkdir(dirname(dmg), { recursive: true });
    const bytes = Buffer.from('fixture, not a real DMG');
    await writeFile(dmg, bytes);
    await expect(verifyObsidianInstaller(dmg, { version: '1.15.1', sha256: null })).rejects.toThrow('OBSIDIAN_INSTALLER_UNPINNED');
    await expect(verifyObsidianInstaller(dmg, { version: '1.15.1', sha256: '0'.repeat(64) })).rejects.toThrow('OBSIDIAN_INSTALLER_HASH_MISMATCH');
    await expect(verifyObsidianInstaller(dmg, { version: '1.15.1', sha256: hash(bytes) })).resolves
      .toEqual({ version: '1.15.1', sha256: hash(bytes), status: 'hash_verified' });
  } finally {
    await fx.disconnect();
  }
});

test.skipIf(getUid() === 0)('doctor measures permissions as the service user and the installer preflights denied directories', async () => {
  const fx = await fixture();
  try {
    await confirmVault(fx.db, deviceId, vaultId, now);
    for (const dir of ['知识笔记', '判断案例', '标准修订', '附件', '系统视图']) {
      await mkdir(join(fx.root, dir), { mode: dir === '系统视图' ? 0o500 : 0o700 });
    }
    const inspectObsidian = createObsidianInspector({
      localDeviceId: deviceId, lockedVersion: null, installerHash: null, readMacState: async () => null,
    });
    const observed = await createObsidianDoctor({ ...fx.options, inspectObsidian }).inspect(deviceId, vaultId);
    expect(observed.permissions).toEqual({ reader: 'allowed', draftWriter: 'allowed', projector: 'denied' });
    await expect(createVaultKitInstaller(fx.options).installVaultKit(vaultId)).rejects.toMatchObject({ code: 'EACCES' });
    await expect(lstat(join(fx.root, '模板'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await fx.disconnect();
  }
});

test('an isolated filesystem round trip collects a new draft and a note, opens a candidate and exports with the editor stopped', async () => {
  const fx = await fixture();
  try {
    await confirmVault(fx.db, deviceId, vaultId, now);
    await createVaultKitInstaller(fx.options).installVaultKit(vaultId);
    const blobs = createBlobStore(join(fx.dir, 'blobs'));
    const vault = createVaultApi(fx.db, { blobs, captureHost, now: () => new Date(now) });
    const principal = { account_id: 'test-owner', caller_id: 'test-device', auth_epoch: 1,
      authenticated_at: now, domains: ['personal'], operations: ['owner', 'edits.write', 'standards.write'] };
    expect(await vault.readVault(vaultId)).toMatchObject({ state: 'ready', collected: 0 });
    const draft = await vault.createEdit(principal, { operation: 'create_standard', draft_key: 'sample', expected_active_version: null });
    const intent = fx.db.prepare('SELECT target_id, relative_path FROM edit_intents WHERE edit_id = ?').get(draft.edit_id) as {
      target_id: string; relative_path: string;
    };
    expect(await readFile(join(fx.root, intent.relative_path), 'utf8')).toContain('# 判断规则');
    const { candidate_rules: rules } = JSON.parse(await readFile(new URL('../../fixtures/evaluation/product/manifest.json', import.meta.url), 'utf8'));
    const standard = [
      '---', `patrick_id: ${intent.target_id}`, 'kind: standard', `standard_id: ${intent.target_id}`, 'base_version:', '---',
      '# 判断规则', '```json', JSON.stringify({ rules }), '```',
    ].join('\n');
    const note = '---\nkind: knowledge\nknowledge_id: test-knowledge\n---\n# 初次保存';
    await writeFile(join(fx.root, intent.relative_path), standard);
    await writeFile(join(fx.root, uriPath), note);
    expect(await vault.readVault(vaultId)).toMatchObject({ state: 'ready', collected: 2 });
    const head = fx.db.prepare(`SELECT document_id, observed_seq AS source_revision, content_hash
      FROM vault_documents WHERE vault_id = ? AND relative_path = ?`).get(vaultId, intent.relative_path) as {
      document_id: string; source_revision: number; content_hash: string;
    };
    expect(head.content_hash).toBe(hash(Buffer.from(standard)));
    const standards = createStandardsApi(fx.db, principal, { domain: 'personal', now: () => new Date(now) });
    const candidate = await standards.openCandidate({ ...head, vault_id: vaultId, standard_id: intent.target_id, draft_key: 'sample' });
    expect(candidate).toMatchObject({ standard_id: intent.target_id, content_hash: head.content_hash });
    expect(await standards.activeStandardVersion(intent.target_id)).toBeNull();
    const files = Object.fromEntries(await Promise.all(PROJECTION_BATCH_FILES.map(async (name) => [name,
      name.endsWith('.md') ? `# 测试投影\n${name.startsWith('候选标准/') ? candidate.id : ''}`
        : await readFile(join(assets, '系统视图', name), 'utf8')])));
    expect(await vault.project({ vaultId, viewKind: 'standards', revision: 1, files })).toMatchObject({ applied: true, pointer: 1 });
    expect(await readFile(join(fx.root, '系统视图', '索引.md'), 'utf8')).toContain('projection_revision: 1');
    expect(await readFile(join(fx.root, '系统视图', '批次', '1', '候选标准', '当前.md'), 'utf8')).toContain(candidate.id);
    await writeFile(join(fx.root, uriPath), note + '\n补采证据');
    expect(await vault.readVault(vaultId)).toMatchObject({ state: 'ready', collected: 1 });
    expect(fx.db.prepare('SELECT observed_seq FROM vault_documents WHERE vault_id = ? AND relative_path = ?').get(vaultId, uriPath))
      .toEqual({ observed_seq: 2 });
    expect(await readFile(join(fx.root, intent.relative_path), 'utf8')).toBe(standard);
    const inspectObsidian = createObsidianInspector({
      localDeviceId: deviceId, lockedVersion: null, installerHash: null,
      readMacState: async () => ({ application: null, uriHandler: null, running: false }),
    });
    const doctor = await createObsidianDoctor({ ...fx.options, inspectObsidian, readRecent: createVaultActivityReader(fx.db) })
      .inspect(deviceId, vaultId);
    expect(doctor).toMatchObject({
      editor: { process: 'stopped' }, connection: { projection_status: 'ready', collection_status: 'ready' },
      recent: { collection: { revisionId: expect.stringMatching(/^rev_/), observedAt: now }, projection: { revision: 1, observedAt: now } },
    });
  } finally {
    await fx.disconnect();
  }
});

test.each(['owner bytes', 'same bytes as kit', 'edited seed'])('the first projection preserves an unattested index: %s', async (kind) => {
  const fx = await fixture();
  try {
    await confirmVault(fx.db, deviceId, vaultId, now);
    const index = join(fx.root, '系统视图', '索引.md');
    if (kind === 'edited seed') {
      await createVaultKitInstaller(fx.options).installVaultKit(vaultId);
    } else {
      await mkdir(dirname(index));
    }
    const bytes = kind === 'same bytes as kit' ? await readFile(join(assets, '系统视图', '索引.md'))
      : Buffer.from([0xef, 0xbb, 0xbf, 35, 32, 65, 13, 10]);
    await writeFile(index, bytes);
    await createVaultKitInstaller(fx.options).installVaultKit(vaultId);
    const api = createVaultApi(fx.db, { blobs: createBlobStore(join(fx.dir, 'blobs')), captureHost });
    const files = Object.fromEntries(PROJECTION_BATCH_FILES.map((name) => [name, name]));
    expect(await api.project({ vaultId, viewKind: 'knowledge', revision: 1, files }))
      .toMatchObject({ state: 'failed', applied: false, pointer: null });
    expect(await readFile(index)).toEqual(bytes);
    await expect(lstat(join(dirname(index), '批次'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await fx.disconnect();
  }
});

test('an explicit distinct editor identity fails before a kit write; doctor does not guess sync or editor access', async () => {
  const fx = await fixture();
  try {
    await confirmVault(fx.db, deviceId, vaultId, now);
    await expect(createVaultKitInstaller({ ...fx.options, editorUid: getUid() + 1 }).installVaultKit(vaultId))
      .rejects.toThrow('VAULT_EDITOR_IDENTITY_UNVERIFIED');
    expect(await readdir(fx.root)).toEqual([]);
    const inspectObsidian = createObsidianInspector({
      localDeviceId: deviceId, lockedVersion: null, installerHash: null, readMacState: async () => null,
    });
    const doctor = createObsidianDoctor({ ...fx.options, editorUid: getUid() + 1, inspectObsidian });
    expect(await doctor.inspect(deviceId, vaultId)).toMatchObject({ sync: 'unknown', editorAccess: 'unknown' });
  } finally {
    await fx.disconnect();
  }
});

test.skipIf(getUid() === 0)('installer refuses denied T06 staging access before publishing any asset', async () => {
  const fx = await fixture();
  try {
    await confirmVault(fx.db, deviceId, vaultId, now);
    await mkdir(join(fx.root, '系统视图'));
    await mkdir(join(fx.root, '系统视图', '.patrick-staging'), { mode: 0o500 });
    await expect(createVaultKitInstaller(fx.options).installVaultKit(vaultId)).rejects.toMatchObject({ code: 'EACCES' });
    await expect(lstat(join(fx.root, '模板'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await fx.disconnect();
  }
});

test('doctor ignores a foreign Vault batch sharing the domain and ignores an unmatched intent', async () => {
  const fx = await fixture();
  try {
    await confirmVault(fx.db, deviceId, vaultId, now);
    const add = (rev: number, view: string, id: string, batchId: string, ptr: string, applied: number) => {
      fx.db.prepare(`INSERT INTO projection_batches
        VALUES ('personal', ?, ?, ?, ?, '[]', ?, 'current', ?, ?, ?)`)
        .run(view, rev, id, batchId, '0'.repeat(64), applied, now, now);
      fx.db.prepare("INSERT INTO projection_pointers VALUES ('personal', ?, ?, ?, ?)").run(view, rev, ptr, now);
    };
    add(1, 'knowledge', vaultId, 'mine', 'mine', 1);
    add(2, 'foreign', 'unrelated-vault', 'foreign', 'foreign', 1);
    add(3, 'mismatched', vaultId, 'other-intent', 'fake-intent', 1);
    add(4, 'incomplete', vaultId, 'unapplied', 'unapplied', 0);
    const readRecent = createVaultActivityReader(fx.db);
    expect(readRecent(fx.options.loadVault(vaultId)).projection).toEqual({ revision: 1, observedAt: now });
    const inspectObsidian = createObsidianInspector({
      localDeviceId: deviceId, lockedVersion: null, installerHash: null, readMacState: async () => null,
    });
    fx.db.prepare("DELETE FROM projection_pointers WHERE intent_id = 'mine'").run();
    const doctor = createObsidianDoctor({ ...fx.options, readRecent, inspectObsidian });
    expect(await doctor.inspect(deviceId, vaultId)).toMatchObject({
      connection: { projection_status: 'missing' }, recent: { projection: null },
    });
  } finally {
    await fx.disconnect();
  }
});

test.each(['success', 'untrusted', 'bad-version', 'failed-detach'] as const)('Mac installer fixture: %s', async (caseName) => {
  const fx = await fixture();
  try {
    const apps = join(fx.dir, 'Applications');
    await mkdir(apps);
    const authorizedDestination = join(apps, 'Obsidian.app');
    const dmgPath = join(fx.dir, 'fixture.dmg');
    const bytes = Buffer.from('not a real DMG');
    await writeFile(dmgPath, bytes);
    const commands: string[] = [];
    const runCommand = async (cmd: string, args: readonly string[]) => {
      commands.push(cmd + ':' + args[0]);
      if (cmd === '/usr/bin/hdiutil' && args[0] === 'attach') {
        expect(args).toContain('-readonly');
        const mount = args[args.indexOf('-mountpoint') + 1];
        expect(mount).toBeTruthy();
        const app = join(mount, 'Obsidian.app');
        await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
        await writeFile(join(app, 'Contents', 'Info.plist'), 'fixture metadata');
        await writeFile(join(app, 'Contents', 'MacOS', 'Obsidian'), 'fixture executable');
        expect(args.at(-1)).not.toBe(dmgPath);
      }
      if (cmd === '/usr/bin/hdiutil' && args[0] === 'detach' && caseName === 'failed-detach') throw new Error('detach failed');
      if (cmd === '/usr/bin/codesign' && args.includes('-R')) {
        expect(args[args.indexOf('-R') + 1]).toMatch(/^=anchor apple generic and identifier "md[.]obsidian"/);
        if (caseName === 'untrusted') throw new Error('untrusted signature');
      }
      if (cmd === '/usr/bin/plutil') {
        return { stdout: args[1] === 'CFBundleIdentifier' ? 'md.obsidian' : caseName === 'bad-version' ? '0.0.0' : '1.15.1' };
      }
      if (cmd === '/usr/bin/file') return { stdout: 'Mach-O universal binary [x86_64] [arm64]' };
      if (cmd === '/usr/bin/ditto') await cp(args[0], args[1], { recursive: true });
      if (cmd === '/usr/bin/osascript') {
        expect(args.at(-1)).toBe(authorizedDestination);
        await rename(args.at(-2)!, args.at(-1)!);
      }
      return { stdout: '' };
    };
    const installer = createMacObsidianInstaller({ applicationsDirectory: apps, scratchDirectory: fx.options.stageParent,
      runCommand, platform: 'darwin' });
    const request = { dmgPath, lock: { version: '1.15.1', sha256: hash(bytes) }, authorizedDestination };
    await expect(installer.install({ ...request, authorizedDestination: join(apps, 'Other.app') })).rejects.toThrow('OBSIDIAN_DESTINATION_UNAUTHORIZED');
    await expect(installer.install({ ...request, lock: { ...request.lock, sha256: '0'.repeat(64) } })).rejects.toThrow('OBSIDIAN_INSTALLER_HASH_MISMATCH');
    expect(commands).toEqual([]);
    if (caseName === 'success') {
      await expect(installer.install(request)).resolves.toMatchObject({ status: 'installed', path: authorizedDestination });
      expect(await readdir(apps)).toEqual(['Obsidian.app']);
      expect(await readdir(fx.options.stageParent)).toEqual([]);
      expect(commands.lastIndexOf('/usr/bin/hdiutil:detach')).toBeLessThan(commands.lastIndexOf('/usr/bin/osascript:-l'));
      const previous = [...commands];
      await expect(installer.install(request)).rejects.toThrow('OBSIDIAN_DESTINATION_EXISTS');
      expect(commands).toEqual(previous);
    } else {
      await expect(installer.install(request)).rejects.toThrow();
      expect(commands).toContain('/usr/bin/hdiutil:detach');
      expect(commands).not.toContain('/usr/bin/osascript:-l');
      expect(await readdir(apps)).toEqual([]);
      expect(await readdir(fx.options.stageParent)).toHaveLength(caseName === 'failed-detach' ? 1 : 0);
    }
  } finally {
    await fx.disconnect();
  }
});

const indexRelative = '系统视图/索引.md';

async function killAtIndexPublication(code: string, target: string, timing: 'before' | 'after' = 'after') {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    registerHooks({
      resolve(specifier, context, next) {
        try {
          return next(specifier, context);
        } catch (error) {
          if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && specifier.endsWith('.js')) {
            return next(specifier.slice(0, -3) + '.ts', context);
          }
          throw error;
        }
      }
    });
    for (const name of ['link', 'rename']) {
      const publish = fs.promises[name];
      fs.promises[name] = async (source, destination) => {
        if (destination === ${JSON.stringify(target)} && ${JSON.stringify(timing)} === 'before') process.kill(process.pid, 'SIGKILL');
        await publish(source, destination);
        if (destination === ${JSON.stringify(target)}) process.kill(process.pid, 'SIGKILL');
      };
    }
    syncBuiltinESMExports();
    ${code}
  `], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => signal === 'SIGKILL' ? resolve() : reject(new Error(`exit ${code}: ${stderr}`)));
  });
}

test.each(['exact', 'exact without seed', 'owner changed index', 'owner replaced index with identical bytes', 'batch changed',
  'batch changed before index', 'different request', 'unowned projection scope'] as const)(
  'reconciles a process stopped immediately after first projected index publication: %s', async (scenario) => {
    const fx = await fixture();
    try {
      await confirmVault(fx.db, deviceId, vaultId, now);
      if (scenario !== 'exact without seed') await createVaultKitInstaller(fx.options).installVaultKit(vaultId);
      const database = new URL('../../packages/storage/src/database.ts', import.meta.url).href;
      const projector = new URL('../../packages/integrations/vault/projector.ts', import.meta.url).href;
      const files = Object.fromEntries(PROJECTION_BATCH_FILES.map((path) => [path, `# ${path}\n`]));
      const input = { vaultId, viewKind: 'knowledge', revision: 1, files };
      const target = join(fx.root, indexRelative);
      const batchPath = join(fx.root, '系统视图', '批次', '1', '知识', '当前.md');
      const stopAt = scenario === 'batch changed before index' ? dirname(dirname(batchPath)) : target;
      await killAtIndexPublication(`
        const { openDatabase } = await import(${JSON.stringify(database)});
        const { projectVault } = await import(${JSON.stringify(projector)});
        await projectVault(openDatabase(${JSON.stringify(join(fx.dir, 'test.sqlite'))}), ${JSON.stringify(input)}, {
          now: ${JSON.stringify(now)}
        });
      `, stopAt);
      const original = await readFile(target);
      if (scenario === 'batch changed before index') expect(original).toEqual(await readFile(join(assets, indexRelative)));
      else expect(original.toString()).toContain('projection_revision: 1');
      expect(fx.db.prepare("SELECT revision_id FROM vault_revisions").all()).toEqual([]);
      expect(fx.db.prepare("SELECT projection_revision FROM projection_pointers").all()).toEqual([]);
      expect(fx.db.prepare("SELECT applied, cleanup_state FROM projection_batches").all())
        .toEqual([{ applied: 0, cleanup_state: 'pending' }]);
      if (scenario === 'owner changed index') await writeFile(target, 'owner replaced body\r\n');
      if (scenario === 'owner replaced index with identical bytes') {
        const replacement = join(dirname(target), 'owner-saved.md');
        await writeFile(replacement, original);
        await rename(replacement, target);
      }
      if (scenario === 'batch changed' || scenario === 'batch changed before index') {
        await writeFile(batchPath, 'owner changed batch');
      }
      if (scenario === 'unowned projection scope') fx.db.prepare('UPDATE vaults SET config_revision = config_revision + 1 WHERE vault_id = ?').run(vaultId);
      const api = createVaultApi(fx.db, { blobs: createBlobStore(join(fx.dir, 'blobs')), captureHost, now: () => new Date(now) });
      const before = await readFile(target);
      const indexInode = (await lstat(target)).ino;
      const batchBefore = await readFile(batchPath);
      if (scenario === 'different request') {
        await expect(api.project({ ...input, files: { ...input.files, '知识/当前.md': 'not original' } }))
          .resolves.toMatchObject({ applied: false, pointer: null, state: 'failed' });
        await expect(api.project(input)).resolves.toMatchObject({ applied: true, pointer: 1, state: 'current' });
      } else if (scenario === 'exact' || scenario === 'exact without seed') {
        await expect(api.project(input)).resolves.toMatchObject({ applied: true, pointer: 1, state: 'current' });
      } else {
        await expect(api.project(input)).resolves.toMatchObject({ applied: false, pointer: null, state: 'failed' });
      }
      expect(await readFile(target)).toEqual(before);
      expect((await lstat(target)).ino).toBe(indexInode);
      expect(await readFile(batchPath)).toEqual(batchBefore);
    } finally {
      await fx.disconnect();
    }
  },
);

test('restarts Vault kit installation after the synced index is staged but before it is published', async () => {
  const fx = await fixture();
  try {
    await confirmVault(fx.db, deviceId, vaultId, now);
    const owner = Buffer.from([0xef, 0xbb, 0xbf, 35, 32, 65, 13, 10]);
    for (const relative of [ownerTemplate, uriPath]) {
      await mkdir(dirname(join(fx.root, relative)), { recursive: true });
      await writeFile(join(fx.root, relative), owner);
    }
    const { loadVault, inspectVault: inspect, ...options } = fx.options;
    const record = loadVault(vaultId);
    const connection = await inspect(deviceId, vaultId);
    const target = join(fx.root, indexRelative);
    await killAtIndexPublication(`
      const { createVaultKitInstaller } = await import(${JSON.stringify(entry)});
      await createVaultKitInstaller({
        ...${JSON.stringify(options)},
        loadVault: () => (${JSON.stringify(record)}),
        inspectVault: () => (${JSON.stringify(connection)}),
      }).installVaultKit(${JSON.stringify(vaultId)});
    `, target, 'before');
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    const staging = join(dirname(target), '.patrick-staging');
    const staged = await readdir(staging);
    expect(staged).toHaveLength(1);
    const index = await readFile(join(assets, indexRelative));
    expect(await readFile(join(staging, staged[0]!))).toEqual(index);

    const installer = createVaultKitInstaller(fx.options);
    const receipt = await installer.installVaultKit(vaultId);
    expect(receipt.files).toContainEqual({ path: indexRelative, state: 'created', sha256: hash(index) });
    expect(receipt.files).toContainEqual({ path: ownerTemplate, state: 'preserved', sha256: hash(owner) });
    for (const file of receipt.files) expect(hash(await readFile(join(fx.root, file.path)))).toBe(file.sha256);
    expect(await readFile(join(fx.root, uriPath))).toEqual(owner);
    expect((await installer.installVaultKit(vaultId)).files.every(({ state }) => state === 'preserved')).toBe(true);
  } finally {
    await fx.disconnect();
  }
});

test('Vault kit surfaces repair-required if a process dies after writing its seed but before attestation', async () => {
  const fx = await fixture();
  try {
    await confirmVault(fx.db, deviceId, vaultId, now);
    const { loadVault, inspectVault: inspect, ...options } = fx.options;
    const record = loadVault(vaultId);
    const connection = await inspect(deviceId, vaultId);
    const target = join(fx.root, indexRelative);
    await killAtIndexPublication(`
      const { createVaultKitInstaller } = await import(${JSON.stringify(entry)});
      await createVaultKitInstaller({
        ...${JSON.stringify(options)},
        loadVault: () => (${JSON.stringify(record)}),
        inspectVault: () => (${JSON.stringify(connection)}),
      }).installVaultKit(${JSON.stringify(vaultId)});
    `, target);
    const original = await readFile(target);
    expect(original).toEqual(await readFile(join(assets, indexRelative)));
    await expect(createVaultKitInstaller(fx.options).installVaultKit(vaultId)).rejects.toThrow('KIT_INDEX_PROOF_REPAIR_REQUIRED');
    expect(await readFile(target)).toEqual(original);
    await expect(lstat(join(fx.root, '系统视图', '.patrick-index-seed.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(fx.root, '系统视图'))).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\.patrick-vault-kit-/)]));
  } finally {
    await fx.disconnect();
  }
});
