/**
 * When money first reached a lease rental (slice 3, C4): its time of supply
 * when paid early. Receipts settle the oldest rows first, so the cash reached
 * rental n on the first SAST day by which the cash received (allocated,
 * unreversed, not a waiver, net of the default charges it paid) exceeded
 * everything due on the rows before it. The database checks the same rule
 * (guardLeaseRental, migration 20261014090000): any supply date from that day
 * to the due date is accepted; this gives the earliest, whatever order the
 * receipts were captured in (a back-dated receipt captured after a later one).
 * // UNTESTED: tax memo pending.
 */
import type { VatTransaction } from "@/lib/vat/db"
import { sastCalendarDate } from "@/lib/date/sast"
import { WAIVER_METHOD } from "@/lib/payments/waiver"

export type SupplyDateTx = Pick<VatTransaction, "repaymentSchedule" | "payment">

/** The SAST day the cash first reached the rental of `periodNo`, or null if it has not. */
export async function cashReachedOn(tx: SupplyDateTx, input: { tenantId: string; loanId: string; periodNo: number }): Promise<string | null> {
  const earlier = await tx.repaymentSchedule.aggregate({
    where: { tenantId: input.tenantId, loanId: input.loanId, installmentNo: { lt: input.periodNo } },
    _sum: { totalDue: true },
  })
  const earlierDue = earlier._sum.totalDue ?? 0
  const payments = await tx.payment.findMany({
    where: { tenantId: input.tenantId, loanId: input.loanId, reversed: false, allocationStatus: "ALLOCATED", paymentMethod: { not: WAIVER_METHOD } },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    select: { amount: true, defaultInterestAllocated: true, chargeFeesAllocated: true, receivedAt: true },
  })
  let cash = 0
  for (const p of payments) {
    cash += p.amount - p.defaultInterestAllocated - p.chargeFeesAllocated
    if (cash > earlierDue) return sastCalendarDate(p.receivedAt)
  }
  return null
}
