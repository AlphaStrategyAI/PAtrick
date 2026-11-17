import { canonicalPayload } from '@patrick/contracts/envelope';
import { diagnosticsReportSchema, type DiagnosticsPreview } from '../../../../../packages/contracts/src/diagnostics.js';
import { ClientError } from '../../api/client.js';

const maxBytes = 4096;

export async function verifiedDiagnosticsBytes(response: Response, preview: DiagnosticsPreview, signal: AbortSignal): Promise<ArrayBuffer> {
  signal.throwIfAborted();
  if (response.status !== 200 || !response.body ||
      !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '') ||
      !/^attachment(?:\s*;|$)/iu.test(response.headers.get('content-disposition') ?? '') ||
      Number(response.headers.get('content-length')) > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    invalid();
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const buffer = new Uint8Array(maxBytes);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (length + value.length > maxBytes) { cancel(); invalid(); }
      buffer.set(value, length);
      length += value.length;
    }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ClientError) throw error;
    throw new ClientError('UNAVAILABLE', undefined, true);
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  const bytes = buffer.buffer.slice(0, length);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  signal.throwIfAborted();
  if (Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('') !== preview.manifest_hash) invalid();

  let text: string;
  let json: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    json = JSON.parse(text);
  }
  catch { invalid(); }
  const parsed = diagnosticsReportSchema.safeParse(json);
  // JSON.parse drops duplicate properties. The raw file must not contain values it hid from the schema.
  if (!parsed.success || canonicalPayload(parsed.data) !== canonicalPayload(preview.report) ||
      propertyCount(text) !== propertyCount(JSON.stringify(parsed.data))) invalid();
  return bytes;
}

export function saveDiagnosticsBytes(bytes: ArrayBuffer) {
  const anchor = document.createElement('a');
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' }));
  anchor.href = url;
  anchor.download = 'patrick-diagnostics.json';
  anchor.hidden = true;
  document.body.append(anchor);
  try { anchor.click(); }
  finally {
    anchor.remove();
    // Give the browser time to take ownership before removing the local URL.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function propertyCount(text: string): number {
  let count = 0;
  // In valid JSON, every colon outside a string belongs to an object property.
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|:/gu)) if (token === ':') count += 1;
  return count;
}

function invalid(): never { throw new ClientError('INVALID_RESPONSE'); }
