export const CONSULTATION_MCP_TOOLS = [
  'patrick_consult',
  'patrick_consult_result',
  'patrick_memory_query',
] as const;

type ConsultationMcpHandlers<P> = {
  consult: (principal: P, request: {
    client_request_id: string;
    text: string;
    data_domain: string;
    parent_work_id: string | null;
  }) => Promise<unknown>;
  result: (principal: P, requestId: string) => Promise<unknown>;
  memory: (principal: P, query: { text: string; domain: string; withdrawalEpoch: number }) => Promise<unknown>;
};

export function createConsultationMcp<P>(handlers: ConsultationMcpHandlers<P>) {
  return {
    list(): string[] {
      return [...CONSULTATION_MCP_TOOLS];
    },
    async call(name: string, principal: P, args: Record<string, unknown>): Promise<unknown> {
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
          withdrawalEpoch: numberField(args, 'withdrawalEpoch'),
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

function numberField(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error('UNPROCESSABLE');
  return value;
}
