// All amounts in CENTS (integers)
import { calculateLoan } from "@/lib/loan-calculator"
import { PRODUCT_PRICING } from "@/lib/product-pricing"

// Fee/rate parameters are sourced from the single pricing snapshot
// so this qualify engine charges what each real LoanProduct charges. Personal =
// 16.5% init / R1,080 cap / R69 service; micro (short-term) = 15% init /
// R1,000 cap / R69 service (R60 + VAT, billed on the 30-day term); PO = 2.5%/month.
const PERSONAL = PRODUCT_PRICING["personal"]
const MICRO = PRODUCT_PRICING["short-term"]
const PO = PRODUCT_PRICING["purchase-order"]

export interface QualificationResult {
  ndi: number
  maxInstalment: number
  microLoan: { maxAmount: number; totalRepayable: number }
  personalLoan: { maxAmount: number; monthlyInstalment: number }
  poFunding: { maxAmount: number; monthlyInterest: number }
}

function maxQualifyingPrincipal(
  minCents: number,
  maxCents: number,
  stepCents: number,
  paymentFn: (principal: number) => number,
  maxPayment: number
): number {
  if (maxPayment <= 0) return 0
  if (paymentFn(minCents) > maxPayment) return 0

  let lo = Math.round(minCents / stepCents)
  let hi = Math.round(maxCents / stepCents)
  let result = 0

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (paymentFn(mid * stepCents) <= maxPayment) {
      result = mid * stepCents
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

export function computeQualification(
  monthlyIncome: number,
  monthlyExpenses: number,
  existingDebt: number
): QualificationResult {
  const ndi = monthlyIncome - monthlyExpenses - existingDebt
  const maxInstalment = Math.max(0, Math.floor(ndi * 0.70))

  // Personal Loan: 3% pm reducing balance, 60 months. Ceiling R100,000 (matches
  // the PERSONAL LoanProduct maxAmount, the source of truth).
  const personalMax = maxQualifyingPrincipal(
    200000, 10000000, 100000,
    (p) => calculateLoan({
      principal: p, termDays: 1800,
      interestRatePm: PERSONAL.interestRatePm,
      interestModel: PERSONAL.interestModel,
      initiationFeeModel: PERSONAL.initiationFeeModel,
      initiationFeePct: PERSONAL.initiationFeePct, initiationFeeMax: PERSONAL.initiationFeeMax,
      monthlyServiceFee: PERSONAL.monthlyServiceFee,
      productType: "PERSONAL",
    }).monthlyInstalment,
    maxInstalment
  )

  const personalInstalment = personalMax > 0
    ? calculateLoan({
        principal: personalMax, termDays: 1800,
        interestRatePm: PERSONAL.interestRatePm,
        interestModel: PERSONAL.interestModel,
        initiationFeeModel: PERSONAL.initiationFeeModel,
        initiationFeePct: PERSONAL.initiationFeePct, initiationFeeMax: PERSONAL.initiationFeeMax,
        monthlyServiceFee: PERSONAL.monthlyServiceFee,
        productType: "PERSONAL",
      }).monthlyInstalment
    : 0

  // Micro Loan: 5%/mo daily accrual, 30 days (single repayment)
  const microMax = maxQualifyingPrincipal(
    50000, 1000000, 10000,
    (p) => calculateLoan({
      principal: p, termDays: 30,
      interestRatePm: MICRO.interestRatePm,
      interestModel: MICRO.interestModel,
      initiationFeeModel: MICRO.initiationFeeModel,
      initiationFeePct: MICRO.initiationFeePct, initiationFeeMax: MICRO.initiationFeeMax,
      monthlyServiceFee: MICRO.monthlyServiceFee,
      productType: "MICRO",
    }).monthlyInstalment,
    maxInstalment
  )

  // Use the full repayable (principal + interest + initiation fee), not just
  // the single instalment (principal + interest) — the initiation fee is a real
  // cost the borrower repays. monthlyInstalment omits it; totalRepayable doesn't.
  // NOTE: the qualifying ceiling (microMax above) intentionally tests
  // affordability against the monthly instalment (the repayment), not the
  // one-time initiation fee — so this displayed total can exceed the figure the
  // instalment-based ceiling was derived from. Deliberate and conservative.
  const microTotal = microMax > 0
    ? calculateLoan({
        principal: microMax, termDays: 30,
        interestRatePm: MICRO.interestRatePm,
        interestModel: MICRO.interestModel,
        initiationFeeModel: MICRO.initiationFeeModel,
        initiationFeePct: MICRO.initiationFeePct, initiationFeeMax: MICRO.initiationFeeMax,
        monthlyServiceFee: MICRO.monthlyServiceFee,
        productType: "MICRO",
      }).totalRepayable
    : 0

  // PO Funding: 2.5% pm, 120 days — interest-only monthly
  const poMax = maxQualifyingPrincipal(
    1000000, 50000000, 100000,
    (p) => Math.round(p * PO.interestRatePm),
    maxInstalment
  )
  const poMonthlyInterest = poMax > 0 ? Math.round(poMax * PO.interestRatePm) : 0

  return {
    ndi,
    maxInstalment,
    microLoan: { maxAmount: microMax, totalRepayable: microTotal },
    personalLoan: { maxAmount: personalMax, monthlyInstalment: personalInstalment },
    poFunding: { maxAmount: poMax, monthlyInterest: poMonthlyInterest },
  }
}
