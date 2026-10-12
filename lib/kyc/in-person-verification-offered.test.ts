import { describe, expect, it } from "vitest"
import { inPersonKycVerificationOffered } from "./in-person-verification"

/**
 * The predicate two surfaces share: the KYC tab renders the form on it, and the
 * upload dialog's selfie step shows its "an ADMIN can record that on the KYC
 * tab" pointer on it. A disagreement is a dead end — staff follow a link to a
 * control that is not on the page — so the rule is tested here rather than
 * asserted twice in JSX. It must also agree with the route itself: offered
 * exactly when POST /api/clients/[id]/kyc-in-person-verification would grant
 * (lib/kyc/face-match-v2-pipeline.integration.test.ts pins that end to end).
 */
const base = {
  manualExceptionActive: false,
  inPersonVerificationRecorded: false,
  coreDocumentsComplete: true,
  manualRejectionActive: false,
  blockingBiometricAttempt: false,
  idDocumentAdmissible: true,
}

describe("inPersonKycVerificationOffered", () => {
  it("offers it when every precondition the route checks holds", () => {
    expect(inPersonKycVerificationOffered(base)).toBe(true)
  })

  it.each([
    // The case that made the pointer lie: the selfie step opens as soon as the
    // ID copy extracts, long before payslip/bank statement/proof of address.
    // The route refuses it (422), refused biometric attempt or not.
    ["core documents are still missing", { coreDocumentsComplete: false }],
    // The route refuses (409) whatever the biometric state.
    ["KYC is manually rejected", { manualRejectionActive: true }],
    // A selfie processing, or passed against an ID copy still on file: the
    // route refuses (409), so the form must not be offered over it.
    ["a selfie still governs", { blockingBiometricAttempt: true }],
    // No usable verified ID copy, or one a selfie found has no real photo.
    ["the ID copy cannot be attested against", { idDocumentAdmissible: false }],
    ["a senior exception is recorded", { manualExceptionActive: true }],
    ["an in-person verification is already recorded", { inPersonVerificationRecorded: true }],
  ])("does NOT offer it when %s", (_label, change) => {
    expect(inPersonKycVerificationOffered({ ...base, ...change })).toBe(false)
  })
})
