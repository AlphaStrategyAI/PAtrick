import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { feishuAppCredentials, probeDeferredCard } from '../../packages/integrations/feishu/connection.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function credentialsFile(values: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'patrick-feishu-credentials-'));
  roots.push(root);
  const path = join(root, 'feishu.env');
  writeFileSync(path, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n'), 'utf8');
  return path;
}

test('the environment wins over the credentials file', () => {
  const path = credentialsFile({ FEISHU_APP_ID: 'file-app', FEISHU_APP_SECRET: 'file-secret' });
  expect(feishuAppCredentials({
    FEISHU_APP_ID: 'env-app', FEISHU_APP_SECRET: 'env-secret', PATRICK_FEISHU_CREDENTIALS_FILE: path,
  })).toEqual({ appId: 'env-app', appSecret: 'env-secret', source: 'environment' });
});

test('the credentials file supplies the app when the environment has none', () => {
  const path = credentialsFile({ FEISHU_APP_ID: 'file-app', FEISHU_APP_SECRET: 'file-secret' });
  expect(feishuAppCredentials({ PATRICK_FEISHU_CREDENTIALS_FILE: path }))
    .toEqual({ appId: 'file-app', appSecret: 'file-secret', source: 'file' });
  // A partial environment does not win over the file.
  expect(feishuAppCredentials({ PATRICK_FEISHU_CREDENTIALS_FILE: path, FEISHU_APP_ID: 'env-app' }))
    .toEqual({ appId: 'file-app', appSecret: 'file-secret', source: 'file' });
});

test('a missing or empty credentials file reports no credential', () => {
  const path = credentialsFile({ FEISHU_APP_ID: '', FEISHU_APP_SECRET: '' });
  expect(feishuAppCredentials({ PATRICK_FEISHU_CREDENTIALS_FILE: path }).source).toBe('none');
  expect(feishuAppCredentials({ PATRICK_FEISHU_CREDENTIALS_FILE: join(tmpdir(), 'patrick-absent.env') }).source).toBe('none');
});

test('the probe finds the credential in the file without putting the secret in the observation', () => {
  const path = credentialsFile({ FEISHU_APP_ID: 'file-app', FEISHU_APP_SECRET: 'file-secret' });
  const without = probeDeferredCard();
  const with_ = (() => {
    const previous = process.env.PATRICK_FEISHU_CREDENTIALS_FILE;
    process.env.PATRICK_FEISHU_CREDENTIALS_FILE = path;
    try { return probeDeferredCard(); } finally {
      if (previous === undefined) delete process.env.PATRICK_FEISHU_CREDENTIALS_FILE;
      else process.env.PATRICK_FEISHU_CREDENTIALS_FILE = previous;
    }
  })();
  expect(without.observation).toMatch(/exit: 1/);
  expect(with_.observation).toMatch(/exit: 0/);
  // The secret never reaches the command or the observation.
  expect(with_.observation).not.toContain('file-secret');
  expect(with_.command).not.toContain('file-secret');
});
