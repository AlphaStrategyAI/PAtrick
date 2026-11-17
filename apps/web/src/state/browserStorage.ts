export function getLocalStorage(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
