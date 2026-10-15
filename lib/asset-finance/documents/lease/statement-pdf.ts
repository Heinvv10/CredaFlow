/**
 * The account statement of an operating or full-maintenance lease (slice 3,
 * C3). A lessee owes rentals, not capital and interest (lib/asset-finance/
 * lease-ledger.ts), so this does not reuse the credit statement
 * (lib/pdf/statement.ts), which prints an interest-rate disclosure and a
 * principal: it lists each rental (rental, maintenance, VAT, total, its tax
 * invoice once issued, paid, status), the receipts, and the totals: rentals
 * billed to date, paid, in arrears (incl. default charges) and still to come.
 * A statement of account, not agreement wording: no DRAFT watermark.
 *
 * Served by the staff route app/api/loans/[id]/statement and the portal lease
 * routes; each caller checks access and writes its DocumentAccessLog row first.
 */
import type { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { formatDatePdf, formatZarPdf, MARGIN } from "@/lib/pdf/helpers"
import { lenderIdentityOrRefusal } from "@/lib/config/identity-response"
import { loanSettlementFigures } from "@/lib/loan/charges-summary"
import { sastCalendarDate } from "@/lib/date/sast"
import { DealDocumentWriter, formatIsoDatePdf, type TableColumn } from "../pdf-layout"
import { isoOfDbDate } from "../../dates"
import { LEASE_TITLES } from "./agreement-pdf"

export type LeaseStatementResult =
  | { kind: "pdf"; bytes: Buffer; filename: string }
  | { kind: "not_found" }
  | { kind: "refused"; response: NextResponse }

const RENTAL_COLUMNS: TableColumn[] = [
  { header: "No.", x: MARGIN + 2, width: 20 },
  { header: "Due", x: MARGIN + 24, width: 66 },
  { header: "Rental", x: MARGIN + 92, width: 62, align: "right" },
  { header: "Maint.", x: MARGIN + 156, width: 56, align: "right" },
  { header: "VAT", x: MARGIN + 214, width: 52, align: "right" },
  { header: "Total", x: MARGIN + 268, width: 64, align: "right" },
  { header: "Invoice", x: MARGIN + 340, width: 70 },
  { header: "Paid", x: MARGIN + 412, width: 60, align: "right" },
  { header: "Status", x: MARGIN + 478, width: 40 },
]
const PAYMENT_COLUMNS: TableColumn[] = [
  { header: "Received", x: MARGIN + 4, width: 90 },
  { header: "Reference", x: MARGIN + 100, width: 200 },
  { header: "Amount", x: MARGIN + 310, width: 90, align: "right" },
  { header: "Note", x: MARGIN + 410, width: 100 },
]

export async function renderLeaseStatementPdf(tenantId: string, loanId: string, statementDate: Date = new Date()): Promise<LeaseStatementResult> {
  const loan = await prisma.loan.findFirst({
    where: { id: loanId, tenantId, contractType: { in: ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] } },
    include: {
      entity: { select: { legalName: true, registrationNumber: true } },
      client: { select: { firstName: true, lastName: true } },
      asset: { select: { make: true, model: true, year: true, serialNumber: true } },
      repaymentSchedule: { orderBy: { installmentNo: "asc" } },
      leaseRentals: { orderBy: { periodNo: "asc" }, include: { taxInvoice: { select: { invoiceNumber: true } } } },
      payments: { orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }] },
    },
  })
  if (!loan || (loan.contractType !== "OPERATING_LEASE" && loan.contractType !== "FULL_MAINTENANCE_LEASE")) return { kind: "not_found" }
  const lender = await lenderIdentityOrRefusal(tenantId)
  if (lender.refusal) return { kind: "refused", response: lender.refusal }
  const figures = await loanSettlementFigures(prisma, loan, statementDate)
  const today = sastCalendarDate(statementDate)
  const rows = loan.repaymentSchedule
  const billed = loan.leaseRentals.filter((r) => isoOfDbDate(r.dueDate) <= today).reduce((sum, r) => sum + r.totalCents, 0)
  const paid = rows.reduce((sum, r) => sum + r.totalPaid, 0)
  const toCome = loan.leaseRentals.filter((r) => isoOfDbDate(r.dueDate) > today).reduce((sum, r) => sum + r.totalCents, 0)

  const w = await DealDocumentWriter.create({ title: `Lease statement ${loan.reference}`, documentDate: statementDate })
  w.letterhead(lender.identity.legalName, [lender.identity.registeredOfficeLines.join(", ")])
  w.title(`${LEASE_TITLES[loan.contractType]} — STATEMENT`, [`Lease ${loan.reference} · statement date ${formatDatePdf(statementDate)}`])
  w.section("LESSEE AND GOODS")
  w.labelValues([
    ["Lessee", loan.entity ? `${loan.entity.legalName} (${loan.entity.registrationNumber})` : `${loan.client?.firstName ?? ""} ${loan.client?.lastName ?? ""}`.trim()],
    ["Goods", loan.asset ? `${loan.asset.year} ${loan.asset.make} ${loan.asset.model}, serial ${loan.asset.serialNumber}` : "—"],
    ["Term", `${formatDatePdf(loan.startDate)} to ${formatDatePdf(loan.maturityDate)} (last rental)`],
  ])
  w.section("ACCOUNT")
  w.labelValues([
    ["Rentals billed to date (incl. VAT)", formatZarPdf(billed)],
    ["Paid", formatZarPdf(paid)],
    ["In arrears (incl. charges)", formatZarPdf(figures.arrearsIncludingCharges)],
    ["Rentals still to fall due", formatZarPdf(toCome)],
    ["Early termination", "By quotation only: the rentals still to fall due are not a settlement figure"],
  ])
  w.table("RENTALS", RENTAL_COLUMNS, loan.leaseRentals.map((r, i) => {
    const row = rows[i]
    const due = isoOfDbDate(r.dueDate)
    const status = row.totalPaid >= row.totalDue ? "Paid" : due <= today ? (row.totalPaid > 0 ? "Part" : "Due") : "—"
    return [
      String(r.periodNo), formatIsoDatePdf(due), formatZarPdf(r.rentalExclVatCents),
      r.maintenanceExclVatCents > 0 ? formatZarPdf(r.maintenanceExclVatCents) : "", formatZarPdf(r.vatCents), formatZarPdf(r.totalCents),
      r.taxInvoice?.invoiceNumber ?? "", formatZarPdf(row.totalPaid), status,
    ]
  }))
  w.table("RECEIPTS", PAYMENT_COLUMNS, loan.payments.map((p) => [
    formatDatePdf(p.receivedAt ?? p.createdAt), p.reference ?? "", formatZarPdf(p.amount),
    p.reversed ? "Reversed" : p.allocationStatus === "UNAPPLIED" ? "Refund due" : "",
  ]))
  const bytes = await w.finish({ reference: loan.reference, watermark: false })
  return { kind: "pdf", bytes, filename: `lease-statement-${loan.reference}-${today}.pdf` }
}
