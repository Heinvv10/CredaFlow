import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Complaints and POPIA data subject requests (app/api/complaints,
  // app/api/dsar). Identifiers, statuses and dates only: the description,
  // resolution and response stay on the row and are never copied here.
  COMPLAINT_CREATED: "COMPLAINT_CREATED",
  COMPLAINT_UPDATED: "COMPLAINT_UPDATED",
  DSAR_CREATED: "DSAR_CREATED",
  DSAR_UPDATED: "DSAR_UPDATED",
  // Branches (app/api/branches).
  BRANCH_CREATED: "BRANCH_CREATED",
})
