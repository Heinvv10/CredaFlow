import { describe, expect, it } from "vitest"
import { biometricFailureCopy, portalSelfieFailureMessage } from "./biometric-failure-copy"

describe("face-match refusal copy", () => {
  it("tells staff the ID-side remedy is a new photo of the ID", () => {
    expect(biometricFailureCopy("id_document_portrait_invalid")?.detail).toContain(
      "upload a new, clear photo of their ID",
    )
  })

  it("tells staff the selfie-side remedy is a real, live selfie", () => {
    expect(biometricFailureCopy("selfie_not_real_photograph")?.detail).toContain(
      "retake a real, live selfie",
    )
  })

  // The same reasons also record a side answer the check returned unreadable,
  // so neither audience may be told what the photo is.
  it("claims nothing about what the refused photo is", () => {
    for (const reason of ["id_document_portrait_invalid", "selfie_not_real_photograph"]) {
      const copy = biometricFailureCopy(reason)
      for (const text of [copy?.label, copy?.detail, portalSelfieFailureMessage(reason)]) {
        expect(text).toMatch(/could(n't| not) (verify|be verified|confirm|be confirmed)/)
        expect(text).not.toMatch(/has no|is not a real|not to be|could not see/i)
      }
    }
    expect(portalSelfieFailureMessage("id_document_portrait_invalid")).toBe(
      "We couldn't verify the photo on your ID — please upload a new, clear photo of your ID, then retake your selfie.",
    )
  })

  it("gives the client the remedy that matches the side that was refused", () => {
    expect(portalSelfieFailureMessage("id_document_portrait_invalid")).toContain(
      "upload a new, clear photo of your ID",
    )
    expect(portalSelfieFailureMessage("selfie_not_real_photograph")).toContain(
      "real, live photo of you",
    )
    expect(portalSelfieFailureMessage("match_score_below_threshold")).toBe(
      "The latest selfie could not be verified. Please retake it.",
    )
    expect(portalSelfieFailureMessage(null)).toBe(
      "The latest selfie could not be verified. Please retake it.",
    )
  })
})
