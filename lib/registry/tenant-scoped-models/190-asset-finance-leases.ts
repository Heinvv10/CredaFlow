import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Operating and full-maintenance leases (slice 3). Non-null tenantId,
  // passed explicitly on every query (the invoice cron has no frame).
  "LeaseRental",
] as const)
