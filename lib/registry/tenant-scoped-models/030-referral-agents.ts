import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Referral agents. All three carry a non-null tenantId; every query site
  // passes an explicit where/data tenantId.
  "ReferralAgent",
  "ReferralCode",
  "ReferralEvent",
] as const)
