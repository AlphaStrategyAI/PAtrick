import { MCP_TOOLS } from '@patrick/contracts';

export const CONSULTATION_MCP_TOOLS = MCP_TOOLS.map((tool) => tool.name);

type ConsultationArgs = { client_request_id: string; text: string; data_domain: string; parent_work_id: string | null };
type MemoryArgs = { text: string; domain: string };
type ConsultationMcpHandlers<C, P> = {
  authenticate: (credential: C) => Promise<P>;
  consult: (principal: P, request: ConsultationArgs) => Promise<unknown>;
  result: (principal: P, requestId: string) => Promise<unknown>;
  memory: (principal: P, query: MemoryArgs) => Promise<unknown>;
};

export function createConsultationMcp<C, P>(handlers: ConsultationMcpHandlers<C, P>) {
  return {
    list(): string[] {
      return [...CONSULTATION_MCP_TOOLS];
    },
    async call(name: string, credential: C, args: Record<string, unknown>): Promise<unknown> {
      if (!CONSULTATION_MCP_TOOLS.some((tool) => tool === name)) throw new Error('UNKNOWN_TOOL');
      const principal = await handlers.authenticate(credential);
      if (name === 'patrick_consult') {
        return handlers.consult(principal, {
          client_request_id: stringField(args, 'client_request_id'),
          text: stringField(args, 'text'),
          data_domain: stringField(args, 'data_domain'),
          parent_work_id: args.parent_work_id === null ? null : stringField(args, 'parent_work_id'),
        });
      }
      if (name === 'patrick_consult_result') return handlers.result(principal, stringField(args, 'request_id'));
      if (name === 'patrick_memory_query') {
        return handlers.memory(principal, {
          text: stringField(args, 'text'),
          domain: stringField(args, 'domain'),
        });
      }
      throw new Error('UNKNOWN_TOOL');
    },
  };
}

function stringField(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error('UNPROCESSABLE');
  return value;
}
