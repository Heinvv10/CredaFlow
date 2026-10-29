import { describe, expect, it } from "vitest"
import { consumerApprovalRecords, consumerDeclineRecord, type ConsumerApprovalFacts } from "./records"

const auto = { ruleVersion: "ALL:v2", ruleSetVersionId: "ver1", reasonCodes: ["RULES_PASSED"], riskGrade: "A", bureauCheckId: "b", exactInputs: { requestedAmountCents: 500_000 } }
const facts = (over: Partial<ConsumerApprovalFacts> = {}): ConsumerApprovalFacts => ({
  tenantId: "t", applicationId: "a", clientId: "c", actor: { userId: "u", role: "LOAN_ADMIN" }, decidedAt: new Date("2026-10-29T08:00:00Z"),
  productType: "MICRO", interestRatePm: 0.05, principalCents: 500_000, termDays: 30, instalmentCents: 100_000, creditLifePremiumCents: 0,
  repaymentMethod: "EFT", monthlyIncomeCents: 2_000_000,
  thresholds: { bureauMinScore: 580, bureauBlockAdverse: false, ndiBufferPct: 110, bureauMaxAgeDays: 60 },
  bureau: { id: "b", provider: "experian", score: 640, unscoreable: false, hasAdverse: false, deceased: false, underDebtReview: false, hasJudgement: false, hasNotice: false, obligations: { totalMonthly: 0 } },
  bureauGateBlocked: false, bureauOverrideReason: null, affordability: { ndiCents: 600_000, requiredNdiCents: 110_000 }, screeningState: "CLEAR", creditCheckFlags: [],
  affordabilitySnapshot: { policyVersion: "approval-ndi-v3", inputFingerprint: "a".repeat(64), decisionFingerprint: "b".repeat(64) },
  ...over,
})

describe("consumerApprovalRecords: an approval by the rules engine", () => {
  it("a staff approval is unchanged: STAFF actor, no automation in the snapshot or version", () => {
    const [decision, offer] = consumerApprovalRecords(facts())
    expect(decision.actor).toEqual({ type: "STAFF", userId: "u", role: "LOAN_ADMIN" })
    expect(decision.ruleVersion).toBe("decision-log-v1+approval-ndi-v3")
    expect(decision.snapshot).not.toHaveProperty("automated")
    expect(offer.actor).toEqual(decision.actor)
  })

  it("an automated approval is a SYSTEM decision that names the rule set and its reason codes, on both rows", () => {
    const [decision, offer] = consumerApprovalRecords(facts({ actor: { system: true }, automation: auto }))
    for (const r of [decision, offer]) expect(r.actor).toEqual({ type: "SYSTEM" })
    expect(decision.ruleVersion).toBe("decision-log-v1+approval-ndi-v3+ALL:v2")
    expect(decision.snapshot).toMatchObject({ automated: { ruleVersion: "ALL:v2", reasonCodes: ["RULES_PASSED"], riskGrade: "A" } })
    // The gates' verdicts are still the ones the staff path computed.
    expect(decision).toMatchObject({ recommendation: "PASS", overrideReason: null })
  })
})

describe("consumerDeclineRecord: a decline by the rules engine", () => {
  const base = { tenantId: "t", applicationId: "a", clientId: "c", decidedAt: new Date("2026-10-29T08:00:00Z"), declineCategory: "BUREAU_SCORE" }
  it("a staff decline is unchanged", () => {
    const r = consumerDeclineRecord({ ...base, actor: { userId: "u", role: "LOAN_ADMIN" } })
    expect(r).toMatchObject({ actor: { type: "STAFF" }, recommendation: "NONE", snapshot: { declineCategory: "BUREAU_SCORE" } })
    expect(r.s71ReviewRequired).toBeFalsy()
  })
  it("an automated decline is a SYSTEM decision awaiting the s71 review, naming the rule set, with the exact facts hashed not stored", () => {
    const r = consumerDeclineRecord({ ...base, actor: { system: true }, automation: { ...auto, reasonCodes: ["BUREAU_SCORE_LOW"] } })
    expect(r).toMatchObject({ actor: { type: "SYSTEM" }, recommendation: "BLOCK", s71ReviewRequired: true })
    expect(r.ruleVersion).toBe("decision-log-v1+approval-ndi-v3+ALL:v2")
    expect(r.snapshot).toMatchObject({ declineCategory: "BUREAU_SCORE", automated: { ruleVersion: "ALL:v2", reasonCodes: ["BUREAU_SCORE_LOW"], riskGrade: "A" } })
    expect(JSON.stringify(r.snapshot)).not.toContain("500000")
    expect(r.exactInputs).toMatchObject({ requestedAmountCents: 500_000, declineCategory: "BUREAU_SCORE" })
    expect(r.evidenceRefs).toMatchObject({ ruleSetVersionId: "ver1", bureauCheckId: "b" })
  })
})
