import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { recordCommand, type InboxCommand } from './commands.js';
import { withImmediateTransaction, type SqliteDatabase } from './database.js';
import { appendDomainEvent } from './outbox.js';

export type BlobStore = {
  putBlob(bytes: Uint8Array): Promise<string>;
  readBlob(sha256: string): Promise<Uint8Array>;
  pathFor(sha256: string): string;
};

export type CommitBlobRevisionInput = {
  bytes: Uint8Array;
  objectId: string;
  accountId: string;
  dataDomain: string;
  command: InboxCommand;
  eventId: string;
  destination: string;
  beforeCommit?: () => void;
};

export function createBlobStore(root: string): BlobStore {
  return {
    pathFor(sha256: string): string {
      assertHash(sha256);
      return join(root, sha256.slice(0, 2), sha256);
    },
    async readBlob(sha256: string): Promise<Uint8Array> {
      return new Uint8Array(await readFile(this.pathFor(sha256)));
    },
    async putBlob(bytes: Uint8Array): Promise<string> {
      const hash = createHash('sha256').update(bytes).digest('hex');
      const finalPath = join(root, hash.slice(0, 2), hash);
      const shard = dirname(finalPath);
      await mkdir(shard, { recursive: true });
      await syncDirectory(root);
      const existing = await readIfPresent(finalPath);
      if (existing) {
        if (!existing.equals(Buffer.from(bytes))) throw new Error('BLOB_HASH_COLLISION');
        return hash;
      }
      const temporaryPath = join(shard, `.${hash}.${process.pid}.${randomUUID()}.tmp`);
      const handle = await open(temporaryPath, 'w', 0o644);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporaryPath, finalPath);
        await syncDirectory(shard);
        const verified = await readFile(finalPath);
        if (!verified.equals(Buffer.from(bytes))) {
          await rm(finalPath, { force: true });
          throw new Error('BLOB_READBACK_MISMATCH');
        }
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
      return hash;
    },
  };
}

export async function commitBlobRevision(
  db: SqliteDatabase,
  blobs: BlobStore,
  input: CommitBlobRevisionInput,
): Promise<{ sha256: string; revision: number; command_id: string; created: boolean }> {
  const sha256 = await blobs.putBlob(input.bytes);
  const readable = await blobs.readBlob(sha256);
  if (!Buffer.from(readable).equals(Buffer.from(input.bytes))) throw new Error('BLOB_UNREADABLE');
  return withImmediateTransaction(db, () => {
    const receipt = recordCommand(db, input.command);
    if (receipt.created) {
      const now = new Date().toISOString();
      db.prepare('INSERT INTO blobs (sha256, byte_length, created_at) VALUES (?, ?, ?) ON CONFLICT(sha256) DO NOTHING').run(
        sha256,
        input.bytes.byteLength,
        now,
      );
      const current = db.prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM object_revisions WHERE object_id = ?').get(input.objectId) as {
        revision: number;
      };
      const revision = current.revision + 1;
      db.prepare(`INSERT INTO object_revisions (
        object_id, revision, account_id, data_domain, schema_version, blob_ref, command_id, created_at
      ) VALUES (?, ?, ?, ?, '1.0', ?, ?, ?)`).run(
        input.objectId,
        revision,
        input.accountId,
        input.dataDomain,
        sha256,
        receipt.command_id,
        now,
      );
      appendDomainEvent(db, {
        eventId: input.eventId,
        aggregateId: input.objectId,
        aggregateVersion: revision,
        accountId: input.accountId,
        dataDomain: input.dataDomain,
        payload: { sha256, command_id: receipt.command_id },
        destination: input.destination,
      });
      input.beforeCommit?.();
      return { sha256, revision, command_id: receipt.command_id, created: true };
    }
    input.beforeCommit?.();
    const current = db.prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM object_revisions WHERE object_id = ?').get(input.objectId) as {
      revision: number;
    };
    return { sha256, revision: current.revision, command_id: receipt.command_id, created: false };
  });
}

async function readIfPresent(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('BLOB_HASH_INVALID');
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT';
}
