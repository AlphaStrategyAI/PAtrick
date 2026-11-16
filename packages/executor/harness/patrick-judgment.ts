export const TOOL_NAME = 'patrick-judgment';

export type FrozenBasis = {
  work_id: string;
  generation: number;
  hash: string;
  evidence_watermark: number;
};

export type JudgmentPort = {
  readBasis(workId: string, generation: number): Promise<FrozenBasis>;
};

export async function patrickJudgment(port: JudgmentPort, input: { workId: string; generation: number }): Promise<FrozenBasis> {
  const basis = await port.readBasis(input.workId, input.generation);
  if (basis.work_id !== input.workId || basis.generation !== input.generation) throw new Error('BASIS_MISMATCH');
  return basis;
}
