import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { appendDomainEvent, withImmediateTransaction, type BlobStore, type SqliteDatabase } from '@patrick/storage';
import { listSamples, samplePath, scanDirectory, stabilityDecision, type StabilitySample } from './directory.js';
import {
  approvedGithubPath,
  classifyGithubPayload,
  normalizeGithubPath,
  readApprovedGithubObject,
  verifyGithubSignature,
  type GithubScope,
} from './github.js';

export type CollectedChange = {
  hasTriggerRule: boolean;
  origin: 'source' | 'review' | 'bot_output' | 'system_view';
  kind: 'create' | 'modify' | 'delete';
  matchesScope: boolean;
  excluded: boolean;
};

export function admitChange(change: CollectedChange): boolean {
  return change.hasTriggerRule && change.origin === 'source'
    && change.kind !== 'delete' && change.matchesScope && !change.excluded;
}

export type Principal = {
  accountId: string;
  dataDomain: string;
};

export type SourceDraft = {
  type: 'github' | 'directory';
  target: string;
  repo?: string;
  branch?: string;
  path?: string;
  excludes?: readonly string[];
  credentialRef?: string | null;
  frequency?: string;
  history?: 'none' | 'backfill';
  hasTriggerRule?: boolean;
};

export type SourceScope = {
  repo: string | null;
  branch: string | null;
  path: string | null;
  root: string | null;
  excludes: string[];
};

export type SourcePreview = {
  sourceId: string | null;
  scope: SourceScope;
  samples: Array<{ locator: string; byteLength: number }>;
  draftHash: string;
  baseline: string;
  identity: { accountId: string; dataDomain: string; connectorType: 'github' | 'directory'; physicalRoot: string };
  expiresAt: string;
  normalizedTarget: string;
  physicalRoot: string;
};

export type CollectionKind = 'enable' | 'first_collection' | 'success' | 'failure' | 'pause' | 'withdraw';

export type CollectionReceipt = {
  eventId: string;
  sourceId: string;
  configRevision: number;
  kind: CollectionKind;
  cursor: string;
  count: number;
  evidenceRef: string | null;
  observedAt: string;
  accepted: boolean;
  reason: string | null;
};

export type GithubWebhookInput = {
  sourceId: string;
  configRevision: number;
  rawBody: Uint8Array;
  signature: string | undefined;
  deliveryId: string;
  secret: string;
};

export type SourceRegistry = {
  detectSource(principal: Principal, draft: SourceDraft): Promise<SourcePreview>;
  enableSource(principal: Principal, draft: SourceDraft): Promise<CollectionReceipt>;
  pauseSource(sourceId: string): Promise<CollectionReceipt>;
  collectSource(sourceId: string, configRevision: number): Promise<CollectionReceipt>;
  ingestGithubWebhook(input: GithubWebhookInput): Promise<CollectionReceipt>;
  wakeDirectory(sourceId: string, relativePath: string): Promise<{ read: boolean; receipt: CollectionReceipt | null }>;
};

export type RegistryOptions = {
  blobs: BlobStore;
  now?: () => string;
  githubFixtureRoot?: string;
  beforeCursorCommit?: () => void;
};

type SourceStatus = 'enabled' | 'paused' | 'offline' | 'placeholder';

type SourceRecord = {
  source_id: string;
  account_id: string;
  data_domain: string;
  connector_type: 'github' | 'directory';
  normalized_target: string;
  physical_root: string;
  scope_json: string;
  excludes_json: string;
  credential_ref: string | null;
  frequency: string;
  history: 'none' | 'backfill';
  has_trigger_rule: number;
  enabled: number;
  status: SourceStatus;
  config_revision: number;
  schema_version: string;
  created_at: string;
  updated_at: string;
};

type CursorRecord = {
  cursor: string;
  phase: string;
  config_revision: number;
  sweep_count: number;
  updated_at: string;
};

type NormalizedDraft = {
  connectorType: 'github' | 'directory';
  normalizedTarget: string;
  physicalRoot: string;
  scope: SourceScope;
  excludes: string[];
  credentialRef: string | null;
  frequency: string;
  history: 'none' | 'backfill';
  hasTriggerRule: boolean;
};

type PendingObject = { locator: string; bytes: Uint8Array; hash: string };

const PREVIEW_TTL_MS = 15 * 60 * 1000;
const SCHEMA_VERSION = '1.0';

export function createSourceRegistry(db: SqliteDatabase, options: RegistryOptions): SourceRegistry {
  const now = options.now ?? (() => new Date().toISOString());
  const stable = new Map<string, StabilitySample>();

  function clock(): string {
    return now();
  }

  function load(sourceId: string): SourceRecord | undefined {
    return db.prepare(`SELECT source_id, account_id, data_domain, connector_type, normalized_target, physical_root,
      scope_json, excludes_json, credential_ref, frequency, history, has_trigger_rule, enabled, status,
      config_revision, schema_version, created_at, updated_at
      FROM source_configs WHERE source_id = ?`).get(sourceId) as SourceRecord | undefined;
  }

  function loadCursor(sourceId: string): CursorRecord {
    const row = db.prepare(`SELECT cursor, phase, config_revision, sweep_count, updated_at
      FROM source_cursors WHERE source_id = ?`).get(sourceId) as CursorRecord | undefined;
    if (!row) throw new Error('SOURCE_CURSOR_MISSING');
    return row;
  }

  function rejected(source: Pick<SourceRecord, 'source_id' | 'config_revision'> | undefined, sourceId: string, configRevision: number, cursor: string, reason: string): CollectionReceipt {
    return {
      eventId: '',
      sourceId: source?.source_id ?? sourceId,
      configRevision: source?.config_revision ?? configRevision,
      kind: 'failure',
      cursor,
      count: 0,
      evidenceRef: null,
      observedAt: clock(),
      accepted: false,
      reason,
    };
  }

  function statusReason(status: SourceStatus | undefined): string {
    if (status === 'offline') return 'OFFLINE';
    if (status === 'placeholder') return 'PLACEHOLDER';
    return 'PAUSED';
  }

  function setStatus(sourceId: string, status: SourceStatus): CollectionReceipt {
    return withImmediateTransaction(db, () => {
      const current = load(sourceId);
      if (!current) throw new Error('SOURCE_NOT_FOUND');
      const cursor = loadCursor(sourceId);
      if (current.status === status) return rejected(current, sourceId, current.config_revision, cursor.cursor, statusReason(status));
      const next = current.config_revision + 1;
      const observedAt = clock();
      const info = db.prepare(`UPDATE source_configs
        SET status = ?, enabled = 0, config_revision = ?, updated_at = ?
        WHERE source_id = ? AND config_revision = ?`).run(status, next, observedAt, sourceId, current.config_revision);
      if (info.changes !== 1) throw new Error('SOURCE_REVISION_CONFLICT');
      insertVersion(db, { ...current, config_revision: next, status, enabled: 0, created_at: observedAt });
      const kind: CollectionKind = status === 'paused' ? 'pause' : 'failure';
      const accepted = status === 'paused';
      const reason = status === 'paused' ? null : statusReason(status);
      const eventId = `${status}:${sourceId}:${next}`;
      insertReceipt(db, {
        eventId,
        sourceId,
        configRevision: next,
        kind,
        cursor: cursor.cursor,
        count: 0,
        evidenceRef: null,
        observedAt,
        accepted,
        reason,
      });
      return {
        eventId,
        sourceId,
        configRevision: next,
        kind,
        cursor: cursor.cursor,
        count: 0,
        evidenceRef: null,
        observedAt,
        accepted,
        reason,
      };
    });
  }

  function gate(sourceId: string, configRevision: number): { source: SourceRecord; cursor: CursorRecord } | CollectionReceipt {
    const source = load(sourceId);
    if (!source) throw new Error('SOURCE_NOT_FOUND');
    const cursor = loadCursor(sourceId);
    if (source.status !== 'enabled') return rejected(source, sourceId, configRevision, cursor.cursor, statusReason(source.status));
    if (source.config_revision !== configRevision) return rejected(source, sourceId, configRevision, cursor.cursor, 'STALE_REVISION');
    return { source, cursor };
  }

  function isReceipt(value: { source: SourceRecord; cursor: CursorRecord } | CollectionReceipt): value is CollectionReceipt {
    return 'accepted' in value;
  }

  async function normalize(principal: Principal, draft: SourceDraft): Promise<NormalizedDraft> {
    if (!principal.accountId || !principal.dataDomain) throw new Error('SOURCE_PRINCIPAL_INVALID');
    assertNoCredential(draft.target);
    if (draft.credentialRef) assertNoCredential(draft.credentialRef);
    const excludes = [...new Set(draft.excludes ?? [])].sort();
    const frequency = draft.frequency ?? 'poll';
    const history = draft.history ?? 'none';
    if (history !== 'none' && history !== 'backfill') throw new Error('SOURCE_HISTORY_INVALID');
    const hasTriggerRule = draft.hasTriggerRule ?? false;
    if (draft.type === 'directory') {
      const root = await realpath(draft.target);
      const info = await stat(root);
      if (!info.isDirectory()) throw new Error('SOURCE_TARGET_INVALID');
      const scope: SourceScope = { repo: null, branch: null, path: null, root, excludes };
      return {
        connectorType: 'directory',
        normalizedTarget: root,
        physicalRoot: root,
        scope,
        excludes,
        credentialRef: draft.credentialRef ?? null,
        frequency,
        history,
        hasTriggerRule,
      };
    }
    if (draft.type !== 'github') throw new Error('SOURCE_TYPE_INVALID');
    if (draft.repo) assertNoCredential(draft.repo);
    if (draft.branch) assertNoCredential(draft.branch);
    if (draft.path) assertNoCredential(draft.path);
    if (!draft.repo || !/^[\w.-]+\/[\w.-]+$/.test(draft.repo) || !draft.branch || !draft.path) throw new Error('SOURCE_TARGET_INVALID');
    const path = normalizeGithubPath(draft.path);
    const branch = normalizeGithubPath(draft.branch);
    if (!path || !branch) throw new Error('SOURCE_TARGET_INVALID');
    const physicalRoot = `github://${draft.repo}@${branch}/${path}`;
    const scope: SourceScope = { repo: draft.repo, branch, path, root: null, excludes };
    return {
      connectorType: 'github',
      normalizedTarget: physicalRoot,
      physicalRoot,
      scope,
      excludes,
      credentialRef: draft.credentialRef ?? null,
      frequency,
      history,
      hasTriggerRule,
    };
  }

  function findRoot(physicalRoot: string): SourceRecord | undefined {
    const row = db.prepare('SELECT source_id FROM source_configs WHERE physical_root = ?').get(physicalRoot) as { source_id: string } | undefined;
    return row ? load(row.source_id) : undefined;
  }

  function overlaps(physicalRoot: string): boolean {
    const rows = db.prepare('SELECT physical_root FROM source_configs').all() as { physical_root: string }[];
    return rows.some((row) => row.physical_root !== physicalRoot && pathsOverlap(row.physical_root, physicalRoot));
  }

  async function samplesFor(draft: NormalizedDraft): Promise<Array<{ locator: string; byteLength: number }>> {
    if (draft.connectorType === 'directory') {
      const root = draft.scope.root;
      if (!root) throw new Error('SOURCE_TARGET_INVALID');
      return (await listSamples(root, draft.excludes)).map((sample) => ({ locator: sample.relativePath, byteLength: sample.byteLength }));
    }
    const scope = githubScope(draft.scope);
    const root = githubRoot(scope);
    return (await listSamples(root, draft.excludes)).map((sample) => ({
      locator: `${scope.path}/${sample.relativePath}`,
      byteLength: sample.byteLength,
    }));
  }

  function githubRoot(scope: GithubScope): string {
    if (!options.githubFixtureRoot) throw new Error('GITHUB_FIXTURE_REQUIRED');
    return resolve(options.githubFixtureRoot, scope.repo, scope.branch, scope.path);
  }

  function previewFor(principal: Principal, draft: NormalizedDraft, sourceId: string | null): SourcePreview {
    const draftHash = hashDraft(principal, draft);
    return {
      sourceId,
      scope: draft.scope,
      samples: [],
      draftHash,
      baseline: `baseline:${draftHash}`,
      identity: {
        accountId: principal.accountId,
        dataDomain: principal.dataDomain,
        connectorType: draft.connectorType,
        physicalRoot: draft.physicalRoot,
      },
      expiresAt: new Date(Date.parse(clock()) + PREVIEW_TTL_MS).toISOString(),
      normalizedTarget: draft.normalizedTarget,
      physicalRoot: draft.physicalRoot,
    };
  }

  function receiptForExisting(source: SourceRecord): CollectionReceipt {
    const cursor = loadCursor(source.source_id);
    return {
      eventId: `enable:${source.source_id}:${source.config_revision}`,
      sourceId: source.source_id,
      configRevision: source.config_revision,
      kind: 'enable',
      cursor: cursor.cursor,
      count: 0,
      evidenceRef: null,
      observedAt: clock(),
      accepted: true,
      reason: null,
    };
  }

  function latestHash(sourceId: string, locator: string): string | null {
    const row = db.prepare(`SELECT source_revisions.content_hash AS content_hash
      FROM source_revisions
      JOIN source_objects ON source_objects.source_id = source_revisions.source_id
        AND source_objects.object_id = source_revisions.object_id
      WHERE source_objects.source_id = ? AND source_objects.locator = ? AND source_revisions.tombstone = 0
      ORDER BY source_revisions.observed_seq DESC LIMIT 1`).get(sourceId, locator) as { content_hash: string | null } | undefined;
    return row?.content_hash ?? null;
  }

  async function stage(sourceId: string, files: Array<{ locator: string; stable: boolean; bytes?: Uint8Array }>): Promise<{
    changed: PendingObject[];
    onDisk: Set<string>;
    unstable: Set<string>;
  }> {
    const changed: PendingObject[] = [];
    const onDisk = new Set<string>();
    const unstable = new Set<string>();
    for (const file of files) {
      if (!file.stable || !file.bytes) {
        unstable.add(file.locator);
        continue;
      }
      onDisk.add(file.locator);
      const hash = sha256(file.bytes);
      const existing = db.prepare('SELECT tombstone FROM source_objects WHERE source_id = ? AND locator = ?').get(
        sourceId,
        file.locator,
      ) as { tombstone: number } | undefined;
      if ((!existing || existing.tombstone === 0) && latestHash(sourceId, file.locator) === hash) continue;
      await options.blobs.putBlob(file.bytes);
      changed.push({ locator: file.locator, bytes: file.bytes, hash });
    }
    return { changed, onDisk, unstable };
  }

  function commitSweep(input: {
    source: SourceRecord;
    configRevision: number;
    changed: PendingObject[];
    onDisk: Set<string>;
    unstable: Set<string>;
    confirmDeletes: boolean;
    deliveryId?: string;
    evidenceRef: string | null;
  }): CollectionReceipt {
    return withImmediateTransaction(db, () => {
      options.beforeCursorCommit?.();
      const current = load(input.source.source_id);
      const cursor = loadCursor(input.source.source_id);
      if (!current || current.status !== 'enabled') {
        return rejected(current, input.source.source_id, input.configRevision, cursor.cursor, statusReason(current?.status));
      }
      if (current.config_revision !== input.configRevision) {
        return rejected(current, input.source.source_id, input.configRevision, cursor.cursor, 'STALE_REVISION');
      }
      if (input.deliveryId) {
        const duplicate = db.prepare('SELECT 1 AS ok FROM webhook_deliveries WHERE event_id = ?').get(input.deliveryId);
        if (duplicate) return rejected(current, input.source.source_id, input.configRevision, cursor.cursor, 'DUPLICATE_EVENT');
      }
      const observedAt = clock();
      let count = 0;
      for (const object of input.changed) {
        if (applyContent(current, object, observedAt)) count += 1;
      }
      let withdrew = false;
      if (input.confirmDeletes) withdrew = confirmMissing(current, input.onDisk, input.unstable, observedAt);
      const prior = db.prepare(`SELECT COUNT(*) AS n FROM collection_receipts
        WHERE source_id = ? AND accepted = 1 AND kind IN ('first_collection', 'success')`).get(current.source_id) as { n: number };
      const kind: CollectionKind = withdrew ? 'withdraw' : prior.n === 0 ? 'first_collection' : 'success';
      const phase = prior.n === 0 ? 'first_collected' : 'advanced';
      const advancesSweep = input.confirmDeletes && !input.deliveryId;
      const sweepCount = advancesSweep ? cursor.sweep_count + 1 : cursor.sweep_count;
      const cursorText = input.deliveryId
        ? `delivery:${input.deliveryId}`
        : advancesSweep
          ? `sweep:${sweepCount}`
          : cursor.cursor;
      db.prepare(`UPDATE source_cursors
        SET config_revision = ?, cursor = ?, phase = ?, sweep_count = ?, updated_at = ?
        WHERE source_id = ?`).run(current.config_revision, cursorText, phase, sweepCount, observedAt, current.source_id);
      const partialSeq = db.prepare('SELECT COUNT(*) AS n FROM collection_receipts WHERE source_id = ?').get(current.source_id) as {
        n: number;
      };
      const eventId = input.deliveryId
        ?? (advancesSweep
          ? `collect:${current.source_id}:${current.config_revision}:sweep:${sweepCount}`
          : `collect:${current.source_id}:${current.config_revision}:partial:${partialSeq.n + 1}`);
      const evidenceRef = input.evidenceRef ?? (input.changed[0] ? input.changed[0].hash : null);
      insertReceipt(db, {
        eventId,
        sourceId: current.source_id,
        configRevision: current.config_revision,
        kind,
        cursor: cursorText,
        count,
        evidenceRef,
        observedAt,
        accepted: true,
        reason: null,
      });
      if (input.deliveryId) rememberDelivery(current.source_id, input.deliveryId, observedAt);
      return {
        eventId,
        sourceId: current.source_id,
        configRevision: current.config_revision,
        kind,
        cursor: cursorText,
        count,
        evidenceRef,
        observedAt,
        accepted: true,
        reason: null,
      };
    });
  }

  function applyContent(source: SourceRecord, object: PendingObject, observedAt: string): boolean {
    db.prepare('INSERT INTO blobs (sha256, byte_length, created_at) VALUES (?, ?, ?) ON CONFLICT(sha256) DO NOTHING').run(
      object.hash,
      object.bytes.byteLength,
      observedAt,
    );
    const existing = db.prepare('SELECT object_id, observed_seq, tombstone FROM source_objects WHERE source_id = ? AND locator = ?').get(
      source.source_id,
      object.locator,
    ) as { object_id: string; observed_seq: number; tombstone: number } | undefined;
    if (existing && existing.tombstone === 0 && latestHash(source.source_id, object.locator) === object.hash) return false;
    const objectId = existing?.object_id ?? objectIdFor(source.source_id, object.locator);
    const seq = (existing?.observed_seq ?? 0) + 1;
    if (!existing) {
      db.prepare(`INSERT INTO source_objects (source_id, object_id, locator, trust_class, tombstone, observed_seq)
        VALUES (?, ?, ?, 'connector', 0, ?)`).run(source.source_id, objectId, object.locator, seq);
    } else {
      db.prepare('UPDATE source_objects SET tombstone = 0, observed_seq = ? WHERE source_id = ? AND object_id = ?').run(seq, source.source_id, objectId);
    }
    const revisionId = `rev_${objectId}_${seq}`;
    db.prepare(`INSERT INTO source_revisions (
      source_id, object_id, observed_seq, revision_id, content_hash, trust_class, tombstone,
      account_id, data_domain, schema_version, created_at
    ) VALUES (?, ?, ?, ?, ?, 'connector', 0, ?, ?, ?, ?)`).run(
      source.source_id,
      objectId,
      seq,
      revisionId,
      object.hash,
      source.account_id,
      source.data_domain,
      SCHEMA_VERSION,
      observedAt,
    );
    const change: CollectedChange = {
      hasTriggerRule: source.has_trigger_rule === 1,
      origin: 'source',
      kind: existing ? 'modify' : 'create',
      matchesScope: true,
      excluded: false,
    };
    if (admitChange(change)) {
      appendDomainEvent(db, {
        eventId: `work:${revisionId}`,
        aggregateId: objectId,
        aggregateVersion: seq,
        accountId: source.account_id,
        dataDomain: source.data_domain,
        payload: { admitted: true, objectId, kind: change.kind },
        destination: 'source-work',
      });
    }
    return true;
  }

  function confirmMissing(source: SourceRecord, onDisk: Set<string>, unstable: Set<string>, observedAt: string): boolean {
    const objects = db.prepare('SELECT object_id, locator, tombstone, observed_seq FROM source_objects WHERE source_id = ?').all(source.source_id) as Array<{
      object_id: string;
      locator: string;
      tombstone: number;
      observed_seq: number;
    }>;
    let withdrew = false;
    for (const object of objects) {
      if (object.tombstone === 1) continue;
      if (onDisk.has(object.locator) || unstable.has(object.locator)) {
        db.prepare('DELETE FROM delete_sweeps WHERE source_id = ? AND object_id = ?').run(source.source_id, object.object_id);
        continue;
      }
      const prior = db.prepare('SELECT missing_streak FROM delete_sweeps WHERE source_id = ? AND object_id = ?').get(source.source_id, object.object_id) as { missing_streak: number } | undefined;
      const streak = (prior?.missing_streak ?? 0) + 1;
      db.prepare(`INSERT INTO delete_sweeps (source_id, object_id, missing_streak) VALUES (?, ?, ?)
        ON CONFLICT(source_id, object_id) DO UPDATE SET missing_streak = excluded.missing_streak`).run(source.source_id, object.object_id, streak);
      if (streak >= 2) {
        withdrawObject(source, object, observedAt);
        withdrew = true;
      }
    }
    return withdrew;
  }

  function withdrawObject(source: SourceRecord, object: { object_id: string; observed_seq: number }, observedAt: string): void {
    const seq = object.observed_seq + 1;
    db.prepare('UPDATE source_objects SET tombstone = 1, observed_seq = ? WHERE source_id = ? AND object_id = ?').run(seq, source.source_id, object.object_id);
    const revisionId = `rev_${object.object_id}_${seq}`;
    db.prepare(`INSERT INTO source_revisions (
      source_id, object_id, observed_seq, revision_id, content_hash, trust_class, tombstone,
      account_id, data_domain, schema_version, created_at
    ) VALUES (?, ?, ?, ?, NULL, 'connector', 1, ?, ?, ?, ?)`).run(
      source.source_id,
      object.object_id,
      seq,
      revisionId,
      source.account_id,
      source.data_domain,
      SCHEMA_VERSION,
      observedAt,
    );
    const checkId = `dep_${object.object_id}_${seq}`;
    db.prepare(`INSERT INTO dependency_checks (check_id, source_id, object_id, observed_seq, reason, created_at)
      VALUES (?, ?, ?, ?, 'source_withdrawn', ?)`).run(checkId, source.source_id, object.object_id, seq, observedAt);
    appendDomainEvent(db, {
      eventId: `dep:${checkId}`,
      aggregateId: object.object_id,
      aggregateVersion: seq,
      accountId: source.account_id,
      dataDomain: source.data_domain,
      payload: { kind: 'withdraw', objectId: object.object_id, observedSeq: seq },
      destination: 'source-dependency',
    });
  }

  function rememberDelivery(sourceId: string, deliveryId: string, observedAt: string): void {
    db.prepare('INSERT INTO webhook_deliveries (event_id, source_id, received_at) VALUES (?, ?, ?)').run(deliveryId, sourceId, observedAt);
  }

  function recordIgnored(source: SourceRecord, deliveryId: string, reason: string): CollectionReceipt {
    return withImmediateTransaction(db, () => {
      const current = load(source.source_id);
      const cursor = loadCursor(source.source_id);
      if (!current || current.status !== 'enabled') return rejected(current, source.source_id, source.config_revision, cursor.cursor, statusReason(current?.status));
      const duplicate = db.prepare('SELECT 1 AS ok FROM webhook_deliveries WHERE event_id = ?').get(deliveryId);
      if (duplicate) return rejected(current, source.source_id, current.config_revision, cursor.cursor, 'DUPLICATE_EVENT');
      rememberDelivery(current.source_id, deliveryId, clock());
      return rejected(current, source.source_id, current.config_revision, cursor.cursor, reason);
    });
  }

  async function collectFiles(source: SourceRecord, configRevision: number): Promise<CollectionReceipt> {
    const scope = parseScope(source.scope_json);
    const excludes = JSON.parse(source.excludes_json) as string[];
    if (source.connector_type === 'github') {
      const github = githubScope(scope);
      const scan = await scanDirectory(githubRoot(github), excludes);
      if (scan.state === 'offline') return setStatus(source.source_id, 'offline');
      if (scan.state === 'placeholder') return setStatus(source.source_id, 'placeholder');
      const staged = await stage(source.source_id, scan.files.map((file) => ({
        locator: `${github.path}/${file.relativePath}`,
        stable: file.stable,
        bytes: file.bytes,
      })));
      const hash = staged.changed[0]?.hash ?? null;
      return commitSweep({
        source,
        configRevision,
        ...staged,
        confirmDeletes: true,
        evidenceRef: hash ? `local-fixture:${hash}` : null,
      });
    }
    const root = scope.root;
    if (!root) throw new Error('SOURCE_SCOPE_INVALID');
    const scan = await scanDirectory(root, excludes);
    if (scan.state === 'offline') return setStatus(source.source_id, 'offline');
    if (scan.state === 'placeholder') return setStatus(source.source_id, 'placeholder');
    const staged = await stage(source.source_id, scan.files.map((file) => ({
      locator: file.relativePath,
      stable: file.stable,
      bytes: file.bytes,
    })));
    return commitSweep({
      source,
      configRevision,
      ...staged,
      confirmDeletes: true,
      evidenceRef: staged.changed[0]?.hash ?? null,
    });
  }

  return {
    async detectSource(principal, draft) {
      const normalized = await normalize(principal, draft);
      const existing = findRoot(normalized.physicalRoot);
      if (existing && (existing.account_id !== principal.accountId || existing.data_domain !== principal.dataDomain)) {
        throw new Error('SOURCE_ROOT_TAKEN');
      }
      const preview = previewFor(principal, normalized, existing?.source_id ?? null);
      preview.samples = await samplesFor(normalized);
      return preview;
    },

    async enableSource(principal, draft) {
      const normalized = await normalize(principal, draft);
      const existing = findRoot(normalized.physicalRoot);
      if (existing) {
        if (existing.account_id !== principal.accountId || existing.data_domain !== principal.dataDomain) throw new Error('SOURCE_ROOT_TAKEN');
        return receiptForExisting(existing);
      }
      if (overlaps(normalized.physicalRoot)) throw new Error('SOURCE_ROOT_TAKEN');
      if (normalized.connectorType === 'github') await stat(githubRoot(githubScope(normalized.scope)));
      const observedAt = clock();
      const draftHash = hashDraft(principal, normalized);
      const sourceId = `src_${sha256(Buffer.from(`${principal.accountId}\0${principal.dataDomain}\0${normalized.physicalRoot}`)).slice(0, 24)}`;
      const baseline = `baseline:${draftHash}`;
      const scopeJson = JSON.stringify(normalized.scope);
      const excludesJson = JSON.stringify(normalized.excludes);
      return withImmediateTransaction(db, () => {
        db.prepare(`INSERT INTO source_configs (
          source_id, account_id, data_domain, connector_type, normalized_target, physical_root, scope_json, excludes_json,
          credential_ref, frequency, history, has_trigger_rule, enabled, status, config_revision, schema_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'enabled', 1, ?, ?, ?)`).run(
          sourceId,
          principal.accountId,
          principal.dataDomain,
          normalized.connectorType,
          normalized.normalizedTarget,
          normalized.physicalRoot,
          scopeJson,
          excludesJson,
          normalized.credentialRef,
          normalized.frequency,
          normalized.history,
          normalized.hasTriggerRule ? 1 : 0,
          SCHEMA_VERSION,
          observedAt,
          observedAt,
        );
        insertVersion(db, {
          source_id: sourceId,
          account_id: principal.accountId,
          data_domain: principal.dataDomain,
          connector_type: normalized.connectorType,
          normalized_target: normalized.normalizedTarget,
          physical_root: normalized.physicalRoot,
          scope_json: scopeJson,
          excludes_json: excludesJson,
          credential_ref: normalized.credentialRef,
          frequency: normalized.frequency,
          history: normalized.history,
          has_trigger_rule: normalized.hasTriggerRule ? 1 : 0,
          enabled: 1,
          status: 'enabled',
          config_revision: 1,
          schema_version: SCHEMA_VERSION,
          created_at: observedAt,
          updated_at: observedAt,
        });
        db.prepare(`INSERT INTO source_cursors (source_id, config_revision, cursor, phase, sweep_count, updated_at)
          VALUES (?, 1, ?, 'baseline', 0, ?)`).run(sourceId, baseline, observedAt);
        const eventId = `enable:${sourceId}:1`;
        insertReceipt(db, {
          eventId,
          sourceId,
          configRevision: 1,
          kind: 'enable',
          cursor: baseline,
          count: 0,
          evidenceRef: null,
          observedAt,
          accepted: true,
          reason: null,
        });
        return {
          eventId,
          sourceId,
          configRevision: 1,
          kind: 'enable' as const,
          cursor: baseline,
          count: 0,
          evidenceRef: null,
          observedAt,
          accepted: true,
          reason: null,
        };
      });
    },

    pauseSource(sourceId) {
      return Promise.resolve(setStatus(sourceId, 'paused'));
    },

    async collectSource(sourceId, configRevision) {
      const opened = gate(sourceId, configRevision);
      if (isReceipt(opened)) return opened;
      return collectFiles(opened.source, configRevision);
    },

    async ingestGithubWebhook(input) {
      const source = load(input.sourceId);
      if (!source) throw new Error('SOURCE_NOT_FOUND');
      const cursor = loadCursor(input.sourceId);
      if (!verifyGithubSignature(input.rawBody, input.signature, input.secret)) {
        return rejected(source, input.sourceId, input.configRevision, cursor.cursor, 'BAD_SIGNATURE');
      }
      if (!input.deliveryId) return rejected(source, input.sourceId, input.configRevision, cursor.cursor, 'BAD_DELIVERY');
      const duplicate = db.prepare('SELECT 1 AS ok FROM webhook_deliveries WHERE event_id = ?').get(input.deliveryId);
      if (duplicate) return rejected(source, input.sourceId, input.configRevision, cursor.cursor, 'DUPLICATE_EVENT');
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.from(input.rawBody).toString('utf8'));
      } catch {
        return rejected(source, input.sourceId, input.configRevision, cursor.cursor, 'GITHUB_PAYLOAD_INVALID');
      }
      const classified = classifyGithubPayload(payload);
      if (classified.origin !== 'source') return recordIgnored(source, input.deliveryId, 'IGNORED_ORIGIN');
      if (source.status !== 'enabled' || source.config_revision !== input.configRevision) {
        return rejected(source, input.sourceId, input.configRevision, cursor.cursor, source.status !== 'enabled' ? statusReason(source.status) : 'STALE_REVISION');
      }
      const scope = githubScope(parseScope(source.scope_json));
      const excludes = new Set(JSON.parse(source.excludes_json) as string[]);
      const files: Array<{ locator: string; stable: boolean; bytes?: Uint8Array }> = [];
      for (const change of classified.changes) {
        if (change.kind === 'delete') continue;
        const approved = approvedGithubPath(scope, { repo: classified.repo, branch: classified.branch, path: change.path });
        if (!approved || excludes.has(approved)) continue;
        try {
          files.push({ locator: approved, stable: true, bytes: readApprovedGithubObject(options.githubFixtureRoot ?? '', scope, approved) });
        } catch (error) {
          if (error instanceof Error && (error.message === 'GITHUB_PATH_NOT_APPROVED' || error.message === 'ENOENT')) continue;
          if (isEnoent(error)) continue;
          throw error;
        }
      }
      const staged = await stage(source.source_id, files);
      if (staged.changed.length === 0) return recordIgnored(source, input.deliveryId, 'NO_APPROVED_OBJECT');
      return commitSweep({
        source,
        configRevision: input.configRevision,
        ...staged,
        confirmDeletes: false,
        deliveryId: input.deliveryId,
        evidenceRef: `local-fixture:${staged.changed[0]!.hash}`,
      });
    },

    async wakeDirectory(sourceId, relativePath) {
      const source = load(sourceId);
      if (!source || source.connector_type !== 'directory') throw new Error('SOURCE_NOT_FOUND');
      if (source.status !== 'enabled') return { read: false, receipt: null };
      const root = parseScope(source.scope_json).root;
      if (!root) throw new Error('SOURCE_SCOPE_INVALID');
      const locator = normalizeGithubPath(relativePath);
      if (!locator) throw new Error('SOURCE_PATH_NOT_APPROVED');
      const excludes = new Set(JSON.parse(source.excludes_json) as string[]);
      if (excludes.has(locator)) return { read: false, receipt: null };
      const full = resolve(root, locator);
      if (!isInside(root, full)) throw new Error('SOURCE_PATH_NOT_APPROVED');
      const sample = await samplePath(full);
      if (sample.offline || sample.placeholder) {
        return { read: false, receipt: setStatus(sourceId, sample.offline ? 'offline' : 'placeholder') };
      }
      if (!sample.exists) return { read: false, receipt: null };
      const key = `${sourceId}\0${locator}`;
      const decision = stabilityDecision(stable.get(key), sample);
      if (decision.next) stable.set(key, decision.next);
      else stable.delete(key);
      if (!decision.ready) return { read: false, receipt: null };
      const real = await realpath(full);
      if (!isInside(root, real)) return { read: false, receipt: null };
      const staged = await stage(sourceId, [{ locator, stable: true, bytes: new Uint8Array(await readFile(real)) }]);
      const receipt = commitSweep({
        source,
        configRevision: source.config_revision,
        ...staged,
        confirmDeletes: false,
        evidenceRef: staged.changed[0]?.hash ?? null,
      });
      return { read: receipt.accepted && receipt.count > 0, receipt };
    },
  };
}

function insertVersion(db: SqliteDatabase, source: SourceRecord): void {
  db.prepare(`INSERT INTO source_versions (
    source_id, config_revision, account_id, data_domain, connector_type, normalized_target, physical_root,
    scope_json, excludes_json, credential_ref, frequency, history, has_trigger_rule, enabled, status, schema_version, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    source.source_id,
    source.config_revision,
    source.account_id,
    source.data_domain,
    source.connector_type,
    source.normalized_target,
    source.physical_root,
    source.scope_json,
    source.excludes_json,
    source.credential_ref,
    source.frequency,
    source.history,
    source.has_trigger_rule,
    source.enabled,
    source.status,
    source.schema_version,
    source.created_at,
  );
}

function insertReceipt(db: SqliteDatabase, receipt: CollectionReceipt): void {
  db.prepare(`INSERT INTO collection_receipts (
    event_id, source_id, config_revision, kind, cursor, object_count, evidence_ref, observed_at, accepted, reason
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    receipt.eventId,
    receipt.sourceId,
    receipt.configRevision,
    receipt.kind,
    receipt.cursor,
    receipt.count,
    receipt.evidenceRef,
    receipt.observedAt,
    receipt.accepted ? 1 : 0,
    receipt.reason,
  );
}

function parseScope(scopeJson: string): SourceScope {
  return JSON.parse(scopeJson) as SourceScope;
}

function githubScope(scope: SourceScope): GithubScope {
  if (!scope.repo || !scope.branch || !scope.path) throw new Error('SOURCE_SCOPE_INVALID');
  return { repo: scope.repo, branch: scope.branch, path: scope.path };
}

function hashDraft(principal: Principal, draft: NormalizedDraft): string {
  return sha256(Buffer.from([
    principal.accountId,
    principal.dataDomain,
    draft.connectorType,
    draft.physicalRoot,
    JSON.stringify(draft.scope),
    draft.excludes.join('\n'),
    draft.credentialRef ?? '',
    draft.frequency,
    draft.history,
    draft.hasTriggerRule ? '1' : '0',
  ].join('\0')));
}

function objectIdFor(sourceId: string, locator: string): string {
  return `obj_${sha256(Buffer.from(`${sourceId}\0${locator}`)).slice(0, 24)}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertNoCredential(value: string): void {
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*@/i.test(value)) throw new Error('SOURCE_CREDENTIAL_IN_TARGET');
  if (/^(ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)/.test(value)) throw new Error('SOURCE_CREDENTIAL_IN_TARGET');
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathPrefix(left, right) || isPathPrefix(right, left);
}

function isPathPrefix(parent: string, child: string): boolean {
  const divider = parent.startsWith('github://') ? '/' : sep;
  const prefix = parent.endsWith(divider) ? parent : parent + divider;
  return child.startsWith(prefix);
}

function isInside(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate === root || candidate.startsWith(prefix);
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
