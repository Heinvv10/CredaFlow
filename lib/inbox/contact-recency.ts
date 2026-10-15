import type { Channel } from "@prisma/client"

/**
 * `Contact.lastInboundAtByChannel` is the ONLY source the WhatsApp Cloud sender
 * reads for Meta's 24h customer-service window (`lib/whatsapp-cloud.ts` →
 * `readWaWindow`). Every WhatsApp inbound persist path must refresh it through
 * here: `routeInbound`, `handleWaStopInbound`.
 * (Email inbound does NOT yet write its own key — nothing reads `EMAIL`, so it
 * is inert; wire it here rather than inline if that ever changes.)
 *
 * This exists because it was previously inlined in `routeInbound` only — the
 * new-contact path — while `handleWaStopInbound` (every inbound from a contact
 * we already know) updated `Conversation.lastInboundAt` and left this field
 * untouched. The sender therefore read null for every known contact and failed
 * closed with WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE no matter how recently the
 * customer had written. One writer, called by both paths, is what stops that
 * recurring.
 */
export type ContactRecencyTx = {
  contact: {
    findUnique: (args: {
      where: { id: string }
      select: { lastInboundAtByChannel: true }
    }) => Promise<{ lastInboundAtByChannel: unknown } | null>
    update: (args: {
      where: { id: string }
      data: { lastInboundAtByChannel: Record<string, string> }
    }) => Promise<unknown>
  }
}

/**
 * Merge-not-replace: the JSON holds one timestamp per channel, so writing
 * WHATSAPP must preserve any EMAIL/SMS key already there.
 *
 * ⚠️ This read-modify-write takes NO row lock, so `prisma/schema/messaging.prisma`'s
 * "inbound matcher takes SELECT…FOR UPDATE on this row" is not true of this
 * path. Harmless only because WHATSAPP is the single key any inbound writes:
 * two concurrent inbounds for one contact clobber each other with near-equal
 * timestamps. The moment a SECOND channel writes here that becomes silent key
 * loss — so if you wire EMAIL in, take the lock first
 * (`lib/messaging/consent-lock.ts` → `lockContactConsentSubject`, which
 * `handleWaStopInbound` already holds on its STOP branch) or make the write
 * atomic with a jsonb `||` merge.
 */
export async function touchContactInbound(
  tx: ContactRecencyTx,
  opts: { contactId: string; channel: Channel; now: Date },
): Promise<void> {
  const current = await tx.contact.findUnique({
    where: { id: opts.contactId },
    select: { lastInboundAtByChannel: true },
  })
  const prior = (current?.lastInboundAtByChannel as Record<string, string> | null) ?? {}
  await tx.contact.update({
    where: { id: opts.contactId },
    data: { lastInboundAtByChannel: { ...prior, [opts.channel]: opts.now.toISOString() } },
  })
}
