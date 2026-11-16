export const SETTINGS_OPERATION_KINDS = ['inspect', 'validate', 'apply', 'recheck'] as const;

export type SettingsOperationKind = (typeof SETTINGS_OPERATION_KINDS)[number];

export type SettingsHandler = (input: unknown) => unknown | Promise<unknown>;

const handlers = new Map<SettingsOperationKind, SettingsHandler>();

function isSettingsOperationKind(kind: string): kind is SettingsOperationKind {
  return (SETTINGS_OPERATION_KINDS as readonly string[]).includes(kind);
}

export function registerSettingsOperation(kind: string, handler: SettingsHandler): void {
  if (!isSettingsOperationKind(kind)) throw new Error('SETTINGS_OPERATION_UNSUPPORTED');
  handlers.set(kind, handler);
}

export function settingsOperations(): SettingsOperationKind[] {
  return [...handlers.keys()];
}

export async function runSettingsOperation(kind: string, input: unknown): Promise<unknown> {
  if (!isSettingsOperationKind(kind)) throw new Error('SETTINGS_OPERATION_UNSUPPORTED');
  const handler = handlers.get(kind);
  if (!handler) throw new Error('SETTINGS_OPERATION_UNREGISTERED');
  return handler(input);
}

export function runSettingsOperationNow(kind: string, input: unknown): unknown {
  if (!isSettingsOperationKind(kind)) throw new Error('SETTINGS_OPERATION_UNSUPPORTED');
  const handler = handlers.get(kind);
  if (!handler) throw new Error('SETTINGS_OPERATION_UNREGISTERED');
  const result = handler(input);
  if (result instanceof Promise) throw new Error('SETTINGS_OPERATION_ASYNC');
  return result;
}

export function clearSettingsOperations(): void {
  handlers.clear();
}
