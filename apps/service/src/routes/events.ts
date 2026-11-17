import { routes } from '@patrick/contracts';
import type { Hono } from 'hono';
import type { ProjectionScope } from '../../../../packages/storage/src/views/cursors.js';
import { ApiError } from '../errors.js';
import { handle } from './http.js';
import { oneValue, projectionScope, type ProjectionReady, type ProjectionResources } from './work.js';

const eventRoute = routes.find((route) => route.operationId === 'listEvents');
if (!eventRoute) throw new Error('PROJECTION_EVENT_CONTRACT_MISSING');
const eventPermissions = [eventRoute.permission, ...eventRoute.scopePermissions ?? []];
const encoder = new TextEncoder();
const maxBufferedEvents = 64;
const maxBufferedBytes = 256 * 1024;

export function mountProjectionEventRoutes(app: Hono, ready: ProjectionReady, options: { pollMs?: number } = {}): void {
  app.get('/api/v1/events', (c) => handle(c, async () => {
    const resources = ready();
    const request = c.req.raw;
    const query = new URL(c.req.url).searchParams;
    const scope = await projectionScope(resources, request, eventPermissions, oneValue(query, 'domain'));
    const after = request.headers.get('last-event-id') || oneValue(query, 'after');
    return subscribeEvents(resources, request, scope, after, options.pollMs ?? 350);
  }));
}

function subscribeEvents(resources: ProjectionResources, request: Request, scope: ProjectionScope, after: string | undefined, pollMs: number): Response {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let active = false;
  let immediately = false;
  let timer: NodeJS.Timeout | undefined;
  let wakeReader: (() => void) | undefined;
  let cursor = after;
  let queued: Uint8Array[] = [];
  let bytes = 0;
  let lastFrame = Date.now();

  const abort = () => stop();
  function stop(terminal?: 'reset_required' | 'scope_revoked', cancelled = false) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
    queued = [];
    bytes = 0;
    if (!cancelled) {
      if (terminal) controller.enqueue(encoder.encode(record(terminal, {})));
      controller.close();
    }
    wakeReader?.();
    wakeReader = undefined;
  }

  function schedule(delay: number) {
    if (closed || active) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      active = true;
      void poll().catch((error: unknown) => {
        const revoked = error instanceof ApiError && (error.status === 401 || error.status === 403);
        stop(revoked ? 'scope_revoked' : 'reset_required');
      }).finally(() => {
        active = false;
        schedule(immediately && wakeReader ? 0 : pollMs);
      });
    }, delay);
    timer.unref();
  }
  function flush() {
    if (!wakeReader || !queued.length) return;
    controller.enqueue(Buffer.concat(queued, bytes));
    queued = [];
    bytes = 0;
    wakeReader();
    wakeReader = undefined;
    lastFrame = Date.now();
  }
  async function poll() {
    const current = await projectionScope(resources, request, eventPermissions, scope.dataDomain);
    if (closed || request.signal.aborted) return;
    if (current.permissionEpoch !== scope.permissionEpoch || current.permissionDigest !== scope.permissionDigest ||
        current.sessionDigest !== scope.sessionDigest || current.accountId !== scope.accountId || current.callerId !== scope.callerId) {
      stop('scope_revoked');
      return;
    }
    immediately = false;
    if (wakeReader && queued.length) {
      flush();
      immediately = true;
      return;
    }
    const replay = cursor ? resources.projection.eventsAfter(current, cursor) : { status: 'reset_required' } as const;
    if (replay.status === 'reset_required') {
      stop('reset_required');
      return;
    }
    for (const { id, event } of replay.events) {
      const frame = encoder.encode(record(event.type, event, id));
      if (queued.length + 1 >= maxBufferedEvents || bytes + frame.byteLength >= maxBufferedBytes) {
        if (wakeReader && queued.length) {
          flush();
          immediately = true;
          return; // The unqueued record will be read again from the last buffer cursor.
        }
        // Drop only this connection. The client's last received ID remains its replay position.
        stop();
        return;
      }
      queued.push(frame);
      bytes += frame.byteLength;
      cursor = id;
    }
    if (wakeReader && !queued.length && Date.now() - lastFrame >= 15_000) {
      const heartbeat = encoder.encode(': heartbeat\n\n');
      queued.push(heartbeat);
      bytes = heartbeat.byteLength;
    }
    immediately = replay.events.length > 0;
    flush();
  }

  const stream = new ReadableStream<Uint8Array>({
    start(out) {
      controller = out;
      if (request.signal.aborted) stop();
      else {
        request.signal.addEventListener('abort', abort, { once: true });
        schedule(0);
      }
    },
    pull() {
      return new Promise<void>((resolve) => {
        wakeReader = resolve;
        schedule(0);
      });
    },
    cancel() { stop(undefined, true); },
  }, { highWaterMark: 0 });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } });
}

function record(type: string, data: unknown, id?: string): string {
  return `${id ? `id: ${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}
