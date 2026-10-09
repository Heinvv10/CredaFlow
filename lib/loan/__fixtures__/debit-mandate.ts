import { calculateLoan, type LoanCalcInput } from "@/lib/loan-calculator"
import {
  AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
  APPROVAL_AFFORDABILITY_POLICY_VERSION,
  createAffordabilityContractEvidence,
  createAffordabilityExpenseEvidence,
  createAffordabilitySnapshot,
  type AffordabilityDecisionInputs,
} from "@/lib/affordability/snapshot"

export function createDebitMandateTestEvidence(overrides: Partial<LoanCalcInput> = {}) {
  const startDate = new Date("2026-07-01T00:00:00.000Z")
  const pricing: LoanCalcInput = {
    principal: 600_000,
    termDays: 90,
    interestRatePm: 0,
    interestModel: "REDUCING_BALANCE",
    initiationFeePct: 0.05,
    initiationFeeMax: 0,
    monthlyServiceFee: 6_900,
    initiationFeePayment: "DEFERRED",
    ...overrides,
    // Required pricing discriminators must not become optional merely because
    // a Partial override can explicitly carry `undefined`.
    initiationFeeModel: overrides.initiationFeeModel ?? "FLAT_PCT",
    productType: overrides.productType ?? "PERSONAL_LOAN",
  }
  const calculation = calculateLoan(pricing, startDate)
  const proposedInstalmentCents = calculation.monthlyInstalment
  const inputs: AffordabilityDecisionInputs = {
    monthlyIncomeCents: 2_000_000,
    monthlyExpensesCents: 800_000,
    applicationDebtCents: 0,
    clientDebtCents: 0,
    declaredDebtCents: 0,
    bureauObligationsCents: 0,
    proposedInstalmentCents,
    principalCents: pricing.principal,
    termDays: pricing.termDays,
    productId: "debit-mandate-test-product",
    interestRatePm: pricing.interestRatePm,
    interestModel: pricing.interestModel,
    initiationFeeModel: pricing.initiationFeeModel,
    initiationFeePct: pricing.initiationFeePct,
    initiationFeeMaxCents: pricing.initiationFeeMax,
    monthlyServiceFeeCents: pricing.monthlyServiceFee,
    productType: pricing.productType,
    initiationFeePayment: pricing.initiationFeePayment ?? "DEFERRED",
    ndiBufferPct: 100,
  }
  const expenseEvidence = createAffordabilityExpenseEvidence({
    grossMonthlyIncome: 2_000_000,
    monthlyIncome: inputs.monthlyIncomeCents,
    monthlyExpenses: inputs.monthlyExpensesCents,
    expenseBreakdown: {
      id: "debit-mandate-test-expenses",
      updatedAt: startDate,
      housing: 400_000,
      transport: 150_000,
      food: 150_000,
      education: 0,
      insurance: 50_000,
      clothing: 0,
      entertainment: 0,
      medical: 50_000,
      other: 0,
      belowMleJustification: null,
    },
  })
  const netDisposableIncomeCents = inputs.monthlyIncomeCents - inputs.monthlyExpensesCents
  const approval = createAffordabilitySnapshot({
    stage: "APPROVAL",
    policyVersion: APPROVAL_AFFORDABILITY_POLICY_VERSION,
    capturedAt: startDate,
    capturedById: "debit-mandate-test-officer",
    inputs,
    applicationDebts: [],
    clientDebts: [],
    expenseEvidence,
    bureauEvidence: null,
    calculation,
    calculationStartDate: startDate,
    outcome: {
      netDisposableIncomeCents,
      ndiAfterLoanCents: netDisposableIncomeCents - proposedInstalmentCents,
      requiredNdiCents: proposedInstalmentCents,
      isAffordable: true,
      reason: null,
    },
  })
  const contract = createAffordabilityContractEvidence(approval, startDate, {
    documentSha256: "a".repeat(64),
    calculator: approval.calculator,
  })
  const maturityDate = calculation.schedule.at(-1)?.dueDate
  if (!maturityDate) throw new Error("Debit-mandate test calculation has no schedule")

  return {
    calculation,
    startDate,
    maturityDate,
    initiationFeePayment: inputs.initiationFeePayment,
    affordabilityResult: {
      schemaVersion: AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
      approval,
      contract,
    },
    schedule: calculation.schedule.map((item) => ({
      installmentNo: item.installmentNo,
      dueDate: item.dueDate,
      principalDue: item.principalDue,
      interestDue: item.interestDue,
      feesDue: item.feesDue,
      totalDue: item.totalDue,
    })),
  }
}
