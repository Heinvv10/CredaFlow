/**
 * Dealer commission as journal sources (slice 5 part A,
 * docs/asset-finance/SLICE5.md "Commission, runs and journals"). Dispatched
 * from assetFinanceSources; the lines are written by the database alone
 * (accrueDealerCommission on BOOKED, clawbackDealerCommission on the loan's
 * exit) and loaded in lib/accounting/store-asset-finance.ts.
 *
 * Per line, signed as stored (a REVERSED line carries its EARNED line's exact
 * negatives, so the same rule reverses expense, VAT and payable):
 *   af:<loan>:dealer-commission:<lineId>       on effectiveOn (SAST midnight):
 *       Dr DEALER_COMMISSION_EXPENSE net; Dr INPUT_VAT vat; Cr DEALER_COMMISSION_PAYABLE gross
 *   af:<loan>:dealer-commission-paid:<lineId>  on the releasedAt of the run that holds it:
 *       Dr DEALER_COMMISSION_PAYABLE gross; Cr BANK gross
 * A clawback not yet netted in a released run leaves a debit on the payable:
 * the dealer owes it back. lib/accounting/reconcile-controls.ts ties the
 * payable per contract to the lines and runs in SQL.
 *
 * // UNTESTED: tax — commission VAT by the dealer's VAT vendor status (input VAT only when the line says the dealer
 * // was a vendor): whether commission for arranging credit is a taxable supply, how much input VAT a lender making
 * // exempt supplies may claim (apportionment), and the input VAT reversed on a clawback. Tax reviewer confirms.
 */
import { addTo, before, type DesiredSource, type SourceDealerCommission, type SourceLoan, type Vector } from "./source-types"
import { adjustment } from "./sources-shared"

function earnedSource(loan: SourceLoan, line: SourceDealerCommission, asOf: Date): DesiredSource {
  const vector: Vector = {}
  if (before(line.effectiveOn, asOf)) {
    addTo(vector, "DEALER_COMMISSION_EXPENSE", line.netCents)
    addTo(vector, "INPUT_VAT", line.vatCents)
    addTo(vector, "DEALER_COMMISSION_PAYABLE", -line.grossCents)
  }
  const what = line.kind === "EARNED" ? "earned" : "clawed back"
  return {
    baseKey: `af:${loan.id}:dealer-commission:${line.id}`, loanId: loan.id, reference: loan.reference, vector,
    origin: { type: "DEALER_COMMISSION", date: line.effectiveOn, description: `Dealer commission ${what} on ${loan.reference}` },
    change: adjustment(loan, "Dealer commission", null),
  }
}

function paidSource(loan: SourceLoan, line: SourceDealerCommission, asOf: Date): DesiredSource {
  const vector: Vector = {}
  if (before(line.releasedAt, asOf)) {
    addTo(vector, "DEALER_COMMISSION_PAYABLE", line.grossCents)
    addTo(vector, "BANK", -line.grossCents)
  }
  const what = line.kind === "EARNED" ? "paid to the dealer" : "clawback netted in a dealer payment run"
  return {
    baseKey: `af:${loan.id}:dealer-commission-paid:${line.id}`, loanId: loan.id, reference: loan.reference, vector,
    origin: { type: "DEALER_COMMISSION_PAID", date: line.releasedAt ?? line.effectiveOn, description: `Dealer commission ${what} on ${loan.reference}` },
    change: adjustment(loan, "Dealer commission payment", null),
  }
}

/** Two sources per commission line of the contract: the line itself and its payment. */
export function dealerCommissionSources(loan: SourceLoan, asOf: Date): DesiredSource[] {
  return (loan.assetFinance?.dealerCommission ?? []).flatMap((line) => [earnedSource(loan, line, asOf), paidSource(loan, line, asOf)])
}
