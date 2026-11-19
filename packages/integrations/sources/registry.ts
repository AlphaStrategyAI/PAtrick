import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { canonicalPayload } from '@patrick/contracts';
import { appendDomainEvent, assertRecoveryWriteAllowed, withImmediateTransaction, type BlobStore, type SqliteDatabase } from '@patrick/storage';
import { listDirectory, listSamples, readDirectoryFile, readDirectoryObject, samplePath, stabilityDecision, type StabilitySample } from './directory.js';
import { assertDirectoryReaderAvailable } from './directory-capability.js';
import { listSamples as listGithubFixtureSamples, scanDirectory as scanGithubFixture } from './github-fixture-directory.js';
export { directoryReaderCapability } from './directory-capability.js';
import { readRegisteredHttp, sourceUrl, type HttpReadPort, type RegisteredHttpSource } from './http-read.js';
import { parseFeed } from './rss.js';
import { planRssHistory, type RssHistoryLimits, type RssHistorySelection } from './http-history.js';
import { extractPage } from './webpage.js';
import {
  approvedGithubPath,
  classifyGithubPayload,
  normalizeGithubPath,
  readApprovedGithubObject,
  verifyGithubSignature,
  type GithubApiPort,
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

export type HttpConnectorType = 'rss' | 'webpage';
type ConnectorType = 'github' | 'directory' | HttpConnectorType;
export type SourceDraft = {
  type: ConnectorType;
  target: string;
  repo?: string;
  branch?: string;
  path?: string;
  excludes?: readonly string[];
  credentialRef?: string | null;
  frequency?: string;
  history?: 'none' | 'backfill';
  hasTriggerRule?: boolean;
  /** Delegation type the admitted trigger runs under. Required for a trigger to dispatch work. */
  triggerMandateTypeId?: string | null;
};

export type SourceScope = {
  repo: string | null;
  branch: string | null;
  path: string | null;
  root: string | null;
  excludes: string[];
  httpTargets?: string[];
};

export type HttpBaselineEntry = [locatorHash: string, contentHash: string];
export type SourcePreview = {
  sourceId: string | null;
  scope: SourceScope;
  samples: Array<{ locator: string; byteLength: number }>;
  httpBaseline?: HttpBaselineEntry[];
  draftHash: string;
  baseline: string;
  identity: { accountId: string; dataDomain: string; connectorType: ConnectorType; physicalRoot: string };
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

export const httpFrequencies = ['poll', '30m', '1h', '6h', '24h'] as const;
export type HttpSourceOperation = 'modify' | 'pause' | 'resume' | 'disconnect';
export type SourceOperation = 'modify' | 'pause' | 'resume' | 'disconnect';
type SourceEnableGuard = { draftHash: string; httpBaseline?: HttpBaselineEntry[]; beforeWrite(): string };
type AsyncTracker = <T>(pending: Promise<T>) => Promise<T>;
type CollectionGuard = { signal: AbortSignal; isLive(): boolean; trackAsync?: AsyncTracker };
type PreviewGuard = { signal?: AbortSignal; assertLive(): void | Promise<void>; trackAsync?: AsyncTracker };

export type RssHistoryActor = Principal & { callerId: string; authEpoch: number };
type RssEvidence = { event_id: string; response_url: string; response_hash: string; byte_length: number };
type PreparedHistory = { sourceId: string; configRevision: number; evidence: RssEvidence; selection: RssHistorySelection };
type HistoryRow = {
  plan_id: string; source_id: string; account_id: string; data_domain: string; caller_id: string; auth_epoch: number;
  config_revision: number; evidence_event_id: string; response_hash: string; selection_hash: string;
  plan_hash: string; summary: string; expires_at: string; created_at: string;
};
export type RssHistoryReceipt = {
  receipt_id: string; applied_at: string; selected_objects: number; imported_objects: number; existing_objects: number;
};
type HistorySummary = {
  plan_id: string; source_id: string; config_revision: number; plan_hash: string; response_hash: string;
  expires_at: string; target: string; response_url: string;
  range: { from: string; until: string }; budget: { max_objects: number; max_bytes: number };
  cost: {
    evidence_bytes: number; eligible_objects: number; eligible_bytes: number; selected_objects: number;
    selected_bytes: number; total_bytes: number; omitted_objects: number; unknown_date_objects: number;
    outside_range_objects: number; additional_network_requests: 0; coverage: 'feed_snapshot_only';
  };
};
export type RssHistoryView = HistorySummary & {
  state: 'pending' | 'expired' | 'stale' | 'applied'; receipt: RssHistoryReceipt | null;
};

export type SourceRegistry = {
  prepareRssHistory(actor: RssHistoryActor, sourceId: string, expectedRevision: number, limits: RssHistoryLimits): Promise<PreparedHistory>;
  freezeRssHistory(actor: RssHistoryActor, planId: string, prepared: PreparedHistory): RssHistoryView;
  readRssHistory(actor: RssHistoryActor, planId: string, sourceId?: string): RssHistoryView;
  inspectRssHistory(actor: RssHistoryActor, planId: string, planHash: string): { revision: number; planHash: string; expiresAt: string };
  validateRssHistory(actor: RssHistoryActor, planId: string, planHash: string): Promise<void>;
  importRssHistory(actor: RssHistoryActor, planId: string, planHash: string, revision: number, beforeWrite: () => string):
    Promise<{ receipt: RssHistoryReceipt; created: boolean }>;
  detectSource(principal: Principal, draft: SourceDraft, guard?: PreviewGuard): Promise<SourcePreview>;
  enableSource(principal: Principal, draft: SourceDraft, guard?: SourceEnableGuard): Promise<CollectionReceipt>;
  inspectHttpDraft(principal: Principal, draft: SourceDraft): { draftHash: string; sourceId: string | null; revision: number };
  describeHttpSource(principal: Principal, sourceId: string): { revision: number; status: SourceStatus; frequency: string; binding: string };
  changeHttpSource(principal: Principal, sourceId: string, operation: HttpSourceOperation, expectedRevision: number,
    frequency: string | undefined, beforeWrite: () => string): { changed: boolean; revision: number; status: SourceStatus };
  /** Inspects a draft of any connector type. A directory draft resolves its root on disk. */
  inspectSourceDraft(principal: Principal, draft: SourceDraft): Promise<{ draftHash: string; sourceId: string | null; revision: number }>;
  describeSource(principal: Principal, sourceId: string): { revision: number; status: SourceStatus; frequency: string;
    binding: string; target: string };
  changeSource(principal: Principal, sourceId: string, operation: SourceOperation, expectedRevision: number,
    frequency: string | undefined, beforeWrite: () => string): { changed: boolean; revision: number; status: SourceStatus };
  pauseSource(sourceId: string): Promise<CollectionReceipt>;
  collectSource(sourceId: string, configRevision: number, guard?: CollectionGuard): Promise<CollectionReceipt>;
  ingestGithubWebhook(input: GithubWebhookInput): Promise<CollectionReceipt>;
  wakeDirectory(sourceId: string, relativePath: string): Promise<{ read: boolean; receipt: CollectionReceipt | null }>;
};

export type RegistryOptions = {
  /** Trusted in-process owner retains actual port work beyond logical cancellation. */
  trackAsync?: AsyncTracker;
  blobs: BlobStore;
  now?: () => string;
  githubFixtureRoot?: string;
  /** The live GitHub reader. Without it the connector stays on the fixture tree. */
  githubApi?: GithubApiPort;
  /** The provider that holds the GitHub token a source references. */
  credentials?: { resolve(reference: string): Uint8Array | null };
  beforeCursorCommit?: () => void;
  http?: {
    approvedUrls(principal: Principal, target: string, type: HttpConnectorType): readonly string[] | null;
    port?: HttpReadPort;
  };
};

type SourceStatus = 'enabled' | 'paused' | 'offline' | 'placeholder' | 'disconnected';

type SourceRecord = {
  source_id: string;
  account_id: string;
  data_domain: string;
  connector_type: ConnectorType;
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
  connectorType: ConnectorType;
  normalizedTarget: string;
  physicalRoot: string;
  scope: SourceScope;
  excludes: string[];
  credentialRef: string | null;
  frequency: string;
  history: 'none' | 'backfill';
  hasTriggerRule: boolean;
  triggerMandateTypeId: string | null;
};

type PendingObject = { locator: string; bytes: Uint8Array; hash: string };
type DirectorySnapshot = { source: SourceRecord; cursor: CursorRecord; generation: number };

const PREVIEW_TTL_MS = 15 * 60 * 1000;
const HISTORY_TTL_MS = 10 * 60 * 1000;
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

  function rejected(source: Pick<SourceRecord, 'source_id' | 'config_revision'> | undefined, sourceId: string, configRevision: number, cursor: string, reason: string,
    observedAt = clock()): CollectionReceipt {
    return {
      eventId: '',
      sourceId: source?.source_id ?? sourceId,
      configRevision: source?.config_revision ?? configRevision,
      kind: 'failure',
      cursor,
      count: 0,
      evidenceRef: null,
      observedAt,
      accepted: false,
      reason,
    };
  }

  function statusReason(status: SourceStatus | undefined): string {
    if (status === 'offline') return 'OFFLINE';
    if (status === 'placeholder') return 'PLACEHOLDER';
    if (status === 'disconnected') return 'DISCONNECTED';
    return 'PAUSED';
  }

  function setStatus(sourceId: string, status: SourceStatus, directory?: DirectorySnapshot): CollectionReceipt {
    return withImmediateTransaction(db, () => {
      const current = load(sourceId);
      if (!current) throw new Error('SOURCE_NOT_FOUND');
      const cursor = loadCursor(sourceId);
      if (directory) {
        const live = finalCollection(directory.source, directory.source.config_revision, clock());
        if (isReceipt(live)) return live;
        if (directoryGeneration(live.source) !== directory.generation) {
          return rejected(live.source, sourceId, live.source.config_revision, cursor.cursor, 'STALE_COLLECTION');
        }
      }
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
    assertRecoveryWriteAllowed(db, source.data_domain);
    const cursor = loadCursor(sourceId);
    if (source.status !== 'enabled') return rejected(source, sourceId, configRevision, cursor.cursor, statusReason(source.status));
    if (source.config_revision !== configRevision) return rejected(source, sourceId, configRevision, cursor.cursor, 'STALE_REVISION');
    return { source, cursor };
  }

  function finalCollection(source: SourceRecord, configRevision: number, observedAt: string): { source: SourceRecord; cursor: CursorRecord } | CollectionReceipt {
    const current = load(source.source_id);
    const cursor = loadCursor(source.source_id);
    if (!current || current.status !== 'enabled') {
      return rejected(current, source.source_id, configRevision, cursor.cursor, statusReason(current?.status), observedAt);
    }
    assertRecoveryWriteAllowed(db, current.data_domain);
    if (current.config_revision !== configRevision) {
      return rejected(current, source.source_id, configRevision, cursor.cursor, 'STALE_REVISION', observedAt);
    }
    if (canonicalPayload(current) !== canonicalPayload(source)) {
      return rejected(current, current.source_id, current.config_revision, cursor.cursor, 'SOURCE_IDENTITY_CHANGED', observedAt);
    }
    return { source: current, cursor };
  }

  function isReceipt(value: { source: SourceRecord; cursor: CursorRecord } | CollectionReceipt): value is CollectionReceipt {
    return 'accepted' in value;
  }

  function directoryGeneration(source: SourceRecord): number {
    const row = db.prepare(`SELECT commit_generation FROM directory_commit_generations
      WHERE source_id=? AND account_id=? AND data_domain=? AND connector_type='directory'`)
      .get(source.source_id, source.account_id, source.data_domain) as { commit_generation: number } | undefined;
    if (!row || !Number.isSafeInteger(row.commit_generation) || row.commit_generation < 0) {
      throw new Error('SOURCE_GENERATION_MISSING');
    }
    return row.commit_generation;
  }

  function directorySnapshot(source: SourceRecord, configRevision: number): DirectorySnapshot | CollectionReceipt {
    return withImmediateTransaction(db, () => {
      const live = finalCollection(source, configRevision, clock());
      if (isReceipt(live)) return live;
      return { ...live, generation: directoryGeneration(live.source) };
    });
  }

  async function normalize(principal: Principal, draft: SourceDraft): Promise<NormalizedDraft> {
    if (draft.type === 'directory') assertDirectoryReaderAvailable();
    if (!principal.accountId || !principal.dataDomain) throw new Error('SOURCE_PRINCIPAL_INVALID');
    assertNoCredential(draft.target);
    if (draft.credentialRef) assertNoCredential(draft.credentialRef);
    const excludes = [...new Set(draft.excludes ?? [])].sort();
    const frequency = draft.frequency ?? 'poll';
    const history = draft.history ?? 'none';
    if (history !== 'none' && history !== 'backfill') throw new Error('SOURCE_HISTORY_INVALID');
    const hasTriggerRule = draft.hasTriggerRule ?? false;
    const triggerMandateTypeId = draft.triggerMandateTypeId ?? null;
    if (isHttpConnector(draft.type)) return normalizeHttp(principal, { ...draft, type: draft.type });
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
        triggerMandateTypeId,
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
      triggerMandateTypeId,
    };
  }

  function normalizeHttp(principal: Principal, draft: SourceDraft & { type: HttpConnectorType }): NormalizedDraft {
    const { history = 'none', frequency = 'poll', hasTriggerRule = false } = draft;
    if (!principal.accountId || !principal.dataDomain || draft.repo || draft.branch || draft.path || draft.credentialRef ||
        history !== 'none' || draft.excludes?.length || !httpFrequencies.some((option) => option === frequency)) {
      throw new Error('SOURCE_HTTP_SCOPE_INVALID');
    }
    assertNoCredential(draft.target);
    const target = sourceUrl(draft.target).href;
    const httpTargets = approvedHttpTargets(principal, target, draft.type);
    return { connectorType: draft.type, normalizedTarget: target, physicalRoot: 'http-source:' + target,
      scope: { repo: null, branch: null, path: null, root: null, excludes: [], httpTargets }, excludes: [],
      credentialRef: null, frequency, history, hasTriggerRule, triggerMandateTypeId: draft.triggerMandateTypeId ?? null };
  }

  function sameRoot(principal: Principal, normalized: NormalizedDraft) {
    const existing = findRoot(normalized.physicalRoot);
    if (existing && (existing.account_id !== principal.accountId || existing.data_domain !== principal.dataDomain ||
        existing.connector_type !== normalized.connectorType)) {
      throw new Error('SOURCE_ROOT_TAKEN');
    }
    return existing;
  }

  function scopedHttp(principal: Principal, sourceId: string) {
    const row = load(sourceId);
    if (!row || row.account_id !== principal.accountId || row.data_domain !== principal.dataDomain || !isHttpConnector(row.connector_type)) {
      throw new Error('SOURCE_NOT_FOUND');
    }
    return { ...row, connector_type: row.connector_type };
  }

  /** Reads a source of any connector type that belongs to the principal. */
  function scopedSource(principal: Principal, sourceId: string) {
    const row = load(sourceId);
    if (!row || row.account_id !== principal.accountId || row.data_domain !== principal.dataDomain) {
      throw new Error('SOURCE_NOT_FOUND');
    }
    return { ...row, connector_type: row.connector_type };
  }

  function inspectHttpDraftOf(principal: Principal, draft: SourceDraft) {
    if (!isHttpConnector(draft.type)) throw new Error('SOURCE_HTTP_SCOPE_INVALID');
    const normalized = normalizeHttp(principal, { ...draft, type: draft.type });
    const existing = sameRoot(principal, normalized);
    return { draftHash: hashDraft(principal, normalized), sourceId: existing?.source_id ?? null, revision: existing?.config_revision ?? 0 };
  }

  function findRoot(physicalRoot: string): SourceRecord | undefined {
    const row = db.prepare('SELECT source_id FROM source_configs WHERE physical_root = ?').get(physicalRoot) as { source_id: string } | undefined;
    return row ? load(row.source_id) : undefined;
  }

  function overlaps(physicalRoot: string): boolean {
    if (rootsConflict('SELECT physical_root FROM source_configs', physicalRoot)) return true;
    const vaults = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'vaults'").get();
    if (!vaults) return false;
    return rootsConflict('SELECT physical_root FROM vaults', physicalRoot);
  }

  function rootsConflict(sql: string, physicalRoot: string): boolean {
    const rows = db.prepare(sql).all() as { physical_root: string }[];
    return rows.some((row) => row.physical_root === physicalRoot || pathsOverlap(row.physical_root, physicalRoot));
  }

  function approvedHttpTargets(principal: Principal, target: string, type: HttpConnectorType): string[] {
    const urls = options.http?.approvedUrls(principal, target, type);
    if (!urls || urls.length > 32) throw new Error('SOURCE_TARGET_OUTSIDE_SCOPE');
    const normalized = [...new Set(urls.map((url) => sourceUrl(url).href))].sort();
    if (!normalized.includes(target)) throw new Error('SOURCE_TARGET_OUTSIDE_SCOPE');
    return normalized;
  }

  function checkHttpScope(principal: Principal, target: string, type: HttpConnectorType, scope: SourceScope): string[] {
    if (!scope.httpTargets?.length) throw new Error('SOURCE_TARGET_OUTSIDE_SCOPE');
    const active = new Set(approvedHttpTargets(principal, target, type));
    if (!scope.httpTargets.includes(target) || !scope.httpTargets.every((value) => active.has(value))) {
      throw new Error('SOURCE_TARGET_OUTSIDE_SCOPE');
    }
    return scope.httpTargets;
  }

  async function readHttp(principal: Principal, sourceId: string, target: string, type: HttpConnectorType,
    scope: SourceScope, live?: () => boolean, guard?: PreviewGuard) {
    const allowedUrls = checkHttpScope(principal, target, type, scope);
    const raw = await readRegisteredHttp({ sourceId, accountId: principal.accountId, dataDomain: principal.dataDomain, target, allowedUrls },
      options.http?.port, { signal: guard?.signal, trackAsync: guard?.trackAsync ?? options.trackAsync, async stillAllowed(next) {
        await guard?.assertLive();
        return (!live || live()) && checkHttpScope(principal, target, type, scope).includes(next);
      } });
    checkHttpScope(principal, target, type, scope);
    const contentType = raw.contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
    let items: { locator: string; stable: true; bytes: Uint8Array }[];
    if (type === 'rss') {
      if (!['application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml'].includes(contentType)) throw new Error('SOURCE_MEDIA_TYPE');
      items = parseFeed(raw.bytes, raw.url).map(({ key, title, link, text }) => ({
        locator: key, stable: true, bytes: new TextEncoder().encode(JSON.stringify({ title, link, text })),
      }));
    } else {
      if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') throw new Error('SOURCE_MEDIA_TYPE');
      items = [{ locator: target, stable: true, bytes: new TextEncoder().encode(extractPage(raw.bytes).text) }];
    }
    return { items, raw, contentType };
  }

  async function samplesFor(draft: NormalizedDraft): Promise<Array<{ locator: string; byteLength: number }>> {
    if (draft.connectorType === 'directory') {
      const root = draft.scope.root;
      if (!root) throw new Error('SOURCE_TARGET_INVALID');
      return (await listSamples(root, draft.excludes)).map((sample) => ({ locator: sample.relativePath, byteLength: sample.byteLength }));
    }
    const scope = githubScope(draft.scope);
    if (options.githubApi) {
      const token = githubToken(draft.credentialRef);
      const entries = await options.githubApi.listTree({ repo: scope.repo, branch: scope.branch, token });
      const prefix = normalizeGithubPath(scope.path);
      return entries
        .filter((entry) => entry.type === 'blob' && entry.path.startsWith(`${prefix}/`) && !draft.excludes.includes(entry.path))
        .map((entry) => ({ locator: entry.path, byteLength: entry.size }));
    }
    const root = githubRoot(scope);
    return (await listGithubFixtureSamples(root, draft.excludes)).map((sample) => ({
      locator: `${scope.path}/${sample.relativePath}`,
      byteLength: sample.byteLength,
    }));
  }

  /** Reads every approved object of a branch over the live GitHub API. */
  async function githubLiveObjects(scope: GithubScope, excludes: Set<string>, token: string):
  Promise<Array<{ locator: string; bytes: Uint8Array }>> {
    const api = options.githubApi;
    if (!api) throw new Error('GITHUB_API_REQUIRED');
    const entries = await api.listTree({ repo: scope.repo, branch: scope.branch, token });
    const prefix = normalizeGithubPath(scope.path);
    if (!prefix) throw new Error('SOURCE_SCOPE_INVALID');
    const objects: Array<{ locator: string; bytes: Uint8Array }> = [];
    for (const entry of entries) {
      if (entry.type !== 'blob') continue;
      const relative = normalizeGithubPath(entry.path);
      if (!relative || relative !== prefix && !relative.startsWith(`${prefix}/`)) continue;
      if (excludes.has(relative)) continue;
      objects.push({ locator: relative, bytes: await api.readBlob({ repo: scope.repo, sha: entry.sha, token }) });
    }
    return objects;
  }

  /** Resolves the token of a GitHub source from the credential provider. */
  function githubToken(credentialRef: string | null): string {
    if (!credentialRef) throw new Error('GITHUB_CREDENTIAL_REQUIRED');
    const secret = options.credentials?.resolve(credentialRef);
    if (!secret) throw new Error('GITHUB_CREDENTIAL_UNAVAILABLE');
    const token = Buffer.from(secret).toString('utf8').trim();
    if (!token) throw new Error('GITHUB_CREDENTIAL_UNAVAILABLE');
    return token;
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
    if (isHttpConnector(source.connector_type)) {
      const saved = db.prepare(`SELECT event_id AS eventId,source_id AS sourceId,config_revision AS configRevision,kind,cursor,
        object_count AS count,evidence_ref AS evidenceRef,observed_at AS observedAt,accepted,reason FROM collection_receipts
        WHERE source_id=? AND kind='enable' ORDER BY config_revision ASC LIMIT 1`).get(source.source_id) as
        (Omit<CollectionReceipt, 'accepted'> & { accepted: number }) | undefined;
      if (!saved) throw new Error('SOURCE_ENABLE_RECEIPT_MISSING');
      return { ...saved, accepted: saved.accepted === 1 };
    }
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

  function assertSourceWrite(sourceId: string): void {
    const source = load(sourceId);
    if (!source) throw new Error('SOURCE_NOT_FOUND');
    assertRecoveryWriteAllowed(db, source.data_domain);
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
      assertSourceWrite(sourceId);
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
    guard?: CollectionGuard;
    directoryGeneration?: number;
    httpEvidence?: { url: string; hash: string; length: number; contentType: string; baseline: HttpBaselineEntry[]; baselineAlreadyObserved: boolean };
  }): CollectionReceipt {
    return withImmediateTransaction(db, () => {
      options.beforeCursorCommit?.();
      const prepared = load(input.source.source_id);
      if (input.httpEvidence && prepared?.status === 'enabled' && prepared.config_revision === input.configRevision) {
        if (!isHttpConnector(prepared.connector_type)) throw new Error('SOURCE_TYPE_INVALID');
        checkHttpScope({ accountId: prepared.account_id, dataDomain: prepared.data_domain },
          prepared.normalized_target, prepared.connector_type, parseScope(prepared.scope_json));
      }
      const observedAt = clock();
      const leaseLive = !input.guard || (input.guard.isLive() && !input.guard.signal.aborted);
      const live = finalCollection(input.source, input.configRevision, observedAt);
      if (isReceipt(live)) return live;
      const { source: current, cursor } = live;
      if (!leaseLive) {
        return rejected(current, current.source_id, current.config_revision, cursor.cursor, 'SOURCE_LEASE_CHANGED', observedAt);
      }
      if (current.connector_type === 'directory') {
        if (input.directoryGeneration === undefined) throw new Error('SOURCE_GENERATION_MISSING');
        const generation = directoryGeneration(current);
        if (generation !== input.directoryGeneration) {
          return rejected(current, current.source_id, current.config_revision, cursor.cursor, 'STALE_COLLECTION', observedAt);
        }
        if (generation === Number.MAX_SAFE_INTEGER) throw new Error('SOURCE_GENERATION_EXHAUSTED');
        const advanced = db.prepare(`UPDATE directory_commit_generations SET commit_generation=commit_generation+1
          WHERE source_id=? AND account_id=? AND data_domain=? AND commit_generation=?`)
          .run(current.source_id, current.account_id, current.data_domain, generation);
        if (advanced.changes !== 1) throw new Error('SOURCE_GENERATION_CONFLICT');
      }
      let baseline: Map<string, string> | null = null;
      if (input.httpEvidence) {
        baseline = httpBaselineFor(current.source_id);
        if (!input.httpEvidence.baselineAlreadyObserved && baseline) {
          return rejected(current, current.source_id, current.config_revision, cursor.cursor, 'SOURCE_BASELINE_CHANGED', observedAt);
        }
        if (!baseline) {
          db.prepare('INSERT INTO http_source_baselines(source_id,entries) VALUES (?,?)')
            .run(current.source_id, JSON.stringify(input.httpEvidence.baseline));
          baseline = new Map(input.httpEvidence.baseline);
        }
      }
      if (input.deliveryId) {
        const duplicate = db.prepare('SELECT 1 AS ok FROM webhook_deliveries WHERE event_id = ?').get(input.deliveryId);
        if (duplicate) return rejected(current, input.source.source_id, input.configRevision, cursor.cursor, 'DUPLICATE_EVENT', observedAt);
      }
      let count = 0;
      for (const object of input.changed) {
        if (baseline && !eligibleHttpItem(current.source_id, baseline, object.locator, object.hash)) continue;
        if (applyContent(current, object, observedAt)) count += 1;
      }
      let withdrew = false;
      if (input.confirmDeletes) withdrew = confirmMissing(current, input.onDisk, input.unstable, observedAt);
      const prior = db.prepare(`SELECT COUNT(*) AS n FROM collection_receipts
        WHERE source_id = ? AND accepted = 1 AND kind IN ('first_collection', 'success')`).get(current.source_id) as { n: number };
      const kind: CollectionKind = withdrew ? 'withdraw' : prior.n === 0 ? 'first_collection' : 'success';
      const phase = prior.n === 0 ? 'first_collected' : 'advanced';
      const advancesSweep = (input.confirmDeletes || input.httpEvidence) && !input.deliveryId;
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
      if (input.httpEvidence) {
        const evidence = input.httpEvidence;
        db.prepare('INSERT INTO blobs(sha256,byte_length,created_at) VALUES (?,?,?) ON CONFLICT(sha256) DO NOTHING')
          .run(evidence.hash, evidence.length, observedAt);
        db.prepare(`INSERT INTO http_source_response_evidence(event_id,source_id,config_revision,response_url,response_hash,content_type,created_at)
          VALUES (?,?,?,?,?,?,?)`).run(eventId, current.source_id, current.config_revision, evidence.url, evidence.hash, evidence.contentType, observedAt);
      }
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

  function recordRevisionProvenance(source: SourceRecord, revisionId: string): void {
    db.prepare(`INSERT INTO source_revision_provenance (revision_id, source_id, config_revision, account_id, data_domain)
      VALUES (?, ?, ?, ?, ?)`).run(revisionId, source.source_id, source.config_revision, source.account_id, source.data_domain);
  }

  function applyContent(source: SourceRecord, object: PendingObject, observedAt: string, allowWork = true): boolean {
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
    recordRevisionProvenance(source, revisionId);
    const change: CollectedChange = {
      hasTriggerRule: source.has_trigger_rule === 1,
      origin: 'source',
      kind: existing ? 'modify' : 'create',
      matchesScope: true,
      excluded: false,
    };
    if (allowWork && admitChange(change)) {
      appendDomainEvent(db, {
        eventId: `work:${revisionId}`,
        aggregateId: objectId,
        aggregateVersion: seq,
        accountId: source.account_id,
        dataDomain: source.data_domain,
        payload: { admitted: true, objectId, kind: change.kind, sourceId: source.source_id, revisionId },
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
    recordRevisionProvenance(source, revisionId);
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
      const duplicate = db.prepare('SELECT 1 AS ok FROM webhook_deliveries WHERE event_id = ?').get(deliveryId);
      if (duplicate) return rejected(source, source.source_id, source.config_revision, loadCursor(source.source_id).cursor, 'DUPLICATE_EVENT');
      const observedAt = clock();
      const live = finalCollection(source, source.config_revision, observedAt);
      if (isReceipt(live)) return live;
      rememberDelivery(live.source.source_id, deliveryId, observedAt);
      return rejected(live.source, source.source_id, live.source.config_revision, live.cursor.cursor, reason, observedAt);
    });
  }

  function httpBaselineFor(sourceId: string): Map<string, string> | null {
    const row = db.prepare('SELECT entries FROM http_source_baselines WHERE source_id=?').get(sourceId) as { entries: string } | undefined;
    return row ? new Map(JSON.parse(row.entries) as HttpBaselineEntry[]) : null;
  }

  function eligibleHttpItem(sourceId: string, baseline: Map<string, string>, locator: string, hash: string): boolean {
    return baseline.get(locatorHash(locator)) !== hash ||
      !!db.prepare('SELECT 1 FROM source_objects WHERE source_id=? AND locator=?').get(sourceId, locator);
  }

  async function collectHttp(source: SourceRecord, configRevision: number, type: HttpConnectorType, scope: SourceScope, guard?: CollectionGuard): Promise<CollectionReceipt> {
    const principal = { accountId: source.account_id, dataDomain: source.data_domain };
    let read: Awaited<ReturnType<typeof readHttp>>;
    try {
      read = await readHttp(principal, source.source_id, source.normalized_target, type, scope,
        () => !isReceipt(gate(source.source_id, configRevision)) && (!guard || guard.isLive()),
        guard ? { signal: guard.signal, trackAsync: guard.trackAsync, assertLive: () => {} } : undefined);
    }
    catch (error) {
      const reason = error instanceof Error && sourceReadFailures.has(error.message) ? error.message : 'SOURCE_HTTP_UNAVAILABLE';
      return withImmediateTransaction(db, () => {
        const observedAt = clock();
        const leaseLive = !guard || (guard.isLive() && !guard.signal.aborted);
        const live = finalCollection(source, configRevision, observedAt);
        if (isReceipt(live)) return live;
        if (!leaseLive) {
          return rejected(live.source, source.source_id, configRevision, live.cursor.cursor, 'SOURCE_LEASE_CHANGED', observedAt);
        }
        const prior = db.prepare('SELECT COUNT(*) AS n FROM collection_receipts WHERE source_id=?').get(source.source_id) as { n: number };
        const failed = { ...rejected(live.source, source.source_id, configRevision, live.cursor.cursor, reason, observedAt),
          eventId: `collect:${source.source_id}:${configRevision}:failure:${prior.n + 1}` };
        insertReceipt(db, failed);
        return failed;
      });
    }
    const stillOpen = gate(source.source_id, configRevision);
    if (isReceipt(stillOpen)) return stillOpen;
    if (guard && !guard.isLive()) return rejected(stillOpen.source, source.source_id, configRevision, stillOpen.cursor.cursor, 'SOURCE_LEASE_CHANGED');
    const fingerprints = fingerprintHttpItems(read.items);
    // Outside the write transaction this only avoids storing ignored item blobs. The writer rechecks baseline membership.
    const frozenBaseline = httpBaselineFor(source.source_id);
    const previous = frozenBaseline ?? new Map(fingerprints);
    const items = read.items.filter(({ locator, bytes }) => eligibleHttpItem(source.source_id, previous, locator, sha256(bytes)));
    const staged = await stage(source.source_id, items);
    assertSourceWrite(source.source_id);
    const hash = await options.blobs.putBlob(read.raw.bytes);
    return commitSweep({ source, configRevision, ...staged, guard, confirmDeletes: false, evidenceRef: hash,
      httpEvidence: { hash, length: read.raw.bytes.byteLength, url: read.raw.url, contentType: read.contentType, baseline: fingerprints, baselineAlreadyObserved: frozenBaseline !== null } });
  }

  async function collectFiles(source: SourceRecord, configRevision: number): Promise<CollectionReceipt> {
    const scope = parseScope(source.scope_json);
    const excludes = JSON.parse(source.excludes_json) as string[];
    if (isHttpConnector(source.connector_type)) return collectHttp(source, configRevision, source.connector_type, scope);
    if (source.connector_type === 'github') {
      const github = githubScope(scope);
      if (options.githubApi) {
        // The live reader collects the approved branch over the API and confirms
        // deletions the same way the local scan does.
        const objects = await githubLiveObjects(github, new Set(excludes), githubToken(source.credential_ref));
        const staged = await stage(source.source_id, objects.map((object) => ({
          locator: object.locator,
          stable: true,
          bytes: object.bytes,
        })));
        const hash = staged.changed[0]?.hash ?? null;
        return commitSweep({
          source,
          configRevision,
          ...staged,
          confirmDeletes: true,
          evidenceRef: hash ? `github-api:${hash}` : null,
        });
      }
      const scan = await scanGithubFixture(githubRoot(github), excludes);
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
    const directory = directorySnapshot(source, configRevision);
    if (isReceipt(directory)) return directory;
    // The directory is read through the trusted reader, which never follows a
    // link out of the approved root and bounds every object it reads.
    const listing = await listDirectory(root, excludes);
    if (listing.state === 'offline') return setStatus(source.source_id, 'offline', directory);
    if (listing.state === 'placeholder') return setStatus(source.source_id, 'placeholder', directory);
    const files: Array<{ locator: string; stable: boolean; bytes?: Uint8Array }> = [];
    for (const entry of listing.entries) {
      if (!entry.stable) {
        files.push({ locator: entry.relativePath, stable: false });
        continue;
      }
      const read = await readDirectoryFile(entry);
      if (read.state === 'read') files.push({ locator: entry.relativePath, stable: true, bytes: read.bytes });
    }
    const staged = await stage(source.source_id, files);
    return commitSweep({
      source,
      configRevision,
      ...staged,
      confirmDeletes: true,
      evidenceRef: staged.changed[0]?.hash ?? null,
      directoryGeneration: directory.generation,
    });
  }

  function rssSourceRow(actor: RssHistoryActor, sourceId: string, revision: number) {
    const row = scopedHttp(actor, sourceId);
    if (row.connector_type !== 'rss') throw new Error('SOURCE_HISTORY_INVALID');
    if (row.config_revision !== revision || row.status !== 'enabled') throw new Error('SOURCE_HISTORY_STALE');
    return row;
  }

  function rssSource(actor: RssHistoryActor, sourceId: string, revision: number) {
    const row = rssSourceRow(actor, sourceId, revision);
    return { row, scope: { sourceId, accountId: actor.accountId, dataDomain: actor.dataDomain,
      target: row.normalized_target, allowedUrls: checkHttpScope(actor, row.normalized_target, 'rss', parseScope(row.scope_json)) } };
  }

  function rssEvidence(sourceId: string, revision: number, eventId: string): RssEvidence {
    const row = db.prepare(`SELECT e.event_id,e.response_url,e.response_hash,b.byte_length
      FROM http_source_response_evidence e JOIN collection_receipts c ON c.event_id=e.event_id
      JOIN blobs b ON b.sha256=e.response_hash
      WHERE e.source_id=? AND e.config_revision=? AND e.event_id=?
        AND c.source_id=e.source_id AND c.config_revision=e.config_revision
        AND c.accepted=1 AND c.kind IN ('first_collection','success') AND c.evidence_ref=e.response_hash
        AND e.content_type IN ('application/rss+xml','application/atom+xml','application/xml','text/xml')`)
      .get(sourceId, revision, eventId) as RssEvidence | undefined;
    if (!row) throw new Error('SOURCE_HISTORY_EVIDENCE_REQUIRED');
    return row;
  }

  function latestRssEvidence(sourceId: string, revision: number) {
    return rssEvidence(sourceId, revision, `collect:${sourceId}:${revision}:sweep:${loadCursor(sourceId).sweep_count}`);
  }

  async function selectHistory(scope: RegisteredHttpSource, evidence: RssEvidence, limits: RssHistoryLimits) {
    // Check cost before reading a blob; the file must still match its recorded byte length and digest.
    if (evidence.byte_length > limits.maxBytes) throw new Error('SOURCE_HISTORY_BUDGET_EXCEEDED');
    let bytes: Uint8Array;
    try { bytes = await options.blobs.readBlob(evidence.response_hash); }
    catch { throw new Error('SOURCE_HISTORY_EVIDENCE_REQUIRED'); }
    if (bytes.byteLength !== evidence.byte_length || sha256(bytes) !== evidence.response_hash) {
      throw new Error('SOURCE_HISTORY_EVIDENCE_REQUIRED');
    }
    return planRssHistory(scope, limits, { requestedTarget: scope.target, url: evidence.response_url, bytes });
  }

  function historyRow(actor: RssHistoryActor, planId: string, sourceId?: string): HistoryRow {
    const row = db.prepare(`SELECT * FROM http_source_history_plans WHERE plan_id=? AND account_id=? AND data_domain=?
      AND caller_id=? AND auth_epoch=?`).get(planId, actor.accountId, actor.dataDomain, actor.callerId, actor.authEpoch) as HistoryRow | undefined;
    if (!row || (sourceId !== undefined && row.source_id !== sourceId)) throw new Error('SOURCE_NOT_FOUND');
    return row;
  }

  function historyReceipt(planId: string): RssHistoryReceipt | null {
    return db.prepare(`SELECT receipt_id,applied_at,selected_objects,imported_objects,existing_objects
      FROM http_source_history_receipts WHERE plan_id=?`).get(planId) as RssHistoryReceipt | undefined ?? null;
  }

  function loadHistory(actor: RssHistoryActor, planId: string, planHash: string, observedAt: string) {
    const plan = historyRow(actor, planId);
    verifiedHistorySummary(plan);
    if (plan.plan_hash !== planHash || plan.expires_at <= observedAt) {
      throw new Error('SOURCE_HISTORY_STALE');
    }
    const row = rssSourceRow(actor, plan.source_id, plan.config_revision);
    const evidence = rssEvidence(plan.source_id, plan.config_revision, plan.evidence_event_id);
    if (plan.response_hash !== evidence.response_hash || !parseScope(row.scope_json).httpTargets?.includes(evidence.response_url)) {
      throw new Error('SOURCE_HISTORY_STALE');
    }
    return { plan, row, evidence };
  }

  function requireHistory(actor: RssHistoryActor, planId: string, planHash: string) {
    const current = loadHistory(actor, planId, planHash, clock());
    const { row } = current;
    const scope = { sourceId: row.source_id, accountId: actor.accountId, dataDomain: actor.dataDomain,
      target: row.normalized_target, allowedUrls: checkHttpScope(actor, row.normalized_target, 'rss', parseScope(row.scope_json)) };
    return { ...current, scope };
  }

  async function verifyFrozenHistory({ plan, scope, evidence }: ReturnType<typeof requireHistory>) {
    const summary = verifiedHistorySummary(plan);
    const selection = await selectHistory(scope, evidence, { ...summary.range, maxObjects: summary.budget.max_objects,
      maxBytes: summary.budget.max_bytes });
    const expected = historySummary(plan.plan_id, plan.config_revision, plan.expires_at, selection);
    if (selection.planHash !== plan.selection_hash ||
        canonicalPayload(summary) !== canonicalPayload({ ...expected, plan_hash: plan.plan_hash })) throw new Error('SOURCE_HISTORY_STALE');
    return selection;
  }

  function planView(actor: RssHistoryActor, plan: HistoryRow): RssHistoryView {
    const receipt = historyReceipt(plan.plan_id);
    let state: RssHistoryView['state'] = receipt ? 'applied' : plan.expires_at <= clock() ? 'expired' : 'pending';
    if (state === 'pending') {
      try { requireHistory(actor, plan.plan_id, plan.plan_hash); }
      catch (error) {
        if (error instanceof Error && ['SOURCE_HISTORY_STALE', 'SOURCE_HISTORY_EVIDENCE_REQUIRED',
          'SOURCE_TARGET_OUTSIDE_SCOPE'].includes(error.message)) state = 'stale';
        else throw error;
      }
    }
    return { ...verifiedHistorySummary(plan), state, receipt };
  }

  return {
    async prepareRssHistory(actor, sourceId, expectedRevision, limits) {
      const { scope } = rssSource(actor, sourceId, expectedRevision);
      const evidence = latestRssEvidence(sourceId, expectedRevision);
      const selection = await selectHistory(scope, evidence, limits);
      return { sourceId, configRevision: expectedRevision, evidence, selection };
    },

    freezeRssHistory(actor, planId, prepared) {
      // The route writes its command and freezes the plan in the same transaction.
      if (!db.inTransaction) throw new Error('SOURCE_HISTORY_WRITE_FENCE');
      const { sourceId, configRevision, selection } = prepared;
      const { row, scope } = rssSource(actor, sourceId, configRevision);
      const evidence = latestRssEvidence(sourceId, configRevision);
      const plan = selection.plan;
      if (evidence.event_id !== prepared.evidence.event_id || evidence.response_hash !== plan.responseHash ||
          evidence.response_url !== plan.responseUrl || canonicalPayload(scope) !== canonicalPayload({
            ...plan.scope, allowedUrls: [...plan.scope.allowedUrls],
          })) throw new Error('SOURCE_HISTORY_STALE');
      const createdAt = clock();
      const expiresAt = new Date(Date.parse(createdAt) + HISTORY_TTL_MS).toISOString();
      const displayed = historySummary(planId, configRevision, expiresAt, selection);
      const planHash = historyPlanDigest({ plan_id: planId, caller_id: actor.callerId, auth_epoch: actor.authEpoch,
        config_revision: configRevision, evidence_event_id: evidence.event_id, expires_at: expiresAt, selection_hash: selection.planHash }, displayed);
      const summary: HistorySummary = { ...displayed, plan_hash: planHash };
      const current = rssSourceRow(actor, sourceId, configRevision);
      const currentEvidence = latestRssEvidence(sourceId, configRevision);
      if (canonicalPayload(current) !== canonicalPayload(row) || canonicalPayload(currentEvidence) !== canonicalPayload(evidence)) {
        throw new Error('SOURCE_HISTORY_STALE');
      }
      assertRecoveryWriteAllowed(db, current.data_domain);
      db.prepare(`INSERT INTO http_source_history_plans (plan_id,source_id,account_id,data_domain,caller_id,auth_epoch,
        config_revision,evidence_event_id,response_hash,selection_hash,plan_hash,summary,expires_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(planId, sourceId, actor.accountId, actor.dataDomain, actor.callerId, actor.authEpoch,
          configRevision, evidence.event_id, evidence.response_hash, selection.planHash, planHash, JSON.stringify(summary), expiresAt, createdAt);
      return { ...summary, state: 'pending', receipt: null };
    },

    readRssHistory(actor, planId, sourceId) {
      return planView(actor, historyRow(actor, planId, sourceId));
    },

    inspectRssHistory(actor, planId, planHash) {
      const { plan } = requireHistory(actor, planId, planHash);
      return { revision: plan.config_revision, planHash: plan.plan_hash, expiresAt: plan.expires_at };
    },

    async validateRssHistory(actor, planId, planHash) {
      const checked = requireHistory(actor, planId, planHash);
      await verifyFrozenHistory(checked);
      const current = requireHistory(actor, planId, planHash);
      if (current.plan.summary !== checked.plan.summary || canonicalPayload(current.scope) !== canonicalPayload(checked.scope)) throw new Error('SOURCE_HISTORY_STALE');
    },

    async importRssHistory(actor, planId, planHash, revision, beforeWrite) {
      const checked = requireHistory(actor, planId, planHash);
      const { plan, scope } = checked;
      if (plan.config_revision !== revision) throw new Error('SOURCE_HISTORY_STALE');
      const prior = historyReceipt(planId);
      if (prior) return withImmediateTransaction(db, () => {
        beforeWrite();
        return { receipt: prior, created: false };
      });
      assertRecoveryWriteAllowed(db, checked.row.data_domain);
      const selection = await verifyFrozenHistory(checked);
      const staged: PendingObject[] = [];
      const existing = db.prepare('SELECT 1 FROM source_objects WHERE source_id=? AND locator=?');
      for (const [index, object] of selection.objects.entries()) {
        // Any current entry takes precedence over the frozen historical copy.
        if (existing.get(plan.source_id, object.key)) continue;
        const bytes = Buffer.from(object.payload);
        assertSourceWrite(plan.source_id);
        const hash = await options.blobs.putBlob(bytes);
        if (hash !== selection.plan.items[index].contentHash) throw new Error('SOURCE_HISTORY_EVIDENCE_REQUIRED');
        staged.push({ locator: object.key, bytes, hash });
      }
      return withImmediateTransaction(db, () => {
        const current = requireHistory(actor, planId, planHash);
        if (current.plan.selection_hash !== selection.planHash || current.plan.config_revision !== revision || current.plan.summary !== plan.summary ||
            canonicalPayload(current.scope) !== canonicalPayload(scope)) {
          throw new Error('SOURCE_HISTORY_STALE');
        }
        // No await between the authoritative settings fence and business rows.
        const appliedAt = beforeWrite();
        const receipt = historyReceipt(planId);
        if (receipt) return { receipt, created: false };
        checkHttpScope(actor, checked.row.normalized_target, 'rss', parseScope(checked.row.scope_json));
        const observedAt = clock();
        const completed = historyReceipt(planId);
        if (completed) return { receipt: completed, created: false };
        const live = loadHistory(actor, planId, planHash, observedAt);
        if (canonicalPayload(live.plan) !== canonicalPayload(current.plan) ||
            canonicalPayload(live.row) !== canonicalPayload(checked.row) ||
            canonicalPayload(live.evidence) !== canonicalPayload(checked.evidence)) {
          throw new Error('SOURCE_HISTORY_STALE');
        }
        assertRecoveryWriteAllowed(db, live.row.data_domain);
        let imported = 0;
        for (const object of staged) {
          if (!existing.get(live.plan.source_id, object.locator) && applyContent(live.row, object, appliedAt, false)) imported++;
        }
        const record: RssHistoryReceipt = { receipt_id: 'receipt_' + planId, applied_at: appliedAt,
          selected_objects: selection.objects.length, imported_objects: imported, existing_objects: selection.objects.length - imported };
        db.prepare(`INSERT INTO http_source_history_receipts (plan_id,receipt_id,applied_at,selected_objects,imported_objects,existing_objects)
          VALUES (?,?,?,?,?,?)`).run(planId, record.receipt_id, appliedAt, record.selected_objects, record.imported_objects, record.existing_objects);
        return { receipt: record, created: true };
      });
    },

    async detectSource(principal, draft, guard) {
      if (draft.type === 'directory') {
        if (!principal.accountId || !principal.dataDomain) throw new Error('SOURCE_PRINCIPAL_INVALID');
        assertRecoveryWriteAllowed(db, principal.dataDomain);
        assertDirectoryReaderAvailable();
      }
      const normalized = await normalize(principal, draft);
      const existing = sameRoot(principal, normalized);
      const preview = previewFor(principal, normalized, existing?.source_id ?? null);
      if (isHttpConnector(normalized.connectorType)) {
        const sample = await readHttp(principal, 'preview', normalized.normalizedTarget, normalized.connectorType, normalized.scope, undefined, guard);
        preview.httpBaseline = fingerprintHttpItems(sample.items);
        preview.samples = sample.items.slice(0, 8).map(({ locator, bytes }) => ({ locator, byteLength: bytes.byteLength }));
      } else preview.samples = await samplesFor(normalized);
      return preview;
    },

    inspectHttpDraft(principal, draft) {
      return inspectHttpDraftOf(principal, draft);
    },

    describeHttpSource(principal, sourceId) {
      const row = scopedHttp(principal, sourceId);
      return { revision: row.config_revision, status: row.status, frequency: row.frequency,
        binding: sha256(Buffer.from(JSON.stringify([row.scope_json, row.normalized_target, row.status, row.frequency]))) };
    },

    changeHttpSource(principal, sourceId, operation, expectedRevision, frequency, beforeWrite) {
      return withImmediateTransaction(db, () => {
        const prepared = scopedHttp(principal, sourceId);
        if (prepared.config_revision !== expectedRevision) throw new Error('SOURCE_REVISION_CONFLICT');
        if (prepared.status === 'disconnected') throw new Error('SOURCE_DISCONNECTED');
        if (operation === 'modify') {
          if (!httpFrequencies.some((option) => option === frequency)) throw new Error('SOURCE_FREQUENCY_INVALID');
        } else if (frequency !== undefined || !['pause', 'resume', 'disconnect'].includes(operation)) {
          throw new Error('SOURCE_HTTP_SCOPE_INVALID');
        }
        if (operation === 'resume' || operation === 'modify') {
          checkHttpScope(principal, prepared.normalized_target, prepared.connector_type, parseScope(prepared.scope_json));
        }
        const observedAt = beforeWrite();
        if (operation === 'resume' || operation === 'modify') {
          checkHttpScope(principal, prepared.normalized_target, prepared.connector_type, parseScope(prepared.scope_json));
        }
        const row = scopedHttp(principal, sourceId);
        if (canonicalPayload(row) !== canonicalPayload(prepared)) throw new Error('SOURCE_REVISION_CONFLICT');
        if (operation === 'resume' || operation === 'modify') assertRecoveryWriteAllowed(db, row.data_domain);
        const nextStatus = operation === 'modify' ? row.status : operation === 'pause' ? 'paused' :
          operation === 'resume' ? 'enabled' : 'disconnected';
        const nextFrequency = frequency ?? row.frequency;
        if (row.status === nextStatus && row.frequency === nextFrequency) {
          return { changed: false, revision: row.config_revision, status: row.status };
        }
        const next = row.config_revision + 1;
        const cursor = loadCursor(sourceId).cursor;
        const enabled = nextStatus === 'enabled' ? 1 : 0;
        const updated = db.prepare('UPDATE source_configs SET status=?,enabled=?,frequency=?,config_revision=?,updated_at=? WHERE source_id=? AND config_revision=?')
          .run(nextStatus, enabled, nextFrequency, next, observedAt, sourceId, row.config_revision);
        if (updated.changes !== 1) throw new Error('SOURCE_REVISION_CONFLICT');
        insertVersion(db, { ...row, config_revision: next, status: nextStatus, enabled, frequency: nextFrequency, created_at: observedAt });
        db.prepare('UPDATE source_cursors SET config_revision=? WHERE source_id=?').run(next, sourceId);
        db.prepare('INSERT INTO http_source_config_receipts(event_id,source_id,config_revision,kind,cursor,observed_at) VALUES (?,?,?,?,?,?)')
          .run(`config:${sourceId}:${next}`, sourceId, next, operation, cursor, observedAt);
        return { changed: true, revision: next, status: nextStatus };
      });
    },

    /** Inspects a draft of any connector type. A directory draft resolves its root on disk. */
    async inspectSourceDraft(principal, draft) {
      if (draft.type !== 'directory') return inspectHttpDraftOf(principal, draft);
      if (!principal.accountId || !principal.dataDomain) throw new Error('SOURCE_PRINCIPAL_INVALID');
      assertDirectoryReaderAvailable();
      const normalized = await normalize(principal, { ...draft, type: 'directory' });
      const existing = sameRoot(principal, normalized);
      return { draftHash: hashDraft(principal, normalized), sourceId: existing?.source_id ?? null,
        revision: existing?.config_revision ?? 0 };
    },

    describeSource(principal, sourceId) {
      const row = scopedSource(principal, sourceId);
      return { revision: row.config_revision, status: row.status, frequency: row.frequency,
        binding: sha256(Buffer.from(JSON.stringify([row.scope_json, row.normalized_target, row.status, row.frequency]))),
        target: row.normalized_target };
    },

    /**
     * Changes a source of any connector type.
     *
     * The location of a work directory stays where it was registered; only the
     * frequency and the status can change. The HTTP scope check only applies to
     * the connectors that hold an approved URL list.
     */
    changeSource(principal, sourceId, operation, expectedRevision, frequency, beforeWrite) {
      return withImmediateTransaction(db, () => {
        const prepared = scopedSource(principal, sourceId);
        if (prepared.config_revision !== expectedRevision) throw new Error('SOURCE_REVISION_CONFLICT');
        if (prepared.status === 'disconnected') throw new Error('SOURCE_DISCONNECTED');
        const http = isHttpConnector(prepared.connector_type) ? prepared.connector_type : null;
        if (operation === 'modify') {
          if (!httpFrequencies.some((option) => option === frequency)) throw new Error('SOURCE_FREQUENCY_INVALID');
        } else if (frequency !== undefined || !['pause', 'resume', 'disconnect'].includes(operation)) {
          throw new Error('SOURCE_HTTP_SCOPE_INVALID');
        }
        if (http && (operation === 'resume' || operation === 'modify')) {
          checkHttpScope(principal, prepared.normalized_target, http, parseScope(prepared.scope_json));
        }
        const observedAt = beforeWrite();
        if (http && (operation === 'resume' || operation === 'modify')) {
          checkHttpScope(principal, prepared.normalized_target, http, parseScope(prepared.scope_json));
        }
        const row = scopedSource(principal, sourceId);
        if (canonicalPayload(row) !== canonicalPayload(prepared)) throw new Error('SOURCE_REVISION_CONFLICT');
        if (operation === 'resume' || operation === 'modify') assertRecoveryWriteAllowed(db, row.data_domain);
        const nextStatus = operation === 'modify' ? row.status : operation === 'pause' ? 'paused' :
          operation === 'resume' ? 'enabled' : 'disconnected';
        const nextFrequency = frequency ?? row.frequency;
        if (row.status === nextStatus && row.frequency === nextFrequency) {
          return { changed: false, revision: row.config_revision, status: row.status };
        }
        const next = row.config_revision + 1;
        const cursor = loadCursor(sourceId).cursor;
        const enabled = nextStatus === 'enabled' ? 1 : 0;
        const updated = db.prepare('UPDATE source_configs SET status=?,enabled=?,frequency=?,config_revision=?,updated_at=? WHERE source_id=? AND config_revision=?')
          .run(nextStatus, enabled, nextFrequency, next, observedAt, sourceId, row.config_revision);
        if (updated.changes !== 1) throw new Error('SOURCE_REVISION_CONFLICT');
        insertVersion(db, { ...row, config_revision: next, status: nextStatus, enabled, frequency: nextFrequency, created_at: observedAt });
        db.prepare('UPDATE source_cursors SET config_revision=? WHERE source_id=?').run(next, sourceId);
        db.prepare('INSERT INTO http_source_config_receipts(event_id,source_id,config_revision,kind,cursor,observed_at) VALUES (?,?,?,?,?,?)')
          .run(`config:${sourceId}:${next}`, sourceId, next, operation, cursor, observedAt);
        return { changed: true, revision: next, status: nextStatus };
      });
    },

    async enableSource(principal, draft, guard) {
      const frozen = structuredClone(draft);
      if (frozen.type === 'directory') {
        if (!principal.accountId || !principal.dataDomain) throw new Error('SOURCE_PRINCIPAL_INVALID');
        assertRecoveryWriteAllowed(db, principal.dataDomain);
        assertDirectoryReaderAvailable();
      }
      const prepared = await normalize(principal, frozen);
      if (prepared.connectorType === 'github' && !sameRoot(principal, prepared)) {
        const github = githubScope(prepared.scope);
        if (options.githubApi) {
          // The live branch has to answer before the source is admitted.
          await options.githubApi.listTree({ repo: github.repo, branch: github.branch, token: githubToken(frozen.credentialRef ?? null) });
        } else {
          await stat(githubRoot(github));
        }
      }
      return withImmediateTransaction(db, () => {
        const normalized = isHttpConnector(frozen.type) ? normalizeHttp(principal, { ...frozen, type: frozen.type }) : prepared;
        const draftHash = hashDraft(principal, normalized);
        if (guard && guard.draftHash !== draftHash) throw new Error('SOURCE_REVISION_CONFLICT');
        const observedAt = guard?.beforeWrite() ?? clock();
        const existing = sameRoot(principal, normalized);
        if (existing) return receiptForExisting(existing);
        assertRecoveryWriteAllowed(db, principal.dataDomain);
        if (overlaps(normalized.physicalRoot)) throw new Error('SOURCE_ROOT_TAKEN');
        const sourceId = `src_${sha256(Buffer.from(`${principal.accountId}\0${principal.dataDomain}\0${normalized.physicalRoot}`)).slice(0, 24)}`;
        const baseline = `baseline:${draftHash}`;
        const scopeJson = JSON.stringify(normalized.scope);
        const excludesJson = JSON.stringify(normalized.excludes);
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
        if (normalized.hasTriggerRule && normalized.triggerMandateTypeId) {
          db.prepare(`INSERT INTO source_trigger_rules (
            source_id, account_id, data_domain, mandate_type_id, config_revision, schema_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`).run(
            sourceId,
            principal.accountId,
            principal.dataDomain,
            normalized.triggerMandateTypeId,
            SCHEMA_VERSION,
            observedAt,
            observedAt,
          );
        }
        db.prepare(`INSERT INTO source_cursors (source_id, config_revision, cursor, phase, sweep_count, updated_at)
          VALUES (?, 1, ?, 'baseline', 0, ?)`).run(sourceId, baseline, observedAt);
        if (guard?.httpBaseline) {
          if (!isHttpConnector(normalized.connectorType)) throw new Error('SOURCE_TYPE_INVALID');
          db.prepare('INSERT INTO http_source_baselines(source_id,entries) VALUES (?,?)').run(sourceId, JSON.stringify(guard.httpBaseline));
        }
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

    async collectSource(sourceId, configRevision, guard) {
      const source = load(sourceId);
      if (!source) throw new Error('SOURCE_NOT_FOUND');
      assertRecoveryWriteAllowed(db, source.data_domain);
      if (source.connector_type === 'directory') assertDirectoryReaderAvailable();
      const opened = gate(sourceId, configRevision);
      if (isReceipt(opened)) return opened;
      if (guard) {
        const source = opened.source;
        if (!isHttpConnector(source.connector_type)) throw new Error('SOURCE_TYPE_INVALID');
        return collectHttp(source, configRevision, source.connector_type, parseScope(source.scope_json), guard);
      }
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
      assertRecoveryWriteAllowed(db, source.data_domain);
      const classified = classifyGithubPayload(payload);
      if (classified.origin !== 'source') return recordIgnored(source, input.deliveryId, 'IGNORED_ORIGIN');
      if (source.status !== 'enabled' || source.config_revision !== input.configRevision) {
        return rejected(source, input.sourceId, input.configRevision, cursor.cursor, source.status !== 'enabled' ? statusReason(source.status) : 'STALE_REVISION');
      }
      const scope = githubScope(parseScope(source.scope_json));
      const excludes = new Set(JSON.parse(source.excludes_json) as string[]);
      const files: Array<{ locator: string; stable: boolean; bytes?: Uint8Array }> = [];
      const liveTree = options.githubApi
        ? await options.githubApi.listTree({ repo: scope.repo, branch: scope.branch, token: githubToken(source.credential_ref) })
        : undefined;
      for (const change of classified.changes) {
        if (change.kind === 'delete') continue;
        const approved = approvedGithubPath(scope, { repo: classified.repo, branch: classified.branch, path: change.path });
        if (!approved || excludes.has(approved)) continue;
        if (liveTree) {
          const entry = liveTree.find((item) => item.type === 'blob' && item.path === approved);
          if (!entry) continue;
          files.push({ locator: approved, stable: true,
            bytes: await options.githubApi!.readBlob({ repo: scope.repo, sha: entry.sha, token: githubToken(source.credential_ref) }) });
          continue;
        }
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
        evidenceRef: `${liveTree ? 'github-api' : 'local-fixture'}:${staged.changed[0]!.hash}`,
      });
    },

    async wakeDirectory(sourceId, relativePath) {
      const source = load(sourceId);
      if (!source || source.connector_type !== 'directory') throw new Error('SOURCE_NOT_FOUND');
      assertRecoveryWriteAllowed(db, source.data_domain);
      assertDirectoryReaderAvailable();
      if (source.status !== 'enabled') return { read: false, receipt: null };
      const directory = directorySnapshot(source, source.config_revision);
      if (isReceipt(directory)) return { read: false, receipt: directory };
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
        return { read: false, receipt: setStatus(sourceId, sample.offline ? 'offline' : 'placeholder', directory) };
      }
      if (!sample.exists) return { read: false, receipt: null };
      const key = `${sourceId}\0${locator}`;
      const decision = stabilityDecision(stable.get(key), sample);
      if (decision.next) stable.set(key, decision.next);
      else stable.delete(key);
      if (!decision.ready) return { read: false, receipt: null };
      // The trusted reader opens the object itself and reports whether it really
      // opened a file inside the approved root.
      const read = await readDirectoryObject(root, locator);
      if (read.state !== 'read') return { read: false, receipt: null };
      const staged = await stage(sourceId, [{ locator, stable: true, bytes: read.bytes }]);
      const receipt = commitSweep({
        source,
        configRevision: source.config_revision,
        ...staged,
        confirmDeletes: false,
        evidenceRef: staged.changed[0]?.hash ?? null,
        directoryGeneration: directory.generation,
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

const sourceReadFailures = new Set(['SOURCE_TARGET_OUTSIDE_SCOPE', 'SOURCE_BODY_SIZE', 'SOURCE_REQUIRES_LOGIN',
  'SOURCE_REDIRECT_LIMIT', 'SOURCE_HTTP_UNAVAILABLE', 'SOURCE_CONTENT_ENCODING', 'SOURCE_DOCUMENT_LIMIT',
  'SOURCE_XML_DTD_DENIED', 'SOURCE_FEED_INVALID', 'SOURCE_HTML_REDIRECT', 'SOURCE_CONTENT_EMPTY', 'SOURCE_MEDIA_TYPE']);

function isHttpConnector(value: ConnectorType): value is HttpConnectorType {
  return value === 'rss' || value === 'webpage';
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
    draft.triggerMandateTypeId ?? '',
  ].join('\0')));
}

function locatorHash(locator: string): string { return sha256(Buffer.from(locator)); }

function fingerprintHttpItems(items: Array<{ locator: string; bytes: Uint8Array }>): HttpBaselineEntry[] {
  return items.map(({ locator, bytes }): HttpBaselineEntry => [locatorHash(locator), sha256(bytes)])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

function objectIdFor(sourceId: string, locator: string): string {
  return `obj_${sha256(Buffer.from(`${sourceId}\0${locator}`)).slice(0, 24)}`;
}

function verifiedHistorySummary(row: HistoryRow): HistorySummary {
  const summary = JSON.parse(row.summary) as HistorySummary;
  const { plan_hash: displayedHash, ...details } = summary;
  if (displayedHash !== row.plan_hash || historyPlanDigest(row, details) !== displayedHash) throw new Error('SOURCE_HISTORY_STALE');
  return summary;
}

function historySummary(planId: string, configRevision: number, expiresAt: string,
  { plan }: RssHistorySelection): Omit<HistorySummary, 'plan_hash'> {
  const { cost, scope } = plan;
  return {
    plan_id: planId, source_id: scope.sourceId, config_revision: configRevision,
    response_hash: plan.responseHash, expires_at: expiresAt, target: scope.target, response_url: plan.responseUrl,
    range: plan.range, budget: { max_objects: plan.budget.maxObjects, max_bytes: plan.budget.maxBytes },
    cost: { evidence_bytes: cost.evidenceBytes, eligible_objects: cost.eligibleObjects, eligible_bytes: cost.eligibleBytes,
      selected_objects: cost.selectedObjects, selected_bytes: cost.selectedBytes, total_bytes: cost.totalBytes,
      omitted_objects: cost.omittedObjects, unknown_date_objects: cost.unknownDateObjects, outside_range_objects: cost.outsideRangeObjects,
      additional_network_requests: cost.additionalNetworkRequests, coverage: cost.coverage },
  };
}

function historyPlanDigest(row: Pick<HistoryRow,
  'plan_id' | 'caller_id' | 'auth_epoch' | 'config_revision' | 'evidence_event_id' | 'expires_at' | 'selection_hash'>,
summary: Omit<HistorySummary, 'plan_hash'>) {
  return sha256(Buffer.from(canonicalPayload([row.plan_id, row.caller_id, row.auth_epoch,
    row.config_revision, row.evidence_event_id, row.expires_at, row.selection_hash, summary])));
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
