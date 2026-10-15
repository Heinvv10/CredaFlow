import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Collections engine (lib/collections-engine). Non-null tenantId, passed
  // explicitly on every query: the crons run outside a request frame.
  "DebitMandate",
  "CollectionBatch",
  "CollectionInstruction",
  "CollectionResult",
] as const)
