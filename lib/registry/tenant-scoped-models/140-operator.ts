import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Lender-granted operator support access (lib/operator/). Non-null
  // tenantId; the operator's access check runs before any tenant frame and
  // passes it explicitly.
  "TenantSupportGrant",
] as const)
