import { allocateReceipt } from "@/lib/loan/receipt-allocation"
import { sastCalendarDay } from "@/lib/loan/settlement"
import { isLastDayOfMonth, isoDay } from "@/lib/loan/day-number"
import { withoutPausedDays } from "@/lib/loan/charge-pauses"
import {
  emptyResult,
  type ChargePosting,
  type DefaultChargeInput,
  type DefaultChargeResult,
  type ReceiptSplit,
} from "@/lib/loan/default-charges"

// Arrears charges on a NON_NCA (asset finance) agreement. ALL money is CENTS.
// The NCA counterpart is lib/loan/default-charges.ts; the replay
// (lib/loan/charges-replay.ts) picks one by Loan.ncaRegime, and this returns
// the same result shape so lib/loan/charges-sync.ts persists it the same way.
//
// Pure and replayed from scratch, like the NCA engine. The contract's terms
// (slice-1 goal, decision 2a.4), not the Act's:
//  - Default interest runs from the day after a missed due date on the OVERDUE
//    amount: the unpaid principal AND unpaid contractual interest of every
//    instalment past its due date. Commercial instalment-sale terms charge
//    interest on "all amounts overdue", and overdue contractual interest is
//    money the lender should already hold. Contractual fees and premiums,
//    default interest and collection fees are NOT in the base: nothing
//    compounds on a charge.
//  - Rate: (contract annual rate + the agreed margin) / 365, actual/365. A
//    day accrues only once complete, so the as-of day itself never accrues.
//    Interest posts aggregated per calendar month, as in the NCA engine.
//  - A collection fee posts once per missed instalment, dated the day after
//    its due date, when the instalment is still unpaid at the end of that day.
//  - A receipt pays default interest, the due contractual interest, the
//    collection fees, the due contractual fees, then principal, then the
//    instalments not yet due (allocateReceipt). Here that order is the
//    CONTRACT's allocation clause, not NCA s126(3), which does not apply.
//    Before `accrueFrom`, receipts replay in the order they were booked in:
//    the schedule instalment by instalment (the same go-live rule as NCA).
//  - None of the NCA rules apply: no in duplum cap (s103(5)), no Section 129
//    letter charge, no post-maturity service fee.
//  - Terms unset on the agreement (null) mean that component is zero: no margin
//    means NO default interest (a margin of 0 means the contract rate alone);
//    no fee means no collection fee.
//  - `accrueUntil` (write-off, cancellation, closing): nothing accrues or posts
//    on or after it; receipts are still allocated.
//  - `pauses` (a recovery's charge freeze): nothing accrues or posts on a paused
//    day, a collection fee falling on one is not charged later, and accrual
//    resumes after it; receipts are still allocated.

export interface NonNcaArrearsTerms {
  /** Loan.nonNcaDefaultInterestMargin (the deal's signed term, copied at booking; charges-replay nonNcaArrearsTerms): annual decimal over the contract rate; null = no default interest */
  defaultInterestMargin: number | null
  /** Loan.nonNcaCollectionFeeCents (copied at booking): per missed instalment; null = none */
  collectionFeeCents: number | null
}

export interface ContractRatePeriod {
  effectiveDate: Date
  /** Annual decimal rate (ContractRate.resultingRate). */
  annualRate: number
}

/** The NCA input without the NCA-only charges (Section 129 letters, post-maturity service fee). */
export type NonNcaChargeInput = Omit<DefaultChargeInput, "adminCharges" | "monthlyServiceFee"> & NonNcaArrearsTerms & {
  /** Effective-dated contract rates; the booked Loan rate is the legacy fallback. */
  contractRateHistory?: ContractRatePeriod[]
}

export function computeNonNcaCharges(input: NonNcaChargeInput): DefaultChargeResult {
  const rows = input.schedule
    .map((row, index) => ({ ...row, index, dueDay: sastCalendarDay(row.dueDate) }))
    .sort((a, b) => a.dueDay - b.dueDay)
  if (rows.length === 0) return emptyResult(input.receipts)
  const endDay = sastCalendarDay(input.asOf)
  const accrueFromDay = input.accrueFrom ? sastCalendarDay(input.accrueFrom) : -Infinity
  const untilDay = input.accrueUntil ? sastCalendarDay(input.accrueUntil) : Infinity
  const chargeable = withoutPausedDays((day) => day >= accrueFromDay && day < untilDay, input.pauses)
  const rates = (input.contractRateHistory ?? [])
    .map((rate) => ({ day: sastCalendarDay(rate.effectiveDate), annualRate: rate.annualRate }))
    .sort((a, b) => a.day - b.day)
  const contractAnnualRateOn = (day: number) => {
    let annualRate = input.interestRatePm * 12
    for (const rate of rates) {
      if (rate.day > day) break
      annualRate = rate.annualRate
    }
    return annualRate
  }
  const collectionFee = input.collectionFeeCents ?? 0

  // Receipts in time order; a future-dated receipt counts on the as-of day.
  const receipts = input.receipts
    .map((r, index) => ({ ...r, index, at: r.receivedAt.getTime(), day: Math.min(endDay, sastCalendarDay(r.receivedAt)) }))
    .sort((a, b) => a.day - b.day || a.at - b.at || a.index - b.index)

  const postings: ChargePosting[] = []
  const splits: ReceiptSplit[] = []
  let interestExact = 0
  let interestPosted = 0
  let interestPaid = 0
  let feesAccrued = 0
  let feesPaid = 0
  let pool = 0
  let unallocated = 0
  const paid = rows.map(() => 0)
  const completedBy: Array<string | null> = rows.map(() => null)

  function postInterestTo(day: number) {
    const amount = Math.round(interestExact) - interestPosted
    if (amount <= 0) return
    interestPosted += amount
    postings.push({ type: "DEFAULT_INTEREST", day: isoDay(day), amount })
  }

  const firstDay = Math.min(rows[0].dueDay, ...receipts.map((receipt) => receipt.day))
  let next = 0
  for (let day = firstDay; day <= endDay; day++) {
    // 1. The day's receipts, in time order.
    for (; next < receipts.length && receipts[next].day === day; next++) {
      const receipt = receipts[next]
      const before = [...paid]
      const split = allocateReceipt({
        amount: receipt.amount, day, rows, paid, s126: day >= accrueFromDay,
        defaultInterestOwed: Math.round(interestExact) - interestPaid, chargesOwed: feesAccrued - feesPaid,
      })
      rows.forEach((row, i) => { if (before[i] < row.totalDue && paid[i] >= row.totalDue) completedBy[i] = receipt.id })
      interestPaid += split.toDefaultInterest
      feesPaid += split.toFees
      pool += split.toSchedule
      unallocated += split.unallocated
      splits.push({
        receiptId: receipt.id, toDefaultInterest: split.toDefaultInterest, toFees: split.toFees, toSchedule: split.toSchedule,
      })
    }
    if (day >= endDay) break

    // 2. End of a completed day: a collection fee per instalment missed the
    //    day before, then the day's default interest on what is overdue.
    let overdueBase = 0
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (row.dueDay >= day || paid[i] >= row.totalDue) continue
      // An instalment is paid interest, then fees, then principal.
      overdueBase += Math.max(0, row.interestDue - paid[i]) + Math.min(row.principalDue, row.totalDue - paid[i])
      if (row.dueDay === day - 1 && collectionFee > 0 && chargeable(day)) {
        feesAccrued += collectionFee
        postings.push({ type: "COLLECTION_FEE", day: isoDay(day), amount: collectionFee })
      }
    }
    const dailyRate = input.defaultInterestMargin === null
      ? 0
      : (contractAnnualRateOn(day) + input.defaultInterestMargin) / 365
    if (chargeable(day)) interestExact += overdueBase * dailyRate
    if (isLastDayOfMonth(day) && day < untilDay) postInterestTo(day)
  }
  const lastPostingDay = Math.min(endDay, untilDay) - 1
  if (lastPostingDay >= firstDay) postInterestTo(lastPostingDay)

  const interestAccrued = Math.round(interestExact)
  return {
    postings,
    interestAccrued,
    interestPaid,
    interestOutstanding: interestAccrued - interestPaid,
    feesAccrued,
    feesPaid,
    feesOutstanding: feesAccrued - feesPaid,
    scheduleAllocated: pool,
    scheduleRows: input.schedule.map((_, index) => {
      const i = rows.findIndex((row) => row.index === index)
      return { paid: paid[i], completedBy: completedBy[i] }
    }),
    unallocated,
    receiptSplits: splits,
    // No in duplum on a NON_NCA agreement.
    inDuplum: null,
  }
}
