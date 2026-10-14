/**
 * Cancelling an asset-finance deal before it is booked (review item 2), so no
 * deal is ever stuck: a signed agreement whose rate moved, a payout that will
 * never be approved, a deal the borrower walked away from. In ONE transaction,
 * the deal, application and asset rows locked FOR UPDATE in booking's order:
 *
 *   - an unreleased payout (PENDING_APPROVAL or APPROVED) → CANCELLED;
 *     a RELEASED payout means a booked deal, which is never cancelled;
 *   - the deal → CANCELLED with who, when and why (reason ≥ 10 characters);
 *   - its application → CANCELLED (the entity status table allows it from
 *     DRAFT, SUBMITTED, UNDER_REVIEW and APPROVED);
 *   - the asset released (releasedAt), freeing its serial and VIN so the
 *     machine can be registered and financed on a new deal;
 *   - one ASSET_DEAL_CANCELLED audit row.
 *
 * The database holds the same line: guardPayout (cancel only while the deal
 * is CONTRACTED), guardAssetDealCancel (no deal cancelled with a live payout),
 * guardAssetDealStatus (the status table), AssetFinanceDeal_cancellation_shape
 * and guardFinancedAssetRelease (release only once nothing finances it).
 */
import type { AssetDealStatus } from "@prisma/client"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { lockDeal, type SigningActor } from "./signing-prepare"

export const CANCELLABLE_DEAL_STATUSES: readonly AssetDealStatus[] = ["DRAFT", "SUBMITTED", "REFERRED", "APPROVED", "CONTRACTED"]
export const MIN_CANCEL_REASON_LENGTH = 10
const MAX_CANCEL_REASON_LENGTH = 1000
const CANCELLABLE_APPLICATION = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED"] as const

export class CancelRaceError extends Error {
  constructor(what: string) {
    super(`${what} changed while the deal was being cancelled; nothing was cancelled`)
    this.name = "CancelRaceError"
  }
}

/** `{ reason }`: why the deal is cancelled, 10 to 1000 characters once trimmed. */
export function parseCancelInput(body: unknown): { reason: string } | string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "Body must be a JSON object"
  const { reason } = body as { reason?: unknown }
  const trimmed = typeof reason === "string" ? reason.trim() : ""
  if (trimmed.length < MIN_CANCEL_REASON_LENGTH || trimmed.length > MAX_CANCEL_REASON_LENGTH) {
    return `reason must be ${MIN_CANCEL_REASON_LENGTH} to ${MAX_CANCEL_REASON_LENGTH} characters: say why the deal is cancelled`
  }
  return { reason: trimmed }
}

export type CancelResult =
  | { kind: "not_found" }
  | { kind: "not_cancellable"; status: AssetDealStatus }
  | { kind: "cancelled"; payoutCancelled: boolean; applicationStatus: string }

export async function cancelDeal(actor: SigningActor, dealId: string, reason: string): Promise<CancelResult> {
  const { tenantId } = actor
  return prisma.$transaction(async (tx) => {
    const locked = await lockDeal(tx, tenantId, dealId)
    if (!locked) return { kind: "not_found" }
    if (!CANCELLABLE_DEAL_STATUSES.includes(locked.status)) return { kind: "not_cancellable", status: locked.status }
    const deal = await tx.assetFinanceDeal.findFirstOrThrow({
      where: { id: dealId, tenantId },
      select: { applicationId: true, assetId: true, payout: { select: { id: true, status: true } } },
    })
    await tx.$queryRaw(Prisma.sql`SELECT 1 FROM "LoanApplication" WHERE "id" = ${deal.applicationId} AND "tenantId" = ${tenantId} FOR UPDATE`)
    await tx.$queryRaw(Prisma.sql`SELECT 1 FROM "FinancedAsset" WHERE "id" = ${deal.assetId} AND "tenantId" = ${tenantId} FOR UPDATE`)
    const application = await tx.loanApplication.findFirstOrThrow({ where: { id: deal.applicationId, tenantId }, select: { status: true } })

    const now = new Date()
    const { payout } = deal
    const payoutCancelled = payout !== null && (payout.status === "PENDING_APPROVAL" || payout.status === "APPROVED")
    if (payout && !payoutCancelled) return { kind: "not_cancellable", status: locked.status }
    if (payout) {
      const moved = await tx.payout.updateMany({
        where: { id: payout.id, tenantId, status: payout.status },
        data: { status: "CANCELLED", cancelledById: actor.userId, cancelledAt: now },
      })
      if (moved.count !== 1) throw new CancelRaceError("The payout")
    }
    const cancelled = await tx.assetFinanceDeal.updateMany({
      where: { id: dealId, tenantId, status: locked.status },
      data: { status: "CANCELLED", cancelledAt: now, cancelledById: actor.userId, cancelReason: reason },
    })
    if (cancelled.count !== 1) throw new CancelRaceError("The deal")
    const applicationCancelled = CANCELLABLE_APPLICATION.some((s) => s === application.status)
    if (applicationCancelled) {
      await tx.loanApplication.update({
        where: { id: deal.applicationId, tenantId },
        data: { status: "CANCELLED", decisionReason: `Deal cancelled: ${reason}` },
      })
    }
    await tx.financedAsset.updateMany({ where: { id: deal.assetId, tenantId, releasedAt: null }, data: { releasedAt: now } })

    await logAuditStrict({
      tenantId,
      userId: actor.userId,
      userEmail: actor.userEmail ?? undefined,
      action: AuditAction.ASSET_DEAL_CANCELLED,
      entity: "AssetFinanceDeal",
      entityId: dealId,
      oldValue: { status: locked.status, applicationStatus: application.status, payoutStatus: payout?.status ?? null },
      newValue: {
        status: "CANCELLED", reason, applicationId: deal.applicationId,
        applicationStatus: applicationCancelled ? "CANCELLED" : application.status,
        payoutId: payout?.id ?? null, payoutStatus: payout ? "CANCELLED" : null,
        assetId: deal.assetId, assetReleasedAt: now.toISOString(),
      },
    }, tx)
    return { kind: "cancelled", payoutCancelled, applicationStatus: applicationCancelled ? "CANCELLED" : application.status }
  })
}
