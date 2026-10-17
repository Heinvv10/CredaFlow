/**
 * Staff-facing wizard copy that has to match what the system then does.
 *
 * The PASQ is issued after approval, with the credit agreement (the signing
 * packet), not "during review ... before approval". And an affordability
 * failure is not something staff "proceed" through: approval stays
 * hard-blocked (/decide's affordability gate); the box sends the application
 * on for a reviewer to decline it or record an override.
 */
export const PASQ_TIMING_COPY =
  "The client understands that, once the application is approved, a versioned Pre-Agreement Statement & Quotation will be issued with the credit agreement, and that they open and acknowledge it in the client portal before signing. This is not the PASQ acknowledgement."

export const AFFORDABILITY_FAIL_REVIEW_COPY =
  "Affordability failed. Submit this application for a decline/override review: it cannot be approved while affordability fails, and a reviewer records the decision."

export const AFFORDABILITY_FAIL_REVIEW_RECONFIRM =
  "Submitted for a decline/override review (confirmed in Step 3)."

export const AFFORDABILITY_FAIL_REVIEW_REQUIRED =
  "Confirm the application goes for a decline/override review to proceed"
