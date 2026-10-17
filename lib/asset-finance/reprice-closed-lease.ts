import { sastCalendarDate } from "@/lib/date/sast"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { issueCreditNote } from "@/lib/vat/credit-note"
import { issueTaxInvoice } from "@/lib/vat/tax-invoice"
import { correctionBalance } from "./rate-correction"
import { dbDate, isoOfDbDate } from "./dates"
import { queueRepriceNotice } from "./reprice-notice"
import type { LeaseCapitalView } from "./lease-reprice"
import type { RepriceTx, RepriceRequest, RepriceOutcome } from "./reprice-loan"
import type { RatePoint } from "./types"
import type { Prisma } from "@prisma/client"

import type { RateTaxDocument } from "./rate-tax-documents"
const evidenceOf = (value: Prisma.JsonValue) => value && typeof value === "object" && !Array.isArray(value) ? value : {}

/** A closed lease's capital is the ex-VAT asset funding. Rentals, excluding
 * maintenance and VAT, amortise it to the lessor's retained residual; that
 * residual is not a receipt. Issued invoices remain immutable. */
export async function writeClosedLeaseRateCorrection(tx: RepriceTx, input: {
  request: RepriceRequest; view: LeaseCapitalView; startDate: string; oldPath: RatePoint[]; newPath: RatePoint[];
  resultingRate: Prisma.Decimal; margin: Prisma.Decimal; loan: { reference: string; entityId: string | null };
}): Promise<RepriceOutcome> {
  const { request, view, loan } = input
  const { tenantId, loanId, effectiveDate } = request
  const capital = view.rows[0].assetFinanceOpeningBalanceCents
  if (capital == null) throw new Error("Closed lease rate correction needs its original capital snapshot")
  const events = view.rows.map((row,index) => ({ day: sastCalendarDate(row.dueDate), capitalCashCents: row.totalDue - (index === view.rows.length-1 ? view.residualCents : 0) }))
  const oldClosing = correctionBalance(capital, input.startDate, input.oldPath, events)
  const revisedClosing = correctionBalance(capital, input.startDate, input.newPath, events)
  if (oldClosing !== view.residualCents) throw new Error("Closed lease capital path does not reconcile to its retained residual")
  const previous = await tx.assetFinanceRateCorrection.findMany({ where: { tenantId, loanId } })
  const priorExcl = previous.filter((row) => row.reason === "LATE_CLOSED_LEASE_RATE").reduce((sum,row) => sum + Number(evidenceOf(row.contractualRows).exclVatAdjustmentCents ?? 0),0)
  const cumulativeExcl = revisedClosing - oldClosing
  const exclDelta = cumulativeExcl - priorExcl
  const rate = await tx.contractRate.create({ data: { tenantId, loanId, effectiveDate: dbDate(effectiveDate), basis: request.basis, margin: input.margin, resultingRate: input.resultingRate, newInstalmentCents: 0, createdById: request.actorUserId } })
  const sources = [...view.rentals.entries()].filter(([period]) => events[period-1].day >= effectiveDate).sort(([a],[b]) => b-a)
  const taxDocuments: RateTaxDocument[] = []
  if (exclDelta < 0) {
    let credit = -exclDelta
    for (const [period,rental] of sources) {
      if (!credit) break
      if (!rental.taxInvoiceId) throw new Error("A closed lease rate credit needs its issued rental invoice")
      const prior = await tx.creditNote.aggregate({ where: { tenantId, invoiceId: rental.taxInvoiceId }, _sum: { exclVatCents: true } })
      const value = Math.min(credit, Math.max(0, rental.rentalExclVatCents - (prior._sum.exclVatCents ?? 0)))
      if (!value) continue
      const original = await tx.taxInvoice.findFirstOrThrow({ where: { tenantId, id: rental.taxInvoiceId } })
      const note = await issueCreditNote(tx, { tenantId, invoiceId: rental.taxInvoiceId, issueDate: request.runDate, reason: `Rental-only reference-rate correction, account ${loan.reference}, period ${period}, effective ${effectiveDate}`, exclVatCents: value, createdById: request.actorUserId })
      taxDocuments.push({ number: note.creditNoteNumber, originalInvoiceNumber: original.invoiceNumber, issueDate: request.runDate, reason: note.reason, supplierName: original.supplierName, supplierAddress: original.supplierAddress, supplierVatNumber: original.supplierVatNumber, recipientName: original.recipientName, recipientAddress: original.recipientAddress, recipientVatNumber: original.recipientVatNumber, vatRate: original.vatRate.toString(), kind: "CREDIT_NOTE", id: note.id, invoiceId: rental.taxInvoiceId, periodNo: period, exclVatCents: -note.exclVatCents, vatCents: -note.vatCents, inclVatCents: -note.inclVatCents })
      credit -= value
    }
    if (credit !== 0) throw new Error("The lease rate credit exceeds the original rental value available to credit")
  } else if (exclDelta > 0) {
    const source = sources[0]
    if (!source) throw new Error("Lease rate debit has no affected rental period")
    const [period,rental] = source
    if (!rental.taxInvoiceId) throw new Error("A closed lease rate debit needs its original rental supply")
    const original = await tx.taxInvoice.findFirstOrThrow({ where: { tenantId, id: rental.taxInvoiceId } })
    const invoice = await issueTaxInvoice(tx, { debitNoteForInvoiceId: original.id, adjustmentReason: `Reference-rate correction effective ${effectiveDate}, rental period ${period}`, tenantId, loanId, issueDate: request.runDate, supplyDate: isoOfDbDate(original.supplyDate), recipient: { name: original.recipientName, address: original.recipientAddress, vatNumber: original.recipientVatNumber }, lines: [{ description: `Additional rental consideration, ${loan.reference}, period ${period}, reference-rate correction effective ${effectiveDate}`, quantity: 1, unitExclVatCents: exclDelta }], createdById: request.actorUserId })
    if (!invoice.vatRate.equals(original.vatRate)) throw new Error("Lease rate debit must retain the original supply's VAT rate")
    taxDocuments.push({ number: invoice.invoiceNumber, originalInvoiceNumber: original.invoiceNumber, issueDate: request.runDate, reason: invoice.adjustmentReason!, supplierName: invoice.supplierName, supplierAddress: invoice.supplierAddress, supplierVatNumber: invoice.supplierVatNumber, recipientName: invoice.recipientName, recipientAddress: invoice.recipientAddress, recipientVatNumber: invoice.recipientVatNumber, vatRate: invoice.vatRate.toString(), kind: "DEBIT_NOTE", id: invoice.id, invoiceId: original.id, periodNo: period, exclVatCents: invoice.totalExclVatCents, vatCents: invoice.vatCents, inclVatCents: invoice.totalInclVatCents })
  }
  const amountCents = taxDocuments.reduce((sum,doc) => sum + doc.inclVatCents,0)
  const cumulativeAmount = previous.reduce((sum,row) => sum + row.amountCents,0) + amountCents
  await tx.assetFinanceRateCorrection.create({ data: { tenantId, loanId, contractRateId: rate.id, cause: `LEASE:${rate.id}`, amountCents, cumulativeAmountCents: cumulativeAmount, reason: "LATE_CLOSED_LEASE_RATE", contractualRows: { originalCapitalExclVatCents: capital, retainedResidualCents: view.residualCents, oldClosingBalanceCents: oldClosing, correctedClosingBalanceCents: revisedClosing, exclVatAdjustmentCents: exclDelta, cumulativeExclVatAdjustmentCents: cumulativeExcl, maintenanceExcludedCents: [...view.rentals.values()].reduce((sum,row) => sum + row.maintenanceExclVatCents,0), events, billedPath: input.oldPath, correctedPath: input.newPath, taxDocuments } } })
  const recipients = await queueRepriceNotice(tx, { tenantId, loanId, entityId: loan.entityId, loanReference: loan.reference, contractRateId: rate.id, resultingRate: input.resultingRate.toString(), effectiveDate, firstChangedPaymentDate: request.runDate, oldInstalmentCents: 0, newInstalmentCents: 0, historicalBalanceAdjustmentCents: amountCents, correctionPendingManual: true, taxDocuments, totalInterestCents: 0, monthlyInterestCents: 0 })
  await logAuditStrict({ tenantId, userId: request.actorUserId, action: AuditAction.LOAN_REPRICED, entity: "Loan", entityId: loanId, newValue: { contractRateId: rate.id, effectiveDate, closedLeaseCorrection: true, capitalExclVatAdjustmentCents: exclDelta, amountCents, taxDocuments, correctionPendingManual: true } }, tx)
  await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
  return { kind: "repriced", contractRateId: rate.id, resultingRate: input.resultingRate.toString(), oldInstalmentCents: 0, newInstalmentCents: 0, rowsRepriced: 0, noticeRecipientClientIds: recipients }
}
