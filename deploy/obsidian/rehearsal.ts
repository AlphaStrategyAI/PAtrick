import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { setTimeout as delay } from 'node:timers/promises';
import { createStandardsApi } from '../../packages/domain/src/standards.js';
import { createVaultApi } from '../../packages/integrations/vault/drafts.js';
import { inspectVault, requireVault, type VaultRecord } from '../../packages/integrations/vault/connection.js';
import { PROJECTION_BATCH_FILES } from '../../packages/integrations/vault/projector.js';
import { createBlobStore } from '../../packages/storage/src/blob-store.js';
import { openDatabase, type SqliteDatabase } from '../../packages/storage/src/database.js';
import { createVaultKitInstaller } from './install.mjs';
import type { EditorObservation, ProcessIdentity } from './rehearsal-observation.js';
import {
  auditManuscripts, auditTree, canonical, exists, hash, ownedDirectory, ownedFile, readOwned, readRecord, verifyAncestors,
  writeExclusive, writeRecord,
} from './rehearsal-files.js';

const area = 'PAtrick-T27-Rehearsals';
const processInstance = randomUUID();
const phases = ['editor-open', 'editor-closed', 'after-restart'] as const;
const sampleNote = '知识笔记/演练笔记 #1.md';
const sampleDraft = '标准修订/native-rehearsal.md';
const sampleKey = 'native-rehearsal';
const notes = [sampleNote, sampleDraft] as const;
type Phase = typeof phases[number];
type ClosedPhase = Exclude<Phase, 'editor-open'>;
type Runtime = {
  username: string;
  uid: number;
  realUid: number;
  home: string;
  observeEditor: () => Promise<EditorObservation | null>;
  observeProcess: (pid: number) => Promise<ProcessIdentity | null>;
  observeBoot: () => Promise<string | null>;
};

type Session = {
  sessionId: string;
  sessionPath: string;
  vaultPath: string;
  databasePath: string;
  blobPath: string;
  stagingPath: string;
};
type Registration = { uid: number; standardId: string; editId: string; vault: VaultRecord; ledgerIdentity: string };
type Worker = { id: string; processInstance: string; pid: number; identity: ProcessIdentity; sessionId: string; phase: Phase;
  startedAt: string; bootId: string | null; expiresAt: number; noteBeforeSha256: string; editorAtStart: EditorObservation };
type StoppedSample = { sessionId: string; phase: ClosedPhase; path: string; workerId: string; workerProcessInstance: string;
  worker: ProcessIdentity; writer: ProcessIdentity; bootId: string | null; startedAt: string; savedAt: string;
  beforeSha256: string; afterSha256: string; editorBefore: EditorObservation; editorAfter: EditorObservation };
type Source = { documentId: string; relativePath: string; observedSeq: number; revisionId: string; sha256: string };
type Evidence = {
  phase: Phase;
  worker: Worker;
  manualGuiSave: 'operator_confirmation_required' | 'not_applicable';
  editorObservation: { start: 'running' | 'stopped'; atCapture: 'running' | 'stopped';
    startProcess: EditorObservation; capturedProcess: EditorObservation };
  stoppedSample: StoppedSample | null;
  source: Source[];
  candidate: { id: string; documentId: string; sourceRevision: number; sha256: string; activeVersion: null };
  publication: { intentId: string; revision: number; indexSha256: string; manifestSha256: string; path: string };
  freshWorkerProcess: boolean | null;
  bootComparedToPrior: 'changed' | 'unchanged' | 'unknown' | 'not_applicable';
};
const sessionPattern = /^t27-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const sampleRules = [{ when: ['synthetic'], unless: [], choice: 'fixture-choice' }];

function marker(id: string, phase: Phase, path: string) {
  return `T27-${phase}-${path === sampleNote ? 'KNOWLEDGE' : 'STANDARD'}-${id}`;
}
function phasesFor(path: string) { return path === sampleNote ? phases : phases.slice(0, 1); }
function baseText(path: string, registration: Registration) {
  return path === sampleNote
    ? '---\nkind: knowledge\nknowledge_id: t27-synthetic-note\n---\n\n# T27 合成演练笔记'
    : ['---', `patrick_id: ${registration.standardId}`, 'kind: standard',
      `standard_id: ${registration.standardId}`, 'base_version:', '---', '', '# T27 合成演练标准', '',
      '```json', JSON.stringify({ rules: sampleRules }), '```'].join('\n');
}
const registeredVaultId = (session: Session) => `vault-${session.sessionId}`;
const evidencePath = (session: Session, phase: Phase) => join(session.sessionPath, `evidence-${phase}.json`);
const readyPath = (session: Session, phase: Phase) => join(session.sessionPath, `watch-${phase}.json`);
const stoppedPath = (session: Session, phase: Phase) => join(session.sessionPath, `stopped-${phase}.json`);
const viewKind = 't27-rehearsal';

export function createRehearsal(runtime: Runtime, input: { testUser: string; testUid: number; serviceUid: number }) {
  if (!Number.isSafeInteger(runtime.uid) || runtime.uid <= 0 || input.testUid <= 0) throw new Error('REHEARSAL_NON_ROOT_REQUIRED');
  const uid = runtime.uid;
  if (runtime.realUid !== uid || input.testUid !== uid || input.testUser !== runtime.username) throw new Error('REHEARSAL_LOGIN_MISMATCH');
  if (input.serviceUid !== uid) throw new Error('REHEARSAL_SEPARATE_SERVICE_UID_UNSUPPORTED');

  async function paths(sessionId: string, initializing = false): Promise<Session> {
    if (!sessionPattern.test(sessionId)) throw new Error('REHEARSAL_SESSION_INVALID');
    const home = await realpath(runtime.home);
    if (home.normalize('NFC') !== runtime.home.normalize('NFC')) throw new Error('REHEARSAL_UNSAFE_PATH');
    await ownedDirectory(home, uid);
    for (let path = home; ; path = dirname(path)) {
      if (await exists(join(path, '.obsidian'))) throw new Error('REHEARSAL_EXISTING_VAULT');
      if (dirname(path) === path) break;
    }
    const parent = join(home, area);
    if (initializing && !await exists(parent)) await mkdir(parent, { mode: 0o700 });
    await ownedDirectory(parent, uid);
    if (await exists(join(parent, '.obsidian'))) throw new Error('REHEARSAL_UNSAFE_PATH');
    const sessionPath = join(parent, sessionId);
    return { sessionId, sessionPath, vaultPath: join(sessionPath, `PAtrick T27 ${sessionId.slice(-12)}`),
      databasePath: join(sessionPath, 'rehearsal.sqlite'), blobPath: join(sessionPath, 'blobs'),
      stagingPath: join(sessionPath, 'install-staging') };
  }
  function ports(session: Session, db: SqliteDatabase) {
    const actor = syntheticActor(session);
    const principal = { account_id: actor, caller_id: actor, auth_epoch: 1,
      authenticated_at: new Date().toISOString(), domains: ['personal'], operations: ['owner', 'edits.write', 'standards.write'] };
    const blobs = createBlobStore(session.blobPath);
    const vault = createVaultApi(db, { blobs, captureHost: actor });
    return { principal, blobs, vault, actor, vaultId: registeredVaultId(session) };
  }
  async function load(sessionId: string) {
    const session = await paths(sessionId);
    await ownedDirectory(session.sessionPath, uid);
    const registration = await readRecord<Registration>(join(session.sessionPath, 'session.json'), uid);
    const root = await ownedDirectory(session.vaultPath, uid);
    if (registration.uid !== uid || registration.vault?.root_identity !== `${root.dev}:${root.ino}`) {
      throw new Error('REHEARSAL_UNSAFE_PATH');
    }
    for (const path of [session.blobPath, session.stagingPath]) await ownedDirectory(path, uid);
    await verifyAncestors(session.databasePath, uid);
    const ledger = await exists(session.databasePath);
    if (!ledger) throw new Error('REHEARSAL_LEDGER_MISSING');
    if (registration.ledgerIdentity !== `${ledger.dev}:${ledger.ino}`) throw new Error('REHEARSAL_LEDGER_IDENTITY_MISMATCH');
    for (const suffix of ['-wal', '-shm', '-journal']) await verifyAncestors(session.databasePath + suffix, uid);
    if (await exists(join(session.sessionPath, 'isolation'))) await ownedDirectory(join(session.sessionPath, 'isolation'), uid);
    const check = new Database(session.databasePath, { readonly: true, fileMustExist: true });
    try { verifyLedger(check, session, registration); } finally { check.close(); }
    return { session, registration };
  }
  async function revalidate(session: Session, registration: Registration) {
    const current = await load(session.sessionId);
    if (current.registration.ledgerIdentity !== registration.ledgerIdentity ||
        current.registration.standardId !== registration.standardId || current.registration.editId !== registration.editId ||
        (Object.keys(registration.vault) as (keyof VaultRecord)[]).some((key) => current.registration.vault[key] !== registration.vault[key])) {
      throw new Error('REHEARSAL_LEDGER_IDENTITY_MISMATCH');
    }
  }
  async function samples(session: Session, registration: Registration) {
    await auditManuscripts(session.vaultPath, notes, uid);
    return Promise.all(notes.map(async (path) => {
      const bytes = await readOwned(join(session.vaultPath, path), uid);
      const text = canonical(bytes.toString('utf8'));
      const allowed = phasesFor(path);
      let expected = baseText(path, registration);
      for (let count = 0; count <= allowed.length; count += 1) {
        if (text === expected) return { path, bytes, count };
        if (count < allowed.length) expected += '\n\n' + marker(session.sessionId, allowed[count], path);
      }
      throw new Error('REHEARSAL_UNEXPECTED_VAULT_CONTENT');
    }));
  }
  async function editor(expected: boolean): Promise<EditorObservation> {
    const observed = await runtime.observeEditor();
    if (observed?.running !== expected) throw new Error('REHEARSAL_EDITOR_NOT_OBSERVED');
    return observed;
  }

  async function processIdentity(pid: number): Promise<ProcessIdentity> {
    const observed = await runtime.observeProcess(pid);
    if (!observed || observed.pid !== pid || observed.uid !== uid || !observed.startedKey) throw new Error('REHEARSAL_WORKER_NOT_WAITING');
    return { pid, uid, startedKey: observed.startedKey };
  }
  async function activeWorker(worker: Worker, session: Session, phase: Phase) {
    if (worker.sessionId !== session.sessionId || worker.phase !== phase || !Number.isSafeInteger(worker.pid) || worker.pid <= 0 ||
        !Number.isFinite(Date.parse(worker.startedAt)) || Date.now() < Date.parse(worker.startedAt) ||
        Date.now() > worker.expiresAt || !sameProcess(worker.identity, await processIdentity(worker.pid)) ||
        worker.bootId !== await runtime.observeBoot()) throw new Error('REHEARSAL_WORKER_NOT_WAITING');
  }

  return {
    async init() {
      const session = await paths('t27-' + randomUUID(), true);
      await mkdir(session.sessionPath, { mode: 0o700 });
      for (const child of [session.vaultPath, session.blobPath, session.stagingPath]) await mkdir(child, { mode: 0o700 });
      await writeExclusive(session.databasePath, '');
      const ledger = (await exists(session.databasePath))!;
      const db = openDatabase(session.databasePath);
      try {
        const { principal, vault, actor, vaultId } = ports(session, db);
        await vault.connectVault({ accountId: actor, deviceId: actor, vaultId, root: session.vaultPath, domain: 'personal' });
        await vault.confirmVault(actor, vaultId);
        const kit = await createVaultKitInstaller({ deviceId: actor, captureHost: actor, serviceUid: uid, editorUid: uid,
          stageParent: session.stagingPath, loadVault: (id) => requireVault(db, id), inspectVault: (device, id) => inspectVault(db, device, id) })
          .installVaultKit(vaultId);
        const draft = await vault.createEdit(principal, { operation: 'create_standard', draft_key: sampleKey, expected_active_version: null });
        const row = db.prepare('SELECT target_id, relative_path FROM edit_intents WHERE edit_id = ?').get(draft.edit_id) as {
          target_id: string; relative_path: string;
        };
        if (row.relative_path !== sampleDraft || !row.target_id) throw new Error('REHEARSAL_DRAFT_MISMATCH');
        const registration = { uid, standardId: row.target_id, editId: draft.edit_id, vault: requireVault(db, vaultId),
          ledgerIdentity: `${ledger.dev}:${ledger.ino}` };
        verifyLedger(db, session, registration);
        await writeExclusive(join(session.vaultPath, sampleNote), baseText(sampleNote, registration) + '\n');
        const standard = await ownedFile(join(session.vaultPath, sampleDraft), uid, constants.O_WRONLY);
        try {
          await standard.truncate(0);
          await standard.writeFile(baseText(sampleDraft, registration) + '\n');
          await standard.sync();
        } finally { await standard.close(); }
        await vault.readVault(vaultId);
        await writeRecord(join(session.sessionPath, 'session.json'), registration);
        await writeRecord(join(session.sessionPath, 'kit.json'), kit);
        return { ...session, guiEdits: notes.map((relativePath) => ({ relativePath, marker: marker(session.sessionId, 'editor-open', relativePath) })) };
      } finally { db.close(); }
    },

    async watch(sessionId: string, phase: Phase, options: { timeoutMs: number; onReady?: (worker: Worker) => unknown }) {
      const step = phases.indexOf(phase);
      if (step < 0) throw new Error('REHEARSAL_PHASE_INVALID');
      if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 600_000) {
        throw new Error('REHEARSAL_TIMEOUT_INVALID');
      }
      const { session, registration } = await load(sessionId);
      const receiptPath = evidencePath(session, phase);
      if (await exists(receiptPath)) throw new Error('REHEARSAL_PHASE_ALREADY_RECORDED');
      const priorPath = step > 0 ? evidencePath(session, phases[step - 1]) : null;
      if (priorPath && !await exists(priorPath)) throw new Error('REHEARSAL_PREVIOUS_PHASE_REQUIRED');
      const prior = priorPath ? await readRecord<Evidence>(priorPath, uid) : null;
      const start = await editor(step === 0);
      const started = await samples(session, registration);
      const changed = step === 0 ? notes : [sampleNote];
      for (const item of started) {
        if (item.count !== (item.path === sampleNote ? step : step > 0 ? 1 : 0)) {
          throw new Error('REHEARSAL_SAMPLE_PRECEDES_WORKER');
        }
      }
      const identity = await processIdentity(process.pid);
      const worker = { id: randomUUID(), processInstance, pid: process.pid, identity, sessionId, phase,
        startedAt: new Date().toISOString(), bootId: await runtime.observeBoot(), expiresAt: Date.now() + options.timeoutMs,
        noteBeforeSha256: hash(started[0].bytes), editorAtStart: start };
      const ready = readyPath(session, phase);
      await writeRecord(ready, worker);
      try {
        await options.onReady?.(worker);
        const stoppedProof = stoppedPath(session, phase);
        let sampled = await samples(session, registration);
        while (true) {
          const saved = sampled.every(({ path, count }) => count === (path === sampleNote ? step + 1 : 1));
          if (Date.now() >= worker.expiresAt) {
            throw new Error(saved && step > 0 ? 'REHEARSAL_STOPPED_SAMPLE_PROOF_REQUIRED' : 'REHEARSAL_WAIT_TIMEOUT');
          }
          if (saved && (step === 0 || await exists(stoppedProof))) break;
          await delay(Math.min(350, worker.expiresAt - Date.now()));
          sampled = await samples(session, registration);
        }
        const atCapture = await editor(step === 0);
        if (!sameEditor(start, atCapture)) throw new Error('REHEARSAL_EDITOR_IDENTITY_CHANGED');
        const stoppedSample = step > 0 ? await readRecord<StoppedSample>(stoppedProof, uid) : null;
        if (stoppedSample) {
          await activeWorker(worker, session, phase);
          const began = Date.parse(stoppedSample.startedAt);
          const ended = Date.parse(stoppedSample.savedAt);
          if (stoppedSample.sessionId !== sessionId || stoppedSample.phase !== phase || stoppedSample.path !== sampleNote ||
              stoppedSample.workerId !== worker.id || stoppedSample.workerProcessInstance !== worker.processInstance ||
              !sameProcess(stoppedSample.worker, worker.identity) || stoppedSample.bootId !== worker.bootId ||
              stoppedSample.writer?.uid !== uid || !Number.isSafeInteger(stoppedSample.writer.pid) || !stoppedSample.writer.startedKey ||
              !(began >= Date.parse(worker.startedAt) && ended >= began && ended <= Date.now() && ended <= worker.expiresAt) ||
              stoppedSample.beforeSha256 !== worker.noteBeforeSha256 || stoppedSample.afterSha256 !== hash(sampled[0].bytes) ||
              !sameEditor(stoppedSample.editorBefore, start) || !sameEditor(stoppedSample.editorAfter, atCapture)) {
            throw new Error('REHEARSAL_STOPPED_SAMPLE_PROOF_MISMATCH');
          }
        }
        for (const tree of [session.blobPath, join(session.vaultPath, '系统视图'),
          join(session.vaultPath, '.patrick-staging'), join(session.sessionPath, 'isolation')]) await auditTree(tree, uid);
        await revalidate(session, registration);
        const db = openDatabase(session.databasePath);
        try {
          verifyLedger(db, session, registration);
          const { principal, blobs, vault, vaultId } = ports(session, db);
          const scanned = await vault.readVault(vaultId);
          if (scanned.state !== 'ready' || scanned.collected !== changed.length) throw new Error('REHEARSAL_SOURCE_NOT_COLLECTED');
          const source = await Promise.all(sampled.filter(({ path }) => changed.some((name) => name === path))
            .map(async ({ path, bytes }) => {
              const row = archivedSource(db, vaultId, path);
              if (row.sha256 !== hash(bytes) || hash(await blobs.readBlob(row.sha256)) !== row.sha256) {
                throw new Error('REHEARSAL_SOURCE_HASH_MISMATCH');
              }
              return row;
            }));
          const standards = createStandardsApi(db, principal, { domain: 'personal' });
          const standard = archivedSource(db, vaultId, sampleDraft);
          const opened = prior ? null : await standards.openCandidate({
            vault_id: vaultId, standard_id: registration.standardId, draft_key: sampleKey,
            document_id: standard.documentId, source_revision: standard.observedSeq, content_hash: standard.sha256,
            editId: registration.editId,
          });
          const candidate = prior?.candidate ?? { id: opened!.id, documentId: standard.documentId, sourceRevision: standard.observedSeq,
            sha256: standard.sha256, activeVersion: null };
          if (!db.prepare("SELECT 1 FROM standard_candidates WHERE candidate_id = ? AND status = 'open' AND source_revision = ? AND content_hash = ?")
            .get(candidate.id, candidate.sourceRevision, candidate.sha256) ||
            await standards.activeStandardVersion(registration.standardId) !== null) throw new Error('REHEARSAL_INVALID_CANDIDATE');
          const publication = await publishEvidence(session, vault, db, vaultId, step + 1, source, candidate);
          const bootComparedToPrior = !prior ? 'not_applicable' : !prior.worker.bootId || !worker.bootId ? 'unknown'
            : prior.worker.bootId === worker.bootId ? 'unchanged' : 'changed';
          const result: Evidence = { phase, worker, manualGuiSave: step === 0 ? 'operator_confirmation_required' : 'not_applicable',
            editorObservation: { start: start.running ? 'running' : 'stopped', atCapture: atCapture.running ? 'running' : 'stopped',
              startProcess: start, capturedProcess: atCapture },
            stoppedSample, source, candidate, publication,
            freshWorkerProcess: prior ? prior.worker.processInstance !== worker.processInstance : null,
            bootComparedToPrior };
          await writeRecord(receiptPath, result);
          return result;
        } finally { db.close(); }
      } finally { await rm(ready, { force: true }); }
    },

    async saveClosedSample(sessionId: string, phase: ClosedPhase) {
      if (phase !== 'editor-closed' && phase !== 'after-restart') throw new Error('REHEARSAL_PHASE_INVALID');
      const { session, registration } = await load(sessionId);
      const ready = readyPath(session, phase);
      if (!await exists(ready)) throw new Error('REHEARSAL_WORKER_NOT_WAITING');
      const worker = await readRecord<Worker>(ready, uid);
      await activeWorker(worker, session, phase);
      const record = stoppedPath(session, phase);
      if (await exists(record)) throw new Error('REHEARSAL_STOPPED_SAMPLE_ALREADY_SAVED');
      const editorBefore = await editor(false);
      if (!sameEditor(editorBefore, worker.editorAtStart)) throw new Error('REHEARSAL_EDITOR_IDENTITY_CHANGED');
      const writer = await processIdentity(process.pid);
      const [note] = await samples(session, registration);
      if (note.count !== phases.indexOf(phase) || hash(note.bytes) !== worker.noteBeforeSha256) {
        throw new Error('REHEARSAL_SAMPLE_PRECEDES_WORKER');
      }
      await revalidate(session, registration);
      const filePath = join(session.vaultPath, sampleNote);
      const startedAt = new Date().toISOString();
      const file = await ownedFile(filePath, uid, constants.O_RDWR | constants.O_APPEND);
      let afterSha256;
      try {
        if (!(await file.readFile()).equals(note.bytes)) throw new Error('REHEARSAL_SOURCE_CHANGED');
        const suffix = note.bytes.toString('utf8').endsWith('\n') ? '\n' : '\n\n';
        const append = suffix + marker(sessionId, phase, sampleNote) + '\n';
        await file.appendFile(append);
        await file.sync();
        const after = await readOwned(filePath, uid);
        if (!after.equals(Buffer.concat([note.bytes, Buffer.from(append)]))) throw new Error('REHEARSAL_SOURCE_CHANGED');
        afterSha256 = hash(after);
      } finally { await file.close(); }
      const editorAfter = await editor(false);
      await activeWorker(worker, session, phase);
      const stillWaiting = await readRecord<Worker>(ready, uid);
      if (stillWaiting.id !== worker.id || stillWaiting.processInstance !== worker.processInstance ||
          !sameEditor(editorAfter, editorBefore)) throw new Error('REHEARSAL_WORKER_NOT_WAITING');
      const receipt: StoppedSample = { sessionId, phase, path: sampleNote, workerId: worker.id, workerProcessInstance: worker.processInstance,
        worker: worker.identity, writer, bootId: worker.bootId, startedAt, savedAt: new Date().toISOString(),
        beforeSha256: worker.noteBeforeSha256, afterSha256, editorBefore, editorAfter };
      await writeRecord(record, receipt);
      return receipt;
    },

    async status(sessionId: string) {
      const { session } = await load(sessionId);
      const evidence = [];
      for (const phase of phases) {
        const path = evidencePath(session, phase);
        if (await exists(path)) evidence.push(await readRecord<Evidence>(path, uid));
      }
      return { ...session, evidence };
    },
  };
}

function sameProcess(left: ProcessIdentity | null | undefined, right: ProcessIdentity) {
  return left?.pid === right.pid && left.uid === right.uid && left.startedKey === right.startedKey;
}
function sameEditor(left: EditorObservation | null | undefined, right: EditorObservation) {
  return left?.running === right.running && left.bundlePath === right.bundlePath && left.pid === right.pid;
}

function syntheticActor(session: Session) {
  return `synthetic-${session.sessionId}`;
}

function verifyLedger(db: SqliteDatabase, session: Session, registration: Registration) {
  const vaultId = registeredVaultId(session);
  const actor = syntheticActor(session);
  let actual: VaultRecord;
  try {
    actual = requireVault(db, vaultId);
  } catch (error) {
    throw new Error('REHEARSAL_LEDGER_IDENTITY_MISMATCH', { cause: error });
  }
  const count = db.prepare('SELECT COUNT(*) AS count FROM vaults').get() as { count: number };
  if (count.count !== 1 || actual.account_id !== actor || actual.capture_host !== actor || actual.data_domain !== 'personal' ||
      actual.source_id !== `src_${vaultId}` || actual.root_path !== session.vaultPath || actual.physical_root !== session.vaultPath ||
      actual.isolation_root !== join(session.sessionPath, 'isolation') || actual.status !== 'connected' ||
      actual.config_revision !== 1 || actual.connection_epoch !== 1 ||
      (Object.keys(actual) as (keyof VaultRecord)[]).some((key) => actual[key] !== registration.vault[key])) {
    throw new Error('REHEARSAL_LEDGER_IDENTITY_MISMATCH');
  }
}

function archivedSource(db: SqliteDatabase, vaultId: string, relativePath: string): Source {
  const row = db.prepare(`SELECT d.document_id AS documentId, d.relative_path AS relativePath, d.observed_seq AS observedSeq,
    r.revision_id AS revisionId, r.content_hash AS sha256
    FROM vault_documents d JOIN vault_revisions r ON r.vault_id = d.vault_id AND r.document_id = d.document_id
      AND r.observed_seq = d.observed_seq
    WHERE d.vault_id = ? AND d.relative_path = ? AND d.tombstone = 0 AND d.parse_error IS NULL`).get(vaultId, relativePath) as Source | undefined;
  if (!row?.sha256) throw new Error('REHEARSAL_SOURCE_NOT_COLLECTED');
  return row;
}

async function publishEvidence(session: Session, vault: ReturnType<typeof createVaultApi>, db: SqliteDatabase, vaultId: string,
  revision: number, source: Source[], candidate: Evidence['candidate']): Promise<Evidence['publication']> {
  const files = Object.fromEntries(await Promise.all(PROJECTION_BATCH_FILES.map(async (path) => [path, path.endsWith('.md')
    ? (path.startsWith('候选标准/') ? `# 合成候选（未采纳）\n\n${candidate.id}\n`
      : path.startsWith('知识/') ? `# 合成知识收录\n\n${source.map(({ revisionId }) => revisionId).join('\n')}\n` : '# 无生产资料\n')
    : await readFile(new URL('../../assets/vault-kit/系统视图/' + path, import.meta.url), 'utf8')] as const)));
  const result = await vault.project({ vaultId, viewKind, revision, files });
  if (!result.applied || result.pointer !== revision) throw new Error('REHEARSAL_PROJECTION_NOT_APPLIED');
  const batch = db.prepare(`SELECT b.intent_id AS intentId, b.manifest_hash AS manifestSha256 FROM projection_batches b
    JOIN projection_pointers p ON p.data_domain = b.data_domain AND p.view_kind = b.view_kind AND p.intent_id = b.intent_id
      AND p.projection_revision = b.projection_revision
    WHERE b.vault_id = ? AND b.view_kind = ? AND b.projection_revision = ? AND b.applied = 1`).get(vaultId, viewKind, revision) as {
      intentId: string; manifestSha256: string;
    } | undefined;
  const path = `系统视图/批次/${revision}`;
  if (!batch) throw new Error('REHEARSAL_PROJECTION_NOT_APPLIED');
  for (const [name, content] of Object.entries(files)) {
    if (hash(await readFile(join(session.vaultPath, path, name))) !== hash(content)) throw new Error('REHEARSAL_PROJECTION_HASH_MISMATCH');
  }
  const index = await readFile(join(session.vaultPath, '系统视图', '索引.md'));
  if (!index.toString('utf8').includes(`projection_revision: ${revision}\n`)) throw new Error('REHEARSAL_PROJECTION_HASH_MISMATCH');
  return { ...batch, revision, indexSha256: hash(index), path };
}
