import { describe, expect, it } from "vitest"
import { calculateLoan } from "@/lib/loan-calculator"
import { evaluateAffordabilityGate } from "@/lib/decision/affordability-gate"
import { verifyCurrentAffordabilityApproval } from "@/lib/affordability/current-approval"
import {
  APPROVAL_AFFORDABILITY_POLICY_VERSION,
  createAffordabilityExpenseEvidence,
  createAffordabilitySnapshot,
  createBureauDecisionEvidence,
  createSubmissionAffordabilitySnapshot,
  normaliseAffordabilityDebts,
  totalAffordabilityDebt,
  withAffordabilitySnapshot,
} from "@/lib/affordability/snapshot"
import { applicationDebt, applicationFixture, capturedAt, client, debt, product, submittedAt, tenantConfig } from "@/lib/affordability/__fixtures__/approval-evidence"

/** What decide freezes for a key-facts approval: no bureau check, no credit life, the schedule from the decision instant. */
function keyFactsApplication() {
  const calculation = calculateLoan({ principal: 500_000, termDays: 90, ...product, initiationFeePayment: "DEFERRED" }, capturedAt)
  const applicationDebts = normaliseAffordabilityDebts([applicationDebt])
  const clientDebts = normaliseAffordabilityDebts([debt])
  const debtCents = totalAffordabilityDebt(clientDebts)
  const inputs = {
    monthlyIncomeCents: client.monthlyIncome, monthlyExpensesCents: client.monthlyExpenses,
    applicationDebtCents: totalAffordabilityDebt(applicationDebts), clientDebtCents: debtCents, declaredDebtCents: debtCents, bureauObligationsCents: 0,
    proposedInstalmentCents: calculation.monthlyInstalment, creditLifePremiumCents: 0,
    principalCents: 500_000, termDays: 90, productId: "product-1", interestRatePm: product.interestRatePm, productType: product.productType,
    interestModel: product.interestModel, initiationFeeModel: product.initiationFeeModel, initiationFeePct: product.initiationFeePct,
    initiationFeeMaxCents: product.initiationFeeMax, monthlyServiceFeeCents: product.monthlyServiceFee, initiationFeePayment: "DEFERRED" as const, ndiBufferPct: tenantConfig.ndiBufferPct,
  }
  const affordability = evaluateAffordabilityGate(inputs)
  const approval = createAffordabilitySnapshot({
    stage: "APPROVAL", policyVersion: APPROVAL_AFFORDABILITY_POLICY_VERSION, capturedAt, capturedById: "officer-1", inputs, applicationDebts, clientDebts,
    expenseEvidence: createAffordabilityExpenseEvidence(client),
    bureauEvidence: createBureauDecisionEvidence({ check: null, minimumScore: tenantConfig.bureauMinScore, blockAdverse: tenantConfig.bureauBlockAdverse, override: null }),
    calculation, calculationStartDate: capturedAt,
    outcome: {
      netDisposableIncomeCents: affordability.ndi, ndiAfterLoanCents: affordability.ndi - calculation.monthlyInstalment, requiredNdiCents: affordability.requiredNdi,
      isAffordable: !affordability.blocked, reason: affordability.reason ?? null,
    },
  })
  const submission = createSubmissionAffordabilitySnapshot({
    capturedAt: submittedAt, capturedById: "officer-1", client, applicationDebts: [applicationDebt], clientDebts: [debt],
    application: { appliedAmount: 500_000, appliedTermDays: 90, productId: "product-1", initiationFeePayment: "DEFERRED", creditLifeMonthlyPremiumCents: 0 }, product,
  })
  return {
    ...applicationFixture("APPROVED"),
    disclosureRegime: "KEY_FACTS",
    affordabilityResult: withAffordabilitySnapshot(withAffordabilitySnapshot(null, submission), approval) as unknown,
    bureauReviewGeneration: null,
    creditLifeElection: null, creditLifeProductId: null, creditLifeProductName: null, creditLifeInsurerId: null, creditLifeInsurerName: null,
    creditLifeMonthlyPremiumCents: null, creditLifeDisclosureVersion: null, creditLifeDisclosureSha256: null, creditLifeDisclosureAcknowledgedAt: null, creditLifeDisclosureAcknowledgedBy: null,
    pasqVersion: null, pasqGeneratedAt: null, pasqDocumentId: null, pasqDocumentSha256: null, pasqEvidence: null, pasqEvidenceSha256: null,
    pasqAcknowledgedAt: null, pasqAcknowledgedBy: null, pasqAcknowledgedSha256: null, approvedPasqDocumentSha256: null,
  }
}

const verify = (application: ReturnType<typeof keyFactsApplication>, config = tenantConfig) =>
  verifyCurrentAffordabilityApproval({ application: application as never, bureauCheck: null, tenantConfig: config })

/** Parsed and re-serialised, as a stored snapshot is: the tampering a database write could do. */
function withFrozenPrincipal(application: ReturnType<typeof keyFactsApplication>, principalCents: number) {
  const store = JSON.parse(JSON.stringify(application.affordabilityResult)) as { approval: { inputs: { principalCents: number } } }
  store.approval.inputs.principalCents = principalCents
  return { ...application, affordabilityResult: store }
}

describe("a KEY_FACTS approval at payout: no bureau and no PASQ, everything else as an NCA approval", () => {
  it("holds with neither a bureau check nor a PASQ", () => {
    const result = verify(keyFactsApplication())
    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.calculation.principal).toBe(500_000)
  })

  it("refuses the frozen terms altered after approval (the snapshot no longer hashes to itself)", () => {
    expect(verify(withFrozenPrincipal(keyFactsApplication(), 800_000))).toEqual({ ok: false, reason: "changed" })
  })

  it("refuses approved terms on the application that differ from the frozen approval", () => {
    expect(verify({ ...keyFactsApplication(), approvedAmount: 800_000 })).toEqual({ ok: false, reason: "changed" })
    expect(verify({ ...keyFactsApplication(), approvedTermDays: 180 })).toEqual({ ok: false, reason: "changed" })
    expect(verify({ ...keyFactsApplication(), initiationFeePayment: "UPFRONT" as "DEFERRED" })).toEqual({ ok: false, reason: "changed" })
    expect(verify({ ...keyFactsApplication(), productId: "another-product" })).toEqual({ ok: false, reason: "changed" })
  })

  it("the approval fingerprint binds the borrower's finances and the lender's policy at payout", () => {
    const application = keyFactsApplication()
    expect(verify({ ...application, client: { ...application.client, monthlyIncome: 900_000 } })).toEqual({ ok: false, reason: "changed" })
    expect(verify({ ...application, client: { ...application.client, debtObligations: [{ ...debt, monthlyInstalment: 90_000 }] } })).toEqual({ ok: false, reason: "changed" })
    expect(verify(application, { ...tenantConfig, ndiBufferPct: 120 })).toEqual({ ok: false, reason: "changed" })
  })

  it("is not skipped for the submission snapshot or an incomplete bureau override", () => {
    expect(verify({ ...keyFactsApplication(), submittedAt: null as never })).toEqual({ ok: false, reason: "submission_missing" })
    expect(verify({ ...keyFactsApplication(), bureauOverrideAt: capturedAt })).toEqual({ ok: false, reason: "override_incomplete" })
  })

  it("an NCA application is still asked for both", () => {
    const { disclosureRegime: _regime, ...withoutRegime } = keyFactsApplication()
    expect(verify(withoutRegime as never)).toEqual({ ok: false, reason: "bureau_missing" })
    expect(verifyCurrentAffordabilityApproval({
      application: { ...withoutRegime, bureauOverrideAt: capturedAt, bureauOverrideReason: "A reasoned override", bureauOverrideById: "officer-1" } as never,
      bureauCheck: null, tenantConfig,
    })).toEqual({ ok: false, reason: "pasq_changed" })
  })
})
