import { createHash } from 'node:crypto';

// This table belongs to the trusted builder/verifier. A new template revision
// needs review here as well as in the five material files.
export const deploymentPaths = Object.freeze({
  caddy: 'deploy/Caddyfile',
  service: 'deploy/launchd/com.patrick.service.plist',
  hub: 'deploy/launchd/com.patrick.autoloop-hub.plist',
  worker: 'deploy/launchd/com.patrick.autoloop-worker.plist',
  lima: 'deploy/lima/executor.yaml',
});
const templates = new Map([
  [deploymentPaths.caddy, ['caddy-template', '915c1bba63f43d6ba86fe5b4d2c475f5e8d084a8a6e12106248878edb711abfb']],
  [deploymentPaths.service, ['service-launchd-template', '4a1abcdf6623764e61d673295935df6c495a5461af2012b177a1ca166bb3d332']],
  [deploymentPaths.hub, ['hub-launchd-template', '57502d907c6d1c90c3c384d6ac46a2e15febdd7367583c3e1c315b1c2cf8a322']],
  [deploymentPaths.worker, ['worker-launchd-template', '72ef5cac63d4e326f0fc25b135eefd94c1dca4d57b9b1e404541e1dc12ce9d5d']],
  [deploymentPaths.lima, ['lima-executor-template', 'cc79f86740be5cc0c40d6ca82c2126c535bfa75fcb556854dea238fdf5676c45']],
]);
const byDigest = new Map([...templates].map(([path, [, digest]]) => [digest, path]));
const jobs = ['service', 'hub', 'worker'];

export function releaseProfile(value = 'runtime-only') {
  if (value !== 'runtime-only' && value !== 'deployment-complete') throw new Error('unsupported release profile');
  return value;
}
export function deploymentRole(path) { return templates.get(path)?.[0]; }
export function checkDeploymentRecord(profile, path, mode, digest) {
  const template = templates.get(path);
  if (template) {
    if (profile !== 'deployment-complete' || mode !== '100644' || digest !== template[1]) {
      throw new Error('deployment template profile/mode/content mismatch: ' + path);
    }
  } else if (byDigest.has(digest)) {
    throw new Error('deployment template alias: ' + path);
  }
}

function fields(value, names) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) {
    throw new Error('invalid deployment registration fields');
  }
}
function pathValue(path) {
  // Caddyfile quotes never receive control bytes, quotes, placeholders,
  // environment substitutions or escape sequences. XML escapes '&' below.
  if (typeof path !== 'string' || path.length > 1024 || !path.startsWith('/') ||
      path.slice(1).split('/').some(part => !/^[A-Za-z0-9_&.-][A-Za-z0-9_ &.-]{0,126}$/.test(part) ||
        ['.', '..', 'current'].includes(part.toLowerCase()) || part.endsWith(' '))) {
    throw new Error('invalid deployment registration path');
  }
  return path;
}
function render(key, bytes, substitutions) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 16 * 1024) throw new Error('invalid deployment template');
  const data = Buffer.from(bytes);
  checkDeploymentRecord('deployment-complete', deploymentPaths[key], '100644', createHash('sha256').update(data).digest('hex'));
  return data.toString('utf8').replace(/@@([A-Z]+)@@/g, (_, token) => {
    if (!Object.hasOwn(substitutions, token)) throw new Error('unknown deployment template field');
    return substitutions[token];
  });
}

// Pure render. The host independently admits these principals, protected
// physical roots, controller binary digest and TLS references before effects.
export function renderDeploymentTemplates(sources, registration) {
  fields(sources, ['caddy', ...jobs]);
  fields(registration, ['instanceRoot', 'controllerPath', 'controllerSha256', 'accounts', 'origin', 'listener', 'certificatePath', 'keyPath']);
  const { accounts, listener, origin, controllerPath, controllerSha256, certificatePath, keyPath } = registration;
  fields(accounts, ['caddy', ...jobs]);
  fields(listener, ['host', 'port']);
  const names = Object.values(accounts);
  if (names.some(name => typeof name !== 'string' || !/^_?[a-z][a-z0-9_-]{0,30}$/.test(name) ||
      ['root', 'daemon', 'nobody'].includes(name)) || new Set(names).size !== names.length) throw new Error('invalid deployment accounts');
  const root = pathValue(registration.instanceRoot);
  const trust = root + '/caddy/trust';
  const controller = pathValue(controllerPath);
  if (typeof controllerSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(controllerSha256) ||
      !controller.endsWith('/' + controllerSha256 + '/patrick-host-controller') ||
      controller.toLowerCase().startsWith(root.toLowerCase() + '/') || root.toLowerCase().startsWith(controller.toLowerCase() + '/') ||
      root.toLowerCase() === controller.toLowerCase()) throw new Error('invalid registered controller path');
  if (![certificatePath, keyPath].every(path => pathValue(path).startsWith(trust + '/')) ||
      certificatePath.toLowerCase() === keyPath.toLowerCase()) throw new Error('invalid registered TLS references');
  if (typeof origin !== 'string' || origin.length > 512) throw new Error('invalid deployment HTTPS origin');
  const url = URL.parse(origin);
  if (!url || url.origin !== origin || url.protocol !== 'https:' || url.port === '0' || url.port === '80' ||
      !(/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(url.hostname) || /^\[[0-9a-f:]+\]$/.test(url.hostname))) throw new Error('invalid deployment HTTPS origin');
  if (!['127.0.0.1', '::1'].includes(listener.host) || !Number.isInteger(listener.port) || listener.port < 1 || listener.port > 65535) {
    throw new Error('invalid deployment loopback endpoint');
  }
  // Caddy binds the public port on all interfaces, including both loopback families.
  if (Number(url.port || 443) === listener.port) throw new Error('deployment listener ports overlap');
  const base = root + '/caddy';
  const caddy = render('caddy', sources.caddy, { ORIGIN: origin, AUTHORITY: url.host, CERT: certificatePath, KEY: keyPath, STORAGE: base + '/data',
    UPSTREAM: (listener.host === '::1' ? '[::1]' : listener.host) + ':' + listener.port });
  const plists = {};
  for (const job of jobs) {
    const work = root + '/runtime/' + job;
    const log = root + '/logs/' + job;
    const substitutions = { CONTROLLER: controller, ACCOUNT: accounts[job], WORK: work, HOME: work + '/home',
      STDOUT: log + '/redacted.stdout.log', STDERR: log + '/redacted.stderr.log' };
    plists[job] = render(job, sources[job], Object.fromEntries(Object.entries(substitutions).map(([k,v]) => [k,v.replaceAll('&','&amp;')])));
  }
  return Object.freeze({ caddy, plists: Object.freeze(plists), caddyProcess: Object.freeze({
    account: accounts.caddy, configPath: base + '/config/Caddyfile', workingDirectory: base,
    environment: Object.freeze({ HOME: base + '/home', XDG_CONFIG_HOME: base + '/config', XDG_DATA_HOME: base + '/data' }),
  }) });
}
