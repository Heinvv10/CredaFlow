import { describe, expect, it } from "vitest"
import { PURPOSE_REFUSAL, purposeRefusal } from "./position-purpose"

// The reveal and the panels share one purpose gate (SLICE5.md part B, Deviation 3).
const none = { DEFAULT: false, RECOVERY: false, LEGAL_MATTER: false }

describe("the position purpose gate", () => {
  it("refuses every context with no purpose, and a context the loan does not have", () => {
    for (const context of ["DEFAULT", "RECOVERY", "LEGAL_MATTER"] as const) {
      expect(purposeRefusal(none, context)).toEqual({ reason: "no_purpose", error: PURPOSE_REFUSAL })
    }
    expect(purposeRefusal({ ...none, LEGAL_MATTER: true }, "RECOVERY")).toEqual({ reason: "no_recovery", error: "This loan has no open recovery" })
    expect(purposeRefusal({ ...none, RECOVERY: true }, "DEFAULT")).toEqual({ reason: "no_default", error: "This loan is not in default" })
    expect(purposeRefusal({ ...none, DEFAULT: true }, "LEGAL_MATTER")).toEqual({ reason: "no_legal_matter", error: "This loan has no open legal matter" })
  })

  it("answers a context the loan has", () => {
    expect(purposeRefusal({ ...none, DEFAULT: true }, "DEFAULT")).toBeNull()
    expect(purposeRefusal({ ...none, RECOVERY: true }, "RECOVERY")).toBeNull()
    expect(purposeRefusal({ ...none, LEGAL_MATTER: true }, "LEGAL_MATTER")).toBeNull()
  })
})
