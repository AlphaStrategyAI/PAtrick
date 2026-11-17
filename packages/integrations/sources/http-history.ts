import { createHash } from 'node:crypto';
import { canonicalPayload } from '@patrick/contracts';
import { sourceUrl, type RegisteredHttpSource } from './http-read.js';
import { parseFeed, rssFeedMaxBytes, rssFeedMaxItems } from './rss.js';

export const rssHistoryBounds = Object.freeze({ maxObjects: rssFeedMaxItems, maxBytes: 4 * 1024 * 1024 });

/** UTC instants, left closed and right open. Both byte and object limits are mandatory. */
export type RssHistoryLimits = Readonly<{ from: string; until: string; maxObjects: number; maxBytes: number }>;

/** Bytes of one completed readRegisteredHttp call. requestedTarget is its original registered target. */
type RssHistorySnapshot = { requestedTarget: string; url: string; bytes: Uint8Array };
type HistoryItem = Readonly<{ key: string; publishedAt: string; byteLength: number; contentHash: string }>;
type HistoryObject = Readonly<{ key: string; payload: string }>;
type ScopedTarget = Readonly<Omit<RegisteredHttpSource, 'allowedUrls'> & { allowedUrls: readonly string[] }>;

export type RssHistorySelection = Readonly<{
  plan: Readonly<{
    version: 1;
    scope: ScopedTarget;
    responseUrl: string;
    responseHash: string;
    range: Readonly<{ from: string; until: string }>;
    budget: Readonly<{ maxObjects: number; maxBytes: number }>;
    items: readonly HistoryItem[];
    cost: Readonly<{
      evidenceBytes: number; eligibleObjects: number; eligibleBytes: number; selectedObjects: number;
      selectedBytes: number; totalBytes: number; omittedObjects: number; unknownDateObjects: number;
      outsideRangeObjects: number; additionalNetworkRequests: 0; coverage: 'feed_snapshot_only';
    }>;
  }>;
  planHash: string;
  /** Private payloads for the trusted caller; only the plan metadata is safe to show in approval UI. */
  objects: readonly HistoryObject[];
}>;

/**
 * Freeze the largest prefix of the eligible feed ordered by newest publication then
 * stable key. A byte limit never skips an expensive item to choose a later cheap one.
 * Charge the original response once plus the exact UTF-8 bytes of selected JSON payloads.
 * This selects from the observed feed only: it does not read entry links, publish,
 * or authorize any backfill. The trusted caller must bind planHash to its T03 receipt
 * and recheck the scope, configuration revision and frozen bytes before writing.
 */
export function planRssHistory(
  source: RegisteredHttpSource, limits: RssHistoryLimits, snapshot: RssHistorySnapshot,
): RssHistorySelection {
  const { scope, responseUrl } = checkTarget(source, snapshot);
  const from = utcInstant(limits.from);
  const until = utcInstant(limits.until);
  const { maxObjects, maxBytes } = limits;
  if (!from || !until || from >= until ||
      !Number.isInteger(maxObjects) || maxObjects < 1 || maxObjects > rssHistoryBounds.maxObjects ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > rssHistoryBounds.maxBytes) {
    throw new Error('SOURCE_HISTORY_INVALID');
  }
  if (snapshot.bytes.byteLength < 1 || snapshot.bytes.byteLength > rssFeedMaxBytes) throw new Error('SOURCE_BODY_SIZE');
  if (snapshot.bytes.byteLength > maxBytes) throw new Error('SOURCE_HISTORY_BUDGET_EXCEEDED');
  // Use a single local copy for both parsing and the evidence fingerprint.
  const bytes = Uint8Array.from(snapshot.bytes);
  const evidenceBytes = bytes.byteLength;
  const parsed = parseFeed(bytes, responseUrl, { includePublishedAt: true });
  const encoder = new TextEncoder();
  let unknownDateObjects = 0;
  let outsideRangeObjects = 0;
  const eligible: Array<{ entry: HistoryItem; object: HistoryObject }> = [];
  for (const { key, title, link, text, publishedAt } of parsed) {
    if (!publishedAt) { unknownDateObjects++; continue; }
    if (publishedAt < from || publishedAt >= until) { outsideRangeObjects++; continue; }
    const payload = JSON.stringify({ title, link, text });
    const encoded = encoder.encode(payload);
    eligible.push({
      entry: Object.freeze({ key, publishedAt, byteLength: encoded.byteLength, contentHash: sha256(encoded) }),
      object: Object.freeze({ key, payload }),
    });
  }
  eligible.sort((left, right) =>
    compare(right.entry.publishedAt, left.entry.publishedAt) || compare(left.entry.key, right.entry.key));
  const items: HistoryItem[] = [];
  const objects: HistoryObject[] = [];
  let selectedBytes = 0;
  for (const { entry, object } of eligible) {
    if (items.length === maxObjects || evidenceBytes + selectedBytes + entry.byteLength > maxBytes) break;
    items.push(entry);
    objects.push(object);
    selectedBytes += entry.byteLength;
  }
  const cost = Object.freeze({
    evidenceBytes, eligibleObjects: eligible.length, eligibleBytes: eligible.reduce((sum, { entry }) => sum + entry.byteLength, 0),
    selectedObjects: items.length, selectedBytes, totalBytes: evidenceBytes + selectedBytes,
    omittedObjects: eligible.length - items.length, unknownDateObjects, outsideRangeObjects,
    additionalNetworkRequests: 0 as const, coverage: 'feed_snapshot_only' as const,
  });
  const plan = Object.freeze({
    version: 1 as const, scope, responseUrl, responseHash: sha256(bytes),
    range: Object.freeze({ from, until }), budget: Object.freeze({ maxObjects, maxBytes }),
    items: Object.freeze(items), cost,
  });
  const planHash = sha256(canonicalPayload({ ...plan, scope: { ...scope, allowedUrls: [...scope.allowedUrls] }, items: [...items] }));
  return Object.freeze({ plan, planHash, objects: Object.freeze(objects) });
}

function checkTarget(source: RegisteredHttpSource, snapshot: RssHistorySnapshot): { scope: ScopedTarget; responseUrl: string } {
  try {
    const { sourceId, accountId, dataDomain } = source;
    if (!sourceId || !accountId || !dataDomain || source.allowedUrls.length < 1 || source.allowedUrls.length > 32) {
      throw new Error('SOURCE_TARGET_OUTSIDE_SCOPE');
    }
    const target = sourceUrl(source.target);
    const response = sourceUrl(snapshot.url);
    const allowedUrls = [...new Set(source.allowedUrls.map((url) => sourceUrl(url).href))].sort(compare);
    if (sourceUrl(snapshot.requestedTarget).href !== target.href ||
        !allowedUrls.includes(target.href) || !allowedUrls.includes(response.href) ||
        (target.protocol === 'https:' && response.protocol !== 'https:')) {
      throw new Error('SOURCE_TARGET_OUTSIDE_SCOPE');
    }
    return { scope: Object.freeze({ sourceId, accountId, dataDomain, target: target.href,
      allowedUrls: Object.freeze(allowedUrls) }), responseUrl: response.href };
  } catch {
    throw new Error('SOURCE_TARGET_OUTSIDE_SCOPE');
  }
}

function utcInstant(value: string): string | undefined {
  if (typeof value !== 'string') return;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u.exec(value);
  if (!match) return;
  const iso = match[1] + '.' + (match[2] ?? '').padEnd(3, '0') + 'Z';
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === iso ? iso : undefined;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
