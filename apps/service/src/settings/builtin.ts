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

type Input = { db: SqliteDatabase; credentials: CredentialStore; now: () => Date; hub: () => LocalHubPort; host?: string };
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
  const { db, credentials, now, hub } = options;
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

  function channelFor(principal: Principal, draft: SettingsDraft) {
    if (draft.input !== null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'settings_input' });
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
  return { connect_vault: existingVault, enable_feishu: enabledChannel, disable_feishu: disabledChannel };
}

function denied(): never {
  throw new ApiError(403, 'FORBIDDEN', { reason: 'settings_target' });
}
