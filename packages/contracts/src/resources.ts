import { z } from 'zod';
import {
  ALLOWED_SCHEMA_MAJORS,
  commandAcceptedSchema,
  commandEnvelope,
  errorBodySchema,
  PAGE_DEFAULT,
  PAGE_MAX,
  snapshotEnvelope,
} from './envelope.js';

export const HTTP_ERROR_STATUS = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
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
  kind: 'read' | 'write';
  request: z.ZodType;
  response: z.ZodType;
  errors: readonly string[];
};

export type SdkMethod = {
  operationId: string;
  method: HttpMethod;
  path: string;
  permission: string;
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
const writeErrors = ['UNAUTHENTICATED', 'FORBIDDEN', 'CONFLICT', 'UNPROCESSABLE'] as const;
const emptySchema = z.strictObject({});
const idSchema = z.strictObject({ id: z.string().min(1) });
const listDataSchema = z.strictObject({ items: z.array(z.unknown()) });
const pageQuerySchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
});

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
    knowledge_id: z.string().min(1),
    document_id: z.string().min(1),
    expected_source_revision: z.number().int().nonnegative(),
  }),
  z.strictObject({
    operation: z.literal('supplement_knowledge'),
    knowledge_id: z.string().min(1),
    expected_knowledge_revision: z.number().int().nonnegative(),
    draft_key: z.string().min(1),
  }),
  z.strictObject({
    operation: z.literal('create_standard'),
    draft_key: z.string().min(1),
    expected_active_version: z.null(),
  }),
  z.strictObject({
    operation: z.literal('revise_standard'),
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

const preferencePayload = z.strictObject({
  mode: z.enum(['system', 'en', 'zh']).optional(),
  reduced_motion: z.boolean().optional(),
  notifications: z.enum(['necessary', 'all']).optional(),
  quiet_hours: z.strictObject({
    start: z.string().min(1),
    end: z.string().min(1),
  }).nullable().optional(),
});

const statsQuerySchema = z.strictObject({
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
  read('listWork', '/work', 'work.read', pageQuerySchema, listDataSchema),
  read('getWork', '/work/:id', 'work.read', idSchema, z.unknown()),
  read('getWorkTimeline', '/work/:id/timeline', 'work.read', idSchema, listDataSchema),
  command('controlWork', '/work/:id/controls', 'work.control', workControlPayload),
  read('getQuestion', '/questions/:id', 'questions.read', idSchema, z.unknown()),
  command('submitAnswer', '/questions/:id/answers', 'questions.answer', answerPayload),
  read('getAnswerReceipt', '/answers/:receiptId', 'questions.read', z.strictObject({ receiptId: z.string().min(1) }), z.unknown()),
  read('listConversations', '/conversations', 'conversations.read', pageQuerySchema, listDataSchema),
  command('createConversation', '/conversations', 'conversations.write', z.strictObject({ text: z.string().min(1) })),
  read('listMessages', '/conversations/:id/messages', 'conversations.read', idSchema, listDataSchema),
  command('postMessage', '/conversations/:id/messages', 'conversations.write', z.strictObject({ text: z.string().min(1) })),
  command('linkConversationWork', '/conversations/:id/work-links', 'conversations.write', z.strictObject({ work_id: z.string().min(1) })),
  command('createConsultation', '/consultations', 'consultations.write', z.strictObject({ text: z.string().min(1), parent_work_id: z.string().min(1).nullable() })),
  read('getConsultation', '/consultations/:id', 'consultations.read', idSchema, z.unknown()),
  command('cancelConsultation', '/consultations/:id/cancel', 'consultations.write', emptySchema),
  read('listKnowledge', '/knowledge', 'knowledge.read', pageQuerySchema, listDataSchema),
  read('getKnowledge', '/knowledge/:id', 'knowledge.read', idSchema, z.unknown()),
  read('getKnowledgeEvidence', '/knowledge/:id/evidence', 'knowledge.read', idSchema, listDataSchema),
  read('getSourceRevision', '/sources/:id/revisions/:rev', 'sources.read', z.strictObject({ id: z.string().min(1), rev: z.string().min(1) }), z.unknown()),
  read('listVaults', '/vaults', 'vault.read', pageQuerySchema, listDataSchema),
  read('getVaultConnection', '/vaults/:id/connection', 'vault.read', idSchema, vaultConnectionSchema),
  command('inspectVaults', '/vaults/inspections', 'vault.inspect', z.strictObject({ device_id: z.string().min(1), vault_id: z.string().min(1) })),
  command('validateVaults', '/vaults/validations', 'vault.inspect', z.strictObject({ device_id: z.string().min(1), vault_id: z.string().min(1) })),
  read('getKnowledgeEditTarget', '/knowledge/:id/edit-target', 'edits.read', idSchema, z.unknown()),
  read('getStandardEditTarget', '/standards/:id/edit-target', 'edits.read', idSchema, z.unknown()),
  command('createEdit', '/edits', 'edits.write', editIntentRequestSchema),
  read('getEdit', '/edits/:id', 'edits.read', idSchema, editReceiptSchema),
  command('checkEdit', '/edits/:id/checks', 'edits.write', emptySchema),
  command('retryEditProjection', '/edits/:id/projection-retries', 'edits.write', z.strictObject({ expected_revision: z.number().int().nonnegative() })),
  read('listStandards', '/standards', 'standards.read', pageQuerySchema, listDataSchema),
  read('listStandardVersions', '/standards/:id/versions', 'standards.read', idSchema, listDataSchema),
  read('getEvaluation', '/evaluations/:id', 'standards.read', idSchema, z.unknown()),
  command('createStandardCandidate', '/standard-candidates', 'standards.write', z.strictObject({ standard_id: z.string().min(1).nullable(), draft_key: z.string().min(1) })),
  command('evaluateStandardCandidate', '/standard-candidates/:id/evaluations', 'standards.write', z.strictObject({ dataset_id: z.string().min(1) })),
  command('adoptStandardCandidate', '/standard-candidates/:id/adoptions', 'owner', z.strictObject({ report_id: z.string().min(1) })),
  read('listDelegations', '/delegations', 'delegations.read', pageQuerySchema, listDataSchema),
  read('getDelegation', '/delegations/:id', 'delegations.read', idSchema, z.unknown()),
  command('createDelegationProposal', '/delegation-proposals', 'owner', z.unknown()),
  command('controlDelegation', '/delegations/:id/controls', 'owner', z.strictObject({ type: z.enum(['pause', 'resume', 'stop']) })),
  read('listSources', '/sources', 'sources.read', pageQuerySchema, listDataSchema),
  read('getSource', '/sources/:id', 'sources.read', idSchema, z.unknown()),
  read('getSourceReceipts', '/sources/:id/receipts', 'sources.read', idSchema, listDataSchema),
  command('detectSources', '/sources/detect', 'sources.detect', z.strictObject({ target: z.string().min(1) })),
  read('getSettings', '/settings', 'settings.read', emptySchema, z.unknown()),
  command('inspectSettings', '/settings/inspections', 'settings.inspect', emptySchema),
  command('validateSettings', '/settings/validations', 'settings.validate', z.strictObject({ draft_hash: z.string().min(1) })),
  command('applySettingsChanges', '/settings/changes', 'owner', z.strictObject({ draft_hash: z.string().min(1) })),
  read('getSettingsChange', '/settings/changes/:id', 'settings.read', idSchema, z.unknown()),
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
  command('confirmFeishuBinding', '/channels/feishu/bindings/:id/confirm', 'owner', emptySchema),
  read('getFeishuBinding', '/channels/feishu/bindings/:id', 'channels.read', idSchema, z.unknown()),
  command('createFeishuTest', '/channels/feishu/tests', 'owner', z.strictObject({ destination: z.string().min(1) })),
  command('sendFeishuTest', '/channels/feishu/tests/:id/send', 'owner', z.strictObject({ preview_hash: z.string().min(1) })),
  read('getFeishuTest', '/channels/feishu/tests/:id', 'channels.read', idSchema, channelTestSchema),
  read('getPreferences', '/preferences', 'session', emptySchema, preferencePayload),
  command('patchPreferences', '/preferences', 'session', preferencePayload, 'PATCH'),
  read('getSystemHealth', '/system/health', 'session', emptySchema, healthSnapshotSchema),
  read('getSystemIncident', '/system/incidents/:id', 'session', idSchema, z.unknown()),
  command('runSystemOperation', '/system/operations', 'owner', z.strictObject({ operation: z.string().min(1) })),
  command('confirmControlProposal', '/control-proposals/:id/confirm', 'owner', z.strictObject({ proposal_hash: z.string().min(1), challenge_id: z.string().min(1) })),
  read('getControlReceipt', '/control-receipts/:id', 'owner', idSchema, z.unknown()),
  read('getStats', '/stats', 'stats.read', statsQuerySchema, z.unknown()),
  command('previewNotification', '/notifications/preview', 'owner', z.strictObject({ intent: z.string().min(1) })),
  command('testNotification', '/notifications/test', 'owner', z.strictObject({ destination: z.string().min(1), intent: z.string().min(1) })),
  command('previewDiagnostics', '/diagnostics/preview', 'owner', emptySchema),
  command('exportDiagnostics', '/diagnostics/export', 'owner', emptySchema),
  read('listEvents', '/events', 'events.read', z.strictObject({ after: z.string().min(1).optional() }), listDataSchema),
  read('getCommand', '/commands/:id', 'commands.read', idSchema, z.unknown()),
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
    const operation: Record<string, unknown> = {
      operationId: route.operationId,
      'x-permission': route.permission,
      parameters: pathParams(route.path).map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      })),
      responses: {
        '200': {
          description: 'success',
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${responseName}` } } },
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
    errors: [...route.errors],
  }));
}

export { PAGE_DEFAULT, PAGE_MAX };
