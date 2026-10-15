import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Applications
  APPLICATION_SUBMITTED_BY_CLIENT: "APPLICATION_SUBMITTED_BY_CLIENT",
  APPLICATION_SUBMISSION_BLOCKED:  "APPLICATION_SUBMISSION_BLOCKED",
  APPLICATION_REVIEW_STARTED: "APPLICATION_REVIEW_STARTED",
  APPLICATION_BUREAU_REVIEW_RETRIED: "APPLICATION_BUREAU_REVIEW_RETRIED",
  // One bureau enquiry run (lib/compliance/bureau-review.ts): the bureaus
  // asked, in order, and how each attempt ended. No consumer data.
  BUREAU_ENQUIRY_RUN: "BUREAU_ENQUIRY_RUN",
  // Bureau enquiry settings (app/api/settings/bureau): order, freshness
  // window, and WHICH bureaus' credentials changed — never their values.
  BUREAU_ENQUIRY_CONFIG_UPDATED: "BUREAU_ENQUIRY_CONFIG_UPDATED",
  APPLICATION_RETURNED_TO_DRAFT: "APPLICATION_RETURNED_TO_DRAFT",
  APPLICATION_RETURNED_TO_REVIEW: "APPLICATION_RETURNED_TO_REVIEW",
  CREDIT_LIFE_ELECTION_RECORDED: "CREDIT_LIFE_ELECTION_RECORDED",
})
