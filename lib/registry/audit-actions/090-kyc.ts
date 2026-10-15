import { defineAuditActions } from "../define"

export default defineAuditActions({
  // KYC
  KYC_APPROVED: "KYC_APPROVED",
  KYC_REJECTED: "KYC_REJECTED",
  KYC_STATUS_CHANGED: "KYC_STATUS_CHANGED",
  // Staff re-derived the stored status from evidence already on file ("Re-verify
  // ID", lib/kyc/kyc-rederive.server.ts). No document was verified or attested.
  KYC_STATUS_REDERIVED: "KYC_STATUS_REDERIVED",
  // One-time consumer selfie capture links. Distinct sent/failed actions for
  // the same reason PASQ_LINK_* are distinct: "we sent a credential to a
  // consumer" and "we minted one and cancelled it undelivered" are different
  // facts, and an auditor filtering on the first must not silently pick up the
  // second.
  SELFIE_LINK_SENT: "SELFIE_LINK_SENT",
  SELFIE_LINK_SEND_FAILED: "SELFIE_LINK_SEND_FAILED",
  // Signing links carry no credential — they route through /portal/continue —
  // so these record delivery of an invitation, not issuance of a token.
  AGREEMENT_SIGNING_LINK_SENT: "AGREEMENT_SIGNING_LINK_SENT",
  AGREEMENT_SIGNING_LINK_SEND_FAILED: "AGREEMENT_SIGNING_LINK_SEND_FAILED",
  BIOMETRIC_VERIFICATION_BLOCKED: "BIOMETRIC_VERIFICATION_BLOCKED",
  // A selfie attempt stuck in `processing` was failed by the sweeper while a
  // newer selfie governs the client, so the client's KYC was not re-projected
  // (lib/kyc/selfie-sweeper.server.ts).
  BIOMETRIC_ATTEMPT_SWEPT: "BIOMETRIC_ATTEMPT_SWEPT",
  KYC_VERIFICATION_BLOCKED: "KYC_VERIFICATION_BLOCKED",
  DOCUMENT_ACCESS_REFUSED: "DOCUMENT_ACCESS_REFUSED",
  KYC_EXCEPTION_GRANTED: "KYC_EXCEPTION_GRANTED",
  KYC_OVERRIDE_POLICY_UPDATED: "KYC_OVERRIDE_POLICY_UPDATED",
  KYC_OVERRIDE_REQUESTED: "KYC_OVERRIDE_REQUESTED",
  KYC_OVERRIDE_APPROVED: "KYC_OVERRIDE_APPROVED",
  KYC_OVERRIDE_DECLINED: "KYC_OVERRIDE_DECLINED",
  KYC_OVERRIDE_EXPIRED: "KYC_OVERRIDE_EXPIRED",
  KYC_IN_PERSON_VERIFICATION_GRANTED: "KYC_IN_PERSON_VERIFICATION_GRANTED",
})
