import { describe, expect, it } from "vitest"
import { documentActionFailureMessage } from "./verify-failure"

const FALLBACK = "Could not verify document."

describe("documentActionFailureMessage", () => {
  it("surfaces the server's error text instead of the generic fallback", () => {
    expect(documentActionFailureMessage(
      { error: "Credit-agreement records are immutable and cannot be verified through the generic document workflow" },
      FALLBACK,
    )).toBe("Credit-agreement records are immutable and cannot be verified through the generic document workflow")
  })

  // The enum is an internal identifier. Once the server sends real wording for
  // a reason, repeating "(reason: subject_identity_changed)" tells a staff
  // member nothing and puts back the internal vocabulary BIOMETRIC_FAILURE_COPY
  // exists to keep out of the UI.
  it("does not append a machine reason the server has already put into words", () => {
    expect(documentActionFailureMessage(
      {
        error: "Record changed after the check. The client record or the ID document this check was run against has changed since this check began, so the result no longer describes what is on file now.",
        biometricEvidence: "subject_identity_changed",
      },
      FALLBACK,
    )).toBe(
      "Record changed after the check. The client record or the ID document this check was run against has changed since this check began, so the result no longer describes what is on file now.",
    )
  })

  // For a reason with no copy the identifier is the only information there is,
  // and a support call needs something to quote.
  it("appends a machine reason that has no wording behind it", () => {
    expect(documentActionFailureMessage(
      {
        error: "This selfie's identity check cannot be accepted as evidence.",
        biometricEvidence: "some_reason_shipped_without_copy",
      },
      FALLBACK,
    )).toBe(
      "This selfie's identity check cannot be accepted as evidence. (reason: some_reason_shipped_without_copy)",
    )
  })

  it("falls back only when the body carries no usable error", () => {
    expect(documentActionFailureMessage(null, FALLBACK)).toBe(FALLBACK)
    expect(documentActionFailureMessage({}, FALLBACK)).toBe(FALLBACK)
    expect(documentActionFailureMessage({ error: "   " }, FALLBACK)).toBe(FALLBACK)
    expect(documentActionFailureMessage("Internal Server Error", FALLBACK)).toBe(FALLBACK)
  })
})
