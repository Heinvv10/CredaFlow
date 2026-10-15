/**
 * Reversing a disbursement whose money definitively never reached the
 * borrower (PR #89 round 1): every payout attempt FAILED, was RETURNED or was
 * CANCELLED, and no receipt on the loan is live.
 *
 * Maker-checker: one LOAN_ADMIN requests with a reason, a second — not the
 * requester, not the disburser — approves or rejects. Approval cancels the
 * loan: status CANCELLED, nothing owed (no balance, arrears or charges), so it
 * leaves the collectible book (lib/loan/collectible-book.ts) and every sweep
 * that reads it; the schedule-row sweeps skip CANCELLED loans explicitly.
 * The accounting export then reverses everything the loan had posted
 * (lib/accounting/sources.ts). The database re-checks the conditions on
 * approval (guardDisbursementReversal).
 */
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { prisma } from "@/lib/prisma"
import { lockLoanForPayout, raceRefusal } from "./loan-lock"
import { applyReversalEffects } from "./reversal-effects"
import { railRefusal } from "./reversal-rail"
import { isOver, type PayoutStatus } from "./state"

export type ReversalDb = Pick<typeof prisma, "disbursementPayout" | "disbursementReversal" | "loan" | "payment" | "auditLog" | "bureauSubmissionRecord" | "tenantConfig" | "$transaction">
type Reader = Pick<typeof prisma, "disbursementPayout" | "loan" | "payment">

export type ReversalResult =
  | { ok: true; reversalId: string; status: "REQUESTED" | "APPROVED" | "REJECTED"; bureauCancellationRequired: boolean }
  | { ok: false; status: number; error: string }

const actorOf = (a: { id: string; email: string }) => ({ userId: a.id, userEmail: a.email })

/** Why this loan's disbursement cannot be reversed now, or null. */
async function reversalBlocker(db: Reader, tenantId: string, loanId: string): Promise<string | null> {
  const loan = await db.loan.findFirst({ where: { id: loanId, tenantId }, select: { status: true } })
  if (!loan) return "Loan not found"
  if (loan.status !== "ACTIVE" && loan.status !== "DEFAULTED") return "Only an active loan's disbursement can be reversed"
  const attempts = await db.disbursementPayout.findMany({ where: { tenantId, loanId }, select: { status: true } })
  if (attempts.length === 0) return "This loan was not paid out through the payout channel; there is no payout to reverse"
  if (attempts.some((a) => !isOver(a.status as PayoutStatus))) return "A payout attempt is paid or still in progress; the money may have reached the borrower"
  const conflict = await db.disbursementPayout.count({ where: { tenantId, loanId, providerConflictAt: { not: null }, conflictResolvedAt: null } })
  if (conflict > 0) return "A provider reported money moving on an attempt already over; resolve that first"
  const live = await db.payment.count({ where: { tenantId, loanId, reversed: false } })
  if (live > 0) return "The loan has a live receipt; reverse it first"
  return null
}

export async function requestDisbursementReversal(db: ReversalDb, args: {
  tenantId: string
  loanId: string
  reason: string
  actor: { id: string; email: string }
}): Promise<ReversalResult> {
  const blocker = await reversalBlocker(db, args.tenantId, args.loanId)
  if (blocker) return { ok: false, status: blocker === "Loan not found" ? 404 : 409, error: blocker }
  const open = await db.disbursementReversal.findFirst({ where: { tenantId: args.tenantId, loanId: args.loanId, status: { not: "REJECTED" } }, select: { id: true } })
  if (open) return { ok: false, status: 409, error: "A reversal of this disbursement is already requested" }
  // A loan the bureau already knows needs a cancellation (V) record by hand.
  const bureauKnown = (await db.bureauSubmissionRecord.count({ where: { tenantId: args.tenantId, loanId: args.loanId, mode: "LIVE", heldReason: null } })) > 0
  try {
    return await db.$transaction(async (tx) => {
    // The loan lock first (lib/payouts/loan-lock.ts), then re-check under it.
    await lockLoanForPayout(tx, args.tenantId, args.loanId)
    const late = await reversalBlocker(tx, args.tenantId, args.loanId)
    if (late) return { ok: false as const, status: 409, error: late }
    const created = await tx.disbursementReversal.create({
      data: { tenantId: args.tenantId, loanId: args.loanId, reason: args.reason, requestedById: args.actor.id },
      select: { id: true },
    })
    await logAuditStrict({
      tenantId: args.tenantId, ...actorOf(args.actor), action: AuditAction.DISBURSEMENT_REVERSAL_REQUESTED,
      entity: "DisbursementReversal", entityId: created.id, newValue: { loanId: args.loanId, reason: args.reason, bureauCancellationRequired: bureauKnown },
    }, tx)
    return { ok: true as const, reversalId: created.id, status: "REQUESTED" as const, bureauCancellationRequired: bureauKnown }
    })
  } catch (error) {
    const refusal = raceRefusal(error)
    if (refusal) return refusal
    throw error
  }
}

export async function decideDisbursementReversal(db: ReversalDb, args: {
  tenantId: string
  reversalId: string
  approve: boolean
  note: string
  actor: { id: string; email: string }
}): Promise<ReversalResult> {
  const r = await db.disbursementReversal.findFirst({ where: { id: args.reversalId, tenantId: args.tenantId } })
  if (!r || r.status !== "REQUESTED") return { ok: false, status: 409, error: "No reversal request is awaiting a decision" }
  const first = await db.disbursementPayout.findFirst({ where: { tenantId: args.tenantId, loanId: r.loanId, attempt: 1 }, select: { disbursedById: true } })
  if (args.actor.id === r.requestedById || args.actor.id === first?.disbursedById) {
    await logAuditStrict({
      tenantId: args.tenantId, ...actorOf(args.actor), action: AuditAction.PAYOUT_ACTION_REFUSED,
      entity: "DisbursementReversal", entityId: r.id, newValue: { action: args.approve ? "approve_reversal" : "reject_reversal", reason: "maker_checker" },
    }, db)
    return { ok: false, status: 403, error: "A second LOAN_ADMIN decides a reversal: not whoever requested it or disbursed the loan" }
  }
  if (args.approve) {
    const blocker = await reversalBlocker(db, args.tenantId, r.loanId)
    if (blocker) return { ok: false, status: 409, error: blocker }
    // Ask the rail, where it can be asked, that no attempt paid.
    const rail = await railRefusal(db, { tenantId: args.tenantId, loanId: r.loanId, actor: args.actor })
    if (rail) return { ok: false, status: 409, error: rail }
  }
  const now = new Date()
  try {
    return await db.$transaction(async (tx) => {
    if (args.approve) {
      await lockLoanForPayout(tx, args.tenantId, r.loanId)
      const late = await reversalBlocker(tx, args.tenantId, r.loanId)
      if (late) return { ok: false as const, status: 409, error: late }
    }
    const moved = await tx.disbursementReversal.updateMany({
      where: { id: r.id, tenantId: args.tenantId, status: "REQUESTED" },
      data: { status: args.approve ? "APPROVED" : "REJECTED", decidedById: args.actor.id, decidedAt: now, decisionNote: args.note },
    })
    if (moved.count !== 1) return { ok: false as const, status: 409, error: "The request changed; refresh and try again" }
    const effects = args.approve
      ? await applyReversalEffects(tx, { tenantId: args.tenantId, loanId: r.loanId, reversalId: r.id, actor: args.actor, now })
      : null
    await logAuditStrict({
      tenantId: args.tenantId, ...actorOf(args.actor), action: AuditAction.DISBURSEMENT_REVERSAL_DECIDED,
      entity: "DisbursementReversal", entityId: r.id, newValue: { loanId: r.loanId, approved: args.approve, note: args.note, ...effects },
    }, tx)
    return { ok: true as const, reversalId: r.id, status: args.approve ? "APPROVED" as const : "REJECTED" as const, bureauCancellationRequired: effects?.bureauCancellationRequired ?? false }
    })
  } catch (error) {
    const refusal = raceRefusal(error)
    if (refusal) return refusal
    throw error
  }
}

/**
 * The staff task an approved reversal leaves: this build has no mandate
 * register (lib/payouts/reversal-effects.ts NO_MANDATE_REGISTER), so someone
 * cancels the borrower's debit order with the bank or collection provider by
 * hand and acknowledges it here, once. Until then the loan page and the
 * outstanding-payouts queue show the task.
 */
export async function acknowledgeDebitOrderCancelled(db: Pick<typeof prisma, "disbursementReversal" | "auditLog" | "$transaction">, args: {
  tenantId: string
  reversalId: string
  note: string
  actor: { id: string; email: string }
}): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const r = await db.disbursementReversal.findFirst({ where: { id: args.reversalId, tenantId: args.tenantId } })
  if (!r) return { ok: false, status: 404, error: "Reversal not found" }
  if (r.status !== "APPROVED") return { ok: false, status: 409, error: "Only an approved reversal leaves a debit order to cancel" }
  if (r.debitOrderCancelAckAt) return { ok: false, status: 409, error: "The debit order is already acknowledged cancelled" }
  try {
    return await db.$transaction(async (tx) => {
      const moved = await tx.disbursementReversal.updateMany({
        where: { id: r.id, tenantId: args.tenantId, status: "APPROVED", debitOrderCancelAckAt: null },
        data: { debitOrderCancelAckAt: new Date(), debitOrderCancelAckById: args.actor.id },
      })
      if (moved.count !== 1) return { ok: false as const, status: 409, error: "The debit order is already acknowledged cancelled" }
      await logAuditStrict({
        tenantId: args.tenantId, ...actorOf(args.actor), action: AuditAction.DEBIT_ORDER_CANCEL_ACKNOWLEDGED,
        entity: "DisbursementReversal", entityId: r.id, newValue: { loanId: r.loanId, note: args.note },
      }, tx)
      return { ok: true as const }
    })
  } catch (error) {
    const refusal = raceRefusal(error)
    if (refusal) return refusal
    throw error
  }
}
