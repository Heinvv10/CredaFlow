import type { Prisma, ScheduleStatus } from "@prisma/client"
import type { prisma } from "@/lib/prisma"

// Writes a receipt's (or a reversal's) projected schedule: every receipt
// writer goes through here, so a re-priced row — an early settlement under
// s125 (lib/loan/s125-settlement.ts, lib/loan/settlement.ts) — is written whole:
// interest, fees, the premium inside the fees, the total and what is paid on it.
// ALL money is CENTS.

export interface WrittenRow {
  id: string
  interestDue: number
  feesDue: number
  creditLifePremiumDue?: number
  totalDue: number
  totalPaid: number
  status?: ScheduleStatus | string
  paidAt?: Date | null
}

type ScheduleTx = Pick<typeof prisma, "repaymentSchedule"> | Prisma.TransactionClient

export interface WriteScheduleOptions {
  tenantId: string
  /** the date a row this write completes is paid on */
  paidAt: Date
  /** keep the date a row was already paid on instead of `paidAt` */
  keepEarlierPaidAt?: boolean
  /** an unpaid row with nothing paid on it is PENDING (reversal, reconcile); otherwise PARTIAL */
  pendingWhenNothingPaid?: boolean
  /** write every row even if nothing about it changed */
  writeUnchanged?: boolean
}

const MONEY = ["interestDue", "feesDue", "creditLifePremiumDue", "totalDue", "totalPaid"] as const

/** Writes each row of `after` that differs from the same row of `before`. */
export async function writeReceiptSchedule(
  tx: ScheduleTx,
  before: WrittenRow[],
  after: WrittenRow[],
  options: WriteScheduleOptions,
): Promise<void> {
  for (const [i, row] of after.entries()) {
    const old = before[i]
    const isPaid = row.totalPaid >= row.totalDue
    const status: ScheduleStatus = isPaid
      ? "PAID"
      : options.pendingWhenNothingPaid && row.totalPaid <= 0 ? "PENDING" : "PARTIAL"
    const unchanged = MONEY.every((key) => (row[key] ?? 0) === (old[key] ?? 0))
      && (!options.pendingWhenNothingPaid || old.status === status)
    if (unchanged && !options.writeUnchanged) continue
    await (tx as Prisma.TransactionClient).repaymentSchedule.update({
      where: { id: row.id, tenantId: options.tenantId },
      data: {
        totalPaid: row.totalPaid,
        interestDue: row.interestDue,
        feesDue: row.feesDue,
        ...(row.creditLifePremiumDue === undefined ? {} : { creditLifePremiumDue: row.creditLifePremiumDue }),
        totalDue: row.totalDue,
        status,
        paidAt: isPaid ? (options.keepEarlierPaidAt ? old.paidAt ?? options.paidAt : options.paidAt) : null,
      },
    })
  }
}
