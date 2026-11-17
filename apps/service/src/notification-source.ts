import { createHash } from 'node:crypto';
import { HUB_CURSOR } from '@patrick/integrations/autoloop/observer';
import { canonicalPayload, preferencePayload } from '@patrick/contracts';
import { appendDomainEvent, assertRecoveryWriteAllowed, recoveryWriteAllowed, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import type { NotificationIntent, NotificationSubject, QuietPreferences } from '../../../packages/domain/src/notifications.js';
import type { AdmissionPrincipal } from '../../../packages/domain/src/delegation.js';

type WorkState = 'researching' | 'awaiting_answer' | 'verifying' | 'paused' | 'blocked' | 'delivered';
type Destination = { connection_id: string; binding_id: string; owner_open_id: string; chat_id: string;
  tenant_key: string; app_id: string; credential_ref: string; credential_version: number; config_revision: number;
  channel_incarnation: number; connection_epoch: number; binding_revision: number };
type Options = { now: () => Date; timezone: string; credentialUsable(ref: string): boolean };
type BlockerRequirement = { factId: string; domain: string; workId: string; generation: number;
  workRevision: number; viewRevision: number; policyRevision: number; needsOwner: boolean;
  reason: 'owner_input_required' | 'owner_authorization_required' | null };
const checkpointAgeMs = 60_000;
type PrBlocker = { intent_id: string; receipt_updated_at: string; reason_code: string; caller_id: string;
  generation: number; work_revision: number; view_revision: number; auth_epoch: number; policy_revision: number;
  grant_id: string; attempt_id: string; source_revision_id: string; source_config_revision: number; basis_hash: string };
const sourceHash = (source: PrBlocker) => createHash('sha256').update(canonicalPayload(source)).digest('hex');

function currentPrBlocker(db: SqliteDatabase, accountId: string, domain: string, workId: string, at: Date): PrBlocker | undefined {
  return db.prepare(`SELECT i.intent_id,r.updated_at AS receipt_updated_at,r.reason AS reason_code,x.caller_id,
      g.generation,g.revision AS work_revision,v.revision AS view_revision,a.auth_epoch,a.policy_revision,
      x.grant_id,x.attempt_id,b.source_revision_id,b.source_config_revision,b.basis_hash
    FROM effect_intents i JOIN effect_receipts r ON r.intent_id=i.intent_id AND r.status='conflict'
      AND r.reason IN ('fixed_branch_conflict','fixed_branch_changed_at_pr_send',
        'approved_patch_conflicts_with_base','branch_contains_unrelated_changes')
      AND r.updated_at>=i.created_at AND r.updated_at<=@at
    JOIN work_generations g ON g.work_id=i.work_id AND g.generation=i.generation
      AND g.account_id=i.account_id AND g.data_domain=i.data_domain
      AND g.generation=(SELECT MAX(generation) FROM work_generations WHERE work_id=g.work_id)
      AND g.control_state='running' AND g.attempt_closed=0 AND g.awaiting_answer=0
      AND g.phase='delivery' AND g.next_action='publish_pr' AND g.evidence_ready=1
    JOIN accounts a ON a.account_id=i.account_id AND a.auth_epoch=i.authorization_epoch
    JOIN execution_grants x ON x.grant_id=i.authorization_ref AND x.account_id=i.account_id AND x.data_domain=i.data_domain
      AND x.work_id=i.work_id AND x.generation=i.generation AND x.subject_kind='work'
      AND x.attempt_id=g.current_attempt_id AND x.mandate_id=g.mandate_id
      AND x.phase='delivery' AND x.next_action='publish_pr' AND x.revoked_at IS NULL
    JOIN caller_scopes s ON s.account_id=a.account_id AND s.data_domain=i.data_domain AND s.caller_id=x.caller_id
      AND s.permission='owner' AND s.revoked_at IS NULL
    JOIN work_pr_builds b ON b.build_id=i.build_id AND b.work_id=i.work_id AND b.generation=i.generation
      AND b.grant_id=x.grant_id AND b.attempt_id=x.attempt_id AND b.repo_id=i.repo_id AND b.base_ref=i.base_ref
    JOIN judgment_bases j ON j.work_id=g.work_id AND j.generation=g.generation AND j.account_id=g.account_id
      AND j.data_domain=g.data_domain AND j.basis_hash=b.basis_hash
    JOIN source_revisions sr ON sr.revision_id=b.source_revision_id AND sr.account_id=g.account_id
      AND sr.data_domain=g.data_domain AND sr.content_hash=b.source_hash AND sr.tombstone=0
      AND g.root_id='work:' || sr.revision_id
    JOIN source_objects so ON so.source_id=sr.source_id AND so.object_id=sr.object_id AND so.observed_seq=sr.observed_seq AND so.tombstone=0
    JOIN source_configs sc ON sc.source_id=sr.source_id AND sc.account_id=g.account_id AND sc.data_domain=g.data_domain
      AND sc.enabled=1 AND sc.config_revision=b.source_config_revision
    JOIN product_work_views v ON v.account_id=g.account_id AND v.data_domain=g.data_domain AND v.work_id=g.work_id
      AND v.visible=1 AND v.state='blocked' AND json_extract(v.payload,'$.generation')=g.generation
    JOIN product_view_checkpoints cp ON cp.account_id=g.account_id AND cp.data_domain=g.data_domain AND cp.freshness='fresh'
      AND cp.domain_seq>=(SELECT COALESCE(MAX(seq),0) FROM domain_events WHERE account_id=g.account_id AND data_domain=g.data_domain)
    JOIN hub_snapshots h ON h.cursor_name=@cursor AND h.hub_seq=cp.hub_seq
      AND h.imported_at<=@at AND h.imported_at>=@freshAfter
    JOIN projection_cursors c ON c.name=h.cursor_name AND c.hub_seq=h.hub_seq
    WHERE i.account_id=@account AND i.data_domain=@domain AND i.work_id=@work AND i.origin='business'
      AND i.action='publish_pr' AND i.schema_version LIKE '1.%'`)
    .get({ account: accountId, domain, work: workId, cursor: HUB_CURSOR,
      at: at.toISOString(), freshAfter: new Date(+at - checkpointAgeMs).toISOString() }) as PrBlocker | undefined;
}

export function publishPrOwnerBlockerRequirement(db: SqliteDatabase, accountId: string, domain: string, workId: string, at: Date) {
  return withImmediateTransaction(db, () => {
    if (!recoveryWriteAllowed(db, domain)) return null;
    const source = currentPrBlocker(db, accountId, domain, workId, at);
    if (!source) return null;
    const cleared = db.prepare(`SELECT 1 FROM domain_events e WHERE e.account_id=? AND e.data_domain=? AND e.aggregate_id=?
      AND json_extract(e.payload,'$.type')='notification.blocker.requirement'
      AND e.seq=(SELECT MAX(seq) FROM domain_events WHERE account_id=e.account_id AND data_domain=e.data_domain
        AND aggregate_id=e.aggregate_id AND json_extract(payload,'$.type')='notification.blocker.requirement')
      AND json_type(e.payload,'$.needs_owner')='false' AND json_extract(e.payload,'$.generation')=?
      AND json_extract(e.payload,'$.work_revision')=? AND json_extract(e.payload,'$.view_revision')=?
      AND json_extract(e.payload,'$.auth_epoch')=? AND json_extract(e.payload,'$.policy_revision')=?
      AND json_extract(e.payload,'$.observed_at')>=? AND json_extract(e.payload,'$.observed_at')<=?`)
      .get(accountId, domain, workId, source.generation, source.work_revision, source.view_revision,
        source.auth_epoch, source.policy_revision, source.receipt_updated_at, at.toISOString());
    if (cleared) return null;
    return recordOwnerBlockerRequirement(db, { account_id: accountId, caller_id: source.caller_id, auth_epoch: source.auth_epoch,
      domains: [domain], operations: ['owner'] }, {
      factId: 'pr-conflict:' + sourceHash(source), domain, workId, generation: source.generation,
      workRevision: source.work_revision, viewRevision: source.view_revision, policyRevision: source.policy_revision,
      needsOwner: true, reason: 'owner_input_required',
    }, at, source);
  });
}

export function recordOwnerBlockerRequirement(db: SqliteDatabase, principal: AdmissionPrincipal, input: BlockerRequirement, at: Date, source?: PrBlocker) {
  if (!input.factId || input.factId.length > 160 || !principal.domains.includes(input.domain) || !principal.operations.includes('owner') ||
      typeof input.needsOwner !== 'boolean' || (input.needsOwner
        ? !['owner_input_required', 'owner_authorization_required'].includes(input.reason ?? '') : input.reason !== null)) {
    throw new Error('NOTIFICATION_BLOCKER_FACT_INVALID');
  }
  return withImmediateTransaction(db, () => {
    assertRecoveryWriteAllowed(db, input.domain);
    const current = db.prepare(`SELECT a.auth_epoch,a.policy_revision,g.generation,g.revision AS work_revision,v.revision AS view_revision
      FROM accounts a JOIN work_generations g ON g.account_id=a.account_id AND g.data_domain=? AND g.work_id=?
      JOIN product_work_views v ON v.account_id=g.account_id AND v.data_domain=g.data_domain AND v.work_id=g.work_id
        AND v.visible=1 AND v.state IN ('blocked','paused') AND json_extract(v.payload,'$.generation')=g.generation
      JOIN caller_scopes s ON s.account_id=a.account_id AND s.caller_id=? AND s.data_domain=g.data_domain
        AND s.permission='owner' AND s.revoked_at IS NULL
      WHERE a.account_id=? AND a.auth_epoch=? AND a.policy_revision=? AND g.generation=? AND g.revision=? AND v.revision=?
        AND g.generation=(SELECT MAX(generation) FROM work_generations WHERE work_id=g.work_id)`)
      .get(input.domain, input.workId, principal.caller_id, principal.account_id, principal.auth_epoch, input.policyRevision,
        input.generation, input.workRevision, input.viewRevision) as { auth_epoch: number; policy_revision: number } | undefined;
    if (!current) throw new Error('NOTIFICATION_BLOCKER_FACT_STALE');
    if (source) {
      const live = currentPrBlocker(db, principal.account_id, input.domain, input.workId, at);
      if (!live || sourceHash(live) !== sourceHash(source)) throw new Error('NOTIFICATION_BLOCKER_FACT_STALE');
    }
    const payload = { type: 'notification.blocker.requirement', caller_id: principal.caller_id, generation: input.generation,
      work_revision: input.workRevision, view_revision: input.viewRevision, auth_epoch: current.auth_epoch,
      policy_revision: current.policy_revision, needs_owner: input.needsOwner, reason_code: input.reason, observed_at: at.toISOString(),
      ...(source ? { source_kind: 'pr_conflict', source_hash: sourceHash(source) } : {}) };
    const eventId = 'notification-blocker_' + createHash('sha256').update(JSON.stringify([
      principal.account_id, input.domain, input.workId, input.generation, input.factId,
    ])).digest('hex');
    const prior = db.prepare('SELECT payload FROM domain_events WHERE event_id=?').get(eventId) as { payload: string } | undefined;
    if (prior) {
      const recorded = JSON.parse(prior.payload) as typeof payload;
      if (canonicalPayload({ ...recorded, observed_at: payload.observed_at }) !== canonicalPayload(payload)) {
        throw new Error('NOTIFICATION_BLOCKER_FACT_CONFLICT');
      }
      return eventId;
    }
    appendDomainEvent(db, { eventId, aggregateId: input.workId, aggregateVersion: input.generation,
      accountId: principal.account_id, dataDomain: input.domain, payload, destination: 'local' });
    return eventId;
  });
}

/** Compose only current scoped observations and the T10-tested recipient. Never read note, task, or chat bodies. */
export function notificationObservations(db: SqliteDatabase, options: Options) {
  const preference = db.prepare('SELECT preferences FROM account_preferences WHERE account_id=?');
  const destination = db.prepare(`SELECT c.connection_id,c.owner_open_id,c.chat_id,c.tenant_key,c.app_id,c.credential_ref,c.credential_version,
      c.config_revision,c.channel_incarnation,c.connection_epoch,c.binding_revision,b.binding_id FROM channel_connections c
    JOIN channel_bindings b ON b.connection_id=c.connection_id AND b.account_id=c.account_id AND b.data_domain=c.data_domain
      AND b.pairing_id=c.current_pairing_id AND b.binding_revision=c.binding_revision
      AND b.config_revision=c.config_revision AND b.credential_version=c.credential_version
      AND b.incarnation=c.channel_incarnation AND b.epoch=c.connection_epoch AND b.owner_open_id=c.owner_open_id
      AND b.chat_id=c.chat_id AND b.tenant_key=c.tenant_key AND b.app_id=c.app_id
    JOIN channel_tests t ON t.test_id=c.current_test_id AND t.account_id=c.account_id AND t.data_domain=c.data_domain
      AND t.connection_id=c.connection_id AND t.binding_id=b.binding_id AND t.epoch=c.connection_epoch
      AND t.incarnation=c.channel_incarnation AND t.config_revision=c.config_revision AND t.credential_version=c.credential_version
      AND t.app_id=c.app_id AND t.tenant_key=c.tenant_key AND t.destination=c.owner_open_id
      AND t.status='verified' AND length(t.message_id)>0 AND length(t.inbound_evidence)>0
    WHERE c.account_id=? AND c.data_domain=? AND c.status='ready' AND c.transport_mode='active'
    ORDER BY c.connection_id LIMIT 2`);
  const enrolledOwner = db.prepare(`SELECT auth_epoch FROM accounts a WHERE account_id=? AND EXISTS
    (SELECT 1 FROM caller_scopes s WHERE s.account_id=a.account_id AND data_domain=? AND permission='owner' AND revoked_at IS NULL)`);
  const work = db.prepare(`SELECT revision,state FROM product_work_views
    WHERE account_id=? AND data_domain=? AND work_id=? AND visible=1`);
  const ownerBlocker = db.prepare(`SELECT e.payload FROM domain_events e
    JOIN work_generations g ON g.work_id=e.aggregate_id AND g.generation=e.aggregate_version
      AND g.account_id=e.account_id AND g.data_domain=e.data_domain
      AND g.generation=(SELECT MAX(generation) FROM work_generations WHERE work_id=g.work_id)
    JOIN product_work_views v ON v.account_id=g.account_id AND v.data_domain=g.data_domain AND v.work_id=g.work_id
      AND v.visible=1 AND v.state IN ('blocked','paused') AND v.revision=? AND json_extract(v.payload,'$.generation')=g.generation
    JOIN accounts a ON a.account_id=g.account_id
    JOIN caller_scopes s ON s.account_id=a.account_id AND s.data_domain=g.data_domain
      AND s.caller_id=json_extract(e.payload,'$.caller_id') AND s.permission='owner' AND s.revoked_at IS NULL
    WHERE e.account_id=? AND e.data_domain=? AND e.aggregate_id=? AND e.schema_version LIKE '1.%'
      AND e.seq=(SELECT MAX(seq) FROM domain_events latest WHERE latest.account_id=e.account_id AND latest.data_domain=e.data_domain
        AND latest.aggregate_id=e.aggregate_id AND json_extract(latest.payload,'$.type')='notification.blocker.requirement')
      AND json_extract(e.payload,'$.type')='notification.blocker.requirement' AND json_type(e.payload,'$.needs_owner')='true'
      AND json_extract(e.payload,'$.reason_code') IN ('owner_input_required','owner_authorization_required')
      AND json_extract(e.payload,'$.generation')=g.generation AND json_extract(e.payload,'$.work_revision')=g.revision
      AND json_extract(e.payload,'$.view_revision')=v.revision AND json_extract(e.payload,'$.auth_epoch')=a.auth_epoch
      AND json_extract(e.payload,'$.policy_revision')=a.policy_revision AND json_extract(e.payload,'$.observed_at')<=?`);
  function needsOwner(intent: Readonly<NotificationIntent>): boolean {
    const fact = ownerBlocker.get(intent.eventVersion, intent.accountId, intent.domain, intent.objectId, options.now().toISOString()) as
      { payload: string } | undefined;
    if (!fact) return false;
    const payload = JSON.parse(fact.payload) as { source_kind?: string; source_hash?: string };
    if (payload.source_kind === undefined) return true;
    const source = currentPrBlocker(db, intent.accountId, intent.domain, intent.objectId, options.now());
    return payload.source_kind === 'pr_conflict' && !!source && payload.source_hash === sourceHash(source);
  }
  const decision = db.prepare(`SELECT 1 FROM question_bindings q
    JOIN product_work_views v ON v.account_id=q.account_id AND v.data_domain=q.data_domain AND v.work_id=q.work_id
      AND v.visible=1 AND v.state='awaiting_answer' AND json_extract(v.payload,'$.question_id')=q.question_id
      AND json_extract(v.payload,'$.generation')=q.generation
    JOIN work_generations g ON g.work_id=q.work_id AND g.generation=q.generation AND g.account_id=q.account_id AND g.data_domain=q.data_domain
      AND g.awaiting_answer=1 AND g.control_state='running'
    WHERE q.account_id=? AND q.data_domain=? AND q.question_id=? AND q.question_version=? AND q.status='open'
      AND NOT EXISTS(SELECT 1 FROM question_bindings newer WHERE newer.question_id=q.question_id AND newer.account_id=q.account_id
        AND newer.data_domain=q.data_domain AND newer.question_version>q.question_version)
      AND NOT EXISTS(SELECT 1 FROM answer_receipts r WHERE r.question_id=q.question_id AND r.question_version=q.question_version
        AND r.account_id=q.account_id AND r.data_domain=q.data_domain AND r.validity='verified')`);
  const checkpoint = db.prepare(`SELECT h.imported_at,v.domain_seq,
    COALESCE((SELECT MAX(seq) FROM domain_events WHERE account_id=v.account_id AND data_domain=v.data_domain),0) AS latest
    FROM product_view_checkpoints v
    JOIN hub_snapshots h ON h.cursor_name=? AND h.hub_seq=v.hub_seq
    JOIN projection_cursors c ON c.name=h.cursor_name AND c.hub_seq=h.hub_seq
    WHERE v.account_id=? AND v.data_domain=? AND v.freshness='fresh'`);

  const prefs = (accountId: string) => {
    const row = preference.get(accountId) as { preferences: string } | undefined;
    return row ? preferencePayload.parse(JSON.parse(row.preferences)) : {};
  };
  return {
    preferences(accountId: string): QuietPreferences {
      return { timezone: options.timezone, quiet: prefs(accountId).quiet_hours ?? null };
    },
    inspect(intent: Readonly<NotificationIntent>): NotificationSubject | null {
      const pair = [intent.accountId, intent.domain] as const;
      const owner = enrolledOwner.get(...pair) as { auth_epoch: number } | undefined;
      if (!owner) return null;
      const candidates = destination.all(...pair) as Destination[];
      const channel = candidates.length === 1 && options.credentialUsable(candidates[0].credential_ref) ? candidates[0] : null;
      const snapshot = checkpoint.get(HUB_CURSOR, ...pair) as { domain_seq: number; latest: number; imported_at: string } | undefined;
      const age = snapshot ? +options.now() - Date.parse(snapshot.imported_at) : NaN;
      const available = snapshot && snapshot.domain_seq >= snapshot.latest && age >= 0 && age <= checkpointAgeMs;
      const live = work.get(...pair, intent.objectId) as { state: WorkState; revision: number } | undefined;
      const currentWork = !!available && live?.revision === intent.eventVersion;
      const decisionActive = !!available && intent.kind === 'decision' && !!decision.get(...pair, intent.objectId, intent.eventVersion);
      const current = intent.kind === 'decision' ? decisionActive : currentWork &&
        (intent.kind === 'delivered' ? live.state === 'delivered' : intent.kind === 'blocker'
          ? live.state === 'blocked' || live.state === 'paused' : live.state === 'researching' || live.state === 'verifying');
      return {
        accountId: intent.accountId, domain: intent.domain, objectId: intent.objectId, eventVersion: intent.eventVersion,
        authEpoch: owner.auth_epoch, current, availability: available ? 'verified' : 'unavailable',
        needsOwner: decisionActive || (current && intent.kind === 'blocker' && needsOwner(intent)),
        subscribed: intent.kind === 'delivered' && prefs(intent.accountId).notifications === 'all',
        destination: channel ? { target: channel.connection_id, binding: createHash('sha256').update(JSON.stringify([
          channel.connection_id, channel.binding_id, channel.config_revision, channel.credential_version,
          channel.channel_incarnation, channel.connection_epoch, channel.binding_revision, channel.app_id, channel.tenant_key,
          channel.owner_open_id, channel.chat_id,
        ])).digest('hex') } : null,
      };
    },
  };
}
