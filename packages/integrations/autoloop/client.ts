import { withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import type { HubCardView, HubRuleLine, HubRunEventView, HubRunView, HubStatePage } from './observer.js';

export type StageKind = 'draft.requested' | 'draft.ready';

export type HubEvent = {
  event_id: string;
  root: string;
  cause: string;
  generation: number;
  hops: number;
  kind: StageKind | 'work.requested' | 'consultation.requested' | 'answer.verified' | 'evidence.ready';
};

export type PublishableHubEvent = HubEvent & {
  request_id?: string;
  stage_key?: string;
};

export type HubWireEvent = {
  id: string;
  type: string;
  subject: string;
  summary: string;
  detail: string;
  hops: number;
};

export type HubEventAck = {
  event: number;
  duplicate: boolean;
  routed: string[];
};

export type HubEventOutcome = {
  event: number;
  runs: Array<{ run: number; rule: string; state: 'queued' | 'claimed' | 'unknown' | 'done' | 'nothing' | 'cancelled' }>;
};

type HubTimer = { key: string; about: string; at: string };
type HubLater = HubTimer | { key: string; cancel: true };

export type HubAnswerView = {
  card: number;
  choice: number | null;
  chosen: string | null;
  text: string | null;
};

export type HubJob = {
  run: number;
  token: string;
  rule: { name: string };
  context: {
    answers: HubAnswerView[];
    events: Array<HubRunEventView & { id?: string }>;
    timers?: HubTimer[];
  };
};

export type HubPublisher = {
  postEvent(body: HubWireEvent): Promise<HubEventAck>;
};

export const SOURCE_CHANGE_RULE = '来源变化';
export const CONSULTATION_RULE = '咨询';
export const RESUME_RULE = '阶段恢复';
export const CONSULTATION_GROUP = 'consultation';
export const CONSULTATION_WORKER = 'patrick-consultation';
export const CONSULTATION_PARALLEL = 4;
export const HUB_SOURCE = 'patrick';
export const PINNED_HUB_COMMIT = '45aecbf578289cda72d1fc773dcad069bfe7778b';

const SUBJECT = /^[A-Za-z0-9#._:/@-]+$/;

export function deriveStageEvent(parent: HubEvent, eventId: string, kind: StageKind): HubEvent {
  const hops = parent.hops + 1;
  if (hops > 8) throw new Error('HOPS_LIMIT');
  return { event_id: eventId, root: parent.root, cause: parent.event_id, generation: parent.generation, hops, kind };
}

export function deriveResumeEvent(
  parent: HubEvent,
  eventId: string,
  kind: 'answer.verified' | 'evidence.ready',
  stageKey: string,
): HubEvent & { stage_key: string } {
  return {
    event_id: eventId,
    root: parent.root,
    cause: parent.event_id,
    generation: parent.generation,
    hops: parent.hops,
    kind,
    stage_key: stageKey,
  };
}

export function hubRules(command: readonly string[]) {
  return {
    timezone: 'Asia/Shanghai',
    sources: { patrick: { name: 'PAtrick' } },
    agents: {
      probe: {
        name: 'Probe',
        worker: 'w1',
        use: 'command',
        access: 'read' as const,
        command: [...command],
      },
      consultation: {
        name: 'Consultation',
        worker: CONSULTATION_WORKER,
        use: 'command',
        access: 'read' as const,
        command: [...command],
      },
    },
    channels: {},
    rules: [
      {
        name: SOURCE_CHANGE_RULE,
        when: { source: HUB_SOURCE, types: ['source.changed'] },
        to: 'probe',
        cwd: '/tmp',
        prompt: '处理来源变化。',
        group: 'work',
        parallel: 4,
      },
      {
        name: CONSULTATION_RULE,
        when: { source: HUB_SOURCE, types: ['consultation.requested'] },
        to: 'consultation',
        cwd: '/tmp',
        prompt: '回答咨询。',
        group: CONSULTATION_GROUP,
        parallel: CONSULTATION_PARALLEL,
      },
      {
        name: RESUME_RULE,
        when: { source: HUB_SOURCE, types: ['answer.verified', 'evidence.ready'] },
        to: 'probe',
        cwd: '/tmp',
        prompt: '继续同一件工作。',
        group: RESUME_RULE,
      },
    ],
    elsewhere: [],
  };
}

export function toHubEventBody(event: PublishableHubEvent): HubWireEvent {
  const requestId = event.request_id ?? '';
  const stageKey = event.stage_key ?? '';
  let type: string = event.kind;
  let subject = event.event_id;
  if (event.kind === 'work.requested') {
    type = 'source.changed';
    subject = event.event_id;
  } else if (event.kind === 'consultation.requested') {
    if (!requestId) throw new Error('CONSULTATION_SUBJECT_REQUIRED');
    type = 'consultation.requested';
    subject = requestId;
  } else if (event.kind === 'answer.verified' || event.kind === 'evidence.ready') {
    type = event.kind;
    subject = stageKey || (event.kind === 'answer.verified' ? 'answer' : 'evidence_ready');
  }
  if (!SUBJECT.test(subject) || [...subject].length > 100) throw new Error('HUB_SUBJECT_INVALID');
  const detail = JSON.stringify({
    root: event.root,
    cause: event.cause,
    generation: event.generation,
    hops: event.hops,
    kind: event.kind,
    stage_key: stageKey || null,
    request_id: requestId || null,
  });
  return { id: event.event_id, type, subject, summary: event.kind, detail, hops: event.hops };
}

export async function publishHubEvent(
  db: SqliteDatabase,
  hub: HubPublisher,
  event: PublishableHubEvent,
  now = new Date().toISOString(),
): Promise<'accepted' | 'duplicate'> {
  const ack = await hub.postEvent(toHubEventBody(event));
  const inserted = withImmediateTransaction(db, () => {
    const result = db.prepare(`INSERT INTO hub_events (
      event_id, root, cause, generation, hops, kind, request_id, stage_key, hub_event, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO NOTHING`).run(
      event.event_id,
      event.root,
      event.cause,
      event.generation,
      event.hops,
      event.kind,
      event.request_id ?? null,
      event.stage_key ?? null,
      ack.event,
      now,
    );
    return result.changes === 1;
  });
  if (!inserted || ack.duplicate) return 'duplicate';
  return 'accepted';
}

export type HubKeys = { owner: string; worker: string; source: string };

export type HubClient = HubPublisher & {
  health(): Promise<{ ok: boolean; commit: string }>;
  eventOutcome(event: number): Promise<HubEventOutcome>;
  state(before?: number): Promise<HubStatePage>;
  answer(cardId: number, body: { text: string } | { choice: number }): Promise<{ changed: boolean; state: string }>;
  claim(claimId: string): Promise<HubJob | null>;
  heartbeat(claimId: string, run: number, signal?: AbortSignal): Promise<number[]>;
  result(run: number, token: string, body: {
    outcome: 'done' | 'nothing' | 'failed';
    summary?: string;
    ask?: unknown[];
    later?: HubLater[];
  }): Promise<{ rejected: unknown[] }>;
};

export function createHubClient(baseUrl: string, keys: HubKeys): HubClient {
  const base = baseUrl.replace(/\/$/, '');
  async function request(method: string, path: string, key: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(base + path, {
      method,
      signal,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) {
      const message = isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : text;
      throw new Error(`${method} ${path} -> ${response.status} ${message}`);
    }
    return parsed;
  }

  return {
    health: async () => {
      const response = await fetch(`${base}/healthz`);
      const parsed: unknown = await response.json();
      if (!response.ok || !isRecord(parsed) || parsed.ok !== true || typeof parsed.commit !== 'string') {
        throw new Error(`GET /healthz -> ${response.status}`);
      }
      return { ok: true, commit: parsed.commit };
    },
    postEvent: async (body) => parseAck(await request('POST', '/v1/events', keys.source, body)),
    eventOutcome: async (event) => {
      if (!Number.isSafeInteger(event) || event < 1) throw new Error('HUB_EVENT_OUTCOME_INVALID');
      return parseEventOutcome(await request('GET', `/v1/events/${event}`, keys.source), event);
    },
    state: async (before) => parseState(await request('GET', before === undefined ? '/v1/state' : `/v1/state?before=${before}`, keys.owner)),
    answer: async (cardId, body) => {
      const parsed = await request('POST', `/v1/cards/${cardId}/answer`, keys.owner, body);
      if (!isRecord(parsed) || typeof parsed.changed !== 'boolean' || typeof parsed.state !== 'string') {
        throw new Error('HUB_ANSWER_INVALID');
      }
      return { changed: parsed.changed, state: parsed.state };
    },
    claim: async (claimId) => {
      const parsed = await request('GET', `/v1/work?claim=${encodeURIComponent(claimId)}&wait=0&capacity=1`, keys.worker);
      if (!isRecord(parsed)) throw new Error('HUB_WORK_INVALID');
      if (parsed.job === null) return null;
      return parseJob(parsed.job);
    },
    heartbeat: async (claimId, run, signal) => {
      const params = new URLSearchParams({ claim: claimId, wait: '0', capacity: '0', running: String(run) });
      const parsed = await request('GET', `/v1/work?${params}`, keys.worker, undefined, signal);
      if (!isRecord(parsed) || parsed.job !== null || !Array.isArray(parsed.cancel)
        || !parsed.cancel.every((id: unknown) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)) {
        throw new Error('HUB_HEARTBEAT_INVALID');
      }
      return parsed.cancel;
    },
    result: async (run, token, body) => {
      const parsed = await request('POST', `/v1/runs/${run}/result`, token, body);
      if (!isRecord(parsed) || !Array.isArray(parsed.rejected)) throw new Error('HUB_RESULT_INVALID');
      return { rejected: parsed.rejected };
    },
  };
}

function parseAck(value: unknown): HubEventAck {
  if (!isRecord(value) || typeof value.event !== 'number' || typeof value.duplicate !== 'boolean' || !Array.isArray(value.routed)) {
    throw new Error('HUB_EVENT_INVALID');
  }
  const routed: string[] = [];
  for (const item of value.routed) {
    if (typeof item !== 'string') throw new Error('HUB_EVENT_INVALID');
    routed.push(item);
  }
  return { event: value.event, duplicate: value.duplicate, routed };
}

function parseEventOutcome(value: unknown, event: number): HubEventOutcome {
  if (!isRecord(value) || value.event !== event || !Array.isArray(value.runs)) throw new Error('HUB_EVENT_OUTCOME_INVALID');
  const runs = value.runs.map((run: unknown): HubEventOutcome['runs'][number] => {
    if (!isRecord(run) || typeof run.run !== 'number' || !Number.isSafeInteger(run.run) || run.run < 1 || typeof run.rule !== 'string'
      || (run.state !== 'queued' && run.state !== 'claimed' && run.state !== 'unknown'
        && run.state !== 'done' && run.state !== 'nothing' && run.state !== 'cancelled')) {
      throw new Error('HUB_EVENT_OUTCOME_INVALID');
    }
    return { run: run.run, rule: run.rule, state: run.state };
  });
  return { event, runs };
}

function parseState(value: unknown): HubStatePage {
  if (!isRecord(value) || typeof value.seq !== 'number' || typeof value.hasMore !== 'boolean' || !Array.isArray(value.runs) || !Array.isArray(value.cards) || !Array.isArray(value.lines)) {
    throw new Error('HUB_STATE_INVALID');
  }
  return {
    seq: value.seq,
    hasMore: value.hasMore,
    nextBefore: nullableNumber(value.nextBefore, 'HUB_STATE_INVALID'),
    runs: value.runs.map(parseRun),
    cards: value.cards.map(parseCard),
    lines: value.lines.map(parseLine),
  };
}

function parseLine(value: unknown): HubRuleLine {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.group !== 'string') throw new Error('HUB_STATE_INVALID');
  return { name: value.name, group: value.group };
}

function parseRun(value: unknown): HubRunView {
  if (!isRecord(value) || typeof value.id !== 'number' || typeof value.rule !== 'string' || typeof value.state !== 'string') {
    throw new Error('HUB_STATE_INVALID');
  }
  if (typeof value.attempts !== 'number' || typeof value.summary !== 'string' || typeof value.error !== 'string' || !Array.isArray(value.events)) {
    throw new Error('HUB_STATE_INVALID');
  }
  return {
    id: value.id,
    rule: value.rule,
    state: value.state,
    attempts: value.attempts,
    summary: value.summary,
    error: value.error,
    events: value.events.map(parseRunEvent),
  };
}

function parseRunEvent(value: unknown): HubRunEventView {
  if (!isRecord(value) || typeof value.source !== 'string' || typeof value.type !== 'string' || typeof value.subject !== 'string' || typeof value.summary !== 'string') {
    throw new Error('HUB_STATE_INVALID');
  }
  const event: HubRunEventView = { source: value.source, type: value.type, subject: value.subject, summary: value.summary };
  if (typeof value.detail === 'string') event.detail = value.detail;
  return event;
}

function parseCard(value: unknown): HubCardView {
  if (!isRecord(value) || typeof value.id !== 'number' || typeof value.title !== 'string' || typeof value.state !== 'string') {
    throw new Error('HUB_STATE_INVALID');
  }
  return {
    id: value.id,
    title: value.title,
    state: value.state,
    choice: nullableNumber(value.choice, 'HUB_STATE_INVALID'),
    answer: nullableString(value.answer, 'HUB_STATE_INVALID'),
  };
}

function parseJob(value: unknown): HubJob {
  if (!isRecord(value) || typeof value.run !== 'number' || typeof value.token !== 'string' || !isRecord(value.rule) || typeof value.rule.name !== 'string' || !isRecord(value.context)) {
    throw new Error('HUB_WORK_INVALID');
  }
  if (!Array.isArray(value.context.answers) || !Array.isArray(value.context.events)
    || (value.context.timers !== undefined && !Array.isArray(value.context.timers))) throw new Error('HUB_WORK_INVALID');
  return {
    run: value.run,
    token: value.token,
    rule: { name: value.rule.name },
    context: {
      answers: value.context.answers.map(parseAnswer),
      timers: value.context.timers?.map(parseTimer),
      events: value.context.events.map((event: unknown) => ({
        ...parseRunEvent(event), ...(isRecord(event) && typeof event.id === 'string' ? { id: event.id } : {}),
      })),
    },
  };
}

function parseTimer(value: unknown): HubTimer {
  if (!isRecord(value) || typeof value.key !== 'string' || typeof value.about !== 'string' || typeof value.at !== 'string') {
    throw new Error('HUB_WORK_INVALID');
  }
  return { key: value.key, about: value.about, at: value.at };
}

function parseAnswer(value: unknown): HubAnswerView {
  if (!isRecord(value) || typeof value.card !== 'number') throw new Error('HUB_WORK_INVALID');
  return {
    card: value.card,
    choice: nullableNumber(value.choice, 'HUB_WORK_INVALID'),
    chosen: nullableString(value.chosen, 'HUB_WORK_INVALID'),
    text: nullableString(value.text, 'HUB_WORK_INVALID'),
  };
}

function nullableNumber(value: unknown, code: string): number | null {
  if (value === null) return null;
  if (typeof value === 'number') return value;
  throw new Error(code);
}

function nullableString(value: unknown, code: string): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  throw new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
