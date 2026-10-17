import { describe, expect, it } from "vitest"
import { approvalGateBlockers, headerBlockerLabel } from "./rail-blockers"

const clear = {
  status: "UNDER_REVIEW",
  affordabilityCaptured: true,
  affordable: true,
  recklessLendingAssessed: true,
  clientAffordabilityDeclared: true,
  openCreditChecks: 0,
}

describe("approvalGateBlockers", () => {
  it("is empty when every approval gate the rail can see is clear", () => {
    expect(approvalGateBlockers(clear)).toEqual([])
  })

  // Fair Score audit 2026-10-16: the panel said NOT AFFORDABLE and approval
  // was refused (422 "Affordability gate") while the header said NO BLOCKERS.
  it("reports an unaffordable assessment", () => {
    expect(approvalGateBlockers({ ...clear, affordable: false })).toEqual([
      expect.objectContaining({ label: "Not affordable", tone: "danger" }),
    ])
  })

  // ...and after Return to review, with the NCA checks cleared.
  it("reports the NCA checks a return to review cleared", () => {
    expect(approvalGateBlockers({ ...clear, recklessLendingAssessed: false, clientAffordabilityDeclared: false }))
      .toEqual([expect.objectContaining({ label: "NCA checks not confirmed" })])
    expect(approvalGateBlockers({ ...clear, clientAffordabilityDeclared: false }))
      .toEqual([expect.objectContaining({ label: "NCA checks not confirmed" })])
  })

  it("reports open credit checks", () => {
    expect(approvalGateBlockers({ ...clear, openCreditChecks: 2 }))
      .toEqual([expect.objectContaining({ label: "2 open credit checks" })])
  })

  it("leaves affordability to the existing pending blocker until it is captured", () => {
    expect(approvalGateBlockers({ ...clear, affordabilityCaptured: false, affordable: false })).toEqual([])
  })

  it.each(["DRAFT", "SUBMITTED", "APPROVED", "DECLINED", "DISBURSED"])("says nothing for %s", (status) => {
    expect(approvalGateBlockers({ ...clear, status, affordable: false, recklessLendingAssessed: false, openCreditChecks: 1 })).toEqual([])
  })
})

describe("headerBlockerLabel", () => {
  it("counts the rail's own list and only says no blockers when it is empty", () => {
    expect(headerBlockerLabel([])).toBe("No blockers")
    expect(headerBlockerLabel(approvalGateBlockers({ ...clear, affordable: false }))).toBe("1 blocker")
    expect(headerBlockerLabel(approvalGateBlockers({ ...clear, affordable: false, openCreditChecks: 1 }))).toBe("2 blockers")
  })
})
