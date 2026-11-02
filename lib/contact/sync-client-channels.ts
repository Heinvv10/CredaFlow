import type { Channel, Contact } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { normaliseEmail, normalisePhone, toWaJid } from "./identity"
import { provisionContactForClient } from "./provision"

type TxLike = Pick<typeof prisma, "$queryRaw" | "client" | "contact" | "contactIdentity">

interface ClientChannels { email?: string | null; whatsapp?: string | null }

const emailOf = (client: ClientChannels) => (client.email ? normaliseEmail(client.email) || null : null)
const waJidOf = (client: ClientChannels) => (client.whatsapp ? toWaJid(client.whatsapp) || null : null)

/** A client with no Contact yet (legacy, or dealer-captured): the Contact and the phone, which nobody set now. */
async function firstContact(tx: TxLike, args: { tenantId: string; clientId: string }): Promise<Contact> {
  const { tenantId, clientId } = args
  const client = await tx.client.findFirst({ where: { id: clientId, tenantId }, select: { firstName: true, lastName: true, phone: true } })
  const { contact } = await provisionContactForClient(tx, { tenantId, clientId, firstName: client?.firstName, lastName: client?.lastName, source: "MANUAL" })
  const phone = client?.phone ? normalisePhone(client.phone) || null : null
  if (phone && !(await tx.contactIdentity.findFirst({ where: { tenantId, channel: "SMS", value: phone } }))) {
    await tx.contactIdentity.create({ data: { tenantId, contactId: contact.id, channel: "SMS", value: phone, source: "MANUAL", verified: false } })
    await tx.contact.update({ where: { id: contact.id }, data: { primaryPhone: phone } })
  }
  return contact
}

/**
 * A client's email or WhatsApp number changed: their Contact follows, in the caller's transaction. Every outbound message
 * resolves its recipient through ContactIdentity and Contact.primary*, so a stale row sends the next message to the replaced
 * address, or fails the send outright. A client with no Contact gets one here: with no row there would be nothing to hold the
 * rule below, and a staff-typed address would recover the login. Ordinary mail follows at once; a signing code or a login
 * recovery does not, if staff made the change (identity-confirmation.ts).
 *
 * The replaced identity goes: it is no longer theirs, and if it stayed it would keep someone else from claiming it. The new value
 * is added, unless another Contact already holds it. Then this Contact is left with none on that channel: no message beats a
 * message to the wrong person, and sendMessage's owner check refuses that holder anyway. There is no row to carry the setter
 * then, so a staff change marks the Contact (staffAddressUnresolvedAt) and recovery stays shut until a later change resolves it.
 * The change itself is never refused here. Returns the channels left without an identity.
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
  const channels = [
    { channel: "EMAIL", column: "primaryEmail", before: emailOf(args.before), after: emailOf(args.after) },
    { channel: "WHATSAPP", column: "primaryWaJid", before: waJidOf(args.before), after: waJidOf(args.after) },
  ] as const
  const changes = channels.filter((c) => c.before !== c.after)
  if (changes.length === 0) return []
  const existing = await tx.contact.findFirst({ where: { tenantId, clientId } })
  const contact = existing ?? await firstContact(tx, args)
  if (!existing) {
    for (const { channel, column, before, after } of channels) {
      if (before !== after || !after || await tx.contactIdentity.findFirst({ where: { tenantId, channel, value: after } })) continue
      await tx.contactIdentity.create({ data: { tenantId, contactId: contact.id, channel, value: after, source: "MANUAL", verified: false } })
      await tx.contact.update({ where: { id: contact.id }, data: { [column]: after } })
    }
  }

  const unset: Channel[] = []
  const now: Pick<Contact, "primaryEmail" | "primaryWaJid"> = { primaryEmail: contact.primaryEmail, primaryWaJid: contact.primaryWaJid }
  for (const { channel, column, before, after } of changes) {
    const replaced = [before, contact[column]].filter((value): value is string => value !== null)
    await tx.contactIdentity.deleteMany({ where: { tenantId, contactId: contact.id, channel, value: { in: replaced } } })
    const holder = after ? await tx.contactIdentity.findFirst({ where: { tenantId, channel, value: after } }) : null
    const held = holder !== null && holder.contactId !== contact.id
    if (after && !holder) await tx.contactIdentity.create({ data: { tenantId, contactId: contact.id, channel, value: after, source: "MANUAL", verified: false, setByStaffUserId } })
    // A value this Contact held already, pointed at again: who set it now is who chose it.
    if (holder && !held) await tx.contactIdentity.update({ where: { id: holder.id }, data: { setByStaffUserId, confirmedAt: null, confirmedByUserId: null } })
    if (held) unset.push(channel)
    now[column] = held ? null : after
    await tx.contact.update({ where: { id: contact.id }, data: { [column]: now[column] } })
  }
  const marked = contact.staffAddressUnresolvedAt !== null
  if (!marked && unset.length > 0 && setByStaffUserId !== null) {
    await tx.contact.update({ where: { id: contact.id }, data: { staffAddressUnresolvedAt: new Date() } })
  }
  // A change on the other channel does not clear it: only every address the client carries reading on the Contact again.
  if (marked && channels.every((c) => c.after === null || c.after === now[c.column])) {
    await tx.contact.update({ where: { id: contact.id }, data: { staffAddressUnresolvedAt: null } })
  }
  return unset
}

/** Whether the Contact still reads as the client does on this channel. A message goes out on the Contact's value, never the client's. */
export function contactMatchesClient(channel: "EMAIL" | "WHATSAPP", contact: { primaryEmail: string | null; primaryWaJid: string | null }, client: ClientChannels): boolean {
  return channel === "EMAIL" ? contact.primaryEmail === emailOf(client) : contact.primaryWaJid === waJidOf(client)
}
