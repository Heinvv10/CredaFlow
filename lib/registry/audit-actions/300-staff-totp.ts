import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Staff two-factor (lib/security/staff-totp-policy.ts, app/api/settings/totp,
  // app/api/settings/users/[id]/totp). Identifiers and the policy flag only,
  // never a secret or a code.
  STAFF_TOTP_POLICY_UPDATED: "STAFF_TOTP_POLICY_UPDATED",
  TOTP_ENROLLED: "TOTP_ENROLLED",
  TOTP_DISABLED: "TOTP_DISABLED",
  TOTP_REPLACED: "TOTP_REPLACED",
  // A refused attempt to turn off or replace 2FA (wrong or replayed code, or refused by policy).
  TOTP_CHANGE_REFUSED: "TOTP_CHANGE_REFUSED",
  TOTP_RESET_BY_ADMIN: "TOTP_RESET_BY_ADMIN",
})
