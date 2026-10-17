import { describe, expect, it } from "vitest"
import { bureauRailAction } from "./bureau-rail-action"

describe("bureauRailAction", () => {
  // Fair Score audit 2026-10-16: after a successful check the primary rail
  // button was still "Retry Bureau Enquiry".
  it("demotes the enquiry to a secondary re-run once a result is on file", () => {
    expect(bureauRailAction({
      kind: "CHECK", source: "CURRENT_REVIEW", provider: "Experian", score: 645, riskGrade: "C",
      adverseInfo: [], unscoreable: false, checkedAt: new Date(), override: null,
    })).toBe("rerun")
  })

  it.each([
    { kind: "MISSING", immutable: false },
    { kind: "PENDING", error: "timeout" },
    { kind: "SKIPPED", reason: "CONSENT_MISSING" },
  ] as const)("keeps it a primary retry when the enquiry is $kind", (display) => {
    expect(bureauRailAction(display)).toBe("retry")
  })
})
