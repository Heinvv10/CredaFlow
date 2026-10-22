/**
 * The position trail (docs/asset-finance/SLICE5-FOLLOWUPS.md part T): the
 * positions of this loan's asset inside its tenure and the tenant's retention,
 * and under THEFT from a week before the theft was reported, time-ordered (the
 * latest 500 at most). Only for THEFT, RECOVERY or
 * LEGAL_MATTER: arrears alone (DEFAULT) never justify a movement history. The
 * same gates as the latest-position reveal (position-view.ts): the
 * view_asset_position permission, a purpose the loan has now, an access row
 * written before the answer (view TRAIL with the point count; the database
 * refuses a TRAIL row for DEFAULT or without a holding purpose) and an audit
 * row with no coordinate. Never rendered with a page; never a map tile.
 */
import type { TelematicsPositionContext } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { canDo } from "@/lib/auth-guards"
import type { AppRole } from "@/lib/auth-config"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { positionPurposes, purposeRefusal } from "./position-purpose"
import { tenureEnd } from "./position-view"
import { objectBody, refused, type TelematicsActor, type TelematicsRefusal, type TelematicsResult } from "./result"

export const TRAIL_CONTEXTS: readonly TelematicsPositionContext[] = ["THEFT", "RECOVERY", "LEGAL_MATTER"]
export const TRAIL_LIMIT = 500
/** A THEFT trail starts this many days before the theft was reported (it is usually reported soon after it happens). */
export const THEFT_LOOKBACK_DAYS = 7

export interface TrailPoint {
  latitude: number
  longitude: number
  accuracyM: number | null
  occurredAt: string
  simulated: boolean
}

const DAY_MS = 86_400_000

export async function revealPositionTrail(
  actor: TelematicsActor & { role: string }, loanId: string, body: unknown, meta: { ipAddress: string | null; userAgent: string | null },
): Promise<TelematicsResult<{ points: TrailPoint[]; truncated: boolean }>> {
  const { tenantId } = actor
  const context = objectBody(body)?.context
  const refuse = async (status: 403 | 409, error: string, reason: string): Promise<TelematicsRefusal> => {
    await auditRefusal({
      action: AuditAction.TELEMATICS_POSITION_REFUSED, entity: "Loan", entityId: loanId, tenantId, userId: actor.userId, userEmail: actor.userEmail,
      reason, status, detail: { role: actor.role, view: "TRAIL", context: typeof context === "string" ? context.slice(0, 40) : null },
    })
    return refused(status, error)
  }
  if (!canDo(actor.role as AppRole, "view_asset_position")) return refuse(403, "Showing a trail needs the view_asset_position permission", "no_view_asset_position")
  if (!TRAIL_CONTEXTS.includes(context as TelematicsPositionContext)) {
    return refused(400, "A trail is shown for THEFT, RECOVERY or LEGAL_MATTER", { context: "THEFT, RECOVERY or LEGAL_MATTER" })
  }
  const purpose = context as TelematicsPositionContext
  const loan = await prisma.loan.findFirst({ where: { id: loanId, tenantId }, select: { id: true, assetId: true, status: true, startDate: true, closedAt: true } })
  if (!loan?.assetId) return refused(404, "Loan not found")
  const assetId = loan.assetId
  const purposes = await positionPurposes(tenantId, loan)
  const refusal = purposeRefusal(purposes, purpose)
  if (refusal) return refuse(409, refusal.error, refusal.reason)

  const end = await tenureEnd(tenantId, { ...loan, assetId })
  const config = await prisma.tenantConfig.findUnique({ where: { tenantId }, select: { telematicsPositionRetentionDays: true } })
  const retained = new Date(Date.now() - (config?.telematicsPositionRetentionDays ?? 90) * DAY_MS)
  // Under THEFT the movement history before the theft is not the purpose: from THEFT_LOOKBACK_DAYS before the day it was reported to SAPS.
  const report = purpose === "THEFT" && purposes.theftReportId
    ? await prisma.assetTheftReport.findFirst({ where: { id: purposes.theftReportId, tenantId }, select: { reportedOn: true } })
    : null
  const theftFrom = report ? new Date(report.reportedOn.getTime() - THEFT_LOOKBACK_DAYS * DAY_MS) : null
  const from = [loan.startDate, retained, ...(theftFrom ? [theftFrom] : [])].reduce((a, b) => (a > b ? a : b))

  return prisma.$transaction(async (tx) => {
    // The newest TRAIL_LIMIT + 1, to know whether the trail was cut; shown oldest first.
    const rows = await tx.telematicsPosition.findMany({
      where: { tenantId, device: { assetId }, occurredAt: { gte: from, ...(end ? { lt: end } : {}) } },
      orderBy: { occurredAt: "desc" }, take: TRAIL_LIMIT + 1,
      select: { deviceId: true, occurredAt: true, latitude: true, longitude: true, accuracyM: true, event: { select: { simulated: true } } },
    })
    const truncated = rows.length > TRAIL_LIMIT
    const points = rows.slice(0, TRAIL_LIMIT).reverse()
    const device = points.at(-1)?.deviceId
      ?? (await tx.trackerDevice.findFirst({ where: { tenantId, assetId }, orderBy: { createdAt: "desc" }, select: { id: true } }))?.id ?? null
    const access = await tx.telematicsPositionAccess.create({
      select: { id: true },
      data: {
        tenantId, userId: actor.userId, loanId, assetId, deviceId: device, context: purpose, view: "TRAIL", positionCount: points.length,
        theftReportId: purpose === "THEFT" ? purposes.theftReportId : null,
        positionOccurredAt: points.at(-1)?.occurredAt ?? null, ipAddress: meta.ipAddress, userAgent: meta.userAgent?.slice(0, 500) ?? null,
      },
    })
    await logAuditStrict({
      tenantId, userId: actor.userId, userEmail: actor.userEmail, action: AuditAction.TELEMATICS_POSITION_TRAIL_VIEWED, entity: "Loan", entityId: loanId,
      newValue: { context: purpose, accessId: access.id, points: points.length, truncated, theftReportId: purpose === "THEFT" ? purposes.theftReportId : null },
    }, tx)
    return {
      kind: "ok" as const, truncated,
      points: points.map((p) => ({
        latitude: Number(p.latitude), longitude: Number(p.longitude), accuracyM: p.accuracyM, occurredAt: p.occurredAt.toISOString(), simulated: p.event.simulated,
      })),
    }
  })
}
