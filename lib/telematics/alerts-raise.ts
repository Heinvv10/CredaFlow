/**
 * A tracker alert becomes a work item (docs/asset-finance/SLICE5.md part B):
 * a repeat of an unresolved alert of the same device and kind folds into it;
 * otherwise a new OPEN item on the loan whose tenure covers the event (the
 * caller's telematicsLoanAt; no loan, no alert). Its queue: RECOVERY when that
 * loan has an open recovery or an OPEN legal matter, COLLECTIONS when it is in
 * default, else SERVICING (a loan in good standing is not a collections
 * matter). Nothing is sent to anyone: this writes TelematicsAlert and the
 * audit row only (lib/telematics/no-outbound.test.ts).
 */
import type { RecoveryStatus, TelematicsAlertKind, TelematicsAlertQueue } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { SigningTx } from "@/lib/asset-finance/signing-prepare"

/** A recovery still open: anything but CLOSED or WITHDRAWN. */
export const OPEN_RECOVERY: { status: { notIn: RecoveryStatus[] } } = { status: { notIn: ["CLOSED", "WITHDRAWN"] } }

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
  return loan?.status === "DEFAULTED" ? "COLLECTIONS" : "SERVICING"
}

export async function raiseAlert(
  tx: SigningTx, device: AlertDevice, eventId: string, kind: TelematicsAlertKind, occurredAt: Date, loanId: string,
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
  const queue = await queueFor(tx, tenantId, loanId)
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
