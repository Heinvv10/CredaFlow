import { describe, expect, it } from "vitest"
import { isDeclinedTerminal, portalDecisionLabel } from "./decision-kind"

const approvedAt = new Date("2026-10-12T10:00:00Z")

describe("portalDecisionLabel", () => {
  it("says approved only for an approved or disbursed application", () => {
    expect(portalDecisionLabel({ status: "APPROVED", approvedAt, declineCategory: null })).toBe("Application approved")
    expect(portalDecisionLabel({ status: "DISBURSED", approvedAt, declineCategory: null })).toBe("Application approved")
  })

  it("says declined for a decline, including one later cancelled", () => {
    expect(portalDecisionLabel({ status: "DECLINED", approvedAt, declineCategory: "IDENTITY" })).toBe("Application declined")
    expect(portalDecisionLabel({ status: "CANCELLED", approvedAt, declineCategory: "IDENTITY" })).toBe("Application declined")
  })

  it("says neither for a cancelled application that was never declined, or with no decision time", () => {
    expect(portalDecisionLabel({ status: "CANCELLED", approvedAt, declineCategory: null })).toBeNull()
    expect(portalDecisionLabel({ status: "APPROVED", approvedAt: null, declineCategory: null })).toBeNull()
  })
})

describe("isDeclinedTerminal", () => {
  it("is true for DECLINED and for a declined-then-cancelled application", () => {
    expect(isDeclinedTerminal({ status: "DECLINED", declineCategory: null })).toBe(true)
    expect(isDeclinedTerminal({ status: "CANCELLED", declineCategory: "AFFORDABILITY" })).toBe(true)
  })

  it("is false for live, approved and plainly cancelled applications", () => {
    for (const status of ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "DISBURSED"]) {
      expect(isDeclinedTerminal({ status, declineCategory: null })).toBe(false)
    }
    expect(isDeclinedTerminal({ status: "CANCELLED", declineCategory: null })).toBe(false)
  })
})
