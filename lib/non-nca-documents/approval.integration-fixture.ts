/**
 * An approval snapshot (the frozen pricing an APPROVED application carries in
 * affordabilityResult) for given terms, built the way the affordability fixtures
 * build theirs (lib/affordability/__fixtures__/approval-evidence.ts), so the quote
 * of a key-facts document is proven against evidence the real verifier accepts.
 * Synthetic. Not a test file.
 */
import { calculateLoan } from "@/lib/loan-calculator"
import { evaluateAffordabilityGate } from "@/lib/decision/affordability-gate"
import {
  APPROVAL_AFFORDABILITY_POLICY_VERSION, createAffordabilityExpenseEvidence, createAffordabilitySnapshot, createBureauDecisionEvidence,
  normaliseAffordabilityDebts, totalAffordabilityDebt, withAffordabilitySnapshot,
} from "@/lib/affordability/snapshot"
import { applicationDebt, bureauCheck, client, debt, tenantConfig } from "@/lib/affordability/__fixtures__/approval-evidence"

export interface ApprovalTerms {
  principalCents: number
  termDays: number
  productId: string
  interestRatePm: number
  interestModel: "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL"
  monthlyServiceFeeCents: number
  /** When the approval was captured; the contract starts then (an approval's calculator never starts after it). Default: now. */
  capturedAt?: Date
}

export function approvedAffordabilityResult(terms: ApprovalTerms): unknown {
  const capturedAt = terms.capturedAt ?? new Date()
  const startDate = capturedAt
  const pricing = {
    productType: "PERSONAL", interestRatePm: terms.interestRatePm, interestModel: terms.interestModel,
    initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0.15, initiationFeeMax: 105_000, monthlyServiceFee: terms.monthlyServiceFeeCents,
  }
  const calculation = calculateLoan({ principal: terms.principalCents, termDays: terms.termDays, ...pricing, initiationFeePayment: "DEFERRED" }, startDate)
  const applicationDebts = normaliseAffordabilityDebts([applicationDebt])
  const clientDebts = normaliseAffordabilityDebts([debt])
  const applicationDebtCents = totalAffordabilityDebt(applicationDebts)
  const clientDebtCents = totalAffordabilityDebt(clientDebts)
  const inputs = {
    monthlyIncomeCents: client.monthlyIncome, monthlyExpensesCents: client.monthlyExpenses, applicationDebtCents, clientDebtCents,
    declaredDebtCents: Math.max(applicationDebtCents, clientDebtCents), bureauObligationsCents: 25_000,
    proposedInstalmentCents: calculation.monthlyInstalment, creditLifePremiumCents: 0, principalCents: terms.principalCents, termDays: terms.termDays,
    productId: terms.productId, interestRatePm: pricing.interestRatePm, productType: pricing.productType, interestModel: pricing.interestModel,
    initiationFeeModel: pricing.initiationFeeModel, initiationFeePct: pricing.initiationFeePct, initiationFeeMaxCents: pricing.initiationFeeMax,
    monthlyServiceFeeCents: pricing.monthlyServiceFee, initiationFeePayment: "DEFERRED" as const, ndiBufferPct: tenantConfig.ndiBufferPct,
  }
  const affordability = evaluateAffordabilityGate(inputs)
  const approval = createAffordabilitySnapshot({
    stage: "APPROVAL", policyVersion: APPROVAL_AFFORDABILITY_POLICY_VERSION, capturedAt, capturedById: "officer-1", inputs, applicationDebts, clientDebts,
    expenseEvidence: createAffordabilityExpenseEvidence(client),
    bureauEvidence: createBureauDecisionEvidence({ check: bureauCheck, minimumScore: tenantConfig.bureauMinScore, blockAdverse: tenantConfig.bureauBlockAdverse, override: null }),
    calculation, calculationStartDate: startDate,
    outcome: {
      netDisposableIncomeCents: affordability.ndi, ndiAfterLoanCents: affordability.ndi - calculation.monthlyInstalment,
      requiredNdiCents: affordability.requiredNdi, isAffordable: !affordability.blocked, reason: affordability.reason ?? null,
    },
  })
  return withAffordabilitySnapshot(null, approval)
}
