import { describe, expect, it } from "vitest"
import { canCancelApplication, decisionKind, isDeclinedTerminal, showDebtEvidenceBlocker } from "./decision-kind"

const approvedAt = new Date("2026-10-12T10:00:00Z")

// The portal timeline labels these outcomes (portalApplications.tlApproved /
// tlDeclined); the decision itself is decisionKind's.
describe("decisionKind", () => {
  it("is approved only for an approved or disbursed application", () => {
    expect(decisionKind({ status: "APPROVED", approvedAt, declineCategory: null })).toBe("approved")
    expect(decisionKind({ status: "DISBURSED", approvedAt, declineCategory: null })).toBe("approved")
  })

  it("is declined for a decline, including one later cancelled", () => {
    expect(decisionKind({ status: "DECLINED", approvedAt, declineCategory: "IDENTITY" })).toBe("declined")
    expect(decisionKind({ status: "CANCELLED", approvedAt, declineCategory: "IDENTITY" })).toBe("declined")
  })

  it("is neither for a cancelled application that was never declined, or with no decision time", () => {
    expect(decisionKind({ status: "CANCELLED", approvedAt, declineCategory: null })).toBeNull()
    expect(decisionKind({ status: "APPROVED", approvedAt: null, declineCategory: null })).toBeNull()
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

describe("canCancelApplication", () => {
  it("allows cancel only on DRAFT, SUBMITTED and UNDER_REVIEW", () => {
    for (const status of ["DRAFT", "SUBMITTED", "UNDER_REVIEW"]) expect(canCancelApplication({ status })).toBe(true)
    for (const status of ["DECLINED", "CANCELLED", "APPROVED", "DISBURSED"]) expect(canCancelApplication({ status })).toBe(false)
  })
})

describe("showDebtEvidenceBlocker", () => {
  it("hides the blocker on DECLINED and declined-then-cancelled", () => {
    expect(showDebtEvidenceBlocker({ status: "DECLINED", declineCategory: null }, true)).toBe(false)
    expect(showDebtEvidenceBlocker({ status: "CANCELLED", declineCategory: "AFFORDABILITY" }, true)).toBe(false)
  })

  it("shows it on a live application with invalid debt evidence only", () => {
    expect(showDebtEvidenceBlocker({ status: "UNDER_REVIEW", declineCategory: null }, true)).toBe(true)
    expect(showDebtEvidenceBlocker({ status: "UNDER_REVIEW", declineCategory: null }, false)).toBe(false)
  })
})
