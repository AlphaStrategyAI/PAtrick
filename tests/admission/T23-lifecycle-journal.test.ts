import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { buildSync } from 'esbuild';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmodSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { canonical, digest } from '../../packages/host/src/recovery/files.js';
import { createLifecycleJournal, createLifecycleJournalReader, type LifecycleEvidenceSubject,
  type LifecycleRegistration, type LifecycleRequest } from '../../deploy/runtime/lifecycle-journal.js';

const syncBoundary = vi.hoisted(() => ({ after: undefined as ((fd: number) => void) | undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, fsyncSync(fd: number) {
    fs.fsyncSync(fd);
    syncBoundary.after?.(fd);
  } };
});

const clean: string[] = [];
afterEach(() => { for (const path of clean.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 't23-lifecycle-'));
  clean.push(base);
  const path = join(base, 'journal');
  mkdirSync(path, { mode: 0o700 });
  const stat = statSync(path);
  const keys = generateKeyPairSync('ed25519');
  const authority = { keyId: 'fixture-journal', async verify(bytes: Uint8Array, signature: string, keyId: string) {
    return keyId === this.keyId && verify(null, bytes, keys.publicKey, Buffer.from(signature, 'base64'));
  } };
  const signer = { async sign(bytes: Uint8Array) { return sign(null, bytes, keys.privateKey).toString('base64'); } };
  const releaseSha256 = digest('release fixture');
  const plan = { command: 'install' as const, targetId: 'release-one', expectedGeneration: null, nextGeneration: 'gen-one',
    planSha256: digest(canonical({ releaseSha256, origin: 'https://fixture.invalid' })), releaseSha256 };
  const registration: LifecycleRegistration = {
    root: { path, device: stat.dev, inode: stat.ino },
    identity: { installationId: 'fixture-install', accountId: 'account', scopeId: 'scope', deviceId: 'device',
      configRevision: 'rev-one', domains: ['personal'] }, plan, authority,
    evidence: { version: 'fixture-proof-v1', async observe(subject: LifecycleEvidenceSubject, evidenceId: string) {
      const bytes = readFileSync(join(base, 'native-readback'));
      if (bytes.toString() !== canonical({ subject, evidenceId })) throw new Error('native readback mismatch');
      return { evidenceId, claimSha256: subject.claimSha256, evidenceSha256: digest(bytes) };
    } },
  };
  const request: LifecycleRequest = { operationId: 'op-one', command: 'install', targetId: plan.targetId,
    planSha256: plan.planSha256, expectedGeneration: null };
  return { base, registration, request, signer, keys,
    writer: () => createLifecycleJournal(() => registration, signer),
    reader: () => createLifecycleJournalReader(() => registration),
    recordEvidence(subject: LifecycleEvidenceSubject, evidenceId: string) {
      writeFileSync(join(base, 'native-readback'), canonical({ subject, evidenceId }));
    } };
}

test('concurrent controllers share one durable claim and only its owner can mark observed completion', async () => {
  const f = fixture();
  const first = f.writer(), second = f.writer();
  expect(await first.read(f.request)).toEqual({ status: 'absent' });
  expect(await first.claim(f.request)).toEqual({ status: 'absent' });
  expect(await first.reserve(f.request)).toEqual({ status: 'reserved' });
  expect(await f.reader().read(f.request)).toEqual({ status: 'reserved' });
  const controllers = [first, second];
  const results = await Promise.all(controllers.map((journal) => journal.claim(f.request)));
  expect(results.map(({ status }) => status).sort()).toEqual(['claimed', 'running_or_uncertain']);
  const index = results.findIndex(({ status }) => status === 'claimed');
  const win = results[index];
  if (win.status !== 'claimed') throw new Error('missing claim');
  expect(await f.writer().claim(f.request)).toEqual({ status: 'running_or_uncertain' });
  expect(await controllers[index].readOwnedClaim(win.token)).toEqual(win.subject);
  await expect(controllers[1 - index].readOwnedClaim(win.token)).rejects.toThrow('OWNER');
  await expect(controllers[1 - index].markCompleted(win.token, 'receipt')).rejects.toThrow();
  f.recordEvidence(win.subject, 'receipt');
  const completed = await controllers[index].markCompleted(win.token, 'receipt');
  expect(completed).toMatchObject({ status: 'completed', receipt: { evidenceId: 'receipt' } });
  await expect(controllers[index].readOwnedClaim(win.token)).rejects.toThrow('OWNER');
  expect(await f.reader().read(f.request)).toEqual(completed);
  expect(await f.writer().reserve(f.request)).toEqual(completed);
  expect(await f.writer().claim(f.request)).toEqual(completed);
});

function recordPath(f: ReturnType<typeof fixture>, kind: string) {
  return join(f.registration.root.path, `lifecycle-v1.${f.request.operationId}.${kind}.json`);
}

async function owned(f: ReturnType<typeof fixture>) {
  const journal = f.writer();
  await journal.reserve(f.request);
  const claim = await journal.claim(f.request);
  if (claim.status !== 'claimed') throw new Error('missing fixture claim');
  return { journal, claim };
}

test.each(['installationId', 'accountId', 'scopeId', 'deviceId', 'domains', 'configRevision', 'targetId', 'command',
  'expectedGeneration', 'nextGeneration', 'planSha256', 'releaseSha256', 'evidenceVersion'] as const)(
  'an authenticated reservation cannot move to another registered %s', async (field) => {
    const f = fixture();
    await f.writer().reserve(f.request);
    if (field === 'domains') f.registration.identity.domains = ['work'];
    else if (field === 'evidenceVersion') f.registration.evidence.version = 'proof-v2';
    else if (field === 'command') f.registration.plan.command = f.request.command = 'upgrade';
    else if (field === 'planSha256') f.registration.plan.planSha256 = f.request.planSha256 = digest('different normalized plan');
    else if (field === 'releaseSha256') f.registration.plan.releaseSha256 = digest('different release');
    else if (field === 'targetId' || field === 'expectedGeneration') f.registration.plan[field] = f.request[field] = 'other';
    else if (field === 'nextGeneration') f.registration.plan.nextGeneration = 'other';
    else f.registration.identity[field] = 'other';
    await expect(f.writer().claim(f.request)).rejects.toThrow('BINDING');
    expect(existsSync(recordPath(f, 'claim'))).toBe(false);
  });

test.each(['unknown-command', 'caller-root', 'unregistered-plan', 'unregistered-generation', 'unsafe-id', 'long-id'] as const)(
  'rejects %s before any reservation publication', async (variation) => {
    const f = fixture();
    const changed = { ...f.request };
    if (variation === 'unknown-command') Object.assign(changed, { command: 'restore' });
    if (variation === 'caller-root') Object.assign(changed, { root: f.base });
    if (variation === 'unregistered-plan') changed.planSha256 = digest('other');
    if (variation === 'unregistered-generation') changed.expectedGeneration = 'other';
    if (variation === 'unsafe-id') changed.operationId = '../other';
    if (variation === 'long-id') changed.operationId = 'a'.repeat(81);
    await expect(f.writer().reserve(changed)).rejects.toThrow();
    expect(readdirSync(f.registration.root.path)).toEqual([]);
  });

test.each(['empty-replacement', 'copied-records', 'symlink-ancestor'] as const)(
  'checks originally enrolled physical ancestry on %s', async (what) => {
    const f = fixture();
    const { root } = f.registration;
    if (what === 'copied-records') await f.writer().reserve(f.request);
    let read = f.reader();
    if (what === 'symlink-ancestor') {
      symlinkSync(f.base, join(f.base, 'alias'), 'dir');
      f.registration.root = { ...root, path: join(f.base, 'alias', 'journal') };
      read = f.reader();
    } else {
      renameSync(root.path, join(f.base, 'former'));
      mkdirSync(root.path, { mode: 0o700 });
      if (what === 'copied-records') {
        const [file] = readdirSync(join(f.base, 'former'));
        writeFileSync(join(root.path, file), readFileSync(join(f.base, 'former', file)));
      }
    }
    await expect(read.read(f.request)).rejects.toThrow('ROOT');
    await expect(f.writer().reserve(f.request)).rejects.toThrow('ROOT');
    expect(existsSync(recordPath(f, 'claim'))).toBe(false);
  });

test.each(['symlink-record', 'oversized-record', 'directory-record', 'edited-signature', 'wrong-key', 'cross-id'] as const)(
  'rejects a %s before issuing a token', async (what) => {
    const f = fixture();
    await f.writer().reserve(f.request);
    const path = recordPath(f, 'reservation');
    const bytes = readFileSync(path);
    if (what === 'wrong-key') {
      const other = fixture();
      f.registration.authority = other.registration.authority;
    } else if (what === 'cross-id') {
      f.request.operationId = 'different-op';
      writeFileSync(recordPath(f, 'reservation'), bytes);
    } else {
      unlinkSync(path);
      if (what === 'symlink-record') {
        writeFileSync(join(f.base, 'other'), bytes);
        symlinkSync(join(f.base, 'other'), path);
      }
      if (what === 'oversized-record') writeFileSync(path, Buffer.alloc(1024 * 1024));
      if (what === 'directory-record') mkdirSync(path);
      if (what === 'edited-signature') {
        const envelope = JSON.parse(bytes.toString());
        envelope.signature = 'A'.repeat(88);
        writeFileSync(path, canonical(envelope));
      }
    }
    await expect(f.writer().claim(f.request)).rejects.toThrow();
    expect(existsSync(recordPath(f, 'claim'))).toBe(false);
  });

test('existing claims survive controller loss without reissuing ownership; a missing predecessor cannot heal itself', async () => {
  const f = fixture();
  await owned(f);
  expect(await f.writer().reserve(f.request)).toEqual({ status: 'running_or_uncertain' });
  expect(await f.writer().claim(f.request)).toEqual({ status: 'running_or_uncertain' });
  unlinkSync(recordPath(f, 'reservation'));
  await expect(f.writer().reserve(f.request)).rejects.toThrow('RECORD');
  expect(existsSync(recordPath(f, 'reservation'))).toBe(false);
});

test('a valid signature on a substituted predecessor does not authenticate an existing claim chain', async () => {
  const f = fixture();
  const { journal, claim } = await owned(f);
  const path = recordPath(f, 'reservation');
  const prior = JSON.parse(readFileSync(path, 'utf8'));
  prior.payload.nonce = 'different-reservation';
  prior.signature = await f.signer.sign(Buffer.from(canonical(prior.payload)));
  writeFileSync(path, canonical(prior));
  await expect(f.reader().read(f.request)).rejects.toThrow('RECORD');
  await expect(journal.markCompleted(claim.token, 'receipt')).rejects.toThrow('RECORD');
});

test('interruption after real claim publication grants no token on retry', async () => {
  const f = fixture();
  const authority = f.registration.authority;
  const verifyRecord = authority.verify.bind(authority);
  authority.verify = async (bytes, signature, key) => {
    const valid = await verifyRecord(bytes, signature, key);
    if (JSON.parse(Buffer.from(bytes).toString()).kind === 'claim' && existsSync(recordPath(f, 'claim'))) throw new Error('lost claim response');
    return valid;
  };
  const journal = f.writer();
  await journal.reserve(f.request);
  await expect(journal.claim(f.request)).rejects.toThrow('lost claim response');
  authority.verify = verifyRecord;
  expect(await f.writer().claim(f.request)).toEqual({ status: 'running_or_uncertain' });
});

test('revocation during signing prevents publication', async () => {
  const f = fixture();
  const signRecord = f.signer.sign;
  f.signer.sign = async (bytes) => {
    const signed = await signRecord(bytes);
    if (JSON.parse(Buffer.from(bytes).toString()).kind === 'claim') f.registration.identity.configRevision = 'revoked';
    return signed;
  };
  const journal = f.writer();
  await journal.reserve(f.request);
  await expect(journal.claim(f.request)).rejects.toThrow();
  expect(existsSync(recordPath(f, 'claim'))).toBe(false);
});

test('changed evidence prevents marking and consumes the one owner token', async () => {
  const f = fixture();
  const { journal, claim } = await owned(f);
  f.recordEvidence({ ...claim.subject, claimSha256: digest('other-claim') }, 'receipt');
  await expect(journal.markCompleted(claim.token, 'receipt')).rejects.toThrow('native readback mismatch');
  f.recordEvidence(claim.subject, 'receipt');
  await expect(journal.markCompleted(claim.token, 'receipt')).rejects.toThrow('OWNER');
  expect(await f.reader().read(f.request)).toEqual({ status: 'running_or_uncertain' });
});

test('a lost terminal response is recovered in a public-key-only process with read-only filesystem permission', async () => {
  const f = fixture();
  const verifier = f.registration.evidence.observe;
  f.registration.evidence.observe = async (subject, id) => {
    const receipt = await verifier(subject, id);
    if (existsSync(recordPath(f, 'terminal'))) throw new Error('lost terminal response');
    return receipt;
  };
  const { journal, claim } = await owned(f);
  f.recordEvidence(claim.subject, 'receipt');
  await expect(journal.markCompleted(claim.token, 'receipt')).rejects.toThrow('lost terminal response');
  expect(existsSync(recordPath(f, 'terminal'))).toBe(true);
  const receipt = { evidenceId: 'receipt', claimSha256: claim.subject.claimSha256,
    evidenceSha256: digest(readFileSync(join(f.base, 'native-readback'))) };
  const runner = join(f.base, 'read.mjs');
  buildSync({ bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: runner,
    stdin: { resolveDir: process.cwd(), contents: `
      import { createPublicKey, verify } from 'node:crypto';
      import { readFileSync } from 'node:fs';
      import { canonical, digest } from './packages/host/src/recovery/files.ts';
      import { createLifecycleJournalReader } from './deploy/runtime/lifecycle-journal.ts';
      const { root, identity, plan, request, pem, evidencePath } = JSON.parse(process.argv[2]);
      if (process.permission.has('fs.write', root.path)) throw new Error('Unexpected write permission');
      const key = createPublicKey(pem);
      const registered = { root, identity, plan, authority: { keyId: 'fixture-journal',
        async verify(bytes, signature, id) { return id === this.keyId && verify(null, bytes, key, Buffer.from(signature, 'base64')); }
      }, evidence: { version: 'fixture-proof-v1', async observe(subject, evidenceId) {
        const bytes = readFileSync(evidencePath);
        if (bytes.toString() !== canonical({ subject, evidenceId })) throw new Error('different native evidence');
        return { evidenceId, claimSha256: subject.claimSha256, evidenceSha256: digest(bytes) };
      } } };
      process.stdout.write(JSON.stringify(await createLifecycleJournalReader(() => registered).read(request)));
    ` } });
  const { root, identity, plan } = f.registration;
  const response = spawnSync(process.execPath, ['--permission', '--allow-fs-read=' + f.base, runner,
    JSON.stringify({ root, identity, plan, request: f.request, pem: f.keys.publicKey.export({ format: 'pem', type: 'spki' }),
      evidencePath: join(f.base, 'native-readback') })], { encoding: 'utf8', timeout: 10000 });
  expect(response.status, response.error?.message ?? response.stderr).toBe(0);
  expect(JSON.parse(response.stdout)).toEqual({ status: 'completed', receipt });
  writeFileSync(join(f.base, 'native-readback'), 'corrupt fixture');
  await expect(f.reader().read(f.request)).rejects.toThrow('native readback mismatch');
});

test('read rechecks the exact signed record after the evidence verifier yields', async () => {
  const f = fixture();
  const { journal, claim } = await owned(f);
  f.recordEvidence(claim.subject, 'receipt');
  await journal.markCompleted(claim.token, 'receipt');
  const observe = f.registration.evidence.observe;
  f.registration.evidence.observe = async (subject, id) => {
    const proof = await observe(subject, id);
    renameSync(recordPath(f, 'terminal'), join(f.base, 'old-terminal'));
    writeFileSync(recordPath(f, 'terminal'), 'replacement');
    return proof;
  };
  await expect(f.reader().read(f.request)).rejects.toThrow('RECORD');
});

test('group-writable journal roots cannot confer ownership', async () => {
  const f = fixture();
  chmodSync(f.registration.root.path, 0o770);
  await expect(f.writer().reserve(f.request)).rejects.toThrow('ROOT');
});

test('evidence withdrawn while the terminal is being signed leaves only the original durable claim', async () => {
  const f = fixture();
  const signRecord = f.signer.sign;
  f.signer.sign = async (bytes) => {
    const signature = await signRecord(bytes);
    if (JSON.parse(Buffer.from(bytes).toString()).kind === 'terminal') unlinkSync(join(f.base, 'native-readback'));
    return signature;
  };
  const { journal, claim } = await owned(f);
  f.recordEvidence(claim.subject, 'receipt');
  await expect(journal.markCompleted(claim.token, 'receipt')).rejects.toThrow();
  expect(existsSync(recordPath(f, 'terminal'))).toBe(false);
  expect(await f.reader().read(f.request)).toEqual({ status: 'running_or_uncertain' });
});

test('two processes that have both signed claims race to publish once, then exit without completing', async () => {
  const f = fixture();
  await f.writer().reserve(f.request);
  const runner = join(f.base, 'contend.mjs');
  buildSync({ bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: runner,
    stdin: { resolveDir: process.cwd(), contents: `
      import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
      import { once } from 'node:events';
      import { createLifecycleJournal } from './deploy/runtime/lifecycle-journal.ts';
      const [{ root, identity, plan, request, pem }] = await once(process, 'message');
      const key = createPrivateKey(pem);
      const pub = createPublicKey(key);
      const registration = { root, identity, plan, authority: { keyId: 'fixture-journal', async verify(bytes, sig, id) {
        return id === this.keyId && verify(null, bytes, pub, Buffer.from(sig, 'base64'));
      } }, evidence: { version: 'fixture-proof-v1', async observe() { throw new Error('unexpected terminal'); } } };
      const journal = createLifecycleJournal(() => registration, { async sign(bytes) {
        const signature = sign(null, bytes, key).toString('base64');
        const go = once(process, 'message');
        process.send('signed');
        await go;
        return signature;
      } });
      const result = await journal.claim(request);
      process.send(result.status, () => process.disconnect());
    ` } });
  const { root, identity, plan } = f.registration;
  const children = Array.from({ length: 2 }, () => fork(runner, [], {
    execArgv: ['--permission', '--allow-fs-read=' + f.base, '--allow-fs-write=' + f.base], silent: true,
  }));
  const exits = children.map((child) => once(child, 'exit'));
  function nextMessages() {
    return children.map((child, index) => Promise.race([
      once(child, 'message').then(([message]) => message),
      exits[index].then(([code]) => { throw new Error(`Contender exited before responding: ${code}`); }),
    ]));
  }
  try {
    const signed = nextMessages();
    for (const child of children) child.send({ root, identity, plan, request: f.request,
      pem: f.keys.privateKey.export({ format: 'pem', type: 'pkcs8' }) });
    expect(await Promise.all(signed)).toEqual(['signed', 'signed']);
    const results = nextMessages();
    for (const child of children) child.send('publish');
    expect((await Promise.all(results)).sort()).toEqual(['claimed', 'running_or_uncertain']);
    expect(await Promise.all(exits)).toEqual([[0, null], [0, null]]);
  } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
  expect(await f.writer().claim(f.request)).toEqual({ status: 'running_or_uncertain' });
}, 10000);

test.each(['init', 'install', 'start', 'stop', 'upgrade', 'uninstall'] as const)(
  'the registered %s plan survives controller reconstruction', async (command) => {
    const f = fixture();
    f.registration.plan.command = f.request.command = command;
    if (command !== 'install' && command !== 'upgrade') f.registration.plan.releaseSha256 = null;
    const { journal, claim } = await owned(f);
    expect(claim.subject.binding.plan).toEqual(f.registration.plan);
    f.recordEvidence(claim.subject, 'observed');
    expect(await f.reader().read(f.request)).toEqual({ status: 'running_or_uncertain' });
    const completed = await journal.markCompleted(claim.token, 'observed');
    expect(await f.reader().read(f.request)).toEqual(completed);
  });

test('a terminal without its claim cannot move the operation out of uncertainty', async () => {
  const f = fixture();
  const { journal, claim } = await owned(f);
  f.recordEvidence(claim.subject, 'receipt');
  await journal.markCompleted(claim.token, 'receipt');
  unlinkSync(recordPath(f, 'claim'));
  await expect(f.reader().read(f.request)).rejects.toThrow('RECORD');
  await expect(f.writer().claim(f.request)).rejects.toThrow('RECORD');
  expect(existsSync(recordPath(f, 'claim'))).toBe(false);
});

test('a freshly registered evidence verifier must independently return the exact signed receipt', async () => {
  const f = fixture();
  const { journal, claim } = await owned(f);
  f.recordEvidence(claim.subject, 'receipt');
  await journal.markCompleted(claim.token, 'receipt');
  const observe = f.registration.evidence.observe;
  f.registration.evidence.observe = async (subject, id) => ({
    ...await observe(subject, id), evidenceSha256: digest('a different native observation'),
  });
  await expect(f.reader().read(f.request)).rejects.toThrow('EVIDENCE');
});

test('a transient registry selection with identical key and evidence labels cannot supply either port', async () => {
  const f = fixture();
  const { journal, claim } = await owned(f);
  f.recordEvidence(claim.subject, 'receipt');
  await journal.markCompleted(claim.token, 'receipt');

  const original = f.registration;
  const used: string[] = [];
  const alternate: LifecycleRegistration = {
    ...original,
    authority: { keyId: original.authority.keyId, async verify(bytes, signature, id) {
      used.push('alternate verification');
      return original.authority.verify(bytes, signature, id);
    } },
    evidence: { version: original.evidence.version, async observe(subject, id) {
      used.push('alternate evidence');
      return original.evidence.observe(subject, id);
    } },
  };
  let selections = 0;
  const reader = createLifecycleJournalReader(() => ++selections === 2 ? alternate : original);
  const result = await Promise.allSettled([reader.read(f.request)]);
  expect(used).toEqual([]);
  expect(result[0].status).toBe('rejected');
  await expect(reader.read(f.request)).rejects.toThrow();
});

test('withdrawal at the temporary terminal fsync leaves the claim uncertain', async () => {
  const f = fixture();
  const { journal, claim } = await owned(f);
  f.recordEvidence(claim.subject, 'receipt');
  const claimBytes = readFileSync(recordPath(f, 'claim'));
  let withdrew = false;
  syncBoundary.after = (fd) => {
    const opened = fstatSync(fd);
    if (!opened.isFile()) return;
    const temporary = readdirSync(f.registration.root.path).find((name) => name.startsWith('.lifecycle-'));
    if (!temporary) return;
    const path = join(f.registration.root.path, temporary);
    const entry = statSync(path);
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || JSON.parse(readFileSync(path, 'utf8')).payload.kind !== 'terminal') return;
    expect(existsSync(recordPath(f, 'terminal'))).toBe(false);
    unlinkSync(join(f.base, 'native-readback'));
    withdrew = true;
  };
  try { await expect(journal.markCompleted(claim.token, 'receipt')).rejects.toThrow(); }
  finally { syncBoundary.after = undefined; }
  expect(withdrew).toBe(true);
  expect(existsSync(recordPath(f, 'terminal'))).toBe(false);
  expect(readFileSync(recordPath(f, 'claim'))).toEqual(claimBytes);
  expect(await f.reader().read(f.request)).toEqual({ status: 'running_or_uncertain' });
  expect(await f.writer().claim(f.request)).toEqual({ status: 'running_or_uncertain' });
});

test.each(['reserved', 'completed'] as const)('fresh %s readback accepts the same domains in another order', async (status) => {
  const f = fixture();
  f.registration.identity.domains = ['work', 'personal'];
  const journal = f.writer();
  let expected = await journal.reserve(f.request);
  if (status === 'completed') {
    const claim = await journal.claim(f.request);
    if (claim.status !== 'claimed') throw new Error('missing fixture claim');
    f.recordEvidence(claim.subject, 'receipt');
    expected = await journal.markCompleted(claim.token, 'receipt');
  }
  expect(expected.status).toBe(status);
  expect(f.registration.identity.domains).toEqual(['work', 'personal']);
  f.registration.identity.domains = ['personal', 'work'];
  expect(await f.reader().read(f.request)).toEqual(expected);
});
