import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Valuation guides (docs/asset-finance/SLICE5.md part C). Non-null
  // tenantId, passed explicitly on every query; RLS policy in migration
  // 20261021090100_valuation_guides.
  "ValuationGuide",
  "ValuationGuideRow",
] as const)
