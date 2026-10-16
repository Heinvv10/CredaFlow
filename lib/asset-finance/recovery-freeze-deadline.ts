import { AuditAction, logAuditStrict } from "@/lib/audit"
import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"
import { wouldRegressCollectionsStage } from "@/lib/collections/stages"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { createNotification } from "@/lib/notifications/bell"
import { prisma } from "@/lib/prisma"
import { dbDate, isoOfDbDate } from "./dates"

export interface RecoveryDeadlineRun {
  ok: boolean
  day: string
  handled: number
  alreadyHandled: number
  reminded: number
  alreadyReminded: number
  /** Due, but the creator is inactive and the tenant has no active ADMIN or SUPER_ADMIN: no marker, so the next run tries again. */
  noRecipient: number
  failed: number
}

type Outcome = "handled" | "already_handled"
type Reminder = "reminded" | "already_reminded" | "no_longer_due" | "no_recipient"

/** SA business days an NCA recovery may sit at PROCEEDS_APPLIED, charges frozen, before its creator is reminded of the final notice. */
export const FINAL_NOTICE_REMINDER_BUSINESS_DAYS = 5

async function handleRecovery(recovery: { id: string; tenantId: string; loanId: string; createdById: string }, day: string): Promise<Outcome> {
  const { tenantId } = recovery
  return prisma.$transaction(async (tx) => {
    await lockLoanForUpdate(tx, recovery.loanId)
    const done = await tx.auditLog.count({ where: { tenantId, action: AuditAction.ASSET_RECOVERY_DEADLINE_PASSED, entity: "Recovery", entityId: recovery.id } })
    if (done > 0) return "already_handled"
    const loan = await tx.loan.findFirst({ where: { id: recovery.loanId, tenantId }, select: { reference: true, status: true, collectionsStage: true } })
    if (!loan) throw new Error(`Loan ${recovery.loanId} of recovery ${recovery.id} not found`)
    const collectible = loan.status === "ACTIVE" || loan.status === "DEFAULTED"
    const attorney = collectible
      ? await tx.legalMatter.count({ where: { tenantId, loanId: recovery.loanId, status: "OPEN", attorneySupplierId: { not: null } } })
      : 0
    const moveStage = attorney > 0 && loan.collectionsStage !== "ATTORNEY_REFERRED" && !wouldRegressCollectionsStage(loan.collectionsStage, "ATTORNEY_REFERRED")
    if (moveStage) {
      await tx.loan.update({ where: { id: recovery.loanId, tenantId }, data: { collectionsStage: "ATTORNEY_REFERRED", collectionsStageUpdatedAt: new Date() } })
    }
    if (collectible) {
      await createNotification({
        tenantId, userId: recovery.createdById, type: "RECOVERY_DEADLINE_PASSED",
        title: `Loan ${loan.reference}: the period to pay the shortfall after the sale has ended`,
        body: "Default charges resume. Refer the loan to collections or the attorney; write-off stays a manual decision.",
        entityType: "Recovery", entityId: recovery.id,
      }, tx.notification)
    }
    await logAuditStrict({
      tenantId, action: AuditAction.ASSET_RECOVERY_DEADLINE_PASSED, entity: "Recovery", entityId: recovery.id,
      newValue: { loanId: recovery.loanId, day, collectible, collectionsStageMoved: moveStage, hasAttorney: attorney > 0 },
    }, tx)
    return "handled"
  })
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/** The recovery's creator; if that account is inactive, the tenant's active ADMIN and SUPER_ADMIN users. */
async function reminderRecipients(tx: Tx, tenantId: string, createdById: string): Promise<string[]> {
  const creator = await tx.user.findFirst({ where: { id: createdById, tenantId }, select: { active: true } })
  if (creator?.active) return [createdById]
  const admins = await tx.user.findMany({ where: { tenantId, role: { in: ["ADMIN", "SUPER_ADMIN"] }, active: true }, orderBy: { id: "asc" }, select: { id: true } })
  return admins.map((a) => a.id)
}

// The open-ended NCA freeze: charges stay frozen from the proceeds until the
// final notice fixes the deadline, so a forgotten notice freezes them for good.
// The reminder changes nothing on the recovery or the loan. It ignores the
// loan's status on purpose: the final notice is owed even on a loan that is
// settled, written off or otherwise closed.
async function remindFinalNotice(recovery: { id: string; tenantId: string; loanId: string; createdById: string }, day: string): Promise<Reminder> {
  const { tenantId } = recovery
  return prisma.$transaction(async (tx) => {
    // The loan, then the recovery, as the proceeds path locks them. Re-read under the lock:
    // a final notice issued since the sweep's query has moved the recovery on.
    await lockLoanForUpdate(tx, recovery.loanId)
    const [current] = await tx.$queryRaw<{ status: string }[]>`SELECT "status"::TEXT AS "status" FROM "Recovery" WHERE "id" = ${recovery.id} AND "tenantId" = ${tenantId} FOR UPDATE`
    if (current?.status !== "PROCEEDS_APPLIED") return "no_longer_due"
    const done = await tx.auditLog.count({ where: { tenantId, action: AuditAction.ASSET_RECOVERY_FINAL_NOTICE_REMINDED, entity: "Recovery", entityId: recovery.id } })
    if (done > 0) return "already_reminded"
    const recipients = await reminderRecipients(tx, tenantId, recovery.createdById)
    // No marker without a recipient: the next run tries again.
    if (recipients.length === 0) return "no_recipient"
    const loan = await tx.loan.findFirst({ where: { id: recovery.loanId, tenantId }, select: { reference: true } })
    if (!loan) throw new Error(`Loan ${recovery.loanId} of recovery ${recovery.id} not found`)
    for (const userId of recipients) {
      await createNotification({
        tenantId, userId, type: "RECOVERY_FINAL_NOTICE_DUE",
        title: `Loan ${loan.reference}: the final notice after the sale has not been issued`,
        body: `Sale proceeds were applied ${FINAL_NOTICE_REMINDER_BUSINESS_DAYS} or more business days ago. Charges stay frozen until the final notice sets the deadline; nothing happens automatically.`,
        entityType: "Recovery", entityId: recovery.id,
      }, tx.notification)
    }
    await logAuditStrict({
      tenantId, action: AuditAction.ASSET_RECOVERY_FINAL_NOTICE_REMINDED, entity: "Recovery", entityId: recovery.id,
      newValue: { loanId: recovery.loanId, day, recipients: recipients.length, toCreator: recipients[0] === recovery.createdById },
    }, tx)
    return "reminded"
  })
}

/** NCA recoveries at PROCEEDS_APPLIED (no final notice yet) whose charges froze at least FINAL_NOTICE_REMINDER_BUSINESS_DAYS business days before `day`. */
async function finalNoticesDue(tenantId: string, day: string) {
  const rows = await prisma.recovery.findMany({
    where: {
      // PROCEEDS_APPLIED is "no final notice yet": issuing it moves an NCA recovery to FINAL_NOTICE_ISSUED.
      tenantId, status: "PROCEEDS_APPLIED", route: { in: ["NCA_S127_SURRENDER", "NCA_S131_ATTACHMENT"] },
      chargesFrozenFrom: { not: null, lt: dbDate(day) },
    },
    orderBy: { id: "asc" }, select: { id: true, tenantId: true, loanId: true, createdById: true, chargesFrozenFrom: true },
  })
  // The TS holiday calendar is enough for a reminder; the legal deadlines (the
  // freeze end) are computed by the database's own calendar, recoveryAddBusinessDays.
  return rows.filter((r) => addSouthAfricanBusinessDays(isoOfDbDate(r.chargesFrozenFrom!), FINAL_NOTICE_REMINDER_BUSINESS_DAYS) <= day)
}

/**
 * The deadline sweep behind app/api/cron/asset-finance-recovery-deadlines.
 * For every SHORTFALL_OPEN recovery whose charge freeze ended before `day`
 * (SAST), once: the shortfall loan's collections stage moves to ATTORNEY_REFERRED
 * when it has an open legal matter with an attorney appointed (never backwards,
 * never to WRITTEN_OFF; with no attorney the stage stays and collections picks
 * the loan up as it does any arrears), the recovery's creator gets a bell item,
 * and an audit row is written. That audit row is the "handled" marker, written in
 * the same transaction, so a rerun changes nothing. Charges themselves resume by
 * the replay (lib/loan/recovery-pauses.ts), not here. Write-off
 * is never automatic. It also reminds the creator (or, when that account is
 * inactive, the tenant's active admins), once per recovery (the
 * ASSET_RECOVERY_FINAL_NOTICE_REMINDED audit row is the marker), of every NCA
 * recovery whose final notice is still missing 5 SA business days after the
 * proceeds froze its charges. Each recovery runs in its own transaction; one
 * failure is logged and counted and the sweep goes on.
 */
export async function runRecoveryDeadlineSweep(day: string): Promise<RecoveryDeadlineRun> {
  const run: RecoveryDeadlineRun = { ok: true, day, handled: 0, alreadyHandled: 0, reminded: 0, alreadyReminded: 0, noRecipient: 0, failed: 0 }
  const tenants = await prisma.tenantConfig.findMany({ where: { featureAssetFinance: true }, orderBy: { tenantId: "asc" }, select: { tenantId: true } })
  for (const { tenantId } of tenants) {
    const due = await prisma.recovery.findMany({
      where: { tenantId, status: "SHORTFALL_OPEN", chargesFrozenUntil: { lt: dbDate(day) } },
      orderBy: { id: "asc" }, select: { id: true, tenantId: true, loanId: true, createdById: true },
    })
    for (const recovery of due) {
      try {
        const outcome = await handleRecovery(recovery, day)
        if (outcome === "handled") run.handled++
        else run.alreadyHandled++
      } catch (error) {
        run.failed++
        console.error("[asset-finance-recovery-deadlines] recovery failed", { tenantId, recoveryId: recovery.id, error: error instanceof Error ? error.name : "unknown" })
      }
    }
    for (const recovery of await finalNoticesDue(tenantId, day)) {
      try {
        const outcome = await remindFinalNotice(recovery, day)
        if (outcome === "reminded") run.reminded++
        else if (outcome === "already_reminded") run.alreadyReminded++
        else if (outcome === "no_recipient") run.noRecipient++
      } catch (error) {
        run.failed++
        console.error("[asset-finance-recovery-deadlines] final-notice reminder failed", { tenantId, recoveryId: recovery.id, error: error instanceof Error ? error.name : "unknown" })
      }
    }
  }
  run.ok = run.failed === 0
  return run
}
