import { spawnSync } from 'node:child_process';
import { chmod, chown, cp, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, test } from 'vitest';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const serviceName = '_mdnsresponder';
const dropAndRun = `
  import { spawnSync } from 'node:child_process';
  const [uid, gid, timeoutMs, execPath, ...args] = process.argv.slice(1);
  process.setgroups([Number(gid)]);
  process.setgid(Number(gid));
  process.setuid(Number(uid));
  const result = spawnSync(execPath, args, {
    cwd: process.cwd(),
    env: { PATH: '/usr/bin:/bin' },
    stdio: 'inherit',
    timeout: Number(timeoutMs),
    killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
`;
const serviceEntry = `
  import assert from 'node:assert/strict';
  import { createHash } from 'node:crypto';
  import { lstat, readFile, writeFile } from 'node:fs/promises';
  import { join } from 'node:path';
  import { openDatabase } from './packages/storage/src/database.ts';
  import { createVaultApi } from './packages/integrations/vault/drafts.ts';
  import { createBlobStore } from './packages/storage/src/blob-store.ts';
  import { INDEX_PATH } from './packages/integrations/vault/index-proof.ts';
  import { PROJECTION_BATCH_FILES } from './packages/integrations/vault/projector.ts';

  const [vaultRoot, privateRoot, migrations, serviceUid, serviceGid, checkGroups] = process.argv.slice(2);
  const expectedIdentity = [Number(serviceUid), Number(serviceUid), Number(serviceGid), Number(serviceGid)];
  assert.deepEqual([process.getuid(), process.geteuid(), process.getgid(), process.getegid()], expectedIdentity);
  if (checkGroups === '1') assert.deepEqual(process.getgroups(), [Number(serviceGid)]);
  process.umask(0o077);
  const stage = join(vaultRoot, '.patrick-staging');
  const standardsStage = join(vaultRoot, '标准修订', '.patrick-staging');
  await writeFile(join(stage, 'service-marker'), 'private staging path', { flag: 'wx', mode: 0o600 });
  await writeFile(join(standardsStage, 'draft-marker'), 'private draft staging path', { flag: 'wx', mode: 0o600 });
  const db = openDatabase(join(privateRoot, 'service.sqlite'), { migrationsDir: migrations });
  try {
    const api = createVaultApi(db, { blobs: createBlobStore(join(privateRoot, 'blobs')) });
    const vaultId = 'native-access-fixture';
    const deviceId = 'native-device';
    const accountId = 'fixture-owner';
    await api.connectVault({ vaultId, deviceId, root: vaultRoot, accountId, domain: 'personal' });
    await api.confirmVault(deviceId, vaultId);
    const projection = join(vaultRoot, '系统视图');
    const index = join(vaultRoot, INDEX_PATH);
    assert.equal(await lstat(index).then(() => true, error => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }), false);
    const files = Object.fromEntries(PROJECTION_BATCH_FILES.map(name => [name, 'native projection fixture: ' + name + '\\n']));
    const result = await api.project({ vaultId, viewKind: 'knowledge', revision: 1, files });
    assert.deepEqual(result, { applied: true, pointer: 1, state: 'current' });
    const pointer = db.prepare("SELECT projection_revision FROM projection_pointers WHERE data_domain = 'personal' AND view_kind = 'knowledge'").get();
    assert.equal(pointer?.projection_revision, 1);
    const batch = join(projection, '批次', '1');
    for (const path of [index, ...PROJECTION_BATCH_FILES.map(name => join(batch, name))]) {
      const info = await lstat(path);
      assert.equal(info.isFile(), true, path);
      assert.equal(info.uid, Number(serviceUid), path);
      assert.equal(info.mode & 0o777, 0o600, path);
    }
    const principal = {
      account_id: accountId,
      caller_id: 'native-fixture',
      auth_epoch: 1,
      authenticated_at: new Date().toISOString(),
      domains: ['personal'],
      operations: ['owner', 'edits.write'],
    };
    const draftRequest = { operation: 'create_standard', draft_key: 'native-draft', expected_active_version: null };
    const edit = await api.createEdit(principal, draftRequest);
    const reopened = await api.createEdit(principal, draftRequest);
    assert.deepEqual(reopened, edit);
    const draftRelativePath = '标准修订/native-draft.md';
    const draftPath = join(vaultRoot, draftRelativePath);
    const draftInfo = await lstat(draftPath);
    assert.equal(draftInfo.isFile(), true, draftPath);
    assert.equal(draftInfo.uid, Number(serviceUid), draftPath);
    assert.equal(draftInfo.mode & 0o777, 0o600, draftPath);
    const draftBytes = await readFile(draftPath);
    const draftSha256 = createHash('sha256').update(draftBytes).digest('hex');
    assert.deepEqual(edit.file, { state: 'awaiting_save', proof_ref: draftSha256 });
    console.log(JSON.stringify({
      result,
      files,
      draft: { relativePath: draftRelativePath, content: draftBytes.toString('utf8'), sha256: draftSha256 },
    }));
  } finally {
    db.close();
  }
`;

const editorEntry = `
  import assert from 'node:assert/strict';
  import { open, readFile, readdir, stat, unlink } from 'node:fs/promises';
  import { join } from 'node:path';

  const [vaultRoot, privateRoot, editorUid, editorGid, evidence] = process.argv.slice(1);
  assert.deepEqual([process.getuid(), process.geteuid(), process.getgid(), process.getegid()],
    [Number(editorUid), Number(editorUid), Number(editorGid), Number(editorGid)]);
  assert.deepEqual(process.getgroups(), [Number(editorGid)]);
  const { files, draft } = JSON.parse(evidence);
  const projection = join(vaultRoot, '系统视图');
  const index = join(projection, '索引.md');
  assert.match(await readFile(index, 'utf8'), /projection_revision: 1\\n/);
  assert.match(await readFile(index, 'utf8'), /系统视图\\/批次\\/1/);
  let firstBatchFile = '';
  for (const [name, bytes] of Object.entries(files)) {
    const target = join(projection, '批次', '1', name);
    if (!firstBatchFile) firstBatchFile = target;
    assert.equal(await readFile(target, 'utf8'), bytes, name);
  }
  const denied = error => error?.code === 'EACCES' || error?.code === 'EPERM';
  await assert.rejects(async () => { await (await open(index, 'r+')).close(); }, denied, 'index write');
  await assert.rejects(unlink(index), denied, 'index removal');
  await assert.rejects(async () => { await (await open(firstBatchFile, 'r+')).close(); }, denied, 'batch file write');
  await assert.rejects(unlink(firstBatchFile), denied, 'batch file removal');
  const draftPath = join(vaultRoot, draft.relativePath);
  assert.equal(await readFile(draftPath, 'utf8'), draft.content);
  assert.match(draft.content, /# 适用范围/);
  const suffix = '\\nDesktop editor edit\\n';
  const draftHandle = await open(draftPath, 'r+');
  try {
    const appendBytes = Buffer.from(suffix, 'utf8');
    await draftHandle.write(appendBytes, 0, appendBytes.length, Buffer.byteLength(draft.content, 'utf8'));
  } finally {
    await draftHandle.close();
  }
  assert.equal(await readFile(draftPath, 'utf8'), draft.content + suffix);
  await assert.rejects(unlink(draftPath), denied, 'draft removal');
  const stage = join(vaultRoot, '.patrick-staging');
  await assert.rejects(readdir(stage), denied, 'staging listing');
  await assert.rejects(stat(join(stage, 'service-marker')), denied, 'staging traversal');
  const standardsStage = join(vaultRoot, '标准修订', '.patrick-staging');
  await assert.rejects(readdir(standardsStage), denied, 'draft staging listing');
  await assert.rejects(stat(join(standardsStage, 'draft-marker')), denied, 'draft staging traversal');
  await assert.rejects(readdir(privateRoot), denied, 'private Service directory listing');
  await assert.rejects(readFile(join(privateRoot, 'service.sqlite')), denied, 'private Service database read');
`;

function run(command: string, args: string[], options: { cwd?: string; uid?: number; gid?: number; timeout?: number } = {}) {
  const result = spawnSync(command, args, {
    ...options, env: { PATH: '/usr/bin:/bin' }, timeout: options.timeout ?? 5_000, encoding: 'utf8', killSignal: 'SIGKILL',
  });
  expect(result.status, result.error?.message ?? result.stderr).toBe(0);
  return result.stdout.trim();
}

function runAs(account: { uid: number; gid: number }, args: string[], cwd: string, timeout = 20_000) {
  return run(process.execPath, [
    '--input-type=module', '-e', dropAndRun,
    String(account.uid), String(account.gid), String(timeout), process.execPath, ...args,
  ], { cwd, timeout: timeout + 5_000 });
}

function localAccount(name: string) {
  const uid = Number(run('/usr/bin/id', ['-u', name]));
  const gid = Number(run('/usr/bin/id', ['-g', name]));
  expect(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0, name).toBe(true);
  return { uid, gid };
}

async function buildRunner(runner: string) {
  const entry = join(runner, 'packages', 'integrations', 'vault', 'service.mjs');
  const migrations = join(runner, 'migrations');
  const modules = join(runner, 'node_modules');
  const vaultKit = join(runner, 'assets', 'vault-kit');
  await mkdir(dirname(entry), { recursive: true, mode: 0o755 });
  await mkdir(modules, { recursive: true, mode: 0o755 });
  await mkdir(dirname(vaultKit), { recursive: true, mode: 0o755 });
  for (const name of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
    await cp(dirname(require.resolve(`${name}/package.json`)), join(modules, name), { recursive: true, dereference: true });
  }
  await cp(join(repo, 'packages/storage/migrations'), migrations, { recursive: true });
  await cp(join(repo, 'assets/vault-kit'), vaultKit, { recursive: true });
  await build({
    stdin: { contents: serviceEntry, resolveDir: repo },
    outfile: entry,
    bundle: true, format: 'esm', platform: 'node', target: 'node26.13', external: ['better-sqlite3'],
  });
  run('/bin/chmod', ['-R', 'go-w,a+rX', runner]);
  return { entry, migrations };
}

test.skipIf(process.env.PATRICK_T27_NATIVE_ACCESS !== '1')(
  'a distinct desktop UID reads Service projections and edits create-only drafts through inherited Darwin ACLs',
  async ({ onTestFinished }) => {
  expect([process.platform, process.getuid?.(), process.geteuid?.()]).toEqual(['darwin', 0, 0]);
  const editorName = process.env.PATRICK_T27_DESKTOP_USER ?? '';
  expect(editorName, 'set PATRICK_T27_DESKTOP_USER to the approved local desktop short name').toMatch(/^[a-zA-Z_][a-zA-Z0-9_-]*$/);
  const editor = localAccount(editorName);
  const service = localAccount(serviceName);
  expect(editor.uid).not.toBe(service.uid);
  const scratch = await mkdtemp('/private/tmp/patrick-t27-native-');
  onTestFinished(() => rm(scratch, { recursive: true, force: true }));
  try {
    run('/bin/chmod', ['-N', scratch]);
    const vault = join(scratch, 'vault');
    const privateRoot = join(scratch, 'service-private');
    const runner = join(scratch, 'runner');
    const stage = join(vault, '.patrick-staging');
    const projection = join(vault, '系统视图');
    const batches = join(projection, '批次');
    const standards = join(vault, '标准修订');
    const standardsStage = join(standards, '.patrick-staging');
    for (const directory of [vault, privateRoot, stage, projection, batches, standards, standardsStage]) {
      await mkdir(directory, { mode: 0o700 });
      await chown(directory, service.uid, service.gid);
    }
    await mkdir(runner);
    await chmod(runner, 0o755);
    const { entry, migrations } = await buildRunner(runner);
    const addAcl = (path: string, user: string, rights: string) =>
      run('/bin/chmod', ['+a#', '0', `user:${user} allow ${rights}`, path]);
    addAcl(scratch, serviceName, 'search');
    addAcl(scratch, editorName, 'search');
    for (const directory of [vault, projection, batches, standards]) addAcl(directory, editorName, 'list,search');
    addAcl(stage, editorName, 'list,search,directory_inherit,only_inherit');
    addAcl(stage, editorName, 'read,file_inherit,directory_inherit,only_inherit');
    addAcl(standardsStage, editorName, 'read,write,append,file_inherit,only_inherit');

    const evidence = runAs(service, [entry, vault, privateRoot, migrations, String(service.uid), String(service.gid), '1'], runner);
    const parsed = JSON.parse(evidence) as { result: unknown; draft: { relativePath: string } };
    expect(parsed.result).toEqual({ applied: true, pointer: 1, state: 'current' });
    expect((await lstat(join(stage, 'service-marker'))).uid).toBe(service.uid);
    expect((await lstat(join(standardsStage, 'draft-marker'))).uid).toBe(service.uid);
    expect((await lstat(join(privateRoot, 'service.sqlite'))).uid).toBe(service.uid);
    runAs(editor, ['--input-type=module', '-e', editorEntry, vault, privateRoot, String(editor.uid), String(editor.gid), evidence], runner);
    const editedDraft = await lstat(join(vault, parsed.draft.relativePath));
    expect(editedDraft.uid).toBe(service.uid);
    expect(editedDraft.mode & 0o777).toBe(0o600);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 45_000);
