import { describe, expect, it } from "vitest"
import { calculateLoan } from "@/lib/loan-calculator"
import { evaluateAffordabilityGate } from "@/lib/decision/affordability-gate"
import { affordabilityDecisionSnapshotIsIntact, affordabilityInputFingerprint, calculateLoanFromDecisionInputs, createAffordabilityCalculatorEvidence, createAffordabilitySnapshot, APPROVAL_AFFORDABILITY_POLICY_VERSION } from "./snapshot"
import { buildEvidence, capturedAt, pasqGeneratedAt } from "./__fixtures__/approval-evidence"

// The repayment structure and the product version a loan was priced on are part of what approval froze (lib/product-engine).
const { approval } = buildEvidence()
const repayment = { frequency: "WEEKLY" as const, structure: "AMORTISING" as const, graceKind: "NONE" as const, graceInstalments: 0, instalments: 12 }
const version = { id: "pv-1", version: 3, baseRatePm: 0.03, pricingRuleId: "rule-1", pricingRuleName: "Best grades", pricingInputs: { segment: "SALARIED", channel: null, campaignCode: null, riskRank: 0 } }

const snapshotWith = (extra: Record<string, unknown>) => {
  const draft = { ...approval.inputs, ...extra } as typeof approval.inputs
  const evidence = createAffordabilityCalculatorEvidence(calculateLoanFromDecisionInputs(draft, pasqGeneratedAt), pasqGeneratedAt)
  const inputs = { ...draft, proposedInstalmentCents: evidence.recurringInstalmentCents + (draft.creditLifePremiumCents ?? 0) }
  const gate = evaluateAffordabilityGate(inputs)
  return createAffordabilitySnapshot({
    stage: "APPROVAL", policyVersion: APPROVAL_AFFORDABILITY_POLICY_VERSION, capturedAt, capturedById: "officer-1", inputs,
    applicationDebts: approval.debts.application, clientDebts: approval.debts.client, expenseEvidence: approval.expenses, bureauEvidence: approval.bureauEvidence,
    calculation: calculateLoanFromDecisionInputs(inputs, pasqGeneratedAt), calculationStartDate: pasqGeneratedAt,
    outcome: { netDisposableIncomeCents: gate.ndi, ndiAfterLoanCents: gate.ndi - inputs.proposedInstalmentCents, requiredNdiCents: gate.requiredNdi, isAffordable: !gate.blocked, reason: gate.reason ?? null },
  })
}

describe("approval inputs that carry a repayment structure", () => {
  it("leave the fingerprint of every input without one exactly as it was", () => {
    expect(affordabilityInputFingerprint(approval.inputs)).toBe(approval.inputFingerprint)
  })

  it("change the fingerprint when a structure or a version is present, and when either changes", () => {
    const base = affordabilityInputFingerprint(approval.inputs)
    const withStructure = affordabilityInputFingerprint({ ...approval.inputs, repayment })
    expect(withStructure).not.toBe(base)
    expect(affordabilityInputFingerprint({ ...approval.inputs, repayment: { ...repayment, frequency: "FORTNIGHTLY" } })).not.toBe(withStructure)
    expect(affordabilityInputFingerprint({ ...approval.inputs, repayment, productVersion: version })).not.toBe(withStructure)
    expect(affordabilityInputFingerprint({ ...approval.inputs, repayment, productVersion: { ...version, pricingRuleId: "rule-2" } })).not.toBe(affordabilityInputFingerprint({ ...approval.inputs, repayment, productVersion: version }))
  })

  it("book the loan on the structure: the schedule is the engine's, not the single instalment of the product row", () => {
    const priced = calculateLoanFromDecisionInputs({ ...approval.inputs, termDays: 84, repayment }, pasqGeneratedAt)
    expect(priced.schedule).toHaveLength(12)
    const without = calculateLoanFromDecisionInputs({ ...approval.inputs, termDays: 84 }, pasqGeneratedAt)
    expect(without.schedule.length).not.toBe(12)
    expect(priced).toEqual({ ...calculateLoan({ principal: approval.inputs.principalCents, termDays: 84, interestRatePm: approval.inputs.interestRatePm, interestModel: approval.inputs.interestModel, initiationFeeModel: approval.inputs.initiationFeeModel ?? "FLAT_PCT", initiationFeePct: approval.inputs.initiationFeePct, initiationFeeMax: approval.inputs.initiationFeeMaxCents, monthlyServiceFee: approval.inputs.monthlyServiceFeeCents, productType: approval.inputs.productType ?? null, initiationFeePayment: approval.inputs.initiationFeePayment, repayment }, pasqGeneratedAt) })
  })

  it("make a snapshot that is intact, and one that stops being intact when the structure or the version is edited", () => {
    const snapshot = snapshotWith({ termDays: 84, repayment, productVersion: version })
    expect(affordabilityDecisionSnapshotIsIntact(snapshot)).toBe(true)
    expect(affordabilityDecisionSnapshotIsIntact({ ...snapshot, inputs: { ...snapshot.inputs, repayment: { ...repayment, instalments: 6 } } })).toBe(false)
    expect(affordabilityDecisionSnapshotIsIntact({ ...snapshot, inputs: { ...snapshot.inputs, productVersion: { ...version, id: "pv-other" } } })).toBe(false)
  })

  it("refuse a structure that contradicts itself, even with a matching fingerprint: a bullet with a grace", () => {
    const bad = { ...repayment, structure: "BULLET" as const, graceKind: "FULL" as const, graceInstalments: 1 }
    const snapshot = snapshotWith({ termDays: 84, repayment })
    const tampered = { ...snapshot, inputs: { ...snapshot.inputs, repayment: bad } }
    expect(affordabilityDecisionSnapshotIsIntact(tampered)).toBe(false)
  })
})
