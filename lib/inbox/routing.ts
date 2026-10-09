import type { Prisma } from "@prisma/client"
import type { WaProvider } from "@/lib/messaging/wa-provider"
import { normalisePhone } from "@/lib/contact/identity"
import { touchContactInbound } from "./contact-recency"
import { resolveOpenThreadForContact } from "./resolve-thread"

export type RouteInboundCtx = {
  tenantId: string
  fromValue: string // normalised WA JID
  fromPhone: string // raw phone from the payload
  text: string
  providerMessageId: string | null
  waEnabled: boolean
  isStop: boolean
  now: Date
  /** Which transport delivered this. REQUIRED, with no default: the bug this
   *  replaced was a wrong-by-default provider label, and a default silently
   *  un-covers every caller that omits it. tsc enumerates the call sites. */
  provider: WaProvider
}

export type RouteInboundResult = {
  handled: boolean
  persisted: boolean
  conversationId?: string
  messageId?: string
  contactId?: string
}

// SA MSISDN in E.164-without-plus is "27" + 9 digits = 11 chars.
function isPlausibleSaNumber(phone: string): boolean {
  const n = normalisePhone(phone)
  return n.startsWith("27") && n.length === 11
}

export async function routeInbound(
  tx: Prisma.TransactionClient,
  ctx: RouteInboundCtx,
): Promise<RouteInboundResult> {
  if (!ctx.waEnabled) return { handled: false, persisted: false }

  // POPIA data-minimisation: an unknown sender whose first message is a STOP
  // keyword has no relationship to opt out of — don't provision a Contact / store PII.
  if (ctx.isStop) return { handled: false, persisted: false }
  if (!isPlausibleSaNumber(ctx.fromPhone)) return { handled: false, persisted: false }

  // Provision an UNKNOWN contact + WhatsApp identity for the first-time sender.
  const contact = await tx.contact.create({
    data: {
      tenantId: ctx.tenantId,
      status: "UNKNOWN",
      firstSeenChannel: "WHATSAPP",
      primaryPhone: normalisePhone(ctx.fromPhone),
      primaryWaJid: ctx.fromValue,
      identities: {
        create: {
          tenantId: ctx.tenantId,
          channel: "WHATSAPP",
          value: ctx.fromValue,
          verified: true,
          source: "INBOUND",
        },
      },
    },
  })

  // One open thread per contact — channel-free lookup (lib/inbox/resolve-thread.ts).
  // The inbound's own channel is recorded on the Message below.
  const { id: conversationId } = await resolveOpenThreadForContact(tx, {
    tenantId: ctx.tenantId,
    contactId: contact.id,
    channel: "WHATSAPP",
    now: ctx.now,
  })

  // Persist the inbound message (P2002 on dup providerMessageId bubbles to the webhook catch).
  const message = await tx.message.create({
    data: {
      tenantId: ctx.tenantId,
      conversationId,
      channel: "WHATSAPP",
      direction: "INBOUND",
      provider: ctx.provider,
      providerMessageId: ctx.providerMessageId,
      fromValue: ctx.fromValue,
      bodyText: ctx.text,
      status: "DELIVERED",
      deliveredAt: ctx.now,
    },
    select: { id: true },
  })

  // Recency markers.
  // lastActivityAt is the inbox queue's sort key and must move with every
  // write to lastInboundAt/lastOutboundAt. ctx.now is webhook-receipt time, so
  // it is by construction the newest traffic on this thread.
  await tx.conversation.update({
    where: { id: conversationId, tenantId: ctx.tenantId },
    data: { lastInboundAt: ctx.now, lastActivityAt: ctx.now },
  })
  await touchContactInbound(tx, { contactId: contact.id, channel: "WHATSAPP", now: ctx.now })

  return { handled: true, persisted: true, conversationId, messageId: message.id, contactId: contact.id }
}
