/**
 * A dealer cancels its own draft (SLICE5-FOLLOWUPS.md part D): DEALER_ADMIN any
 * draft of its dealer, DEALER_SALES only one it created, and only before the
 * deal is handed to the lender (dealerSubmittedAt). After that the deal is the
 * lender's to cancel (lib/asset-finance/deal-cancel.ts).
 *
 * In one transaction, the deal locked: the deal → CANCELLED with the dealer
 * user, when and why; its DRAFT application → CANCELLED; the asset released
 * (its serial and VIN free again); one DEALER_DEAL_CANCELLED audit row. The
 * database holds the same line (guardAssetDealDealerCancel,
 * AssetFinanceDeal_cancellation_shape).
 *
 * The 404 rule: another dealer's deal, and a colleague's draft for a SALES
 * user, are "not found".
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { lockDeal } from "@/lib/asset-finance/signing-prepare"
import { MIN_CANCEL_REASON_LENGTH } from "@/lib/asset-finance/deal-cancel"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import { dealerAuditFields, type DealerActor } from "./actor"
import { dealerDealWhere } from "./deals"
import { dealerMiss, dealerRefused, type DealerRefusal } from "./result"

export async function cancelDealerDraft(actor: DealerActor, dealId: string, reason: string): Promise<{ kind: "cancelled" } | DealerRefusal> {
  // The database counts characters (code points), not UTF-16 units.
  if ([...reason.trim()].length < MIN_CANCEL_REASON_LENGTH) return dealerRefused(400, `Say why the draft is cancelled (at least ${MIN_CANCEL_REASON_LENGTH} characters)`)
  try {
    return await cancelInTransaction(actor, dealId, reason)
  } catch (error) {
    // The database's own refusal (guardAssetDealDealerCancel: e.g. a user deactivated meanwhile).
    if (isCheckViolation(error)) return dealerRefused(409, "The lender's system refused the cancellation")
    throw error
  }
}

async function cancelInTransaction(actor: DealerActor, dealId: string, reason: string): Promise<{ kind: "cancelled" } | DealerRefusal> {
  return prisma.$transaction(async (tx) => {
    const mine = await tx.assetFinanceDeal.findFirst({ where: dealerDealWhere(actor, dealId), select: { dealerUserId: true, dealerPurge: { select: { id: true } } } })
    if (!mine) return dealerMiss("Deal")
    if (mine.dealerPurge) return dealerRefused(409, "This draft was closed and its details erased: start a new deal")
    if (actor.dealerRole !== "DEALER_ADMIN" && mine.dealerUserId !== actor.dealerUserId) return dealerMiss("Deal")
    await lockDeal(tx, actor.tenantId, dealId)
    const deal = await tx.assetFinanceDeal.findFirstOrThrow({
      where: dealerDealWhere(actor, dealId),
      select: { status: true, dealerSubmittedAt: true, applicationId: true, assetId: true },
    })
    if (deal.status !== "DRAFT" || deal.dealerSubmittedAt) {
      return dealerRefused(409, "This deal is with the lender: ask the lender to cancel it")
    }
    await tx.$queryRaw(Prisma.sql`SELECT 1 FROM "LoanApplication" WHERE "id" = ${deal.applicationId} AND "tenantId" = ${actor.tenantId} FOR UPDATE`)
    await tx.$queryRaw(Prisma.sql`SELECT 1 FROM "FinancedAsset" WHERE "id" = ${deal.assetId} AND "tenantId" = ${actor.tenantId} FOR UPDATE`)
    const now = new Date()
    await tx.assetFinanceDeal.update({
      where: { id: dealId, tenantId: actor.tenantId },
      data: { status: "CANCELLED", cancelledAt: now, cancelledByDealerUserId: actor.dealerUserId, cancelReason: reason },
    })
    const application = await tx.loanApplication.updateMany({
      where: { id: deal.applicationId, tenantId: actor.tenantId, status: "DRAFT" },
      // The reason stays in the audit row only: the application outlives a purge.
      data: { status: "CANCELLED", decisionReason: "Deal cancelled by the dealer" },
    })
    await tx.financedAsset.updateMany({ where: { id: deal.assetId, tenantId: actor.tenantId, releasedAt: null }, data: { releasedAt: now } })
    const audit = dealerAuditFields(actor)
    await logAuditStrict({
      tenantId: actor.tenantId, userId: audit.userId, userEmail: audit.userEmail,
      action: AuditAction.DEALER_DEAL_CANCELLED, entity: "AssetFinanceDeal", entityId: dealId,
      oldValue: { status: "DRAFT" },
      newValue: {
        status: "CANCELLED", reason, applicationId: deal.applicationId, applicationCancelled: application.count === 1,
        assetId: deal.assetId, assetReleasedAt: now.toISOString(), actor: audit.actor,
      },
    }, tx)
    return { kind: "cancelled" as const }
  })
}
