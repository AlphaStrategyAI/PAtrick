import { CONSULTATION_MCP_TOOLS, createConsultationMcp } from '@patrick/integrations/mcp/consultation';
import { withDeferredTransaction, withImmediateTransaction } from '@patrick/storage';
import { createConsultationApi } from '../../../packages/domain/src/consultations.js';
import { queryEvidenceSnapshot } from '../../../packages/domain/src/evidence.js';
import { assertMcpPermission, requireMcpSession, type AuthContext } from './auth.js';
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
      const mcp = createConsultationMcp<Request>({
        async consult(credential, request) {
          return withImmediateTransaction(db, () => {
            const principal = requireMcpSession(context, credential);
            const domain = request.parent_work_id
              ? resolvedWorkDomain(db, principal, request.parent_work_id)
              : request.data_domain;
            assertMcpPermission(db, principal, domain, 'mcp:consult');
            if (domain !== request.data_domain) throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
            return api.mutations.createConsultation(principal, request, 'mcp:consult');
          });
        },
        async result(credential, requestId) {
          return withDeferredTransaction(db, () => {
            const principal = requireMcpSession(context, credential);
            const domain = ownedConsultationDomain(db, principal, requestId);
            assertMcpPermission(db, principal, domain, 'mcp:consult');
            return api.readConsultationSnapshot(principal, requestId);
          });
        },
        async memory(credential, query) {
          return withDeferredTransaction(db, () => {
            const principal = requireMcpSession(context, credential);
            assertMcpPermission(db, principal, query.domain, 'mcp:memory');
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
