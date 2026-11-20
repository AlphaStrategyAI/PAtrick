import { createHash } from 'node:crypto';
import { canonicalPayload, type Json } from '@patrick/contracts';
import type { Hono } from 'hono';
import { ORIGIN, RP_ID } from '../../apps/service/src/auth.js';

const hash = (value: Json) => createHash('sha256').update(canonicalPayload(value)).digest('hex');

export type SettingsChange = {
  authorization: string; draft: Json; id: string; expectedRevision?: number | null;
};

export type SettingsChangeResult = {
  validation: Response; staged?: Response; confirmed?: Response; applied?: Response; receipt?: Response;
};

/** Runs one trusted settings change: validate, prove, confirm, apply.
 *
 * The steps are the ones the browser runs, so a test proves the same flow an
 * owner goes through.
 */
export async function applySettingsChange(app: Hono, options: SettingsChange): Promise<SettingsChangeResult> {
  const { authorization, draft, id, expectedRevision = null } = options;
  const origin = ORIGIN;
  const post = (path: string, payload: Json, clientRequestId: string, expected: number | null) =>
    app.request('/api/v1' + path, { method: 'POST', headers: { authorization, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ payload, payload_hash: hash(payload), client_request_id: clientRequestId, expected_revision: expected }) });
  const validation = await post('/settings/validations', draft, `validate-${id}`, expectedRevision);
  if (validation.status !== 200) return { validation };
  const { data: { validation_id } } = await validation.json() as { data: { validation_id: string } };
  const challenge = await app.request('/api/v1/auth/challenge', { method: 'POST',
    headers: { authorization, origin, 'content-type': 'application/json' }, body: JSON.stringify({ rp_id: RP_ID }) });
  const { challenge_id } = await challenge.json() as { challenge_id: string };
  const staged = await post('/settings/control-proposals', { draft, validation_id, challenge_id }, `prepare-${id}`, expectedRevision);
  if (staged.status !== 200) return { validation, staged };
  const { data: { proposal_id, proposal_hash, base_revision } } = await staged.json() as
    { data: { proposal_id: string; proposal_hash: string; base_revision: number } };
  const confirmed = await app.request(`/api/v1/control-proposals/${proposal_id}/confirm`, { method: 'POST',
    headers: { authorization, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ payload: { proposal_hash, challenge_id }, payload_hash: hash({ proposal_hash, challenge_id }),
      client_request_id: `confirm-${id}`, expected_revision: base_revision }) });
  if (confirmed.status !== 202) return { validation, staged, confirmed };
  const accepted = await confirmed.json() as { receipt_url: string };
  const control = await app.request(accepted.receipt_url, { headers: { authorization } });
  const { data: { control_receipt_id } } = await control.json() as { data: { control_receipt_id: string } };
  const applied = await post('/settings/changes', { draft, validation_id, control_receipt_id }, `apply-${id}`, expectedRevision);
  if (applied.status !== 202) return { validation, staged, confirmed, applied };
  const receiptUrl = (await applied.clone().json() as { receipt_url: string }).receipt_url;
  const receipt = await app.request(receiptUrl, { headers: { authorization } });
  return { validation, staged, confirmed, applied, receipt };
}

/** Stages the app secret and configures the Feishu connection with it.
 *
 * The credential endpoint only holds the secret; the connection itself is
 * created by the trusted change, exactly like the browser does it.
 */
export async function configureFeishuConnection(app: Hono, options: {
  authorization: string; appId: string; appSecret: string; id: string; domain?: string; credentialOrigin?: string;
}): Promise<SettingsChangeResult & { stagedCredential?: Response }> {
  const { authorization, appId, appSecret, id, domain = 'personal', credentialOrigin = 'https://localhost' } = options;
  const staged = await app.request(`${credentialOrigin}/api/v1/channels/feishu/credentials`, { method: 'POST',
    headers: { authorization, origin: credentialOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }) });
  if (staged.status !== 200) return { validation: staged, stagedCredential: staged };
  const { credential_ref } = await staged.json() as { credential_ref: string };
  const draft: Json = { operation: 'set_feishu_connection', domain, target: appId,
    input: { credential_ref, app_id: appId } };
  return { ...(await applySettingsChange(app, { authorization, draft, id })), stagedCredential: staged };
}
