import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createConsultationApi } from '../../packages/domain/src/consultations.js';
import { createCredentialStore } from '../../packages/host/src/credentials.js';
import { createConsultationHubReceipts } from '../../packages/integrations/autoloop/consultation-hub-receipts.js';
import { openDatabase } from '../../packages/storage/src/database.js';

test('a restart posts the exact old Hub receipt after local completion and a lost response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-hub-receipt-'));
  const path = join(dir, 'db.sqlite');
  const now = () => new Date('2026-11-17T03:00:00.000Z');
  const credentialsPath = join(dir, 'credentials');
  const principal = { account_id: 'owner', caller_id: 'web', auth_epoch: 1, domains: ['product'], operations: ['owner'] };
  const token = randomUUID();
  const posted: unknown[][] = [];
  const onError = (error: unknown) => { throw error; };
  let db = openDatabase(path);
  try {
    db.prepare('INSERT INTO accounts (account_id, auth_epoch, policy_revision, created_at) VALUES (?,?,?,?)')
      .run(principal.account_id, 1, 0, now().toISOString());
    const api = createConsultationApi(db, { now });
    const c = await api.createConsultation(principal, {
      client_request_id: 'one-question', data_domain: 'product', parent_work_id: null, text: 'Question',
    });
    const first = createConsultationHubReceipts(db, createCredentialStore(credentialsPath, now), {
      async result() { throw new Error('unexpected first-process send'); },
    });
    first.bind(c.request_id, { run: 7, token });
    expect(await api.completeConsultation(c.request_id, 0, { text: 'Answer' })).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE payload LIKE ?").get(`%${token}%`)).toEqual({ n: 0 });
    db.close();

    db = openDatabase(path);
    const second = createConsultationHubReceipts(db, createCredentialStore(credentialsPath, now), {
      async result(...args) { posted.push(args); throw new Error('lost response after Hub accepted'); },
    });
    await expect(second.recover(32, onError)).rejects.toThrow('lost response');
    db.close();

    db = openDatabase(path);
    const third = createConsultationHubReceipts(db, createCredentialStore(credentialsPath, now), {
      async result(...args) { posted.push(args); return { rejected: [] }; },
    });
    await third.recover(32, onError);
    await third.recover(32, onError);
    expect(posted).toEqual([[7, token, { outcome: 'done', summary: 'consultation answered' }],
      [7, token, { outcome: 'done', summary: 'consultation answered' }]]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
