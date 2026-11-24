import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { assertName, assertRelative, canonical, containedPath, digest, durableJson, durableWrite } from './files.js';
import { persistDomain, requireRecoverySchema } from './restore.js';
import type { RecoveryReceipt } from './types.js';
import type { RecoveryWitness } from './witness.js';

export type OwnerRecoveryImport = {
  importId: string; accountId: string; domain: string; controlReceiptRef: string;
  root: string; approvedPaths: string[]; previousEpoch: string;
};
export type RecoveryOwnerControl = {
  authorizeRead?(input: OwnerRecoveryImport): Promise<{ authenticatedOwner: boolean; domain: string }>;
  verify(input: OwnerRecoveryImport): Promise<{
    authenticatedOwner: boolean; trustedControl: boolean; domain: string; controlReceiptRef: string;
  }>;
};

export function createOwnerRecoveryImporter(options: {
  database: SqliteDatabase; isolationRoot: string; witness?: RecoveryWitness; control?: RecoveryOwnerControl; now?: () => Date;
}) {
  const db = options.database;
  const now = options.now ?? (() => new Date());
  return {
    async importSurvivors(input: OwnerRecoveryImport): Promise<RecoveryReceipt> {
      input = structuredClone(input);
      assertName(input.importId);
      assertName(input.domain);
      if (!input.accountId || !input.previousEpoch || !input.controlReceiptRef || !input.approvedPaths.length
        || new Set(input.approvedPaths).size !== input.approvedPaths.length) throw new Error('RECOVERY_IMPORT_INVALID');
      input.approvedPaths.forEach(assertRelative);
      if (!options.control?.authorizeRead || !db.prepare('SELECT account_id FROM accounts WHERE account_id=?').get(input.accountId)) throw new Error('RECOVERY_OWNER_CONTROL_REQUIRED');
      requireRecoverySchema(db);
      const authorization = await options.control.authorizeRead(structuredClone(input));
      if (!authorization.authenticatedOwner || authorization.domain !== input.domain
        || !db.prepare('SELECT account_id FROM accounts WHERE account_id=?').get(input.accountId)) throw new Error('RECOVERY_OWNER_CONTROL_REQUIRED');
      const request = { ...input, approvedPaths: [...input.approvedPaths].sort() };
      const fingerprint = digest(canonical(request));
      const previous = db.prepare('SELECT status,manifest_json FROM recovery_imports WHERE import_id=?').get(input.importId) as { status: string; manifest_json: string } | undefined;
      if (previous) {
        const saved = JSON.parse(previous.manifest_json) as { fingerprint?: string };
        if (saved.fingerprint !== fingerprint) throw new Error('RECOVERY_IMPORT_ID_CONFLICT');
        const outcome = db.prepare("SELECT receipt_json FROM recovery_receipts WHERE receipt_id=? AND mode='owner_import'").get(input.importId) as { receipt_json: string } | undefined;
        if (!outcome) throw new Error('RECOVERY_IMPORT_OUTCOME_UNAVAILABLE');
        const receipt = JSON.parse(outcome.receipt_json) as RecoveryReceipt;
        return { ...receipt, rpoMs: null, rtoMs: null };
      }
      if (!options.witness) throw new Error('RECOVERY_WITNESS_STATUS_UNKNOWN');
      if (await options.witness.current(input.domain)) throw new Error('RECOVERY_WITNESS_AVAILABLE');
      const startedAt = now().toISOString();
      const startedMs = performance.now();
      const epoch = randomUUID();
      await mkdir(options.isolationRoot, { recursive: true, mode: 0o700 });
      const actualRoot = await realpath(input.root);
      const actualIsolation = await realpath(options.isolationRoot);
      const difference = relative(actualRoot, actualIsolation);
      if (!difference || (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference))) throw new Error('RECOVERY_ISOLATION_REQUIRED');
      const directory = await mkdtemp(join(actualIsolation, `${input.importId}-`));
      const receipt: RecoveryReceipt = {
        receiptId: input.importId, setId: input.importId, mode: 'owner_import', directory, startedAt, finishedAt: startedAt,
        elapsedMs: 0, rpoMs: null, rtoMs: null, orderlyHandoff: false, external_writes: 0, channels: { feishu: 'requires_reauthorization' },
        data_domains: { [input.domain]: { status: 'blocked', writerEpoch: epoch, activationId: null, reasons: ['owner_import_in_progress'] } },
        stages: [], conflicts: [],
      };
      withImmediateTransaction(db, () => {
        const active = db.prepare("SELECT import_id FROM recovery_imports WHERE data_domain=? AND status='importing'").get(input.domain);
        if (active) throw new Error('RECOVERY_IMPORT_IN_PROGRESS');
        db.prepare('INSERT INTO recovery_imports VALUES (?,?,?,?,?,?,?,?,?)').run(
          input.importId, input.domain, epoch, input.controlReceiptRef, 'importing', startedAt, null, null,
          canonical({ request, fingerprint, canonicalRoot: actualRoot, directory, objects: [] }),
        );
        persistDomain(db, input.domain, epoch, 'importing', null, null, input.importId, 'owner_import_in_progress', startedAt);
        db.prepare('INSERT INTO recovery_receipts VALUES (?,?,?,?,?)').run(
          input.importId, input.importId, 'owner_import', canonical(receipt), startedAt,
        );
      });
      try {
        const proof = await options.control.verify(structuredClone(input));
        if (!proof.authenticatedOwner || !proof.trustedControl || proof.domain !== input.domain
          || proof.controlReceiptRef !== input.controlReceiptRef) throw new Error('RECOVERY_OWNER_CONTROL_REQUIRED');
        if (await options.witness.current(input.domain)) throw new Error('RECOVERY_WITNESS_AVAILABLE');
        const objects: Array<{ path: string; hash: string; bytes: number }> = [];
        for (const path of input.approvedPaths) {
          const source = await containedPath(input.root, path);
          if (!(await lstat(source)).isFile()) throw new Error('RECOVERY_SPECIAL_FILE_FORBIDDEN');
          const bytes = await readFile(source);
          const destination = await containedPath(directory, `vault/${input.domain}/${path}`);
          await durableWrite(destination, bytes);
          if (digest(await readFile(source)) !== digest(bytes) || digest(await readFile(destination)) !== digest(bytes)) throw new Error('RECOVERY_IMPORT_READBACK_MISMATCH');
          objects.push({ path, hash: digest(bytes), bytes: bytes.length });
        }
        await durableJson(join(directory, 'owner-import-manifest.json'), {
          importId: input.importId, accountId: input.accountId, domain: input.domain, writerEpoch: epoch,
          controlReceiptRef: input.controlReceiptRef, objects, externalWrites: false,
        });
        receipt.elapsedMs = Math.max(0, performance.now() - startedMs);
        receipt.finishedAt = now().toISOString();
        receipt.data_domains[input.domain] = { status: 'imported', writerEpoch: epoch, activationId: null, reasons: ['external_activation_requires_new_admission'] };
        receipt.stages.push({ stage: 'trusted_scoped_owner_import', startedAt, finishedAt: receipt.finishedAt, status: 'complete', reasons: [] });
        await durableJson(join(directory, 'receipt.json'), receipt);
        withImmediateTransaction(db, () => {
          for (const object of objects) {
            db.prepare('INSERT INTO recovery_import_objects VALUES (?,?,?,?,?,?,?)').run(
              input.importId, input.domain, epoch, object.path, object.hash, object.bytes, join(directory, `vault/${input.domain}/${object.path}`),
            );
          }
          db.prepare("UPDATE recovery_imports SET status='complete',completed_at=?,elapsed_ms=?,manifest_json=? WHERE import_id=?").run(
            receipt.finishedAt, Math.ceil(receipt.elapsedMs), canonical({ request, fingerprint, canonicalRoot: actualRoot, directory, objects }), input.importId,
          );
          persistDomain(db, input.domain, epoch, 'imported', null, null, input.importId, 'external_activation_requires_new_admission', receipt.finishedAt);
          db.prepare('UPDATE recovery_receipts SET receipt_json=? WHERE receipt_id=?').run(
            canonical(receipt), input.importId,
          );
        });
        return receipt;
      } catch (error) {
        const failedAt = now().toISOString();
        receipt.finishedAt = failedAt;
        receipt.elapsedMs = Math.max(0, performance.now() - startedMs);
        receipt.data_domains[input.domain] = { status: 'blocked', writerEpoch: epoch, activationId: null, reasons: ['owner_import_incomplete'] };
        receipt.stages = [{ stage: 'trusted_scoped_owner_import', startedAt, finishedAt: failedAt, status: 'blocked', reasons: ['owner_import_incomplete'] }];
        withImmediateTransaction(db, () => {
          db.prepare("UPDATE recovery_imports SET status='blocked',elapsed_ms=? WHERE import_id=?").run(Math.ceil(performance.now() - startedMs), input.importId);
          persistDomain(db, input.domain, epoch, 'blocked', null, null, input.importId, 'owner_import_incomplete', failedAt);
          db.prepare('UPDATE recovery_receipts SET receipt_json=? WHERE receipt_id=?').run(canonical(receipt), input.importId);
        });
        throw error;
      }
    },
  };
}
