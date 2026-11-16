export function requiresChannelReconciliation(intent: {
  permitRecorded: boolean; dispatchSeq: number | null; terminal: boolean;
}, cutoff: number): boolean {
  return intent.permitRecorded && intent.dispatchSeq !== null
    && intent.dispatchSeq <= cutoff && !intent.terminal;
}
