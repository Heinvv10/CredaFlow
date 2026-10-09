// Turning a unique-constraint violation into something a staff member can act
// on.
//
// Client.idNumber and Client.email are both globally unique. Before this,
// creating a client with an ID already on the books threw P2002 straight into
// the catch-all in app/api/clients/route.ts, which answered 500 "Failed to
// create client" — so the one thing the operator needed to know (that this
// person is already a client) was the one thing the error did not say.

import { Prisma, type Channel, type Contact } from "@prisma/client"
import { lookupContactByChannelValue, normaliseEmail, normalisePhone, toWaJid } from "@/lib/contact/identity"

/**
 * The field whose unique constraint was violated, or null if this error is not
 * a unique-constraint violation.
 *
 * Returning null for everything else is deliberate: a mapping that turned any
 * failure into a 409 would report a genuine database fault as a duplicate and
 * hide it from whoever has to fix it.
 */
export function uniqueConflictField(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null
  if (error.code !== "P2002") return null

  const target = error.meta?.target
  // Prisma has shipped `target` as both string[] and string depending on the
  // connector, so handle both rather than trusting one shape.
  if (Array.isArray(target)) return target.length > 0 ? String(target[0]) : null
  if (typeof target === "string") return target
  return null
}

const MESSAGES: Record<string, string> = {
  idNumber: "A client with this ID number already exists",
  email: "A client with this email address already exists",
}

/**
 * What to tell the operator. Falls back to a generic sentence rather than
 * echoing a column name, which would leak schema detail into the UI and read
 * as a crash rather than a decision.
 */
export function conflictMessage(field: string): string {
  return MESSAGES[field] ?? "A client with these details already exists"
}

// Client.idNumber and Client.email are not the only unique keys a client
// create can hit. provisionContactForClient (same transaction) writes a
// ContactIdentity per email/phone/WhatsApp, and (tenantId, channel, value) is
// unique so messages route to exactly one person. When the phone belongs to
// someone else, Prisma reports target ["tenantId", "channel", "value"], which
// said nothing to the operator: they got "these details", searched for the
// applicant, found no one, and were stuck.

export type ChannelField = "email" | "phone" | "whatsapp"

/** True when the violated unique key is a ContactIdentity (tenant, channel, value). */
export function isContactIdentityConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    error.meta?.modelName === "ContactIdentity"
  )
}

/**
 * The Contact that already holds one of these channel values in this tenant.
 * Checked in provisioning order (email, phone, WhatsApp) so the first hit is
 * the identity whose insert was refused. Keep this list in the same order as
 * collectChannelValues in lib/contact/provision.ts, or a conflict is
 * attributed to the wrong field.
 */
export async function findChannelHolder(
  db: Parameters<typeof lookupContactByChannelValue>[0],
  tenantId: string,
  input: { email?: string | null; phone?: string | null; whatsapp?: string | null },
): Promise<{ field: ChannelField; contact: Contact } | null> {
  const candidates: { field: ChannelField; channel: Channel; value: string }[] = [
    { field: "email", channel: "EMAIL", value: input.email ? normaliseEmail(input.email) : "" },
    { field: "phone", channel: "SMS", value: input.phone ? normalisePhone(input.phone) : "" },
    { field: "whatsapp", channel: "WHATSAPP", value: input.whatsapp ? toWaJid(input.whatsapp) : "" },
  ]
  for (const { field, channel, value } of candidates) {
    if (!value) continue
    const contact = await lookupContactByChannelValue(db, { tenantId, channel, value })
    if (contact) return { field, contact }
  }
  return null
}

const CHANNEL_LABELS: Record<ChannelField, string> = {
  email: "email address",
  phone: "phone number",
  whatsapp: "WhatsApp number",
}

/**
 * Names the holder so the operator can find them. A holder that is not one of
 * this tenant's clients is a CRM lead or a contact record from inbound
 * messaging; say which rather than claim a client exists.
 */
export function channelConflictMessage(
  field: ChannelField,
  client: { reference: string; firstName: string; lastName: string } | null,
  heldByLead: boolean,
): string {
  const label = CHANNEL_LABELS[field]
  if (client) {
    return `This ${label} already belongs to client ${client.firstName} ${client.lastName} (${client.reference})`
  }
  return `This ${label} is already linked to ${heldByLead ? "a CRM lead" : "another contact record"}`
}
