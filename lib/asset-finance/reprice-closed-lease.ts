import { sastCalendarDate } from "@/lib/date/sast"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { vatOnExclusive } from "@/lib/vat/amounts"
import { rateTenThousandthsOf } from "@/lib/vat/vat-rate"
import { issueRentalRateTaxDocument, objectEvidence, type PendingLeaseRateTax } from "./lease-rate-tax-adjustment"
import { correctionBalance } from "./rate-correction"
import { dbDate, isoOfDbDate } from "./dates"
import { queueRepriceNotice } from "./reprice-notice"
import type { LeaseCapitalView } from "./lease-reprice"
import type { RepriceTx, RepriceRequest, RepriceOutcome } from "./reprice-loan"
import type { RatePoint } from "./types"
import type { Prisma } from "@prisma/client"

import type { RateTaxDocument } from "./rate-tax-documents"

/** A lease with closed or notice-fixed rentals uses ex-VAT asset funding. Rentals, excluding
 * maintenance and VAT, amortise it to the lessor's retained residual; that
 * residual is not a receipt. Issued invoices remain immutable. */
export async function writeClosedLeaseRateCorrection(
  tx: RepriceTx,
  input: {
    request: RepriceRequest
    view: LeaseCapitalView
    startDate: string
    oldPath: RatePoint[]
    newPath: RatePoint[]
    resultingRate: Prisma.Decimal
    margin: Prisma.Decimal
    ledgerOnlyDates?: Set<string>
    loan: { reference: string; entityId: string | null }
  }
): Promise<RepriceOutcome> {
  const { request, view, loan } = input
  const { tenantId, loanId, effectiveDate } = request
  const capital = view.rows[0].assetFinanceOpeningBalanceCents
  if (capital == null) throw new Error("Closed lease rate correction needs its original capital snapshot")
  const events = view.rows.map((row, index) => ({
    day: sastCalendarDate(row.dueDate),
    capitalCashCents: row.totalDue - (index === view.rows.length - 1 ? view.residualCents : 0),
  }))
  const oldClosing = correctionBalance(capital, input.startDate, input.oldPath, events)
  const revisedClosing = correctionBalance(capital, input.startDate, input.newPath, events)
  if (oldClosing + (view.lessorFundingDifferenceCents ?? 0) !== view.residualCents)
    throw new Error("Closed lease capital path does not reconcile to its retained residual")
  const previous = await tx.assetFinanceRateCorrection.findMany({
    where: { tenantId, loanId },
    include: { contractRate: { select: { effectiveDate: true } } },
  })
  const unappliedSources = new Set(
    previous
      .filter(
        (row) =>
          row.reason === "LATE_CLOSED_LEASE_RATE" &&
          (!input.ledgerOnlyDates || input.ledgerOnlyDates.has(isoOfDbDate(row.contractRate.effectiveDate)))
      )
      .map((row) => row.id)
  )
  const periodAdjustments: Array<{ periodNo: number; exclVatCents: number }> = []
  const pendingTaxAdjustments: PendingLeaseRateTax[] = []
  const taxDocuments: RateTaxDocument[] = []
  const rate = await tx.contractRate.create({
    data: {
      tenantId,
      loanId,
      effectiveDate: dbDate(effectiveDate),
      basis: request.basis,
      margin: input.margin,
      resultingRate: input.resultingRate,
      newInstalmentCents: 0,
      createdById: request.actorUserId,
    },
  })
  let priorTarget = 0
  for (const index of events.keys()) {
    const periodNo = index + 1
    const target =
      correctionBalance(capital, input.startDate, input.newPath, events.slice(0, index + 1)) -
      correctionBalance(capital, input.startDate, input.oldPath, events.slice(0, index + 1))
    const targetShare = target - priorTarget
    priorTarget = target
    const already = previous.reduce((sum, row) => {
      const evidence = objectEvidence(row.contractualRows)
      if (
        row.reason === "RATE_PAYOFF_CREDIT" ||
        (row.reason === "LATE_CLOSED_LEASE_RATE" && !unappliedSources.has(row.id))
      )
        return sum
      if (row.reason === "LEASE_SUPPLY_TAX_CANCELLED" && !unappliedSources.has(String(evidence.sourceCorrectionId)))
        return sum
      if (row.reason === "LEASE_SUPPLY_TAX_CANCELLED" && evidence.periodNo === periodNo)
        return sum + Number(evidence.exclVatAdjustmentCents ?? 0)
      const parts = evidence.periodAdjustments
      return (
        sum +
        (Array.isArray(parts)
          ? parts.reduce<number>(
              (subtotal, part) =>
                part && typeof part === "object" && !Array.isArray(part) && part.periodNo === periodNo
                  ? subtotal + Number(part.exclVatCents ?? 0)
                  : subtotal,
              0
            )
          : 0)
      )
    }, 0)
    const exclVatCents = targetShare - already
    if (!exclVatCents) continue
    const rental = view.rentals.get(periodNo)!
    periodAdjustments.push({ periodNo, exclVatCents })
    if (rental.taxInvoiceId)
      taxDocuments.push(
        await issueRentalRateTaxDocument(tx, {
          tenantId,
          loanId,
          invoiceId: rental.taxInvoiceId,
          periodNo,
          exclVatCents,
          issueDate: request.runDate,
          effectiveDate,
          actorUserId: request.actorUserId,
        })
      )
    else
      pendingTaxAdjustments.push({
        rentalId: rental.id,
        periodNo,
        exclVatCents,
        estimatedGrossCents:
          exclVatCents +
          Math.sign(exclVatCents) * vatOnExclusive(Math.abs(exclVatCents), rateTenThousandthsOf(rental.vatRate)),
      })
  }
  const cumulativeExcl = revisedClosing - oldClosing
  const exclDelta = periodAdjustments.reduce((sum, item) => sum + item.exclVatCents, 0)
  const amountCents =
    taxDocuments.reduce((sum, doc) => sum + doc.inclVatCents, 0) +
    pendingTaxAdjustments.reduce((sum, item) => sum + item.estimatedGrossCents, 0)
  const cumulativeAmount = previous.reduce((sum, row) => sum + row.amountCents, 0) + amountCents
  await tx.assetFinanceRateCorrection.create({
    data: {
      tenantId,
      loanId,
      contractRateId: rate.id,
      cause: `LEASE:${rate.id}`,
      amountCents,
      cumulativeAmountCents: cumulativeAmount,
      reason: "LATE_CLOSED_LEASE_RATE",
      contractualRows: {
        originalCapitalExclVatCents: capital,
        retainedResidualCents: view.residualCents,
        oldClosingBalanceCents: oldClosing,
        correctedClosingBalanceCents: revisedClosing,
        exclVatAdjustmentCents: exclDelta,
        cumulativeExclVatAdjustmentCents: cumulativeExcl,
        maintenanceExcludedCents: [...view.rentals.values()].reduce((sum, row) => sum + row.maintenanceExclVatCents, 0),
        periodAdjustments,
        pendingTaxAdjustments,
        events,
        billedPath: input.oldPath,
        correctedPath: input.newPath,
        taxDocuments,
      },
    },
  })
  const recipients = await queueRepriceNotice(tx, {
    tenantId,
    loanId,
    entityId: loan.entityId,
    loanReference: loan.reference,
    contractRateId: rate.id,
    resultingRate: input.resultingRate.toString(),
    effectiveDate,
    firstChangedPaymentDate: request.runDate,
    oldInstalmentCents: 0,
    newInstalmentCents: 0,
    historicalBalanceAdjustmentCents: amountCents,
    correctionPendingManual: true,
    taxAdjustmentPending: pendingTaxAdjustments.length > 0,
    taxDocuments,
    totalInterestCents: 0,
    monthlyInterestCents: 0,
  })
  await logAuditStrict(
    {
      tenantId,
      userId: request.actorUserId,
      action: AuditAction.LOAN_REPRICED,
      entity: "Loan",
      entityId: loanId,
      newValue: {
        contractRateId: rate.id,
        effectiveDate,
        closedLeaseCorrection: true,
        capitalExclVatAdjustmentCents: exclDelta,
        amountCents,
        taxDocuments,
        correctionPendingManual: true,
      },
    },
    tx
  )
  await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
  return {
    kind: "repriced",
    contractRateId: rate.id,
    resultingRate: input.resultingRate.toString(),
    oldInstalmentCents: 0,
    newInstalmentCents: 0,
    rowsRepriced: 0,
    noticeRecipientClientIds: recipients,
  }
}
