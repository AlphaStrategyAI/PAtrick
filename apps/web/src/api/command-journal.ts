import type { BrowserCreationScope } from '@patrick/contracts/resources';
import { ClientError, type ApiClient } from './client.js';
import { sameScope, type Scope } from './events.js';

export type CommandIntent = {
  operation: Parameters<ApiClient['command']>[0];
  parameters: Parameters<ApiClient['command']>[1];
  command: Omit<Parameters<ApiClient['command']>[2], 'client_request_id'>;
};
export type CommandAttempt = { intent: CommandIntent & { requestId: string } } & (
  { phase: 'sending' } | { phase: 'received'; receiptUrl: string } | { phase: 'retry' | 'declined'; error: ClientError });
type Attempts = Readonly<Record<string, CommandAttempt>>;
const empty: Attempts = Object.freeze({});

function sameCaller(left: BrowserCreationScope, right: BrowserCreationScope): boolean {
  return sameScope(left, right) && left.caller_id === right.caller_id;
}

/** Lives for a single tab, including when the authenticated UI is remounted during an SSE reset. */
export function createCommandJournal() {
  let verified: BrowserCreationScope | undefined;
  let visible: Attempts = empty;
  let parked: { identity: BrowserCreationScope; attempts: Attempts } | undefined;
  const listeners = new Set<() => void>();

  function publish(next: Attempts) {
    if (next === visible) return;
    visible = next;
    for (const listener of listeners) listener();
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    snapshot: () => visible,
    scope(scope: Scope | null, callerId: string | null) {
      return scope && verified && sameScope(scope, verified) && callerId === verified.caller_id ? verified : undefined;
    },
    changedCaller(identity: BrowserCreationScope): boolean {
      const prior = verified ?? parked?.identity;
      return !!prior && sameScope(prior, identity) && prior.caller_id !== identity.caller_id;
    },
    verify(identity: BrowserCreationScope) {
      const next = verified && sameCaller(identity, verified) ? visible
        : parked && sameCaller(identity, parked.identity) ? parked.attempts : empty;
      verified = identity;
      parked = undefined;
      publish(next);
    },
    hide(cause: 'reset' | 'revoked') {
      if (cause === 'revoked') parked = undefined;
      else if (verified) {
        const retryable: [string, CommandAttempt][] = Object.entries(visible).map(([key, attempt]) => [
          key,
          attempt.phase === 'sending'
            ? { phase: 'retry', intent: attempt.intent, error: new ClientError('UNAVAILABLE', undefined, true) }
            : attempt,
        ]);
        parked = { identity: verified, attempts: Object.fromEntries(retryable) };
      }
      verified = undefined;
      publish(empty);
    },
    replace(key: string, expected: CommandAttempt | undefined, replacement?: CommandAttempt): boolean {
      const current = Object.hasOwn(visible, key) ? visible[key] : undefined;
      if (!verified || current !== expected) return false;
      const updated = { ...visible };
      if (replacement) updated[key] = replacement;
      else delete updated[key];
      publish(updated);
      return true;
    },
  };
}
