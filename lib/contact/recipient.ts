import type { Channel, Contact } from "@prisma/client"
import { lookupContactByChannelValue, type ContactIdentityPrismaLike } from "./identity"

/** The report and log text for a refused leg. Names no number or address. */
export const CONTACT_NOT_RECIPIENTS = "The Contact for this number or address belongs to someone else; not sent"

export type RecipientContact =
  | { ok: true; contact: Contact }
  | { ok: false; reason: "NO_CONTACT" | "OTHER_OWNER" }

/**
 * The Contact an OUTBOUND message is filed under, and whose consent sendMessage
 * checks. The ONE lookup every outbound caller uses.
 *
 * A Contact is found by the number or address (lookupContactByChannelValue), so
 * it is whoever HOLDS the value: a client row edited to a number a lead or another
 * client holds resolves to THEIR Contact. Sending there would check that person's
 * consent and block status instead of the recipient's, file the message on their
 * timeline, and show them the recipient's loan. So:
 *  - `ownerClientId` set: the Contact must belong to that Client. One owned by a
 *    different Client, or by none (a lead), is refused as OTHER_OWNER.
 *  - `ownerClientId` null: the flow has no Client to own the message (a staff test
 *    message to a number they typed). Any Contact holding the value, as before.
 */
export async function lookupRecipientContact(
  db: ContactIdentityPrismaLike,
  opts: { tenantId: string; channel: Channel; value: string; ownerClientId: string | null },
): Promise<RecipientContact> {
  const contact = await lookupContactByChannelValue(db, { tenantId: opts.tenantId, channel: opts.channel, value: opts.value })
  if (!contact) return { ok: false, reason: "NO_CONTACT" }
  if (opts.ownerClientId !== null && contact.clientId !== opts.ownerClientId) return { ok: false, reason: "OTHER_OWNER" }
  return { ok: true, contact }
}
