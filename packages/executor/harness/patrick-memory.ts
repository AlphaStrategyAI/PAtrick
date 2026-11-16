export const TOOL_NAME = 'patrick-memory';

export type MemoryQuery = {
  domain: string;
  knowledgeId: string;
  withdrawalEpoch: number;
};

export type MemoryRecord = {
  evidenceId: string;
  documentId: string;
  revisionId: string;
  status: string;
};

export type MemoryPort = {
  queryEvidence(query: MemoryQuery): Promise<readonly MemoryRecord[]>;
};

export async function patrickMemory(port: MemoryPort, query: MemoryQuery): Promise<readonly MemoryRecord[]> {
  if (!query.domain || !query.knowledgeId || !Number.isInteger(query.withdrawalEpoch)) throw new Error('UNPROCESSABLE');
  return port.queryEvidence(query);
}
