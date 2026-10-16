/**
 * What each money source SHOULD have posted to the ledger as at an instant.
 *
 * Every source (a loan's disbursement, each payout attempt, each instalment,
 * each default charge, each receipt group, the write-off) yields a desired
 * cumulative vector of signed cents per account role that sums to zero. The
 * export posts the difference between that and what earlier batches posted
 * (lib/accounting/derive.ts), so a source that changes after its month closed
 * is corrected in the next open month, never by editing a closed one.
 *
 * The loan book is one receivable for everything a borrower owes. Income is
 * recognised when it falls due; a receipt credits the loan book as a whole
 * (the system stores no principal/interest split per receipt, so none is
 * invented here).
 *
 * Payout channel (the loan has payout attempts): the disbursement credits
 * PAYOUT_CLEARING, and only a PAID attempt moves it to BANK; a RETURNED one
 * moves it back; FAILED or never sent posts nothing. Without attempts (the
 * channel was off) the disbursement credits BANK, as before. An approved
 * disbursement reversal takes every non-receipt source of the loan to zero.
 * Money a provider paid out after the reversal (a recovery case) debits
 * PAYOUT_CLEARING against BANK from the day it left until it is recovered;
 * closed as unrecoverable, it moves from clearing to BAD_DEBT_EXPENSE that day.
 *
 * Credit-life premiums are payable to the insurer as they fall due; on
 * write-off the part not collected is reversed out of the payable (binder
 * assumption, lib/accounting/.claude.md).
 */
import { allocateReceipts } from "@/lib/loan/balances"
import { addTo, before, type DesiredSource, type SourceLoan, type Vector } from "./source-types"
import { assetFinanceSources } from "./sources-asset-finance"
import { receiptSources } from "./sources-receipts"
import { adjustment, chargeSources, raisedOn, receivableOf, writtenOffAt } from "./sources-shared"

export type { DesiredSource, EventType, SourceLoan, Vector } from "./source-types"

/**
 * Premium raised but not collected as at `asOf`. The receipts on the schedule
 * then (live, applied, less what paid default charges) are spread over the
 * instalments earliest first, as lib/reports/book-as-of.ts rebuilds a past
 * book (lib/loan/balances.ts allocateReceipts); within an instalment the paid
 * order is interest, then fees, then principal (lib/loan/receipt-allocation.ts),
 * and the premium is taken to be collected pro rata within the fees, because
 * the system does not record which part of an instalment's fees a receipt
 * paid. Assumption documented in lib/accounting/.claude.md.
 */
function uncollectedPremium(loan: SourceLoan, asOf: Date): number {
  const share = loan.payments
    .filter((p) => before(p.receivedAt, asOf) && !(p.reversed && before(p.reversedAt, asOf))
      && p.allocationStatus === "ALLOCATED" && !(p.reconciledAt && !before(p.reconciledAt, asOf)))
    .reduce((sum, p) => sum + p.amount - p.defaultInterestAllocated - p.chargeFeesAllocated, 0)
  const rows = [...loan.schedule].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
  const paid = allocateReceipts(rows, share)
  let total = 0
  rows.forEach((row, i) => {
    if (row.creditLifePremiumDue <= 0 || !raisedOn(loan, row.dueDate, asOf)) return
    const feesPaid = Math.min(Math.max(paid[i] - row.interestDue, 0), row.feesDue)
    total += Math.round(row.creditLifePremiumDue * (1 - (row.feesDue > 0 ? feesPaid / row.feesDue : 1)))
  })
  return total
}

/** Every source of one loan, desired as at `asOf` (exclusive), write-off excluded. */
function ordinarySources(loan: SourceLoan, asOf: Date): DesiredSource[] {
  if (loan.assetFinance) return assetFinanceSources(loan, asOf)
  const out: DesiredSource[] = []
  const reversedAt = before(loan.reversedAt, asOf) ? loan.reversedAt : null
  const live = !reversedAt
  const viaChannel = loan.payouts.length > 0
  const disbursement: Vector = {}
  if (live && before(loan.startDate, asOf)) {
    const fee = loan.upfrontFee ? loan.initiationFee : 0
    addTo(disbursement, "LOAN_BOOK", loan.principal)
    addTo(disbursement, viaChannel ? "PAYOUT_CLEARING" : "BANK", -(loan.principal - fee))
    addTo(disbursement, "FEE_INCOME", -fee)
  }
  out.push({
    baseKey: `loan:${loan.id}:disbursement`, loanId: loan.id, reference: loan.reference, vector: disbursement,
    origin: { type: "DISBURSEMENT", date: loan.startDate, description: viaChannel ? `Loan ${loan.reference} booked; payout to follow` : `Loan ${loan.reference} paid out` },
    change: adjustment(loan, "Disbursement", reversedAt),
  })
  for (const p of loan.payouts) {
    const vector: Vector = {}
    if (before(p.paidAt, asOf) && !before(p.returnedAt, asOf)) {
      addTo(vector, "PAYOUT_CLEARING", p.amountCents)
      addTo(vector, "BANK", -p.amountCents)
    }
    out.push({
      baseKey: `payout:${p.id}`, loanId: loan.id, reference: loan.reference, vector,
      origin: { type: "PAYOUT_PAID", date: p.paidAt ?? loan.startDate, description: `Payout ${p.attempt} of ${loan.reference} paid` },
      change: { type: "PAYOUT_RETURNED", date: p.returnedAt, description: `Payout ${p.attempt} of ${loan.reference} returned by the bank` },
    })
  }
  for (const r of loan.recoveries) {
    const vector: Vector = {}
    if (before(r.paidAt, asOf) && !before(r.recoveredAt, asOf)) {
      addTo(vector, "PAYOUT_CLEARING", r.amountCents)
      addTo(vector, "BANK", -r.amountCents)
    }
    out.push({
      baseKey: `recovery:${r.id}`, loanId: loan.id, reference: loan.reference, vector,
      origin: { type: "PAYOUT_PAID", date: r.paidAt, description: `Payout ${r.attempt} of ${loan.reference} paid out after its disbursement was reversed; to be recovered` },
      change: { type: "PAYOUT_RECOVERED", date: r.recoveredAt, description: `Payout ${r.attempt} of ${loan.reference} recovered` },
    })
    const lost: Vector = {}
    if (before(r.unrecoverableAt, asOf)) {
      addTo(lost, "BAD_DEBT_EXPENSE", r.amountCents)
      addTo(lost, "PAYOUT_CLEARING", -r.amountCents)
    }
    out.push({
      baseKey: `recovery:${r.id}:unrecoverable`, loanId: loan.id, reference: loan.reference, vector: lost,
      origin: { type: "WRITE_OFF", date: r.unrecoverableAt ?? r.paidAt, description: `Payout ${r.attempt} of ${loan.reference}, paid out after its disbursement was reversed, written off as unrecoverable` },
      change: { type: "ADJUSTMENT", date: null, description: `Unrecoverable payout ${r.attempt} of ${loan.reference} re-stated` },
    })
  }
  for (const row of loan.schedule) {
    const on = live ? raisedOn(loan, row.dueDate, asOf) : null
    const vector: Vector = {}
    if (on) {
      addTo(vector, "LOAN_BOOK", row.interestDue + row.feesDue)
      addTo(vector, "INTEREST_INCOME", -row.interestDue)
      addTo(vector, "FEE_INCOME", -(row.feesDue - row.creditLifePremiumDue))
      addTo(vector, "CREDIT_LIFE_PAYABLE", -row.creditLifePremiumDue)
    }
    out.push({
      baseKey: `loan:${loan.id}:instalment:${row.id}`, loanId: loan.id, reference: loan.reference, vector,
      origin: { type: "INSTALMENT_DUE", date: on ?? row.dueDate, description: `Instalment ${row.installmentNo} interest, fees and premium due on ${loan.reference}` },
      change: adjustment(loan, `Instalment ${row.installmentNo}`, reversedAt),
    })
  }
  out.push(...chargeSources(loan, asOf, live, reversedAt))
  out.push(...receiptSources(loan, asOf, writtenOffAt(loan, asOf)))
  return out
}

/**
 * All of a loan's sources as at `asOf`. A written-off loan's write-off takes
 * whatever its other sources leave on the loan book (so the book holds nothing
 * for it once written off, and a later change moves the write-off with it):
 * premium raised but never collected leaves the insurer payable, the rest is
 * a bad debt.
 */
export function loanSources(loan: SourceLoan, asOf: Date): DesiredSource[] {
  const sources = ordinarySources(loan, asOf)
  const writeOff = writtenOffAt(loan, asOf)
  const vector: Vector = {}
  if (writeOff) {
    const receivable = receivableOf(loan)
    const book = sources.reduce((sum, s) => sum + (s.vector[receivable] ?? 0), 0)
    if (book > 0) {
      const premium = Math.min(book, loan.assetFinance ? 0 : uncollectedPremium(loan, asOf))
      addTo(vector, "CREDIT_LIFE_PAYABLE", premium)
      addTo(vector, "BAD_DEBT_EXPENSE", book - premium)
      addTo(vector, receivable, -book)
    }
  }
  sources.push({
    baseKey: `loan:${loan.id}:write-off`, loanId: loan.id, reference: loan.reference, vector,
    origin: { type: "WRITE_OFF", date: loan.writeOffAt ?? loan.startDate, description: `Loan ${loan.reference} written off` },
    change: adjustment(loan, "Write-off", null),
  })
  return sources
}
