/**
 * The IFRS 9 sources: what the ledger should hold for each loan's expected
 * credit loss allowance and interest in suspense, as at the latest MONTHLY run
 * of lib/ifrs9 on or before the period (the run is the evidence; nothing here
 * recomputes a figure).
 *
 *   provision   Dr ECL_EXPENSE / Cr ECL_ALLOWANCE for the loan's ECL. Nil once the loan is written
 *               off (the write-off takes the receivable) or has left the book (settled).
 *   suspense    Dr INTEREST_INCOME (and DEFAULT_INTEREST_INCOME) / Cr INTEREST_SUSPENSE for the
 *               interest raised and uncollected while the loan is non-performing. The loan book is
 *               untouched: the borrower owes the same. As it is collected, or the loan cures, the
 *               figure falls and the next run's delta puts it back into income. On write-off the
 *               suspended interest is not a loss: it reduces BAD_DEBT_EXPENSE instead.
 *
 * Both are cumulative vectors, so derive.ts posts the movement each month and
 * a correction after the fact is next month's adjustment, as for every source.
 */
import { addTo, before, type DesiredSource, type Vector } from "./source-types"

export interface Ifrs9Position {
  loanId: string
  reference: string
  /** The run date, SAST midnight: where the first posting is dated. */
  runDate: Date
  eclCents: number
  suspendedInterestCents: number
  suspendedDefaultInterestCents: number
  /** Whether interest suspension is journalled for this contract (consumer loans; asset finance is left in income). */
  journalsSuspense: boolean
  /** The loan was written off before the period ended. */
  writtenOff: boolean
  /** The loan left the book before the period ended without a write-off (settled, cancelled). */
  closed: boolean
}

export function ifrs9Sources(positions: readonly Ifrs9Position[], asOf: Date): DesiredSource[] {
  return positions.flatMap((p) => {
    const provision: Vector = {}
    if (!p.writtenOff && !p.closed && before(p.runDate, asOf)) {
      addTo(provision, "ECL_EXPENSE", p.eclCents)
      addTo(provision, "ECL_ALLOWANCE", -p.eclCents)
    }
    const suspense: Vector = {}
    if (p.journalsSuspense && !p.closed && before(p.runDate, asOf)) {
      const total = p.suspendedInterestCents + p.suspendedDefaultInterestCents
      addTo(suspense, "INTEREST_INCOME", p.suspendedInterestCents)
      addTo(suspense, "DEFAULT_INTEREST_INCOME", p.suspendedDefaultInterestCents)
      addTo(suspense, p.writtenOff ? "BAD_DEBT_EXPENSE" : "INTEREST_SUSPENSE", -total)
    }
    return [
      {
        baseKey: `ifrs9:ecl:${p.loanId}`, loanId: p.loanId, reference: p.reference, vector: provision,
        origin: { type: "ECL_PROVISION", date: p.runDate, description: `Expected credit loss provision on ${p.reference}` },
        change: { type: "ECL_PROVISION", date: null, description: `Expected credit loss provision on ${p.reference} re-stated` },
      },
      {
        baseKey: `ifrs9:suspense:${p.loanId}`, loanId: p.loanId, reference: p.reference, vector: suspense,
        origin: { type: "INTEREST_SUSPENSE", date: p.runDate, description: `Interest on ${p.reference} held in suspense` },
        change: { type: "INTEREST_SUSPENSE", date: null, description: `Interest in suspense on ${p.reference} re-stated` },
      },
    ]
  })
}
