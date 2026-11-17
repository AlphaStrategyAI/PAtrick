import { sseEventSchema } from '@patrick/contracts/envelope';
import type { Snapshot } from '@patrick/contracts/envelope';

export type Scope = Snapshot<unknown>['scope'];
export type Watermark = Snapshot<unknown>['watermark'];
export type StreamEvent = ReturnType<typeof sseEventSchema.parse>;

export function sameScope(left: Scope, right: Scope): boolean {
  return left.account_id === right.account_id && left.data_domain === right.data_domain
    && left.permission_epoch === right.permission_epoch;
}

export function covers(actual: Watermark, required: Watermark): boolean {
  return actual.hub_seq >= required.hub_seq && actual.domain_seq >= required.domain_seq;
}

export class EventTracker {
  private readonly seen = new Set<string>();
  private readonly revisions = new Map<string, number>();
  latest?: StreamEvent;

  constructor(private readonly scope: Scope, public cursor: string) {}

  accept(cursor: string, candidate: unknown): 'updated' | 'ignored' | 'revoked' | 'reset' {
    const parsed = sseEventSchema.safeParse(candidate);
    if (!parsed.success || !cursor || /[\r\n\0]/.test(cursor)) return 'reset';
    const event = parsed.data;
    if (!sameScope(event.scope, this.scope)) return 'revoked';
    this.cursor = cursor;
    if (this.seen.has(event.event_id)) return 'ignored';
    this.seen.add(event.event_id);
    if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!);
    if (event.resource_id !== null && event.resource_revision !== null) {
      const prior = this.revisions.get(event.resource_id);
      if (prior !== undefined && event.resource_revision <= prior) return 'ignored';
      this.revisions.set(event.resource_id, event.resource_revision);
    }
    this.latest = event;
    return 'updated';
  }
}

export type Frame = { id: string; type: string; data: string };

export async function* readFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let fields: string[] = [];
  let frameSize = 0;
  let id = '';
  let type = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline = /[\r\n]/.exec(pending);
      while (newline && (done || newline[0] !== '\r' || newline.index < pending.length - 1)) {
        const line = pending.slice(0, newline.index);
        const width = pending.slice(newline.index, newline.index + 2) === '\r\n' ? 2 : 1;
        pending = pending.slice(newline.index + width);
        if (line === '') {
          if (fields.length) yield { id, type: type || 'message', data: fields.join('\n') };
          type = '';
          fields = [];
          frameSize = 0;
        } else if (!line.startsWith(':')) {
          frameSize += line.length;
          if (frameSize > 262_144) throw new TypeError('Event frame too large');
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const raw = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') type = raw;
          else if (field === 'data') fields.push(raw);
          else if (field === 'id' && !raw.includes('\0')) id = raw;
        }
        newline = /[\r\n]/.exec(pending);
      }
      if (done) return;
      if (pending.length > 262_144) throw new TypeError('Event line too large');
    }
  } finally {
    try { await reader.cancel(); } catch { /* Transport already closed. */ }
    reader.releaseLock();
  }
}
