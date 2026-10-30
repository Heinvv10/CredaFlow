import { capInitiationFee, ncaInitiationFeeCap } from "./loan/nca-fee-cap"
import { isNcaJurisdiction } from "./jurisdiction/active"
import { monthlyEquivalentInstalment } from "./product-engine/instalment"
import { generateSchedule } from "./product-engine/schedule"
import type { RepaymentTerms } from "./product-engine/types"

// All amounts in CENTS (integers)

export interface LoanCalcInput {
  principal: number // cents
  termDays: number
  interestRatePm: number // e.g. 0.05 = 5% per month
  interestModel: "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL"
  /**
   * How the fee is PRICED (LoanProduct.initiationFeeModel).
   *  - "FLAT_PCT": `initiationFeePct` x principal.
   *  - "NCA_REG42": the Reg 42 schedule itself, so the configured price and the
   *    charged price are the same number and the product config stops
   *    advertising a percentage the engine overrides.
   * `initiationFeeMax` applies as a commercial cap under BOTH models.
   *
   * REQUIRED, for the same reason `productType` is. An optional pricing
   * discriminator reaches the one caller you happened to edit: the marketing
   * quote would price a Micro Loan on the Reg 42 schedule while the signed
   * agreement and the booked loan silently priced it on the flat percentage.
   * A compile error at every origination path is the only reliable enumeration.
   */
  initiationFeeModel: "FLAT_PCT" | "NCA_REG42"
  initiationFeePct: number
  initiationFeeMax: number // cents, 0 = no cap
  monthlyServiceFee: number // cents per month
  /**
   * How the initiation fee is paid — the consumer's option under NCA s.101.
   *  - "DEFERRED" (default): the full principal is advanced and the fee is
   *    collected through the repayment schedule as a separate INTEREST-FREE
   *    amount on the first instalment.
   *  - "UPFRONT": the fee is deducted from the cash advanced (the consumer
   *    receives principal − initiationFee) and is not collected through the
   *    schedule.
   * Per NCR Circular 15 of 2016 the initiation fee on an unsecured / short-term
   * loan is interest-free in BOTH cases — it is never folded into the
   * interest-bearing principal (that is permitted only for instalment /
   * mortgage / secured / lease agreements, NCA s.102).
   */
  initiationFeePayment?: "DEFERRED" | "UPFRONT"
  /**
   * Product category (LoanProduct.productType). Selects which NCA
   * initiation-fee regime applies — the consumer ceiling does NOT govern
   * business / developmental credit. See lib/loan/nca-fee-cap.ts.
   *
   * REQUIRED, deliberately. When it was optional, exactly one of twelve callers
   * passed it and every origination path — including the signed credit
   * agreement and the booked loan — silently clamped a R500,000 PO facility's
   * R10,000 fee to R1,207.50. A compile error is the only thing that makes a
   * missing category impossible to overlook.
   */
  productType: string | null
  /**
   * The repayment structure of a product the engine schedules (lib/product-engine): frequency, bullet / interest-only /
   * amortising, grace. Absent for every product that has none, which then behaves exactly as it always has. With it,
   * `interestModel` is FLAT or REDUCING_BALANCE (never DAILY_ACCRUAL) and `termDays` is not read: the term is
   * `repayment.instalments` periods.
   */
  repayment?: RepaymentTerms
}

export interface LoanCalcResult {
  principal: number
  totalInterest: number
  initiationFee: number
  serviceFees: number
  totalRepayable: number // === sum(schedule.totalDue) in every model/mode
  disbursementAmount: number // cash actually advanced (principal, less the fee if UPFRONT)
  monthlyInstalment: number // 0 for micro loans
  schedule: ScheduleItem[]
}

export interface ScheduleItem {
  installmentNo: number
  dueDate: Date
  principalDue: number
  interestDue: number
  feesDue: number
  totalDue: number
  openingBalance: number
  closingBalance: number
}

export function calculateLoan(
  input: LoanCalcInput,
  startDate: Date = new Date()
): LoanCalcResult {
  const {
    principal,
    termDays,
    interestRatePm,
    interestModel,
    initiationFeeModel,
    initiationFeePct,
    initiationFeeMax,
    monthlyServiceFee,
    initiationFeePayment = "DEFERRED",
    productType,
    repayment,
  } = input

  // Initiation fee: the configured price, then the product's own commercial cap,
  // then the STATUTORY ceiling. The last step is not optional — the price is an
  // operator setting and nothing else stopped a product being configured above
  // the NCA Reg 42 maximum (a flat 15% on a R3,000 loan charged R450 against a
  // ~R419.75 ceiling). See lib/loan/nca-fee-cap.ts.
  //
  // NCA_REG42 prices ON the schedule, so config and charge agree at every
  // principal. It is still passed through capInitiationFee: that is what applies
  // the PO_FUNDING exemption, and it keeps one ceiling for every path.
  let initiationFee =
    initiationFeeModel === "NCA_REG42" && isNcaJurisdiction()
      ? ncaInitiationFeeCap(principal)
      : Math.round(principal * initiationFeePct)
  if (initiationFeeMax > 0) initiationFee = Math.min(initiationFee, initiationFeeMax)
  initiationFee = capInitiationFee(initiationFee, principal, productType)

  const schedule: ScheduleItem[] = []
  let totalInterest = 0
  let serviceFees = 0

  if (repayment) {
    if (interestModel === "DAILY_ACCRUAL") throw new Error("A repayment structure needs a FLAT or REDUCING_BALANCE interest model")
    const generated = generateSchedule({
      principalCents: principal, interestRatePm, interestModel, monthlyServiceFeeCents: monthlyServiceFee, startDate, terms: repayment,
    })
    schedule.push(...generated.schedule)
    totalInterest = generated.totalInterest
    serviceFees = generated.serviceFees
  } else if (interestModel === "FLAT") {
    // Flat: interestRatePm is monthly decimal (e.g. 0.05 = 5%/month)
    const interestRatePerDay = interestRatePm / 30
    totalInterest = Math.round(principal * interestRatePerDay * termDays)
    const dueDate = new Date(startDate)
    dueDate.setDate(dueDate.getDate() + termDays)
    schedule.push({
      installmentNo: 1,
      dueDate,
      principalDue: principal,
      interestDue: totalInterest,
      feesDue: 0,
      totalDue: principal + totalInterest,
      openingBalance: principal,
      closingBalance: 0,
    })
  } else if (interestModel === "REDUCING_BALANCE") {
    // Personal loan: reducing balance, monthly instalments
    const months = Math.round(termDays / 30)
    const r = interestRatePm
    // PMT formula: P * r / (1 - (1+r)^-n). Guard r=0 to avoid 0/0 → NaN.
    const instalment = r === 0
      ? Math.round(principal / months)
      : Math.round(principal * r / (1 - Math.pow(1 + r, -months)))
    let balance = principal
    for (let i = 1; i <= months; i++) {
      const interestDue = Math.round(balance * r)
      const principalDue = i === months ? balance : instalment - interestDue
      const feeDue = monthlyServiceFee
      const dueDate = new Date(startDate)
      dueDate.setMonth(dueDate.getMonth() + i)
      totalInterest += interestDue
      serviceFees += feeDue
      schedule.push({
        installmentNo: i,
        dueDate,
        principalDue,
        interestDue,
        feesDue: feeDue,
        totalDue: principalDue + interestDue + feeDue,
        openingBalance: balance,
        closingBalance: Math.max(0, balance - principalDue),
      })
      balance = Math.max(0, balance - principalDue)
    }
  } else if (interestModel === "DAILY_ACCRUAL") {
    // PO funding: interestRatePm is a MONTHLY rate (same basis as FLAT/REDUCING,
    // and what the product catalog, the seed appRates, and the statutory credit
    // agreement all use). Interest accrues daily by spreading that monthly rate
    // over the days in the term. Applying the monthly rate PER DAY over-charged
    // ~30x — a gross NCA s.100-105 usury breach.
    const dailyRate = interestRatePm / 30
    totalInterest = Math.round(principal * dailyRate * termDays)
    const dueDate = new Date(startDate)
    dueDate.setDate(dueDate.getDate() + termDays)
    schedule.push({
      installmentNo: 1,
      dueDate,
      principalDue: principal,
      interestDue: totalInterest,
      feesDue: 0,
      totalDue: principal + totalInterest,
      openingBalance: principal,
      closingBalance: 0,
    })
  }

  // Monthly service fee on single-payment (bullet) loans. Instalment loans
  // (REDUCING_BALANCE) already fold one service fee into EACH instalment above;
  // FLAT / DAILY_ACCRUAL previously dropped it entirely — the product field
  // existed but was never billed, so micro loans silently charged R0.
  // The NCA-prescribed maximum monthly service fee (currently R60 + VAT = R69) is
  // charged per month of the agreement, so a 30-day micro loan spans one month →
  // one fee. Folded into the single instalment so the schedule still foots to
  // totalRepayable.
  //
  // NOTE (multi-month bullets): every fee-bearing single-payment product today is
  // a FIXED 30-day term (round(30/30) = 1 fee), so the month count is unambiguous.
  // For a hypothetical >30-day fee-bearing bullet product the "per month or part
  // thereof" vs "completed months" basis must be confirmed with legal before it is
  // configured — Math.round would bill 2 fees from day 45, which is a legal call,
  // not an engineering one.
  if (!repayment && interestModel !== "REDUCING_BALANCE" && monthlyServiceFee > 0 && schedule.length > 0) {
    const serviceFeeMonths = Math.max(1, Math.round(termDays / 30))
    const bulletServiceFee = monthlyServiceFee * serviceFeeMonths
    serviceFees += bulletServiceFee
    schedule[0].feesDue += bulletServiceFee
    schedule[0].totalDue += bulletServiceFee
  }

  // Apply the initiation-fee payment mode (NCA s.101 / NCR Circular 15 of 2016).
  // The fee is INTEREST-FREE in both modes and never folded into the
  // interest-bearing principal. The schedule must foot to totalRepayable.
  let disbursementAmount = principal
  let scheduledInitiationFee = 0
  if (initiationFeePayment === "UPFRONT") {
    // Deducted from the cash advanced; not collected through the schedule.
    disbursementAmount = principal - initiationFee
  } else if (schedule.length > 0 && initiationFee > 0) {
    // DEFERRED (default): full principal advanced; fold the interest-free fee
    // into the first instalment so the schedule foots to the stated total.
    schedule[0].feesDue += initiationFee
    schedule[0].totalDue += initiationFee
    scheduledInitiationFee = initiationFee
  }

  // The regular recurring instalment. For a multi-instalment loan that is a
  // later instalment (the one-time fee sits on instalment 1 only); for a
  // single-instalment loan it is the one payment, including any deferred fee.
  // With a repayment structure it is the monthly equivalent of the regular instalment (weekly x 52 / 12, ...), which is what
  // affordability sets against monthly income.
  const monthlyInstalment = repayment
    ? monthlyEquivalentInstalment(schedule, repayment.frequency)
    : schedule.length > 1
      ? (schedule[1]?.totalDue ?? schedule[0]?.totalDue ?? 0)
      : (schedule[0]?.totalDue ?? 0)

  return {
    principal,
    totalInterest,
    initiationFee,
    serviceFees,
    totalRepayable: principal + totalInterest + serviceFees + scheduledInitiationFee,
    disbursementAmount,
    monthlyInstalment,
    schedule,
  }
}

// Display-only rand formatter (every importer is a React/UI component). The
// gap between "R" and the amount is a NON-BREAKING space (U+00A0) so the symbol
// never wraps onto its own line in narrow cards/flex rows. Do NOT reuse this for
// SMS (GSM-7 has no U+00A0 → forces costlier UCS-2) or NCA docs — lib/utils.ts
// keeps the plain-space formatZAR for those channels.
export function formatZAR(cents: number): string {
  return `R\u00A0${(cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`
}
