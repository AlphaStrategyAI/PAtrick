import type { TokenUsage } from '../types.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function jsonLines(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) events.push(parsed);
    } catch {
      // Lines that are not JSON objects are not terminal events.
    }
  }
  return events;
}

export function positiveToken(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function tokenUsage(
  value: unknown,
  names: { input: string; output: string; cached: readonly string[] },
): TokenUsage | null {
  if (!isRecord(value)) return null;
  let cached = 0;
  for (const name of names.cached) {
    const candidate = value[name];
    if (candidate !== undefined && candidate !== null) {
      cached = positiveToken(candidate);
      break;
    }
  }
  const input = positiveToken(value[names.input]);
  const output = positiveToken(value[names.output]);
  if (input + output + cached <= 0) return null;
  return { input, output, cached };
}
