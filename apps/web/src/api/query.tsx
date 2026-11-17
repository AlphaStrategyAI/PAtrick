import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Snapshot } from '@patrick/contracts/envelope';
import type { BrowserCreationScope } from '@patrick/contracts/resources';
import { createCommandJournal } from './command-journal.js';
import { ApiClient, ClientError, scopedQueryKey } from './client.js';
import { sameScope } from './events.js';
import { createProjectionRefresh, purgeAccountQueries, t13ProjectionMeta } from './query-cache.js';
import type { Scope } from './events.js';

type Service = {
  api: ApiClient;
  commandJournal: ReturnType<typeof createCommandJournal>;
  scope: Scope | null;
  callerId: string | null;
  accessGeneration: number;
  rejectedCursor?: string;
  verifying: boolean;
  accessError: ClientError | null;
  signOut: () => Promise<void>;
  recheck: () => void;
};

const ServiceContext = createContext<Service | null>(null);

export function ServiceProvider({ children, demo, onAccountExit }: {
  children: ReactNode; demo: boolean; onAccountExit: (account: string) => void;
}) {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<Scope | null>(null);
  const [callerId, setCallerId] = useState<string | null>(null);
  const [accessError, setAccessError] = useState<ClientError | null>(null);
  const [verifying, setVerifying] = useState(!demo);
  const [attempt, setAttempt] = useState(0);
  const [accessGeneration, setAccessGeneration] = useState(0);
  const [rejectedCursor, setRejectedCursor] = useState<string>();
  const [commandJournal] = useState(createCommandJournal);
  const [api] = useState(() => new ApiClient(undefined, (old, cause) => {
    commandJournal.hide(cause.kind);
    purgeAccountQueries(queryClient, old.account_id);
    setScope(null);
    setCallerId(null);
    setAccessGeneration((prior) => prior + 1);
    if (cause.kind === 'reset') {
      // The cursor binds permissions beyond the public epoch. Block everything until session
      // revalidation and fresh scoped reads, even if the server returns that same epoch.
      setRejectedCursor(cause.cursor);
      setAccessError(null);
      setVerifying(true);
      setAttempt((prior) => prior + 1);
    } else {
      setRejectedCursor(undefined);
      setAccessError(cause.error);
      onAccountExit(old.account_id);
    }
  }));

  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    void api.read('getSession', {}, { signal: controller.signal }).then((session) => {
      if (controller.signal.aborted) return;
      const identity = verifiedIdentity(session);
      if (!identity) {
        api.revoke();
        commandJournal.hide('revoked');
        setScope(null);
        setCallerId(null);
        throw new ClientError('INVALID_RESPONSE');
      }
      if (commandJournal.changedCaller(identity)) api.revoke();
      api.authorize(session.scope);
      commandJournal.verify(identity);
      setScope(session.scope);
      setCallerId(identity.caller_id);
      setAccessError(null);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setAccessError(asClientError(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setVerifying(false);
    });
    return () => controller.abort();
  }, [api, demo, attempt, commandJournal]);

  async function signOut() {
    if (!scope) return;
    try {
      await api.write('deleteSession', {}, {});
      api.revoke();
      setAccessError(null);
    } catch (cause) {
      setAccessError(asClientError(cause));
      // A server rejection is not a successful logout. Private local drafts still clear.
      onAccountExit(scope.account_id);
    }
  }

  return <ServiceContext.Provider value={{
    api, scope, callerId, commandJournal, accessGeneration, rejectedCursor, verifying, accessError, signOut,
    recheck: () => { setVerifying(true); setAttempt((previous) => previous + 1); },
  }}>{children}</ServiceContext.Provider>;
}

function verifiedIdentity(session: Snapshot<unknown>): BrowserCreationScope | undefined {
  if (!session.data || typeof session.data !== 'object') return;
  const data = session.data as { account_id?: unknown; caller_id?: unknown; auth_epoch?: unknown; domains?: unknown };
  if (data.account_id !== session.scope.account_id || data.auth_epoch !== session.scope.permission_epoch ||
      !Array.isArray(data.domains) || !data.domains.includes(session.scope.data_domain) ||
      typeof data.caller_id !== 'string' || !data.caller_id) return;
  return { ...session.scope, caller_id: data.caller_id };
}

export function useService(): Service {
  const service = useContext(ServiceContext);
  if (!service) throw new Error('ServiceProvider is required');
  return service;
}

export function asClientError(error: unknown): ClientError {
  return error instanceof ClientError ? error : new ClientError('UNAVAILABLE');
}

type QueryValues = Record<string, string | number | boolean | undefined>;

/** Later feature lanes supply projection data schemas; auth, snapshot and query scope are shared. */
export function useScopedSnapshot<T>(
  operation: string, params: QueryValues, parse: (data: unknown) => T,
  options: { enabled?: boolean; refetchInterval?: number; projection?: boolean } = {},
) {
  const { api, scope, accessGeneration } = useService();
  return useQuery({
    queryKey: scope ? [...scopedQueryKey(scope, operation, params), accessGeneration] : ['patrick:locked', operation],
    enabled: !!scope && options.enabled !== false,
    meta: options.projection ? t13ProjectionMeta : undefined,
    refetchInterval: options.refetchInterval,
    queryFn: async ({ signal }): Promise<Snapshot<T>> => {
      const result = await api.read(operation, params, { signal });
      return { ...result, data: parse(result.data) };
    },
    retry: false,
  });
}

/** A stream delivers invalidations only. Query data comes from a validated scoped HTTP snapshot. */
export function useSnapshotEvents(snapshot: Snapshot<unknown> | undefined) {
  const { api, callerId, rejectedCursor, scope } = useService();
  const queryClient = useQueryClient();
  const [source, setSource] = useState<Snapshot<unknown>>();
  const [connected, setConnected] = useState<boolean | undefined>();
  useEffect(() => {
    if (!scope || !snapshot?.stream_cursor) { setSource(undefined); return; }
    setSource((active) => {
      if (active && sameScope(active.scope, snapshot.scope)) return active;
      return rejectedCursor === snapshot.stream_cursor ? undefined : snapshot;
    });
  }, [snapshot, rejectedCursor, scope]);
  useEffect(() => {
    if (!source) return;
    const controller = new AbortController();
    const refresh = createProjectionRefresh(queryClient, source.scope, controller.signal);
    void api.subscribe(source, {
      signal: controller.signal,
      checkSession: async () => {
        const session = await api.read('getSession', {}, { signal: controller.signal });
        return !!callerId && verifiedIdentity(session)?.caller_id === callerId;
      },
      onConnection: (next) => { if (!controller.signal.aborted) setConnected(next); },
      onUpdate: (event) => { void refresh(event.watermark); },
      onReset: () => {
        if (controller.signal.aborted) return;
        setConnected(false);
        setSource(undefined);
      },
    }).catch(() => {
      if (!controller.signal.aborted) setConnected(false);
    });
    return () => controller.abort();
  }, [api, callerId, queryClient, source]);
  return connected;
}
