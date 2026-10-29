/**
 * The IFRS 9 sources: what the ledger should hold for each loan's expected
 * credit loss allowance and interest in suspense, as at the latest MONTHLY run
 * of lib/ifrs9 for a month up to the period (the run is the evidence; nothing
 * here recomputes a figure). A run is dated its month's last day however late
 * it was made, so a make-up or superseding run posts in its own month.
 *
 *   provision   Dr ECL_EXPENSE / Cr ECL_ALLOWANCE for the loan's ECL. Nil once the loan has left the
 *               book without a write-off (settled). On write-off the allowance is used, not released:
 *               it is debited and BAD_DEBT_EXPENSE credited by the same amount (the write-off source
 *               debits BAD_DEBT_EXPENSE for the whole book), and ECL_EXPENSE stays as charged.
 *   suspense    Dr INTEREST_INCOME (and DEFAULT_INTEREST_INCOME) / Cr INTEREST_SUSPENSE for the
 *               interest raised and uncollected while the loan is Stage 3 (full-suspension basis only).
 *               The loan book is untouched: the borrower owes the same. As it
 *               is collected, or the loan cures, the figure falls and the next run's delta puts it back
 *               into income. On write-off the suspended interest is not a loss: it reduces
 *               BAD_DEBT_EXPENSE instead.
 *   net basis   (IFRS 9 5.4.1(b), when the lender chose it) Dr INTEREST_INCOME (and DEFAULT_INTEREST_INCOME) /
 *               Cr ECL_EXPENSE for the cumulative sum of each Stage 3 month's interest times ECL / gross exposure.
 *               The allowance stays the ECL on the gross exposure, there is no suspense, and nothing is given back
 *               on cure or write-off: the adjustment is prospective (5.4.2) and only moves income between lines.
 *
 * All are cumulative vectors, so derive.ts posts the movement each month and
 * a correction after the fact is next month's adjustment, as for every source.
 */
import { sastDayStart } from "@/lib/date/sast-period"
import { parsePeriodKey, type AccountingPeriod } from "./period"
import { addTo, type DesiredSource, type Vector } from "./source-types"

export interface Ifrs9Position {
  loanId: string
  reference: string
  /** The month ("yyyy-mm") of the run these figures come from. */
  periodKey: string
  eclCents: number
  suspendedInterestCents: number
  suspendedDefaultInterestCents: number
  /** Net basis, summed over the current monthly runs up to the period: interest income taken out against the ECL expense. */
  netInterestAdjustmentCents: number
  netDefaultInterestAdjustmentCents: number
  /** Whether interest suspension is journalled for this contract (consumer loans; asset finance is left in income). */
  journalsSuspense: boolean
  /** The loan was written off before the period ended. */
  writtenOff: boolean
  /** The loan left the book before the period ended without a write-off (settled, cancelled). */
  closed: boolean
}

function provisionOf(p: Ifrs9Position, posted: boolean): Vector {
  const vector: Vector = {}
  if (!posted || p.closed) return vector
  addTo(vector, "ECL_EXPENSE", p.eclCents)
  if (p.writtenOff) addTo(vector, "BAD_DEBT_EXPENSE", -p.eclCents)
  else addTo(vector, "ECL_ALLOWANCE", -p.eclCents)
  return vector
}

function suspenseOf(p: Ifrs9Position, posted: boolean): Vector {
  const vector: Vector = {}
  if (!posted || !p.journalsSuspense || p.closed) return vector
  const total = p.suspendedInterestCents + p.suspendedDefaultInterestCents
  addTo(vector, "INTEREST_INCOME", p.suspendedInterestCents)
  addTo(vector, "DEFAULT_INTEREST_INCOME", p.suspendedDefaultInterestCents)
  addTo(vector, p.writtenOff ? "BAD_DEBT_EXPENSE" : "INTEREST_SUSPENSE", -total)
  return vector
}

function netBasisOf(p: Ifrs9Position): Vector {
  const vector: Vector = {}
  addTo(vector, "INTEREST_INCOME", p.netInterestAdjustmentCents)
  addTo(vector, "DEFAULT_INTEREST_INCOME", p.netDefaultInterestAdjustmentCents)
  addTo(vector, "ECL_EXPENSE", -(p.netInterestAdjustmentCents + p.netDefaultInterestAdjustmentCents))
  return vector
}

export function ifrs9Sources(positions: readonly Ifrs9Position[], period: AccountingPeriod): DesiredSource[] {
  return positions.flatMap((p) => {
    const posted = p.periodKey <= period.key
    const runPeriod = parsePeriodKey(p.periodKey)
    const date = sastDayStart(runPeriod?.lastDay ?? period.lastDay)
    return [
      {
        baseKey: `ifrs9:ecl:${p.loanId}`, loanId: p.loanId, reference: p.reference, vector: provisionOf(p, posted),
        origin: { type: "ECL_PROVISION", date, description: `Expected credit loss provision on ${p.reference}` },
        change: { type: "ECL_PROVISION", date: null, description: `Expected credit loss provision on ${p.reference} re-stated` },
      },
      {
        baseKey: `ifrs9:suspense:${p.loanId}`, loanId: p.loanId, reference: p.reference, vector: suspenseOf(p, posted),
        origin: { type: "INTEREST_SUSPENSE", date, description: `Interest on ${p.reference} held in suspense` },
        change: { type: "INTEREST_SUSPENSE", date: null, description: `Interest in suspense on ${p.reference} re-stated` },
      },
      {
        baseKey: `ifrs9:netint:${p.loanId}`, loanId: p.loanId, reference: p.reference, vector: netBasisOf(p),
        origin: { type: "ECL_PROVISION", date, description: `Interest on ${p.reference} taken off against the credit loss expense (net basis)` },
        change: { type: "ECL_PROVISION", date: null, description: `Net-basis interest adjustment on ${p.reference} re-stated` },
      },
    ]
  })
}
