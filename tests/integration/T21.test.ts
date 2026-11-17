import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { canonicalPayload, type Json } from '@patrick/contracts';
import { createCredentialStore } from '@patrick/host';
import { openDatabase } from '@patrick/storage';
import { createApp } from '../../apps/service/src/app.js';
import { issueCallerSession, ORIGIN, RP_ID } from '../../apps/service/src/auth.js';
import { parseNetworkPolicy } from '../../packages/host/src/network/vpn.js';
import { createMacNetworkActuator } from '../../packages/host/src/network/native.js';

const at = '2026-11-17T07:00:00.000Z';
const policy = parseNetworkPolicy({
  schema_version: '1.0', device_id: 'registered-mac', revision: 1,
  targets: [{ id: 'hub', role: 'hub' }, { id: 'work', role: 'target' }, { id: 'peer', role: 'peer' }],
  vpn_paths: [], repairs: [{ id: 'work-dns', kind: 'refresh_dns', target: 'work' }],
  limits: { maximum_attempts: 1, cooldown_ms: 5_000, deadline_ms: 5_000 }, fallback: 'none',
});

test.each(['success', 'already-healthy', 'revoked', 'logged-out', 'wrong-device', 'gate-during-native'] as const)('T03 to T17 fixed network change: %s', async (scenario) => {
  const directory = mkdtempSync(join(tmpdir(), 'patrick-t21-settings-'));
  const databasePath = join(directory, 'ledger.sqlite');
  const credentialDirectory = join(directory, 'credentials');
  const db = openDatabase(databasePath);
  const now = () => new Date(at);
  const credentials = createCredentialStore(credentialDirectory, now);
  try {
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run('owner', 1, 1, at);
    const session = issueCallerSession(db, { accountId: 'owner', callerId: 'web', domain: 'personal', permissions: ['owner'] }, now, credentials);
    let fixed = scenario === 'already-healthy';
    if (fixed) {
      db.prepare('INSERT INTO network_device_state (device_id) VALUES (?)').run(policy.device_id);
      db.prepare('INSERT INTO network_target_blockers (device_id,target_id,mfa_question_id) VALUES (?,?,?)')
        .run(policy.device_id, 'work', 'old-mfa-request');
    }
    let revision = 'a'.repeat(64);
    let mutations = 0;
    let nativeReads = 0;
    const native = scenario === 'gate-during-native' ? createMacNetworkActuator({
      policy, localDeviceId: policy.device_id, platform: 'darwin',
      bindings: [{ repairId: 'work-dns', service: 'Fixture service', servers: ['10.0.0.54'] }],
      snapshotDirectory: join(directory, 'native-snapshots'),
      runCommand: async (_file, args) => {
        if (args[0] === '-getdnsservers') {
          nativeReads += 1;
          if (nativeReads === 3) db.prepare(`INSERT INTO recovery_domain_gates
            (data_domain,writer_epoch,status,reason,updated_at) VALUES ('personal','fixture','blocked','fixture race',?)`).run(at);
          return { stdout: fixed ? '10.0.0.54' : '10.0.0.53' };
        }
        mutations += 1;
        fixed = true;
        return { stdout: '' };
      },
    }) : undefined;
    const app = createApp({ databasePath, credentialDirectory, now, networkRepair: {
      policy, localDeviceId: 'registered-mac', accountId: 'owner', domain: 'personal',
      observe: async ({ targetIds }) => {
        if (scenario === 'revoked' && db.prepare('SELECT 1 FROM settings_changes').get()) {
          db.prepare("UPDATE caller_scopes SET revoked_at=? WHERE account_id='owner'").run(at);
        }
        if (scenario === 'logged-out' && db.prepare('SELECT 1 FROM settings_changes').get()) {
          db.prepare("DELETE FROM sessions WHERE account_id='owner'").run();
        }
        return targetIds.map((targetId) => ({ targetId, problem: targetId === 'work' && !fixed ? 'dns' as const : 'healthy' as const }));
      },
      actuator: native ?? {
        readRule: async () => revision,
        apply: async () => { mutations += 1; fixed = true; revision = 'b'.repeat(64); return { state: 'changed', revision }; },
        restore: async () => 'unknown',
      },
    } });
    const headers = { authorization: session['authorization'], origin: ORIGIN, 'content-type': 'application/json' };
    const post = (path: string, request: string, expected: number | null, payload: Json) => app.request('/api/v1' + path, {
      method: 'POST', headers, body: JSON.stringify({ client_request_id: request, expected_revision: expected,
        payload, payload_hash: createHash('sha256').update(canonicalPayload(payload)).digest('hex') }),
    });
    const draft = { operation: 'repair_network', domain: 'personal', target: scenario === 'wrong-device' ? 'other' : policy.device_id,
      input: { target_id: 'work', repair_id: 'work-dns' } };
    const validation = await post('/settings/validations', 'validate', 0, draft);
    if (scenario === 'wrong-device') {
      expect(validation.status).toBe(403);
      expect(mutations).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE json_extract(payload,'$.type')='work.requested'").get()).toEqual({ n: 0 });
      return;
    }
    expect(validation.status).toBe(200);
    const { data: proof } = await validation.json() as { data: { validation_id: string; valid: boolean } };
    expect(proof.valid).toBe(true);
    const guessed = await post('/settings/changes', 'guessed', 0, { draft, validation_id: proof.validation_id, control_receipt_id: 'guessed' });
    expect(guessed.status).toBe(403);
    const challenge = await app.request('/api/v1/auth/challenge', { method: 'POST', headers, body: JSON.stringify({ rp_id: RP_ID }) });
    expect(challenge.status).toBe(200);
    const { challenge_id } = await challenge.json() as { challenge_id: string };
    const staged = await post('/settings/control-proposals', 'stage', 0, { draft, validation_id: proof.validation_id, challenge_id });
    expect(staged.status).toBe(200);
    const { data: proposal } = await staged.json() as { data: { proposal_id: string; proposal_hash: string; base_revision: number } };
    expect(proposal.proposal_id.length).toBeGreaterThan(80);
    expect((await post('/control-proposals/' + proposal.proposal_id + '/confirm', 'confirm', proposal.base_revision,
      { proposal_hash: proposal.proposal_hash, challenge_id })).status).toBe(202);
    const { receipt_id } = db.prepare('SELECT receipt_id FROM control_receipts WHERE proposal_id=?').get(proposal.proposal_id) as { receipt_id: string };
    const applied = await post('/settings/changes', 'apply', 0, { draft, validation_id: proof.validation_id, control_receipt_id: receipt_id });
    expect(applied.status).toBe(202);
    const { command_id } = await applied.json() as { command_id: string };
    const read = async (path: string) => {
      const result = await app.request(path, { headers });
      expect(result.status).toBe(200);
      return (await result.json() as { data: unknown }).data;
    };
    if (scenario === 'success' || scenario === 'already-healthy') {
      const epoch = scenario === 'success' ? 1 : 0;
      const settings = await read('/api/v1/settings/changes/' + command_id);
      expect(settings).toMatchObject({ verified: true, applied_revision: epoch,
        effects: expect.arrayContaining([{ item: scenario === 'success' ? 'network:repaired' : 'network:already_healthy',
          outcome: scenario === 'success' ? 'applied' : 'unchanged', revision: epoch }]) });
      expect(await read('/api/v1/system/incidents/' + command_id)).toEqual(settings);
      expect((await post('/settings/changes', 'apply', 0, { draft, validation_id: proof.validation_id, control_receipt_id: receipt_id })).status).toBe(202);
      expect(mutations).toBe(epoch);
      expect(db.prepare('SELECT COUNT(*) AS n FROM network_target_blockers').get()).toEqual({ n: 0 });
      expect(await read('/api/v1/settings?domain=personal')).toMatchObject({
        groups: expect.arrayContaining([{ id: 'operation', operations: expect.arrayContaining([{
          operation: 'repair_network', registered: true, targets: [{
            target: policy.device_id, device: policy.device_id, status: 'registered', revision: epoch,
            label: 'work / work-dns', input: { target_id: 'work', repair_id: 'work-dns' },
          }],
        }]) }]),
      });
    } else {
      expect(mutations).toBe(0);
      const raw = db.prepare('SELECT receipt_json FROM network_repair_operations WHERE proposal_id=?').get(proposal.proposal_id) as { receipt_json: string };
      expect(JSON.parse(raw.receipt_json)).toMatchObject(scenario === 'gate-during-native'
        ? { state: 'unresolved', attempts: 1 } : { state: 'not_confirmed', attempts: 0 });
      if (scenario === 'gate-during-native') {
        expect(nativeReads).toBe(3);
        expect(db.prepare('SELECT lock_token FROM network_device_state').get()).toMatchObject({ lock_token: expect.any(String) });
      }
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE json_extract(payload,'$.type')='work.requested'").get()).toEqual({ n: 0 });
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
