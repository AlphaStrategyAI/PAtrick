import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { startProbeDomain } from '../../packages/executor/src/backends/probe-domain.js';

const MCP_SERVER = fileURLToPath(new URL('../../packages/executor/harness/mcp-server.ts', import.meta.url));

type RpcReply = { id: number; result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean };
  error?: { message: string } };

/** Speaks MCP over stdio, the way a backend does. */
function mcpClient(env: Record<string, string>) {
  const child = spawn('node', [MCP_SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, (reply: RpcReply) => void>();
  let buffer = '';
  let next = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line) continue;
      const reply = JSON.parse(line) as RpcReply;
      pending.get(reply.id)?.(reply);
      pending.delete(reply.id);
    }
  });
  const call = (method: string, params?: Record<string, unknown>): Promise<RpcReply> => {
    const id = ++next;
    const reply = new Promise<RpcReply>((resolve) => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return reply;
  };
  return { call, async close() { child.stdin.end(); await once(child, 'close'); } };
}

test('the Harness bundle answers over MCP and reads the domain through the restricted RPC', async () => {
  const domain = await startProbeDomain(() => new Date('2026-11-20T00:00:00.000Z'));
  const client = mcpClient({ PATRICK_HARNESS_RPC_URL: domain.url, PATRICK_HARNESS_RPC_TOKEN: domain.token });
  try {
    const initialized = await client.call('initialize', { protocolVersion: '2025-06-18' });
    expect(initialized.result).toMatchObject({ protocolVersion: '2025-06-18',
      serverInfo: { name: 'patrick-harness' } });

    const listed = await client.call('tools/list');
    expect((listed.result?.tools ?? []).map((tool) => tool.name).sort())
      .toEqual(['patrick-bridge', 'patrick-judgment', 'patrick-memory']);

    const called = await client.call('tools/call', { name: 'patrick-memory',
      arguments: { domain: domain.domain, knowledgeId: domain.knowledgeId, withdrawalEpoch: 0 } });
    expect(called.result?.isError).toBe(false);
    expect(JSON.parse(called.result?.content?.[0]?.text ?? '[]')).toEqual([
      { evidenceId: 'ev-probe-1', documentId: 'doc-probe-1', revisionId: 'rev-probe-1', status: 'supported' },
    ]);
  } finally {
    await client.close();
    await domain.close();
  }
});

test('the restricted RPC refuses a caller without its token', async () => {
  const domain = await startProbeDomain(() => new Date('2026-11-20T00:00:00.000Z'));
  try {
    const response = await fetch(domain.url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'evidence.query', params: { domain: domain.domain, knowledgeId: domain.knowledgeId,
        withdrawalEpoch: 0 } }) });
    expect(response.status).toBe(403);
    const withToken = await fetch(domain.url, { method: 'POST', headers: { 'content-type': 'application/json',
      authorization: `Bearer ${domain.token}` },
      body: JSON.stringify({ method: 'evidence.query', params: { domain: domain.domain, knowledgeId: domain.knowledgeId,
        withdrawalEpoch: 0 } }) });
    expect(withToken.status).toBe(200);
    expect(await withToken.json()).toMatchObject({ result: [{ evidence_id: 'ev-probe-1' }] });
  } finally {
    await domain.close();
  }
});

test('the bundle refuses a domain the caller does not own', async () => {
  const domain = await startProbeDomain(() => new Date('2026-11-20T00:00:00.000Z'));
  const client = mcpClient({ PATRICK_HARNESS_RPC_URL: domain.url, PATRICK_HARNESS_RPC_TOKEN: domain.token });
  try {
    const called = await client.call('tools/call', { name: 'patrick-memory',
      arguments: { domain: 'private', knowledgeId: domain.knowledgeId, withdrawalEpoch: 0 } });
    expect(called.result?.isError).toBe(true);
    expect(called.result?.content?.[0]?.text).toContain('FORBIDDEN');
  } finally {
    await client.close();
    await domain.close();
  }
});
