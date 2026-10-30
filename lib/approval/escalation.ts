import { AuditAction, logAuditStrict } from "@/lib/audit"
import { logger } from "@/lib/observability/logger"
import { prisma } from "@/lib/prisma"
import { runWithTenant, withoutTenantScope } from "@/lib/tenant-scope"
import { loadMatrixVersion } from "./matrix-store"
import { approversForLevel, notifyStaff } from "./notify"
import type { MatrixLevel } from "./types"

const BATCH = 100
const hours = (n: number) => n * 3_600_000

export interface EscalationResult {
  escalated: number
  /** Overdue at the highest level: nobody above to tell; the level's own approvers are reminded. */
  reminded: number
  failed: number
}

/** The level an overdue case escalates to: one further up for each escalation already made at the pending level, capped at the top. */
export function escalationTarget(pendingLevel: number, escalationCount: number, topLevel: number): number {
  return Math.min(pendingLevel + escalationCount + 1, topLevel)
}

async function escalateOne(caseId: string, tenantId: string, now: Date): Promise<"escalated" | "reminded" | "skipped"> {
  return prisma.$transaction(async (tx) => {
    const theCase = await tx.approvalCase.findFirst({ where: { id: caseId, tenantId, status: "OPEN", dueAt: { lt: now } } })
    if (!theCase || !theCase.dueAt) return "skipped"
    const levels = ((theCase.levelsSnapshot as unknown as MatrixLevel[] | null) ?? (theCase.matrixVersionId ? (await loadMatrixVersion(tx, tenantId, theCase.matrixVersionId))?.payload.levels : undefined)) ?? []
    if (levels.length === 0) return "skipped"
    const top = levels[levels.length - 1].level
    const pending = levels.find((l) => l.level === theCase.pendingLevel) ?? levels[0]
    const toLevel = escalationTarget(theCase.pendingLevel, theCase.escalationCount, top)
    // Claimed by the due time it was read at: another replica's claim leaves this one nothing to update.
    const claimed = await tx.approvalCase.updateMany({
      where: { id: theCase.id, status: "OPEN", dueAt: theCase.dueAt },
      data: { escalationCount: { increment: 1 }, lastEscalatedAt: now, dueAt: new Date(now.getTime() + hours(pending.slaHours)) },
    })
    if (claimed.count !== 1) return "skipped"
    const application = await tx.loanApplication.findFirst({ where: { id: theCase.applicationId, tenantId }, select: { reference: true, appliedAmount: true, inputStaffIds: true } })
    if (!application) return "skipped"
    const steps = await tx.approvalStep.findMany({ where: { caseId: theCase.id }, select: { approverId: true } })
    const exclude = [...application.inputStaffIds, ...steps.map((s) => s.approverId)]
    const recipients = await approversForLevel(tx, { tenantId, levels, level: toLevel, amountCents: application.appliedAmount, exclude, now })
    const atTop = theCase.pendingLevel >= top
    if (!atTop) {
      await tx.approvalEscalation.create({ data: { tenantId, caseId: theCase.id, fromLevel: theCase.pendingLevel, toLevel, notifiedUserIds: recipients } })
    }
    await logAuditStrict({
      tenantId, action: atTop ? AuditAction.APPROVAL_OVERDUE_AT_TOP_LEVEL : AuditAction.APPROVAL_ESCALATED, entity: "LoanApplication", entityId: theCase.applicationId,
      newValue: { caseId: theCase.id, pendingLevel: theCase.pendingLevel, toLevel, dueAt: theCase.dueAt.toISOString(), notified: recipients.length },
    }, tx)
    await notifyStaff(tx, {
      tenantId, userIds: recipients, type: atTop ? "APPROVAL_OVERDUE" : "APPROVAL_ESCALATED",
      title: atTop ? "An application is overdue for final approval" : "An overdue approval has been escalated to you",
      body: `${application.reference} has waited more than ${pending.slaHours} hours at level ${theCase.pendingLevel} (${pending.name}).`, applicationId: theCase.applicationId,
    })
    return atTop ? "reminded" : "escalated"
  })
}

/**
 * A case whose escalation keeps failing is pushed back an hour, so the oldest failing cases cannot fill every batch and starve the rest.
 * Only the due time moves; the level, its count and the people told are untouched.
 */
async function postponeFailedCase(caseId: string, tenantId: string, now: Date): Promise<void> {
  try {
    await runWithTenant(tenantId, () => prisma.approvalCase.updateMany({ where: { id: caseId, status: "OPEN", dueAt: { lt: now } }, data: { dueAt: new Date(now.getTime() + hours(1)) } }))
  } catch (error) {
    logger.error("approval: could not postpone a failing case", { caseId, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * The cron's work: every open approval that is overdue at its level, across lenders, is escalated to the next level up (its approvers are
 * told, the escalation is recorded, and the next overdue time is one SLA away so it climbs again if still waiting). At the top level the
 * approvers there are reminded each SLA. Idempotent across replicas.
 */
export async function escalateOverdueApprovals(input: { now?: Date } = {}): Promise<EscalationResult> {
  const now = input.now ?? new Date()
  const due = await withoutTenantScope(async () => await prisma.approvalCase.findMany({
    where: { status: "OPEN", dueAt: { lt: now } }, orderBy: { dueAt: "asc" }, take: BATCH, select: { id: true, tenantId: true },
  }))
  const result: EscalationResult = { escalated: 0, reminded: 0, failed: 0 }
  for (const row of due) {
    try {
      const outcome = await runWithTenant(row.tenantId, () => escalateOne(row.id, row.tenantId, now))
      if (outcome === "escalated") result.escalated += 1
      else if (outcome === "reminded") result.reminded += 1
    } catch (error) {
      logger.error("approval: escalation failed for case", { caseId: row.id, error: error instanceof Error ? error.message : String(error) })
      result.failed += 1
      await postponeFailedCase(row.id, row.tenantId, now)
    }
  }
  return result
}
