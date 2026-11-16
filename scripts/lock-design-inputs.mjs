import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const assets = 'docs/designs/设计资产/v2/';
const files = [
  'docs/designs/PAtrick产品设计.md',
  'docs/designs/PAtrick技术设计-v2.md',
  ...['交互原型.html', '设计令牌.css', 'Figma交付记录.json',
    'Figma-界面核对.json', '原型验证.json', 'icons/manifest.json'].map(name => assets + name),
];
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const inventory = JSON.parse(readFileSync(assets + 'Figma交付记录.json', 'utf8'));
const frames = inventory.screenInventory.map(({ key, id }) => ({ key, id })).sort((a, b) => a.key.localeCompare(b.key, 'en'));
assert.equal(frames.length, 292);
assert.equal(new Set(frames.map(({ id }) => id)).size, frames.length);
assert.equal(inventory.exports.length, 65);
for (const entry of inventory.exports) assert.equal(hash(assets + entry.asset), entry.sha256, entry.asset);
const content = JSON.stringify({
  files: Object.fromEntries(files.map(path => [path, hash(path)])),
  frames, exports: inventory.exports,
}, null, 2) + '\n';
if (process.argv.includes('--check')) assert.equal(readFileSync('design-inputs.lock.json', 'utf8'), content);
else writeFileSync('design-inputs.lock.json', content);
console.log(frames.length + ' frames / ' + inventory.exports.length + ' exports');