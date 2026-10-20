/**
 * The contact details a dealer typed for a person it captured (Client with
 * createdByDealerId) are untrusted until a staff member verifies them
 * (Client.dealerContactVerifiedAt, lib/dealer/contact-verification.ts): the
 * email or phone could be the dealer's own. Until then the client portal is
 * not activated on them (app/api/portal/register; the database refuses the
 * portal password, Client_dealer_contact_guard) and no signing code is sent
 * to them (lib/signing-otp/subject.ts), and a dealer deal is not booked
 * (lib/asset-finance/booking-load.ts; AssetFinanceDeal_dealer_contacts_verified).
 */
import type { Prisma } from "@prisma/client"

export function dealerContactUnverified(client: { createdByDealerId: string | null; dealerContactVerifiedAt: Date | null }): boolean {
  return client.createdByDealerId !== null && client.dealerContactVerifiedAt === null
}

/** Clients whose contact details may be trusted: staff-captured, or dealer-captured and verified. */
export const TRUSTED_CONTACT_WHERE = {
  OR: [{ createdByDealerId: null }, { dealerContactVerifiedAt: { not: null } }],
} as const satisfies Prisma.ClientWhereInput

export const DEALER_CONTACT_UNVERIFIED =
  "A dealer captured this person's contact details: a staff member verifies them before anything is sent to them."

/** How many people on the deal (its sole proprietor, or active people of its entity) have unverified dealer-typed contacts. */
export function unverifiedDealerContactsOnDeal(
  db: { client: { count(args: { where: Prisma.ClientWhereInput }): Promise<number> } },
  tenantId: string,
  deal: { clientId: string | null; entityId: string | null },
): Promise<number> {
  return db.client.count({
    where: {
      tenantId, createdByDealerId: { not: null }, dealerContactVerifiedAt: null,
      OR: [
        ...(deal.clientId ? [{ id: deal.clientId }] : []),
        ...(deal.entityId ? [{ entityRelationships: { some: { tenantId, entityId: deal.entityId, active: true } } }] : []),
      ],
    },
  })
}
