import { expect, test, vi } from 'vitest';
import { readRegisteredHttp, sourceUrl, type RegisteredHttpSource } from '../../packages/integrations/sources/http-read.js';

const feed = 'https://feed.example.test/news';
const redirect = 'https://feed.example.test/redirected';
const source: RegisteredHttpSource = { sourceId: 'feed-example', accountId: 'owner', dataDomain: 'personal',
  target: feed, allowedUrls: [feed, redirect] };
const resolvedPublic = { address: '8.8.8.8', family: 4 as const };

test('requires registration before DNS and refuses redirects outside the exact trusted scope', async () => {
  const resolve = vi.fn(async () => [resolvedPublic]);
  const request = vi.fn(async () => ({ status: 302, location: 'https://other.example.test/', contentType: null, bytes: new Uint8Array() }));
  const port = { resolve, request };
  await expect(readRegisteredHttp({ ...source, target: 'https://other.example.test/' }, port)).rejects.toThrow('SOURCE_TARGET_OUTSIDE_SCOPE');
  expect(resolve).not.toHaveBeenCalled();
  await expect(readRegisteredHttp(source, port)).rejects.toThrow('SOURCE_TARGET_OUTSIDE_SCOPE');
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls).toHaveLength(1);
});

test.each(['127.0.0.1', '10.0.1.3', '169.254.169.254', '100.64.0.2', '::ffff:127.0.0.1', 'fe80::1', '2002:7f00:1::1'])(
  'rejects nonpublic or translating DNS results before any connection: %s', async (address) => {
    const request = vi.fn();
    await expect(readRegisteredHttp(source, { resolve: async () => [resolvedPublic, { address, family: address.includes(':') ? 6 : 4 }],
      request })).rejects.toThrow('SOURCE_TARGET_OUTSIDE_SCOPE');
    expect(request).not.toHaveBeenCalled();
  },
);

test('revalidates DNS on a same-host redirect and supplies only the pinned address to transport', async () => {
  const resolve = vi.fn().mockResolvedValueOnce([resolvedPublic]).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
  const request = vi.fn(async (_target: URL, _pinned: unknown) => ({ status: 302, location: '/redirected', contentType: null, bytes: new Uint8Array() }));
  await expect(readRegisteredHttp(source, { resolve, request })).rejects.toThrow('SOURCE_TARGET_OUTSIDE_SCOPE');
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[0][0].href).toBe(feed);
  expect(request.mock.calls[0][1]).toEqual(resolvedPublic);
  expect(request).toHaveBeenCalledTimes(1);
});

test('a login redirect or response is not accepted as first collection evidence', async () => {
  const request = vi.fn()
    .mockResolvedValueOnce({ status: 403, location: null, contentType: 'text/html', bytes: new Uint8Array() })
    .mockResolvedValueOnce({ status: 200, location: null, contentType: 'text/html', bytes: new TextEncoder().encode(
      '<html><form><input type="password"></form></html>') });
  const port = { resolve: async () => [resolvedPublic], request };
  await expect(readRegisteredHttp(source, port)).rejects.toThrow('SOURCE_REQUIRES_LOGIN');
  await expect(readRegisteredHttp(source, port)).rejects.toThrow('SOURCE_REQUIRES_LOGIN');
});

test('normalizes fragments and rejects URL credentials and address literals', () => {
  expect(sourceUrl(feed + '#part').href).toBe(feed);
  for (const input of ['https://someone:secret@feed.example.test/news', 'file:///private/data', 'http://127.1/',
    'http://[::1]/', 'https://feed.example.test/a%2fadmin', 'https://feed.example.test/a\\b']) {
    expect(() => sourceUrl(input)).toThrow('SOURCE_URL_INVALID');
  }
});

test('withdrawn policy during DNS prevents opening the approved connection', async () => {
  let approved = true;
  const request = vi.fn();
  await expect(readRegisteredHttp(source, {
    resolve: async () => { approved = false; return [resolvedPublic]; },
    request,
  }, { stillAllowed: () => approved })).rejects.toThrow('SOURCE_TARGET_OUTSIDE_SCOPE');
  expect(request).not.toHaveBeenCalled();
  expect(() => sourceUrl(feed + '?access_token=fixture-value')).toThrow('SOURCE_URL_INVALID');
});
