import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { readRawCustom, saveRawCustom, encodeHubAnswer } from '../../packages/integrations/autoloop/answers.js';
import {
  check,
  command,
  createClaimFixture,
  doneAskRemainsUnanswered,
  read,
  settleNativeAnswer,
  type ResumeKey,
} from '../../packages/integrations/autoloop/agent.js';
import {
  CONSULTATION_GROUP,
  CONSULTATION_PARALLEL,
  CONSULTATION_RULE,
  PINNED_HUB_COMMIT,
  RESUME_RULE,
  SOURCE_CHANGE_RULE,
  deriveResumeEvent,
  deriveStageEvent,
  hubRules,
  publishHubEvent,
  toHubEventBody,
  type HubEvent,
  type HubEventAck,
  type PublishableHubEvent,
} from '../../packages/integrations/autoloop/client.js';
import { readHubView, rebuildHubView, storeHubView, type HubRunView, type HubStatePage } from '../../packages/integrations/autoloop/observer.js';
import { openDatabase, type SqliteDatabase } from '../../packages/storage/src/database.js';
import { PinnedHubError, runCommandPlugin, startPinnedHub, type PinnedHub } from './pinned-hub.js';

const RAW = '  先补证，再比较。  ';
const NATIVE_COMMAND = 'plugins/command/agent.ts command/read; POST /v1/runs/:id/result {"outcome":"done","summary":"no-op","later":[{"key":"answer","cancel":true}]}';
const ADMISSION_PATH = fileURLToPath(new URL('../../fixtures/contracts/admission-matrix.json', import.meta.url));
const MANIFEST_PATH = fileURLToPath(new URL('../../packages/storage/migrations/manifest.json', import.meta.url));

type AdmissionRow = {
  status: string;
  command: string;
  observation: string;
  evidenceSha256: string | null;
  rawCustomInput?: string;
  expectedChosen?: string | null;
};

function admission(): {
  autoloop_custom_text: AdmissionRow;
  autoloop_native_answer_resume: AdmissionRow;
} {
  return JSON.parse(readFileSync(ADMISSION_PATH, 'utf8')) as {
    autoloop_custom_text: AdmissionRow;
    autoloop_native_answer_resume: AdmissionRow;
  };
}

function temporaryDatabase(): { path: string; db: SqliteDatabase; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t04-'));
  const path = join(dir, 'patrick.sqlite');
  const db = openDatabase(path);
  return {
    path,
    db,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function workEvent(eventId: string, kind: HubEvent['kind'] = 'work.requested'): PublishableHubEvent {
  return { event_id: eventId, root: eventId, cause: eventId, generation: 1, hops: 0, kind };
}

function countEvents(db: SqliteDatabase, eventId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM hub_events WHERE event_id = ?').get(eventId) as { n: number };
  return row.n;
}

function customObservation(answer: { choice: number | null; chosen: string | null; text: string | null }): string {
  const choice = answer.choice === null ? 'null' : String(answer.choice);
  return [
    'custom-text-only',
    `commit ${PINNED_HUB_COMMIT}`,
    'command: POST /v1/cards/:id/answer {"text":"  先补证，再比较。  "}',
    'plugin: plugins/command/agent.ts command/read',
    `read-back: choice=${choice} chosen=${JSON.stringify(answer.chosen)} text=${JSON.stringify(answer.text)} card matches answers.card`,
    'upstream trims text; raw_custom remains "  先补证，再比较。  "',
  ].join('\n');
}

function nativeObservation(input: {
  state: string;
  attempts: number;
  summary: string;
  readText: string;
  resumeRule: string;
  resumeType: string;
  root: string;
  stageKey: string;
  claimStatus: string;
}): string {
  return [
    'native-answer-before-receipt',
    `commit ${PINNED_HUB_COMMIT}`,
    `command: ${NATIVE_COMMAND}`,
    `early: state=${input.state} attempts=${input.attempts} summary=${JSON.stringify(input.summary)}`,
    `read.text=${JSON.stringify(input.readText)} modelCalls=0 technicalRetries=0`,
    `resume: rule=${input.resumeRule} type=${input.resumeType} root=${input.root} stage_key=${input.stageKey} claimContinuation=${input.claimStatus}`,
  ].join('\n');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

test('stage lineage stops at eight hops and keeps the parent generation', () => {
  const parent = { event_id: 'e8', root: 'e0', cause: 'e7', generation: 2, hops: 8, kind: 'draft.requested' } as const;
  expect(() => deriveStageEvent(parent, 'e9', 'draft.ready')).toThrow('HOPS_LIMIT');
  expect(deriveStageEvent({ ...parent, hops: 7 }, 'e8-ready', 'draft.ready')).toMatchObject({
    root: 'e0', cause: 'e8', generation: 2, hops: 8,
  });
});

test('resume signals keep hops while only draft stages increase depth', () => {
  const parent = { event_id: 'e8', root: 'e0', cause: 'e7', generation: 2, hops: 7, kind: 'draft.requested' } as const;
  const resume = deriveResumeEvent(parent, 'e8-answer', 'answer.verified', 'work-1/2/q-1/e8/answer');
  expect(resume).toMatchObject({ root: 'e0', cause: 'e8', generation: 2, hops: 7, kind: 'answer.verified' });
  expect(resume.stage_key).toBe('work-1/2/q-1/e8/answer');
  const evidence = deriveResumeEvent({ ...parent, hops: 8 }, 'e8-evidence', 'evidence.ready', 'evidence_ready');
  expect(evidence.hops).toBe(8);
  const evidenceBody = toHubEventBody(evidence);
  expect(evidenceBody.type).toBe('evidence.ready');
  expect(evidenceBody.subject).toBe('evidence_ready');
  expect(JSON.parse(evidenceBody.detail)).toMatchObject({
    root: 'e0', cause: 'e8', generation: 2, hops: 8, stage_key: 'evidence_ready',
  });
  const body = toHubEventBody(resume);
  expect(body.hops).toBe(7);
  expect(body.type).toBe('answer.verified');
  expect(JSON.parse(body.detail)).toMatchObject({ root: 'e0', generation: 2, stage_key: resume.stage_key, hops: 7 });
  const work = toHubEventBody(workEvent('work-1'));
  expect(work.type).toBe('source.changed');
  expect(work.hops).toBe(0);
  const consultation = toHubEventBody({ ...workEvent('consult-1', 'consultation.requested'), request_id: 'request-1' });
  expect(consultation).toMatchObject({ type: 'consultation.requested', subject: 'request-1', hops: 0 });
  const rules = hubRules(['node', 'probe.mjs']);
  expect(rules.rules.find((rule) => rule.name === CONSULTATION_RULE)).toMatchObject({
    group: CONSULTATION_GROUP,
    parallel: CONSULTATION_PARALLEL,
  });
  expect(rules.rules.find((rule) => rule.name === SOURCE_CHANGE_RULE)?.when).toEqual({
    source: 'patrick',
    types: ['source.changed'],
  });
  expect(rules.rules.find((rule) => rule.name === SOURCE_CHANGE_RULE)?.parallel).toBe(4);
  const resumeRule = rules.rules.find((rule) => rule.name === RESUME_RULE);
  expect(resumeRule?.when).toEqual({ source: 'patrick', types: ['answer.verified', 'evidence.ready'] });
  expect(resumeRule?.group).toBe(RESUME_RULE);
  expect(resumeRule).not.toHaveProperty('parallel');
});

test('custom hub answers send the raw text and omit choice', () => {
  const payload = encodeHubAnswer({ kind: 'custom', raw_text: RAW });
  expect(payload).toEqual({ text: RAW });
  expect(Object.hasOwn(payload, 'choice')).toBe(false);
  const choice = encodeHubAnswer({ kind: 'choice', index: 1 });
  expect(choice).toEqual({ choice: 1 });
  expect(Object.hasOwn(choice, 'text')).toBe(false);
});

test('raw custom bytes stay untrimmed in the domain row', () => {
  const holder = temporaryDatabase();
  try {
    saveRawCustom(holder.db, 'sub-1', RAW);
    const stored = readRawCustom(holder.db, 'sub-1');
    expect(stored).toBe(RAW);
    expect(Buffer.from(stored, 'utf8').equals(Buffer.from(RAW, 'utf8'))).toBe(true);
  } finally {
    holder.close();
  }
});

test('a native answer before the stage is claimable ends with policy_wait and no model call', async () => {
  const port = createClaimFixture();
  const key: ResumeKey = {
    work_id: 'work-1',
    generation: 2,
    question_id: 'q-1',
    answer_event_id: 'ans-1',
    phase: 'answer',
  };
  const early = await settleNativeAnswer(port, key, 'attempt-1');
  expect(early).toMatchObject({
    controller: 'policy_wait',
    hubResult: { outcome: 'done', summary: 'no-op', later: [{ key: 'answer', cancel: true }] },
    noop: true,
    modelCalls: 0,
    technicalRetries: 0,
    claim: { status: 'waiting' },
  });
  expect((await settleNativeAnswer(port, key, 'attempt-1')).claim.status).toBe('waiting');
  port.setClaimable(key, true);
  const later = await settleNativeAnswer(port, key, 'attempt-2');
  expect(later.claim.status).toBe('claimed');
  if (later.claim.status === 'claimed') {
    expect(later.claim.grant).toMatchObject({ work_id: 'work-1', generation: 2, phase: 'answer', answer_event_id: 'ans-1' });
  }
  expect((await settleNativeAnswer(port, key, 'attempt-3')).claim).toMatchObject({ status: 'duplicate' });
  expect(doneAskRemainsUnanswered({ outcome: 'done', ask: [{ title: '还没答' }] })).toBe(true);
  expect(doneAskRemainsUnanswered({ outcome: 'done' })).toBe(false);

  const argv = command({ prompt: 'probe', cwd: '/tmp', contextFile: join(tmpdir(), 'context.json') });
  const proc = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', env: { ...process.env, PATRICK_CLAIM: 'waiting' } });
  expect(read(proc.stdout ?? '', proc.status, proc.stderr ?? '')).toMatchObject({
    controller: 'policy_wait',
    hubOutcome: 'done',
    noop: true,
    modelCalls: 0,
    technicalRetries: 0,
  });
  expect(check()).toBeNull();
  expect(check(join(tmpdir(), 'missing-patrick-program'))).toMatch(/程序不存在/);
});

test('the same event id is one authoritative row, and a gap refetches the whole snapshot', async () => {
  const holder = temporaryDatabase();
  try {
    let posts = 0;
    const fake = {
      async postEvent() {
        posts += 1;
        return { event: 4, duplicate: posts > 1, routed: [SOURCE_CHANGE_RULE] };
      },
    };
    const event = workEvent('e-once');
    expect(await publishHubEvent(holder.db, fake, event)).toBe('accepted');
    expect(await publishHubEvent(holder.db, fake, event)).toBe('duplicate');
    expect(countEvents(holder.db, 'e-once')).toBe(1);
    holder.db.close();
    const reopened = openDatabase(holder.path);
    try {
      expect(countEvents(reopened, 'e-once')).toBe(1);
      expect(await publishHubEvent(reopened, fake, event)).toBe('duplicate');
      expect(countEvents(reopened, 'e-once')).toBe(1);
    } finally {
      reopened.close();
    }

    const runs = {
      a: viewRun(10, 'a'),
      b: viewRun(9, 'b'),
      c: viewRun(11, 'c'),
    };
    const script: HubStatePage[] = [
      page(1, true, 10, [runs.a]),
      page(1, false, null, [runs.b]),
      page(2, false, null, []),
      page(2, true, 11, [runs.c, runs.a]),
      page(2, false, null, [runs.b]),
      page(2, false, null, [runs.c, runs.a]),
    ];
    const befores: Array<number | undefined> = [];
    let index = 0;
    const reader = {
      async state(before?: number) {
        befores.push(before);
        const next = script[index];
        index += 1;
        if (!next) throw new Error('unexpected state read');
        return next;
      },
    };
    const gapDb = openDatabase(join(holder.path, '..', 'gap.sqlite'));
    try {
      expect(await rebuildHubView(gapDb, reader)).toEqual({ hub_seq: 2 });
      expect(befores).toEqual([undefined, 10, undefined, undefined, 11, undefined]);
      const view = readHubView(gapDb);
      expect(view.hub_seq).toBe(2);
      expect(view.runs.map((run) => run.events[0]?.subject)).toEqual(['b', 'a', 'c']);
      gapDb.close();
      const restarted = openDatabase(join(holder.path, '..', 'gap.sqlite'));
      try {
        expect(readHubView(restarted).runs.map((run) => run.id)).toEqual([9, 10, 11]);
        expect(readHubView(restarted).hub_seq).toBe(2);
      } finally {
        restarted.close();
      }
    } finally {
      if (gapDb.open) gapDb.close();
    }

    const rollbackDir = mkdtempSync(join(tmpdir(), 'patrick-t04-rollback-'));
    const rollback = openDatabase(join(rollbackDir, 'patrick.sqlite'));
    try {
      rollback.exec(`CREATE TRIGGER abort_hub_snapshot BEFORE INSERT ON hub_snapshots BEGIN SELECT RAISE(ABORT, 'boom'); END`);
      expect(() => storeHubView(rollback, { hub_seq: 3, runs: [], cards: [] }, '2026-11-16T00:00:00.000Z')).toThrow(/boom/);
      const snapshots = rollback.prepare('SELECT COUNT(*) AS n FROM hub_snapshots').get() as { n: number };
      const cursors = rollback.prepare(`SELECT COUNT(*) AS n FROM projection_cursors WHERE name = 'hub_observer'`).get() as { n: number };
      expect(snapshots.n).toBe(0);
      expect(cursors.n).toBe(0);
    } finally {
      rollback.close();
      rmSync(rollbackDir, { recursive: true, force: true });
    }
  } finally {
    if (holder.db.open) holder.db.close();
    rmSync(join(holder.path, '..'), { recursive: true, force: true });
  }
});

test('manifest appends the hub migration without changing the earlier files', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { file: string; sha256: string }[];
  expect(manifest.map((entry) => entry.file)).toEqual(['0002_core.sql', '0003_auth_control.sql', '0004_hub_work.sql', '0005_sources.sql', '0006_vault_evidence.sql', '0007_standards.sql', '0008_admission_budget.sql', '0010_answers_channels.sql']);
  expect(manifest[0]?.sha256).toBe('6e82bac75d455f28dc498874b61d0d778e1552b4bc5a8d1b5d7f5dfddfc06233');
  expect(manifest[1]?.sha256).toBe('3767d19a3f6c65f5ddae4f5f7d65a057082bfc978fec2d7e7a7a347f4cf2487f');
  expect(manifest[2]?.sha256).toBe('bcd83075a607244bf5e5ee89efc621d0dd7670e42ace2b5884874ee8047dbcbe');
  const holder = temporaryDatabase();
  try {
    const applied = holder.db.prepare('SELECT file, sha256 FROM schema_migrations ORDER BY position').all();
    expect(applied).toEqual(manifest);
  } finally {
    holder.close();
  }
});

test('the pinned hub keeps one event, pages the snapshot, and the admission probes match the read-back', async () => {
  const matrix = admission();
  let hub: PinnedHub | undefined;
  try {
    hub = await startPinnedHub();
  } catch (error) {
    const failure = error instanceof PinnedHubError ? error : new PinnedHubError('start pinned hub', String(error));
    expect(matrix.autoloop_custom_text.status).toBe('blocked');
    expect(matrix.autoloop_native_answer_resume.status).toBe('blocked');
    expect(matrix.autoloop_custom_text.expectedChosen).toBeNull();
    expect(matrix.autoloop_custom_text.evidenceSha256).toBe(sha256(matrix.autoloop_custom_text.observation));
    expect(matrix.autoloop_custom_text.observation).toContain(failure.command);
    expect(matrix.autoloop_custom_text.observation).toContain(failure.message);
    expect(matrix.autoloop_native_answer_resume.observation).toContain(failure.command);
    expect(matrix.autoloop_native_answer_resume.observation).toContain(failure.message);
    return;
  }
  try {
    const health = await hub.client.health();
    expect(health.commit).toBe(PINNED_HUB_COMMIT);
    await expectDuplicatePagingAndRestart(hub);
    await expectCustomText(matrix.autoloop_custom_text);
    await expectNativeAndDoneAsk(matrix.autoloop_native_answer_resume);
  } finally {
    await hub.stop();
  }
}, 120_000);

async function expectDuplicatePagingAndRestart(hub: PinnedHub): Promise<void> {
  const holder = temporaryDatabase();
  try {
    const routed: string[][] = [];
    const publisher = {
      async postEvent(body: Parameters<PinnedHub['client']['postEvent']>[0]) {
        const ack = await hub.client.postEvent(body);
        routed.push(ack.routed);
        return ack;
      },
    };
    const event = workEvent('work-dup');
    expect(await publishHubEvent(holder.db, publisher, event)).toBe('accepted');
    expect(routed[0]).toContain(SOURCE_CHANGE_RULE);
    expect(await publishHubEvent(holder.db, publisher, event)).toBe('duplicate');
    expect(countEvents(holder.db, 'work-dup')).toBe(1);
    holder.db.close();
    const reopened = openDatabase(holder.path);
    try {
      expect(countEvents(reopened, 'work-dup')).toBe(1);
      await hub.stop();
      const restartedHub = await startPinnedHub(hub.home);
      hub.stop = restartedHub.stop;
      hub.client = restartedHub.client;
      expect(await publishHubEvent(reopened, publisher, event)).toBe('duplicate');
      expect(countEvents(reopened, 'work-dup')).toBe(1);

      const consultation = { ...workEvent('consult-1', 'consultation.requested'), request_id: 'request-1' };
      expect(await publishHubEvent(reopened, publisher, consultation)).toBe('accepted');
      expect(routed.at(-1)).toContain(CONSULTATION_RULE);
      const line = (await hub.client.state()).lines.find((item) => item.name === CONSULTATION_RULE);
      expect(line?.group).toBe(CONSULTATION_GROUP);
      for (let index = 1; index <= 60; index += 1) {
        expect(await publishHubEvent(reopened, publisher, workEvent(`evt-${index}`))).toBe('accepted');
      }
      const befores: Array<number | undefined> = [];
      const view = await rebuildHubView(reopened, {
        state(before) {
          befores.push(before);
          return hub.client.state(before);
        },
      });
      expect(befores.some((before) => before !== undefined)).toBe(true);
      const stored = readHubView(reopened);
      expect(stored.hub_seq).toBe(view.hub_seq);
      const subjects = stored.runs.flatMap((run) => run.events.map((item) => item.subject));
      expect(subjects).toContain('work-dup');
      expect(subjects).toContain('request-1');
      expect(subjects).toContain('evt-60');
      const seq = stored.hub_seq;
      reopened.close();
      const afterRestart = openDatabase(holder.path);
      try {
        const again = readHubView(afterRestart);
        expect(again.hub_seq).toBe(seq);
        expect(again.runs.map((run) => run.id)).toEqual(stored.runs.map((run) => run.id));
        expect(countEvents(afterRestart, 'work-dup')).toBe(1);
      } finally {
        afterRestart.close();
      }
    } finally {
      if (reopened.open) reopened.close();
    }
  } finally {
    rmSync(join(holder.path, '..'), { recursive: true, force: true });
  }
}

async function expectCustomText(row: AdmissionRow): Promise<void> {
  const fresh = await startPinnedHub();
  try {
    const payload = encodeHubAnswer({ kind: 'custom', raw_text: RAW });
    expect(payload).toEqual({ text: RAW });
    expect(Object.keys(payload)).toEqual(['text']);
    await fresh.client.postEvent(toHubEventBody(workEvent('custom-1')));
    const opened = await fresh.client.claim(`custom-open-${randomUUID()}`);
    if (!opened) throw new Error('custom setup produced no job');
    await fresh.client.result(opened.run, opened.token, {
      outcome: 'done',
      summary: '需要自定义答复',
      ask: [{ title: '怎么补', text: '请写一句', options: ['补证', '比较'], key: 'custom-text', about: '保留原文' }],
    });
    const card = (await fresh.client.state()).cards.find((item) => item.title === '怎么补');
    if (!card) throw new Error('custom card was not open');
    await fresh.client.answer(card.id, payload);
    const follow = await fresh.client.claim(`custom-read-${randomUUID()}`);
    if (!follow) throw new Error('custom answer produced no follow-up job');
    const answer = follow.context.answers[0];
    if (!answer) throw new Error('custom follow-up had no answer');
    expect(answer.card).toBe(card.id);
    expect(answer.choice).toBeNull();
    expect(answer.chosen).toBe(row.expectedChosen);
    expect(answer.text).toBe(row.expectedChosen);
    const holder = temporaryDatabase();
    try {
      saveRawCustom(holder.db, 'custom-1', RAW);
      expect(readRawCustom(holder.db, 'custom-1')).toBe(row.rawCustomInput);
    } finally {
      holder.close();
    }
    const context = join(fresh.home, 'custom-context.json');
    writeFileSync(context, JSON.stringify(follow.context));
    const plugin = runCommandPlugin(fresh, 'idle', context);
    expect(plugin.exitCode).toBe(0);
    expect(plugin.check).toBeNull();
    expect(plugin.reading.text).toContain('idle');
    const observation = customObservation(answer);
    expect(row.status).toBe('verified');
    expect(row.rawCustomInput).toBe(RAW);
    expect(row.command).toBe('POST /v1/cards/:id/answer {"text":"  先补证，再比较。  "}');
    expect(row.observation).toBe(observation);
    expect(row.evidenceSha256).toBe(sha256(observation));
    await fresh.client.result(follow.run, follow.token, { outcome: 'done', summary: 'read custom answer' });
  } finally {
    await fresh.stop();
  }
}

async function expectNativeAndDoneAsk(row: AdmissionRow): Promise<void> {
  const fresh = await startPinnedHub();
  try {
    await fresh.client.postEvent(toHubEventBody(workEvent('done-ask')));
    const asked = await fresh.client.claim(`done-ask-${randomUUID()}`);
    if (!asked) throw new Error('done+ask produced no job');
    const receipt = {
      outcome: 'done' as const,
      summary: '先问再停',
      ask: [{ title: '还没答', text: '保持待答', options: ['继续', '停下'], key: 'stay-open' }],
    };
    expect(doneAskRemainsUnanswered(receipt)).toBe(true);
    await fresh.client.result(asked.run, asked.token, receipt);
    const pending = (await fresh.client.state()).cards.find((item) => item.title === '还没答');
    expect(pending).toMatchObject({ state: 'open', choice: null, answer: null });

    await fresh.client.postEvent(toHubEventBody(workEvent('native-1')));
    const opened = await fresh.client.claim(`native-open-${randomUUID()}`);
    if (!opened) throw new Error('native setup produced no job');
    await fresh.client.result(opened.run, opened.token, {
      outcome: 'done',
      summary: '等原生答复',
      ask: [{ title: '先到的答复', text: '阶段还不能领', options: ['采纳', '再看'], key: 'native' }],
    });
    const card = (await fresh.client.state()).cards.find((item) => item.title === '先到的答复');
    if (!card) throw new Error('native card was not open');
    await fresh.client.answer(card.id, { choice: 0 });
    const port = createClaimFixture();
    const key: ResumeKey = {
      work_id: 'native-1',
      generation: 1,
      question_id: 'q-native',
      answer_event_id: `card-${card.id}`,
      phase: 'answer',
    };
    const settled = await settleNativeAnswer(port, key, 'attempt-early');
    expect(settled).toMatchObject({ controller: 'policy_wait', modelCalls: 0, technicalRetries: 0, noop: true });
    const early = await fresh.client.claim(`native-early-${randomUUID()}`);
    if (!early) throw new Error('native answer produced no follow-up job');
    const context = join(fresh.home, 'native-context.json');
    writeFileSync(context, JSON.stringify(early.context));
    const waiting = runCommandPlugin(fresh, 'native-waiting', context);
    expect(waiting.exitCode).toBe(0);
    expect(waiting.stdout).toBe('no-op\n');
    expect(waiting.stderr ?? '').not.toContain('model-called');
    expect(waiting.reading.text).toBe('no-op\n');
    const posted = await fresh.client.result(early.run, early.token, settled.hubResult);
    expect(posted.rejected).toEqual([]);
    const earlyRun = (await fresh.client.state()).runs.find((run) => run.id === early.run);
    expect(earlyRun).toMatchObject({ state: 'done', attempts: 0, summary: 'no-op', error: '' });
    const parent = workEvent('native-1');
    const resume = deriveResumeEvent(parent, 'wake-1', 'answer.verified', 'answer');
    expect(resume).toMatchObject({
      root: parent.root,
      cause: parent.event_id,
      generation: parent.generation,
      hops: parent.hops,
      kind: 'answer.verified',
      stage_key: 'answer',
    });
    const wire = toHubEventBody(resume);
    expect(wire.type).toBe('answer.verified');
    expect(wire.subject).toBe('answer');
    const holder = temporaryDatabase();
    const acks: HubEventAck[] = [];
    try {
      const publisher = {
        async postEvent(body: Parameters<PinnedHub['client']['postEvent']>[0]) {
          const ack = await fresh.client.postEvent(body);
          acks.push(ack);
          return ack;
        },
      };
      expect(await publishHubEvent(holder.db, publisher, resume)).toBe('accepted');
      expect(acks.at(-1)?.routed).toEqual([RESUME_RULE]);
      const stored = holder.db.prepare(
        'SELECT root, cause, generation, hops, kind, stage_key FROM hub_events WHERE event_id = ?',
      ).get('wake-1');
      expect(stored).toEqual({
        root: 'native-1',
        cause: 'native-1',
        generation: 1,
        hops: 0,
        kind: 'answer.verified',
        stage_key: 'answer',
      });
    } finally {
      holder.close();
    }
    const later = await fresh.client.claim(`native-later-${randomUUID()}`);
    if (!later) throw new Error('resume event produced no job');
    expect(later.rule.name).toBe(RESUME_RULE);
    expect(later.rule.name).not.toBe(SOURCE_CHANGE_RULE);
    const wakeEvent = later.context.events.find((event) => event.type === 'answer.verified');
    expect(wakeEvent?.subject).toBe('answer');
    const detail = JSON.parse(wakeEvent?.detail ?? 'null') as {
      root: string;
      cause: string;
      generation: number;
      hops: number;
      stage_key: string;
    };
    expect(detail).toMatchObject({
      root: parent.root,
      cause: parent.event_id,
      generation: parent.generation,
      hops: parent.hops,
      stage_key: wakeEvent?.subject,
    });
    expect(later.context.events.some((event) => event.type === 'source.changed')).toBe(false);
    port.setClaimable(key, true);
    const continuation = await port.claimContinuation(key, 'attempt-later');
    expect(continuation.status).toBe('claimed');
    const evidence = deriveResumeEvent(parent, 'evidence-1', 'evidence.ready', 'evidence_ready');
    const evidenceAck = await fresh.client.postEvent(toHubEventBody(evidence));
    expect(evidenceAck.routed).toEqual([RESUME_RULE]);
    const evidenceRun = (await fresh.client.state()).runs.find((run) => (
      run.state === 'queued'
      && run.rule === RESUME_RULE
      && run.events.some((event) => event.type === 'evidence.ready' && event.subject === 'evidence_ready')
    ));
    expect(evidenceRun).toBeTruthy();
    const observation = nativeObservation({
      state: earlyRun?.state ?? '',
      attempts: earlyRun?.attempts ?? -1,
      summary: earlyRun?.summary ?? '',
      readText: waiting.reading.text ?? '',
      resumeRule: later.rule.name,
      resumeType: wakeEvent?.type ?? '',
      root: detail.root,
      stageKey: detail.stage_key,
      claimStatus: continuation.status,
    });
    expect(row.status).toBe('verified');
    expect(row.command).toBe(NATIVE_COMMAND);
    expect(row.observation).toBe(observation);
    expect(row.evidenceSha256).toBe(sha256(observation));
  } finally {
    await fresh.stop();
  }
}

function page(seq: number, hasMore: boolean, nextBefore: number | null, runs: HubRunView[]): HubStatePage {
  return { seq, hasMore, nextBefore, runs, cards: [], lines: [] };
}

function viewRun(id: number, subject: string): HubRunView {
  return {
    id,
    rule: SOURCE_CHANGE_RULE,
    state: 'queued',
    attempts: 0,
    summary: '',
    error: '',
    events: [{ source: 'patrick', type: 'source.changed', subject, summary: subject }],
  };
}
