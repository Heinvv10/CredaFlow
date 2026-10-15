import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // In-app bell items. Non-null tenantId. Written by request handlers (inside
  // withTenantContext's ALS frame) and by the lead-task-reminder cron, which
  // has no ALS frame and therefore passes an explicit tenantId on every query
  // — the rewriter requires one or the other and throws missing-context
  // otherwise.
  "Notification",
] as const)
