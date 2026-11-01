/**
 * Rescheduling: the one change that moves arrears. Rows already due and unpaid are replaced, at the amount owed: their principal,
 * interest and fees spread evenly over the rows that follow, and marked, for that principal bears no interest from here on. The rows
 * not yet due keep their amounts and move to the new dates; if none is left, the arrears make one row. Only future time is charged:
 * the days the next instalment moves by, as simple interest on what bears it, carried with the rest. The first date moves later only.
 */
import { addPeriods } from "@/lib/product-engine/periods"
import { PERIOD_DAYS, type RepaymentTerms } from "@/lib/product-engine/types"
import type { InPlaceChange } from "./types"
import { byDue, finished, LoanChangeRefused, sastDay, spreadCarried, sumOf, type FreshRow, type InPlacePlan, type PlanInput, type PlanRow, type TrimmedRow } from "./plan"

/** A row cut to what paid it. Due: the receipts filled interest, then fees, then principal. Ahead: principal first, nothing in it being earned. */
function paidPart(row: PlanRow, due: boolean): TrimmedRow {
  const paid = row.totalPaid
  const interestDue = due ? Math.min(row.interestDue, paid) : Math.min(row.interestDue, Math.max(0, paid - row.principalDue))
  const feesDue = due ? Math.min(row.feesDue, paid - interestDue) : paid - Math.min(row.principalDue, paid) - interestDue
  return { id: row.id, principalDue: paid - interestDue - feesDue, interestDue, feesDue, totalDue: paid, totalPaid: paid }
}

export function planReschedule(input: PlanInput, change: Extract<InPlaceChange, { type: "RESCHEDULE" }>): InPlacePlan {
  const { loan, frequency, structure, asOf } = input
  const rows = [...input.rows].sort(byDue)
  const today = sastDay(asOf)
  const settled = (row: PlanRow) => row.totalPaid >= row.totalDue
  const isDue = (row: PlanRow) => sastDay(row.dueDate) <= today
  const keep = rows.filter(settled)
  const open = rows.filter((row) => !settled(row))
  if (open.length === 0) throw new LoanChangeRefused("No principal is left unpaid on this loan to change")
  const parts = new Map(open.filter((row) => row.totalPaid > 0).map((row) => [row.id, paidPart(row, isDue(row))]))
  const left = (row: PlanRow) => {
    const paid = parts.get(row.id)
    return { principalDue: row.principalDue - (paid?.principalDue ?? 0), interestDue: row.interestDue - (paid?.interestDue ?? 0), feesDue: row.feesDue - (paid?.feesDue ?? 0) }
  }
  const arrears = open.filter(isDue).map(left)
  const tail = open.filter((row) => !isDue(row))

  // With no row ahead, the next instalment is the first period end still to come. Nothing is charged for the time since the last.
  const lastDue = rows.reduce((latest, row) => (row.dueDate > latest ? row.dueDate : latest), loan.startDate)
  let k = 1
  while (sastDay(addPeriods(lastDue, frequency, k)) <= today) k += 1
  const next = tail[0]?.dueDate ?? addPeriods(lastDue, frequency, k)
  const first = new Date(`${change.firstDueDate}T10:00:00.000Z`)
  const gapDays = sastDay(first) - sastDay(next)
  if (gapDays < 0) throw new LoanChangeRefused("A rescheduled loan's first instalment must fall on or after its next instalment")

  const balance = loan.principal - sumOf(keep, (row) => row.principalDue) - [...parts.values()].reduce((sum, row) => sum + row.principalDue, 0)
  const moved = sumOf(arrears, (row) => row.principalDue) + sumOf(tail, (row) => Math.min(row.carriedPrincipalDue ?? 0, left(row).principalDue))
  const gapInterest = Math.round(((loan.interestModel === "FLAT" ? loan.principal : balance - moved) * loan.interestRatePm * gapDays) / 30)
  const dueInterest = sumOf(arrears, (row) => row.interestDue)
  const dueFees = sumOf(arrears, (row) => row.feesDue)

  const count = Math.max(tail.length, 1)
  const nextNo = Math.max(0, ...keep.map((row) => row.installmentNo), ...open.filter((row) => parts.has(row.id)).map((row) => row.installmentNo)) + 1
  const rowsAhead = Array.from({ length: count }, (_, i) => {
    const row = tail[i]
    const own = row ? left(row) : { principalDue: 0, interestDue: 0, feesDue: 0 }
    return {
      installmentNo: nextNo + i, dueDate: addPeriods(first, frequency, i), principalDue: own.principalDue, interestDue: own.interestDue, feesDue: own.feesDue,
      totalDue: own.principalDue + own.interestDue + own.feesDue,
      earlierPrincipal: Math.min(row?.carriedPrincipalDue ?? 0, own.principalDue), earlierInterest: row?.carriedInterestDue ?? 0, earlierFees: row?.carriedFeesDue ?? 0,
    }
  })
  const fresh: FreshRow[] = spreadCarried(rowsAhead, dueInterest + gapInterest, dueFees, sumOf(arrears, (row) => row.principalDue)).map(({ earlierPrincipal, earlierInterest, earlierFees, ...row }) => ({
    ...row, carriedPrincipalDue: row.carriedPrincipalDue + earlierPrincipal, carriedInterestDue: row.carriedInterestDue + earlierInterest, carriedFeesDue: row.carriedFeesDue + earlierFees,
  }))
  const terms: RepaymentTerms = { frequency, structure, instalments: structure === "BULLET" ? Math.max(1, Math.round((sastDay(first) - sastDay(loan.startDate)) / PERIOD_DAYS[frequency])) : count, graceKind: "NONE", graceInstalments: 0 }
  return finished(input, {
    keep, trim: [...parts.values()], remove: open.filter((row) => !parts.has(row.id)).map((row) => row.id), fresh, terms, interestRatePm: loan.interestRatePm, balance,
    carriedInterest: dueInterest + gapInterest, carriedFees: dueFees, scheduleInterest: sumOf(rowsAhead, (row) => row.interestDue), deferredInterest: 0,
  })
}
