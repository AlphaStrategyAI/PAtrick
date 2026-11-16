import { createHash } from 'node:crypto';
import { appendDomainEvent, withDeferredTransaction, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';

const CJK = /[\u3400-\u9fff]/;

export type EvidenceQuery = {
  text: string;
  domain: string;
  withdrawalEpoch: number;
};

export type EvidenceSupport = {
  evidence_id: string;
  document_id: string;
  revision_id: string;
  status: 'supported' | 'disputed' | 'stale' | 'retracted';
};

export type EvidencePack = {
  items: Array<{
    knowledge_id: string;
    canonical_id: string;
    aliases: string[];
    available: boolean;
    support: EvidenceSupport[];
  }>;
};

export type EvidencePrincipal = {
  domains: readonly string[];
};

type SupportRow = {
  status: EvidenceSupport['status'];
  withdrawal_epoch: number | null;
};

export function tokenizeText(input: string): string[] {
  const tokens: string[] = [];
  let ascii = '';
  const cjk: string[] = [];
  const flushAscii = () => {
    const word = ascii.toLowerCase();
    ascii = '';
    if (word) tokens.push(word);
  };
  const flushCjk = () => {
    for (const character of cjk) tokens.push(character);
    for (let index = 0; index < cjk.length - 1; index += 1) tokens.push(`${cjk[index]}${cjk[index + 1]}`);
    cjk.length = 0;
  };
  for (const character of input) {
    if (CJK.test(character)) {
      flushAscii();
      cjk.push(character);
      continue;
    }
    if (/[a-z0-9]/i.test(character)) {
      flushCjk();
      ascii += character;
      continue;
    }
    flushAscii();
    flushCjk();
  }
  flushAscii();
  flushCjk();
  return [...new Set(tokens)];
}

export function tokenDocument(parts: readonly string[]): string {
  return tokenizeText(parts.join('\n')).join(' ');
}

export function ftsMatch(text: string): string {
  const tokens = tokenizeText(text);
  if (tokens.length === 0) throw new Error('UNPROCESSABLE');
  return tokens.map((token) => `"${token.replaceAll('"', '')}"`).join(' AND ');
}

export function reindexKnowledge(db: SqliteDatabase, knowledgeId: string, domain: string, parts: readonly string[]): void {
  const tokens = tokenDocument(parts);
  db.prepare('DELETE FROM knowledge_fts WHERE knowledge_id = ?').run(knowledgeId);
  db.prepare('INSERT INTO knowledge_fts (knowledge_id, data_domain, tokens) VALUES (?, ?, ?)').run(knowledgeId, domain, tokens);
}

export function recordKnowledge(db: SqliteDatabase, input: {
  accountId: string;
  domain: string;
  knowledgeId: string;
  body: string;
  alias: string | null;
  documentId: string;
  revisionId: string;
  observedSeq: number;
  now: string;
}): void {
  const existing = db.prepare('SELECT revision, data_domain, canonical_id FROM knowledge_records WHERE knowledge_id = ?').get(input.knowledgeId) as {
    revision: number;
    data_domain: string;
    canonical_id: string;
  } | undefined;
  if (existing && existing.data_domain !== input.domain) throw new Error('CONFLICT');
  const revision = existing ? existing.revision + 1 : 1;
  if (!existing) {
    db.prepare(`INSERT INTO knowledge_records (
      knowledge_id, canonical_id, account_id, data_domain, revision, status, title, body, schema_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?, '1.0', ?, ?)`).run(
      input.knowledgeId,
      input.knowledgeId,
      input.accountId,
      input.domain,
      revision,
      input.knowledgeId,
      input.body,
      input.now,
      input.now,
    );
  } else {
    db.prepare(`UPDATE knowledge_records
      SET revision = ?, body = ?, status = 'candidate', updated_at = ?
      WHERE knowledge_id = ? AND data_domain = ?`).run(revision, input.body, input.now, input.knowledgeId, input.domain);
  }
  if (input.alias) {
    db.prepare(`INSERT INTO knowledge_aliases (knowledge_id, alias, data_domain) VALUES (?, ?, ?)
      ON CONFLICT(data_domain, alias) DO NOTHING`).run(input.knowledgeId, input.alias, input.domain);
  }
  const evidenceId = `ev_${sha256(`${input.documentId}\0${input.revisionId}`).slice(0, 24)}`;
  db.prepare(`INSERT INTO evidence_refs (
    evidence_id, knowledge_id, data_domain, document_id, revision_id, source_kind, status, withdrawal_epoch, span, created_at
  ) VALUES (?, ?, ?, ?, ?, 'vault', 'supported', NULL, NULL, ?)
  ON CONFLICT(evidence_id) DO NOTHING`).run(
    evidenceId,
    input.knowledgeId,
    input.domain,
    input.documentId,
    input.revisionId,
    input.now,
  );
  db.prepare(`INSERT INTO evidence_dependencies (
    dependency_id, from_kind, from_id, from_version, to_kind, to_id, to_version, data_domain, epoch, created_at
  ) VALUES (?, 'knowledge', ?, ?, 'revision', ?, ?, ?, 0, ?)
  ON CONFLICT(dependency_id) DO NOTHING`).run(
    `dep_${evidenceId}`,
    input.knowledgeId,
    revision,
    input.revisionId,
    input.observedSeq,
    input.domain,
    input.now,
  );
  const aliases = db.prepare('SELECT alias FROM knowledge_aliases WHERE knowledge_id = ? AND data_domain = ?').all(input.knowledgeId, input.domain) as {
    alias: string;
  }[];
  const bodies = db.prepare(`SELECT body_text FROM vault_documents
    WHERE knowledge_id = ? AND kind = 'note' AND tombstone = 0 AND body_text IS NOT NULL`).all(input.knowledgeId) as { body_text: string }[];
  reindexKnowledge(db, input.knowledgeId, input.domain, [
    ...bodies.map((row) => row.body_text),
    ...aliases.map((row) => row.alias),
  ]);
}

export async function queryEvidence(
  db: SqliteDatabase,
  query: EvidenceQuery,
  principal: EvidencePrincipal,
): Promise<EvidencePack> {
  if (!principal.domains.includes(query.domain)) throw new Error('FORBIDDEN');
  const match = ftsMatch(query.text);
  return withDeferredTransaction(db, () => {
    const found = db.prepare('SELECT knowledge_id FROM knowledge_fts WHERE knowledge_fts MATCH ? AND data_domain = ?').all(match, query.domain) as {
      knowledge_id: string;
    }[];
    const ids = [...new Set(found.map((row) => row.knowledge_id))].sort();
    const items: EvidencePack['items'] = [];
    for (const knowledgeId of ids) {
      const record = db.prepare(`SELECT knowledge_id, canonical_id, data_domain, status FROM knowledge_records
        WHERE knowledge_id = ? AND data_domain = ?`).get(knowledgeId, query.domain) as {
        knowledge_id: string;
        canonical_id: string;
        data_domain: string;
        status: string;
      } | undefined;
      if (!record || record.status === 'withdrawn') continue;
      const aliases = (db.prepare('SELECT alias FROM knowledge_aliases WHERE knowledge_id = ? AND data_domain = ? ORDER BY alias').all(knowledgeId, query.domain) as {
        alias: string;
      }[]).map((row) => row.alias);
      const support = (db.prepare(`SELECT evidence_id, document_id, revision_id, status, withdrawal_epoch
        FROM evidence_refs WHERE knowledge_id = ? AND data_domain = ? ORDER BY evidence_id`).all(knowledgeId, query.domain) as Array<{
        evidence_id: string;
        document_id: string | null;
        revision_id: string | null;
        status: EvidenceSupport['status'];
        withdrawal_epoch: number | null;
      }>).filter((row) => supportActive(row, query.withdrawalEpoch)).map((row) => ({
        evidence_id: row.evidence_id,
        document_id: row.document_id ?? '',
        revision_id: row.revision_id ?? '',
        status: row.status,
      }));
      if (support.length === 0) continue;
      items.push({
        knowledge_id: record.knowledge_id,
        canonical_id: record.canonical_id,
        aliases,
        available: true,
        support,
      });
    }
    return { items };
  });
}

export function withdrawEvidence(
  db: SqliteDatabase,
  input: { domain: string; evidenceId: string; reason: string; now?: string },
): { epoch: number } {
  const now = input.now ?? new Date().toISOString();
  return withImmediateTransaction(db, () => {
    const row = db.prepare(`SELECT knowledge_id, data_domain, status FROM evidence_refs
      WHERE evidence_id = ? AND data_domain = ?`).get(input.evidenceId, input.domain) as {
      knowledge_id: string;
      data_domain: string;
      status: string;
    } | undefined;
    if (!row) throw new Error('NOT_FOUND');
    const current = db.prepare('SELECT COALESCE(MAX(epoch), 0) AS epoch FROM withdrawal_events WHERE data_domain = ?').get(input.domain) as {
      epoch: number;
    };
    const epoch = current.epoch + 1;
    db.prepare(`UPDATE evidence_refs SET status = 'retracted', withdrawal_epoch = ? WHERE evidence_id = ?`).run(epoch, input.evidenceId);
    db.prepare(`INSERT INTO withdrawal_events (
      event_id, data_domain, target_kind, target_id, target_version, epoch, reason, created_at
    ) VALUES (?, ?, 'evidence', ?, 1, ?, ?, ?)`).run(
      `withdraw:${input.evidenceId}:${epoch}`,
      input.domain,
      input.evidenceId,
      epoch,
      input.reason,
      now,
    );
    const active = db.prepare(`SELECT COUNT(*) AS n FROM evidence_refs
      WHERE knowledge_id = ? AND data_domain = ? AND status = 'supported'`).get(row.knowledge_id, input.domain) as { n: number };
    db.prepare(`UPDATE knowledge_records SET status = ?, updated_at = ? WHERE knowledge_id = ? AND data_domain = ?`).run(
      active.n > 0 ? 'candidate' : 'withdrawn',
      now,
      row.knowledge_id,
      input.domain,
    );
    const account = db.prepare('SELECT account_id FROM knowledge_records WHERE knowledge_id = ?').get(row.knowledge_id) as {
      account_id: string;
    };
    appendDomainEvent(db, {
      eventId: `evidence.invalidated:${input.evidenceId}:${epoch}`,
      aggregateId: row.knowledge_id,
      aggregateVersion: epoch,
      accountId: account.account_id,
      dataDomain: input.domain,
      payload: { type: 'evidence.invalidated', evidence_id: input.evidenceId, epoch, reason: input.reason },
      destination: 'vault',
    });
    return { epoch };
  });
}

function supportActive(row: SupportRow, epoch: number): boolean {
  if (row.status === 'retracted') return false;
  if (row.withdrawal_epoch !== null && row.withdrawal_epoch <= epoch) return false;
  return true;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
