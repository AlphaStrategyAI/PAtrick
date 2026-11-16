import { randomUUID } from 'node:crypto';
import { withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { workResumeAllowed, type AdmissionPrincipal } from './delegation.js';

export type WorkControlCommand = {
  work_id: string;
  type: 'pause' | 'resume' | 'stop';
  generation: number;
  expected_revision: number;
};

export type WorkControlState = 'paused' | 'running' | 'processing' | 'stopped' | 'denied';

export type WorkControlReceipt = {
  receipt_id: string;
  work_id: string;
  generation: number;
  type: WorkControlCommand['type'];
  state: WorkControlState;
  revision: number;
};

export type StopReport = {
  process_tree_stopped: boolean;
  effects_reconciled: boolean;
};

export type StopPort = {
  submit(workId: string, generation: number): void;
  read(workId: string, generation: number): StopReport;
};

export type StopFixture = StopPort & {
  report(workId: string, generation: number, update: Partial<StopReport>): void;
};

type WorkControlOptions = {
  now?: () => Date;
  stopPort: StopPort;
};

type WorkRow = {
  account_id: string;
  data_domain: string;
  control_state: string;
  revision: number;
};

export function createStopFixture(): StopFixture {
  const reports = new Map<string, StopReport>();
  function key(workId: string, generation: number): string {
    return `${workId}\0${generation}`;
  }
  return {
    submit(workId, generation) {
      const id = key(workId, generation);
      if (!reports.has(id)) reports.set(id, { process_tree_stopped: false, effects_reconciled: false });
    },
    read(workId, generation) {
      return reports.get(key(workId, generation)) ?? { process_tree_stopped: false, effects_reconciled: false };
    },
    report(workId, generation, update) {
      const id = key(workId, generation);
      const current = reports.get(id) ?? { process_tree_stopped: false, effects_reconciled: false };
      reports.set(id, { ...current, ...update });
    },
  };
}

export function createWorkControlApi(db: SqliteDatabase, principal: AdmissionPrincipal, options: WorkControlOptions) {
  const now = options.now ?? (() => new Date());
  const stopPort = options.stopPort;

  function stamp(): string {
    return now().toISOString();
  }

  return {
    async applyWorkControl(caller: AdmissionPrincipal, command: WorkControlCommand): Promise<WorkControlReceipt> {
      if (caller.account_id !== principal.account_id) throw new Error('FORBIDDEN');
      return withImmediateTransaction(db, () => {
        const work = visibleWork(db, caller, command.work_id, command.generation);
        if (work.revision !== command.expected_revision) throw new Error('CONFLICT');
        if (command.type === 'pause') {
          const revision = advance(db, command, stamp(), { control_state: 'paused' });
          return insertReceipt(db, command, 'paused', revision, stamp());
        }
        if (command.type === 'resume') {
          if (!workResumeAllowed(db, caller, stamp(), command.work_id, command.generation)) {
            return insertReceipt(db, command, 'denied', work.revision, stamp());
          }
          const revision = advance(db, command, stamp(), { control_state: 'running' });
          return insertReceipt(db, command, 'running', revision, stamp());
        }
        stopPort.submit(command.work_id, command.generation);
        const report = stopPort.read(command.work_id, command.generation);
        const done = report.process_tree_stopped && report.effects_reconciled;
        const revision = advance(db, command, stamp(), {
          control_state: done ? 'stopped' : 'processing',
          process_tree_stopped: report.process_tree_stopped ? 1 : 0,
          effects_reconciled: report.effects_reconciled ? 1 : 0,
          attempt_closed: done ? 1 : undefined,
        });
        return insertReceipt(db, command, done ? 'stopped' : 'processing', revision, stamp());
      });
    },

    async syncStop(workId: string, generation: number): Promise<WorkControlReceipt> {
      return withImmediateTransaction(db, () => {
        visibleWork(db, principal, workId, generation);
        const report = stopPort.read(workId, generation);
        const done = report.process_tree_stopped && report.effects_reconciled;
        const state = done ? 'stopped' : 'processing';
        db.prepare(`UPDATE work_generations SET
          control_state = ?, process_tree_stopped = ?, effects_reconciled = ?,
          attempt_closed = CASE WHEN ? = 1 THEN 1 ELSE attempt_closed END, updated_at = ?
          WHERE work_id = ? AND generation = ?`).run(
          state,
          report.process_tree_stopped ? 1 : 0,
          report.effects_reconciled ? 1 : 0,
          done ? 1 : 0,
          stamp(),
          workId,
          generation,
        );
        const receipt = db.prepare(`SELECT receipt_id, command_type, revision FROM work_control_receipts
          WHERE work_id = ? AND generation = ? AND command_type = 'stop'
          ORDER BY created_at DESC LIMIT 1`).get(workId, generation) as {
          receipt_id: string;
          command_type: WorkControlCommand['type'];
          revision: number;
        } | undefined;
        if (!receipt) throw new Error('NOT_FOUND');
        db.prepare('UPDATE work_control_receipts SET state = ? WHERE receipt_id = ?').run(state, receipt.receipt_id);
        return {
          receipt_id: receipt.receipt_id,
          work_id: workId,
          generation,
          type: 'stop',
          state,
          revision: receipt.revision,
        };
      });
    },
  };
}

function visibleWork(db: SqliteDatabase, principal: AdmissionPrincipal, workId: string, generation: number): WorkRow {
  const work = db.prepare('SELECT account_id, data_domain, control_state, revision FROM work_generations WHERE work_id = ? AND generation = ?').get(
    workId,
    generation,
  ) as WorkRow | undefined;
  if (!work || work.account_id !== principal.account_id || !principal.domains.includes(work.data_domain)) throw new Error('NOT_FOUND');
  return work;
}

function advance(
  db: SqliteDatabase,
  command: WorkControlCommand,
  stamped: string,
  patch: {
    control_state: string;
    process_tree_stopped?: number;
    effects_reconciled?: number;
    attempt_closed?: number;
  },
): number {
  const updated = db.prepare(`UPDATE work_generations SET
    control_state = @control_state,
    process_tree_stopped = COALESCE(@process_tree_stopped, process_tree_stopped),
    effects_reconciled = COALESCE(@effects_reconciled, effects_reconciled),
    attempt_closed = COALESCE(@attempt_closed, attempt_closed),
    revision = revision + 1,
    updated_at = @updated_at
    WHERE work_id = @work_id AND generation = @generation AND revision = @revision
    RETURNING revision`).get({
    control_state: patch.control_state,
    process_tree_stopped: patch.process_tree_stopped ?? null,
    effects_reconciled: patch.effects_reconciled ?? null,
    attempt_closed: patch.attempt_closed ?? null,
    updated_at: stamped,
    work_id: command.work_id,
    generation: command.generation,
    revision: command.expected_revision,
  }) as { revision: number } | undefined;
  if (!updated) throw new Error('CONFLICT');
  return updated.revision;
}

function insertReceipt(
  db: SqliteDatabase,
  command: WorkControlCommand,
  state: WorkControlState,
  revision: number,
  stamped: string,
): WorkControlReceipt {
  const receiptId = `wcr_${randomUUID()}`;
  db.prepare(`INSERT INTO work_control_receipts (
    receipt_id, work_id, generation, account_id, command_type, state, revision, created_at
  ) VALUES (?, ?, ?, (SELECT account_id FROM work_generations WHERE work_id = ? AND generation = ?), ?, ?, ?, ?)`).run(
    receiptId,
    command.work_id,
    command.generation,
    command.work_id,
    command.generation,
    command.type,
    state,
    revision,
    stamped,
  );
  return {
    receipt_id: receiptId,
    work_id: command.work_id,
    generation: command.generation,
    type: command.type,
    state,
    revision,
  };
}
