import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Product versions, pricing rules, the terms a loan was written on, and an application's pricing inputs (lib/product-engine).
  "ProductVersion",
  "ProductPricingRule",
  "LoanTerms",
  "ApplicationPricingInput",
] as const)
