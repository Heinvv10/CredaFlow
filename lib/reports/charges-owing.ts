import type { LoanStatus } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { chargesLiveForTenant } from "@/lib/loan/charges-replay"
import { ARREARS_BANDS, arrearsBucket, type ArrearsBucketLabel } from "@/lib/reports/arrears-buckets"

/**
 * Default charges owing, shown BESIDE instalment arrears on the reports — never
 * inside them. Loan.arrearsAmount stays the regulatory, schedule-only figure.
 * The source is Loan.chargesOutstanding (current to the last sync: every
 * receipt and the 01:30 SAST sweep) and it counts only while charges are live
 * for the tenant, the same rule as arrearsWithCharges (lib/loan/charge-labels.ts).
 * ALL money is CENTS.
 */
export function chargesOwing(loan: { chargesOutstanding: number }, chargesLive: boolean): number {
  return chargesLive ? loan.chargesOutstanding : 0
}

export interface ChargesOwingByBand {
  byBand: Record<ArrearsBucketLabel, number>
  /** loans with no instalment arrears (0 DPD) that still owe charges */
  notInArrears: { count: number; amount: number }
  total: number
}

export function chargesOwingByBand(
  loans: Array<{ daysInArrears: number; chargesOutstanding: number }>,
  chargesLive: boolean,
): ChargesOwingByBand {
  const byBand = Object.fromEntries(ARREARS_BANDS.map((b) => [b.label, 0])) as Record<ArrearsBucketLabel, number>
  const notInArrears = { count: 0, amount: 0 }
  let total = 0
  for (const loan of loans) {
    const amount = chargesOwing(loan, chargesLive)
    if (amount <= 0) continue
    total += amount
    if (loan.daysInArrears > 0) {
      byBand[arrearsBucket(loan.daysInArrears)] += amount
    } else {
      notInArrears.count += 1
      notInArrears.amount += amount
    }
  }
  return { byBand, notInArrears, total }
}

/** Charges owing by DPD band over the given loan statuses, for one tenant. */
export async function loadChargesOwingByBand(
  db: Pick<typeof prisma, "loan" | "tenantConfig">,
  tenantId: string,
  statuses: LoanStatus[],
): Promise<ChargesOwingByBand & { chargesLive: boolean }> {
  const chargesLive = await chargesLiveForTenant(db, tenantId)
  const loans = chargesLive
    ? await db.loan.findMany({
        where: { tenantId, status: { in: statuses }, chargesOutstanding: { gt: 0 } },
        select: { daysInArrears: true, chargesOutstanding: true },
      })
    : []
  return { ...chargesOwingByBand(loans, chargesLive), chargesLive }
}
