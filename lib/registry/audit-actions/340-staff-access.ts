import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Staff working hours and IP allowlist (lib/security/staff-access-*.ts).
  // REFUSED: a sign-in or a live session stopped by the policy, with reason.
  // BYPASSED: a SUPER_ADMIN the policy would have stopped, let through.
  STAFF_ACCESS_POLICY_UPDATED: "STAFF_ACCESS_POLICY_UPDATED",
  STAFF_ACCESS_REFUSED: "STAFF_ACCESS_REFUSED",
  STAFF_ACCESS_BYPASSED: "STAFF_ACCESS_BYPASSED",
})
