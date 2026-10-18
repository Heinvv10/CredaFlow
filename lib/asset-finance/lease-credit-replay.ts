import { AuditAction, logAuditStrict } from "@/lib/audit"
import { allocateReceipts, recomputeLoanBalances, nextPaymentDueDate } from "@/lib/loan/balances"
import { restampSchedulePaidAt } from "@/lib/loan/schedule-paid-at"
import { syncLoanCharges } from "@/lib/loan/charges-sync"
import { scheduleRowStatus } from "@/lib/loan/schedule-status"
import type { SigningTx } from "./signing-prepare"

export const LEASE_SUPPLY_VAT_CREDIT = "lease_supply_vat_credit"
export const LEASE_CANCELLATION_CREDIT = "lease_cancellation_credit"

/**
 * Re-apply cash after a statutory cancellation, later charge assessment, or
 * supply-date VAT adjustment. VAT credits have a separate reconciliation reason.
 * No receipt disappears: a receipt's no-longer-allocated part is split into
 * the existing UNAPPLIED reconciliation/refund ledger, with its original
 * value date, method and parent. The same credit can fund the assessed charge.
 */
export async function replayLeaseCancellationCredit(tx: SigningTx, input: { tenantId: string; loanId: string; userId: string | null; reference: string; creditReason?: string; source?: string; reconcileStatus?: boolean }): Promise<void> {
  const { tenantId, loanId } = input
  const creditReason = input.creditReason ?? LEASE_CANCELLATION_CREDIT
  const source = input.source ?? "lease_cancellation_credit"
  const rows = await tx.repaymentSchedule.findMany({ where: { tenantId, loanId }, orderBy: { installmentNo: "asc" } })
  const receipts = await tx.payment.findMany({ where: { tenantId, loanId, reversed: false, OR: [{ allocationStatus: "ALLOCATED" }, { allocationStatus: "UNAPPLIED", reconciliationReason: creditReason }] }, orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }] })
  let left = rows.reduce((sum, r) => sum + r.totalDue, 0)
  let schedulePaid = 0
  const changes = []
  for (const receipt of receipts) {
    const charges = receipt.defaultInterestAllocated + receipt.chargeFeesAllocated
    const share = receipt.amount - charges
    const used = Math.min(left, share)
    left -= used
    schedulePaid += used
    const applied = used + charges
    const excess = receipt.amount - applied
    if (applied === 0) {
      if (receipt.allocationStatus === "ALLOCATED" && receipt.paymentMethod === "WAIVER") {
        await tx.payment.update({ where: { id: receipt.id, tenantId }, data: { reversed: true, reversedAt: new Date(), reversedById: input.userId, reversalReason: "Updated lease consideration removed the waived amount; no cash refund" } })
        changes.push({ paymentId: receipt.id, releasedWaiverCents: receipt.amount })
      } else if (receipt.allocationStatus === "ALLOCATED") {
        await tx.payment.update({ where: { id: receipt.id, tenantId }, data: { allocationStatus: "UNAPPLIED", reconciliationReason: creditReason } })
        changes.push({ paymentId: receipt.id, unappliedCents: receipt.amount })
      }
      continue
    }
    if (excess > 0) {
      await tx.payment.update({ where: { id: receipt.id, tenantId }, data: { amount: applied, allocationStatus: "ALLOCATED", reconciliationReason: null } })
      const credit = await tx.payment.create({ data: {
        tenantId, loanId, amount: excess, paymentMethod: receipt.paymentMethod, reference: receipt.reference,
        receivedAt: receipt.receivedAt, capturedBy: input.userId, allocationStatus: "UNAPPLIED", reconciliationReason: creditReason,
        ...(receipt.paymentMethod === "WAIVER" ? { reversed: true, reversedAt: new Date(), reversedById: input.userId, reversalReason: "Updated lease consideration removed the waived amount; no cash refund" } : {}),
        parentPaymentId: receipt.parentPaymentId ?? receipt.id, notes: `Lease consideration credit: ${input.reference}`,
      } })
      changes.push({ paymentId: receipt.id, previousAmountCents: receipt.amount, allocatedCents: applied, creditId: credit.id, unappliedCents: excess })
    } else if (receipt.allocationStatus === "UNAPPLIED") {
      await tx.payment.update({ where: { id: receipt.id, tenantId }, data: { allocationStatus: "ALLOCATED", reconciliationReason: null } })
      changes.push({ paymentId: receipt.id, allocatedCents: applied })
    }
  }
  const allocations = allocateReceipts(rows, schedulePaid)
  for (const [i, row] of rows.entries()) {
    if (row.totalPaid === allocations[i] && (!input.reconcileStatus || row.status === scheduleRowStatus(allocations[i], row.totalDue))) continue
    await tx.repaymentSchedule.update({ where: { id: row.id, tenantId }, data: { totalPaid: allocations[i], status: scheduleRowStatus(allocations[i], row.totalDue), paidAt: null } })
  }
  const loan = await tx.loan.findUniqueOrThrow({ where: { id: loanId, tenantId }, select: { principal: true } })
  const after = rows.map((r, i) => ({ ...r, totalPaid: allocations[i] }))
  const balances = recomputeLoanBalances(loan.principal, after, new Date())
  await tx.loan.update({ where: { id: loanId, tenantId }, data: { totalPaid: schedulePaid, outstandingPrincipal: balances.outstandingPrincipal, arrearsAmount: balances.arrearsAmount, daysInArrears: balances.daysInArrears, nextPaymentDate: nextPaymentDueDate(after) } })
  const synced = await syncLoanCharges(tx, { tenantId, loanId }, new Date(), { source, userId: input.userId }, { mode: "reversal" })
  if (!synced) await restampSchedulePaidAt(tx, { tenantId, loanId }, { source, userId: input.userId })
  if (!synced && input.reconcileStatus) {
    const current = await tx.loan.findUniqueOrThrow({ where: { id: loanId, tenantId }, select: { status: true, closedAt: true } })
    const settled = after.every(row => row.totalPaid >= row.totalDue)
    if (["ACTIVE", "COMPLETED", "DEFAULTED"].includes(current.status)) {
      const latest = settled ? await tx.payment.findFirst({ where: { tenantId, loanId, reversed: false, allocationStatus: "ALLOCATED" }, orderBy: [{ receivedAt: "desc" }], select: { receivedAt: true } }) : null
      const status = settled ? "COMPLETED" : current.status === "COMPLETED" ? "ACTIVE" : current.status
      const closedAt = settled ? latest?.receivedAt ?? current.closedAt ?? new Date() : null
      await tx.loan.update({ where: { id: loanId, tenantId }, data: { status, closedAt } })
      if (current.status !== status) await logAuditStrict({ tenantId, userId: input.userId ?? undefined, action: AuditAction.LOAN_STATUS_CHANGED, entity: "Loan", entityId: loanId, oldValue: { status: current.status }, newValue: { status, reason: source } }, tx)
    }
  }
  if (changes.length) await logAuditStrict({ tenantId, userId: input.userId ?? undefined, action: input.reconcileStatus ? AuditAction.LEASE_RENTAL_INVOICED : AuditAction.LEASE_EARLY_TERMINATION_ACCEPTED, entity: "Loan", entityId: loanId,
    newValue: { source, reference: input.reference, changes, schedulePaidCents: schedulePaid } }, tx)
}
