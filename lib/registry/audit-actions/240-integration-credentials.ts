import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Provider credentials (lib/integrations/tenant-credentials.ts): which
  // fields changed, never the values.
  PROVIDER_CREDENTIALS_UPDATED: "PROVIDER_CREDENTIALS_UPDATED",
})
