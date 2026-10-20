/**
 * Who receives an entity borrower's servicing messages (goal §4.11): payment
 * reminders, arrears notices and receipt confirmations for an asset-finance
 * loan go to the people who act for the entity, never to the entity itself
 * (it has no inbox) and never to a guarantor.
 *
 * A recipient is a `Client` holding an ACTIVE relationship with the entity in
 * a role that acts for it: DIRECTOR, TRUSTEE or AUTHORISED_SIGNATORY (the
 * portal's authority roles, ./portal-access.ts). Excluded:
 *  - SURETY, MEMBER and BENEFICIAL_OWNER alone: a surety guarantees the debt
 *    but does not run the borrower's account, so a reminder to them would be
 *    a demand on the guarantee, which is a different (legal) step;
 *  - an inactive relationship (the person has resigned or been removed);
 *  - a client with a recorded death (Client.deceasedAt, lib/clients/status.ts);
 *  - a person a dealer captured whose contact details staff have not verified
 *    (lib/clients/dealer-contact.ts): they may be the dealer's own.
 * A person holding several qualifying roles is one recipient.
 *
 * This only decides WHO. Whether a channel may carry the message to them
 * (consent, opt-out, a blocked contact) is the send pipeline's canSend, per
 * recipient (./entity-dispatch.ts). SMS is never used (lib/messaging/.claude.md).
 */
import type { prisma } from "@/lib/prisma"
import { TRUSTED_CONTACT_WHERE } from "@/lib/clients/dealer-contact"
import { PORTAL_AUTHORITY_ROLES } from "./portal-access"

export type EntityContactsDb = Pick<typeof prisma, "entityRelationship">

export interface EntityContact {
  clientId: string
  firstName: string
  lastName: string
  email: string
  whatsapp: string | null
}

export async function entityContactRecipients(
  db: EntityContactsDb,
  tenantId: string,
  entityId: string,
): Promise<EntityContact[]> {
  const rows = await db.entityRelationship.findMany({
    where: {
      tenantId,
      entityId,
      active: true,
      role: { in: [...PORTAL_AUTHORITY_ROLES] },
      client: { deceasedAt: null, ...TRUSTED_CONTACT_WHERE },
    },
    select: { client: { select: { id: true, firstName: true, lastName: true, email: true, whatsapp: true } } },
    orderBy: [{ clientId: "asc" }, { role: "asc" }],
  })
  const byClient = new Map<string, EntityContact>()
  for (const { client } of rows) {
    if (byClient.has(client.id)) continue
    byClient.set(client.id, {
      clientId: client.id,
      firstName: client.firstName,
      lastName: client.lastName,
      email: client.email,
      whatsapp: client.whatsapp,
    })
  }
  return [...byClient.values()]
}
