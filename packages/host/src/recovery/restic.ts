import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { recoverySetEvidence } from './backup.js';
import { canonical, containedPath, digest, fileHash } from './files.js';
import type { RecoveryManifest, RecoveryOffHostPort } from './types.js';

export type RecoveryResticTarget = {
  targetId: string; repository: string; domains: string[]; authorized: boolean; offHostVerified: boolean;
  credentialRef: string; recoveryCredentialRef: string; expectedVersion: string;
};
export type RecoveryResticRunner = (
  args: string[], environment: Readonly<Record<string, string>>, emit: (bytes: Uint8Array) => void,
) => Promise<void>;

export function createResticRecoveryBackup(options: {
  target: RecoveryResticTarget; credentials: { resolve(reference: string): Promise<Record<string, string>> };
  executable?: string; runner?: RecoveryResticRunner; now?: () => Date;
}): RecoveryOffHostPort {
  const target = structuredClone(options.target);
  const runner = options.runner ?? nativeResticRunner(options.executable ?? 'restic');
  return {
    async protect(set) {
      const evidence = recoverySetEvidence(set);
      const manifest = JSON.parse(evidence.inventory) as RecoveryManifest;
      if (!target.authorized || !target.offHostVerified || !target.targetId || !target.credentialRef || !target.recoveryCredentialRef
        || !target.expectedVersion || !/^(sftp:|s3:|b2:|azure:|gs:|rest:https:\/\/)/.test(target.repository)
        || canonical([...target.domains].sort()) !== canonical(manifest.domains.map((domain) => domain.domain).sort())) {
        throw new Error('RECOVERY_RESTIC_TARGET_NOT_ADMITTED');
      }
      if (!manifest.completeness.recoverable || !isAbsolute(evidence.directory)) throw new Error('RECOVERY_RESTIC_SET_INCOMPLETE');
      const expectations = [
        { path: 'manifest.json', hash: digest(evidence.envelope), bytes: Buffer.byteLength(evidence.envelope) },
        ...manifest.artifacts,
      ];
      async function verifyLocalInventory() {
        recoverySetEvidence(set);
        for (const expected of expectations) {
          const actual = await fileHash(await containedPath(evidence.directory, expected.path));
          if (actual.hash !== expected.hash || actual.bytes !== expected.bytes) throw new Error('RECOVERY_RESTIC_SET_CHANGED');
        }
        recoverySetEvidence(set);
      }
      await verifyLocalInventory();
      const environment = await options.credentials.resolve(target.credentialRef);
      if (!environment.RESTIC_PASSWORD && !environment.RESTIC_PASSWORD_FILE) throw new Error('RECOVERY_RESTIC_CREDENTIAL_REQUIRED');
      let version = '';
      await runner(['version'], environment, (bytes) => {
        version += Buffer.from(bytes).toString('utf8');
        if (version.length > 4096) throw new Error('RECOVERY_RESTIC_VERSION_INVALID');
      });
      if (version.trim() !== target.expectedVersion) throw new Error('RECOVERY_RESTIC_VERSION_MISMATCH');
      await verifyLocalInventory();
      const prefix = ['--repo', target.repository];
      let output = '';
      await runner([...prefix, 'backup', '--json', '--tag', `recovery-set:${manifest.setId}`,
        ...target.domains.flatMap((domain) => ['--tag', `domain:${domain}`]), '--',
        ...expectations.map((entry) => join(evidence.directory, entry.path))], environment, (bytes) => {
        output += Buffer.from(bytes).toString('utf8');
        if (output.length > 4 * 1024 * 1024) throw new Error('RECOVERY_RESTIC_RECEIPT_TOO_LARGE');
      });
      await verifyLocalInventory();
      let snapshotId: string | undefined;
      for (const line of output.split('\n').filter(Boolean)) {
        const event: unknown = JSON.parse(line);
        if (event && typeof event === 'object' && 'message_type' in event && event.message_type === 'summary'
          && 'snapshot_id' in event && typeof event.snapshot_id === 'string') snapshotId = event.snapshot_id;
      }
      if (!snapshotId || !/^[a-f0-9]{64}$/.test(snapshotId)) throw new Error('RECOVERY_RESTIC_SNAPSHOT_UNCONFIRMED');
      await runner([...prefix, 'check', '--read-data'], environment, () => undefined);
      for (const expected of expectations) {
        const hash = createHash('sha256');
        let length = 0;
        await runner([...prefix, 'dump', snapshotId, join(evidence.directory, expected.path)], environment, (bytes) => {
          length += bytes.length;
          if (length > expected.bytes) throw new Error('RECOVERY_RESTIC_READBACK_MISMATCH');
          hash.update(bytes);
        });
        if (length !== expected.bytes || hash.digest('hex') !== expected.hash) throw new Error('RECOVERY_RESTIC_READBACK_MISMATCH');
      }
      const verifiedAt = (options.now ?? (() => new Date()))().toISOString();
      await verifyLocalInventory();
      recoverySetEvidence(set);
      return {
        encrypted: true, offHost: true, verified: true, domains: [...target.domains], targetId: target.targetId,
        snapshotId, recoveryCredentialRef: target.recoveryCredentialRef,
        verifiedAt, manifestHash: evidence.manifestHash,
      };
    },
  };
}

function nativeResticRunner(executable: string): RecoveryResticRunner {
  return async (args, environment, emit) => new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      env: { PATH: process.env.PATH, LANG: 'C', ...environment }, stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15 * 60 * 1000,
    });
    let outputFailed = false;
    child.stdout.on('data', (bytes: Buffer) => {
      try { emit(bytes); } catch (error) { outputFailed = true; child.kill('SIGKILL'); reject(error); }
    });
    child.once('error', () => reject(new Error('RECOVERY_RESTIC_COMMAND_FAILED')));
    child.once('close', (code) => {
      if (outputFailed) return;
      if (code === 0) resolve();
      else reject(new Error('RECOVERY_RESTIC_COMMAND_FAILED'));
    });
  });
}
