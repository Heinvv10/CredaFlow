import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Recovery and remarketing (slice 4a). Non-null tenantId, passed explicitly
  // on every query (the post-sale jobs have no frame).
  "CommercialCancellation",
  "LegalMatter",
  "LegalMatterStep",
  "Recovery",
  "RecoveryCost",
  "RemarketingSale",
  "RecoveryVatEvent",
  "RecoveryRefund",
] as const)
