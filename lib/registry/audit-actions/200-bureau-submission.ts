import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Bureau data submission (lib/bureau-submission). Counts and identifiers
  // only: an audit row never carries a line of the file.
  BUREAU_SUBMISSION_GENERATED: "BUREAU_SUBMISSION_GENERATED",
  BUREAU_SUBMISSION_DOWNLOADED: "BUREAU_SUBMISSION_DOWNLOADED",
  BUREAU_SUBMISSION_PUSHED: "BUREAU_SUBMISSION_PUSHED",
  BUREAU_ADVERSE_LISTING_CONFIRMED: "BUREAU_ADVERSE_LISTING_CONFIRMED",
  BUREAU_CONFIG_UPDATED: "BUREAU_CONFIG_UPDATED",
})
