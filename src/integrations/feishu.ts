import { createHash, timingSafeEqual } from 'node:crypto';
import { AESCipher, AppType, Client, EventDispatcher, LoggerLevel, WSClient, generateChallenge } from '@larksuiteoapi/node-sdk';
import { ZodError } from 'zod';
import { DomainError, digest, now, stableId, type AppConfig, type NotificationAdapter, type OutboxMessage, type Project, type Question, type Scope } from '../domain.js';
import type { Workbench } from '../orchestrator.js';
import type { Store } from '../store.js';
import { canExport } from '../permissions.js';
import { admitOriginalOwnerDecision, clearNativeDecision, looksLikeNativeRevision } from '../cases.js';
import { knowledgeSourceRefs } from '../knowledge-records.js';

type Json = Record<string, any>;
export interface FeishuSdkClient {
  im: { message: {
    list(input: any): Promise<any>;
    create(input: any): Promise<any>;
    get?(input: any): Promise<any>;
  } };
}
interface MessageCursor { revision: string; time: number; sourceIds: string[]; watermark?: number; withdrawn?: boolean }
const silentLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
function equal(left: unknown, right: string): boolean { if (typeof left !== 'string' || !left || !right) return false; const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }

export function feishuHistoryCursor(chatId: string): string { return stableId('feishu-history', chatId); }

/** Official SDK transport with a host-owned inbox/outbox and authenticated owner mapping. */
export class FeishuChannel implements NotificationAdapter {
  readonly dispatcher: EventDispatcher;
  private readonly client: FeishuSdkClient;
  private websocket?: WSClient;
  private historyReady = false;
  private readinessReason = 'Chat history access has not been verified.';
  private sends = new Map<string, Promise<{ remoteId: string }>>();
  private catchingUp?: Promise<void>;
  private stopping = false;

  constructor(private readonly store: Store, private readonly config: AppConfig, private readonly workbench: Workbench, client?: FeishuSdkClient) {
    const f = config.feishu;
    this.client = client ?? new Client({ appId: f?.appId ?? '', appSecret: f?.appSecret ?? '', appType: AppType.SelfBuild, logger: silentLogger, loggerLevel: LoggerLevel.error });
    this.dispatcher = new EventDispatcher({ verificationToken: f?.verificationToken, encryptKey: f?.encryptKey, logger: silentLogger, loggerLevel: LoggerLevel.error });
    this.dispatcher.register({
      'im.message.receive_v1': async (event: Json) => this.receive(event),
      'im.message.recalled_v1': async (event: Json) => this.recalled(event),
      // Edits are also detected by complete history reconciliation, even when a tenant has no edit event.
      'im.message.updated_v1': async (event: Json) => this.receive(event),
    });
  }

  ready(): { ready: boolean; reason?: string } {
    if (this.stopping) return { ready: false, reason: 'The Feishu channel is shutting down.' };
    const f = this.config.feishu;
    if (!f?.appId || !f.appSecret || !f.ownerOpenId) return { ready: false, reason: 'Feishu application credentials and owner open_id are required.' };
    if (!f.chatId) return { ready: false, reason: 'A configured owner chatId and readable history are required for recovery and duplicate-send reconciliation.' };
    return this.historyReady ? { ready: true } : { ready: false, reason: this.readinessReason };
  }

  async webhook(payload: unknown, headers: Record<string, string | undefined>): Promise<unknown> {
    if (this.stopping) throw new DomainError('The Feishu channel is shutting down.', 'feishu_unready', 503);
    const f = this.requireConfiguration();
    const verificationToken = f.verificationToken;
    if (!verificationToken?.trim()) throw new DomainError('Feishu webhook verification failed.', 'feishu_verification', 403);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new DomainError('Invalid Feishu event.', 'feishu_invalid');
    const raw = payload as Json;
    let decoded = raw;
    if (f.encryptKey) {
      const timestamp = headers['x-lark-request-timestamp']; const nonce = headers['x-lark-request-nonce']; const signature = headers['x-lark-signature'];
      const time = Number(timestamp) * 1000;
      if (!timestamp || !nonce || !signature || !Number.isFinite(time) || Math.abs(Date.now() - time) > 300_000) throw new DomainError('Feishu webhook verification failed.', 'feishu_verification', 403);
      const expected = createHash('sha256').update(timestamp + nonce + f.encryptKey + JSON.stringify(raw)).digest('hex');
      if (!equal(signature, expected)) throw new DomainError('Feishu webhook verification failed.', 'feishu_verification', 403);
      if (typeof raw.encrypt !== 'string') throw new DomainError('Encrypted Feishu payload required.', 'feishu_verification', 403);
      try { decoded = JSON.parse(new AESCipher(f.encryptKey).decrypt(raw.encrypt)); } catch { throw new DomainError('Feishu webhook verification failed.', 'feishu_verification', 403); }
    }
    const token = decoded.header?.token ?? decoded.token;
    if (!equal(token, verificationToken)) throw new DomainError('Feishu webhook verification failed.', 'feishu_verification', 403);
    if (decoded.type === 'url_verification') return generateChallenge(raw, { encryptKey: f.encryptKey ?? '', verificationToken }).challenge;
    // The SDK signs only the original JSON body: headers belong on the prototype, as in adaptDefault.
    const data = Object.assign(Object.create({ headers }), raw);
    await this.dispatcher.invoke(data, { needCheck: true });
    return { code: 0 };
  }

  /** Trusted input from a verified SDK event or the application's authenticated history API. */
  async receive(raw: Json): Promise<void> {
    if (this.stopping) return;
    const event = raw.event ? { ...raw.header, ...raw.event } : raw;
    if (event.event_type === 'im.message.recalled_v1' || event.message?.deleted) return this.recalled(event);
    const f = this.requireConfiguration(); const message = event.message; const sender = event.sender;
    if (!message || sender?.sender_type !== 'user' || sender.sender_id?.open_id !== f.ownerOpenId || message.chat_id !== f.chatId || message.message_type !== 'text' || typeof message.message_id !== 'string') return;
    const text = this.text(message.content); if (text === undefined || text.includes('[PAtrick:')) return;
    const revision = digest([message.update_time ?? message.create_time, text]); const messageId = message.message_id;
    const id = stableId('feishu-receive', f.chatId, messageId, revision); const cursorId = stableId('feishu-message', f.chatId, messageId);
    const scope = this.scope(); const previous = this.messageCursor(cursorId);
    if (previous?.withdrawn || this.store.get('actions', id)?.status === 'completed') return;
    const time = Number(message.update_time ?? message.create_time) || 0;
    if (previous && (previous.watermark ?? previous.time) > time) return;
    this.store.transaction(() => {
      // A withdrawn or no longer readable source cannot prove a new semantic edit.
      // Do not recreate its evidence merely because transport metadata changed.
      if (previous?.sourceIds.some(sourceId => { const source = this.store.get('sources', sourceId); return !source || source.status !== 'active' || !source.content; })) return;
      // Legacy receipts retained the original revision, which hashes the native
      // timestamp and body. Compare both timestamp representations supported by
      // the receiver; if neither proves equality, let the edit revoke the answer.
      if (previous && this.legacyAnswerReceipt(previous, messageId) && Number.isFinite(previous.time) && [previous.time, String(previous.time)].some(originalTime => digest([originalTime, text]) === previous.revision)) {
        this.store.save('cursors', { ...scope, id: cursorId, value: JSON.stringify({ ...previous, watermark: time } satisfies MessageCursor), updatedAt: now() });
        return;
      }
      const retainedSource = previous && (this.unchangedMessageSource(previous, messageId, text, message) ?? this.unchangedAnswerSource(previous, messageId, text, message));
      if (previous && retainedSource) {
        const receivedAt = now(), directOriginal = !message.parent_id && !message.root_id;
        this.store.save('actions', { projectId: retainedSource.projectId, domain: retainedSource.domain, id, kind: 'feishu_receive', status: 'completed', payload: { messageId, chatId: f.chatId, revision, semanticRevision: previous.revision, sourceIds: previous.sourceIds, ownerId: this.config.ownerId, principal: sender.sender_id.open_id, nativeTime: time, nativeBodyHash: digest(text), directOriginal }, updatedAt: receivedAt });
        // Keep the semantic revision and its original receipt valid while advancing transport ordering.
        this.store.save('cursors', { ...scope, id: cursorId, value: JSON.stringify({ ...previous, watermark: time } satisfies MessageCursor), updatedAt: receivedAt });
        return;
      }
      this.store.save('actions', { ...scope, id, kind: 'feishu_receive', status: 'pending', payload: { messageId, chatId: f.chatId, revision }, updatedAt: now() });
      if (previous && previous.revision !== revision) for (const sourceId of previous.sourceIds) this.workbench.withdraw(sourceId);
      let sourceIds: string[] = [];
      try { sourceIds = this.route(messageId, revision, text, message); }
      catch (error) {
        if (!(error instanceof DomainError) && !(error instanceof ZodError)) throw error;
        this.reply(scope, messageId, revision, `未接纳这条指令：${error instanceof ZodError ? error.issues.map(issue => issue.message).join('；') : error.message}`);
      }
      const receivedAt = now(), directOriginal = !message.parent_id && !message.root_id;
      const receiptScope = sourceIds.length ? this.store.get('sources', sourceIds[0]!) ?? scope : scope;
      this.store.save('actions', { projectId: receiptScope.projectId, domain: receiptScope.domain, id, kind: 'feishu_receive', status: 'completed', payload: { messageId, chatId: f.chatId, revision, sourceIds, ownerId: this.config.ownerId, principal: sender.sender_id.open_id, nativeTime: time, nativeBodyHash: digest(text), directOriginal }, updatedAt: receivedAt });
      this.store.save('cursors', { ...scope, id: cursorId, value: JSON.stringify({ revision, time, sourceIds } satisfies MessageCursor), updatedAt: receivedAt });
      if (directOriginal) for (const sourceId of sourceIds) {
        const source = this.store.get('sources', sourceId), clear = source && clearNativeDecision(source.content);
        if (!source || source.kind !== 'feishu' || !clear) continue;
        const sourceRefs = knowledgeSourceRefs(this.store, source.id, source);
        if (!sourceRefs) continue;
        const binding = { schemaVersion: 1 as const, provider: 'feishu' as const, tenant: f.appId, chatId: f.chatId!, messageId, nativeRevision: revision, ownerId: this.config.ownerId, principal: sender.sender_id.open_id as string, nativeTime: time, receiveId: id, receivedAt, nativeBodyHash: digest(text), businessBodyHash: digest(source.content), source: { id: source.id, revision: source.revision }, sourceRefs, projectId: source.projectId, domain: source.domain };
        const originId = stableId('decision.owner-origin', binding.tenant, binding.chatId, binding.messageId, binding.nativeRevision, source.id), hash = digest(binding);
        this.store.save('actions', { projectId: source.projectId, domain: source.domain, id: originId, kind: 'decision.owner-origin', status: 'completed', payload: { binding, hash, sourceRefs }, updatedAt: receivedAt });
        try { admitOriginalOwnerDecision(this.store, this.config, { id: originId, hash }, { source: binding.source, quote: source.content, scopeQuote: clear.scopeQuote, declaredScope: { projectId: source.projectId, domain: source.domain } }); }
        catch (error) { if (!(error instanceof DomainError) || error.code !== 'invalid_owner_declaration' || !looksLikeNativeRevision(source.content)) throw error; }
      }
    });
  }

  private unchangedMessageSource(previous: MessageCursor, messageId: string, text: string, message: Json) {
    const f = this.config.feishu!;
    if (!Number.isFinite(previous.time) || !Array.isArray(previous.sourceIds) || previous.sourceIds.length !== 1) return;
    const source = this.store.get('sources', previous.sourceIds[0]!), receipt = this.store.get('actions', stableId('feishu-receive', f.chatId, messageId, previous.revision));
    if (!source || !receipt || receipt.kind !== 'feishu_receive' || receipt.status !== 'completed' || receipt.payload.messageId !== messageId || receipt.payload.chatId !== f.chatId || receipt.payload.revision !== previous.revision || !Array.isArray(receipt.payload.sourceIds) || digest(receipt.payload.sourceIds) !== digest(previous.sourceIds)) return;
    const command = text.match(/^\/task\s+(\S+)\s+([\s\S]+)$/), projectId = command?.[1] ?? (this.config.projects.length === 1 ? this.config.projects[0]!.id : undefined);
    if (text.startsWith('/') && !command || projectId !== source.projectId || source.kind !== 'feishu' || source.externalId !== `${f.chatId}:${messageId}` || source.authorId !== this.config.ownerId || source.revision !== previous.revision || source.status !== 'active' || source.content !== (command?.[2] ?? text) || receipt.projectId !== source.projectId || receipt.domain !== source.domain) return;
    const current = this.store.get('projects', source.projectId), configured = this.config.projects.find(project => project.id === source.projectId);
    const acceptedHash = this.store.get('cursors', stableId('source-hash', source.id))?.value;
    if (!current || !configured || current.domain !== configured.domain || current.domain !== source.domain || current.ownerId !== this.config.ownerId || !canExport(this.config, source.domain, 'feishu') || acceptedHash && acceptedHash !== digest(source.content) || !knowledgeSourceRefs(this.store, source.id, source)) return;
    const p = receipt.payload, legacy = p.nativeBodyHash === undefined && p.ownerId === undefined && p.principal === undefined && p.nativeTime === undefined && p.directOriginal === undefined;
    if (!legacy && (p.ownerId !== this.config.ownerId || p.principal !== f.ownerOpenId || p.nativeTime !== previous.time || p.nativeBodyHash !== digest(text) || p.directOriginal !== (!message.parent_id && !message.root_id))) return;
    return source;
  }

  private unchangedAnswerSource(previous: MessageCursor, messageId: string, text: string, message: Json) {
    const f = this.config.feishu!;
    if (!Number.isFinite(previous.time) || previous.sourceIds.length !== 1) return;
    const receipt = this.store.get('actions', stableId('feishu-receive', f.chatId, messageId, previous.revision));
    const p = receipt?.payload;
    if (!receipt || receipt.kind !== 'feishu_receive' || receipt.status !== 'completed' || p?.messageId !== messageId || p.chatId !== f.chatId || p.revision !== previous.revision || !Array.isArray(p.sourceIds) || digest(p.sourceIds) !== digest(previous.sourceIds) || p.ownerId !== this.config.ownerId || p.principal !== f.ownerOpenId || p.nativeTime !== previous.time || p.nativeBodyHash !== digest(text) || p.directOriginal !== (!message.parent_id && !message.root_id)) return;
    const explicit = text.match(/^\/answer\s+(\S+)\s+(\d+)\.(\d+)\s+([ABC])(?:\s+([\s\S]*))?$/i);
    const replyChoice = text.match(/^\s*([ABC])(?:\s+([\s\S]*))?\s*$/i);
    const question = explicit ? this.store.get('questions', explicit[1]!) : replyChoice ? this.questionForRemote(message.parent_id ?? message.root_id) : undefined;
    if (!question || question.status !== 'answered' || !question.answer || question.ownerId !== this.config.ownerId || question.answer.actorId !== this.config.ownerId || question.answer.eventId !== `feishu:${f.chatId}:${messageId}:${previous.revision}` || question.answer.choice !== (explicit?.[4] ?? replyChoice?.[1])?.toUpperCase() || explicit && (question.taskVersion !== Number(explicit[2]) || question.version !== Number(explicit[3]))) return;
    const source = this.store.get('sources', previous.sourceIds[0]!);
    const task = this.store.get('tasks', question.taskId), project = this.store.get('projects', question.projectId), configured = this.config.projects.find(item => item.id === question.projectId);
    const primary = task && this.store.get('sources', task.sourceId);
    const event = this.store.get('cursors', stableId('answer-event', question.projectId, question.domain, question.answer.eventId));
    if (!source || source.id !== stableId('owner-answer', question.id) || source.kind !== 'conversation' || source.status !== 'active' || source.projectId !== question.projectId || source.domain !== question.domain || source.authorId !== this.config.ownerId || source.content !== question.answer.text || source.revision !== digest(source.content) || source.locator !== `question:${question.id}@${question.version}` || !task || task.projectId !== question.projectId || task.domain !== question.domain || !primary || primary.status !== 'active' || primary.revision !== task.sourceRevision || !project || !configured || project.ownerId !== this.config.ownerId || project.domain !== question.domain || configured.domain !== question.domain || receipt.projectId !== question.projectId || receipt.domain !== question.domain || !canExport(this.config, question.domain, 'feishu') || event?.value !== digest({ questionId: question.id, choice: question.answer.choice, words: question.answer.text }) || !knowledgeSourceRefs(this.store, source.id, source)) return;
    return source;
  }

  private legacyAnswerReceipt(previous: MessageCursor, messageId: string): boolean {
    const f = this.config.feishu!;
    if (!Array.isArray(previous.sourceIds) || previous.sourceIds.length !== 1) return false;
    const receipt = this.store.get('actions', stableId('feishu-receive', f.chatId, messageId, previous.revision));
    const p = receipt?.payload;
    if (!receipt || receipt.kind !== 'feishu_receive' || receipt.status !== 'completed' || p?.messageId !== messageId || p.chatId !== f.chatId || p.revision !== previous.revision || !Array.isArray(p.sourceIds) || digest(p.sourceIds) !== digest(previous.sourceIds) || p.nativeBodyHash !== undefined || p.ownerId !== undefined || p.principal !== undefined || p.nativeTime !== undefined || p.directOriginal !== undefined) return false;
    const source = this.store.get('sources', previous.sourceIds[0]!);
    if (!source || source.kind !== 'conversation') return false;
    return this.store.list('questions').some(question => question.status === 'answered' && question.answer?.eventId === `feishu:${f.chatId}:${messageId}:${previous.revision}` && source.id === stableId('owner-answer', question.id));
  }

  async send(message: OutboxMessage): Promise<{ remoteId: string }> {
    const pending = this.sends.get(message.id); if (pending) return pending;
    if (this.stopping) throw new DomainError('The Feishu channel is shutting down.', 'feishu_unready', 503);
    const promise = this.sendOnce(message).finally(() => this.sends.delete(message.id)); this.sends.set(message.id, promise); return promise;
  }

  catchup(): Promise<void> {
    if (this.catchingUp) return this.catchingUp;
    if (this.stopping) return Promise.resolve();
    this.catchingUp = this.reconcileHistory().finally(() => { this.catchingUp = undefined; }); return this.catchingUp;
  }

  async start(): Promise<void> {
    if (this.stopping) throw new DomainError('The Feishu channel is shutting down.', 'feishu_unready', 503);
    const f = this.requireConfiguration(); await this.catchup();
    this.websocket = new WSClient({ appId: f.appId, appSecret: f.appSecret, logger: silentLogger, loggerLevel: LoggerLevel.error });
    await this.websocket.start({ eventDispatcher: this.dispatcher });
  }
  stop(): void { this.stopping = true; this.websocket?.close({ force: true }); this.websocket = undefined; }
  async shutdown(): Promise<void> {
    this.stop();
    await Promise.allSettled([...(this.catchingUp ? [this.catchingUp] : []), ...this.sends.values()]);
  }

  private route(messageId: string, revision: string, text: string, message: Json): string[] {
    // One-time private pairing is configuration, including when replayed from history.
    if (/^\s*\/pair(?:\s|$)/i.test(text)) return [];
    const f = this.config.feishu!; const internalOwner = this.config.ownerId;
    const explicit = text.match(/^\/answer\s+(\S+)\s+(\d+)\.(\d+)\s+([ABC])(?:\s+([\s\S]*))?$/i);
    const replyChoice = text.match(/^\s*([ABC])(?:\s+([\s\S]*))?\s*$/i);
    const replyQuestion = replyChoice ? this.questionForRemote(message.parent_id ?? message.root_id) : undefined;
    if (explicit || replyQuestion) {
      const questionId = explicit?.[1] ?? replyQuestion!.id;
      const question = this.store.get('questions', questionId);
      if (question) this.project(question.projectId);
      const taskVersion = explicit ? Number(explicit[2]) : replyQuestion!.taskVersion;
      const questionVersion = explicit ? Number(explicit[3]) : replyQuestion!.version;
      const choice = (explicit?.[4] ?? replyChoice![1])!.toUpperCase() as 'A' | 'B' | 'C';
      const words = explicit?.[5] ?? replyChoice?.[2];
      this.workbench.answer({ questionId, taskVersion, questionVersion, choice, text: words, actorId: internalOwner, eventId: `feishu:${f.chatId}:${messageId}:${revision}` });
      const sourceId = stableId('owner-answer', questionId);
      return this.store.get('sources', sourceId) ? [sourceId] : [];
    }
    if (text.startsWith('/answer')) throw new DomainError('用 /answer 问题编号 任务版本.问题版本 A|B|C 你的原话。');
    if (/^\/status(?:\s|$)/.test(text)) {
      const tasks = this.store.list('tasks').filter(t => canExport(this.config, t.domain, 'feishu') && this.config.projects.some(p => p.id === t.projectId && p.domain === t.domain)).slice(-20);
      this.reply(this.scope(), messageId, revision, tasks.length ? tasks.map(t => `${t.id.slice(0, 8)} · ${t.title} · ${t.status}${t.error ? ` · ${t.error}` : ''}`).join('\n') : '当前没有任务。', [...new Set(tasks.map(t=>t.sourceId))]); return [];
    }
    const lookup = text.match(/^\/lookup\s+(\S+)\s+([\s\S]+)$/);
    if (lookup) {
      const project = this.project(lookup[1]!); const cards = this.store.searchCards(lookup[2]!, project, 5);
      this.reply(project, messageId, revision, cards.length ? cards.map(c => `${c.title}\n${c.body}\n原句：${c.quote}\n${c.locator} @ ${c.sourceRevision}`).join('\n\n') : '本项目没有当前有效的匹配资料。', [...new Set(cards.map(c => c.sourceId))]); return [];
    }
    if (text.startsWith('/lookup')) throw new DomainError('用 /lookup 项目编号 查询内容。');
    const taskCommand = text.match(/^\/task\s+(\S+)\s+([\s\S]+)$/);
    if (text.startsWith('/') && !taskCommand) throw new DomainError('支持 /task、/lookup、/status 和 /answer。');
    const project = taskCommand ? this.project(taskCommand[1]!) : this.config.projects.length === 1 ? this.project(this.config.projects[0]!.id) : undefined;
    if (!project) throw new DomainError('多个项目时，请用 /task 项目编号 业务内容指定范围。');
    const content = taskCommand?.[2] ?? text;
    if (!content.trim()) throw new DomainError('业务内容不能为空。');
    const task = this.workbench.ingest({ projectId: project.id, kind: 'feishu', externalId: `${f.chatId}:${messageId}`, title: content.trim().split('\n')[0]!.slice(0, 120), content, revision, locator: `https://applink.feishu.cn/client/message/open?message_id=${encodeURIComponent(messageId)}`, authorId: internalOwner, retention: 'permanent' });
    return task ? [task.sourceId] : [];
  }

  private questionForRemote(remoteId: unknown): Question | undefined {
    if (typeof remoteId !== 'string') return undefined;
    const message = this.store.list('outbox').find(outbox => outbox.channel === 'feishu' && outbox.remoteId === remoteId);
    if (!message) return undefined;
    return this.store.list('questions').find(question => stableId('question-notice', question.id) === message.id && question.status !== 'stale');
  }

  private async recalled(event: Json): Promise<void> {
    const f = this.requireConfiguration(); const id = event.message_id ?? event.message?.message_id; const chatId = event.chat_id ?? event.message?.chat_id;
    if (typeof id !== 'string' || chatId !== f.chatId) return;
    const cursorId = stableId('feishu-message', f.chatId, id); const previous = this.messageCursor(cursorId);
    this.store.transaction(() => {
      const sourceIds = new Set([...(previous?.sourceIds ?? []), ...this.store.list('sources').filter(s => s.kind === 'feishu' && s.externalId === `${f.chatId}:${id}`).map(s => s.id)]);
      for (const sourceId of sourceIds) this.workbench.withdraw(sourceId);
      this.store.save('cursors', { ...this.scope(), id: cursorId, value: JSON.stringify({ revision: previous?.revision ?? 'withdrawn', time: Number(event.recall_time) || Date.now(), sourceIds: [...sourceIds], withdrawn: true } satisfies MessageCursor), updatedAt: now() });
    });
  }

  private async sendOnce(message: OutboxMessage): Promise<{ remoteId: string }> {
    const f = this.requireConfiguration();
    if (!canExport(this.config, message.domain, 'feishu')) throw new DomainError('This data domain is not admitted to the configured interaction channel.', 'feishu_scope', 403);
    if (message.sourceIds?.some(id => this.store.get('sources', id)?.status !== 'active')) throw new DomainError('Notification evidence is no longer available.', 'feishu_stale', 409);
    if (![f.ownerOpenId, this.config.ownerId].includes(message.recipient)) throw new DomainError('Feishu notifications may only target the configured owner.', 'feishu_recipient', 403);
    const marker = `[PAtrick:${message.id}]`; const text = `${message.text}\n\n${marker}`;
    const id = stableId('feishu-send', message.id); const fingerprint = digest({ text, chatId: f.chatId }); const existing = this.store.get('actions', id);
    if (existing && existing.payload.fingerprint !== fingerprint) throw new DomainError('An outbox identifier cannot be reused for different notification content.', 'feishu_conflict', 409);
    if (existing?.status === 'completed' && typeof existing.payload.remoteId === 'string') return { remoteId: existing.payload.remoteId };
    const matches: Json[] = []; let token: string | undefined; const seen = new Set<string>();
    do {
      const data = await this.history({ page_token: token, sort_type: 'ByCreateTimeDesc', start_time: String(Math.max(0, Math.floor(Date.parse(message.createdAt) / 1000) - 60)) });
      for (const item of data.items ?? []) {
        const body = this.text(item.body?.content);
        if (item.chat_id === f.chatId && ['app', 'bot'].includes(item.sender?.sender_type) && item.sender?.id === f.appId && body?.includes(marker)) {
          if (body !== text || typeof item.message_id !== 'string') throw new DomainError('A notification marker has conflicting remote content.', 'feishu_ambiguous', 409);
          matches.push(item);
        }
      }
      token = data.has_more ? data.page_token : undefined;
      if (data.has_more && (!token || seen.has(token))) throw new DomainError('Feishu history pagination could not be completed.', 'feishu_unready', 503);
      if (token) seen.add(token);
    } while (token);
    if (matches.length > 1) throw new DomainError('Multiple remote messages share this notification marker; reconcile them before retrying.', 'feishu_ambiguous', 409);
    this.assertOutboundCurrent(message);
    const payload = { fingerprint, uuid: stableId('feishu-uuid', message.id), marker, chatId: f.chatId };
    this.store.save('actions', { id, projectId: message.projectId, domain: message.domain, taskId: message.taskId, kind: 'feishu_send', status: 'pending', payload, updatedAt: now() });
    let remoteId = matches[0]?.message_id as string | undefined;
    if (!remoteId) {
      let result: Json;
      try { result = await this.client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: f.chatId, msg_type: 'text', content: JSON.stringify({ text }), uuid: payload.uuid } }); }
      catch { throw new DomainError('Feishu send result is unknown; the stable marker will be checked before retry.', 'feishu_unavailable', 503); }
      if (result.code !== 0 || typeof result.data?.message_id !== 'string') throw new DomainError('Feishu did not return a verified message receipt.', 'feishu_unavailable', 503);
      remoteId = result.data.message_id;
    }
    this.store.save('actions', { id, projectId: message.projectId, domain: message.domain, taskId: message.taskId, kind: 'feishu_send', status: 'completed', payload: { ...payload, remoteId }, updatedAt: now() });
    return { remoteId: remoteId! };
  }

  private assertOutboundCurrent(message: OutboxMessage): void {
    if (!canExport(this.config, message.domain, 'feishu') || message.sourceIds?.some(id => this.store.get('sources', id)?.status !== 'active')) throw new DomainError('Notification authorization or evidence changed before sending.', 'feishu_stale', 409);
    const current = this.store.get('outbox', message.id);
    if (current && (current.status !== 'pending' || current.text !== message.text || current.domain !== message.domain || current.projectId !== message.projectId || current.recipient !== message.recipient)) throw new DomainError('This notification was invalidated before sending.', 'feishu_stale', 409);
  }

  private async reconcileHistory(): Promise<void> {
    const f = this.requireConfiguration(); const snapshot = String(Math.floor(Date.now() / 1000)); let token: string | undefined; const seen = new Set<string>();
    do {
      // Scan complete history to catch edits/recalls to messages older than the creation watermark.
      const data = await this.history({ page_token: token, sort_type: 'ByCreateTimeAsc', end_time: snapshot });
      for (const item of data.items ?? []) {
        if (item.deleted) { await this.recalled(item); continue; }
        const sender = item.sender;
        await this.receive({ sender: { sender_type: sender?.sender_type, sender_id: sender?.id_type === 'open_id' ? { open_id: sender.id } : {} }, message: { ...item, message_type: item.msg_type, content: item.body?.content } });
      }
      token = data.has_more ? data.page_token : undefined;
      if (data.has_more && (!token || seen.has(token))) throw new DomainError('Feishu history pagination could not be completed.', 'feishu_unready', 503);
      if (token) seen.add(token);
    } while (token);
    this.store.save('cursors', { ...this.scope(), id: feishuHistoryCursor(f.chatId), value: snapshot, updatedAt: now() });
  }

  private async history(extra: Json): Promise<Json> {
    const f = this.requireConfiguration();
    try {
      const result = await this.client.im.message.list({ params: { container_id_type: 'chat', container_id: f.chatId, page_size: 50, ...extra } });
      if (result.code !== 0 || !result.data || !Array.isArray(result.data.items)) throw new Error('History permission or response missing.');
      this.historyReady = true; return result.data;
    } catch { this.historyReady = false; this.readinessReason = 'Feishu chat history is unavailable or not authorized; duplicate-send and offline recovery are unready.'; throw new DomainError(this.readinessReason, 'feishu_unready', 503); }
  }
  private requireConfiguration(): NonNullable<AppConfig['feishu']> & { chatId: string } {
    const f = this.config.feishu;
    if (!f?.appId || !f.appSecret || !f.ownerOpenId || !f.chatId) throw new DomainError(this.ready().reason ?? 'Feishu is not configured.', 'feishu_unready', 503);
    return f as NonNullable<AppConfig['feishu']> & { chatId: string };
  }
  private text(content: unknown): string | undefined { if (typeof content !== 'string' || content.length > 100_000) return undefined; try { const value = JSON.parse(content); return typeof value.text === 'string' && value.text.trim() ? value.text : undefined; } catch { return undefined; } }
  private messageCursor(id: string): MessageCursor | undefined { const cursor = this.store.get('cursors', id); if (!cursor) return undefined; try { return JSON.parse(cursor.value); } catch { throw new DomainError('Stored Feishu receive cursor is invalid.', 'feishu_cursor', 500); } }
  private scope(): Scope { const project = this.config.projects.find(p => canExport(this.config, p.domain, 'feishu')); return project ? { projectId: project.id, domain: project.domain } : { projectId: '_interaction', domain: 'personal' }; }
  private project(id: string): Project { const approved = this.config.projects.find(p => p.id === id); const current = this.store.get('projects', id); if (!approved || !current || current.domain !== approved.domain || current.ownerId !== this.config.ownerId || !canExport(this.config, current.domain, 'feishu')) throw new DomainError('Unknown or unauthorized project.', 'unknown_project', 404); return current; }
  private reply(scope: Scope, messageId: string, revision: string, text: string, sourceIds?: string[]): void {
    const id = stableId('feishu-command-reply', this.config.feishu?.chatId, messageId, revision);
    if (!this.store.get('outbox', id)) this.store.save('outbox', { ...scope, id, channel: 'feishu', recipient: this.config.feishu!.ownerOpenId, text, sourceIds, status: 'pending', attempts: 0, createdAt: now(), runAfter: now() });
  }
}
