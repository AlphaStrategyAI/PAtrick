import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

test('pinned-design-inputs', () => {
  const lock = JSON.parse(readFileSync('design-inputs.lock.json', 'utf8'));
  assert.equal(new Set(lock.frames.map(({ id }) => id)).size, 292);
  assert.equal(lock.exports.length, 65);
  assert.match(execFileSync(process.execPath, ['scripts/lock-design-inputs.mjs', '--check'], { encoding: 'utf8' }), /292 frames \/ 65 exports/);
});