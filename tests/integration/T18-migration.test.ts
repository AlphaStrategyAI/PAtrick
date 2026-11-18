import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openDatabase, type MigrationEntry } from '@patrick/storage';

test('the HTTP source migration keeps existing lineage and checks new connector and foreign-key constraints', () => {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t18-upgrade-'));
  const filename = join(dir, 'source.sqlite');
  const sourceMigrations = new URL('../../packages/storage/migrations/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', sourceMigrations), 'utf8')) as MigrationEntry[];
  const migrationIndex = manifest.findIndex((entry) => entry.file === '0020_http_sources.sql');
  expect(migrationIndex).toBeGreaterThan(0);
  const previousManifest = manifest.slice(0, migrationIndex);
  const now = '2026-11-17T00:00:00.000Z';
  try {
    const prior = openDatabase(filename, { manifest: previousManifest });
    try {
      prior.prepare(`INSERT INTO source_configs VALUES ('before','owner','personal','directory','/test/root','/test/root',
        '{}','[]',NULL,'daily','none',0,1,'enabled',1,'1.0',?,?)`).run(now, now);
      prior.prepare(`INSERT INTO source_versions VALUES ('before',1,'owner','personal','directory','/test/root','/test/root',
        '{}','[]',NULL,'daily','none',0,1,'enabled','1.0',?)`).run(now);
      prior.prepare("INSERT INTO source_objects VALUES ('before','o-1','evidence.txt','source',1,1)").run();
      prior.prepare(`INSERT INTO source_revisions VALUES ('before','o-1',1,'before-r1',NULL,'source',1,'owner','personal','1.0',?)`).run(now);
      prior.prepare(`INSERT INTO collection_receipts VALUES ('before-c1','before',1,'success','cursor',0,NULL,?,1,NULL)`).run(now);
    } finally { prior.close(); }
    const after = openDatabase(filename, { manifest });
    try {
      expect(after.pragma('foreign_key_check')).toEqual([]);
      expect(after.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(after.prepare("SELECT locator FROM source_objects WHERE source_id='before'").get()).toEqual({ locator: 'evidence.txt' });
      expect(after.prepare("SELECT revision_id FROM source_revisions WHERE source_id='before'").get()).toEqual({ revision_id: 'before-r1' });
      expect(after.prepare("SELECT event_id FROM collection_receipts WHERE source_id='before'").get()).toEqual({ event_id: 'before-c1' });
      after.prepare(`INSERT INTO source_configs VALUES ('rss','owner','personal','rss','https://feed.example.test/news',
        'https://feed.example.test/news','{}','[]',NULL,'daily','none',0,1,'enabled',1,'1.0',?,?)`).run(now, now);
      expect(() => after.prepare("INSERT INTO source_objects VALUES ('wrong','object','route','source',0,0)").run()).toThrow(/FOREIGN KEY/u);
    } finally { after.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
