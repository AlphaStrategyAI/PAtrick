type Attempt = Readonly<{
  appId: string; secret: Uint8Array; openId: string; chatId: string; tenantKey: string; testId: string;
  signal: AbortSignal; authorizeOAuth: () => boolean; authorizeMessage: () => boolean;
}>;
type FixedRequest = Readonly<{
  method: 'POST'; headers: Readonly<Record<string, string>>; body: Uint8Array;
}>;
type Reply = Readonly<{
  status: number; headers: readonly (readonly [string, string])[]; body: Uint8Array;
}>;
type SyntheticTransport = (url: string, take: (preparedUrl: string) => FixedRequest | null,
  signal: AbortSignal) => Promise<Reply>;
type Result = Readonly<{ state: 'sent'; message_id: string }> | Readonly<{ state: 'unknown' }>;

const oauthUrl = 'https://accounts.feishu.cn/oauth/v3/token';
const messageUrl = 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id';
const preview = 'PAtrick 连接测试，不含业务资料。';
const unknown = Object.freeze({ state: 'unknown' } as const);

// Local byte budgets for the modeled HTTP fields, independent of provider/proxy limits.
// Feishu bearer credentials may exceed 4 KiB. The request budget includes the Bearer prefix.
const maxToken = 32 * 1024;
const maxRequestHeaders = 36 * 1024;
const maxRequestBody = 8 * 1024;
const maxReplyHeaders = 16 * 1024;
const maxReplyBody = 64 * 1024;
const deadlineMs = 10_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && Buffer.byteLength(value) <= 800
    && Boolean(value.trim()) && !/[\uD800-\uDFFF]/u.test(value);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

function request(payload: Record<string, string>, bearer?: string): FixedRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'accept-encoding': 'identity' };
  if (bearer !== undefined) headers.authorization = 'Bearer ' + bearer;
  const headerBytes = Object.entries(headers).reduce((total, [name, value]) =>
    total + Buffer.byteLength(name) + Buffer.byteLength(value) + 4, 2);
  const body = Buffer.from(JSON.stringify(payload));
  if (body.length > maxRequestBody || headerBytes > maxRequestHeaders) {
    body.fill(0);
    throw new Error('FEISHU_REQUEST_LIMIT');
  }
  return Object.freeze({ method: 'POST', headers: Object.freeze(headers), body });
}

function jsonHeaders(reply: Reply): boolean {
  if (!Array.isArray(reply.headers) || reply.headers.length > maxReplyHeaders / 4) return false;
  let bytes = 2;
  const fields = new Map<string, string>();
  for (const pair of reply.headers) {
    if (!Array.isArray(pair) || pair.length !== 2) return false;
    const [name, value] = pair;
    if (typeof name !== 'string' || typeof value !== 'string' || name.length + value.length > maxReplyHeaders) return false;
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (bytes > maxReplyHeaders || !/^[!#$%&'*+.^_|`~0-9a-z-]+$/iu.test(name) || /[\r\n\0]/u.test(value)) return false;
    const key = name.toLowerCase();
    if (['content-type', 'content-length', 'content-encoding'].includes(key)) {
      if (fields.has(key)) return false;
      fields.set(key, value.trim());
    }
  }
  const type = fields.get('content-type') ?? '';
  const length = fields.get('content-length');
  return /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/iu.test(type)
    && (fields.get('content-encoding') ?? 'identity').toLowerCase() === 'identity'
    && (length === undefined || (/^\d+$/u.test(length) && Number(length) === reply.body.byteLength));
}

function parseReply(reply: Reply): Record<string, unknown> | null {
  if (reply.status !== 200 || !(reply.body instanceof Uint8Array)
    || reply.body.byteLength > maxReplyBody || !jsonHeaders(reply)) return null;
  const value: unknown = JSON.parse(decode(reply.body));
  return record(value) && value.code === 0 ? value : null;
}

// Release the admission closure after one use or settlement, even if the transport retains take.
function finalGate(admit: (preparedUrl: string) => FixedRequest | null) {
  let remaining: typeof admit | undefined = admit;
  let granted = false;
  let repeated = false;
  return {
    take(preparedUrl: string) {
      const check = remaining;
      remaining = undefined;
      if (!check) { repeated = true; return null; }
      const wire = check(preparedUrl);
      granted = wire !== null && !repeated;
      return granted ? wire : null;
    },
    close() {
      remaining = undefined;
      return granted && !repeated;
    },
  };
}

// prepare owns each modeled resource through release. Only the one-shot gate exposes the request.
// Receiving the expected URL from a synthetic transport establishes no DNS, TLS or peer identity.
async function stage(url: string, wire: FixedRequest, authorize: () => unknown, active: () => boolean,
  signal: AbortSignal, prepare: SyntheticTransport): Promise<Record<string, unknown> | null> {
  let reply: Reply | undefined;
  const gate = finalGate((preparedUrl) => {
    if (preparedUrl !== url || !active()) return null;
    let decision: unknown;
    try { decision = authorize(); } catch { return null; }
    if (decision !== true) {
      // Unsupported async decisions fail immediately. Observe a possible rejection.
      void Promise.resolve(decision).catch(() => {});
      return null;
    }
    return active() ? wire : null;
  });
  try {
    if (!active()) return null;
    reply = await prepare(url, gate.take, signal);
    return gate.close() && !signal.aborted ? parseReply(reply) : null;
  } finally {
    gate.close();
    wire.body.fill(0);
    // A bounded response buffer transfers to this attempt when transport cleanup settles.
    if (reply?.body instanceof Uint8Array && reply.body.byteLength <= maxReplyBody) reply.body.fill(0);
  }
}

function tokenFields(value: Record<string, unknown> | null) {
  const bearer = value?.access_token;
  const seconds = value?.expires_in;
  if (!value || value.token_type !== 'Bearer' || typeof bearer !== 'string' || bearer.length > maxToken
    || !/^[A-Za-z0-9._~+/-]+=*$/u.test(bearer) || typeof seconds !== 'number'
    || !Number.isSafeInteger(seconds) || seconds <= 0 || ('scope' in value && typeof value.scope !== 'string')) return null;
  return { bearer, seconds };
}

function messageId(value: Record<string, unknown> | null, appId: string, chatId: string, tenantKey: string): string | null {
  const data = value?.data;
  if (!record(data) || ('chat_id' in data && data.chat_id !== chatId)) return null;
  if ('sender' in data) {
    const sender = data.sender;
    if (!record(sender) || ('tenant_key' in sender && sender.tenant_key !== tenantKey)) return null;
    if ('sender_type' in sender && sender.sender_type !== 'app') return null;
    if (sender.id_type === 'app_id' && 'id' in sender && sender.id !== appId) return null;
  }
  const id = data.message_id;
  return typeof id === 'string' && /^[A-Za-z0-9_:-]{1,200}$/u.test(id) ? id : null;
}

/** One offline attempt for an already claimed test. The caller owns durable admission across
 * invocations/restarts; Feishu's one-hour UUID deduplication window never authorizes repetition.
 * No native transport or production composition is provided. */
export async function attemptFeishuConnectionTest(input: Attempt, prepare: SyntheticTransport): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { appId, openId, chatId, tenantKey, testId, signal: stop, authorizeOAuth, authorizeMessage } = input;
    if (![appId, openId, chatId, tenantKey].every(identifier) || typeof testId !== 'string'
      || !/^test_[a-f0-9]{12}$/u.test(testId) || typeof authorizeOAuth !== 'function'
      || typeof authorizeMessage !== 'function' || stop.aborted) return unknown;
    const borrowed = input.secret;
    if (!(borrowed instanceof Uint8Array) || borrowed.byteLength > 4096) return unknown;
    const secret = decode(borrowed);
    if (secret.length > 1024 || !secret.trim()) return unknown;

    const started = performance.now();
    const deadline = new AbortController();
    const signal = AbortSignal.any([stop, deadline.signal]);
    const active = () => !signal.aborted && performance.now() - started < deadlineMs;
    timer = setTimeout(() => deadline.abort(), deadlineMs);
    const oauth = request({ grant_type: 'client_credentials', client_id: appId, client_secret: secret });
    const token = tokenFields(await stage(oauthUrl, oauth, authorizeOAuth, active, signal, prepare));
    if (!token) return unknown;
    const maySubmit = () => active() && (performance.now() - started) / 1000 < token.seconds;
    const message = request({ receive_id: openId, msg_type: 'text', content: JSON.stringify({ text: preview }), uuid: testId }, token.bearer);
    const reply = await stage(messageUrl, message, authorizeMessage, maySubmit, signal, prepare);
    const id = messageId(reply, appId, chatId, tenantKey);
    if (!active() || !id || id.includes(token.bearer) || id.includes(secret)) return unknown;
    return { state: 'sent', message_id: id };
  } catch {
    return unknown;
  } finally {
    clearTimeout(timer);
  }
}
