/**
 * Provider reports the system did not apply, kept for staff (PR #89 round 3):
 * stale ones (SUBMITTED/PROCESSING on an attempt already over, or a state a
 * settled attempt cannot take), dropped ones (weaker than the open conflict,
 * or the money is already a recovery case) and ones the database refused
 * (lib/payouts/conflicts.ts). Each is a PayoutUnappliedReport row, written
 * with its audit row, and stays on the outstanding-payouts queue — however
 * old — until a LOAN_ADMIN acknowledges it, once, with a note (audited; the
 * database guards both). Not anyone who acted on that attempt (actedOnPayout;
 * the guard computes the same list from the rows).
 * Acknowledging clears the list entry only: a conflict on the attempt still
 * blocks retry, reversal and send until it is resolved (lib/payouts/
 * conflicts.ts). Exact duplicates are not kept: they repeat an event already
 * handled.
 */
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { prisma } from "@/lib/prisma"
import type { Actor } from "./dispatch"
import { raceRefusal } from "./loan-lock"

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
export type UnappliedOutcome = "stale" | "dropped" | "rejected"

export interface UnappliedReport {
  id: string
  payoutId: string
  at: Date
  reported: string
  outcome: UnappliedOutcome
  reason: string | null
}

export async function recordUnapplied(tx: Pick<Tx, "payoutUnappliedReport">, args: {
  tenantId: string
  payoutId: string
  reported: string
  outcome: UnappliedOutcome
  reason: string | null
  eventId: string | null
  source: string
}): Promise<void> {
  await tx.payoutUnappliedReport.create({
    data: {
      tenantId: args.tenantId, payoutId: args.payoutId, reported: args.reported, outcome: args.outcome,
      reason: args.reason?.slice(0, 500) ?? null, eventId: args.eventId, source: args.source,
    },
  })
}

/** Unacknowledged reports of the tenant, newest first, a page at a time, with the true total. */
export async function loadUnappliedReports(db: Pick<typeof prisma, "payoutUnappliedReport">, tenantId: string, page: { page: number; pageSize: number }): Promise<{ total: number; items: UnappliedReport[] }> {
  const where = { tenantId, acknowledgedAt: null }
  const size = Math.min(Math.max(Math.floor(page.pageSize), 1), 500)
  const skip = (Math.max(Math.floor(page.page), 1) - 1) * size
  const [total, rows] = await Promise.all([
    db.payoutUnappliedReport.count({ where }),
    db.payoutUnappliedReport.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip, take: size }),
  ])
  return {
    total,
    items: rows.map((r) => ({ id: r.id, payoutId: r.payoutId, at: r.createdAt, reported: r.reported, outcome: r.outcome as UnappliedOutcome, reason: r.reason })),
  }
}

/**
 * Everyone who acted on a payout attempt, from the rows (guardPayoutUnappliedReport
 * computes the same list): the disburser, its creator and requester, its
 * approver, whoever confirmed it paid, failed or returned, every resolver of
 * a conflict on it (earlier ones from the audit trail: a reopen clears the
 * column), and the recovery case's opener and escalator.
 */
export async function actedOnPayout(db: Pick<typeof prisma, "disbursementPayout" | "auditLog">, tenantId: string, payoutId: string): Promise<Set<string>> {
  const [p, resolvers] = await Promise.all([
    db.disbursementPayout.findFirst({
      where: { id: payoutId, tenantId },
      select: {
        disbursedById: true, createdById: true, requestedById: true, approvedById: true, resolvedById: true, returnedById: true,
        conflictResolvedById: true, recoveryCase: { select: { openedById: true, escalatedById: true } },
      },
    }),
    db.auditLog.findMany({ where: { entity: "DisbursementPayout", entityId: payoutId, action: AuditAction.PAYOUT_PROVIDER_CONFLICT_RESOLVED }, select: { userId: true } }),
  ])
  const ids = [
    p?.disbursedById, p?.createdById, p?.requestedById, p?.approvedById, p?.resolvedById, p?.returnedById, p?.conflictResolvedById,
    p?.recoveryCase?.openedById, p?.recoveryCase?.escalatedById, ...resolvers.map((r) => r.userId),
  ]
  return new Set(ids.filter((id): id is string => Boolean(id)))
}

export async function acknowledgeUnappliedReport(db: Pick<typeof prisma, "payoutUnappliedReport" | "disbursementPayout" | "auditLog" | "$transaction">, args: {
  tenantId: string
  id: string
  note: string
  actor: Actor & { id: string }
}): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const entry = await db.payoutUnappliedReport.findFirst({ where: { id: args.id, tenantId: args.tenantId } })
  if (!entry) return { ok: false, status: 404, error: "Report not found" }
  if (entry.acknowledgedAt) return { ok: false, status: 409, error: "This report is already acknowledged" }
  if ((await actedOnPayout(db, args.tenantId, entry.payoutId)).has(args.actor.id)) {
    await logAuditStrict({
      tenantId: args.tenantId, userId: args.actor.id, userEmail: args.actor.email,
      action: AuditAction.PAYOUT_ACTION_REFUSED, entity: "PayoutUnappliedReport", entityId: entry.id,
      newValue: { action: "acknowledge_report", reason: "maker_checker", payoutId: entry.payoutId },
    }, db)
    return { ok: false, status: 403, error: "Another LOAN_ADMIN must acknowledge this: you acted on this payout (disbursed, requested, approved, confirmed, resolved or recovered it)" }
  }
  try {
    return await db.$transaction(async (tx) => {
      const moved = await tx.payoutUnappliedReport.updateMany({
        where: { id: entry.id, tenantId: args.tenantId, acknowledgedAt: null },
        data: { acknowledgedAt: new Date(), acknowledgedById: args.actor.id, acknowledgementNote: args.note },
      })
      if (moved.count !== 1) return { ok: false as const, status: 409, error: "This report is already acknowledged" }
      await logAuditStrict({
        tenantId: args.tenantId, userId: args.actor.id, userEmail: args.actor.email,
        action: AuditAction.PAYOUT_PROVIDER_REPORT_ACKNOWLEDGED, entity: "PayoutUnappliedReport", entityId: entry.id,
        newValue: { payoutId: entry.payoutId, reported: entry.reported, outcome: entry.outcome, reason: entry.reason, note: args.note },
      }, tx)
      return { ok: true as const }
    })
  } catch (error) {
    const refusal = raceRefusal(error)
    if (refusal) return refusal
    throw error
  }
}
