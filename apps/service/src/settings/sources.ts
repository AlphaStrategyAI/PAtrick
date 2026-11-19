import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { canonicalPayload, sourcePreviewSchema, type Json } from '@patrick/contracts';
import type { CredentialStore } from '@patrick/host';
import { httpFrequencies, type HttpBaselineEntry, type HttpSourceOperation, type SourceDraft, type SourceRegistry } from '@patrick/integrations/sources/registry';
import type { SqliteDatabase } from '@patrick/storage';
import { assertDomainPermission, type Principal } from '../auth.js';
import { ApiError } from '../errors.js';
import { assertSettingsControl } from './authority.js';
import { SettingsApplyBlocked, type SettingsDraft, type SettingsHandler } from './changes.js';

type Options = { db: SqliteDatabase; credentials: CredentialStore; now: () => Date; registry: SourceRegistry };

export function sourceSettingsHandlers({ db, credentials, now, registry }: Options): Record<string, SettingsHandler> {
  const deviceId = hostname();
  const hash = (value: Json) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
  const actor = (principal: Principal, domain: string) => ({ accountId: principal.account_id, dataDomain: domain });
  const authorize: SettingsHandler['authorize'] = (principal, draft, proof, receiptId) =>
    assertSettingsControl(db, credentials, principal, now(), receiptId,
      { operation: draft.operation, target: draft.target, domain: draft.domain, draftHash: proof.draft_hash,
        validationId: proof.validation_id, objectRevision: proof.base_revision });

  function frequency(input: Json): string {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 ||
        typeof input.frequency !== 'string' || !httpFrequencies.some((value) => value === input.frequency)) invalid();
    return input.frequency;
  }

  function fromPreview(principal: Principal, draft: SettingsDraft) {
    assertDomainPermission(db, principal, draft.domain, 'sources.detect');
    const row = db.prepare(`SELECT p.snapshot,p.baseline FROM source_preview_receipts p JOIN command_records c USING(command_id)
      WHERE p.command_id=? AND c.account_id=? AND c.caller_id=? AND c.data_domain=? AND c.operation='detectSources'`)
      .get(draft.target, principal.account_id, principal.caller_id, draft.domain) as { snapshot: string; baseline: string } | undefined;
    if (!row) forbidden();
    const saved = JSON.parse(row.snapshot) as { scope: { permission_epoch: number }; data: unknown };
    const preview = sourcePreviewSchema.parse(saved.data);
    if (saved.scope.permission_epoch !== principal.auth_epoch || preview.expires_at <= now().toISOString()) stale();
    const owner = actor(principal, draft.domain);
    const original: SourceDraft = { type: preview.type, target: preview.target };
    const checked = checkedSource(() => registry.inspectHttpDraft(owner, original));
    if (checked.draftHash !== preview.draft_hash || checked.sourceId !== preview.duplicate_source_id) stale();
    const configured = { ...original, frequency: frequency(draft.input) };
    const change = checkedSource(() => registry.inspectHttpDraft(owner, configured));
    return { owner, configured, change, baseline: JSON.parse(row.baseline) as HttpBaselineEntry[] };
  }

  const enable: SettingsHandler = {
    binding(principal, draft) {
      const { change, baseline } = fromPreview(principal, draft);
      return { revision: change.revision, deviceId, identityId: change.sourceId ?? draft.target,
        scopeHash: hash([change.draftHash, draft.target, baseline]) };
    },
    async validate(principal, draft) { fromPreview(principal, draft); return { valid: true }; },
    authorize,
    async apply(principal, draft, proof, beforeWrite) {
      try {
        const { owner, configured, change, baseline } = fromPreview(principal, draft);
        if (change.revision !== proof.base_revision) stale();
        const receipt = await registry.enableSource(owner, configured, { draftHash: change.draftHash, httpBaseline: baseline, beforeWrite });
        const revision = change.revision || receipt.configRevision;
        return { revision, effects: [{ item: 'source_enable', outcome: change.sourceId ? 'unchanged' : 'applied', revision }] };
      } catch (error) { return blockedChange(error); }
    },
    async recheck(principal, draft, applied) {
      // Enabling a new source changes duplicate identity, so read the saved preview and the resulting config separately.
      const row = db.prepare(`SELECT s.config_revision FROM source_configs s JOIN source_preview_receipts p ON p.command_id=?
        JOIN command_records c ON c.command_id=p.command_id AND c.account_id=s.account_id AND c.data_domain=s.data_domain
        WHERE s.account_id=? AND s.data_domain=? AND c.caller_id=?
        AND s.normalized_target=json_extract(p.snapshot,'$.data.target')
        AND s.connector_type=json_extract(p.snapshot,'$.data.type')`).get(draft.target, principal.account_id, draft.domain, principal.caller_id) as
        { config_revision: number } | undefined;
      const verified = !!row && row.config_revision === applied.revision;
      return { verified, ...(!verified ? { issue: 'source_recheck' } : {}) };
    },
  };

  function existing(principal: Principal, draft: SettingsDraft, operation: HttpSourceOperation) {
    const owner = actor(principal, draft.domain);
    if (operation !== 'modify' && draft.input !== null) invalid();
    const nextFrequency = operation === 'modify' ? frequency(draft.input) : undefined;
    const source = checkedSource(() => registry.describeHttpSource(owner, draft.target));
    return { source, owner, nextFrequency };
  }

  function handlerFor(operation: HttpSourceOperation): SettingsHandler {
    return {
      binding(principal, draft) {
        const { source } = existing(principal, draft, operation);
        return { revision: source.revision, deviceId, identityId: draft.target, scopeHash: source.binding };
      },
      async validate(principal, draft) {
        const { source } = existing(principal, draft, operation);
        return { valid: source.status !== 'disconnected' };
      },
      authorize,
      async apply(principal, draft, proof, beforeWrite) {
        try {
          const { owner, nextFrequency } = existing(principal, draft, operation);
          const result = registry.changeHttpSource(owner, draft.target, operation, proof.base_revision, nextFrequency, beforeWrite);
          return { revision: result.revision, effects: [{ item: 'source_' + operation,
            outcome: result.changed ? 'applied' : 'unchanged', revision: result.revision }] };
        } catch (error) { return blockedChange(error); }
      },
      async recheck(principal, draft, applied) {
        const { source } = existing(principal, draft, operation);
        const expected = operation === 'pause' ? 'paused' : operation === 'resume' ? 'enabled' : 'disconnected';
        const verified = source.revision === applied.revision &&
          (operation === 'modify' ? source.frequency === frequency(draft.input) : source.status === expected);
        return { verified, ...(!verified ? { issue: 'source_recheck' } : {}) };
      },
    };
  }

  function historyInput(principal: Principal, draft: SettingsDraft) {
    const input = draft.input;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 ||
        typeof input.plan_hash !== 'string' || !/^[a-f0-9]{64}$/u.test(input.plan_hash)) invalid();
    return { actor: { ...actor(principal, draft.domain), callerId: principal.caller_id, authEpoch: principal.auth_epoch },
      planHash: input.plan_hash };
  }

  /** Adds a GitHub source over the live API.
   *
   * The token itself is staged by the credential endpoint and never travels
   * through the draft; only the reference does. The validation reads the
   * approved branch, so an unusable token or an unreachable branch is refused
   * before anything is written.
   */
  const enableGithub: SettingsHandler = {
    binding(principal, draft) {
      const input = githubInput(draft);
      return { revision: 0, deviceId, identityId: draft.target,
        scopeHash: hash([principal.account_id, draft.target, input.credential_ref, input.repo, input.branch, input.path]) };
    },
    async validate(principal, draft) {
      const input = githubInput(draft);
      try {
        await registry.detectSource(actor(principal, draft.domain), githubDraft(input));
        return { valid: true };
      } catch {
        return { valid: false };
      }
    },
    authorize,
    async apply(principal, draft, _proof, beforeWrite) {
      const input = githubInput(draft);
      const owner = actor(principal, draft.domain);
      const sourceDraft = githubDraft(input);
      const preview = await registry.detectSource(owner, sourceDraft);
      const receipt = await registry.enableSource(owner, sourceDraft, { draftHash: preview.draftHash, beforeWrite });
      return { revision: receipt.configRevision,
        effects: [{ item: 'source_enable', outcome: 'applied', revision: receipt.configRevision }] };
    },
    async recheck(principal, draft, applied) {
      const input = githubInput(draft);
      const row = db.prepare(`SELECT config_revision FROM source_configs
        WHERE account_id=? AND data_domain=? AND normalized_target=?`).get(
        principal.account_id, draft.domain, githubTarget(input)) as { config_revision: number } | undefined;
      const verified = row?.config_revision === applied.revision;
      return { verified, ...(!verified ? { issue: 'source_recheck' } : {}) };
    },
  };

  const history: SettingsHandler = {
    binding(principal, draft) {
      const { actor, planHash } = historyInput(principal, draft);
      const proof = checkedSource(() => registry.inspectRssHistory(actor, draft.target, planHash));
      return { revision: proof.revision, deviceId, identityId: draft.target,
        scopeHash: hash([proof.planHash, proof.expiresAt]) };
    },
    async validate(principal, draft) {
      const { actor, planHash } = historyInput(principal, draft);
      await registry.validateRssHistory(actor, draft.target, planHash).catch(throwSourceError);
      return { valid: true };
    },
    authorize,
    async apply(principal, draft, proof, beforeWrite) {
      try {
        const { actor, planHash } = historyInput(principal, draft);
        const result = await registry.importRssHistory(actor, draft.target, planHash, proof.base_revision, beforeWrite);
        return { revision: proof.base_revision, effects: [{ item: 'source_history_import',
          outcome: result.created && result.receipt.imported_objects > 0 ? 'applied' : 'unchanged', revision: proof.base_revision }] };
      } catch (error) { return blockedChange(error); }
    },
    async recheck(principal, draft, applied) {
      const { actor, planHash } = historyInput(principal, draft);
      const plan = checkedSource(() => registry.readRssHistory(actor, draft.target));
      const verified = plan.plan_hash === planHash && plan.config_revision === applied.revision &&
        plan.state === 'applied' && plan.receipt !== null;
      return { verified, ...(!verified ? { issue: 'source_history_recheck' } : {}) };
    },
  };

  return { enable_http_source: enable, modify_http_source: handlerFor('modify'), pause_http_source: handlerFor('pause'),
    resume_http_source: handlerFor('resume'), disconnect_http_source: handlerFor('disconnect'), import_rss_history: history,
    enable_github_source: enableGithub };
}

type GithubInput = { credential_ref: string; repo: string; branch: string; path: string };

function githubInput(draft: SettingsDraft): GithubInput {
  const input = draft.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== 4) invalid();
  for (const key of ['credential_ref', 'repo', 'branch', 'path'] as const) {
    if (typeof record[key] !== 'string' || !(record[key] as string).trim()) invalid();
  }
  return {
    credential_ref: record.credential_ref as string,
    repo: record.repo as string,
    branch: record.branch as string,
    path: record.path as string,
  };
}

function githubTarget(input: GithubInput): string {
  return `github://${input.repo}@${input.branch}/${input.path}`;
}

function githubDraft(input: GithubInput) {
  return {
    type: 'github' as const,
    target: githubTarget(input),
    repo: input.repo,
    branch: input.branch,
    path: input.path,
    credentialRef: input.credential_ref,
    frequency: 'poll' as const,
    history: 'none' as const,
  };
}

function checkedSource<T>(read: () => T): T {
  try { return read(); } catch (error) { return throwSourceError(error); }
}

function throwSourceError(error: unknown): never {
  if (!(error instanceof Error)) throw error;
  if (['SOURCE_NOT_FOUND', 'SOURCE_TARGET_OUTSIDE_SCOPE', 'SOURCE_ROOT_TAKEN'].includes(error.message)) forbidden();
  if (['SOURCE_HTTP_SCOPE_INVALID', 'SOURCE_URL_INVALID', 'SOURCE_FREQUENCY_INVALID'].includes(error.message)) invalid();
  if (['SOURCE_HISTORY_STALE', 'SOURCE_HISTORY_EVIDENCE_REQUIRED', 'SOURCE_HISTORY_BUDGET_EXCEEDED',
    'SOURCE_HISTORY_INVALID'].includes(error.message)) stale();
  throw error;
}

function blockedChange(error: unknown): never {
  if (error instanceof ApiError || (error instanceof Error &&
      ['SOURCE_TARGET_OUTSIDE_SCOPE', 'SOURCE_ROOT_TAKEN', 'SOURCE_REVISION_CONFLICT', 'SOURCE_DISCONNECTED',
        'SOURCE_HISTORY_STALE', 'SOURCE_HISTORY_EVIDENCE_REQUIRED', 'SOURCE_HISTORY_BUDGET_EXCEEDED',
        'SOURCE_HISTORY_INVALID'].includes(error.message))) {
    throw new SettingsApplyBlocked('source_binding_changed');
  }
  throw error;
}

function invalid(): never { throw new ApiError(422, 'UNPROCESSABLE', { reason: 'source_settings_input' }); }
function forbidden(): never { throw new ApiError(403, 'FORBIDDEN', { reason: 'source_settings_scope' }); }
function stale(): never { throw new ApiError(409, 'VALIDATION_STALE', { reason: 'source_preview_changed' }); }
