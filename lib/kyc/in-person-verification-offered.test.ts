import { describe, expect, it } from "vitest"
import { inPersonKycVerificationOffered } from "./in-person-verification"

/**
 * The predicate two surfaces share: the KYC tab renders the form on it, and the
 * upload dialog's selfie step shows its "an ADMIN can record that on the KYC
 * tab" pointer on it. A disagreement is a dead end — staff follow a link to a
 * control that is not on the page — so the rule is tested here rather than
 * asserted twice in JSX.
 */
const base = {
  manualExceptionActive: false,
  inPersonVerificationRecorded: false,
  selfieCaptured: false,
  coreDocumentsComplete: true,
  manualRejectionActive: false,
  biometricAttemptFailed: false,
}

describe("inPersonKycVerificationOffered", () => {
  it("offers it when no selfie exists and every core document is in", () => {
    expect(inPersonKycVerificationOffered(base)).toBe(true)
  })

  it("does NOT offer it while core documents are still missing", () => {
    // The case that made the pointer lie: the selfie step opens as soon as the
    // ID copy extracts, long before payslip/bank statement/proof of address.
    expect(
      inPersonKycVerificationOffered({ ...base, coreDocumentsComplete: false }),
    ).toBe(false)
  })

  it("offers it after a refused biometric attempt, core documents or not", () => {
    expect(
      inPersonKycVerificationOffered({
        ...base,
        selfieCaptured: true,
        coreDocumentsComplete: false,
        biometricAttemptFailed: true,
      }),
    ).toBe(true)
  })

  it("does NOT offer it for a captured selfie that has not been refused", () => {
    expect(
      inPersonKycVerificationOffered({ ...base, selfieCaptured: true }),
    ).toBe(false)
  })

  it("does NOT offer it while KYC is manually rejected", () => {
    expect(
      inPersonKycVerificationOffered({ ...base, manualRejectionActive: true }),
    ).toBe(false)
  })

  it("still offers it on a refused attempt under a manual rejection", () => {
    // The rejection gate guards only the no-selfie arm; a refused biometric
    // keeps the human fallback open, which is what the tab already renders.
    expect(
      inPersonKycVerificationOffered({
        ...base,
        manualRejectionActive: true,
        selfieCaptured: true,
        biometricAttemptFailed: true,
      }),
    ).toBe(true)
  })

  it("does NOT offer it once a senior exception is recorded", () => {
    expect(
      inPersonKycVerificationOffered({
        ...base,
        manualExceptionActive: true,
        biometricAttemptFailed: true,
      }),
    ).toBe(false)
  })

  it("does NOT offer it once an in-person verification is already recorded", () => {
    expect(
      inPersonKycVerificationOffered({
        ...base,
        inPersonVerificationRecorded: true,
      }),
    ).toBe(false)
  })
})
