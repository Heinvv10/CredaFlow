import { calculateLoan } from "@/lib/loan-calculator"
import { evaluateAffordabilityGate } from "@/lib/decision/affordability-gate"
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
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import { applicationDebt, applicationFixture, capturedAt, client, debt, product, submittedAt, tenantConfig } from "@/lib/affordability/__fixtures__/approval-evidence"

/** What decide freezes for a key-facts approval: no bureau check, no credit life, the schedule from the decision instant. */
export function keyFactsApplication() {
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
    borrowerIdentity: biometricSubjectFingerprint(client),
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
