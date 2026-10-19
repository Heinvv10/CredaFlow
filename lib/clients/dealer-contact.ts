/**
 * The contact details a dealer typed for a person it captured (Client with
 * createdByDealerId) are untrusted until a staff member verifies them
 * (Client.dealerContactVerifiedAt, lib/dealer/contact-verification.ts): the
 * email or phone could be the dealer's own. Until then the client portal is
 * not activated on them (app/api/portal/register; the database refuses the
 * portal password, Client_dealer_contact_guard) and no signing code is sent
 * to them (lib/signing-otp/subject.ts).
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
