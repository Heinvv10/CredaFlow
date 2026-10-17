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
//  - None of the NCA rules apply: no statutory in duplum cap (s103(5)); common law still caps interest, no Section 129
//    letter charge, no post-maturity service fee.
//  - Terms unset on the agreement (null) mean that component is zero: no margin
//    means NO default interest (a margin of 0 means the contract rate alone);
//    no fee means no collection fee.
//  - `accrueUntil` (write-off, cancellation, closing): nothing accrues or posts
//    on or after it; receipts are still allocated.
//  - `recoveryCosts` (a repossession's costs charged to the account): one fee
//    posting each, dated the day the sale proceeds were applied, ignoring the
//    freeze, uncapped, and skipped once that day's receipts have settled the loan.
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
  startDate?: Date
  contractualInterestUntil?: Date
  contractRateHistory?: ContractRatePeriod[]
  stoppedCharges?: { at: Date; receipts: Array<{ id: string; defaultInterestAllocated: number; chargeFeesAllocated: number }> }
}

export function computeNonNcaCharges(input: NonNcaChargeInput): DefaultChargeResult {
  const rows = input.schedule
    .map((row, index) => {
      const original = row.commonLawContractualInterestDue ?? row.interestDue
      return { ...row, interestDue: original, totalDue: row.principalDue + original + row.feesDue, originalInterest: original, index, dueDay: sastCalendarDay(row.dueDate) }
    })
    .sort((a, b) => a.dueDay - b.dueDay)
  if (rows.length === 0) return emptyResult(input.receipts)
  const endDay = sastCalendarDay(input.asOf)
  const cancellationDay = input.contractualInterestUntil ? sastCalendarDay(input.contractualInterestUntil) : Infinity
  const accrueFromDay = input.accrueFrom ? sastCalendarDay(input.accrueFrom) : -Infinity
  const untilDay = input.accrueUntil ? sastCalendarDay(input.accrueUntil) : Infinity
  const stopDay = input.stoppedCharges ? sastCalendarDay(input.stoppedCharges.at) : Infinity
  const fixedShares = new Map(input.stoppedCharges?.receipts.map((receipt) => [receipt.id, receipt]))
  const chargeable = withoutPausedDays((day) => day >= accrueFromDay && day < untilDay && day < stopDay, input.pauses)
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

  // A recovery's charged costs, each dated the day its proceeds were applied (see DefaultChargeInput.recoveryCosts).
  const costs = (input.recoveryCosts ?? [])
    .map((cost, index) => ({ ...cost, index, day: sastCalendarDay(cost.date) }))
    .filter((cost) => cost.day <= endDay)
    .sort((a, b) => a.day - b.day || a.index - b.index)
  const scheduleTotal = () => rows.reduce((sum, row) => sum + row.totalDue, 0)

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

  /** Outside the freeze, no cap (NON_NCA), and never on a loan the day's receipts settled: a closed loan is not re-opened. */
  function postRecoveryCost(day: number, amount: number, sourceId: string) {
    if (day < accrueFromDay || day >= untilDay || day >= stopDay || amount <= 0) return
    if (pool >= scheduleTotal() && Math.round(interestExact) - interestPaid + feesAccrued - feesPaid <= 0) return
    feesAccrued += amount
    postings.push({ type: "RECOVERY_COST", day: isoDay(day), amount, sourceId })
  }

  function postInterestTo(day: number) {
    const amount = Math.round(interestExact) - interestPosted
    if (amount <= 0) return
    interestPosted += amount
    postings.push({ type: "DEFAULT_INTEREST", day: isoDay(day), amount })
  }

  const startDay = input.startDate ? sastCalendarDay(input.startDate) : rows[0].dueDay
  const originalDueDays = rows.map((row) => row.dueDay)
  if (cancellationDay <= endDay) {
    rows.forEach((row, i) => {
      const periodStart = i === 0 ? startDay : originalDueDays[i - 1]
      const earned = row.dueDay <= periodStart ? (cancellationDay >= row.dueDay ? row.originalInterest : 0)
        : Math.round(row.originalInterest * Math.max(0, Math.min(1, (cancellationDay - periodStart) / (row.dueDay - periodStart))))
      row.interestDue = earned
      row.totalDue -= row.originalInterest - earned
      row.dueDay = Math.min(row.dueDay, cancellationDay)
    })
  }
  const contractualEarned = rows.map(() => 0)
  const contractualTarget = rows.map(() => 0)
  const firstDay = Math.min(startDay, rows[0].dueDay, ...receipts.map((receipt) => receipt.day), ...costs.map((cost) => cost.day))
  let next = 0
  let nextCost = 0
  for (let day = firstDay; day <= endDay; day++) {
    // The permanent stop forgives unpaid charges, retaining past competition
    // and actual paid shares. Blocked contractual interest is never revived.
    if (day === stopDay) { interestExact = interestPaid; feesAccrued = feesPaid }
    const inDefault = rows.some((row, i) => row.dueDay < day && paid[i] < row.totalDue) || interestExact > interestPaid
    if (inDefault) {
      const capital = rows.reduce((sum, row, i) => sum + Math.min(row.principalDue, Math.max(0, row.totalDue - paid[i])), 0)
      let excess = Math.max(0, contractualEarned.reduce((sum, earned, i) => sum + Math.max(0, earned - Math.min(paid[i], rows[i].interestDue)), 0) + interestExact - interestPaid - capital)
      for (let i = rows.length - 1; i >= 0 && excess > 0; i--) {
        const reduction = Math.min(excess, Math.max(0, contractualEarned[i] - Math.min(paid[i], rows[i].interestDue)))
        contractualEarned[i] -= reduction; rows[i].interestDue -= reduction; rows[i].totalDue -= reduction; excess -= reduction
      }
    }
    // Contractual interest earns across its period, under the SAME ceiling
    // as default interest. Interest blocked on a day never accrues later.
    // Original signed/rate-adjusted amounts remain as replay inputs.
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const periodStart = i === 0 ? startDay : originalDueDays[i - 1]
      const earnedThrough = Math.min(day, cancellationDay)
      const target = originalDueDays[i] <= periodStart
        ? (earnedThrough >= originalDueDays[i] ? row.originalInterest : 0)
        : Math.round(row.originalInterest * Math.max(0, Math.min(1, (earnedThrough - periodStart) / (originalDueDays[i] - periodStart))))
      const increment = target - contractualTarget[i]
      contractualTarget[i] = target
      if (increment <= 0) continue
      const capital = rows.reduce((sum, r, j) => sum + Math.min(r.principalDue, Math.max(0, r.totalDue - paid[j])), 0)
      const unpaid = rows.reduce((sum, r, j) => sum + Math.max(0, contractualEarned[j] - Math.min(paid[j], r.interestDue)), 0)
      const headroom = Math.max(0, capital - unpaid - (interestExact - interestPaid))
      const prepaid = Math.max(0, Math.min(paid[i], row.interestDue) - contractualEarned[i])
      const earned = inDefault ? Math.min(increment, Math.floor(headroom + 1e-8) + prepaid) : increment
      contractualEarned[i] += earned
      const blocked = increment - earned
      row.interestDue -= blocked
      row.totalDue -= blocked
    }
    // 1. The day's receipts, in time order.
    for (; next < receipts.length && receipts[next].day === day; next++) {
      const receipt = receipts[next]
      const before = [...paid]
      const fixed = fixedShares.get(receipt.id)
      const split = allocateReceipt({
        amount: receipt.amount - (fixed?.defaultInterestAllocated ?? 0) - (fixed?.chargeFeesAllocated ?? 0), day, rows, paid, s126: day >= accrueFromDay,
        defaultInterestOwed: fixed ? 0 : Math.round(interestExact) - interestPaid, chargesOwed: fixed ? 0 : feesAccrued - feesPaid,
      })
      if (fixed) { split.toDefaultInterest = fixed.defaultInterestAllocated; split.toFees = fixed.chargeFeesAllocated }
      rows.forEach((row, i) => { if (before[i] < row.totalDue && paid[i] >= row.totalDue) completedBy[i] = receipt.id })
      interestPaid += split.toDefaultInterest
      feesPaid += split.toFees
      // A fixed share can be a live-era payment valued on the stop day.
      // Forgiveness must never turn that paid share into negative debt.
      if (day >= stopDay) { interestExact = interestPaid; feesAccrued = feesPaid }
      pool += split.toSchedule
      unallocated += split.unallocated
      splits.push({
        receiptId: receipt.id, toDefaultInterest: split.toDefaultInterest, toFees: split.toFees, toSchedule: split.toSchedule,
      })
    }
    for (; nextCost < costs.length && costs[nextCost].day === day; nextCost++) postRecoveryCost(day, costs[nextCost].amount, costs[nextCost].id)
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
    // Common-law in duplum: unpaid arrear interest (contractual and default)
    // cannot grow past the unpaid capital. Payments reopen only the headroom
    // they actually create; fees are outside this interest-only ceiling.
    let unpaidCapital = 0
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      unpaidCapital += Math.min(row.principalDue, Math.max(0, row.totalDue - paid[i]))
    }
    const unpaidEarnedInterest = rows.reduce((sum, row, i) => sum + Math.max(0, contractualEarned[i] - Math.min(paid[i], row.interestDue)), 0)
    const headroom = Math.max(0, unpaidCapital - unpaidEarnedInterest - (interestExact - interestPaid))
    if (chargeable(day)) interestExact += Math.min(overdueBase * dailyRate, headroom)
    if (isLastDayOfMonth(day) && day < untilDay) postInterestTo(day)
  }
  const lastPostingDay = Math.min(endDay, untilDay) - 1
  if (lastPostingDay >= firstDay) postInterestTo(lastPostingDay)

  const interestAccrued = Math.round(interestExact)
  return {
    lawfulSchedule: input.schedule.map((_, index) => { const row = rows.find((r) => r.index === index)!; return { interestDue: row.interestDue, totalDue: row.totalDue, contractualInterestDue: row.originalInterest } }),
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
    // The common-law ceiling is applied daily above; this field describes NCA s103(5) only.
    inDuplum: null,
  }
}
