import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { verifyRecoverySet } from './backup.js';
import { assertName, canonical, containedPath, digest, durableCopy, durableJson, durableWrite, fileHash, walkFiles } from './files.js';
import { localRecoveryCut, tableInventory, type RecoveryLocalCut } from './cut.js';
import { verifyWithdrawalChain, type RecoveryHandoffCertificate, type RecoveryWitness, type RecoveryWitnessRecord } from './witness.js';
import { assertVaultRoot, bindVaultRoot, readVaultFile, restoredVaultRoot, withVaultRoot, type BoundVaultRoot } from './vaults.js';
import type { RecoveryDatabaseReader, RecoveryDatabases, RecoveryManifestAuthority, RecoveryReceipt, RecoveryRestoreReceipt, RecoveryVault, WithdrawalEntry } from './types.js';

export type RecoveryReplayContext = RecoveryDatabases & { domain: string; directory: string; externalAccess: 'read_only' };
export type RecoveryReadback = { confirmed: boolean };
export type RecoveryReplayPorts = {
  externalAccess: 'read_only';
  reconcileHub(context: RecoveryReplayContext): Promise<RecoveryReadback>;
  recoverPendingIngest(context: RecoveryReplayContext): Promise<RecoveryReadback>;
  rebuildProjections(context: RecoveryReplayContext): Promise<RecoveryReadback>;
  recoverAnswer?(intentId: string, context: RecoveryReplayContext): Promise<RecoveryReadback>;
  reconcilePr?(intentId: string, context: RecoveryReplayContext): Promise<RecoveryReadback>;
  reconcileConfiguration?(changeId: string, context: RecoveryReplayContext): Promise<RecoveryReadback>;
  reconcileConsultation?(requestId: string, context: RecoveryReplayContext): Promise<RecoveryReadback>;
  reconcileNotification?(intentId: string, context: RecoveryReplayContext): Promise<RecoveryReadback>;
};
export type RecoveryRestoreOptions = {
  recoveryRoot: string; isolationRoot: string; authority: RecoveryManifestAuthority; versionLocks: Record<string, string>;
  readDatabase?: RecoveryDatabaseReader; survivors?: Array<{ domain: string; root: string; vaultId?: string }>; witness?: RecoveryWitness;
  fence?: { verify(domain: string, record: RecoveryWitnessRecord): Promise<{ stopped: boolean; credentialsRevoked: boolean; proof: string }> };
  withdrawalLog?: { independence: 'independent_authority'; readComplete(domain: string, record: RecoveryWitnessRecord): Promise<WithdrawalEntry[]> };
  replay?: RecoveryReplayPorts;
  activation?: {
    enableDomain(input: { domain: string; writerEpoch: string; activationId: string; witnessRevision: string; directory: string }): Promise<{
      epochInstalled: boolean; credentialsScoped: boolean; runtimeGateVerified: boolean;
    }>;
    revokeDomain?(input: { domain: string; writerEpoch: string; activationId: string; witnessRevision: string; directory: string }): Promise<void>;
  };
  now?: () => Date;
};

export function canActivateRecovery(evidence: {
  manifestValid: boolean; sealedProofVerified: boolean; withdrawalsComplete: boolean; previousWriterFenced: boolean;
  newerDraftsProtected: boolean; effectsReconciled: boolean; writerClaim: 'acquired' | 'lost' | 'unconfirmed';
}): boolean {
  return evidence.manifestValid && evidence.sealedProofVerified && evidence.withdrawalsComplete
    && evidence.previousWriterFenced && evidence.newerDraftsProtected && evidence.effectsReconciled && evidence.writerClaim === 'acquired';
}

function outside(source: string, target: string): void {
  const difference = relative(resolve(source), resolve(target));
  if (!difference.startsWith(`..${sep}`) && difference !== '..') throw new Error('RECOVERY_ISOLATION_REQUIRED');
  const reverse = relative(resolve(target), resolve(source));
  if (!reverse.startsWith(`..${sep}`) && reverse !== '..') throw new Error('RECOVERY_ISOLATION_REQUIRED');
}

type HandoffTiming = NonNullable<RecoveryHandoffCertificate['timing']>;

function utcTime(value: unknown): number {
  if (typeof value !== 'string') return NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? timestamp : NaN;
}

function measureHandoff(receipt: RecoveryRestoreReceipt, timings: readonly (HandoffTiming | undefined)[]): void {
  if (!receipt.orderlyHandoff || timings.length === 0) return;
  const started = utcTime(receipt.startedAt);
  const finished = utcTime(receipt.finishedAt);
  let earliestInterruption = started;
  let greatestDataLoss = 0;
  for (const timing of timings) {
    if (!timing || timing.manifestSha256 !== receipt.manifestHash) return;
    const interrupted = utcTime(timing.interruptedAt);
    const recoveryPoint = utcTime(timing.recoveryPointAt);
    if (!(recoveryPoint <= interrupted && interrupted <= started && started <= finished)) return;
    earliestInterruption = Math.min(earliestInterruption, interrupted);
    greatestDataLoss = Math.max(greatestDataLoss, interrupted - recoveryPoint);
  }
  receipt.rpoMs = greatestDataLoss;
  receipt.rtoMs = finished - earliestInterruption;
}

export function createRecoveryRestorer(options: RecoveryRestoreOptions) {
  const now = options.now ?? (() => new Date());
  return {
    async restoreRecoverySet(setId: string, mode: 'drill' | 'activate' = 'drill', expectedManifestHash?: string): Promise<RecoveryRestoreReceipt> {
      const survivors = structuredClone(options.survivors ?? []);
      assertName(setId);
      if (mode !== 'drill' && mode !== 'activate') throw new Error('RECOVERY_MODE_INVALID');
      const startedMs = performance.now();
      const sourceDirectory = await containedPath(options.recoveryRoot, setId);
      outside(options.recoveryRoot, options.isolationRoot);
      for (const survivor of survivors) outside(survivor.root, options.isolationRoot);
      const set = await verifyRecoverySet(sourceDirectory, options.authority, options.versionLocks, options.readDatabase);
      if (set.manifest.setId !== setId) throw new Error('RECOVERY_SET_ID_MISMATCH');
      if (expectedManifestHash !== undefined && set.manifestHash !== expectedManifestHash) throw new Error('RECOVERY_MANIFEST_HASH_MISMATCH');
      const startedAt = now().toISOString();
      await mkdir(options.isolationRoot, { recursive: true, mode: 0o700 });
      const actualIsolation = await realpath(options.isolationRoot);
      outside(await realpath(options.recoveryRoot), actualIsolation);
      for (const survivor of survivors) outside(await realpath(survivor.root), actualIsolation);
      const directory = await mkdtemp(join(actualIsolation, `${setId}-`));
      const receipt: RecoveryRestoreReceipt = {
        receiptId: randomUUID(), setId, manifestHash: set.manifestHash, mode, directory, startedAt, finishedAt: startedAt, elapsedMs: 0,
        rpoMs: null, rtoMs: null, orderlyHandoff: false, external_writes: 0,
        channels: { feishu: 'requires_reauthorization' }, data_domains: {}, stages: [], conflicts: [],
      };
      await stage(receipt, 'manifest_and_database_validation', now, async () => []);
      for (const vault of set.manifest.vaults) await mkdir(restoredVaultRoot(directory, vault), { recursive: true, mode: 0o700 });
      for (const artifact of set.manifest.artifacts) {
        const restoredPath = await containedPath(directory, artifact.path);
        await durableCopy(await containedPath(sourceDirectory, artifact.path), restoredPath);
        const copied = await fileHash(restoredPath);
        if (copied.hash !== artifact.hash || copied.bytes !== artifact.bytes) throw new Error('RECOVERY_ARTIFACT_HASH_MISMATCH');
        if (artifact.kind === 'vault' && artifact.domain) {
          const path = artifact.path.split('/').slice(2).join('/');
          const vault = set.manifest.vaults.find((entry) => entry.resourcePrefix === artifact.path.split('/').slice(0, 2).join('/'));
          if (vault) {
            const root = restoredVaultRoot(directory, vault);
            await mkdir(root, { recursive: true, mode: 0o700 });
            await durableCopy(restoredPath, await containedPath(root, path));
          }
        }
      }
      if (survivors.some((survivor) => !set.manifest.domains.some((domain) => domain.domain === survivor.domain))) throw new Error('RECOVERY_RESOURCE_DOMAIN_MISMATCH');
      const service = new Database(join(directory, 'databases/service.sqlite'), { timeout: 2000 });
      const hub = new Database(join(directory, 'databases/hub.sqlite'), { timeout: 2000 });
      service.pragma('foreign_keys=ON');
      service.pragma('journal_mode=WAL');
      hub.pragma('foreign_keys=ON');
      hub.pragma('journal_mode=WAL');
      const candidates: Array<{ domain: string; winner: RecoveryWitnessRecord; cut: RecoveryLocalCut; reason: string; timing?: HandoffTiming }> = [];
      try {
        requireRecoverySchema(service);
        quarantineRestoredAuthority(service, now().toISOString(), receipt.receiptId, directory);
        for (const domain of set.manifest.domains) {
          receipt.data_domains[domain.domain] = { status: 'blocked', writerEpoch: null, activationId: null, reasons: [] };
          persistDomain(service, domain.domain, domain.writerEpoch, 'blocked', null, null, receipt.receiptId, 'recovery_in_progress', now().toISOString());
        }
        await checkpoint(service, receipt, directory, now);
        for (const domain of set.manifest.domains) {
          const result = receipt.data_domains[domain.domain];
          const reasons = result.reasons;
          const record = await options.witness?.current(domain.domain);
          let sealed = false;
          let fenced = false;
          let complete = false;
          let replayed = false;
          let replayCut: RecoveryLocalCut | undefined;
          let expectedGate = '';
          await stage(receipt, `withdrawal_and_handoff:${domain.domain}`, now, async () => {
            sealed = Boolean(record && record.writerEpoch === domain.writerEpoch && record.certificate?.cutId === set.manifest.cutId
              && await options.witness?.verifySealed(record));
            if (!sealed) reasons.push('sealed_proof_unverified');
            if (sealed && record && options.fence) {
              try {
                const proof = await options.fence.verify(domain.domain, record);
                fenced = proof.stopped && proof.credentialsRevoked && proof.proof === record.certificate?.fenceProof;
              } catch { fenced = false; }
            }
            if (!fenced) reasons.push('previous_writer_not_fenced');
            if (record && options.withdrawalLog?.independence === 'independent_authority') {
              try {
                const entries = await options.withdrawalLog.readComplete(domain.domain, record);
                const backupHead = domain.withdrawal.seq === 0 ? digest('') : entries[domain.withdrawal.seq - 1]?.hash;
                complete = sealed && verifyWithdrawalChain(domain.domain, entries, record.withdrawal)
                  && domain.withdrawal.seq <= record.withdrawal.seq && backupHead === domain.withdrawal.hash;
                if (complete) complete = applyWithdrawals(service, domain.domain, entries);
              } catch { complete = false; }
            }
            if (!complete) reasons.push('withdrawals_incomplete');
            return reasons;
          });
          await stage(receipt, `protect_surviving_vault_drafts:${domain.domain}`, now, async () => {
            for (const survivor of survivors) {
              if (survivor.domain === domain.domain) {
                const root = await realpath(survivor.root);
                const matches = set.manifest.vaults.filter((vault) => vault.domain === survivor.domain
                  && vault.canonicalRoot === root && (!survivor.vaultId || vault.vaultId === survivor.vaultId));
                if (matches.length !== 1) throw new Error('RECOVERY_SURVIVOR_VAULT_AMBIGUOUS');
                await mergeSurvivor(receipt, bindVaultRoot(survivor.root, matches[0]), matches[0]);
              }
            }
            return [];
          });
          await stage(receipt, `read_only_reconciliation:${domain.domain}`, now, async () => {
            const replay = await reconcileDomainCut({ service, hub, domain: domain.domain, directory, externalAccess: 'read_only' }, options.replay);
            const unresolved = replay.reasons;
            replayCut = replay.cut;
            expectedGate = canonical(service.prepare('SELECT * FROM recovery_domain_gates WHERE data_domain=?').get(domain.domain));
            replayed = unresolved.length === 0;
            if (!replayed) reasons.push('reconciliation_incomplete', ...unresolved);
            return unresolved;
          });
          if (complete && service.prepare('SELECT event_id FROM recovery_withdrawal_pending WHERE data_domain=? LIMIT 1').get(domain.domain)) {
            complete = false;
            reasons.push('withdrawal_changed_during_replay');
          }
          if (!set.manifest.completeness.recoverable) reasons.push('manifest_incomplete', ...set.manifest.completeness.gaps);
          if (mode === 'drill') reasons.push('drill_mode');
          if (mode === 'activate' && !options.activation) reasons.push('runtime_activation_unavailable');
          const eligible = mode === 'activate' && Boolean(options.activation) && set.manifest.completeness.recoverable
            && sealed && fenced && complete && replayed && Boolean(record);
          if (eligible && record && options.witness && options.activation) {
            const activationId = `${receipt.receiptId}:${domain.domain}`;
            result.activationId = activationId;
            await checkpoint(service, receipt, directory, now);
            const claim = await options.witness.claimRecoveryWriter(domain.domain, record.revision, activationId);
            if (canActivateRecovery({
              manifestValid: true, sealedProofVerified: sealed, withdrawalsComplete: complete, previousWriterFenced: fenced,
              newerDraftsProtected: true, effectsReconciled: replayed, writerClaim: claim,
            })) {
              const winner = await options.witness.current(domain.domain);
              if (winner?.state === 'open' && winner.activationId === activationId && winner.parentSealedRevision === record.revision
                && canonical(winner.withdrawal) === canonical(record.withdrawal) && replayCut) {
                result.writerEpoch = winner.writerEpoch;
                const pendingReason = `runtime_activation_pending:${activationId}:${replayCut.inventory}`;
                const preparedAt = now().toISOString();
                const prepared = withImmediateTransaction(service, () => {
                  if (canonical(localRecoveryCut({ service, hub }, domain.domain)) !== canonical(replayCut)
                    || canonical(service.prepare('SELECT * FROM recovery_domain_gates WHERE data_domain=?').get(domain.domain)) !== expectedGate) return false;
                  service.prepare('INSERT INTO recovery_quarantined_records VALUES (?,?,?,?,?,?)').run(
                    receipt.receiptId, 'recovery_activation_cut', domain.domain, domain.domain,
                    canonical({ generation: activationId, cut: replayCut, winner }), preparedAt,
                  );
                  persistDomain(service, domain.domain, winner.writerEpoch, 'blocked', activationId, winner.revision, receipt.receiptId, pendingReason, preparedAt);
                  return true;
                });
                if (!prepared) { reasons.push('activation_cut_changed'); continue; }
                try {
                  const enabled = await options.activation.enableDomain({
                    domain: domain.domain, writerEpoch: winner.writerEpoch, activationId, witnessRevision: winner.revision, directory,
                  });
                  if (enabled.epochInstalled && enabled.credentialsScoped && enabled.runtimeGateVerified) {
                    const timing = canonical(winner.certificate) === canonical(record.certificate) ? record.certificate?.timing : undefined;
                    candidates.push({ domain: domain.domain, winner, cut: replayCut, reason: pendingReason, timing });
                  } else {
                    reasons.push('runtime_activation_unconfirmed');
                    await revokeCandidate(options, service, receipt, domain.domain, winner, preparedAt);
                  }
                } catch {
                  reasons.push('runtime_activation_unconfirmed');
                  await revokeCandidate(options, service, receipt, domain.domain, winner, preparedAt);
                }
              } else reasons.push('writer_claim_unconfirmed');
            } else reasons.push(`writer_claim_${claim}`);
          }
          await checkpoint(service, receipt, directory, now);
        }
        receipt.finishedAt = now().toISOString();
        receipt.elapsedMs = Math.max(0, performance.now() - startedMs);
        await checkpoint(service, receipt, directory, now);
        const authoritative = await Promise.all(candidates.map(async (candidate) => ({
          domain: candidate.domain, current: await options.witness?.current(candidate.domain),
        })));
        const published = withImmediateTransaction(service, () => {
          const valid = candidates.every((candidate) => {
            const row = service.prepare('SELECT * FROM recovery_domain_gates WHERE data_domain=?').get(candidate.domain) as Record<string, unknown> | undefined;
            const evidence = service.prepare(`SELECT row_json FROM recovery_quarantined_records
              WHERE receipt_id=? AND table_name='recovery_activation_cut' AND record_id=?`).get(receipt.receiptId, candidate.domain) as { row_json: string } | undefined;
            return canonical(authoritative.find((item) => item.domain === candidate.domain)?.current) === canonical(candidate.winner)
              && canonical(localRecoveryCut({ service, hub }, candidate.domain)) === canonical(candidate.cut)
              && row?.status === 'blocked' && row.reason === candidate.reason && row.activation_id === candidate.winner.activationId
              && row.writer_epoch === candidate.winner.writerEpoch && row.witness_revision === candidate.winner.revision
              && row.receipt_id === receipt.receiptId
              && evidence?.row_json === canonical({ generation: candidate.winner.activationId, cut: candidate.cut, winner: candidate.winner });
          });
          if (!valid) return false;
          receipt.finishedAt = now().toISOString();
          for (const candidate of candidates) {
            receipt.data_domains[candidate.domain].status = 'open';
            persistDomain(service, candidate.domain, candidate.winner.writerEpoch, 'open', candidate.winner.activationId,
              candidate.winner.revision, receipt.receiptId, null, receipt.finishedAt);
          }
          receipt.orderlyHandoff = mode === 'activate' && Object.values(receipt.data_domains).every((domain) => domain.status === 'open');
          receipt.elapsedMs = Math.max(0, performance.now() - startedMs);
          measureHandoff(receipt, candidates.map(candidate => candidate.timing));
          persistReceipt(service, receipt, receipt.finishedAt);
          return true;
        });
        if (!published) {
          for (const candidate of candidates) {
            receipt.data_domains[candidate.domain].reasons.push('activation_cut_changed');
            await revokeCandidate(options, service, receipt, candidate.domain, candidate.winner, receipt.finishedAt);
          }
          receipt.finishedAt = now().toISOString();
          receipt.elapsedMs = Math.max(0, performance.now() - startedMs);
          persistReceipt(service, receipt, receipt.finishedAt);
        }
        return receipt;
      } catch (error) {
        for (const candidate of candidates) {
          receipt.data_domains[candidate.domain].status = 'blocked';
          receipt.data_domains[candidate.domain].reasons.push('activation_interrupted');
          await revokeCandidate(options, service, receipt, candidate.domain, candidate.winner, receipt.finishedAt);
        }
        throw error;
      } finally {
        service.close();
        hub.close();
      }
    },
  };
}

async function revokeCandidate(
  options: RecoveryRestoreOptions, database: SqliteDatabase, receipt: RecoveryReceipt,
  domain: string, winner: RecoveryWitnessRecord, timestamp: string,
) {
  try {
    database.prepare(`UPDATE recovery_domain_gates SET status=CASE WHEN status='protection_pending' THEN status ELSE 'blocked' END,
      activation_id=NULL,witness_revision=NULL,reason=CASE WHEN status='protection_pending' THEN reason ELSE 'activation_revoked' END,
      updated_at=? WHERE data_domain=? AND receipt_id=? AND activation_id=?`).run(timestamp, domain, receipt.receiptId, winner.activationId);
  } catch { receipt.data_domains[domain].reasons.push('runtime_gate_revocation_unconfirmed'); }
  try {
    await options.activation?.revokeDomain?.({
      domain, writerEpoch: winner.writerEpoch, activationId: winner.activationId!, witnessRevision: winner.revision, directory: receipt.directory,
    });
  } catch { receipt.data_domains[domain].reasons.push('runtime_revocation_unconfirmed'); }
}

async function mergeSurvivor(receipt: RecoveryReceipt, binding: BoundVaultRoot, vault: RecoveryVault): Promise<void> {
  assertName(vault.domain);
  const checked = <T>(operation: () => Promise<T>) => withVaultRoot(binding, operation);
  const root = restoredVaultRoot(receipt.directory, vault);
  await checked(() => mkdir(root, { recursive: true, mode: 0o700 }));
  for (const path of await checked(() => walkFiles(binding.root))) {
    const bytes = await readVaultFile(binding, path);
    const destination = await checked(() => containedPath(root, path));
    let old: Buffer | undefined;
    try { old = await checked(() => readFile(destination)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (old && digest(old) !== digest(bytes)) {
      const backup = old;
      const preserved = `conflicts/${vault.domain}/${digest(vault.vaultId)}/${digest(old)}/${path}`;
      const preservedPath = await checked(() => containedPath(receipt.directory, preserved));
      await checked(() => durableWrite(preservedPath, backup));
      receipt.conflicts.push({ domain: vault.domain, vaultId: vault.vaultId, path, backupHash: digest(old), survivorHash: digest(bytes), preservedBackupPath: preserved });
    }
    if (!old || digest(old) !== digest(bytes)) {
      if (old) {
        const handle = await open(destination, 'w', 0o600);
        try {
          assertVaultRoot(binding);
          await handle.writeFile(bytes);
          assertVaultRoot(binding);
          await handle.sync();
        } finally { await handle.close(); }
        assertVaultRoot(binding);
      } else await checked(() => durableWrite(destination, bytes));
    }
  }
  assertVaultRoot(binding);
}

export function requireRecoverySchema(db: SqliteDatabase): void {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recovery_domain_gates'").get()) throw new Error('RECOVERY_SCHEMA_NOT_REGISTERED');
}

export function quarantineRestoredAuthority(db: SqliteDatabase, now: string, receiptId: string, directory: string): void {
  withImmediateTransaction(db, () => {
    const tables = [
      ['sessions', 'token_hash'], ['auth_challenges', 'challenge_id'], ['bootstrap_tickets', 'ticket_hash'],
      ['channel_connections', 'connection_id'], ['channel_pairings', 'pairing_id'], ['channel_tests', 'test_id'],
      ['channel_permits', 'permit_id'], ['notification_intents', 'intent_id'], ['source_configs', 'source_id'], ['vaults', 'vault_id'],
    ];
    for (const [table, key] of tables) {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      for (const row of db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>) {
        db.prepare('INSERT OR IGNORE INTO recovery_quarantined_records VALUES (?,?,?,?,?,?)').run(
          receiptId, table, String(row[key]), typeof row.data_domain === 'string' ? row.data_domain : null, JSON.stringify(row), now,
        );
      }
    }
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM auth_challenges').run();
    db.prepare('DELETE FROM bootstrap_tickets').run();
    db.prepare('UPDATE accounts SET auth_epoch=auth_epoch+1').run();
    db.prepare('UPDATE settings_validations SET valid=0').run();
    db.prepare('UPDATE execution_grants SET revoked_at=? WHERE revoked_at IS NULL').run(now);
    db.prepare('DELETE FROM resume_intents').run();
    const vaults = db.prepare('SELECT vault_id,source_id,data_domain FROM vaults').all() as Array<{ vault_id: string; source_id: string; data_domain: string }>;
    const sourceRoots = new Map<string, string>();
    for (const vault of vaults) {
      assertName(vault.data_domain);
      const root = restoredVaultRoot(directory, { vaultId: vault.vault_id, domain: vault.data_domain });
      if (sourceRoots.has(vault.source_id)) throw new Error('RECOVERY_VAULT_SOURCE_AMBIGUOUS');
      sourceRoots.set(vault.source_id, root);
      db.prepare(`UPDATE vaults SET root_path=?,physical_root=?,isolation_root=?,root_identity=?,scope_hash=?,
        config_revision=config_revision+1,connection_epoch=connection_epoch+1,status='not_connected',updated_at=? WHERE vault_id=?`).run(
        root, root, directory, `recovery:${receiptId}:${vault.vault_id}`, digest(root), now, vault.vault_id,
      );
    }
    const sources = db.prepare('SELECT source_id,connector_type FROM source_configs').all() as Array<{ source_id: string; connector_type: string }>;
    for (const source of sources) {
      db.prepare("UPDATE source_configs SET enabled=0,status='paused',credential_ref=NULL,config_revision=config_revision+1,updated_at=? WHERE source_id=?").run(now, source.source_id);
      if (source.connector_type === 'directory') {
        const root = sourceRoots.get(source.source_id) ?? join(directory, 'source-roots', digest(source.source_id));
        db.prepare('UPDATE source_configs SET normalized_target=?,physical_root=? WHERE source_id=?').run(root, root, source.source_id);
      }
      db.prepare(`INSERT INTO source_versions SELECT source_id,config_revision,account_id,data_domain,connector_type,
        normalized_target,physical_root,scope_json,excludes_json,credential_ref,frequency,history,has_trigger_rule,enabled,status,schema_version,?
        FROM source_configs WHERE source_id=?`).run(now, source.source_id);
    }
    db.prepare("UPDATE vault_clients SET mapping_revision=mapping_revision+1,app_status='unknown',editor_status='unknown',observed_at=?").run(now);
    const connections = db.prepare('SELECT connection_id,channel_incarnation FROM channel_connections').all() as Array<{ connection_id: string; channel_incarnation: number }>;
    for (const connection of connections) {
      let incarnation = randomInt(1, 2 ** 48 - 1);
      while (incarnation === connection.channel_incarnation || incarnation === connection.channel_incarnation + 1) incarnation = randomInt(1, 2 ** 48 - 1);
      db.prepare(`UPDATE channel_connections SET channel_incarnation=?,connection_epoch=connection_epoch+1,binding_revision=binding_revision+1,
        current_pairing_id=NULL,current_test_id=NULL,owner_open_id=NULL,chat_id=NULL,credential_ref=?,status='requires_reauthorization',
        transport_mode='disabled',reason_code='recovery_requires_reauthorization',updated_at=? WHERE connection_id=?`).run(
        incarnation, `recovery-unconfigured:${receiptId}`, now, connection.connection_id,
      );
    }
    db.prepare("UPDATE channel_pairings SET status='expired' WHERE status IN ('open','candidate')").run();
    db.prepare("UPDATE channel_tests SET status='expired',reason_code='recovery_requires_reauthorization',updated_at=?").run(now);
    db.prepare("UPDATE channel_permits SET terminal=1,disposition='recovery_quarantined' WHERE terminal=0").run();
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notification_intents'").get()) {
      db.prepare("UPDATE notification_intents SET status='blocked',lease_until=NULL,updated_at=? WHERE status NOT IN ('sent','superseded')").run(now);
    }
  });
}

export function persistDomain(
  db: SqliteDatabase, domain: string, epoch: string, status: 'blocked' | 'open' | 'importing' | 'imported', activationId: string | null,
  witnessRevision: string | null, receiptId: string, reason: string | null, now: string,
): void {
  db.prepare(`INSERT INTO recovery_domain_gates VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(data_domain) DO UPDATE SET writer_epoch=excluded.writer_epoch,status=excluded.status,activation_id=excluded.activation_id,
    witness_revision=excluded.witness_revision,receipt_id=excluded.receipt_id,reason=excluded.reason,updated_at=excluded.updated_at`).run(
    domain, epoch, status, activationId, witnessRevision, receiptId, reason, now,
  );
}

async function stage(receipt: RecoveryReceipt, name: string, now: () => Date, run: () => Promise<string[]>): Promise<void> {
  const startedAt = now().toISOString();
  const reasons = await run();
  receipt.stages.push({ stage: name, startedAt, finishedAt: now().toISOString(), status: reasons.length ? 'blocked' : 'complete', reasons: [...reasons] });
}

async function checkpoint(db: SqliteDatabase, receipt: RecoveryReceipt, directory: string, now: () => Date): Promise<void> {
  persistReceipt(db, receipt, now().toISOString());
  await durableJson(join(directory, `receipt-${randomUUID()}.json`), receipt);
}

function persistReceipt(db: SqliteDatabase, receipt: RecoveryReceipt, timestamp: string): void {
  const bytes = canonical(receipt);
  db.prepare(`INSERT INTO recovery_receipts VALUES (?,?,?,?,?) ON CONFLICT(receipt_id) DO UPDATE SET receipt_json=excluded.receipt_json`).run(
    receipt.receiptId, receipt.setId, receipt.mode, bytes, timestamp,
  );
}

export async function reconcileRecoveredDomain(context: RecoveryReplayContext, ports?: RecoveryReplayPorts): Promise<string[]> {
  return (await reconcileDomainCut(context, ports)).reasons;
}

async function reconcileDomainCut(context: RecoveryReplayContext, ports?: RecoveryReplayPorts): Promise<{ reasons: string[]; cut?: RecoveryLocalCut }> {
  if (!ports || ports.externalAccess !== 'read_only') return { reasons: ['read_only_replay_ports_unavailable'] };
  const reasons: string[] = [];
  async function confirmed(name: string, run: (() => Promise<RecoveryReadback>) | undefined) {
    try { if (!run || !(await run()).confirmed) reasons.push(name); } catch { reasons.push(name); }
  }
  await confirmed('hub_readback_unconfirmed', () => ports.reconcileHub(context));
  await confirmed('pending_ingest_unconfirmed', () => ports.recoverPendingIngest(context));
  const batches: Array<{ table: string; key: string; condition: string; port: ((id: string, context: RecoveryReplayContext) => Promise<RecoveryReadback>) | undefined }> = [
    { table: 'answer_intents', key: 'intent_id', condition: "send_status IN ('stored','accepted','uncertain')", port: ports.recoverAnswer },
    { table: 'effect_intents', key: 'intent_id', condition: '1=1', port: ports.reconcilePr },
    { table: 'settings_changes', key: 'change_id', condition: "phase IN ('applying','applied','uncertain')", port: ports.reconcileConfiguration },
    { table: 'consultations', key: 'request_id', condition: "status='pending'", port: ports.reconcileConsultation },
    { table: 'notification_intents', key: 'intent_id', condition: "status<>'superseded'", port: ports.reconcileNotification },
  ];
  const expected = new Map<string, Map<string, Record<string, unknown>>>();
  for (const batch of batches) {
    if (!context.service.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(batch.table)) continue;
    const inventory = new Map(tableInventory(context.service, batch.table, context.domain).map((row) => [String(row[batch.key]), row]));
    expected.set(batch.table, inventory);
    const companionTable = batch.table === 'effect_intents' ? 'effect_receipts' : batch.table === 'answer_intents' ? 'answer_receipts' : undefined;
    const companionKey = companionTable === 'answer_receipts' ? 'receipt_id' : 'intent_id';
    const companion = companionTable ? new Map(tableInventory(context.service, companionTable, context.domain)
      .map((row) => [String(row[companionKey]), row])) : undefined;
    if (companionTable && companion) expected.set(companionTable, companion);
    const rows = context.service.prepare(`SELECT ${batch.key} AS id FROM ${batch.table} WHERE data_domain=? AND (${batch.condition}) ORDER BY ${batch.key}`).all(context.domain) as Array<{ id: string }>;
    for (const row of rows) {
      await confirmed(`${batch.table}_unconfirmed:${row.id}`, batch.port ? () => batch.port!(row.id, context) : undefined);
      const after = context.service.prepare(`SELECT * FROM ${batch.table} WHERE ${batch.key}=? AND data_domain=?`).get(row.id, context.domain) as Record<string, unknown> | undefined;
      if (after) inventory.set(row.id, after);
      else inventory.delete(row.id);
      if (companionTable && companion) {
        for (const [key, value] of companion) if (value.intent_id === row.id) companion.delete(key);
        for (const value of tableInventory(context.service, companionTable, context.domain).filter((entry) => entry.intent_id === row.id)) {
          companion.set(String(value[companionKey]), value);
        }
      }
    }
  }
  await confirmed('projections_unconfirmed', () => ports.rebuildProjections(context));
  for (const [table, inventory] of expected) {
    const rows = [...inventory.values()].sort((left, right) => canonical(left).localeCompare(canonical(right)));
    if (canonical(tableInventory(context.service, table, context.domain)) !== canonical(rows)) reasons.push(`reconciliation_inventory_changed:${table}`);
  }
  return { reasons, cut: reasons.length ? undefined : localRecoveryCut(context, context.domain) };
}

function applyWithdrawals(db: SqliteDatabase, domain: string, entries: WithdrawalEntry[]): boolean {
  return withImmediateTransaction(db, () => {
    for (const entry of entries) {
      const event = entry.event;
      const old = db.prepare('SELECT * FROM withdrawal_events WHERE event_id=?').get(event.eventId) as Record<string, unknown> | undefined;
      if (old && (old.data_domain !== domain || old.target_kind !== event.targetKind || old.target_id !== event.targetId
        || old.target_version !== event.targetVersion || old.epoch !== event.epoch || old.reason !== event.reason || old.created_at !== event.createdAt)) throw new Error('RECOVERY_WITHDRAWAL_CONFLICT');
      db.prepare('INSERT OR IGNORE INTO withdrawal_events VALUES (?,?,?,?,?,?,?,?)').run(
        event.eventId, domain, event.targetKind, event.targetId, event.targetVersion, event.epoch, event.reason, event.createdAt,
      );
      const logged = db.prepare('SELECT entry_hash FROM recovery_withdrawal_log WHERE data_domain=? AND sequence=?').get(domain, entry.seq) as { entry_hash: string } | undefined;
      if (logged && logged.entry_hash !== entry.hash) throw new Error('RECOVERY_WITHDRAWAL_CONFLICT');
      db.prepare('INSERT OR IGNORE INTO recovery_withdrawal_log VALUES (?,?,?,?,?,?,?)').run(
        domain, entry.seq, entry.writerEpoch, entry.previousHash, entry.hash, JSON.stringify(event), 'protected',
      );
      db.prepare("UPDATE recovery_withdrawal_log SET protection='protected' WHERE data_domain=? AND sequence=?").run(domain, entry.seq);
      db.prepare('DELETE FROM recovery_withdrawal_pending WHERE event_id=? AND data_domain=?').run(event.eventId, domain);
      if (event.targetKind === 'standard') {
        db.prepare("UPDATE standard_versions SET status='withdrawn' WHERE standard_id=? AND version=? AND data_domain=?").run(event.targetId, event.targetVersion, domain);
      } else if (event.targetKind === 'evidence') {
        db.prepare("UPDATE evidence_refs SET status='retracted',withdrawal_epoch=? WHERE evidence_id=? AND data_domain=?").run(event.epoch, event.targetId, domain);
        db.prepare(`UPDATE knowledge_records SET status='withdrawn' WHERE data_domain=? AND knowledge_id IN (
          SELECT knowledge_id FROM evidence_refs WHERE evidence_id=? AND data_domain=?)`).run(domain, event.targetId, domain);
      } else if (event.targetKind === 'knowledge') {
        db.prepare("UPDATE knowledge_records SET status='withdrawn' WHERE knowledge_id=? AND data_domain=?").run(event.targetId, domain);
      } else if (event.targetKind !== 'report') return false;
    }
    return true;
  });
}
