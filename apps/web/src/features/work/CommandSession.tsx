import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { asClientError, useService } from '../../api/query.js';
import type { CommandAttempt, CommandIntent } from '../../api/command-journal.js';

type Commands = {
  attempts: Readonly<Record<string, CommandAttempt>>;
  start: (key: string, intent: CommandIntent) => void;
  retry: (key: string) => void;
  clear: (key: string) => void;
};

const Context = createContext<Commands | null>(null);

/** A reset can remount this consumer without changing an already submitted command's identity. */
export function CommandSession({ children }: { children: ReactNode }) {
  const { api, scope, callerId, commandJournal } = useService();
  const attempts = useSyncExternalStore(commandJournal.subscribe, commandJournal.snapshot);
  async function send(key: string, intent: CommandAttempt['intent'], prior?: CommandAttempt) {
    const sending = { phase: 'sending', intent } as const;
    if (!commandJournal.replace(key, prior, sending)) return;
    try {
      const accepted = await api.command(intent.operation, intent.parameters,
        { ...intent.command, client_request_id: intent.requestId });
      commandJournal.replace(key, sending, { phase: 'received', intent, receiptUrl: accepted.receipt_url });
    } catch (cause) {
      const error = asClientError(cause);
      const phase = error.status === undefined || error.retryable || error.status >= 500 ? 'retry' : 'declined';
      commandJournal.replace(key, sending, { phase, intent, error });
    }
  }

  return <Context.Provider value={{
    attempts,
    start(key, intent) {
      const verified = commandJournal.scope(scope, callerId);
      const prior = commandJournal.snapshot()[key];
      if (!verified || (prior && prior.phase !== 'declined')) return;
      const command = structuredClone(intent);
      if (command.operation === 'createConsultation' || command.operation === 'createConversation') {
        const payload = command.command.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
        command.command.payload = { ...payload, request_scope: { ...verified } };
      }
      void send(key, { ...command, requestId: crypto.randomUUID() }, prior);
    },
    retry(key) {
      const current = commandJournal.snapshot()[key];
      if (commandJournal.scope(scope, callerId) && current?.phase === 'retry') void send(key, current.intent, current);
    },
    clear(key) {
      const current = commandJournal.snapshot()[key];
      if (commandJournal.scope(scope, callerId) && (current?.phase === 'received' || current?.phase === 'declined')) {
        commandJournal.replace(key, current);
      }
    },
  }}>{children}</Context.Provider>;
}

export function useCommands() {
  const commands = useContext(Context);
  if (!commands) throw new Error('CommandSession is required');
  return commands;
}
