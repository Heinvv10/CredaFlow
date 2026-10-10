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
