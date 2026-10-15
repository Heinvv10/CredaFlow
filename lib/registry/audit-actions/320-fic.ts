import { defineAuditActions } from "../define"

export default defineAuditActions({
  // FIC Act registers (lib/fic). STR rows carry the case id and status only:
  // the audit view is wider than the STR register, and naming the client
  // there would spread knowledge of the report (tipping-off risk).
  CTR_RECORDED: "CTR_RECORDED",
  FIC_EXPORTED: "FIC_EXPORTED",
  STR_CASE_RAISED: "STR_CASE_RAISED",
  STR_CASE_UPDATED: "STR_CASE_UPDATED",
  RMCP_UPLOADED: "RMCP_UPLOADED",
  RMCP_APPROVED: "RMCP_APPROVED",
  RMCP_DOWNLOADED: "RMCP_DOWNLOADED",
})
