import { describe, expect, it } from "vitest"
import { section129HintText } from "./section129-hint"

describe("section129HintText", () => {
  it("temporary block: says yet", () => {
    expect(section129HintText({ reason: "the account is below the 90-day arrears threshold", temporary: true }))
      .toBe("Section 129 cannot be issued yet: the account is below the 90-day arrears threshold.")
  })
  it("cooldown keeps its own capital and full stop", () => {
    expect(section129HintText({ reason: "A new notice can be reserved after 1 Nov 2026.", temporary: true }))
      .toBe("Section 129 cannot be issued yet: A new notice can be reserved after 1 Nov 2026.")
  })
  it("permanent NON_NCA block: no yet, no doubled Section 129", () => {
    const out = section129HintText({
      reason: "Section 129 applies to NCA credit agreements only; this agreement is not regulated by the NCA",
      temporary: false,
    })
    expect(out).toBe("Section 129 applies to NCA credit agreements only; this agreement is not regulated by the NCA.")
  })
  it("permanent active-issuance block: no yet", () => {
    expect(section129HintText({ reason: "An issuance is already in progress.", temporary: false }))
      .toBe("Section 129 cannot be issued: An issuance is already in progress.")
  })
  it("status block keeps the reason verbatim after the prefix", () => {
    expect(section129HintText({ reason: "loan status SETTLED is not eligible for collections activity", temporary: false }))
      .toBe("Section 129 cannot be issued: loan status SETTLED is not eligible for collections activity.")
  })
})
