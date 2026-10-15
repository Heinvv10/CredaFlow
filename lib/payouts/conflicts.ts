/**
 * Provider conflicts: a provider (webhook or status query) reports money
 * moving — PAID or RETURNED — for an attempt that is already FAILED or
 * CANCELLED. The state machine will not apply it, but it must not vanish
 * either: the report is recorded on the attempt, audited, shown as a review
 * item, and blocks any retry, reversal or send on the loan (code and
 * database) until a second LOAN_ADMIN — not the disburser, requester or
 * approver — resolves it: "not_paid" (the provider was wrong; the attempt
 * stays as it was) or "paid" (the money did go out: the attempt becomes PAID
 * at the value date given). On a loan whose disbursement was already reversed
 * (CANCELLED) "paid" is refused, here and in the database: the loan is not
 * reinstated, and the money that went out is "recovery" — a
 * PayoutRecoveryCase (lib/payouts/recovery.ts) opened at the value date given.
 *
 * Every report on an attempt already over is audited, with what became of it
 * (breaker re-attack, PR #89 round 3):
 *  - "stale": SUBMITTED/PROCESSING says nothing about money; never stored, so
 *    it cannot mask a later PAID (PAYOUT_PROVIDER_REPORT_IGNORED);
 *  - "recorded": the first PAID/RETURNED;
 *  - "strengthened": a stronger report (PAID > RETURNED) replaces an
 *    unresolved one;
 *  - "reopened": a PAID/RETURNED after the conflict was resolved not paid
 *    clears the resolution and blocks again;
 *  - "dropped": weaker than the unresolved report, the attempt is no longer
 *    over, or the money is already a recovery case.
 */
import type { DisbursementPayout } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { Actor, PayoutDb } from "./dispatch"
import { lockLoanForPayout, raceRefusal } from "./loan-lock"
import { openRecoveryCase } from "./recovery"
import type { PayoutStatus } from "./state"
import type { ProviderPayoutState } from "./types"

/** Attempt states a later report may contradict. */
export const CONFLICTABLE: readonly PayoutStatus[] = ["FAILED", "CANCELLED"]

export type ReportOutcome = "stale" | "recorded" | "strengthened" | "reopened" | "dropped"

const STRENGTH: Partial<Record<string, number>> = { PAID: 4, RETURNED: 3, PROCESSING: 2, SUBMITTED: 1 }
const strength = (state: string | null) => (state ? STRENGTH[state] ?? 0 : 0)

export async function recordProviderConflict(db: PayoutDb, args: {
  tenantId: string
  payout: Pick<DisbursementPayout, "id" | "status">
  state: ProviderPayoutState
  reason?: string
  source: string
  actor: Actor
}): Promise<ReportOutcome> {
  const now = new Date()
  const detail = `${args.source} reported ${args.state} after the attempt was ${args.payout.status}${args.reason ? `: ${args.reason}` : ""}`.slice(0, 500)
  const audit = (tx: Parameters<Parameters<PayoutDb["$transaction"]>[0]>[0], outcome: ReportOutcome, extra: Record<string, unknown> = {}) => logAuditStrict({
    tenantId: args.tenantId, userId: args.actor.id ?? undefined, userEmail: args.actor.email,
    action: outcome === "stale" ? AuditAction.PAYOUT_PROVIDER_REPORT_IGNORED : AuditAction.PAYOUT_PROVIDER_CONFLICT,
    entity: "DisbursementPayout", entityId: args.payout.id,
    newValue: { status: args.payout.status, reported: args.state, source: args.source, detail, outcome, ...extra },
  }, tx)
  return db.$transaction(async (tx) => {
    if (args.state !== "PAID" && args.state !== "RETURNED") {
      await audit(tx, "stale")
      return "stale"
    }
    // The loan lock first, like a retry approval or a claim to send.
    const owner = await tx.disbursementPayout.findFirst({ where: { id: args.payout.id, tenantId: args.tenantId }, select: { loanId: true } })
    if (owner) await lockLoanForPayout(tx, args.tenantId, owner.loanId)
    const row = await tx.disbursementPayout.findFirst({
      where: { id: args.payout.id, tenantId: args.tenantId },
      select: { status: true, providerConflictState: true, providerConflictAt: true, conflictResolvedAt: true, recoveryCase: { select: { id: true } } },
    })
    let outcome: ReportOutcome = "dropped"
    let data: Record<string, unknown> | null = null
    if (row && CONFLICTABLE.includes(row.status as PayoutStatus)) {
      const reported = { providerConflictState: args.state, providerConflictAt: now, providerConflictDetail: detail }
      if (!row.providerConflictAt) [outcome, data] = ["recorded", reported]
      else if (!row.conflictResolvedAt) {
        if (strength(args.state) > strength(row.providerConflictState)) [outcome, data] = ["strengthened", reported]
      } else if (!row.recoveryCase) {
        [outcome, data] = ["reopened", { ...reported, conflictResolvedAt: null, conflictResolvedById: null, conflictResolutionNote: null }]
      }
    }
    if (data && row) {
      const moved = await tx.disbursementPayout.updateMany({
        where: { id: args.payout.id, tenantId: args.tenantId, status: row.status, providerConflictAt: row.providerConflictAt, conflictResolvedAt: row.conflictResolvedAt },
        data,
      })
      if (moved.count !== 1) outcome = "dropped"
    }
    await audit(tx, outcome, { previous: row?.providerConflictState ?? null, previouslyResolved: Boolean(row?.conflictResolvedAt) })
    return outcome
  })
}

export type ConflictOutcome = "not_paid" | "paid" | "recovery"

const REVERSED_PAID = "This loan's disbursement was reversed, so the attempt is not resolved as paid and the loan is not reinstated: open a recovery case for the money instead"
const NOT_REVERSED = "A recovery case is for money paid out on a reversed loan; this loan was not reversed"

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
  if (args.outcome !== "not_paid" && p.providerConflictState !== "PAID") {
    return { ok: false, status: 422, error: "The provider did not report this attempt paid" }
  }
  const loan = await db.loan.findFirst({ where: { id: p.loanId, tenantId: args.tenantId }, select: { status: true } })
  if (args.outcome === "paid" && loan?.status === "CANCELLED") return { ok: false, status: 409, error: REVERSED_PAID }
  if (args.outcome === "recovery" && loan?.status !== "CANCELLED") return { ok: false, status: 409, error: NOT_REVERSED }
  if (args.outcome === "paid") {
    const other = await db.disbursementPayout.findFirst({
      where: { tenantId: args.tenantId, applicationId: p.applicationId, id: { not: p.id }, status: { notIn: ["FAILED", "RETURNED", "CANCELLED"] } },
      select: { attempt: true, status: true },
    })
    if (other) {
      return { ok: false, status: 409, error: `Attempt ${other.attempt} is ${other.status}: if this one paid too, another attempt sent the money twice; recover it (returned) before resolving this as paid` }
    }
  }
  const now = new Date()
  const to: PayoutStatus = args.outcome === "paid" ? "PAID" : (p.status as PayoutStatus)
  try {
  return await db.$transaction(async (tx) => {
    const locked = await lockLoanForPayout(tx, args.tenantId, p.loanId)
    // Re-read under the lock: a reversal approved meanwhile changes the answer.
    if (args.outcome === "paid" && locked?.status === "CANCELLED") return { ok: false as const, status: 409, error: REVERSED_PAID }
    if (args.outcome === "recovery" && locked?.status !== "CANCELLED") return { ok: false as const, status: 409, error: NOT_REVERSED }
    const moved = await tx.disbursementPayout.updateMany({
      where: { id: p.id, tenantId: args.tenantId, status: p.status, conflictResolvedAt: null },
      data: {
        conflictResolvedAt: now, conflictResolvedById: args.actor.id, conflictResolutionNote: args.note,
        ...(args.outcome === "paid" ? { status: "PAID", paidAt: args.paidAt ?? now, resolvedAt: now } : {}),
      },
    })
    if (moved.count !== 1) return { ok: false as const, status: 409, error: "The payout changed; refresh and try again" }
    const recovery = args.outcome === "recovery"
      ? await openRecoveryCase(tx, { tenantId: args.tenantId, payout: p, paidAt: args.paidAt ?? p.providerConflictAt ?? now, note: args.note, actor: args.actor })
      : null
    await logAuditStrict({
      tenantId: args.tenantId, userId: args.actor.id, userEmail: args.actor.email,
      action: AuditAction.PAYOUT_PROVIDER_CONFLICT_RESOLVED, entity: "DisbursementPayout", entityId: p.id,
      oldValue: { status: p.status, reported: p.providerConflictState },
      newValue: { outcome: args.outcome, status: to, note: args.note, ...(args.outcome === "paid" ? { paidAt: (args.paidAt ?? now).toISOString() } : {}), ...(recovery ? { recoveryCaseId: recovery.id } : {}) },
    }, tx)
    return { ok: true as const, status: to }
  })
  } catch (error) {
    const refusal = raceRefusal(error)
    if (refusal) return { ...refusal, error: `Another attempt of this payout is paid or in flight. ${refusal.error}` }
    throw error
  }
}
