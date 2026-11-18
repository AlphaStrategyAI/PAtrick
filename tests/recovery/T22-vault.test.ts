import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { createBlobStore, createRecoveryRuntimeGate, openDatabase } from '@patrick/storage';
import { confirmVault, inspectVault } from '../../packages/integrations/vault/connection.js';
import { createVaultApi, type VaultPrincipal } from '../../packages/integrations/vault/drafts.js';
import { readVault, readVaultEdit } from '../../packages/integrations/vault/reader.js';
import { createStandardsApi, type StandardRule } from '../../packages/domain/src/standards.js';
import { projectVault, PROJECTION_BATCH_FILES } from '../../packages/integrations/vault/projector.js';

const io = vi.hoisted(() => ({ before: (_operation: string, _path: string) => {}, after: (_operation: string, _path: string) => {} }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  const wrap = (operation: 'lstat' | 'readFile' | 'readdir' | 'realpath' | 'open') => async (...args: unknown[]) => {
    io.before(operation, String(args[0]));
    const result = await (actual[operation] as (...values: unknown[]) => Promise<unknown>)(...args);
    io.after(operation, String(args[0]));
    return result;
  };
  return { ...actual, lstat: wrap('lstat'), readFile: wrap('readFile'), readdir: wrap('readdir'), realpath: wrap('realpath'), open: wrap('open') };
});
const at = '2026-11-17T06:00:00.000Z';
const principal: VaultPrincipal = { account_id: 'owner', caller_id: 'web', auth_epoch: 1, authenticated_at: at,
  domains: ['personal', 'enterprise'], operations: ['owner', 'edits.write'] };
const request = { operation: 'create_standard' as const, draft_key: 'new', expected_active_version: null };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t22-vault-'));
  const vault = join(root, 'vault');
  mkdirSync(join(vault, '知识笔记'), { recursive: true });
  writeFileSync(join(vault, '知识笔记/note.md'), '---\nknowledge_id: k-note\n---\nA');
  const db = openDatabase(join(root, 'local.sqlite'));
  const blobs = createBlobStore(join(root, 'blobs'));
  const put = vi.spyOn(blobs, 'putBlob');
  const api = createVaultApi(db, { blobs, captureHost: 'fixture', now: () => new Date(at) });
  const connect = async (domain = 'personal') => api.connectVault({ accountId: 'owner', deviceId: 'fixture',
    vaultId: 'vault', root: vault, domain });
  const ready = async (domain = 'personal') => { await connect(domain); await api.confirmVault('fixture', 'vault'); };
  const counts = () => Object.fromEntries(['vaults', 'vault_clients', 'authority_facts', 'blobs', 'vault_documents',
    'vault_revisions', 'knowledge_records', 'edit_intents', 'edit_receipts', 'projection_batches', 'projection_pointers',
    'projection_locks', 'domain_events'].map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  const project = (options: Partial<Parameters<typeof projectVault>[2]> = {}, revision = 1) => projectVault(db,
    { vaultId: 'vault', viewKind: 'knowledge', revision, files: Object.fromEntries(PROJECTION_BATCH_FILES.map((path) => [path, 'view'])) },
    { now: at, ...options });
  return { root, vault, db, blobs, put, api, connect, ready, counts, project,
    close() { io.before = () => {}; io.after = () => {}; db.close(); rmSync(root, { recursive: true, force: true }); } };
}
function admit(f: ReturnType<typeof fixture>, domain = 'personal') {
  f.db.prepare(`INSERT INTO recovery_domain_gates(data_domain,writer_epoch,status,activation_id,witness_revision,updated_at)
    VALUES (?,'epoch-1','open','activation-1','witness-1',?)`).run(domain, at);
  const gate = createRecoveryRuntimeGate(f.db);
  gate.admit({ domain, writerEpoch: 'epoch-1', activationId: 'activation-1', witnessRevision: 'witness-1' });
  return gate;
}
function unpublished(f: ReturnType<typeof fixture>) {
  expect(existsSync(join(f.vault, '系统视图/批次/1'))).toBe(false);
  expect(existsSync(join(f.vault, '系统视图/索引.md'))).toBe(false);
  expect(f.db.prepare('SELECT * FROM projection_pointers').all()).toEqual([]);
  expect(f.db.prepare('SELECT * FROM projection_locks').all()).toEqual([]);
}

test('closed direct connection creates no root or authority records', async () => {
  const f = fixture();
  try { createRecoveryRuntimeGate(f.db); const before = f.counts();
    await expect(f.connect()).rejects.toThrow('RECOVERY_WRITE_BLOCKED'); expect(f.counts()).toEqual(before);
  } finally { f.close(); }
});
test.each(['closed', 'callback'] as const)('confirmation checks live recovery after its %s boundary', async (kind) => {
  const f = fixture();
  try { await f.connect(); const gate = admit(f); if (kind === 'closed') gate.revoke('personal'); const before = f.counts();
    await expect(confirmVault(f.db, 'fixture', 'vault', at, kind === 'closed' ? undefined : { beforeWrite() { gate.revoke('personal'); return at; } }))
      .rejects.toThrow('RECOVERY_WRITE_BLOCKED'); expect(f.counts()).toEqual(before);
  } finally { f.close(); }
});
test.each(['read', 'edit'] as const)('closed direct %s ingestion puts no blobs or SQL facts', async (kind) => {
  const f = fixture();
  try { await f.ready(); createRecoveryRuntimeGate(f.db); const before = f.counts();
    const run = kind === 'read' ? readVault(f.db, f.blobs, 'vault', at)
      : readVaultEdit(f.db, f.blobs, 'vault', '知识笔记/note.md', at, () => {});
    await expect(run).rejects.toThrow('RECOVERY_WRITE_BLOCKED'); expect(f.put).not.toHaveBeenCalled(); expect(f.counts()).toEqual(before);
    await expect(inspectVault(f.db, 'fixture', 'vault')).resolves.toMatchObject({ status: 'connected' });
  } finally { f.close(); }
});
test('read edit authorization can revoke admission before any blob handoff', async () => {
  const f = fixture();
  try { await f.ready(); const gate = admit(f); const before = f.counts();
    await expect(readVaultEdit(f.db, f.blobs, 'vault', '知识笔记/note.md', at, () => gate.revoke('personal')))
      .rejects.toThrow('RECOVERY_WRITE_BLOCKED'); expect(f.put).not.toHaveBeenCalled(); expect(f.counts()).toEqual(before);
  } finally { f.close(); }
});
test('scan closure prevents the first blob handoff', async () => {
  const f = fixture();
  try { await f.ready(); const gate = admit(f); const before = f.counts();
    io.after = (operation) => { if (operation === 'readdir') gate.revoke('personal'); };
    await expect(readVault(f.db, f.blobs, 'vault', at)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(f.put).not.toHaveBeenCalled(); expect(f.counts()).toEqual(before);
  } finally { f.close(); }
});

test('growth observed at the final attachment path check aborts the whole Vault sweep', async () => {
  const f = fixture();
  try {
    await f.ready();
    const directory = join(f.vault, '附件');
    mkdirSync(directory);
    const attachment = join(directory, 'sample.pdf');
    writeFileSync(attachment, Buffer.alloc(20_000_000, 0x61));
    const physicalAttachment = realpathSync(attachment);
    let grown = false;
    io.before = (operation, path) => {
      if (!grown && operation === 'lstat' && path === physicalAttachment) {
        appendFileSync(attachment, 'x');
        grown = true;
      }
    };
    const before = f.counts();
    await expect(f.api.readVault('vault')).rejects.toThrow('VAULT_ATTACHMENT_TOO_LARGE');
    expect(grown).toBe(true);
    expect(f.put).not.toHaveBeenCalled();
    expect(f.counts()).toEqual(before);
  } finally { f.close(); }
});

test.each(['read', 'edit'] as const)('closure after %s blob staging prevents business commit and later blob handoffs', async (kind) => {
  const f = fixture();
  try { await f.ready(); writeFileSync(join(f.vault, '知识笔记/other.md'), 'B'); const gate = admit(f); const before = f.counts();
    const put = createBlobStore(join(f.root, 'blobs')).putBlob; f.put.mockImplementationOnce(async (bytes) => { const hash = await put(bytes); gate.revoke('personal'); return hash; });
    const run = kind === 'read' ? readVault(f.db, f.blobs, 'vault', at)
      : readVaultEdit(f.db, f.blobs, 'vault', '知识笔记/note.md', at, () => {});
    await expect(run).rejects.toThrow('RECOVERY_WRITE_BLOCKED'); expect(f.put).toHaveBeenCalledTimes(1); expect(f.counts()).toEqual(before);
  } finally { f.close(); }
});
test('closed createEdit produces no manuscript or intent', async () => {
  const f = fixture();
  try { await f.ready(); createRecoveryRuntimeGate(f.db); const before = f.counts();
    await expect(f.api.createEdit(principal, request)).rejects.toThrow('RECOVERY_WRITE_BLOCKED'); expect(f.counts()).toEqual(before);
    expect(existsSync(join(f.vault, '标准修订/new.md'))).toBe(false);
  } finally { f.close(); }
});
test('draft final create-only boundary checks admission after awaited preparation', async () => {
  const f = fixture();
  try { await f.ready(); const gate = admit(f); let triggered = false;
    io.after = (operation, path) => { if (operation === 'readFile' && path.includes('.patrick-staging')) { triggered = true; gate.revoke('personal'); } };
    await expect(f.api.createEdit(principal, request)).rejects.toThrow('RECOVERY_WRITE_BLOCKED'); expect(triggered).toBe(true);
    expect(existsSync(join(f.vault, '标准修订/new.md'))).toBe(false);
    expect(f.db.prepare('SELECT file_state FROM edit_receipts').all()).toEqual([{ file_state: 'preparing' }]);
  } finally { f.close(); }
});
test('completed exact edit replay remains a read while closed', async () => {
  const f = fixture();
  try { await f.ready(); const gate = admit(f); const receipt = await f.api.createEdit(principal, request); const before = f.counts();
    gate.revoke('personal'); await expect(f.api.createEdit(principal, request)).resolves.toEqual(receipt); expect(f.counts()).toEqual(before);
  } finally { f.close(); }
});
test('direct projector without optional authorization denies before lock and publication', async () => {
  const f = fixture();
  try { await f.ready(); createRecoveryRuntimeGate(f.db); const before = f.counts();
    await expect(f.project()).rejects.toThrow('RECOVERY_WRITE_BLOCKED'); expect(f.counts()).toEqual(before); unpublished(f);
  } finally { f.close(); }
});
test.each(['lock', 'filesystem', 'index'] as const)('projection %s closure prevents new publication', async (boundary) => {
  const f = fixture();
  try { await f.ready(); const gate = admit(f); let triggered = false;
    io.after = (operation, path) => {
      if ((boundary === 'filesystem' && operation === 'realpath' && path.endsWith('/系统视图')) ||
          (boundary === 'index' && operation === 'lstat' && path.endsWith('/系统视图') && existsSync(join(f.vault, '系统视图/批次/1')))) {
        triggered = true; gate.revoke('personal');
      }
    };
    await expect(f.project({ onProjectionLock() { if (boundary === 'lock') { triggered = true; gate.revoke('personal'); } } }))
      .rejects.toThrow('RECOVERY_WRITE_BLOCKED'); expect(triggered).toBe(true);
    if (boundary !== 'index') expect(existsSync(join(f.vault, '系统视图/批次/1'))).toBe(false);
    expect(existsSync(join(f.vault, '系统视图/索引.md'))).toBe(false);
    expect(f.db.prepare('SELECT * FROM projection_pointers').all()).toEqual([]);
    expect(f.db.prepare('SELECT * FROM projection_locks').all()).toEqual([]);
  } finally { f.close(); }
});
test('an optional projector callback cannot revoke admission and authorize publication', async () => {
  const f = fixture();
  try { await f.ready(); const gate = admit(f);
    await expect(f.project({ authorize: () => gate.revoke('personal') })).rejects.toThrow('RECOVERY_WRITE_BLOCKED'); unpublished(f);
  } finally { f.close(); }
});
test.each(['domain', 'epoch', 'peer'] as const)('persisted Vault %s controls live admission', async (kind) => {
  const f = fixture(); let peer: ReturnType<typeof openDatabase> | undefined;
  try { await f.ready(kind === 'domain' ? 'enterprise' : 'personal'); admit(f);
    if (kind === 'epoch') f.db.prepare("UPDATE recovery_domain_gates SET writer_epoch='epoch-2'").run();
    if (kind === 'peer') { f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); cpSync(join(f.root, 'local.sqlite'), join(f.root, 'copy.sqlite')); peer = openDatabase(join(f.root, 'copy.sqlite')); }
    const before = f.counts(); await expect(readVault(peer ?? f.db, f.blobs, 'vault', at)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(f.put).not.toHaveBeenCalled(); expect(f.counts()).toEqual(before);
  } finally { peer?.close(); f.close(); }
});
test('admitted ingestion and projection work, and closed owner withdrawal records pending protection', async () => {
  const f = fixture();
  try { const gate = admit(f); await f.ready();
    await expect(readVault(f.db, f.blobs, 'vault', at)).resolves.toMatchObject({ collected: 1 });
    await expect(f.project()).resolves.toEqual({ applied: true, pointer: 1, state: 'current' });
    const index = readFileSync(join(f.vault, '系统视图/索引.md'), 'utf8'); gate.revoke('personal');
    const evidence = f.db.prepare('SELECT evidence_id FROM evidence_refs LIMIT 1').get() as { evidence_id: string };
    await expect(f.api.withdrawEvidence({ domain: 'personal', evidenceId: evidence.evidence_id, reason: 'owner withdrew' })).resolves.toBeDefined();
    expect(f.db.prepare('SELECT * FROM recovery_withdrawal_pending').all()).toHaveLength(1);
    await expect(f.project({}, 2)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(readFileSync(join(f.vault, '系统视图/索引.md'), 'utf8')).toBe(index);
    expect(existsSync(join(f.vault, '系统视图/批次/2'))).toBe(false);
  } finally { f.close(); }
});

test.each(['read', 'edit', 'project'] as const)('a final %s callback cannot switch to another admitted persisted Vault domain', async (kind) => {
  const f = fixture();
  try {
    await f.ready(); admit(f); admit(f, 'enterprise');
    const before = f.counts();
    const mutate = () => { f.db.prepare("UPDATE vaults SET data_domain='enterprise' WHERE vault_id='vault'").run(); };
    if (kind === 'read') {
      io.after = (operation) => { if (operation === 'readdir') mutate(); };
    }
    const run = kind === 'read' ? readVault(f.db, f.blobs, 'vault', at) : kind === 'edit'
      ? readVaultEdit(f.db, f.blobs, 'vault', '知识笔记/note.md', at, mutate) : f.project({ authorize: mutate });
    await expect(run).rejects.toThrow('CONFLICT');
    expect(f.put).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT * FROM vault_documents').all()).toEqual(before.vault_documents);
    expect(f.db.prepare('SELECT * FROM projection_pointers').all()).toEqual([]);
  } finally { f.close(); }
});

test('closure after index publication leaves the pending proof without a new business pointer', async () => {
  const f = fixture();
  try {
    await f.ready(); const gate = admit(f); let triggered = false;
    io.after = (operation, path) => {
      if (operation === 'lstat' && path.endsWith('/系统视图/索引.md') && existsSync(path)) {
        triggered = true; gate.revoke('personal');
      }
    };
    await expect(f.project()).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(triggered).toBe(true);
    expect(existsSync(join(f.vault, '系统视图/索引.md'))).toBe(true);
    expect(f.db.prepare('SELECT * FROM projection_pointers').all()).toEqual([]);
    expect(f.db.prepare('SELECT applied,cleanup_state FROM projection_batches').all()).toEqual([{ applied: 0, cleanup_state: 'pending' }]);
    expect(f.db.prepare('SELECT * FROM projection_locks').all()).toEqual([]);
  } finally { f.close(); }
});

test('closed unfinished draft retry cannot publish or advance the preparing receipt', async () => {
  const f = fixture();
  try {
    await f.ready(); const gate = admit(f);
    const crashing = createVaultApi(f.db, { blobs: f.blobs, now: () => new Date(at), beforeDraftWrite() { throw new Error('CRASH'); } });
    await expect(crashing.createEdit(principal, request)).rejects.toThrow('CRASH');
    const before = f.counts(); gate.revoke('personal');
    await expect(f.api.createEdit(principal, request)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(f.counts()).toEqual(before);
    expect(existsSync(join(f.vault, '标准修订/new.md'))).toBe(false);
  } finally { f.close(); }
});

test('closed checkEdit denies materialization even with a permissive caller callback', async () => {
  const f = fixture();
  try {
    await f.ready(); const gate = admit(f); const edit = await f.api.createEdit(principal, request);
    writeFileSync(join(f.vault, '标准修订/new.md'), '# new content');
    const before = f.counts(); gate.revoke('personal');
    await expect(f.api.checkEdit(edit.edit_id, edit.receipt_revision, () => {})).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(f.put).not.toHaveBeenCalled(); expect(f.counts()).toEqual(before);
  } finally { f.close(); }
});

async function adoption(f: ReturnType<typeof fixture>) {
  await f.ready();
  const edit = await f.api.createEdit(principal, request);
  const intent = f.db.prepare('SELECT target_id FROM edit_intents WHERE edit_id=?').get(edit.edit_id) as { target_id: string };
  const standards = createStandardsApi(f.db, { ...principal, operations: ['owner', 'standards.write'] }, {
    domain: 'personal', now: () => new Date(at),
  });
  await standards.seedProductDataset();
  const rules = JSON.parse(readFileSync(new URL('../../fixtures/evaluation/product/manifest.json', import.meta.url), 'utf8')) as {
    candidate_rules: StandardRule[];
  };
  const candidate = await standards.openCandidate(await standards.ingestStandardDraft({ vaultId: 'vault',
    standardId: intent.target_id, draftKey: request.draft_key, rules: rules.candidate_rules }));
  const report = await standards.evaluate(candidate, { version: 1 });
  expect(await standards.adoptStandard(candidate.id, report.id, candidate.revision)).toBe('adopted');
  const batch = f.db.prepare("SELECT intent_id,projection_revision FROM projection_batches WHERE view_kind='standards'").get() as {
    intent_id: string; projection_revision: number;
  };
  const projection = { vaultId: 'vault', viewKind: 'standards', revision: batch.projection_revision, editId: edit.edit_id,
    files: Object.fromEntries(PROJECTION_BATCH_FILES.map((path) => [path, 'committed view'])) };
  return { edit, candidate, report, batch, projection };
}

test.each(['project', 'pending'] as const)('closed adoption %s cannot freeze a render, stage blobs or advance receipts', async (kind) => {
  const f = fixture();
  try {
    const a = await adoption(f); createRecoveryRuntimeGate(f.db); const before = f.counts(); f.put.mockClear();
    const run = kind === 'project' ? f.api.project(a.projection)
      : f.api.projectPendingStandardAdoption(a.candidate.id, a.report.id, () => {});
    await expect(run).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(f.put).not.toHaveBeenCalled(); expect(f.counts()).toEqual(before); unpublished(f);
  } finally { f.close(); }
});

test('closed adopted retry denies a new attempt and permits the exact completed receipt replay', async () => {
  const f = fixture();
  try {
    const a = await adoption(f); const gate = admit(f);
    const failing = createVaultApi(f.db, { blobs: f.blobs, now: () => new Date(at), failProjection: () => true });
    await expect(failing.project(a.projection)).resolves.toMatchObject({ state: 'failed' });
    const failed = f.db.prepare('SELECT MAX(receipt_revision) AS revision FROM edit_receipts WHERE edit_id=?')
      .get(a.edit.edit_id) as { revision: number };
    const expected = { receiptRevision: failed.revision, intentId: a.batch.intent_id, projectionRevision: a.batch.projection_revision };
    gate.revoke('personal'); const before = f.counts(); f.put.mockClear();
    await expect(f.api.retryAdoptedProjection(a.edit.edit_id, expected, () => {})).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(f.put).not.toHaveBeenCalled(); expect(f.counts()).toEqual(before);
    gate.admit({ domain: 'personal', writerEpoch: 'epoch-1', activationId: 'activation-1', witnessRevision: 'witness-1' });
    const completed = await f.api.retryAdoptedProjection(a.edit.edit_id, expected, () => {});
    expect(completed.projection.state).toBe('current');
    gate.revoke('personal'); const final = f.counts(); f.put.mockClear();
    await expect(f.api.retryAdoptedProjection(a.edit.edit_id, expected, () => {})).resolves.toEqual(completed);
    expect(f.put).not.toHaveBeenCalled(); expect(f.counts()).toEqual(final);
    await expect(f.api.retryAdoptedProjection(a.edit.edit_id, { ...expected, receiptRevision: expected.receiptRevision - 1 }, () => {}))
      .rejects.toThrow('RECOVERY_WRITE_BLOCKED');
  } finally { f.close(); }
});

test('create-only final link checks live admission after the destination temporary file is opened', async () => {
  const f = fixture();
  try {
    await f.ready(); const gate = admit(f); let triggered = false;
    io.after = (operation, path) => {
      if (operation === 'open' && path.endsWith('.tmp')) { triggered = true; gate.revoke('personal'); }
    };
    await expect(f.api.createEdit(principal, request)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(triggered).toBe(true);
    expect(existsSync(join(f.vault, '标准修订/new.md'))).toBe(false);
    expect(f.db.prepare('SELECT file_state FROM edit_receipts').all()).toEqual([{ file_state: 'preparing' }]);
  } finally { f.close(); }
});

test('replacement index rename rechecks admission after the awaited comparison', async () => {
  const f = fixture();
  try {
    await f.ready(); const gate = admit(f); await f.project();
    const destination = join(f.vault, '系统视图/索引.md');
    const previous = readFileSync(destination, 'utf8'); let triggered = false;
    io.after = (operation, path) => {
      if (operation === 'lstat' && path.endsWith('/系统视图/索引.md') && existsSync(join(f.vault, '系统视图/批次/2'))) {
        triggered = true; gate.revoke('personal');
      }
    };
    await expect(f.project({}, 2)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    expect(triggered).toBe(true); expect(readFileSync(destination, 'utf8')).toBe(previous);
    expect(f.db.prepare('SELECT projection_revision FROM projection_pointers').all()).toEqual([{ projection_revision: 1 }]);
    expect(f.db.prepare('SELECT * FROM projection_locks').all()).toEqual([]);
  } finally { f.close(); }
});

test('retryProjection cannot carry an old pointer across an admitted Vault rebinding in its clock callback', async () => {
  const f = fixture();
  try {
    await f.ready(); admit(f); admit(f, 'enterprise');
    const edit = await f.api.createEdit(principal, request); await f.project();
    const before = f.counts();
    const clocked = createVaultApi(f.db, { blobs: f.blobs, now() {
      f.db.prepare("UPDATE vaults SET data_domain='enterprise' WHERE vault_id='vault'").run();
      f.db.prepare("UPDATE edit_intents SET data_domain='enterprise' WHERE edit_id=?").run(edit.edit_id);
      return new Date(at);
    } });
    await expect(async () => clocked.retryProjection(edit.edit_id, 0)).rejects.toThrow('CONFLICT');
    expect(f.counts().edit_receipts).toEqual(before.edit_receipts);
    expect(f.counts().domain_events).toEqual(before.domain_events);
  } finally { f.close(); }
});
