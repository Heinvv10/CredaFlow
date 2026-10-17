import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Statement AI (lib/statement-ai). Written by the background worker after
  // its request has returned, so every query passes tenantId explicitly.
  "StatementAiOutput",
  "StatementAiUsage",
] as const)
