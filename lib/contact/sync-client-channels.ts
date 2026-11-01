import type { Channel } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { normaliseEmail, toWaJid } from "./identity"

type TxLike = Pick<typeof prisma, "contact" | "contactIdentity">

interface ClientChannels { email?: string | null; whatsapp?: string | null }

const emailOf = (client: ClientChannels) => (client.email ? normaliseEmail(client.email) || null : null)
const waJidOf = (client: ClientChannels) => (client.whatsapp ? toWaJid(client.whatsapp) || null : null)

/**
 * A client's email or WhatsApp number changed: their Contact follows, in the caller's transaction. Every outbound message
 * resolves its recipient through ContactIdentity and Contact.primary*, so a stale row sends the next message to the replaced
 * address, or fails the send outright.
 *
 * Ordinary mail follows at once; a signing code does not, if staff made the change (identity-confirmation.ts).
 * The replaced identity goes: it is no longer theirs, and if it stayed it would keep someone else from claiming it. The new value
 * is added, unless another Contact already holds it. Then this Contact is left with none on that channel: no message beats a
 * message to the wrong person, and sendMessage's owner check refuses that holder anyway. The change itself is never refused
 * here. A client with no Contact is left alone: there is nothing stale to correct. Returns the channels left without an identity.
 */
export async function syncClientContactChannels(tx: TxLike, args: {
  tenantId: string
  clientId: string
  before: ClientChannels
  after: ClientChannels
  /** The staff member making the change: their value is unverified for a signing code. Null: the borrower's own change, which is verified. */
  setByStaffUserId: string | null
}): Promise<Channel[]> {
  const { tenantId, clientId, setByStaffUserId } = args
  const changes = ([
    { channel: "EMAIL", column: "primaryEmail", before: emailOf(args.before), after: emailOf(args.after) },
    { channel: "WHATSAPP", column: "primaryWaJid", before: waJidOf(args.before), after: waJidOf(args.after) },
  ] as const).filter((c) => c.before !== c.after)
  if (changes.length === 0) return []
  const contact = await tx.contact.findFirst({ where: { tenantId, clientId } })
  if (!contact) return []

  const unset: Channel[] = []
  for (const { channel, column, before, after } of changes) {
    const replaced = [before, contact[column]].filter((value): value is string => value !== null)
    await tx.contactIdentity.deleteMany({ where: { tenantId, contactId: contact.id, channel, value: { in: replaced } } })
    const holder = after ? await tx.contactIdentity.findFirst({ where: { tenantId, channel, value: after } }) : null
    const held = holder !== null && holder.contactId !== contact.id
    if (after && !holder) await tx.contactIdentity.create({ data: { tenantId, contactId: contact.id, channel, value: after, source: "MANUAL", verified: false, setByStaffUserId } })
    // A value this Contact held already, pointed at again: who set it now is who chose it.
    if (holder && !held) await tx.contactIdentity.update({ where: { id: holder.id }, data: { setByStaffUserId, confirmedAt: null, confirmedByUserId: null, confirmedByClientId: null } })
    if (held) unset.push(channel)
    await tx.contact.update({ where: { id: contact.id }, data: { [column]: held ? null : after } })
  }
  return unset
}

/** Whether the Contact still reads as the client does on this channel. A message goes out on the Contact's value, never the client's. */
export function contactMatchesClient(channel: "EMAIL" | "WHATSAPP", contact: { primaryEmail: string | null; primaryWaJid: string | null }, client: ClientChannels): boolean {
  return channel === "EMAIL" ? contact.primaryEmail === emailOf(client) : contact.primaryWaJid === waJidOf(client)
}
