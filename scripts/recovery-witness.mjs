import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { createRecoveryWitnessServer, openRecoveryWitnessStore } from '../packages/host/src/recovery/https-witness.mjs';
import { openRecoveryWithdrawalStore } from '../packages/host/src/recovery/withdrawal-store.mjs';

const configFields = ['store', 'authorityId', 'host', 'port', 'caPath', 'certPath', 'keyPath', 'clients'];
const maximumFileSize = 128 * 1024;

function readOwnedFile(path, privateFile) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) {
    throw new Error('RECOVERY_WITNESS_FILE_INVALID');
  }
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(file);
    const forbiddenMode = privateFile ? 0o077 : 0o022;
    if (!info.isFile() || info.uid !== process.geteuid() || info.nlink !== 1 || (info.mode & forbiddenMode)
      || info.size <= 0 || info.size > maximumFileSize) throw new Error('RECOVERY_WITNESS_FILE_INVALID');
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(file, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length !== info.size) throw new Error('RECOVERY_WITNESS_FILE_INVALID');
    return bytes.subarray(0, length);
  } finally { closeSync(file); }
}

function loadConfiguration(path) {
  const config = JSON.parse(readOwnedFile(resolve(path), true).toString('utf8'));
  const fields = Object.hasOwn(config ?? {}, 'withdrawalStore') ? [...configFields, 'withdrawalStore'] : configFields;
  if (!config || Object.keys(config).length !== fields.length || !fields.every(field => Object.hasOwn(config, field))
    || typeof config.host !== 'string' || !isIP(config.host) || !Number.isInteger(config.port) || config.port < 0
    || config.port > 65535 || !Array.isArray(config.clients) || config.store === config.withdrawalStore) {
    throw new Error('RECOVERY_WITNESS_CONFIG_INVALID');
  }
  return config;
}

async function serve(path) {
  const config = loadConfiguration(path);
  const store = openRecoveryWitnessStore(config.store);
  let withdrawalStore;
  try {
    if (Object.hasOwn(config, 'withdrawalStore')) withdrawalStore = openRecoveryWithdrawalStore(config.withdrawalStore);
    const server = createRecoveryWitnessServer({
      authorityId: config.authorityId, clients: config.clients, store, withdrawalStore,
      ca: readOwnedFile(config.caPath, false), cert: readOwnedFile(config.certPath, false), key: readOwnedFile(config.keyPath, true),
    });
    server.listen(config.port, config.host);
    await once(server, 'listening');
    const close = () => {
      if (server.listening) server.close();
    };
    process.on('SIGTERM', close);
    process.on('SIGINT', close);
    try {
      const closed = once(server, 'close');
      process.stdout.write(JSON.stringify({ status: 'listening', port: server.address().port }) + '\n');
      await closed;
    } finally {
      process.off('SIGTERM', close);
      process.off('SIGINT', close);
      close();
    }
  } finally {
    try { withdrawalStore?.close(); } finally { store.close(); }
  }
}

async function main([action, ...args]) {
  process.umask(0o077);
  if (action === 'serve' && args.length === 1) return serve(args[0]);
  if (action === 'initialize-log' && args.length === 1) {
    openRecoveryWithdrawalStore(resolve(args[0]), { create: true }).close();
    process.stdout.write(JSON.stringify({ status: 'initialized' }) + '\n');
    return;
  }
  if (action === 'initialize' && args.length === 4) {
    const [path, domain, writerId, writerEpoch] = args;
    const store = openRecoveryWitnessStore(resolve(path), { create: true });
    try {
      const { revision } = store.initialize({
        domain, writerId, writerEpoch, state: 'open',
        withdrawal: { seq: 0, hash: createHash('sha256').update('').digest('hex') },
        certificate: null, activationId: null, parentSealedRevision: null,
      });
      process.stdout.write(JSON.stringify({ revision }) + '\n');
    } finally { store.close(); }
    return;
  }
  throw new Error('RECOVERY_WITNESS_USAGE');
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const code = /^RECOVERY_(?:WITNESS|WITHDRAWAL)_[A-Z_]+$/.test(error?.message) ? error.message : 'RECOVERY_WITNESS_OPERATION_FAILED';
  process.stderr.write(JSON.stringify({ code }) + '\n');
  process.exitCode = 1;
}
