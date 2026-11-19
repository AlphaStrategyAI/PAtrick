// This helper is only for offline tests; it does not read archives, compile or
// establish that a later tool consumes these bytes.
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readSync, readdirSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const reviewedManifestSha256 = '444f23e3c6b640a0bef3cc051d513d8eb7dec1fc80f49a11f7669d0273d1b683';
const layout = Object.freeze([
  ['directory-module.cc', 'source/directory-module.cc'],
  ['node_api.h', 'node/node_api.h'],
  ['node_api_types.h', 'node/node_api_types.h'],
  ['js_native_api.h', 'node/js_native_api.h'],
  ['js_native_api_types.h', 'node/js_native_api_types.h'],
  ['stdbool.h', 'standard/stdbool.h'],
  ['stddef.h', 'standard/stddef.h'],
  ['stdint.h', 'standard/stdint.h'],
  ['abi-check.h', 'checks/abi-check.h'],
]);
const maxEntry = 64 * 1024;
const maxTotal = 256 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inputFailure = () => new Error('INTEL_INPUT_INVALID');
const stageFailure = () => new Error('INTEL_STAGE_FAILED');
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength').get;
const typedOffset = Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset').get;
const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer').get;
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const typedSet = typedPrototype.set;

function ownData(object, name) {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  if (!descriptor || !('value' in descriptor)) throw inputFailure();
  return descriptor.value;
}

function pinsForLayout(pins) {
  if (!Array.isArray(pins) || ownData(pins, 'length') !== layout.length) throw inputFailure();
  let total = 0;
  const result = [];
  for (let index = 0; index < layout.length; index += 1) {
    const pin = ownData(pins, String(index));
    const [name, destination] = layout[index];
    if (!pin || typeof pin !== 'object') throw inputFailure();
    const pinName = ownData(pin, 'name'), pinDestination = ownData(pin, 'destination');
    const bytes = ownData(pin, 'bytes'), sha256 = ownData(pin, 'sha256');
    if (pinName !== name || pinDestination !== destination || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > maxEntry ||
        typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)) throw inputFailure();
    total += bytes;
    if (total > maxTotal) throw inputFailure();
    result.push({ name, destination, bytes, sha256 });
  }
  return result;
}

function reviewedPins() {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0 ||
      !Number.isInteger(constants.O_NONBLOCK) || constants.O_NONBLOCK === 0) throw inputFailure();
  const fd = openSync(new URL('manifest.json', import.meta.url), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let manifest;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > 32 * 1024) throw inputFailure();
    const buffer = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const n = readSync(fd, buffer, count, buffer.length - count, null);
      if (!n) break;
      count += n;
    }
    const bytes = buffer.subarray(0, count);
    if (count !== info.size || fstatSync(fd).size !== info.size || sha(bytes) !== reviewedManifestSha256) throw inputFailure();
    manifest = JSON.parse(bytes.toString('utf8'));
  } finally { closeSync(fd); }
  if (manifest?.version !== '1.0' || manifest.kind !== 'test-only-intel-directory-inputs') throw inputFailure();
  return pinsForLayout(manifest.inputs);
}

function viewLength(value) {
  if (!(value instanceof Uint8Array)) throw inputFailure();
  const length = Reflect.apply(typedLength, value, []);
  const offset = Reflect.apply(typedOffset, value, []);
  const buffer = Reflect.apply(typedBuffer, value, []);
  const capacity = Reflect.apply(arrayBufferLength, buffer, []);
  if (!Number.isSafeInteger(length) || !Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > capacity) {
    throw inputFailure();
  }
  return length;
}

function copiedInputs(entries, pins) {
  if (!Array.isArray(entries) || ownData(entries, 'length') !== layout.length) throw inputFailure();
  const seen = new Set();
  const rows = [];
  for (let index = 0; index < layout.length; index += 1) {
    const entry = ownData(entries, String(index));
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw inputFailure();
    const keys = Reflect.ownKeys(entry);
    if (keys.length !== 2 || !keys.includes('name') || !keys.includes('bytes')) throw inputFailure();
    const name = ownData(entry, 'name'), bytes = ownData(entry, 'bytes');
    if (typeof name !== 'string' || name.length > 128 || seen.has(name) || !pins.some(pin => pin.name === name)) throw inputFailure();
    const length = viewLength(bytes);
    seen.add(name);
    rows.push([name, { bytes, length }]);
  }
  if (seen.size !== layout.length) throw inputFailure();
  const byName = new Map(rows);
  let total = 0;
  for (const pin of pins) {
    const value = byName.get(pin.name);
    if (!value || value.length !== pin.bytes || value.length > maxEntry) throw inputFailure();
    total += value.length;
    if (total > maxTotal) throw inputFailure();
  }
  return pins.map(pin => {
    const bytes = Buffer.alloc(pin.bytes);
    Reflect.apply(typedSet, bytes, [byName.get(pin.name).bytes]);
    if (bytes.length !== pin.bytes || sha(bytes) !== pin.sha256) throw inputFailure();
    return { ...pin, content: bytes };
  });
}

function privateParent(parent) {
  if (typeof parent !== 'string' || !isAbsolute(parent) || resolve(parent) !== parent || realpathSync(parent) !== parent) {
    throw stageFailure();
  }
  const info = lstatSync(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o7777) !== 0o700 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw stageFailure();
}

function writeExclusive(path, bytes) {
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600) throw stageFailure();
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(fd, bytes, written, bytes.length - written);
      if (count <= 0) throw stageFailure();
      written += count;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function verifyStaged(child, inputs) {
  const names = ['checks', 'node', 'source', 'standard'];
  if (readdirSync(child).sort().join('\0') !== names.join('\0')) throw stageFailure();
  for (const name of names) {
    const dir = join(child, name);
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o7777) !== 0o700) throw stageFailure();
    const expected = inputs.filter(input => input.destination.startsWith(`${name}/`))
      .map(input => input.destination.slice(name.length + 1)).sort();
    if (readdirSync(dir).sort().join('\0') !== expected.join('\0')) throw stageFailure();
  }
  for (const input of inputs) {
    const path = join(child, input.destination);
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o7777) !== 0o600) throw stageFailure();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size !== input.bytes || (info.mode & 0o7777) !== 0o600) throw stageFailure();
      const bytes = Buffer.alloc(input.bytes + 1);
      let count = 0;
      while (count < bytes.length) {
        const n = readSync(fd, bytes, count, bytes.length - count, null);
        if (!n) break;
        count += n;
      }
      if (count !== input.bytes || fstatSync(fd).size !== input.bytes || sha(bytes.subarray(0, count)) !== input.sha256) throw stageFailure();
    } finally { closeSync(fd); }
  }
}

function stage(entries, parent, suppliedPins, hooks) {
  let inputs;
  try { inputs = copiedInputs(entries, pinsForLayout(suppliedPins)); }
  catch { throw inputFailure(); }
  let child;
  try {
    hooks?.afterCopy?.();
    privateParent(parent);
    if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0 ||
        !Number.isInteger(constants.O_NONBLOCK) || constants.O_NONBLOCK === 0) throw stageFailure();
    child = mkdtempSync(join(parent, 'intel-inputs-'));
    chmodSync(child, 0o700);
    const created = lstatSync(child);
    if (realpathSync(child) !== child || !created.isDirectory() || created.isSymbolicLink() ||
        (created.mode & 0o7777) !== 0o700 || (typeof process.getuid === 'function' && created.uid !== process.getuid())) throw stageFailure();
    for (const name of ['checks', 'node', 'source', 'standard']) {
      const path = join(child, name);
      mkdirSync(path, { mode: 0o700 });
      chmodSync(path, 0o700);
    }
    inputs.forEach((input, index) => {
      const path = join(child, input.destination);
      hooks?.beforeWrite?.(index, path);
      writeExclusive(path, input.content);
    });
    verifyStaged(child, inputs);
    return Object.freeze({ status: 'staged', directory: child });
  } catch {
    try { if (child) rmSync(child, { recursive: true, force: true }); }
    catch { throw new Error('INTEL_STAGE_CLEANUP_FAILED'); }
    throw stageFailure();
  }
}

// The reviewed wrapper never accepts a manifest, destination or hook argument.
export function stageApprovedInputs(entries, parent) {
  let pins;
  try { pins = reviewedPins(); } catch { throw inputFailure(); }
  return stage(entries, parent, pins);
}

// Only tests import this seam. Layout and destinations remain fixed even here.
export function stageSyntheticInputs(entries, parent, pins, hooks) {
  return stage(entries, parent, pins, hooks);
}
