import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { canonicalPayload, type Json } from '../../packages/contracts/src/envelope.js';
import { editReceiptSchema } from '../../packages/contracts/src/resources.js';
import { createVaultApi, type VaultApiOptions, type VaultPrincipal } from '../../packages/integrations/vault/drafts.js';
import { publishCreateOnly } from '../../packages/integrations/vault/create-file.js';
import { PROJECTION_BATCH_FILES } from '../../packages/integrations/vault/projector.js';
import { editKey, obsidianFileUri } from '../../packages/integrations/vault/uri.js';
import { createSourceRegistry } from '../../packages/integrations/sources/registry.js';
import { tokenizeText } from '../../packages/domain/src/evidence.js';
import { createBlobStore, type BlobStore } from '../../packages/storage/src/blob-store.js';
import { openDatabase, type SqliteDatabase } from '../../packages/storage/src/database.js';
import { createApp } from '../../apps/service/src/app.js';
import { issueBootstrapTicket, issueCallerSession, ORIGIN } from '../../apps/service/src/auth.js';
import { createCredentialStore } from '../../packages/host/src/credentials.js';

const NOW = '2026-11-16T12:00:00.000Z';
const MIGRATIONS = fileURLToPath(new URL('../../packages/storage/migrations/', import.meta.url));
const PREVIOUS = {
  '0002_core.sql': '6e82bac75d455f28dc498874b61d0d778e1552b4bc5a8d1b5d7f5dfddfc06233',
  '0003_auth_control.sql': '3767d19a3f6c65f5ddae4f5f7d65a057082bfc978fec2d7e7a7a347f4cf2487f',
  '0004_hub_work.sql': 'bcd83075a607244bf5e5ee89efc621d0dd7670e42ace2b5884874ee8047dbcbe',
  '0005_sources.sql': '8bd6d4ee8e06b94247d314030acaf0b312b635a8fccdc457267afdfdc3c22f29',
} as const;

const principal: VaultPrincipal = {
  account_id: 'owner',
  caller_id: 'web',
  auth_epoch: 1,
  authenticated_at: NOW,
  domains: ['personal', 'work'],
  operations: ['owner', 'edits.write', 'edits.read', 'vault.read', 'knowledge.read'],
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function temporaryDatabase(): { dir: string; db: SqliteDatabase; blobs: BlobStore; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t06-'));
  const db = openDatabase(join(dir, 'patrick.sqlite'));
  const blobs = createBlobStore(join(dir, 'blobs'));
  return {
    dir,
    db,
    blobs,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function apiFor(fx: { db: SqliteDatabase; blobs: BlobStore }, extras: Partial<VaultApiOptions> = {}) {
  return createVaultApi(fx.db, { now: () => new Date(NOW), captureHost: 'mac-mini', ...extras, blobs: fx.blobs });
}

function note(knowledgeId: string, body: string, extra = ''): string {
  return `---\npatrick_id: doc-${knowledgeId}\nkind: knowledge\nknowledge_id: ${knowledgeId}\n${extra}---\n\n${body}\n`;
}

async function connect(api: ReturnType<typeof createVaultApi>, root: string, vaultId = 'vault-personal') {
  await api.connectVault({
    accountId: 'owner',
    deviceId: 'mac-mini',
    vaultId,
    root,
    domain: 'personal',
  });
  await api.confirmVault('mac-mini', vaultId);
  return vaultId;
}

test('a supplement retry reopens the same manuscript and keeps newer owner text', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'PAtrick-个人');
  mkdirSync(join(root, '知识笔记'), { recursive: true });
  try {
    const api = apiFor(fx);
    const vaultId = await connect(api, root);
    writeFileSync(join(root, '知识笔记', '原文.md'), note('k-note', '原始事实'), 'utf8');
    await api.readVault(vaultId);
    const supplementRequest = {
      operation: 'supplement_knowledge' as const,
      knowledge_id: 'k-note',
      expected_knowledge_revision: 1,
      draft_key: 'supplement-1',
    };
    const edit = await api.createEdit(principal, supplementRequest);
    const draft = join(root, '知识笔记', '补充', 'k-note.md');
    writeFileSync(draft, '# 原稿仍在', 'utf8');
    const retry = await api.createEdit(principal, supplementRequest);
    expect(retry.edit_id).toBe(edit.edit_id);
    expect(readFileSync(draft, 'utf8')).toBe('# 原稿仍在');
    expect(retry.business.state).not.toBe('adopted');
    expect(editReceiptSchema.safeParse(retry).success).toBe(true);
  } finally {
    fx.close();
  }
});

test('a crash after the draft is linked keeps the owner text on the same edit', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'vault');
  mkdirSync(join(root, '知识笔记'), { recursive: true });
  let crashed = false;
  try {
    const api = apiFor(fx, {
      afterDraftWrite() {
        if (crashed) return;
        crashed = true;
        throw new Error('CRASH_BEFORE_RECEIPT');
      },
    });
    const vaultId = await connect(api, root);
    writeFileSync(join(root, '知识笔记', '原文.md'), note('k-crash', '事实'), 'utf8');
    await api.readVault(vaultId);
    const request = {
      operation: 'supplement_knowledge' as const,
      knowledge_id: 'k-crash',
      expected_knowledge_revision: 1,
      draft_key: 'supplement-crash',
    };
    await expect(api.createEdit(principal, request)).rejects.toThrow('CRASH_BEFORE_RECEIPT');
    const row = fx.db.prepare(`SELECT edit_id FROM edit_intents WHERE operation = 'supplement_knowledge'`).get() as { edit_id: string };
    const draft = join(root, '知识笔记', '补充', 'k-crash.md');
    expect(readFileSync(draft, 'utf8')).not.toBe('# 原稿仍在');
    writeFileSync(draft, '# 原稿仍在', 'utf8');
    const retry = await api.createEdit(principal, request);
    expect(retry.edit_id).toBe(row.edit_id);
    expect(readFileSync(draft, 'utf8')).toBe('# 原稿仍在');
    expect(retry.business.state).not.toBe('adopted');
    const preparing = fx.db.prepare(`SELECT file_state FROM edit_receipts WHERE edit_id = ? AND receipt_revision = 0`).get(row.edit_id) as {
      file_state: string;
    };
    expect(preparing.file_state).toBe('preparing');
  } finally {
    fx.close();
  }
});

test('a crash after the intent row and before the draft file resumes the planned template', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'vault');
  mkdirSync(join(root, '知识笔记'), { recursive: true });
  let crashed = false;
  try {
    const api = apiFor(fx, {
      beforeDraftWrite() {
        if (crashed) return;
        crashed = true;
        throw new Error('CRASH_BEFORE_FILE');
      },
    });
    const vaultId = await connect(api, root);
    writeFileSync(join(root, '知识笔记', '原文.md'), note('k-resume', '事实'), 'utf8');
    await api.readVault(vaultId);
    const request = {
      operation: 'supplement_knowledge' as const,
      knowledge_id: 'k-resume',
      expected_knowledge_revision: 1,
      draft_key: 'resume',
    };
    await expect(api.createEdit(principal, request)).rejects.toThrow('CRASH_BEFORE_FILE');
    const draft = join(root, '知识笔记', '补充', 'k-resume.md');
    expect(existsSync(draft)).toBe(false);
    const row = fx.db.prepare(`SELECT edit_id FROM edit_intents WHERE operation = 'supplement_knowledge'`).get() as { edit_id: string };
    const retry = await api.createEdit(principal, request);
    const stored = fx.db.prepare('SELECT document_id FROM draft_intents WHERE edit_id = ?').get(row.edit_id) as { document_id: string };
    const template = readFileSync(fileURLToPath(new URL('../../assets/vault-kit/知识笔记.md', import.meta.url)), 'utf8');
    const planned = template.replace('patrick_id:', `patrick_id: ${stored.document_id}`).replace('knowledge_id:', 'knowledge_id: k-resume');
    expect(retry.edit_id).toBe(row.edit_id);
    expect(readFileSync(draft, 'utf8')).toBe(planned);
    expect(retry.file.state).toBe('awaiting_save');
    expect(retry.file.proof_ref).toBe(sha256(Buffer.from(planned, 'utf8')));
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM edit_intents WHERE active_key IS NOT NULL`).get()).toEqual({
      n: 1,
    });
  } finally {
    fx.close();
  }
});

test('edit_original only registers a location and create_standard keeps each draft_key', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'vault');
  mkdirSync(join(root, '知识笔记'), { recursive: true });
  try {
    const api = apiFor(fx);
    const vaultId = await connect(api, root);
    writeFileSync(join(root, '知识笔记', '原文.md'), note('k-orig', '事实'), 'utf8');
    await api.readVault(vaultId);
    const document = fx.db.prepare(`SELECT document_id, observed_seq FROM vault_documents WHERE relative_path = ?`).get('知识笔记/原文.md') as {
      document_id: string;
      observed_seq: number;
    };
    const before = readdirSync(root, { recursive: true }).map(String).sort();
    const opened = await api.createEdit(principal, {
      operation: 'edit_original',
      knowledge_id: 'k-orig',
      document_id: document.document_id,
      expected_source_revision: document.observed_seq,
    });
    const again = await api.createEdit(principal, {
      operation: 'edit_original',
      knowledge_id: 'k-orig',
      document_id: document.document_id,
      expected_source_revision: document.observed_seq,
    });
    expect(again.edit_id).toBe(opened.edit_id);
    expect(opened.file.state).toBe('awaiting_save');
    expect(opened.file.proof_ref).toBeNull();
    expect(opened.business.state).toBe('not_started');
    expect(readdirSync(root, { recursive: true }).map(String).sort()).toEqual(before);
    expect(api.fileUri(opened.edit_id)).toBe(obsidianFileUri('vault', '知识笔记/原文.md'));
    await expect(api.createEdit(principal, {
      operation: 'edit_original',
      knowledge_id: 'k-orig',
      document_id: document.document_id,
      expected_source_revision: document.observed_seq + 9,
    })).rejects.toThrow('CONFLICT');

    const alpha = await api.createEdit(principal, { operation: 'create_standard', draft_key: 'alpha', expected_active_version: null });
    const beta = await api.createEdit(principal, { operation: 'create_standard', draft_key: 'beta', expected_active_version: null });
    const alphaAgain = await api.createEdit(principal, { operation: 'create_standard', draft_key: 'alpha', expected_active_version: null });
    expect(alpha.edit_id).not.toBe(beta.edit_id);
    expect(alphaAgain.edit_id).toBe(alpha.edit_id);
    expect(readFileSync(join(root, '标准修订', 'alpha.md'), 'utf8')).toContain('# 适用范围');
    expect(readFileSync(join(root, '标准修订', 'beta.md'), 'utf8')).toContain('# 判断规则');
    writeFileSync(join(root, '标准修订', 'alpha.md'), '# 标准原稿仍在', 'utf8');
    await api.createEdit(principal, { operation: 'create_standard', draft_key: 'alpha', expected_active_version: null });
    expect(readFileSync(join(root, '标准修订', 'alpha.md'), 'utf8')).toBe('# 标准原稿仍在');
    const ids = fx.db.prepare(`SELECT target_id FROM edit_intents WHERE operation = 'create_standard' ORDER BY target_id`).all() as { target_id: string }[];
    expect(new Set(ids.map((row) => row.target_id)).size).toBe(2);
    expect(fx.db.prepare(`SELECT active_version FROM authority_facts WHERE data_domain = 'personal'`).get()).toEqual({ active_version: null });
    expect(alpha.business.state).not.toBe('adopted');
    const standardId = fx.db.prepare(`SELECT target_id FROM edit_intents WHERE edit_id = ?`).get(alpha.edit_id) as { target_id: string };
    const revised = await api.createEdit(principal, {
      operation: 'revise_standard',
      standard_id: standardId.target_id,
      base_version: 1,
      draft_key: 'revise-1',
    });
    expect(revised.business.state).toBe('stale');
    expect(revised.business.state).not.toBe('adopted');
    expect(readFileSync(join(root, '标准修订', `修订-${standardId.target_id}-v1.md`), 'utf8')).toContain('base_version: 1');
    expect(fx.db.prepare(`SELECT active_version FROM authority_facts WHERE data_domain = 'personal'`).get()).toEqual({ active_version: null });
  } finally {
    fx.close();
  }
});

test('publishCreateOnly claims a new name and leaves an existing file untouched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t06-link-'));
  try {
    const staged = join(root, 'staged.md');
    const destination = join(root, '知识笔记', '新稿.md');
    writeFileSync(staged, '完整正文', 'utf8');
    expect(await publishCreateOnly(staged, destination)).toBe('created');
    expect(readFileSync(destination, 'utf8')).toBe('完整正文');
    writeFileSync(staged, '后来的半成品', 'utf8');
    expect(await publishCreateOnly(staged, destination)).toBe('exists');
    expect(readFileSync(destination, 'utf8')).toBe('完整正文');
    expect(statSync(destination).nlink).toBeGreaterThanOrEqual(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('obsidianFileUri encodes the vault and file and does not open an application', () => {
  const relative = '知识笔记/补充 稿#.md';
  expect(obsidianFileUri('个人库', relative)).toBe(
    `obsidian://open?vault=${encodeURIComponent('个人库')}&file=${encodeURIComponent(relative)}`,
  );
  const source = readFileSync(fileURLToPath(new URL('../../packages/integrations/vault/uri.ts', import.meta.url)), 'utf8');
  expect(source).not.toContain('child_process');
  expect(source).not.toContain('Obsidian.app');
  expect(editKey('create_standard', null, null, 'alpha')).toBe(JSON.stringify(['create_standard', null, null, 'alpha']));
  expect(editKey('create_standard', null, null, 'beta')).not.toBe(editKey('create_standard', null, null, 'alpha'));
  expect(editKey('supplement_knowledge', 'k-note', 1, 'ignored')).toBe(JSON.stringify(['supplement_knowledge', 'k-note', 1, null]));
  expect(editKey('edit_original', 'doc-1', 3, '')).toBe(JSON.stringify(['edit_original', 'doc-1', 3, null]));
  expect(editKey('revise_standard', 'std-1', 2, 'r')).toBe(JSON.stringify(['revise_standard', 'std-1', 2, null]));
});

test('the reader skips system paths, archives original bytes, and ignores YAML authority', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'vault');
  mkdirSync(root);
  try {
    const api = apiFor(fx);
    const vaultId = await connect(api, root);
    const authority = fx.db.prepare(`SELECT data_domain, active_version, evaluation_threshold, delegation FROM authority_facts`).get();
    mkdirSync(join(root, '.obsidian'), { recursive: true });
    mkdirSync(join(root, '模板'), { recursive: true });
    mkdirSync(join(root, '系统视图', '批次', '1'), { recursive: true });
    mkdirSync(join(root, '附件'), { recursive: true });
    mkdirSync(join(root, '知识笔记'), { recursive: true });
    writeFileSync(join(root, '.obsidian', 'app.json'), '{"vault":true}', 'utf8');
    writeFileSync(join(root, '模板', '知识笔记.md'), note('k-template', '模板不是证据'), 'utf8');
    writeFileSync(join(root, '系统视图', '索引.md'), note('k-system', '系统视图'), 'utf8');
    writeFileSync(join(root, '系统视图', '批次', '1', '知识.base'), 'filters', 'utf8');
    writeFileSync(join(root, '知识笔记', '关系.canvas'), '{"nodes":[]}', 'utf8');
    writeFileSync(join(root, '知识笔记', '半写.md.tmp'), note('k-tmp', '临时'), 'utf8');
    writeFileSync(join(root, '知识笔记', '笔记.sync-conflict-2026.md'), note('k-sync', '冲突副本'), 'utf8');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    writeFileSync(join(root, '附件', '图.png'), png);
    const good = Buffer.from(note('k-good', '这里有知识笔记和证据', 'alias: 出处别名\n'), 'utf8');
    writeFileSync(join(root, '知识笔记', '记录 #1.md'), good);
    const broken = Buffer.from('---\nkind: knowledge\n!!python/object: nope\n---\n原文保留\n', 'utf8');
    writeFileSync(join(root, '知识笔记', '坏格式.md'), broken);
    const hostile = Buffer.from(note('k-hostile', '越权正文', 'data_domain: other\nactive_version: 9\nevaluation_threshold: 0\ndelegation: admin\n'), 'utf8');
    writeFileSync(join(root, '知识笔记', '越权.md'), hostile);
    const result = await api.readVault(vaultId);
    expect(result.state).toBe('ready');
    const paths = (fx.db.prepare(`SELECT relative_path, kind FROM vault_documents ORDER BY relative_path`).all() as { relative_path: string; kind: string }[]);
    expect(paths.map((row) => row.relative_path)).toEqual(expect.arrayContaining([
      '附件/图.png',
      '知识笔记/坏格式.md',
      '知识笔记/越权.md',
      '知识笔记/记录 #1.md',
    ]));
    expect(paths).toHaveLength(4);
    expect(paths.find((row) => row.relative_path === '附件/图.png')?.kind).toBe('attachment');
    expect(paths.filter((row) => row.kind === 'note').map((row) => row.relative_path)).not.toContain('附件/图.png');
    const brokenHash = sha256(broken);
    const archived = await fx.blobs.readBlob(brokenHash);
    expect(Buffer.from(archived).equals(broken)).toBe(true);
    expect(readFileSync(join(root, '知识笔记', '坏格式.md')).equals(broken)).toBe(true);
    const error = fx.db.prepare(`SELECT parse_error FROM vault_documents WHERE relative_path = ?`).get('知识笔记/坏格式.md') as { parse_error: string };
    expect(error.parse_error).toBe('3');
    expect(fx.db.prepare(`SELECT knowledge_id FROM knowledge_records WHERE knowledge_id = 'k-template'`).get()).toBeUndefined();
    expect(fx.db.prepare(`SELECT data_domain FROM knowledge_records WHERE knowledge_id = 'k-hostile'`).get()).toEqual({ data_domain: 'personal' });
    expect(fx.db.prepare(`SELECT data_domain, active_version, evaluation_threshold, delegation FROM authority_facts`).get()).toEqual(authority);
    expect(fx.db.prepare(`SELECT data_domain FROM vaults WHERE vault_id = ?`).get(vaultId)).toEqual({ data_domain: 'personal' });
    const tokens = fx.db.prepare(`SELECT tokens FROM knowledge_fts WHERE knowledge_id = 'k-good'`).get() as { tokens: string };
    expect(tokens.tokens).toContain('知识');
    expect(tokens.tokens).not.toContain('知识笔记');
    expect(tokenizeText('知识笔记')).toContain('知识');
  } finally {
    fx.close();
  }
});

test('Chinese search is limited to the domain and an isolated withdrawal keeps the other support', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'vault');
  mkdirSync(join(root, '知识笔记'), { recursive: true });
  try {
    const api = apiFor(fx);
    const vaultId = await connect(api, root);
    writeFileSync(join(root, '知识笔记', '甲.md'), note('k-shared', '甲的知识笔记出处', 'alias: 出处别名\n'), 'utf8');
    writeFileSync(join(root, '知识笔记', '乙.md'), note('k-shared', '乙仍支持这条知识'), 'utf8');
    await api.readVault(vaultId);
    const found = await api.queryEvidence({ text: '知识笔记', domain: 'personal', withdrawalEpoch: 0 }, principal);
    expect(found.items.map((item) => item.knowledge_id)).toEqual(['k-shared']);
    expect(found.items[0]?.support.length).toBe(2);
    const byAlias = await api.queryEvidence({ text: '出处别名', domain: 'personal', withdrawalEpoch: 0 }, principal);
    expect(byAlias.items[0]?.knowledge_id).toBe('k-shared');
    const other = await api.queryEvidence({ text: '知识笔记', domain: 'work', withdrawalEpoch: 0 }, principal);
    expect(other.items).toEqual([]);
    await expect(api.queryEvidence({ text: '知识笔记', domain: 'secret', withdrawalEpoch: 0 }, principal)).rejects.toThrow('FORBIDDEN');
    const first = found.items[0]?.support[0];
    const second = found.items[0]?.support[1];
    if (!first || !second) throw new Error('SUPPORT_MISSING');
    const epoch = await api.withdrawEvidence({ domain: 'personal', evidenceId: first.evidence_id, reason: 'source_withdrawn' });
    const kept = await api.queryEvidence({ text: '知识笔记', domain: 'personal', withdrawalEpoch: epoch.epoch }, principal);
    expect(kept.items).toHaveLength(1);
    expect(kept.items[0]?.support.map((item) => item.evidence_id)).toEqual([second.evidence_id]);
    expect(fx.db.prepare(`SELECT status FROM knowledge_records WHERE knowledge_id = 'k-shared'`).get()).toEqual({ status: 'candidate' });
    await api.withdrawEvidence({ domain: 'personal', evidenceId: second.evidence_id, reason: 'source_withdrawn' });
    const gone = await api.queryEvidence({ text: '知识笔记', domain: 'personal', withdrawalEpoch: epoch.epoch + 1 }, principal);
    expect(gone.items).toEqual([]);
    expect(fx.db.prepare(`SELECT status FROM knowledge_records WHERE knowledge_id = 'k-shared'`).get()).toEqual({ status: 'withdrawn' });
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM knowledge_records WHERE status = 'candidate'`).get()).toEqual({ n: 0 });
  } finally {
    fx.close();
  }
});

test('one physical root has one collector', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'notes');
  const nested = join(root, 'nested');
  mkdirSync(nested, { recursive: true });
  try {
    const registry = createSourceRegistry(fx.db, { blobs: fx.blobs, now: () => NOW });
    const api = apiFor(fx);
    await registry.enableSource({ accountId: 'owner', dataDomain: 'personal' }, {
      type: 'directory',
      target: root,
      excludes: [],
      hasTriggerRule: true,
      frequency: 'poll',
      history: 'none',
    });
    await expect(api.connectVault({
      accountId: 'owner',
      deviceId: 'mac-mini',
      vaultId: 'vault-taken',
      root,
      domain: 'personal',
    })).rejects.toThrow('VAULT_ROOT_TAKEN');
    const other = join(fx.dir, 'vault-only');
    mkdirSync(join(other, '知识笔记'), { recursive: true });
    await connect(api, other, 'vault-only');
    await expect(registry.enableSource({ accountId: 'owner', dataDomain: 'personal' }, {
      type: 'directory',
      target: other,
      excludes: [],
      hasTriggerRule: true,
      frequency: 'poll',
      history: 'none',
    })).rejects.toThrow('SOURCE_ROOT_TAKEN');
    await expect(registry.enableSource({ accountId: 'owner', dataDomain: 'personal' }, {
      type: 'directory',
      target: join(other, '知识笔记'),
      excludes: [],
      hasTriggerRule: true,
      frequency: 'poll',
      history: 'none',
    })).rejects.toThrow('SOURCE_ROOT_TAKEN');
  } finally {
    fx.close();
  }
});

test('offline rescan keeps documents and a later manuscript is a new revision', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'vault');
  mkdirSync(join(root, '知识笔记'), { recursive: true });
  try {
    const api = apiFor(fx);
    const vaultId = await connect(api, root);
    const file = join(root, '知识笔记', '原文.md');
    writeFileSync(file, note('k-live', '第一稿'), 'utf8');
    await api.readVault(vaultId);
    const first = fx.db.prepare(`SELECT document_id, observed_seq FROM vault_documents WHERE relative_path = ?`).get('知识笔记/原文.md') as {
      document_id: string;
      observed_seq: number;
    };
    rmSync(root, { recursive: true });
    const offline = await api.readVault(vaultId);
    expect(offline.state).toBe('offline');
    expect(fx.db.prepare(`SELECT tombstone FROM vault_documents WHERE document_id = ?`).get(first.document_id)).toEqual({ tombstone: 0 });
    mkdirSync(join(root, '知识笔记'), { recursive: true });
    writeFileSync(file, note('k-live', '较新原稿'), 'utf8');
    const online = await api.readVault(vaultId);
    expect(online.state).toBe('ready');
    const second = fx.db.prepare(`SELECT document_id, observed_seq, content_hash FROM vault_documents WHERE relative_path = ?`).get('知识笔记/原文.md') as {
      document_id: string;
      observed_seq: number;
      content_hash: string;
    };
    expect(second.document_id).toBe(first.document_id);
    expect(second.observed_seq).toBe(first.observed_seq + 1);
    expect(second.content_hash).toBe(sha256(Buffer.from(note('k-live', '较新原稿'), 'utf8')));
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM vault_revisions WHERE document_id = ?`).get(first.document_id)).toEqual({ n: 2 });
  } finally {
    fx.close();
  }
});

test('a failed or older projection does not move the current pointer', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'vault');
  mkdirSync(join(root, '知识笔记'), { recursive: true });
  try {
    const api = apiFor(fx, {
      failProjection(revision) {
        return revision === 3;
      },
    });
    const vaultId = await connect(api, root);
    writeFileSync(join(root, '知识笔记', '原文.md'), note('k-proj', '待投影'), 'utf8');
    await api.readVault(vaultId);
    const knowledgeBefore = fx.db.prepare(`SELECT revision, status FROM knowledge_records WHERE knowledge_id = 'k-proj'`).get();
    const files = Object.fromEntries(PROJECTION_BATCH_FILES.map((path) => [path, `# ${path}\n`]));
    const first = await api.project({ vaultId, viewKind: 'knowledge', revision: 1, files });
    expect(first.applied).toBe(true);
    expect(first.pointer).toBe(1);
    writeFileSync(join(root, '系统视图', '批次', '1', '知识', '当前.md'), '# 人工改过的生成文件\n', 'utf8');
    const second = await api.project({ vaultId, viewKind: 'knowledge', revision: 2, files });
    expect(second.pointer).toBe(2);
    expect(readFileSync(join(root, '系统视图', '索引.md'), 'utf8')).toContain('projection_revision: 2');
    expect(readFileSync(join(fx.dir, 'isolation', 'vault-personal', '1', '知识', '当前.md'), 'utf8')).toBe('# 人工改过的生成文件\n');
    const late = await api.project({ vaultId, viewKind: 'knowledge', revision: 1, files });
    expect(late.applied).toBe(false);
    expect(late.state).toBe('superseded');
    expect(late.pointer).toBe(2);
    const failed = await api.project({ vaultId, viewKind: 'knowledge', revision: 3, files });
    expect(failed.applied).toBe(false);
    expect(failed.state).toBe('failed');
    expect(failed.pointer).toBe(2);
    expect(readFileSync(join(root, '系统视图', '索引.md'), 'utf8')).toContain('projection_revision: 2');
    expect(fx.db.prepare(`SELECT revision, status FROM knowledge_records WHERE knowledge_id = 'k-proj'`).get()).toEqual(knowledgeBefore);
    const incomplete = await api.project({
      vaultId,
      viewKind: 'knowledge',
      revision: 4,
      files: { '知识/当前.md': '# 缺清单\n' },
    });
    expect(incomplete.applied).toBe(false);
    expect(incomplete.pointer).toBe(2);
    let seen = '';
    const locking = createVaultApi(fx.db, {
      blobs: fx.blobs,
      now: () => new Date(NOW),
      captureHost: 'mac-mini',
      onProjectionLock(domain, viewKind) {
        seen = `${domain}:${viewKind}`;
        const row = fx.db.prepare(`SELECT holder FROM projection_locks WHERE data_domain = ? AND view_kind = ?`).get(domain, viewKind);
        expect(row).toBeTruthy();
      },
    });
    await locking.project({ vaultId, viewKind: 'knowledge', revision: 4, files });
    expect(seen).toBe('personal:knowledge');
    expect(fx.db.prepare(`SELECT projection_revision FROM projection_pointers WHERE data_domain = 'personal' AND view_kind = 'knowledge'`).get()).toEqual({
      projection_revision: 4,
    });
  } finally {
    fx.close();
  }
});

test('a leftover lock and a partial batch still project that revision', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'vault');
  mkdirSync(join(root, '知识笔记'), { recursive: true });
  try {
    const api = apiFor(fx);
    const vaultId = await connect(api, root);
    const revision = 6;
    mkdirSync(join(root, '系统视图', '批次', String(revision), '知识'), { recursive: true });
    writeFileSync(join(root, '系统视图', '批次', String(revision), '知识', '当前.md'), '# 半截批次\n', 'utf8');
    fx.db.prepare(`INSERT INTO projection_locks (data_domain, view_kind, holder, acquired_at) VALUES ('personal', 'knowledge', 'abandoned-holder', ?)`).run(NOW);
    const files = Object.fromEntries(PROJECTION_BATCH_FILES.map((path) => [path, `# ${path}\n`]));
    const result = await api.project({ vaultId, viewKind: 'knowledge', revision, files });
    expect(result.applied).toBe(true);
    expect(result.pointer).toBe(revision);
    expect(fx.db.prepare(`SELECT projection_revision FROM projection_pointers WHERE data_domain = 'personal' AND view_kind = 'knowledge'`).get()).toEqual({
      projection_revision: revision,
    });
    expect(readFileSync(join(root, '系统视图', '批次', String(revision), '知识', '当前.md'), 'utf8')).toBe('# 知识/当前.md\n');
    expect(fx.db.prepare(`SELECT holder FROM projection_locks WHERE data_domain = 'personal' AND view_kind = 'knowledge'`).get()).toBeUndefined();
  } finally {
    fx.close();
  }
});

test('projection finishes when the prior batch was already preserved', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'vault');
  mkdirSync(join(root, '知识笔记'), { recursive: true });
  try {
    const api = apiFor(fx);
    const vaultId = await connect(api, root);
    const files = Object.fromEntries(PROJECTION_BATCH_FILES.map((path) => [path, `# ${path}\n`]));
    const first = await api.project({ vaultId, viewKind: 'knowledge', revision: 1, files });
    expect(first.applied).toBe(true);
    expect(first.pointer).toBe(1);
    const batch2 = join(root, '系统视图', '批次', '2');
    for (const path of PROJECTION_BATCH_FILES) {
      const target = join(batch2, ...path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, files[path], 'utf8');
    }
    const vaultBatch1 = join(root, '系统视图', '批次', '1');
    const isolationBatch1 = join(fx.dir, 'isolation', vaultId, '1');
    mkdirSync(dirname(isolationBatch1), { recursive: true });
    cpSync(vaultBatch1, isolationBatch1, { recursive: true });
    rmSync(vaultBatch1, { recursive: true, force: true });
    expect(fx.db.prepare(`SELECT projection_revision FROM projection_pointers WHERE data_domain = 'personal' AND view_kind = 'knowledge'`).get()).toEqual({
      projection_revision: 1,
    });
    const second = await api.project({ vaultId, viewKind: 'knowledge', revision: 2, files });
    expect(second.applied).toBe(true);
    expect(second.pointer).toBe(2);
    expect(existsSync(isolationBatch1)).toBe(true);
    expect(existsSync(join(isolationBatch1, '知识', '当前.md'))).toBe(true);
    expect(existsSync(vaultBatch1)).toBe(false);
  } finally {
    fx.close();
  }
});

test('a partial isolation copy is replaced before the vault batch is removed', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'vault');
  mkdirSync(join(root, '知识笔记'), { recursive: true });
  try {
    const api = apiFor(fx);
    const vaultId = await connect(api, root);
    const files = Object.fromEntries(PROJECTION_BATCH_FILES.map((path) => [path, `# ${path}\n`]));
    const first = await api.project({ vaultId, viewKind: 'knowledge', revision: 1, files });
    expect(first.applied).toBe(true);
    expect(first.pointer).toBe(1);
    const editedPath = join(root, '系统视图', '批次', '1', '知识', '当前.md');
    writeFileSync(editedPath, '# 人工改过的生成文件\n', 'utf8');
    const isolationBatch1 = join(fx.dir, 'isolation', vaultId, '1');
    const partialFile = join(isolationBatch1, '知识', '当前.md');
    mkdirSync(dirname(partialFile), { recursive: true });
    writeFileSync(partialFile, '# 半截隔离\n', 'utf8');
    const second = await api.project({ vaultId, viewKind: 'knowledge', revision: 2, files });
    expect(second.applied).toBe(true);
    expect(second.pointer).toBe(2);
    expect(readFileSync(join(isolationBatch1, '知识', '当前.md'), 'utf8')).toBe('# 人工改过的生成文件\n');
    expect(existsSync(join(root, '系统视图', '批次', '1'))).toBe(false);
  } finally {
    fx.close();
  }
});

test('a partial vault batch is dropped when the isolation copy is complete', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'vault');
  mkdirSync(join(root, '知识笔记'), { recursive: true });
  try {
    const api = apiFor(fx);
    const vaultId = await connect(api, root);
    const files = Object.fromEntries(PROJECTION_BATCH_FILES.map((path) => [path, `# ${path}\n`]));
    const first = await api.project({ vaultId, viewKind: 'knowledge', revision: 1, files });
    expect(first.applied).toBe(true);
    expect(first.pointer).toBe(1);
    const vaultBatch1 = join(root, '系统视图', '批次', '1');
    const isolationBatch1 = join(fx.dir, 'isolation', vaultId, '1');
    mkdirSync(dirname(isolationBatch1), { recursive: true });
    cpSync(vaultBatch1, isolationBatch1, { recursive: true });
    const removedPath = join(vaultBatch1, '知识', '当前.md');
    const preservedBytes = readFileSync(removedPath, 'utf8');
    rmSync(removedPath, { force: true });
    expect(existsSync(vaultBatch1)).toBe(true);
    const second = await api.project({ vaultId, viewKind: 'knowledge', revision: 2, files });
    expect(second.applied).toBe(true);
    expect(second.pointer).toBe(2);
    for (const path of PROJECTION_BATCH_FILES) {
      expect(existsSync(join(isolationBatch1, ...path.split('/')))).toBe(true);
    }
    expect(readFileSync(join(isolationBatch1, '知识', '当前.md'), 'utf8')).toBe(preservedBytes);
    expect(existsSync(vaultBatch1)).toBe(false);
  } finally {
    fx.close();
  }
});

test('projection retry reconciles an older revision without a new candidate', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'vault');
  mkdirSync(join(root, '知识笔记'), { recursive: true });
  try {
    const api = apiFor(fx);
    const vaultId = await connect(api, root);
    writeFileSync(join(root, '知识笔记', '原文.md'), note('k-retry', '事实'), 'utf8');
    await api.readVault(vaultId);
    const supplement = await api.createEdit(principal, {
      operation: 'supplement_knowledge',
      knowledge_id: 'k-retry',
      expected_knowledge_revision: 1,
      draft_key: 's',
    });
    const files = Object.fromEntries(PROJECTION_BATCH_FILES.map((path) => [path, `# ${path}\n`]));
    await api.project({ vaultId, viewKind: 'knowledge', revision: 2, files, editId: supplement.edit_id });
    const before = fx.db.prepare(`SELECT candidate_id, business_state FROM edit_receipts WHERE edit_id = ? ORDER BY receipt_revision DESC LIMIT 1`).get(supplement.edit_id) as {
      candidate_id: string | null;
      business_state: string;
    };
    const candidates = fx.db.prepare(`SELECT COUNT(*) AS n FROM knowledge_records`).get() as { n: number };
    const retry = await api.retryProjection(supplement.edit_id, 1);
    expect(retry.edit_id).toBe(supplement.edit_id);
    expect(retry.projection.projection_revision).toBe(2);
    expect(retry.projection.state).not.toBe('not_due');
    expect(retry.business.candidate_id).toBe(before.candidate_id);
    expect(retry.business.state).toBe(before.business_state);
    expect(retry.business.state).not.toBe('adopted');
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM knowledge_records`).get()).toEqual(candidates);
    expect(fx.db.prepare(`SELECT projection_revision FROM projection_pointers WHERE view_kind = 'knowledge'`).get()).toEqual({ projection_revision: 2 });
  } finally {
    fx.close();
  }
});

test('a supplement scan leaves the template unread and collects the owner text', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'vault');
  mkdirSync(join(root, '知识笔记'), { recursive: true });
  try {
    const api = apiFor(fx);
    const vaultId = await connect(api, root);
    writeFileSync(join(root, '知识笔记', '原文.md'), note('k-owner', '原始事实'), 'utf8');
    await api.readVault(vaultId);
    const before = fx.db.prepare(`SELECT body, revision FROM knowledge_records WHERE knowledge_id = 'k-owner'`).get() as {
      body: string;
      revision: number;
    };
    const edit = await api.createEdit(principal, {
      operation: 'supplement_knowledge',
      knowledge_id: 'k-owner',
      expected_knowledge_revision: 1,
      draft_key: 'owner-save',
    });
    const draft = join(root, '知识笔记', '补充', 'k-owner.md');
    await api.readVault(vaultId);
    expect(fx.db.prepare(`SELECT body, revision FROM knowledge_records WHERE knowledge_id = 'k-owner'`).get()).toEqual(before);
    expect(before.body).not.toContain('# 待核实');
    expect(fx.db.prepare(`SELECT file_state FROM edit_receipts WHERE edit_id = ? ORDER BY receipt_revision DESC LIMIT 1`).get(edit.edit_id)).toEqual({
      file_state: 'awaiting_save',
    });
    const owner = note('k-owner', '主人写下的补充');
    writeFileSync(draft, owner, 'utf8');
    await api.readVault(vaultId);
    expect(fx.db.prepare(`SELECT file_state FROM edit_receipts WHERE edit_id = ? ORDER BY receipt_revision DESC LIMIT 1`).get(edit.edit_id)).toEqual({
      file_state: 'collected',
    });
    expect(readFileSync(draft, 'utf8')).toBe(owner);
    const broken = Buffer.from('---\nkind: knowledge\n!!python/object: nope\n---\n原文保留\n', 'utf8');
    writeFileSync(draft, broken);
    await api.readVault(vaultId);
    expect(fx.db.prepare(`SELECT file_state FROM edit_receipts WHERE edit_id = ? ORDER BY receipt_revision DESC LIMIT 1`).get(edit.edit_id)).toEqual({
      file_state: 'invalid',
    });
    expect(readFileSync(draft).equals(broken)).toBe(true);
    expect(Buffer.from(await fx.blobs.readBlob(sha256(broken))).equals(broken)).toBe(true);
  } finally {
    fx.close();
  }
});

test('an existing foreign draft conflicts and the bytes stay', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'vault');
  mkdirSync(join(root, '知识笔记', '补充'), { recursive: true });
  try {
    const api = apiFor(fx);
    const vaultId = await connect(api, root);
    writeFileSync(join(root, '知识笔记', '原文.md'), note('k-foreign', '事实'), 'utf8');
    await api.readVault(vaultId);
    const occupied = join(root, '知识笔记', '补充', 'k-foreign.md');
    writeFileSync(occupied, '# 别人的稿', 'utf8');
    const edit = await api.createEdit(principal, {
      operation: 'supplement_knowledge',
      knowledge_id: 'k-foreign',
      expected_knowledge_revision: 1,
      draft_key: 'foreign',
    });
    expect(edit.file.state).toBe('conflict');
    expect(readFileSync(occupied, 'utf8')).toBe('# 别人的稿');
    const retry = await api.createEdit(principal, {
      operation: 'supplement_knowledge',
      knowledge_id: 'k-foreign',
      expected_knowledge_revision: 1,
      draft_key: 'foreign',
    });
    expect(retry.edit_id).toBe(edit.edit_id);
    expect(readFileSync(occupied, 'utf8')).toBe('# 别人的稿');
  } finally {
    fx.close();
  }
});

test('vault reads use the snapshot envelope and edit commands return 202', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'vault');
  mkdirSync(join(root, '知识笔记'), { recursive: true });
  const databasePath = join(fx.dir, 'patrick.sqlite');
  const credentialDirectory = join(fx.dir, 'credentials');
  try {
    const app = createApp({ databasePath, credentialDirectory, now: () => new Date(NOW) });
    const api = apiFor(fx);
    const vaultId = await connect(api, root);
    writeFileSync(join(root, '知识笔记', '原文.md'), note('k-http', '网页里的知识笔记'), 'utf8');
    await api.readVault(vaultId);
    issueBootstrapTicket(fx.db, { accountId: 'owner' }, () => new Date(NOW));
    const store = createCredentialStore(credentialDirectory, () => new Date(NOW));
    const session = issueCallerSession(fx.db, {
      accountId: 'owner',
      callerId: 'web',
      domain: 'personal',
      permissions: ['edits.write', 'edits.read', 'vault.read', 'knowledge.read'],
    }, () => new Date(NOW), store);
    const headers = {
      authorization: session.authorization,
      origin: ORIGIN,
      'content-type': 'application/json',
    };
    const denied = await app.request('/api/v1/vaults');
    expect(denied.status).toBe(401);
    const listed = await app.request('/api/v1/vaults', { headers });
    expect(listed.status).toBe(200);
    const listBody = await listed.json() as { schema_version: string; data: { items: { vault_id: string }[] } };
    expect(listBody.schema_version).toBe('1.0');
    expect(listBody.data.items.map((item) => item.vault_id)).toContain(vaultId);
    const connection = await app.request(`/api/v1/vaults/${vaultId}/connection`, { headers });
    expect(connection.status).toBe(200);
    const connectionBody = await connection.json() as { data: { status: string; editor_status: string; collection_status: string } };
    expect(connectionBody.data.status).toBe('connected');
    expect(connectionBody.data.editor_status).toBe('missing');
    expect(connectionBody.data.collection_status).toBe('ready');
    const payload = {
      operation: 'supplement_knowledge',
      knowledge_id: 'k-http',
      expected_knowledge_revision: 1,
      draft_key: 'http-1',
    };
    const envelope = {
      client_request_id: `edit-${randomUUID()}`,
      expected_revision: null,
      payload_hash: sha256(Buffer.from(canonicalPayload(payload as Json))),
      payload,
    };
    const created = await app.request('/api/v1/edits', { method: 'POST', headers, body: JSON.stringify(envelope) });
    expect(created.status).toBe(202);
    const accepted = await created.json() as { command_id: string; state: string; receipt_url: string };
    expect(accepted.state).toBe('received');
    const replay = await app.request('/api/v1/edits', { method: 'POST', headers, body: JSON.stringify(envelope) });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(accepted);
    const receipt = await app.request(accepted.receipt_url, { headers });
    expect(receipt.status).toBe(200);
    const receiptBody = await receipt.json() as { data: unknown };
    expect(editReceiptSchema.safeParse(receiptBody.data).success).toBe(true);
    const knowledge = await app.request('/api/v1/knowledge', { headers });
    expect(knowledge.status).toBe(200);
    const knowledgeBody = await knowledge.json() as { data: { items: { knowledge_id: string }[] } };
    expect(knowledgeBody.data.items.map((item) => item.knowledge_id)).toContain('k-http');
    const evidence = await app.request('/api/v1/knowledge/k-http/evidence', { headers });
    expect(evidence.status).toBe(200);
    const evidenceBody = await evidence.json() as { data: { items: { evidence_id: string }[] } };
    expect(evidenceBody.data.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(evidenceBody.data)).not.toContain('source_citation');
  } finally {
    fx.close();
  }
});

test('inspectVault reports a missing editor separately and drops a changed root', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'vault');
  mkdirSync(root);
  try {
    const api = apiFor(fx);
    const vaultId = await connect(api, root);
    const connected = await api.inspectVault('mac-mini', vaultId);
    expect(connected.status).toBe('connected');
    expect(connected.editor_status).toBe('missing');
    expect(connected.collection_status).toBe('ready');
    expect(connected.projection_status).toBe('missing');
    expect(connected.capture_host).toBe('mac-mini');
    expect(connected.root_identity.length).toBeGreaterThan(0);
    rmSync(root, { recursive: true });
    mkdirSync(root);
    const replaced = await api.inspectVault('mac-mini', vaultId);
    expect(replaced.status).not.toBe('connected');
    expect(replaced.collection_status).toBe('stopped');
  } finally {
    fx.close();
  }
});

test('the vault migration appends without changing earlier files', () => {
  const manifest = JSON.parse(readFileSync(join(MIGRATIONS, 'manifest.json'), 'utf8')) as { file: string; sha256: string }[];
  expect(manifest.map((entry) => entry.file)).toEqual([
    '0002_core.sql',
    '0003_auth_control.sql',
    '0004_hub_work.sql',
    '0005_sources.sql',
    '0006_vault_evidence.sql',
    '0007_standards.sql',
    '0008_admission_budget.sql',
    '0010_answers_channels.sql',
  ]);
  for (const [file, hash] of Object.entries(PREVIOUS)) {
    expect(manifest.find((entry) => entry.file === file)?.sha256).toBe(hash);
    expect(sha256(readFileSync(join(MIGRATIONS, file)))).toBe(hash);
  }
  const vaultHash = sha256(readFileSync(join(MIGRATIONS, '0006_vault_evidence.sql')));
  expect(manifest[4]?.sha256).toBe(vaultHash);
  const fx = temporaryDatabase();
  try {
    expect(fx.db.prepare('SELECT file, sha256 FROM schema_migrations ORDER BY position').all()).toEqual(manifest);
  } finally {
    fx.close();
  }
});
