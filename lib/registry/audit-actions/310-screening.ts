import { defineAuditActions } from "../define"

export default defineAuditActions({
  // PEP / sanctions screening (lib/screening). Types and results only: never
  // the matched list entries, which would put "possible PEP" in the audit view.
  SCREENING_RUN: "SCREENING_RUN",
  SCREENING_RUN_FAILED: "SCREENING_RUN_FAILED",
  SCREENING_MATCH_REVIEWED: "SCREENING_MATCH_REVIEWED",
  SCREENING_CONFIG_UPDATED: "SCREENING_CONFIG_UPDATED",
  SCREENING_BLOCK_LIFTED: "SCREENING_BLOCK_LIFTED",
  // An approval the screening gate refused (consumer decide route).
  SCREENING_APPROVAL_REFUSED: "SCREENING_APPROVAL_REFUSED",
})
