/**
 * A repossession and its sale as journal sources (slice 4b). Every base key
 * starts `af-recovery:<recoveryId>:` so the reconciliation can attribute a line
 * to its recovery (lib/accounting/reconcile-asset-finance.ts); the proceeds
 * receipt is the generic `payment:<id>` source with `recoveryProceeds` set.
 *
 * RECOVERY_CLEARING holds a recovery's cash and costs until the proceeds are
 * applied (or the recovery is withdrawn), and then nothing:
 *   cost        deducted: Dr CLEARING net; charged: Dr RECOVERY_COST_EXPENSE net;
 *               both: Dr INPUT_VAT; Cr RECOVERY_COSTS_PAYABLE gross (paid through AP)
 *   vat         repossession deemed supply: Dr INPUT_VAT claim; Cr CLEARING
 *   sale        Dr BANK price; Cr OUTPUT_VAT; Cr CLEARING price excl. VAT
 *   sale credit a credit note on the buyer's invoice: Dr OUTPUT_VAT; Dr CLEARING excl. VAT;
 *               Cr BANK incl. VAT, on its issue date (the buyer is refunded in cash, as it paid)
 *   proceeds    (generic receipt) Dr CLEARING; Cr the receivable
 *   surplus     Dr CLEARING; Cr RECOVERY_REFUND_PAYABLE
 *   refund      Dr RECOVERY_REFUND_PAYABLE; Cr BANK once released
 *   result      what is left in CLEARING moves to RECOVERY_RESULT
 * A shortfall posts nothing: it stays on the receivable and is written off by
 * the manual write-off. A cost charged to the account is the generic charge
 * source (RECOVERY_COST -> RECOVERY_COSTS_RECHARGED, receivable debited).
 *
 * // UNTESTED: accounting — the result account takes the gap between output VAT and the input VAT claimed; whether it is a P&L item is for the lender's accountant.
 * // UNTESTED: tax — the sale's cash is taken in on the completion day (the buyer's invoice date).
 * // UNTESTED: accounting — a credit note on the buyer's invoice is refunded on its issue date (no buyer-refund record exists), and the
 * // proceeds applied to the debtor are the sale price before it, so the credit lands in the recovery result.
 */
import { addTo, before, type DesiredSource, type SourceLoan, type SourceRecovery, type Vector } from "./source-types"
import { adjustment } from "./sources-shared"

function recoverySource(loan: SourceLoan, key: string, vector: Vector, type: DesiredSource["origin"]["type"], date: Date, description: string, what: string): DesiredSource {
  return { baseKey: key, loanId: loan.id, reference: loan.reference, vector, origin: { type, date, description }, change: adjustment(loan, what, null) }
}

function ownSources(loan: SourceLoan, rec: SourceRecovery, asOf: Date): DesiredSource[] {
  const key = (suffix: string) => `af-recovery:${rec.id}:${suffix}`
  const out: DesiredSource[] = []
  for (const cost of rec.costs) {
    const vector: Vector = {}
    if (before(cost.incurredOn, asOf)) {
      addTo(vector, cost.treatment === "DEDUCT_FROM_PROCEEDS" ? "RECOVERY_CLEARING" : "RECOVERY_COST_EXPENSE", cost.netCents)
      addTo(vector, "INPUT_VAT", cost.vatCents)
      addTo(vector, "RECOVERY_COSTS_PAYABLE", -cost.grossCents)
    }
    out.push(recoverySource(loan, key(`cost:${cost.id}`), vector, "RECOVERY_COST", cost.incurredOn, `Recovery cost on ${loan.reference} (supplier invoice, payable)`, "Recovery cost"))
  }
  for (const event of rec.vatEvents) {
    const vector: Vector = {}
    if (before(event.eventDate, asOf)) {
      addTo(vector, "INPUT_VAT", event.inputTaxClaimCents)
      addTo(vector, "RECOVERY_CLEARING", -event.inputTaxClaimCents)
    }
    out.push(recoverySource(loan, key(`vat:${event.id}`), vector, "RECOVERY_VAT", event.eventDate, `Input tax on the repossession of the asset of ${loan.reference}`, "Repossession VAT"))
  }
  if (rec.sale) {
    const { invoice, priceInclVatCents } = rec.sale
    const vector: Vector = {}
    if (before(invoice.issueDate, asOf)) {
      addTo(vector, "BANK", priceInclVatCents)
      addTo(vector, "OUTPUT_VAT", -invoice.vatCents)
      addTo(vector, "RECOVERY_CLEARING", -invoice.exclVatCents)
    }
    out.push(recoverySource(loan, key(`sale:${rec.sale.id}`), vector, "RECOVERY_SALE", invoice.issueDate, `Repossessed asset of ${loan.reference} sold`, "Remarketing sale"))
    for (const note of rec.sale.creditNotes ?? []) {
      const credit: Vector = {}
      if (before(note.issueDate, asOf)) {
        addTo(credit, "OUTPUT_VAT", note.vatCents)
        addTo(credit, "RECOVERY_CLEARING", note.exclVatCents)
        addTo(credit, "BANK", -note.inclVatCents)
      }
      out.push(recoverySource(loan, key(`sale-credit:${note.id}`), credit, "CREDIT_NOTE", note.issueDate, `Credit note on the sale of the repossessed asset of ${loan.reference}`, "Sale credit note"))
    }
  }
  const surplus: Vector = {}
  if (rec.proceedsDate && before(rec.proceedsDate, asOf)) {
    addTo(surplus, "RECOVERY_CLEARING", rec.surplusCents)
    addTo(surplus, "RECOVERY_REFUND_PAYABLE", -rec.surplusCents)
  }
  out.push(recoverySource(loan, key("surplus"), surplus, "RECOVERY_SURPLUS", rec.proceedsDate ?? loan.startDate, `Surplus from the sale of the asset of ${loan.reference} owed to the debtor`, "Recovery surplus"))
  if (rec.refund) {
    const vector: Vector = {}
    if (before(rec.refund.releasedAt, asOf)) {
      addTo(vector, "RECOVERY_REFUND_PAYABLE", rec.refund.amountCents)
      addTo(vector, "BANK", -rec.refund.amountCents)
    }
    out.push(recoverySource(loan, key("refund"), vector, "RECOVERY_REFUND", rec.refund.releasedAt, `Surplus refunded to the debtor of ${loan.reference}`, "Surplus refund"))
  }
  return out
}

/**
 * The recovery sources of a loan. `siblings` are the loan's other sources so
 * far: the proceeds receipt is one of them, and the result source needs its
 * clearing too.
 */
export function recoverySources(loan: SourceLoan, asOf: Date, siblings: DesiredSource[]): DesiredSource[] {
  const out: DesiredSource[] = []
  for (const rec of loan.assetFinance?.recoveries ?? []) {
    const own = ownSources(loan, rec, asOf)
    const resolvedOn = rec.proceedsDate ?? rec.withdrawnAt
    const vector: Vector = {}
    if (resolvedOn && before(resolvedOn, asOf)) {
      const proceeds = rec.proceedsPaymentId ? siblings.filter((s) => s.baseKey === `payment:${rec.proceedsPaymentId}`) : []
      const left = [...own, ...proceeds].reduce((sum, s) => sum + (s.vector.RECOVERY_CLEARING ?? 0), 0)
      addTo(vector, "RECOVERY_CLEARING", -left)
      addTo(vector, "RECOVERY_RESULT", left)
    }
    out.push(...own, recoverySource(loan, `af-recovery:${rec.id}:result`, vector, "RECOVERY_RESULT", resolvedOn ?? loan.startDate,
      `Recovery of the asset of ${loan.reference} settled: clearing moved to the result`, "Recovery result"))
  }
  return out
}
