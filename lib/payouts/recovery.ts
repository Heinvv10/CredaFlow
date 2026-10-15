/**
 * Money paid out on a loan whose disbursement had already been reversed (PR
 * #89 round 3): a provider's late PAID report on a FAILED/CANCELLED attempt of
 * a CANCELLED loan. It is never "resolved as paid" — the loan stays CANCELLED
 * and is not reinstated. The resolver opens a recovery case instead
 * (lib/payouts/conflicts.ts, outcome "recovery"), and the accounting export
 * shows the money in payout clearing (Dr clearing / Cr bank at the value date
 * it left) until the case records it recovered (lib/accounting/sources.ts).
 *
 * A case goes OPEN -> RECOVERED (the full amount came back: staff enter the
 * amount and it must equal the case's), or OPEN -> ESCALATED (it is not
 * coming back by itself: a partial recovery, a recipient who will not return
 * it) -> RECOVERED; from OPEN or ESCALATED it may instead be closed
 * UNRECOVERABLE, which the accounting export writes off to bad debts that
 * day. Each step is audited and taken by a LOAN_ADMIN (TOTP, the route) who
 * neither made nor approved the payout nor opened the case, and whoever
 * escalated a case does not also close it; the database repeats the order,
 * the full-amount rule and these exclusions (guardPayoutRecoveryCase).
 */
import type { DisbursementPayout, PayoutRecoveryCase } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { prisma } from "@/lib/prisma"
import type { Actor } from "./dispatch"
import { raceRefusal } from "./loan-lock"

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
export type RecoveryDb = Pick<typeof prisma, "payoutRecoveryCase" | "auditLog" | "$transaction">
export type RecoveryResult = { ok: true; status: PayoutRecoveryCase["status"] } | { ok: false; status: number; error: string }

/** Opens the case inside the conflict resolution's transaction (the loan row is locked and CANCELLED). */
export async function openRecoveryCase(tx: Tx, args: {
  tenantId: string
  payout: Pick<DisbursementPayout, "id" | "loanId" | "amountCents" | "attempt">
  paidAt: Date
  note: string
  actor: Actor & { id: string }
}): Promise<PayoutRecoveryCase> {
  const opened = await tx.payoutRecoveryCase.create({
    data: {
      tenantId: args.tenantId, loanId: args.payout.loanId, payoutId: args.payout.id,
      amountCents: args.payout.amountCents, paidAt: args.paidAt, openedById: args.actor.id, openNote: args.note,
    },
  })
  await logAuditStrict({
    tenantId: args.tenantId, userId: args.actor.id, userEmail: args.actor.email,
    action: AuditAction.PAYOUT_RECOVERY_OPENED, entity: "PayoutRecoveryCase", entityId: opened.id,
    newValue: { loanId: args.payout.loanId, payoutId: args.payout.id, attempt: args.payout.attempt, amountCents: args.payout.amountCents, paidAt: args.paidAt.toISOString(), note: args.note },
  }, tx)
  return opened
}

type CaseWithPayout = PayoutRecoveryCase & { payout: Pick<DisbursementPayout, "disbursedById" | "createdById" | "approvedById"> }

async function loadCase(db: RecoveryDb, tenantId: string, caseId: string): Promise<CaseWithPayout | null> {
  return db.payoutRecoveryCase.findFirst({
    where: { id: caseId, tenantId },
    include: { payout: { select: { disbursedById: true, createdById: true, approvedById: true } } },
  })
}

async function makerCheckerRefusal(db: RecoveryDb, tenantId: string, c: CaseWithPayout, action: string, actor: Actor & { id: string }) {
  const excluded = [c.payout.disbursedById, c.payout.createdById, c.payout.approvedById, c.openedById]
  // A two-step close: whoever escalated does not also close (recovered or unrecoverable).
  if (action !== "escalate_recovery" && c.status === "ESCALATED") excluded.push(c.escalatedById)
  if (!excluded.includes(actor.id)) return null
  await logAuditStrict({
    tenantId, userId: actor.id, userEmail: actor.email,
    action: AuditAction.PAYOUT_ACTION_REFUSED, entity: "PayoutRecoveryCase", entityId: c.id,
    newValue: { action, reason: "maker_checker" },
  }, db)
  return { ok: false as const, status: 403, error: "Another LOAN_ADMIN must act on this recovery: you disbursed the loan, requested or approved this payout, opened this case or escalated it" }
}

async function moveCase(db: RecoveryDb, args: {
  tenantId: string
  c: CaseWithPayout
  from: PayoutRecoveryCase["status"][]
  data: Partial<PayoutRecoveryCase>
  action: (typeof AuditAction)["PAYOUT_RECOVERY_ESCALATED" | "PAYOUT_RECOVERY_RECORDED" | "PAYOUT_RECOVERY_UNRECOVERABLE"]
  detail: Record<string, unknown>
  actor: Actor & { id: string }
}): Promise<RecoveryResult> {
  try {
    return await db.$transaction(async (tx) => {
      const moved = await tx.payoutRecoveryCase.updateMany({
        where: { id: args.c.id, tenantId: args.tenantId, status: { in: args.from } },
        data: args.data,
      })
      if (moved.count !== 1) return { ok: false as const, status: 409, error: "The recovery case changed; refresh and try again" }
      await logAuditStrict({
        tenantId: args.tenantId, userId: args.actor.id, userEmail: args.actor.email,
        action: args.action, entity: "PayoutRecoveryCase", entityId: args.c.id,
        oldValue: { status: args.c.status }, newValue: { status: args.data.status, loanId: args.c.loanId, ...args.detail },
      }, tx)
      return { ok: true as const, status: args.data.status as PayoutRecoveryCase["status"] }
    })
  } catch (error) {
    const refusal = raceRefusal(error)
    if (refusal) return refusal
    throw error
  }
}

const CLOSED: readonly PayoutRecoveryCase["status"][] = ["RECOVERED", "UNRECOVERABLE"]
const closedError = (s: PayoutRecoveryCase["status"]) => s === "RECOVERED" ? "This money is already recorded as recovered" : "This case is closed as unrecoverable"

/** The full amount, as entered by staff, came back to the lender's bank on `recoveredAt` (a value date). */
export async function recordRecoveredFunds(db: RecoveryDb, args: {
  tenantId: string
  caseId: string
  recoveredAt: Date
  amountCents: number
  note: string
  reference: string | null
  actor: Actor & { id: string }
}): Promise<RecoveryResult> {
  const c = await loadCase(db, args.tenantId, args.caseId)
  if (!c) return { ok: false, status: 404, error: "Recovery case not found" }
  if (CLOSED.includes(c.status)) return { ok: false, status: 409, error: closedError(c.status) }
  const refused = await makerCheckerRefusal(db, args.tenantId, c, "record_recovery", args.actor)
  if (refused) return refused
  if (args.amountCents !== c.amountCents) {
    return { ok: false, status: 422, error: `Only the full ${(c.amountCents / 100).toFixed(2)} is recorded as recovered; if less came back, escalate the case` }
  }
  if (args.recoveredAt.getTime() < c.paidAt.getTime()) return { ok: false, status: 422, error: "The funds cannot come back before they left" }
  return moveCase(db, {
    tenantId: args.tenantId, c, from: ["OPEN", "ESCALATED"], actor: args.actor, action: AuditAction.PAYOUT_RECOVERY_RECORDED,
    data: { status: "RECOVERED", recoveredAt: args.recoveredAt, recoveredById: args.actor.id, recoveryNote: args.note, recoveryReference: args.reference, recoveredAmountCents: args.amountCents },
    detail: { amountCents: args.amountCents, recoveredAt: args.recoveredAt.toISOString(), note: args.note, reference: args.reference },
  })
}

/** The money is not coming back by itself; someone takes it further. */
export async function escalateRecovery(db: RecoveryDb, args: {
  tenantId: string
  caseId: string
  note: string
  actor: Actor & { id: string }
}): Promise<RecoveryResult> {
  const c = await loadCase(db, args.tenantId, args.caseId)
  if (!c) return { ok: false, status: 404, error: "Recovery case not found" }
  if (c.status !== "OPEN") return { ok: false, status: 409, error: c.status === "ESCALATED" ? "This recovery is already escalated" : closedError(c.status) }
  const refused = await makerCheckerRefusal(db, args.tenantId, c, "escalate_recovery", args.actor)
  if (refused) return refused
  return moveCase(db, {
    tenantId: args.tenantId, c, from: ["OPEN"], actor: args.actor, action: AuditAction.PAYOUT_RECOVERY_ESCALATED,
    data: { status: "ESCALATED", escalatedAt: new Date(), escalatedById: args.actor.id, escalationNote: args.note },
    detail: { note: args.note },
  })
}

/** The money is not coming back: the case closes, and the export writes it off to bad debts today. */
export async function closeRecoveryUnrecoverable(db: RecoveryDb, args: {
  tenantId: string
  caseId: string
  note: string
  actor: Actor & { id: string }
}): Promise<RecoveryResult> {
  const c = await loadCase(db, args.tenantId, args.caseId)
  if (!c) return { ok: false, status: 404, error: "Recovery case not found" }
  if (CLOSED.includes(c.status)) return { ok: false, status: 409, error: closedError(c.status) }
  const refused = await makerCheckerRefusal(db, args.tenantId, c, "close_unrecoverable", args.actor)
  if (refused) return refused
  return moveCase(db, {
    tenantId: args.tenantId, c, from: ["OPEN", "ESCALATED"], actor: args.actor, action: AuditAction.PAYOUT_RECOVERY_UNRECOVERABLE,
    data: { status: "UNRECOVERABLE", unrecoverableAt: new Date(), unrecoverableById: args.actor.id, unrecoverableNote: args.note },
    detail: { amountCents: c.amountCents, note: args.note },
  })
}
