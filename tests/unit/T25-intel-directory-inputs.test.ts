import { createHash } from 'node:crypto';
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const helperUrl = new URL('../native/intel-directory-fixture/stage-inputs.mjs', import.meta.url);
const fixtureUrl = new URL('../native/intel-directory-fixture/', import.meta.url);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const layout = [
  ['directory-module.cc', 'source/directory-module.cc'],
  ['node_api.h', 'node/node_api.h'],
  ['node_api_types.h', 'node/node_api_types.h'],
  ['js_native_api.h', 'node/js_native_api.h'],
  ['js_native_api_types.h', 'node/js_native_api_types.h'],
  ['stdbool.h', 'standard/stdbool.h'],
  ['stddef.h', 'standard/stddef.h'],
  ['stdint.h', 'standard/stdint.h'],
  ['abi-check.h', 'checks/abi-check.h'],
] as const;
type Entry = { name: string; bytes: Uint8Array };
type Pin = { name: string; destination: string; bytes: number; sha256: string };
const dirs: string[] = [];

async function helper() {
  expect(existsSync(fileURLToPath(helperUrl)), 'missing offline input staging helper').toBe(true);
  return import(helperUrl.href);
}
function parent() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'patrick-intel-stage-'));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
}
function sample() {
  const entries: Entry[] = layout.map(([name]) => ({ name, bytes: Buffer.from(`synthetic ${name}\n`) }));
  const pins: Pin[] = entries.map((entry, i) => ({ name: entry.name, destination: layout[i][1],
    bytes: entry.bytes.length, sha256: sha(entry.bytes) }));
  return { entries, pins };
}
function files(root: string): string[] {
  function walk(path: string, prefix: string): string[] {
    return readdirSync(path, { withFileTypes: true }).flatMap(item => {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      const absolute = join(path, item.name);
      if (item.isDirectory()) {
        expect(lstatSync(absolute).mode & 0o777).toBe(0o700);
        return walk(absolute, relative);
      }
      expect(item.isFile()).toBe(true);
      expect(lstatSync(absolute).mode & 0o777).toBe(0o600);
      return [relative];
    });
  }
  expect(lstatSync(root).mode & 0o777).toBe(0o700);
  return walk(root, '').sort();
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('stages exactly the nine checked byte snapshots into a private child', async () => {
  const { stageSyntheticInputs } = await helper();
  const dir = parent(), { entries, pins } = sample();
  const original = entries.map(entry => Buffer.from(entry.bytes));
  const result = stageSyntheticInputs(entries, dir, pins, { afterCopy: () => entries.forEach(entry => entry.bytes.fill(0)) });
  expect(result.status).toBe('staged');
  expect(dirname(result.directory)).toBe(dir);
  expect(files(result.directory)).toEqual(layout.map(([, destination]) => destination).sort());
  for (let i = 0; i < pins.length; i += 1) {
    expect(readFileSync(join(result.directory, pins[i].destination))).toEqual(original[i]);
  }
});

it('rejects duplicate, missing, extra and malformed entries before writing', async () => {
  const { stageSyntheticInputs } = await helper();
  const dir = parent(), { entries, pins } = sample();
  const invalid = [entries.slice(1), [...entries, entries[0]], entries.map((entry, i) => i === 1 ? entries[0] : entry),
    entries.map((entry, i) => i === 0 ? { ...entry, name: '../escape' } : entry),
    entries.map((entry, i) => i === 0 ? { ...entry, note: 'extra' } : entry),
    entries.map((entry, i) => i === 0 ? { ...entry, name: 'x'.repeat(129) } : entry),
    entries.map((entry, i) => i === 0 ? { ...entry, bytes: 'not-bytes' } : entry)];
  for (const value of invalid) {
    expect(() => stageSyntheticInputs(value, dir, pins)).toThrow('INTEL_INPUT_INVALID');
    expect(readdirSync(dir)).toEqual([]);
  }
});

it('reads indexed entry data without invoking an alternate array iterator', async () => {
  const { stageSyntheticInputs } = await helper();
  const dir = parent(), { entries, pins } = sample();
  Object.defineProperty(entries, Symbol.iterator, { value: () => { throw new Error('unexpected iterator'); } });
  const result = stageSyntheticInputs(entries, dir, pins);
  expect(result.status).toBe('staged');
  expect(files(result.directory)).toEqual(layout.map(([, destination]) => destination).sort());
});

it('rejects an indexed accessor without invoking it', async () => {
  const { stageSyntheticInputs } = await helper();
  const dir = parent(), { entries, pins } = sample();
  const first = entries[0];
  let reads = 0;
  Object.defineProperty(entries, '0', { configurable: true, get() { reads += 1; return first; } });
  expect(() => stageSyntheticInputs(entries, dir, pins)).toThrow('INTEL_INPUT_INVALID');
  expect(reads).toBe(0);
  expect(readdirSync(dir)).toEqual([]);
});

it('copies real typed-array bytes without consulting shadowed metadata', async () => {
  const { stageSyntheticInputs } = await helper();
  const dir = parent(), { entries, pins } = sample();
  const bytes = Uint8Array.from(entries[0].bytes);
  Object.defineProperty(bytes, 'byteLength', { get() { throw new Error('unexpected length property'); } });
  Object.defineProperty(bytes, 'buffer', { get() { throw new Error('unexpected buffer property'); } });
  entries[0] = { ...entries[0], bytes };
  const result = stageSyntheticInputs(entries, dir, pins);
  expect(result.status).toBe('staged');
  expect(sha(readFileSync(join(result.directory, pins[0].destination)))).toBe(pins[0].sha256);
});

it('rejects a shared backing store even if the public buffer property is shadowed', async () => {
  const { stageSyntheticInputs } = await helper();
  const dir = parent(), { entries, pins } = sample();
  const shared = new Uint8Array(new SharedArrayBuffer(entries[0].bytes.length));
  shared.set(entries[0].bytes);
  Object.defineProperty(shared, 'buffer', { value: new ArrayBuffer(shared.length) });
  entries[0] = { ...entries[0], bytes: shared };
  expect(() => stageSyntheticInputs(entries, dir, pins)).toThrow('INTEL_INPUT_INVALID');
  expect(readdirSync(dir)).toEqual([]);
});

it('rejects lengths, digests and oversized entries before creating a child', async () => {
  const { stageSyntheticInputs } = await helper();
  const dir = parent(), { entries, pins } = sample();
  const wrongLength = entries.map((entry, i) => i === 0 ? { ...entry, bytes: Buffer.concat([entry.bytes, Buffer.from('x')]) } : entry);
  const wrongDigest = entries.map((entry, i) => i === 0 ? { ...entry, bytes: Buffer.alloc(entry.bytes.length, 65) } : entry);
  for (const value of [wrongLength, wrongDigest]) {
    expect(() => stageSyntheticInputs(value, dir, pins)).toThrow('INTEL_INPUT_INVALID');
    expect(readdirSync(dir)).toEqual([]);
  }
  const huge = entries.map((entry, i) => i === 0 ? { ...entry, bytes: Buffer.alloc(1024 * 1024) } : entry);
  const hugePins = pins.map((pin, i) => i === 0 ? { ...pin, bytes: huge[0].bytes.length, sha256: sha(huge[0].bytes) } : pin);
  expect(() => stageSyntheticInputs(huge, dir, hugePins)).toThrow('INTEL_INPUT_INVALID');
  expect(readdirSync(dir)).toEqual([]);
  const many = entries.map(entry => ({ ...entry, bytes: Buffer.alloc(32 * 1024, 7) }));
  const manyPins = pins.map((pin, i) => ({ ...pin, bytes: many[i].bytes.length, sha256: sha(many[i].bytes) }));
  expect(() => stageSyntheticInputs(many, dir, manyPins)).toThrow('INTEL_INPUT_INVALID');
  expect(readdirSync(dir)).toEqual([]);
});

it('rejects an unsafe destination even in the test-only synthetic seam', async () => {
  const { stageSyntheticInputs } = await helper();
  const dir = parent(), { entries, pins } = sample();
  const wrong = pins.map((pin, i) => i === 0 ? { ...pin, destination: '../existing' } : pin);
  expect(() => stageSyntheticInputs(entries, dir, wrong)).toThrow('INTEL_INPUT_INVALID');
  expect(readdirSync(dir)).toEqual([]);
});

it('does not accept caller-selected pins through the approved wrapper', async () => {
  const { stageApprovedInputs } = await helper();
  const dir = parent(), { entries, pins } = sample();
  expect(() => stageApprovedInputs(entries, dir, pins)).toThrow('INTEL_INPUT_INVALID');
  expect(readdirSync(dir)).toEqual([]);
});

it('rejects a rewritten manifest even when it matches supplied bytes', async () => {
  const dir = parent(), { entries, pins } = sample();
  const copy = join(dir, 'copy'), destination = join(dir, 'destination');
  mkdirSync(copy, { mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  copyFileSync(fileURLToPath(helperUrl), join(copy, 'stage-inputs.mjs'));
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixtureUrl), 'utf8')) as { inputs: Pin[] };
  manifest.inputs = pins;
  writeFileSync(join(copy, 'manifest.json'), JSON.stringify(manifest));
  const subject = await import(pathToFileURL(join(copy, 'stage-inputs.mjs')).href);
  expect(() => subject.stageApprovedInputs(entries, destination)).toThrow('INTEL_INPUT_INVALID');
  expect(readdirSync(destination)).toEqual([]);
});

it('rejects a linked manifest before staging even when its target has the pinned bytes', async () => {
  const dir = parent(), { entries, pins } = sample();
  const copy = join(dir, 'copy'), destination = join(dir, 'destination');
  mkdirSync(copy, { mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixtureUrl), 'utf8')) as { inputs: Pin[] };
  manifest.inputs = pins;
  const contents = Buffer.from(JSON.stringify(manifest));
  const original = readFileSync(helperUrl, 'utf8');
  const altered = original.replace(/const reviewedManifestSha256 = '[a-f0-9]{64}';/u,
    `const reviewedManifestSha256 = '${sha(contents)}';`);
  expect(altered).not.toBe(original);
  writeFileSync(join(copy, 'stage-inputs.mjs'), altered);
  writeFileSync(join(copy, 'synthetic-manifest.json'), contents);
  symlinkSync('synthetic-manifest.json', join(copy, 'manifest.json'));
  const subject = await import(pathToFileURL(join(copy, 'stage-inputs.mjs')).href);
  expect(() => subject.stageApprovedInputs(entries, destination)).toThrow('INTEL_INPUT_INVALID');
  expect(readdirSync(destination)).toEqual([]);
});

it('rejects an oversized manifest without reading its contents', async () => {
  const dir = parent(), { entries } = sample();
  const copy = join(dir, 'copy'), destination = join(dir, 'destination');
  mkdirSync(copy, { mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  const bridge = `import * as fs from 'node:fs';\nexport * from 'node:fs';\n` +
    `export const reads = [];\n` +
    `export function readFileSync(...args) { reads.push('readFileSync'); return fs.readFileSync(...args); }\n` +
    `export function readSync(...args) { reads.push('readSync'); return fs.readSync(...args); }\n`;
  writeFileSync(join(copy, 'fs-bridge.mjs'), bridge);
  const original = readFileSync(helperUrl, 'utf8');
  const altered = original.replace("from 'node:fs'", "from './fs-bridge.mjs'");
  expect(altered).not.toBe(original);
  writeFileSync(join(copy, 'stage-inputs.mjs'), altered);
  writeFileSync(join(copy, 'manifest.json'), Buffer.alloc(32 * 1024 + 1, 32));
  const calls = await import(pathToFileURL(join(copy, 'fs-bridge.mjs')).href);
  const subject = await import(pathToFileURL(join(copy, 'stage-inputs.mjs')).href);
  expect(() => subject.stageApprovedInputs(entries, destination)).toThrow('INTEL_INPUT_INVALID');
  expect(calls.reads).toEqual([]);
  expect(readdirSync(destination)).toEqual([]);
});

it('opens the manifest with nonblocking and no-follow flags before checking its type', async () => {
  const dir = parent(), { entries } = sample();
  const copy = join(dir, 'copy'), destination = join(dir, 'destination');
  mkdirSync(copy, { mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  const bridge = `import * as fs from 'node:fs';\nexport * from 'node:fs';\n` +
    `export const opens = [];\n` +
    `export function openSync(...args) { opens.push(args[1]); return fs.openSync(...args); }\n`;
  writeFileSync(join(copy, 'fs-bridge.mjs'), bridge);
  const original = readFileSync(helperUrl, 'utf8');
  const altered = original.replace("from 'node:fs'", "from './fs-bridge.mjs'");
  expect(altered).not.toBe(original);
  writeFileSync(join(copy, 'stage-inputs.mjs'), altered);
  copyFileSync(fileURLToPath(new URL('manifest.json', fixtureUrl)), join(copy, 'manifest.json'));
  const calls = await import(pathToFileURL(join(copy, 'fs-bridge.mjs')).href);
  const subject = await import(pathToFileURL(join(copy, 'stage-inputs.mjs')).href);
  expect(() => subject.stageApprovedInputs(entries, destination)).toThrow('INTEL_INPUT_INVALID');
  expect(calls.opens).toHaveLength(1);
  expect(calls.opens[0] & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
  expect(calls.opens[0] & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
  expect(readdirSync(destination)).toEqual([]);
});

it('refuses a runtime without nonblocking opens before touching the manifest', async () => {
  const dir = parent(), { entries } = sample();
  const copy = join(dir, 'copy'), destination = join(dir, 'destination');
  mkdirSync(copy, { mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  const bridge = `import * as fs from 'node:fs';\nexport * from 'node:fs';\n` +
    `export const constants = { ...fs.constants, O_NONBLOCK: 0 };\n` +
    `export const opens = [];\n` +
    `export function openSync(...args) { opens.push(args[1]); return fs.openSync(...args); }\n`;
  writeFileSync(join(copy, 'fs-bridge.mjs'), bridge);
  const original = readFileSync(helperUrl, 'utf8');
  const altered = original.replace("from 'node:fs'", "from './fs-bridge.mjs'");
  expect(altered).not.toBe(original);
  writeFileSync(join(copy, 'stage-inputs.mjs'), altered);
  copyFileSync(fileURLToPath(new URL('manifest.json', fixtureUrl)), join(copy, 'manifest.json'));
  const calls = await import(pathToFileURL(join(copy, 'fs-bridge.mjs')).href);
  const subject = await import(pathToFileURL(join(copy, 'stage-inputs.mjs')).href);
  expect(() => subject.stageApprovedInputs(entries, destination)).toThrow('INTEL_INPUT_INVALID');
  expect(calls.opens).toEqual([]);
  expect(readdirSync(destination)).toEqual([]);
});

it('opens staged files nonblocking before verifying their contents', async () => {
  const dir = parent(), { entries, pins } = sample();
  const copy = join(dir, 'copy'), destination = join(dir, 'destination');
  mkdirSync(copy, { mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  const bridge = `import * as fs from 'node:fs';\nexport * from 'node:fs';\n` +
    `export const opens = [];\n` +
    `export function openSync(...args) { opens.push(args[1]); return fs.openSync(...args); }\n`;
  writeFileSync(join(copy, 'fs-bridge.mjs'), bridge);
  const original = readFileSync(helperUrl, 'utf8');
  const altered = original.replace("from 'node:fs'", "from './fs-bridge.mjs'");
  expect(altered).not.toBe(original);
  writeFileSync(join(copy, 'stage-inputs.mjs'), altered);
  const calls = await import(pathToFileURL(join(copy, 'fs-bridge.mjs')).href);
  const subject = await import(pathToFileURL(join(copy, 'stage-inputs.mjs')).href);
  expect(subject.stageSyntheticInputs(entries, destination, pins).status).toBe('staged');
  const reads = calls.opens.filter((flags: number) => (flags & 3) === constants.O_RDONLY);
  expect(reads).toHaveLength(9);
  for (const flags of reads) {
    expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
  }
});

it('refuses a symlink or non-private parent', async () => {
  const { stageSyntheticInputs } = await helper();
  const dir = parent(), { entries, pins } = sample();
  const alias = `${dir}-alias`;
  symlinkSync(dir, alias);
  dirs.push(alias);
  expect(() => stageSyntheticInputs(entries, alias, pins)).toThrow('INTEL_STAGE_FAILED');
  chmodSync(dir, 0o755);
  expect(() => stageSyntheticInputs(entries, dir, pins)).toThrow('INTEL_STAGE_FAILED');
  chmodSync(dir, 0o1700);
  expect(() => stageSyntheticInputs(entries, dir, pins)).toThrow('INTEL_STAGE_FAILED');
  expect(readdirSync(dir)).toEqual([]);
});

it('cleans only its new child after a write failure and redacts the error', async () => {
  const { stageSyntheticInputs } = await helper();
  const dir = parent(), { entries, pins } = sample();
  writeFileSync(join(dir, 'pre-existing'), 'keep', { mode: 0o600 });
  expect(() => stageSyntheticInputs(entries, dir, pins, { beforeWrite: (index: number) => {
    if (index === 3) throw new Error('sensitive synthetic failure');
  } })).toThrow(/^INTEL_STAGE_FAILED$/u);
  expect(readdirSync(dir)).toEqual(['pre-existing']);
  expect(readFileSync(join(dir, 'pre-existing'), 'utf8')).toBe('keep');
});

it('refuses collisions with an exclusive create and removes its own child', async () => {
  const { stageSyntheticInputs } = await helper();
  const dir = parent(), { entries, pins } = sample();
  expect(() => stageSyntheticInputs(entries, dir, pins, { beforeWrite: (_index: number, destination: string) => {
    if (destination.endsWith('/source/directory-module.cc')) symlinkSync('/no-such-target', destination);
  } })).toThrow(/^INTEL_STAGE_FAILED$/u);
  expect(readdirSync(dir)).toEqual([]);
});

it('rejects unexpected staged paths and cleans up the new child', async () => {
  const { stageSyntheticInputs } = await helper();
  const dir = parent(), { entries, pins } = sample();
  expect(() => stageSyntheticInputs(entries, dir, pins, { beforeWrite: (index: number, destination: string) => {
    if (index === 1) writeFileSync(join(dirname(destination), 'unexpected'), 'fixture');
  } })).toThrow(/^INTEL_STAGE_FAILED$/u);
  expect(readdirSync(dir)).toEqual([]);
});

it('pins the source and fixture headers while recording official archive member provenance', async () => {
  await helper();
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixtureUrl), 'utf8')) as {
    source: { path: string; gitBlob: string }; archive: { name: string; bytes: number; sha256: string };
    inputs: Array<Pin & { archivePath?: string }>;
  };
  expect(manifest.archive).toEqual({ name: 'node-v24.9.0-headers.tar.xz', bytes: 577884,
    sha256: '4db1e4f2bc0a1787810a24a54e351e3e49889a13cbf987041a5d462c157fbf48' });
  expect(manifest.inputs.map(row => [row.name, row.destination])).toEqual(layout.map(row => [...row]));
  const source = readFileSync(new URL('../../packages/integrations/sources/native/directory-module.cc', import.meta.url));
  const sourcePin = manifest.inputs.find(row => row.name === 'directory-module.cc')!;
  expect(sourcePin).toMatchObject({ bytes: source.length, sha256: sha(source) });
  expect(createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex')).toBe(manifest.source.gitBlob);
  for (const name of ['stdbool.h', 'stddef.h', 'stdint.h', 'abi-check.h']) {
    const bytes = readFileSync(new URL(name, fixtureUrl));
    expect(manifest.inputs.find(row => row.name === name)).toMatchObject({ bytes: bytes.length, sha256: sha(bytes) });
  }
  const archived = manifest.inputs.filter(row => row.archivePath);
  expect(archived.map(row => row.archivePath)).toEqual(['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h']
    .map(name => `node-v24.9.0/include/node/${name}`));
});

it('declares absent byte-order macros an error in the uncompiled ABI fixture', () => {
  const abi = readFileSync(new URL('abi-check.h', fixtureUrl), 'utf8');
  expect(abi).toMatch(/#if !defined\(__BYTE_ORDER__\) \|\| !defined\(__ORDER_LITTLE_ENDIAN__\)\s*\n#error/u);
});
