import { defineTenantScopedModels } from "../define"
// The lender's audit policy, its SIEM queue and the receipts and revisions around them
// (lib/audit/siem/). The chain tables carry a nullable tenantId (the platform chain has none),
// so they are RLS-covered but not listed.
export default defineTenantScopedModels(["AuditPolicy", "AuditSiemOutbox", "AuditPolicyRevision", "AuditSiemDelivery"] as const)
