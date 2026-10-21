/**
 * The tracker alert work queue (docs/asset-finance/SLICE5.md part B):
 * servicing, collections or recovery items; collections staff
 * (work_telematics_alerts) acknowledge an OPEN item and
 * resolve it with a note; a resolved item is final (guardTelematicsAlert).
 * Raising is alerts-raise.ts. Audited.
 */
import type { TelematicsAlertQueue, TelematicsAlertStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { noteOf, objectBody, refused, type TelematicsActor, type TelematicsResult } from "./result"

export { raiseAlert } from "./alerts-raise"

export async function acknowledgeAlert(actor: TelematicsActor, alertId: string): Promise<TelematicsResult> {
  const { tenantId } = actor
  if (!(await prisma.telematicsAlert.findFirst({ where: { id: alertId, tenantId }, select: { id: true } }))) return refused(404, "Alert not found")
  return prisma.$transaction(async (tx) => {
    const done = await tx.telematicsAlert.updateMany({
      where: { id: alertId, tenantId, status: "OPEN" },
      data: { status: "ACKNOWLEDGED", acknowledgedById: actor.userId, acknowledgedAt: new Date() },
    })
    if (done.count !== 1) return refused(409, "Only an open alert is acknowledged")
    await logAuditStrict({ tenantId, userId: actor.userId, userEmail: actor.userEmail, action: AuditAction.TELEMATICS_ALERT_ACKNOWLEDGED, entity: "TelematicsAlert", entityId: alertId }, tx)
    return { kind: "ok" as const }
  })
}

export async function resolveAlert(actor: TelematicsActor, alertId: string, body: unknown): Promise<TelematicsResult> {
  const { tenantId } = actor
  const note = noteOf(objectBody(body)?.note)
  if (!note) return refused(400, "Say how the alert was resolved (3 to 500 characters)", { note: "3 to 500 characters" })
  if (!(await prisma.telematicsAlert.findFirst({ where: { id: alertId, tenantId }, select: { id: true } }))) return refused(404, "Alert not found")
  return prisma.$transaction(async (tx) => {
    const done = await tx.telematicsAlert.updateMany({
      where: { id: alertId, tenantId, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      data: { status: "RESOLVED", resolvedById: actor.userId, resolvedAt: new Date(), resolutionNote: note },
    })
    if (done.count !== 1) return refused(409, "This alert is already resolved")
    await logAuditStrict({
      tenantId, userId: actor.userId, userEmail: actor.userEmail, action: AuditAction.TELEMATICS_ALERT_RESOLVED, entity: "TelematicsAlert", entityId: alertId,
      newValue: { note },
    }, tx)
    return { kind: "ok" as const }
  })
}

export interface AlertRow {
  id: string
  kind: string
  queue: TelematicsAlertQueue
  status: TelematicsAlertStatus
  occurrences: number
  firstOccurredAt: Date
  lastOccurredAt: Date
  assetId: string
  assetLabel: string
  loanId: string
  loanReference: string
  simulated: boolean
  resolutionNote: string | null
}

export const ALERT_QUEUES: readonly TelematicsAlertQueue[] = ["SERVICING", "COLLECTIONS", "RECOVERY"]
export const ALERT_STATUSES: readonly TelematicsAlertStatus[] = ["OPEN", "ACKNOWLEDGED", "RESOLVED"]

/** The queue, newest activity first; unresolved by default. Optionally one loan's or one asset's. */
export async function listAlerts(
  tenantId: string, filter: { queue?: TelematicsAlertQueue; status?: TelematicsAlertStatus; loanId?: string; assetId?: string } = {},
): Promise<AlertRow[]> {
  const rows = await prisma.telematicsAlert.findMany({
    where: {
      tenantId, ...(filter.queue ? { queue: filter.queue } : {}), status: filter.status ?? { not: "RESOLVED" },
      ...(filter.loanId ? { loanId: filter.loanId } : {}), ...(filter.assetId ? { assetId: filter.assetId } : {}),
    },
    orderBy: { lastOccurredAt: "desc" },
    take: 200,
    select: {
      id: true, kind: true, queue: true, status: true, occurrences: true, firstOccurredAt: true, lastOccurredAt: true, assetId: true, loanId: true, resolutionNote: true,
      asset: { select: { make: true, model: true, serialNumber: true } }, loan: { select: { reference: true } }, event: { select: { simulated: true } },
    },
  })
  return rows.map(({ asset, loan, event, ...row }) => ({
    ...row, assetLabel: `${asset.make} ${asset.model} (${asset.serialNumber})`, loanReference: loan.reference, simulated: event.simulated,
  }))
}
