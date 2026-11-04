import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, readdirSync, existsSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { digest, stableId, tokenize, type Entities, type KnowledgeCard, type Scope, type Table } from './domain.js';
import { ingestSource, redactWithdrawnEvidence } from './intake.js';

const tables: Table[] = ['projects', 'sources', 'tasks', 'cards', 'rules', 'cases', 'questions', 'events', 'attempts', 'outbox', 'receipts', 'actions', 'cursors'];
const vaultTables = new Set<Table>(['sources', 'cards', 'rules', 'cases']);
type VaultJob = { table: Table; entity: Entities[Table]; previous?: Entities[Table] };

/** SQLite owns business state; the Vault and FTS are recoverable, scoped projections. */
export class Store {
  private readonly db: Database.Database;
  private temporary = new Map<string, Entities[Table]>();
  private vaultJobs = new Map<string, VaultJob>();
  private depth = 0;
  private closed = false;
  private preserveVaultPaths = new Set<string>();

  constructor(databasePath: string, private readonly vaultDir?: string) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    if (vaultDir) mkdirSync(vaultDir, { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    for (const table of tables) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, domain TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ${table}_scope ON ${table}(project_id, domain)`);
    this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(id UNINDEXED, project_id UNINDEXED, domain UNINDEXED, terms, tokenize='unicode61')");
    // Read the Vault before projecting SQLite, so an independent edit is never overwritten at startup.
    this.recoverVault();
    this.transaction(() => { for (const source of this.list('sources')) if (source.status === 'withdrawn') redactWithdrawnEvidence(this, source.id); });
    if (vaultDir) for (const table of vaultTables) for (const entity of this.list(table)) this.publish({ table, entity }, true);
    this.rebuildIndex();
  }

  get<K extends Table>(table: K, id: string): Entities[K] | undefined {
    this.assertTable(table);
    const temporary = this.temporary.get(`${table}:${id}`);
    if (temporary) return structuredClone(temporary) as Entities[K];
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as Entities[K] : undefined;
  }

  list<K extends Table>(table: K): Entities[K][] {
    this.assertTable(table);
    const rows = this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all() as { data: string }[];
    const result = new Map(rows.map(row => { const entity = JSON.parse(row.data) as Entities[K]; return [entity.id, entity]; }));
    for (const [key, entity] of this.temporary) if (key.startsWith(`${table}:`)) result.set(entity.id, structuredClone(entity) as Entities[K]);
    return [...result.values()];
  }

  save<K extends Table>(table: K, entity: Entities[K]): void {
    this.assertTable(table);
    const previous = this.get(table, entity.id);
    const value = structuredClone(entity);
    const key = `${table}:${entity.id}`;
    if (table === 'sources' && (value as Entities['sources']).retention === 'ephemeral') {
      this.temporary.set(key, value);
      this.write(table, { ...value, content: '', title: 'Temporary source' } as Entities[K]);
      return;
    }
    if (this.isTemporaryDerived(table, value)) {
      this.temporary.set(key, value);
      return;
    }
    if (this.isTemporaryTaskEntity(table, value)) {
      this.temporary.set(key, value);
      this.write(table, this.redactTemporary(table, value) as Entities[K]);
      return;
    }
    this.temporary.delete(key);
    this.write(table, value);
    if (table === 'cards') this.indexCard(value as KnowledgeCard);
    if (table === 'sources') {
      const source = value as Entities['sources'];
      if (source.status !== 'active') this.db.prepare('DELETE FROM cards_fts WHERE id IN (SELECT json_extract(data, \'$.id\') FROM cards WHERE json_extract(data, \'$.sourceId\') = ?)').run(source.id);
    }
    if (vaultTables.has(table)) {
      this.vaultJobs.set(key, { table, entity: value, previous });
      if (!this.depth) this.flushVault();
    }
  }

  delete(table: Table, id: string): void {
    this.assertTable(table); const entity = this.get(table, id);
    this.temporary.delete(`${table}:${id}`);
    this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    if (table === 'cards') this.db.prepare('DELETE FROM cards_fts WHERE id = ?').run(id);
    if (entity && this.vaultDir && vaultTables.has(table)) {
      const path = this.vaultPath(table, entity);
      // Deletions are represented by a tombstone in the same post-commit projection queue.
      this.vaultJobs.set(`${table}:${id}`, { table, entity: { ...entity, status: 'withdrawn' } as Entities[Table], previous: entity });
      if (!this.depth && existsSync(path)) this.flushVault();
    }
  }

  transaction<T>(fn: () => T): T {
    const previousJobs = new Map(this.vaultJobs); const previousTemporary = new Map(this.temporary);
    this.depth++;
    let result: T;
    try {
      result = this.db.transaction(() => {
        const value = fn();
        if (value && typeof (value as { then?: unknown }).then === 'function') throw new Error('Store transactions must be synchronous.');
        return value;
      })();
    } catch (error) {
      this.depth--;
      this.vaultJobs = previousJobs; this.temporary = previousTemporary;
      throw error;
    }
    this.depth--;
    if (!this.depth) this.flushVault();
    return result;
  }

  searchCards(query: string, scope: Scope, limit = 20): KnowledgeCard[] {
    const terms = tokenize(query).split(' ').filter(Boolean);
    if (!terms.length) return [];
    const match = [...new Set(terms)].map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    const rows = this.db.prepare('SELECT id FROM cards_fts WHERE cards_fts MATCH ? AND project_id = ? AND domain = ? ORDER BY bm25(cards_fts) LIMIT ?').all(match, scope.projectId, scope.domain, Math.max(1, Math.min(100, Math.floor(limit)))) as { id: string }[];
    return rows.flatMap(row => { const card = this.get('cards', row.id); return card && this.cardActive(card, scope) ? [card] : []; });
  }

  indexCard(card: KnowledgeCard): void {
    this.db.prepare('DELETE FROM cards_fts WHERE id = ?').run(card.id);
    if (!this.cardActive(card, card) || this.get('sources', card.sourceId)?.retention === 'ephemeral') return;
    this.db.prepare('INSERT INTO cards_fts(id, project_id, domain, terms) VALUES (?, ?, ?, ?)').run(card.id, card.projectId, card.domain, tokenize([card.title, card.aliases.join(' '), card.body, card.quote].join(' ')));
  }

  rebuildIndex(): void {
    this.recoverVault();
    this.db.transaction(() => { this.db.exec('DELETE FROM cards_fts'); for (const card of this.list('cards')) this.indexCard(card); })();
  }

  async backup(destination: string): Promise<void> { mkdirSync(dirname(destination), { recursive: true }); await this.db.backup(destination); }
  vaultDirectory():string|undefined{return this.vaultDir;}
  close(): void { if (this.closed) return; this.db.close(); this.closed = true; this.temporary.clear(); }

  private write<K extends Table>(table: K, entity: Entities[K]): void {
    this.db.prepare(`INSERT INTO ${table}(id, project_id, domain, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, domain = excluded.domain, data = excluded.data`).run(entity.id, entity.projectId, entity.domain, JSON.stringify(entity));
  }
  private assertTable(table: string): void { if (!tables.includes(table as Table)) throw new Error('Unknown entity table.'); }
  private cardActive(card: KnowledgeCard, scope: Scope): boolean {
    const source = this.get('sources', card.sourceId);
    return card.status === 'active' && card.projectId === scope.projectId && card.domain === scope.domain && (!card.expiresAt || Date.parse(card.expiresAt) > Date.now()) && source?.status === 'active' && source.revision === card.sourceRevision && source.projectId === card.projectId && source.domain === card.domain;
  }
  private isTemporaryDerived(table: Table, entity: Entities[Table]): boolean {
    if (!['cards', 'rules', 'cases'].includes(table)) return false;
    if ('sourceId' in entity) return this.get('sources', entity.sourceId)?.retention === 'ephemeral';
    if ('citations' in entity) return entity.citations.some(c => this.get('sources', c.sourceId)?.retention === 'ephemeral');
    return false;
  }
  private isTemporaryTaskEntity(table: Table, entity: Entities[Table]): boolean {
    const task = table === 'tasks' ? entity as Entities['tasks'] : 'taskId' in entity && entity.taskId ? this.get('tasks', entity.taskId) : undefined;
    return !!task && this.get('sources', task.sourceId)?.retention === 'ephemeral';
  }
  private redactTemporary(table: Table, entity: Entities[Table]): Entities[Table] {
    if (table === 'tasks') return { ...entity, title: 'Temporary task', description: '', decision: undefined, plan: undefined, artifact: undefined, review: undefined, feedback: undefined, baselineFiles: undefined, error: 'Temporary content is kept only in the active process.' } as Entities['tasks'];
    if (table === 'events') return { ...entity, message: 'Temporary task event.', data: {} } as Entities['events'];
    if (table === 'attempts') {
      const attempt = entity as Entities['attempts'];
      // Retain only fixed accounting/availability codes, never provider or source text.
      const error = ['attempt_abandoned_after_host_restart', 'billing_policy_violation', 'subscription_unavailable'].includes(attempt.error ?? '') ? attempt.error : undefined;
      return { ...attempt, error };
    }
    if (table === 'actions') return { ...entity, payload: {} } as Entities['actions'];
    if (table === 'outbox') return { ...entity, text: '', status: 'sent', remoteId: 'expired-temporary' } as Entities['outbox'];
    if (table === 'questions') {
      const q = entity as Entities['questions']; const option = { label: '[expired]', description: '[expired]', rationale: '[expired]', tradeoff: '[expired]', evidenceUrls: [] };
      return { ...q, title: 'Temporary question', context: '', status: 'stale', options: { A: option, B: option }, research: { queries: [], summary: '', gaps: [] }, answer: q.answer ? { ...q.answer, text: '' } : undefined };
    }
    return entity;
  }
  private vaultPath(table: Table, entity: Entities[Table]): string {
    const segment = (text: string) => encodeURIComponent(text).replaceAll('.', '%2E');
    return join(this.vaultDir!, segment(entity.projectId), segment(entity.domain), table, `${segment(entity.id)}.md`);
  }
  private markdown(table: Table, entity: Entities[Table]): string {
    entity = this.vaultEntity(table, entity);
    const meta = ['---', `id: ${JSON.stringify(entity.id)}`, `project: ${JSON.stringify(entity.projectId)}`, `domain: ${JSON.stringify(entity.domain)}`, `type: ${table}`, `patrick_entity: ${JSON.stringify(entity)}`];
    if ('status' in entity) meta.push(`status: ${entity.status}`);
    if ('sourceId' in entity) meta.push(`source: ${JSON.stringify(entity.sourceId)}`);
    if ('sourceRevision' in entity) meta.push(`revision: ${JSON.stringify(entity.sourceRevision)}`);
    if ('verification' in entity) meta.push(`verification: ${entity.verification}`);
    meta.push('---', '');
    if ('status' in entity && !['active'].includes(entity.status)) return `${meta.join('\n')}\nEvidence is no longer active.\n`;
    const title = 'title' in entity ? entity.title : 'originalWords' in entity ? 'Decision case' : entity.id;
    let body = '';
    if (table === 'sources') body = (entity as Entities['sources']).content;
    if (table === 'cards') { const card = entity as Entities['cards']; body = `${card.body}\n\n> ${card.quote.replaceAll('\n', '\n> ')}\n\nSource: ${card.locator}\nRevision: ${card.sourceRevision}`; }
    if (table === 'rules') { const rule = entity as Entities['rules']; body = `${rule.statement}\n\nKind: ${rule.kind}\nVersion: ${rule.version}\nConditions: ${rule.conditions}\nExceptions: ${rule.exceptions}\n\n${rule.citations.map(c => `> ${c.quote}\n\nSource: ${c.locator} (${c.revision})`).join('\n\n')}`; }
    if (table === 'cases') {
      const c = entity as Entities['cases'], s = c.decisionSnapshot;
      body = `${c.originalWords}\n\nChoice: ${c.choice}\nActor: ${c.actorId}\nQuestion: ${c.questionId}\nRationale: ${c.rationale}\n\n## Judgment at the time\n\n${s ? `Goal: ${s.goal.title}\n\n${s.decision.summary}\n\n${s.decision.rationale}\n\nExpected outcome: ${s.expectedOutcome ?? 'Not stated'}\n\n${s.rules.map(rule => `Used rule: ${rule.title} @ v${rule.version}\n${rule.statement}`).join('\n\n')}` : 'Historical judgment snapshot unavailable.'}\n\n## Observed results\n\n${c.outcomes?.length ? c.outcomes.map(outcome => `${outcome.recordedAt} · Receipt ${outcome.receiptId}\n${outcome.summary}`).join('\n\n') : c.outcome ?? 'Not observed'}`;
    }
    return `${meta.join('\n')}\n# ${title}\n\n${body}\n`;
  }
  private publish(job: VaultJob, startup = false): void {
    if (!this.vaultDir || this.isTemporaryDerived(job.table, job.entity) || job.table === 'sources' && (job.entity as Entities['sources']).retention === 'ephemeral') return;
    const path = this.vaultPath(job.table, job.entity); const body = this.markdown(job.table, job.entity);
    const effective = this.vaultEntity(job.table, job.entity);
    const inactive = 'status' in effective && effective.status !== 'active';
    if (startup && !inactive && this.preserveVaultPaths.has(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    if (inactive) {
      const prefix = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '.conflict-');
      for (const name of readdirSync(dirname(path))) if (name.startsWith(prefix) && name.endsWith('.md')) writeFileSync(join(dirname(path), name), body, { mode: 0o600 });
    }
    if (existsSync(path)) {
      const previous = readFileSync(path, 'utf8');
      if (previous === body) return;
      if (!inactive && (!job.previous || previous !== this.markdown(job.table, job.previous))) {
        const conflict = path.replace(/\.md$/, `.conflict-${digest(previous).slice(0, 12)}.md`);
        if (!existsSync(conflict)) writeFileSync(conflict, previous, { flag: 'wx', mode: 0o600 });
      }
    }
    const temporaryPath = `${path}.tmp-${process.pid}`;
    try { writeFileSync(temporaryPath, body, { mode: 0o600 }); renameSync(temporaryPath, path); }
    finally { if (existsSync(temporaryPath)) unlinkSync(temporaryPath); }
  }
  private flushVault(): void { const jobs = [...this.vaultJobs.values()]; this.vaultJobs.clear(); for (const job of jobs) this.publish(job); }

  private vaultEntity(table: Table, entity: Entities[Table]): Entities[Table] {
    if (table === 'sources') { const s = entity as Entities['sources']; return s.status === 'active' ? s : { ...s, title: '[withdrawn]', content: '', locator: `withdrawn:${s.id}` }; }
    if (table === 'cards') { const c = entity as Entities['cards']; return this.cardActive(c, c) ? c : { ...c, status: 'withdrawn', title: '[withdrawn]', body: '', quote: '', aliases: [], locator: `withdrawn:${c.sourceId}` }; }
    if (table === 'rules') {
      const r = entity as Entities['rules'];
      if (r.status !== 'active' || r.citations.some(c => { const s = this.get('sources', c.sourceId); return s?.status !== 'active' || s.revision !== c.revision; })) return { ...r, status: 'suspended', title: '[withdrawn]', statement: '[Evidence no longer active]', conditions: '[withdrawn]', exceptions: '[withdrawn]', citations: r.citations.map(c => ({ ...c, quote: '[inactive]', locator: `withdrawn:${c.sourceId}` })) };
    }
    if (table === 'cases') { const c = entity as Entities['cases']; if (c.status !== 'active' || this.get('sources', c.sourceId)?.status !== 'active' || c.decisionSnapshot?.sourceRefs.some(ref => { const source = this.get('sources', ref.id); return source?.status !== 'active' || source.revision !== ref.revision; })) return { ...c, status: 'withdrawn', originalWords: '[withdrawn]', rationale: '[withdrawn]', alternatives: [], outcome: undefined, decisionSnapshot: undefined, outcomes: undefined }; }
    return entity;
  }

  private ordinarySourceIdentity(source: Entities['sources']): boolean {
    return ['file', 'feishu', 'github', 'conversation', 'manual', 'reading'].includes(source.kind)
      && typeof source.externalId === 'string' && !!source.externalId.trim()
      && source.id === stableId('source', { projectId: source.projectId, domain: source.domain }, source.kind, source.externalId, source.revision);
  }

  /** Missing rows must match a host-generated identity; editable classification is not authority. */
  private recoverableSourceIdentity(source: Entities['sources'], trustedQuestions: ReadonlyMap<string, Entities['questions']>): boolean {
    if (this.ordinarySourceIdentity(source)) return true;
    if (source.kind !== 'conversation' || typeof source.externalId !== 'string' || !source.externalId.startsWith('answer:')) return false;
    const question = trustedQuestions.get(source.externalId.slice('answer:'.length));
    if (!question || question.status !== 'answered' || !question.answer || source.id !== stableId('owner-answer', question.id)) return false;
    const project = this.get('projects', question.projectId), task = this.get('tasks', question.taskId);
    const primary = task && this.get('sources', task.sourceId);
    return !!project && !!task && !!primary && question.projectId === source.projectId && question.domain === source.domain
      && project.domain === source.domain && project.ownerId === question.ownerId && question.answer.actorId === project.ownerId
      && source.authorId === project.ownerId && task.projectId === source.projectId && task.domain === source.domain && task.version >= question.taskVersion
      && primary.status === 'active' && primary.revision === task.sourceRevision && primary.projectId === source.projectId && primary.domain === source.domain
      && source.retention === primary.retention && source.revision === digest(question.answer.text) && source.content === question.answer.text
      && source.locator === `question:${question.id}@${question.version}`;
  }

  /** Import only our structured card format; existing withdrawal records always win. */
  private recoverVault(): void {
    if (!this.vaultDir) return;
    // Capture authority before any editable projection can be written back into SQLite.
    const trustedSources = new Map(this.list('sources').map(source => [source.id, source]));
    const trustedQuestions = new Map(this.list('questions').map(question => [question.id, question]));
    let trustedTasks: Entities['tasks'][] | undefined;
    const trustedPaths = new Map<string, { id: string; revision: string }[]>();
    for (const table of vaultTables) for (const entity of this.list(table)) {
      const refs = table === 'sources' ? [{ id: entity.id, revision: (entity as Entities['sources']).revision }]
        : table === 'rules' ? (entity as Entities['rules']).citations.map(c => ({ id: c.sourceId, revision: c.revision }))
        : table === 'cards' ? [{ id: (entity as Entities['cards']).sourceId, revision: (entity as Entities['cards']).sourceRevision }]
        : [{ id: (entity as Entities['cases']).sourceId, revision: trustedSources.get((entity as Entities['cases']).sourceId)?.revision ?? '' }, ...((entity as Entities['cases']).decisionSnapshot?.sourceRefs ?? [])];
      trustedPaths.set(`vault:${relative(this.vaultDir, this.vaultPath(table, entity))}`, refs);
    }
    // Legacy SQLite rows have trustworthy path identities even when their projections were edited or removed.
    for (const source of trustedSources.values()) if (!source.parentSources && source.kind === 'file' && source.externalId.startsWith('vault:')) {
      const refs = trustedPaths.get(source.externalId);
      if (refs?.length && !refs.some(ref => ref.id === source.id)) {
        source.parentSources = refs; this.write('sources', source);
      }
    }
    const records: { table: Table; entity: Entities[Table]; path: string; text: string }[] = [];
    const walk = (directory: string) => {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isDirectory()) { walk(path); continue; }
        if (!item.isFile() || !item.name.endsWith('.md') || item.name.includes('.conflict-')) continue;
        const text = readFileSync(path, 'utf8'); const header = text.match(/^---\n([\s\S]*?)\n---\n/);
        if (!header) continue;
        const table = header[1]?.match(/^type: (\w+)$/m)?.[1] as Table;
        const json = header[1]?.match(/^patrick_entity: (.+)$/m)?.[1];
        if (!json || !vaultTables.has(table)) continue;
        try {
          const entity = JSON.parse(json) as Entities[Table];
          if (!entity.id || !entity.projectId || !entity.domain || this.vaultPath(table, entity) !== path) continue;
          records.push({ table, entity, path, text });
        } catch { /* A malformed human edit is preserved and never silently trusted. */ }
      }
    };
    walk(this.vaultDir);
    const order = ['sources', 'cases', 'cards', 'rules'];
    // Accepted answers depend on primary rows: finish ordinary source recovery first, regardless of filenames.
    const recoveryOrder = (record: typeof records[number]) => record.table === 'sources'
      ? this.ordinarySourceIdentity(record.entity as Entities['sources']) ? 0 : 1
      : order.indexOf(record.table) + 1;
    records.sort((a, b) => recoveryOrder(a) - recoveryOrder(b));
    const edits: typeof records = [];
    for (const record of records) {
      const { table, entity, path, text } = record;
      const existing = this.get(table, entity.id);
      let sourceEdited: boolean | undefined;
      if (existing && 'status' in existing && existing.status !== 'active') {this.publish({table,entity:existing},true);continue;}
      if (table === 'sources') {
        const s = entity as Entities['sources'];
        if (s.retention !== 'permanent' || typeof s.content !== 'string' || typeof s.revision !== 'string' || !['active', 'superseded', 'withdrawn'].includes(s.status)) continue;
        // Purpose normalization is recovery bookkeeping, not an independent content edit.
        sourceEdited = text !== this.markdown(table, entity);
        const canonical = trustedSources.get(s.id);
        s.parentSources = canonical?.parentSources;
        s.purpose = canonical ? canonical.purpose ?? 'task' : (trustedTasks ??= this.list('tasks')).some(task => task.sourceId === s.id && task.sourceRevision === s.revision && task.projectId === s.projectId && task.domain === s.domain) ? 'task' : 'reference';
        if (!canonical && (!this.recoverableSourceIdentity(s, trustedQuestions) || s.kind === 'file' && s.externalId.startsWith('vault:'))) {
          // Mismatched identities and copies without host provenance cannot recover readable material.
          s.status = 'withdrawn'; s.content = ''; s.title = '[withdrawn]'; s.locator = `withdrawn:${s.id}`; s.parentSources = []; s.purpose = 'reference'; sourceEdited = false;
        }
      }
      if (table === 'cards') {
        const c = entity as Entities['cards']; const source = this.get('sources', c.sourceId);
        if (source && source.status !== 'active') { this.publish({ table, entity: this.vaultEntity(table, entity) }, true); continue; }
        if (!this.cardActive(c, c) || source?.retention !== 'permanent' || !source.content.includes(c.quote) || !Array.isArray(c.aliases) || !['reported', 'verified', 'inference'].includes(c.verification)) continue;
        // A recovered model card is never promoted to verified merely by its Markdown label.
        if (!existing && c.verification === 'verified') c.verification = 'reported';
      }
      if (table === 'cases') {
        const c = entity as Entities['cases']; const p = this.get('projects', c.projectId); const source = this.get('sources', c.sourceId); const q = this.get('questions', c.questionId);
        if (!p || c.actorId !== p.ownerId || source?.status !== 'active' || source.authorId !== p.ownerId || q?.status !== 'answered' || q.answer?.actorId !== p.ownerId || q.answer.text !== c.originalWords) continue;
      }
      if (table === 'rules') {
        const r = entity as Entities['rules'];
        if (!Array.isArray(r.citations) || !r.citations.length || r.citations.some(c => { const s = this.get('sources', c.sourceId); return s?.status !== 'active' || s.revision !== c.revision || s.projectId !== r.projectId || s.domain !== r.domain || !s.content.includes(c.quote); })) continue;
        if (r.kind === 'principle' && (!Array.isArray(r.caseIds) || !r.caseIds.length || r.caseIds.some(id => this.get('cases', id)?.status !== 'active'))) continue;
      }
      if (!existing) this.write(table, entity);
      if (sourceEdited ?? text !== this.markdown(table, entity)) { this.preserveVaultPaths.add(path); edits.push(record); }
    }
    for (const record of edits) {
      if (!this.get('projects', record.entity.projectId)) continue;
      const content = record.text.replace(/^---\n[\s\S]*?\n---\n/, '');
      const externalId=`vault:${relative(this.vaultDir,record.path)}`,lineage=this.list('sources').filter(source=>source.projectId===record.entity.projectId&&source.domain===record.entity.domain&&source.kind==='file'&&source.externalId===externalId),current=lineage.find(source=>source.status==='active');
      if(current&&digest(current.content)===digest(content))continue;
      const revision=stableId('vault-occurrence',lineage.at(-1)?.id??'first',digest(content));
      // Source purpose was resolved from pre-recovery authority, never from editable frontmatter.
      const purpose=record.table==='sources'?(record.entity as Entities['sources']).purpose??'reference':'task';
      const parentSources = trustedPaths.get(`vault:${relative(this.vaultDir, record.path)}`)
        ?? (record.table === 'sources' ? [{ id: record.entity.id, revision: (record.entity as Entities['sources']).revision }] : []);
      if (parentSources.some(ref => { const parent = this.get('sources', ref.id); return parent?.status !== 'active' || parent.revision !== ref.revision; })) continue;
      try { ingestSource(this, { projects: [] }, { projectId: record.entity.projectId, kind: 'file', externalId,revision, title: `Vault edit: ${'title' in record.entity ? record.entity.title : record.entity.id}`, content, locator: record.path, retention: 'permanent',purpose }, parentSources); }
      catch { /* Revoked/conflicting edits remain intact for explicit review. */ }
    }
  }
}
