import { describe, expect, it } from "vitest"
import { portalDecisionLabel } from "./decision-kind"

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
