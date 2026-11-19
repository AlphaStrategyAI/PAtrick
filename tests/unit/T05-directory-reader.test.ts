import { expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDirectory, readDirectoryFile, safeComponents } from '../../packages/integrations/sources/directory-reader.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-directory-reader-'));
  mkdirSync(join(root, 'notes'));
  writeFileSync(join(root, 'notes', 'a.md'), 'alpha\n');
  writeFileSync(join(root, 'b.md'), 'beta\n');
  symlinkSync('/etc/passwd', join(root, 'escape.md'));
  return root;
}

test('the reader lists the approved files and never the link', async () => {
  const root = fixture();
  const listing = await listDirectory(root, []);
  expect(listing.state).toBe('ready');
  expect(listing.entries.map((entry) => entry.relativePath).sort()).toEqual(['b.md', 'notes/a.md']);
});

test('the reader refuses a path that leaves the approved root', () => {
  expect(safeComponents('../outside')).toBeNull();
  expect(safeComponents('/etc/passwd')).toBeNull();
  expect(safeComponents('notes/a.md')).toEqual(['notes', 'a.md']);
});

test('the reader reads a file and refuses to read outside the root', async () => {
  const root = fixture();
  const listing = await listDirectory(root, []);
  const entry = listing.entries.find((candidate) => candidate.relativePath === 'b.md');
  expect(entry).toBeDefined();
  const read = await readDirectoryFile(entry!);
  expect(read.state).toBe('read');
  if (read.state === 'read') expect(Buffer.from(read.bytes).toString('utf8')).toBe('beta\n');
  const escaped = { ...entry!, relativePath: 'escape.md', name: 'escape.md' };
  const refused = await readDirectoryFile(escaped);
  expect(refused.state).toBe('rejected');
});
