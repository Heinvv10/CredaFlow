import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // An application's product-type facts and lending groups (lib/product-types).
  "ApplicationProductFacts",
  "BorrowerGroup",
  "BorrowerGroupMember",
] as const)
