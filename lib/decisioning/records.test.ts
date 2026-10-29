import { describe, expect, it } from "vitest"
import { facts } from "./facts.test-helpers"
import { autoDecisionRecord } from "./records"

const base = {
  tenantId: "t", applicationId: "a", clientId: "c", reasonCodes: ["BUREAU_SCORE_LOW"], riskGrade: "C", role: "CHAMPION" as const,
  version: { id: "v1", scopeKey: "ALL", version: 3 }, bureauCheckId: "b1", decidedAt: new Date("2026-10-29T08:00:00Z"),
  facts: facts({ productId: "prod-secret", productCode: "SECRET" }),
}

describe("autoDecisionRecord", () => {
  it("a decline is a SYSTEM decision awaiting the s71 review, naming the rule set version", () => {
    const r = autoDecisionRecord({ ...base, decision: "DECLINE", declineCategory: "BUREAU_SCORE" })
    expect(r).toMatchObject({ kind: "CREDIT_DECISION", decision: "DECLINE", recommendation: "BLOCK", actor: { type: "SYSTEM" }, s71ReviewRequired: true })
    expect(r.ruleVersion).toBe("decision-log-v1+decisioning-v1+ALL:v3")
    expect(r.snapshot).toEqual({ reasonCodes: ["BUREAU_SCORE_LOW"], riskGrade: "C", role: "CHAMPION", declineCategory: "BUREAU_SCORE" })
  })
  it("a referral is not flagged for the s71 review", () => {
    expect(autoDecisionRecord({ ...base, decision: "REFER", declineCategory: null })).toMatchObject({ recommendation: "REFER", s71ReviewRequired: false })
  })
  it("keeps amounts and identifiers out of the stored snapshot; the exact facts are only hashed", () => {
    const r = autoDecisionRecord({ ...base, decision: "DECLINE", declineCategory: "BUREAU_SCORE" })
    expect(JSON.stringify(r.snapshot)).not.toMatch(/300000|prod-secret|SECRET/)
    expect(r.exactInputs).not.toHaveProperty("productId")
    expect(r.exactInputs).toHaveProperty("requestedAmountCents", 300_000)
  })
})
