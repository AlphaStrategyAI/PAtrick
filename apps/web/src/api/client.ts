import { canonicalPayload, commandAcceptedSchema, errorBodySchema, scopeSchema } from '@patrick/contracts/envelope';
import type { Json, Snapshot } from '@patrick/contracts/envelope';
import { routes } from '@patrick/contracts/resources';
import type { RouteDefinition } from '@patrick/contracts/resources';
import { EventTracker, readFrames, sameScope } from './events.js';
import type { Scope, StreamEvent } from './events.js';
import { waitForDelay } from './timing.js';

export class ClientError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly retryable = false,
    readonly correlationId?: string,
    readonly currentRevision?: number,
  ) { super(code); }
}

type QueryValues = Record<string, string | number | boolean | undefined>;
type RequestOptions = { signal?: AbortSignal };
type Intent = { client_request_id: string; expected_revision: number | null; payload: Json };
type Receipt = ReturnType<typeof commandAcceptedSchema.parse>;
type SubscribeOptions = RequestOptions & {
  onUpdate: (event: StreamEvent) => void;
  onReset?: () => void;
  onConnection?: (connected: boolean) => void;
  checkSession?: () => Promise<boolean>;
  reconnectDelayMs?: number;
};

type ScopeLoss = { kind: 'revoked'; error: ClientError } | { kind: 'reset'; cursor: string };

const operations = new Map(routes.map((route) => [route.operationId, route]));
const authRequired = (route: RouteDefinition) => route.permission !== 'public' && route.operationId !== 'getSession';

function operation(name: string, kind: RouteDefinition['kind']): RouteDefinition {
  const route = operations.get(name);
  if (route?.kind !== kind) throw new ClientError('INVALID_REQUEST');
  return route;
}

function path(route: RouteDefinition, input: QueryValues): string {
  const params = { ...input };
  const target = route.path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
    const value = params[name];
    if (typeof value !== 'string' || !value || value === '.' || value === '..') throw new ClientError('INVALID_REQUEST');
    delete params[name];
    return encodeURIComponent(value);
  });
  if (route.method !== 'GET' && Object.keys(params).length) throw new ClientError('INVALID_REQUEST');
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params).sort(([a], [b]) => a.localeCompare(b))) {
    if (value !== undefined) query.set(name, String(value));
  }
  return '/api/v1' + target + (query.size ? '?' + query.toString() : '');
}

export function scopedQueryKey(scope: Scope, name: string, parameters: QueryValues = {}) {
  return ['patrick', scope.account_id, scope.data_domain, scope.permission_epoch, name, parameters] as const;
}

export class ApiClient {
  private scope?: Scope;
  private resetScope?: Scope;
  private fence = new AbortController();

  constructor(
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly onScopeLoss: (scope: Scope, cause: ScopeLoss) => void = () => {},
  ) {}

  authorize(scope: Scope): void {
    const validated = scopeSchema.parse(scope);
    if (this.scope && sameScope(this.scope, validated)) return;
    if (this.scope || (this.resetScope && !sameScope(this.resetScope, validated))) this.revoke();
    this.resetScope = undefined;
    this.scope = validated;
  }

  revoke(cause: ScopeLoss = { kind: 'revoked', error: new ClientError('FORBIDDEN', 403) }): void {
    const old = cause.kind === 'reset' ? this.scope : this.scope ?? this.resetScope;
    this.scope = undefined;
    this.resetScope = cause.kind === 'reset' ? old : undefined;
    this.fence.abort(new ClientError('FORBIDDEN', 403));
    this.fence = new AbortController();
    if (old) this.onScopeLoss(old, cause);
  }

  private accessSignal(options?: RequestOptions): AbortSignal {
    return options?.signal ? AbortSignal.any([options.signal, this.fence.signal]) : this.fence.signal;
  }

  private async send(target: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(target, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason ?? error;
      throw new ClientError('UNAVAILABLE', undefined, true);
    }
    init.signal?.throwIfAborted();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const error = new ClientError(response.status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN', response.status);
        // Response headers are sufficient. A slow or hostile error body cannot hold the scope open.
        const isSessionCheck = target === '/api/v1/session' && init.method === 'GET';
        if (this.scope || (this.resetScope && isSessionCheck)) this.revoke({ kind: 'revoked', error });
        discardBody(response);
        throw error;
      }
      const err = errorBodySchema.safeParse(await response.json().catch(() => undefined));
      init.signal?.throwIfAborted();
      const fallback = response.status === 404 ? 'NOT_FOUND' : 'UNAVAILABLE';
      throw new ClientError(err.success ? err.data.code : fallback, response.status,
        err.success && err.data.retryable, err.success ? err.data.correlation_id : undefined,
        err.success ? err.data.current_revision : undefined);
    }
    return response;
  }

  private async call(route: RouteDefinition, target: string, options?: RequestOptions, body?: unknown,
    headers?: Record<string, string>): Promise<unknown> {
    if (authRequired(route) && !this.scope) throw new ClientError('UNAUTHENTICATED', 401);
    const signal = this.accessSignal(options);
    signal.throwIfAborted();
    const response = await this.send(target, {
      method: route.method, signal,
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => undefined);
    signal.throwIfAborted();
    const result = route.response.safeParse(payload);
    if (!result.success) throw new ClientError('INVALID_RESPONSE', response.status);
    return result.data;
  }

  async signInWithPasskey(ticket?: string, options?: RequestOptions): Promise<void> {
    const passkey = globalThis.PublicKeyCredential;
    if (!globalThis.isSecureContext || !passkey || !navigator.credentials ||
        typeof passkey.prototype.toJSON !== 'function' ||
        (ticket === undefined
          ? typeof passkey.parseRequestOptionsFromJSON !== 'function'
          : typeof passkey.parseCreationOptionsFromJSON !== 'function')) {
      throw new ClientError('PASSKEY_UNAVAILABLE');
    }
    const signal = this.accessSignal(options);
    const route = operation('createAuthChallenge', 'write');
    const { challenge, challenge_id } = await this.call(route, path(route, {}), { signal },
      { rp_id: globalThis.location.hostname }, ticket === undefined ? undefined : { 'x-patrick-bootstrap': ticket }) as {
      challenge: unknown; challenge_id: string;
    };
    const credential = ticket === undefined
      ? await navigator.credentials.get({
        publicKey: passkey.parseRequestOptionsFromJSON(challenge as PublicKeyCredentialRequestOptionsJSON), signal,
      })
      : await navigator.credentials.create({
        publicKey: passkey.parseCreationOptionsFromJSON(challenge as PublicKeyCredentialCreationOptionsJSON), signal,
      });
    if (!(credential instanceof passkey)) throw new ClientError('UNAUTHENTICATED');
    await this.write('verifyAuth', {}, { challenge_id, credential: credential.toJSON() }, { signal });
  }

  async read(name: string, parameters: QueryValues = {}, options?: RequestOptions): Promise<Snapshot<unknown>> {
    const route = operation(name, 'read');
    if (route.responseMediaType === 'text/event-stream') throw new ClientError('INVALID_REQUEST');
    const expected = this.scope;
    if (expected && parameters.domain !== undefined && parameters.domain !== expected.data_domain) {
      throw new ClientError('FORBIDDEN', 403);
    }
    // T13 reads take an optional domain. T01 routes without that field retain their own strict schemas.
    const scoped = expected ? route.request.safeParse({ ...parameters, domain: expected.data_domain }) : undefined;
    const checked = scoped?.success ? scoped : route.request.safeParse(parameters);
    if (!checked.success) throw new ClientError('INVALID_REQUEST');
    const signal = this.accessSignal(options);
    const response = await this.call(route, path(route, checked.data as QueryValues), { signal }) as Snapshot<unknown>;
    signal.throwIfAborted();
    if (expected) {
      if (!this.scope || !sameScope(expected, this.scope)) throw new ClientError('FORBIDDEN', 403);
      if (!sameScope(expected, response.scope)) {
        this.revoke();
        throw new ClientError('FORBIDDEN', 403);
      }
    }
    return response;
  }

  async write(name: string, parameters: QueryValues, body: unknown, options?: RequestOptions): Promise<unknown> {
    const route = operation(name, 'write');
    const checked = route.request.safeParse(body);
    if (!checked.success) throw new ClientError('INVALID_REQUEST');
    return this.call(route, path(route, parameters), options, route.method === 'DELETE' ? undefined : checked.data);
  }

  async writeAttachment(name: 'exportDiagnostics', parameters: QueryValues, body: unknown, options?: RequestOptions):
    Promise<{ response: Response; signal: AbortSignal }> {
    const route = operation(name, 'write');
    const checked = route.request.safeParse(body);
    if (!checked.success) throw new ClientError('INVALID_REQUEST');
    if (!this.scope) throw new ClientError('UNAUTHENTICATED', 401);
    const signal = this.accessSignal(options);
    signal.throwIfAborted();
    const response = await this.send(path(route, parameters), {
      method: route.method, signal, headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(checked.data),
    });
    signal.throwIfAborted();
    return { response, signal };
  }

  async command(name: string, parameters: QueryValues, intent: Intent, options?: RequestOptions): Promise<Receipt> {
    const route = operation(name, 'write');
    if (route.response !== commandAcceptedSchema) throw new ClientError('INVALID_REQUEST');
    return this.submit(name, parameters, intent, options) as Promise<Receipt>;
  }

  /** Sends a command envelope and returns the response the route declares.
   *
   * A command that answers with a snapshot instead of a receipt goes through
   * this path; the envelope is hashed the same way the receipt path hashes it.
   */
  async submit(name: string, parameters: QueryValues, intent: Intent, options?: RequestOptions): Promise<unknown> {
    if (!this.scope) throw new ClientError('UNAUTHENTICATED', 401);
    const signal = this.accessSignal(options);
    const payload = structuredClone(intent.payload);
    const bytes = new TextEncoder().encode(canonicalPayload(payload));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const payload_hash = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
    signal.throwIfAborted();
    return this.write(name, parameters, { ...intent, payload, payload_hash }, { signal });
  }

  async subscribe(snapshot: Snapshot<unknown>, options: SubscribeOptions): Promise<void> {
    if (!this.scope || !sameScope(this.scope, snapshot.scope)) throw new ClientError('FORBIDDEN', 403);
    if (!snapshot.stream_cursor) throw new ClientError('INVALID_REQUEST');
    const tracker = new EventTracker(snapshot.scope, snapshot.stream_cursor);
    const signal = this.accessSignal(options);
    const reset = () => {
      if (signal.aborted) return;
      this.revoke({ kind: 'reset', cursor: tracker.cursor });
      options.onReset?.();
    };
    const route = operation('listEvents', 'read');
    const domain = snapshot.scope.data_domain;
    const initial = route.request.safeParse({ after: snapshot.stream_cursor, domain });
    const reconnect = route.request.safeParse({ domain });
    if (!initial.success || !reconnect.success) throw new ClientError('INVALID_REQUEST');
    const initialPath = path(route, initial.data as QueryValues);
    const reconnectPath = path(route, reconnect.data as QueryValues);
    const baseDelay = options.reconnectDelayMs ?? 1500;
    let delay = baseDelay;
    let first = true;
    while (!signal.aborted) {
      if (!first) {
        await waitForDelay(delay, signal);
        if (signal.aborted) return;
        delay = Math.min(delay * 2, 30_000);
        try {
          const valid = options.checkSession ? await options.checkSession() : Boolean(await this.read('getSession', {}, { signal }));
          if (signal.aborted) return;
          if (!valid) { this.revoke(); return; }
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof ClientError && error.code === 'UNAVAILABLE') continue;
          throw error;
        }
      }
      try {
        const response = await this.send(first ? initialPath : reconnectPath, {
          method: 'GET', signal,
          headers: { accept: 'text/event-stream', ...(!first ? { 'last-event-id': tracker.cursor } : {}) },
        });
        if (signal.aborted) { discardBody(response); return; }
        const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
        if (!response.body || mediaType !== 'text/event-stream') {
          discardBody(response);
          throw new ClientError('UNAVAILABLE', response.status, true);
        }
        options.onConnection?.(true);
        if (signal.aborted) { discardBody(response); return; }
        for await (const frame of readFrames(response.body)) {
          if (signal.aborted) return;
          if (frame.type === 'reset_required') { reset(); return; }
          if (frame.type === 'authorization_revoked' || frame.type === 'scope_revoked') { this.revoke(); return; }
          const body: unknown = parseJson(frame.data);
          if (isControl(body, 'reset_required')) { reset(); return; }
          if (isControl(body, 'scope_revoked')) { this.revoke(); return; }
          const disposition = tracker.accept(frame.id, body);
          if (disposition === 'revoked') { this.revoke(); return; }
          if (disposition === 'reset') throw new ClientError('UNAVAILABLE', undefined, true);
          delay = baseDelay;
          if (disposition === 'updated' && tracker.latest) options.onUpdate(tracker.latest);
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ClientError && error.code !== 'UNAVAILABLE' && !error.retryable) throw error;
      } finally {
        if (!signal.aborted) options.onConnection?.(false);
      }
      first = false;
    }
  }
}

function isControl(body: unknown, type: string): boolean {
  return !!body && typeof body === 'object' && 'type' in body && body.type === type;
}

function parseJson(input: string): unknown {
  try { return JSON.parse(input) as unknown; } catch { return undefined; }
}

function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}
