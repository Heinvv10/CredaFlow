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
import { isOver, type PayoutStatus } from "./state"

export type ReversalDb = Pick<typeof prisma, "disbursementPayout" | "disbursementReversal" | "loan" | "payment" | "auditLog" | "$transaction">

export type ReversalResult = { ok: true; reversalId: string; status: "REQUESTED" | "APPROVED" | "REJECTED" } | { ok: false; status: number; error: string }

const actorOf = (a: { id: string; email: string }) => ({ userId: a.id, userEmail: a.email })

/** Why this loan's disbursement cannot be reversed now, or null. */
async function reversalBlocker(db: ReversalDb, tenantId: string, loanId: string): Promise<string | null> {
  const loan = await db.loan.findFirst({ where: { id: loanId, tenantId }, select: { status: true } })
  if (!loan) return "Loan not found"
  if (loan.status !== "ACTIVE" && loan.status !== "DEFAULTED") return "Only an active loan's disbursement can be reversed"
  const attempts = await db.disbursementPayout.findMany({ where: { tenantId, loanId }, select: { status: true } })
  if (attempts.length === 0) return "This loan was not paid out through the payout channel; there is no payout to reverse"
  if (attempts.some((a) => !isOver(a.status as PayoutStatus))) return "A payout attempt is paid or still in progress; the money may have reached the borrower"
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
  return db.$transaction(async (tx) => {
    const created = await tx.disbursementReversal.create({
      data: { tenantId: args.tenantId, loanId: args.loanId, reason: args.reason, requestedById: args.actor.id },
      select: { id: true },
    })
    await logAuditStrict({
      tenantId: args.tenantId, ...actorOf(args.actor), action: AuditAction.DISBURSEMENT_REVERSAL_REQUESTED,
      entity: "DisbursementReversal", entityId: created.id, newValue: { loanId: args.loanId, reason: args.reason },
    }, tx)
    return { ok: true as const, reversalId: created.id, status: "REQUESTED" as const }
  })
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
  }
  const now = new Date()
  return db.$transaction(async (tx) => {
    const moved = await tx.disbursementReversal.updateMany({
      where: { id: r.id, tenantId: args.tenantId, status: "REQUESTED" },
      data: { status: args.approve ? "APPROVED" : "REJECTED", decidedById: args.actor.id, decidedAt: now, decisionNote: args.note },
    })
    if (moved.count !== 1) return { ok: false as const, status: 409, error: "The request changed; refresh and try again" }
    await logAuditStrict({
      tenantId: args.tenantId, ...actorOf(args.actor), action: AuditAction.DISBURSEMENT_REVERSAL_DECIDED,
      entity: "DisbursementReversal", entityId: r.id, newValue: { loanId: r.loanId, approved: args.approve, note: args.note },
    }, tx)
    if (args.approve) {
      const cancelled = await tx.loan.updateMany({
        where: { id: r.loanId, tenantId: args.tenantId, status: { in: ["ACTIVE", "DEFAULTED"] } },
        data: {
          status: "CANCELLED", closedAt: now, outstandingPrincipal: 0, arrearsAmount: 0, daysInArrears: 0,
          nextPaymentDate: null, collectionsStage: "NONE", chargesOutstanding: 0,
          // No interest or fees on money never advanced. The signed totals stay
          // in contractualTotal* (set at booking).
          totalInterest: 0, totalRepayable: 0,
        },
      })
      if (cancelled.count !== 1) throw new Error("The loan changed while its disbursement was being reversed")
      await logAuditStrict({
        tenantId: args.tenantId, ...actorOf(args.actor), action: AuditAction.LOAN_CANCELLED,
        entity: "Loan", entityId: r.loanId, newValue: { status: "CANCELLED", reason: "disbursement_reversed", reversalId: r.id },
      }, tx)
    }
    return { ok: true as const, reversalId: r.id, status: args.approve ? "APPROVED" as const : "REJECTED" as const }
  })
}
