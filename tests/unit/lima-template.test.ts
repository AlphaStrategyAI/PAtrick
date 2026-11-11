import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderBootNft, renderBootScript } from '../../scripts/lima/boot-firewall.mjs';
import { sessionUploadBytes } from '../../scripts/lima/connect-proxy.mjs';

const yaml = readFileSync(new URL('../../examples/lima.yaml', import.meta.url), 'utf8');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function templateScript() {
  const lines = yaml.split('\n');
  const start = lines.findIndex(line => line === '    script: |');
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line !== '' && !line.startsWith('      ')) break;
    body.push(line.slice(6));
  }
  return `${body.join('\n').replace(/\n+$/, '')}\n`;
}
function temp(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
function executable(dir: string, name: string, text: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text, { mode: 0o755 });
}
function boot(path: string, env: NodeJS.ProcessEnv, dest: string) {
  const dir = temp('patrick-boot-');
  const file = join(dir, 'boot.sh');
  writeFileSync(file, templateScript(), { mode: 0o755 });
  return spawnSync('/bin/sh', [file, dest], { env: { ...env, PATH: path }, encoding: 'utf8' });
}

describe('Lima template network and session limits', () => {
  it('keeps the guest off host mounts, agent forwarding, and session file copies', () => {
    expect(yaml).toContain('minimumLimaVersion: 2.3.0');
    expect(yaml).toMatch(/^mounts: \[\]$/m);
    expect(yaml).toMatch(/^copyToHost: \[\]$/m);
    expect(yaml).toContain('forwardAgent: false');
    expect(yaml).toContain('hostLoopback: false');
    expect(yaml).not.toMatch(/location:\s*~/);
    expect(yaml).not.toMatch(/location:\s*["']?\/Users/);
    expect(templateScript()).toBe(renderBootScript());
  });
  it('rejects private and gateway destinations before the worker chain, without a public allowlist', () => {
    const nft = renderBootNft();
    const worker = readFileSync(new URL('../../scripts/lima/policy.mjs', import.meta.url), 'utf8');
    const priority = (text: string) => Number(/hook output priority (-?\d+);/.exec(text)?.[1]);
    expect(priority(nft)).toBeLessThan(priority(worker));
    expect(nft.indexOf('192.168.5.2 udp dport 53 accept')).toBeLessThan(nft.indexOf('ip daddr 192.168.0.0/16 reject'));
    for (const cidr of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', 'fc00::/7', 'fe80::/10']) expect(nft).toContain(cidr);
    expect(nft).not.toContain('0.0.0.0/0');
    expect(nft).not.toContain('127.0.0.0/8');
    expect(nft).not.toContain('policy drop');
    expect(renderBootScript()).toContain(String(sessionUploadBytes));
  });
  it('installs the private-network reject rules and records the proxy session cap', () => {
    const capture = join(temp('patrick-nft-'), 'rules.nft');
    const bin = temp('patrick-nft-bin-');
    executable(bin, 'nft', '#!/bin/sh\nif [ "$1" = "-f" ]; then cat > "$PATRICK_NFT_CAPTURE"; exit 0; fi\nexit 0\n');
    const dest = join(temp('patrick-cap-'), 'worker');
    const ran = boot(`${bin}:/bin:/usr/bin`, { PATRICK_NFT_CAPTURE: capture }, dest);
    expect(ran.status, ran.stderr).toBe(0);
    expect(readFileSync(capture, 'utf8')).toBe(renderBootNft());
    expect(readFileSync(join(dest, 'session-upload-bytes'), 'utf8')).toBe(`${sessionUploadBytes}\n`);
  });
  it('uses iptables when nft is absent and still records the same cap', () => {
    const log = join(temp('patrick-ipt-'), 'calls.log');
    const bin = temp('patrick-ipt-bin-');
    const fake = '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$PATRICK_IPTABLES_LOG"\nexit 0\n';
    executable(bin, 'iptables', fake);
    executable(bin, 'ip6tables', fake);
    const dest = join(temp('patrick-cap-'), 'worker');
    const ran = boot(`${bin}:/bin:/usr/bin`, { PATRICK_IPTABLES_LOG: log }, dest);
    expect(ran.status, ran.stderr).toBe(0);
    const calls = readFileSync(log, 'utf8');
    for (const rule of ['-d 10.0.0.0/8 -j REJECT', '-d 192.168.0.0/16 -j REJECT', '-d 192.168.5.2 --dport 53 -j ACCEPT', '-d fc00::/7 -j REJECT']) expect(calls).toContain(rule);
    expect(calls).not.toContain('0.0.0.0/0');
    expect(readFileSync(join(dest, 'session-upload-bytes'), 'utf8')).toBe(`${sessionUploadBytes}\n`);
  });
  it('does not record a session cap when no packet filter is available', () => {
    const dest = join(temp('patrick-cap-'), 'worker');
    const ran = boot('/bin:/usr/bin', {}, dest);
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('patrick-boot-firewall-missing');
    expect(() => readFileSync(join(dest, 'session-upload-bytes'), 'utf8')).toThrow();
  });
});
