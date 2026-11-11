import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { now, tokenize, type SourceRevision } from '../../src/domain.js';
import { withdrawSource } from '../../src/intake.js';
import { publishKnowledge } from '../../src/knowledge.js';
import { Store } from '../../src/store.js';

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-knowledge-'));
  roots.push(root);
  const store = new Store(join(root, 'db.sqlite'), join(root, 'vault'));
  stores.push(store);
  return { root, store };
}

function source(content: string): SourceRevision {
  return { id: 'source', projectId: 'one', domain: 'personal', kind: 'manual', externalId: 'idea', revision: 'v1', title: '草稿恢复', content, locator: 'productIdeas/草稿.md', authorId: 'owner', retention: 'permanent', status: 'active', createdAt: now() };
}

function vaultText(root: string): string {
  const dir = join(root, 'vault');
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) walk(path);
      else if (item.isFile()) files.push(readFileSync(path, 'utf8'));
    }
  };
  try { walk(dir); } catch { return ''; }
  return files.join('\n');
}

const content = '导出失败后应恢复草稿。';
const quote = '应恢复草稿';

it('records a rejected quotation separately from an exact source quotation', () => {
  const { root, store } = open();
  const current = source(content);
  store.save('sources', current);
  const forged = '这句话不在原文里';
  expect(() => publishKnowledge(store, current, { cards: [{ title: '伪造', body: forged, quote: forged, aliases: ['forged'], verification: 'reported', kind: 'fact' }] })).toThrow(/absent from the authorized source/);
  expect(store.list('cards')).toEqual([]);
  expect(store.searchCards(forged, current)).toEqual([]);
  expect(store.searchCards('恢复', current)).toEqual([]);
  expect(vaultText(root)).not.toContain(forged);
  const [card] = publishKnowledge(store, current, { cards: [{ title: '草稿恢复', body: '保留草稿以供恢复', quote, aliases: ['draft'], verification: 'reported', kind: 'fact' }] });
  expect(card?.quote).toBe(quote);
  expect(store.searchCards('恢复', current).map(item => item.quote)).toEqual([quote]);
  expect(vaultText(root)).toContain(quote);
  expect(vaultText(root)).not.toContain(forged);
});

it('indexes adjacent Chinese bigrams and English terms', () => {
  const terms = tokenize('草稿恢复 Draft').split(' ');
  expect(terms).toContain('草稿');
  expect(terms).toContain('恢复');
  expect(terms).toContain('draft');
});

it('records withdrawal separately: Chinese search stays empty after the index is rebuilt', () => {
  const { store } = open();
  const current = source(content);
  store.save('sources', current);
  const [card] = publishKnowledge(store, current, { cards: [{ title: '草稿恢复', body: '保留草稿以供恢复', quote, aliases: ['draft'], verification: 'reported', kind: 'fact' }] });
  expect(store.searchCards('草稿', current).map(item => item.id)).toEqual([card!.id]);
  expect(store.searchCards('恢复', current).map(item => item.quote)).toEqual([quote]);
  expect(store.searchCards('draft', current).map(item => item.quote)).toEqual([quote]);
  withdrawSource(store, current.id);
  store.rebuildIndex();
  expect(store.searchCards('草稿', current)).toEqual([]);
  expect(store.searchCards('恢复', current)).toEqual([]);
  expect(store.searchCards('draft', current)).toEqual([]);
});
