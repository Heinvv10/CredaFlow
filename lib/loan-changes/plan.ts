/**
 * What a loan change does to the money: pure, integer cents, no database. Schedules come from the product engine
 * (lib/product-engine/schedule.ts), so a change's rows follow the same rules as a new loan's; this module decides the balance
 * they are generated on, and what is kept and carried. Rules: lib/loan-changes/.claude.md.
 *
 * Fully paid rows stay as they are. A part-paid row is cut down to what the receipts paid, and the rest of the schedule goes.
 * What it held comes back as:
 *   principal                       the balance the new rows repay, so the rows add up to Loan.principal to the cent;
 *   interest and fees already due   carried, spread evenly over the new rows, never added to the balance: no interest on interest;
 *   what an earlier change carried  carried again, wherever it sits (RepaymentSchedule.carried*): it was earned, whatever the date;
 *   interest not yet due            gone: the new rows charge the balance from the last instalment date, the period running
 *                                   now included, on the new terms.
 * A moved first instalment or a payment holiday adds the time it skips as simple interest, carried like the rest.
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
  /** What an earlier change carried onto this row. */
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
 * row not yet due they are a prepayment: its interest is not earned and the new rows charge that period again, so the money
 * goes to principal first and lowers the balance they charge it on.
 */
function trimmed(row: PlanRow, due: boolean): TrimmedRow {
  const paid = row.totalPaid
  if (due) {
    const interestDue = Math.min(row.interestDue, paid)
    const feesDue = Math.min(row.feesDue, paid - interestDue)
    return { id: row.id, principalDue: paid - interestDue - feesDue, interestDue, feesDue, totalDue: paid, totalPaid: paid }
  }
  const principalDue = Math.min(row.principalDue, paid)
  const interestDue = Math.min(row.interestDue, paid - principalDue)
  return { id: row.id, principalDue, interestDue, feesDue: paid - principalDue - interestDue, totalDue: paid, totalPaid: paid }
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

export function planInPlace(input: PlanInput): InPlacePlan {
  const { loan, frequency, structure, change, asOf } = input
  const rows = [...input.rows].sort(byDue)
  const today = sastDay(asOf)
  const settled = (row: PlanRow) => row.totalPaid >= row.totalDue
  const keep = rows.filter(settled)
  const open = rows.filter((row) => !settled(row))
  const isDue = (row: PlanRow) => sastDay(row.dueDate) <= today
  const trim = open.filter((row) => row.totalPaid > 0).map((row) => trimmed(row, isDue(row)))
  const remove = open.filter((row) => row.totalPaid === 0).map((row) => row.id)

  const kept = [...keep.map((row) => row.principalDue), ...trim.map((row) => row.principalDue)]
  const balance = loan.principal - kept.reduce((sum, cents) => sum + cents, 0)
  if (open.length === 0 || balance <= 0) throw new LoanChangeRefused("No principal is left unpaid on this loan to change")

  // Interest and fees of rows due today or earlier are owed whatever the new terms say, and what an earlier change carried is too.
  let carriedInterest = 0
  let carriedFees = 0
  open.forEach((row) => {
    const paid = trimmed(row, isDue(row))
    carriedInterest += isDue(row) ? row.interestDue - paid.interestDue : Math.max(0, (row.carriedInterestDue ?? 0) - paid.interestDue)
    carriedFees += isDue(row) ? row.feesDue - paid.feesDue : Math.max(0, (row.carriedFeesDue ?? 0) - paid.feesDue)
  })

  // The new rows count from the last date that has passed or been paid, so the first falls where the next instalment would.
  const anchor = rows.reduce((latest, row) => (settled(row) || isDue(row)) && row.dueDate > latest ? row.dueDate : latest, loan.startDate)
  const lastDue = rows.at(-1)!.dueDate
  const remaining = structure === "BULLET"
    ? Math.max(1, Math.round((sastDay(lastDue) - sastDay(anchor)) / PERIOD_DAYS[frequency]))
    : open.length
  const target = targetOf(change, loan.interestRatePm, remaining)
  if (target.holiday > 0 && structure === "BULLET") throw new LoanChangeRefused("A single-payment loan has no instalments to take a holiday from: reschedule it")

  const schedule: RepaymentTerms = { frequency, structure, instalments: target.instalments, graceKind: "NONE", graceInstalments: 0 }
  // What the terms row records: a holiday's periods are part of the term, as a full grace's are.
  const terms: RepaymentTerms = target.holiday > 0
    ? { ...schedule, instalments: target.instalments + target.holiday, graceKind: "FULL", graceInstalments: target.holiday }
    : schedule
  let deferredInterest = 0
  if (target.holiday > 0) {
    // Simple interest on the balance for the skipped periods, and the service fee of the months they span, as a full grace defers them.
    const periodRate = frequency === "MONTHLY" ? target.rate : (target.rate * 12) / PERIODS_PER_YEAR[frequency]
    deferredInterest = Math.round(balance * periodRate) * target.holiday
    carriedInterest += deferredInterest
    carriedFees += Math.round((target.holiday * PERIOD_DAYS[frequency]) / 30) * loan.monthlyServiceFee
  }
  if (target.firstDueDate) {
    const next = addPeriods(anchor, frequency, 1)
    const gapDays = sastDay(target.firstDueDate) - sastDay(next)
    if (gapDays < 0 || sastDay(target.firstDueDate) <= today) throw new LoanChangeRefused("A rescheduled loan's first instalment must fall after today and on or after its next instalment")
    // The extra days earn simple interest on the balance, carried with the rest.
    carriedInterest += Math.round((balance * target.rate * gapDays) / 30)
  }

  const startDate = target.holiday > 0 ? addPeriods(anchor, frequency, target.holiday) : anchor
  const generated = generateSchedule({ principalCents: balance, interestRatePm: target.rate, interestModel: loan.interestModel, monthlyServiceFeeCents: loan.monthlyServiceFee, startDate, terms: schedule })
  const nextNo = rows.reduce((max, row) => Math.max(max, settled(row) || row.totalPaid > 0 ? row.installmentNo : 0), 0) + 1
  const generatedRows = generated.schedule.map((row, i) => ({
    installmentNo: nextNo + i, dueDate: target.firstDueDate ? addPeriods(target.firstDueDate, frequency, i) : row.dueDate, principalDue: row.principalDue, interestDue: row.interestDue, feesDue: row.feesDue, totalDue: row.totalDue,
  }))
  const fresh = spreadCarried(generatedRows, carriedInterest, carriedFees)

  const byId = new Map(rows.map((row) => [row.id, row]))
  const after = [
    ...keep.map(({ installmentNo, dueDate, principalDue, interestDue, feesDue, totalDue, totalPaid }) => ({ installmentNo, dueDate, principalDue, interestDue, feesDue, totalDue, totalPaid, carriedInterestDue: 0, carriedFeesDue: 0 })),
    ...trim.map((row) => ({ ...row, installmentNo: byId.get(row.id)!.installmentNo, dueDate: byId.get(row.id)!.dueDate, carriedInterestDue: 0, carriedFeesDue: 0 })),
  ].sort((a, b) => a.installmentNo - b.installmentNo)
  const all = [...after, ...fresh.map((row) => ({ ...row, totalPaid: 0 }))]
  const balances = recomputeLoanBalances(loan.principal, all, asOf)
  return {
    keep, trim, remove, fresh, rows: all, terms, interestRatePm: target.rate, balance, carriedInterest, carriedFees,
    scheduleInterest: generated.totalInterest, deferredInterest,
    totalInterest: all.reduce((sum, row) => sum + row.interestDue, 0),
    totalRepayable: all.reduce((sum, row) => sum + row.totalDue, 0),
    maturityDate: fresh.at(-1)!.dueDate,
    nextPaymentDate: fresh[0]!.dueDate,
    outstandingPrincipal: balances.outstandingPrincipal,
    arrearsAmount: balances.arrearsAmount,
    daysInArrears: balances.daysInArrears,
  }
}

export interface NewLoanInput {
  settledCents: number
  newMoneyCents: number
  interestRatePm: number
  interestModel: EngineInterestModel
  monthlyServiceFee: number
  frequency: Frequency
  instalments: number
  asOf: Date
}

export interface NewLoanPlan {
  principal: number
  rows: FreshRow[]
  terms: RepaymentTerms
  totalInterest: number
  totalRepayable: number
  maturityDate: Date
}

/** The loan a top-up, refinance or consolidation books: its principal is what settles the old loan(s) plus the new money, from today. */
export function planNewLoan(input: NewLoanInput): NewLoanPlan {
  const principal = input.settledCents + input.newMoneyCents
  const terms: RepaymentTerms = { frequency: input.frequency, structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, instalments: input.instalments }
  const generated = generateSchedule({ principalCents: principal, interestRatePm: input.interestRatePm, interestModel: input.interestModel, monthlyServiceFeeCents: input.monthlyServiceFee, startDate: input.asOf, terms })
  const rows = generated.schedule.map((row) => ({ installmentNo: row.installmentNo, dueDate: row.dueDate, principalDue: row.principalDue, interestDue: row.interestDue, feesDue: row.feesDue, totalDue: row.totalDue, carriedInterestDue: 0, carriedFeesDue: 0 }))
  return {
    principal, rows, terms, totalInterest: generated.totalInterest,
    totalRepayable: rows.reduce((sum, row) => sum + row.totalDue, 0), maturityDate: rows.at(-1)!.dueDate,
  }
}
