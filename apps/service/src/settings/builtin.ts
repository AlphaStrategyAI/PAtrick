import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { canonicalPayload, type Json } from '@patrick/contracts';
import { encodeHubAnswer, type LocalHubPort } from '@patrick/integrations/autoloop/answers';
import { confirmVault, inspectVault, loadVault, probeVaultConfirmation, VaultConfirmationBlocked } from '@patrick/integrations/vault/connection';
import { createFeishuChannel } from '../../../../packages/integrations/feishu/connection.js';
import type { CredentialStore } from '@patrick/host';
import type { SqliteDatabase } from '@patrick/storage';
import type { Principal } from '../auth.js';
import { ApiError } from '../errors.js';
import { assertSettingsControl } from './authority.js';
import { SettingsApplyBlocked, type SettingsDraft, type SettingsHandler } from './changes.js';

type Input = { db: SqliteDatabase; credentials: CredentialStore; now: () => Date; hub: () => LocalHubPort; host?: string;
  /** The provider that holds the Feishu app secret; the session store is not one. */
  feishuCredentials?: CredentialStore };
type VaultClient = { device_id: string; mapping_revision: number };
type Channel = { connection_id: string; status: string; transport_mode: string; config_revision: number; binding_revision: number;
  app_id: string; tenant_key: string; credential_ref: string; owner_open_id: string | null; chat_id: string | null;
  credential_version: number; channel_incarnation: number; connection_epoch: number; current_test_id: string | null;
  verified_hash: string | null; test_binding_id: string | null; test_message_id: string | null; test_inbound_evidence: string | null };
const hash = (value: Json) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
const device = (value: Json): string => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 ||
      typeof value.device_id !== 'string' || !value.device_id || value.device_id.length > 160) {
    throw new ApiError(422, 'UNPROCESSABLE', { reason: 'settings_input' });
  }
  return value.device_id;
};

export function builtinSettingsHandlers(options: Input): Record<string, SettingsHandler> {
  const { db, credentials, now, hub, feishuCredentials } = options;
  const host = options.host ?? hostname();
  const authorize: SettingsHandler['authorize'] = (principal, draft, proof, receiptId) => assertSettingsControl(
    db, credentials, principal, now(), receiptId,
    { operation: draft.operation, target: draft.target, domain: draft.domain, draftHash: proof.draft_hash,
      validationId: proof.validation_id, objectRevision: proof.base_revision },
  );

  function vaultFor(principal: Principal, draft: SettingsDraft) {
    const id = device(draft.input);
    const record = loadVault(db, draft.target);
    if (!record || record.account_id !== principal.account_id || record.data_domain !== draft.domain || record.capture_host !== host) denied();
    const client = db.prepare('SELECT device_id,mapping_revision FROM vault_clients WHERE vault_id=? AND device_id=?')
      .get(draft.target, id) as VaultClient | undefined;
    if (!client) denied();
    return { record, client };
  }
  const existingVault: SettingsHandler = {
    binding(principal, draft) {
      const { record, client } = vaultFor(principal, draft);
      return { revision: record.config_revision, deviceId: client.device_id, identityId: host,
        scopeHash: hash([record.scope_hash, record.root_identity, record.connection_epoch, record.status, client.mapping_revision]) };
    },
    async validate(principal, draft) {
      const { record } = vaultFor(principal, draft);
      return { valid: await probeVaultConfirmation(record) };
    },
    authorize,
    async apply(principal, draft, proof, beforeWrite) {
      const { record, client } = vaultFor(principal, draft);
      if (record.config_revision !== proof.base_revision || record.status !== 'awaiting_confirmation') {
        throw new SettingsApplyBlocked('confirmation_changed');
      }
      try { await confirmVault(db, client.device_id, record.vault_id, now().toISOString(), { beforeWrite }); }
      catch (error) {
        if (error instanceof VaultConfirmationBlocked) throw new SettingsApplyBlocked(error.reason);
        throw error;
      }
      return { revision: record.config_revision, effects: [{ item: 'vault_connection', outcome: 'applied', revision: record.config_revision }] };
    },
    async recheck(principal, draft) {
      const { record, client } = vaultFor(principal, draft);
      const check = await inspectVault(db, client.device_id, record.vault_id);
      const verified = check.status === 'connected' && check.collection_status === 'ready';
      return { verified, ...(!verified ? { issue: 'vault_recheck' } : {}) };
    },
  };

  function channelFor(principal: Principal, draft: SettingsDraft, allowInput = false) {
    if (!allowInput && draft.input !== null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'settings_input' });
    const row = db.prepare(`SELECT c.connection_id,c.status,c.transport_mode,c.config_revision,c.binding_revision,c.credential_version,
      c.app_id,c.tenant_key,c.credential_ref,c.owner_open_id,c.chat_id,c.channel_incarnation,c.connection_epoch,c.current_test_id,
      t.binding_id AS test_binding_id,t.message_id AS test_message_id,t.inbound_evidence AS test_inbound_evidence,
      CASE WHEN t.status='verified' THEN t.preview_hash ELSE NULL END AS verified_hash
      FROM channel_connections c LEFT JOIN channel_tests t ON t.test_id=c.current_test_id
        AND t.connection_id=c.connection_id AND t.account_id=c.account_id AND t.data_domain=c.data_domain
      WHERE c.connection_id=? AND c.account_id=? AND c.data_domain=?`).get(draft.target, principal.account_id, draft.domain) as Channel | undefined;
    if (!row) denied();
    return row;
  }
  const enabledChannel: SettingsHandler = {
    binding(principal, draft) {
      const row = channelFor(principal, draft);
      return { revision: row.config_revision, deviceId: host, identityId: row.connection_id,
        scopeHash: hash([row.binding_revision, row.credential_version, row.channel_incarnation, row.connection_epoch,
          row.app_id, row.tenant_key, row.credential_ref, row.owner_open_id, row.chat_id, row.status, row.transport_mode,
          row.current_test_id, row.verified_hash, row.test_binding_id, row.test_message_id, row.test_inbound_evidence]) };
    },
    async validate(principal, draft) {
      const row = channelFor(principal, draft);
      return { valid: row.status === 'needs_enable' && row.verified_hash !== null };
    },
    authorize,
    async apply(principal, draft, proof, beforeWrite) {
      const row = channelFor(principal, draft);
      if (row.config_revision !== proof.base_revision || row.status !== 'needs_enable' || !row.verified_hash || !row.current_test_id) {
        throw new SettingsApplyBlocked('confirmation_changed');
      }
      const endpoint = createFeishuChannel(db, { domain: draft.domain, connectionId: row.connection_id, now, hub: hub(), encode: encodeHubAnswer });
      await endpoint.applyTrustedEnable({ connection_id: row.connection_id, account_id: principal.account_id, test_id: row.current_test_id,
        preview_hash: row.verified_hash, binding_revision: row.binding_revision, config_revision: row.config_revision,
        credential_version: row.credential_version, incarnation: row.channel_incarnation, epoch: row.connection_epoch }, { beforeWrite });
      return { revision: row.config_revision, effects: [{ item: 'feishu_mode', outcome: 'applied', revision: row.config_revision }] };
    },
    async recheck(principal, draft) {
      const verified = channelFor(principal, draft).status === 'ready';
      return { verified, ...(!verified ? { issue: 'feishu_recheck' } : {}) };
    },
  };
  const disabledChannel: SettingsHandler = {
    binding: enabledChannel.binding,
    async validate(principal, draft) {
      return { valid: channelFor(principal, draft).status === 'ready' };
    },
    authorize,
    async apply(principal, draft, proof, beforeWrite) {
      const row = channelFor(principal, draft);
      if (row.config_revision !== proof.base_revision || row.status !== 'ready') throw new SettingsApplyBlocked('confirmation_changed');
      const endpoint = createFeishuChannel(db, { domain: draft.domain, connectionId: row.connection_id, now, hub: hub(), encode: encodeHubAnswer });
      const result = await endpoint.disableTrusted({ accountId: principal.account_id, configRevision: row.config_revision,
        epoch: row.connection_epoch }, { beforeWrite });
      return { revision: result.epoch, effects: [{ item: result.status === 'draining' ? 'feishu_draining' : 'feishu_disabled',
        outcome: 'applied', revision: result.epoch }] };
    },
    async recheck(principal, draft, applied) {
      const row = channelFor(principal, draft);
      const blocked = row.connection_epoch !== applied.revision || (row.status !== 'disabled' && row.status !== 'draining');
      return { verified: !blocked, ...(blocked ? { issue: 'feishu_recheck' } : {}) };
    },
  };
  const reboundChannel: SettingsHandler = {
    binding: enabledChannel.binding,
    async validate(principal, draft) {
      const row = channelFor(principal, draft);
      return { valid: row.status !== 'draining' && row.transport_mode !== 'draining' };
    },
    authorize,
    async apply(principal, draft, proof, beforeWrite) {
      const row = channelFor(principal, draft);
      if (row.config_revision !== proof.base_revision) throw new SettingsApplyBlocked('confirmation_changed');
      const endpoint = createFeishuChannel(db, { domain: draft.domain, connectionId: row.connection_id, now, hub: hub(), encode: encodeHubAnswer });
      if (row.status === 'ready' && row.transport_mode === 'active') {
        // An active connection is drained before it is rebound, so no answer is
        // accepted under the old binding once the new one starts.
        const result = await endpoint.disableTrusted({ accountId: principal.account_id, configRevision: row.config_revision,
          epoch: row.connection_epoch }, { beforeWrite });
        if (result.status === 'draining') {
          return { revision: result.epoch, effects: [{ item: 'feishu_draining', outcome: 'applied', revision: result.epoch }] };
        }
      }
      endpoint.configure();
      return { revision: row.config_revision, effects: [{ item: 'feishu_rebind', outcome: 'applied', revision: row.config_revision }] };
    },
    async recheck(principal, draft) {
      const row = channelFor(principal, draft);
      const verified = row.status === 'needs_binding' || row.status === 'draining';
      return { verified, ...(!verified ? { issue: 'feishu_recheck' } : {}) };
    },
  };

  /** Rotates the credential of an existing connection.
   *
   * The candidate secret is staged by the dedicated credential endpoint and
   * never travels through a setting draft. The rotation drains an active
   * connection first, swaps the credential, and clears the binding so the old
   * pairing and test receipts cannot make the new configuration ready.
   */
  const rotatedChannel: SettingsHandler = {
    binding(principal, draft) {
      const row = channelFor(principal, draft, true);
      const candidate = candidateCredential(draft);
      return { revision: row.config_revision, deviceId: host, identityId: row.connection_id,
        scopeHash: hash([row.credential_version, row.binding_revision, row.channel_incarnation,
          row.connection_epoch, row.app_id, candidate]) };
    },
    async validate(principal, draft) {
      channelFor(principal, draft, true);
      const candidate = candidateCredential(draft);
      if (!feishuCredentials) return { valid: false };
      // The candidate must still resolve: a staged secret that expired cannot be
      // proven and must not be swapped in.
      return { valid: feishuCredentials.resolve(candidate) !== null };
    },
    authorize,
    async apply(principal, draft, proof, beforeWrite) {
      const row = channelFor(principal, draft, true);
      const candidate = candidateCredential(draft);
      if (row.config_revision !== proof.base_revision) throw new SettingsApplyBlocked('confirmation_changed');
      if (!feishuCredentials || feishuCredentials.resolve(candidate) === null) {
        throw new SettingsApplyBlocked('candidate_credential_unavailable');
      }
      const endpoint = createFeishuChannel(db, { domain: draft.domain, connectionId: row.connection_id, now, hub: hub(), encode: encodeHubAnswer });
      let drained = false;
      if (row.status === 'ready' && row.transport_mode === 'active') {
        const result = await endpoint.disableTrusted({ accountId: principal.account_id, configRevision: row.config_revision,
          epoch: row.connection_epoch }, { beforeWrite });
        if (result.status === 'draining') {
          return { revision: result.epoch, effects: [{ item: 'feishu_draining', outcome: 'applied', revision: result.epoch }] };
        }
        drained = true;
      }
      const stamped = beforeWrite();
      const current = channelFor(principal, draft, true);
      if (current.config_revision !== row.config_revision || current.credential_version !== row.credential_version) {
        throw new SettingsApplyBlocked('confirmation_changed');
      }
      const next = current.config_revision + 1;
      // The drain already fenced the old permits with its own epoch; without one the
      // rotation has to move the epoch itself so the old permits stop counting.
      const epoch = drained ? current.connection_epoch : current.connection_epoch + 1;
      const updated = db.prepare(`UPDATE channel_connections SET credential_ref=?, credential_version=?, config_revision=?,
        binding_revision=?, channel_incarnation=?, connection_epoch=?, status='needs_binding', transport_mode='probe',
        reason_code='CREDENTIAL_ROTATED', current_pairing_id=NULL, current_test_id=NULL, owner_open_id=NULL, chat_id=NULL,
        cutoff_seq=NULL, updated_at=? WHERE connection_id=? AND config_revision=? AND credential_version=?`).run(
        candidate, current.credential_version + 1, next, current.binding_revision + 1, current.channel_incarnation + 1,
        epoch, stamped, current.connection_id, current.config_revision, current.credential_version);
      if (updated.changes !== 1) throw new SettingsApplyBlocked('confirmation_changed');
      db.prepare(`INSERT INTO channel_receipts(receipt_id,connection_id,kind,status,created_at) VALUES (?,?,'rotate','applied',?)`)
        .run(`ch_${hash([current.connection_id, 'rotate', next]).slice(0, 16)}`, current.connection_id, stamped);
      return { revision: next, effects: [{ item: 'feishu_credential', outcome: 'applied', revision: next }] };
    },
    async recheck(principal, draft, applied) {
      const row = channelFor(principal, draft, true);
      const verified = row.config_revision === applied.revision && row.status === 'needs_binding';
      return { verified, ...(!verified ? { issue: 'feishu_recheck' } : {}) };
    },
  };
  return { connect_vault: existingVault, enable_feishu: enabledChannel, disable_feishu: disabledChannel,
    rebind_feishu: reboundChannel, rotate_feishu_credential: rotatedChannel };
}

function denied(): never {
  throw new ApiError(403, 'FORBIDDEN', { reason: 'settings_target' });
}

/** Reads the staged candidate credential reference out of a draft.
 *
 * The secret itself never travels through a setting draft; only the reference
 * the dedicated credential endpoint handed back does.
 */
function candidateCredential(draft: SettingsDraft): string {
  const input = draft.input;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 ||
      typeof (input as { credential_ref?: unknown }).credential_ref !== 'string') {
    throw new ApiError(422, 'UNPROCESSABLE', { reason: 'settings_draft' });
  }
  const reference = (input as { credential_ref: string }).credential_ref;
  if (!/^cred_[A-Za-z0-9_-]+$/u.test(reference)) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'settings_draft' });
  return reference;
}
