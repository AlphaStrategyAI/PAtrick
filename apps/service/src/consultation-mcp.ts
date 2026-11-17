import { CONSULTATION_MCP_TOOLS, createConsultationMcp } from '@patrick/integrations/mcp/consultation';
import { withDeferredTransaction, withImmediateTransaction } from '@patrick/storage';
import { createConsultationApi } from '../../../packages/domain/src/consultations.js';
import { queryEvidenceSnapshot } from '../../../packages/domain/src/evidence.js';
import { assertDomainPermission, requireSession, runWithAuth, type AuthContext } from './auth.js';
import { ApiError } from './errors.js';
import { ownedConsultationDomain, resolvedWorkDomain } from './routes/consultation-commands.js';

// A transport passes its request, never a principal or a scope supplied by tool arguments.
export function createAuthenticatedConsultationMcp(ready: () => AuthContext) {
  return {
    list: () => [...CONSULTATION_MCP_TOOLS],
    async call(name: string, credential: Request, args: Record<string, unknown>): Promise<unknown> {
      const context = ready();
      const { db, now } = context;
      const api = createConsultationApi(db, { now });
      const mcp = createConsultationMcp({
        authenticate: (request: Request) => runWithAuth(context, () => requireSession(request, { bearerOnly: true })),
        async consult(principal, request) {
          return withImmediateTransaction(db, () => {
            const domain = request.parent_work_id
              ? resolvedWorkDomain(db, principal, request.parent_work_id)
              : request.data_domain;
            assertDomainPermission(db, principal, domain, 'mcp:consult', false);
            if (domain !== request.data_domain) throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
            return api.mutations.createConsultation({ ...principal, domains: [domain] }, request);
          });
        },
        async result(principal, requestId) {
          const domain = ownedConsultationDomain(db, principal, requestId);
          assertDomainPermission(db, principal, domain, 'mcp:consult', false);
          return api.readConsultation({ ...principal, domains: [domain] }, requestId);
        },
        async memory(principal, query) {
          return withDeferredTransaction(db, () => {
            assertDomainPermission(db, principal, query.domain, 'mcp:memory', false);
            const { epoch } = db.prepare('SELECT COALESCE(MAX(epoch), 0) AS epoch FROM withdrawal_events WHERE data_domain = ?')
              .get(query.domain) as { epoch: number };
            return queryEvidenceSnapshot(db, { ...query, withdrawalEpoch: epoch }, {
              account_id: principal.account_id, domains: [query.domain],
            });
          });
        },
      });
      return mcp.call(name, credential, args);
    },
  };
}
