import { withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';

export const HUB_CURSOR = 'hub_observer';

export type HubRunEventView = {
  source: string;
  type: string;
  subject: string;
  summary: string;
  detail?: string;
};

export type HubRunView = {
  id: number;
  rule: string;
  state: string;
  attempts: number;
  summary: string;
  error: string;
  events: HubRunEventView[];
};

export type HubCardView = {
  id: number;
  title: string;
  state: string;
  choice: number | null;
  answer: string | null;
};

export type HubRuleLine = {
  name: string;
  group: string;
};

export type HubStatePage = {
  seq: number;
  runs: HubRunView[];
  cards: HubCardView[];
  lines: HubRuleLine[];
  hasMore: boolean;
  nextBefore: number | null;
};

export type HubSnapshot = {
  hub_seq: number;
  runs: HubRunView[];
  cards: HubCardView[];
};

export type HubStateReader = {
  state(before?: number): Promise<HubStatePage>;
};

export async function readConsistentHubSnapshot(hub: HubStateReader): Promise<HubSnapshot> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const first = await hub.state();
    const pages = [first];
    const seen = new Set<number>();
    let before = nextPage(first);
    while (before !== null) {
      if (seen.has(before)) throw new Error('HUB_PAGE_INVALID');
      seen.add(before);
      const page = await hub.state(before);
      pages.push(page);
      before = nextPage(page);
    }
    const followed = await hub.state();
    if (followed.seq === first.seq) {
      return { hub_seq: followed.seq, runs: mergeRuns(pages), cards: first.cards };
    }
  }
  throw new Error('HUB_SNAPSHOT_GAP');
}

export async function rebuildHubView(
  db: SqliteDatabase,
  hub: HubStateReader,
  now = new Date().toISOString(),
): Promise<{ hub_seq: number }> {
  const view = await readConsistentHubSnapshot(hub);
  storeHubView(db, view, now);
  return { hub_seq: view.hub_seq };
}

export function storeHubView(db: SqliteDatabase, view: HubSnapshot, now: string): void {
  const snapshot = JSON.stringify({ runs: view.runs, cards: view.cards });
  withImmediateTransaction(db, () => {
    db.prepare(`INSERT INTO hub_snapshots (cursor_name, hub_seq, snapshot, imported_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(cursor_name) DO UPDATE SET
        hub_seq = excluded.hub_seq,
        snapshot = excluded.snapshot,
        imported_at = excluded.imported_at`).run(HUB_CURSOR, view.hub_seq, snapshot, now);
    db.prepare(`INSERT INTO projection_cursors (name, hub_seq, domain_seq, updated_at)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(name) DO UPDATE SET
        hub_seq = excluded.hub_seq,
        updated_at = excluded.updated_at`).run(HUB_CURSOR, view.hub_seq, now);
  });
}

export function readHubView(db: SqliteDatabase): HubSnapshot {
  const stored = db.prepare('SELECT hub_seq, snapshot FROM hub_snapshots WHERE cursor_name = ?').get(HUB_CURSOR) as
    | { hub_seq: number; snapshot: string }
    | undefined;
  const cursor = db.prepare('SELECT hub_seq FROM projection_cursors WHERE name = ?').get(HUB_CURSOR) as
    | { hub_seq: number }
    | undefined;
  if (!stored || !cursor) throw new Error('HUB_VIEW_MISSING');
  if (stored.hub_seq !== cursor.hub_seq) throw new Error('HUB_CURSOR_MISMATCH');
  const parsed = JSON.parse(stored.snapshot) as { runs: HubRunView[]; cards: HubCardView[] };
  return { hub_seq: stored.hub_seq, runs: parsed.runs, cards: parsed.cards };
}

function nextPage(page: HubStatePage): number | null {
  if (!page.hasMore) return null;
  if (page.nextBefore === null) throw new Error('HUB_PAGE_INVALID');
  return page.nextBefore;
}

function mergeRuns(pages: readonly HubStatePage[]): HubRunView[] {
  const byId = new Map<number, HubRunView>();
  for (const page of pages) {
    for (const run of page.runs) byId.set(run.id, run);
  }
  return [...byId.values()].sort((left, right) => left.id - right.id);
}
