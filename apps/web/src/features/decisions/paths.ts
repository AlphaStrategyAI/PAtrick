export function decisionPath(questionId: string, workId: string) {
  return '/decisions?' + new URLSearchParams({ question: questionId, work: workId });
}
