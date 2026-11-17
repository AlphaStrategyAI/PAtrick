import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { matchEditorProcess } from '../../deploy/obsidian/rehearsal-observation.js';
import { createRehearsal } from '../../deploy/obsidian/rehearsal.js';

const uid = process.geteuid?.() ?? -1;
const requested = { testUser: 'isolated-test', testUid: uid, serviceUid: uid };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'patrick-rehearsal-test-'));
  let running: boolean | null = true;
  let boot = 'test-boot-one';
  const runtime = {
    username: 'isolated-test', uid, realUid: uid, home,
    observeEditor: async () => running === null ? null : { running, bundlePath: '/fixture/Obsidian.app', pid: running ? 123 : null },
    observeProcess: async (pid: number) => ({ pid, uid, startedKey: 'fixture process start' }),
    observeBoot: async () => boot,
  };
  return { home, runtime, setRunning: (value: boolean | null) => { running = value; },
    setBoot: (value: string) => { boot = value; }, close: () => rm(home, { recursive: true, force: true }) };
}

test.skipIf(uid <= 0)('requires the selected non-root login and shared verified editor/service UID before creating anything', async () => {
  const fx = await fixture();
  try {
    expect(() => createRehearsal(fx.runtime, { ...requested, testUser: 'another-login' })).toThrow('REHEARSAL_LOGIN_MISMATCH');
    expect(() => createRehearsal(fx.runtime, { ...requested, serviceUid: uid + 1 })).toThrow('REHEARSAL_SEPARATE_SERVICE_UID_UNSUPPORTED');
    expect(() => createRehearsal({ ...fx.runtime, uid: 0, realUid: 0 }, { ...requested, testUid: 0, serviceUid: 0 }))
      .toThrow('REHEARSAL_NON_ROOT_REQUIRED');
    expect(await readdir(fx.home)).toEqual([]);
  } finally { await fx.close(); }
});

test.skipIf(uid <= 0)('isolates both new sessions and binds phased evidence to real T06/T07 archive and projection receipts', async () => {
  const fx = await fixture();
  try {
    const rehearsal = createRehearsal(fx.runtime, requested);
    const first = await rehearsal.init();
    const second = await rehearsal.init();
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.vaultPath.startsWith(first.sessionPath + '/')).toBe(true);
    await expect(rehearsal.saveClosedSample(first.sessionId, 'editor-closed')).rejects.toThrow('REHEARSAL_WORKER_NOT_WAITING');
    const open = await rehearsal.watch(first.sessionId, 'editor-open', {
      timeoutMs: 1000,
      onReady: async () => {
        for (const note of first.guiEdits) await appendFile(join(first.vaultPath, note.relativePath), '\n' + note.marker + '\n');
      },
    });
    expect(open).toMatchObject({
      phase: 'editor-open', editorObservation: { start: 'running', atCapture: 'running' },
      manualGuiSave: 'operator_confirmation_required', publication: { revision: 1 },
      candidate: { activeVersion: null },
    });
    fx.setRunning(false);
    const closed = await rehearsal.watch(first.sessionId, 'editor-closed', {
      timeoutMs: 1000,
      onReady: () => rehearsal.saveClosedSample(first.sessionId, 'editor-closed'),
    });
    expect(closed).toMatchObject({
      phase: 'editor-closed', editorObservation: { start: 'stopped', atCapture: 'stopped' },
      publication: { revision: 2 },
      stoppedSample: { phase: 'editor-closed', workerId: expect.any(String), afterSha256: expect.any(String), writer: { uid } },
    });
    expect(closed.stoppedSample?.afterSha256).toBe(closed.source[0].sha256);
    expect(closed.stoppedSample?.workerId).toBe(closed.worker.id);
    expect(closed.source).toHaveLength(1);
    expect(closed.source[0].observedSeq).toBeGreaterThan(open.source.find((item) => item.relativePath === closed.source[0].relativePath)!.observedSeq);
    fx.setBoot('test-boot-two');
    const restarted = await createRehearsal(fx.runtime, requested).watch(first.sessionId, 'after-restart', {
      timeoutMs: 1000,
      onReady: () => rehearsal.saveClosedSample(first.sessionId, 'after-restart'),
    });
    expect(restarted).toMatchObject({ phase: 'after-restart', bootComparedToPrior: 'changed', publication: { revision: 3 } });
    expect(restarted.worker.id).not.toBe(closed.worker.id);
    expect(restarted.worker.pid).toBe(closed.worker.pid);
    expect(restarted.freshWorkerProcess).toBe(false); // Same test process is not a native restart.
    const db = new Database(first.databasePath, { readonly: true, fileMustExist: true });
    try {
      for (const receipt of [open, closed, restarted]) {
        for (const source of receipt.source) {
          const row = db.prepare('SELECT content_hash FROM vault_revisions WHERE revision_id = ?').get(source.revisionId);
          expect(row).toEqual({ content_hash: source.sha256 });
          expect(hash(await readFile(join(first.blobPath, source.sha256.slice(0, 2), source.sha256)))).toBe(source.sha256);
        }
        expect(db.prepare('SELECT applied FROM projection_batches WHERE projection_revision = ?').get(receipt.publication.revision))
          .toEqual({ applied: 1 });
      }
      expect(db.prepare('SELECT candidate_id FROM standard_candidates WHERE candidate_id = ?').get(open.candidate.id))
        .toEqual({ candidate_id: open.candidate.id });
      expect(db.prepare('SELECT projection_revision FROM projection_pointers').get()).toEqual({ projection_revision: 3 });
    } finally { db.close(); }
    expect((await rehearsal.status(first.sessionId)).evidence).toHaveLength(3);
    expect((await rehearsal.status(second.sessionId)).evidence).toEqual([]);
  } finally { await fx.close(); }
});

test.skipIf(uid <= 0)('fails closed for unknown editor state, added content and a symlinked Vault directory', async () => {
  const fx = await fixture();
  try {
    const rehearsal = createRehearsal(fx.runtime, requested);
    const session = await rehearsal.init();
    await expect(rehearsal.status('../some-other-vault')).rejects.toThrow('REHEARSAL_SESSION_INVALID');
    fx.setRunning(null);
    await expect(rehearsal.watch(session.sessionId, 'editor-open', { timeoutMs: 100 })).rejects.toThrow('REHEARSAL_EDITOR_NOT_OBSERVED');
    fx.setRunning(true);
    const outside = join(fx.home, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'private.md'), 'unrelated owner bytes');
    const extra = join(session.vaultPath, '知识笔记', 'unapproved.md');
    await writeFile(extra, 'unapproved synthetic test path');
    await expect(rehearsal.watch(session.sessionId, 'editor-open', { timeoutMs: 100 })).rejects.toThrow('REHEARSAL_UNEXPECTED_VAULT_CONTENT');
    await rm(extra);
    await symlink(join(outside, 'private.md'), extra);
    await expect(rehearsal.watch(session.sessionId, 'editor-open', { timeoutMs: 100 })).rejects.toThrow('REHEARSAL_UNEXPECTED_VAULT_CONTENT');
    expect((await rehearsal.status(session.sessionId)).evidence).toEqual([]);
    expect(await readFile(join(outside, 'private.md'), 'utf8')).toBe('unrelated owner bytes');
  } finally { await fx.close(); }
});

test('native CLI help and option rejection do not require a desktop', async () => {
  const entry = fileURLToPath(new URL('../../deploy/obsidian/rehearsal.mjs', import.meta.url));
  const run = promisify(execFile);
  await expect(run(process.execPath, [entry, '--help'])).resolves.toMatchObject({ stdout: expect.stringContaining('sample-save') });
  for (const extra of ['--vault', '--token']) {
    await expect(run(process.execPath, [entry, 'init', extra, '/tmp/must-not-be-opened']))
      .rejects.toMatchObject({ stderr: expect.stringContaining('Unknown option') });
  }
  if (process.platform === 'darwin' && uid > 0) {
    await expect(run(process.execPath, [entry, 'init', '--test-user', 'never-the-selected-test-login', '--test-uid', String(uid + 1),
      '--service-uid', String(uid + 1)])).rejects.toMatchObject({ stderr: expect.stringContaining('REHEARSAL_LOGIN_MISMATCH') });
  }
});

test.skipIf(uid <= 0)('checks canonical home and ancestors for Vault markers before creating the rehearsal area', async () => {
  const fx = await fixture();
  try {
    const nested = join(fx.home, 'fake-login');
    await mkdir(nested);
    await mkdir(join(fx.home, '.obsidian'));
    await writeFile(join(fx.home, 'untouched.md'), 'external vault fixture');
    await expect(createRehearsal({ ...fx.runtime, home: nested }, requested).init()).rejects.toThrow('REHEARSAL_EXISTING_VAULT');
    await expect(createRehearsal(fx.runtime, requested).init()).rejects.toThrow('REHEARSAL_EXISTING_VAULT');
    expect(await readdir(nested)).toEqual([]);
    expect((await readdir(fx.home)).sort()).toEqual(['.obsidian', 'fake-login', 'untouched.md']);
    expect(await readFile(join(fx.home, 'untouched.md'), 'utf8')).toBe('external vault fixture');
  } finally { await fx.close(); }
});

test.skipIf(uid <= 0).each(['root', 'isolation', 'actor'] as const)('rejects mutated ledger identity (%s) before touching any external fixture', async (field) => {
  const fx = await fixture();
  try {
    const rehearsal = createRehearsal(fx.runtime, requested);
    const session = await rehearsal.init();
    const external = join(fx.home, 'external vault');
    await mkdir(join(external, '知识笔记'), { recursive: true });
    await mkdir(join(external, '系统视图'));
    const externalPath = join(external, '知识笔记', 'untouched.md');
    await writeFile(externalPath, 'untouched fixture\n');
    const db = new Database(session.databasePath);
    try {
      if (field === 'root') db.prepare("UPDATE vaults SET root_path = ?, physical_root = ?").run(external, external);
      if (field === 'isolation') db.prepare("UPDATE vaults SET isolation_root = ?").run(external);
      if (field === 'actor') db.prepare("UPDATE vaults SET capture_host = 'different-actor'").run();
    } finally { db.close(); }
    await expect(rehearsal.status(session.sessionId)).rejects.toThrow('REHEARSAL_LEDGER_IDENTITY_MISMATCH');
    await expect(rehearsal.watch(session.sessionId, 'editor-open', { timeoutMs: 50 })).rejects.toThrow('REHEARSAL_LEDGER_IDENTITY_MISMATCH');
    expect(await readFile(externalPath, 'utf8')).toBe('untouched fixture\n');
    expect(await readdir(join(external, '系统视图'))).toEqual([]);
    expect(await readdir(join(external, '知识笔记'))).toEqual(['untouched.md']);
  } finally { await fx.close(); }
});

test.skipIf(uid <= 0)('a direct closed-editor append without the active worker receipt does not count as a stopped sample', async () => {
  const fx = await fixture();
  try {
    const rehearsal = createRehearsal(fx.runtime, requested);
    const first = await rehearsal.init();
    await rehearsal.watch(first.sessionId, 'editor-open', {
      timeoutMs: 1000,
      onReady: async () => {
        for (const note of first.guiEdits) await appendFile(join(first.vaultPath, note.relativePath), '\n' + note.marker + '\n');
      },
    });
    fx.setRunning(false);
    const synthetic = first.guiEdits.find(({ relativePath }) => relativePath.startsWith('知识笔记/'))!;
    await expect(rehearsal.watch(first.sessionId, 'editor-closed', {
      timeoutMs: 80,
      onReady: () => appendFile(join(first.vaultPath, synthetic.relativePath), '\n' + synthetic.marker.replace('editor-open', 'editor-closed') + '\n'),
    })).rejects.toThrow('REHEARSAL_STOPPED_SAMPLE_PROOF_REQUIRED');
    expect((await rehearsal.status(first.sessionId)).evidence).toHaveLength(1);
  } finally { await fx.close(); }
});

test('signed bundle, AppKit PID and test-UID kernel executable must all agree', () => {
  const bundlePath = '/Applications/Obsidian.app';
  const executablePath = bundlePath + '/Contents/MacOS/Obsidian';
  const bundle = { path: bundlePath, signature: 'verified', architecture: 'universal' };
  const app = { bundlePath, executablePath, pid: 55 };
  const listed = [{ pid: 55, executablePath, uid: 551 }];
  expect(matchEditorProcess(bundle, [app], listed, 551)).toEqual({ running: true, bundlePath, pid: 55 });
  expect(matchEditorProcess(bundle, [], [], 551)).toEqual({ running: false, bundlePath, pid: null });
  expect(matchEditorProcess({ ...bundle, signature: 'invalid' }, [], [], 551)).toBeNull();
  expect(matchEditorProcess(bundle, [app], [{ ...listed[0], pid: 56 }], 551)).toBeNull();
  expect(matchEditorProcess(bundle, [app], [{ ...listed[0], uid: 552 }], 551)).toBeNull();
  expect(matchEditorProcess(bundle, [app], [{ ...listed[0], executablePath: '/tmp/lookalike/Obsidian' }], 551)).toBeNull();
  expect(matchEditorProcess(bundle, [{ ...app, bundlePath: '/tmp/Obsidian.app' }], listed, 551)).toBeNull();
});

test.skipIf(uid <= 0)('rejects a stopped sample bound to a different worker and leaves its source uncollected', async () => {
  const fx = await fixture();
  try {
    const rehearsal = createRehearsal(fx.runtime, requested);
    const first = await rehearsal.init();
    const open = await rehearsal.watch(first.sessionId, 'editor-open', {
      timeoutMs: 1000,
      onReady: async () => {
        for (const note of first.guiEdits) await appendFile(join(first.vaultPath, note.relativePath), '\n' + note.marker + '\n');
      },
    });
    fx.setRunning(false);
    await expect(rehearsal.watch(first.sessionId, 'editor-closed', {
      timeoutMs: 1000,
      onReady: async () => {
        const saved = await rehearsal.saveClosedSample(first.sessionId, 'editor-closed');
        await writeFile(join(first.sessionPath, 'stopped-editor-closed.json'), JSON.stringify({ ...saved, workerId: 'different-worker' }));
      },
    })).rejects.toThrow('REHEARSAL_STOPPED_SAMPLE_PROOF_MISMATCH');
    const db = new Database(first.databasePath, { readonly: true, fileMustExist: true });
    try {
      const prior = open.source.find((entry) => entry.relativePath.startsWith('知识笔记/'))!;
      expect(db.prepare('SELECT observed_seq FROM vault_documents WHERE document_id = ?').get(prior.documentId))
        .toEqual({ observed_seq: prior.observedSeq });
      expect(db.prepare('SELECT projection_revision FROM projection_pointers').get()).toEqual({ projection_revision: 1 });
    } finally { db.close(); }
  } finally { await fx.close(); }
});
