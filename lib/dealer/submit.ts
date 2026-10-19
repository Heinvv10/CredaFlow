/**
 * The handoff from dealer to lender (spec deviation 1). The dealer's submit
 * only records dealerSubmittedAt (the deal stays DRAFT): every person whose
 * consent the deal needs has an attestation, and the dealer has uploaded at
 * least one document. A staff member's accept then runs the unchanged
 * submitDeal as that staff member — the NCA classification and any override
 * request are the lender's — and from there the staff credit flow is the one
 * every deal follows.
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { submitDeal, type SubmitDealResult } from "@/lib/asset-finance/deal-submit"
import { dealerAuditFields, type DealerActor, type StaffActor } from "./actor"
import { dealSubjects } from "./consent"
import { dealerDealWhere } from "./deals"
import { dealerMiss, dealerRefused, type DealerRefusal } from "./result"

export async function submitDealerDeal(actor: DealerActor, dealId: string): Promise<{ kind: "submitted"; at: Date } | DealerRefusal> {
  return prisma.$transaction(async (tx) => {
    // The row lock orders this against a concurrent submit or attestation.
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "AssetFinanceDeal"
      WHERE "id" = ${dealId} AND "tenantId" = ${actor.tenantId} AND "dealerId" = ${actor.dealerId} FOR UPDATE
    `)
    if (locked.length === 0) return dealerMiss("Deal")
    const deal = await tx.assetFinanceDeal.findFirst({
      where: dealerDealWhere(actor, dealId),
      select: { id: true, status: true, dealerSubmittedAt: true, clientId: true, entityId: true },
    })
    if (!deal) return dealerMiss("Deal")
    if (deal.status !== "DRAFT" || deal.dealerSubmittedAt) return dealerRefused(409, "Only an unsubmitted draft is submitted")
    const subjects = await dealSubjects(tx, actor.tenantId, deal)
    if (subjects.length === 0) return dealerRefused(422, "Add the people of the business before submitting")
    const attested = await tx.dealerConsentAttestation.findMany({ where: { tenantId: actor.tenantId, dealId: deal.id }, select: { clientId: true } })
    const missing = subjects.filter((s) => !attested.some((a) => a.clientId === s))
    if (missing.length > 0) return dealerRefused(422, `Consent is missing for ${missing.length} ${missing.length === 1 ? "person" : "people"}`)
    const documents = await tx.entityDocument.count({ where: { tenantId: actor.tenantId, dealId: deal.id, uploadedByType: "dealer", deletedAt: null } })
    if (documents === 0) return dealerRefused(422, "Upload at least one document before submitting")
    const at = new Date()
    await tx.assetFinanceDeal.update({ where: { id: deal.id, tenantId: actor.tenantId }, data: { dealerSubmittedAt: at } })
    const audit = dealerAuditFields(actor)
    await logAuditStrict({
      tenantId: actor.tenantId, userId: audit.userId, userEmail: audit.userEmail,
      action: AuditAction.DEALER_DEAL_SUBMITTED, entity: "AssetFinanceDeal", entityId: deal.id,
      newValue: { dealerSubmittedAt: at.toISOString(), subjects: subjects.length, documents, actor: audit.actor },
    }, tx)
    return { kind: "submitted" as const, at }
  })
}

/** Staff accept (manage_asset_finance): the unchanged submitDeal, as the staff member. */
export async function acceptDealerSubmission(staff: StaffActor, dealId: string): Promise<SubmitDealResult | DealerRefusal> {
  return prisma.$transaction(async (tx) => {
    const deal = await tx.assetFinanceDeal.findFirst({
      where: { id: dealId, tenantId: staff.tenantId },
      select: { id: true, dealerId: true, dealerSubmittedAt: true },
    })
    if (!deal) return dealerMiss("Deal")
    if (!deal.dealerId || !deal.dealerSubmittedAt) return dealerRefused(409, "The dealer has not submitted this deal")
    const result = await submitDeal(tx, staff, deal.id)
    if (result.kind === "submitted" || result.kind === "refused_nca") {
      await logAuditStrict({
        tenantId: staff.tenantId, userId: staff.userId, userEmail: staff.userEmail,
        action: AuditAction.DEALER_SUBMISSION_ACCEPTED, entity: "AssetFinanceDeal", entityId: deal.id,
        newValue: { dealerId: deal.dealerId, dealerSubmittedAt: deal.dealerSubmittedAt.toISOString(), outcome: result.kind },
      }, tx)
    }
    return result
  })
}
