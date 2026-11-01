import { defineAuditActions } from "../define"

export default defineAuditActions({
  // An NCA field sent for an application it does not apply to (app/api/applications/[id]/compliance): refused, and on the record.
  COMPLIANCE_UPDATE_REFUSED: "COMPLIANCE_UPDATE_REFUSED",
})
