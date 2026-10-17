import { describe, expect, it } from "vitest"
import { selfieLinkNeeded } from "./selfie-link-needed"

describe("selfieLinkNeeded", () => {
  // Fair Score audit 2026-10-16: the link panel showed for a client verified in person.
  it("is not needed once identity is covered", () => {
    expect(selfieLinkNeeded({ biometricEvidence: null })).toBe(false)
  })

  it("is needed while the biometric requirement is open, or unknown", () => {
    expect(selfieLinkNeeded({ biometricEvidence: "biometric_evidence_missing" })).toBe(true)
    expect(selfieLinkNeeded(null)).toBe(true)
  })
})
