import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Document Template System (Task 5). DocumentTemplateVersion is scoped
  // transitively via its `template` relation and is deliberately NOT added
  // here — it has no tenantId column of its own.
  "DocumentTemplate",
] as const)
