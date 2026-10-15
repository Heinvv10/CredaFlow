import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Lender API (lib/lender-api). Non-null tenantId. The key lookup by prefix
  // and the webhook cron's cross-tenant scans run in withoutTenantScope;
  // ApiRequestLog (nullable tenantId: a call with an unknown key) is not listed.
  "ApiKey",
  "WebhookEndpoint",
  "WebhookEvent",
  "WebhookDelivery",
] as const)
