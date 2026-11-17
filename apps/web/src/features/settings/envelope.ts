import { canonicalPayload, type Json } from '@patrick/contracts/envelope';

export async function safeEnvelope(payload: Json, expected_revision: number | null, requestId = crypto.randomUUID()) {
  const data = new TextEncoder().encode(canonicalPayload(payload));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return { client_request_id: requestId, expected_revision, payload,
    payload_hash: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('') };
}
