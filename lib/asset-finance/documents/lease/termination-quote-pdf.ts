// The early-termination quote of a lease (slice 3, C8/C9): the figures the
// LeaseTerminationQuote row holds (quoted on, termination date, validity, the
// remaining rentals, their present value, the penalty, VAT on both, the
// arrears and the total) and its `basis` text verbatim: the formula and, for
// a CPA lessee, the CPA Reg 5(2) wording; then the terms of the quote
// (../wording/lease-servicing.ts). Deterministic; DRAFT watermark.
// The formula and the penalty are signed off by the lender's legal team, 2026-10-17. The wording of
// the basis is drafted 2026-10-17 and awaits legal approval (TenantConfig.assetFinanceLegalWordingApproved).
import { formatZarPdf } from "@/lib/pdf/helpers"
import { formatIsoDatePdf } from "../pdf-layout"
import { terminationQuoteClauses } from "../wording/lease-servicing"
import { contactRows, finishLeaseDocument, leaseRows, openLeaseDocument } from "./lease-docs-parts"
import type { LeaseDocLender, TerminationQuoteData } from "./lease-docs-types"

export async function renderLeaseTerminationQuote(data: TerminationQuoteData, lender: LeaseDocLender): Promise<Buffer> {
  const w = await openLeaseDocument(lender, data, {
    title: "Early-termination quote",
    subtitle: `Lease ${data.reference} · quoted ${formatIsoDatePdf(data.quotedOn)} · valid until ${formatIsoDatePdf(data.validUntil)}`,
    dateIso: data.quotedOn,
  })
  w.section("1. THE LEASE")
  w.labelValues(leaseRows(data))
  w.section("2. THE QUOTE")
  w.labelValues([
    ["Quoted on", formatIsoDatePdf(data.quotedOn)],
    ["Termination date", formatIsoDatePdf(data.terminationDate)],
    ["Valid until", formatIsoDatePdf(data.validUntil)],
    ["Status", data.status === "ACCEPTED" ? "Accepted" : "Open for acceptance"],
    ["Rentals still to fall due", String(data.remainingRentals)],
  ])
  w.section("3. WHAT YOU PAY")
  w.labelValues([
    ["PV of the remaining rentals", formatZarPdf(data.pvCents)],
    ["Early-termination penalty", formatZarPdf(data.penaltyCents)],
    ["Invoiced excl. VAT", formatZarPdf(data.invoiceExclVatCents)],
    ["VAT on the PV and penalty", formatZarPdf(data.invoiceVatCents)],
    ["Arrears (incl. charges)", formatZarPdf(data.arrearsCents)],
    ["Total payable", formatZarPdf(data.totalCents)],
  ])
  w.section("4. BASIS OF THE QUOTE")
  w.paragraph(data.basis)
  w.section("5. TERMS OF THIS QUOTE")
  terminationQuoteClauses(data).forEach((c, i) => w.clause(`5.${i + 1}`, c.heading, c.text))
  w.section("6. HOW TO ACCEPT")
  w.paragraph(`Accept this quote on or before ${formatIsoDatePdf(data.validUntil)} through the lessor's portal or by contacting the lessor. After that date the quote lapses and a new quote is needed.`)
  w.labelValues(contactRows(lender))
  return finishLeaseDocument(w, data)
}
