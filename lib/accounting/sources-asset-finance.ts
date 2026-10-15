/**
 * Asset-finance contracts as journal sources (slice 4b). Dispatched from
 * lib/accounting/sources.ts for a loan with `assetFinance` set; the consumer
 * sources never see these loans (a lease's `Loan.principal` is every future
 * rental, an instalment sale's includes capitalised interest, and neither is
 * the amount paid out).
 *
 * Instalment sale and finance lease (the lender owns the debt, not the asset):
 *   inception   on the day the supplier payout is released (a payout not yet
 *               released has not posted): Dr AF_INSTALMENT_DEBTORS F; Dr INPUT_VAT v; Cr OUTPUT_VAT v;
 *               Cr BANK payout; Cr FEE_INCOME financed fees. F = payout + fees
 *               = cash price incl. VAT - deposit - trade-in + fees, and the
 *               reconciliation holds it to the schedule's first opening balance.
 *   instalment  Dr debtors / Cr INTEREST_INCOME the interest the row accrues,
 *               on its due date: B(next) - B(this) + totalDue, B = the capital
 *               balance each row's interest accrued on. That includes interest
 *               capitalised in a skip period; the balloon is principal already
 *               inside F and posts nothing of its own.
 * Operating and full-maintenance lease (the lessor owns the asset):
 *   asset       Dr LEASED_ASSETS cost; Dr INPUT_VAT; Cr BANK (the supplier payout)
 *   rental      per rental tax invoice, on its supply date: Dr LEASE_DEBTORS total;
 *               Cr RENTAL_INCOME, MAINTENANCE_INCOME, OUTPUT_VAT
 *   invoice     a lease's other tax invoice (end of term, purchase, early
 *               termination): the invoice becomes a schedule row of the loan
 *               (lib/asset-finance/lease-charges.ts), so it sits on LEASE_DEBTORS;
 *               the asset sold credits ASSET_DISPOSAL_PROCEEDS, a billed fund
 *               deficit MAINTENANCE_FUND_LIABILITY, the rest RENTAL_INCOME
 *   credit note Dr the income the invoice credited (spread pro rata), Dr OUTPUT_VAT; Cr LEASE_DEBTORS, on its issue date
 *   fund        maintenance fund movements; a lessee-settled fund is the lessee's
 *               money, a lender-risk fund's claims are an expense.
 * Receipts, charges and the write-off are the generic sources, on the loan's
 * receivable role. Depreciation and the net book value of a leased asset sold
 * or recovered stay in the lender's fixed-asset register: documented, not posted.
 *
 * // UNTESTED: accounting — interest is recognised as it falls due (no deferred finance income), as for consumer loans.
 * // UNTESTED: tax — the lender claims input VAT on the dealer's invoice at inception and accounts for output VAT on its own supply.
 * AF contracts never split fee VAT out of a VAT-inclusive fee account: their VAT is explicit only (lib/accounting/derive.ts).
 * // UNTESTED: tax — VAT on maintenance claims is not posted (a claim's amount is ex VAT in the fund).
 */
import { addTo, before, type DesiredSource, type EventType, type SourceCreditNote, type SourceInvoice, type SourceLoan, type Vector } from "./source-types"
import { recoverySources } from "./sources-recovery"
import { receiptSources } from "./sources-receipts"
import { adjustment, chargeSources, raisedOn, writtenOffAt } from "./sources-shared"

const source = (loan: SourceLoan, baseKey: string, vector: Vector, type: EventType, date: Date, description: string, what: string): DesiredSource => ({
  baseKey, loanId: loan.id, reference: loan.reference, vector,
  origin: { type, date, description },
  change: adjustment(loan, what, null),
})

function inceptionSource(loan: SourceLoan, asOf: Date): DesiredSource {
  const af = loan.assetFinance!
  const inv = af.inceptionInvoice
  const vector: Vector = {}
  // Posted when the supplier is paid, as for a lease: a payout not yet released has not posted anything.
  if (inv && af.payout && before(af.payout.releasedAt, asOf)) {
    addTo(vector, "AF_INSTALMENT_DEBTORS", af.payout.amountCents + af.financedFeesCents)
    addTo(vector, "INPUT_VAT", inv.vatCents)
    addTo(vector, "OUTPUT_VAT", -inv.vatCents)
    addTo(vector, "BANK", -af.payout.amountCents)
    addTo(vector, "FEE_INCOME", -af.financedFeesCents)
  }
  return source(loan, `af:${loan.id}:inception`, vector, "ASSET_INCEPTION", af.payout?.releasedAt ?? inv?.supplyDate ?? loan.startDate,
    `${loan.assetFinance!.contractType === "FINANCE_LEASE" ? "Finance lease" : "Instalment sale"} ${loan.reference} booked and the supplier paid`, "Inception")
}

function instalmentSources(loan: SourceLoan, asOf: Date): DesiredSource[] {
  const rows = [...loan.schedule].sort((a, b) => a.installmentNo - b.installmentNo)
  return rows.map((row, i) => {
    const on = raisedOn(loan, row.dueDate, asOf)
    const vector: Vector = {}
    if (on) {
      const accrued = (rows[i + 1]?.openingBalanceCents ?? 0) - (row.openingBalanceCents ?? 0) + row.totalDue
      addTo(vector, "AF_INSTALMENT_DEBTORS", accrued)
      addTo(vector, "INTEREST_INCOME", -accrued)
    }
    return source(loan, `af:${loan.id}:row:${row.id}`, vector, "INSTALMENT_DUE", on ?? row.dueDate,
      `Instalment ${row.installmentNo} interest due on ${loan.reference}`, `Instalment ${row.installmentNo}`)
  })
}

function leaseAssetSource(loan: SourceLoan, asOf: Date): DesiredSource {
  const af = loan.assetFinance!
  const vector: Vector = {}
  if (af.payout && before(af.payout.releasedAt, asOf)) {
    addTo(vector, "LEASED_ASSETS", af.asset.exclVatCents)
    addTo(vector, "INPUT_VAT", af.asset.vatCents)
    addTo(vector, "BANK", -af.payout.amountCents)
  }
  return source(loan, `lease:${loan.id}:asset`, vector, "ASSET_INCEPTION", af.payout?.releasedAt ?? loan.startDate,
    `Lease ${loan.reference} booked and the supplier paid for the asset`, "Lease asset")
}

const invoiced = (invoice: SourceInvoice, asOf: Date) => before(invoice.supplyDate, asOf)

function leaseInvoiceSources(loan: SourceLoan, asOf: Date): DesiredSource[] {
  const af = loan.assetFinance!
  const rentals = af.rentals.map((r) => {
    const vector: Vector = {}
    if (invoiced(r.invoice, asOf)) {
      addTo(vector, "LEASE_DEBTORS", r.totalCents)
      addTo(vector, "RENTAL_INCOME", -r.rentalExclVatCents)
      addTo(vector, "MAINTENANCE_INCOME", -r.maintenanceExclVatCents)
      addTo(vector, "OUTPUT_VAT", -r.vatCents)
    }
    return source(loan, `lease-rental:${r.id}`, vector, "LEASE_RENTAL", r.invoice.supplyDate, `Rental invoiced on ${loan.reference}`, "Rental")
  })
  const sundry = af.sundryInvoices.map((inv) => {
    const vector: Vector = {}
    if (invoiced(inv, asOf)) {
      addTo(vector, "LEASE_DEBTORS", inv.inclVatCents)
      addTo(vector, "OUTPUT_VAT", -inv.vatCents)
      addTo(vector, "ASSET_DISPOSAL_PROCEEDS", -inv.assetSaleExclVatCents)
      // A billed fund deficit settles the lessee's fund (the liability the claims drew down), it is not income.
      addTo(vector, "MAINTENANCE_FUND_LIABILITY", -(inv.fundBilledExclVatCents ?? 0))
      addTo(vector, "RENTAL_INCOME", -(inv.exclVatCents - inv.assetSaleExclVatCents - (inv.fundBilledExclVatCents ?? 0)))
    }
    return source(loan, `lease-invoice:${inv.id}`, vector, "LEASE_INVOICE", inv.supplyDate, `Lease invoice (end of term or termination) on ${loan.reference}`, "Lease invoice")
  })
  return [...rentals, ...sundry]
}

/**
 * Spreads a credit's value over the income the invoice credited, in proportion
 * (largest remainder, so the parts add up to the cent). // UNTESTED: accounting —
 * the split of a credit between rental, maintenance and asset-sale income, and that
 * a credited maintenance contribution stays in the lessee's fund.
 */
export function creditShares(note: SourceCreditNote): Array<{ role: SourceCreditNote["invoiceIncome"][number]["role"]; cents: number }> {
  const parts = note.invoiceIncome.filter((p) => p.exclVatCents > 0)
  const total = parts.reduce((sum, p) => sum + p.exclVatCents, 0)
  if (total === 0) return []
  const shares = parts.map((p, i) => ({ i, role: p.role, cents: Math.floor((note.exclVatCents * p.exclVatCents) / total), rest: (note.exclVatCents * p.exclVatCents) % total }))
  let left = note.exclVatCents - shares.reduce((sum, s) => sum + s.cents, 0)
  for (const s of [...shares].sort((a, b) => b.rest - a.rest || a.i - b.i)) {
    if (left === 0) break
    s.cents += 1
    left -= 1
  }
  return shares.map(({ role, cents }) => ({ role, cents }))
}

function creditNoteSources(loan: SourceLoan, asOf: Date): DesiredSource[] {
  return loan.assetFinance!.creditNotes.map((note) => {
    const vector: Vector = {}
    const shares = creditShares(note)
    // A credit with no income to spread over would not balance: it posts nothing and the loader refuses the close.
    if (shares.length > 0 && before(note.issueDate, asOf)) {
      for (const share of shares) addTo(vector, share.role, share.cents)
      addTo(vector, "OUTPUT_VAT", note.vatCents)
      addTo(vector, "LEASE_DEBTORS", -note.inclVatCents)
    }
    return source(loan, `lease-credit:${note.id}`, vector, "CREDIT_NOTE", note.issueDate, `Credit note on a lease invoice of ${loan.reference}`, "Credit note")
  })
}

function fundSources(loan: SourceLoan, asOf: Date): DesiredSource[] {
  const fund = loan.assetFinance!.fund
  if (!fund) return []
  return fund.movements.flatMap((m) => {
    const vector: Vector = {}
    const done = before(m.occurredOn, asOf)
    if (fund.riskModel === "LESSEE_SETTLED") {
      // A billed deficit is on the end-of-term invoice (lease-invoice source), which credits the liability itself.
      if (m.kind === "SETTLEMENT_BILLED") return []
      if (done && m.kind === "CONTRIBUTION") {
        addTo(vector, "MAINTENANCE_INCOME", m.amountCents)
        addTo(vector, "MAINTENANCE_FUND_LIABILITY", -m.amountCents)
      } else if (done) {
        addTo(vector, "MAINTENANCE_FUND_LIABILITY", m.amountCents)
        addTo(vector, "BANK", -m.amountCents)
      }
    } else if (m.kind === "CLAIM") {
      if (done) {
        addTo(vector, "MAINTENANCE_EXPENSE", m.amountCents)
        addTo(vector, "BANK", -m.amountCents)
      }
    } else {
      return []
    }
    return [source(loan, `mf:${m.id}`, vector, "MAINTENANCE_FUND", m.occurredOn, `Maintenance fund ${m.kind.replaceAll("_", " ").toLowerCase()} on ${loan.reference}`, "Maintenance fund movement")]
  })
}

/** Every source of an asset-finance loan as at `asOf`, write-off excluded (lib/accounting/sources.ts adds it). */
export function assetFinanceSources(loan: SourceLoan, asOf: Date): DesiredSource[] {
  const lease = loan.assetFinance!.contractType === "OPERATING_LEASE" || loan.assetFinance!.contractType === "FULL_MAINTENANCE_LEASE"
  const out: DesiredSource[] = lease
    ? [leaseAssetSource(loan, asOf), ...leaseInvoiceSources(loan, asOf), ...creditNoteSources(loan, asOf), ...fundSources(loan, asOf)]
    : [inceptionSource(loan, asOf), ...instalmentSources(loan, asOf)]
  out.push(...chargeSources(loan, asOf, true, null))
  out.push(...receiptSources(loan, asOf, writtenOffAt(loan, asOf)))
  out.push(...recoverySources(loan, asOf, out))
  return out
}
