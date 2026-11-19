import { z } from 'zod';
import { diagnosticsExportRequest, diagnosticsPreviewRequest, diagnosticsPreviewSchema, diagnosticsReportSchema } from './diagnostics.js';
import { statsSnapshotSchema } from './stats.js';
import {
  ALLOWED_SCHEMA_MAJORS,
  commandAcceptedSchema,
  commandEnvelope,
  errorBodySchema,
  PAGE_DEFAULT,
  PAGE_MAX,
  scopeSchema,
  snapshotEnvelope,
  sseEventSchema,
} from './envelope.js';

export const HTTP_ERROR_STATUS = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_STALE: 409,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
} as const;

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type RouteDefinition = {
  operationId: string;
  method: HttpMethod;
  path: string;
  permission: string;
  scopePermissions?: readonly string[];
  kind: 'read' | 'write';
  request: z.ZodType;
  response: z.ZodType;
  responseMediaType?: 'text/event-stream';
  errors: readonly string[];
};

export type SdkMethod = {
  operationId: string;
  method: HttpMethod;
  path: string;
  permission: string;
  scopePermissions?: readonly string[];
  errors: string[];
};

export type OpenApiDocument = {
  openapi: '3.1.0';
  info: { title: string; version: string; 'x-allowed-schema-majors': number[] };
  paths: Record<string, Record<string, { operationId: string }>>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
};

const readErrors = ['UNAUTHENTICATED', 'FORBIDDEN'] as const;
const writeErrors = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'CONFLICT',
  'UNPROCESSABLE',
  'RATE_LIMITED',
  'UNAVAILABLE',
] as const;
export const emptySchema = z.strictObject({});
const idSchema = z.strictObject({ id: z.string().min(1) });
const listDataSchema = z.strictObject({ items: z.array(z.unknown()) });
const pageQuerySchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
});
// These resource-free commands cannot infer the active tab's scope from a path resource.
export const browserCreationScopeSchema = scopeSchema.extend({ caller_id: z.string().min(1) });
export type BrowserCreationScope = z.infer<typeof browserCreationScopeSchema>;
const domainSchema = z.strictObject({ domain: z.string().min(1).optional() });
const noticeCount = z.number().int().nonnegative();
export const notificationSummarySchema = z.strictObject({
  pending: noticeCount, quiet: noticeCount, digest: noticeCount, checking: noticeCount, retrying: noticeCount, blocked: noticeCount,
});
export const notificationPreviewSchema = z.strictObject({
  decision: noticeCount, blocker: noticeCount, delivered: noticeCount, progress: noticeCount,
});
const feishuTestSendPayload = z.strictObject({
  test_id: z.string().min(1), preview_hash: z.string().min(1), destination: z.string().min(1),
});
const scopedIdSchema = idSchema.extend(domainSchema.shape);
const learningPageQuery = pageQuerySchema.extend(domainSchema.shape);
export const detectHttpSourcePayload = z.strictObject({
  type: z.enum(['rss', 'webpage']), target: z.string().min(1).max(2048), request_scope: browserCreationScopeSchema,
});
export const sourceEntrySchema = z.strictObject({
  source_id: z.string().min(1), connector_type: z.enum(['github', 'directory', 'rss', 'webpage']),
  normalized_target: z.string().min(1), frequency: z.string().min(1),
  config_revision: z.number().int().positive(), status: z.string().min(1), updated_at: z.iso.datetime(),
});
export const sourceReaderCapabilitiesSchema = z.strictObject({
  directory: z.strictObject({ state: z.literal('blocked'), reason: z.literal('DIRECTORY_READER_UNAVAILABLE') }),
});
export const sourcePreviewSchema = z.strictObject({
  preview_id: z.string().min(1), target: z.string().min(1), type: detectHttpSourcePayload.shape.type,
  duplicate_source_id: z.string().min(1).nullable(), draft_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  allowed_urls: z.array(z.string().min(1).max(2048)).min(1).max(32),
  samples: z.array(z.strictObject({ locator: z.string().min(1), byteLength: z.number().int().nonnegative() })).max(8),
  expires_at: z.iso.datetime(),
});
export const sourceReceiptSchema = z.strictObject({
  event_id: z.string().min(1), config_revision: z.number().int().positive(), kind: z.string().min(1),
  cursor: z.string(), object_count: z.number().int().nonnegative(), observed_at: z.iso.datetime(),
  accepted: z.boolean(), reason: z.string().nullable(),
});
export const rssHistoryPreviewPayload = z.strictObject({
  from: z.string().min(1).max(36), until: z.string().min(1).max(36),
  max_objects: z.number().int().min(1).max(500), max_bytes: z.number().int().min(1).max(4 * 1024 * 1024),
  request_scope: browserCreationScopeSchema,
});
const historyCount = z.number().int().nonnegative();
const historyHash = z.string().regex(/^[a-f0-9]{64}$/u);
export const rssHistoryViewSchema = z.strictObject({
  plan_id: z.string().min(1), source_id: z.string().min(1), config_revision: z.number().int().positive(),
  plan_hash: historyHash, response_hash: historyHash, expires_at: z.iso.datetime(),
  target: z.string().min(1), response_url: z.string().min(1),
  range: z.strictObject({ from: z.iso.datetime(), until: z.iso.datetime() }),
  budget: z.strictObject({ max_objects: rssHistoryPreviewPayload.shape.max_objects, max_bytes: rssHistoryPreviewPayload.shape.max_bytes }),
  cost: z.strictObject({
    evidence_bytes: historyCount, eligible_objects: historyCount, eligible_bytes: historyCount, selected_objects: historyCount,
    selected_bytes: historyCount, total_bytes: historyCount, omitted_objects: historyCount, unknown_date_objects: historyCount,
    outside_range_objects: historyCount, additional_network_requests: z.literal(0), coverage: z.literal('feed_snapshot_only'),
  }),
  state: z.enum(['pending', 'expired', 'stale', 'applied']),
  receipt: z.strictObject({
    receipt_id: z.string().min(1), applied_at: z.iso.datetime(), selected_objects: historyCount,
    imported_objects: historyCount, existing_objects: historyCount,
  }).nullable(),
}).refine(({ range, budget, cost, state, receipt }) =>
  range.from < range.until &&
  cost.selected_objects <= budget.max_objects && cost.total_bytes <= budget.max_bytes &&
  cost.total_bytes === cost.evidence_bytes + cost.selected_bytes && cost.selected_bytes <= cost.eligible_bytes &&
  cost.eligible_objects === cost.selected_objects + cost.omitted_objects &&
  (state === 'applied' ? receipt !== null && receipt.selected_objects === cost.selected_objects &&
    receipt.imported_objects + receipt.existing_objects === receipt.selected_objects : receipt === null),
{ message: 'Invalid frozen history plan costs or receipt' });
const editTargetSchema = z.strictObject({
  vault_id: z.string().min(1), document_id: z.string().min(1), observed_seq: z.number().int().nonnegative(),
  relative_path: z.string().min(1), obsidian_uri: z.string().optional(),
});
const workListQuerySchema = pageQuerySchema.extend({ ...domainSchema.shape,
  state: z.enum(['open', 'awaiting_answer', 'blocked', 'delivered', 'all']).default('open') });
const workItemSchema = z.strictObject({
  work_id: z.string().min(1), generation: z.number().int().nonnegative(), updated_at: z.string().min(1),
  state: z.enum(['researching', 'awaiting_answer', 'verifying', 'paused', 'blocked', 'delivered']),
  attempt_ids: z.array(z.number().int().positive()), question_id: z.string().nullable(), delivery_id: z.string().nullable(),
  revision: z.number().int().positive(),
});
const workListSchema = z.strictObject({ items: z.array(workItemSchema), next_cursor: z.string().nullable(),
  counts: z.strictObject({ open: z.number().int().nonnegative(), awaiting_answer: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative() }) });
const workTimelineSchema = z.strictObject({ items: z.array(z.strictObject({ event_id: z.string().min(1),
  type: z.string().min(1), at: z.string().min(1) })) });

export const vaultConnectionStatusSchema = z.enum([
  'not_connected',
  'checking',
  'needs_install',
  'needs_permission',
  'awaiting_confirmation',
  'connected',
  'degraded',
]);

export const vaultFacetStatusSchema = z.enum(['ready', 'missing', 'stopped', 'unknown']);

export const vaultConnectionSchema = z.strictObject({
  status: vaultConnectionStatusSchema,
  vault_id: z.string().min(1),
  source_id: z.string().min(1),
  config_revision: z.number().int().nonnegative(),
  scope_hash: z.string().min(1),
  root_identity: z.string().min(1),
  capture_host: z.string().min(1),
  client_mapping_revision: z.number().int().nonnegative(),
  editor_status: vaultFacetStatusSchema,
  collection_status: vaultFacetStatusSchema,
  projection_status: vaultFacetStatusSchema,
});

export const editFileStateSchema = z.enum([
  'preparing',
  'awaiting_save',
  'collected',
  'invalid',
  'conflict',
]);

export const editBusinessStateSchema = z.enum([
  'not_started',
  'pending',
  'verifying',
  'evaluating',
  'adopted',
  'not_adopted',
  'stale',
]);

export const editProjectionStateSchema = z.enum([
  'not_due',
  'pending',
  'current',
  'failed',
  'cleanup_pending',
  'superseded',
]);

export const editReceiptSchema = z.strictObject({
  edit_id: z.string().min(1),
  receipt_revision: z.number().int().nonnegative(),
  file: z.strictObject({
    state: editFileStateSchema,
    proof_ref: z.string().nullable(),
  }),
  business: z.strictObject({
    state: editBusinessStateSchema,
    candidate_id: z.string().nullable(),
    result_ref: z.string().nullable(),
  }),
  projection: z.strictObject({
    state: editProjectionStateSchema,
    intent_id: z.string().nullable(),
    projection_revision: z.number().int().nonnegative().nullable(),
    superseded_by: z.string().nullable(),
  }),
});

export const editIntentRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('edit_original'),
    vault_id: z.string().min(1).optional(),
    knowledge_id: z.string().min(1),
    document_id: z.string().min(1),
    expected_source_revision: z.number().int().nonnegative(),
  }),
  z.strictObject({
    operation: z.literal('supplement_knowledge'),
    vault_id: z.string().min(1).optional(),
    knowledge_id: z.string().min(1),
    expected_knowledge_revision: z.number().int().nonnegative(),
    draft_key: z.string().min(1),
  }),
  z.strictObject({
    operation: z.literal('create_standard'),
    vault_id: z.string().min(1).optional(),
    draft_key: z.string().min(1),
    expected_active_version: z.null(),
  }),
  z.strictObject({
    operation: z.literal('revise_standard'),
    vault_id: z.string().min(1).optional(),
    standard_id: z.string().min(1),
    base_version: z.number().int().nonnegative(),
    draft_key: z.string().min(1),
  }),
]);

export const feishuConnectionStatusSchema = z.enum([
  'not_configured',
  'checking',
  'needs_binding',
  'needs_test',
  'needs_enable',
  'ready',
  'degraded',
  'draining',
  'disabled',
  'requires_reauthorization',
]);

export const feishuTransportModeSchema = z.enum(['probe', 'active', 'draining', 'disabled']);

export const feishuConnectionSchema = z.strictObject({
  status: feishuConnectionStatusSchema,
  reason_code: z.string().nullable(),
  transport_mode: feishuTransportModeSchema,
});

export const channelTestStatusSchema = z.enum([
  'previewed',
  'sending',
  'sent',
  'verified',
  'unknown',
  'expired',
]);

export const channelTestSchema = z.strictObject({
  test_id: z.string().min(1),
  status: channelTestStatusSchema,
  preview_hash: z.string().min(1),
  destination: z.string().min(1),
  message_id: z.string().nullable(),
  inbound_evidence: z.string().nullable(),
  app_id: z.string().min(1),
  tenant_key: z.string().min(1),
  config_revision: z.number().int().nonnegative(),
  credential_version: z.number().int().nonnegative(),
  binding_id: z.string().min(1),
  data_domain: z.string().min(1),
  incarnation: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
});

export const healthSnapshotSchema = z.strictObject({
  service: z.enum(['running', 'paused', 'unknown']),
  freshness: z.enum(['fresh', 'stale', 'unknown']),
  impact: z.string(),
  next_step: z.string().nullable(),
  as_of: z.string().min(1),
  connections: z.strictObject({
    vault: z.strictObject({ status: z.string(), revision: z.number().int().nonnegative(), epoch: z.number().int().nonnegative() }).nullable(),
    feishu: z.strictObject({ status: z.string(), revision: z.number().int().nonnegative(), epoch: z.number().int().nonnegative() }).nullable(),
  }).optional(),
  edits: z.strictObject({ pending: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }).optional(),
});

export const workControlActionSchema = z.enum(['pause','resume','stop']);
const workControlStateSchema = z.enum(['running','paused','processing','stopped']);
export const workControlViewSchema = z.strictObject({
  work_id: z.string().min(1), generation: z.number().int().nonnegative(), control_revision: z.number().int().nonnegative(),
  state: workControlStateSchema, actions: z.array(workControlActionSchema),
});
export const workControlReceiptSchema = z.strictObject({
  receipt_id: z.string().min(1), work_id: z.string().min(1), generation: z.number().int().nonnegative(),
  type: workControlActionSchema, state: workControlStateSchema.or(z.literal('denied')), revision: z.number().int().nonnegative(),
});
const workControlPayload = z.strictObject({
  type: z.enum(['pause', 'resume', 'stop']),
  generation: z.number().int().nonnegative(),
});

const answerPayload = z.strictObject({
  work_id: z.string().min(1),
  generation: z.number().int().nonnegative(),
  question_id: z.string().min(1),
  question_version: z.number().int().nonnegative(),
  proposal_revision: z.number().int().nonnegative(),
  options_hash: z.string().regex(/^[a-f0-9]{64}$/),
  answer: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('option'), option_id: z.string().min(1) }),
    z.strictObject({ kind: z.literal('custom'), raw_text: z.string() }),
  ]),
});

export const preferencePayload = z.strictObject({
  mode: z.enum(['system', 'en', 'zh']).optional(),
  reduced_motion: z.boolean().optional(),
  notifications: z.enum(['necessary', 'all']).optional(),
  quiet_hours: z.strictObject({
    start: z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u),
    end: z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u),
  }).nullable().optional(),
});

export const storedPreferences = preferencePayload.required().extend({ revision: z.number().int().nonnegative() });
export const preferencePatchRequest = commandEnvelope(z.strictObject({
  account_id: z.string().min(1), auth_epoch: z.number().int().nonnegative(),
  changes: preferencePayload.refine((value) => Object.keys(value).length > 0),
}));

export const settingsDraftSchema = z.strictObject({
  operation: z.string().min(1).max(80),
  domain: z.string().min(1).max(160),
  target: z.string().min(1).max(160),
  input: z.json(),
});
export const settingsChangePayload = z.strictObject({
  draft: settingsDraftSchema,
  validation_id: z.string().min(1).max(160),
  control_receipt_id: z.string().min(1).max(160),
});
export const settingsControlPayload = z.strictObject({
  draft: settingsDraftSchema,
  validation_id: z.string().min(1).max(160),
  challenge_id: z.string().min(1).max(160),
});
export const settingsControlSchema = z.strictObject({
  proposal_id: z.string().min(1), proposal_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  base_revision: z.number().int().nonnegative(), object_revision: z.number().int().nonnegative(), expires_at: z.iso.datetime(),
});
export const delegationFields = z.strictObject({
  type_id: z.string().min(1).max(160),
  actions: z.array(z.string().min(1).max(160)).max(100),
  resources: z.array(z.string().min(1).max(160)).max(100),
  effects: z.array(z.string().min(1).max(160)).max(100),
  domains: z.array(z.string().min(1).max(160)).min(1).max(25),
  risk: z.string().min(1).max(100),
  level: z.enum(['L0', 'L1', 'L2', 'L3']),
  budget_micros: z.number().int().nonnegative(),
  expires_at: z.iso.datetime(),
});
const delegationId = z.string().min(1).max(160);
const delegationStatus = z.enum(['active', 'paused', 'stopped']);
const delegationAction = z.enum(['pause', 'resume', 'stop']);
export const delegationProposalRequest = commandEnvelope(delegationFields.extend({ challenge_id: delegationId }));
export const delegationControlRequest = commandEnvelope(z.strictObject({ type: delegationAction, challenge_id: delegationId }));
export const delegationApplyRequest = commandEnvelope(z.strictObject({ control_receipt_id: delegationId }));
export const delegationProposalSchema = z.strictObject({
  proposal_id: delegationId, mandate_id: delegationId, base_revision: z.number().int().nonnegative(),
  proposal_hash: z.string().regex(/^[a-f0-9]{64}$/u), expires_at: z.iso.datetime(),
  mandate_revision: z.number().int().nonnegative().nullable(), before: delegationStatus.nullable(),
  change: z.union([z.strictObject({ action: z.literal('create'), scope: delegationFields }),
    z.strictObject({ action: delegationAction })]),
  state: z.enum(['staged', 'expired', 'applied']),
  result: z.strictObject({ status: delegationStatus, revision: z.number().int().nonnegative(),
    control_receipt_id: delegationId, applied_at: z.iso.datetime() }).nullable(),
});
export const settingsValidationSchema = z.strictObject({
  validation_id: z.string().min(1), draft_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  base_revision: z.number().int().nonnegative(), device_id: z.string().min(1),
  identity_id: z.string().min(1), scope_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  valid: z.boolean(), checked_at: z.iso.datetime(), expires_at: z.iso.datetime(),
});
export const settingsReceiptSchema = z.strictObject({
  change_id: z.string().min(1), validation_id: z.string().min(1), operation: z.string().min(1), target_id: z.string().min(1),
  phase: z.enum(['applying','applied','observed','uncertain']), applied_revision: z.number().int().nonnegative().nullable(),
  verified: z.boolean(), checked_at: z.iso.datetime().nullable(), issues: z.array(z.string()),
  effects: z.array(z.strictObject({ item: z.string(), outcome: z.enum(['applied','unchanged','blocked','uncertain']),
    revision: z.number().int().nonnegative().nullable() })),
});

const settingsTargetSchema = z.strictObject({
  label: z.string().min(1).optional(), input: z.json().optional(),
  target: z.string().min(1), device: z.string().min(1).nullable(), status: z.string().min(1), revision: z.number().int().nonnegative(),
});
export const settingsRecoveryOfferSchema = z.discriminatedUnion('status', [
  z.strictObject({ change_id: z.string().min(1), status: z.literal('unavailable'), reason: z.string().min(1) }),
  ...(['readback_available', 'projection_available'] as const).map((status) => z.strictObject({
    change_id: z.string().min(1), action: z.enum(['reconcile_network', 'readback_recovery_backup', 'readback_recovery_drill']), status: z.literal(status),
    target: z.strictObject({ label: z.string().min(1), target: z.string().min(1), device: z.string().min(1),
      revision: z.number().int().nonnegative(), input: z.strictObject({ change_id: z.string().min(1) }) }),
  })),
]);
export const settingsRecoveryReceiptSchema = z.strictObject({
  recovery_command_id: z.string().min(1), receipt: settingsReceiptSchema,
});
export const settingsDashboardSchema = z.strictObject({ groups: z.array(z.strictObject({
  id: z.string(), operations: z.array(z.strictObject({
    operation: z.string(), registered: z.boolean(), kind: z.enum(['change', 'inspect']),
    /** Where the entry comes from: found here, suggested, chosen by the owner, or inherited from the host. */
    origin: z.enum(['detected', 'suggested', 'user', 'inherited']),
    targets: z.array(settingsTargetSchema),
  })),
})) });
export const settingsInspectionSchema = z.strictObject({
  records: z.array(z.strictObject({ target: z.string().min(1).max(160), observed: z.string().min(1).max(2048) })).max(64),
});

const statsQuerySchema = z.strictObject({
  ...domainSchema.shape,
  period: z.enum(['7d', '30d', 'all']),
  timezone: z.string().min(1),
});

function read(
  operationId: string,
  path: string,
  permission: string,
  request: z.ZodType,
  data: z.ZodType,
): RouteDefinition {
  return {
    operationId,
    method: 'GET',
    path,
    permission,
    kind: 'read',
    request,
    response: snapshotEnvelope(data),
    errors: readErrors,
  };
}

function command(
  operationId: string,
  path: string,
  permission: string,
  payload: z.ZodType,
  method: 'POST' | 'PATCH' = 'POST',
): RouteDefinition {
  return {
    operationId,
    method,
    path,
    permission,
    kind: 'write',
    request: commandEnvelope(payload),
    response: commandAcceptedSchema,
    errors: writeErrors,
  };
}

function write(
  operationId: string,
  method: HttpMethod,
  path: string,
  permission: string,
  request: z.ZodType,
  response: z.ZodType,
  errors: readonly string[] = writeErrors,
): RouteDefinition {
  return { operationId, method, path, permission, kind: 'write', request, response, errors };
}

export const routes: RouteDefinition[] = [
  write('createAuthChallenge', 'POST', '/auth/challenge', 'public', z.strictObject({ rp_id: z.string().min(1) }), z.strictObject({ challenge_id: z.string().min(1), challenge: z.unknown() }), []),
  write('verifyAuth', 'POST', '/auth/verify', 'public', z.strictObject({ challenge_id: z.string().min(1), credential: z.unknown() }), z.strictObject({ session: z.unknown() }), ['UNAUTHENTICATED']),
  read('getSession', '/session', 'session', emptySchema, z.unknown()),
  write('deleteSession', 'DELETE', '/session', 'session', emptySchema, z.strictObject({ ok: z.literal(true) }), readErrors),
  { ...read('listWork', '/work', 'work.read', workListQuerySchema, workListSchema), errors: [...readErrors, 'CONFLICT', 'UNPROCESSABLE'] },
  read('getWork', '/work/:id', 'work.read', scopedIdSchema, workItemSchema),
  read('getWorkTimeline', '/work/:id/timeline', 'work.read', scopedIdSchema, workTimelineSchema),
  read('getWorkControl', '/work/:id/controls', 'work.read', scopedIdSchema, workControlViewSchema),
  read('getWorkControlReceipt', '/work/:id/controls/:receiptId', 'work.control',
    scopedIdSchema.extend({ receiptId: z.string().min(1) }), workControlReceiptSchema),
  command('controlWork', '/work/:id/controls', 'work.control', workControlPayload),
  read('getQuestion', '/questions/:id', 'questions.read', idSchema, z.unknown()),
  command('submitAnswer', '/questions/:id/answers', 'questions.answer', answerPayload),
  read('getAnswerReceipt', '/answers/:receiptId', 'questions.read', z.strictObject({ receiptId: z.string().min(1) }), z.unknown()),
  read('listConversations', '/conversations', 'conversations.read', pageQuerySchema, listDataSchema),
  command('createConversation', '/conversations', 'conversations.write',
    z.strictObject({ text: z.string().min(1), request_scope: browserCreationScopeSchema })),
  read('listMessages', '/conversations/:id/messages', 'conversations.read', idSchema, listDataSchema),
  command('postMessage', '/conversations/:id/messages', 'conversations.write', z.strictObject({ text: z.string().min(1) })),
  command('linkConversationWork', '/conversations/:id/work-links', 'conversations.write', z.strictObject({ work_id: z.string().min(1) })),
  command('createConsultation', '/consultations', 'consultations.write',
    z.strictObject({ text: z.string().min(1), parent_work_id: z.string().min(1).nullable(), request_scope: browserCreationScopeSchema })),
  read('getConsultation', '/consultations/:id', 'consultations.read', idSchema, z.unknown()),
  command('cancelConsultation', '/consultations/:id/cancel', 'consultations.write', emptySchema),
  read('listKnowledge', '/knowledge', 'knowledge.read', learningPageQuery.extend({ q: z.string().min(1).max(160).optional() }), listDataSchema),
  read('getKnowledge', '/knowledge/:id', 'knowledge.read', scopedIdSchema, z.unknown()),
  read('getKnowledgeEvidence', '/knowledge/:id/evidence', 'knowledge.read', scopedIdSchema, listDataSchema),
  read('getSourceRevision', '/sources/:id/revisions/:rev', 'sources.read', scopedIdSchema.extend({ rev: z.string().min(1) }), z.unknown()),
  read('listVaults', '/vaults', 'vault.read', pageQuerySchema, listDataSchema),
  read('getVaultConnection', '/vaults/:id/connection', 'vault.read', idSchema, vaultConnectionSchema),
  command('inspectVaults', '/vaults/inspections', 'vault.inspect', z.strictObject({ device_id: z.string().min(1), vault_id: z.string().min(1) })),
  command('validateVaults', '/vaults/validations', 'vault.inspect', z.strictObject({ device_id: z.string().min(1), vault_id: z.string().min(1) })),
  { ...read('getKnowledgeEditTarget', '/knowledge/:id/edit-target', 'edits.read', scopedIdSchema.extend({ document: z.string().min(1).optional() }), editTargetSchema), errors: [...readErrors, 'CONFLICT'] },
  { ...read('getStandardEditTarget', '/standards/:id/edit-target', 'edits.read', scopedIdSchema, editTargetSchema), errors: [...readErrors, 'CONFLICT'] },
  read('getEditDestination', '/edits/:id/destination', 'edits.read', scopedIdSchema, editTargetSchema),
  command('createEdit', '/edits', 'edits.write', editIntentRequestSchema),
  read('getEdit', '/edits/:id', 'edits.read', scopedIdSchema, editReceiptSchema),
  command('checkEdit', '/edits/:id/checks', 'edits.write', emptySchema),
  command('retryEditProjection', '/edits/:id/projection-retries', 'edits.write', z.strictObject({
    expected_revision: z.number().int().nonnegative(), intent_id: z.string().min(1), projection_revision: z.number().int().nonnegative(),
  })),
  read('listStandards', '/standards', 'standards.read', learningPageQuery, listDataSchema),
  read('listStandardVersions', '/standards/:id/versions', 'standards.read', scopedIdSchema, listDataSchema.extend({ candidates: z.array(z.unknown()) })),
  read('getEvaluation', '/evaluations/:id', 'standards.read', scopedIdSchema, z.unknown()),
  command('createStandardCandidate', '/standard-candidates', 'standards.write', z.strictObject({ standard_id: z.string().min(1).nullable(), draft_key: z.string().min(1) })),
  command('evaluateStandardCandidate', '/standard-candidates/:id/evaluations', 'standards.write', z.strictObject({ dataset_id: z.string().min(1) })),
  command('adoptStandardCandidate', '/standard-candidates/:id/adoptions', 'owner', z.strictObject({ report_id: z.string().min(1) })),
  read('listDelegations', '/delegations', 'delegations.read', learningPageQuery, listDataSchema),
  read('getDelegation', '/delegations/:id', 'delegations.read', scopedIdSchema, z.unknown()),
  write('createDelegationProposal', 'POST', '/delegation-proposals', 'owner', delegationProposalRequest, commandAcceptedSchema),
  read('getDelegationProposal', '/delegation-proposals/:id', 'owner', scopedIdSchema, delegationProposalSchema),
  write('controlDelegation', 'POST', '/delegations/:id/controls', 'owner', delegationControlRequest, commandAcceptedSchema),
  write('applyDelegationProposal', 'POST', '/delegation-proposals/:id/apply', 'owner', delegationApplyRequest, commandAcceptedSchema),
  { ...read('listSources', '/sources', 'sources.read', learningPageQuery,
    z.strictObject({ items: z.array(sourceEntrySchema), next_cursor: z.string().nullable() })),
  errors: [...readErrors, 'UNPROCESSABLE'] },
  read('getSource', '/sources/:id', 'sources.read', scopedIdSchema, sourceEntrySchema),
  read('getSourceReaderCapabilities', '/source-reader-capabilities', 'sources.read', domainSchema, sourceReaderCapabilitiesSchema),
  read('getSourceReceipts', '/sources/:id/receipts', 'sources.read', scopedIdSchema,
    z.strictObject({ items: z.array(sourceReceiptSchema) })),
  write('detectSources', 'POST', '/sources/detect', 'sources.detect', commandEnvelope(detectHttpSourcePayload),
    snapshotEnvelope(sourcePreviewSchema)),
  write('previewRssHistory', 'POST', '/sources/:id/history/preview', 'owner',
    commandEnvelope(rssHistoryPreviewPayload).extend({ expected_revision: z.number().int().positive() }),
    snapshotEnvelope(rssHistoryViewSchema), [...writeErrors, 'VALIDATION_STALE']),
  { ...read('getRssHistory', '/sources/:id/history/:planId', 'sources.read',
    scopedIdSchema.extend({ planId: z.string().min(1) }), rssHistoryViewSchema),
  errors: [...readErrors, 'NOT_FOUND', 'UNPROCESSABLE', 'VALIDATION_STALE'] },
  read('getSettings', '/settings', 'settings.read', domainSchema, settingsDashboardSchema),
  write('inspectSettings', 'POST', '/settings/inspections', 'settings.inspect',
    commandEnvelope(emptySchema), snapshotEnvelope(settingsInspectionSchema)),
  write('validateSettings', 'POST', '/settings/validations', 'settings.validate', commandEnvelope(settingsDraftSchema),
    snapshotEnvelope(settingsValidationSchema), [...writeErrors, 'VALIDATION_STALE']),
  write('prepareSettingsControl', 'POST', '/settings/control-proposals', 'owner', commandEnvelope(settingsControlPayload),
    snapshotEnvelope(settingsControlSchema), [...writeErrors, 'VALIDATION_STALE']),
  write('applySettingsChanges', 'POST', '/settings/changes', 'owner', commandEnvelope(settingsChangePayload),
    commandAcceptedSchema, [...writeErrors, 'VALIDATION_STALE']),
  read('getSettingsChange', '/settings/changes/:id', 'settings.read', idSchema, settingsReceiptSchema),
  read('getSettingsRecovery', '/settings/changes/:id/recovery', 'settings.read', idSchema, settingsRecoveryOfferSchema),
  write('recoverSettingsChange', 'POST', '/settings/changes/:id/recovery', 'owner', commandEnvelope(settingsChangePayload),
    snapshotEnvelope(settingsRecoveryReceiptSchema), [...writeErrors, 'VALIDATION_STALE']),
  read('getFeishuChannel', '/channels/feishu', 'channels.read', emptySchema, feishuConnectionSchema),
  command('inspectFeishu', '/channels/feishu/inspections', 'channels.inspect', emptySchema),
  command('validateFeishu', '/channels/feishu/validations', 'channels.validate', emptySchema),
  write(
    'putFeishuCredentials',
    'POST',
    '/channels/feishu/credentials',
    'owner',
    z.strictObject({ app_id: z.string().min(1), app_secret: z.string().min(1) }),
    z.strictObject({ credential_ref: z.string().min(1), version: z.number().int().positive() }),
  ),
  command('createFeishuBinding', '/channels/feishu/bindings', 'owner', emptySchema),
  command('rejectFeishuBinding', '/channels/feishu/bindings/reject', 'owner', z.strictObject({ pairing_id: z.string().regex(/^pair_[a-f0-9]{16}$/u) })),
  command('confirmFeishuBinding', '/channels/feishu/bindings/:id/confirm', 'owner', emptySchema),
  read('getFeishuBinding', '/channels/feishu/bindings/:id', 'channels.read', idSchema, z.unknown()),
  command('createFeishuTest', '/channels/feishu/tests', 'owner', z.strictObject({ destination: z.string().min(1) })),
  command(
    'sendFeishuTest',
    '/channels/feishu/tests/:id/send',
    'owner',
    feishuTestSendPayload,
  ),
  read('getFeishuTest', '/channels/feishu/tests/:id', 'channels.read', idSchema, channelTestSchema),
  read('getPreferences', '/preferences', 'session', emptySchema, storedPreferences),
  write('patchPreferences', 'PATCH', '/preferences', 'session', preferencePatchRequest, snapshotEnvelope(storedPreferences)),
  read('getSystemHealth', '/system/health', 'session', domainSchema, healthSnapshotSchema),
  read('getSystemIncident', '/system/incidents/:id', 'settings.read', idSchema, settingsReceiptSchema),
  command('runSystemOperation', '/system/operations', 'owner', z.strictObject({ operation: z.string().min(1) })),
  command('confirmControlProposal', '/control-proposals/:id/confirm', 'owner', z.strictObject({ proposal_hash: z.string().min(1), challenge_id: z.string().min(1) })),
  read('getControlReceipt', '/control-receipts/:id', 'owner', idSchema, z.unknown()),
  { ...read('getStats', '/stats', 'stats.read', statsQuerySchema, statsSnapshotSchema),
    scopePermissions: ['work.read'], errors: [...readErrors, 'UNPROCESSABLE'] },
  { ...read('getNotificationSummary', '/notifications/summary', 'owner', domainSchema, notificationSummarySchema),
    errors: [...readErrors, 'UNPROCESSABLE'] },
  write('previewNotification', 'POST', '/notifications/preview', 'owner',
    commandEnvelope(z.strictObject({ request_scope: browserCreationScopeSchema })).extend({ expected_revision: z.null() }),
    snapshotEnvelope(notificationPreviewSchema)),
  command('testNotification', '/notifications/test', 'owner', feishuTestSendPayload),
  write('previewDiagnostics', 'POST', '/diagnostics/preview', 'owner', diagnosticsPreviewRequest, diagnosticsPreviewSchema),
  write('exportDiagnostics', 'POST', '/diagnostics/export', 'owner', diagnosticsExportRequest, diagnosticsReportSchema),
  { operationId: 'listEvents', method: 'GET', path: '/events', permission: 'events.read', kind: 'read',
    scopePermissions: ['work.read'],
    request: z.strictObject({ after: z.string().min(1).optional(), ...domainSchema.shape }), response: sseEventSchema,
    responseMediaType: 'text/event-stream', errors: [...readErrors, 'UNPROCESSABLE'] },
  read('getCommand', '/commands/:id', 'commands.read', idSchema, z.strictObject({
    ...commandAcceptedSchema.shape, resource_id: z.string().min(1), operation: z.string().min(1),
    control_receipt_id: z.string().min(1).optional(),
  })),
];

export const MCP_TOOLS = [
  { name: 'patrick_consult', permission: 'mcp:consult' },
  { name: 'patrick_consult_result', permission: 'mcp:consult' },
  { name: 'patrick_memory_query', permission: 'mcp:memory' },
] as const;

export function apiPath(path: string): string {
  return '/api/v1' + path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
}

function queryParameters(route: RouteDefinition): Record<string, unknown>[] {
  if (route.method !== 'GET') return [];
  const pathParamSet = new Set(pathParams(route.path));
  const jsonSchema = z.toJSONSchema(route.request) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const properties = jsonSchema.properties ?? {};
  const required = new Set(jsonSchema.required ?? []);
  return Object.entries(properties)
    .filter(([name]) => !pathParamSet.has(name))
    .map(([name, schema]) => {
      const fieldSchema = schema as { default?: unknown };
      const isRequired = required.has(name) && fieldSchema.default === undefined;
      return {
        name,
        in: 'query',
        required: isRequired,
        schema,
      };
    });
}

function openApiSuccessStatus(route: RouteDefinition): '200' | '202' {
  if (route.operationId === 'patchPreferences') return '200';
  if (route.response === commandAcceptedSchema) return '202';
  return '200';
}

export function generateOpenApi(): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = {};
  const schemas: Record<string, unknown> = {
    ErrorBody: z.toJSONSchema(errorBodySchema),
  };

  for (const route of routes) {
    const path = apiPath(route.path);
    const method = route.method.toLowerCase();
    const requestName = `${route.operationId}Request`;
    const responseName = `${route.operationId}Response`;
    schemas[requestName] = z.toJSONSchema(route.request);
    schemas[responseName] = z.toJSONSchema(route.response);
    const successStatus = openApiSuccessStatus(route);
    const operation: Record<string, unknown> = {
      operationId: route.operationId,
      'x-permission': route.permission,
      ...(route.scopePermissions ? { 'x-additional-scope-permissions': route.scopePermissions } : {}),
      parameters: [
        ...pathParams(route.path).map((name) => ({
          name,
          in: 'path',
          required: true,
          schema: { type: 'string' },
        })),
        ...queryParameters(route),
        ...(route.responseMediaType === 'text/event-stream' ? [{ name: 'Last-Event-ID', in: 'header', required: false,
          schema: { type: 'string' } }] : []),
      ],
      responses: {
        [successStatus]: {
          description: 'success',
          content: route.responseMediaType === 'text/event-stream' ? {
            'text/event-stream': { schema: { type: 'string' }, 'x-event-data-schema': { $ref: `#/components/schemas/${responseName}` } },
          } : { 'application/json': { schema: { $ref: `#/components/schemas/${responseName}` } } },
        },
      },
    };
    if (route.kind === 'write' && route.method !== 'DELETE') {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${requestName}` } } },
      };
    }
    const responses = operation.responses as Record<string, unknown>;
    for (const code of route.errors) {
      const status = HTTP_ERROR_STATUS[code as keyof typeof HTTP_ERROR_STATUS];
      if (!status) continue;
      responses[String(status)] = {
        description: code,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } },
      };
    }
    paths[path] ??= {};
    paths[path][method] = { operationId: route.operationId, ...operation };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'PAtrick service',
      version: '1.0.0',
      'x-allowed-schema-majors': [...ALLOWED_SCHEMA_MAJORS],
    },
    paths,
    components: {
      schemas,
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: 'patrick_session' },
      },
    },
  };
}

export function generateSdk(): SdkMethod[] {
  return routes.map((route) => ({
    operationId: route.operationId,
    method: route.method,
    path: route.path,
    permission: route.permission,
    ...(route.scopePermissions ? { scopePermissions: route.scopePermissions } : {}),
    errors: [...route.errors],
  }));
}

export { PAGE_DEFAULT, PAGE_MAX };
