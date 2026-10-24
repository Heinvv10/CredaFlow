import { defineAuditActions } from "../define"

export default defineAuditActions({
  // A DSAR's decision-record export downloaded (app/api/dsar/[id]/decision-records).
  // This row is the access event: who, which request, how many records. The
  // records themselves (overrideReason is staff free text) never enter it.
  DSAR_DECISION_RECORDS_EXPORTED: "DSAR_DECISION_RECORDS_EXPORTED",
})
