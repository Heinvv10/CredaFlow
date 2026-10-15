import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Phase 7 collection engine. Non-null tenantId; lib/avs.ts also passes an
  // explicit tenantId on create and guards cross-tenant on read.
  "AvsCheck",
] as const)
