/**
 * The only read path for a coordinate (docs/asset-finance/SLICE5.md part B,
 * POPIA). A position is never rendered with a page: staff press "Show last
 * known position" and this runs. It answers only collections staff and above
 * (view_asset_position, never READONLY, INSURANCE_OFFICER or a dealer), only
 * for a loan in default, legal action or recovery, only a position from this
 * loan's tenure of the asset (from its start to the next loan's) and within
 * the tenant's retention. The access row is written in the same transaction
 * before the answer leaves, a "none" included. Coordinates are text: never a
 * map tile or a third-party link.
 */
import type { TelematicsPositionContext } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { canDo } from "@/lib/auth-guards"
import type { AppRole } from "@/lib/auth-config"
import { OPEN_RECOVERY } from "./alerts-raise"
import { objectBody, refused, type TelematicsActor, type TelematicsResult } from "./result"

export const POSITION_CONTEXTS: readonly TelematicsPositionContext[] = ["RECOVERY", "LEGAL_MATTER"]
export const PURPOSE_REFUSAL = "Position is shown only for a loan in default, legal action or recovery"

export interface RevealedPosition {
  latitude: number
  longitude: number
  accuracyM: number | null
  occurredAt: string
  simulated: boolean
}

export type PositionAnswer = { position: RevealedPosition } | { none: true }

const DAY_MS = 86_400_000

export async function revealPosition(
  actor: TelematicsActor & { role: string }, loanId: string, body: unknown, meta: { ipAddress: string | null; userAgent: string | null },
): Promise<TelematicsResult<PositionAnswer>> {
  const { tenantId } = actor
  if (!canDo(actor.role as AppRole, "view_asset_position")) return refused(403, "Showing a position needs the view_asset_position permission")
  const context = objectBody(body)?.context
  if (!POSITION_CONTEXTS.includes(context as TelematicsPositionContext)) return refused(400, "context is RECOVERY or LEGAL_MATTER", { context: "RECOVERY or LEGAL_MATTER" })
  const loan = await prisma.loan.findFirst({ where: { id: loanId, tenantId }, select: { id: true, assetId: true, status: true, startDate: true } })
  if (!loan?.assetId) return refused(404, "Loan not found")
  const assetId = loan.assetId
  const [matters, recoveries] = await Promise.all([
    prisma.legalMatter.count({ where: { tenantId, loanId, status: "OPEN" } }),
    prisma.recovery.count({ where: { tenantId, loanId, ...OPEN_RECOVERY } }),
  ])
  if (loan.status !== "DEFAULTED" && matters === 0 && recoveries === 0) return refused(409, PURPOSE_REFUSAL)
  if (context === "LEGAL_MATTER" && matters === 0) return refused(409, "This loan has no open legal matter")

  // This loan's tenure of the asset: from its start to the next loan's start.
  const next = await prisma.loan.findFirst({
    where: { tenantId, assetId, id: { not: loan.id }, startDate: { gt: loan.startDate } }, orderBy: { startDate: "asc" }, select: { startDate: true },
  })
  const config = await prisma.tenantConfig.findUnique({ where: { tenantId }, select: { telematicsPositionRetentionDays: true } })
  const retained = new Date(Date.now() - (config?.telematicsPositionRetentionDays ?? 90) * DAY_MS)
  const from = loan.startDate > retained ? loan.startDate : retained

  return prisma.$transaction(async (tx) => {
    const position = await tx.telematicsPosition.findFirst({
      where: { tenantId, device: { assetId }, occurredAt: { gte: from, ...(next ? { lt: next.startDate } : {}) } },
      orderBy: { occurredAt: "desc" },
      select: { id: true, deviceId: true, occurredAt: true, latitude: true, longitude: true, accuracyM: true, event: { select: { simulated: true } } },
    })
    const device = position ? null : await tx.trackerDevice.findFirst({ where: { tenantId, assetId }, orderBy: { createdAt: "desc" }, select: { id: true } })
    await tx.telematicsPositionAccess.create({
      data: {
        tenantId, userId: actor.userId, loanId, assetId, deviceId: position?.deviceId ?? device?.id ?? null, context: context as TelematicsPositionContext,
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
