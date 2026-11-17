import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const scope = { account_id: 'owner', data_domain: 'alpha', permission_epoch: 4 };
const snapshot = {
  schema_version: '1.0', scope, as_of: '2026-01-01T00:00:00Z', freshness: 'fresh' as const,
  watermark: { hub_seq: 2, domain_seq: 3 }, stream_cursor: 'cursor-a', data: { items: [] },
};

describe('T14 bilingual foundation', () => {
  it('uses ordered system locales, a single-language fallback, and explicit overrides', async () => {
    const { resolveLocale, browserLanguages } = await import('../../apps/web/src/i18n/locale.js');
    expect(resolveLocale('system', ['ja-JP', 'zh-TW', 'en'])).toBe('zh');
    expect(resolveLocale('system', ['en-GB', 'zh-CN'])).toBe('en');
    expect(resolveLocale('system', ['ja-JP'])).toBe('en');
    expect(resolveLocale('system', browserLanguages({ languages: [], language: 'zh-CN' }))).toBe('zh');
    expect(resolveLocale('system', browserLanguages({}))).toBe('en');
    expect(resolveLocale('en', ['zh-CN'])).toBe('en');
  });

  it('keeps message catalogs aligned and renders a safe localized fallback', async () => {
    const { en, zh, errorMessage } = await import('../../apps/web/src/i18n/locale.js');
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    expect(errorMessage('zh', 'EDIT_CONFLICT')).toBe(zh['error.EDIT_CONFLICT']);
    expect(errorMessage('en', 'unexpected <server details>')).toBe(en['error.unknown']);
  });

  it('keeps navigation and all six settings groups in product order', async () => {
    const { navigation, settingsNavigation, workDetailPath } = await import('../../apps/web/src/app/navigation.js');
    expect(navigation.map(({ path }) => path)).toEqual([
      '/decisions', '/work', '/standards', '/knowledge', '/delegations', '/system', '/stats', '/settings',
    ]);
    expect(settingsNavigation.map(({ path }) => path)).toEqual([
      '/settings/collection', '/settings/materials', '/settings/execution', '/settings/operation',
      '/settings/interaction', '/settings/preferences',
    ]);
    expect(workDetailPath).toBe('/work/:id');
  });

  it('isolates local drafts by account, domain, conversation, resource and version', async () => {
    const { DraftStore } = await import('../../apps/web/src/state/drafts.js');
    const entries = new Map<string, string>();
    const storage = {
      get length() { return entries.size; },
      key: (index: number) => [...entries.keys()][index] ?? null,
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
      removeItem: (key: string) => { entries.delete(key); },
    };
    const drafts = new DraftStore(storage);
    const key = { account: 'A', domain: 'domain', conversation: 'C', resource: 'Q', version: 2, kind: 'decision' } as const;
    const other = { ...key, account: 'B' };
    drafts.write(key, '先保留 / keep original');
    drafts.write(other, 'B only');
    expect(drafts.read({ ...key, version: 3 })).toBeNull();
    expect(drafts.read({ ...key, domain: 'other' })).toBeNull();
    expect(drafts.read({ ...key, conversation: 'other' })).toBeNull();
    expect(drafts.read({ ...key, kind: 'consultation' })).toBeNull();
    expect(drafts.read(key)).toBe('先保留 / keep original');
    drafts.clearAccount('A');
    expect(new DraftStore(storage).read(key)).toBeNull();
    expect(new DraftStore(storage).read(other)).toBe('B only');
  });

  it('drops old presentation fragments without losing original results or business revision', async () => {
    const { createPresentation, switchPresentation, addDisplayFragment, keepOriginal } =
      await import('../../apps/web/src/state/presentation.js');
    let state = createPresentation('en', 17);
    state = addDisplayFragment(state, 0, 'old');
    state = switchPresentation(state, 'zh');
    state = addDisplayFragment(state, 0, 'late');
    state = keepOriginal(state, '原话 / original');
    state = addDisplayFragment(state, 1, '译文');
    expect(state).toMatchObject({ locale: 'zh', presentation_epoch: 1, businessRevision: 17, original: '原话 / original', display: '译文' });
  });

  it('renders a limited Markdown subset as text nodes and allowlisted links', async () => {
    const { parseInlineMarkdown } = await import('../../apps/web/src/components/markdown.js');
    const content = parseInlineMarkdown('<img src=x onerror=oops> **Safe** [docs](https://example.test/a) [bad](javascript:bad) [encoded](java&#x73;cript:bad) [other](//example.test)');
    expect(content.filter(({ kind }) => kind === 'link')).toEqual([{ kind: 'link', text: 'docs', href: 'https://example.test/a' }]);
    expect(content).toContainEqual({ kind: 'strong', text: 'Safe' });
    expect(content.some(({ kind, text }) => kind === 'text' && text.includes('<img src=x onerror=oops>'))).toBe(true);
  });

  it('validates scoped reads and rejects old-scope responses after revocation', async () => {
    const { ApiClient } = await import('../../apps/web/src/api/client.js');
    let respond!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; }));
    const api = new ApiClient(fetcher);
    api.authorize(scope);
    const request = api.read('listWork', {});
    expect(fetcher).toHaveBeenCalledWith('/api/v1/work?domain=alpha&limit=50&state=open', expect.objectContaining({ credentials: 'same-origin' }));
    api.revoke();
    respond(Response.json(snapshot));
    await expect(request).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('reads an actual T13-shaped scoped list and declines a different domain before fetching', async () => {
    const { ApiClient } = await import('../../apps/web/src/api/client.js');
    const workList = { ...snapshot, data: { items: [], counts: { open: 0, awaiting_answer: 0, blocked: 0 }, next_cursor: null } };
    const fetcher = vi.fn(async () => Response.json(workList));
    const api = new ApiClient(fetcher);
    api.authorize(scope);
    await expect(api.read('listWork', {})).resolves.toEqual(workList);
    await expect(api.read('listWork', { domain: 'different' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses contracts for command envelopes and preserves a received receipt without claiming success', async () => {
    const { ApiClient } = await import('../../apps/web/src/api/client.js');
    const receipt = { command_id: 'cmd-one', state: 'received', receipt_url: '/api/v1/commands/cmd-one' };
    const fetcher = vi.fn(async () => Response.json(receipt, { status: 202 }));
    const api = new ApiClient(fetcher);
    api.authorize(scope);
    const intent = { client_request_id: 'same', expected_revision: 3, payload: { type: 'pause', generation: 2 } };
    await expect(api.command('controlWork', { id: 'a/b' }, intent)).resolves.toEqual(receipt);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe('/api/v1/work/a%2Fb/controls');
    expect(JSON.parse(String(init.body))).toMatchObject({ ...intent, payload_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it('deduplicates event replay, drops older versions, and advances only the transport cursor', async () => {
    const { EventTracker } = await import('../../apps/web/src/api/events.js');
    const tracker = new EventTracker(scope, snapshot.stream_cursor);
    const event = { event_id: 'one', type: 'work.delivered', resource_id: 'W', resource_revision: 2, scope, as_of: snapshot.as_of, watermark: snapshot.watermark };
    expect(tracker.accept('cursor-b', event)).toBe('updated');
    expect(tracker.accept('cursor-c', event)).toBe('ignored');
    expect(tracker.accept('cursor-d', { ...event, event_id: 'two', resource_revision: 1 })).toBe('ignored');
    expect(tracker.cursor).toBe('cursor-d');
    expect(tracker.accept('other', { ...event, scope: { ...scope, permission_epoch: 5 } })).toBe('revoked');
    expect(tracker.cursor).toBe('cursor-d');
  });

  it('locks the actual Playwright Chromium and the shipped font sources', async () => {
    const { default: lock } = await import('../../apps/web/rendering.lock.json');
    const web = fileURLToPath(new URL('../../apps/web/', import.meta.url));
    const require = createRequire(join(web, 'package.json'));
    const playwright = require('playwright-core/package.json') as { version: string };
    expect(playwright.version).toBe(lock.playwright);
    const browserPath = join(dirname(require.resolve('playwright-core/package.json')), 'browsers.json');
    const { browsers } = JSON.parse(readFileSync(browserPath, 'utf8')) as { browsers: { name: string; browserVersion: string; revision: string }[] };
    expect(browsers.find(({ name }) => name === lock.chromium.channel)).toMatchObject({
      browserVersion: lock.chromium.version, revision: lock.chromium.revision,
    });
    const noto = dirname(require.resolve('@fontsource/noto-sans-sc/400.css'));
    const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    expect(sha256(join(web, 'public/fonts/NotoSansSC-OFL.txt'))).toBe(lock.fonts.noto.licenseSha256);
    for (const [file, hash] of Object.entries(lock.fonts.inter.sha256)) {
      expect(sha256(join(web, 'public/fonts', file)), file).toBe(hash);
    }
    for (const [file, hash] of Object.entries(lock.fonts.noto.sha256)) {
      expect(sha256(join(noto, file)), file).toBe(hash);
    }
  });

  it('reconnects with Last-Event-ID and stops on a reset without sending writes', async () => {
    const { ApiClient } = await import('../../apps/web/src/api/client.js');
    const event = { event_id: 'one', type: 'work.delivered', resource_id: 'W', resource_revision: 2, scope, as_of: snapshot.as_of, watermark: snapshot.watermark };
    const first = 'id: cursor-b\r\nevent: work.delivered\r\ndata: ' + JSON.stringify(event) + '\r\n\r\n';
    const response = (body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(first))
      .mockResolvedValueOnce(response('event: reset_required\ndata: {}\n\n'));
    const api = new ApiClient(fetcher);
    api.authorize(scope);
    const updates = vi.fn();
    const onReset = vi.fn();
    await api.subscribe(snapshot, { onUpdate: updates, onReset, checkSession: async () => true, reconnectDelayMs: 0 });
    expect(updates).toHaveBeenCalledExactlyOnceWith(event);
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/v1/events?after=cursor-a&domain=alpha', expect.objectContaining({ method: 'GET' }));
    expect(fetcher.mock.calls[1][0]).toBe('/api/v1/events?domain=alpha');
    expect(new Headers(fetcher.mock.calls[1][1].headers).get('last-event-id')).toBe('cursor-b');
  });
});

describe('T14 review regressions', () => {
  it.each([401, 403])('fences the current scope on %s headers when the body never arrives', async (status) => {
    const { ApiClient } = await import('../../apps/web/src/api/client.js');
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (controller) => { stream = controller; } });
    const revoke = vi.fn();
    const fetcher = vi.fn(async () => new Response(body, { status }));
    const api = new ApiClient(fetcher, revoke);
    api.authorize(scope);
    const rejection = api.read('listWork').catch((error: unknown) => error);
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(revoke).toHaveBeenCalledTimes(1);
      await expect(rejection).resolves.toMatchObject({ status });
    } finally { try { stream.close(); } catch { /* Already canceled. */ } }
  });

  it('fences reads and drops cached snapshots on reset even when the epoch later stays the same', async () => {
    const { QueryClient } = await import('@tanstack/react-query');
    const { ApiClient, scopedQueryKey } = await import('../../apps/web/src/api/client.js');
    const { purgeAccountQueries } = await import('../../apps/web/src/api/query-cache.js');
    const query = new QueryClient();
    const key = scopedQueryKey(scope, 'listWork');
    query.setQueryData(key, 'previously visible');
    let resolveOld!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(new Response('event: reset_required\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(Response.json({ ...snapshot, data: { items: [], next_cursor: null, counts: { open: 0, awaiting_answer: 0, blocked: 0 } } }));
    const reset = vi.fn((old: typeof scope) => purgeAccountQueries(query, old.account_id));
    const api = new ApiClient(fetcher, reset);
    api.authorize(scope);
    const oldRead = api.read('listWork').catch((error: unknown) => error);
    await api.subscribe(snapshot, { onUpdate: vi.fn() });
    expect(reset).toHaveBeenCalledWith(scope, { kind: 'reset', cursor: 'cursor-a' });
    expect(query.getQueryData(key)).toBeUndefined();
    await expect(api.read('listWork')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    resolveOld(Response.json(snapshot));
    await expect(oldRead).resolves.toMatchObject({ code: 'FORBIDDEN' });
    const session = await api.read('getSession');
    api.authorize(session.scope);
    expect(query.getQueryData(key)).toBeUndefined();
    await expect(api.read('listWork')).resolves.toMatchObject({ scope, data: { items: [] } });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/work?domain=alpha&limit=50&state=open',
      '/api/v1/events?after=cursor-a&domain=alpha', '/api/v1/session', '/api/v1/work?domain=alpha&limit=50&state=open',
    ]);
  });

  it.each([false, true])('replaces a pending TanStack fetch when an event arrives (cached=%s)', async (cached) => {
    const { QueryClient, QueryObserver } = await import('@tanstack/react-query');
    const { scopedQueryKey } = await import('../../apps/web/src/api/client.js');
    const { refreshScopedQueries, t13ProjectionMeta } = await import('../../apps/web/src/api/query-cache.js');
    const query = new QueryClient();
    const key = scopedQueryKey(scope, 'listWork');
    if (cached) query.setQueryData(key, 'prior cached result');
    let settleOld!: (data: string) => void;
    let oldSignal!: AbortSignal;
    const handler = vi.fn().mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
      oldSignal = signal;
      return new Promise<string>((resolve) => { settleOld = resolve; });
    }).mockResolvedValueOnce('new authorized snapshot');
    const observer = new QueryObserver(query, { queryKey: key, queryFn: handler, meta: t13ProjectionMeta, staleTime: 0 });
    const dispose = observer.subscribe(() => {});
    try {
      expect(handler).toHaveBeenCalledTimes(1);
      await refreshScopedQueries(query, scope);
      expect(oldSignal.aborted).toBe(true);
      settleOld('outdated in-flight snapshot');
      await Promise.resolve();
      expect(handler).toHaveBeenCalledTimes(2);
      expect(query.getQueryData(key)).toBe('new authorized snapshot');
    } finally { dispose(); query.clear(); }
  });

  it('configures the live Vite origin to match the unchanged T03 Origin gate', async () => {
    const { localServerConfig } = await import('../../apps/web/vite.config.js');
    const { ORIGIN, assertBrowserOrigin } = await import('../../apps/service/src/auth.js');
    const server = localServerConfig('http://127.0.0.1:4194');
    const browserOrigin = new URL(`http://${server.host}:${server.port}`).origin;
    expect(browserOrigin).toBe(ORIGIN);
    expect(server.strictPort).toBe(true);
    expect(server.proxy?.['/api']).toEqual({ target: 'http://127.0.0.1:4194' });
    expect(() => assertBrowserOrigin(new Request(browserOrigin + '/api/v1/session', {
      method: 'DELETE', headers: { origin: browserOrigin },
    }))).not.toThrow();
    expect(() => assertBrowserOrigin(new Request(browserOrigin + '/api/v1/session', {
      method: 'DELETE', headers: { origin: 'http://localhost:5173' },
    }))).toThrow('FORBIDDEN');
  });
});

describe('T14 stream re-review', () => {
  const stream = (body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  const work = (accountScope = scope) => Response.json({ ...snapshot, scope: accountScope, data: { items: [], next_cursor: null,
    counts: { open: 0, awaiting_answer: 0, blocked: 0 },
  } });

  it('does not let an old stream response act after a replacement authorization', async () => {
    const { ApiClient } = await import('../../apps/web/src/api/client.js');
    const next = { ...scope, account_id: 'new-owner' };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('<html>offline</html>')).mockResolvedValueOnce(work(next));
    const onLoss = vi.fn();
    const onReset = vi.fn();
    const api = new ApiClient(fetcher, onLoss);
    api.authorize(scope);
    const old = api.subscribe(snapshot, { onUpdate: vi.fn(), onReset });
    queueMicrotask(() => api.authorize(next));
    await old;
    expect(onReset).not.toHaveBeenCalled();
    expect(onLoss.mock.calls.map(([lost]) => lost)).toEqual([scope]);
    await expect(api.read('listWork')).resolves.toMatchObject({ scope: next });
  });

  it('ignores an old session check that finishes after a replacement authorization', async () => {
    const { ApiClient } = await import('../../apps/web/src/api/client.js');
    const next = { ...scope, account_id: 'new-owner' };
    const fetcher = vi.fn().mockResolvedValueOnce(stream('')).mockResolvedValueOnce(work(next));
    const api = new ApiClient(fetcher);
    api.authorize(scope);
    let checking!: () => void;
    let checked!: (valid: boolean) => void;
    const began = new Promise<void>((resolve) => { checking = resolve; });
    const old = api.subscribe(snapshot, { onUpdate: vi.fn(), reconnectDelayMs: 0, checkSession: () => {
      checking();
      return new Promise<boolean>((resolve) => { checked = resolve; });
    } });
    await began;
    api.authorize(next);
    checked(false);
    await old;
    await expect(api.read('listWork')).resolves.toMatchObject({ scope: next });
  });

  it.each([401, 403])('purges the prior account drafts if reset revalidation returns %s', async (status) => {
    const { ApiClient } = await import('../../apps/web/src/api/client.js');
    const { DraftStore } = await import('../../apps/web/src/state/drafts.js');
    const key = { account: scope.account_id, domain: scope.data_domain, conversation: 'draft', resource: 'work',
      version: 0, kind: 'consultation' } as const;
    const drafts = new DraftStore(undefined);
    drafts.write(key, 'prior private text');
    const fetcher = vi.fn().mockResolvedValueOnce(stream('event: reset_required\ndata: {}\n\n'))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status }));
    const api = new ApiClient(fetcher, (prior, cause) => {
      if (cause.kind === 'revoked') drafts.clearAccount(prior.account_id);
    });
    api.authorize(scope);
    await api.subscribe(snapshot, { onUpdate: vi.fn() });
    expect(drafts.read(key)).toBe('prior private text');
    await expect(api.read('getSession')).rejects.toMatchObject({ status: 503 });
    expect(drafts.read(key)).toBe('prior private text');
    await expect(api.read('getSession')).rejects.toMatchObject({ status });
    expect(drafts.read(key)).toBeNull();
  });

  it('backs off after non-SSE and malformed responses without rejecting the cursor', async () => {
    const { ApiClient } = await import('../../apps/web/src/api/client.js');
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('<html>proxy maintenance</html>', { headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(stream('id: corrupted-cursor\ndata: invalid JSON\n\n'))
      .mockResolvedValueOnce(stream('event: reset_required\ndata: {}\n\n'));
    const reset = vi.fn();
    const onLoss = vi.fn();
    const api = new ApiClient(fetcher, onLoss);
    api.authorize(scope);
    const checkSession = vi.fn(async () => true);
    vi.useFakeTimers();
    try {
      const subscription = api.subscribe(snapshot, { onUpdate: vi.fn(), onReset: reset, checkSession, reconnectDelayMs: 20 });
      await vi.advanceTimersByTimeAsync(19);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(39);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await subscription;
    } finally { vi.useRealTimers(); }
    expect(checkSession).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.slice(1).map(([, init]) => new Headers(init.headers).get('last-event-id')))
      .toEqual(['cursor-a', 'cursor-a']);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(onLoss).toHaveBeenCalledExactlyOnceWith(scope, { kind: 'reset', cursor: 'cursor-a' });
  });

  it('coalesces a replay burst, follows a mid-read notification, and retries an uncovered watermark', async () => {
    const { QueryClient, QueryObserver } = await import('@tanstack/react-query');
    const { scopedQueryKey } = await import('../../apps/web/src/api/client.js');
    const { createProjectionRefresh, t13ProjectionMeta } = await import('../../apps/web/src/api/query-cache.js');
    const client = new QueryClient();
    const key = scopedQueryKey(scope, 'listWork');
    const controller = new AbortController();
    const calls: Array<(value: typeof snapshot) => void> = [];
    const observer = new QueryObserver(client, { queryKey: key, retry: false, meta: t13ProjectionMeta,
      queryFn: () => new Promise<typeof snapshot>((resolve) => { calls.push(resolve); }),
    });
    const off = observer.subscribe(() => {});
    const refresh = createProjectionRefresh(client, scope, controller.signal, { coalesceMs: 0, retryMs: 0 });
    try {
      const first = refresh({ hub_seq: 4, domain_seq: 3 });
      for (let i = 5; i <= 40; i++) void refresh({ hub_seq: i, domain_seq: 3 });
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      const newest = refresh({ hub_seq: 41, domain_seq: 6 });
      expect(calls).toHaveLength(2);
      calls[1]({ ...snapshot, watermark: { hub_seq: 40, domain_seq: 3 } });
      await vi.waitFor(() => expect(calls).toHaveLength(3));
      calls[2]({ ...snapshot, watermark: { hub_seq: 41, domain_seq: 5 } });
      await vi.waitFor(() => expect(calls).toHaveLength(4));
      calls[3]({ ...snapshot, watermark: { hub_seq: 41, domain_seq: 6 } });
      await Promise.all([first, newest]);
      calls[0](snapshot);
      expect(client.getQueryData(key)).toMatchObject({ watermark: { hub_seq: 41, domain_seq: 6 } });
    } finally { controller.abort(); off(); client.clear(); }
  });
});

describe('T14 projection registration and reset scope replacement', () => {
  it('does not wait for independent queries or repeatedly refetch a terminal projection error', async () => {
    const { QueryClient, QueryObserver } = await import('@tanstack/react-query');
    const { ClientError, scopedQueryKey } = await import('../../apps/web/src/api/client.js');
    const { createProjectionRefresh, t13ProjectionMeta } = await import('../../apps/web/src/api/query-cache.js');
    const client = new QueryClient();
    const controller = new AbortController();
    const requested = { hub_seq: 9, domain_seq: 12 };
    let conversationSignal!: AbortSignal;
    const independent = vi.fn(({ signal }: { signal: AbortSignal }) => {
      conversationSignal = signal;
      return new Promise<unknown>(() => {});
    });
    const terminal = vi.fn(async () => { throw new ClientError('NOT_FOUND', 404); });
    const project = vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValue({ ...snapshot, watermark: requested });
    const workList = new QueryObserver(client, { queryKey: scopedQueryKey(scope, 'listWork'), meta: t13ProjectionMeta, queryFn: project });
    const workDetail = new QueryObserver(client, {
      queryKey: scopedQueryKey(scope, 'getWork', { id: 'missing' }), meta: t13ProjectionMeta, queryFn: terminal, retry: false,
    });
    const conversations = new QueryObserver(client, { queryKey: scopedQueryKey(scope, 'listConversations'), queryFn: independent });
    const unmount = [workList.subscribe(() => {}), workDetail.subscribe(() => {}), conversations.subscribe(() => {})];
    try {
      await vi.waitFor(() => {
        expect(workList.getCurrentResult().isSuccess).toBe(true);
        expect(workDetail.getCurrentResult().isError).toBe(true);
      });
      let settled = false;
      const refreshed = createProjectionRefresh(client, scope, controller.signal, { coalesceMs: 0, retryMs: 0 })(requested)
        .then(() => { settled = true; });
      await vi.waitFor(() => expect(project).toHaveBeenCalledTimes(2), { timeout: 300 });
      expect(independent).toHaveBeenCalledTimes(1);
      expect(conversationSignal.aborted).toBe(false);
      expect(terminal).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 300 });
      await refreshed;
      expect(workList.getCurrentResult().data).toMatchObject({ watermark: requested });
    } finally {
      controller.abort();
      for (const dispose of unmount) dispose();
      client.clear();
    }
  });

  it.each([
    { label: 'same scope', next: scope, purged: false },
    { label: 'different account', next: { ...scope, account_id: 'replacement' }, purged: true },
    { label: 'different domain', next: { ...scope, data_domain: 'replacement' }, purged: true },
    { label: 'different epoch', next: { ...scope, permission_epoch: 5 }, purged: true },
  ])('preserves or purges prior drafts on successful revalidation: $label', async ({ next, purged }) => {
    const { ApiClient } = await import('../../apps/web/src/api/client.js');
    const { DraftStore } = await import('../../apps/web/src/state/drafts.js');
    const drafts = new DraftStore(undefined);
    const key = { account: scope.account_id, domain: scope.data_domain, conversation: 'decision', resource: 'work',
      version: 0, kind: 'decision' } as const;
    const other = { ...key, account: 'untouched' };
    drafts.write(key, 'prior private text');
    drafts.write(other, 'other account text');
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('event: reset_required\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(Response.json({ ...snapshot, scope: next }))
      .mockResolvedValueOnce(Response.json({ ...snapshot, scope: next, data: { items: [], next_cursor: null,
        counts: { open: 0, awaiting_answer: 0, blocked: 0 } } }));
    const api = new ApiClient(fetcher, (old, cause) => {
      if (cause.kind === 'revoked') drafts.clearAccount(old.account_id);
    });
    api.authorize(scope);
    await api.subscribe(snapshot, { onUpdate: vi.fn() });
    const session = await api.read('getSession');
    api.authorize(session.scope);
    expect(drafts.read(key)).toBe(purged ? null : 'prior private text');
    expect(drafts.read(other)).toBe('other account text');
    await expect(api.read('listWork')).resolves.toMatchObject({ scope: next });
  });
});
