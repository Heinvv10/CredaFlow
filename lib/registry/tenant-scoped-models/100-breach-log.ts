import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // POPIA security-compromise register. Non-null tenantId; its routes and
  // page pass it explicitly, so the rewriter is the backstop for a query that
  // forgets to.
  "BreachLog",
] as const)
