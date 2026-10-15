import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Lender API (lib/lender-api, app/api/settings/api-keys, app/api/settings/webhooks).
  // Key and endpoint rows by id and prefix only, never a key or a signing secret.
  API_KEY_CREATED: "API_KEY_CREATED",
  API_KEY_REVOKED: "API_KEY_REVOKED",
  WEBHOOK_ENDPOINT_CREATED: "WEBHOOK_ENDPOINT_CREATED",
  WEBHOOK_ENDPOINT_DISABLED: "WEBHOOK_ENDPOINT_DISABLED",
  // The circuit breaker paused an endpoint (no user: the system did it), and an admin resumed it.
  WEBHOOK_ENDPOINT_PAUSED: "WEBHOOK_ENDPOINT_PAUSED",
  WEBHOOK_ENDPOINT_RESUMED: "WEBHOOK_ENDPOINT_RESUMED",
  // A draft application created through POST /api/v1/applications; newValue names the key.
  APPLICATION_CREATED_VIA_API: "APPLICATION_CREATED_VIA_API",
})
