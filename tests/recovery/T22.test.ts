import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '@patrick/storage';

const stamp = '2026-11-17T06:00:00.000Z';
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const emptyHash = hash('');
const versionLocks = { application: 'fixture-v1', executor: 'fixture-executor-v1' };
const keys = generateKeyPairSync('ed25519');
const authority = {
  keyId: 'fixture-recovery-signing-key',
  sign: async (bytes: Uint8Array) => sign(null, bytes, keys.privateKey).toString('base64'),
  verify: async (bytes: Uint8Array, signature: string, keyId: string) =>
    keyId === 'fixture-recovery-signing-key' && verify(null, bytes, keys.publicKey, Buffer.from(signature, 'base64')),
};
function canonicalFixture(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalFixture).join(',')}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalFixture(entry)}`).join(',')}}`;
}
const initialWithdrawal = {
  domain: 'personal', seq: 1, writerEpoch: 'epoch-before', previousHash: emptyHash,
  event: { eventId: 'withdrawn', targetKind: 'knowledge', targetId: 'old-knowledge', targetVersion: 1, epoch: 4, reason: 'owner withdrew', createdAt: stamp },
};
const initialEntry = { ...initialWithdrawal, hash: hash(canonicalFixture(initialWithdrawal)) };
const initialHead = { seq: 1, hash: initialEntry.hash };

async function feature<T>(name: string): Promise<T> {
  const module = await import(`../../packages/host/src/recovery/${name}.ts`).catch(() => undefined);
  expect(module, `T22 ${name} recovery module must exist`).toBeDefined();
  return module as T;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-T22-'));
  const service = openDatabase(join(root, 'service.sqlite'));
  const hub = openDatabase(join(root, 'hub.sqlite'));
  for (const db of [service, hub]) {
    const migration = join(process.cwd(), 'packages/storage/migrations/0023_recovery.sql');
    if (existsSync(migration)) db.exec(readFileSync(migration, 'utf8'));
    db.prepare("INSERT INTO hub_snapshots VALUES ('hub', 9, '{}', ?)").run(stamp);
  }
  service.prepare("INSERT INTO accounts VALUES ('owner', 1, 1, ?)").run(stamp);
  service.prepare(`INSERT INTO sessions VALUES (?, 'owner', 'web', 1, '2027-01-01', ?, 'old-credential')`).run(hash('old-session'), stamp);
  service.prepare(`INSERT INTO consultations (request_id, account_id, caller_id, data_domain, parent_work_id,
    result_version, status, domains_json, tools_json, deadline_at, budget_micros, permission_revision,
    cancelled_at, schema_version, created_at, updated_at) VALUES (
    'unfinished', 'owner', 'web', 'personal', NULL, 0, 'pending', '["personal"]', '[]',
    '2026-11-18', 1000, 1, NULL, '1.0', ?, ?)`).run(stamp, stamp);
  service.prepare(`INSERT INTO withdrawal_events VALUES ('withdrawn', 'personal', 'knowledge', 'old-knowledge', 1, 4, 'owner withdrew', ?)`).run(stamp);
  if (existsSync(join(process.cwd(), 'packages/storage/migrations/0023_recovery.sql'))) {
    service.prepare('INSERT INTO recovery_withdrawal_log VALUES (?,?,?,?,?,?,?)').run(
      'personal', 1, 'epoch-before', emptyHash, initialEntry.hash, JSON.stringify(initialEntry.event), 'protected',
    );
    service.prepare('DELETE FROM recovery_withdrawal_pending').run();
    service.prepare("UPDATE recovery_domain_gates SET writer_epoch='epoch-before',status='blocked'").run();
  }
  service.prepare(`INSERT INTO channel_connections VALUES (
    'feishu', 'owner', 'personal', 'app', 'tenant', 'credential-ref', 1, 1, 4, 2, 3,
    'old-pairing', 'old-test', 'old-owner', 'old-chat', 'ready', 'active', NULL, NULL, '1.0', ?, ?)`).run(stamp, stamp);
  service.prepare(`INSERT INTO channel_pairings VALUES (
    'old-pairing','feishu','owner','personal',?,'2027-01-01',NULL,'old-owner','old-chat',
    'app','tenant',1,1,3,4,2,'candidate','1.0',?)`).run(hash('old-pairing'), stamp);
  service.prepare(`INSERT INTO channel_tests VALUES (
    'old-test','feishu','owner','personal',?,'old-chat','verified','old-message','old-evidence',
    'app','tenant',1,1,'old-binding',4,2,NULL,'1.0',?,?)`).run(hash('old-test'), stamp, stamp);
  const vault = join(root, 'vault');
  mkdirSync(join(vault, '标准修订'), { recursive: true });
  writeFileSync(join(vault, '标准修订/较新稿.md'), '# 旧原稿');
  service.prepare(`INSERT INTO source_configs VALUES (
    'vault-source','owner','personal','directory',?,?,'{}','[]',NULL,'daily','none',0,1,'enabled',1,'1.0',?,?)`).run(vault, vault, stamp, stamp);
  service.prepare(`INSERT INTO vaults VALUES (
    'vault-fixture','vault-source','owner','personal','fixture-host',?,?,?, ?,?,1,1,'connected','1.0',?,?)`).run(
    vault, root, `${statSync(vault).dev}:${statSync(vault).ino}`, vault, hash(vault), stamp, stamp,
  );
  const frozen: string[] = [];
  const freeze = {
    async acquire() {
      frozen.push('freeze');
      return {
        cutId: 'cut-fixture', ingressFrozen: true, claimsFrozen: true, receiptsFrozen: true,
        effectsFrozen: true, executionTreesStopped: true, uncertainCallsJournaled: true,
        durableHandoff: true, async release() { frozen.push('release'); },
      };
    },
  };
  return { root, service, hub, vault, freeze, frozen,
    scope: { setId: 'set-old', domains: [{ domain: 'personal', writerEpoch: 'epoch-before', withdrawal: initialHead }],
      resources: [{ kind: 'vault' as const, root: vault, domain: 'personal' }], versionLocks },
    close() { service.close(); hub.close(); rmSync(root, { recursive: true, force: true }); } };
}

type BackupModule = typeof import('../../packages/host/src/recovery/backup.js');
type RestoreModule = typeof import('../../packages/host/src/recovery/restore.js');
type WitnessModule = typeof import('../../packages/host/src/recovery/witness.js');

test('native backup freezes two real WAL databases and preserves unfinished consultation and withdrawal facts', async () => {
  const fx = fixture();
  try {
    const { createRecoveryBackup, verifyRecoverySet } = await feature<BackupModule>('backup');
    const backup = createRecoveryBackup({ root: join(fx.root, 'sets'), databases: fx, freeze: fx.freeze, authority, now: () => new Date(stamp) });
    const captured = await backup.captureRecoverySet(fx.scope);
    expect(fx.frozen).toEqual(['freeze', 'release']);
    expect(captured.manifest.completeness.recoverable).toBe(true);
    expect(captured.manifest.protection.status).toBe('local_only');
    const verified = await verifyRecoverySet(captured.directory, authority, versionLocks);
    expect(verified.manifest.databases.service.hubSeq).toBe(9);
    const copy = new Database(join(captured.directory, 'databases/service.sqlite'), { readonly: true });
    try {
      expect(copy.prepare('SELECT status FROM consultations').get()).toEqual({ status: 'pending' });
      expect(copy.prepare('SELECT epoch, reason FROM withdrawal_events').get()).toEqual({ epoch: 4, reason: 'owner withdrew' });
    } finally { copy.close(); }
  } finally { fx.close(); }
});

test('mismatched database watermarks and non-quiescent writers cannot produce a recoverable set', async () => {
  const fx = fixture();
  try {
    const { createRecoveryBackup } = await feature<BackupModule>('backup');
    const backup = createRecoveryBackup({ root: join(fx.root, 'sets'), databases: fx, freeze: fx.freeze, authority });
    fx.hub.prepare('UPDATE hub_snapshots SET hub_seq=10').run();
    await expect(backup.captureRecoverySet(fx.scope)).rejects.toThrow('RECOVERY_DATABASE_CUT_MISMATCH');
    expect(existsSync(join(fx.root, 'sets/set-old/manifest.json'))).toBe(false);
    expect(fx.frozen).toEqual(['freeze', 'release']);
    const unsafe = createRecoveryBackup({ root: join(fx.root, 'unsafe'), databases: fx, authority });
    await expect(unsafe.captureRecoverySet(fx.scope)).rejects.toThrow('RECOVERY_FREEZE_REQUIRED');
  } finally { fx.close(); }
});

test('manifest hashes, signatures, schema locks and safe paths are validated before restore', async () => {
  const fx = fixture();
  try {
    const { createRecoveryBackup, verifyRecoverySet } = await feature<BackupModule>('backup');
    const captured = await createRecoveryBackup({ root: join(fx.root, 'sets'), databases: fx, freeze: fx.freeze, authority }).captureRecoverySet(fx.scope);
    await expect(verifyRecoverySet(captured.directory, authority, { ...versionLocks, application: 'other' })).rejects.toThrow('RECOVERY_VERSION_MISMATCH');
    writeFileSync(join(captured.directory, 'resources/0/标准修订/较新稿.md'), '# corrupted');
    await expect(verifyRecoverySet(captured.directory, authority, versionLocks)).rejects.toThrow('RECOVERY_ARTIFACT_HASH_MISMATCH');
    await expect(createRecoveryBackup({ root: join(fx.root, 'sets'), databases: fx, freeze: fx.freeze, authority })
      .captureRecoverySet({ ...fx.scope, setId: '../escape' })).rejects.toThrow('RECOVERY_PATH_INVALID');
  } finally { fx.close(); }
});

function witnessFixture(timing?: { interruptedAt: string; recoveryPointAt: string; manifestSha256: string }) {
  let record = {
    domain: 'personal', revision: 'sealed-1', writerEpoch: 'epoch-before', writerId: 'old-writer',
    state: 'sealed' as 'sealed' | 'open', withdrawal: { ...initialHead },
    certificate: { id: 'handoff-1', cutId: 'cut-fixture', previousWriterId: 'old-writer', fenceProof: 'fence-fixture', withdrawalsReconciled: true,
      ...(timing && { timing }) },
    activationId: null as string | null, parentSealedRevision: null as string | null,
  };
  let loseResponse = false;
  let unavailable = false;
  const port = {
    independence: 'independent_authority' as const, consistency: 'linearizable' as const, authorityId: 'fixture-only',
    async readAuthoritative() { if (unavailable) throw new Error('offline'); return structuredClone(record); },
    async compareAndSwap(_domain: string, revision: string, next: Omit<typeof record, 'revision'>) {
      if (unavailable) throw new Error('offline');
      if (record.revision !== revision) return false;
      record = { ...structuredClone(next), revision: `${revision}-next` };
      if (loseResponse) throw new Error('response lost after commit');
      return true;
    },
  };
  return { port, setLost(value: boolean) { loseResponse = value; }, setUnavailable(value: boolean) { unavailable = value; }, read: () => record };
}

test('only one recovery candidate wins exact sealed CAS and a lost response reads back its own activation', async () => {
  const { createRecoveryWitness } = await feature<WitnessModule>('witness');
  const fixture = witnessFixture();
  const witness = createRecoveryWitness({ port: fixture.port, writerId: 'new-writer', verifySealedProof: async () => true });
  fixture.setLost(true);
  const results = await Promise.all([
    witness.claimRecoveryWriter('personal', 'sealed-1', 'activation-a'),
    witness.claimRecoveryWriter('personal', 'sealed-1', 'activation-b'),
  ]);
  expect(results.sort()).toEqual(['acquired', 'lost']);
  expect(fixture.read().writerEpoch).not.toBe('epoch-before');
  expect(await witness.claimRecoveryWriter('personal', 'sealed-1', fixture.read().activationId!)).toBe('acquired');
  expect(await witness.claimRecoveryWriter('personal', 'stale-revision', 'activation-stale')).toBe('lost');
  fixture.setUnavailable(true);
  expect(await witness.claimRecoveryWriter('personal', 'sealed-1', 'activation-c')).toBe('unconfirmed');
  expect(await createRecoveryWitness({ writerId: 'new-writer' }).claimRecoveryWriter('personal', 'sealed-1', 'activation-d')).toBe('unconfirmed');
});

test('isolated drill keeps newer Vault bytes, expires old channel/session authority and never claims a writer', async () => {
  const fx = fixture();
  try {
    const { createRecoveryBackup } = await feature<BackupModule>('backup');
    const { createRecoveryRestorer } = await feature<RestoreModule>('restore');
    await createRecoveryBackup({ root: join(fx.root, 'sets'), databases: fx, freeze: fx.freeze, authority }).captureRecoverySet(fx.scope);
    writeFileSync(join(fx.vault, '标准修订/较新稿.md'), '# 较新原稿');
    const receipt = await createRecoveryRestorer({
      recoveryRoot: join(fx.root, 'sets'), isolationRoot: join(fx.root, 'drills'), authority, versionLocks,
      survivors: [{ domain: 'personal', root: fx.vault }], now: () => new Date(stamp),
    }).restoreRecoverySet('set-old');
    expect(receipt.mode).toBe('drill');
    expect(receipt.rpoMs).toBeNull();
    expect(receipt).toHaveProperty('rtoMs', null);
    expect(receipt.external_writes).toBe(0);
    expect(receipt.channels.feishu).toBe('requires_reauthorization');
    expect(receipt.data_domains.personal.status).toBe('blocked');
    expect(readFileSync(join(receipt.directory, `vault/personal/${hash('vault-fixture')}/标准修订/较新稿.md`), 'utf8')).toBe('# 较新原稿');
    expect(readFileSync(join(fx.vault, '标准修订/较新稿.md'), 'utf8')).toBe('# 较新原稿');
    expect(receipt.conflicts).toHaveLength(1);
    const restored = new Database(join(receipt.directory, 'databases/service.sqlite'));
    try {
      const channel = restored.prepare('SELECT * FROM channel_connections').get() as Record<string, unknown>;
      expect(channel).toMatchObject({ status: 'requires_reauthorization', transport_mode: 'disabled', current_pairing_id: null, current_test_id: null, owner_open_id: null, chat_id: null });
      expect(channel.channel_incarnation).toEqual(expect.any(Number));
      expect(Number.isSafeInteger(channel.channel_incarnation)).toBe(true);
      expect(channel.channel_incarnation).not.toBe(4);
      expect(channel.channel_incarnation).not.toBe(5);
      expect(restored.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
      expect(restored.prepare('SELECT status FROM channel_pairings').get()).toEqual({ status: 'expired' });
      expect(restored.prepare('SELECT status FROM channel_tests').get()).toEqual({ status: 'expired' });
      expect(restored.prepare('SELECT status,root_path,physical_root FROM vaults').get()).toEqual({
        status: 'not_connected', root_path: join(receipt.directory, `vault/personal/${hash('vault-fixture')}`), physical_root: join(receipt.directory, `vault/personal/${hash('vault-fixture')}`),
      });
      expect(restored.prepare('SELECT enabled,status,credential_ref FROM source_configs').get()).toEqual({
        enabled: 0, status: 'paused', credential_ref: null,
      });
      const audit = restored.prepare("SELECT row_json FROM recovery_quarantined_records WHERE table_name='channel_tests' AND record_id='old-test'").get() as { row_json: string };
      expect(JSON.parse(audit.row_json)).toMatchObject({ status: 'verified', incarnation: 4, inbound_evidence: 'old-evidence' });
      const { createFeishuChannel } = await import('../../packages/integrations/feishu/connection.js');
      const channelGate = createFeishuChannel(restored, {
        domain: 'personal', connectionId: 'feishu', now: () => new Date(stamp),
        hub: {
          async accept() { throw new Error('external writes forbidden in recovery'); },
          async read() { return null; },
        },
        encode: (answer) => answer.kind === 'choice' ? { choice: answer.index } : { text: answer.raw_text },
      });
      expect(await channelGate.receive({ inbound_id: 'old-callback', epoch: 2, question_id: 'old-question' })).toEqual({ disposition: 'audit_only' });
      await expect(channelGate.recordTestCallback({ test_id: 'old-test', message_id: 'old-message', inbound_evidence: 'old-evidence' })).rejects.toThrow('BINDING_STALE');
    } finally { restored.close(); }
    expect(fx.service.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
  } finally { fx.close(); }
});

test('activation stays blocked for missing withdrawal tail, absent fence or unresolved effects', async () => {
  const fx = fixture();
  try {
    const { createRecoveryBackup } = await feature<BackupModule>('backup');
    const { createRecoveryRestorer } = await feature<RestoreModule>('restore');
    const { createRecoveryWitness } = await feature<WitnessModule>('witness');
    await createRecoveryBackup({ root: join(fx.root, 'sets'), databases: fx, freeze: fx.freeze, authority }).captureRecoverySet(fx.scope);
    const witness = witnessFixture();
    witness.read().withdrawal.seq = 2;
    witness.read().withdrawal.hash = hash('missing-tail');
    const manager = createRecoveryWitness({ port: witness.port, writerId: 'candidate', verifySealedProof: async () => true });
    const receipt = await createRecoveryRestorer({
      recoveryRoot: join(fx.root, 'sets'), isolationRoot: join(fx.root, 'drills'), authority, versionLocks, witness: manager,
      withdrawalLog: { independence: 'independent_authority', async readComplete() { return []; } },
    }).restoreRecoverySet('set-old', 'activate');
    expect(receipt.external_writes).toBe(0);
    expect(receipt.data_domains.personal.status).toBe('blocked');
    expect(receipt.data_domains.personal.reasons).toEqual(expect.arrayContaining(['withdrawals_incomplete', 'previous_writer_not_fenced', 'reconciliation_incomplete']));
    expect(witness.read().state).toBe('sealed');
  } finally { fx.close(); }
});

test('capture refuses to call an unchained historical withdrawal ledger complete', async () => {
  const fx = fixture();
  try {
    const { createRecoveryBackup } = await feature<BackupModule>('backup');
    const set = await createRecoveryBackup({ root: join(fx.root, 'sets'), databases: fx, freeze: fx.freeze, authority })
      .captureRecoverySet({ ...fx.scope, domains: [{ ...fx.scope.domains[0], withdrawal: { seq: 0, hash: emptyHash } }] });
    expect(set.manifest.completeness.recoverable).toBe(false);
    expect(set.manifest.completeness.gaps).toContain('withdrawal_chain_incomplete:personal');
  } finally { fx.close(); }
});

test.each(['verified timing', 'different manifest', 'missing observation', 'inconsistent times'] as const)(
  'verified native restore opens only after full recovery gates and validates handoff timing (%s)', async (timingCase) => {
  const fx = fixture();
  try {
    const { createRecoveryBackup } = await feature<BackupModule>('backup');
    const { createRecoveryRestorer } = await feature<RestoreModule>('restore');
    const { createRecoveryWitness } = await feature<WitnessModule>('witness');
    const recoveryPointAt = '2026-11-17T06:00:00.000Z';
    const interruptedAt = '2026-11-17T07:00:00.000Z';
    const set = await createRecoveryBackup({
      root: join(fx.root, 'sets'), databases: fx, freeze: fx.freeze, authority, now: () => new Date(recoveryPointAt),
    }).captureRecoverySet(fx.scope);
    const witness = witnessFixture(timingCase === 'missing observation' ? undefined : {
      interruptedAt,
      recoveryPointAt: timingCase === 'inconsistent times' ? '2026-11-17T07:08:00.000Z' : recoveryPointAt,
      manifestSha256: timingCase === 'different manifest' ? emptyHash : set.manifestHash,
    });
    let wallClock = new Date('2026-11-17T07:05:00.000Z');
    let monotonicTime = 1000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => monotonicTime);
    const observed: string[] = [];
    const receipt = await createRecoveryRestorer({
      recoveryRoot: join(fx.root, 'sets'), isolationRoot: join(fx.root, 'drills'), versionLocks,
      authority: {
        ...authority,
        async verify(bytes, signature, keyId) {
          wallClock = new Date('2026-11-17T07:06:00.000Z');
          monotonicTime += 60 * 1000;
          return authority.verify(bytes, signature, keyId);
        },
      },
      now: () => wallClock,
      witness: createRecoveryWitness({ port: witness.port, writerId: 'candidate', verifySealedProof: async () => true }),
      fence: { async verify() { return { stopped: true, credentialsRevoked: true, proof: 'fence-fixture' }; } },
      withdrawalLog: { independence: 'independent_authority', async readComplete() { return [initialEntry]; } },
      replay: {
        externalAccess: 'read_only',
        async reconcileHub(context) { expect(context.externalAccess).toBe('read_only'); observed.push('hub'); return { confirmed: true }; },
        async recoverPendingIngest() { observed.push('ingest'); return { confirmed: true }; },
        async reconcileConsultation(id) { observed.push(id); return { confirmed: true }; },
        async rebuildProjections() { observed.push('rebuild'); return { confirmed: true }; },
      },
      activation: { async enableDomain(input) {
        expect(input.writerEpoch).toBe(witness.read().writerEpoch);
        expect(witness.read().activationId).toBe(input.activationId);
        observed.push('install-epoch');
        wallClock = new Date('2026-11-17T07:17:00.000Z');
        monotonicTime += 11 * 60 * 1000;
        return { epochInstalled: true, credentialsScoped: true, runtimeGateVerified: true };
      } },
    }).restoreRecoverySet('set-old', 'activate').finally(() => clock.mockRestore());
    expect(receipt.data_domains.personal.status).toBe('open');
    expect(receipt.orderlyHandoff).toBe(true);
    expect(receipt.startedAt).toBe('2026-11-17T07:06:00.000Z');
    expect(receipt.elapsedMs).toBe(12 * 60 * 1000);
    expect(receipt.external_writes).toBe(0);
    expect(receipt.rpoMs).toBe(timingCase === 'verified timing' ? 60 * 60 * 1000 : null);
    expect(receipt).toHaveProperty('rtoMs', timingCase === 'verified timing' ? 17 * 60 * 1000 : null);
    expect(observed).toEqual(['hub', 'ingest', 'unfinished', 'rebuild', 'install-epoch']);
    const restored = new Database(join(receipt.directory, 'databases/service.sqlite'), { readonly: true });
    try {
      const durable = restored.prepare('SELECT receipt_json FROM recovery_receipts WHERE receipt_id=?').get(receipt.receiptId) as { receipt_json: string };
      expect(JSON.parse(durable.receipt_json)).toMatchObject({ rpoMs: receipt.rpoMs, rtoMs: receipt.rtoMs });
    } finally { restored.close(); }
  } finally { fx.close(); }
});

test('unavailable or invalid sealed verifiers keep a writer unconfirmed', async () => {
  const { createRecoveryWitness } = await feature<WitnessModule>('witness');
  const fixture = witnessFixture();
  const witness = createRecoveryWitness({ writerId: 'candidate', port: fixture.port, verifySealedProof: async () => { throw new Error('certificate authority unavailable'); } });
  await expect(witness.claimRecoveryWriter('personal', 'sealed-1', 'activation')).resolves.toBe('unconfirmed');
  expect(fixture.read().state).toBe('sealed');
});

test('witness loss permits only authenticated scoped owner import, a new epoch and separate no-resend timing', async () => {
  const fx = fixture();
  try {
    const { createOwnerRecoveryImporter } = await feature<typeof import('../../packages/host/src/recovery/owner-import.js')>('owner-import');
    const witness = witnessFixture();
    const { createRecoveryWitness } = await feature<WitnessModule>('witness');
    const manager = createRecoveryWitness({ writerId: 'candidate', port: witness.port });
    witness.setUnavailable(true);
    const request = { importId: 'owner-recovery', accountId: 'owner', domain: 'personal', controlReceiptRef: 'fresh-control-proof',
      root: fx.vault, approvedPaths: ['标准修订/较新稿.md'], previousEpoch: 'epoch-before' };
    const importer = createOwnerRecoveryImporter({
      database: fx.service, isolationRoot: join(fx.root, 'imports'), witness: manager,
      control: {
        async authorizeRead(input) { return { authenticatedOwner: input.accountId === 'owner', domain: input.domain }; },
        async verify(input) { return { authenticatedOwner: input.accountId === 'owner', trustedControl: true, domain: input.domain, controlReceiptRef: input.controlReceiptRef }; },
      },
    });
    const receipt = await importer.importSurvivors(request);
    expect(receipt.mode).toBe('owner_import');
    expect(receipt.orderlyHandoff).toBe(false);
    expect(receipt.rpoMs).toBe(null);
    expect(receipt.rtoMs).toBe(null);
    expect(receipt.data_domains.personal.status).toBe('imported');
    expect(receipt.data_domains.personal.writerEpoch).not.toBe('epoch-before');
    expect(receipt.external_writes).toBe(0);
    expect(readFileSync(join(receipt.directory, 'vault/personal/标准修订/较新稿.md'), 'utf8')).toBe('# 旧原稿');
    expect(fx.service.prepare('SELECT status FROM recovery_domain_gates').get()).toEqual({ status: 'imported' });
    witness.setUnavailable(false);
    await expect(importer.importSurvivors({ ...request, importId: 'online-bypass' })).rejects.toThrow('RECOVERY_WITNESS_AVAILABLE');
    const unauthenticated = createOwnerRecoveryImporter({ database: fx.service, isolationRoot: join(fx.root, 'imports'), witness: manager });
    witness.setUnavailable(true);
    await expect(unauthenticated.importSurvivors({ ...request, importId: 'unauthenticated' })).rejects.toThrow('RECOVERY_OWNER_CONTROL_REQUIRED');
  } finally { fx.close(); }
});

test('restic protection requires admitted encrypted off-host target and complete content readback', async () => {
  const fx = fixture();
  try {
    const { createRecoveryBackup } = await feature<BackupModule>('backup');
    const { createResticRecoveryBackup } = await feature<typeof import('../../packages/host/src/recovery/restic.js')>('restic');
    const captured = await createRecoveryBackup({ root: join(fx.root, 'sets'), databases: fx, freeze: fx.freeze, authority }).captureRecoverySet(fx.scope);
    const calls: string[][] = [];
    let corrupt = false;
    const port = createResticRecoveryBackup({
      target: { targetId: 'fixture-offsite', repository: 'sftp:fixture:/backup', domains: ['personal'], authorized: true,
        offHostVerified: true, credentialRef: 'fixture-credential', recoveryCredentialRef: 'independent-recovery-material', expectedVersion: 'restic fixture' },
      credentials: { async resolve() { return { RESTIC_PASSWORD: 'fixture-only' }; } },
      runner: async (args, _environment, emit) => {
        calls.push(args);
        if (args.includes('version')) emit(Buffer.from('restic fixture\n'));
        else if (args.includes('backup')) emit(Buffer.from(JSON.stringify({ message_type: 'summary', snapshot_id: 'a'.repeat(64) }) + '\n'));
        else if (args.includes('dump')) emit(corrupt ? Buffer.from('corrupted') : readFileSync(args.at(-1)!));
      },
    });
    const protectedSet = await port.protect(captured);
    expect(protectedSet).toMatchObject({ encrypted: true, offHost: true, verified: true, targetId: 'fixture-offsite', manifestHash: captured.manifestHash });
    expect(calls.filter((args) => args.includes('dump'))).toHaveLength(captured.manifest.artifacts.length + 1);
    corrupt = true;
    await expect(port.protect(captured)).rejects.toThrow('RECOVERY_RESTIC_READBACK_MISMATCH');
  } finally { fx.close(); }
});

test('withdrawal is blocked in the same SQL commit and stays pending until independent durability and witness readback', async () => {
  const fx = fixture();
  try {
    const { createRecoveryWithdrawalJournal } = await feature<typeof import('../../packages/host/src/recovery/withdrawals.js')>('withdrawals');
    const { createRecoveryWitness } = await feature<WitnessModule>('witness');
    const fixtureWitness = witnessFixture();
    fixtureWitness.read().state = 'open';
    fixtureWitness.read().writerId = 'current-writer';
    const witness = createRecoveryWitness({ port: fixtureWitness.port, writerId: 'current-writer' });
    let unavailable = true;
    const journal = createRecoveryWithdrawalJournal({
      database: fx.service, witness,
      log: { independence: 'independent_authority', async appendAndReadBack(entry) {
        if (unavailable) throw new Error('offsite log unavailable');
        return { domain: entry.domain, seq: entry.seq, hash: entry.hash, verified: true };
      } },
    });
    fx.service.prepare(`INSERT INTO withdrawal_events VALUES ('next-withdrawal','personal','knowledge','another',1,5,'owner withdrew again',?)`).run(stamp);
    expect(fx.service.prepare('SELECT status FROM recovery_domain_gates WHERE data_domain=?').get('personal')).toEqual({ status: 'protection_pending' });
    expect(await journal.protectPending('personal', 'epoch-before')).toBe('protection_pending');
    expect(fixtureWitness.read().withdrawal).toEqual(initialHead);
    unavailable = false;
    expect(await journal.protectPending('personal', 'epoch-before')).toBe('protected');
    expect(fixtureWitness.read().withdrawal.seq).toBe(2);
    expect(fx.service.prepare('SELECT status FROM recovery_domain_gates WHERE data_domain=?').get('personal')).toEqual({ status: 'blocked' });
    expect(fx.service.prepare("SELECT protection FROM recovery_withdrawal_log WHERE sequence=2").get()).toEqual({ protection: 'protected' });
  } finally { fx.close(); }
});

test('a whole-database backup cannot label another domain as personal-only protection', async () => {
  const fx = fixture();
  try {
    const { createRecoveryBackup } = await feature<BackupModule>('backup');
    fx.service.prepare("INSERT INTO caller_scopes VALUES ('owner','web','company','owner',NULL)").run();
    await expect(createRecoveryBackup({ root: join(fx.root, 'sets'), databases: fx, freeze: fx.freeze, authority })
      .captureRecoverySet(fx.scope)).rejects.toThrow('RECOVERY_DATABASE_DOMAIN_SCOPE_MISMATCH');
    expect(existsSync(join(fx.root, 'sets/set-old/manifest.json'))).toBe(false);
  } finally { fx.close(); }
});

test('an ingest-time withdrawal invalidates earlier activation evidence and remains blocked', async () => {
  const fx = fixture();
  try {
    const { createRecoveryBackup } = await feature<BackupModule>('backup');
    const { createRecoveryRestorer } = await feature<RestoreModule>('restore');
    const { createRecoveryWitness } = await feature<WitnessModule>('witness');
    await createRecoveryBackup({ root: join(fx.root, 'sets'), databases: fx, freeze: fx.freeze, authority }).captureRecoverySet(fx.scope);
    const witness = witnessFixture();
    let activations = 0;
    const receipt = await createRecoveryRestorer({
      recoveryRoot: join(fx.root, 'sets'), isolationRoot: join(fx.root, 'drills'), authority, versionLocks,
      witness: createRecoveryWitness({ port: witness.port, writerId: 'candidate', verifySealedProof: async () => true }),
      fence: { async verify() { return { stopped: true, credentialsRevoked: true, proof: 'fence-fixture' }; } },
      withdrawalLog: { independence: 'independent_authority', async readComplete() { return [initialEntry]; } },
      replay: {
        externalAccess: 'read_only', async reconcileHub() { return { confirmed: true }; },
        async recoverPendingIngest(context) {
          context.service.prepare(`INSERT INTO withdrawal_events VALUES ('during-replay','personal','knowledge','new-withdrawal',1,5,'ingest withdrew',?)`).run(stamp);
          return { confirmed: true };
        },
        async reconcileConsultation() { return { confirmed: true }; },
        async rebuildProjections() { return { confirmed: true }; },
      },
      activation: { async enableDomain() { activations += 1; return { epochInstalled: true, credentialsScoped: true, runtimeGateVerified: true }; } },
    }).restoreRecoverySet('set-old', 'activate');
    expect(receipt.data_domains.personal.status).toBe('blocked');
    expect(receipt.data_domains.personal.reasons).toContain('withdrawal_changed_during_replay');
    expect(activations).toBe(0);
    expect(witness.read().state).toBe('sealed');
  } finally { fx.close(); }
});

test('the signed envelope enforces the manifest schema rather than accepting unknown control fields', async () => {
  const fx = fixture();
  try {
    const { createRecoveryBackup, verifyRecoverySet } = await feature<BackupModule>('backup');
    const captured = await createRecoveryBackup({ root: join(fx.root, 'sets'), databases: fx, freeze: fx.freeze, authority }).captureRecoverySet(fx.scope);
    const path = join(captured.directory, 'manifest.json');
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...envelope, bypassFence: true }));
    await expect(verifyRecoverySet(captured.directory, authority, versionLocks)).rejects.toThrow('RECOVERY_MANIFEST_INVALID');
  } finally { fx.close(); }
});

test('an unconfirmed notification effect keeps its historical handoff evidence and cannot be replayed as a send', async () => {
  const fx = fixture();
  try {
    fx.service.prepare(`INSERT INTO notification_intents (
      intent_id,account_id,data_domain,object_id,event_version,kind,channel,auth_epoch,binding_hash,expires_at,
      status,attempts,next_at,lease_until,evidence_hash,updated_at
    ) VALUES ('uncertain-effect','owner','personal','work',1,'progress','feishu',1,?,'2027-01-01','sending',1,NULL,'2027-01-01',NULL,?)`).run(hash('binding'), stamp);
    fx.service.prepare("INSERT INTO notification_attempts VALUES ('uncertain-effect',1,?,?,NULL,NULL,NULL)").run(stamp, stamp);
    const { createRecoveryBackup } = await feature<BackupModule>('backup');
    const { createRecoveryRestorer } = await feature<RestoreModule>('restore');
    await createRecoveryBackup({ root: join(fx.root, 'sets'), databases: fx, freeze: fx.freeze, authority }).captureRecoverySet(fx.scope);
    const observed: string[] = [];
    const receipt = await createRecoveryRestorer({
      recoveryRoot: join(fx.root, 'sets'), isolationRoot: join(fx.root, 'drills'), authority, versionLocks,
      replay: {
        externalAccess: 'read_only', async reconcileHub() { return { confirmed: true }; },
        async recoverPendingIngest() { return { confirmed: true }; },
        async rebuildProjections() { return { confirmed: true }; },
        async reconcileConsultation() { return { confirmed: true }; },
        async reconcileNotification(id) { observed.push(id); return { confirmed: false }; },
      },
    }).restoreRecoverySet('set-old');
    expect(receipt.external_writes).toBe(0);
    expect(receipt.data_domains.personal.status).toBe('blocked');
    expect(receipt.data_domains.personal.reasons).toContain('notification_intents_unconfirmed:uncertain-effect');
    expect(observed).toEqual(['uncertain-effect']);
    const db = new Database(join(receipt.directory, 'databases/service.sqlite'), { readonly: true });
    try {
      expect(db.prepare('SELECT status FROM notification_intents').get()).toEqual({ status: 'blocked' });
      expect(db.prepare('SELECT handed_off_at,outcome FROM notification_attempts').get()).toEqual({ handed_off_at: stamp, outcome: null });
      const audit = db.prepare("SELECT row_json FROM recovery_quarantined_records WHERE table_name='notification_intents'").get() as { row_json: string };
      expect(JSON.parse(audit.row_json)).toMatchObject({ status: 'uncertain' });
    } finally { db.close(); }
  } finally { fx.close(); }
});
