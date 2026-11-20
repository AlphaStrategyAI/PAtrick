/**
 * The Harness bundle over MCP.
 *
 * The bundle tools are exposed to a backend over stdio JSON-RPC. The tools
 * themselves stay the same modules the executor loads: this server only
 * transports the call to the restricted RPC and back, so the bundle never
 * takes a database connection.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type RpcRequest = { jsonrpc: '2.0'; id?: number | string | null; method: string; params?: Record<string, unknown> };
type RpcResponse = { jsonrpc: '2.0'; id: number | string | null; result?: unknown; error?: { code: number; message: string } };

type ToolSpec = { name: string; entry: string; rpc: string };

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const RPC_URL = process.env.PATRICK_HARNESS_RPC_URL ?? '';
const RPC_TOKEN = process.env.PATRICK_HARNESS_RPC_TOKEN ?? '';

const SCHEMAS: Record<string, Record<string, unknown>> = {
  'evidence.query': {
    type: 'object',
    properties: {
      domain: { type: 'string', description: 'The data domain the evidence belongs to.' },
      knowledgeId: { type: 'string', description: 'The knowledge item the evidence supports.' },
      withdrawalEpoch: { type: 'integer', description: 'The withdrawal epoch the answer may use.' },
    },
    required: ['domain', 'knowledgeId', 'withdrawalEpoch'],
    additionalProperties: false,
  },
  'judgment.read': {
    type: 'object',
    properties: {
      workId: { type: 'string', description: 'The work the frozen judgment basis belongs to.' },
      generation: { type: 'integer', description: 'The generation of the frozen judgment basis.' },
    },
    required: ['workId', 'generation'],
    additionalProperties: false,
  },
  'budget.next': {
    type: 'object',
    properties: {
      grantId: { type: 'string', description: 'The grant the paid call runs under.' },
      attemptId: { type: 'string', description: 'The attempt the paid call belongs to.' },
      routeId: { type: 'string', description: 'The route the paid call takes.' },
    },
    required: ['grantId', 'attemptId', 'routeId'],
    additionalProperties: false,
  },
};

const DESCRIPTIONS: Record<string, string> = {
  'patrick-memory': 'Read the admitted evidence of a knowledge item inside the data domain.',
  'patrick-judgment': 'Read the frozen judgment basis of a work generation.',
  'patrick-bridge': 'Reserve, claim and settle the budget of the next paid call.',
};

/** Reads the bundle manifest that ships next to this server. */
function bundleTools(): ToolSpec[] {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('./manifest.json', import.meta.url)), 'utf8')) as {
    tools?: ToolSpec[];
  };
  return (manifest.tools ?? []).filter((tool) => typeof tool.name === 'string' && typeof tool.rpc === 'string');
}

/** Calls the restricted RPC that owns the domain. */
async function rpcCall(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (!RPC_URL || !RPC_TOKEN) throw new Error('HARNESS_RPC_UNAVAILABLE');
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${RPC_TOKEN}` },
    body: JSON.stringify({ method, params }),
  });
  const body = await response.json() as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? 'HARNESS_RPC_ERROR');
  if (!response.ok) throw new Error(`HARNESS_RPC_${response.status}`);
  return body.result;
}

/** Runs the bundle tool behind the transport. */
async function callTool(tool: ToolSpec, args: Record<string, unknown>): Promise<unknown> {
  if (tool.rpc === 'evidence.query') {
    const memory = await import(new URL('./patrick-memory.ts', import.meta.url).href) as
      typeof import('./patrick-memory.js');
    const query = { domain: String(args.domain ?? ''), knowledgeId: String(args.knowledgeId ?? ''),
      withdrawalEpoch: Number(args.withdrawalEpoch ?? 0) };
    return memory.patrickMemory({ queryEvidence: async (input) => {
      const records = await rpcCall('evidence.query', { ...input }) as { evidence_id: string; document_id: string;
        revision_id: string; status: string }[];
      return records.map((record) => ({ evidenceId: record.evidence_id, documentId: record.document_id,
        revisionId: record.revision_id, status: record.status }));
    } }, query);
  }
  if (tool.rpc === 'judgment.read') {
    const judgment = await import(new URL('./patrick-judgment.ts', import.meta.url).href) as
      typeof import('./patrick-judgment.js');
    return judgment.patrickJudgment({ readBasis: async (workId, generation) => {
      const basis = await rpcCall('judgment.read', { workId, generation }) as { work_id: string; generation: number;
        hash: string; evidence_watermark: number };
      return { work_id: basis.work_id, generation: basis.generation, hash: basis.hash,
        evidence_watermark: basis.evidence_watermark };
    } }, { workId: String(args.workId ?? ''), generation: Number(args.generation ?? 0) });
  }
  const bridge = await import(new URL('./patrick-bridge.ts', import.meta.url).href) as
    typeof import('./patrick-bridge.js');
  const result = await rpcCall('budget.next', {
    grantId: String(args.grantId ?? ''), attemptId: String(args.attemptId ?? ''), routeId: String(args.routeId ?? ''),
  }) as { claim?: string; sent?: boolean; settled?: string; outbound?: number };
  return { claim: result.claim ?? 'denied', sent: result.sent === true, settled: result.settled ?? 'none',
    outbound: Number(result.outbound ?? 0), admitted: bridge.hardBudgetAdmitted({ sdkMaxRetries: 0,
    implicitResend: false, perHttpAccounted: false, verifiedMaxSends: null }) };
}

async function handle(request: RpcRequest): Promise<unknown> {
  if (request.method === 'initialize') {
    const requested = String(request.params?.protocolVersion ?? '');
    return {
      protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'patrick-harness', version: '1.0' },
    };
  }
  if (request.method === 'ping') return {};
  if (request.method === 'tools/list') {
    return { tools: bundleTools().map((tool) => ({
      name: tool.name, description: DESCRIPTIONS[tool.name] ?? tool.name,
      inputSchema: SCHEMAS[tool.rpc] ?? { type: 'object', properties: {}, additionalProperties: false },
    })) };
  }
  if (request.method === 'tools/call') {
    const name = String(request.params?.name ?? '');
    const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
    const tool = bundleTools().find((entry) => entry.name === name);
    if (!tool) throw new Error('UNKNOWN_TOOL');
    try {
      const result = await callTool(tool, args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  }
  return undefined;
}

function write(message: RpcResponse): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\n');
    if (!line) continue;
    void dispatch(line);
  }
});

async function dispatch(line: string): Promise<void> {
  let request: RpcRequest;
  try { request = JSON.parse(line) as RpcRequest; } catch { return; }
  try {
    const result = await handle(request);
    if (request.id === undefined || request.id === null) return;
    write({ jsonrpc: '2.0', id: request.id, result });
  } catch (error) {
    if (request.id === undefined || request.id === null) return;
    write({ jsonrpc: '2.0', id: request.id, error: {
      code: -32000, message: error instanceof Error ? error.message : String(error) } });
  }
}
