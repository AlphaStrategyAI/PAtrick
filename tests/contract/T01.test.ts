import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  assertAllowedSchemaMajor,
  canonicalCommand,
  canonicalPayload,
  commandEnvelope,
} from '../../packages/contracts/src/envelope.js';
import { acceptEventVersion, domainEventSchema } from '../../packages/contracts/src/events.js';
import { snapshotEnvelope } from '../../packages/contracts/src/envelope.js';
import { createApp } from '../../apps/service/src/app.js';
import {
  apiPath,
  channelTestStatusSchema,
  editBusinessStateSchema,
  editFileStateSchema,
  editIntentRequestSchema,
  editProjectionStateSchema,
  feishuConnectionStatusSchema,
  generateOpenApi,
  generateSdk,
  healthSnapshotSchema,
  MCP_TOOLS,
  routes,
  vaultConnectionStatusSchema,
} from '../../packages/contracts/src/resources.js';

function openApiOperation(operationId: string): Record<string, unknown> {
  const openapi = generateOpenApi();
  for (const item of Object.values(openapi.paths)) {
    for (const operation of Object.values(item)) {
      if ((operation as { operationId?: string }).operationId === operationId) {
        return operation as Record<string, unknown>;
      }
    }
  }
  throw new Error(`missing operation ${operationId}`);
}

test('canonical-command', () => {
  expect(canonicalPayload({ z: 1, a: ['否', null] })).toBe('{"a":["否",null],"z":1}');
  const schema = commandEnvelope(z.strictObject({ text: z.string() }));
  const request = { client_request_id: 'req-1', expected_revision: null, payload_hash: 'a'.repeat(64), payload: { text: '原文' } };
  expect(schema.parse(request)).toEqual(request);
  expect(schema.safeParse({ ...request, origin: 'business' }).success).toBe(false);
  const binding = { operation: 'work.pause', resource_id: 'W-017', data_domain: 'personal', expected_revision: 3, payload_hash: request.payload_hash };
  expect(canonicalCommand(binding)).not.toBe(canonicalCommand({ ...binding, resource_id: 'W-018' }));
  expect(canonicalCommand(binding)).not.toBe(canonicalCommand({ ...binding, expected_revision: 4 }));
});

test('rejects-unknown-major-and-authorization-fields', () => {
  expect(() => assertAllowedSchemaMajor('1.0')).not.toThrow();
  expect(() => assertAllowedSchemaMajor('2.0')).toThrow('SCHEMA_MAJOR_UNSUPPORTED');
  expect(acceptEventVersion('work.delivered', '1.0')).toBe('accept');
  expect(acceptEventVersion('work.delivered', '2.0')).toBe('reject_unknown_major');
  const control = routes.find((route) => route.operationId === 'controlWork');
  expect(control).toBeDefined();
  const request = {
    client_request_id: 'req-1',
    expected_revision: 3,
    payload_hash: 'a'.repeat(64),
    payload: { type: 'pause', generation: 2 },
  };
  expect(control?.request.safeParse(request).success).toBe(true);
  expect(control?.request.safeParse({ ...request, origin: 'business' }).success).toBe(false);
  expect(control?.request.safeParse({ ...request, authorization_ref: 'grant-1' }).success).toBe(false);
});

test('openapi-sdk-no-drift', () => {
  const openapi = generateOpenApi();
  const sdk = generateSdk();
  expect(openapi.openapi).toBe('3.1.0');
  const fromOpenApi = Object.entries(openapi.paths)
    .flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([method]) => ['get', 'post', 'patch', 'delete'].includes(method))
        .map(([method, operation]) => `${method.toUpperCase()} ${path} ${operation.operationId}`),
    )
    .sort();
  const fromSdk = sdk
    .map((item) => `${item.method} ${apiPath(item.path)} ${item.operationId}`)
    .sort();
  expect(fromSdk).toEqual(fromOpenApi);
  expect(new Set(sdk.map((item) => item.operationId)).size).toBe(sdk.length);
  expect(
    fromSdk.map((item) => item.split(' ').slice(0, 2).join(' ')),
  ).toEqual([
    'DELETE /api/v1/session',
    'GET /api/v1/answers/{receiptId}',
    'GET /api/v1/channels/feishu',
    'GET /api/v1/channels/feishu/bindings/{id}',
    'GET /api/v1/channels/feishu/tests/{id}',
    'GET /api/v1/commands/{id}',
    'GET /api/v1/consultations/{id}',
    'GET /api/v1/control-receipts/{id}',
    'GET /api/v1/conversations',
    'GET /api/v1/conversations/{id}/messages',
    'GET /api/v1/delegations',
    'GET /api/v1/delegations/{id}',
    'GET /api/v1/edits/{id}',
    'GET /api/v1/evaluations/{id}',
    'GET /api/v1/events',
    'GET /api/v1/knowledge',
    'GET /api/v1/knowledge/{id}',
    'GET /api/v1/knowledge/{id}/edit-target',
    'GET /api/v1/knowledge/{id}/evidence',
    'GET /api/v1/preferences',
    'GET /api/v1/questions/{id}',
    'GET /api/v1/session',
    'GET /api/v1/settings',
    'GET /api/v1/settings/changes/{id}',
    'GET /api/v1/sources',
    'GET /api/v1/sources/{id}',
    'GET /api/v1/sources/{id}/receipts',
    'GET /api/v1/sources/{id}/revisions/{rev}',
    'GET /api/v1/standards',
    'GET /api/v1/standards/{id}/edit-target',
    'GET /api/v1/standards/{id}/versions',
    'GET /api/v1/stats',
    'GET /api/v1/system/health',
    'GET /api/v1/system/incidents/{id}',
    'GET /api/v1/vaults',
    'GET /api/v1/vaults/{id}/connection',
    'GET /api/v1/work',
    'GET /api/v1/work/{id}',
    'GET /api/v1/work/{id}/timeline',
    'PATCH /api/v1/preferences',
    'POST /api/v1/auth/challenge',
    'POST /api/v1/auth/verify',
    'POST /api/v1/channels/feishu/bindings',
    'POST /api/v1/channels/feishu/bindings/{id}/confirm',
    'POST /api/v1/channels/feishu/credentials',
    'POST /api/v1/channels/feishu/inspections',
    'POST /api/v1/channels/feishu/tests',
    'POST /api/v1/channels/feishu/tests/{id}/send',
    'POST /api/v1/channels/feishu/validations',
    'POST /api/v1/consultations',
    'POST /api/v1/consultations/{id}/cancel',
    'POST /api/v1/control-proposals/{id}/confirm',
    'POST /api/v1/conversations',
    'POST /api/v1/conversations/{id}/messages',
    'POST /api/v1/conversations/{id}/work-links',
    'POST /api/v1/delegation-proposals',
    'POST /api/v1/delegations/{id}/controls',
    'POST /api/v1/diagnostics/export',
    'POST /api/v1/diagnostics/preview',
    'POST /api/v1/edits',
    'POST /api/v1/edits/{id}/checks',
    'POST /api/v1/edits/{id}/projection-retries',
    'POST /api/v1/notifications/preview',
    'POST /api/v1/notifications/test',
    'POST /api/v1/questions/{id}/answers',
    'POST /api/v1/settings/changes',
    'POST /api/v1/settings/inspections',
    'POST /api/v1/settings/validations',
    'POST /api/v1/sources/detect',
    'POST /api/v1/standard-candidates',
    'POST /api/v1/standard-candidates/{id}/adoptions',
    'POST /api/v1/standard-candidates/{id}/evaluations',
    'POST /api/v1/system/operations',
    'POST /api/v1/vaults/inspections',
    'POST /api/v1/vaults/validations',
    'POST /api/v1/work/{id}/controls',
  ].sort());
  expect(MCP_TOOLS.map((tool) => tool.name)).toEqual([
    'patrick_consult',
    'patrick_consult_result',
    'patrick_memory_query',
  ]);
});

test('freezes-connection-edit-channel-unions', () => {
  expect(vaultConnectionStatusSchema.options).toEqual([
    'not_connected',
    'checking',
    'needs_install',
    'needs_permission',
    'awaiting_confirmation',
    'connected',
    'degraded',
  ]);
  expect(editFileStateSchema.options).toEqual([
    'preparing',
    'awaiting_save',
    'collected',
    'invalid',
    'conflict',
  ]);
  expect(editBusinessStateSchema.options).toEqual([
    'not_started',
    'pending',
    'verifying',
    'evaluating',
    'adopted',
    'not_adopted',
    'stale',
  ]);
  expect(editProjectionStateSchema.options).toEqual([
    'not_due',
    'pending',
    'current',
    'failed',
    'cleanup_pending',
    'superseded',
  ]);
  expect(channelTestStatusSchema.options).toEqual([
    'previewed',
    'sending',
    'sent',
    'verified',
    'unknown',
    'expired',
  ]);
  expect(feishuConnectionStatusSchema.options).toEqual([
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
  expect(
    editIntentRequestSchema.safeParse({
      operation: 'create_standard',
      draft_key: 'draft-1',
      expected_active_version: null,
    }).success,
  ).toBe(true);
  expect(
    editIntentRequestSchema.safeParse({
      operation: 'create_standard',
      draft_key: 'draft-1',
      expected_active_version: 1,
    }).success,
  ).toBe(false);
});

test('release-evidence-rejects-pass-without-proof', () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-evidence-'));
  mkdirSync(join(root, 'tasks'));
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({ release_id: 'dev', versions: { schema: '1.0' }, tasks: ['T01'] }),
  );
  const scenario = {
    id: 'canonical-command',
    command: 'npm exec -- vitest run tests/contract/T01.test.ts',
    exitCode: 0,
    versions: { node: 'v26.13.0', schema: '1.0' },
    status: 'passed',
  };
  writeFileSync(join(root, 'tasks', 'T01.json'), JSON.stringify({ task: 'T01', scenarios: [scenario] }));
  expect(() =>
    execFileSync(process.execPath, ['scripts/check-release-evidence.mjs', root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  ).toThrow(/passed without evidence/);

  mkdirSync(join(root, 'evidence'));
  const body = 'ok\n';
  writeFileSync(join(root, 'evidence', 'canonical-command.txt'), body);
  writeFileSync(
    join(root, 'tasks', 'T01.json'),
    JSON.stringify({
      task: 'T01',
      scenarios: [{
        ...scenario,
        evidenceFile: 'evidence/canonical-command.txt',
        evidenceSha256: createHash('sha256').update(body).digest('hex'),
      }],
    }),
  );
  expect(
    execFileSync(process.execPath, ['scripts/check-release-evidence.mjs', root], { encoding: 'utf8' }),
  ).toMatch(/checked 1 scenario/);
});

test('quality-fix-command-openapi-query-and-versions', () => {
  const control = openApiOperation('controlWork');
  expect(control.responses).toHaveProperty('202');
  const controlResponses = control.responses as Record<string, unknown>;
  expect(controlResponses).toHaveProperty('429');
  expect(controlResponses).toHaveProperty('503');

  const patchPrefs = openApiOperation('patchPreferences');
  expect(patchPrefs.responses).toHaveProperty('200');
  expect(patchPrefs.responses).not.toHaveProperty('202');

  const queryParams = (operationId: string) =>
    ((openApiOperation(operationId).parameters ?? []) as { name: string; in: string; required?: boolean; schema?: unknown }[])
      .filter((parameter) => parameter.in === 'query');

  const listWorkQueries = queryParams('listWork');
  expect(listWorkQueries.map((parameter) => parameter.name).sort()).toEqual(['cursor', 'domain', 'limit', 'state']);
  expect(listWorkQueries.find((parameter) => parameter.name === 'cursor')?.required).toBe(false);
  expect(listWorkQueries.find((parameter) => parameter.name === 'limit')?.required).toBe(false);

  expect(queryParams('getWork').map((parameter) => parameter.name)).not.toContain('id');

  const getStatsQueries = queryParams('getStats');
  expect(getStatsQueries.find((parameter) => parameter.name === 'period')?.required).toBe(true);
  expect(getStatsQueries.find((parameter) => parameter.name === 'timezone')?.required).toBe(true);
  const periodSchema = getStatsQueries.find((parameter) => parameter.name === 'period')?.schema as { enum?: string[] };
  expect(periodSchema.enum).toEqual(['7d', '30d', 'all']);

  const listEventsQueries = queryParams('listEvents');
  expect(listEventsQueries).toEqual([
    expect.objectContaining({ name: 'after', required: false }),
    expect.objectContaining({ name: 'domain', required: false }),
  ]);
  expect(openApiOperation('listEvents')).toMatchObject({ responses: { '200': {
    content: { 'text/event-stream': { schema: { type: 'string' } } },
  } } });

  const send = routes.find((route) => route.operationId === 'sendFeishuTest');
  const envelopeBase = {
    client_request_id: 'req-feishu',
    expected_revision: null,
    payload_hash: 'a'.repeat(64),
  };
  expect(send?.request.safeParse({ ...envelopeBase, payload: { preview_hash: 'preview' } }).success).toBe(false);
  expect(
    send?.request.safeParse({
      ...envelopeBase,
      payload: { test_id: 'test-1', preview_hash: 'preview', destination: 'chat-1' },
    }).success,
  ).toBe(true);

  const snapshotSchema = snapshotEnvelope(healthSnapshotSchema);
  const snapshotBase = {
    scope: { account_id: 'bootstrap', data_domain: 'system', permission_epoch: 0 },
    as_of: '2026-01-01T00:00:00.000Z',
    watermark: { hub_seq: 0, domain_seq: 0 },
    freshness: 'unknown' as const,
    data: {
      service: 'unknown' as const,
      freshness: 'unknown' as const,
      impact: 'bootstrapping',
      next_step: null,
      as_of: '2026-01-01T00:00:00.000Z',
    },
  };
  expect(snapshotSchema.safeParse({ ...snapshotBase, schema_version: '1.0' }).success).toBe(true);
  expect(snapshotSchema.safeParse({ ...snapshotBase, schema_version: '2.0' }).success).toBe(false);

  const eventBase = {
    event_id: 'evt-1',
    type: 'work.delivered',
    resource_id: null,
    resource_revision: null,
    scope: { account_id: 'bootstrap', data_domain: 'personal', permission_epoch: 0 },
    as_of: '2026-01-01T00:00:00.000Z',
    watermark: { hub_seq: 0, domain_seq: 0 },
    payload: {},
  };
  expect(domainEventSchema.safeParse({ ...eventBase, schema_version: '1.0' }).success).toBe(true);
  expect(domainEventSchema.safeParse({ ...eventBase, schema_version: '2.0' }).success).toBe(false);
});

test('quality-fix-system-health-snapshot', async () => {
  const healthRoute = routes.find((route) => route.operationId === 'getSystemHealth');
  const response = await createApp().request('/api/v1/system/health');
  const body: unknown = await response.json();
  expect(healthRoute?.response.safeParse(body).success).toBe(true);
  const snapshot = healthRoute?.response.parse(body) as { data: { service: string; impact: string } };
  expect(snapshot.data.service).toBe('unknown');
  expect(snapshot.data.impact).toBe('bootstrapping');
});
