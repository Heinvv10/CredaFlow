/**
 * The only read path for a coordinate (docs/asset-finance/SLICE5.md part B,
 * POPIA). A position is never rendered with a page: staff press "Show last
 * known position" and this runs. It answers only collections staff and above
 * (view_asset_position, never READONLY, INSURANCE_OFFICER or a dealer), only
 * for a purpose the loan has now: DEFAULT (the loan is DEFAULTED), RECOVERY
 * (an open recovery) or LEGAL_MATTER (an OPEN matter). It shows only a
 * position from this loan's tenure of the asset (from its start until the
 * next loan's start, the loan's closing or the asset's recovery, whichever is
 * first) and within the tenant's retention. The access row is written in the
 * same transaction before the answer leaves, a "none" included; a 403 or 409
 * refusal is audited (no coordinate). Coordinates are text: never a map tile
 * or a third-party link.
 */
import type { TelematicsPositionContext } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { canDo } from "@/lib/auth-guards"
import type { AppRole } from "@/lib/auth-config"
import { AuditAction } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { SAST_OFFSET_MS } from "@/lib/date/sast"
import { isoOfDbDate } from "@/lib/asset-finance/dates"
import { OPEN_RECOVERY } from "./alerts-raise"
import { objectBody, refused, type TelematicsActor, type TelematicsRefusal, type TelematicsResult } from "./result"

export const POSITION_CONTEXTS: readonly TelematicsPositionContext[] = ["DEFAULT", "RECOVERY", "LEGAL_MATTER"]
export const PURPOSE_REFUSAL = "Position is shown only for a loan in default, legal action or recovery"
const CONTEXT_REFUSAL: Record<TelematicsPositionContext, string> = {
  DEFAULT: "This loan is not in default",
  RECOVERY: "This loan has no open recovery",
  LEGAL_MATTER: "This loan has no open legal matter",
}

export interface RevealedPosition {
  latitude: number
  longitude: number
  accuracyM: number | null
  occurredAt: string
  simulated: boolean
}

export type PositionAnswer = { position: RevealedPosition } | { none: true }

const DAY_MS = 86_400_000
/** SAST midnight starting a calendar date, as an instant. */
const sastDayStart = (day: Date) => new Date(Date.parse(`${isoOfDbDate(day)}T00:00:00.000Z`) - SAST_OFFSET_MS)

/** When this loan's tenure of the asset ends: the next loan's start, its closing or the earliest recovery that was not withdrawn. */
async function tenureEnd(tenantId: string, loan: { id: string; assetId: string; startDate: Date; closedAt: Date | null }): Promise<Date | null> {
  const [next, recovery] = await Promise.all([
    prisma.loan.findFirst({
      where: { tenantId, assetId: loan.assetId, id: { not: loan.id }, startDate: { gt: loan.startDate } }, orderBy: { startDate: "asc" }, select: { startDate: true },
    }),
    prisma.recovery.findFirst({ where: { tenantId, loanId: loan.id, status: { not: "WITHDRAWN" } }, orderBy: { recoveredOn: "asc" }, select: { recoveredOn: true } }),
  ])
  const ends = [next?.startDate, loan.closedAt, recovery ? sastDayStart(recovery.recoveredOn) : null].filter((d): d is Date => d instanceof Date)
  return ends.length > 0 ? new Date(Math.min(...ends.map((d) => d.getTime()))) : null
}

export async function revealPosition(
  actor: TelematicsActor & { role: string }, loanId: string, body: unknown, meta: { ipAddress: string | null; userAgent: string | null },
): Promise<TelematicsResult<PositionAnswer>> {
  const { tenantId } = actor
  const context = objectBody(body)?.context
  const refuse = async (status: 403 | 409, error: string, reason: string): Promise<TelematicsRefusal> => {
    await auditRefusal({
      action: AuditAction.TELEMATICS_POSITION_REFUSED, entity: "Loan", entityId: loanId, tenantId, userId: actor.userId, userEmail: actor.userEmail,
      reason, status, detail: { role: actor.role, context: typeof context === "string" ? context.slice(0, 40) : null },
    })
    return refused(status, error)
  }
  if (!canDo(actor.role as AppRole, "view_asset_position")) return refuse(403, "Showing a position needs the view_asset_position permission", "no_view_asset_position")
  if (!POSITION_CONTEXTS.includes(context as TelematicsPositionContext)) {
    return refused(400, "context is DEFAULT, RECOVERY or LEGAL_MATTER", { context: "DEFAULT, RECOVERY or LEGAL_MATTER" })
  }
  const purpose = context as TelematicsPositionContext
  const loan = await prisma.loan.findFirst({ where: { id: loanId, tenantId }, select: { id: true, assetId: true, status: true, startDate: true, closedAt: true } })
  if (!loan?.assetId) return refused(404, "Loan not found")
  const assetId = loan.assetId
  const [matters, recoveries] = await Promise.all([
    prisma.legalMatter.count({ where: { tenantId, loanId, status: "OPEN" } }),
    prisma.recovery.count({ where: { tenantId, loanId, ...OPEN_RECOVERY } }),
  ])
  const holds: Record<TelematicsPositionContext, boolean> = { DEFAULT: loan.status === "DEFAULTED", RECOVERY: recoveries > 0, LEGAL_MATTER: matters > 0 }
  if (!Object.values(holds).some(Boolean)) return refuse(409, PURPOSE_REFUSAL, "no_purpose")
  if (!holds[purpose]) return refuse(409, CONTEXT_REFUSAL[purpose], `no_${purpose.toLowerCase()}`)

  const end = await tenureEnd(tenantId, { ...loan, assetId })
  const config = await prisma.tenantConfig.findUnique({ where: { tenantId }, select: { telematicsPositionRetentionDays: true } })
  const retained = new Date(Date.now() - (config?.telematicsPositionRetentionDays ?? 90) * DAY_MS)
  const from = loan.startDate > retained ? loan.startDate : retained

  return prisma.$transaction(async (tx) => {
    const position = await tx.telematicsPosition.findFirst({
      where: { tenantId, device: { assetId }, occurredAt: { gte: from, ...(end ? { lt: end } : {}) } },
      orderBy: { occurredAt: "desc" },
      select: { id: true, deviceId: true, occurredAt: true, latitude: true, longitude: true, accuracyM: true, event: { select: { simulated: true } } },
    })
    const device = position ? null : await tx.trackerDevice.findFirst({ where: { tenantId, assetId }, orderBy: { createdAt: "desc" }, select: { id: true } })
    await tx.telematicsPositionAccess.create({
      data: {
        tenantId, userId: actor.userId, loanId, assetId, deviceId: position?.deviceId ?? device?.id ?? null, context: purpose,
        positionId: position?.id ?? null, positionOccurredAt: position?.occurredAt ?? null, ipAddress: meta.ipAddress, userAgent: meta.userAgent?.slice(0, 500) ?? null,
      },
    })
    if (!position) return { kind: "ok" as const, none: true as const }
    return {
      kind: "ok" as const,
      position: {
        latitude: Number(position.latitude), longitude: Number(position.longitude), accuracyM: position.accuracyM,
        occurredAt: position.occurredAt.toISOString(), simulated: position.event.simulated,
      },
    }
  })
}
