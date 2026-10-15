import { AuditAction, logAuditStrict } from "@/lib/audit"
import { wouldRegressCollectionsStage } from "@/lib/collections/stages"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { createNotification } from "@/lib/notifications/bell"
import { prisma } from "@/lib/prisma"
import { dbDate } from "./dates"

/**
 * The deadline sweep behind app/api/cron/asset-finance-recovery-deadlines.
 * For every SHORTFALL_OPEN recovery whose charge freeze ended before `day`
 * (SAST), once: the shortfall loan's collections stage moves to ATTORNEY_REFERRED
 * when it has an open legal matter with an attorney appointed (never backwards,
 * never to WRITTEN_OFF; with no attorney the stage stays and collections picks
 * the loan up as it does any arrears), the recovery's creator gets a bell item,
 * and an audit row is written. That audit row is the "handled" marker, written in
 * the same transaction, so a rerun changes nothing. Charges themselves resume by
 * the replay (lib/asset-finance/recovery-freeze-window.ts), not here. Write-off
 * is never automatic. Each recovery runs in its own transaction; one failure is
 * logged and counted and the sweep goes on.
 */
export const RECOVERY_DEADLINE_AUDIT_ACTION = AuditAction.ASSET_RECOVERY_DEADLINE_PASSED

export interface RecoveryDeadlineRun {
  ok: boolean
  day: string
  handled: number
  alreadyHandled: number
  failed: number
}

type Outcome = "handled" | "already_handled"

async function handleRecovery(recovery: { id: string; tenantId: string; loanId: string; createdById: string }, day: string): Promise<Outcome> {
  const { tenantId } = recovery
  return prisma.$transaction(async (tx) => {
    await lockLoanForUpdate(tx, recovery.loanId)
    const done = await tx.auditLog.count({ where: { tenantId, action: RECOVERY_DEADLINE_AUDIT_ACTION, entity: "Recovery", entityId: recovery.id } })
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
      tenantId, action: RECOVERY_DEADLINE_AUDIT_ACTION, entity: "Recovery", entityId: recovery.id,
      newValue: { loanId: recovery.loanId, day, collectible, collectionsStageMoved: moveStage, hasAttorney: attorney > 0 },
    }, tx)
    return "handled"
  })
}

export async function runRecoveryDeadlineSweep(day: string): Promise<RecoveryDeadlineRun> {
  const run: RecoveryDeadlineRun = { ok: true, day, handled: 0, alreadyHandled: 0, failed: 0 }
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
        console.error("[asset-finance-recovery-deadlines] recovery failed", { tenantId, recoveryId: recovery.id, error })
      }
    }
  }
  run.ok = run.failed === 0
  return run
}
