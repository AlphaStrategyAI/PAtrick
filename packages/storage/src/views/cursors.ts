import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type ProjectionScope = {
  accountId: string;
  callerId: string;
  dataDomain: string;
  permissionEpoch: number;
  permissionDigest: string;
  sessionDigest: string;
};

export type ProjectionPosition = { epoch: number; seq: number };
export type ProjectionWindow = { epoch: number; floor: number; head: number };
export type WorkPagePosition = ProjectionPosition & { filter: string; sortKey: string; workId: string };

type CursorBody = { v: 1; kind: 'stream' | 'work.page'; scope: string } & ProjectionPosition;
const digest = /^[a-f0-9]{64}$/;
const cursorPattern = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/;

export function createProjectionCursorCodec(signingKey: Uint8Array) {
  if (signingKey.byteLength < 32) throw new Error('PROJECTION_CURSOR_KEY_TOO_SHORT');
  const key = Buffer.from(signingKey);

  function sign(value: string): string {
    return createHmac('sha256', key).update('patrick.projection.cursor.v1\0').update(value).digest('base64url');
  }

  function issue(scope: ProjectionScope, kind: CursorBody['kind'], position: ProjectionPosition | WorkPagePosition) {
    if (!isSequence(position.seq) || !isSequence(position.epoch)) throw new Error('PROJECTION_POSITION_INVALID');
    const claims = { ...position, v: 1, kind, scope: fingerprint(scope) };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    if (payload.length > 1500) throw new Error('PROJECTION_CURSOR_TOO_LONG');
    return `${payload}.${sign(payload)}`;
  }

  function read(value: string, scope: ProjectionScope, window: ProjectionWindow, kind: CursorBody['kind']) {
    if (value.length > 1600) return null;
    const match = cursorPattern.exec(value);
    if (!match) return null;
    const [, payload, signature] = match;
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(sign(payload)))) return null;
    let claims: unknown;
    try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
    catch { return null; }
    if (!claims || typeof claims !== 'object') return null;
    const body = claims as Partial<CursorBody & WorkPagePosition>;
    if (body.v !== 1 || body.kind !== kind || body.scope !== fingerprint(scope) || body.epoch !== window.epoch
      || !isSequence(body.epoch) || !isSequence(body.seq) || body.seq < window.floor || body.seq > window.head) return null;
    return { ...body, epoch: body.epoch, seq: body.seq };
  }

  return {
    stream(scope: ProjectionScope, position: ProjectionPosition): string {
      return issue(scope, 'stream', { epoch: position.epoch, seq: position.seq });
    },
    page(scope: ProjectionScope, position: WorkPagePosition): string {
      const { epoch, seq, filter, sortKey, workId } = position;
      return issue(scope, 'work.page', { epoch, seq, filter, sortKey, workId });
    },
    readStream(value: string, scope: ProjectionScope, window: ProjectionWindow): ProjectionPosition | null {
      const body = read(value, scope, window, 'stream');
      return body ? { epoch: body.epoch, seq: body.seq } : null;
    },
    readPage(value: string, scope: ProjectionScope, window: ProjectionWindow, filter: string): WorkPagePosition | null {
      const body = read(value, scope, window, 'work.page');
      if (!body || body.seq !== window.head || body.filter !== filter || !digest.test(filter)
        || typeof body.sortKey !== 'string' || typeof body.workId !== 'string' || !body.workId) return null;
      return { epoch: body.epoch, seq: body.seq, filter, sortKey: body.sortKey, workId: body.workId };
    },
  };
}

function fingerprint(scope: ProjectionScope): string {
  return createHash('sha256').update(JSON.stringify([
    scope.accountId, scope.callerId, scope.dataDomain, scope.permissionEpoch, scope.permissionDigest, scope.sessionDigest,
  ])).digest('hex');
}

function isSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
