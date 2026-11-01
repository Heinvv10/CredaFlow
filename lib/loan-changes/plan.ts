/**
 * What a loan change does to the money: pure, integer cents, no database. Schedules come from the product engine
 * (lib/product-engine/schedule.ts), so a change's rows follow the same rules as a new loan's. Rules: lib/loan-changes/.claude.md.
 *
 * A change never re-plans what has fallen due or accrued. Paid rows and rows already due stay as they are, and stay owed. Only rows
 * not yet due change, priced from the principal outstanding on them, from the last due date forward. Whatever they held above a
 * fresh pricing of themselves on the old terms (a deferred fee, a grace's or holiday's interest, what an earlier change carried, a
 * single payment's interest for the whole periods gone by) is already owed, and is carried, spread evenly, never added to the
 * balance: no interest on interest. A later change never reduces what was carried. So a change that changes nothing changes
 * nothing, to the cent.
 *
 * Moving arrears is its own case, RESCHEDULE (plan-reschedule.ts). Every other change refuses a loan with no row left to change.
 */
import { nextPaymentDueDate, recomputeLoanBalances } from "@/lib/loan/balances"
import { sastCalendarDate } from "@/lib/date/sast"
import { evenly } from "@/lib/product-engine/evenly"
import { addPeriods } from "@/lib/product-engine/periods"
import { generateSchedule } from "@/lib/product-engine/schedule"
import { PERIOD_DAYS, PERIODS_PER_YEAR, type EngineInterestModel, type Frequency, type RepaymentStructure, type RepaymentTerms } from "@/lib/product-engine/types"
import { planReschedule } from "./plan-reschedule"
import type { InPlaceChange } from "./types"

type TailChange = Exclude<InPlaceChange, { type: "RESCHEDULE" }>

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
  /** What an earlier change carried onto this row: earned interest and fees, and arrears principal that bears no interest. */
  carriedPrincipalDue?: number
  carriedInterestDue?: number
  carriedFeesDue?: number
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
export type FreshRow = Pick<PlanRow, "installmentNo" | "dueDate" | "principalDue" | "interestDue" | "feesDue" | "totalDue"> & { carriedPrincipalDue: number; carriedInterestDue: number; carriedFeesDue: number }

export interface InPlacePlan {
  /** Rows the change leaves as they are: paid, and, unless it reschedules them, already due. */
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

export const sastDay = (date: Date) => Date.parse(sastCalendarDate(date)) / DAY_MS
export const byDue = (a: PlanRow, b: PlanRow) => a.dueDate.getTime() - b.dueDate.getTime() || a.installmentNo - b.installmentNo

/** Adds what is carried to the rows, spread evenly: every cent lands on a row. */
export function spreadCarried<T extends { principalDue: number; interestDue: number; feesDue: number; totalDue: number }>(rows: T[], interest: number, fees: number, principal = 0): Array<T & { carriedPrincipalDue: number; carriedInterestDue: number; carriedFeesDue: number }> {
  const principalShare = evenly(principal, rows.length)
  const interestShare = evenly(interest, rows.length)
  const feeShare = evenly(fees, rows.length)
  return rows.map((row, i) => ({
    ...row, principalDue: row.principalDue + principalShare[i]!, interestDue: row.interestDue + interestShare[i]!, feesDue: row.feesDue + feeShare[i]!,
    totalDue: row.totalDue + principalShare[i]! + interestShare[i]! + feeShare[i]!,
    carriedPrincipalDue: principalShare[i]!, carriedInterestDue: interestShare[i]!, carriedFeesDue: feeShare[i]!,
  }))
}

interface Target {
  rate: number
  instalments: number
  /** Periods a payment holiday skips. */
  holiday: number
}

function targetOf(change: TailChange, rate: number, remaining: number): Target {
  const same = { rate, instalments: remaining, holiday: 0 }
  switch (change.type) {
    case "RATE_CHANGE": return { ...same, rate: change.interestRatePm }
    case "TERM_CHANGE": return { ...same, instalments: change.instalments }
    case "PAYMENT_HOLIDAY": return { ...same, holiday: change.holidayInstalments }
    case "RESTRUCTURE": return { ...same, rate: change.interestRatePm ?? rate, instalments: change.instalments ?? remaining }
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
export function priced(loan: PlanLoan, frequency: Frequency, structure: RepaymentStructure, pricing: Pricing) {
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

export const sumOf = <T,>(rows: readonly T[], cents: (row: T) => number) => rows.reduce((sum, row) => sum + cents(row), 0)

/** What the old rows held short of a fresh pricing comes off the new rows' own interest and fees, first to last, never off what is carried. */
function lessShortfall(rows: FreshRow[], interest: number, fees: number): FreshRow[] {
  let owedInterest = -interest
  let owedFees = -fees
  return rows.map((row) => {
    const offInterest = Math.min(owedInterest, row.interestDue - row.carriedInterestDue)
    const offFees = Math.min(owedFees, row.feesDue - row.carriedFeesDue)
    owedInterest -= offInterest
    owedFees -= offFees
    return { ...row, interestDue: row.interestDue - offInterest, feesDue: row.feesDue - offFees, totalDue: row.totalDue - offInterest - offFees }
  })
}

/** The rows of the loan after a change, and every figure that follows from them. */
export function finished(input: PlanInput, parts: {
  keep: PlanRow[]; trim: TrimmedRow[]; remove: string[]; fresh: FreshRow[]; terms: RepaymentTerms; interestRatePm: number; balance: number
  carriedInterest: number; carriedFees: number; scheduleInterest: number; deferredInterest: number
}): InPlacePlan {
  const { keep, trim, fresh } = parts
  const byId = new Map(input.rows.map((row) => [row.id, row]))
  const after = [
    ...keep.map(({ installmentNo, dueDate, principalDue, interestDue, feesDue, totalDue, totalPaid, carriedPrincipalDue = 0, carriedInterestDue = 0, carriedFeesDue = 0 }) => ({ installmentNo, dueDate, principalDue, interestDue, feesDue, totalDue, totalPaid, carriedPrincipalDue, carriedInterestDue, carriedFeesDue })),
    ...trim.map((row) => ({ ...row, installmentNo: byId.get(row.id)!.installmentNo, dueDate: byId.get(row.id)!.dueDate, carriedPrincipalDue: 0, carriedInterestDue: 0, carriedFeesDue: 0 })),
  ].sort((a, b) => a.installmentNo - b.installmentNo)
  const all = [...after, ...fresh.map((row) => ({ ...row, totalPaid: 0 }))]
  const balances = recomputeLoanBalances(input.loan.principal, all, input.asOf)
  return {
    ...parts, rows: all,
    totalInterest: sumOf(all, (row) => row.interestDue),
    totalRepayable: sumOf(all, (row) => row.totalDue),
    maturityDate: all.reduce((latest, row) => (row.dueDate > latest ? row.dueDate : latest), fresh[0]!.dueDate),
    nextPaymentDate: nextPaymentDueDate(all)!,
    outstandingPrincipal: balances.outstandingPrincipal,
    arrearsAmount: balances.arrearsAmount,
    daysInArrears: balances.daysInArrears,
  }
}

/**
 * A single payment accrues by the period: a new rate or term runs from the last period end, and the row's interest for the periods
 * before it is what the pricing of the rest leaves over, carried. `anchor` is where its interest starts.
 */
function bulletProgress(row: PlanRow, anchor: Date, frequency: Frequency, today: number) {
  const periods = Math.max(1, Math.round((sastDay(row.dueDate) - sastDay(anchor)) / PERIOD_DAYS[frequency]))
  let gone = 0
  while (gone + 1 < periods && sastDay(addPeriods(anchor, frequency, gone + 1)) <= today) gone += 1
  return { periods, gone, from: addPeriods(anchor, frequency, gone) }
}

export function planInPlace(input: PlanInput): InPlacePlan {
  const { change } = input
  return change.type === "RESCHEDULE" ? planReschedule(input, change) : planTail(input, change)
}

function planTail(input: PlanInput, change: TailChange): InPlacePlan {
  const { loan, frequency, structure, asOf } = input
  const rows = [...input.rows].sort(byDue)
  const today = sastDay(asOf)
  const settled = (row: PlanRow) => row.totalPaid >= row.totalDue
  const tail = rows.filter((row) => !settled(row) && sastDay(row.dueDate) > today)
  const keep = rows.filter((row) => !tail.includes(row))
  if (tail.length === 0) throw new LoanChangeRefused(rows.some((row) => !settled(row)) ? "Every instalment left has already fallen due: reschedule the arrears instead" : "No principal is left unpaid on this loan to change")

  // Money paid ahead is all principal: it is what the rows no longer have to repay.
  const trim = tail.filter((row) => row.totalPaid > 0).map((row): TrimmedRow => ({ id: row.id, principalDue: row.totalPaid, interestDue: 0, feesDue: 0, totalDue: row.totalPaid, totalPaid: row.totalPaid }))
  const remove = tail.filter((row) => row.totalPaid === 0).map((row) => row.id)
  // Arrears principal a reschedule moved bears no interest: only the rest is priced. Money paid ahead lowers what bears interest first.
  const movedPrincipal = sumOf(tail, (row) => row.carriedPrincipalDue ?? 0)
  const paidAhead = sumOf(tail, (row) => row.totalPaid)
  const bearingBefore = sumOf(tail, (row) => row.principalDue) - movedPrincipal
  const bearing = Math.max(0, bearingBefore - paidAhead)
  const interestFree = movedPrincipal - Math.max(0, paidAhead - bearingBefore)
  const balance = bearing + interestFree
  if (balance <= 0) throw new LoanChangeRefused("No principal is left unpaid on this loan to change")
  const pricedPrincipal = bearing > 0 ? bearing : interestFree
  const pricedRate = (rate: number) => (bearing > 0 ? rate : 0)

  const bullet = structure === "BULLET"
    ? bulletProgress(tail[0]!, rows.reduce((latest, row) => (settled(row) && row.dueDate > latest ? row.dueDate : latest), loan.startDate), frequency, today)
    : null
  const remaining = bullet ? bullet.periods - bullet.gone : tail.length
  const target = targetOf(change, loan.interestRatePm, remaining)
  if (target.holiday > 0 && bullet) throw new LoanChangeRefused("A single-payment loan has no instalments to take a holiday from: reschedule it")

  const next = tail[0]!.dueDate
  const bulletMoved = bullet !== null && target.instalments !== remaining
  let first = bulletMoved ? addPeriods(bullet.from, frequency, target.instalments) : next
  let deferredInterest = 0
  let carriedFees = 0
  if (target.holiday > 0) {
    // Simple interest for the skipped periods, and the service fee of the months they span, as a full grace defers them.
    const periodRate = frequency === "MONTHLY" ? target.rate : (target.rate * 12) / PERIODS_PER_YEAR[frequency]
    deferredInterest = bearing > 0 ? Math.round((loan.interestModel === "FLAT" ? loan.principal : bearing) * periodRate) * target.holiday : 0
    carriedFees = Math.round((target.holiday * PERIOD_DAYS[frequency]) / 30) * loan.monthlyServiceFee
    first = addPeriods(next, frequency, target.holiday)
  }

  const dates = tail.map((row) => row.dueDate)
  const oldPricing = priced(loan, frequency, structure, { principal: pricedPrincipal, rate: pricedRate(loan.interestRatePm), instalments: remaining, first: next, dates })
  const excessInterest = sumOf(tail, (row) => row.interestDue) - sumOf(oldPricing, (row) => row.interestDue)
  const excessFees = sumOf(tail, (row) => row.feesDue) - sumOf(oldPricing, (row) => row.feesDue)
  // What an earlier change carried is earned: it stands whatever the pricing says. Below it, the difference comes off the new rows' own.
  const keptInterest = Math.max(0, excessInterest, sumOf(tail, (row) => row.carriedInterestDue ?? 0))
  const keptFees = Math.max(0, excessFees, sumOf(tail, (row) => row.carriedFeesDue ?? 0))
  const carriedInterest = deferredInterest + keptInterest
  carriedFees += keptFees

  const generated = priced(loan, frequency, structure, { principal: pricedPrincipal, rate: pricedRate(target.rate), instalments: target.instalments, first, dates: first === next ? dates : [] })
  const nextNo = rows.reduce((max, row) => Math.max(max, tail.includes(row) ? 0 : row.installmentNo), trim.length > 0 ? Math.max(...tail.filter((row) => row.totalPaid > 0).map((row) => row.installmentNo)) : 0) + 1
  const generatedRows = generated.map((row, i) => ({ ...row, installmentNo: nextNo + i }))
  // With nothing bearing interest the rows are all moved principal, and stay marked so: no later change charges on it.
  const fresh = lessShortfall(spreadCarried(generatedRows, carriedInterest, carriedFees, bearing > 0 ? interestFree : 0), excessInterest - keptInterest, excessFees - keptFees)
    .map((row) => (bearing > 0 ? row : { ...row, carriedPrincipalDue: row.principalDue }))
  const terms: RepaymentTerms = target.holiday > 0
    ? { frequency, structure, instalments: target.instalments + target.holiday, graceKind: "FULL", graceInstalments: target.holiday }
    : { frequency, structure, instalments: target.instalments, graceKind: "NONE", graceInstalments: 0 }
  return finished(input, {
    keep, trim, remove, fresh, terms, interestRatePm: target.rate, balance, carriedInterest, carriedFees,
    scheduleInterest: sumOf(generated, (row) => row.interestDue), deferredInterest,
  })
}
