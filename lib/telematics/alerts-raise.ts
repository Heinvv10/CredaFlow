/**
 * A tracker alert becomes a work item (docs/asset-finance/SLICE5.md part B):
 * a repeat of an unresolved alert of the same device and kind folds into it;
 * otherwise a new OPEN item on the asset's current loan, in the RECOVERY queue
 * when that loan has an open recovery or an OPEN legal matter, else
 * COLLECTIONS. Nothing is sent to anyone: this writes TelematicsAlert and the
 * audit row only (lib/telematics/no-outbound.test.ts).
 */
import type { RecoveryStatus, TelematicsAlertKind, TelematicsAlertQueue } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { SigningTx } from "@/lib/asset-finance/signing-prepare"

const CLOSED_LOANS = ["COMPLETED", "CANCELLED", "WRITTEN_OFF"] as const
/** A recovery still open: anything but CLOSED or WITHDRAWN. */
export const OPEN_RECOVERY: { status: { notIn: RecoveryStatus[] } } = { status: { notIn: ["CLOSED", "WITHDRAWN"] } }

export interface AlertDevice {
  id: string
  tenantId: string
  assetId: string
}

async function queueFor(tx: SigningTx, tenantId: string, loanId: string | null): Promise<TelematicsAlertQueue> {
  if (!loanId) return "COLLECTIONS"
  const [recoveries, matters] = await Promise.all([
    tx.recovery.count({ where: { tenantId, loanId, ...OPEN_RECOVERY } }),
    tx.legalMatter.count({ where: { tenantId, loanId, status: "OPEN" } }),
  ])
  return recoveries > 0 || matters > 0 ? "RECOVERY" : "COLLECTIONS"
}

export async function raiseAlert(
  tx: SigningTx, device: AlertDevice, eventId: string, kind: TelematicsAlertKind, occurredAt: Date,
): Promise<{ alertId: string; repeat: boolean }> {
  const { tenantId } = device
  const open = await tx.telematicsAlert.findFirst({
    where: { tenantId, deviceId: device.id, kind, status: { not: "RESOLVED" } }, select: { id: true, lastOccurredAt: true },
  })
  if (open) {
    const updated = await tx.telematicsAlert.update({
      where: { id: open.id, tenantId },
      data: { occurrences: { increment: 1 }, lastOccurredAt: occurredAt > open.lastOccurredAt ? occurredAt : open.lastOccurredAt },
      select: { occurrences: true },
    })
    await logAuditStrict({
      tenantId, action: AuditAction.TELEMATICS_ALERT_RAISED, entity: "TelematicsAlert", entityId: open.id,
      newValue: { eventId, kind, repeat: true, occurrences: updated.occurrences, actor: { type: "system", source: "telematics", eventId } },
    }, tx)
    return { alertId: open.id, repeat: true }
  }
  const loan = await tx.loan.findFirst({
    where: { tenantId, assetId: device.assetId, status: { notIn: [...CLOSED_LOANS] } }, orderBy: { startDate: "desc" }, select: { id: true },
  })
  const queue = await queueFor(tx, tenantId, loan?.id ?? null)
  const alert = await tx.telematicsAlert.create({
    data: {
      tenantId, eventId, deviceId: device.id, assetId: device.assetId, loanId: loan?.id ?? null, kind, queue,
      firstOccurredAt: occurredAt, lastOccurredAt: occurredAt,
    },
    select: { id: true },
  })
  await logAuditStrict({
    tenantId, action: AuditAction.TELEMATICS_ALERT_RAISED, entity: "TelematicsAlert", entityId: alert.id,
    newValue: { eventId, kind, queue, assetId: device.assetId, loanId: loan?.id ?? null, actor: { type: "system", source: "telematics", eventId } },
  }, tx)
  return { alertId: alert.id, repeat: false }
}
