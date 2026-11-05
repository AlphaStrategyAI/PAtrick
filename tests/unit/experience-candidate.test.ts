import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, knowledgeOutputSchema, stableId, type KnowledgeCard, type SourceRevision } from '../../src/domain.js';
import { publishKnowledge } from '../../src/knowledge.js';
import { Store } from '../../src/store.js';
import { invalidateSource } from '../../src/intake.js';

const roots: string[] = [], stores: Store[] = [];
const H = '8244f04f20df9bbc4536baa865a2454428c7584e';
const quote = '助手说：“修好了”。显式指定配置路径后，启动成功。';
function details() {
  return { schemaVersion: 1 as const, problem: '配置文件找不到', symptomAliases: ['启动报错找不到配置'], solution: '显式指定配置路径', files: ['docs/PRD.md'], productId: 'one', codeVersion: H, environment: 'Node24; browser unknown', invalidationConditions: ['配置加载规则发生变化时重新检查'] };
}
function candidate() {
  return { title: '一次排查记录', body: '助手报告采用显式路径。', quote, aliases: ['config'], verification: 'reported' as const, kind: 'experience' as const, experience: details() };
}
function setup(retention: SourceRevision['retention'] = 'permanent') {
  const root = mkdtempSync(join(tmpdir(), 'patrick-experience-candidate-')); roots.push(root);
  const store = new Store(join(root, 'db.sqlite'), join(root, 'vault')); stores.push(store);
  const scope = { projectId: 'one', domain: 'personal' };
  const source: SourceRevision = { ...scope, id: stableId('source', scope, 'manual', 'reported', 'r1'), kind: 'manual', externalId: 'reported', revision: 'r1', title: '排查来源', content: `来源原文\n${quote}\n结束`, locator: 'manual:reported@r1', authorId: 'owner', retention, status: 'active', createdAt: '2026-11-05T00:00:00.000Z' };
  store.save('sources', source);
  return { store, source, root };
}
function cardPath(root: string): string {
  const path = readdirSync(join(root, 'vault'), { recursive: true }).map(String).find(path => path.includes('/cards/') && path.endsWith('.md'));
  if (!path) throw new Error('Expected a published card');
  return join(root, 'vault', path);
}
function editEntity(path: string, edit: (entity: Record<string, unknown>) => void) {
  const text = readFileSync(path, 'utf8');
  writeFileSync(path, text.replace(/^patrick_entity: (.+)$/m, (_, json: string) => {
    const entity = JSON.parse(json) as Record<string, unknown>; edit(entity);
    return `patrick_entity: ${JSON.stringify(entity)}`;
  }));
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('descriptive pending experience candidates', () => {
  it('preserves a complete reported description and exact assistant fixed quotation without minting host evidence', () => {
    const { store, source } = setup();
    const cards = publishKnowledge(store, source, { cards: [candidate()] });
    expect(cards[0]?.experience).toEqual(details());
    expect(cards[0]?.verification).toBe('reported');
    expect(cards[0]?.quote).toBe(quote);
    expect(store.get('cards', cards[0]!.id)).toEqual(cards[0]);
    expect(store.list('actions').filter(action => action.kind.startsWith('experience.'))).toEqual([]);
    expect(cards[0]).not.toHaveProperty('success');
    expect(cards[0]).not.toHaveProperty('experienceReference');
  });

  it('normalizes descriptions and mirrors symptom aliases into searchable aliases', () => {
    const { store, source } = setup(), value = candidate();
    value.aliases = [' config ', 'config', ''];
    value.experience = { ...details(), problem: ' 配置文件找不到 ', solution: ' 显式指定配置路径 ', files: [' docs/PRD.md '], symptomAliases: [' 启动报错找不到配置 '], productId: ' one ', codeVersion: ` ${H} `, environment: ' Node24; browser unknown ', invalidationConditions: [' 配置加载规则发生变化时重新检查 '] };
    const [card] = publishKnowledge(store, source, { cards: [value] });
    expect(card?.experience).toEqual(details());
    expect(card?.aliases).toEqual(['config', '启动报错找不到配置']);
    expect(store.searchCards('配置文件找不到', source).map(card => card.id)).toEqual([card!.id]);
    expect(store.searchCards('启动报错找不到配置', source).map(card => card.id)).toEqual([card!.id]);
    expect(store.searchCards('config', { ...source, domain: 'company' })).toEqual([]);
  });

  it('projects labeled reported details and a descriptive pending label into readable Markdown', () => {
    const { store, source, root } = setup(); publishKnowledge(store, source, { cards: [candidate()] });
    const text = readFileSync(cardPath(root), 'utf8'), body = text.split('\n---\n')[1]!;
    for (const label of ['Experience: pending', 'Reported problem: 配置文件找不到', 'Reported solution: 显式指定配置路径', 'Reported files: docs/PRD.md', 'Reported product: one', `Reported code version: ${H}`, 'Reported environment: Node24; browser unknown', 'Reported invalidation conditions: 配置加载规则发生变化时重新检查']) expect(body).toContain(label);
    expect(body).toContain(`> ${quote}`);
    expect(body).toContain('Source: manual:reported@r1');
    expect(body).toContain('Revision: r1');
    expect(text.split('\n---\n')[0]).not.toContain('experienceReference');
  });

  const invalidDetails: [string, (value: Record<string, unknown>) => void][] = [
    ['missing schema version', value => { delete value.schemaVersion; }], ['wrong schema version', value => { value.schemaVersion = 2; }],
    ['missing problem', value => { delete value.problem; }], ['blank problem', value => { value.problem = ' '; }], ['long problem', value => { value.problem = 'x'.repeat(8193); }],
    ['missing solution', value => { delete value.solution; }], ['blank solution', value => { value.solution = ' '; }], ['long solution', value => { value.solution = 'x'.repeat(8193); }],
    ['missing files', value => { delete value.files; }], ['empty files', value => { value.files = []; }], ['blank file', value => { value.files = [' ']; }],
    ...['../secret', '/etc/passwd', 'docs/../secret', 'docs/./PRD.md', 'docs//PRD.md', 'docs\\PRD.md', '.git/config', 'C:/secret', 'docs/\0secret'].map(path => [`unsafe file ${JSON.stringify(path)}`, (value: Record<string, unknown>) => { value.files = [path]; }] as [string, (value: Record<string, unknown>) => void]),
    ['duplicate files', value => { value.files = ['docs/PRD.md', ' docs/PRD.md ']; }], ['long file', value => { value.files = ['x'.repeat(1025)]; }], ['too many files', value => { value.files = Array.from({ length: 129 }, (_, i) => `docs/${i}.md`); }],
    ['missing product', value => { delete value.productId; }], ['blank product', value => { value.productId = ' '; }], ['long product', value => { value.productId = 'x'.repeat(513); }],
    ['missing version', value => { delete value.codeVersion; }], ['blank version', value => { value.codeVersion = ' '; }], ['long version', value => { value.codeVersion = 'x'.repeat(513); }],
    ['missing environment', value => { delete value.environment; }], ['blank environment', value => { value.environment = ' '; }], ['long environment', value => { value.environment = 'x'.repeat(8193); }],
    ['missing aliases', value => { delete value.symptomAliases; }], ['empty aliases', value => { value.symptomAliases = []; }], ['blank alias', value => { value.symptomAliases = [' ']; }], ['duplicate aliases', value => { value.symptomAliases = ['启动报错', ' 启动报错 ']; }], ['long alias', value => { value.symptomAliases = ['x'.repeat(257)]; }], ['too many aliases', value => { value.symptomAliases = Array.from({ length: 33 }, (_, i) => `alias${i}`); }],
    ['missing conditions', value => { delete value.invalidationConditions; }], ['empty conditions', value => { value.invalidationConditions = []; }], ['blank condition', value => { value.invalidationConditions = [' ']; }], ['long condition', value => { value.invalidationConditions = ['x'.repeat(2049)]; }], ['too many conditions', value => { value.invalidationConditions = Array.from({ length: 33 }, () => 'changed'); }],
  ];
  it.each(invalidDetails)('rejects %s', (_, mutate) => {
    const value = candidate(); mutate(value.experience);
    expect(knowledgeOutputSchema.safeParse({ cards: [value] }).success).toBe(false);
  });

  it('accepts the documented inclusive descriptor bounds', () => {
    const value = candidate();
    value.experience = { schemaVersion: 1, problem: 'p'.repeat(8192), solution: 's'.repeat(8192), environment: 'e'.repeat(8192), productId: 'p'.repeat(512), codeVersion: 'h'.repeat(512), files: Array.from({ length: 128 }, (_, i) => `${i}`.padEnd(1024, 'f')), symptomAliases: Array.from({ length: 32 }, (_, i) => `${i}`.padEnd(256, 'a')), invalidationConditions: Array.from({ length: 32 }, () => 'c'.repeat(2048)) };
    expect(knowledgeOutputSchema.safeParse({ cards: [value] }).success).toBe(true);
  });

  it('requires experience details only for new experience extraction', () => {
    const { experience: _, ...value } = candidate();
    expect(knowledgeOutputSchema.safeParse({ cards: [value] }).success).toBe(false);
    for (const kind of ['fact', 'knowledge']) {
      expect(knowledgeOutputSchema.safeParse({ cards: [{ ...value, kind }] }).success).toBe(true);
      expect(knowledgeOutputSchema.safeParse({ cards: [{ ...candidate(), kind }] }).success).toBe(false);
    }
    const { aliases: __, ...withoutAliases } = candidate();
    expect(knowledgeOutputSchema.safeParse({ cards: [withoutAliases] }).success).toBe(false);
  });

  const authority = ['verified', 'success', 'observations', 'testObservation', 'testObservations', 'links', 'evidenceLink', 'evidenceLinks', 'experienceReference', 'reference', 'applicability', 'claim', 'pendingClaim', 'comparable', 'snapshotDigest', 'testDefinitionDigest'];
  it.each(authority)('rejects forged %s at the envelope, card and descriptor boundaries', field => {
    const value = { observations: [{ conclusion: 'success', verified: true }], links: [{ candidateHash: 'forged' }] };
    expect(knowledgeOutputSchema.safeParse({ cards: [candidate()], [field]: value }).success).toBe(false);
    expect(knowledgeOutputSchema.safeParse({ cards: [{ ...candidate(), [field]: value }] }).success).toBe(false);
    expect(knowledgeOutputSchema.safeParse({ cards: [{ ...candidate(), experience: { ...details(), [field]: value } }] }).success).toBe(false);
  });

  it('rejects nested authority in declared text and list fields, unknown keys and model verified', () => {
    const nested = { success: true, experienceReference: { eligible: true } };
    for (const field of ['problem', 'solution', 'environment', 'productId', 'codeVersion', 'files', 'symptomAliases', 'invalidationConditions']) expect(knowledgeOutputSchema.safeParse({ cards: [{ ...candidate(), experience: { ...details(), [field]: Array.isArray(details()[field as keyof ReturnType<typeof details>]) ? [nested] : nested } }] }).success).toBe(false);
    expect(knowledgeOutputSchema.safeParse({ cards: [{ ...candidate(), verification: 'verified' }] }).success).toBe(false);
    for (const value of [{ cards: [candidate()], unknown: true }, { cards: [{ ...candidate(), unknown: true }] }, { cards: [{ ...candidate(), experience: { ...details(), unknown: true } }] }]) expect(knowledgeOutputSchema.safeParse(value).success).toBe(false);
  });

  it('enforces authorized product, current source revision and exact quotation before writing', () => {
    const { store, source } = setup();
    expect(() => publishKnowledge(store, source, { cards: [{ ...candidate(), experience: { ...details(), productId: 'other' } }] })).toThrow('Experience product must match its authorized project.');
    expect(() => publishKnowledge(store, source, { cards: [{ ...candidate(), quote: 'not in source' }] })).toThrow('An extracted quote is absent');
    expect(() => publishKnowledge(store, { ...source, revision: 'stale' }, { cards: [candidate()] })).toThrow('obsolete source');
    expect(store.list('cards')).toEqual([]);
  });

  it('hashes the complete frozen candidate identity and description while excluding display and timestamps', async () => {
    const { knowledgeCandidateHash } = await import('../../src/knowledge-identity.js');
    const { store, source } = setup(), [card] = publishKnowledge(store, source, { cards: [candidate()] });
    const hash = knowledgeCandidateHash(card!);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    for (const field of ['id', 'sourceId', 'sourceRevision', 'projectId', 'domain', 'title', 'body', 'quote', 'locator', 'kind'] as const) expect(knowledgeCandidateHash({ ...card!, [field]: `${card![field]}-changed` } as KnowledgeCard)).not.toBe(hash);
    expect(knowledgeCandidateHash({ ...card!, aliases: [...card!.aliases, 'other'] })).not.toBe(hash);
    for (const [field, value] of Object.entries(details())) expect(knowledgeCandidateHash({ ...card!, experience: { ...card!.experience!, [field]: Array.isArray(value) ? [...value, 'other'] : typeof value === 'number' ? 2 : `${value}-changed` } } as KnowledgeCard)).not.toBe(hash);
    expect(knowledgeCandidateHash({ ...card!, experience: undefined })).not.toBe(hash);
    expect(knowledgeCandidateHash({ ...card!, createdAt: 'later', expiresAt: 'later', verification: 'verified', status: 'withdrawn', experienceReference: { eligible: true } } as KnowledgeCard)).toBe(hash);
    expect(knowledgeCandidateHash({ ...card!, aliases: [' 启动报错找不到配置 ', 'config', 'config', ''] })).toBe(hash);
    expect(knowledgeCandidateHash({ ...card!, experience: Object.fromEntries(Object.entries(card!.experience!).reverse()) } as KnowledgeCard)).toBe(hash);
  });

  it('recovers complete descriptions and keeps legacy details-free experience browseable and reported', () => {
    const { store, source, root } = setup(); const [card] = publishKnowledge(store, source, { cards: [candidate()] });
    const complete = new Store(join(root, 'complete.sqlite'), join(root, 'vault')); stores.push(complete);
    expect(complete.searchCards('配置文件找不到', source)[0]?.experience).toEqual(details());
    complete.close();
    editEntity(cardPath(root), entity => { delete entity.experience; entity.verification = 'verified'; });
    const legacy = new Store(join(root, 'legacy.sqlite'), join(root, 'vault')); stores.push(legacy);
    const recovered = legacy.searchCards('config', source)[0];
    expect(recovered?.id).toBe(card!.id);
    expect(recovered?.experience).toBeUndefined();
    expect(recovered?.verification).toBe('reported');
    expect(readFileSync(cardPath(root), 'utf8')).toContain('Experience: pending');
    expect(legacy.list('actions')).toEqual([]);
  });

  it.each(['wrong product', 'unknown authority', 'unsafe file'])('drops %s from recovered descriptions without granting authority', reason => {
    const { store, source, root } = setup(); publishKnowledge(store, source, { cards: [candidate()] });
    editEntity(cardPath(root), entity => {
      const experience = (entity.experience ??= details()) as Record<string, unknown>;
      if (reason === 'wrong product') experience.productId = 'other';
      if (reason === 'unknown authority') experience.success = true;
      if (reason === 'unsafe file') experience.files = ['../secret'];
      entity.verification = 'verified';
    });
    const recovered = new Store(join(root, 'recovered.sqlite'), join(root, 'vault')); stores.push(recovered);
    const card = recovered.searchCards('config', source)[0];
    expect(card?.experience).toBeUndefined();
    expect(card?.verification).toBe('reported');
    expect(recovered.list('actions')).toEqual([]);
  });

  it('preserves withdrawal provenance when recovering a malformed descriptor into a Vault edit source', () => {
    const { store, source, root } = setup(), sentinel = 'G1_PRIVATE_RECOVERY_DESCRIPTOR_71b46e';
    const [published] = publishKnowledge(store, source, { cards: [{ ...candidate(), experience: { ...details(), problem: sentinel } }] });
    const path = cardPath(root);
    expect(readFileSync(path, 'utf8')).toContain(`Reported problem: ${sentinel}`);
    editEntity(path, entity => { (entity.experience as Record<string, unknown>).success = true; });
    const conflictPath = path.replace(/\.md$/, '.conflict-private.md');
    writeFileSync(conflictPath, readFileSync(path));
    store.close();

    const databasePath = join(root, 'recovered.sqlite'), seed = new Store(databasePath); stores.push(seed);
    seed.save('projects', { id: 'one', projectId: 'one', domain: 'personal', name: 'One', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [1], ownerId: 'owner', autoMerge: false, budgetUsd: 1, createdAt: source.createdAt });
    seed.save('sources', source);
    expect(seed.list('cards')).toEqual([]);
    seed.close();

    const recovered = new Store(databasePath, join(root, 'vault')); stores.push(recovered);
    const card = recovered.get('cards', published!.id);
    expect(card).toBeDefined();
    expect(card?.experience).toBeUndefined();
    expect(card?.verification).toBe('reported');
    const actions=recovered.list('actions');expect(actions).toHaveLength(2);
    expect(actions.every(action=>action.kind==='knowledge.structured-ingest'&&action.status==='pending'&&action.payload.phase==='queued')).toBe(true);
    const jobSourceIds=actions.map(action=>action.payload.sourceId as string);expect(new Set(jobSourceIds).size).toBe(2);expect(jobSourceIds).toContain(source.id);
    for(const action of actions){const linked=recovered.get('sources',action.payload.sourceId as string);expect(linked).toBeDefined();expect(action.payload).toMatchObject({sourceId:linked!.id,sourceRevision:linked!.revision,sourceHash:digest(linked!.content)});}
    expect(actions.filter(action=>['knowledge.host-observation','knowledge.evidence-link','experience.test-observation'].includes(action.kind))).toEqual([]);
    const readableEdits = recovered.list('sources').filter(value => value.status === 'active' && value.content.includes(sentinel));
    expect(readableEdits.length).toBeGreaterThan(0);
    for (const edit of readableEdits) {
      expect(edit.kind).toBe('file');
      expect(edit.externalId).toMatch(/^vault:/);
      expect(edit.parentSources).toEqual([{ id: source.id, revision: source.revision }]);
    }

    invalidateSource(recovered, source.id, 'withdrawn');
    expect(recovered.get('sources', source.id)?.status).toBe('withdrawn');
    expect(recovered.list('sources').filter(value => value.status === 'active' && JSON.stringify(value).includes(sentinel))).toEqual([]);
    const markdownPaths = readdirSync(join(root, 'vault'), { recursive: true }).map(String).filter(name => name.endsWith('.md'));
    expect(markdownPaths).toContain(conflictPath.slice(join(root, 'vault').length + 1));
    for (const name of markdownPaths) expect(readFileSync(join(root, 'vault', name), 'utf8')).not.toContain(sentinel);
  });

  it('redacts added descriptors from withdrawn Vault frontmatter and conflict copies', () => {
    const { store, source, root } = setup(); const [card] = publishKnowledge(store, source, { cards: [candidate()] });
    const path = cardPath(root); writeFileSync(path.replace(/\.md$/, '.conflict-private.md'), readFileSync(path));
    invalidateSource(store, source.id, 'withdrawn');
    for (const name of readdirSync(join(root, 'vault'), { recursive: true }).map(String).filter(path => path.includes('/cards/') && path.endsWith('.md'))) {
      const text = readFileSync(join(root, 'vault', name), 'utf8');
      for (const secret of [details().problem, details().solution, details().environment, details().invalidationConditions[0]!]) expect(text).not.toContain(secret);
      expect(text).not.toContain('"experience":');
    }
    expect(store.get('cards', card!.id)?.experience).toBeUndefined();
    store.rebuildIndex(); expect(store.searchCards('config', source)).toEqual([]);
  });

  it('keeps ephemeral descriptors in memory without publishing or restoring them', () => {
    const { store, source, root } = setup('ephemeral'); const [card] = publishKnowledge(store, source, { cards: [candidate()] });
    expect(store.get('cards', card!.id)?.experience).toEqual(details());
    expect(readdirSync(join(root, 'vault'), { recursive: true })).toEqual([]);
    store.close();
    const reopened = new Store(join(root, 'db.sqlite'), join(root, 'vault')); stores.push(reopened);
    expect(reopened.list('cards')).toEqual([]);
    expect(readFileSync(join(root, 'db.sqlite')).includes(Buffer.from(details().problem))).toBe(false);
  });
});
