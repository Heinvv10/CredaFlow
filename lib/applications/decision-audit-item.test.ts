import { describe, expect, it } from "vitest"
import { decisionAuditItem } from "./decision-audit-item"

const decidedAt = new Date("2026-10-12T10:00:00Z")
const base = {
  approvedAt: decidedAt,
  approvedBy: { name: "Demo Admin" },
  repaymentMethod: null,
  status: "APPROVED" as const,
  declineCategory: null,
}

describe("decisionAuditItem", () => {
  it("shows nothing before a decision is recorded", () => {
    expect(decisionAuditItem({ ...base, approvedAt: null, approvedBy: null })).toBeNull()
  })

  it("labels a decline as Declined, not Approved, and omits the repayment method", () => {
    const item = decisionAuditItem({
      ...base,
      status: "DECLINED",
      declineCategory: "AFFORDABILITY",
    })
    expect(item?.label).toMatch(/^Declined /)
    expect(item?.label).not.toMatch(/Approved/)
    expect(item?.detail).toBe("Demo Admin • Affordability")
    expect(item?.tone).toBe("danger")
  })

  it("keeps the Approved entry and repayment method for an approval", () => {
    const item = decisionAuditItem({ ...base, repaymentMethod: "EFT" })
    expect(item?.label).toMatch(/^Approved /)
    expect(item?.detail).toBe("Demo Admin • EFT repayment")
    expect(item?.tone).toBe("success")
  })

  it("still reports a missing repayment method on an approval", () => {
    expect(decisionAuditItem(base)?.detail).toBe("Demo Admin • Repayment method missing")
  })
})
