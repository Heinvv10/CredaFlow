import { Prisma } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { recomputeLoanBalances, nextPaymentDueDate } from "@/lib/loan/balances"
import { syncLoanCharges } from "@/lib/loan/charges-sync"
import { dbDate } from "./dates"
import { sastCalendarDate } from "@/lib/date/sast"
import { dueDateInstant } from "./schedule-records"
import { issueRentalRateTaxDocument, consumeDeferredLeaseRateTax, objectEvidence } from "./lease-rate-tax-adjustment"
import { rateTaxDocuments, type RateTaxDocument } from "./rate-tax-documents"
import { writeLeaseRepricedRows, type LeaseCapitalView } from "./lease-reprice"
import { writeRestatedRows } from "./reprice-writes"
import { queueRepriceNotice } from "./reprice-notice"
import type { RepriceTx, RepriceRequest, RepriceOutcome } from "./reprice-loan"
import type { LeaseRentalFloorPlan } from "./lease-rental-floor"
import type { StoredScheduleRow } from "./stored-schedule"
import type { RatePoint, ScheduleRow } from "./types"

/** Historical cash is unchanged. The credit is a pending liability, not a
 * claimed bank refund. Only the affected original supplies may receive notes. */
export async function writeLeaseRentalFloor(
  tx: RepriceTx,
  input: {
    request: RepriceRequest
    loan: { reference: string; entityId: string | null }
    view: LeaseCapitalView
    stored: StoredScheduleRow[]
    plan: LeaseRentalFloorPlan
    paid: number
    kept: number
    path: RatePoint[]
    resultingRate: Prisma.Decimal
    margin: Prisma.Decimal
  }
): Promise<RepriceOutcome> {
  const { request, plan, view, stored, paid, kept } = input
  const { tenantId, loanId, effectiveDate } = request
  const prior = await tx.assetFinanceRateCorrection.findMany({ where: { tenantId, loanId } })
  const oldDocs = [
    ...new Map(
      prior
        .flatMap((row) => rateTaxDocuments(objectEvidence(row.contractualRows).taxDocuments ?? null))
        .map((doc) => [doc.id, doc])
    ).values(),
  ]
  const historicDocs = oldDocs.filter((doc) => doc.periodNo <= paid + 1)
  const creditByPeriod = new Map(plan.credits.map((credit) => [credit.index, credit.exclVatCents]))
  let priorFaceReconciliationCents = 0
  for (const doc of historicDocs) {
    const index = doc.periodNo - 1
    if (sastCalendarDate(stored[index].dueDate) < effectiveDate) priorFaceReconciliationCents += doc.exclVatCents
    else creditByPeriod.set(index, (creditByPeriod.get(index) ?? 0) + doc.exclVatCents)
  }
  // Earlier valid notes remain issued. Reconcile their pending face against
  // the new affected-period credit, rather than fabricating earlier cash.
  creditByPeriod.set(paid, (creditByPeriod.get(paid) ?? 0) + priorFaceReconciliationCents)
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
  const documents: RateTaxDocument[] = []
  let carriedCredit = 0
  for (let index = paid; index >= 0; index--) {
    if (sastCalendarDate(stored[index].dueDate) < effectiveDate) continue
    let creditLeft = (creditByPeriod.get(index) ?? 0) + carriedCredit
    carriedCredit = 0
    if (!creditLeft) continue
    const rental = view.rentals.get(index + 1)!
    if (!rental.taxInvoiceId)
      throw new Error("A historical rental credit requires its actual original supplied invoice")
    if (creditLeft < 0) {
      documents.push(
        await issueRentalRateTaxDocument(tx, {
          ...request,
          invoiceId: rental.taxInvoiceId,
          periodNo: index + 1,
          exclVatCents: -creditLeft,
          issueDate: request.runDate,
        })
      )
      creditLeft = 0
      continue
    }
    // Preserve valid older notes. Reverse any additional rental consideration
    // through its own debit-note supply before crediting the original rental.
    for (const debit of historicDocs.filter((doc) => doc.periodNo === index + 1 && doc.kind === "DEBIT_NOTE")) {
      const credited = await tx.creditNote.aggregate({
        where: { tenantId, invoiceId: debit.id },
        _sum: { exclVatCents: true },
      })
      const amount = Math.min(creditLeft, debit.exclVatCents - (credited._sum.exclVatCents ?? 0))
      if (amount <= 0) continue
      documents.push(
        await issueRentalRateTaxDocument(tx, {
          ...request,
          invoiceId: debit.id,
          periodNo: index + 1,
          exclVatCents: -amount,
          issueDate: request.runDate,
        })
      )
      creditLeft -= amount
    }
    const already = historicDocs
      .filter((doc) => doc.invoiceId === rental.taxInvoiceId && doc.kind === "CREDIT_NOTE")
      .reduce((sum, doc) => sum - doc.exclVatCents, 0)
    const amount = Math.min(creditLeft, Math.max(0, rental.rentalExclVatCents - already))
    if (amount > 0) {
      documents.push(
        await issueRentalRateTaxDocument(tx, {
          ...request,
          invoiceId: rental.taxInvoiceId,
          periodNo: index + 1,
          exclVatCents: -amount,
          issueDate: request.runDate,
        })
      )
      creditLeft -= amount
    }
    carriedCredit = creditLeft
  }
  if (carriedCredit !== 0)
    throw new Error("The rental floor credit exceeds its affected original supplied rental consideration")
  const rows: ScheduleRow[] = plan.rows.map((row, index) => {
    const last = index === stored.length - 1
    const interest = row.interestCents + (last ? plan.lessorFundingDifferenceCents : 0)
    return {
      index,
      dueDate: sastCalendarDate(stored[index].dueDate),
      weight: index > kept ? 1 : 0,
      openingBalanceCents: row.openingCents,
      interestCents: interest,
      principalCents: row.paymentCents - interest,
      feesCents: 0,
      balloonCents: last ? view.residualCents : 0,
      totalCents: row.paymentCents + (last ? view.residualCents : 0),
      closingBalanceCents: last ? 0 : row.closingCents,
    }
  })
  await writeRestatedRows(tx, tenantId, loanId, stored, rows.slice(0, paid + 1), true)
  await writeLeaseRepricedRows(tx, tenantId, loanId, view, stored, rows.slice(paid + 1))
  await consumeDeferredLeaseRateTax(tx, {
    tenantId,
    loanId,
    rentalIds: stored.slice(kept + 1).map((row) => view.rentals.get(row.installmentNo)!.id),
    today: request.runDate,
    actorUserId: request.actorUserId ?? null,
    replacedByRentalFloor: true,
  })
  // Superseded ledger-only rates are now represented by the actual funding
  // replay. Rebase their pending face once, retaining every issued document.
  const pending = await tx.assetFinanceRateCorrection.aggregate({
    where: { tenantId, loanId },
    _sum: { amountCents: true },
  })
  await tx.assetFinanceRateCorrection.create({
    data: {
      tenantId,
      loanId,
      contractRateId: rate.id,
      cause: `SCHEDULE:${rate.id}`,
      amountCents: -(pending._sum.amountCents ?? 0),
      cumulativeAmountCents: 0,
      reason: "APPLIED_TO_SCHEDULE",
      contractualRows: { source: "lease_rental_floor", pendingAmountCents: pending._sum.amountCents },
    },
  })
  const amountCents =
    historicDocs.reduce((sum, doc) => sum + doc.inclVatCents, 0) +
    documents.reduce((sum, doc) => sum + doc.inclVatCents, 0)
  const periodAdjustments = documents.map((doc) => ({ periodNo: doc.periodNo, exclVatCents: doc.exclVatCents }))
  await tx.assetFinanceRateCorrection.create({
    data: {
      tenantId,
      loanId,
      contractRateId: rate.id,
      cause: `LEASE_FLOOR:${rate.id}`,
      amountCents,
      cumulativeAmountCents: amountCents,
      reason: "RATE_PAYOFF_CREDIT",
      contractualRows: {
        source: "lease_rental_floor",
        retainedResidualCents: view.residualCents,
        lessorRoundingCents: plan.lessorRoundingCents,
        lessorFundingDifferenceCents: plan.lessorFundingDifferenceCents,
        endingCapitalCents: plan.endingCapitalCents,
        priorFaceReconciliationCents,
        fundingAdjustments: plan.credits.map((credit) => ({
          periodNo: credit.index + 1,
          capitalCashAdjustmentCents: -credit.exclVatCents,
        })),
        periodAdjustments,
        taxDocuments: documents,
        path: input.path,
        fundingRows: plan.rows,
      } as unknown as Prisma.InputJsonValue,
    },
  })
  const finalRows = await tx.repaymentSchedule.findMany({
    where: { tenantId, loanId },
    orderBy: { installmentNo: "asc" },
  })
  const principal = finalRows.reduce((sum, row) => sum + row.principalDue, 0)
  const balances = recomputeLoanBalances(principal, finalRows, dueDateInstant(request.runDate))
  await tx.loan.update({
    where: { id: loanId, tenantId },
    data: {
      principal,
      totalRepayable: finalRows.reduce((sum, row) => sum + row.totalDue, 0),
      totalInterest: 0,
      outstandingPrincipal: balances.outstandingPrincipal,
      arrearsAmount: balances.arrearsAmount,
      daysInArrears: balances.daysInArrears,
      nextPaymentDate: nextPaymentDueDate(finalRows),
      interestRatePm: input.resultingRate.div(12).toNumber(),
    },
  })
  const firstChanged = finalRows[kept + 1]
  const recipients = await queueRepriceNotice(tx, {
    tenantId,
    loanId,
    contractRateId: rate.id,
    loanReference: input.loan.reference,
    entityId: input.loan.entityId,
    resultingRate: input.resultingRate.toString(),
    effectiveDate,
    firstChangedPaymentDate: sastCalendarDate(firstChanged.dueDate),
    oldInstalmentCents: stored[kept + 1].totalDue,
    newInstalmentCents: firstChanged.totalDue,
    totalInterestCents: 0,
    monthlyInterestCents: 0,
    historicalBalanceAdjustmentCents: amountCents,
    correctionPendingManual: amountCents !== 0,
    taxDocuments: documents,
  })
  await logAuditStrict(
    {
      tenantId,
      userId: request.actorUserId,
      action: AuditAction.LOAN_REPRICED,
      entity: "Loan",
      entityId: loanId,
      newValue: {
        source: "lease_rental_floor",
        contractRateId: rate.id,
        amountCents,
        pendingManualReconciliation: true,
        retainedResidualCents: view.residualCents,
        lessorRoundingCents: plan.lessorRoundingCents,
        lessorFundingDifferenceCents: plan.lessorFundingDifferenceCents,
        taxDocuments: documents,
        fundingRows: plan.rows,
      },
    },
    tx
  )
  await syncLoanCharges(tx, { tenantId, loanId }, dueDateInstant(request.runDate), {
    source: "lease_rental_floor",
    userId: request.actorUserId,
  })
  await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
  return {
    kind: "repriced",
    contractRateId: rate.id,
    resultingRate: input.resultingRate.toString(),
    oldInstalmentCents: stored[kept + 1].totalDue,
    newInstalmentCents: firstChanged.totalDue,
    rowsRepriced: stored.length - kept - 1,
    noticeRecipientClientIds: recipients,
  }
}
