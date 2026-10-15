import { defineAuditActions } from "../define"

export default defineAuditActions({
  // User management
  USER_CREATED: "USER_CREATED",
  USER_UPDATED: "USER_UPDATED",
  USER_DEACTIVATED: "USER_DEACTIVATED",
  USER_DELETED: "USER_DELETED",
  // A staff-user write stopped by the role ceiling (lib/auth-guards.ts).
  USER_WRITE_REFUSED: "USER_WRITE_REFUSED",
})
