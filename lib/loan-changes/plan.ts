/**
 * What a loan change does to the money: pure, integer cents, no database. Schedules come from the product engine
 * (lib/product-engine/schedule.ts), so a change's rows follow the same rules as a new loan's; this module decides the balance
 * they are generated on, and what is kept and carried. Rules: lib/loan-changes/.claude.md.
 *
 * Fully paid rows stay as they are. A part-paid row is cut down to what the receipts paid, and the rest of the schedule goes.
 * What it held comes back as:
 *   principal                       the balance the new rows repay, so the rows add up to Loan.principal to the cent;
 *   interest and fees already due   carried, spread evenly over the new rows, never added to the balance: no interest on interest;
 *   rows not yet due                priced again on the new terms. Whatever they held above a fresh pricing of the SAME rows on the
 *                                   OLD terms is not time still to run but something already owed (a deferred initiation fee, the
 *                                   interest and fees of a grace or an earlier holiday, what an earlier change carried), so it is
 *                                   carried too. A change that changes nothing therefore changes nothing, to the cent.
 * The next instalment keeps its date unless the change moves it. A moved first instalment or a payment holiday adds the time it
 * skips as simple interest, carried like the rest.
 */
import { recomputeLoanBalances } from "@/lib/loan/balances"
import { sastCalendarDate } from "@/lib/date/sast"
import { evenly } from "@/lib/product-engine/evenly"
import { addPeriods } from "@/lib/product-engine/periods"
import { generateSchedule } from "@/lib/product-engine/schedule"
import { PERIOD_DAYS, PERIODS_PER_YEAR, type EngineInterestModel, type Frequency, type RepaymentStructure, type RepaymentTerms } from "@/lib/product-engine/types"
import type { InPlaceChange } from "./types"

const DAY_MS = 86_400_000

export class LoanChangeRefused extends Error {}

export interface PlanRow {
  id: string
  installmentNo: number
  dueDate: Date
  principalDue: number
  interestDue: number
  feesDue: number
  totalDue: number
  totalPaid: number
  paidAt: Date | null
}

export interface PlanLoan {
  principal: number
  interestRatePm: number
  interestModel: EngineInterestModel
  monthlyServiceFee: number
  startDate: Date
}

export interface PlanInput {
  loan: PlanLoan
  rows: PlanRow[]
  frequency: Frequency
  structure: RepaymentStructure
  change: InPlaceChange
  asOf: Date
}

export type TrimmedRow = Pick<PlanRow, "id" | "principalDue" | "interestDue" | "feesDue" | "totalDue" | "totalPaid">
export type FreshRow = Pick<PlanRow, "installmentNo" | "dueDate" | "principalDue" | "interestDue" | "feesDue" | "totalDue"> & { carriedInterestDue: number; carriedFeesDue: number }

export interface InPlacePlan {
  /** Fully paid rows, unchanged. */
  keep: PlanRow[]
  /** Part-paid rows, cut down to what was paid. */
  trim: TrimmedRow[]
  /** Ids of the rows the change replaces. */
  remove: string[]
  fresh: FreshRow[]
  /** Every row of the schedule after the change, in order. */
  rows: Array<FreshRow & { totalPaid: number }>
  terms: RepaymentTerms
  interestRatePm: number
  /** Principal the new rows repay. */
  balance: number
  carriedInterest: number
  carriedFees: number
  /** Interest of the new rows alone, before what is carried. */
  scheduleInterest: number
  deferredInterest: number
  totalInterest: number
  totalRepayable: number
  maturityDate: Date
  nextPaymentDate: Date
  outstandingPrincipal: number
  arrearsAmount: number
  daysInArrears: number
}

const sastDay = (date: Date) => Date.parse(sastCalendarDate(date)) / DAY_MS
const byDue = (a: PlanRow, b: PlanRow) => a.dueDate.getTime() - b.dueDate.getTime() || a.installmentNo - b.installmentNo

/**
 * What a part-paid row keeps. On a row that fell due the receipts filled its interest, then its fees, then its principal. On a
 * row not yet due they are a prepayment: nothing in it is earned and the new rows charge that period, so all of it is principal.
 */
function trimmed(row: PlanRow, due: boolean): TrimmedRow {
  const paid = row.totalPaid
  if (!due) return { id: row.id, principalDue: paid, interestDue: 0, feesDue: 0, totalDue: paid, totalPaid: paid }
  const interestDue = Math.min(row.interestDue, paid)
  const feesDue = Math.min(row.feesDue, paid - interestDue)
  return { id: row.id, principalDue: paid - interestDue - feesDue, interestDue, feesDue, totalDue: paid, totalPaid: paid }
}

/** Adds what is carried to the rows, spread evenly: every cent lands on a row. */
export function spreadCarried<T extends { interestDue: number; feesDue: number; totalDue: number }>(rows: T[], interest: number, fees: number): Array<T & { carriedInterestDue: number; carriedFeesDue: number }> {
  const interestShare = evenly(interest, rows.length)
  const feeShare = evenly(fees, rows.length)
  return rows.map((row, i) => ({
    ...row, interestDue: row.interestDue + interestShare[i]!, feesDue: row.feesDue + feeShare[i]!, totalDue: row.totalDue + interestShare[i]! + feeShare[i]!,
    carriedInterestDue: interestShare[i]!, carriedFeesDue: feeShare[i]!,
  }))
}

interface Target {
  rate: number
  instalments: number
  /** The first instalment, when the change sets it. */
  firstDueDate: Date | null
  /** Periods a payment holiday skips. */
  holiday: number
}

function targetOf(change: InPlaceChange, rate: number, remaining: number): Target {
  const same = { rate, instalments: remaining, firstDueDate: null, holiday: 0 }
  switch (change.type) {
    case "RATE_CHANGE": return { ...same, rate: change.interestRatePm }
    case "TERM_CHANGE": return { ...same, instalments: change.instalments }
    case "PAYMENT_HOLIDAY": return { ...same, holiday: change.holidayInstalments }
    case "RESTRUCTURE": return { ...same, rate: change.interestRatePm ?? rate, instalments: change.instalments ?? remaining }
    case "RESCHEDULE": return { ...same, firstDueDate: new Date(`${change.firstDueDate}T10:00:00.000Z`) }
  }
}

interface Pricing {
  principal: number
  rate: number
  instalments: number
  first: Date
  /** The dates to keep, row by row, where the change does not move them. */
  dates: readonly Date[]
}

/**
 * The rows of `pricing`: the engine's, each period ending on its due date. FLAT charges the rate on the loan's original principal
 * (a contract fixed at booking), so its interest is priced on that, not on the balance.
 */
function priced(loan: PlanLoan, frequency: Frequency, structure: RepaymentStructure, pricing: Pricing) {
  const { principal, rate, instalments, first, dates } = pricing
  const terms: RepaymentTerms = { frequency, structure, instalments, graceKind: "NONE", graceInstalments: 0 }
  const startDate = addPeriods(first, frequency, structure === "BULLET" ? -instalments : -1)
  const { schedule } = generateSchedule({ principalCents: principal, interestRatePm: rate, interestModel: loan.interestModel, monthlyServiceFeeCents: loan.monthlyServiceFee, startDate, terms })
  const flat = loan.interestModel === "FLAT"
    ? evenly(Math.round((loan.principal * rate * 12 * instalments) / PERIODS_PER_YEAR[frequency]), schedule.length)
    : null
  const dueAfter = (i: number) => dates[i] ?? addPeriods(dates.at(-1) ?? first, frequency, i - Math.max(dates.length - 1, 0))
  return schedule.map((row, i) => {
    const interestDue = flat ? flat[i]! : row.interestDue
    return { dueDate: dueAfter(i), principalDue: row.principalDue, interestDue, feesDue: row.feesDue, totalDue: row.principalDue + interestDue + row.feesDue }
  })
}

const sumOf = <T,>(rows: readonly T[], cents: (row: T) => number) => rows.reduce((sum, row) => sum + cents(row), 0)

/** A rounding difference the other way comes off the first row, which never goes below nothing. */
function lessShortfall<T extends { interestDue: number; feesDue: number; totalDue: number }>(rows: T[], interest: number, fees: number): T[] {
  const [head, ...rest] = rows
  if (!head || (interest === 0 && fees === 0)) return rows
  const interestDue = Math.max(0, head.interestDue + interest)
  const feesDue = Math.max(0, head.feesDue + fees)
  return [{ ...head, interestDue, feesDue, totalDue: head.totalDue - head.interestDue - head.feesDue + interestDue + feesDue }, ...rest]
}

export function planInPlace(input: PlanInput): InPlacePlan {
  const { loan, frequency, structure, change, asOf } = input
  const rows = [...input.rows].sort(byDue)
  const today = sastDay(asOf)
  const settled = (row: PlanRow) => row.totalPaid >= row.totalDue
  const isDue = (row: PlanRow) => sastDay(row.dueDate) <= today
  const keep = rows.filter(settled)
  const open = rows.filter((row) => !settled(row))
  const tail = open.filter((row) => !isDue(row))
  const trim = open.filter((row) => row.totalPaid > 0).map((row) => trimmed(row, isDue(row)))
  const remove = open.filter((row) => row.totalPaid === 0).map((row) => row.id)

  const kept = [...keep.map((row) => row.principalDue), ...trim.map((row) => row.principalDue)]
  const balance = loan.principal - kept.reduce((sum, cents) => sum + cents, 0)
  if (open.length === 0 || balance <= 0) throw new LoanChangeRefused("No principal is left unpaid on this loan to change")

  // Interest and fees of rows due today or earlier are owed whatever the new terms say.
  let carriedInterest = 0
  let carriedFees = 0
  open.filter(isDue).forEach((row) => {
    const paid = trimmed(row, true)
    carriedInterest += row.interestDue - paid.interestDue
    carriedFees += row.feesDue - paid.feesDue
  })

  const anchor = rows.reduce((latest, row) => (settled(row) || isDue(row)) && row.dueDate > latest ? row.dueDate : latest, loan.startDate)
  const remaining = structure === "BULLET"
    ? Math.max(1, Math.round((sastDay(rows.at(-1)!.dueDate) - sastDay(anchor)) / PERIOD_DAYS[frequency]))
    : open.length
  const target = targetOf(change, loan.interestRatePm, remaining)
  if (target.holiday > 0 && structure === "BULLET") throw new LoanChangeRefused("A single-payment loan has no instalments to take a holiday from: reschedule it")

  // The next instalment: the first not yet due. A loan past its last instalment gets the first period end still ahead of it.
  const ahead = (from: Date) => {
    let k = 0
    while (sastDay(addPeriods(from, frequency, k)) <= today) k += 1
    return addPeriods(from, frequency, k)
  }
  const bulletTermMoved = structure === "BULLET" && target.instalments !== remaining
  const next = tail[0] && !bulletTermMoved ? tail[0].dueDate : ahead(bulletTermMoved ? addPeriods(anchor, frequency, target.instalments) : anchor)
  // FLAT interest is on the original principal: the time a change skips is too.
  const gapBase = loan.interestModel === "FLAT" ? loan.principal : balance
  let first = next
  let deferredInterest = 0
  if (target.holiday > 0) {
    // Simple interest for the skipped periods, and the service fee of the months they span, as a full grace defers them.
    const periodRate = frequency === "MONTHLY" ? target.rate : (target.rate * 12) / PERIODS_PER_YEAR[frequency]
    deferredInterest = Math.round(gapBase * periodRate) * target.holiday
    carriedInterest += deferredInterest
    carriedFees += Math.round((target.holiday * PERIOD_DAYS[frequency]) / 30) * loan.monthlyServiceFee
    first = addPeriods(next, frequency, target.holiday)
  }
  if (target.firstDueDate) {
    const gapDays = sastDay(target.firstDueDate) - sastDay(next)
    if (gapDays < 0 || sastDay(target.firstDueDate) <= today) throw new LoanChangeRefused("A rescheduled loan's first instalment must fall after today and on or after its next instalment")
    // The extra days earn simple interest on the balance, carried with the rest.
    carriedInterest += Math.round((gapBase * target.rate * gapDays) / 30)
    first = target.firstDueDate
  }

  // What the rows not yet due hold beyond a fresh pricing of themselves on the old terms is already owed.
  const tailPricing = tail.length === 0 ? [] : priced(loan, frequency, structure, {
    principal: sumOf(tail, (row) => row.principalDue), rate: loan.interestRatePm, instalments: structure === "BULLET" ? remaining : tail.length, first: tail[0]!.dueDate, dates: tail.map((row) => row.dueDate),
  })
  const excessInterest = sumOf(tail, (row) => row.interestDue) - sumOf(tailPricing, (row) => row.interestDue)
  const excessFees = sumOf(tail, (row) => row.feesDue) - sumOf(tailPricing, (row) => row.feesDue)
  carriedInterest += Math.max(0, excessInterest)
  carriedFees += Math.max(0, excessFees)

  const dates = first === next && !bulletTermMoved ? tail.map((row) => row.dueDate) : []
  const generated = priced(loan, frequency, structure, { principal: balance, rate: target.rate, instalments: target.instalments, first, dates })
  const nextNo = rows.reduce((max, row) => Math.max(max, settled(row) || row.totalPaid > 0 ? row.installmentNo : 0), 0) + 1
  const generatedRows = generated.map((row, i) => ({ ...row, installmentNo: nextNo + i }))
  const fresh = lessShortfall(spreadCarried(generatedRows, carriedInterest, carriedFees), Math.min(0, excessInterest), Math.min(0, excessFees))

  const byId = new Map(rows.map((row) => [row.id, row]))
  const after = [
    ...keep.map(({ installmentNo, dueDate, principalDue, interestDue, feesDue, totalDue, totalPaid }) => ({ installmentNo, dueDate, principalDue, interestDue, feesDue, totalDue, totalPaid, carriedInterestDue: 0, carriedFeesDue: 0 })),
    ...trim.map((row) => ({ ...row, installmentNo: byId.get(row.id)!.installmentNo, dueDate: byId.get(row.id)!.dueDate, carriedInterestDue: 0, carriedFeesDue: 0 })),
  ].sort((a, b) => a.installmentNo - b.installmentNo)
  const all = [...after, ...fresh.map((row) => ({ ...row, totalPaid: 0 }))]
  const balances = recomputeLoanBalances(loan.principal, all, asOf)
  const terms: RepaymentTerms = target.holiday > 0
    ? { frequency, structure, instalments: target.instalments + target.holiday, graceKind: "FULL", graceInstalments: target.holiday }
    : { frequency, structure, instalments: target.instalments, graceKind: "NONE", graceInstalments: 0 }
  return {
    keep, trim, remove, fresh, rows: all, terms, interestRatePm: target.rate, balance, carriedInterest, carriedFees,
    scheduleInterest: sumOf(generated, (row) => row.interestDue), deferredInterest,
    totalInterest: all.reduce((sum, row) => sum + row.interestDue, 0),
    totalRepayable: all.reduce((sum, row) => sum + row.totalDue, 0),
    maturityDate: fresh.at(-1)!.dueDate,
    nextPaymentDate: fresh[0]!.dueDate,
    outstandingPrincipal: balances.outstandingPrincipal,
    arrearsAmount: balances.arrearsAmount,
    daysInArrears: balances.daysInArrears,
  }
}
