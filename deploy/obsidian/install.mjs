import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishCreateOnly } from '../../packages/integrations/vault/create-file.ts';
import { INDEX_PATH, SEED_PROOF_PATH, indexSeedProof, readIndexFile } from '../../packages/integrations/vault/index-proof.ts';
import { checkRoot, draftDirs, hasServiceIdentity, inside, kitDirs, readRegular, safeDirectory } from './scope.mjs';

export { createMacObsidianInstaller } from './mac-install.mjs';
export { verifyObsidianInstaller } from './dmg.mjs';

const releaseKit = fileURLToPath(new URL('../../assets/vault-kit/', import.meta.url));
const SEED_INTENT_PATH = '系统视图/.patrick-index-seed.intent.json';
const SHA256 = /^[a-f0-9]{64}$/;
const kitFiles = new Map([
  ['模板/知识笔记.md', '知识笔记.md'],
  ['模板/判断案例.md', '判断案例.md'],
  ['模板/标准修订.md', '标准修订.md'],
  ...['索引.md', '知识.base', '标准.base', '知识关系.canvas'].map((name) => [`系统视图/${name}`, `系统视图/${name}`]),
]);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function createVaultKitInstaller(options) {
  const { assetRoot = releaseKit, stageParent = tmpdir() } = options;
  async function assertScope(vaultId, previous) {
    if (!hasServiceIdentity(options.serviceUid)) throw new Error('VAULT_SERVICE_IDENTITY_MISMATCH');
    if (options.editorUid !== options.serviceUid || !hasServiceIdentity(options.editorUid)) {
      throw new Error('VAULT_EDITOR_IDENTITY_UNVERIFIED');
    }
    if ((process.umask() & 0o700) !== 0) throw new Error('VAULT_UNSAFE_CREATE_MODE');
    const vault = await options.loadVault(vaultId);
    if (vault.vault_id !== vaultId || vault.capture_host !== options.captureHost || vault.status !== 'connected') {
      throw new Error('VAULT_NOT_CONFIRMED');
    }
    await checkRoot(vault);
    const connection = await options.inspectVault(options.deviceId, vaultId);
    if (connection.status !== 'connected' || connection.collection_status !== 'ready' ||
        connection.client_mapping_revision < 1 || connection.vault_id !== vaultId ||
        connection.source_id !== vault.source_id || connection.capture_host !== vault.capture_host ||
        connection.root_identity !== vault.root_identity || connection.config_revision !== vault.config_revision ||
        connection.scope_hash !== vault.scope_hash) throw new Error('VAULT_NOT_CONFIRMED');
    if (previous && (vault.vault_id !== previous.vault_id || vault.root_path !== previous.root_path ||
        vault.root_identity !== previous.root_identity || vault.config_revision !== previous.config_revision ||
        vault.connection_epoch !== previous.connection_epoch || vault.scope_hash !== previous.scope_hash)) {
      throw new Error('VAULT_SCOPE_CHANGED');
    }
    return vault;
  }

  return {
    async installVaultKit(vaultId) {
      const vault = await assertScope(vaultId);
      const root = vault.root_path;
      const { manifest, manifestBytes, artifacts } = await loadKit(assetRoot);
      const manifestSha256 = digest(manifestBytes);
      const manifestPath = `系统视图/.patrick-vault-kit-${manifest.version}-${manifestSha256.slice(0, 12)}.json`;
      const toInstall = [...artifacts, { path: manifestPath, bytes: manifestBytes, sha256: manifestSha256 }];
      for (const dir of kitDirs) {
        const path = join(root, dir);
        if (await safeDirectory(path, root)) {
          await access(path, constants.R_OK | constants.X_OK | (draftDirs.includes(dir) ? constants.W_OK : 0));
          const staging = join(path, '.patrick-staging');
          if (await safeDirectory(staging, root)) await access(staging, constants.W_OK | constants.X_OK);
        } else {
          await access(root, constants.W_OK | constants.X_OK);
        }
      }
      const seedIntentPath = join(root, SEED_INTENT_PATH);
      const seedProofPath = join(root, SEED_PROOF_PATH);
      const seedTarget = join(root, INDEX_PATH);
      const seedSha256 = artifacts.find(({ path }) => path === INDEX_PATH).sha256;
      const seedIntent = JSON.stringify({
        format: 1, vaultId, rootIdentity: vault.root_identity, configRevision: vault.config_revision,
        scopeHash: vault.scope_hash, sha256: seedSha256,
      }) + '\n';
      const priorIntent = await readRegular(seedIntentPath, true);
      const priorProof = await readRegular(seedProofPath, true);
      if (priorIntent) {
        const seed = await readIndexFile(seedTarget);
        if (!priorProof && (priorIntent.toString('utf8') !== seedIntent || seed) ||
            priorProof && seed?.sha256 === seedSha256 && priorProof.toString('utf8') !== indexSeedProof(vault, seed)) {
          throw new Error('KIT_INDEX_PROOF_REPAIR_REQUIRED');
        }
      }
      for (const item of toInstall) {
        const destination = join(root, item.path);
        const existing = await readRegular(destination, true);
        if (item.path === manifestPath && existing && digest(existing) !== item.sha256) {
          throw new Error('KIT_INSTALLED_MANIFEST_MISMATCH');
        }
        if (!existing && await safeDirectory(dirname(destination), root)) {
          await access(dirname(destination), constants.W_OK | constants.X_OK);
        }
      }
      const stage = await realpath(stageParent);
      if (stage === root || inside(root, stage)) throw new Error('VAULT_UNSAFE_PATH');
      const temporary = await mkdtemp(join(stage, 'patrick-vault-kit-'));
      try {
        for (const dir of kitDirs) {
          await assertScope(vaultId, vault);
          const path = join(root, dir);
          if (!await safeDirectory(path, root)) {
            try {
              await mkdir(path, { mode: 0o750 });
            } catch (error) {
              if (error.code !== 'EEXIST') throw error;
            }
            await safeDirectory(path, root);
          }
          await access(path, constants.R_OK | constants.X_OK | (draftDirs.includes(dir) ? constants.W_OK : 0));
        }
        const files = [];
        for (const [index, item] of toInstall.entries()) {
          await assertScope(vaultId, vault);
          const destination = join(root, item.path);
          const parent = dirname(destination);
          if (!await safeDirectory(parent, root)) throw new Error('VAULT_UNSAFE_PATH');
          const existing = await readRegular(destination, true, true);
          if (existing) {
            if (item.path === INDEX_PATH && await readRegular(seedIntentPath, true) &&
                !await readRegular(seedProofPath, true)) throw new Error('KIT_INDEX_PROOF_REPAIR_REQUIRED');
            const sha256 = digest(existing);
            if (item.path === manifestPath && sha256 !== item.sha256) throw new Error('KIT_INSTALLED_MANIFEST_MISMATCH');
            files.push({ path: item.path, state: 'preserved', sha256 });
            continue;
          }
          const stagedPath = join(temporary, `${index}.stage`);
          await writeVerifiedStage(stagedPath, item.bytes, item.sha256);
          await assertScope(vaultId, vault);
          if (!await safeDirectory(parent, root)) throw new Error('VAULT_UNSAFE_PATH');
          const staging = join(parent, '.patrick-staging');
          if (await safeDirectory(staging, root)) await access(staging, constants.W_OK | constants.X_OK);
          if (item.path === INDEX_PATH) {
            const intentStage = join(temporary, 'index-seed-intent.stage');
            await writeVerifiedStage(intentStage, seedIntent, digest(seedIntent));
            await publishCreateOnly(intentStage, seedIntentPath);
            if ((await readRegular(seedIntentPath, true, true))?.toString('utf8') !== seedIntent) {
              throw new Error('KIT_INDEX_PROOF_REPAIR_REQUIRED');
            }
          }
          const result = await publishCreateOnly(stagedPath, destination);
          if (item.path === INDEX_PATH && result !== 'created') throw new Error('KIT_INDEX_PROOF_REPAIR_REQUIRED');
          const readback = await readRegular(destination, true, true);
          if (!readback) throw new Error('KIT_TARGET_VANISHED');
          const sha256 = digest(readback);
          if ((result === 'created' || item.path === manifestPath) && sha256 !== item.sha256) throw new Error('KIT_TARGET_HASH_MISMATCH');
          if (item.path === INDEX_PATH && result === 'created') {
            const identity = await readIndexFile(destination);
            if (!identity || identity.sha256 !== item.sha256) throw new Error('KIT_TARGET_HASH_MISMATCH');
            const proof = indexSeedProof(vault, identity);
            const proofStage = join(temporary, 'index-seed.stage');
            await writeVerifiedStage(proofStage, proof, digest(proof));
            const proofPath = seedProofPath;
            await assertScope(vaultId, vault);
            if (!await safeDirectory(parent, root)) throw new Error('VAULT_UNSAFE_PATH');
            await publishCreateOnly(proofStage, proofPath);
            if (digest(await readRegular(proofPath, true, true) ?? '') !== digest(proof)) {
              throw new Error('KIT_INDEX_PROOF_REPAIR_REQUIRED');
            }
          }
          files.push({ path: item.path, state: result === 'created' ? 'created' : 'preserved', sha256 });
        }
        return { vaultId, sourceId: vault.source_id, configRevision: vault.config_revision, scopeHash: vault.scope_hash,
          version: manifest.version, manifestSha256, manifestPath, files };
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  };
}

async function writeVerifiedStage(path, bytes, sha256) {
  const fd = await open(path, 'wx', 0o600);
  try {
    await fd.writeFile(bytes);
    await fd.sync();
  } finally {
    await fd.close();
  }
  if (digest(await readFile(path)) !== sha256) throw new Error('KIT_HASH_MISMATCH');
}

async function loadKit(assetRoot) {
  const manifestPath = join(assetRoot, 'manifest.json');
  const manifestBytes = await readRegular(manifestPath);
  if (!manifestBytes) throw new Error('KIT_MANIFEST_INVALID');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('KIT_MANIFEST_INVALID');
  }
  if (manifest?.name !== 'vault-kit' || !/^\d+\.\d+\.\d+$/.test(manifest.version ?? '') ||
      !Array.isArray(manifest.files) || manifest.files.length !== kitFiles.size) throw new Error('KIT_MANIFEST_INVALID');
  const seen = new Set();
  const artifacts = [];
  const canonical = await realpath(assetRoot);
  for (const item of manifest.files) {
    if (typeof item?.path !== 'string' || typeof item.source !== 'string' || kitFiles.get(item.path) !== item.source ||
        seen.has(item.path) || typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)) throw new Error('KIT_MANIFEST_INVALID');
    seen.add(item.path);
    const path = join(canonical, item.source);
    if (basename(item.source) !== item.source && !await safeDirectory(dirname(path), canonical)) throw new Error('KIT_HASH_MISMATCH');
    const bytes = await readRegular(path);
    if (!bytes || digest(bytes) !== item.sha256) throw new Error('KIT_HASH_MISMATCH');
    artifacts.push({ path: item.path, sha256: item.sha256, bytes });
  }
  return { manifest, manifestBytes, artifacts };
}
