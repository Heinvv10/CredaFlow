/**
 * Provider conflicts: a provider (webhook or status query) reports PAID,
 * RETURNED, PROCESSING or SUBMITTED for an attempt that is already FAILED or
 * CANCELLED. The state machine will not apply it, but it must not vanish
 * either: the report is recorded on the attempt, audited, shown as a review
 * item, and blocks any retry or reversal of the loan (code and database)
 * until a second LOAN_ADMIN — not the disburser, requester or approver —
 * resolves it: "not_paid" (the provider was wrong; the attempt stays as it
 * was) or "paid" (the money did go out: the attempt becomes PAID at the value
 * date given).
 */
import type { DisbursementPayout } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { Actor, PayoutDb } from "./dispatch"
import type { PayoutStatus } from "./state"
import type { ProviderPayoutState } from "./types"

/** Attempt states a later report may contradict. */
export const CONFLICTABLE: readonly PayoutStatus[] = ["FAILED", "CANCELLED"]

export async function recordProviderConflict(db: PayoutDb, args: {
  tenantId: string
  payout: Pick<DisbursementPayout, "id" | "status">
  state: ProviderPayoutState
  reason?: string
  source: string
  actor: Actor
}): Promise<boolean> {
  const now = new Date()
  const detail = `${args.source} reported ${args.state} after the attempt was ${args.payout.status}${args.reason ? `: ${args.reason}` : ""}`.slice(0, 500)
  return db.$transaction(async (tx) => {
    const moved = await tx.disbursementPayout.updateMany({
      where: { id: args.payout.id, tenantId: args.tenantId, status: { in: [...CONFLICTABLE] }, providerConflictAt: null },
      data: { providerConflictState: args.state, providerConflictAt: now, providerConflictDetail: detail },
    })
    if (moved.count !== 1) return false
    await logAuditStrict({
      tenantId: args.tenantId, userId: args.actor.id ?? undefined, userEmail: args.actor.email,
      action: AuditAction.PAYOUT_PROVIDER_CONFLICT, entity: "DisbursementPayout", entityId: args.payout.id,
      newValue: { status: args.payout.status, reported: args.state, source: args.source, detail },
    }, tx)
    return true
  })
}

export type ConflictOutcome = "not_paid" | "paid"

export async function resolveProviderConflict(db: PayoutDb, args: {
  tenantId: string
  payout: DisbursementPayout
  outcome: ConflictOutcome
  note: string
  paidAt: Date | null
  actor: Actor & { id: string }
}): Promise<{ ok: true; status: PayoutStatus } | { ok: false; status: number; error: string }> {
  const p = args.payout
  if (!p.providerConflictAt || p.conflictResolvedAt) return { ok: false, status: 409, error: "This payout has no provider report awaiting resolution" }
  if ([p.disbursedById, p.createdById, p.approvedById].includes(args.actor.id)) {
    await logAuditStrict({
      tenantId: args.tenantId, userId: args.actor.id, userEmail: args.actor.email,
      action: AuditAction.PAYOUT_ACTION_REFUSED, entity: "DisbursementPayout", entityId: p.id,
      newValue: { action: "resolve_conflict", reason: "maker_checker" },
    }, db)
    return { ok: false, status: 403, error: "Another LOAN_ADMIN must resolve this: you disbursed the loan, or requested or approved this attempt" }
  }
  if (args.outcome === "paid" && p.providerConflictState !== "PAID") {
    return { ok: false, status: 422, error: "The provider did not report this attempt paid" }
  }
  const now = new Date()
  const to: PayoutStatus = args.outcome === "paid" ? "PAID" : (p.status as PayoutStatus)
  return db.$transaction(async (tx) => {
    const moved = await tx.disbursementPayout.updateMany({
      where: { id: p.id, tenantId: args.tenantId, status: p.status, conflictResolvedAt: null },
      data: {
        conflictResolvedAt: now, conflictResolvedById: args.actor.id, conflictResolutionNote: args.note,
        ...(args.outcome === "paid" ? { status: "PAID", paidAt: args.paidAt ?? now, resolvedAt: now } : {}),
      },
    })
    if (moved.count !== 1) return { ok: false as const, status: 409, error: "The payout changed; refresh and try again" }
    await logAuditStrict({
      tenantId: args.tenantId, userId: args.actor.id, userEmail: args.actor.email,
      action: AuditAction.PAYOUT_PROVIDER_CONFLICT_RESOLVED, entity: "DisbursementPayout", entityId: p.id,
      oldValue: { status: p.status, reported: p.providerConflictState },
      newValue: { outcome: args.outcome, status: to, note: args.note, ...(args.outcome === "paid" ? { paidAt: (args.paidAt ?? now).toISOString() } : {}) },
    }, tx)
    return { ok: true as const, status: to }
  })
}
