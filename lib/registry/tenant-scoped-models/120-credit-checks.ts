import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Credit checks v1. Non-null tenantId; the statement read also runs after
  // its upload request has returned, so every query passes it explicitly.
  "StatementAnalysis",
  "ApplicationCheckFlag",
] as const)
