import { prisma } from "@/lib/prisma"
import { normaliseEmail, toWaJid } from "@/lib/contact/identity"
import { resolveOpenThreadForContact } from "@/lib/inbox/resolve-thread"
import { CHAT_CONSENT_VERSION, CHAT_STARTED_ACTIVITY_SUBJECT, chatGreeting } from "./constants"
import { newChatRef } from "./ref"
import { CHAT, LEAD_LINK, note, stampThread, type Tx } from "./rows"
import type { ChatStartFields } from "./validate"

// Phase 1 rule: self-declared details are NEVER linked to an existing contact.
// A match only produces an internal note so staff verify before discussing an account.
async function findMatches(tx: Tx, tenantId: string, f: ChatStartFields) {
  const values = [f.phone, toWaJid(f.phone), normaliseEmail(f.email)].filter(Boolean)
  return tx.contact.findMany({
    where: {
      tenantId, mergedIntoId: null,
      OR: [
        { primaryPhone: f.phone },
        { primaryEmail: { equals: f.email, mode: "insensitive" } },
        { identities: { some: { value: { in: values } } } },
      ],
    },
    select: { id: true, firstName: true, lastName: true, clientId: true },
    take: 5,
  })
}

/**
 * Earlier website chats from the same self-declared number, newest first, for the
 * staff note only. Nothing is linked: the number is unverified, so a repeat is a
 * hint for the person calling back, not an identity.
 */
async function earlierChatLeads(tx: Tx, tenantId: string, phone: string) {
  return tx.lead.findMany({
    where: { tenantId, phone, source: "WEBSITE", tags: { has: "website-chat" } },
    orderBy: { createdAt: "desc" }, take: 5, select: { id: true },
  })
}

/** `brand` is the lender's trading name (identity.tradingName), printed in the greeting. */
export async function startChat(a: { tenantId: string; fields: ChatStartFields; now: Date; brand: string }) {
  const { tenantId, fields: f, now } = a
  const greeting = chatGreeting(f.firstName, a.brand)
  const ref = newChatRef()
  return prisma.$transaction(async (tx) => {
    const matches = await findMatches(tx, tenantId, f)
    const earlier = await earlierChatLeads(tx, tenantId, f.phone)
    const lead = await tx.lead.create({
      data: {
        tenantId, firstName: f.firstName, lastName: f.lastName, phone: f.phone, email: f.email,
        source: "WEBSITE", status: "NEW", tags: ["website-chat", "unverified"],
        notes: "Website AI chat. Details are self-declared and NOT verified.",
      },
    })
    // Deliberately NOT linked to the Lead (no leadId). Converting the lead finds its
    // Contact by leadId and gives it a phone and WhatsApp identity; that must not be
    // this chat Contact, or the client's WhatsApp would land in a read-only chat thread.
    // The two records are tied only by the cross-links in the notes below.
    const contact = await tx.contact.create({
      data: { tenantId, status: "LEAD", firstSeenChannel: CHAT.channel, firstSeenContext: "website-chat", firstName: f.firstName, lastName: f.lastName },
    })
    await tx.contactConsent.create({
      data: { tenantId, contactId: contact.id, channel: CHAT.channel, purpose: "CHATBOT_TRANSCRIPT_RETAIN", status: "GRANTED", source: "CHATBOT_OPT_IN", evidenceRef: CHAT_CONSENT_VERSION },
    })
    const { id: conversationId } = await resolveOpenThreadForContact(tx, { tenantId, contactId: contact.id, channel: CHAT.channel, now, subject: `Website chat ${ref}` })

    const matchLine = matches.length === 0 ? "" :
      `\n\nThese details match existing contact(s): ${matches.map((c) => `${c.firstName ?? ""} ${c.lastName ?? ""} (contact ${c.id}${c.clientId ? `, client ${c.clientId}` : ""})`.trim()).join("; ")}. Do NOT discuss any account until you have verified the caller's identity.`
    const repeatLine = earlier.length === 0 ? "" :
      `\n\nEarlier website chats from this number (not verified): ${earlier.map((l) => `/crm/leads/${l.id}`).join(", ")}.`
    await tx.message.create({
      data: note(tenantId, conversationId, `Website chat visitor, details NOT verified: ${f.firstName} ${f.lastName}, cell +${f.phone}, email ${f.email}. Follow up by phone.\nChat ref: ${ref}\n${LEAD_LINK}${lead.id}${repeatLine}${matchLine}`),
      select: { id: true },
    })
    await tx.message.create({
      data: { tenantId, conversationId, ...CHAT, direction: "OUTBOUND", status: "DELIVERED", sentAt: now, deliveredAt: now, bodyText: greeting },
      select: { id: true },
    })
    await stampThread(tx, { tenantId, conversationId, direction: "outbound", at: now })
    await tx.crmActivity.create({
      data: {
        tenantId, leadId: lead.id, type: "NOTE", subject: CHAT_STARTED_ACTIVITY_SUBJECT,
        notes: `From: ${f.firstName} ${f.lastName} | Phone: ${f.phone} | Email: ${f.email} (self-declared, not verified)\nInbox thread: /inbox?conversationId=${conversationId}`,
        completedAt: now, createdById: "website-system",
      },
    })
    return { conversationId, leadId: lead.id, contactId: contact.id, matchedContactIds: matches.map((c) => c.id), greeting, ref }
  })
}
