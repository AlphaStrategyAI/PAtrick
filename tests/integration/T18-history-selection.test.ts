import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { parseFeed } from '../../packages/integrations/sources/rss.js';
import { planRssHistory } from '../../packages/integrations/sources/http-history.js';

const feedUrl = 'https://news.example.test/feed';
const redirectedUrl = 'https://static.example.test/current.xml';
const scope = { sourceId: 'source-1', accountId: 'owner', dataDomain: 'reading', target: feedUrl, allowedUrls: [feedUrl, redirectedUrl] };
const window = { from: '2026-11-01T00:00:00Z', until: '2026-11-03T00:00:00Z', maxObjects: 20, maxBytes: 16000 };
const utf8 = (text: string) => new TextEncoder().encode(text);
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const rss = (entries: string) => utf8('<rss version="2.0"><channel>' + entries + '</channel></rss>');
const item = (id: string, date: string, text = '内容') =>
  `<item><guid>${id}</guid><title>${id}</title><link>https://not-approved.example.test/article/${id}</link><description>${text}</description><pubDate>${date}</pubDate></item>`;
const snapshot = (bytes: Uint8Array) => ({ requestedTarget: feedUrl, url: redirectedUrl, bytes });
const from = 'Sun, 01 Nov 2026 00:00:00 +0000';
const latest = 'Mon, 02 Nov 2026 14:30:00 +0100';

test('publication timestamps are opt-in; RSS and Atom preserve valid instants only', () => {
  const bytes = rss(item('one', latest) + item('invalid', 'Tue, 02 Nov 2026 14:30:00 +0100') +
    item('unknown-zone', 'Mon, 02 Nov 2026 14:30:00 -0000'));
  expect(parseFeed(bytes, feedUrl).every((entry) => !Object.hasOwn(entry, 'publishedAt'))).toBe(true);
  expect(parseFeed(bytes, feedUrl, { includePublishedAt: true }).map(({ publishedAt }) => publishedAt)).toEqual([
    '2026-11-02T13:30:00.000Z', undefined, undefined,
  ]);
  const atom = utf8(`<feed xmlns="http://www.w3.org/2005/Atom">
    <entry><id>a</id><published>2026-11-02T09:30:00.25-04:00</published></entry>
    <entry><id>b</id><updated>2026-11-02T13:30:00Z</updated></entry>
    <entry><id>c</id><published>2026-11-02T13:30:00</published></entry>
    <entry><id>d</id><published>2026-02-30T13:30:00Z</published></entry>
    <entry><id>e</id><published>2026-11-02T13:30:00-00:00</published></entry>
    <entry><id>f</id><published>2026-11-02T13:30:00Z</published><published>2026-11-01T13:30:00Z</published></entry>
  </feed>`);
  expect(parseFeed(atom, feedUrl, { includePublishedAt: true }).map(({ publishedAt }) => publishedAt)).toEqual([
    '2026-11-02T13:30:00.250Z', undefined, undefined, undefined, undefined, undefined,
  ]);
});

test('history pins the exact snapshot, scope and [from, until) range; order is newest then key', () => {
  const bytes = rss(item('end', 'Tue, 03 Nov 2026 00:00:00 GMT') + item('z', latest) +
    item('start', from) + item('a', latest) + item('old', 'Sat, 31 Oct 2026 23:59:59 +0000') +
    item('undated', 'unrecognized clock'));
  const result = planRssHistory(scope, window, snapshot(bytes));
  expect(result.plan).toMatchObject({
    scope: { ...scope, allowedUrls: [feedUrl, redirectedUrl] },
    responseUrl: redirectedUrl,
    responseHash: hash(bytes),
    range: { from: '2026-11-01T00:00:00.000Z', until: '2026-11-03T00:00:00.000Z' },
    cost: { evidenceBytes: bytes.byteLength, selectedObjects: 3, eligibleObjects: 3, unknownDateObjects: 1,
      outsideRangeObjects: 2, omittedObjects: 0, additionalNetworkRequests: 0 },
  });
  expect(result.plan.items.map((entry) => entry.key)).toEqual(['id:a', 'id:z', 'id:start']);
  expect(result.objects.map((entry) => entry.key)).toEqual(['id:a', 'id:z', 'id:start']);
  for (const [index, entry] of result.objects.entries()) {
    expect(result.plan.items[index]).toMatchObject({
      contentHash: hash(entry.payload), byteLength: utf8(entry.payload).byteLength,
    });
  }
  expect(result.planHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(planRssHistory({ ...scope, allowedUrls: [redirectedUrl, feedUrl] }, window, snapshot(bytes))).toEqual(result);
  expect(planRssHistory({ ...scope, dataDomain: 'another' }, window, snapshot(bytes)).planHash).not.toBe(result.planHash);
  expect(planRssHistory(scope, { ...window, maxBytes: 15000 }, snapshot(bytes)).planHash).not.toBe(result.planHash);
});

test('a plan applies both hard budgets to one deterministic prefix and reports all omitted costs', () => {
  const bytes = rss(item('z', latest, '旧'.repeat(100)) + item('start', from) + item('a', latest));
  const full = planRssHistory(scope, window, snapshot(bytes));
  const firstBytes = full.plan.items[0].byteLength;
  const cost = bytes.byteLength + firstBytes;
  const bounded = planRssHistory(scope, { ...window, maxBytes: cost, maxObjects: 2 }, snapshot(bytes));
  expect(bounded.plan.items.map((entry) => entry.key)).toEqual(['id:a']);
  expect(bounded.plan.cost).toMatchObject({
    selectedBytes: firstBytes, totalBytes: cost, eligibleObjects: 3, selectedObjects: 1, omittedObjects: 2,
  });
  const countBound = planRssHistory(scope, { ...window, maxObjects: 2 }, snapshot(bytes));
  expect(countBound.plan.items.map((entry) => entry.key)).toEqual(['id:a', 'id:z']);
  expect(countBound.plan.cost).toMatchObject({ eligibleObjects: 3, selectedObjects: 2, omittedObjects: 1 });
  expect(() => planRssHistory(scope, { ...window, maxBytes: bytes.byteLength - 1 }, snapshot(bytes)))
    .toThrow('SOURCE_HISTORY_BUDGET_EXCEEDED');
});

test('rejects invalid budgets, implicit timezones and bytes that do not belong to the exact approved feed', () => {
  const invalidXml = snapshot(utf8('must reject the scope before parsing this'));
  expect(() => planRssHistory(scope, window, { ...invalidXml, requestedTarget: redirectedUrl })).toThrow('SOURCE_TARGET_OUTSIDE_SCOPE');
  expect(() => planRssHistory(scope, window, { ...invalidXml, url: 'https://static.example.test/other.xml' })).toThrow('SOURCE_TARGET_OUTSIDE_SCOPE');
  const downgradedUrl = redirectedUrl.replace('https:', 'http:');
  expect(() => planRssHistory({ ...scope, allowedUrls: [feedUrl, downgradedUrl] }, window, {
    ...invalidXml, url: downgradedUrl,
  })).toThrow('SOURCE_TARGET_OUTSIDE_SCOPE');
  expect(() => planRssHistory(scope, { ...window, from: '2026-11-01' }, invalidXml)).toThrow('SOURCE_HISTORY_INVALID');
  expect(() => planRssHistory(scope, { ...window, until: window.from }, invalidXml)).toThrow('SOURCE_HISTORY_INVALID');
  expect(() => planRssHistory(scope, { ...window, maxObjects: 1.5 }, invalidXml)).toThrow('SOURCE_HISTORY_INVALID');
  expect(() => planRssHistory(scope, { ...window, maxBytes: Number.POSITIVE_INFINITY }, invalidXml)).toThrow('SOURCE_HISTORY_INVALID');
});
