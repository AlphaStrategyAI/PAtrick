import { closeSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createRecoveryRuntimeGate, openDatabase } from '@patrick/storage';
import { canonicalize } from '../lib/release.mjs';
import type { HubPublisher, HubWireEvent } from '../../packages/integrations/autoloop/client.js';
import { dispatchSourceWork, sourceWorkId } from '../../packages/integrations/sources/work-dispatch.js';

export async function runUpgradeResearchCanary(path: string) {
  if (!isAbsolute(path)) throw new Error('DATABASE_PATH_INVALID');
  closeSync(openSync(path, 'wx', 0o600));
  const database = openDatabase(path);
  try {
    const now = new Date('2026-01-01T00:00:00Z');
    const timestamp = now.toISOString();
    const domain = 'personal';
    const account = 'research-canary-account';
    const eventId = 'upgrade-research-request';
    const sourceId = 'upgrade-research-source';
    const objectId = 'upgrade-research-object';
    const workId = sourceWorkId(sourceId, objectId);
    const writer = { domain, writerEpoch: 'canary-epoch', activationId: 'canary-activation', witnessRevision: 'canary-witness' };
    const recovery = createRecoveryRuntimeGate(database);
    database.prepare(`INSERT INTO recovery_domain_gates
      (data_domain, writer_epoch, status, activation_id, witness_revision, reason, updated_at)
      VALUES (?, ?, 'open', ?, ?, 'canary', ?)`).run(domain, writer.writerEpoch, writer.activationId, writer.witnessRevision, timestamp);
    database.prepare(`INSERT INTO mandate_types
      (type_id, account_id, data_domain, actions_json, resources_json, effects_json, domains_json, risk, level,
        budget_micros, config_version, schema_version, created_at)
      VALUES ('canary-type', ?, ?, '[]', '[]', '[]', '["personal"]', 'low', 'L0', 0, 1, '1.0', ?)`)
      .run(account, domain, timestamp);
    database.prepare(`INSERT INTO mandates
      (mandate_id, type_id, account_id, data_domain, status, actions_json, resources_json, effects_json, domains_json, risk,
        level, budget_micros, expires_at, revision, scope_hash, config_version, schema_version, created_at, updated_at)
      VALUES ('canary-mandate', 'canary-type', ?, ?, 'active', '[]', '[]', '[]', '["personal"]', 'low',
        'L0', 0, '2027-01-01T00:00:00.000Z', 0, ?, 1, '1.0', ?, ?)`)
      .run(account, domain, 'a'.repeat(64), timestamp, timestamp);
    database.prepare(`INSERT INTO evaluation_policies
      (policy_id, policy_version, data_domain, dataset_id, min_samples, threshold_thousandths, budget_micros,
        external_method_id, external_method_revision, external_rules_json, schema_version, created_at)
      VALUES ('canary-policy', 1, ?, 'canary-dataset', 1, 0, 0, 'canary-method', '1', '[]', '1.0', ?)`).run(domain, timestamp);
    database.prepare(`INSERT INTO source_configs
      (source_id, account_id, data_domain, connector_type, normalized_target, physical_root, scope_json, excludes_json,
        frequency, history, has_trigger_rule, enabled, status, config_revision, schema_version, created_at, updated_at)
      VALUES (?, ?, ?, 'directory', 'canary', 'canary', '[]', '[]', 'poll', 'none', 1, 1, 'enabled', 1, '1.0', ?, ?)`)
      .run(sourceId, account, domain, timestamp, timestamp);
    function enqueue(id: string, revisionId: string, sequence: number) {
      database.prepare(`INSERT INTO domain_events
        (seq, event_id, aggregate_id, aggregate_version, account_id, data_domain, schema_version, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, '1.0', ?, ?)`).run(sequence, id, objectId, sequence, account, domain,
        JSON.stringify({ sourceId, objectId, revisionId }), timestamp);
      database.prepare("INSERT INTO outbox (event_id, destination) VALUES (?, 'source-work')").run(id);
    }
    const lost = new Error('UPGRADE_RESEARCH_CANARY_REPLY_LOST');
    const invalid = () => new Error('UPGRADE_RESEARCH_CANARY_INVALID');
    const count = (sql: string) => (database.prepare(sql).get() as { count: number }).count;
    let firstRequest: HubWireEvent | undefined;
    let hubCalls = 0;
    const hub: HubPublisher = {
      async postEvent(request) {
        hubCalls++;
        const { id, type, subject, summary, hops, detail } = request;
        if (id !== eventId || type !== 'source.changed' || subject !== eventId || summary !== 'work.requested' || hops !== 0 ||
            canonicalize(JSON.parse(detail)) !== canonicalize({
              root: eventId, cause: eventId, generation: 1, hops: 0, kind: 'work.requested', stage_key: null, request_id: null,
            })) throw invalid();
        if (!firstRequest) {
          firstRequest = request;
          throw lost;
        }
        if (canonicalize(request) !== canonicalize(firstRequest)) throw invalid();
        return { event: 1, duplicate: true, routed: [] };
      },
    };
    const dispatch = () => dispatchSourceWork(database, hub, { now: () => now });
    const blocked = (id: string) => ({ dispatched: [], deferred: [{ event_id: id, reason: 'RECOVERY_WRITE_BLOCKED' }] });
    enqueue(eventId, 'canary-revision-one', 1);
    const closedBefore = canonicalize(await dispatch()) === canonicalize(blocked(eventId)) &&
      count('SELECT count(*) AS count FROM work_generations') === 0 && hubCalls === 0;
    if (!closedBefore) throw invalid();
    recovery.admit(writer);
    try {
      await dispatch().then(() => { throw invalid(); }, error => { if (error !== lost) throw error; });
      const outbox = database.prepare<[string], { result: string | null }>(
        "SELECT result FROM outbox WHERE event_id = ? AND destination = 'source-work'");
      const work = database.prepare<[string], { generation: number }>(
        'SELECT generation FROM work_generations WHERE work_id = ?');
      const basis = database.prepare<[string], { generation: number }>(
        'SELECT generation FROM judgment_bases WHERE work_id = ?');
      const receipt = database.prepare<[string], {
        root: string; cause: string; generation: number; kind: string; hub_event: number;
      }>('SELECT root, cause, generation, kind, hub_event FROM hub_events WHERE event_id = ?');
      if (outbox.get(eventId)?.result !== null || work.get(workId)?.generation !== 1 || basis.get(workId)?.generation !== 1 ||
          receipt.get(eventId) !== undefined) throw invalid();
      const recovered = await dispatch();
      if (canonicalize(recovered) !== canonicalize({
        dispatched: [{ work_id: workId, generation: 1, event_id: eventId, result: 'duplicate' }], deferred: [],
      })) throw invalid();
      const acknowledged = receipt.get(eventId);
      if (canonicalize(await dispatch()) !== canonicalize({ dispatched: [], deferred: [] }) ||
          outbox.get(eventId)?.result !== 'duplicate' || !acknowledged || acknowledged.root !== eventId ||
          acknowledged.cause !== eventId || acknowledged.generation !== 1 ||
          acknowledged.kind !== 'work.requested' || acknowledged.hub_event !== 1 ||
          count('SELECT count(*) AS count FROM judgment_bases') !== 1 ||
          count('SELECT count(*) AS count FROM hub_events') !== 1) throw invalid();
    } finally { recovery.revoke(domain); }
    const laterEvent = 'upgrade-research-next-request';
    enqueue(laterEvent, 'canary-revision-two', 2);
    const closedAfter = canonicalize(await dispatch()) === canonicalize(blocked(laterEvent));
    const workGenerations = count('SELECT count(*) AS count FROM work_generations');
    if (!closedAfter || hubCalls !== 2 || workGenerations !== 1) throw invalid();
    return { closedBefore, recovered: 'duplicate' as const, hubCalls, workGenerations, closedAfter };
  } finally { database.close(); }
}
