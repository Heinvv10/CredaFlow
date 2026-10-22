/**
 * A tracker alert becomes a work item (docs/asset-finance/SLICE5.md part B) on
 * the loan whose tenure covers the event (the caller's telematicsLoanAt; no
 * loan, no alert). A repeat of an unresolved alert of the same device, kind
 * and loan folds into it (locked first: a resolve racing the fold wins, and
 * the repeat opens a new item); an old loan's item never absorbs a new
 * lease's. Its queue is the loan's now, set on raising and re-evaluated on
 * every repeat: RECOVERY when that loan has an open recovery or an OPEN legal
 * matter, COLLECTIONS when it is in default (DEFAULTED or PENDING_WRITE_OFF),
 * else SERVICING (a loan in good standing is not a collections matter).
 * Nothing is sent to anyone: this writes TelematicsAlert and the audit row
 * only (lib/telematics/no-outbound.test.ts).
 */
import type { RecoveryStatus, TelematicsAlertKind, TelematicsAlertQueue } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { SigningTx } from "@/lib/asset-finance/signing-prepare"

/** A recovery still open: anything but CLOSED or WITHDRAWN. */
export const OPEN_RECOVERY: { status: { notIn: RecoveryStatus[] } } = { status: { notIn: ["CLOSED", "WITHDRAWN"] } }
/** A loan in default: still collectable, not written off. */
export const IN_DEFAULT = ["DEFAULTED", "PENDING_WRITE_OFF"] as const

export interface AlertDevice {
  id: string
  tenantId: string
  assetId: string
}

async function queueFor(tx: SigningTx, tenantId: string, loanId: string): Promise<TelematicsAlertQueue> {
  const [recoveries, matters, loan] = await Promise.all([
    tx.recovery.count({ where: { tenantId, loanId, ...OPEN_RECOVERY } }),
    tx.legalMatter.count({ where: { tenantId, loanId, status: "OPEN" } }),
    tx.loan.findFirst({ where: { id: loanId, tenantId }, select: { status: true } }),
  ])
  if (recoveries > 0 || matters > 0) return "RECOVERY"
  return (IN_DEFAULT as readonly string[]).includes(loan?.status ?? "") ? "COLLECTIONS" : "SERVICING"
}

export async function raiseAlert(
  tx: SigningTx, device: AlertDevice, eventId: string, kind: TelematicsAlertKind, occurredAt: Date, loanId: string,
): Promise<{ alertId: string; repeat: boolean }> {
  const { tenantId } = device
  const queue = await queueFor(tx, tenantId, loanId)
  // Locked, and re-read after the lock: an item resolved meanwhile no longer matches.
  const [open] = await tx.$queryRaw<{ id: string; lastOccurredAt: Date }[]>`
    SELECT "id", "lastOccurredAt" FROM "TelematicsAlert"
    WHERE "tenantId" = ${tenantId} AND "deviceId" = ${device.id} AND "kind" = ${kind}::"TelematicsAlertKind" AND "loanId" = ${loanId} AND "status" <> 'RESOLVED'
    FOR UPDATE`
  if (open) {
    const updated = await tx.telematicsAlert.update({
      where: { id: open.id, tenantId },
      data: { occurrences: { increment: 1 }, lastOccurredAt: occurredAt > open.lastOccurredAt ? occurredAt : open.lastOccurredAt, queue },
      select: { occurrences: true },
    })
    await logAuditStrict({
      tenantId, action: AuditAction.TELEMATICS_ALERT_RAISED, entity: "TelematicsAlert", entityId: open.id,
      newValue: { eventId, kind, queue, repeat: true, occurrences: updated.occurrences, actor: { type: "system", source: "telematics", eventId } },
    }, tx)
    return { alertId: open.id, repeat: true }
  }
  const alert = await tx.telematicsAlert.create({
    data: {
      tenantId, eventId, deviceId: device.id, assetId: device.assetId, loanId, kind, queue,
      firstOccurredAt: occurredAt, lastOccurredAt: occurredAt,
    },
    select: { id: true },
  })
  await logAuditStrict({
    tenantId, action: AuditAction.TELEMATICS_ALERT_RAISED, entity: "TelematicsAlert", entityId: alert.id,
    newValue: { eventId, kind, queue, assetId: device.assetId, loanId, actor: { type: "system", source: "telematics", eventId } },
  }, tx)
  return { alertId: alert.id, repeat: false }
}
