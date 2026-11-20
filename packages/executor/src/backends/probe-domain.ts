import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../storage/src/database.js';
import { startHarnessRpcServer } from '../harness-rpc.js';

export type ProbeDomain = {
  url: string;
  token: string;
  knowledgeId: string;
  domain: string;
  close(): Promise<void>;
};

/**
 * A small domain for the admission probe.
 *
 * The probe only asks whether the backend can reach the bundle and read the
 * domain through it, so the domain holds one knowledge item with one admitted
 * evidence record. The bundle still takes its answer through the restricted
 * RPC, never from a database connection.
 */
export async function startProbeDomain(now: () => Date): Promise<ProbeDomain> {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-probe-domain-'));
  const db = openDatabase(join(dir, 'domain.sqlite'));
  const stamp = now().toISOString();
  const domain = 'personal';
  const knowledgeId = 'K-001';
  db.prepare('INSERT INTO knowledge_records (knowledge_id,canonical_id,account_id,data_domain,revision,status,title,body,'
    + 'schema_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
    knowledgeId, 'K-001', 'probe', domain, 1, 'available', 'Admission probe', 'The bundle reads this record.',
    '1.0', stamp, stamp);
  db.prepare('INSERT INTO evidence_refs (evidence_id,knowledge_id,data_domain,document_id,revision_id,source_kind,status,'
    + 'withdrawal_epoch,span,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    'ev-probe-1', knowledgeId, domain, 'doc-probe-1', 'rev-probe-1', 'vault', 'supported', 0, null, stamp);
  const rpc = await startHarnessRpcServer({ db, principal: { account_id: 'probe', domains: [domain] }, now });
  return {
    url: rpc.url,
    token: rpc.token,
    knowledgeId,
    domain,
    async close() {
      await rpc.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
