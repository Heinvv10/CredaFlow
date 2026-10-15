import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Client
  CLIENT_CREATED: "CLIENT_CREATED",
  CLIENT_UPDATED: "CLIENT_UPDATED",
  CLIENT_BLACKLISTED: "CLIENT_BLACKLISTED",
  // Recording a death is a records change, not a credit decision, and the trail
  // has to tell them apart — an estate is not a declined applicant.
  CLIENT_DECEASED_RECORDED: "CLIENT_DECEASED_RECORDED",

  // Consent (granular ClientConsent per-purpose changes — see lib/consent.ts)
  CONSENT_GRANTED: "CONSENT_GRANTED",
  CONSENT_WITHDRAWN: "CONSENT_WITHDRAWN",
  CONSENT_PURPOSE_CHANGED: "CONSENT_PURPOSE_CHANGED",
})
