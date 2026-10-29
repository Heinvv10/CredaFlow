import { defineTenantScopedModels } from "../define"
// The lender's audit policy and its SIEM queue (lib/audit/siem/). The chain tables carry a
// nullable tenantId (the platform chain has none), so they are RLS-covered but not listed.
export default defineTenantScopedModels(["AuditPolicy", "AuditSiemOutbox"] as const)
