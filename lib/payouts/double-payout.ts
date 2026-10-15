/**
 * A possible double payout: a provider reports money moving (an unresolved
 * conflict, lib/payouts/conflicts.ts) on an earlier attempt that was over,
 * while a later attempt of the same application is live — paid or still in
 * flight. If both stand the borrower was paid twice. Listed on the
 * outstanding-payouts queue (app/(dashboard)/disbursements/payouts/page.tsx).
 */
import type { prisma } from "@/lib/prisma"

export interface DoublePayoutRisk {
  payoutId: string
  loanId: string
  reference: string
  attempt: number
  reported: string
  liveAttempt: number
  liveStatus: string
}

const OVER = ["FAILED", "RETURNED", "CANCELLED"] as const

export async function loadDoublePayoutRisks(db: Pick<typeof prisma, "disbursementPayout">, tenantId: string): Promise<DoublePayoutRisk[]> {
  const conflicted = await db.disbursementPayout.findMany({
    where: { tenantId, providerConflictAt: { not: null }, conflictResolvedAt: null },
    select: { id: true, loanId: true, applicationId: true, attempt: true, providerConflictState: true, loan: { select: { reference: true } } },
  })
  if (conflicted.length === 0) return []
  const live = await db.disbursementPayout.findMany({
    where: { tenantId, applicationId: { in: [...new Set(conflicted.map((c) => c.applicationId))] }, status: { notIn: [...OVER] } },
    select: { applicationId: true, attempt: true, status: true },
  })
  return conflicted.flatMap((c) => live
    .filter((l) => l.applicationId === c.applicationId && l.attempt > c.attempt)
    .map((l) => ({
      payoutId: c.id, loanId: c.loanId, reference: c.loan.reference, attempt: c.attempt,
      reported: c.providerConflictState ?? "", liveAttempt: l.attempt, liveStatus: l.status,
    })))
}
