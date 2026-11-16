import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type CredentialStore = {
  put(secret: Uint8Array, ttlMs: number): string;
  resolve(reference: string): Uint8Array | null;
};

type StoredSecret = {
  expires_at: string;
  secret: string;
};

const REFERENCE_PATTERN = /^cred_[A-Za-z0-9_-]+$/;

export function createCredentialStore(directory: string, now: () => Date = () => new Date()): CredentialStore {
  mkdirSync(directory, { recursive: true });
  return {
    put(secret, ttlMs) {
      const reference = `cred_${randomBytes(18).toString('base64url')}`;
      const body: StoredSecret = {
        expires_at: new Date(now().getTime() + ttlMs).toISOString(),
        secret: Buffer.from(secret).toString('base64url'),
      };
      writeFileSync(join(directory, reference), JSON.stringify(body), { mode: 0o600 });
      return reference;
    },
    resolve(reference) {
      if (!REFERENCE_PATTERN.test(reference)) return null;
      let raw: string;
      try {
        raw = readFileSync(join(directory, reference), 'utf8');
      } catch {
        return null;
      }
      let parsed: StoredSecret;
      try {
        parsed = JSON.parse(raw) as StoredSecret;
      } catch {
        return null;
      }
      if (typeof parsed.expires_at !== 'string' || typeof parsed.secret !== 'string') return null;
      if (parsed.expires_at <= now().toISOString()) return null;
      return Uint8Array.from(Buffer.from(parsed.secret, 'base64url'));
    },
  };
}
