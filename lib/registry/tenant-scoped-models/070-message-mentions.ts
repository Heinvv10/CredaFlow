import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Phase 3 @mentions on internal notes (Task 8). Non-null tenantId, written
  // inside request handlers' tenant frame alongside the Message it tags.
  "MessageMention",
] as const)
