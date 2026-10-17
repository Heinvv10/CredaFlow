import { AuditAction, logAuditStrict } from "@/lib/audit"
import { allocateReceipts } from "@/lib/loan/balances"
import { dbDate } from "./dates"
import { dueDateInstant } from "./schedule-records"
import { queueRepriceNotice } from "./reprice-notice"
import { assetRateRepriceBaseline } from "./reprice-baseline"
import { ratePayoffPlan } from "./reprice-payoff"
import type { RepriceTx, RepriceRequest, RepriceOutcome } from "./reprice-loan"
import type { StoredScheduleRow } from "./stored-schedule"
import type { RatePoint } from "./types"
import type { Prisma } from "@prisma/client"

export const RATE_PAYOFF_CREDIT = "asset_rate_payoff_credit"
/** Conserve every cent and value date while classifying no-longer-owed cash
 * as refund due. The UNAPPLIED child is money held, never a bank refund. */
async function releasePayoffCash(tx: RepriceTx, tenantId: string, loanId: string, contractRateId: string, amountDue: number) {
  const receipts = await tx.payment.findMany({ where: { tenantId, loanId, reversed: false, allocationStatus: "ALLOCATED" }, orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }] })
  let left = amountDue
  const changes = []
  let refundCashCents = 0
  for (const receipt of receipts) {
    const charges = receipt.defaultInterestAllocated + receipt.chargeFeesAllocated
    const used = Math.min(left, receipt.amount - charges)
    left -= used
    const excess = receipt.amount - charges - used
    if (excess <= 0) continue
    const waiver = receipt.paymentMethod === "WAIVER"
    if (!waiver) refundCashCents += excess
    const creditData = { allocationStatus: "UNAPPLIED" as const, reconciliationReason: RATE_PAYOFF_CREDIT, reconciliationReference: contractRateId }
    if (used + charges === 0) {
      await tx.payment.update({ where: { id: receipt.id, tenantId, loanId }, data: waiver ? { reversed: true, reversedAt: new Date(), reversalReason: "Rate payoff removed the waived balance; no cash refund" } : creditData })
      changes.push({ paymentId: receipt.id, heldCreditCents: receipt.amount })
    } else {
      await tx.payment.update({ where: { id: receipt.id, tenantId, loanId }, data: { amount: used + charges } })
      const credit = await tx.payment.create({ data: { ...creditData, tenantId, loanId, amount: excess, parentPaymentId: receipt.parentPaymentId ?? receipt.id,
        ...(waiver ? { reversed: true, reversedAt: new Date(), reversalReason: "Rate payoff removed the waived balance; no cash refund" } : {}),
        paymentMethod: receipt.paymentMethod, reference: receipt.reference, receivedAt: receipt.receivedAt, capturedBy: receipt.capturedBy, notes: "Rate correction: cash held pending refund execution" } })
      changes.push({ paymentId: receipt.id, originalAmountCents: receipt.amount, allocatedAmountCents: used + charges, creditId: credit.id, heldCreditCents: excess })
    }
  }
  if (left !== 0) throw new Error("Historical rate payoff is not covered by actual recorded cash")
  return { changes, refundCashCents }
}

export async function writeRatePayoff(tx: RepriceTx, input: {
  request: RepriceRequest; loan: { reference: string; entityId: string | null; ncaRegime: string | null; application: { pasqEvidence: Prisma.JsonValue | null } };
  rows: StoredScheduleRow[]; plan: ReturnType<typeof ratePayoffPlan>; resultingRate: Prisma.Decimal; margin: Prisma.Decimal; oldInstalmentCents: number; path: RatePoint[];
}): Promise<RepriceOutcome> {
  const { request, plan, loan } = input
  const { tenantId, loanId, effectiveDate } = request
  const rate = await tx.contractRate.create({ data: { tenantId, loanId, effectiveDate: dbDate(effectiveDate), basis: request.basis, margin: input.margin, resultingRate: input.resultingRate, newInstalmentCents: 0, createdById: request.actorUserId } })
  const released = await releasePayoffCash(tx, tenantId, loanId, rate.id, plan.amountDue)
  const cashChanges = released.changes
  const refundCents = released.refundCashCents
  const allocated = allocateReceipts(plan.rows, plan.amountDue)
  for (const [i, row] of plan.rows.entries()) await tx.repaymentSchedule.update({ where: { id: row.id, tenantId, loanId }, data: { principalDue: row.principalDue, interestDue: row.interestDue, feesDue: row.feesDue, creditLifePremiumDue: row.creditLifePremiumDue,
    totalDue: row.totalDue, totalPaid: allocated[i], status: "PAID", assetFinanceOpeningBalanceCents: row.assetFinanceOpeningBalanceCents, commonLawContractualInterestDue: null } })
  const interest = plan.rows.reduce((sum,row) => sum + row.interestDue,0)
  const principal = plan.rows.reduce((sum,row) => sum + row.principalDue,0)
  await tx.loan.update({ where: { id: loanId, tenantId }, data: { principal, outstandingPrincipal: 0, totalInterest: interest, totalRepayable: plan.amountDue, totalPaid: plan.amountDue, contractualTotalInterest: interest, contractualTotalRepayable: plan.amountDue,
    interestRatePm: input.resultingRate.div(12).toNumber(), status: "COMPLETED", closedAt: dueDateInstant(plan.payoffDate), arrearsAmount: 0, daysInArrears: 0, nextPaymentDate: null } })
  const oldLedger = await tx.assetFinanceRateCorrection.aggregate({ where: { tenantId, loanId }, _sum: { amountCents: true } })
  await tx.assetFinanceRateCorrection.create({ data: { tenantId, loanId, contractRateId: rate.id, cause: `PAYOFF:${rate.id}`, amountCents: -refundCents - (oldLedger._sum.amountCents ?? 0), cumulativeAmountCents: -refundCents, reason: "RATE_PAYOFF_CREDIT",
    contractualRows: { originalRows: input.rows, payoffDate: plan.payoffDate, path: input.path, cashChanges } as unknown as Prisma.InputJsonValue } })
  const baseline = loan.ncaRegime === "NCA" ? assetRateRepriceBaseline({ original: loan.application.pasqEvidence, contractRateId: rate.id, annualRate: input.resultingRate.toString(), effectiveDate, recurringPaymentCents: 0, rows: plan.rows.map((row) => ({ ...row, assetFinanceOpeningBalanceCents: row.assetFinanceOpeningBalanceCents ?? 0 })), payoff: { date: plan.payoffDate, refundDueCents: refundCents } }) : null
  const recipients = await queueRepriceNotice(tx, { tenantId, loanId, entityId: loan.entityId, loanReference: loan.reference, contractRateId: rate.id, resultingRate: input.resultingRate.toString(), effectiveDate, firstChangedPaymentDate: request.runDate, oldInstalmentCents: input.oldInstalmentCents, newInstalmentCents: 0, totalInterestCents: interest, monthlyInterestCents: 0, correctionPendingManual: true, historicalBalanceAdjustmentCents: -refundCents })
  await logAuditStrict({ tenantId, userId: request.actorUserId, action: AuditAction.LOAN_REPRICED, entity: "Loan", entityId: loanId, newValue: { contractRateId: rate.id, effectiveDate, ratePayoff: true, payoffDate: plan.payoffDate, refundDueCents: refundCents, cashChanges, ...(baseline ? { assetRateRepriceEvidence: baseline } : {}) } }, tx)
  await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
  return { kind: "repriced", contractRateId: rate.id, resultingRate: input.resultingRate.toString(), oldInstalmentCents: input.oldInstalmentCents, newInstalmentCents: 0, rowsRepriced: plan.rows.length, noticeRecipientClientIds: recipients }
}
