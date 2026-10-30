import { describe, expect, it } from "vitest"
import { facts } from "./facts.test-helpers"
import { referRecord } from "./records"

const base = {
  tenantId: "t", applicationId: "a", clientId: "c", reasonCodes: ["LARGE_AMOUNT"], riskGrade: "C", role: "CHAMPION" as const,
  version: { id: "v1", scopeKey: "ALL", version: 3 }, bureauCheckId: "b1", decidedAt: new Date("2026-10-29T08:00:00Z"),
  facts: facts({ productId: "prod-secret", productCode: "SECRET" }),
}

describe("referRecord", () => {
  it("is a SYSTEM referral naming the rule set version and not flagged for the s71 review (nothing was decided against the client)", () => {
    const r = referRecord(base)
    expect(r).toMatchObject({ kind: "CREDIT_DECISION", decision: "REFER", recommendation: "REFER", actor: { type: "SYSTEM" } })
    expect(r.s71ReviewRequired).toBeFalsy()
    expect(r.ruleVersion).toBe("decision-log-v1+decisioning-v1+ALL:v3")
    expect(r.snapshot).toEqual({ reasonCodes: ["LARGE_AMOUNT"], riskGrade: "C", role: "CHAMPION" })
  })
  it("keeps amounts and identifiers out of the stored snapshot; the exact facts are only hashed", () => {
    const r = referRecord(base)
    expect(JSON.stringify(r.snapshot)).not.toMatch(/300000|prod-secret|SECRET/)
    expect(r.exactInputs).not.toHaveProperty("productId")
    expect(r.exactInputs).toHaveProperty("requestedAmountCents", 300_000)
  })
})
