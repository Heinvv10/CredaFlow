import type { Prisma } from "@prisma/client"

/**
 * What a reminder is about, and the one definition of "there is nothing to remind
 * about": used by the reminders cron to skip a send, and by the messaging retry
 * sweep to drop a queued reminder the borrower has since paid
 * (lib/collections/client-holds.ts, `loanDunningHold`).
 */

// Structural, so a transaction client of the tenant-scoped extension fits too.
export interface InstalmentDb {
  repaymentSchedule: { findFirst: (args: Prisma.RepaymentScheduleFindFirstArgs) => PromiseLike<unknown> }
}

/**
 * What is left of the first unpaid instalment, in cents. `totalDue > 0` skips an
 * asset-finance skip period's R0.00 row, which stays PENDING for good
 * (lib/asset-finance/schedule-records.ts); a consumer row is never zero. PARTIAL
 * is unpaid too: leaving it out quoted "R 0.00" to borrowers whose unpaid rows a
 * writer had stored PARTIAL.
 */
export async function nextInstalmentOwed(db: InstalmentDb, ref: { tenantId: string; loanId: string }): Promise<number> {
  const row = await db.repaymentSchedule.findFirst({
    where: { loanId: ref.loanId, tenantId: ref.tenantId, status: { in: ["PENDING", "PARTIAL", "OVERDUE"] }, totalDue: { gt: 0 } },
    orderBy: { dueDate: "asc" },
    select: { totalDue: true, totalPaid: true },
  }) as { totalDue: number; totalPaid: number } | null
  return row ? Math.max(0, row.totalDue - row.totalPaid) : 0
}

/**
 * Never tell a borrower they owe R 0.00: nothing unpaid on the schedule and no
 * default charges, or an overdue reminder on a loan with no arrears and no charges,
 * is no reminder at all. `overdue` is a reminder for a missed payment (a negative
 * `daysUntilDue`), as opposed to one before a payment is due.
 */
export function nothingOwed(o: { paymentAmount: number; charges: number; arrearsAmount: number; overdue: boolean }): boolean {
  return o.paymentAmount + o.charges <= 0 || (o.overdue && o.arrearsAmount + o.charges <= 0)
}
