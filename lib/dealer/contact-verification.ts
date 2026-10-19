/**
 * Staff verify the contact details a dealer typed for a person it captured
 * (review finding S1): until then the client portal is not activated on them
 * and no signing code is sent to them (lib/clients/dealer-contact.ts), since
 * the email or phone could be the dealer's own. The person must be on the
 * deal (its sole proprietor, or an active person of its entity). Set once
 * (Client_dealer_contact_guard), audited DEALER_CONTACT_VERIFIED.
 */
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { StaffActor } from "./actor"
import { dealerMiss, dealerRefused, type DealerRefusal } from "./result"

export async function verifyDealerContact(staff: StaffActor, dealId: string, clientId: string): Promise<{ kind: "verified" } | DealerRefusal> {
  const { tenantId } = staff
  return prisma.$transaction(async (tx) => {
    const deal = await tx.assetFinanceDeal.findFirst({
      where: { id: dealId, tenantId, dealerId: { not: null } },
      select: { id: true, clientId: true, entityId: true },
    })
    if (!deal) return dealerMiss("Deal")
    const onDeal = deal.clientId === clientId || (deal.entityId !== null
      && await tx.entityRelationship.count({ where: { tenantId, entityId: deal.entityId, clientId, active: true } }) > 0)
    if (!onDeal) return dealerMiss("Person")
    const client = await tx.client.findFirst({ where: { id: clientId, tenantId, createdByDealerId: { not: null } }, select: { id: true } })
    if (!client) return dealerMiss("Dealer-captured person")
    const verifiedAt = new Date()
    const marked = await tx.client.updateMany({
      where: { id: client.id, tenantId, createdByDealerId: { not: null }, dealerContactVerifiedAt: null },
      data: { dealerContactVerifiedAt: verifiedAt, dealerContactVerifiedById: staff.userId },
    })
    if (marked.count !== 1) return dealerRefused(409, "These contact details are already verified")
    await logAuditStrict({
      tenantId, userId: staff.userId, userEmail: staff.userEmail,
      action: AuditAction.DEALER_CONTACT_VERIFIED, entity: "Client", entityId: client.id,
      newValue: { dealId: deal.id, verifiedAt: verifiedAt.toISOString() },
    }, tx)
    return { kind: "verified" as const }
  })
}
