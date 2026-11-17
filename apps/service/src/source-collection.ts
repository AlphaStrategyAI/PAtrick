import { randomUUID } from 'node:crypto';
import type { SourceRegistry } from '@patrick/integrations/sources/registry';
import { withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';

type Candidate = { source_id: string; config_revision: number; frequency: string };
type Claim = Candidate & { token: string };
const leaseMs = 45_000;
const min = 60_000;
const interval: Record<string, number> = { poll: 15 * min, '30m': 30 * min, '1h': 60 * min, '6h': 360 * min, '24h': 1440 * min };
export type HttpCollectionWorkerOptions = { signal: AbortSignal; pollMs?: number; onError?: (error: unknown) => void };

export function createHttpCollectionWorker(db: SqliteDatabase, registry: SourceRegistry, now: () => Date, options: HttpCollectionWorkerOptions) {
  const { signal, onError } = options;
  const pollMs = options.pollMs ?? 5_000;
  if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60_000) throw new Error('SOURCE_WORKER_POLL_INVALID');
  let running = false;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function claim(): Claim | undefined {
    const at = now();
    const stamp = at.toISOString();
    return withImmediateTransaction(db, () => {
      const row = db.prepare(`SELECT c.source_id,c.config_revision,c.frequency FROM source_configs c
        LEFT JOIN http_source_schedule s USING(source_id)
        WHERE c.connector_type IN ('rss','webpage') AND c.enabled=1 AND c.status='enabled'
        AND (s.lease_until IS NULL OR s.lease_until<=?)
        AND (s.source_id IS NULL OR s.config_revision<>c.config_revision OR s.next_at<=?)
        ORDER BY CASE WHEN s.config_revision=c.config_revision THEN s.next_at ELSE c.updated_at END,c.source_id LIMIT 1`)
        .get(stamp, stamp) as Candidate | undefined;
      if (!row) return;
      const token = randomUUID();
      db.prepare(`INSERT INTO http_source_schedule(source_id,config_revision,lease_token,lease_until,next_at)
        VALUES (?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET config_revision=excluded.config_revision,
        lease_token=excluded.lease_token,lease_until=excluded.lease_until,next_at=excluded.next_at`)
        .run(row.source_id, row.config_revision, token, new Date(+at + leaseMs).toISOString(), stamp);
      return { ...row, token };
    });
  }

  async function tick() {
    if (running || signal.aborted) return false;
    running = true;
    try {
      const work = claim();
      if (!work) return false;
      const isLive = () => !signal.aborted && !!db.prepare(`SELECT 1 FROM http_source_schedule
        WHERE source_id=? AND config_revision=? AND lease_token=? AND lease_until>?`)
        .get(work.source_id, work.config_revision, work.token, now().toISOString());
      try {
        await registry.collectSource(work.source_id, work.config_revision, { isLive, signal });
      } finally {
        const nextAt = new Date(+now() + (signal.aborted ? 0 : interval[work.frequency] ?? interval.poll)).toISOString();
        withImmediateTransaction(db, () => {
          db.prepare(`UPDATE http_source_schedule SET lease_token=NULL,lease_until=NULL,next_at=?
            WHERE source_id=? AND config_revision=? AND lease_token=?`).run(nextAt, work.source_id, work.config_revision, work.token);
        });
      }
      return true;
    } finally { running = false; }
  }

  function start() {
    if (signal.aborted || started) return;
    started = true;
    signal.addEventListener('abort', () => { if (timer) clearTimeout(timer); }, { once: true });
    const schedule = () => {
      if (signal.aborted) return;
      timer = setTimeout(() => {
        void tick().catch((error: unknown) => {
          try { onError?.(error); } catch { /* Observer cannot stop scheduled reconciliation. */ }
        }).finally(schedule);
      }, pollMs);
      timer.unref();
    };
    schedule();
  }
  return { start, tick };
}
