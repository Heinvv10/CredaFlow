import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Insurance book + cross-sell opportunities. Non-null tenantId. Routes run
  // inside withTenantContext's frame; callers outside a request frame pass
  // tenantId explicitly.
  "InsurancePolicy",
  "InsuranceClaim",
  "PremiumPayment",
  "CrossSellOpportunity",
] as const)
