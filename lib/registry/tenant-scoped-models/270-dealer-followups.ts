import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // The dealer draft purge tombstone (docs/asset-finance/SLICE5-FOLLOWUPS.md
  // part D). RLS policy in migration 20261022100000_dealer_followups.
  "DealerDealPurge",
  "DealerPurgePendingFile",
] as const)
