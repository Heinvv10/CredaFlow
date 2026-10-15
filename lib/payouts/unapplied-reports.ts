/**
 * Provider reports the system did not apply, for the outstanding-payouts
 * queue: stale ones (SUBMITTED/PROCESSING on an attempt already over, or a
 * state a settled attempt cannot take), dropped ones (weaker than the open
 * conflict, or the money is already a recovery case) and ones the database
 * refused (lib/payouts/conflicts.ts). Exact duplicates are not listed: they
 * repeat an event already handled.
 */
import type { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"

export interface UnappliedReport {
  auditId: string
  payoutId: string
  at: Date
  reported: string
  outcome: "stale" | "dropped" | "rejected"
  reason: string | null
}

export async function loadUnappliedReports(db: Pick<typeof prisma, "auditLog">, tenantId: string, since = new Date(Date.now() - 30 * 86_400_000)): Promise<UnappliedReport[]> {
  const rows = await db.auditLog.findMany({
    where: {
      tenantId, entity: "DisbursementPayout", createdAt: { gte: since },
      OR: [
        { action: { in: [AuditAction.PAYOUT_PROVIDER_REPORT_IGNORED, AuditAction.PAYOUT_PROVIDER_REPORT_REJECTED] } },
        { action: AuditAction.PAYOUT_PROVIDER_CONFLICT, newValue: { path: ["outcome"], equals: "dropped" } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, action: true, entityId: true, createdAt: true, newValue: true },
  })
  return rows.map((r) => {
    const v = (r.newValue ?? {}) as { reported?: string; reason?: string }
    const outcome = r.action === AuditAction.PAYOUT_PROVIDER_REPORT_REJECTED ? "rejected" : r.action === AuditAction.PAYOUT_PROVIDER_REPORT_IGNORED ? "stale" : "dropped"
    return { auditId: r.id, payoutId: r.entityId ?? "", at: r.createdAt, reported: v.reported ?? "", outcome, reason: v.reason ?? null }
  })
}
